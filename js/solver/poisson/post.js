/* ============================================================
   post.js — Post-processing for the Poisson VEM block
   ============================================================
   Turns the nodal solution u into the per-field display data that the
   heatmap legend and canvas rendering consume:
     temperature  — nodal values (length = nodes.length)
     flux         — element heat-flux MAGNITUDE |q_E| = k·|Π∇u|_E
                    (length = elements.length), via the projected
                    gradient of the VEM solution
   Produces the exact `state.solution` shape the solver shell expects:
     { fields: { temperature: { data, min, max }, flux: { data, min, max } },
       iterations, residual }

   Depends on:  vem.js
   Exposes:     window.MeshStudio.Solver.Poisson.post
   ============================================================ */

(function (global) {
  'use strict';

  const Vem = global.MeshStudio.Solver.Poisson.vem;

  /** Element heat-flux magnitude |q_E| = k·|Π∇u| (constant per element). */
  function elementFlux(mesh, u, k) {
    const flux = new Float64Array(mesh.elements.length);
    for (let e = 0; e < mesh.elements.length; e++) {
      const ids = mesh.elements[e].nodeIds;
      const Nv = ids.length;
      const ring = new Array(Nv);
      const uLoc = new Float64Array(Nv);
      for (let i = 0; i < Nv; i++) {
        ring[i] = mesh.nodes[ids[i]];
        uLoc[i] = u[ids[i]];
      }
      const { gx, gy } = Vem.elementProjectedGradient(ring, uLoc);
      flux[e] = k * Math.hypot(gx, gy);
    }
    return flux;
  }

  function minMax(arr) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < mn) mn = arr[i];
      if (arr[i] > mx) mx = arr[i];
    }
    return { min: mn === Infinity ? 0 : mn, max: mx === -Infinity ? 0 : mx };
  }

  /**
   * Build the state.solution object for the given nodal solution.
   * opts: { k } conductivity used for the flux field.
   */
  function buildSolution(mesh, u, opts) {
    const k = (opts && opts.k != null) ? opts.k : 1;
    const temperature = Float64Array.from(u);
    const flux = elementFlux(mesh, u, k);
    const tr = minMax(temperature);
    const qr = minMax(flux);
    return {
      fields: {
        temperature: { data: temperature, min: tr.min, max: tr.max },
        flux:        { data: flux,        min: qr.min, max: qr.max },
      },
    };
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Solver = global.MeshStudio.Solver || {};
  global.MeshStudio.Solver.Poisson = global.MeshStudio.Solver.Poisson || {};
  global.MeshStudio.Solver.Poisson.post = { elementFlux, buildSolution };
})(window);
