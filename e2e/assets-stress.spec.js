// ─── Assets at real-user scale ────────────────────────────────────────────────
// The smoke fixture has one character and four assets, so every render path it
// exercises is fast by construction. Real profiles are 90 characters and 100,000+
// items, and the app hangs while building that. This spec runs the REAL renderer
// against a profile that size and reports where the time goes.
//
// Skipped unless asked for, because generating and rendering 100k rows takes
// minutes and has no place in the normal suite:
//
//   node scripts/stress-assets.js --keep                 # build the database
//   npx playwright test e2e/assets-stress.spec.js        # render against it
//
// scripts/stress-assets.js covers the DATA half (queries, no Electron). This
// covers the RENDER half. Keeping them apart is what stops a slow query being
// mistaken for a slow render.
const base = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { buildStressProfile, seedStressUserData, seedStressCharacterDb } = require('./fixtures/seed-stress');

const REPO_ROOT = path.join(__dirname, '..');
const CHARACTERS = Number(process.env.STRESS_CHARS  || 90);
const ASSETS     = Number(process.env.STRESS_ASSETS || 100000);

const test = base.test;
const { expect } = base;

// Opt-in via STRESS=1, always. A kept database only makes the run faster; it must
// never be what decides whether the run happens, or leaving one on disk silently
// adds two minutes to every ordinary `npx playwright test`.
const STRESS_DIR = process.env.EVE_CARBON_STRESS_DIR
  || path.join(os.tmpdir(), 'eve-carbon-stress', `${CHARACTERS}c-${ASSETS}a`);
const HAVE_DB = fs.existsSync(path.join(STRESS_DIR, 'character_information.db'));

test.describe('assets at scale', () => {
  test.skip(!process.env.STRESS,
    'stress run is opt-in — STRESS=1 npx playwright test e2e/assets-stress.spec.js');
  test.describe.configure({ timeout: 15 * 60_000 });

  let app, window, tmpRoot;

  test.beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-stress-run-'));
    const userDataDir = path.join(tmpRoot, 'userData');
    const profile = buildStressProfile({ characters: CHARACTERS, assets: ASSETS });
    await seedStressUserData(userDataDir, profile.chars);

    // Reuse a database that is already there; building 100k rows takes ~30s and
    // there is no reason to pay it twice.
    let dataDir = STRESS_DIR;
    if (!HAVE_DB) {
      dataDir = path.join(tmpRoot, 'data');
      const { charInfoDb } = await seedStressCharacterDb(dataDir, profile);
      await charInfoDb.closeCharacterDb();
    }

    const childEnv = { ...process.env, EVE_CARBON_DATA_DIR: dataDir };
    delete childEnv.ELECTRON_RUN_AS_NODE;   // see the note in support/electron-app.js
    app = await electron.launch({ args: [REPO_ROOT, `--user-data-dir=${userDataDir}`], env: childEnv });
    window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.setContentSize(1600, 1000);
    }).catch(() => {});
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  });

  test('the assets page builds without locking the app', async () => {
    const errors = [];
    window.on('pageerror', (e) => errors.push(e.message));

    const t0 = Date.now();
    await window.locator('.nav-btn[data-page="assets"]').click();
    await expect(window.locator('#page-assets')).toBeVisible({ timeout: 60_000 });

    // Wait for the tree to actually exist, not merely for the page to appear.
    await expect
      .poll(async () => window.locator('#assetTable tbody tr').count(),
            { timeout: 10 * 60_000, intervals: [1000] })
      .toBeGreaterThan(100);
    const firstRows = Date.now() - t0;

    // Settle: keep watching until the row count stops climbing, so the figure is
    // the finished tree rather than a partial one.
    let last = -1, stable = 0, rows = 0;
    while (stable < 3) {
      rows = await window.locator('#assetTable tbody tr').count();
      if (rows === last) stable++; else { stable = 0; last = rows; }
      await window.waitForTimeout(1000);
    }
    const settled = Date.now() - t0;

    // Is the main thread still answering? A render that blocks it is the
    // difference between "slow" and "hung" — and it is what users report.
    const probeStart = Date.now();
    await window.evaluate(() => new Promise(r => requestAnimationFrame(() => r(1))));
    const frameLatency = Date.now() - probeStart;

    const breakdown = await window.evaluate(() => ({
      rows:      document.querySelectorAll('#assetTable tbody tr').length,
      itemRows:  document.querySelectorAll('#assetTable tbody tr.asset-item-row').length,
      locRows:   document.querySelectorAll('#assetTable tbody .asset-loc-value').length,
      cached:    typeof allAssetsCache !== 'undefined' && allAssetsCache ? allAssetsCache.length : 0,
      chunked:   typeof renderNextAssetChunk === 'function'
                   ? renderNextAssetChunk.toString().replace(/\s+/g, ' ').slice(0, 60) : 'absent',
    }));

    console.log('\n─── assets at scale ─────────────────────────────');
    console.log(`characters       ${CHARACTERS}`);
    console.log(`assets in cache  ${breakdown.cached.toLocaleString()}`);
    console.log(`first rows       ${firstRows.toLocaleString()} ms`);
    console.log(`settled          ${settled.toLocaleString()} ms`);
    console.log(`DOM rows         ${breakdown.rows.toLocaleString()} (${breakdown.itemRows.toLocaleString()} items, ${breakdown.locRows.toLocaleString()} locations)`);
    console.log(`frame latency    ${frameLatency.toLocaleString()} ms after settle`);
    console.log(`chunk renderer   ${breakdown.chunked}`);
    console.log('─────────────────────────────────────────────────\n');

    // Not a benchmark assertion — a liveness one. The page must produce rows and
    // must not have thrown while doing it.
    expect(breakdown.rows, 'the tree never rendered a row').toBeGreaterThan(100);
    expect(errors, 'the renderer threw while building the tree').toEqual([]);
  });

  test('sorting a full tree stays responsive', async () => {
    // Sorting re-renders everything. At 100k rows this is the interaction most
    // likely to lock the window, and the one a user hits deliberately.
    const t0 = Date.now();
    await window.locator('#assetTable thead th[data-col-key="price"]').first().click();

    let last = -1, stable = 0;
    while (stable < 3) {
      const rows = await window.locator('#assetTable tbody tr').count();
      if (rows === last) stable++; else { stable = 0; last = rows; }
      await window.waitForTimeout(1000);
    }
    const sortMs = Date.now() - t0;

    const probe = Date.now();
    await window.evaluate(() => new Promise(r => requestAnimationFrame(() => r(1))));
    console.log(`\nsort by price    ${sortMs.toLocaleString()} ms · frame latency after ${Date.now() - probe} ms\n`);

    expect(await window.locator('#assetTable tbody tr').count()).toBeGreaterThan(100);
  });
});
