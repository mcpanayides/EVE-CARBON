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
// Honesty note: a skill profile (character / all-0 / all-V) is applied across the
// common skill families (gunnery, missiles, drones, tank, cap, nav, targeting,
// fitting). Per-HULL trait bonuses (ship role bonuses like "25% bonus to Medium
// Projectile damage") are NOT applied yet — that needs the full dogma trait
// engine. Everything shown is computed from exact SDE values with EVE's
// stacking-penalty formula.

const FIT_SLOTS = [
  { key: 'high', label: 'High Slots' },
  { key: 'med',  label: 'Mid Slots'  },
  { key: 'low',  label: 'Low Slots'  },
  { key: 'rig',  label: 'Rig Slots'  },
  { key: 'subsystem', label: 'Subsystems' },
];

// Wheel geometry — matches the in-game fitting window: the ship render fills a
// circular porthole, and all slots sit ON the dark ring band around it.
// Arcs are degrees clockwise from 12 o'clock: HIGH top, MID right, LOW left,
// rigs bottom-right, subsystems (T3) bottom-left.
const FIT_WHEEL = {
  size: 720, slotR: 310, portholeR: 266, cell: 46,
  // Minimum angular spacing so 46px cells at r=310 can never overlap.
  minSpacing: 9.5,
};

// Layout copied 1:1 from the in-game fitting window. FIXED positions, always:
//   8 HIGH across the top · 8 MID on the right · 8 LOW on the bottom ·
//   4 SUBSYSTEMS lower-left (T3 only) · 3 RIGS upper-left.
// Tight 10° spacing INSIDE a group, wide 20° breaks BETWEEN groups — the groups
// read as distinct blocks, and the ring sums to exactly 360°.
const FIT_WHEEL_ARCS = {
  high:      { from: -35, to: 35,  spacing: 10, disp: 8, label: 'High slots' },
  med:       { from: 55,  to: 125, spacing: 10, disp: 8, label: 'Mid slots' },
  low:       { from: 145, to: 215, spacing: 10, disp: 8, label: 'Low slots' },
  subsystem: { from: 235, to: 265, spacing: 10, disp: 4, label: 'Subsystems' },
  rig:       { from: 285, to: 305, spacing: 10, disp: 3, label: 'Rig slots' },
};

// Chart series palette — validated (dataviz six checks) against the app's dark
// surface (#14161c): all ≥3:1 contrast, worst adjacent CVD ΔE 15.7.
const FIT_CHART_COLORS = ['#3987e5', '#199e70', '#c98500', '#9085e9'];
const FIT_CHART_TOTAL  = '#dfe5f0';
const FIT_CHART_HEAT   = '#e66767';

// Scripts are ordinary charges (Tracking Script group 907 / Missile Guidance
// Script group 1400) — load them from the Charges tab or drag them onto a TC/MGC,
// exactly like the game. The engine detects them via _fitScriptMode.

// ─── Skill profile ────────────────────────────────────────────────────────────
// Skill IDs verified against the SDE by name. Each entry: [skillId, %-per-level]
// applied as a plain multiplier (skills are never stacking-penalized). Racial
// weapon damage (+5%/lvl) keys off each weapon/charge's own requiredSkill1.
const FIT_SK = {
  gunnery: 3300, rapidFiring: 3310, sharpshooter: 3311, motion: 3312, surgical: 3315, trajectory: 3317,
  mlo: 3319, bombardment: 12441, projection: 12442, warhead: 20315, rapidLaunch: 21071,
  drones: 3436, avionics: 3437, interfacing: 3442, advAvionics: 23566,
  shieldMgmt: 3419, hullUp: 3394, mechanics: 3392,
  capMgmt: 3418, capSys: 3417,
  nav: 3449, accel: 3452, evasive: 3453,
  lrt: 3428, sigAn: 3431,
  cpuMgmt: 3426, pgMgmt: 3413, wu: 3318, awu: 11207,
};
const FIT_SK_IDS = Object.values(FIT_SK);

// Current level of a skill under the active profile.
function _fitSkill(id) {
  const s = _fitState.skills;
  if (s.mode === 'all5') return 5;
  if (s.mode === 'char') return s.levels[id] || 0;
  return 0;
}
// 1 + pct%·level convenience (positive = bonus, negative = reduction).
function _fitSkMult(key, pct) { return 1 + (pct / 100) * _fitSkill(FIT_SK[key]); }
function _fitSkillLabel() {
  const s = _fitState.skills;
  return s.mode === 'all5' ? 'all skills V' : s.mode === 'char' ? (s.charName || 'character') : 'no skills';
}

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
  drones: [],                                  // bay stacks: { id, name, f, qty, active }
  droneBayOpen: false,                         // bay panel visible on the wheel
  // Skill profile: 'none' (all 0) | 'all5' | 'char' (a synced character's skills)
  skills: {
    mode: localStorage.getItem('fitSkillMode') || 'all5',
    charId: localStorage.getItem('fitSkillChar') || null,
    charName: null, levels: {}, fetched: new Set(),
  },
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
  const statsW = Math.max(240, Math.min(640, Number(localStorage.getItem('fitStatsW')) || 310));
  mount.innerHTML = `
    <div class="fit-wrap" id="fitWrap" style="grid-template-columns:${browserW}px 6px 1fr 6px ${statsW}px;">
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
        <div class="fit-skillbar">
          <span class="fit-skillbar-label"><span class="material-symbols-outlined">school</span> SKILLS</span>
          <select id="fitSkillSel" class="field-input" style="width:220px;">
            <option value="all5">All skills V</option>
            <option value="none">No skills (all 0)</option>
          </select>
          <span id="fitSkillNote" class="fit-skillbar-note"></span>
        </div>
        <div id="fitWheelWrap" class="fit-wheel-wrap"><div id="fitWheel" class="fit-wheel"></div></div>
        <div id="fitImportPanel" class="fit-import-panel" style="display:none;"></div>
      </div>

      <!-- Drag handle: resize the stats column (double-click resets) -->
      <div id="fitStatsHandle" class="fit-col-handle" title="Drag to resize — double-click to reset"></div>

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

  // Column resize handles — browser (left) and stats (right). Widths persist;
  // double-click resets. The DPS chart re-renders live while the stats column drags.
  const wrap = mount.querySelector('#fitWrap');
  const applyCols = () => {
    const b = Math.max(200, Math.min(560, Number(localStorage.getItem('fitBrowserW')) || 280));
    const s = Math.max(240, Math.min(640, Number(localStorage.getItem('fitStatsW'))   || 310));
    wrap.style.gridTemplateColumns = `${b}px 6px 1fr 6px ${s}px`;
  };
  const bindHandle = (sel, key, def, min, max, grow, onLive) => {
    const handle = mount.querySelector(sel);
    if (!handle) return;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = Math.max(min, Math.min(max, Number(localStorage.getItem(key)) || def));
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      let raf = null;
      const onMove = (ev) => {
        const w = Math.max(min, Math.min(max, startW + grow * (ev.clientX - startX)));
        localStorage.setItem(key, String(Math.round(w)));
        applyCols();
        if (onLive && !raf) raf = requestAnimationFrame(() => { raf = null; onLive(); });
      };
      const onUp = () => {
        document.body.style.cursor = ''; document.body.style.userSelect = '';
        if (onLive) onLive();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    handle.addEventListener('dblclick', () => {
      localStorage.setItem(key, String(def));
      applyCols();
      if (onLive) onLive();
    });
  };
  const redrawChart = () => { if (_fitSimCache && _fitSimCache.length) _fitDrawRangeChart(_fitSimCache); };
  bindHandle('#fitColHandle',   'fitBrowserW', 280, 200, 560, +1, null);
  bindHandle('#fitStatsHandle', 'fitStatsW',   310, 240, 640, -1, redrawChart);   // handle sits left of the panel

  // Action buttons
  mount.querySelector('#fitClear').addEventListener('click', () => {
    _fitState.modules = _fitEmptyRacks(_fitState.hull);
    _fitState.drones = [];
    _fitState.selected = null; _fitRenderAll();
  });
  mount.querySelector('#fitCopyEft').addEventListener('click', _fitCopyEFT);
  mount.querySelector('#fitImportEft').addEventListener('click', _fitShowEftPaste);
  mount.querySelector('#fitImportGame').addEventListener('click', _fitImportFromGame);
  mount.querySelector('#fitSaveGame').addEventListener('click', _fitSaveToGame);

  _fitPopulateChars();
  _fitInitSkillBar();
  _fitRenderFilters();
  _fitRenderBrowser();
  _fitRenderAll();
  // After a reload, rebuild the last in-progress fit (hull, modules, states,
  // charges) from its localStorage snapshot.
  if (!_fitState.hull) _fitRestore().catch(() => {});
}

// ─── Skill bar (below the header) ─────────────────────────────────────────────
async function _fitInitSkillBar() {
  const sel = document.getElementById('fitSkillSel');
  if (!sel) return;
  const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
  for (const a of accounts) {
    const opt = document.createElement('option');
    opt.value = `char:${a.characterId}`;
    opt.textContent = `${a.characterName}'s skills`;
    sel.appendChild(opt);
  }
  const s = _fitState.skills;
  sel.value = s.mode === 'char' && s.charId ? `char:${s.charId}` : s.mode;
  if (sel.selectedIndex === -1) { sel.value = 'all5'; s.mode = 'all5'; }
  if (s.mode === 'char' && s.charId) {
    const acc = accounts.find(a => String(a.characterId) === String(s.charId));
    s.charName = acc ? acc.characterName : null;
    _fitLoadSkillProfile();   // async — re-renders when levels land
  }
  _fitSkillNote();

  sel.addEventListener('change', () => {
    const v = sel.value;
    if (v.startsWith('char:')) {
      s.mode = 'char';
      s.charId = v.slice(5);
      const acc = accounts.find(a => String(a.characterId) === String(s.charId));
      s.charName = acc ? acc.characterName : null;
      s.levels = {}; s.fetched = new Set();
      _fitLoadSkillProfile();
    } else {
      s.mode = v; s.charId = null; s.charName = null;
    }
    try {
      localStorage.setItem('fitSkillMode', s.mode);
      if (s.charId) localStorage.setItem('fitSkillChar', s.charId); else localStorage.removeItem('fitSkillChar');
    } catch (_) {}
    _fitSkillNote();
    _fitRenderAll();
  });
}

