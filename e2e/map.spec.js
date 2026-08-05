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
const { _electron: electron } = require('playwright');
const { test, expect } = require('./support/electron-app');

const AUTO_CACHE = 'modern-map-layout.auto.json';

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#page-map')).toBeVisible({ timeout: 15_000 });
  // The galaxy comes from a local SQLite read plus the layout build; wait for
  // the page's own ready state rather than a fixed sleep.
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
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

test('modern view lays out the galaxy and caches the result', async ({ window, profile }) => {
  const logs = [];
  window.on('console', (msg) => logs.push(msg.text()));

  await openMap(window);
  // The cache write is fire-and-forget after the build, so poll for the file
  // rather than assuming it has landed.
  const cachePath = path.join(profile.userDataDir, AUTO_CACHE);
  await expect.poll(() => fs.existsSync(cachePath), { timeout: 25_000 }).toBe(true);

  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  // New Eden is ~5 200 k-space systems; a layout with far fewer means regions
  // were dropped somewhere between the SDE read and the cache write.
  expect(Object.keys(saved.systems).length).toBeGreaterThan(5000);
  expect(saved.sdeVersion, 'cache must record which SDE it was built from').toBeTruthy();
  expect(saved.algo, 'cache must record which layout algorithm built it').toBeGreaterThan(0);
  expect(Array.isArray(saved.labels) && saved.labels.length).toBeGreaterThan(50);

  // Every position must be a real pair of finite numbers — a NaN here renders
  // as an invisible system rather than an error.
  for (const [id, xz] of Object.entries(saved.systems).slice(0, 200)) {
    expect(Array.isArray(xz) && xz.length === 2, `system ${id} has a malformed position`).toBe(true);
    expect(Number.isFinite(xz[0]) && Number.isFinite(xz[1]), `system ${id} has a non-finite position`).toBe(true);
  }
});

test('a second launch reuses the cached layout instead of rebuilding', async ({ electronApp, window, profile }) => {
  // First launch: build + cache.
  await openMap(window);
  const cachePath = path.join(profile.userDataDir, AUTO_CACHE);
  await expect.poll(() => fs.existsSync(cachePath), { timeout: 25_000 }).toBe(true);
  const first = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

  // The app takes a single-instance lock, so the first one has to go before a
  // second can start against the same profile. (Closing it here is safe — the
  // fixture's own teardown close() is tolerant of an already-closed app.)
  await electronApp.close().catch(() => {});

  // Second launch against the SAME profile — this is the run every user gets
  // after their first, and the one that must not spend 1.6s laying out again.
  const app2 = await electron.launch({ args: profile.args, env: profile.childEnv });
  try {
    const w2 = await app2.firstWindow();
    await w2.waitForLoadState('domcontentloaded');
    const logs = [];
    w2.on('console', (msg) => logs.push(msg.text()));

    await openMap(w2);
    await expect
      .poll(() => logs.some(l => /using CACHED saved layout/.test(l)), { timeout: 20_000 })
      .toBe(true);

    // And it must not have rebuilt. Matching "built in" alone is too broad and
    // races: a ResizeObserver can fire before the cached layout has finished
    // loading, and that call logs a harmless "built in 0ms (0 systems)" for a
    // build that produced nothing and was neither kept nor cached. What must
    // not happen is a build that actually laid systems out.
    const realBuilds = logs
      .map(l => /modern layout built in \d+ms \((\d+) systems\)/.exec(l))
      .filter(m => m && Number(m[1]) > 0);
    expect(realBuilds, 'second launch rebuilt the layout instead of reading the cache').toEqual([]);

    // Same map, not merely a fast one.
    const second = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    expect(second.systems).toEqual(first.systems);
  } finally {
    await app2.close().catch(() => {});
  }
});
