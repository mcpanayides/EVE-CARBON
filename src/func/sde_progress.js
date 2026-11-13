// ─── SDE update progress (top-right) ─────────────────────────────────────────
// When CCP publishes a new SDE (the static data: every item, system and
// blueprint), the app downloads and rebuilds it in the background, about two
// minutes' work. This shows that in the corner toast stack (pushAppToast's, in
// utils.js): what it is doing, how far along it is, and about how long is left.
// The arithmetic is src/shared/sde_eta.js.
//
// One card per update, changed in place. Hiding it leaves the update running
// (the SDE light in the status bar still says so) and it stays hidden; the end
// of the update is news again and shows. Like every popup that opens on its
// own, it waits while a guided tour runs (tutorialBusy / 'tutorial-idle').

const SdeProgress = (() => {
  // { kind: 'auto'|'manual', eta, snap, state: 'running'|'done'|'failed', el, timer, hidden, waiting, message }
  let run = null;

  const STAGES = {
    check:    'Checking for the newest version',
    download: 'Downloading',
    extract:  'Unpacking',
    build:    'Building the database',
    finish:   'Finishing up',
    done:     'Finishing up',
  };

  function begin(kind = 'auto') {
    end();
    const eta = SdeEta.create();
    run = { kind, eta, snap: eta.update({ phase: 'check' }, Date.now()), state: 'running',
            el: null, timer: null, hidden: false, waiting: false, message: '' };
    _show();
  }

  function update(evt) {
    if (!run || run.state !== 'running' || !evt) return;
    if (evt.phase === 'done') return;        // done() says so, with what happens next
    run.snap = run.eta.update(evt, Date.now());
    _render();
  }

  /** The update finished. `restarting`: the app restarts by itself (Settings → Update). */
  function done({ restarting = false } = {}) {
    if (!run) return;
    run.state = 'done';
    run.restarting = restarting;
    run.hidden = false;
    _stopTicking();
    _show();
  }

  function fail(message) {
    if (!run) return;
    run.state = 'failed';
    run.message = String(message || 'Unknown error').replace(/[.\s]+$/, '');   // the card adds its own full stop
    run.hidden = false;
    _stopTicking();
    _show();
  }

  /** Close the card and forget the update (an interrupted one, say). */
  function end() {
    if (!run) return;
    _stopTicking();
    if (run.el) run.el.remove();
    run = null;
  }

  /** What the card says, for anything else showing the same update (Settings → Database). */
  function describe() {
    if (!run) return null;
    const s = run.snap;
    let detail = '';
    if (s.phase === 'download' && s.total > 0) detail = `${SdeEta.formatMB(s.downloaded).replace(' MB', '')} of ${SdeEta.formatMB(s.total)}`;
    else if (s.phase === 'build' && s.step > 0) detail = `Step ${Math.min(s.step, s.steps)} of ${s.steps}`;
    return { stage: STAGES[s.phase] || STAGES.check, detail, eta: SdeEta.formatEta(s.etaMs), percent: s.percent };
  }

  function _stopTicking() {
    if (run && run.timer) { clearInterval(run.timer); run.timer = null; }
  }

  function _stack() {
    let stack = document.getElementById('appToastStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'appToastStack';
      stack.className = 'app-toast-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function _show() {
    if (!run || run.hidden) return;
    // Nothing pops over a guided tour; this waits for it to finish.
    if (typeof tutorialBusy === 'function' && tutorialBusy()) {
      if (!run.waiting) {
        run.waiting = true;
        const mine = run;
        document.addEventListener('tutorial-idle', () => {
          if (run === mine) { mine.waiting = false; _show(); }
        }, { once: true });
      }
      return;
    }
    if (!run.el) {
      run.el = _build();
      _stack().appendChild(run.el);
      const el = run.el;
      requestAnimationFrame(() => el.classList.add('app-toast-in'));
    }
    // A long build step sends nothing for most of a minute; the estimate still moves.
    if (run.state === 'running' && !run.timer) {
      run.timer = setInterval(() => {
        if (!run || run.state !== 'running') return;
        run.snap = run.eta.snapshot(Date.now());
        _render();
      }, 1000);
    }
    _render();
  }

  function _build() {
    const el = document.createElement('div');
    el.className = 'app-toast app-toast-info sde-toast';
    el.innerHTML =
      `<div class="app-toast-body">
         <div class="app-toast-title"></div>
         <div class="app-toast-text sde-toast-stage" role="status" aria-live="polite"></div>
         <div class="sde-toast-track" role="progressbar" aria-label="SDE update" aria-valuemin="0" aria-valuemax="100">
           <div class="sde-toast-fill"></div>
         </div>
         <div class="sde-toast-meta"><span class="sde-toast-detail"></span><span class="sde-toast-eta"></span></div>
         <div class="sde-toast-actions" hidden></div>
       </div>
       <button class="app-toast-close" aria-label="Hide">✕</button>`;
    el.querySelector('.app-toast-close').addEventListener('click', _hide);
    return el;
  }

  function _hide() {
    if (!run || !run.el) return;
    const el = run.el;
    run.el = null;
    _stopTicking();
    el.classList.add('app-toast-out');
    setTimeout(() => el.remove(), 240);
    // Hiding a running update keeps it running, quietly; hiding the end of one is the end.
    if (run.state === 'running') run.hidden = true;
    else run = null;
  }

  function _render() {
    if (!run || !run.el) return;
    const el = run.el;
    const q = (sel) => el.querySelector(sel);
    const track = q('.sde-toast-track');
    const actions = q('.sde-toast-actions');
    el.classList.toggle('app-toast-info', run.state === 'running');
    el.classList.toggle('app-toast-success', run.state === 'done');
    el.classList.toggle('app-toast-warn', run.state === 'failed');

    if (run.state === 'running') {
      const d = describe();
      q('.app-toast-title').textContent = 'Updating the SDE';
      if (q('.sde-toast-stage').textContent !== d.stage) q('.sde-toast-stage').textContent = d.stage;
      q('.sde-toast-fill').style.width = `${d.percent}%`;
      track.setAttribute('aria-valuenow', String(d.percent));
      track.hidden = false;
      // No percentage beside the megabytes: the bar is the whole job, the download
      // a sixth of it, and "8% · 43.6 of 94.7 MB" reads as a contradiction.
      q('.sde-toast-detail').textContent = d.detail;
      q('.sde-toast-eta').textContent = d.eta;
      q('.sde-toast-meta').hidden = false;
      actions.hidden = true;
      return;
    }

    q('.sde-toast-meta').hidden = true;
    if (run.state === 'done') {
      q('.app-toast-title').textContent = 'SDE updated';
      q('.sde-toast-stage').textContent = run.restarting
        ? 'Restarting EVE Carbon to use it…'
        : 'Restart EVE Carbon to start using it.';
      q('.sde-toast-fill').style.width = '100%';
      track.setAttribute('aria-valuenow', '100');
      track.hidden = false;
      actions.hidden = run.restarting;
      if (!run.restarting && !actions.firstChild) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fc-track-btn fc-invite-btn';
        btn.textContent = 'Restart now';
        btn.addEventListener('click', () => window.eveAPI.sdeRestartApp());
        actions.appendChild(btn);
      }
    } else {
      q('.app-toast-title').textContent = 'SDE update failed';
      q('.sde-toast-stage').textContent = `${run.message}. It tries again the next time EVE Carbon starts.`;
      track.hidden = true;
      actions.hidden = true;
    }
  }

  return { begin, update, done, fail, end, describe };
})();
