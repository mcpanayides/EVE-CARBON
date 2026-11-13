// The SDE update's progress and time left (src/shared/sde_eta.js), tested by
// replaying a real update: build 3670638, timed stage by stage on 2026-11-08.
// 120 s in all; the download was 17 s of it and the database build 98 s.
const test = require('node:test');
const assert = require('node:assert');
const { create, formatEta, formatMB, stepShare } = require('../src/shared/sde_eta');

const MB = 1048576;
const ZIP = Math.round(94.7 * MB);

// [build step label, seconds it took], in the order sde_build.js runs them.
const BUILD = [
  ['Creating schema...', 0.3], ['Loading lookup maps...', 2.7],
  ['Populating invCategories, invGroups, invMarketGroups, chrRaces...', 0.2],
  ['Populating invTypes, invMetaTypes...', 6.8],
  ['Populating invTraits (role + skill-linked ship/subsystem bonuses)...', 0.3],
  ['Populating invTypeMaterials...', 2.6],
  ['Populating dgmTypeAttributes, dgmTypeEffects (the big one)...', 40.2],
  ['Populating planetSchematics...', 0.05], ['Populating dgmEffects...', 0.2],
  ['Populating blueprints -> industryActivity / Materials / Products...', 3.6],
  ['Populating mapRegions, mapConstellations, mapSolarSystems, mapSolarSystemJumps...', 0.9],
  ['Deriving mapSolarSystemJumps from stargate destinations...', 0.9],
  ['Populating mapDenormalize (systems, planets, moons, belts, stars, stargates)...', 36.6],
  ['Populating staStations (NPC stations, with reconstructed display names)...', 0.4],
  ['Appending stations to mapDenormalize (old table includes them as items too)...', 0.4],
  ['Creating indexes...', 2.2],
];

/**
 * The update as a list of [ms, event], each build step `slow` times as long:
 * the events main sends, at the times they arrived.
 */
function replay({ downloadS = 17.2, slow = 1, slowExtract = slow } = {}) {
  const out = [];
  let t = 0;
  out.push([t, { phase: 'check' }]);
  t += 300;
  out.push([t, { phase: 'download', downloaded: 0, total: 0 }]);
  for (let pct = 1; pct <= 100; pct++) {                 // one event per percent, as downloadFile sends
    out.push([t + (downloadS * 1000) * pct / 100, { phase: 'download', downloaded: Math.round(ZIP * pct / 100), total: ZIP }]);
  }
  t += downloadS * 1000;
  out.push([t, { phase: 'extract' }]);
  t += 3800 * slowExtract;
  out.push([t, { phase: 'build', step: 0 }]);
  BUILD.forEach(([label, s], i) => {
    out.push([t, { phase: 'build', step: i + 1, label }]);
    t += s * 1000 * slow;
  });
  out.push([t, { phase: 'finish' }]);
  t += 200;
  out.push([t, { phase: 'done' }]);
  return { events: out, totalMs: t };
}

/** Run the replay, sampling the estimate every second as the toast does. */
function run(opts) {
  const { events, totalMs } = replay(opts);
  const eta = create();
  const samples = [];
  let i = 0;
  for (let now = 0; now <= totalMs; now += 250) {
    while (i < events.length && events[i][0] <= now) { eta.update(events[i][1], events[i][0]); i++; }
    samples.push({ now, ...eta.snapshot(now), left: totalMs - now });
  }
  while (i < events.length) { eta.update(events[i][1], events[i][0]); i++; }
  return { samples, final: eta.snapshot(totalMs), totalMs };
}

test('on the measured update, the estimate stays near the real time left', () => {
  const { samples } = run();
  // From once the download rate is known until the last few seconds, within 30%.
  const judged = samples.filter(s => s.etaMs != null && s.left > 10000);
  assert.ok(judged.length > 300, 'most of the run is judged');
  const off = judged.filter(s => Math.abs(s.etaMs - s.left) / s.left > 0.30);
  assert.ok(off.length / judged.length < 0.1,
    `${off.length} of ${judged.length} samples more than 30% out (worst: ${JSON.stringify(off[0])})`);
});

