'use strict';
//
// ─── world.js — the demo pilots' belongings, told once ────────────────────────
//
// Everything that has to agree between the seeded database (demo_data.js) and
// the live-ESI fixtures (demo_fixtures.js): where each pilot is, what they fly,
// their colonies, clones, loyalty points, standings, fits and contracts. When
// both sides read this file, the Machariel contract in the Contracts tab is the
// same one the wallet journal was paid for, and the PI page offline matches the
// planets ESI would report.
//
// Every id is a real SDE id (verified when written — a wrong one renders as
// "Unknown" or a broken icon), and every time is relative to `now`.

const { CAST, NPC_CORPS, pilot } = require('./cast');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

// ── Places ───────────────────────────────────────────────────────────────────
const PLACES = {
  JITA:    { stationId: 60003760, stationName: 'Jita 4 - Moon 4 - Caldari Navy Assembly Plant', systemId: 30000142, systemName: 'Jita',    regionId: 10000002, regionName: 'The Forge',   sec: 0.9 },
  AMARR:   { stationId: 60008494, stationName: 'Amarr 8 - Emperor Family Academy',              systemId: 30002187, systemName: 'Amarr',   regionId: 10000043, regionName: 'Domain',      sec: 0.9 },
  DODIXIE: { stationId: 60011866, stationName: 'Dodixie 9 - Moon 20 - Federation Navy Assembly Plant', systemId: 30002659, systemName: 'Dodixie', regionId: 10000032, regionName: 'Sinq Laison', sec: 0.9 },
  RENS:    { stationId: 60004588, stationName: 'Rens 6 - Moon 8 - Brutor Tribe Treasury',       systemId: 30002510, systemName: 'Rens',    regionId: 10000030, regionName: 'Heimatar',    sec: 0.9 },
  // Sov null has no NPC stations, so the staging is an Upwell structure — the
  // 1e12+ id range is what real citadels use. An Astrahus (35832).
  STAGING: { stationId: 1035466617946, stationName: '1DQ1-A - Vaelin Forward Assembly', systemId: 30004759, systemName: '1DQ1-A', regionId: 10000060, regionName: 'Delve', sec: -0.4, typeId: 35832 },
};

const keyOf = (id) => Object.keys(CAST).find(k => CAST[k].id === Number(id)) || null;

// ── Where they are, what they fly ────────────────────────────────────────────
const SHIPS = {
  main:  { ship_type_id: 17738, ship_item_id: 1_500_000_001, ship_name: 'Slow Boat',   typeName: 'Machariel' },
  indy:  { ship_type_id: 28606, ship_item_id: 1_500_000_002, ship_name: 'Bulk Carrier', typeName: 'Orca' },
  scout: { ship_type_id: 22456, ship_item_id: 1_500_000_003, ship_name: 'Bubble Gum',  typeName: 'Sabre' },
};
// Tovan is out in the Minmatar warzone — Amamake, a militia staple.
const AMAMAKE = { systemId: 30002537, systemName: 'Amamake' };

function location(key) {
  if (key === 'main')  return { solar_system_id: PLACES.JITA.systemId, station_id: PLACES.JITA.stationId };
  if (key === 'indy')  return { solar_system_id: PLACES.STAGING.systemId, structure_id: PLACES.STAGING.stationId };
  return { solar_system_id: AMAMAKE.systemId };
}

function online(key, now) {
  const map = {
    main:  { online: true,  last_login: iso(now - 2 * HOUR - 14 * MIN), last_logout: iso(now - 20 * HOUR), logins: 4211 },
    indy:  { online: false, last_login: iso(now - 9 * HOUR),  last_logout: iso(now - 3 * HOUR - 5 * MIN), logins: 3108 },
    scout: { online: false, last_login: iso(now - 2 * DAY - 4 * HOUR), last_logout: iso(now - 2 * DAY), logins: 388 },
  };
  return map[key];
}

