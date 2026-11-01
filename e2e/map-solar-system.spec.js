// The solar system view: select any system, "View solar system", dive into its
// star, and find everything the SDE places in it - then back to the map, exactly
// where you left it. Jita is the worked case; the rest of the spec is for the
// systems unlike it, and one test goes through every system on the map.
//
// The arithmetic is test/orrery.test.js. These are about the real app: the real
// SDE rows, the real button, and the camera handed back to the last decimal.
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
  await window.evaluate(() => {
    document.body.classList.remove('app-unfocused');
    _viewMode = 'spatial'; _camFlat = false; _overlay = 'natural'; _fitSpatial();
  });
}

/** Jita selected and in the middle of a flown-in view; returns that camera. */
function overJita(window) {
  return window.evaluate(() => {
    const j = _systems.find(s => s.name === 'Jita');
    _camFocusX = j.tx; _camFocusY = j.ty; _camFocusZ = j.tz;
    _camYaw = 0.4; _camPitch = 0.9; _camZoom = 40; _camPanX = 12; _camPanY = -7;
    _showInfo(j); _render();
    return _camSnap();
  });
}

/** Straight to the end of whatever transition is running. */
const settle = (window) => window.evaluate(() => { if (_sys && _sys.anim) _solarFinish(); });

/**
 * Opened and held on its first frame, in one step: a flash is over in 280 ms, and
 * a slow runner could be through a dive before a test got round to holding it.
 */
const openHeld = (window) => window.evaluate(async () => {
  await _solarOpen();
  if (_sys.raf) { cancelAnimationFrame(_sys.raf); _sys.raf = 0; }
});

/** Into the system with the real button, without waiting out the animation. */
async function enter(window) {
  await window.locator('#mapSysBtn').click();
  await expect.poll(() => window.evaluate(() => !!_sys)).toBe(true);
  await settle(window);
}

test('the button is offered for whichever system is selected, in either view', async ({ window }) => {
  await openMap(window);
  const btn = window.locator('#mapSysBtn');
  await expect(btn).toBeHidden();
  await overJita(window);
  await expect(btn).toBeVisible();
  await expect(btn.locator('.map-sys-btn-label')).toHaveText('View solar system');
  // Bottom centre of the map.
  const [b, v] = await Promise.all([btn.boundingBox(), window.locator('#mapViewport').boundingBox()]);
  expect(Math.abs(b.x + b.width / 2 - (v.x + v.width / 2))).toBeLessThan(2);
  expect(v.y + v.height - (b.y + b.height)).toBeLessThan(30);

  for (const name of ['Perimeter', 'Zarzakh', 'Thera', 'J140831']) {
    await window.evaluate(() => mapCloseInfo());
    await expect(btn, 'nothing selected').toBeHidden();
    await window.evaluate((name) => _showInfo(_systems.find(s => s.name === name)), name);
    await expect(btn, name).toBeVisible();
  }
  // An SDE too old to carry stars has nothing to draw, so nothing is offered.
  await window.evaluate(() => { const j = _systems.find(s => s.name === 'Jita'); _showInfo(Object.assign({}, j, { star: undefined })); });
  await expect(btn).toBeHidden();

  // The Schematic: a real click on a system's pill.
  await window.locator('.map-view-btn[data-view="modern"]').click();
  await window.waitForTimeout(300);
  const at = await window.evaluate(() => {
    const j = _systems.find(s => s.name === 'Jita');
    _enterRegion(j.regionId); _render();
    const p = _regionLayout.get(j.id);
    return _w2c(p.x, p.z);
  });
  const box = await window.locator('#mapCanvas').boundingBox();
  await window.mouse.click(box.x + at[0], box.y + at[1]);
  await expect(window.locator('#mapInfoSystemName')).toHaveText('Jita');
  await expect(btn).toBeVisible();
});

