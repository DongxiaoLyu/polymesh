/* ============================================================
   renderer.js — All canvas drawing, plus Path2D caching
   ============================================================
   createRenderer(ctx) returns a render function that draws the
   whole scene from the app `state` object.

   Performance: the static grid and the finished mesh are re-traced
   into Path2D objects ONLY when their input data changes (identity
   check on the state arrays). Pointer moves re-render every frame
   but reuse the cached paths, so drawing stays smooth.

   Depends on:  constants.js, geometry.js
   Exposes:     window.MeshStudio.Renderer
   ============================================================ */

(function (global) {
  'use strict';

  const Constants = global.MeshStudio.Constants;
  const COLORS = Constants.COLORS;
  const V = global.MeshStudio.Geometry.V;

  function createRenderer(ctx) {

    /** Trace one polygon ring into an existing Path2D. */
    function addPath(path, poly) {
      path.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x, poly[i].y);
      path.closePath();
    }

    /* ---------- Cached Path2D objects ---------- */
    let cachedCells = null, gridPath = null;
    let cachedMesh  = null, interiorPath = null, boundaryPath = null;
    let cachedNodes = null, nodePaths = null;

    function drawGrid(state) {
      if (state.cells !== cachedCells) {
        cachedCells = state.cells;
        gridPath = new Path2D();
        for (const cell of state.cells) addPath(gridPath, cell);
      }
      ctx.strokeStyle = COLORS.gridLine;
      ctx.lineWidth = 1;
      ctx.stroke(gridPath);
    }

    function drawMesh(state) {
      if (!state.mesh) return;
      if (state.mesh !== cachedMesh) {
        cachedMesh = state.mesh;
        interiorPath = new Path2D();
        boundaryPath = new Path2D();
        for (const el of state.mesh.elements) {
          const poly = el.nodeIds.map(id => state.mesh.nodes[id]);
          addPath(el.interior ? interiorPath : boundaryPath, poly);
        }
      }
      // Uncut / interior elements — System Blue.
      ctx.fillStyle = COLORS.interiorFill;
      ctx.fill(interiorPath);
      ctx.strokeStyle = COLORS.interiorEdge;
      ctx.lineWidth = 1.5;
      ctx.stroke(interiorPath);
      // Cut / boundary elements — System Orange, slightly thicker stroke.
      ctx.fillStyle = COLORS.boundaryFill;
      ctx.fill(boundaryPath);
      ctx.strokeStyle = COLORS.boundaryEdge;
      ctx.lineWidth = 2.5;
      ctx.stroke(boundaryPath);
    }

    function drawPolygon(state) {
      const poly = state.polygon;
      if (!poly || poly.length < 3) return;
      const path = new Path2D();
      addPath(path, poly);
      ctx.fillStyle = COLORS.polygonFill;
      ctx.fill(path);
      ctx.strokeStyle = COLORS.polygon;
      ctx.lineWidth = 1.5;
      ctx.stroke(path);
    }

    function drawNodes(state) {
      if (!state.mesh) return;
      const styles = [
        { type: 'grid',         color: COLORS.nodeGrid,      r: 2.5 },
        { type: 'sampling',     color: COLORS.nodeSampling,  r: 3.5 },
        { type: 'intersection', color: COLORS.nodeIntersect, r: 3.5 },
      ];
      if (state.mesh !== cachedNodes) {
        cachedNodes = state.mesh;
        // One Path2D + single fill per type keeps dense node sets fast.
        nodePaths = styles.map(({ type, color, r }) => {
          const path = new Path2D();
          for (const n of state.mesh.nodes) {
            if ((n.type || 'grid') !== type) continue;
            path.moveTo(n.x + r, n.y);
            path.arc(n.x, n.y, r, 0, Math.PI * 2);
          }
          return { color, path };
        });
      }
      for (const { color, path } of nodePaths) {
        ctx.fillStyle = color;
        ctx.fill(path);
      }
    }

    function drawPreview(state) {
      if (!state.drawing.length) return;
      const pts = state.drawing;
      const freehand = state.drawMode === 'freehand';

      // Path stroke: solid for freehand, dashed for click-to-point.
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = COLORS.polygonStroke;
      ctx.lineWidth = freehand ? 2 : 1.5;
      if (!freehand) ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (freehand) {
        // Hint the implicit closing edge back to the stroke start.
        if (pts.length > 2 && state.cursor) {
          ctx.beginPath();
          ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
          ctx.lineTo(pts[0].x, pts[0].y);
          ctx.strokeStyle = COLORS.polygonGuide;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        return;
      }

      // Click-to-point: discrete vertices + guide to cursor + close highlight.
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.vertexFill;
        ctx.fill();
        ctx.strokeStyle = COLORS.polygon;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (state.cursor) {
        ctx.beginPath();
        ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.lineTo(state.cursor.x, state.cursor.y);
        ctx.strokeStyle = COLORS.polygonGuide;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        if (pts.length >= 3 && V.dist(state.cursor, pts[0]) < 12) {
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, 8, 0, Math.PI * 2);
          ctx.strokeStyle = COLORS.polygonStroke;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    /* ============================================================
       Boundary conditions (loads / supports) markers + selection
       ============================================================ */

    /** Arrow from (x,y) along direction (dx,dy), scaled to length L. */
    function drawArrow(x, y, dx, dy, L, color, width) {
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return; // zero vector: no arrow
      const ux = dx / len, uy = dy / len;
      const x2 = x + ux * L, y2 = y + uy * L;
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const head = 5.5, ang = 0.42;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - Math.cos(Math.atan2(uy, ux) - ang) * head, y2 - Math.sin(Math.atan2(uy, ux) - ang) * head);
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - Math.cos(Math.atan2(uy, ux) + ang) * head, y2 - Math.sin(Math.atan2(uy, ux) + ang) * head);
      ctx.stroke();
    }

    /** Support marker: fixed = filled triangle, hinge = outlined triangle. */
    function drawSupport(x, y, type, color) {
      const filled = type === 'fixed';
      ctx.beginPath();
      ctx.moveTo(x - 6, y + 9);
      ctx.lineTo(x + 6, y + 9);
      ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = filled ? color : 'rgba(255,255,255,0.7)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      if (filled) ctx.fill();
      ctx.stroke();
      if (filled) { // ground hatch
        ctx.beginPath();
        ctx.moveTo(x - 10, y + 12); ctx.lineTo(x + 10, y + 12);
        ctx.moveTo(x - 7, y + 15); ctx.lineTo(x + 7, y + 15);
        ctx.moveTo(x - 4, y + 18); ctx.lineTo(x + 4, y + 18);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    function drawConditions(state) {
      const mesh = state.mesh;
      if (!mesh) return;
      const colors = Constants.COND_COLORS;

      // --- live selection preview ---
      const sel = state.bcSel;
      if (sel) {
        if (sel.nodes && sel.nodes.size) {
          ctx.fillStyle = 'rgba(0,113,227,0.35)';
          for (const id of sel.nodes) {
            const n = mesh.nodes[id];
            ctx.beginPath();
            ctx.arc(n.x, n.y, 7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (sel.edges && sel.edges.size) {
          ctx.strokeStyle = 'rgba(0,113,227,0.6)';
          ctx.lineWidth = 5;
          ctx.beginPath();
          for (const [a, b] of sel.edges.values()) {
            const na = mesh.nodes[a], nb = mesh.nodes[b];
            ctx.moveTo(na.x, na.y);
            ctx.lineTo(nb.x, nb.y);
          }
          ctx.stroke();
        }
        if (sel.box) {
          const b = sel.box;
          ctx.fillStyle = 'rgba(0,113,227,0.08)';
          ctx.strokeStyle = 'rgba(0,113,227,0.5)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
          ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
          ctx.setLineDash([]);
        }
      }

      // --- confirmed groups ---
      const color = i => colors[i % colors.length];

      state.pointLoads.forEach((g, gi) => {
        const col = color(gi);
        for (const id of g.nodeIds) {
          const n = mesh.nodes[id];
          ctx.beginPath();
          ctx.arc(n.x, n.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fill();
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          ctx.stroke();
          // Load vectors use the FEM convention (+Y = up); the canvas is
          // Y-down, so the arrow direction flips the Y component.
          drawArrow(n.x, n.y, g.fx, -g.fy, 18, col, 2);
        }
      });

      state.distLoads.forEach((g, gi) => {
        const col = color(gi);
        for (const [a, b] of g.edges) {
          const na = mesh.nodes[a], nb = mesh.nodes[b];
          const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
          ctx.beginPath();
          ctx.moveTo(na.x, na.y);
          ctx.lineTo(nb.x, nb.y);
          ctx.strokeStyle = col;
          ctx.lineWidth = 3;
          ctx.stroke();
          drawArrow(mx, my, g.fx, -g.fy, 14, col, 2);
        }
      });

      state.supports.forEach((g, gi) => {
        const col = color(gi);
        for (const id of g.nodeIds) drawSupport(mesh.nodes[id].x, mesh.nodes[id].y, g.type, col);
      });
    }

    /** Draw the complete scene from the current app state. */
    function render(state) {
      ctx.clearRect(0, 0, state.w, state.h);
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, state.w, state.h);

      drawGrid(state);
      drawMesh(state);
      drawPolygon(state);
      drawNodes(state);
      drawConditions(state);
      drawPreview(state);
    }

    return { render };
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Renderer = { createRenderer };
})(window);
