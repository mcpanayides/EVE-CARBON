// ─── Trading / accounting (Finances → Trading) ─────────────────────────────────
// Three tools over already-synced data — no new ESI scopes:
//   • Undercut alerts  — active market orders vs the best competing price at the
//     same station, flagging which are undercut and by how much.
//   • Per-item P&L     — realised profit per item (average-cost method) from your
//     buy/sell transaction history.
//   • Profit over time — daily / weekly realised profit from those transactions.
//
// Orders come from getCharacterOrders (ESI, 5-min cache). Transactions come from
// getWalletTransactions (local DB, ~500 most recent). The best competing price is
// read from public region market orders via esiFetch (cached in-memory per view).

const _TR_ESI = 'https://esi.evetech.net';

let _trView     = 'undercut';       // 'undercut' | 'pnl' | 'profit'
let _trChar     = 'all';            // 'all' or a characterId
let _trGran     = 'day';            // profit-over-time bucket: 'day' | 'week'
let _trAccounts = [];
const _trSort   = {                 // per-view sort state
  undercut: { key: 'status',  dir:  1 },
  pnl:      { key: 'profit',  dir: -1 },
};
const _trOrdersByType = new Map();  // `${regionId}:${typeId}` → competing-orders[]

async function renderTrading(host) {
  if (!host) return;
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(accounts) || !accounts.length) {
    host.innerHTML = '<div class="fin-empty">Add a character to use the trading tools.</div>';
    return;
  }
  _trAccounts = accounts;
  if (_trChar !== 'all' && !accounts.some(a => String(a.characterId) === String(_trChar))) _trChar = 'all';

  const seg = (id, label) =>
    `<button class="tr-seg-btn${_trView === id ? ' active' : ''}" data-tr-view="${id}">${label}</button>`;

  host.innerHTML = `
    <div class="fin-tab-fill tr-wrap">
      <div class="lp-bar tr-bar">
        <div class="tr-seg">
          ${seg('undercut', 'Undercut Alerts')}
          ${seg('pnl', 'Per-Item P&amp;L')}
          ${seg('profit', 'Profit Over Time')}
          ${seg('market', 'vs Jita')}
        </div>
        <select id="trCharSelect" class="field-input" title="Which character(s) to include">
          <option value="all"${_trChar === 'all' ? ' selected' : ''}>All characters</option>
          ${accounts.map(a => `<option value="${a.characterId}"${String(a.characterId) === String(_trChar) ? ' selected' : ''}>${escHtml(a.characterName)}</option>`).join('')}
        </select>
        <span class="tr-controls" id="trControls"></span>
        <span class="lp-status" id="trStatus"></span>
      </div>
      <div class="lp-body" id="trBody"><div class="fin-empty">Loading…</div></div>
    </div>`;

  host.querySelectorAll('.tr-seg-btn').forEach(b => {
    b.onclick = () => { if (b.dataset.trView !== _trView) { _trView = b.dataset.trView; renderTrading(host); } };
  });
  document.getElementById('trCharSelect').onchange = (e) => { _trChar = e.target.value; _trRenderView(); };

  _trRenderView();
}

function _trStatus(m) { const el = document.getElementById('trStatus'); if (el) el.textContent = m || ''; }

function _trAccountsScope() {
  return _trChar === 'all' ? _trAccounts : _trAccounts.filter(a => String(a.characterId) === String(_trChar));
}

function _trRenderView() {
  const controls = document.getElementById('trControls');
  if (controls) controls.innerHTML = '';
  // The "vs Jita" view is all-characters (renderMarket ignores scope), so the
  // per-character selector would be misleading there — hide it for that view.
  const charSel = document.getElementById('trCharSelect');
  if (charSel) charSel.style.display = (_trView === 'market') ? 'none' : '';
  if (_trView === 'undercut') return _trRenderUndercut();
  if (_trView === 'pnl')      return _trRenderPnl();
  if (_trView === 'market')   return _trRenderMarket();
  return _trRenderProfit();
}

