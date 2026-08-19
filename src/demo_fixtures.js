'use strict';
//
// ─── demo_fixtures.js — canned ESI responses for demo mode ───────────────────
//
// WHY THIS EXISTS
//
// demo_mode.js redirects the profile and demo_data.js seeds the local database,
// which is enough for every page that reads from disk — assets, blueprints,
// skills, wallet, PI, mining. It is NOT enough for the pages that fetch live:
// Mail, Notifications, Calendar and Faction Warfare all go to ESI, and the demo
// cast (2118400001 and friends) are character ids that do not exist. Those pages
// screenshot empty, which is exactly the half of the app worth showing off.
//
// So in demo mode ESI is answered locally. This is the honest way to produce
// marketing images: the alternative is screenshotting a real account, and a
// killboard advertising a real supercarrier is a target painted on its owner.
//
// WHERE IT HOOKS IN
//
// One place — the `esi-fetch` IPC in src/ipc/esi_ipc.js — because this project
// enforces a single ESI client (see src/shared/esi.js and `npm run esi:audit`).
// That rule was written to stop route drift; it also means demo interception has
// exactly one seam instead of thirty call sites.
//
// RULES, INHERITED FROM demo_data.js
//
//   • Timestamps are relative to now, so "3 minutes ago" stays true on every
//     recording rather than rotting into a fixed date.
//   • Every id is a REAL one from the SDE. A fake type id renders as a broken
//     icon and a fake system id as "Unknown", both worse than showing less.
//   • Nothing here is random. A re-record has to match the last one.
//
// Returns `undefined` for an unmatched URL, which means "not ours, let it go to
// the network" — deliberately distinct from `null`, which is a legitimate body.

const MIN  = 60 * 1000;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;

// The demo cast, mirrored from demo_data.js. Duplicated rather than imported
// because demo_data pulls in the database layer, and this module is loaded on
// the IPC path where that would be a needless cost.
const MAIN = 2118400001;
const INDY = 2118400002;
const SCOUT = 2118400003;

const iso = (now, ago) => new Date(now - ago).toISOString();

// ── Mail ─────────────────────────────────────────────────────────────────────
// A believable inbox: alliance broadcast, a corp logistics thread, one personal
// reply, one unread ping. Bodies are written out rather than lorem — a reader
// pausing the video should find real sentences.
function mailHeaders(now) {
  return [
    { mail_id: 4400101, subject: 'FLEET: Strat op 20:00 — Muninn / Scimitar',
      from: 98000101, is_read: false, timestamp: iso(now, 42 * MIN),
      labels: [4], recipients: [{ recipient_id: MAIN, recipient_type: 'character' }] },
    { mail_id: 4400102, subject: 'Re: Ore hauling contracts this week',
      from: INDY, is_read: false, timestamp: iso(now, 3 * HOUR),
      labels: [1], recipients: [{ recipient_id: MAIN, recipient_type: 'character' }] },
    { mail_id: 4400103, subject: 'Structure timer — 1DQ1-A Astrahus',
      from: 98000101, is_read: true, timestamp: iso(now, 9 * HOUR),
      labels: [4], recipients: [{ recipient_id: MAIN, recipient_type: 'character' }] },
    { mail_id: 4400104, subject: 'Thanks for the Machariel fit',
      from: SCOUT, is_read: true, timestamp: iso(now, 26 * HOUR),
      labels: [1], recipients: [{ recipient_id: MAIN, recipient_type: 'character' }] },
    { mail_id: 4400105, subject: 'Corp payout — month end',
      from: 98000102, is_read: true, timestamp: iso(now, 3 * DAY),
      labels: [1], recipients: [{ recipient_id: MAIN, recipient_type: 'character' }] },
  ];
}

