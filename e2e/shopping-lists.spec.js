// Industry → Shopping Lists.
//
// Both the New and Rename buttons reached for window.prompt(), which Electron
// does not implement. It does not quietly return undefined either — measured,
// it THROWS "prompt() is not supported", so the click handler dies on that line
// and everything after it is skipped with nothing shown to the user. Both now
// open an in-app modal. window.confirm() IS implemented (it shows a real
// dialog), which is why Clear and Delete were never affected.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="industry"]').click();
  await expect(window.locator('#page-industry')).toBeVisible({ timeout: 15_000 });
  await window.locator('.industry-sub-btn[data-industry-tab="shopping-lists"]').click();
  await expect(window.locator('#slTabWrap')).toBeVisible({ timeout: 10_000 });
});

test('New Shopping List button opens a modal and creates a list', async ({ window }) => {
  await window.locator('#slNewListBtn').click();
  await expect(window.locator('#slNameBackdrop')).toBeVisible({ timeout: 5_000 });

  await window.locator('#slNameInput').fill('Corp Ammo Run');
  await window.locator('#slNameConfirm').click();

  // Modal closes and the new list shows in the sidebar.
  await expect(window.locator('#slNameBackdrop')).toHaveCount(0);
  await expect(window.locator('#slListItems')).toContainText('Corp Ammo Run', { timeout: 5_000 });
});

test('Enter key in the name field creates the list', async ({ window }) => {
  await window.locator('#slNewListBtn').click();
  await window.locator('#slNameInput').fill('Ice Interdiction');
  await window.locator('#slNameInput').press('Enter');
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

test('Rename opens a modal prefilled with the current name and renames the list', async ({ window }) => {
  await window.evaluate(() => { const l = slCreate('Before Rename'); _slActiveId = l.id; });
  await window.locator('.industry-sub-btn[data-industry-tab="orehold"]').click();
  await window.locator('.industry-sub-btn[data-industry-tab="shopping-lists"]').click();

  await window.locator('#slRenameBtn').click();
  await expect(window.locator('#slNameBackdrop')).toBeVisible({ timeout: 5_000 });
  // Prefilled and selected, so the old name can be replaced by typing.
  await expect(window.locator('#slNameInput')).toHaveValue('Before Rename');

  await window.locator('#slNameInput').fill('After Rename');
  await window.locator('#slNameConfirm').click();

  await expect(window.locator('#slNameBackdrop')).toHaveCount(0);
  await expect(window.locator('#slListItems')).toContainText('After Rename', { timeout: 5_000 });
  await expect(window.locator('#slListItems')).not.toContainText('Before Rename');
});

test('renaming survives a re-render, so it reached storage and not just the DOM', async ({ window }) => {
  await window.evaluate(() => { const l = slCreate('Persist Me'); _slActiveId = l.id; });
  await window.locator('.industry-sub-btn[data-industry-tab="orehold"]').click();
  await window.locator('.industry-sub-btn[data-industry-tab="shopping-lists"]').click();

  await window.locator('#slRenameBtn').click();
  await window.locator('#slNameInput').fill('Persisted');
  await window.locator('#slNameInput').press('Enter');
  await expect(window.locator('#slListItems')).toContainText('Persisted', { timeout: 5_000 });

  const stored = await window.evaluate(() => slGetAll().map(l => l.name));
  expect(stored).toContain('Persisted');
  expect(stored).not.toContain('Persist Me');
});

test('a click handler that used prompt() no longer throws', async ({ window }) => {
  // The real symptom was an exception inside the handler, not a silent no-op.
  const errors = [];
  window.on('pageerror', e => errors.push(e.message));
  await window.evaluate(() => { const l = slCreate('Throw Check'); _slActiveId = l.id; });
  await window.locator('.industry-sub-btn[data-industry-tab="orehold"]').click();
  await window.locator('.industry-sub-btn[data-industry-tab="shopping-lists"]').click();
  await window.locator('#slRenameBtn').click();
  await expect(window.locator('#slNameBackdrop')).toBeVisible({ timeout: 5_000 });
  expect(errors.filter(e => /prompt/i.test(e))).toEqual([]);
});
