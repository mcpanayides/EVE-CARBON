// ─── Fleet Commander · Fitting Simulator ──────────────────────────────────────
// Radial fitting wheel (in-game / zkill style): slots arranged in arcs around a
// ring — high top, mid right, low bottom-left, rigs + subsystems on an inner ring
// — with the ship render in the middle (parallax tilt).
//
// Simulation (all dogma attributes verified against the local SDE):
//  • Fitting: CPU/PG usage AND hull output modified by Co-Processors / RCU / PDS
//    and fitting rigs, with EVE stacking penalties. Offline modules draw nothing.
//  • Weapon ranges: optimal / falloff / tracking per weapon group, including ammo
//    range multipliers, Tracking Enhancers/Computers (+ scripts), Missile Guidance
//    Computers/Enhancers (+ scripts), weapon rigs, and overheat bonuses.
//  • Applied-DPS-vs-range chart (turret falloff curve at 0 transversal; missiles
//    flat to max range ≈ velocity × flight time).
//
// Honesty note: numbers are pre-skill (no character skills / hull trait bonuses
// applied — that needs the full dogma engine). Everything shown is computed from
// exact SDE values with EVE's stacking-penalty formula.

const FIT_SLOTS = [
  { key: 'high', label: 'High Slots' },
  { key: 'med',  label: 'Mid Slots'  },
  { key: 'low',  label: 'Low Slots'  },
  { key: 'rig',  label: 'Rig Slots'  },
  { key: 'subsystem', label: 'Subsystems' },
];

// Wheel geometry — arcs are degrees clockwise from 12 o'clock.
const FIT_WHEEL = {
  size: 640, outerR: 264, innerR: 168, cell: 52,
  arcs: {
    high:      { from: -55, to: 55,  r: 'outer', label: 'HIGH' },
    med:       { from: 65,  to: 175, r: 'outer', label: 'MID' },
    low:       { from: 185, to: 295, r: 'outer', label: 'LOW' },
    rig:       { from: 252, to: 308, r: 'inner', label: 'RIGS' },
    subsystem: { from: 32,  to: 108, r: 'inner', label: 'SUBS' },
  },
};

// Chart series palette — validated (dataviz six checks) against the app's dark
// surface (#14161c): all ≥3:1 contrast, worst adjacent CVD ΔE 15.7.
const FIT_CHART_COLORS = ['#3987e5', '#199e70', '#c98500', '#9085e9'];
const FIT_CHART_TOTAL  = '#dfe5f0';
const FIT_CHART_HEAT   = '#e66767';

// Scripts are ordinary charges (Tracking Script group 907 / Missile Guidance
// Script group 1400) — load them from the Charges tab or drag them onto a TC/MGC,
// exactly like the game. The engine detects them via _fitScriptMode.

// State is the single source of truth — render() is a pure function of it, so
// switching FC sub-tabs (which re-renders) never loses the in-progress fit.
const _fitState = {
  hull: null,                                  // { id,name,slots,hardpoints,output,base,… }
  fitName: 'EVE Carbon Fit',
  modules: { high: [], med: [], low: [], rig: [], subsystem: [] },
  selected: null,                              // { slot, idx } — module awaiting a charge
  searchKind: 'ship',
  searchResults: [],
  gameFits: null,                              // cached ESI fits list while the picker is open
  heatPreview: false,                          // chart: overlay "everything overheated"
  trees: {},                                   // kind → browse tree from fit-browse-tree
  treeOpen: {},                                // kind → Set of open group paths
  filters: { slots: new Set(), fits: false, skills: false },   // Modules-tab filter row
  skillLevels: null, skillsChar: null,         // cached getSkillLevels result for the skills filter
  fitsByHull: null, fitsChar: null,            // saved game fits grouped by hull (Hulls & Fits tab)
};
let _fitSearchTimer = null;
let _fitSimCache = null;                       // last weapon-sim result (tooltips reuse it)
let _fitTreeNodes = [];                        // flat registry: data-tn index → tree node

// ─── Entry point (called from navigateFcTab) ─────────────────────────────────
function renderFitting(mount) {
  const browserW = Math.max(200, Math.min(560, Number(localStorage.getItem('fitBrowserW')) || 280));
  mount.innerHTML = `
    <div class="fit-wrap" id="fitWrap" style="grid-template-columns:${browserW}px 6px 1fr 310px;">
      <!-- Left: item browser -->
      <div class="fit-browser">
        <div class="fit-kind-tabs">
          ${[['ship', 'Hulls & Fits'], ['module', 'Modules'], ['charge', 'Charges & Drones']]
            .map(([k, l]) => `<button class="fit-kind-btn ${k === _fitState.searchKind ? 'active' : ''}" data-kind="${k}">${l}</button>`).join('')}
        </div>
        <input id="fitSearch" class="field-input" placeholder="Search — or browse below…" autocomplete="off"/>
        <div id="fitFilters" class="fit-filters"></div>
        <div id="fitResults" class="fit-results"></div>
      </div>

      <!-- Drag handle: resize the browser column (double-click resets) -->
      <div id="fitColHandle" class="fit-col-handle" title="Drag to resize — double-click to reset"></div>

      <!-- Center: the fitting wheel -->
      <div class="fit-canvas">
        <div class="fit-canvas-head">
          <div id="fitHullName" class="fit-hull-name">No hull — pick one from Hulls</div>
          <div class="fit-canvas-actions">
            <select id="fitCharSelect" class="field-input" style="width:170px;"></select>
            <button id="fitImportGame" class="fit-btn">Import from Game</button>
            <button id="fitImportEft"  class="fit-btn">Paste EFT</button>
            <button id="fitCopyEft"    class="fit-btn">Copy EFT</button>
            <button id="fitSaveGame"   class="fit-btn fit-btn-accent">Save to Game</button>
            <button id="fitClear"      class="fit-btn">Clear</button>
          </div>
        </div>
        <div id="fitWheelWrap" class="fit-wheel-wrap"><div id="fitWheel" class="fit-wheel"></div></div>
        <div id="fitImportPanel" class="fit-import-panel" style="display:none;"></div>
      </div>

      <!-- Right: stats -->
      <div id="fitStats" class="fit-stats"></div>
    </div>`;

  // Browser events
  if (_fitState.searchKind === 'drone') _fitState.searchKind = 'charge';   // merged tab
  mount.querySelectorAll('.fit-kind-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _fitState.searchKind = btn.dataset.kind;
      _fitRenderKindTabs(); _fitRenderFilters(); _fitRenderBrowser();
    });
  });
  const search = mount.querySelector('#fitSearch');
  search.addEventListener('input', () => { clearTimeout(_fitSearchTimer); _fitSearchTimer = setTimeout(_fitRenderBrowser, 220); });

  const results = mount.querySelector('#fitResults');
  results.addEventListener('click', (e) => {
    const fitRow = e.target.closest('[data-fitidx]');
    if (fitRow) {                                   // saved game fit under a hull
      const f = (_fitState.fitsByHull?.all || [])[Number(fitRow.dataset.fitidx)];
      if (f) _fitLoadGameFit(f);
      return;
    }
    const row = e.target.closest('[data-typeid]');
    if (row) _fitPickResult(Number(row.dataset.typeid), row.dataset.name);
  });
  // Browser rows are draggable onto specific wheel slots.
  results.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-typeid]');
    if (!row) return;
    e.dataTransfer.setData('text/plain', `new:${row.dataset.typeid}`);
    e.dataTransfer.effectAllowed = 'copy';
  });

  // Column resize handle.
  const handle = mount.querySelector('#fitColHandle');
  const wrap   = mount.querySelector('#fitWrap');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wrap.querySelector('.fit-browser').getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      const w = Math.max(200, Math.min(560, startW + (ev.clientX - startX)));
      wrap.style.gridTemplateColumns = `${w}px 6px 1fr 310px`;
    };
    const onUp = () => {
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      const w = Math.round(wrap.querySelector('.fit-browser').getBoundingClientRect().width);
      localStorage.setItem('fitBrowserW', String(w));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('dblclick', () => {
    wrap.style.gridTemplateColumns = `280px 6px 1fr 310px`;
    localStorage.setItem('fitBrowserW', '280');
  });

  // Action buttons
  mount.querySelector('#fitClear').addEventListener('click', () => {
    _fitState.modules = _fitEmptyRacks(_fitState.hull);
    _fitState.selected = null; _fitRenderAll();
  });
  mount.querySelector('#fitCopyEft').addEventListener('click', _fitCopyEFT);
  mount.querySelector('#fitImportEft').addEventListener('click', _fitShowEftPaste);
  mount.querySelector('#fitImportGame').addEventListener('click', _fitImportFromGame);
  mount.querySelector('#fitSaveGame').addEventListener('click', _fitSaveToGame);

  _fitPopulateChars();
  _fitRenderFilters();
  _fitRenderBrowser();
  _fitRenderAll();
}

function _fitRenderAll() { _fitRenderCanvas(); _fitRenderStats(); }

// ─── Item browser ─────────────────────────────────────────────────────────────
function _fitRenderKindTabs() {
  document.querySelectorAll('.fit-kind-btn').forEach(b => b.classList.toggle('active', b.dataset.kind === _fitState.searchKind));
}

