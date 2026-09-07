/* ============================================================
   solver-bc.js — Solver boundary conditions (scalar problems)
   ============================================================
   The pre-processing BCs (loads / supports) are mechanics semantics
   and do NOT apply to the Poisson equation. Solver BCs live in the
   solve phase and are declared by each block via
   SolverUI.registerBlock({ bcs: [...] }).

   Conventions (classic FEM, Poisson):
     - BCs are set ONLY on the domain BOUNDARY — edges used by exactly
       one element (see computeBoundary below). Interior edges can
       never be selected.
     - Unassigned boundary edges default to ZERO-FLUX NEUMANN
       (insulated): nothing is stored for them.
     - A block may require a minimum number of groups (Poisson needs
       at least one Dirichlet/Temperature group for uniqueness); the
       Solve button stays disabled until satisfied.

   Interaction mirrors the pre-processing BC phase: click or box-select
   boundary edges → Enter → name + scalar value → named group; Esc
   cancels. Groups are drawn on the canvas through state.renderHooks.

   Depends on:  app.js, renderer.js (renderHooks), solver-ui.js
   Exposes:     window.MeshStudio.SolverBC = { groups (read-only) }
   ============================================================ */

(function (global) {
  'use strict';

  const App = global.MeshStudio.App;
  const state = App.state;
  const G = global.MeshStudio.Geometry;
  const Mesh = global.MeshStudio.Mesh;
  const Constants = global.MeshStudio.Constants;
  const SolverUI = global.MeshStudio.SolverUI;

  /* ---------- DOM refs ---------- */

  const bcButtons  = document.getElementById('solverBcButtons');
  const bcList     = document.getElementById('solverBcList');
  const bcSection  = document.getElementById('solverBcSection');
  const modal      = document.getElementById('solverCondModal');
  const modalTitle = document.getElementById('solverCondTitle');
  const modalName  = document.getElementById('solverCondName');
  const modalValue = document.getElementById('solverCondValue');
  const modalValLbl = document.getElementById('solverCondValueLabel');
  const modalCount = document.getElementById('solverCondCount');
  const btnOk      = document.getElementById('btnSolverCondOk');
  const btnCancel  = document.getElementById('btnSolverCondCancel');
  const btnSolve   = document.getElementById('btnSolve');

  /* ---------- Solver BC state (per mesh) ---------- */

  let groups = [];        // { bc, name, edges:[[a,b],...], value }
  let sel = null;         // active selection session: { bcId, edges:Map, box, dragStart, dragging }
  let boundary = [];      // ring-ordered boundary edges [{a, b}] of the current mesh
  let boundaryPairs = []; // [[a, b], ...] view of boundary for Mesh.nearestEdge/edgesInBox
  let boundarySet = null; // Set of undirected keys 'a_b'
  let lastMesh = null;

  const worldDist = d => d / state.view.zoom;

  function currentBlock() {
    return SolverUI.blocks[SolverUI.currentProblem()] || null;
  }

  function blockBcMeta(bcId) {
    const b = currentBlock();
    return (b && b.bcs && b.bcs.find(x => x.id === bcId)) || null;
  }

  /* ---------- Boundary extraction ----------
     The domain boundary = edges used by exactly ONE element. Edges are
     stored in the ring order of their element (elements are CCW), so the
     outward normal of edge (a→b) is normalize(b.y - a.y, a.x - b.x). */

  function computeBoundary() {
    const mesh = state.mesh;
    boundary = [];
    boundaryPairs = [];
    boundarySet = new Set();
    if (!mesh) return;
    const count = new Map(); // key -> { a, b (ring order), n }
    for (const el of mesh.elements) {
      const ids = el.nodeIds;
      for (let i = 0; i < ids.length; i++) {
        const a = ids[i], b = ids[(i + 1) % ids.length];
        const k = a < b ? a + '_' + b : b + '_' + a;
        const e = count.get(k);
        if (e) e.n++;
        else count.set(k, { a, b, n: 1 });
      }
    }
    for (const e of count.values()) {
      if (e.n === 1) {
        boundary.push(e);
        boundaryPairs.push([e.a, e.b]);
        boundarySet.add(e.a < e.b ? e.a + '_' + e.b : e.b + '_' + e.a);
      }
    }
  }

  /* ---------- Selection session ---------- */

  function startBcSelect(bcId) {
    if (state.phase !== 'solve') return;
    cancelSel();
    sel = { bcId, edges: new Map(), box: null, dragStart: null, dragging: false };
    App.setHint('Click or box-select BOUNDARY edges · Enter to confirm · Esc to cancel');
    App.scheduleRender();
  }

  function cancelSel() {
    if (!sel) return;
    sel = null;
    App.setHint();
    App.scheduleRender();
  }

  function clickSelectEdge(p) {
    const idx = Mesh.nearestEdge(boundaryPairs, state.mesh, p, worldDist(Constants.BC_SELECT_RADIUS));
    if (idx < 0) { App.showToast('No boundary edge near the click'); return; }
    const e = boundary[idx];
    const k = e.a < e.b ? e.a + '_' + e.b : e.b + '_' + e.a;
    if (sel.edges.has(k)) sel.edges.delete(k);
    else sel.edges.set(k, [e.a, e.b]);
  }

  function applyBox(box) {
    for (const idx of Mesh.edgesInBox(boundaryPairs, state.mesh, box)) {
      const e = boundary[idx];
      const k = e.a < e.b ? e.a + '_' + e.b : e.b + '_' + e.a;
      sel.edges.set(k, [e.a, e.b]);
    }
  }

  /* ---------- Pointer / keyboard (routed by app.js to 'solve' phase) ---------- */

  function onPointerDown() {
    if (!sel) return;
    sel.dragStart = { x: state.cursor.x, y: state.cursor.y };
    sel.dragging = false;
    sel.box = null;
  }

  function onPointerMove() {
    if (!sel || !sel.dragStart) return;
    if (!sel.dragging && G.V.dist(sel.dragStart, state.cursor) > worldDist(Constants.BC_DRAG_THRESHOLD)) {
      sel.dragging = true;
    }
    if (sel.dragging) {
      const a = sel.dragStart, b = state.cursor;
      sel.box = {
        minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
      };
    }
    App.scheduleRender();
  }

  function onPointerUp() {
    if (!sel) return;
    if (sel.dragging) { applyBox(sel.box); sel.box = null; }
    else clickSelectEdge(state.cursor);
    sel.dragStart = null;
    sel.dragging = false;
    App.scheduleRender();
  }

  function onPointerCancel() {
    if (sel) { sel.dragStart = null; sel.dragging = false; sel.box = null; App.scheduleRender(); }
  }

  function onKeydown(e) {
    if (e.key === 'Enter') {
      if (modal.classList.contains('visible')) { e.preventDefault(); confirm(); return; }
      if (sel && sel.edges.size) { e.preventDefault(); openModal(); }
      return; // consumed — mesh is locked in the solve phase
    }
    if (e.key === 'Escape') {
      if (modal.classList.contains('visible')) { closeModal(); cancelSel(); return; }
      if (sel) { cancelSel(); return; }
      // Always consume Escape in the solve phase (never clears the polygon).
    }
  }

  /* ---------- Scalar-value modal ---------- */

  let modalBc = null;

  function openModal() {
    const meta = blockBcMeta(sel.bcId);
    if (!meta) return;
    modalBc = meta;
    modalTitle.textContent = meta.label + ' (' + (meta.id === 'dirichlet' ? 'Dirichlet' : 'Neumann') + ')';
    modalValLbl.textContent = 'Value (' + meta.valueLabel + (meta.unit && meta.unit !== '—' ? ', ' + meta.unit : '') + ')';
    modalName.value = defaultName(meta);
    modalValue.value = '0';
    modalCount.textContent = sel.edges.size + ' boundary edges selected';
    modal.classList.add('visible');
    modalName.focus();
    modalName.select();
  }

  function defaultName(meta) {
    const base = meta.id === 'dirichlet' ? 'Temperature' : 'Flux';
    const used = new Set(groups.filter(g => g.bc === meta.id).map(g => g.name));
    let n = 1;
    while (used.has(base + '_' + n)) n++;
    return base + '_' + n;
  }

  function closeModal() {
    modal.classList.remove('visible');
    modalBc = null;
  }

  function confirm() {
    const meta = modalBc;
    const name = modalName.value.trim();
    if (!meta || !name) { App.showToast('Enter a name'); return; }
    const value = parseFloat(modalValue.value);
    if (!isFinite(value)) { App.showToast('Enter a numeric value'); return; }
    groups.push({ bc: meta.id, name, edges: [...sel.edges.values()], value });
    modalBc = null;
    sel = null;
    closeModal();
    renderList();
    updateSolveGating();
    App.setHint();
    App.scheduleRender();
  }

  /* ---------- Group list ---------- */

  function renderList() {
    if (!bcList) return;
    bcList.replaceChildren();
    for (const g of groups) {
      const row = document.createElement('div');
      row.className = 'bc-item';
      const meta = blockBcMeta(g.bc);
      const label = document.createElement('span');
      label.textContent = g.name + ' (' + g.value +
                          (meta && meta.unit && meta.unit !== '—' ? ' ' + meta.unit : '') + ')';
      const del = document.createElement('button');
      del.className = 'btn btn-ghost bc-del';
      del.textContent = '✕';
      del.addEventListener('click', () => {
        groups.splice(groups.indexOf(g), 1);
        renderList();
        updateSolveGating();
        App.scheduleRender();
      });
      row.appendChild(label);
      row.appendChild(del);
      bcList.appendChild(row);
    }
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'bc-empty';
      empty.textContent = 'No solver BCs yet — defaults apply';
      bcList.appendChild(empty);
    }
  }

  /* ---------- Solve gating (block's BC requirements) ----------
     The button is NOT truly disabled — it stays clickable while faded
     (class 'solver-blocked') so a click can explain WHY it is blocked. */

  function updateSolveGating() {
    if (!btnSolve) return;
    const block = currentBlock();
    let valid = false, reason = '';
    if (block && block.available) {
      if (block.bcs && block.bcs.length) {
        valid = block.bcs.every(b => groups.filter(g => g.bc === b.id).length >= (b.minGroups || 0));
        if (!valid) reason = 'Add at least one Temperature (Dirichlet) BC on boundary edges';
      } else {
        // Available problem WITHOUT scalar BC requirements (e.g. 2D
        // Elasticity reads loads/supports from the pre-processor BC
        // phase): the shell imposes no gate here — the block's own
        // solve() validates its problem-specific requirements and the
        // faded click keeps explaining why it cannot run.
        valid = true;
      }
    }
    const blocked = !valid;
    btnSolve.classList.toggle('solver-blocked', blocked);
    btnSolve.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    btnSolve.title = blocked ? 'Solve disabled — ' + reason : 'Solve';
  }

  /* ---------- BC buttons (from the active block's metadata) ---------- */

  /**
   * The whole "Boundary Conditions" section (add-buttons, list, default
   * hint) is only meaningful for problems whose solver BCs ARE these
   * boundary-edge scalar groups (e.g. Poisson). Problems that consume the
   * pre-processor mechanical BCs (elasticity) or are still unavailable
   * hide the section entirely — no stray "coming soon" / empty-list texts.
   */
  function syncBcSection() {
    if (!bcSection) return;
    const block = currentBlock();
    const has = !!(block && block.available && block.bcs && block.bcs.length);
    bcSection.style.display = has ? '' : 'none';
  }

  function renderBcButtons() {
    syncBcSection();
    if (!bcButtons) return;
    bcButtons.replaceChildren();
    const block = currentBlock();
    if (!block || !block.bcs || !block.bcs.length) return; // section hidden
    for (const b of block.bcs) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.textContent = 'Add ' + b.label + ' (' + (b.id === 'dirichlet' ? 'Dirichlet' : 'Neumann') + ')';
      btn.addEventListener('click', () => startBcSelect(b.id));
      bcButtons.appendChild(btn);
    }
  }

  /* ---------- Canvas markers (render hook) ---------- */

  function drawMarkers(ctx) {
    const mesh = state.mesh;
    if (!mesh) return;
    const k = 1 / state.view.zoom;
    const colors = Constants.COND_COLORS;
    const color = i => colors[i % colors.length];
    const node = id => mesh.nodes[id];

    // Live selection: faintly outline ALL boundary edges (the selectable
    // set), highlight the selected ones, show the rubber-band box.
    if (sel) {
      ctx.strokeStyle = 'rgba(0,113,227,0.25)';
      ctx.lineWidth = 4 * k;
      ctx.beginPath();
      for (const e of boundary) { ctx.moveTo(node(e.a).x, node(e.a).y); ctx.lineTo(node(e.b).x, node(e.b).y); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,113,227,0.9)';
      ctx.lineWidth = 6 * k;
      ctx.beginPath();
      for (const [a, b] of sel.edges.values()) { ctx.moveTo(node(a).x, node(a).y); ctx.lineTo(node(b).x, node(b).y); }
      ctx.stroke();
      if (sel.box) {
        const b = sel.box;
        ctx.fillStyle = 'rgba(0,113,227,0.08)';
        ctx.strokeStyle = 'rgba(0,113,227,0.5)';
        ctx.lineWidth = 1 * k;
        ctx.setLineDash([4 * k, 3 * k]);
        ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
        ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
        ctx.setLineDash([]);
      }
    }

    // Confirmed groups: Dirichlet = thick colored edge + midpoint dot.
    // Neumann is drawn the SAME way (thick edge stroke) but in a distinct
    // fixed color, so the two BC kinds are told apart by color, not style.
    const NEUMANN_COLOR = '#34C759'; // System Green
    groups.forEach((g, gi) => {
      const c = g.bc === 'dirichlet' ? color(gi) : NEUMANN_COLOR;
      for (const [a, b] of g.edges) {
        const na = node(a), nb = node(b);
        const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
        ctx.strokeStyle = c;
        ctx.lineWidth = 4 * k;
        ctx.beginPath(); ctx.moveTo(na.x, na.y); ctx.lineTo(nb.x, nb.y); ctx.stroke();
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(mx, my, 3.5 * k, 0, Math.PI * 2); ctx.fill();
      }
    });
  }

  let markerHook = null;

  /* ---------- Phase plugin (into app.js) ---------- */

  App.registerPhase('solve', {
    enter() {
      if (state.mesh !== lastMesh) {
        lastMesh = state.mesh;
        groups = [];
        computeBoundary();
        renderBcButtons();
        renderList();
        updateSolveGating();
        if (state.mesh) {
          App.showToast('Solver BCs re-set — unassigned boundary edges default to zero-flux Neumann (insulated)');
        }
      }
      if (markerHook == null) {
        markerHook = drawMarkers;
        state.renderHooks.push(markerHook);
      }
      renderBcButtons();
      renderList();
      updateSolveGating();
      const blk = currentBlock();
      App.setHint(blk && blk.bcs && blk.bcs.length
        ? 'Set BCs on BOUNDARY edges (interior edges are not selectable) — default: zero-flux Neumann'
        : (blk ? 'Solve phase — press Solve' : 'Solver phase — pick a problem from the panel'));
    },
    exit() {
      cancelSel();
      if (markerHook != null) {
        const i = state.renderHooks.indexOf(markerHook);
        if (i >= 0) state.renderHooks.splice(i, 1);
        markerHook = null;
      }
    },
    pointerdown: onPointerDown,
    pointermove: onPointerMove,
    pointerup: onPointerUp,
    pointercancel: onPointerCancel,
    keydown: onKeydown,
  });

  /* ---------- Problem change (different problem ⇒ different BCs) ---------- */

  SolverUI.setProblemChangeHandler(() => {
    groups = [];
    sel = null;
    computeBoundary();
    renderBcButtons();
    renderList();
    updateSolveGating();
    App.scheduleRender();
  });

  /* ---------- Modal wiring ---------- */

  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) { closeModal(); cancelSel(); } });
  if (btnOk) btnOk.addEventListener('click', confirm);
  if (btnCancel) btnCancel.addEventListener('click', () => { closeModal(); cancelSel(); });
  if (modalName) modalName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
  if (modalValue) modalValue.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
  if (btnSolve) btnSolve.addEventListener('click', () => {
    // If the required BCs are missing, explain that first — that is why
    // the button is faded and does nothing.
    const block = currentBlock();
    const missing = (block && block.bcs || []).find(b =>
      (b.minGroups || 0) > 0 && groups.filter(g => g.bc === b.id).length < (b.minGroups || 0));
    if (missing) {
      App.showToast(missing.id === 'dirichlet'
        ? 'At least one Dirichlet boundary condition is required.'
        : 'Missing required boundary condition: ' + missing.label);
      return;
    }
    // A shipped solver block attaches its solve() to its own metadata
    // (blocks[<id>].solve) — dispatch to the ACTIVE problem's solver.
    if (block && typeof block.solve === 'function') { block.solve(); return; }
    App.showToast('Solver core is under construction — coming soon');
  });

  /* ---------- Public API (read-only for tests / future blocks) ---------- */

  global.MeshStudio = global.MeshStudio || {};
  Object.defineProperty(global.MeshStudio, 'SolverBC', {
    configurable: true,
    value: {
      get groups() { return groups; },        // read-only view
      get boundary() { return boundary; },    // ring-ordered boundary edges
      computeBoundary,
    },
  });

  /* ---------- Init ---------- */

  computeBoundary();
  renderBcButtons();
  renderList();
  updateSolveGating();
})(window);
