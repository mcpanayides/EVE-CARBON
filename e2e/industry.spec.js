// Industry page: the sub-nav tabs switch correctly, and the Blueprints
// library — which reads straight from the local DB (getAllBlueprintsFromDb) —
// shows the 3 fixture blueprints without needing any live ESI call.
const { test, expect } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="industry"]').click();
  await expect(window.locator('#page-industry')).toBeVisible({ timeout: 15_000 });
});

test('Blueprints tab shows the seeded blueprint library', async ({ window }) => {
  await window.locator('.industry-sub-btn[data-industry-tab="blueprints"]').click();
  await expect(window.locator('#bpLibList')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#bpLibCount')).toHaveText('3', { timeout: 10_000 });
  await expect(window.locator('#bpLibList')).toContainText('Rifter Blueprint');
  await expect(window.locator('#bpLibList')).toContainText('Merlin Blueprint');

  // Blueprint thumbnails use the copy-specific image-server variant: originals
  // (Rifter 690, Merlin 691) use /bp, the copy (590) uses /bpc — never a plain
  // /icon (which 400s for blueprints).
  await expect(window.locator('.bp-card-thumb[src*="/types/690/bp?"]')).toHaveCount(1);
  await expect(window.locator('.bp-card-thumb[src*="/types/590/bpc?"]')).toHaveCount(1);
  await expect(window.locator('.bp-card-thumb[src*="/icon?"]')).toHaveCount(0);
});

test('blueprint detail has a clearly-labelled "direct materials" add button', async ({ window }) => {
  await window.locator('.industry-sub-btn[data-industry-tab="blueprints"]').click();
  await expect(window.locator('#bpLibList')).toBeVisible({ timeout: 10_000 });
  await window.locator('.bp-card', { has: window.locator('.bp-card-thumb[src*="/types/690/bp?"]') }).click();
  const addBtn = window.locator('#bpAddToListBtn');
  await expect(addBtn).toBeVisible({ timeout: 10_000 });
  await expect(addBtn).toContainText('DIRECT MATERIALS');   // was ambiguous "ADD TO SHOPPING LIST"
});

test('component tree renders its own "add this breakdown" button', async ({ window }) => {
  // The synthetic fixture blueprints have no SDE materials to build a tree from, so
  // drive renderComponentTreePanel directly with a mineral leaf and confirm the
  // per-breakdown add button (distinct from the detail view's direct-materials one).
  const has = await window.evaluate(async () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    await renderComponentTreePanel(div, { type_id: 587, name: 'Rifter' },
      [{ typeid: 34, name: 'Tritanium', quantity: 100 }]);
    const btn = div.querySelector('#bpTreeAddBtn');
    const tiers = div.querySelectorAll('.tier-btn').length;
    return { addBtn: !!btn, label: btn ? btn.textContent.trim() : '', tiers };
  });
  expect(has.addBtn).toBe(true);
  expect(has.label).toContain('ADD THIS BREAKDOWN');
  expect(has.tiers).toBe(3);   // T1 / T2 / Raw
});

test('Active Jobs tab loads without crashing (no valid ESI token)', async ({ window }) => {
  const errors = [];
  window.on('pageerror', (e) => errors.push(e.message));
  await window.locator('.industry-sub-btn[data-industry-tab="active-jobs"]').click();
  await expect(window.locator('#ajTable')).toBeVisible({ timeout: 10_000 });
  await window.waitForTimeout(1500);
  expect(errors).toEqual([]);
});

test('switching sub-tabs updates the active state', async ({ window }) => {
  const bpBtn = window.locator('.industry-sub-btn[data-industry-tab="blueprints"]');
  const oreBtn = window.locator('.industry-sub-btn[data-industry-tab="ore"]');
  await bpBtn.click();
  await expect(bpBtn).toHaveClass(/active/);
  await oreBtn.click();
  await expect(oreBtn).toHaveClass(/active/);
  await expect(bpBtn).not.toHaveClass(/active/);
});

// Opening a blueprint TWICE. The first open worked; the second used to blank the
// whole page — the detail panel rendered into zero height while the library kept
// the space, so the window looked frozen with no sub-nav and no way back.
//
// The cause was a selector that searched upward for an ancestor whose inline
// style CONTAINED "flex-direction:column". The markup writes that without
// spaces, but the first time JavaScript touches element.style.* the browser
// re-serialises the attribute canonically — with a space — so the selector then
// matched #page-industry instead and hid the entire page.
test('opening a blueprint twice still shows the detail, and never hides the page', async ({ window }) => {
  await window.locator('.industry-sub-btn[data-industry-tab="blueprints"]').click();
  await expect(window.locator('#bpLibList')).toBeVisible({ timeout: 15_000 });

  const open = async (pass) => {
    await window.locator('#bpLibList .bp-view-btn').first().click();
    // Visible, not merely present: the failure mode rendered the whole detail
    // into a container with no height, so "exists" would have passed throughout.
    await expect(window.locator('#backToBpLib'), `pass ${pass}: back button`)
      .toBeVisible({ timeout: 15_000 });
    await expect(window.locator('#page-industry'), `pass ${pass}: the page itself`)
      .toBeVisible();
    const h = await window.locator('#results').evaluate(el => el.getBoundingClientRect().height);
    expect(h, `pass ${pass}: the detail panel has height`).toBeGreaterThan(100);
    await window.locator('#backToBpLib').click();
    await expect(window.locator('#bpLibList')).toBeVisible({ timeout: 10_000 });
  };

  await open(1);
  await open(2);   // used to blank the page
  await open(3);
});
