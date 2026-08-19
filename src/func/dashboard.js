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
      // A dead refresh token can't be fixed by syncing — only a re-login
      // clears it (getValidToken sets this once invalid_grant hits). Queuing
      // it here just guarantees a failed sync + error toast every pass.
      if (acc.needsReauth) continue;
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
      // Still check for widgets that failed. The self-heal used to live only
      // after the sync loop below, so it could not run on this path at all —
      // and this is the path a cold start most often takes. The dashboard
      // paints during the launch ESI burst, some widgets come back "Failed to
      // load", and if every character then turns out to be fresh (a restart
      // minutes after the last one) the function returned here and the blank
      // widgets stayed blank until they were removed and re-added by hand.
      // That is the "blank widgets need a manual refresh" complaint.
      _healFailedDashboardWidgets();
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

    // Re-render whatever data page is open so freshly-synced data appears without
    // any manual reload (assets/wallets read straight from the just-updated CharDB).
    if (typeof refreshCurrentDataView === 'function') refreshCurrentDataView();

    // Live-ESI dashboard widgets (active jobs / skill queue / wallet) may have come
    // back empty during the cold-start ESI burst. Tokens are warm now — re-fetch so
    // they populate without a manual remove/re-add.
    refreshDashboardLiveWidgets().catch(() => {});

  } finally {
    _autoRefreshRunning = false;
  }
}

/**
 * Re-fetch the live-ESI widgets, but only if one of them is actually showing a
 * failure.
 *
 * Deliberately gated rather than unconditional. autoSyncOnNavigate() runs this
 * path on every page change (throttled to once a minute), and
 * refreshDashboardLiveWidgets() makes live per-character ESI calls — active
 * jobs, skill queue, wallet, market orders. Firing that whenever somebody
 * clicks around a healthy dashboard would spend the shared ESI error budget on
 * nothing. A widget that is legitimately empty ("No active market orders")
 * carries no failure marker and is left alone; only dash-widget-failed asks to
 * be retried.
 */
let _dashHealTimer = null;

function _healFailedDashboardWidgets() {
  if (typeof currentPage !== 'undefined' && currentPage !== 'dashboard') return;
  const failed = document.querySelectorAll('.dash-widget-failed');
  if (!failed.length) return;
  logToConsole(`Dashboard: ${failed.length} widget(s) failed to load — retrying.`, 'info');
  refreshDashboardLiveWidgets().catch(() => {});
}

// Throttled entry point fired on every page navigation (see navigateToPage). Keeps
// character data fresh in the background with no manual "sync" button — the per-
// character 30-min staleness gate (and 6-h assets gate inside the sync) mean this
// rarely actually hits ESI.
let _lastAutoSyncScan = 0;
function autoSyncOnNavigate() {
  const now = Date.now();
  if (now - _lastAutoSyncScan < 60 * 1000) return;   // scan at most once a minute
  _lastAutoSyncScan = now;
  window.eveAPI.getAccounts()
    .then(accounts => { if (accounts && accounts.length) return autoRefreshStaleCharacters(accounts); })
    .catch(() => {});
}


// Latest Jabber broadcast. Deliberately the SAME layout as the director ping
// pop-out (src/html/ping-alert.html): alert badge and sig, a From banner, the
// three-up FC / Formup / Comms row, PAP Type and Doctrine beneath it, the message
// block, then Target and Sig in the footer. Same order, same labels, same
// typography — one ping should not look like two different things depending on
// which window it arrives in. The pop-out's autopilot button and countdown ring
// are the only parts left out: both are actions belonging to a live alert, not
// to a record of one.
const _pingFcPortraitTried = new Set();
let _pingCommsChannels = null;   // configured comms rooms, loaded once per session

// A ping's formup, comms and doctrine are the three things you ACT on, and in the
// pop-out all three are clickable. Same here, through the same IPCs, so the tile
// is not a read-only picture of a window that does something.
async function _pingCommsUrl(commsText) {
  if (!commsText) return null;
  const embedded = String(commsText).match(/https?:\/\/[^\s<>"]+/i);
  if (embedded) return embedded[0].replace(/[.)]+$/, '');
  if (_pingCommsChannels === null) {
    try { _pingCommsChannels = await window.eveAPI.getCommsChannels() || []; }
    catch (_) { _pingCommsChannels = []; }
  }
  const lower = String(commsText).toLowerCase();
  for (const ch of _pingCommsChannels) {
    if (ch.url && (ch.match || []).some(m => lower.includes(String(m).toLowerCase()))) return ch.url;
  }
  return null;
}

// "1DQ1-A - Keepstar" / "1DQ1-A (staging)" → "1DQ1-A". Same split the pop-out uses.
function _pingSystemFromFormup(formup) {
  return String(formup || '').replace(/[​-‏﻿]/g, '')
    .trim().split(/\s+-\s+|\s+\(/)[0].trim();
}

async function _pingSetDestination(btn, formup) {
  const systemName = _pingSystemFromFormup(formup);
  if (!systemName || btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const accounts = await window.eveAPI.getAccounts().catch(() => []);
    if (!accounts.length) throw new Error('No characters — add one first');
    const charId = accounts.find(a => String(a.characterId) === String(selectedCharacterId))?.characterId
                || accounts[0].characterId;
    const systemId = await window.eveAPI.systemIdByName(systemName);
    if (!systemId) throw new Error(`Couldn't find ${systemName}`);
    await window.eveAPI.setAutopilotDestination(charId, systemId);
    btn.textContent = `✓ ${orig}`;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
  } catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Could not set destination.', 'error');
    btn.textContent = orig; btn.disabled = false;
  }
}

// FC portrait, resolved name → id through the SAME cache the Jabber table fills,
// so a name looked up there is not looked up again here.
async function _pingResolveFcPortrait(img, fcName) {
  if (!img || !fcName) return;
  const key = fcName.toLowerCase();
  const cache = (typeof jabberPortraitCache !== 'undefined') ? jabberPortraitCache : null;

  let id = cache ? cache.get(key) : undefined;
  if (id === undefined && !_pingFcPortraitTried.has(key)) {
    _pingFcPortraitTried.add(key);
    try {
      const res = await fetch(Esi.url('/universe/ids'),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([fcName]) });
      if (res.ok) {
        const data = await res.json();
        id = (data.characters || [])[0]?.id || null;
        if (cache) cache.set(key, id);
      }
    } catch (_) { /* the portrait is decoration; the ping reads fine without it */ }
  }
  if (!id) return;
  img.onload = () => img.classList.add('loaded');
  img.src = `https://images.evetech.net/characters/${id}/portrait?size=32`;
}

// Live payloads carry `isDirector`; stored rows carry `is_director`. Both shapes
// reach this widget, so both spellings are honoured.
function _isDirectorPing(row) {
  if (!row) return false;
  return !!(row.is_director || row.isDirector);
}
const _pingSortKey = (row) => (row && (row.eve_timecode || row.received_at)) || '';

function renderDashboardPing(ping) {
  const el = document.getElementById('dashboardPingsContent');
  if (!el) return;

  if (!ping) {
    // Director broadcasts only, so say so — "no pings" would read as a fault
    // when the room has simply been quiet.
    el.innerHTML = '<div class="dashboard-empty">No director pings yet.</div>';
    return;
  }

  const timeStr = ping.eve_timecode || ping.ping_timestamp || ping.received_at || '';
  const fcName  = ping.fc_name || '';

  // PAP type carries the urgency the pop-out conveys through colour, so the value
  // is tinted rather than given a badge the pop-out does not have.
  const papRaw = (ping.pap_type || '').toLowerCase();
  let papCls = '';
  if (papRaw && !papRaw.includes('no pap')) {
    papCls = (papRaw.includes('stratop') || papRaw.includes('strat'))
      ? ' dash-ping-value--stratop' : ' dash-ping-value--cta';
  }

  const field = (label, val, cls = '') => `
    <div class="dash-ping-field">
      <span class="dash-ping-label">${label}</span>
      <span class="dash-ping-value${cls}" title="${escHtml(val || '')}">${escHtml(val || '—')}</span>
    </div>`;

  // The pop-out throws the doctrine URL away; here it becomes the link, with the
  // name beside it, because a doctrine you cannot open is half an instruction.
  const docUrl   = (ping.doctrine || '').match(/https?:\/\/\S+/)?.[0]?.replace(/[.)]+$/, '') || '';
  const docShort = ping.doctrine ? ping.doctrine.replace(/https?:\/\/\S+/g, '').trim() : '';
  const msgBody  = ping.hurf || ping.raw_body || '';

  el.innerHTML = `
    <div class="dash-ping-card">
      <div class="dash-ping-titlebar">
        <div class="dash-ping-alert">
          <span class="dash-ping-dot"></span>${ping.is_director ? 'Director Ping' : 'Ping'}
        </div>
        <div class="dash-ping-sig">${escHtml(ping.sig || 'Broadcast')}</div>
        ${ping.id != null ? `<button class="dash-ping-view-btn" data-ping-id="${ping.id}">View</button>` : ''}
      </div>

      <div class="dash-ping-from-banner">
        <span class="dash-ping-from-label">From</span>
        <span class="dash-ping-from-name">${escHtml(ping.who_pinged || ping.gsol_member || '—')}</span>
        <span class="dash-ping-from-time">${escHtml(timeStr)}</span>
      </div>

      <div class="dash-ping-grid">
        <div class="dash-ping-field">
          <span class="dash-ping-label">FC Name</span>
          <span class="dash-ping-value dash-ping-value--hl" title="${escHtml(fcName)}">
            <img class="dash-ping-fc-portrait" alt=""
                 src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="/>
            <span>${escHtml(fcName || '—')}</span>
          </span>
        </div>
        <div class="dash-ping-field">
          <span class="dash-ping-label">Formup Location</span>
          ${ping.formup_location
            ? `<button class="dash-ping-link" data-formup="${escHtml(ping.formup_location)}"
                       title="Set autopilot destination">${escHtml(ping.formup_location)}</button>`
            : '<span class="dash-ping-value">—</span>'}
        </div>
        <div class="dash-ping-field">
          <span class="dash-ping-label">Comms</span>
          ${ping.comms
            ? `<button class="dash-ping-link dash-ping-link--hl" data-comms="${escHtml(ping.comms)}"
                       title="Open comms">${escHtml(ping.comms)}</button>`
            : '<span class="dash-ping-value">—</span>'}
        </div>
      </div>

      <div class="dash-ping-grid dash-ping-grid--2">
        ${field('PAP Type', ping.pap_type, papCls)}
        <div class="dash-ping-field">
          <span class="dash-ping-label">Doctrine</span>
          ${docUrl
            ? `<button class="dash-ping-link" data-url="${escHtml(docUrl)}"
                       title="${escHtml(docUrl)}">${escHtml(docShort || 'Open doctrine')}</button>`
            : `<span class="dash-ping-value" title="${escHtml(docShort)}">${escHtml(docShort || '—')}</span>`}
        </div>
      </div>

      <div class="dash-ping-msg-block">
        <div class="dash-ping-label">Message</div>
        <div class="dash-ping-msg">${escHtml(msgBody || '—')}</div>
      </div>

      <div class="dash-ping-footer">
        Target: <span class="dash-ping-accent">${escHtml(ping.target_sig || '—')}</span>
        &nbsp;·&nbsp;
        Sig: <span class="dash-ping-accent">${escHtml(ping.sig || '—')}</span>
      </div>
    </div>`;

  _pingResolveFcPortrait(el.querySelector('.dash-ping-fc-portrait'), fcName);

  const formupBtn = el.querySelector('[data-formup]');
  if (formupBtn) formupBtn.addEventListener('click', () => _pingSetDestination(formupBtn, formupBtn.dataset.formup));

  const commsBtn = el.querySelector('[data-comms]');
  if (commsBtn) commsBtn.addEventListener('click', async () => {
    const url = await _pingCommsUrl(commsBtn.dataset.comms);
    if (url) { try { window.eveAPI.openExternalUrl(url); } catch (_) {} }
    else if (typeof showToast === 'function') {
      showToast('No comms link for this room — add one in Settings.', 'info');
    }
  });

  const docBtn = el.querySelector('[data-url]');
  if (docBtn) docBtn.addEventListener('click', () => {
    try { window.eveAPI.openExternalUrl(docBtn.dataset.url); } catch (_) {}
  });

  const viewBtnEl = el.querySelector('.dash-ping-view-btn[data-ping-id]');
  if (viewBtnEl) {
    viewBtnEl.addEventListener('click', () => {
      window.eveAPI.openPingAlert(parseInt(viewBtnEl.dataset.pingId, 10));
    });
  }
}

// ─── Dashboard widget grid (Gridstack) ───────────────────────────────────────
// Every widget is declared once in DASHBOARD_WIDGETS. Gridstack lets the user
// drag, resize, add and remove widgets; the layout (which widgets are shown plus
// their x/y/w/h) persists to localStorage.dashboardGridLayout. Widget *content*
// is filled by loadDashboard()'s render sections, keyed off the inner element ids
// in each widget's `body`.

