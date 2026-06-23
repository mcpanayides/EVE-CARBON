// ─── Settings Drawer ──────────────────────────────────────────────────────────

function setSettingsTab(tab) {
  currentSettingsTab = tab;
  document.querySelectorAll('.settings-menu-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.settingsTab === tab);
  });
  document.querySelectorAll('.settings-tab').forEach(panel => {
    const target = `settingsTab${tab.charAt(0).toUpperCase() + tab.slice(1)}`;
    panel.style.display = panel.id === target ? 'block' : 'none';
  });
  if (tab === 'general')    populateGeneralSettings();
  if (tab === 'jumpgates')  populateJumpgatesSettings();
  if (tab === 'database')   populateDatabaseSettings();
  if (tab === 'palette')    populatePaletteSettings();
  if (tab === 'background') populateBackgroundSettings();
}

// ─── General Settings Tab ──────────────────────────────────────────────────────
// "Start with Windows" and "Minimize to tray". Both apply immediately on toggle
// (no SAVE needed): launch-at-login is written to the OS, minimize-to-tray is
// persisted in config and the main process creates/removes the tray icon.
async function populateGeneralSettings() {
  const startToggle = document.getElementById('startWithWindowsToggle');
  const trayToggle  = document.getElementById('minimizeToTrayToggle');
  if (!startToggle || !trayToggle) return;

  try {
    const prefs = await window.eveAPI.getAppPreferences();
    startToggle.checked = !!prefs.launchAtLogin;
    trayToggle.checked  = !!prefs.minimizeToTray;
  } catch (_) { /* leave unchecked if prefs can't be read */ }

  startToggle.onchange = async () => {
    try {
      const enabled = await window.eveAPI.setLaunchAtLogin(startToggle.checked);
      startToggle.checked = !!enabled;   // reflect what actually took effect
      showToast(enabled ? 'EVE Carbon will start with Windows.'
                        : 'EVE Carbon will no longer start with Windows.', 'success');
    } catch (e) {
      startToggle.checked = !startToggle.checked;   // revert on failure
      showToast(`Couldn't update startup setting: ${e.message}`, 'error');
    }
  };

  trayToggle.onchange = async () => {
    try {
      const enabled = await window.eveAPI.setMinimizeToTray(trayToggle.checked);
      trayToggle.checked = !!enabled;
      showToast(enabled ? 'Minimizing will now hide EVE Carbon to the system tray.'
                        : 'Minimize to tray disabled.', 'success');
    } catch (e) {
      trayToggle.checked = !trayToggle.checked;
      showToast(`Couldn't update tray setting: ${e.message}`, 'error');
    }
  };
}

// ─── Jump Gates / Beacon Network Import ────────────────────────────────────────
// Imports a pasted jump-gate list (e.g. a Webway export) into the encrypted
// main-process bridge store the Jump Planner's Beacon mode reads (stored as
// [[idA, idB], …]). Not localStorage — the network can be sensitive alliance intel.
let _navGalaxyIndex = null;   // lowercase system name → solarSystemID

async function _navGetBridges() {
  try { return await window.eveAPI.getJumpBridges() || []; } catch (_) { return []; }
}
async function _navSaveBridges(b) {
  try { return await window.eveAPI.saveJumpBridges(b); }
  catch (e) { return { ok: false, error: e.message }; }
}

// Build a name→id index from the galaxy SDE once, so a whole list resolves locally
// without a per-name IPC round-trip.
async function _navLoadGalaxyIndex() {
  if (_navGalaxyIndex) return _navGalaxyIndex;
  const galaxy = await window.eveAPI.mapGetGalaxy().catch(() => null);
  const idx = {};
  if (galaxy && Array.isArray(galaxy.systems)) {
    for (const s of galaxy.systems) idx[String(s.name).toLowerCase()] = s.id;
  }
  _navGalaxyIndex = idx;
  return idx;
}

// A "System / POS" cell can be the bare system, "System @ 1-1" (POS moon notation),
// or "System - Moon - POS". The system is the leading token. We strip an "@ …"
// suffix and a " - …" suffix, but NOT bare hyphens — system names contain hyphens
// (MN-Q26, 1DQ1-A, G-ME2K), so only spaced " - " counts as a POS separator.
function _navCleanSystemName(cell) {
  let s = String(cell || '').trim();
  s = s.split(/\s*@\s*/)[0];     // "MN-Q26 @ 1-1" → "MN-Q26"
  s = s.split(/\s[-–]\s/)[0];    // "1DQ1-A - Moon 1 - POS" → "1DQ1-A"
  return s.trim();
}

