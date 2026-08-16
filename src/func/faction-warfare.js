// ─── Faction Warfare tracker (top-level FW page) ────────────────────────────────
// Warzone control, militia stats, per-system plex/contested status, leaderboards
// and LP tiers. Almost everything is PUBLIC ESI (no scope needed):
//   /v1/fw/stats/         — per-faction kills, pilots, systems held, victory points
//   /v1/fw/systems/       — every FW system's owner/occupier/contested/VP state
//   /v1/fw/leaderboards/… — top pilots & corps by kills and victory points
// Only "My Militia" needs esi-characters.read_fw_stats.v1 (get-character-fw-stats).
//
// Public data is fetched through esiFetch and cached in-module; the page auto-
// refreshes on the endpoints' own cadence — no manual sync button.

// URLs come from the one ESI client (window.Esi, src/shared/esi.js) rather
// than a private copy of the base. This file used to hold its own, which is
// how its four routes stayed on /vN/ long after the rest of the app moved.

// The four militias, grouped into their two warzones. Colours are ours (no ESI
// colour exists) and echo each faction's identity.
const FW_FACTIONS = {
  500001: { name: 'Caldari State',       short: 'Caldari',  color: '#4a8fd6', enemy: 500004 },
  500004: { name: 'Gallente Federation', short: 'Gallente', color: '#48b58a', enemy: 500001 },
  500003: { name: 'Amarr Empire',        short: 'Amarr',    color: '#d6b24a', enemy: 500002 },
  500002: { name: 'Minmatar Republic',   short: 'Minmatar', color: '#d66a4a', enemy: 500003 },
};
const FW_WARZONES = [
  { key: 'cal-gal', name: 'Caldari–Gallente Warzone', factions: [500001, 500004] },
  { key: 'ama-min', name: 'Amarr–Minmatar Warzone',   factions: [500003, 500002] },
];

// Warzone-control tier (1–5) from the share of the warzone a militia occupies, and
// the LP-payout multiplier each tier grants. Thresholds/multipliers follow the
// standard FW control scale and are labelled as reference in the UI — CCP tunes the
// exact numbers, but the control % and system counts we show are live from ESI.
const FW_LP_MULT = { 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5, 5: 3.0 };
function _fwTier(pct) {
  if (pct >= 0.90) return 5;
  if (pct >= 0.75) return 4;
  if (pct >= 0.60) return 3;
  if (pct >= 0.45) return 2;
  return 1;
}

// Plex tiers — ship-size restrictions are stable game facts. Base LP is a labelled
// reference (scaled by warzone-control tier in the LP view).
const FW_PLEXES = [
  { name: 'Novice',  ships: 'Frigates (T1/T2/faction) & below',    baseLp: 5000  },
  { name: 'Small',   ships: 'Destroyers & below',                  baseLp: 7500  },
  { name: 'Medium',  ships: 'Cruisers & below',                    baseLp: 10000 },
  { name: 'Large',   ships: 'Battlecruisers & below',              baseLp: 15000 },
];
const FW_CONTESTED = {
  uncontested: { label: 'Stable',     cls: 'fw-c-stable' },
  contested:   { label: 'Contested',  cls: 'fw-c-contested' },
  vulnerable:  { label: 'Vulnerable', cls: 'fw-c-vuln' },
  captured:    { label: 'Captured',   cls: 'fw-c-cap' },
};

let _fwTab      = 'overview';
let _fwStats    = null;   // [{ faction_id, kills, pilots, systems_controlled, victory_points }]
let _fwSystems  = null;   // [{ solar_system_id, owner_faction_id, occupier_faction_id, contested, victory_points, victory_points_threshold }]
let _fwLbChars  = null;
let _fwLbCorps  = null;
let _fwNames    = {};     // id → name (systems, chars, corps)
let _fwFetchedAt = 0;
let _fwMilitiaChar = null;
let _fwSysWarzone  = 'all';
let _fwSysContestedOnly = false;
let _fwLbMode = 'kills';   // 'kills' | 'victory_points'
let _fwLbWindow = 'active_total'; // 'yesterday' | 'active_total'
let _fwRefreshTimer = null;

