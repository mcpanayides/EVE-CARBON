// ─── LP Store optimiser ────────────────────────────────────────────────────────
// Ranks a corporation's loyalty-store offers by ISK-per-LP using live Jita
// prices, so you can see which offers are actually worth your LP.
//
//   profit   = Jita-sell(output × qty) − isk_cost − Jita-sell(required items)
//   ISK / LP = profit ÷ lp_cost
//
// Corp list comes from the character's synced loyalty points (no new scope —
// esi-characters.read_loyalty.v1 is already granted); offers are the public
// LP-store endpoint (lp-get-offers). Nothing is stored.

let _lpChar   = null;
let _lpCorps  = [];      // [{ corpId, name, lp }]
let _lpCorpId = null;
let _lpRows   = [];      // computed, ranked offers
let _lpSort   = 'iskPerLp';
let _lpSortDir = -1;     // 1 = ascending, -1 = descending
let _lpNames  = {};

async function renderLpStore(host) {
  if (!host) return;
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(accounts) || !accounts.length) {
    host.innerHTML = '<div class="fin-empty">Add a character to use the LP Store optimiser.</div>';
    return;
  }
  if (!_lpChar || !accounts.some(a => String(a.characterId) === String(_lpChar))) {
    const main = accounts.find(a => String(a.characterId) === String(typeof selectedCharacterId !== 'undefined' ? selectedCharacterId : '')) || accounts[0];
    _lpChar = main.characterId;
  }

  host.innerHTML = `
    <div class="fin-tab-fill lp-wrap">
      <div class="lp-bar">
        <select id="lpCharSelect" class="field-input" title="Whose loyalty points to use">
          ${accounts.map(a => `<option value="${a.characterId}"${String(a.characterId) === String(_lpChar) ? ' selected' : ''}>${escHtml(a.characterName)}</option>`).join('')}
        </select>
        <select id="lpCorpSelect" class="field-input" style="min-width:220px;"></select>
        <span class="lp-hint">Double-click a column to sort</span>
        <span class="lp-status" id="lpStatus"></span>
      </div>
      <div class="lp-body" id="lpBody"><div class="fin-empty">Loading loyalty points…</div></div>
    </div>`;

  document.getElementById('lpCharSelect').onchange = (e) => { _lpChar = Number(e.target.value); _lpLoadCorps(); };
  document.getElementById('lpCorpSelect').onchange = (e) => { _lpCorpId = Number(e.target.value); _lpLoadOffers(); };

  await _lpLoadCorps();
}

function _lpStatus(m) { const el = document.getElementById('lpStatus'); if (el) el.textContent = m || ''; }

async function _lpLoadCorps() {
  const body = document.getElementById('lpBody');
  const sel  = document.getElementById('lpCorpSelect');
  _lpStatus('Loading loyalty points…');
  const rows = await window.eveAPI.getLoyaltyPoints(_lpChar).catch(() => []);
  _lpStatus('');

  _lpCorps = (Array.isArray(rows) ? rows : [])
    .map(r => ({ corpId: r.corporation_id, lp: r.loyalty_points || 0 }))
    .filter(c => c.corpId)
    .sort((a, b) => b.lp - a.lp);

  if (!_lpCorps.length) {
    sel.innerHTML = '<option value="">— no loyalty points —</option>';
    body.innerHTML = `<div class="fin-empty">No loyalty points found for this character.<br><br>
      Run a character sync (Characters page) so the app has your LP, then come back.</div>`;
    return;
  }

  // Resolve corp names for the dropdown.
  await _lpResolveNames(_lpCorps.map(c => c.corpId));
  sel.innerHTML = _lpCorps.map(c =>
    `<option value="${c.corpId}">${escHtml(_lpName(c.corpId))} — ${formatNumber(c.lp)} LP</option>`).join('');
  _lpCorpId = _lpCorps[0].corpId;
  sel.value = String(_lpCorpId);
  await _lpLoadOffers();
}