function populateJumpgatesSettings() {
  const importBtn = document.getElementById('beaconImportBtn');
  const clearBtn  = document.getElementById('beaconClearBtn');
  if (importBtn && !importBtn._bound) { importBtn._bound = true; importBtn.addEventListener('click', importBeaconNetwork); }
  if (clearBtn  && !clearBtn._bound)  { clearBtn._bound  = true; clearBtn.addEventListener('click', clearBeaconNetwork); }
  _navUpdateGateCount();
}

async function _navUpdateGateCount() {
  const el = document.getElementById('beaconImportCount');
  if (el) el.textContent = `${(await _navGetBridges()).length} gates saved`;
}

async function importBeaconNetwork() {
  const ta       = document.getElementById('beaconImportInput');
  const resultEl = document.getElementById('beaconImportResult');
  const friendlyOnly = document.getElementById('beaconImportFriendlyOnly')?.checked;
  if (!ta || !ta.value.trim()) { showToast('Paste a gate list first.', 'error'); return; }

  const idx = await _navLoadGalaxyIndex();
  if (!idx || !Object.keys(idx).length) {
    showToast('Galaxy data unavailable — update the SDE in Settings → Database.', 'error');
    return;
  }
  const resolve = (cell) => idx[_navCleanSystemName(cell).toLowerCase()] ?? null;

  const existing = await _navGetBridges();
  const pairKey  = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const seen     = new Set(existing.map(([a, b]) => pairKey(a, b)));
  let added = 0, dup = 0, notFriendly = 0, unresolved = 0;
  const unresolvedNames = new Set();

  for (const raw of ta.value.split(/\r?\n/)) {
    if (!raw.includes('\t')) continue;            // title row / blank — needs columns
    const cols = raw.split('\t');
    const aRaw = cols[1], bRaw = cols[2];
    if (!aRaw || !bRaw) continue;
    if (/^region$/i.test((cols[0] || '').trim()) || /system\s*\/\s*pos/i.test(aRaw)) continue; // header

    if (friendlyOnly) {
      const fr = (cols[8] || '').trim().toLowerCase();
      if (fr && !/^(y|yes|true|1|friendly)$/.test(fr)) { notFriendly++; continue; }
    }

    const a = resolve(aRaw), b = resolve(bRaw);
    if (!a) unresolvedNames.add(_navCleanSystemName(aRaw));
    if (!b) unresolvedNames.add(_navCleanSystemName(bRaw));
    if (!a || !b) { unresolved++; continue; }
    if (a === b) continue;
    const k = pairKey(a, b);
    if (seen.has(k)) { dup++; continue; }
    seen.add(k);
    existing.push([a, b]);
    added++;
  }

  const saved = await _navSaveBridges(existing);
  await _navUpdateGateCount();
  if (typeof window.mapReloadBridges === 'function') window.mapReloadBridges();
  if (saved && saved.ok === false) {
    showToast(`Couldn't save the gate network to disk: ${saved.error || 'unknown error'}`, 'error');
  }

  const parts = [`✓ Imported ${added} gate${added === 1 ? '' : 's'}.`];
  if (dup)         parts.push(`${dup} already saved.`);
  if (notFriendly) parts.push(`${notFriendly} skipped (not friendly).`);
  if (unresolved)  parts.push(`${unresolved} row(s) skipped — system not found.`);
  if (unresolvedNames.size) {
    const names = [...unresolvedNames].filter(Boolean).slice(0, 15);
    parts.push(`Unresolved: ${names.join(', ')}${unresolvedNames.size > 15 ? '…' : ''}`);
  }
  if (resultEl) resultEl.textContent = parts.join('\n');
  showToast(`Imported ${added} gate${added === 1 ? '' : 's'} into the beacon network.`, added ? 'success' : 'info');
}

async function clearBeaconNetwork() {
  await _navSaveBridges([]);
  await _navUpdateGateCount();
  if (typeof window.mapReloadBridges === 'function') window.mapReloadBridges();
  const resultEl = document.getElementById('beaconImportResult');
  if (resultEl) resultEl.textContent = 'Beacon network cleared.';
  showToast('Beacon network cleared.', 'success');
}

