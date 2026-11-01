// One solar system laid out for the map (src/func/orrery.js): everything keeps
// its true direction, the order of distances never changes, and what sits
// beside a planet is set round it by decades rather than lost inside its disc.
const test = require('node:test');
const assert = require('node:assert/strict');
const Orrery = require('../src/func/orrery.js');

const AU = Orrery.AU, KM = 1000;
const G = Orrery.GROUP;

/** A small made-up system: three planets, moons, a station, a gate beside a planet and one out on its own. */
function rows() {
  return [
    { id: 1, groupId: G.SUN, typeName: 'Sun O1 (Bright Blue)', name: 'Testa - Star', x: 0, y: 0, z: 0, radius: 5e8 },
    { id: 10, groupId: G.PLANET, typeName: 'Planet (Barren)', name: 'Testa I', celestialIndex: 1, x: 0.3 * AU, y: 0, z: 0, radius: 2e6 },
    { id: 20, groupId: G.PLANET, typeName: 'Planet (Gas)', name: 'Testa II', celestialIndex: 2, x: 0, y: 0.5 * AU, z: 3 * AU, radius: 5.8e7 },
    { id: 30, groupId: G.PLANET, typeName: 'Planet (Ice)', name: 'Testa III', celestialIndex: 3, x: -30 * AU, y: -2 * AU, z: 0, radius: 7e6 },
    { id: 21, groupId: G.MOON, orbitId: 20, orbitIndex: 1, name: 'Testa II - Moon 1', x: 70000 * KM, y: 0.5 * AU, z: 3 * AU, radius: 1e6 },
    { id: 22, groupId: G.MOON, orbitId: 20, orbitIndex: 2, name: 'Testa II - Moon 2', x: 0, y: 0.5 * AU + 14e6 * KM, z: 3 * AU, radius: 1e6 },
    { id: 23, groupId: G.STATION, typeName: 'Caldari Trading Station', name: 'Testa 2 - Moon 2 - Ytiri Storage', x: 0, y: 0.5 * AU + 14e6 * KM + 300 * KM, z: 3 * AU },
    { id: 31, groupId: G.GATE, typeName: 'Stargate (Caldari System)', name: 'Testa - Stargate (Jita)', x: -30 * AU + 16000 * KM, y: -2 * AU, z: 0 },
    { id: 40, groupId: G.GATE, typeName: 'Stargate (Caldari Region)', name: 'Testa - Stargate (Sobaseki)', x: 0, y: 40 * AU, z: 12 * AU },
  ];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (v) => Math.hypot(v[0], v[1], v[2]);

test('distances are square-rooted: order kept, directions and heights true, the farthest at 1', () => {
  const L = Orrery.layout(rows());
  assert.equal(L.planets.length, 3);
  assert.deepEqual(L.planets.map(p => p.numeral), ['I', 'II', 'III']);
  // Every primary points exactly where it truly is from the sun...
  for (const b of [...L.planets, ...L.gates.filter(g => !g.parent)]) {
    const cos = dot(b.p, b.m) / len(b.p) / len(b.m);
    assert.ok(cos > 1 - 1e-12, `${b.name} keeps its direction`);
  }
  // ...at the square root of its distance, so the order never changes.
  const r = L.planets.map(p => len(p.p));
  assert.ok(r[0] < r[1] && r[1] < r[2], 'order kept');
  assert.ok(Math.abs(r[1] / r[0] - Math.sqrt(len(L.planets[1].m) / len(L.planets[0].m))) < 1e-9, 'square-rooted');
  // The gate high above the plane is the farthest thing out: it sits at 1, and still high.
  const far = L.gates.find(g => g.dest === 'Sobaseki');
  assert.ok(Math.abs(len(far.p) - 1) < 1e-12);
  assert.ok(far.p[1] > 0.9, 'its height above the plane survives the squash');
  assert.equal(far.reach, 'region');
  assert.equal(Orrery.squash(4 * AU), 2);
});

test('what sits beside a planet keeps its true direction from it, and is spread by decades', () => {
  const L = Orrery.layout(rows());
  const ii = L.planets[1], iii = L.planets[2];
  assert.equal(ii.moons.length, 2);
  const [m1, m2] = ii.moons;
  assert.deepEqual(m1.dir.map(v => Math.round(v * 1e9) / 1e9), [1, 0, 0]);
  assert.deepEqual(m2.dir.map(v => Math.round(v * 1e9) / 1e9), [0, 1, 0]);
  assert.ok(m2.k > m1.k, 'the farther moon is further out');
  // A gate 16,000 km off its planet is that planet's, not a primary - and clears the disc.
  const near = L.gates.find(g => g.dest === 'Jita');
  assert.equal(near.parent, iii);
  assert.equal(near.p, undefined);
  assert.equal(near.reach, 'system');
  assert.ok(Orrery.spreadPx(near.k, 8, 1) > 8 + Orrery.SPREAD.gap, 'beside the disc, not inside it');
  // Decades: 2,000 km opens the first one.
  assert.ok(Math.abs(Orrery.decades(1.8e7) - 1) < 1e-12);
  assert.equal(Orrery.decades(0), 0);
  // Zooming in opens a planet's company out - and never past the order it is in.
  assert.ok(Orrery.spreadPx(2, 8, 10) > Orrery.spreadPx(2, 8, 1));
  assert.ok(Orrery.spreadPx(3, 8, 10) > Orrery.spreadPx(2, 8, 10));
});

test('a station belongs to the planet it is by and notes the moon it is docked at', () => {
  const L = Orrery.layout(rows());
  const st = L.stations[0];
  assert.equal(st.parent, L.planets[1]);
  assert.equal(st.moon, L.planets[1].moons[1]);
  assert.equal(st.short, 'Ytiri Storage');
  assert.equal(st.where, 'Testa 2 - Moon 2');
  assert.deepEqual(Orrery.stationParts('Jita 4 - Moon 4 - Caldari Navy Assembly Plant'),
    { at: 'Jita 4 - Moon 4', name: 'Caldari Navy Assembly Plant' });
});

test('names read off the SDE the way the map shows them', () => {
  assert.equal(Orrery.gateDestination('Jita - Stargate (New Caldari)'), 'New Caldari');
  assert.equal(Orrery.planetKind('Planet (Temperate)'), 'temperate');
  assert.equal(Orrery.gateReach('Stargate (Caldari Constellation)'), 'constellation');
  assert.deepEqual([1, 4, 8, 9, 14, 19].map(Orrery.roman), ['I', 'IV', 'VIII', 'IX', 'XIV', 'XIX']);
});

test('an orbit is the circle round the sun through its planet, tilted to the planet\'s true height', () => {
  const p = [0.3, 0.2, -0.6];
  const ring = Orrery.orbitRing(p, 64);
  assert.equal(ring.length, 64);
  assert.ok(len([ring[0][0] - p[0], ring[0][1] - p[1], ring[0][2] - p[2]]) < 1e-12, 'it starts at the planet');
  for (const q of ring) assert.ok(Math.abs(len(q) - len(p)) < 1e-12, 'every point as far from the sun as the planet');
  // One plane, through the sun: every point square to the same normal.
  const n = [ring[0][1] * ring[16][2] - ring[0][2] * ring[16][1], ring[0][2] * ring[16][0] - ring[0][0] * ring[16][2], ring[0][0] * ring[16][1] - ring[0][1] * ring[16][0]];
  for (const q of ring) assert.ok(Math.abs(dot(q, n)) < 1e-12);
  // A planet at its true height: the ring is tilted, not lying flat.
  assert.ok(ring.some(q => Math.abs(q[1]) > 0.15));
  assert.deepEqual(Orrery.orbitRing([0, 0, 0], 8), []);
});

test('arriving dives into the star, then opens the system - inner orbits first - and leaving runs it back', () => {
  const { ENTER, LEAVE } = Orrery;
  assert.equal(Orrery.arrival(0).scene, 'galaxy');
  assert.equal(Orrery.arrival(0).bloom, 0);
  assert.equal(Orrery.arrival(ENTER.dive - 1).scene, 'galaxy');
  assert.ok(Orrery.arrival(ENTER.dive - 1).bloom > 0.99, 'the light fills the view as the scenes change');
  assert.equal(Orrery.arrival(ENTER.dive).scene, 'system');
  assert.ok(Orrery.arrival(ENTER.dive).bloom > 0.99);
  assert.equal(Orrery.arrival(ENTER.dive + ENTER.reveal).done, true);
  assert.equal(Orrery.arrival(ENTER.dive + ENTER.reveal).bloom, 0);
  assert.ok(Orrery.ringShare(0, 8, 0.3) > Orrery.ringShare(7, 8, 0.3), 'inner orbits first');
  assert.equal(Orrery.ringShare(7, 8, 1), 1, 'and every one closed by the end');
  assert.equal(Orrery.ringShare(0, 8, 0), 0);
  assert.equal(Orrery.planetShare(3, 8, 1), 1);
  assert.equal(Orrery.departure(0).scene, 'system');
  assert.ok(Orrery.departure(LEAVE.sink - 1).bloom > 0.99);
  assert.equal(Orrery.departure(LEAVE.sink).scene, 'galaxy');
  assert.equal(Orrery.departure(LEAVE.sink + LEAVE.rise).done, true);
});

test('with no planets at all, what is there stands alone and is still placed', () => {
  // Zarzakh: a sun, four gates and a station. The station used to be dropped.
  const L = Orrery.layout([
    { id: 1, groupId: G.SUN, typeName: 'Sun A0 (Captured Blue Small)', name: 'Zarzakh - Star', x: 0, y: 0, z: 0, radius: 5e8 },
    { id: 2, groupId: G.STATION, typeName: 'Fulcrum', name: 'Zarzakh - The Fulcrum', x: 0.01 * AU, y: 0, z: 0 },
    { id: 3, groupId: G.GATE, typeName: 'Stargate (Caldari System)', name: 'Zarzakh - Stargate (Turnur)', x: 3 * AU, y: 4 * AU, z: 0 },
  ]);
  assert.equal(L.planets.length, 0);
  assert.equal(L.stations.length, 1);
  const st = L.stations[0];
  assert.equal(st.parent, undefined);
  assert.equal(st.short, 'The Fulcrum');
  assert.equal(st.moon, undefined);
  assert.ok(Math.hypot(...st.p) > 0, 'placed, in its own direction');
  assert.ok(Math.abs(Math.hypot(...L.gates[0].p) - 1) < 1e-12, 'the farthest thing out still sets the reach');
});

test('a planet kind with no art of its own wears the nearest that has', () => {
  assert.equal(Orrery.planetSkin('scorched barren'), 'barren');
  assert.equal(Orrery.planetSkin('gas'), 'gas');
  assert.equal(Orrery.layout([{ id: 1, groupId: G.PLANET, typeName: 'Planet (Scorched Barren)', name: 'Turnur I', celestialIndex: 1, x: AU, y: 0, z: 0, radius: 2e6 }]).planets[0].skin, 'barren');
});

test('the scale marks round numbers that suit the system, inside its reach and clear of each other', () => {
  const marks = (reachAU) => Orrery.scaleMarks(Orrery.squash(reachAU * AU));
  assert.deepEqual(marks(42).map(m => m.au), [1, 5, 10, 20], 'Jita');
  assert.deepEqual(marks(3.68).map(m => m.au), [0.5, 1, 2], 'J210750, the smallest');
  assert.deepEqual(marks(203).map(m => m.au), [5, 20, 50, 100, 200], 'Thera, the largest');
  for (const reach of [3.68, 8, 25, 42, 90, 203]) {
    const ms = marks(reach);
    assert.ok(ms.length >= 2, `${reach} AU gets a scale`);
    ms.forEach((m, i) => {
      assert.ok(m.r <= 1.08 && m.r >= 0.12, `${m.au} AU sits inside the system and off the sun`);
      if (i) assert.ok(m.r - ms[i - 1].r >= 0.14 - 1e-9, 'and off its neighbour');
    });
  }
});

test('security as words is lifted until it reads, without losing its hue', () => {
  const lift = (h) => [1, 3, 5].map(i => parseInt(Orrery.legible(h).slice(i, i + 2), 16));
  assert.equal(Orrery.legible('#efef00'), '#efef00', 'a bright colour is left alone');
  assert.equal(Orrery.legible('#2effff'), '#2effff');
  const [gr, gg, gb] = lift('#282828');
  assert.ok(gr === gg && gg === gb && gr > 120, 'wormhole near-black becomes a readable grey');
  const [rr, rg, rb] = lift('#c00000');
  assert.ok(rr > rg + 80 && rr > rb + 80, 'null-sec red stays red');
  assert.ok(rr > 200 && rg > 60, 'and is lighter');
  assert.equal(Orrery.legible('rgba(1,2,3,1)'), 'rgba(1,2,3,1)', 'anything but plain hex passes through');
});

test('with no star to dive into, a flash stands in for the dive and a fade for the rise', () => {
  const { ENTER, LEAVE } = Orrery;
  assert.ok(ENTER.flash < ENTER.dive / 2 && LEAVE.fade < LEAVE.rise / 2);
  assert.equal(Orrery.arrival(ENTER.flash - 1, ENTER.flash).scene, 'galaxy');
  assert.ok(Orrery.arrival(ENTER.flash - 1, ENTER.flash).bloom > 0.98);
  assert.equal(Orrery.arrival(ENTER.flash, ENTER.flash).scene, 'system');
  assert.equal(Orrery.arrival(ENTER.flash + ENTER.reveal, ENTER.flash).done, true);
  assert.equal(Orrery.departure(LEAVE.sink + LEAVE.fade, LEAVE.fade).done, true);
  assert.equal(Orrery.departure(LEAVE.sink + LEAVE.fade - 1, LEAVE.fade).done, false);
});
