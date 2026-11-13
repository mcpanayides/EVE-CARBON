// Many EVE clients on one machine: the case the chat-log readers were least
// ready for. Every client in a channel writes its own copy of that channel, and
// the Chatlogs folder grows by a file per channel per character per session.
//
// Pins:
//   - several clients in one intel channel hand each message on ONCE. Before,
//     "follow the most recently written copy" changed hands with every message
//     and each change re-read a whole file: two clients, 20 messages, 243 lines.
//   - the followed client logging off loses nothing and repeats nothing.
//   - a relog follows the new session from its start.
//   - a copy that can't be lined up is joined at its end, never replayed as live.
//   - the folder is listed again only when it gains a file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createChatlogReader, detectOnlineCharacters, lineTimestamp } = require('../src/intel/chatlog_reader');
const { chatlogListing, sessionMayBeLive } = require('../src/intel/chatlog_dir');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'evec-multibox-'));

const header = (channel, listener) => '﻿\r\n\r\n  ---------------------------------------------------------------\r\n\r\n'
  + `  Channel ID:      -69720000\r\n  Channel Name:    ${channel}\r\n  Listener:        ${listener}\r\n`
  + '  Session started: 2026.11.08 10:00:00\r\n  ---------------------------------------------------------------\r\n\r\n';

/** A channel log the way EVE writes one: UTF-16LE, header first. */
function logFile(dir, channel, stamp, characterId, lines = []) {
  const file = path.join(dir, `${channel}_${stamp}_${characterId}.txt`);
  fs.writeFileSync(file, Buffer.from(header(channel, `Pilot ${characterId}`) + lines.map(l => l + '\r\n').join(''), 'utf16le'));
  return file;
}
const append = (file, line) => fs.appendFileSync(file, Buffer.from(line + '\r\n', 'utf16le'));
const touch = (file, secs) => fs.utimesSync(file, secs, secs);
const now = () => Date.now() / 1000;
const msg = (n, who = 'Scout') => `[ 2026.11.08 10:${String(10 + Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')} ] ${who} > 1DQ1-A Hostile${n} nv`;

/** A reader that weighs copies on every tick, collecting the dated lines it hands on. */
function reader(dir, channels = ['delve.imperium']) {
  const got = [];
  const r = createChatlogReader({ dir, channels, pickMs: 0,
    onLine: (line) => { if (lineTimestamp(line) != null) got.push(line.trim()); } });
  return { r, got };
}

test('two clients in one channel: every message is handed on once', () => {
  const dir = tmpdir();
  const a = logFile(dir, 'delve.imperium', '20261108_100000', 90000001);
  const b = logFile(dir, 'delve.imperium', '20261108_100005', 90000002);
  const { r, got } = reader(dir);
  r.tick();
  const sent = [];
  for (let n = 0; n < 20; n++) {
    const line = msg(n);
    sent.push(line);
    // Which client flushes last varies message to message, so the "newest" copy
    // changes hands all the time. That alone must not move the reader.
    const order = n % 3 === 0 ? [b, a] : [a, b];
    const t = now() + n;
    order.forEach((f, i) => { append(f, line); touch(f, t + i * 0.01); });
    r.tick();
  }
  assert.deepStrictEqual(got, sent);
});

test('the followed client logs off: reading carries on from the other copy, nothing lost or repeated', () => {
  const dir = tmpdir();
  const a = logFile(dir, 'delve.imperium', '20261108_100000', 90000001);
  const b = logFile(dir, 'delve.imperium', '20261108_100005', 90000002);
  const { r, got } = reader(dir);
  r.tick();
  for (let n = 0; n < 5; n++) { const t = now() + n; append(a, msg(n)); touch(a, t); append(b, msg(n)); touch(b, t); r.tick(); }

  const followed = path.join(dir, r.status().channels[0].file);
  const other = followed === a ? b : a;
  // Its client is gone: no more lines in our copy, the other carries on.
  for (let n = 5; n < 10; n++) append(other, msg(n));
  touch(followed, now() - 60);
  touch(other, now());
  r.tick();

  assert.deepStrictEqual(got, Array.from({ length: 10 }, (_, n) => msg(n)));
  assert.strictEqual(path.join(dir, r.status().channels[0].file), other, 'now following the copy still being written');
});

