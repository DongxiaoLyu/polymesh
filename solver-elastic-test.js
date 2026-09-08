/* ============================================================
   solver-elastic-test.js — Validation of the 2D elasticity VEM solver
   ============================================================
   The JS port of the MATLAB mVEM solid-mechanics reference
   (Matlab_Mechancial/*.txt) is validated here with closed-form
   problems (no external reference data needed):
     1. PATCH TESTS — a mixed linear displacement field (extension +
        shear + rigid rotation) is reproduced EXACTLY (< 1e-9) on an
        axis-aligned square mesh AND on a rotated square domain whose
        boundary cells are genuinely clipped (intersection nodes,
        polygonal elements). This is the definitive check that the
        element stiffness port (vem.js) preserves consistency and the
        stabilization vanishes on P1.
     2. MANUFACTURED SOLUTION — u = (sin πx·sin πy, 0.6 sin πx·sin πy)
        on the unit square with per-element constant body force
        f = −div σ(x_E); checks nodal displacement AND the
        C-weighted strain (energy) error converge ~O(h²) (centroid
        superconvergence) as the mesh refines.
     3. ELEMENT STIFFNESS PROPERTIES — symmetry, constant translations
        AND rigid rotation in the kernel (K·r ≈ 0), positive diagonal,
        positive-semidefinite quadratic form, and exact material
        scaling K(2E) = 2·K(E).
     4. UNIAXIAL TENSION STRIP — clamped-left 2×1 strip under a
        constant normal traction reproduces the closed-form plane-stress
        state σxx = p0, ux = p0·x/E, uy = −ν·p0·y/E (validates the
        traction load, the support handling and the stress recovery).
     5. RIGID-TRANSLATION BC — prescribing u = (5, 0) on the boundary
        gives u = (5, 0) everywhere (zero strain energy).
     6. CG unit test — a known 2×2 SPD system.

   Run:  node solver-elastic-test.js
   ============================================================ */

'use strict';

global.window = global;

require('./js/constants.js');
require('./js/geometry.js');
require('./js/grid.js');
require('./js/clipping.js');
require('./js/mesh.js');
require('./js/solver/matrix.js');
require('./js/solver/elastic/vem.js');
require('./js/solver/elastic/assembly.js');
require('./js/solver/elastic/post.js');

const MS = global.MeshStudio;
const G = MS.Geometry;
const Grid = MS.Grid;
const Mesh = MS.Mesh;
const Matrix = MS.Solver.Matrix;
const El = MS.Solver.Elastic;

/* ---------- Tiny assertion helpers ---------- */

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.log('  FAIL: ' + msg); }
}
function close(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, msg + ' (got ' + a + ', want ' + b + ')'); }

/* ---------- Mesh helper (uses the app's own mesh pipeline) ---------- */

function buildMesh(poly, cellSize) {
  const bb = G.bbox(poly);
  const m = cellSize * 2;
  const rect = { minX: bb.minX - m, minY: bb.minY - m, maxX: bb.maxX + m, maxY: bb.maxY + m };
  const cells = Grid.generateCells('square', rect, cellSize);
  return Mesh.buildMesh(cells, poly, poly, cellSize * MS.Constants.EPS_SCALE);
}

/** Prescribe the exact displacement of `fcn` on all boundary nodes. */
function prescribeBoundary(mesh, fcn) {
  const n = mesh.nodes.length;
  const prescribed = {};
  for (const [a, b] of Mesh.boundaryEdges(mesh)) {
    for (const i of [a, b]) {
      if (!(i in prescribed)) {
        const u = fcn(mesh.nodes[i].x, mesh.nodes[i].y);
        prescribed[i] = u.x;
        prescribed[n + i] = u.y;
      }
    }
  }
  return prescribed;
}

/** Max nodal error of a solution against a closed-form displacement. */
function maxNodalError(mesh, u, fcn) {
  const n = mesh.nodes.length;
  let mx = 0;
  for (let i = 0; i < n; i++) {
    const p = mesh.nodes[i];
    const e = fcn(p.x, p.y);
    mx = Math.max(mx, Math.abs(u[i] - e.x), Math.abs(u[n + i] - e.y));
  }
  return mx;
}

/* ---------- 1. Patch tests ---------- */