const MAIL_BODIES = {
  4400101: 'Form up 19:45, undock 20:00 sharp.\n\nDoctrine is Muninn with Scimitar support — bring a full flight of light drones and a mobile depot. Staging is 1DQ1-A.\n\nIf you are not in a doctrine hull you will be left behind, no exceptions this time.',
  4400102: 'Yes, I can take the Arkonor run on Thursday. Retriever is fitted and the Orca is already staged.\n\nLeave the contracts up and I will collect them after downtime.',
  4400103: 'Astrahus in 1DQ1-A came out of reinforcement at 03:14.\n\nRepair timer is running now. Anyone in system please keep an eye on d-scan until it finishes.',
  4400104: 'That fit worked perfectly, thanks. Held the field long enough for logi to land.\n\nOwe you a drink next time we are both docked.',
  4400105: 'Monthly payout has been processed. Check your wallet journal for the corporation account withdrawal line.',
};

// ── Notifications ────────────────────────────────────────────────────────────
// Read-only in the app (ESI exposes no write route), so these only ever render.
function notifications(now) {
  return [
    { notification_id: 5500201, type: 'StructureUnderAttack', sender_id: 1000125, sender_type: 'corporation',
      timestamp: iso(now, 18 * MIN), is_read: false,
      text: 'solarsystemID: 30004759\nstructureID: 1035466617946\nstructureShowInfoData:\n- showinfo\n- 35832\n- 1035466617946\n' },
    { notification_id: 5500202, type: 'MoonminingExtractionFinished', sender_id: 1000125, sender_type: 'corporation',
      timestamp: iso(now, 5 * HOUR), is_read: false,
      text: 'autoTime: 133000000000000000\nmoonID: 40000001\nsolarSystemID: 30004759\nstructureID: 1035466617946\n' },
    { notification_id: 5500203, type: 'InsuranceExpirationMsg', sender_id: 1000132, sender_type: 'corporation',
      timestamp: iso(now, 2 * DAY), is_read: true,
      text: 'itemID: 1500000001\nshipTypeID: 17738\n' },
  ];
}

// ── Calendar ─────────────────────────────────────────────────────────────────
//
// Spread across the WHOLE month rather than bunched on two days. A calendar with
// three entries sitting on one square looks like a calendar that does not work;
// the point of the month view is that it fills.
//
// Offsets are in days from today, deliberately uneven — a real corp schedule has
// clusters around the weekend and gaps mid-week, not one event every third day.
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
      event_id: 6600301 + i,
      title,
      event_date: d.toISOString(),
      importance,
      event_response,
      duration: 60,
      owner_name: 'Vaelin Industries',
      owner_type: 'corporation',
    };
  });
}

