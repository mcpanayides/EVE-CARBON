// ─── Fleet Commander → Early Warning ──────────────────────────────────────────
// Reads in-game intel channels and warns when hostiles are closing on the
// fleet. Built for the case where reacting late is fatal: barges sieged in a
// belt need ~60–120s to break, align and go, and an Orca needs longer.
//
// The engine is in the main process (src/intel/*) because the SDE lives there.
// This renders what it emits and does no parsing of its own.
//
// JUMPS lead, ETA is secondary and explicitly an estimate. Distance is the only
// hard number here: it comes from the stargate graph and is exactly right. Time
// is inferred from how fast the contact has been moving, and warp speed varies
// several-fold between hulls while systems differ in size — so a confident "70s"
// would be a number the tool cannot actually stand behind. It's shown as "~70s",
// and dimmed further when the rate is a default guess rather than measured.

let _intelWired    = false;
let _intelContacts = [];
let _intelFeed     = [];
let _intelStatus   = null;
let _intelTimer    = null;
let _intelUnsub    = [];
let _intelChars    = [];   // monitorable characters, with online + position
let _intelSound    = null; // { enabled, minSize, volume }
let _intelAudio    = null; // the <audio> element, created lazily
let _intelLastSound = 0;   // last time a sound played (ms)

let _intelCharTimer = null;   // slow poll, only while the character menu is open

const INTEL_REFRESH_MS = 2000;   // contacts re-render; alerts arrive by push
// Jumps arrive by push from the Local log; this only catches logging in and out,
// so it can be lazy — and it runs only while the dropdown is on screen.
const INTEL_CHAR_POLL_MS = 5000;

function _intelFmtEta(sec) {
  if (sec == null) return '—';
  if (sec <= 0) return 'HERE';
  // Rounded to something a person would say out loud. Reporting "~83s" implies
  // a precision the estimate does not have.
  if (sec < 45)  return '~30s';
  if (sec < 90)  return '~1m';
  if (sec < 150) return '~2m';
  if (sec < 600) return `~${Math.round(sec / 60)}m`;
  return '10m+';
}

// Contacts are seconds-old; the channel picker lists files last written days
// ago. One formatter serves both, so it has to roll all the way up — "1166m
// ago" for a log from yesterday is technically true and useless.
const _intelAgo = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60)     return `${s}s`;
  if (s < 3600)   return `${Math.round(s / 60)}m`;
  if (s < 86400)  return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

