// A real demo launch, end to end: every page has something to show, and demo
// mode never asks the network for anything it has no answer for.
//
// The Settings-toggle spec (demo-mode.spec.js) stops short of restarting into
// demo mode, because the demo profile used to be one fixed global folder.
// EVE_CARBON_DEMO_DIR moves it, so this launches a REAL demo profile in a temp
// directory — the seeder, the fixtures and the renderer seed all run for real.
//
// One launch for the whole file: seeding and the first paint take most of the
// time, and every assertion below reads a different page of the same profile.
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');

let app, win, tmp;
const mainLog = [];

test.describe.configure({ mode: 'serial', timeout: 90_000 });

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-demo-e2e-'));
  // See e2e/support/electron-app.js on why ELECTRON_RUN_AS_NODE must be deleted
  // rather than blanked, and what EVE_CARBON_E2E switches off.
  const env = { ...process.env, EVE_CARBON_DEMO_DIR: path.join(tmp, 'demo'), EVE_CARBON_E2E: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.EVE_CARBON_DATA_DIR;      // demo mode sets its own
  app = await electron.launch({ args: [REPO, `--user-data-dir=${path.join(tmp, 'real')}`, '--demo'], env });
  app.process().stdout.on('data', d => mainLog.push(String(d)));
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w) w.setContentSize(1600, 1000); }).catch(() => {});
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  for (let i = 0; i < 12; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
    catch (_) { await new Promise(r => setTimeout(r, 250)); }
  }
});

async function openPage(page) {
  await win.locator(`.nav-btn[data-page="${page}"]`).first().click();
  await expect(win.locator(`#page-${page}`)).toBeVisible({ timeout: 15_000 });
}
const tool = (page, label) => win.locator(`#page-${page} .industry-sub-btn`, { hasText: label }).first().click();

test('the demo opens on the main pilot, seeded', async () => {
  await expect.poll(() => mainLog.join('').includes('[demo] seeded 3 characters'), { timeout: 30_000 }).toBe(true);
  await expect(win.locator('.dashboard-welcome-name')).toHaveText('Kaska Vaelin', { timeout: 20_000 });
});

test('the Total line in Wealth Growth glows in the main colour, not red', async () => {
  // The glow was hard-coded red (rgba 255, 32, 16) and stayed red after the line
  // itself moved to the accent: a pink line glowing red. Both now come from --accent.
  const total = () => win.evaluate(() => {
    const c = document.querySelector('#dashboardWealthGrowth canvas');
    const ds = c && c._chartInstance && c._chartInstance.data.datasets.find(x => x._isTotal);
    return ds ? { line: ds.borderColor, glow: ds._glow } : null;
  });
  await expect.poll(total, { timeout: 20_000 }).toEqual({ line: '#e6a5e6', glow: 'rgba(230, 165, 230, 0.8)' });

  // Another main colour, as the palette's picker sets it: the glow goes with it.
  await win.evaluate(() => { document.documentElement.style.setProperty('--accent', '#33ccff'); loadDashboard(); });
  await expect.poll(total, { timeout: 20_000 }).toEqual({ line: '#33ccff', glow: 'rgba(51, 204, 255, 0.8)' });
  // And what is actually painted: just above each point is glow, and it is blue.
  // (A red shadow hard-coded in the plugin again would paint it red.)
  await expect.poll(() => win.evaluate(() => {
    const c = document.querySelector('#dashboardWealthGrowth canvas');
    const chart = c && c._chartInstance;
    if (!chart || chart.animating) return null;
    const i = chart.data.datasets.findIndex(x => x._isTotal);
    const r = chart.currentDevicePixelRatio || 1;
    const ctx = c.getContext('2d');
    let red = 0, blue = 0;
    for (const p of chart.getDatasetMeta(i).data) {
      const px = ctx.getImageData(Math.round(p.x * r), Math.round((p.y - 9) * r), 1, 1).data;
      red += px[0]; blue += px[2];
    }
    return blue > red * 1.5;
  }), { timeout: 10_000 }).toBe(true);
  await win.evaluate(() => { document.documentElement.style.removeProperty('--accent'); loadDashboard(); });
  await expect.poll(total, { timeout: 20_000 }).toEqual({ line: '#e6a5e6', glow: 'rgba(230, 165, 230, 0.8)' });
});

