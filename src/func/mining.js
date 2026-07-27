// ─── Mining Ledger (Industry → Mining) ──────────────────────────────────────────
// Per-character (and combined) mining yield from the ESI personal mining ledger,
// valued either as raw ore at market or as refined minerals via the same SDE
// reprocessing math the Ore-hold calculator uses. Plus corp moon-extraction
// timers where the character has the corp role.
//
//   ESI: /characters/{id}/mining/                (esi-industry.read_character_mining.v1)
//        /corporation/{corp}/mining/extractions/ (esi-industry.read_corporation_mining.v1 + role)
//        /corporation/{corp}/mining/observers/…
//
// The personal ledger is UPSERTed into CharDB, so it grows into a longer history
// than ESI's own 30-day window as you keep syncing. Nothing else is stored.

let _mlChar      = 'all';        // 'all' or a characterId
let _mlView      = 'ore';        // 'ore' | 'daily' | 'moon'
let _mlBasis     = 'refined';    // 'ore' | 'refined'
let _mlPriceMode = 'sell';       // 'sell' | 'buy'
let _mlRefinePct = 87.6;         // reprocessing efficiency for the refined basis
let _mlRange     = 30;           // days; 0 = all stored
let _mlSort      = { key: 'value', dir: -1 };
let _mlAccounts  = [];

let _mlLedger    = [];           // merged ledger rows for the current scope
let _mlNames     = {};           // typeId → ore name
let _mlOrePrices = {};           // typeId → { buy, sell }
let _mlReprocess = {};           // nameLower → { portionSize, materials:[{id,name,quantity}] }
let _mlMatPrices = {};           // materialId → { buy, sell }
let _mlSyncMsg   = '';

async function renderMiningLedger(host) {
  if (!host) return;
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(accounts) || !accounts.length) {
    host.innerHTML = '<div class="fin-empty">Add a character to use the Mining Ledger.</div>';
    return;
  }
  _mlAccounts = accounts;
  if (_mlChar !== 'all' && !accounts.some(a => String(a.characterId) === String(_mlChar))) _mlChar = 'all';

  const seg = (id, label) => `<button class="tr-seg-btn${_mlView === id ? ' active' : ''}" data-ml-view="${id}">${label}</button>`;
  host.innerHTML = `
    <div class="fin-tab-fill tr-wrap ml-wrap">
      <div class="lp-bar tr-bar ml-bar">
        <div class="tr-seg">
          ${seg('ore', 'By Ore')}
          ${seg('daily', 'Daily')}
          ${seg('moon', 'Moon Extractions')}
        </div>
        <select id="mlCharSelect" class="field-input" title="Which character(s)">
          <option value="all"${_mlChar === 'all' ? ' selected' : ''}>All characters</option>
          ${accounts.map(a => `<option value="${a.characterId}"${String(a.characterId) === String(_mlChar) ? ' selected' : ''}>${escHtml(a.characterName)}</option>`).join('')}
        </select>
        <span class="tr-controls" id="mlControls"></span>
        <span class="lp-status" id="mlStatus"></span>
      </div>
      <div class="lp-body" id="mlBody"><div class="fin-empty">Loading mining ledger…</div></div>
    </div>`;

  document.getElementById('mlCharSelect').onchange = (e) => { _mlChar = e.target.value; _mlLoadAndRender().then(() => _mlEnsureFresh()); };
  host.querySelectorAll('.tr-seg-btn').forEach(b => {
    b.onclick = () => {
      if (b.dataset.mlView === _mlView) return;
      _mlView = b.dataset.mlView;
      host.querySelectorAll('.tr-seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mlView === _mlView));
      _mlRenderView();
    };
  });

  await _mlLoadAndRender();   // show stored data immediately…
  _mlEnsureFresh();           // …then pull from ESI in the background (throttled to its cache)
  _mlStartAutoRefresh();
}

// ESI caches the mining ledger for 1 hour, so there's nothing to gain from a manual
// button — we just keep it current. The sync IPC self-throttles to that window, so
// this ticks often and only actually reaches ESI once the cache has rolled over.
let _mlRefreshTimer = null;
function _mlStartAutoRefresh() {
  if (_mlRefreshTimer) clearInterval(_mlRefreshTimer);
  _mlRefreshTimer = setInterval(() => {
    if (document.querySelector('.ml-wrap')) _mlEnsureFresh();
    else { clearInterval(_mlRefreshTimer); _mlRefreshTimer = null; }   // page gone — stop
  }, 5 * 60 * 1000);
}

