// The selected system wears a ring, the way "you are here" does: in the accent,
// a size up from that ring so the two nest on one star, and named off to its
// right. Spatial and the Schematic overview draw it. Classic always had its
// own, and a Schematic region outlines the system's pill instead.
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
}

/** Flown in over Scalding Pass with G15Z-W in the middle; returns its id. */
function overG15Z(window) {
  return window.evaluate(() => {
    _viewMode = 'spatial'; _camFlat = false; _overlay = 'natural'; _fitSpatial();
    const g = _systems.find(s => s.name === 'G15Z-W');
    _camFocusX = g.tx; _camFocusY = g.ty; _camFocusZ = g.tz;
    _camYaw = -1.5597; _camPitch = 0.90375;
    _camZoom = 26266 / _spatialScale();
    _camPanX = 0; _camPanY = 0;
    _render();
    return g.id;
  });
}

/**
 * Pixels on the map canvas within a few RGB steps of `hex`, in the box dx0..dx1
 * across and dy0..dy1 down from a system, in whichever view is up. With `ring`,
 * the box is ignored: it counts which of 24 points `ring` px round the system
 * have that colour at or beside them.
 */
function paint(window, id, hex, { dx0 = 0, dx1 = 0, dy0 = 0, dy1 = 0, ring = 0 } = {}) {
  return window.evaluate(({ id, hex, dx0, dx1, dy0, dy1, ring }) => {
    let c;
    if (_viewMode === 'spatial') c = _spatialCanvasOf(id);
    else {
      const p = (_regionView != null ? _regionLayout : _galaxyModern.gpos).get(id);
      c = _w2c(p.x, p.z);
    }
    const [R, G, B] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const near = (d, i) => d[i + 3] > 100 && Math.abs(d[i] - R) + Math.abs(d[i + 1] - G) + Math.abs(d[i + 2] - B) < 60;
    let n = 0;
    if (ring) {
      for (let k = 0; k < 24; k++) {
        const a = k * Math.PI / 12;
        const d = _ctx.getImageData(Math.round(c[0] + ring * Math.cos(a)) - 1, Math.round(c[1] + ring * Math.sin(a)) - 1, 3, 3).data;
        for (let i = 0; i < d.length; i += 4) if (near(d, i)) { n++; break; }
      }
      return n;
    }
    const x = Math.round(c[0] + dx0), y = Math.round(c[1] + dy0);
    const d = _ctx.getImageData(x, y, dx1 - dx0, dy1 - dy0).data;
    for (let i = 0; i < d.length; i += 4) if (near(d, i)) n++;
    return n;
  }, { id, hex, dx0, dx1, dy0, dy1, ring });
}

/** Light grey name pixels where a Spatial label puts the start of a system's name: up and to the left of it. */
function ownNameStart(window, id) {
  return window.evaluate((id) => {
    const [cx, cy] = _spatialCanvasOf(id).map(Math.round);
    const d = _ctx.getImageData(cx - 40, cy - 14, 24, 10).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 60 && d[i] > 150 && Math.abs(d[i] - d[i + 1]) < 25 && Math.abs(d[i + 1] - d[i + 2]) < 30) n++;
    }
    return n;
  }, id);
}

const RIGHT = { dx0: 19, dx1: 59, dy0: -4, dy1: 5 };     // where its name starts, past the ring
const LEFT  = { dx0: -59, dx1: -19, dy0: -4, dy1: 5 };