test('inside, everything the SDE has in Jita is there, each gate named for where it leads', async ({ window }) => {
  await openMap(window);
  await overJita(window);
  await enter(window);
  const r = await window.evaluate(() => {
    const L = _sys.L;
    return {
      scene: _sys.scene,
      counts: [L.planets.length, L.moons.length, L.gates.length, L.stations.length],
      numerals: L.planets.map(p => p.numeral),
      kinds: L.planets.map(p => p.planetKind),
      beside: L.gates.filter(g => g.parent).map(g => [g.dest, g.parent.numeral]).sort(),
      apart: L.gates.filter(g => !g.parent).map(g => g.dest).sort(),
      led: L.gates.every(g => g.to && g.to.name === g.dest),
      hub: L.stations.filter(s => /trade hub/i.test(s.typeName || '')).map(s => s.name),
      drawn: _sys.hits.length,
      fills: _sys.L.planets.every(p => { const pr = _spatialProject(p.pt); const [x, y] = _spatialToCanvas(pr); return x > 0 && x < _canvas.width && y > 0 && y < _canvas.height; }),
    };
  });
  expect(r.scene).toBe('system');
  expect(r.counts, 'planets, moons, stargates, stations').toEqual([8, 33, 7, 18]);
  expect(r.numerals).toEqual(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']);
  expect(r.kinds).toEqual(['barren', 'barren', 'temperate', 'gas', 'gas', 'lava', 'ice', 'barren']);
  // Four parked on Jita VIII, three out on their own - read off the SDE, not assumed.
  expect(r.beside).toEqual([['Maurasi', 'VIII'], ['New Caldari', 'VIII'], ['Niyabainen', 'VIII'], ['Perimeter', 'VIII']]);
  expect(r.apart).toEqual(['Ikuchi', 'Muvolailen', 'Sobaseki']);
  expect(r.led, 'every gate leads to a system on the map').toBe(true);
  expect(r.hub).toEqual(['Jita 4 - Moon 4 - Caldari Navy Assembly Plant']);
  expect(r.drawn, 'sun + planets + moons + gates + stations').toBe(1 + 8 + 33 + 7 + 18);
  expect(r.fills, 'the fitted view holds every planet').toBe(true);
  await expect(window.locator('#mapSysHudName')).toHaveText('Jita');
  await expect(window.locator('#mapSysHudCount')).toHaveText('8 planets · 33 moons · 7 stargates · 18 stations');
  await expect(window.locator('#mapSysBtn .map-sys-btn-label')).toHaveText('Back to galaxy');
  await expect(window.locator('#mapLegend')).toContainText('square-rooted');
});

test('a planet keeps its true direction from the sun, and its orbit runs through it', async ({ window }) => {
  await openMap(window);
  await overJita(window);
  await enter(window);
  const r = await window.evaluate(() => _sys.L.planets.map(p => {
    const unit = (v) => { const l = Math.hypot(...v); return v.map(x => x / l); };
    const a = unit(p.m), b = unit(p.p);
    return { cos: a[0] * b[0] + a[1] * b[1] + a[2] * b[2], r: Math.hypot(...p.p),
      ring: Math.hypot(p.ring[0].tx - p.p[0], p.ring[0].ty - p.p[1], p.ring[0].tz - p.p[2]) };
  }));
  for (const p of r) {
    expect(p.cos).toBeGreaterThan(1 - 1e-9);
    expect(p.ring).toBeLessThan(1e-9);
  }
  for (let i = 1; i < r.length; i++) expect(r[i].r, 'further out in the SDE, further out here').toBeGreaterThan(r[i - 1].r);
});

test('zooming in opens a planet\'s company out, and it turns with the camera', async ({ window }) => {
  await openMap(window);
  await overJita(window);
  await enter(window);
  const spread = () => window.evaluate(() => {
    const iv = _sys.L.planets.find(p => p.numeral === 'IV');
    const c = _sys.hits.find(h => h.b === iv);
    const ms = _sys.hits.filter(h => h.b.kind === 'moon' && h.b.parent === iv);
    return { d: Math.max(...ms.map(h => Math.hypot(h.x - c.x, h.y - c.y))), first: [ms[0].x - c.x, ms[0].y - c.y] };
  });
  const a = await spread();
  await window.evaluate(() => { _camZoom = _sys.zFit * 10; _render(); });
  const b = await spread();
  expect(b.d, `${a.d.toFixed(0)} px fitted, ${b.d.toFixed(0)} px at 10x`).toBeGreaterThan(a.d * 4);
  await window.evaluate(() => { _camYaw += 1; _render(); });
  const c = await spread();
  expect(Math.hypot(c.first[0] - b.first[0], c.first[1] - b.first[1]), 'the moons swing round as you orbit').toBeGreaterThan(5);
});

test('picking a gate says where it leads; empty space lets go; the Esc key goes home', async ({ window }) => {
  await openMap(window);
  const cam = await overJita(window);
  await enter(window);
  const box = await window.locator('#mapCanvas').boundingBox();
  const at = await window.evaluate(() => { const h = _sys.hits.find(q => q.b.kind === 'gate' && q.b.dest === 'Sobaseki'); return [h.x, h.y]; });
  await window.mouse.click(box.x + at[0], box.y + at[1]);
  await expect(window.locator('#mapInfoSystemName')).toHaveText('Stargate · Sobaseki');
  const body = window.locator('#mapInfoBody');
  await expect(body).toContainText('Sobaseki');
  await expect(body).toContainText('Regional gate');
  await expect(body).toContainText('42.1 AU');
  // The picked mark is ringed in the theme's accent, and the camera glides onto it.
  await expect.poll(() => window.evaluate(() => _camTween)).toBe(null);
  const ring = await window.evaluate(() => {
    _render();
    const h = _sys.hits.find(q => q.b === _sys.sel);
    const R = Math.max(7, h.r + 3), hex = _accent();
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    let n = 0;
    for (let k = 0; k < 24; k++) {
      const a = k * Math.PI / 12;
      const d = _ctx.getImageData(Math.round(h.x + R * Math.cos(a)) - 1, Math.round(h.y + R * Math.sin(a)) - 1, 3, 3).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100 && Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 60) { n++; break; }
    }
    return { n, centred: Math.hypot(h.x - _canvas.width / 2, h.y - _canvas.height / 2) };
  });
  expect(ring.n, 'ringed in the accent').toBeGreaterThanOrEqual(18);
  expect(ring.centred, 'and centred').toBeLessThan(2);

  // Empty space: the panel goes, the system stays open and selected.
  await window.mouse.click(box.x + 60, box.y + box.height / 2);
  await expect(window.locator('#mapInfoPanel')).toBeHidden();
  expect(await window.evaluate(() => [_sys.sel, _selected.name])).toEqual([null, 'Jita']);

  // Esc: back to the galaxy, the camera handed back to the last decimal.
  await window.keyboard.press('Escape');
  await expect.poll(() => window.evaluate(() => !!_sys), { timeout: 5000 }).toBe(false);
  expect(await window.evaluate(() => _camSnap())).toEqual(cam);
  await expect(window.locator('#mapInfoSystemName')).toHaveText('Jita');
  await expect(window.locator('#mapSysBtn .map-sys-btn-label')).toHaveText('View solar system');
  await expect(window.locator('#mapSysHud')).toBeHidden();
  await expect(window.locator('#mapLegend')).not.toContainText('square-rooted');
});

