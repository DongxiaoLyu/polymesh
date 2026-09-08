/* ============================================================
   dom-smoke.js — DOM-level wiring check for app.js
   ============================================================
   Boots the real app.js against stub DOM/canvas APIs to catch:
     - missing element ids / typos in getElementById
     - init errors (resize + loadDemo + listeners)
     - the image-import flow end to end (file → contour → mesh)
     - the THREE-STAGE workflow (mesh → model → solve):
         stage 1 = geometry & mesh only (NO boundary conditions)
         stage 2 = problem choice + unified BC controller
         stage 3 = parameters, Solve & post-processing
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
      add(c) { c.split(/\s+/).forEach(x => { if (x) this._s.add(x); }); },
      remove(c) { c.split(/\s+/).forEach(x => { if (x) this._s.delete(x); }); },
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
    // Minimal selector engine for the dynamically-built solver controls:
    //   '.seg', '.seg.active'                — class list match
    //   '[data-field="fx"]'                  — dataset attr match
    //   '.cond-vec .cond-input'              — descendant classes
    _matchSel(sel) {
      const tokens = sel.trim().split(/\s+/);
      const attrRe = /^\[data-([a-z]+)="([^"]+)"\]$/;
      let node = this;
      for (const t of tokens) {
        const m = t.match(attrRe);
        if (m) {
          if (!node || !node.dataset || node.dataset[m[1]] !== m[2]) return false;
          continue;
        }
        for (const cls of t.split('.').filter(Boolean)) {
          if (!node || !node.classList || !node.classList.contains(cls)) return false;
        }
      }
      return true;
    },
    querySelector(sel) {
      const stack = [...(this.children || [])];
      while (stack.length) {
        const n = stack.pop();
        if (n._matchSel && n._matchSel(sel)) return n;
        stack.push(...(n.children || []));
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const stack = [...(this.children || [])];
      while (stack.length) {
        const n = stack.pop();
        if (n._matchSel && n._matchSel(sel)) out.push(n);
        stack.push(...(n.children || []));
      }
      return out;
    },
  };
  // className <-> classList sync (dynamic solver controls assign className)
  Object.defineProperty(el, 'className', {
    get() { return [...el.classList._s].join(' '); },
    set(v) { el.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
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
    // Stub the segmented controls (draw modes, grid types) + stage dots.
    const defs = {
      '#drawModeSeg .seg': ['point', 'freehand', 'image'],
      '#gridTypeSeg .seg': ['square', 'triangle', 'hexagon'],
      '#stageNav .stage-btn': ['mesh', 'model', 'solve'],
    };
    const values = defs[sel];
    if (!values) return [];
    return values.map(v => {
      const el = makeEl('seg-' + v);
      el.dataset.value = v;
      el.dataset.phase = v;
      el.classList.add('stage-btn');
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

// Pre-build the BC scope segmented control (All / Boundary only) so the
// solver-bc wiring finds its two .seg children.
{
  const scopeEl = makeEl('bcScopeSeg');
  for (const v of ['all', 'boundary']) {
    const s = makeEl('seg-scope-' + v);
    s.dataset.scope = v;
    s.classList.add('seg');
    s.textContent = v === 'all' ? 'All nodes' : 'Boundary only';
    scopeEl.appendChild(s);
  }
}

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

/* ---------- Helpers ---------- */

function textOf(el) {
  return (el.textContent || '') + (el.children || []).map(textOf).join(' ');
}
const clickById = id => {
  const el = elements.get(id);
  if (!el || !el.listeners.click || !el.listeners.click.length) throw new Error('button #' + id + ' not wired');
  el.listeners.click[0]();
};
const key = (k, target) => ({ key: k, target: target || { tagName: 'BODY' }, preventDefault() {} });
const stageBtn = ph => {
  const btn = Array.from(elements.values()).find(e => e.classList && e.classList.contains('stage-btn') && e.dataset.phase === ph);
  if (!btn) throw new Error('stage dot not found: ' + ph);
  return btn;
};

