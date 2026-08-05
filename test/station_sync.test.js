'use strict';
//
// NPC station sync — local SDE only, no network.
//
// This used to fetch sde.hoboleaks.space/tq/stastations.json and fall back to
// fuzzwork.co.uk/dump/latest/staStations.json. Probed 2026-08-05: BOTH 404.
// Hoboleaks answers NoSuchKey for its whole /tq/ prefix, and Fuzzwork's
// /dump/latest/ listing holds only database dumps and a csv/ folder — no
// staStations.json — so that URL looks like it was never right.
//
// The failure was invisible: the fetch threw, the catch logged a warning, and
// the sync reported success having written nothing. What it did do was cost two
// failed requests every run, one of them a 404 at the service whose operator got
// in touch about exactly that traffic.
//
// data/sde.sql already has all of it, so these tests assert the strongest
// version of the fix: the sync must complete without touching the network at
// all. Both transports are wired to throw.
const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const fs     = require('fs');

const createLocator = require('../src/locator');
const SDE_PATH = path.join(__dirname, '..', 'data', 'sde.sql');

const openSde = async () => {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  return open({ filename: SDE_PATH, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
};

const haveSde = fs.existsSync(SDE_PATH);

test('the station sync completes with the network unavailable', { skip: !haveSde && 'no local SDE' }, async () => {
  const sde = await openSde();
  const rows = [];
  try {
    const loc = createLocator({
      // Any network use is a hard failure, not a fallback.
      httpGet:  async (u) => { throw new Error(`NETWORK USED: ${u}`); },
      readCache: () => null, writeCache: () => {},
      getValidToken: async () => 't', getAllCharacterIds: () => [],
      getStationById: async () => null,
      upsertNpcStations: async (batch) => { rows.push(...batch); },
      upsertUpwellStructures: async () => {},
      getSdeDb: () => sde,
    });
    const res = await loc.syncStationDatabase({
      httpPost: async (u) => { throw new Error(`POST USED: ${u}`); },
    });
    assert.ok(res.npc > 5000, `expected the full NPC station set, got ${res.npc}`);
    assert.strictEqual(res.npc, rows.length);
  } finally { await sde.close(); }
});

test('every station carries the geo the UI shows', { skip: !haveSde && 'no local SDE' }, async () => {
  // The old path resolved system and region names with ~6 ESI
  // /universe/names/ POSTs. The SDE join supplies them, so those calls are gone.
  const sde = await openSde();
  const rows = [];
  try {
    const loc = createLocator({
      httpGet: async () => { throw new Error('NETWORK'); },
      readCache: () => null, writeCache: () => {},
      getValidToken: async () => 't', getAllCharacterIds: () => [],
      getStationById: async () => null,
      upsertNpcStations: async (batch) => { rows.push(...batch); },
      upsertUpwellStructures: async () => {},
      getSdeDb: () => sde,
    });
    await loc.syncStationDatabase({ httpPost: async () => { throw new Error('POST'); } });

    const missingSystem = rows.filter(r => !r.solar_system_name).length;
    const missingRegion = rows.filter(r => !r.region_name).length;
    assert.strictEqual(missingSystem, 0, `${missingSystem} stations with no system name`);
    assert.strictEqual(missingRegion, 0, `${missingRegion} stations with no region name`);
    // NPC block only — anything above 64m is a player structure (PART 2's job).
    const outOfRange = rows.filter(r => r.id < 60_000_000 || r.id >= 64_000_000);
    assert.deepStrictEqual(outOfRange, [], 'player structures must not come from staStations');
  } finally { await sde.close(); }
});

test('no dead station-dump URL is left in the source', () => {
  // Named explicitly: both 404, and re-adding one would silently write nothing
  // while generating traffic at somebody else's expense.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'locator.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  for (const dead of ['hoboleaks.space/tq/stastations.json', 'dump/latest/staStations.json']) {
    assert.ok(!code.includes(dead), `${dead} is back in executable code and it 404s`);
  }
});
