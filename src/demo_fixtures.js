'use strict';
//
// ─── demo_fixtures.js — canned ESI responses for demo mode ───────────────────
//
// WHY THIS EXISTS
//
// demo_mode.js redirects the profile and demo_data.js seeds the local database,
// which is enough for every page that reads from disk — assets, blueprints,
// skills, wallet, PI, mining. It is NOT enough for the pages that fetch live:
// Mail, Notifications, the skill queue, Faction Warfare, the map's layers, cost
// indices and the rest all go to ESI, and the demo cast exists nowhere. Those
// pages screenshot empty, which is exactly the half of the app worth showing off.
//
// So in demo mode ESI is answered locally. This is the honest way to produce
// marketing images: the alternative is screenshotting a real account, and a
// killboard advertising a real supercarrier is a target painted on its owner.
//
// WHERE IT HOOKS IN
//
// The single ESI client's seams — esi-fetch (src/ipc/esi_ipc.js) and httpGet /
// httpGetFull / _esiFetch / httpPost (main.js) — because this project enforces
// one ESI client (see src/shared/esi.js and `npm run esi:audit`). That rule was
// written to stop route drift; it also means demo interception has a handful of
// seams instead of thirty call sites.
//
// WHERE THE DATA COMES FROM
//
//   src/demo/cast.js      who exists, and every name an id resolves to
//   src/demo/world.js     the pilots' belongings — shared with the seeder
//   src/demo/skills.js    skill sheets and queues, from real ranks
//   src/demo/universe.js  public data: real snapshots, altered (prices, cost
//                         indices, sov, FW, incursions, traffic)
//
// RULES, INHERITED FROM demo_data.js
//
//   • Timestamps are relative to now, so "3 minutes ago" stays true on every
//     recording rather than rotting into a fixed date.
//   • Every id is a REAL one from the SDE. A fake type id renders as a broken
//     icon and a fake system id as "Unknown", both worse than showing less.
//   • Nothing here is random. A re-record has to match the last one.
//
// Returns `undefined` for an unmatched URL, which means "not ours" — distinct
// from `null`, which is a legitimate body. Unmatched routes never reach the
// network in demo mode; miss() logs them so an empty page says what it wanted.

const { CAST, VAELIN, VAELIN_CORP, CORP_BASE, ALLIANCE_BASE, pilot, nameOf, corpInfo, allianceInfo, PILOT_BY_ID } = require('./demo/cast');
const W = require('./demo/world');
const S = require('./demo/skills');
const U = require('./demo/universe');

const MIN  = 60 * 1000;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;

const MAIN  = CAST.main.id;
const INDY  = CAST.indy.id;
const SCOUT = CAST.scout.id;

const iso = (now, ago) => new Date(now - ago).toISOString();
const keyOf = (id) => S.keyOf(id);

// The rival the demo's killmails are fought against: the largest invented sov
// holder, and its holding corporation.
const RIVAL = { alliance: ALLIANCE_BASE, corp: CORP_BASE };

// ── Mail ─────────────────────────────────────────────────────────────────────
// A mailbox per pilot. One shared list made every message show three times in
// the "All characters" view — once per pilot — which reads as a broken sync.
// Alliance mail is the exception: every member really does receive it.
// Bodies are written out rather than lorem — a reader pausing the video should
// find real sentences. Labels are ESI's: 1 Inbox, 4 Corp, 8 Alliance.
const FC_MAIL = pilot(17).id, DIRECTOR = pilot(2).id, CEO = pilot(9).id;
const MAILS = [
  // [mail_id, to, from, subject, ago, read, labels]
  [4400101, 'all',   FC_MAIL,  'FLEET: Strat op 20:00 — Muninn / Scimitar',      42 * MIN,  false, [8]],
  [4400102, 'main',  INDY,     'Re: Ore hauling contracts this week',            3 * HOUR,  false, [1]],
  [4400103, 'main',  DIRECTOR, 'Structure timer — 1DQ1-A Astrahus',              9 * HOUR,  true,  [8]],
  [4400104, 'main',  SCOUT,    'Thanks for the Machariel fit',                   26 * HOUR, true,  [1]],
  [4400105, 'main',  CEO,      'Corp payout — month end',                        3 * DAY,   true,  [4]],
  [4400201, 'indy',  MAIN,     'Ore hauling contracts this week',                5 * HOUR,  true,  [1]],
  [4400202, 'indy',  CEO,      'Buyback payout — October',                       20 * HOUR, false, [4]],
  [4400203, 'indy',  DIRECTOR, 'Moon schedule — November',                       2 * DAY,   true,  [8]],
  [4400301, 'scout', pilot(23).id, 'Welcome to the militia',                     4 * DAY,   true,  [1]],
  [4400302, 'scout', MAIN,     'Sabre fit for Sunday',                           7 * HOUR,  false, [1]],
];

function mailHeaders(now, characterId = MAIN) {
  const key = keyOf(characterId) || 'main';
  return MAILS.filter(m => m[1] === 'all' || m[1] === key).map(([mail_id, , from, subject, ago, is_read, labels]) => ({
    mail_id, subject, from, is_read, timestamp: iso(now, ago), labels,
    recipients: [{ recipient_id: Number(characterId) || MAIN, recipient_type: 'character' }],
  }));
}

