// Planned routes on the map.
//
// The Spatial view drew no route at all: the planners' "show on map" set one
// only the Schematic knew how to draw, then framed it with the Schematic's
// camera. On Spatial a plotted route was simply not there.
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
}

/** 1DQ1-A to Jita by stargates: 42 jumps across half the cluster. */
function route(window) {
  return window.evaluate(() => {
    const a = _systems.find(s => s.name === '1DQ1-A'), b = _systems.find(s => s.name === 'Jita');
    return _routeDijkstra(a.id, b.id, { mode: 'shortest', useBridges: false }).path;
  });
}

/**
 * Pixels of route blue (96,200,255) on the map canvas - the line and its
 * rings. No security colour comes close: the nearest, 1.0 and 0.9, are
 * (46,255,255) and (72,240,192).
 */
function routeBlue(window) {
  return window.evaluate(() => {
    const d = _ctx.getImageData(0, 0, _canvas.width, _canvas.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 96) < 30 && Math.abs(d[i + 1] - 200) < 30 && d[i + 2] > 225) n++;
    }
    return n;
  });
}

/**
 * Show a route and skip to where it lands. A new route draws itself in over
 * a few seconds (e2e/map-route-reveal.spec.js); these tests are about the
 * route that is left on the map, not its arrival.
 */
function showRoute(window, path) {
  return window.evaluate((p) => { window.mapShowRoute(p); _routeRevealFinish(); _render(); }, path);
}

function onScreen(window, ids) {
  return window.evaluate((ids) => ids.filter(id => {
    const c = _spatialCanvasOf(id);
    return c && c[0] >= 0 && c[0] <= _canvas.width && c[1] >= 0 && c[1] <= _canvas.height;
  }).length, ids);
}

test('a planned route is drawn and framed on the Spatial map', async ({ window }) => {
  await openMap(window);
  const path = await route(window);
  expect(path.length).toBeGreaterThan(20);

  // Flown in over Tenal, far from the route: most of it out of view.
  await window.evaluate(() => {
    _viewMode = 'spatial'; _camFlat = false; _fitSpatial();
    const t = _systems.find(s => _regions[s.regionId] === 'Tenal');
    _camFocusX = t.tx; _camFocusY = t.ty; _camFocusZ = t.tz;
    _camPanX = 0; _camPanY = 0; _camZoom *= 8; _render();
  });
  expect(await onScreen(window, path)).toBeLessThan(path.length / 2);
  const before = await routeBlue(window);

  await showRoute(window, path);
  expect(await onScreen(window, path), 'framed: every system on the route in view').toBe(path.length);
  expect(await routeBlue(window) - before, 'drawn: the route and its rings').toBeGreaterThan(300);

  // The line itself, not just the rings: the middle of the longest hop - a
  // 22 LY regional gate out of Period Basis, open space - is route blue.
  // And the start is ringed: route blue at three of four points around it.
  const marks = await window.evaluate((path) => {
    const blue = (x, y) => {
      const d = _ctx.getImageData(Math.round(x) - 1, Math.round(y) - 1, 3, 3).data;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - 96) < 30 && Math.abs(d[i + 1] - 200) < 30 && d[i + 2] > 225) return true;
      }
      return false;
    };
    let mid = null, longest = 0;
    for (let i = 1; i < path.length; i++) {
      const a = _spatialCanvasOf(path[i - 1]), b = _spatialCanvasOf(path[i]);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > longest) { longest = len; mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    }
    const [sx, sy] = _spatialCanvasOf(path[0]);
    const ring = [[7, 0], [-7, 0], [0, 7], [0, -7]].filter(([dx, dy]) => blue(sx + dx, sy + dy)).length;
    return { line: blue(mid[0], mid[1]), ring };
  }, path);
  expect(marks.line, 'the route line').toBe(true);
  expect(marks.ring, 'the start ring').toBeGreaterThanOrEqual(3);
});

test('the Schematic still draws it, from the same shared code', async ({ window }) => {
  await openMap(window);
  const path = await route(window);
  await window.locator('.map-view-btn[data-view="modern"]').click();
  await window.waitForTimeout(300);
  const before = await routeBlue(window);
  await showRoute(window, path);
  expect(await routeBlue(window) - before).toBeGreaterThan(300);
});

// ── Safest route ──────────────────────────────────────────────────────────────
//
// Anyone who knows the game holds "Safest route" up against its Safer autopilot.
// Amarr to Jita cut through low-sec Ahbazon, because every low-sec system has a
// faction claim in the sov data and was priced as neutral null-sec.

/**
 * Sov as production delivers it, whatever the network is doing: a faction claim
 * on every hi-sec and low-sec system, null-sec held by someone with no standing.
 * The map's first live fetch can still be in flight: stamping _sovAt marks this
 * as newer, so a late answer leaves it alone.
 */