async function _lpLoadOffers() {
  const body = document.getElementById('lpBody');
  if (!_lpCorpId) return;
  body.innerHTML = '<div class="fin-empty">Loading offers and Jita prices…</div>';

  const offers = await window.eveAPI.lpGetOffers(_lpCorpId).catch(() => []);
  if (!offers.length) { body.innerHTML = '<div class="fin-empty">This corporation has no LP store offers.</div>'; return; }

  // One price fetch + one name fetch for every type across all offers.
  const typeIds = [...new Set(offers.flatMap(o => [o.typeId, ...o.required.map(r => r.typeId)]))];
  const [prices] = await Promise.all([
    window.eveAPI.getJitaPrices(typeIds).catch(() => ({})),
    _lpResolveNames(typeIds),
  ]);
  const sell = (id) => Number((prices[id] || prices[String(id)] || {}).sell) || 0;

  const myLp = (_lpCorps.find(c => c.corpId === _lpCorpId) || {}).lp || 0;
  _lpRows = offers.map(o => ({
    ...o,
    outputValue: sell(o.typeId) * o.quantity,
    reqCost:     o.required.reduce((n, r) => n + sell(r.typeId) * r.quantity, 0),
    affordable:  myLp >= o.lpCost,
    isBlueprint: /\bBlueprint$/i.test(_lpName(o.typeId)),
  }));

  // Blueprints have no direct market price — value them by what they BUILD: the
  // product's Jita-sell value × quantity (gross output, before build materials).
  // Products resolve in one batched SDE call, then get one price/name fetch.
  const bpOffers = _lpRows.filter(r => r.isBlueprint && r.outputValue <= 0);
  if (bpOffers.length) {
    try {
      const productMap = await window.eveAPI.sdeProductsForBlueprints(bpOffers.map(r => r.typeId));
      const productIds = [...new Set(Object.values(productMap).map(v => v.product).filter(Boolean))];
      if (productIds.length) {
        const [pPrices] = await Promise.all([
          window.eveAPI.getJitaPrices(productIds).catch(() => ({})),
          _lpResolveNames(productIds),
        ]);
        const psell = (id) => Number((pPrices[id] || pPrices[String(id)] || {}).sell) || 0;
        bpOffers.forEach(r => {
          const pm = productMap[r.typeId];
          if (pm && psell(pm.product) > 0) {
            r.builtFrom   = pm.product;
            r.outputValue = psell(pm.product) * (pm.qty || 1) * r.quantity;   // product value × units/run × copies
          }
        });
      }
    } catch (_) { /* leave any blueprint we can't value as no-price */ }
  }

  // Finalise now that blueprint output values are filled in.
  _lpRows.forEach(r => {
    r.profit   = r.outputValue - r.iskCost - r.reqCost;
    r.iskPerLp = r.lpCost > 0 ? r.profit / r.lpCost : 0;
    r.priced   = r.outputValue > 0;
  });
  _lpRender();
}

// key === 'offer' sorts by resolved name (text), everything else numerically.
function _lpSortedRows() {
  const dir = _lpSortDir, key = _lpSort;
  return _lpRows.slice().sort((a, b) =>
    key === 'offer'
      ? dir * _lpName(a.typeId).localeCompare(_lpName(b.typeId))
      : dir * ((a[key] || 0) - (b[key] || 0)));
}

function _lpSetSort(key) {
  if (_lpSort === key) _lpSortDir *= -1;
  else { _lpSort = key; _lpSortDir = key === 'offer' ? 1 : -1; }   // names A→Z, numbers high→low
  _lpRender();
}