// Pull the latest ledger for the in-scope character(s). The IPC returns quickly
// (throttled: true) when ESI's cache hasn't expired; we only re-render when a real
// fetch brought new data, so the view doesn't flicker on every tick.
let _mlScopeIssue = null;
async function _mlEnsureFresh() {
  let changed = false, scopeIssue = null;
  for (const acc of _mlScopeAccounts()) {
    let res = null;
    try { res = await window.eveAPI.syncMiningLedger(acc.characterId); } catch (_) {}
    if (res && res.ok && !res.throttled) changed = true;
    else if (res && res.reason === 'scope') scopeIssue = res.message;
  }
  _mlScopeIssue = scopeIssue;
  if (changed) await _mlLoadAndRender();
  else if (scopeIssue && !_mlLedger.length) _mlRenderView();   // surface the re-auth note
}

function _mlStatus(m) { const el = document.getElementById('mlStatus'); if (el) el.textContent = m || ''; }
function _mlScopeAccounts() {
  return _mlChar === 'all' ? _mlAccounts : _mlAccounts.filter(a => String(a.characterId) === String(_mlChar));
}

// Pull the stored ledger for the scope, then price everything, then render.
async function _mlLoadAndRender() {
  const body = document.getElementById('mlBody');
  if (body) body.innerHTML = '<div class="fin-empty">Loading mining ledger…</div>';
  _mlStatus('Loading…');

  // Merge each in-scope character's stored ledger by (date, system, type).
  const merged = new Map();
  for (const acc of _mlScopeAccounts()) {
    let rows = [];
    try { rows = await window.eveAPI.getMiningLedgerDb(acc.characterId); } catch (_) {}
    (Array.isArray(rows) ? rows : []).forEach(r => {
      const key = `${r.date}|${r.solar_system_id}|${r.type_id}`;
      const cur = merged.get(key);
      if (cur) cur.quantity += r.quantity || 0;
      else merged.set(key, { date: r.date, solar_system_id: r.solar_system_id, type_id: r.type_id, quantity: r.quantity || 0 });
    });
  }
  _mlLedger = [...merged.values()];
  _mlStatus('');

  if (_mlLedger.length) await _mlPrice();
  _mlRenderView();
}

// Resolve ore names, ore market prices, reprocessing outputs + mineral prices.
async function _mlPrice() {
  const typeIds = [...new Set(_mlLedger.map(r => r.type_id).filter(Boolean))];
  _mlNames = typeof _resolveTypeNames === 'function' ? await _resolveTypeNames(typeIds) : {};
  try { _mlOrePrices = await window.eveAPI.getJitaPrices(typeIds) || {}; } catch (_) { _mlOrePrices = {}; }

  // Reprocessing yields (by name) + mineral prices — only needed for refined basis.
  try {
    const names = typeIds.map(id => _mlNames[id]).filter(Boolean);
    _mlReprocess = names.length ? (await window.eveAPI.reprocessFromNames(names) || {}) : {};
  } catch (_) { _mlReprocess = {}; }
  const matIds = [...new Set(Object.values(_mlReprocess).flatMap(e => (e.materials || []).map(m => m.id)))];
  try { _mlMatPrices = matIds.length ? (await window.eveAPI.getJitaPrices(matIds) || {}) : {}; }
  catch (_) { _mlMatPrices = {}; }
}

// ISK value of one unit of an ore type under the current basis/price settings.
function _mlUnitValue(typeId) {
  const pick = (p) => _mlPriceMode === 'buy' ? (p.buy || 0) : (p.sell || p.buy || 0);
  if (_mlBasis === 'ore') return pick(_mlOrePrices[typeId] || {});
  const entry = _mlReprocess[(_mlNames[typeId] || '').toLowerCase()];
  if (!entry || !entry.portionSize) return 0;
  let per = 0;
  for (const m of (entry.materials || [])) per += (m.quantity || 0) * pick(_mlMatPrices[m.id] || {});
  return (per / entry.portionSize) * (_mlRefinePct / 100);
}

function _mlCutoff() {
  if (!_mlRange) return '0000-00-00';
  return new Date(Date.now() - _mlRange * 86400000).toISOString().slice(0, 10);
}
function _mlRowsInRange() {
  const cutoff = _mlCutoff();
  return _mlLedger.filter(r => (r.date || '') >= cutoff);
}

