// ─── Hotfix card: clearing up after stuck SDE updates ─────────────────────────
// Up to 4.1.3 an update could hang for good on an all-users install, leaving
// about 650 MB in the temp folder on every launch (src/sde_store.js has why).
// Updates now save in the user's own folder; this clears the leftovers at launch
// and, the first time there are any, says what happened and what it is doing.
// People with nothing to clear never see it, and later clean-ups are silent.
//
// main does the finding and the deleting (src/sde_cleanup.js) and names no path
// to this side. Like every popup that opens on its own, the card waits for a
// guided tour; the clean-up itself doesn't need to.

const SdeCleanup = (() => {
  const MAX_WAIT_MS = 90000;   // the SDE check follows this; a slow disk mustn't hold it for ever
  const READ_MS = 6000;        // a few folders go in a second; leave time to read why
  let state = null;            // { scan, progress, result, el, shownAt }

  function size(bytes) {
    const mb = Math.max(0, Number(bytes) || 0) / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
  const folders = (n) => `${n.toLocaleString()} leftover folder${n === 1 ? '' : 's'}`;

  /** Clear what there is. Resolves when it is done (or has taken long enough). One at a time. */
  let running = null;
  function run() {
    if (!running) running = _run().finally(() => { running = null; });
    return running;
  }

  async function _run() {
    let scan;
    try { scan = await window.eveAPI.sdeCleanupScan(); } catch (_) { return null; }
    if (!scan || !scan.folders) return null;

    state = { scan, progress: null, result: null, el: null, shownAt: 0 };
    if (scan.notice) _show();
    const stop = window.eveAPI.on('sde-cleanup-progress', (p) => { if (state) { state.progress = p; _render(); } });
    const work = window.eveAPI.sdeCleanupRun()
      .then((r) => { state.result = r; _render(); return r; })
      .catch(() => { _close(); return null; })
      .finally(() => stop?.());
    return Promise.race([work, new Promise(r => setTimeout(() => r(null), MAX_WAIT_MS))]);
  }

  function _show() {
    if (typeof tutorialBusy === 'function' && tutorialBusy()) {
      document.addEventListener('tutorial-idle', _show, { once: true });
      return;
    }
    if (!state || state.el) return;
    let stack = document.getElementById('appToastStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'appToastStack';
      stack.className = 'app-toast-stack';
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = 'app-toast app-toast-info sde-toast sde-cleanup-toast';
    el.innerHTML =
      `<div class="app-toast-body">
         <div class="app-toast-title"></div>
         <div class="app-toast-text" role="status" aria-live="polite"></div>
         <div class="sde-toast-track" role="progressbar" aria-label="Clearing leftover files" aria-valuemin="0" aria-valuemax="100">
           <div class="sde-toast-fill"></div>
         </div>
         <div class="sde-toast-meta"><span class="sde-toast-detail"></span><span class="sde-toast-eta"></span></div>
       </div>
       <button class="app-toast-close" aria-label="Hide">✕</button>`;
    el.querySelector('.app-toast-close').addEventListener('click', _close);
    stack.appendChild(el);
    state.el = el;
    // Opened late (after a tour) with the work already done, it goes straight to the end.
    state.shownAt = state.result ? 0 : Date.now();
    requestAnimationFrame(() => el.classList.add('app-toast-in'));
    _render();
  }

  function _close() {
    const el = state && state.el;
    if (!el) return;
    state.el = null;
    el.classList.add('app-toast-out');
    setTimeout(() => el.remove(), 240);
  }

  function _render() {
    if (!state || !state.el) return;
    const { el, scan, progress, result } = state;
    const q = (sel) => el.querySelector(sel);
    const fill = (pct) => {
      q('.sde-toast-fill').style.width = `${pct}%`;
      q('.sde-toast-track').setAttribute('aria-valuenow', String(Math.round(pct)));
    };
    const text = (s) => { const t = q('.app-toast-text'); if (t.textContent !== s) t.textContent = s; };

    const readLeft = result ? READ_MS - (Date.now() - state.shownAt) : 0;
    if (readLeft > 0) setTimeout(_render, readLeft);
    if (!result || readLeft > 0) {
      q('.app-toast-title').textContent = 'Hotfix: clearing up after stuck updates';
      text('On some PCs, EVE Carbon couldn’t save SDE updates (CCP’s game data) in its install folder. '
        + 'They got stuck and left files in your temp folder. Updates now save in your own EVE Carbon folder, '
        + 'and we’re removing the leftovers. Please bear with us.');
      const p = result ? { done: scan.folders, total: scan.folders, freed: result.freed }
        : progress || { done: 0, total: scan.folders, freed: 0 };
      fill(p.total ? (p.done / p.total) * 100 : 0);
      q('.sde-toast-detail').textContent = `${p.done.toLocaleString()} of ${folders(p.total)}`;
      q('.sde-toast-eta').textContent = `${size(p.freed)} of ${size(scan.bytes)}`;
      return;
    }

    el.classList.remove('app-toast-info');
    el.classList.add('app-toast-success');
    q('.app-toast-title').textContent = result.removed ? 'Hotfix done: all cleared up' : 'Hotfix: nothing could be cleared yet';
    text((result.removed ? `Removed ${folders(result.removed)} from stuck SDE updates and freed ${size(result.freed)}. ` : '')
      + (result.failed ? `${folders(result.failed)} in use; EVE Carbon tries again next time it starts. ` : '')
      + `SDE updates now save in ${scan.dir}. Your characters and settings weren’t touched.`);
    q('.sde-toast-track').hidden = true;
    q('.sde-toast-meta').hidden = true;
  }

  return { run };
})();
