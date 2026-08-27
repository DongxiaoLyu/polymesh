/* ============================================================
   geometry.js — Vector math & core geometric predicates
   ============================================================
   Pure functions: no DOM access, no app state. None of them
   mutate their inputs (they return new objects / values).

   Depends on:  constants.js
   Exposes:     window.MeshStudio.Geometry
   ============================================================ */

(function (global) {
  'use strict';

  const Constants = global.MeshStudio.Constants;
  const EPS  = Constants.EPS;
  const SNAP = Constants.SNAP;

  /* ---------- 2D vector helpers ---------- */

  const V = {
    add:   (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale: (a, s) => ({ x: a.x * s,   y: a.y * s   }),
    dot:   (a, b) => a.x * b.x + a.y * b.y,
    cross: (a, b) => a.x * b.y - a.y * b.x, // 2D cross product (z component)
    len:   (a)    => Math.hypot(a.x, a.y),
    dist:  (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  };

  /* ---------- Polygon basics ---------- */

  /** Signed area (shoelace formula). Positive = counter-clockwise. */
  function signedArea(poly) {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }

  /** Return a CCW (counter-clockwise) copy of a polygon. */
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
   * `bboxOpt` (optional) speeds up the common case.
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

  /* ---------- Bounding boxes ---------- */

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

  /* ---------- Segment predicates ---------- */

  /** Parameter (0..1) of point p along segment a-b. */
  function paramOnSegment(p, a, b) {
    const ab = V.sub(b, a);
    const l2 = V.dot(ab, ab);
    return l2 === 0 ? 0 : V.dot(V.sub(p, a), ab) / l2;
  }

  /**
   * Robust segment-segment intersection.
   * Returns an array of 0, 1, or 2 points:
   *   - none                    -> []
   *   - transversal/touch point -> [point]
   *   - collinear overlap       -> [start, end]
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

  /** Node-identity key: coordinates rounded to 1e-6 px. */
  function snapKey(p) {
    return Math.round(p.x * SNAP) + '_' + Math.round(p.y * SNAP);
  }

  /** True if two segments properly cross (strict interior crossing). */
  function segmentsProperlyIntersect(a, b, c, d) {
    const d1 = V.sub(b, a), d2 = V.sub(d, c), r = V.sub(c, a);
    const denom = V.cross(d1, d2);
    if (Math.abs(denom) < 1e-12) return false;
    const t = V.cross(r, d2) / denom, u = V.cross(r, d1) / denom;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
  }

  /* ---------- Polygon cleaning ---------- */

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
   * Keeps every remaining vertex within `epsilon` px of the original path,
   * so a freehand stroke becomes a light, smooth polygon — avoiding an
   * excess of redundant vertices for the mesh intersection step.
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

  /* ---------- Boundary sampling ---------- */

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

  /* ---------- Fitting ---------- */

  /**
   * Uniform-scale a point ring to fit inside w×h, centered.
   * `margin` = fraction of the smaller side the shape should occupy (0.8).
   * `flipY`  = mirror vertically; use true when the source space is y-up
   *            (e.g. the demo's Cartesian space), false when the source is
   *            y-down (e.g. image pixel space, like the canvas itself).
   */
  function fitToCanvas(pts, w, h, margin, flipY) {
    const bb = bbox(pts);
    const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
    const scale = Math.min(w, h) * (margin || 0.8) / span;
    const midX = (bb.minX + bb.maxX) / 2, midY = (bb.minY + bb.maxY) / 2;
    return pts.map(p => ({
      x: w / 2 + (p.x - midX) * scale,
      y: h / 2 + (flipY ? -1 : 1) * (p.y - midY) * scale,
    }));
  }

  /* ---------- Small utilities ---------- */

  function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

  /** Directed edge ring of a polygon: [{a, b}, ...] in vertex order. */
  function ringEdges(poly) {
    const edges = [];
    for (let i = 0; i < poly.length; i++) edges.push({ a: poly[i], b: poly[(i + 1) % poly.length] });
    return edges;
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Geometry = {
    V,
    signedArea, makeCCW, distToSegment, pointInPolygon,
    bbox, bboxOfSegment, bboxIntersect, paramOnSegment,
    segmentIntersection, snapKey, segmentsProperlyIntersect,
    simplifyPolygon, rdpSimplify, isSimplePolygon, resamplePolygon,
    fitToCanvas, clamp01, ringEdges,
  };
})(window);
