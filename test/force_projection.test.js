// Ansiblex fare zoning and spheres of influence.
//
// The zone bands come from the published Ansiblex capacitor mechanic:
//   0-5 LY free, 5.1-10 x2, 10.1-15 x6, 15.1-20 x9, 20.1+ x15, no capital = unknown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const FP = require('../src/func/force-projection.js');

const LY = FP.LY_METRES;
/** A system `ly` light-years along +x from the origin. */
const at = (id, ly, name) => ({ id, name: name || `S${id}`, x: ly * LY, y: 0, z: 0 });

test("light-year matches the jump planner's, exactly", () => {
  // Two copies of this number is one too many, and they drifting apart would
  // make the planner and the zoning disagree about the same distance.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'jump-planner.js'), 'utf8');
  const m = /const JP_LY = ([0-9.e+]+);/.exec(src);
  assert.ok(m, 'JP_LY not found in jump-planner.js');
  assert.equal(Number(m[1]), LY);
  assert.equal(LY, 9.46e15, "EVE's light-year, not the physical one");
});

test('zone bands and their multipliers', () => {
  const z = (ly) => FP.zoneFor(ly);
  assert.equal(z(0).zone, 1);
  assert.equal(z(0).multiplier, 0);          // free inside the home sphere
  assert.equal(z(4.9).zone, 1);
  assert.equal(z(5).zone, 1);                // upper bound inclusive
  assert.equal(z(5.0001).zone, 2);
  assert.equal(z(10).zone, 2);
  assert.equal(z(10).multiplier, 2);
  assert.equal(z(12).zone, 3);
  assert.equal(z(15).multiplier, 6);
  assert.equal(z(17).zone, 4);
  assert.equal(z(20).multiplier, 9);
  assert.equal(z(20.1).zone, 5);
  assert.equal(z(500).multiplier, 15);       // no upper bound on the last band
});

test('the 0.1 LY in the published bands is rounding, not a gap', () => {
  // Quoted as "0-5" then "5.1-10". Treating that literally would leave
  // 5.0-5.1 belonging to no zone at all.
  for (const ly of [5.02, 5.05, 5.09, 10.05, 15.05, 20.05]) {
    assert.notEqual(FP.zoneFor(ly).zone, null, `${ly} LY fell into no zone`);
  }
});

test('no capital is "unknown", and never silently the most expensive zone', () => {
  const u = FP.zoneFor(null);
  assert.equal(u.zone, null);
  assert.equal(u.multiplier, null);
  assert.equal(u.token, '--pal-purple');            // violet, per the spec
  assert.notEqual(u.multiplier, 15, 'unknown must not collapse into zone 5');
  assert.equal(FP.zoneFor(undefined).zone, null);
  assert.equal(FP.zoneFor(NaN).zone, null);
  assert.equal(FP.zoneFor(-1).zone, null);
});

test('distance is symmetric and in light-years', () => {
  const a = at(1, 0), b = at(2, 7.5);
  assert.ok(Math.abs(FP.distanceLy(a, b) - 7.5) < 1e-9);
  assert.ok(Math.abs(FP.distanceLy(b, a) - 7.5) < 1e-9);
  assert.equal(FP.distanceLy(a, null), null);
  // Diagonal, so the z axis is genuinely used and not dropped like a flat map.
  const c = { id: 3, x: 3 * LY, y: 4 * LY, z: 0 };
  assert.ok(Math.abs(FP.distanceLy(at(1, 0), c) - 5) < 1e-9);
  const d = { id: 4, x: 0, y: 0, z: 12 * LY };
  assert.ok(Math.abs(FP.distanceLy(at(1, 0), d) - 12) < 1e-9);
});

test('the sphere radii are the band edges, without the infinite one', () => {
  assert.deepEqual(FP.zoneRadiiLy(), [5, 10, 15, 20]);
});

test('reach zones are distance from the CHOSEN capital, whoever holds the system', () => {
  const cap = at(100, 0, 'Home');
  const systems = [at(1, 2), at(2, 8), at(3, 12), at(4, 18), at(5, 25)];
  const z = FP.reachZones(systems, [cap]);
  assert.equal(z.get(1).zone, 1);
  assert.equal(z.get(2).zone, 2);
  assert.equal(z.get(3).zone, 3);
  assert.equal(z.get(4).zone, 4);
  assert.equal(z.get(1).capitalId, 100);
});

