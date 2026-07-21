// ─── e2e/fixtures/seed.js ─────────────────────────────────────────────────────
// Builds a throwaway userData profile + character_information.db for the e2e
// smoke tests: one fake character with blueprints, wallet history, wallet
// journal and PI colonies already populated, so page-level tests can assert on
// real rendered rows instead of only empty states.
//
// Uses the app's OWN character_info_db.js writer functions (not hand-rolled
// SQL) so the fixture always matches the real schema — if a column gets added
// there, this fixture picks it up automatically instead of silently drifting.
//
// The fake account's ESI tokens are deliberately invalid: any live ESI call
// the app attempts will fail and the widgets fall back to this seeded local
// data (the same fallback path real users hit on a rate limit / offline
// moment) — see the "fall back to cached data" comments throughout
// src/func/dashboard.js. This is what makes the tests network-independent.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const FAKE_CHAR_ID = 90000001;
const FAKE_CHAR_NAME = 'E2E Test Pilot';

async function seedUserData(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });

  // ── accounts store (main.js loadDB()/dbPath — historically named blueprints.json) ──
  const accountsPath = path.join(userDataDir, 'blueprints.json');
  fs.writeFileSync(accountsPath, JSON.stringify({
    accounts: {
      [FAKE_CHAR_ID]: {
        characterId: FAKE_CHAR_ID,
        characterName: FAKE_CHAR_NAME,
        accessToken: 'e2e-fake-access-token',
        refreshToken: 'e2e-fake-refresh-token',
        expiresAt: Date.now() - 1000,   // already expired — forces fallback to local DB
        addedAt: Date.now() - 30 * 86400 * 1000,
      },
    },
    blueprints: {},
    assets: {},
  }, null, 2));

  // ── app config ──
  const configPath = path.join(userDataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ app: { theme: 'Carbon' } }, null, 2));

  return { accountsPath, configPath, characterId: FAKE_CHAR_ID, characterName: FAKE_CHAR_NAME };
}

// dataDir = the app's /data folder (character_information.db lives beside
// sde.sql, NOT in userData — see main.js initPaths()).
async function seedCharacterDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const charInfoDb = require('../../src/character_info_db');

  await charInfoDb.initCharacterDb(dataDir);
  await charInfoDb.ensureCharacterTables(FAKE_CHAR_ID);

  await charInfoDb.upsertCharacterInfo(FAKE_CHAR_ID, {
    character_name: FAKE_CHAR_NAME,
    corporation_id: 98000001,
    alliance_id: 99000001,
    birthday: '2020-01-01T00:00:00Z',
    description: '',
    gender: 'female',
    race_id: 1,
    bloodline_id: 1,
    security_status: 5.0,
  });

  await charInfoDb.insertWalletSnapshot(FAKE_CHAR_ID, 1234567890.12);

  await charInfoDb.replaceBlueprints(FAKE_CHAR_ID, [
    { item_id: 1001, type_id: 690, name: 'Rifter Blueprint', location_id: 60003760, location_flag: 'Hangar', quantity: 1, runs: -1, me: 10, te: 20, is_bpc: 0 },
    { item_id: 1002, type_id: 691, name: 'Merlin Blueprint', location_id: 60003760, location_flag: 'Hangar', quantity: 1, runs: -1, me: 8, te: 16, is_bpc: 0 },
    { item_id: 1003, type_id: 590, name: 'Rifter Blueprint Copy', location_id: 60003760, location_flag: 'Hangar', quantity: 1, runs: 5, me: 10, te: 20, is_bpc: 1 },
  ]);

  await charInfoDb.replaceWalletJournal(FAKE_CHAR_ID, Array.from({ length: 12 }, (_, i) => ({
    id: 5000 + i,
    amount: i % 2 === 0 ? 1000000 : -250000,
    balance: 1234567890.12 - i * 100000,
    context_id: null, context_id_type: null,
    date: new Date(Date.now() - i * 3600 * 1000).toISOString(),
    description: i % 2 === 0 ? 'Bounty Prizes' : 'Market Transaction',
    first_party_id: FAKE_CHAR_ID, ref_type: i % 2 === 0 ? 'bounty_prizes' : 'market_transaction',
    second_party_id: 1000132, tax: 0, tax_receiver_id: null, reason: null,
  })));

  await charInfoDb.replaceAssets(FAKE_CHAR_ID, [
    {
      item_id: 2001, type_id: 34, name: 'Tritanium', location_id: 60003760,
      location_name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', location_flag: 'Hangar',
      quantity: 50000, volume: 5000, is_singleton: 0,
      solar_system_id: 30000142, solar_system_name: 'Jita',
      region_id: 10000002, region_name: 'The Forge', security_status: 0.9,
      owner_id: FAKE_CHAR_ID, owner_name: FAKE_CHAR_NAME,
    },
    {
      item_id: 2002, type_id: 587, name: 'Rifter', location_id: 60003760,
      location_name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', location_flag: 'Hangar',
      quantity: 1, volume: 27289, is_singleton: 1,
      solar_system_id: 30000142, solar_system_name: 'Jita',
      region_id: 10000002, region_name: 'The Forge', security_status: 0.9,
      owner_id: FAKE_CHAR_ID, owner_name: FAKE_CHAR_NAME,
    },
  ]);

  await charInfoDb.replacePiColonies(FAKE_CHAR_ID, [
    {
      planet_id: 40000001, planet_type: 'Planet (Barren)',
      solar_system_id: 30000142, solar_system_name: 'Jita',
      upgrade_level: 3, num_pins: 8, last_update: Date.now(),
      extractor_expires_at: Date.now() + 6 * 3600 * 1000,
      storage_json: JSON.stringify([{ pin_id: 1, label: 'Launchpad', capacity_m3: 10000, used_m3: 4200, fill_pct: 42, contents: [] }]),
      pins_json: '[]',
    },
  ]);

  return charInfoDb;
}

module.exports = { seedUserData, seedCharacterDb, FAKE_CHAR_ID, FAKE_CHAR_NAME };
