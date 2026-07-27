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

test('fitting ship browser mirrors the in-game market tree (with group icons)', async ({ window }) => {
  await window.locator('.fc-sub-btn[data-fc-tab="fitting"]').click();
  await expect(window.locator('#fitResults .ft-grp').first()).toBeVisible({ timeout: 15_000 });

  const info = await window.evaluate(() => ({
    top: [...document.querySelectorAll('#fitResults > details.ft-grp > summary .ft-grp-name')].map(s => s.textContent.trim()),
    groupIcons: document.querySelectorAll('#fitResults .ft-grp-icon').length,
  }));
  // Market-group sections, not the old inventory-group "classes".
  expect(info.top).toContain('Battleships');
  expect(info.top).toContain('Special Edition Ships');
  // "Covert Ops" was a top-level class in the old (mis-)grouping; in the market
  // tree it's nested (under Frigates / Special Edition), never a top section.
  expect(info.top).not.toContain('Covert Ops');
  expect(info.groupIcons).toBeGreaterThan(0);   // group rows now carry icons
});

test('Chremoas is filed under Special Edition Ships, not Covert Ops', async ({ window }) => {
  await window.locator('.fc-sub-btn[data-fc-tab="fitting"]').click();
  await expect(window.locator('#fitResults .ft-grp').first()).toBeVisible({ timeout: 15_000 });

  await window.locator('details.ft-grp > summary', { hasText: 'Special Edition Ships' }).first().click();
  await window.locator('details.ft-grp > summary', { hasText: 'Special Edition Covert Ops' }).first().click();
  await expect(window.locator('#fitResults .fit-result[data-name="Chremoas"]')).toBeVisible({ timeout: 10_000 });
});