function _fitSkillNote(text) {
  const note = document.getElementById('fitSkillNote');
  if (note) note.textContent = text != null ? text
    : (_fitState.skills.mode === 'none' ? 'baseline hull & module values'
      : _fitState.skills.mode === 'all5' ? 'every relevant skill at V'
      : 'using this character’s trained skills');
}

// Fetch the character's levels for the fixed simulation skills PLUS every
// requiredSkill1 present in the current fit (racial weapon-damage skills).
async function _fitLoadSkillProfile() {
  const s = _fitState.skills;
  if (s.mode !== 'char' || !s.charId) return;
  const ids = new Set(FIT_SK_IDS);
  for (const m of _fitAllMods()) {
    if (m.f?.attrs?.[182]) ids.add(m.f.attrs[182]);
    if (m.charge?.f?.attrs?.[182]) ids.add(m.charge.f.attrs[182]);
  }
  for (const d of _fitState.drones) if (d.f?.attrs?.[182]) ids.add(d.f.attrs[182]);
  const want = [...ids].filter(id => !s.fetched.has(id));
  if (!want.length) return;
  want.forEach(id => s.fetched.add(id));
  _fitSkillNote('loading skills…');
  try {
    const lv = await window.eveAPI.getSkillLevels(s.charId, want) || {};
    Object.assign(s.levels, lv);
    _fitSkillNote();
    _fitRenderAll();
  } catch (e) { _fitSkillNote('skills unavailable — ' + e.message); }
}

function _fitRenderAll() {
  _fitSyncRacks();                 // subsystem-driven slot layout stays consistent
  _fitRenderCanvas(); _fitRenderStats();
  // The FITS filter depends on the fit itself (free slots / hardpoints / remaining
  // CPU+PG) — keep the browser in sync while it's active.
  if (_fitState.filters.fits && _fitState.searchKind === 'module') _fitRenderBrowser();
  // New weapons/charges may need their racial skill levels (guarded by the
  // fetched-set, so this is a no-op unless something new appeared).
  if (_fitState.skills.mode === 'char') _fitLoadSkillProfile();
  _fitPersist();
}

// ─── Loadout persistence (survives Ctrl+R) ────────────────────────────────────
// The in-progress fit — hull, module positions, states, charges — is snapshotted
// to localStorage on every change and rebuilt from the SDE on next open.
function _fitPersist() {
  try {
    if (!_fitState.hull) { localStorage.removeItem('fitSaved'); return; }
    const racks = {};
    for (const key of Object.keys(_fitState.modules)) {
      racks[key] = _fitState.modules[key].map(m => m
        ? { id: m.id, state: m.state, c: m.charge ? { id: m.charge.id, name: m.charge.name } : null }
        : null);
    }
    const drones = _fitState.drones.map(d => ({ id: d.id, qty: d.qty, active: d.active }));
    localStorage.setItem('fitSaved', JSON.stringify({ hullId: _fitState.hull.id, fitName: _fitState.fitName, racks, drones }));
  } catch (_) {}
}

async function _fitRestore() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem('fitSaved') || 'null'); } catch (_) {}
  if (!data?.hullId) return false;
  const hull = await window.eveAPI.fitGetHull(data.hullId).catch(() => null);
  if (!hull) return false;
  const ids = new Set();
  for (const rack of Object.values(data.racks || {})) {
    for (const e of rack || []) { if (e) { ids.add(e.id); if (e.c) ids.add(e.c.id); } }
  }
  for (const d of (data.drones || [])) ids.add(d.id);
  const facts = ids.size ? await window.eveAPI.fitGetItems([...ids]).catch(() => ({})) : {};
  _fitState.hull = hull;
  _fitState.fitName = data.fitName || 'EVE Carbon Fit';
  _fitState.modules = _fitEmptyRacks(hull);
  _fitState.drones = (data.drones || [])
    .filter(d => facts[d.id])
    .map(d => ({ id: d.id, name: facts[d.id].name, f: facts[d.id], qty: d.qty || 1, active: d.active || 0 }));
  for (const [key, rack] of Object.entries(data.racks || {})) {
    // Stored racks may be larger than the bare hull (T3: subsystems grant the
    // slots) — size to the snapshot; _fitSyncRacks reconciles after placement.
    if (_fitState.modules[key]) {
      while (_fitState.modules[key].length < (rack || []).length) _fitState.modules[key].push(null);
    }
    (rack || []).forEach((e, i) => {
      if (!e || !facts[e.id] || !_fitState.modules[key] || i >= _fitState.modules[key].length) return;
      const mod = _fitMod(facts[e.id]);
      const okStates = ['offline', 'online'].concat(mod.activatable ? ['active'] : [], mod.overloadable ? ['overheated'] : []);
      if (okStates.includes(e.state)) mod.state = e.state;
      if (e.c && facts[e.c.id]) mod.charge = { id: e.c.id, name: e.c.name, dmg: facts[e.c.id].dmg, f: facts[e.c.id] };
      _fitState.modules[key][i] = mod;
    });
  }
  _fitRenderAll();
  return true;
}

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

  // With filters active, a group's count is its FILTERED descendant count — and
  // groups with nothing matching disappear entirely (e.g. Fleet Assistance
  // Modules contains no rigs, so the RIG filter hides the whole group).
  const filtering = kind === 'module' &&
    (_fitState.filters.slots.size > 0 || _fitState.filters.fits || _fitState.filters.skills);
  const visCount = (node) => filtering
    ? node.types.filter(_fitPassesFilters).length + node.kids.reduce((s, k) => s + visCount(k), 0)
    : (node.count ?? node.types.length);

  const grpHtml = (node, path) => {
    const cnt = visCount(node);
    if (!cnt) return '';
    const key = path + '/' + node.name;
    const idx = _fitTreeNodes.push({ node, key }) - 1;
    return `
      <details class="ft-grp" data-tn="${idx}" data-key="${_fitEsc(key)}" ${open.has(key) ? 'open' : ''}>
        <summary>${_fitEsc(node.name)}<span class="ft-count">${cnt}</span></summary>
        <div class="ft-body">${node.kids.map(k => grpHtml(k, key)).join('')}<div class="ft-types"></div></div>
      </details>`;
  };
  box.innerHTML = tree.sections.map(s => grpHtml(s, kind)).join('')
    || `<div class="fit-hint">Nothing matches the active filters.</div>`;

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
    const effS = _fitEffSlots();
    if (!t.slot || !(effS[t.slot] > 0)) return false;
    if (_fitFilled(t.slot).length >= effS[t.slot]) return false;
    const u = _fitComputeUsage(), eff = _fitEffOutputs();
    if ((t.cpu || 0) > eff.cpu - u.cpu + 1e-6) return false;
    if ((t.pg  || 0) > eff.pg  - u.pg  + 1e-6) return false;
    if (t.hp === 'turret'   && u.turret   >= effS.turret)   return false;
    if (t.hp === 'launcher' && u.launcher >= effS.launcher) return false;
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

// ─── T3 subsystems ────────────────────────────────────────────────────────────
// Effective slot layout = hull base + fitted subsystems' slot modifiers
// (hi/med/low 1374-6, hardpoints 1368-9). A bare Tengu is 0/0/0 — the subsystems
// bring the slots.
function _fitEffSlots() {
  const hull = _fitState.hull;
  if (!hull) return { high: 0, med: 0, low: 0, rig: 0, subsystem: 0, turret: 0, launcher: 0 };
  const s = {
    high: hull.slots.high, med: hull.slots.med, low: hull.slots.low,
    rig: hull.slots.rig, subsystem: hull.slots.subsystem,
    turret: hull.hardpoints.turret, launcher: hull.hardpoints.launcher,
  };
  for (const m of (_fitState.modules.subsystem || [])) {
    if (!m) continue;
    const a = m.f?.attrs || {};
    s.high += a[1374] || 0; s.med += a[1375] || 0; s.low += a[1376] || 0;
    s.turret += a[1368] || 0; s.launcher += a[1369] || 0;
  }
  return s;
}

// Effective drone bay/bandwidth (subsystems contribute via plain hull attrs).
function _fitEffDrone() {
  const hull = _fitState.hull;
  if (!hull) return { bay: 0, bandwidth: 0 };
  let bay = hull.drone?.bay || 0, bandwidth = hull.drone?.bandwidth || 0;
  for (const m of (_fitState.modules.subsystem || [])) {
    if (!m) continue;
    bay += m.f?.attrs?.[283] || 0;
    bandwidth += m.f?.attrs?.[1271] || 0;
  }
  return { bay, bandwidth };
}

// Resize every rack to the current effective layout (runs on every render, so
// swapping a subsystem immediately grows/shrinks the racks; anything left without
// a slot is unfitted with a notice).
function _fitSyncRacks() {
  const hull = _fitState.hull;
  if (!hull) return;
  const eff = _fitEffSlots();
  const dropped = [];
  for (const key of ['high', 'med', 'low', 'rig', 'subsystem']) {
    const want = key === 'subsystem' ? (hull.slots.subsystem || 0) : (eff[key] || 0);
    const rack = _fitState.modules[key] || (_fitState.modules[key] = []);
    while (rack.length < want) rack.push(null);
    if (rack.length > want) rack.splice(want).forEach(m => { if (m) dropped.push(m.name); });
  }
  if (dropped.length) _fitFlash(`Unfitted (slot removed): ${dropped.join(', ')}`);
}

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
  _fitState.drones = [];
  _fitState.selected = null;
  _fitRenderAll();
}

// ─── Drone & fighter bays ─────────────────────────────────────────────────────
// One store (_fitState.drones) holds both: drones (category 18, live in the drone
// bay, limited by bandwidth + 5 in space) and fighters (category 87, live in the
// fighter bay, launched as SQUADRONS limited by launch tubes).
function _fitIsFighter(d)     { return (d.f?.categoryId ?? d.categoryId) === 87; }
function _fitDroneUsedM3()    { return _fitState.drones.filter(d => !_fitIsFighter(d)).reduce((s, d) => s + d.qty * (d.f?.volume || 0), 0); }
function _fitFighterUsedM3()  { return _fitState.drones.filter(_fitIsFighter).reduce((s, d) => s + d.qty * (d.f?.volume || 0), 0); }
function _fitDroneActiveBw()  { return _fitState.drones.filter(d => !_fitIsFighter(d)).reduce((s, d) => s + d.active * (d.f?.attrs?.[1272] || 0), 0); }
function _fitDroneActiveN()   { return _fitState.drones.filter(d => !_fitIsFighter(d)).reduce((s, d) => s + d.active, 0); }
function _fitFighterActiveSq(){ return _fitState.drones.filter(_fitIsFighter).reduce((s, d) => s + d.active, 0); }
function _fitFighterSqSize(d) { return d.f?.attrs?.[2215] || 1; }
// Control range: 20 km base + Drone Avionics (+5 km/lvl) + Advanced Drone
// Avionics (+3 km/lvl) + Drone Link Augmentors (attr 459, flat metres, online).
function _fitDroneCtrlRange() {
  let r = 20000 + 5000 * _fitSkill(FIT_SK.avionics) + 3000 * _fitSkill(FIT_SK.advAvionics);
  for (const m of _fitAllMods()) if (m.state !== 'offline' && m.f?.attrs?.[459]) r += m.f.attrs[459];
  return r;
}
// Max drones in space = Drones skill level (0 with no skills, 5 at V).
function _fitDroneCap() { return _fitSkill(FIT_SK.drones); }

