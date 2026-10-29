'use strict';
//
// ─── cast.js — every id demo mode hands out, and the name each one has ────────
//
// One table, read by the seeder (demo_data.js), the ESI fixtures
// (demo_fixtures.js) and the name lookups, so a pilot who appears on a killmail,
// in a mail header and on a leaderboard is the same pilot with the same name.
// No database layer here, which is what lets the IPC path load it cheaply.
//
// WHY THE IDS ARE WHAT THEY ARE
//
// The app resolves names, portraits and logos FROM ids. An invented id that
// happens to belong to someone resolves to them: the first cast (2118400001…)
// were real characters, so the demo showed three strangers' portraits under the
// demo names, and the killmail victims' ids came back as real players' names.
//
//   • Pilots are CCP NPC agents (npcCharacters in the SDE). Their portraits exist
//     on the image server and there is no player behind them. The cast keeps its
//     own names; everyone else keeps the agent's.
//   • Player corporations and alliances use ranges no real one occupies
//     (98,990,001+ and 99,990,001+). The image server answers those with its
//     default logo, and every name comes from here.
//   • NPC corporations and factions are the real ones — lore, owned by nobody.

const PILOTS = require('./snapshots/npc-pilots.json');

// RFC 2606 reserves .example for exactly this: an address that can never be
// anybody's server, however the demo is shared.
const DOMAIN = 'vaelin.example';

// The invented alliance the cast's forum, Jabber and calendar belong to. It is
// the invented owner the sov snapshot gave 1DQ1-A, so the map, the pings and
// the forum all agree on who holds the staging system.
const VAELIN = { id: 99_990_003, name: 'Vaelin Collective', ticker: 'VAELN' };
// …and its executor: the invented corporation that holds 1DQ1-A's sov claim.
const VAELIN_CORP = { id: 98_990_003, name: 'Vaelin Industries', ticker: 'VAELI' };

// ── The three demo pilots ─────────────────────────────────────────────────────
// Race and bloodline match the agent portrait each id shows. Corporations are
// NPC ones; Tovan flies for the Minmatar militia, which is what gives the
// Faction Warfare page an enlisted pilot to show.
//
// Kaska has the LOWEST id on purpose: accounts are keyed by character id, so
// pages that take "the first account" (the notification feed, first-load
// pickers) take her. With the scout's id lowest, the app opened as the scout.
const CAST = {
  main:  { id: 3_010_026, name: 'Kaska Vaelin',  corpId: 1_000_167, allianceId: null, balance: 8_412_660_000.42, sec:  4.8, race: 1, bloodline: 1, gender: 'female', bornDaysAgo: 3210 },
  indy:  { id: 3_010_075, name: 'Sirene Vaelin', corpId: 1_000_166, allianceId: null, balance: 1_903_220_500.00, sec:  5.0, race: 4, bloodline: 5, gender: 'female', bornDaysAgo: 2480 },
  scout: { id: 3_010_035, name: 'Tovan Kesh',    corpId: 1_000_182, allianceId: null, balance:   412_880_300.10, sec: -1.4, race: 2, bloodline: 4, gender: 'male',   bornDaysAgo:  390, militia: 500_002 },
};
const CAST_BY_ID = Object.fromEntries(Object.values(CAST).map(c => [c.id, c]));

// ── NPC corporations and factions the demo touches (real SDE values) ──────────
const NPC_CORPS = {
  1_000_035: { name: 'Caldari Navy',                ticker: 'CN',    factionId: 500_001 },
  1_000_045: { name: 'Science and Trade Institute', ticker: 'STI',   factionId: 500_001 },
  1_000_080: { name: 'Ministry of War',             ticker: 'MW',    factionId: 500_003 },
  1_000_130: { name: 'Sisters of EVE',              ticker: 'SEVE',  factionId: 500_016 },
  1_000_107: { name: 'The Scope',                   ticker: 'TS',    factionId: 500_004 },
  1_000_125: { name: 'CONCORD',                     ticker: 'CONCO', factionId: 500_006 },
  1_000_132: { name: 'Secure Commerce Commission',  ticker: 'SCC',   factionId: 500_006 },
  1_000_165: { name: 'Hedion University',           ticker: 'HU',    factionId: 500_003 },
  1_000_166: { name: 'Imperial Academy',            ticker: 'IAC',   factionId: 500_003 },
  1_000_167: { name: 'State War Academy',           ticker: 'SWA',   factionId: 500_001 },
  1_000_179: { name: '24th Imperial Crusade',       ticker: 'IC24',  factionId: 500_003 },
  1_000_180: { name: 'State Protectorate',          ticker: 'SPROT', factionId: 500_001 },
  1_000_181: { name: 'Federal Defense Union',       ticker: 'FEDEF', factionId: 500_004 },
  1_000_182: { name: 'Tribal Liberation Force',     ticker: 'TLIB',  factionId: 500_002 },
};
const FACTIONS = {
  500_001: 'Caldari State', 500_002: 'Minmatar Republic', 500_003: 'Amarr Empire',
  500_004: 'Gallente Federation', 500_006: 'CONCORD Assembly', 500_010: 'Guristas Pirates',
  500_011: 'Angel Cartel', 500_016: 'Servant Sisters of EVE',
};

