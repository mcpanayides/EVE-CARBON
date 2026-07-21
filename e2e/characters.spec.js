// Characters page: the account list (loadAccounts()) reads straight from the
// local accounts store (blueprints.json) — the fixture's one fake character
// should render a card with no live ESI call needed.
const { test, expect, FAKE_CHAR_NAME, FAKE_CHAR_ID } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="characters"]').click();
  await expect(window.locator('#page-characters')).toBeVisible({ timeout: 15_000 });
});

test('shows a character card for the fixture character', async ({ window }) => {
  const card = window.locator(`.character-card[data-character-id="${FAKE_CHAR_ID}"]`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator('.character-card-name')).toHaveText(FAKE_CHAR_NAME);
});

test('search filter narrows the character list', async ({ window }) => {
  const card = window.locator(`.character-card[data-character-id="${FAKE_CHAR_ID}"]`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await window.locator('#charSearch').fill('nobody-matches-this-xyz');
  await expect(card).toBeHidden({ timeout: 5_000 });
  await window.locator('#charSearch').fill('');
  await expect(card).toBeVisible({ timeout: 5_000 });
});
