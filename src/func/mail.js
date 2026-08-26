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

// _mailChar is a characterId, or the string 'all' for the combined mailbox.
// In combined mode every header carries the mailbox it came from (_charId), so
// opening, marking and deleting still act on the right character — EVE Mail is
// per-character and there is no roster-wide endpoint. Use _mailBoxIds() rather
// than reading _mailChar directly when you need actual character ids.
const MAIL_ALL = 'all';
let _mailChar      = null;   // characterId whose mailbox is open, or MAIL_ALL
let _mailAccounts  = [];     // [{ characterId, characterName }] — the roster
let _mailLabels    = [];     // [{ labelId, name, unreadCount }]
let _mailLabelId   = 1;      // current folder (1 = Inbox)
let _mailHeaders   = [];     // headers for the current folder, newest first
let _mailOpenId    = null;   // mail currently in the reading pane
let _mailLists     = [];     // mailing lists this character is subscribed to
let _mailNames     = {};     // id → name cache (senders/recipients)
let _mailBusy      = false;
let _mailExhausted = false;  // no more pages for this folder
let _mailPageState = {};     // charId → { lastMailId, exhausted } for combined paging
let _mailTab       = 'mail'; // 'mail' | 'notifications' — the page's two tabs

// The chosen mailbox survives restarts, stored as the picker's own value string
// ('all' or a character id) so it round-trips through the same parsing.
const MAIL_BOX_KEY = 'mailSelectedBox';
function _mailLoadBox() {
  try { return localStorage.getItem(MAIL_BOX_KEY) || null; } catch (_) { return null; }
}
function _mailSaveBox(v) {
  try { localStorage.setItem(MAIL_BOX_KEY, String(v)); } catch (_) { /* private mode */ }
}

const _mailIsAll   = () => _mailChar === MAIL_ALL;
/** Character ids currently being read — every account in combined mode. */
const _mailBoxIds  = () => (_mailIsAll()
  ? _mailAccounts.map(a => Number(a.characterId))
  : (_mailChar == null ? [] : [Number(_mailChar)]));
/** The character a per-mailbox call should use. Falls back to the first account. */
const _mailOneId   = () => (_mailIsAll()
  ? Number(_mailAccounts[0]?.characterId)
  : Number(_mailChar));
const _mailCharName = (id) => {
  const a = _mailAccounts.find(x => String(x.characterId) === String(id));
  return a ? a.characterName : `ID ${id}`;
};

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
  // Notifications are per-character with no combined endpoint, so the feed shows
  // one character even when the mailbox is set to All.
  if (tab === 'notifications') Promise.resolve(initNotifications(_mailOneId())).catch(() => {});
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
  _mailAccounts = accounts;
  // Keep whatever is open this session; otherwise restore the mailbox chosen last
  // session, and failing that open the combined view — with more than one
  // character, "all my mail" is the reading view you actually want. A
  // single-character roster has no combined option and opens on that character.
  if (_mailChar == null) {
    const saved = _mailLoadBox();
    if (saved) _mailChar = saved === MAIL_ALL ? MAIL_ALL : Number(saved);
  }
  const usable = _mailIsAll()
    ? accounts.length > 1
    : accounts.some(a => String(a.characterId) === String(_mailChar));
  if (!usable) _mailChar = accounts.length > 1 ? MAIL_ALL : Number(accounts[0].characterId);
  _mailRenderCharPicker(accounts);
  await _mailReload();
}

function _mailRenderCharPicker(accounts) {
  const sel = document.getElementById('mailCharSelect');
  if (!sel) return;
  // "All characters" first — it is the default reading view for a multi-character
  // roster, and only offered when there is more than one mailbox to combine.
  sel.innerHTML = (accounts.length > 1 ? `<option value="${MAIL_ALL}">All characters</option>` : '')
    + accounts.map(a => `<option value="${a.characterId}">${escHtml(a.characterName)}</option>`).join('');
  sel.value = String(_mailChar);
  sel.onchange = async () => {
    _mailChar = sel.value === MAIL_ALL ? MAIL_ALL : Number(sel.value);
    _mailSaveBox(sel.value);
    _mailLabelId = 1;
    // Reload whichever tab is showing — switching character shouldn't bounce
    // the user back to the mailbox while they're reading notifications.
    if (_mailTab === 'notifications') await initNotifications(_mailOneId());
    else await _mailReload();
  };
}