function initFactionWarfarePage() {
  document.querySelectorAll('.fw-sub-btn').forEach(btn => {
    btn.onclick = () => { const t = btn.dataset.fwTab; if (t) navigateFwTab(t); };
  });
  navigateFwTab(_fwTab || 'overview');
  _fwStartAutoRefresh();
}

function navigateFwTab(tab) {
  _fwTab = tab;
  document.querySelectorAll('.fw-sub-btn').forEach(b => b.classList.toggle('active', b.dataset.fwTab === tab));
  const host = document.getElementById('fwTabContent');
  if (!host) return;
  if (tab === 'militia')      return _fwRenderMilitia(host);
  if (tab === 'systems')      return _fwRenderSystems(host);
  if (tab === 'leaderboards') return _fwRenderLeaderboards(host);
  if (tab === 'lp')           return _fwRenderLp(host);
  return _fwRenderOverview(host);
}

// FW public data caches ~30 min server-side; refresh the in-memory copy on that
// cadence while the page is open (self-clearing when navigated away).
function _fwStartAutoRefresh() {
  if (_fwRefreshTimer) clearInterval(_fwRefreshTimer);
  _fwRefreshTimer = setInterval(async () => {
    if (!document.getElementById('page-fw')) { clearInterval(_fwRefreshTimer); _fwRefreshTimer = null; return; }
    _fwFetchedAt = 0;                     // force a re-pull
    await _fwEnsurePublic(true);
    if (document.getElementById('fwTabContent') && _fwTab !== 'militia') navigateFwTab(_fwTab);
  }, 30 * 60 * 1000);
}

// Pull the public datasets once (cached 5 min in-module; ESI caches longer still).
async function _fwEnsurePublic(force) {
  if (!force && _fwStats && (Date.now() - _fwFetchedAt) < 5 * 60 * 1000) return;
  const get = async (path) => {
    try { return await window.eveAPI.esiFetch(Esi.url(path)); }
    catch (_) { return null; }
  };
  const [stats, systems, lbC, lbP] = await Promise.all([
    get('/fw/stats'), get('/fw/systems'),
    get('/fw/leaderboards/characters'), get('/fw/leaderboards/corporations'),
  ]);
  if (Array.isArray(stats))   _fwStats   = stats;
  if (Array.isArray(systems)) _fwSystems = systems;
  _fwLbChars = lbC || _fwLbChars;
  _fwLbCorps = lbP || _fwLbCorps;
  _fwFetchedAt = Date.now();

  // Resolve names for systems + leaderboard ids in one batch.
  const ids = new Set();
  (_fwSystems || []).forEach(s => ids.add(s.solar_system_id));
  for (const lb of [_fwLbChars, _fwLbCorps]) {
    if (!lb) continue;
    ['kills', 'victory_points'].forEach(m => ['yesterday', 'active_total', 'last_week'].forEach(w => {
      (lb[m] && lb[m][w] || []).forEach(e => ids.add(e.character_id || e.corporation_id));
    }));
  }
  const list = [...ids].filter(Boolean);
  if (list.length) {
    try {
      const arr = await window.eveAPI.getNames(list);
      if (Array.isArray(arr)) arr.forEach(n => { if (n && n.id) _fwNames[n.id] = n.name; });
    } catch (_) {}
  }
}

function _fwName(id) { return _fwNames[id] || `#${id}`; }
function _fwLoading(host, label) { host.innerHTML = `<div class="fin-empty">${escHtml(label || 'Loading Faction Warfare data…')}</div>`; }

// Per-warzone control numbers derived from /fw/stats systems_controlled.
function _fwWarzoneControl(wz) {
  const s = {};
  (_fwStats || []).forEach(x => { s[x.faction_id] = x; });
  const [a, b] = wz.factions;
  const ca = (s[a] && s[a].systems_controlled) || 0;
  const cb = (s[b] && s[b].systems_controlled) || 0;
  const total = ca + cb || 1;
  return {
    total, a, b, statA: s[a] || {}, statB: s[b] || {},
    ctrlA: ca, ctrlB: cb, pctA: ca / total, pctB: cb / total,
    tierA: _fwTier(ca / total), tierB: _fwTier(cb / total),
  };
}

