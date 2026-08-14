// ─── e2e/fixtures/seed-stress.js ──────────────────────────────────────────────
// A profile the size of a real one.
//
// The smoke fixture has ONE character and FOUR assets, which is why it has never
// caught a scaling problem: every render path it exercises is trivially fast at
// that size. Real users run 90 characters and 100,000+ items, and the app hangs
// while building that. This generator produces data of that shape so the slow
// paths are reachable from a test.
//
// Shape matters as much as size. The generator reproduces the things that make
// real asset data expensive, not just the row count:
//   • assets spread over many stations in many regions (group count drives the
//     tree, not just the item count)
//   • deep container nesting — ships with fitted modules, containers inside
//     containers — which is what the roll-up and the collapse logic walk
//   • a long tail of distinct type_ids, so per-type caches cannot trivially hit
//   • a handful of characters holding most of the items, as in real corps
//
// Used by scripts/stress-assets.js (data layer, no Electron) and
// e2e/assets-stress.spec.js (the real app).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// Deterministic PRNG: a stress run that cannot be reproduced is not a
// measurement, it is an anecdote. Same seed, same profile, every time.
function rng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

// Real regions/systems so region grouping and the sec-status colouring behave as
// they do in production.
const REGIONS = [
  { region_id: 10000002, region_name: 'The Forge',   systems: [[30000142, 'Jita', 0.9], [30002187, 'Amarr', 1.0]] },
  { region_id: 10000043, region_name: 'Domain',      systems: [[30002510, 'Rens', 0.9], [30002053, 'Hek', 0.8]] },
  { region_id: 10000030, region_name: 'Heimatar',    systems: [[30002505, 'Dodixie', 0.9]] },
  { region_id: 10000060, region_name: 'Delve',       systems: [[30004759, '1DQ1-A', -0.4], [30003067, 'T5ZI-S', -0.5]] },
  { region_id: 10000067, region_name: 'Genesis',     systems: [[30001984, 'Sakht', 0.4]] },
  { region_id: 10000037, region_name: 'Everyshore',  systems: [[30002225, 'Villore', 0.7]] },
];

// A long tail of type ids. Real hangars hold hundreds of distinct types; a
// fixture that reuses three defeats every per-type cache in the app.
const TYPE_POOL = Array.from({ length: 420 }, (_, i) => 30 + i * 7);
const SHIP_TYPES = [587, 588, 589, 590, 591, 592, 593, 594];       // nested containers
const CONTAINER_TYPES = [3465, 3466, 11488, 11489];                 // secure containers

/**
 * Generate a full profile.
 *
 * @param {object} opts
 * @param {number} opts.characters  how many characters (real reports: up to 90)
 * @param {number} opts.assets      total asset rows across all characters
 * @param {number} opts.stations    distinct stations to spread them over
 * @param {number} opts.seed        PRNG seed
 */
function buildStressProfile({ characters = 90, assets = 100000, stations = 120, seed = 1337 } = {}) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const chars = Array.from({ length: characters }, (_, i) => ({
    characterId: 90000001 + i,
    characterName: `Stress Pilot ${String(i + 1).padStart(3, '0')}`,
  }));

  // Stations, spread across the regions above.
  const locations = Array.from({ length: stations }, (_, i) => {
    const region = REGIONS[i % REGIONS.length];
    const [solar_system_id, solar_system_name, security_status] = pick(region.systems);
    return {
      location_id: 60000000 + i * 17,
      location_name: `${solar_system_name} ${romanish(i)} - Station ${i}`,
      solar_system_id, solar_system_name, security_status,
      region_id: region.region_id, region_name: region.region_name,
    };
  });

  // Item distribution: a few characters hold most of the assets, as in a real
  // corp where two or three mains carry the stockpile. A flat split would hide
  // the cost of one enormous hangar, which is the case that actually hangs.
  const weights = chars.map((_, i) => (i < 3 ? 12 : i < 12 ? 4 : 1));
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let nextItemId = 1_000_000;
  const perChar = new Map();

  for (let c = 0; c < chars.length; c++) {
    const share = Math.max(1, Math.round(assets * (weights[c] / weightSum)));
    const rows = [];
    let remaining = share;

    while (remaining > 0) {
      const loc = pick(locations);

      // Roughly one in nine top-level items is a ship or container holding a
      // few things — and one in five of those holds a nested container, so the
      // tree is genuinely three deep in places.
      const makeContainer = rand() < 0.11 && remaining > 6;
      if (makeContainer) {
        const parentId = nextItemId++;
        rows.push(assetRow(parentId, pick(rand() < 0.5 ? SHIP_TYPES : CONTAINER_TYPES),
          loc.location_id, loc, chars[c], 1, 1));
        remaining--;

        const kidCount = Math.min(remaining, 3 + Math.floor(rand() * 8));
        for (let k = 0; k < kidCount && remaining > 0; k++) {
          const kidId = nextItemId++;
          rows.push(assetRow(kidId, pick(TYPE_POOL), parentId, loc, chars[c],
            1 + Math.floor(rand() * 50), 0));
          remaining--;

          if (rand() < 0.2 && remaining > 2) {
            const inner = Math.min(remaining, 1 + Math.floor(rand() * 3));
            for (let n = 0; n < inner && remaining > 0; n++) {
              rows.push(assetRow(nextItemId++, pick(TYPE_POOL), kidId, loc, chars[c],
                1 + Math.floor(rand() * 20), 0));
              remaining--;
            }
          }
        }
        continue;
      }

      rows.push(assetRow(nextItemId++, pick(TYPE_POOL), loc.location_id, loc, chars[c],
        1 + Math.floor(rand() * 5000), 0));
      remaining--;
    }
    perChar.set(chars[c].characterId, rows);
  }

  return { chars, locations, perChar,
           totalAssets: [...perChar.values()].reduce((n, r) => n + r.length, 0) };
}