// Full reload for the current character: labels + mailing lists + first page.
async function _mailReload() {
  _mailHeaders = [];
  _mailOpenId = null;
  _mailExhausted = false;
  _mailPageState = {};
  _mailRenderReader(null);
  _mailSetStatus('Loading mail…');

  const ids = _mailBoxIds();
  if (!ids.length) { _mailSetStatus('No character selected.'); return; }

  // One round per mailbox, in parallel. In combined mode the unread counts are
  // SUMMED per folder so the Inbox badge is the roster's total, which is the
  // number that actually matters when you are reading everything at once.
  const perChar = await Promise.all(ids.map(async id => ({
    id,
    labels: await window.eveAPI.mailGetLabels(id).catch(e => ({ ok: false, error: e.message })),
    lists:  await window.eveAPI.mailGetLists(id).catch(() => ({ ok: false })),
  })));

  const usable = perChar.filter(p => p.labels.ok);
  if (!usable.length) { _mailShowError(perChar[0].labels); return; }

  // Mailing lists are valid senders — seed the name cache so they resolve. In
  // combined mode this is the union across characters, deduped by id.
  const listById = new Map();
  for (const p of perChar) {
    if (!p.lists.ok) continue;
    for (const l of (p.lists.lists || [])) listById.set(l.id, l);
  }
  _mailLists = [...listById.values()];
  _mailLists.forEach(l => { _mailNames[l.id] = l.name; });

  // Merge ESI's labels over the known system ones so Inbox/Sent/Corp/Alliance
  // keep their familiar names and order, with custom labels after.
  const byId = new Map();
  MAIL_SYSTEM_LABELS.forEach(l => byId.set(l.labelId, { ...l, unreadCount: 0 }));
  for (const p of usable) {
    for (const l of (p.labels.labels || [])) {
      const known = byId.get(l.labelId);
      byId.set(l.labelId, {
        labelId: l.labelId,
        name: known ? known.name : l.name,
        unreadCount: (known?.unreadCount || 0) + (l.unreadCount || 0),
      });
    }
  }
  _mailLabels = [...byId.values()];

  _mailRenderLabels();
  // The nav badge is roster-wide. In combined mode the labels just fetched
  // already cover every character; reading one mailbox says nothing about the
  // others, so that case re-polls instead of reporting a partial total.
  if (_mailIsAll() || _mailAccounts.length === 1) {
    _mailSetNavUnread(usable.reduce((n, p) => n + (p.labels.totalUnread || 0), 0));
  } else {
    _mailPollUnread().catch(() => {});
  }

  // A character whose mail could not be read should not silently vanish from a
  // combined view — say which, and carry on with the rest.
  const failed = perChar.filter(p => !p.labels.ok);
  if (failed.length && usable.length) {
    console.warn('[mail] skipped mailboxes:', failed.map(p => _mailCharName(p.id)).join(', '));
  }

  await _mailLoadPage(true);
}