const MAIL_BODIES = {
  4400101: 'Form up 19:45, undock 20:00 sharp.\n\nDoctrine is Muninn with Scimitar support — bring a full flight of light drones and a mobile depot. Staging is 1DQ1-A.\n\nIf you are not in a doctrine hull you will be left behind, no exceptions this time.',
  4400102: 'Yes, I can take the Arkonor run on Thursday. Retriever is fitted and the Orca is already staged.\n\nLeave the contracts up and I will collect them after downtime.',
  4400103: 'Astrahus in 1DQ1-A came out of reinforcement at 03:14.\n\nRepair timer is running now. Anyone in system please keep an eye on d-scan until it finishes.',
  4400104: 'That fit worked perfectly, thanks. Held the field long enough for logi to land.\n\nOwe you a drink next time we are both docked.',
  4400105: 'Monthly payout has been processed. Check your wallet journal for the corporation account withdrawal line.',
  4400201: 'Can you take the Arkonor run on Thursday? The Orca is in 1DQ1-A and the buyback is at 92% this week.',
  4400202: 'Your buyback payout for October is in your wallet: 1.31b for 412k units of compressed ore. Thanks for the haul.',
  4400203: 'November fractures are on the forum calendar. The R64 at 319-3D IV - Moon 1 is the one to be at — bring the Hulks.',
  4400301: 'Welcome to the Tribal Liberation Force. Plex rotations run every evening from Amamake; join the militia channel in game.\n\nFly what you can afford to lose.',
  4400302: 'Fit the Sabre from the forum doctrine thread for Sunday. Bubble on the gate, call the point, and stay aligned.',
};

// ── Notifications ────────────────────────────────────────────────────────────
// Read-only in the app (ESI exposes no write route), so these only ever render.
const STG = W.PLACES.STAGING;
function notifications(now, characterId = MAIN) {
  const key = keyOf(characterId) || 'main';
  const n = (notification_id, type, sender_id, sender_type, ago, is_read, text) =>
    ({ notification_id, type, sender_id, sender_type, timestamp: iso(now, ago), is_read, text });
  const all = {
    main: [
      n(5500201, 'StructureUnderAttack', 1000125, 'corporation', 18 * MIN, false,
        `solarsystemID: ${STG.systemId}\nstructureID: ${STG.stationId}\nstructureShowInfoData:\n- showinfo\n- 35832\n- ${STG.stationId}\nstructureTypeID: 35832\naggressorAllianceID: ${RIVAL.alliance}\naggressorCorpID: ${RIVAL.corp}\nshieldPercentage: 61.4\narmorPercentage: 100.0\nhullPercentage: 100.0\n`),
      n(5500202, 'KillReportFinalBlow', MAIN, 'character', 34 * MIN, false,
        'killMailHash: demo141200301\nkillMailID: 141200301\nvictimShipTypeID: 24688\n'),
      n(5500203, 'InsurancePayoutMsg', 1000132, 'corporation', 26 * HOUR, true,
        'amount: 120000000\nitemID: 1500000004\npayout: 1\n'),
      n(5500204, 'StructureLostShields', 1000125, 'corporation', 2 * DAY, true,
        `solarsystemID: ${STG.systemId}\nstructureID: ${STG.stationId}\nstructureTypeID: 35832\ntimeLeft: 864000000000\n`),
      n(5500205, 'InsuranceExpirationMsg', 1000132, 'corporation', 3 * DAY, true,
        'itemID: 1500000001\nshipTypeID: 17738\n'),
    ],
    indy: [
      n(5500301, 'MoonminingExtractionFinished', 1000125, 'corporation', 5 * HOUR, false,
        `autoTime: 133000000000000000\nmoonID: 40301373\nsolarSystemID: ${STG.systemId}\nstructureID: ${STG.stationId}\noreVolumeByType:\n  45510: 1840211.6\n  45492: 2210984.1\n`),
      n(5500302, 'MoonminingAutomaticFracture', 1000125, 'corporation', 2 * DAY, true,
        `moonID: 40301373\nsolarSystemID: ${STG.systemId}\nstructureID: ${STG.stationId}\n`),
      n(5500303, 'StructureFuelAlert', 1000125, 'corporation', 3 * DAY, true,
        `solarsystemID: ${STG.systemId}\nstructureID: ${STG.stationId}\nstructureShowInfoData:\n- showinfo\n- 35832\n- ${STG.stationId}\nlistOfTypesAndQty:\n- - 120\n  - 4247\n`),
    ],
    scout: [
      n(5500401, 'FWCharRankGainMsg', 1000182, 'corporation', 9 * HOUR, false,
        'factionID: 500002\nnewRank: 4\n'),
      n(5500402, 'KillReportVictim', SCOUT, 'character', 3 * HOUR, true,
        'killMailHash: demo141200190\nkillMailID: 141200190\nvictimShipTypeID: 22456\n'),
    ],
  };
  return all[key] || [];
}

// ── Calendar (ESI's character calendar) ──────────────────────────────────────
// The Calendar PAGE reads the forum and iCal feeds (src/demo/calendar.js); this
// is ESI's own per-character list, which other widgets read. Spread across the
// month rather than bunched, with clusters round the weekend.
const CAL_EVENTS = [
  [-12, 19, 'Alliance town hall',              1, 'accepted'],
  [-9,  20, 'Corp mining fleet — Arkonor',     0, 'accepted'],
  [-6,  18, 'Strategic op — staging move',     1, 'accepted'],
  [-5,  21, 'Skill plan review',               0, 'tentative'],
  [-2,  20, 'Doctrine refit night',            0, 'accepted'],
  [-1,  19, 'Roam — low-sec skirmish',         0, 'accepted'],
  [0,   20, 'Alliance strategic op',           1, 'accepted'],
  [1,   18, 'Industry planning',               0, 'tentative'],
  [3,   21, 'CTA — structure defence',         1, 'not_responded'],
  [4,   19, 'Newbro fleet — free ships',       0, 'accepted'],
  [7,   20, 'Corp meeting — month end',        0, 'tentative'],
  [9,   18, 'Moon extraction — 1DQ1-A',        0, 'accepted'],
  [11,  21, 'Roam — null-sec deployment',      1, 'not_responded'],
  [14,  20, 'Alliance tournament practice',    0, 'tentative'],
];

function calendar(now) {
  // Anchor to local midnight so an event set for 20:00 lands on the intended
  // square rather than sliding a day either way near the date boundary.
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return CAL_EVENTS.map(([dayOffset, hour, title, importance, event_response], i) => {
    const d = new Date(midnight.getTime() + dayOffset * DAY);
    d.setHours(hour, 30, 0, 0);
    return {
      event_id: 6600301 + i, title, event_date: d.toISOString(), importance, event_response,
      duration: 60, owner_name: VAELIN.name, owner_type: 'alliance',
    };
  });
}

