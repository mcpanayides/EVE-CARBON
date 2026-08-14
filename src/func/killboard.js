// ─── Killboard ────────────────────────────────────────────────────────────────
// Recent kills and losses with all-time PvP stats, backed by zKillboard's public
// API (the same source the dashboard banner already uses for its rank column).
//
// The source dropdown offers four kinds of view:
//   • a single character
//   • a single corporation (every kill/loss the corp was on)
//   • All Characters  — every one of your characters' feeds merged
//   • All Corporations — every corp your characters belong to, merged
// Combined views fetch each underlying entity's zKill feed and merge them,
// deduping by killmail and re-deciding kill/loss against your whole set.
//
// Deliberately no ESI scope: zKill returns the whole killmail inline (victim,
// attackers, ship, system, time) plus its own ISK valuation, so this works for
// any character/corp immediately without re-authenticating. The trade-off is it
// only shows killmails zKill knows about, which in practice is all PvP ones.

let _kbSource   = null;   // { type:'char'|'corp'|'all-chars'|'all-corps', id?, name, charIds?, corpIds? }
let _kbStats    = null;
let _kbFeed     = [];
let _kbFilter   = 'all';  // all | kills | losses | solo
let _kbPage     = 1;
let _kbNames    = {};
let _kbBusy     = false;
let _kbEnd      = false;
let _kbMyChars  = new Set();   // all my character ids (for combined loss detection)
let _kbMyCorps  = new Set();   // all corp ids my characters belong to

// The chosen source survives restarts. Stored as the dropdown's own value string
// ('all-chars', 'char:123', 'corp:456') so it round-trips through the same parser
// the picker uses, and a stale id simply fails validation and falls back.
const KB_SOURCE_KEY = 'killboardSource';
function _kbLoadSourceValue() {
  try { return localStorage.getItem(KB_SOURCE_KEY) || null; } catch (_) { return null; }
}
function _kbSaveSourceValue(v) {
  try { localStorage.setItem(KB_SOURCE_KEY, String(v)); } catch (_) { /* private mode */ }
}

// Run async `fn` over `items` at most `limit` at a time — polite to zKill when a
// combined view fans out to several feeds at once.
async function _kbMapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function initKillboardPage() {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(accounts) || !accounts.length) {
    _kbSetFeedMessage('Add a character on the Characters page to see its killboard.');
    document.getElementById('kbStats').innerHTML = '';
    return;
  }

  // Resolve each character's corporation from the local DB (fast, no network).
  const corpByChar = {};
  await Promise.all(accounts.map(async a => {
    try { const d = await window.eveAPI.getCharacterData(a.characterId); corpByChar[a.characterId] = d?.info?.corporation_id || null; }
    catch (_) { corpByChar[a.characterId] = null; }
  }));

  _kbMyChars = new Set(accounts.map(a => Number(a.characterId)));
  const corpIds = [...new Set(Object.values(corpByChar).filter(Boolean).map(Number))];
  _kbMyCorps = new Set(corpIds);

  // Corp names for the dropdown (and seed the shared name cache).
  if (corpIds.length) {
    try {
      const r = await window.eveAPI.getNames(corpIds);
      if (Array.isArray(r)) r.forEach(({ id, name }) => { if (id && name) _kbNames[id] = name; });
      else if (r && typeof r === 'object') Object.assign(_kbNames, r);
    } catch (_) { /* corps show a fallback label */ }
  }

  _kbPopulateSelect(accounts, corpIds);

  // Keep the current source across refreshes if it's still valid; otherwise
  // restore the one chosen last session, and failing that show All Characters —
  // the whole roster's feed is what you want on a killboard you share between
  // characters. A single-character roster has no combined view, so it opens on
  // that character.
  if (!_kbSource || !_kbSourceStillValid(accounts, corpIds)) {
    const saved = _kbLoadSourceValue();
    const restored = saved ? _kbParseSourceValue(saved, accounts, corpIds) : null;
    if (restored && _kbSourceStillValid(accounts, corpIds, restored)) {
      _kbSource = restored;
    } else if (accounts.length > 1) {
      _kbSource = { type: 'all-chars', name: 'All Characters', charIds: [..._kbMyChars] };
    } else {
      const main = accounts[0];
      _kbSource = { type: 'char', id: Number(main.characterId), name: main.characterName };
    }
  }
  _kbSyncSelectValue();

  // Static controls
  document.querySelectorAll('.kb-filter').forEach(b => {
    b.onclick = () => { _kbFilter = b.dataset.kbFilter; _kbRenderFilters(); _kbRenderFeed(); };
  });
  const refresh = document.getElementById('kbRefreshBtn');
  if (refresh) refresh.onclick = () => _kbReload();
  const zk = document.getElementById('kbOpenZkillBtn');
  if (zk) zk.onclick = () => {
    const url = _kbSource.type === 'corp'  ? `https://zkillboard.com/corporation/${_kbSource.id}/`
              : _kbSource.type === 'char'  ? `https://zkillboard.com/character/${_kbSource.id}/`
              : null;
    if (url) _kbOpen(url);
  };

  await _kbReload();
}

