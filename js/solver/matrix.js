/* ============================================================
   matrix.js — Sparse linear algebra for the in-browser solvers
   ============================================================
   CRS (compressed row storage) matrices + conjugate gradient with
   Jacobi (diagonal) preconditioning. Typed arrays throughout.

   This is the shared numerical core: the Poisson block uses it now,
   and future blocks (2D Elasticity, 2D Dynamics) reuse it unchanged.

   Depends on:  nothing
   Exposes:     window.MeshStudio.Solver.Matrix
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------- Construction ---------- */

  /**
   * Build a CRS matrix from [i, j, v] triplets. Duplicates (same row and
   * column) are summed. Returns { n, rowPtr, colIdx, values, diag }.
   */
  function fromTriplets(n, triplets) {
    // Merge duplicates per (row, column).
    const rows = new Map(); // row -> Map(col -> value)
    for (let k = 0; k < triplets.length; k++) {
      const i = triplets[k][0], j = triplets[k][1], v = triplets[k][2];
      let m = rows.get(i);
      if (!m) { m = new Map(); rows.set(i, m); }
      m.set(j, (m.get(j) || 0) + v);
    }
    const rowPtr = new Int32Array(n + 1);
    const colIdx = [];
    const values = [];
    for (let i = 0; i < n; i++) {
      rowPtr[i] = colIdx.length;
      const m = rows.get(i);
      if (m) {
        const js = Array.from(m.keys()).sort((a, b) => a - b);
        for (const j of js) { colIdx.push(j); values.push(m.get(j)); }
      }
    }
    rowPtr[n] = colIdx.length;
    const C = {
      n,
      rowPtr,
      colIdx: Int32Array.from(colIdx),
      values: Float64Array.from(values),
      diag: new Float64Array(n),
    };
    for (let i = 0; i < n; i++) {
      for (let k = C.rowPtr[i]; k < C.rowPtr[i + 1]; k++) {
        if (C.colIdx[k] === i) { C.diag[i] = C.values[k]; break; }
      }
    }
    return C;
  }

  /* ---------- Basic ops ---------- */

  function matvec(A, x, out) {
    for (let i = 0; i < A.n; i++) {
      let s = 0;
      for (let k = A.rowPtr[i]; k < A.rowPtr[i + 1]; k++) s += A.values[k] * x[A.colIdx[k]];
      out[i] = s;
    }
  }

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function norm2(a) {
    return Math.sqrt(dot(a, a));
  }

  function axpy(y, alpha, x) { // y += alpha * x
    for (let i = 0; i < y.length; i++) y[i] += alpha * x[i];
  }

  /* ---------- CG solver (SPD) with Jacobi preconditioning ---------- */

  /**
   * Solve A·x = b by conjugate gradients. A must be symmetric positive
   * definite (guaranteed for the VEM Poisson stiffness restricted to the
   * free DOFs). Stopping: ||r|| <= tol * ||b||.
   *
   * Returns { x, iterations, residual }.
   */
  function cgSolve(A, b, opts) {
    opts = opts || {};
    const n = A.n;
    const tol = opts.tol || 1e-12;
    const maxIter = opts.maxIter || Math.max(2000, 10 * n);
    const x = new Float64Array(n);
    const r = new Float64Array(b);      // residual b - A x (x = 0)
    const z = new Float64Array(n);      // M^-1 r
    const p = new Float64Array(n);
    const Ap = new Float64Array(n);

    const bNorm = norm2(b);
    if (bNorm === 0) return { x, iterations: 0, residual: 0 };

    const diag = A.diag;
    for (let i = 0; i < n; i++) z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i];
    p.set(z);
    let rho = dot(r, z);
    let iterations = 0;

    for (; iterations < maxIter; iterations++) {
      matvec(A, p, Ap);
      const pAp = dot(p, Ap);
      if (!(pAp > 0)) break; // not SPD — stop (should never happen for VEM)
      const alpha = rho / pAp;
      axpy(x, alpha, p);
      axpy(r, -alpha, Ap);
      if (norm2(r) <= tol * bNorm) break;
      for (let i = 0; i < n; i++) z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i];
      const rhoNew = dot(r, z);
      const beta = rhoNew / rho;
      rho = rhoNew;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }

    return { x, iterations: iterations + 1, residual: norm2(r) / bNorm };
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Solver = global.MeshStudio.Solver || {};
  global.MeshStudio.Solver.Matrix = { fromTriplets, matvec, dot, norm2, axpy, cgSolve };
})(window);