function seedSov(window) {
  return window.evaluate(() => {
    _sovMap = {};
    for (const s of _systems) {
      _sovMap[s.id] = s.sec > 0
        ? { allianceId: null, corporationId: null, factionId: 500001, isCapital: false }
        : { allianceId: 99990001, corporationId: 98990001, factionId: null, isCapital: false };
    }
    _sovAt = Date.now();
    _fnfStandings = {};
    _fnfAllianceId = null;
    _fnfLoaded = true;                 // standings never resolve offline
  });
}

test('Safest stays in hi-sec when a hi-sec route exists', async ({ window }) => {
  await openMap(window);
  await seedSov(window);
  const r = await window.evaluate(async () => {
    const id = (n) => _systems.find(s => s.name === n).id;
    const lowest = (path) => Math.min(...path.map(i => _sysById[i].sec));
    const a = id('Amarr'), b = id('Jita');
    const safest = _routeDijkstra(a, b, { mode: 'safest' }).path;
    const hiOnly = _routeDijkstra(a, b, { mode: 'shortest', avoidLow: true, avoidNull: true }).path;
    // The star menu's route, the one its toast calls "Safest route".
    _travelStart = a;
    _travelEnd = b;
    await _computeTravelRoute();
    // Not even for an EvE-Scout door at each end: Shortest takes it, Safest does not.
    _whAdj = new Map([[a, [_THERA_ID]], [b, [_THERA_ID]], [_THERA_ID, [a, b]]]);
    const viaThera = (mode) => _routeDijkstra(a, b, { mode, useWormholes: true }).path.includes(_THERA_ID);
    return {
      jumps: safest.length - 1, lowest: lowest(safest), hiOnly: hiOnly.length - 1,
      menuJumps: _routeIds.length - 1, menuLowest: lowest(_routeIds),
      safestDoor: viaThera('safest'), shortestDoor: viaThera('shortest'),
    };
  });
  expect(r.lowest).toBeGreaterThanOrEqual(0.45);
  expect(r.jumps, 'and no longer than a hi-sec route has to be').toBe(r.hiOnly);
  expect(r.menuLowest, 'from the star menu too').toBeGreaterThanOrEqual(0.45);
  expect(r.menuJumps).toBe(r.hiOnly);
  expect(r.safestDoor).toBe(false);
  expect(r.shortestDoor).toBe(true);
});

test('faction low-sec is priced as low-sec, and null-sec keeps its standings prices', async ({ window }) => {
  await openMap(window);
  await seedSov(window);
  const r = await window.evaluate(() => {
    const low = _systems.filter(s => s.sec > 0 && s.sec < 0.45);
    const prices = () => [...new Set(low.map(s => _travelSafetyCost(s)))];
    const claimed = prices();
    const sov = _sovMap;
    _sovMap = {};
    const sovNotLoaded = prices();
    _sovMap = sov;

    _fnfAllianceId = 1001;
    _fnfStandings = { 2005: 5, 2010: 10, 2001: 1, 3005: -5, 3010: -10, 4010: 10 };
    const nul = _systems.find(s => s.name === '1DQ1-A');
    const at = (claim) => {
      _sovMap[nul.id] = claim;
      const empire = _travelSafetyCost(nul, _EMPIRE_TRIP), nullsec = _travelSafetyCost(nul, _NULLSEC_TRIP);
      return empire === nullsec ? empire : `${empire} on an empire trip, ${nullsec} on a null-sec one`;
    };
    const held = (allianceId, corporationId = null) => at({ allianceId, corporationId, factionId: null });
    return {
      claimed, sovNotLoaded, lowCount: low.length,
      table: {
        own: held(1001), blue5: held(2005), blue10: held(2010), blueCorp: held(5000, 4010),
        neutral: held(5000), plus1: held(2001), orange: held(3005), red: held(3010),
        npc: at({ allianceId: null, corporationId: null, factionId: 500010 }),
        unclaimed: at({ allianceId: null, corporationId: null, factionId: null }),
      },
    };
  });
  expect(r.lowCount).toBeGreaterThan(600);
  expect(r.claimed, 'one price for all of low-sec').toEqual([3]);
  expect(r.sovNotLoaded, 'and sov has no say in it').toEqual([3]);
  expect(r.table).toEqual({
    own: 1, blue5: 2, blue10: 2, blueCorp: 2,
    neutral: 6, plus1: 6, orange: 50, red: 100, npc: 6, unclaimed: 6,
  });
});