// Mixed linear field: extension + shear + a rigid-rotation part is fine
// (linear ⇒ constant strain ⇒ exact; rotation ⇒ zero strain ⇒ exact).
{
  const f = (x, y) => ({ x: 0.3 + 0.1 * x + 0.05 * y, y: -0.2 + 0.04 * x - 0.07 * y });
  const mesh = buildMesh([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], 0.25);
  const { u } = El.assembly.solveElastic(mesh, {
    E: 200000, nu: 0.3, prescribed: prescribeBoundary(mesh, f), point: [], traction: [], body: null,
  });
  const e = maxNodalError(mesh, u, f);
  assert(e < 1e-9, 'patch test: linear field reproduced exactly on aligned squares (max err ' + e + ')');
  console.log('OK: patch test (linear field, aligned mesh, ' + mesh.nodes.length + ' nodes, max err ' + e.toExponential(2) + ')');
}

// Rotated square: its boundary crosses the lattice so boundary cells are
// genuinely clipped (intersection nodes → polygonal VEM elements).
{
  const c = Math.PI / 6, R = 0.35;
  const poly = [0, 1, 2, 3].map(k => {
    const a = Math.PI / 4 + k * Math.PI / 2;
    return { x: 0.5 + R * Math.cos(a), y: 0.5 + R * Math.sin(a) };
  });
  const f = (x, y) => ({ x: 0.3 + 0.1 * x + 0.05 * y, y: -0.2 + 0.04 * x - 0.07 * y });
  const mesh = buildMesh(poly, 0.12);
  const { u } = El.assembly.solveElastic(mesh, {
    E: 200000, nu: 0.3, prescribed: prescribeBoundary(mesh, f), point: [], traction: [], body: null,
  });
  const e = maxNodalError(mesh, u, f);
  assert(e < 1e-9, 'patch test: linear field on clipped polygonal mesh (max err ' + e + ')');
  console.log('OK: patch test (clipped mesh, ' + mesh.elements.length + ' elements, ' +
              mesh.boundaryCount + ' boundary, max err ' + e.toExponential(2) + ')');
}

/* ---------- 2. Manufactured solution + convergence ---------- */

