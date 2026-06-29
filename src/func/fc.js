// ─── Fleet Commander ──────────────────────────────────────────────────────────
// Sub-nav router (mirrors navigateIndustryTab) plus the first tool: a near
// real-time Fleet Composition Tracker. Add a tool by adding a .fc-sub-btn in
// pageLoader.js (fc template) and a branch in navigateFcTab() below.

let currentFcTab    = null;

// ── Fleet Composition state ──────────────────────────────────────────────────
const FC_POLL_MS = 6000;            // ESI caches /fleets/members for ~5s
let _fcShipRoles  = null;           // { [typeId]: {name, group_name, tactical_role} } — loaded once
let _fcPollTimer  = null;
let _fcBusy       = false;          // guards against overlapping poll cycles
let _fcTracking   = false;
let _fcCharId     = null;           // character authenticating as fleet boss
let _fcFleetId    = null;
let _fcDoctrine   = 'shield';
const _fcNameCache     = new Map(); // characterId -> name (resolved via ESI, cached)
const _fcTypeNameCache = new Map(); // shipTypeId  -> name (ESI fallback when the SDE lacks the hull)
const _fcExpanded  = new Set();     // expanded chip keys ("roleKey|typeId") — survives the 6s refresh

// ── Doctrine profiles ─────────────────────────────────────────────────────────
// Each doctrine decides: how ships bucket into role cards (by SDE group_id, with
// optional per-type overrides), which summary tiles show (each role with a `thr`
// gets a % + red/green/yellow zone), whether wrong-tank "false flags" apply
// (expectedTank), and what the fleet needs (checks). Add a doctrine by adding an
// entry here and an <option> in renderFleetComposition().

// Combat doctrines (shield/armor/capital) share these buckets + group mapping.
const FC_COMBAT_ROLES = [
  { key: 'Tackle',          label: 'Tackle & Screen', icon: 'my_location',       thr: { min: 5,  max: 10 } },
  { key: 'Logistics',       label: 'Logistics',       icon: 'health_and_safety', thr: { min: 10, max: 15 } },
  { key: 'Command Links',   label: 'Command Links',   icon: 'cell_tower' },
  { key: 'Capital Command', label: 'Capital Command', icon: 'military_tech' },
  { key: 'Capital Support', label: 'Capital Support', icon: 'rocket_launch' },
  { key: 'Other',           label: 'Other / DPS',     icon: 'bolt' },
];
const FC_COMBAT_GROUP_ROLES = {
  831:  'Tackle',           // Interceptor
  541:  'Tackle',           // Interdictor
  894:  'Tackle',           // Heavy Interdiction Cruiser
  832:  'Logistics',        // Logistics Cruiser
  1527: 'Logistics',        // Logistics Frigate
  540:  'Command Links',    // Command Ship
  1534: 'Command Links',    // Command Destroyer
  5120: 'Capital Command',  // Command Carrier
  4902: 'Capital Command',  // Expedition Command Ship
  1538: 'Capital Support',  // Force Auxiliary (FAX)
};

// Mining doctrine — miners + mining boosts; recons/bridgers fall under Other.
const FC_MINING_ROLES = [
  { key: 'Miners',        label: 'Miners',        icon: 'diamond' },
  { key: 'Mining Boosts', label: 'Mining Boosts', icon: 'cell_tower' },
  { key: 'Other',         label: 'Other',         icon: 'bolt' },
];
const FC_MINING_GROUP_ROLES = {
  463:  'Miners',          // Mining Barge (Procurer/Retriever/Covetor)
  543:  'Miners',          // Exhumer (Skiff/Mackinaw/Hulk)
  1283: 'Miners',          // Expedition Frigate (Prospect/Endurance)
  941:  'Mining Boosts',   // Industrial Command Ship (Orca/Porpoise)
  883:  'Mining Boosts',   // Capital Industrial Ship (Rorqual)
};
const FC_MINING_TYPE_ROLES = {
  32880: 'Miners',         // Venture — lives in the generic Frigate group, so map by type
};