// ── "vs Jita" — every active sell order vs the live Jita 4-4 price ──────────────
// Folded in from the retired standalone Market page. Reuses market.js: we inject
// the table skeleton it targets (#marketOrdersBody / #marketSummary) then hand off.
function _trRenderMarket() {
  const body = document.getElementById('trBody');
  if (!body) return;
  body.innerHTML = `
    <div class="tr-summary tr-market-bar">
      <span id="marketSummary" class="asset-summary">Loading…</span>
      <button class="icon-btn tr-market-refresh" onclick="renderMarket()" title="Refresh from ESI">⟳ REFRESH</button>
    </div>
    <div class="lp-table-wrap tr-market-scroll">
      <table class="asset-table tr-market-table">
        <thead><tr>
          <th style="width:44px;"></th>
          <th class="th-item">Item</th>
          <th>Location</th>
          <th class="th-right">Qty</th>
          <th class="th-right">Your Price</th>
          <th class="th-right">Jita 4-4</th>
          <th class="th-right">vs Jita</th>
        </tr></thead>
        <tbody id="marketOrdersBody"><tr><td colspan="7" class="loading-row">Loading market orders…</td></tr></tbody>
      </table>
    </div>
    <div class="lp-note">Every active <b>sell</b> order across your characters, compared to the live Jita 4-4 price
      (green = at/above Jita, red = below). For per-station undercut detection on buys <i>and</i> sells, use Undercut Alerts.</div>`;
  if (typeof renderMarket === 'function') renderMarket();
}

// ── Shared: pull every active order across the in-scope characters ──────────────
async function _trAllOrders() {
  const accounts = _trAccountsScope();
  const orders   = [];
  for (const acc of accounts) {
    try {
      const list = await window.eveAPI.getCharacterOrders(acc.characterId);
      if (Array.isArray(list)) list.forEach(o => orders.push({ ...o, _charId: acc.characterId, _charName: acc.characterName }));
    } catch (_) {}
    await new Promise(r => setTimeout(r, 60));
  }
  return orders;
}

// ── Shared: pull every wallet transaction across the in-scope characters ────────
async function _trAllTransactions() {
  const accounts = _trAccountsScope();
  const txns     = [];
  for (const acc of accounts) {
    try {
      const list = await window.eveAPI.getWalletTransactions(acc.characterId);
      if (Array.isArray(list)) list.forEach(t => txns.push(t));
    } catch (_) {}
  }
  return txns;
}

// Public region orders for one type (paginated; single-type results are tiny, so
// one page is the norm). Cached per view render so an undercut refresh is cheap.
async function _trFetchTypeOrders(regionId, typeId) {
  const key = `${regionId}:${typeId}`;
  if (_trOrdersByType.has(key)) return _trOrdersByType.get(key);
  const all = [];
  for (let page = 1; page <= 5; page++) {
    let batch = null;
    try {
      batch = await window.eveAPI.esiFetch(
        `${_TR_ESI}/v1/markets/${regionId}/orders/?datasource=tranquility&order_type=all&type_id=${typeId}&page=${page}`
      );
    } catch (_) { break; }
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    if (batch.length < 1000) break;   // last page
  }
  _trOrdersByType.set(key, all);
  return all;
}

// Evaluate each order against the best competing order at its own station/side.
// Returns [{ o, isBuy, competing, status: 'undercut'|'best'|'unknown', undercutBy,
// undercutPct }]. Shared by the Undercut view and the background watcher.
async function _trEvaluateUndercuts(orders) {
  const out = [];
  for (const o of orders) {
    const isBuy = !!o.is_buy_order;
    let competing = null, hasMarket = false;
    if (o.region_id && o.type_id) {
      const mkt   = await _trFetchTypeOrders(o.region_id, o.type_id);
      const peers = mkt.filter(m => m.location_id === o.location_id
                                 && !!m.is_buy_order === isBuy
                                 && m.order_id !== o.order_id);
      if (peers.length) {
        hasMarket = true;
        competing = isBuy
          ? Math.max(...peers.map(m => m.price))   // buy: highest bid wins
          : Math.min(...peers.map(m => m.price));  // sell: lowest ask wins
      } else {
        hasMarket = mkt.some(m => m.location_id === o.location_id);  // alone at station
      }
    }
    let status = 'unknown', undercutBy = 0, undercutPct = 0;
    if (competing != null) {
      const beaten = isBuy ? competing > o.price : competing < o.price;
      if (beaten) {
        status      = 'undercut';
        undercutBy  = Math.abs(competing - o.price);
        undercutPct = o.price ? (undercutBy / o.price) * 100 : 0;
      } else {
        status = 'best';
      }
    } else if (hasMarket) {
      status = 'best';
    }
    out.push({ o, isBuy, competing, status, undercutBy, undercutPct });
  }
  return out;
}

