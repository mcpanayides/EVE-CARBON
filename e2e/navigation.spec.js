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
