// ─── Fleet Commander ──────────────────────────────────────────────────────────
// Sub-nav router (mirrors navigateIndustryTab) plus the first tool: a near
// real-time Fleet Composition Tracker. Add a tool by adding a .fc-sub-btn in
// pageLoader.js (fc template) and a branch in navigateFcTab() below.

let currentFcTab    = null;

// ── Fleet Composition state ──────────────────────────────────────────────────
const FC_POLL_MS = 6000;            // ESI caches /fleets/members for ~5s
// Not in a fleet? /characters/{id}/fleet answers 404, and at 6s that is 600 4xx
// an hour against a shared 100-errors-per-60s budget the whole app draws on —
// spent entirely on learning nothing changed. Idle polling backs off to this.
const FC_IDLE_POLL_MS = 30_000;
let _fcShipRoles  = null;           // { [typeId]: {name, group_name, tactical_role} } — loaded once
let _fcPollTimer  = null;
let _fcPollEveryMs = FC_POLL_MS;    // current cadence, so a change can restart the timer
let _fcBusy       = false;          // guards against overlapping poll cycles
let _fcTracking   = false;
let _fcCharId     = null;           // character authenticating as fleet boss
let _fcFleetId    = null;
let _fcDoctrine   = 'shield';
let _fcOpId       = null;           // running op, or null when only watching
let _fcOpName     = '';
let _fcBossId     = null;           // last seen fleet_boss_id, to notice a handover
const _fcNameCache     = new Map(); // characterId -> name (resolved via ESI, cached)
const _fcTypeNameCache = new Map(); // shipTypeId  -> name (ESI fallback when the SDE lacks the hull)
const _fcExpanded  = new Set();     // expanded chip keys ("roleKey|typeId") — survives the 6s refresh

// ── Doctrine profiles ─────────────────────────────────────────────────────────
// Each doctrine decides: how ships bucket into role cards (by SDE group_id, with
// optional per-type overrides), which summary tiles show (each role with a `thr`
// gets a % + red/green/yellow zone), whether wrong-tank "false flags" apply
// (expectedTank), and what the fleet needs (checks). Add a doctrine by adding an
// entry here and an <option> in renderFleetComposition().

// Combat doctrines (shield/armor/capital) share these buckets + group mapping.
const FC_COMBAT_ROLES = [
  { key: 'Tackle',          label: 'Tackle & Screen', icon: 'my_location',       thr: { min: 5,  max: 10 } },
  { key: 'Logistics',       label: 'Logistics',       icon: 'health_and_safety', thr: { min: 10, max: 15 } },
  { key: 'Command Links',   label: 'Command Links',   icon: 'cell_tower' },
  { key: 'Capital Command', label: 'Capital Command', icon: 'military_tech' },
  { key: 'Capital Support', label: 'Capital Support', icon: 'rocket_launch' },
  { key: 'Other',           label: 'Other / DPS',     icon: 'bolt' },
];
const FC_COMBAT_GROUP_ROLES = {
  831:  'Tackle',           // Interceptor
  541:  'Tackle',           // Interdictor
  894:  'Tackle',           // Heavy Interdiction Cruiser
  832:  'Logistics',        // Logistics Cruiser
  1527: 'Logistics',        // Logistics Frigate
  540:  'Command Links',    // Command Ship
  1534: 'Command Links',    // Command Destroyer
  5120: 'Capital Command',  // Command Carrier
  4902: 'Capital Command',  // Expedition Command Ship
  1538: 'Capital Support',  // Force Auxiliary (FAX)
};

// Mining doctrine — miners + mining boosts; recons/bridgers fall under Other.
const FC_MINING_ROLES = [
  { key: 'Miners',        label: 'Miners',        icon: 'diamond' },
  { key: 'Mining Boosts', label: 'Mining Boosts', icon: 'cell_tower' },
  { key: 'Other',         label: 'Other',         icon: 'bolt' },
];
const FC_MINING_GROUP_ROLES = {
  463:  'Miners',          // Mining Barge (Procurer/Retriever/Covetor)
  543:  'Miners',          // Exhumer (Skiff/Mackinaw/Hulk)
  1283: 'Miners',          // Expedition Frigate (Prospect/Endurance)
  941:  'Mining Boosts',   // Industrial Command Ship (Orca/Porpoise)
  883:  'Mining Boosts',   // Capital Industrial Ship (Rorqual)
};
const FC_MINING_TYPE_ROLES = {
  32880: 'Miners',         // Venture — lives in the generic Frigate group, so map by type
};

const FC_DOCTRINES = {
  shield: {
    label: 'Shield', expectedTank: 'shield',
    roles: FC_COMBAT_ROLES, groupRoles: FC_COMBAT_GROUP_ROLES,
    checks: (c) => [{ label: 'Command Links present', ok: c['Command Links'] > 0, detail: `${c['Command Links']} link ship${c['Command Links'] === 1 ? '' : 's'}` }],
  },
  armor: {
    label: 'Armor', expectedTank: 'armor',
    roles: FC_COMBAT_ROLES, groupRoles: FC_COMBAT_GROUP_ROLES,
    checks: (c) => [{ label: 'Command Links present', ok: c['Command Links'] > 0, detail: `${c['Command Links']} link ship${c['Command Links'] === 1 ? '' : 's'}` }],
  },
  capital: {
    label: 'Capital / Titan', expectedTank: null,
    roles: FC_COMBAT_ROLES, groupRoles: FC_COMBAT_GROUP_ROLES,
    checks: (c) => [
      { label: 'Capital Command (Command Carrier)', ok: c['Capital Command'] > 0, detail: `${c['Capital Command']} command carrier${c['Capital Command'] === 1 ? '' : 's'}` },
      { label: 'Capital Support (FAX)',             ok: c['Capital Support'] > 0, detail: `${c['Capital Support']} FAX` },
    ],
  },
  mining: {
    label: 'Mining Fleet', expectedTank: null,
    roles: FC_MINING_ROLES, groupRoles: FC_MINING_GROUP_ROLES, typeRoles: FC_MINING_TYPE_ROLES,
    checks: (c) => [
      { label: 'Mining boosts present (Orca/Porpoise/Rorqual)', ok: c['Mining Boosts'] > 0, detail: `${c['Mining Boosts']} boost ship${c['Mining Boosts'] === 1 ? '' : 's'}` },
      { label: 'Miners present', ok: c['Miners'] > 0, detail: `${c['Miners']} miner${c['Miners'] === 1 ? '' : 's'}` },
    ],
  },
};

