'use strict';
//
// The live killmail feed, and what it lets through.
//
// Two very different risks. The first is being a bad citizen of somebody else's
// free service: zKillboard publishes a 15 requests/second ceiling and bans for
// an hour on violation — the whole application, not just this feature. So the
// rate discipline is the feature, and most of the first half of this file exists
// to hold it. The second risk is the usual one: a feed carrying every kill in
// New Eden must not turn ratting accidents four regions away into alerts.
const test   = require('node:test');
const assert = require('node:assert');
const {
  createZkillStream, STEP_MS, IDLE_MS, STALL_ROUNDS, MAX_CATCHUP,
} = require('../src/intel/zkill_stream');
const { createKillWatch, normalisePackage } = require('../src/intel/kill_watch');

const tick = () => new Promise(r => setImmediate(r));
const advance = async (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) await tick();
};

const SEQ = /sequence\.json$/;
const idOf = (url) => Number((/\/(\d+)\.json$/.exec(url) || [])[1]);

/** A fake R2Z2: a sequence head, and killmail files for the ids that exist. */
function fakeServer({ head = 100, have = new Set(), onGet } = {}) {
  const urls = [];
  return {
    urls,
    get head() { return head; },
    set head(v) { head = v; },
    have,
    fetch: async (url) => {
      urls.push(url);
      if (onGet) onGet(url);
      if (SEQ.test(url)) return { body: { sequence: head } };
      const id = idOf(url);
      if (!have.has(id)) return { notFound: true };
      return { body: { killmail_id: 900000 + id, victim: {}, attackers: [], zkb: {} } };
    },
  };
}

// ── Rate discipline ───────────────────────────────────────────────────────────

test('it starts at the present rather than replaying history', async () => {
  // Walking a long backlog would be thousands of requests at the moment we are
  // least sure of our rate budget, and every kill in it is already too old to
  // say anything about who is near now.
  const srv = fakeServer({ head: 96_088_891 });
  const s = createZkillStream({ httpGet: srv.fetch });
  await s._cycle();
  assert.strictEqual(s.status().cursor, 96_088_891);
  assert.strictEqual(srv.urls.length, 1, 'one request to find the front');
  s.stop();
});

test('sequential fetches are spaced, and going quiet waits much longer', async () => {
  const srv = fakeServer({ head: 10, have: new Set([11]) });
  const s = createZkillStream({ httpGet: srv.fetch, onKillmail: () => {} });

  await s._cycle();                                  // cursor -> 10
  assert.strictEqual(await s._cycle(), STEP_MS, 'a hit steps on promptly');
  assert.strictEqual(await s._cycle(), IDLE_MS, 'caught up: back off hard');
  // zKillboard publishes NO numeric rate limit — the "15/s ceiling" this test
  // used to cite is not in their API wiki or information page (checked
  // 2026-08-17). Against a free volunteer-run service the floor is set by what
  // is defensible, not by a number we cannot source: 400ms = 2.5/s, which still
  // clears New Eden's baseline kill rate. Mirrored in request_broker.js's rate
  // table for r2z2.zkillboard.com.
  assert.ok(STEP_MS >= 400, 'no faster than 2.5 req/s against a free service');
  assert.ok(IDLE_MS >= 6000, "zKillboard's own guidance on seeing a 404");
  s.stop();
});

test('only one request is ever in flight', async () => {
  let open = 0, maxOpen = 0;
  const s = createZkillStream({
    httpGet: async (url) => {
      open++; maxOpen = Math.max(maxOpen, open);
      await tick(); await tick();
      open--;
      return SEQ.test(url) ? { body: { sequence: 5 } } : { notFound: true };
    },
  });
  await Promise.all([s._cycle(), s._cycle(), s._cycle()]);
  assert.strictEqual(maxOpen, 1);
  s.stop();
});

test('errors back off instead of retrying in a tight loop', async () => {
  let calls = 0;
  const s = createZkillStream({ httpGet: async () => { calls++; throw new Error('503'); } });
  s.start();
  await advance(200);
  s.stop();
  assert.strictEqual(calls, 1, 'the first failure waits seconds, not milliseconds');
  assert.strictEqual(s.status().connected, false);
});

