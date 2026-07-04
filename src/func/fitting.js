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
// fitting). Per-HULL trait bonuses (role bonuses and per-skill-level bonuses from
// invTraits — damage, rate of fire, resists, HP, missile velocity/flight, ranges,
// drone damage) ARE applied via the trait engine below, matched through the
// showinfo skill links in each trait's bonusText. Implants (10 slots) apply their
// fitting-relevant attribute bonuses as plain (non-penalized) multipliers.
// Pirate/navy implant SETS (Nirvana, Amulet, Snake, Crystal, Asklepian,
// Ascendancy, Halo, Rapture, Hydra, Genolution, HG/LG navy sensor sets…) apply
// their full set mechanic: every piece's set multiplier amplifies all worn
// pieces of that set, Omega included.
// Not simulated: cap-use bonuses, reload time, EWAR strength, boosters (drugs),
// and specialization-skill (T2) damage. Everything else is exact SDE values
// with EVE's stacking-penalty formula.

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
  shieldOp: 3416, repSys: 3393,                  // shield recharge time / repairer duration
  // Command Burst Specialist skills (+10%/lvl own-burst strength, attr 2572)
  shieldSpec: 3351, armorSpec: 11569, skirmSpec: 11572, infoSpec: 3352,
  // Cap-use skills: Controlled Bursts (turrets −5%), Fuel Conservation (AB −10%),
  // High Speed Maneuvering (MWD −5%), Shield Compensation (boosters −2%)
  ctrlBursts: 3316, fuelCons: 3451, hsm: 3454, shieldComp: 21059,
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
  drones: [],                                  // drone bay stacks: { id, name, f, qty, active }
  droneBayOpen: false,                         // drone bay panel visible on the wheel
  fighters: [],                                // LAUNCH TUBES: per tube null | { id, name, f, units, active }
  fighterBayOpen: false,                       // fighter tube panel visible
  implants: new Array(10).fill(null),          // slot 1-10 → { id, name, f } (character-level, survives hull swaps)
  implantsOpen: false,                         // implants panel visible
  links: localStorage.getItem('fitLinks') || 'off',   // incoming command-burst preset
  target: null,                                // { id, name, base } — applied-damage reference hull
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
  fitsError: null,                             // why game fits couldn't load (shown in the tree)
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
            <button id="fitSaveLocal"  class="fit-btn fit-btn-accent">Save</button>
            <button id="fitSaveGame"   class="fit-btn">Save to Game</button>
            <button id="fitClear"      class="fit-btn">Clear</button>
          </div>
        </div>
        <div class="fit-skillbar">
          <span class="fit-skillbar-label"><span class="material-symbols-outlined">school</span> SKILLS</span>
          <select id="fitSkillSel" class="field-input" style="width:220px;">
            <option value="all5">All skills V</option>
            <option value="none">No skills (all 0)</option>
          </select>
          <span class="fit-skillbar-label" title="Simulate command bursts received from a fleet booster (max-skill Command Ship with mindlink, T2 bursts). Shown as green + bonuses on the stats."><span class="material-symbols-outlined">podcasts</span> LINKS</span>
          <select id="fitLinksSel" class="field-input" style="width:190px;">
            <option value="off">No incoming links</option>
            <option value="shield">Shield bursts (max)</option>
            <option value="armor">Armor bursts (max)</option>
            <option value="skirmish">Skirmish bursts (max)</option>
            <option value="info">Info bursts (max)</option>
            <option value="shieldskirm">Shield + Skirmish (max)</option>
            <option value="armorskirm">Armor + Skirmish (max)</option>
            <option value="all">All bursts (max)</option>
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
    const del = e.target.closest('[data-delfit]');
    if (del) { _fitDeleteLocalFit(del.dataset.delfit); return; }
    const localRow = e.target.closest('[data-localfit]');
    if (localRow) { _fitLoadLocalFit(localRow.dataset.localfit); return; }
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
  mount.querySelector('#fitSaveLocal').addEventListener('click', _fitSaveLocal);
  mount.querySelector('#fitSaveGame').addEventListener('click', _fitSaveToGame);

  // Incoming fleet links (command-burst presets) — persists across sessions.
  const linksSel = mount.querySelector('#fitLinksSel');
  linksSel.value = _fitState.links;
  if (linksSel.selectedIndex === -1) { linksSel.value = 'off'; _fitState.links = 'off'; }
  linksSel.addEventListener('change', () => {
    _fitState.links = linksSel.value;
    try { localStorage.setItem('fitLinks', linksSel.value); } catch (_) {}
    _fitRenderAll();
  });

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
    for (const k of [182, 183, 184]) if (m.f?.attrs?.[k]) ids.add(m.f.attrs[k]);
    for (const k of [182, 183, 184]) if (m.charge?.f?.attrs?.[k]) ids.add(m.charge.f.attrs[k]);
  }
  for (const d of _fitState.drones) for (const k of [182, 183, 184]) if (d.f?.attrs?.[k]) ids.add(d.f.attrs[k]);
  // Hull + subsystem trait bonuses scale with their own skills (racial hull
  // skills, T3 subsystem skills) — fetch those levels too.
  for (const r of (_fitState.hull?.traits || [])) if (r.skillID > 0) ids.add(r.skillID);
  for (const m of _fitState.modules.subsystem || []) {
    if (m) for (const r of (m.f?.traits || [])) if (r.skillID > 0) ids.add(r.skillID);
  }
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
    const fighters = (_fitState.fighters || []).map(t => t ? { id: t.id, units: t.units, active: t.active ? 1 : 0 } : null);
    const implants = _fitState.implants.map(i => i ? { id: i.id, name: i.name } : null);
    localStorage.setItem('fitSaved', JSON.stringify({ hullId: _fitState.hull.id, fitName: _fitState.fitName, racks, drones, fighters, implants }));
  } catch (_) {}
}

async function _fitRestore() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem('fitSaved') || 'null'); } catch (_) {}
  return _fitApplySnapshot(data);
}