// ── View 1: Warzone Control (faction overview) ──────────────────────────────────
async function _fwRenderOverview(host) {
  _fwLoading(host);
  await _fwEnsurePublic();
  if (_fwTab !== 'overview') return;   // user switched tabs during the fetch — don't clobber
  if (!_fwStats) { host.innerHTML = '<div class="fin-empty">Couldn’t reach ESI for Faction Warfare stats. It refreshes automatically.</div>'; return; }

  const blocks = FW_WARZONES.map(wz => {
    const c = _fwWarzoneControl(wz);
    const fa = FW_FACTIONS[c.a], fb = FW_FACTIONS[c.b];
    const card = (fid, stat, ctrl, pct, tier) => {
      const f = FW_FACTIONS[fid];
      return `
        <div class="fw-fac-card" style="border-top:3px solid ${f.color};">
          <div class="fw-fac-head"><img class="fw-fac-logo" src="https://images.evetech.net/corporations/${fid}/logo?size=64" alt="" onerror="this.style.visibility='hidden'"><div>
            <div class="fw-fac-name" style="color:${f.color};">${escHtml(f.name)}</div>
            <div class="fw-fac-sub">Tier ${tier} · ×${FW_LP_MULT[tier].toFixed(1)} LP</div>
          </div></div>
          <div class="fw-fac-grid">
            <div><span class="fw-k">Systems held</span><span class="fw-v">${ctrl} <span class="lp-dim">(${(pct * 100).toFixed(0)}%)</span></span></div>
            <div><span class="fw-k">Pilots</span><span class="fw-v">${formatNumber(stat.pilots || 0)}</span></div>
            <div><span class="fw-k">Kills (24h)</span><span class="fw-v">${formatNumber((stat.kills || {}).yesterday || 0)}</span></div>
            <div><span class="fw-k">Kills (total)</span><span class="fw-v">${formatNumber((stat.kills || {}).total || 0)}</span></div>
            <div><span class="fw-k">VP (24h)</span><span class="fw-v">${formatNumber((stat.victory_points || {}).yesterday || 0)}</span></div>
            <div><span class="fw-k">VP (total)</span><span class="fw-v">${formatNumber((stat.victory_points || {}).total || 0)}</span></div>
          </div>
        </div>`;
    };
    return `
      <div class="fw-wz">
        <div class="fw-wz-title">${escHtml(wz.name)}</div>
        <div class="fw-ctrl-bar" title="${fa.short} ${(c.pctA * 100).toFixed(0)}% · ${fb.short} ${(c.pctB * 100).toFixed(0)}%">
          <div class="fw-ctrl-seg" style="width:${(c.pctA * 100).toFixed(1)}%;background:${fa.color};">${(c.pctA * 100).toFixed(0)}%</div>
          <div class="fw-ctrl-seg" style="width:${(c.pctB * 100).toFixed(1)}%;background:${fb.color};">${(c.pctB * 100).toFixed(0)}%</div>
        </div>
        <div class="fw-fac-row">${card(c.a, c.statA, c.ctrlA, c.pctA, c.tierA)}${card(c.b, c.statB, c.ctrlB, c.pctB, c.tierB)}</div>
      </div>`;
  }).join('');

  host.innerHTML = `
    <div class="fin-tab-fill fw-scroll">
      ${blocks}
      <div class="lp-note">Systems held, pilots, kills and victory points are live from ESI (<code>/fw/stats/</code>).
        The control tier and its LP multiplier follow the standard FW control scale — see LP &amp; Tiers.</div>
    </div>`;
}

