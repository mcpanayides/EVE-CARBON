// ─── Fleet Commander · Fitting Simulator ──────────────────────────────────────
// Phase 1 foundation: pick a hull, fit modules/charges from a searchable panel,
// and get EXACT fitting-resource validation (CPU / Powergrid / slots / hardpoints)
// straight from the local SDE — plus EFT paste and game (ESI) import/export.
//
// Honesty note: DPS / EHP / capacitor require EVE's full dogma engine (skills,
// stacking penalties, ship bonuses, cap sim). Those are a phased follow-on and
// are shown as "engine in progress" rather than as wrong numbers. Everything
// labelled here as a number IS accurate.

const FIT_SLOTS = [
  { key: 'high', label: 'High Slots' },
  { key: 'med',  label: 'Mid Slots'  },
  { key: 'low',  label: 'Low Slots'  },
  { key: 'rig',  label: 'Rig Slots'  },
  { key: 'subsystem', label: 'Subsystems' },
];

// State is the single source of truth — render() is a pure function of it, so
// switching FC sub-tabs (which re-renders) never loses the in-progress fit.
const _fitState = {
  hull: null,                                  // { id,name,slots,hardpoints,output,base }
  fitName: 'EVE Carbon Fit',
  modules: { high: [], med: [], low: [], rig: [], subsystem: [] }, // {id,name,cpu,pg,hardpoint,charge?}
  selected: null,                              // { slot, idx } — module awaiting a charge
  searchKind: 'module',
  searchResults: [],
  gameFits: null,                              // cached ESI fits list while the picker is open
};
let _fitSearchTimer = null;

// ─── Entry point (called from navigateFcTab) ─────────────────────────────────
function renderFitting(mount) {
  mount.innerHTML = `
    <div class="fit-wrap">
      <!-- Left: item browser -->
      <div class="fit-browser">
        <div class="fit-kind-tabs">
          ${[['ship', 'Hulls'], ['module', 'Modules'], ['charge', 'Charges'], ['drone', 'Drones']]
            .map(([k, l]) => `<button class="fit-kind-btn ${k === _fitState.searchKind ? 'active' : ''}" data-kind="${k}">${l}</button>`).join('')}
        </div>
        <input id="fitSearch" class="field-input" placeholder="Search…" autocomplete="off"/>
        <div id="fitResults" class="fit-results"></div>
      </div>

      <!-- Center: the fit canvas -->
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
        <div id="fitSlots" class="fit-slots"></div>
        <div id="fitImportPanel" class="fit-import-panel" style="display:none;"></div>
      </div>

      <!-- Right: stats -->
      <div id="fitStats" class="fit-stats"></div>
    </div>`;

  // Browser events
  mount.querySelectorAll('.fit-kind-btn').forEach(btn => {
    btn.addEventListener('click', () => { _fitState.searchKind = btn.dataset.kind; _fitRenderKindTabs(); _fitDoSearch(); });
  });
  const search = mount.querySelector('#fitSearch');
  search.addEventListener('input', () => { clearTimeout(_fitSearchTimer); _fitSearchTimer = setTimeout(_fitDoSearch, 220); });

  // Result + slot clicks (delegated)
  mount.querySelector('#fitResults').addEventListener('click', (e) => {
    const row = e.target.closest('[data-typeid]');
    if (row) _fitPickResult(Number(row.dataset.typeid), row.dataset.name);
  });
  mount.querySelector('#fitSlots').addEventListener('click', _fitSlotClick);

  // Action buttons
  mount.querySelector('#fitClear').addEventListener('click', () => {
    _fitState.modules = { high: [], med: [], low: [], rig: [], subsystem: [] };
    _fitState.selected = null; _fitRenderCanvas(); _fitRenderStats();
  });
  mount.querySelector('#fitCopyEft').addEventListener('click', _fitCopyEFT);
  mount.querySelector('#fitImportEft').addEventListener('click', _fitShowEftPaste);
  mount.querySelector('#fitImportGame').addEventListener('click', _fitImportFromGame);
  mount.querySelector('#fitSaveGame').addEventListener('click', _fitSaveToGame);

  _fitPopulateChars();
  _fitDoSearch();
  _fitRenderCanvas();
  _fitRenderStats();
}

// ─── Item browser ─────────────────────────────────────────────────────────────
function _fitRenderKindTabs() {
  document.querySelectorAll('.fit-kind-btn').forEach(b => b.classList.toggle('active', b.dataset.kind === _fitState.searchKind));
}

