'use strict';
//
// The demo profile's world (src/demo/*): internally consistent, believable, and
// — the part that matters most — free of anything real.
//
// Demo mode exists to be recorded and published. A snapshot that kept one real
// alliance id, a scout name, or a broadcast mentioning a real comms server would
// put that on screen in every video made from it; these tests are the tripwire.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const cast     = require('../src/demo/cast');
const Skills   = require('../src/demo/skills');
const W        = require('../src/demo/world');
const U        = require('../src/demo/universe');
const Pings    = require('../src/demo/pings');
const Cal      = require('../src/demo/calendar');
const Forum    = require('../src/demo/forum');
const Text     = require('../src/demo/text');
const fx       = require('../src/demo_fixtures');
const { parseJabberMessage } = require('../src/jabber_data_db');
const Ics      = require('../src/func/ics-parse');

const NOW  = Date.parse('2026-10-29T12:00:00Z');
const SNAP = path.join(__dirname, '..', 'src', 'demo', 'snapshots');
const snap = (n) => JSON.parse(fs.readFileSync(path.join(SNAP, n), 'utf8'));
const DAY  = 86_400_000;

// ── Nothing real ──────────────────────────────────────────────────────────────

test('sovereignty holders are all invented alliances and corporations', () => {
  const sov = snap('sovereignty.json');
  const held = sov.systems.filter(r => r[1] === 'a');
  assert.ok(held.length > 2000, 'the map keeps its real shape');
  for (const r of held) {
    assert.ok(r[2] >= cast.ALLIANCE_BASE, `system ${r[0]} keeps a real alliance id ${r[2]}`);
    assert.ok(r[3] >= cast.CORP_BASE, `system ${r[0]} keeps a real corporation id ${r[3]}`);
    assert.ok(cast.allianceInfo(r[2]), `alliance ${r[2]} has no invented name`);
  }
  for (const c of snap('sov-campaigns.json')) {
    assert.ok(!c.defender_id || c.defender_id >= cast.ALLIANCE_BASE, `campaign ${c.campaign_id} defender is real`);
    for (const p of c.participants || []) assert.ok(p.alliance_id >= cast.ALLIANCE_BASE, 'a real campaign participant');
  }
});

test('leaderboards and scout reports name nobody real', () => {
  const pool = new Set(cast.PILOTS.map(p => p.id));
  const names = new Set(cast.PILOTS.map(p => p.name));
  const chars = snap('fw-leaderboards-characters.json');
  for (const section of Object.values(chars)) for (const rows of Object.values(section)) {
    for (const r of rows) assert.ok(pool.has(r.character_id), `leaderboard pilot ${r.character_id} is not an NPC agent`);
  }
  const corps = snap('fw-leaderboards-corporations.json');
  for (const section of Object.values(corps)) for (const rows of Object.values(section)) {
    for (const r of rows) assert.ok(r.corporation_id >= cast.CORP_BASE, `leaderboard corp ${r.corporation_id} is real`);
  }
  for (const s of snap('eve-scout.json')) {
    for (const [k, v] of Object.entries(s)) {
      if (/_by_name$/.test(k)) assert.ok(names.has(v), `eve-scout ${k} "${v}" is not from the NPC pool`);
      if (/_by_id$/.test(k)) assert.ok(pool.has(v), `eve-scout ${k} ${v} is not from the NPC pool`);
    }
  }
});

test('every pilot id the demo hands out is a CCP NPC agent', () => {
  // The first demo cast used ids that belonged to real players, so their
  // portraits — and on killmails, their names — appeared under demo labels.
  for (const c of Object.values(cast.CAST)) {
    assert.ok(c.id >= 3_000_000 && c.id < 4_000_000, `${c.name} (${c.id}) is not in the NPC agent range`);
  }
  for (const p of cast.PILOTS) assert.ok(p.id >= 3_000_000 && p.id < 4_000_000);
});

