/* ============================================================
   post.js — Post-processing for the 2D elasticity VEM block
   ============================================================
   Turns the nodal solution u (2·n: [ux.., uy..]) into the per-field
   display data the heatmap legend + canvas consume, mirroring the
   reference calculateStress.txt:
     - per element, recover the projected gradients Π∇ux, Π∇uy at the
       centroid (scalar projector, calculatePi.txt) and form the Voigt
       strain ε = [ux,x, uy,y, ux,y+uy,x]; stress σ = C·ε (plane stress);
     - accumulate the constant element strain/stress onto its vertices
       and divide by the visit count — nodal averaging;
     - derive three nodal display fields:
         displacement — |u|
         strain       — equivalent strain (principal-strain formula
                        identical in structure to the Mises one)
         stress       — von Mises stress
   Produces the exact `state.solution` shape the solver shell expects:
     { fields: { displacement: { data (n), min, max },
                 strain:       { data (n), min, max },
                 stress:       { data (n), min, max } },
       iterations, residual }
   All field arrays have length = nodes.length (nodal fields → the UI
   renders them with fan triangulation).

   Depends on:  vem.js
   Exposes:     window.MeshStudio.Solver.Elastic.post
   ============================================================ */

(function (global) {
  'use strict';

  const Vem = global.MeshStudio.Solver.Elastic.vem;

  /** min/max of an array (0 when empty). */
  function minMax(arr) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < mn) mn = arr[i];
      if (arr[i] > mx) mx = arr[i];
    }
    return { min: mn === Infinity ? 0 : mn, max: mx === -Infinity ? 0 : mx };
  }

  /**
   * Projected Voigt strain of one element (constant over the element,
   * evaluated at the centroid): [εxx, εyy, γxy] with γ = 2εxy.
   */
  function elementStrainVoigt(mesh, u, eIndex) {
    const ids = mesh.elements[eIndex].nodeIds;
    const Nv = ids.length;
    const ring = new Array(Nv);
    const ux = new Float64Array(Nv), uy = new Float64Array(Nv);
    for (let i = 0; i < Nv; i++) {
      ring[i] = mesh.nodes[ids[i]];
      ux[i] = u[ids[i]];
      uy[i] = u[mesh.nodes.length + ids[i]];
    }
    const { Pis, hK } = Vem.scalarProjector(ring);
    let cx = 0, cy = 0;
    for (let i = 0; i < Nv; i++) {
      cx += Pis[1 * Nv + i] * ux[i];
      cy += Pis[2 * Nv + i] * ux[i];
    }
    const uxx = cx / hK, uxy = cy / hK;
    cx = 0; cy = 0;
    for (let i = 0; i < Nv; i++) {
      cx += Pis[1 * Nv + i] * uy[i];
      cy += Pis[2 * Nv + i] * uy[i];
    }
    const uyx = cx / hK, uyy = cy / hK;
    return { exx: uxx, eyy: uyy, gxy: uxy + uyx };
  }

  /** Equivalent strain (same principal formula as the Mises one). */
  function equivalentStrain(exx, eyy, gxy) {
    const mean = (exx + eyy) / 2;
    const rad = Math.sqrt(((exx - eyy) / 2) * ((exx - eyy) / 2) + (gxy / 2) * (gxy / 2));
    const e1 = mean + rad, e2 = mean - rad;
    return Math.sqrt((e1 * e1 + e2 * e2 + (e1 - e2) * (e1 - e2)) / 2);
  }

  /** Von Mises stress from averaged Voigt stress components. */
  function vonMises(sxx, syy, sxy) {
    const mean = (sxx + syy) / 2;
    const rad = Math.sqrt(((sxx - syy) / 2) * ((sxx - syy) / 2) + sxy * sxy);
    const s1 = mean + rad, s2 = mean - rad;
    return Math.sqrt((s1 * s1 + s2 * s2 + (s1 - s2) * (s1 - s2)) / 2);
  }

  /**
   * Build the state.solution object for the given nodal solution.
   * mat: { E, nu } plane-stress material used for the stress field.
   */
  function buildSolution(mesh, u, mat) {
    const E = mat.E, nu = mat.nu;
    const C = Vem.planeStressC(E, nu);
    const n = mesh.nodes.length;
    const elements = mesh.elements;

    // Accumulators for the nodal Voigt stress / strain averages.
    const eA = new Float64Array(3 * n); // exx, eyy, gxy per node
    const sA = new Float64Array(3 * n); // sxx, syy, sxy per node
    const cnt = new Int32Array(n);

    for (let e = 0; e < elements.length; e++) {
      const ids = elements[e].nodeIds;
      const { exx, eyy, gxy } = elementStrainVoigt(mesh, u, e);
      const sxx = C[0] * exx + C[1] * eyy;
      const syy = C[3] * exx + C[4] * eyy;
      const sxy = C[8] * gxy; // C33·γ (plane stress)
      for (let k = 0; k < ids.length; k++) {
        const i = ids[k];
        eA[i] += exx; eA[n + i] += eyy; eA[2 * n + i] += gxy;
        sA[i] += sxx; sA[n + i] += syy; sA[2 * n + i] += sxy;
        cnt[i]++;
      }
    }

    const displacement = new Float64Array(n);
    const strain = new Float64Array(n);
    const stress = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      displacement[i] = Math.hypot(u[i], u[n + i]);
      if (cnt[i]) {
        const exx = eA[i] / cnt[i], eyy = eA[n + i] / cnt[i], gxy = eA[2 * n + i] / cnt[i];
        strain[i] = equivalentStrain(exx, eyy, gxy);
        const sxx = sA[i] / cnt[i], syy = sA[n + i] / cnt[i], sxy = sA[2 * n + i] / cnt[i];
        stress[i] = vonMises(sxx, syy, sxy);
      }
    }

    const dr = minMax(displacement), er = minMax(strain), sr = minMax(stress);
    return {
      fields: {
        displacement: { data: displacement, min: dr.min, max: dr.max },
        strain:       { data: strain,       min: er.min, max: er.max },
        stress:       { data: stress,       min: sr.min, max: sr.max },
      },
    };
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Solver = global.MeshStudio.Solver || {};
  global.MeshStudio.Solver.Elastic = global.MeshStudio.Solver.Elastic || {};
  global.MeshStudio.Solver.Elastic.post = {
    minMax, elementStrainVoigt, equivalentStrain, vonMises, buildSolution,
  };
})(window);
