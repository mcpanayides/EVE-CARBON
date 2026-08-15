// ─── Assets at real-user scale ────────────────────────────────────────────────
// The smoke fixture has one character and a handful of assets, so every render
// path it exercises is fast by construction. Real profiles are 90 characters and
// 100,000+ items, and the app used to hang while building that. This spec runs
// the REAL renderer against a profile that size and reports where the time goes.
//
// Since Phase 2 the interesting number is no longer "how long to build 100,000
// rows" but "how few rows does it build at all". The page queries per view, so
// the DOM should hold about a hundred and twenty location headers regardless of
// how much is owned — and the assertions below are written to FAIL if anyone
// reintroduces the load-everything path.
//
// Skipped unless asked for:
//
//   node scripts/stress-assets.js --keep                 # build the database
//   node scripts/stress-index.js                         # data-layer timings
//   STRESS=1 npx playwright test e2e/assets-stress.spec.js
//
// scripts/stress-index.js covers the DATA half (queries, no Electron). This
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

  test('the assets page opens as locations, not as a hundred thousand rows', async () => {
    const errors = [];
    window.on('pageerror', (e) => errors.push(e.message));

    const t0 = Date.now();
    await window.locator('.nav-btn[data-page="assets"]').click();
    await expect(window.locator('#page-assets')).toBeVisible({ timeout: 60_000 });

    // The index is built by the main process at startup; on a cold 100k profile
    // that takes a few seconds, so wait for the headers rather than a sleep.
    await expect(window.locator('tr.asset-loc-header').first())
      .toBeVisible({ timeout: 10 * 60_000 });
    const firstPaint = Date.now() - t0;

    // Is the main thread still answering? A render that blocks it is the
    // difference between "slow" and "hung" — and it is what users report.
    const probeStart = Date.now();
    await window.evaluate(() => new Promise(r => requestAnimationFrame(() => r(1))));
    const frameLatency = Date.now() - probeStart;

    const breakdown = await window.evaluate(() => ({
      rows:     document.querySelectorAll('#assetTable tbody tr').length,
      locRows:  document.querySelectorAll('#assetTable tbody tr.asset-loc-header').length,
      itemRows: document.querySelectorAll('#assetTable tbody tr.asset-item-row').length,
      summary:  document.getElementById('assetSummary')?.textContent || '',
      priceAge: document.getElementById('assetPriceAge')?.textContent || '',
    }));

    console.log('\n─── assets at scale ─────────────────────────────');
    console.log(`characters       ${CHARACTERS}`);
    console.log(`summary line     ${breakdown.summary}`);
    console.log(`price age        ${breakdown.priceAge}`);
    console.log(`first paint      ${firstPaint.toLocaleString()} ms`);
    console.log(`DOM rows         ${breakdown.rows.toLocaleString()} (${breakdown.locRows} locations, ${breakdown.itemRows} items)`);
    console.log(`frame latency    ${frameLatency.toLocaleString()} ms`);
    console.log('─────────────────────────────────────────────────\n');

    expect(breakdown.locRows, 'no location headers rendered').toBeGreaterThan(0);
    // The regression guard. A hundred thousand assets must not become a hundred
    // thousand table rows; if this fails, the load-everything path is back.
    expect(breakdown.rows, 'the page built far more rows than it has locations')
      .toBeLessThan(2000);
    expect(breakdown.itemRows, 'items were built before anything was expanded')
      .toBe(0);
    expect(errors, 'the renderer threw while building the page').toEqual([]);
  });

  test('expanding a location loads only that location', async () => {
    const before = await window.locator('#assetTable tbody tr').count();

    const t0 = Date.now();
    await window.locator('tr.asset-loc-header').first().click();
    await expect(window.locator('tr.asset-char-header').first()).toBeVisible({ timeout: 30_000 });
    await window.locator('tr.asset-char-header').first().click();
    await expect(window.locator('tr.asset-item-row').first()).toBeVisible({ timeout: 30_000 });
    const expandMs = Date.now() - t0;

    const after = await window.locator('#assetTable tbody tr').count();
    console.log(`\nexpand one hangar  ${expandMs.toLocaleString()} ms · ${before} → ${after} DOM rows\n`);

    // One hangar is a hangar's worth of rows, not the portfolio's.
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeLessThan(6000);
  });

  test('sorting by value stays responsive', async () => {
    // Sorting re-runs the queries. It used to re-sort a 100k-row array in the
    // renderer, which is the interaction most likely to lock the window and the
    // one a user hits deliberately.
    const t0 = Date.now();
    await window.locator('#assetTable thead th[data-col-key="price"]').first().click();
    await expect(window.locator('tr.asset-loc-header').first()).toBeVisible({ timeout: 60_000 });
    const sortMs = Date.now() - t0;

    const probe = Date.now();
    await window.evaluate(() => new Promise(r => requestAnimationFrame(() => r(1))));
    console.log(`\nsort by value    ${sortMs.toLocaleString()} ms · frame latency after ${Date.now() - probe} ms\n`);

    expect(await window.locator('tr.asset-loc-header').count()).toBeGreaterThan(0);
  });

  test('searching filters without loading the portfolio', async () => {
    const t0 = Date.now();
    await window.locator('#assetSearch').fill('tritanium');
    await window.waitForTimeout(1500);            // 200 ms debounce, then one query
    const searchMs = Date.now() - t0;

    const rows = await window.locator('#assetTable tbody tr').count();
    console.log(`\nsearch           ${searchMs.toLocaleString()} ms · ${rows} DOM rows\n`);
    expect(rows).toBeLessThan(2000);

    await window.locator('#assetSearch').fill('');
    await window.waitForTimeout(1500);
  });
});
