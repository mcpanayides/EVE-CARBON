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
//
// The cast, their places and their belongings live in src/demo/ (cast.js,
// world.js, skills.js), shared with the ESI fixtures — so what this file writes
// to disk and what demo_fixtures.js answers live can never disagree.

const fs   = require('fs');
const path = require('path');

const { CAST, DOMAIN, pilot } = require('./demo/cast');
const W      = require('./demo/world');
const Skills = require('./demo/skills');
const Pings  = require('./demo/pings');
const Cal    = require('./demo/calendar');
const Forum  = require('./demo/forum');

const HOUR = 3600 * 1000;
const DAY  = 24 * HOUR;

// The pre-split names, kept so the fleet-ops seed and its test read as before.
const CHARS = CAST;
const { JITA, AMARR, DODIXIE, RENS, STAGING } = W.PLACES;

// ── Deterministic noise ───────────────────────────────────────────────────────
// Fixed seed: re-running the seeder produces byte-identical data, so footage
// recorded a week apart still matches.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// Ansiblex pairs inside the demo alliance's Delve, each under the 5 LY limit
// (3.7–4.9 LY, checked against the SDE), chained out from the 1DQ1-A staging.
// They give the map's bridge layer and the Stargate planner something to route.
const JUMP_BRIDGES = [
  [30004759, 30004775], [30004759, 30004734], [30004775, 30004760], [30004775, 30004716],
  [30004734, 30004761], [30004734, 30004776], [30004760, 30004774], [30004760, 30004773],
  [30004716, 30004762],
];

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

  // The integrations a real user would have set up — every one pointed at a host
  // under .example (RFC 2606), which can never resolve. Demo mode answers each
  // locally: Jabber "connects" without a socket (jabber_ipc.js), the forum is
  // served on its own session (src/demo/forum.js), and the calendar feeds come
  // from src/demo/calendar.js.
  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
    app: {
      theme: 'Default',
      // Nothing should pop a notification, play a sound, or slide a toast in
      // over a take.
      launchAtLogin: false,
      minimizeToTray: false,
      netLog: false,
      jabber: {
        service:  `xmpp://jabber.${DOMAIN}:5222`,
        jid:      `kaska.vaelin@jabber.${DOMAIN}`,
        password: 'demo-mode-not-a-real-password',
        pack:     'user:vaelin_collective.yaml',
        rooms:    Pings.ROOMS.map(r => ({ jid: r.jid, name: r.name, nick: null })),
      },
      forum: { url: `${Forum.BASE}/` },
      calendar: {
        forumBaseUrl: `${Forum.BASE}/`,
        feeds:        [Cal.FORUM_FEED],
        extraFeeds:   [Cal.CORP_FEED],
        useSession:   false,
        showPi:       true,
        showJobs:     true,
      },
    },
  }, null, 2));

  // The alliance pack the Jabber page colours its SIG badges from — invented, so
  // the demo never shows a real alliance's SIG list.
  const packs = path.join(userDataDir, 'packs');
  fs.mkdirSync(packs, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'demo', 'vaelin_pack.yaml'), path.join(packs, 'vaelin_collective.yaml'));

  // Jump bridges, in the store's own unencrypted form ({ enc:false }), which its
  // loader accepts: main.js keeps this file encrypted with the OS keychain, but
  // an invented network has nothing to protect.
  fs.writeFileSync(path.join(userDataDir, 'jump_network.dat'), JSON.stringify({
    enc: false, data: Buffer.from(JSON.stringify(JUMP_BRIDGES), 'utf8').toString('base64'),
  }));
}

