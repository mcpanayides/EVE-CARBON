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

// The TOOLS rail mirrors Industry/Finances/FW. Colonies is the landing view;
// Planet Size Mapper moved here from the Industry rail.
test('tools rail switches between Colonies and Planet Size Mapper', async ({ window }) => {
  const colonies = window.locator('.pi-sub-btn[data-pi-tab="colonies"]');
  const mapper   = window.locator('.pi-sub-btn[data-pi-tab="planet-size"]');
  await expect(colonies).toBeVisible();
  await expect(mapper).toBeVisible();
  // Colonies is active on entry and owns #piContainer.
  await expect(colonies).toHaveClass(/active/);
  await expect(window.locator('#piContainer')).toBeVisible();

  await mapper.click();
  await expect(mapper).toHaveClass(/active/);
  await expect(window.locator('#psRegion')).toBeVisible({ timeout: 10_000 });
  // The region select must be populated from the SDE, not left on the placeholder.
  await expect
    .poll(async () => window.locator('#psRegion option').count(), { timeout: 10_000 })
    .toBeGreaterThan(1);

  // Switching back rebuilds the colony view.
  await colonies.click();
  await expect(colonies).toHaveClass(/active/);
  await expect(window.locator('#piColonyCount')).toBeVisible({ timeout: 10_000 });
});
