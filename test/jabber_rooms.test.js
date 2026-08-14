'use strict';
//
// Jabber chat rooms — the per-room storage and unread accounting that the rail's
// badges are built on. Runs against a real SQLite database in a temp directory,
// because the behaviour under test IS the SQL: the room/ping split is a WHERE
// clause, and the unread count is a join against a read marker. Mocking that out
// would leave the only interesting part untested.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const db = require('../src/jabber_data_db');

const ROOM_A = 'corp@conference.example.com';
const ROOM_B = 'alliance@conference.example.com';

function roomMsg(roomJid, nick, body) {
  return { from: `${roomJid}/${nick}`, type: 'groupchat', body, isDirector: false,
           raw: '', roomJid, senderNick: nick };
}

let dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evecarbon-jabber-'));
  await db.initJabberDb(dir, dir);
});
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

test('room messages are stored against their room and kept out of the ping feed', async () => {
  await db.insertJabberMessage(roomMsg(ROOM_A, 'pilotone', 'first'));
  await db.insertJabberMessage(roomMsg(ROOM_A, 'pilottwo', 'second'));
  await db.insertJabberMessage(roomMsg(ROOM_B, 'pilotone', 'elsewhere'));
  // A director broadcast: no room, and it must not leak into a room view.
  await db.insertJabberMessage({ from: 'directorbot@example.com', type: 'chat',
                                 body: 'ping body', isDirector: true, raw: '' });

  const a = await db.getRoomMessages(ROOM_A);
  assert.deepStrictEqual(a.map(m => m.raw_body), ['first', 'second'], 'oldest first');
  assert.ok(a.every(m => m.room_jid === ROOM_A));

  const b = await db.getRoomMessages(ROOM_B);
  assert.strictEqual(b.length, 1);

  // The ping the widget reads is still the director broadcast, not room chatter.
  const latest = await db.getLatestDirectorMessage();
  assert.strictEqual(latest.raw_body, 'ping body');
});

test('unread counts distinct speakers, not messages', async () => {
  const before = await db.getRoomUnread([ROOM_A]);
  // pilotone + pilottwo have spoken; three messages exist across both rooms.
  assert.strictEqual(before[ROOM_A].speakers, 2);
  assert.strictEqual(before[ROOM_A].messages, 2);

  // One person talking a lot is still one person to catch up with.
  for (let i = 0; i < 8; i++) await db.insertJabberMessage(roomMsg(ROOM_A, 'pilotone', `spam ${i}`));
  const noisy = await db.getRoomUnread([ROOM_A]);
  assert.strictEqual(noisy[ROOM_A].speakers, 2, 'still two distinct speakers');
  assert.strictEqual(noisy[ROOM_A].messages, 10);
});

test('opening a room clears its badge and only its badge', async () => {
  await db.markRoomRead(ROOM_A);

  const after = await db.getRoomUnread([ROOM_A, ROOM_B]);
  assert.strictEqual(after[ROOM_A].speakers, 0, 'read room is clear');
  assert.strictEqual(after[ROOM_A].messages, 0);
  assert.strictEqual(after[ROOM_B].speakers, 1, 'the other room is untouched');

  // New traffic after the marker counts again.
  await db.insertJabberMessage(roomMsg(ROOM_A, 'pilotthree', 'later'));
  const later = await db.getRoomUnread([ROOM_A]);
  assert.strictEqual(later[ROOM_A].speakers, 1);
  assert.strictEqual(later[ROOM_A].messages, 1);
});

test('the read marker survives being set twice and never goes backwards', async () => {
  const first = await db.markRoomRead(ROOM_A);
  const again = await db.markRoomRead(ROOM_A);
  assert.strictEqual(first, again, 'no new messages, same marker');

  const unread = await db.getRoomUnread([ROOM_A]);
  assert.strictEqual(unread[ROOM_A].messages, 0);
  assert.strictEqual(unread[ROOM_A].lastReadId, again);
});

test('a room with no messages reports zero rather than failing', async () => {
  const empty = await db.getRoomUnread(['quiet@conference.example.com']);
  assert.deepStrictEqual(empty['quiet@conference.example.com'],
    { messages: 0, speakers: 0, lastReadId: 0 });
  assert.deepStrictEqual(await db.getRoomMessages('quiet@conference.example.com'), []);
  assert.deepStrictEqual(await db.getRoomUnread([]), {});
});

// ─── Archived history storage ────────────────────────────────────────────────
// The server re-sends the same archived messages on every history pull, so the
// archive id is what keeps a room from growing a duplicate copy of itself each
// time you press "Load older".
const ROOM_C = 'archive@conference.example.com';

