// The Natural overlay: every system drawn as its own star, coloured and sized
// by its star type in the SDE, and the default overlay.
//
// The star comes from the system's own Sun row in mapDenormalize. The obvious
// route - mapSolarSystems' "sunTypeID" - is a trap: in our SDE it holds the
// star's ITEM id, in the old Fuzzwork dump a type id. Read it the wrong way and
// every star silently comes back unknown - plain white - with nothing to say why.
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
}

test('Natural is the default, and every system on the map carries its SDE star', async ({ window }) => {
  await openMap(window);
  await expect(window.locator('.map-overlay-btn[data-overlay="natural"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(window.locator('.map-overlay-btn[data-overlay="security"]')).toHaveAttribute('aria-pressed', 'false');
  const r = await window.evaluate(() => {
    const ks = _systems.filter(s => s.id >= 30000000 && s.id < 31000000);
    const known = new Set(Object.values(_STAR_HEX).concat(Object.values(_STAR_CLASS_HEX)));
    const of = (n) => _systems.find(s => s.name === n).star;
    return {
      overlay: _overlay,
      total: ks.length,
      named: ks.filter(s => /^Sun /.test(s.star || '')).length,
      coloured: ks.filter(s => known.has(s.starHex)).length,
      // Read from the SDE on 2026-10-28; a change here means the join broke, not CCP.
      jita: of('Jita'), rens: of('Rens'),
    };
  });
  expect(r.overlay).toBe('natural');
  expect(r.named).toBe(r.total);
  expect(r.coloured).toBe(r.total);
  expect(r.jita).toBe('Sun O1 (Bright Blue)');
  expect(r.rens).toBe('Sun K7 (Orange)');
});

test('colour and size follow the words in the star\'s name', async ({ window }) => {
  await openMap(window);
  const out = await window.evaluate(() => {
    const cases = [
      { star: 'Sun K5 (Red Giant)' },
      { star: 'Sun B5 (White Dwarf)' },
      { star: 'Sun O1 (Bright Blue)' },
      { star: 'Sun K5 (Orange Bright)' },
      { star: 'Sun K3 (Yellow Small)' },
      { star: 'Sun O1 (Divine Immanence)' },   // no colour word: by spectral class
      { star: 'Sun A0 (Captured Blue Small)' },
      { star: null },                          // an SDE without the star join
    ];
    _classifyStars(cases);
    return cases.map(c => [c.starHex, Number(c.starSize.toFixed(2)), c.starLabel]);
  });
  const hex = await window.evaluate(() => ({ ..._STAR_HEX, O: _STAR_CLASS_HEX.O, none: _STAR_FALLBACK }));
  expect(out).toEqual([
    [hex['red giant'],   1.7,  'K5 Red Giant'],
    [hex['white dwarf'], 0.6,  'B5 White Dwarf'],
    [hex['bright blue'], 1.3,  'O1 Bright Blue'],
    [hex.orange,         1.3,  'K5 Orange Bright'],
    [hex.yellow,         0.75, 'K3 Yellow Small'],
    [hex.O,              1,    'O1 Divine Immanence'],
    [hex.blue,           0.75, 'A0 Captured Blue Small'],
    [hex.none,           1,    null],
  ]);
});

/**
 * Fly to the most isolated system with a given star (so no neighbour's glow
 * mixes in), at the zoom where stars glow full, and read the glow around it:
 * the colour 4 px out, and how far out it is still lit.
 *
 * Reach is measured sideways, and as the shorter of left and right. Straight up
 * runs into the system's own name - labels sit just above the star - and one
 * label joined to its glow passed for a bigger star; one direction alone can
 * meet a gate line.
 */
function glowOf(window, word) {
  return window.evaluate((word) => {
    const LY = ForceProjection.LY_METRES;
    const ks = _systems.filter(s => s.id < 31000000 && s.tx !== undefined);
    const nearest = (s) => {
      let d = Infinity;
      for (const o of ks) if (o !== s) d = Math.min(d, Math.hypot(o.x - s.x, o.y - s.y, o.z - s.z));
      return d / LY;
    };
    const pick = ks.filter(s => (s.star || '').toLowerCase().includes(word))
      .map(s => ({ s, gap: nearest(s) })).sort((a, b) => b.gap - a.gap)[0].s;
    _skyOn = false;                                    // the star alone, not the nebula behind it
    _viewMode = 'spatial'; _camFlat = false; _fitSpatial();
    _camFocusX = pick.tx; _camFocusY = pick.ty; _camFocusZ = pick.tz; _camPanX = 0; _camPanY = 0;
    _camZoom = 1;
    _camZoom = 1.2 * _STAR_GLOW_AT / (_medianGateLen() * _spatialPxPerUnit());
    _render();
    const [cx, cy] = _spatialCanvasOf(pick.id).map(Math.round);
    // The map canvas is clear over the backdrop layer, so a faint glow pixel
    // reads back as full colour at low alpha: weigh it by alpha, which is how
    // bright it shows over black space.
    const px = (x, y) => Array.from(_ctx.getImageData(x, y, 1, 1).data);
    const shown = (p) => Math.max(p[0], p[1], p[2]) * p[3] / 255;
    const lit = (dir) => {
      let d = 1;
      while (d < 60 && shown(px(cx + dir * d, cy)) > 60) d++;
      return d - 1;
    };
    return { name: pick.name, rgb: px(cx + 4, cy - 4), reach: Math.min(lit(-1), lit(1)) };
  }, word);
}

test('on the map, a red giant glows red and big, a white dwarf small, a blue star blue', async ({ window }) => {
  await openMap(window);
  const giant = await glowOf(window, 'red giant');
  const dwarf = await glowOf(window, 'white dwarf');
  const blue  = await glowOf(window, 'bright blue');
  expect(giant.rgb[0], `${giant.name}: red leads`).toBeGreaterThan(giant.rgb[1] * 1.3);
  expect(giant.rgb[0]).toBeGreaterThan(giant.rgb[2] * 1.3);
  expect(blue.rgb[2], `${blue.name}: blue leads`).toBeGreaterThan(blue.rgb[0]);
  expect(giant.reach, `${giant.name} vs ${dwarf.name}`).toBeGreaterThan(dwarf.reach * 1.6);
});

test('the legend shows the stars, the tooltip names the one under the cursor', async ({ window }) => {
  await openMap(window);
  await expect(window.locator('#mapLegend .map-legend-title').first()).toHaveText('STARS');
  await expect(window.locator('#mapLegend .map-legend-orb')).toHaveCount(6);

  const box = await window.locator('#mapCanvas').boundingBox();
  const target = await window.evaluate(() => {
    _viewMode = 'spatial'; _camFlat = false; _fitSpatial();
    const d = _systems.find(s => s.name === 'Rens');
    _camFocusX = d.tx; _camFocusY = d.ty; _camFocusZ = d.tz; _camPanX = 0; _camPanY = 0;
    _camZoom = 1; _camZoom = 1.2 * _STAR_GLOW_AT / (_medianGateLen() * _spatialPxPerUnit());
    _render();
    const [x, y] = _spatialCanvasOf(d.id);
    const hit = _hitTest(x, y);
    return { x, y, name: hit.name, label: hit.starLabel };
  });
  await window.mouse.move(box.x + target.x, box.y + target.y);
  await expect(window.locator('#mapTooltip')).toHaveText(`${target.name} · ${target.label}`);
});

test('in Schematic, Natural colours each dot by its star', async ({ window }) => {
  await openMap(window);
  await window.locator('.map-view-btn[data-view="modern"]').click();
  const mismatched = await window.evaluate(() =>
    _systems.filter(s => s.id < 31000000 && _systemColor(s) !== s.starHex).length);
  expect(mismatched).toBe(0);
});
