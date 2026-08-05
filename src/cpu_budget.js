'use strict';
//
// How many worker threads to spawn for a parallelisable batch, decided at
// runtime from the machine actually running the app.
//
// MEASURED, not guessed. Benchmark: the 70 per-region force layouts behind the
// Modern galaxy map (~1.4s single-threaded), run under Windows processor
// affinity to emulate smaller CPUs on a 16-logical-core i7-7820X:
//
//   cores   serial    best        16 workers
//     2     1482ms    2w 1385ms   1985ms   <- SLOWER than serial
//     4     1432ms    4w  768ms   1012ms
//     8     1449ms    8w  433ms    515ms
//    16     1363ms    8w  360ms    362ms   <- nothing gained past 8
//
// Three things that table decides:
//
//  1. CAP AT 8. Past 8 workers the curve is flat or worse on every machine
//     tested. Worker startup is ~25ms each, and the batch has a hard floor at
//     the largest single task (Domain, 189 systems, 57ms) — so more threads
//     buy nothing once the queue is shorter than the spawn cost.
//
//  2. RESERVE A CORE. Peak throughput on a 4-core box wanted all 4 workers, but
//     this app runs alongside EVE. Giving back one core costs ~8% on a job that
//     happens once per SDE version, and avoids a full-CPU stall mid-fight.
//
//  3. NEVER OVERSUBSCRIBE A SMALL MACHINE. At 2 cores, 16 workers ran 34%
//     SLOWER than doing the work on one thread. On tiny CPUs the win isn't
//     parallelism, it's simply being off the UI thread — one worker delivers
//     that and costs nothing.
//
// CAVEAT worth knowing before "fixing" the detection: on Windows neither
// os.cpus().length nor os.availableParallelism() respects processor affinity —
// both reported 16 under a 2-core mask. Affinity is therefore a way to measure
// the performance curve, not a way to test this function. Container CPU limits
// on Linux ARE reflected by availableParallelism(), which is why it's preferred.

const os = require('os');

const MAX_WORKERS   = 8;   // measured ceiling — see (1) above
const RESERVED_CORE = 1;   // headroom for the UI thread and the game — see (2)

/** Logical processors, preferring the API that honours cgroup/container limits. */
function logicalCores() {
  try {
    if (typeof os.availableParallelism === 'function') {
      const n = os.availableParallelism();
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (_) { /* fall through */ }
  const n = (os.cpus() || []).length;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Workers to spawn for a batch of independent tasks.
 *
 * @param {number}  taskCount        how many independent units of work there are
 * @param {object} [opts]
 * @param {number} [opts.cores]      override the detected core count (tests)
 * @param {number} [opts.max]        override the ceiling
 * @param {number} [opts.minPerWorker=1]  don't split below this much work per worker
 * @returns {number} 1..max — never 0, so the caller always has a worker to hand
 *                   work to and never needs a separate inline code path.
 */
function workerCount(taskCount, opts = {}) {
  const cores = Number.isFinite(opts.cores) ? opts.cores : logicalCores();
  const max   = Number.isFinite(opts.max)   ? opts.max   : MAX_WORKERS;
  const minPer = Math.max(1, opts.minPerWorker || 1);

  if (!Number.isFinite(taskCount) || taskCount <= 1) return 1;

  // Reserve headroom, cap at the measured ceiling, and never spawn a worker
  // that would get less than minPer tasks — an idle worker is pure spawn cost.
  const byCores = Math.max(1, cores - RESERVED_CORE);
  const byWork  = Math.max(1, Math.floor(taskCount / minPer));
  return Math.max(1, Math.min(byCores, byWork, max, taskCount));
}

/**
 * Split tasks across workers, heaviest first.
 *
 * Order matters more than it looks: the batch cannot finish before its largest
 * task, so a heavy region picked up last leaves every other worker idle waiting
 * for it. Longest-processing-time-first is what turned a naive split into the
 * measured 3.8x. `weight` should be proportional to actual cost — for an O(n²)
 * relaxation that's n², not n.
 *
 * @param {Array}     tasks
 * @param {number}    workers
 * @param {Function} [weight]  task -> relative cost (default: equal)
 * @returns {Array<Array>} one bucket per worker, empty buckets dropped
 */
function balance(tasks, workers, weight = () => 1) {
  const bins  = Array.from({ length: Math.max(1, workers) }, () => []);
  const loads = new Array(bins.length).fill(0);
  for (const t of [...tasks].sort((a, b) => weight(b) - weight(a))) {
    let k = 0;
    for (let i = 1; i < loads.length; i++) if (loads[i] < loads[k]) k = i;
    bins[k].push(t);
    loads[k] += weight(t);
  }
  return bins.filter(b => b.length);
}

module.exports = { workerCount, balance, logicalCores, MAX_WORKERS, RESERVED_CORE };