test('Safest leaves hi-sec only when it has to, and then for as few systems as it can', async ({ window }) => {
  await openMap(window);
  await seedSov(window);
  const r = await window.evaluate(() => {
    _ensureGateAdj();
    // What the game's Safer minimises: a low-sec system counts 1, null-sec 2.
    const exposure = (id) => { const sec = _sysById[id].sec; return sec >= 0.45 ? 0 : sec > 0 ? 1 : 2; };
    const least = (a, b) => {
      const best = new Map([[a, 0]]), heap = _mapHeap();
      heap.push(0, a);
      while (heap.size()) {
        const [d, id] = heap.pop();
        if (id === b) return d;
        if (d > best.get(id)) continue;
        for (const to of _gateAdj.get(id) || []) {
          const nd = d + exposure(to);
          if (!best.has(to) || nd < best.get(to)) { best.set(to, nd); heap.push(nd, to); }
        }
      }
      return null;
    };
    const list = _systems.filter(s => s.id < 31000000);
    const wrong = [];
    let tried = 0;
    for (let i = 0; i < 120; i++) {
      const a = list[(i * 211 + 7) % list.length], b = list[(i * 677 + 13) % list.length];
      if (a.id === b.id || (a.sec <= 0 && b.sec <= 0)) continue;
      tried++;
      const want = least(a.id, b.id);
      const route = _routeDijkstra(a.id, b.id, { mode: 'safest' });
      const have = route ? route.path.slice(1).reduce((t, id) => t + exposure(id), 0) : null;
      if (have !== want) wrong.push(`${a.name} to ${b.name}: ${have}, could be ${want}`);
    }
    return { tried, wrong };
  });
  expect(r.tried).toBeGreaterThan(50);
  expect(r.wrong).toEqual([]);
});

test('a destination only reachable through low-sec still gets a route', async ({ window }) => {
  await openMap(window);
  await seedSov(window);
  const r = await window.evaluate(() => {
    const id = (n) => _systems.find(s => s.name === n).id;
    const a = id('Jita'), pocket = id('Boystin');
    const route = _routeDijkstra(a, pocket, { mode: 'safest' }).path;
    const rancer = _routeDijkstra(id('Amarr'), id('Rancer'), { mode: 'safest' }).path;
    return {
      hiOnly: _routeDijkstra(a, pocket, { mode: 'safest', avoidLow: true, avoidNull: true }),
      lowest: Math.min(...route.map(i => _sysById[i].sec)),
      avoidRed: !!_routeDijkstra(a, pocket, { mode: 'safest', avoidRed: true }),
      rancerLow: rancer.filter(i => _sysById[i].sec < 0.45).map(i => _sysById[i].name),
    };
  });
  expect(r.hiOnly, 'Boystin is a hi-sec pocket with no hi-sec way in').toBe(null);
  expect(r.lowest, 'through low-sec, not the shorter way through null-sec').toBeGreaterThan(0);
  expect(r.avoidRed, 'low-sec is not red').toBe(true);
  // A low-sec destination is no licence to cut through low-sec on the way there.
  expect(r.rancerLow).not.toContain('Ahbazon');
  expect(r.rancerLow).toContain('Rancer');
});

test('a trip between two null-sec systems stays in your own sov', async ({ window }) => {
  // Priced like an empire trip, this one goes 41 jumps round through hi-sec.
  await openMap(window);
  await seedSov(window);
  const r = await window.evaluate(() => {
    const id = (n) => _systems.find(s => s.name === n).id;
    for (const s of _systems) {
      if (s.sec <= 0 && _regions[s.regionId] === 'Geminate') {
        _sovMap[s.id] = { allianceId: 1001, corporationId: 1002, factionId: null, isCapital: false };
      }
    }
    _fnfAllianceId = 1001;
    const path = _routeDijkstra(id('YN3-E3'), id('BWF-ZZ'), { mode: 'safest' }).path;
    return { jumps: path.length - 1, own: path.filter(i => _sovMap[i].allianceId === 1001).length };
  });
  expect(r.own, 'every system on it yours').toBe(r.jumps + 1);
  expect(r.jumps).toBeLessThan(20);
});