test('an archived message is stored once, however many times it is pulled', async () => {
  const archived = {
    from: `${ROOM_C}/pilotone`, type: 'groupchat', body: 'from the archive',
    isDirector: false, raw: '', roomJid: ROOM_C, senderNick: 'pilotone',
    stanzaId: 'archive-id-1', receivedAt: '2026-07-01T10:00:00.000Z',
  };

  const first = await db.insertJabberMessage(archived);
  assert.ok(first, 'first pull stores it');

  // Same message from a later page, or a re-join replaying history.
  assert.strictEqual(await db.insertJabberMessage(archived), null, 'second pull is a no-op');
  assert.strictEqual(await db.insertJabberMessage({ ...archived, body: 'edited?' }), null,
    'matched on archive id, not on body');

  const rows = await db.getRoomMessages(ROOM_C);
  assert.strictEqual(rows.length, 1);
});

test('archived messages keep the time they were sent, not the time they loaded', async () => {
  const rows = await db.getRoomMessages(ROOM_C);
  assert.strictEqual(rows[0].received_at, '2026-07-01T10:00:00.000Z');
  assert.strictEqual(rows[0].stanza_id, 'archive-id-1');
});

test('the same archive id in a different room is a different message', async () => {
  const other = 'other@conference.example.com';
  const stored = await db.insertJabberMessage({
    from: `${other}/pilotone`, type: 'groupchat', body: 'elsewhere', isDirector: false,
    raw: '', roomJid: other, senderNick: 'pilotone',
    stanzaId: 'archive-id-1', receivedAt: '2026-07-01T10:00:00.000Z',
  });
  assert.ok(stored, 'archive ids are only unique within a room');
});

test('the oldest archive id is what the next page is fetched before', async () => {
  await db.insertJabberMessage({
    from: `${ROOM_C}/pilottwo`, type: 'groupchat', body: 'newer', isDirector: false,
    raw: '', roomJid: ROOM_C, senderNick: 'pilottwo',
    stanzaId: 'archive-id-2', receivedAt: '2026-07-02T10:00:00.000Z',
  });
  assert.strictEqual(await db.getRoomOldestArchiveId(ROOM_C), 'archive-id-1');
  // A room with no archived messages has no anchor — the first page is fetched
  // from the most recent end instead.
  assert.strictEqual(await db.getRoomOldestArchiveId('empty@conference.example.com'), null);
});

test('live messages without an archive id are unaffected by the dedupe', async () => {
  const live = { from: `${ROOM_C}/pilotthree`, type: 'groupchat', body: 'same text',
                 isDirector: false, raw: '', roomJid: ROOM_C, senderNick: 'pilotthree' };
  assert.ok(await db.insertJabberMessage(live));
  assert.ok(await db.insertJabberMessage(live), 'identical live messages are both real');
});

// ─── The broadcast feed must not carry room chat ─────────────────────────────
// The ping feed's history query used to be a bare SELECT *, so every page load
// re-filled the broadcast table with the entire contents of every chat room. The
// two feeds read the same table through opposite filters; this is the filter.
test('the broadcast history excludes every room message', async () => {
  const room = 'noise@conference.example.com';
  for (let i = 0; i < 25; i++) {
    await db.insertJabberMessage(roomMsg(room, `talker${i % 4}`, `chatter ${i}`));
  }
  await db.insertJabberMessage({
    from: 'directorbot@example.com', type: 'chat', isDirector: true, raw: '',
    body: 'This was a test broadcast',
  });

  const feed = await db.getRecentMessages(200);
  assert.ok(feed.length > 0, 'the feed should still have broadcasts in it');
  assert.ok(feed.every(m => m.room_jid == null),
    `room chat leaked into the broadcast feed: ${feed.filter(m => m.room_jid).length} rows`);
  assert.ok(feed.some(m => m.raw_body === 'This was a test broadcast'));

  // And the room still has its own history, read through the other filter.
  const roomRows = await db.getRoomMessages(room);
  assert.strictEqual(roomRows.length, 25);
});

test('a room with hundreds of lines cannot crowd out the broadcasts', async () => {
  const busy = 'busy@conference.example.com';
  for (let i = 0; i < 300; i++) {
    await db.insertJabberMessage(roomMsg(busy, 'spammer', `line ${i}`));
  }
  // Newest-first with a limit: before the fix, 300 lines of room chat would fill
  // the whole page and push every broadcast off the end.
  const feed = await db.getRecentMessages(50);
  assert.ok(feed.every(m => m.room_jid == null));
});
