// The Spatial map's dust, twinkle and lens flares: dust drifting in front of the
// lens that streams past as you fly in and falls away as you pull out, in the
// colour of the gas behind it; stars that twinkle; small lens flares flown in,
// and a bigger one on the star the view is closing on.
//
// Where a frame has to be pinned down the tests stop the clock (the window
// "unfocused") and draw; where what matters is whether the loop runs at all,
// they watch the real one. Like the bridge shimmer it must stop whenever nobody
// is looking (DESIGN.md: the Nothing-Animates-Unwatched rule).
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
}

/**
 * The view the flares were judged in: G15Z-W selected in Scalding Pass, at the
 * exact pixel scale of that screenshot (fitted to 42 systems in it, to ~1 px).
 * Starts "unfocused", so nothing moves unless a test moves it.
 */
function judgedView(window) {
  return window.evaluate(() => {
    document.body.classList.add('app-unfocused');
    _viewMode = 'spatial'; _camFlat = false; _overlay = 'natural'; _fitSpatial();
    const g = _systems.find(s => s.name === 'G15Z-W');
    _camFocusX = g.tx; _camFocusY = g.ty; _camFocusZ = g.tz;
    _camYaw = -1.5597; _camPitch = 0.90375;
    _camZoom = 26266 / _spatialScale();
    _camPanX = 0; _camPanY = 0;
    _render();
  });
}

/** How far a star's light reaches across the sky layer, tip to tip: the widest of five rows (a ray straddles pixels). */
function spanAt(window, name) {
  return window.evaluate((name) => {
    const s = _systems.find(q => q.name === name);
    const [cx, cy] = _spatialCanvasOf(s.id).map(Math.round);
    const d = _skyCtx.getImageData(cx - 40, cy - 2, 81, 5).data;
    const lit = (i) => { for (let j = 0; j < 5; j++) if (d[(j * 81 + i) * 4 + 3] > 12) return true; return false; };
    let lo = 40, hi = 40;
    while (lo > 0 && lit(lo - 1)) lo--;
    while (hi < 80 && lit(hi + 1)) hi++;
    return hi - lo;
  }, name);
}