// Rebuild the whole fit (hull, modules, states, charges, drones) from a snapshot
// in the _fitPersist shape — shared by the Ctrl+R restore and locally saved fits.
async function _fitApplySnapshot(data) {
  if (!data?.hullId) return false;
  const hull = await window.eveAPI.fitGetHull(data.hullId).catch(() => null);
  if (!hull) return false;
  const ids = new Set();
  for (const rack of Object.values(data.racks || {})) {
    for (const e of rack || []) { if (e) { ids.add(e.id); if (e.c) ids.add(e.c.id); } }
  }
  for (const d of (data.drones || [])) ids.add(d.id);
  for (const t of (data.fighters || [])) if (t) ids.add(t.id);
  for (const i of (data.implants || [])) if (i) ids.add(i.id);
  const facts = ids.size ? await window.eveAPI.fitGetItems([...ids]).catch(() => ({})) : {};
  _fitState.hull = hull;
  _fitState.fitName = data.fitName || 'EVE Carbon Fit';
  _fitState.modules = _fitEmptyRacks(hull);
  _fitState.drones = (data.drones || [])
    .filter(d => facts[d.id] && facts[d.id].categoryId !== 87)
    .map(d => ({ id: d.id, name: facts[d.id].name, f: facts[d.id], qty: d.qty || 1, active: d.active || 0 }));
  // Fighter tubes (new snapshots) …
  _fitState.fighters = [];
  (data.fighters || []).forEach((t, i) => {
    _fitState.fighters[i] = (t && facts[t.id])
      ? { id: t.id, name: facts[t.id].name, f: facts[t.id], units: t.units || 1, active: t.active !== 0 }
      : null;
  });
  // …and legacy snapshots that stored fighters as drone-bay stacks: refill tubes.
  for (const d of (data.drones || [])) {
    const f = facts[d.id];
    if (!f || f.categoryId !== 87) continue;
    let left = d.qty || 1;
    const sqMax = f.attrs?.[2215] || 1;
    const tubes = hull.fighter?.tubes || 0;
    while (left > 0 && _fitState.fighters.filter(Boolean).length < tubes) {
      const idx = (() => { for (let i = 0; i < tubes; i++) if (!_fitState.fighters[i]) return i; return -1; })();
      if (idx === -1) break;
      const units = Math.min(sqMax, left);
      _fitState.fighters[idx] = { id: f.id, name: f.name, f, units, active: true };
      left -= units;
    }
  }
  if (data.implants) {
    _fitState.implants = new Array(10).fill(null);
    data.implants.forEach((i, n) => {
      if (i && facts[i.id] && n < 10) _fitState.implants[n] = { id: i.id, name: facts[i.id].name, f: facts[i.id] };
    });
  }
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

// Hull names for game-fit rows (fit payloads only carry shipTypeId).
const _fitHullNameCache = new Map();
async function _fitHullNames(ids) {
  const missing = [...new Set(ids)].filter(id => id && !_fitHullNameCache.has(id));
  if (missing.length) {
    const facts = await window.eveAPI.fitGetItems(missing).catch(() => ({}));
    for (const id of missing) _fitHullNameCache.set(id, facts[id]?.name || '');
  }
  return (id) => _fitHullNameCache.get(id) || '';
}

// Ship-tab search matches HULL NAMES and FIT NAMES together: a matching hull
// lists every saved fit for it (local + game), and a fit whose NAME matches
// shows up with its hull labelled — "Fight Club" finds the Nyx fit directly.
async function _fitDoSearch() {
  const box  = document.getElementById('fitResults');
  const qRaw = document.getElementById('fitSearch')?.value.trim() || '';
  const q    = qRaw.toLowerCase();
  if (!box || q.length < 2) return;
  box.innerHTML = `<div class="fit-hint">Searching…</div>`;
  const results = await window.eveAPI.fitSearch(qRaw, _fitState.searchKind, 80).catch(() => []);
  if ((document.getElementById('fitSearch')?.value.trim() || '') !== qRaw) return;   // stale response
  _fitState.searchResults = results;

  if (_fitState.searchKind !== 'ship') {
    box.innerHTML = results.length
      ? results.map(r => _fitTypeRowHtml({ id: r.id, name: r.name }, r.groupName)).join('')
      : `<div class="fit-hint">No matches.</div>`;
    return;
  }

  await _fitEnsureGameFits();
  const locals = _fitLocalFits();
  const game   = _fitState.fitsByHull?.all || [];
  const localRow = (lf, hullLabel = '') => `
    <div class="fit-result ft-fit ft-fit-local" data-localfit="${lf.id}" title="Saved in EVE Carbon — click to load">
      <span class="material-symbols-outlined">save</span>
      <span class="fit-result-name">${_fitEsc(lf.name)}</span>
      ${hullLabel ? `<span class="fit-result-grp">${_fitEsc(hullLabel)}</span>` : ''}
      <button class="ft-fit-del" data-delfit="${lf.id}" title="Delete this saved fit">✕</button>
    </div>`;
  const gameRow = (i, f, hullLabel = '') => `
    <div class="fit-result ft-fit" data-fitidx="${i}" title="Saved fit (in game) — click to load">
      <span>⚙</span><span class="fit-result-name">${_fitEsc(f.name)}</span>
      ${hullLabel ? `<span class="fit-result-grp">${_fitEsc(hullLabel)}</span>` : ''}
    </div>`;

  const rows = [];
  const shownLocal = new Set(), shownGame = new Set();
  // Matching hulls — each with ALL of its saved fits nested beneath it.
  for (const r of results) {
    rows.push(_fitTypeRowHtml({ id: r.id, name: r.name }, r.groupName));
    locals.forEach(lf => { if (lf.hullId === r.id) { rows.push(localRow(lf)); shownLocal.add(lf.id); } });
    game.forEach((f, i) => { if (f.shipTypeId === r.id) { rows.push(gameRow(i, f)); shownGame.add(i); } });
  }
  // Fits matched by NAME (or stored hull name) that aren't already listed.
  const extraL = locals.filter(lf => !shownLocal.has(lf.id)
    && (lf.name.toLowerCase().includes(q) || (lf.hullName || '').toLowerCase().includes(q)));
  const extraG = game.map((f, i) => ({ f, i })).filter(({ f, i }) => !shownGame.has(i) && (f.name || '').toLowerCase().includes(q));
  if (extraL.length || extraG.length) {
    const nameOf = await _fitHullNames(extraG.map(({ f }) => f.shipTypeId));
    if ((document.getElementById('fitSearch')?.value.trim() || '') !== qRaw) return;
    if (rows.length) rows.push(`<div class="ft-fit-sec">FITS MATCHING “${_fitEsc(qRaw)}”</div>`);
    extraL.forEach(lf => rows.push(localRow(lf, lf.hullName)));
    extraG.forEach(({ f, i }) => rows.push(gameRow(i, f, nameOf(f.shipTypeId))));
  }
  box.innerHTML = rows.join('') || `<div class="fit-hint">No hulls or fits match.</div>`;
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
  const fitsNote = (kind === 'ship' && _fitState.fitsError)
    ? `<div class="fit-hint fit-hint-warn">⚠ Game fits unavailable — ${_fitEsc(_fitState.fitsError)} Locally saved fits are unaffected.</div>` : '';
  box.innerHTML = fitsNote + (tree.sections.map(s => grpHtml(s, kind)).join('')
    || `<div class="fit-hint">Nothing matches the active filters.</div>`);

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
  const locals = kind === 'ship' ? _fitLocalFits() : [];
  holder.innerHTML = types.map(t => {
    let html = _fitTypeRowHtml(t);
    if (kind === 'ship') {
      for (const lf of locals) {
        if (lf.hullId !== t.id) continue;
        html += `
          <div class="fit-result ft-fit ft-fit-local" data-localfit="${lf.id}" title="Saved in EVE Carbon — click to load">
            <span class="material-symbols-outlined">save</span>${_fitEsc(lf.name)}
            <button class="ft-fit-del" data-delfit="${lf.id}" title="Delete this saved fit">✕</button>
          </div>`;
      }
      if (_fitState.fitsByHull?.byHull?.has(t.id)) {
        html += _fitState.fitsByHull.byHull.get(t.id)
          .map(({ i, name }) => `<div class="fit-result ft-fit" data-fitidx="${i}" title="Saved fit — click to load">⚙ ${_fitEsc(name)}</div>`)
          .join('');
      }
    }
    return html;
  }).join('') || `<div class="fit-hint" style="padding:4px 8px;">No matches for the active filters.</div>`;
}

// Saved game fits for the selected character, grouped by hull (Hulls & Fits tab).
async function _fitEnsureGameFits() {
  const charId = document.getElementById('fitCharSelect')?.value || '';
  if (!charId) { _fitState.fitsByHull = null; _fitState.fitsError = null; return; }
  if (_fitState.fitsChar === charId && _fitState.fitsByHull) { _fitState.fitsError = null; return; }
  // After a failure, keep showing the notice but don't re-hit ESI on every
  // render — retry at most every 30 s (rate-limit friendly).
  if (_fitState.fitsError && Date.now() - (_fitState.fitsErrorAt || 0) < 30000) return;
  const res = await window.eveAPI.fitGetFittings(charId).catch(e => ({ ok: false, error: e.message }));
  if (!res.ok) {
    // Do NOT cache a failed fetch as an empty list — the next render retries,
    // and the tree shows WHY the fits are missing instead of silently blanking.
    _fitState.fitsByHull = null; _fitState.fitsChar = null;
    _fitState.fitsErrorAt = Date.now();
    _fitState.fitsError = res.needsReauth
      ? 'Re-authenticate this character to grant fittings access.'
      : (res.error || 'Could not load game fits.');
    return;
  }
  _fitState.fitsError = null;
  const all = res.fittings || [];
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
  // Fighter launch tubes track the hull too.
  const tubes = hull.fighter?.tubes || 0;
  const fl = _fitState.fighters || (_fitState.fighters = []);
  while (fl.length < tubes) fl.push(null);
  if (fl.length > tubes) fl.splice(tubes).forEach(t => { if (t) dropped.push(`${t.name} squadron`); });
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
  _fitState.fighters = [];
  _fitState.selected = null;
  _fitRenderAll();
}

// ─── Drone & fighter bays ─────────────────────────────────────────────────────
// One store (_fitState.drones) holds both: drones (category 18, live in the drone
// bay, limited by bandwidth + 5 in space) and fighters (category 87, live in the
// fighter bay, launched as SQUADRONS limited by launch tubes).
function _fitIsFighter(d)     { return (d.f?.categoryId ?? d.categoryId) === 87; }
function _fitDroneUsedM3()    { return _fitState.drones.filter(d => !_fitIsFighter(d)).reduce((s, d) => s + d.qty * (d.f?.volume || 0), 0); }
function _fitDroneActiveBw()  { return _fitState.drones.filter(d => !_fitIsFighter(d)).reduce((s, d) => s + d.active * (d.f?.attrs?.[1272] || 0), 0); }
function _fitDroneActiveN()   { return _fitState.drones.filter(d => !_fitIsFighter(d)).reduce((s, d) => s + d.active, 0); }
function _fitFighterSqSize(d) { return d.f?.attrs?.[2215] || 1; }

// ── Fighters live in LAUNCH TUBES — one squadron per tube (in-game model). ──
// Hulls limit squadrons by TYPE: fighterLightSlots / SupportSlots / HeavySlots
// (a Thanatos' 4 tubes hold at most 3 light + 2 support; a Hel 3 light + 4 heavy).
function _fitFighterType(f) {
  const g = f?.groupId;
  if (g === 1652 || g === 4777) return 'light';
  if (g === 1537 || g === 4778) return 'support';
  if (g === 1653 || g === 4779) return 'heavy';
  return null;
}
function _fitFighterTubeCaps() {
  const fg = _fitState.hull?.fighter || {};
  return { tubes: fg.tubes || 0, light: fg.light || 0, support: fg.support || 0, heavy: fg.heavy || 0 };
}
function _fitFighterTypeCount(type) {
  return (_fitState.fighters || []).filter(t => t && _fitFighterType(t.f) === type).length;
}
function _fitFighterUsedM3()  { return (_fitState.fighters || []).reduce((s, t) => s + (t ? t.units * (t.f?.volume || 0) : 0), 0); }
function _fitFighterActiveSq(){ return (_fitState.fighters || []).filter(t => t && t.active).length; }

// Load a squadron into a tube. Enforces tube count, per-type squadron slots and
// fighter-bay volume; auto-clamps units to what the bay can still hold.
// Returns the number of UNITS placed (0 = refused, with the reason flashed).
function _fitAddFighter(facts, atTube = null, wantUnits = Infinity) {
  const hull = _fitState.hull;
  const caps = _fitFighterTubeCaps();
  if (!caps.tubes) { _fitFlash(`${hull.name} has no fighter launch tubes.`); return 0; }
  const type = _fitFighterType(facts);
  if (!type) { _fitFlash(`${facts.name} isn't a fighter.`); return 0; }
  const fl = _fitState.fighters;
  const idx = (atTube != null && atTube < fl.length && !fl[atTube]) ? atTube : fl.findIndex(t => !t);
  if (idx === -1) { _fitFlash(`All ${caps.tubes} launch tubes are loaded.`); return 0; }
  if (_fitFighterTypeCount(type) >= (caps[type] || 0)) {
    _fitFlash(`No free ${type}-squadron slots (${_fitFighterTypeCount(type)}/${caps[type] || 0} on ${hull.name}).`);
    return 0;
  }
  const sqMax = facts.attrs?.[2215] || 1;
  const free  = (hull.fighter?.bay || 0) - _fitFighterUsedM3();
  const units = Math.max(0, Math.min(sqMax, wantUnits, Math.floor(free / (facts.volume || 1))));
  if (!units) { _fitFlash(`Fighter bay full (${_fitNum(_fitFighterUsedM3())} / ${_fitNum(hull.fighter.bay)} m³).`); return 0; }
  fl[idx] = { id: facts.id, name: facts.name, f: facts, units, active: true };
  _fitRenderAll();
  if (units < Math.min(sqMax, wantUnits)) _fitFlash(`Tube ${idx + 1}: only ${units}/${sqMax} ${facts.name}s fit in the bay.`);
  return units;
}

// Combined sustained DPS of one tube's squadron: primary attack + missile salvo
// (averaged over its cooldown) + bomb launches.
function _fitFighterTubeDps(t) {
  const a = t.f?.attrs || {};
  let dps = 0;
  const add = (perUnit, cycMs) => { if (perUnit > 0 && cycMs > 0) dps += (perUnit * t.units) / (cycMs / 1000); };
  add(((a[2227] || 0) + (a[2228] || 0) + (a[2229] || 0) + (a[2230] || 0)) * (a[2226] || 1), a[2233] || 0);
  add(((a[2131] || 0) + (a[2132] || 0) + (a[2133] || 0) + (a[2134] || 0)) * (a[2130] || 1), a[2182] || 0);
  if (a[2324]) {
    const bf = _fitBombFacts(a[2324]);
    if (bf) { const d = bf.dmg || {}; add((d.em || 0) + (d.th || 0) + (d.kin || 0) + (d.exp || 0), a[2349] || 60000); }
  }
  return dps;
}

// Units stepper for a tube (±1): capped by squadron max and fighter-bay volume.
function _fitTubeUnits(i, delta) {
  const t = _fitState.fighters[i];
  if (!t) return;
  if (delta > 0) {
    const sqMax = t.f?.attrs?.[2215] || 1;
    if (t.units >= sqMax) { _fitFlash(`Squadron is full (${sqMax} max for ${t.name}).`); return; }
    const free = (_fitState.hull?.fighter?.bay || 0) - _fitFighterUsedM3();
    if (free < (t.f?.volume || 0)) { _fitFlash(`Fighter bay full (${_fitNum(_fitFighterUsedM3())} / ${_fitNum(_fitState.hull.fighter.bay)} m³).`); return; }
    t.units++;
  } else {
    t.units = Math.max(1, t.units - 1);
  }
  _fitRenderAll();
}
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
  // Fighters go into launch tubes, one squadron per tube. A click adds one full
  // squadron; an import quantity fills as many tubes as it can.
  if (facts.categoryId === 87) {
    if (qty <= 1) { _fitAddFighter(facts); return; }
    let left = qty;
    while (left > 0) {
      const placed = _fitAddFighter(facts, null, left);
      if (!placed) break;
      left -= placed;
    }
    return;
  }
  const bay = _fitEffDrone().bay;
  if (!bay) { _fitFlash(`${_fitState.hull.name} has no drone bay.`); return; }
  const used = _fitDroneUsedM3();
  const vol  = facts.volume || 0;
  const fits = Math.max(0, Math.min(qty, Math.floor((bay - used) / (vol || 1))));
  if (!fits) { _fitFlash(`Drone bay full (${_fitNum(used)} / ${_fitNum(bay)} m³).`); return; }
  const stack = _fitState.drones.find(d => d.id === facts.id);
  if (stack) stack.qty += fits;
  else _fitState.drones.push({ id: facts.id, name: facts.name, f: facts, qty: fits, active: 0 });
  _fitState.droneBayOpen = true;
  _fitRenderAll();
  if (fits < qty) _fitFlash(`Only ${fits} fit in the bay.`);
}

