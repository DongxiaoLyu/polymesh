/* ============================================================
   solver-ui.js — Shared solver shell (NOT a problem block)
   ============================================================
   Owns the solver metadata registry & the shared solve-phase UI:
     - problem-type dropdown (#solverProblemSel — lives in the MODEL
       panel: stage 2; switching problems resets BCs & params)
     - heatmap display field   (#solverFieldSel, stage 3)
     - parameters section      (#solverParams, stage 3)
     - Solve button            (#btnSolve, stage 3)
     - heatmap legend          (#solverInfoPanel, stage 3)

   Each solver block (js/solver/<problem>/) registers its metadata via
   MeshStudio.SolverUI.registerBlock() so the shell can list the problem,
   populate the field dropdown and draw the matching legend — without
   app.js ever knowing any solver details. BC setup itself lives in the
   unified BC controller (js/solver/solver-bc.js, registered on the
   'model' phase); the solve-phase panel here only shows the selected
   problem's fields/params/Solve.

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

  /* ---------- Colormaps (single source of truth) ----------
     Gradients are VERTICAL ('to top'): the first color is the minimum
     (bottom of the legend bar), the last is the maximum (top). Exported
     as SolverUI.gradients so every block picks its palette from here
     instead of re-typing CSS strings.

     PALETTE POLICY (half-unified, aligned with the mVEM/MATLAB-default
     look of B. Xu's VEM codes, whose showsolution never overrides the
     colormap → parula since R2014b):
       - magnitude fields (|u|, equivalent strain, von Mises, |q|, and
         the future dynamics magnitudes) → ONE perceptually-uniform
         sequential map (GRAD_MAG, Viridis — a parula-style colormap);
       - fields with a natural signed meaning / zero (temperature) →
         the diverging cold→hot RdBu (GRAD_TEMP).
  */
  const GRAD_TEMP = 'linear-gradient(to top, #313695, #4575b4, #74add1, #abd9e9, #e0f3f8, #fee090, #fdae61, #f46d43, #d73027, #a50026)'; // RdBu: cold→hot (temperature)
  const GRAD_MAG = 'linear-gradient(to top, #440154, #414487, #2a788e, #22a884, #7ad151, #fde725)';                                    // Viridis: uniform sequential (parula-style)

  /* ---------- Solver block registry ----------
     Each block meta: { id, label, available, fields: [{ id, label, unit,
     legend }] }. `available:false` blocks appear in the dropdown but are
     disabled ("coming soon") until their module ships. */

  const blocks = {};

  // Problem-change listeners. Called whenever the active problem block
  // changes: solver-bc.js resets its boundary-condition groups on this
  // (different problem ⇒ different BCs); solver blocks may register their
  // own listeners via setProblemChangeHandler (multiple are CHAINED).
  const problemChangeHandlers = [];
  function setProblemChangeHandler(fn) { problemChangeHandlers.push(fn); }

  function registerBlock(meta) {
    blocks[meta.id] = meta;
    renderProblemOptions();
  }

  /* ---------- Dropdowns ---------- */

  /* Full "problem changed" pipeline: drop the stale solution (different
     problem ⇒ its fields/range no longer apply), re-render fields + params
     and notify the listeners (solver-bc.js resets its BC groups on this). */
  function onProblemChanged() {
    if (state.solution) {
      state.solution = null;   // node ids are per-problem semantics — clear
      updateLegend();          // …and reset the legend range to '—'
    }
    renderFieldOptions();
    renderParams();
    for (const fn of problemChangeHandlers) fn();
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

    // Built input elements; a param with `enabledBy: <switchId>` stays
    // disabled until that switch is ON.
    const controls = []; // { input, enabledBy }

    function applyEnableStates() {
      for (const c of controls) {
        if (!c.enabledBy) continue;
        c.input.disabled = !paramValues[c.enabledBy];
      }
    }

    for (const p of b.params) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const lbl = document.createElement('span');
      lbl.className = 'param-label';
      lbl.textContent = p.label + (p.unit ? ' [' + p.unit + ']' : '');
      row.appendChild(lbl);

      if (p.type === 'switch') {
        // iOS-style toggle switch (same .switch markup as the app's toggles)
        const sw = document.createElement('label');
        sw.className = 'switch';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!p.value;
        const pill = document.createElement('span');
        pill.className = 'slider';
        sw.appendChild(cb);
        sw.appendChild(pill);
        cb.addEventListener('change', () => {
          paramValues[p.id] = cb.checked;
          applyEnableStates();
          App.scheduleRender();
        });
        row.appendChild(sw);
        paramsWrap.appendChild(row);
        paramValues[p.id] = !!p.value;
        controls.push({ input: cb, enabledBy: null });
        if (p.note) {
          const note = document.createElement('p');
          note.className = 'hint';
          note.textContent = p.note;
          paramsWrap.appendChild(note);
        }
        continue;
      }

      if (p.type === 'slider') {
        // Logarithmic slider: the input VALUE is the exponent and the param
        // value is base^exponent (×1, ×10, ×100, …). The track fill colour
        // (--val) follows the knob on every drag. No hint line is emitted
        // unless the block declares p.note.
        const base = p.logBase || 10;
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'param-range';
        input.min = String(p.min != null ? p.min : 0);
        input.max = String(p.max != null ? p.max : 4);
        input.step = String(p.step != null ? p.step : 0.1);
        input.value = String(p.value != null ? p.value : 2);
        row.appendChild(input);
        const note = p.note ? document.createElement('p') : null;
        if (note) note.className = 'hint';
        const fill = () => {
          const mn = parseFloat(input.min), mx = parseFloat(input.max);
          const v = parseFloat(input.value);
          const pct = mx > mn ? ((v - mn) / (mx - mn)) * 100 : 0;
          input.style.setProperty('--val', pct + '%');
        };
        const apply = () => {
          const v = parseFloat(input.value);
          const exp = Number.isFinite(v) ? v : (p.value != null ? p.value : 2);
          paramValues[p.id] = Math.pow(base, exp);
          if (note) note.textContent = p.note + ' — × ' + Math.round(Math.pow(base, exp));
          fill();
          App.scheduleRender(); // e.g. the deformed heatmap follows the scale
        };
        input.addEventListener('input', apply);
        paramsWrap.appendChild(row);
        if (note) paramsWrap.appendChild(note);
        controls.push({ input, enabledBy: p.enabledBy || null });
        apply(); // init paramValues (+ note text) + track fill
        continue;
      }

      // Plain numeric input (E, nu, k, f, …)
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'cond-input param-input';
      input.step = 'any';
      input.value = String(p.value);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        paramValues[p.id] = isFinite(v) ? v : p.value; // invalid → back to default
        App.scheduleRender(); // params may drive the canvas
      });
      row.appendChild(input);
      paramsWrap.appendChild(row);
      paramValues[p.id] = p.value;
      controls.push({ input, enabledBy: p.enabledBy || null });
      if (p.note) {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = p.note;
        paramsWrap.appendChild(note);
      }
    }
    applyEnableStates();
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

  /* ============================================================
     Shared heatmap toolkit (colormap sampling + per-element uniform
     rendering) — used by every solver block so the look stays
     identical and the math lives in ONE place.
     ============================================================ */

  /** Parse a 'linear-gradient(to top, #hex, …)' string → [[r,g,b], …]. */
  function heatParse(css) {
    const hex = /#[0-9a-fA-F]{6}/g;
    const stops = [];
    let m;
    while ((m = hex.exec(css)) !== null) {
      const v = parseInt(m[0].slice(1), 16);
      stops.push([(v >> 16) & 255, (v >> 8) & 255, v & 255]);
    }
    return stops;
  }

  /** Sample a stop list at t ∈ [0,1] → [r,g,b] (arrays keep the per-pixel
      interpolation math cheap; stringify only at the last fill step). */
  function heatSample(stops, t) {
    if (!stops.length) return [128, 128, 128];
    if (stops.length === 1) return stops[0].slice();
    const pos = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(pos));
    const fr = pos - i;
    const a = stops[i], b = stops[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * fr),
      Math.round(a[1] + (b[1] - a[1]) * fr),
      Math.round(a[2] + (b[2] - a[2]) * fr),
    ];
  }

  /** Field value → [r,g,b] via the stops, normalised by the field range. */
  function heatColor(stops, min, max, v) {
    const span = max - min;
    return heatSample(stops, span > 1e-30 ? (v - min) / span : 0.5);
  }

  /** [r,g,b] → 'rgb(r,g,b)'. */
  function heatRgb(c) {
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  /**
   * Per-ELEMENT heatmap for nodal fields: average the node values of each
   * polygon and fill the WHOLE element with ONE colour (colour of the
   * mean value via the colormap). Uniform fill makes the underlying cell
   * geometry readable — you can tell square / triangle / hexagonal /
   * clipped boundary elements apart — and there are no triangle seams to
   * begin with.
   *
   * xyOf(i)    → {x, y}   (node position; may be deformed)
   * valueOf(i) → number  (node field value; cached per node)
   */
  function heatElements(ctx, mesh, xyOf, valueOf, stops, min, max) {
    const elements = mesh.elements;
    if (!elements.length) return;
    const cache = new Array(mesh.nodes.length).fill(null);
    const valOf = id => {
      let v = cache[id];
      if (v == null) v = cache[id] = valueOf(id);
      return v;
    };
    for (let e = 0; e < elements.length; e++) {
      const ids = elements[e].nodeIds;
      const Nv = ids.length;
      let sum = 0;
      for (let i = 0; i < Nv; i++) sum += valOf(ids[i]);
      ctx.fillStyle = heatRgb(heatColor(stops, min, max, sum / Nv));
      const p0 = xyOf(ids[0]);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < Nv; i++) {
        const p = xyOf(ids[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  /* ---------- Public API ---------- */

  global.MeshStudio = global.MeshStudio || {};
  global.MeshStudio.SolverUI = {
    registerBlock,
    blocks,
    setProblemChangeHandler,
    gradients: { temperature: GRAD_TEMP,
                 flux: GRAD_MAG, displacement: GRAD_MAG, strain: GRAD_MAG,
                 stress: GRAD_MAG, velocity: GRAD_MAG, acceleration: GRAD_MAG },
    heat: { parse: heatParse, sample: heatSample, color: heatColor,
            rgb: heatRgb, elements: heatElements },
    currentProblem: () => (selProblem ? selProblem.value : null),
    currentParams: () => ({ ...paramValues }),
    currentField: () => (selField ? selField.value : null),
    refreshLegend: updateLegend,
    // A solver block attaches its real solve() to blocks[<id>].solve
    // (per-problem dispatch in solver-bc.js). `solve` stays as a null
    // legacy slot and is no longer used by the shell.
    solve: null,
  };

  /* ============================================================
     Scaffolding metadata for the solver blocks (data only — no
     numerical code):
       - elastic & dynamics below are 'coming soon' PLACEHOLDERS
         (available:false). Once they ship, their real metadata is
         re-registered from the block itself (colormaps come from
         the GRAD_* constants exported above).
       - poisson (available:true) is the EXCEPTION: its scaffold IS
         the real metadata — js/solver/poisson/ui.js never calls
         registerBlock, it only wires blocks.poisson.solve. Change
         its fields/params/bcs HERE (keep DEVELOPMENT.md in sync).
     ============================================================ */

  // NOTE — registration order also defines the dropdown order and the
  // default problem (first available block). Elasticity is registered
  // first on purpose so it becomes the DEFAULT solver once it ships
  // (its real metadata is re-registered by js/solver/elastic/ui.js).

  registerBlock({
    id: 'elastic',
    label: '2D Elasticity',
    available: false,
    fields: [
      { id: 'displacement', label: 'Displacement', unit: 'mm',  legend: GRAD_MAG },
      { id: 'strain',       label: 'Strain',       unit: '—',   legend: GRAD_MAG },
      { id: 'stress',       label: 'Stress',       unit: 'MPa', legend: GRAD_MAG },
    ],
  });

  registerBlock({
    id: 'poisson',
    label: '2D Poisson Equation',
    available: true, // this scaffold IS the real metadata — poisson/ui.js
                     // never re-registers (only wires blocks.poisson.solve)
    fields: [
      { id: 'temperature', label: 'Temperature', unit: '°C',    legend: GRAD_TEMP },
      { id: 'flux',        label: 'Heat Flux',   unit: 'W/m²',  legend: GRAD_MAG },
    ],
    // Unified-BC metadata (consumed by js/solver/solver-bc.js in the
    // 'model' stage): scalar BCs on boundary edges only. Unassigned
    // boundary edges default to zero-flux Neumann (insulated); the
    // scalar store keeps the groups and minGroups>=1 enforces the
    // Dirichlet requirement for a unique solution.
    bcs: [
      { id: 'dirichlet', label: 'Temperature', store: 'scalar', target: 'boundaryEdges',
        input: 'scalar', valueLabel: 'u', unit: '°C', defaultName: 'Temperature', minGroups: 1 },
      { id: 'neumann',   label: 'Heat Flux',   store: 'scalar', target: 'boundaryEdges',
        input: 'scalar', valueLabel: 'q', unit: 'W/m²', defaultName: 'Flux', minGroups: 0 },
    ],
    bcDefault: 'Unassigned boundary edges default to zero-flux Neumann (insulated).',
    // Material / source parameters — user-editable with defaults. The
    // k=10 / f=10 values below are the LIVE shipped defaults (this block
    // never re-registers; poisson/ui.js's k=1 / f=0 fallbacks are only a
    // defensive path). dom-smoke.js overrides f->0 for its constant-
    // Dirichlet check — change these in lockstep with it & DEVELOPMENT.md.
    // f is a uniform heat source over the WHOLE domain (not per-region);
    // k is the thermal conductivity. Read via SolverUI.currentParams().
    params: [
      { id: 'k', label: 'Conductivity k', unit: 'W/(m·°C)', value: 10 },
      { id: 'f', label: 'Heat Source f', unit: 'W/m²', value: 10,
        note: 'Uniform over the whole domain' },
    ],
  });

  registerBlock({
    id: 'dynamics',
    label: '2D Dynamics',
    available: false,
    fields: [
      { id: 'displacement', label: 'Displacement', unit: 'mm',    legend: GRAD_MAG },
      { id: 'velocity',     label: 'Velocity',     unit: 'mm/s',  legend: GRAD_MAG },
      { id: 'acceleration', label: 'Acceleration', unit: 'mm/s²', legend: GRAD_MAG },
      { id: 'stress',       label: 'Stress',       unit: 'MPa',   legend: GRAD_MAG },
    ],
  });
})(window);
