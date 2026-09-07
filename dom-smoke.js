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
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...kids) { this.children.length = 0; for (const k of kids) this.children.push(k); },
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
// requestAnimationFrame: execute the callback SYNCHRONOUSLY (the tests
// rely on immediate execution), but return a falsy token — app.js stores
// the token in rafId as a coalescing flag, and in a real browser the
// callback (which clears rafId) runs next frame. Returning a truthy value
// here would leave rafId stuck and swallow every later scheduleRender.
global.requestAnimationFrame = cb => { global._rafCount = (global._rafCount || 0) + 1; cb(); return 0; };
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
  body: {
    appendChild() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  },
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
require('./js/solver/solver-ui.js');
require('./js/solver/solver-bc.js');
require('./js/solver/matrix.js');
require('./js/solver/poisson/vem.js');
require('./js/solver/poisson/assembly.js');
require('./js/solver/poisson/post.js');
require('./js/solver/poisson/ui.js');
require('./js/solver/elastic/vem.js');
require('./js/solver/elastic/assembly.js');
require('./js/solver/elastic/post.js');
require('./js/solver/elastic/ui.js');

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

  /* ---------- Exercise: solver phase (Solver Start button) ---------- */

  const btnSolver = elements.get('btnSolver');
  if (!btnSolver || !btnSolver.listeners.click || !btnSolver.listeners.click.length) {
    throw new Error('Solver Start button not wired');
  }
  btnSolver.listeners.click[0]();                  // enter the solve phase
  if (!stageEl.classList.contains('solve')) throw new Error('stage did not enter solve phase');
  if (btnSolver.textContent !== 'Exit Solver') throw new Error('solver button text wrong: ' + btnSolver.textContent);
  if (!btnSolver.classList.contains('btn-primary')) throw new Error('solver button should be primary in solve phase');
  if (elements.get('btnDemo').disabled !== true) throw new Error('Demo should be locked in solve phase');

  // solve-phase top-bar actions: Reset View + Hide Panels stay available
  const btnSolveResetView = elements.get('btnSolveResetView');
  const btnSolvePanels = elements.get('btnSolvePanels');
  if (!btnSolveResetView || !btnSolveResetView.listeners.click || !btnSolveResetView.listeners.click.length) throw new Error('solve Reset View not wired');
  if (!btnSolvePanels || !btnSolvePanels.listeners.click || !btnSolvePanels.listeners.click.length) throw new Error('solve Hide Panels not wired');
  btnSolveResetView.listeners.click[0]();          // resetView — must not throw
  btnSolvePanels.listeners.click[0]();             // hide the floating panels
  if (!stageEl.classList.contains('ui-off')) throw new Error('solve Hide Panels did not hide the panels');
  if (btnSolvePanels.textContent !== 'Show Panels') throw new Error('solve Hide Panels label wrong: ' + btnSolvePanels.textContent);
  btnSolvePanels.listeners.click[0]();             // restore them
  if (stageEl.classList.contains('ui-off')) throw new Error('solve panels did not restore');
  if (btnSolvePanels.textContent !== 'Hide Panels') throw new Error('solve panels label wrong after restore');
  console.log('OK: solve top bar keeps Reset View & Hide Panels');

  btnSolver.listeners.click[0]();                  // exit back to the mesh phase
  if (stageEl.classList.contains('solve')) throw new Error('stage still in solve phase after exit');
  if (btnSolver.textContent !== 'Solver Start') throw new Error('solver button text wrong after exit: ' + btnSolver.textContent);
  console.log('OK: solver phase entered & exited via Solver Start button');

  /* ---------- Exercise: solver shell UI (dropdowns + legend) ---------- */

  const selProblem = elements.get('solverProblemSel');
  const selField = elements.get('solverFieldSel');
  if (selProblem.children.length !== 3) throw new Error('problem dropdown should list 3 blocks, got ' + selProblem.children.length);
  if (selProblem.children[0].value !== 'elastic' || selProblem.children[0].disabled !== false) throw new Error('elastic should be selectable & FIRST');
  if (selProblem.children[0].textContent !== '2D Elasticity') throw new Error('elastic label wrong: ' + selProblem.children[0].textContent);
  if (selProblem.children[1].value !== 'poisson' || selProblem.children[1].disabled !== false) throw new Error('poisson should be selectable & second');
  if (selProblem.children[1].textContent !== '2D Poisson Equation') throw new Error('poisson label wrong: ' + selProblem.children[1].textContent);
  if (selProblem.children[2].disabled !== true) throw new Error('dynamics should be disabled (coming soon)');
  if (selProblem.value !== 'elastic') throw new Error('default problem should be elastic, got ' + selProblem.value);
  if (selField.children.length !== 3) throw new Error('elastic should expose 3 fields by default, got ' + selField.children.length);
  if (elements.get('solverLegendCaption').textContent !== 'Displacement [mm]') throw new Error('default legend caption wrong: ' + elements.get('solverLegendCaption').textContent);
  if (elements.get('solverLegendMin').textContent !== '—' || elements.get('solverLegendMax').textContent !== '—') throw new Error('legend range should be empty before solving');
  if (elements.get('btnSolve').classList.contains('solver-blocked')) throw new Error('Solve must not be shell-blocked for elasticity');

  // switch to poisson → field list, caption and Solve gating change
  selProblem.value = 'poisson';
  selProblem.listeners.change[0]();
  if (selField.children.length !== 2) throw new Error('poisson should expose 2 fields, got ' + selField.children.length);
  if (elements.get('solverLegendCaption').textContent !== 'Temperature [°C]') throw new Error('legend caption wrong: ' + elements.get('solverLegendCaption').textContent);
  if (!elements.get('btnSolve').classList.contains('solver-blocked')) throw new Error('Solve button should be blocked (faded) until a Temperature BC exists');

  // switch display field → legend caption changes
  selField.value = 'flux';
  selField.listeners.change[0]();
  if (elements.get('solverLegendCaption').textContent !== 'Heat Flux [W/m²]') throw new Error('legend caption wrong after field switch: ' + elements.get('solverLegendCaption').textContent);

  // switch problem → field list + legend update
  selProblem.value = 'elastic';
  selProblem.listeners.change[0]();
  if (selField.children.length !== 3) throw new Error('elastic should expose 3 fields, got ' + selField.children.length);
  if (elements.get('solverLegendCaption').textContent !== 'Displacement [mm]') throw new Error('legend caption wrong after problem switch: ' + elements.get('solverLegendCaption').textContent);

  // dynamics → 4 fields (displacement / velocity / acceleration / stress)
  selProblem.value = 'dynamics';
  selProblem.listeners.change[0]();
  if (selField.children.length !== 4) throw new Error('dynamics should expose 4 fields, got ' + selField.children.length);
  if (elements.get('solverLegendCaption').textContent !== 'Displacement [mm]') throw new Error('legend caption wrong after dynamics switch: ' + elements.get('solverLegendCaption').textContent);

  // back to poisson
  selProblem.value = 'poisson';
  selProblem.listeners.change[0]();
  if (elements.get('solverLegendCaption').textContent !== 'Temperature [°C]') throw new Error('legend caption wrong after switching back: ' + elements.get('solverLegendCaption').textContent);
  console.log('OK: solver shell dropdowns (elastic first, default) + heatmap legend follow problem & field');

  /* ---------- Exercise: solver parameters (k, f) ---------- */

  const paramsWrap = elements.get('solverParams');
  if (paramsWrap.children.length !== 3) throw new Error('poisson should render 2 params + f note, got ' + paramsWrap.children.length);
  const kInput = paramsWrap.children[0].children[1];
  const fInput = paramsWrap.children[1].children[1];
  if (kInput.value !== '10' || fInput.value !== '10') throw new Error('param defaults wrong: k=' + kInput.value + ' f=' + fInput.value);
  if (!/Uniform over the whole domain/.test(paramsWrap.children[2].textContent)) throw new Error('f note missing: ' + paramsWrap.children[2].textContent);
  fInput.value = '5';
  fInput.listeners.input[0]();
  const paramsNow = global.MeshStudio.SolverUI.currentParams();
  if (paramsNow.f !== 5 || paramsNow.k !== 10) throw new Error('param values wrong: ' + JSON.stringify(paramsNow));
  // switching problem resets params to the new block's defaults
  selProblem.value = 'elastic';
  selProblem.listeners.change[0]();
  if (paramsWrap.children.length !== 4) throw new Error('elastic should render E, nu, Show-deformation switch, slider → 4 children, got ' + paramsWrap.children.length);
  if (paramsWrap.children[0].children[1].value !== '200') throw new Error('E default wrong (should be 200 GPa): ' + paramsWrap.children[0].children[1].value);
  if (paramsWrap.children[1].children[1].value !== '0.3') throw new Error('nu default wrong: ' + paramsWrap.children[1].children[1].value);
  const deformSwitchCb0 = paramsWrap.children[2].children[1].children[0];
  if (deformSwitchCb0.type !== 'checkbox') throw new Error('Show deformation should be a switch (checkbox), got type ' + deformSwitchCb0.type);
  if (deformSwitchCb0.checked !== false) throw new Error('Show deformation should default to OFF');
  const deformRange = paramsWrap.children[3].children[1];
  if (deformRange.type !== 'range') throw new Error('Deformation should be a slider input, got type ' + deformRange.type);
  if (deformRange.value !== '1') throw new Error('Deformation slider default wrong (should be 10^1 = ×10): ' + deformRange.value);
  const cp0 = global.MeshStudio.SolverUI.currentParams();
  if (cp0.deformOn !== false || cp0.deform !== 10) throw new Error('elastic param defaults wrong: ' + JSON.stringify(cp0));
  if (deformRange.disabled !== true) throw new Error('Deformation slider should be disabled until Show deformation is ON');

  // enabling the switch unlocks the slider (and the deformed view)
  deformSwitchCb0.checked = true;
  deformSwitchCb0.listeners.change[0]();
  if (deformRange.disabled !== false) throw new Error('Deformation slider should enable with the switch');
  if (global.MeshStudio.SolverUI.currentParams().deformOn !== true) throw new Error('deformOn should be true after the switch');
  deformSwitchCb0.checked = false;
  deformSwitchCb0.listeners.change[0]();
  if (deformRange.disabled !== true) throw new Error('Deformation slider should disable again after switch off');
  selProblem.value = 'poisson';
  selProblem.listeners.change[0]();
  if (paramsWrap.children.length !== 3) throw new Error('poisson params not restored, got ' + paramsWrap.children.length);
  if (paramsWrap.children[1].children[1].value !== '10') throw new Error('param f should reset to default after problem switch');
  console.log('OK: solver parameters (k, f) with defaults, problem-scoped');

  /* ---------- Exercise: solver boundary conditions (Poisson) ---------- */

  btnSolver.listeners.click[0]();                  // enter the solve phase
  if (!stageEl.classList.contains('solve')) throw new Error('stage did not enter solve phase (BC test)');
  if (!/boundary/i.test(elements.get('hintBar').textContent)) throw new Error('solve hint should mention boundary edges: ' + elements.get('hintBar').textContent);

  const bcButtons = elements.get('solverBcButtons');
  if (bcButtons.children.length !== 2) throw new Error('poisson should expose 2 BC buttons, got ' + bcButtons.children.length);

  // clicking the blocked Solve button must explain WHY it does nothing
  elements.get('btnSolve').listeners.click[0]();
  const blockedToast = elements.get('toast').textContent;
  if (blockedToast !== 'At least one Dirichlet boundary condition is required.') throw new Error('blocked solve toast wrong: ' + blockedToast);

  // Temperature (Dirichlet) via box selection over the whole domain
  bcButtons.children[0].listeners.click[0]();
  canvasEl.listeners.pointermove[0]({ clientX: 100, clientY: 100, pointerId: 11 });
  canvasEl.listeners.pointerdown[0]({ clientX: 100, clientY: 100, pointerId: 11 });
  canvasEl.listeners.pointermove[0]({ clientX: 700, clientY: 500, pointerId: 11 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!elements.get('solverCondModal').classList.contains('visible')) throw new Error('solver BC modal did not open');
  elements.get('solverCondName').value = 'HotEdge';
  elements.get('solverCondValue').value = '100';
  elements.get('btnSolverCondOk').listeners.click[0]();
  if (elements.get('solverCondModal').classList.contains('visible')) throw new Error('solver BC modal did not close');
  if (!/HotEdge/.test(textOf(elements.get('solverBcList')))) throw new Error('temperature group not listed: ' + textOf(elements.get('solverBcList')));
  if (elements.get('btnSolve').classList.contains('solver-blocked')) throw new Error('Solve should be enabled once a Temperature BC exists');

  // every selected edge must be a boundary edge (interior edges are NOT selectable)
  const ms = global.MeshStudio;
  const bndKeys = new Set(ms.Mesh.boundaryEdges(ms.App.state.mesh).map(([a, b]) => (a < b ? a + '_' + b : b + '_' + a)));
  const bcGroups = ms.SolverBC.groups;
  if (bcGroups.length !== 1) throw new Error('expected 1 BC group, got ' + bcGroups.length);
  for (const g of bcGroups) for (const [a, b] of g.edges) {
    const kk = a < b ? a + '_' + b : b + '_' + a;
    if (!bndKeys.has(kk)) throw new Error('non-boundary edge selected: ' + kk);
  }
  console.log('OK: temperature (Dirichlet) group on boundary edges only, Solve enabled');

  /* ---------- Exercise: run the real Poisson solve ---------- */

  // The constant-Dirichlet check below requires f = 0 (with the new default
  // f = 10 the interior would heat up above 100); set it explicitly.
  const fSolveInput = paramsWrap.children[1].children[1];
  fSolveInput.value = '0';
  fSolveInput.listeners.input[0]();
  elements.get('btnSolve').listeners.click[0]();
  const sol = ms.App.state.solution;
  if (!sol || !sol.fields || !sol.fields.temperature) throw new Error('no solution after Solve');
  const tField = sol.fields.temperature;
  if (!(Math.abs(tField.min - 100) < 1e-6 && Math.abs(tField.max - 100) < 1e-6)) {
    throw new Error('constant-Dirichlet solution wrong: ' + tField.min + '..' + tField.max);
  }
  if (sol.fields.flux.max > 1e-6) throw new Error('flux should vanish for a constant solution, got ' + sol.fields.flux.max);
  if (!/Solved/.test(elements.get('toast').textContent)) throw new Error('solve toast missing: ' + elements.get('toast').textContent);
  if (elements.get('solverLegendMin').textContent === '—') throw new Error('legend min not updated after solve');
  console.log('OK: real Poisson solve runs (constant Dirichlet reproduced, u=' + tField.min + ')');

  // switching the display field must re-render the heatmap (and the legend):
  // for the constant solution the flux range is 0..0 while T is 100..100
  const rafBefore = global._rafCount || 0;
  selField.value = 'flux';
  selField.listeners.change[0]();
  if ((global._rafCount || 0) <= rafBefore) throw new Error('field switch did not schedule a re-render (stale heatmap)');
  if (elements.get('solverLegendCaption').textContent !== 'Heat Flux [W/m²]') throw new Error('legend caption not flux after switch: ' + elements.get('solverLegendCaption').textContent);
  if (elements.get('solverLegendMin').textContent !== '0' || elements.get('solverLegendMax').textContent !== '0') {
    throw new Error('legend should show flux range 0..0 for the constant solution, got ' +
      elements.get('solverLegendMin').textContent + '..' + elements.get('solverLegendMax').textContent);
  }
  console.log('OK: display-field switch re-renders the heatmap (flux legend 0..0)');

  // Heat Flux (Neumann) group
  bcButtons.children[1].listeners.click[0]();
  canvasEl.listeners.pointermove[0]({ clientX: 100, clientY: 100, pointerId: 12 });
  canvasEl.listeners.pointerdown[0]({ clientX: 100, clientY: 100, pointerId: 12 });
  canvasEl.listeners.pointermove[0]({ clientX: 700, clientY: 500, pointerId: 12 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!elements.get('solverCondModal').classList.contains('visible')) throw new Error('flux modal did not open');
  elements.get('solverCondName').value = 'Flux1';
  elements.get('solverCondValue').value = '50';
  elements.get('btnSolverCondOk').listeners.click[0]();
  if (!/Flux1/.test(textOf(elements.get('solverBcList')))) throw new Error('flux group not listed');
  if (ms.SolverBC.groups.length !== 2) throw new Error('expected 2 BC groups, got ' + ms.SolverBC.groups.length);
  for (const g of ms.SolverBC.groups) for (const [a, b] of g.edges) {
    const kk = a < b ? a + '_' + b : b + '_' + a;
    if (!bndKeys.has(kk)) throw new Error('non-boundary edge selected in flux group: ' + kk);
  }
  console.log('OK: heat flux (Neumann) group added (boundary-only)');

  // Esc cancels a live selection; a delete removes a group; exit the phase
  bcButtons.children[0].listeners.click[0]();
  global._listeners.keydown[0](key('Escape'));
  const delBtn = elements.get('solverBcList').children[0].children[1];
  delBtn.listeners.click[0]();
  if (ms.SolverBC.groups.length !== 1) throw new Error('group delete failed, got ' + ms.SolverBC.groups.length);
  btnSolver.listeners.click[0]();                  // back to mesh phase
  if (stageEl.classList.contains('solve')) throw new Error('stage still in solve phase (BC test)');
  console.log('OK: solver BC selection, grouping, delete, gating & boundary-only restriction');

  /* ---------- Exercise: 2D Elasticity end-to-end (preprocessor BCs) ---------- */
  // Earlier steps left MyLoad (1000, -250) — on a node INSIDE the Support_1
  // box, i.e. pinned, so it would not deform the body. Add a second point
  // load at a free lattice node (480, 360) to get a nonzero displacement.

  btnPhase.listeners.click[0]();                   // enter the BC phase
  elements.get('btnAddPointLoad').listeners.click[0]();
  canvasEl.listeners.pointermove[0]({ clientX: 480, clientY: 360, pointerId: 21 });
  canvasEl.listeners.pointerdown[0]({ clientX: 480, clientY: 360, pointerId: 21 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!condModal.classList.contains('visible')) throw new Error('elastic load modal did not open');
  condName.value = 'ElasticLoad';
  elements.get('condFx').value = '0';
  elements.get('condFy').value = '-500';           // FEM convention: down in screen space
  elements.get('btnCondOk').listeners.click[0]();
  if (!/ElasticLoad/.test(textOf(elements.get('bcList')))) throw new Error('elastic load not listed');

  btnSolver.listeners.click[0]();                  // enter the solve phase
  if (!stageEl.classList.contains('solve')) throw new Error('stage did not enter solve phase (elastic test)');

  selProblem.value = 'elastic';
  selProblem.listeners.change[0]();
  if (selField.children.length !== 3) throw new Error('elastic should expose 3 fields, got ' + selField.children.length);

  // elasticity has no scalar solver-BCs — the whole BC section is hidden
  // (no stray "coming soon"/empty-list texts for non-BC problems)
  if (elements.get('solverBcSection').style.display !== 'none') throw new Error('BC section should be hidden for elasticity');
  if (elements.get('solverBcButtons').children.length !== 0) throw new Error('elastic should add no scalar BC buttons');
  if (elements.get('btnSolve').classList.contains('solver-blocked')) throw new Error('Solve must not be shell-blocked for elasticity');

  // Solve must run: the 4-node support removes rigid-body motion
  elements.get('btnSolve').listeners.click[0]();
  const esol = ms.App.state.solution;
  if (!esol || !esol.fields || !esol.fields.displacement) throw new Error('no elasticity solution after Solve');
  const nNodes = ms.App.state.mesh.nodes.length;
  for (const fid of ['displacement', 'strain', 'stress']) {
    const f = esol.fields[fid];
    if (!f || f.data.length !== nNodes || !(f.min <= f.max) || !Number.isFinite(f.min) || !Number.isFinite(f.max)) {
      throw new Error('bad elastic field ' + fid);
    }
  }
  if (!(esol.fields.displacement.max > 0)) throw new Error('free-node load should displace the body (max ' + esol.fields.displacement.max + ')');
  const eu = esol.fields.displacement.data;
  // every support node must stay put
  const supIds = new Set();
  for (const g of ms.App.state.supports) for (const id of g.nodeIds) supIds.add(id);
  if (supIds.size < 2) throw new Error('expected ≥2 support nodes for the elastic gate, got ' + supIds.size);
  for (const id of supIds) {
    if (!(Math.abs(eu[id]) < 1e-8)) throw new Error('support node ' + id + ' moved by ' + eu[id]);
  }
  if (elements.get('solverLegendMin').textContent === '—') throw new Error('legend range not updated after elastic solve');
  if (!/Solved/.test(elements.get('toast').textContent)) throw new Error('elastic solve toast missing: ' + elements.get('toast').textContent);
  console.log('OK: elasticity solves from pre-processor loads/supports (max |u| ' + esol.fields.displacement.max.toExponential(1) + ')');

  // display-field switch re-renders for elastic nodal fields
  selField.value = 'stress';
  selField.listeners.change[0]();
  if (elements.get('solverLegendCaption').textContent !== 'Stress [MPa]') {
    throw new Error('stress caption wrong: ' + elements.get('solverLegendCaption').textContent);
  }
  console.log('OK: elasticity display fields follow the field dropdown');

  // deformed view is OFF by default → the heatmap stays on the UNDEFORMED
  // mesh and the renderer keeps drawing the domain (predicate = false)
  if (typeof ms.App.state.hideMeshFn !== 'function') throw new Error('elastic solve should install a hideMesh predicate');
  if (ms.App.state.hideMeshFn() !== false) throw new Error('mesh must stay visible while the deformed view is off');

  const deformSwitchCb = paramsWrap.children[2].children[1].children[0];
  const deformInput = paramsWrap.children[3].children[1];
  if (deformInput.disabled !== true) throw new Error('Deformation slider should start disabled (deformed view off)');

  // enable the deformed view: the heatmap follows the deformed mesh (the
  // renderer's mesh drawing is suppressed per frame) and the slider unlocks
  const rafToggleBefore = global._rafCount || 0;
  deformSwitchCb.checked = true;
  deformSwitchCb.listeners.change[0]();
  if ((global._rafCount || 0) <= rafToggleBefore) throw new Error('Show deformation switch did not schedule a re-render');
  if (deformInput.disabled !== false) throw new Error('Deformation slider should enable with the switch');
  if (ms.App.state.hideMeshFn() !== true) throw new Error('mesh should be hidden in deformed mode');
  console.log('OK: Show-deformation switch toggles the deformed heatmap');

  // the logarithmic Deformation slider drives the scale → edits re-render
  const rafSliderBefore = global._rafCount || 0;
  deformInput.value = '3';                        // 10^3 = ×1000
  deformInput.listeners.input[0]();
  if ((global._rafCount || 0) <= rafSliderBefore) {
    throw new Error('Deformation slider change did not schedule a re-render');
  }
  if (global.MeshStudio.SolverUI.currentParams().deform !== 1000) {
    throw new Error('Deformation slider should map 10^3 → ×1000, got ' + global.MeshStudio.SolverUI.currentParams().deform);
  }
  console.log('OK: Deformation slider (log) re-renders the deformed heatmap');

  selProblem.value = 'poisson';                    // leave the shell clean
  selProblem.listeners.change[0]();
  if (ms.App.state.hideMeshFn() !== false) throw new Error('predicate must clear when switching away from elasticity');
  btnSolver.listeners.click[0]();                  // exit the solve phase
  if (stageEl.classList.contains('solve')) throw new Error('stage still in solve phase (elastic test exit)');
  if (ms.App.state.hideMeshFn !== null) throw new Error('hideMesh predicate must be removed on leaving the solve phase');
  console.log('OK: elasticity block wired end-to-end');

  console.log('DOM smoke OK');
})().catch(e => {
  console.error('DOM smoke FAIL: ' + e.message);
  process.exit(1);
});
