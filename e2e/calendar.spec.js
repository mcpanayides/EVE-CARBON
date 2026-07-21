// Calendar page: renderCalendar() paints the month grid shell immediately,
// then loads forum/feed config (none configured in the fixture) and ICS
// events in the background. No live network dependency for the shell itself.
const { test, expect } = require('./support/electron-app');

test('renders the month grid shell without crashing', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await window.locator('.nav-btn[data-page="calendar"]').click();
  await expect(window.locator('#page-calendar')).toBeVisible({ timeout: 15_000 });

  await expect(window.locator('#calTitle')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('.cal-view-btn')).toHaveCount(2);
  await expect(window.locator('#calContent')).toBeVisible();

  await window.waitForTimeout(1000);
  expect(errors).toEqual([]);
});

test('switching between month and agenda views works', async ({ window }) => {
  await window.locator('.nav-btn[data-page="calendar"]').click();
  const agendaBtn = window.locator('.cal-view-btn[data-cal-view="agenda"]');
  const monthBtn  = window.locator('.cal-view-btn[data-cal-view="month"]');
  await expect(agendaBtn).toBeVisible({ timeout: 10_000 });
  await agendaBtn.click();
  await expect(window.locator('#calContent')).toBeVisible();
  await monthBtn.click();
  await expect(window.locator('#calContent')).toBeVisible();
});
