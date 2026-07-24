// ─── EVE Mail ─────────────────────────────────────────────────────────────────
// Three-pane mail client (labels │ message list │ reading pane) over the ESI
// mail endpoints. Mail is live-fetched and never written to the local DB — it's
// personal correspondence, and ESI already ETag-caches it through the main
// process (see the mail-* handlers in main.js). Same treatment as game fits.
//
// Requires the esi-mail.read_mail / send_mail / organize_mail scopes. Characters
// authenticated before those were added get a 403, which surfaces here as a
// "re-authenticate this character" prompt rather than a raw error.

// ESI's built-in label ids. Custom labels come back from the labels endpoint
// with their own ids and are appended after these.
const MAIL_SYSTEM_LABELS = [
  { labelId: 1, name: 'Inbox' },
  { labelId: 2, name: 'Sent' },
  { labelId: 4, name: 'Corporation' },
  { labelId: 8, name: 'Alliance' },
];

let _mailChar      = null;   // characterId whose mailbox is open
let _mailLabels    = [];     // [{ labelId, name, unreadCount }]
let _mailLabelId   = 1;      // current folder (1 = Inbox)
let _mailHeaders   = [];     // headers for the current folder, newest first
let _mailOpenId    = null;   // mail currently in the reading pane
let _mailLists     = [];     // mailing lists this character is subscribed to
let _mailNames     = {};     // id → name cache (senders/recipients)
let _mailBusy      = false;
let _mailExhausted = false;  // no more pages for this folder
let _mailTab       = 'mail'; // 'mail' | 'notifications' — the page's two tabs

// The Mail page hosts both mail and the notification feed, mirroring the EVE
// client (notifications live in the in-game mail window). Both share the
// character picker; only Mail can compose.
function _mailSetTab(tab) {
  _mailTab = tab;
  document.querySelectorAll('.mail-tab').forEach(b => b.classList.toggle('active', b.dataset.mailtab === tab));
  const paneMail  = document.getElementById('mailTabMail');
  const paneNotif = document.getElementById('mailTabNotifications');
  if (paneMail)  paneMail.style.display  = tab === 'mail' ? '' : 'none';
  if (paneNotif) paneNotif.style.display = tab === 'notifications' ? '' : 'none';
  const compose = document.getElementById('mailComposeBtn');
  if (compose) compose.style.display = tab === 'mail' ? '' : 'none';
  if (tab === 'notifications') Promise.resolve(initNotifications(_mailChar)).catch(() => {});
}

// ─── Entry point (called by _initPageForFirstVisit in ui.js) ─────────────────
async function initMailPage() {
  // Bind here rather than on DOMContentLoaded: loadAllPages() injects this
  // page's markup asynchronously, so the buttons don't exist yet at that point.
  // Re-binding is harmless — the handlers are assigned, not accumulated.
  _mailBindStaticControls();

  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(accounts) || !accounts.length) {
    _mailSetStatus('Add a character on the Characters page to read EVE Mail.');
    return;
  }
  // Default to whichever character the rest of the app has selected (the same
  // rule dashboard.js uses), falling back to the first account.
  if (!_mailChar || !accounts.some(a => String(a.characterId) === String(_mailChar))) {
    const main = accounts.find(a => String(a.characterId) === String(typeof selectedCharacterId !== 'undefined' ? selectedCharacterId : '')) || accounts[0];
    _mailChar = main.characterId;
  }
  _mailRenderCharPicker(accounts);
  await _mailReload();
}

function _mailRenderCharPicker(accounts) {
  const sel = document.getElementById('mailCharSelect');
  if (!sel) return;
  sel.innerHTML = accounts
    .map(a => `<option value="${a.characterId}">${escHtml(a.characterName)}</option>`)
    .join('');
  sel.value = String(_mailChar);
  sel.onchange = async () => {
    _mailChar = Number(sel.value);
    _mailLabelId = 1;
    // Reload whichever tab is showing — switching character shouldn't bounce
    // the user back to the mailbox while they're reading notifications.
    if (_mailTab === 'notifications') await initNotifications(_mailChar);
    else await _mailReload();
  };
}