test('the dive holds the star in the middle, its light fills the view at the cut, and it stops if nobody watches', async ({ window }) => {
  await openMap(window);
  await overJita(window);
  await openHeld(window);
  // A moment of the running transition, drawn on demand with the loop held.
  const at = (ms) => window.evaluate((ms) => {
    if (_sys.raf) { cancelAnimationFrame(_sys.raf); _sys.raf = 0; }
    _sys.anim.t0 = performance.now() - ms;
    _solarTick();
    if (_sys.raf) { cancelAnimationFrame(_sys.raf); _sys.raf = 0; }
    const cx = Math.round(_canvas.width / 2), cy = Math.round(_canvas.height / 2);
    return { scene: _sys.scene, zoom: _camZoom, bloom: _sys.bloom, reveal: _sys.reveal,
      jita: _sys.scene === 'galaxy' ? _spatialCanvasOf(_sys.id) : null,
      mid: [cx, cy], lit: [..._ctx.getImageData(cx + 200, cy, 1, 1).data],
      disabled: document.getElementById('mapSysBtn').disabled };
  }, ms);
  const { ENTER } = await window.evaluate(() => ({ ENTER: Orrery.ENTER }));
  const early = await at(200), late = await at(ENTER.dive - 5), cut = await at(ENTER.dive + 5), open = await at(ENTER.dive + ENTER.reveal * 0.6);
  expect(early.scene).toBe('galaxy');
  expect(early.disabled, 'no second press while it plays').toBe(true);
  expect(late.zoom, 'in, and faster').toBeGreaterThan(early.zoom * 3);
  expect(Math.hypot(late.jita[0] - late.mid[0], late.jita[1] - late.mid[1]), 'the star held in the middle').toBeLessThan(2);
  expect(early.bloom).toBe(0);
  expect(late.bloom).toBeGreaterThan(0.98);
  expect(cut.scene).toBe('system');
  expect(cut.bloom, 'the same light either side of the cut').toBeGreaterThan(0.98);
  expect(cut.lit[3], 'light well out from the star').toBeGreaterThan(100);
  expect(open.bloom, 'and it clears').toBe(0);
  expect(open.zoom).toBeLessThan(cut.zoom);

  // Window loses focus mid-way: the transition lands, and nothing keeps running.
  await window.evaluate(() => { document.body.classList.add('app-unfocused'); _solarTick(); });
  const done = await window.evaluate(() => ({ anim: _sys.anim, raf: _sys.raf, fit: _camZoom === _sys.zFit, reveal: _sys.reveal, disabled: document.getElementById('mapSysBtn').disabled }));
  expect(done).toEqual({ anim: null, raf: 0, fit: true, reveal: 1, disabled: false });
});

