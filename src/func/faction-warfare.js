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
//
// `cls` is the same colour again, reachable from CSS: the dashboard widgets set
// `class="fw-f-caldari"` and let --fw-caldari in dashboard.css do the painting,
// because inline-styling a colour from JS puts it beyond the reach of themes.
// (This page predates that rule and still writes `color` inline; the two are
// kept in step here, in one object, rather than in two lists that can drift.)
// These are identity colours, not data-palette hues — a theme may not repaint
// Caldari green — so they are deliberately NOT --pal-* tokens.
const FW_FACTIONS = {
  500001: { name: 'Caldari State',       short: 'Caldari',  cls: 'caldari',  color: '#4a8fd6', enemy: 500004 },
  500004: { name: 'Gallente Federation', short: 'Gallente', cls: 'gallente', color: '#48b58a', enemy: 500001 },
  500003: { name: 'Amarr Empire',        short: 'Amarr',    cls: 'amarr',    color: '#d6b24a', enemy: 500002 },
  500002: { name: 'Minmatar Republic',   short: 'Minmatar', cls: 'minmatar', color: '#d66a4a', enemy: 500003 },
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

// How urgent each contested state is — lowest sorts first. Shared so the page's
// systems table and the dashboard widget rank the same systems the same way; two
// copies of this would eventually disagree about which system is "the hottest".
const FW_URGENCY = { vulnerable: 0, contested: 1, captured: 2, uncontested: 3 };

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
  // The tab render is returned so navigateToPage can show the header spinner
  // until the ESI pull behind it settles; the auto-refresh timer is fire-and-forget.
  const p = navigateFwTab(_fwTab || 'overview');
  _fwStartAutoRefresh();
  return p;
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
}

// Resolve ids → names, asking only for the ones we don't already hold.
//
// This used to run inside _fwEnsurePublic and resolve EVERYTHING the page might
// ever show: 160 systems plus both leaderboards × two metrics × three windows,
// which is up to ~1,200 ids for a view that displays 25 rows. That was tolerable
// while only the FW page could trigger it. The dashboard widgets can, and they
// re-render on every navigation, so each caller now names the handful of ids it
// is about to paint and the cache absorbs the overlap.
async function _fwResolveNames(ids) {
  const want = [...new Set(ids)].filter(id => id && !_fwNames[id]);
  if (!want.length) return;
  try {
    const arr = await window.eveAPI.getNames(want);
    if (Array.isArray(arr)) arr.forEach(n => { if (n && n.id) _fwNames[n.id] = n.name; });
  } catch (_) { /* leave them as #id; the next render retries */ }
}

function _fwName(id) { return _fwNames[id] || `#${id}`; }
function _fwLoading(host, label) { host.innerHTML = `<div class="fin-empty">${escHtml(label || 'Loading Faction Warfare data…')}</div>`; }

// Per-warzone control numbers now come from fwTugOfWar() at the bottom of this
// file — one function describing a warzone, read by this page AND the dashboard
// tile. There used to be two, which is how the tile ended up with a dead-even
// tick and a 24-hour push indicator that the page never got.