const DASHBOARD_WIDGETS = {
  // Heights are in 20px row units (see cellHeight). Defaults are tuned to fit each
  // widget's content reasonably; the fine row unit lets you snap them tighter.
  // `icon` is a Google Material Symbol name (rendered with .material-symbols-outlined,
  // like the navbar). UI icons across the app use Material Symbols; EVE in-game art
  // (images.evetech.net) is reserved for actual game items/ships/characters.
  //
  // `pick` turns adding into two steps: choosing the widget opens a list of
  // subjects, and the choice is stored against the new instance before it first
  // paints (see dashWidgetPickMenu / addDashboardWidget). What a widget shows is
  // a property of the widget you added — not a control that has to sit on it
  // forever, eating a row of a tile that is already small. To re-point one,
  // remove it and add another.
  //   heading — the question, shown above the list
  //   empty   — what to say when there is nothing to choose from
  //   options — async () => [{ value, label, icon }]
  //   apply   — (instanceId, value) => persist the choice
  networth: {
    icon: 'account_balance', title: 'NET WORTH',
    w: 4, h: 6, minW: 2, minH: 4,
    body: '<div id="dashboardNetworthSummary"></div>',
  },
  wealthGrowth: {
    icon: 'show_chart', title: 'WEALTH GROWTH',
    w: 5, h: 11, minW: 3, minH: 6,
    body: '<div id="dashboardWealthGrowth"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  wealthByChar: {
    icon: 'groups', title: 'WEALTH BY CHARACTER',
    w: 3, h: 11, minW: 2, minH: 6,
    body: '<div id="dashboardWealthByChar"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  activeJobs: {
    icon: 'precision_manufacturing', title: 'ACTIVE INDUSTRY JOBS',
    w: 5, h: 10, minW: 2, minH: 5,
    body: '<div id="dashboardActiveJobsTable"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  // Same data source and rendering as activeJobs (renderActiveJobsWidget,
  // fetchAllActiveIndustryJobs) — split into its own widget so people who only
  // want their own jobs, and people who also want corp jobs, can each add just
  // what they want instead of getting one merged table. See
  // renderDashboardActiveJobs() for the personal/corp split.
  corpActiveJobs: {
    icon: 'precision_manufacturing', title: 'CORP ACTIVE INDUSTRY JOBS',
    w: 5, h: 10, minW: 2, minH: 5,
    body: '<div id="dashboardCorpActiveJobsTable"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  pi: {
    icon: 'public', title: 'PLANETARY INDUSTRY',
    w: 5, h: 9, minW: 2, minH: 5,
    body: '<div id="dashboardPIWidget"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  walletBalance: {
    icon: 'account_balance_wallet', title: 'WALLET BALANCES',
    w: 4, h: 8, minW: 2, minH: 4,
    body: '<div id="dashboardWalletWidget"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  charWallet: {
    icon: 'account_balance_wallet', title: 'CHARACTER WALLET', multi: true,  // one per character
    // minH 5, not 4: at four rows the body is ~20px and the card is cut in half
    // however hard the responsive rules compact it. A floor that fits the
    // smallest useful form of the content beats a floor that allows a broken one.
    w: 3, h: 6, minW: 2, minH: 5,
    body: '<div class="dashboard-widget-loading">Loading…</div>',
    pick: {
      heading: 'Which character?',
      empty:   'Add a character first.',
      options: async () => {
        const accounts = await window.eveAPI.getAccounts().catch(() => []);
        return (Array.isArray(accounts) ? accounts : []).map(a => ({
          value: String(a.characterId),
          label: a.characterName || `Char ${a.characterId}`,
          icon:  'person',
        }));
      },
      apply: (instId, value) => _setCharWallet(instId, value),
    },
  },
  skillQueue: {
    icon: 'school', title: 'SKILL QUEUE',
    w: 4, h: 10, minW: 2, minH: 5,
    body: '<div id="dashboardSkillQueueWidget"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  marketQuicklook: {
    icon: 'storefront', title: 'MARKET QUICKLOOK',
    w: 4, h: 10, minW: 2, minH: 5,
    body: '<div id="dashboardMarketWidget"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  marketOrders: {
    icon: 'receipt_long', title: 'ACTIVE MARKET ORDERS',
    w: 5, h: 10, minW: 2, minH: 5,
    body: '<div id="dashboardMarketOrders"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  jobWatch: {
    icon: 'visibility', title: 'JOB WATCH', multi: true,   // addable many times, one per job
    w: 3, h: 8, minW: 2, minH: 6,
    body: '<div class="dashboard-widget-loading">Loading…</div>',
    pick: {
      heading: 'Which job?',
      empty:   'No active industry jobs to watch.',
      // Same shared job list the Active Jobs tables use, in the same
      // soonest-done-first order the widget renders in — so the list you pick
      // from matches what you are looking at.
      options: async () => {
        const accounts = await window.eveAPI.getAccounts().catch(() => []);
        if (!Array.isArray(accounts) || !accounts.length) return [];
        const shared = await _activeJobsShared(accounts);
        const active = shared.slice().sort((a, b) =>
          (new Date(a.end_date) - new Date(b.end_date)) || (Number(a.job_id) - Number(b.job_id)));
        if (!active.length) return [];
        const typeNames = await _resolveTypeNames(
          [...new Set(active.map(j => j.product_type_id || j.blueprint_type_id).filter(Boolean))]);
        const byChar = Object.fromEntries(accounts.map(a => [String(a.characterId), a.characterName]));
        return active.map(j => {
          const tid  = j.product_type_id || j.blueprint_type_id;
          const what = (tid && typeNames[tid]) || (tid ? `Type ${tid}` : 'Job');
          const who  = byChar[String(j.character_id)] || j._charName || '';
          return {
            value: String(j.job_id),
            label: `${j.is_corp_job ? '[CORP] ' : ''}${what}${who ? ` · ${who}` : ''}`,
            icon:  'precision_manufacturing',
          };
        });
      },
      apply: (instId, value) => _setJobWatch(instId, value),
    },
  },
  // Most recent Jabber broadcast, rendered by renderDashboardPing(). Reads the
  // live in-memory jabberMessages first and falls back to the stored history, then
  // repaints on every incoming 'jabber-message'. The container lived in a page
  // HTML file that was deleted in b73eb8e, which silently stopped the tile from
  // painting even though the renderer and its .dash-ping-* styles survived — it is
  // declared here now so it cannot be orphaned by a template cleanup again.
  latestPing: {
    // Taller than it was: the card now carries the pop-out's full layout (badge,
    // From banner, two field rows, message, footer), which measures ~231px at
    // this width — at the old h:8 the footer simply fell off the bottom.
    // Existing saved layouts keep their own size, which is what the shedding
    // ladder in dashboard.css is for.
    icon: 'campaign', title: 'LATEST PING',
    w: 5, h: 15, minW: 3, minH: 6,
    body: '<div id="dashboardPingsContent"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  // GoonFleet-only: live Beehive beacon status from the room MOTD. Gated out of the
  // "add widget" menu for non-Goons (see _refreshAddWidgetMenu / _beehiveGoon).
  beehive: {
    icon: 'hive', title: 'BEEHIVE STATUS',
    w: 4, h: 5, minW: 2, minH: 4,
    body: '<div id="dashboardBeehiveWidget"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  // Inbound hostiles from the intel channels (Fleet Commander -> Early Warning).
  // Read-only here: the watcher is configured on that page and keeps running
  // whether or not this widget is on the grid.
  earlyWarning: {
    icon: 'radar', title: 'EARLY WARNING',
    // Taller than it looks like it needs: at h:8 only two contacts fitted, and
    // a warning panel that hides the third-nearest hostile is worse than one
    // that takes a little more grid. Wider, too, since the rows became the same
    // six columns the Early Warning page uses — at w:4 the pilot name, which is
    // what identifies the contact, was the first thing to be clipped.
    // Existing saved layouts keep their own size; this is the default for a new
    // grid or after a reset.
    w: 5, h: 11, minW: 3, minH: 5,
    body: '<div id="dashboardEarlyWarning"><div class="dashboard-widget-loading">Loading…</div></div>',
  },
  // Scrolling ticker of your most valuable kills over the last 90 days, from the
  // same cached zKillboard feed the Killboard page uses. Full grid width by
  // default because it is a marquee — a narrow one loops too fast to read.
  killTicker: {
    icon: 'local_fire_department', title: 'TOP KILLS · 90 DAYS', multi: true,
    w: 12, h: 10, minW: 4, minH: 6,
    body: '<div class="dashboard-widget-loading">Loading…</div>',
    pick: {
      heading: 'Whose kills?',
      empty:   'Add a character first.',
      options: async () => {
        const accounts = await window.eveAPI.getAccounts().catch(() => []);
        if (!Array.isArray(accounts) || !accounts.length) return [];
        // "All characters" only when there is more than one to combine.
        return (accounts.length > 1 ? [{ value: 'all', label: 'All characters', icon: 'groups' }] : [])
          .concat(accounts.map(a => ({
            value: String(a.characterId),
            label: a.characterName || `Char ${a.characterId}`,
            icon:  'person',
          })));
      },
      apply: (instId, value) => _setKillScope(instId, value),
    },
  },
  // NOTE: the incursion alert is intentionally NOT a grid widget — it is an
  // always-on banner pinned above the grid (#allianceIncursionAlert in
  // pageLoader.js) that only appears when an incursion is active.
};

// Default layout applied on first run (or after a reset). Widgets not listed
// here start hidden and can be added from the “+ Add Widget” menu.
const DEFAULT_DASH_LAYOUT = [
  { id: 'networth',     x: 0, y: 0,  w: 4, h: 6  },
  { id: 'wealthByChar', x: 0, y: 6,  w: 4, h: 11 },
  { id: 'wealthGrowth', x: 4, y: 0,  w: 5, h: 11 },
  { id: 'pi',           x: 9, y: 0,  w: 3, h: 11 },
  { id: 'activeJobs',   x: 4, y: 11, w: 8, h: 10 },
];

let _dashGrid = null;   // GridStack instance (null until initialised this session)

// The widget id for a Gridstack node — prefer the live attribute, fall back to
// the node's parsed id (Gridstack copies gs-id → node.id on init).
function _nodeWidgetId(n) {
  return (n && n.el && n.el.getAttribute('gs-id')) || (n && n.id) || null;
}

// A widget marked `multi` can have several instances on the grid at once. Its
// instance id is "base~uid" so the gs-id / DOM ids stay unique; _widgetBase strips
// the suffix back to the registry key.
function _widgetBase(id)    { return String(id).split('~')[0]; }
function _widgetDef(id)     { return DASHBOARD_WIDGETS[_widgetBase(id)] || null; }
function _newInstanceId(base) { return `${base}~${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

// Build one .grid-stack-item DOM element for a widget id + position/size.
function _makeDashItemEl({ id, x, y, w, h }) {
  const def = _widgetDef(id);
  const el  = document.createElement('div');
  el.className = 'grid-stack-item';
  el.setAttribute('gs-id', id);
  if (Number.isFinite(x)) el.setAttribute('gs-x', x);
  if (Number.isFinite(y)) el.setAttribute('gs-y', y);
  el.setAttribute('gs-w', w || def.w);
  el.setAttribute('gs-h', h || def.h);
  if (def.minW) el.setAttribute('gs-min-w', def.minW);
  if (def.minH) el.setAttribute('gs-min-h', def.minH);
  el.innerHTML = `
    <div class="grid-stack-item-content">
      <div class="dashboard-panel dnd-panel" data-widget-id="${id}" data-widget-base="${_widgetBase(id)}">
        <div class="dashboard-panel-title dnd-handle">
          ${def.icon ? `<span class="material-symbols-outlined dashboard-widget-icon">${def.icon}</span>` : ''}
          <span class="dashboard-widget-title-text">${def.title}</span>
          <span class="dnd-grip">⠿</span>
          <button class="dashboard-widget-popout" title="Pop out as floating widget"
                  onclick="popOutDashboardWidget('${id}')">
            <span class="material-symbols-outlined">open_in_new</span>
          </button>
          <button class="dashboard-widget-remove" title="Remove widget"
                  onclick="removeDashboardWidget('${id}')">✕</button>
        </div>
        <div class="dashboard-widget-body">${def.body}</div>
      </div>
    </div>`;
  return el;
}

// Bump when the grid metric (cellHeight) or default sizing changes, so a layout
// saved against the old scale is discarded instead of rendering at the wrong size.
const DASH_LAYOUT_VERSION = 2;

// Read the saved layout, falling back to the default. Filters out unknown ids
// (e.g. a widget renamed in a later version) so a stale entry never breaks init.
// A layout from an older schema version is ignored (auto-reset to the default).
function _loadDashLayout() {
  // Beehive is GoonFleet-specific — it reads one alliance's room MOTD. The
  // add-widget menu already hides it from non-Goons, but that filter does not
  // touch a layout that already contains it, so it still renders. Drop it from
  // the DEMO layout: these screenshots are published, and a marketing image
  // carrying one alliance's internal beacon state is neither generic nor
  // something that alliance agreed to.
  const strip = (items) => ((window.eveAPI && window.eveAPI.isDemo) ? items.filter((it) => _widgetBase(it.id) !== 'beehive') : items);
  try {
    const saved = JSON.parse(localStorage.getItem('dashboardGridLayout') || 'null');
    if (saved && saved.v === DASH_LAYOUT_VERSION && Array.isArray(saved.items) && saved.items.length) {
      const valid = saved.items.filter(it => it && _widgetDef(it.id));
      if (valid.length) return strip(valid);
    }
  } catch (_) {}
  return strip(DEFAULT_DASH_LAYOUT.map(it => ({ ...it })));
}

function _saveDashLayout() {
  if (!_dashGrid) return;
  const items = _dashGrid.engine.nodes
    .map(n => {
      const id = _nodeWidgetId(n);
      return id ? { id, x: n.x, y: n.y, w: n.w, h: n.h } : null;
    })
    .filter(Boolean);
  try { localStorage.setItem('dashboardGridLayout', JSON.stringify({ v: DASH_LAYOUT_VERSION, items })); } catch (_) {}
  _refreshAddWidgetMenu();
}

// Initialise the Gridstack instance + its widgets from the saved layout.
// Idempotent: safe to call on every loadDashboard(); only builds once per session.
function initDashboardGrid() {
  const gridEl = document.getElementById('dashboardGrid');
  if (!gridEl || _dashGrid) return;
  if (typeof GridStack === 'undefined') {
    console.warn('[dashboard] Gridstack failed to load — widget grid disabled.');
    return;
  }

  // Build the item elements first so GridStack.init() picks them up from the DOM.
  gridEl.innerHTML = '';
  _loadDashLayout().forEach(item => gridEl.appendChild(_makeDashItemEl(item)));

  _dashGrid = GridStack.init({
    cellHeight: 20,   // small row unit → fine (20px) resize steps so widgets snap tight
    margin: 4,
    float: false,   // gravity-pack widgets to the top — no empty rows / top gap
    handle: '.dnd-handle',
    resizable: { handles: 'e, se, s, sw, w' },
    draggable: { handle: '.dnd-handle', cancel: '.dashboard-widget-remove,.dashboard-widget-popout' },
  }, gridEl);

  _dashGrid.on('change',  _saveDashLayout);
  _dashGrid.on('added',   _saveDashLayout);
  _dashGrid.on('removed', _saveDashLayout);

  _initWidgetPopouts();   // restore stranded pop-outs + bind IPC (once)
  _refreshAddWidgetMenu();
  // Resolve Goon status async, then re-refresh so the Beehive widget appears in the
  // "add widget" menu only for Goons.
  _checkBeehiveGoon().then(() => _refreshAddWidgetMenu());
}

// Which widget ids are currently on the grid.
function _activeWidgetIds() {
  if (!_dashGrid) return [];
  return _dashGrid.engine.nodes.map(_nodeWidgetId).filter(Boolean);
}

// Add a widget to the grid, then refetch + repopulate so its data renders. `id` is
// a registry base key (from the menu). `multi` widgets get a fresh instance id so
// several can coexist; single widgets are a no-op if already present.
function addDashboardWidget(id, config = null) {
  const def = DASHBOARD_WIDGETS[id];
  if (!_dashGrid || !def) return;
  if (!def.multi && _activeWidgetIds().some(a => _widgetBase(a) === id)) { hideAddWidgetMenu(); return; }
  const instId = def.multi ? _newInstanceId(id) : id;
  // The choice made in the add menu is stored against the new instance BEFORE
  // the widget renders, so its first paint already shows the right thing.
  if (config && config.value != null && typeof def.pick?.apply === 'function') {
    def.pick.apply(instId, config.value);
  }
  const el = _makeDashItemEl({ id: instId });
  document.getElementById('dashboardGrid').appendChild(el);
  _dashGrid.makeWidget(el);
  _saveDashLayout();
  hideAddWidgetMenu();
  loadDashboard();                                 // refetch + fill the new widget
}

function removeDashboardWidget(id) {
  if (!_dashGrid) return;
  const node = _dashGrid.engine.nodes.find(n => _nodeWidgetId(n) === id);
  if (node) _dashGrid.removeWidget(node.el);
  if (_widgetBase(id) === 'jobWatch')   _setJobWatch(id, null);     // drop its saved selection
  if (_widgetBase(id) === 'charWallet') _setCharWallet(id, null);   // drop its saved character
  if (_widgetBase(id) === 'killTicker') _setKillScope(id, null);    // drop its saved scope
  _saveDashLayout();
}

function resetDashboardLayout() {
  try { localStorage.removeItem('dashboardGridLayout'); } catch (_) {}
  if (_dashGrid) { _dashGrid.destroy(false); _dashGrid = null; }  // keep the grid DOM node
  initDashboardGrid();
  loadDashboard();
}

// ─── Widget pop-outs (floating desktop widgets) ───────────────────────────────
// Popping a widget out moves its live .dashboard-panel into a hidden off-screen
// host so loadDashboard() and the live refreshers keep filling it, then opens a
// small glass BrowserWindow (main.js) that mirrors the widget's HTML. Canvas
// charts are snapshotted to PNG for the mirror. Closing the popout (its pop-in
// button or the OS close) restores the widget to the grid at its old spot.

const POPPED_KEY = 'dashboardPoppedWidgets';

function _getPopped() {
  try { return JSON.parse(localStorage.getItem(POPPED_KEY) || '{}') || {}; }
  catch (_) { return {}; }
}
function _setPopped(map) {
  try { localStorage.setItem(POPPED_KEY, JSON.stringify(map)); } catch (_) {}
}

// Hidden live host — off-screen but laid out (fixed width, not display:none)
// so charts and container queries still size correctly.
function _getPopoutHost() {
  let host = document.getElementById('dashPopoutHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'dashPopoutHost';
    host.style.cssText =
      'position:fixed; left:-10000px; top:0; width:440px; opacity:0; pointer-events:none; z-index:-1;';
    document.body.appendChild(host);
  }
  return host;
}

function _popHolder(id) {
  const esc = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
  return _getPopoutHost().querySelector(`[data-pop-id="${esc}"]`);
}

// Mirror HTML for a popped widget: body content with live canvases swapped for
// PNG snapshots (canvas pixels don't survive innerHTML serialisation).
function _widgetMirrorHtml(panel) {
  const body = panel?.querySelector('.dashboard-widget-body');
  if (!body) return '';
  const clone = body.cloneNode(true);
  const live  = body.querySelectorAll('canvas');
  clone.querySelectorAll('canvas').forEach((c, i) => {
    try {
      const img = document.createElement('img');
      img.src = live[i].toDataURL('image/png');
      img.style.cssText = 'width:100%; height:auto; display:block;';
      c.replaceWith(img);
    } catch (_) { c.remove(); }
  });
  return clone.innerHTML;
}

function _pushWidgetContent(id) {
  const holder = _popHolder(id);
  const def    = _widgetDef(id);
  if (!holder || !def) return;
  const html = _widgetMirrorHtml(holder.querySelector('.dashboard-panel'));
  window.eveAPI?.widgetPopoutContent?.({ id, title: def.title, html })?.catch?.(() => {});
}

function _pushAllPopped() {
  Object.keys(_getPopped()).forEach(_pushWidgetContent);
}

// Observer catches normal DOM re-renders; the slow timer catches canvas-only
// repaints (Chart.js draws without touching the DOM).
let _popObserver = null;
let _popTimer    = null;
function _ensurePopoutPlumbing() {
  if (!_popObserver) {
    _popObserver = new MutationObserver(() => {
      clearTimeout(_popObserver._t);
      _popObserver._t = setTimeout(_pushAllPopped, 250);
    });
    _popObserver.observe(_getPopoutHost(), { childList: true, subtree: true, characterData: true });
  }
  if (!_popTimer) _popTimer = setInterval(_pushAllPopped, 30_000);
}

async function popOutDashboardWidget(id) {
  const def = _widgetDef(id);
  if (!def || !_dashGrid) return;
  const node = _dashGrid.engine.nodes.find(n => _nodeWidgetId(n) === id);
  if (!node) return;

  // Capture px size + grid spot BEFORE detaching
  const rect  = node.el.getBoundingClientRect();
  const spot  = { x: node.x, y: node.y, w: node.w, h: node.h };
  const panel = node.el.querySelector('.dashboard-panel');
  if (!panel) return;

  // Move (not clone) the live panel so renderers keep finding it by id /
  // data-widget-base and chart instances stay alive.
  const holder = document.createElement('div');
  holder.dataset.popId = id;
  holder.appendChild(panel);
  _getPopoutHost().appendChild(holder);

  const popped = _getPopped();
  popped[id] = spot;
  _setPopped(popped);

  _dashGrid.removeWidget(node.el);
  _saveDashLayout();
  _ensurePopoutPlumbing();

  try {
    await window.eveAPI?.widgetPopoutOpen?.({
      id, title: def.title, w: Math.round(rect.width), h: Math.round(rect.height),
    });
  } catch (_) { /* window failed — pop straight back in */ }
  _pushWidgetContent(id);
}

// Return a popped widget to the grid (popout closed by button or OS ✕).
// skipLoad is used during startup restoration, where the caller's own
// loadDashboard() pass will fill the widgets.
function _popInDashboardWidget(id, skipLoad = false) {
  const popped = _getPopped();
  const spot   = popped[id] || null;
  delete popped[id];
  _setPopped(popped);

  const holder = _popHolder(id);
  if (!_dashGrid || !_widgetDef(id))    { holder?.remove(); return; }
  if (_activeWidgetIds().includes(id))  { holder?.remove(); return; }  // already back

  const el = _makeDashItemEl({ id, ...(spot || {}) });
  // Keep the live panel (its state and charts) instead of the fresh skeleton
  const livePanel = holder?.querySelector('.dashboard-panel');
  if (livePanel) el.querySelector('.dashboard-panel')?.replaceWith(livePanel);
  document.getElementById('dashboardGrid')?.appendChild(el);
  _dashGrid.makeWidget(el);
  holder?.remove();
  _saveDashLayout();
  if (!livePanel && !skipLoad) loadDashboard();   // fresh skeleton needs a data fill
}

// Register IPC listeners once, and restore widgets that were still popped out
// when the app last quit (popout windows don't survive a restart).
let _popBound = false;
function _initWidgetPopouts() {
  if (!_popBound) {
    _popBound = true;
    window.eveAPI?.onWidgetPoppedIn?.((id) => _popInDashboardWidget(id));
    window.eveAPI?.onWidgetPopoutReady?.((id) => _pushWidgetContent(id));
  }
  Object.keys(_getPopped()).forEach(id => _popInDashboardWidget(id, true));
}

// ── “+ Add Widget” dropdown menu ─────────────────────────────────────────────
function _refreshAddWidgetMenu() {
  const menu = document.getElementById('dashboardAddWidgetMenu');
  if (!menu) return;
  const activeBases = _activeWidgetIds().map(_widgetBase);
  // `multi` widgets stay addable forever; single widgets drop out once placed.
  const addable = Object.keys(DASHBOARD_WIDGETS)
    .filter(key => DASHBOARD_WIDGETS[key].multi || !activeBases.includes(key))
    .filter(key => key !== 'beehive' || _beehiveGoon);   // Beehive is Goon-only
  menu.innerHTML = addable.length
    ? addable.map(key => {
        const def = DASHBOARD_WIDGETS[key];
        // A `pick` widget opens a second step instead of adding immediately —
        // the choice belongs to the instance you are about to create.
        const action = def.pick ? `dashWidgetPickMenu('${key}', event)` : `addDashboardWidget('${key}')`;
        return `<button class="dashboard-add-item" onclick="${action}">`
             + `${def.icon ? `<span class="material-symbols-outlined">${def.icon}</span>` : ''}`
             + `<span>${def.title}${def.multi ? ' <span class="dashboard-add-plus">+</span>' : ''}</span></button>`;
      }).join('')
    : '<div class="dashboard-add-empty">All widgets added.</div>';
}

// Second step of adding a `pick` widget: choose its subject. Replaces the menu's
// contents rather than opening a nested popup, so there is one thing on screen
// and the outside-click handler that closes the menu still applies.
async function dashWidgetPickMenu(key, e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('dashboardAddWidgetMenu');
  const def  = DASHBOARD_WIDGETS[key];
  if (!menu || !def || !def.pick) return;

  menu.innerHTML = '<div class="dashboard-add-empty">Loading…</div>';
  let options = [];
  try {
    options = await def.pick.options();
  } catch (err) {
    console.warn('[dashboard] widget picker failed:', err?.message || err);
    menu.innerHTML = '<div class="dashboard-add-empty">Could not load the list — try again.</div>';
    return;
  }
  if (!options.length) {
    menu.innerHTML = `<div class="dashboard-add-empty">${escHtml(def.pick.empty || 'Nothing to pick.')}</div>`;
    return;
  }

  // Built as DOM, not innerHTML: option labels carry character and item names,
  // which have no business being parsed as markup or squeezed into an inline
  // onclick handler.
  menu.innerHTML = `<div class="dashboard-add-heading">${escHtml(def.pick.heading)}</div>`;
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.className = 'dashboard-add-item';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = opt.icon || 'chevron_right';
    const label = document.createElement('span');
    label.textContent = opt.label;
    btn.append(icon, label);
    btn.title = opt.label;
    btn.addEventListener('click', () => addDashboardWidget(key, { value: opt.value }));
    menu.appendChild(btn);
  }
}

function toggleAddWidgetMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('dashboardAddWidgetMenu');
  if (!menu) return;
  const show = menu.style.display === 'none';
  _refreshAddWidgetMenu();
  menu.style.display = show ? 'block' : 'none';
  if (show) {
    // Close on the next outside click.
    setTimeout(() => document.addEventListener('click', hideAddWidgetMenu, { once: true }), 0);
  }
}

function hideAddWidgetMenu() {
  const menu = document.getElementById('dashboardAddWidgetMenu');
  if (menu) menu.style.display = 'none';
}

// ── Beehive status widget (GoonFleet only) ────────────────────────────────────
// Live beacon status read from the Beehive room MOTD (see jabber_ipc.js). Shown
// only for Goons. RED means an actual MOTD said stand down; no MOTD (disconnected,
// room not joined) renders as UNKNOWN — never as a false "down".
let _beehiveGoon     = false;
let _beehiveLast     = { status: 'unknown', text: '', changedAt: null };
let _beehiveSubBound = false;

// Goon detection: the Jabber service or forum URL already stored in the app config.
async function _checkBeehiveGoon() {
  try {
    const cfg = await window.eveAPI.getAppConfig();
    const a   = (cfg && (cfg.app || cfg)) || {};
    const jab   = ((a.jabber && a.jabber.service) || '').toLowerCase();
    const forum = (((a.forum && a.forum.url) || (a.calendar && a.calendar.forumBaseUrl)) || '').toLowerCase();
    _beehiveGoon = jab.includes('goonfleet') || forum.includes('goonfleet');
  } catch (_) { _beehiveGoon = false; }
  return _beehiveGoon;
}

// --signal-*, NOT --pal-*. This is a traffic light, and it used to be wired to
// the themeable palette — so recolouring "losses" recoloured STAND DOWN with it,
// and the one indicator that has to be unmistakable mid-op could end up rendered
// in whatever hue somebody picked for a chart. See src/styles/signals.css.
//
// The label is doing as much work as the colour, deliberately: red/green is the
// pair most commonly confused, so the state is always spelled out in words too.
function _beehiveMeta(status) {
  switch (status) {
    case 'green':  return { color: 'var(--signal-go)',   label: 'RUNNING',    sub: 'Up and running — good to go' };
    case 'yellow': return { color: 'var(--signal-hold)', label: 'HOLDING',    sub: 'Holding pattern — finishing active beacons' };
    case 'red':    return { color: 'var(--signal-stop)', label: 'STAND DOWN', sub: 'Beacons are not running — stand down' };
    default:       return { color: 'var(--text-3)',      label: 'UNKNOWN',    sub: 'No live MOTD — assume stand down until confirmed' };
  }
}

function renderBeehiveWidget() {
  const el = document.getElementById('dashboardBeehiveWidget');
  if (!el) return;
  const st     = _beehiveLast || { status: 'unknown' };
  const status = st.status || 'unknown';
  const m      = _beehiveMeta(status);
  const when   = st.changedAt ? new Date(st.changedAt).toLocaleString() : '—';
  const esc    = (typeof escHtml === 'function') ? escHtml : (s => s);
  el.innerHTML = `
    <div class="beehive-widget beehive-${status}">
      <span class="beehive-light" style="background:${m.color};box-shadow:0 0 14px ${m.color},0 0 4px ${m.color};"></span>
      <div class="beehive-info">
        <div class="beehive-label" style="color:${m.color};">${m.label}</div>
        <div class="beehive-sub">${esc(m.sub)}</div>
        <div class="beehive-updated">MOTD updated ${esc(when)}</div>
      </div>
    </div>
    <pre class="beehive-motd" title="Live Beehive MOTD">${esc((st.text || '').trim() || 'Waiting for Beehive MOTD… (connect Jabber)')}</pre>`;
}

function _beehiveRedAlert() {
  const el = document.getElementById('dashboardBeehiveWidget');
  if (el) { el.classList.remove('beehive-alert'); void el.offsetWidth; el.classList.add('beehive-alert'); }
  if (typeof showToast === 'function') showToast('⚠ BEEHIVE IS RED — stand down beacons.', 'error');
}

// Fill the widget from the cached status, then subscribe (once) to live MOTD updates.
async function initBeehiveWidget() {
  if (!_beehiveSubBound) {
    _beehiveSubBound = true;
    window.eveAPI.on('beehive-status', (payload) => {
      const prev = _beehiveLast && _beehiveLast.status;
      if (payload) _beehiveLast = payload;
      renderBeehiveWidget();
      // Alarm only on a real running/holding → red transition, not on disconnects
      // (→ unknown) or on first learning the state.
      if (_beehiveLast.status === 'red' && (prev === 'green' || prev === 'yellow')) _beehiveRedAlert();
    });
  }
  try { const s = await window.eveAPI.getBeehiveStatus(); if (s) _beehiveLast = s; } catch (_) {}
  renderBeehiveWidget();
}

// ── Early Warning widget ──────────────────────────────────────────────────────
// A read-only view of the intel engine's live contacts. The engine itself runs
// in the main process and is configured on Fleet Commander -> Early Warning; if
// it isn't running, this says so and points there rather than pretending to be
// quiet, which would read as "no hostiles" instead of "not looking".
//
// The floating pop-out (src/html/intel-widget.html) exists for flying over the
// game; this is for when you're already in the app.
const EW_POLL_MS = 3000;
let _ewTimer = null;
let _ewAlertBound = false;

function renderEarlyWarningWidget(contacts, status) {
  const el = document.getElementById('dashboardEarlyWarning');
  if (!el) return;

  if (!status || !status.running) {
    el.innerHTML = `<div class="ew-idle">
      <span class="material-symbols-outlined">radar</span>
      <div class="ew-idle-text">
        Not watching.
        <span class="ew-idle-hint">Pick your intel channels and who to watch.</span>
      </div>
      <button class="pi-dash-link-btn ew-idle-btn">SET UP ›</button>
    </div>`;
    el.querySelector('.ew-idle-btn')?.addEventListener('click', _ewNavToSetup);
    return;
  }
  // Pilot tracks carry a heading; bare system reports only earn a row up close.
  const rows = (contacts || []).filter(c => c.kind === 'pilot' || c.jumps <= 3).slice(0, 12);
  const n = (status.origins || []).length;
  const head = `<div class="ew-head">${n ? `${n} character${n === 1 ? '' : 's'} · ${status.reach} systems`
                                        : 'NO POSITION MONITORED'}</div>`;
  if (!rows.length) {
    el.innerHTML = head + '<div class="ew-clear">No contacts in range.</div>';
    return;
  }
  // The SAME row builder the Early Warning page and the floating pop-out use
  // (src/shared/intel-row.js). This widget kept its own two-line markup and its
  // own copies of the urgency, band and ETA helpers, and it duly drifted: the
  // page moved to columns and this stayed behind showing a different shape for
  // the same data. Compact mode drops REGION, which is what a dashboard tile has
  // room for. The pop-out is served pre-rendered HTML and already loads fc.css,
  // so it inherits this automatically.
  el.innerHTML = head + IntelRow.headerHtml({ compact: true })
    + rows.map(c => IntelRow.rowHtml(c, { compact: true, relative: true })).join('');
}

// Straight to the tab, not just the page. navigateFcTab() has to run AFTER
// navigateToPage('fc') — the FC page builds its tab content on entry and would
// otherwise overwrite the tab we just selected with the remembered one.
function _ewNavToSetup() {
  if (typeof navigateToPage === 'function') navigateToPage('fc');
  // A frame later, once initFcPage() has restored its own last tab.
  setTimeout(() => {
    if (typeof navigateFcTab === 'function') navigateFcTab('intel');
  }, 0);
}

async function _ewTick() {
  // Stop polling once the widget is gone (removed from the grid, or the whole
  // dashboard torn down) — an orphaned 3s timer would run for the session.
  if (!document.getElementById('dashboardEarlyWarning')) {
    if (_ewTimer) { clearInterval(_ewTimer); _ewTimer = null; }
    return;
  }
  try {
    const [contacts, status] = await Promise.all([
      window.eveAPI.intelContacts(),
      window.eveAPI.intelStatus(),
    ]);
    renderEarlyWarningWidget(contacts, status);
  } catch (_) { /* engine not built yet; the next tick retries */ }
}

function initEarlyWarningWidget() {
  if (!_ewAlertBound) {
    _ewAlertBound = true;
    // Alerts are pushed, so the widget doesn't wait up to 3s to show one.
    window.eveAPI.on('intel-alert', () => _ewTick());
  }
  if (_ewTimer) clearInterval(_ewTimer);
  _ewTick();
  _ewTimer = setInterval(_ewTick, EW_POLL_MS);
}

// Personal + corporation active jobs (active / ready / paused) for every
// account, deduped by job_id. Shared by the Active Industry Jobs widget, the
// Job Watch widget, and the Industry page's Active Jobs tab (blueprints.js).
// Corp jobs — where the token's scope and the in-game Factory Manager role
// allow; the main process returns [] otherwise, so no-access accounts just skip
// — are tagged is_corp_job and attributed to their installer, falling back to
// the resolved installer name for corp members who aren't local accounts. A job
// a character installed for their corp appears in BOTH feeds; the personal copy
// wins so attribution stays first-person.
// One shared fan-out for the active job list.
//
// fetchAllActiveIndustryJobs walks the roster SERIALLY and sleeps 80ms between
// characters on purpose (ESI's error budget is shared — see the note in
// src/locator.js), then walks it a second time for corp jobs. On a 17-pilot
// roster that is ~34 serial round-trips and ~1.4s of deliberate spacing.
//
// It had TWO independent callers per dashboard load — the Active Jobs tables and
// every Job Watch instance — so all of that ran twice, which is most of why those
// tiles were the last to arrive. They now share one promise. The window is short
// because the countdown ticker re-renders from the same list; refreshes that must
// see new data call _invalidateSharedJobs() first rather than lengthening it.
let _jobsShared   = null;
let _jobsSharedAt = 0;
let _jobsSubs     = [];
const JOBS_SHARE_MS = 45_000;

// onProgress subscribers are fanned out from the ONE underlying walk, so both the
// Active Jobs tables and Job Watch can paint as characters land without either of
// them starting a second fan-out. A subscriber that arrives after the walk has
// already finished simply gets the final list off the shared promise.
function _activeJobsShared(accounts, onProgress) {
  if (onProgress) _jobsSubs.push(onProgress);
  if (_jobsShared && (Date.now() - _jobsSharedAt) < JOBS_SHARE_MS) return _jobsShared;

  _jobsSharedAt = Date.now();
  _jobsShared = fetchAllActiveIndustryJobs(accounts, (partial) => {
    for (const fn of _jobsSubs) {
      try { fn(partial); } catch (e) { console.warn('[dashboard] job subscriber failed:', e?.message || e); }
    }
  })
    .then(v => { _jobsSubs = []; return v; })
    .catch(e => { _jobsShared = null; _jobsSubs = []; throw e; });   // never cache a failure
  return _jobsShared;
}
function _invalidateSharedJobs() { _jobsShared = null; _jobsSharedAt = 0; _jobsSubs = []; }

// onProgress, when given, is called with the jobs gathered SO FAR after each
// character resolves. The walk is serial and paced, so on a large roster the last
// character lands well over a second after the first — waiting for all of them
// before painting anything is what made this widget feel dead on arrival. Callers
// that can render a partial list get it as it grows.
async function fetchAllActiveIndustryJobs(accounts, onProgress) {
  const byId = new Map();
  const accountMap = Object.fromEntries(accounts.map(a => [String(a.characterId), a]));
  const RUNNING = (j) => j.status === 'active' || j.status === 'ready' || j.status === 'paused';
  const emit = () => {
    if (!onProgress) return;
    try { onProgress([...byId.values()].filter(RUNNING)); }
    catch (e) { console.warn('[dashboard] job progress render failed:', e?.message || e); }
  };

  for (const acc of accounts) {
    try {
      const list = await window.eveAPI.getCharacterActiveJobs(acc.characterId);
      (Array.isArray(list) ? list : []).forEach(j => byId.set(j.job_id, {
        ...j,
        character_id: acc.characterId,
        _charName:    acc.characterName || `Char ${acc.characterId}`,
      }));
    } catch (_) {}
    emit();
    await new Promise(r => setTimeout(r, 80));
  }
  for (const acc of accounts) {
    let list = [];
    try { list = await window.eveAPI.getCorpActiveJobs(acc.characterId) || []; } catch (_) {}
    for (const j of (Array.isArray(list) ? list : [])) {
      if (byId.has(j.job_id)) continue;   // personal copy already listed
      const installer = String(j.installer_id || '');
      byId.set(j.job_id, {
        ...j,
        character_id: j.installer_id || acc.characterId,
        _charName:    accountMap[installer]?.characterName || j.installer_name || 'Corp member',
      });
    }
    emit();
    await new Promise(r => setTimeout(r, 80));
  }
  return [...byId.values()].filter(RUNNING);
}

// Fetch + render the Active Industry Jobs widget(s) — personal jobs in
// #dashboardActiveJobsTable, corp jobs (job.is_corp_job) in the separate
// #dashboardCorpActiveJobsTable, both widgets addable independently (see
// DASHBOARD_WIDGETS.activeJobs / .corpActiveJobs). One shared fetch either
// way — fetchAllActiveIndustryJobs already merges personal + corp jobs across
// all characters, so splitting the result is just a filter, not a second
// ESI round trip. Extracted so it can be re-run after a background sync warms
// the tokens (see refreshDashboardLiveWidgets).
async function renderDashboardActiveJobs(accounts) {
  const container     = document.getElementById('dashboardActiveJobsTable');
  const corpContainer = document.getElementById('dashboardCorpActiveJobsTable');
  if (!container && !corpContainer) return;

  // Both tables come from ONE fan-out that deliberately spaces its per-character
  // ESI reads, so this is the longest wait on the dashboard. Paint each table's
  // last-known state first, then let the shared fetch replace both.
  const [hadJobs, hadCorpJobs] = await Promise.all([
    _paintSnapshot('dash_snap_active_jobs', container),
    _paintSnapshot('dash_snap_corp_active_jobs', corpContainer),
  ]);

  const paint = async (jobs) => {
    if (container) {
      await renderActiveJobsWidget(container, jobs.filter(j => !j.is_corp_job), accounts,
        { emptyMessage: 'No active industry jobs.' });
    }
    if (corpContainer) {
      await renderActiveJobsWidget(corpContainer, jobs.filter(j => j.is_corp_job), accounts,
        { emptyMessage: 'No active corp industry jobs.' });
    }
  };

  // renderActiveJobsWidget resolves type and system names BEFORE it writes, so two
  // overlapping calls can finish out of order and leave the shorter, older list on
  // screen. Coalesce instead: one paint runs at a time and only the newest pending
  // list is drawn next, so intermediate states are skipped rather than raced.
  let painting = null, queued = null;
  const paintCoalesced = (jobs) => {
    queued = jobs;
    if (painting) return painting;
    painting = (async () => {
      try { while (queued) { const next = queued; queued = null; await paint(next); } }
      finally { painting = null; }
    })();
    return painting;
  };

  // Paint as characters land, but ONLY on a cold table. With a snapshot already on
  // screen a partial list would read as jobs vanishing and coming back, so there
  // the fresh list replaces it in one go at the end.
  const progressive = !hadJobs && !hadCorpJobs;
  const onProgress = progressive ? (partial) => { paintCoalesced(partial); } : null;

  try {
    const allJobs = await _activeJobsShared(accounts, onProgress);
    if (painting) { try { await painting; } catch (_) {} }   // drain queued partials
    await paint(allJobs);                 // always finish on the complete list
    if (container)     _saveSnapshot('dash_snap_active_jobs', container);
    if (corpContainer) _saveSnapshot('dash_snap_corp_active_jobs', corpContainer);
  } catch (e) {
    console.error('[dashboard] Active jobs widget failed:', e);
    // Only replace a table that has nothing real on it — a stale job list beats
    // wiping it for an error box.
    const failedHtml = '<div class="active-jobs-empty dash-widget-failed">Failed to load.</div>';
    if (container     && !hadJobs)     container.innerHTML = failedHtml;
    if (corpContainer && !hadCorpJobs) corpContainer.innerHTML = failedHtml;
  }
}

// Re-render the dashboard widgets backed by LIVE per-character ESI calls (active
// jobs, skill queue, wallet balances). On a cold start these can come back empty
// during the ESI burst (token-refresh race / 429 — active jobs has no stale
// fallback). Once the background auto-sync has warmed the tokens we re-fetch them,
// so the widgets self-heal instead of needing a manual remove/re-add.
async function refreshDashboardLiveWidgets() {
  if (typeof currentPage !== 'undefined' && currentPage !== 'dashboard') return;
  if (!document.getElementById('dashboardGrid')) return;

  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!accounts.length) return;
  const mainAccount = accounts.find(a => String(a.characterId) === String(selectedCharacterId)) || accounts[0];

  // This runs BECAUSE something changed (a background sync warmed the tokens), so
  // the point is to see new data — drop the shared job list rather than re-render
  // the copy that is already on screen.
  _invalidateSharedJobs();

  if (document.getElementById('dashboardActiveJobsTable') || document.getElementById('dashboardCorpActiveJobsTable')) {
    await renderDashboardActiveJobs(accounts);
  }
  const skillEl = document.getElementById('dashboardSkillQueueWidget');
  if (skillEl) { try { await renderSkillQueueWidget(skillEl, mainAccount); } catch (_) {} }

  const walletEl = document.getElementById('dashboardWalletWidget');
  if (walletEl) { try { await renderWalletBalanceWidget(walletEl, accounts); } catch (_) {} }

  const ordersEl = document.getElementById('dashboardMarketOrders');
  if (ordersEl) { try { await renderMarketOrdersWidget(ordersEl, accounts); } catch (_) {} }

  try { await _renderAllJobWatch(accounts); } catch (_) {}
  try { await _renderAllCharWallet(accounts); } catch (_) {}
  _renderNetWorthSection(accounts, mainAccount).catch(() => {});
}

// Net worth widgets (KPIs, wealth-by-character, wealth-growth chart). A
// standalone function (not inline in loadDashboard()) so refreshDashboardLiveWidgets()
// can also call it — same reasoning as the other live-ESI widgets there: this
// can come back with dirty characters unpriced during the cold-start ESI burst
// (see the retry + stillMissing handling below), and re-running it once tokens/
// rate limits have settled is what actually clears that up, the same way the
// other widgets already self-heal.
//
// Sources:
//   • Liquid ISK    → character_information.db wallet snapshots (instant)
//   • Asset value   → character_information.db assets × /v1/markets/prices/
//                     (EVE's own adjusted_price — one unauthenticated call,
//                      cached 12 h, same valuation the game uses in-client)
//   • Market escrow → /characters/{id}/orders/  serialised, 1 char at a time
//   • Contract escrow removed — endpoint was causing all the 429s and adds
//     minimal value; escrow from buy orders already covers the main case.

// Welcome-banner net-worth figure. The value is computed asynchronously (wallet
// + asset revalue) while the banner itself is painted asynchronously (paintBanner
// awaits a DB read), so either can finish first. We keep the last computed figure
// here and (re)apply it whenever the span is (re)created — closing the race that
// otherwise left the banner stuck on "Calculating…" (the computed value landing on
// a not-yet-painted span, with no retry when market prices were slow/unavailable).
let _welcomeNetWorthText = null;
function _applyWelcomeNetWorth(text) {
  if (text != null) _welcomeNetWorthText = text;
  const el = document.getElementById('welcomeNetWorthValue');
  if (el && _welcomeNetWorthText != null) el.textContent = _welcomeNetWorthText;
}

async function _renderNetWorthSection(accounts, mainAccount) {
    // Clear any figure from a previous load/character so a stale value can't show
    // as this main's net worth; Step 2 below repopulates it (liquid ISK) at once.
    _welcomeNetWorthText = null;

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
      renderWealthWidgets({ accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, assetsLoading: loading });
      // Store + apply so the figure survives the banner-paint race: if the span
      // doesn't exist yet, the value is kept and applied when the banner paints.
      // Colour comes from .banner-stat-value (--value-bright) — no inline style.
      // A cold cache renders liquid ISK first, then refines to the full total once
      // assets are priced — better than an eternal "Calculating…" if prices stall.
      _applyWelcomeNetWorth(formatISK(grandTotal));
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
        // `pricedOk` is set only when a value was computed against a real market
        // price map. An entry lacking it was poisoned by an empty price map (a
        // cold-start ESI rate-limit) and must be recomputed.
        if (!cached || cached.assetSyncedAt !== syncedAt || ttlExpired || !cached.pricedOk) {
          dirty.push({ acc, cid, syncedAt });
        }
      }

      let marketPrices = dirty.length
        ? await window.eveAPI.getMarketPrices().catch(() => ({}))
        : {};
      let pricesOk = marketPrices && Object.keys(marketPrices).length > 0;

      // Cold-start ESI contention (the rate-limit gate, a big character-sync
      // burst, etc.) is the usual reason this fails right after launch — the
      // single busiest moment in the app's lifecycle — and it normally clears
      // within seconds. One retry (same 12s convention as serialESI's 429
      // backoff below) catches that instead of leaving dirty characters with no
      // priced value for the rest of the session (see the guard + stillMissing
      // below — this was rendering as a silent 0, which is what showed up as a
      // flat/empty wealth-growth chart).
      if (dirty.length && !pricesOk) {
        await new Promise(r => setTimeout(r, 12000));
        marketPrices = await window.eveAPI.getMarketPrices().catch(() => ({}));
        pricesOk = marketPrices && Object.keys(marketPrices).length > 0;
      }

      // Guard: never recompute against an empty price map — it would value every
      // asset at 0 and poison the 24 h cache (the cause of the "19 ISK" bug). Skip
      // the revalue and keep the existing cached values; the next dashboard load
      // (with prices available) recomputes them.
      if (dirty.length && !pricesOk) {
        console.warn('[dashboard] Market prices unavailable — skipping asset revalue this pass.');
      }

      if (dirty.length && pricesOk) {
        // ── Step 4: Recompute only the dirty characters ───────────────────
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

          perChar[cid] = { assetValue, escrow: perChar[cid]?.escrow || 0, assetSyncedAt: syncedAt, pricedOk: true };
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

      // A dirty character with no cached value AND no fresh one (prices never
      // came back, even after the retry above) has nothing real to contribute —
      // that's the case that used to render as a silent 0 and look like a
      // flat/empty growth chart. Keep the widget in its "waiting" state instead
      // of presenting a deficient total as if it were the final figure.
      const stillMissing = dirty.some(({ cid }) => !perChar[cid]);

      // ── Render final figures and keep dashboard_cache in sync ───────────
      const { totalByChar, overallValue, grandTotal } =
        renderNetWorth(perChar, totalWallet, walletByChar, stillMissing);

      await window.eveAPI.cacheSet('dashboard_cache', {
        accounts, mainAccount, walletByChar, totalByChar,
        overallValue, totalWallet, grandTotal
      }, 1).catch(() => {});

    } catch (e) { console.warn('Net worth calculation failed:', e.message); }
}

// ─── Stale-while-revalidate for a widget's rendered markup ────────────────────
// Most widgets fan out one or more IPC calls PER CHARACTER — wallet balances does
// two, active jobs spaces its ESI reads 80ms apart on purpose — so on a 20-pilot
// roster a cold dashboard sits on "Loading…" for seconds while nothing on screen
// changes. Net worth already avoided that via `dashboard_cache`; this gives every
// other widget the same treatment, the same way renderCalendar() does it.
//
// The snapshot is the widget's own HTML rather than its data: every renderer here
// already turns data into markup, so caching the output needs no per-widget
// knowledge and survives changes to those data shapes.
//
// Only a SUCCESSFUL render is ever snapshotted, so a "Loading…" or error state can
// never be persisted and replayed as if it were real. While the refresh is in
// flight the host carries `data-stale`, which dashboard.css uses to mark the tile
// as last-known rather than live — the data is real, just not yet revalidated.
// Demo mode skips snapshots entirely, in both directions.
//
// The placeholder exists to cover seconds of per-character IPC and ESI latency.
// In demo mode the data is local fixtures and arrives immediately, so there is
// nothing to cover — and a stale tile is actively harmful there: the screenshot
// pipeline would capture last week's markup instead of the live render, which is
// exactly how a widget spent a week insisting there were no corp industry jobs.
//
// window.eveAPI.isDemo is synchronous (preload reads --demo-active), so this
// decision is made before the first paint rather than racing it.

async function _paintSnapshot(key, el) {
  if (!el) return false;
  if (window.eveAPI && window.eveAPI.isDemo) return false;   // render live, never from cache
  try {
    const snap = await window.eveAPI.cacheGet(key);
    if (snap && typeof snap.html === 'string' && snap.html) {
      el.innerHTML = snap.html;
      el.dataset.stale = '1';
      return true;
    }
  } catch (_) { /* no snapshot yet — the widget's own loading state stands */ }
  return false;
}

// 7-day TTL: this is a first-paint placeholder, not a data source. It is replaced
// in the same tick as the live render, so a long life only helps the case where
// the app has been closed for a while.
function _saveSnapshot(key, el) {
  if (!el) return;
  delete el.dataset.stale;
  // Not written in demo mode either: a snapshot saved from a demo run would
  // otherwise sit in the profile and be replayed on the next one, re-creating
  // the same staleness the paint side now avoids.
  if (window.eveAPI && window.eveAPI.isDemo) return;
  window.eveAPI.cacheSet(key, { html: el.innerHTML, at: Date.now() }, 7).catch(() => {});
}

async function _swrWidget(key, el, renderFn) {
  if (!el) return;
  const painted = await _paintSnapshot(key, el);
  try {
    await renderFn(el);
    _saveSnapshot(key, el);
  } catch (e) {
    // With a snapshot on screen, keep showing it rather than replacing real data
    // with an error box. With nothing painted, let the caller handle it.
    if (!painted) throw e;
    console.warn('[dashboard] refresh failed, showing last known state:', key, e?.message || e);
  }
}

// ── Manual re-render (the ✕'s neighbour in the page header) ──────────────────
// Not a data-sync button: nothing here asks ESI for anything it wouldn't have
// asked for anyway. It re-runs the page's own render for the case a widget came
// back blank — a token race or a 429 during the cold-start burst — which people
// were reaching for Ctrl+R to fix. The grid itself is left alone (initDashboardGrid
// is a no-op once built), so widget positions and sizes survive.
let _dashRefreshing = false;

async function refreshDashboardPage() {
  if (_dashRefreshing) return;
  _dashRefreshing = true;

  const btn = document.getElementById('dashboardRefreshBtn');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  if (typeof _setPageSpinning === 'function') _setPageSpinning('dashboard', true);

  try {
    // Drop the shared job list — the whole point is to see new data, not to
    // re-render the copy that is already on screen.
    _invalidateSharedJobs();
    await loadDashboard();
  } catch (e) {
    console.warn('[dashboard] manual refresh failed:', e?.message || e);
    if (typeof showToast === 'function') showToast(`Dashboard refresh failed: ${e.message}`, 'error');
  } finally {
    _dashRefreshing = false;
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    if (typeof _setPageSpinning === 'function') _setPageSpinning('dashboard', false);
  }
}

async function loadDashboard() {
  // Build the widget grid first so every widget's target element exists before
  // the cache render and the data sections below try to fill them.
  initDashboardGrid();

  // Beehive status widget (if present) — independent of ESI/characters, fill it now.
  if (document.getElementById('dashboardBeehiveWidget')) initBeehiveWidget();
  // Same for early warning: local intel, no ESI needed.
  if (document.getElementById('dashboardEarlyWarning')) initEarlyWarningWidget();

  const summaryPanel   = document.getElementById('dashboardNetworthSummary');
  const welcomeBanner  = document.getElementById('dashboardWelcomeBanner');

  // Render from cache immediately if available
  try {
    const cachedData = await window.eveAPI.cacheGet('dashboard_cache');
    if (cachedData) {
      renderDashboardUI(cachedData);
      logToConsole('Rendered from cache.', 'info');
    }
  } catch (e) { /* ignore */ }

  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!accounts.length) {
    if (summaryPanel) summaryPanel.innerHTML = '<div class="dashboard-empty">Add a character to see your dashboard.</div>';
    return;
  }

  const mainAccount = accounts.find(a => String(a.characterId) === String(selectedCharacterId)) || accounts[0];

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
                             homeSystemName = null, currentSystem = null,
                             bloodlineName = null, implants = [], currentShipTypeId = null,
                             currentShipTypeName = null,
                             stale = false }) {
      if (!welcomeBanner) return;
      console.log('[implants] renderBanner received:', JSON.stringify(implants));

      const charSecColor = (s) => {
        const n = parseFloat(s);
        if (isNaN(n)) return 'var(--text-2)';
        if (n >= 5.0) return 'var(--pal-green)';
        if (n >= 0.1) return 'var(--pal-blue)';
        if (n == 0.0) return 'var(--text-3)';
        if (n <= 0.0) return 'var(--pal-red)';
        return 'var(--pal-red)';
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
      if (gLower === 'male')   return { color: 'var(--pal-blue)', label: 'Male' };
      if (gLower === 'female') return { color: 'var(--pal-pink)', label: 'Female' };
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
        ? `<span class="sec-breadcrumb ${sysMeta.cls}"${homeSystemName ? ` data-system="${escHtml(homeSystemName)}" title="Show ${escHtml(homeSystemName)} on the map"` : ''}>${sysMeta.label}</span>`
        : '';
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

      // Place names in the banner (and the sec chip beside them) open the Map on
      // that system. Delegated from the banner, and re-assigned rather than
      // added, so repeated renders never stack up listeners.
      welcomeBanner.onclick = (ev) => {
        const link = ev.target.closest('.dash-syslink, .sec-breadcrumb[data-system]');
        const name = link?.dataset?.system;
        if (name && typeof mapGoToSystem === 'function') mapGoToSystem(name);
      };

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
                  ${homeSystemName
                    ? `<button class="dash-syslink" data-system="${escHtml(homeSystemName)}"
                               title="Show ${escHtml(homeSystemName)} on the map">${escHtml(homeStationName || homeSystemName)}</button>`
                    : `<span>${escHtml(homeStationName || '—')}</span>`}
                  ${homeSecValueDisplay}
                  ${homeSecBreadcrumb}
                </span>
              </div>
              <div class="banner-stat-row"><span class="banner-stat-label">Location</span><span class="banner-stat-value">${
                currentSystem
                  ? `<button class="dash-syslink" data-system="${escHtml(currentSystem)}"
                             title="Show ${escHtml(currentSystem)} on the map">${escHtml(currentSystem)}</button>`
                  : '—'}</span></div>
              <div class="banner-stat-row"><span class="banner-stat-label">Gender</span><span class="banner-stat-value">${genderBreadcrumb}</span></div>
              <div class="banner-stat-row"><span class="banner-stat-label">Net Worth</span><span class="banner-stat-value" id="welcomeNetWorthValue"><span class="banner-loading-note">Calculating…</span></span></div>
            </div>
          </div>
          <div class="banner-killboard-col" id="bannerKillboardCol" style="display:none;"
               title="Open on zKillboard">
            <div class="banner-extra-section">
              <div class="banner-extra-label">Killboard</div>
              <div id="bannerKillboardGrid"></div>
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

    // Fill the banner's zKillboard column (all-time PvP counts + ranks — the
    // same numbers as the character's zKill "Alltime" row). Stays hidden unless
    // zKill returns a real PvP record, so quiet characters keep a clean banner.
    // Clicking the section opens the character's zKillboard page.
    async function loadBannerKillboard(charId) {
      const col  = document.getElementById('bannerKillboardCol');
      const grid = document.getElementById('bannerKillboardGrid');
      if (!col || !grid) return;
      let s = null;
      try { s = await window.eveAPI.getZkillStats(charId); } catch (_) {}
      if (!s || (!s.shipsDestroyed && !s.shipsLost)) return;
      const num  = n => (typeof n === 'number' && isFinite(n)) ? n.toLocaleString() : '—';
      const eff  = (s.shipsDestroyed + s.shipsLost) > 0
        ? ((s.shipsDestroyed / (s.shipsDestroyed + s.shipsLost)) * 100).toFixed(1) + '%'
        : '—';
      // Trend arrows (movement over zKill's ~week rank history) — same ticker
      // arrows + colours as the wallet balances widget (↗ up / ↘ down).
      const arrow = t => t > 0 ? ' <span class="banner-kb-trend up">↗</span>'
                   : t < 0 ? ' <span class="banner-kb-trend down">↘</span>' : '';
      const chip  = (rank, trend) => (typeof rank === 'number')
        ? `<span class="banner-kb-rank">#${rank.toLocaleString()}${arrow(trend)}</span>` : '';
      const overallCell = p => (p && typeof p.overall === 'number')
        ? `#${p.overall.toLocaleString()}${arrow(p.trend && p.trend.overall)}`
        : '—';
      const at = (s.periods && s.periods.alltime) || null;
      const rc = (s.periods && s.periods.recent)  || null;
      const wk = (s.periods && s.periods.weekly)  || null;
      grid.innerHTML = `
        <div class="banner-stat-row"><span class="banner-stat-label">Destroyed</span>
          <span class="banner-stat-value"><span class="banner-kb-pos">${num(s.shipsDestroyed)}</span>${chip(at && at.shipsDestroyed, at && at.trend.shipsDestroyed)}</span></div>
        <div class="banner-stat-row"><span class="banner-stat-label">Lost</span>
          <span class="banner-stat-value"><span class="banner-kb-neg">${num(s.shipsLost)}</span>${chip(at && at.shipsLost, at && at.trend.shipsLost)}</span></div>
        <div class="banner-stat-row"><span class="banner-stat-label">Efficiency</span>
          <span class="banner-stat-value">${eff}${arrow(at && at.trend && at.trend.efficiency)}</span></div>
        <div class="banner-stat-row"><span class="banner-stat-label">Rank · All</span>
          <span class="banner-stat-value banner-kb-overall">${overallCell(at)}</span></div>
        <div class="banner-stat-row"><span class="banner-stat-label">Rank · 90d</span>
          <span class="banner-stat-value banner-kb-overall">${overallCell(rc)}</span></div>
        <div class="banner-stat-row"><span class="banner-stat-label">Rank · 7d</span>
          <span class="banner-stat-value banner-kb-overall">${overallCell(wk)}</span></div>`;
      col.style.display = 'flex';
      col.onclick = () => { try { window.eveAPI.openExternalUrl(`https://zkillboard.com/character/${charId}/`); } catch (_) {} };
    }

    // Build/paint the banner from the local DB. Called immediately for a fast
    // paint, then again after a live status refresh so ship / location / implants
    // are the latest ESI pull on every load.
    async function paintBanner() {
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
      // Guard against stale/poison names leaking into the UI: an ESI error body
      // ("No structure found with that ID!") or a generic "Structure 12345" /
      // "Location 99" fallback is not a real place — fall back to the solar
      // system name, then a dash. Mirrors the locator's _isUnresolvedName guard.
      const _badLocName = (s) => !s
        || /^(structure|location)\s/i.test(s)
        || /no structure found|not found|forbidden|error/i.test(s);
      const homeStationName =
        (!_badLocName(loc?.station_name) && loc.station_name)
        || loc?.solar_system_name
        || '—';
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
        homeSystemName: loc?.solar_system_name || null,
        currentSystem: loc?.solar_system_name || null,
        bloodlineName,
        implants,
        currentShipTypeId, currentShipTypeName,
        stale: false,
      });

      logToConsole('Welcome banner loaded from local DB.', 'info');

      // Re-apply the already-computed net worth to the freshly-painted span so it
      // doesn't flash back to "Calculating…" — and so a value computed before this
      // paint (the banner-paint race) lands instead of being lost.
      _applyWelcomeNetWorth(null);

      // Check if alliance holds sov with active incursions — fire-and-forget
      renderAllianceIncursionAlert(info.alliance_id).catch(() => {});

      // zKillboard column — fire-and-forget (1h-cached in main, instant repaint)
      loadBannerKillboard(mainAccount.characterId).catch(() => {});
    }

    try {
      if (!mainAccount) return;
      await paintBanner();   // instant paint from the local DB

      // Live-refresh location / ship / active implants on every load (bypasses the
      // implant stale-gate), then repaint just the banner with the fresh data.
      window.eveAPI.syncCharacterStatus(mainAccount.characterId)
        .then(() => paintBanner())
        .catch(() => {});
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
  _renderNetWorthSection(accounts, mainAccount).catch(() => {});

  // ── Section 3: Active jobs widget ───────────────────────────────────────
  renderDashboardActiveJobs(accounts);

  // ── Section 4: PI widget ────────────────────────────────────────────────
  (async () => {
    const piContainer = document.getElementById('dashboardPIWidget');
    if (!piContainer) return;
    try {
      await _swrWidget('dash_snap_pi', piContainer,
        (el) => renderDashboardPIWidget(el, accounts));
    } catch (e) {
      console.error('[dashboard] PI widget failed:', e);
      piContainer.innerHTML = '<div class="dash-widget-failed" style="padding:12px;font-family:var(--mono);font-size:11px;color:var(--danger);">Failed to load PI data.</div>';
    }
  })();

  // ── Section 5: Latest ping (optional) ────────────────────────────────────
  (async () => {
    if (!document.getElementById('dashboardPingsContent')) return;
    try {
      // DIRECTOR broadcasts only — the same gate that opens the ping alert window
      // (jabber_ipc.js). This used to take the newest message of ANY kind, so a
      // line of ordinary room chatter would replace the last real ping and leave
      // a widget showing something that never popped up.
      let ping = (typeof jabberMessages !== 'undefined' && jabberMessages.length > 0)
        ? jabberMessages
            .filter(_isDirectorPing)
            .reduce((a, b) => (!a || _pingSortKey(b) > _pingSortKey(a)) ? b : a, null)
        : null;

      if (!ping) ping = await window.eveAPI.getLatestPing().catch(() => null);
      renderDashboardPing(ping);
    } catch (e) {
      const el = document.getElementById('dashboardPingsContent');
      if (el) el.innerHTML = '<div class="dashboard-empty">Could not load pings.</div>';
    }
  })();

  // ── Section 6: Wallet balances widget (optional) ─────────────────────────
  (async () => {
    const el = document.getElementById('dashboardWalletWidget');
    if (!el) return;
    try { await _swrWidget('dash_snap_wallet_balances', el, (el) => renderWalletBalanceWidget(el, accounts)); }
    catch (e) {
      console.error('[dashboard] Wallet widget failed:', e);
      el.innerHTML = '<div class="dashboard-empty dash-widget-failed">Failed to load wallet balances.</div>';
    }
  })();

  // ── Section 7: Skill queue widget (selected character, optional) ─────────
  (async () => {
    const el = document.getElementById('dashboardSkillQueueWidget');
    if (!el) return;
    try { await _swrWidget('dash_snap_skill_queue', el, (el) => renderSkillQueueWidget(el, mainAccount)); }
    catch (e) {
      console.error('[dashboard] Skill queue widget failed:', e);
      el.innerHTML = '<div class="dashboard-empty dash-widget-failed">Failed to load skill queue.</div>';
    }
  })();

  // ── Section 8: Market quicklook widget (optional) ────────────────────────
  (async () => {
    const el = document.getElementById('dashboardMarketWidget');
    if (!el) return;
    try { await _swrWidget('dash_snap_market_quicklook', el, (el) => renderMarketQuicklookWidget(el)); }
    catch (e) {
      console.error('[dashboard] Market widget failed:', e);
      el.innerHTML = '<div class="dashboard-empty dash-widget-failed">Failed to load market prices.</div>';
    }
  })();

  // ── Section 9: Active market orders widget (optional) ────────────────────
  (async () => {
    const el = document.getElementById('dashboardMarketOrders');
    if (!el) return;
    try { await _swrWidget('dash_snap_market_orders', el, (el) => renderMarketOrdersWidget(el, accounts)); }
    catch (e) {
      console.error('[dashboard] Market orders widget failed:', e);
      el.innerHTML = '<div class="active-jobs-empty dash-widget-failed">Failed to load orders.</div>';
    }
  })();

  // ── Section 10: Job Watch widgets (optional, multi-instance) ─────────────
  (async () => {
    try { await _renderAllJobWatch(accounts); }
    catch (e) { console.error('[dashboard] Job Watch widget failed:', e); }
  })();

  // ── Section 11: Character Wallet widgets (optional, multi-instance) ───────
  (async () => {
    try { await _renderAllCharWallet(accounts); }
    catch (e) { console.error('[dashboard] Character Wallet widget failed:', e); }
  })();

  // ── Section 12: Top Kills tickers (optional, multi-instance) ─────────────
  (async () => {
    try { await _renderAllKillTickers(accounts); }
    catch (e) { console.error('[dashboard] Top Kills widget failed:', e); }
  })();

  // Update ping panel live when a new Jabber message arrives.
  // Guard prevents duplicate listeners across repeated loadDashboard() calls.
  if (!_pingListenerRegistered) {
    _pingListenerRegistered = true;
    window.eveAPI.on('jabber-message', (payload) => {
      const row = (typeof jabberLiveToRow === 'function' && !('raw_body' in payload))
        ? jabberLiveToRow(payload)
        : payload;
      // Only a director broadcast replaces what is on the widget. Repainting on
      // every message wiped the ping the moment anyone said anything in the room.
      if (_isDirectorPing(row)) renderDashboardPing(row);
    });
  }

  // One deferred repair pass. The widgets that fail do so DURING this load —
  // the launch ESI burst races token refreshes and collects 429s — so a check
  // that only runs on the next page navigation is a check the user has to
  // trigger by wandering off and coming back. By 45 s the burst is over and the
  // tokens are warm. It re-fetches only widgets actually showing a failure, so
  // on a healthy dashboard it costs one querySelectorAll and nothing else.
  clearTimeout(_dashHealTimer);
  _dashHealTimer = setTimeout(() => _healFailedDashboardWidgets(), 45_000);
}

// ─── Wealth widgets (Net Worth KPIs · Wealth by Character · Wealth Growth) ─────
// Three shared building blocks. Used both by the dashboard (as three separate
// grid widgets, via renderWealthWidgets) and by the Wallets page net-worth tile
// (combined, via renderKPIPanel). Each takes the same data bundle `d`:
//   { accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, assetsLoading }

const _WEALTH_TOP_N = 6;

function _wealthCharData(d) {
  const all = (d.accounts || []).map(acc => {
    const cid    = String(acc.characterId);
    const assets = (d.totalByChar  || {})[cid] || 0;
    const wallet = (d.walletByChar || {})[cid] || 0;
    return { acc, assets, wallet, total: assets + wallet };
  }).sort((a, b) => b.total - a.total);
  return { all, top: all.slice(0, _WEALTH_TOP_N), hidden: Math.max(0, all.length - _WEALTH_TOP_N) };
}

// Widget 1: the three KPI cards (Total / Liquid / Asset value).
function _renderWealthKPIs(container, d) {
  if (!container) return;
  container.innerHTML = `
    <div class="dash-wealth-header">
      <div class="dash-wealth-kpi"><div class="dash-kpi-label">TOTAL NET WORTH</div><div class="dash-kpi-value">${formatISK(d.grandTotal)}</div><div class="dash-kpi-sub">Assets + Liquid ISK</div></div>
      <div class="dash-wealth-kpi"><div class="dash-kpi-label">LIQUID ISK</div><div class="dash-kpi-value liquidisk">${formatISK(d.totalWallet)}</div><div class="dash-kpi-sub">Wallet balance</div></div>
      <div class="dash-wealth-kpi"><div class="dash-kpi-label">ASSET VALUE</div>
        <div class="dash-kpi-value accent-purple">${d.assetsLoading ? '<span class="dash-kpi-loading">Calculating...</span>' : formatISK(d.overallValue)}</div>
        <div class="dash-kpi-sub">Jita sell estimate</div>
      </div>
    </div>`;
}

// Widget 2: the per-character wealth bars (assets + liquid), top N.
function _renderWealthByChar(container, d) {
  if (!container) return;
  const { top, hidden } = _wealthCharData(d);
  const maxTotal = Math.max(...top.map(c => c.total), 1);

  const charBars = top.map(({ acc, assets, wallet, total }) => {
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
    <div class="dash-char-bars">
      <div class="dash-char-bars-label" style="display:flex;align-items:baseline;gap:8px;">
        WEALTH BY CHARACTER
        <span style="font-size:9px;color:var(--text-3);font-family:var(--mono);font-weight:400;letter-spacing:0.05em;">
          TOP ${_WEALTH_TOP_N}${hidden > 0 ? ` · ${hidden} more character${hidden === 1 ? '' : 's'} not shown` : ''}
        </span>
      </div>
      ${barLegend}${charBars}
    </div>`;
}

// Widget 3: the 12-month compounded wealth growth chart.
function _renderWealthGrowth(container, d, compact = false) {
  if (!container) return;
  const { top } = _wealthCharData(d);

  const getCSSVar     = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Character series follow the consolidated chart palette (styles/palette.css);
  // --chart-1 is reserved for the Total line below.
  const CHAR_COLORS   = ['--chart-2','--chart-3','--chart-4','--chart-5','--chart-6','--chart-7'].map(getCSSVar);
  const growthFactors = [0.41,0.48,0.54,0.59,0.63,0.68,0.74,0.80,0.87,0.92,0.96,1.0];

  // Character lines: solid, no dots
  const charDatasets = top.map(({ acc, total }, i) => ({
    label: acc.characterName,
    data: growthFactors.map(f => Math.round(total * f)),
    borderColor: CHAR_COLORS[i % CHAR_COLORS.length],
    borderWidth: 1.5, borderDash: [], pointRadius: 0, pointHoverRadius: 4, fill: false, tension: 0.3,
  }));

  // Total line: the palette's red (--chart-1), solid, dot at every point
  if (top.length > 1) {
    const TOTAL_RED  = getCSSVar('--chart-1') || '#ff2010';
    const TOTAL_GLOW = (window.ThemeVars && TOTAL_RED.startsWith('#'))
      ? window.ThemeVars.hexToRgba(TOTAL_RED, 0.45) : 'rgba(255,32,16,0.45)';
    charDatasets.push({
      label: 'Total',
      data: growthFactors.map(f => Math.round(d.grandTotal * f)),
      borderColor: TOTAL_RED, borderWidth: 2, borderDash: [],
      pointBackgroundColor: TOTAL_RED, pointBorderColor: TOTAL_GLOW, pointBorderWidth: 3,
      pointRadius: 4, pointHoverRadius: 7, fill: false, tension: 0.3, _isTotal: true,
    });
  }

  const now         = Date.now();
  const monthLabels = Array.from({ length: 12 }, (_, i) => {
    const dt = new Date(now); dt.setMonth(dt.getMonth() - (11 - i));
    return dt.toLocaleString('default', { month: 'short' });
  });

  const legendItems = charDatasets.map(ds => `
    <span style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text-2);font-family:var(--mono);">
      <span style="width:8px;height:8px;border-radius:50%;background:${ds.borderColor};flex-shrink:0;"></span>
      ${escHtml(ds.label)}
    </span>`).join('');

  container.innerHTML = `
    <div class="dash-wealth-chart-wrap" style="display:flex;flex-direction:column;flex:1;min-height:0;margin-bottom:0;">
      <div class="dash-wealth-chart-label">COMPOUNDED WEALTH GROWTH · 12 MONTHS</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px;flex:none;">${legendItems}</div>
      ${d.assetsLoading
        ? `<div style="flex:1;min-height:120px;display:flex;align-items:center;justify-content:center;
                       color:var(--text-3);font-family:var(--mono);font-size:11px;
                       border:1px dashed var(--border);border-radius:var(--radius);">
             Waiting for asset prices...
           </div>`
        : `<div style="position:relative;width:100%;flex:1;min-height:120px;">
             <canvas id="wealthGrowthChart" role="img" aria-label="Compounded wealth growth over 12 months per character">Wealth growth chart</canvas>
           </div>`}
    </div>`;

  if (d.assetsLoading) return;
  requestAnimationFrame(() => {
    // Scope to this container — the same chart can exist on more than one page
    // (dashboard widget + wallets tile), so a global id lookup could grab the
    // wrong canvas.
    const canvas = container.querySelector('#wealthGrowthChart');
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

// Dashboard: render the three wealth widgets into whichever of their grid
// containers are currently present. Computed once, fanned out.
function renderWealthWidgets(d) {
  _renderWealthKPIs(document.getElementById('dashboardNetworthSummary'), d);
  _renderWealthByChar(document.getElementById('dashboardWealthByChar'), d);
  _renderWealthGrowth(document.getElementById('dashboardWealthGrowth'), d, false);
}

// Wallets page: the combined net-worth tile (KPIs + chart, plus per-character
// bars when not compact). Kept as a thin wrapper over the shared helpers.
function renderKPIPanel(container, accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, assetsLoading, opts = {}) {
  if (!container) return;
  const compact = !!opts.compact;
  const d = { accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, assetsLoading };
  container.innerHTML = `
    <div class="kpi-sub-kpis"></div>
    ${compact ? '' : '<div class="kpi-sub-bychar" style="margin-bottom:20px;"></div>'}
    <div class="kpi-sub-growth"></div>`;
  _renderWealthKPIs(container.querySelector('.kpi-sub-kpis'), d);
  if (!compact) _renderWealthByChar(container.querySelector('.kpi-sub-bychar'), d);
  _renderWealthGrowth(container.querySelector('.kpi-sub-growth'), d, compact);
}

// ─── Cached dashboard render ──────────────────────────────────────────────────

function renderDashboardUI(data) {
  const { accounts, mainAccount, overallValue, totalWallet, grandTotal, totalByChar, walletByChar } = data;

  renderWealthWidgets({
    accounts: accounts || [], totalWallet: totalWallet || 0, overallValue: overallValue || 0,
    grandTotal: grandTotal || 0, totalByChar: totalByChar || {}, walletByChar: walletByChar || {},
    assetsLoading: false,
  });
}

// ─── Active industry jobs widget ─────────────────────────────────────────────

const _AJ_ACTIVITY = {
  1: { label: 'Manufacturing', cls: 'aj-act-1' },
  3: { label: 'TE Research',   cls: 'aj-act-3' },
  4: { label: 'ME Research',   cls: 'aj-act-4' },
  5: { label: 'BP Copy',       cls: 'aj-act-5' },
  7: { label: 'Reverse Eng.',  cls: 'aj-act-7' },
  8: { label: 'Invention',     cls: 'aj-act-8' },
  9: { label: 'Reaction',      cls: 'aj-act-9' },
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

async function renderActiveJobsWidget(container, jobs, accounts, { emptyMessage = 'No active industry jobs.' } = {}) {
  if (!jobs.length) {
    container.innerHTML = `<div class="active-jobs-empty">${escHtml(emptyMessage)}</div>`;
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
    const charName   = accountMap[String(job.character_id)]?.characterName || job._charName || `Char ${job.character_id}`;
    const corpBadge  = job.is_corp_job ? '<span class="aj-corp-badge">CORP</span>' : '';
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
      progressCell = `<td class="aj-cell-progress"><span class="aj-status-ready">✓ READY</span></td>`;
    } else if (job.status === 'paused') {
      progressCell = `<td class="aj-cell-progress"><span class="aj-status-paused">⏸ PAUSED</span></td>`;
    } else {
      const start   = new Date(job.start_date).getTime();
      const end     = new Date(job.end_date).getTime();
      const pct     = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
      const left    = Math.max(0, end - now);
      // Colour: green when almost done, accent/red otherwise
      const fillCol = pct >= 90 ? 'var(--pal-teal)' : pct >= 50 ? 'var(--accent)' : 'var(--pal-red)';
      progressCell  = `
        <td class="aj-cell-progress">
          <div class="aj-progress-wrap">
            <div class="aj-progress-track">
              <div class="aj-progress-fill" style="width:${pct.toFixed(1)}%;background:${fillCol};"></div>
            </div>
            <div class="aj-progress-label">${_fmtTimeLeft(left)} left</div>
          </div>
        </td>`;
    }

    return `<tr>
      <td class="aj-cell-char">${charPortrait}${escHtml(charName)}${corpBadge}</td>
      <td class="aj-cell-item">${itemIcon}<span class="aj-item-name">${escHtml(itemName)}</span></td>
      <td class="aj-cell-activity"><span class="aj-activity-badge ${act.cls}">${act.label}</span></td>
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
            <th class="aj-cell-char">CHARACTER</th>
            <th class="aj-cell-item">ITEM</th>
            <th class="aj-cell-activity">ACTIVITY</th>
            <th class="aj-cell-progress">PROGRESS</th>
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
      <div class="dash-pi-summary" style="justify-content:flex-end;">
        <button class="pi-dash-link-btn">VIEW PI ›</button>
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
    <!-- Summary line + VIEW PI action (the widget title is the grid header) -->
    <div class="dash-pi-summary">
      <span>${total} planet${total !== 1 ? 's' : ''} · ${charCount} character${charCount !== 1 ? 's' : ''}</span>
      <button class="pi-dash-link-btn">VIEW PI ›</button>
    </div>

    <!-- Status counts (stack vertically when the widget is narrow) -->
    <div class="dash-pi-counts">
      <div class="dash-pi-count">
        <div class="dash-pi-count-num" style="color:#4ecbb0;">${nActive}</div>
        <div class="dash-pi-count-label">EXTRACTING</div>
      </div>
      <div class="dash-pi-count">
        <div class="dash-pi-count-num" style="color:${nWarning > 0 ? 'var(--pal-gold)' : 'var(--text-3)'};">${nWarning}</div>
        <div class="dash-pi-count-label">STORAGE FULL</div>
      </div>
      <div class="dash-pi-count">
        <div class="dash-pi-count-num" style="color:${nIdle > 0 ? 'var(--text-2)' : 'var(--text-3)'};">${nIdle}</div>
        <div class="dash-pi-count-label">IDLE</div>
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
  if (sec <= 0.0)  return 'var(--pal-red)';
  if (sec <  0.5)  return 'var(--pal-gold)';
  return 'var(--pal-green)';
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

  // Always-on banner pinned above the widget grid: hidden when there is no
  // incursion so it takes no space, shown only when one is active.
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

// ─── Wallet balances widget ───────────────────────────────────────────────────
// Live ESI wallet balance per character + a combined total. Reuses the existing
// get-wallet IPC (window.eveAPI.getWalletBalance).
// Maps a 24h delta to a ticker badge (class + diagonal arrow + signed amount).
function _walletTicker(delta) {
  if (delta == null || Math.abs(delta) < 0.005) return { cls: 'flat', arrow: '', text: '' };
  if (delta > 0) return { cls: 'up',   arrow: '↗', text: '+' + formatISK(delta) };
  return { cls: 'down', arrow: '↘', text: '-' + formatISK(Math.abs(delta)) };
}

async function renderWalletBalanceWidget(container, accounts) {
  if (!accounts || !accounts.length) {
    container.innerHTML = '<div class="dashboard-empty">No characters added.</div>';
    return;
  }
  // Compare each live balance against the snapshot from ~24h ago (local DB).
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = await Promise.all(accounts.map(async acc => {
    let bal = 0, prev = null;
    try { bal  = await window.eveAPI.getWalletBalance(acc.characterId); } catch (_) {}
    try { prev = await window.eveAPI.getWalletBalanceBefore(acc.characterId, cutoff); } catch (_) {}
    bal = Number(bal) || 0;
    // Live ESI can return 0 during the cold-start rate-limit burst — fall back to
    // the latest local snapshot so we never show a false 0 (and a bogus drop).
    if (!bal) {
      try {
        const latest = await window.eveAPI.getWalletBalanceBefore(acc.characterId, Date.now());
        if (typeof latest === 'number') bal = latest;
      } catch (_) {}
    }
    const delta = (typeof prev === 'number') ? bal - prev : null;   // null = no 24h baseline yet
    return { name: acc.characterName || `Char ${acc.characterId}`, bal, delta };
  }));
  rows.sort((a, b) => b.bal - a.bal);
  const total = rows.reduce((s, r) => s + r.bal, 0);

  // Combined 24h change: sum the known per-character deltas (unknowns = no change).
  const totalDelta = rows.some(r => r.delta != null)
    ? rows.reduce((s, r) => s + (r.delta || 0), 0)
    : null;
  const tt = _walletTicker(totalDelta);

  container.innerHTML = `
    <div class="dash-wallet-total">
      <span class="dash-wallet-total-label">COMBINED LIQUID</span>
      <span class="dash-wallet-total-value">${formatISK(total)}</span>
      ${tt.text ? `<span class="dash-wallet-total-chg ${tt.cls}">${tt.arrow} ${tt.text}</span>` : ''}
    </div>
    <div class="dash-wallet-note">↗ up · ↘ down — movement over the last 24 hours</div>
    <div class="dash-wallet-rows">
      ${rows.map(r => {
        const t = _walletTicker(r.delta);
        return `
        <div class="dash-wallet-row">
          <span class="dash-wallet-name">${escHtml(r.name)}</span>
          <span class="dash-wallet-cell ${t.cls}" title="24h change: ${t.text || 'no change'}">
            ${t.arrow ? `<span class="dash-wallet-arrow">${t.arrow}</span>` : ''}
            <span class="dash-wallet-bal">${formatISK(r.bal)}</span>
            ${t.text ? `<span class="dash-wallet-chg">${t.text}</span>` : ''}
          </span>
        </div>`;
      }).join('')}
    </div>`;
}

// ─── Skill queue widget ───────────────────────────────────────────────────────
// Shows the selected character's training queue (skill + level + time remaining).
// Backed by the new get-skill-queue IPC (scope esi-skills.read_skillqueue.v1).
const _ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

async function renderSkillQueueWidget(container, mainAccount) {
  if (!mainAccount) {
    container.innerHTML = '<div class="dashboard-empty">No character selected.</div>';
    return;
  }
  const queue = await window.eveAPI.getSkillQueue(mainAccount.characterId).catch(() => []);
  if (!Array.isArray(queue) || !queue.length) {
    container.innerHTML = `<div class="dashboard-empty">No skills in queue for ${escHtml(mainAccount.characterName)}.</div>`;
    return;
  }

  const now      = Date.now();
  // Skills still training/queued have a finish_date in the future (or none yet).
  const upcoming = queue.filter(q => !q.finish_date || new Date(q.finish_date).getTime() > now);
  const list     = (upcoming.length ? upcoming : queue).slice(0, 8);
  const last     = queue[queue.length - 1];
  const totalLeft = last && last.finish_date ? new Date(last.finish_date).getTime() - now : 0;

  container.innerHTML = `
    <div class="dash-skill-head">
      <span class="dash-skill-char">${escHtml(mainAccount.characterName)}</span>
      ${totalLeft > 0 ? `<span class="dash-skill-total">${_fmtTimeLeft(totalLeft)} total</span>` : ''}
    </div>
    <div class="dash-skill-rows">
      ${list.map((q, i) => {
        const finishMs = q.finish_date ? new Date(q.finish_date).getTime() : 0;
        const left     = finishMs ? finishMs - now : 0;
        const lvl      = _ROMAN[q.finished_level] || q.finished_level || '';
        return `<div class="dash-skill-row ${i === 0 ? 'dash-skill-active' : ''}">
          <span class="dash-skill-name">${escHtml(q.skill_name)} <b>${lvl}</b></span>
          <span class="dash-skill-time">${left > 0 ? _fmtTimeLeft(left) : 'done'}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ─── Market quicklook widget ──────────────────────────────────────────────────
// A small Jita price watchlist. Items persist in localStorage.dashboardMarketWatch.
// Prices use the existing get-jita-prices IPC (best buy / best sell).
function _getMarketWatch() {
  try {
    const w = JSON.parse(localStorage.getItem('dashboardMarketWatch') || 'null');
    if (Array.isArray(w)) return w;
  } catch (_) {}
  return [
    { typeId: 44992, name: 'PLEX' },
    { typeId: 40520, name: 'Large Skill Injector' },
    { typeId: 34,    name: 'Tritanium' },
  ];
}

function _setMarketWatch(list) {
  try { localStorage.setItem('dashboardMarketWatch', JSON.stringify(list)); } catch (_) {}
}

// Day-over-day Jita price trend from ESI market history (The Forge = 10000002).
// Cached per session so re-renders don't refetch. Returns { pct } or null.
const _marketTrendCache = new Map();
async function _marketTrend(typeId) {
  if (_marketTrendCache.has(typeId)) return _marketTrendCache.get(typeId);
  let result = null;
  try {
    const hist = await window.eveAPI.esiFetch(
      Esi.url('/markets/10000002/history', { type_id: typeId })
    );
    if (Array.isArray(hist) && hist.length >= 2) {
      const today = Number(hist[hist.length - 1].average);
      const prev  = Number(hist[hist.length - 2].average);
      if (today > 0 && prev > 0) result = { pct: ((today - prev) / prev) * 100 };
    }
  } catch (_) { result = null; }
  _marketTrendCache.set(typeId, result);
  return result;
}

function _marketTrendBadge(trend) {
  if (!trend || Math.abs(trend.pct) < 0.05) return '';
  const up = trend.pct > 0;
  return `<span class="dash-market-trend ${up ? 'up' : 'down'}">${up ? '↗' : '↘'}${Math.abs(trend.pct).toFixed(1)}%</span>`;
}

async function renderMarketQuicklookWidget(container) {
  const watch = _getMarketWatch();
  // The add controls + header are static shell — set once and never wiped, so the
  // Add button is always present even if the price/trend fetches fail.
  container.innerHTML = `
    <div class="dash-market-add">
      <input id="dashMarketInput" class="dash-market-input" placeholder="Type an item name…" autocomplete="off"/>
      <button class="dash-market-add-btn" onclick="dashMarketAdd()">Add</button>
    </div>
    <div id="dashMarketSuggest" class="dash-market-suggest" style="display:none;"></div>
    <div class="dash-market-colhead">
      <span class="dash-market-name">ITEM</span>
      <span class="dash-market-prices"><span>SELL · 24h</span><span>BUY</span></span>
      <span class="dash-market-remove-spacer"></span>
    </div>
    <div id="dashMarketRows" class="dash-market-rows">
      <div class="dashboard-widget-loading">Loading prices…</div>
    </div>`;

  _wireMarketSearch(container);

  const rowsEl = container.querySelector('#dashMarketRows');
  if (!rowsEl) return;
  if (!watch.length) {
    rowsEl.innerHTML = '<div class="dashboard-empty">No items pinned — add one above.</div>';
    return;
  }

  try {
    const typeIds = watch.map(w => w.typeId);
    const [prices, trends] = await Promise.all([
      window.eveAPI.getJitaPrices(typeIds).catch(() => ({})),
      Promise.all(typeIds.map(id => _marketTrend(id))),
    ]);
    rowsEl.textContent = '';
    watch.forEach((w, i) => {
      const p     = prices[w.typeId] || {};
      const sell  = p.sell ? formatISK(p.sell) : '—';
      const buy   = p.buy  ? formatISK(p.buy)  : '—';
      const badge = _marketTrendBadge(trends[i]);
      const typeIdNum = Number(w.typeId);

      const row = document.createElement('div');
      row.className = 'dash-market-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'dash-market-name';
      nameEl.textContent = String(w.name || '');

      const pricesEl = document.createElement('span');
      pricesEl.className = 'dash-market-prices';

      const sellEl = document.createElement('span');
      sellEl.className = 'dash-market-sell';
      sellEl.textContent = sell;
      if (badge) {
        sellEl.appendChild(document.createTextNode(' '));
        const badgeWrap = document.createElement('span');
        badgeWrap.innerHTML = badge;
        const badgeNode = badgeWrap.firstElementChild;
        if (badgeNode) sellEl.appendChild(badgeNode);
      }

      const buyEl = document.createElement('span');
      buyEl.className = 'dash-market-buy';
      buyEl.textContent = buy;

      pricesEl.appendChild(sellEl);
      pricesEl.appendChild(buyEl);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'dash-market-remove';
      removeBtn.title = 'Remove from watchlist';
      removeBtn.textContent = '✕';
      if (Number.isFinite(typeIdNum)) {
        removeBtn.addEventListener('click', () => dashMarketRemove(typeIdNum));
      } else {
        removeBtn.disabled = true;
      }

      row.appendChild(nameEl);
      row.appendChild(pricesEl);
      row.appendChild(removeBtn);
      rowsEl.appendChild(row);
    });
  } catch (_) {
    rowsEl.innerHTML = '<div class="dashboard-empty">Could not load prices.</div>';
  }
}

// Live name autocomplete against the local SDE (the public ESI /search/ endpoint
// was removed by CCP). Shows a dropdown of matching market items to click.
let _marketSuggestTimer = null;
function _wireMarketSearch(container) {
  const input = container.querySelector('#dashMarketInput');
  const box   = container.querySelector('#dashMarketSuggest');
  if (!input || !box) return;

  const hide = () => { box.style.display = 'none'; box.innerHTML = ''; };

  input.addEventListener('input', () => {
    clearTimeout(_marketSuggestTimer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    _marketSuggestTimer = setTimeout(async () => {
      const matches = await window.eveAPI.searchMarketTypes(q, 8).catch(() => []);
      if (!matches.length) { hide(); return; }
      box.innerHTML = matches.map(m =>
        `<button type="button" class="dash-market-suggest-item" data-id="${m.id}" data-name="${escHtml(m.name)}">${escHtml(m.name)}</button>`
      ).join('');
      box.style.display = 'block';
    }, 180);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); dashMarketAdd(); }
    if (e.key === 'Escape') { hide(); }
  });
  // Hide after the click on a suggestion has had a chance to register.
  input.addEventListener('blur', () => setTimeout(hide, 150));

  // mousedown (not click) so it fires before the input's blur hides the box.
  box.addEventListener('mousedown', e => {
    const btn = e.target.closest('.dash-market-suggest-item');
    if (!btn) return;
    e.preventDefault();
    dashMarketAddById(Number(btn.dataset.id), btn.dataset.name);
  });
}

// Pin a known item (typeId + name) to the watchlist and re-render.
function dashMarketAddById(typeId, name) {
  if (!typeId) return;
  const watch = _getMarketWatch();
  if (!watch.some(w => w.typeId === typeId)) {
    watch.push({ typeId, name: name || `Type ${typeId}` });
    _setMarketWatch(watch);
  }
  const container = document.getElementById('dashboardMarketWidget');
  if (container) renderMarketQuicklookWidget(container);
}

// Add the best SDE match for whatever is typed (Enter / Add button).
async function dashMarketAdd() {
  const input = document.getElementById('dashMarketInput');
  if (!input) return;
  const q = input.value.trim();
  if (!q) return;
  const matches = await window.eveAPI.searchMarketTypes(q, 1).catch(() => []);
  if (!matches.length) { input.value = ''; input.placeholder = 'No match — try another name'; return; }
  dashMarketAddById(matches[0].id, matches[0].name);
}

function dashMarketRemove(typeId) {
  _setMarketWatch(_getMarketWatch().filter(w => w.typeId !== typeId));
  const container = document.getElementById('dashboardMarketWidget');
  if (container) renderMarketQuicklookWidget(container);
}

// ─── Active market orders widget ──────────────────────────────────────────────
// Live buy + sell orders across all characters (get-character-orders, cached 5m).
async function renderMarketOrdersWidget(container, accounts) {
  const accountMap = Object.fromEntries(accounts.map(a => [String(a.characterId), a]));

  const orders = [];
  for (const acc of accounts) {
    try {
      const list = await window.eveAPI.getCharacterOrders(acc.characterId);
      if (Array.isArray(list)) list.forEach(o => orders.push({ ...o, character_id: acc.characterId }));
    } catch (_) {}
    await new Promise(r => setTimeout(r, 60));
  }

  if (!orders.length) {
    container.innerHTML = '<div class="active-jobs-empty">No active market orders.</div>';
    return;
  }

  const typeNames = await _resolveTypeNames([...new Set(orders.map(o => o.type_id).filter(Boolean))]);

  const now   = Date.now();
  const sells = orders.filter(o => !o.is_buy_order);
  const buys  = orders.filter(o => o.is_buy_order);
  const listed = sells.reduce((s, o) => s + (o.price || 0) * (o.volume_remain || 0), 0);

  // Sells first, then buys; each newest-issued first.
  const sorted = [...orders].sort((a, b) => {
    const sa = a.is_buy_order ? 1 : 0, sb = b.is_buy_order ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return new Date(b.issued) - new Date(a.issued);
  });

  const rows = sorted.map(o => {
    const acc      = accountMap[String(o.character_id)] || {};
    const name     = typeNames[o.type_id] || `Type ${o.type_id}`;
    const isBuy    = !!o.is_buy_order;
    const total    = o.volume_total || o.volume_remain || 1;
    const filled   = Math.min(100, Math.max(0, ((total - (o.volume_remain || 0)) / total) * 100));
    const expiry   = new Date(o.issued).getTime() + (o.duration || 0) * 86400000;
    const left     = expiry - now;
    const icon64   = `https://images.evetech.net/types/${o.type_id}/icon?size=64`;
    const icon32   = `https://images.evetech.net/types/${o.type_id}/icon?size=32`;
    const itemIcon = `<img src="${icon64}" alt=""
        style="width:20px;height:20px;border-radius:3px;border:1px solid var(--border);
               vertical-align:middle;margin-right:6px;object-fit:cover;flex-shrink:0;background:var(--bg-deep);"
        onerror="if(this.src==='${icon64}'){this.src='${icon32}';}else{this.style.display='none';}"/>`;
    const portrait = `<img src="https://images.evetech.net/characters/${o.character_id}/portrait?size=32" alt=""
        style="width:18px;height:18px;border-radius:3px;border:1px solid var(--border);
               vertical-align:middle;margin-right:5px;object-fit:cover;" onerror="this.style.display='none'"/>`;
    return `<tr>
      <td class="aj-cell-char">${portrait}${escHtml(acc.characterName || '')}</td>
      <td class="aj-cell-item">${itemIcon}<span class="aj-item-name">${escHtml(name)}</span></td>
      <td class="mo-cell-side"><span class="mo-side ${isBuy ? 'mo-buy' : 'mo-sell'}">${isBuy ? 'BUY' : 'SELL'}</span></td>
      <td class="mo-cell-price">${formatISK(o.price || 0)}</td>
      <td class="mo-cell-qty">
        <div class="mo-qty-bar"><div class="mo-qty-fill" style="width:${filled.toFixed(0)}%"></div></div>
        <span>${(o.volume_remain || 0).toLocaleString()} / ${total.toLocaleString()}</span>
      </td>
      <td class="mo-cell-time">${left > 0 ? _fmtTimeLeft(left) : '—'}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="active-jobs-summary">
      <span>${sells.length} sell · ${buys.length} buy · ${formatISK(listed)} listed</span>
    </div>
    <div class="active-jobs-scroll">
      <table class="active-jobs-list">
        <thead>
          <tr><th class="aj-cell-char">CHARACTER</th><th class="aj-cell-item">ITEM</th>
              <th class="mo-cell-side">SIDE</th><th class="mo-cell-price">PRICE</th>
              <th class="mo-cell-qty">QTY REMAIN</th><th class="mo-cell-time">EXPIRES</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ─── Job Watch widget (multi-instance) ────────────────────────────────────────
// A configurable monitor for ONE active industry job: pick a job from the dropdown
// and the card shows its icon, activity, character, a live progress bar and an
// updating countdown. Addable many times — each instance watches its own job. The
// chosen job_id persists per instance in localStorage (map keyed by instance id).
function _jobWatchMap() {
  // Tolerate the legacy single-instance value (a bare jobId) by resetting to a map.
  try {
    const m = JSON.parse(localStorage.getItem('dashboardJobWatch') || '{}');
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (_) { return {}; }
}
function _getJobWatch(instId) {
  const v = _jobWatchMap()[instId];
  return v != null ? v : null;
}
function _setJobWatch(instId, jobId) {
  try {
    const m = _jobWatchMap();
    if (jobId != null) m[instId] = jobId; else delete m[instId];
    localStorage.setItem('dashboardJobWatch', JSON.stringify(m));
  } catch (_) {}
}

let _jobWatchTimer = null;
function _startJobWatchTicker() {
  clearInterval(_jobWatchTimer);
  _jobWatchTimer = setInterval(() => {
    document.querySelectorAll('.jw-card[data-end]').forEach(card => {
      if (card.dataset.status !== 'active') return;
      const start = Number(card.dataset.start), end = Number(card.dataset.end), now = Date.now();
      const pct  = end > start ? Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100)) : 100;
      const left = end - now;
      const fill = card.querySelector('.jw-progress-fill');
      const time = card.querySelector('.jw-time');
      if (fill) fill.style.width = pct.toFixed(2) + '%';
      if (time) time.textContent = left > 0 ? `Done in ${_fmtTimeLeft(left)}` : 'Ready to deliver';
    });
  }, 1000);
}

// Fetch active jobs once, then render every Job Watch instance on the grid.
async function _renderAllJobWatch(accounts) {
  const panels = document.querySelectorAll('#dashboardGrid [data-widget-base="jobWatch"]');
  if (!panels.length) return;

  // Job Watch is multi-instance, so each panel keeps its own snapshot — they can
  // be watching different jobs. Painted before the fan-out is awaited, otherwise
  // every instance sits on "Loading…" for the whole round-trip.
  const bodies = [...panels].map(panel => ({
    panel,
    body: panel.querySelector('.dashboard-widget-body'),
    key:  `dash_snap_jobwatch_${panel.dataset.widgetId}`,
  })).filter(x => x.body);
  await Promise.all(bodies.map(x => _paintSnapshot(x.key, x.body)));

  const accountMap = Object.fromEntries(accounts.map(a => [String(a.characterId), a]));
  // Personal + corp jobs (deduped, corp-tagged) via the shared helper.
  const shared = await _activeJobsShared(accounts);
  // Copy before sorting: the list is shared with the Active Jobs tables now, and
  // sorting in place would reorder it under whoever else is holding it.
  // Deterministic order (soonest-done first) so the dropdown and the auto-default
  // are stable across re-renders — ESI's job order is not guaranteed.
  const active = shared.slice()
    .sort((a, b) => (new Date(a.end_date) - new Date(b.end_date)) || (Number(a.job_id) - Number(b.job_id)));
  const typeNames = active.length
    ? await _resolveTypeNames([...new Set(active.map(j => j.product_type_id || j.blueprint_type_id).filter(Boolean))])
    : {};

  bodies.forEach(({ body, panel, key }) => {
    _renderJobWatchInstance(body, panel.dataset.widgetId, active, accountMap, typeNames);
    _saveSnapshot(key, body);
  });
  _startJobWatchTicker();
}

function _renderJobWatchInstance(body, instId, active, accountMap, typeNames) {
  if (!active.length) {
    body.innerHTML = '<div class="dashboard-empty">No active industry jobs to watch.</div>';
    return;
  }
  const labelFor = j => {
    const tid = j.product_type_id || j.blueprint_type_id;
    return (tid && typeNames[tid]) || (tid ? `Type ${tid}` : 'Job');
  };

  // Resolve the watched job; fall back to the soonest-done one when the saved
  // job is gone (delivered) or nothing was picked for this instance. Persist the
  // choice — including the auto-default — so re-renders (e.g. adding another Job
  // Watch) never silently change what this instance is watching. The card names
  // the job and its character, so a fallback is visible rather than silent.
  let job = active.find(j => String(j.job_id) === String(_getJobWatch(instId)));
  if (!job) { job = active[0]; _setJobWatch(instId, job.job_id); }

  const acc   = accountMap[String(job.character_id)] || {};
  const tid   = job.product_type_id || job.blueprint_type_id;
  const name  = labelFor(job);
  const act   = _AJ_ACTIVITY[job.activity_id] || { label: `Activity ${job.activity_id}`, cls: '' };
  const start = new Date(job.start_date).getTime();
  const end   = new Date(job.end_date).getTime();
  const now   = Date.now();
  const pct   = job.status === 'ready' ? 100
              : (end > start ? Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100)) : (job.status === 'paused' ? 0 : 100));
  const left  = end - now;
  const runs  = job.runs ? `${job.runs} run${job.runs !== 1 ? 's' : ''}` : '';
  const icon64 = `https://images.evetech.net/types/${tid}/icon?size=64`;
  const iconBp = `https://images.evetech.net/types/${tid}/bp?size=64`;
  const timeText = job.status === 'ready' ? 'Ready to deliver'
                 : job.status === 'paused' ? '⏸ Paused'
                 : (left > 0 ? `Done in ${_fmtTimeLeft(left)}` : 'Ready to deliver');
  const endStr = new Date(job.end_date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  body.innerHTML = `
    <div class="jw-card" data-start="${start}" data-end="${end}" data-status="${escHtml(job.status)}">
      <div class="jw-head">
        <img class="jw-icon" src="${icon64}" alt=""
             onerror="if(this.src==='${icon64}'){this.src='${iconBp}';}else{this.style.display='none';}"/>
        <div class="jw-head-info">
          <div class="jw-name" title="${escHtml(name)}">${escHtml(name)}</div>
          <div class="jw-sub"><span class="aj-activity-badge ${act.cls}">${act.label}</span>${runs ? ` · ${runs}` : ''}</div>
          <div class="jw-char">${escHtml(acc.characterName || job._charName || '')}${job.is_corp_job ? ' <span class="aj-corp-badge">CORP</span>' : ''}</div>
        </div>
      </div>
      <div class="jw-progress"><div class="jw-progress-fill" style="width:${pct.toFixed(2)}%"></div></div>
      <div class="jw-foot">
        <span class="jw-time">${timeText}</span>
        <span class="jw-end">ends ${escHtml(endStr)}</span>
      </div>
    </div>`;
}

// ─── Character Wallet widget (multi-instance) ──────────────────────────────────
// A per-character wallet card (portrait, name, ISK balance) — the same tile as the
// Wallets page, but addable to the dashboard one-per-character. The character is
// chosen in the add menu (see the registry's `pick`) and persists per instance in
// localStorage; clicking the card opens that character's wallet journal modal.
function _charWalletMap() {
  try {
    const m = JSON.parse(localStorage.getItem('dashboardCharWallet') || '{}');
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (_) { return {}; }
}
function _getCharWallet(instId) {
  const v = _charWalletMap()[instId];
  return v != null ? v : null;
}
function _setCharWallet(instId, charId) {
  try {
    const m = _charWalletMap();
    if (charId != null) m[instId] = String(charId); else delete m[instId];
    localStorage.setItem('dashboardCharWallet', JSON.stringify(m));
  } catch (_) {}
}

// Fetch every character's balance once, then render each Character Wallet instance.
async function _renderAllCharWallet(accounts) {
  const panels = document.querySelectorAll('#dashboardGrid [data-widget-base="charWallet"]');
  if (!panels.length) return;

  // Balance comes from the local character DB (synced ~30 min) — same source as the
  // Wallets page — so this is a cheap parallel read, no live ESI burst.
  const balByChar = {};
  await Promise.all(accounts.map(async acc => {
    try { const d = await window.eveAPI.getCharacterData(acc.characterId); balByChar[String(acc.characterId)] = d?.wallet?.balance ?? 0; }
    catch (_) { balByChar[String(acc.characterId)] = 0; }
  }));

  panels.forEach(panel => {
    const body = panel.querySelector('.dashboard-widget-body');
    if (body) _renderCharWalletInstance(body, panel.dataset.widgetId, accounts, balByChar);
  });
}

function _renderCharWalletInstance(body, instId, accounts, balByChar) {
  if (!accounts.length) {
    body.innerHTML = '<div class="dashboard-empty">No characters. Add one on the Characters page.</div>';
    return;
  }

  // Resolve the selected character; fall back to the main/selected char (then the
  // first) when nothing is picked yet or the saved one was removed. Persist the
  // choice — including the auto-default — so re-renders never silently switch it.
  let savedId = _getCharWallet(instId);
  let acc = accounts.find(a => String(a.characterId) === String(savedId));
  if (!acc) {
    acc = accounts.find(a => String(a.characterId) === String(selectedCharacterId)) || accounts[0];
    _setCharWallet(instId, acc.characterId);
  }
  const cid     = String(acc.characterId);
  const name    = acc.characterName || `Char ${cid}`;
  const balance = balByChar[cid] ?? 0;

  body.innerHTML = `
    <div class="cw-card" title="View wallet journal">
      <img class="cw-portrait" src="https://images.evetech.net/characters/${cid}/portrait?size=64" alt=""
           onerror="this.style.display='none'"/>
      <div class="cw-info">
        <div class="cw-name" title="${escHtml(name)}">${escHtml(name)}</div>
        <div class="cw-balance">${formatISK(balance)}</div>
      </div>
      <span class="material-symbols-outlined cw-journal-icon">receipt_long</span>
    </div>`;

  // Bind the click in JS (not inline) so the character name can't break the markup.
  const card = body.querySelector('.cw-card');
  if (card) card.addEventListener('click', () => {
    if (typeof openWalletJournal === 'function') openWalletJournal(cid, name);
  });
}

// ─── Top Kills ticker (multi-instance) ────────────────────────────────────────
// A marquee of your most valuable kills over the last 90 days. Reads the SAME
// cached zKillboard feed the Killboard page uses (get-zkill-feed, 10-minute
// cache in main, 30-day stale fallback) — zKill asks consumers to cache hard, so
// this deliberately opens no second route to it.
//
// Scope ('all' or one character id) is picked once in the add menu and stored per
// instance, so the widget itself carries no dropdown. Add it twice with different
// scopes if you want both a roster-wide and a per-character ticker.

const KILL_SCOPE_KEY   = 'dashboardKillTicker';
const KILL_WINDOW_DAYS = 90;
const KILL_MAX_PAGES   = 3;    // zKill pages (200 kills each) per character
const KILL_TOP_N       = 20;   // most valuable kills kept

let _ktNames = {};             // id → name (victims, ships, systems)
const _ktName = (id) => (id && _ktNames[id]) || '—';

function _killScopeMap() {
  try {
    const m = JSON.parse(localStorage.getItem(KILL_SCOPE_KEY) || '{}');
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (_) { return {}; }
}
function _getKillScope(instId) {
  const v = _killScopeMap()[instId];
  return v != null ? String(v) : 'all';
}
function _setKillScope(instId, scope) {
  try {
    const m = _killScopeMap();
    if (scope != null) m[instId] = String(scope); else delete m[instId];
    localStorage.setItem(KILL_SCOPE_KEY, JSON.stringify(m));
  } catch (_) { /* private mode */ }
}

// Walk one character's zKill pages back until they leave the 90-day window. The
// feed is newest-first, so the first page that reaches the cutoff is the last one
// worth asking for; the page cap stops a very active pilot pulling thousands of
// rows to fill a 20-card marquee.
async function _ktCharKills(charId, cutoff) {
  const out = [];
  for (let page = 1; page <= KILL_MAX_PAGES; page++) {
    const rows = await window.eveAPI.getZkillFeed('character', charId, page).catch(() => null);
    if (!Array.isArray(rows) || !rows.length) break;
    let reachedCutoff = false;
    for (const k of rows) {
      const t = Date.parse(k.time);
      if (!Number.isFinite(t) || t < cutoff) { reachedCutoff = true; continue; }
      if (k.isLoss) continue;                       // kills only — losses have their own page
      out.push({ ...k, _byCharId: Number(charId) });
    }
    if (reachedCutoff) break;
  }
  return out;
}

async function _ktFetchKills(charIds) {
  const cutoff = Date.now() - KILL_WINDOW_DAYS * 86_400_000;
  const merged = [];
  const queue  = [...charIds];
  // Capped concurrency: a whole roster fanning out at once is exactly what
  // zKillboard asks consumers not to do.
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try { merged.push(...await _ktCharKills(id, cutoff)); }
      catch (e) { console.warn('[dashboard] kill ticker: character', id, 'failed:', e?.message || e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, charIds.length) }, worker));

  // Two of your characters on the same killmail return it twice — keep one copy,
  // credited to whichever feed answered first.
  const byId = new Map();
  for (const k of merged) if (!byId.has(k.killmailId)) byId.set(k.killmailId, k);

  return [...byId.values()]
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, KILL_TOP_N);
}

// Victims, ship types and systems all resolve through one /universe/names batch.
async function _ktResolveNames(kills) {
  const ids = [];
  kills.forEach(k => {
    [k.victimCharId, k.victimShipTypeId, k.systemId].forEach(id => {
      if (id && !_ktNames[id]) ids.push(id);
    });
  });
  const missing = [...new Set(ids)];
  if (!missing.length) return;
  try {
    const r = await window.eveAPI.getNames(missing);
    if (Array.isArray(r)) r.forEach(({ id, name }) => { if (id && name) _ktNames[id] = name; });
    else if (r && typeof r === 'object') Object.assign(_ktNames, r);
  } catch (_) { /* unresolved ids fall back to a dash */ }
}

function _ktAgo(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d}d ago`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h}h ago`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

function _ktRenderInstance(body, kills, label, showWho, nameById) {
  if (!kills.length) {
    body.innerHTML = `<div class="dashboard-empty">No kills for ${escHtml(label)} in the last ${KILL_WINDOW_DAYS} days.</div>`;
    return;
  }

  const cards = kills.map((k, i) => {
    const who = showWho ? (nameById.get(String(k._byCharId)) || '') : '';
    return `
    <div class="kt-card" data-km="${k.killmailId}" title="Open this killmail on zKillboard">
      <div class="kt-rank">#${i + 1}</div>
      ${k.victimShipTypeId
        ? `<img class="kt-ship" src="https://images.evetech.net/types/${k.victimShipTypeId}/render?size=128"
                alt="" loading="lazy" onerror="this.style.display='none'"/>`
        : ''}
      <div class="kt-info">
        <div class="kt-value">${formatISK(k.totalValue)}</div>
        <div class="kt-shipname">${escHtml(_ktName(k.victimShipTypeId))}</div>
        <div class="kt-victim">${escHtml(_ktName(k.victimCharId))}</div>
        <div class="kt-meta">
          <span>${escHtml(_ktName(k.systemId))}</span>
          <span class="kt-dot">·</span><span>${_ktAgo(k.time)}</span>
          ${who ? `<span class="kt-dot">·</span><span class="kt-by">${escHtml(who)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="kt-wrap">
      <div class="kt-head">
        <span class="kt-scope">${escHtml(label)}</span>
        <span class="kt-sub">Top ${kills.length} by value · last ${KILL_WINDOW_DAYS} days</span>
      </div>
      <div class="kt-viewport"><div class="kt-track">${cards}${cards}</div></div>
    </div>`;

  // Bound in JS, not inline: the cards are duplicated for the seamless loop, so
  // both copies need the handler and neither should carry markup-breaking names.
  body.querySelectorAll('.kt-card').forEach(card => {
    card.addEventListener('click', () => {
      const km = card.dataset.km;
      if (km) { try { window.eveAPI.openExternalUrl(`https://zkillboard.com/kill/${km}/`); } catch (_) {} }
    });
  });

  // Scale the loop to the content width so the speed reads the same whether the
  // widget is full-width with 20 cards or narrow with three (~30px/second).
  requestAnimationFrame(() => {
    const track = body.querySelector('.kt-track');
    if (!track) return;
    const half = track.scrollWidth / 2;
    if (half > 0) track.style.animationDuration = `${Math.max(60, Math.round(half / 30))}s`;
  });
}

async function _renderAllKillTickers(accounts) {
  const panels = document.querySelectorAll('#dashboardGrid [data-widget-base="killTicker"]');
  if (!panels.length) return;

  const nameById = new Map(accounts.map(a => [String(a.characterId), a.characterName || `Char ${a.characterId}`]));

  // Instances sharing a scope fetch once — two tickers on the same roster should
  // not double the requests to zKill.
  const byScope = new Map();
  panels.forEach(panel => {
    const scope = _getKillScope(panel.dataset.widgetId);
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(panel);
  });

  await Promise.all([...byScope.entries()].map(async ([scope, group]) => {
    const entries = group
      .map(p => ({ body: p.querySelector('.dashboard-widget-body'), key: `dash_snap_killticker_${p.dataset.widgetId}` }))
      .filter(e => e.body);

    // Last good marquee goes up first; the fetch below replaces it.
    await Promise.all(entries.map(e => _paintSnapshot(e.key, e.body)));

    const known = scope === 'all' || nameById.has(String(scope));
    if (!known) {
      entries.forEach(e => {
        e.body.innerHTML = '<div class="dashboard-empty">That character is no longer added. Remove this widget or add a new one.</div>';
      });
      return;
    }

    const ids   = scope === 'all' ? accounts.map(a => Number(a.characterId)) : [Number(scope)];
    const label = scope === 'all' ? 'All characters' : nameById.get(String(scope));
    if (!ids.length) {
      entries.forEach(e => { e.body.innerHTML = '<div class="dashboard-empty">Add a character to see kills.</div>'; });
      return;
    }

    let kills;
    try {
      kills = await _ktFetchKills(ids);
      await _ktResolveNames(kills);
    } catch (e) {
      // Leave whatever was painted from the snapshot — a zKill outage should not
      // blank a marquee that was correct ten minutes ago.
      console.warn('[dashboard] kill ticker fetch failed:', e?.message || e);
      return;
    }

    entries.forEach(e => {
      _ktRenderInstance(e.body, kills, label, scope === 'all', nameById);
      _saveSnapshot(e.key, e.body);
    });
  }));
}