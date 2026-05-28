// ─── Assets ───────────────────────────────────────────────────────────────────

// ── Read all assets from character_information.db (one call per character) ───
// Returns a flat array with characterId / characterName attached, matching the
// shape the rest of the code expects. No ESI call is made here.
async function loadAssetsFromDb() {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!accounts.length) return [];

  const results = await Promise.all(accounts.map(async (acc) => {
    try {
      const rows = await window.eveAPI.getCharacterAssets(acc.characterId);
      if (!Array.isArray(rows)) return [];
      return rows.map(row => ({
        ...row,
        // DB stores the display name as type_name; normalise to .name so
        // renderNextAssetChunk() works without changes.
        name:          row.type_name || row.name || `Type ${row.type_id}`,
        characterId:   acc.characterId,
        characterName: acc.characterName,
      }));
    } catch (e) {
      console.warn(`[Assets] DB read failed for ${acc.characterName}:`, e.message);
      return [];
    }
  }));

  return results.flat();
}

async function loadAssets() {
  const assetTableBody = document.querySelector('#assetTable tbody');
  const assetSummary   = document.getElementById('assetSummary');

  if (assetTableBody) {
    assetTableBody.innerHTML = '<tr><td colspan="10" class="loading-row">Loading assets from local database…</td></tr>';
  }

  try {
    const allAssets = await loadAssetsFromDb();

    if (!allAssets.length) {
      if (assetTableBody) {
        assetTableBody.innerHTML = '<tr><td colspan="10" class="loading-row">No assets found — sync a character on the Characters page first.</td></tr>';
      }
      if (assetSummary) assetSummary.textContent = 'No assets synced yet — use SYNC on the Characters page.';
      return;
    }

    allAssetsCache = allAssets;

    // Populate character, region, and corp dropdowns from the loaded data
    populateAssetFilters(allAssets);

    // Apply any filters already set (e.g. user reloaded while filters were active)
    filterAssets();

    const wrapper = document.getElementById('assetTableWrapper');
    if (wrapper) {
      wrapper.removeEventListener('scroll', assetTableScrollHandler);
      wrapper.addEventListener('scroll', assetTableScrollHandler);
    }

    // ── Background refresh: re-poll the DB after 5 s and 30 s ───────────────
    // The locator pipeline resolves structure locations asynchronously after a
    // sync. Re-loading from the DB a couple of times catches rows that were
    // NULL on first load but now have region_name / owner_name filled in.
    // We only re-populate filters + re-render if new data actually arrived.
    for (const delayMs of [5000, 30000]) {
      setTimeout(async () => {
        try {
          const refreshed = await loadAssetsFromDb();
          if (!refreshed.length) return;

          // Check if any previously-null region/owner_name fields are now filled
          const prevNullRegions = allAssetsCache.filter(a => !a.region_name).length;
          const newNullRegions  = refreshed.filter(a => !a.region_name).length;
          if (newNullRegions >= prevNullRegions) return; // nothing changed, skip re-render

          allAssetsCache = refreshed;
          populateAssetFilters(refreshed);
          // Only re-render if no filter is active — avoids resetting a user's scroll mid-browse
          const charVal   = document.getElementById('assetCharFilter')?.value   || '';
          const regionVal = document.getElementById('assetRegionFilter')?.value || '';
          const corpVal   = document.getElementById('assetCorpFilter')?.value   || '';
          const searchVal = document.getElementById('assetSearch')?.value       || '';
          if (!charVal && !regionVal && !corpVal && !searchVal) {
            filterAssets();
          } else {
            // Still re-filter in case the active selection now matches more rows
            filterAssets();
          }
        } catch (e) { /* ignore background refresh errors */ }
      }, delayMs);
    }

  } catch (err) {
    if (assetTableBody) {
      assetTableBody.innerHTML = `<tr><td colspan="10" class="loading-row">Failed to load assets: ${err.message}</td></tr>`;
    }
    if (assetSummary) assetSummary.textContent = 'Asset load failed.';
    throw err;
  }
}