// ── Public character / corporation / alliance sheets ─────────────────────────
function characterSheet(id, now) {
  const c = Object.values(CAST).find(x => x.id === Number(id));
  if (c) {
    return { name: c.name, corporation_id: c.corpId, alliance_id: c.allianceId || undefined,
      birthday: iso(now, c.bornDaysAgo * DAY), gender: c.gender, race_id: c.race,
      bloodline_id: c.bloodline, security_status: c.sec };
  }
  const p = PILOT_BY_ID[Number(id)];
  if (p) {
    // Everyone else flies for one of the invented corporations, so their sheet,
    // their killmails and their portrait all agree.
    return { name: p.name, corporation_id: CORP_BASE + (p.id % 40), alliance_id: ALLIANCE_BASE + (p.id % 12),
      birthday: iso(now, (900 + (p.id % 2500)) * DAY), gender: p.male ? 'male' : 'female',
      race_id: p.race, bloodline_id: p.bloodline, security_status: Math.round(((p.id % 100) / 20 - 2) * 10) / 10 };
  }
  return undefined;
}
function corporationSheet(id, now) {
  const c = corpInfo(Number(id));
  if (!c) return undefined;
  const npc = Number(id) < 2_000_000;
  return { name: c.name, ticker: c.ticker, member_count: npc ? 412_000 + (id % 9000) : 40 + (id % 900),
    ceo_id: npc ? 3_000_001 : pilot(id).id, creator_id: npc ? 1 : pilot(id + 1).id,
    alliance_id: npc ? undefined : (Number(id) === VAELIN_CORP.id ? VAELIN.id : ALLIANCE_BASE + (id % 12)),
    faction_id: c.factionId, date_founded: iso(now, (npc ? 7000 : 600 + (id % 3000)) * DAY),
    description: npc ? '' : 'An invented corporation — demo mode.', tax_rate: npc ? 0.11 : 0.1, url: '' };
}
function allianceSheet(id, now) {
  const a = allianceInfo(Number(id));
  if (!a) return undefined;
  const exec = Number(id) === VAELIN.id ? VAELIN_CORP.id : CORP_BASE + (id % 69);
  return { name: a.name, ticker: a.ticker, creator_corporation_id: exec,
    creator_id: pilot(id).id, executor_corporation_id: exec, date_founded: iso(now, (900 + (id % 3000)) * DAY) };
}

// ── Route table ──────────────────────────────────────────────────────────────
// Matched on the PATH: the query string carries datasource and paging, which do
// not change the shape of the answer (where it does — type ids, page numbers —
// it is read explicitly).
function match(url, { now = Date.now() } = {}) {
  let host, path, search;
  try { const u = new URL(url); host = u.hostname; path = u.pathname.replace(/\/+$/, '') || '/'; search = u.searchParams; }
  catch (_) { return undefined; }

  // ── Third-party services ──
  // Market prices (Fuzzwork aggregates). Without these, Asset Value and Wealth
  // Growth sit on "Calculating…" forever. Every requested type gets a price.
  if (/market\.fuzzwork\.co\.uk$/.test(host) || /\/aggregates$/.test(path)) {
    return U.fuzzworkAggregates((search.get('types') || '').split(',').filter(Boolean), fallbackPrice);
  }
  if (/eve-scout\.com$/.test(host) && /\/signatures$/.test(path)) return U.eveScout(now);

  // ── Public universe data (src/demo/universe.js) ──
  // CCP's bulk price list, which the asset valuation reads FIRST.
  if (path === '/markets/prices') return U.marketPrices();
  let m = path.match(/^\/markets\/(\d+)\/orders$/);
  if (m) {
    const t = Number(search.get('type_id'));
    if (!t) return [];
    const ours = Object.keys(CAST).flatMap(k => marketOrders(now, CAST[k].id));
    return U.regionOrders(t, search.get('order_type') || 'all', now, ours);
  }
  m = path.match(/^\/markets\/(\d+)\/history$/);
  if (m) return U.regionHistory(Number(search.get('type_id')), now);
  if (path === '/industry/systems')        return U.industrySystems();
  if (path === '/sovereignty/systems')     return U.sovereigntySystems(now);
  if (path === '/sovereignty/campaigns')   return U.sovCampaigns(now);
  if (path === '/sovereignty/structures')  return [];
  if (path === '/fw/systems')              return U.fwSystems();
  if (path === '/fw/stats')                return U.fwStats();
  if (path === '/fw/wars')                 return U.fwWars();
  if (path === '/fw/leaderboards')         return U.fwLeaderboards();
  m = path.match(/^\/fw\/leaderboards\/(characters|corporations)$/);
  if (m) return U.fwLeaderboards(m[1]);
  if (path === '/incursions')              return U.incursions();
  if (path === '/universe/system_kills')   return U.systemKills();
  if (path === '/universe/system_jumps')   return U.systemJumps();
  if (path === '/status')                  return U.status(now);
  m = path.match(/^\/loyalty\/stores\/(\d+)\/offers$/);
  if (m) return U.lpOffers(Number(m[1]));
  m = path.match(/^\/universe\/planets\/(\d+)$/);
  if (m) return W.planetInfo(m[1]);
  // The implant slot resolver reads attribute 331 (implantSlot) from here.
  m = path.match(/^\/universe\/types\/(\d+)$/);
  if (m && W.IMPLANT_NAMES[Number(m[1])]) {
    const [name, slot] = W.IMPLANT_NAMES[Number(m[1])];
    return { type_id: Number(m[1]), name, published: true, dogma_attributes: [{ attribute_id: 331, value: slot }] };
  }
  m = path.match(/^\/universe\/structures\/(\d+)$/);
  if (m && Number(m[1]) === STG.stationId) {
    return { name: STG.stationName, owner_id: VAELIN.id, solar_system_id: STG.systemId, type_id: STG.typeId,
             position: { x: 1.2e11, y: -3.4e9, z: 8.8e10 } };
  }

  // ── Fleets (the Fleet Tracker's "Start Tracking") ──
  m = path.match(/^\/fleets\/(\d+)(\/members|\/wings)?$/);
  if (m) {
    if (Number(m[1]) !== W.FLEET_ID) return undefined;
    const f = W.fleet(now);
    return m[2] === '/members' ? f.members : m[2] === '/wings' ? f.wings : f.info;
  }

  // ── Public sheets ──
  m = path.match(/^\/characters\/(\d+)$/);
  if (m) return characterSheet(m[1], now);
  m = path.match(/^\/corporations\/(\d+)$/);
  if (m) return corporationSheet(Number(m[1]), now);
  m = path.match(/^\/alliances\/(\d+)$/);
  if (m) return allianceSheet(Number(m[1]), now);
  if (/^\/characters\/\d+\/corporationhistory$/.test(path)) {
    const id = Number(path.split('/')[2]), c = characterSheet(id, now);
    return c ? [{ record_id: 1, corporation_id: c.corporation_id, start_date: iso(now, 400 * DAY) },
                { record_id: 0, corporation_id: 1_000_045, start_date: c.birthday }] : [];
  }
  m = path.match(/^\/corporations\/(\d+)\/industry\/jobs$/);
  if (m) return corpIndustryJobs(now);
  m = path.match(/^\/corporations\/(\d+)\/fw\/stats$/);
  if (m) return Number(m[1]) === 1_000_182
    ? { enlisted_on: iso(now, 7000 * DAY), faction_id: 500_002, pilots: 18_402,
        kills: { last_week: 9_310, total: 2_120_000, yesterday: 1_204 },
        victory_points: { last_week: 7_400_000, total: 1_610_000_000, yesterday: 980_000 } }
    : { kills: { last_week: 0, total: 0, yesterday: 0 }, victory_points: { last_week: 0, total: 0, yesterday: 0 } };

  // ── One of the cast ──
  m = path.match(/^\/characters\/(\d+)\/(.+)$/);
  if (m) return characterRoute(Number(m[1]), m[2], search, now);

  return undefined;   // not ours
}