// ─── Tool 1: Undercut alerts ────────────────────────────────────────────────────
async function _trRenderUndercut() {
  _trOrdersByType.clear();
  const body = document.getElementById('trBody');
  if (!body) return;
  _trRenderAlertToggle();
  body.innerHTML = '<div class="fin-empty">Loading active orders…</div>';
  _trStatus('Loading orders…');

  const orders = await _trAllOrders();
  if (!orders.length) {
    _trStatus('');
    body.innerHTML = '<div class="fin-empty">No active market orders for the selected character(s).</div>';
    return;
  }

  const names = await _resolveTypeNames([...new Set(orders.map(o => o.type_id).filter(Boolean))]);

  // Best competing price per order, from the order's own region/station.
  _trStatus('Checking market prices…');
  const evals = await _trEvaluateUndercuts(orders);
  const rows = evals.map(e => ({
    typeId:  e.o.type_id,
    name:    names[e.o.type_id] || `Type ${e.o.type_id}`,
    isBuy:   e.isBuy, price: e.o.price || 0,
    competing: e.competing, status: e.status, undercutBy: e.undercutBy, undercutPct: e.undercutPct,
    qty:     e.o.volume_remain || 0,
    charName: e.o._charName || '',
    station:  e.o.location_id,
  }));
  _trStatus('');

  const undercutCount = rows.filter(r => r.status === 'undercut').length;
  const summary = `${rows.length} order${rows.length !== 1 ? 's' : ''} · <span class="lp-neg">${undercutCount} undercut</span> · <span class="lp-pos">${rows.filter(r => r.status === 'best').length} best</span>`;

  const rank = { undercut: 0, best: 1, unknown: 2 };
  const s = _trSort.undercut;
  rows.sort((a, b) => {
    let av, bv;
    switch (s.key) {
      case 'name':  av = a.name.toLowerCase(); bv = b.name.toLowerCase(); return av < bv ? -s.dir : av > bv ? s.dir : 0;
      case 'price': av = a.price; bv = b.price; break;
      case 'undercutBy':  av = a.undercutBy; bv = b.undercutBy; break;
      case 'undercutPct': av = a.undercutPct; bv = b.undercutPct; break;
      default: av = rank[a.status]; bv = rank[b.status];   // 'status'
    }
    return (av - bv) * s.dir;
  });

  const caret = (k) => s.key === k ? (s.dir === 1 ? ' sort-asc' : ' sort-desc') : '';
  const showChar = _trChar === 'all';
  body.innerHTML = `
    <div class="tr-summary">${summary}</div>
    <div class="lp-table-wrap">
      <table class="tr-table" id="trUndercutTable">
        <thead><tr>
          <th data-tr-key="name">Item</th>
          <th>Side</th>
          <th class="lp-num${caret('price')}" data-tr-key="price">Your Price</th>
          <th class="lp-num">Best Rival</th>
          <th class="lp-num${caret('undercutBy')}" data-tr-key="undercutBy">Undercut By</th>
          <th class="lp-num${caret('undercutPct')}" data-tr-key="undercutPct">%</th>
          <th class="lp-num">Qty</th>
          <th class="${caret('status')}" data-tr-key="status">Status</th>
          ${showChar ? '<th>Character</th>' : ''}
        </tr></thead>
        <tbody>${rows.map(r => _trUndercutRow(r, showChar)).join('')}</tbody>
      </table>
    </div>
    <div class="lp-note">Best price is the lowest ask (sell) or highest bid (buy) from other orders in the same station.
      Player structures may not report public orders — those show as “no data”. Undercut by 0.01 ISK to reclaim the top spot.</div>`;

  body.querySelectorAll('th[data-tr-key]').forEach(th => {
    th.ondblclick = () => _trSetSort('undercut', th.dataset.trKey, 'status');
  });
}

