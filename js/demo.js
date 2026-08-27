/* ============================================================
   demo.js — Built-in demo boundary ring (51 nodes)
   ============================================================
   The ring is the 51 ordered nodes from the original demo.txt
   (10 × 10 space). buildPolygon(w, h) scales it to 80% of the
   canvas' smaller side, centers it, and flips Y (the demo space
   is y-up, the canvas is y-down).

   Depends on:  geometry.js (bbox)
   Exposes:     window.MeshStudio.Demo
   ============================================================ */

(function (global) {
  'use strict';

  const G = global.MeshStudio.Geometry;

  const DEMO_RING = [
    {x:5.660377,y:10.000000},
    {x:5.503145,y:9.968553},
    {x:5.330189,y:9.701258},
    {x:4.968553,y:8.443396},
    {x:4.701258,y:8.459119},
    {x:4.166667,y:8.977987},
    {x:3.679245,y:9.371069},
    {x:3.301887,y:9.544025},
    {x:3.238994,y:9.496855},
    {x:3.238994,y:9.308176},
    {x:3.490566,y:8.238994},
    {x:2.955975,y:7.893082},
    {x:2.672956,y:7.578616},
    {x:2.531447,y:7.295597},
    {x:2.311321,y:6.588050},
    {x:1.588050,y:5.676101},
    {x:1.603774,y:5.503145},
    {x:1.761006,y:5.267296},
    {x:1.839623,y:4.968553},
    {x:2.028302,y:4.732704},
    {x:2.185535,y:4.308176},
    {x:2.342767,y:4.150943},
    {x:2.657233,y:4.040881},
    {x:3.333333,y:4.009434},
    {x:3.553459,y:3.836478},
    {x:3.632075,y:3.694969},
    {x:3.647799,y:3.128931},
    {x:3.411950,y:2.201258},
    {x:3.427673,y:1.446541},
    {x:3.553459,y:1.006289},
    {x:3.726415,y:0.660377},
    {x:3.977987,y:0.330189},
    {x:4.323899,y:0.000000},
    {x:4.433962,y:0.015723},
    {x:4.748428,y:0.314465},
    {x:5.235849,y:0.644654},
    {x:6.745283,y:1.367925},
    {x:7.452830,y:1.855346},
    {x:7.814465,y:2.216981},
    {x:8.113208,y:2.625786},
    {x:8.301887,y:3.034591},
    {x:8.411950,y:3.490566},
    {x:8.380503,y:4.245283},
    {x:8.066038,y:5.754717},
    {x:7.893082,y:6.336478},
    {x:7.578616,y:6.965409},
    {x:7.216981,y:7.468553},
    {x:6.902516,y:8.333333},
    {x:6.477987,y:9.119497},
    {x:6.022013,y:9.732704},
    {x:5.817610,y:9.921384},
  ];

  /**
   * Scale the demo ring to fit the canvas (uniform scale, aspect
   * preserved, Y flipped because the demo space is y-up) and return
   * screen-space points. Reuses Geometry.fitToCanvas.
   */
  function buildPolygon(w, h) {
    return G.fitToCanvas(DEMO_RING, w, h, 0.8, true);
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Demo = { buildPolygon, RING: DEMO_RING };
})(window);
