// Spatial viewport controls, driven by real mouse and keyboard events.
//
// The orbit used to turn about the camera's focus. After any pan that focus is
// wherever the galaxy's original centre has drifted to - often off screen - so
// a drag swung the whole map around a point nobody was looking at: a star
// grabbed under the cursor slid 360 px away over one drag. Now a drag turns
// about the selected system; with nothing selected, about Rens in the middle of
// New Eden; and once Rens is out of view too, about what is under the cursor.
// Whichever it is stays exactly where it was.
const { test, expect } = require('./support/electron-app');

async function openSpatial(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
  // Zoomed in, with Rens just past the right-hand edge: out of view, so a drag
  // turns about what is under the cursor. The galaxy's centre, where the focus
  // sits, goes out of view with it - the situation the old pivot failed in.
  await window.evaluate(() => {
    _viewMode = 'spatial'; _camFlat = false; _fitSpatial();
    _camZoom *= 2.5; _selected = null;
    _camPanX += _canvas.width + 40 - _spatialCanvasOf(_RENS_ID)[0];
    _camPanY -= 160; _render();
  });
  return window.locator('#mapCanvas').boundingBox();
}

/** The visible system nearest a fraction of the canvas. */
function starNear(window, fx, fy) {
  return window.evaluate(({ fx, fy }) => {
    const W = _canvas.width, H = _canvas.height;
    let best = null, bd = Infinity;
    for (const s of _spatialSystems()) {
      const c = _spatialCanvasOf(s.id);
      if (!c) continue;
      const d = (c[0] - W * fx) ** 2 + (c[1] - H * fy) ** 2;
      if (d < bd) { bd = d; best = { id: s.id, c }; }
    }
    return best;
  }, { fx, fy });
}

const drift = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Whether Rens is drawn inside the canvas right now. */
function rensInView(window) {
  return window.evaluate(() => {
    const c = _spatialCanvasOf(_RENS_ID);
    return !!c && c[0] >= 0 && c[0] <= _canvas.width && c[1] >= 0 && c[1] <= _canvas.height;
  });
}

/**
 * Fixed world points offset from a star along the camera's axes, in units of a
 * quarter of its depth. Markers rather than real stars, so each sits exactly
 * where a test needs it - straight in front of the star, say - whatever the
 * galaxy happens to have there.
 */
function markers(window, id, offsets) {
  return window.evaluate(({ id, offsets }) => {
    const P = _spatialPoint(id);
    const pitch = _camFlat ? Math.PI / 2 : _camPitch;
    const k = 0.25 * _spatialProject(P).depth;
    const out = {};
    for (const [name, [x, y, z]] of Object.entries(offsets)) {
      const [dx, dy, dz] = _camFromView(x * k, y * k, z * k, _camYaw, pitch);
      out[name] = { tx: P.tx + dx, ty: P.ty + dy, tz: P.tz + dz };
    }
    return out;
  }, { id, offsets });
}

/** Where the markers are drawn right now. */
function drawnAt(window, marks) {
  return window.evaluate((marks) => {
    const out = {};
    for (const [name, p] of Object.entries(marks)) out[name] = _spatialToCanvas(_spatialProject(p));
    return out;
  }, marks);
}

test('with Rens out of view, orbiting keeps the star you grabbed under the cursor', async ({ window }) => {
  const box = await openSpatial(window);
  expect(await rensInView(window)).toBe(false);
  const star = await starNear(window, 0.45, 0.5);
  const sx = box.x + star.c[0], sy = box.y + star.c[1];
  await window.mouse.move(sx, sy);
  await window.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await window.mouse.move(sx + i * 22, sy + i * 11);
    const now = await window.evaluate((id) => _spatialCanvasOf(id), star.id);
    expect(drift(now, star.c), `step ${i}`).toBeLessThan(1);
  }
  await window.mouse.up();
  // And the view really did turn - a no-op would also hold the star still.
  expect(Math.abs(await window.evaluate(() => _camYaw))).toBeGreaterThan(0.5);
});

