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
 */
function registerJabberHandlers({ jabberDataDb, createPingAlertWindow }) {

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
      });

      jabberClient.on('stanza', async (stanza) => {
        // A rejected Beehive join comes back as a presence error — log it instead of
        // dropping it silently, so a never-arriving MOTD is diagnosable.
        if (stanza.is('presence') && stanza.attrs.type === 'error'
            && (stanza.attrs.from || '').toLowerCase().startsWith(BEEHIVE_ROOM.toLowerCase())) {
          console.warn('[jabber] Beehive MUC join rejected:', stanza.toString());
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

        const body = stanza.getChildText('body');
        if (!body) return;
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

  ipcMain.handle('jabber-disconnect', async () => {
    if (jabberClient) {
      jabberConnectionActive = false;
      const clientToStop = jabberClient;
      jabberClient = null; // Null first so no new events route through
      try { await clientToStop.stop(); } catch (_) {}
    }
    stopBeehiveRecheck();
    resetBeehiveStatus();   // status unknown while disconnected
    return true;
  });

  // Current Beehive beacon status (cached from the room MOTD) for the dashboard
  // widget to read on mount, before the next live subject update arrives.
  ipcMain.handle('beehive-get-status', async () => beehiveStatus);

  ipcMain.handle('jabber-get-messages', async (_, limit = 200) => {
    try {
      return await jabberDataDb.getRecentMessages(limit);
    } catch (e) {
      console.error('[jabberDataDb] jabber-get-messages failed:', e.message);
      return [];
    }
  });

  ipcMain.handle('jabber-wipe-data', async () => {
    try {
      await jabberDataDb.wipeJabberDb();
      return true;
    } catch (e) {
      console.error('[jabberDataDb] jabber-wipe-data failed:', e.message);
      return false;
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

module.exports = { registerJabberHandlers, broadcastToRenderers, parseBeehiveStatus };