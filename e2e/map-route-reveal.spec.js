// A newly plotted route draws itself in, hop by hop from its start - about
// 1.2 s a hop, never more than 15 s in all - on a layer of its own over the map,
// and lands on the map when it is done.
//
// Where a frame has to be pinned down the tests move a reveal's start back and
// draw; where what matters is whether it plays at all, they watch the real one.
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
  await window.evaluate(() => {
    document.body.classList.remove('app-unfocused');   // watched: routes draw in
    _viewMode = 'spatial'; _camFlat = false; _fitSpatial(); _render();
  });
}

/** A gate route by name, shortest, no bridges. */
function gateRoute(window, from, to) {
  return window.evaluate(([from, to]) => {
    const a = _systems.find(s => s.name === from), b = _systems.find(s => s.name === to);
    return _routeDijkstra(a.id, b.id, { mode: 'shortest', useBridges: false }).path;
  }, [from, to]);
}

/** Put a reveal `f` of the way through its own length, and draw that frame. */
function revealAt(window, kind, f) {
  return window.evaluate(([kind, f]) => {
    const r = _routeReveal[kind];
    r.start = performance.now() - r.total * f;
    _rtDraw();
  }, [kind, f]);
}

/** How much of the reveal layer is lit within a few px of a system. */
function litNear(window, id) {
  return window.evaluate((id) => {
    const c = _routeDraw.toCanvas(id);
    if (!c) return -1;
    const d = _rtCtx.getImageData(Math.round(c[0]) - 3, Math.round(c[1]) - 3, 7, 7).data;
    let a = 0;
    for (let i = 3; i < d.length; i += 4) a += d[i];
    return a;
  }, id);
}

/** Pixels of route blue (96,200,255) on the map canvas itself. */
function mapBlue(window) {
  return window.evaluate(() => {
    const d = _ctx.getImageData(0, 0, _canvas.width, _canvas.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 96) < 30 && Math.abs(d[i + 1] - 200) < 30 && d[i + 2] > 225) n++;
    }
    return n;
  });
}

test('a route draws itself in from its start, hop by hop, and then lands on the map', async ({ window }) => {
  await openMap(window);
  const path = await gateRoute(window, 'C-J6MT', 'JDAS-0');
  expect(path.length).toBeGreaterThan(10);
  const before = await mapBlue(window);
  await window.evaluate((p) => window.mapShowRoute(p), path);
  const r = await window.evaluate(() => ({ revealing: _revealing('gate'), total: _routeReveal.gate && _routeReveal.gate.total }));
  expect(r.revealing, 'drawing in').toBe(true);
  expect(r.total).toBeCloseTo(await window.evaluate((n) => RouteReveal.durationMs(n), path.length - 1), 6);

  // A third of the way: the start is lit, the destination not yet; the map
  // itself holds the line back, showing only the ends.
  await window.evaluate(() => _render());
  await revealAt(window, 'gate', 0.33);
  expect(await litNear(window, path[1]), 'reached').toBeGreaterThan(0);
  expect(await litNear(window, path[path.length - 2]), 'not yet').toBe(0);
  const during = await mapBlue(window) - before;    // the map: only the start and end rings and names

  // Two thirds: further along.
  await revealAt(window, 'gate', 0.66);
  expect(await litNear(window, path[Math.floor(path.length * 0.55)]), 'reached by now').toBeGreaterThan(0);

  // Done: it lands - the map takes the route back, and the layer clears once the
  // destination's ring has faded.
  await revealAt(window, 'gate', 1.01);
  await expect.poll(() => window.evaluate(() => _revealing('gate')), 'landed').toBe(false);
  await window.evaluate(() => _render());
  const after = await mapBlue(window) - before;
  expect(after, 'the whole route, on the map').toBeGreaterThan(1000);
  expect(during, `the map held the line back while it drew in: ${during} px against ${after}`).toBeLessThan(after * 0.3);
  await expect.poll(() => window.evaluate(() => _routeReveal.gate), { timeout: 3000 }).toBe(null);
});

test('it keeps the pace of a hop on a short route, and never takes more than 15 s', async ({ window }) => {
  await openMap(window);
  const short = await gateRoute(window, 'Jita', 'Perimeter');
  const long = await gateRoute(window, '1DQ1-A', 'Jita');
  const total = (p) => window.evaluate((p) => { window.mapShowRoute(p, [], false); return _routeReveal.gate.total; }, p);
  const s = await total(short), l = await total(long);
  expect(short.length - 1).toBe(1);
  expect(s, 'one hop: about 1.2 s').toBeGreaterThan(1000);
  expect(s).toBeLessThan(1300);
  expect(long.length - 1, '1DQ1-A to Jita by gates').toBeGreaterThan(30);
  expect(l, `${long.length - 1} jumps`).toBeGreaterThan(12000);
  expect(l, 'never more than 15 s').toBeLessThanOrEqual(15000);
});

