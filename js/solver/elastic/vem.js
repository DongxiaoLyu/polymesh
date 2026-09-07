/* ============================================================
   vem.js — Lowest-order (k=1) VEM element stiffness for 2D linear
            elasticity (plane stress)
   ============================================================
   Direct port of the reference MATLAB implementation (mVEM solid,
   B. Xu, Leibniz Universität Hannover — Matlab_Mechancial/*.txt,
   https://www.sciencedirect.com/science/article/pii/S0045782519301215):
     elemK.txt        — element stiffness matrix
     myM_matrix.txt   — vector-valued scaled monomials at the vertices
     calculatePi.txt  — scalar (per-component) projector for stress
                        recovery (post-processing)
   with the element projector solved through the shared dense solver
   (js/solver/matrix.js solveDense).

   Conventions (must match the reference code):
     - the vertex ring is shoelace-POSITIVE (mesh.js/clipping.js
       guarantee this for every element), so the rotated edge vector
       Ne = [y_next−y_prev, x_prev−x_next] is OUTWARD × edge length —
       this also holds in the app's y-down screen coordinates;
     - local DOF order: [ux_1..ux_Nv, uy_1..uy_Nv] (2·Nv DOFs);
     - the k=1 vector monomial basis (Eq. (22) of the reference) is
       m = [ (1,0), (0,1), (−η,ξ), (η,ξ), (ξ,0), (0,η) ] with the
       scaled coords ξ=(x−xK)/hK, η=(y−yK)/hK — translations, the rigid
       rotation (−η,ξ) (zero strain), pure shear and the two normal
       strains. B and Bs are 6×2Nv.
     - plane stress ONLY (plane strain variant left commented out in
       the reference);
     - stabilization: alpha = trace(Ke_c)/Nv, Ke_s = alpha·(I−Pi)'(I−Pi)
       (Eq. (42) — note this DIFFERS from the Poisson port, whose
       reference used an unscaled stabilization: elasticity must scale
       with the material tensor C).

   Element stiffness (Eq. (31)–(42) of the reference):
     D   = myM_matrix ring          (2Nv × 6)
     B   = consistency via Green: ∫_E Cε(m_s):∇φ_i = ∮ φ_i σ(m_s)·n  (6×2Nv)
     B0  = [B01; B02] constraints fixing translations & rotation
     Bs  = B with rows 0..2 replaced by B0
     G   = B·D,  Gs = Bs·D           (6×6)
     Pis = Gs⁻¹·Bs                   (6×2Nv, monomial-coefficient projector)
     Pi  = D·Pis                     (2Nv×2Nv, DOF-space projector)
     Ke_c  = Pis'·G·Pis
     alpha = trace(Ke_c)/Nv
     AK    = Ke_c + alpha·(I−Pi)'(I−Pi)

   Exposes:  window.MeshStudio.Solver.Elastic.vem
   Depends on:  matrix.js (solveDense)
   ============================================================ */

