'use strict';
//
// ESI hands back a Python repr instead of a string for some player-authored
// names. A ship called "♦ Pegasus" arrives from /characters/{id}/ship/ as the
// literal seventeen ASCII characters u'♦ Pegasus' — quotes, `u` prefix and
// backslash included. Taken from a real character database, where the stored
// value's code points were [117, 39, 92, 117, 50, 54, 54, 54, …].
//
// The risk in fixing it is over-reach: a player can name a ship u'hello', and
// silently stripping its quotes would be a worse bug than the one being fixed.
// Most of what follows is about the strings this must LEAVE ALONE.
const test   = require('node:test');
const assert = require('node:assert');
const { decodeEsiText } = require('../src/shared/esi_text');

// ── The reported case ────────────────────────────────────────────────────────

test('the reported ship name decodes', () => {
  assert.strictEqual(decodeEsiText("u'\\u2666 Pegasus'"), '♦ Pegasus');
  assert.strictEqual(decodeEsiText("u'\\u2666 Pegasus'"), '♦ Pegasus');
});

test('the input really is the ASCII repr, not an already-decoded string', () => {
  // Guards the fixture itself: if this literal ever became a real ♦ the test
  // above would pass while proving nothing.
  const raw = "u'\\u2666 Pegasus'";
  assert.strictEqual(raw.length, 17);
  assert.deepStrictEqual([...raw].slice(0, 8).map(c => c.codePointAt(0)),
    [117, 39, 92, 117, 50, 54, 54, 54]);
});

test('double-quoted reprs decode too', () => {
  assert.strictEqual(decodeEsiText('u"\\u2666 Pegasus"'), '♦ Pegasus');
});

test('several escapes in one name', () => {
  assert.strictEqual(decodeEsiText("u'\\u2665\\u2666\\u2663\\u2660'"), '♥♦♣♠');
  assert.strictEqual(decodeEsiText("u'caf\\xe9'"), 'café');
});

test('astral code points survive', () => {
  // Emoji are two UTF-16 units; a naive String.fromCharCode would mangle them.
  assert.strictEqual(decodeEsiText("u'\\U0001F680 Rocket'"), '\u{1F680} Rocket');
});

// ── What it must not touch ───────────────────────────────────────────────────

test('an ordinary name is returned byte for byte', () => {
  for (const n of ['Super Saver', '*PI Squall', 'Capsule - Selene Rose', 'rapiierrrr',
                   '♦ Pegasus', '', 'u', "u'"]) {
    assert.strictEqual(decodeEsiText(n), n, n);
  }
});

test('a ship genuinely named u\'hello\' keeps its quotes', () => {
  // The whole reason this is gated on containing an escape. Stripping the
  // quotes off a real name would be a worse bug than the one being fixed.
  assert.strictEqual(decodeEsiText("u'hello'"), "u'hello'");
  assert.strictEqual(decodeEsiText('u"hello"'), 'u"hello"');
});

test('quotes must match and must wrap the WHOLE string', () => {
  assert.strictEqual(decodeEsiText("u'\\u2666 Pegasus\""), "u'\\u2666 Pegasus\"");
  assert.strictEqual(decodeEsiText("prefix u'\\u2666'"), "prefix u'\\u2666'");
  assert.strictEqual(decodeEsiText("u'\\u2666' suffix"), "u'\\u2666' suffix");
  assert.strictEqual(decodeEsiText("'\\u2666 Pegasus'"), "'\\u2666 Pegasus'",
    'no u prefix is not a repr');
});

test('a malformed escape aborts the whole decode', () => {
  // Half-decoding is the worst outcome: it produces a plausible-looking name
  // that is silently wrong. Anything unparseable returns the input untouched.
  assert.strictEqual(decodeEsiText("u'\\u26 Pegasus'"), "u'\\u26 Pegasus'", 'short hex');
  assert.strictEqual(decodeEsiText("u'\\uZZZZ'"), "u'\\uZZZZ'", 'not hex');
  assert.strictEqual(decodeEsiText("u'Pegasus\\'"), "u'Pegasus\\'", 'trailing backslash');
  assert.strictEqual(decodeEsiText("u'\\q'"), "u'\\q'", 'unknown escape');
});

test('escaped quotes and backslashes come through', () => {
  assert.strictEqual(decodeEsiText("u'It\\'s \\u2666'"), "It's ♦");
  assert.strictEqual(decodeEsiText("u'back\\\\slash \\u2666'"), 'back\\slash ♦');
});

test('non-strings pass straight through', () => {
  assert.strictEqual(decodeEsiText(null), null);
  assert.strictEqual(decodeEsiText(undefined), undefined);
  assert.strictEqual(decodeEsiText(42), 42);
  const o = { a: 1 };
  assert.strictEqual(decodeEsiText(o), o);
});

test('decoding is idempotent', () => {
  // The next sync re-reads a name this already fixed; running it again must not
  // find a second repr inside the result.
  const once = decodeEsiText("u'\\u2666 Pegasus'");
  assert.strictEqual(decodeEsiText(once), once);
});