// ── Implants and clones ──────────────────────────────────────────────────────
const IMPLANT_NAMES = {
  10216: ['Ocular Filter - Standard', 1], 10217: ['Ocular Filter - Improved', 1],
  10208: ['Memory Augmentation - Standard', 2], 10209: ['Memory Augmentation - Improved', 2],
  10212: ['Neural Boost - Standard', 3], 10213: ['Neural Boost - Improved', 3],
  10221: ['Cybernetic Subprocessor - Standard', 4], 10222: ['Cybernetic Subprocessor - Improved', 4],
  10225: ['Social Adaptation Chip - Standard', 5], 10226: ['Social Adaptation Chip - Improved', 5],
  16003: ["Eifyr and Co. 'Rogue' Navigation NN-605", 6],
  19548: ["Inherent Implants 'Noble' Remote Armor Repair Systems RA-705", 7],
  19549: ["Inherent Implants 'Noble' Mechanic MC-805", 8],
  19685: ["Inherent Implants 'Noble' Repair Proficiency RP-905", 9],
  19550: ["Inherent Implants 'Noble' Hull Upgrades HG-1005", 10],
};
const implantRows = (ids) => ids.map(id => ({ implant_id: id, type_name: (IMPLANT_NAMES[id] || [''])[0], slot: (IMPLANT_NAMES[id] || [, null])[1] }));

/** ESI /characters/{id}/clones/. */
function clones(key, now) {
  const P = PLACES;
  const home = { main: P.JITA, indy: P.STAGING, scout: P.RENS }[key];
  const jump = {
    main:  [{ jump_clone_id: 51_000_101, location_id: P.AMARR.stationId,   location_type: 'station',   name: 'Amarr learning clone', implants: [10216, 10208, 10212, 10221, 10225] },
            { jump_clone_id: 51_000_102, location_id: P.STAGING.stationId, location_type: 'structure', name: 'Delve PvP',            implants: [] }],
    indy:  [{ jump_clone_id: 51_000_201, location_id: P.JITA.stationId,    location_type: 'station',   name: 'Jita trade',           implants: [] }],
    scout: [],
  }[key];
  return {
    home_location: { location_id: home.stationId, location_type: home === P.STAGING ? 'structure' : 'station' },
    jump_clones: jump,
    last_clone_jump_date: iso(now - (key === 'main' ? 6 : 31) * DAY),
    last_station_change_date: iso(now - 90 * DAY),
  };
}
/** The same clones as the database stores them (with names resolved). */
function cloneRows(key, now) {
  const byStation = Object.fromEntries(Object.values(PLACES).map(p => [p.stationId, p.stationName]));
  return clones(key, now).jump_clones.map(c => ({ ...c, location_name: byStation[c.location_id] || null }));
}

// ── Loyalty points and standings ─────────────────────────────────────────────
const LP = {
  main:  [[1_000_035, 412_300], [1_000_130, 88_450]],
  indy:  [[1_000_080, 156_000]],
  scout: [[1_000_182, 1_284_600]],
};
const loyaltyEsi = (key) => LP[key].map(([corporation_id, loyalty_points]) => ({ corporation_id, loyalty_points }));
const loyaltyRows = (key) => LP[key].map(([corporation_id, loyalty_points]) =>
  ({ corporation_id, corporation_name: (NPC_CORPS[corporation_id] || {}).name || null, loyalty_points }));

function standings(key) {
  const rows = {
    main:  [[500_001, 'faction', 7.21], [1_000_035, 'npc_corp', 8.14], [1_000_130, 'npc_corp', 5.42], [1_000_125, 'npc_corp', 2.08], [500_004, 'faction', -1.6]],
    indy:  [[500_003, 'faction', 6.83], [1_000_080, 'npc_corp', 7.39], [1_000_166, 'npc_corp', 3.1], [500_001, 'faction', 1.2]],
    scout: [[500_002, 'faction', 4.41], [1_000_182, 'npc_corp', 5.92], [500_003, 'faction', -3.24], [500_001, 'faction', -1.1]],
  }[key];
  return rows.map(([from_id, from_type, standing]) => ({ from_id, from_type, standing }));
}

