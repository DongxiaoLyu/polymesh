/* ============================================================
   solver-ui.js — Shared solve-phase shell (NOT a problem block)
   ============================================================
   Drives the solver components revealed in the 'solve' phase:
     - problem-type dropdown   (#solverProblemSel)
     - heatmap display field   (#solverFieldSel)
     - Solve button            (#btnSolve)
     - heatmap legend          (#solverInfoPanel)

   Each solver block (js/solver/<problem>/) registers its metadata via
   MeshStudio.SolverUI.registerBlock() so the shell can list the problem,
   populate the field dropdown and draw the matching legend — without
   app.js ever knowing any solver details. The block's own controller
   additionally registers 'solve' phase handlers via MeshStudio.App.

   Depends on:  app.js (window.MeshStudio.App)
   Exposes:     window.MeshStudio.SolverUI = { registerBlock, blocks }
   ============================================================ */

(function (global) {
  'use strict';

  const App = global.MeshStudio.App;
  const state = App.state;

  /* ---------- DOM refs ---------- */

  const selProblem = document.getElementById('solverProblemSel');
  const selField   = document.getElementById('solverFieldSel');
  const btnSolve   = document.getElementById('btnSolve');
  const paramsSection = document.getElementById('solverParamsSection');
  const paramsWrap = document.getElementById('solverParams');
  const legendBar  = document.getElementById('solverLegendBar');
  const legendMin  = document.getElementById('solverLegendMin');
  const legendMax  = document.getElementById('solverLegendMax');
  const legendCap  = document.getElementById('solverLegendCaption');

  /* ---------- Solver block registry ----------
     Each block meta: { id, label, available, fields: [{ id, label, unit,
     legend }] }. `available:false` blocks appear in the dropdown but are
     disabled ("coming soon") until their module ships. */

  const blocks = {};

  // Called whenever the active problem block changes (solver-bc.js uses it
  // to reset its boundary-condition groups: different problem ⇒ different BCs).
  let onProblemChange = null;
  function setProblemChangeHandler(fn) { onProblemChange = fn; }

  function registerBlock(meta) {
    blocks[meta.id] = meta;
    renderProblemOptions();
  }

  /* ---------- Dropdowns ---------- */

  /* Full "problem changed" pipeline: re-render fields, params and notify
     listeners (solver-bc.js resets its BC groups on this). */
  function onProblemChanged() {
    renderFieldOptions();
    renderParams();
    if (onProblemChange) onProblemChange();
  }

  function renderProblemOptions() {
    if (!selProblem) return;
    selProblem.replaceChildren();
    const ids = Object.keys(blocks);
    for (const id of ids) {
      const b = blocks[id];
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = b.label + (b.available ? '' : ' (coming soon)');
      opt.disabled = !b.available;
      selProblem.appendChild(opt);
    }
    if (ids.length) {
      const firstId = ids.find(id => blocks[id].available) || ids[0];
      selProblem.value = firstId;
    }
    onProblemChanged();
  }

  function currentBlock() {
    return (selProblem && blocks[selProblem.value]) || null;
  }

  /* ---------- Solver parameters (per block, e.g. k, f) ----------
     Values live in `paramValues` (current block only); a block's solve()
     reads them via SolverUI.currentParams(). Switching problems resets
     them to the new block's defaults. */

  let paramValues = {};

  function renderParams() {
    if (!paramsWrap) return;
    paramsWrap.replaceChildren();
    paramValues = {};
    const b = currentBlock();
    const has = !!(b && b.params && b.params.length);
    if (paramsSection) paramsSection.style.display = has ? '' : 'none';
    if (!has) return;
    for (const p of b.params) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const lbl = document.createElement('span');
      lbl.className = 'param-label';
      lbl.textContent = p.label + (p.unit ? ' [' + p.unit + ']' : '');
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'cond-input param-input';
      input.step = 'any';
      input.value = String(p.value);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        paramValues[p.id] = isFinite(v) ? v : p.value; // invalid → back to default
      });
      row.appendChild(lbl);
      row.appendChild(input);
      paramsWrap.appendChild(row);
      paramValues[p.id] = p.value;
      if (p.note) {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = p.note;
        paramsWrap.appendChild(note);
      }
    }
  }

  function renderFieldOptions() {
    if (!selField) return;
    selField.replaceChildren();
    const b = currentBlock();
    if (!b || !b.fields.length) { selField.disabled = true; updateLegend(); return; }
    selField.disabled = false;
    for (const f of b.fields) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.label + (f.unit && f.unit !== '—' ? ' [' + f.unit + ']' : '');
      selField.appendChild(opt);
    }
    selField.value = b.fields[0].id;
    updateLegend();
  }

  /* ---------- Heatmap legend ---------- */

  function currentField() {
    const b = currentBlock();
    if (!b || !selField || !selField.value) return null;
    return b.fields.find(f => f.id === selField.value) || null;
  }

  function fmtNum(v) {
    if (!Number.isFinite(v)) return '—';
    const s = v.toFixed(4);
    return s.replace(/\.?0+$/, '') || '0';
  }

  function updateLegend() {
    if (!legendBar) return;
    const f = currentField();
    if (f && f.legend) {
      legendBar.style.background = f.legend;
      legendCap.textContent = f.label + (f.unit && f.unit !== '—' ? ' [' + f.unit + ']' : '');
      // Numeric range appears once a solve exists: prefer the per-field
      // range (state.solution.fields[fieldId]), fall back to .min/.max.
      const sol = state.solution;
      const range = (sol && sol.fields && f) ? sol.fields[f.id] : null;
      legendMin.textContent = range ? fmtNum(range.min) : (sol ? fmtNum(sol.min) : '—');
      legendMax.textContent = range ? fmtNum(range.max) : (sol ? fmtNum(sol.max) : '—');
    } else {
      legendBar.style.background = 'linear-gradient(to top, #ccc, #ccc)';
      legendCap.textContent = 'Select a problem & display field';
      legendMin.textContent = '—';
      legendMax.textContent = '—';
    }
  }

  /* ---------- Phase plugin (into app.js) ---------- */

  App.registerPhase('solve', {
    enter() {
      state.meshPlain = true; // plain mesh: no fills / interior edges, only
                              // the outer boundary outline over the heatmap
      updateLegend();         // re-apply the current selection on entry
    },
    exit() {
      state.meshPlain = false; // restore the preprocessor mesh rendering
    },
  });

  /* ---------- Wiring ---------- */

  if (selProblem) selProblem.addEventListener('change', onProblemChanged);
  // A field switch must re-render the canvas too: the heatmap reads the
  // current field on every frame, but a render has to be scheduled.
  if (selField)   selField.addEventListener('change', () => { updateLegend(); App.scheduleRender(); });
  // The Solve button's blocked/enabled state is managed by solver-bc.js
  // (gated on the active block's BC requirements).

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.SolverUI = {
    registerBlock,
    blocks,
    setProblemChangeHandler,
    currentProblem: () => (selProblem ? selProblem.value : null),
    currentParams: () => ({ ...paramValues }),
    currentField: () => (selField ? selField.value : null),
    refreshLegend: updateLegend,
    solve: null,           // set by a solver block to replace the placeholder click
  };

  /* ============================================================
     Scaffolding metadata for the planned blocks (data only — no
     numerical code). A block becomes selectable once it ships; its
     real metadata can be re-registered from the block itself.

     Gradients are VERTICAL ('to top'): the first color is the minimum
     (bottom of the legend bar), the last is the maximum (top).
     ============================================================ */

  const GRAD_TEMP = 'linear-gradient(to top, #313695, #4575b4, #74add1, #abd9e9, #e0f3f8, #fee090, #fdae61, #f46d43, #d73027, #a50026)'; // RdBu: cold→hot
  const GRAD_FLUX = 'linear-gradient(to top, #440154, #414487, #2a788e, #22a884, #7ad151, #fde725)';                                   // Viridis
  const GRAD_DISP = 'linear-gradient(to top, #f7fbff, #deebf7, #c6dbef, #9ecae1, #6baed6, #4292c6, #2171b5, #08519c, #08306b)';        // Blues
  const GRAD_STRAIN = 'linear-gradient(to top, #ffffd9, #edf8b1, #c7e9b4, #7fcdbb, #41b6c4, #1d91c0, #225ea8, #253494, #081d58)';     // YlGnBu
  const GRAD_STRESS = 'linear-gradient(to top, #a50026, #d73027, #f46d43, #fdae61, #fee08b, #ffffbf, #d9ef8b, #a6d96a, #66bd63, #1a9850, #006837)'; // RdYlGn
  const GRAD_VEL = 'linear-gradient(to top, #0d0887, #6a00a8, #b12a90, #e16462, #fca636, #f0f921)';                                   // Plasma
  const GRAD_ACC = 'linear-gradient(to top, #000004, #1b0c41, #4a0c6b, #781c6d, #a52c60, #cf4446, #ed6925, #fb9b06, #f7d13d)';        // Magma

  registerBlock({
    id: 'poisson',
    label: '2D Poisson Equation',
    available: true, // first block under construction
    fields: [
      { id: 'temperature', label: 'Temperature', unit: '°C',    legend: GRAD_TEMP },
      { id: 'flux',        label: 'Heat Flux',   unit: 'W/m²',  legend: GRAD_FLUX },
    ],
    // Solver boundary conditions — entered in the solve phase on BOUNDARY
    // edges only (js/solver/solver-bc.js). Unassigned edges default to
    // zero-flux Neumann (insulated); minGroups >= 1 enforces uniqueness.
    bcs: [
      { id: 'dirichlet', label: 'Temperature', valueLabel: 'u', unit: '°C',    minGroups: 1 },
      { id: 'neumann',   label: 'Heat Flux',   valueLabel: 'q', unit: 'W/m²',  minGroups: 0 },
    ],
    // Material / source parameters — user-editable with defaults. f is a
    // uniform heat source over the WHOLE domain (not per-region); k is the
    // thermal conductivity. Read by the block via SolverUI.currentParams().
    params: [
      { id: 'k', label: 'Conductivity k', unit: 'W/(m·°C)', value: 10 },
      { id: 'f', label: 'Heat Source f', unit: 'W/m²', value: 10,
        note: 'Uniform over the whole domain' },
    ],
  });

  registerBlock({
    id: 'elastic',
    label: '2D Elasticity',
    available: false,
    fields: [
      { id: 'displacement', label: 'Displacement', unit: 'mm',  legend: GRAD_DISP },
      { id: 'strain',       label: 'Strain',       unit: '—',   legend: GRAD_STRAIN },
      { id: 'stress',       label: 'Stress',       unit: 'MPa', legend: GRAD_STRESS },
    ],
  });

  registerBlock({
    id: 'dynamics',
    label: '2D Dynamics',
    available: false,
    fields: [
      { id: 'displacement', label: 'Displacement', unit: 'mm',    legend: GRAD_DISP },
      { id: 'velocity',     label: 'Velocity',     unit: 'mm/s',  legend: GRAD_VEL },
      { id: 'acceleration', label: 'Acceleration', unit: 'mm/s²', legend: GRAD_ACC },
      { id: 'stress',       label: 'Stress',       unit: 'MPa',   legend: GRAD_STRESS },
    ],
  });
})(window);
