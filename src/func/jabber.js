// ─── Jabber ───────────────────────────────────────────────────────────────────
// jabberMessages holds the merged set of DB history + live incoming messages.
// Each entry is a DB row shape:
//   { id, received_at, from_jid, msg_type, is_director, raw_body,
//     ping_timestamp, who_pinged, hurf,
//     fc_name, formup_location, pap_type, comms, doctrine,
//     sig, gsol_member, target_sig, eve_timecode }
//
// Live messages arriving via IPC are parsed client-side with the same field
// names so they slot in without any special-casing.

// ── Filters ───────────────────────────────────────────────────────────────────
// Both filters removed from UI. Hardcoded to false = show everything.
// jabberFilterDirectorOnly is declared in state.js; force it off here.
jabberFilterDirectorOnly  = false;
var jabberFilterBroadcastOnly = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip zero-width / invisible Unicode chars used as EVE field separators. */
function jabberStripInvisible(str) {
  if (!str) return '';
  return str.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\uFFFD]/g, '').trim();
}

/**
 * Lightweight client-side parser — mirrors jabber_data_db.js parseJabberMessage
 * so live incoming messages have the same shape as DB rows.
 */
function jabberParseMessage(body) {
  const r = {
    ping_timestamp: null, who_pinged: null, hurf: null,
    fc_name: null, formup_location: null, pap_type: null,
    comms: null, doctrine: null,
    sig: null, gsol_member: null, target_sig: null, eve_timecode: null,
  };
  if (!body) return r;

  // First line: "(HH:MM:SS AM/PM) sender: hurf"
  const h = (body.split('\n')[0] || '').match(/^\(([^)]+)\)\s+([^:]+):\s*(.*)$/);
  if (h) {
    r.ping_timestamp = h[1].trim();
    r.who_pinged     = jabberStripInvisible(h[2]);
    r.hurf           = jabberStripInvisible(h[3]);
  }

  const inv = '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]*';
  const field = (label) => {
    const m = body.match(new RegExp(`^${label.replace(/ /g, '\\s+')}\\s*:${inv}\\s*(.+)$`, 'mi'));
    return m ? jabberStripInvisible(m[1]) : null;
  };

  r.fc_name         = field('FC Name');
  r.formup_location = field('Formup Location');
  r.pap_type        = field('PAP Type');
  r.comms           = field('Comms');
  r.doctrine        = field('Doctrine');

  const c = body.match(
    /~~~\s*This was a\s+(\S+)\s+broadcast from\s+(\S+)\s+to\s+(\S+)\s+at\s+([\d\-: .]+?)\s+EVE\s*~~~/i
  );
  if (c) {
    r.sig          = c[1].trim();
    r.gsol_member  = c[2].trim();
    r.target_sig   = c[3].trim();
    r.eve_timecode = c[4].trim();
  }
  return r;
}

/** Convert a live IPC message { from, type, body, isDirector } to a DB-row-like object. */
function jabberLiveToRow(msg) {
  const parsed = jabberParseMessage(msg.body || '');
  return {
    id:              null,                          // not yet in DB (DB write is async)
    received_at:     new Date().toISOString(),
    from_jid:        msg.from        || '',
    msg_type:        msg.type        || '',
    is_director:     msg.isDirector  ? 1 : 0,
    raw_body:        msg.body        || '',
    ...parsed,
  };
}

/** Sort key: prefer eve_timecode, fall back to received_at. Newest first. */
function jabberSortKey(row) {
  // eve_timecode: "2026-05-22 16:34:42.764243"  → ISO-sortable as-is
  return row.eve_timecode || row.received_at || '';
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderJabberTable() {
  const tbody = document.querySelector('#jabberTable tbody');
  if (!tbody) return;

  // Sort newest-first — no filters applied, show everything
  const sorted = [...jabberMessages].sort((a, b) => jabberSortKey(b).localeCompare(jabberSortKey(a)));

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-row">No messages received yet.</td></tr>`;
    updateJabberSummary(0);
    return;
  }

  tbody.innerHTML = sorted.map(row => {
    // Truncate doctrine to first URL-free segment for display; full text in title
    const docShort = row.doctrine
      ? row.doctrine.replace(/https?:\/\/\S+/g, '').trim().split(/\s+/).slice(0, 4).join(' ')
      : '';

    return `<tr title="${escHtml(row.raw_body || '')}">
      <td style="font-family:var(--mono); font-size:11px; white-space:nowrap; min-width:140px;">${escHtml(row.eve_timecode || row.ping_timestamp || '')}</td>
      <td style="white-space:normal; word-break:break-word;">${escHtml(row.fc_name       || '')}</td>
      <td style="white-space:normal; word-break:break-word;">${escHtml(row.formup_location || '')}</td>
      <td style="white-space:normal; word-break:break-word;">${escHtml(row.pap_type      || '')}</td>
      <td style="white-space:normal; word-break:break-word;" title="${escHtml(row.doctrine || '')}">${escHtml(docShort)}</td>
      <td style="white-space:normal; word-break:break-word;">${escHtml(row.sig           || '')}</td>
      <td style="white-space:normal; word-break:break-word;">${escHtml(row.comms         || '')}</td>
      <td style="white-space:normal; word-break:break-word;">${escHtml(row.gsol_member   || row.who_pinged || '')}</td>
      <td style="white-space:normal; word-break:break-word;">${escHtml(row.target_sig    || '')}</td>
      <td style="white-space:normal; word-break:break-word;"
          title="${escHtml(row.hurf || '')}">${escHtml(row.hurf || row.raw_body || '')}</td>
    </tr>`;
  }).join('');

  updateJabberSummary(sorted.length);
}