// ── Route table ──────────────────────────────────────────────────────────────
// Matched on the PATH only: the query string carries datasource and paging,
// neither of which changes the shape of the answer.
function match(url, { now = Date.now() } = {}) {
  let path, search;
  try { const u = new URL(url); path = u.pathname; search = u.searchParams; }
  catch (_) { return undefined; }

  // Market prices (Fuzzwork aggregates). Without these, Asset Value and Wealth
  // Growth sit on "Calculating…" forever, which is the most visible widget on
  // the dashboard reading as broken. Every requested type gets a price — a
  // partial answer would leave the totals wrong rather than merely fake.
  if (/market\.fuzzwork\.co\.uk$/.test(new URL(url).hostname) || /\/aggregates\/?$/.test(path)) {
    return fuzzworkAggregates((search.get('types') || '').split(',').filter(Boolean));
  }

  // CCP's bulk price list, which the asset valuation reads FIRST — it covers
  // ~91% of held types in one call. Without it the valuation never completes and
  // the banner sits on "Calculating…" while Wealth Growth waits on asset prices.
  if (/\/markets\/prices\/?$/.test(path)) return marketPrices();

  // Mail body: /characters/{id}/mail/{mail_id}
  const body = path.match(/\/characters\/\d+\/mail\/(\d+)\/?$/);
  if (body) {
    const id = Number(body[1]);
    return { from: MAIN, subject: (mailHeaders(now).find((m) => m.mail_id === id) || {}).subject || '',
             body: MAIL_BODIES[id] || '', labels: [1], read: true,
             recipients: [{ recipient_id: MAIN, recipient_type: 'character' }] };
  }
  if (/\/characters\/\d+\/mail\/?$/.test(path))          return mailHeaders(now);
  if (/\/characters\/\d+\/mail\/labels\/?$/.test(path))  {
    return { labels: [
      { label_id: 1, name: 'Inbox',    color: '#ffffff', unread_count: 1 },
      { label_id: 4, name: 'Alliance', color: '#6666ff', unread_count: 1 },
    ], total_unread_count: 2 };
  }
  if (/\/characters\/\d+\/mail\/lists\/?$/.test(path))   return [];
  // Public character sheet. Corp industry jobs resolve the corporation id from
  // here FIRST; with no fixture that lookup returned null and the widget bailed
  // out before it ever asked for jobs.
  const who = path.match(/\/characters\/(\d+)\/?$/);
  if (who) {
    const id = Number(who[1]);
    const names = { [MAIN]: 'Kaska Vaelin', [INDY]: 'Sirene Vaelin', [SCOUT]: 'Tovan Kesh' };
    return {
      name: names[id] || 'Demo Pilot',
      corporation_id: 1000167, alliance_id: null,
      birthday: iso(now, 3210 * DAY), gender: 'female',
      race_id: 1, bloodline_id: 1, security_status: 4.8,
    };
  }

  if (/\/characters\/\d+\/notifications\/?$/.test(path)) return notifications(now);
  if (/\/characters\/\d+\/calendar\/?$/.test(path))      return calendar(now);

  // Dashboard widgets. Each of these renders an explicit "nothing here" state
  // when empty, so an unfixtured route does not look like missing data — it
  // looks like the feature does not work.
  if (/\/characters\/\d+\/skillqueue\/?$/.test(path))    return skillQueue(now);
  if (/\/characters\/\d+\/industry\/jobs\/?$/.test(path)) return industryJobs(now);
  if (/\/corporations\/\d+\/industry\/jobs\/?$/.test(path)) return corpIndustryJobs(now);
  if (/\/characters\/\d+\/orders\/?$/.test(path))        return marketOrders(now);
  if (/\/characters\/\d+\/attributes\/?$/.test(path)) {
    return { charisma: 20, intelligence: 27, memory: 21, perception: 24, willpower: 24,
             bonus_remaps: 2, last_remap_date: iso(now, 200 * DAY) };
  }

  return undefined;   // not ours — fall through to the real network
}

// ── Market prices ────────────────────────────────────────────────────────────
//
// Fuzzwork's aggregates shape, keyed by type id. Prices are DERIVED from the id
// rather than random, so a re-record produces identical net-worth figures — the
// headline number on the dashboard must not change between takes.
//
// Well-known items are hand-set. Everything else lands in a plausible band by
// magnitude: minerals are single ISK, modules are millions, hulls are hundreds
// of millions. A flat price for everything would make the asset breakdown
// nonsense (a hold of Tritanium worth more than a Machariel).
const HAND_PRICED = {
  34: 4.85, 35: 18.2, 36: 54.6, 37: 194.0, 38: 705.0, 39: 1201.0, 40: 2646.0,   // minerals
  11399: 6_950_000,          // Morphite
  44992: 6_120_000,          // PLEX
  40520: 742_800_000,        // Large Skill Injector
  17738: 412_600_000,        // Machariel
  12015: 214_500_000,        // Muninn
  11978: 268_900_000,        // Scimitar
  22456: 58_400_000,         // Sabre
  32880: 1_240_000,          // Venture
  17478: 24_800_000,         // Retriever
};

