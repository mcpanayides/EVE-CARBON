// Force Projection — Ansiblex fare zoning, as a map LAYER.
//
// The arithmetic is covered by test/force_projection.test.js under Node,
// including the sov normaliser against a real ESI response. What needs a real
// window is the wiring: capitals derived from the loaded sov, the reach memo in
// front of them, the alliance picker, and — the reason this is a layer rather
// than an overlay — that it combines with every other layer at once.
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#page-map')).toBeVisible({ timeout: 15_000 });
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(2000);
}

/**
 * Sov shaped exactly as map_ipc normalises /sovereignty/systems: one alliance
 * holding everything within 30 LY of Jita with Jita as its capital, the rest
 * unclaimed. Selects that alliance, as picking it in the widget would.
 */
async function seed(window) {
  // The map's first live sov fetch can still be in flight as the page opens.
  // Stamping _sovAt below marks this seed as newer than anything it asked for,
  // so if it lands late, _loadLiveData leaves the seed alone.
  return window.evaluate(() => {
    const jita = _systems.find(s => s.name === 'Jita');
    const pick = (n) => _systems.find(s => s.name === n);
    _sovMap = {};
    for (const s of _systems) {
      const d = Math.hypot(s.x - jita.x, s.y - jita.y, s.z - jita.z) / ForceProjection.LY_METRES;
      _sovMap[s.id] = d < 30
        ? { allianceId: 1001, corporationId: 1, factionId: null, isCapital: s.id === jita.id }
        : { allianceId: null, corporationId: null, factionId: null, isCapital: false };
    }
    _sovAt = Date.now();
    _allianceNames[1001] = 'Test Coalition';
    _allianceTickers[1001] = 'TSTC';
    _fpSelected = new Set([1001]);
    return { jita: jita.id, amarr: pick('Amarr').id, rens: pick('Rens').id,
             perimeter: pick('Perimeter').id, hek: pick('Hek').id };
  });
}

test('capitals are read from the sov data, not entered', async ({ window }) => {
  await openMap(window);
  const ids = await seed(window);
  const caps = await window.evaluate(() => _fpState().capitals);
  expect(caps).toEqual({ 1001: ids.jita });
});

test('reach follows real light-years from the chosen capital', async ({ window }) => {
  await openMap(window);
  const ids = await seed(window);
  const z = await window.evaluate((ids) => {
    const m = _fpReach();
    const of = (id) => { const e = m.get(id); return e ? { zone: e.zone, ly: +e.ly.toFixed(2) } : null; };
    return { jita: of(ids.jita), perimeter: of(ids.perimeter), rens: of(ids.rens), amarr: of(ids.amarr) };
  }, ids);

  // Cross-checked against the distances this project has verified before.
  expect(z.jita.zone).toBe(1);
  expect(z.perimeter.ly).toBeCloseTo(2.1, 1);
  expect(z.rens.ly).toBeCloseTo(13.29, 1);
  expect(z.rens.zone).toBe(3);
  // Amarr is 20.28 LY out: past the last finite band, so unmarked, not zone 5.
  expect(z.amarr).toBeNull();
});

test('MOVING a capital re-zones the map', async ({ window }) => {
  // An earlier version keyed its zone cache on how MANY capitals there were. A
  // capital that moved — same alliance, a different system, exactly what
  // AllianceCapitalChanged reports — left the count unchanged and served the
  // old zoning, so the map kept marking reach from an abandoned home.
  await openMap(window);
  const ids = await seed(window);
  const res = await window.evaluate((ids) => {
    const before = _fpReach().get(ids.hek).zone;
    _sovMap[ids.jita].isCapital = false;          // the capital moves...
    _sovMap[ids.hek].isCapital = true;            // ...to Hek: still one capital
    _sovAt = Date.now() + 1;                      // as a sov refresh would
    const after = _fpReach().get(ids.hek).zone;
    return { before, after, count: Object.keys(_fpState().capitals).length };
  }, ids);

  expect(res.count).toBe(1);                      // the count never changed
  expect(res.before).toBe(2);                     // 6.8 LY from Jita
  expect(res.after).toBe(1);                      // 0 LY from its new capital
});

test('it is a LAYER: the overlay keeps the system colours', async ({ window }) => {
  // Force projection used to be an overlay, so switching it on threw away
  // Sovereignty. It now draws rings on top of whatever the overlay paints.
  await openMap(window);
  await seed(window);
  await window.locator('.map-overlay-btn[data-overlay="sovereignty"]').click();
  const before = await window.evaluate(() =>
    _systems.slice(0, 400).map(s => _systemColor(s)));

  await window.locator('#mapFpToggle').click();
  const after = await window.evaluate(() => ({
    overlay: _overlay, fp: _showFp,
    colours: _systems.slice(0, 400).map(s => _systemColor(s)),
  }));

  expect(after.overlay).toBe('sovereignty');
  expect(after.fp).toBe(true);
  expect(after.colours).toEqual(before);
});

