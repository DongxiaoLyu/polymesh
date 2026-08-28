/* ============================================================
   vem.js — Lowest-order (k=1) VEM element stiffness for Poisson
   ============================================================
   Direct port of the reference MATLAB implementation (mVEM, B. Xu):
     elemK.txt  — element stiffness matrix
     myM.txt    — scaled monomials at the element vertices
   with the extension of a projected-gradient helper for post
   processing (heat flux).

   Conventions (must match the reference code):
     - the vertex ring is shoelace-POSITIVE (the app's mesh.js and
       clipping.js guarantee this for every element), so the edge
       normals produced by 0.5·[y_next−y_prev, x_prev−x_next] are the
       OUTWARD normals;
     - scaled monomials m = [1, (x−xK)/hK, (y−yK)/hK] with hK = element
       diameter and xK = area-weighted centroid.

   Element stiffness (Eq. (58)–(61) of the reference):
     B   = [∫_E ∇m_s·∇φ_i]        (consistency, via Green's theorem)
     Bs  = B with row 0 replaced by 1/Nv   (fixes the constant)
     G   = B·D,  Gs = Bs·D        (monomial Gram matrices, D = [m_s(v_i)])
     Pis = Gs⁻¹·Bs                (projection: DOF → monomial coeffs)
     Pi  = D·Pis                  (projection matrix in DOF space)
     AK  = Pis'·G·Pis + (I−Pi)'(I−Pi)   (consistency + dofi-dofi stability)

   Depends on:  nothing
   Exposes:     window.MeshStudio.Solver.Poisson.vem
   ============================================================ */

