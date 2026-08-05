'use strict';
//
// Worker thread: relaxes a bundle of regions and posts the positions back.
//
// Deliberately thin. All the scheduling lives in src/galaxy_layout.js and all
// the maths lives in src/region_layout.js; this file exists only to give that
// maths its own core. Keeping it free of app state is what makes it safe to run
// N of them — there is nothing here to contend over.

const { parentPort, workerData } = require('worker_threads');
const { regionForceLayout } = require('../region_layout');

// One bundle per worker, handed over at spawn time — no message loop. The pool
// is sized so every worker gets a fair share of the total work up front
// (see balance() in src/cpu_budget.js), so there is nothing to hand out later,
// and a spawn-and-collect worker cannot leak or outlive its batch.
const { regions, adj, seeds } = workerData;

const out = [];
for (const r of regions) {
  try {
    out.push({ regionId: r.regionId, positions: regionForceLayout(r.ids, adj, seeds) });
  } catch (e) {
    // Report the failure for this region only. The caller drops regions it
    // didn't get back and the renderer lays those out itself, so one bad region
    // degrades to today's behaviour instead of losing the whole batch.
    out.push({ regionId: r.regionId, positions: null, error: String(e && e.message || e) });
  }
}
parentPort.postMessage(out);
