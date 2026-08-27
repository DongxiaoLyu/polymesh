/* ============================================================
   smoke-test.js — Behavior cross-check for the refactor
   ============================================================
   Runs the SAME battery of tests against:
     - the NEW modular implementation (js/*.js), and
     - the ORIGINAL implementation extracted into legacy-core.js
   and asserts both produce identical results (deep JSON compare).
   Any mismatch means the refactor changed behavior.

   Run:  node smoke-test.js
   ============================================================ */

'use strict';

global.window = global;

/* ---------- Load new modules ---------- */
require('./js/constants.js');
require('./js/geometry.js');
require('./js/grid.js');
require('./js/clipping.js');
require('./js/mesh.js');
require('./js/export.js');
require('./js/demo.js');
require('./js/image.js');
require('./legacy-core.js');

const MS = global.MeshStudio;
const NEW = {
  Constants: MS.Constants,
  G: MS.Geometry,
  Grid: MS.Grid,
  Clipping: MS.Clipping,
  Mesh: MS.Mesh,
  Export: MS.Export,
  Demo: MS.Demo,
  Image: MS.Image,
};
const LEGACY = global.Legacy;

/* ---------- Tiny assertion helpers ---------- */
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.log('    FAIL: ' + msg); }
}
function eq(a, b, msg) { assert(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function close(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, msg + ' (got ' + a + ', want ' + b + ')'); }

/* ============================================================
   Test battery — run against an API object that provides
   { Constants, G, Grid, Mesh }. `demoPoly` is the SAME input for
   both implementations. Returns the meshes for cross-comparison.
   ============================================================ */
function runBattery(api, label, demoPoly) {
  console.log('--- battery: ' + label + ' ---');
  const C = api.Constants, G = api.G, Grid = api.Grid, Mesh = api.Mesh;
  const out = {};

  // segmentIntersection
  {
    const [p] = G.segmentIntersection({x:0,y:0},{x:10,y:10},{x:0,y:10},{x:10,y:0}, C.EPS);
    close(p.x, 5, 1e-9, 'crossing x'); close(p.y, 5, 1e-9, 'crossing y');
    // truly parallel & disjoint: (0,0)-(10,0) vs (0,5)-(10,5)
    eq(G.segmentIntersection({x:0,y:0},{x:10,y:0},{x:0,y:5},{x:10,y:5}, C.EPS).length, 0, 'parallel disjoint -> 0');
    eq(G.segmentIntersection({x:0,y:0},{x:10,y:0},{x:5,y:0},{x:15,y:0}, C.EPS).length, 2, 'collinear overlap -> 2');
    eq(G.segmentIntersection({x:0,y:0},{x:10,y:0},{x:10,y:0},{x:10,y:10}, C.EPS).length, 1, 'endpoint touch -> 1');
  }

  // pointInPolygon
  {
    const sq = [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
    assert(G.pointInPolygon({x:5,y:5}, sq, 1e-9), 'point inside');
    assert(!G.pointInPolygon({x:15,y:5}, sq, 1e-9), 'point outside');
    assert(G.pointInPolygon({x:10,y:5}, sq, 1e-9), 'boundary counts inside');
    assert(G.pointInPolygon({x:5,y:5}, sq, 1e-9, G.bbox(sq)), 'with bbox opt');
  }

  // simplifyPolygon / isSimplePolygon
  {
    const p = G.simplifyPolygon([{x:0,y:0},{x:5,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]);
    eq(p.length, 4, 'collinear vertex removed');
    assert(!G.isSimplePolygon([{x:0,y:0},{x:10,y:10},{x:10,y:0},{x:0,y:10}]), 'bowtie not simple');
    assert(G.isSimplePolygon([{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]), 'square simple');
  }

  // resamplePolygon
  {
    const sq = [{x:0,y:0},{x:80,y:0},{x:80,y:80},{x:0,y:80}];
    const s = G.resamplePolygon(sq, 20);
    eq(s.length, 16, 'resample count');
    let maxGap = 0;
    for (let i = 0; i < s.length; i++) maxGap = Math.max(maxGap, G.V.dist(s[i], s[(i + 1) % s.length]));
    assert(maxGap <= 20 + 1e-9, 'spacing <= S (max ' + maxGap + ')');
    eq(s[0].x, 0, 'first sample = first vertex x');
    eq(s[0].y, 0, 'first sample = first vertex y');
  }

  // grid generation invariants
  {
    const rect = {minX:0,minY:0,maxX:160,maxY:160};
    const sq = Grid.generateCells('square', rect, 40);
    eq(sq.length, 16, 'square cells count');
    const tr = Grid.generateCells('triangle', rect, 40);
    let ok = tr.length > 0;
    for (const t of tr) {
      const d01 = G.V.dist(t[0], t[1]), d12 = G.V.dist(t[1], t[2]), d20 = G.V.dist(t[2], t[0]);
      if (Math.abs(d01 - 40) > 1e-9 || Math.abs(d12 - 40) > 1e-9 || Math.abs(d20 - 40) > 1e-9) ok = false;
      if (G.signedArea(t) <= 0) ok = false;
    }
    assert(ok, 'triangles equilateral & CCW (' + tr.length + ' cells)');
    const hx = Grid.generateCells('hexagon', rect, 40);
    ok = hx.length > 0;
    for (const h of hx) {
      if (h.length !== 6) ok = false;
      for (let i = 0; i < 6; i++) if (Math.abs(G.V.dist(h[i], h[(i + 1) % 6]) - 40) > 1e-9) ok = false;
      if (G.signedArea(h) <= 0) ok = false;
    }
    assert(ok, 'hexagons regular & CCW (' + hx.length + ' cells)');
  }

  // mesh: grid-aligned square
  {
    const cells = Grid.generateCells('square', {minX:0,minY:0,maxX:80,maxY:80}, 40);
    const poly = [{x:0,y:0},{x:80,y:0},{x:80,y:80},{x:0,y:80}];
    const samples = G.resamplePolygon(poly, 20);
    const mesh = Mesh.buildMesh(cells, poly, samples, 40 * C.EPS_SCALE);
    out.alignedMesh = mesh;
    eq(mesh.elements.length, 4, 'aligned: 4 elements');
    eq(mesh.interiorCount, 4, 'aligned: 4 interior');
    eq(mesh.boundaryCount, 0, 'aligned: 0 boundary');
    eq(mesh.nodes.length, 9, 'aligned: 9 nodes');
    const count = t => mesh.nodes.filter(n => n.type === t).length;
    eq(count('sampling'), 8, 'aligned: 8 sampling');
    eq(count('grid'), 1, 'aligned: 1 grid');
    eq(count('intersection'), 0, 'aligned: 0 intersection');
    for (const el of mesh.elements) {
      const ring = el.nodeIds.map(id => mesh.nodes[id]);
      assert(G.signedArea(ring) > 0, 'aligned element CCW');
      assert(el.nodeIds.length >= 3, 'aligned element >= 3 nodes');
    }
  }

  // mesh: non-aligned square (4 cut cells).
  // NOTE: the mesh boundary lands ON the resampled polygon, so the cut
  // elements carry extra sample vertices along their edges — hence 17
  // nodes (12 sampling + 4 intersection + 1 grid), not the naive 9.
  {
    const cells = Grid.generateCells('square', {minX:0,minY:0,maxX:80,maxY:80}, 40);
    const poly = [{x:10,y:10},{x:70,y:10},{x:70,y:70},{x:10,y:70}];
    const samples = G.resamplePolygon(poly, 20);
    const mesh = Mesh.buildMesh(cells, poly, samples, 40 * C.EPS_SCALE);
    out.cutMesh = mesh;
    eq(mesh.elements.length, 4, 'cut: 4 elements');
    eq(mesh.interiorCount, 0, 'cut: 0 interior');
    eq(mesh.boundaryCount, 4, 'cut: 4 boundary');
    eq(mesh.nodes.length, 17, 'cut: 17 nodes');
    const count = t => mesh.nodes.filter(n => n.type === t).length;
    eq(count('sampling'), 12, 'cut: 12 sampling');
    eq(count('grid'), 1, 'cut: 1 grid');
    eq(count('intersection'), 4, 'cut: 4 intersection');
    for (const el of mesh.elements) {
      const ring = el.nodeIds.map(id => mesh.nodes[id]);
      for (const n of ring) assert(G.pointInPolygon(n, poly, 1e-6), 'cut: node inside polygon');
      assert(Math.abs(G.signedArea(ring)) > C.AREA_EPS, 'cut: element area ok');
    }
  }

  // demo ring end-to-end (same demoPoly input for both implementations)
  {
    const poly = demoPoly;
    assert(poly && poly.length >= 3, 'demo: polygon available');
    const cells = Grid.generateCells('square', {minX:-80,minY:-80,maxX:880,maxY:680}, 40);
    const samples = G.resamplePolygon(poly, 20);
    const mesh = Mesh.buildMesh(cells, poly, samples, 40 * C.EPS_SCALE);
    out.demoMesh = mesh;
    assert(mesh.nodes.length > 40, 'demo: nodes (' + mesh.nodes.length + ')');
    assert(mesh.elements.length > 20, 'demo: elements (' + mesh.elements.length + ')');
  }

  return out;
}

/* ============================================================
   Build ONE demo polygon (from the new Demo module) and feed the
   identical input to both implementations.
   ============================================================ */
const demoPoly = G0 => G0.simplifyPolygon(MS.Demo.buildPolygon(800, 600));
const demoPts = demoPoly(MS.Geometry);
{
  eq(demoPts.length, 51, 'demo: 51 points');
  assert(MS.Geometry.isSimplePolygon(demoPts), 'demo: simple');
  const bb = MS.Geometry.bbox(demoPts);
  assert(bb.minX >= 0 && bb.maxX <= 800 && bb.minY >= 0 && bb.maxY <= 600, 'demo: inside canvas');
}

/* ============================================================
   Run both implementations on identical inputs
   ============================================================ */
const newRes = runBattery(NEW, 'NEW (js/*.js)', demoPts);
const legacyRes = runBattery(LEGACY, 'LEGACY (original)', demoPts);

/* ============================================================
   Cross-check: meshes must be IDENTICAL between implementations
   ============================================================ */
console.log('--- cross-check: identical output ---');
{
  const same = (name, a, b) => {
    const ja = JSON.stringify(a), jb = JSON.stringify(b);
    if (ja === jb) { passed++; console.log('  OK: ' + name + ' identical'); }
    else { failed++; console.log('  FAIL: ' + name + ' differs between NEW and LEGACY'); }
  };
  same('aligned mesh', newRes.alignedMesh, legacyRes.alignedMesh);
  same('cut mesh', newRes.cutMesh, legacyRes.cutMesh);
  same('demo mesh', newRes.demoMesh, legacyRes.demoMesh);
}

/* ============================================================
   New-only checks (snapping, export, renderer stub)
   ============================================================ */
console.log('--- new-only checks ---');
{
  // snapping
  const p = NEW.Grid.snapPoint({x:37,y:12}, 'square', 40, true);
  eq(p.x, 40, 'square snap x'); eq(p.y, 0, 'square snap y');
  const off = NEW.Grid.snapPoint({x:37,y:12}, 'square', 40, false);
  eq(off.x, 37, 'snap off x'); eq(off.y, 12, 'snap off y');
  const h = 40 * Math.sqrt(3) / 2;
  const tp = NEW.Grid.snapPoint({x:50,y:20}, 'triangle', 40, true);
  const j = Math.round(tp.y / h);
  const offv = (((j % 2) + 2) % 2) * 20;
  const i = Math.round((tp.x - offv) / 40);
  close(tp.x, i * 40 + offv, 1e-9, 'triangle snap on lattice x');
  close(tp.y, j * h, 1e-9, 'triangle snap on lattice y');

  // export: Y-flip (height) + uniform 100x100 fit
  const mesh = newRes.demoMesh;
  const txt = NEW.Export.buildTxt(mesh, { height: 600, fit: 100 });
  const lines = txt.split('\n');
  assert(lines[0].startsWith('# NODES (ID X Y)'), 'export header');
  const blankIdx = lines.indexOf('');
  eq(blankIdx, mesh.nodes.length + 1, 'export nodes section length');
  eq(lines[blankIdx + 1], '# ELEMENTS (ID NODE_1 NODE_2 ... NODE_N)', 'export elements header');
  eq(lines.length - (blankIdx + 2), mesh.elements.length, 'export elements section length');
  for (let k = blankIdx + 2; k < lines.length; k++) {
    const ids = lines[k].split(' ').slice(1).map(Number);
    for (const id of ids) assert(id >= 1 && id <= mesh.nodes.length, 'export node id in range');
  }
  {
    // every exported node must sit inside [0,100]^2, and the mesh must span
    // the full 100 box along at least one axis (uniform fit, aspect kept)
    const nodeLines = lines.slice(1, blankIdx);
    eq(nodeLines.length, mesh.nodes.length, 'export node lines count');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodeLines.forEach((ln, i) => {
      const parts = ln.split(' ');
      eq(Number(parts[0]), i + 1, 'export node id sequential');
      const x = Number(parts[1]), y = Number(parts[2]);
      assert(x >= 0 && x <= 100 && y >= 0 && y <= 100, 'export: node inside 100x100 box');
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    });
    assert(maxX - minX >= 99.99 || maxY - minY >= 99.99, 'export: mesh spans the full 100 box');
  }
  // unit checks for the flip & fit transforms
  {
    const fake = { nodes: [{x:10,y:20},{x:30,y:40}], elements: [] };
    assert(NEW.Export.buildTxt(fake, { height: 100 }).includes('1 10 80'), 'flip: y = height - y');
    assert(NEW.Export.buildTxt(fake, { height: 100 }).includes('2 30 60'), 'flip: second node');
    assert(NEW.Export.buildTxt(fake).includes('1 10 20'), 'no flip without height');
    const fitted = NEW.Export.buildTxt(fake, { height: 100, fit: 100 }).split('\n');
    assert(fitted[1] === '1 0 100' && fitted[2] === '2 100 0', 'fit: flipped corners land on the box edges');
  }
  eq(NEW.Export.fmt(40), '40', 'fmt int');
  eq(NEW.Export.fmt(40.5), '40.5', 'fmt decimal');
  eq(NEW.Export.fmt(-0), '0', 'fmt -0');

  // export: boundary-condition sections (group-block format)
  {
    const fakeMesh = { nodes: [{x:10,y:20},{x:30,y:40},{x:50,y:60},{x:70,y:80},{x:90,y:100}], elements: [] };
    const conds = {
      pointLoads: [{ name: 'Point_load_1', nodeIds: [0, 2], fx: 100, fy: 0 }],
      distLoads:  [{ name: 'Distributed_load_1', edges: [[0, 1], [2, 3]], fx: -50, fy: 86.6025 }],
      supports:   [{ name: 'Support_1', type: 'fixed', nodeIds: [4] }],
    };
    const lines = NEW.Export.buildTxt(fakeMesh, { height: 100, fit: 100 }, conds).split('\n');
    const pl = lines.indexOf('# POINT LOADS (NAME COUNT | NODE LINES | FX FY)');
    const dl = lines.indexOf('# DISTRIBUTED LOADS (NAME COUNT | EDGE LINES N1 N2 | FX FY)');
    const sp = lines.indexOf('# SUPPORTS (NAME TYPE COUNT | NODE LINES)');
    assert(pl > 0 && dl > pl && sp > dl, 'export: condition sections in order');
    eq(lines[pl + 1], 'Point_load_1 2', 'export: point load header');
    eq(lines[pl + 2], '1', 'export: point load member 1 (1-based)');
    eq(lines[pl + 3], '3', 'export: point load member 2');
    eq(lines[pl + 4], '100 0', 'export: point load vector');
    eq(lines[dl + 1], 'Distributed_load_1 2', 'export: dist load header');
    eq(lines[dl + 2], '1 2', 'export: dist edge 1');
    eq(lines[dl + 3], '3 4', 'export: dist edge 2');
    eq(lines[dl + 4], '-50 86.6025', 'export: dist vector');
    eq(lines[sp + 1], 'Support_1 fixed 1', 'export: support header');
    eq(lines[sp + 2], '5', 'export: support member');
    // no conditions -> no condition sections
    const plain = NEW.Export.buildTxt(fakeMesh, { height: 100 });
    assert(!plain.includes('# POINT LOADS'), 'export: no condition sections when empty');
  }

  // export: every element must be COUNTER-CLOCKWISE in the exported Y-UP
  // coordinates (the Y flip mirrors screen-space CCW into CW, and the
  // exporter reverses the node order to restore CCW).
  {
    const txt2 = NEW.Export.buildTxt(newRes.demoMesh, { height: 600, fit: 100 });
    const ls = txt2.split('\n');
    const nEnd = ls.indexOf('', ls.indexOf('# NODES (ID X Y)') + 1);
    const eStart = ls.indexOf('# ELEMENTS (ID NODE_1 NODE_2 ... NODE_N)');
    let eEnd = ls.indexOf('', eStart + 1);
    if (eEnd < 0) eEnd = ls.length;
    const pts = {};
    for (let i = 1; i < nEnd; i++) { const p = ls[i].split(' '); pts[+p[0]] = { x: +p[1], y: +p[2] }; }
    let ccw = 0, total = 0;
    for (let i = eStart + 1; i < eEnd; i++) {
      const ids = ls[i].split(' ').slice(1).map(Number);
      total++;
      let s = 0;
      for (let k = 0; k < ids.length; k++) {
        const a = pts[ids[k]], b = pts[ids[(k + 1) % ids.length]];
        s += a.x * b.y - b.x * a.y;
      }
      if (s > 1e-9) ccw++;
    }
    eq(ccw, total, 'export: all elements CCW in Y-UP coords (' + ccw + '/' + total + ')');
  }

  // mesh: boundary edges + selection helpers
  {
    const cells = NEW.Grid.generateCells('square', {minX:0,minY:0,maxX:80,maxY:80}, 40);
    const poly = [{x:0,y:0},{x:80,y:0},{x:80,y:80},{x:0,y:80}];
    const samples = NEW.G.resamplePolygon(poly, 20);
    const m = NEW.Mesh.buildMesh(cells, poly, samples, 40 * NEW.Constants.EPS_SCALE);
    const edges = NEW.Mesh.boundaryEdges(m);
    eq(edges.length, 8, 'aligned mesh: 8 boundary edges');
    // every boundary edge must be used by exactly one element
    const cnt = new Map();
    for (const el of m.elements) {
      const ids = el.nodeIds;
      for (let i = 0; i < ids.length; i++) {
        let a = ids[i], b = ids[(i + 1) % ids.length];
        if (a > b) { const t = a; a = b; b = t; }
        const k = a + '_' + b;
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
    }
    let allCount1 = true;
    for (const [a, b] of edges) if (cnt.get(a + '_' + b) !== 1) allCount1 = false;
    assert(allCount1, 'all boundary edges have count 1');
    eq(NEW.Mesh.nearestNode(m, {x:2,y:2}, 12), 0, 'nearest node within radius');
    eq(NEW.Mesh.nearestNode(m, {x:500,y:500}, 12), -1, 'no node within radius');
    eq(NEW.Mesh.nearestEdge(edges, m, {x:20,y:1}, 12) >= 0, true, 'nearest edge within radius');
    const ids = NEW.Mesh.nodesInBox(m, {minX:0,minY:0,maxX:40,maxY:40});
    eq(ids.length, 4, 'box selects the 4 corner-cell nodes');
    // allEdges: 8 boundary + 4 interior shared edges = 12 unique edges
    const all = NEW.Mesh.allEdges(m);
    eq(all.length, 12, 'aligned mesh: 12 unique edges (8 boundary + 4 interior)');
    eq(NEW.Mesh.boundaryEdges(m).length, 8, 'boundary edges still 8');
  }

  // renderer smoke: cached rendering must not throw
  const Path2DStub = class {
    constructor() { this.ops = []; }
    moveTo(x, y) { this.ops.push(['M', x, y]); }
    lineTo(x, y) { this.ops.push(['L', x, y]); }
    arc(x, y, r, a0, a1) { this.ops.push(['A', x, y, r, a0, a1]); }
    closePath() { this.ops.push(['Z']); }
  };
  global.Path2D = Path2DStub;
  require('./js/renderer.js');
  const fakeCtx = new Proxy({}, {
    get(t, prop) { if (!(prop in t)) t[prop] = () => {}; return t[prop]; },
    set(t, prop, v) { t[prop] = v; return true; },
  });
  const renderer = MS.Renderer.createRenderer(fakeCtx);
  const fakeState = {
    w: 800, h: 600, drawMode: 'point',
    cells: NEW.Grid.generateCells('square', {minX:-80,minY:-80,maxX:880,maxY:680}, 40),
    mesh, samples: [], polygon: null, drawing: [], cursor: {x: 10, y: 10},
    pointLoads: [], distLoads: [], supports: [], bcSel: null,
  };
  renderer.render(fakeState);
  renderer.render(fakeState); // second pass exercises the path cache
  // exercise the boundary-condition markers + selection preview paths
  fakeState.pointLoads = [{ name: 'P', nodeIds: [0], fx: 10, fy: 0 }];
  fakeState.distLoads = [{ name: 'D', edges: [[0, 1], [1, 2]], fx: -5, fy: 3 }];
  fakeState.supports = [{ name: 'S', type: 'fixed', nodeIds: [1] }];
  fakeState.bcSel = {
    nodes: new Set([0]),
    edges: new Map([['1_2', [1, 2]]]),
    box: {minX: 0, minY: 0, maxX: 100, maxY: 100},
  };
  renderer.render(fakeState);
  console.log('  OK: renderer.render() ran 3x without throwing (path cache + BC markers)');
}

/* ============================================================
   Image pipeline tests (synthetic images, no browser needed)
   ============================================================ */
console.log('--- image pipeline ---');
{
  const Img = NEW.Image;
  const G = NEW.G;

  // Build an RGBA image: white background + paint callback (dark pixels).
  function makeImage(w, h, paint) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 255; data[i * 4 + 1] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
    }
    if (paint) paint((x, y) => {
      const i = (y * w + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    });
    return { data, width: w, height: h };
  }

  // grayscale & Otsu basics
  {
    const black = makeImage(4, 4, s => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) s(x, y); });
    eq(Img.toGray(black)[0], 0, 'toGray black = 0');
    eq(Img.toGray(makeImage(4, 4))[0], 255, 'toGray white = 255');
    const bimodal = new Uint8ClampedArray(400);
    for (let i = 0; i < 200; i++) bimodal[i] = 20;
    for (let i = 200; i < 400; i++) bimodal[i] = 220;
    const t = Img.otsuThreshold(bimodal);
    // the threshold must separate the two modes (not equal 20 or 220)
    assert(t > 20 && t <= 220, 'otsu separates modes (' + t + ')');
    const m = Img.binarizeDark(bimodal, t);
    eq(m[0], 1, 'otsu: dark mode classified as foreground');
    eq(m[399], 0, 'otsu: light mode classified as background');
  }

  // marching squares on a solid 3x3 block → one closed 12-edge loop
  {
    const contours = Img.marchingSquares(new Uint8Array(9).fill(1), 3, 3);
    eq(contours.length, 1, 'solid block: one contour');
    const c = contours[0];
    eq(c[0].x, c[c.length - 1].x, 'solid block: closed x');
    eq(c[0].y, c[c.length - 1].y, 'solid block: closed y');
    close(Math.abs(G.signedArea(c)), 9, 1e-9, 'solid block: area = 9 px');
  }

  // filled rectangle → auto-detected 'filled', fitted into the canvas
  {
    const img = makeImage(200, 200, s => {
      for (let y = 50; y < 150; y++) for (let x = 50; x < 150; x++) s(x, y);
    });
    const res = Img.extractPolygon(img, { targetW: 800, targetH: 600 });
    assert(res, 'filled rect: shape found');
    eq(res.kind, 'filled', 'filled rect: kind = filled');
    assert(G.isSimplePolygon(res.polygon), 'filled rect: polygon simple');
    const bb = G.bbox(res.polygon);
    assert(bb.minX >= 0 && bb.maxX <= 800 && bb.minY >= 0 && bb.maxY <= 600, 'filled rect: inside canvas');
    // 100 px square in a 200 px image → span 100 → scale 4.8 → ~480 px.
    // The Gaussian blur chamfers sharp corners by 1-2 px, so allow a band.
    close(bb.maxX - bb.minX, 480, 12, 'filled rect: fitted width ~480 (' + (bb.maxX - bb.minX) + ')');
    close(Math.abs(G.signedArea(res.polygon)), 480 * 480, 20000, 'filled rect: fitted area ~480^2');
  }

  // stroke ring → auto-detected 'stroke', follows the inner edge
  {
    const img = makeImage(200, 200, s => {
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        const d = Math.hypot(x - 100, y - 100);
        if (d >= 60 && d <= 70) s(x, y);
      }
    });
    const res = Img.extractPolygon(img, { targetW: 800, targetH: 600 });
    assert(res, 'ring: shape found');
    eq(res.kind, 'stroke', 'ring: kind = stroke');
    assert(G.isSimplePolygon(res.polygon), 'ring: polygon simple');
    const bb = G.bbox(res.polygon);
    assert(bb.minX >= 0 && bb.maxX <= 800 && bb.minY >= 0 && bb.maxY <= 600, 'ring: inside canvas');
    // inner edge radius ~60 → diameter 120 → scale 4 → ~480 px fitted
    close(bb.maxX - bb.minX, 480, 6, 'ring: fitted width ~480');
  }

  // tiny noise blob → rejected
  {
    const img = makeImage(200, 200, s => {
      for (let y = 98; y < 103; y++) for (let x = 98; x < 103; x++) s(x, y);
    });
    eq(Img.extractPolygon(img, { targetW: 800, targetH: 600 }), null, 'noise blob: rejected (null)');
  }

  // fillRatio discriminates filled vs stroke
  {
    const filled = makeImage(200, 200, s => {
      for (let y = 50; y < 150; y++) for (let x = 50; x < 150; x++) s(x, y);
    });
    let gray = Img.gaussianBlur(Img.toGray(filled), 200, 200, 1.5);
    let mask = Img.binarizeDark(gray, Img.otsuThreshold(gray));
    let outer = Img.largestContour(Img.marchingSquares(mask, 200, 200));
    const ratioFilled = Img.fillRatio(mask, 200, 200, outer);
    assert(ratioFilled > 0.9, 'fillRatio filled ~1 (' + ratioFilled + ')');

    const stroke = makeImage(200, 200, s => {
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        if (x === 30 || x === 169 || y === 30 || y === 169) s(x, y);
      }
    });
    gray = Img.gaussianBlur(Img.toGray(stroke), 200, 200, 1.5);
    mask = Img.binarizeDark(gray, Img.otsuThreshold(gray));
    outer = Img.largestContour(Img.marchingSquares(mask, 200, 200));
    const ratioStroke = Img.fillRatio(mask, 200, 200, outer);
    assert(ratioStroke < 0.5, 'fillRatio stroke < 0.5 (' + ratioStroke + ')');
  }

  // interiorMask: a border ring encloses an interior region
  {
    const img = makeImage(200, 200, s => {
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        if (x === 30 || x === 169 || y === 30 || y === 169) s(x, y);
      }
    });
    const gray = Img.gaussianBlur(Img.toGray(img), 200, 200, 1.5);
    const mask = Img.binarizeDark(gray, Img.otsuThreshold(gray));
    const interior = Img.interiorMask(mask, 200, 200);
    let count = 0;
    for (let i = 0; i < interior.length; i++) count += interior[i];
    // enclosed region ≈ 138 x 138 px (may shift ± a few px after blur)
    close(count, 138 * 138, 1500, 'interior region size ~138^2 (' + count + ')');
  }

  // demo fit regression: fitToCanvas must reproduce the ORIGINAL inline
  // demo scaling math exactly (span → scale → center → flip Y)
  {
    const raw = NEW.Demo.RING;
    const w = 800, h = 600;
    const bb = G.bbox(raw);
    const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
    const scale = Math.min(w, h) * 0.8 / span;
    const midX = (bb.minX + bb.maxX) / 2, midY = (bb.minY + bb.maxY) / 2;
    const expected = raw.map(p => ({
      x: w / 2 + (p.x - midX) * scale,
      y: h / 2 - (p.y - midY) * scale,
    }));
    eq(JSON.stringify(NEW.Demo.buildPolygon(w, h)), JSON.stringify(expected), 'demo fit identical to original math');
  }
}

/* ---------- Summary ---------- */
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
