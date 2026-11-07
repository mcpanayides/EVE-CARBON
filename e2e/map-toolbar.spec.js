// The Galaxy Map's toolbar: one row of labelled controls. View, then Layout
// (Spatial) or Region (Schematic); Overlay and Layers, which fold into menus
// whose triggers name what's on; Plan; Find. It used to be eleven overlay
// segments and seven loose buttons over two rows, with the layer toggles split
// between them.
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.waitForFunction(() => _loaded, null, { timeout: 30_000 });
}

/** The distinct rows the toolbar's visible controls sit on (by their vertical centres). */
const toolbarRows = (window) => window.evaluate(() => {
  const items = [...document.querySelectorAll('.map-toolbar > *')].filter(el => el.offsetParent);
  const rows = new Set(items.map(el => { const r = el.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2 / 10); }));
  return rows.size;
});

const overlayMenu = (w) => w.locator('#mapOverlayMenu');
const layersMenu  = (w) => w.locator('#mapLayersMenu');

test('one row on an ordinary window, in both views, with each control shown only where it works', async ({ window }) => {
  await openMap(window);
  const heights = () => window.evaluate(() => ({
    header: document.querySelector('#page-map .page-header').getBoundingClientRect().height,
    controls: [...new Set([...document.querySelectorAll('.map-toolbar > *')].filter(e => e.offsetParent)
      .map(e => e.getBoundingClientRect().height))],
  }));
  // Spatial opens: Layout is there, Region is not (it used to show here, and
  // picking a region from it left Layout up in Schematic).
  await expect(window.locator('#mapLayoutGroup')).toBeVisible();
  await expect(window.locator('#mapRegionGroup')).toBeHidden();
  expect(await toolbarRows(window), 'Spatial, 1600 px window').toBe(1);
  const spatial = await heights();
  expect(spatial.controls, 'every control one height').toEqual([28]);

  await window.locator('.map-view-btn[data-view="modern"]').click();
  await expect(window.locator('#mapLayoutGroup')).toBeHidden();
  await expect(window.locator('#mapRegionGroup')).toBeVisible();
  expect(await toolbarRows(window), 'Schematic, 1600 px window').toBe(1);
  // Layout and Region swap places without the header changing height, which
  // would resize the map and nudge its camera half a pixel.
  expect(await heights()).toEqual(spatial);

  // The region picker changing the view keeps the toolbar truthful.
  await window.locator('.map-view-btn[data-view="spatial"]').click();
  await window.evaluate(() => {
    _populateRegionSelect();
    const sel = document.getElementById('mapRegionSelect');
    sel.value = sel.options[1].value;
    sel.dispatchEvent(new Event('change'));
  });
  await expect(window.locator('.map-view-btn[data-view="modern"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(window.locator('.map-view-btn[data-view="spatial"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(window.locator('#mapLayoutGroup')).toBeHidden();
});

test('Overlay: a menu of every overlay, grouped, that names the one on and closes once one is picked', async ({ window }) => {
  await openMap(window);
  const trigger = window.locator('#mapOverlayTrigger');
  await expect(trigger).toContainText('Natural');
  await expect(overlayMenu(window)).toBeHidden();

  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(overlayMenu(window)).toBeVisible();
  await expect(overlayMenu(window).locator('.map-overlay-btn')).toHaveCount(11);
  await expect(overlayMenu(window).locator('.map-menu-heading')).toHaveText(['Stars', 'Territory', 'Last hour', 'PvE and industry']);

  await window.locator('.map-overlay-btn[data-overlay="security"]').click();
  await expect(overlayMenu(window)).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toContainText('Security');
  await expect(trigger).toBeFocused();
  expect(await window.evaluate(() => _overlay)).toBe('security');
  await expect(window.locator('.map-overlay-btn[data-overlay="security"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(window.locator('.map-overlay-btn[data-overlay="natural"]')).toHaveAttribute('aria-pressed', 'false');

  // A press anywhere else closes it without changing anything.
  await trigger.click();
  await expect(overlayMenu(window)).toBeVisible();
  await window.locator('#mapCanvas').click({ position: { x: 1150, y: 90 } });   // well right of the panel
  await expect(overlayMenu(window)).toBeHidden();
  expect(await window.evaluate(() => _overlay)).toBe('security');

  // "View on map" from the dashboard switches the overlay from code: the trigger follows.
  await window.evaluate(() => window.mapJumpToSystem(30000142));
  await expect(trigger).toContainText('Incursions');
});

test('Layers: switches that stay open for the next, and a trigger that shows what is on', async ({ window }) => {
  await openMap(window);
  const trigger = window.locator('#mapLayersTrigger');
  const on = () => window.evaluate(() => ({ jb: _showJb, wh: _showWh, inf: _showInf, fp: _showFp }));
  // Bridges and wormholes open switched on.
  await expect(window.locator('#mapLayersValue > [data-layer]')).toHaveCount(2);
  await expect(trigger).toHaveAttribute('aria-label', 'Layers: Jump bridges, Wormholes');

  await trigger.click();
  await window.locator('#mapInfToggle').click();
  await expect(layersMenu(window), 'a switch leaves the menu open').toBeVisible();
  await window.locator('#mapWhToggle').click();
  expect(await on()).toEqual({ jb: true, wh: false, inf: true, fp: false });
  await expect(window.locator('#mapInfToggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(trigger).toHaveAttribute('aria-label', 'Layers: Jump bridges, Influence');
  await expect(window.locator('#mapLayersValue > [data-layer]')).toHaveCount(2);

  await window.keyboard.press('Escape');
  await expect(layersMenu(window)).toBeHidden();
  await expect(trigger).toBeFocused();

  // All off: the trigger says so.
  await trigger.click();
  await window.locator('#mapJbToggle').click();
  await window.locator('#mapInfToggle').click();
  await expect(window.locator('#mapLayersValue')).toHaveText('None');
  await expect(trigger).toHaveAttribute('aria-label', 'Layers: none');
});

test('the keyboard: arrow down opens on the one that is on, arrows move, Esc closes back to the trigger', async ({ window }) => {
  await openMap(window);
  await window.locator('#mapLayoutTrigger').focus();
  await window.keyboard.press('ArrowDown');
  await expect(window.locator('#mapLayoutMenu')).toBeVisible();
  await expect(window.locator('.map-layout-btn[data-layout="system"]')).toBeFocused();
  await window.keyboard.press('ArrowDown');
  await expect(window.locator('.map-layout-btn[data-layout="constellation"]')).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(window.locator('#mapLayoutMenu')).toBeHidden();
  await expect(window.locator('#mapLayoutValue')).toHaveText('Constellation');
  expect(await window.evaluate(() => _spatialLayout)).toBe('constellation');

  // Flat is a switch inside the same menu: it flips and the menu stays.
  await window.keyboard.press('ArrowDown');
  await window.keyboard.press('End');
  await expect(window.locator('#mapFlatBtn')).toBeFocused();
  await window.keyboard.press('Enter');
  expect(await window.evaluate(() => _camFlat)).toBe(true);
  await expect(window.locator('#mapLayoutMenu')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(window.locator('#mapLayoutMenu')).toBeHidden();
  await expect(window.locator('#mapLayoutTrigger')).toBeFocused();

  // One menu at a time.
  await window.locator('#mapOverlayTrigger').click();
  await window.locator('#mapLayersTrigger').click();
  await expect(overlayMenu(window)).toBeHidden();
  await expect(layersMenu(window)).toBeVisible();
});

test('a narrow window wraps whole controls, never splitting one', async ({ window, electronApp }) => {
  await openMap(window);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 860));
  await window.waitForTimeout(400);
  const split = await window.evaluate(() =>
    [...document.querySelectorAll('.map-toolbar > *')].filter(el => el.offsetParent).some(el => {
      // A control on two lines is taller than one row of it.
      const kids = [...el.querySelectorAll('button, select, input')].filter(k => k.offsetParent && !k.closest('.map-menu-panel'));
      const tops = new Set(kids.map(k => Math.round(k.getBoundingClientRect().top)));
      return tops.size > 1;
    }));
  expect(split).toBe(false);
  expect(await toolbarRows(window)).toBeGreaterThan(1);
});
