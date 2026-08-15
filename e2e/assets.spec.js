// Assets page: queried per view from the materialised index (src/asset_index.js)
// rather than loaded whole. No live ESI call — the fixture seeds the asset rows
// AND the prices, and the app builds its index from them at startup, so these
// assertions run against the real query path with no network.
//
// The page now opens COLLAPSED: a list of locations, drilled into by clicking.
// That is the substantive change these tests are pinning — the DOM holds what is
// on screen, not one row per asset owned.
const { test, expect, FAKE_CHAR_NAME } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="assets"]').click();
  await expect(window.locator('#page-assets')).toBeVisible({ timeout: 15_000 });
  // The index is built by the main process at startup; wait for the first
  // location header rather than a fixed sleep.
  await expect(window.locator('tr.asset-loc-header').first()).toBeVisible({ timeout: 20_000 });
});

/** Open the Jita location group and the character inside it. */
async function openJitaHangar(window) {
  await window.locator('tr.asset-loc-header', { hasText: 'Jita' }).first().click();
  const charHeader = window.locator('tr.asset-char-header', { hasText: FAKE_CHAR_NAME }).first();
  await expect(charHeader).toBeVisible({ timeout: 10_000 });
  await charHeader.click();
  await expect(window.locator('tr.asset-item-row').first()).toBeVisible({ timeout: 10_000 });
}

test('opens as a list of locations, with no item rows until one is expanded', async ({ window }) => {
  await expect(window.locator('tr.asset-loc-header', { hasText: 'Jita' })).toHaveCount(1);
  // The whole point of Phase 2: nothing below the headers has been built yet.
  await expect(window.locator('tr.asset-item-row')).toHaveCount(0);
  await expect(window.locator('tr.asset-char-header')).toHaveCount(0);
});

test('expanding a location then a character reveals its items', async ({ window }) => {
  await openJitaHangar(window);
  const wrapper = window.locator('#assetTableWrapper');
  await expect(wrapper).toContainText('Tritanium');
  await expect(wrapper).toContainText('Rifter');
});

test('collapsing a location removes its rows from the DOM', async ({ window }) => {
  await openJitaHangar(window);
  await expect(window.locator('tr.asset-item-row').first()).toBeVisible();

  await window.locator('tr.asset-loc-header', { hasText: 'Jita' }).first().click();
  // Removed, not hidden — that is what keeps the page proportional to the
  // screen rather than to the size of the hangar.
  await expect(window.locator('tr.asset-item-row')).toHaveCount(0);
  await expect(window.locator('tr.asset-char-header')).toHaveCount(0);
});

test('blueprints show BPO/BPC icons and an original-vs-copy category label', async ({ window }) => {
  await openJitaHangar(window);
  const wrapper = window.locator('#assetTableWrapper');

  // Category column spells out original vs copy instead of a bare "Blueprint".
  await expect(wrapper).toContainText('Blueprint Original');
  await expect(wrapper).toContainText('Blueprint Copy');

  // Icons use the blueprint-specific image-server variants (plain /icon 400s for
  // blueprints): originals use /bp, copies use /bpc — different colours in-game.
  await expect(window.locator('img.asset-type-icon[src*="/types/690/bp?"]')).toHaveCount(1);
  await expect(window.locator('img.asset-type-icon[src*="/types/590/bpc?"]')).toHaveCount(1);
});

test('character filter dropdown is populated from the fixture character', async ({ window }) => {
  const charFilter = window.locator('#assetCharFilter');
  await expect(charFilter.locator('option', { hasText: FAKE_CHAR_NAME })).toHaveCount(1);
});

// A container is priced by what is inside it. An Asset Safety Wrap's own type is
// worthless, so before this it read N/A while holding a fortune in modules —
// which is precisely the number you need to decide whether to pay to unwrap it.
test('containers show the value of their contents', async ({ window }) => {
  await openJitaHangar(window);

  const wrapRow = window.locator('tr.asset-item-row', { hasText: 'Asset Safety Wrap' }).first();
  await expect(wrapRow).toBeVisible();

  // 1,000,000 (Damage Control II) + 2 × 250,000 (Reinforced Bulkheads II).
  const priceCell = wrapRow.locator('td.asset-item-price-cell');
  await expect(priceCell).toContainText('1,500,000');
  await expect(priceCell).toHaveClass(/price-contents/);
  await expect(priceCell).toHaveAttribute('title', /contents/);
});