test('with motion reduced it just cuts, both ways', async ({ window }) => {
  await openMap(window);
  const cam = await overJita(window);
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await window.locator('#mapSysBtn').click();
  await expect.poll(() => window.evaluate(() => _sys && _sys.scene)).toBe('system');
  expect(await window.evaluate(() => ({ anim: _sys.anim, bloom: _sys.bloom, fit: _camZoom === _sys.zFit }))).toEqual({ anim: null, bloom: 0, fit: true });
  await window.locator('#mapSysBtn').click();
  expect(await window.evaluate(() => !!_sys)).toBe(false);
  expect(await window.evaluate(() => _camSnap())).toEqual(cam);
});

test('a route through Jita marks the gates it uses, and the names keep off the panels', async ({ window }) => {
  await openMap(window);
  await overJita(window);
  const path = await window.evaluate(() => ['Perimeter', 'Jita', 'Niyabainen'].map(n => _systems.find(s => s.name === n).id));
  await window.evaluate((p) => { _routeIds = p; }, path);
  await enter(window);
  await expect(window.locator('#mapSysHudRoute')).toContainText('in from Perimeter');
  await expect(window.locator('#mapSysHudRoute')).toContainText('out to Niyabainen');
  await expect(window.locator('#mapSysHudRoute')).toContainText('km apart');
  const roles = await window.evaluate(() => [..._solarRouteRoles()].map(([g, r]) => [g.dest, r]).sort());
  expect(roles).toEqual([['Niyabainen', 'out'], ['Perimeter', 'in']]);

  // Every name's box this frame, against every panel: none of a gate's or planet's names lies under one.
  const under = await window.evaluate(() => {
    const out = [], orig = _ctx.fillText, view = _canvas.getBoundingClientRect();
    const panels = [...document.querySelectorAll('#mapLegend, #mapSysHud, #mapInfoPanel, #mapSysBtn')].map(e => e.getBoundingClientRect());
    _ctx.fillText = function (t, x, y) {
      const w = _ctx.measureText(t).width;
      for (const p of panels) {
        if (x + view.left < p.right && x + view.left + w > p.left && y + view.top + 6 > p.top && y + view.top - 6 < p.bottom) out.push(t);
      }
      return orig.apply(this, arguments);
    };
    _render();
    _ctx.fillText = orig;
    return out;
  });
  expect(under, 'names under a panel').toEqual([]);
});

