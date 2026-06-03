// salvage.js — Salvage Calculator

let _salvageData    = null;   // { rigs: [...], salvageMats: [...] }
let _salvagePrices  = {};     // typeID -> { buy, sell }
let _salvageLoading = false;
let _salvageMode    = 'lookup';
let _salvageSizeFilter  = 0;  // 0 = all, 1-6 = specific size
let _selectedSalvageId  = 0;  // typeID of selected salvage material
let _salvageSort    = { col: 'margin', dir: -1 };

const RIG_SIZE_LABEL = { 0: '—', 1: 'S', 2: 'M', 3: 'L', 4: 'XL', 5: 'Cap', 6: 'Str' };

// ── Entry point ──────────────────────────────────────────────────────────────

async function renderSalvageCalculator(container) {
  container.innerHTML = `
    <div id="salvageWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- Toolbar -->
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                  padding:10px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;flex-shrink:0;">SALVAGE CALCULATOR · JITA 4-4</span>
        <div style="display:flex;gap:2px;background:var(--bg-deep);border-radius:8px;padding:2px;flex-shrink:0;">
          <button id="salvModeLookup" class="bp-tab-btn active"
                  style="font-family:var(--mono);font-size:10px;padding:5px 12px;letter-spacing:0.06em;">BY SALVAGE</button>
          <button id="salvModeBulk" class="bp-tab-btn"
                  style="font-family:var(--mono);font-size:10px;padding:5px 12px;letter-spacing:0.06em;">BULK PASTE</button>
        </div>
        <select id="salvSizeFilter" class="field-input"
                style="width:126px;font-size:12px;padding:5px 8px;">
          <option value="0">All Sizes</option>
          <option value="1">Small</option>
          <option value="2">Medium</option>
          <option value="3">Large</option>
          <option value="4">X-Large</option>
          <option value="5">Capital</option>
          <option value="6">Structure</option>
        </select>
        <button id="salvRefreshBtn" class="icon-btn"
                style="padding:5px 12px;font-size:12px;margin-left:auto;">⟳ REFRESH</button>
        <div id="salvPriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);"></div>
      </div>

      <!-- BY SALVAGE panel -->
      <div id="salvLookupPanel" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">

        <!-- Material selector row -->
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;
                    padding:10px 16px;border-bottom:1px solid var(--border);
                    background:var(--bg-panel);flex-shrink:0;">
          <label style="font-size:10px;color:var(--text-3);font-family:var(--mono);
                         letter-spacing:0.1em;flex-shrink:0;">SALVAGE MATERIAL</label>
          <select id="salvMatSelect" class="field-input"
                  style="flex:1;max-width:320px;font-size:12px;cursor:pointer;">
            <option value="0">— select a salvage material —</option>
          </select>
          <div id="salvMatPrice" style="font-size:11px;font-family:var(--mono);
                                        color:var(--text-2);min-width:200px;"></div>
        </div>

        <!-- Rig results table -->
        <div style="flex:1;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                         position:sticky;top:0;z-index:1;">
                <th style="text-align:left;padding:9px 14px;font-family:var(--mono);
                            font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RIG</th>
                <th style="text-align:center;padding:9px 8px;font-family:var(--mono);
                            font-size:10px;color:var(--text-3);letter-spacing:0.1em;">SIZE</th>
                <th id="salvThQty" style="text-align:right;padding:9px 14px;cursor:pointer;
                            font-family:var(--mono);font-size:10px;color:var(--text-3);
                            letter-spacing:0.1em;white-space:nowrap;">QTY ↕</th>
                <th style="text-align:left;padding:9px 10px;font-family:var(--mono);
                            font-size:10px;color:var(--text-3);letter-spacing:0.1em;">OTHER MATS</th>
                <th id="salvThSell" style="text-align:right;padding:9px 14px;cursor:pointer;
                            font-family:var(--mono);font-size:10px;color:var(--text-3);
                            letter-spacing:0.1em;white-space:nowrap;">RIG SELL ↕</th>
                <th id="salvThCost" style="text-align:right;padding:9px 14px;cursor:pointer;
                            font-family:var(--mono);font-size:10px;color:var(--text-3);
                            letter-spacing:0.1em;white-space:nowrap;">SALV COST ↕</th>
                <th id="salvThMargin" style="text-align:right;padding:9px 14px;cursor:pointer;
                            font-family:var(--mono);font-size:10px;color:var(--accent);
                            letter-spacing:0.1em;white-space:nowrap;">MARGIN ↕</th>
              </tr>
            </thead>
            <tbody id="salvRigBody">
              <tr><td colspan="7" style="text-align:center;padding:48px;
                  color:var(--text-3);font-family:var(--mono);font-size:12px;">
                ◈ Select a salvage material above
              </td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- BULK PASTE panel -->
      <div id="salvBulkPanel" style="display:none;flex-direction:column;flex:1;
                                      overflow:hidden;padding:16px;gap:12px;">
        <div style="flex-shrink:0;">
          <div style="font-size:10px;color:var(--text-3);font-family:var(--mono);
                      letter-spacing:0.1em;margin-bottom:6px;">
            PASTE EVE INVENTORY — Copy from cargo or hangar (Ctrl+A → Ctrl+C in-game)
          </div>
          <textarea id="salvBulkInput"
            placeholder="Alloyed Tritanium Bar&#9;5&#10;Burned Logic Circuit&#9;10&#10;…"
            style="width:100%;height:110px;box-sizing:border-box;
                   background:var(--bg-input);color:var(--text-1);
                   border:1px solid var(--border);border-radius:8px;
                   padding:10px 12px;font-family:var(--mono);font-size:12px;
                   resize:vertical;line-height:1.6;outline:none;"></textarea>
          <div style="display:flex;gap:10px;margin-top:8px;align-items:center;">
            <button id="salvBulkCalcBtn" class="calc-btn"
                    style="font-family:var(--mono);font-size:11px;letter-spacing:0.08em;">
              ◈ CALCULATE
            </button>
            <button id="salvBulkClearBtn" class="icon-btn" style="font-size:12px;">✕ CLEAR</button>
            <div id="salvBulkStatus"
                 style="font-size:11px;color:var(--text-3);font-family:var(--mono);margin-left:auto;"></div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;" id="salvBulkResults">
          <div style="text-align:center;padding:48px;color:var(--text-3);
               font-family:var(--mono);font-size:12px;">
            ◈ Paste your salvage inventory above and click Calculate
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div style="padding:7px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Rig sell = Jita 4-4 lowest sell order. Salvage cost = qty × Jita buy price. Margin excludes non-salvage components (RAM items etc.).
      </div>
    </div>`;

  // Mode toggles
  document.getElementById('salvModeLookup').addEventListener('click', () => _setSalvageMode('lookup'));
  document.getElementById('salvModeBulk').addEventListener('click',   () => _setSalvageMode('bulk'));

  // Size filter
  document.getElementById('salvSizeFilter').addEventListener('change', e => {
    _salvageSizeFilter = parseInt(e.target.value) || 0;
    _buildSalvageTable();
  });

  // Refresh prices
  document.getElementById('salvRefreshBtn').addEventListener('click', () => _loadSalvagePrices(true));

  // Column sort headers
  document.getElementById('salvThQty').addEventListener('click',    () => _sortSalvage('qty'));
  document.getElementById('salvThSell').addEventListener('click',   () => _sortSalvage('sell'));
  document.getElementById('salvThCost').addEventListener('click',   () => _sortSalvage('cost'));
  document.getElementById('salvThMargin').addEventListener('click', () => _sortSalvage('margin'));

  // Material dropdown change
  document.getElementById('salvMatSelect').addEventListener('change', e => {
    _selectedSalvageId = parseInt(e.target.value) || 0;
    _updateMatPriceDisplay();
    _buildSalvageTable();
  });

  // Bulk paste
  document.getElementById('salvBulkCalcBtn').addEventListener('click', _runBulkSalvage);
  document.getElementById('salvBulkClearBtn').addEventListener('click', () => {
    document.getElementById('salvBulkInput').value = '';
    document.getElementById('salvBulkStatus').textContent = '';
    document.getElementById('salvBulkResults').innerHTML =
      '<div style="text-align:center;padding:48px;color:var(--text-3);font-family:var(--mono);font-size:12px;">◈ Paste your salvage inventory above and click Calculate</div>';
  });

  await _loadSalvageData();
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function _loadSalvageData() {
  if (_salvageLoading) return;
  _salvageLoading = true;

  const body = document.getElementById('salvRigBody');
  if (body) body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:48px;
    color:var(--text-3);font-family:var(--mono);font-size:12px;">◈ Loading SDE data…</td></tr>`;

  try {
    if (!_salvageData) {
      _salvageData = await window.eveAPI.salvageGetRigData();
    }
    if (!_salvageData) {
      if (body) body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:48px;
        color:var(--danger);font-family:var(--mono);font-size:12px;">
        ⚠ SDE not available — update your database in Settings → Database</td></tr>`;
      return;
    }

    _populateSalvageMatDropdown();
    await _loadSalvagePrices(false);
  } finally {
    _salvageLoading = false;
  }
}

async function _loadSalvagePrices(forceRefresh) {
  if (!_salvageData) return;

  const refreshBtn = document.getElementById('salvRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  const salvageIds = _salvageData.salvageMats.map(m => m.typeID);
  try {
    const prices = await window.eveAPI.getJitaPrices(salvageIds);
    Object.assign(_salvagePrices, prices || {});

    const ageEl = document.getElementById('salvPriceAge');
    if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    _updateMatPriceDisplay();
    _buildSalvageTable();
  } catch (e) {
    logToConsole && logToConsole(`Salvage prices fetch failed: ${e.message}`, 'error');
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

async function _fetchRigPrices(rigTypeIds) {
  if (!rigTypeIds.length) return;
  const missing = rigTypeIds.filter(id => !_salvagePrices[id]);
  if (!missing.length) return;
  try {
    const prices = await window.eveAPI.getJitaPrices(missing);
    Object.assign(_salvagePrices, prices || {});
  } catch (_) {}
}

// ── Dropdown ─────────────────────────────────────────────────────────────────

function _populateSalvageMatDropdown() {
  const sel = document.getElementById('salvMatSelect');
  if (!sel || !_salvageData) return;

  sel.innerHTML = '<option value="0">— select a salvage material —</option>';
  for (const mat of _salvageData.salvageMats) {
    const opt = document.createElement('option');
    opt.value = mat.typeID;
    opt.textContent = mat.typeName;
    sel.appendChild(opt);
  }

  if (_selectedSalvageId) sel.value = _selectedSalvageId;
}

function _updateMatPriceDisplay() {
  const el = document.getElementById('salvMatPrice');
  if (!el) return;
  if (!_selectedSalvageId) { el.textContent = ''; return; }
  const p = _salvagePrices[_selectedSalvageId];
  if (!p) { el.textContent = ''; return; }
  el.innerHTML =
    `<span style="color:var(--success);">Buy: ${formatNumber(p.buy)} ISK</span>` +
    `<span style="color:var(--text-3);margin:0 8px;">·</span>` +
    `<span style="color:var(--accent);">Sell: ${formatNumber(p.sell)} ISK</span>`;
}

// ── Table rendering ───────────────────────────────────────────────────────────

function _sortSalvage(col) {
  if (_salvageSort.col === col) _salvageSort.dir *= -1;
  else { _salvageSort.col = col; _salvageSort.dir = -1; }
  _buildSalvageTable();
}

async function _buildSalvageTable() {
  const body = document.getElementById('salvRigBody');
  if (!body || !_salvageData) return;

  if (!_selectedSalvageId) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:48px;
      color:var(--text-3);font-family:var(--mono);font-size:12px;">
      ◈ Select a salvage material above</td></tr>`;
    return;
  }

  // Filter rigs that use the selected salvage material
  let rigs = _salvageData.rigs.filter(r =>
    r.materials.some(m => m.typeID === _selectedSalvageId)
  );
  if (_salvageSizeFilter) rigs = rigs.filter(r => r.rigSize === _salvageSizeFilter);

  if (!rigs.length) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:48px;
      color:var(--text-3);font-family:var(--mono);font-size:12px;">
      ◈ No rigs found for this salvage / size filter</td></tr>`;
    return;
  }

  // Fetch rig sell prices for visible rigs
  await _fetchRigPrices(rigs.map(r => r.rigTypeID));

  const salvBuy = _salvagePrices[_selectedSalvageId]?.buy || 0;

  // Build sortable rows
  const rows = rigs.map(rig => {
    const mat = rig.materials.find(m => m.typeID === _selectedSalvageId);
    const qty  = mat?.qty || 0;
    const sell = _salvagePrices[rig.rigTypeID]?.sell || 0;
    const cost = qty * salvBuy;
    const margin = sell - cost;

    const otherMats = rig.materials
      .filter(m => m.typeID !== _selectedSalvageId)
      .map(m => `${m.qty}× ${m.name}`)
      .join(', ');

    return { rig, qty, sell, cost, margin, otherMats };
  });

  const { col, dir } = _salvageSort;
  rows.sort((a, b) => {
    const av = col === 'margin' ? a.margin : col === 'sell' ? a.sell : col === 'cost' ? a.cost : a.qty;
    const bv = col === 'margin' ? b.margin : col === 'sell' ? b.sell : col === 'cost' ? b.cost : b.qty;
    return (av - bv) * dir;
  });

  body.innerHTML = rows.map(({ rig, qty, sell, cost, margin, otherMats }) => {
    const marginColor = margin > 0 ? 'var(--success)' : margin < 0 ? 'var(--danger)' : 'var(--text-3)';
    const sizeLabel   = RIG_SIZE_LABEL[rig.rigSize] || '—';
    const sizeBg = {
      1: 'rgba(78,203,176,0.10)',  2: 'rgba(0,132,255,0.10)',
      3: 'rgba(171,122,184,0.10)', 4: 'rgba(230,126,34,0.10)',
      5: 'rgba(208,38,61,0.12)',   6: 'rgba(128,128,128,0.10)',
    }[rig.rigSize] || 'transparent';

    return `<tr style="border-bottom:1px solid var(--border-e);transition:background 0.1s;"
                onmouseenter="this.style.background='var(--bg-hover)'"
                onmouseleave="this.style.background=''">
      <td style="padding:9px 14px;display:flex;align-items:center;gap:9px;">
        <img src="${ESI_IMAGE}/${rig.rigTypeID}/icon?size=32"
             style="width:28px;height:28px;border-radius:6px;
                    border:1px solid var(--border);background:var(--bg-deep);flex-shrink:0;"
             onerror="this.style.display='none'"/>
        <span style="color:var(--text-1);font-size:12px;">${escHtml(rig.rigName)}</span>
      </td>
      <td style="text-align:center;padding:9px 8px;">
        <span style="font-family:var(--mono);font-size:10px;font-weight:700;
                     padding:2px 7px;border-radius:4px;background:${sizeBg};">
          ${sizeLabel}
        </span>
      </td>
      <td style="text-align:right;padding:9px 14px;font-family:var(--mono);color:var(--text-1);">
        ${qty.toLocaleString()}
      </td>
      <td style="padding:9px 10px;font-size:11px;color:var(--text-3);font-family:var(--mono);
                 max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${escHtml(otherMats)}">
        ${otherMats ? escHtml(otherMats) : '<span style="color:var(--text-5);">—</span>'}
      </td>
      <td style="text-align:right;padding:9px 14px;font-family:var(--mono);color:var(--accent);">
        ${sell > 0 ? formatNumber(sell) : '<span style="color:var(--text-5);">—</span>'}
      </td>
      <td style="text-align:right;padding:9px 14px;font-family:var(--mono);color:var(--text-2);">
        ${salvBuy > 0 ? formatNumber(cost) : '<span style="color:var(--text-5);">—</span>'}
      </td>
      <td style="text-align:right;padding:9px 14px;font-family:var(--mono);
                 font-weight:700;color:${marginColor};">
        ${sell > 0 && salvBuy > 0
          ? (margin >= 0 ? '+' : '') + formatNumber(margin)
          : '<span style="color:var(--text-5);">—</span>'}
      </td>
    </tr>`;
  }).join('');

  // Update sort header highlights
  ['Qty','Sell','Cost','Margin'].forEach(c => {
    const th = document.getElementById(`salvTh${c}`);
    if (!th) return;
    const key = c.toLowerCase();
    th.style.color = _salvageSort.col === key ? 'var(--accent)' : 'var(--text-3)';
  });
}

// ── Mode switch ───────────────────────────────────────────────────────────────

function _setSalvageMode(mode) {
  _salvageMode = mode;

  const lookup = document.getElementById('salvLookupPanel');
  const bulk   = document.getElementById('salvBulkPanel');
  const btnL   = document.getElementById('salvModeLookup');
  const btnB   = document.getElementById('salvModeBulk');

  if (mode === 'lookup') {
    if (lookup) lookup.style.display = 'flex';
    if (bulk)   bulk.style.display   = 'none';
    btnL?.classList.add('active');
    btnB?.classList.remove('active');
  } else {
    if (lookup) lookup.style.display = 'none';
    if (bulk)   bulk.style.display   = 'flex';
    btnL?.classList.remove('active');
    btnB?.classList.add('active');
  }
}

// ── Bulk paste calculator ─────────────────────────────────────────────────────

async function _runBulkSalvage() {
  if (!_salvageData) return;

  const textarea  = document.getElementById('salvBulkInput');
  const statusEl  = document.getElementById('salvBulkStatus');
  const resultsEl = document.getElementById('salvBulkResults');
  if (!textarea || !resultsEl) return;

  const raw = textarea.value.trim();
  if (!raw) { if (statusEl) statusEl.textContent = 'Nothing pasted.'; return; }

  // Build name → typeID map from SDE salvage data
  const nameToId = {};
  for (const m of _salvageData.salvageMats) {
    nameToId[m.typeName.toLowerCase().trim()] = m.typeID;
  }

  // Parse paste: "Name\tQty" or "Name Qty" per line
  const inventory = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // EVE paste: columns are tab-separated, qty is second column
    const parts = line.split('\t');
    const name  = parts[0].trim();
    const qtyRaw = (parts[1] || '').replace(/[^0-9]/g, '');
    const qty   = parseInt(qtyRaw) || 1;
    const id    = nameToId[name.toLowerCase()];
    if (id) inventory[id] = (inventory[id] || 0) + qty;
  }

  const matched = Object.keys(inventory).length;
  if (!matched) {
    if (statusEl) statusEl.textContent = 'No salvage materials recognised.';
    resultsEl.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-3);
      font-family:var(--mono);font-size:12px;">
      ◈ No recognised salvage materials found.<br/>
      <span style="font-size:10px;color:var(--text-5);">Paste your EVE inventory with Ctrl+A → Ctrl+C from cargo or hangar window.</span>
    </div>`;
    return;
  }

  if (statusEl) statusEl.textContent = `Recognised ${matched} salvage type${matched > 1 ? 's' : ''} — fetching prices…`;

  // Apply size filter
  let rigs = _salvageSizeFilter
    ? _salvageData.rigs.filter(r => r.rigSize === _salvageSizeFilter)
    : _salvageData.rigs;

  // For each rig, calculate how many can be built from available salvage
  // (only considering salvage materials, ignoring RAM/other components)
  const results = [];
  for (const rig of rigs) {
    const salvMats = rig.materials; // all mats are salvage (groupID=754) from our IPC query
    if (!salvMats.length) continue;

    let canBuild = Infinity;
    const deficit = [];

    for (const mat of salvMats) {
      const have = inventory[mat.typeID] || 0;
      const runs = Math.floor(have / mat.qty);
      if (runs < canBuild) canBuild = runs;
      if (have < mat.qty) {
        deficit.push({ name: mat.name, have, need: mat.qty, short: mat.qty - have });
      }
    }
    if (!isFinite(canBuild)) canBuild = 0;

    results.push({ rig, canBuild, deficit });
  }

  // Fetch rig prices for all rigs we might show
  const rigIdsToFetch = results.filter(r => r.canBuild > 0 || r.deficit.length > 0)
    .map(r => r.rig.rigTypeID);
  await _fetchRigPrices(rigIdsToFetch);

  // Sort: completable first (desc), then by name
  results.sort((a, b) => {
    if (b.canBuild !== a.canBuild) return b.canBuild - a.canBuild;
    return a.rig.rigName.localeCompare(b.rig.rigName);
  });

  const completable = results.filter(r => r.canBuild > 0);
  const partial     = results.filter(r => r.canBuild === 0 && r.deficit.length > 0);

  let totalIsk = 0;
  completable.forEach(r => {
    totalIsk += r.canBuild * (_salvagePrices[r.rig.rigTypeID]?.sell || 0);
  });

  if (statusEl) statusEl.textContent =
    `${completable.length} rigs buildable · Total: ${formatNumber(totalIsk)} ISK`;

  // Render summary header
  let html = `
    <div style="display:flex;align-items:center;gap:16px;padding:12px 16px;
                border-bottom:1px solid var(--border);background:var(--bg-card);flex-shrink:0;">
      <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                  letter-spacing:0.08em;">RESULTS</div>
      <div style="font-family:var(--mono);font-size:13px;color:var(--success);font-weight:700;">
        ${completable.length} BUILDABLE
      </div>
      ${totalIsk > 0 ? `<div style="font-family:var(--mono);font-size:13px;color:var(--accent);">
        ≈ ${formatNumber(totalIsk)} ISK
      </div>` : ''}
      ${partial.length ? `<div style="font-family:var(--mono);font-size:11px;color:var(--text-3);">
        + ${partial.length} partial
      </div>` : ''}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                   position:sticky;top:0;z-index:1;">
          <th style="text-align:left;padding:8px 14px;font-family:var(--mono);font-size:10px;
                     color:var(--text-3);letter-spacing:0.1em;">RIG</th>
          <th style="text-align:center;padding:8px 8px;font-family:var(--mono);font-size:10px;
                     color:var(--text-3);letter-spacing:0.1em;">SIZE</th>
          <th style="text-align:right;padding:8px 14px;font-family:var(--mono);font-size:10px;
                     color:var(--text-3);letter-spacing:0.1em;">CAN BUILD</th>
          <th style="text-align:right;padding:8px 14px;font-family:var(--mono);font-size:10px;
                     color:var(--accent);letter-spacing:0.1em;">SELL VALUE</th>
          <th style="text-align:left;padding:8px 10px;font-family:var(--mono);font-size:10px;
                     color:var(--text-3);letter-spacing:0.1em;">MISSING MATERIALS</th>
        </tr>
      </thead>
      <tbody>`;

  const renderRow = ({ rig, canBuild, deficit }) => {
    const sell      = _salvagePrices[rig.rigTypeID]?.sell || 0;
    const totalSell = canBuild * sell;
    const sizeLabel = RIG_SIZE_LABEL[rig.rigSize] || '—';
    const rowBg     = canBuild > 0 ? 'rgba(78,203,176,0.04)' : '';
    const sizeBg = {
      1:'rgba(78,203,176,0.10)', 2:'rgba(0,132,255,0.10)',
      3:'rgba(171,122,184,0.10)', 4:'rgba(230,126,34,0.10)',
      5:'rgba(208,38,61,0.12)',   6:'rgba(128,128,128,0.10)',
    }[rig.rigSize] || 'transparent';

    const defStr = deficit.map(d =>
      `<span style="color:var(--danger);">${d.short.toLocaleString()}× ${escHtml(d.name)}</span>`
    ).join('<span style="color:var(--text-5);"> · </span>');

    return `<tr style="border-bottom:1px solid var(--border-e);background:${rowBg};"
                onmouseenter="this.style.background='var(--bg-hover)'"
                onmouseleave="this.style.background='${rowBg}'">
      <td style="padding:8px 14px;display:flex;align-items:center;gap:9px;">
        <img src="${ESI_IMAGE}/${rig.rigTypeID}/icon?size=32"
             style="width:26px;height:26px;border-radius:5px;border:1px solid var(--border);
                    background:var(--bg-deep);flex-shrink:0;"
             onerror="this.style.display='none'"/>
        <span style="color:${canBuild > 0 ? 'var(--text-1)' : 'var(--text-3)'};font-size:12px;">
          ${escHtml(rig.rigName)}
        </span>
      </td>
      <td style="text-align:center;padding:8px 8px;">
        <span style="font-family:var(--mono);font-size:10px;font-weight:700;
                     padding:2px 7px;border-radius:4px;background:${sizeBg};">
          ${sizeLabel}
        </span>
      </td>
      <td style="text-align:right;padding:8px 14px;font-family:var(--mono);
                 font-weight:700;color:${canBuild > 0 ? 'var(--success)' : 'var(--text-5)'};">
        ${canBuild > 0 ? canBuild.toLocaleString() : '0'}
      </td>
      <td style="text-align:right;padding:8px 14px;font-family:var(--mono);color:var(--accent);">
        ${totalSell > 0 ? formatNumber(totalSell) : '<span style="color:var(--text-5);">—</span>'}
      </td>
      <td style="padding:8px 10px;font-size:11px;font-family:var(--mono);">
        ${deficit.length ? defStr : '<span style="color:var(--success);font-size:10px;">✓ sufficient</span>'}
      </td>
    </tr>`;
  };

  html += completable.map(renderRow).join('');

  if (partial.length) {
    html += `<tr><td colspan="5" style="padding:10px 14px;font-family:var(--mono);
      font-size:10px;color:var(--text-3);letter-spacing:0.1em;border-top:2px solid var(--border);
      background:var(--bg-card);">PARTIAL — MISSING MATERIALS</td></tr>`;
    html += partial.map(renderRow).join('');
  }

  html += `</tbody></table>`;
  resultsEl.innerHTML = html;
}