// Full reload for the current character: labels + mailing lists + first page.
async function _mailReload() {
  _mailHeaders = [];
  _mailOpenId = null;
  _mailExhausted = false;
  _mailRenderReader(null);
  _mailSetStatus('Loading mail…');

  const [labelsRes, listsRes] = await Promise.all([
    window.eveAPI.mailGetLabels(_mailChar).catch(e => ({ ok: false, error: e.message })),
    window.eveAPI.mailGetLists(_mailChar).catch(() => ({ ok: false })),
  ]);

  if (!labelsRes.ok) { _mailShowError(labelsRes); return; }

  _mailLists = listsRes.ok ? listsRes.lists : [];
  // Mailing lists are valid senders — seed the name cache so they resolve.
  _mailLists.forEach(l => { _mailNames[l.id] = l.name; });

  // Merge ESI's labels over the known system ones so Inbox/Sent/Corp/Alliance
  // keep their familiar names and order, with custom labels after.
  const byId = new Map();
  MAIL_SYSTEM_LABELS.forEach(l => byId.set(l.labelId, { ...l, unreadCount: 0 }));
  (labelsRes.labels || []).forEach(l => {
    const known = byId.get(l.labelId);
    byId.set(l.labelId, { labelId: l.labelId, name: known ? known.name : l.name, unreadCount: l.unreadCount || 0 });
  });
  _mailLabels = [...byId.values()];

  _mailRenderLabels();
  _mailSetNavUnread(labelsRes.totalUnread);
  await _mailLoadPage(true);
}

async function _mailLoadPage(reset = false) {
  if (_mailBusy) return;
  _mailBusy = true;
  if (reset) { _mailHeaders = []; _mailExhausted = false; }
  _mailSetStatus(reset ? 'Loading mail…' : 'Loading older mail…');

  // Page backwards using the oldest id we already hold.
  const lastMailId = _mailHeaders.length
    ? Math.min(..._mailHeaders.map(m => m.mailId))
    : null;

  const res = await window.eveAPI
    .mailGetHeaders(_mailChar, { labelId: _mailLabelId, lastMailId })
    .catch(e => ({ ok: false, error: e.message }));

  _mailBusy = false;
  if (!res.ok) { _mailShowError(res); return; }

  // ESI returns at most 50 per call — fewer means we've reached the end.
  if (!res.mails.length || res.mails.length < 50) _mailExhausted = true;

  const seen = new Set(_mailHeaders.map(m => m.mailId));
  _mailHeaders.push(...res.mails.filter(m => !seen.has(m.mailId)));
  _mailHeaders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  await _mailResolveNames(_mailHeaders.flatMap(m => [m.from, ...m.recipients.map(r => r.id)]));
  _mailRenderList();
  _mailSetStatus('');
}

// ─── Name resolution ─────────────────────────────────────────────────────────
// Batch-resolves unknown character/corp/alliance ids, tolerating either shape
// getNames() can return (array of {id,name} or a plain id→name map).
async function _mailResolveNames(ids) {
  const missing = [...new Set(ids.filter(id => id && !_mailNames[id]))];
  if (!missing.length) return;
  try {
    const r = await window.eveAPI.getNames(missing);
    if (Array.isArray(r)) r.forEach(({ id, name }) => { if (id && name) _mailNames[id] = name; });
    else if (r && typeof r === 'object') Object.assign(_mailNames, r);
  } catch (_) { /* leave unresolved — rendered as the raw id below */ }
}

const _mailName = (id) => _mailNames[id] || `ID ${id}`;

