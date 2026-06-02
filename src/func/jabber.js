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

// ── FC portrait cache ─────────────────────────────────────────────────────────
// Maps lowercase FC name → characterId (number) or null (not found / failed).
// Populated lazily after each table render.

const jabberPortraitCache = new Map();

/** After a table render, batch-resolve any unresolved FC names and fill in srcs.
 *  Calls ESI /universe/ids/ directly via fetch — ESI allows CORS from any origin
 *  so no IPC hop needed, and it avoids httpPost serialisation issues. */
async function jabberResolvePortraits() {
  const imgs = [...document.querySelectorAll(
    '#jabberTable img.jabber-fc-portrait[data-fc-name]:not([data-resolved])'
  )];
  if (!imgs.length) return;

  const unresolved = [...new Set(imgs.map(i => i.dataset.fcName))]
    .filter(n => n && !jabberPortraitCache.has(n.toLowerCase()));

  if (unresolved.length) {
    try {
      const res  = await fetch(
        'https://esi.evetech.net/v1/universe/ids/?datasource=tranquility',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(unresolved),
        }
      );
      if (res.ok) {
        const data = await res.json();
        for (const { name, id } of (data.characters || [])) {
          jabberPortraitCache.set(name.toLowerCase(), id);
        }
        console.debug('[Jabber portraits] resolved', data.characters?.length ?? 0, '/', unresolved.length);
      } else {
        console.warn('[Jabber portraits] ESI', res.status, await res.text().catch(() => ''));
      }
    } catch (e) {
      console.warn('[Jabber portraits] fetch failed:', e.message);
    }
    for (const n of unresolved) {
      if (!jabberPortraitCache.has(n.toLowerCase())) jabberPortraitCache.set(n.toLowerCase(), null);
    }
  }

  for (const img of imgs) {
    img.dataset.resolved = '1';
    const id = jabberPortraitCache.get(img.dataset.fcName.toLowerCase());
    if (id) {
      img.style.display = '';
      img.onerror = () => { img.style.display = 'none'; };
      img.src = `https://images.evetech.net/characters/${id}/portrait?size=32`;
    }
  }
}

// ── SIG / Squad lookup map ────────────────────────────────────────────────────
// Populated from yaml/gsf_sigs.yaml via IPC. Keys are normalised SIG names.

let jabberSigsMap = new Map();

function jabberNormSig(s) {
  return s.toLowerCase().replace(/[\s_\-\.]+/g, '');
}

function jabberHexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

async function loadJabberSigsMap() {
  try {
    const groups = await window.eveAPI.getSigGroups();
    jabberSigsMap.clear();
    for (const g of groups) {
      jabberSigsMap.set(jabberNormSig(g.name), g);
    }
  } catch (e) {
    console.warn('[Jabber] loadJabberSigsMap failed:', e.message);
  }
}

// ── Comms channels map ────────────────────────────────────────────────────────
// Loaded from yaml/gsf_sigs.yaml comms_channels section.
// Each entry: { name, match: string[], url: string }

let jabberCommsChannels = []; // raw array, kept for ordered prefix matching

async function loadJabberCommsChannels() {
  try {
    jabberCommsChannels = await window.eveAPI.getCommsChannels();
  } catch (e) {
    console.warn('[Jabber] loadJabberCommsChannels failed:', e.message);
  }
}

