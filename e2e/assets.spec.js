// Assets page: reads straight from the local DB (character_info_db.getCharacterAssets,
// via the get-character-assets-db IPC) — no live ESI call — so the fixture's 2 seeded
// asset rows (Tritanium stack + a Rifter) should render without any network access.
const { test, expect, FAKE_CHAR_NAME } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="assets"]').click();
  await expect(window.locator('#page-assets')).toBeVisible({ timeout: 15_000 });
});

test('shows the seeded asset rows grouped by location', async ({ window }) => {
  const wrapper = window.locator('#assetTableWrapper');
  await expect(wrapper).toContainText('Tritanium', { timeout: 10_000 });
  await expect(wrapper).toContainText('Rifter');
  await expect(wrapper).toContainText('Jita');
});

test('character filter dropdown is populated from the fixture character', async ({ window }) => {
  const charFilter = window.locator('#assetCharFilter');
  await expect(window.locator('#assetTableWrapper')).toContainText('Tritanium', { timeout: 10_000 });
  await expect(charFilter.locator('option', { hasText: FAKE_CHAR_NAME })).toHaveCount(1);
});