const FC_DOCTRINES = {
  shield: {
    label: 'Shield', expectedTank: 'shield',
    roles: FC_COMBAT_ROLES, groupRoles: FC_COMBAT_GROUP_ROLES,
    checks: (c) => [{ label: 'Command Links present', ok: c['Command Links'] > 0, detail: `${c['Command Links']} link ship${c['Command Links'] === 1 ? '' : 's'}` }],
  },
  armor: {
    label: 'Armor', expectedTank: 'armor',
    roles: FC_COMBAT_ROLES, groupRoles: FC_COMBAT_GROUP_ROLES,
    checks: (c) => [{ label: 'Command Links present', ok: c['Command Links'] > 0, detail: `${c['Command Links']} link ship${c['Command Links'] === 1 ? '' : 's'}` }],
  },
  capital: {
    label: 'Capital / Titan', expectedTank: null,
    roles: FC_COMBAT_ROLES, groupRoles: FC_COMBAT_GROUP_ROLES,
    checks: (c) => [
      { label: 'Capital Command (Command Carrier)', ok: c['Capital Command'] > 0, detail: `${c['Capital Command']} command carrier${c['Capital Command'] === 1 ? '' : 's'}` },
      { label: 'Capital Support (FAX)',             ok: c['Capital Support'] > 0, detail: `${c['Capital Support']} FAX` },
    ],
  },
  mining: {
    label: 'Mining Fleet', expectedTank: null,
    roles: FC_MINING_ROLES, groupRoles: FC_MINING_GROUP_ROLES, typeRoles: FC_MINING_TYPE_ROLES,
    checks: (c) => [
      { label: 'Mining boosts present (Orca/Porpoise/Rorqual)', ok: c['Mining Boosts'] > 0, detail: `${c['Mining Boosts']} boost ship${c['Mining Boosts'] === 1 ? '' : 's'}` },
      { label: 'Miners present', ok: c['Miners'] > 0, detail: `${c['Miners']} miner${c['Miners'] === 1 ? '' : 's'}` },
    ],
  },
};

// ─── Sub-nav routing ──────────────────────────────────────────────────────────
function initFcPage() {
  document.querySelectorAll('.fc-sub-btn').forEach(btn => {
    // Replace-node trick (same as Industry) clears any stale listeners on re-entry.
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => navigateFcTab(fresh.dataset.fcTab));
  });
  const content = document.getElementById('fcTabContent');
  if (content && !content.querySelector(':scope > *')) navigateFcTab('composition');
}

function navigateFcTab(tab) {
  // Leaving the composition tab tears down the polling loop so it never runs in
  // the background against a hidden page.
  if (currentFcTab === 'composition' && tab !== 'composition') _fcStopTracking();
  currentFcTab = tab;

  document.querySelectorAll('.fc-sub-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fcTab === tab);
  });

  const mount = document.getElementById('fcTabContent');
  if (!mount) return;

  if (tab === 'composition') {
    renderFleetComposition(mount);
  } else if (tab === 'fitting') {
    if (typeof renderFitting === 'function') renderFitting(mount);
  }
}

