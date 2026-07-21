// Dashboard: the widget grid renders, and the seeded local-DB data reaches at
// least one widget. Live-ESI-only widgets (active jobs, skill queue, market
// orders) aren't asserted on content here — the fixture's access token is
// deliberately invalid, so those widgets are expected to show their graceful
// "failed to load" / empty state, not real data (see e2e/fixtures/seed.js).
const { test, expect, FAKE_CHAR_NAME } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });
});

test('widget grid renders with at least one widget', async ({ window }) => {
  const grid = window.locator('#dashboardGrid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('.dashboard-widget, .grid-stack-item')).not.toHaveCount(0);
});

test('welcome banner shows the fixture character name', async ({ window }) => {
  await expect(window.locator('.dashboard-welcome-name')).toContainText(FAKE_CHAR_NAME, { timeout: 15_000 });
});

test('net worth widget reflects the seeded wallet snapshot (not stuck loading)', async ({ window }) => {
  const value = window.locator('#welcomeNetWorthValue');
  await expect(value).toBeVisible();
  // Give the async net-worth calc time to settle, then confirm it isn't stuck
  // on the initial "Calculating…" placeholder forever.
  await expect(value).not.toContainText('Calculating', { timeout: 20_000 });
});
