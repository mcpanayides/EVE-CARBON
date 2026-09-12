// ─── Faction Warfare dashboard widgets ────────────────────────────────────────
// Three tiles that put the warzone on the dashboard without opening the Faction
// Warfare page:
//
//   fwBoard    TOP PILOTS      — top five by kills or victory points, all-time
//                                or yesterday. Which pair is picked when you add
//                                it, so the tile carries no toggle of its own.
//   fwSystems  CAPTURE PRESSURE— the six systems closest to flipping, for one
//                                warzone or both.
//   fwTug      WARZONE         — the tug of war: where the rope sits, and which
//                                militia is pulling it today.
//
// All three read PUBLIC ESI, so none of them need a character, a scope or a
// militia — a Gallente FC and someone who has never undocked into low-sec see
// the same numbers. The data and every derived figure come from the selectors in
// src/func/faction-warfare.js (fwTopEntries / fwHotSystems / fwTugOfWar), which
// the FW page itself uses, so a widget and the page can never quietly disagree
// about who is winning.
//
// These files share ONE global scope (see the duplicate-declaration check in
// scripts/lint.js), hence the _fwW / fwW prefixes throughout.
//
// The widgets are declared in DASHBOARD_WIDGETS in dashboard.js — the registry
// stays the single place a widget is described — and rendered from here.

// FW public data is cached ~30 min server-side, so that is the poll cadence.
// No refresh button: the endpoint's own TTL is the schedule.
const FW_W_POLL_MS = 30 * 60 * 1000;
let _fwWTimer = null;

// ── Per-instance choices ──────────────────────────────────────────────────────
// Each widget stores what it was pointed at when it was added, keyed by instance
// id, exactly like Job Watch and Character Wallet. One map per widget kind so a
// stale key from one can never be read as a value for another.
const FW_W_KEYS = {
  fwBoard:   'dashboardFwBoard',
  fwSystems: 'dashboardFwSystems',
  fwTug:     'dashboardFwTug',
};