// `src` defaults to the live source; pass one explicitly to vet a restored
// selection before adopting it (a character or corp may have gone away).
function _kbSourceStillValid(accounts, corpIds, src = _kbSource) {
  if (!src) return false;
  if (src.type === 'char')  return accounts.some(a => Number(a.characterId) === src.id);
  if (src.type === 'corp')  return corpIds.includes(src.id);
  if (src.type === 'all-chars') return accounts.length > 1;
  if (src.type === 'all-corps') return corpIds.length > 1;
  return false;
}

function _kbPopulateSelect(accounts, corpIds) {
  const sel = document.getElementById('kbCharSelect');
  if (!sel) return;

  const overview = [];
  if (accounts.length > 1) overview.push('<option value="all-chars">All Characters</option>');
  if (corpIds.length > 1)  overview.push('<option value="all-corps">All Corporations</option>');

  const chars = accounts
    .map(a => `<option value="char:${a.characterId}">${escHtml(a.characterName)}</option>`)
    .join('');

  const corps = corpIds
    .map(id => `<option value="corp:${id}">${escHtml(_kbName(id))}</option>`)
    .join('');

  sel.innerHTML =
    (overview.length ? `<optgroup label="Overviews">${overview.join('')}</optgroup>` : '')
    + `<optgroup label="Characters">${chars}</optgroup>`
    + (corps ? `<optgroup label="Corporations">${corps}</optgroup>` : '');

  sel.onchange = () => {
    _kbSource = _kbParseSourceValue(sel.value, accounts, corpIds);
    _kbSaveSourceValue(sel.value);
    // The zKillboard-link button only makes sense for a single entity.
    const zk = document.getElementById('kbOpenZkillBtn');
    if (zk) zk.style.display = (_kbSource.type === 'char' || _kbSource.type === 'corp') ? '' : 'none';
    _kbReload();
  };
}

function _kbParseSourceValue(v, accounts, corpIds) {
  if (v === 'all-chars') return { type: 'all-chars', name: 'All Characters', charIds: [..._kbMyChars] };
  if (v === 'all-corps') return { type: 'all-corps', name: 'All Corporations', corpIds: [..._kbMyCorps] };
  if (v.startsWith('char:')) {
    const id = Number(v.slice(5));
    const a = accounts.find(x => Number(x.characterId) === id);
    return { type: 'char', id, name: a ? a.characterName : `ID ${id}` };
  }
  if (v.startsWith('corp:')) {
    const id = Number(v.slice(5));
    return { type: 'corp', id, name: _kbName(id) };
  }
  return _kbSource;
}

function _kbSyncSelectValue() {
  const sel = document.getElementById('kbCharSelect');
  if (!sel) return;
  sel.value = _kbSource.type === 'char' ? `char:${_kbSource.id}`
            : _kbSource.type === 'corp' ? `corp:${_kbSource.id}`
            : _kbSource.type;
  const zk = document.getElementById('kbOpenZkillBtn');
  if (zk) zk.style.display = (_kbSource.type === 'char' || _kbSource.type === 'corp') ? '' : 'none';
}

// The zKill entities the current source fans out to.
function _kbEntities() {
  switch (_kbSource.type) {
    case 'char':      return [{ kind: 'character', id: _kbSource.id }];
    case 'corp':      return [{ kind: 'corporation', id: _kbSource.id }];
    case 'all-chars': return _kbSource.charIds.map(id => ({ kind: 'character', id }));
    case 'all-corps': return _kbSource.corpIds.map(id => ({ kind: 'corporation', id }));
    default:          return [];
  }
}

async function _kbReload() {
  _kbFeed = []; _kbPage = 1; _kbEnd = false;
  _kbRenderFilters();
  _kbSetFeedMessage('Loading killboard…');
  document.getElementById('kbStats').innerHTML = '<div class="kb-empty">Loading stats…</div>';
  await Promise.all([_kbLoadStats(), _kbLoadPage(true)]);
}