// ── Populate character and region dropdowns ───────────────────────────────────
function populateAssetFilters(assets) {
  const charSelect   = document.getElementById('assetCharFilter');
  const regionSelect = document.getElementById('assetRegionFilter');
  const corpSelect   = document.getElementById('assetCorpFilter');
  if (!charSelect || !regionSelect) return;

  // Preserve current selections across a reload
  const prevChar   = charSelect.value;
  const prevRegion = regionSelect.value;
  const prevCorp   = corpSelect?.value || '';

  // Characters — unique by id, sorted by name
  const chars = [...new Map(assets.map(a => [String(a.characterId), a.characterName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  charSelect.innerHTML = '<option value="">All Characters</option>';
  chars.forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    charSelect.appendChild(opt);
  });

  // Regions — unique names, sorted alphabetically; add an "Unresolved" bucket
  // for rows where region_name is still NULL so those assets are never invisible.
  const regions         = [...new Set(assets.map(a => a.region_name).filter(Boolean))].sort();
  const unresolvedCount = assets.filter(a => !a.region_name).length;

  regionSelect.innerHTML = '<option value="">All Regions</option>';
  regions.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    regionSelect.appendChild(opt);
  });
  if (unresolvedCount > 0) {
    const opt = document.createElement('option');
    opt.value = '__unresolved__';
    opt.textContent = `(Unresolved — ${unresolvedCount})`;
    regionSelect.appendChild(opt);
  }

  // Corps (owner_name) — unique, sorted, skip blanks
  if (corpSelect) {
    const corps = [...new Set(assets.map(a => a.owner_name).filter(Boolean))].sort();
    corpSelect.innerHTML = '<option value="">All Corps</option>';
    corps.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      corpSelect.appendChild(opt);
    });
  }

  // Restore previous selections if they still exist
  if (prevChar   && charSelect.querySelector(`option[value="${prevChar}"]`))     charSelect.value   = prevChar;
  if (prevRegion && regionSelect.querySelector(`option[value="${prevRegion}"]`)) regionSelect.value = prevRegion;
  if (prevCorp   && corpSelect?.querySelector(`option[value="${prevCorp}"]`))    corpSelect.value   = prevCorp;
}

// ── Grouped location tree — EVE-style ────────────────────────────────────────
//
// Assets are rendered as collapsible location groups, mirroring the EVE client:
//
//   ▶ 0.5  Jita IV - Moon 4 — 42 Items · 1,234,567 ISK
//       Tritanium                    1000    Minerals
//       Damage Control II              1     Damage Control
//
// State is kept in _assetGroupState (locationKey → expanded bool).
// All groups start expanded. Clicking the header row toggles visibility.
// ─────────────────────────────────────────────────────────────────────────────

// Persistent expand/collapse state across filter changes
if (typeof window._assetGroupState === 'undefined') window._assetGroupState = {};

// ── Filter assets and build grouped tree ─────────────────────────────────────
function filterAssets() {
  if (!allAssetsCache) return;

  const searchVal = (document.getElementById('assetSearch')?.value  || '').toLowerCase().trim();
  const charVal   =  document.getElementById('assetCharFilter')?.value   || '';
  const regionVal =  document.getElementById('assetRegionFilter')?.value || '';
  const corpVal   =  document.getElementById('assetCorpFilter')?.value   || '';

  filteredAssetsCache = allAssetsCache.filter(asset => {
    if (charVal && String(asset.characterId) !== charVal) return false;
    if (regionVal === '__unresolved__') {
      if (asset.region_name) return false;
    } else if (regionVal && (asset.region_name || '') !== regionVal) {
      return false;
    }
    if (corpVal && (asset.owner_name || '') !== corpVal) return false;
    if (searchVal) {
      const name     = (asset.name     || asset.type_name || '').toLowerCase();
      const location = (asset.location_name || '').toLowerCase();
      const corp     = (asset.owner_name    || '').toLowerCase();
      const region   = (asset.region_name   || '').toLowerCase();
      const sys      = (asset.solar_system_name || '').toLowerCase();
      if (!name.includes(searchVal) && !location.includes(searchVal) &&
          !corp.includes(searchVal) && !region.includes(searchVal) &&
          !sys.includes(searchVal)) return false;
    }
    return true;
  });

  // Update summary
  const assetSummary = document.getElementById('assetSummary');
  if (assetSummary) {
    const charCount = new Set(filteredAssetsCache.map(a => String(a.characterId))).size;
    const suffix    = filteredAssetsCache.length < allAssetsCache.length
      ? ` (filtered from ${allAssetsCache.length.toLocaleString()})`
      : ' · local DB';
    assetSummary.textContent =
      `${filteredAssetsCache.length.toLocaleString()} assets across ${charCount} character(s)${suffix}`;
  }

  renderAssetTree();
}

// Not used in tree mode but kept so scroll-listener wiring doesn't break
function assetTableScrollHandler() {}