test('the near side of the map follows the hand, across as well as down', async ({ window }) => {
  // Grab the map and turn it like a globe: drag down and the side nearest you
  // swings down, drag right and it swings right. Down always did; across ran
  // backwards - drag right and the near side went left - and nothing pinned
  // the direction, so nothing caught it.
  //
  // The markers sit on the line of sight through the grabbed star, so a turn
  // carries them across the screen rather than in or out: no ambiguity. The
  // star is selected, so it is the pivot wherever Rens happens to be.
  const box = await openSpatial(window);
  const star = await starNear(window, 0.5, 0.5);
  await window.evaluate((id) => { _selected = _sysById[id]; }, star.id);
  const sx = box.x + star.c[0], sy = box.y + star.c[1];
  const drag = async (dx, dy) => {
    await window.mouse.move(sx, sy);
    await window.mouse.down();
    await window.mouse.move(sx + dx, sy + dy, { steps: 4 });
    await window.mouse.up();
  };
  const sight = { near: [0, 0, -1], far: [0, 0, 1] };

  let m = await markers(window, star.id, sight);
  let a = await drawnAt(window, m);
  await drag(0, 40);
  let b = await drawnAt(window, m);
  expect(b.near[1] - a.near[1], 'drag down: the near side moves down').toBeGreaterThan(5);
  expect(b.far[1] - a.far[1], 'drag down: the far side moves up').toBeLessThan(-5);

  m = await markers(window, star.id, sight);
  a = await drawnAt(window, m);
  await drag(40, 0);
  b = await drawnAt(window, m);
  expect(b.near[0] - a.near[0], 'drag right: the near side moves right').toBeGreaterThan(5);
  expect(b.far[0] - a.far[0], 'drag right: the far side moves left').toBeLessThan(-5);
});

test('Flat turns the same way: the bottom of the map follows the hand', async ({ window }) => {
  // Flat is the same camera looking straight down, so its Shift-turn is the
  // same yaw. Overhead, the near side is the bottom of the screen; if the two
  // views disagreed, switching between them would reverse the gesture.
  const box = await openSpatial(window);
  await window.evaluate(() => { _camFlat = true; _fitSpatial(); _render(); });
  const star = await starNear(window, 0.5, 0.5);
  await window.evaluate((id) => { _selected = _sysById[id]; }, star.id);
  const sx = box.x + star.c[0], sy = box.y + star.c[1];
  const m = await markers(window, star.id, { below: [0, 1, 0], above: [0, -1, 0] });
  const a = await drawnAt(window, m);
  await window.keyboard.down('Shift');
  await window.mouse.move(sx, sy); await window.mouse.down();
  await window.mouse.move(sx + 40, sy, { steps: 4 }); await window.mouse.up();
  await window.keyboard.up('Shift');
  const b = await drawnAt(window, m);
  expect(b.below[0] - a.below[0], 'Shift-drag right: the bottom moves right').toBeGreaterThan(5);
  expect(b.above[0] - a.above[0], 'Shift-drag right: the top moves left').toBeLessThan(-5);
});

test('a selected system is the pivot, wherever the drag starts', async ({ window }) => {
  const box = await openSpatial(window);
  const sel = await starNear(window, 0.7, 0.5);
  await window.evaluate((id) => { _selected = _sysById[id]; }, sel.id);
  const ex = box.x + box.width * 0.25, ey = box.y + box.height * 0.5;   // far from it
  await window.mouse.move(ex, ey);
  await window.mouse.down();
  await window.mouse.move(ex + 90, ey + 40, { steps: 5 });
  const now = await window.evaluate((id) => _spatialCanvasOf(id), sel.id);
  await window.mouse.up();
  expect(drift(now, sel.c)).toBeLessThan(1);
});