test('Shortest is still the fewest jumps, low-sec or not', async ({ window }) => {
  await openMap(window);
  await seedSov(window);
  const r = await window.evaluate(() => {
    _ensureGateAdj();
    const id = (n) => _systems.find(s => s.name === n).id;
    const bfs = (a, b) => {
      const seen = new Map([[a, 0]]), queue = [a];
      for (let i = 0; i < queue.length; i++) {
        if (queue[i] === b) return seen.get(b);
        for (const to of _gateAdj.get(queue[i]) || []) {
          if (!seen.has(to)) { seen.set(to, seen.get(queue[i]) + 1); queue.push(to); }
        }
      }
      return null;
    };
    const list = _systems.filter(s => s.id < 31000000);
    const wrong = [];
    for (let i = 0; i < 40; i++) {
      const a = list[(i * 211 + 7) % list.length], b = list[(i * 677 + 13) % list.length];
      if (a.id === b.id) continue;
      const route = _routeDijkstra(a.id, b.id, { mode: 'shortest' });
      const have = route ? route.path.length - 1 : null, want = bfs(a.id, b.id);
      if (have !== want) wrong.push(`${a.name} to ${b.name}: ${have}, could be ${want}`);
    }
    const path = _routeDijkstra(id('Amarr'), id('Jita'), { mode: 'shortest' }).path;
    return {
      wrong, jumps: path.length - 1, cost: _pathCost(path, { mode: 'shortest' }),
      via: path.filter(i => _sysById[i].sec < 0.45).map(i => _sysById[i].name),
      avoidRedJumps: _routeDijkstra(id('Amarr'), id('Jita'), { mode: 'shortest', avoidRed: true }).path.length - 1,
    };
  });
  expect(r.wrong).toEqual([]);
  expect(r.jumps, 'the game\'s Shorter says the same').toBe(11);
  expect(r.via).toEqual(['Ahbazon']);
  expect(r.cost).toBe(11);
  expect(r.avoidRedJumps, 'avoiding red does not bar low-sec').toBe(11);
});

test('the planner\'s alternatives are priced the same way', async ({ window }) => {
  await openMap(window);
  await seedSov(window);
  const r = await window.evaluate(() => {
    const id = (n) => _systems.find(s => s.name === n).id;
    const a = id('Amarr'), b = id('Jita');
    const routes = _kShortestRoutes(a, b, { mode: 'safest' }, 3);

    // Null-sec to null-sec by way of empire: _pathCost must price it as that trip.
    const nullTrip = _routeDijkstra(id('HED-GP'), id('PF-346'), { mode: 'safest' });

    // A spur starting out in null-sec is still part of a trip from Jita. No route
    // on today's map shows the difference, so this watches what the spurs are told.
    const told = new Set();
    const dijkstra = _routeDijkstra;
    _routeDijkstra = (from, to, opts, ...rest) => { told.add(opts.prices); return dijkstra(from, to, opts, ...rest); };
    _kShortestRoutes(id('Jita'), id('1DQ1-A'), { mode: 'safest' }, 2);
    _routeDijkstra = dijkstra;

    return {
      paths: routes.map(x => x.path.join()),
      first: dijkstra(a, b, { mode: 'safest' }).path.join(),
      lowest: routes.map(x => Math.min(...x.path.map(i => _sysById[i].sec))),
      costs: routes.map(x => x.cost),
      priced: routes.map(x => _pathCost(x.path, { mode: 'safest' })),
      nullCost: nullTrip.cost,
      nullPriced: _pathCost(nullTrip.path, { mode: 'safest' }),
      spursPricedAsTheTrip: told.size === 1 && told.has(_EMPIRE_TRIP),
    };
  });
  expect(new Set(r.paths).size, 'three different routes').toBe(3);
  expect(r.paths[0], 'the plotted route first').toBe(r.first);
  for (const sec of r.lowest) expect(sec, 'all three in hi-sec').toBeGreaterThanOrEqual(0.45);
  r.costs.forEach((c, i) => expect(c).toBeCloseTo(r.priced[i], 6));
  expect(r.costs).toEqual([...r.costs].sort((x, y) => x - y));
  expect(r.nullPriced).toBeCloseTo(r.nullCost, 6);
  expect(r.spursPricedAsTheTrip).toBe(true);
});

test('the Stargate Planner shows hi-sec on Safest and the low-sec hop on Shortest, neither as red', async ({ window }) => {
  await openMap(window);
  await seedSov(window);
  await window.evaluate(() => openStargatePlanner());
  await expect(window.locator('#sgNote')).toContainText('stays in hi-sec whenever it can');
  await window.locator('#sgFrom').fill('Amarr');
  await window.locator('#sgTo').fill('Jita');
  await window.evaluate(() => _sgPlot());

  const result = window.locator('#sgResult');
  await expect(result.locator('.jp-banner')).toContainText('Safest route');
  await expect(result.locator('.map-mark-lowsec')).toHaveCount(0);
  await expect(result.locator('.map-mark-red')).toHaveCount(0);

  await window.locator('#sgMode').selectOption('shortest');
  await window.evaluate(() => _sgPlot());
  await expect(result.locator('.jp-banner')).toContainText('Shortest route');
  await expect(result.locator('.jp-tot-num').first()).toHaveText('11');
  await expect(result.locator('.map-mark-lowsec')).toHaveText('1');
  await expect(result.locator('.map-mark-red')).toHaveCount(0);
});