function _fwWPickMap(base) {
  try {
    const m = JSON.parse(localStorage.getItem(FW_W_KEYS[base]) || '{}');
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (_) { return {}; }
}
function _fwWGetPick(base, instId) {
  const v = _fwWPickMap(base)[instId];
  return v != null ? String(v) : null;
}
function _fwWSetPick(base, instId, value) {
  try {
    const m = _fwWPickMap(base);
    if (value != null) m[instId] = String(value); else delete m[instId];
    localStorage.setItem(FW_W_KEYS[base], JSON.stringify(m));
  } catch (_) {}
}
// Called from removeDashboardWidget so a removed tile leaves nothing behind.
function fwWForgetPick(instId) {
  const base = String(instId).split('~')[0];
  if (FW_W_KEYS[base]) _fwWSetPick(base, instId, null);
}

// ── The pickable subjects ─────────────────────────────────────────────────────
// A leaderboard is one metric crossed with one window. Flattening the two into a
// single list keeps the add flow at one question — pick the board you want —
// rather than making you answer twice for a tile you may add three of.
const FW_W_BOARDS = [
  { value: 'kills:active_total',         metric: 'kills',          window: 'active_total', title: 'TOP PILOTS · KILLS',      sub: 'All-time',  unit: 'kills' },
  { value: 'kills:yesterday',            metric: 'kills',          window: 'yesterday',    title: 'TOP PILOTS · KILLS 24H',  sub: 'Yesterday', unit: 'kills' },
  { value: 'victory_points:active_total',metric: 'victory_points', window: 'active_total', title: 'TOP PILOTS · VP',         sub: 'All-time',  unit: 'VP'    },
  { value: 'victory_points:yesterday',   metric: 'victory_points', window: 'yesterday',    title: 'TOP PILOTS · VP 24H',     sub: 'Yesterday', unit: 'VP'    },
];
const _fwWBoard = (v) => FW_W_BOARDS.find(b => b.value === v) || FW_W_BOARDS[0];

function fwWBoardOptions() {
  return FW_W_BOARDS.map(b => ({
    value: b.value,
    label: `${b.metric === 'kills' ? 'Kills' : 'Victory points'} · ${b.sub}`,
    icon:  b.metric === 'kills' ? 'local_fire_department' : 'military_tech',
  }));
}
function fwWSystemsOptions() {
  return [{ value: 'all', label: 'Both warzones', icon: 'public' }]
    .concat(FW_WARZONES.map(w => ({ value: w.key, label: w.name, icon: 'swords' })));
}
// One warzone per tile, deliberately: the tug of war only reads as a tug of war
// at a size that shows both militias' names, tiers and the rope between them.
// Add it twice for both warzones.
function fwWTugOptions() {
  return FW_WARZONES.map(w => ({ value: w.key, label: w.name, icon: 'swords' }));
}

// ── Titles ────────────────────────────────────────────────────────────────────
// Two instances of the same widget showing different things have to be tellable
// apart from the header alone, so each names its own subject (registry `titleOf`).
function fwWBoardTitle(instId)   { return _fwWBoard(_fwWGetPick('fwBoard', instId)).title; }
function fwWSystemsTitle(instId) {
  const wz = FW_WARZONES.find(w => w.key === _fwWGetPick('fwSystems', instId));
  return wz ? `CAPTURE PRESSURE · ${wz.name.replace(' Warzone', '').toUpperCase()}` : 'CAPTURE PRESSURE';
}
function fwWTugTitle(instId) {
  const wz = FW_WARZONES.find(w => w.key === _fwWGetPick('fwTug', instId)) || FW_WARZONES[0];
  return wz.name.replace(' Warzone', '').toUpperCase() + ' WARZONE';
}

// ── Small shared bits ─────────────────────────────────────────────────────────
// Faction colour arrives as a class, never as an inline style: --fw-caldari and
// friends live in dashboard.css so a theme can reach them.
function _fwWFac(id)      { return FW_FACTIONS[id] || null; }
function _fwWFacCls(id)   { const f = _fwWFac(id); return f ? `fw-f-${f.cls}` : ''; }
function _fwWFacShort(id) { const f = _fwWFac(id); return f ? f.short : '—'; }
function _fwWNum(n)       { return (typeof formatNumber === 'function') ? formatNumber(n) : String(n); }
function _fwWEmpty(msg)   { return `<div class="dashboard-empty">${escHtml(msg)}</div>`; }

// Every FW tile fails the same way, and it is worth being specific about which
// of the two failures it is: ESI down is not the same as "nobody has plexed".
function _fwWOffline() {
  return `<div class="dashboard-empty dash-widget-failed">Couldn’t reach ESI for Faction Warfare. It retries on its own.</div>`;
}

// ── Widget 1: TOP PILOTS ──────────────────────────────────────────────────────
// A leaderboard is a ranked list, but it is also a distribution — and on a day
// when the top pilot has 144 kills and the fifth has 30, that shape is the story.
// So each row carries a bar scaled to the leader, behind the text rather than
// beside it, which costs no width on a tile that may only be three columns wide.
async function _fwWRenderBoard(body, instId) {
  if (!_fwLbChars) { body.innerHTML = _fwWOffline(); return; }
  const cfg  = _fwWBoard(_fwWGetPick('fwBoard', instId));
  const rows = fwTopEntries(_fwLbChars, cfg.metric, cfg.window, 5);
  if (!rows.length) { body.innerHTML = _fwWEmpty('ESI has published no entries for this board.'); return; }

  await _fwResolveNames(rows.map(r => r.id));

  const top = rows[0].amount || 1;
  const list = rows.map(r => {
    const pct = Math.max(2, (r.amount / top) * 100);   // a floor, so rank 5 is still a bar
    return `<li class="fwx-row${r.rank === 1 ? ' is-lead' : ''}">
      <span class="fwx-bar" style="width:${pct.toFixed(1)}%"></span>
      <span class="fwx-pos">${r.rank}</span>
      <img class="fwx-portrait" src="https://images.evetech.net/characters/${r.id}/portrait?size=32"
           alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span class="fwx-name" title="${escHtml(_fwName(r.id))}">${escHtml(_fwName(r.id))}</span>
      <span class="fwx-amt">${_fwWNum(r.amount)}</span>
    </li>`;
  }).join('');

  body.innerHTML = `<div class="fwx-board">
    <!-- The metric and window are already in the tile's own title, so the line
         leads with the thing that isn't: this is not your militia's board. -->
    <div class="fwx-sub">All four militias · ${escHtml(cfg.sub)} ${escHtml(cfg.unit)}</div>
    <ol class="fwx-rank">${list}</ol>
  </div>`;
}

// ── Widget 2: CAPTURE PRESSURE ────────────────────────────────────────────────
// The six systems closest to changing hands. The bar is how far the attackers
// have ground the system down, so it is coloured by pressure — gold through to
// red — and NOT by the owner's militia: filling a Caldari system in Caldari blue
// as it falls would read as Caldari progress.
async function _fwWRenderSystems(body, instId) {
  if (!_fwSystems) { body.innerHTML = _fwWOffline(); return; }
  const key  = _fwWGetPick('fwSystems', instId) || 'all';
  const wz   = FW_WARZONES.find(w => w.key === key);
  const rows = fwHotSystems(_fwSystems, key, 6);
  if (!rows.length) {
    body.innerHTML = _fwWEmpty(wz ? `Nothing contested in the ${wz.name.replace(' Warzone', '')} warzone.`
                                  : 'Nothing contested in either warzone.');
    return;
  }

  await _fwResolveNames(rows.map(r => r.id));

  // How many are contested in total, so six rows are read as a shortlist rather
  // than as the whole warzone.
  const contestedTotal = fwHotSystems(_fwSystems, key, _fwSystems.length).length;
  const list = rows.map(r => {
    const pct  = r.pct * 100;
    const vuln = r.contested === 'vulnerable' || r.contested === 'captured';
    return `<div class="fwx-sys-row${vuln ? ' is-vuln' : ''}${pct >= 75 ? ' is-hot' : ''}">
      <span class="fwx-sys-own ${_fwWFacCls(r.owner)}" title="Held by the ${escHtml(_fwWFacShort(r.owner))} militia">${escHtml(_fwWFacShort(r.owner).slice(0, 3).toUpperCase())}</span>
      <span class="fwx-sys-name" title="${escHtml(_fwName(r.id))}">${escHtml(_fwName(r.id))}${
        r.flipped ? ' <span class="fwx-flip" title="Occupied by its attacker">⚑</span>' : ''}</span>
      <span class="fwx-sys-track"><span class="fwx-sys-fill" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="fwx-sys-pct">${pct.toFixed(0)}%</span>
    </div>`;
  }).join('');

  body.innerHTML = `<div class="fwx-sys">
    <div class="fwx-sub">${escHtml(wz ? wz.name.replace(' Warzone', '') : 'Both warzones')} · ${contestedTotal} contested</div>
    <div class="fwx-sys-list">${list}</div>
  </div>`;
}

// ── Widget 3: WARZONE TUG OF WAR ──────────────────────────────────────────────
// Where the rope is (systems held) and which way it is being pulled (share of
// yesterday's victory points). Those are two different endpoints answering two
// different questions, and the tile keeps them visually separate: the rope is
// the standing, the arrows are today.
//
// The 50% tick matters more than it looks. Without it a 59/41 split is just a
// two-tone bar; with it you can see how far the warzone has been dragged from
// even, which is the whole point of drawing it as a rope.
function _fwWRenderTug(body, instId) {
  const key = _fwWGetPick('fwTug', instId) || FW_WARZONES[0].key;
  const wz  = FW_WARZONES.find(w => w.key === key) || FW_WARZONES[0];
  if (!_fwStats) { body.innerHTML = _fwWOffline(); return; }

  const t = fwTugOfWar(_fwStats, wz);
  if (!t.ok) { body.innerHTML = _fwWEmpty('ESI returned no stats for this warzone.'); return; }

  const side = (fid, hold, pct, tier, right) => `
    <div class="fwx-tug-side${right ? ' is-right' : ''} ${_fwWFacCls(fid)}">
      <img class="fwx-tug-logo" src="https://images.evetech.net/corporations/${fid}/logo?size=64"
           alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="fwx-tug-id">
        <div class="fwx-tug-fac">${escHtml(_fwWFacShort(fid))}</div>
        <div class="fwx-tug-meta">${hold} sys · T${tier} ×${FW_LP_MULT[tier].toFixed(1)}</div>
      </div>
    </div>`;

  // Which way the chevrons run.
  //
  // Worth stating, because the obvious answer is the wrong one: they point AWAY
  // from the militia that is winning, not toward it. `.fwx-rope-a` is measured
  // from the left edge, so the left faction gaining ground makes its segment
  // WIDER and drives the knot to the RIGHT — into the enemy's half. The first
  // version of this pointed the arrows at the winner and was exactly backwards;
  // it took looking at the rendered tile to see it.
  const pushCls = t.pushing == null ? '' : (t.pushing === t.a ? ' is-right' : ' is-left');
  const flow = t.pushing == null ? '' :
    `<span class="fwx-flow${pushCls}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`;

  const pushLine = t.pushing == null
    ? `<div class="fwx-push is-even">
         <span class="material-symbols-outlined fwx-push-ico">drag_handle</span>
         <span class="fwx-push-txt">Evenly matched</span>
         <span class="fwx-push-num">${(t.shareA * 100).toFixed(1)}% / ${((1 - t.shareA) * 100).toFixed(1)}%</span>
       </div>`
    : `<div class="fwx-push ${_fwWFacCls(t.pushing)}${pushCls}">
         <span class="material-symbols-outlined fwx-push-ico">double_arrow</span>
         <span class="fwx-push-txt"><b>${escHtml(_fwWFacShort(t.pushing))}</b> pushing</span>
         <span class="fwx-push-num">${(Math.max(t.shareA, 1 - t.shareA) * 100).toFixed(1)}% of 24h VP</span>
       </div>`;

  body.innerHTML = `
    <div class="fwx-tug" style="--fwx-a:${(t.pctA * 100).toFixed(2)}%; --fwx-push:${t.intensity.toFixed(2)};">
      <div class="fwx-tug-heads">${side(t.a, t.holdA, t.pctA, t.tierA, false)}${side(t.b, t.holdB, t.pctB, t.tierB, true)}</div>
      <div class="fwx-rope" title="${t.holdA} of ${t.held} systems held by the ${escHtml(_fwWFacShort(t.a))} militia">
        <span class="fwx-rope-a ${_fwWFacCls(t.a)}"></span>
        <span class="fwx-rope-b ${_fwWFacCls(t.b)}"></span>
        <span class="fwx-rope-even" aria-hidden="true"></span>
        <span class="fwx-knot"></span>
        ${flow}
      </div>
      <div class="fwx-rope-pcts">
        <span class="${_fwWFacCls(t.a)}">${(t.pctA * 100).toFixed(0)}%</span>
        <span class="fwx-rope-even-lbl">even</span>
        <span class="${_fwWFacCls(t.b)}">${(t.pctB * 100).toFixed(0)}%</span>
      </div>
      ${pushLine}
      <div class="fwx-foot">
        <span>${_fwWNum(t.killsA)} <i>kills 24h</i> ${_fwWNum(t.killsB)}</span>
        <span>${_fwWNum(t.pilotsA)} <i>pilots</i> ${_fwWNum(t.pilotsB)}</span>
      </div>
    </div>`;
}

// ── Painting them all ─────────────────────────────────────────────────────────
// One fetch (_fwEnsurePublic is cached in-module) feeds every FW tile on the
// grid, however many of them there are.
async function renderAllFwWidgets() {
  const panels = document.querySelectorAll(
    '#dashboardGrid [data-widget-base="fwBoard"], #dashboardGrid [data-widget-base="fwSystems"], #dashboardGrid [data-widget-base="fwTug"],'
    + ' #dashPopoutHost [data-widget-base="fwBoard"], #dashPopoutHost [data-widget-base="fwSystems"], #dashPopoutHost [data-widget-base="fwTug"]');
  if (!panels.length) return;

  // The FW page module owns the fetch and the cache. If it failed to load at all
  // (a duplicate top-level name takes a whole file out — see scripts/lint.js),
  // say so on the tile instead of throwing on every dashboard load.
  if (typeof _fwEnsurePublic !== 'function') {
    panels.forEach(p => {
      const b = p.querySelector('.dashboard-widget-body');
      if (b) b.innerHTML = _fwWOffline();
    });
    return;
  }
  await _fwEnsurePublic();

  for (const panel of panels) {
    const body   = panel.querySelector('.dashboard-widget-body');
    const instId = panel.dataset.widgetId;
    if (!body || !instId) continue;
    try {
      if (panel.dataset.widgetBase === 'fwBoard')   await _fwWRenderBoard(body, instId);
      if (panel.dataset.widgetBase === 'fwSystems') await _fwWRenderSystems(body, instId);
      if (panel.dataset.widgetBase === 'fwTug')     _fwWRenderTug(body, instId);
    } catch (e) {
      console.warn('[dashboard-fw] widget render failed:', e?.message || e);
      body.innerHTML = _fwWOffline();
    }
  }
}

// Paint now, then keep to the endpoint's own cadence. The timer stops itself once
// the last FW tile leaves the grid, so removing a widget doesn't leave a 30-minute
// interval running for the rest of the session.
function initFwWidgets() {
  renderAllFwWidgets().catch(() => {});
  if (_fwWTimer) clearInterval(_fwWTimer);
  _fwWTimer = setInterval(() => {
    // A popped-out tile lives in the off-screen host, not the grid, and must keep
    // refreshing — checking only the grid would stop the clock on the one window
    // the user has deliberately left open on top of the game.
    if (!document.querySelector('#dashboardGrid [data-widget-base^="fw"], #dashPopoutHost [data-widget-base^="fw"]')) {
      clearInterval(_fwWTimer); _fwWTimer = null; return;
    }
    _fwFetchedAt = 0;                       // past the in-module 5-min gate
    renderAllFwWidgets().catch(() => {});
  }, FW_W_POLL_MS);
}