test('a container hides its contents until its chevron is clicked', async ({ window }) => {
  await openJitaHangar(window);
  const contents = window.locator('tr.asset-item-row', { hasText: 'Damage Control II' }).first();
  await expect(contents).toBeHidden();

  await window.locator('tr.asset-item-row', { hasText: 'Asset Safety Wrap' })
    .first().locator('.asset-ship-chevron').click();
  await expect(contents).toBeVisible();
});

test('sorting by value ranks locations by what they hold', async ({ window }) => {
  // The reported bug: sorting by price ordered items inside each station while
  // leaving the stations themselves in region order, so at the level you were
  // reading it the list was not sorted at all.
  await window.locator('#assetTable thead th[data-col-key="price"]').click();
  const first = window.locator('tr.asset-loc-header').first();
  await expect(first).toContainText('Jita');
});

test('the search box filters without loading every asset', async ({ window }) => {
  await window.locator('#assetSearch').fill('tritanium');
  // Debounced at 200 ms, then one query.
  await expect(window.locator('#assetSummary')).toContainText('filtered from', { timeout: 5_000 });
  await expect(window.locator('tr.asset-loc-header')).toHaveCount(1);
});

// Searching by ship class, end to end: the group name comes from the bundled
// SDE via the index rebuild, so this only passes if that whole path is wired.
// A Rifter is in the Frigate group; nothing in the fixture is named "frigate".
test('searching a ship class finds hulls of that class by name', async ({ window }) => {
  await window.locator('#assetSearch').fill('frigate');
  await expect(window.locator('#assetSummary')).toContainText('filtered from', { timeout: 5_000 });

  await openJitaHangar(window);
  const wrapper = window.locator('#assetTableWrapper');
  await expect(wrapper).toContainText('Rifter');
  await expect(wrapper).not.toContainText('Tritanium');
});

test('a plural class name works as well as the singular', async ({ window }) => {
  // Group names are singular; people type plurals. Without the stored plural
  // "frigates" finds nothing while "frigate" finds everything, which reads as
  // the search being broken.
  await window.locator('#assetSearch').fill('frigates');
  await expect(window.locator('#assetSummary')).toContainText('filtered from', { timeout: 5_000 });
  await openJitaHangar(window);
  await expect(window.locator('#assetTableWrapper')).toContainText('Rifter');
});

// Text left, numbers right — and the header must read the same way as the cell
// under it. This regressed because the Characters page has its own table using
// the class name .asset-table, and its ".asset-table td { text-align: left }"
// outranked every per-cell rule here: headers stayed right while every cell went
// left. A cross-page class collision is exactly the kind of thing that comes
// back, so the alignment is asserted rather than eyeballed.
test('every column header reads the same way as the cells under it', async ({ window }) => {
  await openJitaHangar(window);

  const cols = await window.evaluate(() => {
    const ths = [...document.querySelectorAll('#assetTable thead th')];
    const tds = [...document.querySelector('#assetTable tbody tr.asset-item-row').children];
    return ths.map((th, i) => ({
      key: th.dataset.colKey,
      th: getComputedStyle(th).textAlign,
      td: getComputedStyle(tds[i]).textAlign,
      width: th.style.width,
    }));
  });

  const RIGHT = ['qty', 'vol', 'meta', 'tech', 'price'];
  const LEFT  = ['name', 'group', 'category', 'slot'];

  for (const c of cols) {
    expect(c.th, `${c.key}: header and cell disagree`).toBe(c.td);
    if (RIGHT.includes(c.key)) expect(c.th, `${c.key} should be right-aligned`).toBe('right');
    if (LEFT.includes(c.key))  expect(c.th, `${c.key} should be left-aligned`).toBe('left');
    // Every column gets a width. The defaults list had five entries for ten
    // columns, so the last five were set to "undefinedpx" and silently ignored.
    expect(c.width, `${c.key} has no column width`).toMatch(/^\d+px$/);
  }
});

test('the page says how old its prices are', async ({ window }) => {
  // Values are materialised, so this label is the only thing telling the user
  // whether the ISK figures are current.
  await expect(window.locator('#assetPriceAge')).toContainText(/Prices/, { timeout: 10_000 });
});