// ─── Sub-nav routing ──────────────────────────────────────────────────────────
function initFcPage() {
  document.querySelectorAll('.fc-sub-btn').forEach(btn => {
    // Replace-node trick (same as Industry) clears any stale listeners on re-entry.
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => navigateFcTab(fresh.dataset.fcTab));
  });
  const content = document.getElementById('fcTabContent');
  if (content && !content.querySelector(':scope > *')) {
    // First entry this session — reopen the sub-tab the user was last on
    // (so Ctrl+R lands back on e.g. the Fitting Simulator, not Composition).
    let last = null;
    try { last = localStorage.getItem('fcLastTab'); } catch (_) {}
    navigateFcTab(last === 'fitting' ? 'fitting' : last === 'fleetfight' ? 'fleetfight' : 'composition');
  }
}

function navigateFcTab(tab) {
  // Leaving the composition tab tears down the polling loop so it never runs in
  // the background against a hidden page — UNLESS an op is recording. An FC
  // checks a fit or the intel tab constantly mid-fleet, and an op that stopped
  // collecting every time they did would have holes exactly where the
  // interesting parts are.
  if (currentFcTab === 'composition' && tab !== 'composition' && !_fcOpId) _fcStopTracking();
  // Leaving Early Warning stops the contact refresh, but NOT the watcher — the
  // whole point is that it keeps warning you while you're on another tab.
  if (currentFcTab === 'intel' && tab !== 'intel' && typeof teardownIntelEarlyWarning === 'function') {
    teardownIntelEarlyWarning();
  }
  currentFcTab = tab;
  try { localStorage.setItem('fcLastTab', tab); } catch (_) {}

  document.querySelectorAll('.fc-sub-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fcTab === tab);
  });

  const mount = document.getElementById('fcTabContent');
  if (!mount) return;

  if (tab === 'composition') {
    renderFleetComposition(mount);
  } else if (tab === 'fitting') {
    if (typeof renderFitting === 'function') renderFitting(mount);
  } else if (tab === 'fleetfight') {
    renderFleetFightNotify(mount);
  } else if (tab === 'ophistory') {
    renderOpHistory(mount);
  } else if (tab === 'intel') {
    if (typeof renderIntelEarlyWarning === 'function') renderIntelEarlyWarning(mount);
  }
}

// ─── Fleet Fight Notification (CCP form, embedded) ────────────────────────────
// CCP asks FCs to file advance notice of large/massive fleet fights so they can
// reinforce the destination node server-side. Embedded in-app like the Forums
// page (webview) — the form lives entirely on CCP's site; nothing is stored.
const FLEET_FIGHT_URL = 'https://community.eveonline.com/support/fleet-fight/';

/* ── Op History ───────────────────────────────────────────────────────────────
   Every past op, so a report survives the fleet that made it. The report used
   to be reachable only from the live tracking flow: stop tracking or restart
   the app and the data sat in the database with no route to it — precisely when
   an FC wants it, having run three fleets back to back and written up none.

   Times are UTC because EVE is, and because the report itself is. A local
   column here would silently disagree with the report it opens. */

const _ophWhen = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—');

function _ophDur(a, b) {
  if (!a) return '—';
  const ms = (b || Date.now()) - a;
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

function _ophIsk(v) {
  const n = Number(v) || 0;
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'b';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toFixed(0);
}

async function renderOpHistory(mount) {
  mount.innerHTML = '<div class="oph-wrap"><div class="oph-empty">Loading past ops…</div></div>';

  let ops = [];
  try { ops = await window.eveAPI.fleetOpList(100); } catch (_) { ops = []; }
  if (!Array.isArray(ops)) ops = [];

  if (!ops.length) {
    mount.innerHTML =
      '<div class="oph-wrap"><div class="oph-empty">' +
      'No ops recorded yet.<br>' +
      'Start one from <strong>Fleet Tracker</strong> — Start Tracking, then Start Op.' +
      '</div></div>';
    return;
  }

  const rows = ops.map((o) => {
    const live    = !o.ended_at;
    const endCls  = live ? 'live' : (o.end_reason === 'boss-handover' ? 'handover' : '');
    const endText = live ? 'recording' : (o.end_reason || 'stopped');
    const k = Number(o.kills) || 0, l = Number(o.losses) || 0;
    return '' +
      '<tr>' +
        '<td><span class="oph-when">' + _ophWhen(o.started_at) + '</span></td>' +
        '<td><span class="oph-name">' + escHtml(o.name || 'Untitled') + '</span>' +
            (o.doctrine ? '<span class="oph-doct">' + escHtml(o.doctrine) + '</span>' : '') + '</td>' +
        '<td class="r oph-num">' + _ophDur(o.started_at, o.ended_at) + '</td>' +
        '<td class="r oph-num">' + (o.pilots || 0) + '</td>' +
        '<td class="r oph-num">' + (o.systems || 0) + '</td>' +
        '<td class="r ' + (k ? 'oph-kill' : 'oph-zero') + '">' + k + '</td>' +
        '<td class="r ' + (l ? 'oph-loss' : 'oph-zero') + '">' + l + '</td>' +
        '<td class="r ' + (Number(o.isk_killed) ? 'oph-kill' : 'oph-zero') + '">' + _ophIsk(o.isk_killed) + '</td>' +
        '<td class="r ' + (Number(o.isk_lost) ? 'oph-loss' : 'oph-zero') + '">' + _ophIsk(o.isk_lost) + '</td>' +
        '<td><span class="oph-end ' + endCls + '">' + escHtml(endText) + '</span></td>' +
        '<td class="r oph-actions">' +
          '<button class="oph-report-btn" data-oph-op="' + Number(o.op_id) + '">REPORT</button>' +
          (live ? '' : '<button class="oph-del-btn" title="Delete this op and all of its data"' +
                       ' data-oph-del="' + Number(o.op_id) + '"' +
                       ' data-oph-name="' + escHtml(o.name || 'Untitled') + '">DELETE</button>') +
        '</td>' +
      '</tr>';
  }).join('');

  mount.innerHTML =
    '<div class="oph-wrap">' +
      '<div class="oph-head">' +
        '<span class="oph-title">OP HISTORY</span>' +
        '<span class="oph-note">' + ops.length + ' recorded · times UTC</span>' +
      '</div>' +
      '<table class="oph-table"><thead><tr>' +
        '<th>Started</th><th>Op</th><th class="r">Dur</th><th class="r">Pilots</th>' +
        '<th class="r">Systems</th><th class="r">Kills</th><th class="r">Losses</th>' +
        '<th class="r">Destroyed</th><th class="r">Lost</th><th>End</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>';

  // The modal reads a module-level op id, so point it at the chosen op and
  // reuse the same renderer the live flow uses — one report, one code path.
  mount.querySelectorAll('.oph-report-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      _fcReportOpId = Number(btn.dataset.ophOp);
      _fcShowReport();
    });
  });

  // Deleting an op is irreversible and there is no undo, so the confirm names
  // the op and counts what goes with it. A bare "Are you sure?" trains people
  // to click through it, which is worse than no dialog at all.
  mount.querySelectorAll('.oph-del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id   = Number(btn.dataset.ophDel);
      const row  = ops.find((o) => Number(o.op_id) === id) || {};
      const bits = [
        (row.pilots  || 0) + ' pilot' + (row.pilots  === 1 ? '' : 's'),
        (row.systems || 0) + ' system' + (row.systems === 1 ? '' : 's'),
        ((row.kills || 0) + (row.losses || 0)) + ' killmail' + (((row.kills || 0) + (row.losses || 0)) === 1 ? '' : 's'),
      ].join(', ');

      const ok = await showConfirm({
        title: 'Delete this op?',
        body: '"' + (row.name || 'Untitled') + '"\n' +
              'Started ' + _ophWhen(row.started_at) + ' UTC · ' + bits + '.\n\n' +
              'The op and all of its recorded data are removed from the database. ' +
              'This cannot be undone, and the report will no longer be available.',
        confirmText: 'Delete op',
        cancelText: 'Keep it',
        danger: true,
      });
      if (!ok) return;

      btn.disabled = true;
      btn.textContent = '…';
      const res = await window.eveAPI.fleetOpDelete(id).catch((e) => ({ ok: false, error: e.message }));
      if (!res || !res.ok) {
        btn.disabled = false;
        btn.textContent = 'DELETE';
        if (typeof showToast === 'function') showToast((res && res.error) || 'could not delete that op', 'error');
        return;
      }
      if (typeof showToast === 'function') showToast('Op deleted', 'success');
      renderOpHistory(mount);   // re-read rather than splice, so the list matches the database
    });
  });
}

