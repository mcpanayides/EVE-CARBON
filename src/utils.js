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

function formatCurrency(value) {
  if (typeof value !== 'number') return 'N/A';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  }).format(value);
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

async function withLoadingLogs(taskName, errorContainerId, asyncWork) {
  try {
    logToConsole(`Loading ${taskName}...`, 'info');
    await asyncWork();
    logToConsole(`${taskName} loaded successfully.`, 'success');
  } catch (error) {
    console.error(`[${taskName}] Error:`, error);
    logToConsole(`Connection failed: ${error.message}`, 'error');
    const container = document.getElementById(errorContainerId);
    if (container) {
      container.innerHTML = `
        <div style="color:var(--danger);padding:10px;text-align:center;
                    font-family:var(--mono);font-size:11px;">
          ⚠ Failed to load ${taskName} data. Check the console below for details.
        </div>`;
    }
  }
}

// Simple persistent cache wrappers
async function cacheSet(key, value, days = 7) {
  try { await window.eveAPI.cacheSet(key, value, days); } catch (e) { /* ignore */ }
}
async function cacheGet(key) {
  try { return await window.eveAPI.cacheGet(key); } catch (e) { return null; }
}

function showError(msg) {
  document.getElementById('results').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon" style="color:var(--danger)">⚠</div>
      <div class="empty-title">Error</div>
      <div class="empty-sub">${escHtml(msg)}</div>
    </div>`;
}

function scrollToResults() {
  document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function openExternal(url) {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.click();
}
// ── ESI identification (best practices) ───────────────────────────────────────
// Every renderer-side ESI call must identify the app. Chromium silently drops
// User-Agent overrides, so ESI's documented fallback is the X-User-Agent
// header. Wrapping fetch ONCE here covers every call site (dashboard, assets,
// jabber, fleetup, cost-index, …) with app name/version + contact + source.
// Pinned the same way as the main process (see src/app_ident.js) — a
// deliberately-tested ESI behaviour snapshot, not "whatever today is". Bump
// both together after testing against newer ESI behaviour.
const ESI_COMPATIBILITY_DATE = '2026-07-20';

(function () {
  const IDENT_BASE = '(miachristinapanayides@gmail.com; +https://github.com/mcpanayides/EVE-CARBON)';
  let _xua = `EVE-Carbon/dev ${IDENT_BASE}`;
  try {
    window.eveAPI?.getAppVersion?.().then(v => { if (v) _xua = `EVE-Carbon/${v} ${IDENT_BASE}`; }).catch(() => {});
  } catch (_) {}
  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/esi\.evetech\.net/i.test(url)) {
        init = init || {};
        init.headers = { ...(init.headers || {}), 'X-User-Agent': _xua, 'X-Compatibility-Date': ESI_COMPATIBILITY_DATE };
      }
    } catch (_) { /* never break a fetch over identification */ }
    return _origFetch.call(this, input, init);
  };
})();
