// Assets page: reads straight from the local DB (character_info_db.getCharacterAssets,
// via the get-character-assets-db IPC) — no live ESI call — so the fixture's seeded
// asset rows (Tritanium, a Rifter, a blueprint original + a copy) render without any
// network access.
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

test('blueprints show BPO/BPC icons and an original-vs-copy category label', async ({ window }) => {
  const wrapper = window.locator('#assetTableWrapper');
  await expect(wrapper).toContainText('Tritanium', { timeout: 10_000 });

  // Category column spells out original vs copy instead of a bare "Blueprint".
  await expect(wrapper).toContainText('Blueprint Original');
  await expect(wrapper).toContainText('Blueprint Copy');

  // Icons use the blueprint-specific image-server variants (plain /icon 400s for
  // blueprints): originals use /bp, copies use /bpc — different colours in-game.
  await expect(window.locator('img.asset-type-icon[src*="/types/690/bp?"]')).toHaveCount(1);
  await expect(window.locator('img.asset-type-icon[src*="/types/590/bpc?"]')).toHaveCount(1);
});

test('character filter dropdown is populated from the fixture character', async ({ window }) => {
  const charFilter = window.locator('#assetCharFilter');
  await expect(window.locator('#assetTableWrapper')).toContainText('Tritanium', { timeout: 10_000 });
  await expect(charFilter.locator('option', { hasText: FAKE_CHAR_NAME })).toHaveCount(1);
});