// ─── Background wallpaper ─────────────────────────────────────────────────────
// Persisted in localStorage as { url, dim }. The image lives in a fixed
// full-screen layer behind the whole UI (see #appBackground). Non-destructive:
// "None" simply hides the layer and the original themed background returns.
const BG_STORAGE_KEY = 'appBackground';

function _getBgSettings() {
  try { return JSON.parse(localStorage.getItem(BG_STORAGE_KEY) || 'null') || {}; }
  catch (_) { return {}; }
}
function _saveBgSettings(s) {
  try { localStorage.setItem(BG_STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
}

function applyBackground(url, dim) {
  const bg = document.getElementById('appBackground');
  const ov = document.getElementById('appBackgroundOverlay');
  if (!bg) return;
  if (url) { bg.style.backgroundImage = `url("${url}")`; bg.style.display = 'block'; }
  else     { bg.style.backgroundImage = ''; bg.style.display = 'none'; }
  if (ov) ov.style.opacity = String((dim != null ? dim : 35) / 100);
}

// Restore the saved wallpaper at startup (called from app.js).
function initBackground() {
  const s = _getBgSettings();
  applyBackground(s.url || null, s.dim != null ? s.dim : 35);
}

function _renderBgGrid(grid, list, activeUrl) {
  if (!list.length) {
    grid.innerHTML = `<div class="bg-preset-empty">No images yet — use “Add image…” to choose one, or drop files into the app's <code>assets/backgrounds</code> folder.</div>`;
    return;
  }
  grid.innerHTML = '';
  list.forEach(bg => {
    const cell = document.createElement('div');
    cell.className = 'bg-preset' + (bg.url === activeUrl ? ' active' : '');
    cell.style.backgroundImage = `url("${bg.url}")`;
    cell.title = bg.name;
    cell.innerHTML = `<span class="bg-preset-label">${escHtml(bg.name)}</span>`;
    cell.addEventListener('click', () => {
      const cur = _getBgSettings();
      cur.url = bg.url;
      _saveBgSettings(cur);
      applyBackground(cur.url, cur.dim != null ? cur.dim : 35);
      grid.querySelectorAll('.bg-preset').forEach(c => c.classList.remove('active'));
      cell.classList.add('active');
    });
    grid.appendChild(cell);
  });
}

async function populateBackgroundSettings() {
  const grid      = document.getElementById('bgPresetGrid');
  const dimSlider = document.getElementById('bgDimSlider');
  const dimValue  = document.getElementById('bgDimValue');
  const pickBtn   = document.getElementById('bgPickBtn');
  const noneBtn   = document.getElementById('bgNoneBtn');
  if (!grid) return;

  const saved = _getBgSettings();

  if (dimSlider) {
    dimSlider.value = saved.dim != null ? saved.dim : 35;
    if (dimValue) dimValue.textContent = `${dimSlider.value}%`;
    dimSlider.oninput = () => {
      if (dimValue) dimValue.textContent = `${dimSlider.value}%`;
      const cur = _getBgSettings();
      cur.dim = Number(dimSlider.value);
      _saveBgSettings(cur);
      applyBackground(cur.url || null, cur.dim);
    };
  }

  let list = [];
  try { list = await window.eveAPI.listBackgrounds() || []; } catch (_) {}
  _renderBgGrid(grid, list, saved.url || null);

  if (pickBtn) pickBtn.onclick = async () => {
    try {
      const r = await window.eveAPI.pickBackground();
      if (r && !r.canceled && r.background) {
        const cur = _getBgSettings();
        cur.url = r.background.url;
        _saveBgSettings(cur);
        applyBackground(cur.url, cur.dim != null ? cur.dim : 35);
        await populateBackgroundSettings();
        showToast(`Background set: ${r.background.name}`, 'success');
      } else if (r && r.error) {
        showToast(`Couldn't add image: ${r.error}`, 'error');
      }
    } catch (e) { showToast(`Couldn't add image: ${e.message}`, 'error'); }
  };

  if (noneBtn) noneBtn.onclick = () => {
    const cur = _getBgSettings();
    cur.url = null;
    _saveBgSettings(cur);
    applyBackground(null, cur.dim != null ? cur.dim : 35);
    _renderBgGrid(grid, list, null);
  };
}

function bindUISettings() {
  const openBtn  = document.getElementById('openSettingsBtn');
  const drawer   = document.getElementById('uiSettingsDrawer');
  const saveBtn  = document.getElementById('saveSettingsBtn');
  const closeBtn = document.getElementById('closeSettingsBtn');

  if (openBtn) {
    openBtn.addEventListener('click', async () => {
      if (drawer) {
        drawer.style.display = 'flex';
        await populateSettingsInputs();
        setSettingsTab(currentSettingsTab);
      }
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => { if (drawer) drawer.style.display = 'none'; });
  }
  drawer?.addEventListener('click', e => { if (e.target === drawer) drawer.style.display = 'none'; });
  document.querySelectorAll('.settings-menu-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.settingsTab) setSettingsTab(btn.dataset.settingsTab); });
  });
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      await saveAllSettings();
      if (drawer) drawer.style.display = 'none';
      showToast('Settings saved.', 'success');
    });
  }
}