// Namespaced deliberately. Renderer scripts are CLASSIC <script> tags sharing
// ONE global scope, so a bare `_esc` here collided with map.js's `_esc` and the
// duplicate declaration killed the whole of map.js — "initMapPage is not
// defined", a page away from anything intel-related. Every top-level name in
// this file is _intel*-prefixed for that reason.
const _intelEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function renderIntelEarlyWarning(mount) {
  mount.innerHTML = `
    <div class="intel-ew" style="display:flex;flex-direction:column;height:100%;gap:10px;">
      <div class="fc-control-bar intel-bar">
        <div class="intel-bar-left">
          <button id="intelToggleBtn" class="fc-track-btn">Start watching</button>
          <span id="intelStatusLine" class="intel-status">Not running</span>
        </div>
        <div class="intel-bar-right">
          <label class="intel-field">Alert within
            <input id="intelJumps" type="number" min="1" max="12" value="5" class="intel-num"> jumps
          </label>
          <label class="intel-field">or arriving within
            <input id="intelEta" type="number" min="30" max="600" step="30" value="120" class="intel-num"> s
          </label>
          <div class="intel-dd-wrap">
            <button id="intelCharsBtn" class="fc-track-btn fc-invite-btn">Monitoring: none ▾</button>
            <div id="intelCharsMenu" class="intel-dd-menu" style="display:none;"></div>
          </div>
          <button id="intelChannelsBtn" class="fc-track-btn fc-invite-btn">Channels…</button>
          <button id="intelRulesBtn" class="fc-track-btn fc-invite-btn"
                  title="Custom alerts — watchlist pilots, hulls, gang size, contact standings">Alerts…</button>
          <button id="intelPatternsBtn" class="fc-track-btn fc-invite-btn"
                  title="What hostiles habitually do — which gates they come through, and what hour they turn up">Patterns…</button>
          <button id="intelWidgetBtn" class="fc-track-btn fc-invite-btn"
                  title="Float a compact contact list over the game — pin it to keep it on top">Pop out ↗</button>
          <label class="intel-field" title="Begin watching as soon as EVE Carbon starts, without opening this page">
            <input id="intelAutoStart" type="checkbox"> auto-start
          </label>
          <label class="intel-field" id="intelLiveKillsField"
                 title="Stream killmails from zKillboard as they happen. Works with EVE closed — chat logs need a running client, killmails don't.">
            <input id="intelLiveKills" type="checkbox"> live kills
          </label>
          <label class="intel-field" title="Play a sound when a gang of this size or larger comes into range">
            <input id="intelSoundOn" type="checkbox"> sound
            <select id="intelSoundSize" class="intel-sel">
              <option value="2">gang</option>
              <option value="15">15+</option>
              <option value="31" selected>fleet (30+)</option>
            </select>
          </label>
        </div>
      </div>

      <div id="intelAlertBanner" class="intel-alert-banner" style="display:none;"></div>

      <div class="intel-grid">
        <div class="intel-panel">
          <div class="intel-panel-title">
            CONTACTS <span class="intel-hint">tracked across systems — closing contacts first</span>
          </div>
          <div id="intelContacts" class="intel-contacts">
            <div class="empty-state">Not watching any channels yet.</div>
          </div>
        </div>
        <div class="intel-panel">
          <div class="intel-panel-title">INTEL FEED
            <span class="intel-hint">chat + killmails, newest first — hover a row for the raw line</span></div>
          <div id="intelFeed" class="intel-feed"></div>
        </div>
      </div>
    </div>`;

  document.getElementById('intelToggleBtn').onclick   = _intelToggle;
  document.getElementById('intelChannelsBtn').onclick = _intelOpenChannels;
  document.getElementById('intelCharsBtn').onclick    = _intelToggleCharMenu;
  document.getElementById('intelAutoStart').onchange = async (e) =>
    window.eveAPI.intelSetConfig({ autoStart: !!e.target.checked });
  document.getElementById('intelRulesBtn').onclick    = _intelOpenRules;
  document.getElementById('intelPatternsBtn').onclick = _intelOpenPatterns;
  document.getElementById('intelWidgetBtn').onclick  = async () => {
    try { await window.eveAPI.intelWidgetOpen(); }
    catch (e) { showToast(`Couldn't open the widget: ${e.message}`, 'error'); }
  };
  document.getElementById('intelLiveKills').onchange = async (e) => {
    const on = !!e.target.checked;
    await window.eveAPI.intelSetConfig({ options: { liveKills: on } });
    // Say what it will and won't do, rather than letting a silent checkbox imply
    // it replaces chat intel. It reports fights that have already started.
    showToast(on
      ? 'Live killmails on — works with EVE closed, but reports fights already in progress.'
      : 'Live killmails off.', on ? 'success' : 'info');
    _intelPaintStatus();
  };
  document.getElementById('intelSoundOn').onchange   = _intelSaveSound;
  document.getElementById('intelSoundSize').onchange = _intelSaveSound;
  // Any click outside closes the dropdown — without this it stays open behind
  // the modal and over the contact list.
  document.addEventListener('click', _intelMaybeCloseCharMenu, true);
  for (const [id, key] of [['intelJumps', 'alertJumps'], ['intelEta', 'etaSeconds']]) {
    document.getElementById(id).onchange = async (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v <= 0) return;
      await window.eveAPI.intelSetConfig({ options: { [key]: v } });
    };
  }

  _intelWire();

  // Restore prior settings so the thresholds survive a page change.
  try {
    const cfg = await window.eveAPI.intelGetConfig();
    if (cfg?.options?.alertJumps) document.getElementById('intelJumps').value = cfg.options.alertJumps;
    if (cfg?.options?.etaSeconds) document.getElementById('intelEta').value  = cfg.options.etaSeconds;
    document.getElementById('intelAutoStart').checked = !!cfg?.autoStart;
    document.getElementById('intelLiveKills').checked = !!cfg?.options?.liveKills;
    document.getElementById('intelSoundOn').checked   = !!cfg?.sound?.enabled;
    if (cfg?.sound?.minSize) document.getElementById('intelSoundSize').value = String(cfg.sound.minSize);
    _intelSound = cfg?.sound || null;
    await _intelLoadCharacters();
    const st = await window.eveAPI.intelStatus();
    _intelStatus = st;
    if (st.running) { _intelStartRefresh(); }
    _intelPaintStatus();
  } catch (_) { /* engine not built yet — the button builds it */ }
}