function _fitAddDrone(facts, qty = 1) {
  if (!_fitState.hull) { _fitFlash('Pick a hull first.'); return; }
  const fighter = facts.categoryId === 87;
  const bay = fighter ? (_fitState.hull.fighter?.bay || 0) : _fitEffDrone().bay;
  if (!bay) { _fitFlash(`${_fitState.hull.name} has no ${fighter ? 'fighter' : 'drone'} bay.`); return; }
  const used = fighter ? _fitFighterUsedM3() : _fitDroneUsedM3();
  const vol  = facts.volume || 0;
  const fits = Math.max(0, Math.min(qty, Math.floor((bay - used) / (vol || 1))));
  if (!fits) { _fitFlash(`${fighter ? 'Fighter' : 'Drone'} bay full (${_fitNum(used)} / ${_fitNum(bay)} m³).`); return; }
  const stack = _fitState.drones.find(d => d.id === facts.id);
  if (stack) stack.qty += fits;
  else _fitState.drones.push({ id: facts.id, name: facts.name, f: facts, qty: fits, active: 0 });
  _fitState.droneBayOpen = true;
  _fitRenderAll();
  if (fits < qty) _fitFlash(`Only ${fits} fit in the bay.`);
}

// Change a stack's ACTIVE count (±1). Drones: bandwidth + max 5 in space (assumes
// Drones V). Fighters: active = SQUADRONS — capped by launch tubes and by how many
// full squadrons the units in the bay can form.
function _fitDroneSetActive(id, delta) {
  const d = _fitState.drones.find(x => x.id === id);
  if (!d || !_fitState.hull) return;
  if (delta > 0) {
    if (_fitIsFighter(d)) {
      const tubes = _fitState.hull.fighter?.tubes || 0;
      const maxSq = Math.floor(d.qty / _fitFighterSqSize(d));
      if (_fitFighterActiveSq() >= tubes) { _fitFlash(`All ${tubes} launch tubes in use.`); return; }
      if (d.active >= maxSq) { _fitFlash(`Not enough ${d.name}s for another full squadron (${_fitFighterSqSize(d)}/sq).`); return; }
      d.active++;
    } else {
      const bw = _fitEffDrone().bandwidth;
      const unit = d.f?.attrs?.[1272] || 0;
      if (d.active >= d.qty) return;
      const cap = _fitDroneCap();
      if (_fitDroneActiveN() >= cap) { _fitFlash(cap ? `Max ${cap} drones in space (Drones ${cap === 5 ? 'V' : cap}).` : 'The Drones skill is 0 under this profile — no drones can launch.'); return; }
      if (_fitDroneActiveBw() + unit > bw) { _fitFlash(`Not enough drone bandwidth (${_fitNum(bw)} Mbit/s).`); return; }
      d.active++;
    }
  } else {
    d.active = Math.max(0, d.active - 1);
  }
  _fitRenderAll();
}

// Active drones/fighters as sim entries. Drones: flat applied DPS out to control
// range. Fighters: squadron attack DPS (dmg × mult × squadron size / cycle) — they
// operate across the grid, so no range bound on the chart.
function _fitDroneSim() {
  const out = [];
  if (!_fitState.hull) return out;
  const ctrl = _fitDroneCtrlRange();
  // Drone Damage Amplifiers (attr 1255, %, online lows) — stacking penalized —
  // plus Drone Interfacing (+10%/lvl, never penalized).
  const dda = [];
  for (const m of _fitAllMods()) if (m.state !== 'offline' && m.f?.attrs?.[1255]) dda.push(m.f.attrs[1255] / 100);
  const dmgMult = _fitStackChain(dda) * _fitSkMult('interfacing', 10);
  for (const d of _fitState.drones) {
    if (!d.active) continue;
    const a = d.f?.attrs || {};
    if (_fitIsFighter(d)) {
      const sq = _fitFighterSqSize(d);
      const perVolley = ((a[2227] || 0) + (a[2228] || 0) + (a[2229] || 0) + (a[2230] || 0)) * (a[2226] || 1) * sq;
      const cyc = a[2233] || 0;
      const dps = perVolley > 0 && cyc > 0 ? (perVolley / (cyc / 1000)) * d.active : 0;
      if (!dps) continue;
      out.push({
        kind: 'fighter', flavor: 'fighter', hot: false,
        name: d.name, chargeName: null, count: d.active,
        dps, volley: perVolley * d.active,
        optimal: a[2236] || 0, falloff: a[2237] || 0, tracking: null,
        vel: a[37] || 0, range: Infinity,
      });
    } else {
      const perShot = ((a[114] || 0) + (a[118] || 0) + (a[117] || 0) + (a[116] || 0)) * (a[64] || 1) * dmgMult;
      const rof = a[51] || 0;
      const dps = perShot > 0 && rof > 0 ? (perShot / (rof / 1000)) * d.active : 0;
      if (!dps) continue;
      out.push({
        kind: 'drone', flavor: 'drone', hot: false,
        name: d.name, chargeName: null, count: d.active,
        dps, volley: perShot * d.active,
        optimal: a[54] || 0, falloff: a[158] || 0, tracking: a[160] || 0,
        vel: a[37] || 0, range: ctrl,
      });
    }
  }
  return out;
}

// Full fit-legality check (mirrors the game): the hull must have that slot type
// with one free, and turrets/launchers need a free HARDPOINT — a Nyx has 6 highs
// but 0 turret hardpoints, so guns must be rejected. `ignoreMod` excludes the
// module being replaced from the counts (drag-replace).
function _fitCanFit(facts, ignoreMod = null) {
  const hull = _fitState.hull;
  if (!hull) return 'Pick a hull first.';
  if (!facts.slot) return `${facts.name} doesn’t fit a slot.`;
  // T3 subsystems: must be built for THIS hull (attr 1380), one per subsystem
  // slot (attr 1366 — same-slot fitting swaps, handled in placement).
  if (facts.slot === 'subsystem') {
    if (!(hull.slots.subsystem > 0)) return `${hull.name} has no subsystem slots.`;
    const forHull = facts.attrs?.[1380];
    if (forHull && forHull !== hull.id) return `${facts.name} only fits its own T3 hull.`;
    return null;
  }
  const eff = _fitEffSlots();
  if (!(eff[facts.slot] > 0)) return `${hull.name} has no ${facts.slot} slots${hull.slots.subsystem ? ' (fit subsystems to unlock them)' : ''}.`;
  const filled = _fitFilled(facts.slot).filter(m => m !== ignoreMod).length;
  if (filled >= eff[facts.slot]) return `No free ${facts.slot} slots.`;
  if (facts.hardpoint) {
    let used = 0;
    for (const m of _fitState.modules.high) if (m && m !== ignoreMod && m.hardpoint === facts.hardpoint) used++;
    const max = eff[facts.hardpoint] || 0;
    if (used >= max) {
      return max === 0
        ? `${hull.name} has no ${facts.hardpoint} hardpoints — ${facts.name} can’t be fitted.`
        : `No free ${facts.hardpoint} hardpoints (${used}/${max}).`;
    }
  }
  return null;
}

// Subsystems have a CANONICAL position: attr 1366 (125=Core, 126=Defensive, …)
// maps to rack index. Fitting one of the same category swaps it in place — never
// duplicates.
function _fitPlaceSubsystem(facts) {
  const rack = _fitState.modules.subsystem;
  const idx = Math.max(0, Math.min(rack.length - 1, (facts.attrs?.[1366] || 125) - 125));
  const prev = rack[idx];
  rack[idx] = _fitMod(facts);
  _fitRenderAll();
  if (prev) _fitFlash(`Swapped ${prev.name} → ${facts.name}.`);
}

