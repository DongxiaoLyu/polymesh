/* ============================================================
   solver-bc.js — UNIFIED boundary-condition controller ('model')
   ============================================================
   After the mesh stage the user picks a PROBLEM; that choice decides
   which boundary conditions exist. This module is the single BC
   environment for the whole 'model' stage — both the mechanical
   BCs of Elasticity (point loads / uniform boundary pressure /
   supports, drawn as arrows & triangles) and the scalar BCs of
   Poisson (Dirichlet temperature / Neumann heat flux on boundary
   edges, drawn as thick coloured edges) are set HERE, driven by the
   BC metadata each problem block declares (SolverUI.registerBlock).

   BC metadata per block:
     { id, label, store: 'mechanical'|'scalar',
       target: 'nodes'|'edges'|'boundaryEdges',
       input:  'vector'|'type'|'scalar',
       valueLabel?, unit?, defaultName?, options?,   // modal fields
       minGroups?, minMembers? }                     // readiness

   Storage:
     - store 'mechanical' → id decides the state array written:
         pointload  → state.pointLoads { name, nodeIds, fx, fy }
         pressure   → state.pressures  { name, edges,  p }   (boundary only)
         support    → state.supports   { name, type,   nodeIds }
       (renderer.drawConditions draws arrows/triangles, elastic/ui.js
       reads them, app.js export serialises them — unchanged.)
     - store 'scalar' → this module's internal `groups` array
       { bc, name, edges:[[a,b]], value } (poisson/ui.js reads
       SolverBC.groups — unchanged).

   Solve readiness (SolverBC.ready()/reason()):
     - scalar BC with minGroups (Poisson dirichlet ≥ 1);
     - mechanical BC with minMembers (elasticity support ≥ 2 distinct
       nodes — removes the rigid-body modes).
   app.js consults SolverBC.ready() before entering the solve stage.

   Depends on:  app.js, solver-ui.js, matrix? no — renderer (hooks)
   Exposes:     window.MeshStudio.SolverBC
   ============================================================ */

