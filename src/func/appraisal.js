// ─── Bulk appraisal ───────────────────────────────────────────────────────────
// Paste a cargo hold / loot pile / contract and get a Jita valuation, in the
// spirit of Janice / EVEPraisal. Lives under Industry → Appraisal.
//
// Prices come from the app's existing getJitaPrices() (Jita 4-4 buy/sell), and
// names resolve through a batched SDE lookup (sde-types-by-names) so a 500-line
// paste costs one query rather than one per line.

let _apRows      = [];   // [{ typeId, name, qty, volume, buy, sell }]
let _apUnmatched = [];   // raw lines we could not resolve
let _apBasis     = 'sell';
let _apRate      = 100;

// Parse "1,000" / "1 000" / "1000" → 1000. Returns 0 for anything non-numeric,
// which callers treat as "this candidate has no quantity".
function _apNum(s) {
  if (s == null) return 0;
  const cleaned = String(s).replace(/[,\s ]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return 0;
  return Math.floor(parseFloat(cleaned)) || 0;
}

// Build the possible readings of one pasted line, best first. We can't decide
// between "Cap Booster 400" (a real item) and "<item> <quantity>" by pattern
// alone, so every plausible split is offered and the SDE picks the winner in
// _apResolve — whichever candidate is a real type name wins.
function _apCandidates(line) {
  const raw = String(line).replace(/\r/g, '').trim();
  if (!raw) return null;
  // Ignore EVE's "Total:" footer and similar non-item rows.
  if (/^total[\s:]/i.test(raw)) return null;

  const cands = [];

  // Tab-separated is EVE's own inventory/contract copy: name, qty, group, …
  if (raw.includes('\t')) {
    const parts = raw.split('\t').map(s => s.trim());
    if (parts[0]) cands.push({ name: parts[0], qty: _apNum(parts[1]) || 1 });
  }

  // The whole line as a name — this is what protects "Cap Booster 400",
  // "125mm Gatling AutoCannon II" and friends from being split.
  cands.push({ name: raw, qty: 1 });

  // "1000 x Tritanium" / "1000x Tritanium" / "1000 Tritanium"
  let m = /^([\d][\d.,\s ]*?)\s*[x×]?\s+(.+)$/i.exec(raw);
  if (m) { const q = _apNum(m[1]); if (q) cands.push({ name: m[2].trim(), qty: q }); }

  // "Tritanium x1000" / "Tritanium 1000"
  m = /^(.+?)\s+[x×]?\s*([\d][\d.,\s ]*)$/i.exec(raw);
  if (m) { const q = _apNum(m[2]); if (q) cands.push({ name: m[1].trim(), qty: q }); }

  return { raw, cands };
}

async function _apResolve(text) {
  const parsed = String(text || '').split('\n').map(_apCandidates).filter(Boolean);
  if (!parsed.length) return { rows: [], unmatched: [] };

  // One batched SDE lookup for every candidate name across every line.
  const allNames = parsed.flatMap(p => p.cands.map(c => c.name));
  const found = await window.eveAPI.sdeTypesByNames(allNames).catch(() => ({}));

  const byType = new Map();   // typeId → aggregated row
  const unmatched = [];

  for (const p of parsed) {
    const hit = p.cands.find(c => found[c.name.toLowerCase()]);
    if (!hit) { unmatched.push(p.raw); continue; }
    const t = found[hit.name.toLowerCase()];
    const existing = byType.get(t.id);
    // The same item can appear on several lines — sum rather than overwrite.
    if (existing) existing.qty += hit.qty;
    else byType.set(t.id, { typeId: t.id, name: t.name, qty: hit.qty, volume: t.volume || 0, buy: 0, sell: 0 });
  }

  const rows = [...byType.values()];
  if (rows.length) {
    const prices = await window.eveAPI.getJitaPrices(rows.map(r => r.typeId)).catch(() => ({})) || {};
    rows.forEach(r => {
      const p = prices[r.typeId] || prices[String(r.typeId)] || {};
      r.buy  = Number(p.buy)  || 0;
      r.sell = Number(p.sell) || 0;
    });
  }
  rows.sort((a, b) => (b.sell * b.qty) - (a.sell * a.qty));
  return { rows, unmatched };
}

// The unit price for the chosen basis, before the rate modifier.
function _apUnit(r) {
  if (_apBasis === 'buy')   return r.buy;
  if (_apBasis === 'split') return (r.buy + r.sell) / 2;
  return r.sell;
}
const _apRateMul = () => (Number(_apRate) || 0) / 100;

function _apTotals() {
  const t = { buy: 0, sell: 0, split: 0, volume: 0, qty: 0, basis: 0 };
  for (const r of _apRows) {
    t.buy    += r.buy * r.qty;
    t.sell   += r.sell * r.qty;
    t.split  += ((r.buy + r.sell) / 2) * r.qty;
    t.volume += (r.volume || 0) * r.qty;
    t.qty    += r.qty;
    t.basis  += _apUnit(r) * r.qty;
  }
  t.basis *= _apRateMul();
  return t;
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function renderAppraisal(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="ap-wrap">
      <div class="ap-input-col">
        <div class="ap-section-label">PASTE ITEMS</div>
        <textarea id="apInput" class="ap-textarea" spellcheck="false"
          placeholder="Paste from your cargo hold, hangar, a contract or a loot pile.

Tritanium	1000
150 x Veldspar
Damage Control II
Cap Booster 400	12"></textarea>
        <div class="ap-controls">
          <label class="ap-ctl">
            <span>Basis</span>
            <select id="apBasis" class="field-input">
              <option value="sell">Jita Sell</option>
              <option value="buy">Jita Buy</option>
              <option value="split">Split</option>
            </select>
          </label>
          <label class="ap-ctl">
            <span>Rate %</span>
            <input id="apRate" class="field-input" type="number" value="100" min="0" max="200" step="1"
                   title="Apply a percentage — handy for buyback offers (e.g. 90%)"/>
          </label>
          <button class="ap-btn primary" id="apRunBtn">Appraise</button>
          <button class="ap-btn" id="apClearBtn">Clear</button>
        </div>
      </div>
      <div class="ap-result-col" id="apResult">
        <div class="ap-empty">Paste a list and hit <b>Appraise</b>.</div>
      </div>
    </div>`;

  const run = () => _apRun();
  document.getElementById('apRunBtn').onclick = run;
  document.getElementById('apClearBtn').onclick = () => {
    document.getElementById('apInput').value = '';
    _apRows = []; _apUnmatched = [];
    document.getElementById('apResult').innerHTML = '<div class="ap-empty">Paste a list and hit <b>Appraise</b>.</div>';
  };
  // Ctrl/Cmd+Enter runs it without reaching for the mouse.
  document.getElementById('apInput').onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  };
  document.getElementById('apBasis').onchange = (e) => { _apBasis = e.target.value; _apRenderResult(); };
  document.getElementById('apRate').oninput   = (e) => { _apRate = e.target.value; _apRenderResult(); };
}

async function _apRun() {
  const text = document.getElementById('apInput')?.value || '';
  const host = document.getElementById('apResult');
  if (!text.trim()) { host.innerHTML = '<div class="ap-empty">Nothing to appraise yet.</div>'; return; }

  host.innerHTML = '<div class="ap-empty">Resolving items and fetching Jita prices…</div>';
  try {
    const { rows, unmatched } = await _apResolve(text);
    _apRows = rows;
    _apUnmatched = unmatched;
    _apRenderResult();
  } catch (e) {
    host.innerHTML = `<div class="ap-empty">Appraisal failed: ${escHtml(e.message)}</div>`;
  }
}

function _apRenderResult() {
  const host = document.getElementById('apResult');
  if (!host) return;
  if (!_apRows.length && !_apUnmatched.length) {
    host.innerHTML = '<div class="ap-empty">Paste a list and hit <b>Appraise</b>.</div>';
    return;
  }

  const t = _apTotals();
  const rated = _apRateMul() !== 1;
  const basisLabel = _apBasis === 'buy' ? 'Jita Buy' : _apBasis === 'split' ? 'Split' : 'Jita Sell';

  const rowsHtml = _apRows.map(r => {
    const unit = _apUnit(r) * _apRateMul();
    const total = unit * r.qty;
    // Flag items with no order book so a 0 isn't mistaken for "worthless".
    const noPrice = !r.buy && !r.sell;
    return `
      <tr${noPrice ? ' class="ap-noprice"' : ''}>
        <td class="ap-td-name">
          <img class="ap-icon" src="https://images.evetech.net/types/${r.typeId}/icon?size=32" alt="" loading="lazy"
               onerror="this.style.display='none'"/>
          ${escHtml(r.name)}${noPrice ? '<span class="ap-tag">no orders</span>' : ''}
        </td>
        <td class="ap-num">${formatNumber(r.qty)}</td>
        <td class="ap-num">${formatISK(unit)}</td>
        <td class="ap-num ap-strong">${formatISK(total)}</td>
        <td class="ap-num ap-dim">${formatNumber((r.volume || 0) * r.qty)} m³</td>
      </tr>`;
  }).join('');

  host.innerHTML = `
    <div class="ap-totals">
      <div class="ap-total-main">
        <div class="ap-total-label">${escHtml(basisLabel)}${rated ? ` @ ${escHtml(String(_apRate))}%` : ''}</div>
        <div class="ap-total-value">${formatISK(t.basis)}</div>
      </div>
      <div class="ap-total-grid">
        <div><span>Jita Sell</span><b>${formatISK(t.sell)}</b></div>
        <div><span>Jita Buy</span><b>${formatISK(t.buy)}</b></div>
        <div><span>Split</span><b>${formatISK(t.split)}</b></div>
        <div><span>Volume</span><b>${formatNumber(t.volume)} m³</b></div>
        <div><span>Items</span><b>${formatNumber(_apRows.length)} / ${formatNumber(t.qty)} units</b></div>
      </div>
    </div>

    <div class="ap-table-wrap">
      <table class="ap-table">
        <thead>
          <tr>
            <th>Item</th><th class="ap-num">Qty</th>
            <th class="ap-num">Unit (${escHtml(basisLabel)})</th>
            <th class="ap-num">Total</th><th class="ap-num">Volume</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>

    ${_apUnmatched.length ? `
      <div class="ap-unmatched">
        <div class="ap-section-label">UNRECOGNISED (${_apUnmatched.length})</div>
        <div class="ap-unmatched-list">${_apUnmatched.map(l => escHtml(l)).join('<br>')}</div>
      </div>` : ''}

    <div class="ap-actions">
      <button class="ap-btn" id="apCopyBtn">Copy summary</button>
    </div>`;

  const copy = document.getElementById('apCopyBtn');
  if (copy) copy.onclick = () => {
    const lines = _apRows.map(r => `${r.name}\t${r.qty}\t${Math.round(_apUnit(r) * _apRateMul())}`);
    const summary = `${basisLabel}${rated ? ` @ ${_apRate}%` : ''}: ${formatISK(t.basis)}\n`
      + `Jita Sell ${formatISK(t.sell)} | Jita Buy ${formatISK(t.buy)} | Volume ${formatNumber(t.volume)} m3\n\n`
      + lines.join('\n');
    try {
      navigator.clipboard.writeText(summary);
      showToast('Appraisal summary copied.', 'success');
    } catch (_) { showToast('Could not copy to clipboard.', 'error'); }
  };
}
