// Wallets page: reads wallet balances (insertWalletSnapshot) and the journal
// (replaceWalletJournal) straight from the local DB — the fixture's 12 seeded
// journal entries and wallet snapshot should render with no live ESI needed.
const { test, expect, FAKE_CHAR_NAME, FAKE_CHAR_ID } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="wallets"]').click();
  await expect(window.locator('#page-wallets')).toBeVisible({ timeout: 15_000 });
});

test('shows a wallet card for the fixture character', async ({ window }) => {
  const grid = window.locator('#walletsGrid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('.wallet-card')).not.toHaveCount(0, { timeout: 10_000 });
  await expect(grid).toContainText(FAKE_CHAR_NAME, { timeout: 10_000 });
});

test('opening the wallet journal shows the seeded entries', async ({ window }) => {
  // The card itself is drag-reorderable (draggable="true", see
  // src/func/assets.js _wireWalletDrag) and has NO click listener of its own
  // — the journal opens via the nested "View Journal" button specifically
  // (.journal-open-btn). Clicking the card body is a no-op by design.
  await window.locator(`.journal-open-btn[data-char-id="${FAKE_CHAR_ID}"]`).click();
  const modal = window.locator('#walletJournalModal');
  await expect(modal).toBeVisible({ timeout: 10_000 });
  // The overview tab's category breakdown is Chart.js canvas-only (#journalLegend
  // is never populated with real DOM text — confirmed by reading the source),
  // so it isn't assertable by text content. The income/expense totals ARE real
  // textContent — assert those against the fixture's known seeded amounts
  // (6 income entries @ 1,000,000 = 6.00m; 6 expense entries @ 250,000 = 1.50m).
  await expect(window.locator('#journalIncomeTotal')).toContainText('6.00 M ISK', { timeout: 10_000 });
  await expect(window.locator('#journalExpenseTotal')).toContainText('1.50 M ISK');
});
