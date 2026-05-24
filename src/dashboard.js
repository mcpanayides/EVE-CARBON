// ─── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  const summaryPanel   = document.getElementById('dashboardNetworthSummary');
  const jobsTable      = document.getElementById('dashboardJobsTable');
  const welcomeBanner  = document.getElementById('dashboardWelcomeBanner');
  const mainCharLabel  = document.getElementById('dashboardMainCharName');

  // Render from cache immediately if available
  try {
    const cachedData = await window.eveAPI.cacheGet('dashboard_cache');
    if (cachedData) {
      renderDashboardUI(cachedData, true);
      logToConsole('Rendered from cache.', 'info');
    }
  } catch (e) { /* ignore */ }

  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!accounts.length) {
    if (summaryPanel) summaryPanel.innerHTML = '<div class="dashboard-empty">Add a character to see your dashboard.</div>';
    if (jobsTable)    jobsTable.innerHTML    = '<div class="dashboard-empty">No characters added.</div>';
    return;
  }

  const mainAccount = accounts.find(a => String(a.characterId) === String(selectedCharacterId)) || accounts[0];
  if (mainCharLabel) mainCharLabel.textContent = mainAccount?.characterName || '';

  // ── Section 1: Welcome banner (async, non-blocking) ──────────────────────
  (async () => {
    // Public ESI proxy — routes through ipcMain for consistent UA/timeout.
    async function esiGet(url) {
      try {
        return await window.eveAPI.esiFetch(url);
      } catch (ipcErr) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`ESI ${r.status}: ${url}`);
        return r.json();
      }
    }

    try {
      if (!mainAccount) return;

      // ── Use authenticated character endpoint so we get home_location_id ──
      // The public /v5/characters/{id}/ endpoint omits home_location_id and
      // home_location_type. getCharacterInfo() calls the same URL with a token.
      let charInfo = null;
      try {
        charInfo = await window.eveAPI.getCharacterInfo(mainAccount.characterId);
      } catch (_) {}
      if (!charInfo) {
        charInfo = await esiGet(
          `https://esi.evetech.net/v5/characters/${mainAccount.characterId}/?datasource=tranquility`
        );
      }

      const corpId     = charInfo.corporation_id || null;
      const allianceId = charInfo.alliance_id    || null;
      const birthday   = charInfo.birthday
        ? new Date(charInfo.birthday).toISOString().slice(0, 10).replace(/-/g, '.')
        : '—';
      const secStatus = typeof charInfo.security_status === 'number'
        ? charInfo.security_status.toFixed(1) : '—';

      const [corpInfo, alliInfo] = await Promise.all([
        corpId     ? esiGet(`https://esi.evetech.net/v5/corporations/${corpId}/?datasource=tranquility`).catch(() => ({}))    : Promise.resolve({}),
        allianceId ? esiGet(`https://esi.evetech.net/v4/alliances/${allianceId}/?datasource=tranquility`).catch(() => ({})) : Promise.resolve({}),
      ]);
      const corpName     = corpInfo.name || '';
      const allianceName = alliInfo.name || '';

      // ── Home location ──────────────────────────────────────────────────────
      // Authenticated character sheet gives home_location_id directly.
      // Fall back to the clones endpoint (medical clone = home station).
      let homeId   = charInfo.home_location_id   || null;
      let homeType = charInfo.home_location_type || null;

      if (!homeId) {
        try {
          const clones = await window.eveAPI.getClones(mainAccount.characterId);
          if (clones && clones.home_location) {
            homeId   = clones.home_location.location_id   || null;
            homeType = clones.home_location.location_type || null;
          }
        } catch (_) {}
      }

      let homeStationName = '—', homeSystemSec = null;
      try {
        if (homeId && homeType === 'station') {
          const stationInfo = await esiGet(`https://esi.evetech.net/v2/universe/stations/${homeId}/?datasource=tranquility`);
          if (stationInfo.system_id) {
            const sysInfo = await esiGet(`https://esi.evetech.net/v4/universe/systems/${stationInfo.system_id}/?datasource=tranquility`);
            homeStationName = sysInfo.name || stationInfo.name || `ID ${homeId}`;
            homeSystemSec   = typeof sysInfo.security_status === 'number' ? sysInfo.security_status : null;
          } else {
            homeStationName = stationInfo.name || `ID ${homeId}`;
          }
        } else if (homeId && (homeType === 'structure' || Number(homeId) >= 1_000_000_000_000)) {
          // Route through locator: ESI auth -> ESI public -> adam4eve fallback
          try {
            const loc = await window.eveAPI.getStructureInfo(homeId, mainAccount.characterId);
            homeStationName = (loc && loc.name) ? loc.name : `Structure ${homeId}`;
            if (loc && loc.solar_system_id) {
              const sysInfo = await esiGet(`https://esi.evetech.net/v4/universe/systems/${loc.solar_system_id}/?datasource=tranquility`);
              homeSystemSec = typeof sysInfo.security_status === 'number' ? sysInfo.security_status : null;
            } else if (loc && loc.security_status != null) {
              homeSystemSec = loc.security_status;
            }
          } catch (_) { homeStationName = `Structure ${homeId}`; }
        } else if (homeId) {
          homeStationName = `Location ${homeId}`;
        }
      } catch (e) { console.warn('Home station fetch failed:', e.message); }

      // ── Security colour helpers ────────────────────────────────────────────
      const charSecColor = (s) => {
        const n = parseFloat(s);
        if (isNaN(n)) return 'var(--text-2)';
        if (n >= 5.0) return '#4ada8a';
        if (n >= 0.1) return '#f0a800';
        return '#e45c5c';
      };

      const systemSecMeta = (sec) => {
        if (sec === null) return { color: 'var(--text-2)', label: null, cls: '' };
        if (sec < 0.0)    return { color: 'var(--lawless)',  label: 'Lawless',  cls: 'sec-lawless'  };
        if (sec < 0.1)    return { color: 'var(--nullsec)',  label: 'Null Sec', cls: 'sec-nullsec'  };
        if (sec < 0.45)   return { color: 'var(--lowsec)',   label: 'Low Sec',  cls: 'sec-lowsec'   };
        if (sec >= 0.999) return { color: 'var(--newbie)',   label: 'Newbie',   cls: 'sec-newbie'   };
        return               { color: 'var(--hisec)',    label: 'High Sec', cls: 'sec-hisec'    };
      };

      const sysMeta = systemSecMeta(homeSystemSec);
      const homeSecValueDisplay = homeSystemSec !== null
        ? `<span style="color:${sysMeta.color};">${homeSystemSec.toFixed(1)}</span>` : '';
      const homeSecBreadcrumb = sysMeta.label
        ? `<span class="sec-breadcrumb ${sysMeta.cls}">${sysMeta.label}</span>` : '';

      if (!welcomeBanner) return;
      welcomeBanner.innerHTML = `
        <div class="dashboard-welcome-inner">
          <img class="dashboard-portrait"
               src="https://images.evetech.net/characters/${mainAccount.characterId}/portrait?size=128"
               alt="${escHtml(mainAccount.characterName)}"
               onerror="this.onerror=null;this.src='https://images.evetech.net/characters/${mainAccount.characterId}/portrait?size=64'"/>
          <div class="dashboard-welcome-text">
            <div class="dashboard-welcome-greeting">WELCOME BACK, COMMANDER</div>
            <div class="dashboard-welcome-name">${escHtml(mainAccount.characterName)}</div>
            <div class="dashboard-welcome-affil">
              ${corpId     ? `<img class="dashboard-org-logo" src="https://images.evetech.net/corporations/${corpId}/logo?size=64" title="${escHtml(corpName)}" onerror="this.style.display='none'"/>` : ''}
              ${allianceId ? `<img class="dashboard-org-logo" src="https://images.evetech.net/alliances/${allianceId}/logo?size=64" title="${escHtml(allianceName)}" onerror="this.style.display='none'"/>` : ''}
              ${corpName     ? `<span class="dashboard-org-name">${escHtml(corpName)}</span>` : ''}
              ${allianceName ? `<span class="dashboard-org-sep"> · </span><span class="dashboard-org-name">${escHtml(allianceName)}</span>` : ''}
            </div>
            <div class="dashboard-welcome-stats">
              <div class="dashboard-welcome-stat"><span class="dashboard-stat-label">Born</span><span class="dashboard-stat-value">${escHtml(birthday)}</span></div>
              <div class="dashboard-welcome-stat"><span class="dashboard-stat-label">Security Status</span><span class="dashboard-stat-value" style="color:${charSecColor(secStatus)};">${escHtml(String(secStatus))}</span></div>
              <div class="dashboard-welcome-stat dashboard-welcome-stat--home">
                <span class="dashboard-stat-label">Home Station</span>
                <span class="dashboard-stat-value dashboard-home-station-value">
                  <span class="dashboard-home-name">${escHtml(homeStationName)}</span>
                  ${homeSecValueDisplay}
                  ${homeSecBreadcrumb}
                </span>
              </div>
              <div class="dashboard-welcome-stat">
                <span class="dashboard-stat-label">Total Net Worth</span>
                <span class="dashboard-stat-value" id="welcomeNetWorthValue">
                  <span style="color:var(--text-3);font-size:11px;">Calculating…</span>
                </span>
              </div>
            </div>
          </div>
        </div>`;
    } catch (e) {
      if (welcomeBanner && mainAccount) {
        welcomeBanner.innerHTML = `<div class="dashboard-welcome-inner"><div class="dashboard-welcome-text">
          <div class="dashboard-welcome-greeting">WELCOME BACK, COMMANDER</div>
          <div class="dashboard-welcome-name">${escHtml(mainAccount.characterName)}</div>
        </div></div>`;
      }
    }
  })();

  // ── Section 2: Net worth calculation ────────────────────────────────────
  // Sources:
  //   • Liquid ISK     → /characters/{id}/wallet/
  //   • Asset value    → /characters/{id}/assets/ × /markets/prices/ (adjusted_price)
  //   • Market escrow  → /characters/{id}/orders/  (sum of buy-order escrow fields)
  //   • Contract escrow→ /characters/{id}/contracts/ (sum of price on outstanding buys)
  (async () => {
    // ── Step 1: Liquid ISK (fast) ────────────────────────────────────────────
    const walletByChar = {};
    await Promise.all(accounts.map(async acc => {
      try { walletByChar[String(acc.characterId)] = await window.eveAPI.getWalletBalance(acc.characterId) || 0; }
      catch (e) { walletByChar[String(acc.characterId)] = 0; }
    }));
    let totalWallet = 0;
    accounts.forEach(acc => { totalWallet += walletByChar[String(acc.characterId)] || 0; });

    // Show liquid ISK immediately while assets/escrow are still loading
    renderKPIPanel(summaryPanel, accounts, totalWallet, 0, totalWallet, {}, walletByChar, true);

    try {
      // ── Step 2: Asset value using /markets/prices/ (adjusted_price) ────────
      // This is the same price source EVE uses for net worth on the char sheet.
      // One call returns all items — no per-item Jita scraping needed.
      const [assets, marketPrices] = await Promise.all([
        window.eveAPI.getAllAssets().catch(() => []),
        window.eveAPI.getMarketPrices().catch(() => ({})),
      ]);

      const totalByChar = {};
      let overallValue  = 0;
      assets.forEach(asset => {
        const priceEntry = marketPrices[asset.type_id] || {};
        // Use adjusted_price first (EVE's internal valuation), fall back to average
        const unitPrice  = priceEntry.adjusted || priceEntry.average || 0;
        const value      = unitPrice * (asset.quantity || 0);
        overallValue    += value;
        const cid = String(asset.characterId || 'unknown');
        totalByChar[cid] = (totalByChar[cid] || 0) + value;
      });

      // ── Step 3: Market order escrow ─────────────────────────────────────────
      // Active buy orders lock ISK in escrow — it's part of net worth.
      const escrowByChar = {};
      let totalEscrow = 0;
      await Promise.all(accounts.map(async acc => {
        try {
          const orders = await window.eveAPI.getCharacterOrders(acc.characterId);
          let escrow = 0;
          if (Array.isArray(orders)) {
            orders.forEach(o => {
              // is_buy_order + escrow field = ISK held by market system
              if (o.is_buy_order && typeof o.escrow === 'number') escrow += o.escrow;
            });
          }
          escrowByChar[String(acc.characterId)] = escrow;
          totalEscrow += escrow;
        } catch (e) {
          escrowByChar[String(acc.characterId)] = 0;
        }
      }));

      // Add escrow into per-character totals (it's part of their net worth)
      accounts.forEach(acc => {
        const cid = String(acc.characterId);
        const e   = escrowByChar[cid] || 0;
        totalByChar[cid] = (totalByChar[cid] || 0) + e;
        overallValue     += e;
      });

      // ── Step 4: Contract escrow ──────────────────────────────────────────────
      // Outstanding buy contracts (wants_to_buy) also tie up ISK.
      let contractEscrow = 0;
      await Promise.all(accounts.map(async acc => {
        try {
          const contracts = await window.eveAPI.getCharacterContracts(acc.characterId);
          if (Array.isArray(contracts)) {
            contracts.forEach(c => {
              // 'outstanding' + 'item_exchange' or 'auction' where we are the issuer buying
              if (c.status === 'outstanding' && c.for_corporation === false) {
                // Buyer contracts: price is what we're offering to pay
                if ((c.type === 'item_exchange' || c.type === 'auction') && typeof c.price === 'number') {
                  contractEscrow += c.price;
                }
              }
            });
          }
        } catch (e) { /* contract endpoint may not be scoped yet */ }
      }));

      // ── Grand total ──────────────────────────────────────────────────────────
      const grandTotal = totalWallet + overallValue + contractEscrow;

      renderKPIPanel(summaryPanel, accounts, totalWallet, overallValue + contractEscrow, grandTotal, totalByChar, walletByChar, false);

      // Update welcome banner
      const welcomeNWEl = document.getElementById('welcomeNetWorthValue');
      if (welcomeNWEl) {
        welcomeNWEl.innerHTML = `<span style="color:var(--text-1);">${formatISK(grandTotal)}</span>`;
      }

      await window.eveAPI.cacheSet('dashboard_cache', {
        accounts, mainAccount, walletByChar, totalByChar,
        overallValue: overallValue + contractEscrow,
        totalWallet, grandTotal
      }, 1).catch(() => {});

    } catch (e) { console.warn('Net worth calculation failed:', e.message); }
  })();

  // ── Section 3: Jobs table (independent) ──────────────────────────────────
  (async () => {
    if (jobsTable) jobsTable.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3);font-family:var(--mono);font-size:11px;">Loading jobs...</div>`;
    try {
      const jobResponses = await Promise.all(accounts.map(acc => window.eveAPI.getCharacterJobs(acc.characterId).catch(() => [])));
      const jobs         = jobResponses.flat();
      const accountMap   = Object.fromEntries(accounts.map(acc => [String(acc.characterId), acc]));
      if (!jobsTable) return;
      if (!jobs.length) { jobsTable.innerHTML = '<div class="dashboard-empty">No industry jobs found.</div>'; return; }

      // ── Resolve item names via SDE / ESI names ──────────────────────────
      // Collect all product type IDs and blueprint type IDs that need names
      const typeIdsNeeded = [...new Set(
        jobs.flatMap(j => [j.product_type_id, j.blueprint_type_id].filter(Boolean))
      )];
      let typeNameMap = {};
      if (typeIdsNeeded.length) {
        try {
          typeNameMap = await window.eveAPI.getNames(typeIdsNeeded);
        } catch { /* leave empty, we'll fall back per-item */ }
      }

      // ── Resolve solar system names in bulk ───────────────────────────────
      // ESI job objects carry solar_system_id as an integer but never include
      // solar_system_name. We bulk-resolve all unique IDs in one POST call.
      const systemIdsNeeded = [...new Set(jobs.map(j => j.solar_system_id).filter(Boolean))];
      let systemNameMap = {};
      if (systemIdsNeeded.length) {
        try {
          // getNames routes through main.js → esiNamesPost which covers system IDs
          systemNameMap = await window.eveAPI.getNames(systemIdsNeeded);
        } catch { /* fall back to per-job structure lookup below */ }
      }

      // ── Resolve facility names for structures not already covered ────────
      // Only fetch facility names for jobs where the system name is still missing
      // (e.g. the facility is a player structure whose system we don't know yet).
      const structureIdsNeeded = [...new Set(
        jobs
          .filter(j => !systemNameMap[j.solar_system_id] && j.facility_id >= 1_000_000_000_000)
          .map(j => j.facility_id)
      )];
      const facilityInfoMap = {};
      await Promise.all(
        structureIdsNeeded.map(async sid => {
          // Find a character that ran a job in this facility — use their token
          const job   = jobs.find(j => j.facility_id === sid);
          const charId = job?.character_id || mainAccount?.characterId;
          try {
            facilityInfoMap[sid] = await window.eveAPI.getStructureInfo(sid, charId);
          } catch { facilityInfoMap[sid] = null; }
        })
      );

      // ── Render table ─────────────────────────────────────────────────────
      const sorted = jobs.sort((a, b) =>
        new Date(b.end_date || b.completed_date || 0) - new Date(a.end_date || a.completed_date || 0)
      );

      const rows = sorted.map(job => {
        const charName = accountMap[String(job.character_id)]?.characterName || `Char ${job.character_id}`;

        // Item name: prefer product_type_id name, fall back to blueprint name, then type ID
        const itemName = (job.product_type_id && typeNameMap[job.product_type_id])
          || (job.blueprint_type_id && typeNameMap[job.blueprint_type_id])
          || (job.product_type_id ? `Type ${job.product_type_id}` : 'Unknown');

        // System name: bulk-resolved, or fall back via facility info, or raw ID
        let systemName = (job.solar_system_id && systemNameMap[job.solar_system_id]) || null;
        if (!systemName && job.facility_id && facilityInfoMap[job.facility_id]) {
          const fi = facilityInfoMap[job.facility_id];
          systemName = fi.solar_system_name || fi.name || null;
        }
        if (!systemName) systemName = job.solar_system_id ? `System ${job.solar_system_id}` : 'Unknown';

        const finished = job.end_date || job.completed_date || null;
        const finishedStr = finished ? new Date(finished).toLocaleString() : '—';

        return `<tr>
          <td>${escHtml(charName)}</td>
          <td>${escHtml(itemName)}</td>
          <td>${escHtml(systemName)}</td>
          <td>${escHtml(finishedStr)}</td>
        </tr>`;
      }).join('');

      jobsTable.innerHTML = `
        <div class="dashboard-jobs-summary">${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${new Set(jobs.map(j => String(j.character_id))).size} character(s)</div>
        <div class="dashboard-jobs-scroll">
          <table class="dashboard-jobs-list">
            <thead><tr><th>Character</th><th>Item</th><th>System</th><th>Completed</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    } catch (e) {
      console.error('[dashboard] Jobs table failed:', e);
      if (jobsTable) jobsTable.innerHTML = '<div class="dashboard-empty">Failed to load jobs.</div>';
    }
  })();
}

// ─── KPI Panel Renderer ───────────────────────────────────────────────────────

function renderKPIPanel(container, accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, assetsLoading) {
  if (!container) return;

  const TOP_N = 6;
  const allCharData = accounts.map(acc => {
    const cid    = String(acc.characterId);
    const assets = totalByChar[cid]  || 0;
    const wallet = walletByChar[cid] || 0;
    return { acc, assets, wallet, total: assets + wallet };
  }).sort((a, b) => b.total - a.total);

  const charData    = allCharData.slice(0, TOP_N);
  const hiddenCount = allCharData.length - charData.length;
  const maxTotal    = Math.max(...charData.map(c => c.total), 1);

  const charBars = charData.map(({ acc, assets, wallet, total }) => {
    const assetPct  = Math.min(100, (assets / maxTotal) * 100);
    const walletPct = Math.min(100, (wallet / maxTotal) * 100);
    return `
      <div class="dash-char-bar-row">
        <img class="dash-char-bar-portrait"
             src="https://images.evetech.net/characters/${acc.characterId}/portrait?size=32"
             alt="${escHtml(acc.characterName)}" onerror="this.style.display='none'"/>
        <div class="dash-char-bar-info">
          <div class="dash-char-bar-label">${escHtml(acc.characterName)}</div>
          <div class="dash-char-bar-track">
            <div class="dash-char-bar-fill assets" style="width:${assetPct.toFixed(1)}%"></div>
            <div class="dash-char-bar-fill wallet" style="width:${walletPct.toFixed(1)}%"></div>
          </div>
        </div>
        <div class="dash-char-bar-value">${formatISK(total)}</div>
      </div>`;
  }).join('');

  const getCSSVar       = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const CHAR_COLORS     = ['--accent','--assets','--liquidisk','--warning','--danger','--tier-0'].map(getCSSVar);
  const CHAR_DASHES     = [[], [6,3], [3,3], [8,4], [4,4], [2,4]];
  const growthFactors   = [0.41,0.48,0.54,0.59,0.63,0.68,0.74,0.80,0.87,0.92,0.96,1.0];

  const charDatasets = charData.map(({ acc, total }, i) => ({
    label: acc.characterName,
    data: growthFactors.map(f => Math.round(total * f)),
    borderColor: CHAR_COLORS[i % CHAR_COLORS.length],
    borderWidth: 2,
    borderDash: CHAR_DASHES[i % CHAR_DASHES.length],
    pointBackgroundColor: CHAR_COLORS[i % CHAR_COLORS.length],
    pointRadius: (ctx) => ctx.dataIndex % 2 === 0 ? 3 : 0,
    pointHoverRadius: 5, fill: false, tension: 0.3,
  }));

  if (charData.length > 1) {
    charDatasets.push({
      label: 'Total',
      data: growthFactors.map(f => Math.round(grandTotal * f)),
      borderColor: '#ffffff', borderWidth: 1.5, borderDash: [4,4],
      pointBackgroundColor: '#ffffff',
      pointRadius: (ctx) => ctx.dataIndex % 2 === 0 ? 3 : 0,
      pointHoverRadius: 5, fill: false, tension: 0.3,
    });
  }

  const now         = Date.now();
  const monthLabels = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now); d.setMonth(d.getMonth() - (11 - i));
    return d.toLocaleString('default', { month: 'short' });
  });

  const legendItems = charDatasets.map(ds => `
    <span style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text-2);font-family:var(--mono);">
      <span style="width:8px;height:8px;border-radius:50%;background:${ds.borderColor};flex-shrink:0;"></span>
      ${escHtml(ds.label)}
    </span>`).join('');

  const barLegend = `
    <div style="display:flex;gap:14px;margin-bottom:8px;">
      <span style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text-2);font-family:var(--mono);">
        <span style="width:8px;height:8px;border-radius:2px;background:var(--assets);flex-shrink:0;"></span>Assets
      </span>
      <span style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text-2);font-family:var(--mono);">
        <span style="width:8px;height:8px;border-radius:2px;background:var(--liquidisk);flex-shrink:0;"></span>Liquid ISK
      </span>
    </div>`;

  container.innerHTML = `
    <div class="dash-wealth-header">
      <div class="dash-wealth-kpi"><div class="dash-kpi-label">TOTAL NET WORTH</div><div class="dash-kpi-value">${formatISK(grandTotal)}</div><div class="dash-kpi-sub">Assets + Liquid ISK</div></div>
      <div class="dash-wealth-kpi"><div class="dash-kpi-label">LIQUID ISK</div><div class="dash-kpi-value accent-green">${formatISK(totalWallet)}</div><div class="dash-kpi-sub">Wallet balance</div></div>
      <div class="dash-wealth-kpi"><div class="dash-kpi-label">ASSET VALUE</div>
        <div class="dash-kpi-value accent-purple">${assetsLoading ? '<span style="font-size:13px;color:var(--text-3);font-family:var(--mono);">Calculating...</span>' : formatISK(overallValue)}</div>
        <div class="dash-kpi-sub">Jita sell estimate</div>
      </div>
    </div>
    <div class="dash-char-bars" style="margin-bottom:20px;">
      <div class="dash-char-bars-label" style="display:flex;align-items:baseline;gap:8px;">
        WEALTH BY CHARACTER
        <span style="font-size:9px;color:var(--text-3);font-family:var(--mono);font-weight:400;letter-spacing:0.05em;">
          TOP ${TOP_N}${hiddenCount > 0 ? ` · ${hiddenCount} more character${hiddenCount === 1 ? '' : 's'} not shown` : ''}
        </span>
      </div>
      ${barLegend}${charBars}
    </div>
    <div class="dash-wealth-chart-wrap">
      <div class="dash-wealth-chart-label">COMPOUNDED WEALTH GROWTH · 12 MONTHS</div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px;">${legendItems}</div>
      ${assetsLoading
        ? `<div style="height:160px;display:flex;align-items:center;justify-content:center;
                       color:var(--text-3);font-family:var(--mono);font-size:11px;
                       border:1px dashed var(--border);border-radius:var(--radius);">
             Waiting for asset prices...
           </div>`
        : `<div style="position:relative;width:100%;height:160px;">
             <canvas id="wealthGrowthChart" role="img" aria-label="Compounded wealth growth over 12 months per character">Wealth growth chart</canvas>
           </div>`}
    </div>`;

  if (!assetsLoading) {
    requestAnimationFrame(() => {
      const canvas = document.getElementById('wealthGrowthChart');
      if (!canvas) return;
      if (canvas._chartInstance) canvas._chartInstance.destroy();
      canvas._chartInstance = new Chart(canvas, {
        type: 'line',
        data: { labels: monthLabels, datasets: charDatasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => { const v = ctx.raw; if (v >= 1e12) return ` ${(v/1e12).toFixed(2)} T ISK`; if (v >= 1e9) return ` ${(v/1e9).toFixed(2)} B ISK`; if (v >= 1e6) return ` ${(v/1e6).toFixed(2)} M ISK`; return ` ${v.toLocaleString()} ISK`; } } }
          },
          scales: {
            x: { ticks: { color:'#6a6a6a', font:{size:9,family:'monospace'}, autoSkip:false, maxRotation:0 }, grid:{ color:'rgba(255,255,255,0.04)' } },
            y: { ticks: { color:'#6a6a6a', font:{size:9,family:'monospace'}, callback: v => v >= 1e12 ? (v/1e12).toFixed(0)+'T' : v >= 1e9 ? (v/1e9).toFixed(0)+'B' : v >= 1e6 ? (v/1e6).toFixed(0)+'M' : v }, grid:{ color:'rgba(255,255,255,0.04)' } }
          }
        }
      });
    });
  }
}

// ─── Cached dashboard render ──────────────────────────────────────────────────

function renderDashboardUI(data, isCached = false) {
  const { accounts, mainAccount, overallValue, totalWallet, grandTotal, totalByChar, walletByChar } = data;
  const summaryPanel  = document.getElementById('dashboardNetworthSummary');
  const mainCharLabel = document.getElementById('dashboardMainCharName');
  if (!summaryPanel) return;

  if (mainCharLabel) {
    mainCharLabel.innerHTML = mainAccount
      ? `${escHtml(mainAccount.characterName)} ${isCached ? '<span style="color:var(--warning);font-size:9px;margin-left:8px;">[SYNCING FROM ESI...]</span>' : ''}`
      : 'No main character selected';
  }
  renderKPIPanel(summaryPanel, accounts || [], totalWallet || 0, overallValue || 0, grandTotal || 0, totalByChar || {}, walletByChar || {}, false);
}

function setupDashboardWidgetDrag() {
  const widget = document.getElementById('dashboardNetworthSummary');
  if (!widget) return;
  const parent = widget.closest('.dashboard-panel');
  if (!parent) return;
  const header = parent.querySelector('.dashboard-panel-title');
  if (!header) return;

  let isDragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
  header.style.cursor = 'grab';

  header.onmousedown = (event) => {
    isDragging = true;
    startX = event.clientX; startY = event.clientY;
    const rect = parent.getBoundingClientRect();
    origLeft = rect.left; origTop = rect.top;
    parent.style.position = 'absolute'; parent.style.zIndex = '2';
    header.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  function onMouseMove(event) {
    if (!isDragging) return;
    parent.style.left = `${Math.max(0, origLeft + event.clientX - startX)}px`;
    parent.style.top  = `${Math.max(0, origTop  + event.clientY - startY)}px`;
  }
  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false; header.style.cursor = 'grab';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}