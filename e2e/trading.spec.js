// Finances → Trading tools. Per-item P&L and profit-over-time read the seeded
// wallet transactions from the local DB (no ESI). Undercut alerts need live
// orders (no valid token in e2e) so they degrade to an empty state.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="wallets"]').click();
  await expect(window.locator('#page-wallets, #financesTabContent').first()).toBeVisible({ timeout: 15_000 });
  await window.locator('.finances-sub-btn[data-finances-tab="trading"]').click();
  await expect(window.locator('.tr-wrap')).toBeVisible({ timeout: 10_000 });
});

test('undercut view degrades gracefully with no live orders', async ({ window }) => {
  await expect(window.locator('#trBody')).toContainText('No active market orders', { timeout: 10_000 });
});

test('per-item P&L computes realised profit from seeded transactions', async ({ window }) => {
  await window.locator('.tr-seg-btn[data-tr-view="pnl"]').click();
  const body = window.locator('#trBody');
  await expect(body).toContainText('Tritanium', { timeout: 10_000 });
  await expect(body).toContainText('Rifter');
  // Tritanium: (5.5 − 4.5) × 100k = 100k; Rifter: (2×~575k − 2×400k) = 350k; total 450k.
  await expect(window.locator('.tr-summary')).toContainText('450.0 K ISK');
  await expect(window.locator('#trPnlTable')).toBeVisible();
});

test('profit-over-time renders period bars totalling the realised profit', async ({ window }) => {
  await window.locator('.tr-seg-btn[data-tr-view="profit"]').click();
  await expect(window.locator('.tr-bars .tr-bar-row').first()).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('.tr-summary')).toContainText('450.0 K ISK');
});

test('undercut alert toggle persists to config', async ({ window }) => {
  const chk = window.locator('#trAlertChk');
  await expect(chk).toBeVisible({ timeout: 10_000 });
  await expect(chk).not.toBeChecked();
  await chk.check();
  // The change handler writes config.app.trading.undercutAlerts — read it back.
  await expect.poll(async () =>
    window.evaluate(async () => {
      const cfg = (await window.eveAPI.getAppConfig()) || {};
      return !!(cfg.app && cfg.app.trading && cfg.app.trading.undercutAlerts);
    }), { timeout: 10_000 }
  ).toBe(true);
});

test('pushAppToast renders a dismissible floating toast', async ({ window }) => {
  const count = await window.evaluate(() => {
    pushAppToast({ title: 'Test', body: 'hello', kind: 'warn' });
    return document.querySelectorAll('#appToastStack .app-toast').length;
  });
  expect(count).toBe(1);
  await expect(window.locator('.app-toast .app-toast-title')).toContainText('Test');
  await window.locator('.app-toast .app-toast-close').click();
  await expect(window.locator('#appToastStack .app-toast')).toHaveCount(0, { timeout: 5_000 });
});
