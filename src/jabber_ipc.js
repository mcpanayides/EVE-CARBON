// ─── jabber_ipc.js ────────────────────────────────────────────────────────────
// Handles all Jabber/XMPP IPC in the main process.
// Extracted from main.js — register by calling registerJabberHandlers().
// ─────────────────────────────────────────────────────────────────────────────

const { ipcMain, BrowserWindow } = require('electron');

let jabberClient = null;
let jabberConnectionActive = false;

// ── Beehive beacon status ─────────────────────────────────────────────────────
// Derived from the MOTD (MUC subject) of the GoonFleet "Beehive" room. Drives a
// dashboard widget. RED only when an actual MOTD reads as stand-down; when we
// have no MOTD at all (disconnected, room not joined) the status is UNKNOWN —
// we can't claim the Beehive is down, only that we can't see it.
const BEEHIVE_ROOM = 'Beehive@conference.goonfleet.com';
const BEEHIVE_RECHECK_MS = 60 * 1000;   // occupancy/MOTD self-check cadence
let beehiveStatus = { status: 'unknown', text: '', changedAt: null };
let beehiveNick = null;          // nick we joined with — needed for self-ping / re-join
let beehiveRecheckTimer = null;

// Classify the Beehive MOTD into a traffic light. The real MOTD carries an explicit
// "Status: Green" line (e.g. "FC: K Cee \n Status: Green \n Doctrine: SIR …") —
// classify THAT when present, else an older "Beehive is currently ___" sentence.
// Only if both are missing do we scan the whole MOTD, and then only for unambiguous
// whole words, so body text like "Red Loot Buyback" can't force a false RED.
// Yellow is checked before green so an "online, spooling" state reads yellow.
// Fail-safe: anything unrecognised → RED (incl. "stand down", which is red, not yellow).
//   green  = green / online / running / active / up  (good to go)
//   yellow = spooling (spinning up) / holding / winding down / finishing
//   red    = red / offline / stand down / everything else
const _BEEHIVE_YELLOW = /spool|spinning up|holding|winding|finishing|wrapping|\bhold\b|\byellow\b|\bamber\b/;
const _BEEHIVE_GREEN  = /\bonline\b|\brunning\b|\bactive\b|\blive\b|\bopen\b|\bup\b|\bgo\b|\bready\b|good to go|\bgreen\b/;

function parseBeehiveStatus(motd) {
  const t = (motd || '').toLowerCase();
  const line = (t.match(/^[ \t]*status[ \t]*[:=-][ \t]*([^\n.!]*)/m) || [])[1]
            ?? (t.match(/beehive is\s+(?:currently\s+)?([^\n.!]*)/)  || [])[1];

  if (line != null) {                          // explicit status line — trust it
    if (_BEEHIVE_YELLOW.test(line)) return 'yellow';
    if (_BEEHIVE_GREEN.test(line))  return 'green';
    return 'red';
  }
  // No status line — only unambiguous whole-word signals (avoid loose colour words).
  if (/\bspool(?:ing|ed)?\b|\bspinning up\b/.test(t)) return 'yellow';
  if (/\bonline\b/.test(t)) return 'green';
  return 'red';   // fail-safe default
}

function updateBeehiveStatus(motd) {
  const text   = motd || '';
  const status = text.trim() ? parseBeehiveStatus(text) : 'unknown';   // blank MOTD proves nothing
  // Re-delivered identical MOTDs (minutely recheck, re-join) keep the original timestamp.
  if (status === beehiveStatus.status && text === beehiveStatus.text) return;
  beehiveStatus = { status, text, changedAt: new Date().toISOString() };
  broadcastToRenderers('beehive-status', beehiveStatus);
}

// Back to UNKNOWN when we lose the room (disconnect / offline) — no MOTD, no claim.
function resetBeehiveStatus() {
  beehiveStatus = { status: 'unknown', text: '', changedAt: null };
  broadcastToRenderers('beehive-status', beehiveStatus);
}

// (Re-)join the Beehive MUC. The server re-sends the room subject (MOTD) on every
// join, so this doubles as a status refresh. history maxstanzas=0 skips old chatter.
async function joinBeehiveRoom() {
  if (!jabberClient || !beehiveNick) return;
  const { xml } = await getXmppClient();
  await jabberClient.send(xml('presence', { to: `${BEEHIVE_ROOM}/${beehiveNick}` },
    xml('x', { xmlns: 'http://jabber.org/protocol/muc' }, xml('history', { maxstanzas: '0' }))));
}