// ── Build and render the full location-grouped tree ───────────────────────────
function renderAssetTree() {
  const tbody = document.querySelector('#assetTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const source = filteredAssetsCache || allAssetsCache;
  if (!source || !source.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="loading-row">No assets match the current filters.</td></tr>';
    return;
  }

  // ── Group by location ──────────────────────────────────────────────────────
  // Key = location_id so we never merge two different structures even if they
  // happen to share a display name.
  const groupMap = new Map(); // locationKey → { meta, items[] }
  for (const asset of source) {
    const key = String(asset.location_id || asset.location_name || 'unknown');
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        locationName:    asset.location_name    || `Location ${asset.location_id}`,
        solarSystemName: asset.solar_system_name || '',
        regionName:      asset.region_name       || '',
        secStatus:       asset.security_status,
        ownerName:       asset.owner_name        || '',
        characterId:     asset.characterId,
        characterName:   asset.characterName,
        items: [],
      });
    }
    groupMap.get(key).items.push(asset);
  }

  // ── Sort groups: by region → solar system → location name ─────────────────
  const groups = [...groupMap.values()].sort((a, b) => {
    const ra = a.regionName.localeCompare(b.regionName);
    if (ra !== 0) return ra;
    const sa = a.solarSystemName.localeCompare(b.solarSystemName);
    if (sa !== 0) return sa;
    return a.locationName.localeCompare(b.locationName);
  });

  // ── Collect all type_ids that need prices ──────────────────────────────────
  const allTypeIds = [...new Set(source.map(a => a.type_id).filter(Boolean))].filter(t => !priceCache[t]);
  if (allTypeIds.length) {
    // Fetch in background; cells update when the promise resolves
    window.eveAPI.getJitaPrices(allTypeIds).then(priceMap => {
      Object.assign(priceCache, priceMap || {});
      _updateAssetPriceCells();
    }).catch(() => {});
  }

  // ── Render each group ──────────────────────────────────────────────────────
  // Use a numeric group index (gi) as the DOM link between header and item rows.
  // This avoids CSS.escape issues with location_id strings in querySelectorAll.
  const frag = document.createDocumentFragment();

  groups.forEach((group, gi) => {
    const isExpanded = window._assetGroupState[group.key] !== false; // default open
    const itemCount  = group.items.length;

    // Sec status
    let secColor = '#666';
    let secStr   = '';
    if (typeof group.secStatus === 'number') {
      const sec = group.secStatus;
      secStr  = sec.toFixed(1);
      if      (sec >= 0.5) secColor = '#4ecbb0';
      else if (sec >= 0.1) secColor = '#e6c84a';
      else                 secColor = '#e05252';
    }

    // System · Region subtitle
    const subtitle = [group.solarSystemName, group.regionName].filter(Boolean).join(' · ');

    // Character portrait
    const portrait = `https://images.evetech.net/characters/${group.characterId}/portrait?size=32`;

    // ── Group header row ───────────────────────────────────────────────────
    const headerTr = document.createElement('tr');
    headerTr.className = 'asset-group-header';
    headerTr.dataset.gi       = gi;
    headerTr.dataset.expanded = isExpanded ? '1' : '0';
    headerTr.innerHTML = `
      <td colspan="5" class="asset-group-header-cell">
        <div class="asset-group-inner">
          <span class="asset-group-chevron">${isExpanded ? '▼' : '▶'}</span>
          <img class="asset-group-portrait"
               src="${portrait}"
               alt="${escHtml(group.characterName)}"
               title="${escHtml(group.characterName)}" />
          ${secStr ? `<span class="asset-group-sec" style="color:${secColor}">${secStr}</span>` : ''}
          <span class="asset-group-location">${escHtml(group.locationName)}</span>
          ${subtitle ? `<span class="asset-group-subtitle">· ${escHtml(subtitle)}</span>` : ''}
          <span class="asset-group-spacer"></span>
          <span class="asset-group-count">${itemCount.toLocaleString()} item${itemCount !== 1 ? 's' : ''}</span>
          <span class="asset-group-value" data-gi="${gi}">—</span>
        </div>
      </td>`;
    headerTr.addEventListener('click', _toggleAssetGroup);
    frag.appendChild(headerTr);

    // ── Item rows ──────────────────────────────────────────────────────────
    const sorted = [...group.items].sort((a, b) =>
      (a.name || a.type_name || '').localeCompare(b.name || b.type_name || ''));

    for (const asset of sorted) {
      const itemTr = document.createElement('tr');
      itemTr.className        = 'asset-item-row' + (isExpanded ? '' : ' asset-row-hidden');
      itemTr.dataset.gi       = gi;
      itemTr.dataset.typeId   = asset.type_id  || '';
      itemTr.dataset.quantity = asset.quantity || 1;

      const qty      = asset.quantity || 1;
      const itemName = asset.name || asset.type_name || `Type ${asset.type_id}`;
      const vol      = asset.volume != null ? Number(asset.volume).toFixed(2) : '—';

      const iconHtml = asset.type_id
        ? `<img class="asset-type-icon"
                src="https://images.evetech.net/types/${asset.type_id}/icon?size=32"
                alt="" loading="lazy" />`
        : `<span class="asset-type-icon-placeholder"></span>`;

      const cachedEntry = priceCache[asset.type_id] || {};
      const cachedPrice = cachedEntry.sell || cachedEntry.buy || 0;
      const priceText   = cachedPrice
        ? `${Math.round(cachedPrice * qty).toLocaleString('en-US')} ISK`
        : 'Loading…';
      const priceClass  = cachedPrice ? 'has-price' : 'price-loading';

      itemTr.innerHTML = `
        <td class="asset-item-icon-cell">${iconHtml}</td>
        <td class="asset-item-name-cell">${escHtml(itemName)}</td>
        <td class="asset-item-qty-cell">${qty > 1 ? qty.toLocaleString() : ''}</td>
        <td class="asset-item-vol-cell">${vol}</td>
        <td class="asset-item-price-cell ${priceClass}"
            data-type-id="${asset.type_id || ''}"
            data-quantity="${qty}">${priceText}</td>`;

      frag.appendChild(itemTr);
    }
  });

  tbody.appendChild(frag);
  _updateAssetPriceCells();
  initAssetColResize();
}

