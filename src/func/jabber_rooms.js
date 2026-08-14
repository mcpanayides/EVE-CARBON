// ─── Jabber chat rooms (MUC) ──────────────────────────────────────────────────
// The rail on the Jabber page: Broadcasts (the existing ping feed) plus every
// chat room the user has added. Rooms are joined by the main process on connect
// (src/jabber_ipc.js); this file is the view — list, badges, history, composer.
//
// The unread badge counts SPEAKERS, not messages: "how many people have spoken
// since you last looked" is the question a room badge should answer, and a single
// person posting forty lines is not forty things to catch up on. The message
// count rides along in the tooltip for when the distinction matters.
//
// Read state lives in the database (jabber_room_reads), not in this file, so it
// survives a restart and cannot drift between the rail and the room view.

const JR_PINGS = '__pings__';          // the Broadcasts pseudo-room

let _jrRooms      = [];                // [{ jid, name, nick, joined, unread }]
let _jrActive     = JR_PINGS;          // which rail entry is selected
let _jrBound      = false;             // one-time listener guard
let _jrLoadToken  = 0;                 // guards against out-of-order room loads
const _jrPulled   = new Set();         // rooms whose archive has been auto-pulled this session
const _jrComplete = new Set();         // rooms the SERVER said it has no more of
const _jrNoArchive = new Set();        // rooms whose auto-pull failed — see _jrLoadOlder

const _jrEsc = (s) => (typeof escHtml === 'function' ? escHtml(s) : String(s ?? ''));

// Feedback for a deliberate click. showToast() only writes a line to the
// status-bar log at the bottom of the window — fine as a record, invisible as an
// answer — so anything the user pressed a button for also gets a corner toast.
function _jrNotify(body, kind = 'info', title = 'Chat rooms') {
  if (typeof showToast === 'function') showToast(body, kind === 'error' ? 'error' : 'info');
  if (typeof pushAppToast === 'function') pushAppToast({ title, body, kind, timeout: 6000 });
}

// ─── Rail ─────────────────────────────────────────────────────────────────────
async function jabberRefreshRooms() {
  const host = document.getElementById('jabberRoomList');
  if (!host) return;

  try {
    _jrRooms = await window.eveAPI.jabberListRooms() || [];
  } catch (e) {
    console.warn('[jabber rooms] list failed:', e?.message || e);
    _jrRooms = [];
  }

  host.innerHTML = '';
  for (const room of _jrRooms) {
    const btn = document.createElement('button');
    btn.className = 'jabber-room-btn' + (_jrActive === room.jid ? ' active' : '');
    btn.dataset.room = room.jid;
    btn.title = room.jid + (room.joined ? '' : ' — not joined yet');

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined jabber-room-icon';
    icon.textContent = room.joined ? 'forum' : 'cloud_off';

    const name = document.createElement('span');
    name.className = 'jabber-room-name';
    name.textContent = room.name || room.jid;

    btn.append(icon, name);

    // No badge on the room you are looking at — it is read by definition.
    const speakers = room.unread?.speakers || 0;
    if (speakers > 0 && _jrActive !== room.jid) {
      const badge = document.createElement('span');
      badge.className = 'jabber-room-badge';
      badge.textContent = String(speakers);
      const msgs = room.unread?.messages || 0;
      badge.title = `${speakers} ${speakers === 1 ? 'person has' : 'people have'} spoken · ${msgs} message${msgs === 1 ? '' : 's'}`;
      btn.appendChild(badge);
    }

    btn.addEventListener('click', () => jabberOpenRoom(room.jid));
    host.appendChild(btn);
  }

  const hint = document.getElementById('jabberRoomHint');
  if (hint) {
    hint.textContent = _jrRooms.length ? '' : 'No rooms yet — add one to start chatting.';
  }
  _jrPaintActive();
}

function _jrPaintActive() {
  document.querySelectorAll('#page-jabber .jabber-room-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.room === _jrActive);
  });
  const pings = document.getElementById('jabberPingsPane');
  const room  = document.getElementById('jabberRoomPane');
  const isPings = _jrActive === JR_PINGS;
  if (pings) pings.style.display = isPings ? '' : 'none';
  if (room)  room.style.display  = isPings ? 'none' : '';
}

