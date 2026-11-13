// Performance mode (Settings → General). Quality is EVE Carbon as designed;
// Performance turns off the glass, the wallpaper, every animation and, from the
// next launch, graphics acceleration, for people running it beside many EVE
// clients. src/func/perf_mode.js, src/styles/performance.css, main.js.
const { test, expect } = require('./support/electron-app');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');

async function openGeneral(window) {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.locator('#openSettingsBtn').click();
  await window.locator('[data-settings-tab="general"]').click();
  await expect(window.locator('#settingsTabGeneral')).toBeVisible({ timeout: 15_000 });
}

const opt = (w, mode) => w.locator(`#perfModeSwitch .perf-switch-opt[data-perf-mode="${mode}"]`);
const savedMode = (profile) =>
  JSON.parse(fs.readFileSync(path.join(profile.userDataDir, 'config.json'), 'utf8')).app?.performanceMode;

// Looping animations still running, spinners aside: spinners mean "working" and
// keep turning in Performance mode on purpose.
const SPINNERS = ['spin', 'page-spin', 'forum-spin', 'map-spin'];
const loops = (w) => w.evaluate((spinners) => document.getAnimations()
  .filter(a => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity)
  .map(a => a.animationName || a.constructor.name)
  .filter(n => !spinners.includes(n)), SPINNERS);

test('the switch turns glass, wallpaper and animation off at once, and Quality brings them back', async ({ window, profile }) => {
  await openGeneral(window);
  await expect(opt(window, 'quality')).toHaveAttribute('aria-checked', 'true');
  await expect(window.locator('body')).toHaveClass(/glass-on/);
  // A wallpaper to hide (the default one comes from CCP's servers later).
  await window.evaluate(() => applyBackground('data:image/gif;base64,R0lGODlhAQABAAAAACw=', 0));
  await expect(window.locator('#appBackground')).toBeVisible();

  await opt(window, 'performance').click();
  await expect(opt(window, 'performance')).toHaveAttribute('aria-checked', 'true');
  await expect(window.locator('body')).toHaveClass(/perf-mode/);
  await expect(window.locator('body')).not.toHaveClass(/glass-on/);
  await expect(window.locator('#appBackground')).toBeHidden();
  expect(await loops(window)).toEqual([]);
  // Wallpaper and Colour says why its choices aren't showing.
  const noteShown = () => window.evaluate(() => getComputedStyle(document.querySelector('.perf-mode-note')).display !== 'none');
  expect(await noteShown()).toBe(true);
  await expect.poll(() => savedMode(profile)).toBe('performance');
  // Graphics acceleration is decided at launch, so the switch says to restart.
  await expect(window.locator('#perfModeNotice')).toBeVisible();
  await expect(window.locator('#perfModeNotice')).toContainText('Restart');

  await opt(window, 'quality').click();
  await expect(window.locator('body')).not.toHaveClass(/perf-mode/);
  await expect(window.locator('body')).toHaveClass(/glass-on/, { timeout: 5_000 });   // the saved glass, untouched
  await expect(window.locator('#appBackground')).toBeVisible();
  await expect.poll(() => savedMode(profile)).toBe('quality');
  await expect(window.locator('#perfModeNotice')).toBeHidden();   // back to what this launch started with
  expect(await noteShown()).toBe(false);
});

test('it is a radio group: the arrow keys move the choice and the focus', async ({ window }) => {
  await openGeneral(window);
  await opt(window, 'quality').focus();
  await window.keyboard.press('ArrowRight');
  await expect(opt(window, 'performance')).toHaveAttribute('aria-checked', 'true');
  await expect(opt(window, 'performance')).toBeFocused();
  await expect(window.locator('body')).toHaveClass(/perf-mode/);
  await window.keyboard.press('ArrowLeft');
  await expect(opt(window, 'quality')).toHaveAttribute('aria-checked', 'true');
  await expect(opt(window, 'quality')).toBeFocused();
  await expect(window.locator('body')).not.toHaveClass(/perf-mode/);
});

test('the map holds still in Performance mode: its loops all ask one question', async ({ window }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  // The OS reduced-motion setting also stills the map; pin it off so this
  // measures the mode and not the machine.
  await window.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await window.evaluate(() => _jbFxStill())).toBe(false);
  await window.evaluate(() => window.eveAPI.setPerformanceMode('performance'));
  await expect(window.locator('body')).toHaveClass(/perf-mode/);
  expect(await window.evaluate(() => _jbFxStill())).toBe(true);
});

test('a pop-out window follows the switch, glass and all', async ({ window, electronApp }) => {
  await expect(window.locator('#page-dashboard')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => window.eveAPI.widgetPopoutOpen({ id: 'beehive', title: 'BEEHIVE STATUS', w: 280, h: 200 }));
  let pop = null;
  await expect.poll(() => {
    pop = electronApp.windows().find(p => p.url().includes('widget-window.html')) || null;
    return !!pop;
  }, { timeout: 10_000 }).toBe(true);
  await pop.waitForLoadState('domcontentloaded');
  await expect(pop.locator('body')).toHaveClass(/glass-on/);

  await window.evaluate(() => window.eveAPI.setPerformanceMode('performance'));
  await expect(pop.locator('body')).toHaveClass(/perf-mode/);
  await expect(pop.locator('body')).not.toHaveClass(/glass-on/);

  await window.evaluate(() => window.eveAPI.setPerformanceMode('quality'));
  await expect(pop.locator('body')).not.toHaveClass(/perf-mode/);
  await expect(pop.locator('body')).toHaveClass(/glass-on/);
});

test('saved as Performance, the next launch starts that way: no glass, no animation, no graphics acceleration', async ({ electronApp, profile }) => {
  await electronApp.close();
  const cfgPath = path.join(profile.userDataDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.app = { ...(cfg.app || {}), performanceMode: 'performance' };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const app = await electron.launch({ args: profile.args, env: profile.childEnv });
  try {
    const w = await app.firstWindow();
    await w.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; if (win) win.setContentSize(1600, 1000); }).catch(() => {});
    // On <body> from the pre-paint script, before the app's own scripts run:
    // nothing animates or blurs and then stops.
    expect(await w.evaluate(() => document.body.classList.contains('perf-mode'))).toBe(true);
    expect(await w.evaluate(() => document.body.classList.contains('glass-on'))).toBe(false);
    expect(await app.evaluate(({ app }) => app.getGPUFeatureStatus().gpu_compositing)).toMatch(/disabled/);

    await openGeneral(w);
    await expect(opt(w, 'performance')).toHaveAttribute('aria-checked', 'true');
    await expect(w.locator('#perfModeNotice')).toBeHidden();   // nothing waiting on a restart
    expect(await loops(w)).toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});
