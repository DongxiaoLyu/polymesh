/* ============================================================
   assembly.js — Global assembly & solve for the 2D elasticity block
   ============================================================
   Solves the plane-stress linear elasticity problem (k=1 VEM):

     −div σ(u) = f  in Ω,   σ = C:ε(u)   (plane stress)
       u = g  on Γ_D        (prescribed displacement DOFs)
       σ·n = t on Γ_N       (surface traction / line load)

   DOF layout matches the reference (globalK.txt): node i contributes
   dof i  (ux_i) and dof n+i (uy_i), n = number of nodes. The mesh is
   used in its OWN coordinate frame (the app's y-down screen space) —
   this assembly is frame-agnostic, so every load vector handed in must
   already be expressed in that frame (the UI layer flips the FEM
   convention's +Y-up components to the screen frame before calling).

   Assembly:
     - element stiffness  AK (elastic vem)  → triplets (summed by CRS)
     - constant body force  b_i += f·|E|/Nv  (per component; exact for
       constant f, same quadrature-free load as the Poisson block)
     - point loads / edge tractions q·L/2 per endpoint (trapezoid,
       exact for piecewise-constant tractions on straight edges)
     - pressureToTraction() converts uniform boundary-pressure BCs
       (p > 0 pushes INTO the domain) into such edge tractions
   Dirichlet uses the standard symmetric reduction
     K_ff·u_f = b_f − K_fp·u_p   (free / prescribed split)
   solved with the sparse preconditioned CG solver (matrix.js).
   Rigid-body modes are the caller's responsibility to suppress
   (the UI gates on ≥ 2 constrained nodes).

   Depends on:  matrix.js, vem.js
   Exposes:     window.MeshStudio.Solver.Elastic.assembly
   ============================================================ */

