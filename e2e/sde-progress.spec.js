// The SDE update's progress card (src/func/sde_progress.js): top right, what it
// is doing, how far along it is and the time left, then what happens next. A
// real update downloads 95 MB from CCP and rebuilds data/sde.sql, so the main
// process's handlers are swapped for a fake that sends the same events, with
// gates the test opens to look at each stage.
const { test, expect } = require('./support/electron-app');

/** Replace main's SDE handlers with a scripted update the test steps through. */
async function fakeSdeUpdate(electronApp, { error = null } = {}) {
  await electronApp.evaluate(({ ipcMain, BrowserWindow }, error) => {
    const g = globalThis;
    g.__sde = { restarts: 0, gates: [], at: 'idle' };
    const gate = (name) => new Promise(r => { g.__sde.at = name; g.__sde.gates.push(r); });
    // The version check is left alone: under EVE_CARBON_E2E it always says up to
    // date, so the app's own background update never starts and replaces this one.
    for (const ch of ['sde-download-update', 'sde-restart-app']) ipcMain.removeHandler(ch);
    ipcMain.handle('sde-restart-app', () => { g.__sde.restarts++; });
    ipcMain.handle('sde-download-update', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const push = (e) => { if (!win.isDestroyed()) win.webContents.send('sde-update-progress', e); };
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const total = Math.round(94.7 * 1048576);
      push({ phase: 'check', stage: 'Checking SDE version…' });
      await wait(150);
      for (let p = 0; p <= 40; p += 2) {
        push({ phase: 'download', stage: 'Downloading SDE…', percent: p, downloaded: Math.round(total * p / 100), total });
        await wait(120);
      }
      await gate('downloading');
      for (let p = 42; p <= 100; p += 2) {
        push({ phase: 'download', stage: 'Downloading SDE…', percent: p, downloaded: Math.round(total * p / 100), total });
      }
      push({ phase: 'extract', stage: 'Extracting…' });
      await wait(100);
      push({ phase: 'build', stage: 'Building database (this can take a minute)…', step: 0 });
      ['Creating schema...', 'Loading lookup maps...', 'Populating invCategories, invGroups...', 'Populating invTypes, invMetaTypes...']
        .forEach((label, i) => push({ phase: 'build', stage: `Building database… ${label}`, step: i + 1, label }));
      await gate('building');
      push({ phase: 'finish', stage: 'Finishing up…' });
      if (error) return { success: false, error };
      push({ phase: 'done', stage: 'Done', percent: 100 });
      return { success: true };
    });
  }, error);
}
const stage = (electronApp) => electronApp.evaluate(() => globalThis.__sde.at);
const openGate = (electronApp) => electronApp.evaluate(() => { const r = globalThis.__sde.gates.shift(); if (r) r(); });
const restarts = (electronApp) => electronApp.evaluate(() => globalThis.__sde.restarts);
const card = (w) => w.locator('.sde-toast');

async function openDatabase(window) {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.locator('#openSettingsBtn').click();
  await window.locator('[data-settings-tab="database"]').click();
  await expect(window.locator('#sdeUpdateBtn')).toBeVisible({ timeout: 10_000 });
}

