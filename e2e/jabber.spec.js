// Jabber page: autoConnectJabber() reads jabber credentials from app config —
// the fixture never sets any (app.jabber is absent), so it must show the
// "credentials missing" status rather than attempting a live XMPP connection.
// The ping table falls back to its local DB history (empty for a fresh fixture).
const { test, expect } = require('./support/electron-app');

test('shows missing-credentials status and an empty ping table', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await window.locator('.nav-btn[data-page="jabber"]').click();
  await expect(window.locator('#page-jabber')).toBeVisible({ timeout: 15_000 });

  await expect(window.locator('#jabberStatus')).toContainText(
    'Jabber credentials missing',
    { timeout: 10_000 }
  );
  await expect(window.locator('#jabberTable')).toContainText('No messages received yet.', { timeout: 10_000 });
  await expect(window.locator('#jabberSummary')).toContainText('0 pings');

  expect(errors).toEqual([]);
});
