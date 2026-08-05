'use strict';
//
// The per-region force layout behind the Modern galaxy map, as a pure function.
//
// This is a VERBATIM port of _regionForceLayout() in src/func/map.js — same
// operations in the same order, so it produces bit-identical positions. The one
// difference is deliberate: the renderer's copy reaches into module-global
// _sysById for seed positions, and this one takes them as an argument, which is
// what makes it runnable inside a worker thread.
//
// Why the duplication is tolerable: the renderer copy is the FALLBACK. If the
// worker pool fails, is unavailable, or returns a short result, map.js quietly
// runs its own version and the user sees the map it always saw. Losing the
// parallel path costs latency, never correctness. test/region_layout.test.js
// pins the two implementations together against a fixture.
//
// Costs ~1.4s single-threaded across the galaxy's ~70 regions; it is the reason
// the Modern map used to block the renderer for over a second on first open.

/**
 * Relax one region's gate graph into the reference 2D-mode look.
 *
 * Springs pull EVERY gate link toward one uniform rest length (so squares
 * render as squares and chains as even ladders), a spatial-hash collision pass
 * keeps systems from touching, and seeding from the true star positions keeps
 * the drawing nearly crossing-free.
 *
 * @param {number[]} ids    system IDs in this region
 * @param {object|Map} adj  id -> array of neighbour ids (galaxy-wide is fine;
 *                          links leaving the region are ignored)
 * @param {object} seeds    id -> [wx, wz] true star position, any scale
 * @returns {Array<[number, {x:number, z:number}]>} centred, in rest-length units
 *          — an array of pairs rather than a Map so it survives structured clone
 *          across the worker boundary unchanged.
 */
function regionForceLayout(ids, adj, seeds) {
  const out = [];
  const n = ids.length;
  if (!n) return out;
  const index = new Map(ids.map((id, i) => [id, i]));
  const neighbours = (id) => (adj instanceof Map ? adj.get(id) : adj[id]) || [];

  // Seed from true positions, scaled so the median gate edge starts near 1.
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = seeds[ids[i]];
    px[i] = s ? s[0] : 0; pz[i] = s ? s[1] : 0;
  }
  const ea = [], eb = [];
  for (let i = 0; i < n; i++) {
    for (const v of neighbours(ids[i])) {
      const j = index.get(v);
      if (j !== undefined && j > i) { ea.push(i); eb.push(j); }
    }
  }
  const seedLens = ea.map((a, e) => Math.hypot(px[eb[e]] - px[a], pz[eb[e]] - pz[a])).sort((x, y) => x - y);
  const med = seedLens.length ? (seedLens[Math.floor(seedLens.length / 2)] || 1) : 1;
  for (let i = 0; i < n; i++) { px[i] /= med; pz[i] /= med; }

  const MIND = 0.8;   // no two systems closer than 80% of an edge length
  for (let it = 0; it < 220; it++) {
    const step = 0.05 + 0.25 * (1 - it / 220);   // cooling
    // Uniform-length springs (both directions: long edges contract, short expand).
    for (let e = 0; e < ea.length; e++) {
      const a = ea[e], b = eb[e];
      let dx = px[b] - px[a], dz = pz[b] - pz[a];
      const d = Math.hypot(dx, dz) || 0.001;
      const f = ((d - 1) / d) * 0.5 * step;
      dx *= f; dz *= f;
      px[a] += dx; pz[a] += dz; px[b] -= dx; pz[b] -= dz;
    }
    // Collision repulsion via spatial hash (only neighbouring cells checked).
    const cell = new Map();
    for (let i = 0; i < n; i++) {
      const k = Math.round(px[i]) + ':' + Math.round(pz[i]);
      const bucket = cell.get(k);
      if (bucket) bucket.push(i); else cell.set(k, [i]);
    }
    for (let i = 0; i < n; i++) {
      const cx0 = Math.round(px[i]), cz0 = Math.round(pz[i]);
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
        const bucket = cell.get((cx0 + gx) + ':' + (cz0 + gz));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          let dx = px[j] - px[i], dz = pz[j] - pz[i];
          const d = Math.hypot(dx, dz) || 0.001;
          if (d >= MIND) continue;
          const f = ((MIND - d) / d) * 0.5 * step;
          dx *= f; dz *= f;
          px[i] -= dx; pz[i] -= dz; px[j] += dx; pz[j] += dz;
        }
      }
    }
  }

  // ── Rectification — the reference's "clean" look ──────────────────────────
  // Snap every node onto the integer grid (high-degree hubs first, spiralling
  // to the nearest free cell on collision). Gate neighbours end up 1 cell or a
  // diagonal apart, so edges render as straight horizontals / verticals / 45°s
  // instead of the organic squiggle the raw force layout produces.
  const keyOf = (gx, gz) => gx + ':' + gz;
  const taken = new Map();
  const degree = new Array(n).fill(0);
  for (let e = 0; e < ea.length; e++) { degree[ea[e]]++; degree[eb[e]]++; }
  const orderIdx = [...Array(n).keys()].sort((a, b) => degree[b] - degree[a]);
  for (const i of orderIdx) {
    let gx = Math.round(px[i]), gz = Math.round(pz[i]);
    if (taken.has(keyOf(gx, gz))) {
      let found = false;
      for (let r = 1; r <= 6 && !found; r++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          for (let dz = -r; dz <= r && !found; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            if (!taken.has(keyOf(gx + dx, gz + dz))) { gx += dx; gz += dz; found = true; }
          }
        }
      }
    }
    taken.set(keyOf(gx, gz), i);
    px[i] = gx; pz[i] = gz;
  }

  // Greedy octilinear polish: nudge each node into a neighbouring free cell
  // when that makes its edges shorter and closer to the 8 compass directions.
  const inc = Array.from({ length: n }, () => []);
  for (let e = 0; e < ea.length; e++) { inc[ea[e]].push(e); inc[eb[e]].push(e); }
  const EIGHTH = Math.PI / 4;
  const nodeCost = (i, x, z) => {
    let c = 0;
    for (const e of inc[i]) {
      const j = ea[e] === i ? eb[e] : ea[e];
      const dx = px[j] - x, dz = pz[j] - z;
      const d = Math.hypot(dx, dz) || 0.001;
      c += Math.abs(d - 1);                                        // uniform length
      const a = Math.atan2(dz, dx);
      c += Math.abs(a - Math.round(a / EIGHTH) * EIGHTH) * 0.8;    // octilinearity
    }
    return c;
  };
  const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const i of orderIdx) {
      let bestX = px[i], bestZ = pz[i], bestC = nodeCost(i, px[i], pz[i]);
      for (const [dx, dz] of DIRS8) {
        const nx = px[i] + dx, nz = pz[i] + dz;
        if (taken.has(keyOf(nx, nz))) continue;
        const c = nodeCost(i, nx, nz);
        if (c < bestC - 1e-6) { bestC = c; bestX = nx; bestZ = nz; }
      }
      if (bestX !== px[i] || bestZ !== pz[i]) {
        taken.delete(keyOf(px[i], pz[i]));
        taken.set(keyOf(bestX, bestZ), i);
        px[i] = bestX; pz[i] = bestZ;
      }
    }
  }

  let mx = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += px[i]; mz += pz[i]; }
  mx /= n; mz /= n;
  for (let i = 0; i < n; i++) out.push([ids[i], { x: px[i] - mx, z: pz[i] - mz }]);
  return out;
}

module.exports = { regionForceLayout };
