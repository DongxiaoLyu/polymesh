/* ============================================================
   clipping.js — Convex cell ∩ polygon clipping (the core step)
   ============================================================
   Strategy — "split edges + midpoint classification + loop assembly":
    1. Compute every intersection point between cell edges and polygon
       edges (handling transversal crossings, touches, and collinear
       overlaps via segmentIntersection).
    2. Split each cell edge / polygon edge at its intersection points.
       A sub-segment of a cell edge is kept iff its midpoint is inside the
       polygon; a sub-segment of a polygon edge is kept iff its midpoint is
       inside the cell. (Sub-segments never cross the opposite boundary, so
       a single midpoint test classifies the whole piece — this is what
       makes the method robust for concave clip polygons.)
    3. The kept directed sub-segments form the boundary of the intersection;
       assemble them into closed loops, deduplicate coincident pieces, and
       enforce CCW ordering.

   Because a convex cell intersecting a concave polygon can be disconnected,
   clipCell returns an ARRAY of polygons (usually exactly one).

   Depends on:  constants.js, geometry.js
   Exposes:     window.MeshStudio.Clipping
   ============================================================ */

(function (global) {
  'use strict';

  const Constants = global.MeshStudio.Constants;
  const EPS     = Constants.EPS;
  const AREA_EPS = Constants.AREA_EPS;

  // Local aliases for the geometry functions this file uses.
  const G = global.MeshStudio.Geometry;
  const V                     = G.V;
  const bbox                  = G.bbox;
  const bboxIntersect         = G.bboxIntersect;
  const pointInPolygon        = G.pointInPolygon;
  const paramOnSegment        = G.paramOnSegment;
  const segmentIntersection   = G.segmentIntersection;
  const snapKey               = G.snapKey;
  const signedArea            = G.signedArea;
  const segmentsProperlyIntersect = G.segmentsProperlyIntersect;
  const ringEdges             = G.ringEdges;
  const clamp01               = G.clamp01;

  /* ---------- The main clip operation ---------- */

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

  /* ---------- Helpers ---------- */

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

  /**
   * Strict inside test for a convex (CCW) cell: the point must be to the left
   * of every edge by more than `eps` (a perpendicular-distance margin), i.e.
   * strictly interior, not on the boundary.
   */
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

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Clipping = {
    clipCell, cellIsCutByPolygon,
  };
})(window);