(function (global) {
  'use strict';

  const Matrix = global.MeshStudio.Solver.Matrix;
  const solveDense = Matrix.solveDense;

  /* ---------- Shared element geometry ---------- */

  /**
   * Area (shoelace), area-weighted centroid and diameter of a ring.
   * Mirrors the app's Poisson vem.js (and the reference globalK).
   * Returns { Nv, area, cx, cy, hK }.
   */
  function elementGeometry(ring) {
    const Nv = ring.length;
    if (Nv < 3) throw new Error('element needs at least 3 vertices');
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
    return { Nv, area, cx, cy, hK };
  }

  /* ---------- Plane-stress constitutive matrix (Voigt, γ = 2εxy) ---------- */

  function planeStressC(E, nu) {
    if (!(E > 0) || !isFinite(E)) throw new Error('Young modulus E must be positive');
    if (!(nu > 0 && nu < 0.5) || !isFinite(nu)) throw new Error('Poisson ratio nu must be in (0, 0.5)');
    const c11 = E / (1 - nu * nu);
    const c33 = E / (2 * (1 + nu));
    return [c11, nu * c11, 0, nu * c11, c11, 0, 0, 0, c33]; // row-major 3×3
  }

  /* ---------- D: vector-valued scaled monomials (2Nv × 6) ---------- */

  /**
   * Rows 0..Nv−1 are the x-component values of the 6 basis functions at
   * the Nv vertices, rows Nv..2Nv−1 the y-component values (myM_matrix).
   */
  function monomialMatrix(ring, cx, cy, hK, Nv) {
    const D = new Float64Array(Nv * 2 * 6);
    for (let i = 0; i < Nv; i++) {
      const xi = (ring[i].x - cx) / hK;
      const eta = (ring[i].y - cy) / hK;
      // col 0: (1,0)
      D[i * 6 + 0] = 1;
      // col 1: (0,1)
      D[(Nv + i) * 6 + 1] = 1;
      // col 2: (−η, ξ) — rigid rotation
      D[i * 6 + 2] = -eta;
      D[(Nv + i) * 6 + 2] = xi;
      // col 3: (η, ξ) — pure shear
      D[i * 6 + 3] = eta;
      D[(Nv + i) * 6 + 3] = xi;
      // col 4: (ξ, 0) — εxx
      D[i * 6 + 4] = xi;
      // col 5: (0, η) — εyy
      D[(Nv + i) * 6 + 5] = eta;
    }
    return D;
  }

  /* ---------- Element stiffness ---------- */

  /**
   * Element stiffness matrix (k = 1, plane stress).
   * ring: array of {x, y} (CCW / shoelace-positive), 2D coords.
   * mat:  { E, nu }.
   * Returns { AK (2Nv×2Nv flat row-major), area, hK }.
   */
  function elementStiffness(ring, mat) {
    const E = mat.E, nu = mat.nu;
    const C = planeStressC(E, nu);
    const { Nv, area, cx, cy, hK } = elementGeometry(ring);
    const Ndof = 2 * Nv;

    // ----- D (2Nv × 6) -----
    const D = monomialMatrix(ring, cx, cy, hK, Nv);

    // ----- B (6 × 2Nv): boundary-integral consistency, Eq. (32) -----
    // Strain of the s-th basis in Voigt (with γ = 2εxy):
    //   rows 0..2 (translations + rotation) vanish; then shear / εxx / εyy.
    const ER = new Float64Array(6 * 3);
    ER[3 * 3 + 2] = 2 / hK;   // basis (η,ξ): γ = ∂m_x/∂y + ∂m_y/∂x = 2/hK
    ER[4 * 3 + 0] = 1 / hK;   // basis (ξ,0): εxx
    ER[5 * 3 + 1] = 1 / hK;   // basis (0,η): εyy

    const B = new Float64Array(6 * Ndof);
    for (let n = 0; n < Nv; n++) {
      const v1 = n, v2 = (n + 1) % Nv;
      const dY = ring[v2].y - ring[v1].y; // Δy
      const dX = ring[v2].x - ring[v1].x; // Δx
      const Ne1 = dY, Ne2 = -dX;          // outward normal × edge length
      for (let s = 0; s < 6; s++) {
        // σ = C·ε(m_s) (Voigt)
        const e0 = ER[s * 3 + 0], e1 = ER[s * 3 + 1], e2 = ER[s * 3 + 2];
        const sxx = C[0] * e0 + C[1] * e1 + C[2] * e2;
        const syy = C[3] * e0 + C[4] * e1 + C[5] * e2;
        const sxy = C[6] * e0 + C[7] * e1 + C[8] * e2;
        // ∮_edge φ σ n ds → ½·(σn)·L to EACH endpoint (linear trace split)
        const xterm = 0.5 * (sxx * Ne1 + sxy * Ne2);
        const yterm = 0.5 * (sxy * Ne1 + syy * Ne2);
        B[s * Ndof + v1] += xterm;
        B[s * Ndof + v2] += xterm;
        B[s * Ndof + Nv + v1] += yterm;
        B[s * Ndof + Nv + v2] += yterm;
      }
    }

    // ----- B0 constraints (Eq. (35)/(37)/(38)): rows 0..2 of Bs -----
    const B0 = new Float64Array(3 * Ndof);
    for (let n = 0; n < Nv; n++) {
      const v1 = n, v2 = (n + 1) % Nv;
      const dY = ring[v2].y - ring[v1].y;
      const dX = ring[v2].x - ring[v1].x;
      // B01 (row 0): tangent-weighted — fixes the rotation freedom
      B0[0 * Ndof + v1] += 0.5 * dX;
      B0[0 * Ndof + v2] += 0.5 * dX;
      B0[0 * Ndof + Nv + v1] += 0.5 * dY;
      B0[0 * Ndof + Nv + v2] += 0.5 * dY;
      // B02 rows 1,2: unit integrals — fix the two translations
      B0[1 * Ndof + v1] += 0.5;
      B0[1 * Ndof + v2] += 0.5;
      B0[2 * Ndof + Nv + v1] += 0.5;
      B0[2 * Ndof + Nv + v2] += 0.5;
    }
    const Bs = Float64Array.from(B);
    for (let j = 0; j < Ndof; j++) {
      Bs[0 * Ndof + j] = B0[0 * Ndof + j];
      Bs[1 * Ndof + j] = B0[1 * Ndof + j];
      Bs[2 * Ndof + j] = B0[2 * Ndof + j];
    }

    // ----- G = B·D, Gs = Bs·D (6×6) -----
    const G = new Float64Array(36), Gs = new Float64Array(36);
    for (let s = 0; s < 6; s++) {
      for (let t = 0; t < 6; t++) {
        let v = 0, w = 0;
        for (let i = 0; i < Ndof; i++) {
          v += B[s * Ndof + i] * D[i * 6 + t];
          w += Bs[s * Ndof + i] * D[i * 6 + t];
        }
        G[s * 6 + t] = v;
        Gs[s * 6 + t] = w;
      }
    }

    // ----- Pis = Gs⁻¹·Bs (6×2Nv), Pi = D·Pis (2Nv×2Nv) -----
    const Pis = solveDense(Gs, Bs, 6, Ndof);
    const Pi = new Float64Array(Ndof * Ndof);
    for (let i = 0; i < Ndof; i++) {
      for (let j = 0; j < Ndof; j++) {
        let v = 0;
        for (let s = 0; s < 6; s++) v += D[i * 6 + s] * Pis[s * Ndof + j];
        Pi[i * Ndof + j] = v;
      }
    }

    // ----- Ke_c = Pis'·G·Pis (2Nv×2Nv) -----
    const T = new Float64Array(6 * Ndof);       // T = G·Pis
    for (let s = 0; s < 6; s++) {
      for (let j = 0; j < Ndof; j++) {
        let v = 0;
        for (let t = 0; t < 6; t++) v += G[s * 6 + t] * Pis[t * Ndof + j];
        T[s * Ndof + j] = v;
      }
    }
    const AK = new Float64Array(Ndof * Ndof);
    let trace = 0;
    for (let i = 0; i < Ndof; i++) {
      for (let j = 0; j < Ndof; j++) {
        let v = 0;
        for (let s = 0; s < 6; s++) v += Pis[s * Ndof + i] * T[s * Ndof + j];
        AK[i * Ndof + j] = v;
      }
      trace += AK[i * Ndof + i];
    }

    // ----- stabilization: alpha = trace(Ke_c)/Nv, Ke_s = alpha·(I−Pi)'(I−Pi) -----
    const alpha = trace / Nv;
    for (let i = 0; i < Ndof; i++) {
      for (let j = 0; j < Ndof; j++) {
        let v = 0;
        for (let r = 0; r < Ndof; r++) {
          const Mir = (i === r ? 1 : 0) - Pi[r * Ndof + i];
          const Mrj = (r === j ? 1 : 0) - Pi[r * Ndof + j];
          v += Mir * Mrj;
        }
        AK[i * Ndof + j] += alpha * v;
      }
    }

    return { AK, area, hK };
  }

  /* ---------- Scalar (per-component) projector for post-processing ---------- */

  /**
   * k=1 scalar projector onto P1 — the reference calculatePi.txt.
   * Used to recover ∇ux and ∇uy for strain/stress post-processing.
   * Returns { Pis (3×Nv flat row-major: rows = const, ξ, η coefficients),
   *           hK }.
   */
  function scalarProjector(ring) {
    const { Nv, cx, cy, hK } = elementGeometry(ring);

    // Scalar scaled monomials at the vertices (Nv × 3): [1, ξ, η]
    const D = new Float64Array(Nv * 3);
    for (let i = 0; i < Nv; i++) {
      D[i * 3 + 0] = 1;
      D[i * 3 + 1] = (ring[i].x - cx) / hK;
      D[i * 3 + 2] = (ring[i].y - cy) / hK;
    }

    // B (3 × Nv): ∫_∂E φ_i ∇m_s·n ds with ∇ξ = (1/hK, 0), ∇η = (0, 1/hK).
    const B = new Float64Array(3 * Nv);
    for (let i = 0; i < Nv; i++) {
      const prev = ring[(i - 1 + Nv) % Nv], next = ring[(i + 1) % Nv];
      const nx = 0.5 * (next.y - prev.y);   // ∫_∂E φ_i n_x ds
      const ny = 0.5 * (prev.x - next.x);   // ∫_∂E φ_i n_y ds
      B[1 * Nv + i] = nx / hK;
      B[2 * Nv + i] = ny / hK;
    }
    const Bs = Float64Array.from(B);
    for (let i = 0; i < Nv; i++) Bs[i] = 1 / Nv; // row 0: average constraint

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
    const Pis = solveDense(Gs, Bs, 3, Nv);
    return { Pis, hK };
  }

  /**
   * Projected gradient of one scalar component inside an element:
   * ∇v|_E ≈ Π∇v = (c_ξ, c_η)/hK with c = Pis·v_local.
   * Returns { gx, gy } (already divided by hK).
   */
  function elementProjectedGradient(ring, vLoc) {
    const { Pis, hK } = scalarProjector(ring);
    const Nv = ring.length;
    let c1 = 0, c2 = 0;
    for (let i = 0; i < Nv; i++) {
      c1 += Pis[1 * Nv + i] * vLoc[i];
      c2 += Pis[2 * Nv + i] * vLoc[i];
    }
    return { gx: c1 / hK, gy: c2 / hK };
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Solver = global.MeshStudio.Solver || {};
  global.MeshStudio.Solver.Elastic = global.MeshStudio.Solver.Elastic || {};
  global.MeshStudio.Solver.Elastic.vem = {
    planeStressC,
    elementGeometry,
    elementStiffness,
    scalarProjector,
    elementProjectedGradient,
  };
})(window);