// ── Shared top-bar controls per view ────────────────────────────────────────────
function _mlRenderControls() {
  const el = document.getElementById('mlControls');
  if (!el) return;
  if (_mlView === 'moon') { el.innerHTML = ''; return; }
  el.innerHTML = `
    <select id="mlRange" class="field-input ml-mini" title="Date range">
      <option value="7"${_mlRange === 7 ? ' selected' : ''}>Last 7d</option>
      <option value="30"${_mlRange === 30 ? ' selected' : ''}>Last 30d</option>
      <option value="90"${_mlRange === 90 ? ' selected' : ''}>Last 90d</option>
      <option value="0"${_mlRange === 0 ? ' selected' : ''}>All stored</option>
    </select>
    <select id="mlBasis" class="field-input ml-mini" title="Value ore at market, or as refined minerals">
      <option value="refined"${_mlBasis === 'refined' ? ' selected' : ''}>Refined value</option>
      <option value="ore"${_mlBasis === 'ore' ? ' selected' : ''}>Ore market</option>
    </select>
    <select id="mlPriceMode" class="field-input ml-mini" title="Jita price side">
      <option value="sell"${_mlPriceMode === 'sell' ? ' selected' : ''}>Jita sell</option>
      <option value="buy"${_mlPriceMode === 'buy' ? ' selected' : ''}>Jita buy</option>
    </select>
    <label class="ml-refine${_mlBasis === 'refined' ? '' : ' ml-hide'}" title="Reprocessing efficiency">refine
      <input id="mlRefine" class="field-input ml-mini" type="number" min="0" max="100" step="0.1" value="${_mlRefinePct}">%
    </label>`;
  const reRender = () => _mlRenderView();
  const r = document.getElementById('mlRange');      if (r) r.onchange = (e) => { _mlRange = Number(e.target.value); reRender(); };
  const b = document.getElementById('mlBasis');      if (b) b.onchange = (e) => { _mlBasis = e.target.value; reRender(); };
  const pm = document.getElementById('mlPriceMode'); if (pm) pm.onchange = (e) => { _mlPriceMode = e.target.value; reRender(); };
  const rf = document.getElementById('mlRefine');    if (rf) rf.onchange = (e) => { _mlRefinePct = Math.max(0, Math.min(100, Number(e.target.value) || 0)); reRender(); };
}

function _mlRenderView() {
  _mlRenderControls();
  if (_mlView === 'moon') return _mlRenderMoon();
  if (_mlView === 'daily') return _mlRenderDaily();
  return _mlRenderOre();
}

// ── View 1: aggregate by ore type ───────────────────────────────────────────────
function _mlRenderOre() {
  const body = document.getElementById('mlBody');
  if (!body) return;
  const rows = _mlRowsInRange();
  if (!rows.length) return _mlEmpty(body);

  const byType = {};
  for (const r of rows) {
    const t = byType[r.type_id] || (byType[r.type_id] = { typeId: r.type_id, qty: 0 });
    t.qty += r.quantity || 0;
  }
  let list = Object.values(byType).map(t => {
    const unit  = _mlUnitValue(t.typeId);
    const value = unit * t.qty;
    return { ...t, name: _mlNames[t.typeId] || `Type ${t.typeId}`, unit, value };
  });
  const total = list.reduce((s, r) => s + r.value, 0);
  const units = list.reduce((s, r) => s + r.qty, 0);

  const s = _mlSort;
  list.sort((a, b) => {
    let av, bv;
    switch (s.key) {
      case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); return av < bv ? -s.dir : av > bv ? s.dir : 0;
      case 'qty':  av = a.qty; bv = b.qty; break;
      case 'unit': av = a.unit; bv = b.unit; break;
      default:     av = a.value; bv = b.value;
    }
    return (av - bv) * s.dir;
  });

  const caret = (k) => s.key === k ? (s.dir === 1 ? ' sort-asc' : ' sort-desc') : '';
  const basisLabel = _mlBasis === 'refined' ? `refined @ ${_mlRefinePct}%` : 'ore market';
  body.innerHTML = `
    <div class="tr-summary">
      Est. value <span class="lp-pos lp-strong">${formatISK(total)}</span>
      · ${formatNumber(units)} units · ${list.length} ore type${list.length !== 1 ? 's' : ''}
      <span class="lp-dim">(${basisLabel}, Jita ${_mlPriceMode})</span>
    </div>
    <div class="lp-table-wrap">
      <table class="tr-table" id="mlOreTable">
        <thead><tr>
          <th data-ml-key="name">Ore</th>
          <th class="lp-num${caret('qty')}" data-ml-key="qty">Units</th>
          <th class="lp-num${caret('unit')}" data-ml-key="unit">ISK / Unit</th>
          <th class="lp-num${caret('value')}" data-ml-key="value">Value</th>
          <th class="lp-num">Share</th>
        </tr></thead>
        <tbody>${list.map(r => _mlOreRow(r, total)).join('')}</tbody>
      </table>
    </div>
    <div class="lp-note">Refined value uses the same SDE reprocessing yields as the Ore-hold calculator, scaled by your
      reprocessing efficiency. Set it to your station rate × skills (perfect skills at a 50% NPC station ≈ 87.6%).</div>`;

  body.querySelectorAll('th[data-ml-key]').forEach(th => {
    th.ondblclick = () => { const k = th.dataset.mlKey; if (_mlSort.key === k) _mlSort.dir = -_mlSort.dir; else { _mlSort.key = k; _mlSort.dir = (k === 'name') ? 1 : -1; } _mlRenderView(); };
  });
}