test('a star you click is ringed and named in the accent, round "you are here", and the ring goes with the panel', async ({ window }) => {
  await openMap(window);
  const id = await overG15Z(window);
  const accent = await window.evaluate(() => _accent());
  expect(accent, 'the theme accent, resolved for the canvas').toMatch(/^#[0-9a-f]{6}$/i);
  expect(await paint(window, id, accent, { ring: 13 }), 'nothing selected, no ring').toBe(0);
  const ownName = await ownNameStart(window, id);
  expect(ownName, 'its name, above it, as every star near enough has').toBeGreaterThan(15);

  // Clicked, as anyone would pick it.
  const box = await window.locator('#mapCanvas').boundingBox();
  const at = await window.evaluate((id) => _spatialCanvasOf(id), id);
  await window.mouse.click(box.x + at[0], box.y + at[1]);
  await expect(window.locator('#mapInfoPanel')).toBeVisible();
  await expect.poll(() => window.evaluate(() => _camTween)).toBe(null);
  expect(await window.evaluate(() => _selected && _selected.name)).toBe('G15Z-W');
  await window.evaluate(() => _render());
  expect(await paint(window, id, accent, { ring: 13 }), 'ringed').toBeGreaterThanOrEqual(20);
  expect(await paint(window, id, accent, RIGHT), 'named, to the right of the ring').toBeGreaterThan(10);
  expect(await ownNameStart(window, id), 'and not a second time above it').toBeLessThan(3);

  // Where you are as well: the two rings nest, "you" inside.
  await window.evaluate((id) => { _youHereId = id; _render(); }, id);
  expect(await paint(window, id, '#4ecbb0', { ring: 8 }), 'you are here').toBeGreaterThanOrEqual(18);
  expect(await paint(window, id, accent, { ring: 13 }), 'the selection, round it').toBeGreaterThanOrEqual(16);
  await window.evaluate(() => { _youHereId = null; });

  // The theme's accent, whatever it is: a var() the canvas cannot read would leave the ring in the last colour set.
  await window.evaluate(() => { document.documentElement.style.setProperty('--accent', '#40ff40'); _render(); });
  expect(await paint(window, id, '#40ff40', { ring: 13 }), 'retinted with the theme').toBeGreaterThanOrEqual(20);
  await window.evaluate(() => { document.documentElement.style.removeProperty('--accent'); _render(); });

  // Closed: the ring and its name go, and the star's own name comes back.
  await window.locator('#mapInfoPanel .map-info-close').click();
  expect(await window.evaluate(() => _selected)).toBe(null);
  await window.evaluate(() => _render());
  expect(await paint(window, id, accent, { ring: 13 })).toBe(0);
  expect(await paint(window, id, accent, RIGHT)).toBe(0);
  expect(await ownNameStart(window, id)).toBeGreaterThan(15);

  // Up against the right-hand edge the name goes on the ring's other side.
  await window.evaluate((id) => {
    _showInfo(_sysById[id]);
    _camPanX += _canvas.width - 30 - _spatialCanvasOf(id)[0];
    _render();
  }, id);
  expect(await paint(window, id, accent, { ring: 13 })).toBeGreaterThanOrEqual(20);
  expect(await paint(window, id, accent, LEFT), 'named on the left').toBeGreaterThan(10);
});

test('the Schematic overview rings it too; inside a region its pill is outlined instead', async ({ window }) => {
  await openMap(window);
  await window.locator('.map-view-btn[data-view="modern"]').click();
  await window.waitForTimeout(300);
  const field = window.locator('#mapSearchInput');
  await field.click();
  await field.fill('Jita');
  await field.press('Enter');
  await expect(window.locator('#mapInfoPanel')).toBeVisible();
  const id = await window.evaluate(() => _selected && _selected.name === 'Jita' ? _selected.id : null);
  expect(id).not.toBe(null);
  await window.evaluate(() => _render());
  const accent = await window.evaluate(() => _accent());
  expect(await paint(window, id, accent, { ring: 13 }), 'ringed on the overview').toBeGreaterThanOrEqual(20);
  expect(await paint(window, id, accent, RIGHT), 'and named').toBeGreaterThan(10);

  // Into The Forge: a ring there would cut across the name on Jita's pill, so the pill's own outline marks it.
  await window.evaluate((id) => { _enterRegion(_sysById[id].regionId); _render(); }, id);
  expect(await paint(window, id, accent, { ring: 13 }), 'no ring across the pill').toBe(0);
  expect(await paint(window, id, '#e0b34a', { dx0: -2, dx1: 3, dy0: -11, dy1: -8 }), 'its outline, in gold').toBeGreaterThan(0);
});
