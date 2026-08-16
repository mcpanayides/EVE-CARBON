'use strict';
//
// Every ESI request carries identity, the compatibility date, and no version.
//
// This is the fourth attempt at stopping versioned routes and duplicated bases
// from creeping back. The first three were lint regexes that matched the SHAPE
// of the mistake and were each defeated by writing it differently — renaming the
// base variable, splitting the URL across lines, inlining it as an argument.
//
// These tests assert the OUTPUT instead: what the shared client actually
// produces. A URL builder that emits a version, or a header set missing the
// date, fails here regardless of how the calling code is written.
const test   = require('node:test');
const assert = require('node:assert');

const { Esi, ESI_BASE, ESI_COMPATIBILITY_DATE, APP_USER_AGENT } = require('../src/app_ident');

test('the client builds unversioned URLs', () => {
  for (const path of ['/characters/123/skills', 'characters/123/skills', '/fw/stats', '/status']) {
    const url = Esi.url(path);
    assert.ok(!/\/v[0-9]+\//.test(url), `${url} contains a version segment`);
    assert.ok(url.startsWith(ESI_BASE + '/'), `${url} is not on the one base`);
    assert.match(url, /[?&]datasource=tranquility/);
  }
});

test('extra query parameters survive without a second question mark', () => {
  const url = Esi.url('/markets/10000002/orders', { order_type: 'all', type_id: 34, page: 2 });
  assert.strictEqual((url.match(/\?/g) || []).length, 1, url);
  for (const bit of ['order_type=all', 'type_id=34', 'page=2', 'datasource=tranquility']) {
    assert.ok(url.includes(bit), `${url} is missing ${bit}`);
  }
});

test('every request carries the compatibility date and an identity', () => {
  const h = Esi.headers({ token: 'TOKEN' });
  assert.strictEqual(h['X-Compatibility-Date'], ESI_COMPATIBILITY_DATE);
  assert.strictEqual(h.Authorization, 'Bearer TOKEN');
  assert.strictEqual(h['User-Agent'], APP_USER_AGENT);
});

test('the identity names the app, a contact, and the source', () => {
  // CCP uses this to reach us instead of blocking us — an anonymous client is
  // the one that gets banned rather than emailed.
  assert.match(APP_USER_AGENT, /EVE-Carbon\/\d+\.\d+\.\d+/);
  assert.match(APP_USER_AGENT, /@/);
  assert.match(APP_USER_AGENT, /github\.com/i);
});

test('the renderer swaps User-Agent for X-User-Agent', () => {
  // Chromium silently drops a User-Agent override on fetch(); X-User-Agent is
  // ESI's documented fallback. Getting this wrong makes the app anonymous.
  const h = Esi.headers({ renderer: true });
  assert.ok(!h['User-Agent'], 'renderer must not set User-Agent');
  assert.strictEqual(h['X-User-Agent'], APP_USER_AGENT);
  assert.strictEqual(h['X-Compatibility-Date'], ESI_COMPATIBILITY_DATE);
});

test('extra headers merge without displacing the required ones', () => {
  const h = Esi.headers({ token: 'T', extra: { 'Content-Type': 'application/json' } });
  assert.strictEqual(h['Content-Type'], 'application/json');
  assert.strictEqual(h['X-Compatibility-Date'], ESI_COMPATIBILITY_DATE);
  assert.ok(h['User-Agent']);
});

test('the pinned date is a real, past, hardcoded date', () => {
  // Never `new Date()`: computing it daily would silently re-adopt whatever ESI
  // does next, which is the entire thing pinning exists to prevent.
  assert.match(ESI_COMPATIBILITY_DATE, /^\d{4}-\d{2}-\d{2}$/);
  const pinned = Date.parse(ESI_COMPATIBILITY_DATE);
  assert.ok(isFinite(pinned), 'not a parseable date');
  assert.ok(pinned < Date.now(), 'ESI rejects future compatibility dates');
});

test('isEsi recognises the host and nothing else', () => {
  assert.ok(Esi.isEsi(`${ESI_BASE}/status`));
  // SSO and third parties legitimately use versioned URLs and must not be
  // mistaken for ESI by the wrappers that inject these headers.
  assert.ok(!Esi.isEsi('https://login.eveonline.com/v2/oauth/token'));
  assert.ok(!Esi.isEsi('https://api.eve-scout.com/v2/public/signatures'));
});