test('with nothing selected the map turns about Rens, and a selection beats it', async ({ window }) => {
  // Rens sits in the middle of New Eden, so turning about it turns the galaxy
  // about its own centre. Checked by name, so the id cannot drift onto some
  // other system unnoticed.
  const box = await openSpatial(window);
  await window.evaluate(() => { _fitSpatial(); _render(); });
  expect(await window.evaluate(() => _sysById[_RENS_ID].name)).toBe('Rens');
  expect(await rensInView(window)).toBe(true);
  const ex = box.x + box.width * 0.25, ey = box.y + box.height * 0.6;   // nowhere near it
  const dragFromAfar = async (watch) => {
    await window.mouse.move(ex, ey);
    await window.mouse.down();
    await window.mouse.move(ex + 90, ey + 40, { steps: 5 });
    const at = await window.evaluate((ids) => ids.map(id => _spatialCanvasOf(id)), watch);
    await window.mouse.up();
    return at;
  };
  const rensId = await window.evaluate(() => _RENS_ID);

  const r0 = await window.evaluate(() => _spatialCanvasOf(_RENS_ID));
  const [r1] = await dragFromAfar([rensId]);
  expect(drift(r1, r0)).toBeLessThan(1);
  expect(await window.evaluate(() => _camYaw)).not.toBe(0);    // and it really turned

  const sel = await starNear(window, 0.7, 0.4);
  await window.evaluate((id) => { _selected = _sysById[id]; }, sel.id);
  const [s2, r2] = await dragFromAfar([sel.id, rensId]);
  expect(drift(s2, sel.c)).toBeLessThan(1);
  expect(drift(r2, r1)).toBeGreaterThan(5);                     // Rens gave way
});

test('Space + drag pans one-for-one; Shift no longer does', async ({ window }) => {
  const box = await openSpatial(window);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const read = () => window.evaluate(() => ({ yaw: _camYaw, pitch: _camPitch, px: _camPanX, py: _camPanY }));

  const b = await read();
  await window.keyboard.down('Space');
  await window.mouse.move(cx, cy); await window.mouse.down();
  await window.mouse.move(cx + 60, cy + 25, { steps: 4 });
  await window.mouse.up();
  await window.keyboard.up('Space');
  const a = await read();
  expect(a.yaw).toBe(b.yaw);
  expect(a.pitch).toBe(b.pitch);
  expect(Math.round(a.px - b.px)).toBe(60);
  expect(Math.round(a.py - b.py)).toBe(25);

  await window.keyboard.down('Shift');
  await window.mouse.move(cx, cy); await window.mouse.down();
  await window.mouse.move(cx + 50, cy, { steps: 4 });
  await window.mouse.up();
  await window.keyboard.up('Shift');
  const c = await read();
  expect(c.px).toBe(a.px);              // Shift is not pan any more
  expect(c.yaw).not.toBe(a.yaw);        // it orbits like a plain drag
});

test('in Flat, Space pans and Shift turns the map', async ({ window }) => {
  // Flat inverts the default (a plain drag pans), so swapping Shift for Space
  // inside the old inverted test would have made Space ROTATE here.
  const box = await openSpatial(window);
  await window.evaluate(() => { _camFlat = true; _fitSpatial(); _render(); });
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const read = () => window.evaluate(() => ({ yaw: _camYaw, px: _camPanX }));
  const drag = async (key) => {
    await window.keyboard.down(key);
    await window.mouse.move(cx, cy); await window.mouse.down();
    await window.mouse.move(cx + 40, cy, { steps: 3 }); await window.mouse.up();
    await window.keyboard.up(key);
  };
  const a = await read();
  await drag('Space');
  const b = await read();
  expect(b.px).not.toBe(a.px);
  expect(b.yaw).toBe(a.yaw);
  await drag('Shift');
  const c = await read();
  expect(c.yaw).not.toBe(b.yaw);
});

