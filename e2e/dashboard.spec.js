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

// The refresh button is declared in the page markup but _injectPageSpinners()
// moves it into the header's action group at boot — assert where it ends up, not
// where it was written, since a broken move leaves the header with three
// space-between children and the button adrift.
test('refresh button sits in the header action group beside the ✕', async ({ window }) => {
  const actions = window.locator('#page-dashboard .page-header .page-header-actions');
  await expect(actions).toHaveCount(1);
  await expect(actions.locator('#dashboardRefreshBtn')).toBeVisible();
  await expect(actions.locator('.page-spinner')).toBeAttached();
  await expect(actions.locator('.close-page-btn')).toBeVisible();
  // Nothing else may sit loose in the header — the title block and the group only.
  await expect(window.locator('#page-dashboard > .page-header > *')).toHaveCount(2);
});

test('refresh re-renders the dashboard without errors', async ({ window }) => {
  const grid = window.locator('#dashboardGrid');
  await expect(grid.locator('.grid-stack-item')).not.toHaveCount(0);
  const before = await grid.locator('.grid-stack-item').count();

  await window.locator('#dashboardRefreshBtn').click();
  // Re-entrancy guard: a second click while busy must not start another pass.
  await window.locator('#dashboardRefreshBtn').click({ force: true });

  // The button re-enables when the pass finishes, and the widgets survive it —
  // initDashboardGrid() must not rebuild the grid and lose the layout.
  await expect(window.locator('#dashboardRefreshBtn')).toBeEnabled({ timeout: 30_000 });
  await expect(grid.locator('.grid-stack-item')).toHaveCount(before);
});

// Widgets with a `pick` ask what they should show BEFORE being added, so none of
// them carries a dropdown afterwards. Assert the two-step flow, not just the add.
// Job Watch is exercised separately below: its options are live industry jobs,
// which the fixture's invalid token cannot produce.
for (const { menuText, base, heading, option } of [
  { menuText: 'TOP KILLS',       base: 'killTicker', heading: /whose kills/i,     option: FAKE_CHAR_NAME },
  { menuText: 'CHARACTER WALLET', base: 'charWallet', heading: /which character/i, option: FAKE_CHAR_NAME },
]) {
  test(`${base} asks what to show before it is added`, async ({ window }) => {
    await window.locator('.dashboard-add-widget-btn').click();
    const menu = window.locator('#dashboardAddWidgetMenu');
    await expect(menu).toBeVisible();

    // Step one: choosing the widget must NOT put it on the grid yet.
    await menu.locator('.dashboard-add-item', { hasText: menuText }).click();
    await expect(menu.locator('.dashboard-add-heading')).toHaveText(heading);
    await expect(window.locator(`#dashboardGrid [data-widget-base="${base}"]`)).toHaveCount(0);

    // Step two: picking adds exactly one instance, with no picker left on it.
    await menu.locator('.dashboard-add-item', { hasText: option }).click();
    const panel = window.locator(`#dashboardGrid [data-widget-base="${base}"]`);
    await expect(panel).toHaveCount(1);
    await expect(panel.locator('select')).toHaveCount(0);
  });
}

// Job Watch's list is live jobs, which this fixture has none of — the picker must
// say so rather than adding a widget with nothing to watch.
test('job watch picker reports when there is nothing to watch', async ({ window }) => {
  await window.locator('.dashboard-add-widget-btn').click();
  const menu = window.locator('#dashboardAddWidgetMenu');
  await menu.locator('.dashboard-add-item', { hasText: 'JOB WATCH' }).click();
  await expect(menu.locator('.dashboard-add-empty')).toHaveText(/no active industry jobs/i, { timeout: 30_000 });
  await expect(window.locator('#dashboardGrid [data-widget-base="jobWatch"]')).toHaveCount(0);
});

test('top kills widget spans the full grid width', async ({ window }) => {
  await window.locator('.dashboard-add-widget-btn').click();
  const menu = window.locator('#dashboardAddWidgetMenu');
  await menu.locator('.dashboard-add-item', { hasText: 'TOP KILLS' }).click();
  await menu.locator('.dashboard-add-item', { hasText: FAKE_CHAR_NAME }).click();

  // 12 of 12 columns — a marquee in a narrow box loops too fast to read.
  const width = await window.locator('#dashboardGrid [data-widget-base="killTicker"]').evaluate(el => {
    const item = el.closest('.grid-stack-item');
    return item?.gridstackNode?.w ?? Number(item?.getAttribute('gs-w'));
  });
  expect(width).toBe(12);
});

test('net worth widget reflects the seeded wallet snapshot (not stuck loading)', async ({ window }) => {
  const value = window.locator('#welcomeNetWorthValue');
  await expect(value).toBeAttached();
  // Assert on content, not geometry: the figure is computed asynchronously, so
  // confirm it settles to a real ISK value and isn't stuck on the initial
  // "Calculating…" placeholder. (toBeVisible would be flaky here — the banner's
  // width-flexed stat column can collapse to a zero-width box on a narrow
  // window even when the value rendered correctly.)
  await expect(value).not.toContainText('Calculating', { timeout: 20_000 });
  await expect(value).toContainText('ISK', { timeout: 20_000 });
});
