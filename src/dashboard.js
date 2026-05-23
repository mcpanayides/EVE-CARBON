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
    // Route public ESI calls through ipcMain so they share the same User-Agent,
    // timeout, and error-handling as the rest of the app.
    // Falls back to renderer fetch() if the IPC channel isn't wired yet.
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
      const charInfo = await esiGet(
        `https://esi.evetech.net/v5/characters/${mainAccount.characterId}/?datasource=tranquility`
      );

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

      let homeStationName = '—', homeSystemSec = null;
      try {
        const homeId   = charInfo.home_location_id;
        const homeType = charInfo.home_location_type;
        if (homeId && homeType === 'station') {
          const stationInfo = await esiGet(`https://esi.evetech.net/v2/universe/stations/${homeId}/?datasource=tranquility`);
          if (stationInfo.system_id) {
            const sysInfo = await esiGet(`https://esi.evetech.net/v4/universe/systems/${stationInfo.system_id}/?datasource=tranquility`);
            homeStationName = sysInfo.name || stationInfo.name || `ID ${homeId}`;
            homeSystemSec   = typeof sysInfo.security_status === 'number' ? sysInfo.security_status : null;
          } else {
            homeStationName = stationInfo.name || `ID ${homeId}`;
          }
        } else if (homeId) {
          homeStationName = `Structure ${homeId}`;
        }
      } catch (e) { console.warn('Home station fetch failed:', e.message); }

      const systemSecColor = (sec) => sec === null ? 'var(--text-2)' : sec >= 0.5 ? '#4ada8a' : sec >= 0.1 ? '#f0a800' : '#e45c5c';
      const charSecColor   = (s)   => { const n = parseFloat(s); return isNaN(n) ? 'var(--text-2)' : n >= 5.0 ? '#4ada8a' : n >= 0.1 ? '#f0a800' : '#e45c5c'; };
      const homeSecDisplay = homeSystemSec !== null
        ? ` <span style="color:${systemSecColor(homeSystemSec)};">${homeSystemSec.toFixed(1)}</span>` : '';

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
              <div class="dashboard-welcome-stat"><span class="dashboard-stat-label">Home Station</span><span class="dashboard-stat-value">${escHtml(homeStationName)}${homeSecDisplay}</span></div>
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

  // ── Section 2: KPI cards (wallets first, then asset prices) ──────────────
  (async () => {
    const walletByChar = {};
    await Promise.all(accounts.map(async acc => {
      try { walletByChar[String(acc.characterId)] = await window.eveAPI.getWalletBalance(acc.characterId) || 0; }
      catch (e) { walletByChar[String(acc.characterId)] = 0; }
    }));

    let totalWallet = 0;
    accounts.forEach(acc => { totalWallet += walletByChar[String(acc.characterId)] || 0; });

    renderKPIPanel(summaryPanel, accounts, totalWallet, 0, totalWallet, {}, walletByChar, true);

    try {
      const assets  = await window.eveAPI.getAllAssets().catch(() => []);
      const typeIds = [...new Set(assets.map(a => a.type_id).filter(Boolean))];
      let prices = {};
      if (typeIds.length) prices = await window.eveAPI.getJitaPrices(typeIds).catch(() => ({}));

      const totalByChar = {};
      let overallValue  = 0;
      assets.forEach(asset => {
        const pe        = prices[asset.type_id] || {};
        const unitPrice = pe.sell > 0 ? pe.sell : (pe.buy > 0 ? pe.buy : 0);
        const value     = unitPrice * (asset.quantity || 0);
        overallValue   += value;
        const cid = String(asset.characterId || 'unknown');
        totalByChar[cid] = (totalByChar[cid] || 0) + value;
      });

      const grandTotal = overallValue + totalWallet;
      renderKPIPanel(summaryPanel, accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, false);

      const existing = await window.eveAPI.cacheGet('dashboard_cache').catch(() => null) || {};
      await window.eveAPI.cacheSet('dashboard_cache', {
        ...existing, accounts, mainAccount, walletByChar, totalByChar, overallValue, totalWallet, grandTotal
      }, 7);
    } catch (e) { console.warn('Asset value fetch failed:', e.message); }
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

      jobsTable.innerHTML = `
        <div class="dashboard-jobs-summary">${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${new Set(jobs.map(j => String(j.character_id))).size} character(s)</div>
        <div class="dashboard-jobs-scroll">
          <table class="dashboard-jobs-list">
            <thead><tr><th>Character</th><th>Item</th><th>System</th><th>Completed</th></tr></thead>
            <tbody>
              ${jobs.sort((a, b) => new Date(b.end_date || b.completed_date || 0) - new Date(a.end_date || a.completed_date || 0))
                .map(job => {
                  const charName   = accountMap[String(job.character_id)]?.characterName || `Char ${job.character_id}`;
                  const itemName   = job.product_type_id ? `Type ${job.product_type_id}` : 'Unknown';
                  const systemName = job.solar_system_name || 'Unknown';
                  const finished   = job.end_date || job.completed_date || 'Unknown';
                  return `<tr><td>${escHtml(charName)}</td><td>${escHtml(itemName)}</td><td>${escHtml(systemName)}</td><td>${escHtml(new Date(finished).toLocaleString())}</td></tr>`;
                }).join('')}
            </tbody>
          </table>
        </div>`;
    } catch (e) {
      if (jobsTable) jobsTable.innerHTML = '<div class="dashboard-empty">Failed to load jobs.</div>';
    }
  })();
}

// ─── KPI Panel Renderer ───────────────────────────────────────────────────────

function renderKPIPanel(container, accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, assetsLoading) {
  if (!container) return;

  const charData = accounts.map(acc => {
    const cid    = String(acc.characterId);
    const assets = totalByChar[cid]  || 0;
    const wallet = walletByChar[cid] || 0;
    return { acc, assets, wallet, total: assets + wallet };
  });
  const maxTotal = Math.max(...charData.map(c => c.total), 1);

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
      <div class="dash-char-bars-label">WEALTH BY CHARACTER</div>
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