// ─── Rendering ───────────────────────────────────────────────────────────────
function _mailRenderLabels() {
  const host = document.getElementById('mailLabels');
  if (!host) return;
  host.innerHTML = _mailLabels.map(l => `
    <button class="mail-label-btn${l.labelId === _mailLabelId ? ' active' : ''}" data-label="${l.labelId}">
      <span class="mail-label-name">${escHtml(l.name)}</span>
      ${l.unreadCount ? `<span class="mail-label-count">${l.unreadCount}</span>` : ''}
    </button>`).join('');
  host.querySelectorAll('.mail-label-btn').forEach(btn => {
    btn.onclick = async () => {
      _mailLabelId = Number(btn.dataset.label);
      _mailOpenId = null;
      _mailRenderReader(null);
      _mailRenderLabels();
      await _mailLoadPage(true);
    };
  });
}

function _mailRenderList() {
  const host = document.getElementById('mailList');
  if (!host) return;
  if (!_mailHeaders.length) {
    host.innerHTML = '<div class="mail-empty">No mail in this folder.</div>';
    return;
  }
  host.innerHTML = _mailHeaders.map(m => `
    <button class="mail-row${m.isRead ? '' : ' unread'}${m.mailId === _mailOpenId ? ' active' : ''}" data-id="${m.mailId}">
      <div class="mail-row-top">
        <span class="mail-row-from">${escHtml(_mailName(m.from))}</span>
        <span class="mail-row-date">${_mailFmtDate(m.timestamp)}</span>
      </div>
      <div class="mail-row-subject">${escHtml(m.subject)}</div>
    </button>`).join('')
    + (_mailExhausted ? '' : '<button class="mail-more-btn" id="mailMoreBtn">Load older mail</button>');

  host.querySelectorAll('.mail-row').forEach(row => {
    row.onclick = () => _mailOpen(Number(row.dataset.id));
  });
  const more = document.getElementById('mailMoreBtn');
  if (more) more.onclick = () => _mailLoadPage(false);
}

async function _mailOpen(mailId) {
  _mailOpenId = mailId;
  _mailRenderList();
  _mailRenderReader(null, 'Loading…');

  const res = await window.eveAPI.mailGetBody(_mailChar, mailId).catch(e => ({ ok: false, error: e.message }));
  if (!res.ok) { _mailRenderReader(null, res.error || 'Could not load this mail.'); return; }

  await _mailResolveNames([res.mail.from, ...res.mail.recipients.map(r => r.id)]);
  _mailRenderReader(res.mail);

  // Mark read in the background; reflect it locally so the list updates at once.
  const header = _mailHeaders.find(m => m.mailId === mailId);
  if (header && !header.isRead) {
    header.isRead = true;
    const lbl = _mailLabels.find(l => l.labelId === _mailLabelId);
    if (lbl && lbl.unreadCount > 0) lbl.unreadCount--;
    _mailRenderList();
    _mailRenderLabels();
    window.eveAPI.mailUpdate(_mailChar, mailId, { read: true }).catch(() => {});
  }
}