async function _fitDoSearch() {
  const input = document.getElementById('fitSearch');
  const box   = document.getElementById('fitResults');
  if (!input || !box) return;
  const q = input.value.trim();
  if (q.length < 2) { box.innerHTML = `<div class="fit-hint">Type at least 2 characters…</div>`; return; }
  box.innerHTML = `<div class="fit-hint">Searching…</div>`;
  const results = await window.eveAPI.fitSearch(q, _fitState.searchKind, 80).catch(() => []);
  _fitState.searchResults = results;
  if (!results.length) { box.innerHTML = `<div class="fit-hint">No matches.</div>`; return; }
  box.innerHTML = results.map(r => `
    <div class="fit-result" data-typeid="${r.id}" data-name="${_fitEsc(r.name)}" title="${_fitEsc(r.name)}">
      <img src="https://images.evetech.net/types/${r.id}/icon?size=32" alt="" loading="lazy"/>
      <span class="fit-result-name">${_fitEsc(r.name)}</span>
      <span class="fit-result-grp">${_fitEsc(r.groupName || '')}</span>
    </div>`).join('');
}

async function _fitPickResult(typeId, name) {
  if (_fitState.searchKind === 'ship') return _fitLoadHull(typeId);
  if (_fitState.searchKind === 'charge') return _fitLoadCharge(typeId, name);
  // module / drone
  const facts = (await window.eveAPI.fitGetItems([typeId]).catch(() => ({})))[typeId];
  if (!facts) return;
  if (_fitState.searchKind === 'drone' || !facts.slot) { _fitFlash('Drones/cargo aren’t placed in slots yet (Phase 2).'); return; }
  _fitAddModule(facts);
}

// ─── Hull + modules ───────────────────────────────────────────────────────────
async function _fitLoadHull(typeId) {
  const hull = await window.eveAPI.fitGetHull(typeId).catch(() => null);
  if (!hull) { _fitFlash('Could not load that hull.'); return; }
  _fitState.hull = hull;
  _fitState.modules = { high: [], med: [], low: [], rig: [], subsystem: [] };
  _fitState.selected = null;
  _fitRenderCanvas();
  _fitRenderStats();
}

function _fitAddModule(facts) {
  if (!_fitState.hull) { _fitFlash('Pick a hull first.'); return; }
  const slot = facts.slot;
  const cap  = _fitState.hull.slots[slot] || 0;
  if ((_fitState.modules[slot] || []).length >= cap) { _fitFlash(`No free ${slot} slots.`); return; }
  _fitState.modules[slot].push(_fitMod(facts));
  _fitRenderCanvas();
  _fitRenderStats();
}

// Build a fitted-module record carrying everything stats need (incl. weapon dmg).
// State: activatable modules default to 'active' (running); passive to 'online'.
function _fitMod(facts) {
  const activatable  = !!facts.activatable;
  const overloadable = !!facts.overloadable;
  return { id: facts.id, name: facts.name, cpu: facts.cpu, pg: facts.pg, hardpoint: facts.hardpoint,
           dmgMult: facts.dmgMult, rof: facts.rof, charge: null,
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
  _fitRenderCanvas();
  _fitRenderStats();
}

async function _fitLoadCharge(typeId, name) {
  if (!_fitState.selected) { _fitFlash('Select a fitted module first, then click a charge.'); return; }
  const { slot, idx } = _fitState.selected;
  const mod = _fitState.modules[slot]?.[idx];
  if (!mod) { _fitState.selected = null; return; }
  const facts = (await window.eveAPI.fitGetItems([typeId]).catch(() => ({})))[typeId];
  mod.charge = { id: typeId, name, dmg: facts ? facts.dmg : null };
  _fitRenderCanvas();
  _fitRenderStats();
}

function _fitSlotClick(e) {
  const st = e.target.closest('[data-cyclestate]');
  if (st) {
    const [slot, idx] = st.dataset.cyclestate.split(':');
    _fitCycleState(slot, Number(idx));
    return;
  }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const [slot, idx] = rm.dataset.remove.split(':');
    _fitState.modules[slot].splice(Number(idx), 1);
    _fitState.selected = null;
    _fitRenderCanvas(); _fitRenderStats();
    return;
  }
  const chip = e.target.closest('[data-select]');
  if (chip) {
    const [slot, idx] = chip.dataset.select.split(':');
    const cur = _fitState.selected;
    _fitState.selected = (cur && cur.slot === slot && cur.idx === Number(idx)) ? null : { slot, idx: Number(idx) };
    _fitRenderCanvas();
  }
}

