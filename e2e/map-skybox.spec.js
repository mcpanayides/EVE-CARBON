// The Spatial map's backdrop: one skybox for the whole cluster, and each
// region's own nebula drawn behind it - our own art, coloured by the family of
// skybox the SDE assigns the region (a = Amarr side, c = Caldari, m = Minmatar…).
const { test, expect } = require('./support/electron-app');

async function openSpatial(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
  await window.evaluate(() => { _viewMode = 'spatial'; _camFlat = false; _overlay = 'natural'; _fitSpatial(); _render(); });
}

/** Render until every queued cloud is painted and faded in. */
async function settle(window) {
  await window.evaluate(() => _render());
  await window.waitForFunction(() => _nebQueue.length === 0, null, { timeout: 30_000 });
  await window.waitForTimeout(600);
  await window.evaluate(() => _render());
}

test('every region on the map carries its SDE skybox, in the right family', async ({ window }) => {
  await openSpatial(window);
  const r = await window.evaluate(() => {
    const family = (name) => {
      const id = Object.keys(_regions).find(k => _regions[k] === name);
      const neb = Nebula.familyOf(_regionNebulae[id]);
      return neb && neb.key;
    };
    const shown = new Set(_spatialSystems().map(s => s.regionId));
    return {
      shown: shown.size,
      withSky: [...shown].filter(id => Nebula.familyOf(_regionNebulae[id])).length,
      // Read from the SDE on 2026-10-29.
      keys: ['Genesis', 'Kador', 'Domain', 'The Citadel', 'Metropolis', 'Pochven'].map(family),
    };
  });
  expect(r.withSky).toBe(r.shown);
  expect(r.keys).toEqual(['a01', 'a02', 'a03', 'c01', 'm01', 'a08']);
});

/**
 * Draw the nebula layer alone, on black: what sits behind the regions. With the
 * stars on top, a dense region like The Citadel is mostly orange starlight - a
 * median taken there measured the stars, not the cloud behind them.
 */
function nebulaLayer(window) {
  return window.evaluate(() => {
    _ctx.fillStyle = '#000';
    _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
    _drawRegionNebulae(_ctx, _canvas.width, _canvas.height);
  });
}

/** Median colour of the nebula layer over a region's middle. */
function regionColour(window, name) {
  return window.evaluate((name) => {
    const g = _regionGeometry().find(x => _regions[x.id] === name);
    const pr = _spatialProject({ tx: g.x, ty: g.y, tz: g.z });
    const [cx, cy] = _spatialToCanvas(pr);
    const R = Math.max(8, g.r * pr.f * _spatialScale() * 0.6);
    const ch = [[], [], []];
    for (let k = 0; k < 400; k++) {
      const a = k * 2.399963, d = R * Math.sqrt(k / 400);     // a sunflower spread over the disc
      const p = _ctx.getImageData(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d), 1, 1).data;
      for (let c = 0; c < 3; c++) ch[c].push(p[c]);
    }
    return ch.map(v => v.sort((x, y) => x - y)[v.length >> 1]);
  }, name);
}

/** How many regions on screen show their own family's hue at their middle, of how many judged. */
function trueToFamily(window) {
  return window.evaluate(() => {
    const hueOf = ([r, g, b]) => {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d < 0.02) return null;
      const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    let fair = 0, judged = 0;
    for (const g of _regionGeometry()) {
      const pr = _spatialProject({ tx: g.x, ty: g.y, tz: g.z });
      if (!pr) continue;
      const [x, y] = _spatialToCanvas(pr).map(Math.round);
      if (x < 0 || y < 0 || x >= _canvas.width || y >= _canvas.height) continue;
      const h = hueOf(Array.from(_ctx.getImageData(x, y, 1, 1).data).slice(0, 3));
      if (h === null) continue;
      judged++;
      const off = Math.abs(h - Nebula.FAMILIES[g.neb.family].hue) % 360;
      if (Math.min(off, 360 - off) <= 30) fair++;
    }
    return { fair, judged };
  });
}

