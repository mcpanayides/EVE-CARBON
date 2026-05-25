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