// Every type the demo profile actually touches: the 20 distinct ids across the
// three characters' asset tables, plus the hulls, ores, blueprints and market
// items the other fixtures reference. Enumerated rather than swept over a range
// because /markets/prices/ is what the valuation trusts for coverage — a type
// missing here is a type that silently values at zero, and the net-worth figure
// is the headline number on the dashboard.
const DEMO_TYPE_IDS = [
  // minerals + ice products
  34, 35, 36, 37, 38, 39, 40, 16272, 16273, 16274, 17887, 17888, 17889,
  // ores
  22, 1223, 1225, 1230, 11396, 19,
  // moon ores (R4 → R64)
  45490, 45491, 45492, 45493, 45494, 45495, 45496, 45497,
  45498, 45499, 45500, 45501, 45502, 45503, 45504, 45506,
  45510, 45511, 45512, 45513,
  // assets held by the demo cast
  587, 621, 638, 691, 2389, 3689, 9832, 12005, 17738, 17739, 24698, 24699, 28606,
  // hulls used by fleet ops, killmails and market orders
  12015, 11978, 22456, 29990, 24688, 24702, 34828, 670, 32880, 17478, 17476, 626, 640,
  // blueprints referenced by industry jobs
  1178, 1179, 1180, 1181, 627, 628, 629,
  // market staples
  44992, 40520, 11399,
];

/** CCP /markets/prices/ — one row per type, adjusted and average. */
function marketPrices() {
  return DEMO_TYPE_IDS.map((type_id) => {
    const agg = fuzzworkAggregates([type_id])[String(type_id)];
    const sell = Number(agg.sell.percentile);
    return {
      type_id,
      // CCP's adjusted price runs a little under Jita sell, which is the
      // relationship the valuation's source-picking logic expects to see.
      adjusted_price: Math.round(sell * 0.97 * 100) / 100,
      average_price:  Math.round(sell * 0.99 * 100) / 100,
    };
  });
}

function fuzzworkAggregates(typeIds) {
  const out = {};
  for (const raw of typeIds) {
    const id = Number(raw);
    if (!Number.isFinite(id)) continue;
    let sell = HAND_PRICED[id];
    if (sell === undefined) {
      // Deterministic band from the id itself. Larger ids skew to larger items
      // only loosely, so the spread reads as a real market rather than a ramp.
      const h = (id * 2654435761) % 1000;
      sell = id < 1000 ? 20 + h / 10                 // ores and minerals
           : id < 20000 ? 1_000_000 + h * 41_000     // modules and small hulls
           : 12_000_000 + h * 380_000;               // everything heavier
    }
    const buy = sell * 0.92;
    const f = (n) => String(Math.round(n * 100) / 100);
    out[String(id)] = {
      buy:  { weightedAverage: f(buy),  max: f(buy),  min: f(buy * 0.85),
              stddev: '0', median: f(buy), volume: '412000', orderCount: '180', percentile: f(buy) },
      sell: { weightedAverage: f(sell), max: f(sell * 1.2), min: f(sell),
              stddev: '0', median: f(sell), volume: '388000', orderCount: '164', percentile: f(sell) },
    };
  }
  return out;
}

// ── Skill queue ──────────────────────────────────────────────────────────────
// Real skill type ids, ordered as a queue is: the one training now first. The
// finish dates step outward so the widget's countdown column has a spread rather
// than a wall of identical times.
const QUEUE = [
  [3327, 'Spaceship Command',       5, 0.4],   // finished_level, days out
  [3413, 'Weapon Upgrades',         5, 2.1],
  [3436, 'Advanced Weapon Upgrades',4, 6.8],
  [12209, 'Heavy Assault Cruisers', 4, 14.2],
  [22761, 'Capital Ships',          3, 31.5],
  [3402, 'Shield Management',       5, 48.0],
  [11207, 'Advanced Spaceship Command', 4, 79.3],
];

