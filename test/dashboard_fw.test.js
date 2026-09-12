'use strict';
//
// The Faction Warfare dashboard tiles.
//
// Everything here is a pure function over an ESI payload, which is the point:
// the three widgets and the FW page read the SAME selectors, so they cannot end
// up disagreeing about who is winning a warzone. The shapes below are taken from
// live /fw/stats, /fw/systems and /fw/leaderboards responses (2026-09-01), and
// the tug-of-war case at the bottom is that day's real Caldari–Gallente numbers
// reconciled by hand — a second source, not a restatement of the code.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

// Both files load as classic <script>s into ONE global scope in the app, so they
// are loaded into one vm context here too. Top-level `function` declarations
// attach to the context; top-level `const`/`let` do not, hence the explicit
// hand-off of the tables at the end.
function load() {
  const noop = () => {};
  const store = {};
  const sb = {
    console, Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number,
    Boolean, RegExp, Error, isNaN, parseFloat, parseInt,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { eveAPI: {}, addEventListener: noop },
    escHtml: (s) => String(s),
    formatNumber: (n) => String(n),
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  for (const f of ['faction-warfare.js', 'dashboard-fw.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'func', f), 'utf8'), ctx, { filename: f });
  }
  vm.runInContext(';globalThis.__x = { FW_WARZONES, FW_FACTIONS, FW_LP_MULT };', ctx);
  return sb;
}

const WZ_CAL_GAL = { key: 'cal-gal', factions: [500001, 500004] };

// Shorthand for a /fw/stats row.
const stat = (faction_id, systems_controlled, vpYesterday, extra = {}) => ({
  faction_id, systems_controlled, pilots: 1000,
  kills: { yesterday: 10, total: 100 },
  victory_points: { yesterday: vpYesterday, total: 100000 },
  ...extra,
});

// ── fwTopEntries ─────────────────────────────────────────────────────────────

test('a leaderboard comes back ranked, five deep', () => {
  const S = load();
  const lb = { kills: { active_total: [
    { character_id: 1, amount: 900 }, { character_id: 2, amount: 800 },
    { character_id: 3, amount: 700 }, { character_id: 4, amount: 600 },
    { character_id: 5, amount: 500 }, { character_id: 6, amount: 400 },
  ] } };
  const rows = S.fwTopEntries(lb, 'kills', 'active_total', 5);
  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(rows.map(r => r.rank), [1, 2, 3, 4, 5]);
  assert.strictEqual(rows[0].id, 1);
  assert.strictEqual(rows[0].amount, 900);
});

test('ordering is not taken on trust', () => {
  // ESI does return these sorted. Ordering is also the one thing a leaderboard
  // cannot get wrong, and re-sorting costs nothing, so it is not assumed.
  const S = load();
  const lb = { kills: { yesterday: [
    { character_id: 1, amount: 30 }, { character_id: 2, amount: 144 }, { character_id: 3, amount: 90 },
  ] } };
  const rows = S.fwTopEntries(lb, 'kills', 'yesterday', 5);
  assert.deepStrictEqual(rows.map(r => r.id), [2, 3, 1]);
  assert.strictEqual(rows[0].rank, 1, 'rank follows the sort, it is not the payload index');
});

test('the corporation board uses the same shape', () => {
  const S = load();
  const lb = { victory_points: { yesterday: [{ corporation_id: 98000001, amount: 12 }] } };
  assert.strictEqual(S.fwTopEntries(lb, 'victory_points', 'yesterday', 5)[0].id, 98000001);
});

test('a missing board is empty, not a crash', () => {
  // Lengths, not deepStrictEqual: an array literal built inside the vm realm has
  // a different Array.prototype, so [] never equals [] across the boundary.
  const S = load();
  assert.strictEqual(S.fwTopEntries(null, 'kills', 'yesterday', 5).length, 0);
  assert.strictEqual(S.fwTopEntries({}, 'kills', 'yesterday', 5).length, 0);
  assert.strictEqual(S.fwTopEntries({ kills: {} }, 'kills', 'last_week', 5).length, 0);
  assert.strictEqual(S.fwTopEntries({ kills: { yesterday: [{ amount: 5 }] } }, 'kills', 'yesterday', 5).length, 0,
    'an entry with no id identifies nobody and is dropped');
});

// ── fwHotSystems ─────────────────────────────────────────────────────────────

const sys = (id, owner, occupier, contested, vp, vpt = 75000) => ({
  solar_system_id: id, owner_faction_id: owner, occupier_faction_id: occupier,
  contested, victory_points: vp, victory_points_threshold: vpt,
});

test('a stable system is not capture pressure', () => {
  const S = load();
  const rows = S.fwHotSystems([
    sys(1, 500001, 500001, 'uncontested', 0),
    sys(2, 500001, 500001, 'contested', 30000),
  ], 'all', 6);
  assert.deepStrictEqual(rows.map(r => r.id), [2]);
});

test('vulnerable outranks merely close', () => {
  // A vulnerable system can flip right now; a system at 90% cannot. Ranking by
  // percentage alone would bury the one that matters under the one that looks
  // more dramatic.
  const S = load();
  const rows = S.fwHotSystems([
    sys(1, 500001, 500001, 'contested', 71000),
    sys(2, 500001, 500001, 'vulnerable', 1000),
  ], 'all', 6);
  assert.deepStrictEqual(rows.map(r => r.id), [2, 1]);
});

test('within a state, the closest to falling comes first', () => {
  const S = load();
  const rows = S.fwHotSystems([
    sys(1, 500001, 500001, 'contested', 10000),
    sys(2, 500001, 500001, 'contested', 60000),
    sys(3, 500001, 500001, 'contested', 35000),
  ], 'all', 6);
  assert.deepStrictEqual(rows.map(r => r.id), [2, 3, 1]);
  assert.ok(Math.abs(rows[0].pct - 0.8) < 1e-9);
});

test('a warzone filter keeps only that warzone, and no filter keeps both', () => {
  const S = load();
  const all = [
    sys(1, 500001, 500001, 'contested', 30000),   // Caldari–Gallente
    sys(2, 500003, 500003, 'contested', 40000),   // Amarr–Minmatar
  ];
  assert.deepStrictEqual(S.fwHotSystems(all, 'cal-gal', 6).map(r => r.id), [1]);
  assert.deepStrictEqual(S.fwHotSystems(all, 'ama-min', 6).map(r => r.id), [2]);
  assert.strictEqual(S.fwHotSystems(all, 'all', 6).length, 2, 'an unknown key means both warzones');
});

test('a system held by its attacker is flagged, one held by its owner is not', () => {
  const S = load();
  const rows = S.fwHotSystems([
    sys(1, 500001, 500004, 'contested', 30000),
    sys(2, 500001, 500001, 'contested', 20000),
  ], 'all', 6);
  assert.strictEqual(rows[0].flipped, true);
  assert.strictEqual(rows[1].flipped, false);
});

test('progress is clamped and a zero threshold is not a division by zero', () => {
  const S = load();
  const rows = S.fwHotSystems([
    sys(1, 500001, 500001, 'contested', 90000, 75000),
    sys(2, 500001, 500001, 'contested', 500, 0),
  ], 'all', 6);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.strictEqual(byId[1].pct, 1, 'over threshold is full, never 120%');
  assert.strictEqual(byId[2].pct, 0);
  assert.ok(Number.isFinite(byId[2].pct));
});

test('the list is capped at what the tile asked for', () => {
  const S = load();
  const many = Array.from({ length: 20 }, (_, i) => sys(i + 1, 500001, 500001, 'contested', 1000 * i));
  assert.strictEqual(S.fwHotSystems(many, 'all', 6).length, 6);
  assert.strictEqual(S.fwHotSystems([], 'all', 6).length, 0);
  assert.strictEqual(S.fwHotSystems(null, 'all', 6).length, 0);
});

// ── fwTugOfWar ───────────────────────────────────────────────────────────────

test('the rope sits where the systems are, not where the victory points are', () => {
  // The whole reason two numbers are read from two endpoints: holding 3 of 4
  // systems is a 75% rope no matter who out-plexed whom yesterday.
  const S = load();
  const t = S.fwTugOfWar([stat(500001, 30, 100), stat(500004, 10, 900)], WZ_CAL_GAL);
  assert.strictEqual(t.ok, true);
  assert.strictEqual(t.pctA, 0.75);
  assert.strictEqual(t.pctB, 0.25);
  assert.strictEqual(t.holdA, 30);
  assert.strictEqual(t.pushing, 500004, 'and the push is still the other way');
});

test('the push is the militia with the bigger share of yesterday', () => {
  const S = load();
  const t = S.fwTugOfWar([stat(500001, 20, 700), stat(500004, 20, 300)], WZ_CAL_GAL);
  assert.strictEqual(t.pushing, 500001);
  assert.strictEqual(t.shareA, 0.7);
  assert.ok(Math.abs(t.lead - 0.4) < 1e-9);
});

test('a near-even day is a deadlock, not a direction', () => {
  // Without a deadband the arrow flips sides on noise, and a tile that changes
  // its mind every refresh is worse than one that says "evenly matched".
  const S = load();
  const even = S.fwTugOfWar([stat(500001, 20, 50600), stat(500004, 20, 49400)], WZ_CAL_GAL);
  assert.strictEqual(even.pushing, null);
  assert.strictEqual(even.intensity, 0, 'nothing to animate either');

  const justOutside = S.fwTugOfWar([stat(500001, 20, 530), stat(500004, 20, 470)], WZ_CAL_GAL);
  assert.strictEqual(justOutside.pushing, 500001, '6-point margin is past the 4-point deadband');
});

test('a silent warzone reads as even rather than as a landslide', () => {
  const S = load();
  const t = S.fwTugOfWar([stat(500001, 20, 0), stat(500004, 20, 0)], WZ_CAL_GAL);
  assert.strictEqual(t.shareA, 0.5);
  assert.strictEqual(t.pushing, null);
});

test('intensity is a display quantity: bounded, and it lifts the small leads', () => {
  const S = load();
  const lopsided = S.fwTugOfWar([stat(500001, 20, 1000), stat(500004, 20, 0)], WZ_CAL_GAL);
  assert.strictEqual(lopsided.lead, 1);
  assert.strictEqual(lopsided.intensity, 1, 'never past full tilt');

  // The margins that actually occur are small. A linear map would leave a real
  // warzone looking motionless, so the curve has to lift them.
  const real = S.fwTugOfWar([stat(500001, 20, 138603), stat(500004, 20, 155073)], WZ_CAL_GAL);
  assert.ok(real.lead < 0.06, `real-world lead is small: ${real.lead}`);
  assert.ok(real.intensity > 0.4 && real.intensity < 0.75,
    `and still reads as movement: ${real.intensity}`);
});

test('a warzone ESI has no stats for reports that, rather than inventing a 50/50', () => {
  const S = load();
  assert.strictEqual(S.fwTugOfWar([stat(500001, 20, 100)], WZ_CAL_GAL).ok, false);
  assert.strictEqual(S.fwTugOfWar([], WZ_CAL_GAL).ok, false);
  assert.strictEqual(S.fwTugOfWar(null, WZ_CAL_GAL).ok, false);
});

test('tiers follow the control share and carry their LP multiplier', () => {
  const S = load();
  const { FW_LP_MULT } = S.__x;
  const t = S.fwTugOfWar([stat(500001, 76, 100), stat(500004, 24, 100)], WZ_CAL_GAL);
  assert.strictEqual(t.tierA, 4, '76% of the warzone is tier 4');
  assert.strictEqual(t.tierB, 1);
  assert.strictEqual(FW_LP_MULT[t.tierA], 2.5);
});

// ── Reconciled against the live warzone ──────────────────────────────────────

test('the real Caldari–Gallente warzone, checked by hand', () => {
  // /fw/stats on 2026-09-01. Caldari held more ground while Gallente out-plexed
  // them over the previous day — the exact case the tile exists to show, and the
  // one a "who is winning" number computed from a single endpoint gets wrong.
  const S = load();
  const t = S.fwTugOfWar([
    stat(500001, 53, 138603), stat(500004, 37, 155073),
  ], WZ_CAL_GAL);

  assert.strictEqual(t.held, 90);
  assert.ok(Math.abs(t.pctA - 53 / 90) < 1e-12);
  assert.strictEqual((t.pctA * 100).toFixed(1), '58.9', 'rope: Caldari 58.9%');
  assert.strictEqual(t.tierA, 2, '58.9% is one point under the tier-3 line at 60%');
  assert.strictEqual((t.shareA * 100).toFixed(1), '47.2', 'push: Caldari took 47.2% of the day');
  assert.strictEqual(t.pushing, 500004, 'so Gallente are pushing, against the run of the map');
});

test('the real Amarr–Minmatar warzone was a deadlock that day', () => {
  const S = load();
  const t = S.fwTugOfWar([stat(500003, 44, 148829), stat(500002, 26, 145308)],
    { key: 'ama-min', factions: [500003, 500002] });
  assert.strictEqual((t.pctA * 100).toFixed(1), '62.9', 'Amarr hold well over half');
  assert.strictEqual((t.shareA * 100).toFixed(1), '50.6');
  assert.strictEqual(t.pushing, null, 'but 50.6/49.4 is nobody pushing');
});

// ── Per-instance choices and titles ──────────────────────────────────────────

test('each tile titles itself after what it was pointed at', () => {
  // Two of the same widget side by side are unreadable if both say TOP PILOTS.
  const S = load();
  S._fwWSetPick('fwBoard', 'fwBoard~a', 'kills:yesterday');
  S._fwWSetPick('fwBoard', 'fwBoard~b', 'victory_points:active_total');
  assert.notStrictEqual(S.fwWBoardTitle('fwBoard~a'), S.fwWBoardTitle('fwBoard~b'));
  assert.match(S.fwWBoardTitle('fwBoard~a'), /KILLS/);
  assert.match(S.fwWBoardTitle('fwBoard~b'), /VP/);

  S._fwWSetPick('fwTug', 'fwTug~a', 'ama-min');
  assert.match(S.fwWTugTitle('fwTug~a'), /AMARR/i);
  S._fwWSetPick('fwSystems', 'fwSystems~a', 'cal-gal');
  assert.match(S.fwWSystemsTitle('fwSystems~a'), /CALDARI/i);
});

test('an unset or unknown pick still produces a usable title', () => {
  const S = load();
  assert.ok(S.fwWBoardTitle('fwBoard~never-picked').length > 0);
  assert.ok(S.fwWTugTitle('fwTug~never-picked').length > 0);
  assert.strictEqual(S.fwWSystemsTitle('fwSystems~never-picked'), 'CAPTURE PRESSURE',
    'both warzones is the un-narrowed title');
  S._fwWSetPick('fwTug', 'fwTug~junk', 'not-a-warzone');
  assert.ok(S.fwWTugTitle('fwTug~junk').length > 0);
});

test('removing a tile forgets its choice, and only its own', () => {
  const S = load();
  S._fwWSetPick('fwBoard', 'fwBoard~keep', 'kills:yesterday');
  S._fwWSetPick('fwBoard', 'fwBoard~drop', 'victory_points:yesterday');
  S.fwWForgetPick('fwBoard~drop');
  assert.strictEqual(S._fwWGetPick('fwBoard', 'fwBoard~drop'), null);
  assert.strictEqual(S._fwWGetPick('fwBoard', 'fwBoard~keep'), 'kills:yesterday');
  // A widget with no stored choice must not throw its way through removal.
  assert.doesNotThrow(() => S.fwWForgetPick('networth'));
});

test('every pickable board resolves to a real metric and window', () => {
  // The pick values are strings in localStorage; a typo in one would render an
  // empty tile with no error anywhere.
  const S = load();
  for (const opt of S.fwWBoardOptions()) {
    S._fwWSetPick('fwBoard', 'fwBoard~probe', opt.value);
    assert.ok(S.fwWBoardTitle('fwBoard~probe').length > 0, opt.value);
    const [metric, win] = opt.value.split(':');
    assert.ok(['kills', 'victory_points'].includes(metric), opt.value);
    assert.ok(['yesterday', 'last_week', 'active_total'].includes(win), opt.value);
  }
});

test('every pickable warzone is a real warzone', () => {
  const S = load();
  const keys = S.__x.FW_WARZONES.map(w => w.key);
  assert.deepStrictEqual(S.fwWTugOptions().map(o => o.value), keys);
  const sysOpts = S.fwWSystemsOptions().map(o => o.value);
  assert.strictEqual(sysOpts[0], 'all', 'both warzones is offered first');
  keys.forEach(k => assert.ok(sysOpts.includes(k), k));
});

test('every militia has a CSS class to be coloured by', () => {
  // The widgets never inline-style a colour; they emit fw-f-<cls> and let
  // dashboard.css hold the value. A militia without one would render unstyled.
  const S = load();
  const seen = new Set();
  for (const id of Object.keys(S.__x.FW_FACTIONS)) {
    const f = S.__x.FW_FACTIONS[id];
    assert.match(f.cls, /^[a-z]+$/, `${f.name} needs a class-safe cls`);
    assert.ok(!seen.has(f.cls), `${f.cls} is used twice`);
    seen.add(f.cls);
  }
  assert.strictEqual(seen.size, 4);
});