const running = (window) => window.evaluate(() => _skyRaf !== 0);
const layerEmpty = (window) => window.evaluate(() => {
  const d = _skyCtx.getImageData(0, 0, _sky.width, _sky.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
});

test('the sky sits exactly on the map, adds its light to it, and never takes the mouse', async ({ window }) => {
  await openMap(window);
  await judgedView(window);
  const r = await window.evaluate(() => {
    const a = _sky.getBoundingClientRect(), b = _canvas.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      box: [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height],
      px: [_sky.width - _canvas.width, _sky.height - _canvas.height],
      hit: hit && hit.id,
      blend: getComputedStyle(_sky).mixBlendMode,
      above: !!(_jbFx.compareDocumentPosition(_sky) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });
  expect(r.box).toEqual([0, 0, 0, 0]);
  expect(r.px).toEqual([0, 0]);
  expect(r.hit).toBe('mapCanvas');
  // Composited normally, the flares half-covered the stars they sit on and all but vanished.
  expect(r.blend).toBe('plus-lighter');
  expect(r.above, 'over the bridge shimmer: the dust is in front of everything').toBe(true);
});

test('flown in, the star in the middle carries a flare about a third of the HJ-BCH bridge; the rest smaller ones', async ({ window }) => {
  await openMap(window);
  await judgedView(window);
  const r = await window.evaluate(() => {
    const at = (n) => _spatialCanvasOf(_systems.find(s => s.name === n).id);
    const [a, b] = [at('HJ-BCH'), at('V-F6DQ')];
    return { hero: _sysById[_skyHero]?.name, bridge: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  });
  expect(r.hero, 'the star the view is closing on').toBe('G15Z-W');
  expect(r.bridge, 'the bridge as long as it was in the screenshot').toBeGreaterThan(75);
  expect(r.bridge).toBeLessThan(90);

  const hero = await spanAt(window, 'G15Z-W');
  expect(hero / r.bridge, `${hero} px against a ${r.bridge.toFixed(0)} px bridge`).toBeGreaterThan(0.3);
  expect(hero / r.bridge).toBeLessThan(0.45);

  for (const name of ['WHI-61', 'CVY-UC', 'S-E6ES']) {
    const s = await spanAt(window, name);
    expect(s, `${name} has a flare of its own`).toBeGreaterThan(8);
    expect(s * 1.2, `${name}'s ${s} px is clearly smaller than the ${hero} px one being closed on`).toBeLessThan(hero);
  }
});

test('the stars twinkle: the same star, a moment apart, shines differently', async ({ window }) => {
  await openMap(window);
  await judgedView(window);
  const glow = (t) => window.evaluate((t) => {
    _skyClock = t;
    _skyDraw();
    const s = _systems.find(q => q.name === 'WHI-61');
    const [cx, cy] = _spatialCanvasOf(s.id).map(Math.round);
    const d = _skyCtx.getImageData(cx - 12, cy - 12, 25, 25).data;
    let sum = 0;
    for (let i = 3; i < d.length; i += 4) sum += d[i];
    return sum;
  }, t);
  const samples = [];
  for (let t = 0; t < 6000; t += 400) samples.push(await glow(t));
  const lo = Math.min(...samples), hi = Math.max(...samples);
  expect(hi / lo, `glow over six seconds: ${lo}..${hi}`).toBeGreaterThan(1.3);
});

test('the dust streams out past the lens as you fly in, and falls away as you pull out', async ({ window }) => {
  await openMap(window);
  await judgedView(window);
  await window.evaluate(() => document.body.classList.remove('app-unfocused'));
  await expect.poll(() => running(window)).toBe(true);

  // How far from the middle the specks in view sit, on average - tracking the
  // same specks, and leaving out any that left the box and came back in.
  const spread = () => window.evaluate(() => {
    const f = _skyDust, out = new Map();
    for (let i = 0; i < f.n; i++) {
      const p = SkyFx.projectDust(f, i, _SKY.speck);
      if (p) out.set(i, [Math.hypot(p[0] - f.W / 2, p[1] - f.H / 2), f.age[i]]);
    }
    return [...out];
  });
  const compare = (a, b) => {
    const before = new Map(a);
    let sum0 = 0, sum1 = 0, n = 0;
    for (const [i, [r1, age1]] of b) {
      const was = before.get(i);
      if (!was || age1 < was[1]) continue;           // came back in: not the same speck's journey
      sum0 += was[0]; sum1 += r1; n++;
    }
    return { ratio: sum1 / sum0, n };
  };
  const box = await window.locator('#mapCanvas').boundingBox();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const a = await spread();
  await window.mouse.wheel(0, -100);
  await window.waitForTimeout(450);
  const inward = compare(a, await spread());
  expect(inward.n, 'specks to follow').toBeGreaterThan(50);
  expect(inward.ratio, 'flying in: further out').toBeGreaterThan(1.05);

  const b = await spread();
  await window.mouse.wheel(0, 100);
  await window.waitForTimeout(450);
  const outward = compare(b, await spread());
  expect(outward.ratio, 'pulling out: towards the middle').toBeLessThan(0.95);
});

test('the dust keeps to the edges of the view, soft and greyed - never in the middle, never coloured like stars', async ({ window }) => {
  await openMap(window);
  await judgedView(window);
  await window.waitForFunction(() => _nebQueue.length === 0, null, { timeout: 30_000 });   // the gas painted
  await window.waitForTimeout(600);
  const r = await window.evaluate(() => {
    _render();
    _skyN = 0;                                       // the stars' flares and twinkle out of the way: the dust alone
    _skyDraw();
    const W = _sky.width, H = _sky.height, d = _skyCtx.getImageData(0, 0, W, H).data;
    let middle = 0, edge = 0, sat = 0, motes = 0;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4, a = d[i + 3];
        if (!a) continue;
        const rho = Math.hypot((2 * x - W) / W, (2 * y - H) / H);
        if (rho < 0.45) middle += a;
        else if (rho > 0.9) {
          edge += a;
          if (a > 20) {
            const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
            sat += (mx - mn) / Math.max(1, mx); motes++;
          }
        }
      }
    }
    // Here, in Scalding Pass, the gas behind the dust is a strong rust red.
    const gas = _skyCloudAt(_skyClouds(W, H), W * 0.95, H * 0.5);
    const gasSat = (Math.max(gas[0], gas[1], gas[2]) - Math.min(gas[0], gas[1], gas[2])) / Math.max(gas[0], gas[1], gas[2]);
    return { middle, edge, motes, sat: sat / Math.max(1, motes), gasSat };
  });
  expect(r.middle, 'nothing across the middle of the view').toBe(0);
  expect(r.edge, 'dust round the edges').toBeGreaterThan(0);
  expect(r.motes).toBeGreaterThan(10);
  expect(r.gasSat, 'the gas there is strongly coloured').toBeGreaterThan(0.4);
  expect(r.sat, `the dust in front of it is grey: ${r.sat.toFixed(2)} against the gas's ${r.gasSat.toFixed(2)}`).toBeLessThan(0.25);
});

test('the dust takes the colour of the gas behind it', async ({ window }) => {
  // Flat, where the regions lie side by side and none stands in front of
  // another's middle - as the skybox spec judges The Citadel.
  await openMap(window);
  await window.evaluate(() => { _viewMode = 'spatial'; _camFlat = true; _overlay = 'natural'; _fitSpatial(); _render(); });
  await window.waitForFunction(() => _nebQueue.length === 0, null, { timeout: 30_000 });
  await window.waitForTimeout(600);
  // Gold over Genesis (an Amarr-side skybox), blue over The Citadel (Caldari):
  // the colour the dust reads is the gas's own.
  const at = (name) => window.evaluate((name) => {
    _render();
    const g = _regionGeometry().find(x => _regions[x.id] === name);
    const [cx, cy] = _spatialToCanvas(_spatialProject({ tx: g.x, ty: g.y, tz: g.z }));
    _skyField = null;                                // read the clouds afresh
    return Array.from(_skyCloudAt(_skyClouds(_sky.width, _sky.height), cx, cy));
  }, name);
  const genesis = await at('Genesis'), citadel = await at('The Citadel');
  expect(genesis[3], 'thick gas over Genesis').toBeGreaterThan(0.1);
  expect(genesis[0], `Genesis gold: ${genesis}`).toBeGreaterThan(genesis[2] * 1.2);
  expect(citadel[2], `The Citadel blue: ${citadel}`).toBeGreaterThan(citadel[0] * 1.2);
});

test('reduced motion holds the flares still and drops the dust; pulled out there is nothing to show', async ({ window }) => {
  await openMap(window);
  await judgedView(window);
  await window.evaluate(() => document.body.classList.remove('app-unfocused'));
  await expect.poll(() => running(window)).toBe(true);

  await window.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => running(window), 'reduce: the loop stops').toBe(false);
  const c = await window.evaluate(() => _skyClock);
  await window.waitForTimeout(300);
  expect(await window.evaluate(() => _skyClock), 'and the clock with it').toBe(c);
  expect(await spanAt(window, 'G15Z-W'), 'the flare is still there, still').toBeGreaterThan(15);

  // The whole cluster: stars are specks - no flares, and with motion reduced
  // no twinkle and no dust either, so nothing at all.
  await window.evaluate(() => { _fitSpatial(); _render(); });
  expect(await layerEmpty(window)).toBe(true);

  await window.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => running(window), 'and back').toBe(true);
});

