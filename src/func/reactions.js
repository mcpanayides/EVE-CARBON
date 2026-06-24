// reactions.js — Reactions Profit calculator
//
// Fuzzwork-style reaction profitability, but as a grid of elegant cards instead
// of a table. Each card is one reaction formula; clicking it opens a modal with
// the input materials, their quantities, volume (m³) and total cost at the
// chosen market hub, plus the net profit.
//
// Data comes from the SDE in one round-trip (window.eveAPI.reactionsList()):
// every reaction formula with its product and full input-material list. Prices
// come from window.eveAPI.getHubPrices(typeIds, hub).
//
// The "scrap return" slider (0–5) models the unrefined materials a reaction
// returns via Scrap Metal Processing — each level credits 1% of the input cost
// back, reducing the effective build cost. It's an approximation, surfaced
// clearly in the modal.

// ── State ──────────────────────────────────────────────────────────────────
let _rxFormulas   = null;   // [{ formulaTypeId, formulaName, productTypeId, ... materials:[] }]
let _rxPrices     = {};     // typeId -> { buy, sell }
let _rxHubMeta    = null;   // { jita: {...}, amarr: {...}, ... }
let _rxHub        = 'jita';
let _rxScrapLevel = 0;      // 0–5 (Scrap Metal Processing skill), 1% return per level
let _rxSearch     = '';
let _rxGroup      = 'all';
let _rxSort       = 'profit';
let _rxLoading    = false;
let _rxPricesLoaded = false;

const RX_HUB_LABELS = { jita: 'Jita', amarr: 'Amarr', dodixie: 'Dodixie', rens: 'Rens', hek: 'Hek' };

// Colour coding for reaction product groups (Composite / Intermediate Materials /
// Hybrid Polymers / Biochemical Material / Molecular-Forged Materials …).
function _rxGroupColor(group) {
  const g = (group || '').toLowerCase();
  if (g.includes('composite'))          return '#ab7ab8'; // purple
  if (g.includes('intermediate'))       return '#5b9bd5'; // blue
  if (g.includes('hybrid'))             return '#4ecbb0'; // teal
  if (g.includes('polymer'))            return '#4ecbb0'; // teal
  if (g.includes('biochemical'))        return '#e3a84d'; // amber (boosters)
  if (g.includes('molecular'))          return '#c05c7e'; // pink
  return '#7d8fa3';                                        // grey fallback
}

// ── Entry point ─────────────────────────────────────────────────────────────
async function renderReactionsCalculator(container) {
  container.innerHTML = `
    <div class="rx-wrap">
      <div class="rx-toolbar">
        <span class="rx-toolbar-label">REACTIONS PROFIT</span>

        <div class="rx-hub-picker" id="rxHubPicker"></div>

        <div class="rx-scrap" title="Scrap Metal Processing — unrefined materials returned by the reaction. Each level credits 1% of input cost back.">
          SCRAP RETURN
          <input type="range" id="rxScrapSlider" min="0" max="5" step="1" value="${_rxScrapLevel}">
          <span class="rx-scrap-val" id="rxScrapVal">${_rxScrapLevel}%</span>
        </div>

        <input id="rxSearch" class="field-input" style="flex:1;min-width:160px;max-width:280px;"
               placeholder="Search reactions…" value="${escHtml(_rxSearch)}"/>

        <select id="rxGroup" class="field-input" style="width:160px;"></select>

        <select id="rxSort" class="field-input" style="width:140px;">
          <option value="profit">Profit High-Low</option>
          <option value="margin">Margin High-Low</option>
          <option value="output">Output Value</option>
          <option value="name">Name (A–Z)</option>
          <option value="group">Group</option>
        </select>

        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);margin-left:auto;">
          <span id="rxCount">0</span> formulas
        </span>
      </div>

      <div id="rxGrid" class="rx-grid"></div>
    </div>`;

  _rxBuildHubPicker();
  _rxBindToolbar();

  await _rxLoadData();
}

function _rxBuildHubPicker() {
  const wrap = document.getElementById('rxHubPicker');
  if (!wrap) return;
  const hubs = _rxHubMeta ? Object.keys(_rxHubMeta) : Object.keys(RX_HUB_LABELS);
  wrap.innerHTML = hubs.map(h =>
    `<button class="rx-hub-btn ${h === _rxHub ? 'active' : ''}" data-hub="${h}">
       ${escHtml(RX_HUB_LABELS[h] || h)}
     </button>`).join('');
  wrap.querySelectorAll('.rx-hub-btn').forEach(btn =>
    btn.addEventListener('click', () => _rxSetHub(btn.dataset.hub)));
}

