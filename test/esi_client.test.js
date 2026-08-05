'use strict';
//
// The shared ESI client (src/shared/esi.js).
//
// CCP's developer relations reviewed this repo and raised two things:
//
//   1. `const ESI_BASE = 'https://esi.evetech.net'` was declared in EIGHT files,
//      with full URLs hard-coded in a dozen more. Nothing about how we reach ESI
//      could be changed in one place.
//
//   2. Versioned /vN/ routes are the deprecated way of talking to ESI. They keep
//      working, but every NEW route is unversioned-only, so it is a breakage
//      with no date attached.
//
// Point 1 had already cost us: the identity and compatibility date were written
// out three times, and src/html/ping-alert.html sent X-User-Agent but NOT
// X-Compatibility-Date — so that window silently used a different snapshot of
// the API than the rest of the app. These tests hold the single definition.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const Esi = require('../src/shared/esi');
const { APP_USER_AGENT, ESI_COMPATIBILITY_DATE, ESI_BASE } = require('../src/app_ident');

test('app_ident re-exports the shared client rather than redefining it', () => {
  assert.strictEqual(ESI_BASE, Esi.BASE);
  assert.strictEqual(ESI_COMPATIBILITY_DATE, Esi.COMPAT_DATE);
  assert.strictEqual(APP_USER_AGENT, Esi.userAgent());
});

test('the identity carries app, version, contact and source', () => {
  // CCP uses this to reach us instead of blocking us — which is exactly how both
  // the Fuzzwork 404 flood and this review arrived.
  const ua = Esi.userAgent();
  assert.match(ua, /^EVE-Carbon\/\d+\.\d+/, `no version in "${ua}"`);
  assert.match(ua, /@/,      'no contact address');
  assert.match(ua, /\+https:\/\/github\.com\//, 'no source repository');
});

test('the compatibility date is pinned, not computed from today', () => {
  // Computing it daily would silently re-adopt whatever ESI does next, which
  // defeats the entire point of pinning a tested snapshot.
  assert.match(Esi.COMPAT_DATE, /^\d{4}-\d{2}-\d{2}$/);
  const today = new Date().toISOString().slice(0, 10);
  assert.notStrictEqual(Esi.COMPAT_DATE, today, 'looks like new Date() — pin it deliberately');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'esi.js'), 'utf8');
  assert.ok(!/COMPAT_DATE\s*=\s*new Date/.test(src), 'the date must be a literal');
});

test('url() builds unversioned routes', () => {
  const u = Esi.url('/characters/123/wallet/');
  assert.ok(!/\/v\d+\//.test(u), `still versioned: ${u}`);
  assert.match(u, /^https:\/\/esi\.evetech\.net\/characters\/123\/wallet\/\?/);
  assert.match(u, /datasource=tranquility/);
});

test('url() carries extra query parameters', () => {
  const u = Esi.url('/markets/10000002/history/', { type_id: 34 });
  assert.match(u, /type_id=34/);
  assert.match(u, /datasource=tranquility/);
});

test('main and renderer identify differently, on purpose', () => {
  // Chromium silently DROPS User-Agent overrides on fetch(), so the renderer has
  // to use ESI's documented X-User-Agent fallback. Getting this wrong makes us
  // anonymous to CCP.
  const main = Esi.headers();
  const rend = Esi.headers({ renderer: true });
  assert.ok(main['User-Agent'] && !main['X-User-Agent'], 'main sends User-Agent');
  assert.ok(rend['X-User-Agent'] && !rend['User-Agent'], 'renderer sends X-User-Agent');
  assert.strictEqual(main['User-Agent'], rend['X-User-Agent'], 'same identity either way');
});

test('every request carries the compatibility date', () => {
  // The bug this guards: ping-alert.html sent the identity but not the date, so
  // one window quietly ran against a different API snapshot.
  for (const h of [Esi.headers(), Esi.headers({ renderer: true }), Esi.headers({ token: 'x' })]) {
    assert.strictEqual(h['X-Compatibility-Date'], Esi.COMPAT_DATE);
  }
});

test('a token becomes a Bearer header, and is optional', () => {
  assert.strictEqual(Esi.headers({ token: 'abc' }).Authorization, 'Bearer abc');
  assert.ok(!('Authorization' in Esi.headers()), 'no token, no header');
});

test('isEsi recognises our own URLs and nothing else', () => {
  assert.ok(Esi.isEsi('https://esi.evetech.net/status/'));
  assert.ok(Esi.isEsi(Esi.url('/status/')));
  for (const other of ['https://zkillboard.com/api/', 'https://www.fuzzwork.co.uk/blueprint/api/blueprint.php',
                       'https://images.evetech.net/types/587/icon', '', null]) {
    assert.ok(!Esi.isEsi(other), `should not match ${other}`);
  }
});

test('no ESI route in the codebase is still versioned', () => {
  // Belt and braces with the lint rule: 90 of these were migrated at once, and a
  // single missed one would keep us on the deprecated scheme silently.
  const root = path.join(__dirname, '..');
  const skip = new Set(['node_modules', '.git', 'data', 'dist', 'out', 'release', 'test']);
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.join(dir, e.name)); continue; }
      if (!/\.(js|html)$/.test(e.name)) continue;
      const f = path.join(dir, e.name);
      if (path.resolve(f) === path.resolve(__filename)) continue;
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//')) return;
        if (/(?:\$\{ESI_BASE\}|https:\/\/esi\.evetech\.net)\/(?:v\d+|latest)\//.test(line)) {
          hits.push(`${path.relative(root, f)}:${i + 1}`);
        }
      });
    }
  })(root);
  assert.deepStrictEqual(hits, [], `versioned ESI routes remain: ${hits.join(', ')}`);
});