// ─── Room view ────────────────────────────────────────────────────────────────
async function jabberOpenRoom(jid) {
  _jrActive = jid;
  _jrPaintActive();
  if (jid === JR_PINGS) { jabberRefreshRooms(); return; }

  const room = _jrRooms.find(r => r.jid === jid);
  const title = document.getElementById('jabberRoomTitle');
  const jidEl = document.getElementById('jabberRoomJid');
  const log   = document.getElementById('jabberRoomLog');
  if (title) title.textContent = room?.name || jid;
  if (jidEl) jidEl.textContent = jid;
  const olderBtn = document.getElementById('jabberLoadOlderBtn');
  if (olderBtn) {
    const done = _jrComplete.has(jid);
    olderBtn.disabled = done;
    olderBtn.textContent = done ? 'No archive' : 'Load older';
  }
  if (log)   log.innerHTML = '<div class="jabber-room-empty">Loading…</div>';

  // Switching rooms quickly must not let an earlier fetch paint over a later one.
  const token = ++_jrLoadToken;
  let messages = [];
  try { messages = await window.eveAPI.jabberRoomMessages(jid, 200) || []; }
  catch (e) { console.warn('[jabber rooms] history failed:', e?.message || e); }
  if (token !== _jrLoadToken) return;

  _jrRenderLog(messages);

  // Opening the room is what marks it read — then refresh the rail so the badge
  // clears in the same frame the user sees the messages.
  try { await window.eveAPI.jabberMarkRoomRead(jid); } catch (_) { }
  jabberRefreshRooms();

  // A join only ever yields a few lines of MUC history, so the first time a room
  // is opened its archive is pulled in the background. Once per session — after
  // that "Load older" is the deliberate way to go further back.
  if (!_jrPulled.has(jid) && room?.joined) {
    _jrPulled.add(jid);
    _jrLoadOlder(jid, { silent: true });
  }

  // Subject and roster are push-only; read the current state or the room shows
  // nothing until the next change, which in a quiet room could be hours.
  try {
    const state = await window.eveAPI.jabberRoomState(jid);
    if (token === _jrLoadToken) {
      _jrRenderSubject(state?.subject);
      _jrRenderRoster(state?.occupants);
    }
  } catch (e) {
    console.warn('[jabber rooms] state failed:', e?.message || e);
  }

  const input = document.getElementById('jabberRoomInput');
  if (input) { input.disabled = !room?.joined; input.focus(); }
  const send = document.getElementById('jabberRoomSend');
  if (send) send.disabled = !room?.joined;
  document.querySelectorAll('#page-jabber .jabber-fmt-btn')
    .forEach(b => { b.disabled = !room?.joined; });
}

function _jrRenderLog(messages) {
  const log = document.getElementById('jabberRoomLog');
  if (!log) return;
  if (!messages.length) {
    log.innerHTML = '<div class="jabber-room-empty">No messages yet.</div>';
    return;
  }
  log.innerHTML = '';
  let lastNick = null;
  for (const m of messages) {
    log.appendChild(_jrRowEl(m, m.sender_nick === lastNick));
    lastNick = m.sender_nick;
  }
  log.scrollTop = log.scrollHeight;
}

// One message row. Consecutive lines from the same speaker drop the name, the
// way every chat client does it — the room reads as conversation, not a log.
function _jrRowEl(m, sameSpeaker) {
  const row = document.createElement('div');
  row.className = 'jabber-msg' + (sameSpeaker ? ' jabber-msg--cont' : '');

  if (!sameSpeaker) {
    const who = document.createElement('span');
    who.className = 'jabber-msg-who';
    who.textContent = m.sender_nick || 'unknown';
    row.appendChild(who);
  }

  const body = document.createElement('span');
  body.className = 'jabber-msg-body';
  body.appendChild(_jrLinkify(m.raw_body || m.body || ''));
  row.appendChild(body);

  const time = document.createElement('span');
  time.className = 'jabber-msg-time';
  time.textContent = _jrTime(m.received_at);
  time.title = m.received_at || '';
  row.appendChild(time);
  return row;
}