// ── View 1: Warzone Control (faction overview) ──────────────────────────────────
async function _fwRenderOverview(host) {
  _fwLoading(host);
  await _fwEnsurePublic();
  if (_fwTab !== 'overview') return;   // user switched tabs during the fetch — don't clobber
  if (!_fwStats) { host.innerHTML = '<div class="fin-empty">Couldn’t reach ESI for Faction Warfare stats. It refreshes automatically.</div>'; return; }

  // The rope, the knot and the running chevrons are the SAME markup and CSS the
  // dashboard's Warzone tile uses (.fwx-* in styles/dashboard.css, which the main
  // window loads alongside this page). Sharing it is the point: this page used to
  // draw its own flat two-tone bar from its own copy of the control maths, so the
  // tile grew a 24-hour push indicator and a dead-even tick and the page — the
  // place you actually go to read the warzone — never got either.
  const blocks = FW_WARZONES.map(wz => {
    const t = fwTugOfWar(_fwStats, wz);
    if (!t.ok) return `<div class="fw-wz"><div class="fw-wz-title">${escHtml(wz.name)}</div>
      <div class="fin-empty">ESI returned no stats for this warzone.</div></div>`;

    const card = (fid, stat, hold, pct, tier) => {
      const f = FW_FACTIONS[fid];
      return `
        <div class="fw-fac-card fw-f-${f.cls}">
          <div class="fw-fac-head"><img class="fw-fac-logo" src="https://images.evetech.net/corporations/${fid}/logo?size=64" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div>
            <div class="fw-fac-name">${escHtml(f.name)}</div>
            <div class="fw-fac-sub">Tier ${tier} · ×${FW_LP_MULT[tier].toFixed(1)} LP</div>
          </div></div>
          <div class="fw-fac-grid">
            <div><span class="fw-k">Systems held</span><span class="fw-v">${hold} <span class="lp-dim">(${(pct * 100).toFixed(0)}%)</span></span></div>
            <div><span class="fw-k">Pilots</span><span class="fw-v">${formatNumber(stat.pilots || 0)}</span></div>
            <div><span class="fw-k">Kills (24h)</span><span class="fw-v">${formatNumber((stat.kills || {}).yesterday || 0)}</span></div>
            <div><span class="fw-k">Kills (total)</span><span class="fw-v">${formatNumber((stat.kills || {}).total || 0)}</span></div>
            <div><span class="fw-k">VP (24h)</span><span class="fw-v">${formatNumber((stat.victory_points || {}).yesterday || 0)}</span></div>
            <div><span class="fw-k">VP (total)</span><span class="fw-v">${formatNumber((stat.victory_points || {}).total || 0)}</span></div>
          </div>
        </div>`;
    };

    // Chevrons run AWAY from the militia that is gaining: the left faction's
    // segment is measured from the left edge, so it winning drives the knot
    // rightwards, into the enemy's half. (Pointing them at the winner is the
    // intuitive answer and it is backwards — see dashboard-fw.js.)
    const pushCls = t.pushing == null ? '' : (t.pushing === t.a ? ' is-right' : ' is-left');
    const flow = t.pushing == null ? ''
      : `<span class="fwx-flow${pushCls}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;
    const push = t.pushing == null
      ? `<div class="fwx-push is-even">
           <span class="material-symbols-outlined fwx-push-ico">drag_handle</span>
           <span class="fwx-push-txt">Evenly matched over the last 24 hours</span>
           <span class="fwx-push-num">${(t.shareA * 100).toFixed(1)}% / ${((1 - t.shareA) * 100).toFixed(1)}%</span>
         </div>`
      : `<div class="fwx-push fw-f-${FW_FACTIONS[t.pushing].cls}${pushCls}">
           <span class="material-symbols-outlined fwx-push-ico">double_arrow</span>
           <span class="fwx-push-txt"><b>${escHtml(FW_FACTIONS[t.pushing].short)}</b> pushing</span>
           <span class="fwx-push-num">${(Math.max(t.shareA, 1 - t.shareA) * 100).toFixed(1)}% of the last 24h victory points</span>
         </div>`;

    return `
      <div class="fw-wz">
        <div class="fw-wz-title">${escHtml(wz.name)}</div>
        <div class="fw-tug" style="--fwx-a:${(t.pctA * 100).toFixed(2)}%; --fwx-push:${t.intensity.toFixed(2)};">
          <div class="fwx-rope fw-rope-lg" title="${t.holdA} of ${t.held} systems held by the ${escHtml(FW_FACTIONS[t.a].short)} militia">
            <span class="fwx-rope-a fw-f-${FW_FACTIONS[t.a].cls}"></span>
            <span class="fwx-rope-b fw-f-${FW_FACTIONS[t.b].cls}"></span>
            <span class="fwx-rope-even" aria-hidden="true"></span>
            <span class="fwx-knot"></span>
            ${flow}
          </div>
          <div class="fwx-rope-pcts">
            <span class="fw-f-${FW_FACTIONS[t.a].cls}">${(t.pctA * 100).toFixed(0)}% · ${t.holdA} systems</span>
            <span class="fwx-rope-even-lbl">even</span>
            <span class="fw-f-${FW_FACTIONS[t.b].cls}">${t.holdB} systems · ${(t.pctB * 100).toFixed(0)}%</span>
          </div>
          ${push}
        </div>
        <div class="fw-fac-row">${card(t.a, t.statA, t.holdA, t.pctA, t.tierA)}${card(t.b, t.statB, t.holdB, t.pctB, t.tierB)}</div>
      </div>`;
  }).join('');

  host.innerHTML = `
    <div class="fin-tab-fill fw-scroll">
      ${blocks}
      <div class="lp-note">Systems held, pilots, kills and victory points are live from ESI (<code>/fw/stats/</code>).
        The rope is systems held — the standing, won over months. The arrows are each militia’s share of the
        <em>last 24 hours’</em> victory points: who out-plexed whom yesterday, not a forecast that systems are
        about to flip. Inside four points of even it shows no direction at all.
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
  rows.sort((a, b) => (FW_URGENCY[a.contested] ?? 4) - (FW_URGENCY[b.contested] ?? 4)
    || ((b.victory_points || 0) / (b.victory_points_threshold || 1)) - ((a.victory_points || 0) / (a.victory_points_threshold || 1)));

  // Names for the rows about to be drawn (see _fwResolveNames).
  await _fwResolveNames(rows.map(s => s.solar_system_id));
  if (_fwTab !== 'systems') return;

  const wzOpts = [`<option value="all"${_fwSysWarzone === 'all' ? ' selected' : ''}>All warzones</option>`]
    .concat(FW_WARZONES.map(w => `<option value="${w.key}"${_fwSysWarzone === w.key ? ' selected' : ''}>${escHtml(w.name)}</option>`)).join('');

  const body = rows.map(s => {
    const owner = FW_FACTIONS[s.owner_faction_id], occ = FW_FACTIONS[s.occupier_faction_id];
    const cst = FW_CONTESTED[s.contested] || { label: s.contested || '—', cls: 'lp-dim' };
    const vp = s.victory_points || 0, vpt = s.victory_points_threshold || 0;
    const pct = vpt > 0 ? Math.min(100, (vp / vpt) * 100) : 0;
    const flipped = occ && owner && s.owner_faction_id !== s.occupier_faction_id;
    // Same two states the dashboard's Capture Pressure tile uses, so a system
    // reads identically in both places.
    const vuln = s.contested === 'vulnerable' || s.contested === 'captured';
    const rowCls = `fw-vprow${vuln ? ' is-vuln' : ''}${pct >= 75 ? ' is-hot' : ''}`;
    return `<tr class="${rowCls}">
      <td>${escHtml(_fwName(s.solar_system_id))}</td>
      <td class="${owner ? `fw-f-${owner.cls}` : ''}"><span class="fw-owner-txt">${owner ? escHtml(owner.short) : '—'}</span></td>
      <td class="${occ ? `fw-f-${occ.cls}` : ''}"><span class="fw-owner-txt">${occ ? escHtml(occ.short) : '—'}</span>${flipped ? ' <span class="fw-flip" title="Occupied by the attacker">⚑</span>' : ''}</td>
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

  // Only the 25 rows of the metric/window actually on screen — switching the
  // toggles resolves the next 25 and the cache keeps the previous ones.
  await _fwResolveNames([_fwLbChars, _fwLbCorps].flatMap(lb =>
    ((lb && lb[_fwLbMode] && lb[_fwLbMode][_fwLbWindow]) || [])
      .slice(0, 25).map(e => e.character_id || e.corporation_id)));
  if (_fwTab !== 'leaderboards') return;

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
    const c  = wz ? fwTugOfWar(_fwStats, wz) : null;
    const myTier = (c && c.ok) ? (s.faction_id === c.a ? c.tierA : c.tierB) : 1;
    const enlisted = s.enlisted_on ? new Date(s.enlisted_on).toLocaleDateString() : '—';
    content = `
      <div class="fw-me-head ${f ? `fw-f-${f.cls}` : ''}">
        <img class="fw-fac-logo" src="https://images.evetech.net/corporations/${s.faction_id}/logo?size=64" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div>
          <div class="fw-fac-name">${f ? escHtml(f.name) : 'Faction ' + s.faction_id} militia</div>
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
  FW_WARZONES.forEach(wz => {
    const c = fwTugOfWar(_fwStats, wz);
    if (c.ok) { tierByFaction[c.a] = c.tierA; tierByFaction[c.b] = c.tierB; }
  });
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

// ─── Shared selectors ─────────────────────────────────────────────────────────
// Pure functions over the ESI payloads, kept beside the data they read so the
// dashboard widgets (src/func/dashboard-fw.js) cannot drift into a second
// interpretation of the same numbers. Each takes its data as an argument and
// touches no module state, which is what makes them testable outside Electron.

/**
 * The top `n` entries of one leaderboard metric/window.
 *
 * ESI returns these already ordered, but ordering is the one thing a leaderboard
 * cannot get wrong and the sort is free, so it is not taken on trust.
 *
 * @param {object} lb      /fw/leaderboards/{characters,corporations} payload
 * @param {string} metric  'kills' | 'victory_points'
 * @param {string} window  'yesterday' | 'last_week' | 'active_total'
 */
function fwTopEntries(lb, metric, window, n) {
  const list = (lb && lb[metric] && lb[metric][window]) || [];
  return list
    .map(e => ({ id: e.character_id || e.corporation_id || 0, amount: Number(e.amount) || 0 }))
    .filter(e => e.id)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, n || 5)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

/**
 * Systems under live capture pressure, most urgent first.
 *
 * ESI names an owner and an occupier but never the attacker, so neither does
 * this: when the two differ the system is flying its attacker's flag already
 * (`flipped`), and when they match the pressure is simply the enemy militia's.
 * Inferring a name for the attacker would be a guess printed as a fact.
 *
 * @param {Array}  systems     /fw/systems payload
 * @param {string} warzoneKey  an FW_WARZONES key, or anything else for both
 */
function fwHotSystems(systems, warzoneKey, n) {
  const wz = FW_WARZONES.find(w => w.key === warzoneKey);
  return (systems || [])
    .filter(s => s && s.contested && s.contested !== 'uncontested')
    .filter(s => !wz || wz.factions.includes(s.owner_faction_id) || wz.factions.includes(s.occupier_faction_id))
    .map(s => {
      const vpt = Number(s.victory_points_threshold) || 0;
      const vp  = Number(s.victory_points) || 0;
      return {
        id: s.solar_system_id,
        owner: s.owner_faction_id,
        occupier: s.occupier_faction_id,
        contested: s.contested,
        vp, vpt,
        pct: vpt > 0 ? Math.min(1, vp / vpt) : 0,
        flipped: !!(s.owner_faction_id && s.occupier_faction_id && s.owner_faction_id !== s.occupier_faction_id),
      };
    })
    .sort((a, b) => (FW_URGENCY[a.contested] ?? 4) - (FW_URGENCY[b.contested] ?? 4) || b.pct - a.pct)
    .slice(0, n || 6);
}

// Below this much of an edge in the day's victory points, the warzone is called
// even rather than given a direction. Without a deadband the arrow flips sides on
// noise: Amarr–Minmatar sat at 50.6/49.4 the day this was written, which is a
// deadlock, not a push.
const FW_PUSH_DEADBAND = 0.04;
// The lead at which the push animation is already at full tilt. Real warzones
// rarely part further than this in a day, so the curve below lifts the small
// leads that actually occur instead of wasting its range on ones that don't.
const FW_PUSH_FULL = 0.20;

/**
 * One warzone as a tug of war.
 *
 * Two numbers from two endpoints, because they answer two different questions:
 *
 *   where the rope IS      systems_controlled — the standing, won over months
 *   which way it MOVES     each side's share of YESTERDAY's victory points
 *
 * The second is a 24-hour momentum proxy, not a territory forecast. Victory
 * points are earned by plexing and both militias bank them every single day, so
 * a majority share means "outplexed them yesterday", not "systems are flipping".
 * It is the only sub-weekly signal ESI publishes, and the widget labels it as
 * what it is. `lead` is the raw margin; `intensity` is only ever a display
 * quantity, driving how fast the arrows run.
 *
 * @param {Array}  stats  /fw/stats payload
 * @param {object} wz     an FW_WARZONES entry
 */
function fwTugOfWar(stats, wz) {
  const by = {};
  (stats || []).forEach(s => { if (s && s.faction_id) by[s.faction_id] = s; });
  const [a, b] = wz.factions;
  const sa = by[a], sb = by[b];
  if (!sa || !sb) return { ok: false, a, b };

  const holdA = Number(sa.systems_controlled) || 0;
  const holdB = Number(sb.systems_controlled) || 0;
  const held  = holdA + holdB;
  const pctA  = held ? holdA / held : 0.5;

  const vpA = Number((sa.victory_points || {}).yesterday) || 0;
  const vpB = Number((sb.victory_points || {}).yesterday) || 0;
  const vpT = vpA + vpB;
  // No victory points at all yesterday is a quiet warzone, not a 50/50 fight —
  // but it reads as even, and even is the state with no arrows.
  const shareA = vpT ? vpA / vpT : 0.5;
  const lead   = Math.abs(shareA - 0.5) * 2;

  return {
    ok: true, a, b,
    // The raw /fw/stats rows, so this is the ONE thing that has to be computed
    // to describe a warzone. The Warzone Control page and the dashboard tile both
    // read it; when they each had their own version of this maths, only one of
    // them got the rope and the other kept a flat two-tone bar.
    statA: sa, statB: sb,
    holdA, holdB, held,
    pctA, pctB: 1 - pctA,
    tierA: _fwTier(pctA), tierB: _fwTier(1 - pctA),
    killsA: Number((sa.kills || {}).yesterday) || 0,
    killsB: Number((sb.kills || {}).yesterday) || 0,
    pilotsA: Number(sa.pilots) || 0,
    pilotsB: Number(sb.pilots) || 0,
    vpA, vpB, shareA, lead,
    // The faction gaining ground, or null while the two are inside the deadband.
    pushing: lead < FW_PUSH_DEADBAND ? null : (shareA > 0.5 ? a : b),
    // 0…1 for the animation only. Square-rooted because the leads that happen in
    // practice cluster near zero, and a linear map would leave every real
    // warzone looking motionless.
    intensity: lead < FW_PUSH_DEADBAND ? 0 : Math.min(1, Math.sqrt(lead / FW_PUSH_FULL)),
  };
}
