// Stargate planner — Ansiblex fares, hull classes and capacitor.
//
// The fare table and its arithmetic are covered under Node (test/
// force_projection.test.js), including CCP's worked examples. These check the
// router: that a bridge is only an edge when the hull may use it and the origin
// structure has the capacitor for the whole fleet.
//
// Every case uses one bridge from deep in an alliance's space straight to its
// capital's doorstep, so taking it is a large shortcut and the route length
// says plainly whether the router used it.
const { test, expect } = require('./support/electron-app');

async function openMap(window) {
  await window.locator('.nav-btn[data-page="map"]').click();
  await expect(window.locator('#page-map')).toBeVisible({ timeout: 15_000 });
  await expect(window.locator('#mapCanvas')).toBeVisible({ timeout: 20_000 });
  await window.evaluate(() => _navSettled);
  await window.waitForTimeout(1500);
}

/**
 * Null-sec within 30 LY of 1DQ1-A held by one alliance with 1DQ1-A as capital.
 * Null only: sov - and so an Ansiblex - cannot exist in empire space.
 * B sits beside the capital (zone 1); A is out in zone 4.
 */
async function seed(window) {
  // The map's first live sov fetch can still be in flight: stamping _sovAt below
  // marks this seed as newer, so a late answer leaves it alone.
  return window.evaluate(() => {
    const cap = _systems.find(s => s.name === '1DQ1-A');
    const ly = (s) => Math.hypot(s.x - cap.x, s.y - cap.y, s.z - cap.z) / ForceProjection.LY_METRES;
    _sovMap = {};
    for (const s of _systems) {
      _sovMap[s.id] = (s.id < 31000000 && s.sec <= 0 && ly(s) < 30)
        ? { allianceId: 1001, isCapital: s.id === cap.id }
        : { allianceId: null, isCapital: false };
    }
    _sovAt = Date.now();
    _sgDown = {};
    _fnfLoaded = true;                 // standings never resolve offline
    const held = _systems.filter(s => _sovMap[s.id].allianceId === 1001);
    const B = held.find(s => ly(s) > 1 && ly(s) < 4);
    const A = held.find(s => ly(s) > 15.5 && ly(s) < 19.5);
    _savedBridges = [[A.id, B.id]];
    return { A: A.id, B: B.id, aName: A.name, bName: B.name, aLy: ly(A), bLy: ly(B) };
  });
}

/** Jumps from `from` to `to` for a hull and fleet size; null if unreachable. */
function jumps(window, from, to, o) {
  return window.evaluate(({ from, to, o }) => {
    const r = _routeDijkstra(from, to, Object.assign({ mode: 'shortest', useBridges: true }, o));
    return r ? r.path.length - 1 : null;
  }, { from, to, o });
}

test('heading home is free; heading out costs the destination zone', async ({ window }) => {
  await openMap(window);
  const s = await seed(window);
  const f = await window.evaluate((s) => ({
    home: _bridgeHop(s.A, s.B, { shipClass: 'battleship', fleet: 1 }),
    out:  _bridgeHop(s.B, s.A, { shipClass: 'battleship', fleet: 1 }),
  }), s);
  expect(f.home.zone).toBe(1);
  expect(f.home.fare).toBe(0);
  expect(f.out.zone).toBe(4);
  expect(f.out.fare).toBe(148.5);                // battleship 16.5 x zone 4's 9
});

test('a full capacitor carries 8 battleships out, not 9', async ({ window }) => {
  // 8 x 148.5 = 1188 TJ fits in 1250; 9 x 148.5 = 1336.5 does not. A bridge
  // that cannot carry the whole fleet is, for that fleet, a bridge that is down.
  await openMap(window);
  const s = await seed(window);
  const gates = await jumps(window, s.B, s.A, { useBridges: false });
  expect(gates).toBeGreaterThan(1);
  expect(await jumps(window, s.B, s.A, { shipClass: 'battleship', fleet: 8 })).toBe(1);
  expect(await jumps(window, s.B, s.A, { shipClass: 'battleship', fleet: 9 })).toBe(gates);
});

test('capitals are barred from bridges; Rorquals are not', async ({ window }) => {
  await openMap(window);
  const s = await seed(window);
  const gates = await jumps(window, s.B, s.A, { useBridges: false });
  for (const cls of ['carrier', 'dread', 'fax', 'super', 'titan']) {
    expect(await jumps(window, s.B, s.A, { shipClass: cls, fleet: 1 }), cls).toBe(gates);
  }
  expect(await jumps(window, s.B, s.A, { shipClass: 'rorqual', fleet: 1 })).toBe(1);
});