// Read/write a dynamically built BC-modal field by its data-field name.
function bcField(field) {
  const root = elements.get('bcFields');
  const walk = el => {
    if (!el) return null;
    if (el.dataset && el.dataset.field === field) return el;
    for (const c of el.children || []) { const r = walk(c); if (r) return r; }
    return null;
  };
  const el = walk(root);
  if (!el) throw new Error('BC modal field [' + field + '] not found');
  return el;
}

/* ---------- Stage 1: boot + import (mesh only) ---------- */

const stageEl = elements.get('stage');
const canvasEl = elements.get('canvas');
const ms = global.MeshStudio;
if (stageEl.classList.contains('model') || stageEl.classList.contains('solve')) throw new Error('boot should start in the mesh stage');
if (elements.get('btnDemo').disabled !== false) throw new Error('Demo should be enabled in the mesh stage');

// stage dots 2 & 3 exist and are disabled until a mesh exists — at boot
// the demo polygon is already loaded, so a mesh exists → dots enabled
if (stageBtn('model').disabled !== false) throw new Error('Model dot should be enabled after boot/demo mesh');
if (stageBtn('solve').disabled !== false) throw new Error('Solve dot should be enabled after boot/demo mesh');
console.log('OK: mesh stage active at boot, stage dots 2/3 enabled once a mesh exists');

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

  // Stage 1 MUST NOT offer any BC capability anymore: no Set-BCs button,
  // and the model-stage BC sections stay hidden.
  if (elements.get('btnPhase')) throw new Error('Set BCs button should no longer exist (stage 1 has no BCs)');
  if (elements.get('btnSolver')) throw new Error('Solver Start launcher should no longer exist (stepper replaced it)');
  console.log('OK: stage 1 has no BC entry points');

  /* ---------- Exercise: wheel zoom + reset view ---------- */

  const wheel = canvasEl.listeners.wheel && canvasEl.listeners.wheel[0];
  if (!wheel) throw new Error('wheel listener not wired');
  wheel({ clientX: 400, clientY: 300, deltaY: -240, preventDefault() {} }); // zoom in — must not throw
  wheel({ clientX: 400, clientY: 300, deltaY: 240, preventDefault() {} });  // zoom out — must not throw
  clickById('btnResetView');                      // resetView — must not throw
  console.log('OK: wheel zoom + Reset View work in the mesh stage');

  /* ---------- Exercise: enter the Model stage (problem + unified BC) ---------- */

  stageBtn('model').listeners.click[0]();
  if (!stageEl.classList.contains('model')) throw new Error('stage did not enter the model stage');
  if (!elements.get('controlsPanel').classList.contains('locked')) throw new Error('mesh controls not locked in model stage');
  if (elements.get('btnDemo').disabled !== true) throw new Error('Demo should be disabled in the model stage');
  console.log('OK: model stage entered — mesh is locked');

  // Problem dropdown default = elastic (first available); BC section + solve
  // shell adapt to the ACTIVE block. In the model stage the problem dropdown
  // lives in the model panel.
  const selProblem = elements.get('solverProblemSel');
  if (selProblem.children.length !== 3) throw new Error('problem dropdown should list 3 blocks, got ' + selProblem.children.length);
  if (selProblem.value !== 'elastic') throw new Error('default problem should be elastic, got ' + selProblem.value);
  if (selProblem.children[0].value !== 'elastic' || selProblem.children[0].disabled !== false) throw new Error('elastic should be selectable & FIRST');
  if (selProblem.children[2].disabled !== true) throw new Error('dynamics should be disabled (coming soon)');
  console.log('OK: model stage — problem dropdown defaults to Elasticity');

  /* ---------- Exercise: unified BC controller (elastic: mechanical BCs) ---------- */

  const bcButtons = elements.get('solverBcButtons');
  if (bcButtons.children.length !== 3) throw new Error('elastic should expose 3 BC buttons (point/pressure/support), got ' + bcButtons.children.length);
  if (!/Point Load/.test(bcButtons.children[0].textContent)) throw new Error('BC btn 0 wrong: ' + bcButtons.children[0].textContent);
  if (!/Pressure/.test(bcButtons.children[1].textContent)) throw new Error('BC btn 1 wrong: ' + bcButtons.children[1].textContent);
  if (!/Support/.test(bcButtons.children[2].textContent)) throw new Error('BC btn 2 wrong: ' + bcButtons.children[2].textContent);
  console.log('OK: elastic BC buttons (point / pressure / support) rendered from metadata');

  // Solve dot is clickable but gated on ≥2 support nodes → click yields a toast, stays in model
  stageBtn('solve').listeners.click[0]();
  if (stageEl.classList.contains('solve')) throw new Error('should not enter solve without 2 support nodes');
  if (!/support/i.test(elements.get('toast').textContent)) throw new Error('gating toast missing: ' + elements.get('toast').textContent);
  console.log('OK: solve entry gated until ≥2 support nodes exist');

  // point load via click selection
  bcButtons.children[0].listeners.click[0]();     // Add Point Load
  canvasEl.listeners.pointermove[0]({ clientX: 400, clientY: 320, pointerId: 1 });
  canvasEl.listeners.pointerdown[0]({ clientX: 400, clientY: 320, pointerId: 1 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));     // confirm selection → unified modal
  const bcModal = elements.get('bcModal');
  if (!bcModal.classList.contains('visible')) throw new Error('BC modal did not open for a point load');
  if (elements.get('bcTitle').textContent !== 'Point Load') throw new Error('BC modal title wrong: ' + elements.get('bcTitle').textContent);
  if (elements.get('bcName').value !== 'Point_load_1') throw new Error('default name wrong: ' + elements.get('bcName').value);
  console.log('OK: point-load selection + unified modal open (default name ' + elements.get('bcName').value + ')');

  // vector input (fx/fy) lives in #bcFields
  elements.get('bcName').value = 'MyLoad';
  const fx = bcField('fx'); fx.value = '1000';
  const fy = bcField('fy'); fy.value = '-250';
  clickById('btnBcOk');
  if (bcModal.classList.contains('visible')) throw new Error('BC modal did not close');
  const bcListText = textOf(elements.get('solverBcList'));
  if (!/MyLoad/.test(bcListText)) throw new Error('point load not listed: ' + bcListText);
  if (ms.App.state.pointLoads.length !== 1) throw new Error('point load not in state');
  console.log('OK: point load confirmed & listed (' + bcListText.split('—').join(' - ').trim() + ')');

  // --- selection scope: All / Boundary only (node BCs) ---
  const scopeSegs = elements.get('bcScopeSeg').children;
  if (scopeSegs.length !== 2) throw new Error('scope segmented control should have 2 segments, got ' + scopeSegs.length);
  if (ms.SolverBC.scope !== 'all') throw new Error('default node scope should be "all"');
  // switch to Boundary only → picking a big interior point must now be ignored
  scopeSegs[1].listeners.click[0]();                 // Boundary only
  if (ms.SolverBC.scope !== 'boundary') throw new Error('scope did not switch to boundary');
  bcButtons.children[0].listeners.click[0]();        // Add Point Load (boundary-scoped)
  // try an interior point (the imported filled rectangle centre ~ (400, 300))
  canvasEl.listeners.pointermove[0]({ clientX: 400, clientY: 300, pointerId: 7 });
  canvasEl.listeners.pointerdown[0]({ clientX: 400, clientY: 300, pointerId: 7 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));        // no node selected → toast, no modal
  if (bcModal.classList.contains('visible')) throw new Error('interior click should NOT open the modal in boundary scope');
  if (!/BOUNDARY node/i.test(elements.get('toast').textContent)) throw new Error('boundary-only miss toast wrong: ' + elements.get('toast').textContent);
  // box-select everything → only boundary nodes are kept
  bcButtons.children[0].listeners.click[0]();
  canvasEl.listeners.pointermove[0]({ clientX: 100, clientY: 100, pointerId: 8 });
  canvasEl.listeners.pointerdown[0]({ clientX: 100, clientY: 100, pointerId: 8 });
  canvasEl.listeners.pointermove[0]({ clientX: 700, clientY: 500, pointerId: 8 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!bcModal.classList.contains('visible')) throw new Error('boundary box-select should open the modal');
  if (!/node\(s\) selected/.test(textOf(elements.get('bcCount')))) throw new Error('modal count missing for boundary selection');
  elements.get('bcName').value = 'BoundaryLoad';
  bcField('fx').value = '50';
  bcField('fy').value = '0';
  clickById('btnBcOk');
  const bLoad = ms.App.state.pointLoads.find(p => p.name === 'BoundaryLoad');
  if (!bLoad) throw new Error('boundary point load not stored');
  if (!bLoad.nodeIds.length) throw new Error('boundary point load should have ≥1 node');
  for (const id of bLoad.nodeIds) {
    if (!ms.SolverBC.boundaryNodes.has(id)) throw new Error('boundary scope admitted interior node ' + id);
  }
  scopeSegs[0].listeners.click[0]();                 // back to All for the rest of the flow
  if (ms.SolverBC.scope !== 'all') throw new Error('scope did not return to all');
  console.log('OK: All/Boundary-only scope restricts point-load picking to boundary nodes');

  // support via box selection → type input (Fixed/Hinge)
  bcButtons.children[2].listeners.click[0]();     // Add Support
  canvasEl.listeners.pointermove[0]({ clientX: 400, clientY: 300, pointerId: 2 });
  canvasEl.listeners.pointerdown[0]({ clientX: 400, clientY: 300, pointerId: 2 });
  canvasEl.listeners.pointermove[0]({ clientX: 640, clientY: 460, pointerId: 2 }); // big box → many nodes
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!bcModal.classList.contains('visible')) throw new Error('support modal did not open');
  const typeSeg = elements.get('bcFields');
  const segBtns = [];
  (function collect(n) {
    for (const c of n.children || []) { if (c.classList && c.classList.contains('seg')) segBtns.push(c); collect(c); }
  })(typeSeg);
  const hingeBtn = segBtns.find(b => b.dataset.type === 'hinge');
  if (!hingeBtn) throw new Error('hinge option missing in support modal');
  hingeBtn.listeners.click[0]();                   // choose Hinge
  elements.get('bcName').value = 'Support_1';
  clickById('btnBcOk');
  const supportText = textOf(elements.get('solverBcList'));
  if (!/Support_1/.test(supportText)) throw new Error('support not listed: ' + supportText);
  const supNodes = ms.App.state.supports[0].nodeIds.length;
  if (supNodes < 2) throw new Error('box should select ≥2 support nodes, got ' + supNodes);
  if (ms.App.state.supports[0].type !== 'hinge') throw new Error('support type wrong');
  console.log('OK: support (hinge) added via box selection — ' + supNodes + ' nodes');

  // Pressure (boundary-edge, scalar like Poisson) + Escape cancels a live session
  bcButtons.children[1].listeners.click[0]();     // Add Pressure
  canvasEl.listeners.pointermove[0]({ clientX: 100, clientY: 100, pointerId: 9 });
  canvasEl.listeners.pointerdown[0]({ clientX: 100, clientY: 100, pointerId: 9 });
  canvasEl.listeners.pointermove[0]({ clientX: 700, clientY: 500, pointerId: 9 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Escape'));
  if (ms.SolverBC.selecting() !== false) throw new Error('Escape should cancel the live BC selection');
  console.log('OK: Escape cancels a live pressure selection');

  // re-add the pressure: box select (filtered to boundary edges) → scalar p
  bcButtons.children[1].listeners.click[0]();     // Add Pressure
  canvasEl.listeners.pointermove[0]({ clientX: 100, clientY: 100, pointerId: 10 });
  canvasEl.listeners.pointerdown[0]({ clientX: 100, clientY: 100, pointerId: 10 });
  canvasEl.listeners.pointermove[0]({ clientX: 700, clientY: 500, pointerId: 10 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!bcModal.classList.contains('visible')) throw new Error('pressure modal did not open');
  if (elements.get('bcTitle').textContent !== 'Pressure') throw new Error('pressure modal title wrong: ' + elements.get('bcTitle').textContent);
  elements.get('bcName').value = 'Pressure_1';
  bcField('value').value = '2';
  clickById('btnBcOk');
  if (bcModal.classList.contains('visible')) throw new Error('pressure modal did not close');
  const pressureText = textOf(elements.get('solverBcList'));
  if (!/Pressure_1/.test(pressureText)) throw new Error('pressure not listed: ' + pressureText);
  if (ms.App.state.pressures.length !== 1) throw new Error('pressure not in state');
  // every pressure edge must be a boundary edge (interior edges NOT selectable)
  const pBndKeys = new Set(ms.Mesh.boundaryEdges(ms.App.state.mesh).map(([a, b]) => (a < b ? a + '_' + b : b + '_' + a)));
  for (const g of ms.App.state.pressures) for (const [a, b] of g.edges) {
    const kk = a < b ? a + '_' + b : b + '_' + a;
    if (!pBndKeys.has(kk)) throw new Error('non-boundary edge under pressure: ' + kk);
  }
  console.log('OK: uniform pressure on boundary edges only (scalar p)');

  // delete the two point-load rows via the list ✕ (list deletion path)
  for (let i = 0; i < 2; i++) {
    const del = elements.get('solverBcList').children[0].children[1];
    del.listeners.click[0]();
  }
  if (ms.App.state.pointLoads.length !== 0) throw new Error('point load delete failed');
  if (!/Pressure_1/.test(textOf(elements.get('solverBcList')))) throw new Error('pressure should survive the delete');
  console.log('OK: group deletion works per row');

  /* ---------- Exercise: enter solve (elasticity) & run it ---------- */

  stageBtn('solve').listeners.click[0]();
  if (!stageEl.classList.contains('solve')) throw new Error('stage did not enter solve after 2 supports');
  if (elements.get('btnDemo').disabled !== true) throw new Error('Demo should be disabled in solve');
  console.log('OK: solve stage entered (elasticity)');

  // elastic params (E, ν, deform switch + slider) render in the solve panel
  const paramsWrap = elements.get('solverParams');
  if (paramsWrap.children.length !== 4) throw new Error('elastic should render E, nu, switch, slider → 4 children, got ' + paramsWrap.children.length);
  if (paramsWrap.children[0].children[1].value !== '200') throw new Error('E default wrong (should be 200 GPa): ' + paramsWrap.children[0].children[1].value);
  if (paramsWrap.children[1].children[1].value !== '0.3') throw new Error('nu default wrong: ' + paramsWrap.children[1].children[1].value);
  console.log('OK: elastic parameters render in the solve stage');

  // Solve (block dispatch through the unified controller)
  clickById('btnSolve');
  const esol = ms.App.state.solution;
  if (!esol || !esol.fields || !esol.fields.displacement) throw new Error('no elastic solution after Solve');
  if (!/Solved/.test(elements.get('toast').textContent)) throw new Error('elastic solve toast missing: ' + elements.get('toast').textContent);
  const nNodes = ms.App.state.mesh.nodes.length;
  for (const fid of ['displacement', 'strain', 'stress']) {
    const f = esol.fields[fid];
    if (!f || f.data.length !== nNodes || !(f.min <= f.max)) throw new Error('bad elastic field ' + fid);
  }
  console.log('OK: elasticity solves from model-stage BCs (max |u| ' + esol.fields.displacement.max.toExponential(1) + ')');

  // display-field switch re-renders legend (elastic nodal fields)
  const selField = elements.get('solverFieldSel');
  selField.value = 'stress';
  selField.listeners.change[0]();
  if (elements.get('solverLegendCaption').textContent !== 'Stress [MPa]') {
    throw new Error('stress caption wrong: ' + elements.get('solverLegendCaption').textContent);
  }
  console.log('OK: elastic display fields follow the field dropdown');

  // deformed view switch + log slider
  const deformSwitchCb = paramsWrap.children[2].children[1].children[0];
  const deformInput = paramsWrap.children[3].children[1];
  deformSwitchCb.checked = true;
  deformSwitchCb.listeners.change[0]();
  if (deformInput.disabled !== false) throw new Error('deformation slider should enable with the switch');
  if (ms.App.state.hideMeshFn() !== true) throw new Error('mesh should be hidden in deformed mode');
  const rafBefore = global._rafCount || 0;
  deformInput.value = '3';                        // 10^3 = ×1000
  deformInput.listeners.input[0]();
  if ((global._rafCount || 0) <= rafBefore) throw new Error('deformation slider did not re-render');
  if (ms.SolverUI.currentParams().deform !== 1000) throw new Error('deformation slider should map 10^3 → ×1000');
  deformSwitchCb.checked = false;
  deformSwitchCb.listeners.change[0]();
  console.log('OK: deformed view + log deformation slider work');

  /* ---------- Back to model: switch to Poisson (scalar BCs) ---------- */

  stageBtn('model').listeners.click[0]();
  if (!stageEl.classList.contains('model')) throw new Error('did not return to the model stage');
  selProblem.value = 'poisson';
  selProblem.listeners.change[0]();
  if (bcButtons.children.length !== 2) throw new Error('poisson should expose 2 BC buttons (dirichlet/neumann), got ' + bcButtons.children.length);
  if (!/Temperature/.test(bcButtons.children[0].textContent)) throw new Error('poisson BC btn 0 wrong: ' + bcButtons.children[0].textContent);
  if (!/Heat Flux/.test(bcButtons.children[1].textContent)) throw new Error('poisson BC btn 1 wrong: ' + bcButtons.children[1].textContent);
  if (ms.App.state.supports.length !== 0) throw new Error('switching problem must clear mechanical BCs');
  console.log('OK: problem switch → Poisson BC buttons (scalar), mechanical BCs cleared');

  // Poisson: Dirichlet Temperature on boundary edges (box selection)
  stageBtn('solve').listeners.click[0]();
  if (stageEl.classList.contains('solve')) throw new Error('should not enter solve for Poisson without a Dirichlet BC');
  if (!/Temperature|Dirichlet/i.test(elements.get('toast').textContent)) throw new Error('poisson gating toast wrong: ' + elements.get('toast').textContent);
  console.log('OK: Poisson solve gated until a Dirichlet group exists');

  bcButtons.children[0].listeners.click[0]();     // Add Temperature
  canvasEl.listeners.pointermove[0]({ clientX: 100, clientY: 100, pointerId: 11 });
  canvasEl.listeners.pointerdown[0]({ clientX: 100, clientY: 100, pointerId: 11 });
  canvasEl.listeners.pointermove[0]({ clientX: 700, clientY: 500, pointerId: 11 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!bcModal.classList.contains('visible')) throw new Error('temperature modal did not open');
  elements.get('bcName').value = 'HotEdge';
  const valField = bcField('value'); valField.value = '100';
  clickById('btnBcOk');
  if (!/HotEdge/.test(textOf(elements.get('solverBcList')))) throw new Error('temperature group not listed');
  if (ms.SolverBC.groups.length !== 1) throw new Error('expected 1 scalar BC group, got ' + ms.SolverBC.groups.length);

  // every selected edge must be a boundary edge (interior edges are NOT selectable)
  const bndKeys = new Set(ms.Mesh.boundaryEdges(ms.App.state.mesh).map(([a, b]) => (a < b ? a + '_' + b : b + '_' + a)));
  for (const g of ms.SolverBC.groups) for (const [a, b] of g.edges) {
    const kk = a < b ? a + '_' + b : b + '_' + a;
    if (!bndKeys.has(kk)) throw new Error('non-boundary edge selected: ' + kk);
  }
  console.log('OK: temperature (Dirichlet) group on boundary edges only, Solve enabled');

  // Heat Flux (Neumann) group + list delete
  bcButtons.children[1].listeners.click[0]();
  canvasEl.listeners.pointermove[0]({ clientX: 100, clientY: 100, pointerId: 12 });
  canvasEl.listeners.pointerdown[0]({ clientX: 100, clientY: 100, pointerId: 12 });
  canvasEl.listeners.pointermove[0]({ clientX: 700, clientY: 500, pointerId: 12 });
  canvasEl.listeners.pointerup[0]({});
  global._listeners.keydown[0](key('Enter'));
  if (!bcModal.classList.contains('visible')) throw new Error('flux modal did not open');
  elements.get('bcName').value = 'Flux1';
  bcField('value').value = '50';
  clickById('btnBcOk');
  if (ms.SolverBC.groups.length !== 2) throw new Error('expected 2 BC groups, got ' + ms.SolverBC.groups.length);
  const fluxRowDel = elements.get('solverBcList').children[1].children[1]; // second row = Flux1
  fluxRowDel.listeners.click[0]();
  if (ms.SolverBC.groups.length !== 1) throw new Error('group delete failed, got ' + ms.SolverBC.groups.length);
  console.log('OK: heat flux (Neumann) group added then deleted from the list');

  /* ---------- Exercise: real Poisson solve (stage 3) ---------- */

  stageBtn('solve').listeners.click[0]();
  if (!stageEl.classList.contains('solve')) throw new Error('did not enter solve for Poisson');

  // The constant-Dirichlet check requires f = 0 (with the new default
  // f = 10 the interior would heat up above 100); set it explicitly.
  const fInput = paramsWrap.children[1].children[1];
  fInput.value = '0';
  fInput.listeners.input[0]();
  clickById('btnSolve');
  const sol = ms.App.state.solution;
  if (!sol || !sol.fields || !sol.fields.temperature) throw new Error('no Poisson solution after Solve');
  const tField = sol.fields.temperature;
  if (!(Math.abs(tField.min - 100) < 1e-6 && Math.abs(tField.max - 100) < 1e-6)) {
    throw new Error('constant-Dirichlet solution wrong: ' + tField.min + '..' + tField.max);
  }
  if (sol.fields.flux.max > 1e-6) throw new Error('flux should vanish for a constant solution, got ' + sol.fields.flux.max);
  if (!/Solved/.test(elements.get('toast').textContent)) throw new Error('poisson solve toast missing: ' + elements.get('toast').textContent);
  if (elements.get('solverLegendMin').textContent === '—') throw new Error('legend min not updated after solve');
  console.log('OK: real Poisson solve runs (constant Dirichlet reproduced, u=' + tField.min + ')');

  // switching the display field re-renders heatmap (flux legend 0..0)
  const rafSwitch = global._rafCount || 0;
  selField.value = 'flux';
  selField.listeners.change[0]();
  if ((global._rafCount || 0) <= rafSwitch) throw new Error('field switch did not re-render (stale heatmap)');
  if (elements.get('solverLegendCaption').textContent !== 'Heat Flux [W/m²]') throw new Error('legend caption not flux: ' + elements.get('solverLegendCaption').textContent);
  if (elements.get('solverLegendMin').textContent !== '0' || elements.get('solverLegendMax').textContent !== '0') {
    throw new Error('legend should show flux range 0..0, got ' +
      elements.get('solverLegendMin').textContent + '..' + elements.get('solverLegendMax').textContent);
  }
  console.log('OK: display-field switch re-renders heatmap (flux legend 0..0)');

  // solve-phase top-bar keeps Reset View + Hide Panels usable
  const btnPanels = elements.get('btnPanels');
  btnPanels.listeners.click[0]();                  // hide
  if (!stageEl.classList.contains('ui-off')) throw new Error('Hide Panels did not hide');
  btnPanels.listeners.click[0]();                  // restore
  if (stageEl.classList.contains('ui-off')) throw new Error('panels did not restore');
  clickById('btnResetView');
  console.log('OK: solve stage keeps Reset View & Hide Panels');

  // problem is LOCKED in solve: the problem dropdown lives in the MODEL
  // panel only, so it is unreachable while stage.solve hides that panel.
  // Switching problems therefore requires returning to the model stage.
  stageBtn('model').listeners.click[0]();          // back to model (allowed)
  if (!stageEl.classList.contains('model')) throw new Error('did not return to model');
  selProblem.value = 'elastic';                    // cleanup: restore default problem
  selProblem.listeners.change[0]();
  console.log('OK: problem switching requires returning to the model stage');

  console.log('DOM smoke OK');
})().catch(e => {
  console.error('DOM smoke FAIL: ' + e.message);
  process.exit(1);
});
