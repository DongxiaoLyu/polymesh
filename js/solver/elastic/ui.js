/* ============================================================
   ui.js — 2D Elasticity block: Solve wiring + heatmap rendering
   ============================================================
   The second shipped solver block (k=1 plane-stress VEM). It does NOT
   touch app.js or the shell's internals — it plugs in through the
   public bridges:
     - SolverUI.registerBlock — replaces the 'coming soon' placeholder
       metadata with the real one (fields / E-ν-deform params / bcNote)
     - blocks.elastic.solve   — per-problem Solve dispatch (solver-bc)
     - SolverUI.currentParams / currentProblem / currentField
     - App.registerPhase      — solve-phase lifecycle (heat + deform hooks)
     - state.renderHooks/underlayHooks — heatmap + deformed overlay

   Display convention: a 'Show deformation' switch (OFF by default) controls
   the view. OFF → the heatmap is drawn on the UNDEFORMED mesh, colour alone
   conveys the field (nothing can blow up). ON → classic deformed plot: the
   heatmap follows the mesh displaced by scale·(ux,uy) and the ORIGINAL
   position keeps only a light, undeformed reference wireframe; the scale
   comes from the logarithmic 'Deformation ×' slider (10^0 … 10^5, default
   ×10). In deformed mode the renderer's own mesh/polygon/node drawing is
   suppressed via the per-frame predicate state.hideMeshFn (the block owns
   the domain rendering).

   Boundary conditions are NOT re-entered here: elasticity loads and
   supports are mechanics semantics defined in the PRE-PROCESSOR BC
   phase (point loads, distributed edge loads, fixed/hinge supports),
   which is exactly the data this block consumes:
     - point/distributed load vectors follow the FEM convention
       (+X right, +Y UP) and are flipped into the mesh's y-down screen
       frame here (fy → −fy) before assembly;
     - fixed and hinge supports are equivalent at k=1 (both fix the two
       translational DOFs) → homogeneous Dirichlet on both components;
     - Solve is gated on ≥ 2 distinct support nodes (fewer leaves a
       rigid-body rotation that makes the stiffness singular).

   Depends on:  app.js, solver-ui.js, solver-bc.js, matrix.js,
                vem.js, assembly.js, post.js
   Exposes:     nothing (side-effect wiring only)
   ============================================================ */

