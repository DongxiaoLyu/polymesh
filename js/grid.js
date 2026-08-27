/* ============================================================
   grid.js — Background grid generation & grid snapping
   ============================================================
   Three tilings: square, equilateral-triangle, pointy-top hexagon.
   All cells are emitted as CCW (counter-clockwise) vertex rings in
   screen coordinates — the loop assembly in clipping.js relies on
   this consistent winding.

   Depends on:  constants.js, geometry.js
   Exposes:     window.MeshStudio.Grid
   ============================================================ */

(function (global) {
  'use strict';

  const Constants = global.MeshStudio.Constants;
  const SQRT3 = Constants.SQRT3;
  const V = global.MeshStudio.Geometry.V;

  /* ---------- Generation dispatch ---------- */

  function generateCells(type, rect, s) {
    if (type === 'square')   return squareCells(rect, s);
    if (type === 'triangle') return triangleCells(rect, s);
    return hexagonCells(rect, s);
  }

  /* ---------- Square tiling ---------- */

  /** Axis-aligned quads covering `rect`; each vertex ring is CCW. */
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

  /* ---------- Equilateral-triangle tiling ---------- */

  /**
   * The lattice point (i, j) is
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

  /* ---------- Hexagonal (honeycomb) tiling ---------- */

  /**
   * Vertices of a pointy-top hexagon centered at (cx, cy), emitted CCW.
   * Centers use axial coordinates: cx = s·√3·(q + r/2), cy = 1.5·s·r.
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

  /* ---------- Snapping ---------- */

  /**
   * Snap a raw pointer position to the nearest lattice vertex of the
   * active grid type. Returns a copy; with snap off, the point passes
   * through unchanged.
   */
  function snapPoint(p, gridType, cellSize, snap) {
    if (!snap) return { x: p.x, y: p.y };
    const s = cellSize;

    if (gridType === 'square') {
      return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s };
    }

    if (gridType === 'triangle') {
      const h = s * SQRT3 / 2;
      const j = Math.round(p.y / h);
      const off = (((j % 2) + 2) % 2) * s / 2;
      const i = Math.round((p.x - off) / s);
      return { x: i * s + off, y: j * h };
    }

    // Hexagon: nearest honeycomb vertex (checked over nearest hex + neighbors).
    const qf = (SQRT3 / 3 * p.x - 1 / 3 * p.y) / s;
    const rf = (2 / 3 * p.y) / s;
    const q = Math.round(qf), r = Math.round(rf);
    let best = null, bestD = Infinity;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dq = -1; dq <= 1; dq++) {
        const cx = s * SQRT3 * ((q + dq) + (r + dr) / 2);
        const cy = 1.5 * s * (r + dr);
        for (const v of hexVertices(cx, cy, s)) {
          const d = V.dist(p, v);
          if (d < bestD) { bestD = d; best = v; }
        }
      }
    }
    return best;
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Grid = {
    generateCells, squareCells, latPoint, triangleCells,
    hexVertices, hexagonCells, snapPoint,
  };
})(window);