function assetRow(item_id, type_id, location_id, loc, char, quantity, is_singleton) {
  return {
    item_id, type_id, name: `Type ${type_id}`,
    location_id,
    location_name: loc.location_name, location_flag: 'Hangar',
    quantity, volume: 0.01 + (type_id % 40), is_singleton,
    solar_system_id: loc.solar_system_id, solar_system_name: loc.solar_system_name,
    region_id: loc.region_id, region_name: loc.region_name,
    security_status: loc.security_status,
    owner_id: char.characterId, owner_name: char.characterName,
  };
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const romanish = (i) => ROMAN[i % ROMAN.length];

/** Write the accounts store for every generated character. */
async function seedStressUserData(userDataDir, chars) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const accounts = {};
  for (const c of chars) {
    accounts[c.characterId] = {
      characterId: c.characterId, characterName: c.characterName,
      accessToken: 'stress-fake-access-token', refreshToken: 'stress-fake-refresh-token',
      expiresAt: Date.now() - 1000,       // expired: forces the local-DB fallback
      addedAt: Date.now() - 30 * 86400 * 1000,
    };
  }
  fs.writeFileSync(path.join(userDataDir, 'blueprints.json'),
    JSON.stringify({ accounts, blueprints: {}, assets: {} }));
  fs.writeFileSync(path.join(userDataDir, 'config.json'),
    JSON.stringify({ app: { theme: 'Default' } }));
}

/**
 * Write the character database. Returns per-stage timings, because the point of
 * this fixture is to find out where the time goes.
 */
async function seedStressCharacterDb(dataDir, profile, { onProgress } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const charInfoDb = require('../../src/character_info_db');
  await charInfoDb.initCharacterDb(dataDir);

  const timings = { tables: 0, info: 0, assets: 0 };
  let t = Date.now();

  for (const c of profile.chars) await charInfoDb.ensureCharacterTables(c.characterId);
  timings.tables = Date.now() - t; t = Date.now();

  for (const c of profile.chars) {
    await charInfoDb.upsertCharacterInfo(c.characterId, {
      character_name: c.characterName, corporation_id: 98000001, alliance_id: 99000001,
      birthday: '2020-01-01T00:00:00Z', description: '', gender: 'female',
      race_id: 1, bloodline_id: 1, security_status: 2.5,
    });
    await charInfoDb.insertWalletSnapshot(c.characterId, 1e9 + c.characterId);
  }
  timings.info = Date.now() - t; t = Date.now();

  let done = 0;
  for (const c of profile.chars) {
    const rows = profile.perChar.get(c.characterId) || [];
    await charInfoDb.replaceAssets(c.characterId, rows);
    done += rows.length;
    if (onProgress) onProgress(done, profile.totalAssets);
  }
  timings.assets = Date.now() - t;

  return { charInfoDb, timings };
}

module.exports = { buildStressProfile, seedStressUserData, seedStressCharacterDb };