/** ESI /characters/{id}/fw/stats — only Tovan is enlisted. */
function fwStats(key, now) {
  if (key !== 'scout') {
    return { kills: { last_week: 0, total: 0, yesterday: 0 }, victory_points: { last_week: 0, total: 0, yesterday: 0 } };
  }
  return {
    enlisted_on: iso(now - 118 * DAY), faction_id: CAST.scout.militia,
    current_rank: 4, highest_rank: 5,
    kills: { last_week: 23, total: 412, yesterday: 4 },
    victory_points: { last_week: 18_400, total: 512_300, yesterday: 2_350 },
  };
}

// ── Planetary industry ───────────────────────────────────────────────────────
// Structure type ids per planet type, from the SDE (groups 1027-1030, 1063).
const PIN_TYPES = {
  barren:    { cc: 2524, ecu: 2848, basic: 2473, adv: 2474, pad: 2544, store: 2541 },
  lava:      { cc: 2549, ecu: 3062, basic: 2469, adv: 2470, pad: 2555, store: 2558 },
  plasma:    { cc: 2551, ecu: 3064, basic: 2471, adv: 2472, pad: 2556, store: 2560 },
  storm:     { cc: 2550, ecu: 3067, basic: 2483, adv: 2484, pad: 2557, store: 2561 },
  temperate: { cc: 2254, ecu: 3068, basic: 2481, adv: 2480, pad: 2256, store: 2562 },
  gas:       { cc: 2534, ecu: 3060, basic: 2492, adv: 2494, pad: 2543, store: 2536 },
};
// What each world extracts (P0 type ids) and makes (schematic → output P1/P2).
const PI_CHAIN = {
  barren:    { raw: [2267, 2270], p1: [[126, 2398], [127, 2399]], p2: [[73, 3689]] },   // Reactive/Precious Metals → Mechanical Parts
  lava:      { raw: [2307, 2272], p1: [[130, 9828], [128, 2400]], p2: [] },              // Silicon, Toxic Metals
  plasma:    { raw: [2308, 2270], p1: [[122, 2389], [127, 2399]], p2: [] },              // Plasmoids, Precious Metals
  storm:     { raw: [2309, 2310], p1: [[123, 2390], [124, 3683]], p2: [] },              // Electrolytes, Oxygen
  temperate: { raw: [2288, 2305], p1: [[134, 2396], [135, 2397]], p2: [] },              // Biofuels, Industrial Fibers
  gas:       { raw: [2311, 2310], p1: [[125, 2392], [124, 3683]], p2: [[69, 2317]] },    // Oxidizing Compound/Oxygen → Oxides
};

// Planet ids are real and each orbits the system it is listed under — the app
// resolves the planet NAME from the SDE. planet_type is ESI's lower-case word:
// the PI page keys its planet art on it, and the first demo stored
// "Planet (Barren)", which matched no art and drew every colony as a barren icon.
const COLONIES = {
  indy: [
    [40301369, 'barren',    'STAGING', 5,  2 * HOUR, 88, '1DQ1-A I'],
    [40301372, 'lava',      'STAGING', 5, 19 * HOUR, 61, '1DQ1-A II'],
    [40301376, 'plasma',    'STAGING', 4, 31 * HOUR, 44, '1DQ1-A IV'],
    [40169271, 'storm',     'DODIXIE', 5,  7 * HOUR, 72, 'Dodixie V'],
    [40169275, 'temperate', 'DODIXIE', 3, 44 * HOUR, 12, 'Dodixie VI'],
    [40009082, 'gas',       'JITA',    5, 26 * HOUR, 95, 'Jita IV'],
  ],
  main: [], scout: [],
};
// Planet type ids, for ESI's /universe/planets/{id}/ answer.
const PLANET_TYPE_IDS = { temperate: 11, gas: 13, lava: 2015, barren: 2016, storm: 2017, plasma: 2063 };

/** ESI /universe/planets/{id}/ for the demo's own colonies. */
function planetInfo(planetId) {
  for (const rows of Object.values(COLONIES)) {
    const c = rows.find(r => r[0] === Number(planetId));
    if (c) return { planet_id: c[0], name: c[6], system_id: W_PLACES()[c[2]].systemId, type_id: PLANET_TYPE_IDS[c[1]],
                    position: { x: 1.4e11, y: 2.1e9, z: -9.7e10 } };
  }
  return undefined;
}
const W_PLACES = () => PLACES;