// ── Toggle a location group open/closed ───────────────────────────────────────
function _toggleAssetGroup(e) {
  const headerTr  = e.currentTarget;
  const gi        = headerTr.dataset.gi;
  const expanding = headerTr.dataset.expanded !== '1';

  headerTr.dataset.expanded = expanding ? '1' : '0';
  const chev = headerTr.querySelector('.asset-group-chevron');
  if (chev) chev.textContent = expanding ? '▼' : '▶';

  // Persist state by location key stored as a sibling data attr
  const key = headerTr.dataset.groupKey || gi;
  window._assetGroupState[key] = expanding;

  // Toggle all item rows that share the same group index
  const tbody = headerTr.closest('tbody');
  if (!tbody) return;
  tbody.querySelectorAll(`.asset-item-row[data-gi="${gi}"]`).forEach(row => {
    row.classList.toggle('asset-row-hidden', !expanding);
  });
}

// ── Update price cells and group value totals ─────────────────────────────────
function _updateAssetPriceCells() {
  const tbody = document.querySelector('#assetTable tbody');
  if (!tbody) return;

  // Update individual item price cells
  tbody.querySelectorAll('td.asset-item-price-cell[data-type-id]').forEach(td => {
    const typeId = Number(td.dataset.typeId);
    const qty    = Number(td.dataset.quantity) || 1;
    if (!typeId || !priceCache[typeId]) return;
    const entry = priceCache[typeId];
    const price = entry.sell || entry.buy || 0;
    if (price) {
      td.textContent = `${Math.round(price * qty).toLocaleString('en-US')} ISK`;
      td.classList.remove('price-loading', 'price-na');
      td.classList.add('has-price');
    } else if (td.textContent === 'Loading…') {
      td.textContent = 'N/A';
      td.classList.remove('price-loading');
      td.classList.add('price-na');
    }
  });

  // Roll up group totals keyed by gi (numeric group index)
  const groupTotals = {};
  tbody.querySelectorAll('tr.asset-item-row').forEach(row => {
    const gi     = row.dataset.gi;
    const typeId = Number(row.dataset.typeId);
    const qty    = Number(row.dataset.quantity) || 1;
    if (!gi || !typeId || !priceCache[typeId]) return;
    const price = priceCache[typeId].sell || priceCache[typeId].buy || 0;
    groupTotals[gi] = (groupTotals[gi] || 0) + price * qty;
  });

  // Write totals into header value spans (also keyed by gi)
  tbody.querySelectorAll('.asset-group-value[data-gi]').forEach(el => {
    const gi    = el.dataset.gi;
    const total = groupTotals[gi] || 0;
    el.textContent = total > 0
      ? `${Math.round(total).toLocaleString('en-US')} ISK`
      : '—';
  });
}

// Keep this as a no-op — tree renders all at once, scroll is no longer needed
function renderNextAssetChunk() {}

// ── Draggable column resizing ─────────────────────────────────────────────────
//
// Injects a 6 px drag handle at the right edge of every <th> in #assetTable.
// Column widths are persisted to localStorage so they survive page reloads.
// Call once after the table is first rendered; safe to call again (idempotent).
// ─────────────────────────────────────────────────────────────────────────────

