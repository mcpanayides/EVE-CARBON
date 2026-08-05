'use strict';
//
// The demo profile's contents — a plausible three-character account with enough
// history behind it that every page has something real to render.
//
// THREE RULES THIS FILE FOLLOWS
//
// 1. Write through the app's own DB functions (src/character_info_db.js), never
//    hand-rolled SQL. If a column is added there, the demo data picks it up
//    instead of silently drifting out of schema — the same reasoning as
//    e2e/fixtures/seed.js.
//
// 2. Timestamps are relative to launch, not absolute. A recording that says
//    "2 hours ago" should say that on every take; hard-coded dates rot into
//    "8 months ago" and have to be re-edited before each session. (This is why
//    the clock itself is NOT mocked — freezing Date.now() in a process with
//    token refresh and pollers breaks more than it fixes, and reseeding on each
//    launch gets the same on-camera stability.)
//
// 3. Bulk rows are deterministic (a fixed-seed LCG, never Math.random) so a
//    re-record matches earlier footage, but anything on screen in the first few
//    seconds is hand-picked. Randomly generated numbers read as fake — real
//    ledgers have round-ish, repeating, lopsided values.
//
// Every ID here is a REAL one from the SDE, verified to resolve: fake type IDs
// render as broken icons and fake system IDs as "Unknown", both of which look
// worse on camera than having less data.

const fs   = require('fs');
const path = require('path');

const HOUR = 3600 * 1000;
const DAY  = 24 * HOUR;

// ── Cast ──────────────────────────────────────────────────────────────────────
// Corporations are NPC ones (the 1000xxx range), and nobody is in an alliance.
// This is deliberate: the app resolves corp and alliance NAMES from their IDs
// rather than trusting anything stored locally, so invented player-corp IDs
// come back as whoever really owns them — an early draft put "Pandemic Horde"
// on screen. Publishing a video that appears to show a real alliance's data
// isn't a look worth risking, and NPC corps every player starts in are both
// lore-correct and owned by nobody.
const CHARS = {
  main:  { id: 2118400001, name: 'Kaska Vaelin',  corpId: 1000167, allianceId: null, balance: 8_412_660_000.42, sec:  4.8, race: 1, bloodline: 1, gender: 'female', bornDaysAgo: 3210 },
  indy:  { id: 2118400002, name: 'Sirene Vaelin', corpId: 1000107, allianceId: null, balance: 1_903_220_500.00, sec:  5.0, race: 4, bloodline: 7, gender: 'female', bornDaysAgo: 2480 },
  scout: { id: 2118400003, name: 'Tovan Kesh',    corpId: 1000045, allianceId: null, balance:   412_880_300.10, sec: -1.4, race: 2, bloodline: 4, gender: 'male',   bornDaysAgo:  390 },
};

// ── Places (real SDE IDs — see the header) ───────────────────────────────────
const JITA    = { stationId: 60003760, stationName: 'Jita 4 - Moon 4 - Caldari Navy Assembly Plant', systemId: 30000142, systemName: 'Jita',    regionId: 10000002, regionName: 'The Forge',   sec: 0.9 };
const AMARR   = { stationId: 60008494, stationName: 'Amarr 8 - Emperor Family Academy',              systemId: 30002187, systemName: 'Amarr',   regionId: 10000043, regionName: 'Domain',      sec: 0.9 };
const DODIXIE = { stationId: 60011866, stationName: 'Dodixie 9 - Moon 20 - Federation Navy Assembly Plant', systemId: 30002659, systemName: 'Dodixie', regionId: 10000032, regionName: 'Sinq Laison', sec: 0.9 };
const RENS    = { stationId: 60004588, stationName: 'Rens 6 - Moon 8 - Brutor Tribe Treasury',       systemId: 30002510, systemName: 'Rens',    regionId: 10000030, regionName: 'Heimatar',    sec: 0.9 };
// Sov null has no NPC stations, so the staging is an Upwell structure — the
// 1e12+ ID range is what real citadels use.
const STAGING = { stationId: 1035466617946, stationName: '1DQ1-A - Vaelin Forward Assembly', systemId: 30004759, systemName: '1DQ1-A', regionId: 10000060, regionName: 'Delve', sec: -0.4 };