test('a dry Ansiblex blocks only the jumps that leave from it', async ({ window }) => {
  // Each end of a bridge is its own structure with its own capacitor: B->A
  // drains B, A->B drains A. Marking B dry must not strand you on the way home.
  await openMap(window);
  const s = await seed(window);
  const gates = await jumps(window, s.B, s.A, { useBridges: false });
  await window.evaluate((s) => { _sgDown[s.B] = Date.now(); }, s);
  expect(await jumps(window, s.B, s.A, { shipClass: 'hauler', fleet: 1 })).toBe(gates);
  expect(await jumps(window, s.A, s.B, { shipClass: 'hauler', fleet: 1 })).toBe(1);
});

test('a dry Ansiblex recharges at ~200 TJ an hour and rejoins the router', async ({ window }) => {
  await openMap(window);
  const s = await seed(window);
  const gates = await jumps(window, s.B, s.A, { useBridges: false });
  const avail = await window.evaluate((s) => {
    _sgDown[s.B] = Date.now() - 2 * 3600000;    // drained two hours ago
    return _ansiblexAvailableTJ(s.B);
  }, s);
  expect(Math.round(avail)).toBe(400);
  expect(await jumps(window, s.B, s.A, { shipClass: 'battleship', fleet: 2 })).toBe(1);      // 297 TJ
  expect(await jumps(window, s.B, s.A, { shipClass: 'battleship', fleet: 3 })).toBe(gates);  // 445.5 TJ
  const pruned = await window.evaluate((s) => {
    _sgDown[s.B] = Date.now() - 7 * 3600000;    // past full recharge
    _sgPruneDown();
    return s.B in _sgDown;
  }, s);
  expect(pruned).toBe(false);
});

test('the planner shows each bridge fare, and Out of cap re-routes around it', async ({ window }) => {
  await openMap(window);
  const s = await seed(window);
  await window.evaluate(() => openStargatePlanner());
  await window.locator('#sgShip').selectOption('battleship');
  await window.locator('#sgFleet').fill('4');
  await window.locator('#sgFrom').fill(s.bName);
  await window.locator('#sgTo').fill(s.aName);
  await window.evaluate(() => _sgPlot());       // Plot also minimises the panel to show the map

  const row = window.locator('#sgResult .sg-bridge-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('148.5 TJ');
  await expect(row).toContainText('594 TJ');    // x 4 ships

  await row.locator('.sg-down').click();
  await expect(window.locator('#sgResult .sg-bridge-row')).toHaveCount(0);
  await expect(window.locator('#sgResult')).toContainText('so the route goes around');
  const marked = await window.evaluate((s) => s.B in _sgDown, s);
  expect(marked).toBe(true);
});

test('a capital is told plainly why it is on the gates', async ({ window }) => {
  await openMap(window);
  const s = await seed(window);
  await window.evaluate(() => openStargatePlanner());
  await window.locator('#sgShip').selectOption('titan');
  await window.locator('#sgFrom').fill(s.bName);
  await window.locator('#sgTo').fill(s.aName);
  await window.evaluate(() => _sgPlot());
  await expect(window.locator('#sgResult')).toContainText("Titans can't use Ansiblex jump bridges");
  await expect(window.locator('#sgResult .sg-bridge-row')).toHaveCount(0);
});

test('alternative routes obey the hull too', async ({ window }) => {
  // The plot and the alternatives search each used to build their own options
  // object; a field added to one and not the other would let the alternatives
  // route a titan straight across the bridge network.
  await openMap(window);
  const s = await seed(window);
  await window.evaluate(() => openStargatePlanner());
  await window.locator('#sgShip').selectOption('titan');
  await window.locator('#sgFrom').fill(s.bName);
  await window.locator('#sgTo').fill(s.aName);
  await window.evaluate(() => _sgShowAlternatives());
  const lens = await window.evaluate(() => (_sgAltRoutes || []).map(r => r.path.length - 1));
  expect(lens.length).toBeGreaterThan(0);
  for (const n of lens) expect(n).toBeGreaterThan(1);   // the 1-jump route is the bridge
});

test('route home goes to your own alliance capital', async ({ window }) => {
  await openMap(window);
  const s = await seed(window);
  await window.evaluate(() => { _fnfAllianceId = 1001; openStargatePlanner(); });
  await window.locator('#sgFrom').fill(s.aName);
  await window.locator('#sgHomeBtn').click();
  await expect(window.locator('#sgTo')).toHaveValue('1DQ1-A');
});
