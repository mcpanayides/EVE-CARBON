// ─── jabber_data_db.js ────────────────────────────────────────────────────────
// Manages jabber_data.db in the project /data folder (alongside character_information.db).
// Parses and stores incoming Jabber broadcast messages with full field extraction.
// ─────────────────────────────────────────────────────────────────────────────

const path   = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

let jabberDb = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initJabberDb(appDataDir, userDataDir) {
  // Jabber messages are user data that must survive app updates/reinstalls.
  // Use userDataDir (app.getPath('userData')) when provided; fall back to
  // appDataDir for backwards-compat with callers that only pass one arg.
  const persistDir = userDataDir || appDataDir;
  const dbPath = path.join(persistDir, 'jabber_data.db');
  jabberDb = await open({ filename: dbPath, driver: sqlite3.Database });

  await jabberDb.exec(`
    CREATE TABLE IF NOT EXISTS jabber_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at     TEXT    NOT NULL,           -- ISO-8601 wall-clock time when we got the message
      from_jid        TEXT    NOT NULL DEFAULT '', -- XMPP from attribute (e.g. directorbot@conf.goonfleet.com)
      msg_type        TEXT    NOT NULL DEFAULT '', -- XMPP type attribute (chat / groupchat / etc.)
      is_director     INTEGER NOT NULL DEFAULT 0,  -- 1 if flagged as director message
      raw_body        TEXT    NOT NULL DEFAULT '', -- original, unmodified message body

      -- Parsed header fields (first line: "(HH:MM:SS AM/PM) sender: hurf text")
      ping_timestamp  TEXT    DEFAULT NULL,        -- wall-clock time extracted from leading "(HH:MM:SS ...)"
      who_pinged      TEXT    DEFAULT NULL,        -- sender name before the colon
      hurf            TEXT    DEFAULT NULL,        -- free-text body on the first line after "sender: "

      -- Structured broadcast fields
      fc_name         TEXT    DEFAULT NULL,
      formup_location TEXT    DEFAULT NULL,
      pap_type        TEXT    DEFAULT NULL,
      comms           TEXT    DEFAULT NULL,
      doctrine        TEXT    DEFAULT NULL,

      -- Closing-line fields  "~~~ This was a <sig> broadcast from <gsol_member> to <target_sig> at <eve_timecode> EVE ~~~"
      sig             TEXT    DEFAULT NULL,        -- e.g. "skirmishbot"
      gsol_member     TEXT    DEFAULT NULL,        -- e.g. "medusacascade4"
      target_sig      TEXT    DEFAULT NULL,        -- e.g. "all"
      eve_timecode    TEXT    DEFAULT NULL         -- e.g. "2026-05-22 16:34:42.764243"
    );

    CREATE INDEX IF NOT EXISTS idx_jm_received_at  ON jabber_messages (received_at);
    CREATE INDEX IF NOT EXISTS idx_jm_who_pinged   ON jabber_messages (who_pinged);
    CREATE INDEX IF NOT EXISTS idx_jm_sig          ON jabber_messages (sig);
    CREATE INDEX IF NOT EXISTS idx_jm_eve_timecode ON jabber_messages (eve_timecode);
  `);

  console.log('[JabberDb] initialised at', dbPath);
  return jabberDb;
}

// ─── Parser ───────────────────────────────────────────────────────────────────
// Strips the Unicode zero-width / invisible characters EVE embeds after field
// labels before the actual value.  The pattern "Field:​‍﻿ value" contains a
// mix of zero-width joiners (U+200D), zero-width non-joiners (U+200C), and
// other invisible code-points between the colon and the visible text.

function stripInvisible(str) {
  if (!str) return '';
  // Remove zero-width space, ZWNJ, ZWJ, word-joiner, BOM, soft-hyphen, etc.
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\uFFFD]/g, '').trim();
}