test('it stops when the window loses focus, off the map page and in Schematic', async ({ window }) => {
  await openMap(window);
  await judgedView(window);
  expect(await running(window), 'unfocused from the start').toBe(false);

  await window.evaluate(() => document.body.classList.remove('app-unfocused'));
  await expect.poll(() => running(window)).toBe(true);
  const c0 = await window.evaluate(() => _skyClock);
  await window.waitForTimeout(400);
  expect(await window.evaluate(() => _skyClock), 'focused: the clock moves').toBeGreaterThan(c0 + 150);

  await window.evaluate(() => document.body.classList.add('app-unfocused'));
  await expect.poll(() => running(window), 'blurred').toBe(false);
  const c1 = await window.evaluate(() => _skyClock);
  await window.waitForTimeout(300);
  expect(await window.evaluate(() => _skyClock), 'stopped where it was').toBe(c1);
  expect(await layerEmpty(window), 'its last frame left up').toBe(false);

  await window.evaluate(() => document.body.classList.remove('app-unfocused'));
  await expect.poll(() => running(window)).toBe(true);
  await window.locator('.map-view-btn[data-view="modern"]').click();
  await expect.poll(() => running(window), 'Schematic').toBe(false);
  expect(await layerEmpty(window), 'Schematic is a diagram: no sky').toBe(true);

  await window.locator('.map-view-btn[data-view="spatial"]').click();
  await expect.poll(() => running(window), 'back in Spatial').toBe(true);
  await window.locator('.nav-btn[data-page="dashboard"]').click();
  await expect.poll(() => running(window), 'map page left').toBe(false);
});

test('the map itself is never redrawn for it, and a frame stays cheap', async ({ window }) => {
  // A full map frame costs ~40 ms; animating that would eat a core. Only the
  // sky layer may redraw while the dust drifts and the stars twinkle.
  await openMap(window);
  await judgedView(window);
  const r = await window.evaluate(async () => {
    let renders = 0, frames = 0;
    const orig = _renderMap, origSky = _skyDraw;
    _renderMap = function () { renders++; return orig.apply(this, arguments); };
    _skyDraw = function () { frames++; return origSky.apply(this, arguments); };
    document.body.classList.remove('app-unfocused');
    _skySync();
    const c0 = _skyClock;
    await new Promise(res => setTimeout(res, 700));
    _renderMap = orig; _skyDraw = origSky;
    // What a frame costs here, and pulled out to all 5,500 stars.
    const cost = () => { const t0 = performance.now(); for (let i = 0; i < 20; i++) _skyDraw(); return (performance.now() - t0) / 20; };
    const near = cost();
    _fitSpatial(); _render();
    const far = cost();
    return { renders, frames, advanced: _skyClock - c0, near, far };
  });
  expect(r.advanced, 'the sky moved').toBeGreaterThan(300);
  // Twenty-odd sky frames and no map frames for them. A couple of stray map
  // frames are allowed - the live sov fetch, and the alliance tickers after it,
  // can land in any window and redraw (map-skybox.spec.js allows the same) -
  // but a sky that redrew the map would show one per frame.
  expect(r.frames, 'sky frames drawn').toBeGreaterThanOrEqual(12);
  expect(r.renders, `map redraws over ${r.frames} sky frames`).toBeLessThanOrEqual(2);
  expect(r.near, `ms a frame, flown in: ${r.near.toFixed(2)}`).toBeLessThan(8);
  expect(r.far, `ms a frame, the whole cluster: ${r.far.toFixed(2)}`).toBeLessThan(8);
});