function characterRoute(id, rest, search, now) {
  const key = keyOf(id);
  // Mail body: mail/{mail_id}
  const body = rest.match(/^mail\/(\d+)$/);
  if (body) {
    const mailId = Number(body[1]);
    const h = MAILS.find(x => x[0] === mailId);
    return { from: h ? h[2] : MAIN, subject: h ? h[3] : '', body: MAIL_BODIES[mailId] || '',
             labels: h ? h[6] : [1], read: true, timestamp: h ? iso(now, h[4]) : undefined,
             recipients: [{ recipient_id: id, recipient_type: 'character' }] };
  }
  switch (rest) {
    case 'mail':          return mailHeaders(now, id);
    case 'mail/labels': {
      const mine = mailHeaders(now, id), unread = (l) => mine.filter(x => !x.is_read && x.labels.includes(l)).length;
      return { labels: [
        { label_id: 1, name: 'Inbox',       color: '#ffffff', unread_count: unread(1) },
        { label_id: 4, name: 'Corporation', color: '#ffffff', unread_count: unread(4) },
        { label_id: 8, name: 'Alliance',    color: '#6666ff', unread_count: unread(8) },
      ], total_unread_count: mine.filter(x => !x.is_read).length };
    }
    case 'mail/lists':    return [];
    case 'notifications': return notifications(now, id);
    case 'calendar':      return calendar(now);
  }
  if (!key) return undefined;
  switch (rest) {
    case 'skills':        return S.skills(key);
    case 'skillqueue':    return S.skillQueue(key, now);
    case 'attributes':    return S.attributes(key, now);
    case 'implants':      return S.implants(key);
    case 'clones':        return W.clones(key, now);
    case 'location':      return W.location(key);
    case 'ship': { const { typeName, ...ship } = W.SHIPS[key]; return ship; }
    case 'online':        return W.online(key, now);
    case 'standings':     return W.standings(key);
    case 'loyalty/points': return W.loyaltyEsi(key);
    case 'fw/stats':      return W.fwStats(key, now);
    case 'fittings':      return W.fittings(key);
    case 'contracts':     return Number(search.get('page') || 1) > 1 ? [] : W.contracts(key, now);
    case 'planets':       return W.planetsEsi(key, now);
    case 'mining':        return W.miningLedger(key, now);
    case 'wallet':        return CAST[key].balance;
    case 'industry/jobs': return industryJobs(now, id);
    case 'orders':        return marketOrders(now, id);
    case 'fleet': {
      const f = W.fleet(now).members.find(x => x.character_id === id);
      return f ? { fleet_id: W.FLEET_ID, fleet_boss_id: MAIN, role: f.role, squad_id: f.squad_id, wing_id: f.wing_id } : undefined;
    }
  }
  let m = rest.match(/^contracts\/(\d+)\/items$/);
  if (m) return W.contractItems(Number(m[1]));
  m = rest.match(/^planets\/(\d+)$/);
  if (m) return W.planetDetail(key, m[1], now);
  return undefined;
}

// Writes the demo answers with success and nothing more — setting a waypoint,
// opening an info window, inviting to fleet, sending mail, saving a fit. On
// camera the button works; nothing leaves the machine.
function isDemoWrite(url) {
  try {
    const p = new URL(url).pathname;
    return /^\/ui\//.test(p) || /^\/fleets\/\d+\/(members|wings|squads)/.test(p) ||
           /^\/characters\/\d+\/(mail|fittings|contacts)\/?$/.test(p) ||
           /^\/characters\/\d+\/mail\/\d+\/?$/.test(p);
  } catch (_) { return false; }
}