async function _mailLoadPage(reset = false) {
  if (_mailBusy) return;
  _mailBusy = true;
  if (reset) { _mailHeaders = []; _mailExhausted = false; _mailPageState = {}; }
  _mailSetStatus(reset ? 'Loading mail…' : 'Loading older mail…');

  const ids = _mailBoxIds();

  // Each mailbox pages independently — ESI's lastMailId cursor is per character,
  // and mail ids from different characters are not comparable — so paging state
  // is tracked per mailbox and only the ones with more to give are asked again.
  const results = await Promise.all(ids.map(async id => {
    const st = _mailPageState[id] || (_mailPageState[id] = { lastMailId: null, exhausted: false });
    if (st.exhausted && !reset) return { id, skipped: true };
    const res = await window.eveAPI
      .mailGetHeaders(id, { labelId: _mailLabelId, lastMailId: reset ? null : st.lastMailId })
      .catch(e => ({ ok: false, error: e.message }));
    return { id, res };
  }));

  _mailBusy = false;

  const answered = results.filter(r => !r.skipped);
  if (answered.length && answered.every(r => !r.res.ok)) { _mailShowError(answered[0].res); return; }

  const seen = new Set(_mailHeaders.map(m => `${m._charId}:${m.mailId}`));
  for (const { id, res, skipped } of results) {
    if (skipped) continue;
    const st = _mailPageState[id];
    if (!res.ok) { st.exhausted = true; continue; }   // stop asking a failing mailbox

    // ESI returns at most 50 per call — fewer means we've reached the end.
    if (!res.mails.length || res.mails.length < 50) st.exhausted = true;
    if (res.mails.length) st.lastMailId = Math.min(...res.mails.map(m => m.mailId));

    for (const m of res.mails) {
      // Tag every header with the mailbox it came from. Everything downstream —
      // opening, marking read, deleting, replying — routes on this.
      const key = `${id}:${m.mailId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      _mailHeaders.push({ ...m, _charId: id, _charName: _mailCharName(id) });
    }
  }
  _mailHeaders.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  _mailExhausted = ids.every(id => _mailPageState[id]?.exhausted);

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
  const showBox = _mailIsAll();
  host.innerHTML = _mailHeaders.map(m => `
    <button class="mail-row${m.isRead ? '' : ' unread'}${m.mailId === _mailOpenId ? ' active' : ''}"
            data-id="${m.mailId}" data-char="${m._charId}">
      <div class="mail-row-top">
        <span class="mail-row-from">${escHtml(_mailName(m.from))}</span>
        <span class="mail-row-date">${_mailFmtDate(m.timestamp)}</span>
      </div>
      <div class="mail-row-subject">${escHtml(m.subject)}</div>
      ${showBox ? `<div class="mail-row-box" title="Received by ${escHtml(m._charName || '')}">${escHtml(m._charName || '')}</div>` : ''}
    </button>`).join('')
    + (_mailExhausted ? '' : '<button class="mail-more-btn" id="mailMoreBtn">Load older mail</button>');

  host.querySelectorAll('.mail-row').forEach(row => {
    row.onclick = () => _mailOpen(Number(row.dataset.id), Number(row.dataset.char));
  });
  const more = document.getElementById('mailMoreBtn');
  if (more) more.onclick = () => _mailLoadPage(false);
}

// charId identifies the mailbox the mail lives in. It is required in combined
// mode and defaults to the single open mailbox otherwise; two characters can hold
// mails with the same id, so the pair is what identifies a message.
async function _mailOpen(mailId, charId) {
  const boxId = Number(charId) || _mailOneId();
  _mailOpenId = mailId;
  _mailRenderList();
  _mailRenderReader(null, 'Loading…');

  const res = await window.eveAPI.mailGetBody(boxId, mailId).catch(e => ({ ok: false, error: e.message }));
  if (!res.ok) { _mailRenderReader(null, res.error || 'Could not load this mail.'); return; }

  await _mailResolveNames([res.mail.from, ...res.mail.recipients.map(r => r.id)]);
  _mailRenderReader({ ...res.mail, _charId: boxId, _charName: _mailCharName(boxId) });

  // Mark read in the background; reflect it locally so the list updates at once.
  const header = _mailHeaders.find(m => m.mailId === mailId && String(m._charId) === String(boxId));
  if (header && !header.isRead) {
    header.isRead = true;
    const lbl = _mailLabels.find(l => l.labelId === _mailLabelId);
    if (lbl && lbl.unreadCount > 0) lbl.unreadCount--;
    _mailBumpNavUnread(-1);
    _mailRenderList();
    _mailRenderLabels();
    window.eveAPI.mailUpdate(boxId, mailId, { read: true }).catch(() => {});
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
      ${mail._charName ? `<span><span class="mail-meta-label">Mailbox</span> ${escHtml(mail._charName)}</span>` : ''}
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

  const boxId = Number(mail._charId) || _mailOneId();

  // Replying defaults to the character that RECEIVED it — replying as someone
  // else is almost never what you meant, and the From picker can still change it.
  document.getElementById('mailReplyBtn').onclick = () => _mailCompose({
    from: boxId,
    recipients: [{ id: mail.from, type: 'character', name: _mailName(mail.from) }],
    subject: /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`,
  });
  document.getElementById('mailUnreadBtn').onclick = async () => {
    const r = await window.eveAPI.mailUpdate(boxId, mail.mailId, { read: false }).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) { showToast(r.error || 'Could not mark unread.', 'error'); return; }
    const h = _mailHeaders.find(m => m.mailId === mail.mailId && String(m._charId) === String(boxId));
    if (h && h.isRead) { h.isRead = false; _mailBumpNavUnread(1); }
    _mailRenderList();
    showToast('Marked unread.', 'success');
  };
  document.getElementById('mailDeleteBtn').onclick = () => _mailDelete(mail.mailId, boxId);
}

