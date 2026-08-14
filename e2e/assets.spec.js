// Assets page: reads straight from the local DB (character_info_db.getCharacterAssets,
// via the get-character-assets-db IPC) — no live ESI call — so the fixture's seeded
// asset rows (Tritanium, a Rifter, a blueprint original + a copy) render without any
// network access.
const { test, expect, FAKE_CHAR_NAME } = require('./support/electron-app');

test.beforeEach(async ({ window }) => {
  await window.locator('.nav-btn[data-page="assets"]').click();
  await expect(window.locator('#page-assets')).toBeVisible({ timeout: 15_000 });
});

test('shows the seeded asset rows grouped by location', async ({ window }) => {
  const wrapper = window.locator('#assetTableWrapper');
  await expect(wrapper).toContainText('Tritanium', { timeout: 10_000 });
  await expect(wrapper).toContainText('Rifter');
  await expect(wrapper).toContainText('Jita');
});

test('blueprints show BPO/BPC icons and an original-vs-copy category label', async ({ window }) => {
  const wrapper = window.locator('#assetTableWrapper');
  await expect(wrapper).toContainText('Tritanium', { timeout: 10_000 });

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
  await expect(window.locator('#assetTableWrapper')).toContainText('Tritanium', { timeout: 10_000 });
  await expect(charFilter.locator('option', { hasText: FAKE_CHAR_NAME })).toHaveCount(1);
});

// A container is priced by what is inside it. An Asset Safety Wrap's own type is
// worthless, so before this it read N/A while holding a fortune in modules —
// which is precisely the number you need to decide whether to pay to unwrap it.
test('containers show the value of their contents', async ({ window }) => {
  await window.locator('.nav-btn[data-page="assets"]').click();
  await expect(window.locator('#page-assets')).toBeVisible({ timeout: 15_000 });

  const result = await window.evaluate(() => {
    // Prices for three made-up types: the wrap is worth nothing, its contents
    // are worth 1m and 250k, and a loose item alongside is worth 500k.
    priceCache[9001] = { sell: 0 };        // Asset Safety Wrap
    priceCache[9002] = { sell: 1_000_000 };
    priceCache[9003] = { sell: 250_000 };
    priceCache[9004] = { sell: 500_000 };

    const tbody = document.querySelector('#assetTable tbody');
    tbody.innerHTML = '';
    const row = (itemId, typeId, qty, parentId) => {
      const tr = document.createElement('tr');
      tr.className = 'asset-item-row';
      tr.dataset.itemId = String(itemId);
      tr.dataset.typeId = String(typeId);
      tr.dataset.quantity = String(qty);
      tr.dataset.isBpc = '';
      tr.dataset.parentId = parentId ? String(parentId) : '';
      tr.dataset.locKey = 'L1';
      tr.dataset.charKey = 'C1';
      tr.innerHTML = `<td class="asset-item-price-cell" data-type-id="${typeId}"
                          data-quantity="${qty}" data-item-id="${itemId}"
                          data-is-bpc="">Loading…</td>`;
      return tr;
    };
    tbody.append(
      row(1, 9001, 1, null),   // the wrap
      row(2, 9002, 1, 1),      // inside it
      row(3, 9003, 2, 1),      // inside it, qty 2
      row(4, 9004, 1, null),   // loose alongside
    );

    _updateAssetPriceCells();
    const cell = (itemId) =>
      tbody.querySelector(`td[data-item-id="${itemId}"]`).textContent.trim();
    return {
      wrap:  cell(1),
      loose: cell(4),
      wrapTitle: tbody.querySelector('td[data-item-id="1"]').title,
      marked: tbody.querySelector('td[data-item-id="1"]').classList.contains('price-contents'),
    };
  });

  // 1,000,000 + (250,000 × 2) = 1.5m, not N/A.
  expect(result.wrap).toMatch(/1\.5[0-9]*\s*M?\s*ISK|1,500,000\s*ISK/);
  expect(result.marked).toBe(true);
  expect(result.wrapTitle).toContain('contents');
  // An item that contains nothing is unaffected.
  expect(result.loose).toMatch(/500|0\.5/);
});
