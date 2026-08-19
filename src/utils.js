// ─── Utilities ────────────────────────────────────────────────────────────────

// Stale-while-revalidate: render last-known data from the persistent cache
// instantly, then fetch fresh in the background and re-render. So a page never
// shows a blank stare — it shows the previous snapshot immediately, then updates.
//
//   key       persistent-cache key (per page/dataset)
//   fetchData async () => serializable data (or null to skip caching)
//   apply     (data, { fromCache, error }) => void  — renders the data
//   ttlDays   how long the snapshot stays usable (default 1 day)
//
// `apply` may be called twice: once with the cached snapshot (fromCache:true),
// then once with fresh data. If there's no cache, it's called once with fresh
// data (or once with error and data:null when the fetch fails cold).
async function swrRender(key, fetchData, apply, ttlDays = 1) {
  let shownFromCache = false;
  try {
    const cached = await window.eveAPI.cacheGet(key);
    if (cached != null) { apply(cached, { fromCache: true }); shownFromCache = true; }
  } catch (_) { /* no usable cache */ }

  try {
    const fresh = await fetchData();
    if (fresh != null) {
      apply(fresh, { fromCache: false });
      window.eveAPI.cacheSet(key, fresh, ttlDays).catch(() => {});
    }
  } catch (e) {
    if (!shownFromCache) apply(null, { fromCache: false, error: e });
    else console.warn('[swr] background refresh failed for', key, e?.message);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(num) {
  return Math.round(num).toLocaleString();
}

function formatISK(value) {
  if (!value || isNaN(value)) return '0 ISK';
  if (value >= 1e12) return (value / 1e12).toFixed(2) + ' T ISK';
  if (value >= 1e9)  return (value / 1e9).toFixed(2)  + ' B ISK';
  if (value >= 1e6)  return (value / 1e6).toFixed(2)  + ' M ISK';
  if (value >= 1e3)  return (value / 1e3).toFixed(1)  + ' K ISK';
  return Math.round(value).toLocaleString() + ' ISK';
}

function countUp(el, targetValue, duration = 1200) {
  if (!el) return;
  const start    = performance.now();
  const startVal = parseFloat(el.dataset.currentVal) || 0;
  el.dataset.currentVal = targetValue;
  function tick(now) {
    const elapsed  = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    const current  = startVal + (targetValue - startVal) * eased;
    el.textContent = current.toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Was a floating popup stack (bottom-right) — with several rapid-fire
// notifications (e.g. auto-refresh failures across many characters) they
// piled on top of each other and became unreadable. Route to the app's
// existing console log bar/history instead, which is one line + a
// scrollable list rather than an uncapped stack of overlapping divs.
function showToast(msg, type = 'info') {
  if (typeof logToConsole === 'function') logToConsole(msg, type);
}

// ── Floating toast stack ──────────────────────────────────────────────────────
// Non-blocking corner notifications that slide in and auto-dismiss. Distinct from
// showToast()/logToConsole() (the bottom status-bar log). Used for undercut alerts
// and anywhere a passing notification beats a modal. Returns the toast element.
function pushAppToast({ title = '', body = '', kind = 'info', timeout = 9000, onClick } = {}) {
  let stack = document.getElementById('appToastStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'appToastStack';
    stack.className = 'app-toast-stack';
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = `app-toast app-toast-${kind}`;
  el.innerHTML =
    `<div class="app-toast-body">
       ${title ? `<div class="app-toast-title">${escHtml(String(title))}</div>` : ''}
       ${body  ? `<div class="app-toast-text">${escHtml(String(body))}</div>`  : ''}
     </div>
     <button class="app-toast-close" aria-label="Dismiss">✕</button>`;

  let removed = false;
  const dismiss = () => {
    if (removed) return; removed = true;
    el.classList.add('app-toast-out');
    setTimeout(() => el.remove(), 240);
  };
  el.querySelector('.app-toast-close').addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  if (typeof onClick === 'function') {
    el.classList.add('app-toast-click');
    el.addEventListener('click', () => { try { onClick(); } catch (_) {} dismiss(); });
  }

  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('app-toast-in'));   // trigger slide-in
  if (timeout > 0) setTimeout(dismiss, timeout);
  return el;
}

// ── Centered confirmation toast ───────────────────────────────────────────────
// A brief, prominent popup in the middle of the app window for actions the user
// needs immediate confirmation of (e.g. "Copied!"). Non-blocking (pointer-events
// none) and auto-dismisses. Distinct from pushAppToast() (corner) and showToast()
// (status-bar log). Only one shows at a time.
function pushCenterToast(message, kind = 'success', ms = 1900) {
  const existing = document.getElementById('centerToast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'centerToast';
  el.className = `center-toast center-toast-${kind}`;
  const glyph = kind === 'error' ? '✕' : kind === 'info' ? 'ℹ' : '✓';
  el.innerHTML = `<span class="center-toast-icon">${glyph}</span><span class="center-toast-msg">${escHtml(String(message))}</span>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('center-toast-in'));
  setTimeout(() => {
    el.classList.remove('center-toast-in');
    setTimeout(() => el.remove(), 260);
  }, ms);
  // Also drop a line in the status-bar log so there's a persistent record.
  if (typeof logToConsole === 'function') logToConsole(message, kind);
  return el;
}

function logToConsole(message, type = 'info') {
  const consoleMsg  = document.getElementById('console-msg');
  const consoleTime = document.getElementById('console-time');
  const consoleLog  = document.getElementById('consoleLog');

  const now = new Date();
  const timeString = now.toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  // ── Update the always-visible status bar ──────────────────────────────────
  if (consoleTime) consoleTime.textContent = `[${timeString}]`;
  if (consoleMsg)  {
    consoleMsg.textContent = message;
    consoleMsg.className   = `console-msg ${type}`;
  }

  // ── Append to scrollable history log ─────────────────────────────────────
  if (consoleLog) {
    const entry = document.createElement('div');
    entry.className = `console-log-entry ${type}`;
    entry.innerHTML =
      `<span class="log-time">[${timeString}]</span>` +
      `<span class="log-msg">${escHtml(String(message))}</span>`;
    // column-reverse means prepend = visually appears at bottom
    consoleLog.appendChild(entry);
    consoleLog.scrollTop = consoleLog.scrollHeight;

    // Cap history at 200 entries to avoid memory growth
    while (consoleLog.children.length > 200) {
      consoleLog.removeChild(consoleLog.lastChild);
    }
  }

  // ── Mirror to the diagnostic log file, when it's switched on ──────────────
  // The history above is 200 lines held in memory and gone when the app closes,
  // which is exactly the wrong shape for "it broke last night". The main process
  // decides whether anything is actually recorded (Settings → General); this
  // side just offers the line and never waits for an answer.
  try { window.eveAPI?.logWrite?.({ level: type, source: 'ui', message: String(message) }); }
  catch (_) { /* logging must never break the thing that was being logged */ }
}

// ── Console expand/collapse (initialised once on DOMContentLoaded) ────────────
(function initConsoleToggle() {
  function setup() {
    const console_el  = document.getElementById('appConsole');
    const toggleBtn   = document.getElementById('consoleToggleBtn');
    const statusbar   = document.getElementById('consoleStatusbar');
    if (!console_el || !toggleBtn) return;

    let expanded = false;

    function toggle() {
      expanded = !expanded;
      console_el.classList.toggle('expanded', expanded);
      toggleBtn.textContent = expanded ? '▼' : '▲';
      toggleBtn.title = expanded ? 'Collapse console log' : 'Expand console log';
    }

    // Click the toggle button OR anywhere on the status bar
    toggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    if (statusbar) statusbar.addEventListener('click', toggle);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();

// Simple persistent cache wrappers
async function cacheSet(key, value, days = 7) {
  try { await window.eveAPI.cacheSet(key, value, days); } catch (e) { /* ignore */ }
}
async function cacheGet(key) {
  try { return await window.eveAPI.cacheGet(key); } catch (e) { return null; }
}

function openExternal(url) {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.click();
}
// ── ESI identification (best practices) ───────────────────────────────────────
// Every renderer-side ESI call must identify the app and pin its compatibility
// date. Chromium silently drops User-Agent overrides, so ESI's documented
// fallback is X-User-Agent. Wrapping fetch ONCE here covers every call site
// (dashboard, assets, jabber, cost-index, …).
//
// The strings come from window.Esi (src/shared/esi.js), which the main process
// uses too. They used to be written out here AND in src/app_ident.js AND inline
// in src/html/ping-alert.html — and they had already drifted: ping-alert sent
// X-User-Agent but no X-Compatibility-Date, so that window was talking to a
// different snapshot of ESI than the rest of the app, silently.
(function () {
  const Esi = window.Esi;
  if (!Esi) return;   // shared/esi.js failed to load — never break fetch over it
  try {
    window.eveAPI?.getAppVersion?.().then(v => Esi.setVersion(v)).catch(() => {});
  } catch (_) {}
  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (Esi.isEsi(url)) {
        init = init || {};
        init.headers = { ...(init.headers || {}), ...Esi.headers({ renderer: true }) };
      }
    } catch (_) { /* never break a fetch over identification */ }
    return _origFetch.call(this, input, init);
  };
})();

// ─── Confirm dialog ───────────────────────────────────────────────────────────
//
// window.confirm() draws the OS dialog — a grey Windows box in the middle of a
// themed glass terminal, with the app's name in the titlebar and no way to say
// which button is the dangerous one. This is the same question in the app's own
// language.
//
// Returns a Promise<boolean>. Unlike window.confirm it does NOT block, so every
// call site has to await it; that is the one behavioural difference to watch
// when converting the remaining raw confirm() sites (fitting, jabber, mail,
// palette, rooms).
//
//   showConfirm({ title, body, confirmText, cancelText, danger })
//
// `danger: true` makes the confirm button destructive-red AND focuses Cancel
// instead, so a reflexive Enter dismisses rather than destroys.
function showConfirm({ title, body = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'cf-backdrop';
    wrap.innerHTML =
      '<div class="cf-modal' + (danger ? ' danger' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="cf-head">' +
          (danger ? '<span class="cf-icon material-symbols-outlined">warning</span>' : '') +
          '<span class="cf-title"></span>' +
        '</div>' +
        '<div class="cf-body"></div>' +
        '<div class="cf-foot">' +
          '<button class="cf-btn cf-cancel"></button>' +
          '<button class="cf-btn cf-go"></button>' +
        '</div>' +
      '</div>';

    // Text set as textContent, never innerHTML: these strings carry op names and
    // other user input, and a fit called "<img onerror=…>" is not a dialog.
    wrap.querySelector('.cf-title').textContent  = title || 'Are you sure?';
    wrap.querySelector('.cf-cancel').textContent = cancelText;
    wrap.querySelector('.cf-go').textContent     = confirmText;

    const bodyEl = wrap.querySelector('.cf-body');
    for (const line of String(body).split('\n')) {
      const p = document.createElement('p');
      p.className = 'cf-line';
      p.textContent = line;
      bodyEl.appendChild(p);
    }

    const done = (val) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(val);
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      if (e.key === 'Enter' && !danger) { e.preventDefault(); done(true); }
    }

    wrap.querySelector('.cf-cancel').addEventListener('click', () => done(false));
    wrap.querySelector('.cf-go').addEventListener('click', () => done(true));
    // Clicking the backdrop cancels; clicking inside the panel must not.
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(wrap);
    wrap.querySelector(danger ? '.cf-cancel' : '.cf-go').focus();
  });
}