function _mlOreRow(r, total) {
  const icon = `<img class="tr-icon" src="https://images.evetech.net/types/${r.typeId}/icon?size=32" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  const share = total > 0 ? (r.value / total) * 100 : 0;
  return `<tr>
    <td class="tr-td-name">${icon}<span class="lp-name-txt">${escHtml(r.name)}</span></td>
    <td class="lp-num">${formatNumber(r.qty)}</td>
    <td class="lp-num lp-dim">${r.unit ? formatISK(r.unit) : '—'}</td>
    <td class="lp-num lp-strong">${formatISK(r.value)}</td>
    <td class="lp-num lp-dim">${share.toFixed(1)}%</td>
  </tr>`;
}

// ── View 2: daily mined value ───────────────────────────────────────────────────
function _mlRenderDaily() {
  const body = document.getElementById('mlBody');
  if (!body) return;
  const rows = _mlRowsInRange();
  if (!rows.length) return _mlEmpty(body);

  const byDay = {};
  for (const r of rows) {
    const d = byDay[r.date] || (byDay[r.date] = { date: r.date, value: 0, qty: 0 });
    d.value += _mlUnitValue(r.type_id) * (r.quantity || 0);
    d.qty   += r.quantity || 0;
  }
  const days = Object.values(byDay).sort((a, b) => (a.date < b.date ? -1 : 1));
  const maxV = Math.max(1, ...days.map(d => d.value));
  const total = days.reduce((s, d) => s + d.value, 0);
  const avg   = days.length ? total / days.length : 0;

  const bars = days.map(d => {
    const pct = (d.value / maxV) * 100;
    const label = new Date(d.date + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<div class="tr-bar-row" title="${escHtml(label)} · ${formatISK(d.value)} · ${formatNumber(d.qty)} units">
      <span class="tr-bar-label">${escHtml(label)}</span>
      <span class="tr-bar-track"><span class="tr-bar-fill tr-bar-pos" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="tr-bar-val lp-pos">${formatISK(d.value)}</span>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="tr-summary">
      ${days.length} active day${days.length !== 1 ? 's' : ''} · total <span class="lp-pos lp-strong">${formatISK(total)}</span>
      · avg/day <span class="lp-dim">${formatISK(avg)}</span>
    </div>
    <div class="tr-bars">${bars}</div>
    <div class="lp-note">Daily mined value at the current basis (${_mlBasis === 'refined' ? `refined @ ${_mlRefinePct}%` : 'ore market'}, Jita ${_mlPriceMode}).</div>`;
}