test('behind each region, its family\'s colour: gold Amarr side, rust Minmatar, blue Caldari', async ({ window }) => {
  // In 3-D some regions stand in front of others from any angle, so a few
  // middles show a nearer region's cloud - fine, it is in front. The families
  // must still follow the regions almost everywhere: one circle per region
  // managed 47 of 59, smothered by Pochven's cluster-wide constellations.
  await openSpatial(window);
  await settle(window);
  await nebulaLayer(window);
  const genesis = await regionColour(window, 'Genesis');
  const metro   = await regionColour(window, 'Metropolis');
  expect(genesis[0], `Genesis ${genesis}`).toBeGreaterThan(genesis[2]);
  expect(metro[0], `Metropolis ${metro}`).toBeGreaterThan(metro[1]);
  const { fair, judged } = await trueToFamily(window);
  expect(fair / judged, `${fair} of ${judged} regions true to their family`).toBeGreaterThanOrEqual(0.9);

  // Top-down Flat lays the regions side by side, nothing in front of anything:
  // there The Citadel - packed into the Caldari/Gallente core - is Caldari blue.
  await window.evaluate(() => { _camFlat = true; _fitSpatial(); });
  await settle(window);
  await nebulaLayer(window);
  const citadel = await regionColour(window, 'The Citadel');
  expect(citadel[2], `The Citadel ${citadel}`).toBeGreaterThan(citadel[0]);
});

test('neighbouring nebulae run into each other - no gap between Kador and Domain', async ({ window }) => {
  await openSpatial(window);
  await settle(window);
  await nebulaLayer(window);
  const midway = await window.evaluate(() => {
    const c = (n) => { const g = _regionGeometry().find(x => _regions[x.id] === n); return _spatialToCanvas(_spatialProject({ tx: g.x, ty: g.y, tz: g.z })); };
    const a = c('Kador'), b = c('Domain');
    const p = _ctx.getImageData(Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), 1, 1).data;
    return p[0] + p[1] + p[2];
  });
  expect(midway, 'the clouds cover the ground between the two regions').toBeGreaterThan(30);
});

/** Brightness of a top-left block of the backdrop layer, clear of the galaxy. */
function backdropCorner(window) {
  return window.evaluate(() => {
    const d = _bgCtx.getImageData(4, 4, 60, 60).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s;
  });
}

test('the skybox turns with the camera, and zooming or panning never moves it', async ({ window }) => {
  await openSpatial(window);
  // The skybox alone: region nebulae move with the map, the sky must not.
  await window.evaluate(() => { _regionNebulae = {}; _regionGeoCache = { key: null, list: [] }; });
  await settle(window);
  const corner = () => backdropCorner(window);
  const a = await corner();
  expect(a, 'not bare black: there is a sky').toBeGreaterThan(0);
  await window.evaluate(() => { _camZoom *= 1.7; _camPanX += 140; _camPanY -= 60; _render(); });
  expect(await corner(), 'zoom and pan leave it where it was').toBe(a);
  await window.evaluate(() => { _camYaw += 0.9; _render(); });
  expect(await corner(), 'orbiting turns it').not.toBe(a);
});

test('turned off - as the star tests do - the background is bare black again', async ({ window }) => {
  await openSpatial(window);
  await window.evaluate(() => { _skyOn = false; _render(); });
  expect(await backdropCorner(window)).toBe(0);
});

test('the clouds drift on a layer of their own: the map is never redrawn for it', async ({ window }) => {
  // A full map frame costs ~40 ms; animating that would eat a core. Only the
  // backdrop layer may redraw while the clouds move - and only while watched.
  await openSpatial(window);
  await settle(window);
  const r = await window.evaluate(async () => {
    let renders = 0, drifts = 0;
    const origMap = _renderMap, origBg = _drawBackdrop;
    _renderMap = function () { renders++; return origMap.apply(this, arguments); };
    _drawBackdrop = function () { drifts++; return origBg.apply(this, arguments); };
    const snap = () => { const d = _bgCtx.getImageData(0, 0, _bg.width, _bg.height).data; let s = 0; for (let i = 0; i < d.length; i += 97) s += d[i]; return s; };
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const c0 = _bgClock, a = snap();
    document.body.classList.remove('app-unfocused');           // watched: it drifts
    await wait(1200);
    const b = snap(), c1 = _bgClock;
    document.body.classList.add('app-unfocused');              // unwatched: it holds still
    await wait(150);
    const c2 = _bgClock;
    await wait(500);
    const out = { advanced: c1 - c0, moved: a !== b, renders, drifts, frozen: _bgClock === c2, running: _bgRaf !== 0 };
    _renderMap = origMap; _drawBackdrop = origBg;
    return out;
  });
  expect(r.advanced, 'drift time ran while watched').toBeGreaterThan(800);
  expect(r.moved, 'and the clouds visibly moved').toBe(true);
  // A dozen backdrop frames, and no map frames for them. A couple of stray map
  // frames are allowed - the live sov fetch, and the alliance tickers after it,
  // can land in any 1.2 s window and redraw - but a drift that redrew the map
  // would show one per frame.
  expect(r.drifts, 'backdrop frames drawn').toBeGreaterThanOrEqual(8);
  expect(r.renders, `map redraws over ${r.drifts} drift frames`).toBeLessThanOrEqual(2);
  expect(r.frozen, 'unfocused, they hold still').toBe(true);
  expect(r.running).toBe(false);
});

