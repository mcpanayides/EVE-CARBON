'use strict';
//
// src/region_layout.js is a port of _regionForceLayout() in src/func/map.js, and
// map.js still runs its own copy whenever the worker pool is unavailable. Two
// implementations of the same maths silently drifting apart would mean the map
// looks different depending on whether the workers happened to succeed — the
// worst kind of bug, because it reproduces intermittently.
//
// So this test doesn't approximate the renderer's version: it EXTRACTS it from
// map.js and runs it, comparing positions exactly.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const { regionForceLayout } = require('../src/region_layout');

const MAP_JS = path.join(__dirname, '..', 'src', 'func', 'map.js');

// Pull _regionForceLayout out of map.js as source text. It is a top-level
// declaration, so it runs from `function _regionForceLayout` to the first
// closing brace in column 0.
function extractRendererImpl() {
  const src   = fs.readFileSync(MAP_JS, 'utf8');
  const start = src.indexOf('function _regionForceLayout(');
  assert.notStrictEqual(start, -1,
    '_regionForceLayout has been renamed or removed from map.js — this test must be updated with it');
  const end = src.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, 'could not find the end of _regionForceLayout');
  const body = src.slice(start, end + 2);

  // It closes over module-global _sysById for seed positions; give it one.
  // eslint-disable-next-line no-new-func
  const make = new Function('_sysById', `${body}; return _regionForceLayout;`);
  return (ids, adj, seeds) => {
    const sysById = {};
    for (const id of ids) sysById[id] = { wx: seeds[id][0], wz: seeds[id][1] };
    const adjMap = adj instanceof Map ? adj : new Map(Object.entries(adj).map(([k, v]) => [Number(k), v]));
    return make(sysById)(ids, adjMap);
  };
}

// Deterministic pseudo-random graphs — a fixed seed so a failure is reproducible.
// Math.random would make a mismatch impossible to re-run.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Shaped like a real region: a spanning chain (every system reachable) plus
// extra gates, seeded from scattered "true" star positions.
function makeRegion(seed, n) {
  const rnd  = lcg(seed);
  const ids  = Array.from({ length: n }, (_, i) => 30000000 + i);
  const adj  = {};
  const seeds = {};
  for (const id of ids) { adj[id] = []; seeds[id] = [rnd() * 1000 - 500, rnd() * 1000 - 500]; }
  const link = (a, b) => { adj[a].push(b); adj[b].push(a); };
  for (let i = 1; i < n; i++) link(ids[i], ids[Math.floor(rnd() * i)]);
  for (let k = 0; k < n / 3; k++) {
    const a = ids[Math.floor(rnd() * n)], b = ids[Math.floor(rnd() * n)];
    if (a !== b) link(a, b);
  }
  return { ids, adj, seeds };
}

test('the ported kernel matches the renderer\'s copy exactly', () => {
  const renderer = extractRendererImpl();
  // Sizes spanning the real range: tiny constellations up to Domain (189).
  for (const [seed, n] of [[1, 5], [2, 17], [3, 40], [4, 96], [5, 189]]) {
    const { ids, adj, seeds } = makeRegion(seed, n);
    const mine  = regionForceLayout(ids, adj, seeds);
    const theirs = [...renderer(ids, adj, seeds)];

    assert.strictEqual(mine.length, theirs.length, `region n=${n}: different system count`);
    for (let i = 0; i < mine.length; i++) {
      const [idA, a] = mine[i], [idB, b] = theirs[i];
      assert.strictEqual(idA, idB, `region n=${n}: systems came back in a different order at ${i}`);
      // Identical operations in identical order — this should be bit-exact, not
      // merely close. A tolerance here would hide exactly the drift being tested.
      assert.strictEqual(a.x, b.x, `region n=${n}, system ${idA}: x drifted (${a.x} vs ${b.x})`);
      assert.strictEqual(a.z, b.z, `region n=${n}, system ${idA}: z drifted (${a.z} vs ${b.z})`);
    }
  }
});

test('returns clone-safe pairs, not a Map', () => {
  // The worker posts this across a thread boundary. A Map would survive
  // structured clone, but the renderer consumes `new Map(pairs)` — so the array
  // shape is load-bearing, not incidental.
  const { ids, adj, seeds } = makeRegion(9, 12);
  const out = regionForceLayout(ids, adj, seeds);
  assert.ok(Array.isArray(out), 'must be an array');
  assert.ok(Array.isArray(out[0]) && out[0].length === 2, 'entries must be [id, {x,z}] pairs');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), out, 'must survive a serialisation round trip');
});

test('degenerate regions do not throw', () => {
  assert.deepStrictEqual(regionForceLayout([], {}, {}), []);
  assert.strictEqual(regionForceLayout([1], {}, { 1: [5, 5] }).length, 1, 'a one-system region still lays out');
  // A system with no seed entry: the kernel treats it as the origin rather than
  // producing NaN, which would poison the whole region's centring.
  const out = regionForceLayout([1, 2], { 1: [2], 2: [1] }, { 1: [0, 0] });
  for (const [, p] of out) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), 'missing seeds must not yield NaN');
  }
});

test('the centroid is at the origin', () => {
  // _buildGalaxyModern places each region by its centre, so a layout that
  // isn't centred would offset the whole region on the galaxy map.
  const { ids, adj, seeds } = makeRegion(7, 60);
  const out = regionForceLayout(ids, adj, seeds);
  const sum = out.reduce((a, [, p]) => ({ x: a.x + p.x, z: a.z + p.z }), { x: 0, z: 0 });
  assert.ok(Math.abs(sum.x / out.length) < 1e-9, 'x centroid should be 0');
  assert.ok(Math.abs(sum.z / out.length) < 1e-9, 'z centroid should be 0');
});

test('is deterministic — the same input always gives the same map', () => {
  // The whole disk cache rests on this. If the layout had any randomness,
  // a cached map would differ from a freshly built one.
  const { ids, adj, seeds } = makeRegion(11, 50);
  assert.deepStrictEqual(regionForceLayout(ids, adj, seeds), regionForceLayout(ids, adj, seeds));
});