function updateJabberSummary(count) {
  const summary = document.getElementById('jabberSummary');
  if (!summary) return;
  if (count === undefined) count = jabberMessages.length;
  summary.textContent = `${count} ping${count === 1 ? '' : 's'}`;
}

// ── DB load ───────────────────────────────────────────────────────────────────

/**
 * Called once when the Jabber page is opened (or on reconnect).
 * Fetches stored rows from the main process and merges with any
 * live messages already buffered in jabberMessages this session.
 */
async function loadJabberHistory() {
  try {
    const history = await window.eveAPI.getJabberMessages(200);
    if (!Array.isArray(history)) return;

    // Build a Set of DB ids that are already represented in jabberMessages
    const existingIds = new Set(
      jabberMessages.filter(m => m.id != null).map(m => m.id)
    );

    // Prepend DB rows that aren't already in the live list
    const newRows = history.filter(r => !existingIds.has(r.id));
    jabberMessages.unshift(...newRows);

    renderJabberTable();
  } catch (e) {
    console.warn('[Jabber] loadJabberHistory failed:', e.message);
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function populateJabberSettings() {
  const cfg    = await window.eveAPI.getAppConfig();
  const jabber = cfg?.app?.jabber || cfg?.jabber || {};

  jabberSettings = {
    service:      jabber.service      || 'xmpp://jabber.eveonline.com:5222',
    jid:          jabber.jid          || '',
    password:     jabber.password     || '',
    directorOnly: typeof jabber.directorOnly === 'boolean' ? jabber.directorOnly : true,
  };

  const serviceInput  = document.getElementById('jabberService');
  const jidInput      = document.getElementById('jabberJid');
  const passwordInput = document.getElementById('jabberPassword');
  const directorCheck = document.getElementById('jabberDirectorOnly');

  if (serviceInput)  serviceInput.value    = jabberSettings.service;
  if (jidInput)      jidInput.value        = jabberSettings.jid;
  if (passwordInput) passwordInput.value   = jabberSettings.password;
  if (directorCheck) directorCheck.checked = jabberSettings.directorOnly;
}

function gatherJabberSettings() {
  return {
    service:      document.getElementById('jabberService')?.value.trim()   || 'xmpp://jabber.eveonline.com:5222',
    jid:          document.getElementById('jabberJid')?.value.trim()       || '',
    password:     document.getElementById('jabberPassword')?.value         || '',
    directorOnly: document.getElementById('jabberDirectorOnly')?.checked   ?? true,
  };
}

async function autoConnectJabber() {
  const cfg      = await window.eveAPI.getAppConfig();
  const jabber   = cfg?.app?.jabber || cfg?.jabber || {};
  const service  = jabber.service?.trim();
  const jid      = jabber.jid?.trim();
  const password = jabber.password || '';
  const label    = document.getElementById('jabberStatus');

  if (!service || !jid || !password) {
    if (label) label.textContent = 'Jabber credentials missing; set them in Settings.';
    return;
  }

  if (label) label.textContent = 'Auto-connecting to Jabber...';
  try {
    const result = await window.eveAPI.connectJabber({ service, jid, password });
    if (!result.success) {
      showToast(`Jabber auto-connect failed: ${result.message}`, 'error');
      if (label) label.textContent = 'Jabber disconnected.';
    }
  } catch (err) {
    showToast(`Jabber auto-connect error: ${err.message}`, 'error');
    if (label) label.textContent = 'Jabber disconnected.';
  }
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindJabberEvents() {
  // Live messages from main process
  window.eveAPI.on('jabber-message', (msg) => {
    const row = jabberLiveToRow(msg);
    jabberMessages.unshift(row);   // prepend so newest is index 0
    renderJabberTable();
  });

  // Connection status updates
  window.eveAPI.on('jabber-status', (status) => {
    jabberConnected = status.status === 'online';
    updateNavStatusIndicators();
    const label = document.getElementById('jabberStatus');
    if (label) label.textContent = status.message || '';

    // Always reload history on any status change — catches reconnects AND
    // the initial 'connecting' event which fires once the DB is ready.
    loadJabberHistory();
  });

  // Defer the initial history load by one tick so the DB has time to
  // finish initialising before we query it. This replaces the old
  // immediate call that raced with initJabberDb.
  setTimeout(() => loadJabberHistory(), 500);

  // Wipe jabber DB + settings button (in Settings drawer)
  const wipeBtn = document.getElementById('jabberWipeBtn');
  if (wipeBtn) {
    wipeBtn.addEventListener('click', async () => {
      if (!confirm('Wipe ALL Jabber messages from the database and clear saved credentials? This cannot be undone.')) return;
      try {
        await window.eveAPI.wipeJabberData();
        await window.eveAPI.saveAppConfig({ jabber: { service: '', jid: '', password: '', directorOnly: true } });
        jabberMessages = [];
        renderJabberTable();
        // Clear the settings inputs so they visually reflect the wipe
        const s = document.getElementById('jabberService');
        const j = document.getElementById('jabberJid');
        const p = document.getElementById('jabberPassword');
        if (s) s.value = 'xmpp://jabber.eveonline.com:5222';
        if (j) j.value = '';
        if (p) p.value = '';
        showToast('Jabber database and credentials wiped.', 'success');
      } catch (e) {
        showToast(`Wipe failed: ${e.message}`, 'error');
      }
    });
  }
}