// Change a drone stack's ACTIVE count (±1): bandwidth + max-in-space limits.
// (Fighters live in launch tubes — see _fitTubeUnits / the tube panel.)
function _fitDroneSetActive(id, delta) {
  const d = _fitState.drones.find(x => x.id === id);
  if (!d || !_fitState.hull) return;
  if (delta > 0) {
    const bw = _fitEffDrone().bandwidth;
    const unit = d.f?.attrs?.[1272] || 0;
    if (d.active >= d.qty) return;
    const cap = _fitDroneCap();
    if (_fitDroneActiveN() >= cap) { _fitFlash(cap ? `Max ${cap} drones in space (Drones ${cap === 5 ? 'V' : cap}).` : 'The Drones skill is 0 under this profile — no drones can launch.'); return; }
    if (_fitDroneActiveBw() + unit > bw) { _fitFlash(`Not enough drone bandwidth (${_fitNum(bw)} Mbit/s).`); return; }
    d.active++;
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
  // plus Drone Interfacing (+10%/lvl, never penalized), hull drone-damage traits
  // (Gila/Ishtar/Rattlesnake…) and drone-tuner implants.
  const dda = [];
  for (const m of _fitAllMods()) if (m.state !== 'offline' && m.f?.attrs?.[1255]) dda.push(m.f.attrs[1255] / 100);
  const dmgMult = _fitStackChain(dda) * _fitSkMult('interfacing', 10) * _fitImplantBonuses().droneDmg;
  for (const d of _fitState.drones) {
    if (!d.active || _fitIsFighter(d)) continue;                     // fighters live in tubes now
    const a = d.f?.attrs || {};
    const droneTrait = _fitTraitMult('dmg', _fitRsSet(d.f), 'drone');
    const raw = (a[114] || 0) + (a[118] || 0) + (a[117] || 0) + (a[116] || 0);
    const perShot = raw * (a[64] || 1) * dmgMult * droneTrait;
    const rof = a[51] || 0;
    const dps = perShot > 0 && rof > 0 ? (perShot / (rof / 1000)) * d.active : 0;
    if (!dps) continue;
    out.push({
      kind: 'drone', flavor: 'drone', hot: false,
      name: d.name, chargeName: null, count: d.active,
      dps, volley: perShot * d.active,
      split: { em: (a[114] || 0) / raw, th: (a[118] || 0) / raw, kin: (a[117] || 0) / raw, exp: (a[116] || 0) / raw },
      optimal: a[54] || 0, falloff: a[158] || 0, tracking: a[160] || 0,
      vel: a[37] || 0, range: ctrl,
    });
  }
  // Launched squadrons — grouped per fighter type so 2 tubes of Einherjis read
  // as one chart series. Each ABILITY is its own series: the constant primary
  // attack, the big cooldown SALVO (Tyrfing-style heavy attack bombers), and
  // bomb launches (long-range fighters) — all scale with UNITS launched.
  const fMap = new Map();
  for (const t of _fitState.fighters || []) {
    if (!t || !t.active) continue;
    const e = fMap.get(t.id) || { f: t.f, name: t.name, units: 0, squads: 0 };
    e.units += t.units; e.squads++;
    fMap.set(t.id, e);
  }
  for (const e of fMap.values()) {
    const a = e.f?.attrs || {};
    const push = (suffix, comp, mult, cycMs, rangeM) => {
      const perUnit = (comp.em + comp.th + comp.kin + comp.exp) * mult;
      const volley = perUnit * e.units;
      const dps = volley > 0 && cycMs > 0 ? volley / (cycMs / 1000) : 0;
      if (!dps) return;
      const sum = comp.em + comp.th + comp.kin + comp.exp;
      out.push({
        kind: 'fighter', flavor: 'fighter', hot: false,
        name: `${e.name} — ${suffix}`, chargeName: null, count: e.squads,
        dps, volley,
        split: { em: comp.em / sum, th: comp.th / sum, kin: comp.kin / sum, exp: comp.exp / sum },
        optimal: rangeM, falloff: 0, tracking: null,
        vel: a[37] || 0, range: Infinity, abilityRange: rangeM,
      });
    };
    // Primary attack (constant fire).
    push('attack',
      { em: a[2227] || 0, th: a[2228] || 0, kin: a[2229] || 0, exp: a[2230] || 0 },
      a[2226] || 1, a[2233] || 0, (a[2236] || 0) + (a[2237] || 0));
    // Missile salvo (huge volley on a long cooldown — DPS shown as the
    // sustained average, volley shows the burst).
    push('salvo',
      { em: a[2131] || 0, th: a[2132] || 0, kin: a[2133] || 0, exp: a[2134] || 0 },
      a[2130] || 1, a[2182] || 0, a[2149] || 0);
    // Bomb launch — damage lives on the BOMB type (attr 2324), fetched lazily.
    if (a[2324]) {
      const bf = _fitBombFacts(a[2324]);
      if (bf) {
        const d = bf.dmg || {};
        push('bomb', { em: d.em || 0, th: d.th || 0, kin: d.kin || 0, exp: d.exp || 0 }, 1, a[2349] || 60000, bf.attrs?.[54] || 0);
      }
    }
  }
  return out;
}

// Bomb items referenced by fighter launch-bomb abilities — fetched once, then
// the render that needed them re-runs.
const _fitBombCache = new Map();
function _fitBombFacts(typeId) {
  if (_fitBombCache.has(typeId)) return _fitBombCache.get(typeId);
  _fitBombCache.set(typeId, null);
  window.eveAPI.fitGetItems([typeId]).then(r => {
    if (r && r[typeId]) { _fitBombCache.set(typeId, r[typeId]); _fitRenderAll(); }
  }).catch(() => {});
  return null;
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

// A copy of a fitted module: same type, same state, same loaded charge.
function _fitDupMod(src) {
  const copy = _fitMod(src.f);
  copy.state = src.state;                                // mirror active/overheated/etc.
  if (src.charge) copy.charge = { ...src.charge };
  return copy;
}

// Shift+click on a fitted module: clone it — module AND whatever charge it has
// loaded — into the next free slot of the same rack (fast way to fill a rack
// with identical weapons). Respects slot, hardpoint and CPU/PG limits.
// (Shift+DRAG+drop clones onto a specific slot — see _fitHandleDrop.)
function _fitCloneSlot(slot, idx) {
  try {
    const src = _fitState.modules[slot]?.[idx];
    if (!src) return;
    if (slot === 'subsystem') { _fitFlash('Subsystems are one per slot — nothing to duplicate.'); return; }
    const err = _fitCanFit(src.f);
    if (err) { _fitFlash(err); return; }
    if (!_fitPlace(slot, _fitDupMod(src))) { _fitFlash(`No free ${slot} slots.`); return; }
    _fitRenderAll();
    _fitFlash(`Duplicated ${src.name}${src.charge ? ` + ${src.charge.name}` : ''}.`);
  } catch (e) {
    // Never fail silently — surface whatever went wrong in the header.
    console.error('[fitting] shift+click duplicate failed:', e);
    _fitFlash('Duplicate failed: ' + e.message);
  }
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
// Shift-dropping a FITTED module duplicates it (charge included) onto the
// target slot instead of moving it.
async function _fitHandleDrop(payload, tgtSlot, tgtIdx, shiftAll = false) {
  if (!payload || !_fitState.hull) return;

  if (payload.startsWith('move:')) {
    const [, srcSlot, srcIdxS] = payload.split(':');
    const srcIdx = Number(srcIdxS);
    if (srcSlot === tgtSlot && srcIdx === tgtIdx) return;
    if (srcSlot === 'subsystem') { _fitFlash('Subsystems occupy fixed slots (Core / Defensive / Offensive / Propulsion).'); return; }
    if (srcSlot !== tgtSlot) { _fitFlash(`That's a ${srcSlot}-slot module — it can't move to a ${tgtSlot} slot.`); return; }
    const rack = _fitState.modules[srcSlot];
    if (shiftAll) {                                      // shift held → copy, don't move
      const src = rack[srcIdx];
      if (!src) return;
      if (rack[tgtIdx]) { _fitFlash('Shift-drop onto an EMPTY slot to duplicate.'); return; }
      const err = _fitCanFit(src.f);                     // free slot count + hardpoints
      if (err) { _fitFlash(err); return; }
      rack[tgtIdx] = _fitDupMod(src);
      _fitState.selected = null;
      _fitRenderAll();
      _fitFlash(`Duplicated ${src.name}${src.charge ? ` + ${src.charge.name}` : ''}.`);
      return;
    }
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

// ─── Hull-trait engine ─────────────────────────────────────────────────────────
// invTraits rows (hull + fitted T3 subsystems) parsed into machine records.
// skillID -1 = role bonus (always on); otherwise %-per-level of that skill.
// The bonusText's <a href=showinfo:ID> links are the SKILL ids the affected
// weapons / charges / drones / modules must REQUIRE (requiredSkill1-3) — that's
// the matcher, no name parsing of item types needed. Trait bonuses are plain
// multipliers (never stacking-penalized), exactly like the game.
const _FIT_DT_ALL = ['em', 'th', 'kin', 'exp'];
const _FIT_DT_KEY = { em: 'em', thermal: 'th', kinetic: 'kin', explosive: 'exp' };

function _fitParseTrait(r) {
  if (r == null || r.bonus == null || r.unitID !== 105) return null;   // % rows only
  const raw = String(r.bonusText || '');
  const links = [...raw.matchAll(/showinfo:(\d+)/g)].map(x => Number(x[1]));
  const text = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const rec = { pct: Number(r.bonus) || 0, skillId: r.skillID > 0 ? r.skillID : null, links, text };
  const has = (s) => text.includes(s);

  if (has('signature radius penalty'))      return { ...rec, q: 'mwdSigPen' };
  if (has('all shield resistances'))        return { ...rec, q: 'res', layer: 'shield', dtypes: _FIT_DT_ALL };
  if (has('all armor resistances'))         return { ...rec, q: 'res', layer: 'armor',  dtypes: _FIT_DT_ALL };
  const resM = text.match(/(shield|armor|hull|structure) (em|thermal|kinetic|explosive) resistance/);
  if (resM) return { ...rec, q: 'res', layer: resM[1] === 'structure' ? 'hull' : resM[1], dtypes: [_FIT_DT_KEY[resM[2]]] };
  if (has('rate of fire') && !has('reload')) return { ...rec, q: 'rof' };
  if (has('burst strength')) return { ...rec, q: 'burstStr' };         // command-ship burst bonuses
  if (/(booster|boost|repairer|repair) amount/.test(text)) return { ...rec, q: 'repAmount' };
  if (has('damage') && !has('damage from overheating') && !has('smartbomb')) {
    const dtypes = Object.keys(_FIT_DT_KEY).filter(w => has(w)).map(w => _FIT_DT_KEY[w]);
    return { ...rec, q: 'dmg', dtypes };
  }
  if (has('falloff'))        return { ...rec, q: 'falloff' };
  if (has('optimal range'))  return { ...rec, q: 'optimal' };
  if (has('tracking speed')) return { ...rec, q: 'tracking' };
  if (has('flight time'))    return { ...rec, q: 'mslFlight' };
  if (has('warp speed'))     return { ...rec, q: 'warp' };
  if (has('velocity') && !has('explosion velocity')) {
    if (has('drone')) return null;                                     // drone speed isn't simmed
    if (has('afterburner') || has('microwarpdrive')) return { ...rec, q: 'propBoost' };
    if (has('missile')) return { ...rec, q: 'mslVel' };
    if (links.length)   return { ...rec, q: 'mslVel' };                // "<HAM> max velocity" — scoped, only charges can match
    if (has('max velocity')) return { ...rec, q: 'shipVel' };
    return null;
  }
  if (has('hitpoints')) {
    if (links.length) return { ...rec, q: 'modhp' };                   // "<Shield Extender> hitpoints" — scales that module's HP add
    if (has('shield')) return { ...rec, q: 'hp', layer: 'shield' };
    if (has('armor'))  return { ...rec, q: 'hp', layer: 'armor' };
    if (has('structure') || has('hull')) return { ...rec, q: 'hp', layer: 'struct' };
    return null;
  }
  if (has('capacitor capacity'))       return { ...rec, q: 'cap' };
  if (has('capacitor recharge time'))  return { ...rec, q: 'capTime' };
  return null;                                                         // not simulated (reps, EWAR, reload, …)
}

// All active trait records: the hull's + every fitted (non-offline) subsystem's.
function _fitTraitRecords() {
  const hull = _fitState.hull;
  if (!hull) return [];
  if (_fitTraitRecords._hull === hull && _fitTraitRecords._subs === _fitSubsKey()) return _fitTraitRecords._recs;
  const rows = [...(hull.traits || [])];
  for (const m of _fitState.modules.subsystem || []) {
    if (m && m.state !== 'offline') rows.push(...(m.f?.traits || []));
  }
  const recs = rows.map(_fitParseTrait).filter(Boolean);
  _fitTraitRecords._hull = hull; _fitTraitRecords._subs = _fitSubsKey(); _fitTraitRecords._recs = recs;
  return recs;
}
function _fitSubsKey() {
  return (_fitState.modules.subsystem || []).map(m => (m && m.state !== 'offline') ? m.id : 0).join(',');
}

// Bonus scale: role rows apply once; per-skill rows scale with the profile's level.
function _fitTraitLvl(rec) { return rec.skillId ? _fitSkill(rec.skillId) : 1; }

// Does a trait row apply to an item with this required-skill set?
// Linked rows match if any linked skill is required by the weapon/charge/drone/
// module; unlinked rows fall back to the kind word in the text ("missile",
// "turret", "drone" — e.g. the Drake's "25% bonus to Missile velocity").
function _fitTraitMatches(rec, rsSet, kindWord) {
  if (rec.links.length) return !!rsSet && rec.links.some(id => rsSet.has(id));
  if (!kindWord) return true;
  return rec.text.includes(kindWord);
}

// Required-skill id set (requiredSkill1-3 = attrs 182/183/184) for facts objects.
function _fitRsSet(...factsList) {
  const s = new Set();
  for (const f of factsList) {
    const a = f?.attrs || {};
    for (const id of [a[182], a[183], a[184]]) if (id) s.add(id);
  }
  return s;
}

// Product of all matching trait multipliers for a quantity (1 + pct·lvl/100).
function _fitTraitMult(q, rsSet = null, kindWord = null) {
  let k = 1;
  for (const rec of _fitTraitRecords()) {
    if (rec.q !== q || !_fitTraitMatches(rec, rsSet, kindWord)) continue;
    k *= 1 + (rec.pct * _fitTraitLvl(rec)) / 100;
  }
  return k;
}
// Same for ship-level quantities with a layer (hp).
function _fitTraitLayerMult(q, layer) {
  let k = 1;
  for (const rec of _fitTraitRecords()) {
    if (rec.q === q && rec.layer === layer) k *= 1 + (rec.pct * _fitTraitLvl(rec)) / 100;
  }
  return k;
}
// Module-HP trait scale ("+100% Shield Extender hitpoints") for one fitted module.
function _fitModHpMult(mFacts) {
  let k = 1;
  const rs = _fitRsSet(mFacts);
  for (const rec of _fitTraitRecords()) {
    if (rec.q === 'modhp' && rec.links.some(id => rs.has(id))) k *= 1 + (rec.pct * _fitTraitLvl(rec)) / 100;
  }
  return k;
}
// Resonance scale from resist traits: res × (1 − pct·lvl/100) per matching row.
function _fitTraitRes(layer, res) {
  for (const rec of _fitTraitRecords()) {
    if (rec.q !== 'res' || rec.layer !== layer) continue;
    const k = 1 - (rec.pct * _fitTraitLvl(rec)) / 100;
    for (const t of rec.dtypes) if (res[t] != null) res[t] *= k;
  }
  return res;
}

// ─── Implants ──────────────────────────────────────────────────────────────────
// 10 slots (implantness attr 331). Bonuses are carried as plain % attributes and
// scoped by the implant's effect names ("…RequiringGunnery" → turrets,
// "missileSkill…" → launchers, drone tuners → drones). Implant bonuses are never
// stacking-penalized. Pirate SET multipliers are not applied (each implant's own
// bonus is), and rep/boost-amount implants aren't simulated.
const _FIT_MSL_FRAG = {   // per-missile-type damage implants: effect suffix → charge group fragment
  heavyassault: 'heavy assault', heavy: 'heavy missile', cruise: 'cruise',
  torpedo: 'torpedo', light: 'light missile', rocket: 'rocket', defender: 'defender',
};
// Pirate / navy implant SET attributes (implantSetSerpentis, ImplantSetNirvana…).
// Set mechanic: every piece's set-multiplier amplifies the bonuses of ALL worn
// pieces of that set, its own included — verified against the known full-set
// numbers (High-grade Amulet/Crystal ≈ +53.6%, High-grade Snake ≈ +24.7%).
const _FIT_SET_ATTRS = [
  802, 803, 838, 863, 864, 799, 1282, 1284, 1291, 1292, 1293,
  1550, 1552, 1553, 1554, 1569, 1570, 1571, 1572, 1799, 1932, 2825, 3017, 3023, 3027, 3107,
];
function _fitImplantBonuses() {
  const B = {
    turretDmg: 1, turretRof: 1, turretOpt: 1, turretFall: 1, turretTrack: 1,
    mslRof: 1, mslVel: 1, mslFlight: 1, mslDmg: [],
    droneDmg: 1, shieldHp: 1, armorHp: 1, hullHp: 1, cap: 1, capTime: 1,
    vel: 1, agi: 1, sig: 1, propBoost: 1, cpuOut: 1, pgOut: 1,
    lock: 1, scanres: 1, sensor: 1, sensorFlat: 0, warp: 1,
    shieldBoostAmt: 1, armorRepAmt: 1, repDur: 1,
  };
  const sensorAttr = { Gravimetric: 1027, Ladar: 1028, Magnetometric: 1029, Radar: 1030 }[_fitState.hull?.targeting?.sensorType];
  const sensorFlatAttr = { Gravimetric: 1567, Ladar: 1566, Magnetometric: 1568, Radar: 1565 }[_fitState.hull?.targeting?.sensorType];
  // Pass 1 — set-multiplier product per worn set (Omega is the big amplifier).
  const setProd = {};
  for (const imp of _fitState.implants) {
    const a = imp?.f?.attrs || {};
    for (const id of _FIT_SET_ATTRS) if (a[id]) setProd[id] = (setProd[id] || 1) * a[id];
  }
  for (const imp of _fitState.implants) {
    if (!imp?.f) continue;
    const a = imp.f.attrs || {};
    const effs = (imp.f.effects || []).join(' ').toLowerCase();
    // Set pieces: all their bonuses are scaled by the whole set's multiplier product.
    let setK = 1;
    for (const id of _FIT_SET_ATTRS) if (a[id] && setProd[id]) { setK = setProd[id]; break; }
    const p = (id) => 1 + ((a[id] || 0) * setK) / 100;
    // Drone tuners / 'Valdimar' drone implants: their damage applies to drones and
    // their hp/speed attrs must NEVER leak onto the ship.
    if (effs.includes('drone')) {
      if (a[292]) B.droneDmg *= p(292);
      continue;
    }
    if (a[292]) {                                        // damageMultiplierBonus
      if (effs.includes('missile')) {
        const sufM = effs.match(/dmgbonus(\w+)/);
        const frag = sufM ? _FIT_MSL_FRAG[sufM[1]] : null;
        if (frag) B.mslDmg.push({ frag, mult: p(292) }); // per-missile-type (Snapshot line)
      } else B.turretDmg *= p(292);                      // Gunnery-scoped (Lancer/Gunslinger)
    }
    if (a[441]) B.turretRof   *= p(441);                 // negative = faster
    // 294 doubles as EWAR-range on Centurion sets — only gunnery-scoped ones
    // (Sharpshooter line) touch turret optimal.
    if (a[294] && effs.includes('gunnery')) B.turretOpt *= p(294);
    if (a[349]) B.turretFall  *= p(349);
    if (a[767]) B.turretTrack *= p(767);
    if (a[293]) B.mslRof *= p(293);
    if (a[20] && effs.includes('missile')) B.mslVel *= p(20);   // 'Deadeye' Missile Projection
    if (a[547]) B.mslVel *= p(547);
    if (a[557]) B.mslFlight *= p(557);
    if (a[3030]) B.mslFlight *= p(3030);                 // Hydra pieces
    if (a[3015]) B.shieldHp *= p(3015);                  // Nirvana pieces
    if (a[337])  B.shieldHp *= p(337);
    if (a[335])  B.armorHp *= p(335);
    if (a[1083]) B.armorHp *= p(1083);
    if (a[327])  B.hullHp *= p(327);
    if (a[1079]) B.cap *= p(1079);
    if (a[314])  B.capTime *= p(314);                    // negative = faster recharge
    if (a[1076]) B.vel *= p(1076);
    if (a[315])  B.vel *= p(315);                        // Snake pieces (set-amplified via setK)
    if (a[2603]) B.vel *= p(2603);
    if (a[151])  B.agi *= p(151);                        // negative = more agile
    if (a[554])  B.sig *= p(554);                        // Halo: negative
    if (a[318])  B.propBoost *= p(318);                  // Zor's / Acceleration Control
    if (a[424])  B.cpuOut *= p(424);
    if (a[313])  B.pgOut *= p(313);
    if (a[309])  B.lock *= p(309);
    if (a[566])  B.scanres *= p(566);
    if (a[624])  B.warp *= p(624);
    if (sensorAttr && a[sensorAttr]) B.sensor *= p(sensorAttr);
    if (sensorFlatAttr && a[sensorFlatAttr]) B.sensorFlat += a[sensorFlatAttr] * setK;   // LG navy sets: flat points
    if (a[548])  B.shieldBoostAmt *= p(548);             // Crystal pieces (set-amplified)
    if (a[2457]) B.armorRepAmt *= p(2457);               // Asklepian pieces (set-amplified)
    if (a[806])  B.armorRepAmt *= p(806);                // 'Noble' repair-amount implants
    if (a[312])  B.repDur *= p(312);                     // 'Noble' RS — negative = faster reps
  }
  return B;
}
function _fitImplantCount() { return _fitState.implants.filter(Boolean).length; }

// ─── Command bursts (own + incoming links) ──────────────────────────────────────
// Burst charges carry warfareBuff IDs + base % (attrs 2468/2470/2472/2536 +
// 2596-2599). Buff semantics (verified against the SDE charge names):
//   10/13 shield/armor resists · 12/15 shield/armor HP · 11/14 booster/rep cycle
//   20 sig radius · 60 agility · 22 AB/MWD boost · 16 lock range · 26 scan res ·
//   18 sensor strength. Bursts NEVER stack — the strongest source per buff wins.
const FIT_BURST_FAMILY = { 1769: 'shield', 1774: 'armor', 1772: 'skirmish', 1773: 'info' };   // charge group → family
const FIT_BURST_SPEC   = { shield: FIT_SK.shieldSpec, armor: FIT_SK.armorSpec, skirmish: FIT_SK.skirmSpec, info: FIT_SK.infoSpec };
const FIT_BURST_CMDSK  = { shield: 3350, armor: 20494, skirmish: 3349, info: 20495 };         // command skills traits link
// Incoming-links "max boosts": T2 burst module (×1.25) · Specialist V (+50%) ·
// Command Ships V hull trait (+15%) · mindlink (+25%) = ×2.6953 on charge base.
const FIT_LINK_MAX = 1.25 * 1.5 * 1.15 * 1.25;
// Base buff % per family's charge set (SDE warfareBuff multipliers, T1-only charges).
const FIT_LINK_CHARGES = {
  shield:   { 10: 8, 11: 8, 12: 8 },
  armor:    { 13: 8, 14: 8, 15: 8 },
  skirmish: { 20: 6, 60: 6, 22: 12 },
  info:     { 16: 9, 26: 18, 18: 18 },
};
const FIT_LINK_LABELS = {
  off: 'None', shield: 'Shield (max)', armor: 'Armor (max)', skirmish: 'Skirmish (max)',
  info: 'Info (max)', shieldskirm: 'Shield + Skirmish (max)', armorskirm: 'Armor + Skirmish (max)', all: 'All (max)',
};
const FIT_LINK_FAMILIES = {
  off: [], shield: ['shield'], armor: ['armor'], skirmish: ['skirmish'], info: ['info'],
  shieldskirm: ['shield', 'skirmish'], armorskirm: ['armor', 'skirmish'],
  all: ['shield', 'armor', 'skirmish', 'info'],
};

// Fitted, running Command Burst modules with a charge → their buffs at OUR
// strength: module value (T1 ×1, T2 ×1.25) · Specialist skill (+10%/lvl) ·
// command-ship hull traits · a matching Mindlink implant (+25%).
function _fitOwnBursts() {
  const out = [];
  for (const m of _fitAllMods()) {
    if (m.f?.groupId !== 1770) continue;
    if (m.state !== 'active' && m.state !== 'overheated') continue;
    const cf = m.charge?.f;
    const family = cf ? FIT_BURST_FAMILY[cf.groupId] : null;
    if (!family) continue;
    let k = (m.f.attrs?.[2469] || 1) * (1 + 0.10 * _fitSkill(FIT_BURST_SPEC[family]));
    for (const rec of _fitTraitRecords()) {
      if (rec.q === 'burstStr' && rec.links.includes(FIT_BURST_CMDSK[family])) k *= 1 + (rec.pct * _fitTraitLvl(rec)) / 100;
    }
    for (const imp of _fitState.implants) {
      const ia = imp?.f?.attrs || {};
      // Mindlinks name their families via required Specialist skills.
      if (ia[884] && _fitRsSet(imp.f).has(FIT_BURST_SPEC[family])) k *= 1 + ia[884] / 100;
    }
    const buffs = {}, a = cf.attrs || {};
    for (const [idA, vA] of [[2468, 2596], [2470, 2597], [2472, 2598], [2536, 2599]]) {
      if (a[idA] && a[vA]) buffs[a[idA]] = Math.abs(a[vA]) * k;
    }
    out.push({ name: m.name, chargeName: m.charge.name, family, buffs });
  }
  return out;
}

// Combined buff map (buffID → strength %): incoming preset + own bursts,
// strongest single source per buff (in-game rule — bursts don't stack).
function _fitActiveBuffs() {
  const map = {};
  const take = (id, v) => { if (v > (map[id] || 0)) map[id] = v; };
  for (const fam of (FIT_LINK_FAMILIES[_fitState.links] || [])) {
    for (const [id, base] of Object.entries(FIT_LINK_CHARGES[fam])) take(Number(id), base * FIT_LINK_MAX);
  }
  for (const b of _fitOwnBursts()) {
    for (const [id, v] of Object.entries(b.buffs)) take(Number(id), v);
  }
  return map;
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
  const I = _fitImplantBonuses();
  return {
    cpu: (hull.output.cpu + cpuAdd) * _fitStackChain(cpuB) * _fitSkMult('cpuMgmt', 5) * I.cpuOut,
    pg:  (hull.output.pg  + pgAdd)  * _fitStackChain(pgB)  * _fitSkMult('pgMgmt', 5)  * I.pgOut,
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
  const I = _fitImplantBonuses();
  for (const g of groups.values()) {
    const { m, f, count, hot, kind } = g;
    const flavor = _fitWeaponFlavor(f.groupName);
    const rb  = _fitRangeBonuses(kind);
    const db  = _fitDamageBonuses(flavor);
    const c   = m.charge, cf = c?.f || {};
    // Hull-trait matching context: skills required by the weapon OR its charge
    // (traits link "Small Projectile Turret" for guns, missile-type skills for
    // launcher bonuses), plus the kind word for unlinked traits.
    const rsSet = _fitRsSet(f, cf);
    const kw = kind === 'missile' ? 'missile' : 'turret';

    // Rate of fire (ms): damage-mod chain + skills (Gunnery/Rapid Firing for
    // turrets, Missile Launcher Operation/Rapid Launch for launchers) + hull
    // traits ("5% bonus to … rate of fire" per level) + implants.
    let rof = (f.rof || 1) * _fitStackChain(db.rofM);
    rof *= kind === 'turret'
      ? _fitSkMult('gunnery', -2) * _fitSkMult('rapidFiring', -4) * I.turretRof
      : _fitSkMult('mlo', -2) * _fitSkMult('rapidLaunch', -3) * I.mslRof;
    for (const rec of _fitTraitRecords()) {
      if (rec.q === 'rof' && _fitTraitMatches(rec, rsSet, kw)) rof *= 1 - (rec.pct * _fitTraitLvl(rec)) / 100;
    }
    if (hot && kind === 'missile' && f.heat?.rofBonus) rof *= 1 + f.heat.rofBonus / 100;

    // Damage per shot: mods + heat + skills (Surgical Strike / Warhead Upgrades,
    // plus the weapon's/charge's own racial skill at +5%/lvl via requiredSkill1).
    // Hull traits can be damage-TYPE-scoped (Drake: kinetic only) so each
    // component carries its own multiplier.
    const d = (kind === 'missile' ? cf.dmg : c?.dmg) || c?.dmg;
    let perShot = 0, split = null;
    if (d) {
      const tm = { em: 1, th: 1, kin: 1, exp: 1 };
      for (const rec of _fitTraitRecords()) {
        if (rec.q !== 'dmg' || !_fitTraitMatches(rec, rsSet, kw)) continue;
        const k = 1 + (rec.pct * _fitTraitLvl(rec)) / 100;
        for (const t of (rec.dtypes.length ? rec.dtypes : _FIT_DT_ALL)) tm[t] *= k;
      }
      const comp = { em: (d.em || 0) * tm.em, th: (d.th || 0) * tm.th, kin: (d.kin || 0) * tm.kin, exp: (d.exp || 0) * tm.exp };
      perShot = comp.em + comp.th + comp.kin + comp.exp;
      if (perShot > 0) split = { em: comp.em / perShot, th: comp.th / perShot, kin: comp.kin / perShot, exp: comp.exp / perShot };
      if (kind === 'turret') perShot *= (f.dmgMult || 1);
      perShot *= _fitStackChain(db.dmg);
      // Racial 5%/lvl damage skill = the first required skill that isn't the
      // baseline operation skill (T2 items list Gunnery/MLO first, the racial
      // size/type skill second — T1 items list the racial skill first).
      if (kind === 'turret') {
        perShot *= _fitSkMult('surgical', 3) * I.turretDmg;
        const racial = [f.attrs?.[182], f.attrs?.[183], f.attrs?.[184]].find(id => id && id !== FIT_SK.gunnery) || 0;
        perShot *= 1 + 0.05 * _fitSkill(racial);
      } else {
        perShot *= _fitSkMult('warhead', 2);
        const racial = [cf.attrs?.[182], cf.attrs?.[183], cf.attrs?.[184]].find(id => id && id !== FIT_SK.mlo) || 0;
        perShot *= 1 + 0.05 * _fitSkill(racial);
        const grp = (cf.groupName || '').toLowerCase();
        for (const s of I.mslDmg) {   // per-missile-type implants (Snapshot line)
          if (grp.includes(s.frag) && (s.frag !== 'heavy missile' || !grp.includes('assault'))) perShot *= s.mult;
        }
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
        dps: dps * count, volley: perShot * count, split,
        optimal:  (f.optimal  || 0) * ammoOpt  * _fitStackChain(rb.opt)   * _fitSkMult('sharpshooter', 5)
                  * _fitTraitMult('optimal', rsSet, kw) * I.turretOpt,
        falloff:  (f.falloff  || 0) * ammoFall * _fitStackChain(rb.fall)  * _fitSkMult('trajectory', 5)
                  * _fitTraitMult('falloff', rsSet, kw) * I.turretFall,
        tracking: (f.tracking || 0) * _fitStackChain(rb.track)            * _fitSkMult('motion', 5)
                  * _fitTraitMult('tracking', rsSet, kw) * I.turretTrack,
      };
      entry.range = entry.optimal + entry.falloff;
    } else {
      const vel    = (cf.missileVel || 0) * _fitStackChain(rb.vel) * _fitSkMult('projection', 10)
                     * _fitTraitMult('mslVel', rsSet, kw) * I.mslVel;
      const flight = ((cf.flightMs || 0) / 1000) * _fitStackChain(rb.flight) * _fitSkMult('bombardment', 10)
                     * _fitTraitMult('mslFlight', rsSet, kw) * I.mslFlight;
      entry = {
        kind, flavor, count, hot, name: f.name, chargeName: c?.name || null,
        dps: dps * count, volley: perShot * count, split,
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
  const rows = _fitState.drones.filter(d => !_fitIsFighter(d)).map(d => {
    const a = d.f?.attrs || {};
    const perShot = ((a[114] || 0) + (a[118] || 0) + (a[117] || 0) + (a[116] || 0)) * (a[64] || 1);
    const dps = a[51] ? perShot / (a[51] / 1000) : 0;
    const stats = `${_fitNum(dps)} dps · ${_fitNum(a[37] || 0)} m/s · ${_fitKm(a[54] || 0)} + ${_fitKm(a[158] || 0)} · ${_fitNum(a[1272] || 0)} Mbit`;
    return `
      <div class="fw-db-row">
        <img src="https://images.evetech.net/types/${d.id}/icon?size=32" alt=""/>
        <div class="fw-db-main">
          <div class="fw-db-name">${_fitEsc(d.name)} <span class="fw-db-qty">×${d.qty}</span></div>
          <div class="fw-db-stats">${stats}</div>
        </div>
        <div class="fw-db-active" title="Active in space">
          <button class="fw-db-btn" data-dact="${d.id}:-1">−</button>
          <span class="${d.active ? 'on' : ''}">${d.active}</span>
          <button class="fw-db-btn" data-dact="${d.id}:1">＋</button>
        </div>
        <button class="fw-db-x" data-drm="${d.id}" title="Remove stack">✕</button>
      </div>`;
  }).join('');

  const effD = _fitEffDrone();
  return `
    <div class="fw-dronebay" id="fwDroneBay">
      <div class="fw-db-head">DRONE BAY<span>${_fitNum(_fitDroneUsedM3())} / ${_fitNum(effD.bay)} m³ · ${_fitNum(_fitDroneActiveBw())} / ${_fitNum(effD.bandwidth)} Mbit · ${_fitDroneActiveN()}/${_fitDroneCap()}</span></div>
      ${rows || `<div class="fw-db-empty">Drag drones here (Charges &amp; Drones tab), or click one in the browser.</div>`}
      <div class="fw-db-hint">Active drones add DPS &amp; a curve out to control range (${_fitKm(_fitDroneCtrlRange())}). Max in space: ${_fitDroneCap()} (Drones skill).</div>
    </div>`;
}


// Implants panel — 10 slots (implantness 1-10), with an inline implant search.
// Implants are character-level: they survive hull swaps and Clear, and are
// stored with fit snapshots. Attribute-only implants (+Perception etc.) socket
// fine but change no fitting stats.
function _fitImplantPanelHtml() {
  const rows = _fitState.implants.map((imp, i) => imp ? `
      <div class="fw-db-row">
        <span class="fw-imp-slotn">${i + 1}</span>
        <img src="https://images.evetech.net/types/${imp.id}/icon?size=32" alt=""/>
        <div class="fw-db-main"><div class="fw-db-name">${_fitEsc(imp.name)}</div></div>
        <button class="fw-db-x" data-imprm="${i}" title="Remove implant">✕</button>
      </div>` : `
      <div class="fw-db-row fw-imp-empty">
        <span class="fw-imp-slotn">${i + 1}</span>
        <div class="fw-db-main"><div class="fw-db-name">— empty —</div></div>
      </div>`).join('');
  return `
    <div class="fw-dronebay" id="fwImplants">
      <div class="fw-db-head">IMPLANTS<span>${_fitImplantCount()}/10</span></div>
      <div class="fw-imp-search">
        <input id="fwImpSearch" class="field-input" value="${_fitEsc(_fitState._impQ || '')}" placeholder="Search implants — e.g. Deadeye, Snake, Genolution…" autocomplete="off"/>
        <div id="fwImpResults" class="fw-imp-results"></div>
      </div>
      ${rows}
      <div class="fw-db-hint">Bonuses apply to DPS, tank, reps, cap, speed, fitting &amp; targeting — pirate SETS (Nirvana, Amulet, Snake, Crystal, Asklepian…) amplify each other, Omega included. ${_fitImplantCount() ? '<button id="fwImpClear" class="fw-imp-clear">Remove all</button>' : ''}</div>
    </div>`;
}

async function _fitAddImplant(typeId) {
  const facts = (await window.eveAPI.fitGetItems([typeId]).catch(() => ({})))[typeId];
  if (!facts) return;
  const slotN = facts.attrs?.[331];
  if (!slotN || slotN < 1 || slotN > 10) { _fitFlash('That item has no implant slot.'); return; }
  const prev = _fitState.implants[slotN - 1];
  _fitState.implants[slotN - 1] = { id: facts.id, name: facts.name, f: facts };
  _fitRenderAll();
  document.getElementById('fwImpSearch')?.focus();   // keep socketing from the same search
  _fitFlash(prev ? `Slot ${slotN}: ${prev.name} → ${facts.name}.` : `${facts.name} → slot ${slotN}.`);
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
  bays.innerHTML = `
    ${_fitState.droneBayOpen && effD.bay > 0 ? _fitDroneBayHtml(hull) : ''}
    ${_fitState.implantsOpen ? _fitImplantPanelHtml() : ''}
    <div class="fw-bays">
      <div class="fw-bay" title="Cargo hold capacity">
        <span class="material-symbols-outlined">inventory_2</span>${_fitNum(hull.cargo || 0)} m³
      </div>
      ${effD.bay > 0 ? `
        <div class="fw-bay fw-bay-drone ${_fitState.droneBayOpen ? 'open' : ''}" data-baychip="1"
             title="Drone bay — click to open. Drag drones here.">
          <span class="material-symbols-outlined">smart_toy</span>${_fitNum(_fitDroneUsedM3())} / ${_fitNum(effD.bay)} m³
        </div>` : ''}
      ${(hull.fighter?.tubes || 0) > 0 ? `
        <div class="fw-bay" title="Fighter bay — squadrons load into the launch-tube wedges below the wheel.">
          <span class="material-symbols-outlined">flight</span>${_fitNum(_fitFighterUsedM3())} / ${_fitNum(hull.fighter.bay)} m³
        </div>` : ''}
      <div class="fw-bay fw-bay-drone ${_fitState.implantsOpen ? 'open' : ''}" data-impchip="1"
           title="Implants (10 slots) — click to open. Bonuses feed the simulation.">
        <span class="material-symbols-outlined">neurology</span>${_fitImplantCount()}/10
      </div>
    </div>`;

  // Implants chip + panel events. The search only touches its own results box —
  // never a full re-render — so typing keeps focus.
  bays.querySelector('[data-impchip]')?.addEventListener('click', () => {
    _fitState.implantsOpen = !_fitState.implantsOpen;
    if (_fitState.implantsOpen) { _fitState.droneBayOpen = false; _fitState.fighterBayOpen = false; }   // one corner panel at a time
    _fitRenderCanvas();
    if (_fitState.implantsOpen) document.getElementById('fwImpSearch')?.focus();
  });
  const impPanel = bays.querySelector('#fwImplants');
  if (impPanel) {
    impPanel.querySelectorAll('[data-imprm]').forEach(b => b.addEventListener('click', () => {
      _fitState.implants[Number(b.dataset.imprm)] = null;
      _fitRenderAll();
    }));
    impPanel.querySelector('#fwImpClear')?.addEventListener('click', () => {
      _fitState.implants = new Array(10).fill(null);
      _fitRenderAll();
    });
    const inp = impPanel.querySelector('#fwImpSearch');
    const res = impPanel.querySelector('#fwImpResults');
    let impTimer = null;
    inp.addEventListener('input', () => {
      _fitState._impQ = inp.value;
      clearTimeout(impTimer);
      impTimer = setTimeout(async () => {
        const q = inp.value.trim();
        if (q.length < 2) { res.innerHTML = ''; return; }
        const hits = await window.eveAPI.fitSearch(q, 'implant', 30).catch(() => []);
        if (inp.value.trim() !== q) return;                      // stale response
        res.innerHTML = hits.length ? hits.map(h => `
            <div class="fit-result" data-impadd="${h.id}" title="Click to socket">
              <img src="https://images.evetech.net/types/${h.id}/icon?size=32" alt="" loading="lazy"/>
              <span class="fit-result-name">${_fitEsc(h.name)}</span>
            </div>`).join('')
          : `<div class="fit-hint" style="padding:6px;">No implants match.</div>`;
        res.querySelectorAll('[data-impadd]').forEach(r => r.addEventListener('click', () => _fitAddImplant(Number(r.dataset.impadd))));
      }, 220);
    });
    // Panel re-renders wipe the results box — restore the last search silently.
    if ((inp.value || '').trim().length >= 2) inp.dispatchEvent(new Event('input'));
  }

  bays.querySelectorAll('[data-baychip]').forEach(chipEl => {
    chipEl.addEventListener('click', () => {
      _fitState.droneBayOpen = !_fitState.droneBayOpen;
      if (_fitState.droneBayOpen) { _fitState.implantsOpen = false; _fitState.fighterBayOpen = false; }
      _fitRenderCanvas();
    });
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

  // Fighter LAUNCH TUBES — wedge cells hanging just below the bottom of the
  // ring (outside the band), one per tube, matching the slot-wedge look.
  const tubeCount = hull.fighter?.tubes || 0;
  if (tubeCount > 0) {
    const rT = FIT_WHEEL.slotR + 70;
    const half = 5 * (tubeCount - 1);
    const angles = _fitArcAngles({ from: 180 - half, to: 180 + half, spacing: 10 }, tubeCount);
    const capsTitle = [hull.fighter.light ? `${hull.fighter.light} light` : '',
      hull.fighter.support ? `${hull.fighter.support} support` : '',
      hull.fighter.heavy ? `${hull.fighter.heavy} heavy` : ''].filter(Boolean).join(' / ');
    angles.forEach((deg, i) => {
      const [x, y] = _fitPolar(deg, rT);
      const t = (_fitState.fighters || [])[i];
      const pos = `left:${x}px;top:${y}px;transform:translate(-50%,-50%) rotate(${deg.toFixed(1)}deg);`;
      const upright = `transform:rotate(${(-deg).toFixed(1)}deg);`;
      if (t) {
        const type = _fitFighterType(t.f) || 'light';
        const sqMax = t.f?.attrs?.[2215] || 1;
        cells += `
          <div class="fw-slot fw-tube ${t.active ? 'state-active' : 'state-offline'}" style="${pos}" data-tube="${i}"
               title="Tube ${i + 1} — ${_fitEsc(t.name)} ×${t.units}/${sqMax} (${type}${t.active ? ', launched' : ', held in bay'}) · ${_fitNum(_fitFighterTubeDps(t))} dps incl. salvo. Click to ${t.active ? 'hold' : 'launch'} · right-click for units.">
            <span class="fw-wedge"></span>
            <img class="fw-icon" style="${upright}" src="https://images.evetech.net/types/${t.id}/icon?size=64" alt="" draggable="false"/>
            <span class="fw-tube-units fw-tube-${type}" style="${upright}">${t.units}</span>
            <button class="fw-x" style="${upright}" data-tuberm="${i}" title="Clear tube">✕</button>
          </div>`;
      } else {
        cells += `
          <div class="fw-slot empty fw-tube" style="${pos}" data-tube="${i}"
               title="Empty launch tube ${i + 1} — drag a fighter here (${capsTitle} squadrons max)">
            <span class="fw-wedge"></span>
            <span class="material-symbols-outlined fw-tube-ico" style="${upright}">flight</span>
          </div>`;
      }
    });
  }
  // Tubes overflow the 720px wheel box (they hang below the ring). Reserve the
  // space with a MARGIN — changing the box height would shift every %-positioned
  // layer (porthole, ring svg, centre bars) down relative to the px-positioned
  // slot cells.
  wheel.style.height = '';
  wheel.style.marginBottom = tubeCount > 0 ? '90px' : '';

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

  // ── Tube interactions ── click = launch/hold, right-click = units menu,
  // drop a fighter = load/replace, ✕ = clear.
  wheel.querySelectorAll('.fw-tube').forEach(el => {
    const i = Number(el.dataset.tube);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.fw-x')) return;
      const t = _fitState.fighters[i];
      if (t) { t.active = !t.active; _fitRenderAll(); }
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); _fitShowTubeMenu(i, e.clientX, e.clientY); });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('fw-drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('fw-drop'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault(); el.classList.remove('fw-drop');
      const payload = e.dataTransfer.getData('text/plain') || '';
      if (!payload.startsWith('new:')) return;
      const id = Number(payload.slice(4));
      const facts = (await window.eveAPI.fitGetItems([id]).catch(() => ({})))[id];
      if (!facts) return;
      if (facts.categoryId !== 87) { _fitFlash('Only fighters go in launch tubes.'); return; }
      if (_fitState.fighters[i]) _fitState.fighters[i] = null;   // replace this tube's squadron
      _fitAddFighter(facts, i);
    });
  });
  wheel.querySelectorAll('[data-tuberm]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    _fitState.fighters[Number(btn.dataset.tuberm)] = null;
    _fitRenderAll();
  }));

  // ── Interactions ── (locked wedges are inert; tubes handled above)
  wheel.querySelectorAll('.fw-slot:not(.locked):not(.fw-tube)').forEach(el => {
    const slot = el.dataset.slot, idx = Number(el.dataset.idx);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.fw-x')) return;
      if (el.classList.contains('empty')) return;
      // Shift+click a fitted module → duplicate it (loaded charge included)
      // into the next free slot of the same rack.
      if (e.shiftKey) { _fitCloneSlot(slot, idx); return; }
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

// Right-click menu for a fighter launch tube: adjust squadron units, launch/hold, clear.
function _fitShowTubeMenu(i, x, y) {
  _fitCloseSlotMenu();
  const t = _fitState.fighters[i];
  const menu = document.createElement('div');
  menu.id = 'fitCtxMenu';
  if (!t) {
    menu.innerHTML = `<div class="fit-ctx-head">Empty launch tube ${i + 1}</div>
      <div class="fit-ctx-item" style="cursor:default;">Drag a fighter here from Charges &amp; Drones.</div>`;
  } else {
    const sqMax = t.f?.attrs?.[2215] || 1;
    menu.innerHTML = `
      <div class="fit-ctx-head">Tube ${i + 1} — ${_fitEsc(t.name)}</div>
      <button class="fit-ctx-item" data-act="minus">− unit (${t.units}/${sqMax})</button>
      <button class="fit-ctx-item" data-act="plus">＋ unit (${t.units}/${sqMax})</button>
      <button class="fit-ctx-item" data-act="toggle">${t.active ? 'Hold in bay (remove from DPS)' : 'Launch squadron'}</button>
      <button class="fit-ctx-item fit-ctx-danger" data-act="clear">✕ Clear tube</button>`;
  }
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  if (r.right  > window.innerWidth)  menu.style.left = Math.max(8, window.innerWidth  - r.width  - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top  = Math.max(8, window.innerHeight - r.height - 8) + 'px';
  menu.addEventListener('click', (e) => {
    e.stopPropagation();                     // keep the once-outside-click closer from eating the rebuilt menu
    const act = e.target.closest('[data-act]');
    if (!act || !t) return;
    if (act.dataset.act === 'minus')  { _fitTubeUnits(i, -1); _fitShowTubeMenu(i, x, y); return; }
    if (act.dataset.act === 'plus')   { _fitTubeUnits(i, +1); _fitShowTubeMenu(i, x, y); return; }
    _fitCloseSlotMenu();
    if (act.dataset.act === 'toggle') { t.active = !t.active; _fitRenderAll(); }
    if (act.dataset.act === 'clear')  { _fitState.fighters[i] = null; _fitRenderAll(); }
  });
  setTimeout(() => document.addEventListener('click', (e) => { if (!menu.contains(e.target)) _fitCloseSlotMenu(); }, { once: true }), 0);
}

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
  // Base stats vs command-burst-boosted stats: the base number is displayed and
  // the boost contribution rides along as a green "+x" (in-game style).
  const buffs = _fitActiveBuffs();
  const boosted = Object.keys(buffs).length > 0;
  const D  = _fitShipDerived();           // live: modules + states + heat applied
  const DB = boosted ? _fitShipDerived(buffs) : D;
  const cap = _fitCapSim(D);
  const gd = (base, up, fmt = _fitNum) => {
    const d = up - base;
    if (Math.abs(d) < (Math.abs(base) > 100 ? 0.5 : 0.05)) return '';
    return `<span class="fit-boost-delta">${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}</span>`;
  };
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
        : g.kind === 'fighter' ? (g.abilityRange ? `${_fitKm(g.abilityRange)} · on-grid` : 'on-grid') : `≈ ${_fitKm(g.range)}`}${(g.kind === 'drone' || g.kind === 'fighter') ? ` · ${_fitNum(g.vel)} m/s` : ''} · ${_fitNum(g.dps)} dps${g.kind === 'fighter' && g.name.endsWith('salvo') ? ` · ${_fitNum(g.volley)} volley` : ''}</span>
    </div>`).join('');

  // Drone/fighter bay summary card (bandwidth / tubes / control range / stacks).
  const droneBay   = _fitEffDrone().bay;
  const fighterBay = hull.fighter?.bay || 0;
  const droneRows = _fitState.drones.filter(d => !_fitIsFighter(d)).map(d => {
    const a = d.f?.attrs || {};
    const sim1 = sim.find(g => g.kind === 'drone' && g.name === d.name);
    return `<div class="fit-mini">
      <span>${d.active}/${d.qty}× ${_fitEsc(d.name)}</span>
      <span>${sim1 ? `${_fitNum(sim1.dps)} dps · ` : ''}${_fitNum(a[37] || 0)} m/s · ${_fitKm(a[54] || 0)}+${_fitKm(a[158] || 0)}</span>
    </div>`;
  }).join('');
  const fighterRows = (_fitState.fighters || []).map((t, i) => {
    if (!t) return '';
    const a = t.f?.attrs || {};
    const dps = t.active ? _fitFighterTubeDps(t) : 0;
    return `<div class="fit-mini">
      <span>Tube ${i + 1} · ${t.units}× ${_fitEsc(t.name)}${t.active ? '' : ' (in bay)'}</span>
      <span>${dps ? `${_fitNum(dps)} dps · ` : ''}${_fitNum(a[37] || 0)} m/s</span>
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
      : `<div class="fit-note-line">Fit weapons (and load charges) to simulate optimal, falloff and applied DPS vs range — including ammo, tracking mods, scripts, rigs, heat, hull bonuses and implants.</div>`}
    </div>

    <!-- Offense -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">crisis_alert</span> OFFENSE <span class="fit-note">${_fitEsc(_fitSkillLabel())}</span></div>
      <div class="fit-big">${_fitNum(off.dps)} <span class="fit-big-unit">dps</span></div>
      ${(() => {
        if (off.dps === 0) return `<div class="fit-note-line">Fit turrets/launchers, set them active, and load charges to see weapon DPS.</div>`;
        // Damage composition by type + by source.
        const byType = { em: 0, th: 0, kin: 0, exp: 0 };
        const bySrc  = { turret: 0, missile: 0, drone: 0, fighter: 0 };
        for (const g of sim) {
          bySrc[g.kind] = (bySrc[g.kind] || 0) + g.dps;
          const s = g.split || { em: 0.25, th: 0.25, kin: 0.25, exp: 0.25 };
          for (const t of ['em', 'th', 'kin', 'exp']) byType[t] += g.dps * s[t];
        }
        const tPct = (t) => Math.round((byType[t] / off.dps) * 100);
        const bar = `<div class="fit-dmg-bar">${['em', 'th', 'kin', 'exp']
          .filter(t => byType[t] > 0.5)
          .map(t => `<span class="fit-res-${t}" style="flex:${byType[t].toFixed(1)}" title="${t.toUpperCase()} ${tPct(t)}%"></span>`).join('')}</div>
          <div class="fit-dmg-legend">${[['em', 'EM'], ['th', 'Th'], ['kin', 'Kin'], ['exp', 'Exp']]
            .filter(([t]) => byType[t] > 0.5).map(([t, l]) => `${l} ${tPct(t)}%`).join(' · ')}</div>`;
        const srcLines = [['turret', 'Turrets'], ['missile', 'Launchers'], ['drone', 'Drones'], ['fighter', 'Fighters']]
          .filter(([k]) => bySrc[k] > 0.5)
          .map(([k, l]) => line(l, `${_fitNum(bySrc[k])} dps`)).join('');
        // Applied damage vs the chosen target's BASE resists, weighted by our
        // actual damage-type mix, per layer.
        const T = _fitState.target;
        let tgtHtml;
        if (T) {
          const appl = (res) => {
            let dps = 0, vol = 0;
            for (const g of sim) {
              const s = g.split || { em: 0.25, th: 0.25, kin: 0.25, exp: 0.25 };
              const f = (res.em ?? 1) * s.em + (res.th ?? 1) * s.th + (res.kin ?? 1) * s.kin + (res.exp ?? 1) * s.exp;
              dps += g.dps * f; vol += g.volley * f;
            }
            return { dps, vol };
          };
          const rows = [['shield', T.base.shieldRes], ['armor', T.base.armorRes], ['hull', T.base.hullRes]].map(([l, res]) => {
            const A = appl(res);
            return line(`vs ${l}`, `${_fitNum(A.dps)} dps · ${_fitNum(A.vol)} volley <span class="fit-note">(−${Math.round((1 - A.dps / off.dps) * 100)}%)</span>`);
          }).join('');
          tgtHtml = `
            ${line('Target', `${_fitEsc(T.name)} <button id="fitTgtClear" class="fit-tgt-clear" title="Clear target">✕</button>`)}
            ${rows}
            <div class="fit-note-line">Against the target's BASE resists (no modules/skills) — resist-weighted only, tracking/sig not applied.</div>`;
        } else {
          tgtHtml = `
            <input id="fitTgtSearch" class="field-input fit-tgt-search" placeholder="Apply vs target — search a hull…" autocomplete="off"/>
            <div id="fitTgtResults"></div>`;
        }
        return `${bar}${srcLines}${line('Volley', `${_fitNum(off.volley)} hp`)}${tgtHtml}`;
      })()}
    </div>

    <!-- Drones / fighters -->
    ${droneBay > 0 || fighterBay > 0 ? `<div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">${fighterBay ? 'flight' : 'smart_toy'}</span> ${fighterBay ? 'FIGHTERS' : 'DRONES'} ${droneBay && fighterBay ? '&amp; DRONES' : ''} <span class="fit-note">${fighterBay ? 'launch tubes' : _fitEsc(_fitSkillLabel())}</span></div>
      ${droneBay ? bar('Bandwidth', _fitDroneActiveBw(), _fitEffDrone().bandwidth, 'Mbit') : ''}
      <div class="fit-mini-grid">
        ${droneBay ? line('Drone bay', `${_fitNum(_fitDroneUsedM3())} / ${_fitNum(droneBay)} m³`) : ''}
        ${fighterBay ? line('Fighter bay', `${_fitNum(_fitFighterUsedM3())} / ${_fitNum(fighterBay)} m³`) : ''}
        ${fighterBay ? line('Launch tubes', `${(_fitState.fighters || []).filter(Boolean).length} / ${hull.fighter.tubes}`) : ''}
        ${fighterBay && hull.fighter.light   ? line('Light slots',   `${_fitFighterTypeCount('light')} / ${hull.fighter.light}`)     : ''}
        ${fighterBay && hull.fighter.support ? line('Support slots', `${_fitFighterTypeCount('support')} / ${hull.fighter.support}`) : ''}
        ${fighterBay && hull.fighter.heavy   ? line('Heavy slots',   `${_fitFighterTypeCount('heavy')} / ${hull.fighter.heavy}`)     : ''}
        ${droneBay ? line('Control range', _fitKm(_fitDroneCtrlRange())) : ''}
        ${droneBay ? line('In space', `${_fitDroneActiveN()} / ${_fitDroneCap()}`) : ''}
      </div>
      ${fighterRows}${droneRows}
      ${!fighterRows && !droneRows ? `<div class="fit-note-line">${fighterBay
        ? 'Load fighters into launch tubes (Charges &amp; Drones tab → drag onto the tubes chip, bottom-left of the wheel). Launched squadrons count toward DPS.'
        : 'Add drones from the Charges &amp; Drones tab — set them active in the bay (bottom-left of the wheel) to count toward DPS and the range chart.'}</div>` : ''}
    </div>` : ''}

    <!-- Capacitor -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">bolt</span> CAPACITOR <span class="fit-note">incl. modules, boosters &amp; implants</span></div>
      <div class="fit-cap">
        <svg viewBox="0 0 56 56" class="fit-cap-ring"><circle cx="28" cy="28" r="23" class="fit-cap-bg"/><circle cx="28" cy="28" r="23" class="fit-cap-fg"/></svg>
        <div class="fit-cap-info">
          <div class="fit-cap-gj">${_fitNum(D.capCap)} GJ</div>
          <div class="fit-cap-sub">${_fitNum(D.rechargeSec)} s recharge · peak +${_fitNum(D.peakRegen)} GJ/s</div>
          <div class="fit-cap-sub">use −${_fitNum(cap.drain)} GJ/s${cap.inject ? ` · inject +${_fitNum(cap.inject)} GJ/s` : ''}</div>
          <div class="fit-cap-stab ${cap.stable ? 'ok' : 'warn'}">${
            cap.drain === 0 ? 'No active cap use'
            : cap.stable ? `Stable at ${cap.stableAt}%`
            : `Lasts ${_fitDur(cap.lastsSec)}`}</div>
        </div>
      </div>
      ${cap.drain === 0 ? `<div class="fit-note-line">Set modules active (double-click) to simulate cap under load — guns, reps, prop mods and Cap Boosters (load charges) all count.</div>` : ''}
    </div>

    <!-- Defense -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">shield</span> DEFENSE <span class="fit-note">incl. modules, heat &amp; reps</span></div>
      <div class="fit-big">${_fitNum(D.ehp)}${gd(D.ehp, DB.ehp)} <span class="fit-big-unit">ehp</span></div>
      <div class="fit-res-head"><span></span>${['EM', 'Th', 'Kin', 'Exp'].map(x => `<span>${x}</span>`).join('')}</div>
      ${_fitLayerRow('Shield', D.shieldHp, DB.shieldRes, gd(D.shieldHp, DB.shieldHp),
        [DB.rep.boost ? `boost ${_fitNum(DB.rep.boost)} hp/s${gd(D.rep.boost, DB.rep.boost)}` : '',
         `regen ${_fitNum(DB.rep.passive)} hp/s peak${gd(D.rep.passive, DB.rep.passive)}`].filter(Boolean).join(' · '))}
      ${_fitLayerRow('Armor', D.armorHp, DB.armorRes, gd(D.armorHp, DB.armorHp),
        DB.rep.armor ? `rep ${_fitNum(DB.rep.armor)} hp/s${gd(D.rep.armor, DB.rep.armor)}` : '')}
      ${_fitLayerRow('Structure', D.structHp, D.hullRes, '',
        DB.rep.hull ? `rep ${_fitNum(DB.rep.hull)} hp/s` : '')}
    </div>

    <!-- Command bursts -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">podcasts</span> COMMAND BURSTS <span class="fit-note">strongest source wins</span></div>
      ${_fitOwnBursts().map(bb => line(`${_fitEsc(bb.name)}`, `${_fitEsc(bb.chargeName)}`)).join('')}
      ${line('Incoming links', FIT_LINK_LABELS[_fitState.links] || 'None')}
      ${!boosted ? `<div class="fit-note-line">Fit a Command Burst with a charge (set it active), or pick incoming links in the top bar — boosts appear as green + bonuses across the stats.</div>` : ''}
    </div>

    <!-- Targeting -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">my_location</span> TARGETING <span class="fit-note">incl. modules</span></div>
      ${line('Lock range', `${_fitNum(D.lockRange / 1000)} km${gd(D.lockRange / 1000, DB.lockRange / 1000)}`)}
      ${line('Scan res', `${_fitNum(D.scanRes)} mm${gd(D.scanRes, DB.scanRes)}`)}
      ${line(`${hull.targeting.sensorType} str`, `${_fitNum(D.sensorStrength)} pts${gd(D.sensorStrength, DB.sensorStrength)}`)}
      ${line('Max targets', `${D.maxTargets}`)}
    </div>

    <!-- Navigation -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">navigation</span> NAVIGATION <span class="fit-note">incl. modules</span></div>
      ${line('Max velocity', `${_fitNum(D.maxVel)} m/s${gd(D.maxVel, DB.maxVel)}`)}
      ${line('Align time', `${_fitNum(D.align)} s${gd(D.align, DB.align)}`)}
      ${line('Warp speed', `${_fitNum(D.warp)} AU/s`)}
      ${line('Mass', `${_fitNum(D.mass / 1000)} t`)}
      ${line('Sig radius', `${_fitNum(D.sig)} m${gd(D.sig, DB.sig)}`)}
    </div>`;

  const heat = el.querySelector('#fitHeatPreview');
  if (heat) heat.addEventListener('change', () => { _fitState.heatPreview = heat.checked; _fitRenderAll(); });

  // Target picker (Offense card) — search touches only its own results box.
  const tgtIn = el.querySelector('#fitTgtSearch');
  if (tgtIn) {
    const tRes = el.querySelector('#fitTgtResults');
    let tTimer = null;
    tgtIn.addEventListener('input', () => {
      clearTimeout(tTimer);
      tTimer = setTimeout(async () => {
        const q = tgtIn.value.trim();
        if (q.length < 2) { tRes.innerHTML = ''; return; }
        const hits = await window.eveAPI.fitSearch(q, 'ship', 12).catch(() => []);
        if (tgtIn.value.trim() !== q) return;
        tRes.innerHTML = hits.length ? hits.map(h => `
            <div class="fit-result" data-tgt="${h.id}">
              <img src="https://images.evetech.net/types/${h.id}/icon?size=32" alt="" loading="lazy"/>
              <span class="fit-result-name">${_fitEsc(h.name)}</span>
              <span class="fit-result-grp">${_fitEsc(h.groupName || '')}</span>
            </div>`).join('')
          : `<div class="fit-hint" style="padding:6px;">No hulls match.</div>`;
        tRes.querySelectorAll('[data-tgt]').forEach(r => r.addEventListener('click', () => _fitSetTarget(Number(r.dataset.tgt))));
      }, 220);
    });
  }
  el.querySelector('#fitTgtClear')?.addEventListener('click', () => { _fitState.target = null; _fitRenderStats(); });

  if (sim.length) requestAnimationFrame(() => _fitDrawRangeChart(sim));
}

// Load a hull as the applied-damage reference target (base resists only).
async function _fitSetTarget(typeId) {
  const hull = await window.eveAPI.fitGetHull(typeId).catch(() => null);
  if (!hull) { _fitFlash('Could not load that hull.'); return; }
  _fitState.target = { id: hull.id, name: hull.name, base: hull.base };
  _fitRenderStats();
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
function _fitLayerRow(label, hp, res, delta = '', sub = '') {
  return `<div class="fit-layer">
      <span class="fit-layer-name">${label}<span class="fit-layer-hp">${_fitNum(hp)}${delta}</span></span>
      ${_fitResistCells(res)}
    </div>${sub ? `<div class="fit-rep-line">${sub}</div>` : ''}`;
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
function _fitShipDerived(buffs = null) {
  const hull = _fitState.hull;
  const b = hull.base, nav = hull.nav, tgt = hull.targeting;
  // Command-burst buff fraction (0 when computing the unboosted baseline).
  const bf = (id) => (buffs && buffs[id] ? buffs[id] : 0) / 100;

  // Bonus chains (fractions, stacking-penalized) and flat adds.
  const chains = {};   // key → [fraction,…]
  const add = (key, frac) => { if (frac) (chains[key] || (chains[key] = [])).push(frac); };
  const flat = { shield: 0, armor: 0, cap: 0, mass: 0, sig: 0, targets: 0, vel: 0 };

  // Resonance-multiplier attr ids per layer/damage on MODULES. Shield/armor use
  // the ship-style ids (Damage Controls, Reactive Armor Hardeners carry those),
  // but module HULL bonuses live on 974-977 (hullEmDamageResonance…) — the
  // 113-family is kept for completeness. A DC II's 0.6 × the universal 0.67 hull
  // base ≈ the familiar 60% structure resist.
  const RES_IDS = {
    shield: { em: [271], th: [274], kin: [273], exp: [272] },
    armor:  { em: [267], th: [270], kin: [269], exp: [268] },
    hull:   { em: [113, 974], th: [110, 977], kin: [109, 976], exp: [111, 975] },
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
    // Extender/plate HP adds are scaled by module-HP hull traits ("+100% Shield
    // Extender hitpoints" role bonuses on Raven/Machariel/etc).
    if (a[796]) flat.mass += a[796];
    if (a[72])  flat.shield += a[72] * _fitModHpMult(m.f);
    if (a[983]) flat.sig += a[983];
    if (a[1159]) flat.armor += a[1159] * _fitModHpMult(m.f);
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
      for (const [d, idList] of Object.entries(ids)) {
        for (const id of idList) {
          if (a[id] != null && a[id] !== 1) add(`res:${ly}:${d}`, 1 - a[id]);
        }
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

  // Skills (Shield Management / Hull Upgrades / Mechanics +5%/lvl), hull-trait
  // HP bonuses ("15% bonus to armor hitpoints" per level) and HP implants.
  const I = _fitImplantBonuses();
  const shieldHp = (b.shieldHp + flat.shield) * mult('shieldMult') * _fitSkMult('shieldMgmt', 5)
                   * _fitTraitLayerMult('hp', 'shield') * I.shieldHp * (1 + bf(12));
  const armorHp  = (b.armorHp + flat.armor) * mult('armorMult')    * _fitSkMult('hullUp', 5)
                   * _fitTraitLayerMult('hp', 'armor') * I.armorHp * (1 + bf(15));
  const structHp = b.structureHp * mult('structMult')              * _fitSkMult('mechanics', 5)
                   * _fitTraitLayerMult('hp', 'struct') * I.hullHp;
  // Resonances: module chains (stacking-penalized), hull resist traits, then
  // Shield/Armor Harmonizing burst buffs (all plain multipliers).
  const buffRes = (res, frac) => {
    if (frac) for (const t of _FIT_DT_ALL) if (res[t] != null) res[t] *= 1 - frac;
    return res;
  };
  const shieldRes = buffRes(_fitTraitRes('shield', resOf('shield', b.shieldRes)), bf(10));
  const armorRes  = buffRes(_fitTraitRes('armor',  resOf('armor',  b.armorRes)), bf(13));
  const hullRes   = _fitTraitRes('hull',   resOf('hull',   b.hullRes));
  const ehp = _fitLayerEHP(shieldHp, shieldRes) + _fitLayerEHP(armorHp, armorRes) + _fitLayerEHP(structHp, hullRes);

  // Navigation: base × velocity mods × Navigation skill × hull velocity traits ×
  // implants, then active prop-mod thrust (v ×= 1 + sf% · thrust/mass; sf boosted
  // by Acceleration Control, AB/MWD hull traits and Zor's-style implants).
  const mass = (nav.mass || 0) + flat.mass;
  let maxVel = ((nav.maxVel || 0) + flat.vel) * mult('vel') * _fitSkMult('nav', 5)
               * _fitTraitMult('shipVel') * I.vel;
  let sigChain = chains['sig'] || [];
  const accelK = _fitSkMult('accel', 5);
  for (const m of _fitAllMods()) {
    const a = m.f?.attrs || {};
    if (!(a[20] && a[567])) continue;
    if (m.state !== 'active' && m.state !== 'overheated') continue;
    const propRs = _fitRsSet(m.f);
    let sf = a[20] * accelK * I.propBoost * _fitTraitMult('propBoost', propRs) * (1 + bf(22))
             * (m.state === 'overheated' && a[1223] ? 1 + a[1223] / 100 : 1);
    maxVel *= 1 + (sf / 100) * (a[567] / (mass || 1));
    if (a[554]) {
      // MWD signature bloom — hull traits can shrink the penalty (Cerberus −50%).
      let pen = a[554] / 100;
      for (const rec of _fitTraitRecords()) {
        if (rec.q === 'mwdSigPen' && _fitTraitMatches(rec, propRs, null)) pen *= 1 - (rec.pct * _fitTraitLvl(rec)) / 100;
      }
      sigChain.push(pen);
    }
  }
  chains['sig'] = sigChain;
  const agility = (nav.agility || 0) * mult('agi') * _fitSkMult('evasive', -5) * I.agi * (1 - bf(60));
  const sig = ((nav.sig || 0) + flat.sig) * mult('sig') * I.sig * (1 - bf(20));
  const align = (mass && agility) ? (Math.log(4) * agility * mass) / 1e6 : 0;

  const capCap = (b.capacitor + flat.cap) * mult('capMult') * _fitSkMult('capMgmt', 5)
                 * _fitTraitMult('cap') * I.cap;
  const rechargeSec = ((b.rechargeMs || 0) * mult('capTime') * _fitSkMult('capSys', -5)
                 * _fitTraitMult('capTime') * I.capTime) / 1000;
  const peakRegen = rechargeSec > 0 ? (2.5 * capCap) / rechargeSec : 0;

  // ── Repair rates (HP/s) ────────────────────────────────────────────────────
  // Active shield boost (boosters + ancillary), passive shield regen, active
  // armor reps (+ancillary ×paste), active hull reps. Heat speeds cycles
  // (attr 1206) AND pumps amounts (1231/1230); SBAs / Aux Nano Pumps stack-
  // penalize; hull rep-amount traits, implants, and Active Shielding / Rapid
  // Repair burst buffs (11/14, cycle-time cuts) all included.
  const rep = { boost: 0, passive: 0, armor: 0, hull: 0 };
  const sbaChain = [], armorAmpChain = [], boostDurChain = [], repDurChain = [];
  for (const m of _fitAllMods()) {
    if (m.state === 'offline') continue;
    const a = m.f?.attrs || {};
    if (a[548] && !a[68]) sbaChain.push(a[548] / 100);                 // Shield Boost Amplifier
    if (m._slot !== 'rig') continue;
    const g = (m.f?.groupName || '').toLowerCase();
    if (a[806]) armorAmpChain.push(a[806] / 100);                      // Aux Nano Pump
    if (a[312]) (g.includes('shield') ? boostDurChain : repDurChain).push(a[312] / 100);   // Solidifier / Nanobot Accelerator
  }
  for (const m of _fitAllMods()) {
    if (m.state !== 'active' && m.state !== 'overheated') continue;
    const a = m.f?.attrs || {};
    const hot = m.state === 'overheated';
    const heatDur = hot && a[1206] ? 1 + a[1206] / 100 : 1;            // −15% cycle when hot
    if (a[68] && a[73] && (m.f.groupId === 40 || m.f.groupId === 1156)) {
      const amt = a[68] * _fitStackChain(sbaChain) * _fitTraitMult('repAmount', _fitRsSet(m.f))
                  * I.shieldBoostAmt * (hot && a[1231] ? 1 + a[1231] / 100 : 1);
      const dur = a[73] * _fitStackChain(boostDurChain) * heatDur * (1 - bf(11));
      if (dur > 0) rep.boost += (amt / dur) * 1000;
    }
    if (a[84] && a[73] && (m.f.groupId === 62 || m.f.groupId === 1199)) {
      const paste = m.f.groupId === 1199 && m.charge && a[1886] ? a[1886] : 1;   // AAR ×3 with Nanite Paste
      const amt = a[84] * paste * _fitStackChain(armorAmpChain) * _fitTraitMult('repAmount', _fitRsSet(m.f))
                  * I.armorRepAmt * (hot && a[1230] ? 1 + a[1230] / 100 : 1);
      const dur = a[73] * _fitStackChain(repDurChain) * _fitSkMult('repSys', -5) * I.repDur * heatDur * (1 - bf(14));
      if (dur > 0) rep.armor += (amt / dur) * 1000;
    }
    if (a[83] && a[73] && m.f.groupId === 63) {
      const dur = a[73] * _fitSkMult('repSys', -5) * I.repDur * heatDur;
      if (dur > 0) rep.hull += (a[83] / dur) * 1000;
    }
  }
  // Passive shield regen — peak ≈ 2.5 × shield HP / recharge time. SPRs, flux
  // coils and purger rigs (attr 338, stack-penalized) + Shield Operation −5%/lvl.
  const srChain = [];
  for (const m of _fitAllMods()) {
    if (m.state !== 'offline' && m.f?.attrs?.[338]) srChain.push(m.f.attrs[338] / 100);
  }
  const shieldRechargeSec = ((b.shieldRechargeMs || 0) * _fitStackChain(srChain) * _fitSkMult('shieldOp', -5)) / 1000;
  rep.passive = shieldRechargeSec > 0 ? (2.5 * shieldHp) / shieldRechargeSec : 0;

  return {
    shieldHp, armorHp, structHp, shieldRes, armorRes, hullRes, ehp,
    mass, maxVel, agility, sig, align,
    warp: (nav.warpMult || 0) * _fitTraitMult('warp') * I.warp,
    capCap, rechargeSec, peakRegen,
    rep, shieldRechargeSec,
    lockRange: (tgt.lockRange || 0) * mult('lock') * _fitSkMult('lrt', 5) * I.lock * (1 + bf(16)),
    scanRes: (tgt.scanRes || 0) * mult('scanres')  * _fitSkMult('sigAn', 5) * I.scanres * (1 + bf(26)),
    sensorStrength: ((tgt.sensorStrength || 0) * mult('sensor') * I.sensor + I.sensorFlat) * (1 + bf(18)),
    maxTargets: (tgt.maxTargets || 0) + flat.targets,
  };
}

// ─── Capacitor simulation ────────────────────────────────────────────────────
// Active-module cap drain (weapons cycle on their rate of fire, everything else
// on duration — heat speeds both), Cap Booster injection from the loaded charge,
// then the EVE recharge curve dC/dt = (2·Cmax/τ)(√x − x), τ = rechargeTime/5:
// stable when peak regen covers the net drain (equilibrium at x = s², where
// s = (1+√(1−4k))/2 and k = net·τ / 2Cmax), otherwise integrate to empty.
function _fitCapSim(D) {
  let drain = 0, inject = 0;
  for (const m of _fitAllMods()) {
    if (m.state !== 'active' && m.state !== 'overheated') continue;
    const f = m.f || {}, a = f.attrs || {};
    const hot = m.state === 'overheated';
    let cyc = f.hardpoint ? (f.rof || 0) : (a[73] || 0);
    if (!cyc) continue;
    if (hot && a[1206]) cyc *= 1 + a[1206] / 100;
    // Cap Booster: injects its charge's capacitorBonus every cycle, cap-free.
    if (f.groupId === 76 && m.charge?.f?.attrs?.[67]) {
      inject += m.charge.f.attrs[67] / (cyc / 1000);
      continue;
    }
    let need = a[6] || 0;
    if (!need) continue;                                       // missiles, passives…
    if (f.hardpoint === 'turret') need *= _fitSkMult('ctrlBursts', -5);
    if (a[20] && a[567]) need *= _fitRsSet(f).has(FIT_SK.hsm) ? _fitSkMult('hsm', -5) : _fitSkMult('fuelCons', -10);
    if (f.groupId === 40 || f.groupId === 1156) need *= _fitSkMult('shieldComp', -2);
    if (f.groupId === 1156 && m.charge) need = 0;              // ASB runs cap-free on charges
    if (need) drain += need / (cyc / 1000);
  }
  const net = drain - inject;
  const out = { drain, inject, net };
  const Cmax = D.capCap, tau = (D.rechargeSec || 1) / 5;
  if (Cmax <= 0 || net <= 0) return { ...out, stable: true, stableAt: 100 };
  const k = (net * tau) / (2 * Cmax);
  if (k <= 0.25) {
    const s = (1 + Math.sqrt(1 - 4 * k)) / 2;
    return { ...out, stable: true, stableAt: Math.round(s * s * 100) };
  }
  let x = 1, t = 0;
  while (x > 0 && t < 7200) {
    x += ((2 / tau) * (Math.sqrt(x) - x) - net / Cmax) * 1;
    t += 1;
  }
  return { ...out, stable: false, lastsSec: t };
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
  const fighterTubes = (_fitState.fighters || []).filter(Boolean);
  if (_fitState.drones.length || fighterTubes.length) {
    lines.push('');
    for (const d of _fitState.drones) lines.push(`${d.name} x${d.qty}`);
    // Merge tubes of the same fighter into one EFT quantity line.
    const fq = new Map();
    for (const t of fighterTubes) fq.set(t.name, (fq.get(t.name) || 0) + t.units);
    for (const [n, q] of fq) lines.push(`${n} x${q}`);
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
  // Bays: drones → DroneBay flag 87, fighter tubes → FighterBay flag 158.
  for (const d of _fitState.drones) if (!_fitIsFighter(d)) items.push({ typeId: d.id, flag: 87, quantity: d.qty });
  for (const t of (_fitState.fighters || [])) if (t) items.push({ typeId: t.id, flag: 158, quantity: t.units });
  const fit = { name: _fitState.fitName || 'EVE Carbon Fit', description: 'Created in EVE Carbon', shipTypeId: _fitState.hull.id, items };
  _fitFlash('Saving to game…');
  const res = await window.eveAPI.fitSaveFitting(charId, fit).catch(e => ({ ok: false, error: e.message }));
  if (res.needsReauth) { _fitFlash('Re-authenticate this character to grant fittings write access.'); return; }
  _fitFlash(res.ok ? 'Saved to game — check Fittings in the EVE client.' : (res.error || 'Save failed.'));
}

// ─── Local fits — saved inside EVE Carbon, no ESI involved ────────────────────
// localStorage 'fitLocalFits': [{ id, name, hullId, hullName, racks, drones, saved }].
// racks/drones use the _fitPersist snapshot shape, so _fitApplySnapshot rebuilds
// them. They survive ESI outages and show under their hull in Hulls & Fits.
function _fitLocalFits() {
  try { const a = JSON.parse(localStorage.getItem('fitLocalFits') || '[]'); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}
function _fitLocalFitsStore(list) {
  try { localStorage.setItem('fitLocalFits', JSON.stringify(list)); } catch (_) {}
}

function _fitSaveLocal() {
  if (!_fitState.hull) { _fitFlash('Load a hull first.'); return; }
  const panel = document.getElementById('fitImportPanel');
  if (!panel) return;
  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="fit-import-title">Save this fit in EVE Carbon</div>
    <input id="fitLocalName" class="field-input" value="${_fitEsc(_fitState.fitName || '')}" placeholder="Fit name" autocomplete="off"/>
    <div class="fit-import-actions">
      <button id="fitLocalGo" class="fit-btn fit-btn-accent">Save</button>
      <button id="fitLocalCancel" class="fit-btn">Cancel</button>
    </div>`;
  const input = panel.querySelector('#fitLocalName');
  input.focus(); input.select();
  const doSave = () => {
    const name = input.value.trim() || `${_fitState.hull.name} Fit`;
    const racks = {};
    for (const key of Object.keys(_fitState.modules)) {
      racks[key] = _fitState.modules[key].map(m => m
        ? { id: m.id, state: m.state, c: m.charge ? { id: m.charge.id, name: m.charge.name } : null }
        : null);
    }
    const drones = _fitState.drones.map(d => ({ id: d.id, qty: d.qty, active: d.active }));
    const fighters = (_fitState.fighters || []).map(t => t ? { id: t.id, units: t.units, active: t.active ? 1 : 0 } : null);
    const implants = _fitState.implants.map(i => i ? { id: i.id, name: i.name } : null);
    const list = _fitLocalFits();
    const entry = {
      id: String(Date.now()), name, hullId: _fitState.hull.id, hullName: _fitState.hull.name,
      racks, drones, fighters, implants, saved: new Date().toISOString(),
    };
    // Saving under an existing name on the same hull overwrites that fit.
    const i = list.findIndex(f => f.hullId === entry.hullId && f.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) { entry.id = list[i].id; list[i] = entry; } else { list.push(entry); }
    _fitLocalFitsStore(list);
    _fitState.fitName = name;
    _fitPersist();
    panel.style.display = 'none';
    _fitRenderBrowser();                          // appears under its hull in Hulls & Fits
    _fitFlash(i >= 0 ? `Updated "${name}".` : `Saved "${name}".`);
  };
  panel.querySelector('#fitLocalCancel').addEventListener('click', () => { panel.style.display = 'none'; });
  panel.querySelector('#fitLocalGo').addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
}

async function _fitLoadLocalFit(id) {
  const f = _fitLocalFits().find(x => String(x.id) === String(id));
  if (!f) return;
  const ok = await _fitApplySnapshot({ hullId: f.hullId, fitName: f.name, racks: f.racks, drones: f.drones, fighters: f.fighters, implants: f.implants });
  _fitFlash(ok ? `Loaded "${f.name}".` : 'Could not rebuild this fit — hull missing from the SDE?');
}

function _fitDeleteLocalFit(id) {
  const list = _fitLocalFits();
  const f = list.find(x => String(x.id) === String(id));
  if (!f) return;
  if (!window.confirm(`Delete the saved fit "${f.name}"?`)) return;
  _fitLocalFitsStore(list.filter(x => String(x.id) !== String(id)));
  _fitRenderBrowser();
  _fitFlash(`Deleted "${f.name}".`);
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
function _fitDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
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