function _fitAddModule(facts, atIdx = null) {
  const err = _fitCanFit(facts);
  if (err) { _fitFlash(err); return; }
  if (facts.slot === 'subsystem') { _fitPlaceSubsystem(facts); return; }
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
// Shift-dropping a charge loads it into EVERY compatible fitted module.
async function _fitHandleDrop(payload, tgtSlot, tgtIdx, shiftAll = false) {
  if (!payload || !_fitState.hull) return;

  if (payload.startsWith('move:')) {
    const [, srcSlot, srcIdxS] = payload.split(':');
    const srcIdx = Number(srcIdxS);
    if (srcSlot === tgtSlot && srcIdx === tgtIdx) return;
    if (srcSlot === 'subsystem') { _fitFlash('Subsystems occupy fixed slots (Core / Defensive / Offensive / Propulsion).'); return; }
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
    // Drones and fighters go to their bay wherever they're dropped.
    if (facts.categoryId === 18 || facts.categoryId === 87) { _fitAddDrone(facts); return; }
    // A charge dropped onto a fitted module loads it (scripts included).
    // Shift held → load into every compatible module at once.
    if (facts.categoryId === 8) {
      if (shiftAll) { _fitLoadChargeAll(facts.id, facts.name); return; }
      const mod = _fitState.modules[tgtSlot]?.[tgtIdx];
      if (!mod) { _fitFlash('Drop charges onto a fitted module.'); return; }
      mod.charge = { id: facts.id, name: facts.name, dmg: facts.dmg, f: facts };
      _fitRenderAll();
      return;
    }
    if (!facts.slot) { _fitFlash('That item doesn’t fit a slot.'); return; }
    if (facts.slot !== tgtSlot) { _fitFlash(`${facts.name} is a ${facts.slot}-slot module.`); return; }
    // Subsystems ignore the drop position — they snap to their canonical slot.
    if (facts.slot === 'subsystem') {
      const err = _fitCanFit(facts);
      if (err) { _fitFlash(err); return; }
      _fitPlaceSubsystem(facts);
      return;
    }
    const replacing = _fitState.modules[tgtSlot][tgtIdx];
    const err = _fitCanFit(facts, replacing);              // hardpoints checked even on replace
    if (err) { _fitFlash(err); return; }
    _fitState.modules[tgtSlot][tgtIdx] = _fitMod(facts);   // place exactly here (replaces)
    _fitState.selected = null;
    _fitRenderAll();
  }
}

// Can this fitted module take this charge? (charge group + size compatibility)
function _fitChargeAccepts(m, cf) {
  if (!m || !cf) return false;
  if (!(m.f?.chargeGroups || []).includes(cf.groupId)) return false;
  const ms = m.f?.chargeSize, cs = cf.chargeSize;
  return ms == null || cs == null || ms === cs;
}

// Load a charge into EVERY fitted module that accepts it (shift-drop / shift-click
// / "load into all" — no more feeding each gun individually).
async function _fitLoadChargeAll(typeId, name) {
  const facts = (await window.eveAPI.fitGetItems([typeId]).catch(() => ({})))[typeId];
  if (!facts || facts.categoryId !== 8) return;
  let n = 0;
  for (const slot of Object.keys(_fitState.modules)) {
    for (const m of _fitState.modules[slot]) {
      if (m && _fitChargeAccepts(m, facts)) { m.charge = { id: typeId, name, dmg: facts.dmg, f: facts }; n++; }
    }
  }
  _fitRenderAll();
  _fitFlash(n ? `Loaded ${name} into ${n} module${n === 1 ? '' : 's'}.` : `Nothing fitted accepts ${name}.`);
}

async function _fitLoadCharge(typeId, name, target = null) {
  const sel = target || _fitState.selected;   // capture BEFORE any await
  const facts = (await window.eveAPI.fitGetItems([typeId]).catch(() => ({})))[typeId];
  if (facts && (facts.categoryId === 18 || facts.categoryId === 87)) { _fitAddDrone(facts); return; }   // drones/fighters → the bay
  if (!sel) { _fitFlash('Select a fitted module first, then click a charge.'); return; }
  const mod = _fitState.modules[sel.slot]?.[sel.idx];
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

// Total rig calibration in use (rigs are always on — calibration is spent on fit).
function _fitCalUsed() {
  return (_fitState.modules.rig || []).reduce((s, m) => s + (m?.f?.calCost || 0), 0);
}

// Effective hull CPU/PG output: subsystems ADD raw output (T3 hulls get most of
// theirs this way), then Co-Processors / RCU / PDS / rigs multiply, then skills.
function _fitEffOutputs() {
  const hull = _fitState.hull;
  const cpuB = [], pgB = [];
  let cpuAdd = 0, pgAdd = 0;
  for (const m of _fitAllMods()) {
    const f = m.f || {};
    if (m._slot === 'subsystem' && m.state !== 'offline') {
      cpuAdd += f.attrs?.[48] || 0;
      pgAdd  += f.attrs?.[11] || 0;
      continue;
    }
    if (!_fitContributes(m.ref, false)) continue;
    if (f.cpuMult)     cpuB.push(f.cpuMult - 1);
    if (f.pgMult)      pgB.push(f.pgMult - 1);
    if (f.cpuOutBonus) cpuB.push(f.cpuOutBonus / 100);
    if (f.pgOutBonus)  pgB.push(f.pgOutBonus / 100);
  }
  return {
    cpu: (hull.output.cpu + cpuAdd) * _fitStackChain(cpuB) * _fitSkMult('cpuMgmt', 5),
    pg:  (hull.output.pg  + pgAdd)  * _fitStackChain(pgB)  * _fitSkMult('pgMgmt', 5),
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

    // Rate of fire (ms): damage-mod chain + skills (Gunnery/Rapid Firing for
    // turrets, Missile Launcher Operation/Rapid Launch for launchers).
    let rof = (f.rof || 1) * _fitStackChain(db.rofM);
    rof *= kind === 'turret'
      ? _fitSkMult('gunnery', -2) * _fitSkMult('rapidFiring', -4)
      : _fitSkMult('mlo', -2) * _fitSkMult('rapidLaunch', -3);
    if (hot && kind === 'missile' && f.heat?.rofBonus) rof *= 1 + f.heat.rofBonus / 100;

    // Damage per shot: mods + heat + skills (Surgical Strike / Warhead Upgrades,
    // plus the weapon's/charge's own racial skill at +5%/lvl via requiredSkill1).
    const d = (kind === 'missile' ? cf.dmg : c?.dmg) || c?.dmg;
    let perShot = 0;
    if (d) {
      perShot = (d.em || 0) + (d.th || 0) + (d.kin || 0) + (d.exp || 0);
      if (kind === 'turret') perShot *= (f.dmgMult || 1);
      perShot *= _fitStackChain(db.dmg);
      if (kind === 'turret') {
        perShot *= _fitSkMult('surgical', 3);
        perShot *= 1 + 0.05 * _fitSkill(f.attrs?.[182] || 0);
      } else {
        perShot *= _fitSkMult('warhead', 2);
        perShot *= 1 + 0.05 * _fitSkill(cf.attrs?.[182] || 0);
      }
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
        optimal:  (f.optimal  || 0) * ammoOpt  * _fitStackChain(rb.opt)   * _fitSkMult('sharpshooter', 5),
        falloff:  (f.falloff  || 0) * ammoFall * _fitStackChain(rb.fall)  * _fitSkMult('trajectory', 5),
        tracking: (f.tracking || 0) * _fitStackChain(rb.track)            * _fitSkMult('motion', 5),
      };
      entry.range = entry.optimal + entry.falloff;
    } else {
      const vel    = (cf.missileVel || 0) * _fitStackChain(rb.vel)          * _fitSkMult('projection', 10);
      const flight = ((cf.flightMs || 0) / 1000) * _fitStackChain(rb.flight) * _fitSkMult('bombardment', 10);
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
// the standard falloff curve at 0 transversal. Missiles flat to max range; drones
// flat to CONTROL range (they fly to the target and orbit within their own optimal).
function _fitAppliedAt(g, r) {
  if (g.kind === 'missile' || g.kind === 'drone' || g.kind === 'fighter') return r <= g.range ? 1 : 0;
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

// Evenly distribute n slots inside an arc, centred, spacing capped per arc so
// small counts stay tightly packed like the in-game band — but NEVER below the
// overlap floor: if a group outgrows its arc, it spills past the ends rather
// than stacking cells on top of each other.
function _fitArcAngles(arc, n) {
  if (n <= 0) return [];
  const span = arc.to - arc.from;
  const spacing = n === 1 ? 0
    : Math.max(FIT_WHEEL.minSpacing, Math.min(span / (n - 1), arc.spacing || 15));
  const start = (arc.from + arc.to) / 2 - (spacing * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => start + i * spacing);
}

// The dark ring band the slot cells sit on (in-game style): a thick annulus
// around the porthole with subtle edge strokes — no text labels, no grid.
function _fitRingSvg() {
  const C = FIT_WHEEL.size / 2;
  const bandMid = (FIT_WHEEL.portholeR + (FIT_WHEEL.size / 2 - 8)) / 2;
  const bandW   = (FIT_WHEEL.size / 2 - 8) - FIT_WHEEL.portholeR;
  return `<svg class="fw-ring" viewBox="0 0 ${FIT_WHEEL.size} ${FIT_WHEEL.size}">
    <circle cx="${C}" cy="${C}" r="${bandMid}" class="fw-band" style="stroke-width:${bandW}px;"/>
    <circle cx="${C}" cy="${C}" r="${FIT_WHEEL.portholeR + 1}" class="fw-band-edge-in"/>
    <circle cx="${C}" cy="${C}" r="${FIT_WHEEL.size / 2 - 8}" class="fw-band-edge-out"/>
  </svg>`;
}

// Drone/fighter bay panel (in-game style): stacks with active steppers and the
// per-unit numbers that decide an engagement — DPS, top speed, attack range.
// Fighters activate as SQUADRONS (tube-limited); drones as units (bandwidth).
function _fitDroneBayHtml(hull) {
  const rows = _fitState.drones.map(d => {
    const a = d.f?.attrs || {};
    let stats, activeTitle;
    if (_fitIsFighter(d)) {
      const sq = _fitFighterSqSize(d);
      const perVolley = ((a[2227] || 0) + (a[2228] || 0) + (a[2229] || 0) + (a[2230] || 0)) * (a[2226] || 1) * sq;
      const dps = a[2233] ? perVolley / (a[2233] / 1000) : 0;
      stats = `${_fitNum(dps)} dps/sq · ${_fitNum(a[37] || 0)} m/s · ${sq}/squadron`;
      activeTitle = 'Squadrons launched (uses a tube)';
    } else {
      const perShot = ((a[114] || 0) + (a[118] || 0) + (a[117] || 0) + (a[116] || 0)) * (a[64] || 1);
      const dps = a[51] ? perShot / (a[51] / 1000) : 0;
      stats = `${_fitNum(dps)} dps · ${_fitNum(a[37] || 0)} m/s · ${_fitKm(a[54] || 0)} + ${_fitKm(a[158] || 0)} · ${_fitNum(a[1272] || 0)} Mbit`;
      activeTitle = 'Active in space';
    }
    return `
      <div class="fw-db-row">
        <img src="https://images.evetech.net/types/${d.id}/icon?size=32" alt=""/>
        <div class="fw-db-main">
          <div class="fw-db-name">${_fitEsc(d.name)} <span class="fw-db-qty">×${d.qty}${_fitIsFighter(d) ? ' units' : ''}</span></div>
          <div class="fw-db-stats">${stats}</div>
        </div>
        <div class="fw-db-active" title="${activeTitle}">
          <button class="fw-db-btn" data-dact="${d.id}:-1">−</button>
          <span class="${d.active ? 'on' : ''}">${d.active}</span>
          <button class="fw-db-btn" data-dact="${d.id}:1">＋</button>
        </div>
        <button class="fw-db-x" data-drm="${d.id}" title="Remove stack">✕</button>
      </div>`;
  }).join('');

  const headBits = [];
  const effD = _fitEffDrone();
  if (effD.bay) headBits.push(`${_fitNum(_fitDroneUsedM3())} / ${_fitNum(effD.bay)} m³ · ${_fitNum(_fitDroneActiveBw())} / ${_fitNum(effD.bandwidth)} Mbit · ${_fitDroneActiveN()}/${_fitDroneCap()}`);
  if (hull.fighter?.bay) headBits.push(`fighters ${_fitNum(_fitFighterUsedM3())} / ${_fitNum(hull.fighter.bay)} m³ · ${_fitFighterActiveSq()}/${hull.fighter.tubes} tubes`);
  return `
    <div class="fw-dronebay" id="fwDroneBay">
      <div class="fw-db-head">${hull.fighter?.bay ? 'FIGHTER' : 'DRONE'} BAY<span>${headBits.join('  ·  ')}</span></div>
      ${rows || `<div class="fw-db-empty">Drag ${hull.fighter?.bay ? 'fighters' : 'drones'} here (Charges &amp; Drones tab), or click one in the browser.</div>`}
      <div class="fw-db-hint">${hull.fighter?.bay
        ? 'Launched squadrons add DPS across the grid. Squadron size is per fighter type.'
        : `Active drones add DPS &amp; a curve out to control range (${_fitKm(_fitDroneCtrlRange())}). Max in space: ${_fitDroneCap()} (Drones skill).`}</div>
    </div>`;
}

// Bay chips + panel live in the bottom-left corner of the CANVAS (not the wheel),
// so they stay anchored like the in-game window.
function _fitRenderBays(hull) {
  const wrap = document.getElementById('fitWheelWrap');
  if (!wrap) return;
  let bays = document.getElementById('fwBaysWrap');
  if (!hull) { if (bays) bays.innerHTML = ''; return; }
  if (!bays) {
    bays = document.createElement('div');
    bays.id = 'fwBaysWrap';
    wrap.appendChild(bays);
  }
  const effD = _fitEffDrone();
  const hasBay = effD.bay > 0 || (hull.fighter?.bay || 0) > 0;
  bays.innerHTML = `
    ${_fitState.droneBayOpen && hasBay ? _fitDroneBayHtml(hull) : ''}
    <div class="fw-bays">
      <div class="fw-bay" title="Cargo hold capacity">
        <span class="material-symbols-outlined">inventory_2</span>${_fitNum(hull.cargo || 0)} m³
      </div>
      ${effD.bay > 0 ? `
        <div class="fw-bay fw-bay-drone ${_fitState.droneBayOpen ? 'open' : ''}" data-baychip="1"
             title="Drone bay — click to open. Drag drones here.">
          <span class="material-symbols-outlined">smart_toy</span>${_fitNum(_fitDroneUsedM3())} / ${_fitNum(effD.bay)} m³
        </div>` : ''}
      ${(hull.fighter?.bay || 0) > 0 ? `
        <div class="fw-bay fw-bay-drone ${_fitState.droneBayOpen ? 'open' : ''}" data-baychip="1"
             title="Fighter bay (${hull.fighter.tubes} tubes) — click to open. Drag fighters here.">
          <span class="material-symbols-outlined">flight</span>${_fitNum(_fitFighterUsedM3())} / ${_fitNum(hull.fighter.bay)} m³
        </div>` : ''}
    </div>`;

  bays.querySelectorAll('[data-baychip]').forEach(chipEl => {
    chipEl.addEventListener('click', () => { _fitState.droneBayOpen = !_fitState.droneBayOpen; _fitRenderCanvas(); });
    chipEl.addEventListener('dragover', (e) => { e.preventDefault(); chipEl.classList.add('fw-drop'); });
    chipEl.addEventListener('dragleave', () => chipEl.classList.remove('fw-drop'));
    chipEl.addEventListener('drop', (e) => {
      e.preventDefault(); chipEl.classList.remove('fw-drop');
      _fitHandleDrop(e.dataTransfer.getData('text/plain'), null, null, e.shiftKey);
    });
  });
  const bayEl = bays.querySelector('#fwDroneBay');
  if (bayEl) {
    bayEl.querySelectorAll('[data-dact]').forEach(b => b.addEventListener('click', () => {
      const [id, delta] = b.dataset.dact.split(':');
      _fitDroneSetActive(Number(id), Number(delta));
    }));
    bayEl.querySelectorAll('[data-drm]').forEach(b => b.addEventListener('click', () => {
      _fitState.drones = _fitState.drones.filter(d => d.id !== Number(b.dataset.drm));
      _fitRenderAll();
    }));
    bayEl.addEventListener('dragover', (e) => e.preventDefault());
    bayEl.addEventListener('drop', (e) => {
      e.preventDefault();
      _fitHandleDrop(e.dataTransfer.getData('text/plain'), null, null, e.shiftKey);
    });
  }
}

function _fitRenderCanvas() {
  const head  = document.getElementById('fitHullName');
  const wheel = document.getElementById('fitWheel');
  if (!head || !wheel) return;
  const hull = _fitState.hull;
  head.textContent = hull ? `${hull.name} — ${_fitState.fitName}` : 'No hull — pick one from Hulls';

  if (!hull) {
    wheel.innerHTML = `<div class="fit-hint" style="padding-top:220px;">Select a hull from the Hulls tab to start fitting.</div>`;
    _fitRenderBays(null);
    return;
  }

  _fitSimCache = _fitWeaponSim().concat(_fitDroneSim());   // drones count everywhere
  const eff = _fitEffOutputs();
  const use = _fitComputeUsage();

  const effSlots = _fitEffSlots();               // hardpoint chips read turret/launcher totals
  let cells = '';
  for (const [key, arc] of Object.entries(FIT_WHEEL_ARCS)) {
    // High/mid/low ALWAYS render all 8 wedge positions (in-game style); the
    // subsystem/rig groups follow the hull. Positions past what the fit actually
    // has are LOCKED wedges — visible, but inert until a subsystem grants them.
    const disp = (key === 'subsystem' || key === 'rig') ? (hull.slots[key] || 0) : arc.disp;
    if (!disp) continue;
    const r = FIT_WHEEL.slotR;
    const angles = _fitArcAngles(arc, disp);
    const fitted = _fitState.modules[key] || [];
    const avail  = fitted.length;                   // racks are synced to eff slots
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
      // The CELL rotates to its ring angle (wedge slice, wide edge outward) but
      // the CONTENT counter-rotates so icons stay upright, like the game.
      const pos = `left:${x}px;top:${y}px;transform:translate(-50%,-50%) rotate(${deg.toFixed(1)}deg);`;
      const upright = `transform:rotate(${(-deg).toFixed(1)}deg);`;
      if (m) {
        const sel = _fitState.selected && _fitState.selected.slot === key && _fitState.selected.idx === i;
        cells += `
          <div class="fw-slot state-${m.state} ${sel ? 'sel' : ''} ${hotAdj.has(i) && m.state !== 'overheated' ? 'fw-heat-adjacent' : ''}"
               style="${pos}" data-slot="${key}" data-idx="${i}" data-name="${_fitEsc(m.name)}" draggable="true">
            <span class="fw-wedge"></span>
            <img class="fw-icon" style="${upright}" src="https://images.evetech.net/types/${m.id}/icon?size=64" alt="" draggable="false"/>
            ${m.charge ? `<img class="fw-charge" style="${upright}" src="https://images.evetech.net/types/${m.charge.id}/icon?size=32" alt="" title="${_fitEsc(m.charge.name)}"/>` : ''}
            <button class="fw-x" style="${upright}" data-remove="${key}:${i}" title="Remove">✕</button>
          </div>`;
      } else if (i < avail) {
        cells += `<div class="fw-slot empty" style="${pos}" data-slot="${key}" data-idx="${i}" title="Empty ${arc.label.toLowerCase().replace(' slots', '')} slot — drag a module here"><span class="fw-wedge"></span></div>`;
      } else {
        cells += `<div class="fw-slot locked" style="${pos}" title="${hull.slots.subsystem ? 'No slot — granted by subsystems' : 'This hull has no slot here'}"><span class="fw-wedge"></span></div>`;
      }
    });
  }

  const pct = (u, t) => t ? Math.min(100, (u / t) * 100) : 0;
  const calUsed  = _fitCalUsed();
  const calTotal = hull.output.calibration || 0;
  wheel.innerHTML = `
    <div class="fw-porthole2">
      <img id="fwShip" class="fw-ship" src="https://images.evetech.net/types/${hull.id}/render?size=512"
           alt="${_fitEsc(hull.name)}" draggable="false"
           onerror="this.onerror=null;this.src='https://images.evetech.net/types/${hull.id}/icon?size=64'"/>
    </div>
    ${_fitRingSvg()}
    <div class="fw-center-bars">
      <div class="fw-mini-bar" title="CPU"><span>CPU</span><div class="fw-mini-track"><div class="fw-mini-fill ${use.cpu > eff.cpu ? 'over' : ''}" style="width:${pct(use.cpu, eff.cpu)}%"></div></div></div>
      <div class="fw-mini-bar" title="Powergrid"><span>PWR</span><div class="fw-mini-track"><div class="fw-mini-fill ${use.pg > eff.pg ? 'over' : ''}" style="width:${pct(use.pg, eff.pg)}%"></div></div></div>
      ${(hull.slots.rig || 0) > 0 ? `<div class="fw-mini-bar" title="Calibration (rigs): ${_fitNum(calUsed)} / ${_fitNum(calTotal)}"><span>CAL</span><div class="fw-mini-track"><div class="fw-mini-fill ${calUsed > calTotal ? 'over' : ''}" style="width:${pct(calUsed, calTotal)}%"></div></div></div>` : ''}
    </div>
    ${effSlots.turret > 0 || use.turret > 0 ? `
      <div class="fw-hp fw-hp-left" title="Turret hardpoints used / total">
        <span class="material-symbols-outlined">gps_fixed</span>${use.turret}/${effSlots.turret}
      </div>` : ''}
    ${effSlots.launcher > 0 || use.launcher > 0 ? `
      <div class="fw-hp fw-hp-right" title="Launcher hardpoints used / total">
        <span class="material-symbols-outlined">rocket_launch</span>${use.launcher}/${effSlots.launcher}
      </div>` : ''}
    ${cells}
    <div id="fwTip" class="fw-tip" style="display:none;"></div>`;

  _fitRenderBays(hull);

  // ── Interactions ── (locked wedges are inert)
  wheel.querySelectorAll('.fw-slot:not(.locked)').forEach(el => {
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

    // Right-click → context menu (state / load ammo / filter / remove).
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _fitShowSlotMenu(slot, idx, e.clientX, e.clientY);
    });

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
      _fitHandleDrop(e.dataTransfer.getData('text/plain'), slot, idx, e.shiftKey);
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
      ship.style.transform = `perspective(800px) scale(1.08) rotateY(${nx * 8}deg) rotateX(${ny * -8}deg)`;
    });
    wheel.addEventListener('mouseleave', () => { ship.style.transform = 'perspective(800px) scale(1.08)'; });
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
    // Structured stat rows — weapons from the live sim; everything else from its
    // verified SDE attrs (tackle range + overheated range, scram strength, web
    // slow, neut drain, cycle time).
    const rows = [];
    const sim = (_fitSimCache || []).find(g => g.name === m.name && (g.chargeName || null) === (m.charge?.name || null));
    const a = m.f?.attrs || {};
    if (sim) {
      if (sim.kind === 'turret') {
        rows.push(['Optimal', _fitKm(sim.optimal)]);
        rows.push(['Falloff', '+' + _fitKm(sim.falloff)]);
        rows.push(['Tracking', sim.tracking.toFixed(3)]);
      } else {
        rows.push(['Range', '≈ ' + _fitKm(sim.range)]);
      }
      rows.push(['DPS / unit', _fitNum(sim.dps / sim.count)]);
    } else if (m.f?.hardpoint) {
      rows.push(['DPS', 'load a charge & set active', 'dim']);
    } else {
      if (a[54] > 0) {
        rows.push(['Range', _fitKm(a[54])]);
        if (a[1222]) rows.push(['Overheated', _fitKm(a[54] * (1 + a[1222] / 100)), 'hot']);
      }
      if (a[105]) rows.push(['Warp scramble', `−${a[105]} pt${a[105] > 1 ? 's' : ''}`]);
      if (a[20] < 0) rows.push(['Target velocity', `${a[20]}%`]);
      if (a[97]) rows.push(['Neutralized', `${_fitNum(a[97])} GJ`]);
      if (a[73] > 0 && m.activatable) rows.push(['Cycle', `${_fitNum(a[73] / 1000)} s`]);
    }
    tip.innerHTML = `
      <div class="fw-tip-name">${_fitEsc(m.name)}</div>
      ${m.charge ? `<div class="fw-tip-sub">↳ ${_fitEsc(m.charge.name)}</div>` : ''}
      <div class="fw-tip-sub">state: <b class="fw-tip-${m.state}">${m.state}</b> · ${_fitNum(m.cpu)} tf · ${_fitNum(m.pg)} MW</div>
      ${rows.length ? `<div class="fw-tip-grid">${rows.map(([k, v, cls]) =>
        `<span class="fw-tip-k">${k}</span><span class="fw-tip-v ${cls || ''}">${_fitEsc(String(v))}</span>`).join('')}</div>` : ''}
      ${m.state === 'overheated' ? `<div class="fw-tip-sub" style="color:#ff5b50;">⚠ heat bleeds into adjacent slots — buffer with empty/passive slots</div>` : ''}
      <div class="fw-tip-hint">click = select · double-click = cycle state · drag = move · right-click = ammo &amp; more</div>`;
  }
  tip.style.display = 'block';
  const wr = el.parentElement.getBoundingClientRect(), er = el.getBoundingClientRect();
  let tx = er.left - wr.left + 30, ty = er.top - wr.top + 30;
  if (tx > FIT_WHEEL.size - 240) tx -= 270;
  if (ty > FIT_WHEEL.size - 120) ty -= 130;
  tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
}