// ─── Feed ────────────────────────────────────────────────────────────────────
async function _kbLoadPage(reset = false) {
  if (_kbBusy || (_kbEnd && !reset)) return;
  _kbBusy = true;
  const entities = _kbEntities();
  const results = await _kbMapLimit(entities, 4, e =>
    window.eveAPI.getZkillFeed(e.kind, e.id, _kbPage).catch(() => null));
  _kbBusy = false;

  const good = results.filter(Array.isArray);
  if (!good.length) {
    if (reset) _kbSetFeedMessage('zKillboard is unreachable right now — try Refresh in a moment.');
    _kbEnd = true;
    return;
  }
  // End of feed when every source is empty for this page.
  if (good.every(r => r.length === 0)) { _kbEnd = true; if (reset) _kbRenderFeed(); return; }

  let rows = good.flat();
  // Combined views: re-decide kill/loss against ALL my characters/corps, since a
  // single source's isLoss only reflects that one entity.
  if (_kbSource.type === 'all-chars') rows.forEach(k => { k.isLoss = _kbMyChars.has(Number(k.victimCharId)); });
  if (_kbSource.type === 'all-corps') rows.forEach(k => { k.isLoss = _kbMyCorps.has(Number(k.victimCorpId)); });

  // Dedupe against what we already have AND within this batch: in combined
  // views the same killmail can arrive from two of your entities at once (e.g.
  // two of your corps both on one kill), so update `seen` as we go.
  const seen = new Set(_kbFeed.map(k => k.killmailId));
  for (const k of rows) {
    if (seen.has(k.killmailId)) continue;
    seen.add(k.killmailId);
    _kbFeed.push(k);
  }
  _kbFeed.sort((a, b) => new Date(b.time) - new Date(a.time));

  await _kbResolveNames();
  _kbRenderFeed();
}

// Characters, ship types and solar systems all resolve through the same ESI
// /universe/names batch, so one call covers every id the feed needs.
async function _kbResolveNames() {
  const ids = [];
  _kbFeed.forEach(k => {
    [k.victimCharId, k.finalBlowCharId, k.victimShipTypeId, k.finalBlowShipTypeId, k.systemId]
      .forEach(id => { if (id && !_kbNames[id]) ids.push(id); });
  });
  const missing = [...new Set(ids)];
  if (!missing.length) return;
  try {
    const r = await window.eveAPI.getNames(missing);
    if (Array.isArray(r)) r.forEach(({ id, name }) => { if (id && name) _kbNames[id] = name; });
    else if (r && typeof r === 'object') Object.assign(_kbNames, r);
  } catch (_) { /* unresolved ids fall back to a dash */ }
}

const _kbName = (id) => (id && _kbNames[id]) || '—';

function _kbFiltered() {
  if (_kbFilter === 'kills')  return _kbFeed.filter(k => !k.isLoss);
  if (_kbFilter === 'losses') return _kbFeed.filter(k => k.isLoss);
  if (_kbFilter === 'solo')   return _kbFeed.filter(k => k.solo);
  return _kbFeed;
}

function _kbRenderFilters() {
  document.querySelectorAll('.kb-filter').forEach(b => {
    b.classList.toggle('active', b.dataset.kbFilter === _kbFilter);
  });
}

function _kbSetFeedMessage(msg) {
  const host = document.getElementById('kbFeed');
  if (host) host.innerHTML = `<div class="kb-empty">${escHtml(msg)}</div>`;
}

function _kbRenderFeed() {
  const host = document.getElementById('kbFeed');
  if (!host) return;
  const rows = _kbFiltered();
  if (!rows.length) {
    host.innerHTML = `<div class="kb-empty">No ${_kbFilter === 'all' ? 'killmails' : _kbFilter} to show.</div>`;
    return;
  }

  host.innerHTML = rows.map(k => {
    // On a kill we name what was shot; on a loss, who landed the final blow.
    const otherId = k.isLoss ? k.finalBlowCharId : k.victimCharId;
    const shipId  = k.victimShipTypeId;
    const tags = [
      k.solo ? '<span class="kb-tag solo">SOLO</span>' : '',
      k.npc  ? '<span class="kb-tag npc">NPC</span>'   : '',
      k.awox ? '<span class="kb-tag awox">AWOX</span>' : '',
    ].join('');
    return `
      <button class="kb-row ${k.isLoss ? 'loss' : 'kill'}" data-km="${k.killmailId}">
        <span class="kb-badge">${k.isLoss ? 'LOSS' : 'KILL'}</span>
        <img class="kb-ship" src="https://images.evetech.net/types/${shipId}/render?size=64"
             alt="" loading="lazy" onerror="this.onerror=null;this.src='https://images.evetech.net/types/${shipId}/icon?size=64'"/>
        <span class="kb-main">
          <span class="kb-ship-name">${escHtml(_kbName(shipId))}${tags}</span>
          <span class="kb-sub">
            ${k.isLoss ? 'killed by' : 'destroyed'} ${escHtml(_kbName(otherId))}
            ${k.attackerCount > 1 ? `<span class="kb-dim">+${k.attackerCount - 1}</span>` : ''}
            · ${escHtml(_kbName(k.systemId))}
          </span>
        </span>
        <span class="kb-right">
          <span class="kb-isk ${k.isLoss ? 'kb-neg' : 'kb-pos'}">${formatISK(k.totalValue)}</span>
          <span class="kb-time">${_kbFmtDate(k.time)}</span>
        </span>
      </button>`;
  }).join('')
    + (_kbEnd ? '' : '<button class="kb-more" id="kbMoreBtn">Load older killmails</button>');

  host.querySelectorAll('.kb-row').forEach(r => {
    r.onclick = () => _kbOpen(`https://zkillboard.com/kill/${r.dataset.km}/`);
  });
  const more = document.getElementById('kbMoreBtn');
  if (more) more.onclick = async () => {
    more.disabled = true; more.textContent = 'Loading…';
    _kbPage += 1;
    await _kbLoadPage(false);
  };
}

