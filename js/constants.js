/* ============================================================
   constants.js — Global configuration & tuning parameters
   ============================================================
   Every magic number in the app lives here, so the rest of the
   code never hard-codes a value. Loaded FIRST — no dependencies.

   Exposes:  window.MeshStudio.Constants
   ============================================================ */

(function (global) {
  'use strict';

  const Constants = {

    /* ----- Geometric tolerances ----- */

    // Dimensionless tolerance for segment-intersection predicates
    // (compared against lengths, so it stays scale-invariant).
    EPS: 1e-7,

    // Spatial tolerance factor: spatialEps = cellSize * EPS_SCALE (px).
    // Used by point-in-polygon boundary tests and "strictly inside" tests.
    EPS_SCALE: 1e-4,

    // Drop clipped slivers smaller than this area (px^2).
    AREA_EPS: 1e-6,

    // Node-identity snap: coordinates are rounded to 1e-6 px so that
    // near-equal points produced by different computations merge into
    // a single mesh node.
    SNAP: 1e6,

    SQRT3: Math.sqrt(3),

    /* ----- Freehand capture ----- */

    FREEHAND_MIN_DIST: 2, // px — minimum spacing between raw stroke samples
    FREEHAND_EPSILON:  3, // px — RDP simplification tolerance for strokes

    /* ----- Polygon validation ----- */

    MIN_POLYGON_AREA: 1,  // px^2 — reject finished polygons smaller than this

    /* ----- Export ----- */

    EXPORT_FIT: 100,      // px — uniformly fit the exported mesh into a 100x100 box

    /* ----- Boundary conditions (loads & supports) ----- */

    BC_SELECT_RADIUS: 12, // px — click-selection tolerance around a node / edge midpoint
    BC_DRAG_THRESHOLD: 4, // px — pointer travel that turns a click into a box-drag

    // Per-group colors, cycled by group index.
    COND_COLORS: ['#0071E3', '#FF9500', '#AF52DE', '#34C759', '#FF3B30',
                  '#00C7BE', '#FF2D55', '#5856D6', '#FFCC00', '#64D2FF'],

    /* ----- Shared palette -----
       Colors are kept in ONE place so retheming is a single edit.
       (The CSS variables in index.html are the non-canvas half of
       the theme; these drive the canvas drawing.) */
    COLORS: {
      background:    '#F5F5F7',
      gridLine:      '#E2E2E8',
      polygon:       '#0071E3',                 // finalized polygon outline
      polygonFill:   'rgba(0,113,227,0.04)',
      polygonStroke: 'rgba(0,113,227,0.55)',   // in-progress drawing stroke
      polygonGuide:  'rgba(0,113,227,0.3)',    // dashed guide lines
      vertexFill:    '#fff',
      interiorFill:  'rgba(0,113,227,0.15)',   // uncut elements
      interiorEdge:  'rgba(0,113,227,0.4)',
      boundaryFill:  'rgba(255,149,0,0.25)',   // clipped elements
      boundaryEdge:  'rgba(255,149,0,0.8)',
      nodeGrid:      '#8E8E93',                 // original lattice points
      nodeSampling:  '#AF52DE',                 // boundary sampling points
      nodeIntersect: '#FF3B30',                 // grid x polygon crossings
    },
  };

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Constants = Constants;
})(window);