// ── View 2: Systems & Plexes ────────────────────────────────────────────────────
async function _fwRenderSystems(host) {
  _fwLoading(host);
  await _fwEnsurePublic();
  if (_fwTab !== 'systems') return;   // tab changed mid-fetch
  const systems = _fwSystems || [];
  if (!systems.length) { host.innerHTML = '<div class="fin-empty">No Faction Warfare systems returned by ESI.</div>'; return; }

  const inWz = (s) => {
    if (_fwSysWarzone === 'all') return true;
    const wz = FW_WARZONES.find(w => w.key === _fwSysWarzone);
    return wz && (wz.factions.includes(s.owner_faction_id) || wz.factions.includes(s.occupier_faction_id));
  };
  let rows = systems.filter(inWz).filter(s => !_fwSysContestedOnly || (s.contested && s.contested !== 'uncontested'));
  // Most-contested first, then by VP progress.
  const rank = { vulnerable: 0, contested: 1, captured: 2, uncontested: 3 };
  rows.sort((a, b) => (rank[a.contested] ?? 4) - (rank[b.contested] ?? 4)
    || ((b.victory_points || 0) / (b.victory_points_threshold || 1)) - ((a.victory_points || 0) / (a.victory_points_threshold || 1)));

  const wzOpts = [`<option value="all"${_fwSysWarzone === 'all' ? ' selected' : ''}>All warzones</option>`]
    .concat(FW_WARZONES.map(w => `<option value="${w.key}"${_fwSysWarzone === w.key ? ' selected' : ''}>${escHtml(w.name)}</option>`)).join('');

  const body = rows.map(s => {
    const owner = FW_FACTIONS[s.owner_faction_id], occ = FW_FACTIONS[s.occupier_faction_id];
    const cst = FW_CONTESTED[s.contested] || { label: s.contested || '—', cls: 'lp-dim' };
    const vp = s.victory_points || 0, vpt = s.victory_points_threshold || 0;
    const pct = vpt > 0 ? Math.min(100, (vp / vpt) * 100) : 0;
    const flipped = occ && owner && s.owner_faction_id !== s.occupier_faction_id;
    return `<tr>
      <td>${escHtml(_fwName(s.solar_system_id))}</td>
      <td style="color:${owner ? owner.color : 'var(--text-3)'};">${owner ? escHtml(owner.short) : '—'}</td>
      <td style="color:${occ ? occ.color : 'var(--text-3)'};">${occ ? escHtml(occ.short) : '—'}${flipped ? ' <span class="fw-flip" title="Occupied by the attacker">⚑</span>' : ''}</td>
      <td><span class="fw-pill ${cst.cls}">${cst.label}</span></td>
      <td class="fw-vpcell">${vpt > 0 ? `<span class="fw-vpbar"><span class="fw-vpfill" style="width:${pct.toFixed(0)}%"></span></span><span class="lp-dim">${pct.toFixed(0)}%</span>` : '<span class="lp-dim">—</span>'}</td>
    </tr>`;
  }).join('');

  const vuln = systems.filter(s => s.contested === 'vulnerable').length;
  const cont = systems.filter(s => s.contested === 'contested').length;
  host.innerHTML = `
    <div class="fin-tab-fill fw-scroll">
      <div class="lp-bar tr-bar">
        <select id="fwWzSel" class="field-input ml-mini">${wzOpts}</select>
        <label class="tr-alert-toggle"><input type="checkbox" id="fwContestedChk"${_fwSysContestedOnly ? ' checked' : ''}> Contested only</label>
        <span class="lp-status">${rows.length} systems · <span class="fw-c-vuln">${vuln} vulnerable</span> · <span class="fw-c-contested">${cont} contested</span></span>
      </div>
      <div class="lp-table-wrap">
        <table class="tr-table">
          <thead><tr><th>System</th><th>Owner</th><th>Occupier</th><th>Status</th><th>Capture progress</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <div class="lp-note">“Vulnerable” systems can flip — their infrastructure is beaten down and plex capture counts.
        Capture progress is victory points toward the threshold (<code>/fw/systems/</code>). ⚑ marks a system held by its attacker.</div>
    </div>`;
  const sel = document.getElementById('fwWzSel'); if (sel) sel.onchange = (e) => { _fwSysWarzone = e.target.value; _fwRenderSystems(host); };
  const chk = document.getElementById('fwContestedChk'); if (chk) chk.onchange = (e) => { _fwSysContestedOnly = e.target.checked; _fwRenderSystems(host); };
}

