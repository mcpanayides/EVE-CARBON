// "vs Jita" view — folded into Finances → Trading (the standalone Market page was
// retired). renderMarket() fetches live character orders via ESI
// (getCharacterOrders); the fixture's expired token makes that call fail, which
// _marketFetch() catches per-account, yielding an empty order list. This asserts
// the view loads cleanly to that deterministic empty state rather than throwing.
const { test, expect } = require('./support/electron-app');

test('vs-Jita view loads to the empty-orders state without crashing', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await window.locator('.nav-btn[data-page="wallets"]').click();
  await window.locator('.finances-sub-btn[data-finances-tab="trading"]').click();
  await window.locator('.tr-seg-btn[data-tr-view="market"]').click();

  await expect(window.locator('#marketOrdersBody')).toContainText(
    'No active sell orders found',
    { timeout: 15_000 }
  );
  await expect(window.locator('#marketSummary')).toContainText('0 active sell orders');

  expect(errors).toEqual([]);
});