test('anything that needs the galaxy brings you out first', async ({ window }) => {
  await openMap(window);
  const cam = await overJita(window);
  await enter(window);
  // The Schematic.
  await window.locator('.map-view-btn[data-view="modern"]').click();
  expect(await window.evaluate(() => !!_sys)).toBe(false);
  await window.locator('.map-view-btn[data-view="spatial"]').click();

  // A route from a planner.
  await overJita(window);
  await enter(window);
  const ids = await window.evaluate(() => ['Jita', 'Perimeter'].map(n => _systems.find(s => s.name === n).id));
  await window.evaluate((ids) => window.mapShowRoute(ids, [], false), ids);
  expect(await window.evaluate(() => !!_sys)).toBe(false);
  await window.evaluate(() => { _routeIds = null; _routeRevealFinish(); });

  // Picked in Flat, the dive still ends in the true sky, and comes back Flat.
  await window.evaluate(() => { _camFlat = true; _fitSpatial(); _showInfo(_spatialSystems().find(s => s.name === 'Jita')); _render(); });
  const flat = await window.evaluate(() => _camSnap());
  await enter(window);
  const inside = await window.evaluate(() => {
    const j = _sysById[_sys.id];
    return { flat: _camFlat, bg: [_sys.bg.fx - j.tx, _sys.bg.fy - j.ty, _sys.bg.fz - j.tz], bgFlat: _sys.bg.flat };
  });
  expect(inside).toEqual({ flat: false, bg: [0, 0, 0], bgFlat: false });
  await window.keyboard.press('Escape');
  await expect.poll(() => window.evaluate(() => !!_sys), { timeout: 5000 }).toBe(false);
  expect(await window.evaluate(() => _camSnap())).toEqual(flat);
  expect(cam.flat).toBe(false);
});