// Push channels rather than polling: an alert that waited 2s for the next tick
// is 2s of a 90s budget spent on nothing.
function _intelWire() {
  if (_intelWired) return;
  _intelWired = true;
  _intelUnsub.push(window.eveAPI.on('intel-alert',  (a) => _intelOnAlert(a)));
  _intelUnsub.push(window.eveAPI.on('intel-reports', (batch) => {
    _intelFeed = [...batch.reverse(), ..._intelFeed].slice(0, 120);
    _intelPaintFeed();
  }));
  _intelUnsub.push(window.eveAPI.on('intel-status', (s) => { _intelStatus = { ..._intelStatus, reader: s }; _intelPaintStatus(); }));
  // A monitored character jumped. This arrives within a second of the gate
  // flash because it comes from EVE's own Local log, not from an ESI poll —
  // and it MUST be pushed rather than polled, because every jump silently
  // invalidates every distance on screen until the origin catches up.
  _intelUnsub.push(window.eveAPI.on('intel-characters', (list) => {
    if (!Array.isArray(list)) return;
    _intelChars = list;
    _intelPaintCharButton();
    _intelRepaintCharMenu();
  }));
  _intelUnsub.push(window.eveAPI.on('intel-origins', ({ origins, reach, moved } = {}) => {
    _intelStatus = { ..._intelStatus, origins, reach };
    _intelPaintStatus();
    // Say it out loud. The contact list is about to renumber itself, and an
    // operator who doesn't know why will read it as the tool glitching.
    //
    // Only an actual MOVE, though. On startup every monitored character is
    // discovered at once (previous === null) — announcing those as jumps would
    // greet the operator with a stack of toasts about ships that have not
    // moved, which is exactly the crying-wolf this feature cannot afford.
    for (const m of (moved || [])) {
      if (!m.previous) continue;
      const who = _intelChars.find(c => Number(c.characterId) === Number(m.characterId));
      showToast(`${who ? who.name : 'Monitored character'} moved ${m.previous} → ${m.systemName} — distances re-measured.`, 'info');
    }
  }));
}

function _intelStopRefresh() {
  if (_intelTimer) { clearInterval(_intelTimer); _intelTimer = null; }
}

function _intelStartRefresh() {
  _intelStopRefresh();
  const tick = async () => {
    try {
      _intelContacts = await window.eveAPI.intelContacts();
      _intelPaintContacts();
    } catch (_) {}
  };
  tick();
  _intelTimer = setInterval(tick, INTEL_REFRESH_MS);
}

async function _intelToggle() {
  const btn = document.getElementById('intelToggleBtn');
  if (!btn) return;
  const running = _intelStatus && _intelStatus.running;
  btn.disabled = true;
  try {
    if (running) {
      await window.eveAPI.intelStop();
      _intelStopRefresh();
      _intelStatus = { ..._intelStatus, running: false };
    } else {
      const cfg = await window.eveAPI.intelGetConfig();
      // Live killmails need no channels and no running client, so somebody using
      // only that source must not be sent to the channel picker they don't want.
      if ((!cfg.channels || !cfg.channels.length) && !cfg?.options?.liveKills) {
        btn.disabled = false;
        showToast('Pick at least one intel channel, or switch on live kills.', 'warning');
        return _intelOpenChannels();
      }
      // Origin = where the selected character actually is. Without it every
      // distance is meaningless, so this is set before the reader starts.
      const origin = await _intelResolveOrigin();
      _intelStatus = await window.eveAPI.intelStart({ channels: cfg.channels, origin });
      _intelStartRefresh();
      // Say so when the last few minutes were picked back up, rather than
      // leaving the operator to wonder whether the contacts on screen are live.
      const resumed = _intelStatus?.reader?.resumed || 0;
      if (resumed) {
        showToast(`Resumed — ${resumed} contact${resumed === 1 ? '' : 's'} still in range from before.`, 'warning');
      }
      if (origin == null) {
        showToast('Watching channels, but the fleet position is unknown — sync a character so distances can be measured.', 'warning');
      }
    }
  } catch (e) {
    showToast(`Intel: ${e.message}`, 'error');
  }
  btn.disabled = false;
  _intelPaintStatus();
}