// ── Names, ids and routes (POST, and anything needing the SDE) ───────────────
// Static data — systems, types, stations — resolves from the local SDE; every id
// the demo hands out resolves from cast.js. Nothing reaches /universe/names/ on
// the network: the first demo did, and its fake killmail ids came back as real
// players' names.
async function resolveNames(ids, sde) {
  const out = new Map();
  const rest = [];
  for (const raw of ids || []) {
    const id = Number(raw);
    const n = nameOf(id);
    if (n) out.set(id, { id, ...n }); else rest.push(id);
  }
  if (rest.length && sde) {
    const list = rest.filter(Number.isFinite).join(',') || '0';
    const q = async (sql, category) => {
      try { for (const r of await sde.all(sql)) out.set(r.id, { id: r.id, name: r.name, category }); } catch (_) {}
    };
    await q(`SELECT solarSystemID id, solarSystemName name FROM mapSolarSystems WHERE solarSystemID IN (${list})`, 'solar_system');
    await q(`SELECT constellationID id, constellationName name FROM mapConstellations WHERE constellationID IN (${list})`, 'constellation');
    await q(`SELECT regionID id, regionName name FROM mapRegions WHERE regionID IN (${list})`, 'region');
    await q(`SELECT stationID id, stationName name FROM staStations WHERE stationID IN (${list})`, 'station');
    await q(`SELECT typeID id, typeName name FROM invTypes WHERE typeID IN (${list})`, 'inventory_type');
  }
  return [...out.values()];
}

async function resolveIds(names, sde) {
  const out = {};
  const add = (k, row) => { (out[k] = out[k] || []).push(row); };
  const byName = new Map();
  for (const c of Object.values(CAST)) byName.set(c.name.toLowerCase(), { id: c.id, name: c.name, k: 'characters' });
  for (const p of Object.values(PILOT_BY_ID)) byName.set(p.name.toLowerCase(), { id: p.id, name: p.name, k: 'characters' });
  const rest = [];
  for (const raw of names || []) {
    const hit = byName.get(String(raw).toLowerCase());
    if (hit) add(hit.k, { id: hit.id, name: hit.name }); else rest.push(String(raw));
  }
  if (rest.length && sde) {
    const ph = rest.map(() => '?').join(',');
    const q = async (sql, k) => { try { for (const r of await sde.all(sql, rest)) add(k, { id: r.id, name: r.name }); } catch (_) {} };
    await q(`SELECT solarSystemID id, solarSystemName name FROM mapSolarSystems WHERE solarSystemName IN (${ph})`, 'systems');
    await q(`SELECT regionID id, regionName name FROM mapRegions WHERE regionName IN (${ph})`, 'regions');
    await q(`SELECT typeID id, typeName name FROM invTypes WHERE typeName IN (${ph}) AND published = 1`, 'inventory_types');
  }
  return out;
}

// Static universe sheets — systems, constellations, regions — the locator and
// the maps ask ESI for. The SDE holds the same facts, so they come from there.
async function staticUniverse(path, sde) {
  try {
    let m = path.match(/^\/universe\/systems\/(\d+)$/);
    if (m) {
      const r = await sde.get(`SELECT solarSystemID id, solarSystemName name, constellationID c, security s, x, y, z
                                 FROM mapSolarSystems WHERE solarSystemID = ?`, [Number(m[1])]);
      return r ? { system_id: r.id, name: r.name, constellation_id: r.c, security_status: r.s,
                   position: { x: r.x, y: r.y, z: r.z } } : undefined;
    }
    m = path.match(/^\/universe\/constellations\/(\d+)$/);
    if (m) {
      const r = await sde.get('SELECT constellationID id, constellationName name, regionID rg FROM mapConstellations WHERE constellationID = ?', [Number(m[1])]);
      if (!r) return undefined;
      const sys = await sde.all('SELECT solarSystemID id FROM mapSolarSystems WHERE constellationID = ?', [r.id]);
      return { constellation_id: r.id, name: r.name, region_id: r.rg, systems: sys.map(s => s.id) };
    }
    m = path.match(/^\/universe\/regions\/(\d+)$/);
    if (m) {
      const r = await sde.get('SELECT regionID id, regionName name FROM mapRegions WHERE regionID = ?', [Number(m[1])]);
      if (!r) return undefined;
      const cons = await sde.all('SELECT constellationID id FROM mapConstellations WHERE regionID = ?', [r.id]);
      return { region_id: r.id, name: r.name, constellations: cons.map(c => c.id) };
    }
  } catch (_) { /* fall through to the route table */ }
  return undefined;
}

// Shortest gate route on the SDE's own jump graph — the cost index's "within N
// jumps" filter asks ESI's POST /route/ for every candidate system.
let _jumps = null;
async function route(from, to, sde) {
  if (!_jumps) {
    _jumps = new Map();
    for (const r of await sde.all('SELECT fromSolarSystemID a, toSolarSystemID b FROM mapSolarSystemJumps')) {
      if (!_jumps.has(r.a)) _jumps.set(r.a, []);
      _jumps.get(r.a).push(r.b);
    }
  }
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of _jumps.get(cur) || []) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      if (nb === to) {
        const path = [to];
        for (let p = cur; p !== null; p = prev.get(p)) path.unshift(p);
        return path;
      }
      queue.push(nb);
    }
  }
  return null;
}

/**
 * The async half of the router: POSTs (names, ids, routes, writes), and any GET
 * match() answers. `sde` is the app's open SDE handle, used for static names.
 * Returns `undefined` when the request is not ours.
 */
async function matchAsync(url, { method = 'GET', body, sde, now = Date.now() } = {}) {
  let path;
  try { path = new URL(url).pathname.replace(/\/+$/, ''); } catch (_) { return undefined; }
  if (String(method).toUpperCase() === 'GET' && sde) {
    const st = await staticUniverse(path, sde);
    if (st !== undefined) return st;
  }
  if (String(method).toUpperCase() !== 'GET') {
    if (path === '/universe/names') return resolveNames(Array.isArray(body) ? body : [], sde);
    if (path === '/universe/ids')   return resolveIds(Array.isArray(body) ? body : [], sde);
    const r = path.match(/^\/route\/(\d+)\/(\d+)$/);
    if (r && sde) { const p = await route(Number(r[1]), Number(r[2]), sde); return p ? { route: p } : { route: [] }; }
    if (isDemoWrite(url)) return {};
    return undefined;
  }
  return match(url, { now });
}