test('no broadcast, room, pack, forum page or feed mentions a real organisation', () => {
  // Markers of real alliances and their infrastructure. Lower-cased substring match.
  const DENY = ['goonfleet', 'goonswarm', 'goonie', 'gnf.lt', 'imperium', 'gsol', 'gice', 'guardbees',
                'skirmishbot', 'directorbot', 'beehive', 'locust', 'twitch.tv', 'discord'];
  const corpus = [
    ...Pings.broadcasts(NOW).map(m => m.body + ' ' + m.from),
    ...Pings.roomMessages(NOW).map(m => m.body + ' ' + m.from),
    ...Pings.ROOMS.map(r => r.jid + ' ' + r.name + ' ' + r.subject),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'demo', 'vaelin_pack.yaml'), 'utf8'),
    Forum.respond(Forum.BASE + '/', NOW).body,
    Forum.respond(Forum.BASE + '/topic/2118-intel-channel-rules/', NOW).body,
    Cal.feed(Cal.FORUM_FEED, NOW), Cal.feed(Cal.CORP_FEED, NOW), Text.GEZ_CSV,
  ].join('\n').toLowerCase();
  for (const word of DENY) assert.ok(!corpus.includes(word), `the demo mentions "${word}"`);
  // Every link the demo shows points at a reserved .example host (RFC 2606) —
  // except the image server, which only ever draws NPC portraits and type icons.
  for (const url of corpus.match(/https?:\/\/[^\s"'<>)]+/g) || []) {
    const host = new URL(url).hostname;
    assert.ok(host.endsWith('.example') || host === 'images.evetech.net', `a real link: ${url}`);
  }
});

// ── Consistent with itself ────────────────────────────────────────────────────

test('skill sheets cost exactly what their levels are worth, and the queue continues them', () => {
  const ranks = new Map(snap('skills.json').map(r => [r[0], r[1]]));
  for (const key of Object.keys(cast.CAST)) {
    const sheet = Skills.sheet(key);
    const queue = Skills.skillQueue(key, NOW);
    assert.ok(sheet.skills.length > 150, `${key} has a real-sized sheet`);
    assert.ok(queue.length >= 5, `${key} is training`);
    const queued = new Map(queue.map(q => [q.skill_id, q]));
    for (const q of queue) {
      assert.ok(q.finished_level >= 1 && q.finished_level <= 5, `${key} queues ${q.skill_id} to level ${q.finished_level}`);
      assert.strictEqual(q.level_end_sp, Skills.spAt(ranks.get(q.skill_id), q.finished_level), 'the level ends where its SP says');
    }
    for (const s of sheet.skills) {
      const q = queued.get(s.skill_id);
      const rank = ranks.get(s.skill_id);
      assert.ok(s.trained_skill_level >= 0 && s.trained_skill_level <= 5, `${key} skill ${s.skill_id} at level ${s.trained_skill_level}`);
      assert.ok(s.skillpoints_in_skill <= Skills.spAt(rank, 5), `${key} skill ${s.skill_id} holds more SP than level V`);
      if (!q) {
        assert.strictEqual(s.skillpoints_in_skill, Skills.spAt(rank, s.trained_skill_level),
          `${key} skill ${s.skill_id} holds SP that do not match its level`);
      } else {
        assert.strictEqual(s.trained_skill_level, q.finished_level - 1, 'a queued skill trains to the NEXT level');
      }
    }
    // Head part-trained, the rest back to back, finish dates ascending.
    assert.ok(queue[0].training_start_sp > queue[0].level_start_sp, 'the head of the queue is part-trained');
    assert.ok(Date.parse(queue[0].start_date) < NOW && Date.parse(queue[0].finish_date) > NOW, 'and training now');
    for (let i = 1; i < queue.length; i++) {
      assert.ok(Date.parse(queue[i].finish_date) > Date.parse(queue[i - 1].finish_date), 'finish dates step outward');
    }
    assert.strictEqual(fx.match(require('../src/shared/esi').url(`/characters/${cast.CAST[key].id}/skillqueue/`), { now: NOW }).length, queue.length,
      'the fixture serves the same queue');
  }
});

test('colonies are real planets of the right type, with art and full pin layouts', () => {
  const art = fs.readdirSync(path.join(__dirname, '..', 'assets', 'planets')).map(f => f.replace(/\.jpg$/, ''));
  for (const c of W.colonyRows('indy', NOW)) {
    // ESI's lower-case word: the PI page keys its planet art on it. The first
    // demo stored "Planet (Barren)", which matched no art.
    assert.ok(art.includes(c.planet_type), `${c.planet_type} has no planet art`);
    const pins = JSON.parse(c.pins_json);
    assert.ok(pins.length >= 8, 'a working colony, not an empty command centre');
    assert.ok(pins.some(p => p.extractor_details), 'it extracts');
    for (const s of JSON.parse(c.storage_json)) assert.ok(s.fill_pct >= 0 && s.fill_pct <= 100);
  }
});

