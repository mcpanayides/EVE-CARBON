// Jump-bridge shimmer: in the Spatial view a light runs along each bridge from
// its first system to its second, so the two ends of an arc can be told apart.
// Wormholes are drawn the bridges' way and carry the same light, in violet,
// leaving Thera or Turnur.
//
// Where a frame has to be pinned down, the tests set the animation clock and
// draw; where what matters is whether the loop runs at all, they watch the real
// one. It must stop whenever nobody is looking - unfocused, map hidden, nothing
// to animate (DESIGN.md: the Nothing-Animates-Unwatched rule).
const { test, expect } = require('./support/electron-app');

/**
 * The Spatial map, flown in far enough for full-size lights, with a single
 * bridge between two systems well apart on screen. Starts "unfocused", so the
 * clock moves only when a test moves it.
 */
async function openWithBridge(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
  return window.evaluate(() => {
    document.body.classList.add('app-unfocused');
    _viewMode = 'spatial'; _camFlat = false; _fitSpatial();
    _camZoom *= 1.25 * _JB_FX.fullAt / (_medianGateLen() * _spatialPxPerUnit());
    const W = _canvas.width, H = _canvas.height;
    const near = (fx, fy) => {
      let best = null, bd = Infinity;
      for (const s of _spatialSystems()) {
        const c = _spatialCanvasOf(s.id);
        if (!c) continue;
        const d = (c[0] - W * fx) ** 2 + (c[1] - H * fy) ** 2;
        if (d < bd) { bd = d; best = s.id; }
      }
      return best;
    };
    _savedBridges = [[near(0.4, 0.55), near(0.62, 0.42)]];
    _showJb = true;
    // Wormholes off: whatever EvE-Scout answered would carry lights of their own.
    _showWh = false;
    _render();
    return _jbArcs[0];
  });
}

/** Draw the frame where the bridge is at phase p (0..1 crossing, then flare, then rest). */
function drawAt(window, p) {
  return window.evaluate((p) => {
    const arc = _jbArcs[0], c = _JB_FX.cycle;
    _jbFxClock = ((p * _JB_FX.travel - arc.seed * c) % c + c) % c;
    _jbFxDraw();
  }, p);
}

/** The overlay's alpha at a point on the arc (t along it), or at raw canvas coordinates. */
function alphaOnArc(window, t) {
  return window.evaluate((t) => {
    const [x, y] = _arcPoint(_jbArcs[0], t);
    return _jbFxCtx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3];
  }, t);
}