// Search text ≥ 2 chars → flat search results; otherwise → the grouped browse tree.
function _fitRenderBrowser() {
  const input = document.getElementById('fitSearch');
  if (!input) return;
  if (input.value.trim().length >= 2) _fitDoSearch();
  else _fitRenderTree();
}

async function _fitDoSearch() {
  const box = document.getElementById('fitResults');
  const q   = document.getElementById('fitSearch')?.value.trim() || '';
  if (!box || q.length < 2) return;
  box.innerHTML = `<div class="fit-hint">Searching…</div>`;
  const results = await window.eveAPI.fitSearch(q, _fitState.searchKind, 80).catch(() => []);
  _fitState.searchResults = results;
  if (!results.length) { box.innerHTML = `<div class="fit-hint">No matches.</div>`; return; }
  box.innerHTML = results.map(r => _fitTypeRowHtml({ id: r.id, name: r.name }, r.groupName)).join('');
}

// One clickable/draggable type row (shared by search results and the tree).
function _fitTypeRowHtml(t, grpLabel = '') {
  return `
    <div class="fit-result" draggable="true" data-typeid="${t.id}" data-name="${_fitEsc(t.name)}" title="${_fitEsc(t.name)} — click to fit, or drag onto a specific slot">
      <img src="https://images.evetech.net/types/${t.id}/icon?size=32" alt="" loading="lazy"/>
      <span class="fit-result-name">${_fitEsc(t.name)}</span>
      ${grpLabel ? `<span class="fit-result-grp">${_fitEsc(grpLabel)}</span>` : ''}
    </div>`;
}

// ─── Grouped browse tree (EVE-style) ─────────────────────────────────────────
// ship: class → race → hulls (saved game fits nested under their hull);
// module/charge: the SDE market-group tree. Types render lazily on expand.
async function _fitRenderTree() {
  const box  = document.getElementById('fitResults');
  const kind = _fitState.searchKind;
  if (!box) return;

  if (!_fitState.trees[kind]) {
    box.innerHTML = `<div class="fit-hint">Loading…</div>`;
    _fitState.trees[kind] = await window.eveAPI.fitBrowseTree(kind).catch(() => null);
    if (_fitState.searchKind !== kind) return;           // user switched tabs meanwhile
  }
  const tree = _fitState.trees[kind];
  if (!tree || !tree.sections?.length) { box.innerHTML = `<div class="fit-hint">Browse data unavailable — use search.</div>`; return; }

  if (kind === 'ship') await _fitEnsureGameFits();

  const open = _fitState.treeOpen[kind] || (_fitState.treeOpen[kind] = new Set());
  _fitTreeNodes = [];
  const grpHtml = (node, path) => {
    const key = path + '/' + node.name;
    const idx = _fitTreeNodes.push({ node, key }) - 1;
    return `
      <details class="ft-grp" data-tn="${idx}" data-key="${_fitEsc(key)}" ${open.has(key) ? 'open' : ''}>
        <summary>${_fitEsc(node.name)}<span class="ft-count">${node.count ?? node.types.length}</span></summary>
        <div class="ft-body">${node.kids.map(k => grpHtml(k, key)).join('')}<div class="ft-types"></div></div>
      </details>`;
  };
  box.innerHTML = tree.sections.map(s => grpHtml(s, kind)).join('');

  box.querySelectorAll('details.ft-grp').forEach(d => {
    d.addEventListener('toggle', () => {
      const { node, key } = _fitTreeNodes[Number(d.dataset.tn)] || {};
      if (!node) return;
      if (d.open) { open.add(key); _fitFillTypes(d, node); }
      else open.delete(key);
    });
    if (d.open) {   // restore previously-open groups
      const { node } = _fitTreeNodes[Number(d.dataset.tn)] || {};
      if (node) _fitFillTypes(d, node);
    }
  });
}

// Fill a group's type rows (applying the Modules-tab filters). Ship rows get their
// saved game fits nested beneath them.
function _fitFillTypes(detailsEl, node) {
  const holder = detailsEl.querySelector(':scope > .ft-body > .ft-types');
  if (!holder || !node.types.length) return;
  const kind = _fitState.searchKind;
  const types = kind === 'module' ? node.types.filter(_fitPassesFilters) : node.types;
  holder.innerHTML = types.map(t => {
    let html = _fitTypeRowHtml(t);
    if (kind === 'ship' && _fitState.fitsByHull?.byHull?.has(t.id)) {
      html += _fitState.fitsByHull.byHull.get(t.id)
        .map(({ i, name }) => `<div class="fit-result ft-fit" data-fitidx="${i}" title="Saved fit — click to load">⚙ ${_fitEsc(name)}</div>`)
        .join('');
    }
    return html;
  }).join('') || `<div class="fit-hint" style="padding:4px 8px;">No matches for the active filters.</div>`;
}

// Saved game fits for the selected character, grouped by hull (Hulls & Fits tab).
async function _fitEnsureGameFits() {
  const charId = document.getElementById('fitCharSelect')?.value || '';
  if (!charId) { _fitState.fitsByHull = null; return; }
  if (_fitState.fitsChar === charId && _fitState.fitsByHull) return;
  const res = await window.eveAPI.fitGetFittings(charId).catch(() => ({ ok: false }));
  const all = (res.ok && res.fittings) || [];
  const byHull = new Map();
  all.forEach((f, i) => {
    if (!byHull.has(f.shipTypeId)) byHull.set(f.shipTypeId, []);
    byHull.get(f.shipTypeId).push({ i, name: f.name });
  });
  _fitState.fitsByHull = { all, byHull };
  _fitState.fitsChar = charId;
}