// ── Misses ───────────────────────────────────────────────────────────────────
// One log line per unfixtured route, ids folded to {id}, so a page that comes up
// empty in demo mode names the request it was waiting on instead of degrading
// in silence.
const _missed = new Set();
function miss(url) {
  let key;
  try { const u = new URL(url); key = u.host + u.pathname.replace(/\/\d+(?=\/|$)/g, '/{id}'); }
  catch (_) { key = String(url).slice(0, 120); }
  if (_missed.has(key)) return;
  _missed.add(key);
  console.log(`[demo] no fixture: ${key}`);
}

// ── Market prices ────────────────────────────────────────────────────────────
// Real prices come from the snapshot (src/demo/universe.js). A type it does not
// hold — rare — falls into a plausible band by magnitude, derived from the id so
// a re-record produces identical net-worth figures.
function fallbackPrice(id) {
  const h = (id * 2654435761) % 1000;
  return id < 1000 ? 20 + h / 10 : id < 20000 ? 1_000_000 + h * 41_000 : 12_000_000 + h * 380_000;
}
function fuzzworkAggregates(typeIds) { return U.fuzzworkAggregates(typeIds, fallbackPrice); }
const marketPrices = () => U.marketPrices();

// Kept for callers that enumerate the demo's types (the valuation tests).
const DEMO_TYPE_IDS = [
  34, 35, 36, 37, 38, 39, 40, 22, 1223, 1225, 1230, 11396, 587, 621, 638, 691, 2389, 3689, 9832,
  12005, 17738, 17739, 24698, 24699, 28606, 12015, 11978, 22456, 29990, 24688, 24702, 34828, 670,
  44992, 40520, 11399,
];

// ── Skill queue ──────────────────────────────────────────────────────────────
// Generated per pilot from real ranks (src/demo/skills.js); the head is
// part-trained and every finish date follows from the pilot's attributes.
function skillQueue(now, characterId = MAIN) { return S.skillQueue(keyOf(characterId) || 'main', now); }

// ── Industry jobs ────────────────────────────────────────────────────────────
// Real blueprint → product pairs from industryActivityProducts. Research and
// copying name the blueprint itself as the product, as ESI does. A mix of
// running and nearly done, across activities, so the bars sit at different fills.
const JOBS = [
  // [job_id, who, blueprint, product, activity, runs, startedAgo, endsIn, system, cost]
  [70001, 'main',  24699, 24698, 1, 10, 6 * HOUR,  2 * HOUR,   30004759, 18_420_000],   // Drake ×10
  [70002, 'main',    688,   638, 1,  2, 20 * HOUR, 30 * MIN,   30004759,  9_310_000],   // Raven ×2
  [70003, 'main',    687, 11994, 8,  1, 30 * HOUR, 44 * HOUR,  30004759,  4_880_000],   // Cerberus BPC (invention)
  [70004, 'indy',    687,   621, 1, 20, 9 * HOUR,  5 * HOUR,   30004759, 11_250_000],   // Caracal ×20
  [70005, 'indy',  28607, 28607, 4,  1, 3 * DAY,   28 * HOUR,  30004722,  6_900_000],   // Orca BP — ME research
  [70006, 'indy',  17739, 17739, 3,  1, 2 * DAY,   9 * HOUR,   30004722,  3_120_000],   // Machariel BP — TE research
  [70007, 'indy',    691,   691, 5,  5, 12 * HOUR, 4 * HOUR,   30004759,    410_000],   // Rifter BP — copying
  [70008, 'indy',  12006, 12005, 1,  1, 40 * HOUR, 22 * HOUR,  30004759, 22_600_000],   // Ishtar
  [70009, 'scout',   691, 11372, 8,  2, 10 * HOUR, 14 * HOUR,  30004759,  1_920_000],   // Wolf BPC (invention)
  [70010, 'scout',   692,   692, 5,  3, 7 * HOUR,  3 * HOUR,   30004759,    260_000],   // Stabber BP — copying
];
function _job([job_id, who, blueprint_type_id, product_type_id, activity_id, runs, startedAgo, endsIn, system, cost], now) {
  const installer_id = CAST[who].id;
  return {
    job_id, installer_id, facility_id: STG.stationId, station_id: STG.stationId,
    activity_id, blueprint_id: 1_600_000_000 + job_id, blueprint_type_id,
    blueprint_location_id: STG.stationId, output_location_id: STG.stationId,
    product_type_id, runs, cost, licensed_runs: runs, status: 'active',
    duration: Math.round((startedAgo + endsIn) / 1000),
    start_date: iso(now, startedAgo), end_date: iso(now, -endsIn),
    solar_system_id: system,
  };
}
function industryJobs(now, characterId = MAIN) {
  const key = keyOf(characterId) || 'main';
  return JOBS.filter(j => j[1] === key).map(j => _job(j, now));
}
function corpIndustryJobs(now) {
  // The corporation's own lines, installed by the cast on its behalf.
  return [
    [71001, 'indy',  24699, 24698, 1, 25, 14 * HOUR, 11 * HOUR, 30004759, 46_800_000],
    [71002, 'main',    687,   621, 1, 40, 22 * HOUR, 90 * MIN,  30004759, 22_400_000],
    [71003, 'indy',  12006, 12006, 4,  1, 4 * DAY,   2 * DAY,   30004722,  8_150_000],
    [71004, 'scout',   691,   587, 1, 50, 3 * HOUR,  52 * MIN,  30004759,  1_150_000],
  ].map(j => _job(j, now));
}

