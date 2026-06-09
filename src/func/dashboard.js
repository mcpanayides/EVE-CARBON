// ─── Dashboard ────────────────────────────────────────────────────────────────
// ── Background auto-refresh: silently sync stale characters ──────────────────
// Called once per dashboard load. Checks every character's last synced_at from
// character_information.db. If data is older than STALE_MS and no manual sync
// is already running, queues them one-at-a-time to avoid hammering ESI.

const STALE_MS = 30 * 60 * 1000; // 30 minutes

let _dashboardLoading       = false;
let _autoRefreshRunning     = false;
let _pingListenerRegistered = false;

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
        // Core data (wallet/location/ship/etc.) refreshes on every pass.
        // Assets are heavy (paginated fetch + structure-location resolution) and
        // the ESI assets endpoint only updates hourly, so they're governed by a
        // separate 6-hour staleness gate that self-skips when data is still fresh.
        await window.eveAPI.syncCharacterCore(acc.characterId);
        await window.eveAPI.syncCharacterAssetsIfStale(acc.characterId);
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

function renderDashboardPing(ping) {
  const el = document.getElementById('dashboardPingsContent');
  if (!el) return;

  if (!ping) {
    el.innerHTML = '<div class="dashboard-empty">No pings recorded.</div>';
    return;
  }

  const timeStr = ping.eve_timecode || ping.ping_timestamp || ping.received_at || '';

  // Type badges
  const directorBadge = ping.is_director
    ? `<span class="dash-ping-badge dash-ping-badge--director">Director</span>` : '';
  const papRaw = (ping.pap_type || '').toLowerCase();
  let papCls = '';
  if (papRaw && !papRaw.includes('no pap')) {
    papCls = (papRaw.includes('stratop') || papRaw.includes('strat')) ? 'dash-ping-badge--stratop' : 'dash-ping-badge--cta';
  }
  const papBadge = papCls
    ? `<span class="dash-ping-badge ${papCls}">${escHtml(ping.pap_type)}</span>` : '';
  const sigBadge = ping.sig
    ? `<span class="dash-ping-badge dash-ping-badge--sig">${escHtml(ping.sig)}</span>` : '';
  const targetBadge = (ping.target_sig && ping.target_sig !== ping.sig)
    ? `<span class="dash-ping-badge dash-ping-badge--sig">${escHtml(ping.target_sig)}</span>` : '';

  const viewBtn = ping.id != null
    ? `<button class="dash-ping-view-btn" data-ping-id="${ping.id}">View</button>` : '';

  const field = (label, val, wide = false) => val
    ? `<div class="dash-ping-field${wide ? ' dash-ping-field--wide' : ''}">
         <span class="dash-ping-label">${label}</span>
         <span class="dash-ping-value" title="${escHtml(val)}">${escHtml(val)}</span>
       </div>` : '';

  const docShort = ping.doctrine
    ? ping.doctrine.replace(/https?:\/\/\S+/g, '').trim() : null;
  const msgBody  = ping.hurf || ping.raw_body || '';

  el.innerHTML = `
    <div class="dash-ping-card">
      <div class="dash-ping-header">
        <div class="dash-ping-header-left">
          <div class="dash-ping-type-row">
            ${directorBadge}${papBadge}${sigBadge}${targetBadge}
          </div>
          <div class="dash-ping-from">From <span>${escHtml(ping.who_pinged || ping.gsol_member || '—')}</span></div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
          <span class="dash-ping-time">${escHtml(timeStr)}</span>
          ${viewBtn}
        </div>
      </div>
      <div class="dash-ping-fields">
        ${field('FC', ping.fc_name)}
        ${field('Comms', ping.comms)}
        ${field('Formup', ping.formup_location)}
        ${field('PAP Type', ping.pap_type)}
        ${field('Doctrine', docShort, true)}
      </div>
      ${msgBody ? `<div class="dash-ping-msg">${escHtml(msgBody)}</div>` : ''}
    </div>`;

  const viewBtnEl = el.querySelector('.dash-ping-view-btn[data-ping-id]');
  if (viewBtnEl) {
    viewBtnEl.addEventListener('click', () => {
      window.eveAPI.openPingAlert(parseInt(viewBtnEl.dataset.pingId, 10));
    });
  }
}

// ─── Dashboard drag-and-drop panel reordering ────────────────────────────────

