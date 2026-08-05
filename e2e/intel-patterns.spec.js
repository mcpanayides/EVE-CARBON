// Early Warning → Patterns.
//
// The panel's job is to report habits WITHOUT lending them more authority than
// their sample warrants, so these specs check both halves of that: that a fresh
// profile refuses to draw anything, and that a seeded one draws the chart, the
// verdict and the corridors — with the sample size on screen next to them.
const { test, expect } = require('./support/electron-app');
const fs = require('fs');
const path = require('path');

const DAY  = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Real system ids, so the SDE resolves them to the names asserted below.
const GM_50Y = 30000544, L_FM3P = 30000540, R78_0R6 = 30000773;

/**
 * A history with an obvious 20:00 habit and one corridor into 78-0R6.
 *
 * Anchored to now rather than a fixed date: the store prunes against the wall
 * clock, so a fixture pinned to a calendar date would quietly age out of the
 * 30-day window and start failing on its own.
 */
function seedHistory(userDataDir) {
  const base = Math.floor((Date.now() - 9 * DAY) / DAY) * DAY;
  const at = (d, h, m = 0) => base + d * DAY + h * HOUR + m * 60_000;

  const presence = [];
  for (let d = 0; d < 8; d++) {
    presence.push({ t: at(d, 20), s: R78_0R6, n: 5 });      // every evening
    presence.push({ t: at(d, (d * 3) % 12), s: L_FM3P, n: 1 });  // scattered otherwise
  }

  // GM-50Y › L-FM3P › 78-0R6, walked on four separate days by different pilots.
  const legs = [];
  for (let d = 0; d < 4; d++) {
    legs.push({ t: at(d, 20, 0), a: GM_50Y, b: L_FM3P, k: `p:roamer${d}` });
    legs.push({ t: at(d, 20, 2), a: L_FM3P, b: R78_0R6, k: `p:roamer${d}` });
  }

  fs.writeFileSync(path.join(userDataDir, 'intel-patterns.json'),
    JSON.stringify({ version: 1, presence, legs }), 'utf8');
}

const openPatterns = async (window) => {
  await window.locator('.nav-btn[data-page="fc"]').click();
  await expect(window.locator('#page-fc')).toBeVisible({ timeout: 15_000 });
  await window.locator('.fc-sub-btn[data-fc-tab="intel"]').click();
  await expect(window.locator('#intelPatternsBtn')).toBeVisible({ timeout: 15_000 });
  await window.locator('#intelPatternsBtn').click();
  await expect(window.locator('.intel-pat-modal')).toBeVisible({ timeout: 20_000 });
};

test('with no history, the panel says so instead of drawing a chart', async ({ window }) => {
  // A chart built from nothing looks exactly as convincing as one built from
  // months of data. Refusing to draw it is the feature.
  await openPatterns(window);
  await expect(window.locator('.intel-pat-notready')).toBeVisible();
  await expect(window.locator('.intel-pat-notready')).toContainText('Not enough history');
  await expect(window.locator('.intel-pat-chart')).toHaveCount(0);
  await expect(window.locator('.intel-pat-sample')).toContainText('0 sightings');
});

test('with history, it reports the hour, the route and the sample behind them', async ({ window, profile }) => {
  seedHistory(profile.userDataDir);
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await openPatterns(window);

  // The sample is on screen next to the claims, not hidden behind a tooltip.
  await expect(window.locator('.intel-pat-sample')).toContainText('8 days');

  // 24 columns — the whole distribution, so the operator sees the data and not
  // only the conclusion — with the evening ones marked.
  await expect(window.locator('.intel-pat-bar')).toHaveCount(24);
  const hot = window.locator('.intel-pat-bar-hot');
  await expect(hot).toHaveCount(1);
  await expect(hot.first()).toHaveAttribute('title', /20:00/);
  await expect(window.locator('.intel-pat-verdict').first()).toContainText('20:00');

  // The corridor, in order, ending at home.
  const route = window.locator('.intel-pat-route').first();
  await expect(route).toContainText('GM-50Y');
  await expect(route).toContainText('L-FM3P');
  await expect(route).toContainText('78-0R6');
  await expect(route.locator('.intel-pat-route-n')).toContainText('4 days');

  // Where they come from.
  await expect(window.locator('.intel-pat-entries')).toContainText('GM-50Y');

  expect(errors).toEqual([]);
});

test('history can be forgotten, for a move to new space', async ({ window, profile }) => {
  seedHistory(profile.userDataDir);
  await openPatterns(window);
  await expect(window.locator('.intel-pat-chart')).toBeVisible();

  window.on('dialog', (d) => d.accept());
  await window.locator('.intel-pat-modal [data-act="clear"]').click();
  await expect(window.locator('.intel-pat-notready')).toBeVisible({ timeout: 10_000 });
});
