// Industry → Shopping Lists. The "New Shopping List" button previously called
// window.prompt() (a no-op in Electron), so it did nothing. It now opens an in-app
// modal — this asserts creating a list from that modal works, no network needed.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="industry"]').click();
  await expect(window.locator('#page-industry')).toBeVisible({ timeout: 15_000 });
  await window.locator('.industry-sub-btn[data-industry-tab="shopping-lists"]').click();
  await expect(window.locator('#slTabWrap')).toBeVisible({ timeout: 10_000 });
});

test('New Shopping List button opens a modal and creates a list', async ({ window }) => {
  await window.locator('#slNewListBtn').click();
  await expect(window.locator('#slNewListBackdrop')).toBeVisible({ timeout: 5_000 });

  await window.locator('#slNewNameInput').fill('Corp Ammo Run');
  await window.locator('#slNewCreate').click();

  // Modal closes and the new list shows in the sidebar.
  await expect(window.locator('#slNewListBackdrop')).toHaveCount(0);
  await expect(window.locator('#slListItems')).toContainText('Corp Ammo Run', { timeout: 5_000 });
});

test('Enter key in the name field creates the list', async ({ window }) => {
  await window.locator('#slNewListBtn').click();
  await window.locator('#slNewNameInput').fill('Ice Interdiction');
  await window.locator('#slNewNameInput').press('Enter');
  await expect(window.locator('#slListItems')).toContainText('Ice Interdiction', { timeout: 5_000 });
});

test('Send to Game shows a centered confirmation toast', async ({ window }) => {
  // Seed a list with an item via the storage API, then re-render to show it.
  await window.evaluate(() => {
    const l = slCreate('Send Test');
    slAddItems(l.id, [{ typeId: 34, name: 'Tritanium', qty: 1000 }], 'probe');
  });
  await window.locator('.industry-sub-btn[data-industry-tab="orehold"]').click();
  await window.locator('.industry-sub-btn[data-industry-tab="shopping-lists"]').click();

  await window.locator('#slSendBtn').click();
  const toast = window.locator('#centerToast');
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText('Copied');
  await expect(toast).toContainText('Multibuy');
});