function initDashboardDnD() {
  const grid = document.getElementById('dashboardContent');
  if (!grid) return;

  // Restore saved layout before wiring events
  _dndRestoreLayout();

  let dragging   = null;   // panel being dragged
  let srcCol     = null;   // column it came from

  function _save() {
    const state = {};
    grid.querySelectorAll('.dashboard-col').forEach(col => {
      state[col.id] = [...col.querySelectorAll(':scope > .dnd-panel')].map(p => p.id);
    });
    try { localStorage.setItem('dashboardLayout', JSON.stringify(state)); } catch (_) {}
  }

  function _dropIntoCol(col, refPanel, e) {
    if (!dragging || col === dragging) return;
    if (refPanel && refPanel !== dragging) {
      const rect = refPanel.getBoundingClientRect();
      col.insertBefore(dragging, e.clientY < rect.top + rect.height / 2 ? refPanel : refPanel.nextSibling);
    } else if (!refPanel) {
      col.appendChild(dragging);
    }
    _save();
  }

  // Wire panels
  grid.querySelectorAll('.dnd-panel').forEach(panel => {
    panel.addEventListener('dragstart', e => {
      dragging = panel;
      srcCol   = panel.parentElement;
      panel.classList.add('dnd-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Needed for Firefox
      e.dataTransfer.setData('text/plain', panel.id);
    });

    panel.addEventListener('dragend', () => {
      grid.querySelectorAll('.dnd-panel').forEach(p => p.classList.remove('dnd-over', 'dnd-dragging'));
      grid.querySelectorAll('.dashboard-col').forEach(c => c.classList.remove('dnd-col-over'));
      dragging = null;
      srcCol   = null;
    });

    panel.addEventListener('dragover', e => {
      e.preventDefault();
      if (!dragging || panel === dragging) return;
      e.dataTransfer.dropEffect = 'move';
      grid.querySelectorAll('.dnd-panel').forEach(p => p.classList.remove('dnd-over'));
      panel.classList.add('dnd-over');
    });

    panel.addEventListener('drop', e => {
      e.preventDefault();
      const col = panel.parentElement;
      grid.querySelectorAll('.dnd-panel').forEach(p => p.classList.remove('dnd-over'));
      _dropIntoCol(col, panel, e);
    });
  });

  // Wire columns (drop into empty space at bottom of col)
  grid.querySelectorAll('.dashboard-col').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Only highlight col if hovering its padding (not a panel)
      if (e.target === col) col.classList.add('dnd-col-over');
    });

    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('dnd-col-over');
    });

    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('dnd-col-over');
      if (e.target === col) _dropIntoCol(col, null, e);
    });
  });
}

function _dndRestoreLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem('dashboardLayout') || 'null');
    if (!saved) return;
    const grid = document.getElementById('dashboardContent');
    if (!grid) return;
    Object.entries(saved).forEach(([colId, panelIds]) => {
      const col = document.getElementById(colId);
      if (!col) return;
      panelIds.forEach(pid => {
        const panel = document.getElementById(pid);
        if (panel) col.appendChild(panel);
      });
    });
  } catch (_) {}
}