// ─── Fleet Composition tool ───────────────────────────────────────────────────
async function renderFleetComposition(mount) {
  const lastChar     = localStorage.getItem('fc_char')     || '';
  const lastDoctrine = localStorage.getItem('fc_doctrine') || 'shield';
  _fcDoctrine = lastDoctrine;

  mount.innerHTML = `
    <div class="fc-comp" style="display:flex;flex-direction:column;height:100%;">
      <div class="fc-control-bar">
        <label class="fc-ctl">
          <span class="fc-ctl-label">FLEET BOSS</span>
          <select id="fcCharSelect" class="field-input" style="min-width:200px;">
            <option value="">Loading characters…</option>
          </select>
        </label>
        <label class="fc-ctl">
          <span class="fc-ctl-label">DOCTRINE</span>
          <select id="fcDoctrineSelect" class="field-input" style="width:150px;">
            <option value="shield">Shield</option>
            <option value="armor">Armor</option>
            <option value="capital">Capital / Titan</option>
            <option value="mining">Mining Fleet</option>
          </select>
        </label>
        <button id="fcTrackBtn" class="fc-track-btn">Start Tracking</button>
        <button id="fcInviteBtn" class="fc-track-btn fc-invite-btn"
                title="Invite all your other characters to this fleet (they must accept in-game)">Invite All Alts</button>
        <span id="fcStatus" class="fc-status">Idle</span>
      </div>
      <div id="fcResults" class="fc-results">
        <div class="fc-empty">Select your fleet-boss character and press <strong>Start Tracking</strong>.</div>
      </div>
    </div>`;

  // Populate character dropdown.
  const sel = document.getElementById('fcCharSelect');
  const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
  if (!accounts.length) {
    sel.innerHTML = `<option value="">No characters — add one in Characters</option>`;
  } else {
    sel.innerHTML = accounts.map(a =>
      `<option value="${a.characterId}">${_fcEsc(a.characterName)}</option>`).join('');
    if (lastChar && accounts.some(a => String(a.characterId) === String(lastChar))) sel.value = lastChar;
  }

  const docSel = document.getElementById('fcDoctrineSelect');
  docSel.value = lastDoctrine;
  docSel.addEventListener('change', () => {
    _fcDoctrine = docSel.value;
    localStorage.setItem('fc_doctrine', _fcDoctrine);
    if (_fcLastMembers) _fcRenderStats(_fcLastMembers);  // re-evaluate doctrine live
  });

  document.getElementById('fcTrackBtn').addEventListener('click', () => {
    if (_fcTracking) _fcStopTracking();
    else _fcStartTracking();
  });

  document.getElementById('fcInviteBtn').addEventListener('click', _fcInviteAllAlts);

  // Delegated click: expand/collapse a ship chip to reveal its pilots. Bound on
  // the persistent #fcResults container so it survives the per-poll re-render.
  document.getElementById('fcResults').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-key]');
    if (!chip) return;
    const key = chip.dataset.key;
    if (_fcExpanded.has(key)) _fcExpanded.delete(key);
    else _fcExpanded.add(key);
    if (_fcLastMembers) _fcRenderStats(_fcLastMembers);
  });
}

async function _fcStartTracking() {
  const sel = document.getElementById('fcCharSelect');
  _fcCharId = sel ? sel.value : '';
  if (!_fcCharId) { _fcSetStatus('Pick a character first.', 'warn'); return; }
  localStorage.setItem('fc_char', _fcCharId);

  // Load the SDE ship-role table once (cached for the session).
  if (!_fcShipRoles) {
    _fcSetStatus('Loading ship database…', '');
    _fcShipRoles = await window.eveAPI.fcGetShipRoles().catch(() => ({}));
    if (!_fcShipRoles || !Object.keys(_fcShipRoles).length) {
      _fcSetStatus('Ship database (SDE) unavailable — roles can’t be classified. Download the SDE in Settings.', 'warn');
      _fcShipRoles = {};
    }
  }

  _fcTracking = true;
  _fcFleetId  = null;
  _fcSetTrackBtn(true);
  await _fcPoll();                                  // immediate first cycle
  if (_fcTracking) _fcPollTimer = setInterval(_fcPoll, FC_POLL_MS);
}

function _fcStopTracking() {
  _fcTracking = false;
  if (_fcPollTimer) { clearInterval(_fcPollTimer); _fcPollTimer = null; }
  _fcSetTrackBtn(false);
  _fcSetStatus('Stopped.', '');
}

// Page-visibility hooks (called from navigateToPage). Leaving the fleet page
// PAUSES the poll loop but keeps _fcTracking + all your selections, so you don't
// spam ESI while away. Returning resumes the loop and immediately re-checks that
// the fleet is still up — your setup is exactly as you left it.
function _fcOnPageHidden() {
  if (_fcPollTimer) { clearInterval(_fcPollTimer); _fcPollTimer = null; }
}
function _fcOnPageShown() {
  if (_fcTracking && !_fcPollTimer) {
    _fcPoll();                                     // re-check the fleet right away
    _fcPollTimer = setInterval(_fcPoll, FC_POLL_MS);
  }
}

