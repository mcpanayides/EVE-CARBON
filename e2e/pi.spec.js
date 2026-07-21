// Planetary Interaction page: loadPlanetaryInteraction() reads colonies from
// the local DB (getCharacterData().piColonies) — no live ESI sync required —
// so the fixture's 1 seeded colony (Jita, Barren planet) should render.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="pi"]').click();
  await expect(window.locator('#page-pi')).toBeVisible({ timeout: 15_000 });
});

test('shows the seeded colony count and system', async ({ window }) => {
  const count = window.locator('#piColonyCount');
  await expect(count).toBeVisible({ timeout: 10_000 });
  await expect(count).toContainText('1 Colony');
  await expect(count).toContainText('1 Character');
  await expect(window.locator('#piContainer')).toContainText('Jita');
});
