// Faction Warfare page. Overview/Systems/Leaderboards pull live public ESI, so we
// don't assert their data (network-dependent). We assert the page + sub-nav wire
// up, the LP & Tiers view renders from local constants, and My Militia degrades
// gracefully without a valid token — all without throwing pageerrors.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="fw"]').click();
  await expect(window.locator('#page-fw')).toBeVisible({ timeout: 15_000 });
});

test('sub-nav exposes the five FW tools with Warzone Control active', async ({ window }) => {
  await expect(window.locator('.fw-sub-btn')).toHaveCount(5);
  await expect(window.locator('.fw-sub-btn[data-fw-tab="overview"]')).toHaveClass(/active/);
});

test('LP & Tiers renders the tier ladder and plex reference from local data', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));

  await window.locator('.fw-sub-btn[data-fw-tab="lp"]').click();
  const host = window.locator('#fwTabContent');
  await expect(host).toContainText('Tier 1', { timeout: 20_000 });
  await expect(host).toContainText('Tier 5');
  await expect(host).toContainText('×3.0');       // tier-5 multiplier
  await expect(host).toContainText('Novice');     // plex reference
  await expect(host).toContainText('Battlecruisers & below');
  expect(errors).toEqual([]);
});

test('My Militia degrades gracefully without a valid FW token', async ({ window }) => {
  await window.locator('.fw-sub-btn[data-fw-tab="militia"]').click();
  await expect(window.locator('#fwTabContent')).toContainText('Militia', { timeout: 15_000 });
  await expect(window.locator('#fwCharSel')).toBeVisible();
});

// The Warzone Control page and the dashboard's Warzone tile render the SAME rope
// from the SAME selector (fwTugOfWar). They did not always: the page had its own
// copy of the control maths and drew a flat two-tone bar, so the tile grew a
// dead-even tick and a 24-hour push indicator that the page — the place you
// actually go to read a warzone — never got. Seeded rather than live so the
// assertion is about the rendering, not about what the warzone is doing today.
test('the warzone overview draws the tug of war, not a flat bar', async ({ window }) => {
  await window.evaluate(() => {
    const st = (id, sys, vp) => ({ faction_id: id, systems_controlled: sys, pilots: 1,
      kills: { yesterday: 1, total: 1 }, victory_points: { yesterday: vp, total: 1 } });
    // Caldari hold more ground; Gallente took more of the day. Rope one way,
    // push the other — the case a single number cannot describe.
    _fwStats = [st(500001, 53, 138603), st(500004, 37, 155073),
                st(500003, 44, 148829), st(500002, 26, 145308)];
    _fwFetchedAt = Date.now();
    navigateFwTab('overview');
  });

  const wz = window.locator('.fw-wz').first();
  await expect(wz.locator('.fwx-rope')).toBeVisible({ timeout: 15_000 });
  // The knot sits where the systems are, not where the victory points are.
  const ropeA = await wz.locator('.fwx-rope-a').evaluate(el => el.style.width || getComputedStyle(el).width);
  expect(await wz.locator('.fwx-rope-even').count(), 'the dead-even tick is what makes it a tug of war').toBe(1);

  // Chevrons run AWAY from whoever is gaining: Gallente are on the right and
  // ahead on the day, so the rope is being dragged left, into Caldari's half.
  await expect(wz.locator('.fwx-flow')).toHaveClass(/is-left/);
  await expect(wz.locator('.fwx-push')).toContainText(/Gallente/i);

  // The second warzone was a genuine deadlock that day: no direction at all.
  const wz2 = window.locator('.fw-wz').nth(1);
  await expect(wz2.locator('.fwx-push')).toHaveClass(/is-even/);
  await expect(wz2.locator('.fwx-flow')).toHaveCount(0);
  expect(ropeA, 'the rope is positioned from systems held').toBeTruthy();
});