function renderFleetFightNotify(mount) {
  mount.innerHTML = `
    <div class="fc-fleetfight" style="display:flex;flex-direction:column;height:100%;">
      <div class="fc-control-bar" style="flex:none;">
        <div class="fc-ff-blurb">
          <span class="material-symbols-outlined fc-ff-icon">campaign</span>
          <div>
            <div class="fc-ff-title">CCP Fleet Fight Notification</div>
            <div class="fc-ff-sub">Expecting a large or massive brawl? File this with CCP — ideally a day
              ahead — so they can reinforce the destination node server-side.</div>
          </div>
        </div>
        <span style="flex:1;"></span>
        <button class="forum-tb-btn" title="Reload form"
                onclick="fcFleetFightNav('reload')"><span class="material-symbols-outlined">refresh</span></button>
        <button class="forum-tb-btn" title="Open in external browser"
                onclick="fcFleetFightNav('external')"><span class="material-symbols-outlined">open_in_new</span></button>
      </div>
      <div class="forum-viewport" style="flex:1;min-height:0;">
        <webview id="fcFleetFightWebview" partition="persist:fleetfight"
                 src="${FLEET_FIGHT_URL}" style="width:100%;height:100%;"></webview>
      </div>
    </div>`;
}

function fcFleetFightNav(action) {
  if (action === 'external') { window.eveAPI?.openExternalUrl?.(FLEET_FIGHT_URL); return; }
  const wv = document.getElementById('fcFleetFightWebview');
  if (action === 'reload' && wv) { try { wv.reload(); } catch (_) {} }
}

// ─── Fleet Composition tool ───────────────────────────────────────────────────
async function renderFleetComposition(mount) {
  const lastChar     = localStorage.getItem('fc_char')     || '';
  const lastDoctrine = localStorage.getItem('fc_doctrine') || 'shield';
  _fcDoctrine = lastDoctrine;

  mount.innerHTML = `
    <div class="fc-comp" style="display:flex;flex-direction:column;height:100%;">
      <div class="fc-control-bar">
        <label class="fc-ctl">
          <span class="fc-ctl-label">FLEET BOSS</span>
          <select id="fcCharSelect" class="field-input" style="min-width:200px;">
            <option value="">Loading characters…</option>
          </select>
        </label>
        <label class="fc-ctl">
          <span class="fc-ctl-label">DOCTRINE</span>
          <select id="fcDoctrineSelect" class="field-input" style="width:150px;">
            <option value="shield">Shield</option>
            <option value="armor">Armor</option>
            <option value="capital">Capital / Titan</option>
            <option value="mining">Mining Fleet</option>
          </select>
        </label>
        <button id="fcTrackBtn" class="fc-track-btn">Start Tracking</button>
        <button id="fcOpBtn" class="fc-track-btn fc-op-btn"
                title="Record this fleet as an op — roster, ship changes and where the fleet actually went">Start Op</button>
        <button id="fcReportBtn" class="fc-track-btn fc-invite-btn" style="display:none;">Report</button>
        <button id="fcInviteBtn" class="fc-track-btn fc-invite-btn"
                title="Invite all your other characters to this fleet (they must accept in-game)">Invite All Alts</button>
        <span id="fcStatus" class="fc-status">Idle</span>
      </div>
      <div id="fcResults" class="fc-results">
        <div class="fc-empty">Select your fleet-boss character and press <strong>Start Tracking</strong>.</div>
      </div>
    </div>`;

  // Populate character dropdown.
  const sel = document.getElementById('fcCharSelect');
  const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
  if (!accounts.length) {
    sel.innerHTML = `<option value="">No characters — add one in Characters</option>`;
  } else {
    sel.innerHTML = accounts.map(a =>
      `<option value="${a.characterId}">${_fcEsc(a.characterName)}</option>`).join('');
    if (lastChar && accounts.some(a => String(a.characterId) === String(lastChar))) sel.value = lastChar;
  }

  const docSel = document.getElementById('fcDoctrineSelect');
  docSel.value = lastDoctrine;
  docSel.addEventListener('change', () => {
    _fcDoctrine = docSel.value;
    localStorage.setItem('fc_doctrine', _fcDoctrine);
    if (_fcLastMembers) _fcRenderStats(_fcLastMembers);  // re-evaluate doctrine live
  });

  document.getElementById('fcTrackBtn').addEventListener('click', () => {
    if (_fcTracking) _fcStopTracking();
    else _fcStartTracking();
  });

  document.getElementById('fcInviteBtn').addEventListener('click', _fcInviteAllAlts);
  document.getElementById('fcOpBtn').addEventListener('click', _fcToggleOp);
  document.getElementById('fcReportBtn').addEventListener('click', _fcShowReport);
  // The page is rebuilt on every visit, so a report offered before navigating
  // away has to be re-offered rather than silently lost.
  if (_fcReportOpId) _fcOfferReport(_fcReportOpId, _fcReportOpName);

  // An op outlives this page. Navigating away and back — or restarting the app
  // mid-fleet — must find the op still running rather than silently recording
  // nothing while the button says "Start Op".
  _fcResumeOp();

  // Delegated click: expand/collapse a ship chip to reveal its pilots. Bound on
  // the persistent #fcResults container so it survives the per-poll re-render.
  document.getElementById('fcResults').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-key]');
    if (!chip) return;
    const key = chip.dataset.key;
    if (_fcExpanded.has(key)) _fcExpanded.delete(key);
    else _fcExpanded.add(key);
    if (_fcLastMembers) _fcRenderStats(_fcLastMembers);
  });
}

