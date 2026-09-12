'use strict';
//
// Planet hero art is the one PI asset the renderer cannot address itself.
//
// assets/ is copied to resources/ by build.extraResources, which puts it
// OUTSIDE the asar, so a path relative to src/index.html resolves to nothing in
// a packaged build. Main resolves the directory and hands back file:// URLs.
// That makes the renderer side a cache around one IPC call, and the thing worth
// pinning down is its failure behaviour: every path has to end in a usable
// object, because openPIDetail awaits this before it can render the panel at
// all. A throw here would take the whole detail modal down with it.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

function load(planetArt) {
  const noop = () => {};
  const sb = {
    console, Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number,
    Boolean, RegExp, Error, isNaN, parseFloat, parseInt, setTimeout, clearTimeout,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { eveAPI: planetArt ? { planetArt } : {}, addEventListener: noop },
    escHtml: (s) => String(s),
    localStorage: { getItem: () => null, setItem: noop },
    fetch: () => Promise.reject(new Error('no net')),
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'planetary-interaction.js'), 'utf8'),
    ctx, { filename: 'planetary-interaction.js' });
  return sb;
}

test('the art map comes back keyed by planet type', async () => {
  const sb = load(async () => ({ ice: 'file:///art/ice.jpg', gas: 'file:///art/gas.jpg' }));
  const art = await sb.piPlanetArt();
  // Cross-realm objects fail deepStrictEqual, so compare shape and values.
  assert.strictEqual(Object.keys(art).sort().join(','), 'gas,ice');
  assert.strictEqual(art.ice, 'file:///art/ice.jpg');
});

test('the IPC call happens once, however many colonies are opened', async () => {
  let calls = 0;
  const sb = load(async () => { calls++; return { ice: 'file:///art/ice.jpg' }; });
  await sb.piPlanetArt();
  await sb.piPlanetArt();
  await sb.piPlanetArt();
  assert.strictEqual(calls, 1, 'art cannot change while the app runs — resolve it once');
});

test('a rejected lookup yields an empty map, not a rejected promise', async () => {
  const sb = load(async () => { throw new Error('ipc gone'); });
  const art = await sb.piPlanetArt();
  assert.strictEqual(Object.keys(art).length, 0);
});

test('a preload without planetArt still resolves', async () => {
  // Guards the upgrade path: a renderer running against an older preload that
  // has no planetArt must fall through to CCP's icons rather than throw.
  const sb = load(null);
  const art = await sb.piPlanetArt();
  assert.strictEqual(Object.keys(art).length, 0);
});

test('every shipped file is named for a real planet type key', () => {
  // The filename IS the lookup key, so a typo silently costs that planet its
  // art with no error anywhere. Pin the shipped names against the type table.
  const dir   = path.join(__dirname, '..', 'assets', 'planets');
  const keys  = new Set(['temperate','oceanic','ice','gas','lava','barren','storm','plasma','shattered']);
  const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|webp|png|avif)$/i.test(f));
  for (const f of files) {
    assert.ok(keys.has(f.replace(/\.[^.]+$/, '')), `${f} does not match any planet type key`);
  }
});
