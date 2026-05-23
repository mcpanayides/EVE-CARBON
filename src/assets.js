// ─── Assets ───────────────────────────────────────────────────────────────────

async function loadAssets() {
  const assetTableBody = document.querySelector('#assetTable tbody');
  const assetSummary   = document.getElementById('assetSummary');

  if (assetTableBody) {
    assetTableBody.innerHTML = '<tr><td colspan="9" class="loading-row">Loading assets...</td></tr>';
  }

  try {
    const allAssets = allAssetsCache || await window.eveAPI.getAllAssets();

    if (!allAssets?.length) {
      if (assetTableBody) {
        assetTableBody.innerHTML = '<tr><td colspan="9" class="loading-row">No assets found. Click Sync Assets to import.</td></tr>';
      }
      if (assetSummary) assetSummary.textContent = 'No assets imported yet.';
      return;
    }

    allAssetsCache  = allAssets;
    assetsRenderPos = 0;
    if (assetSummary) assetSummary.textContent = `${allAssets.length} asset records available.`;
    if (assetTableBody) assetTableBody.innerHTML = '';

    renderNextAssetChunk();

    const wrapper = document.getElementById('assetTableWrapper');
    if (wrapper) {
      wrapper.removeEventListener('scroll', assetTableScrollHandler);
      wrapper.addEventListener('scroll', assetTableScrollHandler);
    }
  } catch (err) {
    if (assetTableBody) {
      assetTableBody.innerHTML = `<tr><td colspan="9" class="loading-row">Failed to load assets: ${err.message}</td></tr>`;
    }
    if (assetSummary) assetSummary.textContent = 'Asset load failed.';
    throw err;
  }
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
  if (!tbody || !allAssetsCache) return;

  const start = assetsRenderPos;
  const end   = Math.min(allAssetsCache.length, start + ASSET_CHUNK);
  if (start >= end) return;

  const chunk = allAssetsCache.slice(start, end);
  const html  = chunk.map((asset, idx) => {
    const ownerPortrait = `https://images.evetech.net/characters/${asset.characterId}/portrait?size=64`;
    const location      = asset.location_name || `ID ${asset.location_id}`;
    const itemName      = asset.name          || `Type ${asset.type_id}`;
    const qty           = asset.quantity      || 1;
    const totalVolume   = ((asset.volume || 0) * qty) || 0;
    return `
      <tr data-type-id="${asset.type_id || ''}" data-index="${start + idx}" data-quantity="${qty}">
        <td class="asset-owner-cell">
          <div class="asset-owner-wrap">
            <img class="asset-owner-portrait" src="${ownerPortrait}" alt="${asset.characterName}"/>
            <div class="asset-owner-name">${asset.characterName}</div>
          </div>
        </td>
        <td>${itemName}</td>
        <td>${location}</td>
        <td class="asset-constellation">${asset.constellation_name || '—'}</td>
        <td class="asset-region">${asset.region_name || '—'}</td>
        <td class="asset-sec">${typeof asset.security_status === 'number' ? asset.security_status.toFixed(2) : '—'}</td>
        <td class="asset-corp">${asset.owner_name || '—'}</td>
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
          td.textContent = price ? formatCurrency(price * qty) : 'N/A';
        });
      });
    }).catch(() => { /* leave Loading... */ });
  }
}

async function syncAllAssets() {
  const assetSummary = document.getElementById('assetSummary');
  const spinner      = document.getElementById('syncSpinner');
  const btn          = document.getElementById('syncAssetsBtn');
  try {
    if (spinner) { spinner.style.display = 'inline-block'; spinner.classList.add('spin'); }
    if (btn)     btn.disabled = true;
    if (assetSummary) assetSummary.textContent = 'Syncing assets, please wait...';

    const result = await window.eveAPI.syncAllAssets();
    let total = 0;
    if (result && Array.isArray(result.characters)) {
      total = result.characters.reduce((sum, item) => sum + (item.count || 0), 0);
    }
    if (assetSummary) {
      assetSummary.textContent = `Imported ${total} assets for ${result.characters?.length || 0} characters.`;
    }
    await loadAssets();
  } finally {
    if (spinner) { spinner.classList.remove('spin'); spinner.style.display = 'none'; }
    if (btn)     btn.disabled = false;
  }
}

// Pre-fetch assets in the background at startup (non-blocking)
async function prefetchAssetsBackground() {
  try {
    const cached = await window.eveAPI.getAllAssets();
    if (cached?.length) allAssetsCache = cached;
  } catch (e) { /* ignore */ }
}

async function renderWallets() {
  const walletsGrid = document.getElementById('walletsGrid');
  if (!walletsGrid) return;
  if (walletsGrid._isLoading) return;
  walletsGrid._isLoading = true;

  try {
    walletsGrid.innerHTML = '';
    const accounts = await window.eveAPI.getAccounts();

    const cachedDash    = await window.eveAPI.cacheGet('dashboard_cache');
    const cachedWallets = cachedDash?.walletByChar || {};

    const cardData = await Promise.all(accounts.map(async (account) => {
      let rawBalance = cachedWallets[String(account.characterId)];
      if (rawBalance === undefined) rawBalance = await window.eveAPI.getWalletBalance(account.characterId);
      return { account, rawBalance: rawBalance || 0 };
    }));

    cardData.forEach(({ account, rawBalance }) => {
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
          <span class="wallet-meta">Synced</span>
          <button class="wallet-action">View Journal</button>
        </div>`;
      walletsGrid.appendChild(card);
      countUp(card.querySelector('.wallet-balance-number'), rawBalance);
    });
  } finally {
    walletsGrid._isLoading = false;
  }
}