// ── Deterministic noise ───────────────────────────────────────────────────────
// Fixed seed: re-running the seeder produces byte-identical data, so footage
// recorded a week apart still matches.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// ── Accounts + config (userData) ──────────────────────────────────────────────
function writeUserData(userDataDir, now) {
  fs.mkdirSync(userDataDir, { recursive: true });

  const accounts = {};
  for (const c of Object.values(CHARS)) {
    accounts[c.id] = {
      characterId: c.id,
      characterName: c.name,
      // Deliberately expired, exactly as the e2e fixture does: every live ESI
      // call then fails fast and each page falls back to the seeded local data
      // (the same path a real user hits offline or rate-limited). A demo that
      // depended on the network would break the moment you recorded on hotel
      // wifi — or quietly show someone else's real market prices.
      accessToken:  'demo-mode-not-a-real-token',
      refreshToken: 'demo-mode-not-a-real-token',
      expiresAt:    now - 60_000,
      addedAt:      now - 400 * DAY,
    };
  }
  fs.writeFileSync(path.join(userDataDir, 'blueprints.json'),
    JSON.stringify({ accounts, blueprints: {}, assets: {} }, null, 2));

  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
    app: {
      theme: 'Default',
      // Nothing should pop a notification, play a sound, or slide a toast in
      // over a take.
      launchAtLogin: false,
      minimizeToTray: false,
      netLog: false,
    },
  }, null, 2));
}

// ── Character DB ──────────────────────────────────────────────────────────────
async function writeCharacterDb(charInfoDb, now) {
  for (const c of Object.values(CHARS)) {
    await charInfoDb.ensureCharacterTables(c.id);
    await charInfoDb.upsertCharacterInfo(c.id, {
      character_name:  c.name,
      corporation_id:  c.corpId,
      alliance_id:     c.allianceId,
      birthday:        new Date(now - c.bornDaysAgo * DAY).toISOString(),
      description:     '',
      gender:          c.gender,
      race_id:         c.race,
      bloodline_id:    c.bloodline,
      security_status: c.sec,
    });
    await charInfoDb.insertWalletSnapshot(c.id, c.balance);
  }

  await seedMain(charInfoDb, now);
  await seedIndy(charInfoDb, now);
  await seedScout(charInfoDb, now);
}

