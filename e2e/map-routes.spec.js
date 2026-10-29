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

  await window.evaluate((p) => { window.mapShowRoute(p); _render(); }, path);
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
  await window.evaluate((p) => { window.mapShowRoute(p); _render(); }, path);
  expect(await routeBlue(window) - before).toBeGreaterThan(300);
});