const ASSET_COL_STORAGE_KEY = 'assetColWidths';

/** Default column widths in pixels (order matches the 5 <th> elements).
 *  Icon | Item | Qty | Volume | Jita 4-4 Value */
const ASSET_COL_DEFAULTS = [40, 320, 80, 110, 150];
const ASSET_COL_MIN      = 32;   // px — minimum draggable width

function _assetSaveColWidths(widths) {
  try { localStorage.setItem(ASSET_COL_STORAGE_KEY, JSON.stringify(widths)); } catch (e) {}
}

function _assetLoadColWidths() {
  try {
    const raw = localStorage.getItem(ASSET_COL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Discard stale widths saved from the old 10-column layout
      if (Array.isArray(parsed) && parsed.length === ASSET_COL_DEFAULTS.length) return parsed;
      localStorage.removeItem(ASSET_COL_STORAGE_KEY);
    }
  } catch (e) {}
  return [...ASSET_COL_DEFAULTS];
}

function _assetApplyColWidths(ths, widths) {
  ths.forEach((th, i) => {
    th.style.width    = widths[i] + 'px';
    th.style.minWidth = widths[i] + 'px';
  });
}

function initAssetColResize() {
  const table = document.getElementById('assetTable');
  if (!table) return;

  const ths = Array.from(table.querySelectorAll('thead th'));
  if (!ths.length) return;

  // Remove handles from any previous call (idempotent)
  table.querySelectorAll('.col-resize-handle').forEach(h => h.remove());

  // Apply saved (or default) widths to ths
  const widths = _assetLoadColWidths();
  _assetApplyColWidths(ths, widths);

  // Full-screen drag overlay — sits on top of everything during a drag so
  // mousemove/mouseup are never swallowed by iframes, scrollers, or Electron's
  // webview hit-testing. Removed the moment the mouse is released.
  function _makeDragOverlay() {
    const ov = document.createElement('div');
    ov.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'cursor:col-resize', 'user-select:none',
    ].join(';');
    document.body.appendChild(ov);
    return ov;
  }

  ths.forEach((th, colIdx) => {
    const handle = document.createElement('span');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startX  = e.clientX;
      const startW  = th.getBoundingClientRect().width; // reliable after layout
      const overlay = _makeDragOverlay();
      handle.classList.add('dragging');

      const onMove = (ev) => {
        const newW = Math.max(ASSET_COL_MIN, startW + (ev.clientX - startX));
        widths[colIdx]    = Math.round(newW);
        th.style.width    = newW + 'px';
        th.style.minWidth = newW + 'px';
      };

      const onUp = () => {
        overlay.remove();
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup',   onUp,   true);
        _assetSaveColWidths(widths);
      };

      // Use capture so events fire even if a child calls stopPropagation
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup',   onUp,   true);
    });
  });
}

// Pre-fetch assets from local DB in the background at startup (non-blocking).
// No ESI call — just warms allAssetsCache so the Assets page opens instantly.
async function prefetchAssetsBackground() {
  try {
    const cached = await loadAssetsFromDb();
    if (cached?.length) {
      allAssetsCache = cached;
      populateAssetFilters(cached);
    }
  } catch (e) { /* ignore */ }
}