/** The selected character's current system — the fallback when nothing is
 *  explicitly monitored, so the tool still works with zero configuration. */
async function _intelResolveOrigin() {
  try {
    const charId = (typeof getSelectedCharacterId === 'function') ? getSelectedCharacterId() : null;
    if (!charId) return null;
    const data = await window.eveAPI.getCharacterData(charId);
    const sysId = data?.location?.solar_system_id ?? data?.location?.solarSystemId ?? null;
    return sysId != null ? Number(sysId) : null;
  } catch (_) { return null; }
}

// ── Sound alert ───────────────────────────────────────────────────────────────
// Off by default and gated on gang SIZE, because a sound that fires on every
// solo roamer gets muted within an hour and is then absent for the fleet it was
// meant to catch. Reuses the app's existing ping-sound library (bundled
// assets/audio plus anything in userData/ping-sounds) rather than shipping
// another audio file.
const INTEL_SOUND_COOLDOWN_MS = 20000;

async function _intelSaveSound() {
  const on   = document.getElementById('intelSoundOn');
  const size = document.getElementById('intelSoundSize');
  if (!on || !size) return;
  _intelSound = { enabled: !!on.checked, minSize: Number(size.value) || 31, volume: 0.7 };
  try { await window.eveAPI.intelSetConfig({ sound: _intelSound }); } catch (_) {}
  if (_intelSound.enabled) _intelPlaySound(true);   // confirm it's audible when switched on
}

async function _intelPlaySound(force = false) {
  try {
    // One sound per cooldown however many contacts trip at once — a fleet
    // landing produces a burst of alerts, and 12 overlapping chimes is noise,
    // not a warning.
    const now = Date.now();
    if (!force && now - _intelLastSound < INTEL_SOUND_COOLDOWN_MS) return;
    _intelLastSound = now;
    if (!_intelAudio) {
      const list = await window.eveAPI.pingSoundList();
      if (!list || !list.length) return;
      const pick = list.find(s => /alarm|alert|siren|warn/i.test(s.name)) || list[0];
      _intelAudio = new Audio(pick.url);
    }
    _intelAudio.volume = (_intelSound && _intelSound.volume) || 0.7;
    _intelAudio.currentTime = 0;
    await _intelAudio.play();
  } catch (_) { /* autoplay blocked or no audio device — never break the alert */ }
}

// ── Monitored characters ──────────────────────────────────────────────────────
// A mining op is spread out: barge in the belt, Orca on grid, scout a couple of
// systems ahead. Measuring danger from ONE character misses whichever of them is
// actually in trouble, so several can be watched at once and the alert names
// whoever the contact is closest to.
//
// "Online" comes from the chat logs, not ESI — EVE only writes a character's log
// file while that character is running, which needs no scope and covers alts on
// other accounts.
async function _intelLoadCharacters() {
  try { _intelChars = await window.eveAPI.intelMonitorableCharacters(); }
  catch (_) { _intelChars = []; }
  _intelPaintCharButton();
}

function _intelPaintCharButton() {
  const btn = document.getElementById('intelCharsBtn');
  if (!btn) return;
  const on = _intelChars.filter(c => c.monitored);
  btn.textContent = on.length === 0 ? 'Monitoring: none ▾'
    : on.length === 1 ? `Monitoring: ${on[0].name} ▾`
    : `Monitoring: ${on.length} characters ▾`;
  btn.classList.toggle('intel-dd-active', on.length > 0);
}

function _intelToggleCharMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('intelCharsMenu');
  if (!menu) return;
  if (menu.style.display !== 'none') { _intelCloseCharMenu(); return; }
  _intelRenderCharMenu();
  menu.style.display = '';
  // Jumps arrive by push, but logging in and out does not — and a stale online
  // dot is the thing that makes the list look frozen. A slow poll while the
  // menu is actually open costs nothing and stops only when it closes.
  _intelLoadCharacters().then(_intelRepaintCharMenu);
  _intelCharTimer = setInterval(() => {
    _intelLoadCharacters().then(_intelRepaintCharMenu);
  }, INTEL_CHAR_POLL_MS);
}

function _intelCloseCharMenu() {
  const menu = document.getElementById('intelCharsMenu');
  if (menu) menu.style.display = 'none';
  if (_intelCharTimer) { clearInterval(_intelCharTimer); _intelCharTimer = null; }
}

