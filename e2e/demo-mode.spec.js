// The Demo Mode toggle in Settings > General.
//
// Worth covering end-to-end because the switch controls something destructive:
// a demo launch WIPES and rebuilds the profile it points at. The failure that
// matters isn't the toggle looking wrong, it's the app deciding a normal launch
// is a demo launch. So this asserts both directions of the persisted value.
//
// It deliberately stops short of actually restarting into demo mode: that would
// seed <appData>/EVE Carbon Demo, a fixed global path shared with whatever demo
// profile the developer has set up. The boot-time behaviour behind the flag is
// covered by test/demo_mode.test.js, which can fake the paths.
const fs   = require('fs');
const path = require('path');
const { test, expect } = require('./support/electron-app');

// The native checkbox is visually hidden inside its .switch label (that's how
// the slider is styled), so it can never be "visible" to Playwright. Assert on
// the row, and drive the control by clicking the label — which is what a user
// actually clicks anyway.
const rowFor = (window, id) =>
  window.locator(`#${id}`).locator('xpath=ancestor::div[contains(@class,"settings-toggle-row")]');

async function openGeneralSettings(window) {
  await window.locator('#openSettingsBtn').click();
  await window.locator('.settings-menu-btn[data-settings-tab="general"]').click();
  await expect(rowFor(window, 'demoModeToggle')).toBeVisible({ timeout: 8000 });
}

const flip = (window, id) => rowFor(window, id).locator('.switch').click();

test('Demo Mode appears in General settings and is off for a normal profile', async ({ window }) => {
  await openGeneralSettings(window);

  const toggle = window.locator('#demoModeToggle');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();

  // The row must say what it does — this switch swaps the user's entire profile.
  const row = rowFor(window, 'demoModeToggle');
  await expect(row).toContainText('Demo Mode');
  await expect(row).toContainText(/real characters and data are untouched/i);

  // Nothing is active, so no notice.
  await expect(window.locator('#demoModeNotice')).toBeHidden();
});

test('toggling it on persists to config and asks for a restart', async ({ window, profile }) => {
  await openGeneralSettings(window);

  // confirm() would block the run; take the "not now" branch so the app stays up.
  await window.evaluate(() => { window.showConfirm = async () => false; });
  await flip(window, 'demoModeToggle');

  const cfgPath = path.join(profile.userDataDir, 'config.json');
  await expect
    .poll(() => {
      try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.app?.demoMode; }
      catch (_) { return undefined; }
    }, { timeout: 8000 })
    .toBe(true);

  // Enabled but not active yet — the notice has to say so, or the user restarts
  // expecting nothing to have changed.
  await expect(window.locator('#demoModeNotice')).toBeVisible();
  await expect(window.locator('#demoModeNotice')).toContainText(/restart/i);
});

test('toggling it back off clears the flag rather than leaving it set', async ({ window, profile }) => {
  await openGeneralSettings(window);
  await window.evaluate(() => { window.showConfirm = async () => false; });

  const cfgPath = path.join(profile.userDataDir, 'config.json');
  const demoFlag = () => {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.app?.demoMode; }
    catch (_) { return undefined; }
  };

  await flip(window, 'demoModeToggle');
  await expect.poll(demoFlag, { timeout: 8000 }).toBe(true);

  await flip(window, 'demoModeToggle');
  await expect.poll(demoFlag, { timeout: 8000 }).toBe(false);

  // Back to matching reality, so the notice goes away.
  await expect(window.locator('#demoModeToggle')).not.toBeChecked();
  await expect(window.locator('#demoModeNotice')).toBeHidden();
});

test('the toggle does not disturb other settings', async ({ window, profile }) => {
  // setEnabled writes the real config directly rather than going through
  // loadConfig/saveConfig, so it has its own chance to clobber neighbours.
  await openGeneralSettings(window);
  await window.evaluate(() => { window.showConfirm = async () => false; });

  await flip(window, 'minimizeToTrayToggle');
  const cfgPath = path.join(profile.userDataDir, 'config.json');
  await expect
    .poll(() => { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.app?.minimizeToTray; } catch (_) { return undefined; } },
      { timeout: 8000 })
    .toBe(true);

  await flip(window, 'demoModeToggle');
  await expect
    .poll(() => { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8'))?.app?.demoMode; } catch (_) { return undefined; } },
      { timeout: 8000 })
    .toBe(true);

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  expect(cfg.app.minimizeToTray, 'minimize-to-tray must survive the demo toggle').toBe(true);
});