const running = (window) => window.evaluate(() => _jbFxRaf !== 0);
const clock   = (window) => window.evaluate(() => _jbFxClock);
const overlayEmpty = (window) => window.evaluate(() => {
  const d = _jbFxCtx.getImageData(0, 0, _jbFx.width, _jbFx.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
});

test('the light runs from the first system to the second, head first, and lands', async ({ window }) => {
  const arc = await openWithBridge(window);
  expect(arc, 'the bridge arc was drawn and recorded').toBeTruthy();

  let last = Infinity;
  for (const p of [0.25, 0.5, 0.75]) {
    await drawAt(window, p);
    const head = await window.evaluate((p) => _arcPoint(_jbArcs[0], p), p);
    const toEnd = Math.hypot(head[0] - arc.bx, head[1] - arc.by);
    expect(toEnd, `closing on the second system at ${p}`).toBeLessThan(last);
    last = toEnd;
    expect(await alphaOnArc(window, p), `bright head at ${p}`).toBeGreaterThan(200);
    expect(await alphaOnArc(window, p - 0.08), `tail behind at ${p}`).toBeGreaterThan(40);
    expect(await alphaOnArc(window, p + 0.12), `nothing ahead at ${p}`).toBe(0);
  }

  // Landing: a flare on the second system, none on the first.
  await window.evaluate(() => {
    const arc = _jbArcs[0], c = _JB_FX.cycle;
    const p = 1 + 0.1 * _JB_FX.flare / _JB_FX.travel;
    _jbFxClock = ((p * _JB_FX.travel - arc.seed * c) % c + c) % c;
    _jbFxDraw();
  });
  expect(await alphaOnArc(window, 1), 'flare on the second system').toBeGreaterThan(40);
  expect(await alphaOnArc(window, 0), 'nothing on the first').toBe(0);

  // Resting before the next departure: nothing at all.
  await drawAt(window, (3200 - 60) / 1700);
  for (const t of [0, 0.5, 1]) expect(await alphaOnArc(window, t), `rest at ${t}`).toBe(0);
});

test('the lights shrink with the map as you pull out, and go once they would be specks', async ({ window }) => {
  // Sized off how long a typical gate looks: full size flown in, never bigger,
  // smaller pulled out. A fixed size hung them over the zoomed-out galaxy like orbs.
  await openWithBridge(window);
  const aroundHead = () => window.evaluate(() => {
    const a = _jbArcs[0];
    const [hx, hy] = _arcPoint(a, 0.5), [x2, y2] = _arcPoint(a, 0.51);
    const d = Math.hypot(x2 - hx, y2 - hy);
    const sx = hx - (y2 - hy) / d * 4, sy = hy + (x2 - hx) / d * 4;    // 4 px out, across the arc
    return {
      centre: _jbFxCtx.getImageData(Math.round(hx), Math.round(hy), 1, 1).data[3],
      beside: _jbFxCtx.getImageData(Math.round(sx), Math.round(sy), 1, 1).data[3],
    };
  });

  expect(await window.evaluate(() => _jbFxScale)).toBe(1);
  await drawAt(window, 0.5);
  expect((await aroundHead()).beside, 'full size: 4 px out is inside the light').toBeGreaterThan(0);

  await window.evaluate(() => {
    _camZoom *= 0.5 * _JB_FX.fullAt / (_medianGateLen() * _spatialPxPerUnit());
    _render();
  });
  expect(await window.evaluate(() => _jbFxScale)).toBeCloseTo(0.5, 5);
  await drawAt(window, 0.5);
  const half = await aroundHead();
  expect(half.centre, 'half size: the head is still there').toBeGreaterThan(100);
  expect(half.beside, 'half size: 4 px out is clear of it').toBe(0);

  // The whole galaxy: specks - nothing drawn, and nothing left running.
  await window.evaluate(() => { document.body.classList.remove('app-unfocused'); _fitSpatial(); _render(); });
  expect(await window.evaluate(() => _jbFxScale)).toBeLessThan(0.25);
  await expect.poll(() => running(window)).toBe(false);
  expect(await overlayEmpty(window)).toBe(true);
});

test('it stops when the window loses focus, and picks up again on focus', async ({ window }) => {
  await openWithBridge(window);
  const c0 = await clock(window);
  await window.waitForTimeout(400);
  expect(await clock(window), 'unfocused from the start: frozen').toBe(c0);
  expect(await running(window)).toBe(false);

  await window.evaluate(() => document.body.classList.remove('app-unfocused'));
  await window.waitForTimeout(400);
  const c1 = await clock(window);
  expect(c1, 'focused: the clock moves').toBeGreaterThan(c0 + 150);
  expect(await running(window)).toBe(true);

  await window.evaluate(() => document.body.classList.add('app-unfocused'));
  await window.waitForTimeout(100);
  const c2 = await clock(window);
  await window.waitForTimeout(400);
  expect(await clock(window), 'blurred: stopped where it was').toBe(c2);
  expect(await running(window)).toBe(false);
});

test('nothing runs with the bridges off, in Schematic, or off the map page', async ({ window }) => {
  await openWithBridge(window);
  await window.evaluate(() => document.body.classList.remove('app-unfocused'));
  await expect.poll(() => running(window)).toBe(true);

  await window.evaluate(() => { _showJb = false; _render(); });
  await expect.poll(() => running(window), 'bridges off').toBe(false);
  expect(await overlayEmpty(window)).toBe(true);

  // Schematic keeps its arcs still: drawn, but nothing recorded to animate.
  await window.evaluate(() => { _showJb = true; });
  await window.locator('.map-view-btn[data-view="modern"]').click();
  await window.waitForTimeout(300);
  expect(await window.evaluate(() => _jbArcs.length), 'Schematic').toBe(0);
  await expect.poll(() => running(window), 'Schematic').toBe(false);
  expect(await overlayEmpty(window)).toBe(true);

  // Switching back refits to the whole galaxy, where the lights are specks;
  // flown back in, they run again.
  await window.locator('.map-view-btn[data-view="spatial"]').click();
  await window.evaluate(() => {
    _camZoom *= 1.25 * _JB_FX.fullAt / (_medianGateLen() * _spatialPxPerUnit());
    _render();
  });
  await expect.poll(() => running(window), 'back in Spatial').toBe(true);

  await window.locator('.nav-btn[data-page="dashboard"]').click();
  await expect.poll(() => running(window), 'map page left').toBe(false);
});

test('reduced motion gets a still frame with a light on every bridge, live', async ({ window }) => {
  await openWithBridge(window);
  await window.evaluate(() => document.body.classList.remove('app-unfocused'));
  await expect.poll(() => running(window)).toBe(true);

  await window.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => running(window), 'reduce: the loop stops').toBe(false);
  const c = await clock(window);
  await window.waitForTimeout(300);
  expect(await clock(window)).toBe(c);
  const still = await window.evaluate(() => _JB_FX.still);
  expect(await alphaOnArc(window, still), 'parked light').toBeGreaterThan(200);

  await window.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => running(window), 'and back').toBe(true);
});