// ─── Renders ──────────────────────────────────────────────────────────────────
function _fitRenderCanvas() {
  const head  = document.getElementById('fitHullName');
  const slots = document.getElementById('fitSlots');
  if (!head || !slots) return;
  const hull = _fitState.hull;
  head.textContent = hull ? hull.name : 'No hull — pick one from Hulls';

  if (!hull) { slots.innerHTML = `<div class="fit-hint">Select a hull from the Hulls tab to start fitting.</div>`; return; }

  slots.innerHTML = FIT_SLOTS.filter(s => (hull.slots[s.key] || 0) > 0).map(s => {
    const fitted = _fitState.modules[s.key] || [];
    const cap    = hull.slots[s.key] || 0;
    const cells  = [];
    for (let i = 0; i < cap; i++) {
      const m = fitted[i];
      if (m) {
        const sel = _fitState.selected && _fitState.selected.slot === s.key && _fitState.selected.idx === i;
        cells.push(`
          <div class="fit-slot state-${m.state} ${sel ? 'sel' : ''}">
            <button class="fit-state-dot" data-cyclestate="${s.key}:${i}" title="${m.state} — click to change (offline / online${m.activatable ? ' / active' : ''}${m.overloadable ? ' / overheated' : ''})"></button>
            <button class="fit-slot-body" data-select="${s.key}:${i}" title="${_fitEsc(m.name)}${m.charge ? ' + ' + _fitEsc(m.charge.name) : ''}">
              <img src="https://images.evetech.net/types/${m.id}/icon?size=32" alt=""/>
              <span class="fit-slot-name">${_fitEsc(m.name)}${m.charge ? `<span class="fit-charge">↳ ${_fitEsc(m.charge.name)}</span>` : ''}</span>
            </button>
            <button class="fit-slot-x" data-remove="${s.key}:${i}" title="Remove">✕</button>
          </div>`);
      } else {
        cells.push(`<div class="fit-slot empty"><span class="fit-slot-empty">empty ${s.label.replace(' Slots', '').toLowerCase()}</span></div>`);
      }
    }
    return `<div class="fit-slot-group"><div class="fit-slot-group-label">${s.label} <span>${fitted.length}/${cap}</span></div>${cells.join('')}</div>`;
  }).join('');
}

