'use strict';
// The numbers asserted here come from a real benchmark (see src/cpu_budget.js);
// they are not preferences. Changing them should mean re-running that benchmark.
const test   = require('node:test');
const assert = require('node:assert');
const { workerCount, balance, logicalCores, MAX_WORKERS } = require('../src/cpu_budget');

const TASKS = 70;   // the real batch size: 70 k-space regions

test('scales with the machine it finds itself on', () => {
  const got = n => workerCount(TASKS, { cores: n });
  assert.strictEqual(got(1),  1, 'single core: one worker, purely to get off the UI thread');
  assert.strictEqual(got(2),  1, '2 cores: 16 workers measured 34% SLOWER than serial — do not oversubscribe');
  assert.strictEqual(got(4),  3, '4 cores: leave one for the UI and the game');
  assert.strictEqual(got(8),  7);
  assert.strictEqual(got(16), 8, 'capped — 16 workers measured no better than 8');
  assert.strictEqual(got(20), 8);
  assert.strictEqual(got(64), 8, 'a big server box gains nothing past the cap');
});

test('never spawns more workers than there is work', () => {
  assert.strictEqual(workerCount(3, { cores: 32 }), 3);
  assert.strictEqual(workerCount(1, { cores: 32 }), 1);
  assert.strictEqual(workerCount(0, { cores: 32 }), 1, 'degenerate input still returns a usable count');
});

test('minPerWorker stops splitting work too thin', () => {
  // 10 tasks, 32 cores, but nothing smaller than 5 tasks per worker is worth a spawn.
  assert.strictEqual(workerCount(10, { cores: 32, minPerWorker: 5 }), 2);
});

test('always returns at least 1 so callers need no inline fallback path', () => {
  for (const cores of [0, 1, 2, NaN, undefined]) {
    const n = workerCount(TASKS, { cores });
    assert.ok(n >= 1 && Number.isFinite(n), `cores=${cores} gave ${n}`);
  }
});

test('detects a plausible core count on the real machine', () => {
  const n = logicalCores();
  assert.ok(Number.isInteger(n) && n >= 1 && n < 1024, `implausible core count: ${n}`);
});

test('balance puts the heaviest task first so it cannot tail the batch', () => {
  // The batch can never finish before its largest task. Scheduling that one
  // last is what makes a naive split slow.
  const tasks = [{ n: 1 }, { n: 10 }, { n: 1 }, { n: 1 }];
  const bins  = balance(tasks, 2, t => t.n);
  assert.strictEqual(bins[0][0].n, 10, 'largest task must be scheduled first');
});

test('balance spreads weight, not task count', () => {
  // One 189-system region costs far more than several small ones — weighting by
  // n² (the relaxation is O(n²)) is what keeps the bins even in real time.
  const tasks = [{ n: 189 }, { n: 20 }, { n: 20 }, { n: 20 }, { n: 20 }];
  const bins  = balance(tasks, 2, t => t.n * t.n);
  const load  = bins.map(b => b.reduce((a, t) => a + t.n * t.n, 0));
  assert.strictEqual(bins.length, 2);
  assert.ok(bins.some(b => b.length === 1 && b[0].n === 189),
    'the giant region gets a bin to itself rather than being paired up');
  assert.ok(Math.max(...load) / Math.min(...load) < 25, 'bins should not be wildly lopsided');
});

test('balance covers every task exactly once', () => {
  const tasks = Array.from({ length: 70 }, (_, i) => ({ id: i, n: (i % 9) + 1 }));
  const bins  = balance(tasks, workerCount(70, { cores: 16 }), t => t.n * t.n);
  const seen  = bins.flat().map(t => t.id).sort((a, b) => a - b);
  assert.deepStrictEqual(seen, tasks.map(t => t.id), 'no task dropped or duplicated');
});

test('balance drops empty bins rather than spawning idle workers', () => {
  const bins = balance([{ n: 1 }, { n: 1 }], 8, t => t.n);
  assert.strictEqual(bins.length, 2, '8 requested, only 2 tasks — 6 idle workers would be pure cost');
});

test('the measured ceiling is what the code actually uses', () => {
  assert.strictEqual(MAX_WORKERS, 8);
  assert.strictEqual(workerCount(1000, { cores: 1000 }), MAX_WORKERS);
});