// ── Character DB ──────────────────────────────────────────────────────────────
async function writeCharacterDb(charInfoDb, now) {
  for (const [key, c] of Object.entries(CHARS)) {
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

    // What every page reads about a pilot regardless of role — the same values
    // the ESI fixtures serve live (src/demo/world.js, src/demo/skills.js).
    const loc = W.location(key);
    const where = Object.values(W.PLACES).find(p => p.systemId === loc.solar_system_id);
    const sysName = where ? where.systemName : W.AMAMAKE.systemName;
    const station = loc.station_id || loc.structure_id || null;
    await charInfoDb.upsertLocation(c.id, { solar_system_id: loc.solar_system_id, solar_system_name: sysName, station_id: station },
      station ? where.stationName : null);
    const ship = W.SHIPS[key];
    await charInfoDb.upsertShip(c.id, ship, ship.typeName);
    await charInfoDb.replaceSkills(c.id, Skills.skills(key).skills);
    await charInfoDb.replaceImplants(c.id, W.implantRows(Skills.implants(key)));
    await charInfoDb.replaceJumpClones(c.id, W.cloneRows(key, now));
    await charInfoDb.replaceLoyaltyPoints(c.id, W.loyaltyRows(key));
    await charInfoDb.replaceStandings(c.id, W.standings(key));
  }
  // Trading skills, so the Trading tools quote real broker fees and tax.
  await charInfoDb.replaceTradeProfile(CHARS.main.id, { accounting: 5, brokerRelations: 5 });
  await charInfoDb.replaceTradeProfile(CHARS.indy.id, { accounting: 4, brokerRelations: 4 });
  // The staging citadel, so asset and location rows resolve its name. The
  // table is made by initStationTables, which the app runs after seeding;
  // it is CREATE IF NOT EXISTS, so running it first is harmless.
  await charInfoDb.initStationTables();
  const placeRow = (p) => ({ id: p.stationId, name: p.stationName, solar_system_id: p.systemId,
    solar_system_name: p.systemName, region_id: p.regionId, region_name: p.regionName, security_status: p.sec });
  await charInfoDb.upsertUpwellStructures([placeRow(STAGING)]);
  // The NPC stations too: the locator reads this table before it would ask ESI.
  await charInfoDb.upsertNpcStations([JITA, AMARR, DODIXIE, RENS].map(placeRow));

  await seedMain(charInfoDb, now);
  await seedIndy(charInfoDb, now);
  await seedScout(charInfoDb, now);

  // Fleet ops live in the same database but are written through fleet_ops.js,
  // which takes the raw handle rather than the character-info wrapper.
  await seedFleetOps(charInfoDb.getDb(), now);
}

// ── Main: combat pilot with a deep wallet, broad assets, active trading ───────
async function seedMain(db, now) {
  const id  = CHARS.main.id;
  const rnd = lcg(20260803);

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
    // Tritanium: 20M units bought at 3.30, sold at 3.95
    { transaction_id: 800001, is_buy: true,  quantity: 20_000_000, type_id: 34, type_name: 'Tritanium', unit_price: 3.30, ...at(9 * DAY) },
    { transaction_id: 800002, is_buy: false, quantity: 12_000_000, type_id: 34, type_name: 'Tritanium', unit_price: 3.95, ...at(4 * DAY) },
    { transaction_id: 800003, is_buy: false, quantity:  8_000_000, type_id: 34, type_name: 'Tritanium', unit_price: 3.95, ...at(2 * DAY) },
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
    asset(2_100_016, 12015, 'Muninn',     STAGING,     4,  96_000),
    asset(2_100_017, 11978, 'Scimitar',   STAGING,     1,  89_000, 1),
    // Part of the Muninn restock list (demo-seed.js), so Station Checkout shows
    // some lines covered, some short and some missing — not six red rows.
    asset(2_100_020, 2969,  '720mm Howitzer Artillery II',    STAGING,   22,    220),
    asset(2_100_021, 519,   'Gyrostabilizer II',              STAGING,   30,    150),
    asset(2_100_022, 3841,  'Large Shield Extender II',       STAGING,    8,     80),
    asset(2_100_023, 2281,  'Multispectrum Shield Hardener II', STAGING,  4,     20),
    asset(2_100_024, 21922, 'Republic Fleet Phased Plasma M', STAGING, 9000,     90),
    asset(2_100_018, 40520, 'Large Skill Injector', JITA, 2, 0.02),
    asset(2_100_019, 44992, 'PLEX',       JITA,      240, 0),
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
}

