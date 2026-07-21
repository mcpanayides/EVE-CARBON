// Fleet Commander page: sub-nav tabs (Composition / Fitting Simulator / Fleet
// Fight Notify) all switch cleanly and stay error-free. Composition needs a
// live fleet to show real data, so this only checks it initializes without
// crashing — not fleet content.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="fc"]').click();
  await expect(window.locator('#page-fc')).toBeVisible({ timeout: 15_000 });
});

test('defaults to the Fleet Composition tab', async ({ window }) => {
  await expect(window.locator('.fc-sub-btn[data-fc-tab="composition"]')).toHaveClass(/active/);
  await expect(window.locator('#fcTabContent')).toBeVisible();
});

test('Fitting Simulator tab loads without crashing', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));
  await window.locator('.fc-sub-btn[data-fc-tab="fitting"]').click();
  await expect(window.locator('.fc-sub-btn[data-fc-tab="fitting"]')).toHaveClass(/active/);
  await window.waitForTimeout(1000);
  expect(errors).toEqual([]);
});

test('Fleet Fight Notify tab embeds the CCP page', async ({ window }) => {
  await window.locator('.fc-sub-btn[data-fc-tab="fleetfight"]').click();
  await expect(window.locator('#fcFleetFightWebview')).toBeVisible({ timeout: 10_000 });
});