function _intelMaybeCloseCharMenu(e) {
  const menu = document.getElementById('intelCharsMenu');
  if (!menu || menu.style.display === 'none') return;
  if (e.target.closest && e.target.closest('.intel-dd-wrap')) return;
  _intelCloseCharMenu();
}

/** Redraw the menu in place, only if it is open — scroll position preserved. */
function _intelRepaintCharMenu() {
  const menu = document.getElementById('intelCharsMenu');
  if (!menu || menu.style.display === 'none') return;
  const top = menu.scrollTop;
  _intelRenderCharMenu();
  menu.scrollTop = top;
}

/**
 * How a character's position was learned, in words.
 *
 * Worth showing, because the two sources are not the same claim. EVE writes
 * "Channel changed to Local : <system>" the instant you arrive, so a log
 * position is seconds old. The ESI row behind it is refreshed on a 30-minute
 * stale gate, which is how a super could jump to its ratting system and the
 * tool go on measuring every hostile's distance from the staging system it
 * left. Saying which one you are looking at is the difference between trusting
 * the number and guessing at it.
 */
function _intelPosTitle(c) {
  if (c.systemId == null) return 'no known position';
  if (c.positionSource === 'log') {
    return c.online ? 'read from the game log — updates as you jump'
                    : `where this character logged off${c.positionAt ? `, ${_intelAgo(c.positionAt)} ago` : ''}`;
  }
  if (c.positionSource === 'esi') {
    return `from ESI${c.positionAt ? `, ${_intelAgo(c.positionAt)} ago` : ''} — run EVE for a live position`;
  }
  return 'position of unknown age';
}

/** The badge itself: LIVE earns its emphasis, everything else states its age. */
function _intelPosBadge(c) {
  if (c.systemId == null) return '';
  if (c.positionSource === 'log' && c.online) {
    return '<span class="intel-dd-src intel-dd-src-live">LIVE</span>';
  }
  if (c.positionSource === 'log') return '<span class="intel-dd-src">logged off</span>';
  if (c.positionSource === 'esi') {
    return `<span class="intel-dd-src intel-dd-src-stale">ESI${c.positionAt ? ` ${_intelAgo(c.positionAt)}` : ''}</span>`;
  }
  return '';
}

function _intelRenderCharMenu() {
  const menu = document.getElementById('intelCharsMenu');
  if (!menu) return;
  if (!_intelChars.length) {
    menu.innerHTML = '<div class="intel-dd-empty">No characters. Add one on the Characters page.</div>';
    return;
  }
  menu.innerHTML = `
    <div class="intel-dd-head">Watch for hostiles near…</div>
    ${_intelChars.map(c => `
      <label class="intel-dd-row ${c.systemId == null ? 'intel-dd-disabled' : ''}"
             title="${c.systemId == null ? 'No known position — sync this character first'
                     : `${_intelEsc(c.systemName || `System ${c.systemId}`)} · ${_intelEsc(_intelPosTitle(c))}`}">
        <input type="checkbox" data-char="${c.characterId}"
               ${c.monitored ? 'checked' : ''} ${c.systemId == null ? 'disabled' : ''}>
        <span class="intel-dd-dot ${c.online ? 'intel-dd-online' : ''}"></span>
        <span class="intel-dd-name">${_intelEsc(c.name)}</span>
        <span class="intel-dd-loc">
          <span class="intel-dd-sys">${c.systemName ? _intelEsc(c.systemName)
            : (c.systemId != null ? `System ${c.systemId}` : 'position unknown')}</span>
          ${_intelPosBadge(c)}
        </span>
      </label>`).join('')}
    <div class="intel-dd-foot">● = logged in · <b>LIVE</b> = position read from the game as you jump</div>`;

  for (const box of menu.querySelectorAll('input[data-char]')) {
    box.onchange = async () => {
      const picked = [...menu.querySelectorAll('input[data-char]:checked')].map(i => Number(i.dataset.char));
      for (const c of _intelChars) c.monitored = picked.includes(Number(c.characterId));
      _intelPaintCharButton();
      try {
        const res = await window.eveAPI.intelSetMonitored(picked);
        _intelStatus = { ..._intelStatus, origins: res.origins, reach: res.reach };
        _intelPaintStatus();
        if (res.skipped) {
          showToast(`${res.skipped} character${res.skipped === 1 ? ' has' : 's have'} no known position — sync them to include them.`, 'warning');
        }
      } catch (e) { showToast(`Could not set monitoring: ${e.message}`, 'error'); }
    };
  }
}