test('a wormhole is drawn the bridges’ way and carries the same light, in violet', async ({ window }) => {
  // The bridge set up above, made a wormhole: bridges off, the same pair as a hole.
  await openWithBridge(window);
  const arc = await window.evaluate(() => {
    _whArcEdges = _savedBridges; _savedBridges = [];
    _showWh = true; _showJb = false;
    _render();
    return _jbArcs[0];
  });
  expect(arc, 'the wormhole arc was drawn and recorded for the light').toBeTruthy();
  expect(arc.rgb).toBe('189,92,250');
  expect(arc.w, 'the bridges’ line weight').toBe(1.6);
  // Same weight, glow, bow and end nubs as a bridge; only the colour differs.
  const style = await window.evaluate(() => {
    const shape = (s) => ({ blur: s.blur, bow: s.bow, bowMax: s.bowMax, nub: !!s.nubFill });
    return { wh: shape(_ARC_WH), jb: shape(_ARC_JB), stroke: _ARC_WH.stroke };
  });
  expect(style.wh).toEqual(style.jb);
  expect(style.stroke).toBe('rgba(189,92,250,0.85)');

  // The light in flight: a bright head, and a violet tail behind it.
  await drawAt(window, 0.5);
  expect(await alphaOnArc(window, 0.5), 'bright head').toBeGreaterThan(200);
  const [r, g, b] = await window.evaluate(() => {
    const [x, y] = _arcPoint(_jbArcs[0], 0.44);
    return Array.from(_jbFxCtx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
  });
  expect(b, 'violet, not bridge green').toBeGreaterThan(g + 60);
  expect(r).toBeGreaterThan(g + 40);
});

test('a wormhole’s light leaves Thera or Turnur, and the legend shows it in violet', async ({ window }) => {
  await openWithBridge(window);
  const edges = await window.evaluate(() => {
    // EvE-Scout names a hole from either end; Turnur and Thera go first either way.
    _whConns = [{ inId: 30000142, outId: _TURNUR_ID }, { inId: _THERA_ID, outId: 30002187 },
                { inId: 30000142, outId: 30002187 }];
    _rebuildWhArcs();
    _showWh = true; _updateLegend();
    return _whArcEdges;
  });
  expect(edges).toEqual([[30002086, 30000142], [31000005, 30002187], [30000142, 30002187]]);
  const swatch = window.locator('#mapLegend .map-legend-row', { hasText: 'Wormhole' }).locator('.map-legend-line');
  await expect(swatch).toHaveCSS('background-color', 'rgba(189, 92, 250, 0.85)');
});

test('the overlay sits exactly on the map and never takes the mouse', async ({ window }) => {
  await openWithBridge(window);
  const r = await window.evaluate(() => {
    const fx = document.getElementById('mapFxCanvas');
    const a = fx.getBoundingClientRect(), b = _canvas.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      box: [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height],
      px: [fx.width - _canvas.width, fx.height - _canvas.height],
      hit: hit && hit.id,
    };
  });
  expect(r.box).toEqual([0, 0, 0, 0]);
  expect(r.px).toEqual([0, 0]);
  expect(r.hit).toBe('mapCanvas');
});