function _rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

/** ESI /characters/{id}/planets/{planet_id}/ pins for one colony. */
function colonyPins(planetId, type, expiresIn, fillPct, now) {
  const T = PIN_TYPES[type], C = PI_CHAIN[type], rnd = _rng(planetId);
  let n = 0;
  const pos = () => ({ latitude: 1.2 + rnd() * 0.6, longitude: 2.4 + rnd() * 0.8 });
  const pin = (type_id, extra = {}) => ({ pin_id: planetId * 100 + (++n), type_id, ...pos(), ...extra });
  const pins = [pin(T.cc, { contents: [] })];
  C.raw.forEach((product_type_id, i) => {
    pins.push(pin(T.ecu, {
      install_time: iso(now - 4 * DAY), last_cycle_start: iso(now - 20 * MIN),
      // The two heads finish an hour apart: the soonest drives the card's timer.
      expiry_time: iso(now + expiresIn + i * HOUR),
      extractor_details: { cycle_time: 1800, head_radius: 0.0241, product_type_id, qty_per_cycle: 6800 - i * 900,
        heads: Array.from({ length: 10 }, (_, h) => ({ head_id: h, latitude: 1.1 + rnd() * 0.8, longitude: 2.2 + rnd() * 1.1 })) },
    }));
  });
  C.p1.forEach(([schematic_id]) => { for (let k = 0; k < 3; k++) pins.push(pin(T.basic, { schematic_id, last_cycle_start: iso(now - 12 * MIN) })); });
  C.p2.forEach(([schematic_id]) => pins.push(pin(T.adv, { schematic_id, last_cycle_start: iso(now - 25 * MIN) })));
  // Launchpad holding what the colony makes, filled to the colony's level.
  // Volumes are the SDE's (P0 0.005 m³, P1 0.19, P2 0.75) — the PI page's own
  // sync recomputes the bars from them, so seeding anything else would make the
  // bars jump on the first sync. Launchpad 10,000 m³, storage 12,000 m³.
  const out = [...C.p1.map(([, t]) => [t, 0.19]), ...C.p2.map(([, t]) => [t, 0.75])];
  const used = 10_000 * fillPct / 100;
  pins.push(pin(T.pad, { contents: out.map(([type_id, vol]) => ({ type_id, amount: Math.round(used / out.length / vol) })) }));
  // A raw-material buffer a third to a half full: a factory planet's storage.
  pins.push(pin(T.store, { contents: C.raw.map(type_id => ({ type_id, amount: 380_000 + Math.round(rnd() * 320_000) })) }));
  return pins;
}

/** Colonies as the database stores them (pi_ipc's sync output shape). */
function colonyRows(key, now) {
  return COLONIES[key].map(([planetId, type, place, level, expiresIn, fillPct]) => {
    const P = PLACES[place], T = PIN_TYPES[type];
    const pins = colonyPins(planetId, type, expiresIn, fillPct, now);
    const volOf = (t) => (t === 3689 || t === 2317 ? 0.75 : (t >= 2267 && t <= 2311) || t === 2073 ? 0.005 : 0.19);
    const store = (p, label, cap) => {
      const contents = (p.contents || []).map(c => ({ type_id: c.type_id, amount: c.amount, volume_m3: c.amount * volOf(c.type_id) }));
      const used = contents.reduce((s, c) => s + c.volume_m3, 0);
      return { pin_id: p.pin_id, type_id: p.type_id, label, capacity_m3: cap, used_m3: Math.round(used * 100) / 100,
               fill_pct: Math.min(100, Math.round(used / cap * 100)), contents };
    };
    return {
      planet_id: planetId, planet_type: type,
      solar_system_id: P.systemId, solar_system_name: P.systemName,
      upgrade_level: level, num_pins: pins.length, last_update: now - 3 * HOUR,
      extractor_expires_at: now + expiresIn,
      storage_json: JSON.stringify([store(pins.find(p => p.type_id === T.pad), 'Launchpad', 10_000),
                                    store(pins.find(p => p.type_id === T.store), 'Storage Facility', 12_000)]),
      pins_json: JSON.stringify(pins),
      routes_json: '[]',
    };
  });
}