test('a capital jump route grows along its own arcs', async ({ window }) => {
  await openMap(window);
  const ids = await window.evaluate(() => {
    const names = ['1DQ1-A', 'T5ZI-S', 'GE-8JV', 'B-3QPD'];
    return names.map(n => _systems.find(s => s.name === n).id);
  });
  await window.evaluate((ids) => { window.mapShowJumpRoute(ids, [], false); _render(); }, ids);
  expect(await window.evaluate(() => _revealing('jump'))).toBe(true);
  await revealAt(window, 'jump', 0.5);
  // Halfway through three hops: the first is made, the last not begun. The
  // arc between them is pink on the layer where the map would draw it.
  expect(await litNear(window, ids[1]), 'first hop made').toBeGreaterThan(0);
  expect(await litNear(window, ids[3]), 'last not begun').toBe(0);
  const onArc = await window.evaluate((ids) => {
    const a = _routeDraw.toCanvas(ids[0]), b = _routeDraw.toCanvas(ids[1]);
    const [cx, cy] = RouteReveal.jumpArc(a[0], a[1], b[0], b[1]);
    const x = 0.25 * a[0] + 0.5 * cx + 0.25 * b[0], y = 0.25 * a[1] + 0.5 * cy + 0.25 * b[1];   // the arc's midpoint
    const d = _rtCtx.getImageData(Math.round(x) - 2, Math.round(y) - 2, 5, 5).data;
    let pink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100 && d[i] > 200 && d[i + 1] < 160) pink++;
    return pink;
  }, ids);
  expect(onArc, 'pink on the arc itself').toBeGreaterThan(0);
});

test('behind an open planner the route just goes down; closing the planner draws it in', async ({ window }) => {
  await openMap(window);
  const path = await gateRoute(window, 'C-J6MT', 'JDAS-0');

  await window.evaluate(() => openStargatePlanner());
  await expect(window.locator('#stargatePlannerModal')).toBeVisible();
  await window.evaluate((p) => window.mapShowRoute(p, [], false), path);
  expect(await window.evaluate(() => _routeReveal.gate), 'no one could see it').toBe(null);
  await window.evaluate((p) => { _sgLastPath = p; }, path);
  await window.locator('#stargatePlannerModal .sg-close').click();
  expect(await window.evaluate(() => _revealing('gate')), 'closed: it draws in').toBe(true);

  // The Jump Planner keeps its route on the map behind it; closing reveals it.
  const ids = await window.evaluate(() => ['1DQ1-A', 'T5ZI-S'].map(n => _systems.find(s => s.name === n).id));
  await window.evaluate(() => openJumpPlanner());
  await expect(window.locator('#jumpPlannerModal')).toBeVisible();
  await window.evaluate((ids) => window.mapShowJumpRoute(ids, [], false), ids);
  expect(await window.evaluate(() => _routeReveal.jump), 'behind the planner').toBe(null);
  await window.locator('#jumpPlannerModal .jp-close').click();
  expect(await window.evaluate(() => _revealing('jump')), 'closed: it draws in').toBe(true);
});

test('plotted from a star\'s menu, the route draws in', async ({ window }) => {
  await openMap(window);
  await window.evaluate(async () => {
    _travelStart = _systems.find(s => s.name === 'C-J6MT').id;
    _travelEnd = _systems.find(s => s.name === 'JDAS-0').id;
    await _computeTravelRoute();
  });
  expect(await window.evaluate(() => _revealing('gate'))).toBe(true);
});

test('unwatched or with motion reduced it just goes down, and losing focus finishes one', async ({ window }) => {
  await openMap(window);
  const path = await gateRoute(window, 'C-J6MT', 'JDAS-0');

  await window.emulateMedia({ reducedMotion: 'reduce' });
  await window.evaluate((p) => window.mapShowRoute(p), path);
  expect(await window.evaluate(() => _routeReveal.gate), 'reduced motion: no reveal').toBe(null);
  await window.emulateMedia({ reducedMotion: 'no-preference' });

  await window.evaluate((p) => window.mapShowRoute(p), path);
  expect(await window.evaluate(() => _revealing('gate'))).toBe(true);
  await window.evaluate(() => document.body.classList.add('app-unfocused'));
  await expect.poll(() => window.evaluate(() => _routeReveal.gate), 'blurred: finished at once').toBe(null);
  await window.evaluate(() => _render());
  expect(await mapBlue(window), 'and the whole route is on the map').toBeGreaterThan(1000);
  await expect.poll(() => window.evaluate(() => _rtRaf), 'nothing left running').toBe(0);

  await window.evaluate((p) => window.mapShowRoute(p), path);
  expect(await window.evaluate(() => _routeReveal.gate), 'unfocused from the start: no reveal').toBe(null);
});

test('the Schematic draws a route in too, and clearing it mid-way leaves nothing drawing', async ({ window }) => {
  await openMap(window);
  const path = await gateRoute(window, 'C-J6MT', 'JDAS-0');
  await window.locator('.map-view-btn[data-view="modern"]').click();
  await window.waitForTimeout(300);
  await window.evaluate((p) => { window.mapShowRoute(p); _render(); }, path);
  expect(await window.evaluate(() => _revealing('gate'))).toBe(true);
  await revealAt(window, 'gate', 0.5);
  expect(await litNear(window, path[1]), 'drawn in on the Schematic').toBeGreaterThan(0);

  // Right-click > Clear routes, mid-reveal.
  await window.evaluate(() => { _routeIds = null; _render(); });
  await expect.poll(() => window.evaluate(() => _routeReveal.gate)).toBe(null);
  const empty = await window.evaluate(() => {
    const d = _rtCtx.getImageData(0, 0, _rtCv.width, _rtCv.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  });
  expect(empty, 'the layer is clear').toBe(true);
});