// Once a minute: MUC self-ping (XEP-0410) to confirm we're still an occupant. The
// subject is push-only — if the join failed or we got dropped without an 'offline'
// event, no update ever arrives and the widget silently goes stale. On any ping
// failure, re-join; the server then re-sends the subject and the status refreshes.
function startBeehiveRecheck() {
  stopBeehiveRecheck();
  beehiveRecheckTimer = setInterval(async () => {
    if (!jabberClient || !jabberConnectionActive || !beehiveNick) return;
    try {
      const { xml } = await getXmppClient();
      await jabberClient.iqCaller.request(
        xml('iq', { type: 'get', to: `${BEEHIVE_ROOM}/${beehiveNick}` },
          xml('ping', { xmlns: 'urn:xmpp:ping' })),
        15 * 1000);
    } catch (_) {
      try { await joinBeehiveRoom(); }
      catch (e) { console.warn('[jabber] Beehive re-join failed:', e.message || e); }
    }
  }, BEEHIVE_RECHECK_MS);
}

function stopBeehiveRecheck() {
  if (beehiveRecheckTimer) { clearInterval(beehiveRecheckTimer); beehiveRecheckTimer = null; }
}

// ─── Chat rooms (MUC) ─────────────────────────────────────────────
// The Beehive room above is a fixed, status-only join. These are the user's own
// rooms: joined on connect, messages persisted per room, and messages can be sent
// back. Kept out of the ping pipeline — a room's chatter is not a ping, and
// routing it there would flood both the ping feed and the alert window.
const joinedRooms = new Map();   // bare room JID -> { nick, joinedAt }
let roomNick = null;             // default nick, derived from the JID we connect as

const bareJid = (jid) => String(jid || '').split('/')[0].toLowerCase();
const nickOf  = (jid) => String(jid || '').split('/')[1] || '';

// Rooms live in the app config beside the Jabber credentials, so they survive
// restarts and travel with the rest of the user's settings.
function readRooms(loadConfig) {
  try {
    const rooms = loadConfig()?.app?.jabber?.rooms;
    return Array.isArray(rooms) ? rooms : [];
  } catch (_) { return []; }
}

function writeRooms(loadConfig, saveConfig, rooms) {
  const cfg = loadConfig() || {};
  cfg.app = cfg.app || {};
  cfg.app.jabber = { ...(cfg.app.jabber || {}), rooms };
  saveConfig(cfg);
}

// Join presence for a MUC. The history request asks the server for recent
// messages so a room is not blank on open; servers without history send nothing.
async function sendRoomJoin(roomJid, nick, historyStanzas = 30) {
  if (!jabberClient || !roomJid || !nick) return;
  const { xml } = await getXmppClient();
  await jabberClient.send(xml('presence', { to: roomJid + '/' + nick },
    xml('x', { xmlns: 'http://jabber.org/protocol/muc' },
      xml('history', { maxstanzas: String(historyStanzas) }))));
}

async function sendRoomLeave(roomJid, nick) {
  if (!jabberClient || !roomJid || !nick) return;
  const { xml } = await getXmppClient();
  await jabberClient.send(xml('presence', { to: roomJid + '/' + nick, type: 'unavailable' }));
}

// ─── Room discovery (XEP-0030 service discovery) ──────────────────────────────
// What Pidgin's "Room List" does: ask a conference service for its public rooms
// instead of making the user know a room's exact address in advance.
//
// The conference service is conventionally the `conference.` subdomain of the
// account's own domain — goonfleet.com serves its rooms from
// conference.goonfleet.com — so the dialog can offer the right host without
// being told. It is only a default: the field stays editable because the
// convention is a convention, not a rule (some servers use muc. or chat.).
function conferenceHostFor(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^@+/, '');
  if (!d) return '';
  // Already a service host (conference.x, muc.x, chat.x) — leave it alone rather
  // than producing conference.conference.example.com.
  if (/^(conference|muc|chat|rooms)\./.test(d)) return d;
  return `conference.${d}`;
}