test('a rate-limit response backs off rather than retrying immediately', async () => {
  // Their stated penalty is a one-hour ban. Retrying into it would extend it.
  const s = createZkillStream({
    httpGet: async () => { throw Object.assign(new Error('HTTP 403'), { status: 403 }); },
  });
  const delay = await s._cycle();
  assert.ok(delay >= 10_000, `backed off only ${delay}ms`);
  s.stop();
});

test('stop actually stops, including mid-request', async () => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const s = createZkillStream({
    httpGet: async () => { calls++; await gate; return { body: { sequence: 1 } }; },
  });
  s.start();
  await tick();
  s.stop();
  release();
  await advance(80);
  assert.strictEqual(calls, 1, 'no further requests after stop');
  assert.strictEqual(s._running, false);
});

test('stopping forgets the cursor, so restarting resumes at the present', () => {
  const s = createZkillStream({ httpGet: async () => ({ body: { sequence: 7 } }) });
  return s._cycle().then(() => {
    assert.strictEqual(s.status().cursor, 7);
    s.stop();
    assert.strictEqual(s.status().cursor, null, 'not a stale cursor to catch up from');
  });
});

// ── Not getting stuck ─────────────────────────────────────────────────────────

test('a hole in the sequence is stepped over rather than waited on forever', async () => {
  // A missing id and an unpublished one both answer 404. Waiting on the first
  // would freeze the feed permanently, with the status still reading healthy.
  const srv = fakeServer({ head: 10, have: new Set([12]) });   // 11 never exists
  const s = createZkillStream({ httpGet: srv.fetch, onKillmail: () => {} });

  await s._cycle();                                   // cursor -> 10
  srv.head = 12;                                      // the front has moved on
  for (let i = 0; i < STALL_ROUNDS; i++) await s._cycle();

  assert.strictEqual(s.status().cursor, 11, 'stepped past the hole');
  assert.strictEqual(s.status().skipped, 1);
  await s._cycle();
  assert.strictEqual(s.status().cursor, 12, 'and carried on');
  s.stop();
});

test('a quiet feed does not keep asking where the front is', async () => {
  // The stall check costs an extra request; doing it every idle round would
  // double our request rate during exactly the quiet periods that need none.
  const srv = fakeServer({ head: 10 });
  const s = createZkillStream({ httpGet: srv.fetch });
  await s._cycle();
  const after = srv.urls.length;
  await s._cycle();
  assert.strictEqual(srv.urls.length, after + 1, 'one 404 probe, no sequence check');
  s.stop();
});

test('falling a long way behind jumps to the present instead of walking', async () => {
  // Everything in a gap that size is past the relevance window, so walking it
  // would spend hundreds of requests to arrive exactly where a jump lands.
  const srv = fakeServer({ head: 100 });
  const s = createZkillStream({ httpGet: srv.fetch });
  await s._cycle();                       // cursor -> 100
  srv.head = 100 + MAX_CATCHUP + 500;
  for (let i = 0; i < STALL_ROUNDS; i++) await s._cycle();
  assert.strictEqual(s.status().cursor, srv.head, 'skipped straight to the front');
  s.stop();
});

test('a consumer that throws does not kill the feed', async () => {
  const srv = fakeServer({ head: 1, have: new Set([2]) });
  const s = createZkillStream({
    httpGet: srv.fetch,
    onKillmail: () => { throw new Error('downstream is broken'); },
  });
  await s._cycle();
  await s._cycle();
  assert.strictEqual(s.status().received, 1, 'still counted as delivered');
  assert.strictEqual(s.status().cursor, 2, 'and the cursor still advanced');
  s.stop();
});

test('a 404 is a healthy answer, not an error', async () => {
  const srv = fakeServer({ head: 3 });
  const s = createZkillStream({ httpGet: srv.fetch });
  await s._cycle();
  await s._cycle();
  assert.strictEqual(s.status().errors, 0);
  assert.strictEqual(s.status().connected, true);
  s.stop();
});

