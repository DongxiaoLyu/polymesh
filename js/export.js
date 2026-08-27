/* ============================================================
   export.js — TXT mesh output (nodes + elements)
   ============================================================
   Produces the classic FEA/VEM mesh file format:
     # NODES (ID X Y)
     1 x y
     ...
     # ELEMENTS (ID NODE_1 NODE_2 ... NODE_N)
     1 n1 n2 ...
   IDs are 1-based; fields are space-delimited (no commas).

   buildTxt is a pure function (no DOM) — easy to test.

   Depends on:  nothing
   Exposes:     window.MeshStudio.Export
   ============================================================ */

(function (global) {
  'use strict';

  /** Format a number without trailing zeros ('-0' becomes '0'). */
  function fmt(x) {
    let s = x.toFixed(4);
    s = s.replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
  }

  /**
   * Build the full TXT document for a mesh (nodes + elements + conditions).
   *
   * opts.height — drawing-area height in CSS px. When given, node Y
   *   coordinates are flipped (y' = height - y) so the exported mesh is
   *   Y-UP. The app draws in screen space (Y-down), so without the flip
   *   the file would be a vertical mirror of the drawn shape when read in
   *   a standard Cartesian (Y-up) system.
   * opts.fit — target box size in px (e.g. 100). When given, all node
   *   coordinates are uniformly scaled (aspect preserved) and centered so
   *   the whole mesh fits inside [0, fit] x [0, fit].
   *
   * conditions (optional) — { pointLoads, distLoads, supports }:
   *   pointLoads: [{ name, nodeIds[], fx, fy }]      (node ids 0-based)
   *   distLoads:  [{ name, edges: [[a,b],...], fx, fy }]
   *   supports:   [{ name, type: 'fixed'|'hinge', nodeIds[] }]
   *   These append three group-block sections:
   *     # POINT LOADS (NAME COUNT | NODE LINES | FX FY)
   *     # DISTRIBUTED LOADS (NAME COUNT | EDGE LINES N1 N2 | FX FY)
   *     # SUPPORTS (NAME TYPE COUNT | NODE LINES)
   *   Each group = one header line (name [+ type] + member count),
   *   then one line per member, then one vector line (loads only).
   *   All node/edge ids in the file are 1-based.
   */
  function buildTxt(mesh, opts, conditions) {
    opts = opts || {};
    const height = opts.height;
    const fit = opts.fit;
    const flipY = typeof height === 'number' && isFinite(height) && height > 0;
    const doFit = typeof fit === 'number' && isFinite(fit) && fit > 0;
    const { nodes, elements } = mesh;

    // 1. Optional Y flip: screen space (Y-down) -> Cartesian (Y-up).
    const xs = nodes.map(n => n.x);
    const ys = nodes.map(n => (flipY ? height - n.y : n.y));

    // 2. Optional uniform fit into [0, fit] x [0, fit], centered.
    let s = 1, dx = 0, dy = 0;
    if (doFit && nodes.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < nodes.length; i++) {
        if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i];
        if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i];
      }
      const span = Math.max(maxX - minX, maxY - minY);
      s = span > 0 ? fit / span : 1;
      dx = (fit - (maxX - minX) * s) / 2 - minX * s;
      dy = (fit - (maxY - minY) * s) / 2 - minY * s;
    }

    const lines = [];
    lines.push('# NODES (ID X Y)');
    nodes.forEach((n, i) => lines.push((i + 1) + ' ' + fmt(xs[i] * s + dx) + ' ' + fmt(ys[i] * s + dy)));
    lines.push('');
    lines.push('# ELEMENTS (ID NODE_1 NODE_2 ... NODE_N)');
    // Node order is reversed so every element is COUNTER-CLOCKWISE in the
    // exported Y-UP coordinates: the mesh is CCW in screen space (Y-down),
    // and the export's Y flip mirrors the winding, turning it CW — reversing
    // the ring restores CCW, which is what FEM solvers expect (positive
    // Jacobian).
    elements.forEach((el, i) => {
      const ids = el.nodeIds.slice().reverse();
      lines.push((i + 1) + ' ' + ids.map(id => id + 1).join(' '));
    });

    // 3. Optional boundary-condition sections.
    const c = conditions || {};
    appendConditions(lines, c.pointLoads || [], c.distLoads || [], c.supports || []);

    return lines.join('\n');
  }

  /** Append the POINT LOADS / DISTRIBUTED LOADS / SUPPORTS sections. */
  function appendConditions(lines, pointLoads, distLoads, supports) {
    if (pointLoads.length) {
      lines.push('');
      lines.push('# POINT LOADS (NAME COUNT | NODE LINES | FX FY)');
      for (const g of pointLoads) {
        lines.push(g.name + ' ' + g.nodeIds.length);
        g.nodeIds.forEach(id => lines.push(String(id + 1)));
        lines.push(fmt(g.fx) + ' ' + fmt(g.fy));
      }
    }
    if (distLoads.length) {
      lines.push('');
      lines.push('# DISTRIBUTED LOADS (NAME COUNT | EDGE LINES N1 N2 | FX FY)');
      for (const g of distLoads) {
        lines.push(g.name + ' ' + g.edges.length);
        g.edges.forEach(([a, b]) => lines.push((a + 1) + ' ' + (b + 1)));
        lines.push(fmt(g.fx) + ' ' + fmt(g.fy));
      }
    }
    if (supports.length) {
      lines.push('');
      lines.push('# SUPPORTS (NAME TYPE COUNT | NODE LINES)');
      for (const g of supports) {
        lines.push(g.name + ' ' + g.type + ' ' + g.nodeIds.length);
        g.nodeIds.forEach(id => lines.push(String(id + 1)));
      }
    }
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Export = { fmt, buildTxt };
})(window);