// ─── Modules-tab filter row (EVE-style) ──────────────────────────────────────
function _fitRenderFilters() {
  const el = document.getElementById('fitFilters');
  if (!el) return;
  if (_fitState.searchKind !== 'module') { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const f = _fitState.filters;
  const chip = (key, label, on, title) =>
    `<button class="fit-filter-chip ${on ? 'on' : ''}" data-filter="${key}" title="${_fitEsc(title)}">${label}</button>`;
  el.innerHTML = [
    chip('low',  'LOW',  f.slots.has('low'),  'Show low-slot modules'),
    chip('med',  'MID',  f.slots.has('med'),  'Show mid-slot modules'),
    chip('high', 'HIGH', f.slots.has('high'), 'Show high-slot modules'),
    chip('rig',  'RIG',  f.slots.has('rig'),  'Show rigs'),
    chip('subsystem', 'SUB', f.slots.has('subsystem'), 'Show T3 subsystems'),
    chip('fits',   '⚡ FITS',   f.fits,   'Only modules the current hull can take: free slot & hardpoint, and within remaining CPU / powergrid'),
    chip('skills', '🎓 SKILLS', f.skills, 'Only modules the selected character has the skills to use'),
  ].join('');
  el.querySelectorAll('.fit-filter-chip').forEach(btn => btn.addEventListener('click', async () => {
    const k = btn.dataset.filter;
    if (k === 'fits') {
      if (!_fitState.filters.fits && !_fitState.hull) { _fitFlash('Load a hull first for the FITS filter.'); return; }
      _fitState.filters.fits = !_fitState.filters.fits;
    } else if (k === 'skills') {
      if (!_fitState.filters.skills && !(await _fitEnsureSkills())) return;
      _fitState.filters.skills = !_fitState.filters.skills;
    } else {
      _fitState.filters.slots.has(k) ? _fitState.filters.slots.delete(k) : _fitState.filters.slots.add(k);
    }
    _fitRenderFilters();
    _fitRenderBrowser();
  }));
}

// Load the selected character's levels for every skill the module tree requires.
async function _fitEnsureSkills() {
  const charId = document.getElementById('fitCharSelect')?.value || '';
  if (!charId) { _fitFlash('Pick a character for the SKILLS filter.'); return false; }
  if (_fitState.skillsChar === charId && _fitState.skillLevels) return true;
  const tree = _fitState.trees.module;
  if (!tree) return false;
  const ids = new Set();
  const walk = (n) => { n.types.forEach(t => (t.sk || []).forEach(([id]) => ids.add(id))); n.kids.forEach(walk); };
  tree.sections.forEach(walk);
  _fitFlash('Loading skills…');
  try {
    _fitState.skillLevels = await window.eveAPI.getSkillLevels(charId, [...ids]) || {};
    _fitState.skillsChar = charId;
    return true;
  } catch (e) { _fitFlash('Could not load skills: ' + e.message); return false; }
}

function _fitPassesFilters(t) {
  const f = _fitState.filters;
  if (f.slots.size && !f.slots.has(t.slot)) return false;
  if (f.fits && _fitState.hull) {
    const hull = _fitState.hull;
    if (!t.slot || !(hull.slots[t.slot] > 0)) return false;
    if (_fitFilled(t.slot).length >= hull.slots[t.slot]) return false;
    const u = _fitComputeUsage(), eff = _fitEffOutputs();
    if ((t.cpu || 0) > eff.cpu - u.cpu + 1e-6) return false;
    if ((t.pg  || 0) > eff.pg  - u.pg  + 1e-6) return false;
    if (t.hp === 'turret'   && u.turret   >= hull.hardpoints.turret)   return false;
    if (t.hp === 'launcher' && u.launcher >= hull.hardpoints.launcher) return false;
  }
  if (f.skills && _fitState.skillLevels) {
    for (const [id, lvl] of (t.sk || [])) {
      if ((_fitState.skillLevels[id] || 0) < lvl) return false;
    }
  }
  return true;
}

async function _fitPickResult(typeId, name) {
  if (_fitState.searchKind === 'ship') return _fitLoadHull(typeId);
  if (_fitState.searchKind === 'charge') return _fitLoadCharge(typeId, name);
  const facts = (await window.eveAPI.fitGetItems([typeId]).catch(() => ({})))[typeId];
  if (!facts) return;
  if (_fitState.searchKind === 'drone' || !facts.slot) { _fitFlash('Drones/cargo aren’t placed in slots yet (Phase 2).'); return; }
  _fitAddModule(facts);
}

// ─── Hull + modules ───────────────────────────────────────────────────────────
// Racks are POSITIONAL: fixed-length arrays sized to the hull, with null = empty
// slot. Position matters for heat management (heat bleeds to adjacent slots), so
// modules stay exactly where the user drops them.
function _fitEmptyRacks(hull) {
  const mk = (n) => new Array(n || 0).fill(null);
  return hull
    ? { high: mk(hull.slots.high), med: mk(hull.slots.med), low: mk(hull.slots.low),
        rig: mk(hull.slots.rig), subsystem: mk(hull.slots.subsystem) }
    : { high: [], med: [], low: [], rig: [], subsystem: [] };
}
function _fitFilled(slotKey) { return (_fitState.modules[slotKey] || []).filter(Boolean); }

// Place a module at a specific position (or the first free one). Returns true on success.
function _fitPlace(slotKey, mod, atIdx = null) {
  const rack = _fitState.modules[slotKey];
  if (!rack || !rack.length) return false;
  if (atIdx != null && atIdx >= 0 && atIdx < rack.length) { rack[atIdx] = mod; return true; }
  const free = rack.findIndex(m => !m);
  if (free === -1) return false;
  rack[free] = mod;
  return true;
}

async function _fitLoadHull(typeId) {
  const hull = await window.eveAPI.fitGetHull(typeId).catch(() => null);
  if (!hull) { _fitFlash('Could not load that hull.'); return; }
  _fitState.hull = hull;
  _fitState.modules = _fitEmptyRacks(hull);
  _fitState.selected = null;
  _fitRenderAll();
}

// Full fit-legality check (mirrors the game): the hull must have that slot type
// with one free, and turrets/launchers need a free HARDPOINT — a Nyx has 6 highs
// but 0 turret hardpoints, so guns must be rejected. `ignoreMod` excludes the
// module being replaced from the counts (drag-replace).
function _fitCanFit(facts, ignoreMod = null) {
  const hull = _fitState.hull;
  if (!hull) return 'Pick a hull first.';
  if (!facts.slot) return `${facts.name} doesn’t fit a slot.`;
  if (!(hull.slots[facts.slot] > 0)) return `${hull.name} has no ${facts.slot} slots.`;
  const filled = _fitFilled(facts.slot).filter(m => m !== ignoreMod).length;
  if (filled >= hull.slots[facts.slot]) return `No free ${facts.slot} slots.`;
  if (facts.hardpoint) {
    let used = 0;
    for (const m of _fitState.modules.high) if (m && m !== ignoreMod && m.hardpoint === facts.hardpoint) used++;
    const max = hull.hardpoints[facts.hardpoint] || 0;
    if (used >= max) {
      return max === 0
        ? `${hull.name} has no ${facts.hardpoint} hardpoints — ${facts.name} can’t be fitted.`
        : `No free ${facts.hardpoint} hardpoints (${used}/${max}).`;
    }
  }
  return null;
}

function _fitAddModule(facts, atIdx = null) {
  const err = _fitCanFit(facts);
  if (err) { _fitFlash(err); return; }
  if (!_fitPlace(facts.slot, _fitMod(facts), atIdx)) { _fitFlash(`No free ${facts.slot} slots.`); return; }
  _fitRenderAll();
}

// Build a fitted-module record. `f` keeps the FULL facts (range/heat/bonus attrs)
// for the sim engine. Activatable modules default to 'active'; passive to 'online'.
function _fitMod(facts) {
  const activatable  = !!facts.activatable;
  const overloadable = !!facts.overloadable;
  return { id: facts.id, name: facts.name, cpu: facts.cpu, pg: facts.pg, hardpoint: facts.hardpoint,
           dmgMult: facts.dmgMult, rof: facts.rof, charge: null, f: facts,
           activatable, overloadable, state: activatable ? 'active' : 'online' };
}

// Cycle a fitted module's state: offline → online → active? → overheated? → …
function _fitCycleState(slot, idx) {
  const m = _fitState.modules[slot]?.[idx];
  if (!m) return;
  const cycle = ['offline', 'online'];
  if (m.activatable)  cycle.push('active');
  if (m.overloadable) cycle.push('overheated');
  m.state = cycle[(cycle.indexOf(m.state) + 1) % cycle.length];
  _fitRenderAll();
}

// Drop payloads: "move:slot:idx" (reposition within a rack) or "new:typeId"
// (from the browser — module to a specific slot, or a charge onto a module).
async function _fitHandleDrop(payload, tgtSlot, tgtIdx) {
  if (!payload || !_fitState.hull) return;

  if (payload.startsWith('move:')) {
    const [, srcSlot, srcIdxS] = payload.split(':');
    const srcIdx = Number(srcIdxS);
    if (srcSlot === tgtSlot && srcIdx === tgtIdx) return;
    if (srcSlot !== tgtSlot) { _fitFlash(`That's a ${srcSlot}-slot module — it can't move to a ${tgtSlot} slot.`); return; }
    const rack = _fitState.modules[srcSlot];
    [rack[srcIdx], rack[tgtIdx]] = [rack[tgtIdx], rack[srcIdx]];   // swap (or move into empty)
    _fitState.selected = null;
    _fitRenderAll();
    return;
  }

  if (payload.startsWith('new:')) {
    const typeId = Number(payload.slice(4));
    const facts = (await window.eveAPI.fitGetItems([typeId]).catch(() => ({})))[typeId];
    if (!facts) return;
    // A charge dropped onto a fitted module loads it (scripts included).
    if (facts.categoryId === 8) {
      const mod = _fitState.modules[tgtSlot]?.[tgtIdx];
      if (!mod) { _fitFlash('Drop charges onto a fitted module.'); return; }
      mod.charge = { id: facts.id, name: facts.name, dmg: facts.dmg, f: facts };
      _fitRenderAll();
      return;
    }
    if (!facts.slot) { _fitFlash('That item doesn’t fit a slot.'); return; }
    if (facts.slot !== tgtSlot) { _fitFlash(`${facts.name} is a ${facts.slot}-slot module.`); return; }
    const replacing = _fitState.modules[tgtSlot][tgtIdx];
    const err = _fitCanFit(facts, replacing);              // hardpoints checked even on replace
    if (err) { _fitFlash(err); return; }
    _fitState.modules[tgtSlot][tgtIdx] = _fitMod(facts);   // place exactly here (replaces)
    _fitState.selected = null;
    _fitRenderAll();
  }
}

async function _fitLoadCharge(typeId, name) {
  const facts = (await window.eveAPI.fitGetItems([typeId]).catch(() => ({})))[typeId];
  if (facts && facts.categoryId === 18) { _fitFlash('Drones aren’t placed in slots yet (Phase 2).'); return; }
  if (!_fitState.selected) { _fitFlash('Select a fitted module first, then click a charge.'); return; }
  const { slot, idx } = _fitState.selected;
  const mod = _fitState.modules[slot]?.[idx];
  if (!mod) { _fitState.selected = null; return; }
  mod.charge = { id: typeId, name, dmg: facts ? facts.dmg : null, f: facts || null };
  _fitRenderAll();
}

// ─── Simulation engine ─────────────────────────────────────────────────────────
// EVE stacking penalty: i-th strongest modifier of the same attribute is scaled by
// e^(−(i/2.67)²) → 100%, 86.9%, 57.1%, 28.3%, 10.6%… Buffs and debuffs penalize
// as separate chains.
function _fitStackChain(fractions) {
  const pos = fractions.filter(b => b > 0).sort((a, b) => b - a);
  const neg = fractions.filter(b => b < 0).sort((a, b) => a - b);
  let mult = 1;
  pos.forEach((b, i) => { mult *= 1 + b * Math.exp(-((i / 2.67) ** 2)); });
  neg.forEach((b, i) => { mult *= 1 + b * Math.exp(-((i / 2.67) ** 2)); });
  return mult;
}

// A fitted module counts (passively) unless offline; active-only modules (TC/MGC)
// need to actually be running.
function _fitContributes(m, needActive) {
  if (m.state === 'offline') return false;
  if (needActive) return m.state === 'active' || m.state === 'overheated';
  return true;
}
function _fitIsHot(m) { return m.state === 'overheated' || (_fitState.heatPreview && m.overloadable); }

// Script mode loaded into a TC/MGC ('range' | 'tracking' | 'precision' | null).
function _fitScriptMode(m) {
  const g = m.charge?.f?.groupId;
  if (g !== 907 && g !== 1400) return null;
  const n = (m.charge.name || '').toLowerCase();
  if (n.includes('optimal') || n.includes('missile range')) return 'range';
  if (n.includes('tracking speed')) return 'tracking';
  if (n.includes('precision')) return 'precision';
  return null;
}

// Weapon flavor from the SDE group name → used to match damage mods & rigs.
function _fitWeaponFlavor(groupName) {
  const g = (groupName || '').toLowerCase();
  if (g.includes('missile launcher') || g === 'missile launcher rapid heavy') return 'missile';
  if (g.includes('energy weapon'))     return 'energy';
  if (g.includes('hybrid weapon'))     return 'hybrid';
  if (g.includes('projectile weapon')) return 'projectile';
  if (g.includes('vorton'))            return 'vorton';
  return null;
}
function _fitModMatchesFlavor(groupName, flavor) {
  const g = (groupName || '').toLowerCase();
  if (flavor === 'energy')     return g.includes('heat sink')      || g.includes('rig energy weapon');
  if (flavor === 'hybrid')     return g.includes('magnetic field') || g.includes('rig hybrid weapon');
  if (flavor === 'projectile') return g.includes('gyrostabilizer') || g.includes('rig projectile weapon');
  if (flavor === 'missile')    return g.includes('ballistic control') || g.includes('rig launcher');
  if (flavor === 'vorton')     return g.includes('entropic') || g.includes('vorton');
  return false;
}

// All fitted modules flat (skips empty positions).
function _fitAllMods() {
  const out = [];
  for (const slot of Object.keys(_fitState.modules)) {
    for (const m of _fitState.modules[slot]) if (m) out.push({ ...m, _slot: slot, ref: m });
  }
  return out;
}

// Range/tracking modifier chains for one weapon kind ('turret' | 'missile').
// Each returned array is a list of bonus FRACTIONS to feed the stacking chain.
function _fitRangeBonuses(kind) {
  const opt = [], fall = [], track = [], vel = [], flight = [];
  for (const m of _fitAllMods()) {
    const f = m.f || {};
    const b = f.bonus || {};
    const g = (f.groupName || '').toLowerCase();
    const heatK = _fitIsHot(m.ref) && f.heat?.trackModBonus ? 1 + f.heat.trackModBonus / 100 : 1;

    if (kind === 'turret') {
      // Tracking Enhancers (passive) — apply unless offline.
      if (g.includes('tracking enhancer') && _fitContributes(m.ref, false)) {
        if (b.optimal)  opt.push(b.optimal / 100);
        if (b.falloff)  fall.push(b.falloff / 100);
        if (b.tracking) track.push(b.tracking / 100);
      }
      // Tracking Computers (active; scripts double one side and zero the other).
      if (g.includes('tracking computer') && _fitContributes(m.ref, true)) {
        const s = _fitScriptMode(m.ref);
        const oB = (s === 'range' ? 2 : s === 'tracking' ? 0 : 1) * (b.optimal  || 0);
        const fB = (s === 'range' ? 2 : s === 'tracking' ? 0 : 1) * (b.falloff  || 0);
        const tB = (s === 'tracking' ? 2 : s === 'range' ? 0 : 1) * (b.tracking || 0);
        if (oB) opt.push(oB * heatK / 100);
        if (fB) fall.push(fB * heatK / 100);
        if (tB) track.push(tB * heatK / 100);
      }
      // Weapon rigs (Locus Coordinator = optimal, Metastasis = tracking, …).
      if (m._slot === 'rig' && g.includes('rig') && !g.includes('rig launcher')) {
        if (b.optimal)  opt.push(b.optimal / 100);
        if (b.falloff)  fall.push(b.falloff / 100);
        if (b.tracking) track.push(b.tracking / 100);
      }
    } else if (kind === 'missile') {
      // Missile Guidance Enhancers (passive) + Computers (active, scripted).
      if (g.includes('missile guidance enhancer') && _fitContributes(m.ref, false)) {
        if (b.mslVel)    vel.push(b.mslVel / 100);
        if (b.mslFlight) flight.push(b.mslFlight / 100);
      }
      if (g.includes('missile guidance computer') && _fitContributes(m.ref, true)) {
        const s = _fitScriptMode(m.ref);
        const vB = (s === 'range' ? 2 : s === 'precision' ? 0 : 1) * (b.mslVel    || 0);
        const fB = (s === 'range' ? 2 : s === 'precision' ? 0 : 1) * (b.mslFlight || 0);
        if (vB) vel.push(vB * heatK / 100);
        if (fB) flight.push(fB * heatK / 100);
      }
      // Hydraulic Bay Thrusters rig: +% missile velocity via speedFactor(20).
      if (m._slot === 'rig' && g.includes('rig launcher') && b.mslVelRig) {
        vel.push(b.mslVelRig / 100);
      }
    }
  }
  return { opt, fall, track, vel, flight };
}

// Damage-mod chains for a flavor (Gyro / Heat Sink / Mag Stab / BCS): dmg + RoF.
function _fitDamageBonuses(flavor) {
  const dmg = [], rofM = [];
  for (const m of _fitAllMods()) {
    const f = m.f || {};
    if (m._slot !== 'low' || !_fitContributes(m.ref, false)) continue;
    if (!_fitModMatchesFlavor(f.groupName, flavor)) continue;
    const dm = flavor === 'missile' ? f.mslDmgMult : f.dmgMultMod;
    if (dm)        dmg.push(dm - 1);
    if (f.rofMult) rofM.push(f.rofMult - 1);   // 0.895 → −0.105 (faster cycle)
  }
  return { dmg, rofM };
}

// Effective hull CPU/PG output after Co-Processors / RCU / PDS + fitting rigs.
function _fitEffOutputs() {
  const hull = _fitState.hull;
  const cpuB = [], pgB = [];
  for (const m of _fitAllMods()) {
    const f = m.f || {};
    if (!_fitContributes(m.ref, false)) continue;
    if (f.cpuMult)     cpuB.push(f.cpuMult - 1);
    if (f.pgMult)      pgB.push(f.pgMult - 1);
    if (f.cpuOutBonus) cpuB.push(f.cpuOutBonus / 100);
    if (f.pgOutBonus)  pgB.push(f.pgOutBonus / 100);
  }
  return {
    cpu: hull.output.cpu * _fitStackChain(cpuB),
    pg:  hull.output.pg  * _fitStackChain(pgB),
  };
}

// Full weapon simulation → one entry per distinct (weapon, charge, state) group:
// { name, count, kind, flavor, dps, volley, optimal, falloff, tracking, range }.
// `heatAll` forces every heat-capable module to compute as overheated (chart preview).
function _fitWeaponSim(heatAll = false) {
  const prevPreview = _fitState.heatPreview;
  if (heatAll) _fitState.heatPreview = true;

  const groups = new Map();
  for (const m of _fitState.modules.high) {
    if (!m) continue;
    const f = m.f || {};
    if (!f.hardpoint) continue;                           // not a weapon
    if (m.state !== 'active' && m.state !== 'overheated' && !heatAll) continue;
    const kind = f.hardpoint === 'launcher' ? 'missile' : 'turret';
    const key  = `${m.id}|${m.charge?.id || 0}|${_fitIsHot(m) || heatAll}`;
    if (!groups.has(key)) groups.set(key, { m, f, count: 0, hot: _fitIsHot(m) || heatAll, kind });
    groups.get(key).count++;
  }

  const out = [];
  for (const g of groups.values()) {
    const { m, f, count, hot, kind } = g;
    const flavor = _fitWeaponFlavor(f.groupName);
    const rb  = _fitRangeBonuses(kind);
    const db  = _fitDamageBonuses(flavor);
    const c   = m.charge, cf = c?.f || {};

    // Rate of fire (ms): damage-mod RoF chain; launcher heat = overloadRofBonus.
    let rof = (f.rof || 1) * _fitStackChain(db.rofM);
    if (hot && kind === 'missile' && f.heat?.rofBonus) rof *= 1 + f.heat.rofBonus / 100;

    // Damage per shot.
    const d = (kind === 'missile' ? cf.dmg : c?.dmg) || c?.dmg;
    let perShot = 0;
    if (d) {
      perShot = (d.em || 0) + (d.th || 0) + (d.kin || 0) + (d.exp || 0);
      if (kind === 'turret') perShot *= (f.dmgMult || 1);
      perShot *= _fitStackChain(db.dmg);
      if (hot && kind === 'turret' && f.heat?.dmgMod) perShot *= 1 + f.heat.dmgMod / 100;
    }
    const dps = perShot > 0 && rof > 0 ? perShot / (rof / 1000) : 0;

    let entry;
    if (kind === 'turret') {
      const ammoOpt  = (cf.rangeMult   != null) ? cf.rangeMult   : 1;
      const ammoFall = (cf.falloffMult != null) ? cf.falloffMult : 1;
      entry = {
        kind, flavor, count, hot, name: f.name, chargeName: c?.name || null,
        dps: dps * count, volley: perShot * count,
        optimal:  (f.optimal  || 0) * ammoOpt  * _fitStackChain(rb.opt),
        falloff:  (f.falloff  || 0) * ammoFall * _fitStackChain(rb.fall),
        tracking: (f.tracking || 0) * _fitStackChain(rb.track),
      };
      entry.range = entry.optimal + entry.falloff;
    } else {
      const vel    = (cf.missileVel || 0) * _fitStackChain(rb.vel);
      const flight = ((cf.flightMs || 0) / 1000) * _fitStackChain(rb.flight);
      entry = {
        kind, flavor, count, hot, name: f.name, chargeName: c?.name || null,
        dps: dps * count, volley: perShot * count,
        optimal: vel * flight, falloff: 0, tracking: null,
        range: vel * flight,
      };
    }
    if (entry.range > 0 || entry.dps > 0) out.push(entry);
  }

  _fitState.heatPreview = prevPreview;
  return out;
}

// Applied-DPS fraction at range r (m). Turrets: 0.5^((max(0,r−opt)/falloff)²) —
// the standard falloff curve at 0 transversal. Missiles: flat to max range.
function _fitAppliedAt(g, r) {
  if (g.kind === 'missile') return r <= g.range ? 1 : 0;
  if (r <= g.optimal) return 1;
  if (!g.falloff) return 0;
  return Math.pow(0.5, Math.pow((r - g.optimal) / g.falloff, 2));
}

// ─── Fitting wheel render ──────────────────────────────────────────────────────
function _fitPolar(deg, radius) {
  const rad = (deg * Math.PI) / 180;
  const C = FIT_WHEEL.size / 2;
  return [C + radius * Math.sin(rad), C - radius * Math.cos(rad)];
}

// Evenly distribute n slots inside an arc, centred, spacing capped so small
// counts don't spread across the whole span.
function _fitArcAngles(arc, n) {
  if (n <= 0) return [];
  const span = arc.to - arc.from;
  const spacing = n === 1 ? 0 : Math.min(span / (n - 1), 17);
  const start = (arc.from + arc.to) / 2 - (spacing * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => start + i * spacing);
}

function _fitRingSvg(hull) {
  const C = FIT_WHEEL.size / 2;
  const arcPath = (r, a0, a1) => {
    const [x0, y0] = _fitPolar(a0, r), [x1, y1] = _fitPolar(a1, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  let paths = `<circle cx="${C}" cy="${C}" r="${FIT_WHEEL.outerR}" class="fw-ring-base"/>`;
  for (const [key, arc] of Object.entries(FIT_WHEEL.arcs)) {
    const cap = hull.slots[key] || 0;
    if (!cap) continue;
    const r = arc.r === 'outer' ? FIT_WHEEL.outerR : FIT_WHEEL.innerR;
    paths += `<path d="${arcPath(r, arc.from, arc.to)}" class="fw-ring-arc"/>`;
    const mid = (arc.from + arc.to) / 2;
    const [lx, ly] = _fitPolar(mid, r + (arc.r === 'outer' ? 38 : -36));
    paths += `<text x="${lx}" y="${ly}" class="fw-ring-label">${arc.label}</text>`;
  }
  return `<svg class="fw-ring" viewBox="0 0 ${FIT_WHEEL.size} ${FIT_WHEEL.size}">${paths}</svg>`;
}

function _fitRenderCanvas() {
  const head  = document.getElementById('fitHullName');
  const wheel = document.getElementById('fitWheel');
  if (!head || !wheel) return;
  const hull = _fitState.hull;
  head.textContent = hull ? `${hull.name} — ${_fitState.fitName}` : 'No hull — pick one from Hulls';

  if (!hull) {
    wheel.innerHTML = `<div class="fit-hint" style="padding-top:220px;">Select a hull from the Hulls tab to start fitting.</div>`;
    return;
  }

  _fitSimCache = _fitWeaponSim();
  const eff = _fitEffOutputs();
  const use = _fitComputeUsage();

  let cells = '';
  for (const [key, arc] of Object.entries(FIT_WHEEL.arcs)) {
    const cap = hull.slots[key] || 0;
    if (!cap) continue;
    const r = arc.r === 'outer' ? FIT_WHEEL.outerR : FIT_WHEEL.innerR;
    const angles = _fitArcAngles(arc, cap);
    const fitted = _fitState.modules[key] || [];
    // Heat bleeds into ADJACENT slots — flag occupied neighbours of an overheated
    // module so the layout consequence is visible (empty/passive neighbours soak heat).
    const hotAdj = new Set();
    fitted.forEach((m, i) => {
      if (m && m.state === 'overheated') {
        if (fitted[i - 1]) hotAdj.add(i - 1);
        if (fitted[i + 1]) hotAdj.add(i + 1);
      }
    });
    angles.forEach((deg, i) => {
      const [x, y] = _fitPolar(deg, r);
      const m = fitted[i];
      const pos = `left:${x}px;top:${y}px;`;
      if (m) {
        const sel = _fitState.selected && _fitState.selected.slot === key && _fitState.selected.idx === i;
        cells += `
          <div class="fw-slot state-${m.state} ${sel ? 'sel' : ''} ${hotAdj.has(i) && m.state !== 'overheated' ? 'fw-heat-adjacent' : ''}"
               style="${pos}" data-slot="${key}" data-idx="${i}" data-name="${_fitEsc(m.name)}" draggable="true">
            <img src="https://images.evetech.net/types/${m.id}/icon?size=64" alt="" draggable="false"/>
            ${m.charge ? `<img class="fw-charge" src="https://images.evetech.net/types/${m.charge.id}/icon?size=32" alt="" title="${_fitEsc(m.charge.name)}"/>` : ''}
            <button class="fw-x" data-remove="${key}:${i}" title="Remove">✕</button>
          </div>`;
      } else {
        cells += `<div class="fw-slot empty" style="${pos}" data-slot="${key}" data-idx="${i}" title="Empty ${key} slot — drag a module here"><span>${arc.label[0]}</span></div>`;
      }
    });
  }

  const pct = (u, t) => t ? Math.min(100, (u / t) * 100) : 0;
  wheel.innerHTML = `
    ${_fitRingSvg(hull)}
    <div class="fw-center">
      <img id="fwShip" class="fw-ship" src="https://images.evetech.net/types/${hull.id}/render?size=512"
           alt="${_fitEsc(hull.name)}" draggable="false"
           onerror="this.onerror=null;this.src='https://images.evetech.net/types/${hull.id}/icon?size=64'"/>
      <div class="fw-center-bars">
        <div class="fw-mini-bar" title="CPU"><span>CPU</span><div class="fw-mini-track"><div class="fw-mini-fill ${use.cpu > eff.cpu ? 'over' : ''}" style="width:${pct(use.cpu, eff.cpu)}%"></div></div></div>
        <div class="fw-mini-bar" title="Powergrid"><span>PWR</span><div class="fw-mini-track"><div class="fw-mini-fill ${use.pg > eff.pg ? 'over' : ''}" style="width:${pct(use.pg, eff.pg)}%"></div></div></div>
      </div>
    </div>
    ${cells}
    <div id="fwTip" class="fw-tip" style="display:none;"></div>`;

  // ── Interactions ──
  wheel.querySelectorAll('.fw-slot').forEach(el => {
    const slot = el.dataset.slot, idx = Number(el.dataset.idx);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.fw-x')) return;
      if (el.classList.contains('empty')) return;
      const cur = _fitState.selected;
      _fitState.selected = (cur && cur.slot === slot && cur.idx === idx) ? null : { slot, idx };
      _fitRenderAll();
    });
    el.addEventListener('dblclick', (e) => { e.preventDefault(); if (!el.classList.contains('empty')) _fitCycleState(slot, idx); });
    el.addEventListener('mouseenter', () => _fitShowTip(el, slot, idx));
    el.addEventListener('mouseleave', () => { const t = document.getElementById('fwTip'); if (t) t.style.display = 'none'; });

    // Drag a fitted module to reposition it within its rack (heat management).
    el.addEventListener('dragstart', (e) => {
      if (el.classList.contains('empty')) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', `move:${slot}:${idx}`);
      e.dataTransfer.effectAllowed = 'move';
    });
    // Every cell (filled or empty) is a drop target.
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('fw-drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('fw-drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('fw-drop');
      _fitHandleDrop(e.dataTransfer.getData('text/plain'), slot, idx);
    });
  });
  wheel.querySelectorAll('.fw-x').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const [slot, idx] = btn.dataset.remove.split(':');
    _fitState.modules[slot][Number(idx)] = null;   // keep positions of everything else
    _fitState.selected = null;
    _fitRenderAll();
  }));

  // Ship parallax tilt — follows the cursor across the wheel ("movable" centre).
  const ship = wheel.querySelector('#fwShip');
  if (ship) {
    wheel.addEventListener('mousemove', (e) => {
      const r = wheel.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      ship.style.transform = `perspective(700px) rotateY(${nx * 14}deg) rotateX(${ny * -14}deg)`;
    });
    wheel.addEventListener('mouseleave', () => { ship.style.transform = 'perspective(700px)'; });
  }
}