function _jrTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Subject (MOTD) and occupants ─────────────────────────────────────────────
// Both are pushed by the server, so the view reads the current state once when a
// room opens and then follows the pushes.

function _jrRenderSubject(subject) {
  const el = document.getElementById('jabberRoomSubject');
  if (!el) return;
  const text = (subject?.text || '').trim();
  if (!text) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = '';
  // The MOTD is server text with URLs in it (buyback threads, recruitment posts),
  // and it is the one part of a room that is meant to be acted on. Built as DOM
  // with links made real, never as innerHTML.
  el.appendChild(_jrLinkify(text));
}

const _JR_ROLE_ICON = {
  owner:  'shield_person',      // room owner
  admin:  'shield',             // admin
  member: 'star',               // affiliated member
  none:   'radio_button_checked',
};

function _jrRenderRoster(occupants) {
  const list  = document.getElementById('jabberRosterList');
  const count = document.getElementById('jabberRosterCount');
  if (!list || !count) return;

  const people = Array.isArray(occupants) ? occupants : [];
  count.textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'} in room`;

  list.innerHTML = '';
  for (const p of people) {
    const row = document.createElement('div');
    row.className = `jabber-occupant jabber-occupant--${p.affiliation || 'none'}`;
    row.title = `${p.nick} · ${p.affiliation || 'none'} · ${p.role || 'participant'}`;

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined jabber-occupant-icon';
    icon.textContent = _JR_ROLE_ICON[p.affiliation] || _JR_ROLE_ICON.none;

    const nick = document.createElement('span');
    nick.className = 'jabber-occupant-nick';
    nick.textContent = p.nick;

    row.append(icon, nick);
    // Clicking a name addresses them, the way every chat client does.
    row.addEventListener('click', () => {
      const input = document.getElementById('jabberRoomInput');
      if (!input || input.disabled) return;
      input.value = input.value ? `${input.value} ${p.nick}` : `${p.nick}: `;
      input.focus();
    });
    list.appendChild(row);
  }
}

// Plain text with its URLs turned into real links. Returns a fragment, so the
// caller never has to build markup out of message text.
function _jrLinkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const url = m[0].replace(/[.,)]+$/, '');     // trailing punctuation is prose, not URL
    const a = document.createElement('a');
    a.className = 'jabber-link';
    a.textContent = url;
    a.href = '#';
    a.title = url;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      try { window.eveAPI.openExternalUrl(url); } catch (_) {}
    });
    frag.appendChild(a);
    last = m.index + url.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