function _mailRenderReader(mail, message) {
  const host = document.getElementById('mailReader');
  if (!host) return;
  host.innerHTML = '';
  if (!mail) {
    const d = document.createElement('div');
    d.className = 'mail-empty';
    d.textContent = message || 'Select a mail to read.';
    host.appendChild(d);
    return;
  }

  const head = document.createElement('div');
  head.className = 'mail-reader-head';
  head.innerHTML = `
    <div class="mail-reader-subject">${escHtml(mail.subject)}</div>
    <div class="mail-reader-meta">
      <span><span class="mail-meta-label">From</span> ${escHtml(_mailName(mail.from))}</span>
      <span><span class="mail-meta-label">Sent</span> ${_mailFmtDate(mail.timestamp, true)}</span>
    </div>
    <div class="mail-reader-meta">
      <span><span class="mail-meta-label">To</span> ${escHtml(mail.recipients.map(r => _mailName(r.id)).join(', ')) || '—'}</span>
    </div>
    <div class="mail-reader-actions">
      <button class="mail-act-btn" id="mailReplyBtn">Reply</button>
      <button class="mail-act-btn" id="mailUnreadBtn">Mark unread</button>
      <button class="mail-act-btn danger" id="mailDeleteBtn">Delete</button>
    </div>`;
  host.appendChild(head);

  // Body is untrusted third-party content — sanitised into real DOM nodes,
  // never assigned through innerHTML. See _mailSanitizeBody.
  host.appendChild(_mailSanitizeBody(mail.body));

  document.getElementById('mailReplyBtn').onclick = () => _mailCompose({
    recipients: [{ id: mail.from, type: 'character', name: _mailName(mail.from) }],
    subject: /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`,
  });
  document.getElementById('mailUnreadBtn').onclick = async () => {
    const r = await window.eveAPI.mailUpdate(_mailChar, mail.mailId, { read: false }).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) { showToast(r.error || 'Could not mark unread.', 'error'); return; }
    const h = _mailHeaders.find(m => m.mailId === mail.mailId);
    if (h) h.isRead = false;
    _mailRenderList();
    showToast('Marked unread.', 'success');
  };
  document.getElementById('mailDeleteBtn').onclick = () => _mailDelete(mail.mailId);
}

async function _mailDelete(mailId) {
  if (!confirm('Delete this mail? This also removes it in-game and cannot be undone.')) return;
  const r = await window.eveAPI.mailDelete(_mailChar, mailId).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) { showToast(r.error || 'Could not delete this mail.', 'error'); return; }
  _mailHeaders = _mailHeaders.filter(m => m.mailId !== mailId);
  _mailOpenId = null;
  _mailRenderList();
  _mailRenderReader(null);
  showToast('Mail deleted.', 'success');
}

// ─── Body sanitiser ──────────────────────────────────────────────────────────
// EVE mail bodies are attacker-controlled HTML rendered inside an Electron
// renderer, so they get a strict allow-list pass: we rebuild the tree as fresh
// DOM nodes, copy only known-safe tags, drop every attribute except a validated
// font colour, and neuter links. Text is inserted with createTextNode, so no
// markup from the mail is ever parsed as HTML in our document.
const _MAIL_OK_TAGS = new Set(['BR', 'B', 'STRONG', 'I', 'EM', 'U', 'FONT', 'A', 'SPAN', 'DIV', 'P', 'CENTER', 'UL', 'OL', 'LI']);

function _mailSanitizeBody(raw) {
  const wrap = document.createElement('div');
  wrap.className = 'mail-body';
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(String(raw || ''), 'text/html');
  } catch (_) {
    wrap.textContent = String(raw || '');
    return wrap;
  }
  _mailCopyNodes(parsed.body, wrap);
  return wrap;
}

function _mailCopyNodes(src, dest) {
  for (const node of Array.from(src.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      dest.appendChild(document.createTextNode(node.nodeValue));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;   // drop comments, CDATA, etc.

    const tag = node.tagName.toUpperCase();
    // Unknown/dangerous element (script, style, iframe, img, <loc>, …): drop the
    // element itself but keep any readable text inside it.
    if (!_MAIL_OK_TAGS.has(tag)) { _mailCopyNodes(node, dest); continue; }

    if (tag === 'BR') { dest.appendChild(document.createElement('br')); continue; }

    // <font> becomes a span carrying only a validated colour.
    if (tag === 'FONT') {
      const span = document.createElement('span');
      const col = _mailSafeColor(node.getAttribute('color'));
      if (col) span.style.color = col;
      _mailCopyNodes(node, span);
      dest.appendChild(span);
      continue;
    }

    if (tag === 'A') { dest.appendChild(_mailSafeLink(node)); continue; }

    const el = document.createElement(tag.toLowerCase());
    _mailCopyNodes(node, el);
    dest.appendChild(el);
  }
}

// EVE writes colours as #AARRGGBB (or #RRGGBB). Accept only hex and strip the
// alpha byte; anything else is ignored rather than passed into CSS.
function _mailSafeColor(v) {
  if (!v) return null;
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim());
  if (!m) return null;
  const hex = m[1];
  return '#' + (hex.length === 8 ? hex.slice(2) : hex);
}

// Only http(s) links become clickable, and they open in the real browser rather
// than navigating the app. EVE's internal schemes (showinfo:, killReport:,
// fitting:) can't be followed outside the client, so they render as inert
// styled text — never as a live href (which is also how javascript: is blocked).
function _mailSafeLink(node) {
  const href = (node.getAttribute('href') || '').trim();
  const text = node.textContent || href;
  if (/^https?:\/\//i.test(href)) {
    const a = document.createElement('a');
    a.className = 'mail-link';
    a.textContent = text;
    a.href = '#';
    a.title = href;
    a.onclick = (e) => {
      e.preventDefault();
      try { window.eveAPI.openExternalUrl(href); } catch (_) {}
    };
    return a;
  }
  // Anything else renders as inert text. Only echo the target for EVE's own
  // known schemes — we don't want to repeat an arbitrary (possibly hostile)
  // href back to the user, even somewhere as harmless as a tooltip.
  const span = document.createElement('span');
  span.className = 'mail-link-eve';
  span.textContent = text;
  if (/^(showinfo|killreport|fitting|contract|solarsystem|station):/i.test(href)) {
    span.title = `In-game link: ${href}`;
  } else if (href) {
    span.title = 'Link removed — not a supported link type.';
  }
  return span;
}

// ─── Composer ────────────────────────────────────────────────────────────────
let _mailComposeTo = [];   // [{ id, type, name }]

function _mailCompose(prefill = {}) {
  _mailComposeTo = prefill.recipients ? [...prefill.recipients] : [];
  const bd = document.getElementById('mailComposeBackdrop');
  if (!bd) return;
  document.getElementById('mailComposeSubject').value = prefill.subject || '';
  document.getElementById('mailComposeBody').value = prefill.body || '';
  document.getElementById('mailComposeSearch').value = '';
  _mailRenderRecipients();
  bd.style.display = 'flex';
}

function _mailCloseCompose() {
  const bd = document.getElementById('mailComposeBackdrop');
  if (bd) bd.style.display = 'none';
}

function _mailRenderRecipients() {
  const host = document.getElementById('mailComposeChips');
  if (!host) return;
  host.innerHTML = _mailComposeTo.length
    ? _mailComposeTo.map((r, i) => `
        <span class="mail-chip" title="${escHtml(r.type)}">
          ${escHtml(r.name)}<button class="mail-chip-x" data-i="${i}">✕</button>
        </span>`).join('')
    : '<span class="mail-chip-hint">No recipients yet — search above.</span>';
  host.querySelectorAll('.mail-chip-x').forEach(b => {
    b.onclick = () => { _mailComposeTo.splice(Number(b.dataset.i), 1); _mailRenderRecipients(); };
  });
}

// Resolve a typed name to a character/corp/alliance via ESI's name→id endpoint,
// plus any subscribed mailing list matched locally.
async function _mailLookupRecipient() {
  const input = document.getElementById('mailComposeSearch');
  const name = (input.value || '').trim();
  if (!name) return;

  const list = _mailLists.find(l => l.name.toLowerCase() === name.toLowerCase());
  if (list) {
    _mailAddRecipient({ id: list.id, type: 'mailing_list', name: list.name });
    input.value = '';
    return;
  }

  const res = await window.eveAPI.esiFetch(
    'https://esi.evetech.net/v1/universe/ids/?datasource=tranquility',
    { method: 'POST', body: [name] },
  ).catch(() => null);

  const pick = (arr, type) => (arr && arr.length ? { id: arr[0].id, type, name: arr[0].name } : null);
  const hit = pick(res?.characters, 'character')
           || pick(res?.corporations, 'corporation')
           || pick(res?.alliances, 'alliance');

  if (!hit) { showToast(`No character, corp, alliance or mailing list called "${name}".`, 'error'); return; }
  _mailAddRecipient(hit);
  input.value = '';
}

function _mailAddRecipient(r) {
  if (_mailComposeTo.some(x => String(x.id) === String(r.id))) return;
  if (_mailComposeTo.length >= 50) { showToast('EVE Mail allows at most 50 recipients.', 'error'); return; }
  _mailComposeTo.push(r);
  _mailRenderRecipients();
}

async function _mailSendCompose() {
  const subject = document.getElementById('mailComposeSubject').value.trim();
  const body    = document.getElementById('mailComposeBody').value;
  if (!_mailComposeTo.length) { showToast('Add at least one recipient.', 'error'); return; }
  if (!subject)               { showToast('Add a subject.', 'error'); return; }

  const btn = document.getElementById('mailComposeSendBtn');
  btn.disabled = true; btn.textContent = 'Sending…';
  const res = await window.eveAPI.mailSend(_mailChar, {
    recipients: _mailComposeTo.map(r => ({ id: r.id, type: r.type })), subject, body,
  }).catch(e => ({ ok: false, error: e.message }));
  btn.disabled = false; btn.textContent = 'Send';

  if (!res.ok) { showToast(res.error || 'Could not send mail.', 'error'); return; }
  showToast('Mail sent.', 'success');
  _mailCloseCompose();
  if (_mailLabelId === 2) await _mailLoadPage(true);   // viewing Sent — refresh
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function _mailFmtDate(iso, full = false) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  if (full) return d.toLocaleString();
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function _mailSetStatus(msg) {
  const el = document.getElementById('mailStatus');
  if (el) el.textContent = msg || '';
}

// Unread badge on the nav button, mirroring the Forums/Jabber status lights.
function _mailSetNavUnread(n) {
  const el = document.getElementById('mailNavUnread');
  if (!el) return;
  el.textContent = n > 0 ? String(n) : '';
  el.className = n > 0 ? 'nav-status mail-nav-unread' : 'nav-status';
}

// A 403 here means the character was authenticated before the mail scopes were
// added — tell the user exactly what to do instead of showing an HTTP error.
function _mailShowError(res) {
  _mailSetStatus('');
  const host = document.getElementById('mailList');
  if (!host) return;
  host.innerHTML = res.needsReauth
    ? `<div class="mail-empty">EVE Mail access hasn't been granted for this character yet.<br><br>
         Open the <b>Characters</b> page and re-authenticate it to grant mail access.</div>`
    : `<div class="mail-empty">${escHtml(res.error || 'Could not load mail.')}</div>`;
}

// Wire the page's static controls. Called from initMailPage() once the injected
// markup is in the DOM (see the note there).
function _mailBindStaticControls() {
  const compose = document.getElementById('mailComposeBtn');
  if (compose) compose.onclick = () => _mailCompose();
  const refresh = document.getElementById('mailRefreshBtn');
  if (refresh) refresh.onclick = () => (_mailTab === 'notifications' ? initNotifications(_mailChar) : _mailReload());
  document.querySelectorAll('.mail-tab').forEach(b => {
    b.onclick = () => _mailSetTab(b.dataset.mailtab);
  });
  const cancel = document.getElementById('mailComposeCancelBtn');
  if (cancel) cancel.onclick = _mailCloseCompose;
  const send = document.getElementById('mailComposeSendBtn');
  if (send) send.onclick = _mailSendCompose;
  const add = document.getElementById('mailComposeAddBtn');
  if (add) add.onclick = _mailLookupRecipient;
  const search = document.getElementById('mailComposeSearch');
  if (search) search.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); _mailLookupRecipient(); } };
}