test('picked in the Schematic it opens on the same camera, and hands the Schematic back untouched', async ({ window }) => {
  await openMap(window);
  const spatial = await window.evaluate(() => _camSnap());
  await window.locator('.map-view-btn[data-view="modern"]').click();
  await window.waitForTimeout(300);
  const before = await window.evaluate(() => {
    const j = _systems.find(s => s.name === 'Jita');
    _overlay = 'security'; _enterRegion(j.regionId); _showInfo(j); _render();
    return { zoom: _zoom, x: _panX, y: _panY, region: _regionView, mode: _viewMode, full: _skyFull() };
  });
  expect(before.mode).toBe('modern');
  expect(before.full, 'a data overlay dims the sky over the map').toBe(false);
  const label = window.locator('#mapSysBtn .map-sys-btn-label');
  await enter(window);
  const inside = await window.evaluate(() => ({ mode: _viewMode, scene: _sys.scene, dive: _sys.dive, full: _skyFull(), drawn: _sys.hits.length }));
  expect(inside.mode, 'the Spatial camera, input and layers').toBe('spatial');
  expect(inside.scene).toBe('system');
  expect(inside.dive, 'no star to dive into from here').toBe(null);
  expect(inside.full, 'inside a system nothing is colouring the sky').toBe(true);
  expect(inside.drawn).toBe(1 + 8 + 33 + 7 + 18);
  await expect(label).toHaveText('Back to map');

  // Dragging turns it, as it does anywhere in Spatial.
  const box = await window.locator('#mapCanvas').boundingBox();
  const yaw0 = await window.evaluate(() => _camYaw);
  await window.mouse.move(box.x + 300, box.y + 300);
  await window.mouse.down();
  await window.mouse.move(box.x + 360, box.y + 300, { steps: 3 });
  await window.mouse.up();
  expect(await window.evaluate(() => _camYaw)).not.toBe(yaw0);

  await window.keyboard.press('Escape');
  await expect.poll(() => window.evaluate(() => !!_sys), { timeout: 5000 }).toBe(false);
  expect(await window.evaluate(() => ({ zoom: _zoom, x: _panX, y: _panY, region: _regionView, mode: _viewMode, full: _skyFull() }))).toEqual(before);
  expect(await window.evaluate(() => _camSnap()), 'the Spatial camera as it was').toEqual(spatial);
  await expect(label).toHaveText('View solar system');

  // Pressing a view's button inside one: back out first, then what it asks.
  await enter(window);
  await window.locator('.map-view-btn[data-view="spatial"]').click();
  expect(await window.evaluate(() => [!!_sys, _viewMode])).toEqual([false, 'spatial']);
  await window.locator('.map-view-btn[data-view="modern"]').click();
  const schematic = () => window.evaluate(() => ({ zoom: _zoom, x: _panX, y: _panY, region: _regionView, mode: _viewMode }));
  const was = await schematic();
  await enter(window);
  await window.locator('.map-view-btn[data-view="modern"]').click();
  expect(await window.evaluate(() => !!_sys)).toBe(false);
  expect(await schematic(), 'back as it was: pressing its own button is not a switch of view, so no refit').toEqual(was);

  // On the way out the light clears on the Schematic, not the Spatial map behind it.
  await enter(window);
  const fading = await window.evaluate(() => {
    _solarLeave();
    if (_sys.raf) { cancelAnimationFrame(_sys.raf); _sys.raf = 0; }
    _sys.anim.t0 = performance.now() - (Orrery.LEAVE.sink + 20);
    _solarTick();
    if (_sys.raf) { cancelAnimationFrame(_sys.raf); _sys.raf = 0; }
    return { mode: _viewMode, scene: _sys.scene, rise: _sys.rise, lit: _sys.bloom > 0.5 };
  });
  expect(fading).toEqual({ mode: 'modern', scene: 'galaxy', rise: null, lit: true });
  await window.evaluate(() => _solarFinish());
  expect(await schematic()).toEqual(was);

  // With motion reduced there is no way out but the cut, and it lands in the same place.
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await enter(window);
  await window.locator('#mapSysBtn').click();
  expect(await window.evaluate(() => !!_sys)).toBe(false);
  expect(await schematic()).toEqual(was);
  await window.emulateMedia({ reducedMotion: 'no-preference' });

  // The region picker lives in the Schematic's toolbar.
  await enter(window);
  await window.evaluate(() => { const r = document.getElementById('mapRegionSelect'); r.value = 'galaxy'; r.dispatchEvent(new Event('change')); });
  expect(await window.evaluate(() => [!!_sys, _viewMode, _regionView])).toEqual([false, 'modern', null]);
});