// ── View 3: Leaderboards ────────────────────────────────────────────────────────
async function _fwRenderLeaderboards(host) {
  _fwLoading(host);
  await _fwEnsurePublic();
  if (_fwTab !== 'leaderboards') return;   // tab changed mid-fetch
  const board = (lb, kind) => {
    if (!lb || !lb[_fwLbMode]) return `<div class="fin-empty">No ${kind} leaderboard from ESI.</div>`;
    const list = lb[_fwLbMode][_fwLbWindow] || [];
    if (!list.length) return `<div class="fin-empty">No entries.</div>`;
    const rows = list.slice(0, 25).map((e, i) => {
      const id = e.character_id || e.corporation_id;
      const img = e.character_id
        ? `https://images.evetech.net/characters/${id}/portrait?size=32`
        : `https://images.evetech.net/corporations/${id}/logo?size=32`;
      return `<tr>
        <td class="lp-num lp-dim">${i + 1}</td>
        <td class="tr-td-name"><img class="tr-icon" src="${img}" alt="" onerror="this.style.visibility='hidden'"><span class="lp-name-txt">${escHtml(_fwName(id))}</span></td>
        <td class="lp-num lp-strong">${formatNumber(e.amount || 0)}</td>
      </tr>`;
    }).join('');
    return `<div class="fw-lb-col"><div class="tr-summary">${kind}</div>
      <div class="lp-table-wrap"><table class="tr-table"><thead><tr><th class="lp-num">#</th><th>Name</th><th class="lp-num">${_fwLbMode === 'kills' ? 'Kills' : 'Victory Pts'}</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  };
  const segBtn = (v, label, cur, attr) => `<button class="tr-seg-btn${cur === v ? ' active' : ''}" data-${attr}="${v}">${label}</button>`;
  host.innerHTML = `
    <div class="fin-tab-fill fw-scroll">
      <div class="lp-bar tr-bar">
        <div class="tr-seg">${segBtn('kills', 'Kills', _fwLbMode, 'fw-lbmode')}${segBtn('victory_points', 'Victory Points', _fwLbMode, 'fw-lbmode')}</div>
        <div class="tr-seg">${segBtn('active_total', 'All-time', _fwLbWindow, 'fw-lbwin')}${segBtn('yesterday', 'Yesterday', _fwLbWindow, 'fw-lbwin')}</div>
      </div>
      <div class="fw-lb-row">${board(_fwLbChars, 'Top Pilots')}${board(_fwLbCorps, 'Top Corporations')}</div>
      <div class="lp-note">Public ESI leaderboards (<code>/fw/leaderboards/</code>) across all four militias.</div>
    </div>`;
  host.querySelectorAll('[data-fw-lbmode]').forEach(b => b.onclick = () => { _fwLbMode = b.dataset.fwLbmode; _fwRenderLeaderboards(host); });
  host.querySelectorAll('[data-fw-lbwin]').forEach(b => b.onclick = () => { _fwLbWindow = b.dataset.fwLbwin; _fwRenderLeaderboards(host); });
}

// ── View 4: My Militia (authed personal stats) ──────────────────────────────────
async function _fwRenderMilitia(host) {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!accounts.length) { host.innerHTML = '<div class="fin-empty">Add a character to see your militia stats.</div>'; return; }
  if (!_fwMilitiaChar || !accounts.some(a => String(a.characterId) === String(_fwMilitiaChar))) _fwMilitiaChar = accounts[0].characterId;

  const charSel = `<select id="fwCharSel" class="field-input">${accounts.map(a => `<option value="${a.characterId}"${String(a.characterId) === String(_fwMilitiaChar) ? ' selected' : ''}>${escHtml(a.characterName)}</option>`).join('')}</select>`;
  const bar = `<div class="lp-bar tr-bar">${charSel}<span class="lp-status">Personal FW stats · scope esi-characters.read_fw_stats.v1</span></div>`;

  // Paint the shell (selector + title) immediately so it never blocks on the token
  // call, which can be slow when a stale token needs refreshing.
  host.innerHTML = `<div class="fin-tab-fill fw-scroll">${bar}
    <div id="fwMeContent"><div class="fin-empty">Loading My Militia…</div></div></div>`;
  const selEl = document.getElementById('fwCharSel');
  if (selEl) selEl.onchange = (e) => { _fwMilitiaChar = e.target.value; _fwRenderMilitia(host); };

  let res = null;
  try { res = await window.eveAPI.getCharacterFwStats(_fwMilitiaChar); } catch (_) {}
  const target = document.getElementById('fwMeContent');
  if (!target) return;   // navigated away while loading

  let content;
  if (res && res.ok && res.stats && res.stats.faction_id) {
    const s = res.stats, f = FW_FACTIONS[s.faction_id];
    await _fwEnsurePublic();
    const wz = FW_WARZONES.find(w => w.factions.includes(s.faction_id));
    const c  = wz ? _fwWarzoneControl(wz) : null;
    const myTier = c ? (s.faction_id === c.a ? c.tierA : c.tierB) : 1;
    const enlisted = s.enlisted_on ? new Date(s.enlisted_on).toLocaleDateString() : '—';
    content = `
      <div class="fw-me-head" style="border-left:4px solid ${f ? f.color : 'var(--accent)'};">
        <img class="fw-fac-logo" src="https://images.evetech.net/corporations/${s.faction_id}/logo?size=64" alt="" onerror="this.style.visibility='hidden'">
        <div>
          <div class="fw-fac-name" style="color:${f ? f.color : 'var(--accent)'};">${f ? escHtml(f.name) : 'Faction ' + s.faction_id} militia</div>
          <div class="fw-fac-sub">Enlisted ${escHtml(enlisted)} · current rank ${s.current_rank ?? 0} (peak ${s.highest_rank ?? 0}) · warzone tier ${myTier} ×${FW_LP_MULT[myTier].toFixed(1)} LP</div>
        </div>
      </div>
      <div class="fw-me-grid">
        ${_fwStat('Kills — 24h', (s.kills || {}).yesterday)}
        ${_fwStat('Kills — 7d', (s.kills || {}).last_week)}
        ${_fwStat('Kills — total', (s.kills || {}).total)}
        ${_fwStat('Victory pts — 24h', (s.victory_points || {}).yesterday)}
        ${_fwStat('Victory pts — 7d', (s.victory_points || {}).last_week)}
        ${_fwStat('Victory pts — total', (s.victory_points || {}).total)}
      </div>`;
  } else if (res && res.reason === 'scope') {
    content = `<div class="fin-firstrun"><h3>My Militia</h3><p>${escHtml(res.message)}</p>
      <p class="fin-dim">Re-authenticate this character on the Characters page, then come back.</p></div>`;
  } else if (res && res.ok) {
    content = `<div class="fin-firstrun"><h3>Not enlisted</h3><p>This character isn’t in a Faction Warfare militia.
      Enlist at a militia station in-game to start earning FW LP and rank.</p></div>`;
  } else {
    content = `<div class="fin-firstrun"><h3>My Militia</h3><p>Couldn’t load FW stats for this character right now.</p></div>`;
  }

  target.innerHTML = content;
}
function _fwStat(label, val) {
  return `<div class="fw-me-stat"><span class="fw-k">${label}</span><span class="fw-v">${formatNumber(val || 0)}</span></div>`;
}

// ── View 5: LP & Tiers ──────────────────────────────────────────────────────────
// The tier ladder + plex reference are local constants, so paint them immediately
// (never block on ESI). The live "Currently" column and tier-scaled plex LP fill in
// once /fw/stats resolves.
async function _fwRenderLp(host) {
  const held = { 1: '< 45%', 2: '45–59%', 3: '60–74%', 4: '75–89%', 5: '≥ 90%' };
  const tierRows = [1, 2, 3, 4, 5].map(t => `<tr>
      <td class="lp-strong">Tier ${t}</td>
      <td class="lp-num">×${FW_LP_MULT[t].toFixed(1)}</td>
      <td class="lp-dim">${held[t]} of warzone held</td>
      <td class="fw-tier-holders" data-fw-tier="${t}"><span class="lp-dim">…</span></td>
    </tr>`).join('');
  const plexRows = FW_PLEXES.map(p => `<tr>
    <td class="lp-strong">${p.name}</td>
    <td class="lp-dim">${escHtml(p.ships)}</td>
    <td class="lp-num">${formatNumber(p.baseLp)}</td>
    <td class="lp-num" data-fw-plexlp="${p.baseLp}">${formatNumber(p.baseLp)}</td>
  </tr>`).join('');
  const facOpts = Object.keys(FW_FACTIONS).map(fid =>
    `<option value="${fid}">${escHtml(FW_FACTIONS[fid].short)}</option>`).join('');

  host.innerHTML = `
    <div class="fin-tab-fill fw-scroll">
      <div class="tr-summary">Warzone-control tiers &amp; LP multipliers</div>
      <div class="lp-table-wrap"><table class="tr-table">
        <thead><tr><th>Tier</th><th class="lp-num">LP ×</th><th>Warzone held</th><th>Currently</th></tr></thead>
        <tbody>${tierRows}</tbody>
      </table></div>
      <div class="tr-summary" style="border-top:1px solid var(--border);">Plex LP reference
        <select id="fwPlexFac" class="field-input ml-mini" style="margin-left:8px;">${facOpts}</select></div>
      <div class="lp-table-wrap"><table class="tr-table">
        <thead><tr><th>Complex</th><th>Ships allowed</th><th class="lp-num">Base LP</th><th class="lp-num">At tier ×</th></tr></thead>
        <tbody>${plexRows}</tbody>
      </table></div>
      <div class="lp-note">Control % and system counts are live from ESI. Tier thresholds, the LP multiplier ladder and the
        base plex LP are the standard FW reference scale — CCP tunes exact values, so treat the ISK figures as a guide.
        Ship-size restrictions per complex are fixed game rules.</div>
    </div>`;

  let tierByFaction = {};
  const applyPlex = () => {
    const sel = document.getElementById('fwPlexFac');
    if (!sel) return;
    const mult = FW_LP_MULT[tierByFaction[sel.value] || 1];
    host.querySelectorAll('[data-fw-plexlp]').forEach(td => {
      td.textContent = formatNumber(Math.round(Number(td.dataset.fwPlexlp) * mult));
    });
  };
  const facSel = document.getElementById('fwPlexFac'); if (facSel) facSel.onchange = applyPlex;

  // Enhance with live control data once it arrives (page may have moved on).
  await _fwEnsurePublic();
  if (!_fwStats || !document.getElementById('fwPlexFac')) return;
  FW_WARZONES.forEach(wz => { const c = _fwWarzoneControl(wz); tierByFaction[c.a] = c.tierA; tierByFaction[c.b] = c.tierB; });
  host.querySelectorAll('[data-fw-tier]').forEach(td => {
    const t = Number(td.dataset.fwTier);
    const holders = Object.keys(tierByFaction).filter(fid => tierByFaction[fid] === t)
      .map(fid => `<span style="color:${FW_FACTIONS[fid].color};">${FW_FACTIONS[fid].short}</span>`).join(', ');
    td.innerHTML = holders || '<span class="lp-dim">—</span>';
  });
  const sel = document.getElementById('fwPlexFac');
  Object.keys(FW_FACTIONS).forEach((fid, i) => { if (sel.options[i]) sel.options[i].textContent = `${FW_FACTIONS[fid].short} (Tier ${tierByFaction[fid] || 1})`; });
  applyPlex();
}