// Tooltip: module identity + state + (for weapons) simulated range numbers.
function _fitShowTip(el, slot, idx) {
  const tip = document.getElementById('fwTip');
  const m = _fitState.modules[slot]?.[idx];
  if (!tip) return;
  if (!m) {
    tip.innerHTML = `<div class="fw-tip-name">Empty ${slot} slot</div>
      <div class="fw-tip-sub">Drag a module here (or click one in the browser).</div>
      <div class="fw-tip-hint">Empty slots between hot modules soak overheat damage.</div>`;
  } else {
    const sim = (_fitSimCache || []).find(g => g.name === m.name && (g.chargeName || null) === (m.charge?.name || null));
    tip.innerHTML = `
      <div class="fw-tip-name">${_fitEsc(m.name)}</div>
      ${m.charge ? `<div class="fw-tip-sub">↳ ${_fitEsc(m.charge.name)}</div>` : ''}
      <div class="fw-tip-sub">state: <b class="fw-tip-${m.state}">${m.state}</b> · ${_fitNum(m.cpu)} tf · ${_fitNum(m.pg)} MW</div>
      ${sim ? `<div class="fw-tip-sub">${sim.kind === 'turret'
          ? `optimal ${_fitKm(sim.optimal)} + ${_fitKm(sim.falloff)} falloff · tracking ${sim.tracking.toFixed(3)}`
          : `range ≈ ${_fitKm(sim.range)}`} · ${_fitNum(sim.dps / sim.count)} dps</div>` : ''}
      ${m.state === 'overheated' ? `<div class="fw-tip-sub" style="color:#ff5b50;">⚠ heat bleeds into adjacent slots — buffer with empty/passive slots</div>` : ''}
      <div class="fw-tip-hint">click = select for charge · double-click = cycle state · drag = reposition</div>`;
  }
  tip.style.display = 'block';
  const wr = el.parentElement.getBoundingClientRect(), er = el.getBoundingClientRect();
  let tx = er.left - wr.left + 30, ty = er.top - wr.top + 30;
  if (tx > FIT_WHEEL.size - 240) tx -= 270;
  if (ty > FIT_WHEEL.size - 120) ty -= 130;
  tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
}