async function _fcStartTracking() {
  const sel = document.getElementById('fcCharSelect');
  _fcCharId = sel ? sel.value : '';
  if (!_fcCharId) { _fcSetStatus('Pick a character first.', 'warn'); return; }
  localStorage.setItem('fc_char', _fcCharId);

  // Load the SDE ship-role table once (cached for the session).
  if (!_fcShipRoles) {
    _fcSetStatus('Loading ship database…', '');
    _fcShipRoles = await window.eveAPI.fcGetShipRoles().catch(() => ({}));
    if (!_fcShipRoles || !Object.keys(_fcShipRoles).length) {
      _fcSetStatus('Ship database (SDE) unavailable — roles can’t be classified. Download the SDE in Settings.', 'warn');
      _fcShipRoles = {};
    }
  }

  _fcTracking = true;
  _fcFleetId  = null;
  _fcPollEveryMs = FC_POLL_MS;                      // assume in-fleet; the poll corrects it
  _fcSetTrackBtn(true);
  await _fcPoll();                                  // immediate first cycle
  if (_fcTracking) _fcPollTimer = setInterval(_fcPoll, _fcPollEveryMs);
}

// `reason` keeps the caller's explanation on screen. Without it this always
// overwrote the specific message that preceded it — "Only the fleet boss can
// read the roster" became a bare "Stopped.", which is the one case where the
// user most needs to be told why.
function _fcStopTracking(reason = 'stopped') {
  // Stopping the poll deliberately ends any op with it: the poll IS what feeds
  // the record, so an "open" op receiving nothing would quietly accumulate a gap
  // and then claim the fleet sat still for it.
  if (_fcOpId) _fcEndOp(reason);
  _fcTracking = false;
  if (_fcPollTimer) { clearInterval(_fcPollTimer); _fcPollTimer = null; }
  _fcSetTrackBtn(false);
  if (reason === 'stopped') _fcSetStatus('Stopped.', '');
}

// Page-visibility hooks (called from navigateToPage). Leaving the fleet page
// PAUSES the poll loop but keeps _fcTracking + all your selections, so you don't
// spam ESI while away. Returning resumes the loop and immediately re-checks that
// the fleet is still up — your setup is exactly as you left it.
function _fcOnPageHidden() {
  // A recording op keeps polling off-page. That is the one case where the calls
  // are the point: the FC is on the map or in Jabber and the record has to keep
  // covering the fleet. It is bounded — one character, 6s, only while an op the
  // user deliberately started is open.
  if (_fcOpId) return;
  if (_fcPollTimer) { clearInterval(_fcPollTimer); _fcPollTimer = null; }
}
function _fcOnPageShown() {
  if (_fcTracking && !_fcPollTimer) {
    _fcPoll();                                     // re-check the fleet right away
    _fcPollTimer = setInterval(_fcPoll, _fcPollEveryMs);
  }
}

