'use strict';
// Guards how a build chooses where to walk the zKill cursor.
//
// The default MUST stay zKillboard until a fan-out Worker is actually deployed
// and verified: a default pointing at a Worker that does not exist takes the
// intel feed down for every user at once. These cases pin that, and pin that a
// malformed override falls back rather than producing an unusable base.
const test   = require('node:test');
const assert = require('node:assert');
const { resolveZkillBase, DEFAULT_BASE } = require('../src/intel/zkill_stream');

test('unset means zKillboard, unchanged', () => {
  assert.strictEqual(resolveZkillBase({}), DEFAULT_BASE);
  assert.strictEqual(resolveZkillBase({ EVE_CARBON_ZKILL_BASE: '' }), DEFAULT_BASE);
  assert.strictEqual(resolveZkillBase({ EVE_CARBON_ZKILL_BASE: '   ' }), DEFAULT_BASE);
});

test('a worker URL is used as given', () => {
  assert.strictEqual(
    resolveZkillBase({ EVE_CARBON_ZKILL_BASE: 'https://fanout.example.workers.dev' }),
    'https://fanout.example.workers.dev');
});

test('a trailing slash is trimmed', () => {
  // The caller appends `/ephemeral/...`; without this the URL has a double
  // slash, which some origins 404.
  assert.strictEqual(
    resolveZkillBase({ EVE_CARBON_ZKILL_BASE: 'https://fanout.example.workers.dev/' }),
    'https://fanout.example.workers.dev');
  assert.strictEqual(
    resolveZkillBase({ EVE_CARBON_ZKILL_BASE: 'https://fanout.example.workers.dev///' }),
    'https://fanout.example.workers.dev');
});

test('a malformed or non-http value falls back instead of breaking the feed', () => {
  for (const bad of ['not a url', 'file:///etc/passwd', 'ftp://example.test', '://x']) {
    assert.strictEqual(resolveZkillBase({ EVE_CARBON_ZKILL_BASE: bad }), DEFAULT_BASE, bad);
  }
});

test('http is allowed, for a local worker during development', () => {
  assert.strictEqual(
    resolveZkillBase({ EVE_CARBON_ZKILL_BASE: 'http://127.0.0.1:8787' }),
    'http://127.0.0.1:8787');
});

test('a missing env object does not throw', () => {
  assert.doesNotThrow(() => resolveZkillBase(undefined));
  assert.doesNotThrow(() => resolveZkillBase(null));
});