// ─── Stats panel ────────────────────────────────────────────────────────────────
function _fitRenderStats() {
  const el = document.getElementById('fitStats');
  if (!el) return;
  const hull = _fitState.hull;
  if (!hull) { el.innerHTML = `<div class="fit-hint">Stats appear once a hull is loaded.</div>`; return; }

  const u   = _fitComputeUsage();
  const eff = _fitEffOutputs();
  const off = _fitComputeOffense();
  const def = _fitComputeDefense();
  const cap = _fitCapDerived();
  const nav = _fitNavDerived();
  const t   = hull.targeting;
  const sim = _fitSimCache || _fitWeaponSim();

  const bar = (label, used, total, unit) => {
    const over = used > total + 1e-6;
    const pctW  = total ? Math.min(100, (used / total) * 100) : 0;
    return `<div class="fit-stat-row ${over ? 'over' : ''}">
        <div class="fit-stat-top"><span>${label}</span><span>${_fitNum(used)} / ${_fitNum(total)} ${unit}</span></div>
        <div class="fit-bar"><div class="fit-bar-fill ${over ? 'over' : ''}" style="width:${pctW}%;"></div></div>
      </div>`;
  };
  const line = (label, val) => `<div class="fit-mini"><span>${label}</span><span>${val}</span></div>`;

  // Weapon rows under the chart.
  const wrows = sim.map((g, i) => `
    <div class="fit-mini fit-weapon-row">
      <span><span class="fit-series-dot" style="background:${FIT_CHART_COLORS[i % FIT_CHART_COLORS.length]}"></span>
        ${g.count}× ${_fitEsc(g.name)}${g.hot ? ' <span class="fit-hot">HOT</span>' : ''}</span>
      <span>${g.kind === 'turret' ? `${_fitKm(g.optimal)} + ${_fitKm(g.falloff)}` : `≈ ${_fitKm(g.range)}`} · ${_fitNum(g.dps)} dps</span>
    </div>`).join('');

  el.innerHTML = `
    <!-- Fitting resources (rig/module-modified output) -->
    <div class="fit-stats-card">
      <div class="fit-stats-title">FITTING <span class="fit-note">incl. rigs &amp; mods</span></div>
      ${bar('CPU', u.cpu, eff.cpu, 'tf')}
      ${bar('Powergrid', u.pg, eff.pg, 'MW')}
      <div class="fit-mini-grid">
        ${line('Turrets', `<span class="${u.turret > hull.hardpoints.turret ? 'fit-over' : ''}">${u.turret}/${hull.hardpoints.turret}</span>`)}
        ${line('Launchers', `<span class="${u.launcher > hull.hardpoints.launcher ? 'fit-over' : ''}">${u.launcher}/${hull.hardpoints.launcher}</span>`)}
      </div>
    </div>

    <!-- Weapon performance -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">radar</span> WEAPON RANGES <span class="fit-note">pre-skill · 0 transversal</span></div>
      ${sim.length ? `
        <canvas id="fitRangeChart" height="170"></canvas>
        <div id="fitChartLegend" class="fit-chart-legend"></div>
        <label class="fit-heat-toggle"><input type="checkbox" id="fitHeatPreview" ${_fitState.heatPreview ? 'checked' : ''}> Preview everything overheated</label>
        ${wrows}`
      : `<div class="fit-note-line">Fit weapons (and load charges) to simulate optimal, falloff and applied DPS vs range — including ammo, tracking mods, scripts, rigs and heat.</div>`}
    </div>

    <!-- Offense -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">crisis_alert</span> OFFENSE <span class="fit-note">pre-skill</span></div>
      <div class="fit-big">${_fitNum(off.dps)} <span class="fit-big-unit">dps</span></div>
      ${line('Volley', `${_fitNum(off.volley)} hp`)}
      ${off.dps === 0 ? `<div class="fit-note-line">Fit turrets/launchers, set them active, and load charges to see weapon DPS.</div>` : ''}
    </div>

    <!-- Capacitor -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">bolt</span> CAPACITOR</div>
      <div class="fit-cap">
        <svg viewBox="0 0 56 56" class="fit-cap-ring"><circle cx="28" cy="28" r="23" class="fit-cap-bg"/><circle cx="28" cy="28" r="23" class="fit-cap-fg"/></svg>
        <div class="fit-cap-info">
          <div class="fit-cap-gj">${_fitNum(hull.base.capacitor)} GJ</div>
          <div class="fit-cap-sub">${_fitNum(cap.rechargeSec)} s recharge</div>
          <div class="fit-cap-sub">Peak +${_fitNum(cap.peakRegen)} GJ/s</div>
        </div>
      </div>
      <div class="fit-note-line">Cap stability under load needs the active-module sim — coming.</div>
    </div>

    <!-- Defense -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">shield</span> DEFENSE <span class="fit-note">base hull</span></div>
      <div class="fit-big">${_fitNum(def.ehp)} <span class="fit-big-unit">ehp</span></div>
      <div class="fit-res-head"><span></span>${['EM', 'Th', 'Kin', 'Exp'].map(x => `<span>${x}</span>`).join('')}</div>
      ${_fitLayerRow('Shield', hull.base.shieldHp, hull.base.shieldRes)}
      ${_fitLayerRow('Armor', hull.base.armorHp, hull.base.armorRes)}
      ${_fitLayerRow('Structure', hull.base.structureHp, hull.base.hullRes)}
    </div>

    <!-- Targeting -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">my_location</span> TARGETING</div>
      ${line('Lock range', `${_fitNum(t.lockRange / 1000)} km`)}
      ${line('Scan res', `${_fitNum(t.scanRes)} mm`)}
      ${line(`${t.sensorType} str`, `${_fitNum(t.sensorStrength)} pts`)}
      ${line('Max targets', `${t.maxTargets}`)}
    </div>

    <!-- Navigation -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">navigation</span> NAVIGATION</div>
      ${line('Max velocity', `${_fitNum(nav.maxVel)} m/s`)}
      ${line('Align time', `${_fitNum(nav.align)} s`)}
      ${line('Warp speed', `${_fitNum(nav.warp)} AU/s`)}
      ${line('Mass', `${_fitNum(nav.massT)} t`)}
      ${line('Sig radius', `${_fitNum(nav.sig)} m`)}
    </div>`;

  const heat = el.querySelector('#fitHeatPreview');
  if (heat) heat.addEventListener('change', () => { _fitState.heatPreview = heat.checked; _fitRenderAll(); });

  if (sim.length) requestAnimationFrame(() => _fitDrawRangeChart(sim));
}