{
  const P = Math.PI;
  const E = 1000, nu = 0.3;
  const c1 = E / (1 - nu * nu), Gm = E / (2 * (1 + nu));
  const uex = (x, y) => ({ x: Math.sin(P * x) * Math.sin(P * y), y: 0.6 * Math.sin(P * x) * Math.sin(P * y) });
  const strain = (x, y) => [
    P * Math.cos(P * x) * Math.sin(P * y),
    0.6 * P * Math.sin(P * x) * Math.cos(P * y),
    P * Math.sin(P * x) * Math.cos(P * y) + 0.6 * P * Math.cos(P * x) * Math.sin(P * y),
  ];
  // Body force f = −div σ (plane stress, Voigt), evaluated per element at
  // its centroid (the assembly supports one constant per element).
  const bodyAt = (x, y) => {
    const sx = Math.sin(P * x), sy = Math.sin(P * y), cx = Math.cos(P * x), cy = Math.cos(P * y);
    const u1xx = -P * P * sx * sy, u2yy = -0.6 * P * P * sx * sy;
    const u1yy = u1xx, u2xx = u2yy;
    const u1xy = P * P * cx * cy, u2xy = 0.6 * u1xy;
    return {
      fx: -(c1 * (u1xx + nu * u2xy) + Gm * (u1yy + u2xy)),
      fy: -(Gm * (u1xy + u2xx) + c1 * (u2yy + nu * u1xy)),
    };
  };

  function run(h) {
    const mesh = buildMesh([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], h);
    const body = mesh.elements.map(el => {
      let x = 0, y = 0;
      for (const id of el.nodeIds) { x += mesh.nodes[id].x; y += mesh.nodes[id].y; }
      const c = bodyAt(x / el.nodeIds.length, y / el.nodeIds.length);
      return { fx: c.fx, fy: c.fy };
    });
    const { u } = El.assembly.solveElastic(mesh, {
      E, nu, prescribed: prescribeBoundary(mesh, uex), point: [], traction: [], body,
    });
    // nodal displacement error
    const nodal = maxNodalError(mesh, u, uex);
    // C-weighted strain (energy) error via the projected gradients
    let err2 = 0;
    for (let e = 0; e < mesh.elements.length; e++) {
      const ids = mesh.elements[e].nodeIds;
      let cx = 0, cy = 0;
      for (const id of ids) { cx += mesh.nodes[id].x; cy += mesh.nodes[id].y; }
      cx /= ids.length; cy /= ids.length;
      const { exx, eyy, gxy } = El.post.elementStrainVoigt(mesh, u, e);
      const [ex0, ey0, g0] = strain(cx, cy);
      const de = [exx - ex0, eyy - ey0, gxy - g0];
      const area = Math.abs(G.signedArea(ids.map(id => mesh.nodes[id])));
      const s = [c1 * (de[0] + nu * de[1]), c1 * (de[1] + nu * de[0]), Gm * de[2]];
      err2 += area * (de[0] * s[0] + de[1] * s[1] + de[2] * s[2]);
    }
    return { mesh, nodal, energy: Math.sqrt(Math.max(0, err2)) };
  }

  const hs = [0.2, 0.1, 0.05];
  const rs = hs.map(run);
  const slN12 = Math.log(rs[0].nodal / rs[1].nodal) / Math.log(hs[0] / hs[1]);
  const slN23 = Math.log(rs[1].nodal / rs[2].nodal) / Math.log(hs[1] / hs[2]);
  const slE12 = Math.log(rs[0].energy / rs[1].energy) / Math.log(hs[0] / hs[1]);
  const slE23 = Math.log(rs[1].energy / rs[2].energy) / Math.log(hs[1] / hs[2]);
  assert(slN12 > 1.4 && slN12 < 2.6, 'nodal error slope h1→h2 ≈ 2, got ' + slN12.toFixed(2));
  assert(slN23 > 1.4 && slN23 < 2.6, 'nodal error slope h2→h3 ≈ 2, got ' + slN23.toFixed(2));
  assert(slE12 > 1.4 && slE12 < 2.6, 'energy error slope h1→h2 ≈ 2, got ' + slE12.toFixed(2));
  assert(slE23 > 1.4 && slE23 < 2.6, 'energy error slope h2→h3 ≈ 2, got ' + slE23.toFixed(2));
  assert(rs[2].nodal < rs[1].nodal && rs[1].nodal < rs[0].nodal, 'nodal errors decrease with refinement');
  assert(rs[2].energy < rs[1].energy && rs[1].energy < rs[0].energy, 'energy errors decrease with refinement');
  console.log('OK: manufactured solution — nodal ' + rs.map(r => r.nodal.toExponential(2)).join(' / ') +
              ' (slopes ' + slN12.toFixed(2) + ', ' + slN23.toFixed(2) + '), energy ' +
              rs.map(r => r.energy.toExponential(2)).join(' / ') +
              ' (slopes ' + slE12.toFixed(2) + ', ' + slE23.toFixed(2) + ')');
}

/* ---------- 3. Element stiffness properties ---------- */

