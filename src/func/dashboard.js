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
    w: 3, h: 6, minW: 2, minH: 4,
    body: '<div class="dashboard-widget-loading">Loading…</div>',
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
  },
  // GoonFleet-only: live Beehive beacon status from the room MOTD. Gated out of the
  // "add widget" menu for non-Goons (see _refreshAddWidgetMenu / _beehiveGoon).
  beehive: {
    icon: 'hive', title: 'BEEHIVE STATUS',
    w: 4, h: 5, minW: 2, minH: 4,
    body: '<div id="dashboardBeehiveWidget"><div class="dashboard-widget-loading">Loading…</div></div>',
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
  try {
    const saved = JSON.parse(localStorage.getItem('dashboardGridLayout') || 'null');
    if (saved && saved.v === DASH_LAYOUT_VERSION && Array.isArray(saved.items) && saved.items.length) {
      const valid = saved.items.filter(it => it && _widgetDef(it.id));
      if (valid.length) return valid;
    }
  } catch (_) {}
  return DEFAULT_DASH_LAYOUT.map(it => ({ ...it }));
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
    draggable: { handle: '.dnd-handle', cancel: '.dashboard-widget-remove' },
  }, gridEl);

  _dashGrid.on('change',  _saveDashLayout);
  _dashGrid.on('added',   _saveDashLayout);
  _dashGrid.on('removed', _saveDashLayout);

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
function addDashboardWidget(id) {
  const def = DASHBOARD_WIDGETS[id];
  if (!_dashGrid || !def) return;
  if (!def.multi && _activeWidgetIds().some(a => _widgetBase(a) === id)) { hideAddWidgetMenu(); return; }
  const instId = def.multi ? _newInstanceId(id) : id;
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
  _saveDashLayout();
}

function resetDashboardLayout() {
  try { localStorage.removeItem('dashboardGridLayout'); } catch (_) {}
  if (_dashGrid) { _dashGrid.destroy(false); _dashGrid = null; }  // keep the grid DOM node
  initDashboardGrid();
  loadDashboard();
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
        return `<button class="dashboard-add-item" onclick="addDashboardWidget('${key}')">`
             + `${def.icon ? `<span class="material-symbols-outlined">${def.icon}</span>` : ''}`
             + `<span>${def.title}${def.multi ? ' <span class="dashboard-add-plus">+</span>' : ''}</span></button>`;
      }).join('')
    : '<div class="dashboard-add-empty">All widgets added.</div>';
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
// only for Goons; fail-safe RED whenever green/yellow isn't positively confirmed.
let _beehiveGoon     = false;
let _beehiveLast     = { status: 'red', text: '', changedAt: null };
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

function _beehiveMeta(status) {
  switch (status) {
    case 'green':  return { color: '#3fb950', label: 'RUNNING',    sub: 'Up and running — good to go' };
    case 'yellow': return { color: '#e3b341', label: 'HOLDING',    sub: 'Holding pattern — finishing active beacons' };
    default:       return { color: '#f04848', label: 'STAND DOWN', sub: 'Beacons are not running — stand down' };
  }
}

function renderBeehiveWidget() {
  const el = document.getElementById('dashboardBeehiveWidget');
  if (!el) return;
  const st     = _beehiveLast || { status: 'red' };
  const status = st.status || 'red';
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
      if (_beehiveLast.status === 'red' && prev && prev !== 'red') _beehiveRedAlert();
    });
  }
  try { const s = await window.eveAPI.getBeehiveStatus(); if (s) _beehiveLast = s; } catch (_) {}
  renderBeehiveWidget();
}