// Turn a disco#items result into the two columns the list shows. `name` is the
// service's human description; the JID's local part is the room's actual name,
// which is what you would have had to type by hand. Rooms with neither are
// dropped — an item with no JID cannot be joined.
function parseDiscoItems(queryEl) {
  if (!queryEl) return [];
  const items = typeof queryEl.getChildren === 'function' ? queryEl.getChildren('item') : [];
  const rooms = [];
  for (const item of items) {
    const jid = (item.attrs?.jid || '').trim();
    if (!jid || !jid.includes('@')) continue;
    rooms.push({
      jid: jid.toLowerCase(),
      name: jid.split('@')[0],
      description: (item.attrs?.name || '').trim(),
    });
  }
  rooms.sort((a, b) => a.name.localeCompare(b.name));
  return rooms;
}

// ─── Room subject and occupants ───────────────────────────────────────────────
// A MUC tells you two things besides its messages: the subject (the MOTD banner
// every alliance room uses for standings, links and "we are currently offline")
// and who is in it. Both arrive as pushes — the subject on join and on change,
// occupants as a burst of presence on join and then one at a time — so both are
// held here and handed to the renderer, rather than being re-derived per view.
const roomSubjects  = new Map();   // bare room JID -> { text, setBy, at }
const roomOccupants = new Map();   // bare room JID -> Map(nick -> { nick, role, affiliation })

// MUC ranks an occupant twice: `affiliation` is standing with the room (owner,
// admin, member, outcast) and `role` is what they can do right now (moderator,
// participant, visitor). Pidgin's list is ordered by the first and shows the
// second — owners and admins on top, then members, then everyone else.
const AFFILIATION_RANK = { owner: 0, admin: 1, member: 2, none: 3, outcast: 4 };

function occupantSort(a, b) {
  const ra = AFFILIATION_RANK[a.affiliation] ?? 3;
  const rb = AFFILIATION_RANK[b.affiliation] ?? 3;
  if (ra !== rb) return ra - rb;
  // Moderators above the room's general population within the same standing.
  const ma = a.role === 'moderator' ? 0 : 1;
  const mb = b.role === 'moderator' ? 0 : 1;
  if (ma !== mb) return ma - mb;
  return a.nick.toLowerCase().localeCompare(b.nick.toLowerCase());
}

// The <item/> inside a muc#user payload carries the ranks. Absent means a plain
// participant, which is what an unadorned presence implies.
function parseOccupantPresence(stanza) {
  const from = stanza?.attrs?.from || '';
  const nick = nickOf(from);
  if (!nick) return null;
  const x = typeof stanza.getChild === 'function'
    ? stanza.getChild('x', 'http://jabber.org/protocol/muc#user') : null;
  const item = x?.getChild?.('item');
  return {
    roomJid: bareJid(from),
    nick,
    role:        item?.attrs?.role        || 'participant',
    affiliation: item?.attrs?.affiliation || 'none',
    leaving:     stanza.attrs?.type === 'unavailable',
  };
}

function occupantList(roomJid) {
  const map = roomOccupants.get(roomJid);
  return map ? [...map.values()].sort(occupantSort) : [];
}

// ─── Message archives (XEP-0313 MAM) ──────────────────────────────────────────
// The <history/> element on a join presence only ever buys a handful of recent
// lines, and many servers cap it far below what is asked for — which is why
// joining a busy room can look completely empty. MAM is the mechanism that
// actually returns a room's backlog: query the room's archive, page backwards
// through it, and store what comes back.
//
// A server without MAM simply answers with an error; the join history is then all
// there is, and the UI says so rather than pretending the room is empty.

// MAM has shipped under three namespaces. A room that supports none of them
// answers an IQ it does not recognise with a bare "bad-request" — ejabberd's is
// literally "IQ request cannot be processed by the MUC room itself" — which is
// indistinguishable from a malformed query unless you ask first. So: ask the room
// what it supports (disco#info), then use that namespace. Cached per room, since
// the answer does not change while we are connected.
const MAM_NAMESPACES = ['urn:xmpp:mam:2', 'urn:xmpp:mam:1', 'urn:xmpp:mam:0'];
const roomMamNs = new Map();   // bare room JID -> namespace, or null for "none"

// Pick the newest MAM namespace a disco#info result advertises.
function mamNamespaceFrom(queryEl) {
  if (!queryEl) return null;
  const features = typeof queryEl.getChildren === 'function' ? queryEl.getChildren('feature') : [];
  const vars = new Set(features.map(f => f.attrs?.var).filter(Boolean));
  return MAM_NAMESPACES.find(ns => vars.has(ns)) || null;
}