// ─── Applied-DPS-vs-range chart ────────────────────────────────────────────────
// Computes scales + heat overlay once, delegates all drawing to the inner renderer,
// and overlays a crosshair + readout on hover.
function _fitDrawRangeChart(sim) {
  const cv = document.getElementById('fitRangeChart');
  const legend = document.getElementById('fitChartLegend');
  if (!cv) return;
  cv.width = cv.clientWidth || 230;

  // Heat overlay: skip when the whole panel is already in heat-preview mode.
  const heatSim = _fitState.heatPreview ? null : _fitWeaponSim(true);
  const totalAt = (set, r) => set.reduce((s, g) => s + g.dps * _fitAppliedAt(g, r), 0);
  const xmax = Math.max(...sim.map(g => g.kind === 'turret' ? g.optimal + 2.2 * g.falloff : g.range * 1.15), 1000) * 1.05;
  let ymax = 0;
  for (let i = 0; i <= 60; i++) {
    const r = (xmax * i) / 60;
    ymax = Math.max(ymax, totalAt(sim, r), heatSim ? totalAt(heatSim, r) : 0);
  }
  ymax = ymax * 1.08 || 1;

  const p = { sim, heatSim, xmax, ymax, totalAt };
  _fitDrawRangeChartBase(cv, p);

  if (legend) {
    const chip = (c, l, dashed) => `<span class="fit-legend-chip"><span class="fit-series-dot ${dashed ? 'dashed' : ''}" style="background:${c}"></span>${_fitEsc(l)}</span>`;
    legend.innerHTML = sim.map((g, i) => chip(FIT_CHART_COLORS[i % FIT_CHART_COLORS.length], `${g.count}× ${g.name.split(' ').slice(0, 2).join(' ')}`)).join('')
      + (sim.length > 1 ? chip(FIT_CHART_TOTAL, 'total', true) : '')
      + (heatSim && heatSim.length ? chip(FIT_CHART_HEAT, 'total overheated', true) : '');
  }

  // Crosshair + readout.
  const padL = 34, padR = 8, padT = 8, padB = 20;
  cv.onmousemove = (e) => {
    const rect = cv.getBoundingClientRect();
    const W = cv.width, H = cv.height;
    const r = Math.max(0, Math.min(xmax, ((e.clientX - rect.left) - padL) / (W - padL - padR) * xmax));
    _fitDrawRangeChartBase(cv, p);
    const ctx = cv.getContext('2d');
    const x = padL + (r / xmax) * (W - padL - padR);
    ctx.strokeStyle = 'rgba(223,229,240,0.5)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#dfe5f0'; ctx.font = '10px monospace'; ctx.textAlign = x > W - 90 ? 'right' : 'left';
    ctx.fillText(`${_fitKm(r)} — ${_fitNum(totalAt(sim, r))} dps`, x + (x > W - 90 ? -6 : 6), padT + 10);
  };
  cv.onmouseleave = () => _fitDrawRangeChartBase(cv, p);
}