test('systems beyond the last finite band are left out, not painted zone 5', () => {
  // Zone 5 is "everything else" - most of the galaxy. Marking all of it would
  // bury the systems the question is actually about.
  const z = FP.reachZones([at(1, 20), at(2, 20.01), at(3, 200)], [at(100, 0)]);
  assert.equal(z.get(1).zone, 4);                  // 20.0 is still zone 4
  assert.equal(z.has(2), false);
  assert.equal(z.has(3), false);
});

test('with several capitals a system takes the nearest one', () => {
  const a = at(100, 0, 'A'), b = at(200, 30, 'B');
  const z = FP.reachZones([at(1, 27)], [a, b]);     // 27 from A, 3 from B
  assert.equal(z.get(1).zone, 1);
  assert.equal(z.get(1).capitalId, 200);
});

test('no capitals means no reach, and junk capitals are ignored', () => {
  assert.equal(FP.reachZones([at(1, 1)], []).size, 0);
  assert.equal(FP.reachZones([at(1, 1)], [null, { id: 9, x: NaN, y: 0, z: 0 }]).size, 0);
});

test('reach uses all three axes, unlike a flat map', () => {
  const cap = at(100, 0);
  const above = { id: 7, x: 0, y: 12 * LY, z: 0 };   // 12 LY straight up
  assert.equal(FP.reachZones([above], [cap]).get(7).zone, 3);
});

test('zone tokens are names, never colour literals', () => {
  // Themes re-point --pal-*, and canvas drops var() silently, so a literal here
  // would both break theming and be the kind of value that renders as black.
  for (const z of FP.ZONES.concat([FP.UNKNOWN])) {
    assert.match(z.token, /^--pal-[a-z]+$/, `${z.label} carries a literal colour`);
  }
});

// ── Capitals from ESI ────────────────────────────────────────────────────────

test('capitals are read from the sov map, one system per alliance', () => {
  const sov = {
    30000239: { allianceId: 99003581, isCapital: true },
    30000208: { allianceId: 99003581, isCapital: false },
    30001574: { allianceId: 99013739, isCapital: false },   // holds sov, no capital
    30000001: { allianceId: null, factionId: 500007, isCapital: false },
  };
  assert.deepEqual(FP.capitalsFromSov(sov), { 99003581: 30000239 });
});

test('an alliance holding sov with no capital set gets no entry, not a guess', () => {
  const caps = FP.capitalsFromSov({ 1: { allianceId: 7, isCapital: false } });
  assert.deepEqual(caps, {});
  assert.equal(caps[7], undefined);
});

test('capitalsFromSov also accepts the raw ESI field names', () => {
  const caps = FP.capitalsFromSov({ 42: { alliance_id: 5, is_capital_system: true } });
  assert.deepEqual(caps, { 5: 42 });
});

test('the sov normaliser keeps is_capital_system from a REAL ESI response', async () => {
  // This field was in /sovereignty/systems all along and the normaliser threw
  // it away with everything else it did not copy. The fixture is a handful of
  // entries captured from the live endpoint, so it pins ESI's actual nested
  // shape (claim.alliance.is_capital_system) rather than one written from memory.
  const { _fetchSovSystems } = require('../src/ipc/map_ipc.js');
  const fixture = require('./fixtures/esi-sovereignty-systems.json');
  const sov = await _fetchSovSystems({ httpGet: async () => fixture, writeCache: () => {} });

  assert.equal(sov[30000239].isCapital, true, 'the capital system lost its flag');
  assert.equal(sov[30000239].allianceId, 99003581);
  assert.equal(sov[30000208].isCapital, false);
  assert.equal(sov[30000001].isCapital, false, 'a faction claim is never a capital');
  assert.equal(sov[30000326].isCapital, false, 'an unclaimed system is never a capital');

  const caps = FP.capitalsFromSov(sov);
  assert.deepEqual(caps, { 99003581: 30000239 });
  assert.equal(caps[99013739], undefined, 'a capital-less alliance must not be given one');
});

// ── Ansiblex fares ───────────────────────────────────────────────────────────
// Sources: CCP "Force Projection: Ansiblex Capacitor Update" (per-hull table)
// and Patch Notes 24.01 (what shipped).