// ── Main: combat pilot with a deep wallet, broad assets, active trading ───────
async function seedMain(db, now) {
  const id  = CHARS.main.id;
  const rnd = lcg(20260803);

  await db.upsertLocation(id, { solar_system_id: JITA.systemId, solar_system_name: JITA.systemName, station_id: JITA.stationId }, JITA.stationName);
  await db.upsertShip(id, { ship_type_id: 17738, ship_item_id: 1_500_000_001, ship_name: 'Slow Boat' }, 'Machariel');

  // Wallet journal — 30 days. Hand-picked leaders (the rows on screen first),
  // then deterministic filler underneath.
  const HERO_JOURNAL = [
    { amount:  845_000_000, ref: 'contract_price',    desc: 'Contract - Machariel, fitted',      ago: 2 * HOUR },
    { amount: -312_500_000, ref: 'market_transaction', desc: 'Market escrow - Ishtar',            ago: 5 * HOUR },
    { amount:   96_400_000, ref: 'bounty_prizes',      desc: 'Bounty Prizes',                     ago: 9 * HOUR },
    { amount:  120_000_000, ref: 'insurance',          desc: 'Insurance payout - Drake',          ago: 26 * HOUR },
    { amount:  -18_750_000, ref: 'brokers_fee',        desc: "Broker's Fee",                      ago: 30 * HOUR },
  ];
  const REF_TYPES = ['bounty_prizes', 'market_transaction', 'contract_price', 'brokers_fee', 'transaction_tax', 'planetary_import_tax', 'corporation_account_withdrawal'];
  const journal = [];
  let balance = CHARS.main.balance;
  HERO_JOURNAL.forEach((h, i) => {
    journal.push({
      id: 700_000 + i, amount: h.amount, balance: (balance -= 0),
      context_id: null, context_id_type: null,
      date: new Date(now - h.ago).toISOString(),
      description: h.desc, first_party_id: id, ref_type: h.ref,
      second_party_id: 1000132, tax: 0, tax_receiver_id: null, reason: null,
    });
    balance -= h.amount;
  });
  for (let i = 0; i < 55; i++) {
    const ref  = pick(rnd, REF_TYPES);
    const sign = /fee|tax|withdrawal|transaction/.test(ref) ? -1 : 1;
    // Round-ish magnitudes: real journals are full of repeated, blunt numbers.
    const amt  = sign * Math.round((2 + rnd() * 90)) * 1_000_000;
    balance -= amt;
    journal.push({
      id: 710_000 + i, amount: amt, balance,
      context_id: null, context_id_type: null,
      date: new Date(now - (2 * DAY + i * 12 * HOUR)).toISOString(),
      description: ref.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()),
      first_party_id: id, ref_type: ref,
      second_party_id: 1000132, tax: 0, tax_receiver_id: null, reason: null,
    });
  }
  await db.replaceWalletJournal(id, journal);

  // Transactions — built as matched buy/sell pairs so the Trading page's
  // realised P&L has real profit to show rather than "no closed positions".
  const at = (ago, extra = {}) => ({
    location_id: JITA.stationId, location_name: JITA.stationName,
    client_id: 1000132, is_personal: true,
    date: new Date(now - ago).toISOString(), ...extra,
  });
  await db.replaceWalletTransactions(id, [
    // Tritanium: 20M units bought at 4.80, sold at 5.65 → +17M
    { transaction_id: 800001, is_buy: true,  quantity: 20_000_000, type_id: 34, type_name: 'Tritanium', unit_price: 4.80, ...at(9 * DAY) },
    { transaction_id: 800002, is_buy: false, quantity: 12_000_000, type_id: 34, type_name: 'Tritanium', unit_price: 5.65, ...at(4 * DAY) },
    { transaction_id: 800003, is_buy: false, quantity:  8_000_000, type_id: 34, type_name: 'Tritanium', unit_price: 5.65, ...at(2 * DAY) },
    // Drake: 6 bought at 48M, 5 sold at 61.5M → +67.5M
    { transaction_id: 800004, is_buy: true,  quantity: 6, type_id: 24698, type_name: 'Drake', unit_price: 48_000_000, ...at(12 * DAY) },
    { transaction_id: 800005, is_buy: false, quantity: 3, type_id: 24698, type_name: 'Drake', unit_price: 61_500_000, ...at(6 * DAY) },
    { transaction_id: 800006, is_buy: false, quantity: 2, type_id: 24698, type_name: 'Drake', unit_price: 61_500_000, ...at(3 * DAY) },
    // Ishtar: bought high, sold low — one loss keeps it believable
    { transaction_id: 800007, is_buy: true,  quantity: 2, type_id: 12005, type_name: 'Ishtar', unit_price: 312_500_000, ...at(5 * DAY) },
    { transaction_id: 800008, is_buy: false, quantity: 2, type_id: 12005, type_name: 'Ishtar', unit_price: 298_000_000, ...at(1 * DAY) },
    // Megacyte: clean win
    { transaction_id: 800009, is_buy: true,  quantity: 40_000, type_id: 40, type_name: 'Megacyte', unit_price: 1_180, ...at(15 * DAY) },
    { transaction_id: 800010, is_buy: false, quantity: 40_000, type_id: 40, type_name: 'Megacyte', unit_price: 1_465, ...at(7 * DAY) },
  ]);

  // Assets across five locations — the Assets page groups by region, so a
  // single-station pilot would show one flat list and demo nothing.
  const asset = (itemId, typeId, name, place, qty, vol, singleton = 0) => ({
    item_id: itemId, type_id: typeId, name, location_id: place.stationId,
    location_name: place.stationName, location_flag: 'Hangar',
    quantity: qty, volume: vol, is_singleton: singleton,
    solar_system_id: place.systemId, solar_system_name: place.systemName,
    region_id: place.regionId, region_name: place.regionName, security_status: place.sec,
    owner_id: id, owner_name: CHARS.main.name,
  });
  await db.replaceAssets(id, [
    asset(2_100_001, 17738, 'Machariel',  JITA,    1, 486_000, 1),
    asset(2_100_002, 12005, 'Ishtar',     JITA,    3, 115_000, 0),
    asset(2_100_003, 24698, 'Drake',      JITA,    1, 252_000, 1),
    asset(2_100_004, 34,    'Tritanium',  JITA, 8_420_000, 84_200),
    asset(2_100_005, 35,    'Pyerite',    JITA, 2_150_000, 21_500),
    asset(2_100_006, 36,    'Mexallon',   AMARR,  640_000,  6_400),
    asset(2_100_007, 40,    'Megacyte',   AMARR,   18_400,  2_944),
    asset(2_100_008, 638,   'Raven',      AMARR,        1, 486_000, 1),
    asset(2_100_009, 621,   'Caracal',    DODIXIE,     4,  92_000),
    asset(2_100_010, 39,    'Zydrine',    DODIXIE, 31_200,  4_992),
    asset(2_100_011, 28606, 'Orca',       RENS,        1, 250_000, 1),
    asset(2_100_012, 587,   'Rifter',     RENS,       12,  27_289),
    asset(2_100_013, 24698, 'Drake',      STAGING,     6, 252_000),
    asset(2_100_014, 37,    'Isogen',     STAGING, 96_000,  1_536),
    asset(2_100_015, 11396, 'Mercoxit',   STAGING, 14_800,  5_920),
    // Blueprints — item_ids match the blueprint rows below so the assets query
    // resolves BPO vs BPC through its LEFT JOIN (exercises the /bp vs /bpc icon).
    asset(2_200_001, 24699, 'Drake Blueprint',     JITA, 1, 0.01, 1),
    asset(2_200_002, 17739, 'Machariel Blueprint', JITA, 1, 0.01, 1),
    asset(2_200_003, 691,   'Rifter Blueprint',    JITA, 1, 0.01, 1),
  ]);

  await db.replaceBlueprints(id, [
    { item_id: 2_200_001, type_id: 24699, name: 'Drake Blueprint',     location_id: JITA.stationId, location_flag: 'Hangar', quantity: 1, runs: -1, me: 10, te: 20, isBPC: false },
    { item_id: 2_200_002, type_id: 17739, name: 'Machariel Blueprint', location_id: JITA.stationId, location_flag: 'Hangar', quantity: 1, runs: -1, me:  7, te: 14, isBPC: false },
    { item_id: 2_200_003, type_id: 691,   name: 'Rifter Blueprint',    location_id: JITA.stationId, location_flag: 'Hangar', quantity: 1, runs: 30, me: 10, te: 20, isBPC: true  },
  ]);

  await db.replaceSkills(id, [
    { skill_id: 3327, trained_skill_level: 5, skillpoints_in_skill: 1_280_000, active_skill_level: 5 },   // Spaceship Command
    { skill_id: 3300, trained_skill_level: 5, skillpoints_in_skill: 1_280_000, active_skill_level: 5 },   // Gunnery
    { skill_id: 3380, trained_skill_level: 5, skillpoints_in_skill: 1_280_000, active_skill_level: 5 },   // Mechanics
    { skill_id: 3402, trained_skill_level: 4, skillpoints_in_skill:   226_000, active_skill_level: 4 },   // Science
    { skill_id: 3426, trained_skill_level: 5, skillpoints_in_skill: 1_280_000, active_skill_level: 5 },   // Power Grid Management
  ]);
}

