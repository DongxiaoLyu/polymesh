/* ============================================================
   dom-smoke.js — DOM-level wiring check for app.js
   ============================================================
   Boots the real app.js against stub DOM/canvas APIs to catch:
     - missing element ids / typos in getElementById
     - init errors (resize + loadDemo + listeners)
     - the image-import flow end to end (file → contour → mesh)
   Not a visual test; asserts no crash and observable outcomes.

   Run:  node dom-smoke.js
   ============================================================ */

'use strict';

global.window = global;

/* ---------- Stub DOM ---------- */

const elements = new Map();

function makeCtx(w, h) {
  return new Proxy({}, {
    get(t, p) {
      if (p === 'getImageData') {
        // The app draws the uploaded image then reads it back; the stub
        // returns a synthetic dark rectangle so the full pipeline runs.
        return (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4).fill(255);
          for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
            if (i > 0.25 * w && i < 0.75 * w && j > 0.25 * h && j < 0.75 * h) {
              const k = (j * w + i) * 4;
              data[k] = 0; data[k + 1] = 0; data[k + 2] = 0;
            }
          }
          return { data, width: w, height: h };
        };
      }
      if (!(p in t)) t[p] = () => {};
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function makeEl(id) {
  const el = {
    id,
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { if (f) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    style: { setProperty() {} },
    dataset: {},
    textContent: '',
    value: '40', min: '16', max: '140', step: '2',
    checked: true,
    disabled: false,
    files: [],
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    appendChild(child) { this.children.push(child); return child; },
    focus() {},
    select() {},
    getContext() { return makeCtx(); },
    getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; },
  };
  elements.set(id, el);
  return el;
}

class Path2DStub { moveTo() {} lineTo() {} arc() {} closePath() {} }
global.Path2D = Path2DStub;
global.ResizeObserver = class { observe() {} disconnect() {} };
global.requestAnimationFrame = cb => { cb(); return 1; };
global.devicePixelRatio = 1;
global.addEventListener = (type, fn) => {   // app.js: window.addEventListener('keydown', ...)
  global._listeners = global._listeners || {};
  (global._listeners[type] = global._listeners[type] || []).push(fn);
};
global.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
global.Blob = class {};
global.Image = class {
  set src(v) {
    this.naturalWidth = 100;
    this.naturalHeight = 100;
    queueMicrotask(() => this.onload && this.onload());
  }
};
global.document = {
  getElementById(id) { return elements.get(id) || makeEl(id); },
  querySelectorAll(sel) {
    // Stub the segmented controls (draw modes, grid types, support types).
    const defs = {
      '#drawModeSeg .seg': ['point', 'freehand', 'image'],
      '#gridTypeSeg .seg': ['square', 'triangle', 'hexagon'],
      '#condTypeSeg .seg': ['fixed', 'hinge'],
    };
    const values = defs[sel];
    if (!values) return [];
    return values.map(v => {
      const el = makeEl('seg-' + v);
      el.dataset.value = v;
      return el;
    });
  },
  createElement(tag) {
    if (tag === 'canvas') return makeEl('dynamic-canvas');
    if (tag === 'a') return { href: '', download: '', click() {}, remove() {} };
    return makeEl('dynamic-' + tag);
  },
  body: { appendChild() {} },
};

/* ---------- Boot the real app (init runs immediately) ---------- */

require('./js/constants.js');
require('./js/geometry.js');
require('./js/grid.js');
require('./js/clipping.js');
require('./js/mesh.js');
require('./js/renderer.js');
require('./js/export.js');
require('./js/demo.js');
require('./js/image.js');
require('./js/app.js');

console.log('OK: app booted (resize + loadDemo + listeners)');

/* ---------- Exercise: import modal (via the "Import" draw-mode segment) ---------- */

const importSeg = elements.get('seg-image');
if (!importSeg || !importSeg.listeners.click || !importSeg.listeners.click.length) {
  throw new Error('Import segment not wired');
}
importSeg.listeners.click[0]();                   // openImportModal
if (!elements.get('importModal').classList.contains('visible')) throw new Error('import modal did not open');
console.log('OK: import modal opens via Draw Mode "Import" segment, examples drawn');

/* ---------- Exercise: full image-import pipeline ---------- */

(async () => {
  const fileInput = elements.get('fileInput');
  fileInput.files = [{ name: 'test.png', size: 1, type: 'image/png' }];
  fileInput.listeners.change[0]();                // onFileSelected → loadImageFile
  await new Promise(r => setTimeout(r, 50));      // let the Image stub's onload microtask run

  const toast = elements.get('toast').textContent;
  if (!/Imported/.test(toast)) throw new Error('import did not produce a polygon; toast: "' + toast + '"');
  const nodes = Number(elements.get('statNodes').textContent);
  const elems = Number(elements.get('statElems').textContent);
  if (!(nodes > 0 && elems > 0)) throw new Error('mesh not built after import (nodes=' + nodes + ', elems=' + elems + ')');
  console.log('OK: import pipeline end-to-end (toast: "' + toast + '", nodes=' + nodes + ', elements=' + elems + ')');

  // modal must have closed after processing
  if (elements.get('importModal').classList.contains('visible')) throw new Error('modal still open after import');
  console.log('OK: modal closed after import');

  /* ---------- Exercise: boundary-condition phase ---------- */

  const stageEl = elements.get('stage');
  const btnPhase = elements.get('btnPhase');
  const canvasEl = elements.get('canvas');

  // enter the BC phase (a mesh exists after the demo/import)
  btnPhase.listeners.click[0]();
  if (!stageEl.classList.contains('bc')) throw new Error('stage did not enter BC phase');
  if (btnPhase.textContent !== 'Edit Mesh') throw new Error('phase button text wrong: ' + btnPhase.textContent);
  if (elements.get('btnDemo').disabled !== true) throw new Error('Demo should be locked in BC phase');
  if (!elements.get('controlsPanel').classList.contains('locked')) throw new Error('controls panel not locked');
  console.log('OK: BC phase entered, mesh controls locked');

  // start a point-load selection and pick a node at a known grid point
  elements.get('btnAddPointLoad').listeners.click[0]();
  const hint = elements.get('hintBar').textContent;
  if (!/Click nodes\/edges/.test(hint)) throw new Error('selection hint not shown: ' + hint);

  const key = (k, target) => ({ key: k, target: target || { tagName: 'BODY' }, preventDefault() {} });
  canvasEl.listeners.pointermove[0]({ clientX: 400, clientY: 320, pointerId: 1 });
  canvasEl.listeners.pointerdown[0]({ clientX: 400, clientY: 320, pointerId: 1 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));   // confirm selection → modal
  const condModal = elements.get('condModal');
  if (!condModal.classList.contains('visible')) throw new Error('condition modal did not open');
  const condName = elements.get('condName');
  if (condName.value !== 'Point_load_1') throw new Error('default name wrong: ' + condName.value);
  console.log('OK: point-load selection + modal open (default name ' + condName.value + ')');

  // fill the form and confirm
  condName.value = 'MyLoad';
  elements.get('condFx').value = '1000';
  elements.get('condFy').value = '-250';
  elements.get('btnCondOk').listeners.click[0]();
  if (condModal.classList.contains('visible')) throw new Error('condition modal did not close');
  const textOf = el => (el.textContent || '') + (el.children || []).map(textOf).join(' ');
  const bcListText = textOf(elements.get('bcList'));
  if (!/MyLoad/.test(bcListText)) throw new Error('condition not listed: ' + bcListText);
  console.log('OK: point load added & listed (' + bcListText.split('—').join(' - ').trim() + ')');

  // add a support via box selection
  elements.get('btnAddSupport').listeners.click[0]();
  canvasEl.listeners.pointermove[0]({ clientX: 400, clientY: 300, pointerId: 2 });
  canvasEl.listeners.pointerdown[0]({ clientX: 400, clientY: 300, pointerId: 2 });
  canvasEl.listeners.pointermove[0]({ clientX: 460, clientY: 360, pointerId: 2 }); // drag → box
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!condModal.classList.contains('visible')) throw new Error('support modal did not open');
  const segHinge = elements.get('seg-hinge');
  segHinge.listeners.click[0]();                     // choose Hinge
  condName.value = 'Support_1';
  elements.get('btnCondOk').listeners.click[0]();
  const listText = textOf(elements.get('bcList'));
  if (!/Support_1/.test(listText)) throw new Error('support not listed: ' + listText);
  console.log('OK: support added via box selection (' + listText.split('—').join(' - ').trim() + ')');

  // Escape cancels a live selection; exit the BC phase re-enables controls
  elements.get('btnAddDistLoad').listeners.click[0]();
  global._listeners.keydown[0](key('Escape'));
  btnPhase.listeners.click[0]();                     // back to mesh phase
  if (stageEl.classList.contains('bc')) throw new Error('stage still in BC phase');
  if (elements.get('btnDemo').disabled !== false) throw new Error('Demo should be unlocked after BC phase');
  console.log('OK: BC phase exited, mesh controls unlocked');

  /* ---------- Exercise: wheel zoom + reset view ---------- */

  const wheel = canvasEl.listeners.wheel && canvasEl.listeners.wheel[0];
  if (!wheel) throw new Error('wheel listener not wired');
  wheel({ clientX: 400, clientY: 300, deltaY: -240, preventDefault() {} }); // zoom in — must not throw
  wheel({ clientX: 400, clientY: 300, deltaY: 240, preventDefault() {} });  // zoom out — must not throw
  const resetBtn = elements.get('btnResetView');
  if (!resetBtn.listeners.click || !resetBtn.listeners.click.length) throw new Error('Reset View button not wired');
  resetBtn.listeners.click[0]();                     // resetView — must not throw

  // re-enter the BC phase: a click at a known node position must still select
  // (pointer coordinates are converted through the view transform)
  btnPhase.listeners.click[0]();
  elements.get('btnAddPointLoad').listeners.click[0]();
  canvasEl.listeners.pointermove[0]({ clientX: 400, clientY: 320, pointerId: 3 });
  canvasEl.listeners.pointerdown[0]({ clientX: 400, clientY: 320, pointerId: 3 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!condModal.classList.contains('visible')) throw new Error('node not selected after view ops');
  console.log('OK: wheel zoom + Reset View work, selection accurate after view changes');
  global._listeners.keydown[0](key('Escape'));       // close the modal
  btnPhase.listeners.click[0]();                     // back to mesh phase

  console.log('DOM smoke OK');
})().catch(e => {
  console.error('DOM smoke FAIL: ' + e.message);
  process.exit(1);
});