test('a wormhole, found by search, arrives in a flash under a sky of its own', async ({ window }) => {
  await openMap(window);
  const cam = await overJita(window);
  const field = window.locator('#mapSearchInput');
  await field.click();
  await field.fill('J140831');
  await field.press('Enter');
  await expect(window.locator('#mapInfoSystemName')).toHaveText('J140831');
  await expect(window.locator('#mapSysBtn')).toBeVisible();
  await openHeld(window);

  // Held frames: up to the cut the map stands still and the light gathers in the middle.
  const at = (ms) => window.evaluate((ms) => {
    if (_sys.raf) { cancelAnimationFrame(_sys.raf); _sys.raf = 0; }
    _sys.anim.t0 = performance.now() - ms;
    _solarTick();
    if (_sys.raf) { cancelAnimationFrame(_sys.raf); _sys.raf = 0; }
    return { scene: _sys.scene, dive: _sys.dive, bloom: _sys.bloom, zoom: _camZoom, focus: [_camFocusX, _camFocusY, _camFocusZ] };
  }, ms);
  const flash = await window.evaluate(() => Orrery.ENTER.flash);
  const early = await at(flash * 0.8);
  expect(early.scene).toBe('galaxy');
  expect(early.dive, 'it has no place on the map to dive to').toBe(null);
  expect(early.zoom, 'the map stands still').toBe(cam.zoom);
  expect(early.focus).toEqual([cam.fx, cam.fy, cam.fz]);
  expect(early.bloom).toBeGreaterThan(0.3);
  const cut = await at(flash + 2);
  expect(cut.scene).toBe('system');
  expect(cut.bloom).toBeGreaterThan(0.98);
  await settle(window);

  const r = await window.evaluate(() => {
    const L = _sys.L, sec = document.querySelector('#mapSysHudMeta .map-sys-hud-sec');
    return {
      counts: [L.planets.length, L.moons.length, L.gates.length, L.stations.length],
      drawn: _sys.hits.length,
      clouds: _sys.clouds.length,
      family: _sys.clouds[0] && _sys.clouds[0].neb.key,
      sec: getComputedStyle(sec).color, secText: sec.textContent,
    };
  });
  expect(r.counts).toEqual([2, 17, 0, 0]);
  expect(r.drawn).toBe(1 + 2 + 17);
  expect(r.clouds, 'a sky of its own').toBeGreaterThan(0);
  expect(r.family, "in its region's wormhole-class family").toMatch(/^w0/);
  // Its clouds really are what the backdrop draws - and what the dust reads its colour from.
  await expect.poll(() => window.evaluate(() => { _drawBackdrop(); return _nebDrawn.length; })).toBeGreaterThan(0);
  expect(await window.evaluate(() => _nebDrawn.every(c => c.key === _sys.clouds[0].neb.key)), "and nothing of the galaxy's").toBe(true);
  // The game's ramp is near-black here: as words it has to be lifted to be read at all.
  expect(r.secText).toBe('-1.0');
  const [cr, cg, cb] = r.sec.match(/\d+/g).map(Number);
  expect(Math.max(cr, cg, cb), r.sec).toBeGreaterThan(120);
  await expect(window.locator('#mapLegend')).not.toContainText('Stargate');
  await expect(window.locator('#mapSysHudCount')).toHaveText('2 planets · 17 moons');

  await window.locator('#mapSysBtn').click();
  await expect.poll(() => window.evaluate(() => !!_sys), { timeout: 5000 }).toBe(false);
  expect(await window.evaluate(() => _camSnap())).toEqual(cam);
  await expect(window.locator('#mapInfoSystemName')).toHaveText('J140831');
});

test('Zarzakh has no planets, and Turnur the one planet with no art of its own', async ({ window }) => {
  await openMap(window);
  const open = (name) => window.evaluate(async (name) => {
    await _showInfo(_systems.find(s => s.name === name));
    await _solarOpen();
    _solarFinish();
  }, name);
  await open('Zarzakh');
  const z = await window.evaluate(() => {
    const L = _sys.L, st = L.stations[0];
    const h = _sys.hits.find(q => q.b === st);
    return {
      counts: [L.planets.length, L.gates.length, L.stations.length],
      station: st.short, alone: !st.parent, placed: !!st.p, hit: !!h,
      drawn: _sys.hits.length,
      inView: _sys.hits.every(q => q.x > 0 && q.x < _canvas.width && q.y > 0 && q.y < _canvas.height),
      scale: L.marks.map(m => m.au),
    };
  });
  expect(z.counts).toEqual([0, 4, 1]);
  expect(z.station, 'it used to be dropped for want of a planet to sit beside').toBe('The Fulcrum');
  expect(z.alone && z.placed && z.hit).toBe(true);
  expect(z.drawn).toBe(1 + 4 + 1);
  expect(z.inView).toBe(true);
  expect(z.scale.length).toBeGreaterThan(0);
  await expect(window.locator('#mapLegend')).not.toContainText('orbit');
  await expect(window.locator('#mapLegend')).not.toContainText('Moon');
  await window.evaluate(() => _solarClose());

  await open('Turnur');
  const t = await window.evaluate(() => {
    const p = _sys.L.planets.find(q => q.planetKind === 'scorched barren');
    return { name: p.name, skin: p.skin, label: _solarKindLabel(p) };
  });
  expect(t).toEqual({ name: 'Turnur I', skin: 'barren', label: 'Scorched barren' });
});

