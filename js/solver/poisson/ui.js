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

  function drawHeatmap(ctx) {
    if (SolverUI.currentProblem() !== 'poisson') return; // this block only
    const mesh = state.mesh;
    const sol = state.solution;
    if (!mesh || !sol || !sol.fields) return;
    const block = SolverUI.blocks[SolverUI.currentProblem()];
    const fieldId = SolverUI.currentField();
    const field = sol.fields[fieldId];
    const fmeta = block && block.fields.find(f => f.id === fieldId);
    if (!field || !field.data || !fmeta) return;

    const heat = SolverUI.heat;
    const stops = heat.parse(fmeta.legend);

    if (fieldId === 'temperature') {
      // Nodal field: ONE colour per element (mean of the node values) —
      // uniform fills keep the cell geometry readable.
      heat.elements(ctx, mesh, i => mesh.nodes[i], i => field.data[i],
                    stops, field.min, field.max);
    } else {
      // Element field (heat flux): constant colour per element.
      for (let e = 0; e < mesh.elements.length; e++) {
        const ids = mesh.elements[e].nodeIds;
        ctx.fillStyle = heat.rgb(heat.color(stops, field.min, field.max, field.data[e]));
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

  /* ---------- Public bridge: replace the placeholder Solve click ----------
     The solve function lives on the block's OWN metadata so the shell can
     dispatch to the ACTIVE problem (two blocks can no longer fight over a
     single global slot). */

  if (SolverUI.blocks.poisson) SolverUI.blocks.poisson.solve = runSolve;
})(window);
