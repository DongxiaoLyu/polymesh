/* ============================================================
   mesh.js — Mesh construction: classify cells, clip, dedupe nodes
   ============================================================
   Build the conforming mesh:
     - Fully-enclosed cells are preserved verbatim (interior).
     - Cells touched by the boundary are clipped (boundary).
     - All other cells are discarded (exterior).
   `classifyPoly` (few vertices) is used for the fast inside test;
   `clipPoly` (the resampled boundary) is used for clipping so boundary
   nodes land on the sampling points. Both are geometrically identical.

   Depends on:  constants.js, geometry.js, clipping.js
   Exposes:     window.MeshStudio.Mesh
   ============================================================ */

(function (global) {
  'use strict';

  const Constants = global.MeshStudio.Constants;

  const G = global.MeshStudio.Geometry;
  const Clipping = global.MeshStudio.Clipping;

  const bbox           = G.bbox;
  const bboxIntersect  = G.bboxIntersect;
  const bboxOfSegment  = G.bboxOfSegment;
  const makeCCW        = G.makeCCW;
  const pointInPolygon = G.pointInPolygon;
  const ringEdges      = G.ringEdges;
  const snapKey        = G.snapKey;

  /**
   * Build the mesh for the given background cells and polygon.
   *
   * Returns { nodes, elements, interiorCount, boundaryCount }:
   *   nodes    — [{ x, y, type }] unique mesh nodes, type is one of
   *              'grid' | 'sampling' | 'intersection'
   *   elements — [{ nodeIds: [..], interior: bool }] cell vertex rings
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

    // Node table: coordinates rounded via snapKey so that points produced by
    // different computations (grid lattice vs. intersections vs. samples)
    // that are effectively equal share one node id.
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
      const isCut = Clipping.cellIsCutByPolygon(cell, classifyEdges, spatialEps);

      if (allInside && !isCut) {
        // Fully enclosed; the boundary merely touches an edge — keep it uncut.
        elements.push({ nodeIds: makeCCW(cell).map(nodeId), interior: true });
        interiorCount++;
      } else {
        // Genuinely cut (or straddling) — clip. clipCell returns [] for exterior.
        for (const part of Clipping.clipCell(cell, clipPoly, clipEdges, clipBBox, spatialEps)) {
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

  /* ============================================================
     Boundary edges & selection helpers (for BCs / pressures)
     ============================================================ */

  /**
   * Undirected boundary edges of a mesh — the edges used by exactly ONE
   * element (interior edges are shared by two). These are the mesh's
   * outer boundary segments where boundary-edge BCs (pressures, scalar
   * Poisson BCs, supports…) apply.
   * Returns an array of [nodeIdA, nodeIdB] with a < b (0-based ids).
   */
  function boundaryEdges(mesh) {
    const count = new Map();
    const pairs = new Map();
    for (const el of mesh.elements) {
      const ids = el.nodeIds;
      for (let i = 0; i < ids.length; i++) {
        let a = ids[i], b = ids[(i + 1) % ids.length];
        if (a > b) { const t = a; a = b; b = t; }
        const k = a + '_' + b;
        count.set(k, (count.get(k) || 0) + 1);
        pairs.set(k, [a, b]);
      }
    }
    const out = [];
    for (const [k, c] of count) if (c === 1) out.push(pairs.get(k));
    return out;
  }

  /** Index of the mesh node nearest to point p within `radius`, or -1. */
  function nearestNode(mesh, p, radius) {
    let best = -1, bestD = radius;
    for (let i = 0; i < mesh.nodes.length; i++) {
      const n = mesh.nodes[i];
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** Index of the boundary edge nearest to point p within `radius`, or -1. */
  function nearestEdge(edges, mesh, p, radius) {
    let best = -1, bestD = radius;
    for (let i = 0; i < edges.length; i++) {
      const [a, b] = edges[i];
      const na = mesh.nodes[a], nb = mesh.nodes[b];
      const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
      const d = Math.hypot(mx - p.x, my - p.y);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * ALL unique undirected edges of a mesh — boundary AND interior.
   * Interior edges are shared by two elements; kept for edge-selection
   * helpers and potential future interior line loads. Returns
   * [nodeIdA, nodeIdB] pairs with a < b (0-based ids).
   */
  function allEdges(mesh) {
    const seen = new Map();
    for (const el of mesh.elements) {
      const ids = el.nodeIds;
      for (let i = 0; i < ids.length; i++) {
        let a = ids[i], b = ids[(i + 1) % ids.length];
        if (a > b) { const t = a; a = b; b = t; }
        const k = a + '_' + b;
        if (!seen.has(k)) seen.set(k, [a, b]);
      }
    }
    return [...seen.values()];
  }

  /** Node ids inside an axis-aligned box {minX,minY,maxX,maxY}. */
  function nodesInBox(mesh, box) {
    const out = [];
    for (let i = 0; i < mesh.nodes.length; i++) {
      const n = mesh.nodes[i];
      if (n.x >= box.minX && n.x <= box.maxX && n.y >= box.minY && n.y <= box.maxY) out.push(i);
    }
    return out;
  }

  /** Boundary-edge indices whose midpoint lies inside `box`. */
  function edgesInBox(edges, mesh, box) {
    const out = [];
    for (let i = 0; i < edges.length; i++) {
      const [a, b] = edges[i];
      const na = mesh.nodes[a], nb = mesh.nodes[b];
      const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
      if (mx >= box.minX && mx <= box.maxX && my >= box.minY && my <= box.maxY) out.push(i);
    }
    return out;
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Mesh = {
    buildMesh, boundaryEdges, allEdges, nearestNode, nearestEdge, nodesInBox, edgesInBox,
  };
})(window);
