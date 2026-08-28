/* ============================================================
   ui.js — 2D Poisson block: Solve wiring + heatmap rendering
   ============================================================
   The first shipped solver block. It does NOT touch app.js or the
   shell's internals — it plugs in through the public bridges:
     - SolverUI.solve        — replaces the "under construction" toast
     - SolverUI.refreshLegend— legend min/max after a solve
     - SolverUI.currentParams / currentProblem / currentField
     - SolverBC.groups       — boundary-condition groups
     - App.registerPhase     — solve-phase lifecycle
     - state.renderHooks     — heatmap drawing (under the BC markers)

   Depends on:  app.js, solver-ui.js, solver-bc.js, matrix.js,
                vem.js, assembly.js, post.js
   Exposes:     nothing (side-effect wiring only)
   ============================================================ */

(function (global) {
  'use strict';

  const App = global.MeshStudio.App;
  const state = App.state;
  const SolverUI = global.MeshStudio.SolverUI;
  const SolverBC = global.MeshStudio.SolverBC;
  const Poisson = global.MeshStudio.Solver.Poisson;

  /* ============================================================
     Solve
     ============================================================ */

  function runSolve() {
    const mesh = state.mesh;
    if (!mesh || !mesh.elements.length) { App.showToast('No mesh to solve'); return; }

    const params = SolverUI.currentParams();
    const k = params.k != null ? params.k : 1;
    const f = params.f != null ? params.f : 0;
    if (!(k > 0) || !isFinite(k)) { App.showToast('Conductivity k must be positive'); return; }

    // Boundary conditions from the solver BC groups (boundary edges only).
    const prescribed = {};
    const flux = [];
    for (const g of SolverBC.groups) {
      if (g.bc === 'dirichlet') {
        for (const [a, b] of g.edges) {
          if (!(a in prescribed)) prescribed[a] = g.value; // first value wins
          if (!(b in prescribed)) prescribed[b] = g.value;
        }
      } else if (g.bc === 'neumann') {
        for (const [a, b] of g.edges) flux.push({ a, b, q: g.value });
      }
    }
    if (!Object.keys(prescribed).length) {
      App.showToast('At least one Dirichlet boundary condition is required.');
      return;
    }

    let sol;
    try {
      const { u, iterations, residual } = Poisson.assembly.solvePoisson(mesh, { k, f, prescribed, flux });
      sol = Poisson.post.buildSolution(mesh, u, { k });
      sol.iterations = iterations;
      sol.residual = residual;
    } catch (err) {
      console.error(err);
      App.showToast('Solve failed: ' + err.message);
      return;
    }

    state.solution = sol;
    ensureHeatHook();
    SolverUI.refreshLegend();
    App.scheduleRender();
    App.showToast('Solved — ' + mesh.nodes.length + ' nodes, ' + mesh.elements.length +
                  ' elements (' + sol.iterations + ' iters, residual ' + sol.residual.toExponential(1) + ')');
  }

  /* ============================================================
     Heatmap rendering (UNDERLAY hook: drawn below the mesh, so the
     original polygonal cell edges stay visible; BC markers remain
     on top via state.renderHooks)
     ============================================================ */

  /** Parse the field's CSS gradient string into an ordered stop list. */
  function parseGradient(css) {
    const hex = /#[0-9a-fA-F]{6}/g;
    const stops = [];
    let m;
    while ((m = hex.exec(css)) !== null) {
      const v = parseInt(m[0].slice(1), 16);
      stops.push([(v >> 16) & 255, (v >> 8) & 255, v & 255]);
    }
    return stops;
  }

  /** Sample a stop list at t ∈ [0,1] → 'rgb(r,g,b)'. */
  function sampleGradient(stops, t) {
    if (!stops.length) return 'rgb(128,128,128)';
    if (stops.length === 1) return 'rgb(' + stops[0][0] + ',' + stops[0][1] + ',' + stops[0][2] + ')';
    const pos = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const fr = pos - i;
    const a = stops[i], b = stops[i + 1];
    const r = Math.round(a[0] + (b[0] - a[0]) * fr);
    const g = Math.round(a[1] + (b[1] - a[1]) * fr);
    const bl = Math.round(a[2] + (b[2] - a[2]) * fr);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  function avgColor(...cols) {
    let r = 0, g = 0, b = 0;
    for (const c of cols) {
      const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(c);
      if (m) { r += +m[1]; g += +m[2]; b += +m[3]; }
    }
    const n = cols.length || 1;
    return 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')';
  }

  function drawHeatmap(ctx) {
    const mesh = state.mesh;
    const sol = state.solution;
    if (!mesh || !sol || !sol.fields) return;
    const block = SolverUI.blocks[SolverUI.currentProblem()];
    const fieldId = SolverUI.currentField();
    const field = sol.fields[fieldId];
    const fmeta = block && block.fields.find(f => f.id === fieldId);
    if (!field || !field.data || !fmeta) return;

    const stops = parseGradient(fmeta.legend);
    const span = field.max - field.min;
    const colorAt = v => sampleGradient(stops, span > 1e-30 ? (v - field.min) / span : 0.5);

    if (fieldId === 'temperature') {
      // Nodal field: fan-triangulate each polygon from its centroid and
      // fill every triangle with the average of its three node colours
      // (a smooth-looking Gouraud-style approximation).
      for (let e = 0; e < mesh.elements.length; e++) {
        const ids = mesh.elements[e].nodeIds;
        const Nv = ids.length;
        let cx = 0, cy = 0;
        for (let i = 0; i < Nv; i++) { cx += mesh.nodes[ids[i]].x; cy += mesh.nodes[ids[i]].y; }
        cx /= Nv; cy /= Nv;
        const cc = colorAt(field.data[ids[0]]);
        for (let i = 0; i < Nv; i++) {
          const na = mesh.nodes[ids[i]], nb = mesh.nodes[ids[(i + 1) % Nv]];
          ctx.fillStyle = avgColor(colorAt(field.data[ids[i]]), colorAt(field.data[ids[(i + 1) % Nv]]), cc);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(na.x, na.y);
          ctx.lineTo(nb.x, nb.y);
          ctx.closePath();
          ctx.fill();
        }
      }
    } else {
      // Element field (heat flux): constant colour per element.
      for (let e = 0; e < mesh.elements.length; e++) {
        const ids = mesh.elements[e].nodeIds;
        ctx.fillStyle = colorAt(field.data[e]);
        ctx.beginPath();
        ctx.moveTo(mesh.nodes[ids[0]].x, mesh.nodes[ids[0]].y);
        for (let i = 1; i < ids.length; i++) ctx.lineTo(mesh.nodes[ids[i]].x, mesh.nodes[ids[i]].y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  let heatHook = null;

  function ensureHeatHook() {
    if (heatHook == null) {
      heatHook = drawHeatmap;
      // Underlay: drawn BELOW the mesh so the original polygonal cell
      // edges stay visible on top of the heatmap fill.
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

  /* ---------- Phase plugin (chained after solver-ui / solver-bc) ---------- */

  App.registerPhase('solve', {
    enter() { ensureHeatHook(); },
    exit()  { removeHeatHook(); },
  });

  /* ---------- Public bridge: replace the placeholder Solve click ---------- */

  SolverUI.solve = runSolve;
})(window);