/** Returns the configured URL for a comms string, or null if none found / not configured. */
function jabberCommsUrl(commsText) {
  if (!commsText) return null;
  // First: URL already embedded in the text
  const embedded = commsText.match(/https?:\/\/[^\s<>"]+/i);
  if (embedded) return embedded[0].replace(/[.)]+$/, '');
  // Second: match against configured channels
  const lower = commsText.toLowerCase();
  for (const ch of jabberCommsChannels) {
    if (ch.url && ch.match.some(m => lower.includes(m.toLowerCase()))) {
      return ch.url;
    }
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip zero-width / invisible Unicode chars used as EVE field separators. */
function jabberStripInvisible(str) {
  if (!str) return '';
  return str.replace(/[​-‏‪-‮⁠-⁤﻿­�]/g, '').trim();
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

// ── PAP badge ─────────────────────────────────────────────────────────────────

// ── Formup navigate button ────────────────────────────────────────────────────

function jabberFormupBtn(formup) {
  if (!formup) return '';
  const clean = formup.replace(/[​-‏‪-‮﻿]/g, '').trim();
  if (!clean) return '';
  // Extract just the system name (before " - structure" or " (")
  const systemName = clean.split(/\s+-\s+|\s+\(/)[0].trim();
  return `<button class="jformup-btn" data-formup-system="${escHtml(systemName)}" title="Navigate to ${escHtml(systemName)}">${escHtml(clean)}</button>`;
}

// ── Linkify ───────────────────────────────────────────────────────────────────
// Escapes all text and wraps http(s) URLs in clickable anchor tags.
// The click is handled via event delegation on #jabberTable (see bindJabberEvents).

function jabberLinkify(str) {
  if (!str) return '';
  const urlRe = /https?:\/\/[^\s<>"]+/gi;
  const parts = [];
  let last = 0, m;
  while ((m = urlRe.exec(str)) !== null) {
    if (m.index > last) parts.push(escHtml(str.slice(last, m.index)));
    const url = m[0].replace(/[.)]+$/, ''); // trim trailing punctuation
    parts.push(`<a class="jabber-link" href="#" data-url="${escHtml(url)}" title="${escHtml(url)}">${escHtml(url)}</a>`);
    last = m.index + m[0].length;
  }
  if (last < str.length) parts.push(escHtml(str.slice(last)));
  return parts.join('');
}

/** Render the FC Name cell with a circular portrait placeholder. */
function jabberFcCell(fcName) {
  if (!fcName) return '';
  const clean = fcName.replace(/[​-‏﻿]/g, '').trim();
  if (!clean) return escHtml(fcName);
  const cachedId = jabberPortraitCache.get(clean.toLowerCase());
  // Only set src when we have a real ID — omitting src entirely avoids an
  // immediate onerror from src="" which would hide the element before the
  // async resolution can fill it in.
  const srcAttr = cachedId
    ? `src="https://images.evetech.net/characters/${cachedId}/portrait?size=32" onerror="this.style.display='none'"`
    : '';
  const img = `<img class="jabber-fc-portrait" ${srcAttr}
    data-fc-name="${escHtml(clean)}"
    ${cachedId ? 'data-resolved="1"' : ''} alt="">`;
  return `<span class="jabber-fc-cell">${img}<span class="jabber-fc-name">${escHtml(clean)}</span></span>`;
}

/** Render the comms cell: linkify embedded URLs; if a configured channel URL
 *  is found and no URL is already in the text, append a clickable ⊕ link. */
function jabberCommsCell(comms) {
  if (!comms) return '';
  const hasEmbedded = /https?:\/\//i.test(comms);
  const configUrl   = !hasEmbedded ? jabberCommsUrl(comms) : null;

  // Linkify handles any embedded URLs in the text
  let html = jabberLinkify(comms);

  // Append a small join-link badge when a configured URL exists but isn't in the text
  if (configUrl) {
    html += ` <a class="jabber-link jabber-comms-join" href="#" data-url="${escHtml(configUrl)}" title="Open ${escHtml(comms)} comms">⊕</a>`;
  }
  return html;
}

function jabberPapBadge(papType) {
  if (!papType) return '';
  const clean = papType.trim();
  const lower = clean.toLowerCase();
  const cls = /stratop/.test(lower)   ? 'jpap-stratop'
            : /peacetime/.test(lower) ? 'jpap-peacetime'
            : 'jpap-sig';
  return `<span class="jpap-badge ${cls}">${escHtml(clean.toUpperCase())}</span>`;
}

function jabberBadgeFromYaml(clean, baseClass) {
  const entry = jabberSigsMap.get(jabberNormSig(clean));
  if (!entry) return null;
  const bg     = jabberHexToRgba(entry.color, 0.12);
  const border = jabberHexToRgba(entry.color, 0.32);
  const icon   = entry.iconUrl
    ? `<img src="${entry.iconUrl}" style="width:12px;height:12px;object-fit:contain;vertical-align:middle;margin-right:3px;border-radius:2px;" onerror="this.style.display='none'">`
    : '';
  return `<span class="${baseClass}" style="background:${bg};color:${entry.color};border:1px solid ${border};">${icon}${escHtml(clean)}</span>`;
}

function jabberTargetBadge(target) {
  if (!target) return '';
  const clean = target.trim();
  const yamlBadge = jabberBadgeFromYaml(clean, 'jtgt-badge');
  if (yamlBadge) return yamlBadge;
  const lower = clean.toLowerCase();
  const cls = /^all$/.test(lower)     ? 'jtgt-all'
            : /incursion/.test(lower) ? 'jtgt-incursion'
            : /goon/.test(lower)      ? 'jtgt-goon'
            : /locust/.test(lower)    ? 'jtgt-locusts'
            : /^fcsc$/.test(lower)    ? 'jtgt-fcsc'
            : /opt.all/.test(lower)   ? 'jtgt-optall'
            : /beehive/.test(lower)   ? 'jtgt-beehive'
            : 'jtgt-other';
  return `<span class="jtgt-badge ${cls}">${escHtml(clean)}</span>`;
}

function jabberSigBadge(sig) {
  if (!sig) return '';
  const clean = sig.trim();
  const yamlBadge = jabberBadgeFromYaml(clean, 'jsig-badge');
  if (yamlBadge) return yamlBadge;
  const lower = clean.toLowerCase();
  const cls = /capital.commander/.test(lower) ? 'jsig-capital'
            : /skirmish/.test(lower)          ? 'jsig-skirmish'
            : /guardbee/.test(lower)          ? 'jsig-guardbees'
            : /^gice$/.test(lower)            ? 'jsig-gice'
            : /^coord$/.test(lower)           ? 'jsig-coord'
            : 'jsig-other';
  return `<span class="jsig-badge ${cls}">${escHtml(clean)}</span>`;
}

// ── Column visibility ─────────────────────────────────────────────────────────

const JABBER_COL_NAMES = ['EVE Time','FC Name','Formup','PAP Type','Doctrine','SIG','Comms','Pinged By','Target','Message'];

function jabberGetColVisibility() {
  try {
    const s = localStorage.getItem('jabberColVisibility');
    if (s) {
      const v = JSON.parse(s);
      if (Array.isArray(v) && v.length === JABBER_COL_NAMES.length) return v;
    }
  } catch(e) {}
  return JABBER_COL_NAMES.map(() => true);
}

function jabberApplyColVisibility(visible) {
  const style = document.getElementById('jabberColVisStyle');
  if (!style) return;
  style.textContent = visible.map((v, i) => v ? '' :
    `#jabberTable th:nth-child(${i+1}),#jabberTable td:nth-child(${i+1}){display:none}`
  ).join('\n');
}

function jabberSaveColVisibility(visible) {
  localStorage.setItem('jabberColVisibility', JSON.stringify(visible));
  jabberApplyColVisibility(visible);
}

function jabberBuildColsDropdown() {
  const dd = document.getElementById('jabberColsDropdown');
  if (!dd) return;
  const visible = jabberGetColVisibility();
  dd.innerHTML = JABBER_COL_NAMES.map((name, i) => `
    <label style="display:flex;align-items:center;gap:7px;padding:3px 0;cursor:pointer;
                  font-family:var(--mono);font-size:10px;color:var(--text-3);white-space:nowrap;user-select:none;">
      <input type="checkbox" ${visible[i] ? 'checked' : ''} data-col-idx="${i}"
             style="accent-color:var(--accent);cursor:pointer;">
      ${escHtml(name)}
    </label>`).join('');
  dd.querySelectorAll('input[data-col-idx]').forEach(cb => {
    cb.addEventListener('change', () => {
      const v = jabberGetColVisibility();
      v[parseInt(cb.dataset.colIdx, 10)] = cb.checked;
      jabberSaveColVisibility(v);
    });
  });
}

function initJabberColsToggle() {
  const btn = document.getElementById('jabberColsBtn');
  const dd  = document.getElementById('jabberColsDropdown');
  if (!btn || !dd) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dd.style.display !== 'none';
    dd.style.display = open ? 'none' : 'block';
    btn.classList.toggle('active', !open);
    if (!open) jabberBuildColsDropdown();
  });

  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !dd.contains(e.target)) {
      dd.style.display = 'none';
      btn.classList.remove('active');
    }
  });

  jabberApplyColVisibility(jabberGetColVisibility());
}