async function populateSettingsInputs() {
  await populateJabberSettings();
  if (currentSettingsTab === 'database') await populateDatabaseSettings();
  if (currentSettingsTab === 'palette')  await populatePaletteSettings();
}

async function saveAllSettings() {
  const jabber = gatherJabberSettings();
  await window.eveAPI.saveAppConfig({ jabber });
  // Reload SIG/comms data whenever settings are saved so a pack change takes
  // effect immediately without requiring an app restart.
  if (typeof loadJabberSigsMap === 'function')     loadJabberSigsMap();
  if (typeof loadJabberCommsChannels === 'function') loadJabberCommsChannels();
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function bindNavigation() {
  const toggleBtn = document.getElementById('navToggleBtn');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleNavigation);

  // Reopen the sidebar in whatever state it was left in last session.
  restoreNavCollapsed();

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateToPage(btn.dataset.page));
  });

  const industryMenuBtn = document.getElementById('industryMenuBtn');
  const industryMenu    = document.getElementById('industryMenu');
  if (industryMenuBtn && industryMenu) {
    industryMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      industryMenu.style.display = industryMenu.style.display === 'flex' ? 'none' : 'flex';
    });
    industryMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('.industry-menu-btn');
      if (!btn) return;
      e.stopPropagation();
      if (btn.id === 'menuMyBlueprints') toggleLibraryView();
      else if (btn.dataset?.page) navigateToPage(btn.dataset.page);
      industryMenu.style.display = 'none';
    });
    document.addEventListener('click', () => { industryMenu.style.display = 'none'; });
  }
}

const NAV_COLLAPSED_KEY = 'nav_collapsed';

// Apply the collapsed/expanded state to the DOM. Shared by the toggle and the
// startup restore so both stay in sync.
function _applyNavCollapsed(collapsed) {
  navCollapsed = collapsed;
  const nav       = document.getElementById('sidebarNav');
  const toggleBtn = document.getElementById('navToggleBtn');
  const sidebar   = document.querySelector('.sidebar');
  if (collapsed) {
    nav?.classList.add('nav-collapsed');
    // Collapse the whole column, not just the nav list, so the sidebar
    // actually narrows to icon width and the main content reflows wider.
    sidebar?.classList.add('nav-collapsed');
    toggleBtn?.classList.add('collapsed');
    if (toggleBtn) toggleBtn.textContent = 'chevron_right';   // click to expand
  } else {
    nav?.classList.remove('nav-collapsed');
    sidebar?.classList.remove('nav-collapsed');
    toggleBtn?.classList.remove('collapsed');
    if (toggleBtn) toggleBtn.textContent = 'chevron_left';    // click to collapse
  }
}

function toggleNavigation() {
  _applyNavCollapsed(!navCollapsed);
  // Remember the choice so the sidebar opens the same way next launch.
  try { localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? '1' : '0'); } catch (_) {}
}

// Restore the saved collapsed/expanded state on startup (called from bindNavigation).
function restoreNavCollapsed() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(NAV_COLLAPSED_KEY) === '1'; } catch (_) {}
  if (collapsed) _applyNavCollapsed(true);
}