// ── View 3: corp moon extractions ───────────────────────────────────────────────
async function _mlRenderMoon() {
  const body = document.getElementById('mlBody');
  if (!body) return;
  body.innerHTML = '<div class="fin-empty">Loading corp mining data…</div>';
  _mlStatus('Loading corp data…');

  // Corp data is per-corp: use the selected character, or the first account for "all".
  const acc = _mlChar === 'all' ? _mlAccounts[0] : _mlAccounts.find(a => String(a.characterId) === String(_mlChar));
  if (!acc) { _mlStatus(''); return _mlEmpty(body); }

  let ext = null, obs = null;
  try { ext = await window.eveAPI.getCorpMiningExtractions(acc.characterId); } catch (_) {}
  try { obs = await window.eveAPI.getCorpMiningObservers(acc.characterId); } catch (_) {}
  _mlStatus('');

  const gate = ext || obs || {};
  if ((!ext || !ext.ok) && (!obs || !obs.ok)) {
    const reason = (ext && ext.reason) || (obs && obs.reason);
    const msg = reason === 'scope'
      ? 'This character hasn’t granted corp mining access. Re-authenticate it (Characters page) to enable moon extractions.'
      : reason === 'role'
        ? 'Your character can authorise the scope, but the corp mining ledger needs the in-game <b>Station Manager</b> or <b>Accountant</b> role. Ask a director to assign it.'
        : 'Corp mining data isn’t available for this character right now.';
    body.innerHTML = `<div class="fin-firstrun"><h3>Moon Extractions</h3><p>${msg}</p></div>`;
    return;
  }

  const now = Date.now();
  const exList = (ext && ext.ok && Array.isArray(ext.extractions)) ? ext.extractions.slice() : [];
  exList.sort((a, b) => new Date(a.chunk_arrival_time) - new Date(b.chunk_arrival_time));
  const extHtml = exList.length ? exList.map(e => {
    const arrive = new Date(e.chunk_arrival_time).getTime();
    const left   = arrive - now;
    const when   = new Date(arrive).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const cd     = left > 0 ? `<span class="lp-pos">${_mlDur(left)}</span>` : `<span class="lp-dim">arrived</span>`;
    return `<tr>
      <td>${escHtml(e.moon_name || ('Moon ' + e.moon_id))}</td>
      <td class="lp-num lp-dim">${escHtml(when)}</td>
      <td class="lp-num">${cd}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="3" class="lp-dim" style="padding:14px;">No scheduled extractions.</td></tr>`;

  // Per-character corp pull totals from observers (this month's recorded volume).
  let obsHtml = '';
  if (obs && obs.ok && Array.isArray(obs.entries) && obs.entries.length) {
    const byChar = {};
    for (const e of obs.entries) {
      const c = byChar[e.character_id] || (byChar[e.character_id] = { name: e.character_name, qty: 0 });
      c.qty += e.quantity || 0;
    }
    const top = Object.values(byChar).sort((a, b) => b.qty - a.qty).slice(0, 25);
    obsHtml = `
      <div class="tr-summary" style="border-top:1px solid var(--border);">Corp miners (recorded units by character)</div>
      <div class="lp-table-wrap"><table class="tr-table">
        <thead><tr><th>Character</th><th class="lp-num">Units pulled</th></tr></thead>
        <tbody>${top.map(c => `<tr><td>${escHtml(c.name)}</td><td class="lp-num lp-strong">${formatNumber(c.qty)}</td></tr>`).join('')}</tbody>
      </table></div>`;
  }

  body.innerHTML = `
    <div class="tr-summary">Moon extractions · corp ${gate.corporationId || ''}</div>
    <div class="lp-table-wrap"><table class="tr-table">
      <thead><tr><th>Moon</th><th class="lp-num">Chunk arrives</th><th class="lp-num">Countdown</th></tr></thead>
      <tbody>${extHtml}</tbody>
    </table></div>
    ${obsHtml}
    <div class="lp-note">Extraction chunk-arrival times and per-miner pull volumes come from the corp mining ledger
      (needs the in-game Station Manager or Accountant role).</div>`;
}

function _mlEmpty(body) {
  const scopeNote = _mlScopeIssue
    ? `<p class="fin-dim">${_mlScopeIssue} Re-authenticate on the Characters page to enable it.</p>`
    : `<p class="fin-dim">Pulling the last ~30 days from ESI… it updates automatically every hour (ESI's cache window),
        and results accumulate into a longer local history over time. If nothing appears, this character may need the
        <code>esi-industry.read_character_mining.v1</code> scope — re-authenticate it on the Characters page.</p>`;
  body.innerHTML = `<div class="fin-firstrun">
    <h3>Mining Ledger</h3>
    <p>No mining recorded for the selected character(s) yet.</p>
    ${scopeNote}
  </div>`;
}

// Compact duration like "2d 4h" / "3h 12m".
function _mlDur(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