// ── Industry alt: mining ledger, PI, blueprint library ───────────────────────
async function seedIndy(db, now) {
  const id = CHARS.indy.id;

  // 30 days of mining across three systems and six ores — enough for the
  // Mining Ledger's by-ore, by-day and by-system breakdowns to all have shape.
  await db.upsertMiningLedger(id, W.miningLedger('indy', now));

  // PI — six colonies with full pin layouts, one extractor about to expire (the
  // state the dashboard's PI widget is built to warn about). See world.js.
  await db.replacePiColonies(id, W.colonyRows('indy', now));

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
    asset(2_310_005, 2389,  'Plasmoids',       STAGING,     84_000,  31_920),
    asset(2_310_006, 3689,  'Mechanical Parts', STAGING,    41_500,  31_125),
    asset(2_310_007, 9832,  'Coolant',         DODIXIE,     28_900,  43_350),
    asset(2_310_008, 24699, 'Drake Blueprint', STAGING,          1,    0.01, 1),
    asset(2_310_009, 621,   'Caracal',         STAGING,         10,  920_000),
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

// ── Scout alt: a militia pilot a year in ──────────────────────────────────────
async function seedScout(db, now) {
  const id = CHARS.scout.id;

  await db.replaceAssets(id, [
    ...[[2_400_001, 587, 'Rifter', 3, 27_289, 0], [2_400_002, 22456, 'Sabre', 1, 43_000, 1],
        [2_400_003, 11578, 'Covert Ops Cloaking Device II', 2, 10, 0]].map(([item_id, type_id, name, quantity, volume, is_singleton]) => ({
      item_id, type_id, name, location_id: RENS.stationId,
      location_name: RENS.stationName, location_flag: 'Hangar',
      quantity, volume, is_singleton,
      solar_system_id: RENS.systemId, solar_system_name: RENS.systemName,
      region_id: RENS.regionId, region_name: RENS.regionName, security_status: RENS.sec,
      owner_id: id, owner_name: CHARS.scout.name,
    })),
  ]);

  await db.replaceWalletJournal(id, Array.from({ length: 8 }, (_, i) => ({
    id: 950_000 + i, amount: i % 2 ? 3_200_000 : 18_400_000,
    balance: CHARS.scout.balance - i * 3_200_000,
    context_id: null, context_id_type: null,
    date: new Date(now - i * 14 * HOUR).toISOString(),
    description: i % 2 ? 'Bounty Prizes' : 'Faction Warfare reward', first_party_id: id,
    ref_type: i % 2 ? 'bounty_prizes' : 'corporate_reward_payout',
    second_party_id: 1000182, tax: 0, tax_receiver_id: null, reason: null,
  })));
}

// ── Jabber (broadcasts + chat rooms) ──────────────────────────────────────────
// Through the Jabber store's own insert, which runs the real broadcast parser on
// every body (rule 1). Wiped first: demo_mode.reset() deletes the file, but on
// Windows a previous demo instance can still hold it, and the pings would stack.
async function seedJabber(jabberDataDb, now = Date.now()) {
  try { await jabberDataDb.wipeJabberDb(); } catch (_) { /* fresh database */ }
  for (const m of Pings.broadcasts(now)) await jabberDataDb.insertJabberMessage(m);
  // Room history older than an hour goes in first and is marked read; the last
  // hour lands after the marker, so each room shows a few unread lines and an
  // unread badge rather than all of them or none.
  const rooms  = Pings.roomMessages(now);
  const isOld  = (m) => Date.parse(m.receivedAt) < now - HOUR;
  for (const m of rooms.filter(isOld)) await jabberDataDb.insertJabberMessage(m);
  for (const r of Pings.ROOMS) await jabberDataDb.markRoomRead(r.jid);
  for (const m of rooms.filter(m => !isOld(m))) await jabberDataDb.insertJabberMessage(m);
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

module.exports = { seed, seedFleetOps, seedJabber, CHARS, JITA, AMARR, DODIXIE, RENS, STAGING, JUMP_BRIDGES };

// ── Fleet ops (Op History) ────────────────────────────────────────────────────
// Three closed ops, each showing a different face of the tool: a PvP roam with
// kills and a refit, a mining op with yield, and one that ended on a boss
// handover so the amber end-reason badge appears on camera.
//
// Written through src/fleet_ops.js rather than SQL, per rule 1 — the op schema
// is create-and-migrate and hand-rolled inserts would drift out of it silently.
// Every system and hull id below came out of the SDE (rule 4): a wrong one
// renders as "Unknown" or a broken icon, which looks worse than fewer rows.
// The other side's pilots are CCP NPC agents (src/demo/cast.js) — the ids an
// earlier version used belonged to real players.
const OPS_SYS = {
  DQ:    30004759,   // 1DQ1-A  — staging
  T319:  30004722,   // 319-3D
  T5ZI:  30004735,   // T5ZI-S
  YZ9:   30004719,   // YZ9-F6
  ZXB:   30004777,   // ZXB-VC  — passed through, never held
  K6K:   30004751,   // K-6K16  — passed through, never held
};
const OPS_SHIP = {
  muninn: 12015, scimitar: 11978, sabre: 22456, loki: 29990,
  retriever: 17478, covetor: 17476, venture: 32880,
};

async function seedFleetOps(db, now) {
  const ops = require('./fleet_ops');
  const M = CHARS.main.id, I = CHARS.indy.id, S = CHARS.scout.id;
  const foe = (n) => pilot(100 + n).id;

  // Start from a clean slate rather than assuming the profile was wiped.
  // demo_mode.reset() deletes the database file up front, but on Windows that
  // fails with EPERM when a previous demo instance has not finished releasing
  // its handle — relaunching quickly is enough to hit it. The reset logs a
  // warning and carries on, so without this the ops would stack up three at a
  // time on every launch and the History list would fill with duplicates.
  for (const row of await ops.listOps(db, 500)) {
    if (!row.ended_at) await ops.endOp(db, row.op_id, { at: now, reason: 'stopped' });
    await ops.deleteOp(db, row.op_id);
  }
  const member = (characterId, shipTypeId, solarSystemId) => ({ characterId, shipTypeId, solarSystemId });

  // ── 1. Delve Roam — the hero row: kills, a loss, a refit, pass-throughs ──
  {
    const start = now - 2 * HOUR;
    const end   = start + 47 * 60 * 1000;
    const id = await ops.startOp(db, {
      name: 'Delve Roam', doctrine: 'shield',
      bossCharacterId: M, fleetId: 4_120_000_001, at: start,
    });

    const leg = [
      { sys: OPS_SYS.DQ,   at: start,                 hold: true  },
      { sys: OPS_SYS.ZXB,  at: start +  6 * 60000,    hold: false },
      { sys: OPS_SYS.T319, at: start + 11 * 60000,    hold: true  },
      { sys: OPS_SYS.K6K,  at: start + 24 * 60000,    hold: false },
      { sys: OPS_SYS.T5ZI, at: start + 28 * 60000,    hold: true  },
      { sys: OPS_SYS.YZ9,  at: start + 39 * 60000,    hold: true  },
    ];
    for (const l of leg) {
      const roster = [member(M, OPS_SHIP.muninn, l.sys), member(I, OPS_SHIP.scimitar, l.sys), member(S, OPS_SHIP.sabre, l.sys)];
      await ops.recordRoster(db, id, roster, l.at);
      await ops.recordSystemsSeen(db, id, roster, l.at);
      // Only held systems reach the movement narrative — the two pass-throughs
      // exist in systems-seen alone, which is the distinction the tool is for.
      if (l.hold) await ops.recordMovement(db, id, { solarSystemId: l.sys, membersThere: 3, membersTotal: 3 }, l.at);
    }
    // Scout refits mid-op: a SECOND roster row, never an overwrite.
    await ops.recordRoster(db, id, [member(S, OPS_SHIP.loki, OPS_SYS.YZ9)], start + 41 * 60000);

    await ops.recordKills(db, id, [
      { killmailId: 121_400_881, killmailHash: 'demo-a1', at: start + 30 * 60000, solarSystemId: OPS_SYS.T5ZI,
        side: 'kill', victimCharacterId: foe(1), victimCorporationId: 1000107, victimAllianceId: null,
        victimShipTypeId: 24688, isk: 284_610_000, finalBlowCharacterId: M, involved: 3, npc: false },
      { killmailId: 121_400_902, killmailHash: 'demo-a2', at: start + 31 * 60000, solarSystemId: OPS_SYS.T5ZI,
        side: 'kill', victimCharacterId: foe(2), victimCorporationId: 1000107, victimAllianceId: null,
        victimShipTypeId: 24702, isk: 96_250_000, finalBlowCharacterId: S, involved: 2, npc: false },
      { killmailId: 121_401_144, killmailHash: 'demo-a3', at: start + 40 * 60000, solarSystemId: OPS_SYS.YZ9,
        side: 'loss', victimCharacterId: S, victimCorporationId: CHARS.scout.corpId, victimAllianceId: null,
        victimShipTypeId: OPS_SHIP.sabre, isk: 71_880_000, finalBlowCharacterId: foe(3), involved: 0, npc: false },
      { killmailId: 121_401_190, killmailHash: 'demo-a4', at: start + 44 * 60000, solarSystemId: OPS_SYS.YZ9,
        side: 'kill', victimCharacterId: foe(3), victimCorporationId: 1000107, victimAllianceId: null,
        victimShipTypeId: 34828, isk: 148_020_000, finalBlowCharacterId: M, involved: 3, npc: false },
    ]);
    await ops.endOp(db, id, { at: end, reason: 'stopped' });
  }

  // ── 2. Ore Run — yield, no violence ──
  {
    const start = now - 26 * HOUR;
    const end   = start + 110 * 60 * 1000;
    const id = await ops.startOp(db, {
      name: 'Ore Run — R64 Belt', doctrine: 'mining',
      bossCharacterId: I, fleetId: 4_120_000_002, at: start,
    });
    for (const [i, sys] of [OPS_SYS.DQ, OPS_SYS.T319].entries()) {
      const at = start + i * 55 * 60000;
      const roster = [member(I, OPS_SHIP.retriever, sys), member(M, OPS_SHIP.covetor, sys), member(S, OPS_SHIP.venture, sys)];
      await ops.recordRoster(db, id, roster, at);
      await ops.recordSystemsSeen(db, id, roster, at);
      await ops.recordMovement(db, id, { solarSystemId: sys, membersThere: 3, membersTotal: 3 }, at);
    }
    // Round-ish, lopsided quantities: an evenly-split ledger reads as generated.
    await ops.recordMining(db, id, [
      { character_id: I, solar_system_id: OPS_SYS.DQ,   type_id: 22,    quantity: 18_400, isk: 386_400_000 },
      { character_id: I, solar_system_id: OPS_SYS.T319, type_id: 1223,  quantity: 12_050, isk: 168_700_000 },
      { character_id: M, solar_system_id: OPS_SYS.DQ,   type_id: 22,    quantity: 14_900, isk: 312_900_000 },
      { character_id: M, solar_system_id: OPS_SYS.T319, type_id: 1225,  quantity:  9_300, isk: 121_090_000 },
      { character_id: S, solar_system_id: OPS_SYS.DQ,   type_id: 1230,  quantity:  6_200, isk:   4_960_000 },
    ]);
    await ops.endOp(db, id, { at: end, reason: 'stopped' });
  }

  // ── 3. Home Defence — closed by a boss handover ──
  {
    const start = now - 3 * DAY;
    const end   = start + 22 * 60 * 1000;
    const id = await ops.startOp(db, {
      name: 'Home Defence', doctrine: 'armour',
      bossCharacterId: M, fleetId: 4_120_000_003, at: start,
    });
    const roster = [member(M, OPS_SHIP.muninn, OPS_SYS.DQ), member(S, OPS_SHIP.sabre, OPS_SYS.DQ)];
    await ops.recordRoster(db, id, roster, start);
    await ops.recordSystemsSeen(db, id, roster, start);
    await ops.recordMovement(db, id, { solarSystemId: OPS_SYS.DQ, membersThere: 2, membersTotal: 2 }, start);
    await ops.recordKills(db, id, [
      { killmailId: 121_180_455, killmailHash: 'demo-c1', at: start + 14 * 60000, solarSystemId: OPS_SYS.DQ,
        side: 'kill', victimCharacterId: foe(4), victimCorporationId: 1000107, victimAllianceId: null,
        victimShipTypeId: 22456, isk: 63_400_000, finalBlowCharacterId: M, involved: 2, npc: false },
    ]);
    await ops.endOp(db, id, { at: end, reason: 'boss-handover' });
  }
}
