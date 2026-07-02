// ─── jabber_ipc.js ────────────────────────────────────────────────────────────
// Handles all Jabber/XMPP IPC in the main process.
// Extracted from main.js — register by calling registerJabberHandlers().
// ─────────────────────────────────────────────────────────────────────────────

const { ipcMain, BrowserWindow } = require('electron');

let jabberClient = null;
let jabberConnectionActive = false;

// ── Beehive beacon status ─────────────────────────────────────────────────────
// Derived from the MOTD (MUC subject) of the GoonFleet "Beehive" room. Drives a
// dashboard widget. Fail-safe: RED (stand down) whenever we can't positively
// confirm green/yellow — disconnected, room not joined, or MOTD unrecognised.
const BEEHIVE_ROOM = 'Beehive@conference.goonfleet.com';
let beehiveStatus = { status: 'red', text: '', changedAt: null };

// Classify the Beehive MOTD into a traffic light. The status lives on the "Beehive
// is currently ___" line — classify THAT (most reliable). Only if it's missing do we
// scan the whole MOTD, and then only for unambiguous whole words, so body text like
// "Red Loot Buyback" can't force a false RED. Yellow is checked before green so an
// "online, spooling" state reads yellow. Fail-safe: anything unrecognised → RED.
//   green  = online / running / active / up          (good to go)
//   yellow = spooling (spinning up) / holding / winding down / finishing
//   red    = offline / everything else
const _BEEHIVE_YELLOW = /spool|spinning up|holding|winding|finishing|wrapping|stand[-\s]?down|\bhold\b|\byellow\b|\bamber\b/;
const _BEEHIVE_GREEN  = /\bonline\b|\brunning\b|\bactive\b|\blive\b|\bopen\b|\bup\b|\bgo\b|\bready\b|good to go|\bgreen\b/;

function parseBeehiveStatus(motd) {
  const t = (motd || '').toLowerCase();
  const line = (t.match(/beehive is\s+(?:currently\s+)?([^\n.!]*)/) || [])[1];

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
  beehiveStatus = { status: parseBeehiveStatus(motd), text: motd || '', changedAt: new Date().toISOString() };
  broadcastToRenderers('beehive-status', beehiveStatus);
}

// Back to the fail-safe when we lose the room (disconnect / offline).
function resetBeehiveStatus() {
  beehiveStatus = { status: 'red', text: '', changedAt: new Date().toISOString() };
  broadcastToRenderers('beehive-status', beehiveStatus);
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
        resetBeehiveStatus();   // lost the room → fail-safe RED
        broadcastToRenderers('jabber-status', { status: 'offline', message: 'Disconnected' });
      });

      jabberClient.on('online', async (address) => {
        jabberConnectionActive = true;
        broadcastToRenderers('jabber-status', { status: 'online', message: `Connected as ${address.toString()}` });

        // Join the Beehive MUC (GoonFleet only) so its MOTD (subject) reaches us.
        // history maxstanzas=0 avoids replaying old room chatter; the subject still
        // arrives on join and on every change.
        if (/goonfleet/i.test(domain) || /goonfleet/i.test(service)) {
          try {
            const { xml } = await getXmppClient();
            const nick = username || address.local || 'evecarbon';
            await jabberClient.send(xml('presence', { to: `${BEEHIVE_ROOM}/${nick}` },
              xml('x', { xmlns: 'http://jabber.org/protocol/muc' }, xml('history', { maxstanzas: '0' }))));
          } catch (e) {
            console.warn('[jabber] Beehive MUC join failed:', e.message || e);
          }
        }
      });

      jabberClient.on('stanza', async (stanza) => {
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
    resetBeehiveStatus();   // fail-safe RED while disconnected
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

module.exports = { registerJabberHandlers, broadcastToRenderers };