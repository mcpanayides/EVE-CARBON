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

test('the shipped curated layout is what gets drawn', async ({ window }) => {
  // The curated layout used to live only in one machine's user-data directory,
  // so every other install fell back to the algorithm and drew a noticeably
  // more spread-out galaxy. It now ships with the app and outranks both the
  // auto-cache and the algorithm, which is what makes every install identical.
  const logs = [];
  window.on('console', (msg) => logs.push(msg.text()));

  await openMap(window);
  await expect
    .poll(() => logs.some(l => /using CUSTOM saved layout/.test(l)), { timeout: 25_000 })
    .toBe(true);

  // …and it is the whole galaxy, not a partial file that happened to load.
  const line = logs.find(l => /using CUSTOM saved layout/.test(l)) || '';
  const n = Number((/\((\d+) systems/.exec(line) || [])[1] || 0);
  expect(n, `curated layout should cover k-space, got: ${line}`).toBeGreaterThan(5000);
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
