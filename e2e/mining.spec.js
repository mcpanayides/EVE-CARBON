// Industry → Mining Ledger. The "By Ore" and "Daily" views read the seeded
// mining ledger straight from CharDB (no ESI), so unit totals render without any
// network. Moon Extractions needs a live corp token (none in e2e) so it degrades
// to an informative message. ISK values depend on live prices and aren't asserted.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="industry"]').click();
  await expect(window.locator('#page-industry')).toBeVisible({ timeout: 15_000 });
  await window.locator('.industry-sub-btn[data-industry-tab="mining"]').click();
  await expect(window.locator('.ml-wrap')).toBeVisible({ timeout: 10_000 });
});

test('by-ore view aggregates the seeded ledger units', async ({ window }) => {
  await expect(window.locator('#mlOreTable')).toBeVisible({ timeout: 10_000 });
  const body = window.locator('#mlBody');
  // Veldspar 10k+5k merged to 15,000; Scordite 8,000.
  await expect(body).toContainText('15,000');
  await expect(body).toContainText('8,000');
  await expect(window.locator('.tr-summary')).toContainText('2 ore types');
});

test('daily view renders a bar per active day', async ({ window }) => {
  await window.locator('.tr-seg-btn[data-ml-view="daily"]').click();
  // Two distinct mining days seeded (24th and 25th).
  await expect(window.locator('.tr-bars .tr-bar-row')).toHaveCount(2, { timeout: 10_000 });
});

test('moon extractions degrade gracefully without a corp token', async ({ window }) => {
  await window.locator('.tr-seg-btn[data-ml-view="moon"]').click();
  await expect(window.locator('#mlBody')).toContainText('Moon Extractions', { timeout: 10_000 });
});