test('updating shows a card top right: the stage, the megabytes and the time left', async ({ window, electronApp }) => {
  await fakeSdeUpdate(electronApp);
  await openDatabase(window);
  await window.locator('#sdeUpdateBtn').click();

  await expect(card(window)).toBeVisible();
  await expect(card(window).locator('.app-toast-title')).toHaveText('Updating the SDE');
  await expect.poll(() => stage(electronApp), { timeout: 10_000 }).toBe('downloading');
  await expect(card(window).locator('.sde-toast-stage')).toHaveText('Downloading');
  await expect(card(window).locator('.sde-toast-detail')).toHaveText(/^\d+\.\d of 94\.7 MB$/);
  // The time left carries the database build still to come, not only the download.
  await expect(card(window).locator('.sde-toast-eta')).toHaveText(/^About (1|2) min/, { timeout: 5_000 });
  expect(await card(window).locator('.sde-toast-fill').evaluate(el => parseFloat(el.style.width))).toBeGreaterThan(0);

  // Top right, under the title bar, and NOT over the page's refresh and close
  // buttons (Mia, 2026-11-08: it used to sit on top of them).
  const box = await card(window).boundingBox();
  const width = await window.evaluate(() => innerWidth);
  expect(width - (box.x + box.width)).toBeLessThan(200);
  expect(box.y).toBeLessThan(120);
  const actions = await window.locator('.nav-page.active .page-header-actions').boundingBox();
  expect(box.x + box.width).toBeLessThan(actions.x);

  // The bar in Settings → Database says the same.
  await expect(window.locator('#sdeUpdateProgressLabel')).toContainText('Downloading');
  await expect(window.locator('#sdeUpdateProgressLabel')).toContainText('left');

  await openGate(electronApp);
  await expect.poll(() => stage(electronApp), { timeout: 10_000 }).toBe('building');
  await expect(card(window).locator('.sde-toast-stage')).toHaveText('Building the database');
  await expect(card(window).locator('.sde-toast-detail')).toContainText('Step 4 of 16');

  await openGate(electronApp);
  await expect(card(window).locator('.app-toast-title')).toHaveText('SDE updated', { timeout: 10_000 });
  // Started from Settings, it restarts by itself, so there is no button to press.
  await expect(card(window).locator('.sde-toast-stage')).toContainText('Restarting');
  await expect(card(window).getByRole('button', { name: 'Restart now' })).toHaveCount(0);
  await expect.poll(() => restarts(electronApp), { timeout: 5_000 }).toBe(1);
});

test('a background update ends with "Restart now"; hidden while it runs, it stays hidden', async ({ window, electronApp }) => {
  await fakeSdeUpdate(electronApp);   // so a restart is counted, not done
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => {
    SdeProgress.begin('auto');
    SdeProgress.update({ phase: 'download', downloaded: 10485760, total: 99300000 });
  });
  await expect(card(window)).toBeVisible();
  await card(window).locator('.app-toast-close').click();
  await expect(card(window)).toHaveCount(0);

  await window.evaluate(() => SdeProgress.update({ phase: 'build', step: 3, label: 'Populating invTypes...' }));
  await window.waitForTimeout(1300);          // a tick of the card's own timer
  await expect(card(window)).toHaveCount(0);

  // The end of the update is news again.
  await window.evaluate(() => SdeProgress.done({ restarting: false }));
  await expect(card(window).locator('.app-toast-title')).toHaveText('SDE updated');
  await expect(card(window).locator('.sde-toast-stage')).toHaveText('Restart EVE Carbon to start using it.');
  await card(window).getByRole('button', { name: 'Restart now' }).click();
  await expect.poll(() => restarts(electronApp)).toBe(1);
});

test('a failed update says what went wrong, and that it tries again next launch', async ({ window, electronApp }) => {
  await fakeSdeUpdate(electronApp, { error: 'HTTP 503 downloading the SDE.' });
  await openDatabase(window);
  await window.locator('#sdeUpdateBtn').click();
  await expect.poll(() => stage(electronApp), { timeout: 10_000 }).toBe('downloading');
  await openGate(electronApp);
  await expect.poll(() => stage(electronApp), { timeout: 10_000 }).toBe('building');
  await openGate(electronApp);
  await expect(card(window).locator('.app-toast-title')).toHaveText('SDE update failed', { timeout: 10_000 });
  await expect(card(window).locator('.sde-toast-stage'))
    .toHaveText('HTTP 503 downloading the SDE. It tries again the next time EVE Carbon starts.');
  await expect(card(window)).toHaveClass(/app-toast-warn/);
  expect(await restarts(electronApp)).toBe(0);
});

test('it waits while a guided tour is running, then shows', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => startTutorial('basic'));
  await expect(window.locator('.tour-card')).toBeVisible({ timeout: 10_000 });
  await window.evaluate(() => SdeProgress.begin('auto'));
  await window.waitForTimeout(600);
  await expect(card(window)).toHaveCount(0);   // nothing pops over a tour

  await window.evaluate(() => exitTutorial('finished', { quiet: true }));
  await expect(card(window)).toBeVisible({ timeout: 5_000 });
  await expect(card(window).locator('.app-toast-title')).toHaveText('Updating the SDE');
});
