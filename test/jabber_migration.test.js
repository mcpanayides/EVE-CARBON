'use strict';
//
// Upgrading an existing jabber_data.db.
//
// Every other test in this suite starts from an empty directory, so the schema
// is created complete and the migration path is never touched. That is exactly
// how a shipped upgrade broke: on a database that predated chat rooms,
// CREATE TABLE IF NOT EXISTS was a no-op, the index on room_jid failed with
// "no such column: room_jid", the whole exec() aborted, and the ALTER TABLE that
// would have added the column never ran — so every room message failed to store.
//
// These tests open a database built with the OLD schema, exactly as a returning
// user's would be, and assert the upgrade completes and preserves their data.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const db = require('../src/jabber_data_db');

// The schema as it shipped before rooms: no room_jid, sender_nick or stanza_id.
const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jabber_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at     TEXT    NOT NULL,
    from_jid        TEXT    NOT NULL DEFAULT '',
    msg_type        TEXT    NOT NULL DEFAULT '',
    is_director     INTEGER NOT NULL DEFAULT 0,
    raw_body        TEXT    NOT NULL DEFAULT '',
    ping_timestamp  TEXT    DEFAULT NULL,
    who_pinged      TEXT    DEFAULT NULL,
    hurf            TEXT    DEFAULT NULL,
    fc_name         TEXT    DEFAULT NULL,
    formup_location TEXT    DEFAULT NULL,
    pap_type        TEXT    DEFAULT NULL,
    comms           TEXT    DEFAULT NULL,
    doctrine        TEXT    DEFAULT NULL,
    sig             TEXT    DEFAULT NULL,
    gsol_member     TEXT    DEFAULT NULL,
    target_sig      TEXT    DEFAULT NULL,
    eve_timecode    TEXT    DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jm_received_at ON jabber_messages (received_at);
`;

let dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evecarbon-jabber-upgrade-'));

  // Build the user's existing database, with a ping already in it.
  const legacy = await open({ filename: path.join(dir, 'jabber_data.db'), driver: sqlite3.Database });
  await legacy.exec(LEGACY_SCHEMA);
  await legacy.run(
    `INSERT INTO jabber_messages (received_at, from_jid, msg_type, is_director, raw_body, who_pinged)
     VALUES (?, ?, ?, 1, ?, ?)`,
    '2026-07-01T09:00:00.000Z', 'directorbot@example.com', 'chat', 'an old ping', 'somedirector');
  await legacy.close();
});

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

test('opening an old database upgrades it instead of throwing', async () => {
  // The bug surfaced here: this call rejected on "no such column: room_jid".
  await db.initJabberDb(dir, dir);
});

test('the room columns exist after the upgrade', async () => {
  const conn = await open({ filename: path.join(dir, 'jabber_data.db'), driver: sqlite3.Database });
  const cols = (await conn.all('PRAGMA table_info(jabber_messages)')).map(c => c.name);
  await conn.close();
  for (const col of ['room_jid', 'sender_nick', 'stanza_id']) {
    assert.ok(cols.includes(col), `${col} was not added`);
  }
});

test('room messages store on an upgraded database', async () => {
  const room = 'upgraded@conference.example.com';
  const stored = await db.insertJabberMessage({
    from: `${room}/pilotone`, type: 'groupchat', body: 'hello from a room',
    isDirector: false, raw: '', roomJid: room, senderNick: 'pilotone',
  });
  assert.ok(stored, 'insert returned nothing — the column is still missing');
  assert.strictEqual(stored.room_jid, room);

  const rows = await db.getRoomMessages(room);
  assert.deepStrictEqual(rows.map(r => r.raw_body), ['hello from a room']);
});

test('the archive index and read-marker table came with the upgrade', async () => {
  // These live in the same batch as the failing index, so they were collateral.
  const room = 'upgraded@conference.example.com';
  const archived = {
    from: `${room}/pilottwo`, type: 'groupchat', body: 'archived line', isDirector: false,
    raw: '', roomJid: room, senderNick: 'pilottwo',
    stanzaId: 'mig-1', receivedAt: '2026-06-01T00:00:00.000Z',
  };
  assert.ok(await db.insertJabberMessage(archived));
  assert.strictEqual(await db.insertJabberMessage(archived), null, 'dedupe is not in force');

  assert.strictEqual(await db.markRoomRead(room) > 0, true, 'read markers do not work');
  const unread = await db.getRoomUnread([room]);
  assert.strictEqual(unread[room].messages, 0);
});

test('the pings that were already there survived', async () => {
  const ping = await db.getLatestDirectorMessage();
  assert.strictEqual(ping.raw_body, 'an old ping');
  assert.strictEqual(ping.who_pinged, 'somedirector');
  assert.strictEqual(ping.room_jid, null, 'an old ping is not a room message');
});
