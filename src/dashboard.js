// ─── Dashboard ────────────────────────────────────────────────────────────────
// ── Background auto-refresh: silently sync stale characters ──────────────────
// Called once per dashboard load. Checks every character's last synced_at from
// character_information.db. If data is older than STALE_MS and no manual sync
// is already running, queues them one-at-a-time to avoid hammering ESI.

const STALE_MS = 30 * 60 * 1000; // 30 minutes

let _dashboardLoading   = false;
let _autoRefreshRunning = false;

// Shared set so characters.js can check which IDs are currently auto-syncing
// and immediately reflect state on cards that are already rendered.
const _autoSyncingIds = new Set();

function _fireAutoSync(characterId, phase, success) {
  // phase: 'start' | 'done' | 'error'
  document.dispatchEvent(new CustomEvent('auto-sync', {
    detail: { characterId: String(characterId), phase, success }
  }));
}

async function autoRefreshStaleCharacters(accounts) {
  if (_autoRefreshRunning) return;   // only one pass at a time
  _autoRefreshRunning = true;

  try {
    const now = Date.now();
    const stale = [];

    for (const acc of accounts) {
      try {
        const dbData = await window.eveAPI.getCharacterData(acc.characterId);
        const syncedAt = dbData?.info?.synced_at || 0;
        if ((now - syncedAt) > STALE_MS) stale.push(acc);
      } catch (e) {
        stale.push(acc); // no DB row = definitely stale
      }
    }

    if (!stale.length) {
      logToConsole('All character data is fresh (< 30 min old).', 'info');
      return;
    }

    logToConsole(`Auto-refresh: ${stale.length} character(s) have stale data — queuing background sync…`, 'info');

    for (const acc of stale) {
      // Abort if a manual sync was kicked off while we were running
      const manualRunning = document.querySelector('.character-sync-btn[disabled]');
      if (manualRunning) {
        logToConsole('Auto-refresh paused — manual sync in progress.', 'info');
        break;
      }

      const id = String(acc.characterId);
      _autoSyncingIds.add(id);
      _fireAutoSync(id, 'start');

      try {
        logToConsole(`Auto-refresh: syncing ${acc.characterName}…`, 'info');
        await window.eveAPI.syncCharacterFull(acc.characterId);
        logToConsole(`Auto-refresh: ✓ ${acc.characterName} complete.`, 'success');
        _fireAutoSync(id, 'done', true);
      } catch (e) {
        logToConsole(`Auto-refresh: ✗ ${acc.characterName} failed — ${e.message}`, 'error');
        _fireAutoSync(id, 'error', false);
      } finally {
        _autoSyncingIds.delete(id);
      }
    }

    // Reload dashboard data after background refreshes are done
    logToConsole('Auto-refresh complete.', 'success');

  } finally {
    _autoRefreshRunning = false;
  }
}

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

  // ── Kick off silent background auto-refresh (non-blocking) ───────────────
  autoRefreshStaleCharacters(accounts).catch(() => {});

  // ── Section 1: Welcome banner — DB only, no ESI calls ───────────────────
  // All data is read from character_information.db which is kept up-to-date
  // by autoRefreshStaleCharacters(). The banner never hits ESI directly.
  (async () => {

    // ── Static bloodline lookup (EVE data never changes) ─────────────────
    const BLOODLINE_NAMES = {
      1:'Deteis', 2:'Civire', 3:'Achura', 4:'Gallente', 5:'Intaki', 6:'Jin-Mei',
      7:'Amarr', 8:'Ni-Kunni', 9:'Khanid', 11:'Vherokior', 12:'Brutor', 13:'Sebiestor',
      14:'Minmatar', 15:'Nefantar', 16:'Starkmanir', 17:'Thukker',
    };

    // ── Helper: render the banner from DB data ────────────────────────────
    // implants: array of DB rows { implant_id, type_name, slot }
    function renderBanner({ charId, charName, birthday, gender, secStatus, corpId, corpName,
                             allianceId, allianceName, homeStationName, homeSystemSec,
                             bloodlineName = null, implants = [], currentShipTypeId = null,
                             currentShipTypeName = null,
                             stale = false }) {
      if (!welcomeBanner) return;

      const charSecColor = (s) => {
        const n = parseFloat(s);
        if (isNaN(n)) return 'var(--text-2)';
        if (n >= 5.0) return '#4ada8a';
        if (n >= 0.1) return '#0b7edb';
        if (n == 0.0) return '#5f5f5f';
        if (n <= 0.0) return '#db0b0b';
        return '#e45c5c';
      };


      const systemSecMeta = (sec) => {
        if (sec === null || sec === undefined) return { color: 'var(--text-2)', label: null, cls: '' };
        if (sec < 0.0)    return { color: 'var(--lawless)',  label: 'Lawless',  cls: 'sec-lawless'  };
        if (sec < 0.1)    return { color: 'var(--nullsec)',  label: 'Null Sec', cls: 'sec-nullsec'  };
        if (sec < 0.45)   return { color: 'var(--lowsec)',   label: 'Low Sec',  cls: 'sec-lowsec'   };
        if (sec >= 0.999) return { color: 'var(--newbie)',   label: 'Newbie',   cls: 'sec-newbie'   };
        return               { color: 'var(--hisec)',    label: 'High Sec', cls: 'sec-hisec'    };
      };

      // ── New Gender Helper ──────────────────────────────────────────────
     const genderMeta = (g) => {
      if (!g) return null;
      const gLower = String(g).toLowerCase();
      // Using 'color' for both text and border
      if (gLower === 'male')   return { color: '#67ace4', label: 'Male' };
      if (gLower === 'female') return { color: '#e47baf', label: 'Female' };
      return { color: 'var(--text-3)', label: g };
    };

    const gMeta = genderMeta(gender);
    const genderBreadcrumb = gMeta 
      ? `<span class="sec-breadcrumb" style="border: 1px solid ${gMeta.color}; color: ${gMeta.color}; background-color: transparent; padding: 2px 6px; border-radius: 4px;">${escHtml(gMeta.label)}</span>` 
      : '<span style="color:var(--text-2);">—</span>';

      const sysMeta = systemSecMeta(homeSystemSec);
      const homeSecValueDisplay = homeSystemSec != null
        ? `<span style="color:${sysMeta.color};">${Number(homeSystemSec).toFixed(1)}</span>` : '';
      const homeSecBreadcrumb = sysMeta.label
        ? `<span class="sec-breadcrumb ${sysMeta.cls}">${sysMeta.label}</span>` : '';
      const staleNote = stale
        ? `<span style="color:var(--text-3);font-size:9px;font-family:var(--mono);margin-left:6px;">● LIVE</span>` : '';

      // ── Implant icons HTML ───────────────────────────────────────────────
      // implants: { implant_id, type_name } — icons from Fuzzworks with evetech fallback
      const implantIconsHtml = implants.length
        ? implants
            .sort((a, b) => (a.implant_id || 0) - (b.implant_id || 0))
            .map(row => {
              const id    = row.implant_id;
              const label = escHtml(row.type_name || `Implant ${id}`);
              const fuzz  = `https://www.fuzzwork.co.uk/icons/items/${id}_32.png`;
              const eve   = `https://images.evetech.net/types/${id}/icon?size=32`;
              return `<img class="banner-implant-icon"
                 src="${fuzz}"
                 alt="${label}"
                 title="${label}"
                 onerror="if(this._f){this.style.display='none';}else{this._f=1;this.src='${eve}';}"/>`;
            }).join('')
        : `<span class="banner-implant-empty">No implants</span>`;

      // ── Ship column HTML ─────────────────────────────────────────────────
      const shipColHtml = currentShipTypeId ? `
        <div class="banner-ship-col">
          <img class="banner-ship-icon"
               src="https://images.evetech.net/types/${currentShipTypeId}/render?size=256"
               alt="${escHtml(currentShipTypeName || 'Current Ship')}"
               title="${escHtml(currentShipTypeName || 'Current Ship')}"
               onerror="this.onerror=null;this.src='https://images.evetech.net/types/${currentShipTypeId}/icon?size=64'"/>
          <div class="banner-ship-name">${escHtml(currentShipTypeName || 'Unknown Ship')}</div>
        </div>`
        : `<div class="banner-ship-col banner-ship-col--empty">
             <div class="banner-ship-placeholder">
               <span class="banner-ship-placeholder-icon">◈</span>
               <span class="banner-ship-placeholder-label">No Ship Data</span>
             </div>
           </div>`;

      welcomeBanner.innerHTML = `
        <div class="banner-portrait-col">
          <img class="dashboard-portrait"
               src="https://images.evetech.net/characters/${charId}/portrait?size=256"
               alt="${escHtml(charName)}"
               onerror="this.onerror=null;this.src='https://images.evetech.net/characters/${charId}/portrait?size=128'"/>
        </div>
        <div class="banner-main-col">
          <div class="banner-identity-col">
            <div class="dashboard-welcome-greeting">WELCOME BACK, COMMANDER</div>
            <div class="dashboard-welcome-name">${escHtml(charName)}${staleNote}</div>
            <div class="banner-org-logos">
              ${corpId     ? `<img class="banner-org-logo" src="https://images.evetech.net/corporations/${corpId}/logo?size=128" alt="${escHtml(corpName || '')}" onerror="this.style.display='none'"/>` : ''}
              ${allianceId ? `<img class="banner-org-logo" src="https://images.evetech.net/alliances/${allianceId}/logo?size=128" alt="${escHtml(allianceName || '')}" onerror="this.style.display='none'"/>` : ''}
            </div>
            <div class="banner-org-names">
              ${corpName     ? `<span class="banner-org-name-text">${escHtml(corpName)}</span>` : ''}
              ${allianceName ? `<span class="banner-org-sep">//</span><span class="banner-org-name-text">${escHtml(allianceName)}</span>` : ''}
            </div>
          </div>
          <div class="banner-stats-outer">
            <div class="banner-stats-col">
              <div class="banner-stat-row"><span class="banner-stat-label">Born</span><span class="banner-stat-value">${escHtml(birthday || '—')}</span></div>
              <div class="banner-stat-row"><span class="banner-stat-label">Sec Status</span><span class="banner-stat-value" style="color:${charSecColor(secStatus)};">${escHtml(String(secStatus ?? '—'))}</span></div>
              <div class="banner-stat-row">
                <span class="banner-stat-label">Home</span>
                <span class="banner-stat-value banner-home-value">
                  <span>${escHtml(homeStationName || '—')}</span>
                  ${homeSecValueDisplay}
                  ${homeSecBreadcrumb}
                </span>
              </div>
              <div class="banner-stat-row"><span class="banner-stat-label">Gender</span><span class="banner-stat-value">${genderBreadcrumb}</span></div>
              <div class="banner-stat-row"><span class="banner-stat-label">Net Worth</span><span class="banner-stat-value" id="welcomeNetWorthValue"><span style="color:var(--text-3);font-size:11px;">Calculating…</span></span></div>
            </div>
          </div>
          <div class="banner-extra-col">
            <div class="banner-extra-section">
              <div class="banner-extra-label">Bloodline</div>
              <div class="banner-extra-value" id="bannerBloodlineName">${escHtml(bloodlineName || '—')}</div>
            </div>
            <div class="banner-extra-section banner-implants-section">
              <div class="banner-extra-label">Active Implants</div>
              <div class="banner-implant-icons" id="bannerImplantIcons">${implantIconsHtml}</div>
            </div>
          </div>
        </div>
        ${shipColHtml}`;
    }

    try {
      if (!mainAccount) return;

      // ── DB READ: single call, all tables ────────────────────────────────
      const dbData = await window.eveAPI.getCharacterData(mainAccount.characterId);
      if (!dbData?.info) {
        // No DB row yet — character hasn't been synced. Show minimal banner.
        if (welcomeBanner) {
          welcomeBanner.innerHTML = `
            <div class="banner-portrait-col">
              <img class="dashboard-portrait"
                   src="https://images.evetech.net/characters/${mainAccount.characterId}/portrait?size=256"
                   alt="${escHtml(mainAccount.characterName)}"
                   onerror="this.onerror=null;this.src='https://images.evetech.net/characters/${mainAccount.characterId}/portrait?size=128'"/>
            </div>
            <div class="banner-main-col">
              <div class="banner-identity-col">
                <div class="dashboard-welcome-greeting">WELCOME BACK, COMMANDER</div>
                <div class="dashboard-welcome-name">${escHtml(mainAccount.characterName)}</div>
                <div style="color:var(--text-3);font-size:10px;font-family:var(--mono);margin-top:8px;">Sync character data to populate stats.</div>
              </div>
            </div>`;
        }
        return;
      }

      const info = dbData.info;
      const loc  = dbData.location;   // most-recent location row (char_{id}_location)
      const ship = dbData.ship;       // most-recent ship row (char_{id}_ship)

      // ── Birthday ──────────────────────────────────────────────────────────
      const birthday = info.birthday
        ? new Date(info.birthday).toISOString().slice(0, 10).replace(/-/g, '.')
        : '—';

      // ── Security status ───────────────────────────────────────────────────
      const secStatus = typeof info.security_status === 'number'
        ? info.security_status.toFixed(1) : '—';

      // ── Home location — from location table (station_name preferred) ──────
      const homeStationName = loc?.station_name || loc?.solar_system_name || '—';
      // Security for colour-coding: stored as security_status in assets table;
      // location table doesn't store sec — leave null (no breadcrumb, just name)
      const homeSystemSec = null;

      // ── Corp / Alliance names — resolve from cached names IPC ────────────
      let corpName = '', allianceName = '';
      try {
        const ids   = [info.corporation_id, info.alliance_id].filter(Boolean);
        const names = ids.length ? await window.eveAPI.getNames(ids) : {};
        corpName     = names[info.corporation_id]  || '';
        allianceName = names[info.alliance_id]     || '';
      } catch (_) {}

      // ── Bloodline — static lookup, no network call ────────────────────────
      const bloodlineName = info.bloodline_id
        ? (BLOODLINE_NAMES[info.bloodline_id] || `ID ${info.bloodline_id}`)
        : null;

      // ── Implants — normalise all possible DB key/shape variants ────────────
      // getCharacterData may return implants under several key names depending
      // on the DB table naming convention used in the main process.
      // We try each in priority order and normalise every row to { implant_id, type_name }.
      let implants = [];
      const _rawImplants =
        dbData.implants          ||   // expected key
        dbData.implantsList      ||   // alt key
        dbData.character_implants||   // alt key
        info.implants            ||   // sometimes nested under info
        null;

      if (Array.isArray(_rawImplants) && _rawImplants.length > 0) {
        implants = _rawImplants.map(row => ({
          // handle both { implant_id } and { type_id } column names
          implant_id: row.implant_id || row.type_id || row.id || row.implantId,
          type_name:  row.type_name  || row.name    || row.typeName || null,
        })).filter(r => r.implant_id);
        logToConsole(`Implants from DB: ${implants.length} found`, 'info');
      } else {
        // DB key not found or empty — try a direct IPC call for implants
        logToConsole('Implants not in getCharacterData — trying getCharacterImplants…', 'info');
        try {
          const raw = await window.eveAPI.getCharacterImplants(mainAccount.characterId).catch(() => null);
          if (Array.isArray(raw) && raw.length > 0) {
            implants = raw.map(row => ({
              implant_id: row.implant_id || row.type_id || row.id || (typeof row === 'number' ? row : null),
              type_name:  row.type_name  || row.name    || null,
            })).filter(r => r.implant_id);
            logToConsole(`Implants from IPC: ${implants.length} found`, 'info');
          } else {
            logToConsole('No implants returned from IPC either — character may have none or needs sync.', 'info');
          }
        } catch (implantErr) {
          logToConsole(`Implant IPC call failed: ${implantErr.message}`, 'error');
        }
      }

      // ── Current ship — from char_{id}_ship (most recent row) ─────────────
      const currentShipTypeId   = ship?.ship_type_id   || null;
      const currentShipTypeName = ship?.ship_type_name || null;

      renderBanner({
        charId:    mainAccount.characterId,
        charName:  mainAccount.characterName,
        birthday,  secStatus,
        gender:    info.gender,
        corpId:    info.corporation_id,    corpName,
        allianceId: info.alliance_id,      allianceName,
        homeStationName, homeSystemSec,
        bloodlineName,
        implants,
        currentShipTypeId, currentShipTypeName,
        stale: false,
      });

      logToConsole('Welcome banner loaded from local DB.', 'info');

    } catch (e) {
      console.warn('[dashboard] Banner render failed:', e.message);
      if (welcomeBanner && mainAccount) {
        welcomeBanner.innerHTML = `
          <div class="banner-portrait-col">
            <img class="dashboard-portrait"
                 src="https://images.evetech.net/characters/${mainAccount.characterId}/portrait?size=256"
                 alt="${escHtml(mainAccount.characterName)}"
                 onerror="this.style.display='none'"/>
          </div>
          <div class="banner-main-col">
            <div class="banner-identity-col">
              <div class="dashboard-welcome-greeting">WELCOME BACK, COMMANDER</div>
              <div class="dashboard-welcome-name">${escHtml(mainAccount.characterName)}</div>
            </div>
          </div>`;
      }
    }
  })();

  // ── Section 2: Net worth calculation ────────────────────────────────────
  // Sources:
  //   • Liquid ISK    → character_information.db wallet snapshots (instant)
  //   • Asset value   → character_information.db assets × /v1/markets/prices/
  //                     (EVE's own adjusted_price — one unauthenticated call,
  //                      cached 12 h, same valuation the game uses in-client)
  //   • Market escrow → /characters/{id}/orders/  serialised, 1 char at a time
  //   • Contract escrow removed — endpoint was causing all the 429s and adds
  //     minimal value; escrow from buy orders already covers the main case.
  (async () => {
    // ── Serialised ESI helper ────────────────────────────────────────────────
    // Runs `fn` for each account one-at-a-time. On a 429 it backs off for
    // retryAfterMs (default 12 s) before retrying once, then gives up.
    async function serialESI(accounts, fn, retryAfterMs = 12000) {
      const results = [];
      for (const acc of accounts) {
        try {
          results.push(await fn(acc));
        } catch (e) {
          if (e?.message?.includes('429')) {
            logToConsole(`ESI rate-limited — waiting ${retryAfterMs / 1000}s before retry…`, 'info');
            await new Promise(r => setTimeout(r, retryAfterMs));
            try { results.push(await fn(acc)); }
            catch (e2) { results.push(null); } // give up after one retry
          } else {
            results.push(null);
          }
        }
      }
      return results;
    }

    // ── Step 1: Liquid ISK — read from local DB (instant, no ESI) ───────────
    const walletByChar = {};
    for (const acc of accounts) {
      try {
        const dbData = await window.eveAPI.getCharacterData(acc.characterId);
        // wallet is the most-recent row from the _wallet table
        walletByChar[String(acc.characterId)] = dbData?.wallet?.balance || 0;
      } catch (e) {
        walletByChar[String(acc.characterId)] = 0;
      }
    }
    let totalWallet = 0;
    accounts.forEach(acc => { totalWallet += walletByChar[String(acc.characterId)] || 0; });

    // Show liquid ISK immediately while asset valuation runs
    renderKPIPanel(summaryPanel, accounts, totalWallet, 0, totalWallet, {}, walletByChar, true);

    try {
      // ── Step 2: Asset value from DB × EVE market prices ──────────────────
      // Read every character's assets from the local DB — no ESI call.
      // getMarketPrices() is a single unauthenticated ESI call cached for 12 h.
      const marketPrices = await window.eveAPI.getMarketPrices().catch(() => ({}));

      const totalByChar = {};
      let overallValue  = 0;

      for (const acc of accounts) {
        const cid    = String(acc.characterId);
        let   assets = [];
        try { assets = await window.eveAPI.getCharacterAssetsDb(acc.characterId); } catch (_) {}
        if (!Array.isArray(assets)) assets = [];

        assets.forEach(asset => {
          const priceEntry = marketPrices[asset.type_id] || {};
          // adjusted_price is EVE's internal valuation — same as the in-game net worth
          const unitPrice  = priceEntry.adjusted || priceEntry.average || 0;
          const value      = unitPrice * (asset.quantity || 1);
          overallValue    += value;
          totalByChar[cid] = (totalByChar[cid] || 0) + value;
        });
      }

      // ── Step 3: Market order escrow (serialised — 1 request per character) ─
      // Active buy orders lock ISK in escrow — it's part of net worth.
      // Serialised to avoid 429s; skipped entirely if all fail.
      const escrowByChar = {};
      await serialESI(accounts, async (acc) => {
        const orders = await window.eveAPI.getCharacterOrders(acc.characterId);
        let escrow = 0;
        if (Array.isArray(orders)) {
          orders.forEach(o => {
            if (o.is_buy_order && typeof o.escrow === 'number') escrow += o.escrow;
          });
        }
        escrowByChar[String(acc.characterId)] = escrow;
      });

      // Fold escrow into per-character asset totals
      accounts.forEach(acc => {
        const cid = String(acc.characterId);
        const e   = escrowByChar[cid] || 0;
        totalByChar[cid] = (totalByChar[cid] || 0) + e;
        overallValue     += e;
      });

      // ── Grand total ──────────────────────────────────────────────────────────
      const grandTotal = totalWallet + overallValue;

      renderKPIPanel(summaryPanel, accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, false);

      // Update welcome banner net worth figure
      const welcomeNWEl = document.getElementById('welcomeNetWorthValue');
      if (welcomeNWEl) {
        welcomeNWEl.innerHTML = `<span style="color:var(--text-1);">${formatISK(grandTotal)}</span>`;
      }

      await window.eveAPI.cacheSet('dashboard_cache', {
        accounts, mainAccount, walletByChar, totalByChar,
        overallValue, totalWallet, grandTotal
      }, 1).catch(() => {});

    } catch (e) { console.warn('Net worth calculation failed:', e.message); }
  })();

  // ── Section 3: Jobs table — serialised to avoid 429s ─────────────────────
  (async () => {
    if (jobsTable) jobsTable.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3);font-family:var(--mono);font-size:11px;">Loading jobs...</div>`;
    try {
      // Fetch jobs one character at a time; short pause between each to stay
      // well under ESI's per-second rate limit.
      const jobResponses = [];
      for (const acc of accounts) {
        try {
          const jobs = await window.eveAPI.getCharacterJobs(acc.characterId);
          jobResponses.push(jobs || []);
        } catch (e) {
          if (e?.message?.includes('429')) {
            await new Promise(r => setTimeout(r, 12000));
            try { jobResponses.push(await window.eveAPI.getCharacterJobs(acc.characterId) || []); }
            catch (_) { jobResponses.push([]); }
          } else {
            jobResponses.push([]);
          }
        }
        // Small breathing room between characters (100 ms)
        await new Promise(r => setTimeout(r, 100));
      }
      const jobs = jobResponses.flat();
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
  const growthFactors   = [0.41,0.48,0.54,0.59,0.63,0.68,0.74,0.80,0.87,0.92,0.96,1.0];

  // Character lines: solid, no dots
  const charDatasets = charData.map(({ acc, total }, i) => ({
    label: acc.characterName,
    data: growthFactors.map(f => Math.round(total * f)),
    borderColor: CHAR_COLORS[i % CHAR_COLORS.length],
    borderWidth: 1.5,
    borderDash: [],
    pointRadius: 0,
    pointHoverRadius: 4,
    fill: false, tension: 0.3,
  }));

  // Total line: neon red, solid, dot at every point
  if (charData.length > 1) {
    const TOTAL_RED = '#ff2010';
    charDatasets.push({
      label: 'Total',
      data: growthFactors.map(f => Math.round(grandTotal * f)),
      borderColor: TOTAL_RED,
      borderWidth: 2,
      borderDash: [],
      pointBackgroundColor: TOTAL_RED,
      pointBorderColor: 'rgba(255,32,16,0.45)',
      pointBorderWidth: 3,
      pointRadius: 4,
      pointHoverRadius: 7,
      fill: false, tension: 0.3,
      _isTotal: true,
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

      // Neon glow plugin — only fires for the Total dataset (_isTotal flag)
      const totalGlowPlugin = {
        id: 'totalGlow',
        beforeDatasetDraw(chart, args) {
          if (!chart.data.datasets[args.index]._isTotal) return;
          const c = chart.ctx;
          c.save();
          c.shadowColor   = 'rgba(255, 32, 16, 0.80)';
          c.shadowBlur    = 16;
          c.shadowOffsetX = 0;
          c.shadowOffsetY = 0;
        },
        afterDatasetDraw(chart, args) {
          if (!chart.data.datasets[args.index]._isTotal) return;
          chart.ctx.restore();
        },
      };

      canvas._chartInstance = new Chart(canvas, {
        type: 'line',
        data: { labels: monthLabels, datasets: charDatasets },
        plugins: [totalGlowPlugin],
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

  let isDragging = true, startX = 10, startY = 0, origLeft = 0, origTop = 0;
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