async function _mailDelete(mailId, charId) {
  const boxId = Number(charId) || _mailOneId();
  if (!confirm('Delete this mail? This also removes it in-game and cannot be undone.')) return;
  const r = await window.eveAPI.mailDelete(boxId, mailId).catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) { showToast(r.error || 'Could not delete this mail.', 'error'); return; }
  // Drop only this character's copy — the same mail id can exist in another
  // mailbox, and deleting there is a separate action.
  const gone = _mailHeaders.find(m => m.mailId === mailId && String(m._charId) === String(boxId));
  if (gone && !gone.isRead) _mailBumpNavUnread(-1);
  _mailHeaders = _mailHeaders.filter(m => !(m.mailId === mailId && String(m._charId) === String(boxId)));
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

  // From: a reply passes the character that received it; a fresh compose uses the
  // open mailbox, and in combined mode falls back to the first account rather
  // than leaving it ambiguous.
  const from = document.getElementById('mailComposeFrom');
  if (from) {
    from.innerHTML = _mailAccounts
      .map(a => `<option value="${a.characterId}">${escHtml(a.characterName)}</option>`)
      .join('');
    const want = prefill.from != null ? String(prefill.from)
               : (_mailIsAll() ? String(_mailOneId()) : String(_mailChar));
    if (from.querySelector(`option[value="${want}"]`)) from.value = want;
  }

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
    Esi.url('/universe/ids'),
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

  // Send as whoever the From picker names, NOT the mailbox being read — in the
  // combined view there is no single "current" character to fall back on.
  const fromSel = document.getElementById('mailComposeFrom');
  const sender  = Number(fromSel?.value) || _mailOneId();
  if (!sender) { showToast('Pick which character sends this mail.', 'error'); return; }

  const btn = document.getElementById('mailComposeSendBtn');
  btn.disabled = true; btn.textContent = 'Sending…';
  const res = await window.eveAPI.mailSend(sender, {
    recipients: _mailComposeTo.map(r => ({ id: r.id, type: r.type })), subject, body,
  }).catch(e => ({ ok: false, error: e.message }));
  btn.disabled = false; btn.textContent = 'Send';

  if (!res.ok) { showToast(res.error || 'Could not send mail.', 'error'); return; }
  showToast(`Mail sent from ${_mailCharName(sender)}.`, 'success');
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

// ─── Nav unread badge ────────────────────────────────────────────────────────
// The badge counts the WHOLE roster, not the open mailbox — on a nav button it
// answers "is there mail waiting for me anywhere", which is the question the
// combined mailbox is built around. It is watched from app start (see
// startMailUnreadWatch) so it is already right the first time you look at it.
const MAIL_UNREAD_KEY = 'mailNavUnread';
let _mailNavUnread = 0;

function _mailSetNavUnread(n) {
  _mailNavUnread = Math.max(0, Number(n) || 0);
  try { localStorage.setItem(MAIL_UNREAD_KEY, String(_mailNavUnread)); } catch (_) { /* private mode */ }
  _mailPaintNavUnread();
}

// Local adjustment for a read/unread/delete the user just performed, so the
// badge moves with the click instead of waiting for the next poll.
function _mailBumpNavUnread(delta) { _mailSetNavUnread(_mailNavUnread + delta); }

function _mailPaintNavUnread() {
  const el = document.getElementById('mailNavUnread');
  if (!el) return;
  el.textContent = _mailNavUnread > 0 ? String(_mailNavUnread) : '';
  el.className = _mailNavUnread > 0 ? 'nav-status mail-nav-unread' : 'nav-status';
}

// One poll of every character's label totals. ESI caches this endpoint for 30s,
// so polling faster only re-reads the same body.
const MAIL_UNREAD_POLL_MS = 30_000;
// A character authenticated before the mail scopes existed answers 403 forever,
// and every 403 spends the shared ESI error budget (see esi.js). Such a mailbox
// is dropped from the poll and only re-probed occasionally, so re-authenticating
// it still heals without a restart.
const MAIL_NOSCOPE_RETRY_MS = 10 * 60_000;
// Nobody can see the badge when the window is not in front, so polling at full
// cadence buys nothing and costs the most: this watcher runs from launch, on
// every page, for every character. Becoming visible polls at once, so the count
// is never stale by the time it can be read.
const MAIL_IDLE_POLL_MS = 5 * 60_000;
// Spread the per-character requests across a fraction of the poll window rather
// than firing them together. `Promise.all` over 20 characters was 20 requests in
// one tick — the largest single burst the app makes, and concurrency is not
// rate: the broker's lane limit bounds how many are in flight, not how many
// start per second.
const MAIL_STAGGER_FRACTION = 0.6;   // leave the rest of the window as headroom
const MAIL_STAGGER_MAX_MS   = 1500;  // a small mailbox count should not crawl
let _mailUnreadTimer  = null;
let _mailPollEveryMs  = MAIL_UNREAD_POLL_MS;
let _mailPollBusy     = false;       // a staggered walk can outlive its own tick
const _mailNoScope = new Map();   // charId → when it last refused