test('right-drag pans one-for-one, in every view', async ({ window }) => {
  const box = await openSpatial(window);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const read = () => window.evaluate(() => ({
    yaw: _camYaw, pitch: _camPitch, px: _camPanX, py: _camPanY, sx: _panX, sy: _panY,
  }));
  const rightDrag = async () => {
    await window.mouse.move(cx, cy);
    await window.mouse.down({ button: 'right' });
    await window.mouse.move(cx + 60, cy + 25, { steps: 4 });
    await window.mouse.up({ button: 'right' });
  };

  for (const flat of [false, true]) {
    await window.evaluate((flat) => { _camFlat = flat; _render(); }, flat);
    const a = await read();
    await rightDrag();
    const b = await read();
    const view = flat ? 'Flat' : '3-D';
    expect(b.yaw, view).toBe(a.yaw);
    expect(b.pitch, view).toBe(a.pitch);
    expect(Math.round(b.px - a.px), view).toBe(60);
    expect(Math.round(b.py - a.py), view).toBe(25);
  }
  await window.locator('.map-view-btn[data-view="modern"]').click();    // Schematic
  await window.waitForTimeout(300);
  const a = await read();
  await rightDrag();
  const b = await read();
  expect(Math.round(b.sx - a.sx), 'Schematic').toBe(60);
  expect(Math.round(b.sy - a.sy), 'Schematic').toBe(25);
});

test('a right-click still opens the system menu; a right-drag never does', async ({ window }) => {
  // The menu opens on release, once a click can be told from a drag. The
  // browser's own menu event still fires for a right-drag - counted here, so
  // "no menu" cannot pass merely because nothing asked for one.
  const box = await openSpatial(window);
  await window.evaluate(() => {
    window.__menuEvents = 0;
    _canvas.addEventListener('contextmenu', () => { window.__menuEvents++; });
  });
  const star = await starNear(window, 0.45, 0.5);
  const sx = box.x + star.c[0], sy = box.y + star.c[1];
  // Whichever system a click there means: where two overlap, the one in front.
  const name = await window.evaluate(([x, y]) => _hitTest(x, y).name, star.c);
  const menu = window.locator('#mapCtxMenu');

  await window.mouse.click(sx, sy, { button: 'right' });
  await expect(menu).toHaveCount(1);
  await expect(menu.locator('.map-ctx-title')).toHaveText(name);
  expect(await window.evaluate(() => _selected)).toBeNull();     // not a left-click

  // Dragged with the right button the star travels with the cursor, so it is
  // still under it on release - exactly where a menu would wrongly open.
  await window.mouse.move(sx, sy);
  await window.mouse.down({ button: 'right' });
  await window.mouse.move(sx + 60, sy + 25, { steps: 4 });
  await window.mouse.up({ button: 'right' });
  await expect.poll(() => window.evaluate(() => window.__menuEvents)).toBeGreaterThanOrEqual(2);
  await expect(menu).toHaveCount(0);

  // A menu request with no right press behind it - a long press on a touch
  // screen - still opens the menu straight from the event.
  await window.evaluate(({ x, y }) => {
    _rightUpAt = -Infinity;
    const r = _canvas.getBoundingClientRect();
    _canvas.dispatchEvent(new MouseEvent('contextmenu',
      { clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true }));
  }, { x: star.c[0] + 60, y: star.c[1] + 25 });
  await expect(menu).toHaveCount(1);
});

test('F refits, as the empty-view message has always said', async ({ window }) => {
  await openSpatial(window);
  await window.evaluate(() => { _camPanX = 999; _camPanY = -999; _render(); });
  await window.keyboard.press('KeyF');
  const p = await window.evaluate(() => [Math.round(_camPanX), Math.round(_camPanY)]);
  expect(Math.abs(p[0])).toBeLessThan(50);
  expect(Math.abs(p[1])).toBeLessThan(50);
});

test('Space typed into a field is a space, and does not stick as pan', async ({ window }) => {
  await openSpatial(window);
  const field = window.locator('#mapSearch, #mapSearchInput, .map-search input').first();
  await expect(field).toBeVisible();
  await field.click();
  await field.type('a b');
  await expect(field).toHaveValue('a b');
  expect(await window.evaluate(() => _spaceHeld)).toBe(false);
});
