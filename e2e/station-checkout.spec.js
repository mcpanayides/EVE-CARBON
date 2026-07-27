// Industry → Station Checkout. Diffs a shopping list against on-hand assets at a
// chosen location (read from the local DB — no ESI) and surfaces the missing items
// with copy-to-multibuy and new-list actions. The fixture seeds 50,000 Tritanium
// at Jita, so a list needing more Tritanium + an item held nowhere yields a
// deterministic "missing" result.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="industry"]').click();
  await expect(window.locator('#page-industry')).toBeVisible({ timeout: 15_000 });
  // Seed a shopping list before opening the tool (it needs at least one list).
  await window.evaluate(() => {
    const l = slCreate('Fit Check');
    slAddItems(l.id, [
      { typeId: 34, name: 'Tritanium', qty: 100000 },  // have 50k at Jita → missing 50k
      { typeId: 35, name: 'Pyerite',   qty: 500 },     // have none → missing 500
    ], 'probe');
  });
  await window.locator('.industry-sub-btn[data-industry-tab="station-checkout"]').click();
});

test('lists the location and shows the missing items with quantities', async ({ window }) => {
  await expect(window.locator('#scLoc')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#scLoc')).toContainText('Jita');

  const result = window.locator('#scResult');
  await expect(result).toContainText('2 of 2 items missing', { timeout: 15_000 });
  await expect(result).toContainText('50,000');   // Tritanium shortfall
  await expect(result).toContainText('500');      // Pyerite shortfall
});

test('"new list from missing" creates a shopping list from the shortfall', async ({ window }) => {
  await expect(window.locator('#scListBtn')).toBeVisible({ timeout: 15_000 });
  const before = await window.evaluate(() => slGetAll().length);
  await window.locator('#scListBtn').click();
  await expect(window.locator('#centerToast')).toContainText('Created', { timeout: 5_000 });
  const after = await window.evaluate(() => slGetAll().length);
  expect(after).toBe(before + 1);
});

test('"copy missing to multibuy" fires a centered confirmation', async ({ window }) => {
  await expect(window.locator('#scCopyBtn')).toBeVisible({ timeout: 15_000 });
  await window.locator('#scCopyBtn').click();
  await expect(window.locator('#centerToast')).toContainText('Copied', { timeout: 5_000 });
});