function _fitRenderStats() {
  const el = document.getElementById('fitStats');
  if (!el) return;
  const hull = _fitState.hull;
  if (!hull) { el.innerHTML = `<div class="fit-hint">Stats appear once a hull is loaded.</div>`; return; }

  const u   = _fitComputeUsage();
  const off = _fitComputeOffense();
  const def = _fitComputeDefense();
  const cap = _fitCapDerived();
  const nav = _fitNavDerived();
  const t   = hull.targeting;

  const bar = (label, used, total, unit) => {
    const over = used > total + 1e-6;
    const pct  = total ? Math.min(100, (used / total) * 100) : 0;
    return `<div class="fit-stat-row ${over ? 'over' : ''}">
        <div class="fit-stat-top"><span>${label}</span><span>${_fitNum(used)} / ${_fitNum(total)} ${unit}</span></div>
        <div class="fit-bar"><div class="fit-bar-fill ${over ? 'over' : ''}" style="width:${pct}%;"></div></div>
      </div>`;
  };
  const line = (label, val) => `<div class="fit-mini"><span>${label}</span><span>${val}</span></div>`;

  el.innerHTML = `
    <!-- Fitting resources (exact) -->
    <div class="fit-stats-card">
      <div class="fit-stats-title">FITTING <span class="fit-note">exact</span></div>
      ${bar('CPU', u.cpu, hull.output.cpu, 'tf')}
      ${bar('Powergrid', u.pg, hull.output.pg, 'MW')}
      <div class="fit-mini-grid">
        ${line('Turrets', `<span class="${u.turret > hull.hardpoints.turret ? 'fit-over' : ''}">${u.turret}/${hull.hardpoints.turret}</span>`)}
        ${line('Launchers', `<span class="${u.launcher > hull.hardpoints.launcher ? 'fit-over' : ''}">${u.launcher}/${hull.hardpoints.launcher}</span>`)}
      </div>
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

    <!-- Offense -->
    <div class="fit-stats-card">
      <div class="fit-stats-title"><span class="material-symbols-outlined fit-sec-ico">crisis_alert</span> OFFENSE <span class="fit-note">base, pre-skill</span></div>
      <div class="fit-big">${_fitNum(off.dps)} <span class="fit-big-unit">dps</span></div>
      ${line('Volley', `${_fitNum(off.volley)} hp`)}
      ${off.dps === 0 ? `<div class="fit-note-line">Fit turrets/launchers and load charges to see weapon DPS.</div>` : ''}
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
}

// resist% from a resonance (lower resonance = more resist). null when absent.
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

// EHP for one layer against a uniform (25/25/25/25) damage profile.
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

function _fitComputeOffense() {
  let dps = 0, volley = 0;
  for (const slot of Object.keys(_fitState.modules)) {
    for (const m of _fitState.modules[slot]) {
      if (m.state !== 'active' && m.state !== 'overheated') continue;  // weapon must be running
      if (!m.rof || !m.charge || !m.charge.dmg) continue;
      const d = m.charge.dmg;
      const perShot = (m.dmgMult || 1) * (d.em + d.th + d.kin + d.exp);
      if (perShot <= 0) continue;
      dps += perShot / (m.rof / 1000);
      volley += perShot;
    }
  }
  return { dps, volley };
}

function _fitCapDerived() {
  const b = _fitState.hull.base;
  const rechargeSec = (b.rechargeMs || 0) / 1000;
  // Peak recharge (at ~25% cap) = 2.5 × capacity / rechargeTime.
  const peakRegen = rechargeSec > 0 ? (2.5 * b.capacitor) / rechargeSec : 0;
  return { rechargeSec, peakRegen };
}

function _fitNavDerived() {
  const n = _fitState.hull.nav;
  // align time = -ln(0.25) × inertia × mass / 1e6
  const align = (n.mass && n.agility) ? (Math.log(4) * n.agility * n.mass) / 1e6 : 0;
  return { maxVel: n.maxVel, align, warp: n.warpMult, massT: (n.mass || 0) / 1000, sig: n.sig };
}

function _fitComputeUsage() {
  let cpu = 0, pg = 0, turret = 0, launcher = 0;
  for (const key of Object.keys(_fitState.modules)) {
    for (const m of _fitState.modules[key]) {
      // Offline modules draw no CPU/PG. Hardpoints are physically occupied
      // regardless of state, so they're always counted.
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
      lines.push(m.charge ? `${m.name}, ${m.charge.name}` : m.name);
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
    if (!f || !f.slot) { skipped++; continue; }
    const cap = _fitState.hull.slots[f.slot] || 0;
    if ((_fitState.modules[f.slot] || []).length >= cap) { skipped++; continue; }
    const mod = _fitMod(f);
    if (chargeName && byName[chargeName.toLowerCase()]) {
      const cf = byName[chargeName.toLowerCase()];
      mod.charge = { id: cf.id, name: cf.name, dmg: cf.dmg };
    }
    _fitState.modules[f.slot].push(mod);
    placed++;
  }
  _fitState.fitName = fitName;
  _fitRenderCanvas(); _fitRenderStats();
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
  sel.addEventListener('change', () => localStorage.setItem('fit_char', sel.value));
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
  // Place modules (category 7) by their slot flag; attach charges (category 8) after.
  const charges = [];
  for (const it of fit.items) {
    const f = facts[it.typeId];
    if (!f) continue;
    if (f.categoryId === 8) { charges.push({ it, f }); continue; }
    const slot = _fitFlagToSlot(it.flag) || f.slot;
    if (!slot) continue;
    const cap = _fitState.hull.slots[slot] || 0;
    const qty = Math.min(it.quantity || 1, cap - (_fitState.modules[slot] || []).length);
    for (let n = 0; n < qty; n++) _fitState.modules[slot].push(_fitMod(f));
  }
  for (const { it, f } of charges) {
    const slot = _fitFlagToSlot(it.flag);
    const target = (_fitState.modules[slot] || []).find(m => !m.charge);
    if (target) target.charge = { id: f.id, name: f.name, dmg: f.dmg };
  }
  _fitState.fitName = fit.name || 'Imported Fit';
  _fitRenderCanvas(); _fitRenderStats();
  _fitFlash(`Loaded "${fit.name}".`);
}

async function _fitSaveToGame() {
  const sel = document.getElementById('fitCharSelect');
  const charId = sel ? sel.value : '';
  if (!charId) { _fitFlash('Pick a character first.'); return; }
  if (!_fitState.hull) { _fitFlash('Load a hull first.'); return; }

  // Build ESI items with slot flags (HiSlot0+, MedSlot0+, LoSlot0+, RigSlot0+).
  const base = { high: 27, med: 19, low: 11, rig: 92, subsystem: 125 };
  const items = [];
  for (const slot of Object.keys(base)) {
    (_fitState.modules[slot] || []).forEach((m, i) => {
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
function _fitFlash(msg) {
  const head = document.getElementById('fitHullName');
  if (!head) return;
  const old = head.dataset.flashOld || head.textContent;
  head.dataset.flashOld = _fitState.hull ? _fitState.hull.name : 'No hull — pick one from Hulls';
  head.textContent = msg;
  clearTimeout(_fitFlash._t);
  _fitFlash._t = setTimeout(() => { head.textContent = head.dataset.flashOld; }, 2600);
}
function _fitEsc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