// ── Wallets ───────────────────────────────────────────────────────────────────
// Reads wallet balances exclusively from character_information.db via
// getCharacterData(). Falls back to the dashboard cache only as a secondary
// layer; never calls ESI directly.
async function renderWallets() {
  const walletsGrid = document.getElementById('walletsGrid');
  if (!walletsGrid) return;
  if (walletsGrid._isLoading) return;
  walletsGrid._isLoading = true;

  try {
    walletsGrid.innerHTML = '';
    const accounts = await window.eveAPI.getAccounts();

    // Pull wallet balances from the local DB for every character.
    // getCharacterData() returns { info, wallet, location, ship, … } where
    // wallet is the most-recent row from char_X_wallet (balance + synced_at).
    // If the DB has no row yet (character never synced) we fall back to the
    // dashboard cache, then to 0 — never to a live ESI call.
    const cachedDash    = await window.eveAPI.cacheGet('dashboard_cache').catch(() => null);
    const cachedWallets = cachedDash?.walletByChar || {};

    const cardData = await Promise.all(accounts.map(async (account) => {
      let rawBalance = 0;
      let syncedAt   = null;

      try {
        const charData = await window.eveAPI.getCharacterData(account.characterId);
        if (charData?.wallet?.balance != null) {
          rawBalance = charData.wallet.balance;
          syncedAt   = charData.wallet.synced_at || null;
        } else {
          // No DB row yet — use dashboard cache if available, otherwise 0.
          rawBalance = cachedWallets[String(account.characterId)] ?? 0;
        }
      } catch (e) {
        console.warn(`[Wallets] DB read failed for ${account.characterName}:`, e.message);
        rawBalance = cachedWallets[String(account.characterId)] ?? 0;
      }

      return { account, rawBalance, syncedAt };
    }));

    cardData.forEach(({ account, rawBalance, syncedAt }) => {
      // Format the last-synced timestamp for display.
      let syncLabel = 'Never synced';
      if (syncedAt) {
        const d = new Date(syncedAt);
        syncLabel = `Synced ${d.toLocaleString()}`;
      }

      const card = document.createElement('div');
      card.className = 'wallet-card';
      card.innerHTML = `
        <div class="wallet-header">
          <img class="wallet-avatar"
               src="https://images.evetech.net/characters/${account.characterId}/portrait?size=64"
               alt="${escHtml(account.characterName)}">
          <div class="wallet-info">
            <span class="wallet-name">${escHtml(account.characterName)}</span>
            <span class="wallet-corp">Corp Ticker</span>
          </div>
        </div>
        <div class="wallet-balance-container">
          <span class="wallet-balance-label">Liquid Wealth</span>
          <span class="wallet-balance">
            <span class="wallet-balance-number">0.00</span>
            <span class="isk-symbol"> ISK</span>
          </span>
        </div>
        <div class="wallet-footer">
          <span class="wallet-meta">${escHtml(syncLabel)}</span>
          <button class="wallet-action journal-open-btn" data-char-id="${account.characterId}" data-char-name="${escHtml(account.characterName)}">View Journal</button>
        </div>`;
      walletsGrid.appendChild(card);
      countUp(card.querySelector('.wallet-balance-number'), rawBalance);

      // Wire View Journal button
      card.querySelector('.journal-open-btn').addEventListener('click', () => {
        openWalletJournal(account.characterId, account.characterName);
      });
    });
  } finally {
    walletsGrid._isLoading = false;
  }
}
// ── Wallet Journal Modal ───────────────────────────────────────────────────────

// EVE ref_type → category mapping for the ring chart
const JOURNAL_CATEGORIES = {
  bounty_prizes:              'Bounty',
  bounty_prize:               'Bounty',
  agent_mission_reward:       'Bounty',
  agent_mission_time_bonus_reward: 'Bounty',
  mission_reward:             'Bounty',
  incursion_participant_payou: 'Bounty',
  // Trade
  market_transaction:         'Trade',
  contract_reward:            'Trade',
  contract_price:             'Trade',
  contract_collateral:        'Trade',
  contract_deposit:           'Trade',
  contract_auction_bid:       'Trade',
  contract_auction_bid_corp:  'Trade',
  contract_price_payment_corp:'Trade',
  market_escrow:              'Trade',
  transaction_tax:            'Trade',
  brokers_fee:                'Trade',
  // Transfers
  player_donation:            'Transfers',
  corporation_account_withdrawal: 'Transfers',
  corporation_dividend_payment:   'Transfers',
  ess_escrow_transfer:        'Transfers',
  // Miscellaneous (everything else falls here)
};

const CATEGORY_COLORS = {
  Bounty:    '#e05252',   // red
  Trade:     '#4ecbb0',   // teal
  Misc:      '#8c8c8c',   // grey
  Transfers: '#e6c84a',   // yellow
};

function classifyEntry(entry) {
  const rt = (entry.ref_type || '').toLowerCase();
  return JOURNAL_CATEGORIES[rt] || 'Misc';
}

async function openWalletJournal(characterId, characterName) {
  const backdrop = document.getElementById('walletJournalBackdrop');
  if (!backdrop) return;

  // Set header
  document.getElementById('journalCharPortrait').src =
    `https://images.evetech.net/characters/${characterId}/portrait?size=64`;
  document.getElementById('journalCharName').textContent = characterName;

  // Reset to overview tab
  setJournalTab('overview');
  backdrop.style.display = 'flex';

  // Load data in parallel
  const [journalEntries, lpData] = await Promise.all([
    loadJournalEntries(characterId),
    loadLPData(characterId),
  ]);

  renderJournalOverview(journalEntries);
  renderJournalTransactions(journalEntries);
  renderJournalLP(lpData);
}