function skillQueue(now) {
  return QUEUE.map(([skill_id, , finished_level, days], i) => ({
    skill_id,
    finished_level,
    queue_position: i,
    // The head of the queue is already part-trained, which is what a live queue
    // looks like; a queue that starts at 0% reads as one nobody is training.
    level_start_sp: 45255,
    level_end_sp: 256000,
    training_start_sp: i === 0 ? 138400 : 45255,
    start_date:  iso(now, i === 0 ? 2 * DAY : -(QUEUE[i - 1] ? QUEUE[i - 1][3] : 0) * DAY),
    finish_date: iso(now, -days * DAY),
  }));
}

// ── Industry jobs ────────────────────────────────────────────────────────────
// A mix of running and nearly-done, across activities, so the progress bars are
// at different fills. All-100% or all-0% both look static in a screenshot.
function industryJobs(now) {
  const job = (job_id, installer_id, blueprint_type_id, product_type_id, activity_id,
               runs, startedAgo, endsIn, system) => ({
    job_id, installer_id, facility_id: 1035466617946, station_id: 1035466617946,
    activity_id, blueprint_id: 1_600_000_000 + job_id, blueprint_type_id,
    blueprint_location_id: 1035466617946, output_location_id: 1035466617946,
    product_type_id, runs, cost: 12_400_000, licensed_runs: runs, status: 'active',
    duration: Math.round((startedAgo + endsIn) / 1000),
    start_date: iso(now, startedAgo), end_date: iso(now, -endsIn),
    solar_system_id: system,
  });
  return [
    job(70001, MAIN,  1178, 626,   1, 20, 6 * HOUR,  2 * HOUR,  30004759),  // manufacturing
    job(70002, MAIN,  1178, 626,   1, 10, 20 * HOUR, 30 * MIN,  30004759),
    job(70003, INDY,  1179, 627,   3,  1, 2 * DAY,   9 * HOUR,  30004722),  // TE research
    job(70004, INDY,  1179, 627,   4,  1, 3 * DAY,   28 * HOUR, 30004722),  // ME research
    job(70005, SCOUT, 1180, 628,   5,  3, 12 * HOUR, 4 * HOUR,  30004759),  // copying
    job(70006, MAIN,  1181, 629,   8,  1, 30 * HOUR, 44 * HOUR, 30004759),  // invention
  ];
}

function corpIndustryJobs(now) {
  const rows = industryJobs(now).slice(0, 4);
  return rows.map((j, i) => ({ ...j, job_id: 71000 + i, installer_id: [MAIN, INDY, SCOUT][i % 3] }));
}

// ── Market orders ────────────────────────────────────────────────────────────
// Buys and sells both, because the widget splits them and one-sided data hides
// half the layout.
function marketOrders(now) {
  const o = (order_id, type_id, is_buy_order, price, volume_total, volume_remain, region_id, location_id, issuedAgo) => ({
    order_id, type_id, is_buy_order, price,
    volume_total, volume_remain, min_volume: 1,
    duration: 90, escrow: is_buy_order ? price * volume_remain : 0,
    issued: iso(now, issuedAgo), range: 'station',
    region_id, location_id,
  });
  return [
    o(80001, 44992, false, 6_120_000,   40,  12, 10000002, 60003760, 3 * HOUR),   // PLEX sell
    o(80002, 40520, false, 742_800_000,  4,   1, 10000002, 60003760, 9 * HOUR),   // Large Skill Injector
    o(80003, 34,    true,        4.85, 50_000_000, 18_400_000, 10000002, 60003760, 26 * HOUR), // Tritanium buy
    o(80004, 11399, true,   6_950_000,  120,  84, 10000060, 1035466617946, 2 * DAY),
    o(80005, 12015, false, 214_500_000,   3,   3, 10000060, 1035466617946, 4 * DAY),
  ];
}