test("CCP's own worked examples", () => {
  assert.equal(FP.fareTJ('t3c', 3), 78);         // Tengu into zone 3: 13 x 6
  assert.equal(FP.fareTJ('blops', 4), 162);      // Redeemer into zone 4: 18 x 9
  assert.equal(FP.fareTJ('hauler', 1), 0);       // Epithal into zone 1: 1 x 0, free
});

test('fares match cells of the published table', () => {
  assert.equal(FP.fareTJ('battleship', 5), 247.5);
  assert.equal(FP.fareTJ('dictor', 4), 76.5);
  assert.equal(FP.fareTJ('hic', 5), 157.5);
  assert.equal(FP.fareTJ('cmdship', 2), 33);
  assert.equal(FP.fareTJ('marauder', 5), 285);
  assert.equal(FP.fareTJ('frigate', 3), 24);
});

test('a full capacitor moves exactly what an independent planner reports', () => {
  // eo-map's force-projection panel, Hauler: 625 / 208 / 138 / 83 ships per
  // full 1250 TJ in zones 2-5. An independent implementation agreeing to the
  // ship is a far stronger check than restating the formula.
  const per = [2, 3, 4, 5].map(z => FP.shipsThrough(FP.fareTJ('hauler', z), FP.ANSIBLEX.capacityTJ));
  assert.deepEqual(per, [625, 208, 138, 83]);
  assert.equal(FP.shipsThrough(FP.fareTJ('hauler', 1), 1250), Infinity);   // free
});

test('capitals are barred; Rorquals, freighters and jump freighters are not', () => {
  for (const id of ['carrier', 'dread', 'fax', 'super', 'titan']) {
    assert.equal(FP.fareTJ(id, 3), null, `${id} should be barred`);
    assert.equal(FP.shipClass(id).allowed, false);
  }
  for (const id of ['rorqual', 'freighter', 'jf']) {
    assert.notEqual(FP.fareTJ(id, 3), null, `${id} should be allowed`);
  }
  assert.equal(FP.shipsThrough(FP.fareTJ('titan', 2), 1250), 0);
});

test('the Rorqual follows the formula, not two cells that look like typos', () => {
  // The table prints 57 and 104.5 for zones 2 and 3, where every other row is
  // base x multiplier (38 and 114). Its zones 4 and 5 do follow the formula.
  assert.equal(FP.fareTJ('rorqual', 2), 38);
  assert.equal(FP.fareTJ('rorqual', 3), 114);
  assert.equal(FP.fareTJ('rorqual', 4), 171);
  assert.equal(FP.fareTJ('rorqual', 5), 285);
});

test('the fare is priced from the DESTINATION, so heading home is cheaper', () => {
  const cap = at(100, 0, 'Capital');
  const near = at(1, 3), far = at(2, 17);
  const out  = FP.jumpFare(near, far, 'battleship', cap);    // into zone 4
  const home = FP.jumpFare(far, near, 'battleship', cap);    // into zone 1
  assert.equal(out.zone, 4);
  assert.equal(out.fare, 148.5);
  assert.equal(home.zone, 1);
  assert.equal(home.fare, 0);
});

test('an owner with no capital pays zone 5 on every jump', () => {
  const f = FP.jumpFare(at(1, 0), at(2, 1), 'cruiser', null);
  assert.equal(f.zone, 5);
  assert.equal(f.fare, 150);
  assert.equal(f.noCapital, true);
});

test('recharge averages 200 TJ an hour and stops at capacity', () => {
  assert.equal(FP.rechargedTJ(0), 0);
  assert.equal(FP.rechargedTJ(1), 200);
  assert.equal(FP.rechargedTJ(6.25), 1250);       // empty to full
  assert.equal(FP.rechargedTJ(48), 1250);
  assert.equal(FP.rechargedTJ(-1), 0);
});

test('every hull class has a unique id and a sane base', () => {
  const ids = FP.SHIP_CLASSES.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of FP.SHIP_CLASSES) {
    if (c.allowed) assert.ok(c.base >= 1 && c.base <= 19, `${c.id} base ${c.base}`);
    else assert.equal(c.base, null);
  }
});
