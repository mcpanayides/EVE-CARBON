// Industry page: the sub-nav tabs switch correctly, and the Blueprints
// library — which reads straight from the local DB (getAllBlueprintsFromDb) —
// shows the 3 fixture blueprints without needing any live ESI call.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="industry"]').click();
  await expect(window.locator('#page-industry')).toBeVisible({ timeout: 15_000 });
});

test('Blueprints tab shows the seeded blueprint library', async ({ window }) => {
  await window.locator('.industry-sub-btn[data-industry-tab="blueprints"]').click();
  await expect(window.locator('#bpLibList')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#bpLibCount')).toHaveText('3', { timeout: 10_000 });
  await expect(window.locator('#bpLibList')).toContainText('Rifter Blueprint');
  await expect(window.locator('#bpLibList')).toContainText('Merlin Blueprint');
});

test('Active Jobs tab loads without crashing (no valid ESI token)', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));
  await window.locator('.industry-sub-btn[data-industry-tab="active-jobs"]').click();
  await expect(window.locator('#ajTable')).toBeVisible({ timeout: 10_000 });
  await window.waitForTimeout(1500);
  expect(errors).toEqual([]);
});

test('switching sub-tabs updates the active state', async ({ window }) => {
  const bpBtn = window.locator('.industry-sub-btn[data-industry-tab="blueprints"]');
  const oreBtn = window.locator('.industry-sub-btn[data-industry-tab="ore"]');
  await bpBtn.click();
  await expect(bpBtn).toHaveClass(/active/);
  await oreBtn.click();
  await expect(oreBtn).toHaveClass(/active/);
  await expect(bpBtn).not.toHaveClass(/active/);
});
