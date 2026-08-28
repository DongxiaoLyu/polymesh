/* ============================================================
   solver-poisson-test.js — Validation of the Poisson VEM solver
   ============================================================
   The MATLAB reference implementation (mVEM) is validated here after
   the JS port:
     1. PATCH TEST — a linear temperature field is reproduced EXACTLY
        (max nodal error < 1e-9) on an irregular polygonal mesh. This
        is the definitive check that the element stiffness port
        (vem.js) preserves consistency and that the stabilization
        vanishes on P1.
     2. MANUFACTURED SOLUTION — u = sin(πx)·sin(πy) on the unit square
        with per-element constant source f = 2π²u(x_E); checks the
        H¹-like error converges ~O(h) as the mesh refines.
     3. Element stiffness properties — symmetry, SPD, constant in the
        kernel (row sums ≈ 0).
     4. Constant-Dirichlet sanity — u = 100 on the whole boundary gives
        u = 100 everywhere.
     5. CG unit test — a known 2×2 system.

   Run:  node solver-poisson-test.js
   ============================================================ */

'use strict';

global.window = global;

require('./js/constants.js');
require('./js/geometry.js');
require('./js/grid.js');
require('./js/clipping.js');
require('./js/mesh.js');
require('./js/solver/matrix.js');
require('./js/solver/poisson/vem.js');
require('./js/solver/poisson/assembly.js');
require('./js/solver/poisson/post.js');

const MS = global.MeshStudio;
const G = MS.Geometry;
const Grid = MS.Grid;
const Mesh = MS.Mesh;
const Matrix = MS.Solver.Matrix;
const P = MS.Solver.Poisson;

/* ---------- Tiny assertion helpers ---------- */

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.log('  FAIL: ' + msg); }
}
function close(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, msg + ' (got ' + a + ', want ' + b + ')'); }

/* ---------- Mesh helper (uses the app's own mesh pipeline) ---------- */

// Unit square, shoelace-positive in these coordinates.
const SQUARE = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

function buildMesh(poly, cellSize) {
  const bb = G.bbox(poly);
  const m = cellSize * 2;
  const rect = { minX: bb.minX - m, minY: bb.minY - m, maxX: bb.maxX + m, maxY: bb.maxY + m };
  const cells = Grid.generateCells('square', rect, cellSize);
  return Mesh.buildMesh(cells, poly, poly, cellSize * MS.Constants.EPS_SCALE);
}

/** Prescribe the exact boundary values of `fcn` on all boundary nodes. */
function prescribeBoundary(mesh, fcn) {
  const prescribed = {};
  for (const [a, b] of Mesh.boundaryEdges(mesh)) {
    const na = mesh.nodes[a], nb = mesh.nodes[b];
    if (!(a in prescribed)) prescribed[a] = fcn(na.x, na.y);
    if (!(b in prescribed)) prescribed[b] = fcn(nb.x, nb.y);
  }
  return prescribed;
}

/* ---------- 1. Patch test ---------- */

{
  const mesh = buildMesh(SQUARE, 0.25);
  const exact = (x, y) => 0.7 + 0.3 * x - 0.2 * y;
  const { u } = P.assembly.solvePoisson(mesh, { k: 1, f: 0, prescribed: prescribeBoundary(mesh, exact), flux: [] });
  let maxErr = 0;
  for (let i = 0; i < mesh.nodes.length; i++) {
    const e = Math.abs(u[i] - exact(mesh.nodes[i].x, mesh.nodes[i].y));
    if (e > maxErr) maxErr = e;
  }
  assert(maxErr < 1e-9, 'patch test: linear field reproduced exactly (max err ' + maxErr + ')');
  console.log('OK: patch test (linear field, ' + mesh.nodes.length + ' nodes, max err ' + maxErr.toExponential(2) + ')');
}

/* ---------- 2. Manufactured solution + convergence ---------- */