// Invite every other character on the account into the current fleet. Sends ESI
// invites the alts must accept in-game (it never force-joins them). Needs an
// active fleet (start tracking first) and the boss to hold write_fleet scope.
async function _fcInviteAllAlts() {
  if (!_fcCharId)  { _fcSetStatus('Start tracking as the fleet boss first.', 'warn'); return; }
  if (!_fcFleetId) { _fcSetStatus('No fleet detected yet — start tracking while in a fleet.', 'warn'); return; }

  const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
  const ids = accounts.map(a => a.characterId).filter(id => String(id) !== String(_fcCharId));
  if (!ids.length) { _fcSetStatus('No other characters to invite.', 'warn'); return; }

  const btn = document.getElementById('fcInviteBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Inviting…'; }
  _fcSetStatus(`Inviting ${ids.length} character${ids.length === 1 ? '' : 's'}…`, '');
  try {
    const res = await window.eveAPI.fcInviteCharacters(_fcCharId, _fcFleetId, ids);
    if (res.needsReauth) { _fcSetStatus('Re-authenticate the fleet boss to grant invite (write_fleet) access.', 'warn'); return; }
    if (!res.ok)         { _fcSetStatus(res.error || 'Invite failed.', 'warn'); return; }
    const ok   = res.results.filter(r => r.ok).length;
    const fail = res.results.length - ok;
    _fcSetStatus(
      `Invited ${ok} alt${ok === 1 ? '' : 's'}${fail ? `, ${fail} failed (offline / already in fleet)` : ''}. They must accept in-game.`,
      ok ? 'ok' : 'warn'
    );
  } catch (e) {
    _fcSetStatus(e.message || 'Invite failed.', 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Invite All Alts'; }
  }
}

// ─── Ops — the recorded outing behind the live view ───────────────────────────
//
// Tracking and recording are deliberately separate buttons. Tracking is a live
// glance at composition and an FC does it constantly, often for thirty seconds
// while forming up; an op is a record somebody will read later. Making Start
// Tracking also start an op would fill the history with thirty-second stubs.

// Pick up an op left running by a previous visit to this page or a restart.
async function _fcResumeOp() {
  try {
    const op = await window.eveAPI.fleetOpCurrent();
    if (!op) return;
    _fcOpId   = op.op_id;
    _fcOpName = op.name;
    _fcSetOpBtn(true);

    // An op survives a restart but tracking does not, so the op can be open with
    // nothing feeding it. Say so: a button reading "End Op" while no poll is
    // running would otherwise look exactly like recording.
    if (!_fcTracking) {
      _fcSetStatus(`Op “${op.name}” is open but paused — press Start Tracking to keep recording it.`, 'warn');
    }
  } catch (_) { /* no op is a normal state */ }
}

function _fcToggleOp() {
  if (_fcOpId) return _fcEndOp('stopped');

  if (!_fcTracking) { _fcSetStatus('Start tracking first — an op records what the poll sees.', 'warn'); return; }
  if (!_fcFleetId)  { _fcSetStatus('No fleet detected yet — join one in-game first.', 'warn'); return; }

  // The app's one name-entry modal. Electron has no window.prompt() — it THROWS
  // "prompt() is not supported", killing the handler mid-click with nothing
  // shown, which is exactly how renaming a shopping list came to do nothing.
  showShoppingListNameModal({
    title: 'Name this op',
    confirmLabel: 'Start Op',
    placeholder: 'Home Defence, Rorqual Hunt…',
    value: _fcDefaultOpName(),
    onSubmit: async (name) => {
      const res = await window.eveAPI.fleetOpStart({
        name, doctrine: _fcDoctrine, bossCharacterId: Number(_fcCharId), fleetId: _fcFleetId,
      }).catch(e => ({ ok: false, error: e.message }));

      if (!res.ok) { _fcSetStatus(res.error || 'Could not start the op.', 'warn'); return; }
      _fcOpId   = res.opId;
      _fcOpName = name;
      _fcSetOpBtn(true);
      _fcSetStatus(`Recording “${name}”.`, 'ok');
    },
  });
}

// A date-stamped default, because the overwhelmingly common case is one fleet a
// day and an FC should not have to invent a name to press the button.
function _fcDefaultOpName() {
  const d = new Date();
  return `Fleet ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Why an op ended, in the FC's words rather than the code's. Anything not listed
// is a plain stop and needs no explanation.
const FC_END_REASONS = {
  'boss-handover':    'fleet boss changed',
  'lost-boss':        'lost fleet boss',
  'needs-reauth':     'fleet access expired',
  'tracking-stopped': 'tracking stopped',
};

async function _fcEndOp(reason) {
  if (!_fcOpId) return;
  const id = _fcOpId, name = _fcOpName;
  _fcOpId = null; _fcOpName = '';        // stop recording before the await
  _fcSetOpBtn(false);
  const why = FC_END_REASONS[reason] ? ` (${FC_END_REASONS[reason]})` : '';
  try {
    const res = await window.eveAPI.fleetOpStop(id, reason);
    const moves = res && res.op ? res.op.movement.length : 0;
    const pilots = res && res.op ? new Set(res.op.roster.map(r => r.character_id)).size : 0;
    _fcSetStatus(
      `Op “${name}” saved${why} — ${pilots} pilot${pilots === 1 ? '' : 's'}, ${moves} system${moves === 1 ? '' : 's'}. Fetching kills…`,
      why ? 'warn' : 'ok');
    _fcPullKills(id, name);            // not awaited — the op is already saved
  } catch (e) {
    _fcSetStatus(`Op “${name}” closed${why} (${e.message || 'with an error saving'}).`, 'warn');
  }
}

// Kills and losses, pulled once now that the op has an end time.
//
// Deliberately AFTER the op is safely closed and not awaited by the caller: this
// makes ~one request per system through a 1/s rate gate, so a fifteen-system
// roam takes about fifteen seconds. Blocking the stop button on that would make
// ending a fleet feel broken.
async function _fcPullKills(opId, name) {
  try {
    const r = await window.eveAPI.fleetOpPullKills(opId);
    if (!r || !r.ok) { _fcSetStatus(`Op “${name}” saved — kills unavailable (${(r && r.error) || 'failed'}).`, 'warn'); return; }

    // "We could not look" must never render as "nothing happened".
    if (r.reason) { _fcSetStatus(`Op “${name}” saved — ${r.reason}`, 'warn'); return; }

    const s = r.summary || {};
    const isk = (n) => !n ? '0' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'b' : (n / 1e6).toFixed(0) + 'm';
    let msg = `Op “${name}” saved — ${s.kills || 0} kill${s.kills === 1 ? '' : 's'} (${isk(s.iskDestroyed)} ISK), ` +
              `${s.losses || 0} loss${s.losses === 1 ? '' : 'es'} (${isk(s.iskLost)} ISK).`;

    // An incomplete pull says so. A report that quietly under-counts is worse
    // than one that admits a gap, because nobody can tell it happened.
    const gaps = [];
    if (r.failed && r.failed.length)       gaps.push(`${r.failed.length} system${r.failed.length === 1 ? '' : 's'} unreachable`);
    if (r.truncated && r.truncated.length) gaps.push(`${r.truncated.length} hit the result cap`);
    if (gaps.length) msg += ` Incomplete: ${gaps.join(', ')}.`;

    // Mining runs after kills rather than in parallel: both write to the same
    // op and the status line can only say one thing at a time.
    const m = await window.eveAPI.fleetOpPullMining(opId).catch(() => null);
    if (m && m.ok && m.summary && m.summary.units > 0) {
      const c = m.summary.coverage || {};
      msg += ` Mined ${m.summary.units.toLocaleString('en-US')} units`
           + (c.pilotsInFleet ? ` (${c.pilotsMeasured} of ${c.pilotsInFleet} pilots visible)` : '') + '.';
    }

    _fcSetStatus(msg, gaps.length ? 'warn' : 'ok');
    _fcOfferReport(opId, name);
  } catch (e) {
    _fcSetStatus(`Op “${name}” saved — kills unavailable (${e.message || 'error'}).`, 'warn');
    _fcOfferReport(opId, name);          // the record is still worth reading
  }
}

// ─── The after action report ──────────────────────────────────────────────────

let _fcReportOpId = null, _fcReportOpName = '';

// A closed op has nowhere else to be reached from yet, so the button that opens
// its report lives next to the op controls until another op starts.
function _fcOfferReport(opId, name) {
  _fcReportOpId = opId; _fcReportOpName = name;
  const btn = document.getElementById('fcReportBtn');
  if (btn) { btn.style.display = ''; btn.title = `After action report for “${name}”`; }
}

async function _fcShowReport() {
  if (!_fcReportOpId) return;
  const res = await window.eveAPI.fleetOpReport(_fcReportOpId).catch(e => ({ ok: false, error: e.message }));
  if (!res || !res.ok) { _fcSetStatus(`Could not build the report (${(res && res.error) || 'failed'}).`, 'warn'); return; }

  const formats = { markdown: res.markdown, bbcode: res.bbcode, text: res.text };
  let active = 'bbcode';        // most EVE alliance forums run BBCode
  try { active = localStorage.getItem('fc_aar_format') || 'bbcode'; } catch (_) {}
  if (!formats[active]) active = 'bbcode';

  const backdrop = document.createElement('div');
  backdrop.className = 'fc-aar-backdrop';
  backdrop.innerHTML = `
    <div class="fc-aar-modal">
      <div class="fc-aar-head">
        <div class="fc-aar-title">After action report — ${_fcEsc(_fcReportOpName)}</div>
        <button class="fc-aar-close" title="Close">&#10005;</button>
      </div>
      <div class="fc-aar-tabs">
        ${['bbcode', 'markdown', 'text'].map(f => `
          <button class="fc-aar-tab${f === active ? ' active' : ''}" data-fmt="${f}">
            ${f === 'bbcode' ? 'BBCode' : f === 'markdown' ? 'Markdown' : 'Plain text'}</button>`).join('')}
        <span class="fc-aar-hint">Most EVE alliance forums take BBCode.</span>
      </div>
      <textarea class="fc-aar-body" spellcheck="false" readonly></textarea>
      <div class="fc-aar-foot">
        <input class="fc-aar-notes field-input" placeholder="FC notes — what happened, what to do differently…"/>
        <button class="fc-aar-refresh fc-track-btn fc-invite-btn"
                title="Re-fetch kills and mining. zKillboard publishes a killmail a few minutes after the fact, and the mining ledger is up to an hour behind — so a report built the moment a fleet stood down can legitimately be short.">Refresh data</button>
        <button class="fc-aar-save fc-track-btn fc-invite-btn">Save file</button>
        <button class="fc-aar-copy fc-track-btn">Copy</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const body  = backdrop.querySelector('.fc-aar-body');
  const notes = backdrop.querySelector('.fc-aar-notes');
  const paint = () => { body.value = formats[active]; };
  paint();

  const close = () => backdrop.remove();
  backdrop.querySelector('.fc-aar-close').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  backdrop.querySelectorAll('.fc-aar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      active = tab.dataset.fmt;
      try { localStorage.setItem('fc_aar_format', active); } catch (_) {}
      backdrop.querySelectorAll('.fc-aar-tab').forEach(t => t.classList.toggle('active', t === tab));
      paint();
    });
  });

  // Notes are saved and the report rebuilt, so what you copy includes them.
  let notesTimer = null;
  notes.addEventListener('input', () => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(async () => {
      await window.eveAPI.fleetOpSetNotes(_fcReportOpId, notes.value).catch(() => {});
      const fresh = await window.eveAPI.fleetOpReport(_fcReportOpId).catch(() => null);
      if (fresh && fresh.ok) {
        formats.markdown = fresh.markdown; formats.bbcode = fresh.bbcode; formats.text = fresh.text;
        paint();
      }
    }, 600);
  });

  // Both sources lag: zKillboard publishes a killmail minutes after the fact and
  // the mining ledger up to an hour. Without this, a report built the moment a
  // fleet stood down would be permanently short with no way to correct it — and
  // both pulls are idempotent, so re-running only ever corrects the numbers.
  backdrop.querySelector('.fc-aar-refresh').addEventListener('click', async () => {
    const b = backdrop.querySelector('.fc-aar-refresh');
    const was = b.textContent;
    b.disabled = true; b.textContent = 'Fetching…';
    try {
      const [k, m] = await Promise.all([
        window.eveAPI.fleetOpPullKills(_fcReportOpId).catch(() => null),
        window.eveAPI.fleetOpPullMining(_fcReportOpId).catch(() => null),
      ]);
      const fresh = await window.eveAPI.fleetOpReport(_fcReportOpId);
      if (fresh && fresh.ok) {
        formats.markdown = fresh.markdown; formats.bbcode = fresh.bbcode; formats.text = fresh.text;
        paint();
      }
      const found = (k && k.found) || 0;
      const mined = (m && m.summary && m.summary.units) || 0;
      b.textContent = `${found} kill${found === 1 ? '' : 's'}${mined ? ', mining updated' : ''}`;
      setTimeout(() => { b.textContent = was; }, 2500);
    } catch (e) {
      b.textContent = 'Failed';
      setTimeout(() => { b.textContent = was; }, 2000);
    } finally { b.disabled = false; }
  });

  backdrop.querySelector('.fc-aar-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(formats[active]).then(() => {
      const b = backdrop.querySelector('.fc-aar-copy');
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    }).catch(() => _fcSetStatus('Could not copy to clipboard.', 'warn'));
  });

  backdrop.querySelector('.fc-aar-save').addEventListener('click', async () => {
    const r = await window.eveAPI.fleetOpSaveReport({
      name: _fcReportOpName, format: active, content: formats[active],
    }).catch(e => ({ ok: false, error: e.message }));
    if (r && r.ok) _fcSetStatus(`Report saved as ${r.name}.`, 'ok');
    else if (r && !r.canceled) _fcSetStatus(`Could not save (${r.error || 'failed'}).`, 'warn');
  });
}

