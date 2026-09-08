/* ============================================================
   app.js — The controller: state, DOM, interaction, pipeline
   ============================================================
   This is the ONLY file that touches the DOM and the `state`
   object. It coordinates the pure modules loaded before it:

     Constants — tuning parameters & colors
     Geometry  — vector math & geometric predicates
     Grid      — grid generation & snapping
     Clipping  — cell clipping
     Mesh      — mesh construction
     Renderer  — canvas drawing
     Export    — TXT output
     Demo      — sample polygon data

   Read order: state -> pipeline -> interaction -> wiring -> init.
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------- Module aliases (short local names) ---------- */
  const Constants = global.MeshStudio.Constants;
  const G = global.MeshStudio.Geometry;          // Geometry
  const V = G.V;                                 // vector helpers
  const Grid = global.MeshStudio.Grid;           // Grid
  const Mesh = global.MeshStudio.Mesh;           // Mesh
  const Renderer = global.MeshStudio.Renderer;   // Renderer
  const Export = global.MeshStudio.Export;       // Export
  const Demo = global.MeshStudio.Demo;           // Demo
  const ImageProc = global.MeshStudio.Image;     // Image (bitmap → contour)

  const FREEHAND_MIN_DIST = Constants.FREEHAND_MIN_DIST;
  const FREEHAND_EPSILON  = Constants.FREEHAND_EPSILON;
  const MIN_POLYGON_AREA  = Constants.MIN_POLYGON_AREA;

  /* ============================================================
     1. DOM references
     ============================================================ */
  const canvas      = document.getElementById('canvas');
  const ctx         = canvas.getContext('2d');
  const stage       = document.getElementById('stage');
  const segButtons  = Array.from(document.querySelectorAll('#gridTypeSeg .seg'));
  const drawModeButtons = Array.from(document.querySelectorAll('#drawModeSeg .seg'));
  const cellSizeEl  = document.getElementById('cellSize');
  const snapEl      = document.getElementById('snapToggle');
  const snapRow     = document.getElementById('snapRow');
  const btnDemo     = document.getElementById('btnDemo');
  const btnClear    = document.getElementById('btnClear');
  const btnResetView = document.getElementById('btnResetView');
  const btnExport   = document.getElementById('btnExport');
  const btnPanels   = document.getElementById('btnPanels');
  const btnSolvePanels = document.getElementById('btnSolvePanels');     // solve-phase top bar
  const btnSolveResetView = document.getElementById('btnSolveResetView');
  const importModal = document.getElementById('importModal');
  const btnImportPick  = document.getElementById('btnImportPick');
  const btnImportClose = document.getElementById('btnImportClose');
  const fileInput   = document.getElementById('fileInput');
  const exStroke    = document.getElementById('exStroke');
  const exFilled    = document.getElementById('exFilled');
  const hintBar     = document.getElementById('hintBar');
  const toastEl     = document.getElementById('toast');
  const cellSizeVal = document.getElementById('cellSizeVal');
  const statNodes   = document.getElementById('statNodes');
  const statElems   = document.getElementById('statElems');
  const statSamples = document.getElementById('statSamples');
  const btnPhase    = document.getElementById('btnPhase');
  const btnSolver   = document.getElementById('btnSolver');
  const controlsPanel = document.getElementById('controlsPanel');
  const btnAddPointLoad = document.getElementById('btnAddPointLoad');
  const btnAddDistLoad  = document.getElementById('btnAddDistLoad');
  const btnAddSupport   = document.getElementById('btnAddSupport');
  const bcList      = document.getElementById('bcList');
  const condModal   = document.getElementById('condModal');
  const condTitle   = document.getElementById('condTitle');
  const condName    = document.getElementById('condName');
  const condFx      = document.getElementById('condFx');
  const condFy      = document.getElementById('condFy');
  const condVec     = document.getElementById('condVec');
  const condTypeRow = document.getElementById('condTypeRow');
  const condTypeSegButtons = Array.from(document.querySelectorAll('#condTypeSeg .seg'));
  const condCount   = document.getElementById('condCount');
  const btnCondOk   = document.getElementById('btnCondOk');
  const btnCondCancel = document.getElementById('btnCondCancel');
  // Touch adaptation (coarse-pointer devices get visible equivalents of
  // Enter / Backspace / Esc; zoom is pinch-only; desktop is untouched).
  const hintText      = document.getElementById('hintText');
  const touchActions  = document.getElementById('touchActions');
  const btnTouchDone  = document.getElementById('btnTouchDone');
  const btnTouchUndo  = document.getElementById('btnTouchUndo');
  const btnTouchCancel = document.getElementById('btnTouchCancel');
  const solverCondModalEl = document.getElementById('solverCondModal');

  /* ============================================================
     2. Application state — the single source of truth
     ============================================================ */
  const state = {
    gridType: 'square',
    cellSize: 40,
    snap: true,
    drawMode: 'point',      // 'point' (click-to-point) | 'freehand' (drag)
    freehandActive: false,  // currently tracing a freehand stroke
    drawing: [],            // vertices being placed (in-progress polygon)
    polygon: null,          // finalized polygon (array of {x,y}) or null
    cells: [],              // generated background grid (array of polygons)
    viewCells: [],          // background lattice for the CURRENT view (fills the viewport)
    mesh: null,             // { nodes, elements, interiorCount, boundaryCount }
    samples: [],            // polygon vertices used as the clip boundary
    phase: 'mesh',          // 'mesh' (draw/edit) | 'bc' (conditions) | 'solve'
    pointLoads: [],         // { name, nodeIds[], fx, fy }
    distLoads: [],          // { name, edges: [[a,b],...], fx, fy }
    supports: [],           // { name, type: 'fixed'|'hinge', nodeIds[] }
    allEdges: [],           // cached Mesh.allEdges (boundary + interior) for the current mesh
    bcSel: null,            // live selection: { kind, nodes:Set, edges:Map, box, ... }
    cursor: null,           // live pointer position (world coords)
    view: { zoom: 1, ox: 0, oy: 0 },  // view transform: screen = world*zoom + o
    dpr: 1,
    w: 0, h: 0,
    solution: null,     // solver results (future): { u, flux, ... } or null
    renderHooks: [],    // extra draw callbacks run by renderer ON TOP (BC markers, …)
    underlayHooks: [],  // extra draw callbacks run BELOW the mesh (heatmap, …)
    meshPlain: false,   // solve phase: draw the mesh plain — no fills, no
                        // interior cell edges, only the outer boundary outline
    hideMesh: false,    // legacy static flag; see hideMeshFn below
    hideMeshFn: null,   // optional () => bool — dynamic mesh-hiding predicate.
                        // The renderer re-evaluates it EVERY frame, so toggling
                        // e.g. the elastic "Show deformation" switch takes
                        // effect immediately (no event plumbing needed).
  };

  const renderer = Renderer.createRenderer(ctx);

  /**
   * Phase-plugin registry: future solver controllers (js/solver/<problem>/)
   * register pointer/keyboard/lifecycle handlers for a phase here, so the
   * app can hand the phase over without app.js knowing any solver details.
   */
  const phaseHandlers = {};

  /* ============================================================
     3. Pipeline — regenerate grid, mesh, readouts, canvas
     ============================================================ */

  function refresh() {
    // The grid covers the canvas plus a two-cell margin, so cells can
    // never be "missing" near the edges of the drawn polygon.
    const m = state.cellSize * 2;
    const rect = { minX: -m, minY: -m, maxX: state.w + m, maxY: state.h + m };
    state.cells = Grid.generateCells(state.gridType, rect, state.cellSize);
    // Node ids change whenever the mesh is rebuilt, so boundary conditions
    // (which reference node/edge ids) are invalidated. Cancel live selection.
    const hadConditions = state.pointLoads.length || state.distLoads.length || state.supports.length;
    state.pointLoads = [];
    state.distLoads = [];
    state.supports = [];
    state.solution = null;   // solved results reference node ids too — invalidate with the mesh
    if (state.bcSel) cancelBcSelect();
    computeMesh();
    state.allEdges = state.mesh ? Mesh.allEdges(state.mesh) : [];
    updateViewGrid();
    updateReadouts();
    renderBcList();
    renderer.render(state);
    syncTouchUI(); // refresh() renders directly — keep the touch bar in sync
    // A rebuilt mesh invalidates any solved results (state.solution is
    // cleared above); the solver legend must drop its stale numeric range.
    if (global.MeshStudio.SolverUI && typeof global.MeshStudio.SolverUI.refreshLegend === 'function') {
      global.MeshStudio.SolverUI.refreshLegend();
    }
    if (hadConditions) showToast('Mesh changed — boundary conditions cleared');
  }

  /**
   * Regenerate the background lattice so it fills whatever is currently
   * visible (the mesh itself is built once from state.cells and never
   * changes with the view). The extent is capped so extreme zoom-out
   * cannot explode the cell count.
   */
  function updateViewGrid() {
    const v = state.view;
    const s = state.cellSize;
    const m = s * 2;
    let minX = -v.ox / v.zoom - m, maxX = (state.w - v.ox) / v.zoom + m;
    let minY = -v.oy / v.zoom - m, maxY = (state.h - v.oy) / v.zoom + m;
    const maxSpan = s * 130; // cap: at most ~130 x 130 = 17k cells (square)
    if (maxX - minX > maxSpan) {
      const cx = (minX + maxX) / 2;
      minX = cx - maxSpan / 2; maxX = cx + maxSpan / 2;
    }
    if (maxY - minY > maxSpan) {
      const cy = (minY + maxY) / 2;
      minY = cy - maxSpan / 2; maxY = cy + maxSpan / 2;
    }
    state.viewCells = Grid.generateCells(state.gridType, { minX, minY, maxX, maxY }, s);
  }

  function computeMesh() {
    const poly = state.polygon;
    if (!poly || poly.length < 3) {
      state.mesh = null;
      state.samples = [];
      return;
    }
    // Scale-adaptive spatial tolerance for classification and clipping.
    const spatialEps = state.cellSize * Constants.EPS_SCALE;
    // Clip directly against the polygon vertices — the boundary geometry is
    // fully defined by them, so no resampling is needed.
    state.samples = poly;
    state.mesh = Mesh.buildMesh(state.cells, poly, poly, spatialEps);
  }

  function updateReadouts() {
    cellSizeVal.textContent = Export.fmt(state.cellSize) + ' px';
    statNodes.textContent = state.mesh ? state.mesh.nodes.length : 0;
    statElems.textContent = state.mesh ? state.mesh.elements.length : 0;
    statSamples.textContent = state.samples.length;
  }

  /* ============================================================
     4. UI helpers
     ============================================================ */

  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2600);
  }

  /** Hide the floating panels while a polygon is being drawn (focus mode). */
  function syncPanels() {
    const drawing = state.drawing.length > 0 || state.freehandActive;
    stage.classList.toggle('drawing', drawing);
    // Panel toggle is unavailable mid-drawing — both the pre-processing
    // button and the solve-phase twin follow the same state.
    [btnPanels, btnSolvePanels].forEach(b => { if (b) b.disabled = drawing; });
  }

  /** Manual show/hide toggle for the floating panels. */
  let panelsHidden = false;
  function togglePanels() {
    panelsHidden = !panelsHidden;
    stage.classList.toggle('ui-off', panelsHidden);
    const label = panelsHidden ? 'Show Panels' : 'Hide Panels';
    [btnPanels, btnSolvePanels].forEach(b => { if (b) b.textContent = label; });
  }

  const HINT_POINT    = 'Click to place polygon vertices · double-click, Enter, or click the first point to close';
  const HINT_FREEHAND = 'Click and drag to trace a shape · release to close it automatically';
  const HINT_DONE     = 'Mesh generated — adjust the controls or press Clear to redraw';
  const HINT_BC_IDLE  = 'Boundary-condition phase — mesh is locked. Add loads & supports from the panel.';
  const HINT_BC_SELECT = 'Click nodes/edges or drag a box to select · Enter to confirm · Esc to cancel';
  const HINT_SOLVER   = 'Solver phase — mesh & boundary conditions are locked. Pick a problem, set BCs, press Solve.';

  /* ============================================================
     4.5  Touch capability & adaptive controls (Apple-style)
     Desktop (fine pointer + keyboard) keeps its exact UX untouched.
     On coarse/touch devices — or the first real touch on hybrids —
     we ADD: a contextual bottom bar (✓/↩/✕ acting as Enter/Backspace/
     Esc), zoom +/- buttons and two-finger pinch zoom on the canvas.
     ============================================================ */
  const canMatch = typeof window.matchMedia === 'function';
  let touchUI = canMatch ? window.matchMedia('(pointer: coarse)').matches : false;

  function enableTouchUI() {
    if (touchUI) return;
    touchUI = true;
    if (document.body) document.body.classList.add('touch-ui');
    syncTouchUI();
    setHint(); // re-render the current hint without Enter/Esc wording
  }
  // Robust enablement: media queries alone can misclassify Apple/Safari
  // setups (Request-Desktop-Site mode, iPads with trackpads/mice reporting
  // pointer: fine, …). ANY real touch therefore enables the touch UI — the
  // probes run in the CAPTURE phase so even the very first tap gets the
  // adapted bar & hints.
  {
    const probePtr = e => { if (e.pointerType === 'touch') enableTouchUI(); };
    const probeTouch = () => enableTouchUI();
    window.addEventListener('pointerdown', probePtr, { capture: true, passive: true });
    window.addEventListener('touchstart', probeTouch, { capture: true, passive: true });
  }

  /** Rewrite keyboard-centric hint text for touch screens. */
  function localizeTouch(s) {
    return s
      .replace(/\bEnter\b/g, '✓')
      .replace(/\bEsc\b/g, '✕')
      .replace(/Escape/g, '✕')
      .replace(/\bBackspace\b/g, '↩')
      .replace(/double-click/g, 'double-tap')
      .replace(/^Click/, 'Tap');
  }

  /* ---------- Two-finger pinch zoom (touch) ---------- */
  const touchPts = new Map(); // pointerId → {x, y}
  let pinchOn = false;
  let pinchLast = null;       // {dist, mx, my} of the previous move
  const touchPtr = e => touchUI && e.pointerType === 'touch';

  function cancelPinchSideEffects() {
    // A second finger landing must not corrupt in-progress single-touch
    // gestures (freehand stroke / BC rubber-band drag).
    if (state.freehandActive) { state.freehandActive = false; state.drawing = []; syncPanels(); }
    if (state.bcSel) { cancelBcBox(); if (state.bcSel) state.bcSel.dragStart = null; }
  }

  /** Returns true when the pointer event was consumed by pinch handling. */
  function handlePinchEvent(type, e) {
    if (!touchPtr(e)) return false;
    if (type === 'down') {
      touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPts.size === 2) {
        pinchOn = true;
        const [p1, p2] = [...touchPts.values()];
        pinchLast = {
          dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
          mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2,
        };
        cancelPinchSideEffects();
        return true;
      }
      return false; // first finger → normal single-touch logic runs
    }
    if (type === 'move') {
      if (!touchPts.has(e.pointerId)) return false;
      touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinchOn || touchPts.size < 2 || !pinchLast) return false;
      const [p1, p2] = [...touchPts.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const v = state.view;
      const factor = pinchLast.dist > 0 ? dist / pinchLast.dist : 1;
      const nz = Math.max(1, Math.min(32, v.zoom * factor));
      // anchor the world point that was under the previous midpoint
      const wx = (pinchLast.mx - v.ox) / v.zoom;
      const wy = (pinchLast.my - v.oy) / v.zoom;
      v.zoom = nz;
      v.ox = mx - wx * nz;
      v.oy = my - wy * nz;
      pinchLast = { dist, mx, my };
      updateViewGrid();
      scheduleRender();
      return true;
    }
    // 'up' / 'cancel'
    touchPts.delete(e.pointerId);
    if (pinchOn && touchPts.size < 2) { pinchOn = false; pinchLast = null; return true; }
    return false;
  }

  /**
   * Bottom pill (single element) two-mode sync: idle → hint TEXT (dark);
   * while a drawing / selection session is active the pill morphs into the
   * flat symbol buttons (light). Runs after every scheduled render, so any
   * state change re-syncs it idempotently.
   */
  let touchSig = '';
  function syncTouchUI() {
    if (document.body) document.body.classList.toggle('touch-ui', touchUI);
    if (!hintBar || !touchUI) return;
    const modalOpen = importModal.classList.contains('visible') ||
                      condModal.classList.contains('visible') ||
                      solverCondModalEl.classList.contains('visible');
    const session = !modalOpen && (
      (state.phase === 'mesh' && (state.drawing.length || state.freehandActive)) ||
      (state.phase === 'bc' && state.bcSel) ||
      (state.phase === 'solve' && (() => {
        const SB = global.MeshStudio && global.MeshStudio.SolverBC;
        return !!(SB && typeof SB.selecting === 'function' && SB.selecting());
      })())
    );
    const undoOn = !!(state.phase === 'mesh' && state.drawMode === 'point' && state.drawing.length > 0);
    const sig = (session ? '1' : '0') + ':' + (undoOn ? '1' : '0') + (modalOpen ? ':m' : '');
    if (sig === touchSig) return;
    touchSig = sig;
    hintBar.classList.toggle('is-actions', session); // text ⇄ buttons via CSS
    btnTouchUndo.style.display = (session && undoOn) ? '' : 'none';
    btnTouchDone.style.display = session ? '' : 'none';
    btnTouchCancel.style.display = session ? '' : 'none';
  }

  function setHint(text) {
    let t;
    if (text) t = text;
    else if (state.phase === 'solve') t = HINT_SOLVER;
    else if (state.phase === 'bc') t = HINT_BC_IDLE;
    else if (state.polygon) t = HINT_DONE;
    else t = state.drawMode === 'freehand' ? HINT_FREEHAND : HINT_POINT;
    if (hintText) hintText.textContent = touchUI ? localizeTouch(t) : t;
    else if (hintBar) hintBar.textContent = touchUI ? localizeTouch(t) : t;
  }

  /* ============================================================
     5. Interaction (pointer & keyboard)
     ============================================================ */

  /**
   * Pointer position in WORLD coordinates (screen clamped to the canvas,
   * then inverted through the view transform). Points are stored in world
   * space, so panning/zooming never changes the mesh data — only the view.
   */
  function toLocal(e) {
    const r = canvas.getBoundingClientRect();
    // Clamp in screen space so clicks/drags outside the canvas cannot place
    // invisible off-canvas vertices (especially during captured freehand).
    const sx = Math.max(0, Math.min(state.w, e.clientX - r.left));
    const sy = Math.max(0, Math.min(state.h, e.clientY - r.top));
    const v = state.view;
    return {
      x: (sx - v.ox) / v.zoom,
      y: (sy - v.oy) / v.zoom,
    };
  }

  /** Convert a screen-space distance (px) into world units. */
  function worldDist(d) {
    return d / state.view.zoom;
  }

  /**
   * Route a pointer/keyboard event to the active phase's registered plugin
   * (solver blocks etc.). Returns true when the plugin consumed the event;
   * the built-in phase logic below then does not run.
   */
  function phaseHandler(name, e) {
    const h = phaseHandlers[state.phase];
    if (h && typeof h[name] === 'function') { h[name](e); return true; }
    return false;
  }

  /**
   * Mouse-wheel zoom, centered on the cursor.
   * Zoom-in is unlimited up to 32x for inspecting details; zoom-out is
   * clamped at 1x so the view never shows beyond the drawing area (the
   * canvas), which keeps the background lattice fully covering the view.
   */
  function onWheel(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const v = state.view;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const nz = Math.max(1, Math.min(32, v.zoom * factor));
    // Keep the world point under the cursor fixed while zooming.
    const wx = (sx - v.ox) / v.zoom, wy = (sy - v.oy) / v.zoom;
    v.zoom = nz;
    v.ox = sx - wx * nz;
    v.oy = sy - wy * nz;
    updateViewGrid();   // keep the background lattice covering the view
    scheduleRender();
  }

  /** Restore the initial 100% view. */
  function resetView() {
    state.view.zoom = 1;
    state.view.ox = 0;
    state.view.oy = 0;
    updateViewGrid();
    scheduleRender();
  }

  /**
   * Detect the second press of a double-click so that press does not
   * place a vertex / start a stroke — the dblclick event that follows
   * closes the polygon. (Without this, closing by double-click leaves a
   * redundant spike vertex at the close point.)
   */
  let lastPress = null; // { time, x, y } of the previous press
  function isSecondClickOfDoubleClick(e, p) {
    const now = e.timeStamp;
    const wasQuick = lastPress && (now - lastPress.time < 350);
    const wasClose = lastPress && (V.dist(p, lastPress) < worldDist(8));
    lastPress = { time: now, x: p.x, y: p.y };
    return wasQuick && wasClose;
  }

  function onPointerMove(e) {
    if (handlePinchEvent('move', e)) return; // pinch consumes multi-touch moves
    state.cursor = toLocal(e);

    if (phaseHandler('pointermove', e)) return;
    if (state.phase === 'bc') { bcPointerMove(e); return; }

    if (state.freehandActive) {
      // Sample the stroke, thinning dense points by a minimum spacing
      // (a screen-space distance, converted to world units).
      const pts = state.drawing;
      const last = pts[pts.length - 1];
      if (!last || V.dist(state.cursor, last) >= worldDist(FREEHAND_MIN_DIST)) {
        pts.push({ x: state.cursor.x, y: state.cursor.y });
      }
      scheduleRender();
    } else if (state.drawing.length) {
      scheduleRender();
    }
  }

  function onPointerDown(e) {
    if (handlePinchEvent('down', e)) return; // 2nd finger → pinch session
    if (phaseHandler('pointerdown', e)) return;
    if (state.phase === 'bc') { bcPointerDown(e); return; }
    if (state.polygon) return; // polygon finalized — use Clear to redraw

    if (state.drawMode === 'freehand') {
      // Start a freehand stroke (raw path, no grid snapping).
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      }
      const p = toLocal(e);
      if (isSecondClickOfDoubleClick(e, p)) return; // don't start a 2nd stroke
      state.freehandActive = true;
      state.drawing = [p];
      syncPanels();
      scheduleRender();
      return;
    }

    // Click-to-point mode.
    const p = Grid.snapPoint(toLocal(e), state.gridType, state.cellSize, state.snap);
    if (isSecondClickOfDoubleClick(e, p)) return; // dblclick will close
    const pts = state.drawing;
    if (pts.length >= 3 && V.dist(p, pts[0]) < worldDist(12)) { finishPolygon(); return; }
    if (pts.length && G.snapKey(p) === G.snapKey(pts[pts.length - 1])) return;
    pts.push(p);
    syncPanels();
    scheduleRender();
  }

  function onPointerUp(e) {
    if (handlePinchEvent('up', e)) return; // lift after pinch → ignore
    if (phaseHandler('pointerup', e)) return;
    if (state.phase === 'bc') { bcPointerUp(); return; }
    if (state.freehandActive) finishFreehand();
  }

  function onPointerCancel(e) {
    if (handlePinchEvent('cancel', e)) return;
    if (phaseHandler('pointercancel', e)) return;
    if (state.phase === 'bc') { cancelBcBox(); return; }
    if (state.freehandActive) {
      state.freehandActive = false;
      state.drawing = [];
      syncPanels();
      scheduleRender();
    }
  }

  function onDblClick(e) {
    e.preventDefault();
    if (state.polygon || state.drawMode === 'freehand') return;
    finishPolygon();
  }

  function onKeydown(e) {
    if (phaseHandler('keydown', e)) return;
    if (state.phase === 'bc') {
      // Boundary-condition phase: Enter confirms the selection, Esc cancels.
      if (e.key === 'Enter') {
        if (e.target && e.target.tagName === 'BUTTON') e.preventDefault();
        if (state.bcSel) openConditionModal(state.bcSel.kind);
      } else if (e.key === 'Escape') {
        if (importModal.classList.contains('visible')) closeImportModal();
        else if (condModal.classList.contains('visible')) closeConditionModal();
        else cancelBcSelect();
      }
      return;
    }

    if (e.key === 'Enter') {
      // If a button has focus, Enter would ALSO re-click that button;
      // suppress the native re-click so Enter always means "finish".
      if (e.target && e.target.tagName === 'BUTTON') e.preventDefault();
      if (!state.polygon && state.drawMode === 'point') finishPolygon();
    } else if (e.key === 'Backspace') {
      if (state.drawMode === 'point' && state.drawing.length) { state.drawing.pop(); syncPanels(); scheduleRender(); }
    } else if (e.key === 'Escape') {
      if (importModal.classList.contains('visible')) closeImportModal();
      else clearPolygon();
    }
  }

  /* ============================================================
     6. Polygon lifecycle
     ============================================================ */

  /** Finalize a set of raw points into the working polygon (both modes). */
  function finalizePolygon(points) {
    if (state.phase === 'bc') return; // mesh is locked during the BC phase
    if (!points || points.length < 3) {
      showToast('Not enough points to form a polygon');
      return;
    }
    const poly = G.simplifyPolygon(points);
    if (poly.length < 3) { showToast('Polygon is degenerate — draw a larger shape'); return; }
    if (Math.abs(G.signedArea(poly)) < MIN_POLYGON_AREA) { showToast('Polygon is too small — draw a larger shape'); return; }
    if (!G.isSimplePolygon(poly)) { showToast('Polygon self-intersects — press Clear and redraw'); return; }

    state.polygon = poly;
    state.drawing = [];
    state.freehandActive = false;
    state.cursor = null;
    syncPanels();
    setHint();
    resetView();   // a fresh domain should be seen at 100%
    refresh();
  }

  function finishPolygon() {
    finalizePolygon(state.drawing);
  }

  function finishFreehand() {
    state.freehandActive = false;
    const pts = state.drawing;
    state.drawing = [];
    // Lightweight simplification: samples were already distance-thinned during
    // capture; RDP removes the remaining collinear/redundant points.
    finalizePolygon(G.rdpSimplify(pts, FREEHAND_EPSILON));
  }

  function clearPolygon() {
    if (state.phase === 'bc') return; // mesh is locked during the BC phase
    state.polygon = null;
    state.drawing = [];
    syncPanels();
    state.freehandActive = false;
    state.mesh = null;
    state.samples = [];
    state.cursor = null;
    setHint();
    resetView();
    refresh();
  }

  /* ============================================================
     7. Demo & export
     ============================================================ */

  function loadDemo() {
    if (state.phase === 'bc') return; // mesh is locked during the BC phase
    state.drawing = [];
    state.polygon = G.simplifyPolygon(Demo.buildPolygon(state.w, state.h));
    state.cursor = null;
    setHint();
    resetView();
    refresh();
  }

  function exportTxt() {
    if (!state.mesh || !state.mesh.elements.length) {
      showToast('Nothing to export — draw a polygon first');
      return;
    }
    const text = Export.buildTxt(state.mesh, { height: state.h, fit: Constants.EXPORT_FIT }, {
      pointLoads: state.pointLoads,
      distLoads: state.distLoads,
      supports: state.supports,
    });
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mesh.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Exported mesh.txt (' + state.mesh.nodes.length + ' nodes, ' + state.mesh.elements.length + ' elements)');
  }

  /* ============================================================
     8. Image import (upload → contour → polygon)
     ============================================================ */

  /** Draw one example image (stroke or filled) inside the modal. */
  function drawImportExample(canvas, filled) {
    const c = canvas.getContext('2d');
    const pts = Demo.buildPolygon(canvas.width, canvas.height);
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    const path = new Path2D();
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    path.closePath();
    if (filled) {
      c.fillStyle = '#1d1d1f';
      c.fill(path);
    } else {
      c.strokeStyle = '#1d1d1f';
      c.lineWidth = 4;
      c.lineJoin = 'round';
      c.stroke(path);
    }
  }

  function openImportModal() {
    drawImportExample(exStroke, false);
    drawImportExample(exFilled, true);
    importModal.classList.add('visible');
    syncTouchUI(); // modal overlays the action bar → hide it
  }

  function closeImportModal() {
    importModal.classList.remove('visible');
    syncTouchUI();
  }

  function onFileSelected() {
    if (state.phase === 'bc') return; // mesh is locked during the BC phase
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    loadImageFile(file);
  }

  /**
   * Read an image file, run the contour pipeline, and feed the result
   * into the normal polygon flow (finalizePolygon validates it and
   * regenerates the mesh).
   */
  function loadImageFile(file) {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      try {
        // Cap the processing resolution for speed.
        const maxDim = 1200;
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, w, h);
        const imageData = cx.getImageData(0, 0, w, h);

        const result = ImageProc.extractPolygon(imageData, {
          targetW: state.w,
          targetH: state.h,
        });
        if (!result) {
          showToast('No shape detected — try a clearer image');
          return;
        }
        // Route through the standard validation (area, simplicity, …).
        finalizePolygon(result.polygon);
        if (state.polygon) {
          showToast('Imported ' + (result.kind === 'filled' ? 'filled shape' : 'stroke outline') +
                    ' (' + state.polygon.length + ' vertices)');
        }
      } catch (err) {
        console.error(err);
        showToast('Image processing failed');
      } finally {
        URL.revokeObjectURL(url);
        closeImportModal();
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showToast('Could not read that image');
      closeImportModal();
    };
    img.src = url;
  }

  /* ============================================================
     9. Boundary conditions (loads & supports)
     ============================================================ */

  let condState = null; // { kind } while the condition modal is open

  /** Switch between phases: 'mesh' (draw/edit) | 'bc' (conditions) | 'solve'. */
  function setPhase(p) {
    if (p === state.phase) return;
    if ((p === 'bc' || p === 'solve') && (!state.mesh || !state.mesh.nodes.length)) {
      showToast('Draw a polygon first to create a mesh');
      return;
    }
    // Let the phase being left clean up after itself (solver blocks etc.).
    const exiting = phaseHandlers[state.phase];
    if (exiting && exiting.exit) exiting.exit();
    state.phase = p;
    stage.classList.toggle('bc', p === 'bc');
    stage.classList.toggle('solve', p === 'solve');
    document.body.classList.toggle('solve-mode', p === 'solve'); // hides top-bar actions
    cancelBcSelect();
    syncPhaseControls();
    syncSolverButton();
    setHint();
    scheduleRender();
    // Let the phase being entered set up (solver blocks etc.).
    const entering = phaseHandlers[p];
    if (entering && entering.enter) entering.enter();
  }

  /** Lock/unlock the mesh controls and update the phase button. */
  function syncPhaseControls() {
    const locked = state.phase !== 'mesh';
    btnPhase.textContent = locked ? 'Edit Mesh' : 'Set BCs';
    btnPhase.classList.toggle('btn-primary', locked);
    btnDemo.disabled = locked;
    btnClear.disabled = locked;
    controlsPanel.classList.toggle('locked', locked);
    segButtons.forEach(b => { b.disabled = locked; });
    drawModeButtons.forEach(b => { b.disabled = locked; });
    cellSizeEl.disabled = locked;
    snapEl.disabled = locked || state.drawMode === 'freehand';
  }

  /**
   * The solver launcher (bottom-right) toggles between the solve phase and
   * the phase the user came from ('mesh' or 'bc').
   */
  let solverReturnPhase = 'mesh';
  function syncSolverButton() {
    const active = state.phase === 'solve';
    btnSolver.textContent = active ? 'Exit Solver' : 'Solver Start';
    btnSolver.classList.toggle('btn-primary', active);
    btnSolver.classList.toggle('btn-ghost', !active);
  }
  function toggleSolver() {
    if (state.phase === 'solve') { setPhase(solverReturnPhase); return; }
    solverReturnPhase = state.phase;
    setPhase('solve');
  }

  /* ---------- Selection ---------- */

  /** Begin a live selection for a new condition group. */
  function startBcSelect(kind) {
    if (state.phase !== 'bc') return;
    cancelBcSelect();
    state.bcSel = {
      kind,                       // 'pointload' | 'distload' | 'support'
      nodes: new Set(),           // selected node ids
      edges: new Map(),           // selected boundary edges: key 'a_b' -> [a, b]
      box: null,                  // rubber-band rect while dragging
      dragStart: null,
      dragging: false,
    };
    setHint(HINT_BC_SELECT);
    scheduleRender();
  }

  function cancelBcSelect() {
    if (!state.bcSel) return;
    state.bcSel = null;
    setHint();
    scheduleRender();
  }

  /** Abort an in-progress rubber-band drag (pointercancel). */
  function cancelBcBox() {
    if (state.bcSel) {
      state.bcSel.dragStart = null;
      state.bcSel.dragging = false;
      state.bcSel.box = null;
      scheduleRender();
    }
  }

  function bcPointerDown(e) {
    if (!state.bcSel) return;
    const p = toLocal(e);
    state.bcSel.dragStart = { x: p.x, y: p.y };
    state.bcSel.dragging = false;
    state.bcSel.box = null;
  }

  function bcPointerMove(e) {
    if (!state.bcSel || !state.bcSel.dragStart) return;
    if (!state.bcSel.dragging && V.dist(state.bcSel.dragStart, state.cursor) > worldDist(Constants.BC_DRAG_THRESHOLD)) {
      state.bcSel.dragging = true;
    }
    if (state.bcSel.dragging) {
      const a = state.bcSel.dragStart, b = state.cursor;
      state.bcSel.box = {
        minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
      };
    }
    scheduleRender();
  }

  function bcPointerUp() {
    if (!state.bcSel) return;
    if (state.bcSel.dragging) {
      applyBoxSelection(state.bcSel.box);
      state.bcSel.box = null;
    } else {
      clickSelect(state.bcSel.kind, state.cursor);
    }
    state.bcSel.dragStart = null;
    state.bcSel.dragging = false;
    scheduleRender();
  }

  /** Click selection: nearest node (point load / support) or boundary edge. */
  function clickSelect(kind, p) {
    const mesh = state.mesh;
    if (!mesh) return;
    if (kind === 'distload') {
      const idx = Mesh.nearestEdge(state.allEdges, mesh, p, worldDist(Constants.BC_SELECT_RADIUS));
      if (idx < 0) { showToast('No mesh edge near the click'); return; }
      const [a, b] = state.allEdges[idx];
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (state.bcSel.edges.has(key)) state.bcSel.edges.delete(key);
      else state.bcSel.edges.set(key, [a, b]);
    } else {
      const id = Mesh.nearestNode(mesh, p, worldDist(Constants.BC_SELECT_RADIUS));
      if (id < 0) { showToast('No node near the click'); return; }
      if (state.bcSel.nodes.has(id)) state.bcSel.nodes.delete(id);
      else state.bcSel.nodes.add(id);
    }
  }

  /** Box selection: nodes inside the box, or edges with midpoint inside. */
  function applyBoxSelection(box) {
    const mesh = state.mesh;
    if (!box || !mesh) return;
    if (state.bcSel.kind === 'distload') {
      for (const idx of Mesh.edgesInBox(state.allEdges, mesh, box)) {
        const [a, b] = state.allEdges[idx];
        const key = a < b ? a + '_' + b : b + '_' + a;
        state.bcSel.edges.set(key, [a, b]);
      }
    } else {
      for (const id of Mesh.nodesInBox(mesh, box)) state.bcSel.nodes.add(id);
    }
  }

  /* ---------- Condition modal (name / vector / type) ---------- */

  function defaultName(kind) {
    const list = kind === 'pointload' ? state.pointLoads
               : kind === 'distload' ? state.distLoads : state.supports;
    const base = kind === 'pointload' ? 'Point_load'
               : kind === 'distload' ? 'Distributed_load' : 'Support';
    const names = new Set(list.map(g => g.name));
    let n = 1;
    while (names.has(base + '_' + n)) n++;
    return base + '_' + n;
  }

  function openConditionModal(kind) {
    const sel = state.bcSel;
    if (!sel) return;
    const count = kind === 'distload' ? sel.edges.size : sel.nodes.size;
    if (!count) {
      showToast(kind === 'distload' ? 'Select mesh edges first' : 'Select nodes first');
      return;
    }
    condState = { kind };
    condTitle.textContent = kind === 'pointload' ? 'Point Load'
                          : kind === 'distload' ? 'Distributed Load' : 'Support';
    condVec.style.display = kind === 'support' ? 'none' : '';
    condTypeRow.style.display = kind === 'support' ? '' : 'none';
    condName.value = defaultName(kind);
    condFx.value = '0';
    condFy.value = '0';
    condTypeSegButtons.forEach(b => b.classList.toggle('active', b.dataset.value === 'fixed'));
    condCount.textContent = count + (kind === 'distload' ? ' edges selected' : ' nodes selected');
    condModal.classList.add('visible');
    syncTouchUI(); // modal overlays the action bar → hide it
    condName.focus();
    condName.select();
  }

  function closeConditionModal() {
    condModal.classList.remove('visible');
    syncTouchUI();
  }

  function confirmCondition() {
    if (!condState) return;
    const kind = condState.kind;
    const name = condName.value.trim();
    if (!name) { showToast('Enter a name'); return; }
    if (kind === 'support') {
      const active = condTypeSegButtons.find(b => b.classList.contains('active'));
      const type = (active && active.dataset.value) || 'fixed';
      state.supports.push({ name, type, nodeIds: [...state.bcSel.nodes] });
    } else {
      const fx = parseFloat(condFx.value) || 0;
      const fy = parseFloat(condFy.value) || 0;
      if (kind === 'pointload') {
        state.pointLoads.push({ name, nodeIds: [...state.bcSel.nodes], fx, fy });
      } else {
        state.distLoads.push({ name, edges: [...state.bcSel.edges.values()], fx, fy });
      }
    }
    condState = null;
    state.bcSel = null;
    closeConditionModal();
    renderBcList();
    setHint();
    scheduleRender();
  }

  /* ---------- Condition list ---------- */

  function deleteCondition(kind, index) {
    const arr = kind === 'point' ? state.pointLoads
              : kind === 'dist' ? state.distLoads : state.supports;
    arr.splice(index, 1);
    renderBcList();
    scheduleRender();
  }

  function renderBcList() {
    bcList.textContent = '';
    const items = [];
    state.pointLoads.forEach((g, i) => items.push({ g, kind: 'point', i }));
    state.distLoads.forEach((g, i) => items.push({ g, kind: 'dist', i }));
    state.supports.forEach((g, i) => items.push({ g, kind: 'support', i }));
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'bc-empty';
      empty.textContent = 'No conditions yet';
      bcList.appendChild(empty);
      return;
    }
    for (const { g, kind, i } of items) {
      const row = document.createElement('div');
      row.className = 'bc-item';
      const label = document.createElement('span');
      const count = kind === 'dist' ? g.edges.length + ' edges' : g.nodeIds.length + ' nodes';
      label.textContent = g.name + ' — ' + count;
      const del = document.createElement('button');
      del.className = 'btn btn-ghost bc-del';
      del.textContent = '✕';
      del.addEventListener('click', () => deleteCondition(kind, i));
      row.appendChild(label);
      row.appendChild(del);
      bcList.appendChild(row);
    }
  }

  /* ============================================================
     10. Layout (Hi-DPI) & event wiring
     ============================================================ */

  function resize() {
    const rect = stage.getBoundingClientRect();
    state.dpr = window.devicePixelRatio || 1;
    state.w = rect.width;
    state.h = rect.height;
    canvas.width = Math.round(rect.width * state.dpr);
    canvas.height = Math.round(rect.height * state.dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    refresh();
  }

  // ResizeObserver fires continuously while the window is being dragged;
  // coalesce to one full recompute per animation frame.
  let resizeRaf = null;
  function scheduleResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = null; resize(); });
  }

  function updateSliderFill(input) {
    const min = parseFloat(input.min), max = parseFloat(input.max);
    const pct = ((parseFloat(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--val', pct + '%');
  }

  /** Throttle the expensive mesh recompute to once per frame. */
  let refreshRaf = null;
  function scheduleRefresh() {
    if (refreshRaf) return;
    refreshRaf = requestAnimationFrame(() => { refreshRaf = null; refresh(); });
  }

  /** Coalesce plain re-renders (cheap) to once per frame. */
  let rafId = null;
  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      renderer.render(state);
      syncTouchUI(); // touch bar follows whatever state the render just drew
    });
  }

  /* ---------- Wire up the controls ---------- */

  segButtons.forEach(btn => btn.addEventListener('click', () => {
    segButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.gridType = btn.dataset.value;
    refresh();
  }));

  drawModeButtons.forEach(btn => btn.addEventListener('click', () => {
    if (state.phase === 'bc') return; // draw-mode controls are locked
    // "Import" is a momentary action, not a persistent draw mode: open the
    // guide modal and leave the previously selected mode untouched.
    if (btn.dataset.value === 'image') {
      openImportModal();
      return;
    }
    drawModeButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.drawMode = btn.dataset.value;
    snapRow.classList.toggle('disabled', btn.dataset.value === 'freehand');
    snapEl.disabled = btn.dataset.value === 'freehand';
    state.freehandActive = false;
    state.drawing = [];        // drop any in-progress stroke on mode switch
    state.cursor = null;
    syncPanels();
    setHint();
    scheduleRender();
  }));

  cellSizeEl.addEventListener('input', () => {
    state.cellSize = parseFloat(cellSizeEl.value);
    updateSliderFill(cellSizeEl);
    scheduleRefresh();
  });

  snapEl.addEventListener('change', () => { state.snap = snapEl.checked; });

  btnDemo.addEventListener('click', loadDemo);
  btnClear.addEventListener('click', clearPolygon);
  btnResetView.addEventListener('click', resetView);
  btnExport.addEventListener('click', exportTxt);
  btnPanels.addEventListener('click', togglePanels);
  // Solve-phase top-bar twins (Reset View / Hide Panels stay usable while
  // the solver is active and the pre-processing actions are hidden).
  if (btnSolveResetView) btnSolveResetView.addEventListener('click', resetView);
  if (btnSolvePanels) btnSolvePanels.addEventListener('click', togglePanels);

  // ---------- Touch action bar ----------
  // Visible equivalents of Enter / Backspace / Esc. Mesh-phase actions call
  // the local functions directly; BC / solver sessions dispatch the matching
  // keyboard event so the phase handlers (incl. solver blocks) stay the
  // single source of truth.
  function pressKey(key) {
    try {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      window.dispatchEvent(ev);
    } catch (err) { /* synthetic keys unsupported — ignore */ }
  }
  if (btnTouchDone) btnTouchDone.addEventListener('click', () => {
    if (state.phase === 'mesh') {
      if (state.drawMode === 'freehand' && state.freehandActive) finishFreehand();
      else if (state.drawMode === 'point' && !state.polygon) finishPolygon();
    } else pressKey('Enter');
    syncTouchUI();
  });
  if (btnTouchUndo) btnTouchUndo.addEventListener('click', () => {
    if (state.phase === 'mesh' && state.drawMode === 'point' && state.drawing.length) {
      state.drawing.pop();
      syncPanels();
      scheduleRender();
    } else pressKey('Backspace');
    syncTouchUI();
  });
  if (btnTouchCancel) btnTouchCancel.addEventListener('click', () => {
    if (state.phase === 'mesh' && (state.drawing.length || state.freehandActive)) clearPolygon();
    else pressKey('Escape');
    syncTouchUI();
  });

  // Image import modal (opened via the "Import" segment in Draw Mode)
  btnImportPick.addEventListener('click', () => fileInput.click());
  btnImportClose.addEventListener('click', closeImportModal);
  fileInput.addEventListener('change', onFileSelected);
  importModal.addEventListener('click', (e) => {
    if (e.target === importModal) closeImportModal(); // click backdrop to close
  });

  // Boundary-condition phase
  btnPhase.addEventListener('click', () => setPhase(state.phase === 'bc' ? 'mesh' : 'bc'));
  btnSolver.addEventListener('click', toggleSolver);
  btnAddPointLoad.addEventListener('click', () => startBcSelect('pointload'));
  btnAddDistLoad.addEventListener('click', () => startBcSelect('distload'));
  btnAddSupport.addEventListener('click', () => startBcSelect('support'));
  btnCondOk.addEventListener('click', confirmCondition);
  btnCondCancel.addEventListener('click', () => {
    condState = null;
    closeConditionModal();
    cancelBcSelect();
  });
  condTypeSegButtons.forEach(btn => btn.addEventListener('click', () => {
    condTypeSegButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }));
  // Enter inside the modal confirms the condition.
  [condName, condFx, condFy].forEach(el => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmCondition(); }
  }));
  condModal.addEventListener('click', (e) => {
    if (e.target === condModal) { // click backdrop to cancel
      condState = null;
      closeConditionModal();
      cancelBcSelect();
    }
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeydown);

  new ResizeObserver(() => scheduleResize()).observe(stage);

  /* ============================================================
     10.5  Phase-plugin bridge — for future solver controllers
     ============================================================ */

  /**
   * Register handlers for a phase. A solver block (e.g. a future
   * js/solver/<problem>/ui.js) calls this to plug its pointer /
   * keyboard / lifecycle callbacks into the app without app.js ever
   * needing to know solver details.
   *
   * Handlers: enter(), exit(), pointerdown/move/up/cancel(e), keydown(e).
   * Multiple registrations for the same phase/handler are CHAINED, so
   * several plugins (shell, a solver block) can share a phase.
   */
  function registerPhase(phase, handlers) {
    const target = (phaseHandlers[phase] = phaseHandlers[phase] || {});
    for (const key of Object.keys(handlers)) {
      const prev = target[key];
      const next = handlers[key];
      target[key] = prev
        ? function (...args) { prev.apply(this, args); return next.apply(this, args); }
        : next;
    }
  }

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.App = {
    state,
    refresh,
    scheduleRender,
    showToast,
    setHint,
    setPhase,
    registerPhase,
  };

  /* ============================================================
     11. Init
     ============================================================ */
  updateSliderFill(cellSizeEl);
  syncSolverButton();
  resize();
  loadDemo();
  renderBcList();
})(window);