test('skill queues train, on all three pilots', async () => {
  await openPage('skills');
  await tool('skills', 'Active Queues');
  await expect(win.locator('.sk-queues')).toContainText('3 characters', { timeout: 15_000 });
  await expect.poll(() => win.locator('.sk-q-row').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(8);
});

test('warzone control shows both warzones', async () => {
  await openPage('fw');
  await expect(win.locator('#page-fw')).toContainText('Caldari–Gallente Warzone', { timeout: 15_000 });
  await expect(win.locator('#page-fw')).toContainText('Amarr–Minmatar Warzone');
  await expect(win.locator('#page-fw')).toContainText(/\d+ systems/);
});

test('the calendar fills the month rather than three days of it', async () => {
  await openPage('calendar');
  await expect.poll(async () => win.locator('.cal-cell:not(.cal-cell-dim)').evaluateAll(
    cells => cells.filter(c => c.querySelector('.cal-chip')).length), { timeout: 20_000 }).toBeGreaterThanOrEqual(18);
});

test('the forum is signed in and served locally', async () => {
  await openPage('forums');
  await expect(win.locator('#forumStatusLabel')).toHaveText('Logged in', { timeout: 15_000 });
  await expect.poll(() => win.locator('#forumWebview').evaluate(w => w.getAttribute('src') || ''), { timeout: 10_000 })
    .toContain('forum.vaelin.example');
});

test('Jabber has a feed of broadcasts and joined rooms', async () => {
  await openPage('jabber');
  await expect.poll(() => win.locator('#jabberTable tbody tr').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(25);
  await expect(win.locator('#page-jabber')).toContainText('Vaelin Ops');
});

test('PI lists six working colonies, with our own planet art in the detail view', async () => {
  await openPage('pi');
  await expect.poll(() => win.locator('.pi-card').count(), { timeout: 30_000 }).toBe(6);
  await win.locator('text=View Details').first().click();
  // The hero comes from assets/planets, not CCP's icon endpoint.
  await expect.poll(() => win.evaluate(() => {
    const img = document.querySelector('#piDetailBackdrop img, .pi-detail-hero img');
    return img ? img.getAttribute('src') : '';
  }), { timeout: 10_000 }).toMatch(/planets[\\/]+barren\.jpg/);
  await win.keyboard.press('Escape');
});

test('cost indices load for the whole cluster', async () => {
  await openPage('industry');
  await tool('industry', 'Cost Index');
  await expect(win.locator('#page-industry')).toContainText(/Showing 5,\d{3} systems/, { timeout: 20_000 });
});

test('early warning lists its contacts and the channels it watches', async () => {
  await openPage('fc');
  await win.locator('.fc-sub-btn[data-fc-tab="intel"]').click();
  await expect(win.locator('#intelStatusLine')).toContainText('Watching vaelin.intel', { timeout: 15_000 });
  await expect.poll(() => win.locator('#intelContacts .ir-row:not(.ir-head)').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expect(win.locator('#intelContacts')).toContainText('3-DMQT');
});

test('moon extractions list the corp chunks, with the moons named', async () => {
  await openPage('industry');
  await tool('industry', 'Mining Ledger');
  await win.locator('#page-industry .ml-bar button', { hasText: 'Moon Extractions' }).first().click();
  await expect(win.locator('#mlBody')).toContainText('319-3D VII - Moon 1', { timeout: 15_000 });
  await expect(win.locator('#mlBody')).toContainText('Corp miners');
});

test('demo mode asked the network for nothing it could not answer', async () => {
  // Every unanswered request logs one "[demo] no fixture" line (demo_fixtures.js
  // miss()). A page that quietly renders empty in demo mode starts here.
  const misses = mainLog.join('').split('\n').filter(l => l.includes('[demo] no fixture'));
  expect(misses, misses.join('\n')).toEqual([]);
});