// ── Market orders ────────────────────────────────────────────────────────────
// Buys and sells both, because the widget splits them and one-sided data hides
// half the layout. Each pilot their own book.
function marketOrders(now, characterId = MAIN) {
  const key = keyOf(characterId) || 'main';
  const o = (order_id, type_id, is_buy_order, price, volume_total, volume_remain, region_id, location_id, issuedAgo) => ({
    order_id, type_id, is_buy_order, price, volume_total, volume_remain, min_volume: 1,
    duration: 90, escrow: is_buy_order ? price * volume_remain : 0,
    issued: iso(now, issuedAgo), range: 'station', region_id, location_id,
  });
  const p = (t, f) => Math.round((U.priceOf(t) || { sell: fallbackPrice(t) }).sell * f * 100) / 100;
  const books = {
    main: [
      o(80001, 44992, false, p(44992, 1.01), 40, 12, 10000002, 60003760, 3 * HOUR),     // PLEX
      o(80002, 40520, false, p(40520, 0.99), 4, 1, 10000002, 60003760, 9 * HOUR),       // Large Skill Injector
      o(80003, 34,    true,  p(34, 0.9), 50_000_000, 18_400_000, 10000002, 60003760, 26 * HOUR), // Tritanium
      o(80005, 12015, false, p(12015, 1.03), 3, 3, 10000060, STG.stationId, 4 * DAY),   // Muninn in Delve
    ],
    indy: [
      o(80101, 621,   false, p(621, 1.02), 20, 14, 10000002, 60003760, 6 * HOUR),       // Caracal
      o(80102, 2389,  false, p(2389, 1.0), 60_000, 41_200, 10000002, 60003760, 2 * DAY), // Plasmoids
      o(80103, 11399, true,  p(11399, 0.92), 120, 84, 10000060, STG.stationId, 2 * DAY), // Morphite
    ],
    scout: [
      o(80201, 22456, false, p(22456, 1.04), 2, 2, 10000030, 60004588, 11 * HOUR),      // Sabre in Rens
    ],
  };
  return books[key] || [];
}

// ── Jabber: Beehive status ───────────────────────────────────────────────────
// Not a network fetch — supplied at its IPC handler. Without it the widget reads
// "UNKNOWN — waiting for Beehive MOTD", which looks like the app failing.
// (Director pings are seeded into the demo's Jabber database — src/demo/pings.js.)
function beehiveStatus(now = Date.now()) {
  return {
    // The traffic light only understands green/yellow/red/unknown — the words
    // parseBeehiveStatus() produces.
    status: 'green',
    text:
      'HOME GUARD: GREEN\n'
      + 'Cover fleet is UP. Rorquals cleared to undock in 1DQ1-A and 319-3D.\n'
      + 'Join "Vaelin Home Cover" before undocking.',
    changedAt: new Date(now - 48 * MIN).toISOString(),
  };
}

// ── Early warning (intel) ────────────────────────────────────────────────────
//
// Based out of 1DQ1-A, the same staging the rest of the demo profile uses. The
// contacts are a spread of urgencies on purpose: one hostile two jumps out that
// the widget renders as critical, one further gang, and a clear report. All the
// same colour would make the urgency banding invisible in a screenshot.
function intelStatus() {
  // origins/reach are what the widget header reads ("3 characters · 212
  // systems"); without them it said NO POSITION MONITORED over live contacts.
  const origin = (key, systemId, systemName) => ({
    key: String(CAST[key].id), characterId: CAST[key].id, label: CAST[key].name, systemId, systemName, source: 'chatlog' });
  return {
    running: true,
    systems: 212,
    reach: 212,
    origins: [origin('main', 30004759, '1DQ1-A'), origin('indy', 30004759, '1DQ1-A'), origin('scout', 30004722, '319-3D')],
    // INVENTED channel names. The first version of this fixture used real
    // nullsec intel channels, which is the same mistake as screenshotting a real
    // killboard: a published image would have told anyone watching which
    // channels a group actually monitors. Nothing here names a real channel.
    channels: ['vaelin.intel', 'vaelin.home', 'vaelin.forward'],
    characters: 3,
    home: { solarSystemId: 30004759, name: '1DQ1-A' },
  };
}

// Field names come from the SHARED row builder (src/shared/intel-row.js), which
// reads label/ships/shipIds/pilots/etaSeconds — not name/ship/eta. Pilots are
// NPC agents, so a portrait lookup by name finds a face that is nobody's.
// `closing` is how many jumps a contact has closed — the row prints "IN −2" —
// and only inbound contacts carry one. A boolean there printed "IN −true".
function intelContacts(now = Date.now()) {
  const c = (o) => Object.assign({ last: now - 90 * 1000, etaMeasured: true, inbound: false, closing: 0 }, o);
  return [
    c({ kind: 'pilot', label: '319-3D', solarSystemId: 30004722, regionName: 'Delve',
        jumps: 2, js: 2, ships: ['Loki'], shipIds: [29990], pilots: [pilot(101).name],
        count: 1, size: 1, band: 'solo', roles: ['cloaky'],
        security: -0.32, etaSeconds: 75, inbound: true, closing: 2 }),
    c({ kind: 'pilot', label: 'T5ZI-S', solarSystemId: 30004735, regionName: 'Delve',
        jumps: 3, js: 3, ships: ['Sabre', 'Jackdaw'], shipIds: [22456, 34828],
        pilots: [pilot(102).name, pilot(103).name], count: 2, size: 2, band: 'small', roles: [],
        security: -0.14, etaSeconds: 140, inbound: true, closing: 1 }),
    c({ kind: 'system', label: 'YZ9-F6', solarSystemId: 30004719, regionName: 'Delve',
        jumps: 4, js: 4, ships: ['Muninn', 'Scimitar'], shipIds: [12015, 11978],
        pilots: [], count: 14, size: 14, band: 'fleet', roles: ['capital', 'logi'],
        security: -0.18, etaSeconds: 220 }),
    c({ kind: 'system', label: 'K-6K16', solarSystemId: 30004751, regionName: 'Delve',
        jumps: 5, js: 5, ships: [], shipIds: [], pilots: [], count: 0, size: 0,
        band: null, roles: [], camp: false, clear: true, status: 'clear',
        security: -0.43, etaSeconds: 300, body: 'clear' }),
  ];
}

