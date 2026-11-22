'use strict';
// ─── sde_watchdog.js ─────────────────────────────────────────────────────────
// Ends a job that has stopped making progress, with an error that says so.
//
// The SDE update's own failures are errors now, but the one that started this
// was a callback that never came, and no amount of error handling catches that.
// So the job calls `alive()` as it works (every batch of rows, every second of
// a download), and silence for `stallMs` is a failure.
//
// Counted in timer ticks rather than by the clock: a laptop that sleeps in the
// middle wakes up hours "late" with nothing wrong.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {(alive: () => void) => Promise<T>} job
 * @param {{ stallMs?: number, tickMs?: number }} [opts]
 */
function runWithWatchdog(job, { stallMs = 5 * 60 * 1000, tickMs = 5000 } = {}) {
  let quiet = 0;
  let timer = null;
  const stalled = new Promise((_, reject) => {
    timer = setInterval(() => {
      quiet += tickMs;
      if (quiet < stallMs) return;
      const min = Math.round(stallMs / 60000);
      reject(new Error(`Stopped after ${min >= 1 ? `${min} min` : `${Math.round(stallMs / 1000)} s`} with no progress`));
    }, tickMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve().then(() => job(() => { quiet = 0; })), stalled])
    .finally(() => clearInterval(timer));
}

module.exports = { runWithWatchdog };
