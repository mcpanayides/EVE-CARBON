// Settings → General → "Write a diagnostic log", and the bug report that uses it.
//
// The security-relevant assertion is the last one: this report opens a PUBLIC
// GitHub issue, so a token reaching the attached log would be an account
// compromise the reporter cannot undo. src/file_log.js scrubs on the way in;
// this checks the scrubbing survives the whole round trip to the UI.
const { test, expect } = require('./support/electron-app');
const fs = require('fs');
const path = require('path');

const logFile = (profile) => path.join(profile.userDataDir, 'eve-carbon.log');

const openGeneralSettings = async (window) => {
  await window.locator('#openSettingsBtn').click();
  await window.locator('[data-settings-tab="general"]').click();
  await expect(window.locator('#settingsTabGeneral')).toBeVisible({ timeout: 15_000 });
};

// Escape is not bound; the drawer has its own close button.
const closeSettings = async (window) => {
  await window.locator('#closeSettingsBtn').click();
  await expect(window.locator('#uiSettingsDrawer')).toBeHidden();
};

// The native checkbox is visually hidden inside its .switch label (opacity:0 in
// base.css), so the label is what a user actually clicks — same approach as
// demo-mode.spec.js.
const flip = (window, id) =>
  window.locator(`#${id}`).locator('xpath=ancestor::*[contains(@class,"settings-toggle-row")][1]')
        .locator('.switch').click();

test('logging is off until it is switched on, then it writes', async ({ window, profile }) => {
  // Recording what an application does is not something to start unasked.
  await openGeneralSettings(window);
  const toggle = window.locator('#fileLogToggle');
  await expect(toggle).not.toBeChecked();
  expect(fs.existsSync(logFile(profile))).toBe(false);

  await flip(window, 'fileLogToggle');
  await expect(window.locator('#fileLogNotice')).toContainText('Recording to', { timeout: 10_000 });
  await expect(window.locator('#fileLogActions')).toBeVisible();

  // The in-app console mirrors to the file once it is on.
  await window.evaluate(() => logToConsole('e2e marker line', 'info'));
  await expect.poll(() => {
    try { return fs.readFileSync(logFile(profile), 'utf8'); } catch { return ''; }
  }, { timeout: 10_000 }).toContain('e2e marker line');
});

test('the setting survives a page change and reports the file size', async ({ window }) => {
  await openGeneralSettings(window);
  await flip(window, 'fileLogToggle');
  await closeSettings(window);
  await openGeneralSettings(window);
  await expect(window.locator('#fileLogToggle')).toBeChecked();
  await expect(window.locator('#fileLogNotice')).toContainText('eve-carbon.log');
});

test('switching it off stops writing', async ({ window, profile }) => {
  await openGeneralSettings(window);
  await flip(window, 'fileLogToggle');
  await expect(window.locator('#fileLogNotice')).toContainText('Recording to', { timeout: 10_000 });
  await flip(window, 'fileLogToggle');
  await expect(window.locator('#fileLogNotice')).toContainText('Not recording', { timeout: 10_000 });

  await window.evaluate(() => logToConsole('must-not-be-written', 'info'));
  await window.waitForTimeout(500);
  const text = fs.existsSync(logFile(profile)) ? fs.readFileSync(logFile(profile), 'utf8') : '';
  expect(text).not.toContain('must-not-be-written');
});

test('the bug report offers the log only when logging is on', async ({ window }) => {
  await openGeneralSettings(window);
  await expect(window.locator('#fileLogToggle')).not.toBeChecked();

  await window.evaluate(() => openBugReport());
  await expect(window.locator('#bugReportBackdrop')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#bugLogField')).toBeHidden();
  await window.evaluate(() => closeBugReport());
});

test('with logging on, the report attaches a redacted preview of what will be sent', async ({ window, profile }) => {
  await openGeneralSettings(window);
  await flip(window, 'fileLogToggle');
  await expect(window.locator('#fileLogNotice')).toContainText('Recording to', { timeout: 10_000 });

  // A line of exactly the kind that must never reach a public issue.
  const secret = 'SUPERSECRETREFRESHTOKENVALUE';
  await window.evaluate((s) => logToConsole(`auth failed {"refresh_token":"${s}"}`, 'error'), secret);
  await expect.poll(() => {
    try { return fs.readFileSync(logFile(profile), 'utf8'); } catch { return ''; }
  }, { timeout: 10_000 }).toContain('redacted');

  // It never reached the file in the first place.
  expect(fs.readFileSync(logFile(profile), 'utf8')).not.toContain(secret);

  await window.evaluate(() => openBugReport());
  await expect(window.locator('#bugLogField')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#bugIncludeLog')).toBeChecked();
  await expect(window.locator('#bugLogSummary')).toContainText('public GitHub issue');

  // What you see is what leaves the machine — and it carries no secret.
  await window.locator('#bugLogPreviewBtn').click();
  const preview = window.locator('#bugLogPreview');
  await expect(preview).toBeVisible();
  const shown = await preview.textContent();
  expect(shown).not.toContain(secret);
  expect(shown).toContain('redacted');

  await window.evaluate(() => closeBugReport());
});