// ─── History ──────────────────────────────────────────────────────────────────
// Walks the room's server-side archive backwards.
//
// Two states have to stay apart, and conflating them is what broke this button:
//   _jrComplete  — the SERVER said there is nothing older. Clicking again is
//                  pointless, so the click is answered from here.
//   _jrNoArchive — the automatic pull FAILED (not connected yet, server refused,
//                  MAM unsupported). That is a reason not to keep retrying by
//                  itself; it is never a reason to refuse an explicit click.
// A failure used to set _jrComplete, so one silent failure on open — being
// offline at the time is enough — permanently disabled the button for that room
// and answered every later click with "No older messages on the server", which
// was both inert and untrue.
async function _jrLoadOlder(jid, { silent = false } = {}) {
  const btn = document.getElementById('jabberLoadOlderBtn');
  const room = jid || _jrActive;
  if (!room || room === JR_PINGS) return;

  // The one case where not querying is the right answer.
  if (_jrComplete.has(room)) {
    if (!silent) _jrNotify('No older messages on the server.');
    return;
  }
  // Auto-pulls stand down after a failure; a click always tries again.
  if (silent && _jrNoArchive.has(room)) return;

  if (typeof window.eveAPI?.jabberLoadRoomHistory !== 'function') {
    if (!silent) _jrNotify('History loading is unavailable — restart the app.', 'error');
    return;
  }

  if (btn && !silent) { btn.disabled = true; btn.textContent = 'Loading…'; }

  const r = await window.eveAPI.jabberLoadRoomHistory(room, 100)
    .catch(e => ({ ok: false, error: e?.message || String(e) }));

  if (btn && !silent) { btn.disabled = false; btn.textContent = 'Load older'; }

  if (!r?.ok) {
    // A click always says what went wrong. Silence here is what made this look
    // like a dead button rather than a server that would not answer.
    if (!silent) _jrNotify(r?.error || 'Could not load history.', 'error');
    else console.info('[jabber rooms] archive unavailable for', room, '—', r?.error);
    _jrNoArchive.add(room);
    // The room told us it keeps no archive. That is settled, not a failure to
    // retry — mark it complete and label the button honestly.
    if (r?.noArchive) {
      _jrComplete.add(room);
      if (btn && _jrActive === room) {
        btn.disabled = true;
        btn.textContent = 'No archive';
        btn.title = 'This room does not keep history on the server.';
      }
    }
    return;
  }
  _jrNoArchive.delete(room);        // it answered; auto-pull may try again later
  if (r.complete) _jrComplete.add(room);

  // Nothing new is not worth a repaint — and repainting would jump the reader
  // back to the bottom of a log they were scrolled into.
  if (!r.added) {
    if (!silent) _jrNotify('No older messages on the server.');
    return;
  }

  if (_jrActive === room) {
    const log = document.getElementById('jabberRoomLog');
    // Hold the reader's place: keep the distance from the BOTTOM constant so
    // prepending older messages does not move what they are reading.
    const fromBottom = log ? (log.scrollHeight - log.scrollTop) : 0;
    const messages = await window.eveAPI.jabberRoomMessages(room, 500).catch(() => []);
    _jrRenderLog(messages);
    if (log) log.scrollTop = log.scrollHeight - fromBottom;
  }
  if (!silent) _jrNotify(`Loaded ${r.added} older message${r.added === 1 ? '' : 's'}.`, 'success');
}

// ─── Sending ──────────────────────────────────────────────────────────────────
// Only ever from this handler: a real submit on a room the user has open.
async function _jrSend(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('jabberRoomInput');
  const text  = (input?.value || '').trim();
  if (!text || _jrActive === JR_PINGS) return;

  input.value = '';
  input.disabled = true;
  try {
    const r = await window.eveAPI.jabberSendRoom(_jrActive, text);
    if (!r?.ok) {
      if (typeof showToast === 'function') showToast(r?.error || 'Could not send.', 'error');
      input.value = text;   // hand the text back rather than losing it
    }
    // The sent message comes back from the server as a groupchat echo and is
    // appended by the live listener, so nothing is drawn optimistically here —
    // what you see in the log is what the room actually received.
  } finally {
    input.disabled = false;
    input.focus();
  }
}

// ─── Find rooms (XEP-0030 service discovery) ──────────────────────────────────
// Two steps, the same shape as Pidgin's: ask which conference server, then show
// what it has. Adding a room by typing its exact address assumes you already know
// it; this is for when you don't.

let _jrDiscovered = [];   // last room list returned, unfiltered