// ── Invented alliances ────────────────────────────────────────────────────────
// Hand-written rather than generated: these are on screen in the sov legend and
// the Force Projection list, where "Alliance 17" would read as broken.
const ALLIANCE_NAMES = [
  'Obsidian Accord', 'Cinder Reach', 'Vaelin Collective', 'Ashen Covenant', 'Kestrel Union',
  'Hollow Crown Syndicate', 'Ninefold Veil', 'Ironbark Compact', 'Pale Meridian', 'Tidewrack Assembly',
  'Ember Lattice', 'Silent Rook Coalition', 'Glasswing Directorate', 'Rimeward Pact', 'Sable Tithe',
  'Corvid Ascendancy', 'Lantern Fleet', 'Starfall Mandate', 'Wolfram Assembly', 'Quiet Harbour',
  'Vesper Holdings', 'Driftmark League', 'Orrery Concord', 'Thornfield Combine', 'Halcyon Breach',
  'Grey Tern Alliance', 'Basalt Throne', 'Mirefall Concern', 'Salt and Signal', 'Umbral Tithe',
  'Copperline Union', 'Juniper Vanguard', 'Black Sextant', 'Antimony Pact', 'Riven Compass',
  'Seventh Lantern', 'Cobalt Wake', 'Fennec Holdings', 'Gilded Tern', 'Hearthstone Accord',
  'Isotope Ring', 'Jackal Moon', 'Kiln and Anvil', 'Lodestar Order', 'Marrow Coast',
  'Nightjar Assembly', 'Oxbow Combine', 'Pilgrim Static', 'Quarry Saints', 'Rusted Halo',
  'Sundog Federation', 'Tallow Crown', 'Undertow Pact', 'Wayfarer Compact', 'Xenolith Order',
  'Yarrow League', 'Zephyr Concord', 'Aurora Lattice', 'Brightwater Union', 'Calyx Assembly',
  'Dusk Heron', 'Eventide Compact', 'Fathom Guild', 'Gravel Saints', 'Harrow Lane',
  'Ichor Bloom', 'Jetsam Republic', 'Knell Union', 'Lumen Pact', 'Moth and Lamp',
  'Nadir Compact', 'Opaline Order', 'Petrel Assembly', 'Quillon Accord', 'Ravel Concern',
  'Spindrift League', 'Tessera Union', 'Verdigris Pact', 'Wren Directorate', 'Saltmarsh Accord',
];
const ALLIANCE_BASE = 99_990_001;
const CORP_BASE     = 98_990_001;

// Corporations are far more numerous and never headline a screen, so they are
// composed — still deterministic, so one id is one name everywhere.
const CORP_A = ['Halcyon', 'Basalt', 'Corvid', 'Driftmark', 'Ember', 'Fathom', 'Gilded', 'Harrow',
                'Ironbark', 'Juniper', 'Kestrel', 'Lodestar', 'Marrow', 'Nightjar', 'Oxbow', 'Petrel',
                'Quarry', 'Rimeward', 'Sable', 'Tallow', 'Umbral', 'Vesper', 'Wolfram', 'Yarrow'];
const CORP_B = ['Mining', 'Logistics', 'Salvage', 'Armaments', 'Holdings', 'Exploration', 'Refining',
                'Security', 'Shipwrights', 'Survey', 'Freight', 'Engineering'];
const CORP_C = ['Corp', 'Collective', 'Syndicate', 'Group', 'Works', 'Company', 'Partners'];

function _ticker(name) {
  const words = name.replace(/\band\b/gi, '').split(/\s+/).filter(Boolean);
  const t = words.length >= 3 ? words.map(w => w[0]).join('') : (words[0].slice(0, 3) + (words[1] || '').slice(0, 2));
  return t.toUpperCase().slice(0, 5);
}

function allianceInfo(id) {
  if (id === VAELIN.id) return { name: VAELIN.name, ticker: VAELIN.ticker };
  const i = id - ALLIANCE_BASE;
  if (i < 0 || i > 9_999) return null;
  const name = ALLIANCE_NAMES[i % ALLIANCE_NAMES.length] + (i >= ALLIANCE_NAMES.length ? ` ${Math.floor(i / ALLIANCE_NAMES.length) + 1}` : '');
  return { name, ticker: _ticker(name) };
}

function corpInfo(id) {
  if (NPC_CORPS[id]) return NPC_CORPS[id];
  if (id === VAELIN_CORP.id) return { name: VAELIN_CORP.name, ticker: VAELIN_CORP.ticker };
  const i = id - CORP_BASE;
  if (i < 0 || i > 9_999) return null;
  const name = `${CORP_A[i % CORP_A.length]} ${CORP_B[Math.floor(i / CORP_A.length) % CORP_B.length]} ${CORP_C[Math.floor(i / 7) % CORP_C.length]}`;
  return { name, ticker: _ticker(name) };
}

const PILOT_BY_ID = Object.fromEntries(PILOTS.map(p => [p.id, p]));

/** A pilot from the NPC pool, picked deterministically — `pilot(3)` is always the same agent. */
const pilot = (n) => PILOTS[((n % PILOTS.length) + PILOTS.length) % PILOTS.length];

/**
 * The name and ESI category of an id the demo hands out, or null when it is not
 * one of ours (static data — systems, types, stations — resolves from the SDE).
 */
function nameOf(id) {
  id = Number(id);
  if (CAST_BY_ID[id])  return { name: CAST_BY_ID[id].name,  category: 'character' };
  if (PILOT_BY_ID[id]) return { name: PILOT_BY_ID[id].name, category: 'character' };
  if (FACTIONS[id])    return { name: FACTIONS[id],         category: 'faction' };
  const corp = corpInfo(id);
  if (corp)            return { name: corp.name,            category: 'corporation' };
  const al = allianceInfo(id);
  if (al)              return { name: al.name,              category: 'alliance' };
  return null;
}

module.exports = {
  DOMAIN, VAELIN, VAELIN_CORP, CAST, CAST_BY_ID, NPC_CORPS, FACTIONS, PILOTS, PILOT_BY_ID,
  ALLIANCE_BASE, CORP_BASE, allianceInfo, corpInfo, pilot, nameOf,
};