test('a relog follows the new session from its first line', () => {
  const dir = tmpdir();
  const old = logFile(dir, 'delve.imperium', '20261108_100000', 90000001);
  const { r, got } = reader(dir);
  r.tick();
  for (let n = 0; n < 3; n++) { append(old, msg(n)); r.tick(); }

  // Same character, newer session: the old file stops for good.
  logFile(dir, 'delve.imperium', '20261108_120000', 90000001, [msg(3), msg(4)]);
  r.tick();
  assert.deepStrictEqual(got, [msg(0), msg(1), msg(2), msg(3), msg(4)]);
});

test('a copy that cannot be lined up is joined at its end, not replayed as live', () => {
  // Our copy has read nothing dated yet; the other holds an hour of history.
  // Lining up on the header (the same in every copy) would replay all of it as
  // live reports, firing alerts for gangs long gone.
  const dir = tmpdir();
  const ours = logFile(dir, 'delve.imperium', '20261108_100000', 90000001);
  const theirs = logFile(dir, 'delve.imperium', '20261108_090000', 90000002,
    Array.from({ length: 30 }, (_, n) => msg(n, 'Old')));
  touch(theirs, now() - 30);
  touch(ours, now());
  const { r, got } = reader(dir);
  r.tick();
  assert.strictEqual(path.join(dir, r.status().channels[0].file), ours);

  touch(ours, now() - 60);
  touch(theirs, now());
  r.tick();
  assert.deepStrictEqual(got, [], 'none of the history');

  append(theirs, msg(40));
  r.tick();
  assert.deepStrictEqual(got, [msg(40)], 'and what arrives next is read');
});

test('the folder is listed again when it gains a file, not when one is written to', () => {
  const dir = tmpdir();
  const f = logFile(dir, 'Local', '20261108_100000', 90000001);
  const v1 = chatlogListing(dir).version;
  append(f, msg(1));
  append(f, msg(2));
  assert.strictEqual(chatlogListing(dir).version, v1, 'appends leave the listing alone');

  logFile(dir, 'Local', '20261108_110000', 90000001);
  assert.notStrictEqual(chatlogListing(dir).version, v1, 'a new session file is noticed at once');
});

test('the listing keeps only the newest two files per channel and character', () => {
  const dir = tmpdir();
  for (const stamp of ['20261101_100000', '20261108_100000', '20261103_100000', '20261107_100000']) {
    logFile(dir, 'Local', stamp, 90000001);
  }
  const local = chatlogListing(dir).channels.get('local');
  assert.deepStrictEqual(local.byChar.get(90000001).map(e => e.stamp), ['20261108100000', '20261107100000']);
});

test('only a session started within a day of the newest can still be running', () => {
  assert.strictEqual(sessionMayBeLive('20261108090000', '20261108100000'), true);
  assert.strictEqual(sessionMayBeLive('20261107110000', '20261108100000'), true, 'yesterday, inside the day');
  assert.strictEqual(sessionMayBeLive('20261105100000', '20261108100000'), false, 'three days ago');
});

test('online characters are the ones whose logs were written in the last ten minutes', () => {
  const dir = tmpdir();
  const live = logFile(dir, 'Local', '20261108_100000', 90000001);
  const quiet = logFile(dir, 'Local', '20261108_100500', 90000002);
  touch(live, now());
  touch(quiet, now() - 2 * 3600);
  const online = detectOnlineCharacters(dir);
  assert.deepStrictEqual(online.map(c => c.characterId), [90000001]);
  assert.deepStrictEqual(online[0].channels, ['Local']);
});