// Extract "Field Name: value" from the body, handling invisible chars after colon.
function extractField(body, fieldLabel) {
  // Build a regex that allows zero or more invisible chars between the label and value.
  // We match from the label to end-of-line.
  const invisibleChars = '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u00AD]*';
  const pattern = new RegExp(
    `^${escapeRegex(fieldLabel)}\\s*:${invisibleChars}\\s*(.+)$`,
    'mi'
  );
  const m = body.match(pattern);
  return m ? stripInvisible(m[1]) : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a raw Jabber message body into structured fields.
 * Returns an object ready to be merged into the DB row.
 *
 * Expected format (example):
 *   (6:34:42 PM) directorbot: The pinging will continue until moral improves!...
 *   FC Name:​ MedusaCascade4
 *   Formup Location:​ C-J6MT
 *   PAP Type:​ Strategic
 *   Comms:​ Op 3 https://...
 *   Doctrine:​ SIR (Rorqual > Fax) https://...
 *   ​​​
 *   ~~~ This was a skirmishbot broadcast from medusacascade4 to all at 2026-05-22 16:34:42.764243 EVE ~~~
 */
function parseJabberMessage(body) {
  const result = {
    ping_timestamp:  null,
    who_pinged:      null,
    hurf:            null,
    fc_name:         null,
    formup_location: null,
    pap_type:        null,
    comms:           null,
    doctrine:        null,
    sig:             null,
    gsol_member:     null,
    target_sig:      null,
    eve_timecode:    null,
  };

  if (!body) return result;

  const lines = body.split('\n');

  // ── First line: "(HH:MM:SS AM/PM) sender: hurf text" ─────────────────────
  const headerMatch = lines[0]?.match(/^\(([^)]+)\)\s+([^:]+):\s*(.*)$/);
  if (headerMatch) {
    result.ping_timestamp = headerMatch[1].trim();
    result.who_pinged     = stripInvisible(headerMatch[2]);
    result.hurf           = stripInvisible(headerMatch[3]);
  }

  // ── Structured key:value fields ──────────────────────────────────────────
  result.fc_name         = extractField(body, 'FC Name');
  result.formup_location = extractField(body, 'Formup Location');
  result.pap_type        = extractField(body, 'PAP Type');
  result.comms           = extractField(body, 'Comms');
  result.doctrine        = extractField(body, 'Doctrine');

  // ── Closing ~~~ line ─────────────────────────────────────────────────────
  // "~~~ This was a <sig> broadcast from <gsol_member> to <target_sig> at <eve_timecode> EVE ~~~"
  const closingMatch = body.match(
    /~~~\s*This was a\s+(\S+)\s+broadcast from\s+(\S+)\s+to\s+(\S+)\s+at\s+([\d\-: .]+?)\s+EVE\s*~~~/i
  );
  if (closingMatch) {
    result.sig          = closingMatch[1].trim();
    result.gsol_member  = closingMatch[2].trim();
    result.target_sig   = closingMatch[3].trim();
    result.eve_timecode = closingMatch[4].trim();
  }

  return result;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Insert a single incoming Jabber message into jabber_data.db.
 * msg = { from, type, body, isDirector, raw }  (shape broadcast by main.js)
 */
async function insertJabberMessage(msg) {
  if (!jabberDb) {
    console.warn('[JabberDb] insertJabberMessage called before initJabberDb');
    return null;
  }

  const parsed     = parseJabberMessage(msg.body || '');
  const received_at = new Date().toISOString();

  // node-sqlite3 named parameters require keys to include the ':' prefix.
  // Keys without it silently resolve to index 0 → SQLITE_RANGE error.
  // We keep a separate clean object (no prefix) for the return value so
  // callers (the IPC broadcast, ping-alert popup) get normal field names.
  const bindParams = {
    ':received_at':     received_at,
    ':from_jid':        msg.from        || '',
    ':msg_type':        msg.type        || '',
    ':is_director':     msg.isDirector  ? 1 : 0,
    ':raw_body':        msg.body        || '',
    ':ping_timestamp':  parsed.ping_timestamp,
    ':who_pinged':      parsed.who_pinged,
    ':hurf':            parsed.hurf,
    ':fc_name':         parsed.fc_name,
    ':formup_location': parsed.formup_location,
    ':pap_type':        parsed.pap_type,
    ':comms':           parsed.comms,
    ':doctrine':        parsed.doctrine,
    ':sig':             parsed.sig,
    ':gsol_member':     parsed.gsol_member,
    ':target_sig':      parsed.target_sig,
    ':eve_timecode':    parsed.eve_timecode,
  };

  try {
    const result = await jabberDb.run(`
      INSERT INTO jabber_messages (
        received_at, from_jid, msg_type, is_director, raw_body,
        ping_timestamp, who_pinged, hurf,
        fc_name, formup_location, pap_type, comms, doctrine,
        sig, gsol_member, target_sig, eve_timecode
      ) VALUES (
        :received_at, :from_jid, :msg_type, :is_director, :raw_body,
        :ping_timestamp, :who_pinged, :hurf,
        :fc_name, :formup_location, :pap_type, :comms, :doctrine,
        :sig, :gsol_member, :target_sig, :eve_timecode
      )
    `, bindParams);

    console.log(`[JabberDb] stored message id=${result.lastID} from=${bindParams[':from_jid']} sig=${bindParams[':sig'] || 'n/a'}`);

    // Return a clean row with normal (un-prefixed) field names so IPC
    // broadcasts and the ping-alert popup can read fields by their plain names.
    return {
      id:              result.lastID,
      received_at,
      from_jid:        bindParams[':from_jid'],
      msg_type:        bindParams[':msg_type'],
      is_director:     bindParams[':is_director'],
      raw_body:        bindParams[':raw_body'],
      ping_timestamp:  parsed.ping_timestamp,
      who_pinged:      parsed.who_pinged,
      hurf:            parsed.hurf,
      fc_name:         parsed.fc_name,
      formup_location: parsed.formup_location,
      pap_type:        parsed.pap_type,
      comms:           parsed.comms,
      doctrine:        parsed.doctrine,
      sig:             parsed.sig,
      gsol_member:     parsed.gsol_member,
      target_sig:      parsed.target_sig,
      eve_timecode:    parsed.eve_timecode,
    };
  } catch (e) {
    console.error('[JabberDb] insert failed:', e.message);
    return null;
  }
}

// ─── Read helpers (optional — for future IPC queries) ─────────────────────────

async function getRecentMessages(limit = 100) {
  if (!jabberDb) return [];
  return jabberDb.all(
    'SELECT * FROM jabber_messages ORDER BY id DESC LIMIT ?',
    limit
  );
}

async function getMessagesBySignature(sig, limit = 100) {
  if (!jabberDb) return [];
  return jabberDb.all(
    'SELECT * FROM jabber_messages WHERE sig = ? ORDER BY id DESC LIMIT ?',
    sig, limit
  );
}

async function getMessageById(id) {
  if (!jabberDb) return null;
  return jabberDb.get('SELECT * FROM jabber_messages WHERE id = ?', id) || null;
}

async function wipeJabberDb() {
  // Was silently returning success here if the DB connection wasn't ready —
  // the caller reported "wiped" even though nothing was deleted. A wipe that
  // does nothing must fail loudly, not report success.
  if (!jabberDb) throw new Error('Jabber database is not initialised yet — try again in a moment.');
  await jabberDb.exec('DELETE FROM jabber_messages');
  // Reset the autoincrement sequence so IDs start fresh
  await jabberDb.exec("DELETE FROM sqlite_sequence WHERE name='jabber_messages'");
  console.log('[JabberDb] all messages wiped');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initJabberDb,
  insertJabberMessage,
  parseJabberMessage,   // exported so it can be unit-tested
  getRecentMessages,
  getMessageById,
  getMessagesBySignature,
  wipeJabberDb,
};