// ─── Slot context menu (right-click) ──────────────────────────────────────────
// Module: state controls, grouped "load ammo" (Tech I / Tech II / Storyline &
// Faction / Officer & Deadspace), unload, filter-browser-for-slot, remove.
// Empty slot: filter the browser for that slot type.
function _fitCloseSlotMenu() { document.getElementById('fitCtxMenu')?.remove(); }

function _fitShowSlotMenu(slot, idx, x, y) {
  _fitCloseSlotMenu();
  const m = _fitState.modules[slot]?.[idx];
  const menu = document.createElement('div');
  menu.id = 'fitCtxMenu';

  const filterRow = `<button class="fit-ctx-item" data-act="filter">Browse ${slot} modules</button>`;
  if (!m) {
    menu.innerHTML = `<div class="fit-ctx-head">Empty ${slot} slot</div>${filterRow}`;
  } else {
    const states = ['offline', 'online'];
    if (m.activatable)  states.push('active');
    if (m.overloadable) states.push('overheated');
    menu.innerHTML = `
      <div class="fit-ctx-head">${_fitEsc(m.name)}</div>
      <div class="fit-ctx-states">
        ${states.map(s => `<button class="fit-ctx-state st-${s} ${m.state === s ? 'on' : ''}" data-state="${s}" title="${s}">${
          s === 'offline' ? 'OFF' : s === 'online' ? 'ON' : s === 'active' ? 'ACT' : 'HEAT'}</button>`).join('')}
      </div>
      ${(m.f?.chargeGroups || []).length ? `<div class="fit-ctx-ammo" id="fitCtxAmmo"><div class="fit-hint" style="padding:6px;">Loading ammo…</div></div>` : ''}
      ${m.charge ? `<button class="fit-ctx-item" data-act="loadall">⇊ Load ${_fitEsc(m.charge.name)} into all compatible</button>` : ''}
      ${m.charge ? `<button class="fit-ctx-item" data-act="unload">Unload ${_fitEsc(m.charge.name)}</button>` : ''}
      ${filterRow}
      <button class="fit-ctx-item fit-ctx-danger" data-act="remove">✕ Remove module</button>`;
  }

  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  if (r.right  > window.innerWidth)  menu.style.left = Math.max(8, window.innerWidth  - r.width  - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top  = Math.max(8, window.innerHeight - r.height - 8) + 'px';

  menu.addEventListener('click', (e) => {
    const st = e.target.closest('[data-state]');
    if (st && m) { m.state = st.dataset.state; _fitCloseSlotMenu(); _fitRenderAll(); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    _fitCloseSlotMenu();
    if (act.dataset.act === 'remove') {
      _fitState.modules[slot][idx] = null; _fitState.selected = null; _fitRenderAll();
    } else if (act.dataset.act === 'unload') {
      if (m) { m.charge = null; _fitRenderAll(); }
    } else if (act.dataset.act === 'loadall') {
      if (m?.charge) _fitLoadChargeAll(m.charge.id, m.charge.name);
    } else if (act.dataset.act === 'filter') {
      _fitState.searchKind = 'module';
      _fitState.filters.slots = new Set([slot]);
      const search = document.getElementById('fitSearch');
      if (search) search.value = '';
      _fitRenderKindTabs(); _fitRenderFilters(); _fitRenderBrowser();
    }
  });
  setTimeout(() => document.addEventListener('click', _fitCloseSlotMenu, { once: true }), 0);

  // Async: fill the grouped ammo list for charge-taking modules.
  if (m && (m.f?.chargeGroups || []).length) {
    window.eveAPI.fitAmmoFor(m.id).then(list => {
      const box = menu.querySelector('#fitCtxAmmo');
      if (!box) return;
      if (!list.length) { box.innerHTML = ''; return; }
      const sections = [
        ['TECH I',              list.filter(a => a.meta === 1)],
        ['TECH II',             list.filter(a => a.meta === 2)],
        ['STORYLINE & FACTION', list.filter(a => a.meta === 3 || a.meta === 4)],
        ['OFFICER & DEADSPACE', list.filter(a => a.meta === 5 || a.meta === 6)],
        ['OTHER',               list.filter(a => ![1, 2, 3, 4, 5, 6].includes(a.meta))],
      ].filter(([, items]) => items.length);
      box.innerHTML = `<div class="fit-ctx-hint">click = this module · shift-click = all compatible</div>`
        + sections.map(([label, items]) => `
        <div class="fit-ctx-sec">${label}</div>
        ${items.map(a => `
          <button class="fit-ctx-item fit-ctx-charge" data-chargeid="${a.id}" data-chargename="${_fitEsc(a.name)}" ${m.charge?.id === a.id ? 'style="color:var(--accent);"' : ''}>
            <img src="https://images.evetech.net/types/${a.id}/icon?size=32" alt="" loading="lazy"/>${_fitEsc(a.name)}
          </button>`).join('')}`).join('');
      box.querySelectorAll('.fit-ctx-charge').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _fitCloseSlotMenu();
        if (e.shiftKey) _fitLoadChargeAll(Number(btn.dataset.chargeid), btn.dataset.chargename);
        else _fitLoadCharge(Number(btn.dataset.chargeid), btn.dataset.chargename, { slot, idx });
      }));
    }).catch(() => {});
  }
}

