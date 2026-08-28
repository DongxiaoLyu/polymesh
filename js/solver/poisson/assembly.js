/* ============================================================
   assembly.js — Global assembly & solve for the Poisson VEM block
   ============================================================
   Solves  −∇·(k∇u) = f  in Ω with
     u = g      on Γ_D   (Dirichlet: prescribed nodal values)
     k ∂u/∂n = q on Γ_N   (Neumann: outward flux, per edge)

   Assembly:
     - element stiffness  k·AK  (AK from vem.elementStiffness)
     - element source      b_i += f_E·|E|/Nv     (f_E constant per element,
       or a global constant; exact for the reference quadrature)
     - Neumann edges       b_a += q·L/2, b_b += q·L/2   (trapezoid, exact)
   Dirichlet is applied by the standard reduction: the system is split
   into free / prescribed DOFs, K_ff·u_f = b_f − K_fp·u_p, solved with
   the sparse CG solver (matrix.js).

   Depends on:  matrix.js, vem.js
   Exposes:     window.MeshStudio.Solver.Poisson.assembly
   ============================================================ */

(function (global) {
  'use strict';

  const Matrix = global.MeshStudio.Solver.Matrix;
  const Vem = global.MeshStudio.Solver.Poisson.vem;

  /**
   * Solve the Poisson problem on an existing mesh.
   *
   * mesh:       { nodes: [{x,y}], elements: [{ nodeIds, interior }] }
   * opts: {
   *   k:           conductivity (default 1)
   *   f:           heat source — a number (uniform) or an array of
   *                per-element values (default 0)
   *   prescribed:  { nodeId: value }  (Dirichlet; first value wins)
   *   flux:        [{ a, b, q }]      (Neumann edges, q = outward flux)
   *   tol:         CG tolerance (default 1e-12)
   * }
   * Returns { u (Float64Array, nodal), iterations, residual, nf }.
   */
  function solvePoisson(mesh, opts) {
    opts = opts || {};
    const k = opts.k != null ? opts.k : 1;
    const f = opts.f != null ? opts.f : 0;
    const prescribed = opts.prescribed || {};
    const flux = opts.flux || [];
    const nodes = mesh.nodes;
    const elements = mesh.elements;
    const n = nodes.length;

    if (!(k > 0) || !isFinite(k)) throw new Error('conductivity k must be positive');
    if (!elements.length) throw new Error('empty mesh');

    // ----- element loop: triplets + source RHS -----
    const triplets = [];
    const b = new Float64Array(n);
    // f is either a scalar (uniform source) or an array-like of per-element
    // values (plain Array, Float64Array, …).
    const fArr = typeof f === 'number' ? null : f;

    for (let e = 0; e < elements.length; e++) {
      const ids = elements[e].nodeIds;
      const Nv = ids.length;
      const ring = new Array(Nv);
      for (let i = 0; i < Nv; i++) ring[i] = nodes[ids[i]];
      const { AK, area } = Vem.elementStiffness(ring);

      const fE = fArr ? (fArr[e] || 0) : f;
      const rhs = fE * area / Nv; // b_i += f_E·|E|/Nv
      for (let i = 0; i < Nv; i++) {
        const gi = ids[i];
        b[gi] += rhs;
        for (let j = 0; j < Nv; j++) {
          triplets.push([gi, ids[j], k * AK[i * Nv + j]]);
        }
      }
    }

    // ----- Neumann edges: q·L/2 to each endpoint -----
    for (let e = 0; e < flux.length; e++) {
      const { a, b: bb, q } = flux[e];
      const L = Math.hypot(nodes[a].x - nodes[bb].x, nodes[a].y - nodes[bb].y);
      b[a] += q * L / 2;
      b[bb] += q * L / 2;
    }

    // ----- Dirichlet reduction -----
    const isPres = new Uint8Array(n);
    const u = new Float64Array(n);
    const presKeys = Object.keys(prescribed);
    for (let p = 0; p < presKeys.length; p++) {
      const id = Number(presKeys[p]);
      if (!isPres[id]) { isPres[id] = 1; u[id] = prescribed[id]; } // first value wins
    }

    const revFree = new Int32Array(n).fill(-1);
    const freeDofs = [];
    for (let i = 0; i < n; i++) {
      if (!isPres[i]) { revFree[i] = freeDofs.length; freeDofs.push(i); }
    }
    const nf = freeDofs.length;
    if (nf === 0) return { u, iterations: 0, residual: 0, nf: 0 };

    // reduced RHS: b_f − K_fp·u_p
    const bf = new Float64Array(nf);
    for (let i = 0; i < nf; i++) bf[i] = b[freeDofs[i]];
    for (let t = 0; t < triplets.length; t++) {
      const gi = triplets[t][0], gj = triplets[t][1], v = triplets[t][2];
      const ri = revFree[gi];
      if (ri >= 0 && isPres[gj]) bf[ri] -= v * u[gj];
    }

    // reduced system K_ff (only free rows/cols)
    const tf = [];
    for (let t = 0; t < triplets.length; t++) {
      const gi = triplets[t][0], gj = triplets[t][1], v = triplets[t][2];
      const ri = revFree[gi], rj = revFree[gj];
      if (ri >= 0 && rj >= 0) tf.push([ri, rj, v]);
    }
    const A = Matrix.fromTriplets(nf, tf);

    const { x, iterations, residual } = Matrix.cgSolve(A, bf, { tol: opts.tol || 1e-12 });
    for (let i = 0; i < nf; i++) u[freeDofs[i]] = x[i];
    return { u, iterations, residual, nf };
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Solver = global.MeshStudio.Solver || {};
  global.MeshStudio.Solver.Poisson = global.MeshStudio.Solver.Poisson || {};
  global.MeshStudio.Solver.Poisson.assembly = { solvePoisson };
})(window);
