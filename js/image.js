/* ============================================================
   image.js — Bitmap → polygon contour extraction (image import)
   ============================================================
   Pure functions: no DOM access. Input images are plain
   { data: Uint8ClampedArray (RGBA), width, height } objects —
   the browser's ImageData has exactly this shape, and node tests
   can construct the same shape by hand, so everything here is
   testable without a browser.

   Pipeline (mirrors a classic Python CV approach):
     grayscale → Gaussian blur → Otsu threshold → foreground mask
     → contour extraction (marching-squares style edge stitching)
     → largest contour → AUTO-DETECT filled vs stroke outline
       (fill-ratio heuristic) → RDP simplification → fit to canvas

   Depends on:  constants.js, geometry.js
   Exposes:     window.MeshStudio.Image
   ============================================================ */

(function (global) {
  'use strict';

  const Constants = global.MeshStudio.Constants;
  const G = global.MeshStudio.Geometry;

  /* ============================================================
     1. Preprocessing: grayscale, blur, threshold
     ============================================================ */

  /** RGBA image → grayscale buffer (Rec. 601 luma). */
  function toGray(image) {
    const { data, width, height } = image;
    const n = width * height;
    const gray = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      gray[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
    }
    return gray;
  }

  /** Separable Gaussian blur on a grayscale buffer (returns a new buffer). */
  function gaussianBlur(gray, width, height, sigma) {
    const radius = Math.max(1, Math.round(sigma * 3));
    const k = [];                       // 1D kernel
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k.push(v); sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;

    const n = width * height;
    const tmp = new Float64Array(n);    // no clamping between passes
    const out = new Uint8ClampedArray(n);

    for (let y = 0; y < height; y++) {  // horizontal pass
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let i = -radius; i <= radius; i++) {
          const xi = Math.max(0, Math.min(width - 1, x + i));
          acc += gray[row + xi] * k[i + radius];
        }
        tmp[row + x] = acc;
      }
    }
    for (let x = 0; x < width; x++) {   // vertical pass
      for (let y = 0; y < height; y++) {
        let acc = 0;
        for (let i = -radius; i <= radius; i++) {
          const yi = Math.max(0, Math.min(height - 1, y + i));
          acc += tmp[yi * width + x] * k[i + radius];
        }
        out[y * width + x] = acc | 0;
      }
    }
    return out;
  }

  /**
   * Otsu's method: pick the threshold that best separates dark from
   * light pixels (maximizes between-class variance).
   */
  function otsuThreshold(gray) {
    const hist = new Float64Array(256);
    let total = 0;
    for (let i = 0; i < gray.length; i++) { hist[gray[i]]++; total++; }
    if (!total) return 127;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0, wB = 0;
    let best = 0, bestVar = -1;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      // `>=` keeps the LAST maximum, so a flat variance plateau (e.g. a
      // two-tone histogram) resolves to the high end of the plateau.
      if (v >= bestVar) { bestVar = v; best = t; }
    }
    return best;
  }

  /** Binarize: 1 = foreground (dark pixel below threshold), 0 = background. */
  function binarizeDark(gray, threshold) {
    const n = gray.length;
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = gray[i] < threshold ? 1 : 0;
    return mask;
  }

  /* ============================================================
     2. Contour extraction (marching-squares style edge stitching)
     ============================================================ */

  /**
   * Trace the boundary of the foreground (mask == 1) region.
   * Every filled pixel emits its unit edges that border a background
   * pixel (or the image edge), each directed so the filled pixel is on
   * the LEFT. Stitching these directed unit edges yields closed loops.
   * Returns an array of contours; each contour is an array of {x,y}
   * grid points forming a closed loop (first point == last point).
   */
  function marchingSquares(mask, width, height) {
    const edges = [];
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (!mask[row + x]) continue;
        // top side (y): emit if the pixel above is background
        if (y === 0 || !mask[row - width + x]) edges.push({ a: {x, y}, b: {x: x + 1, y} });
        // bottom side (y+1)
        if (y === height - 1 || !mask[row + width + x]) edges.push({ a: {x: x + 1, y: y + 1}, b: {x, y: y + 1} });
        // left side (x)
        if (x === 0 || !mask[row + x - 1]) edges.push({ a: {x, y: y + 1}, b: {x, y} });
        // right side (x+1)
        if (x === width - 1 || !mask[row + x + 1]) edges.push({ a: {x: x + 1, y}, b: {x: x + 1, y: y + 1} });
      }
    }
    return stitchEdges(edges);
  }

  /** Stitch directed unit edges into closed loops. */
  function stitchEdges(edges) {
    const key = p => p.x + '_' + p.y;
    const outMap = new Map();
    edges.forEach((e, i) => {
      const k = key(e.a);
      if (!outMap.has(k)) outMap.set(k, []);
      outMap.get(k).push(i);
    });
    const used = new Array(edges.length).fill(false);
    const loops = [];
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const pts = [edges[i].a];
      const startKey = key(edges[i].a);
      let cur = i;
      let guard = 0;
      while (guard++ <= edges.length + 2) {
        used[cur] = true;
        const b = edges[cur].b;
        const bKey = key(b);
        pts.push(b);
        if (bKey === startKey) break;
        const cands = outMap.get(bKey) || [];
        let next = -1;
        for (const j of cands) if (!used[j]) { next = j; break; }
        if (next === -1) break;
        cur = next;
      }
      loops.push(pts);
    }
    return loops;
  }

  /** The contour with the largest absolute area. */
  function largestContour(contours) {
    let best = null, bestArea = -1;
    for (const c of contours) {
      const a = Math.abs(G.signedArea(c));
      if (a > bestArea) { bestArea = a; best = c; }
    }
    return best;
  }

  /** Fraction of the contour's interior that is foreground (dark) pixels. */
  function fillRatio(mask, width, height, contour) {
    const bb = G.bbox(contour);
    const step = Math.max(1, Math.floor(Math.min(width, height) / 128));
    let inside = 0, dark = 0;
    for (let y = Math.max(0, Math.floor(bb.minY)); y <= Math.min(height - 1, Math.ceil(bb.maxY)); y += step) {
      for (let x = Math.max(0, Math.floor(bb.minX)); x <= Math.min(width - 1, Math.ceil(bb.maxX)); x += step) {
        // sample at pixel centers to avoid boundary ambiguity
        if (!G.pointInPolygon({x: x + 0.5, y: y + 0.5}, contour, 0.01, bb)) continue;
        inside++;
        if (mask[y * width + x]) dark++;
      }
    }
    return inside ? dark / inside : 1;
  }

  /* ============================================================
     3. Interior region (for stroke outlines)
     ============================================================ */

  /**
   * Mask of background pixels NOT connected to the image border —
   * i.e. the region enclosed by a stroke ring. Flood-fills the
   * background starting from every border pixel.
   */
  function interiorMask(mask, width, height) {
    const n = width * height;
    const outside = new Uint8Array(n);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = y * width + x;
      if (mask[i] || outside[i]) return;
      outside[i] = 1;
      stack.push(i);
    };
    for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
    for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % width, y = (i / width) | 0;
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
    const interior = new Uint8Array(n);
    for (let i = 0; i < n; i++) interior[i] = (mask[i] === 0 && outside[i] === 0) ? 1 : 0;
    return interior;
  }

  /* ============================================================
     4. Contour → clean polygon
     ============================================================ */

  /**
   * Simplify a raw contour loop into a clean OPEN polygon ring.
   * RDP (the approxPolyDP equivalent, shared with freehand drawing)
   * removes redundant pixels; simplifyPolygon drops collinear points.
   * Returns null when the contour is degenerate.
   */
  function contourToPolygon(contour, simplifyPx) {
    if (!contour || contour.length < 4) return null;
    // drop consecutive duplicates and the closing duplicate of the loop
    const open = [];
    for (const p of contour) {
      const last = open[open.length - 1];
      if (last && last.x === p.x && last.y === p.y) continue;
      open.push({ x: p.x, y: p.y });
    }
    if (open.length >= 2 &&
        open[0].x === open[open.length - 1].x && open[0].y === open[open.length - 1].y) {
      open.pop();
    }
    if (open.length < 3) return null;
    const simplified = G.rdpSimplify(open, simplifyPx);
    const cleaned = G.simplifyPolygon(simplified);
    return cleaned.length >= 3 ? cleaned : null;
  }

  /* ============================================================
     5. Downscaling & main entry
     ============================================================ */

  /** Nearest-neighbor downsample of an RGBA image. */
  function downscale(image, scale) {
    const W = Math.max(1, Math.round(image.width * scale));
    const H = Math.max(1, Math.round(image.height * scale));
    const data = new Uint8ClampedArray(W * H * 4);
    const s = image.width / W;
    for (let y = 0; y < H; y++) {
      const sy = Math.min(image.height - 1, Math.round(y * s));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(image.width - 1, Math.round(x * s));
        const si = (sy * image.width + sx) * 4;
        const di = (y * W + x) * 4;
        data[di] = image.data[si];
        data[di + 1] = image.data[si + 1];
        data[di + 2] = image.data[si + 2];
        data[di + 3] = image.data[si + 3];
      }
    }
    return { data, width: W, height: H };
  }

  /**
   * Extract the largest shape from an image and fit it to a target canvas.
   *
   * image: { data: Uint8ClampedArray (RGBA), width, height }
   * opts:  { targetW, targetH, maxDim, simplifyPx }
   *
   * Auto-detects the shape kind by fill ratio:
   *   - 'filled' — foreground fills the contour interior (a solid shape)
   *   - 'stroke' — foreground is a thin ring (an outlined drawing); the
   *                polygon then follows the INNER edge of the ring
   * Returns { polygon, kind } with polygon in canvas coordinates
   * (no Y flip — both the image and the canvas are y-down), or null
   * when no usable shape is found.
   */
  function extractPolygon(image, opts) {
    opts = opts || {};
    const maxDim = opts.maxDim || 1200;
    const simplifyPx = opts.simplifyPx || 2;
    const targetW = opts.targetW || 800;
    const targetH = opts.targetH || 600;

    // Cap the processing resolution for speed.
    let src = image;
    const longSide = Math.max(image.width, image.height);
    if (longSide > maxDim) src = downscale(image, maxDim / longSide);

    const W = src.width, H = src.height;
    if (W < 8 || H < 8) return null;

    const gray = gaussianBlur(toGray(src), W, H, 1.5);
    const mask = binarizeDark(gray, otsuThreshold(gray));

    const outer = largestContour(marchingSquares(mask, W, H));
    if (!outer) return null;

    // Reject tiny noise blobs (e.g. specks, compression artifacts).
    const bb = G.bbox(outer);
    const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
    if (span < Math.max(16, 0.15 * Math.min(W, H))) return null;

    const ratio = fillRatio(mask, W, H, outer);
    let kind, poly;
    if (ratio >= 0.5) {
      kind = 'filled';
      poly = contourToPolygon(outer, simplifyPx);
    } else {
      kind = 'stroke';
      // Follow the inner edge of the stroke ring (closer to the drawn
      // line); fall back to the outer contour if the ring is open.
      const inner = largestContour(marchingSquares(interiorMask(mask, W, H), W, H));
      poly = contourToPolygon(inner || outer, simplifyPx);
    }
    if (!poly) return null;

    const fitted = G.fitToCanvas(poly, targetW, targetH, 0.8, false);
    return { polygon: fitted, kind };
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.Image = {
    toGray, gaussianBlur, otsuThreshold, binarizeDark,
    marchingSquares, stitchEdges, largestContour, fillRatio,
    interiorMask, contourToPolygon, downscale, extractPolygon,
  };
})(window);