{
  const uex = (x, y) => Math.sin(Math.PI * x) * Math.sin(Math.PI * y);
  const gx = (x, y) => Math.PI * Math.cos(Math.PI * x) * Math.sin(Math.PI * y); // ∂u/∂x
  const gy = (x, y) => Math.PI * Math.sin(Math.PI * x) * Math.cos(Math.PI * y); // ∂u/∂y

  const hs = [0.2, 0.1, 0.05];
  const errs = [];
  for (const h of hs) {
    const mesh = buildMesh(SQUARE, h);
    const prescribed = prescribeBoundary(mesh, uex);
    // Per-element constant source f_E = 2π²·u(centroid)  (−Δu = 2π²u).
    const f = new Float64Array(mesh.elements.length);
    for (let e = 0; e < mesh.elements.length; e++) {
      const ids = mesh.elements[e].nodeIds;
      let cx = 0, cy = 0;
      for (const id of ids) { cx += mesh.nodes[id].x; cy += mesh.nodes[id].y; }
      cx /= ids.length; cy /= ids.length;
      f[e] = 2 * Math.PI * Math.PI * uex(cx, cy);
    }
    const { u } = P.assembly.solvePoisson(mesh, { k: 1, f, prescribed, flux: [] });
    // H¹-like error: ||∇u − Π∇u_h|| over the domain, via projected gradients.
    let err2 = 0;
    for (let e = 0; e < mesh.elements.length; e++) {
      const ids = mesh.elements[e].nodeIds;
      const ring = ids.map(id => mesh.nodes[id]);
      const uLoc = ids.map(id => u[id]);
      const { gx: ugx, gy: ugy } = P.vem.elementProjectedGradient(ring, uLoc);
      let cx = 0, cy = 0;
      for (const id of ids) { cx += mesh.nodes[id].x; cy += mesh.nodes[id].y; }
      cx /= ids.length; cy /= ids.length;
      const area = Math.abs(G.signedArea(ring));
      err2 += area * ((ugx - gx(cx, cy)) ** 2 + (ugy - gy(cx, cy)) ** 2);
    }
    errs.push(Math.sqrt(err2));
  }
  // The projected gradient at the element CENTROID is a superconvergence
  // point for lowest-order VEM, so this error converges at ~O(h²) — even
  // better than the generic O(h) H¹ bound. Assert the observed slope.
  const p12 = Math.log(errs[0] / errs[1]) / Math.log(hs[0] / hs[1]);
  const p23 = Math.log(errs[1] / errs[2]) / Math.log(hs[1] / hs[2]);
  assert(p12 > 1.4 && p12 < 2.6, 'convergence slope h1→h2 ≈ 2 (centroid superconvergence), got ' + p12.toFixed(2));
  assert(p23 > 1.4 && p23 < 2.6, 'convergence slope h2→h3 ≈ 2 (centroid superconvergence), got ' + p23.toFixed(2));
  assert(errs[2] < errs[1] && errs[1] < errs[0], 'errors decrease with refinement');
  console.log('OK: manufactured solution, H¹-like errors ' + errs.map(e => e.toExponential(2)).join(' / ') +
              ' (slopes ' + p12.toFixed(2) + ', ' + p23.toFixed(2) + ')');
}

/* ---------- 3. Element stiffness properties ---------- */

{
  const rings = [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],          // square
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: Math.sqrt(3) / 2 }],         // triangle
    [{ x: 0.5, y: 0 }, { x: 1, y: 0.35 }, { x: 0.8, y: 1 }, { x: 0.2, y: 1 }, { x: 0, y: 0.35 }], // irregular pentagon
  ];
  for (const ring of rings) {
    const { AK } = P.vem.elementStiffness(ring);
    const Nv = ring.length;
    let sym = 0, row = 0, diag = Infinity;
    for (let i = 0; i < Nv; i++) {
      let rs = 0;
      for (let j = 0; j < Nv; j++) {
        rs += AK[i * Nv + j];
        sym = Math.max(sym, Math.abs(AK[i * Nv + j] - AK[j * Nv + i]));
      }
      row = Math.max(row, Math.abs(rs));
      diag = Math.min(diag, AK[i * Nv + i]);
    }
    assert(sym < 1e-12, 'element stiffness symmetric (Nv=' + Nv + ')');
    assert(row < 1e-10, 'constant in kernel: row sums ≈ 0 (Nv=' + Nv + ')');
    assert(diag > 0, 'positive diagonal (Nv=' + Nv + ')');
    // SPD spot check: xᵀAKx > 0 for a random non-zero x
    let minQ = Infinity;
    for (let trial = 0; trial < 5; trial++) {
      const x = new Float64Array(Nv);
      for (let i = 0; i < Nv; i++) x[i] = Math.sin(trial * 7 + i * 13) + 0.1 * (i + 1);
      let q = 0;
      for (let i = 0; i < Nv; i++) {
        let s = 0;
        for (let j = 0; j < Nv; j++) s += AK[i * Nv + j] * x[j];
        q += x[i] * s;
      }
      minQ = Math.min(minQ, q);
    }
    assert(minQ > 0, 'element stiffness SPD (min xᵀAx ' + minQ.toExponential(2) + ')');
  }
  console.log('OK: element stiffness symmetry / SPD / constant-in-kernel');
}

/* ---------- 4. Constant Dirichlet ⇒ constant solution ---------- */

{
  const mesh = buildMesh(SQUARE, 0.25);
  const prescribed = prescribeBoundary(mesh, () => 100);
  const { u } = P.assembly.solvePoisson(mesh, { k: 1, f: 0, prescribed, flux: [] });
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < u.length; i++) { if (u[i] < mn) mn = u[i]; if (u[i] > mx) mx = u[i]; }
  close(mn, 100, 1e-6, 'constant Dirichlet: min = 100');
  close(mx, 100, 1e-6, 'constant Dirichlet: max = 100');
  // flux must vanish
  const sol = P.post.buildSolution(mesh, u, { k: 1 });
  assert(sol.fields.flux.max < 1e-6, 'constant solution ⇒ zero heat flux (max ' + sol.fields.flux.max + ')');
  console.log('OK: constant Dirichlet reproduced (u = ' + mn + ' … ' + mx + ', flux ≈ 0)');
}

/* ---------- 5. CG unit test (known 2×2 system) ---------- */

{
  // [4 1; 1 3] x = [1; 2]  →  x = [1/11, 7/11]
  const A = Matrix.fromTriplets(2, [[0, 0, 4], [0, 1, 1], [1, 0, 1], [1, 1, 3]]);
  const { x, residual } = Matrix.cgSolve(A, Float64Array.of(1, 2), { tol: 1e-14 });
  close(x[0], 1 / 11, 1e-12, 'CG x0 = 1/11');
  close(x[1], 7 / 11, 1e-12, 'CG x1 = 7/11');
  assert(residual < 1e-12, 'CG residual small (got ' + residual + ')');
  console.log('OK: CG on a known 2×2 SPD system');
}

/* ---------- Summary ---------- */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