function _rxBindToolbar() {
  const slider = document.getElementById('rxScrapSlider');
  if (slider) slider.addEventListener('input', e => _rxSetScrapLevel(parseInt(e.target.value) || 0));

  const search = document.getElementById('rxSearch');
  if (search) search.addEventListener('input', e => {
    _rxSearch = e.target.value.trim().toLowerCase();
    _rxRenderGrid();
  });

  const group = document.getElementById('rxGroup');
  if (group) group.addEventListener('change', e => { _rxGroup = e.target.value; _rxRenderGrid(); });

  const sort = document.getElementById('rxSort');
  if (sort) { sort.value = _rxSort; sort.addEventListener('change', e => { _rxSort = e.target.value; _rxRenderGrid(); }); }
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function _rxLoadData() {
  if (_rxLoading) return;
  _rxLoading = true;

  const grid = document.getElementById('rxGrid');
  if (grid) grid.innerHTML = _rxLoadingCards();

  try {
    if (!_rxHubMeta) {
      try { _rxHubMeta = await window.eveAPI.getHubMeta(); _rxBuildHubPicker(); } catch (_) {}
    }
    if (!_rxFormulas) {
      _rxFormulas = await window.eveAPI.reactionsList();
    }

    if (!Array.isArray(_rxFormulas) || !_rxFormulas.length) {
      if (grid) grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;margin-top:60px;">
          <div class="empty-icon">◈</div>
          <div class="empty-title">NO REACTION DATA</div>
          <div class="empty-sub">The local SDE has no reaction formulas. Update it in Settings → Database.</div>
        </div>`;
      return;
    }

    _rxPopulateGroupFilter();
    _rxRenderGrid();              // paint cards immediately (no prices yet)
    await _rxLoadPrices(false);  // then fetch prices and re-render with profit
  } catch (err) {
    console.error('[reactions] load failed:', err);
    if (grid) grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--danger);
                  font-family:var(--mono);font-size:11px;">⚠ FAILED TO LOAD REACTIONS</div>`;
  } finally {
    _rxLoading = false;
  }
}

async function _rxLoadPrices(force) {
  if (!_rxFormulas?.length) return;

  // Collect every distinct typeId we need a price for: products + all inputs.
  const ids = new Set();
  for (const f of _rxFormulas) {
    ids.add(f.productTypeId);
    for (const m of f.materials) ids.add(m.typeId);
  }

  // If switching hubs we want fresh data; the IPC layer caches per hub for 6h.
  if (force) _rxPrices = {};

  try {
    const prices = await window.eveAPI.getHubPrices([...ids], _rxHub);
    _rxPrices = prices || {};
    _rxPricesLoaded = true;
    _rxRenderGrid();
    // If a modal is open, refresh it with the new prices.
    if (document.getElementById('rxModalBackdrop')) {
      const fid = parseInt(document.getElementById('rxModalBackdrop').dataset.formulaId);
      const f = _rxFormulas.find(x => x.formulaTypeId === fid);
      if (f) _rxFillModal(f);
    }
  } catch (e) {
    console.warn('[reactions] price fetch failed:', e.message);
  }
}

// ── Controls ─────────────────────────────────────────────────────────────────
function _rxSetHub(hub) {
  if (hub === _rxHub) return;
  _rxHub = hub;
  document.querySelectorAll('.rx-hub-btn').forEach(b => b.classList.toggle('active', b.dataset.hub === hub));
  _rxPricesLoaded = false;
  _rxRenderGrid();             // grey out profits while refetching
  _rxLoadPrices(true);
}

function _rxSetScrapLevel(level) {
  _rxScrapLevel = Math.max(0, Math.min(5, level));
  const val = document.getElementById('rxScrapVal');
  if (val) val.textContent = `${_rxScrapLevel}%`;
  // Keep a modal slider (if open) in sync
  const mSlider = document.getElementById('rxModalScrapSlider');
  const mVal    = document.getElementById('rxModalScrapVal');
  if (mSlider && parseInt(mSlider.value) !== _rxScrapLevel) mSlider.value = _rxScrapLevel;
  if (mVal) mVal.textContent = `${_rxScrapLevel}%`;
  const tSlider = document.getElementById('rxScrapSlider');
  if (tSlider && parseInt(tSlider.value) !== _rxScrapLevel) tSlider.value = _rxScrapLevel;
  _rxRenderGrid();
  if (document.getElementById('rxModalBackdrop')) {
    const fid = parseInt(document.getElementById('rxModalBackdrop').dataset.formulaId);
    const f = _rxFormulas.find(x => x.formulaTypeId === fid);
    if (f) _rxFillModal(f);
  }
}

// ── Profit math ──────────────────────────────────────────────────────────────
// Inputs valued at hub SELL (cost to buy them now). Output valued at hub SELL
// (what you'd list the product for). Scrap return credits scrapLevel% of the
// gross input cost back as recovered unrefined materials.
function _rxCompute(formula) {
  let inputCost = 0;
  let inputVolume = 0;
  let priced = formula.materials.length > 0;

  for (const m of formula.materials) {
    const p = _rxPrices[m.typeId];
    const unit = p?.sell > 0 ? p.sell : (p?.buy || 0);
    if (unit <= 0) priced = false;
    inputCost   += unit * m.quantity;
    inputVolume += (m.volume || 0) * m.quantity;
  }

  const pp = _rxPrices[formula.productTypeId];
  const outUnit = pp?.sell > 0 ? pp.sell : (pp?.buy || 0);
  const outputValue = outUnit * formula.productQty;
  const outputVolume = (formula.productVolume || 0) * formula.productQty;

  const scrapReturn = inputCost * (_rxScrapLevel / 100);
  const netCost = inputCost - scrapReturn;
  const profit  = outputValue - netCost;
  const margin  = netCost > 0 ? (profit / netCost) * 100 : 0;

  const hasPrices = _rxPricesLoaded && priced && outUnit > 0;

  return { inputCost, inputVolume, outputValue, outputVolume, scrapReturn, netCost, profit, margin, hasPrices };
}

// ── Group filter ─────────────────────────────────────────────────────────────
function _rxPopulateGroupFilter() {
  const sel = document.getElementById('rxGroup');
  if (!sel) return;
  const groups = [...new Set(_rxFormulas.map(f => f.groupName))].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="all">All Groups</option>` +
    groups.map(g => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join('');
  sel.value = _rxGroup;
}

// ── Grid render ──────────────────────────────────────────────────────────────
function _rxRenderGrid() {
  const grid = document.getElementById('rxGrid');
  if (!grid || !_rxFormulas) return;

  let list = _rxFormulas.filter(f => {
    const matchesSearch = !_rxSearch
      || f.formulaName.toLowerCase().includes(_rxSearch)
      || f.productName.toLowerCase().includes(_rxSearch);
    const matchesGroup = _rxGroup === 'all' || f.groupName === _rxGroup;
    return matchesSearch && matchesGroup;
  });

  // Decorate with computed economics for sorting
  const rows = list.map(f => ({ f, calc: _rxCompute(f) }));

  rows.sort((a, b) => {
    if (_rxSort === 'name')   return a.f.formulaName.localeCompare(b.f.formulaName);
    if (_rxSort === 'output') return b.calc.outputValue - a.calc.outputValue;
    if (_rxSort === 'margin') return b.calc.margin - a.calc.margin;
    if (_rxSort === 'group')  return a.f.groupName.localeCompare(b.f.groupName)
                                  || a.f.formulaName.localeCompare(b.f.formulaName);
    return b.calc.profit - a.calc.profit; // profit (default)
  });

  const countEl = document.getElementById('rxCount');
  if (countEl) countEl.textContent = rows.length;

  if (!rows.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;margin-top:50px;">
        <div class="empty-icon">◈</div>
        <div class="empty-title">NO REACTIONS FOUND</div>
        <div class="empty-sub">Adjust your search or group filter.</div>
      </div>`;
    return;
  }

  grid.innerHTML = rows.map(({ f, calc }) => _rxCardHtml(f, calc)).join('');

  grid.querySelectorAll('.rx-card').forEach(card => {
    card.addEventListener('click', () => {
      const fid = parseInt(card.dataset.formulaId);
      const formula = _rxFormulas.find(x => x.formulaTypeId === fid);
      if (formula) _rxOpenModal(formula);
    });
  });
}

function _rxCardHtml(f, calc) {
  const profitClass = !calc.hasPrices ? 'na' : calc.profit >= 0 ? 'pos' : 'neg';
  const profitText  = !calc.hasPrices
    ? (_rxPricesLoaded ? 'No market' : '…')
    : (calc.profit >= 0 ? '+' : '') + formatNumber(calc.profit);
  const marginText  = calc.hasPrices
    ? `<div class="rx-margin" style="color:${calc.margin >= 0 ? 'var(--success)' : 'var(--danger)'};">
         ${calc.margin >= 0 ? '+' : ''}${calc.margin.toFixed(1)}% margin</div>`
    : '';

  const groupColor = _rxGroupColor(f.groupName);

  return `
    <div class="rx-card" data-formula-id="${f.formulaTypeId}" style="border-left-color:${groupColor};">
      <div class="rx-card-top">
        <span class="rx-group-chip"
              style="color:${groupColor};background:${groupColor}1f;">${escHtml(f.groupName)}</span>
      </div>
      <div class="rx-card-head">
        <img class="rx-card-thumb"
             src="${ESI_IMAGE}/${f.formulaTypeId}/bp?size=64"
             onerror="this.onerror=null;this.src='${ESI_IMAGE}/${f.productTypeId}/icon?size=64';"
             alt="formula">
        <div class="rx-card-titlewrap">
          <div class="rx-card-title">${escHtml(f.formulaName)}</div>
          <div class="rx-card-produces">→ ${f.productQty.toLocaleString()}× ${escHtml(f.productName)}</div>
        </div>
      </div>
      <div class="rx-card-stats">
        <div>
          <div class="rx-stat-label">OUTPUT @ ${escHtml((RX_HUB_LABELS[_rxHub] || _rxHub).toUpperCase())}</div>
          <div class="rx-stat-val">${calc.hasPrices ? formatNumber(calc.outputValue) + ' ISK' : '—'}</div>
        </div>
        <div>
          <div class="rx-profit ${profitClass}">${profitText}</div>
          ${marginText}
        </div>
      </div>
    </div>`;
}

function _rxLoadingCards() {
  const card = `
    <div class="bp-skel-card" style="flex-direction:column;align-items:stretch;height:120px;border-radius:18px;">
      <div class="bp-skel-block" style="height:46px;width:60%;border-radius:8px;"></div>
      <div class="bp-skel-block" style="height:14px;width:80%;margin-top:10px;"></div>
      <div class="bp-skel-block" style="height:20px;width:40%;margin-top:auto;"></div>
    </div>`;
  return Array.from({ length: 12 }, () => card).join('');
}

// ── Detail modal ─────────────────────────────────────────────────────────────
function _rxOpenModal(formula) {
  document.getElementById('rxModalBackdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'rxModalBackdrop';
  backdrop.className = 'rx-modal-backdrop';
  backdrop.dataset.formulaId = formula.formulaTypeId;

  backdrop.innerHTML = `
    <div class="rx-modal">
      <div class="rx-modal-head">
        <img src="${ESI_IMAGE}/${formula.productTypeId}/icon?size=64"
             onerror="this.onerror=null;this.src='${ESI_IMAGE}/${formula.formulaTypeId}/bp?size=64';" alt="">
        <div style="min-width:0;flex:1;">
          <div class="rx-modal-title">${escHtml(formula.formulaName)}</div>
          <div class="rx-modal-sub">Produces ${formula.productQty.toLocaleString()}× ${escHtml(formula.productName)}
               · <span style="color:${_rxGroupColor(formula.groupName)};font-weight:700;">${escHtml(formula.groupName)}</span></div>
        </div>
        <button class="rx-modal-close" id="rxModalClose">✕</button>
      </div>
      <div class="rx-modal-body">
        <div class="rx-modal-controls">
          <div style="display:flex;flex-direction:column;gap:6px;">
            <div class="rx-section-label" style="margin:0;">MARKET HUB</div>
            <div class="rx-hub-picker" id="rxModalHubPicker"></div>
          </div>
          <div class="rx-scrap" style="margin-left:auto;">
            SCRAP RETURN
            <input type="range" id="rxModalScrapSlider" min="0" max="5" step="1" value="${_rxScrapLevel}">
            <span class="rx-scrap-val" id="rxModalScrapVal">${_rxScrapLevel}%</span>
          </div>
        </div>
        <div id="rxModalContent"></div>
      </div>
    </div>`;

  document.body.appendChild(backdrop);

  // Hub picker inside the modal mirrors the global one
  const mPicker = backdrop.querySelector('#rxModalHubPicker');
  const hubs = _rxHubMeta ? Object.keys(_rxHubMeta) : Object.keys(RX_HUB_LABELS);
  mPicker.innerHTML = hubs.map(h =>
    `<button class="rx-hub-btn ${h === _rxHub ? 'active' : ''}" data-hub="${h}">${escHtml(RX_HUB_LABELS[h] || h)}</button>`).join('');
  mPicker.querySelectorAll('.rx-hub-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      mPicker.querySelectorAll('.rx-hub-btn').forEach(b => b.classList.toggle('active', b === btn));
      _rxSetHub(btn.dataset.hub);
    }));

  backdrop.querySelector('#rxModalScrapSlider')
    .addEventListener('input', e => _rxSetScrapLevel(parseInt(e.target.value) || 0));

  backdrop.querySelector('#rxModalClose').addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });

  _rxFillModal(formula);
}

