'use strict';
//
// The opt-in diagnostic log.
//
// Most of this file is about ONE risk. The bug report tool opens a public GitHub
// issue, and this app holds EVE SSO access and refresh tokens. A token pasted
// into a public tracker is a full account compromise the reporter cannot undo —
// the issue is indexed within minutes and the log cannot be unpublished.
//
// So redaction is tested as a security control, not as a formatting nicety, and
// the bias throughout is that over-redacting is free while under-redacting is
// not recoverable.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const log = require('../src/file_log');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-log-'));

/** A fresh log in a throwaway directory, torn down by the caller. */
function fresh() {
  const dir = tmpDir();
  log.stop();
  log.init({ userDataPath: dir, config: {} });
  log.setEnabled(true);
  return {
    dir,
    file: path.join(dir, log.LOG_NAME),
    read: () => { try { return fs.readFileSync(path.join(dir, log.LOG_NAME), 'utf8'); } catch { return ''; } },
    done: () => { log.stop(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// ── Redaction ─────────────────────────────────────────────────────────────────

test('a JWT never reaches the file, wherever it appears', () => {
  // This is the shape an ESI access token takes.
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJDSEFSQUNURVI6RVZFOjEyMyJ9.c2lnbmF0dXJl';
  for (const line of [
    `token=${jwt}`,
    `Authorization: Bearer ${jwt}`,
    `{"access_token":"${jwt}","expires_in":1199}`,
    `request failed with ${jwt} attached`,
  ]) {
    const out = log.redact(line);
    assert.ok(!out.includes(jwt), `LEAKED: ${out}`);
    assert.ok(!out.includes('eyJhbGciOiJSUzI1NiJ9'), `LEAKED header: ${out}`);
  }
});

test('access and refresh tokens are scrubbed in every syntax they appear in', () => {
  // Refresh tokens are the dangerous ones: they do not expire on their own.
  const secret = 'gEy9Q7xKPl2mNvA8sZzWq4RtYu6IoP0dFgHjKlZxCvBnM';
  for (const line of [
    `{"refresh_token":"${secret}"}`,
    `refresh_token=${secret}`,
    `refreshToken: ${secret}`,
    `{"access_token": "${secret}"}`,
    `access-token = ${secret}`,
    `client_secret=${secret}`,
  ]) {
    const out = log.redact(line);
    assert.ok(!out.includes(secret), `LEAKED: ${line} -> ${out}`);
    assert.match(out, /\[redacted\]/);
  }
});

test('the OAuth callback code is scrubbed — it is exchangeable for tokens', () => {
  const out = log.redact('https://localhost/callback?code=AbCd1234xyz&state=nonce987');
  assert.ok(!out.includes('AbCd1234xyz'), out);
  assert.ok(!out.includes('nonce987'), out);
});

test('a bare Bearer header is scrubbed even when the token is not a JWT', () => {
  const out = log.redact('Authorization: Bearer abc123-opaque_token~value');
  assert.ok(!out.includes('abc123-opaque_token'), out);
  assert.match(out, /Bearer \[redacted\]/);
});

test("the user's home directory is scrubbed — a bug report should not publish a real name", () => {
  const home = 'C:\\Users\\Jane Smith';
  const out = log.redact(`could not read ${home}\\AppData\\Roaming\\config.json`, home);
  assert.ok(!out.includes('Jane Smith'), out);
  assert.match(out, /~/);
  // Node hands back forward slashes in plenty of places.
  const fwd = log.redact('failed at C:/Users/Jane Smith/Documents/x', home);
  assert.ok(!fwd.includes('Jane Smith'), fwd);
});

test('ordinary diagnostic text survives intact', () => {
  // Redaction that eats the message defeats the point of the log.
  const line = 'ESI 420 on /v1/characters/95465499/assets — error budget exhausted, backing off 63s';
  assert.strictEqual(log.redact(line), line);
});

test('redaction is applied on the way IN, so the file on disk is already safe', () => {
  // Scrubbing only at read time would leave the secret sitting on the user's
  // disk, one forgotten code path away from being published anyway.
  const t = fresh();
  try {
    log.write('error', 'test', 'auth failed: {"refresh_token":"SUPERSECRETVALUE"}');
    const onDisk = t.read();
    assert.ok(onDisk.length > 0, 'something was written');
    assert.ok(!onDisk.includes('SUPERSECRETVALUE'), `LEAKED TO DISK: ${onDisk}`);
  } finally { t.done(); }
});

test('the tail is scrubbed again on the way out', () => {
  // Belt and braces: this is the text that actually gets published.
  const t = fresh();
  try {
    fs.appendFileSync(t.file, 'hand-edited line with Bearer eyJhbGciOi.JzdWIiOiJ4.c2ln\n');
    const out = log.tail();
    assert.ok(!out.includes('eyJhbGciOi.JzdWIiOiJ4.c2ln'), out);
  } finally { t.done(); }
});

// ── Behaviour ─────────────────────────────────────────────────────────────────

test('nothing is written until it is switched on', () => {
  const dir = tmpDir();
  try {
    log.stop();
    log.init({ userDataPath: dir, config: {} });
    assert.strictEqual(log.isEnabled(), false, 'recording is not something to start unasked');
    log.write('info', 'test', 'should not appear');
    assert.strictEqual(fs.existsSync(path.join(dir, log.LOG_NAME)), false, 'no file at all');
  } finally { log.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config can turn it on at boot', () => {
  const dir = tmpDir();
  try {
    log.stop();
    log.init({ userDataPath: dir, config: { app: { fileLog: true } } });
    assert.strictEqual(log.isEnabled(), true);
    assert.match(log.stat().path, /eve-carbon\.log$/);
  } finally { log.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('switching off stops writing, and switching on resumes', () => {
  const t = fresh();
  try {
    log.write('info', 'test', 'FIRST');
    log.setEnabled(false);
    log.write('info', 'test', 'WHILE-OFF');
    log.setEnabled(true);
    log.write('info', 'test', 'SECOND');
    const out = t.read();
    assert.match(out, /FIRST/);
    assert.match(out, /SECOND/);
    assert.ok(!out.includes('WHILE-OFF'), 'wrote while disabled');
  } finally { t.done(); }
});

test('one entry is one line, however many newlines the message had', () => {
  // tail() counts lines, so a multi-line stack trace must not read as 20 entries.
  const t = fresh();
  try {
    log.write('error', 'test', 'Error: boom\n  at foo()\n  at bar()');
    const lines = t.read().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, 'the start marker plus one entry');
    assert.match(lines[1], /at foo\(\).*at bar\(\)/);
  } finally { t.done(); }
});

test('the tail returns the newest lines, bounded', () => {
  const t = fresh();
  try {
    for (let i = 0; i < 400; i++) log.write('info', 'test', `line-${i}`);
    const out = log.tail({ lines: 20, chars: 100_000 });
    const got = out.split('\n').filter(Boolean);
    assert.strictEqual(got.length, 20);
    assert.match(got[got.length - 1], /line-399/, 'newest last');
    assert.ok(!out.includes('line-100 '), 'older lines dropped');
  } finally { t.done(); }
});

test('the tail is capped by characters too, because it ships inside a URL', () => {
  // A GitHub issue is submitted as a URL and an oversized one silently fails to
  // open rather than erroring, so this bound has to hold independently.
  const t = fresh();
  try {
    for (let i = 0; i < 200; i++) log.write('info', 'test', 'x'.repeat(300));
    const out = log.tail({ lines: 200, chars: 1000 });
    assert.ok(out.length <= 1002, `tail was ${out.length} chars`);
  } finally { t.done(); }
});

test('an empty or missing log tails to nothing rather than throwing', () => {
  const dir = tmpDir();
  try {
    log.stop();
    log.init({ userDataPath: dir, config: {} });
    assert.strictEqual(log.tail(), '');
    assert.doesNotThrow(() => log.stat());
    assert.strictEqual(log.stat().exists, false);
  } finally { log.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clearing removes the file and keeps logging', () => {
  const t = fresh();
  try {
    log.write('info', 'test', 'BEFORE-CLEAR');
    log.clear();
    assert.ok(!t.read().includes('BEFORE-CLEAR'));
    log.write('info', 'test', 'AFTER-CLEAR');
    assert.match(t.read(), /AFTER-CLEAR/);
  } finally { t.done(); }
});

test('stat reports where the file is and how big it has got', () => {
  const t = fresh();
  try {
    log.write('info', 'test', 'x'.repeat(500));
    const s = log.stat();
    assert.strictEqual(s.enabled, true);
    assert.ok(s.bytes > 400, `bytes was ${s.bytes}`);
    assert.strictEqual(s.dir, t.dir);
  } finally { t.done(); }
});

test('the main-process console is mirrored, and still prints', () => {
  // Main-process errors are what a bug report is missing today: they go to a
  // terminal nobody packaged, so a crash in a background poller is invisible.
  const t = fresh();
  const original = console.warn;
  let printed = 0;
  try {
    // init() already wrapped console; prove the wrapper still calls through.
    console.warn = (...a) => { printed++; original(...a); };
    log.stop();
    log.init({ userDataPath: t.dir, config: {} });
    log.setEnabled(true);
    console.warn('[test] a background poller fell over');
    assert.ok(printed > 0, 'the original console still ran');
    assert.match(t.read(), /a background poller fell over/);
  } finally {
    console.warn = original;
    t.done();
  }
});

test('a console line carrying a token is scrubbed like any other', () => {
  const t = fresh();
  try {
    console.error('token refresh failed: {"refresh_token":"LEAKYVALUE123"}');
    assert.ok(!t.read().includes('LEAKYVALUE123'), 'LEAKED via console capture');
  } finally { t.done(); }
});

test('writing never throws into the caller', () => {
  // Every call site is code that was just trying to log something.
  const t = fresh();
  try {
    assert.doesNotThrow(() => log.write('info', 'test', undefined));
    assert.doesNotThrow(() => log.write(null, null, null));
    const circular = {}; circular.self = circular;
    assert.doesNotThrow(() => console.log('circular', circular));
  } finally { t.done(); }
});