test('while downloading, the estimate includes the build still to come', () => {
  // 17 s of download, then 100 s of building: "17 s left" would be the wrong answer.
  const { samples } = run();
  const mid = samples.find(s => s.phase === 'download' && s.downloaded > ZIP / 2 && s.etaMs != null);
  assert.ok(mid.etaMs > 90000, `half way through the download, ${mid.etaMs} ms is not ~108 s`);
});

test('the time left is not guessed before the download has a rate', () => {
  const eta = create();
  eta.update({ phase: 'check' }, 0);
  eta.update({ phase: 'download', downloaded: 0, total: ZIP }, 300);
  assert.strictEqual(eta.update({ phase: 'download', downloaded: 2 * MB, total: ZIP }, 700).etaMs, null);
  assert.strictEqual(formatEta(null), 'Working out the time left…');
});

test('the bar only moves forward, and ends at 100%', () => {
  const { samples, final } = run();
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].percent >= samples[i - 1].percent, `went back at ${samples[i].now} ms`);
  }
  assert.strictEqual(final.percent, 100);
  assert.strictEqual(final.etaMs, 0);
});

test('a slower machine corrects its own estimate once the build gets going', () => {
  // Every build step taking twice as long as measured, unpacking too.
  const { samples } = run({ slow: 2 });
  const late = samples.filter(s => s.phase === 'build' && s.left > 20000);
  const off = late.filter(s => Math.abs(s.etaMs - s.left) / s.left > 0.35);
  assert.ok(off.length / late.length < 0.1, `${off.length} of ${late.length} build samples more than 35% out`);
});

test('how long unpacking took is the first guess at the build', () => {
  // Twice as slow at both: from the first second of the build, the estimate
  // already has it about right, before any build step has finished.
  const { samples } = run({ slow: 2 });
  const start = samples.find(s => s.phase === 'build');
  assert.ok(Math.abs(start.etaMs - start.left) / start.left < 0.15,
    `${Math.round(start.etaMs / 1000)} s estimated, ${Math.round(start.left / 1000)} s real`);
  // A fast unpack on a machine whose build is not fast just starts at the
  // measured speed and corrects later; it never guesses faster than half.
  const quick = run({ slowExtract: 0.25 }).samples.find(s => s.phase === 'build');
  assert.ok(quick.etaMs >= 0.5 * 98000 * 0.9);
});

test('inside a long silent step the estimate keeps falling', () => {
  // The item-attributes step sends nothing for 40 s; the card ticks every second.
  const { samples } = run();
  const inStep = samples.filter(s => s.phase === 'build' && s.step === 7);
  assert.ok(inStep.length > 100);
  const first = inStep[0].etaMs, last = inStep[inStep.length - 1].etaMs;
  assert.ok(last < first - 25000, `${first} → ${last}: should fall through the step`);
});

test('each build step is matched by how its label starts', () => {
  assert.strictEqual(stepShare('Populating invTypes, invMetaTypes...'), 0.069);
  assert.strictEqual(stepShare('Populating invTypeMaterials...'), 0.026, 'not mistaken for invTypes');
  assert.strictEqual(stepShare('Populating somethingNew...'), 0.01, 'an unknown step counts 1%');
});

test('time left reads like a person said it', () => {
  assert.strictEqual(formatEta(4000), 'Almost done');
  assert.strictEqual(formatEta(42000), 'About 40 s left');
  assert.strictEqual(formatEta(95000), 'About 1 min 40 s left');
  assert.strictEqual(formatEta(120000), 'About 2 min left');
  assert.strictEqual(formatEta(720000), 'About 12 min left');
  assert.strictEqual(formatMB(ZIP), '94.7 MB');
});