function _rxFillModal(formula) {
  const content = document.getElementById('rxModalContent');
  if (!content) return;

  const calc = _rxCompute(formula);
  const hubLabel = (RX_HUB_LABELS[_rxHub] || _rxHub).toUpperCase();

  const matRows = formula.materials.map(m => {
    const p = _rxPrices[m.typeId];
    const unit = p?.sell > 0 ? p.sell : (p?.buy || 0);
    const total = unit * m.quantity;
    const vol = (m.volume || 0) * m.quantity;
    return `
      <tr>
        <td class="rx-mat-name">
          <img src="${ESI_IMAGE}/${m.typeId}/icon?size=32"
               onerror="this.onerror=null;this.style.visibility='hidden';" alt="">
          <span>${escHtml(m.name)}</span>
        </td>
        <td style="color:var(--text-1);">${m.quantity.toLocaleString()}</td>
        <td style="color:var(--text-3);">${vol.toLocaleString(undefined, { maximumFractionDigits: 1 })} m³</td>
        <td style="color:var(--text-3);">${unit > 0 ? formatNumber(unit) : '—'}</td>
        <td style="color:${total > 0 ? 'var(--text-1)' : 'var(--text-3)'};font-weight:600;">
          ${total > 0 ? formatNumber(total) : '—'}
        </td>
      </tr>`;
  }).join('');

  const profitClass = calc.profit >= 0 ? 'pos' : 'neg';

  content.innerHTML = `
    <div class="rx-section-label">INPUT MATERIALS — 1 RUN</div>
    <table class="rx-mat-table">
      <thead>
        <tr>
          <th class="l">MATERIAL</th>
          <th>QTY</th>
          <th>VOLUME</th>
          <th>${escHtml(hubLabel)} SELL</th>
          <th>TOTAL</th>
        </tr>
      </thead>
      <tbody>${matRows}</tbody>
    </table>

    <div class="rx-summary">
      <div class="rx-summary-row">
        <span class="k">Input volume</span>
        <span class="v">${calc.inputVolume.toLocaleString(undefined, { maximumFractionDigits: 1 })} m³</span>
      </div>
      <div class="rx-summary-row">
        <span class="k">Input cost (${escHtml(hubLabel)} sell)</span>
        <span class="v">${calc.hasPrices || calc.inputCost > 0 ? formatNumber(calc.inputCost) + ' ISK' : '—'}</span>
      </div>
      <div class="rx-summary-row">
        <span class="k">Scrap return (${_rxScrapLevel}%)</span>
        <span class="v" style="color:var(--success);">${_rxScrapLevel > 0 ? '−' + formatNumber(calc.scrapReturn) + ' ISK' : '0 ISK'}</span>
      </div>
      <div class="rx-summary-row">
        <span class="k">Net build cost</span>
        <span class="v">${calc.inputCost > 0 ? formatNumber(calc.netCost) + ' ISK' : '—'}</span>
      </div>
      <div class="rx-summary-row">
        <span class="k">Output value — ${formula.productQty.toLocaleString()}× ${escHtml(formula.productName)}</span>
        <span class="v">${calc.hasPrices ? formatNumber(calc.outputValue) + ' ISK' : '—'}</span>
      </div>
      <div class="rx-summary-row profit">
        <span class="k">Profit / run</span>
        <span class="v ${profitClass}">
          ${calc.hasPrices ? (calc.profit >= 0 ? '+' : '') + formatNumber(calc.profit) + ' ISK'
                           : (_rxPricesLoaded ? 'No market data' : 'Loading…')}
        </span>
      </div>
      ${calc.hasPrices ? `
      <div class="rx-summary-row">
        <span class="k">Margin</span>
        <span class="v" style="color:${calc.margin >= 0 ? 'var(--success)' : 'var(--danger)'};">
          ${calc.margin >= 0 ? '+' : ''}${calc.margin.toFixed(1)}%
        </span>
      </div>` : ''}
    </div>

    <div style="font-family:var(--mono);font-size:9.5px;color:var(--text-3);margin-top:12px;line-height:1.6;">
      Inputs & output valued at ${escHtml(hubLabel)} sell orders. Scrap return approximates unrefined
      materials recovered via Scrap Metal Processing (1% of input cost per level). Excludes job
      installation fees and reaction time.
    </div>`;
}
