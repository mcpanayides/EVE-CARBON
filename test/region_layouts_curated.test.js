'use strict';
//
// The hand-traced region layouts.
//
// src/data/region-layouts.json holds positions read off the in-game map for
// regions somebody has matched by hand. Identity and gates always come from the
// SDE — the trace supplies ARRANGEMENT and nothing else — so the thing that can
// go wrong is the trace drifting out of step with the static data: a system
// renamed, moved between regions, or added and never placed.
//
// These assertions are cheap and they are the only thing standing between a
// stale trace and a region quietly drawing itself wrong.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const REL  = path.join('src', 'data', 'region-layouts.json');
const FILE = path.join(__dirname, '..', REL);

test('the curated region layouts ship with the app', () => {
  // src/** is packed into the asar; data/ at the repo root is gitignored and
  // would be missing from every CI build. Being in the wrong place fails here
  // rather than in a release nobody can reproduce locally.
  assert.ok(fs.existsSync(FILE), `${REL} is missing — it must ship inside src/`);
  const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.ok(Object.keys(j).length >= 1, 'no regions traced');
});

// The SDE is optional in some checkouts; skip rather than fail the suite.
const sdePath = path.join(__dirname, '..', 'data', 'sde.sql');
const haveSde = fs.existsSync(sdePath);

test('every traced position names a real system in that region', { skip: !haveSde }, async () => {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const db = await open({ filename: sdePath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [regionId, entry] of Object.entries(j)) {
      const rows = await db.all(
        'SELECT solarSystemID id, solarSystemName n FROM mapSolarSystems WHERE regionID = ?', regionId);
      const real = new Map(rows.map(r => [String(r.id), r.n]));
      const traced = Object.keys(entry.seeds);

      const strays = traced.filter(id => !real.has(id));
      assert.deepStrictEqual(strays, [],
        `${entry.region}: traced ids that are not in this region: ${strays.join(', ')}`);

      // A region gaining a system (CCP has done it) must not silently leave a
      // hole in the trace — the layout would place it by relaxation while its
      // neighbours stayed traced, which looks worse than either alone.
      const unplaced = [...real.keys()].filter(id => !entry.seeds[id]).map(id => real.get(id));
      assert.deepStrictEqual(unplaced, [],
        `${entry.region}: systems with no traced position: ${unplaced.join(', ')}`);
    }
  } finally { await db.close(); }
});

test('traced gate neighbours stay near each other', { skip: !haveSde }, async () => {
  // The real check on a trace's accuracy. Reading ~110 positions off a
  // screenshot is error-prone, and a system dropped in the wrong place shows up
  // as a gate stretched across the region. Inter-CONSTELLATION gates are
  // genuinely long in the in-game layout, so the bar is deliberately loose:
  // what this catches is a gross misplacement, not a few pixels.
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const db = await open({ filename: sdePath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const jumps = await db.all('SELECT fromSolarSystemID a, toSolarSystemID b FROM mapSolarSystemJumps');
    for (const [, entry] of Object.entries(j)) {
      const seeds = entry.seeds;
      const lens = [];
      const seen = new Set();
      for (const { a, b } of jumps) {
        const A = seeds[a], B = seeds[b];
        if (!A || !B) continue;                       // not both inside this region
        const k = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (seen.has(k)) continue;
        seen.add(k);
        lens.push({ d: Math.hypot(A[0] - B[0], A[1] - B[1]), a, b });
      }
      assert.ok(lens.length > 10, `${entry.region}: too few internal gates to check`);
      const sorted = lens.map(l => l.d).sort((x, y) => x - y);
      const med = sorted[Math.floor(sorted.length / 2)];

      // This used to fail anything over 6x the median, on the theory that a very
      // long gate meant a misplaced system. It does not, and the threshold cost
      // two correct regions before the screenshots settled it:
      //
      //   Ekura-Amsen   (Lonetrek) 6.9x — different constellations, drawn as a
      //                 long dashed line; confirmed in-game
      //   EIDI-N-IPAY-2 (Vale)     6.7x — drawn as a long vertical solid line
      //                 straight down the left of the region; confirmed in-game
      //
      // The layout is a SCHEMATIC. How far apart it draws two systems is its own
      // choice and is not constrained by their real distance, so gate length
      // cannot prove a placement wrong. What follows is only a gross-error
      // backstop - a gate an order of magnitude past the median means the trace
      // collapsed, not that one system drifted.
      const wild = lens.filter(l => l.d > med * 12);
      assert.deepStrictEqual(wild.map(l => `${l.a}-${l.b}`), [],
        `${entry.region}: a gate is >12x the median (${med.toFixed(0)}) — the trace looks broken, not merely imprecise`);

      // And nothing stacked on top of anything else.
      const pts = Object.values(seeds);
      let minD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        for (let k = i + 1; k < pts.length; k++) {
          minD = Math.min(minD, Math.hypot(pts[i][0] - pts[k][0], pts[i][1] - pts[k][1]));
        }
      }
      assert.ok(minD > med * 0.2,
        `${entry.region}: two systems traced almost on top of each other (${minD.toFixed(0)} vs median gate ${med.toFixed(0)})`);
    }
  } finally { await db.close(); }
});