/** Gap between per-character requests so a poll fits inside its own window. */
function _mailStaggerGap(n, windowMs) {
  if (!(n > 1)) return 0;
  return Math.min(MAIL_STAGGER_MAX_MS,
    Math.max(0, Math.floor((windowMs || MAIL_UNREAD_POLL_MS) * MAIL_STAGGER_FRACTION / n)));
}

/** Is the window actually in front of someone? */
function _mailWindowActive() {
  try {
    if (typeof document === 'undefined') return true;
    if (document.visibilityState && document.visibilityState !== 'visible') return false;
    return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  } catch (_) { return true; }   // never let a missing API stop the badge working
}

const _mailSleep = (ms) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/** Swap cadence and re-arm, so the change takes effect on the running timer. */
function _mailSetCadence(ms) {
  if (ms === _mailPollEveryMs) return;
  _mailPollEveryMs = ms;
  if (_mailUnreadTimer) {
    clearInterval(_mailUnreadTimer);
    _mailUnreadTimer = setInterval(() => { _mailPollUnread().catch(() => {}); }, ms);
  }
}

async function _mailPollUnread() {
  // A staggered walk takes most of the window; without this a slow one would be
  // overlapped by the next tick and the burst would be back.
  if (_mailPollBusy) return;
  _mailPollBusy = true;
  try {
    await _mailPollUnreadInner();
  } finally {
    _mailPollBusy = false;
  }
}

async function _mailPollUnreadInner() {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(accounts) || !accounts.length) { _mailSetNavUnread(0); return; }

  const now = Date.now();
  const ask = accounts.filter(a => {
    const refusedAt = _mailNoScope.get(Number(a.characterId));
    return refusedAt === undefined || (now - refusedAt) > MAIL_NOSCOPE_RETRY_MS;
  });
  if (!ask.length) return;

  // Sequential with a gap, not Promise.all: the point is requests per second,
  // and 20 at once is 20 in one second however few are in flight at a time.
  const gap = _mailStaggerGap(ask.length, _mailPollEveryMs);
  const results = [];
  for (let i = 0; i < ask.length; i++) {
    if (i) await _mailSleep(gap);
    // The watcher can be stopped, or the window hidden, part-way through a walk
    // that takes most of the window. Finish early rather than spending requests
    // on a badge nobody is looking at.
    if (!_mailUnreadTimer) break;
    const id = Number(ask[i].characterId);
    const r = await window.eveAPI.mailGetLabels(id).catch(() => ({ ok: false }));
    if (r && r.ok) _mailNoScope.delete(id);
    else if (r && r.needsReauth) _mailNoScope.set(id, Date.now());
    results.push(r);
  }

  const usable = results.filter(r => r && r.ok);
  // A blip must not blank a count that was right a moment ago — only publish a
  // total when at least one mailbox answered.
  if (!usable.length) return;
  _mailSetNavUnread(usable.reduce((n, r) => n + (r.totalUnread || 0), 0));
}

// Started from app.js at launch: the badge must be right before the Mail page
// has ever been opened. Paints the last known count first so it appears at once,
// then corrects it from ESI.
function startMailUnreadWatch() {
  if (_mailUnreadTimer) return;   // one watcher per window
  try { _mailNavUnread = Math.max(0, Number(localStorage.getItem(MAIL_UNREAD_KEY)) || 0); } catch (_) { /* ignore */ }
  _mailPaintNavUnread();
  _mailPollEveryMs = _mailWindowActive() ? MAIL_UNREAD_POLL_MS : MAIL_IDLE_POLL_MS;
  _mailPollUnread().catch(() => {});
  _mailUnreadTimer = setInterval(() => { _mailPollUnread().catch(() => {}); }, _mailPollEveryMs);

  // Poll at once on coming back, so the badge is right by the time it can be
  // read — that is what makes backing off while hidden free rather than stale.
  const onActive = () => {
    _mailSetCadence(MAIL_UNREAD_POLL_MS);
    _mailPollUnread().catch(() => {});
  };
  const onIdle = () => _mailSetCadence(MAIL_IDLE_POLL_MS);
  try {
    document.addEventListener('visibilitychange', () => (_mailWindowActive() ? onActive() : onIdle()));
    window.addEventListener('focus', onActive);
    window.addEventListener('blur',  onIdle);
  } catch (_) { /* no DOM (tests) — the interval alone is enough */ }
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
  if (refresh) refresh.onclick = () => (_mailTab === 'notifications' ? initNotifications(_mailOneId()) : _mailReload());
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