// Fetch + render the Active Industry Jobs widget (active / ready / paused jobs
// across all characters). Live ESI per character — extracted so it can be re-run
// after a background sync warms the tokens (see refreshDashboardLiveWidgets).
async function renderDashboardActiveJobs(accounts) {
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

  if (document.getElementById('dashboardActiveJobsTable')) {
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
}

async function loadDashboard() {
  // Build the widget grid first so every widget's target element exists before
  // the cache render and the data sections below try to fill them.
  initDashboardGrid();

  // Beehive status widget (if present) — independent of ESI/characters, fill it now.
  if (document.getElementById('dashboardBeehiveWidget')) initBeehiveWidget();

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
                             allianceId, allianceName, homeStationName, homeSystemSec, currentSystem = null,
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
              <div class="banner-stat-row"><span class="banner-stat-label">Location</span><span class="banner-stat-value">${escHtml(currentSystem || '—')}</span></div>
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

    // Build/paint the banner from the local DB. Called immediately for a fast
    // paint, then again after a live status refresh so ship / location / implants
    // are the latest ESI pull on every load.
    async function paintBanner(preserveNetWorth) {
      const prevNW = preserveNetWorth
        ? (document.getElementById('welcomeNetWorthValue')?.innerHTML || null) : null;

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
        currentSystem: loc?.solar_system_name || null,
        bloodlineName,
        implants,
        currentShipTypeId, currentShipTypeName,
        stale: false,
      });

      logToConsole('Welcome banner loaded from local DB.', 'info');

      // Preserve the already-computed net worth across a repaint so it doesn't flash
      // back to "Calculating…".
      if (prevNW != null) {
        const nwEl = document.getElementById('welcomeNetWorthValue');
        if (nwEl) nwEl.innerHTML = prevNW;
      }

      // Check if alliance holds sov with active incursions — fire-and-forget
      renderAllianceIncursionAlert(info.alliance_id).catch(() => {});
    }

    try {
      if (!mainAccount) return;
      await paintBanner(false);   // instant paint from the local DB

      // Live-refresh location / ship / active implants on every load (bypasses the
      // implant stale-gate), then repaint just the banner with the fresh data.
      window.eveAPI.syncCharacterStatus(mainAccount.characterId)
        .then(() => paintBanner(true))
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
      renderWealthWidgets({ accounts, totalWallet, overallValue, grandTotal, totalByChar, walletByChar, assetsLoading: loading });
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
        // `pricedOk` is set only when a value was computed against a real market
        // price map. An entry lacking it was poisoned by an empty price map (a
        // cold-start ESI rate-limit) and must be recomputed.
        if (!cached || cached.assetSyncedAt !== syncedAt || ttlExpired || !cached.pricedOk) {
          dirty.push({ acc, cid, syncedAt });
        }
      }

      const marketPrices = dirty.length
        ? await window.eveAPI.getMarketPrices().catch(() => ({}))
        : {};
      const pricesOk = marketPrices && Object.keys(marketPrices).length > 0;

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
  renderDashboardActiveJobs(accounts);

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

  // ── Section 6: Wallet balances widget (optional) ─────────────────────────
  (async () => {
    const el = document.getElementById('dashboardWalletWidget');
    if (!el) return;
    try { await renderWalletBalanceWidget(el, accounts); }
    catch (e) {
      console.error('[dashboard] Wallet widget failed:', e);
      el.innerHTML = '<div class="dashboard-empty">Failed to load wallet balances.</div>';
    }
  })();

  // ── Section 7: Skill queue widget (selected character, optional) ─────────
  (async () => {
    const el = document.getElementById('dashboardSkillQueueWidget');
    if (!el) return;
    try { await renderSkillQueueWidget(el, mainAccount); }
    catch (e) {
      console.error('[dashboard] Skill queue widget failed:', e);
      el.innerHTML = '<div class="dashboard-empty">Failed to load skill queue.</div>';
    }
  })();

  // ── Section 8: Market quicklook widget (optional) ────────────────────────
  (async () => {
    const el = document.getElementById('dashboardMarketWidget');
    if (!el) return;
    try { await renderMarketQuicklookWidget(el); }
    catch (e) {
      console.error('[dashboard] Market widget failed:', e);
      el.innerHTML = '<div class="dashboard-empty">Failed to load market prices.</div>';
    }
  })();

  // ── Section 9: Active market orders widget (optional) ────────────────────
  (async () => {
    const el = document.getElementById('dashboardMarketOrders');
    if (!el) return;
    try { await renderMarketOrdersWidget(el, accounts); }
    catch (e) {
      console.error('[dashboard] Market orders widget failed:', e);
      el.innerHTML = '<div class="active-jobs-empty">Failed to load orders.</div>';
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
        <div class="dash-kpi-value accent-purple">${d.assetsLoading ? '<span style="font-size:13px;color:var(--text-3);font-family:var(--mono);">Calculating...</span>' : formatISK(d.overallValue)}</div>
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
  const CHAR_COLORS   = ['--accent','--assets','--liquidisk','--warning','--danger','--tier-0'].map(getCSSVar);
  const growthFactors = [0.41,0.48,0.54,0.59,0.63,0.68,0.74,0.80,0.87,0.92,0.96,1.0];

  // Character lines: solid, no dots
  const charDatasets = top.map(({ acc, total }, i) => ({
    label: acc.characterName,
    data: growthFactors.map(f => Math.round(total * f)),
    borderColor: CHAR_COLORS[i % CHAR_COLORS.length],
    borderWidth: 1.5, borderDash: [], pointRadius: 0, pointHoverRadius: 4, fill: false, tension: 0.3,
  }));

  // Total line: neon red, solid, dot at every point
  if (top.length > 1) {
    const TOTAL_RED = '#ff2010';
    charDatasets.push({
      label: 'Total',
      data: growthFactors.map(f => Math.round(d.grandTotal * f)),
      borderColor: TOTAL_RED, borderWidth: 2, borderDash: [],
      pointBackgroundColor: TOTAL_RED, pointBorderColor: 'rgba(255,32,16,0.45)', pointBorderWidth: 3,
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

function renderDashboardUI(data, isCached = false) {
  const { accounts, mainAccount, overallValue, totalWallet, grandTotal, totalByChar, walletByChar } = data;
  const mainCharLabel = document.getElementById('dashboardMainCharName');

  if (mainCharLabel) {
    mainCharLabel.innerHTML = mainAccount
      ? `${escHtml(mainAccount.characterName)} ${isCached ? '<span style="color:var(--warning);font-size:9px;margin-left:8px;">[SYNCING FROM ESI...]</span>' : ''}`
      : 'No main character selected';
  }
  renderWealthWidgets({
    accounts: accounts || [], totalWallet: totalWallet || 0, overallValue: overallValue || 0,
    grandTotal: grandTotal || 0, totalByChar: totalByChar || {}, walletByChar: walletByChar || {},
    assetsLoading: false,
  });
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
        <div class="dash-pi-count-num" style="color:${nWarning > 0 ? '#e3a84d' : 'var(--text-3)'};">${nWarning}</div>
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
      `https://esi.evetech.net/v1/markets/10000002/history/?type_id=${typeId}&datasource=tranquility`
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
      <td class="aj-cell-item">${itemIcon}<span>${escHtml(name)}</span></td>
      <td><span class="mo-side ${isBuy ? 'mo-buy' : 'mo-sell'}">${isBuy ? 'BUY' : 'SELL'}</span></td>
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
          <tr><th>CHARACTER</th><th>ITEM</th><th>SIDE</th><th>PRICE</th><th>QTY REMAIN</th><th>EXPIRES</th></tr>
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

  const accountMap = Object.fromEntries(accounts.map(a => [String(a.characterId), a]));
  const jobs = [];
  for (const acc of accounts) {
    try {
      const list = await window.eveAPI.getCharacterActiveJobs(acc.characterId);
      if (Array.isArray(list)) list.forEach(j => jobs.push({ ...j, character_id: acc.characterId }));
    } catch (_) {}
    await new Promise(r => setTimeout(r, 60));
  }
  const active = jobs.filter(j => j.status === 'active' || j.status === 'ready' || j.status === 'paused');
  // Deterministic order (soonest-done first) so the dropdown and the auto-default
  // are stable across re-renders — ESI's job order is not guaranteed.
  active.sort((a, b) => (new Date(a.end_date) - new Date(b.end_date)) || (Number(a.job_id) - Number(b.job_id)));
  const typeNames = active.length
    ? await _resolveTypeNames([...new Set(active.map(j => j.product_type_id || j.blueprint_type_id).filter(Boolean))])
    : {};

  panels.forEach(panel => {
    const body = panel.querySelector('.dashboard-widget-body');
    if (body) _renderJobWatchInstance(body, panel.dataset.widgetId, active, accountMap, typeNames);
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

  // Resolve the watched job; fall back to the first when the saved one is gone
  // (delivered) or nothing is picked yet for this instance. Persist the choice —
  // including the auto-default — so re-renders (e.g. adding another Job Watch)
  // never silently change what this instance is watching.
  let selectedId = _getJobWatch(instId);
  let job = active.find(j => String(j.job_id) === String(selectedId));
  if (!job) { job = active[0]; selectedId = job.job_id; _setJobWatch(instId, job.job_id); }

  const options = active.map(j => {
    const acc = accountMap[String(j.character_id)] || {};
    const sel = String(j.job_id) === String(selectedId) ? 'selected' : '';
    return `<option value="${j.job_id}" ${sel}>${escHtml(labelFor(j))} · ${escHtml(acc.characterName || '')}</option>`;
  }).join('');

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
    <select class="jw-picker" onchange="dashJobWatchSelect('${instId}', this.value)" title="Pick a job to watch">
      ${options}
    </select>
    <div class="jw-card" data-start="${start}" data-end="${end}" data-status="${escHtml(job.status)}">
      <div class="jw-head">
        <img class="jw-icon" src="${icon64}" alt=""
             onerror="if(this.src==='${icon64}'){this.src='${iconBp}';}else{this.style.display='none';}"/>
        <div class="jw-head-info">
          <div class="jw-name" title="${escHtml(name)}">${escHtml(name)}</div>
          <div class="jw-sub"><span class="aj-activity-badge ${act.cls}">${act.label}</span>${runs ? ` · ${runs}` : ''}</div>
          <div class="jw-char">${escHtml(acc.characterName || '')}</div>
        </div>
      </div>
      <div class="jw-progress"><div class="jw-progress-fill" style="width:${pct.toFixed(2)}%"></div></div>
      <div class="jw-foot">
        <span class="jw-time">${timeText}</span>
        <span class="jw-end">ends ${escHtml(endStr)}</span>
      </div>
    </div>`;
}

function dashJobWatchSelect(instId, jobId) {
  _setJobWatch(instId, jobId ? Number(jobId) : null);
  window.eveAPI.getAccounts().then(accs => _renderAllJobWatch(accs || [])).catch(() => {});
}

// ─── Character Wallet widget (multi-instance) ──────────────────────────────────
// A per-character wallet card (portrait, name, ISK balance) — the same tile as the
// Wallets page, but addable to the dashboard one-per-character. Pick the character
// from the dropdown; clicking the card opens that character's wallet journal modal.
// The chosen character persists per instance in localStorage (map keyed by inst id).
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

  const options = accounts.map(a => {
    const sel = String(a.characterId) === cid ? 'selected' : '';
    return `<option value="${a.characterId}" ${sel}>${escHtml(a.characterName || `Char ${a.characterId}`)}</option>`;
  }).join('');

  body.innerHTML = `
    <select class="cw-picker" onchange="dashCharWalletSelect('${instId}', this.value)" title="Pick a character">
      ${options}
    </select>
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

function dashCharWalletSelect(instId, charId) {
  _setCharWallet(instId, charId || null);
  window.eveAPI.getAccounts().then(accs => _renderAllCharWallet(accs || [])).catch(() => {});
}