/** ESI /characters/{id}/planets/. */
function planetsEsi(key, now) {
  return colonyRows(key, now).map(c => ({
    planet_id: c.planet_id, planet_type: c.planet_type, solar_system_id: c.solar_system_id,
    upgrade_level: c.upgrade_level, num_pins: c.num_pins, last_update: iso(c.last_update), owner_id: CAST[key].id,
  }));
}
function planetDetail(key, planetId, now) {
  const c = COLONIES[key].find(r => r[0] === Number(planetId));
  return c ? { links: [], pins: colonyPins(c[0], c[1], c[4], c[5], now), routes: [] } : null;
}

// ── Mining ledger (30 days, three systems, six ores) ─────────────────────────
function miningLedger(key, now) {
  if (key !== 'indy') return [];
  const rnd = _rng(77);
  const ORES = [[1230, 240_000], [1228, 120_000], [18, 64_000], [1224, 38_000], [22, 9_400], [11396, 4_200]];
  const SYSTEMS = [PLACES.STAGING.systemId, PLACES.JITA.systemId, PLACES.DODIXIE.systemId];
  const out = [];
  for (let d = 0; d < 30; d++) {
    if (d % 7 === 3) continue;                       // a day off — a flat line looks generated
    const date = new Date(now - d * DAY).toISOString().slice(0, 10);
    for (const [type_id, per] of ORES) {
      if (rnd() < 0.35) continue;                    // not every ore every day
      out.push({ date, solar_system_id: SYSTEMS[Math.floor(rnd() * SYSTEMS.length)], type_id,
                 quantity: Math.round(per * (0.55 + rnd() * 0.9)) });
    }
  }
  return out;
}

// ── Saved fittings (in-game, so the simulator's "Import from Game" has fits) ──
const _fit = (fitting_id, name, ship_type_id, description, slots) => ({
  fitting_id, name, ship_type_id, description,
  items: Object.entries(slots).flatMap(([flag, list]) => list.map(([type_id, quantity = 1], i) =>
    ({ flag: /Bay|Cargo/.test(flag) ? flag : `${flag}${i}`, type_id, quantity }))),
});
function fittings(key) {
  const all = {
    main: [
      _fit(9_100_001, 'Muninn — Vaelin fleet', 12015, 'Doctrine Muninn. Fit exactly; no substitutions.', {
        HiSlot: [[2969], [2969], [2969], [2969], [2969]],
        MedSlot: [[12076], [3841], [3841], [2281]],
        LoSlot: [[519], [519], [519], [1999], [2048]],
        RigSlot: [[31790], [31790]],
        Cargo: [[21922, 2400], [28668, 400], [33474]],
      }),
      _fit(9_100_002, 'Drake — L3 missions', 24698, 'Passive tank, heavy missiles.', {
        HiSlot: [[2410], [2410], [2410], [2410], [2410], [2410], [2410]],
        MedSlot: [[3841], [3841], [2281], [2281], [12058]],
        LoSlot: [[22291], [22291], [2048], [22291]],
        RigSlot: [[31790], [31790], [31790]],
        DroneBay: [[2456, 5], [2488, 5]],
        Cargo: [[209, 3000]],
      }),
    ],
    indy: [
      _fit(9_100_101, 'Orca — belt boosts', 28606, 'Mining foreman + shield burst.', {
        HiSlot: [[43551], [43551], [43555]],
        MedSlot: [[3841], [3841], [10858], [2281]],
        LoSlot: [[2048], [22291]],
        DroneBay: [[2185, 5]],
        Cargo: [[42829, 200], [42695, 100]],
      }),
    ],
    scout: [
      _fit(9_100_201, 'Sabre — bubble tackle', 22456, 'Fast tackle. Bubble on the gate, call the point.', {
        HiSlot: [[22782], [2889], [2889], [2889]],
        MedSlot: [[440], [3244], [3831]],
        LoSlot: [[2048], [2605]],
        RigSlot: [[31358], [31177]],
        Cargo: [[22778, 8], [12608, 2000]],
      }),
    ],
  };
  return all[key] || [];
}