// Base render: grid, axes, series curves, total + heat overlays.
function _fitDrawRangeChartBase(cv, p) {
  const { sim, heatSim, xmax, ymax, totalAt } = p;
  const W = cv.width, H = cv.height, ctx = cv.getContext('2d');
  const padL = 34, padR = 8, padT = 8, padB = 20;
  const X = r => padL + (r / xmax) * (W - padL - padR);
  const Y = v => padT + (1 - v / ymax) * (H - padT - padB);
  ctx.clearRect(0, 0, W, H);

  // Recessive grid + axis labels.
  ctx.strokeStyle = 'rgba(150,160,176,0.13)'; ctx.lineWidth = 1;
  ctx.font = '9px monospace'; ctx.fillStyle = 'rgba(150,160,176,0.75)';
  const kmStep = _fitNiceStep(xmax / 1000, 4);
  for (let km = kmStep; km * 1000 < xmax; km += kmStep) {
    const x = X(km * 1000);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(`${km}km`, x, H - 8);
  }
  const dpsStep = _fitNiceStep(ymax, 3);
  for (let v = dpsStep; v < ymax; v += dpsStep) {
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(_fitNum(v), padL - 4, y + 3);
  }
  ctx.strokeStyle = 'rgba(150,160,176,0.35)';
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.lineTo(W - padR, H - padB); ctx.stroke();

  const drawCurve = (fn, color, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash || []);
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const r = (xmax * i) / 120, y = Y(fn(r));
      if (i === 0) ctx.moveTo(X(r), y); else ctx.lineTo(X(r), y);
    }
    ctx.stroke(); ctx.setLineDash([]);
  };
  sim.forEach((g, i) => drawCurve(r => g.dps * _fitAppliedAt(g, r), FIT_CHART_COLORS[i % FIT_CHART_COLORS.length]));
  if (sim.length > 1) drawCurve(r => totalAt(sim, r), FIT_CHART_TOTAL, [5, 4]);
  if (heatSim && heatSim.length) drawCurve(r => totalAt(heatSim, r), FIT_CHART_HEAT, [2, 3]);
}

function _fitNiceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

// ─── Derived stats (unchanged math) ───────────────────────────────────────────
function _fitResistPct(resonance) { return (resonance == null) ? null : Math.round((1 - resonance) * 100); }
function _fitResistCells(res) {
  return [['em', 'EM'], ['th', 'Th'], ['kin', 'Kin'], ['exp', 'Exp']].map(([k]) => {
    const pct = _fitResistPct(res[k]);
    return `<span class="fit-res fit-res-${k}">${pct == null ? '–' : pct + '%'}</span>`;
  }).join('');
}
function _fitLayerRow(label, hp, res) {
  return `<div class="fit-layer">
      <span class="fit-layer-name">${label}<span class="fit-layer-hp">${_fitNum(hp)}</span></span>
      ${_fitResistCells(res)}
    </div>`;
}
function _fitLayerEHP(hp, res) {
  const vals = [res.em, res.th, res.kin, res.exp].filter(v => v != null);
  if (!hp || !vals.length) return hp || 0;
  const avgRes = vals.reduce((s, v) => s + v, 0) / vals.length;
  return avgRes > 0 ? hp / avgRes : hp;
}
function _fitComputeDefense() {
  const b = _fitState.hull.base;
  const ehp = _fitLayerEHP(b.shieldHp, b.shieldRes) + _fitLayerEHP(b.armorHp, b.armorRes) + _fitLayerEHP(b.structureHp, b.hullRes);
  return { ehp };
}

// Offense now comes from the sim (damage mods, heat, stacking included).
function _fitComputeOffense() {
  const sim = _fitSimCache || _fitWeaponSim();
  return { dps: sim.reduce((s, g) => s + g.dps, 0), volley: sim.reduce((s, g) => s + g.volley, 0) };
}

function _fitCapDerived() {
  const b = _fitState.hull.base;
  const rechargeSec = (b.rechargeMs || 0) / 1000;
  const peakRegen = rechargeSec > 0 ? (2.5 * b.capacitor) / rechargeSec : 0;
  return { rechargeSec, peakRegen };
}
function _fitNavDerived() {
  const n = _fitState.hull.nav;
  const align = (n.mass && n.agility) ? (Math.log(4) * n.agility * n.mass) / 1e6 : 0;
  return { maxVel: n.maxVel, align, warp: n.warpMult, massT: (n.mass || 0) / 1000, sig: n.sig };
}
function _fitComputeUsage() {
  let cpu = 0, pg = 0, turret = 0, launcher = 0;
  for (const key of Object.keys(_fitState.modules)) {
    for (const m of _fitState.modules[key]) {
      if (!m) continue;
      if (m.state !== 'offline') { cpu += m.cpu || 0; pg += m.pg || 0; }
      if (m.hardpoint === 'turret') turret++;
      else if (m.hardpoint === 'launcher') launcher++;
    }
  }
  return { cpu, pg, turret, launcher };
}

// ─── EFT import / export ──────────────────────────────────────────────────────
function _fitToEFT() {
  const h = _fitState.hull;
  if (!h) return '';
  const lines = [`[${h.name}, ${_fitState.fitName || 'EVE Carbon Fit'}]`];
  for (const s of ['low', 'med', 'high', 'rig', 'subsystem']) {
    for (const m of (_fitState.modules[s] || [])) {
      if (m) lines.push(m.charge ? `${m.name}, ${m.charge.name}` : m.name);
    }
  }
  return lines.join('\n');
}

function _fitCopyEFT() {
  const text = _fitToEFT();
  if (!text) { _fitFlash('Nothing to copy — load a hull first.'); return; }
  navigator.clipboard.writeText(text).then(() => _fitFlash('EFT copied to clipboard.'));
}