// ─── Stats ───────────────────────────────────────────────────────────────────
async function _kbLoadStats() {
  const entities = _kbEntities();
  if (entities.length === 1) {
    _kbStats = await window.eveAPI.getZkillStats(entities[0].id, entities[0].kind).catch(() => null);
    _kbRenderStats(false);
    return;
  }
  // Combined: sum each entity's all-time stats. Shared kills across your own
  // characters can double-count, so this is billed as an aggregate, not exact.
  const all = await _kbMapLimit(entities, 4, e =>
    window.eveAPI.getZkillStats(e.id, e.kind).catch(() => null));
  const parts = all.filter(Boolean);
  if (!parts.length) { _kbStats = null; _kbRenderStats(true); return; }
  const sum = (f) => parts.reduce((n, s) => n + (Number(s[f]) || 0), 0);
  _kbStats = {
    shipsDestroyed: sum('shipsDestroyed'),
    shipsLost:      sum('shipsLost'),
    iskDestroyed:   sum('iskDestroyed'),
    iskLost:        sum('iskLost'),
    soloKills:      sum('soloKills'),
    dangerRatio:    null,
    periods:        null,     // rank isn't meaningful for a combined view
  };
  _kbRenderStats(true);
}

function _kbRenderStats(combined) {
  const host = document.getElementById('kbStats');
  if (!host) return;
  const s = _kbStats;
  if (!s) {
    host.innerHTML = `<div class="kb-empty">No zKillboard record for ${escHtml(_kbSource.name)} yet.</div>`;
    return;
  }
  const destroyed = s.iskDestroyed || 0;
  const lost      = s.iskLost || 0;
  const eff  = (destroyed + lost) > 0 ? (destroyed / (destroyed + lost)) * 100 : null;
  const rank = s.periods && s.periods.alltime ? s.periods.alltime.overall : null;

  host.innerHTML = `
    ${combined ? `<div class="kb-stat kb-stat-src"><span>Overview</span><b>${escHtml(_kbSource.name)}</b></div>` : ''}
    <div class="kb-stat"><span>Ships Destroyed</span><b class="kb-pos">${formatNumber(s.shipsDestroyed || 0)}</b></div>
    <div class="kb-stat"><span>Ships Lost</span><b class="kb-neg">${formatNumber(s.shipsLost || 0)}</b></div>
    <div class="kb-stat"><span>ISK Destroyed</span><b class="kb-pos">${formatISK(destroyed)}</b></div>
    <div class="kb-stat"><span>ISK Lost</span><b class="kb-neg">${formatISK(lost)}</b></div>
    <div class="kb-stat"><span>ISK Efficiency</span><b>${eff == null ? '—' : eff.toFixed(1) + '%'}</b></div>
    <div class="kb-stat"><span>Solo Kills</span><b>${formatNumber(s.soloKills || 0)}</b></div>
    <div class="kb-stat"><span>Danger Ratio</span><b>${s.dangerRatio == null ? '—' : s.dangerRatio + '%'}</b></div>
    <div class="kb-stat"><span>Rank (all-time)</span><b>${rank == null ? '—' : '#' + formatNumber(rank)}</b></div>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function _kbOpen(url) {
  try { window.eveAPI.openExternalUrl(url); } catch (_) {}
}

function _kbFmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  const mins = Math.floor((now - d) / 60000);
  if (mins < 60)   return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}