// ── Contracts ────────────────────────────────────────────────────────────────
// The finished Machariel sale is the journal's "Contract - Machariel, fitted"
// (+845M, two hours ago) — same deal, seen from the other side.
function contracts(key, now) {
  const me = CAST[key].id, J = PLACES.JITA.stationId, S = PLACES.STAGING.stationId, A = PLACES.AMARR.stationId;
  const c = (o) => ({
    issuer_id: me, issuer_corporation_id: CAST[key].corpId, assignee_id: 0, acceptor_id: 0,
    availability: 'public', for_corporation: false, days_to_complete: 0,
    price: 0, reward: 0, collateral: 0, buyout: null, volume: 0,
    start_location_id: J, end_location_id: J, ...o,
  });
  const all = {
    main: [
      c({ contract_id: 230_000_101, type: 'item_exchange', status: 'finished', title: 'Machariel, fitted',
          price: 845_000_000, volume: 50_000, acceptor_id: pilot(3).id,
          date_issued: iso(now - 30 * HOUR), date_expired: iso(now + 12 * DAY), date_accepted: iso(now - 2 * HOUR), date_completed: iso(now - 2 * HOUR) }),
      c({ contract_id: 230_000_102, type: 'item_exchange', status: 'outstanding', title: 'Ishtar x2 + Hammerhead II',
          price: 610_000_000, volume: 230_000, date_issued: iso(now - 9 * HOUR), date_expired: iso(now + 13 * DAY) }),
      c({ contract_id: 230_000_103, type: 'courier', status: 'in_progress', title: 'Jita → 1DQ1-A: doctrine hulls',
          reward: 85_000_000, collateral: 1_200_000_000, volume: 312_000, days_to_complete: 3, acceptor_id: pilot(11).id,
          end_location_id: S, date_issued: iso(now - 20 * HOUR), date_expired: iso(now + 6 * DAY), date_accepted: iso(now - 14 * HOUR) }),
      c({ contract_id: 230_000_104, type: 'auction', status: 'outstanding', title: 'Large Skill Injector',
          price: 700_000_000, buyout: 780_000_000, volume: 0.01, date_issued: iso(now - 26 * HOUR), date_expired: iso(now + 2 * DAY) }),
      c({ contract_id: 230_000_105, type: 'item_exchange', status: 'finished', title: 'Megacyte 40k',
          price: 58_600_000, volume: 400, acceptor_id: pilot(23).id, start_location_id: A, end_location_id: A,
          date_issued: iso(now - 6 * DAY), date_expired: iso(now + 8 * DAY), date_accepted: iso(now - 5 * DAY), date_completed: iso(now - 5 * DAY) }),
    ],
    indy: [
      c({ contract_id: 230_000_201, type: 'courier', status: 'finished', title: 'Ore delivery — 1DQ1-A → Jita',
          reward: 42_000_000, collateral: 600_000_000, volume: 860_000, days_to_complete: 7, acceptor_id: pilot(41).id,
          start_location_id: S, end_location_id: J,
          date_issued: iso(now - 4 * DAY), date_expired: iso(now + 10 * DAY), date_accepted: iso(now - 4 * DAY + 3 * HOUR), date_completed: iso(now - 2 * DAY) }),
      c({ contract_id: 230_000_202, type: 'item_exchange', status: 'outstanding', title: 'Caracal x10 — corp stock',
          price: 98_000_000, volume: 920_000, availability: 'personal', assignee_id: CAST.main.id,
          start_location_id: S, end_location_id: S, date_issued: iso(now - 5 * HOUR), date_expired: iso(now + 14 * DAY) }),
    ],
    scout: [
      c({ contract_id: 230_000_301, type: 'item_exchange', status: 'outstanding', title: 'Sabre, fitted',
          price: 72_500_000, volume: 43_000, availability: 'personal', assignee_id: CAST.main.id,
          start_location_id: PLACES.RENS.stationId, end_location_id: PLACES.RENS.stationId,
          date_issued: iso(now - 50 * MIN), date_expired: iso(now + 3 * DAY) }),
    ],
  };
  return all[key] || [];
}