// ── Column resizing ───────────────────────────────────────────────────────────

const JABBER_DEFAULT_WIDTHS = [160,100,120,80,110,60,110,90,70,280,62];

function jabberGetColWidths() {
  try {
    const s = localStorage.getItem('jabberColWidths');
    if (s) {
      const w = JSON.parse(s);
      if (Array.isArray(w) && w.length === 11) return w;
    }
  } catch(e) {}
  return null;
}

function jabberSaveColWidths() {
  const ths = document.querySelectorAll('#jabberTable thead th');
  const widths = Array.from(ths).map(th => Math.round(th.getBoundingClientRect().width));
  const table  = document.getElementById('jabberTable');
  localStorage.setItem('jabberColWidths', JSON.stringify(widths));
  if (table) localStorage.setItem('jabberTableWidth', table.style.width);
}

function jabberApplyColWidths(widths) {
  widths.forEach((w, i) => {
    const col = document.getElementById(`jcol-${i}`);
    if (col && w > 0) col.style.width = w + 'px';
  });
  const savedTableW = localStorage.getItem('jabberTableWidth');
  const table = document.getElementById('jabberTable');
  if (table && savedTableW) table.style.width = savedTableW;
}

function initJabberColResize() {
  const saved = jabberGetColWidths();
  if (saved) jabberApplyColWidths(saved);

  const ths = document.querySelectorAll('#jabberTable thead th');
  ths.forEach((th, idx) => {
    // Last column (View) has no resize handle
    if (idx === ths.length - 1) return;

    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const table       = document.getElementById('jabberTable');
      const startX      = e.clientX;
      const col         = document.getElementById(`jcol-${idx}`);
      const startColW   = th.getBoundingClientRect().width;
      const startTableW = table ? table.offsetWidth : 0;

      // Freeze table to a pixel width — prevents width:100% from rescaling
      // every other column when only one column should change.
      if (table) table.style.width = startTableW + 'px';

      handle.classList.add('dragging');
      document.body.style.cursor    = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev) => {
        const delta   = ev.clientX - startX;
        const newColW = Math.max(30, startColW + delta);
        const clampedDelta = newColW - startColW;
        if (col)   col.style.width   = newColW + 'px';
        // Grow/shrink the table by exactly the same delta so no other column shifts
        if (table) table.style.width = (startTableW + clampedDelta) + 'px';
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor    = '';
        document.body.style.userSelect = '';
        jabberSaveColWidths();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderJabberTable() {
  const tbody = document.querySelector('#jabberTable tbody');
  if (!tbody) return;

  // Sort newest-first — no filters applied, show everything
  const sorted = [...jabberMessages].sort((a, b) => jabberSortKey(b).localeCompare(jabberSortKey(a)));

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="loading-row">No messages received yet.</td></tr>`;
    updateJabberSummary(0);
    return;
  }

  tbody.innerHTML = sorted.map(row => {
    // Truncate doctrine to first URL-free segment for display; full text in title
    const docShort = row.doctrine
      ? row.doctrine.replace(/https?:\/\/\S+/g, '').trim().split(/\s+/).slice(0, 4).join(' ')
      : '';

    // Only show View button if the row has a DB id (stored pings)
    const viewBtn = row.id != null
      ? `<button class="ping-view-btn" data-ping-id="${row.id}" title="Re-open ping alert">View</button>`
      : `<button class="ping-view-btn ping-view-btn--live" disabled title="Live ping — not yet stored">View</button>`;

    return `<tr title="${escHtml(row.raw_body || '')}">
      <td style="font-family:var(--mono);font-size:11px;">${escHtml(row.eve_timecode || row.ping_timestamp || '')}</td>
      <td style="overflow:visible;">${jabberFcCell(row.fc_name)}</td>
      <td style="overflow:visible;">${jabberFormupBtn(row.formup_location)}</td>
      <td style="overflow:visible;">${jabberPapBadge(row.pap_type)}</td>
      <td title="${escHtml(row.doctrine || '')}">${escHtml(docShort)}</td>
      <td style="overflow:visible;">${jabberSigBadge(row.sig)}</td>
      <td style="overflow:visible;">${jabberCommsCell(row.comms)}</td>
      <td>${escHtml(row.gsol_member   || row.who_pinged || '')}</td>
      <td style="overflow:visible;">${jabberTargetBadge(row.target_sig)}</td>
      <td class="jabber-msg-cell" title="${escHtml(row.hurf || '')}">${jabberLinkify(row.hurf || row.raw_body || '')}</td>
      <td style="text-align:center;">${viewBtn}</td>
    </tr>`;
  }).join('');

  updateJabberSummary(sorted.length);

  // Resolve FC portraits in background — updates img srcs without re-rendering
  setTimeout(jabberResolvePortraits, 0);

  // Wire View buttons — delegate on tbody so it survives re-renders
  tbody.querySelectorAll('.ping-view-btn[data-ping-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.pingId, 10);
      if (!isNaN(id)) window.eveAPI.openPingAlert(id);
    });
  });
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
    pack:         jabber.pack         || 'gsf_sigs',
  };

  const serviceInput  = document.getElementById('jabberService');
  const jidInput      = document.getElementById('jabberJid');
  const passwordInput = document.getElementById('jabberPassword');
  const directorCheck = document.getElementById('jabberDirectorOnly');

  if (serviceInput)  serviceInput.value    = jabberSettings.service;
  if (jidInput)      jidInput.value        = jabberSettings.jid;
  if (passwordInput) passwordInput.value   = jabberSettings.password;
  if (directorCheck) directorCheck.checked = jabberSettings.directorOnly;

  await populatePackDropdown(jabberSettings.pack);
}

function gatherJabberSettings() {
  return {
    service:      document.getElementById('jabberService')?.value.trim()   || 'xmpp://jabber.eveonline.com:5222',
    jid:          document.getElementById('jabberJid')?.value.trim()       || '',
    password:     document.getElementById('jabberPassword')?.value         || '',
    directorOnly: document.getElementById('jabberDirectorOnly')?.checked   ?? true,
    pack:         document.getElementById('jabberPackSelect')?.value       || 'gsf_sigs',
  };
}

// ── Pack dropdown helpers ─────────────────────────────────────────────────────

let _cachedPacks = [];

async function populatePackDropdown(selectedPackId) {
  const select = document.getElementById('jabberPackSelect');
  if (!select) return;

  try {
    _cachedPacks = await window.eveAPI.getPacks();
    select.innerHTML = '';

    for (const pack of _cachedPacks) {
      const opt = document.createElement('option');
      opt.value = pack.id;
      opt.textContent = pack.alliance && pack.alliance !== pack.name
        ? `${pack.name} — ${pack.alliance}`
        : pack.name;
      if (pack.id === selectedPackId) opt.selected = true;
      select.appendChild(opt);
    }

    // If nothing matched the saved id, default to first option
    if (!_cachedPacks.find(p => p.id === selectedPackId) && _cachedPacks.length) {
      select.value = _cachedPacks[0].id;
    }

    updatePackInfo(select.value);

    select.onchange = () => updatePackInfo(select.value);
  } catch (e) {
    console.warn('[jabber] populatePackDropdown failed:', e.message);
  }
}

function updatePackInfo(packId) {
  const infoEl    = document.getElementById('jabberPackInfo');
  const deleteBtn = document.getElementById('jabberDeletePackBtn');
  const pack      = _cachedPacks.find(p => p.id === packId);

  if (infoEl) {
    const parts = [];
    if (pack?.description) parts.push(pack.description);
    if (pack?.author)      parts.push(`By: ${pack.author}`);
    if (pack?.version)     parts.push(`v${pack.version}`);
    infoEl.textContent = parts.join(' · ');
  }

  if (deleteBtn) {
    deleteBtn.style.display = pack?.source === 'user' ? 'inline-block' : 'none';
  }
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

// ── Table zoom ────────────────────────────────────────────────────────────────

const JABBER_ZOOM_SIZES = [9, 10, 11, 12, 13, 14, 15]; // px
const JABBER_ZOOM_DEFAULT = 2; // index → 11px

function jabberGetZoomIdx() {
  const v = parseInt(localStorage.getItem('jabberZoomIdx'), 10);
  return isNaN(v) ? JABBER_ZOOM_DEFAULT : Math.max(0, Math.min(JABBER_ZOOM_SIZES.length - 1, v));
}

function jabberApplyZoom(idx) {
  const table = document.getElementById('jabberTable');
  const label = document.getElementById('jabberZoomLevel');
  const px    = JABBER_ZOOM_SIZES[idx];
  if (table) table.style.setProperty('--jabber-zoom', px + 'px');
  if (label) label.textContent = px;
  localStorage.setItem('jabberZoomIdx', idx);
}

function initJabberZoom() {
  jabberApplyZoom(jabberGetZoomIdx());

  document.getElementById('jabberZoomIn')?.addEventListener('click', () => {
    const idx = jabberGetZoomIdx();
    if (idx < JABBER_ZOOM_SIZES.length - 1) jabberApplyZoom(idx + 1);
  });
  document.getElementById('jabberZoomOut')?.addEventListener('click', () => {
    const idx = jabberGetZoomIdx();
    if (idx > 0) jabberApplyZoom(idx - 1);
  });
}

function bindJabberEvents() {
  initJabberColsToggle();
  initJabberColResize();
  initJabberZoom();
  loadJabberSigsMap();
  loadJabberCommsChannels();

  // Delegated click handler — handles links and formup nav buttons.
  // bindJabberEvents() is called twice (pageLoader + app.js), so guard against
  // adding duplicate listeners with a module-level flag.
  const table = document.getElementById('jabberTable');
  if (table && !table._jabberClickBound) {
    table._jabberClickBound = true;
    table.addEventListener('click', async (e) => {
      // ── External links ──
      const link = e.target.closest('.jabber-link');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        const url = link.dataset.url;
        if (url) window.eveAPI.openExternalUrl(url);
        return;
      }

      // ── Formup navigate ──
      const btn = e.target.closest('.jformup-btn');
      if (!btn || btn.disabled) return;
      e.stopPropagation();
      const systemName = btn.dataset.formupSystem;
      if (!systemName) return;

      btn.disabled    = true;
      const origText  = btn.textContent;
      btn.textContent = '…';

      try {
        const accounts = await window.eveAPI.getAccounts().catch(() => []);
        if (!accounts.length) throw new Error('No characters — add one first');
        const match  = accounts.find(a => String(a.characterId) === String(selectedCharacterId));
        const charId = (match || accounts[0]).characterId;

        const systemId = await window.eveAPI.systemIdByName(systemName);
        if (!systemId) throw new Error(`System not found: ${systemName}`);

        await window.eveAPI.setAutopilotDestination(charId, systemId);
        btn.textContent = '✓ ' + origText;
        btn.classList.add('done');
        setTimeout(() => {
          btn.textContent = origText;
          btn.classList.remove('done');
          btn.disabled = false;
        }, 2500);
      } catch (err) {
        showToast(`Navigate failed: ${err.message}`, 'error');
        btn.textContent = origText;
        btn.classList.add('err');
        setTimeout(() => { btn.classList.remove('err'); btn.disabled = false; }, 2000);
      }
    });
  }

  // Live messages from main process.
  // When the DB insert succeeded, the broadcast is a complete DB row (has
  // raw_body). When it fails, the broadcast is the raw XMPP msg (has body).
  // Handle both so cells always show content regardless of DB state.
  window.eveAPI.on('jabber-message', (payload) => {
    const row = ('raw_body' in payload) ? payload : jabberLiveToRow(payload);
    jabberMessages.unshift(row);
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

  // Import pack button
  const importPackBtn = document.getElementById('jabberImportPackBtn');
  if (importPackBtn && !importPackBtn._packBound) {
    importPackBtn._packBound = true;
    importPackBtn.addEventListener('click', async () => {
      try {
        const result = await window.eveAPI.importPack();
        if (result.canceled) return;
        if (!result.success) {
          showToast(`Import failed: ${result.error}`, 'error');
          return;
        }
        // Refresh dropdown and select the newly imported pack
        const select = document.getElementById('jabberPackSelect');
        await populatePackDropdown(result.pack.id);
        if (select) select.value = result.pack.id;
        updatePackInfo(result.pack.id);
        showToast(`Pack "${result.pack.name}" imported.`, 'success');
      } catch (e) {
        showToast(`Import error: ${e.message}`, 'error');
      }
    });
  }

  // Delete pack button
  const deletePackBtn = document.getElementById('jabberDeletePackBtn');
  if (deletePackBtn && !deletePackBtn._packBound) {
    deletePackBtn._packBound = true;
    deletePackBtn.addEventListener('click', async () => {
      const select = document.getElementById('jabberPackSelect');
      const packId = select?.value;
      const pack   = _cachedPacks.find(p => p.id === packId);
      if (!pack || pack.source !== 'user') return;
      if (!confirm(`Delete the pack "${pack.name}"? This cannot be undone.`)) return;
      try {
        const result = await window.eveAPI.deletePack(packId);
        if (!result.success) {
          showToast(`Delete failed: ${result.error}`, 'error');
          return;
        }
        await populatePackDropdown('gsf_sigs');
        showToast(`Pack "${pack.name}" deleted.`, 'success');
      } catch (e) {
        showToast(`Delete error: ${e.message}`, 'error');
      }
    });
  }
}