async function _jrFindRooms() {
  const backdrop = document.createElement('div');
  backdrop.className = 'jabber-room-modal-backdrop';
  backdrop.innerHTML = `
    <div class="jabber-room-modal jabber-roomlist-modal">
      <div class="jabber-room-modal-head">
        <div class="jabber-room-modal-title">Find rooms</div>
        <button class="jabber-room-modal-close" type="button" title="Close">&#x2715;</button>
      </div>

      <label class="jabber-room-modal-label" for="jrDiscoHost">Conference server</label>
      <div class="jabber-disco-row">
        <input id="jrDiscoHost" class="field-input jabber-room-modal-input" type="text"
               placeholder="conference.example.com" autocomplete="off" />
        <button id="jrDiscoGo" class="jabber-room-modal-add" type="button">Get list</button>
      </div>
      <div id="jrDiscoStatus" class="jabber-room-modal-hint">
        Rooms are listed by the server. Double-click one to join it.
      </div>

      <input id="jrDiscoFilter" class="field-input jabber-room-modal-input jabber-disco-filter"
             type="text" placeholder="Filter rooms…" autocomplete="off" style="display:none;" />
      <div id="jrDiscoList" class="jabber-disco-list"></div>

      <div class="jabber-room-modal-actions">
        <button class="jabber-room-modal-cancel" type="button">Close</button>
        <button id="jrDiscoJoin" class="jabber-room-modal-add" type="button" disabled>Join room</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const hostInput = backdrop.querySelector('#jrDiscoHost');
  const filterEl  = backdrop.querySelector('#jrDiscoFilter');
  const listEl    = backdrop.querySelector('#jrDiscoList');
  const statusEl  = backdrop.querySelector('#jrDiscoStatus');
  const goBtn     = backdrop.querySelector('#jrDiscoGo');
  const joinBtn   = backdrop.querySelector('#jrDiscoJoin');
  const close     = () => backdrop.remove();

  let selected = null;

  // Offer the account's own conference host. Only a starting point — the field
  // stays editable for servers that use muc. or chat. instead.
  try {
    const suggested = await window.eveAPI.jabberDefaultConference();
    if (suggested) hostInput.value = suggested;
  } catch (_) { /* leave it blank */ }

  const setStatus = (text, tone) => {
    statusEl.textContent = text;
    statusEl.classList.toggle('jabber-disco-error', tone === 'error');
  };

  const paint = () => {
    const q = filterEl.value.trim().toLowerCase();
    const rows = q
      ? _jrDiscovered.filter(r => r.name.toLowerCase().includes(q)
                               || r.description.toLowerCase().includes(q))
      : _jrDiscovered;

    listEl.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'jabber-disco-empty';
      empty.textContent = _jrDiscovered.length ? 'No rooms match that filter.' : '';
      listEl.appendChild(empty);
      return;
    }

    // A header row, because two unlabelled columns of near-identical strings is
    // exactly the confusion the server's own naming already creates.
    const head = document.createElement('div');
    head.className = 'jabber-disco-row-head';
    head.innerHTML = '<span>Name</span><span>Description</span>';
    listEl.appendChild(head);

    for (const room of rows) {
      const row = document.createElement('div');
      row.className = 'jabber-disco-item' + (selected === room.jid ? ' selected' : '');
      row.dataset.jid = room.jid;
      row.title = room.jid;

      const name = document.createElement('span');
      name.className = 'jabber-disco-name';
      name.textContent = room.name;
      const desc = document.createElement('span');
      desc.className = 'jabber-disco-desc';
      desc.textContent = room.description;
      row.append(name, desc);

      row.addEventListener('click', () => {
        selected = room.jid;
        joinBtn.disabled = false;
        listEl.querySelectorAll('.jabber-disco-item')
          .forEach(el => el.classList.toggle('selected', el.dataset.jid === selected));
      });
      row.addEventListener('dblclick', () => join(room));
      listEl.appendChild(row);
    }
  };

  const join = async (room) => {
    joinBtn.disabled = true;
    const r = await window.eveAPI.jabberAddRoom({ jid: room.jid, name: room.description || room.name })
      .catch(e => ({ ok: false, error: e.message }));
    if (!r?.ok) {
      joinBtn.disabled = false;
      if (typeof showToast === 'function') showToast(r?.error || 'Could not join that room.', 'error');
      return;
    }
    close();
    if (typeof showToast === 'function') showToast(`Joined ${room.description || room.name}.`, 'success');
    await jabberRefreshRooms();
  };

  const query = async () => {
    const host = hostInput.value.trim();
    if (!host) { hostInput.focus(); return; }
    goBtn.disabled = true;
    selected = null;
    joinBtn.disabled = true;
    setStatus(`Asking ${host} for its rooms…`);
    listEl.innerHTML = '';

    const r = await window.eveAPI.jabberDiscoverRooms(host)
      .catch(e => ({ ok: false, error: e.message }));
    goBtn.disabled = false;

    if (!r?.ok) {
      _jrDiscovered = [];
      filterEl.style.display = 'none';
      setStatus(r?.error || 'Could not read that server.', 'error');
      return;
    }
    _jrDiscovered = r.rooms || [];
    filterEl.style.display = _jrDiscovered.length > 12 ? '' : 'none';
    setStatus(_jrDiscovered.length
      ? `${_jrDiscovered.length} room${_jrDiscovered.length === 1 ? '' : 's'} on ${r.host}. Double-click one to join.`
      : `${r.host} published no public rooms.`);
    paint();
  };

  goBtn.addEventListener('click', query);
  filterEl.addEventListener('input', paint);
  joinBtn.addEventListener('click', () => {
    const room = _jrDiscovered.find(x => x.jid === selected);
    if (room) join(room);
  });
  backdrop.querySelector('.jabber-room-modal-cancel').addEventListener('click', close);
  backdrop.querySelector('.jabber-room-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  hostInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); query(); } });
  hostInput.focus();
  hostInput.select();
}

// ─── Composer toolbar ─────────────────────────────────────────────────────────
// Emoji and links are plain text, so they arrive intact in every client in the
// room — Pidgin, Swift, a phone, anything. Bold/italic/underline wrap the
// selection in the conventional *asterisk* markers rather than XHTML-IM: the
// markers are what chat clients and people already read, whereas rich markup is
// dropped by half the clients on an EVE Jabber server and would arrive as
// nothing at all.

const JR_EMOJI = [
  '🙂', '😃', '😆', '😉', '😅', '😂', '🙃', '😐', '😑', '😕',
  '😟', '😮', '😱', '😭', '😠', '😎', '🤔', '🤷', '👍', '👎',
  '👏', '🙏', '💀', '🔥', '❤️', '✅', '❌', '⚠️', '🚀', '🛰️',
  '⚔️', '🛡️', '💥', '🪐', '🧊', '💰', '📈', '📉', '🫡', 'o7',
];

// Insert at the cursor, keeping the caret after what was inserted so a second
// click continues rather than overwriting.
function _jrInsertAtCursor(text) {
  const input = document.getElementById('jabberRoomInput');
  if (!input || input.disabled) return;
  const start = input.selectionStart ?? input.value.length;
  const end   = input.selectionEnd   ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const caret = start + text.length;
  input.setSelectionRange(caret, caret);
  input.focus();
}

// Wrap the selection, or drop the markers at the cursor ready to be typed into.
function _jrWrapSelection(marker) {
  const input = document.getElementById('jabberRoomInput');
  if (!input || input.disabled) return;
  const start = input.selectionStart ?? 0;
  const end   = input.selectionEnd   ?? 0;
  const selected = input.value.slice(start, end);
  input.value = input.value.slice(0, start) + marker + selected + marker + input.value.slice(end);
  // Selection wrapped: put the caret after it. Nothing selected: put it between
  // the markers, where the user is about to type.
  const caret = selected ? end + marker.length * 2 : start + marker.length;
  input.setSelectionRange(caret, caret);
  input.focus();
}

const _JR_MARKER = { b: '*', i: '_', u: '__' };

function _jrToggleEmojiPicker() {
  const picker = document.getElementById('jabberEmojiPicker');
  if (!picker) return;
  if (picker.style.display !== 'none') { picker.style.display = 'none'; return; }

  if (!picker.childElementCount) {
    for (const e of JR_EMOJI) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'jabber-emoji';
      b.textContent = e;
      b.title = e;
      b.addEventListener('click', () => {
        _jrInsertAtCursor(e.length > 2 ? `${e} ` : e);   // 'o7' reads better with a space
        picker.style.display = 'none';
      });
      picker.appendChild(b);
    }
  }
  picker.style.display = '';
  // Close on the next click outside, the same way the add-widget menu does.
  setTimeout(() => {
    const off = (ev) => {
      if (picker.contains(ev.target)) return;
      picker.style.display = 'none';
      document.removeEventListener('click', off);
    };
    document.addEventListener('click', off);
  }, 0);
}

// Link insertion. No window.prompt() — Electron has none — so the same in-app
// modal the rest of this page uses.
function _jrInsertLink() {
  const input = document.getElementById('jabberRoomInput');
  if (!input || input.disabled) return;
  const selected = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0).trim();

  const backdrop = document.createElement('div');
  backdrop.className = 'jabber-room-modal-backdrop';
  backdrop.innerHTML = `
    <div class="jabber-room-modal">
      <div class="jabber-room-modal-head">
        <div class="jabber-room-modal-title">Insert link</div>
        <button class="jabber-room-modal-close" type="button" title="Close">&#x2715;</button>
      </div>
      <label class="jabber-room-modal-label" for="jrLinkUrl">Address</label>
      <input id="jrLinkUrl" class="field-input jabber-room-modal-input" type="text"
             placeholder="https://goonfleet.com/…" autocomplete="off" />
      <label class="jabber-room-modal-label" for="jrLinkText">Label <span>(optional)</span></label>
      <input id="jrLinkText" class="field-input jabber-room-modal-input" type="text"
             placeholder="What it is" autocomplete="off" />
      <div class="jabber-room-modal-hint">
        Sent as plain text, so it stays a working link in every client in the room.
      </div>
      <div class="jabber-room-modal-actions">
        <button class="jabber-room-modal-cancel" type="button">Cancel</button>
        <button class="jabber-room-modal-add" type="button">Insert</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const urlEl  = backdrop.querySelector('#jrLinkUrl');
  const textEl = backdrop.querySelector('#jrLinkText');
  if (/^https?:\/\//i.test(selected)) urlEl.value = selected;
  else textEl.value = selected;

  const close = () => backdrop.remove();
  const insert = () => {
    let url = urlEl.value.trim();
    if (!url) { urlEl.focus(); return; }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;   // a bare host is still a link
    const label = textEl.value.trim();
    close();
    _jrInsertAtCursor(label ? `${label} ${url} ` : `${url} `);
  };

  backdrop.querySelector('.jabber-room-modal-add').addEventListener('click', insert);
  backdrop.querySelector('.jabber-room-modal-cancel').addEventListener('click', close);
  backdrop.querySelector('.jabber-room-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') { e.preventDefault(); insert(); }
  });
  urlEl.focus();
}