function _fcSetOpBtn(recording) {
  const btn = document.getElementById('fcOpBtn');
  if (!btn) return;
  btn.textContent = recording ? 'End Op' : 'Start Op';
  btn.classList.toggle('recording', recording);
}

// The poll cadence changes with what we found — active in a fleet, idle out of
// one. Restarting the interval rather than checking a counter inside the tick
// keeps the ESI call rate honestly equal to the cadence.
function _fcSetCadence(ms) {
  if (ms === _fcPollEveryMs) return;
  _fcPollEveryMs = ms;
  if (_fcPollTimer) {
    clearInterval(_fcPollTimer);
    _fcPollTimer = setInterval(_fcPoll, ms);
  }
}

let _fcLastMembers = null;

async function _fcPoll() {
  if (_fcBusy || !_fcTracking) return;
  _fcBusy = true;
  try {
    // Resolve the fleet id (cheap; also catches the fleet closing/reforming).
    const f = await window.eveAPI.fcGetCharacterFleet(_fcCharId);
    if (!_fcTracking) return;                       // stopped mid-await
    if (f.needsReauth) { _fcSetStatus('Re-authenticate this character to grant fleet access.', 'warn'); _fcStopTracking('needs-reauth'); return; }
    if (!f.inFleet) {
      _fcFleetId = null;
      // Back off: this branch is a 404 every time, and at 6s it drains the
      // shared ESI error budget for the whole app while learning nothing.
      _fcSetCadence(FC_IDLE_POLL_MS);
      _fcSetStatus('Character is not in a fleet — checking every 30s.', 'warn');
      _fcShowEmpty('Not in a fleet. Join one in-game, then keep tracking running.');
      return;
    }
    _fcSetCadence(FC_POLL_MS);
    _fcFleetId = f.fleetId;

    // Boss handover. The roster is boss-only, so the moment someone else holds
    // boss the reads start failing — and a 403 alone is indistinguishable from
    // a token problem. Catching it here means the op record says what happened
    // instead of just stopping.
    if (_fcOpId && _fcBossId && f.fleetBossId && f.fleetBossId !== _fcBossId) {
      await _fcEndOp('boss-handover');
      _fcSetStatus('Fleet boss changed — op closed and saved. Restart it as the new boss to keep recording.', 'warn');
    }
    _fcBossId = f.fleetBossId ?? _fcBossId;

    const res = await window.eveAPI.fcGetFleetMembers(_fcCharId, _fcFleetId);
    if (!_fcTracking) return;
    if (res.notBoss)   { _fcSetStatus('Only the fleet boss can read the roster.', 'warn'); _fcStopTracking('lost-boss'); return; }
    if (res.fleetGone) { _fcSetStatus('Fleet changed — re-checking…', ''); return; }
    if (!res.ok)       { _fcSetStatus(res.error || 'Failed to read roster.', 'warn'); return; }

    _fcLastMembers = res.members;

    // Record BEFORE the name resolution and render. Those are cosmetic and can
    // fail; the roster we just read is the thing that cannot be fetched again.
    let opNote = '';
    if (_fcOpId) {
      const rec = await window.eveAPI.fleetOpRecord(_fcOpId, res.members).catch(() => ({ ok: false }));
      if (rec && rec.ended) {
        // The op was closed elsewhere (another window, or the DB). Stop claiming
        // to record rather than dropping polls silently.
        _fcOpId = null; _fcOpName = ''; _fcSetOpBtn(false);
      } else {
        opNote = ` · recording “${_fcOpName}”`;
      }
    }

    await _fcResolveNames(res.members);             // fill pilot-name cache before render
    if (!_fcTracking) return;
    _fcRenderStats(res.members);
    _fcSetStatus(`Live · ${res.members.length} in fleet${opNote} · updated ${new Date().toLocaleTimeString()}`, 'ok');
  } catch (e) {
    _fcSetStatus(e.message || 'Polling error.', 'warn');
  } finally {
    _fcBusy = false;
  }
}