// ── Jabber: director ping, Beehive status ────────────────────────────────────
//
// Neither of these is a network fetch — they come from the XMPP connection and
// its local database, so they are supplied at their IPC handlers rather than in
// match(). Without them the two widgets read "No director pings yet" and
// "UNKNOWN — waiting for Beehive MOTD", which looks like the app failing rather
// than like a quiet evening.
//
// The cast and the alliance are INVENTED. No real corp, alliance, comms link or
// iconography appears here: a demo video that shows a real organisation's
// broadcast is a different kind of problem from an ugly one.
function latestPing(now = Date.now()) {
  return {
    id: 990001,
    is_director: 1,
    who_pinged: 'vaelin_ops',
    sig: 'opsbot',
    fc_name: 'Kaska Vaelin',
    // `hurf` is the MESSAGE BODY, not the formup location — the renderer reads
    // `ping.hurf || ping.raw_body` for the message and `formup_location` for the
    // field. Getting that backwards puts a system name in the message pane.
    formup_location: '1DQ1-A',
    comms: 'Mumble — Op 3',
    doctrine: 'Muninn (Shield HAC) — Scimitar support, T2 light drones',
    pap_type: 'Strategic',
    target_sig: 'all',
    eve_timecode: new Date(now + 25 * MIN).toISOString().slice(11, 16),
    gsol_member: null,
    hurf:
      'STRAT OP — form up 1DQ1-A, undock in 25.\n\n'
      + 'Doctrine is Muninn with Scimitar support — bring T2 light drones and a '
      + 'mobile depot. Cap chain on comms channel 2.\n\n'
      + 'If you are not in a doctrine hull you are on standby. Titan is lit for the '
      + 'first wave only.',
    raw_body: 'STRAT OP — form up 1DQ1-A, undock in 25.',
    ping_timestamp: new Date(now - 6 * MIN).toISOString(),
    received_at:    new Date(now - 6 * MIN).toISOString(),
  };
}