async function loadDashboard() {
  const summaryPanel   = document.getElementById('dashboardNetworthSummary');
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
      console.log('[implants] renderBanner received:', JSON.stringify(implants));

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

      // ── Implant slot grid HTML (slots 1-5 top row, 6-10 bottom row) ────────
      // Builds a slot→implant lookup using the real slot number stored in the DB
      // (written by resolveImplantSlots() in main.js via dogma attribute 331).
      // If a slot number is missing/null (old pre-fix DB data), implants are
      // placed into the first available free slot as a graceful fallback.
      function buildImplantGrid(implants) {
        const bySlot = {};
        const unslotted = [];
        for (const row of implants) {
          const s = Number(row.slot);
          // Log each row so issues with id/slot are immediately visible in DevTools
          console.log(`[implants] slot=${row.slot} implant_id=${row.implant_id} type_id=${row.type_id} type_name=${row.type_name}`);
          if (s >= 1 && s <= 10) { bySlot[s] = row; }
          else { unslotted.push(row); }
        }
        let nextFree = 1;
        for (const row of unslotted) {
          while (bySlot[nextFree] && nextFree <= 10) nextFree++;
          if (nextFree <= 10) { bySlot[nextFree] = row; nextFree++; }
        }
        function slotHtml(slot) {
          const row = bySlot[slot];
          if (!row) {
            return `<div class="implant-slot implant-slot--empty" title="Slot ${slot}"><span class="implant-slot-num">${slot}</span></div>`;
          }
          // Resolve the type ID: normalisation already ran above but guard all
          // possible field names so a DB schema mismatch never silently breaks icons.
          const id = row.implant_id || row.type_id || row.id || row.implantId || null;
          const label = escHtml(row.type_name || (id ? `Implant ${id}` : `Slot ${slot}`));

          if (!id) {
            // ID is genuinely missing — render as a visually distinct unknown slot
            return `<div class="implant-slot implant-slot--filled implant-slot--unknown" title="${label}">
              <span class="implant-slot-num">${slot}</span>
              <span class="implant-slot-unknown-icon">?</span>
            </div>`;
          }

          // Use size=64: broader CDN coverage than size=32.
          // On error: swap to the 32px fallback first, then show the "?" placeholder
          // so a broken image is never silently invisible.
          const icon64 = `https://images.evetech.net/types/${id}/icon?size=64`;
          const icon32 = `https://images.evetech.net/types/${id}/icon?size=32`;
          return `<div class="implant-slot implant-slot--filled" title="${label}" data-implant-id="${id}">
            <span class="implant-slot-num">${slot}</span>
            <img class="banner-implant-icon" src="${icon64}" alt="${label}"
                 onerror="if(this.src!=='${icon32}'){this.src='${icon32}';}else{this.style.display='none';this.parentElement.classList.add('implant-slot--icon-error');}"/>
          </div>`;
        }
        return `<div class="implant-grid-row">${[1,2,3,4,5].map(slotHtml).join('')}</div>` +
               `<div class="implant-grid-row">${[6,7,8,9,10].map(slotHtml).join('')}</div>`;
      }
      const implantIconsHtml = buildImplantGrid(implants);

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
              <div class="banner-implant-grid" id="bannerImplantIcons">${implantIconsHtml}</div>
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
          implant_id: row.implant_id || row.type_id || row.id || row.implantId,
          type_name:  row.type_name  || row.name    || row.typeName || null,
          slot:       row.slot != null ? Number(row.slot) : null,
        })).filter(r => r.implant_id);
        logToConsole(`Implants from DB: ${implants.length} found`, 'info');
      } else {
        logToConsole('Implants array empty or missing — character may have none or needs a sync.', 'info');
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
        allianceId: info.alliance_id,       allianceName,
        homeStationName, homeSystemSec,
        bloodlineName,
        implants,
        currentShipTypeId, currentShipTypeName,
        stale: false,
      });

      logToConsole('Welcome banner loaded from local DB.', 'info');

      // Check if alliance holds sov with active incursions — fire-and-forget
      renderAllianceIncursionAlert(info.alliance_id).catch(() => {});

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

    // Asset value + escrow are expensive (full asset read + per-character ESI
    // order calls) but change slowly — assets re-sync every 6 h, prices every
    // 12 h. So we cache the per-character {assetValue, escrow, assetSyncedAt}
    // and only recompute a character when its assets re-synced or this coarse
    // TTL elapses (to pick up market-price drift). Liquid ISK is always read
    // fresh — it's one cheap wallet row and the figure that moves most.
    const NET_WORTH_TTL_MS = 30 * 60 * 1000; // 30 minutes

    // Build totalByChar / overallValue from a per-character value map.
    function assembleTotals(perChar) {
      const totalByChar = {};
      let overallValue = 0;
      for (const acc of accounts) {
        const cid = String(acc.characterId);
        const pc  = perChar[cid] || {};
        const v   = (pc.assetValue || 0) + (pc.escrow || 0);
        totalByChar[cid] = v;
        overallValue += v;
      }
      return { totalByChar, overallValue };
    }

    function renderNetWorth(perChar, totalWallet, walletByChar, loading) {
      const { totalByChar, overallValue } = assembleTotals(perChar);
      const grandTotal = totalWallet + overallValue;
      renderKPIPanel(summaryPanel, accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, loading);
      const welcomeNWEl = document.getElementById('welcomeNetWorthValue');
      if (welcomeNWEl) {
        welcomeNWEl.innerHTML = `<span style="color:var(--text-1);">${formatISK(grandTotal)}</span>`;
      }
      return { totalByChar, overallValue, grandTotal };
    }

    // ── Step 1: Liquid ISK — read from local DB (instant, no ESI) ───────────
    const walletByChar = {};
    for (const acc of accounts) {
      try {
        const dbData = await window.eveAPI.getCharacterData(acc.characterId);
        walletByChar[String(acc.characterId)] = dbData?.wallet?.balance || 0;
      } catch (e) {
        walletByChar[String(acc.characterId)] = 0;
      }
    }
    let totalWallet = 0;
    accounts.forEach(acc => { totalWallet += walletByChar[String(acc.characterId)] || 0; });

    // ── Step 2: Show the cached net worth instantly (stale-while-revalidate) ─
    const cache      = await window.eveAPI.cacheGet('dashboard_asset_value').catch(() => null);
    const perChar    = (cache && cache.perChar) ? { ...cache.perChar } : {};
    const computedAt = (cache && cache.computedAt) || 0;
    const ttlExpired = (Date.now() - computedAt) >= NET_WORTH_TTL_MS;

    // Render whatever we have right away (cached asset value + fresh wallet).
    // On a cold cache there's no asset value yet, so show the loading state.
    renderNetWorth(perChar, totalWallet, walletByChar, !cache);

    try {
      // Drop cached entries for characters that were removed.
      const liveIds = new Set(accounts.map(a => String(a.characterId)));
      for (const cid of Object.keys(perChar)) if (!liveIds.has(cid)) delete perChar[cid];

      // ── Step 3: Decide which characters actually need recompute ──────────
      // A character is dirty if it has no cached value, its assets re-synced
      // since we last priced them, or the price-drift TTL has elapsed.
      const dirty = [];
      for (const acc of accounts) {
        const cid     = String(acc.characterId);
        const cached  = perChar[cid];
        let syncedAt  = 0;
        try { syncedAt = await window.eveAPI.getAssetSyncedAt(acc.characterId); } catch (_) {}
        if (!cached || cached.assetSyncedAt !== syncedAt || ttlExpired) {
          dirty.push({ acc, cid, syncedAt });
        }
      }

      if (dirty.length) {
        // ── Step 4: Recompute only the dirty characters ───────────────────
        const marketPrices = await window.eveAPI.getMarketPrices().catch(() => ({}));

        for (const { acc, cid, syncedAt } of dirty) {
          let assets = [];
          try { assets = await window.eveAPI.getCharacterAssetsDb(acc.characterId); } catch (_) {}
          if (!Array.isArray(assets)) assets = [];

          let assetValue = 0;
          assets.forEach(asset => {
            let unitPrice;
            if (Number(asset.is_bpc) === 1) {
              // Blueprint copies are valued nominally — they share a type_id with
              // the original, so adjusted_price would otherwise count a copy as a
              // full BPO (e.g. a Titan BPC as tens of billions).
              unitPrice = 0.01;
            } else {
              const priceEntry = marketPrices[asset.type_id] || {};
              // adjusted_price is EVE's internal valuation — same as the in-game
              // net worth; for BPOs it reflects seeded Titan/Super values.
              unitPrice = priceEntry.adjusted || priceEntry.average || 0;
            }
            assetValue += unitPrice * (asset.quantity || 1);
          });

          perChar[cid] = { assetValue, escrow: perChar[cid]?.escrow || 0, assetSyncedAt: syncedAt };
        }

        // Market-order escrow for the dirty characters only (serialised ESI).
        await serialESI(dirty.map(d => d.acc), async (acc) => {
          const cid    = String(acc.characterId);
          const orders = await window.eveAPI.getCharacterOrders(acc.characterId);
          let escrow = 0;
          if (Array.isArray(orders)) {
            orders.forEach(o => { if (o.is_buy_order && typeof o.escrow === 'number') escrow += o.escrow; });
          }
          if (perChar[cid]) perChar[cid].escrow = escrow;
        });

        // Persist the refreshed per-character cache. Only bump computedAt on a
        // TTL-driven full refresh so price-drift refreshes still fire on
        // schedule when only an asset re-sync forced a partial recompute.
        const nextComputedAt = ttlExpired ? Date.now() : (computedAt || Date.now());
        await window.eveAPI.cacheSet('dashboard_asset_value',
          { computedAt: nextComputedAt, perChar }, 1).catch(() => {});
      }

      // ── Render final figures and keep dashboard_cache in sync ───────────
      const { totalByChar, overallValue, grandTotal } =
        renderNetWorth(perChar, totalWallet, walletByChar, false);

      await window.eveAPI.cacheSet('dashboard_cache', {
        accounts, mainAccount, walletByChar, totalByChar,
        overallValue, totalWallet, grandTotal
      }, 1).catch(() => {});

    } catch (e) { console.warn('Net worth calculation failed:', e.message); }
  })();

  // ── Section 3: Active jobs widget ───────────────────────────────────────
  (async () => {
    const container = document.getElementById('dashboardActiveJobsTable');
    if (!container) return;
    try {
      const tag = (id, list) => (list || []).map(j => ({ ...j, character_id: id }));
      const responses = [];
      for (const acc of accounts) {
        try {
          responses.push(tag(acc.characterId, await window.eveAPI.getCharacterActiveJobs(acc.characterId)));
        } catch { responses.push([]); }
        await new Promise(r => setTimeout(r, 80));
      }
      const allJobs    = responses.flat();
      const activeJobs = allJobs.filter(j => j.status === 'active' || j.status === 'ready' || j.status === 'paused');
      renderActiveJobsWidget(container, activeJobs, accounts);
    } catch (e) {
      console.error('[dashboard] Active jobs widget failed:', e);
      container.innerHTML = '<div class="active-jobs-empty">Failed to load.</div>';
    }
  })();

  // ── Section 4: PI widget ────────────────────────────────────────────────
  (async () => {
    const piContainer = document.getElementById('dashboardPIWidget');
    if (!piContainer) return;
    try {
      await renderDashboardPIWidget(piContainer, accounts);
    } catch (e) {
      console.error('[dashboard] PI widget failed:', e);
      piContainer.innerHTML = '<div style="padding:12px;font-family:var(--mono);font-size:11px;color:var(--danger);">Failed to load PI data.</div>';
    }
  })();

  // ── Section 5: Latest ping ───────────────────────────────────────────────
  (async () => {
    try {
      // Prefer in-memory (jabberMessages is populated by jabber.js once connected)
      // Fall back to DB for the most recent stored ping.
      let ping = (typeof jabberMessages !== 'undefined' && jabberMessages.length > 0)
        ? jabberMessages.reduce((a, b) =>
            (b.eve_timecode || b.received_at || '') > (a.eve_timecode || a.received_at || '') ? b : a)
        : null;

      if (!ping) {
        const history = await window.eveAPI.getJabberMessages(1);
        ping = Array.isArray(history) && history.length > 0 ? history[0] : null;
      }
      renderDashboardPing(ping);
    } catch (e) {
      const el = document.getElementById('dashboardPingsContent');
      if (el) el.innerHTML = '<div class="dashboard-empty">Could not load pings.</div>';
    }
  })();

  // Update ping panel live when a new Jabber message arrives.
  // Guard prevents duplicate listeners across repeated loadDashboard() calls.
  if (!_pingListenerRegistered) {
    _pingListenerRegistered = true;
    window.eveAPI.on('jabber-message', (payload) => {
      const row = (typeof jabberLiveToRow === 'function' && !('raw_body' in payload))
        ? jabberLiveToRow(payload)
        : payload;
      renderDashboardPing(row);
    });
  }

  // Initialise drag-and-drop after all panels are rendered
  initDashboardDnD();
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
      <div class="dash-wealth-kpi"><div class="dash-kpi-label">LIQUID ISK</div><div class="dash-kpi-value liquidisk">${formatISK(totalWallet)}</div><div class="dash-kpi-sub">Wallet balance</div></div>
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