// ── Reading whatever envelope zKillboard sends ────────────────────────────────

test('the real R2Z2 envelope is read — the ESI body lives under `esi`', () => {
  // Captured from the live feed. An earlier version looked only for `killmail`
  // and would have discarded every kill in silence while the stream reported
  // itself perfectly healthy, which is exactly the bug this test exists for.
  const real = {
    killmail_id: 137472555,
    hash: 'abc123',
    esi: {
      killmail_id: 137472555,
      killmail_time: '2026-08-04T12:00:00Z',
      solar_system_id: 30000142,
      victim: { character_id: 999, ship_type_id: 17740, damage_taken: 4000 },
      attackers: [{ alliance_id: 99012403, character_id: 2123178164,
                    corporation_id: 98769631, ship_type_id: 28659, final_blow: true }],
    },
    zkb: { totalValue: 1e8, npc: false, solo: false, attackerCount: 1 },
    uploaded_at: 1785000000,
    sequence_id: 98858379,
  };
  const n = normalisePackage(real);
  assert.strictEqual(n.killmail.killmail_id, 137472555);
  assert.strictEqual(n.killmail.solar_system_id, 30000142);
  assert.strictEqual(n.killmail.attackers.length, 1);
  assert.strictEqual(n.zkb.attackerCount, 1);
});

test('the retired RedisQ envelope still parses', () => {
  // Kept because the envelope has changed once already, and the cost of
  // tolerating the old shape is one array entry.
  const km = { killmail_id: 5, killmail_time: '2026-08-04T12:00:00Z',
               solar_system_id: 30000142, victim: {}, attackers: [] };

  const redisq = normalisePackage({ package: { killmail: km, zkb: { npc: true } } });
  assert.strictEqual(redisq.killmail.killmail_id, 5);
  assert.strictEqual(redisq.zkb.npc, true);

  const flat = normalisePackage({ ...km, zkb: { solo: true } });
  assert.strictEqual(flat.killmail.killmail_id, 5);

  // The id can live on the wrapper rather than the body.
  const wrapperId = normalisePackage({ killmail_id: 5, esi: { ...km, killmail_id: undefined }, zkb: {} });
  assert.strictEqual(wrapperId.killmail.killmail_id, 5);
});