test('every system on the map opens, with all of it drawn', async ({ window }) => {
  // The claim is "every system", so this checks every system: all 8,000-odd read
  // and laid out for real, and a spread of them - the extremes, and every 40th -
  // drawn through the real frame.
  test.setTimeout(300_000);
  await openMap(window);
  const r = await window.evaluate(async () => {
    const bad = [], systems = _systems.slice(), laid = new Map();
    for (let i = 0; i < systems.length; i += 200) {
      await Promise.all(systems.slice(i, i + 200).map(async (sys) => {
        if (!sys.star) { bad.push(`${sys.name}: no star, so never offered`); return; }
        const L = Orrery.layout(await window.eveAPI.mapGetSystemContents(sys.id));
        laid.set(sys.id, L);
        if (!L.sun) bad.push(`${sys.name}: no sun`);
        if (!L.planets.length && !L.gates.length && !L.stations.length) bad.push(`${sys.name}: nothing in it`);
        for (const b of [...L.planets, ...L.gates, ...L.stations]) {
          if (!(b.p || b.parent)) bad.push(`${b.name}: no place`);
          if (b.p && !b.p.every(Number.isFinite)) bad.push(`${b.name}: place not a number`);
        }
      }));
    }
    const names = new Set(_systems.map(s => s.name));
    let unresolved = 0;
    for (const L of laid.values()) for (const g of L.gates) if (!names.has(g.dest)) unresolved++;
    // Drawn through the real frame.
    const was = _camSnap(), mode = _viewMode;
    const extremes = ['Jita', 'Aulbres', 'N8D9-Z', 'Horkkisen', 'Thera', 'Zarzakh', 'J210750', 'J140831', 'Turnur', 'Tash-Murkon Prime', 'Nonni'];
    const sample = systems.filter((s, i) => i % 40 === 0 || extremes.includes(s.name));
    const costs = [];
    for (const sys of sample) {
      const L = laid.get(sys.id);
      if (!L) continue;
      _solarPrepare(L, sys);
      _sys = { id: sys.id, sys, L, from: mode, gal: was, dive: null, rise: null, bg: { fx: 0, fy: 0, fz: 0, px: 0, py: 0, zoom: 1, flat: false, yaw: 0, pitch: 1 }, clouds: [], scene: 'system', bloom: 0, reveal: 1, zFit: 1, sel: null, hover: null, hits: [], raf: 0, anim: null };
      _camFocusX = 0; _camFocusY = 0; _camFocusZ = 0; _camPanX = 0; _camPanY = 0; _camFlat = false; _camYaw = 0.3; _camPitch = 1;
      _sys.zFit = _solarFitZoom(); _camZoom = _sys.zFit;
      const t0 = performance.now();
      _renderSystem();
      costs.push(performance.now() - t0);
      const want = 1 + L.planets.length + L.moons.length + L.belts.length + L.gates.length + L.stations.length;
      if (_sys.hits.length !== want) bad.push(`${sys.name}: drew ${_sys.hits.length} of ${want}`);
      if (!_sys.hits.every(h => Number.isFinite(h.x) && Number.isFinite(h.y))) bad.push(`${sys.name}: a mark off the canvas`);
      for (const p of L.planets) {
        const [x, y] = _spatialToCanvas(_spatialProject(p.pt));
        if (x < 0 || y < 0 || x > _canvas.width || y > _canvas.height) bad.push(`${p.name}: outside the fitted view`);
      }
    }
    _sys = null;
    _camLoad(was);
    costs.sort((a, b) => a - b);
    const map = (() => { const t = performance.now(); _render(); return performance.now() - t; })();
    return { total: systems.length, laid: laid.size, unresolved, sampled: costs.length, median: costs[costs.length >> 1], map, bad: bad.slice(0, 20), badCount: bad.length };
  });
  expect(r.bad, `${r.badCount} problems across ${r.total} systems`).toEqual([]);
  expect(r.total, 'known space and wormhole space').toBeGreaterThan(8000);
  expect(r.laid).toBe(r.total);
  expect(r.unresolved, 'every gate leads to a system on the map').toBe(0);
  expect(r.sampled).toBeGreaterThan(200);
  expect(r.median, `${r.median.toFixed(1)} ms a frame against ${r.map.toFixed(0)} ms for the galaxy`).toBeLessThan(r.map);
});