function beehiveStatus(now = Date.now()) {
  return {
    // The traffic light only understands green/yellow/red/unknown — the words
    // parseBeehiveStatus() produces. 'go' is not one of them and falls through
    // to UNKNOWN, which is what the header showed while the MOTD text below it
    // clearly said the beacons were up.
    status: 'green',
    text:
      'BEEHIVE: GO\n'
      + 'Home defence beacons are UP. Rorquals cleared to undock in 1DQ1-A and 319-3D.\n'
      + 'Standing fleet is running — join "Vaelin Home Defence" before undocking.',
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
  return {
    running: true,
    systems: 212,
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
// reads label/ships/shipIds/pilots/etaSeconds — not name/ship/eta. Using the
// wrong ones renders a row with blank system and ship columns and a "GANG
// undefined" size chip, which is what the first attempt at this produced.
function intelContacts(now = Date.now()) {
  const c = (o) => Object.assign({ last: now - 90 * 1000, etaMeasured: true, inbound: true }, o);
  return [
    c({ kind: 'pilot', label: '319-3D', solarSystemId: 30004722, regionName: 'Delve',
        jumps: 2, js: 2, ships: ['Loki'], shipIds: [29990], pilots: ['Vex Tarrow'],
        count: 1, size: 1, band: 'solo', roles: ['cloaky'],
        security: -0.32, etaSeconds: 75, closing: true }),
    c({ kind: 'pilot', label: 'T5ZI-S', solarSystemId: 30004735, regionName: 'Delve',
        jumps: 3, js: 3, ships: ['Sabre', 'Jackdaw'], shipIds: [22456, 34828],
        pilots: ['Sorren Kade', 'Ilva Renn'], count: 2, size: 2, band: 'small', roles: [],
        security: -0.14, etaSeconds: 140, closing: true }),
    c({ kind: 'system', label: 'YZ9-F6', solarSystemId: 30004719, regionName: 'Delve',
        jumps: 4, js: 4, ships: ['Muninn', 'Scimitar'], shipIds: [12015, 11978],
        pilots: [], count: 14, size: 14, band: 'fleet', roles: ['capital', 'logi'],
        security: -0.18, etaSeconds: 220, closing: false }),
    c({ kind: 'system', label: 'K-6K16', solarSystemId: 30004751, regionName: 'Delve',
        jumps: 5, js: 5, ships: [], shipIds: [], pilots: [], count: 0, size: 0,
        band: null, roles: [], camp: false, clear: true,
        security: -0.43, etaSeconds: 300, closing: false, body: 'clear' }),
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
  const corp = 1000167;

  const mk = (killmail_id, ago, sys, victim, attackers, isk) => ({
    killmail_id,
    killmail_time: iso(now, ago),
    solar_system_id: sys,
    victim,
    attackers,
    zkb: { totalValue: isk, npc: false, solo: attackers.length === 1, hash: 'demo' + killmail_id },
  });
  const us    = (ship, character_id = id) => ({ character_id, corporation_id: corp, ship_type_id: ship, damage_taken: 4210 });
  const them  = (ship, character_id) => ({ character_id, corporation_id: 98000501, alliance_id: 99000501, ship_type_id: ship, damage_taken: 8800 });
  const themA = (ship, character_id, final_blow = false) => ({ character_id, corporation_id: 98000501, alliance_id: 99000501, ship_type_id: ship, final_blow });
  const ourA  = (ship, character_id = id, final_blow = false) => ({ character_id, corporation_id: corp, ship_type_id: ship, final_blow });

  return [
    // Recent kills — us on the attacking side
    mk(141_200_301, 34 * MIN, D.YZ9,  them(SHIP.rokh, 2119000301),
       [ourA(SHIP.muninn, id, true), ourA(SHIP.scimitar, INDY)], 284_610_000),
    mk(141_200_298, 52 * MIN, D.YZ9,  them(SHIP.hurricane, 2119000302),
       [ourA(SHIP.muninn, id, true)], 96_250_000),
    mk(141_200_244, 2 * HOUR + 10 * MIN, D.T5ZI, them(SHIP.jackdaw, 2119000303),
       [ourA(SHIP.muninn, id), ourA(SHIP.sabre, SCOUT, true)], 148_020_000),
    // A loss — we were the victim
    mk(141_200_190, 3 * HOUR, D.T5ZI, us(SHIP.sabre, SCOUT),
       [themA(SHIP.loki, 2119000310, true)], 71_880_000),
    mk(141_199_880, 9 * HOUR, D.T319, them(SHIP.capsule, 2119000303),
       [ourA(SHIP.sabre, SCOUT, true)], 10_000),
    mk(141_198_402, 28 * HOUR, D.DQ,  them(SHIP.machariel, 2119000320),
       [ourA(SHIP.muninn, id, true), ourA(SHIP.scimitar, INDY)], 1_842_400_000),
    mk(141_197_115, 2 * DAY, D.DQ,    us(SHIP.muninn, id),
       [themA(SHIP.rokh, 2119000330, true)], 231_500_000),
  ];
}

/**
 * zKill stats, including the rankings/rankHistory the app reads for rank trends.
 * The history snapshot is deliberately WORSE than current, so the arrows render
 * as climbing rather than flat — a flat demo shows the feature doing nothing.
 */
function zkillStats(kind, entityId, now = Date.now()) {
  // One ranking period. `metrics` drives the efficiency figure the app shows;
  // `ranks` drives the placing. Both are read straight back out by periodOf().
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
  match, mailHeaders, notifications, calendar, MAIL_BODIES,
  fuzzworkAggregates, marketPrices, DEMO_TYPE_IDS, skillQueue, industryJobs, corpIndustryJobs, marketOrders,
  latestPing, beehiveStatus, intelStatus, intelContacts,
  zkillFeed, zkillStats,
  MAIN, INDY, SCOUT,
};