(function (global) {
  'use strict';

  const App = global.MeshStudio.App;
  const state = App.state;
  const SolverUI = global.MeshStudio.SolverUI;
  const Mesh = global.MeshStudio.Mesh;
  const Elastic = global.MeshStudio.Solver.Elastic;

  /* ============================================================
     Block metadata (overrides the shell's 'coming soon' placeholder)
     ============================================================ */

  SolverUI.registerBlock({
    id: 'elastic',
    label: '2D Elasticity',
    available: true,
    // This problem CONSUMES the pre-processing mechanical boundary
    // conditions (loads/supports), so the renderer keeps drawing their
    // markers during the solve phase. Problems without this flag (e.g.
    // Poisson, whose scalar BCs are different physics) hide them.
    usesPreprocBCs: true,
    fields: [
      { id: 'displacement', label: 'Displacement', unit: 'mm',  legend: SolverUI.gradients.displacement },
      { id: 'strain',       label: 'Strain',       unit: '—',   legend: SolverUI.gradients.strain },
      { id: 'stress',       label: 'Stress',       unit: 'MPa', legend: SolverUI.gradients.stress },
    ],
    params: [
      { id: 'E',  label: "Young's modulus E", unit: 'GPa', value: 200 },
      { id: 'nu', label: 'Poisson ratio ν',   unit: '—',   value: 0.3 },
      // Deformed-view switch: OFF (default) = heatmap on the undeformed
      // mesh; ON = heatmap follows the displaced mesh (enables the slider).
      { id: 'deformOn', label: 'Show deformation', type: 'switch', value: false },
      { id: 'deform', label: 'Deformation', unit: '×', type: 'slider',
        enabledBy: 'deformOn', min: 0, max: 5, step: 0.1, value: 1 },
    ],
  });

  /* ============================================================
     Solve
     ============================================================ */

  function runSolve() {
    const mesh = state.mesh;
    if (!mesh || !mesh.elements.length) { App.showToast('No mesh to solve'); return; }
    const n = mesh.nodes.length;

    const params = SolverUI.currentParams();
    const E = params.E != null ? params.E : 200;   // GPa
    const nu = params.nu != null ? params.nu : 0.3;
    if (!(E > 0) || !isFinite(E)) { App.showToast("Young's modulus E must be positive"); return; }
    if (!(nu > 0 && nu < 0.5) || !isFinite(nu)) { App.showToast('Poisson ratio ν must be between 0 and 0.5'); return; }

    // ---- supports: every Fixed/Hinge node pins ux & uy ----
    // (at k=1 both support types constrain the same translational DOFs)
    const supportNodes = new Set();
    for (const g of state.supports) {
      for (const id of g.nodeIds) supportNodes.add(id);
    }
    if (supportNodes.size < 2) {
      App.showToast('Elasticity needs at least two support (Fixed/Hinge) nodes to remove rigid-body motion');
      return;
    }
    const prescribed = {};
    for (const id of supportNodes) {
      prescribed[id] = 0;
      prescribed[id + n] = 0;
    }

    // ---- loads: FEM convention (+Y up) → screen frame (y down) ----
    const point = [];
    for (const g of state.pointLoads) {
      for (const node of g.nodeIds) point.push({ node, fx: g.fx, fy: -g.fy });
    }
    const traction = [];
    for (const g of state.distLoads) {
      for (const [a, b] of g.edges) traction.push({ a, b, fx: g.fx, fy: -g.fy });
    }

    let sol;
    try {
      const { u, iterations, residual } = Elastic.assembly.solveElastic(
        mesh, { E, nu, prescribed, point, traction, body: null });
      sol = Elastic.post.buildSolution(mesh, u, { E, nu });
      // Keep the displacement VECTORS (screen frame) for the deformed-shape
      // overlay; buildSolution only stores the |u| magnitude fields.
      sol.ux = u.subarray(0, n);
      sol.uy = u.subarray(n);
      sol.iterations = iterations;
      sol.residual = residual;
    } catch (err) {
      console.error(err);
      App.showToast('Solve failed: ' + err.message);
      return;
    }

    state.solution = sol;
    ensureHeatHook();
    ensureDeformHook();
    SolverUI.refreshLegend();
    App.scheduleRender();
    App.showToast('Solved — ' + mesh.nodes.length + ' nodes, ' + mesh.elements.length +
                  ' elements (' + sol.iterations + ' iters, residual ' + sol.residual.toExponential(1) + ')');
  }

  /* ============================================================
     Heatmap rendering (UNDERLAY hook; guarded to this problem)
     ============================================================ */

  /** Whether the deformed view is enabled ('Show deformation' switch). */
  function deformEnabled() {
    return SolverUI.currentParams().deformOn === true;
  }

  /** Deformation scale from the slider: 10^position (paramValues stores
      the actual value). Fallback ×10. Only used when deformEnabled(). */
  function deformScale() {
    const p = SolverUI.currentParams().deform;
    return (Number.isFinite(p) && p > 0) ? p : 10;
  }

  /**
   * All elastic fields are NODAL: rendered by the SHARED toolkit
   * (SolverUI.heat.nodalFan), which fan-triangulates every polygon and
   * fills it with LINEARLY interpolated colours (smooth, no triangle
   * seams). When the deformed view is OFF the mesh stays UNDEFORMED
   * (colour-only); when it is ON every vertex is displaced by
   * scale·(ux, uy), so the coloured heatmap follows the deformed shape.
   */
  function drawHeatmap(ctx) {
    if (SolverUI.currentProblem() !== 'elastic') return; // this block only
    const mesh = state.mesh;
    const sol = state.solution;
    if (!mesh || !sol || !sol.fields) return;
    const fieldId = SolverUI.currentField();
    const field = sol.fields[fieldId];
    const block = SolverUI.blocks.elastic;
    const fmeta = block && block.fields.find(f => f.id === fieldId);
    if (!field || !field.data || field.data.length !== mesh.nodes.length || !fmeta) return;

    const disp = deformEnabled() &&
                 !!(sol.ux && sol.uy && sol.ux.length === mesh.nodes.length);
    const s = disp ? deformScale() : 0;
    const heat = SolverUI.heat;
    const stops = heat.parse(fmeta.legend);

    // Nodal fields are shown as ONE colour per element (mean of the node
    // values), so the underlying cell type stays readable; when deformed
    // view is on, vertices move by scale·(ux,uy) first.
    heat.elements(ctx, mesh,
      i => ({ x: mesh.nodes[i].x + (disp ? s * sol.ux[i] : 0),
              y: mesh.nodes[i].y + (disp ? s * sol.uy[i] : 0) }),
      i => field.data[i],
      stops, field.min, field.max);
  }

  let heatHook = null;

  function ensureHeatHook() {
    if (heatHook == null) {
      heatHook = drawHeatmap;
      state.underlayHooks.push(heatHook);
    }
  }

  function removeHeatHook() {
    if (heatHook != null) {
      const i = state.underlayHooks.indexOf(heatHook);
      if (i >= 0) state.underlayHooks.splice(i, 1);
      heatHook = null;
    }
  }

  /* ============================================================
     Deformed-plot overlay (RENDER hook — drawn ABOVE the heatmap):
       1. a light reference WIREFRAME of the UNDEFORMED domain at its
          original position (the only thing left there);
       2. the dark outline of the DEFORMED domain (scale·(ux,uy)) plus
          faint displaced node dots that show interior motion.
     ============================================================ */

  function drawDeformed(ctx) {
    if (SolverUI.currentProblem() !== 'elastic') return; // this block only
    if (!deformEnabled()) return; // off: renderer keeps the plain domain
    const mesh = state.mesh;
    if (!mesh) return;
    const k = 1 / state.view.zoom; // screen-constant stroke width/radius

    // 1. undeformed reference wireframe (stays at the original position)
    ctx.strokeStyle = 'rgba(120,120,126,0.55)';
    ctx.lineWidth = 1.1 * k;
    ctx.beginPath();
    for (const [a, b] of Mesh.boundaryEdges(mesh)) {
      ctx.moveTo(mesh.nodes[a].x, mesh.nodes[a].y);
      ctx.lineTo(mesh.nodes[b].x, mesh.nodes[b].y);
    }
    ctx.stroke();

    // 2. deformed outline + node dots
    const sol = state.solution;
    if (!sol || !sol.ux || !sol.uy || sol.ux.length !== mesh.nodes.length) return;
    const s = deformScale();

    ctx.strokeStyle = 'rgba(20,20,24,0.92)';
    ctx.lineWidth = 2.2 * k;
    ctx.beginPath();
    for (const [a, b] of Mesh.boundaryEdges(mesh)) {
      ctx.moveTo(mesh.nodes[a].x + s * sol.ux[a], mesh.nodes[a].y + s * sol.uy[a]);
      ctx.lineTo(mesh.nodes[b].x + s * sol.ux[b], mesh.nodes[b].y + s * sol.uy[b]);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(20,20,24,0.5)';
    const r = 1.8 * k;
    ctx.beginPath();
    for (let i = 0; i < mesh.nodes.length; i++) {
      const x = mesh.nodes[i].x + s * sol.ux[i];
      const y = mesh.nodes[i].y + s * sol.uy[i];
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  let deformHook = null;

  function ensureDeformHook() {
    if (deformHook == null) {
      deformHook = drawDeformed;
      state.renderHooks.push(deformHook);
    }
  }

  function removeDeformHook() {
    if (deformHook != null) {
      const i = state.renderHooks.indexOf(deformHook);
      if (i >= 0) state.renderHooks.splice(i, 1);
      deformHook = null;
    }
  }

  /* ---------- Mesh-drawing ownership ----------
     In deformed mode (elastic problem + solve phase + 'Show deformation' ON)
     the block renders the whole domain itself (deformed heatmap + reference
     wireframe), so the renderer must skip mesh/polygon/node-dot drawing.
     This is exposed as the per-frame PREDICATE state.hideMeshFn — the
     renderer re-evaluates it every frame, so flipping the switch takes
     effect immediately with no extra event plumbing. OFF mode / other
     problems keep the renderer's own (plain) mesh. */

  function meshHiddenNow() {
    return state.phase === 'solve' &&
           SolverUI.currentProblem() === 'elastic' &&
           deformEnabled();
  }

  /* ---------- Phase plugin (chained after solver-ui / solver-bc) ---------- */

  App.registerPhase('solve', {
    enter() {
      state.hideMeshFn = meshHiddenNow;
      ensureHeatHook();
      ensureDeformHook();
    },
    exit() {
      state.hideMeshFn = null;
      state.hideMesh = false;
      removeHeatHook();
      removeDeformHook();
    },
  });

  /* ---------- Public bridge: replace the placeholder Solve click ----------
     The solve function lives on the block's OWN metadata (blocks.elastic)
     so the shell dispatches to the ACTIVE problem's solver. */

  if (SolverUI.blocks.elastic) SolverUI.blocks.elastic.solve = runSolve;
})(window);