function _trUndercutRow(r, showChar) {
  const sideCls = r.isBuy ? 'mo-buy' : 'mo-sell';
  const badge = r.status === 'undercut'
    ? '<span class="tr-pill tr-pill-bad">Undercut</span>'
    : r.status === 'best'
      ? '<span class="tr-pill tr-pill-good">Best</span>'
      : '<span class="tr-pill tr-pill-mut">No data</span>';
  const icon = `<img class="tr-icon" src="https://images.evetech.net/types/${r.typeId}/icon?size=32" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  return `<tr class="${r.status === 'undercut' ? 'tr-row-bad' : ''}">
    <td class="tr-td-name">${icon}<span class="lp-name-txt">${escHtml(r.name)}</span></td>
    <td><span class="tr-side ${sideCls}">${r.isBuy ? 'BUY' : 'SELL'}</span></td>
    <td class="lp-num">${formatISK(r.price)}</td>
    <td class="lp-num lp-dim">${r.competing != null ? formatISK(r.competing) : '—'}</td>
    <td class="lp-num ${r.undercutBy ? 'lp-neg' : 'lp-dim'}">${r.undercutBy ? formatISK(r.undercutBy) : '—'}</td>
    <td class="lp-num ${r.undercutBy ? 'lp-neg' : 'lp-dim'}">${r.undercutBy ? r.undercutPct.toFixed(1) + '%' : '—'}</td>
    <td class="lp-num lp-dim">${formatNumber(r.qty)}</td>
    <td>${badge}</td>
    ${showChar ? `<td class="lp-dim">${escHtml(r.charName)}</td>` : ''}
  </tr>`;
}

// ─── Shared: average-cost basis per type from buy transactions ──────────────────
// avgBuy[type] = Σ(buy qty × price) ÷ Σ(buy qty). Types never bought (acquired
// elsewhere) get 0 → their sells count as pure profit and are flagged.
function _trAvgCost(txns) {
  const buy = {};   // type → { qty, value }
  for (const t of txns) {
    if (!t.is_buy) continue;
    const id = t.type_id;
    (buy[id] || (buy[id] = { qty: 0, value: 0 }));
    buy[id].qty   += t.quantity || 0;
    buy[id].value += (t.quantity || 0) * (t.unit_price || 0);
  }
  const avg = {};
  for (const id in buy) avg[id] = buy[id].qty > 0 ? buy[id].value / buy[id].qty : 0;
  return avg;
}

// ─── Tool 2: Per-item realised P&L ──────────────────────────────────────────────
async function _trRenderPnl() {
  const body = document.getElementById('trBody');
  if (!body) return;
  body.innerHTML = '<div class="fin-empty">Loading transactions…</div>';
  _trStatus('Loading transactions…');

  const txns = await _trAllTransactions();
  _trStatus('');
  if (!txns.length) {
    body.innerHTML = `<div class="fin-empty">No wallet transactions synced yet.<br><br>
      Run a character sync (Characters page) so the app has your market history, then come back.</div>`;
    return;
  }

  const avg = _trAvgCost(txns);
  const byType = {};   // type → aggregate
  for (const t of txns) {
    const id = t.type_id;
    const r = byType[id] || (byType[id] = {
      typeId: id, name: t.type_name || `Type ${id}`,
      buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0,
    });
    if (t.is_buy) { r.buyQty += t.quantity || 0; r.buyValue += (t.quantity || 0) * (t.unit_price || 0); }
    else          { r.sellQty += t.quantity || 0; r.sellValue += (t.quantity || 0) * (t.unit_price || 0); }
  }

  let rows = Object.values(byType).map(r => {
    const avgBuy   = avg[r.typeId] || 0;
    const avgSell  = r.sellQty ? r.sellValue / r.sellQty : 0;
    const costBasis = avgBuy * r.sellQty;
    const profit   = r.sellQty ? r.sellValue - costBasis : 0;
    const margin   = costBasis > 0 ? (profit / costBasis) * 100 : 0;
    return { ...r, avgBuy, avgSell, costBasis, profit, margin, noBasis: r.sellQty > 0 && avgBuy === 0 };
  }).filter(r => r.sellQty > 0 || r.buyQty > 0);

  const totProfit  = rows.reduce((s, r) => s + r.profit, 0);
  const totRevenue = rows.reduce((s, r) => s + r.sellValue, 0);
  const totSpend   = rows.reduce((s, r) => s + r.buyValue, 0);

  const s = _trSort.pnl;
  rows.sort((a, b) => {
    let av, bv;
    switch (s.key) {
      case 'name':    av = a.name.toLowerCase(); bv = b.name.toLowerCase(); return av < bv ? -s.dir : av > bv ? s.dir : 0;
      case 'sellQty': av = a.sellQty; bv = b.sellQty; break;
      case 'avgBuy':  av = a.avgBuy; bv = b.avgBuy; break;
      case 'avgSell': av = a.avgSell; bv = b.avgSell; break;
      case 'revenue': av = a.sellValue; bv = b.sellValue; break;
      case 'margin':  av = a.margin; bv = b.margin; break;
      default:        av = a.profit; bv = b.profit;   // 'profit'
    }
    return (av - bv) * s.dir;
  });

  const caret = (k) => s.key === k ? (s.dir === 1 ? ' sort-asc' : ' sort-desc') : '';
  body.innerHTML = `
    <div class="tr-summary">
      Realised P&amp;L <span class="${totProfit >= 0 ? 'lp-pos' : 'lp-neg'} lp-strong">${formatISK(totProfit)}</span>
      · Revenue <span class="lp-dim">${formatISK(totRevenue)}</span>
      · Spend <span class="lp-dim">${formatISK(totSpend)}</span>
    </div>
    <div class="lp-table-wrap">
      <table class="tr-table" id="trPnlTable">
        <thead><tr>
          <th data-tr-key="name">Item</th>
          <th class="lp-num${caret('sellQty')}" data-tr-key="sellQty">Sold</th>
          <th class="lp-num${caret('avgBuy')}" data-tr-key="avgBuy">Avg Buy</th>
          <th class="lp-num${caret('avgSell')}" data-tr-key="avgSell">Avg Sell</th>
          <th class="lp-num${caret('revenue')}" data-tr-key="revenue">Revenue</th>
          <th class="lp-num${caret('profit')}" data-tr-key="profit">Realised P&amp;L</th>
          <th class="lp-num${caret('margin')}" data-tr-key="margin">Margin</th>
        </tr></thead>
        <tbody>${rows.map(_trPnlRow).join('')}</tbody>
      </table>
    </div>
    <div class="lp-note">Average-cost method: realised P&amp;L = sell revenue − (average buy price × units sold), gross of
      broker fees &amp; sales tax. Based on the most recent ~500 transactions per character; items with no recorded buy
      show as <span class="tr-nobasis">no cost basis</span>.</div>`;

  body.querySelectorAll('th[data-tr-key]').forEach(th => {
    th.ondblclick = () => _trSetSort('pnl', th.dataset.trKey, 'profit');
  });
}

function _trPnlRow(r) {
  const icon = `<img class="tr-icon" src="https://images.evetech.net/types/${r.typeId}/icon?size=32" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  const pnlCls = r.profit > 0 ? 'lp-pos' : r.profit < 0 ? 'lp-neg' : 'lp-dim';
  return `<tr>
    <td class="tr-td-name">${icon}<span class="lp-name-txt">${escHtml(r.name)}${r.noBasis ? ' <span class="tr-nobasis">no basis</span>' : ''}</span></td>
    <td class="lp-num">${formatNumber(r.sellQty)}</td>
    <td class="lp-num lp-dim">${r.avgBuy ? formatISK(r.avgBuy) : '—'}</td>
    <td class="lp-num lp-dim">${r.avgSell ? formatISK(r.avgSell) : '—'}</td>
    <td class="lp-num">${formatISK(r.sellValue)}</td>
    <td class="lp-num ${pnlCls} lp-strong">${r.sellQty ? formatISK(r.profit) : '—'}</td>
    <td class="lp-num ${pnlCls}">${r.costBasis > 0 ? r.margin.toFixed(1) + '%' : '—'}</td>
  </tr>`;
}