test('with reduced motion the clouds stay still', async ({ window }) => {
  await openSpatial(window);
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await settle(window);
  const r = await window.evaluate(async () => {
    const c0 = _bgClock;
    document.body.classList.remove('app-unfocused');
    await new Promise(res => setTimeout(res, 600));
    return { advanced: _bgClock - c0, running: _bgRaf !== 0 };
  });
  expect(r.advanced).toBe(0);
  expect(r.running).toBe(false);
});

/** Fly to Manifest, in packed Exordium, at the zoom the stars glow full. */
async function overManifest(window) {
  await window.evaluate(() => {
    const m = _systems.find(s => s.name === 'Manifest');
    _camFocusX = m.tx; _camFocusY = m.ty; _camFocusZ = m.tz; _camPanX = 0; _camPanY = 0;
    _camZoom = 1; _camZoom = _STAR_GLOW_AT / (_medianGateLen() * _spatialPxPerUnit());
  });
  await settle(window);
}

test('packed clouds never stack into a blown-out wash - Exordium round Manifest', async ({ window }) => {
  // Exordium's constellations are tiny and packed, so dozens of clouds overlap
  // there. Each painted at the layer's strength, they stacked up to the
  // texture's bright core colour: a flat pale teal near 173 of 255. The
  // strength is now applied once, to the whole layer.
  await openSpatial(window);
  await overManifest(window);
  const p95 = await window.evaluate(() => {
    const d = _bgCtx.getImageData(0, 0, _bg.width, _bg.height).data, lum = [];
    for (let i = 0; i < d.length; i += 4 * 7) lum.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    lum.sort((a, b) => a - b);
    return lum[Math.floor(lum.length * 0.95)];
  });
  expect(p95, 'the brightest of the gas, at most').toBeLessThan(110);
});

test('film grain lands on the clouds only - the sky around them is untouched', async ({ window }) => {
  // Laid over the whole backdrop, the grain textured the skybox's faint dust
  // too, which covers nearly the whole view. It is now cut to the clouds.
  await openSpatial(window);
  await overManifest(window);
  const step = (grain) => window.evaluate((grain) => {
    const keep = _NEB.grain;
    _NEB.grain = grain; _drawBackdrop(); _NEB.grain = keep;
    const W = _bg.width, H = _bg.height;
    const d = _bgCtx.getImageData((W >> 1) - 100, (H >> 1) - 60, 200, 120).data;
    let s = 0, n = 0;
    for (let y = 0; y < 120; y++) for (let x = 1; x < 200; x++) { const i = (y * 200 + x) * 4; s += Math.abs(d[i + 1] - d[i - 3]); n++; }
    return s / n;                                         // mean step between neighbouring pixels
  }, grain);
  const smooth = await step(0), grained = await step(0.5);
  expect(grained, `on the gas: ${grained.toFixed(2)} grained vs ${smooth.toFixed(2)} smooth`).toBeGreaterThan(smooth * 1.5 + 0.5);

  // The whole galaxy in view: its top-left corner is sky and dust, no cloud.
  // There, grain on and grain off must be the same image, pixel for pixel.
  await window.evaluate(() => { _fitSpatial(); });
  await settle(window);
  const skyIdentical = await window.evaluate(() => {
    const grab = (grain) => {
      const keep = _NEB.grain;
      _NEB.grain = grain; _drawBackdrop(); _NEB.grain = keep;
      return _bgCtx.getImageData(4, 4, 60, 60).data;
    };
    const a = grab(0), b = grab(0.5);
    let lit = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] || a[i + 1] || a[i + 2]) lit++;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { same: false, lit };
    return { same: true, lit };
  });
  expect(skyIdentical.lit, 'the corner really has sky in it to spoil').toBeGreaterThan(0);
  expect(skyIdentical.same, 'grain leaves the sky alone').toBe(true);
});