test('anything that is not a killmail is rejected outright', () => {
  for (const bad of [null, undefined, 'nope', {}, { package: {} },
                     { victim: {} },                        // no attackers
                     { attackers: [] },                     // no victim
                     { sequence: 12345 }]) {
    assert.strictEqual(normalisePackage(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── What the firehose is allowed through ──────────────────────────────────────

const SHIPS = {
  22456: { name: 'Sabre',     role: 'tackle' },
  17738: { name: 'Machariel', role: null },
  17740: { name: 'Hulk',      role: null },
};

const watch = (over = {}) => {
  const reports = [];
  const kw = createKillWatch({
    onKillReport: (r) => reports.push(r),
    isRelevant: () => true,
    shipFor: (id) => SHIPS[id] || null,
    ...over,
  });
  return { kw, reports };
};

const pkg = (over = {}, zkb = {}) => ({
  killmail_id: 1,
  killmail_time: new Date().toISOString(),
  solar_system_id: 30000142,
  victim: { character_id: 999, ship_type_id: 17740 },
  attackers: [
    { character_id: 11, corporation_id: 500, alliance_id: 900, ship_type_id: 22456 },
    { character_id: 12, corporation_id: 500, alliance_id: 900, ship_type_id: 17738 },
  ],
  zkb: { totalValue: 250_000_000, ...zkb },
  ...over,
});

test('a kill near us becomes a hostile report built from the ATTACKERS', () => {
  // Whoever died, the gang is who did the killing — that is the threat, its
  // size, and what it was flying.
  const { kw, reports } = watch();
  const r = kw.ingestPackage(pkg());
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(r.systemId, 30000142);
  assert.strictEqual(r.count, 2, 'two attackers, not two-plus-the-victim');
  assert.deepStrictEqual(r.ships, ['Sabre', 'Machariel']);
  assert.deepStrictEqual(r.roles, ['tackle']);
  assert.strictEqual(r.status, 'hostile');
  assert.strictEqual(r.source, 'killmail');
  assert.deepStrictEqual(r.pilots, [], 'zKill sends ids, not names');
});

test('attacker corp and alliance ids ride along for standings', () => {
  // Better than chat ever gets: these are already the key the contact sheet
  // uses, so a red alliance resolves on the FIRST sighting instead of the second.
  const { kw } = watch();
  assert.deepStrictEqual(kw.ingestPackage(pkg()).entityIds.sort(), [500, 900]);
});

test('rats killing a ratter is not an intel event', () => {
  // Left in, this would be most of the feed, and would paint every quiet
  // ratting system in range as a warzone.
  const { kw, reports } = watch();
  assert.strictEqual(kw.ingestPackage(pkg({}, { npc: true })), null);
  assert.strictEqual(reports.length, 0);
});

test('a kill with no player attackers is dropped', () => {
  const { kw } = watch();
  assert.strictEqual(kw.ingestPackage(pkg({ attackers: [{ ship_type_id: 22456 }] })), null);
});

test('NPCs padding the attacker list do not inflate the gang size', () => {
  const { kw } = watch();
  const r = kw.ingestPackage(pkg({
    attackers: [
      { character_id: 11, ship_type_id: 22456 },
      { ship_type_id: 17738 },                    // a rat that joined in
      { ship_type_id: 17738 },
    ],
  }));
  assert.strictEqual(r.count, 1);
});

test('the whole galaxy is filtered down to what is near us', () => {
  // At peak the feed is thousands of kills an hour and essentially none are ours.
  const { kw, reports } = watch({ isRelevant: (id) => id === 30000142 });
  assert.ok(kw.ingestPackage(pkg()));
  assert.strictEqual(kw.ingestPackage(pkg({ killmail_id: 2, solar_system_id: 30002187 })), null);
  assert.strictEqual(reports.length, 1);
});

test('a stale kill says nothing about who is nearby now', () => {
  const { kw } = watch();
  const old = pkg({ killmail_id: 3, killmail_time: new Date(Date.now() - 3600_000).toISOString() });
  assert.strictEqual(kw.ingestPackage(old), null);
});

test('the same killmail is never reported twice, from either source', () => {
  // The live feed delivers within seconds; the per-character poll re-delivers
  // the same kill up to ten minutes later. One dedupe set across both is what
  // stops the slow path re-warning about what the fast path already reported.
  const { kw, reports } = watch();
  assert.ok(kw.ingestPackage(pkg()));
  assert.strictEqual(kw.ingestPackage(pkg()), null);
  assert.strictEqual(reports.length, 1);
});

test('our own loss is marked, and still built from the attackers', () => {
  const { kw } = watch();
  kw.setMonitored([{ characterId: 999, name: 'Miner Joe' }]);
  const r = kw.ingestPackage(pkg());
  assert.strictEqual(r.ourLoss, true);
  assert.match(r.body, /WE lost/);
  assert.match(r.body, /Hulk/, 'says what we lost');
  assert.strictEqual(r.count, 2, 'the gang is still the attackers');
});

test('malformed packages are dropped rather than thrown on', () => {
  const { kw } = watch();
  for (const bad of [null, {}, { killmail: {} }, { killmail_id: 9 },
                     pkg({ killmail_time: 'not a date' }),
                     pkg({ solar_system_id: undefined })]) {
    assert.strictEqual(kw.ingestPackage(bad), null);
  }
});

test('an unrecognised hull is skipped without losing the report', () => {
  // The SDE moves; a hull we cannot name must not cost us the sighting.
  const { kw } = watch();
  const r = kw.ingestPackage(pkg({
    attackers: [{ character_id: 11, ship_type_id: 999999 },
                { character_id: 12, ship_type_id: 22456 }],
  }));
  assert.strictEqual(r.count, 2, 'both attackers still count');
  assert.deepStrictEqual(r.ships, ['Sabre']);
});

// ── Through the real service ──────────────────────────────────────────────────

const SDE = {
  async all(sql) {
    if (/mapSolarSystemJumps/.test(sql)) return [{ from: 1, to: 2 }, { from: 2, to: 3 }];
    if (/invTypes/.test(sql)) {
      return [{ id: 22456, n: 'Sabre', grp: 'Interdictor' },
              { id: 17738, n: 'Machariel', grp: 'Battleship' }];
    }
    return [
      { id: 1, name: 'EKPB-3', regionId: 10, regionName: 'Insmother' },
      { id: 2, name: '5M2-KP', regionId: 10, regionName: 'Insmother' },
      { id: 3, name: 'TK-DLH', regionId: 10, regionName: 'Insmother' },
      { id: 9, name: 'UALX-3', regionId: 11, regionName: 'Tenerifis' },   // no gate
    ];
  },
};

const livePkg = (systemId) => pkg({
  killmail_id: 77, solar_system_id: systemId,
  victim: { character_id: 999, ship_type_id: 17738 },
  attackers: [{ character_id: 11, corporation_id: 500, alliance_id: 900, ship_type_id: 22456 }],
});

const svcWith = async (over = {}) => {
  const { createIntelService } = require('../src/intel/intel_service');
  const svc = createIntelService({
    getSdeDb: () => SDE,
    // Never let a unit test reach zKillboard.
    zkillFetch: async () => ({ notFound: true }),
    ...over,
  });
  await svc.init();
  return svc;
};

test('a live killmail becomes an alert, with the system named and hull known', async () => {
  const alerts = [], reports = [];
  const svc = await svcWith({ onAlert: (a) => alerts.push(a), onReport: (r) => reports.push(r) });
  svc.setOrigin(1);
  svc._killWatch.ingestPackage(livePkg(2));

  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].systemName, '5M2-KP', 'zKill sends an id; the SDE names it');
  assert.deepStrictEqual(reports[0].ships, ['Sabre']);
  assert.ok(alerts.length, 'one jump out with tackle is an alert');
  assert.strictEqual(alerts[0].tackle, true);
  svc.stop();
});

test('a kill outside every horizon never reaches the pipeline', async () => {
  const reports = [];
  const svc = await svcWith({ onReport: (r) => reports.push(r) });
  svc.setOrigin(1);
  assert.strictEqual(svc._killWatch.ingestPackage(livePkg(9)), null, 'UALX-3 has no gate to us');
  assert.strictEqual(reports.length, 0);
  svc.stop();
});

test("an attacker's alliance standing resolves immediately, with no name lookup", async () => {
  // The advantage killmails have over chat: the contact sheet is keyed by id,
  // and a killmail already carries the ids.
  const reports = [];
  const svc = await svcWith({
    httpPost: async () => { throw new Error('names must not be resolved for this'); },
    getContactSheet: () => ({ 900: -10 }),
    onReport: (r) => reports.push(r),
  });
  svc.setOrigin(1);
  svc._killWatch.ingestPackage(livePkg(2));
  assert.strictEqual(reports[0].standing, -10, 'red on the first sighting, not the second');
  svc.stop();
});

test('the live feed only runs when it is switched on AND has somewhere to measure from', async () => {
  const svc = await svcWith();
  svc.setOptions({ liveKills: true });
  assert.strictEqual(svc.status().liveKills.running, false, 'no monitored position yet');

  svc.setOrigin(1);
  assert.strictEqual(svc.status().liveKills.running, true);

  svc.setOptions({ liveKills: false });
  assert.strictEqual(svc.status().liveKills.running, false);
  svc.stop();
});

test('the live feed is off unless asked for', async () => {
  const svc = await svcWith();
  svc.setOrigin(1);
  assert.strictEqual(svc.status().liveKills.running, false,
    'a continuous connection to a third-party service is not a default');
  svc.stop();
});