function _fitShowEftPaste() {
  const panel = document.getElementById('fitImportPanel');
  if (!panel) return;
  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="fit-import-title">Paste an EFT fit, then Import</div>
    <textarea id="fitEftText" class="field-input" rows="8" placeholder="[Rifter, My Fit]\n200mm AutoCannon II, Hail S\n..."></textarea>
    <div class="fit-import-actions">
      <button id="fitEftGo" class="fit-btn fit-btn-accent">Import</button>
      <button id="fitEftCancel" class="fit-btn">Cancel</button>
    </div>`;
  panel.querySelector('#fitEftCancel').addEventListener('click', () => { panel.style.display = 'none'; });
  panel.querySelector('#fitEftGo').addEventListener('click', async () => {
    await _fitImportEFT(panel.querySelector('#fitEftText').value);
    panel.style.display = 'none';
  });
}

async function _fitImportEFT(text) {
  const raw = String(text || '').trim();
  if (!raw) return;
  const lines = raw.split(/\r?\n/).map(l => l.trim());
  const header = lines.shift() || '';
  const hm = header.match(/^\[([^,\]]+)\s*,\s*([^\]]*)\]/);
  if (!hm) { _fitFlash('First line must be [Hull, Fit name].'); return; }
  const hullName = hm[1].trim();
  const fitName  = (hm[2] || '').trim() || 'Imported Fit';

  const moduleNames = [], chargeNames = [], parsed = [];
  for (const line of lines) {
    if (!line) continue;
    if (/\sx\d+$/i.test(line)) continue;            // drones/cargo "Item x5" — skip in v1
    const [modName, chargeName] = line.split(',').map(s => s.trim());
    if (!modName) continue;
    moduleNames.push(modName);
    if (chargeName) chargeNames.push(chargeName);
    parsed.push({ modName, chargeName });
  }

  const res = await window.eveAPI.fitLookupNames([hullName, ...moduleNames, ...chargeNames]).catch(() => ({ byName: {} }));
  const byName = res.byName || {};
  const hullFacts = byName[hullName.toLowerCase()];
  if (!hullFacts || hullFacts.categoryId !== 6) { _fitFlash(`Hull "${hullName}" not found.`); return; }

  await _fitLoadHull(hullFacts.id);
  let placed = 0, skipped = 0;
  for (const { modName, chargeName } of parsed) {
    const f = byName[modName.toLowerCase()];
    if (!f || !f.slot || _fitCanFit(f)) { skipped++; continue; }   // incl. hardpoint check
    const mod = _fitMod(f);
    if (chargeName && byName[chargeName.toLowerCase()]) {
      const cf = byName[chargeName.toLowerCase()];
      mod.charge = { id: cf.id, name: cf.name, dmg: cf.dmg, f: cf };
    }
    if (_fitPlace(f.slot, mod)) placed++; else skipped++;
  }
  _fitState.fitName = fitName;
  _fitRenderAll();
  _fitFlash(`Imported ${placed} module${placed === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped` : ''}.`);
}

// ─── ESI: game fits ───────────────────────────────────────────────────────────
async function _fitPopulateChars() {
  const sel = document.getElementById('fitCharSelect');
  if (!sel) return;
  const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
  if (!accounts.length) { sel.innerHTML = `<option value="">No characters</option>`; return; }
  const last = localStorage.getItem('fit_char') || '';
  sel.innerHTML = accounts.map(a => `<option value="${a.characterId}">${_fitEsc(a.characterName)}</option>`).join('');
  if (last && accounts.some(a => String(a.characterId) === String(last))) sel.value = last;
  sel.addEventListener('change', () => {
    localStorage.setItem('fit_char', sel.value);
    // Character changed → saved fits + skill levels no longer apply.
    _fitState.fitsByHull = null; _fitState.fitsChar = null;
    _fitState.skillLevels = null; _fitState.skillsChar = null;
    _fitRenderBrowser();
  });
}

async function _fitImportFromGame() {
  const sel = document.getElementById('fitCharSelect');
  const charId = sel ? sel.value : '';
  if (!charId) { _fitFlash('Pick a character first.'); return; }
  const panel = document.getElementById('fitImportPanel');
  panel.style.display = 'block';
  panel.innerHTML = `<div class="fit-hint">Loading saved fits…</div>`;
  const res = await window.eveAPI.fitGetFittings(charId).catch(() => ({ ok: false }));
  if (res.needsReauth) { panel.innerHTML = `<div class="fit-hint">Re-authenticate this character to grant fittings access.</div>`; return; }
  if (!res.ok || !res.fittings.length) { panel.innerHTML = `<div class="fit-hint">${res.ok ? 'No saved fits.' : (res.error || 'Failed to load fits.')}</div>`; return; }
  _fitState.gameFits = res.fittings;
  panel.innerHTML = `
    <div class="fit-import-title">Your saved fits — click one to load</div>
    <div class="fit-gamefit-list">
      ${res.fittings.map((f, i) => `
        <button class="fit-gamefit" data-fitidx="${i}">
          <img src="https://images.evetech.net/types/${f.shipTypeId}/icon?size=32" alt=""/>
          <span>${_fitEsc(f.name)}</span>
        </button>`).join('')}
    </div>
    <div class="fit-import-actions"><button id="fitGameCancel" class="fit-btn">Close</button></div>`;
  panel.querySelector('#fitGameCancel').addEventListener('click', () => { panel.style.display = 'none'; });
  panel.querySelectorAll('.fit-gamefit').forEach(b => b.addEventListener('click', () => {
    _fitLoadGameFit(_fitState.gameFits[Number(b.dataset.fitidx)]);
    panel.style.display = 'none';
  }));
}

// flag → slot: HiSlot 27-34, MedSlot 19-26, LoSlot 11-18, RigSlot 92-94, SubSystem 125-132
function _fitFlagToSlot(flag) {
  if (flag >= 27 && flag <= 34) return 'high';
  if (flag >= 19 && flag <= 26) return 'med';
  if (flag >= 11 && flag <= 18) return 'low';
  if (flag >= 92 && flag <= 94) return 'rig';
  if (flag >= 125 && flag <= 132) return 'subsystem';
  return null;
}

async function _fitLoadGameFit(fit) {
  if (!fit) return;
  await _fitLoadHull(fit.shipTypeId);
  if (!_fitState.hull) return;
  const ids   = [...new Set(fit.items.map(i => i.typeId))];
  const facts = await window.eveAPI.fitGetItems(ids).catch(() => ({}));
  // Place modules at their EXACT in-game slot position (flag − rack base) so the
  // saved layout — including heat-management gaps — survives the round-trip.
  const flagBase = { high: 27, med: 19, low: 11, rig: 92, subsystem: 125 };
  const charges = [];
  for (const it of fit.items) {
    const f = facts[it.typeId];
    if (!f) continue;
    if (f.categoryId === 8) { charges.push({ it, f }); continue; }
    const slot = _fitFlagToSlot(it.flag) || f.slot;
    if (!slot) continue;
    const atIdx = _fitFlagToSlot(it.flag) ? it.flag - flagBase[slot] : null;
    const qty = it.quantity || 1;
    for (let n = 0; n < qty; n++) _fitPlace(slot, _fitMod(f), n === 0 ? atIdx : null);
  }
  for (const { it, f } of charges) {
    const slot = _fitFlagToSlot(it.flag);
    const rack = _fitState.modules[slot] || [];
    const exact = _fitFlagToSlot(it.flag) ? rack[it.flag - flagBase[slot]] : null;
    const target = (exact && !exact.charge) ? exact : rack.find(m => m && !m.charge);
    if (target) target.charge = { id: f.id, name: f.name, dmg: f.dmg, f };
  }
  _fitState.fitName = fit.name || 'Imported Fit';
  _fitRenderAll();
  _fitFlash(`Loaded "${fit.name}".`);
}

async function _fitSaveToGame() {
  const sel = document.getElementById('fitCharSelect');
  const charId = sel ? sel.value : '';
  if (!charId) { _fitFlash('Pick a character first.'); return; }
  if (!_fitState.hull) { _fitFlash('Load a hull first.'); return; }

  const base = { high: 27, med: 19, low: 11, rig: 92, subsystem: 125 };
  const items = [];
  for (const slot of Object.keys(base)) {
    (_fitState.modules[slot] || []).forEach((m, i) => {
      if (!m) return;                                   // real positions preserved
      items.push({ typeId: m.id, flag: base[slot] + i, quantity: 1 });
      if (m.charge) items.push({ typeId: m.charge.id, flag: base[slot] + i, quantity: 1 });
    });
  }
  const fit = { name: _fitState.fitName || 'EVE Carbon Fit', description: 'Created in EVE Carbon', shipTypeId: _fitState.hull.id, items };
  _fitFlash('Saving to game…');
  const res = await window.eveAPI.fitSaveFitting(charId, fit).catch(e => ({ ok: false, error: e.message }));
  if (res.needsReauth) { _fitFlash('Re-authenticate this character to grant fittings write access.'); return; }
  _fitFlash(res.ok ? 'Saved to game — check Fittings in the EVE client.' : (res.error || 'Save failed.'));
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function _fitNum(n) {
  n = Number(n) || 0;
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : (Math.round(n * 10) / 10).toString();
}
function _fitKm(m) {
  const km = (Number(m) || 0) / 1000;
  return km >= 100 ? `${Math.round(km)} km` : `${(Math.round(km * 10) / 10)} km`;
}
function _fitFlash(msg) {
  const head = document.getElementById('fitHullName');
  if (!head) return;
  const old = head.dataset.flashOld || head.textContent;
  head.dataset.flashOld = _fitState.hull ? `${_fitState.hull.name} — ${_fitState.fitName}` : 'No hull — pick one from Hulls';
  head.textContent = msg;
  clearTimeout(_fitFlash._t);
  _fitFlash._t = setTimeout(() => { head.textContent = head.dataset.flashOld; }, 2600);
}
function _fitEsc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