function navigateToPage(page) {
  const mainLibrary = document.getElementById('mainLibraryView');
  if (mainLibrary) mainLibrary.style.display = 'none';

  const pagesContainer = document.getElementById('navPagesContainer');
  if (pagesContainer) pagesContainer.style.display = 'flex';

  document.querySelectorAll('.nav-page').forEach(p => p.classList.remove('active'));
  const selectedPage = document.getElementById(`page-${page}`);
  if (selectedPage) selectedPage.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  currentPage = page;

  // Keep character data fresh automatically — no manual "sync" button needed.
  if (typeof autoSyncOnNavigate === 'function') autoSyncOnNavigate();

  if (page === 'characters') loadAccounts();
  if (page === 'dashboard')  loadDashboard();
  if (page === 'assets')     loadAssets();
  if (page === 'wallets')    renderWallets();
  if (page === 'industry')   initIndustryPage();
  if (page === 'pi')       { loadPlanetaryInteraction(); if (typeof _autoSyncPIIfStale === 'function') _autoSyncPIIfStale(); }
  if (page === 'jabber')     loadJabberHistory();
  if (page === 'map')        initMapPage();
  if (page === 'market')     renderMarket();
}

// Re-render the open data page after a background sync so new data shows without a
// manual reload. Read-only renders — these must not re-trigger a sync.
function refreshCurrentDataView() {
  if (currentPage === 'assets'  && typeof loadAssets     === 'function') loadAssets();
  else if (currentPage === 'wallets' && typeof renderWallets === 'function') renderWallets();
}

// ─── Nav Status Lights ────────────────────────────────────────────────────────

function setNavStatusLight(id, online) {
  const status = document.getElementById(id);
  if (!status) return;
  const light = status.querySelector('.status-light');
  if (!light) return;
  light.classList.toggle('status-online', online);
  light.classList.toggle('status-offline', !online);
  light.title = online ? 'Connected' : 'Disconnected';
}

function updateNavStatusIndicators() {
  setNavStatusLight('jabberNavStatus', jabberConnected);
}

function updateNavCharacterBtn(account) {
  const btn = document.querySelector('.nav-btn-characters');
  if (!btn) return;
  btn.innerHTML = '';
  if (account) {
    const img = document.createElement('img');
    img.className = 'nav-icon-portrait';
    img.alt = account.characterName;
    img.onerror = function () {
      this.onerror = null;
      const tried = this.dataset.tried || '';
      if (!tried.includes('64')) {
        this.dataset.tried = tried + ' 64';
        this.src = `https://images.evetech.net/characters/${account.characterId}/portrait?size=64`;
      } else {
        this.style.display = 'none';
      }
    };
    img.src = `https://images.evetech.net/characters/${account.characterId}/portrait?size=128`;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'nav-active-char-name';
    nameSpan.textContent = account.characterName;
    btn.appendChild(img);
    btn.appendChild(nameSpan);
    btn.title = `Active: ${account.characterName}`;
  } else {
    const icon = document.createElement('span');
    icon.className = 'nav-icon';
    icon.textContent = '⚔';
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = 'Characters';
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.title = 'Characters';
  }
}

function toggleLibraryView() {
  const library   = document.getElementById('mainLibraryView');
  const toggleBtn = document.getElementById('toggleLibraryBtn');
  if (!library || !toggleBtn) return;
  isLibraryVisible = !isLibraryVisible;
  library.style.display = isLibraryVisible ? 'flex' : 'none';
  toggleBtn.textContent = isLibraryVisible ? 'Hide my blueprint library' : 'Show my blueprint library';
  toggleBtn.title       = toggleBtn.textContent;
}

function clearSelection() {
  const card = document.getElementById('selectedBpCard');
  if (!card) return;
  card.style.display = 'none';
  document.getElementById('selectedBpIcon').src = '';
  document.getElementById('selectedBpName').textContent = '';
  document.getElementById('selectedBpMeta').textContent = '';
}
// ─── Database Settings Tab ─────────────────────────────────────────────────────

// Called when the Database tab becomes visible — populates both last-synced timestamps.
async function populateDatabaseSettings() {
  const npcEl    = document.getElementById('dbSyncLastSynced');
  const upwellEl = document.getElementById('dbUpwellLastSynced');
  try {
    // IPC: getStationSyncTimestamp({ key }) returns ms epoch or 0
    const npcTs    = await window.eveAPI.getStationSyncTimestamp({ key: 'npc_stations' });
    const upwellTs = await window.eveAPI.getStationSyncTimestamp({ key: 'upwell_structures' });
    if (npcEl)    npcEl.textContent    = npcTs    ? _formatSyncAge(npcTs)    : 'Never synced';
    if (upwellEl) upwellEl.textContent = upwellTs ? _formatSyncAge(upwellTs) : 'Never synced';
  } catch {
    if (npcEl)    npcEl.textContent    = 'Unknown';
    if (upwellEl) upwellEl.textContent = 'Unknown';
  }
}