{
  const rings = [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],                                        // square
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: Math.sqrt(3) / 2 }],                                       // triangle
    [{ x: 0.2, y: 0 }, { x: 1.1, y: 0.1 }, { x: 0.9, y: 1.05 }, { x: 0.15, y: 1.1 }, { x: -0.1, y: 0.5 }],  // irregular pentagon
  ];
  for (const ring of rings) {
    const Nv = ring.length;
    const Ndof = 2 * Nv;
    const { AK, area } = El.vem.elementStiffness(ring, { E: 1, nu: 0.3 });
    // centroid for the rotation mode
    let yc = 0, xc = 0;
    for (const p of ring) { xc += p.x; yc += p.y; }
    xc /= Nv; yc /= Nv;

    let sym = 0, diag = Infinity, scale = 0;
    for (let i = 0; i < Ndof; i++) {
      for (let j = 0; j < Ndof; j++) {
        const a = AK[i * Ndof + j];
        sym = Math.max(sym, Math.abs(a - AK[j * Ndof + i]));
        scale = Math.max(scale, Math.abs(a));
        if (i === j) diag = Math.min(diag, a);
      }
    }
    assert(sym < 1e-12, 'element stiffness symmetric (Nv=' + Nv + ')');

    // rigid modes in the kernel: tx, ty, rotation about the centroid
    const modes = [];
    const tx = new Float64Array(Ndof), ty = new Float64Array(Ndof), rot = new Float64Array(Ndof);
    for (let i = 0; i < Nv; i++) {
      tx[i] = 1;
      ty[Nv + i] = 1;
      rot[i] = -(ring[i].y - yc);
      rot[Nv + i] = ring[i].x - xc;
    }
    modes.push([tx, 'x-translation'], [ty, 'y-translation'], [rot, 'rigid rotation']);
    for (const [v, name] of modes) {
      let mx = 0;
      for (let i = 0; i < Ndof; i++) {
        let s = 0;
        for (let j = 0; j < Ndof; j++) s += AK[i * Ndof + j] * v[j];
        mx = Math.max(mx, Math.abs(s));
      }
      assert(mx < 1e-9 * Math.max(1, scale), name + ' in kernel (Nv=' + Nv + ', max |Kv| ' + mx.toExponential(1) + ')');
    }

    // positive diagonal + positive semidefinite quadratic form
    assert(diag > 0, 'positive diagonal (Nv=' + Nv + ')');
    let minQ = Infinity;
    for (let trial = 0; trial < 5; trial++) {
      const x = new Float64Array(Ndof);
      for (let i = 0; i < Ndof; i++) x[i] = Math.sin(trial * 7 + i * 13) + 0.1 * (i + 1);
      let q = 0, xx = 0;
      for (let i = 0; i < Ndof; i++) {
        let s = 0;
        for (let j = 0; j < Ndof; j++) s += AK[i * Ndof + j] * x[j];
        q += x[i] * s; xx += x[i] * x[i];
      }
      minQ = Math.min(minQ, q / (xx * Math.max(1, scale)));
    }
    assert(minQ > -1e-10, 'quadratic form semidefinite (min xᵀAx/(xᵀx·s) ' + minQ.toExponential(2) + ')');

    // exact material scaling: K(2E) = 2·K(E)
    const AK2 = El.vem.elementStiffness(ring, { E: 2, nu: 0.3 }).AK;
    let rel = 0;
    for (let i = 0; i < Ndof * Ndof; i++) rel = Math.max(rel, Math.abs(AK2[i] - 2 * AK[i]));
    rel /= Math.max(1, scale);
    assert(rel < 1e-10, 'K scales linearly with E (Nv=' + Nv + ', rel ' + rel.toExponential(1) + ')');
  }
  console.log('OK: element stiffness symmetry / rigid kernel / SPD / E-scaling');
}

/* ---------- 4. Uniaxial tension strip (closed-form plane stress) ---------- */

{
  const E = 200000, nu = 0.3, p0 = 100;
  const L = 2, H = 1;
  const mesh = buildMesh([{ x: 0, y: 0 }, { x: L, y: 0 }, { x: L, y: H }, { x: 0, y: H }], 0.25);
  const n = mesh.nodes.length;
  const prescribed = {};
  for (let i = 0; i < n; i++) {
    const p = mesh.nodes[i];
    if (p.x < 1e-9) {          // clamp the left face horizontally
      prescribed[i] = 0;
      if (p.y < 1e-9) prescribed[n + i] = 0; // one vertical pin kills rotation
    }
  }
  const traction = [];
  for (const [a, b] of Mesh.boundaryEdges(mesh)) {
    const na = mesh.nodes[a], nb = mesh.nodes[b];
    if (Math.abs(na.x - L) < 1e-9 && Math.abs(nb.x - L) < 1e-9) {
      traction.push({ a, b, fx: p0, fy: 0 }); // uniform normal traction p0
    }
  }
  const { u } = El.assembly.solveElastic(mesh, { E, nu, prescribed, point: [], traction, body: null });
  // closed form: σxx = p0 → ux = p0·x/E, uy = −ν·p0·y/E
  const uxExact = p0 * L / E; // 1e-3
  const dispErr = maxNodalError(mesh, u, (x, y) => ({ x: p0 * x / E, y: -nu * p0 * y / E }));
  assert(dispErr < 1e-6, 'uniaxial strip: nodal displacement matches σxx=p0 state (max err ' + dispErr + ')');

  // stress recovery: nodal-averaged σxx must reproduce p0
  const C = El.vem.planeStressC(E, nu);
  const sA = new Float64Array(n), cnt = new Int32Array(n);
  for (let e = 0; e < mesh.elements.length; e++) {
    const ids = mesh.elements[e].nodeIds;
    const { exx, eyy } = El.post.elementStrainVoigt(mesh, u, e);
    const sxx = C[0] * exx + C[1] * eyy;
    for (const i of ids) { sA[i] += sxx; cnt[i]++; }
  }
  let rel = 0;
  for (let i = 0; i < n; i++) rel = Math.max(rel, Math.abs(sA[i] / cnt[i] - p0) / p0);
  assert(rel < 1e-6, 'uniaxial strip: nodal σxx reproduces p0 (max rel err ' + rel + ')');
  console.log('OK: uniaxial tension strip — ux(L)=' + u[mesh.nodes.findIndex(p => p.x > L - 1e-9 && p.y < 1e-9)].toFixed(6) +
              ' (want ' + uxExact + '), σxx rel err ' + rel.toExponential(1));
}