// ─── Stats panel ────────────────────────────────────────────────────────────────
function _fitRenderStats() {
  const el = document.getElementById('fitStats');
  if (!el) return;
  const hull = _fitState.hull;
  if (!hull) { el.innerHTML = `<div class="fit-hint">Stats appear once a hull is loaded.</div>`; return; }

  const u    = _fitComputeUsage();
  const eff  = _fitEffOutputs();
  const effT = _fitEffSlots();            // hardpoints incl. subsystem grants
  const off  = _fitComputeOffense();
  const D    = _fitShipDerived();         // live: modules + states + heat applied
  const sim  = _fitSimCache || _fitWeaponSim().concat(_fitDroneSim());

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
      <span>${g.kind === 'turret' ? `${_fitKm(g.optimal)} + ${_fitKm(g.falloff)}`
        : g.kind === 'fighter' ? 'on-grid' : `≈ ${_fitKm(g.range)}`}${(g.kind === 'drone' || g.kind === 'fighter') ? ` · ${_fitNum(g.vel)} m/s` : ''} · ${_fitNum(g.dps)} dps</span>
    </div>`).join('');

  // Drone/fighter bay summary card (bandwidth / tubes / control range / stacks).
  const droneBay   = _fitEffDrone().bay;
  const fighterBay = hull.fighter?.bay || 0;
  const droneRows = _fitState.drones.map(d => {
    const a = d.f?.attrs || {};
    const fighter = _fitIsFighter(d);
    const sim1 = sim.find(g => (g.kind === 'drone' || g.kind === 'fighter') && g.name === d.name);
    return `<div class="fit-mini">
      <span>${d.active}${fighter ? ' sq' : ''}/${d.qty}× ${_fitEsc(d.name)}</span>
      <span>${sim1 ? `${_fitNum(sim1.dps)} dps · ` : ''}${_fitNum(a[37] || 0)} m/s${fighter ? '' : ` · ${_fitKm(a[54] || 0)}+${_fitKm(a[158] || 0)}`}</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <!-- Fitting resources (rig/module-modified output) -->
    <div class="fit-stats-card">
      <div class="fit-stats-title">FITTING <span class="fit-note">incl. rigs &amp; mods</span></div>
      ${bar('CPU', u.cpu, eff.cpu, 'tf')}
      ${bar('Powergrid', u.pg, eff.pg, 'MW')}
      ${(hull.slots.rig || 0) > 0 ? bar('Calibration', _fitCalUsed(), hull.output.calibration || 0, '') : ''}
      <div class="fit-mini-grid">
        ${line('Turrets', `<span class="${u.turret > effT.turret ? 'fit-over' : ''}">${u.turret}/${effT.turret}</span>`)}
        ${line('Launchers', `<span class="${u.launcher > effT.launcher ? 'fit-over' : ''}">${u.launcher}/${effT.launcher}</span>`)}
      </div>
    </div>

    <!-- Weapon performance -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">radar</span> WEAPON RANGES <span class="fit-note">${_fitEsc(_fitSkillLabel())} · 0 transversal</span></div>
      ${sim.length ? `
        <canvas id="fitRangeChart" height="170"></canvas>
        <div id="fitChartLegend" class="fit-chart-legend"></div>
        <label class="fit-heat-toggle"><input type="checkbox" id="fitHeatPreview" ${_fitState.heatPreview ? 'checked' : ''}> Preview everything overheated</label>
        ${wrows}`
      : `<div class="fit-note-line">Fit weapons (and load charges) to simulate optimal, falloff and applied DPS vs range — including ammo, tracking mods, scripts, rigs and heat.</div>`}
    </div>

    <!-- Offense -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">crisis_alert</span> OFFENSE <span class="fit-note">${_fitEsc(_fitSkillLabel())}</span></div>
      <div class="fit-big">${_fitNum(off.dps)} <span class="fit-big-unit">dps</span></div>
      ${line('Volley', `${_fitNum(off.volley)} hp`)}
      ${off.dps === 0 ? `<div class="fit-note-line">Fit turrets/launchers, set them active, and load charges to see weapon DPS.</div>` : ''}
    </div>

    <!-- Drones / fighters -->
    ${droneBay > 0 || fighterBay > 0 ? `<div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">${fighterBay ? 'flight' : 'smart_toy'}</span> ${fighterBay ? 'FIGHTERS' : 'DRONES'} ${droneBay && fighterBay ? '&amp; DRONES' : ''} <span class="fit-note">${fighterBay ? 'squadrons' : _fitEsc(_fitSkillLabel())}</span></div>
      ${droneBay ? bar('Bandwidth', _fitDroneActiveBw(), _fitEffDrone().bandwidth, 'Mbit') : ''}
      <div class="fit-mini-grid">
        ${droneBay ? line('Drone bay', `${_fitNum(_fitDroneUsedM3())} / ${_fitNum(droneBay)} m³`) : ''}
        ${fighterBay ? line('Fighter bay', `${_fitNum(_fitFighterUsedM3())} / ${_fitNum(fighterBay)} m³`) : ''}
        ${fighterBay ? line('Launch tubes', `${_fitFighterActiveSq()} / ${hull.fighter.tubes}`) : ''}
        ${droneBay ? line('Control range', _fitKm(_fitDroneCtrlRange())) : ''}
        ${droneBay ? line('In space', `${_fitDroneActiveN()} / ${_fitDroneCap()}`) : ''}
      </div>
      ${droneRows || `<div class="fit-note-line">Add ${fighterBay ? 'fighters' : 'drones'} from the Charges &amp; Drones tab — set them active in the bay (bottom-left of the wheel) to count toward DPS and the range chart.</div>`}
    </div>` : ''}

    <!-- Capacitor -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">bolt</span> CAPACITOR <span class="fit-note">incl. modules</span></div>
      <div class="fit-cap">
        <svg viewBox="0 0 56 56" class="fit-cap-ring"><circle cx="28" cy="28" r="23" class="fit-cap-bg"/><circle cx="28" cy="28" r="23" class="fit-cap-fg"/></svg>
        <div class="fit-cap-info">
          <div class="fit-cap-gj">${_fitNum(D.capCap)} GJ</div>
          <div class="fit-cap-sub">${_fitNum(D.rechargeSec)} s recharge</div>
          <div class="fit-cap-sub">Peak +${_fitNum(D.peakRegen)} GJ/s</div>
        </div>
      </div>
      <div class="fit-note-line">Cap stability under load needs the active-module sim — coming.</div>
    </div>

    <!-- Defense -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">shield</span> DEFENSE <span class="fit-note">incl. modules &amp; heat</span></div>
      <div class="fit-big">${_fitNum(D.ehp)} <span class="fit-big-unit">ehp</span></div>
      <div class="fit-res-head"><span></span>${['EM', 'Th', 'Kin', 'Exp'].map(x => `<span>${x}</span>`).join('')}</div>
      ${_fitLayerRow('Shield', D.shieldHp, D.shieldRes)}
      ${_fitLayerRow('Armor', D.armorHp, D.armorRes)}
      ${_fitLayerRow('Structure', D.structHp, D.hullRes)}
    </div>

    <!-- Targeting -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">my_location</span> TARGETING <span class="fit-note">incl. modules</span></div>
      ${line('Lock range', `${_fitNum(D.lockRange / 1000)} km`)}
      ${line('Scan res', `${_fitNum(D.scanRes)} mm`)}
      ${line(`${hull.targeting.sensorType} str`, `${_fitNum(D.sensorStrength)} pts`)}
      ${line('Max targets', `${D.maxTargets}`)}
    </div>

    <!-- Navigation -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">navigation</span> NAVIGATION <span class="fit-note">incl. modules</span></div>
      ${line('Max velocity', `${_fitNum(D.maxVel)} m/s`)}
      ${line('Align time', `${_fitNum(D.align)} s`)}
      ${line('Warp speed', `${_fitNum(D.warp)} AU/s`)}
      ${line('Mass', `${_fitNum(D.mass / 1000)} t`)}
      ${line('Sig radius', `${_fitNum(D.sig)} m`)}
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
  // (Drones don't overheat — they carry over unchanged.)
  const heatSim = _fitState.heatPreview ? null : _fitWeaponSim(true).concat(_fitDroneSim());
  const totalAt = (set, r) => set.reduce((s, g) => s + g.dps * _fitAppliedAt(g, r), 0);
  // Fighters have unbounded range (on-grid) — they must not stretch the x-axis.
  const xmax = Math.max(...sim.map(g => g.kind === 'turret' ? g.optimal + 2.2 * g.falloff
    : (isFinite(g.range) ? g.range * 1.15 : (g.optimal + 2.2 * g.falloff) || 0)), 1000) * 1.05;
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
// Resist cell = a mini bar filling 0→100% (EVE style): 0% resist shows an empty
// track, not a solid coloured block.
function _fitResistCells(res) {
  return [['em', 'EM'], ['th', 'Th'], ['kin', 'Kin'], ['exp', 'Exp']].map(([k]) => {
    const pct = _fitResistPct(res[k]);
    if (pct == null) return `<span class="fit-res-cell"><span class="fit-res-val">–</span></span>`;
    return `<span class="fit-res-cell" title="${pct}%">
        <span class="fit-res-fill fit-res-${k}" style="width:${Math.max(0, Math.min(100, pct))}%"></span>
        <span class="fit-res-val">${pct}%</span>
      </span>`;
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
// ─── Ship-stats engine ─────────────────────────────────────────────────────────
// Applies every fitted module's bonuses to the hull LIVE, respecting state:
// passives count while online, activatables only while active/overheated, and
// overheat bonuses (hardeners 1208, prop mods 1223, sensor mods 1936) on top.
// EVE stacking penalties per attribute chain. All attr IDs verified vs the SDE:
//   72 shieldHPAdd · 1159 armorHPAdd · 146/148/150 shield/armor/structure mult
//   984/987/986/985 em/th/kin/exp resistanceBonus (hardeners/membranes/amps)
//   ship-resonance attrs on modules (DCU) · 796 massAdd · 983 sigAdd
//   20+567 prop velocity · 554 sig % · 1076 velocity % · 169 agility %
//   309 lock range % · 566 scan res % · 235 targets · 1027-30 sensor str %
//   67 cap flat · 147 cap mult · 144 cap recharge-time mult
function _fitShipDerived() {
  const hull = _fitState.hull;
  const b = hull.base, nav = hull.nav, tgt = hull.targeting;

  // Bonus chains (fractions, stacking-penalized) and flat adds.
  const chains = {};   // key → [fraction,…]
  const add = (key, frac) => { if (frac) (chains[key] || (chains[key] = [])).push(frac); };
  const flat = { shield: 0, armor: 0, cap: 0, mass: 0, sig: 0, targets: 0, vel: 0 };

  // Ship resonance attr ids per layer/damage (same ids modules like DCU carry).
  const RES_IDS = {
    shield: { em: 271, th: 274, kin: 273, exp: 272 },
    armor:  { em: 267, th: 270, kin: 269, exp: 268 },
    hull:   { em: 113, th: 110, kin: 109, exp: 111 },
  };
  // resistanceBonus attrs (negative %): em 984, exp 985, kin 986, th 987.
  const RB = { em: 984, exp: 985, kin: 986, th: 987 };
  const SENSOR_ATTR = { Gravimetric: 1027, Ladar: 1028, Magnetometric: 1029, Radar: 1030 };

  for (const m of _fitAllMods()) {
    if (m.state === 'offline') continue;
    const a = m.f?.attrs || {};
    const g = (m.f?.groupName || '').toLowerCase();
    const running = !m.ref.activatable || m.state === 'active' || m.state === 'overheated';
    const hot = m.state === 'overheated';

    // T3 subsystems contribute raw hull stats (shield / armor / capacitor /
    // velocity) as plain additive attrs — a bare T3 hull is a skeleton.
    if (m._slot === 'subsystem') {
      flat.shield += a[263] || 0;
      flat.armor  += a[265] || 0;
      flat.cap    += a[482] || 0;
      flat.vel    += a[37]  || 0;
      continue;
    }

    // Fitting-level effects — apply while online, even on activatables
    // (plate/prop-mod mass, MWD cap penalty, extender HP+sig are "fitted" costs).
    if (a[796]) flat.mass += a[796];
    if (a[72])  flat.shield += a[72];
    if (a[983]) flat.sig += a[983];
    if (a[1159]) flat.armor += a[1159];
    if (a[67])  flat.cap += a[67];
    if (a[235]) flat.targets += a[235];
    if (a[146]) add('shieldMult', a[146] - 1);
    if (a[148]) add('armorMult',  a[148] - 1);
    if (a[150]) add('structMult', a[150] - 1);
    if (a[147]) add('capMult',    a[147] - 1);
    if (a[144]) add('capTime',    a[144] - 1);

    if (!running) continue;   // everything below needs the module actually running

    // Resistances: resistanceBonus attrs → the module's own layer (shield vs armor
    // by group name); DCU-style direct resonance attrs → their exact layer/type.
    const heatK = hot && a[1208] ? 1 + a[1208] / 100 : 1;
    const layer = g.includes('shield') ? 'shield' : 'armor';
    for (const [d, id] of Object.entries(RB)) {
      if (a[id]) add(`res:${layer}:${d}`, (-a[id] / 100) * heatK);
    }
    for (const [ly, ids] of Object.entries(RES_IDS)) {
      for (const [d, id] of Object.entries(ids)) {
        if (a[id] != null && a[id] !== 1) add(`res:${ly}:${d}`, 1 - a[id]);
      }
    }

    // Navigation.
    if (a[1076]) add('vel', a[1076] / 100);                       // overdrives / nanos
    if (a[169])  add('agi', a[169] / 100);                        // istabs / nanos (negative = better)
    if (a[554] && !(a[20] && a[567])) add('sig', a[554] / 100);   // istab sig penalty (prop bloom handled below)

    // Targeting (Sensor Boosters take scripts — group 910 — like TCs).
    const sMode = (() => {
      if (m.charge?.f?.groupId !== 910 && m.f?.chargeGroup !== 910) return null;
      const n = (m.charge?.name || '').toLowerCase();
      return n.includes('targeting range') ? 'range' : n.includes('scan resolution') ? 'scanres' : n.includes('eccm') ? 'eccm' : null;
    })();
    const sHeat = hot && a[1936] ? 1 + a[1936] / 100 : 1;
    if (a[309]) add('lock',    (sMode === 'range'   ? 2 : sMode ? 0 : 1) * (a[309] / 100) * sHeat);
    if (a[566]) add('scanres', (sMode === 'scanres' ? 2 : sMode ? 0 : 1) * (a[566] / 100) * sHeat);
    const strAttr = SENSOR_ATTR[tgt.sensorType];
    if (strAttr && a[strAttr]) add('sensor', (sMode === 'eccm' ? 2 : sMode ? 0 : 1) * (a[strAttr] / 100) * sHeat);
  }

  const mult = (key) => _fitStackChain(chains[key] || []);
  // Resonance after resist bonuses: base × Π(1 − b·penalty).
  const resOf = (layer, baseRes) => {
    const out = {};
    for (const d of ['em', 'th', 'kin', 'exp']) {
      const bs = (chains[`res:${layer}:${d}`] || []);
      if (baseRes[d] == null) { out[d] = bs.length ? 1 : null; }
      else out[d] = baseRes[d];
      if (out[d] == null) continue;
      const pos = bs.filter(x => x > 0).sort((x, y) => y - x);
      const neg = bs.filter(x => x < 0).sort((x, y) => x - y);
      pos.forEach((v, i) => { out[d] *= 1 - v * Math.exp(-((i / 2.67) ** 2)); });
      neg.forEach((v, i) => { out[d] *= 1 - v * Math.exp(-((i / 2.67) ** 2)); });
    }
    return out;
  };

  // Skills: Shield Management / Hull Upgrades / Mechanics (+5%/lvl to each layer).
  const shieldHp = (b.shieldHp + flat.shield) * mult('shieldMult') * _fitSkMult('shieldMgmt', 5);
  const armorHp  = (b.armorHp + flat.armor) * mult('armorMult')    * _fitSkMult('hullUp', 5);
  const structHp = b.structureHp * mult('structMult')              * _fitSkMult('mechanics', 5);
  const shieldRes = resOf('shield', b.shieldRes);
  const armorRes  = resOf('armor',  b.armorRes);
  const hullRes   = resOf('hull',   b.hullRes);
  const ehp = _fitLayerEHP(shieldHp, shieldRes) + _fitLayerEHP(armorHp, armorRes) + _fitLayerEHP(structHp, hullRes);

  // Navigation: base × velocity mods × Navigation skill, then active prop-mod
  // thrust (v ×= 1 + sf% · thrust/mass, sf boosted by Acceleration Control).
  const mass = (nav.mass || 0) + flat.mass;
  let maxVel = ((nav.maxVel || 0) + flat.vel) * mult('vel') * _fitSkMult('nav', 5);
  let sigChain = chains['sig'] || [];
  const accelK = _fitSkMult('accel', 5);
  for (const m of _fitAllMods()) {
    const a = m.f?.attrs || {};
    if (!(a[20] && a[567])) continue;
    if (m.state !== 'active' && m.state !== 'overheated') continue;
    const sf = a[20] * accelK * (m.state === 'overheated' && a[1223] ? 1 + a[1223] / 100 : 1);
    maxVel *= 1 + (sf / 100) * (a[567] / (mass || 1));
    if (a[554]) sigChain.push(a[554] / 100);       // MWD signature bloom while running
  }
  chains['sig'] = sigChain;
  const agility = (nav.agility || 0) * mult('agi') * _fitSkMult('evasive', -5);
  const sig = ((nav.sig || 0) + flat.sig) * mult('sig');
  const align = (mass && agility) ? (Math.log(4) * agility * mass) / 1e6 : 0;

  const capCap = (b.capacitor + flat.cap) * mult('capMult') * _fitSkMult('capMgmt', 5);
  const rechargeSec = ((b.rechargeMs || 0) * mult('capTime') * _fitSkMult('capSys', -5)) / 1000;
  const peakRegen = rechargeSec > 0 ? (2.5 * capCap) / rechargeSec : 0;

  return {
    shieldHp, armorHp, structHp, shieldRes, armorRes, hullRes, ehp,
    mass, maxVel, agility, sig, align, warp: nav.warpMult,
    capCap, rechargeSec, peakRegen,
    lockRange: (tgt.lockRange || 0) * mult('lock') * _fitSkMult('lrt', 5),
    scanRes: (tgt.scanRes || 0) * mult('scanres')  * _fitSkMult('sigAn', 5),
    sensorStrength: (tgt.sensorStrength || 0) * mult('sensor'),
    maxTargets: (tgt.maxTargets || 0) + flat.targets,
  };
}

// Offense now comes from the sim (damage mods, heat, stacking, drones included).
function _fitComputeOffense() {
  const sim = _fitSimCache || _fitWeaponSim().concat(_fitDroneSim());
  return { dps: sim.reduce((s, g) => s + g.dps, 0), volley: sim.reduce((s, g) => s + g.volley, 0) };
}

function _fitComputeUsage() {
  // Weapon Upgrades −5%/lvl weapon CPU need; Advanced Weapon Upgrades −2%/lvl PG.
  const wuK  = _fitSkMult('wu', -5);
  const awuK = _fitSkMult('awu', -2);
  let cpu = 0, pg = 0, turret = 0, launcher = 0;
  for (const key of Object.keys(_fitState.modules)) {
    for (const m of _fitState.modules[key]) {
      if (!m) continue;
      if (m.state !== 'offline') {
        const weapon = !!m.hardpoint;
        cpu += (m.cpu || 0) * (weapon ? wuK : 1);
        pg  += (m.pg  || 0) * (weapon ? awuK : 1);
      }
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
  if (_fitState.drones.length) {
    lines.push('');
    for (const d of _fitState.drones) lines.push(`${d.name} x${d.qty}`);
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

  const moduleNames = [], chargeNames = [], parsed = [], stacks = [];
  for (const line of lines) {
    if (!line) continue;
    const xm = line.match(/^(.+?)\s+x(\d+)$/i);     // "Valkyrie II x5" — drones/cargo
    if (xm) { stacks.push({ name: xm[1].trim(), qty: Number(xm[2]) }); continue; }
    const [modName, chargeName] = line.split(',').map(s => s.trim());
    if (!modName) continue;
    moduleNames.push(modName);
    if (chargeName) chargeNames.push(chargeName);
    parsed.push({ modName, chargeName });
  }

  const res = await window.eveAPI.fitLookupNames([hullName, ...moduleNames, ...chargeNames, ...stacks.map(s => s.name)]).catch(() => ({ byName: {} }));
  const byName = res.byName || {};
  const hullFacts = byName[hullName.toLowerCase()];
  if (!hullFacts || hullFacts.categoryId !== 6) { _fitFlash(`Hull "${hullName}" not found.`); return; }

  await _fitLoadHull(hullFacts.id);
  // Subsystems first — they create the slots everything else lands in.
  parsed.sort((x, y) => ((byName[y.modName.toLowerCase()]?.slot === 'subsystem') ? 1 : 0) - ((byName[x.modName.toLowerCase()]?.slot === 'subsystem') ? 1 : 0));
  let placed = 0, skipped = 0;
  for (const { modName, chargeName } of parsed) {
    const f = byName[modName.toLowerCase()];
    if (!f || !f.slot || _fitCanFit(f)) { skipped++; continue; }   // incl. hardpoint check
    if (f.slot === 'subsystem') { _fitPlaceSubsystem(f); placed++; continue; }
    const mod = _fitMod(f);
    if (chargeName && byName[chargeName.toLowerCase()]) {
      const cf = byName[chargeName.toLowerCase()];
      mod.charge = { id: cf.id, name: cf.name, dmg: cf.dmg, f: cf };
    }
    if (_fitPlace(f.slot, mod)) placed++; else skipped++;
  }
  // "Name xN" stacks: drones go to the bay (other cargo lines are skipped).
  for (const s of stacks) {
    const f = byName[s.name.toLowerCase()];
    if (f && (f.categoryId === 18 || f.categoryId === 87)) _fitAddDrone(f, s.qty);
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
  // Pass 1: subsystems — they create the slot layout everything else lands in.
  for (const it of fit.items) {
    const f = facts[it.typeId];
    if (f && f.slot === 'subsystem') {
      const rack = _fitState.modules.subsystem;
      if (rack.length) rack[Math.max(0, Math.min(rack.length - 1, (f.attrs?.[1366] || 125) - 125))] = _fitMod(f);
    }
  }
  _fitSyncRacks();
  // Pass 2: everything else at its exact position.
  for (const it of fit.items) {
    const f = facts[it.typeId];
    if (!f || f.slot === 'subsystem') continue;
    if (f.categoryId === 18 || f.categoryId === 87) { _fitAddDrone(f, it.quantity || 1); continue; }   // drone/fighter bay
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
  // Bays: drones → DroneBay flag 87, fighters → FighterBay flag 158.
  for (const d of _fitState.drones) items.push({ typeId: d.id, flag: _fitIsFighter(d) ? 158 : 87, quantity: d.qty });
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