test('the calendar fills the month without piling onto a few days', () => {
  const d = new Date(NOW);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end   = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const perDay = {};
  for (const url of [Cal.FORUM_FEED, Cal.CORP_FEED]) {
    for (const ev of Ics.parseIcs(Cal.feed(url, NOW))) {
      for (const o of Ics.expandRecurring(ev, start, end)) perDay[o.start.getUTCDate()] = (perDay[o.start.getUTCDate()] || 0) + 1;
    }
  }
  const days = Object.keys(perDay).length;
  assert.ok(days >= 18, `only ${days} days of the month have events`);
  assert.ok(Math.max(...Object.values(perDay)) <= 4, 'no day is a wall of events');
  // And next month, and the one after: the recurring ops have no end date.
  const later = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 1));
  const n = Ics.parseIcs(Cal.feed(Cal.FORUM_FEED, NOW)).flatMap(ev => Ics.expandRecurring(ev, later, new Date(later.getTime() + 28 * DAY))).length;
  assert.ok(n >= 8, 'two months out still has a calendar');
});

test('broadcasts parse into the same columns real ones do', () => {
  const all = Pings.broadcasts(NOW);
  assert.ok(all.length >= 25, 'a feed, not a handful');
  const parsed = all.map(m => parseJabberMessage(m.body));
  assert.ok(parsed.every(p => p.sig && p.target_sig && p.eve_timecode), 'every closing line parses');
  const ops = parsed.filter(p => p.fc_name);
  assert.ok(ops.length >= 12, 'most are fleet pings with the full field block');
  for (const p of ops) assert.ok(p.formup_location && p.comms && p.doctrine, 'a fleet ping carries its fields');
  // Newest last in insert order, and minutes old — the Latest Ping widget leads with it.
  assert.ok(NOW - Date.parse(all[all.length - 1].receivedAt) < 15 * 60_000);
});

test('the forum answers its own host only, and every page renders', () => {
  for (const p of ['/', '/forum/4-doctrines-fits/', '/topic/2118-intel-channel-rules/', '/calendar/']) {
    const r = Forum.respond(Forum.BASE + p, NOW);
    assert.strictEqual(r.status, 200, p);
    assert.match(r.body, /Vaelin Collective/);
  }
  assert.strictEqual(Forum.respond(Forum.BASE + '/no-such-page', NOW).status, 404);
  assert.strictEqual(Forum.respond('https://images.evetech.net/types/34/icon', NOW), null, 'other hosts pass through');
  const ics = Forum.respond(Cal.FORUM_FEED, NOW);
  assert.match(ics.type, /text\/calendar/);
});

test('names resolve from the cast without a network, static ids from the SDE only', async () => {
  const out = await fx.matchAsync(require('../src/shared/esi').url('/universe/names/'),
    { method: 'POST', body: [cast.CAST.main.id, cast.PILOTS[0].id, cast.VAELIN.id, 1000182, 30000142] });
  const byId = Object.fromEntries(out.map(r => [r.id, r]));
  assert.strictEqual(byId[cast.CAST.main.id].name, 'Kaska Vaelin');
  assert.strictEqual(byId[cast.VAELIN.id].category, 'alliance');
  assert.strictEqual(byId[1000182].name, 'Tribal Liberation Force');
  assert.strictEqual(byId[30000142], undefined, 'a system id needs the SDE — never a guess, never the network');
});

test('public data is served in ESI\'s own shapes, with live-looking times', () => {
  const sys = U.industrySystems();
  assert.ok(sys.length > 5000 && sys[0].cost_indices.length === 6, 'cost indices for the whole cluster');
  const sov = U.sovereigntySystems(NOW).solar_systems;
  const hub = sov.find(s => s.claim && s.claim.alliance && s.claim.alliance.sovereignty_hub);
  const start = Date.parse(hub.claim.alliance.sovereignty_hub.vulnerability_window.start);
  assert.ok(start > NOW - 3 * 3600_000 && start < NOW + DAY, 'vulnerability windows fall in the next day');
  for (const c of U.sovCampaigns(NOW)) {
    const t = Date.parse(c.start_time);
    assert.ok(t > NOW - 2 * 3600_000 && t < NOW + 2 * DAY, 'sov timers are upcoming, not stale');
  }
  assert.ok(U.fwSystems().length > 100 && U.fwStats().length === 6, 'both warzones');
  assert.ok(U.regionHistory(34, NOW).length === 365, 'a year of market history for any type');
  assert.ok(U.regionOrders(44992, 'all', NOW).some(o => o.is_buy_order) && U.regionOrders(44992, 'all', NOW).some(o => !o.is_buy_order));
});