function _intelPaintStatus() {
  const line = document.getElementById('intelStatusLine');
  const btn  = document.getElementById('intelToggleBtn');
  if (!line || !btn) return;
  const st = _intelStatus || {};
  btn.textContent = st.running ? 'Stop watching' : 'Start watching';
  btn.classList.toggle('active', !!st.running);

  if (!st.running) { line.textContent = 'Not running'; line.className = 'intel-status'; return; }
  const chans = (st.reader?.channels || []).map(c => c.channel);
  const nOrigins = (st.origins || []).length;
  const where = nOrigins
    ? `${nOrigins} character${nOrigins === 1 ? '' : 's'}, ${st.reach} systems in range`
    : (st.origin != null ? `${st.reach} systems in range` : 'NO POSITION MONITORED');

  // The live kill feed is reported separately from the chat reader on purpose:
  // it keeps working with EVE closed, so "no log files" and "no intel at all"
  // are different states and conflating them would hide a working source.
  const live = st.liveKills || {};
  const liveBit = live.running
    ? ` · live kills ${live.connected ? `connected (${live.received || 0})` : 'connecting…'}`
    : '';
  const chatBit = chans.length ? `Watching ${chans.join(', ')}`
    : (live.running ? 'No chat logs (EVE not running?)' : 'No matching log files found');

  line.textContent = `${chatBit} · ${where}${liveBit}`;
  // Only a missing POSITION is fatal now — without chat but with the live feed
  // up, the tool is still doing its job.
  const bad = (!nOrigins && st.origin == null) || (!chans.length && !live.running);
  line.className = 'intel-status' + (bad ? ' intel-status-warn' : ' intel-status-ok');
}

function _intelPaintContacts() {
  const host = document.getElementById('intelContacts');
  if (!host) return;
  // Pilot tracks are the useful ones — a named hostile followed across systems
  // has a heading. System-only rows are folded in behind them.
  const rows = _intelContacts.filter(c => c.kind === 'pilot' || c.sightings > 1 || c.jumps <= 3);
  if (!rows.length) {
    host.innerHTML = `<div class="empty-state">${_intelStatus?.running
      ? 'No contacts in range. Quiet is good.' : 'Not watching any channels yet.'}</div>`;
    return;
  }
  // Same row builder as the pop-out (src/shared/intel-row.js) — one layout, two
  // windows, so they cannot drift apart.
  host.innerHTML = IntelRow.headerHtml() + rows.slice(0, 40).map(c => {
    // The jumps figure is exact and the time is not; the tooltip is where that
    // distinction gets spelled out, along with the path this contact took.
    const basis = c.etaMeasured
      ? `estimated from this contact's observed ${c.jumpsPerMin.toFixed(1)} jumps/min`
      : "rough estimate — this contact's speed has not been measured yet";
    const path = (c.path || []).slice(-5);
    const title = [
      `${c.jumps} gate jump${c.jumps === 1 ? '' : 's'} away (exact). Time ${basis}.`,
      c.threatTo ? `Nearest to ${c.threatTo}.` : '',
      path.length > 1 ? `Seen: ${path.join(' › ')}` : '',
      `${c.sightings} report${c.sightings === 1 ? '' : 's'}, last ${_intelAgo(c.last)} ago.`,
    ].filter(Boolean).join(' ');
    return IntelRow.rowHtml({ ...c, body: title },
                            { relative: true, extra: _intelPatPredictChip });
  }).join('');
}

function _intelPaintFeed() {
  const host = document.getElementById('intelFeed');
  if (!host) return;
  if (!_intelFeed.length) { host.innerHTML = '<div class="empty-state">Nothing reported yet.</div>'; return; }
  // Wall-clock time here, not "4m ago": the feed is a record of what was said
  // and when, and the timestamps line up with what people said in the channel.
  host.innerHTML = IntelRow.headerHtml() + _intelFeed.slice(0, 80)
    // The channel goes in the tooltip beside the raw line rather than taking a
    // chip: it was the widest low-value thing in the row, and which channel
    // carried a report almost never changes what you do about it.
    .map(r => IntelRow.rowHtml({ ...r, body: `[${r.channel || '?'}] ${r.body || ''}` }))
    .join('');
}