function closeWalletJournal() {
  const backdrop = document.getElementById('walletJournalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
  // Destroy chart to free memory
  const canvas = document.getElementById('journalRingChart');
  if (canvas && canvas._chartInstance) {
    canvas._chartInstance.destroy();
    canvas._chartInstance = null;
  }
}

function setJournalTab(tab) {
  document.querySelectorAll('.journal-tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.style.background = active ? 'var(--accent)' : 'none';
    btn.style.color      = active ? '#000' : 'var(--text-2)';
    btn.classList.toggle('active', active);
  });
  document.querySelectorAll('.journal-tab-content').forEach(el => {
    el.style.display = el.id === `journalTab-${tab}` ? '' : 'none';
  });
}

// Bind tab buttons (runs once when modal HTML is created; safe to call multiple times)
(function bindJournalTabs() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.journal-tab-btn');
    if (!btn) return;
    setJournalTab(btn.dataset.tab);
  });
  // Close on backdrop click
  document.addEventListener('click', (e) => {
    const backdrop = document.getElementById('walletJournalBackdrop');
    if (backdrop && e.target === backdrop) closeWalletJournal();
  });
})();

// ── Data loaders ─────────────────────────────────────────────────────────────
async function loadJournalEntries(characterId) {
  // Primary: read from CharDB (synced every 30 min by coreCharacterSync)
  try {
    const rows = await window.eveAPI.getWalletJournal(characterId);
    if (Array.isArray(rows) && rows.length) return rows;
  } catch (e) { /* fall through */ }
  // Fallback: live ESI call if DB is empty (e.g. character never synced yet)
  try {
    const url  = `https://esi.evetech.net/v6/characters/${characterId}/wallet/journal/?datasource=tranquility&page=1`;
    const data = await window.eveAPI.esiFetch(url).catch(() => null);
    if (Array.isArray(data) && data.length) return data;
  } catch (e) { /* ignore */ }
  return [];
}

async function loadLPData(characterId) {
  // Primary: read from CharDB (synced every 30 min by coreCharacterSync)
  try {
    const rows = await window.eveAPI.getLoyaltyPoints(characterId);
    if (Array.isArray(rows) && rows.length) return rows;
  } catch (e) { /* fall through */ }
  // Fallback: live ESI call if DB is empty
  try {
    const url  = `https://esi.evetech.net/v1/characters/${characterId}/loyalty/points/?datasource=tranquility`;
    const data = await window.eveAPI.esiFetch(url).catch(() => null);
    if (Array.isArray(data)) return data;
  } catch (e) { /* ignore */ }
  return [];
}

// ── Renderers ─────────────────────────────────────────────────────────────────
function renderJournalOverview(entries) {
  const now    = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;

  // Only last 30 days
  const recent = entries.filter(e => {
    const t = e.date ? new Date(e.date).getTime() : 0;
    return t >= cutoff;
  });

  // Split income vs expenses by category
  const incomeByCat  = { Bounty: 0, Trade: 0, Misc: 0, Transfers: 0 };
  const expenseByCat = { Bounty: 0, Trade: 0, Misc: 0, Transfers: 0 };
  let totalIncome = 0, totalExpense = 0;

  recent.forEach(e => {
    const amt = parseFloat(e.amount) || 0;
    const cat = classifyEntry(e);
    if (amt >= 0) {
      incomeByCat[cat] = (incomeByCat[cat] || 0) + amt;
      totalIncome += amt;
    } else {
      expenseByCat[cat] = (expenseByCat[cat] || 0) + Math.abs(amt);
      totalExpense += Math.abs(amt);
    }
  });

  // Update income/expense totals
  document.getElementById('journalIncomeTotal').textContent  = formatISK(totalIncome);
  document.getElementById('journalExpenseTotal').textContent = formatISK(totalExpense);
  document.getElementById('journalRingValue').textContent    = formatISK(totalIncome);

  // Build chart data from income categories only
  const cats   = Object.keys(incomeByCat).filter(c => incomeByCat[c] > 0);
  const values = cats.map(c => incomeByCat[c]);
  const colors = cats.map(c => CATEGORY_COLORS[c] || '#8c8c8c');

  // Legend
  const legendEl = document.getElementById('journalLegend');
  if (legendEl) {
    const allCats = Object.keys(incomeByCat);
    legendEl.innerHTML = allCats.map(cat => {
      const pct = totalIncome > 0 ? (incomeByCat[cat] / totalIncome * 100).toFixed(1) : '0.0';
      const amt = formatISK(incomeByCat[cat]);
      return `<div style="display:flex;align-items:center;gap:12px;">
        <span style="width:12px;height:12px;border-radius:50%;background:${CATEGORY_COLORS[cat]};flex-shrink:0;"></span>
        <span style="font-size:13px;color:var(--text-2);font-family:var(--mono);min-width:44px;">${pct}%</span>
        <span style="font-size:13px;color:var(--text-1);flex:1;">${cat}</span>
        <span style="font-size:12px;color:var(--text-3);font-family:var(--mono);">${amt}</span>
      </div>`;
    }).join('');
  }

  // Ring chart
  const canvas = document.getElementById('journalRingChart');
  if (!canvas) return;
  if (canvas._chartInstance) {
    canvas._chartInstance.destroy();
    canvas._chartInstance = null;
  }
  if (typeof Chart === 'undefined') return;

  canvas._chartInstance = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: cats,
      datasets: [{
        data:            values.length ? values : [1],
        backgroundColor: values.length ? colors : ['#2a2a2a'],
        borderColor:     'transparent',
        borderWidth:     0,
        hoverOffset:     6,
      }]
    },
    options: {
      cutout: '86%',
      responsive: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              const pct = totalIncome > 0 ? (v / totalIncome * 100).toFixed(1) : '0.0';
              return ` ${pct}%  ${formatISK(v)}`;
            }
          }
        }
      }
    }
  });
}

