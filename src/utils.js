// ─── Utilities ────────────────────────────────────────────────────────────────

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

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  const color = type === 'success' ? 'var(--success)'
              : type === 'error'   ? 'var(--danger)'
              : 'var(--accent)';
  toast.style.cssText = `
    position:fixed; bottom:20px; right:20px; padding:10px 16px;
    border-radius:4px; font-family:var(--mono); font-size:12px;
    z-index:9999; border:1px solid; background:var(--bg-card);
    color:${color}; border-color:${color};`;
  toast.textContent = msg;
  let layer = document.querySelector('.toast-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'toast-layer';
    document.body.appendChild(layer);
  }
  layer.appendChild(toast);
  setTimeout(() => toast.remove(), 15000);
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
    consoleLog.insertBefore(entry, consoleLog.firstChild);

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