// ─── Add / leave ──────────────────────────────────────────────────────────────
// Electron has no window.prompt() — it is a no-op that returns undefined, so a
// prompt-based dialog silently does nothing. Same in-app modal approach as
// showNewShoppingListModal() in shopping-lists.js.
function _jrAddRoom() {
  const backdrop = document.createElement('div');
  backdrop.className = 'jabber-room-modal-backdrop';
  backdrop.innerHTML = `
    <div class="jabber-room-modal">
      <div class="jabber-room-modal-head">
        <div class="jabber-room-modal-title">Add chat room</div>
        <button class="jabber-room-modal-close" type="button" title="Close">&#x2715;</button>
      </div>
      <label class="jabber-room-modal-label" for="jrRoomJidInput">Room address</label>
      <input id="jrRoomJidInput" class="field-input jabber-room-modal-input" type="text"
             placeholder="corp@conference.goonfleet.com" autocomplete="off" />
      <label class="jabber-room-modal-label" for="jrRoomNameInput">Display name <span>(optional)</span></label>
      <input id="jrRoomNameInput" class="field-input jabber-room-modal-input" type="text"
             placeholder="Corp chat" autocomplete="off" />
      <div class="jabber-room-modal-hint">
        The room is joined as soon as Jabber is connected. Its history is stored locally.
      </div>
      <div class="jabber-room-modal-actions">
        <button class="jabber-room-modal-cancel" type="button">Cancel</button>
        <button class="jabber-room-modal-add" type="button">Add room</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const jidInput  = backdrop.querySelector('#jrRoomJidInput');
  const nameInput = backdrop.querySelector('#jrRoomNameInput');
  const addBtn    = backdrop.querySelector('.jabber-room-modal-add');
  const close     = () => backdrop.remove();

  const submit = async () => {
    const jid  = jidInput.value.trim();
    const name = nameInput.value.trim();
    if (!jid) { jidInput.focus(); return; }

    addBtn.disabled = true;
    const r = await window.eveAPI.jabberAddRoom({ jid, name })
      .catch(e => ({ ok: false, error: e.message }));
    if (!r?.ok) {
      addBtn.disabled = false;
      // Keep the dialog open with the text intact — the usual failure is a typo
      // in the address, and closing it would make the user retype the whole JID.
      if (typeof showToast === 'function') showToast(r?.error || 'Could not add that room.', 'error');
      jidInput.focus();
      return;
    }
    close();
    if (typeof showToast === 'function') {
      showToast(r.joined ? `Joined ${name || jid}.`
                         : `Added ${name || jid} — joins when Jabber connects.`, 'success');
    }
    await jabberRefreshRooms();
  };

  addBtn.addEventListener('click', submit);
  backdrop.querySelector('.jabber-room-modal-cancel').addEventListener('click', close);
  backdrop.querySelector('.jabber-room-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  jidInput.focus();
}

async function _jrLeaveRoom() {
  if (_jrActive === JR_PINGS) return;
  const room = _jrRooms.find(r => r.jid === _jrActive);
  if (!confirm(`Remove ${room?.name || _jrActive} from your rooms? Its history stays in the local database.`)) return;
  await window.eveAPI.jabberRemoveRoom(_jrActive).catch(() => {});
  _jrActive = JR_PINGS;
  await jabberRefreshRooms();
  _jrPaintActive();
}

// ─── Wiring ───────────────────────────────────────────────────────────────────
// Called from initJabberPage(). Binding is idempotent: the page can be opened and
// closed repeatedly, and the live listener must be registered exactly once.
function initJabberRooms() {
  const addBtn = document.getElementById('jabberAddRoomBtn');
  if (addBtn) addBtn.onclick = _jrAddRoom;
  const findBtn = document.getElementById('jabberFindRoomsBtn');
  if (findBtn) findBtn.onclick = _jrFindRooms;
  const leaveBtn = document.getElementById('jabberLeaveRoomBtn');
  if (leaveBtn) leaveBtn.onclick = _jrLeaveRoom;
  const olderBtn = document.getElementById('jabberLoadOlderBtn');
  if (olderBtn) olderBtn.onclick = () => _jrLoadOlder();

  document.querySelectorAll('#page-jabber .jabber-fmt-btn[data-fmt]').forEach(btn => {
    btn.onclick = () => _jrWrapSelection(_JR_MARKER[btn.dataset.fmt] || '*');
  });
  const emojiBtn = document.getElementById('jabberEmojiBtn');
  if (emojiBtn) emojiBtn.onclick = (e) => { e.stopPropagation(); _jrToggleEmojiPicker(); };
  const linkBtn = document.getElementById('jabberLinkBtn');
  if (linkBtn) linkBtn.onclick = _jrInsertLink;
  const composer = document.getElementById('jabberRoomComposer');
  if (composer) composer.onsubmit = _jrSend;

  const pingsBtn = document.querySelector(`#page-jabber .jabber-room-btn[data-room="${JR_PINGS}"]`);
  if (pingsBtn) pingsBtn.onclick = () => jabberOpenRoom(JR_PINGS);

  if (!_jrBound) {
    _jrBound = true;
    window.eveAPI.on('jabber-room-message', (m) => {
      if (!m || !m.room_jid) return;
      if (m.room_jid === _jrActive) {
        // Room is on screen: append, keep it read, and only stick to the bottom
        // if the reader was already there — otherwise scrolling back through
        // history fights every incoming line.
        const log = document.getElementById('jabberRoomLog');
        if (log) {
          const atBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
          if (log.querySelector('.jabber-room-empty')) log.innerHTML = '';
          const prev = log.lastElementChild?.querySelector('.jabber-msg-who')?.textContent;
          log.appendChild(_jrRowEl(m, prev === m.sender_nick));
          if (atBottom) log.scrollTop = log.scrollHeight;
        }
        window.eveAPI.jabberMarkRoomRead(m.room_jid).catch(() => {});
      } else {
        jabberRefreshRooms();   // badge the rail
      }
    });
    // A reconnect re-joins every room; repaint so the rail stops showing them
    // as offline.
    window.eveAPI.on('jabber-rooms', () => jabberRefreshRooms());

    // Subject and roster changes only matter for the room on screen.
    window.eveAPI.on('jabber-room-subject', (s) => {
      if (s?.roomJid === _jrActive) _jrRenderSubject(s);
    });
    window.eveAPI.on('jabber-room-occupants', (o) => {
      if (o?.roomJid === _jrActive) _jrRenderRoster(o.occupants);
    });
  }

  jabberRefreshRooms();
}
