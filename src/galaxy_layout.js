'use strict';
//
// Runs the galaxy's ~70 per-region force layouts across a worker pool.
//
// WHY THIS EXISTS
// The Modern map's layout costs ~1.6s of solid CPU, ~1.4s of which is the
// per-region relaxation. In the renderer that lands on the one thread that also
// draws — a visible freeze on first map open. The regions are independent, so
// the work parallelises almost perfectly (measured 3.8x on 8 workers).
//
// It has to be the MAIN process: the app is served from file://, whose opaque
// origin blocks renderer Web Workers, so worker_threads here is the only route
// to a second core.
//
// FAILURE IS NOT FATAL. Every path returns whatever it managed to compute, and
// map.js lays out anything missing with its own copy of the kernel. A broken
// pool costs the old ~1.6s freeze, never a broken map.

const path        = require('path');
const { Worker }  = require('worker_threads');
const cpuBudget   = require('./cpu_budget');

const WORKER_FILE = path.join(__dirname, 'workers', 'region_layout_worker.js');

// A region below this doesn't repay a structured-clone round trip, let alone a
// thread. Sizing by minPerWorker keeps small galaxies on few threads.
const MIN_REGIONS_PER_WORKER = 4;

// Nothing should be able to hang the map. The whole batch measured ~360ms on 8
// workers and ~1.5s on a single-core box; 30s is a stuck worker, not a slow one.
const BATCH_TIMEOUT_MS = 30_000;

/**
 * @param {object}   job
 * @param {Array}    job.regions  [{ regionId, ids: number[] }]
 * @param {object}   job.adj      id -> neighbour ids (galaxy-wide)
 * @param {object}   job.seeds    id -> [wx, wz]
 * @returns {Promise<{layouts: object, ms: number, workers: number, failed: number}>}
 *          layouts is regionId -> [[systemId, {x, z}], ...]; regions that failed
 *          are simply absent, which the caller treats as "lay this one out
 *          yourself".
 */
async function buildRegionLayouts({ regions, adj, seeds }) {
  const t0 = Date.now();
  const work = (regions || []).filter(r => r && Array.isArray(r.ids) && r.ids.length);
  if (!work.length) return { layouts: {}, ms: 0, workers: 0, failed: 0 };

  const workers = cpuBudget.workerCount(work.length, { minPerWorker: MIN_REGIONS_PER_WORKER });
  // Weight by n²: the relaxation is quadratic in system count, so one 189-system
  // region outweighs a dozen small ones. Splitting by region COUNT would leave
  // one worker grinding on Domain while the rest sat idle.
  const bins = cpuBudget.balance(work, workers, r => r.ids.length * r.ids.length);

  const layouts = {};

  // workerData is structured-cloned per worker, so handing all 8 the whole
  // galaxy's adjacency and seeds copies ~5 200 entries eight times over — that
  // measured 621ms wall against 380ms of actual compute. The kernel only ever
  // reads entries for systems in the region it's laying out, so each worker
  // gets exactly its own slice.
  const sliceFor = (bin) => {
    const adjSlice = {}, seedSlice = {};
    for (const r of bin) {
      for (const id of r.ids) {
        if (adj[id])   adjSlice[id]  = adj[id];
        if (seeds[id]) seedSlice[id] = seeds[id];
      }
    }
    return { adj: adjSlice, seeds: seedSlice };
  };

  const runBin = (bin) => new Promise((resolve) => {
    let settled = false;
    let timer   = null;
    const finish = (results) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(results || []);
    };

    let w;
    try {
      w = new Worker(WORKER_FILE, { workerData: { regions: bin, ...sliceFor(bin) } });
    } catch (e) {
      console.warn('[galaxy-layout] worker spawn failed:', e.message);
      return finish([]);           // caller falls back for this bin's regions
    }

    timer = setTimeout(() => {
      console.warn(`[galaxy-layout] worker timed out after ${BATCH_TIMEOUT_MS}ms — terminating`);
      try { w.terminate(); } catch (_) {}
      finish([]);
    }, BATCH_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    w.on('message', finish);
    w.on('error', (e) => { console.warn('[galaxy-layout] worker error:', e.message); finish([]); });
    // 'exit' after a normal 'message' is a no-op thanks to the settled guard; it
    // only matters when a worker dies without posting, which would otherwise
    // leave this promise pending forever and hang the whole batch.
    w.on('exit', () => finish([]));
  });

  const bundles = await Promise.all(bins.map(runBin));
  for (const results of bundles) {
    for (const r of results) {
      if (r && r.positions) layouts[r.regionId] = r.positions;
      else if (r && r.error) console.warn(`[galaxy-layout] region ${r.regionId} failed: ${r.error}`);
    }
  }
  // Counted from what came back rather than tallied along the way, so it covers
  // regions whose worker died without reporting them at all.
  const got    = Object.keys(layouts).length;
  const failed = work.length - got;

  const ms = Date.now() - t0;
  console.log(`[galaxy-layout] ${got}/${work.length} regions on ${bins.length} worker(s) in ${ms}ms` +
              (failed ? ` (${failed} fell back to the renderer)` : ''));
  return { layouts, ms, workers: bins.length, failed };
}

module.exports = { buildRegionLayouts, MIN_REGIONS_PER_WORKER };