// ── Industry alt: mining ledger, PI, blueprint library ───────────────────────
async function seedIndy(db, now) {
  const id  = CHARS.indy.id;
  const rnd = lcg(77);

  await db.upsertLocation(id, { solar_system_id: STAGING.systemId, solar_system_name: STAGING.systemName, station_id: STAGING.stationId }, STAGING.stationName);
  await db.upsertShip(id, { ship_type_id: 28606, ship_item_id: 1_500_000_002, ship_name: 'Bulk Carrier' }, 'Orca');

  // 30 days of mining across three systems and six ores — enough for the
  // Mining Ledger's by-ore, by-day and by-system breakdowns to all have shape.
  const ORES = [
    { id: 1230, per: 240_000 }, // Veldspar
    { id: 1228, per: 120_000 }, // Scordite
    { id: 18,   per:  64_000 }, // Plagioclase
    { id: 1224, per:  38_000 }, // Pyroxeres
    { id: 22,   per:   9_400 }, // Arkonor
    { id: 11396, per:  4_200 }, // Mercoxit
  ];
  const SYSTEMS = [STAGING.systemId, JITA.systemId, DODIXIE.systemId];
  const ledger = [];
  for (let d = 0; d < 30; d++) {
    const date = new Date(now - d * DAY).toISOString().slice(0, 10);
    if (d % 7 === 3) continue;                       // a day off — a flat line looks generated
    for (const ore of ORES) {
      if (rnd() < 0.35) continue;                    // not every ore every day
      ledger.push({
        date,
        solar_system_id: pick(rnd, SYSTEMS),
        type_id: ore.id,
        quantity: Math.round(ore.per * (0.55 + rnd() * 0.9)),
      });
    }
  }
  await db.upsertMiningLedger(id, ledger);

  // PI — varied planet types and fill levels; one extractor about to expire,
  // which is the state the dashboard's PI widget is designed to warn about.
  const colony = (planetId, type, place, level, pins, expiresIn, fillPct) => ({
    planet_id: planetId, planet_type: type,
    solar_system_id: place.systemId, solar_system_name: place.systemName,
    upgrade_level: level, num_pins: pins, last_update: now - 3 * HOUR,
    extractor_expires_at: now + expiresIn,
    storage_json: JSON.stringify([{
      pin_id: planetId + 1, label: 'Launchpad', capacity_m3: 10_000,
      used_m3: Math.round(100 * fillPct), fill_pct: fillPct, contents: [],
    }]),
    pins_json: '[]',
  });
  // Planet IDs are real, and each one genuinely orbits the system it's listed
  // under — the app resolves the planet NAME from the SDE, so a mismatched pair
  // renders as "Intaki I ... 1DQ1-A" and reads as broken. Types match the SDE
  // too (1DQ1-A II really is a lava planet).
  await db.replacePiColonies(id, [
    colony(40301369, 'Planet (Barren)',    STAGING, 5, 14,  2 * HOUR, 88),   // 1DQ1-A I
    colony(40301372, 'Planet (Lava)',      STAGING, 5, 12, 19 * HOUR, 61),   // 1DQ1-A II
    colony(40301376, 'Planet (Plasma)',    STAGING, 4, 10, 31 * HOUR, 44),   // 1DQ1-A IV
    colony(40169271, 'Planet (Storm)',     DODIXIE, 5, 13,  7 * HOUR, 72),   // Dodixie V
    colony(40169275, 'Planet (Temperate)', DODIXIE, 3,  8, 44 * HOUR, 12),   // Dodixie VI
    colony(40009082, 'Planet (Gas)',       JITA,    5, 15, 26 * HOUR, 95),   // Jita IV
  ]);

  // A working blueprint library: BPOs researched to 10/20, plus copies in use.
  const bp = (itemId, typeId, name, runs, me, te) => ({
    item_id: itemId, type_id: typeId, name, location_id: STAGING.stationId,
    location_flag: 'Hangar', quantity: 1, runs, me, te, isBPC: runs > 0,
  });
  await db.replaceBlueprints(id, [
    bp(2_300_001, 24699, 'Drake Blueprint',     -1, 10, 20),
    bp(2_300_002,   687, 'Caracal Blueprint',   -1, 10, 20),
    bp(2_300_003,   688, 'Raven Blueprint',     -1,  9, 18),
    bp(2_300_004, 12006, 'Ishtar Blueprint',    -1,  8, 16),
    bp(2_300_005, 28607, 'Orca Blueprint',      -1,  6, 12),
    bp(2_300_006,   691, 'Rifter Blueprint',    50, 10, 20),
    bp(2_300_007, 24699, 'Drake Blueprint',     10, 10, 20),
  ]);

  const asset = (itemId, typeId, name, place, qty, vol, singleton = 0) => ({
    item_id: itemId, type_id: typeId, name, location_id: place.stationId,
    location_name: place.stationName, location_flag: 'Hangar',
    quantity: qty, volume: vol, is_singleton: singleton,
    solar_system_id: place.systemId, solar_system_name: place.systemName,
    region_id: place.regionId, region_name: place.regionName, security_status: place.sec,
    owner_id: id, owner_name: CHARS.indy.name,
  });
  await db.replaceAssets(id, [
    asset(2_310_001, 28606, 'Orca',            STAGING, 1, 250_000, 1),
    asset(2_310_002, 34,    'Tritanium',       STAGING, 24_600_000, 246_000),
    asset(2_310_003, 35,    'Pyerite',         STAGING,  6_400_000,  64_000),
    asset(2_310_004, 36,    'Mexallon',        STAGING,  1_820_000,  18_200),
    asset(2_310_005, 2389,  'Plasmoids',       STAGING,     84_000,  33_600),
    asset(2_310_006, 3689,  'Mechanical Parts', STAGING,    41_500,  16_600),
    asset(2_310_007, 9832,  'Coolant',         DODIXIE,     28_900,  11_560),
    asset(2_310_008, 24699, 'Drake Blueprint', STAGING,          1,    0.01, 1),
  ]);

  await db.replaceWalletJournal(id, Array.from({ length: 24 }, (_, i) => ({
    id: 900_000 + i,
    amount: i % 3 === 0 ? 42_000_000 : -6_500_000,
    balance: CHARS.indy.balance - i * 2_000_000,
    context_id: null, context_id_type: null,
    date: new Date(now - i * 8 * HOUR).toISOString(),
    description: i % 3 === 0 ? 'Contract - Ore delivery' : 'Planetary Import Tax',
    first_party_id: id, ref_type: i % 3 === 0 ? 'contract_price' : 'planetary_import_tax',
    second_party_id: 1000132, tax: 0, tax_receiver_id: null, reason: null,
  })));
}