// ─── Active industry jobs widget ─────────────────────────────────────────────

const _AJ_ACTIVITY = {
  1: { label: 'Manufacturing', cls: 'aj-act-1' },
  3: { label: 'TE Research',   cls: 'aj-act-3' },
  4: { label: 'ME Research',   cls: 'aj-act-4' },
  5: { label: 'BP Copy',       cls: 'aj-act-5' },
  7: { label: 'Reverse Eng.',  cls: 'aj-act-7' },
  8: { label: 'Invention',     cls: 'aj-act-8' },
};

function _fmtTimeLeft(ms) {
  if (ms <= 0) return 'Done';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Resolve item names for a list of type IDs using ESI names then SDE fallback.
async function _resolveTypeNames(typeIds) {
  const map = {};
  if (!typeIds.length) return map;
  try {
    const arr = await window.eveAPI.getNames(typeIds);
    if (Array.isArray(arr)) arr.forEach(({ id, name }) => { if (id && name) map[id] = name; });
    else if (arr && typeof arr === 'object') Object.assign(map, arr);
  } catch { /* fall through to SDE */ }
  const missing = typeIds.filter(id => !map[id]);
  await Promise.all(missing.map(async id => {
    try { const n = await window.eveAPI.sdeGetName(id); if (n) map[id] = n; } catch { /* skip */ }
  }));
  return map;
}

async function renderActiveJobsWidget(container, jobs, accounts) {
  if (!jobs.length) {
    container.innerHTML = '<div class="active-jobs-empty">No active industry jobs.</div>';
    return;
  }

  const accountMap = Object.fromEntries(accounts.map(a => [String(a.characterId), a]));

  // Resolve type names
  const typeIds = [...new Set(
    jobs.flatMap(j => [j.product_type_id, j.blueprint_type_id].filter(Boolean))
  )];
  const typeNames = await _resolveTypeNames(typeIds);

  // Resolve system names: SDE offline lookup, then facility fallback for solar_system_id = 0
  const sysIds = [...new Set(jobs.map(j => j.solar_system_id).filter(Boolean))];
  let sysNames = {};
  if (sysIds.length) {
    try { sysNames = await window.eveAPI.sdeGetSystemNames(sysIds) || {}; } catch (_) {}
    const missing = sysIds.filter(id => !sysNames[id]);
    if (missing.length) {
      try {
        const m = await window.eveAPI.resolveSystemNames(missing) || {};
        Object.assign(sysNames, m);
      } catch (_) {}
    }
  }
  const facilityIds = [...new Set(
    jobs.filter(j => !j.solar_system_id && j.facility_id).map(j => j.facility_id)
  )];
  let facilityToSys = {};
  if (facilityIds.length) {
    try { facilityToSys = await window.eveAPI.sdeFacilityToSystem(facilityIds) || {}; } catch (_) {}
  }

  const now = Date.now();

  // Sort: active first (by end_date asc), then ready, then paused
  const order = { active: 0, ready: 1, paused: 2 };
  const sorted = [...jobs].sort((a, b) => {
    const oa = order[a.status] ?? 3, ob = order[b.status] ?? 3;
    if (oa !== ob) return oa - ob;
    return new Date(a.end_date) - new Date(b.end_date);
  });

  const rows = sorted.map(job => {
    const charName   = accountMap[String(job.character_id)]?.characterName || `Char ${job.character_id}`;
    const itemTypeId = job.product_type_id || job.blueprint_type_id || null;
    const itemName   = (itemTypeId && typeNames[itemTypeId]) || (itemTypeId ? `Type ${itemTypeId}` : 'Unknown');
    const sysName    = (job.solar_system_id && sysNames[job.solar_system_id])
                    || (job.facility_id    && facilityToSys[job.facility_id])
                    || (job.solar_system_id ? `System ${job.solar_system_id}` : '—');
    const act        = _AJ_ACTIVITY[job.activity_id] || { label: `Activity ${job.activity_id}`, cls: '' };

    // Same 3-step fallback as finished-jobs: 64px icon → 32px icon → bp image → hide
    const icon64 = `https://images.evetech.net/types/${itemTypeId}/icon?size=64`;
    const icon32 = `https://images.evetech.net/types/${itemTypeId}/icon?size=32`;
    const iconBp = `https://images.evetech.net/types/${itemTypeId}/bp?size=32`;
    const itemIcon = itemTypeId
      ? `<img src="${icon64}"
              alt="${escHtml(itemName)}"
              style="width:22px;height:22px;border-radius:3px;border:1px solid var(--border);
                     vertical-align:middle;margin-right:6px;object-fit:cover;
                     flex-shrink:0;background:var(--bg-deep);"
              onerror="if(this.src==='${icon64}'){this.src='${icon32}';}else if(this.src==='${icon32}'){this.src='${iconBp}';}else{this.style.display='none';}"/>`
      : '';

    const charPortrait = `<img
      src="https://images.evetech.net/characters/${job.character_id}/portrait?size=32"
      alt="" style="width:20px;height:20px;border-radius:3px;border:1px solid var(--border);
                    vertical-align:middle;margin-right:5px;object-fit:cover;"
      onerror="this.style.display='none'"/>`;

    let progressCell;
    if (job.status === 'ready') {
      progressCell = `<td><span class="aj-status-ready">✓ READY</span></td>`;
    } else if (job.status === 'paused') {
      progressCell = `<td><span class="aj-status-paused">⏸ PAUSED</span></td>`;
    } else {
      const start   = new Date(job.start_date).getTime();
      const end     = new Date(job.end_date).getTime();
      const pct     = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
      const left    = Math.max(0, end - now);
      // Colour: green when almost done, accent/red otherwise
      const fillCol = pct >= 90 ? '#4ecbb0' : pct >= 50 ? 'var(--accent)' : '#c0392b';
      progressCell  = `
        <td>
          <div class="aj-progress-wrap">
            <div class="aj-progress-track">
              <div class="aj-progress-fill" style="width:${pct.toFixed(1)}%;background:${fillCol};"></div>
            </div>
            <div class="aj-progress-label">${_fmtTimeLeft(left)} left</div>
          </div>
        </td>`;
    }

    return `<tr>
      <td class="aj-cell-char">${charPortrait}${escHtml(charName)}</td>
      <td class="aj-cell-item">${itemIcon}<span>${escHtml(itemName)}</span></td>
      <td><span class="aj-activity-badge ${act.cls}">${act.label}</span></td>
      ${progressCell}
    </tr>`;
  }).join('');

  const charCount = new Set(jobs.map(j => String(j.character_id))).size;
  container.innerHTML = `
    <div class="active-jobs-summary">
      <span>${jobs.length} job${jobs.length !== 1 ? 's' : ''} · ${charCount} character${charCount !== 1 ? 's' : ''}</span>
      <button id="ajViewAllBtn" style="
        margin-left:auto;padding:2px 10px;font-family:var(--mono);font-size:10px;
        background:transparent;border:1px solid var(--border);border-radius:3px;
        color:var(--text-3);cursor:pointer;letter-spacing:0.06em;
        transition:color 0.15s,border-color 0.15s;">
        VIEW ALL ›
      </button>
    </div>
    <div class="active-jobs-scroll">
      <table class="active-jobs-list">
        <thead>
          <tr>
            <th>CHARACTER</th>
            <th>ITEM</th>
            <th>ACTIVITY</th>
            <th>PROGRESS</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.getElementById('ajViewAllBtn')?.addEventListener('click', () => {
    if (typeof navigateToPage    === 'function') navigateToPage('industry');
    if (typeof navigateIndustryTab === 'function') navigateIndustryTab('active-jobs');
  });
}

// ─── Dashboard PI Widget ──────────────────────────────────────────────────────

async function renderDashboardPIWidget(container, accounts) {
  // Gather all colonies — getPIColonies returns properly parsed storage arrays
  const allColonies = [];
  await Promise.allSettled(accounts.map(async acc => {
    const charId = acc.characterId ?? acc.character_id ?? acc.id;
    try {
      const cols = await window.eveAPI.getPIColonies(charId) ?? [];
      cols.forEach(c => allColonies.push({ ...c, _charName: acc.characterName || `Char ${charId}` }));
    } catch (_) {}
  }));

  if (!allColonies.length) {
    container.innerHTML = `
      <div class="dashboard-panel-title dnd-handle" style="margin-bottom:10px;">
        <span style="flex:1;">🪐 PLANETARY INTERACTION</span>
        <button class="pi-dash-link-btn" style="padding:2px 10px;font-family:var(--mono);font-size:10px;background:transparent;border:1px solid var(--border);border-radius:3px;color:var(--text-3);cursor:pointer;letter-spacing:0.06em;flex-shrink:0;">VIEW PI ›</button>
        <span class="dnd-grip">⠿</span>
      </div>
      <div style="padding:20px 0;text-align:center;font-family:var(--mono);font-size:11px;color:var(--text-3);">
        No colonies found — sync your characters first.
      </div>`;
    container.querySelector('.pi-dash-link-btn')?.addEventListener('click', _piDashNav);
    return;
  }

  const now = Date.now();

  // Categorise every colony using the same logic as the PI page
  let nActive = 0, nWarning = 0, nIdle = 0;
  const soonExpiring = []; // colonies expiring within 24h, sorted soonest first

  allColonies.forEach(col => {
    const expiresAt   = col.extractor_expires_at;
    const storageArr  = Array.isArray(col.storage) ? col.storage
                      : (col.storage_json ? JSON.parse(col.storage_json) : []);
    const storageFull = storageArr.some(s => s.fill_pct >= 90);

    if (expiresAt && expiresAt > now) {
      nActive++;
      const hoursLeft = (expiresAt - now) / 3_600_000;
      if (hoursLeft <= 24) soonExpiring.push({ col, expiresAt });
    } else if (storageFull) {
      nWarning++;
    } else {
      nIdle++;
    }
  });

  soonExpiring.sort((a, b) => a.expiresAt - b.expiresAt);

  const total    = allColonies.length;
  const charCount = new Set(accounts.map(a => a.characterId)).size;

  // Build expiry alert rows (up to 4)
  const alertRows = soonExpiring.slice(0, 4).map(({ col, expiresAt }) => {
    const diffMs  = expiresAt - now;
    const hrs     = Math.floor(diffMs / 3_600_000);
    const mins    = Math.floor((diffMs % 3_600_000) / 60_000);
    const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    const urgent  = hrs < 4;
    const pType   = col.planet_type || 'unknown';
    const ptId    = { temperate:11, oceanic:2014, ice:12, gas:13, lava:2015, barren:2016, storm:2017, plasma:2063 }[pType] || 11;
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;
                  border-top:1px solid var(--border);">
        <img src="https://images.evetech.net/types/${ptId}/icon?size=32"
             style="width:18px;height:18px;border-radius:2px;flex-shrink:0;"
             onerror="this.style.display='none'">
        <span style="flex:1;font-size:11px;color:var(--text-2);
                     overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${escHtml(col._charName)} · ${escHtml(pType.charAt(0).toUpperCase() + pType.slice(1))}
        </span>
        <span style="font-family:var(--mono);font-size:10px;font-weight:700;
                     color:${urgent ? 'var(--danger)' : 'var(--warning, #e3a84d)'};
                     white-space:nowrap;">
          ${timeStr}
        </span>
      </div>`;
  }).join('');

  container.innerHTML = `
    <!-- Header -->
    <div class="dashboard-panel-title dnd-handle" style="margin-bottom:10px;">
      <span style="flex:1;">🪐 PLANETARY INTERACTION</span>
      <button class="pi-dash-link-btn" style="
        padding:2px 10px;font-family:var(--mono);font-size:10px;
        background:transparent;border:1px solid var(--border);border-radius:3px;
        color:var(--text-3);cursor:pointer;letter-spacing:0.06em;flex-shrink:0;">
        VIEW PI ›
      </button>
      <span class="dnd-grip">⠿</span>
    </div>

    <!-- Summary line -->
    <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);margin-bottom:12px;">
      ${total} planet${total !== 1 ? 's' : ''} · ${charCount} character${charCount !== 1 ? 's' : ''}
    </div>

    <!-- Status counts -->
    <div style="display:flex;gap:10px;margin-bottom:12px;">
      <div style="flex:1;padding:8px 12px;background-color:var(--bg-panel);background-image:radial-gradient(circle,var(--dot-color) 1px,transparent 1px);background-size:6px 6px;border:1px solid var(--border);
                  border-radius:6px;text-align:center;">
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:#4ecbb0;">
          ${nActive}
        </div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                    letter-spacing:0.08em;margin-top:2px;">EXTRACTING</div>
      </div>
      <div style="flex:1;padding:8px 12px;background-color:var(--bg-panel);background-image:radial-gradient(circle,var(--dot-color) 1px,transparent 1px);background-size:6px 6px;border:1px solid var(--border);
                  border-radius:6px;text-align:center;">
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;
                    color:${nWarning > 0 ? '#e3a84d' : 'var(--text-3)'};">
          ${nWarning}
        </div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                    letter-spacing:0.08em;margin-top:2px;">STORAGE FULL</div>
      </div>
      <div style="flex:1;padding:8px 12px;background-color:var(--bg-panel);background-image:radial-gradient(circle,var(--dot-color) 1px,transparent 1px);background-size:6px 6px;border:1px solid var(--border);
                  border-radius:6px;text-align:center;">
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;
                    color:${nIdle > 0 ? 'var(--text-2)' : 'var(--text-3)'};">
          ${nIdle}
        </div>
        <div style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                    letter-spacing:0.08em;margin-top:2px;">IDLE</div>
      </div>
    </div>

    <!-- Expiring soon -->
    ${soonExpiring.length ? `
      <div style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                  letter-spacing:0.1em;margin-bottom:4px;">EXPIRING WITHIN 24H</div>
      ${alertRows}
    ` : nActive > 0 ? `
      <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                  padding:6px 0;">All active extractors have more than 24h remaining.</div>
    ` : ''}`;

  container.querySelector('.pi-dash-link-btn')?.addEventListener('click', _piDashNav);
}

