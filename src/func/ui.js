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
  if (tab === 'background') { populateBackgroundSettings(); populateGlassSettings(); }
}

// ─── General Settings Tab ──────────────────────────────────────────────────────
// "Start with Windows" and "Minimize to tray". Both apply immediately on toggle
// (no SAVE needed) and both are persisted in config: launch-at-login is also
// written to the OS (see the note on set-launch-at-login in main.js — Electron
// can't read its own Windows entry back on a path containing spaces, so config
// is what the switch reflects), and minimize-to-tray makes the main process
// create or remove the tray icon.
async function populateGeneralSettings() {
  const startToggle    = document.getElementById('startWithWindowsToggle');
  const trayToggle     = document.getElementById('minimizeToTrayToggle');
  if (!startToggle || !trayToggle) return;

  try {
    const prefs = await window.eveAPI.getAppPreferences();
    startToggle.checked = !!prefs.launchAtLogin;
    trayToggle.checked  = !!prefs.minimizeToTray;
  } catch (_) { /* leave unchecked if prefs can't be read */ }

  startToggle.onchange = async () => {
    try {
      const enabled = await window.eveAPI.setLaunchAtLogin(startToggle.checked);
      startToggle.checked = !!enabled;   // reflect the setting that was recorded
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

  await populateFileLogSetting();
  await populateDemoModeSetting();
}

// ─── Diagnostic log toggle ────────────────────────────────────────────────────
// Applies immediately, unlike Demo Mode — the file opens or closes on the spot,
// so there is nothing to restart for. The notice line carries the two facts that
// decide whether someone trusts it: how big the file has got, and that it is
// scrubbed before anything is written.
async function populateFileLogSetting() {
  const toggle  = document.getElementById('fileLogToggle');
  const notice  = document.getElementById('fileLogNotice');
  const actions = document.getElementById('fileLogActions');
  if (!toggle || !notice || !actions) return;
  if (!window.eveAPI?.logGetState) { toggle.closest('.settings-toggle-row')?.remove(); return; }

  const size = (bytes) => (bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

  const paint = (state) => {
    toggle.checked = !!state.enabled;
    actions.style.display = state.exists ? 'flex' : 'none';
    if (state.enabled) {
      notice.style.display = '';
      notice.textContent = state.exists
        ? `Recording to ${state.path} · ${size(state.bytes)}`
        : `Recording to ${state.path}`;
    } else if (state.exists) {
      notice.style.display = '';
      notice.textContent = `Not recording. An earlier log is still on disk (${size(state.bytes)}).`;
    } else {
      notice.style.display = 'none';
      notice.textContent = '';
    }
  };

  try { paint(await window.eveAPI.logGetState()); }
  catch (_) { return; }

  toggle.onchange = async () => {
    const wanted = toggle.checked;
    try {
      const state = await window.eveAPI.logSetEnabled(wanted);
      paint(state);
      showToast(wanted
        ? 'Diagnostic logging on. Reproduce the problem, then use Report a Bug.'
        : 'Diagnostic logging off.', 'success');
    } catch (e) {
      toggle.checked = !wanted;
      showToast(`Couldn't change logging: ${e.message}`, 'error');
    }
  };

  document.getElementById('fileLogRevealBtn').onclick = async () => {
    try { await window.eveAPI.logReveal(); }
    catch (e) { showToast(`Couldn't open the log folder: ${e.message}`, 'error'); }
  };

  document.getElementById('fileLogClearBtn').onclick = async () => {
    if (!confirm('Delete the diagnostic log and start a fresh one?')) return;
    try { paint(await window.eveAPI.logClear()); showToast('Log cleared.', 'success'); }
    catch (e) { showToast(`Couldn't clear the log: ${e.message}`, 'error'); }
  };
}

// ─── Demo Mode toggle ─────────────────────────────────────────────────────────
// Unlike the two switches above, this one CANNOT apply immediately: which
// profile the app runs against is decided at boot, before any window exists
// (see src/demo_mode.js). So the toggle persists the choice and offers a
// restart, and the notice line underneath always says which state you're
// actually in versus which you've asked for.
async function populateDemoModeSetting() {
  const toggle = document.getElementById('demoModeToggle');
  const notice = document.getElementById('demoModeNotice');
  if (!toggle || !notice) return;
  if (!window.eveAPI?.getDemoMode) { toggle.closest('.settings-toggle-row')?.remove(); return; }

  const paint = (state) => {
    toggle.checked  = !!state.enabled;
    toggle.disabled = !!state.forced;
    if (state.forced) {
      // Launched with --demo or EVE_CARBON_DEMO: the flag outranks the toggle,
      // so showing an operable switch would be a lie.
      notice.style.display = '';
      notice.textContent = 'Forced on by the --demo command-line flag — the toggle is ignored this session.';
      return;
    }
    if (!!state.enabled !== !!state.active) {
      notice.style.display = '';
      notice.textContent = state.enabled
        ? 'Restart EVE Carbon to switch to the demo profile.'
        : 'Restart EVE Carbon to return to your real profile.';
      return;
    }
    if (state.active) {
      notice.style.display = '';
      notice.textContent = 'Demo profile is active — nothing here is your real data.';
      return;
    }
    notice.style.display = 'none';
    notice.textContent = '';
  };

  try { paint(await window.eveAPI.getDemoMode()); }
  catch (_) { return; }

  toggle.onchange = async () => {
    const wanted = toggle.checked;
    try {
      const state = await window.eveAPI.setDemoMode(wanted);
      paint({ ...state, forced: false });
      if (state.restartRequired) {
        const msg = wanted
          ? 'Demo mode on. Restart to load the demo profile.'
          : 'Demo mode off. Restart to return to your real profile.';
        showToast(msg, 'success');
        if (window.eveAPI.restartApp && confirm(`${msg}\n\nRestart now?`)) {
          await window.eveAPI.restartApp();
        }
      }
    } catch (e) {
      toggle.checked = !wanted;   // revert — nothing was persisted
      showToast(`Couldn't update demo mode: ${e.message}`, 'error');
    }
  };
}

// ─── PLEX for Good (nav) ────────────────────────────────────────────────────────
// Deliberately NOT embedded — the page takes payment/credit-card details, and
// that belongs in the user's real browser, not an in-app webview.
const PLEX_FOR_GOOD_URL = 'https://www.eveonline.com/plex-for-good?campaign=plex-for-good-ever-green';

function openPlexForGood() {
  try { window.eveAPI.openExternalUrl(PLEX_FOR_GOOD_URL); } catch (_) {}
}

// ─── EVE service status (nav) ───────────────────────────────────────────────────
// Green dot + live player count from ESI's public Tranquility status endpoint,
// mirroring the Jabber nav light. Red when the server is unreachable (downtime)
// or in VIP mode. Clicking opens CCP's status page.
const EVE_STATUS_PAGE = 'https://status.eveonline.com';

function openEveStatusPage() {
  try { window.eveAPI.openExternalUrl(EVE_STATUS_PAGE); } catch (_) {}
}

// In-app modal (forums/fleet-fight pattern): status page embedded in a webview,
// with reload + pop-out-to-browser. Keeps the user in the app when possible.
function openEveStatusModal() {
  const bd = document.getElementById('eveStatusBackdrop');
  const wv = document.getElementById('eveStatusWebview');
  if (!bd) { openEveStatusPage(); return; }   // markup missing — browser fallback
  if (wv && !wv.getAttribute('src')) wv.setAttribute('src', EVE_STATUS_PAGE);
  bd.style.display = 'flex';
}

function closeEveStatusModal() {
  const bd = document.getElementById('eveStatusBackdrop');
  if (bd) bd.style.display = 'none';
}

function eveStatusModalNav(action) {
  if (action === 'external') { openEveStatusPage(); return; }
  const wv = document.getElementById('eveStatusWebview');
  if (action === 'reload' && wv) { try { wv.reload(); } catch (_) {} }
}

async function _pollEveStatus() {
  const light = document.getElementById('eveStatusLight');
  const count = document.getElementById('eveStatusCount');
  if (!light) return;
  try {
    const res = await fetch(Esi.url('/status'),
                            { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s  = await res.json();
    const up = !s.vip;   // VIP mode = staff-only — treat as down for players
    light.classList.toggle('status-online',  up);
    light.classList.toggle('status-offline', !up);
    light.title = up ? 'Tranquility: online' : 'Tranquility: VIP mode (staff only)';
    if (count) count.textContent = typeof s.players === 'number' ? s.players.toLocaleString() : '';
  } catch (_) {
    light.classList.remove('status-online');
    light.classList.add('status-offline');
    light.title = 'Tranquility: unreachable (downtime?)';
    if (count) count.textContent = '';
  }
}

(function initEveStatusNav() {
  if (!document.getElementById('eveStatusLight')) return;
  _pollEveStatus();
  setInterval(_pollEveStatus, 60 * 1000);   // ESI caches this ~30s; 1 min is polite
})();

// ─── Discord invite (bottom nav) ────────────────────────────────────────────────
// The nav's Discord button opens this invite in the OS browser. Set the link
// here — leaving it empty makes the button explain itself instead of erroring.
const DISCORD_INVITE_URL = 'https://discord.gg/KpCMBZNenD';

function openDiscordInvite() {
  if (!DISCORD_INVITE_URL) {
    showToast('Discord invite not configured yet — set DISCORD_INVITE_URL in src/func/ui.js.', 'error');
    return;
  }
  try { window.eveAPI.openExternalUrl(DISCORD_INVITE_URL); } catch (_) {}
}

// ─── Status-bar presence counter ("N ONLINE") ──────────────────────────────────
// Fed by the main process's anonymous heartbeat (src/presence.js). Hidden when
// the feature is unconfigured, opted out, or the endpoint is unreachable.
// [major, minor, patch]; anything unparsable sorts last.
function _presenceVersionParts(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}

/**
 * The tooltip rows: the three newest releases named individually, everything
 * else folded into "Other".
 *
 * Ranked by version NUMBER rather than by popularity, because the question this
 * answers is "have people moved to the current release" — the newest build has
 * to be a named row even when almost nobody is on it yet. "Other" merges older
 * releases with the unknown bucket on purpose: both mean "not on a current
 * build", and a client too old to report its version is the furthest behind of
 * all.
 */
function _presenceVersionRows(versions, topN = 3) {
  if (!versions || typeof versions !== 'object') return [];
  const named = Object.entries(versions)
    .filter(([v, n]) => v !== 'unknown' && Number(n) > 0 && _presenceVersionParts(v)[0] >= 0)
    .sort((a, b) => {
      const A = _presenceVersionParts(a[0]), B = _presenceVersionParts(b[0]);
      return (B[0] - A[0]) || (B[1] - A[1]) || (B[2] - A[2]) || a[0].localeCompare(b[0]);
    });

  const rows = named.slice(0, topN).map(([label, count]) => ({ label, count: Number(count) }));
  const other = Object.entries(versions)
    .filter(([, n]) => Number(n) > 0)
    .reduce((sum, [v, n]) => sum + (rows.some(r => r.label === v) ? 0 : Number(n)), 0);
  if (other > 0) rows.push({ label: 'Other', count: other });
  return rows;
}

function _updatePresenceCount(payload) {
  const wrap  = document.getElementById('presenceStatus');
  const label = document.getElementById('presenceCountLabel');
  if (!wrap || !label) return;

  // Accepts either the plain number this used to receive or the richer payload
  // the heartbeat sends now, so a stale renderer never blanks the counter.
  const n = (payload && typeof payload === 'object') ? payload.count : payload;
  const versions = (payload && typeof payload === 'object') ? payload.versions : null;

  if (typeof n === 'number' && n > 0) {
    label.textContent  = `${n.toLocaleString()} ONLINE`;
    wrap.style.display = 'inline-flex';

    const rows = _presenceVersionRows(versions);
    wrap.title = rows.length
      ? `${n.toLocaleString()} running EVE Carbon right now\n\n`
        + rows.map(r => `${r.label} — ${r.count.toLocaleString()} user${r.count === 1 ? '' : 's'}`).join('\n')
      : `${n.toLocaleString()} running EVE Carbon right now`;
  } else {
    wrap.style.display = 'none';
    wrap.removeAttribute('title');
  }
}
(function initPresenceCounterUI() {
  try {
    window.eveAPI?.on?.('presence-count', p => _updatePresenceCount(p));
    window.eveAPI?.getPresenceCount?.().then(_updatePresenceCount).catch(() => {});
    // Say why the counter is missing. A hidden counter looks the same whether the
    // feature was never configured, the endpoint is down, or nobody else is
    // online — and in a packaged build the main-process log is out of reach.
    window.eveAPI?.getPresenceState?.().then(st => {
      if (!st || typeof logToConsole !== 'function') return;
      if (!st.configured) {
        logToConsole('Online counter off — no presence endpoint configured in this build.', 'info');
      } else if (st.lastError) {
        logToConsole(`Online counter unavailable — ${st.url} did not answer (${st.lastError}).`, 'warning');
      }
    }).catch(() => {});
  } catch (_) { /* preload not available (tests) */ }
})();

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
const BG_DEFAULT_DIM = 0;   // default wallpaper dim (Citadel Overlook ships un-dimmed)

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
  if (ov) ov.style.opacity = String((dim != null ? dim : BG_DEFAULT_DIM) / 100);
}

// Restore the saved wallpaper at startup (called from app.js).
function initBackground() {
  // True first run (nothing ever saved): default to the Citadel Overlook
  // wallpaper. Resolved lazily and deferred to idle so it never competes with
  // SDE/DB init or the first-paint IPC burst (see resfile_backgrounds.js note).
  if (localStorage.getItem(BG_STORAGE_KEY) == null) { _applyDefaultBackground(); return; }
  const s = _getBgSettings();
  applyBackground(s.url || null, s.dim != null ? s.dim : BG_DEFAULT_DIM);
}

// First-run wallpaper: set the (un-dimmed) default immediately, then fetch the
// Citadel Overlook plate from CCP's resfile CDN once the app is idle and swap it
// in. Best-effort — if offline, nothing is saved and it retries next launch.
function _applyDefaultBackground() {
  applyBackground(null, BG_DEFAULT_DIM);
  const run = async () => {
    try {
      const list = await window.eveAPI.listBackgrounds() || [];
      const citadel = list.find(b => b.id === 'resfile:citadel-overlook');
      if (!citadel) return;
      const s = { url: citadel.url, dim: BG_DEFAULT_DIM };
      _saveBgSettings(s);
      applyBackground(s.url, s.dim);
    } catch (_) { /* offline / CDN hiccup — retried on next launch */ }
  };
  if (window.requestIdleCallback) requestIdleCallback(() => run(), { timeout: 6000 });
  else setTimeout(run, 3000);
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
      applyBackground(cur.url, cur.dim != null ? cur.dim : BG_DEFAULT_DIM);
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
    dimSlider.value = saved.dim != null ? saved.dim : BG_DEFAULT_DIM;
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
        applyBackground(cur.url, cur.dim != null ? cur.dim : BG_DEFAULT_DIM);
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
    applyBackground(null, cur.dim != null ? cur.dim : BG_DEFAULT_DIM);
    _renderBgGrid(grid, list, null);
  };
}

// ─── Reeded glass (spatial UI) ────────────────────────────────────────────────
// Persisted in localStorage as { enabled, tintRgb, tintAlpha, bgAlpha, blurScale }.
// A bootstrap script in index.html applies the saved state before first paint;
// everything here is the live Settings wiring. The OS-level acrylic material is
// toggled over IPC (main.js); the CSS layer works standalone as a fallback.
const GLASS_STORAGE_KEY = 'eve-glass';
// tintMode: 'system' follows the OS accent colour (Windows/macOS colourway);
// 'custom' uses the colour picker. One tint drives everything: glass surfaces
// (darkened) AND the ambient radial glows (full strength).
const GLASS_DEFAULTS = { enabled: true, tintMode: 'custom', tintRgb: '43, 114, 115', tintAlpha: 0.45, bgAlpha: 0.15, blurScale: 1.45 };

// The ambient glow variables that follow the tint in glass mode
const GLASS_GLOW_ALPHAS = {
  '--glow-body-a1': 0.42, '--glow-body-a2': 0.22, '--glow-body-a3': 0.07,
  '--glow-body-b1': 0.08, '--glow-body-b2': 0.14,
  '--glow-main-1':  0.50, '--glow-main-2':  0.32, '--glow-main-3':  0.08,
  '--glow-sec-1':   0.08, '--glow-sec-2':   0.26,
};

function _getGlassSettings() {
  try { return { ...GLASS_DEFAULTS, ...(JSON.parse(localStorage.getItem(GLASS_STORAGE_KEY) || 'null') || {}) }; }
  catch (_) { return { ...GLASS_DEFAULTS }; }
}
function _saveGlassSettings(s) {
  try { localStorage.setItem(GLASS_STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
}

async function applyGlass(s) {
  const root = document.documentElement.style;
  document.body.classList.toggle('glass-on', !!s.enabled);
  // Panel opacity is ONE setting taking one of two paths. Under glass,
  // --glass-tint-alpha below drives it (glass.css declares the --bg-* tokens on
  // body.glass-on). Without glass, nothing declares them there, so the inline
  // :root overrides in palette.js apply instead. Re-run on every change so
  // toggling glass hands over cleanly rather than leaving a stale override.
  if (typeof applyUiTransparency === 'function') applyUiTransparency();

  // Resolve the tint: OS accent colour, or the custom pick
  let rgb = _rgbStrToArr(s.tintRgb) || [138, 77, 190];
  if (s.tintMode !== 'custom') {
    try {
      const accent = await window.eveAPI?.glassGetAccent?.();
      const arr = accent && _rgbStrToArr(_hexToRgbStr(accent));
      if (arr) rgb = arr;
    } catch { /* fall back to stored colour */ }
  }

  // Surfaces get the tint darkened way down (glass stays dark, hue shows);
  // the ambient glows get it at full saturation.
  const glowRgb    = rgb.join(', ');
  const surfaceRgb = rgb.map(v => Math.max(5, Math.round(v * 0.16))).join(', ');

  document.body.classList.remove('glass-light');   // retired experiment — clean up
  root.setProperty('--glass-tint-rgb',   surfaceRgb);
  root.setProperty('--glass-tint-alpha', String(s.tintAlpha));
  root.setProperty('--glass-bg-alpha',   String(s.bgAlpha));
  // Frost blur multiplier — scales every glass surface's backdrop blur ladder
  // proportionally (see --glass-blur-scale usage in glass.css / dashboard.css).
  root.setProperty('--glass-blur-scale', String(s.blurScale != null ? s.blurScale : 1));

  // Ambient radial glows follow the tint in glass mode; cleared when glass is
  // off so the classic theme colours return.
  Object.entries(GLASS_GLOW_ALPHAS).forEach(([v, a]) => {
    if (s.enabled) root.setProperty(v, `rgba(${glowRgb}, ${a})`);
    else           root.removeProperty(v);
  });

  // Persist the resolved colours so the pre-paint bootstrap (index.html) and
  // the ping-alert window can apply them instantly without an IPC round-trip.
  try {
    localStorage.setItem(GLASS_STORAGE_KEY,
      JSON.stringify({ ...s, _surfaceRgb: surfaceRgb, _glowRgb: glowRgb }));
  } catch {}

  // OS acrylic on/off — fire-and-forget; unsupported platforms just report so.
  window.eveAPI?.glassSetMaterial?.(s.enabled ? 'acrylic' : 'none').catch(() => {});
}

function _rgbStrToArr(rgb) {
  const m = String(rgb || '').match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function _hexToRgbStr(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`;
}
function _rgbStrToHex(rgb) {
  const m = String(rgb).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return '#08080c';
  return '#' + [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('');
}

async function populateGlassSettings() {
  const toggle    = document.getElementById('glassEnabledToggle');
  const controls  = document.getElementById('glassControls');
  const modeSel   = document.getElementById('glassTintMode');
  const customWrap= document.getElementById('glassCustomWrap');
  const tintPick  = document.getElementById('glassTintPicker');
  const tintHex   = document.getElementById('glassTintHex');
  const aSlider   = document.getElementById('glassTintAlphaSlider');
  const aVal      = document.getElementById('glassTintAlphaVal');
  const bSlider   = document.getElementById('glassBgAlphaSlider');
  const bVal      = document.getElementById('glassBgAlphaVal');
  const kSlider   = document.getElementById('glassBlurSlider');
  const kVal      = document.getElementById('glassBlurVal');
  const note      = document.getElementById('glassSupportNote');
  if (!toggle) return;

  // Surface the acrylic capability so Win10 users know what they're getting.
  try {
    const ok = await window.eveAPI?.glassSupported?.();
    if (note && ok === false) note.style.display = 'inline';
  } catch (_) {}

  const s = _getGlassSettings();

  const syncVisibility = (cur) => {
    if (controls)   controls.style.opacity  = cur.enabled ? '1' : '0.4';
    if (customWrap) customWrap.style.display = (cur.tintMode === 'custom') ? 'inline-flex' : 'none';
  };

  toggle.checked = !!s.enabled;
  if (modeSel)  modeSel.value = s.tintMode || 'system';
  if (tintPick) tintPick.value = _rgbStrToHex(s.tintRgb);
  if (tintHex)  tintHex.textContent = _rgbStrToHex(s.tintRgb).toUpperCase();
  if (aSlider) { aSlider.value = Math.round(s.tintAlpha * 100); if (aVal) aVal.textContent = `${aSlider.value}%`; }
  if (bSlider) { bSlider.value = Math.round(s.bgAlpha * 100);   if (bVal) bVal.textContent = `${bSlider.value}%`; }
  if (kSlider) { kSlider.value = Math.round((s.blurScale != null ? s.blurScale : 1) * 100); if (kVal) kVal.textContent = `${kSlider.value}%`; }
  syncVisibility(s);

  const update = (patch) => {
    const cur = { ..._getGlassSettings(), ...patch };
    _saveGlassSettings(cur);
    applyGlass(cur);
    syncVisibility(cur);
  };

  toggle.onchange = () => update({ enabled: toggle.checked });
  if (modeSel) modeSel.onchange = () => update({ tintMode: modeSel.value });
  if (tintPick) tintPick.oninput = () => {
    const rgb = _hexToRgbStr(tintPick.value);
    if (!rgb) return;
    if (tintHex) tintHex.textContent = tintPick.value.toUpperCase();
    update({ tintRgb: rgb, tintMode: 'custom' });
  };
  if (aSlider) aSlider.oninput = () => { if (aVal) aVal.textContent = `${aSlider.value}%`; update({ tintAlpha: aSlider.value / 100 }); };
  if (bSlider) bSlider.oninput = () => { if (bVal) bVal.textContent = `${bSlider.value}%`; update({ bgAlpha: bSlider.value / 100 }); };
  if (kSlider) kSlider.oninput = () => { if (kVal) kVal.textContent = `${kSlider.value}%`; update({ blurScale: kSlider.value / 100 }); };
}

// Re-assert the saved material at startup (the window opens with acrylic on by
// default — this syncs it with the user's saved preference, e.g. glass off).
function initGlass() {
  applyGlass(_getGlassSettings());
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
  if (typeof bindIndustrySettings === 'function') bindIndustrySettings();
  if (typeof bindCalendarSettings === 'function') bindCalendarSettings();
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
  if (typeof populateIndustrySettings === 'function') populateIndustrySettings();
  if (typeof populateCalendarSettings === 'function') populateCalendarSettings();
  if (typeof populateForumSettings === 'function') populateForumSettings();
}

async function saveAllSettings() {
  const jabber = gatherJabberSettings();
  await window.eveAPI.saveAppConfig({ jabber });
  // Calendar feeds (merged into config under its own key, won't clobber jabber).
  if (typeof gatherCalendarSettings === 'function') {
    await window.eveAPI.saveAppConfig({ calendar: gatherCalendarSettings() });
  }
  // Forum base URL — save then force-reload the embedded forum with the new URL.
  if (typeof gatherForumSettings === 'function') {
    await window.eveAPI.saveAppConfig({ forum: gatherForumSettings() });
    if (typeof initForumsPage === 'function') initForumsPage(true);
  }
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

  // Only the buttons that map to a page get the navigation handler. The bottom
  // action buttons (Bug Report, Settings, Donate, About) are also .nav-btn but
  // have no data-page — binding navigateToPage to them would call it with
  // undefined, which blanks the page and (because their data-page is undefined)
  // marks every one of them .active (red). They keep their own onclick handlers.
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => navigateToPage(btn.dataset.page));
  });

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

// Session page memory — a page renders its heavy content only on its FIRST visit
// this session. Returning to a page keeps its DOM exactly as you left it (inputs,
// sub-tab, scroll, in-progress calculators). closePage() (the ✕) evicts a page so
// it re-renders fresh next time it's opened. Cleared only on app restart.
let _pageInitialized = new Set();

// Returns the loader's promise (where it has one) so callers can show a spinner
// until the page's data has actually finished loading.
function _initPageForFirstVisit(page) {
  switch (page) {
    case 'characters': return loadAccounts();
    case 'dashboard':  return loadDashboard();
    case 'assets':     return loadAssets();
    case 'wallets':    return initFinancesPage();
    case 'industry':   return initIndustryPage();
    case 'pi':       { const p = initPiPage(); if (typeof _autoSyncPIIfStale === 'function') _autoSyncPIIfStale(); return p; }
    case 'jabber':     return loadJabberHistory();
    case 'map':        return initMapPage();
    case 'calendar':   return renderCalendar();
    case 'fc':         return initFcPage();
    case 'forums':     return initForumsPage();
    case 'mail':       return initMailPage();
    case 'killboard':  return initKillboardPage();
    case 'fw':         return initFactionWarfarePage();
    case 'skills':     return initSkillsPage();
  }
}

// ─── Per-page loading spinner ─────────────────────────────────────────────────
// A passive spinner is injected next to each page's ✕ (see _injectPageSpinners).
// It is shown ONLY while the page is fetching data in the background — so the
// user can tell "still loading" from "this is the cached data, it's done". It's
// not clickable; it appears when a load starts and disappears when it finishes.
function _setPageSpinning(page, on) {
  const sp = document.querySelector(`#page-${page} .page-spinner`);
  if (sp) sp.classList.toggle('loading', !!on);
}

// Inject the spinner beside every page's ✕, grouped so the header's
// space-between layout keeps both pinned top-right. Idempotent.
function _injectPageSpinners() {
  document.querySelectorAll('.nav-page .close-page-btn').forEach(closeBtn => {
    if (closeBtn.parentElement && closeBtn.parentElement.classList.contains('page-header-actions')) return;
    const navPage = closeBtn.closest('.nav-page');
    if (!navPage || !navPage.id) return;

    const spinner = document.createElement('span');
    spinner.className = 'page-spinner';
    spinner.title = 'Loading…';
    spinner.setAttribute('aria-hidden', 'true');

    const wrap = document.createElement('div');
    wrap.className = 'page-header-actions';
    closeBtn.parentNode.insertBefore(wrap, closeBtn);
    // Page-level actions (e.g. the dashboard's refresh) declare themselves in the
    // header markup and get pulled into this group, so the header keeps exactly
    // two children and its space-between layout still pins everything top-right.
    closeBtn.parentNode.querySelectorAll(':scope > .page-header-btn')
      .forEach(actionBtn => wrap.appendChild(actionBtn));
    wrap.appendChild(spinner);
    wrap.appendChild(closeBtn);   // move ✕ in beside the spinner
  });
}

function navigateToPage(page) {
  // Guard against being called with no target (e.g. a .nav-btn without a
  // data-page). Bailing here keeps a real page selected instead of blanking the
  // view and lighting up every page-less button as .active.
  if (!page) return;

  const prevPage = currentPage;

  const pagesContainer = document.getElementById('navPagesContainer');
  if (pagesContainer) pagesContainer.style.display = 'flex';

  document.querySelectorAll('.nav-page').forEach(p => p.classList.remove('active'));
  const selectedPage = document.getElementById(`page-${page}`);
  if (selectedPage) selectedPage.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  currentPage = page;

  // Remember where the user is so a reload (Ctrl+R) reopens this page instead of
  // bouncing back to the dashboard. sessionStorage (not localStorage): it should
  // survive a same-session reload but NOT a full app relaunch — Dashboard is the
  // home page every time you actually open the app. Only persist real pages.
  if (selectedPage) { try { sessionStorage.setItem('lastPage', page); } catch (_) {} }

  // Leaving the fleet page pauses its poll loop — the tracking setup is kept so
  // returning resumes exactly where you were (see _fcOnPageHidden/_fcOnPageShown).
  if (prevPage === 'fc' && page !== 'fc' && typeof _fcOnPageHidden === 'function') _fcOnPageHidden();

  // Keep character data fresh automatically — no manual "sync" button needed.
  // (Background sync only; it updates the local DB without resetting page UI.)
  if (typeof autoSyncOnNavigate === 'function') autoSyncOnNavigate();

  if (!_pageInitialized.has(page)) {
    // First visit this session — build the page and show the spinner until its
    // data has loaded (incl. the SWR background refresh) so the user can tell
    // "still loading" from "this is the cached/loaded data".
    _pageInitialized.add(page);
    const p = _initPageForFirstVisit(page);
    if (p && typeof p.then === 'function') {
      _setPageSpinning(page, true);
      Promise.resolve(p).finally(() => _setPageSpinning(page, false));
    }
  } else if (page === 'fc' && typeof _fcOnPageShown === 'function') {
    // Returning to an already-set-up fleet page: keep the setup, re-check the fleet.
    _fcOnPageShown();
  }
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
    // EVE neocom character-sheet icon (the #eve-charactersheet sprite symbol in
    // index.html) so the Characters button stays consistent with the other
    // EVE-domain nav icons when no character is active.
    icon.innerHTML = '<svg class="nav-icon-svg nav-icon-eve" viewBox="0 0 128 128" aria-hidden="true"><use href="#eve-charactersheet"/></svg>';
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = 'Characters';
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.title = 'Characters';
  }
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
// ── Wipe the local assets database (Settings ▸ Database) ──────────────────────
// Clears every stored asset row for all characters so stale/broken remnants are
// removed. Assets re-sync from ESI in the background afterwards, so this is
// destructive but not permanent. Confirms first, then refreshes the Assets page.
async function wipeAssetsDatabase() {
  const btn    = document.getElementById('wipeAssetsBtn');
  const status = document.getElementById('assetWipeStatus');
  if (!btn || btn.disabled) return;

  if (!confirm('Delete ALL stored assets for every character from the local database?\n\n'
             + 'This clears stale or broken remnants. Your assets reload automatically '
             + 'from ESI on the next sync.')) return;

  const orig = btn.textContent;
  btn.disabled      = true;
  btn.style.opacity = '0.6';
  btn.style.cursor  = 'not-allowed';
  btn.textContent   = '⏳ WIPING…';
  if (status) { status.style.color = 'var(--text-3)'; status.textContent = 'Clearing asset tables…'; }

  try {
    const r    = await window.eveAPI.wipeAssets();
    const rows = r?.rows || 0;
    if (status) {
      status.style.color = 'var(--accent)';
      status.textContent = `✓ Wiped ${rows.toLocaleString()} asset row(s). They will re-sync from ESI in the background.`;
    }
    showToast(`Assets database wiped — ${rows.toLocaleString()} row(s) cleared.`, 'success');
    // Refresh the (now-empty) Assets page if it's open.
    if (typeof loadAssets === 'function') { try { await loadAssets(); } catch (_) {} }
  } catch (e) {
    if (status) { status.style.color = 'var(--danger)'; status.textContent = `Wipe failed: ${e.message}`; }
    showToast(`Asset wipe failed: ${e.message}`, 'error');
  } finally {
    btn.disabled      = false;
    btn.style.opacity = '';
    btn.style.cursor  = '';
    btn.textContent   = orig;
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