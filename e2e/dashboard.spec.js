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

// The refresh button is injected into the header's action group at boot by
// _injectPageHeaderActions — assert where it ends up, since a broken injection
// leaves the header with three space-between children and the button adrift.
test('refresh button sits in the header action group beside the ✕', async ({ window }) => {
  const actions = window.locator('#page-dashboard .page-header .page-header-actions');
  await expect(actions).toHaveCount(1);
  await expect(actions.locator('.page-refresh-btn')).toBeVisible();
  await expect(actions.locator('.page-spinner')).toBeAttached();
  await expect(actions.locator('.close-page-btn')).toBeVisible();
  // Nothing else may sit loose in the header — the title block and the group only.
  await expect(window.locator('#page-dashboard > .page-header > *')).toHaveCount(2);
});

test('refresh re-renders the dashboard without errors', async ({ window }) => {
  const grid = window.locator('#dashboardGrid');
  await expect(grid.locator('.grid-stack-item')).not.toHaveCount(0);
  const before = await grid.locator('.grid-stack-item').count();

  await window.locator('#page-dashboard .page-refresh-btn').click();
  // Re-entrancy guard: a second click while busy must not start another pass.
  await window.locator('#page-dashboard .page-refresh-btn').click({ force: true });

  // The button re-enables when the pass finishes, and the widgets survive it —
  // initDashboardGrid() must not rebuild the grid and lose the layout.
  await expect(window.locator('#page-dashboard .page-refresh-btn')).toBeEnabled({ timeout: 30_000 });
  await expect(grid.locator('.grid-stack-item')).toHaveCount(before);
});

// Widgets with a `pick` ask what they should show BEFORE being added, so none of
// them carries a dropdown afterwards. Assert the two-step flow, not just the add.
// Job Watch is exercised separately below: its options are live industry jobs,
// which the fixture's invalid token cannot produce.
for (const { menuText, base, heading, option } of [
  { menuText: 'TOP KILLS',       base: 'killTicker', heading: /whose kills/i,     option: FAKE_CHAR_NAME },
  { menuText: 'CHARACTER WALLET', base: 'charWallet', heading: /which character/i, option: FAKE_CHAR_NAME },
  // The Faction Warfare tiles pick from fixed lists — the four leaderboards and
  // the two warzones — so unlike the two above they need no character, no token
  // and no live ESI to offer their options.
  // The killfeed's list is your characters; its corporation search is exercised
  // separately below, since that one talks to ESI.
  { menuText: 'KILLFEED',              base: 'killFeed',  heading: /whose killmails/i,   option: FAKE_CHAR_NAME },
  { menuText: 'FW - TOP PILOTS',       base: 'fwBoard',   heading: /which leaderboard/i, option: 'Victory points · Yesterday' },
  { menuText: 'FW - CAPTURE PRESSURE', base: 'fwSystems', heading: /which warzone/i,     option: 'Both warzones' },
  { menuText: 'FW - WARZONES',         base: 'fwTug',     heading: /which warzone/i,     option: 'Amarr–Minmatar Warzone' },
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

// A `multi` widget that can show different things has to say which one it is
// showing, or two of them side by side are indistinguishable. This is the whole
// job of the registry's `titleOf`.
test('two Faction Warfare tiles of the same kind title themselves apart', async ({ window }) => {
  const addTug = async (option) => {
    await window.locator('.dashboard-add-widget-btn').click();
    const menu = window.locator('#dashboardAddWidgetMenu');
    await menu.locator('.dashboard-add-item', { hasText: 'FW - WARZONES' }).click();
    await menu.locator('.dashboard-add-item', { hasText: option }).click();
  };
  await addTug('Caldari–Gallente Warzone');
  await addTug('Amarr–Minmatar Warzone');

  const titles = window.locator('#dashboardGrid [data-widget-base="fwTug"] .dashboard-widget-title-text');
  await expect(titles).toHaveCount(2);
  const [a, b] = await titles.allTextContents();
  expect(a).not.toBe(b);
  expect([a, b].join('|')).toMatch(/CALDARI/i);
  expect([a, b].join('|')).toMatch(/AMARR/i);
});

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

// ── Blank-widget self-heal ───────────────────────────────────────────────────
// Live-ESI widgets can come back "Failed to load" during the launch burst. The
// repair existed but sat AFTER the stale-character sync loop, so on the path
// where every character was already fresh the function returned before reaching
// it — which is the common case on a restart, and why blank widgets sat there
// until they were removed and re-added by hand.
test('a failed widget is detected and retried, a healthy one is left alone', async ({ window }) => {
  await window.locator('.nav-btn[data-page="dashboard"]').click();
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  const healthy = await window.evaluate(() => {
    let calls = 0;
    window.__origRefresh = refreshDashboardLiveWidgets;
    refreshDashboardLiveWidgets = async () => { calls++; };
    _healFailedDashboardWidgets();          // nothing is marked failed
    return calls;
  });
  expect(healthy, 'a healthy dashboard should not re-fetch anything').toBe(0);

  const repaired = await window.evaluate(() => {
    let calls = 0;
    refreshDashboardLiveWidgets = async () => { calls++; };
    const el = document.createElement('div');
    el.className = 'dash-widget-failed';
    el.textContent = 'Failed to load wallet balances.';
    document.getElementById('dashboardGrid').appendChild(el);
    _healFailedDashboardWidgets();
    el.remove();
    refreshDashboardLiveWidgets = window.__origRefresh;
    return calls;
  });
  expect(repaired, 'a failed widget should have been retried').toBe(1);
});

test('the fresh-characters path reaches the self-heal', async ({ window }) => {
  // The regression this fixes: with no stale characters, autoRefreshStaleCharacters
  // returned early and the repair never ran.
  await window.locator('.nav-btn[data-page="dashboard"]').click();
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 15_000 });

  const healed = await window.evaluate(async () => {
    let called = 0;
    const origHeal = _healFailedDashboardWidgets;
    const origGet  = window.eveAPI.getCharacterData;
    _healFailedDashboardWidgets = () => { called++; };
    // Every character reports as just-synced, so the "all fresh" branch is taken.
    window.eveAPI.getCharacterData = async () => ({ info: { synced_at: Date.now() } });
    try {
      const accounts = await window.eveAPI.getAccounts();
      await autoRefreshStaleCharacters(accounts);
    } finally {
      window.eveAPI.getCharacterData = origGet;
      _healFailedDashboardWidgets = origHeal;
    }
    return called;
  });
  expect(healed, 'the all-fresh path skipped the self-heal').toBe(1);
});