// ─── Tool 3: Profit over time ───────────────────────────────────────────────────
async function _trRenderProfit() {
  const controls = document.getElementById('trControls');
  if (controls) {
    controls.innerHTML = `
      <span class="lp-sort">Bucket
        <select id="trGranSelect" class="field-input tr-gran">
          <option value="day"${_trGran === 'day' ? ' selected' : ''}>Daily (30d)</option>
          <option value="week"${_trGran === 'week' ? ' selected' : ''}>Weekly (12w)</option>
        </select>
      </span>`;
    const sel = document.getElementById('trGranSelect');
    if (sel) sel.onchange = (e) => { _trGran = e.target.value; _trRenderProfit(); };
  }

  const body = document.getElementById('trBody');
  if (!body) return;
  body.innerHTML = '<div class="fin-empty">Loading transactions…</div>';
  _trStatus('Loading transactions…');

  const txns = await _trAllTransactions();
  _trStatus('');
  if (!txns.length) {
    body.innerHTML = `<div class="fin-empty">No wallet transactions synced yet.</div>`;
    return;
  }

  const avg = _trAvgCost(txns);
  const buckets = new Map();   // key → { key, label, ts, revenue, spend, profit }
  for (const t of txns) {
    const d = new Date(t.date);
    if (isNaN(d)) continue;
    const { key, label, ts } = _trBucketOf(d, _trGran);
    const b = buckets.get(key) || { key, label, ts, revenue: 0, spend: 0, profit: 0 };
    const val = (t.quantity || 0) * (t.unit_price || 0);
    if (t.is_buy) b.spend += val;
    else { b.revenue += val; b.profit += (t.unit_price - (avg[t.type_id] || 0)) * (t.quantity || 0); }
    buckets.set(key, b);
  }

  const limit = _trGran === 'day' ? 30 : 12;
  const rows  = [...buckets.values()].sort((a, b) => b.ts - a.ts).slice(0, limit).reverse();
  if (!rows.length) {
    body.innerHTML = '<div class="fin-empty">No dated transactions to chart.</div>';
    return;
  }

  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(r.profit)));
  const totProfit = rows.reduce((s, r) => s + r.profit, 0);
  const bars = rows.map(r => {
    const pct = (Math.abs(r.profit) / maxAbs) * 100;
    const pos = r.profit >= 0;
    return `<div class="tr-bar-row" title="${escHtml(r.label)} · ${formatISK(r.profit)}">
      <span class="tr-bar-label">${escHtml(r.label)}</span>
      <span class="tr-bar-track">
        <span class="tr-bar-fill ${pos ? 'tr-bar-pos' : 'tr-bar-neg'}" style="width:${pct.toFixed(1)}%"></span>
      </span>
      <span class="tr-bar-val ${pos ? 'lp-pos' : 'lp-neg'}">${formatISK(r.profit)}</span>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="tr-summary">
      Realised P&amp;L over ${rows.length} ${_trGran === 'day' ? 'day' : 'week'}${rows.length !== 1 ? 's' : ''}:
      <span class="${totProfit >= 0 ? 'lp-pos' : 'lp-neg'} lp-strong">${formatISK(totProfit)}</span>
    </div>
    <div class="tr-bars">${bars}</div>
    <div class="lp-note">Realised profit per period = Σ over sells of (sell price − average buy price) × qty, using the
      average-cost basis across your synced transactions. Gross of broker fees &amp; sales tax; limited to ~500
      transactions per character.</div>`;
}

// Day bucket → "Jul 20"; week bucket → ISO "2026-W30" labelled by its Monday.
function _trBucketOf(d, gran) {
  if (gran === 'week') {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = (dt.getUTCDay() + 6) % 7;             // Mon=0
    dt.setUTCDate(dt.getUTCDate() - day);             // back to Monday
    const key = dt.toISOString().slice(0, 10);
    return { key, ts: dt.getTime(), label: 'w/c ' + dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
  }
  const key = d.toISOString().slice(0, 10);
  const ts  = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { key, ts, label: new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
}

// Double-click a header to sort; clicking the active column flips direction.
function _trSetSort(view, key, defaultKey) {
  if (!key) return;
  const s = _trSort[view];
  if (s.key === key) s.dir = -s.dir;
  else { s.key = key; s.dir = (key === 'name') ? 1 : -1; }
  if (view === 'undercut') _trRenderUndercut();
  else if (view === 'pnl') _trRenderPnl();
}

// ─── Background undercut watcher (opt-in) ───────────────────────────────────────
// When enabled, re-checks every character's orders on an interval and fires a
// non-blocking toast the moment a NEW order becomes undercut. Persisted under
// config.app.trading.undercutAlerts; toggled from the Undercut Alerts view.

const TR_WATCH_MS = 5 * 60 * 1000;   // orders are ESI-cached ~5 min anyway
let _trWatchTimer = null;
let _trWatchSeen  = null;            // Set of order_ids currently undercut (null = not yet seeded)

async function _trGetAlertSetting() {
  try {
    const app = ((await window.eveAPI.getAppConfig()) || {}).app || {};
    return !!(app.trading && app.trading.undercutAlerts);
  } catch (_) { return false; }
}

// Toggle checkbox shown in the Undercut Alerts view's controls slot.
async function _trRenderAlertToggle() {
  const controls = document.getElementById('trControls');
  if (!controls) return;
  const on = await _trGetAlertSetting();
  controls.innerHTML = `
    <label class="tr-alert-toggle" title="Watch your orders in the background and toast you when a new undercut appears">
      <input type="checkbox" id="trAlertChk"${on ? ' checked' : ''}> 🔔 Alert me when undercut
    </label>`;
  const chk = document.getElementById('trAlertChk');
  if (chk) chk.onchange = async () => {
    try { await window.eveAPI.saveAppConfig({ trading: { undercutAlerts: chk.checked } }); } catch (_) {}
    if (chk.checked) { startUndercutWatch(); showToast('Undercut alerts on — watching your orders.', 'success'); }
    else             { stopUndercutWatch();  showToast('Undercut alerts off.', 'info'); }
  };
}

async function _trUndercutWatchTick() {
  try {
    const accounts = await window.eveAPI.getAccounts().catch(() => []);
    if (!Array.isArray(accounts) || !accounts.length) return;

    const orders = [];
    for (const acc of accounts) {
      try {
        const list = await window.eveAPI.getCharacterOrders(acc.characterId);
        if (Array.isArray(list)) list.forEach(o => orders.push({ ...o, _charName: acc.characterName }));
      } catch (_) {}
      await new Promise(r => setTimeout(r, 60));
    }
    if (!orders.length) return;

    _trOrdersByType.clear();                       // fresh market snapshot this tick
    const evals    = await _trEvaluateUndercuts(orders);
    const undercut = evals.filter(e => e.status === 'undercut');
    const nowSet   = new Set(undercut.map(e => e.o.order_id));

    // First run just seeds the baseline — don't toast for pre-existing undercuts.
    if (_trWatchSeen === null) { _trWatchSeen = nowSet; return; }

    const fresh = undercut.filter(e => !_trWatchSeen.has(e.o.order_id));
    _trWatchSeen = nowSet;
    if (!fresh.length) return;

    const names = await _resolveTypeNames([...new Set(fresh.map(e => e.o.type_id))]);
    if (fresh.length === 1) {
      const e = fresh[0];
      pushAppToast({
        kind: 'warn', title: 'You’ve been undercut',
        body: `${names[e.o.type_id] || 'An order'} — rival ${formatISK(e.competing)} vs your ${formatISK(e.o.price)} (${e.undercutPct.toFixed(1)}%). Click to review.`,
        onClick: _trOpenUndercutView,
      });
    } else {
      const preview = fresh.slice(0, 3).map(e => names[e.o.type_id] || 'order').join(', ');
      pushAppToast({
        kind: 'warn', title: `${fresh.length} orders undercut`,
        body: `${preview}${fresh.length > 3 ? '…' : ''} — click to review.`,
        onClick: _trOpenUndercutView,
      });
    }
  } catch (_) { /* transient — try again next tick */ }
}

// Toast click → jump to Finances → Trading → Undercut Alerts.
function _trOpenUndercutView() {
  _trView = 'undercut';
  try { if (typeof navigateToPage === 'function') navigateToPage('wallets'); } catch (_) {}
  setTimeout(() => { try { if (typeof navigateFinancesTab === 'function') navigateFinancesTab('trading'); } catch (_) {} }, 60);
}

function startUndercutWatch() {
  if (_trWatchTimer) return;
  _trWatchSeen = null;                 // re-seed baseline on (re)start
  _trUndercutWatchTick();
  _trWatchTimer = setInterval(_trUndercutWatchTick, TR_WATCH_MS);
}

function stopUndercutWatch() {
  if (_trWatchTimer) { clearInterval(_trWatchTimer); _trWatchTimer = null; }
  _trWatchSeen = null;
}

// Start the watcher at boot if the user left it enabled. Waits a beat so accounts
// and config IPC are ready; harmless if there are no orders.
(function _trInitUndercutWatch() {
  const boot = () => setTimeout(async () => {
    if (await _trGetAlertSetting()) startUndercutWatch();
  }, 4000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
