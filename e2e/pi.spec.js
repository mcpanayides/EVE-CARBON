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

// Free slots are the page's answer to "I need another planet — who can run it?"
// The fixture pilot has Interplanetary Consolidation II (3 slots) and one
// colony, so exactly two slots are open. This is the integration the unit tests
// cannot reach: the skill actually being read off the local DB through the
// preload bridge, and the number surviving the whole render.
test('reports the free planet slots left on a character', async ({ window }) => {
  const strip = window.locator('.pi-status-strip');
  await expect(strip).toBeVisible({ timeout: 10_000 });
  await expect(strip).toContainText('2 slots free');

  // One chip for the pilot, with a pip per slot and the two free ones hollow.
  const chip = window.locator('.pi-cap-chip').first();
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('E2E Test Pilot');
  await expect(chip.locator('.pi-pip')).toHaveCount(3);
  await expect(chip.locator('.pi-pip.is-used')).toHaveCount(1);
});

// The Capacity tab is where the answer scales: chips in the colonies header
// cover a handful of characters, this covers a hundred and adds what a chip
// cannot carry — what each character's command centre can physically hold.
test('the capacity tab reports slots and what the command centre can hold', async ({ window }) => {
  await window.locator('.pi-sub-btn[data-pi-tab="capacity"]').click();
  await expect(window.locator('.pi-cap-table')).toBeVisible({ timeout: 15_000 });

  const row = window.locator('.pi-cap-table tbody tr').first();
  await expect(row).toContainText('E2E Test Pilot');
  await expect(row.locator('.pi-cap-td-free')).toContainText('2');
  // CCU II is a Standard command centre, which fits every role — so the most
  // demanding one it can hold is the P4 plant.
  await expect(row).toContainText('Standard');
  await expect(row.locator('.pi-cap-role')).toContainText('High-Tech');

  // The role legend is the page's explanation of why slots alone are not the
  // whole answer, so it has to actually render.
  await expect(window.locator('.pi-role-card')).toHaveCount(4);
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
