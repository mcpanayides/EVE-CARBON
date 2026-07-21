// ─── e2e/support/electron-app.js ──────────────────────────────────────────────
// Shared Playwright fixture: launches the real app against an isolated,
// seeded profile (see e2e/fixtures/seed.js) so specs assert against real
// rendered data without touching the developer's actual EVE Carbon profile,
// and without needing live ESI/SSO credentials.
//
//   const { test, expect } = require('../support/electron-app');
//   test('...', async ({ window }) => { ... });
//
// `window` is the main BrowserWindow's Playwright Page — use it exactly like
// a normal Playwright page (page.click, page.locator, expect(locator)...).
// ─────────────────────────────────────────────────────────────────────────────

const base = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedUserData, seedCharacterDb, FAKE_CHAR_ID, FAKE_CHAR_NAME } = require('../fixtures/seed');

const REPO_ROOT = path.join(__dirname, '..', '..');

const test = base.test.extend({
  // Fresh isolated userData + character DB per test, torn down after.
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-e2e-'));
    const userDataDir = path.join(tmpRoot, 'userData');
    const dataDir = path.join(tmpRoot, 'data');

    await seedUserData(userDataDir);
    const charInfoDb = await seedCharacterDb(dataDir);
    // Close our seeding connection before the app opens its own — avoids two
    // writable handles to the same WAL-mode file across processes at startup
    // (Windows file locking is stricter here than POSIX).
    await charInfoDb.closeCharacterDb();

    // Electron's own bootstrap checks ELECTRON_RUN_AS_NODE for PRESENCE, not
    // truthiness — setting it to '' still trips "run as plain Node" and the
    // real app (which expects `app`, `BrowserWindow`, etc.) fails to launch.
    // Claude Code's sandboxed shells set this to '1' for their own JS tool
    // execution (see project memory: "Electron launch env"), so it must be
    // `delete`d from the child's env, not merely blanked. `env -u` on the CLI
    // does the same thing for a plain terminal launch.
    const childEnv = { ...process.env, EVE_CARBON_DATA_DIR: dataDir };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const app = await electron.launch({
      args: [REPO_ROOT, `--user-data-dir=${userDataDir}`],
      env: childEnv,
    });

    await use(app);

    await app.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await use(window);
  },
});

const expect = base.expect;
module.exports = { test, expect, FAKE_CHAR_ID, FAKE_CHAR_NAME };