// ── zKillboard ───────────────────────────────────────────────────────────────
//
// The Killboard page does not go through ESI at all — it calls zKillboard's
// public API through its own IPC handlers. It is also the page with the
// strongest reason to be faked: a screenshot of a real killboard publishes what
// its owner flies and loses, and a supercarrier on that list is a target.
//
// These return RAW zkill shapes on purpose. The handlers map them into the
// app's own row shape, and intercepting before that mapping means the real
// mapping code still runs — a fixture that bypassed it would prove nothing.

const D = {                       // real Delve system ids, as everywhere else
  DQ: 30004759, T319: 30004722, T5ZI: 30004735, YZ9: 30004719,
};
const SHIP = {                    // real hull ids
  muninn: 12015, scimitar: 11978, sabre: 22456, loki: 29990,
  machariel: 17738, rokh: 24688, hurricane: 24702, jackdaw: 34828, capsule: 670,
};

/** Raw zkill killmails for one entity. Kills and losses, newest first. */
function zkillFeed(kind, entityId, page = 1, now = Date.now()) {
  if (page > 1) return [];        // one page of demo history is plenty
  const id = Number(entityId) || MAIN;
  const corp = CAST.main.corpId;
  const foe = (n) => pilot(100 + n).id;

  const mk = (killmail_id, ago, sys, victim, attackers, isk) => ({
    killmail_id,
    killmail_time: iso(now, ago),
    solar_system_id: sys,
    victim,
    attackers,
    zkb: { totalValue: isk, npc: false, solo: attackers.length === 1, hash: 'demo' + killmail_id },
  });
  const us    = (ship, character_id = id) => ({ character_id, corporation_id: corp, ship_type_id: ship, damage_taken: 4210 });
  const them  = (ship, character_id) => ({ character_id, corporation_id: RIVAL.corp, alliance_id: RIVAL.alliance, ship_type_id: ship, damage_taken: 8800 });
  const themA = (ship, character_id, final_blow = false) => ({ character_id, corporation_id: RIVAL.corp, alliance_id: RIVAL.alliance, ship_type_id: ship, final_blow });
  const ourA  = (ship, character_id = id, final_blow = false) => ({ character_id, corporation_id: corp, ship_type_id: ship, final_blow });

  return [
    // Recent kills — us on the attacking side
    mk(141_200_301, 34 * MIN, D.YZ9,  them(SHIP.rokh, foe(1)),
       [ourA(SHIP.muninn, id, true), ourA(SHIP.scimitar, INDY)], 284_610_000),
    mk(141_200_298, 52 * MIN, D.YZ9,  them(SHIP.hurricane, foe(2)),
       [ourA(SHIP.muninn, id, true)], 96_250_000),
    mk(141_200_244, 2 * HOUR + 10 * MIN, D.T5ZI, them(SHIP.jackdaw, foe(3)),
       [ourA(SHIP.muninn, id), ourA(SHIP.sabre, SCOUT, true)], 148_020_000),
    // A loss — we were the victim
    mk(141_200_190, 3 * HOUR, D.T5ZI, us(SHIP.sabre, SCOUT),
       [themA(SHIP.loki, foe(4), true)], 71_880_000),
    mk(141_199_880, 9 * HOUR, D.T319, them(SHIP.capsule, foe(3)),
       [ourA(SHIP.sabre, SCOUT, true)], 10_000),
    mk(141_198_402, 28 * HOUR, D.DQ,  them(SHIP.machariel, foe(5)),
       [ourA(SHIP.muninn, id, true), ourA(SHIP.scimitar, INDY)], 1_842_400_000),
    mk(141_197_115, 2 * DAY, D.DQ,    us(SHIP.muninn, id),
       [themA(SHIP.rokh, foe(6), true)], 231_500_000),
  ];
}

/**
 * zKill stats, including the rankings/rankHistory the app reads for rank trends.
 * The history snapshot is deliberately WORSE than current, so the arrows render
 * as climbing rather than flat — a flat demo shows the feature doing nothing.
 */
function zkillStats(kind, entityId, now = Date.now()) {
  const period = (overall, destroyed, lost, shipsDestroyed, shipsLost) => ({
    all: {
      ranks:   { overall, shipsDestroyed: destroyed, shipsLost: lost },
      metrics: { shipsDestroyed, shipsLost },
    },
  });
  const day = (n) => new Date(now - n * DAY).toISOString().slice(0, 10);

  return {
    shipsDestroyed: 412, shipsLost: 63,
    iskDestroyed: 84_612_400_000, iskLost: 6_120_800_000,
    soloKills: 37, dangerRatio: 87, gangRatio: 61,
    rankings: {
      alltime: period(18422, 20114, 91233, 412, 63),
      recent:  period(9044, 10233, 44120, 366, 55),
      weekly:  period(3120, 3488, 15220, 101, 12),
    },
    rankHistory: {
      alltime: { all: { [day(7)]: { ranks: { overall: 19980, shipsDestroyed: 21400, shipsLost: 90880 },
                                    metrics: { shipsDestroyed: 388, shipsLost: 61 } } } },
      recent:  { all: { [day(7)]: { ranks: { overall: 10120, shipsDestroyed: 11002, shipsLost: 44980 },
                                    metrics: { shipsDestroyed: 351, shipsLost: 58 } } } },
      weekly:  { all: { [day(7)]: { ranks: { overall: 4010, shipsDestroyed: 4220, shipsLost: 15980 },
                                    metrics: { shipsDestroyed: 96, shipsLost: 14 } } } },
    },
  };
}

module.exports = {
  match, matchAsync, miss, isDemoWrite, resolveNames, resolveIds, route,
  mailHeaders, notifications, calendar, MAIL_BODIES,
  fuzzworkAggregates, marketPrices, DEMO_TYPE_IDS, skillQueue, industryJobs, corpIndustryJobs, marketOrders,
  beehiveStatus, intelStatus, intelContacts,
  zkillFeed, zkillStats,
  MAIN, INDY, SCOUT,
};