(function (global) {
  'use strict';

  const App = global.MeshStudio.App;
  const state = App.state;
  const G = global.MeshStudio.Geometry;
  const Mesh = global.MeshStudio.Mesh;
  const Constants = global.MeshStudio.Constants;
  const SolverUI = global.MeshStudio.SolverUI;

  /* ---------- DOM refs ----------
     #solverBcSection / #solverBcButtons / #solverBcList live in the
     model panel (index.html); #bcModal is the shared BC modal whose
     fields are built dynamically from the active BC metadata. */

  const bcButtons  = document.getElementById('solverBcButtons');
  const bcList     = document.getElementById('solverBcList');
  const bcSection  = document.getElementById('solverBcSection');
  const bcDefault  = document.getElementById('solverBcDefault');
  const modal      = document.getElementById('bcModal');
  const modalTitle = document.getElementById('bcTitle');
  const modalName  = document.getElementById('bcName');
  const modalFields = document.getElementById('bcFields');
  const modalCount = document.getElementById('bcCount');
  const btnOk      = document.getElementById('btnBcOk');
  const btnCancel  = document.getElementById('btnBcCancel');
  const btnSolve   = document.getElementById('btnSolve');

  /* ---------- Controller state (per mesh) ---------- */

  let groups = [];        // scalar groups: { bc, name, edges, value }
  let sel = null;         // live session: { meta, nodes:Set, edges:Map, ... }
  let boundary = [];      // ring-ordered boundary edges [{a, b}] of the current mesh
  let boundaryPairs = []; // [[a, b], ...] view of boundary for Mesh.nearestEdge/edgesInBox
  let boundarySet = null; // Set of undirected keys 'a_b'
  let lastMesh = null;

  const worldDist = d => d / state.view.zoom;

  /* ---------- Current block & its BC metadata ---------- */

  function currentBlock() {
    return SolverUI.blocks[SolverUI.currentProblem()] || null;
  }

  function blockBcMeta(bcId) {
    const b = currentBlock();
    return (b && b.bcs && b.bcs.find(x => x.id === bcId)) || null;
  }

  /** Mechanical BCs map to state arrays; scalar BCs to `groups`. */
  function storeArray(meta) {
    if (meta.store !== 'mechanical') return null;
    if (meta.id === 'pointload') return state.pointLoads;
    if (meta.id === 'pressure') return state.pressures;
    if (meta.id === 'support') return state.supports;
    return null;
  }

  /** All groups of one BC kind (mechanical list or scalar list). */
  function kindGroups(meta) {
    const arr = storeArray(meta);
    if (arr) return arr;
    if (meta.store === 'scalar') return groups.filter(g => g.bc === meta.id);
    return [];
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

  /* ---------- Selection session ----------
     The active session is mirrored onto state.bcSel so the renderer's
     mechanical BC drawing keeps working; scalar sessions add their own
     boundary tint + group markers via the render hook below. */

  function startBcSelect(bcId) {
    if (state.phase !== 'model') return;
    cancelSel();
    const meta = blockBcMeta(bcId);
    if (!meta) return;
    sel = {
      meta,
      nodes: new Set(),           // selected node ids (target 'nodes')
      edges: new Map(),           // selected edges: key 'a_b' -> [a, b]
      box: null, dragStart: null, dragging: false,
    };
    state.bcSel = sel;
    const what = meta.target === 'nodes' ? 'nodes'
               : meta.target === 'edges' ? 'edges' : 'boundary edges';
    App.setHint('Click or box-select ' + what + ' · Enter to confirm · Esc to cancel');
    App.scheduleRender();
  }

  function cancelSel() {
    sel = null;
    state.bcSel = null;
    App.setHint();
    App.scheduleRender();
  }

  /** Abort an in-progress rubber-band drag (pointercancel / pinch). */
  function cancelDrag() {
    if (sel) { sel.dragStart = null; sel.dragging = false; sel.box = null; App.scheduleRender(); }
  }

  /* ---------- Hit selection (click / box) ---------- */

  /** Edges the current session may pick: all mesh edges or boundary only. */
  function selectableEdges() {
    const meta = sel && sel.meta;
    if (!meta) return null;
    if (meta.target === 'boundaryEdges') return boundaryPairs;
    if (meta.target === 'edges') return state.allEdges || [];
    return null; // target 'nodes'
  }

  function clickSelect(p) {
    const meta = sel.meta;
    const mesh = state.mesh;
    if (!mesh) return;
    if (meta.target === 'nodes') {
      const id = Mesh.nearestNode(mesh, p, worldDist(Constants.BC_SELECT_RADIUS));
      if (id < 0) { App.showToast('No node near the click'); return; }
      if (sel.nodes.has(id)) sel.nodes.delete(id);
      else sel.nodes.add(id);
      return;
    }
    const pool = selectableEdges();
    if (!pool) return;
    const idx = Mesh.nearestEdge(pool, mesh, p, worldDist(Constants.BC_SELECT_RADIUS));
    if (idx < 0) { App.showToast('No mesh edge near the click'); return; }
    const [a, b] = pool[idx];
    const key = a < b ? a + '_' + b : b + '_' + a;
    if (sel.edges.has(key)) sel.edges.delete(key);
    else sel.edges.set(key, [a, b]);
  }

  function applyBox(box) {
    const meta = sel.meta;
    const mesh = state.mesh;
    if (!box || !mesh) return;
    if (meta.target === 'nodes') {
      for (const id of Mesh.nodesInBox(mesh, box)) sel.nodes.add(id);
      return;
    }
    const pool = selectableEdges();
    if (!pool) return;
    for (const idx of Mesh.edgesInBox(pool, mesh, box)) {
      const [a, b] = pool[idx];
      const key = a < b ? a + '_' + b : b + '_' + a;
      sel.edges.set(key, [a, b]);
    }
  }

  /* ---------- Pointer / keyboard (routed by app.js to 'model' phase) ---------- */

  function onPointerDown(e) {
    if (!sel) return;
    // Keep the drag tracked on touch: capture the pointer so the rubber-band
    // follows the finger reliably (app.js refreshes state.cursor on press).
    if (e.target && e.target.setPointerCapture) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    }
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
    else clickSelect(state.cursor);
    sel.dragStart = null;
    sel.dragging = false;
    App.scheduleRender();
  }

  function onPointerCancel() {
    cancelDrag();
  }

  function onKeydown(e) {
    if (e.key === 'Enter') {
      if (modal && modal.classList.contains('visible')) { e.preventDefault(); confirm(); return; }
      if (sel && selCount() > 0) { e.preventDefault(); openModal(); }
      return; // consumed — geometry is locked in the model stage
    }
    if (e.key === 'Escape') {
      if (modal && modal.classList.contains('visible')) { closeModal(); cancelSel(); return; }
      if (sel) { cancelSel(); return; }
      // Always consume Escape in the model stage (never clears the polygon).
    }
  }

  function selCount() {
    if (!sel) return 0;
    return sel.meta.target === 'nodes' ? sel.nodes.size : sel.edges.size;
  }

  /* ---------- BC modal (built per BC metadata) ---------- */

  let modalBc = null; // active BC meta while the modal is open

  /** Default group name: <base>_n with n skipping existing names. */
  function defaultName(meta) {
    const base = meta.defaultName || meta.label;
    const used = new Set(kindGroups(meta).map(g => g.name));
    let n = 1;
    while (used.has(base + '_' + n)) n++;
    return base + '_' + n;
  }

  function makeLabel(text) {
    const row = document.createElement('div');
    row.className = 'label-row';
    const l = document.createElement('label');
    l.textContent = text;
    row.appendChild(l);
    return row;
  }

  function buildFields(meta) {
    modalFields.replaceChildren();
    const input = modalFields;
    if (meta.input === 'vector') {
      input.appendChild(makeLabel(meta.vecLabel || 'Vector (x, y) — +X right, +Y up'));
      const row = document.createElement('div');
      row.className = 'cond-vec';
      const fx = document.createElement('input');
      fx.type = 'number'; fx.className = 'cond-input'; fx.step = 'any'; fx.placeholder = 'x';
      fx.dataset.field = 'fx';
      const fy = document.createElement('input');
      fy.type = 'number'; fy.className = 'cond-input'; fy.step = 'any'; fy.placeholder = 'y';
      fy.dataset.field = 'fy';
      row.appendChild(fx); row.appendChild(fy);
      input.appendChild(row);
      fx.focus(); fx.select();
      return;
    }
    if (meta.input === 'type') {
      input.appendChild(makeLabel('Type'));
      const seg = document.createElement('div');
      seg.className = 'segmented';
      (meta.options || ['fixed', 'hinge']).forEach((v, i) => {
        const b = document.createElement('button');
        b.className = 'seg' + (i === 0 ? ' active' : '');
        b.dataset.type = v;
        b.textContent = v.charAt(0).toUpperCase() + v.slice(1);
        b.addEventListener('click', () => {
          seg.querySelectorAll('.seg').forEach(s => s.classList.remove('active'));
          b.classList.add('active');
        });
        seg.appendChild(b);
      });
      input.appendChild(seg);
      return;
    }
    // scalar
    input.appendChild(makeLabel('Value (' + meta.valueLabel +
      (meta.unit && meta.unit !== '—' ? ', ' + meta.unit : '') + ')'));
    const v = document.createElement('input');
    v.type = 'number'; v.className = 'cond-input'; v.step = 'any';
    v.dataset.field = 'value';
    input.appendChild(v);
    v.focus(); v.select();
  }

  function openModal() {
    const meta = sel && sel.meta;
    if (!meta) return;
    modalBc = meta;
    modalTitle.textContent = meta.label;
    modalName.value = defaultName(meta);
    buildFields(meta);
    const n = selCount();
    modalCount.textContent = n + (meta.target === 'nodes' ? ' node(s) selected'
                                : meta.target === 'boundaryEdges' ? ' boundary edge(s) selected'
                                : ' edge(s) selected');
    modal.classList.add('visible');
    modalName.focus();
    modalName.select();
    App.scheduleRender(); // touch bar must step aside while the modal is open
  }

  function closeModal() {
    modal.classList.remove('visible');
    modalBc = null;
  }

  function readField(name) {
    const el = modalFields.querySelector('[data-field="' + name + '"]');
    return el ? el.value : '';
  }

  function confirm() {
    const meta = modalBc;
    const name = modalName.value.trim();
    if (!meta || !name) { App.showToast('Enter a name'); return; }
    if (!sel) return;
    const count = selCount();
    if (!count) { App.showToast('Select at least one ' + (meta.target === 'nodes' ? 'node' : 'edge')); return; }

    if (meta.input === 'vector') {
      const fx = parseFloat(readField('fx')) || 0;
      const fy = parseFloat(readField('fy')) || 0;
      if (meta.store === 'mechanical') {
        // pointload (the only mechanical vector BC left)
        state.pointLoads.push({ name, nodeIds: [...sel.nodes], fx, fy });
      }
    } else if (meta.input === 'type') {
      const active = modalFields.querySelector('.seg.active');
      const type = (active && active.dataset.type) || 'fixed';
      state.supports.push({ name, type, nodeIds: [...sel.nodes] });
    } else if (meta.store === 'scalar') {
      // scalar boundary-edge BC groups (Poisson dirichlet/neumann, …)
      const value = parseFloat(readField('value'));
      if (!isFinite(value)) { App.showToast('Enter a numeric value'); return; }
      groups.push({ bc: meta.id, name, edges: [...sel.edges.values()], value });
    } else {
      // mechanical SCALAR BC: uniform pressure on boundary edges
      const p = parseFloat(readField('value'));
      if (!isFinite(p)) { App.showToast('Enter a numeric value'); return; }
      state.pressures.push({ name, edges: [...sel.edges.values()], p });
    }
    modalBc = null;
    sel = null;
    state.bcSel = null;
    closeModal();
    renderList();
    updateSolveGating();
    App.setHint();
    App.scheduleRender();
  }

  /* ---------- Group list (one list for the whole model stage) ---------- */

  function groupLabel(meta, g) {
    if (meta.input === 'vector') {
      return g.name + ' — (' + g.fx + ', ' + g.fy + ')';
    }
    if (meta.input === 'type') {
      return g.name + ' — ' + (g.type === 'fixed' ? 'Fixed' : 'Hinge');
    }
    // scalar: mechanical pressure uses g.p, solver BC groups use g.value
    const v = meta.store === 'mechanical' ? g.p : g.value;
    return g.name + ' (' + v + (meta.unit && meta.unit !== '—' ? ' ' + meta.unit : '') + ')';
  }

  function renderList() {
    if (!bcList) return;
    bcList.replaceChildren();
    const block = currentBlock();
    let any = false;
    if (block && block.bcs) {
      for (const meta of block.bcs) {
        const arr = storeArray(meta);
        const items = arr ? arr.slice() : groups.filter(g => g.bc === meta.id);
        items.forEach((g, gi) => {
          any = true;
          const row = document.createElement('div');
          row.className = 'bc-item';
          const label = document.createElement('span');
          const count = meta.store === 'scalar'
            ? (g.edges ? g.edges.length : 0) + ' edge(s)'
            : (g.nodeIds ? g.nodeIds.length : (g.edges ? g.edges.length : 0)) +
              ((meta.id === 'support' || meta.id === 'pointload') ? ' node(s)' : ' edge(s)');
          label.textContent = groupLabel(meta, g) + ' — ' + count;
          const del = document.createElement('button');
          del.className = 'btn btn-ghost bc-del';
          del.textContent = '✕';
          del.addEventListener('click', () => {
            if (arr) arr.splice(gi, 1);
            else groups.splice(groups.indexOf(g), 1);
            renderList();
            updateSolveGating();
            App.scheduleRender();
          });
          row.appendChild(label);
          row.appendChild(del);
          bcList.appendChild(row);
        });
      }
    }
    if (!any) {
      const empty = document.createElement('div');
      empty.className = 'bc-empty';
      empty.textContent = 'No conditions yet — add one above';
      bcList.appendChild(empty);
    }
  }

  /* ---------- Solve readiness (consulted before entering 'solve') ----------
     A block declares minGroups on scalar BCs (Poisson needs ≥1 Dirichlet)
     and/or minMembers on mechanical BCs (elasticity needs ≥2 distinct
     support nodes). Everything else is satisfied by default. */

  function distinctSupportNodes() {
    const s = new Set();
    for (const g of state.supports) for (const id of g.nodeIds) s.add(id);
    return s.size;
  }

  function ready() {
    const block = currentBlock();
    if (!block || !block.available) return false;
    if (!block.bcs || !block.bcs.length) return true;
    return block.bcs.every(bc => {
      if (bc.minGroups) {
        if (bc.store === 'scalar') return groups.filter(g => g.bc === bc.id).length >= bc.minGroups;
        return kindGroups(bc).length >= bc.minGroups;
      }
      if (bc.minMembers && bc.id === 'support') return distinctSupportNodes() >= bc.minMembers;
      return true;
    });
  }

  function reason() {
    const block = currentBlock();
    if (!block) return 'Pick a problem first';
    if (!block.available) return block.label + ' is not available yet';
    if (block.bcs) {
      for (const bc of block.bcs) {
        if (bc.minGroups) {
          const have = (bc.store === 'scalar' ? groups.filter(g => g.bc === bc.id).length : kindGroups(bc).length);
          if (have < bc.minGroups) return 'Add at least ' + bc.minGroups + ' ' + bc.label + ' group(s)';
        }
        if (bc.minMembers && bc.id === 'support' && distinctSupportNodes() < bc.minMembers) {
          return 'Add at least ' + bc.minMembers + ' distinct support nodes (removes rigid-body motion)';
        }
      }
    }
    return '';
  }

  /** Solve-button visual gating (faded but clickable to explain why). */
  function updateSolveGating() {
    if (!btnSolve) return;
    const valid = ready();
    const why = valid ? '' : reason();
    btnSolve.classList.toggle('solver-blocked', !valid);
    btnSolve.setAttribute('aria-disabled', valid ? 'false' : 'true');
    btnSolve.title = valid ? 'Solve' : 'Solve disabled — ' + why;
  }

  /* ---------- BC add-buttons + section hint (per active block) ---------- */

  function renderBcButtons() {
    const block = currentBlock();
    const show = !!(block && block.available && block.bcs && block.bcs.length);
    if (bcSection) bcSection.style.display = show ? '' : 'none';
    if (!bcButtons) return;
    bcButtons.replaceChildren();
    if (!show) return;
    for (const b of block.bcs) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.textContent = 'Add ' + b.label;
      if (b.hint) btn.title = b.hint;   // extra guidance (e.g. pressure sign)
      btn.addEventListener('click', () => startBcSelect(b.id));
      bcButtons.appendChild(btn);
    }
    if (bcDefault) {
      // A scalar problem can state its natural default (e.g. insulated).
      const blkDefault = block.bcDefault || '';
      const meta0 = block.bcs[0];
      if (meta0 && meta0.store === 'scalar' && !blkDefault) {
        bcDefault.textContent = 'Default: unassigned boundary edges are natural (zero flux).';
      } else {
        bcDefault.textContent = blkDefault;
      }
    }
  }

  /* ---------- Canvas markers (render hook, kept for scalar groups) ----------
     Mechanical BC markers (arrows / triangles) and the LIVE selection
     highlight (nodes / edges / rubber-band box) are drawn by the renderer
     itself (renderer.drawConditions reads state.pointLoads etc. and the
     session mirror state.bcSel). This hook only adds what the renderer
     does not know about: the boundary-edge tint that shows which edges
     are selectable for a boundaryEdges session, and the CONFIRMED scalar
     groups (Dirichlet / Neumann thick edges + dots). */

  function drawMarkers(ctx) {
    const mesh = state.mesh;
    if (!mesh) return;
    const k = 1 / state.view.zoom;
    const colors = Constants.COND_COLORS;
    const color = i => colors[i % colors.length];
    const node = id => mesh.nodes[id];

    // Boundary-edges session: faintly outline ALL boundary edges so the
    // user sees the selectable set (the selected ones are highlighted by
    // the renderer through state.bcSel).
    if (sel && sel.meta && sel.meta.target === 'boundaryEdges') {
      ctx.strokeStyle = 'rgba(0,113,227,0.25)';
      ctx.lineWidth = 4 * k;
      ctx.beginPath();
      for (const e of boundary) { ctx.moveTo(node(e.a).x, node(e.a).y); ctx.lineTo(node(e.b).x, node(e.b).y); }
      ctx.stroke();
    }

    // Confirmed scalar groups: Dirichlet = thick colored edge + dot,
    // Neumann uses a fixed distinct color (told apart by color).
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

  let markerHooks = 0; // ref-counted across 'model' & 'solve' enters

  function attachMarkers() {
    if (markerHooks === 0) {
      state.renderHooks.push(drawMarkers);
      markerHooks = 1;
    } else markerHooks++;
  }

  function detachMarkers() {
    markerHooks = Math.max(0, markerHooks - 1);
    if (markerHooks === 0) {
      const i = state.renderHooks.indexOf(drawMarkers);
      if (i >= 0) state.renderHooks.splice(i, 1);
    }
  }

  /* ---------- Sync everything for the active problem ---------- */

  function syncAll({ toast = false } = {}) {
    renderBcButtons();
    renderList();
    updateSolveGating();
    App.scheduleRender();
  }

  /* ---------- Phase plugins (into app.js) ----------
     The BC environment lives in the 'model' stage (pick problem → set
     its BCs). Markers also stay attached during 'solve' so the applied
     BCs remain visible next to the results. */

  App.registerPhase('model', {
    enter() {
      if (state.mesh !== lastMesh) {
        lastMesh = state.mesh;
        groups = [];
        computeBoundary();
        syncAll();
      } else {
        renderBcButtons();
        renderList();
        updateSolveGating();
      }
      attachMarkers();
      const blk = currentBlock();
      App.setHint(blk && blk.available && blk.bcs && blk.bcs.length
        ? 'Set ' + blk.label + ' boundary conditions on the model — mesh is locked'
        : 'Model stage — pick a problem first');
    },
    exit() {
      cancelSel();
      detachMarkers();
    },
    pointerdown: onPointerDown,
    pointermove: onPointerMove,
    pointerup: onPointerUp,
    pointercancel: onPointerCancel,
    keydown: onKeydown,
  });

  App.registerPhase('solve', {
    enter() {
      attachMarkers();
      updateSolveGating();
    },
    exit() {
      detachMarkers();
    },
  });

  /* ---------- Problem change (different problem ⇒ different BCs) ----------
     Switching problems clears EVERY boundary condition: mechanical BCs
     live in state arrays, scalar BCs in `groups`. */

  SolverUI.setProblemChangeHandler(() => {
    groups = [];
    sel = null;
    state.bcSel = null;
    state.pointLoads = [];
    state.pressures = [];
    state.supports = [];
    computeBoundary();
    syncAll();
  });

  /* ---------- Mesh change (app.js refresh) ---------- */

  function onMeshChanged() {
    groups = [];
    sel = null;
    state.bcSel = null;
    computeBoundary();
  }

  /* ---------- Modal wiring ---------- */

  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) { closeModal(); cancelSel(); } });
  if (btnOk) btnOk.addEventListener('click', confirm);
  if (btnCancel) btnCancel.addEventListener('click', () => { closeModal(); cancelSel(); });
  if (modalName) modalName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
  if (modalFields) modalFields.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
  if (btnSolve) btnSolve.addEventListener('click', () => {
    // Faded-but-clickable Solve: first explain WHY it is blocked.
    const valid = ready();
    if (!valid) { App.showToast(reason() || 'Boundary conditions are incomplete'); return; }
    const block = currentBlock();
    if (block && typeof block.solve === 'function') { block.solve(); return; }
    App.showToast('Solver core is under construction — coming soon');
  });

  /* ---------- Public API (read-only for tests / export / future blocks) ---------- */

  global.MeshStudio = global.MeshStudio || {};
  Object.defineProperty(global.MeshStudio, 'SolverBC', {
    configurable: true,
    value: {
      get groups() { return groups; },        // scalar groups (poisson/ui.js)
      get boundary() { return boundary; },    // ring-ordered boundary edges
      // Live session active? (touch bar + tests call this function)
      selecting: () => !!sel,
      computeBoundary,
      ready,
      reason,
      cancelSel,
      cancelDrag,
      onMeshChanged,
      // Export hook: scalar groups with a file-format section title.
      exportScalar() {
        const block = currentBlock();
        const sectionFor = id => {
          if (id === 'dirichlet') return 'TEMPERATURE (DIRICHLET)';
          if (id === 'neumann') return 'HEAT FLUX (NEUMANN)';
          const meta = blockBcMeta(id);
          return meta ? meta.label.toUpperCase() : id.toUpperCase();
        };
        if (!block || !block.bcs || !block.bcs.length) return [];
        const out = [];
        for (const meta of block.bcs) {
          if (meta.store !== 'scalar') continue;
          const unit = meta.unit && meta.unit !== '—' ? meta.unit : '';
          for (const g of groups.filter(x => x.bc === meta.id)) {
            out.push({ section: sectionFor(meta.id), unit, name: g.name, edges: g.edges, value: g.value });
          }
        }
        return out;
      },
    },
  });

  /* ---------- Init ---------- */

  computeBoundary();
  renderBcButtons();
  renderList();
  updateSolveGating();
})(window);