// Format a ms-epoch timestamp as a human-readable age string.
function _formatSyncAge(ts) {
  const diff = Date.now() - ts;
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  <  2)  return 'Just now';
  if (hours <  1)  return `${mins} minutes ago`;
  if (days  <  1)  return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

// Triggered by the SYNC UPWELL STRUCTURES button.
// Mirrors triggerStationSync() but targets the Upwell table.
async function triggerUpwellSync() {
  const btn      = document.getElementById('dbSyncUpwellBtn');
  const icon     = document.getElementById('dbUpwellBtnIcon');
  const status   = document.getElementById('dbUpwellStatus');
  const progress = document.getElementById('dbUpwellProgressWrap');
  const progBar  = document.getElementById('dbUpwellProgressBar');
  const progLbl  = document.getElementById('dbUpwellProgressLabel');
  const lastEl   = document.getElementById('dbUpwellLastSynced');

  if (!btn || btn.disabled) return;

  btn.disabled      = true;
  btn.style.opacity = '0.6';
  btn.style.cursor  = 'not-allowed';
  if (icon)    icon.style.animation    = 'spin 1s linear infinite';
  if (status)  status.textContent      = 'Starting sync…';
  if (progress) progress.style.display = 'block';

  const stages = [
    { pct: 20, label: 'Checking local Upwell structure database…',      delay:     0 },
    { pct: 85, label: 'Re-resolving structures with incomplete geo data…', delay:  5000 },
  ];
  const stageTimers = stages.map(s =>
    setTimeout(() => {
      if (progBar) progBar.style.width = `${s.pct}%`;
      if (progLbl) progLbl.textContent = s.label;
      if (status)  status.textContent  = `${s.pct}% complete…`;
    }, s.delay)
  );

  try {
    const result = await window.eveAPI.syncUpwellDatabase({ force: true });
    stageTimers.forEach(clearTimeout);

    if (result && !result.error) {
      if (progBar) progBar.style.width = '100%';
      if (progLbl) progLbl.textContent = result.upwell > 0
        ? `Done — ${result.upwell} Upwell structures in local database.`
        : 'Re-resolve complete. Structures populate automatically as characters sync.';
      if (status)  status.textContent  = '✓ Complete';
      if (lastEl)  lastEl.textContent  = 'Just now';
      showToast(
        result.upwell > 0
          ? `Upwell sync: ${result.upwell} structures in local DB.`
          : 'Upwell re-resolve complete. Structures seed automatically during character syncs.',
        'success'
      );
    } else {
      if (progBar) progBar.style.width = '100%';
      if (progLbl) progLbl.textContent = result?.error ? `Error: ${result.error}` : 'Already up to date.';
      if (status)  status.textContent  = result?.error ? '✗ Sync failed' : '✓ Already fresh';
      if (!result?.error) showToast('Upwell structure list is already up to date.', 'info');
    }
  } catch (e) {
    stageTimers.forEach(clearTimeout);
    if (progBar) { progBar.style.width = '100%'; progBar.style.background = 'var(--danger)'; }
    if (progLbl) progLbl.textContent = `Error: ${e.message}`;
    if (status)  status.textContent  = '✗ Sync failed';
    showToast(`Upwell sync failed: ${e.message}`, 'error');
  } finally {
    setTimeout(() => {
      btn.disabled      = false;
      btn.style.opacity = '';
      btn.style.cursor  = '';
      if (icon) icon.style.animation = '';
      setTimeout(() => {
        if (progress) progress.style.display = 'none';
        if (progBar)  { progBar.style.width = '0%'; progBar.style.background = ''; }
        if (progLbl)  progLbl.textContent = '';
        if (status)   status.textContent  = '';
      }, 4000);
    }, 3000);
  }
}

