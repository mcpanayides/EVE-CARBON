// Forums page: initForumsPage() reads the forum URL from app config — the
// fixture never sets one (app.forum.url / app.calendar.forumBaseUrl are both
// absent), so it must show the "no forum configured" empty state rather than
// trying to load a <webview> to nowhere.
const { test, expect } = require('./support/electron-app');

test('shows the empty state when no forum URL is configured', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await window.locator('.nav-btn[data-page="forums"]').click();
  await expect(window.locator('#page-forums')).toBeVisible({ timeout: 15_000 });

  await expect(window.locator('#forumEmpty')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#forumEmpty')).toContainText('No forum configured yet');
  await expect(window.locator('#forumWebview')).toBeHidden();
  await expect(window.locator('#forumStatusLabel')).toHaveText('Logged out', { timeout: 10_000 });

  expect(errors).toEqual([]);
});