// ── Scout alt: thin on purpose — a fresh character is a real state to show ────
async function seedScout(db, now) {
  const id = CHARS.scout.id;
  await db.upsertLocation(id, { solar_system_id: 30001161, solar_system_name: 'HED-GP', station_id: null }, null);
  await db.upsertShip(id, { ship_type_id: 587, ship_item_id: 1_500_000_003, ship_name: 'Ratter' }, 'Rifter');

  await db.replaceAssets(id, [{
    item_id: 2_400_001, type_id: 587, name: 'Rifter', location_id: RENS.stationId,
    location_name: RENS.stationName, location_flag: 'Hangar',
    quantity: 3, volume: 27_289, is_singleton: 0,
    solar_system_id: RENS.systemId, solar_system_name: RENS.systemName,
    region_id: RENS.regionId, region_name: RENS.regionName, security_status: RENS.sec,
    owner_id: id, owner_name: CHARS.scout.name,
  }]);

  await db.replaceWalletJournal(id, Array.from({ length: 8 }, (_, i) => ({
    id: 950_000 + i, amount: 3_200_000,
    balance: CHARS.scout.balance - i * 3_200_000,
    context_id: null, context_id_type: null,
    date: new Date(now - i * 14 * HOUR).toISOString(),
    description: 'Bounty Prizes', first_party_id: id, ref_type: 'bounty_prizes',
    second_party_id: 1000132, tax: 0, tax_receiver_id: null, reason: null,
  })));
}

/**
 * Populate a demo profile.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir  demo userData (already redirected)
 * @param {string} opts.dataDir      demo data dir (holds character_information.db)
 * @param {object} opts.charInfoDb   the app's character DB module, already init'd
 * @param {number} [opts.now]        clock origin — override for reproducible tests
 */
async function seed({ userDataDir, dataDir, charInfoDb, now = Date.now() }) {
  fs.mkdirSync(dataDir, { recursive: true });
  writeUserData(userDataDir, now);
  await writeCharacterDb(charInfoDb, now);
  return { characters: Object.values(CHARS).map(c => ({ id: c.id, name: c.name })) };
}

module.exports = { seed, CHARS, JITA, AMARR, DODIXIE, RENS, STAGING };