// When a message was actually sent. Archived and MUC-history messages carry a
// <delay/>; live ones do not, and are happening now.
function delayStamp(el) {
  const delay = typeof el?.getChild === 'function'
    ? (el.getChild('delay', 'urn:xmpp:delay') || el.getChild('delay'))
    : null;
  const stamp = delay?.attrs?.stamp;
  if (!stamp) return null;
  const t = Date.parse(stamp);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// One <result/> from a MAM page → the fields a stored message needs, or null if
// the stanza carries no usable message (subject changes, state notifications).
function parseMamResult(stanza, queryId) {
  const result = typeof stanza?.getChild === 'function' ? stanza.getChild('result') : null;
  if (!result) return null;
  if (queryId && result.attrs?.queryid && result.attrs.queryid !== queryId) return null;

  const forwarded = result.getChild('forwarded');
  const inner     = forwarded?.getChild('message');
  const body      = typeof inner?.getChildText === 'function' ? inner.getChildText('body') : null;
  if (!body) return null;

  const from = inner.attrs?.from || '';
  return {
    stanzaId:   result.attrs?.id || null,
    roomJid:    bareJid(from),
    senderNick: nickOf(from),
    body,
    receivedAt: delayStamp(forwarded) || delayStamp(inner) || null,
  };
}

let xmppLibrary = null;
async function getXmppClient() {
  if (!xmppLibrary) xmppLibrary = await import('@xmpp/client');
  return xmppLibrary;
}

function broadcastToRenderers(channel, payload) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
}

/**
 * Register all jabber-* IPC handlers.
 * @param {object} deps
 * @param {object} deps.jabberDataDb   - the jabber_data_db module
 * @param {Function} deps.createPingAlertWindow - opens the ping alert window
 * @param {Function} deps.loadConfig - reads the JSON app config (chat room list)
 * @param {Function} deps.saveConfig - writes the JSON app config
 */
