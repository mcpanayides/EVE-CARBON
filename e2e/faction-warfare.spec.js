// Faction Warfare page. Overview/Systems/Leaderboards pull live public ESI, so we
// don't assert their data (network-dependent). We assert the page + sub-nav wire
// up, the LP & Tiers view renders from local constants, and My Militia degrades
// gracefully without a valid token — all without throwing pageerrors.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="fw"]').click();
  await expect(window.locator('#page-fw')).toBeVisible({ timeout: 15_000 });
});

test('sub-nav exposes the five FW tools with Warzone Control active', async ({ window }) => {
  await expect(window.locator('.fw-sub-btn')).toHaveCount(5);
  await expect(window.locator('.fw-sub-btn[data-fw-tab="overview"]')).toHaveClass(/active/);
});

test('LP & Tiers renders the tier ladder and plex reference from local data', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await window.locator('.fw-sub-btn[data-fw-tab="lp"]').click();
  const host = window.locator('#fwTabContent');
  await expect(host).toContainText('Tier 1', { timeout: 20_000 });
  await expect(host).toContainText('Tier 5');
  await expect(host).toContainText('×3.0');       // tier-5 multiplier
  await expect(host).toContainText('Novice');     // plex reference
  await expect(host).toContainText('Battlecruisers & below');
  expect(errors).toEqual([]);
});

test('My Militia degrades gracefully without a valid FW token', async ({ window }) => {
  await window.locator('.fw-sub-btn[data-fw-tab="militia"]').click();
  await expect(window.locator('#fwTabContent')).toContainText('Militia', { timeout: 15_000 });
  await expect(window.locator('#fwCharSel')).toBeVisible();
});