// Resolve any unknown pilot names — and, as a safety net, any ship hull missing
// from the SDE map (e.g. a brand-new ship not yet in the downloaded SDE) — into
// caches so the render is synchronous. Pilots fall back to "Pilot {id}".
async function _fcResolveNames(members) {
  const charIds = [...new Set(members.map(m => m.characterId))].filter(id => id && !_fcNameCache.has(id));
  const typeIds = [...new Set(members.map(m => m.shipTypeId))]
    .filter(tid => tid && !_fcShipRoles[tid] && !_fcTypeNameCache.has(tid));
  const ids = [...charIds, ...typeIds];
  if (!ids.length) return;
  try {
    const arr = await window.eveAPI.getNames(ids);
    (arr || []).forEach(n => {
      if (!n || !n.id) return;
      if (charIds.includes(n.id)) _fcNameCache.set(n.id, n.name);
      else                        _fcTypeNameCache.set(n.id, n.name);
    });
  } catch (_) { /* keep fallbacks below */ }
  charIds.forEach(id => { if (!_fcNameCache.has(id)) _fcNameCache.set(id, 'Pilot ' + id); });
}

// ── Compliance matrix + render ────────────────────────────────────────────────
function _fcRenderStats(members) {
  const results = document.getElementById('fcResults');
  if (!results) return;

  const doctrine     = FC_DOCTRINES[_fcDoctrine] || FC_DOCTRINES.shield;
  const roleDefs     = doctrine.roles;
  const groupRoles   = doctrine.groupRoles || {};
  const typeRoles    = doctrine.typeRoles  || {};
  const expectedTank = doctrine.expectedTank;
  const validKeys    = new Set(roleDefs.map(d => d.key));
  const fleetSize    = members.length || 0;

  // Bucket members by role → ship type, tracking pilot ids. Role comes from the
  // active doctrine's group/type mapping (falls back to 'Other'). Tank
  // mismatches are flagged only for doctrines that declare an expected tank.
  const byRole = {};                 // roleKey -> { typeId -> { count, charIds[], outlier } }
  const outliers = {};               // typeId  -> { count, charIds[] }
  const counts = {}; roleDefs.forEach(d => { counts[d.key] = 0; });
  let outlierCount = 0;

  for (const m of members) {
    const ship = _fcShipRoles[m.shipTypeId] || null;
    const gid  = ship ? ship.group_id : null;
    let role = typeRoles[m.shipTypeId] || (gid != null ? groupRoles[gid] : null) || 'Other';
    if (!validKeys.has(role)) role = 'Other';
    const tank = ship ? ship.tank : null;
    const isOutlier = !!(expectedTank && tank && tank !== expectedTank);

    counts[role] = (counts[role] || 0) + 1;

    const bucket = (byRole[role] = byRole[role] || {});
    const entry  = (bucket[m.shipTypeId] = bucket[m.shipTypeId] || { count: 0, charIds: [], outlier: isOutlier });
    entry.count++; entry.charIds.push(m.characterId);

    if (isOutlier) {
      outlierCount++;
      const oe = (outliers[m.shipTypeId] = outliers[m.shipTypeId] || { count: 0, charIds: [] });
      oe.count++; oe.charIds.push(m.characterId);
    }
  }

  // ── Summary tiles ── Fleet Size + each non-Other role (% + zone when it has a
  // threshold) + Outliers (tank-checked doctrines only).
  const tiles = [_fcTile('Fleet Size', fleetSize, '', 'accent')];
  for (const d of roleDefs) {
    if (d.key === 'Other') continue;
    let sub = '', zone = '';
    if (d.thr) {
      const pct = fleetSize ? (counts[d.key] / fleetSize) * 100 : 0;
      sub = `${pct.toFixed(0)}%`; zone = _fcZone(pct, d.thr);
    }
    tiles.push(_fcTile(d.label, counts[d.key], sub, zone));
  }
  if (expectedTank) tiles.push(_fcTile('Outliers', outlierCount, 'wrong tank', outlierCount ? 'red' : ''));
  const summary = `<div class="fc-summary">${tiles.join('')}</div>`;

  // ── Outliers / false-flags card (tank-checked doctrines only) ──
  const outlierTypeIds = Object.keys(outliers);
  const outliersCard = (expectedTank && outlierTypeIds.length) ? `
    <div class="fc-card fc-outliers">
      <div class="fc-card-title fc-outliers-title">
        <span class="material-symbols-outlined">flag</span>
        FALSE FLAGS — WRONG TANK FOR ${_fcEsc(doctrine.label.toUpperCase())}
      </div>
      <div class="fc-chips">
        ${outlierTypeIds.sort((a, b) => outliers[b].count - outliers[a].count)
            .map(tid => _fcChip('outlier', tid, outliers[tid], true)).join('')}
      </div>
    </div>` : '';

  // ── Doctrine presence checks ──
  const checks = doctrine.checks ? doctrine.checks(counts) : [];
  const doctrineCard = `
    <div class="fc-card fc-doctrine">
      <div class="fc-card-title">DOCTRINE CHECK — ${_fcEsc(doctrine.label.toUpperCase())}</div>
      ${checks.length
        ? checks.map(c => `
          <div class="fc-check ${c.ok ? 'ok' : 'fail'}">
            <span class="material-symbols-outlined">${c.ok ? 'check_circle' : 'cancel'}</span>
            <span>${_fcEsc(c.label)}</span>
            <span class="fc-check-detail">${_fcEsc(c.detail)}</span>
          </div>`).join('')
        : '<div class="fc-check ok"><span class="material-symbols-outlined">check_circle</span><span>No special role requirements.</span></div>'}
    </div>`;

  // ── Role cards — only roles that actually have ships, each with ship chips ──
  const roleCards = roleDefs.filter(d => byRole[d.key]).map(d => {
    const bucket  = byRole[d.key];
    const typeIds = Object.keys(bucket).sort((a, b) => bucket[b].count - bucket[a].count);
    return `
      <div class="fc-card fc-role-card">
        <div class="fc-card-title">
          <span class="material-symbols-outlined fc-role-icon">${d.icon}</span>
          ${_fcEsc(d.label)} <span class="fc-role-count">${counts[d.key]}</span>
        </div>
        <div class="fc-chips">
          ${typeIds.map(tid => _fcChip(d.key, tid, bucket[tid], bucket[tid].outlier)).join('')}
        </div>
      </div>`;
  }).join('');

  results.innerHTML = summary + outliersCard + doctrineCard +
    `<div class="fc-role-grid">${roleCards}</div>`;
}

