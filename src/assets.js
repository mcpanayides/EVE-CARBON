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

    // Populate character and region dropdowns from the loaded data
    populateAssetFilters(allAssets);

    // Apply any filters already set (e.g. user reloaded while filters were active)
    filterAssets();

    const wrapper = document.getElementById('assetTableWrapper');
    if (wrapper) {
      wrapper.removeEventListener('scroll', assetTableScrollHandler);
      wrapper.addEventListener('scroll', assetTableScrollHandler);
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
  if (!charSelect || !regionSelect) return;

  // Preserve current selections across a reload
  const prevChar   = charSelect.value;
  const prevRegion = regionSelect.value;

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

  // Regions — unique names, sorted alphabetically, skip blanks
  const regions = [...new Set(assets.map(a => a.region_name).filter(Boolean))].sort();

  regionSelect.innerHTML = '<option value="">All Regions</option>';
  regions.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    regionSelect.appendChild(opt);
  });

  // Restore previous selections if they still exist
  if (prevChar   && charSelect.querySelector(`option[value="${prevChar}"]`))     charSelect.value   = prevChar;
  if (prevRegion && regionSelect.querySelector(`option[value="${prevRegion}"]`)) regionSelect.value = prevRegion;
}

// ── Filter assets and re-render table ────────────────────────────────────────
function filterAssets() {
  if (!allAssetsCache) return;

  const searchVal = (document.getElementById('assetSearch')?.value  || '').toLowerCase().trim();
  const charVal   =  document.getElementById('assetCharFilter')?.value   || '';
  const regionVal =  document.getElementById('assetRegionFilter')?.value || '';

  filteredAssetsCache = allAssetsCache.filter(asset => {
    if (charVal   && String(asset.characterId) !== charVal)                           return false;
    if (regionVal && (asset.region_name || '') !== regionVal)                         return false;
    if (searchVal) {
      const name     = (asset.name     || asset.type_name || '').toLowerCase();
      const location = (asset.location_name || '').toLowerCase();
      if (!name.includes(searchVal) && !location.includes(searchVal))                return false;
    }
    return true;
  });

  // Update summary count
  const assetSummary = document.getElementById('assetSummary');
  if (assetSummary) {
    const charCount = new Set(filteredAssetsCache.map(a => String(a.characterId))).size;
    const suffix    = filteredAssetsCache.length < allAssetsCache.length
      ? ` (filtered from ${allAssetsCache.length.toLocaleString()})`
      : ' · local DB';
    assetSummary.textContent =
      `${filteredAssetsCache.length.toLocaleString()} assets across ${charCount} character(s)${suffix}`;
  }

  // Reset render position and redraw
  assetsRenderPos = 0;
  const tbody = document.querySelector('#assetTable tbody');
  if (tbody) tbody.innerHTML = '';

  if (!filteredAssetsCache.length) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="loading-row">No assets match the current filters.</td></tr>';
    return;
  }

  renderNextAssetChunk();
}

function assetTableScrollHandler(e) {
  const wrapper = e.currentTarget;
  if (!wrapper) return;
  if (wrapper.scrollTop + wrapper.clientHeight >= wrapper.scrollHeight - 300) {
    renderNextAssetChunk();
  }
}

function renderNextAssetChunk() {
  const tbody = document.querySelector('#assetTable tbody');
  const source = filteredAssetsCache || allAssetsCache;
  if (!tbody || !source) return;

  const start = assetsRenderPos;
  const end   = Math.min(source.length, start + ASSET_CHUNK);
  if (start >= end) return;

  const chunk = source.slice(start, end);
  const html  = chunk.map((asset, idx) => {
    const ownerPortrait = `https://images.evetech.net/characters/${asset.characterId}/portrait?size=64`;
    const location      = asset.location_name      || `ID ${asset.location_id}`;
    const regionName    = asset.region_name         || '—';
    const secStatus     = typeof asset.security_status === 'number'
                            ? asset.security_status.toFixed(2)
                            : '—';
    const itemName      = asset.name               || `Type ${asset.type_id}`;
    // quantity is already the grouped/stacked total from the DB query
    const qty           = asset.quantity            || 1;
    const totalVolume   = ((asset.volume || 0) * qty) || 0;
    return `
      <tr data-type-id="${asset.type_id || ''}" data-index="${start + idx}" data-quantity="${qty}">
        <td class="asset-owner-cell">
          <div class="asset-owner-wrap">
            <img class="asset-owner-portrait" src="${ownerPortrait}" alt="${asset.characterName}"/>
            <div class="asset-owner-name">${asset.characterName}</div>
          </div>
        </td>
        <td class="asset-qty">${qty.toLocaleString()}</td>
        <td>${itemName}</td>
        <td>${location}</td>
        <td class="asset-constellation">${asset.solar_system_name || '—'}</td>
        <td class="asset-region">${regionName}</td>
        <td class="asset-sec">${secStatus}</td>
        <td class="asset-corp">—</td>
        <td class="asset-price" data-type-id="${asset.type_id || ''}">Loading...</td>
        <td>${totalVolume.toFixed(2)}</td>
      </tr>`;
  }).join('');

  tbody.insertAdjacentHTML('beforeend', html);
  assetsRenderPos = end;

  // Fetch prices for new types
  const typesNeeded = [...new Set(chunk.map(a => a.type_id).filter(Boolean))].filter(t => !priceCache[t]);
  if (typesNeeded.length) {
    window.eveAPI.getJitaPrices(typesNeeded).then(priceMap => {
      Object.assign(priceCache, priceMap || {});
      typesNeeded.forEach(typeId => {
        const entry = priceMap[typeId] || {};
        const price = entry.sell || entry.buy || 0;
        document.querySelectorAll(`.asset-price[data-type-id="${typeId}"]`).forEach(td => {
          const row = td.closest('tr');
          const qty = Number(row?.dataset.quantity) || 1;
          td.textContent = price ? `${Math.round(price * qty).toLocaleString('en-US')} ISK` : 'N/A';
        });
      });
    }).catch(() => { /* leave Loading... */ });
  }
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
          <button class="wallet-action">View Journal</button>
        </div>`;
      walletsGrid.appendChild(card);
      countUp(card.querySelector('.wallet-balance-number'), rawBalance);
    });
  } finally {
    walletsGrid._isLoading = false;
  }
}