function registerJabberHandlers({ jabberDataDb, createPingAlertWindow, loadConfig, saveConfig }) {

  ipcMain.handle('jabber-connect', async (_, { service, jid, password }) => {
    try {
      if (!service || !jid || !password) {
        return { success: false, message: 'Service, JID, and password are required.' };
      }
      const [username, domain] = jid.split('@');
      if (!username || !domain) {
        return { success: false, message: 'Invalid JID format. Use user@domain.' };
      }

      if (jabberClient) {
        jabberConnectionActive = false;
        stopBeehiveRecheck();
        const oldClient = jabberClient;
        jabberClient = null; // Null before stop so stale events don't route through
        try { await oldClient.stop(); } catch (_) {}
      }

      const { client: xmppClient } = await getXmppClient();
      jabberClient = xmppClient({ service, domain, username, password });

      jabberClient.on('error', (err) => {
        // Swallow the null-write race error — it's a benign teardown artifact
        if (err?.message?.includes("reading 'write'")) return;
        broadcastToRenderers('jabber-status', { status: 'error', message: err?.message || String(err) });
      });

      jabberClient.on('offline', () => {
        jabberConnectionActive = false;
        stopBeehiveRecheck();
        resetBeehiveStatus();   // lost the room → status unknown
        broadcastToRenderers('jabber-status', { status: 'offline', message: 'Disconnected' });
      });

      jabberClient.on('online', async (address) => {
        jabberConnectionActive = true;
        broadcastToRenderers('jabber-status', { status: 'online', message: `Connected as ${address.toString()}` });

        // Join the Beehive MUC (GoonFleet only) so its MOTD (subject) reaches us.
        // The subject arrives on join and on every change; the minutely recheck
        // repairs a failed/lost join.
        if (/goonfleet/i.test(domain) || /goonfleet/i.test(service)) {
          beehiveNick = username || address.local || 'evecarbon';
          try {
            await joinBeehiveRoom();
          } catch (e) {
            console.warn('[jabber] Beehive MUC join failed:', e.message || e);
          }
          startBeehiveRecheck();
        } else {
          beehiveNick = null;
        }

        // Re-join every saved room. MUC membership is per-session, not per
        // account, so a reconnect that skips this leaves a room list that looks
        // joined and silently receives nothing.
        roomNick = username || address.local || 'evecarbon';
        joinedRooms.clear();
        roomOccupants.clear();   // rebuilt from the join presence burst
        for (const room of readRooms(loadConfig)) {
          const jid = bareJid(room.jid);
          if (!jid) continue;
          // Recorded BEFORE the presence goes out: the server answers a join with
          // a burst of history, and a room not yet in this map has its history
          // routed to the ping pipeline instead of to the room.
          joinedRooms.set(jid, { nick: room.nick || roomNick, joinedAt: Date.now() });
          try {
            await sendRoomJoin(jid, room.nick || roomNick);
          } catch (e) {
            joinedRooms.delete(jid);
            console.warn('[jabber] room join failed:', jid, e.message || e);
          }
        }
        broadcastToRenderers('jabber-rooms', { joined: [...joinedRooms.keys()] });
      });

      jabberClient.on('stanza', async (stanza) => {
        // A rejected Beehive join comes back as a presence error — log it instead of
        // dropping it silently, so a never-arriving MOTD is diagnosable.
        if (stanza.is('presence') && stanza.attrs.type === 'error'
            && (stanza.attrs.from || '').toLowerCase().startsWith(BEEHIVE_ROOM.toLowerCase())) {
          console.warn('[jabber] Beehive MUC join rejected:', stanza.toString());
          return;
        }

        // Occupant presence for a room we are in. A join sends one of these per
        // person already present, so this is also how the initial roster arrives.
        if (stanza.is('presence')) {
          const occ = parseOccupantPresence(stanza);
          if (occ && joinedRooms.has(occ.roomJid)) {
            if (!roomOccupants.has(occ.roomJid)) roomOccupants.set(occ.roomJid, new Map());
            const map = roomOccupants.get(occ.roomJid);
            if (occ.leaving) map.delete(occ.nick);
            else map.set(occ.nick, { nick: occ.nick, role: occ.role, affiliation: occ.affiliation });
            broadcastToRenderers('jabber-room-occupants',
              { roomJid: occ.roomJid, occupants: occupantList(occ.roomJid) });
          }
          return;
        }
        if (!stanza.is('message')) return;

        // Beehive room: its MOTD (subject) drives the status widget. Never route the
        // room's own messages/subject into the ping pipeline.
        const fromAttr = (stanza.attrs.from || '').toLowerCase();
        if (fromAttr.startsWith(BEEHIVE_ROOM.toLowerCase())) {
          const subject = stanza.getChildText('subject');
          if (subject != null) updateBeehiveStatus(subject);   // subject stanza = MOTD
          return;
        }

        // Room subject (the MOTD). Carried by a body-less groupchat message, so it
        // has to be handled before the body check drops it.
        const subjBare = bareJid(stanza.attrs.from);
        if (joinedRooms.has(subjBare)) {
          const subject = stanza.getChildText('subject');
          if (subject != null) {
            roomSubjects.set(subjBare, {
              text: subject,
              setBy: nickOf(stanza.attrs.from) || '',
              at: new Date().toISOString(),
            });
            broadcastToRenderers('jabber-room-subject',
              { roomJid: subjBare, ...roomSubjects.get(subjBare) });
            return;
          }
        }

        const body = stanza.getChildText('body');
        if (!body) return;

        // Room chat is decided by the STANZA TYPE, not by our own bookkeeping.
        // This used to check joinedRooms, so any MUC the account sat in that this
        // app had not explicitly joined — server auto-joins, rooms joined from
        // another client — fell straight through into the ping pipeline and was
        // filed as a broadcast. type='groupchat' means a room said it, full stop;
        // a fleet ping arrives as 'chat' or 'headline' from a bot.
        const fromBare = bareJid(stanza.attrs.from);
        const isGroupChat = (stanza.attrs.type || '') === 'groupchat';
        if (isGroupChat || joinedRooms.has(fromBare)) {
          const senderNick = nickOf(stanza.attrs.from);
          const selfNick   = joinedRooms.get(fromBare)?.nick;
          // XEP-0359 stanza-id, when the server stamps one, is the same archive
          // id MAM uses — so a message seen live is recognised rather than
          // duplicated when history is later pulled over it.
          const sidEl = typeof stanza.getChild === 'function'
            ? stanza.getChild('stanza-id', 'urn:xmpp:sid:0') : null;
          const roomMsg = {
            from: stanza.attrs.from || '', type: stanza.attrs.type || 'groupchat',
            body, isDirector: false, raw: stanza.toString(),
            roomJid: fromBare, senderNick,
            stanzaId:   sidEl?.attrs?.id || null,
            // Join history arrives as ordinary messages with a <delay/>; without
            // this every one of them is filed as having arrived at join time.
            receivedAt: delayStamp(stanza),
          };
          let storedRoom = null;
          try { storedRoom = await jabberDataDb.insertJabberMessage(roomMsg); }
          catch (e) { console.error('[jabberDataDb] failed to store room message:', e.message); }
          // insert returns null for a message already in the archive — a re-join
          // replays history, and replaying it into the room view would double
          // every line on screen.
          if (storedRoom) {
            broadcastToRenderers('jabber-room-message', {
              ...storedRoom,
              room_jid: fromBare, sender_nick: senderNick, self: senderNick === selfNick,
            });
          }
          return;
        }

        const from       = stanza.attrs.from || '';
        const type       = stanza.attrs.type || 'chat';
        const isDirector = /director/i.test(from) || /director/i.test(body);
        const msg        = { from, type, body, isDirector, raw: stanza.toString() };

        // ── Always persist every message to DB regardless of isDirector ──
        // isDirector is stored as a column for filtering but never gates storage.
        let stored = null;
        try {
          stored = await jabberDataDb.insertJabberMessage(msg);
        } catch (e) {
          console.error('[jabberDataDb] failed to store message:', e.message);
        }

        // Broadcast the enriched stored row (with DB id) to the jabber panel.
        broadcastToRenderers('jabber-message', stored || msg);

        // Open the ping-alert popup only for director broadcasts.
        if (isDirector) {
          createPingAlertWindow(stored || msg);
        }
      });

      await jabberClient.start();
      return { success: true, message: 'Connecting...' };
    } catch (err) {
      console.warn('Jabber connect failed:', err.message || err);
      return { success: false, message: err.message || String(err) };
    }
  });

  // Current Beehive beacon status (cached from the room MOTD) for the dashboard
  // widget to read on mount, before the next live subject update arrives.
  ipcMain.handle('beehive-get-status', async () =>
    (require('./demo_mode').isEnabled() ? require('./demo_fixtures').beehiveStatus() : beehiveStatus));

  ipcMain.handle('jabber-get-messages', async (_, limit = 200) => {
    try {
      return await jabberDataDb.getRecentMessages(limit);
    } catch (e) {
      console.error('[jabberDataDb] jabber-get-messages failed:', e.message);
      return [];
    }
  });

  // ─── Chat rooms ────────────────────────────────────────────
  ipcMain.handle('jabber-list-rooms', async () => {
    const rooms  = readRooms(loadConfig);
    const jids   = rooms.map(r => bareJid(r.jid));
    const unread = await jabberDataDb.getRoomUnread(jids).catch(() => ({}));
    return rooms.map(r => {
      const jid = bareJid(r.jid);
      return {
        ...r, jid,
        joined: joinedRooms.has(jid),
        unread: unread[jid] || { messages: 0, speakers: 0 },
      };
    });
  });

  ipcMain.handle('jabber-add-room', async (_, { jid, name, nick } = {}) => {
    const roomJid = bareJid(jid);
    if (!roomJid || !roomJid.includes('@')) {
      return { ok: false, error: 'Enter a room address like corp@conference.goonfleet.com' };
    }
    const rooms = readRooms(loadConfig);
    if (rooms.some(r => bareJid(r.jid) === roomJid)) {
      return { ok: false, error: 'That room is already in your list.' };
    }
    const useNick = (nick || '').trim() || null;
    rooms.push({ jid: roomJid, name: (name || '').trim() || roomJid.split('@')[0], nick: useNick });
    writeRooms(loadConfig, saveConfig, rooms);

    // Join straight away when connected, so adding a room does something visible
    // instead of waiting for the next reconnect.
    if (jabberClient && jabberConnectionActive) {
      joinedRooms.set(roomJid, { nick: useNick || roomNick, joinedAt: Date.now() });
      try {
        await sendRoomJoin(roomJid, useNick || roomNick);
      } catch (e) {
        joinedRooms.delete(roomJid);
        return { ok: true, joined: false, error: e.message || String(e) };
      }
    }
    return { ok: true, joined: joinedRooms.has(roomJid) };
  });

  ipcMain.handle('jabber-remove-room', async (_, jid) => {
    const roomJid = bareJid(jid);
    writeRooms(loadConfig, saveConfig,
      readRooms(loadConfig).filter(r => bareJid(r.jid) !== roomJid));
    const entry = joinedRooms.get(roomJid);
    if (entry) {
      try { await sendRoomLeave(roomJid, entry.nick); } catch (_) { /* best effort */ }
      joinedRooms.delete(roomJid);
      roomOccupants.delete(roomJid);
      roomSubjects.delete(roomJid);
    }
    return { ok: true };
  });

  // Subject and roster as they stand right now, for a view that just opened —
  // both are push-only, so without this a room shows nothing until the next
  // change arrives, which in a quiet room could be hours.
  ipcMain.handle('jabber-room-state', async (_, jid) => {
    const roomJid = bareJid(jid);
    return {
      subject: roomSubjects.get(roomJid) || null,
      occupants: occupantList(roomJid),
      joined: joinedRooms.has(roomJid),
    };
  });

  ipcMain.handle('jabber-room-messages', async (_, jid, limit = 200) =>
    jabberDataDb.getRoomMessages(bareJid(jid), limit).catch(() => []));

  ipcMain.handle('jabber-mark-room-read', async (_, jid) =>
    jabberDataDb.markRoomRead(bareJid(jid)).catch(() => 0));

  // Sending is always an explicit user action. Nothing in this app ever sends to
  // a room on its own, and every guard below fails closed.
  ipcMain.handle('jabber-send-room', async (_, jid, body) => {
    const roomJid = bareJid(jid);
    const text = String(body || '').trim();
    if (!text) return { ok: false, error: 'Nothing to send.' };
    if (!jabberClient || !jabberConnectionActive) return { ok: false, error: 'Not connected to Jabber.' };
    if (!joinedRooms.has(roomJid)) return { ok: false, error: 'Not in that room.' };
    try {
      const { xml } = await getXmppClient();
      await jabberClient.send(xml('message', { to: roomJid, type: 'groupchat' }, xml('body', {}, text)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // Pull a page of a room's archive, oldest-first, and store what is new.
  // Paged backwards from the oldest message already held, so repeated calls walk
  // further back rather than re-reading the same page.
  ipcMain.handle('jabber-load-room-history', async (_, jid, pageSize = 100) => {
    const roomJid = bareJid(jid);
    if (!roomJid) return { ok: false, error: 'No room.' };
    if (!jabberClient || !jabberConnectionActive) {
      return { ok: false, error: 'Connect to Jabber first — history comes from the server.' };
    }

    const { xml } = await getXmppClient();

    // Which MAM version does this room speak, if any?
    if (!roomMamNs.has(roomJid)) {
      try {
        const info = await jabberClient.iqCaller.request(
          xml('iq', { type: 'get', to: roomJid },
            xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' })),
          20 * 1000);
        roomMamNs.set(roomJid, mamNamespaceFrom(info.getChild('query')));
      } catch (e) {
        roomMamNs.set(roomJid, null);
      }
    }
    const mamNs = roomMamNs.get(roomJid);
    if (!mamNs) {
      return { ok: false, noArchive: true,
               error: 'This room does not keep a message archive on the server, so there is no older history to fetch.' };
    }

    const queryId = `mam${Date.now().toString(36)}`;
    const before  = await jabberDataDb.getRoomOldestArchiveId(roomJid).catch(() => null);

    // The archive arrives as a burst of <message><result/></message> stanzas
    // BEFORE the IQ result, so the collector has to be listening first.
    const collected = [];
    const onStanza = (st) => {
      try {
        const parsed = parseMamResult(st, queryId);
        if (parsed) collected.push({ ...parsed, roomJid: parsed.roomJid || roomJid });
      } catch (_) { /* a malformed archive entry must not abort the page */ }
    };
    jabberClient.on('stanza', onStanza);

    try {
      // <before/> empty means "the most recent page"; with an id it means
      // "the page before this message".
      const rsm = before
        ? xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
            xml('max', {}, String(pageSize)), xml('before', {}, before))
        : xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
            xml('max', {}, String(pageSize)), xml('before', {}));

      const res = await jabberClient.iqCaller.request(
        xml('iq', { type: 'set', to: roomJid },
          xml('query', { xmlns: mamNs, queryid: queryId }, rsm)),
        60 * 1000);

      let added = 0;
      for (const m of collected) {
        const stored = await jabberDataDb.insertJabberMessage({
          from: `${m.roomJid}/${m.senderNick}`, type: 'groupchat', body: m.body,
          isDirector: false, raw: '', roomJid: m.roomJid, senderNick: m.senderNick,
          stanzaId: m.stanzaId, receivedAt: m.receivedAt,
        }).catch(() => null);
        if (stored) added++;
      }

      // <fin complete='true'/> means the archive has no more before this page.
      const fin = res.getChild('fin');
      const complete = fin?.attrs?.complete === 'true' || collected.length === 0;
      return { ok: true, fetched: collected.length, added, complete };
    } catch (e) {
      // The room advertised MAM but the query still failed — report what it said,
      // and forget the cached namespace so a retry can re-negotiate.
      roomMamNs.delete(roomJid);
      const msg = e?.message || String(e);
      return { ok: false, error: `The room refused the history request (${msg}).` };
    } finally {
      jabberClient.removeListener('stanza', onStanza);
    }
  });

  // The conference host to offer in the Find Rooms dialog, derived from the
  // account's own domain. Returns '' when no account is configured — the dialog
  // then just starts empty rather than guessing.
  ipcMain.handle('jabber-default-conference', () => {
    try {
      const jid = loadConfig()?.app?.jabber?.jid || '';
      return conferenceHostFor(jid.split('@')[1] || '');
    } catch (_) { return ''; }
  });

  // Ask a conference service for its public room list.
  ipcMain.handle('jabber-discover-rooms', async (_, serverJid) => {
    const host = String(serverJid || '').trim().toLowerCase();
    if (!host) return { ok: false, error: 'Enter a conference server.' };
    if (!jabberClient || !jabberConnectionActive) {
      return { ok: false, error: 'Connect to Jabber first — room lists come from the server.' };
    }
    try {
      const { xml } = await getXmppClient();
      // 30s: a big service can take a while to enumerate several hundred rooms,
      // and a premature timeout looks identical to an empty server.
      const res = await jabberClient.iqCaller.request(
        xml('iq', { type: 'get', to: host },
          xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' })),
        30 * 1000);
      const rooms = parseDiscoItems(res.getChild('query'));
      return { ok: true, host, rooms };
    } catch (e) {
      // A service that refuses disco returns an IQ error, which arrives here as a
      // throw — report it rather than showing an empty list, which would read as
      // "this server has no rooms".
      const msg = e?.message || String(e);
      return { ok: false, error: `${host} did not return a room list (${msg}).` };
    }
  });

  // Latest director broadcast for the dashboard's Latest Ping widget.
  ipcMain.handle('jabber-get-latest-ping', async () => {
    // Demo mode never connects to XMPP, so the widget would sit on "No director
    // pings yet" — indistinguishable from a fault. The ping and its cast are
    // invented; no real alliance, comms link or iconography appears in it.
    if (require('./demo_mode').isEnabled()) return require('./demo_fixtures').latestPing();
    try {
      return await jabberDataDb.getLatestDirectorMessage();
    } catch (e) {
      console.error('[jabberDataDb] jabber-get-latest-ping failed:', e.message);
      return null;
    }
  });

  ipcMain.handle('jabber-wipe-data', async () => {
    try {
      await jabberDataDb.wipeJabberDb();
      return true;
    } catch (e) {
      // Rethrow (don't swallow to `false`) — the renderer's try/catch shows a
      // failure toast either way, but silently resolving `false` on a real
      // failure previously let the renderer show a false "wiped" success
      // toast while the data was never actually cleared.
      console.error('[jabberDataDb] jabber-wipe-data failed:', e.message);
      throw e;
    }
  });

  ipcMain.handle('jabber-open-ping-alert', async (_, rowId) => {
    try {
      const row = await jabberDataDb.getMessageById(rowId);
      if (!row) {
        console.warn('[jabberDataDb] jabber-open-ping-alert: row not found for id', rowId);
        return false;
      }
      createPingAlertWindow(row);
      return true;
    } catch (e) {
      console.error('[jabberDataDb] jabber-open-ping-alert failed:', e.message);
      return false;
    }
  });
}

module.exports = { registerJabberHandlers, conferenceHostFor, parseDiscoItems, parseMamResult, delayStamp,
                   parseOccupantPresence, occupantSort, mamNamespaceFrom, broadcastToRenderers, parseBeehiveStatus };