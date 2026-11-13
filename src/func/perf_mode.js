// ─── Performance mode (Settings → General) ───────────────────────────────────
// One switch: Quality, EVE Carbon as designed, or Performance, the least CPU,
// graphics and memory it can run on, for someone running it beside many EVE
// clients. Saved in config.json (app.performanceMode) by main.
//
// What Performance turns off, and where:
//   - every CSS animation and transition, the backdrop blur and the wallpaper:
//     styles/performance.css, all scoped to body.perf-mode
//   - the glass look and the window's acrylic: applyGlass() (ui.js) treats glass
//     as off while body.perf-mode is set, without touching the saved glass
//     settings, so switching back to Quality restores them exactly
//   - the map's drifting nebula, sky and bridge light: _jbFxStill() (map.js)
//     counts perf-mode as stillness, and the map re-syncs on the body class change
//   - chart animation and counting-up numbers: here and in countUp() (utils.js)
//   - glass on pop-out windows: main.js, on the 'performance-mode' broadcast
// body.perf-mode is set before first paint from main's launch argument
// (index.html), so the app never starts animating and then stops.

let _perfChartAnimation;      // Chart.js's own animation defaults, put back for Quality

/** True while Performance mode is on in this window. */
function isPerformanceMode() {
  return !!(document.body && document.body.classList.contains('perf-mode'));
}

/** Switch this window to `mode` ('quality' | 'performance'). Idempotent. */
function applyPerformanceMode(mode) {
  const on = mode === 'performance';
  document.body.classList.toggle('perf-mode', on);
  // Glass follows the mode: off here, the saved setting again in Quality.
  if (typeof applyGlass === 'function' && typeof _getGlassSettings === 'function') {
    applyGlass(_getGlassSettings());
  }
  if (window.Chart && Chart.defaults) {
    if (_perfChartAnimation === undefined) _perfChartAnimation = Chart.defaults.animation;
    Chart.defaults.animation = on ? false : _perfChartAnimation;
  }
  _syncPerfSwitch(on ? 'performance' : 'quality');
}

function _syncPerfSwitch(mode) {
  const sw = document.getElementById('perfModeSwitch');
  if (!sw) return;
  sw.dataset.mode = mode;
  sw.querySelectorAll('.perf-switch-opt').forEach(b => {
    const chosen = b.dataset.perfMode === mode;
    b.setAttribute('aria-checked', String(chosen));
    b.tabIndex = chosen ? 0 : -1;
  });
}

/**
 * The note under the switch. Most of the saving is immediate; the graphics
 * side is chosen when EVE Carbon starts, so a change waits for a restart.
 */
function _perfNotice(state) {
  const el = document.getElementById('perfModeNotice');
  if (!el || !state) return;
  const pending = state.mode !== state.atLaunch;
  el.hidden = !pending;
  if (!pending) return;
  el.textContent = state.mode === 'performance'
    ? 'Restart EVE Carbon to hand its graphics memory back to your EVE clients as well.'
    : 'Restart EVE Carbon to turn graphics acceleration back on.';
  if (typeof window.eveAPI?.restartApp === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-track-btn fc-invite-btn perf-restart-btn';
    btn.textContent = 'Restart now';
    btn.onclick = () => window.eveAPI.restartApp();
    el.append(' ', btn);
  }
}

/** Settings → General: the Quality | Performance switch. */
async function populatePerformanceSetting() {
  const sw = document.getElementById('perfModeSwitch');
  if (!sw) return;
  let state = { mode: isPerformanceMode() ? 'performance' : 'quality', atLaunch: null };
  try { state = await window.eveAPI.getPerformanceMode() || state; } catch (_) { /* keep what the page shows */ }
  _syncPerfSwitch(state.mode);
  _perfNotice(state);

  const choose = async (next, { focus = false } = {}) => {
    if (next === sw.dataset.mode) return;
    const before = sw.dataset.mode;
    applyPerformanceMode(next);
    if (focus) sw.querySelector(`.perf-switch-opt[data-perf-mode="${next}"]`)?.focus();
    try {
      _perfNotice(await window.eveAPI.setPerformanceMode(next));
      showToast(next === 'performance'
        ? 'Performance (Potato mode 🥔): glass, wallpaper and animation are off.'
        : 'Quality: glass, wallpaper and animation are back.', 'success');
    } catch (e) {
      applyPerformanceMode(before);
      showToast(`Couldn't change the setting: ${e.message}`, 'error');
    }
  };

  sw.querySelectorAll('.perf-switch-opt').forEach(b => { b.onclick = () => choose(b.dataset.perfMode); });
  // A radio group: arrows move the choice, and focus goes with it.
  sw.onkeydown = (e) => {
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'Home';
    const fwd  = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'End';
    if (!back && !fwd) return;
    e.preventDefault();
    choose(back ? 'quality' : 'performance', { focus: true });
  };
}

// The class is already on <body> from the pre-paint script; this brings the
// parts that need scripts (glass, Chart.js) into line, and follows changes made
// in another window.
(function initPerformanceMode() {
  try {
    if (isPerformanceMode()) applyPerformanceMode('performance');
    window.eveAPI?.on?.('performance-mode', (mode) => {
      if ((mode === 'performance') !== isPerformanceMode()) applyPerformanceMode(mode);
    });
  } catch (_) { /* a failed switch must never stop the app loading */ }
})();