const CONTRACT_ITEMS = {
  230_000_101: [[17738, 1, true, true], [2969, 4, true, false], [519, 3, true, false], [21922, 2000, true, false]],
  230_000_102: [[12005, 2, true, false], [2185, 10, true, false]],
  230_000_103: [[12015, 4, true, false], [11978, 2, true, false]],
  230_000_104: [[40520, 1, true, false]],
  230_000_105: [[40, 40_000, true, false]],
  230_000_201: [[1230, 412_000, true, false], [1228, 188_000, true, false]],
  230_000_202: [[621, 10, true, false]],
  230_000_301: [[22456, 1, true, true], [22782, 1, true, false], [22778, 8, true, false]],
};
function contractItems(contractId) {
  return (CONTRACT_ITEMS[contractId] || []).map(([type_id, quantity, is_included, is_singleton], i) =>
    ({ record_id: contractId * 10 + i, type_id, quantity, is_included, is_singleton }));
}

// ── A fleet in progress (Fleet Tracker) ──────────────────────────────────────
// Kaska boss of a strat op forming in 1DQ1-A: the cast plus agents from the pool
// in doctrine hulls, split into wings the way a real fleet is.
const FLEET_ID = 1_204_400_101;
const WINGS = [
  { id: 2_001, name: 'Muninn Wing', squads: [{ id: 3_001, name: 'DPS 1' }, { id: 3_002, name: 'DPS 2' }] },
  { id: 2_002, name: 'Support',     squads: [{ id: 3_003, name: 'Logistics' }, { id: 3_004, name: 'Tackle' }] },
];
function fleetMembers(now) {
  const S = PLACES.STAGING.systemId;
  const m = (character_id, ship_type_id, wing_id, squad_id, role, joined, system = S) => ({
    character_id, ship_type_id, wing_id, squad_id, role,
    role_name: role === 'fleet_commander' ? 'Fleet Commander (Boss)' : role === 'squad_commander' ? 'Squad Commander' : 'Squad Member',
    join_time: iso(now - joined * MIN), solar_system_id: system, station_id: undefined, takes_fleet_warp: true,
  });
  const rows = [
    m(CAST.main.id,  12015, -1,    -1,    'fleet_commander', 44),
    m(CAST.indy.id,  11978, 2_002, 3_003, 'squad_commander', 41),
    m(CAST.scout.id, 22456, 2_002, 3_004, 'squad_member',    40),
  ];
  const hulls = [12015, 12015, 12015, 12015, 11978, 12015, 12015, 22456, 12015, 12015, 11978, 12015, 29990, 12015, 12015, 12015];
  hulls.forEach((ship, i) => {
    const support = ship !== 12015;
    rows.push(m(pilot(60 + i).id, ship, support ? 2_002 : 2_001,
      support ? (ship === 11978 ? 3_003 : 3_004) : (i % 2 ? 3_002 : 3_001),
      i === 0 || i === 1 ? 'squad_commander' : 'squad_member', 38 - i * 2,
      i === 14 ? 30004722 : S));                     // one straggler a jump out
  });
  return rows;
}
function fleet(now) {
  return {
    info: { is_free_move: true, is_registered: true, is_voice_enabled: false,
            motd: 'Vaelin Collective strat op — Muninn / Scimitar. Comms: Op 3. Anchor up on Kaska Vaelin.' },
    members: fleetMembers(now), wings: WINGS,
    character: { fleet_id: FLEET_ID, fleet_boss_id: CAST.main.id, role: 'fleet_commander', squad_id: -1, wing_id: -1 },
  };
}

module.exports = {
  PLACES, SHIPS, AMAMAKE, keyOf, location, online, IMPLANT_NAMES, implantRows,
  clones, cloneRows, loyaltyEsi, loyaltyRows, standings, fwStats,
  PIN_TYPES, colonyRows, planetsEsi, planetDetail, planetInfo, miningLedger,
  fittings, contracts, contractItems, FLEET_ID, fleet, HOUR, DAY,
};