test('jump bridges draw in the spatial view, with force projection on', async ({ window }) => {
  // The spatial view — the only one that can draw the spheres — had no
  // jump-bridge drawing at all, so turning force projection on took you to a
  // map with no bridges on it.
  await openMap(window);
  const ids = await seed(window);
  const drawn = await window.evaluate((ids) => {
    _viewMode = 'spatial'; _spatialLayout = 'system'; _camFlat = false;
    _showJb = true; _showFp = true;
    _savedBridges = [[ids.jita, ids.perimeter], [ids.perimeter, ids.hek]];
    const cap = _sysById[ids.jita];
    _camCancelTween(); _camFocusX = cap.tx; _camFocusY = cap.ty; _camFocusZ = cap.tz;
    const calls = [];
    const real = _drawArcs;
    _drawArcs = function (ctx, W, H, edges, toCanvas, st) {
      if (st.nub) calls.push(edges.filter(([a, b]) => toCanvas(a) && toCanvas(b)).length);
      return real.apply(this, arguments);
    };
    try { _render(); } finally { _drawArcs = real; }
    return calls;
  }, ids);
  expect(drawn).toEqual([2]);                     // both bridges, both ends on canvas
});

test('influence says so in 3-D rather than silently doing nothing', async ({ window }) => {
  // The influence field is a hex grid over the schematic's flat coordinates;
  // there is no plane to lay it on in 3-D. It used to count as active there
  // anyway, so the legend claimed dots carried territory colour when they did
  // not — or did, if you had visited the Schematic first.
  await openMap(window);
  await seed(window);
  const res = await window.evaluate(() => {
    _viewMode = 'spatial'; _showInf = true;
    _updateLegend();
    return { active: _infActive(), legend: document.getElementById('mapLegend').innerText };
  });
  expect(res.active).toBe(false);
  expect(res.legend).toContain('Influence draws on the Schematic view');
  expect(res.legend).not.toContain('carry their territory');
});

test('the toggle opens the widget, which picks an alliance by name', async ({ window }) => {
  await openMap(window);
  await seed(window);
  await window.evaluate(() => { _fpSelected.clear(); _fpSaveSelected(); });

  await window.locator('#mapFpToggle').click();
  const widget = window.locator('#mapFpWidget');
  await expect(widget).toBeVisible();
  await expect(widget).toContainText('FORCE PROJECTION');

  // Typed by ticker alone, as people actually type it.
  const input = window.locator('#fpSearch');
  await input.fill('TSTC');
  await input.press('Enter');

  await expect(window.locator('#fpPicked .fp-pick')).toHaveCount(1);
  await expect(window.locator('#fpPicked')).toContainText('Test Coalition');
  await expect(window.locator('#fpPicked')).toContainText('Jita');   // capital read from ESI data

  // Remembered, so the next session opens on the same alliance.
  const stored = await window.evaluate(() => localStorage.getItem('force_projection_alliances'));
  expect(JSON.parse(stored)).toEqual([1001]);

  // Off again, and it goes with the layer rather than lingering over the map.
  await window.locator('#mapFpToggle').click();
  await expect(widget).toBeHidden();
});

test('a sphere is the same size from every direction', async ({ window }) => {
  // The first version measured a sphere by projecting a point R light-years
  // along a fixed WORLD axis. That axis is foreshortened as soon as the camera
  // orbits — at the default 57-degree tilt a quarter-turn shrank every sphere by
  // ten per cent, so they visibly breathed while you rotated, and edge-on they
  // would have collapsed to a line.
  await openMap(window);
  const ids = await seed(window);
  const r = await window.evaluate((ids) => {
    const cap = _sysById[ids.jita];
    _camCancelTween();
    _camFocusX = cap.tx; _camFocusY = cap.ty; _camFocusZ = cap.tz;   // pivot on the capital
    const radii = [];
    for (const deg of [0, 45, 90, 135, 180]) {
      _camYaw = deg * Math.PI / 180;
      radii.push(_fpScreenRadius(_spatialProject(cap), 20));
    }
    return { radii, r5: _fpScreenRadius(_spatialProject(cap), 5),
             r20: _fpScreenRadius(_spatialProject(cap), 20) };
  }, ids);

  const spread = Math.max(...r.radii) - Math.min(...r.radii);
  expect(spread, `radius changed with yaw: ${r.radii.map(x => x.toFixed(1)).join(', ')}`).toBeLessThan(0.5);
  // And it is a real distance: four times the light-years, four times the size.
  expect(r.r20 / r.r5).toBeGreaterThan(3.9);
  expect(r.r20 / r.r5).toBeLessThan(4.1);
});
