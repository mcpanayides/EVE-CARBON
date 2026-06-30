// ─── forums.js — embedded alliance forum (IP.Board) ───────────────────────────
// Renders the forum inside a <webview> bound to the persist:forum session, so the
// page is already signed in from the saved login (see src/ipc/forum_ipc.js — the
// password is never stored). The toolbar drives normal browser navigation plus
// login / logout / open-externally, and a dot reflects the session status.

let _forumWired = false;

// Forum base URL: dedicated forum setting first, else the calendar's forum URL.
function _forumGetUrl(cfg) {
  const a = (cfg && cfg.app) || {};
  let url = (a.forum && a.forum.url) || (a.calendar && a.calendar.forumBaseUrl) || '';
  url = String(url).trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

// force=true reloads the webview with the configured URL (used after a URL change);
// otherwise the webview is only loaded on its first visit so navigation is kept.
async function initForumsPage(force) {
  const wv    = document.getElementById('forumWebview');
  const empty = document.getElementById('forumEmpty');
  if (!wv) return;

  let url = '';
  try { url = _forumGetUrl(await window.eveAPI.getAppConfig()); } catch (_) {}

  if (!url) {
    if (empty) empty.style.display = 'flex';
    wv.style.display = 'none';
    _forumUpdateStatus();
    return;
  }
  if (empty) empty.style.display = 'none';

  // Wire webview events once (the page DOM persists across visits).
  if (!_forumWired) {
    _forumWired = true;
    const loading = document.getElementById('forumLoading');
    wv.addEventListener('did-start-loading', () => { if (loading) loading.style.display = 'flex'; });
    wv.addEventListener('did-stop-loading',  () => { if (loading) loading.style.display = 'none'; _forumUpdateNav(); _forumUpdateStatus(); });
    wv.addEventListener('did-fail-load', (e) => {
      if (e && e.errorCode === -3) return;   // ERR_ABORTED — normal on redirects
      if (loading) loading.style.display = 'none';
      if (e && typeof showToast === 'function') showToast(`Forum failed to load: ${e.errorDescription || 'error'} (${e.errorCode})`, 'error');
    });
    wv.addEventListener('dom-ready', () => { _forumUpdateNav(); _forumUpdateStatus(); });
    wv.addEventListener('page-title-updated', (e) => { const t = document.getElementById('forumTitle'); if (t) t.textContent = (e && e.title) || 'Forum'; });
    wv.addEventListener('did-navigate', _forumUpdateNav);
    wv.addEventListener('did-navigate-in-page', _forumUpdateNav);
    // Popups / target=_blank are handled in the main process (setWindowOpenHandler
    // on webview contents) — they go to the OS browser, never a new app window.
  }

  // MUST be flex, not block: Electron's <webview> uses display:flex internally so
  // its shadow <iframe> fills the host's box. Overriding it to block collapses the
  // view to its ~150px intrinsic height (a thin strip) regardless of CSS sizing.
  wv.style.display = 'flex';
  // getURL()/canGoBack() THROW on a <webview> until its first dom-ready, so guard
  // them — otherwise the throw would skip the wv.src assignment below (blank view).
  let cur = '';
  try { cur = (typeof wv.getURL === 'function') ? wv.getURL() : ''; } catch (_) { cur = ''; }
  if (force || !cur || cur === 'about:blank') {
    try { wv.src = url; } catch (_) { try { wv.setAttribute('src', url); } catch (__) {} }
  }
  _forumUpdateStatus();
}

function _forumUpdateNav() {
  const wv  = document.getElementById('forumWebview');
  if (!wv) return;
  const back = document.getElementById('forumBack');
  const fwd  = document.getElementById('forumForward');
  try { if (back) back.disabled = !wv.canGoBack(); }   catch (_) {}
  try { if (fwd)  fwd.disabled  = !wv.canGoForward(); } catch (_) {}
}

async function _forumUpdateStatus() {
  let loggedIn = false;
  try { const s = await window.eveAPI.forumSessionStatus(); loggedIn = !!(s && s.loggedIn); } catch (_) {}
  // Update both the page toolbar dot and the settings-tab dot.
  [['forumStatusDot', 'forumStatusLabel'], ['forumSettingsStatusDot', 'forumSettingsStatusLabel']].forEach(([d, l]) => {
    const dot = document.getElementById(d), lbl = document.getElementById(l);
    if (dot) { dot.classList.toggle('online', loggedIn); dot.classList.toggle('offline', !loggedIn); }
    if (lbl) lbl.textContent = loggedIn ? 'Logged in' : 'Logged out';
  });
  // Mirror the login state on the left-nav "Forums" status light (same helper the
  // Jabber nav light uses).
  if (typeof setNavStatusLight === 'function') setNavStatusLight('forumNavStatus', loggedIn);
}

// ── Settings → Forums ───────────────────────────────────────────────────────
async function populateForumSettings() {
  const input = document.getElementById('forumUrlInput');
  if (input) {
    try {
      const a = ((await window.eveAPI.getAppConfig()) || {}).app || {};
      input.value = (a.forum && a.forum.url) || (a.calendar && a.calendar.forumBaseUrl) || '';
    } catch (_) {}
  }
  _forumUpdateStatus();
}

// Returns the Forums settings for the unified Save (merged under cfg.app.forum by
// app-save-config). Saving + the page reload are handled by saveAllSettings().
function gatherForumSettings() {
  return { url: (document.getElementById('forumUrlInput')?.value || '').trim() };
}

function forumNav(action) {
  const wv = document.getElementById('forumWebview');
  if (!wv) return;
  try {
    if      (action === 'back'    && wv.canGoBack())    wv.goBack();
    else if (action === 'forward' && wv.canGoForward()) wv.goForward();
    else if (action === 'reload')  wv.reload();
    else if (action === 'home')    window.eveAPI.getAppConfig().then(cfg => { const u = _forumGetUrl(cfg); if (u) wv.src = u; }).catch(() => {});
    else if (action === 'external') {
      const u = (typeof wv.getURL === 'function' && wv.getURL()) || '';
      if (u && u !== 'about:blank') window.eveAPI.openExternalUrl(u);
    }
  } catch (_) {}
}

// Log in INSIDE the embedded forum — the webview shares the persist:forum session,
// so a normal forum login there is saved for next time. No separate window.
async function forumDoLogin() {
  let url = '';
  try { url = _forumGetUrl(await window.eveAPI.getAppConfig()); } catch (_) {}
  if (!url) { if (typeof showToast === 'function') showToast('Set your forum URL in Settings → Forums first.', 'info'); return; }
  // Close the settings drawer (if open) and switch to the embedded Forums page.
  const drawer = document.getElementById('uiSettingsDrawer');
  if (drawer) drawer.style.display = 'none';
  if (typeof navigateToPage === 'function') navigateToPage('forums');
  setTimeout(() => initForumsPage(true), 80);   // force-load the forum to its login page
  if (typeof showToast === 'function') showToast('Log in to the forum here — your session is saved for next time.', 'info');
}

async function forumDoLogout() {
  try { await window.eveAPI.forumLogout(); } catch (_) {}
  if (typeof showToast === 'function') showToast('Forum session cleared.', 'success');
  await _forumUpdateStatus();
  const wv = document.getElementById('forumWebview');
  if (wv) { try { wv.reload(); } catch (_) {} }
}
