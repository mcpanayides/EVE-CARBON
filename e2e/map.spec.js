// The map page's own spec — navigation.spec.js deliberately skips it because
// the page is fetched at runtime from page-map.html rather than living in the
// static SPA shell, so it takes a different code path from every other page.
//
// That gap has bitten before: a stray token in map.js threw at module load and
// killed the whole map, and both the linter and the nav smoke test passed. The
// first test here is that floor-level check for the map specifically.
//
// The rest cover the Modern galaxy layout's caching: it costs ~1.6s to compute,
// so it's computed once per SDE version and read from disk thereafter (see
// _persistModernLayout in src/func/map.js and src/ipc/map_ipc.js).
const fs   = require('fs');
const path = require('path');
const { test, expect } = require('./support/electron-app');


async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#page-map')).toBeVisible({ timeout: 15_000 });
  // The galaxy comes from a local SQLite read plus the layout build; wait for
  // the page's own ready state rather than a fixed sleep.
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  // Visible is not the same as settled. The page change runs as a view
  // transition, and while that is live its overlay covers the page, so
  // elementFromPoint returns <html> for every point on it. The map is the
  // heaviest page to open, so under load its fade was often still running when
  // the dropdown probe below measured — which is why that test passed alone and
  // failed in a full run, and failed outright on the release runner.
  await window.evaluate(() => _navSettled);
}

test('map page opens and stays error-free', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));
  window.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (/Failed to load resource/.test(msg.text())) return;   // fixture's ESI token is deliberately invalid
    errors.push(msg.text());
  });

  await openMap(window);
  await window.waitForTimeout(2000);   // let the layout build and first paint settle

  expect(errors, `console/page errors on map: ${errors.join(' | ')}`).toEqual([]);
});

// What this has always guarded is that every install draws the SAME galaxy
// from a shipped source, rather than each one running the algorithm and
// landing somewhere slightly different.
//
// The source changed. CCP publishes the schematic layout itself
// (mapSolarSystems.position2D) and the map now prefers it, so the bundled
// curated file has become the fallback for an install whose SDE predates it.
// Either is acceptable here; the algorithm is not.
const LAYOUT_SOURCE = /modern layout from CCP position2D \((\d+) systems|using CUSTOM saved layout.*?\((\d+) systems/;

test('the galaxy is drawn from a shipped layout, not computed', async ({ window }) => {
  const logs = [];
  window.on('console', (msg) => logs.push(msg.text()));

  await openMap(window);
  await expect
    .poll(() => logs.some(l => LAYOUT_SOURCE.test(l)), { timeout: 25_000 })
    .toBe(true);

  // …and it is the whole galaxy, not a partial source that happened to load.
  const line = logs.find(l => LAYOUT_SOURCE.test(l)) || '';
  const m = LAYOUT_SOURCE.exec(line) || [];
  const n = Number(m[1] || m[2] || 0);
  expect(n, `layout should cover k-space, got: ${line}`).toBeGreaterThan(5000);
});

test('the algorithm does not run when a curated layout is present', async ({ window }) => {
  // The build costs ~1.6s of the renderer's only thread. With a curated layout
  // shipped there is no reason to ever pay it, so a real build here means the
  // shipped file was not found or was outranked.
  const logs = [];
  window.on('console', (msg) => logs.push(msg.text()));

  await openMap(window);
  await window.waitForTimeout(3000);

  // A ResizeObserver can fire before the layout loads and logs a harmless
  // "built in 0ms (0 systems)" for a build that produced nothing. What must not
  // happen is a build that actually laid systems out.
  const realBuilds = logs
    .map(l => /modern layout built in \d+ms \((\d+) systems\)/.exec(l))
    .filter(m => m && Number(m[1]) > 0);
  expect(realBuilds, 'the layout was rebuilt despite a curated layout shipping').toEqual([]);
});

// The system-search dropdown hangs out of .page-header, which the shared style
// clips with `overflow: hidden` — so the list was cut off at the header's edge
// and read as if the map were drawn over it. Reported 2026-08-21. Asserted by
// hit-testing rather than by reading CSS: what matters is that a click below
// the header lands on the dropdown and not on the canvas.
test('the system-search dropdown is not clipped or covered by the map', async ({ window }) => {
  await openMap(window);

  await window.locator('#mapSearchInput').fill('c-j');
  const results = window.locator('#mapSearchResults');
  await expect(results).toBeVisible({ timeout: 10_000 });
  await expect(results.locator('.map-search-item').first()).toBeVisible({ timeout: 10_000 });

  const probe = await window.evaluate(() => {
    const header = document.querySelector('#page-map .page-header');
    const list   = document.querySelector('#mapSearchResults');
    const h = header.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    // A point inside the list and BELOW the header — the region that used to be
    // clipped away and, once unclipped, would still be painted over by canvas.
    const y = Math.min(l.bottom - 4, h.bottom + 8);
    const el = document.elementFromPoint(l.left + l.width / 2, y);
    return {
      listHeight: l.height,
      extendsBelowHeader: l.bottom > h.bottom + 4,
      headerOverflow: getComputedStyle(header).overflow,
      hitId: el ? (el.closest('#mapSearchResults') ? 'mapSearchResults' : (el.id || el.tagName)) : null,
    };
  });

  expect(probe.headerOverflow, 'the map header must let the dropdown out').not.toBe('hidden');
  expect(probe.listHeight, 'the dropdown should have real height').toBeGreaterThan(10);
  expect(probe.extendsBelowHeader, 'the dropdown should hang below the header').toBe(true);
  expect(probe.hitId, 'a point inside the dropdown must hit the dropdown, not the canvas').toBe('mapSearchResults');
});

test('a slow sovereignty answer never paints over newer data', async ({ electronApp, window }) => {
  // ESI can drag. The map's first load can then land after a poll that started
  // later - or after data a test has put in place - and must not paint the
  // older picture back over it. Staged exactly: the main process holds its
  // answer until newer data is already in.
  await openMap(window);
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('map-get-sovereignty');
    ipcMain.handle('map-get-sovereignty', () => new Promise(res => { global.__sovAnswer = res; }));
  });
  await window.evaluate(() => { window.__pending = _loadLiveData({ sov: true, inc: false }); });
  await window.waitForTimeout(20);
  await window.evaluate(() => {
    window.__newer = { 30000142: { allianceId: 7, isCapital: false } };
    _sovMap = window.__newer; _sovAt = Date.now();
  });
  await electronApp.evaluate(() => global.__sovAnswer({ 30000142: { allianceId: 1, isCapital: false } }));
  const kept = await window.evaluate(async () => { await window.__pending; return _sovMap === window.__newer; });
  expect(kept, 'the newer sovereignty survives the late answer').toBe(true);
});
