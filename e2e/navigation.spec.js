// Baseline smoke test: the app launches, every real nav page opens without
// throwing, and no page leaves stray console errors behind. This is the cheap
// floor-level check that catches the most common break — a renamed element ID,
// a null-deref in a page's init function, a broken onclick handler — across
// the WHOLE app in one pass, independent of the deeper per-page specs.
const { test, expect } = require('./support/electron-app');

// Pages with a static #page-{name} container (see src/func/ui.js navigateToPage).
// 'map' is excluded: it's fetched at runtime from page-map.html, a different
// code path from the rest of the SPA — worth its own spec later.
const PAGES = ['dashboard', 'industry', 'wallets', 'assets', 'pi', 'fc', 'calendar', 'characters'];

test('app launches to the dashboard', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
});

for (const page of PAGES) {
  test(`nav: ${page} page opens and stays error-free`, async ({ window }) => {
    // pageerror = uncaught JS exceptions (real bugs). Console 'error' also
    // fires for plain failed network requests, which the fixture EXPECTS —
    // its ESI token is deliberately invalid, so live-data widgets legitimately
    // 400/401/404 and Chromium logs that as a console error. Only flag console
    // errors that aren't that noise (e.g. the app's own console.error(...) calls).
    const errors = [];
    window.on('pageerror', (e) => errors.push(e.message));
    window.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (/Failed to load resource/.test(msg.text())) return;
      errors.push(msg.text());
    });

    await window.locator(`.nav-btn[data-page="${page}"]`).click();
    await expect(window.locator(`#page-${page}`)).toBeVisible();
    await expect(window.locator(`#page-${page}`)).toHaveClass(/active/);

    // Let first-visit async init (SDE queries, DB reads) settle before judging.
    await window.waitForTimeout(1000);

    expect(errors, `console/page errors on ${page}: ${errors.join(' | ')}`).toEqual([]);
  });
}

// ── Online counter and its version tooltip ───────────────────────────────────
// The counter is fed by the main-process heartbeat, which beats ten seconds
// after launch — too slow to wait for here — so the renderer half is driven
// directly. That is the half that was changed; the worker half has its own unit
// tests against the deployed source.
test('the online counter shows a per-version tooltip, newest first', async ({ window }) => {
  const state = await window.evaluate(() => {
    _updatePresenceCount({
      count: 61,
      versions: { '4.0.0': 19, '3.7.0': 12, '3.3.0': 23, '3.0.0': 5, unknown: 2 },
    });
    const wrap = document.getElementById('presenceStatus');
    return {
      label: document.getElementById('presenceCountLabel').textContent,
      visible: wrap.style.display,
      title: wrap.title,
    };
  });

  expect(state.label).toBe('61 ONLINE');
  expect(state.visible).toBe('inline-flex');
  // Three newest releases named, everything older plus unknown folded together.
  expect(state.title).toContain('4.0.0 — 19 users');
  expect(state.title).toContain('3.7.0 — 12 users');
  expect(state.title).toContain('3.3.0 — 23 users');
  expect(state.title).toContain('Other — 7 users');
  expect(state.title).not.toContain('3.0.0');
  expect(state.title).not.toContain('unknown');
});

test('the counter still works when the worker sends no version breakdown', async ({ window }) => {
  // An older worker, or a client talking to one, answers with a count alone.
  const state = await window.evaluate(() => {
    _updatePresenceCount({ count: 3, versions: null });
    const wrap = document.getElementById('presenceStatus');
    return { label: document.getElementById('presenceCountLabel').textContent, title: wrap.title };
  });
  expect(state.label).toBe('3 ONLINE');
  expect(state.title).toContain('3 running EVE Carbon right now');
});

test('a bare number is still accepted, so a stale renderer never blanks the counter', async ({ window }) => {
  const label = await window.evaluate(() => {
    _updatePresenceCount(7);
    return document.getElementById('presenceCountLabel').textContent;
  });
  expect(label).toBe('7 ONLINE');
});

test('the counter hides when the count is unknown', async ({ window }) => {
  const display = await window.evaluate(() => {
    _updatePresenceCount({ count: null, versions: null });
    return document.getElementById('presenceStatus').style.display;
  });
  expect(display).toBe('none');
});