// Invite every other character on the account into the current fleet. Sends ESI
// invites the alts must accept in-game (it never force-joins them). Needs an
// active fleet (start tracking first) and the boss to hold write_fleet scope.
async function _fcInviteAllAlts() {
  if (!_fcCharId)  { _fcSetStatus('Start tracking as the fleet boss first.', 'warn'); return; }
  if (!_fcFleetId) { _fcSetStatus('No fleet detected yet — start tracking while in a fleet.', 'warn'); return; }

  const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
  const ids = accounts.map(a => a.characterId).filter(id => String(id) !== String(_fcCharId));
  if (!ids.length) { _fcSetStatus('No other characters to invite.', 'warn'); return; }

  const btn = document.getElementById('fcInviteBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Inviting…'; }
  _fcSetStatus(`Inviting ${ids.length} character${ids.length === 1 ? '' : 's'}…`, '');
  try {
    const res = await window.eveAPI.fcInviteCharacters(_fcCharId, _fcFleetId, ids);
    if (res.needsReauth) { _fcSetStatus('Re-authenticate the fleet boss to grant invite (write_fleet) access.', 'warn'); return; }
    if (!res.ok)         { _fcSetStatus(res.error || 'Invite failed.', 'warn'); return; }
    const ok   = res.results.filter(r => r.ok).length;
    const fail = res.results.length - ok;
    _fcSetStatus(
      `Invited ${ok} alt${ok === 1 ? '' : 's'}${fail ? `, ${fail} failed (offline / already in fleet)` : ''}. They must accept in-game.`,
      ok ? 'ok' : 'warn'
    );
  } catch (e) {
    _fcSetStatus(e.message || 'Invite failed.', 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Invite All Alts'; }
  }
}

let _fcLastMembers = null;

async function _fcPoll() {
  if (_fcBusy || !_fcTracking) return;
  _fcBusy = true;
  try {
    // Resolve the fleet id (cheap; also catches the fleet closing/reforming).
    const f = await window.eveAPI.fcGetCharacterFleet(_fcCharId);
    if (!_fcTracking) return;                       // stopped mid-await
    if (f.needsReauth) { _fcSetStatus('Re-authenticate this character to grant fleet access.', 'warn'); _fcStopTracking(); return; }
    if (!f.inFleet)    { _fcFleetId = null; _fcSetStatus('Character is not in a fleet.', 'warn'); _fcShowEmpty('Not in a fleet. Join one in-game, then keep tracking running.'); return; }
    _fcFleetId = f.fleetId;

    const res = await window.eveAPI.fcGetFleetMembers(_fcCharId, _fcFleetId);
    if (!_fcTracking) return;
    if (res.notBoss)   { _fcSetStatus('Only the fleet boss can read the roster.', 'warn'); _fcStopTracking(); return; }
    if (res.fleetGone) { _fcSetStatus('Fleet changed — re-checking…', ''); return; }
    if (!res.ok)       { _fcSetStatus(res.error || 'Failed to read roster.', 'warn'); return; }

    _fcLastMembers = res.members;
    await _fcResolveNames(res.members);             // fill pilot-name cache before render
    if (!_fcTracking) return;
    _fcRenderStats(res.members);
    _fcSetStatus(`Live · ${res.members.length} in fleet · updated ${new Date().toLocaleTimeString()}`, 'ok');
  } catch (e) {
    _fcSetStatus(e.message || 'Polling error.', 'warn');
  } finally {
    _fcBusy = false;
  }
}

// Resolve any unknown pilot names — and, as a safety net, any ship hull missing
// from the SDE map (e.g. a brand-new ship not yet in the downloaded SDE) — into
// caches so the render is synchronous. Pilots fall back to "Pilot {id}".
async function _fcResolveNames(members) {
  const charIds = [...new Set(members.map(m => m.characterId))].filter(id => id && !_fcNameCache.has(id));
  const typeIds = [...new Set(members.map(m => m.shipTypeId))]
    .filter(tid => tid && !_fcShipRoles[tid] && !_fcTypeNameCache.has(tid));
  const ids = [...charIds, ...typeIds];
  if (!ids.length) return;
  try {
    const arr = await window.eveAPI.getNames(ids);
    (arr || []).forEach(n => {
      if (!n || !n.id) return;
      if (charIds.includes(n.id)) _fcNameCache.set(n.id, n.name);
      else                        _fcTypeNameCache.set(n.id, n.name);
    });
  } catch (_) { /* keep fallbacks below */ }
  charIds.forEach(id => { if (!_fcNameCache.has(id)) _fcNameCache.set(id, 'Pilot ' + id); });
}

// ── Compliance matrix + render ────────────────────────────────────────────────
function _fcRenderStats(members) {
  const results = document.getElementById('fcResults');
  if (!results) return;

  const doctrine     = FC_DOCTRINES[_fcDoctrine] || FC_DOCTRINES.shield;
  const roleDefs     = doctrine.roles;
  const groupRoles   = doctrine.groupRoles || {};
  const typeRoles    = doctrine.typeRoles  || {};
  const expectedTank = doctrine.expectedTank;
  const validKeys    = new Set(roleDefs.map(d => d.key));
  const fleetSize    = members.length || 0;

  // Bucket members by role → ship type, tracking pilot ids. Role comes from the
  // active doctrine's group/type mapping (falls back to 'Other'). Tank
  // mismatches are flagged only for doctrines that declare an expected tank.
  const byRole = {};                 // roleKey -> { typeId -> { count, charIds[], outlier } }
  const outliers = {};               // typeId  -> { count, charIds[] }
  const counts = {}; roleDefs.forEach(d => { counts[d.key] = 0; });
  let outlierCount = 0;

  for (const m of members) {
    const ship = _fcShipRoles[m.shipTypeId] || null;
    const gid  = ship ? ship.group_id : null;
    let role = typeRoles[m.shipTypeId] || (gid != null ? groupRoles[gid] : null) || 'Other';
    if (!validKeys.has(role)) role = 'Other';
    const tank = ship ? ship.tank : null;
    const isOutlier = !!(expectedTank && tank && tank !== expectedTank);

    counts[role] = (counts[role] || 0) + 1;

    const bucket = (byRole[role] = byRole[role] || {});
    const entry  = (bucket[m.shipTypeId] = bucket[m.shipTypeId] || { count: 0, charIds: [], outlier: isOutlier });
    entry.count++; entry.charIds.push(m.characterId);

    if (isOutlier) {
      outlierCount++;
      const oe = (outliers[m.shipTypeId] = outliers[m.shipTypeId] || { count: 0, charIds: [] });
      oe.count++; oe.charIds.push(m.characterId);
    }
  }

  // ── Summary tiles ── Fleet Size + each non-Other role (% + zone when it has a
  // threshold) + Outliers (tank-checked doctrines only).
  const tiles = [_fcTile('Fleet Size', fleetSize, '', 'accent')];
  for (const d of roleDefs) {
    if (d.key === 'Other') continue;
    let sub = '', zone = '';
    if (d.thr) {
      const pct = fleetSize ? (counts[d.key] / fleetSize) * 100 : 0;
      sub = `${pct.toFixed(0)}%`; zone = _fcZone(pct, d.thr);
    }
    tiles.push(_fcTile(d.label, counts[d.key], sub, zone));
  }
  if (expectedTank) tiles.push(_fcTile('Outliers', outlierCount, 'wrong tank', outlierCount ? 'red' : ''));
  const summary = `<div class="fc-summary">${tiles.join('')}</div>`;

  // ── Outliers / false-flags card (tank-checked doctrines only) ──
  const outlierTypeIds = Object.keys(outliers);
  const outliersCard = (expectedTank && outlierTypeIds.length) ? `
    <div class="fc-card fc-outliers">
      <div class="fc-card-title fc-outliers-title">
        <span class="material-symbols-outlined">flag</span>
        FALSE FLAGS — WRONG TANK FOR ${_fcEsc(doctrine.label.toUpperCase())}
      </div>
      <div class="fc-chips">
        ${outlierTypeIds.sort((a, b) => outliers[b].count - outliers[a].count)
            .map(tid => _fcChip('outlier', tid, outliers[tid], true)).join('')}
      </div>
    </div>` : '';

  // ── Doctrine presence checks ──
  const checks = doctrine.checks ? doctrine.checks(counts) : [];
  const doctrineCard = `
    <div class="fc-card fc-doctrine">
      <div class="fc-card-title">DOCTRINE CHECK — ${_fcEsc(doctrine.label.toUpperCase())}</div>
      ${checks.length
        ? checks.map(c => `
          <div class="fc-check ${c.ok ? 'ok' : 'fail'}">
            <span class="material-symbols-outlined">${c.ok ? 'check_circle' : 'cancel'}</span>
            <span>${_fcEsc(c.label)}</span>
            <span class="fc-check-detail">${_fcEsc(c.detail)}</span>
          </div>`).join('')
        : '<div class="fc-check ok"><span class="material-symbols-outlined">check_circle</span><span>No special role requirements.</span></div>'}
    </div>`;

  // ── Role cards — only roles that actually have ships, each with ship chips ──
  const roleCards = roleDefs.filter(d => byRole[d.key]).map(d => {
    const bucket  = byRole[d.key];
    const typeIds = Object.keys(bucket).sort((a, b) => bucket[b].count - bucket[a].count);
    return `
      <div class="fc-card fc-role-card">
        <div class="fc-card-title">
          <span class="material-symbols-outlined fc-role-icon">${d.icon}</span>
          ${_fcEsc(d.label)} <span class="fc-role-count">${counts[d.key]}</span>
        </div>
        <div class="fc-chips">
          ${typeIds.map(tid => _fcChip(d.key, tid, bucket[tid], bucket[tid].outlier)).join('')}
        </div>
      </div>`;
  }).join('');

  results.innerHTML = summary + outliersCard + doctrineCard +
    `<div class="fc-role-grid">${roleCards}</div>`;
}

// Color zone: red below min, green in band, yellow above max (over-saturated).
function _fcZone(pct, thr) {
  if (pct < thr.min) return 'red';
  if (pct > thr.max) return 'yellow';
  return 'green';
}

// A summary tile. zone: 'accent' | 'red' | 'yellow' | 'green' | '' (neutral).
function _fcTile(label, value, sub, zone) {
  const cls = zone ? (zone === 'accent' ? 'fc-accent' : 'fc-' + zone) : '';
  return `
    <div class="fc-tile">
      <div class="fc-tile-label">${_fcEsc(label)}</div>
      <div class="fc-tile-value ${cls}">${value}</div>
      ${sub ? `<div class="fc-tile-sub">${_fcEsc(sub)}</div>` : '<div class="fc-tile-sub">&nbsp;</div>'}
    </div>`;
}

// A ship-type chip: one hull icon with a count badge (10 Guardians = one icon
// badged "10"). Clicking expands the pilot list. isOutlier adds the red flag.
function _fcChip(roleKey, typeId, entry, isOutlier) {
  const key  = roleKey + '|' + typeId;
  const open = _fcExpanded.has(key);
  const ship = _fcShipRoles[typeId];
  const name = ship ? ship.name : (_fcTypeNameCache.get(Number(typeId)) || ('Type ' + typeId));
  const pilots = open ? `
    <div class="fc-pilots">
      ${entry.charIds.map(id => `
        <div class="fc-pilot">
          <img src="https://images.evetech.net/characters/${id}/portrait?size=32" alt="" loading="lazy"/>
          <span>${_fcEsc(_fcNameCache.get(id) || ('Pilot ' + id))}</span>
        </div>`).join('')}
    </div>` : '';
  return `
    <div class="fc-chip-wrap">
      <button type="button" class="fc-chip ${isOutlier ? 'fc-chip-flag' : ''} ${open ? 'open' : ''}"
              data-key="${_fcEsc(key)}" title="${_fcEsc(name)} ×${entry.count} — click for pilots">
        <span class="fc-chip-icon">
          <img src="https://images.evetech.net/types/${typeId}/icon?size=64" alt="" loading="lazy"/>
          <span class="fc-chip-badge">${entry.count}</span>
        </span>
        <span class="fc-chip-name">${_fcEsc(name)}${isOutlier ? ' <span class="fc-flag">&#9873;</span>' : ''}</span>
      </button>
      ${pilots}
    </div>`;
}

// ── small helpers ─────────────────────────────────────────────────────────────
function _fcSetStatus(text, kind) {
  const el = document.getElementById('fcStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'fc-status' + (kind ? ' fc-status-' + kind : '');
}

function _fcSetTrackBtn(tracking) {
  const btn = document.getElementById('fcTrackBtn');
  if (!btn) return;
  btn.textContent = tracking ? 'Stop Tracking' : 'Start Tracking';
  btn.classList.toggle('active', tracking);
}

function _fcShowEmpty(msg) {
  const results = document.getElementById('fcResults');
  if (results) results.innerHTML = `<div class="fc-empty">${_fcEsc(msg)}</div>`;
}

function _fcEsc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