(function (global) {
  'use strict';

  /**
   * Solve the small dense system A·X = B (n×n, n×cols) by Gaussian
   * elimination with partial pivoting. Flat row-major arrays.
   */
  function solveDense(A, B, n, cols) {
    const w = n + cols;
    const M = new Float64Array(n * w);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i * w + j] = A[i * n + j];
      for (let j = 0; j < cols; j++) M[i * w + n + j] = B[i * cols + j];
    }
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r * w + col]) > Math.abs(M[piv * w + col])) piv = r;
      }
      if (Math.abs(M[piv * w + col]) < 1e-14) throw new Error('singular VEM projection system');
      if (piv !== col) {
        for (let c = 0; c < w; c++) { const t = M[col * w + c]; M[col * w + c] = M[piv * w + c]; M[piv * w + c] = t; }
      }
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r * w + col] / M[col * w + col];
        for (let c = col; c < w; c++) M[r * w + c] -= f * M[col * w + c];
      }
    }
    const X = new Float64Array(n * cols);
    for (let i = 0; i < n; i++) {
      const d = M[i * w + i];
      for (let j = 0; j < cols; j++) X[i * cols + j] = M[i * w + n + j] / d;
    }
    return X;
  }

  /**
   * Element stiffness matrix (k = 1).
   * ring: array of {x, y} (CCW / shoelace-positive).
   * Returns { AK (Nv×Nv flat row-major), area, hK, Pis (3×Nv flat) }.
   */
  function elementStiffness(ring) {
    const Nv = ring.length;
    if (Nv < 3) throw new Error('element needs at least 3 vertices');

    // ----- area (shoelace), area-weighted centroid, diameter -----
    const ac = new Float64Array(Nv);
    let area2 = 0;
    for (let i = 0; i < Nv; i++) {
      const a = ring[i], b = ring[(i + 1) % Nv];
      ac[i] = a.x * b.y - b.x * a.y;
      area2 += ac[i];
    }
    const area = 0.5 * Math.abs(area2);
    if (area < 1e-14) throw new Error('degenerate element (zero area)');
    let cx = 0, cy = 0;
    for (let i = 0; i < Nv; i++) {
      const a = ring[i], b = ring[(i + 1) % Nv];
      cx += (a.x + b.x) * ac[i];
      cy += (a.y + b.y) * ac[i];
    }
    cx /= 6 * area;
    cy /= 6 * area;
    let hK = 0;
    for (let i = 0; i < Nv; i++) {
      for (let j = i + 1; j < Nv; j++) {
        const d = Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y);
        if (d > hK) hK = d;
      }
    }
    if (hK < 1e-14) throw new Error('degenerate element (zero diameter)');

    // ----- D: scaled monomials at vertices (Nv × 3), myM.txt k=1 -----
    const D = new Float64Array(Nv * 3);
    for (let i = 0; i < Nv; i++) {
      D[i * 3 + 0] = 1;
      D[i * 3 + 1] = (ring[i].x - cx) / hK;
      D[i * 3 + 2] = (ring[i].y - cy) / hK;
    }

    // ----- normVec (Nv × 2): ∫_∂E φ_i n ds = 0.5·[y_next−y_prev, x_prev−x_next] -----
    const nv = new Float64Array(Nv * 2);
    for (let i = 0; i < Nv; i++) {
      const prev = ring[(i - 1 + Nv) % Nv], next = ring[(i + 1) % Nv];
      nv[i * 2 + 0] = 0.5 * (next.y - prev.y);
      nv[i * 2 + 1] = 0.5 * (prev.x - next.x);
    }

    // ----- B (3 × Nv) = Gradm · normVec, Gradm = [[0,0],[1/hK,0],[0,1/hK]] -----
    const B = new Float64Array(3 * Nv);
    for (let i = 0; i < Nv; i++) {
      B[1 * Nv + i] = nv[i * 2 + 0] / hK;
      B[2 * Nv + i] = nv[i * 2 + 1] / hK;
    }

    // ----- Bs: constraint row (average of DOFs), Eq. (37) -----
    const Bs = new Float64Array(3 * Nv);
    for (let i = 0; i < Nv; i++) {
      Bs[0 * Nv + i] = 1 / Nv;
      Bs[1 * Nv + i] = B[1 * Nv + i];
      Bs[2 * Nv + i] = B[2 * Nv + i];
    }

    // ----- G = B·D, Gs = Bs·D (3 × 3) -----
    const G = new Float64Array(9), Gs = new Float64Array(9);
    for (let s = 0; s < 3; s++) {
      for (let t = 0; t < 3; t++) {
        let v = 0, w = 0;
        for (let i = 0; i < Nv; i++) {
          v += B[s * Nv + i] * D[i * 3 + t];
          w += Bs[s * Nv + i] * D[i * 3 + t];
        }
        G[s * 3 + t] = v;
        Gs[s * 3 + t] = w;
      }
    }

    // ----- Pis = Gs⁻¹·Bs (3 × Nv) -----
    const Pis = solveDense(Gs, Bs, 3, Nv);

    // ----- Pi = D·Pis (Nv × Nv) -----
    const Pi = new Float64Array(Nv * Nv);
    for (let i = 0; i < Nv; i++) {
      for (let j = 0; j < Nv; j++) {
        let v = 0;
        for (let s = 0; s < 3; s++) v += D[i * 3 + s] * Pis[s * Nv + j];
        Pi[i * Nv + j] = v;
      }
    }

    // ----- AK = Pis'·G·Pis + (I−Pi)'(I−Pi) -----
    const AK = new Float64Array(Nv * Nv);
    // T1 = Pis' · G  (Nv × 3)
    const T1 = new Float64Array(Nv * 3);
    for (let i = 0; i < Nv; i++) {
      for (let s = 0; s < 3; s++) {
        let v = 0;
        for (let t = 0; t < 3; t++) v += Pis[t * Nv + i] * G[t * 3 + s];
        T1[i * 3 + s] = v;
      }
    }
    // AK1 = T1 · Pis (Nv × Nv)
    for (let i = 0; i < Nv; i++) {
      for (let j = 0; j < Nv; j++) {
        let v = 0;
        for (let s = 0; s < 3; s++) v += T1[i * 3 + s] * Pis[s * Nv + j];
        AK[i * Nv + j] = v;
      }
    }
    // term2 = (I−Pi)'(I−Pi)
    for (let i = 0; i < Nv; i++) {
      for (let j = 0; j < Nv; j++) {
        let v = 0;
        for (let r = 0; r < Nv; r++) {
          const Mir = (i === r ? 1 : 0) - Pi[r * Nv + i];
          const Mrj = (r === j ? 1 : 0) - Pi[r * Nv + j];
          v += Mir * Mrj;
        }
        AK[i * Nv + j] += v;
      }
    }

    return { AK, area, hK, Pis };
  }

  /**
   * Projected gradient of the solution restricted to one element:
   * ∇u|_E ≈ Π∇u = Σ_s c_s ∇m_s with c = Pis·u_local.
   * ring: {x,y}[] vertices; uLoc: nodal values at the same order.
   * Returns { gx, gy } (the reconstructed gradient, unscaled by k).
   */
  function elementProjectedGradient(ring, uLoc) {
    const { Pis, hK } = elementStiffness(ring);
    const Nv = ring.length;
    let c1 = 0, c2 = 0;
    for (let i = 0; i < Nv; i++) {
      c1 += Pis[1 * Nv + i] * uLoc[i];
      c2 += Pis[2 * Nv + i] * uLoc[i];
    }
    return { gx: c1 / hK, gy: c2 / hK };
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Solver = global.MeshStudio.Solver || {};
  global.MeshStudio.Solver.Poisson = global.MeshStudio.Solver.Poisson || {};
  global.MeshStudio.Solver.Poisson.vem = {
    elementStiffness,
    elementProjectedGradient,
  };
})(window);