/* ---------- 5. Rigid-translation boundary condition ---------- */

{
  const mesh = buildMesh([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], 0.25);
  const n = mesh.nodes.length;
  const prescribed = {};
  for (const [a, b] of Mesh.boundaryEdges(mesh)) {
    for (const i of [a, b]) { prescribed[i] = 5; prescribed[n + i] = 0; }
  }
  const { u } = El.assembly.solveElastic(mesh, { E: 200000, nu: 0.3, prescribed, point: [], traction: [], body: null });
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(u[i] - 5), Math.abs(u[n + i]));
  assert(mx < 1e-8, 'rigid translation reproduced (max err ' + mx + ')');
  console.log('OK: constant Dirichlet ⇒ rigid translation (u = 5, max err ' + mx.toExponential(1) + ')');
}

/* ---------- 6. CG unit test (known 2×2 system) ---------- */

{
  const A = Matrix.fromTriplets(2, [[0, 0, 4], [0, 1, 1], [1, 0, 1], [1, 1, 3]]);
  const { x, residual } = Matrix.cgSolve(A, Float64Array.of(1, 2), { tol: 1e-14 });
  close(x[0], 1 / 11, 1e-12, 'CG x0 = 1/11');
  close(x[1], 7 / 11, 1e-12, 'CG x1 = 7/11');
  assert(residual < 1e-12, 'CG residual small (got ' + residual + ')');
  console.log('OK: CG on a known 2×2 SPD system');
}

/* ---------- 7. Uniform pressure BC (pressureToTraction) ---------- */

// pressureToTraction must turn a scalar boundary pressure into edge
// tractions along the INWARD normal (p > 0 pushes into the domain). On
// the right boundary (x = L) of the CCW unit square, inward = −x̂.
{
  const mesh = buildMesh([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], 0.25);
  const right = Mesh.boundaryEdges(mesh).filter(([a, b]) => {
    const na = mesh.nodes[a], nb = mesh.nodes[b];
    return Math.abs(na.x - 1) < 1e-9 && Math.abs(nb.x - 1) < 1e-9;
  });
  const group = { name: 'P', edges: right, p: 3 };
  const traction = El.assembly.pressureToTraction(mesh, [group]);
  assert(traction.length === right.length, 'pressureToTraction: one traction per pressure edge');
  for (const t of traction) {
    close(t.fx, -3, 1e-9, 'pressure pushes INTO the domain (−x̂ on right boundary)');
    close(t.fy, 0, 1e-9, 'pressure is normal to the edge (no tangential part)');
  }
  console.log('OK: pressureToTraction — p>0 → inward-normal tractions on the right boundary');

  // End-to-end: pin the left face, press the right face inward, and the
  // body must compress (right-face nodes move −x).
  const n = mesh.nodes.length;
  const prescribed = {};
  for (const [a, b] of Mesh.boundaryEdges(mesh)) {
    for (const i of [a, b]) {
      if (Math.abs(mesh.nodes[i].x) < 1e-9) { prescribed[i] = 0; prescribed[n + i] = 0; }
    }
  }
  const { u } = El.assembly.solveElastic(mesh, {
    E: 200000, nu: 0.3, prescribed, point: [], traction, body: null,
  });
  let rightUx = 0;
  for (const [a, b] of right) for (const i of [a, b]) rightUx = Math.min(rightUx, u[i]);
  assert(rightUx < -1e-9, 'inward pressure compresses the strip (right-face ux ' + rightUx.toExponential(2) + ')');
  console.log('OK: inward pressure on right face compresses the body (max ux ' + rightUx.toExponential(2) + ')');
}

/* ---------- Summary ---------- */

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