(function (global) {
  'use strict';

  const Matrix = global.MeshStudio.Solver.Matrix;
  const Vem = global.MeshStudio.Solver.Elastic.vem;

  /**
   * Convert uniform-pressure BC groups into constant edge-traction loads.
   *
   * pressure groups: [{ name, edges: [[a,b],…], p }] — edges are mesh
   * boundary edges (0-based, undirected). A pressure p > 0 pushes INTO the
   * domain, i.e. the traction vector on an edge equals −p·n̂_out where n̂_out
   * is the OUTWARD unit normal of the boundary edge.
   *
   * The outward normal is derived from the element ring order: the domain
   * boundary consists of edges used by exactly ONE element, and that
   * element stores its vertices CCW (shoelace-positive), so for the ring
   * edge (a→b) the outward normal is (dy, −dx)/L with (dx,dy) = b−a.
   *
   * Returns a `traction` array consumable by solveElastic:
   *   [{ a, b, fx, fy }]  — constant line load per unit length.
   */
  function pressureToTraction(mesh, pressureGroups) {
    if (!pressureGroups || !pressureGroups.length) return [];
    const nodes = mesh.nodes;

    // Boundary ring-order: first orientation seen for edges used once.
    const seen = new Map(); // key 'a_b' -> { a, b (ring order), n }
    for (const el of mesh.elements) {
      const ids = el.nodeIds;
      for (let i = 0; i < ids.length; i++) {
        const a = ids[i], b = ids[(i + 1) % ids.length];
        const k = a < b ? a + '_' + b : b + '_' + a;
        const e = seen.get(k);
        if (e) e.n++;
        else seen.set(k, { a, b, n: 1 });
      }
    }
    const ring = new Map(); // key -> ring-ordered [ra, rb]
    for (const e of seen.values()) if (e.n === 1) ring.set((e.a < e.b ? e.a + '_' + e.b : e.b + '_' + e.a), [e.a, e.b]);

    const out = [];
    for (const g of pressureGroups) {
      for (const [ua, ub] of g.edges) {
        const k = ua < ub ? ua + '_' + ub : ub + '_' + ua;
        const ro = ring.get(k);
        if (!ro) continue; // not a boundary edge — ignore defensively
        const [ra, rb] = ro;
        const dx = nodes[rb].x - nodes[ra].x;
        const dy = nodes[rb].y - nodes[ra].y;
        const L = Math.hypot(dx, dy);
        if (L < 1e-14) continue;
        // inward normal (p>0 pushes into the domain): −n̂_out = (−dy, dx)/L
        out.push({ a: ua, b: ub, fx: -g.p * dy / L, fy: g.p * dx / L });
      }
    }
    return out;
  }

  /**
   * Solve the plane-stress elasticity problem on an existing mesh.
   *
   * mesh: { nodes: [{x,y}], elements: [{ nodeIds, interior }] }
   * opts: {
   *   E, nu:           material (plane stress)
   *   prescribed:      { flatDof: value } — flatDof = nodeId for ux,
   *                    nodeId + n for uy (first value wins)
   *   point:           [{ node, fx, fy }]  nodal forces
   *   traction:        [{ a, b, fx, fy }]  constant line load per unit
   *                    length on mesh edge a–b (frame-agnostic)
   *   body:            null | { fx, fy } | per-element array — a constant
   *                    body force over the whole domain, or one constant
   *                    { fx, fy } per element (sampled e.g. at the element
   *                    centroid) for manufactured-solution tests
   *   tol:             CG tolerance (default 1e-12)
   * }
   * Returns { u: Float64Array(2n) — [ux_0..ux_{n-1}, uy_0..uy_{n-1}],
   *           iterations, residual, nf }.
   */
  function solveElastic(mesh, opts) {
    opts = opts || {};
    const E = opts.E != null ? opts.E : 1;
    const nu = opts.nu != null ? opts.nu : 0.3;
    const prescribed = opts.prescribed || {};
    const point = opts.point || [];
    const traction = opts.traction || [];
    const body = opts.body || null;

    const nodes = mesh.nodes;
    const elements = mesh.elements;
    const n = nodes.length;
    const ndof = 2 * n;
    if (!elements.length) throw new Error('empty mesh');
    Vem.planeStressC(E, nu); // validate material, throw early on bad input

    // ----- element loop: triplets + body-force RHS -----
    const triplets = [];
    const b = new Float64Array(ndof);
    for (let e = 0; e < elements.length; e++) {
      const ids = elements[e].nodeIds;
      const Nv = ids.length;
      const ring = new Array(Nv);
      for (let i = 0; i < Nv; i++) ring[i] = nodes[ids[i]];
      const { AK, area } = Vem.elementStiffness(ring, { E, nu });
      const Ndof = 2 * Nv; // AK row stride (local dofs: x_1..x_Nv, y_1..y_Nv)
      const fEl = Array.isArray(body) ? body[e] : body;
      for (let i = 0; i < Nv; i++) {
        const gi = ids[i];
        const src = area / Nv;
        if (fEl) { // (per-element) constant body force: exact lumped load
          b[gi] += fEl.fx * src;
          b[n + gi] += fEl.fy * src;
        }
        for (let j = 0; j < Nv; j++) {
          const gj = ids[j];
          triplets.push([gi, gj, AK[i * Ndof + j]]);
          triplets.push([gi, n + gj, AK[i * Ndof + Nv + j]]);
          triplets.push([n + gi, gj, AK[(Nv + i) * Ndof + j]]);
          triplets.push([n + gi, n + gj, AK[(Nv + i) * Ndof + Nv + j]]);
        }
      }
    }

    // ----- point loads -----
    for (let p = 0; p < point.length; p++) {
      const { node, fx, fy } = point[p];
      b[node] += fx;
      b[n + node] += fy;
    }

    // ----- edge tractions: q·L/2 to each endpoint -----
    for (let p = 0; p < traction.length; p++) {
      const { a, b: b2, fx, fy } = traction[p];
      const L = Math.hypot(nodes[a].x - nodes[b2].x, nodes[a].y - nodes[b2].y);
      b[a] += fx * L / 2;
      b[b2] += fx * L / 2;
      b[n + a] += fy * L / 2;
      b[n + b2] += fy * L / 2;
    }

    // ----- Dirichlet reduction (symmetric; cf. Poisson assembly) -----
    const isPres = new Uint8Array(ndof);
    const u = new Float64Array(ndof);
    const presKeys = Object.keys(prescribed);
    for (let p = 0; p < presKeys.length; p++) {
      const id = Number(presKeys[p]);
      if (id >= 0 && id < ndof && !isPres[id]) { isPres[id] = 1; u[id] = prescribed[id]; }
    }

    const revFree = new Int32Array(ndof).fill(-1);
    const freeDofs = [];
    for (let i = 0; i < ndof; i++) {
      if (!isPres[i]) { revFree[i] = freeDofs.length; freeDofs.push(i); }
    }
    const nf = freeDofs.length;
    if (nf === 0) return { u, iterations: 0, residual: 0, nf: 0 };

    const bf = new Float64Array(nf);
    for (let i = 0; i < nf; i++) bf[i] = b[freeDofs[i]];
    for (let t = 0; t < triplets.length; t++) {
      const gi = triplets[t][0], gj = triplets[t][1], v = triplets[t][2];
      const ri = revFree[gi];
      if (ri >= 0 && isPres[gj]) bf[ri] -= v * u[gj];
    }

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
  global.MeshStudio.Solver.Elastic = global.MeshStudio.Solver.Elastic || {};
  global.MeshStudio.Solver.Elastic.assembly = { solveElastic, pressureToTraction };
})(window);