function _lpRender() {
  const body = document.getElementById('lpBody');
  if (!body) return;
  const rows   = _lpSortedRows();
  const priced = _lpRows.filter(r => r.priced);
  const best   = priced.length ? priced.reduce((a, b) => (b.iskPerLp > a.iskPerLp ? b : a)) : null;

  // Sortable header cell with an ▲/▼ caret on the active column. `rk` (resize
  // key) adds a drag handle on that column's right edge.
  const th = (key, label, cls, rk) =>
    `<th data-lpsort="${key}" class="${cls || ''}${_lpSort === key ? (_lpSortDir === 1 ? ' sort-asc' : ' sort-desc') : ''}">${label}${rk ? `<span class="lp-rh" data-rcol="${rk}"></span>` : ''}</th>`;
  const cw = (k) => `class="lp-col-${k}" style="width:${_lpColW[k]}px"`;

  body.innerHTML = `
    <div class="lp-table-wrap">
      <table class="lp-table">
        <colgroup>
          <col/><col ${cw('quantity')}/><col ${cw('lpCost')}/><col ${cw('iskCost')}/>
          <col ${cw('outputValue')}/><col ${cw('profit')}/><col ${cw('iskPerLp')}/>
        </colgroup>
        <thead><tr>
          ${th('offer', 'Offer', 'lp-th-name')}
          ${th('quantity', 'Qty', 'lp-num', 'quantity')}
          ${th('lpCost', 'LP', 'lp-num', 'lpCost')}
          ${th('iskCost', 'ISK cost', 'lp-num', 'iskCost')}
          ${th('outputValue', 'Item value', 'lp-num', 'outputValue')}
          ${th('profit', 'Profit', 'lp-num', 'profit')}
          ${th('iskPerLp', 'ISK / LP', 'lp-num', 'iskPerLp')}
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr class="${r === best ? 'lp-best' : ''}${r.affordable ? '' : ' lp-unaffordable'}" title="${r.affordable ? '' : 'Not enough LP for this offer yet'}">
              <td class="lp-td-name">
                <img class="lp-icon" src="${_lpIconUrl(r.typeId)}" alt="" loading="lazy" onerror="this.style.display='none'"/>
                <span class="lp-name-txt">${r.quantity > 1 ? `<b>${formatNumber(r.quantity)}×</b> ` : ''}${escHtml(_lpName(r.typeId))}${r.required.length ? `<span class="lp-req">+ ${r.required.map(x => `${formatNumber(x.quantity)}× ${escHtml(_lpName(x.typeId))}`).join(', ')}</span>` : ''}${r.builtFrom ? `<span class="lp-req lp-build">▸ builds ${escHtml(_lpName(r.builtFrom))} — valued at Jita sell (before build materials)</span>` : ''}</span>
              </td>
              <td class="lp-num">${formatNumber(r.quantity)}</td>
              <td class="lp-num${r.affordable ? '' : ' lp-dim'}">${formatNumber(r.lpCost)}</td>
              <td class="lp-num">${r.iskCost ? formatISK(r.iskCost) : '—'}</td>
              <td class="lp-num">${r.priced ? formatISK(r.outputValue) : '<span class="lp-dim">no price</span>'}</td>
              <td class="lp-num ${r.profit >= 0 ? 'lp-pos' : 'lp-neg'}">${r.priced ? formatISK(r.profit) : '—'}</td>
              <td class="lp-num lp-strong ${r.iskPerLp >= 0 ? 'lp-pos' : 'lp-neg'}">${r.priced ? formatNumber(Math.round(r.iskPerLp)) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="lp-note">Double-click any column header to sort by it; drag a column's right edge to resize.
      ISK/LP = (Jita-sell value − ISK cost − required-item cost) ÷ LP cost. Blueprint offers are valued by
      what they build (product Jita sell × quantity, gross — before manufacturing materials).
      Highlighted row is the best ISK/LP; greyed rows cost more LP than you currently have.</div>`;

  body.querySelectorAll('th[data-lpsort]').forEach(t => { t.ondblclick = () => _lpSetSort(t.dataset.lpsort); });
  _lpBindResize();
}

async function _lpResolveNames(ids) {
  const missing = [...new Set(ids.filter(id => id && !_lpNames[id]))];
  if (!missing.length) return;
  try {
    const r = await window.eveAPI.getNames(missing);
    if (Array.isArray(r)) r.forEach(({ id, name }) => { if (id && name) _lpNames[id] = name; });
    else if (r && typeof r === 'object') Object.assign(_lpNames, r);
  } catch (_) { /* unresolved ids show a fallback */ }
}
const _lpName = (id) => _lpNames[id] || `ID ${id}`;

// Blueprints have no /icon on the image server (it 400s) — they use /bp (BPO) or
// /bpc (copy). LP-store blueprints are copies, so blueprint-named items render
// via /bpc (the copy icon, with its distinct border) like the game shows them.
function _lpIconUrl(typeId) {
  return `https://images.evetech.net/types/${typeId}/${/\bBlueprint$/i.test(_lpName(typeId)) ? 'bpc' : 'icon'}?size=32`;
}

// ─── Resizable columns (persisted) ───────────────────────────────────────────
const _LP_COLW_KEY = 'eveCarbon_lpColW';
const _LP_COLW_DEFAULT = { quantity: 60, lpCost: 96, iskCost: 116, outputValue: 124, profit: 124, iskPerLp: 92 };
let _lpColW = (() => {
  try { return { ..._LP_COLW_DEFAULT, ...(JSON.parse(localStorage.getItem(_LP_COLW_KEY) || '{}')) }; }
  catch (_) { return { ..._LP_COLW_DEFAULT }; }
})();
function _lpSaveColW() { try { localStorage.setItem(_LP_COLW_KEY, JSON.stringify(_lpColW)); } catch (_) {} }

// Drag a header's right-edge handle to resize that column; the Offer column
// flexes to absorb the change. Widths persist across sessions.
function _lpBindResize() {
  document.querySelectorAll('.lp-table .lp-rh').forEach(h => {
    h.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const key = h.dataset.rcol;
      const startX = e.clientX, startW = _lpColW[key] || 100;
      const col = document.querySelector(`.lp-table col.lp-col-${key}`);
      const onMove = (ev) => {
        const w = Math.max(44, startW + (ev.clientX - startX));
        _lpColW[key] = w;
        if (col) col.style.width = w + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('lp-resizing');
        _lpSaveColW();
      };
      document.body.classList.add('lp-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  });
}
