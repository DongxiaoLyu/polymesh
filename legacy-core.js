/* AUTO-GENERATED from the ORIGINAL index.html (constants + sections 3-8)
   for cross-checking the refactor. Do not edit. Used only by smoke-test.js. */
global.Legacy = {};
(function (global) {
  'use strict';
  /* ============================================================
     0. Constants
     ============================================================ */
  const EPS      = 1e-7;   // tight dimensionless tolerance for segment-intersection predicates
  const EPS_SCALE = 1e-4;  // spatial tolerance factor: spatialEps = cellSize * EPS_SCALE
  const AREA_EPS = 1e-6;   // drop degenerate slivers smaller than this area (px^2)
  const SNAP     = 1e6;    // node-identity snap: 1e-6 px
  const SQRT3    = Math.sqrt(3);
  const FREEHAND_MIN_DIST = 2;  // px — minimum spacing between captured freehand samples
  const FREEHAND_EPSILON  = 3;  // px — RDP simplification tolerance for freehand paths
  /* ============================================================
     3. Vector / point helpers
     ============================================================ */
  const V = {
    add:  (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub:  (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale:(a, s) => ({ x: a.x * s,   y: a.y * s   }),
    dot:  (a, b) => a.x * b.x + a.y * b.y,
    cross:(a, b) => a.x * b.y - a.y * b.x,   // 2D cross product (z component)
    len:  (a)    => Math.hypot(a.x, a.y),
    dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  };

  /* ============================================================
     4. Core geometric predicates
     ============================================================ */

  /** Signed area (shoelace). Positive = counter-clockwise. */
  function signedArea(poly) {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }

  /** Return a CCW copy of a polygon. */
  function makeCCW(poly) {
    return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
  }

  /** Distance from point p to segment a-b. */
  function distToSegment(p, a, b) {
    const ab = V.sub(b, a), ap = V.sub(p, a);
    const l2 = V.dot(ab, ab);
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, V.dot(ap, ab) / l2));
    return V.dist(p, V.add(a, V.scale(ab, t)));
  }

  /**
   * Point-in-polygon (even-odd ray casting) with boundary tolerance.
   * Points within `eps` of the boundary are treated as inside so that
   * collinear (overlapping) edge pieces are retained during clipping.
   */
  function pointInPolygon(pt, poly, eps, bboxOpt) {
    if (bboxOpt && (pt.x < bboxOpt.minX || pt.x > bboxOpt.maxX ||
                    pt.y < bboxOpt.minY || pt.y > bboxOpt.maxY)) return false;
    for (let i = 0; i < poly.length; i++) {
      if (distToSegment(pt, poly[i], poly[(i + 1) % poly.length]) <= eps) return true;
    }
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      if ((a.y > pt.y) !== (b.y > pt.y)) {
        const x = a.x + (pt.y - a.y) / (b.y - a.y) * (b.x - a.x);
        if (x > pt.x) inside = !inside;
      }
    }
    return inside;
  }

  /** Axis-aligned bounding box of a point ring. */
  function bbox(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function bboxOfSegment(a, b) {
    return {
      minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
    };
  }

  function bboxIntersect(a, b) {
    return a.minX <= b.maxX + EPS && a.maxX >= b.minX - EPS &&
           a.minY <= b.maxY + EPS && a.maxY >= b.minY - EPS;
  }

  /** Parameter (0..1) of point p along segment a-b. */
  function paramOnSegment(p, a, b) {
    const ab = V.sub(b, a);
    const l2 = V.dot(ab, ab);
    return l2 === 0 ? 0 : V.dot(V.sub(p, a), ab) / l2;
  }

  /**
   * Robust segment-segment intersection.
   * Returns an array of 0, 1, or 2 points:
   *   - none                      -> []
   *   - transversal/touch point   -> [point]
   *   - collinear overlap segment -> [start, end]
   * The parallel test is scale-invariant so it works for both tiny
   * and large coordinates without separate epsilon tuning.
   */
  function segmentIntersection(a, b, c, d, eps) {
    const d1 = V.sub(b, a), d2 = V.sub(d, c), r = V.sub(c, a);
    const len1 = V.len(d1), len2 = V.len(d2);
    if (len1 === 0 || len2 === 0) return [];
    const denom = V.cross(d1, d2);

    if (Math.abs(denom) <= eps * len1 * len2) {
      // Parallel — test collinearity by checking whether c lies on line a-b.
      if (Math.abs(V.cross(r, d1)) <= eps * len1 * V.len(r)) {
        const proj = p => V.dot(V.sub(p, a), d1) / (len1 * len1);
        const s1 = proj(a), s2 = proj(b), s3 = proj(c), s4 = proj(d);
        const lo = Math.max(Math.min(s1, s2), Math.min(s3, s4));
        const hi = Math.min(Math.max(s1, s2), Math.max(s3, s4));
        if (hi - lo > eps) {
          return [
            { x: a.x + d1.x * lo, y: a.y + d1.y * lo },
            { x: a.x + d1.x * hi, y: a.y + d1.y * hi },
          ];
        }
        if (hi - lo >= -eps) {
          return [{ x: a.x + d1.x * lo, y: a.y + d1.y * lo }];
        }
      }
      return [];
    }

    const t = V.cross(r, d2) / denom;
    const u = V.cross(r, d1) / denom;
    if (t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps) {
      const tt = Math.max(0, Math.min(1, t));
      return [{ x: a.x + d1.x * tt, y: a.y + d1.y * tt }];
    }
    return [];
  }

  /** Node-identity key: coordinates snapped to 1e-6 px. */
  function snapKey(p) {
    return Math.round(p.x * SNAP) + '_' + Math.round(p.y * SNAP);
  }

  /* ============================================================
     5. Polygon preprocessing
     ============================================================ */

  /** Remove consecutive duplicates and collinear vertices. */
  function simplifyPolygon(pts) {
    let out = [];
    for (const p of pts) {
      if (out.length && snapKey(out[out.length - 1]) === snapKey(p)) continue;
      out.push(p);
    }
    if (out.length >= 2 && snapKey(out[0]) === snapKey(out[out.length - 1])) out.pop();
    if (out.length < 3) return out;

    const n = out.length, res = [];
    for (let i = 0; i < n; i++) {
      const a = out[(i - 1 + n) % n], b = out[i], c = out[(i + 1) % n];
      if (Math.abs(V.cross(V.sub(b, a), V.sub(c, a))) <= 1e-9 * Math.max(1, V.dist(a, b) * V.dist(b, c))) continue;
      res.push(b);
    }
    return res.length >= 3 ? res : out;
  }

  /**
   * Ramer–Douglas–Peucker polyline simplification (iterative stack form).
   * Keeps every remaining vertex within `epsilon` px of the original path so
   * a freehand stroke becomes a light, smooth polygon — avoiding an excess of
   * redundant vertices for the subsequent mesh intersection step.
   */
  function rdpSimplify(points, epsilon) {
    if (!points || points.length <= 2) return points ? points.slice() : [];
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;

    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [i, j] = stack.pop();
      const a = points[i], b = points[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      const len = Math.sqrt(lenSq);

      // Perpendicular distance of each interior point to segment i-j.
      let maxDist = 0, index = -1;
      for (let k = i + 1; k < j; k++) {
        const d = lenSq === 0
          ? V.dist(points[k], a)
          : Math.abs((points[k].x - a.x) * dy - (points[k].y - a.y) * dx) / len;
        if (d > maxDist) { maxDist = d; index = k; }
      }

      if (maxDist > epsilon) {
        keep[index] = true;
        stack.push([i, index]);
        stack.push([index, j]);
      }
      // else: drop every interior point between i and j.
    }

    const out = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
    return out;
  }

  /** True if two segments properly cross (strict interior crossing). */
  function segmentsProperlyIntersect(a, b, c, d) {
    const d1 = V.sub(b, a), d2 = V.sub(d, c), r = V.sub(c, a);
    const denom = V.cross(d1, d2);
    if (Math.abs(denom) < 1e-12) return false;
    const t = V.cross(r, d2) / denom, u = V.cross(r, d1) / denom;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
  }

  /** A simple polygon has no repeated vertices and no self-crossing edges. */
  function isSimplePolygon(poly) {
    const n = poly.length;
    const seen = new Set();
    for (const p of poly) {
      const k = snapKey(p);
      if (seen.has(k)) return false;
      seen.add(k);
    }
    for (let i = 0; i < n; i++) {
      const a1 = poly[i], a2 = poly[(i + 1) % n];
      for (let j = i + 1; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges
        if (segmentsProperlyIntersect(a1, a2, poly[j], poly[(j + 1) % n])) return false;
      }
    }
    return true;
  }

  /**
   * Adaptive boundary sampling: subdivide each polygon edge into
   * ceil(length / spacing) equal parts so the sample spacing is <= `spacing`
   * while polygon corners are always preserved exactly. Because the polygon
   * is polygonal (straight edges), resampling introduces no geometric error.
   */
  function resamplePolygon(poly, spacing) {
    if (!poly || poly.length < 3 || spacing <= 0) return poly ? poly.slice() : [];
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L = V.dist(a, b);
      const n = Math.max(1, Math.ceil(L / spacing));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  }

  /* ============================================================
     6. Background grid generation (square / triangular / hexagonal)
     ============================================================ */

  function generateCells(type, rect, s) {
    if (type === 'square')   return squareCells(rect, s);
    if (type === 'triangle') return triangleCells(rect, s);
    return hexagonCells(rect, s);
  }

  /** Axis-aligned quads; each vertex ring is CCW. */
  function squareCells(rect, s) {
    const cells = [];
    const i0 = Math.floor(rect.minX / s), i1 = Math.ceil(rect.maxX / s);
    const j0 = Math.floor(rect.minY / s), j1 = Math.ceil(rect.maxY / s);
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const x = i * s, y = j * s;
        cells.push([{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }]);
      }
    }
    return cells;
  }

  /**
   * Equilateral-triangle tiling. The lattice point (i, j) is
   *   x = i·s + (j mod 2)·s/2,  y = j·h,  h = s·√3/2.
   * Each lattice cell yields an up-pointing and a down-pointing triangle;
   * the lozenge is always split along its SHORT diagonal (b-c on even rows,
   * a-d on odd rows) so every triangle stays equilateral.
   */
  function latPoint(i, j, s) {
    const h = s * SQRT3 / 2;
    const off = (((j % 2) + 2) % 2) * s / 2;
    return { x: i * s + off, y: j * h };
  }

  function triangleCells(rect, s) {
    const h = s * SQRT3 / 2;
    const cells = [];
    const j0 = Math.floor(rect.minY / h) - 1, j1 = Math.ceil(rect.maxY / h) + 1;
    for (let j = j0; j < j1; j++) {
      const off = (((j % 2) + 2) % 2) * s / 2;
      const i0 = Math.floor((rect.minX - off) / s) - 1;
      const i1 = Math.ceil((rect.maxX - off) / s) + 1;
      for (let i = i0; i < i1; i++) {
        const a = latPoint(i, j, s),     b = latPoint(i + 1, j, s),
              c = latPoint(i, j + 1, s), d = latPoint(i + 1, j + 1, s);
        if (off === 0) {
          // Even rows: the b-c diagonal of the lozenge is the short one
          // (length s) — splitting along it yields two equilateral triangles.
          cells.push([a, b, c]); // apex-down triangle (CCW)
          cells.push([d, c, b]); // apex-up triangle   (CCW)
        } else {
          // Odd rows: the b-c diagonal is the long one (length s·√3); splitting
          // along it would create 30°-30°-120° isosceles obtuse triangles.
          // Split along the short a-d diagonal instead to stay equilateral.
          cells.push([a, b, d]); // apex-down triangle (CCW)
          cells.push([a, d, c]); // apex-up triangle   (CCW)
        }
      }
    }
    return cells;
  }

  /**
   * Pointy-top hexagon tiling (honeycomb). Centers use axial coordinates:
   *   cx = s·√3·(q + r/2),  cy = 1.5·s·r.
   * Vertices are the 6 unit directions at ±30° etc., emitted CCW.
   */
  function hexVertices(cx, cy, s) {
    const hx = s * SQRT3 / 2, hy = s / 2;
    return [
      { x: cx + hx, y: cy + hy }, // lower-right
      { x: cx,      y: cy + s  }, // bottom
      { x: cx - hx, y: cy + hy }, // lower-left
      { x: cx - hx, y: cy - hy }, // upper-left
      { x: cx,      y: cy - s  }, // top
      { x: cx + hx, y: cy - hy }, // upper-right
    ];
  }

  function hexagonCells(rect, s) {
    const w = s * SQRT3;     // horizontal column spacing
    const hStep = 1.5 * s;   // vertical row spacing
    const cells = [];
    const r0 = Math.floor(rect.minY / hStep) - 1, r1 = Math.ceil(rect.maxY / hStep) + 1;
    for (let r = r0; r <= r1; r++) {
      const q0 = Math.floor(rect.minX / w - r / 2) - 1;
      const q1 = Math.ceil(rect.maxX / w - r / 2) + 1;
      for (let q = q0; q <= q1; q++) {
        cells.push(hexVertices(w * (q + r / 2), hStep * r, s));
      }
    }
    return cells;
  }

  /* ============================================================
     7. Convex-cell ∩ polygon clipping (the core mesh operation)
     ============================================================ */

  /**
   * Clip one CONVEX cell against a simple (possibly concave) polygon.
   *
   * Strategy — "split edges + midpoint classification + loop assembly":
   *  1. Compute every intersection point between cell edges and polygon
   *     edges (handling transversal crossings, touches, and collinear
   *     overlaps via segmentIntersection).
   *  2. Split each cell edge / polygon edge at its intersection points.
   *     A sub-segment of a cell edge is kept iff its midpoint is inside the
   *     polygon; a sub-segment of a polygon edge is kept iff its midpoint is
   *     inside the cell. (Sub-segments never cross the opposite boundary, so
   *     a single midpoint test classifies the whole piece — this is what
   *     makes the method robust for concave clip polygons.)
   *  3. The kept directed sub-segments form the boundary of the intersection;
   *     assemble them into closed loops, deduplicate coincident pieces, and
   *     enforce CCW ordering.
   *
   * Because a convex cell intersecting a concave polygon can be disconnected,
   * this returns an ARRAY of polygons (usually exactly one).
   */
  function clipCell(cell, clipPoly, clipEdges, clipBBox, spatialEps) {
    const cellEdges = ringEdges(cell);
    const cellBBox = bbox(cell);
    const nearEdges = clipEdges.filter(e => bboxIntersect(cellBBox, e.bbox));

    const cellSplits = cellEdges.map(() => []);
    const polySplits = nearEdges.map(() => []);

    // 1. Collect intersection points (with their parameter along each edge).
    //    Segment-intersection predicates use the tight dimensionless EPS.
    for (let ci = 0; ci < cellEdges.length; ci++) {
      const ce = cellEdges[ci];
      for (let pj = 0; pj < nearEdges.length; pj++) {
        const pe = nearEdges[pj];
        for (const pt of segmentIntersection(ce.a, ce.b, pe.a, pe.b, EPS)) {
          cellSplits[ci].push({ t: clamp01(paramOnSegment(pt, ce.a, ce.b)), pt });
          polySplits[pj].push({ t: clamp01(paramOnSegment(pt, pe.a, pe.b)), pt });
        }
      }
    }

    // 2. Build the kept directed sub-segments. Point-in-polygon boundary
    //    tolerance uses the scale-adaptive spatial epsilon.
    const edges = [];
    for (let ci = 0; ci < cellEdges.length; ci++) {
      const ce = cellEdges[ci];
      subdivideKeep(ce.a, ce.b, cellSplits[ci], m => pointInPolygon(m, clipPoly, spatialEps, clipBBox), edges, EPS);
    }
    for (let pj = 0; pj < nearEdges.length; pj++) {
      const pe = nearEdges[pj];
      subdivideKeep(pe.a, pe.b, polySplits[pj], m => pointInPolygon(m, cell, spatialEps, cellBBox), edges, EPS);
    }

    // 3. Deduplicate coincident edges, assemble loops, finalize to CCW polygons.
    const result = [];
    for (const loop of assembleLoops(dedupeEdges(edges))) {
      const poly = finalizeLoop(loop, AREA_EPS);
      if (poly) result.push(poly);
    }
    return result;
  }

  function ringEdges(poly) {
    const edges = [];
    for (let i = 0; i < poly.length; i++) edges.push({ a: poly[i], b: poly[(i + 1) % poly.length] });
    return edges;
  }

  function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

  /**
   * Split a directed edge a→b at the given parameter values; keep each
   * sub-segment whose midpoint satisfies `inside`.
   */
  function subdivideKeep(a, b, splits, inside, out, eps) {
    const ts = [0, 1];
    for (const s of splits) ts.push(s.t);
    ts.sort((x, y) => x - y);

    const uniq = [];
    for (const t of ts) {
      if (uniq.length && t - uniq[uniq.length - 1] <= eps) continue;
      uniq.push(t);
    }

    for (let i = 0; i < uniq.length - 1; i++) {
      const t0 = uniq[i], t1 = uniq[i + 1];
      if (t1 - t0 <= eps) continue;
      const A = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
      const B = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
      if (inside({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 })) out.push({ a: A, b: B });
    }
  }

  /** Remove coincident (undirected) duplicate edges (collinear overlap artifacts). */
  function dedupeEdges(edges) {
    const seen = new Set(), out = [];
    for (const e of edges) {
      const ka = snapKey(e.a), kb = snapKey(e.b);
      const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  }

  /** Trace directed edges into closed loops. */
  function assembleLoops(edges) {
    const startMap = new Map();
    edges.forEach((e, i) => {
      const k = snapKey(e.a);
      if (!startMap.has(k)) startMap.set(k, []);
      startMap.get(k).push(i);
    });

    const used = new Array(edges.length).fill(false);
    const loops = [];

    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const loop = [edges[i].a];
      const startKey = snapKey(edges[i].a);
      let cur = i;
      let guard = 0;
      while (!used[cur] && guard++ <= edges.length + 2) {
        used[cur] = true;
        loop.push(edges[cur].b);
        const cands = startMap.get(snapKey(edges[cur].b)) || [];
        let next = -1;
        for (const j of cands) if (!used[j]) { next = j; break; }
        if (next === -1) break;
        cur = next;
      }
      if (snapKey(loop[loop.length - 1]) === startKey) loops.push(loop);
    }
    return loops;
  }

  /** Clean a raw loop into a valid CCW polygon (or null if degenerate). */
  function finalizeLoop(loop, areaEps) {
    const pts = [];
    for (const p of loop) {
      if (pts.length && snapKey(pts[pts.length - 1]) === snapKey(p)) continue;
      pts.push(p);
    }
    if (pts.length >= 2 && snapKey(pts[0]) === snapKey(pts[pts.length - 1])) pts.pop();
    if (pts.length < 3) return null;
    const area = signedArea(pts);
    if (Math.abs(area) < areaEps) return null;
    if (area < 0) pts.reverse();
    return pts;
  }

  /** Strict inside test for a convex (CCW) cell: the point must be to the left
   *  of every edge by more than `eps` (a perpendicular-distance margin), i.e.
   *  strictly interior, not on the boundary. */
  function pointStrictlyInsideConvex(pt, cell, eps) {
    for (let i = 0; i < cell.length; i++) {
      const a = cell[i], b = cell[(i + 1) % cell.length];
      const edge = V.sub(b, a);
      if (V.cross(edge, V.sub(pt, a)) <= eps * V.len(edge)) return false;
    }
    return true;
  }

  /**
   * A convex cell is genuinely CUT by the polygon boundary iff a polygon edge
   * properly crosses one of its edges, or a polygon vertex lies strictly inside
   * it (the boundary passes through the cell interior). An edge that merely
   * touches, or overlaps collinearly with, a cell edge does NOT count as a cut —
   * this is what keeps grid-aligned interior cells from being mislabeled as
   * boundary cells.
   */
  function cellIsCutByPolygon(cell, polyEdges, spatialEps) {
    const cellEdges = ringEdges(cell);
    const cellBBox = bbox(cell);
    for (const pe of polyEdges) {
      if (!bboxIntersect(cellBBox, pe.bbox)) continue;
      for (const ce of cellEdges) {
        if (segmentsProperlyIntersect(ce.a, ce.b, pe.a, pe.b)) return true;
      }
      if (pointStrictlyInsideConvex(pe.a, cell, spatialEps) ||
          pointStrictlyInsideConvex(pe.b, cell, spatialEps)) return true;
    }
    return false;
  }

  /* ============================================================
     8. Mesh construction
     ============================================================ */

  /**
   * Build the conforming mesh:
   *  - Fully-enclosed cells are preserved verbatim (interior).
   *  - Cells touched by the boundary are clipped (boundary).
   *  - All other cells are discarded (exterior).
   * `classifyPoly` (few vertices) is used for the fast inside test; `clipPoly`
   * (the resampled boundary) is used for clipping so boundary nodes land on
   * the sampling points. Both are geometrically identical.
   */
  function buildMesh(cells, classifyPoly, clipPoly, spatialEps) {
    /**
     * Normalize both rings to the same (positive-shoelace) winding as the
     * generated cells. clipCell's loop assembly only closes when polygon-edge
     * pieces and cell-edge pieces chain in the same orientation; a polygon
     * drawn in the opposite direction (negative shoelace) would otherwise
     * yield zero boundary elements.
     */
    classifyPoly = makeCCW(classifyPoly);
    clipPoly = makeCCW(clipPoly);
    const classifyBBox  = bbox(classifyPoly);
    const classifyEdges = ringEdges(classifyPoly).map(e => ({ a: e.a, b: e.b, bbox: bboxOfSegment(e.a, e.b) }));
    const clipEdges     = ringEdges(clipPoly).map(e => ({ a: e.a, b: e.b, bbox: bboxOfSegment(e.a, e.b) }));
    const clipBBox      = bbox(clipPoly);

    const nodeMap = new Map();
    const nodes = [];
    const elements = [];
    let interiorCount = 0, boundaryCount = 0;

    const nodeId = (pt) => {
      const k = snapKey(pt);
      let id = nodeMap.get(k);
      if (id === undefined) {
        id = nodes.length;
        nodeMap.set(k, id);
        nodes.push({ x: pt.x, y: pt.y });
      }
      return id;
    };

    for (const cell of cells) {
      const cb = bbox(cell);
      if (!bboxIntersect(cb, classifyBBox)) continue; // far exterior

      let allInside = true;
      for (const p of cell) {
        if (!pointInPolygon(p, classifyPoly, spatialEps, classifyBBox)) { allInside = false; break; }
      }

      // Cheap bbox pre-filter: is any polygon edge near this cell at all?
      let anyNear = false;
      for (const e of classifyEdges) {
        if (bboxIntersect(cb, e.bbox)) { anyNear = true; break; }
      }

      if (allInside && !anyNear) {
        // Definitely interior — no polygon edge even near the cell.
        elements.push({ nodeIds: makeCCW(cell).map(nodeId), interior: true });
        interiorCount++;
        continue;
      }
      if (!allInside && !anyNear) continue; // definitely exterior

      // Ambiguous: an edge is near but may only touch the cell (grid-aligned
      // boundary) rather than cut through it. Decide with a precise test.
      const isCut = cellIsCutByPolygon(cell, classifyEdges, spatialEps);

      if (allInside && !isCut) {
        // Fully enclosed; the boundary merely touches an edge — keep it uncut.
        elements.push({ nodeIds: makeCCW(cell).map(nodeId), interior: true });
        interiorCount++;
      } else {
        // Genuinely cut (or straddling) — clip. clipCell returns [] for exterior.
        for (const part of clipCell(cell, clipPoly, clipEdges, clipBBox, spatialEps)) {
          elements.push({ nodeIds: part.map(nodeId), interior: false });
          boundaryCount++;
        }
      }
    }

    // Tag every node by provenance so the renderer can color-code it:
    //   grid         — original grid lattice vertex
    //   sampling     — point on the (resampled) polygon boundary
    //   intersection — cell-edge × polygon-edge crossing (neither of the above)
    const gridKeys = new Set();
    for (const cell of cells) for (const p of cell) gridKeys.add(snapKey(p));
    const sampleKeys = new Set();
    for (const p of clipPoly) sampleKeys.add(snapKey(p));
    for (const n of nodes) {
      const k = snapKey(n);
      n.type = sampleKeys.has(k) ? 'sampling'
             : (gridKeys.has(k) ? 'grid' : 'intersection');
    }

    return { nodes, elements, interiorCount, boundaryCount };
  }

  const Constants = { EPS: EPS, EPS_SCALE: EPS_SCALE, AREA_EPS: AREA_EPS, SNAP: SNAP, SQRT3: SQRT3,
                      FREEHAND_MIN_DIST: FREEHAND_MIN_DIST, FREEHAND_EPSILON: FREEHAND_EPSILON };
  const G = { V: V, signedArea: signedArea, makeCCW: makeCCW, distToSegment: distToSegment,
              pointInPolygon: pointInPolygon, bbox: bbox, bboxOfSegment: bboxOfSegment,
              bboxIntersect: bboxIntersect, paramOnSegment: paramOnSegment,
              segmentIntersection: segmentIntersection, snapKey: snapKey,
              segmentsProperlyIntersect: segmentsProperlyIntersect, simplifyPolygon: simplifyPolygon,
              rdpSimplify: rdpSimplify, isSimplePolygon: isSimplePolygon,
              resamplePolygon: resamplePolygon, clamp01: clamp01, ringEdges: ringEdges };
  const Grid = { generateCells: generateCells, squareCells: squareCells, latPoint: latPoint,
                 triangleCells: triangleCells, hexVertices: hexVertices, hexagonCells: hexagonCells };
  const Clipping = { clipCell: clipCell, cellIsCutByPolygon: cellIsCutByPolygon };
  const Mesh = { buildMesh: buildMesh };
  global.Legacy = { Constants: Constants, G: G, Grid: Grid, Clipping: Clipping, Mesh: Mesh };
})(window);