// An alert has to survive the operator not looking at this tab, so it also
// raises the app-wide toast. The banner carries the detail.
function _intelOnAlert(a) {
  const banner = document.getElementById('intelAlertBanner');
  const eta = _intelFmtEta(a.etaSeconds);
  if (banner) {
    banner.style.display = '';
    banner.className = `intel-alert-banner intel-${a.level}`;
    banner.innerHTML = `
      <span class="material-symbols-outlined">warning</span>
      <strong>${_intelEsc(a.label)}</strong>
      ${a.inbound ? 'inbound' : 'reported'} in <strong>${_intelEsc(a.systemName)}</strong>
      — <strong>${a.jumps} jump${a.jumps === 1 ? '' : 's'}</strong> out, est. ${eta}
      ${a.tackle ? '<span class="intel-tag intel-role-tackle">TACKLE</span>' : ''}
      ${a.band ? `<span class="intel-tag intel-band-${a.band}">${a.band === 'fleet' ? 'FLEET' : 'GANG'} ${a.size}</span>` : ''}
      ${a.reason === 'closing' ? ` (closed ${a.closing} jumps)` : ''}`;
  }
  // Sound only for gangs at or above the configured size — see the note on
  // INTEL_SOUND_COOLDOWN_MS above.
  if (_intelSound && _intelSound.enabled && a.size && a.size >= (_intelSound.minSize || 31)) {
    _intelPlaySound();
  }
  if (typeof showToast === 'function') {
    const size = a.size ? ` · ${a.band === 'fleet' ? 'FLEET' : 'gang'} of ${a.size}` : '';
    showToast(`${a.label} — ${a.jumps} jump${a.jumps === 1 ? '' : 's'} out${a.tackle ? ' (TACKLE)' : ''}${size}, est. ${eta}`,
               a.level === 'critical' ? 'error' : 'warning');
  }
}

// ── Channel picker ────────────────────────────────────────────────────────────
// Lists channels EVE has actually logged, newest first, so the intel channels
// in use float to the top instead of being lost among Local and Corp.
async function _intelOpenChannels() {
  let data;
  try { data = await window.eveAPI.intelDiscoverChannels(); }
  catch (e) { return showToast(`Could not read chat logs: ${e.message}`, 'error'); }

  if (!data.dir) {
    return showToast('No EVE chat logs found. Enable "Log Chat to File" in EVE (Settings → Chat).', 'error');
  }
  const watching = new Set(data.watching || []);
  const rows = data.channels.map(c => `
    <label class="intel-ch-row">
      <input type="checkbox" value="${_intelEsc(c.channel)}" ${watching.has(c.channel) ? 'checked' : ''}>
      <span class="intel-ch-name">${_intelEsc(c.channel)}</span>
      <span class="intel-ch-when">${_intelAgo(c.lastSeen)} ago</span>
    </label>`).join('');

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal intel-ch-modal">
      <h3>Intel channels</h3>
      <div class="intel-ch-help">
        Pick the channels to watch. Regional intel channels work best —
        each one's covered regions are read from its MOTD automatically.
      </div>
      <div class="intel-ch-list">${rows || '<div class="empty-state">No chat logs found.</div>'}</div>
      <div class="intel-ch-dir">Reading: ${_intelEsc(data.dir)}</div>
      <div class="modal-actions">
        <button class="fc-track-btn fc-invite-btn" data-act="cancel">Cancel</button>
        <button class="fc-track-btn" data-act="save">Save</button>
      </div>
    </div>`;
  // .modal-backdrop carries alignment but not display (base.css) — callers turn
  // it on, the same way bugs.js and the industry modals do.
  modal.style.display = 'flex';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('[data-act="cancel"]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const picked = [...modal.querySelectorAll('input:checked')].map(i => i.value);
    await window.eveAPI.intelSetConfig({ channels: picked });
    close();
    showToast(picked.length ? `Watching ${picked.length} channel${picked.length === 1 ? '' : 's'}.`
                            : 'No channels selected.', picked.length ? 'success' : 'warning');
    if (_intelStatus?.running) {
      _intelStatus = await window.eveAPI.intelStart({ channels: picked, origin: await _intelResolveOrigin() });
      _intelPaintStatus();
    }
  };
}

/** Called when leaving the tab — stops the refresh loop but keeps watching. */
function teardownIntelEarlyWarning() {
  _intelStopRefresh();
}
