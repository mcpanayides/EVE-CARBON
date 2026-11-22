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

test('an update that stops moving says so instead of promising a time, and recovers', async ({ window }) => {
  // The card used to hold "About 5 min 30 s left" for ever over an update that
  // had died (Mia, 2026-11-22). One tick of its timer is a second; run them fast.
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => {
    window.__realSetInterval = window.setInterval;
    window.setInterval = (fn, ms) => window.__realSetInterval(fn, ms === 1000 ? 20 : ms);
    SdeProgress.begin('auto');
    SdeProgress.update({ phase: 'build', step: 1, label: 'Creating schema...' });
    window.setInterval = window.__realSetInterval;
  });
  await expect(card(window).locator('.app-toast-title')).toHaveText('The SDE update has stopped moving', { timeout: 10_000 });
  await expect(card(window).locator('.sde-toast-eta')).toHaveText(/^No progress for \d+ min$/);
  await expect(card(window)).toHaveClass(/sde-toast-stalled/);

  // A sign of life, with no new step: back to normal at once.
  await window.evaluate(() => SdeProgress.update({ phase: 'build', step: 1 }));
  await expect(card(window).locator('.app-toast-title')).toHaveText('Updating the SDE');
  await expect(card(window).locator('.sde-toast-eta')).toContainText('left');

  // Main giving up is a failure with its reason, and the time left is gone.
  await window.evaluate(() => SdeProgress.fail('Stopped after 5 min with no progress'));
  await expect(card(window).locator('.sde-toast-stage'))
    .toHaveText('Stopped after 5 min with no progress. It tries again the next time EVE Carbon starts.');
  await expect(card(window).locator('.sde-toast-meta')).toBeHidden();
  await expect(card(window).locator('.sde-toast-track')).toBeHidden();
});

// ── The hotfix card: clearing up after updates that hung (4.1.3 and earlier) ──
async function fakeCleanup(electronApp, { folders = 220, notice = true, failed = 0 } = {}) {
  await electronApp.evaluate(({ ipcMain, BrowserWindow }, o) => {
    const g = globalThis;
    g.__clean = { runs: 0, go: null };
    for (const ch of ['sde-cleanup-scan', 'sde-cleanup-run']) ipcMain.removeHandler(ch);
    const bytes = o.folders * 75 * 1048576;
    // Once: the launch asks for itself two seconds in, and must not find them again.
    let asked = false;
    ipcMain.handle('sde-cleanup-scan', () => (asked ? { folders: 0 } : (asked = true, { folders: o.folders, bytes, notice: o.notice, dir: 'C:\Users\Pilot\AppData\Roaming\EVE Carbon\sde' })));
    ipcMain.handle('sde-cleanup-run', async (event) => {
      g.__clean.runs++;
      const win = BrowserWindow.fromWebContents(event.sender);
      win.webContents.send('sde-cleanup-progress', { done: 84, total: o.folders, freed: bytes * 84 / o.folders, bytes });
      await new Promise(r => { g.__clean.go = r; });
      const removed = o.folders - o.failed;
      return { removed, failed: o.failed, freed: bytes * removed / o.folders, bytes };
    });
  }, { folders, notice, failed });
}
const cleanCard = (w) => w.locator('.sde-cleanup-toast');
const finishCleanup = (electronApp) => expect.poll(() => electronApp.evaluate(() => {
  if (!globalThis.__clean.go) return false;
  globalThis.__clean.go(); return true;
})).toBe(true);

test('the hotfix card explains the clean-up, counts it, and says what came back', async ({ window, electronApp }) => {
  await fakeCleanup(electronApp);
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => { SdeCleanup.run(); });
  await expect(cleanCard(window).locator('.app-toast-title')).toHaveText('Hotfix: clearing up after stuck updates');
  await expect(cleanCard(window).locator('.app-toast-text')).toContainText('Please bear with us');
  await expect(cleanCard(window).locator('.sde-toast-detail')).toHaveText('84 of 220 leftover folders');
  await expect(cleanCard(window).locator('.sde-toast-eta')).toHaveText('6.2 GB of 16.1 GB');

  await finishCleanup(electronApp);
  await expect(cleanCard(window).locator('.app-toast-title')).toHaveText('Hotfix done: all cleared up', { timeout: 10_000 });
  await expect(cleanCard(window).locator('.app-toast-text')).toContainText('Removed 220 leftover folders from stuck SDE updates and freed 16.1 GB.');
  await expect(cleanCard(window).locator('.app-toast-text')).toContainText('AppData\Roaming\EVE Carbon\sde');
  await expect(cleanCard(window).locator('.sde-toast-meta')).toBeHidden();
  await cleanCard(window).locator('.app-toast-close').click();
  await expect(cleanCard(window)).toHaveCount(0);
});

test('folders in use are said to be left for next time', async ({ window, electronApp }) => {
  await fakeCleanup(electronApp, { folders: 3, failed: 1 });
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => { SdeCleanup.run(); });
  await finishCleanup(electronApp);
  await expect(cleanCard(window).locator('.app-toast-text')).toContainText('Removed 2 leftover folders', { timeout: 10_000 });
  await expect(cleanCard(window).locator('.app-toast-text')).toContainText('1 leftover folder in use; EVE Carbon tries again next time it starts.');
});

test('later clean-ups are silent, and with nothing to clear nothing runs', async ({ window, electronApp }) => {
  await fakeCleanup(electronApp, { folders: 1, notice: false });
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => { SdeCleanup.run(); });
  await finishCleanup(electronApp);
  await window.waitForTimeout(400);
  await expect(cleanCard(window)).toHaveCount(0);

  await fakeCleanup(electronApp, { folders: 0 });
  await window.evaluate(() => SdeCleanup.run());
  await expect(cleanCard(window)).toHaveCount(0);
  expect(await electronApp.evaluate(() => globalThis.__clean.runs)).toBe(0);
});

test('the hotfix card waits for a guided tour; the clean-up does not', async ({ window, electronApp }) => {
  await fakeCleanup(electronApp, { folders: 5 });
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => startTutorial('basic'));
  await expect(window.locator('.tour-card')).toBeVisible({ timeout: 10_000 });
  await window.evaluate(() => { SdeCleanup.run(); });
  await finishCleanup(electronApp);
  await window.waitForTimeout(400);
  await expect(cleanCard(window)).toHaveCount(0);
  await window.evaluate(() => exitTutorial('finished', { quiet: true }));
  await expect(cleanCard(window).locator('.app-toast-title')).toHaveText('Hotfix done: all cleared up', { timeout: 5_000 });
});

test('two calls at once clear once, with one card', async ({ window, electronApp }) => {
  await fakeCleanup(electronApp, { folders: 4 });
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => { SdeCleanup.run(); SdeCleanup.run(); });
  await expect(cleanCard(window)).toHaveCount(1);
  await finishCleanup(electronApp);
  await window.waitForTimeout(500);
  await expect(cleanCard(window)).toHaveCount(1);
  expect(await electronApp.evaluate(() => globalThis.__clean.runs)).toBe(1);
});