// ─── First-run auto-seed ───────────────────────────────────────────────────────
// Called once from app.js on startup (after the DB is initialised).
// If npc_stations has never been synced, kicks off a silent background seed
// so the app has location data available without the user needing to open Settings.
async function autoSeedNpcStations() {
  try {
    const ts = await window.eveAPI.getStationSyncTimestamp({ key: 'npc_stations' });
    if (ts && ts > 0) return; // already seeded — nothing to do

    console.log('[AutoSeed] npc_stations table is empty — running first-run seed…');
    showToast('First launch: seeding NPC station database in the background…', 'info');

    const result = await window.eveAPI.syncStationDatabase({ force: false }); // force:false respects 24-hr guard on subsequent calls
    if (result && !result.skipped && !result.error) {
      console.log(`[AutoSeed] Seed complete — ${result.npc} NPC stations loaded.`);
      showToast(`Station database ready: ${result.npc} NPC stations loaded.`, 'success');
    } else if (result?.error) {
      console.warn('[AutoSeed] Seed failed:', result.error);
    }
  } catch (e) {
    console.warn('[AutoSeed] autoSeedNpcStations error:', e.message);
  }
}
async function triggerStationSync() {
  const btn      = document.getElementById('dbSyncStationsBtn');
  const icon     = document.getElementById('dbSyncBtnIcon');
  const status   = document.getElementById('dbSyncStatus');
  const progress = document.getElementById('dbSyncProgressWrap');
  const progBar  = document.getElementById('dbSyncProgressBar');
  const progLbl  = document.getElementById('dbSyncProgressLabel');
  const lastEl   = document.getElementById('dbSyncLastSynced');

  if (!btn) return;
  if (btn.disabled) return; // already running

  // ── Lock UI ─────────────────────────────────────────────────────────────────
  btn.disabled    = true;
  btn.style.opacity = '0.6';
  btn.style.cursor  = 'not-allowed';
  if (icon)    icon.style.animation = 'spin 1s linear infinite';
  if (status)  status.textContent   = 'Starting sync…';
  if (progress) progress.style.display = 'block';

  // Animate the progress bar in two stages while the backend runs.
  // Typical sync duration is 30-60 s (Hoboleaks download + ESI name resolution):
  //   0 → 20%  immediately (downloading Hoboleaks SDE station list)
  //   20 → 85% over 20 s  (bulk ESI name resolution for systems/regions)
  //   85 → 99% hold until IPC resolves
  const stages = [
    { pct: 20,  label: 'Downloading NPC station list from Hoboleaks SDE…', delay:     0 },
    { pct: 85,  label: 'Resolving system and region names via ESI…',       delay: 20000 },
  ];
  let stageTimers = [];
  for (const s of stages) {
    const t = setTimeout(() => {
      if (progBar) progBar.style.width = `${s.pct}%`;
      if (progLbl) progLbl.textContent = s.label;
      if (status)  status.textContent  = `${s.pct}% complete…`;
    }, s.delay);
    stageTimers.push(t);
  }

  try {
    // This call blocks until syncStationDatabase() resolves (can be 5+ min).
    const result = await window.eveAPI.syncStationDatabase({ force: true });

    // Clear staged timers — we're done
    stageTimers.forEach(clearTimeout);

    if (result && !result.skipped) {
      if (progBar) progBar.style.width = '100%';
      if (progLbl) progLbl.textContent = `Done — ${result.npc} NPC stations synced.`;
      if (status)  status.textContent  = '✓ Sync complete';
      if (lastEl)  lastEl.textContent  = 'Just now';
      showToast(`Station sync complete: ${result.npc} NPC stations.`, 'success');
    } else {
      if (progBar) progBar.style.width = '100%';
      if (progLbl) progLbl.textContent = result?.error ? `Error: ${result.error}` : 'Already up to date.';
      if (status)  status.textContent  = result?.error ? '✗ Sync failed' : '✓ Already fresh';
      if (!result?.error) showToast('Station list is already up to date.', 'info');
    }
  } catch (e) {
    stageTimers.forEach(clearTimeout);
    if (progBar) progBar.style.width = '100%';
    if (progBar) progBar.style.background = 'var(--danger)';
    if (progLbl) progLbl.textContent = `Error: ${e.message}`;
    if (status)  status.textContent  = '✗ Sync failed';
    showToast(`Station sync failed: ${e.message}`, 'error');
  } finally {
    // ── Unlock UI after 3 s so the user can read the result ──────────────────
    setTimeout(() => {
      btn.disabled      = false;
      btn.style.opacity = '';
      btn.style.cursor  = '';
      if (icon) icon.style.animation = '';
      // Hide progress bar and reset for next run
      setTimeout(() => {
        if (progress) progress.style.display = 'none';
        if (progBar)  { progBar.style.width = '0%'; progBar.style.background = ''; }
        if (progLbl)  progLbl.textContent = '';
        if (status)   status.textContent  = '';
      }, 4000);
    }, 3000);
  }
}