function renderJournalTransactions(entries) {
  const tbody = document.getElementById('journalTransactionBody');
  if (!tbody) return;

  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-3);font-family:var(--mono);font-size:12px;">No journal entries found. Sync this character to populate data.</td></tr>`;
    return;
  }

  // Sort newest first
  const sorted = [...entries].sort((a, b) => {
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  tbody.innerHTML = sorted.slice(0, 500).map(e => {
    const amt     = parseFloat(e.amount) || 0;
    const bal     = parseFloat(e.balance) || 0;
    const amtColor = amt >= 0 ? '#4ecbb0' : 'var(--danger)';
    const amtStr   = (amt >= 0 ? '+' : '') + formatISK(amt);
    const dateStr  = e.date ? new Date(e.date).toLocaleString('en-ZA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }) : '—';
    // Human-readable ref type
    const typeLabel = (e.ref_type || '—')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    const desc = escHtml(e.description || e.reason || '—');

    return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
      <td style="padding:9px 12px;font-size:11px;color:var(--text-3);font-family:var(--mono);white-space:nowrap;">${dateStr}</td>
      <td style="padding:9px 12px;font-size:12px;color:var(--text-2);white-space:nowrap;">${typeLabel}</td>
      <td style="padding:9px 12px;font-size:12px;color:${amtColor};font-family:var(--mono);text-align:right;white-space:nowrap;">${amtStr}</td>
      <td style="padding:9px 12px;font-size:12px;color:var(--text-3);font-family:var(--mono);text-align:right;white-space:nowrap;">${formatISK(bal)}</td>
      <td style="padding:9px 12px;font-size:12px;color:var(--text-2);max-width:300px;word-break:break-word;">${desc}</td>
    </tr>`;
  }).join('');
}

async function renderJournalLP(lpRows) {
  const tbody = document.getElementById('journalLPBody');
  if (!tbody) return;

  if (!lpRows.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--text-3);font-family:var(--mono);font-size:12px;">No LP data found. Sync this character to populate standings.</td></tr>`;
    return;
  }

  // Sort by LP descending
  const sorted = [...lpRows].sort((a, b) => (b.loyalty_points || 0) - (a.loyalty_points || 0));

  // Resolve corporation names via ESI names endpoint
  let nameMap = {};
  try {
    const ids = sorted.map(r => r.corporation_id).filter(Boolean);
    if (ids.length) {
      const names = await window.eveAPI.getNames(ids).catch(() => []);
      if (Array.isArray(names)) names.forEach(n => { nameMap[n.id] = n.name; });
    }
  } catch (e) { /* leave names as IDs */ }

  tbody.innerHTML = sorted.map(row => {
    const corpId   = row.corporation_id || 0;
    const corpName = escHtml(nameMap[corpId] || `Corp ${corpId}`);
    const lp       = (row.loyalty_points || 0).toLocaleString();
    // No live store lookup available without additional ESI; show placeholder
    const store    = '—';

    return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
      <td style="padding:11px 16px;font-size:13px;color:var(--text-1);">${corpName}</td>
      <td style="padding:11px 16px;font-size:13px;color:var(--accent);font-family:var(--mono);text-align:right;">${lp}</td>
      <td style="padding:11px 16px;font-size:12px;color:var(--text-3);">${store}</td>
    </tr>`;
  }).join('');
}