// Color zone: red below min, green in band, yellow above max (over-saturated).
function _fcZone(pct, thr) {
  if (pct < thr.min) return 'red';
  if (pct > thr.max) return 'yellow';
  return 'green';
}

// A summary tile. zone: 'accent' | 'red' | 'yellow' | 'green' | '' (neutral).
function _fcTile(label, value, sub, zone) {
  const cls = zone ? (zone === 'accent' ? 'fc-accent' : 'fc-' + zone) : '';
  return `
    <div class="fc-tile">
      <div class="fc-tile-label">${_fcEsc(label)}</div>
      <div class="fc-tile-value ${cls}">${value}</div>
      ${sub ? `<div class="fc-tile-sub">${_fcEsc(sub)}</div>` : '<div class="fc-tile-sub">&nbsp;</div>'}
    </div>`;
}

// A ship-type chip: one hull icon with a count badge (10 Guardians = one icon
// badged "10"). Clicking expands the pilot list. isOutlier adds the red flag.
function _fcChip(roleKey, typeId, entry, isOutlier) {
  const key  = roleKey + '|' + typeId;
  const open = _fcExpanded.has(key);
  const ship = _fcShipRoles[typeId];
  const name = ship ? ship.name : (_fcTypeNameCache.get(Number(typeId)) || ('Type ' + typeId));
  const pilots = open ? `
    <div class="fc-pilots">
      ${entry.charIds.map(id => `
        <div class="fc-pilot">
          <img src="https://images.evetech.net/characters/${id}/portrait?size=32" alt="" loading="lazy"/>
          <span>${_fcEsc(_fcNameCache.get(id) || ('Pilot ' + id))}</span>
        </div>`).join('')}
    </div>` : '';
  return `
    <div class="fc-chip-wrap">
      <button type="button" class="fc-chip ${isOutlier ? 'fc-chip-flag' : ''} ${open ? 'open' : ''}"
              data-key="${_fcEsc(key)}" title="${_fcEsc(name)} ×${entry.count} — click for pilots">
        <span class="fc-chip-icon">
          <img src="https://images.evetech.net/types/${typeId}/icon?size=64" alt="" loading="lazy"/>
          <span class="fc-chip-badge">${entry.count}</span>
        </span>
        <span class="fc-chip-name">${_fcEsc(name)}${isOutlier ? ' <span class="fc-flag">&#9873;</span>' : ''}</span>
      </button>
      ${pilots}
    </div>`;
}

// ── small helpers ─────────────────────────────────────────────────────────────
function _fcSetStatus(text, kind) {
  const el = document.getElementById('fcStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'fc-status' + (kind ? ' fc-status-' + kind : '');
}

function _fcSetTrackBtn(tracking) {
  const btn = document.getElementById('fcTrackBtn');
  if (!btn) return;
  btn.textContent = tracking ? 'Stop Tracking' : 'Start Tracking';
  btn.classList.toggle('active', tracking);
}

function _fcShowEmpty(msg) {
  const results = document.getElementById('fcResults');
  if (results) results.innerHTML = `<div class="fc-empty">${_fcEsc(msg)}</div>`;
}

function _fcEsc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