function _piDashNav() {
  if (typeof navigateToPage === 'function') navigateToPage('pi');
}

// ─── Alliance-space incursion alert widget ────────────────────────────────────

function _incSecColor(sec) {
  if (sec <= 0.0)  return '#ff4444';
  if (sec <  0.5)  return '#ffaa00';
  return '#44cc88';
}

function _incStateClass(state) {
  switch ((state || '').toLowerCase()) {
    case 'established':  return 'inc-state-established';
    case 'mobilizing':   return 'inc-state-mobilizing';
    case 'withdrawing':  return 'inc-state-withdrawing';
    default:             return '';
  }
}

// Renders (or hides) the incursion alert widget for the selected character's alliance.
// Called fire-and-forget from loadDashboard — never throws.
async function renderAllianceIncursionAlert(allianceId) {
  const container = document.getElementById('allianceIncursionAlert');
  if (!container) return;

  if (!allianceId) { container.style.display = 'none'; return; }

  try {
    const result = await window.eveAPI.getSovIncursionAlert(allianceId);
    if (!result || !result.systems || !result.systems.length) {
      container.style.display = 'none';
      return;
    }

    const systems = result.systems;
    const plural  = systems.length !== 1;

    const rows = systems.map(s => `
      <tr class="inc-alert-row">
        <td class="inc-cell-system">${escHtml(s.systemName)}</td>
        <td class="inc-cell-region">${escHtml(s.regionName)}</td>
        <td class="inc-cell-sec" style="color:${_incSecColor(s.security)};">
          ${s.security.toFixed(1)}
        </td>
        <td class="inc-cell-state">
          <span class="inc-state-badge ${_incStateClass(s.state)}">${escHtml(s.state)}</span>
          ${s.isHQ
            ? `<img class="inc-site-icon" src="https://images.evetech.net/types/3514/render?size=64"
                    title="HQ — Sansha Mothership spawns here" alt="Revenant"/>`
            : `<img class="inc-site-icon" src="https://images.evetech.net/types/17736/render?size=64"
                    title="Nightmare-class site" alt="Nightmare"/>`}
        </td>
        <td class="inc-cell-action">
          <button class="inc-view-btn" onclick="viewSystemOnMap(${s.systemId})">
            View on Map →
          </button>
          <button class="inc-nav-btn" onclick="incursionNavigateTo(${s.systemId}, this)"
                  title="Set autopilot destination in active EVE client">
            ⊕ Navigate
          </button>
        </td>
      </tr>`).join('');

    container.style.display = 'block';
    container.innerHTML = `
      <div class="inc-alert-widget">
        <div class="inc-alert-header">
          <div class="inc-alert-light" title="Active incursion"></div>
          <img class="inc-alert-logo"
               src="https://images.evetech.net/types/3514/render?size=64"
               alt="Sansha's Nation"
               onerror="this.style.display='none'"/>
          <div class="inc-alert-title-block">
            <div class="inc-alert-title">⚠ SANSHA INCURSION — ALLIANCE SPACE</div>
            <div class="inc-alert-subtitle">
              Sansha's Nation forces active in
              <strong>${systems.length}</strong> system${plural ? 's' : ''}
              within your alliance's sovereign territory
            </div>
          </div>
          <div class="inc-projected-earnings" id="incProjectedEarnings">
            <div class="inc-earn-label">PROJECTED EARNINGS</div>
            <div class="inc-earn-sub">avg last 3 runs</div>
            <div class="inc-earn-value" id="incEarnValue">—</div>
          </div>
        </div>
        <table class="inc-alert-table">
          <thead>
            <tr>
              <th>SYSTEM</th><th>REGION</th><th>SEC</th><th>STATUS</th><th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    // Load projected earnings in background — updates #incEarnValue when ready
    loadIncursionEarnings().catch(() => {});

  } catch (e) {
    console.warn('[dashboard] Incursion alert failed:', e.message);
    container.style.display = 'none';
  }
}

// ─── Incursion earnings calculator ───────────────────────────────────────────
// Groups wallet journal incursion_site_reward entries into sessions
// (entries within 4 h of each other = same run), averages the last 3 sessions.

function _groupIntoSessions(entries, gapHours = 4) {
  if (!entries.length) return [];
  const sorted = [...entries].sort((a, b) => new Date(b.date) - new Date(a.date));
  const sessions = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i - 1].date) - new Date(sorted[i].date);
    if (gap > gapHours * 3_600_000) { sessions.push(cur); cur = []; }
    cur.push(sorted[i]);
  }
  sessions.push(cur);
  return sessions;
}

async function loadIncursionEarnings() {
  const valueEl = document.getElementById('incEarnValue');
  if (!valueEl) return;

  try {
    const accounts    = await window.eveAPI.getAccounts().catch(() => []);
    const allEntries  = [];

    for (const acc of accounts) {
      try {
        const journal = await window.eveAPI.getWalletJournal(acc.characterId);
        if (!Array.isArray(journal)) continue;
        for (const e of journal) {
          if (!e.amount || e.amount <= 0) continue;
          const desc = (e.description || '').toLowerCase();
          // "CONCORD rewarded {name} for services performed." — corporate reward payout
          const isConcordPayout =
            e.ref_type === 'corporate_reward_payout' ||
            (desc.includes('concord rewarded') && desc.includes('for services performed'));
          if (isConcordPayout) {
            allEntries.push({ amount: e.amount, date: e.date });
          }
        }
      } catch { /* skip character */ }
    }

    if (!allEntries.length) {
      valueEl.innerHTML = '<span class="inc-earn-lp-note">No data — sync wallet after a run</span>';
      return;
    }

    // Group into incursion events: entries more than 8 days apart = different event.
    // Incursions last at most 8 days so any gap larger than that signals a new event.
    const sessions      = _groupIntoSessions(allEntries, 8 * 24);
    const last3         = sessions.slice(0, 3);
    const totals        = last3.map(s => s.reduce((sum, e) => sum + e.amount, 0));
    const avgISK        = totals.reduce((a, b) => a + b, 0) / totals.length;
    const runsUsed      = last3.length;
    const sites         = last3.reduce((sum, s) => sum + s.length, 0);

    valueEl.innerHTML = `
      <span class="inc-earn-isk">${formatISK(avgISK)}</span>
      <span class="inc-earn-lp-note">${runsUsed} run${runsUsed !== 1 ? 's' : ''} · ${sites} site${sites !== 1 ? 's' : ''} · LP not tracked</span>`;
  } catch (e) {
    console.warn('[dashboard] Incursion earnings failed:', e.message);
  }
}

// Sets the autopilot destination in the active EVE client via ESI.
// Fetches a fresh accounts list at call-time so stale selectedCharacterId
// state (e.g. after re-authentication) never causes "Account not found".
async function incursionNavigateTo(systemId, btn) {
  const orig = btn.textContent;
  btn.disabled    = true;
  btn.textContent = '…';
  try {
    const accounts = await window.eveAPI.getAccounts().catch(() => []);
    if (!accounts.length) throw new Error('No characters added — please add a character first.');

    // Prefer the currently selected character; fall back to the first account.
    const match  = accounts.find(a => String(a.characterId) === String(selectedCharacterId));
    const charId = (match || accounts[0]).characterId;

    await window.eveAPI.setAutopilotDestination(charId, systemId);
    btn.textContent = '✓ Set';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  } catch (e) {
    showToast(`Navigate failed: ${e.message}`, 'error');
    btn.textContent = orig;
    btn.disabled    = false;
  }
}

// Navigates to the map page and flies to the given system in Incursions overlay.
// Safe to call before the map has been opened for the first time.
function viewSystemOnMap(systemId) {
  navigateToPage('map');
  // Give initMapPage() time to set up canvas before flying
  setTimeout(() => {
    if (typeof window.mapJumpToSystem === 'function') {
      window.mapJumpToSystem(systemId);
    }
  }, 200);
}