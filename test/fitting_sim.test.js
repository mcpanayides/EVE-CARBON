'use strict';
// Guards the fitting simulator's math. Each case here maps to a number that was
// measurably wrong against a reference fit (Paladin + Bastion, all skills V) on
// 2026-08-20, where we reported 972 dps against a real 2140.
//
// Fixtures are FROZEN, not read from data/sde.sql: that file is ~115 MB and is
// not in git, so a test that queried it would pass locally and fail in CI. Every
// value below was verified against the SDE when this test was written; the
// attribute ids are named in the comments so a re-check is a one-line query.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

// fitting.js is a plain renderer script — no exports, and its top-level `const`
// bindings live in the script's own lexical scope rather than on the context
// global. Appending an exporter is the only way to reach _fitState from outside.
function loadSim() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'fitting.js'), 'utf8');
  const noop = () => {};
  const doc = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop, addEventListener: noop }),
    addEventListener: noop, body: {}, documentElement: { style: {} }, head: {},
  };
  const sb = {
    document: doc, window: { addEventListener: noop, eveAPI: {} }, console,
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: noop,
    navigator: { clipboard: {} }, Image: function () {},
    localStorage: { getItem: () => null, setItem: noop },
    Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseFloat, parseInt, fetch: () => Promise.reject(new Error('no net')),
  };
  sb.globalThis = sb; sb.window.document = doc;
  vm.runInContext(src + '\n;globalThis.__x = { _fitState };\n', vm.createContext(sb), { filename: 'fitting.js' });
  sb._fitState = sb.__x._fitState;
  return sb;
}

// ── Frozen fixtures ──────────────────────────────────────────────────────────
// Paladin (28659): armorHp 265, resonances 267/268/269/270, lockRange 76,
// scanRes 564, sensorStrength 208 (Radar), sig 552, maxVel 37, agility 70.
const HULL = () => ({
  id: 28659, name: 'Paladin', groupName: 'Marauder',
  slots: { high: 8, med: 4, low: 7, rig: 2, subsystem: 0 },
  hardpoints: { turret: 4, launcher: 0 },
  output: { cpu: 800, pg: 20000, calibration: 400 },
  cargo: 1125, drone: { bay: 400, bandwidth: 100 },
  fighter: { bay: 0, tubes: 0, light: 0, support: 0, heavy: 0 },
  base: {
    shieldHp: 6900, armorHp: 8800, structureHp: 8500, capacitor: 6250,
    rechargeMs: 1_562_500, shieldRechargeMs: 2_500_000,
    shieldRes: { em: 1, th: 0.8, kin: 0.6, exp: 0.5 },
    armorRes:  { em: 0.5, th: 0.65, kin: 0.65625, exp: 0.6 },
    hullRes:   { em: 0.67, th: 0.67, kin: 0.67, exp: 0.67 },
  },
  targeting: { lockRange: 118300, scanRes: 160, maxTargets: 10, sensorType: 'Radar', sensorStrength: 21 },
  nav: { maxVel: 100, mass: 97_100_000, agility: 0.0686, warpMult: 1, sig: 420 },
  traits: [],
});

const facts = (o) => Object.assign({
  id: 1, name: 'x', groupName: '', groupId: 0, categoryId: 7, attrs: {}, effects: [],
  traits: null, skillBonuses: [], volume: 0, slot: 'high', hardpoint: null,
  cpu: 0, pg: 0, dmgMult: 0, rof: 0, dmg: { em: 0, th: 0, kin: 0, exp: 0 },
  activatable: false, overloadable: false, optimal: 0, falloff: 0, tracking: 0,
  chargeGroup: null, chargeSize: null, chargeGroups: [], calCost: 0,
  missileVel: 0, flightMs: 0, rangeMult: null, falloffMult: null,
  bonus: {}, dmgMultMod: 0, rofMult: 0, mslDmgMult: 0, heat: {},
}, o);

// Mega Pulse Laser II (rof 51 = 7875 ms, dmgMult 64 = 3.6). Required skills:
// Large Energy Turret 3309 (attr 292 = 5%/lvl) and Large Pulse Laser
// Specialization 12215 (attr 292 = 2%/lvl) — the second was being dropped.
const LASER = () => facts({
  id: 3057, name: 'Mega Pulse Laser II', groupName: 'Energy Weapon', groupId: 53,
  hardpoint: 'turret', activatable: true, rof: 7875, dmgMult: 3.6,
  optimal: 24000, falloff: 12000, tracking: 0.0285,
  skillBonuses: [{ id: 3309, dmg: 5, rof: 0 }, { id: 12215, dmg: 2, rof: 0 }],
  attrs: { 51: 7875, 64: 3.6, 6: 36, 182: 3309, 184: 12215 },   // 6 = capacitorNeed
});
// Conflagration L: em 114 = 35.4, th 118 = 35.4.
const AMMO = () => facts({ id: 12787, name: 'Conflagration L', groupName: 'Advanced Pulse Laser Crystal',
  categoryId: 8, slot: null, dmg: { em: 35.4, th: 35.4, kin: 0, exp: 0 } });

// Bastion Module I (33400), group 515. Verified attribute values:
//   3109 turret RoF −50 · 3108 missile RoF −50 · 351 optimal +25 · 349 falloff
//   +25 · 547 missile velocity +25 · 895 armor rep +60 · 548 shield boost +60 ·
//   5964/6187 rep duration −20 · 20 max velocity −100 · 1030 Radar strength +100
//   · 267-274 + 974-977 resonances 0.7 (PreMul, dgmEffects 6658 operation 0).
const BASTION = () => facts({
  id: 33400, name: 'Bastion Module I', groupName: 'Siege Module', groupId: 515,
  activatable: true,
  attrs: {
    3109: -50, 3108: -50, 351: 25, 349: 25, 547: 25, 895: 60, 548: 60,
    5964: -20, 6187: -20, 20: -100, 1030: 100,
    267: 0.7, 268: 0.7, 269: 0.7, 270: 0.7, 271: 0.7, 272: 0.7, 273: 0.7, 274: 0.7,
    974: 0.7, 975: 0.7, 976: 0.7, 977: 0.7,
  },
});
// Siege Module II (4292), group 515: 2307 turret damage +840, 2305 XL RoF −80.
const SIEGE = () => facts({
  id: 4292, name: 'Siege Module II', groupName: 'Siege Module', groupId: 515,
  activatable: true, attrs: { 2307: 840, 2305: -80, 2306: 200, 20: -100, 2347: 100, 2346: -50 },
});
// Large Trimark Armor Pump II (26302): attr 335 armor HP +20% (postPercent).
const TRIMARK = () => facts({ id: 26302, name: 'Large Trimark Armor Pump II',
  groupName: 'Rig Armor', groupId: 773, slot: 'rig', attrs: { 335: 20, 1153: 75 } });
// 500MN Microwarpdrive: 20 speedFactor, 567 speedBoostFactor, 554 signatureRadiusBonus.
const MWD = () => facts({ id: 12076, name: '500MN Microwarpdrive II', groupName: 'Propulsion Module',
  groupId: 46, slot: 'med', activatable: true, attrs: { 20: 500, 567: 800000, 554: 500 } });

function rig(sb, { bastion = false, siege = false, trimarks = 0, mwd = false, spec = true } = {}) {
  const S = sb._fitState;
  S.hull = HULL();
  S.skills.mode = 'all5';
  S.links = 'off';
  S.implants = new Array(10).fill(null);
  S.drones = []; S.fighters = [];
  S.modules = { high: [], med: [], low: [], rig: [], subsystem: [] };

  const gun = LASER();
  if (!spec) gun.skillBonuses = gun.skillBonuses.filter(s => s.id !== 12215);
  const m = sb._fitMod(gun);
  const a = AMMO();
  m.charge = { id: a.id, name: a.name, dmg: a.dmg, f: a };
  S.modules.high.push(m);
  if (bastion) S.modules.high.push(sb._fitMod(BASTION()));
  if (siege)   S.modules.high.push(sb._fitMod(SIEGE()));
  if (mwd)     S.modules.med.push(sb._fitMod(MWD()));
  for (let i = 0; i < trimarks; i++) S.modules.rig.push(sb._fitMod(TRIMARK()));
  return S;
}
const dps = (sb) => sb._fitWeaponSim().reduce((s, g) => s + g.dps, 0);

// _fitTraitRecords memoises on hull OBJECT IDENTITY, so swapping traits means
// swapping the hull. (The app does this naturally — _fitLoadHull assigns a new
// object — but a test that mutated hull.traits in place would read stale
// records and quietly pass.)
const setTraits = (sb, rows) => { sb._fitState.hull = { ...sb._fitState.hull, traits: rows }; };

// ── Mode modules: Bastion / Siege / Triage / Industrial Core (group 515) ──────

test('Bastion halves the turret cycle — exactly double the DPS', () => {
  // The measured fault: a bastioned Paladin reported 972 dps against a real
  // 2140. Group 515 was not modelled at all, so the −50% RoF simply vanished.
  const sb = loadSim();
  rig(sb, { bastion: false });
  const plain = dps(sb);
  rig(sb, { bastion: true });
  const bastioned = dps(sb);
  assert.ok(plain > 0, 'the baseline fit must actually shoot');
  assert.ok(Math.abs(bastioned / plain - 2) < 0.001,
    `bastion should double turret dps, got ${(bastioned / plain).toFixed(4)}x`);
});

test('a mode module only counts while it is running', () => {
  // Bastion is a cycle you enter, not a passive. An offline/online module must
  // not rewrite the ship — otherwise merely fitting one doubles the numbers.
  const sb = loadSim();
  rig(sb, { bastion: true });
  const on = dps(sb);
  sb._fitState.modules.high[1].state = 'online';
  const off = dps(sb);
  assert.ok(Math.abs(off / on - 0.5) < 0.001, 'an inactive bastion must contribute nothing');
});

test('Siege multiplies turret damage rather than rate of fire', () => {
  // Dreadnoughts were the worst case of the same gap: Siege carries +840%
  // damage (attr 2307), so a sieged dread was reporting about a ninth of its
  // real output.
  const sb = loadSim();
  rig(sb, { siege: false });
  const plain = dps(sb);
  rig(sb, { siege: true });
  assert.ok(Math.abs(dps(sb) / plain - 9.4) < 0.01, 'siege should give 9.4x turret damage');
});

test('mode resistances multiply the hull\'s own — they never replace them', () => {
  // dgmEffects operation 0 is PreMul, not PreAssignment. Read as an assignment,
  // bastion SET every resonance to 0.7 — which made a Paladin's 50% EM resist
  // WORSE than the bare hull's, and dropped total EHP below the unbastioned fit.
  const sb = loadSim();
  rig(sb, { bastion: false });
  const bare = sb._fitShipDerived();
  rig(sb, { bastion: true });
  const bast = sb._fitShipDerived();
  for (const d of ['em', 'th', 'kin', 'exp']) {
    assert.ok(bast.armorRes[d] < bare.armorRes[d],
      `bastion must improve armor ${d} resist, not worsen it`);
  }
  assert.ok(Math.abs(bast.armorRes.em / bare.armorRes.em - 0.7) < 1e-9,
    'the bonus is a plain ×0.7 on the hull value, with no stacking penalty');
  assert.ok(bast.ehp > bare.ehp, 'a bastioned hull must be tougher, not weaker');
});

test('a mode module pins the ship still and takes the prop mod with it', () => {
  // Bastion is attr 20 = −100% velocity. With the hull unable to move, a running
  // MWD contributes neither thrust nor its ×6 signature bloom — which is why a
  // bastioned hull sits at its bare signature.
  const sb = loadSim();
  rig(sb, { bastion: true, mwd: true });
  const D = sb._fitShipDerived();
  assert.strictEqual(D.maxVel, 0, 'bastion must pin velocity to zero');
  assert.ok(Math.abs(D.sig - 420) < 0.001, `sig should stay at the bare 420, got ${D.sig}`);
});

test('no mode module fitted changes nothing', () => {
  const sb = loadSim();
  rig(sb, { bastion: false, mwd: true });
  const D = sb._fitShipDerived();
  assert.ok(D.maxVel > 0, 'a ship with no mode module still moves');
  assert.ok(D.sig > 420, 'and a running MWD still blooms its signature');
});

// ── Skills ───────────────────────────────────────────────────────────────────

test('T2 specialization skills contribute their own damage bonus', () => {
  // The engine applied a hardcoded 5%/level to the FIRST required skill and
  // stopped, silently dropping every specialization in the game — 10% of the
  // damage of any T2 turret at level V.
  const sb = loadSim();
  rig(sb, { spec: false });
  const without = dps(sb);
  rig(sb, { spec: true });
  const withSpec = dps(sb);
  assert.ok(Math.abs(withSpec / without - 1.10) < 0.001,
    `Large Pulse Laser Specialization V is +10%, got ${(withSpec / without).toFixed(4)}x`);
});

test('the baseline operation skills are never counted twice', () => {
  // Gunnery / Rapid Firing / Missile Launcher Operation / Rapid Launch are
  // applied explicitly, so a weapon that also REQUIRES them must not pick their
  // bonus up a second time through the required-skill table.
  const sb = loadSim();
  rig(sb, {});
  const before = dps(sb);
  const gun = sb._fitState.modules.high[0];
  gun.f.skillBonuses = gun.f.skillBonuses.concat([{ id: 3300, dmg: 5, rof: 0 }, { id: 3310, dmg: 0, rof: -4 }]);
  assert.strictEqual(dps(sb), before, 'baseline skills must be skipped in the required-skill pass');
});

// ── Hull traits (invTraits) ──────────────────────────────────────────────────
// 42.7% of every percent-per-level ship trait row in the game was being parsed
// to null and silently discarded. bonusText below is copied verbatim from the
// SDE, links and all — the parser reads that prose, so paraphrasing it here
// would test something the game never says.

// 1600mm Steel Plates II: attr 1159 armor HP add.
const PLATE = () => facts({ id: 20353, name: '1600mm Steel Plates II', groupName: 'Armor Reinforcer',
  groupId: 329, slot: 'low', attrs: { 1159: 4800, 796: 4_500_000 } });

test('capital HP traits that name the module in prose still apply', () => {
  // Erebus/Leviathan/Avatar say "bonus to Armor Plates and Shield Extenders"
  // with no showinfo links and without the word "hitpoints", so the parser's
  // link-scoped HP branch never matched and a 500% bonus was thrown away.
  const sb = loadSim();
  rig(sb, {});
  sb._fitState.modules.low.push(sb._fitMod(PLATE()));
  const plain = sb._fitShipDerived().armorHp;

  rig(sb, {});
  setTraits(sb, [{ skillID: -1, bonus: 500, unitID: 105,
    bonusText: 'bonus to Armor Plates and Shield Extenders' }]);
  sb._fitState.modules.low.push(sb._fitMod(PLATE()));
  const boosted = sb._fitShipDerived().armorHp;

  // The plate's own 4800 becomes 6×; the hull's base armor is untouched.
  assert.ok(Math.abs((boosted - plain) - 4800 * 5 * 1.25) < 1,
    `a 500% plate bonus should add 5x the plate on top, got ${Math.round(boosted - plain)}`);
});

test('a plate mass or CPU trait is never mistaken for an HP trait', () => {
  // "reduction in Armor Plate mass penalty" and "reduction in Reinforced
  // Bulkhead CPU requirements" sit next to the HP rows and match the same
  // nouns — they must not inflate EHP.
  const sb = loadSim();
  for (const text of ['reduction in Armor Plate mass penalty',
    'reduction in Reinforced Bulkhead CPU requirements']) {
    const rec = sb._fitParseTrait({ skillID: -1, bonus: 15, unitID: 105, bonusText: text });
    assert.ok(!rec || rec.q !== 'modhp', `"${text}" must not parse as a hitpoint bonus`);
  }
});

test('hull traits reach the capacitor simulation', () => {
  // 93 hulls carry a cap-use trait and not one of them reached _fitCapSim. A
  // Paladin's guns should cost half as much cap at Amarr Battleship V.
  const sb = loadSim();
  rig(sb, {});
  setTraits(sb, [{ skillID: 3339, bonus: 10, unitID: 105,
    bonusText: 'reduction in <a href=showinfo:3309>Large Energy Turret</a> activation cost' }]);
  const withTrait = sb._fitCapSim(sb._fitShipDerived()).drain;
  setTraits(sb, []);
  const without = sb._fitCapSim(sb._fitShipDerived()).drain;
  assert.ok(without > 0, 'the gun must draw cap at all');
  assert.ok(Math.abs(withTrait / without - 0.5) < 1e-9,
    `10%/level at V is half the cap, got ${(withTrait / without).toFixed(4)}`);
});

test('a cap trait only applies to the weapons it names', () => {
  // The trait links Large Energy Turret; a hull bonus for a weapon you are not
  // flying must not discount the one you are.
  const sb = loadSim();
  rig(sb, {});
  setTraits(sb, [{ skillID: 3339, bonus: 10, unitID: 105,
    bonusText: 'reduction in <a href=showinfo:3304>Small Energy Turret</a> activation cost' }]);
  const other = sb._fitCapSim(sb._fitShipDerived()).drain;
  setTraits(sb, []);
  assert.strictEqual(other, sb._fitCapSim(sb._fitShipDerived()).drain,
    'a trait scoped to another turret size must not touch this gun');
});

test('an inertia trait makes the ship align faster, not slower', () => {
  // "bonus to ship inertia modifier" READS as a bonus but LOWERS the value.
  // Run through the ordinary trait multiplier it would have made haulers slower.
  const sb = loadSim();
  rig(sb, {});
  const before = sb._fitShipDerived().align;
  setTraits(sb, [{ skillID: 3342, bonus: 5, unitID: 105,
    bonusText: 'bonus to ship inertia modifier' }]);
  const after = sb._fitShipDerived().align;
  assert.ok(after < before, 'align time must go DOWN');
  assert.ok(Math.abs(after / before - 0.75) < 1e-9,
    `5%/level at V is 25% faster, got ${(after / before).toFixed(4)}`);
});

test('a signature trait shrinks the ship', () => {
  const sb = loadSim();
  rig(sb, {});
  const before = sb._fitShipDerived().sig;
  setTraits(sb, [{ skillID: 3342, bonus: 3, unitID: 105,
    bonusText: 'reduction in ship signature radius' }]);
  assert.ok(Math.abs(sb._fitShipDerived().sig / before - 0.85) < 1e-9,
    '3%/level at V is a 15% smaller signature');
});

test('hulls with two racial skills get both bonuses', () => {
  // The Revenant carries Amarr Carrier AND Caldari Carrier fighter-damage
  // bonuses; a Nightmare carries Amarr and Caldari Battleship. Both must count.
  const sb = loadSim();
  rig(sb, {});
  setTraits(sb, [
    { skillID: 24311, bonus: 5, unitID: 105, bonusText: 'bonus to <a href=showinfo:3309>Large Energy Turret</a> damage' },
    { skillID: 24312, bonus: 5, unitID: 105, bonusText: 'bonus to <a href=showinfo:3309>Large Energy Turret</a> damage' },
  ]);
  const both = dps(sb);
  setTraits(sb, sb._fitState.hull.traits.slice(0, 1));
  const one = dps(sb);
  assert.ok(Math.abs(both / one - 1.25) < 1e-9,
    `the second racial bonus must also count, got ${(both / one).toFixed(4)}x`);
});

// ── Cargo hold ───────────────────────────────────────────────────────────────

// Expanded Cargohold II: 149 cargo multiplier 1.275, 306 velocity 0.82.
const EXPANDER = () => facts({ id: 1319, name: 'Expanded Cargohold II', groupName: 'Cargo Hold Expander',
  groupId: 60, slot: 'low', attrs: { 149: 1.275, 306: 0.82 } });
// Damage Control II carried as a spare (5 m³), and a Mobile Depot (50 m³).
const SPARE = () => facts({ id: 2048, name: 'Damage Control II', groupName: 'Damage Control',
  groupId: 60, slot: 'low', volume: 5, attrs: {} });
const DEPOT = () => facts({ id: 33474, name: 'Mobile Depot', groupName: 'Mobile Depot',
  groupId: 1250, categoryId: 22, slot: null, volume: 50, attrs: {} });

test('hauler cargo traits expand the hold', () => {
  // 26 hulls carry one and none of them reached the panel, which read the raw
  // hull capacity straight from the SDE.
  const sb = loadSim();
  rig(sb, {});
  const base = sb._fitShipDerived().cargo;
  setTraits(sb, [{ skillID: 3342, bonus: 5, unitID: 105, bonusText: 'bonus to ship cargo capacity' }]);
  assert.ok(Math.abs(sb._fitShipDerived().cargo / base - 1.25) < 1e-9,
    '5%/level at V is a quarter more hold');
});

test('a cargo SCANNER trait is not mistaken for hold space', () => {
  const sb = loadSim();
  const rec = sb._fitParseTrait({ skillID: -1, bonus: 200, unitID: 105,
    bonusText: 'bonus to <a href=showinfo:3412>Cargo Scanners</a> range' });
  assert.ok(!rec || rec.q !== 'cargo', 'scanner range is not capacity');
});

test('a cargo expander buys space with speed', () => {
  const sb = loadSim();
  rig(sb, {});
  const before = sb._fitShipDerived();
  sb._fitState.modules.low.push(sb._fitMod(EXPANDER()));
  const after = sb._fitShipDerived();
  assert.ok(Math.abs(after.cargo / before.cargo - 1.275) < 1e-9, 'attr 149 raises capacity');
  assert.ok(Math.abs(after.maxVel / before.maxVel - 0.82) < 1e-9,
    'attr 306 is the velocity cost — a hold that looked free would be a lie');
});

test('loading the hold stacks by type and counts volume', () => {
  const sb = loadSim();
  rig(sb, {});
  sb._fitAddCargo(SPARE(), 1);
  sb._fitAddCargo(SPARE(), 2);          // same type merges onto the stack
  sb._fitAddCargo(DEPOT(), 1);
  assert.strictEqual(sb._fitState.cargo.length, 2, 'repeat loads must not add duplicate rows');
  assert.strictEqual(sb._fitState.cargo[0].qty, 3);
  assert.strictEqual(sb._fitCargoUsedM3(), 3 * 5 + 50);
});

test('each extra cargo expander does less than the last', () => {
  // EVE's stacking penalty: the i-th strongest module of a kind is scaled by
  // e^-(i/2.67)^2 → 100%, 86.9%, 57.1%, 28.3%, 10.6%. Five expanders are worth
  // about two, not five.
  const sb = loadSim();
  const capWith = (n) => {
    rig(sb, {});
    for (let i = 0; i < n; i++) sb._fitState.modules.low.push(sb._fitMod(EXPANDER()));
    return sb._fitShipDerived().cargo;
  };
  const base = capWith(0);
  let prev = base;
  for (let n = 1; n <= 5; n++) {
    const cur = capWith(n);
    const marginal = cur / prev - 1;
    const expected = 0.275 * Math.exp(-(((n - 1) / 2.67) ** 2));
    assert.ok(Math.abs(marginal - expected) < 1e-9,
      `expander #${n} should add ${(expected * 100).toFixed(2)}%, added ${(marginal * 100).toFixed(2)}%`);
    prev = cur;
  }
  assert.ok(capWith(5) / base < 2.1, 'five expanders are worth about two, not five');
});

test('weapons and flat HP adds are linear, never penalized', () => {
  // Only MODIFIERS taper. A fourth gun is worth exactly as much as the first,
  // and a second plate adds its full hitpoints — penalizing either would
  // under-report every multi-gun fit in the game.
  const sb = loadSim();
  const dpsWith = (n) => {
    rig(sb, {});
    const a = AMMO();
    for (let i = 1; i < n; i++) {
      const m = sb._fitMod(LASER());
      m.charge = { id: a.id, name: a.name, dmg: a.dmg, f: a };
      sb._fitState.modules.high.push(m);
    }
    return dps(sb);
  };
  const one = dpsWith(1);
  for (const n of [2, 3, 4]) {
    assert.ok(Math.abs(dpsWith(n) / one - n) < 1e-9, `${n} guns should be exactly ${n}x one gun`);
  }

  rig(sb, {});
  const bare = sb._fitShipDerived().armorHp;
  sb._fitState.modules.low.push(sb._fitMod(PLATE()));
  const p1 = sb._fitShipDerived().armorHp;
  sb._fitState.modules.low.push(sb._fitMod(PLATE()));
  const p2 = sb._fitShipDerived().armorHp;
  assert.ok(Math.abs((p2 - p1) - (p1 - bare)) < 1e-6,
    'a second plate adds the same hitpoints as the first');
});

test('skills and hull bonuses are never stacking-penalized', () => {
  // Only MODULES taper. Ship bonuses, skills and mode modules are plain
  // multipliers — penalizing them would quietly under-report every hull that
  // carries two bonuses for the same weapon.
  const sb = loadSim();
  rig(sb, {});
  const one = { skillID: 24311, bonus: 5, unitID: 105,
    bonusText: 'bonus to <a href=showinfo:3309>Large Energy Turret</a> damage' };
  setTraits(sb, [one]);
  const t1 = dps(sb);
  setTraits(sb, [one, { ...one, skillID: 24312 }]);
  assert.ok(Math.abs(dps(sb) / t1 - 1.25) < 1e-9,
    'a second identical hull bonus must give its full 25%, not a penalized share');
});

test('cargo is weight, never tank or damage', () => {
  // A spare hardener in the hold must not read as fitted. This is the whole
  // reason the hold is kept out of the simulation.
  const sb = loadSim();
  rig(sb, {});
  const dpsBefore = dps(sb);
  const D = sb._fitShipDerived();
  sb._fitAddCargo(SPARE(), 10);
  sb._fitAddCargo(EXPANDER(), 5);       // carried, NOT fitted
  const after = sb._fitShipDerived();
  assert.strictEqual(dps(sb), dpsBefore, 'carried modules add no damage');
  assert.strictEqual(after.ehp, D.ehp, 'carried modules add no tank');
  assert.strictEqual(after.cargo, D.cargo, 'a carried expander does not expand the hold');
});

test('the hold accepts an over-capacity load rather than silently refusing', () => {
  // You may be planning a fit you have not trimmed yet; the panel warns instead.
  const sb = loadSim();
  rig(sb, {});
  const cap = sb._fitEffCargo();
  sb._fitAddCargo(DEPOT(), Math.ceil(cap / 50) + 5);
  assert.ok(sb._fitCargoUsedM3() > cap, 'the load goes in');
  assert.ok(sb._fitCargoHtml().includes('over'), 'and the panel says so');
});

test('cargo survives an EFT round-trip', () => {
  const sb = loadSim();
  rig(sb, {});
  sb._fitAddCargo(SPARE(), 3);
  const eft = sb._fitToEFT();
  assert.ok(eft.includes('Damage Control II x3'), `cargo should be written out, got:\n${eft}`);
});

// ── Saved fits ───────────────────────────────────────────────────────────────

// Gives the sandbox a real localStorage and a scriptable showConfirm, and
// returns the dialogs it was asked to show.
function withSavedFits(sb, fits, answer) {
  const store = { fitLocalFits: JSON.stringify(fits) };
  sb.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const asked = [];
  sb.showConfirm = (opts) => { asked.push(opts); return Promise.resolve(answer); };
  return { store, asked };
}

test('deleting a saved fit asks first, and asks with our own dialog', async () => {
  // The delete path used window.confirm, which this app treats as a defect —
  // it ignores the theme and blocks the renderer.
  const sb = loadSim();
  const { store, asked } = withSavedFits(sb, [
    { id: '1', name: 'Cheap Rifter', hullId: 587, hullName: 'Rifter' },
    { id: '2', name: 'Blingy Loki', hullId: 29990, hullName: 'Loki' },
  ], true);

  await sb._fitDeleteLocalFit('1');
  assert.strictEqual(asked.length, 1, 'it must confirm before deleting');
  assert.strictEqual(asked[0].danger, true, 'a destructive action is marked danger');
  assert.ok(asked[0].body.includes('Cheap Rifter'), 'the dialog names the fit being deleted');
  assert.ok(asked[0].body.includes('Rifter'), 'and the hull it belongs to');

  const left = JSON.parse(store.fitLocalFits);
  assert.deepStrictEqual(left.map(f => f.id), ['2'], 'only that fit is removed');
});

test('declining the dialog keeps the fit', async () => {
  const sb = loadSim();
  const { store } = withSavedFits(sb, [{ id: '1', name: 'Cheap Rifter', hullId: 587, hullName: 'Rifter' }], false);
  await sb._fitDeleteLocalFit('1');
  assert.strictEqual(JSON.parse(store.fitLocalFits).length, 1, 'saying no must not delete');
});

test('deleting a fit that is already gone is a no-op', async () => {
  const sb = loadSim();
  const { store, asked } = withSavedFits(sb, [{ id: '1', name: 'Cheap Rifter', hullId: 587 }], true);
  await sb._fitDeleteLocalFit('nope');
  assert.strictEqual(asked.length, 0, 'no dialog for a fit that does not exist');
  assert.strictEqual(JSON.parse(store.fitLocalFits).length, 1);
});

// ── In-game fits: removed from EVE Carbon, never from the game ───────────────
// The app is the fitting tool: fits are imported from the game, worked on here,
// and pushed back with Save to Game. Removing one is an EVE Carbon-side action
// only. ESI *can* delete a fitting outright and the app holds the scope for it,
// but that is a one-way action on live character data and is deliberately not
// wired to this button.

function withGameFits(sb, fits, answer) {
  const store = {};
  sb.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sb.document.getElementById = (id) => (id === 'fitCharSelect' ? { value: '90000001' } : null);
  const asked = [];
  sb.showConfirm = (opts) => { asked.push(opts); return Promise.resolve(answer); };
  sb.window.eveAPI.fitGetFittings = () => Promise.resolve({ ok: true, fittings: fits });
  return { store, asked };
}

test('removing an in-game fit never calls ESI', () => {
  // The guard that matters: no delete-from-game path may exist behind this
  // button. If one is ever added, it must be a separate, explicit action.
  const sb = loadSim();
  assert.strictEqual(typeof sb.window.eveAPI.fitDeleteFitting, 'undefined',
    'there must be no ESI fitting-delete binding wired to the remove button');
  assert.strictEqual(typeof sb._fitDeleteGameFit, 'undefined',
    'the delete-from-game helper should be gone');
  assert.strictEqual(typeof sb._fitHideGameFit, 'function', 'removing is an app-side hide');
});

test('the dialog promises the fit stays in the game', async () => {
  const sb = loadSim();
  const { asked, store } = withGameFits(sb, [{ fittingId: 55, name: 'God Tier Baltec' }], true);
  await sb._fitHideGameFit('55', 'God Tier Baltec');
  assert.strictEqual(asked.length, 1, 'it must confirm first');
  assert.ok(/stays in the game/i.test(asked[0].body),
    `the dialog must say the fit survives in the game, got: ${asked[0].body}`);
  assert.ok(asked[0].body.includes('God Tier Baltec'), 'and name the fit');
  assert.ok(JSON.parse(store.fitHiddenGameFits).includes('90000001:55'),
    'the fit is remembered as hidden, keyed by character');
});

test('declining leaves the fit visible', async () => {
  const sb = loadSim();
  const { store } = withGameFits(sb, [{ fittingId: 55, name: 'The Bhaal' }], false);
  await sb._fitHideGameFit('55', 'The Bhaal');
  assert.strictEqual(store.fitHiddenGameFits, undefined, 'nothing is hidden');
});

test('a hidden fit is filtered out of the fetched list, not deleted', async () => {
  // ESI still returns it on every fetch — the filter is the only thing keeping
  // it off screen, which is exactly why it can be restored.
  const sb = loadSim();
  withGameFits(sb, [
    { fittingId: 55, name: 'Hidden', shipTypeId: 1 },
    { fittingId: 56, name: 'Shown',  shipTypeId: 1 },
  ], true);
  await sb._fitHideGameFit('55', 'Hidden');
  await sb._fitEnsureGameFits();
  assert.deepStrictEqual(sb._fitState.fitsByHull.all.map(f => f.name), ['Shown']);
  assert.strictEqual(sb._fitState.fitsHiddenCount, 1, 'the count drives the Restore affordance');
});

test('hidden fits can be restored', async () => {
  const sb = loadSim();
  withGameFits(sb, [{ fittingId: 55, name: 'Hidden', shipTypeId: 1 }], true);
  await sb._fitHideGameFit('55', 'Hidden');
  sb._fitRestoreHiddenGameFits();
  await sb._fitEnsureGameFits();
  assert.deepStrictEqual(sb._fitState.fitsByHull.all.map(f => f.name), ['Hidden'],
    'restoring brings it back — it was never gone');
});

test('hiding is per character', async () => {
  // Fitting ids are only unique within a character, so an unkeyed list would
  // hide an unrelated fit on someone else.
  const sb = loadSim();
  const { store } = withGameFits(sb, [{ fittingId: 55, name: 'Mine', shipTypeId: 1 }], true);
  await sb._fitHideGameFit('55', 'Mine');
  assert.ok(JSON.parse(store.fitHiddenGameFits)[0].startsWith('90000001:'), 'keyed by character');
  sb.document.getElementById = (id) => (id === 'fitCharSelect' ? { value: '90000002' } : null);
  await sb._fitEnsureGameFits();
  assert.strictEqual(sb._fitState.fitsByHull.all.length, 1,
    'another character with the same fitting id keeps seeing theirs');
});

// ── Stats panel ──────────────────────────────────────────────────────────────

// Renders the real panel into a stub element so a broken template or a missing
// helper fails here rather than as a blank card in the app.
function render(sb) {
  let html = '';
  const el = {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
  };
  sb.document.getElementById = (id) => (id === 'fitStats' ? el : null);
  sb._fitRenderStats();
  return html;
}

test('the stats panel shows boosted totals, and explains the green number', () => {
  // The panel used to print the UNBOOSTED figure as the headline with the boost
  // beside it, so a boosted ship read "673 m/s  +172" and left the reader to do
  // the addition. The headline is now the total actually flown.
  // With an MWD fitted, so the skirmish link has a prop mod to amplify — the
  // exact shape that used to read "673 m/s  +172".
  const sb = loadSim();
  rig(sb, { mwd: true });
  const plain = render(sb);
  assert.ok(plain.includes('Max velocity'), 'the navigation card should render');
  assert.ok(!plain.includes('fit-boost-legend'),
    'with no boost running there is no green number, so no legend');

  sb._fitState.links = 'all';
  const boosted = render(sb);
  assert.ok(boosted.includes('fit-boost-legend'), 'a boosted fit explains its green figures');
  assert.ok(boosted.includes('fit-boost-delta'), 'and still shows the boost contribution');

  // Every boosted stat reads "base +boost [combined]" — all three, in that
  // order. Base alone made the reader add up; the combined alone hid where it
  // came from and read as though the green figure were on top of it again.
  const D  = sb._fitShipDerived();
  const DB = sb._fitShipDerived(sb._fitActiveBuffs());
  assert.ok(DB.maxVel > D.maxVel, 'skirmish links should raise velocity at all');
  assert.ok(boosted.includes(sb._fitNum(D.maxVel)), 'the base figure is shown');
  assert.ok(boosted.includes(`[${sb._fitNum(DB.maxVel)}`), 'the combined total is bracketed');
  assert.ok(boosted.indexOf('fit-boost-delta') < boosted.indexOf('fit-boost-total'),
    'the green boost comes before the bracketed total');

  // …and an unboosted stat shows a bare number, with no empty brackets.
  assert.ok(!plain.includes('fit-boost-total'), 'no brackets when nothing is boosted');
});

// ── Weapon rigs ──────────────────────────────────────────────────────────────
// Large Energy Burst Aerator II (204 = 0.85 cycle) and Large Energy Collision
// Accelerator II (64 = 1.15 damage). Both are group "Rig Energy Weapon"; the
// projectile one is here to prove the family guard still bites.
const AERATOR = () => facts({ id: 26932, name: 'Large Energy Burst Aerator II',
  groupName: 'Rig Energy Weapon', groupId: 775, slot: 'rig',
  rofMult: 0.85, attrs: { 204: 0.85, 1153: 200 } });
const ACCEL = () => facts({ id: 26928, name: 'Large Energy Collision Accelerator II',
  groupName: 'Rig Energy Weapon', groupId: 775, slot: 'rig',
  dmgMultMod: 1.15, attrs: { 64: 1.15, 1153: 200 } });
const PROJ_RIG = () => facts({ id: 26934, name: 'Large Projectile Burst Aerator II',
  groupName: 'Rig Projectile Weapon', groupId: 774, slot: 'rig',
  rofMult: 0.85, attrs: { 204: 0.85 } });

test('weapon rate-of-fire rigs speed the guns up', () => {
  // _fitDamageBonuses only ever looked at LOW slots, so every weapon damage and
  // RoF rig in the game contributed nothing — about 18% of the DPS of any fit
  // carrying a Burst Aerator.
  const sb = loadSim();
  rig(sb, {});
  const before = dps(sb);
  sb._fitState.modules.rig.push(sb._fitMod(AERATOR()));
  assert.ok(Math.abs(dps(sb) / before - 1 / 0.85) < 1e-9,
    `a −15% cycle rig is +17.6% dps, got ${((dps(sb) / before - 1) * 100).toFixed(2)}%`);
});

test('weapon damage rigs raise the volley', () => {
  const sb = loadSim();
  rig(sb, {});
  const before = sb._fitWeaponSim()[0].volley;
  sb._fitState.modules.rig.push(sb._fitMod(ACCEL()));
  assert.ok(Math.abs(sb._fitWeaponSim()[0].volley / before - 1.15) < 1e-9, 'attr 64 is +15% damage');
});

test('a weapon rig shares the damage-mod stacking chain', () => {
  // A Collision Accelerator modifies the same attribute a Heat Sink does, so the
  // two must taper together rather than each getting a clean run.
  const sb = loadSim();
  rig(sb, {});
  sb._fitState.modules.low.push(sb._fitMod(facts({
    name: 'Heat Sink II', groupName: 'Heat Sink', slot: 'low', dmgMultMod: 1.1, attrs: { 64: 1.1 } })));
  const withHs = sb._fitWeaponSim()[0].volley;
  sb._fitState.modules.rig.push(sb._fitMod(ACCEL()));
  const both = sb._fitWeaponSim()[0].volley;
  // 0.15 is the stronger bonus so it leads; the 0.10 heat sink takes the penalty.
  const expected = (1 + 0.15) * (1 + 0.10 * Math.exp(-((1 / 2.67) ** 2))) / (1 + 0.10);
  assert.ok(Math.abs(both / withHs - expected) < 1e-9,
    'rig and heat sink must share one penalized chain, not stack cleanly');
});

test('a rig for another weapon family does nothing', () => {
  const sb = loadSim();
  rig(sb, {});
  const before = dps(sb);
  sb._fitState.modules.rig.push(sb._fitMod(PROJ_RIG()));
  assert.strictEqual(dps(sb), before, 'a projectile rig must not speed up an energy turret');
});

// ── High slots that are not turrets ──────────────────────────────────────────
// Verified against a live Paladin readout on 2026-08-20, where turning the
// smartbomb off moved Offense by exactly 375 HP of alpha.

// Dark Blood Large EMP Smartbomb: 375 EM, 10s cycle, 130 GJ, 7.5km radius.
const SMARTBOMB = () => facts({ id: 14210, name: 'Dark Blood Large EMP Smartbomb',
  groupName: 'Smart Bomb', groupId: 72, activatable: true,
  attrs: { 114: 375, 73: 10000, 6: 130, 99: 7500 } });
// Corpus A-Type Heavy Energy Nosferatu: transfers 120 GJ per 10s, costs nothing.
const NOS = () => facts({ id: 15782, name: 'Corpus A-Type Heavy Energy Nosferatu',
  groupName: 'Energy Nosferatu', groupId: 68, activatable: true,
  attrs: { 90: 120, 73: 10000, 54: 30000 } });
// Large Micro Jump Drive: 786 GJ, 12s cycle, 180s reactivation, +150% signature.
const MJD = () => facts({ id: 4383, name: 'Large Micro Jump Drive',
  groupName: 'Micro Jump Drive', groupId: 1189, slot: 'med', activatable: true,
  attrs: { 6: 786, 73: 12000, 669: 180000, 973: 150 } });

test('smartbombs count toward offence', () => {
  // They carry no hardpoint, so the weapon grouping skipped them entirely — but
  // the game counts them, and a Large EMP is 375 alpha.
  const sb = loadSim();
  rig(sb, {});
  const before = dps(sb);
  sb._fitState.modules.high.push(sb._fitMod(SMARTBOMB()));
  const sim = sb._fitWeaponSim();
  const bomb = sim.find(g => g.kind === 'smartbomb');
  assert.ok(bomb, 'the smartbomb should appear as its own series');
  assert.strictEqual(bomb.volley, 375);
  assert.strictEqual(bomb.dps, 37.5);
  assert.ok(Math.abs(dps(sb) - (before + 37.5)) < 1e-9, 'and be added to the total');
});

test('an inactive smartbomb contributes nothing', () => {
  const sb = loadSim();
  rig(sb, {});
  const before = dps(sb);
  const m = sb._fitMod(SMARTBOMB());
  m.state = 'online';
  sb._fitState.modules.high.push(m);
  assert.strictEqual(dps(sb), before);
});

test('a nosferatu feeds the capacitor rather than draining it', () => {
  // It has no activation cost at all, so the cap sim skipped it — leaving one
  // of the biggest cap sources on the fit reading as nothing.
  const sb = loadSim();
  rig(sb, {});
  const before = sb._fitCapSim(sb._fitShipDerived());
  sb._fitState.modules.high.push(sb._fitMod(NOS()));
  const after = sb._fitCapSim(sb._fitShipDerived());
  assert.ok(Math.abs((after.inject - before.inject) - 12) < 1e-9,
    '120 GJ every 10s is +12 GJ/s');
  assert.strictEqual(after.drain, before.drain, 'and it costs nothing to run');
});

test('a module with a reactivation delay is charged over its real duty cycle', () => {
  // A Large Micro Jump Drive is 786 GJ once every 192s, not every 12s. Charged
  // at its raw cycle it alone read as half the ship's capacitor load.
  const sb = loadSim();
  rig(sb, {});
  const before = sb._fitCapSim(sb._fitShipDerived()).drain;
  sb._fitState.modules.med.push(sb._fitMod(MJD()));
  const after = sb._fitCapSim(sb._fitShipDerived()).drain;
  const added = after - before;
  assert.ok(Math.abs(added - 786 / 192) < 1e-6,
    `expected 786/(12+180) = 4.09 GJ/s, got ${added.toFixed(2)}`);
});

test('a micro jump drive blooms the signature on its own attribute', () => {
  // MJDs use attr 973, not the prop-mod 554, and they are not prop mods — so
  // the prop loop never saw them. MWDs keep using 554; afterburners carry
  // neither attribute and correctly bloom nothing.
  const sb = loadSim();
  rig(sb, {});
  const before = sb._fitShipDerived().sig;
  sb._fitState.modules.med.push(sb._fitMod(MJD()));
  assert.ok(Math.abs(sb._fitShipDerived().sig / before - 2.5) < 1e-9,
    '+150% signature is 2.5x');
});

// ── Drones ───────────────────────────────────────────────────────────────────

// Infiltrator II (2175): em 32, damageMultiplier 1.68, rof 4000ms. Required
// skills Medium Drone Operation 33699 (5%/lvl damage) and Amarr Drone
// Specialization 12484 (2%/lvl) — plus Drones 3436, which carries no bonus.
const DRONE = () => facts({
  id: 2175, name: 'Infiltrator II', groupName: 'Combat Drone', groupId: 100,
  categoryId: 18, slot: null, volume: 10,
  dmg: { em: 32, th: 0, kin: 0, exp: 0 },
  skillBonuses: [{ id: 33699, dmg: 5, rof: 0 }, { id: 12484, dmg: 2, rof: 0 }],
  attrs: { 114: 32, 64: 1.68, 51: 4000, 1272: 10, 182: 33699, 183: 12484, 184: 3436 },
});

test('drones get the size and specialization skills they require', () => {
  // Only Drone Interfacing was applied, leaving every drone in the app about a
  // quarter light: 2x Infiltrator II read 40.3 dps against a real 54.4.
  //   32 × 1.68 ÷ 4s = 13.44  × 1.5 (Interfacing V) × 1.25 (Medium Drone
  //   Operation V) × 1.10 (Amarr Drone Spec V) × 2 drones = 55.44
  const sb = loadSim();
  rig(sb, {});
  sb._fitState.drones = [{ id: 2175, name: 'Infiltrator II', f: DRONE(), qty: 2, active: 2 }];
  const [d] = sb._fitDroneSim();
  assert.ok(d, 'the drone should produce a sim entry');
  assert.ok(Math.abs(d.dps - 55.44) < 0.05, `expected 55.44 dps at all V, got ${d.dps.toFixed(2)}`);
});

test('Drone Interfacing is not double-counted when a drone requires it', () => {
  // It is applied explicitly for every drone, so a drone that also lists it as
  // a required skill must not pick it up twice.
  const sb = loadSim();
  rig(sb, {});
  const f = DRONE();
  sb._fitState.drones = [{ id: 2175, name: 'Infiltrator II', f, qty: 2, active: 2 }];
  const before = sb._fitDroneSim()[0].dps;
  f.skillBonuses = f.skillBonuses.concat([{ id: 3442, dmg: 10, rof: 0 }]);   // Drone Interfacing
  assert.strictEqual(sb._fitDroneSim()[0].dps, before, 'Drone Interfacing must be skipped here');
});

// A T2 light fighter: 2226 damage multiplier, 2227-2230 damage per type,
// 2233 attack cycle (ms). Requires Fighters (5%/lvl) and a racial Fighter
// Specialization (2%/lvl); heavies additionally require Heavy Fighters (5%/lvl).
const FIGHTER = () => facts({
  id: 23057, name: 'Templar II', groupName: 'Light Fighter', groupId: 1537,
  categoryId: 87, slot: null, volume: 100,
  skillBonuses: [{ id: 40572, dmg: 5, rof: 0 }, { id: 92397, dmg: 2, rof: 0 }],
  attrs: { 2226: 2, 2227: 20, 2233: 4000, 2216: 1 },
});

test('fighter squadrons get their pilot skills', () => {
  // Squadrons flew on raw attributes alone — no skills at all. Fighters V
  // (+25%) and a racial specialization V (+10%) is x1.375.
  const sb = loadSim();
  rig(sb, {});
  const f = FIGHTER();
  sb._fitState.fighters = [{ id: f.id, name: f.name, f, units: 9, active: true }];
  const withSkills = sb._fitDroneSim().find(x => x.kind === 'fighter').dps;
  f.skillBonuses = [];
  const without = sb._fitDroneSim().find(x => x.kind === 'fighter').dps;
  assert.ok(Math.abs(withSkills / without - 1.375) < 1e-9,
    `Fighters V + racial spec V is 1.375x, got ${(withSkills / without).toFixed(4)}`);
});

test('a carrier with two racial bonuses applies both to its fighters', () => {
  // The Revenant carries Amarr Carrier AND Caldari Carrier fighter-damage
  // bonuses. The traits parsed, but nothing in the fighter path consumed them.
  const sb = loadSim();
  rig(sb, {});
  const f = FIGHTER();
  sb._fitState.fighters = [{ id: f.id, name: f.name, f, units: 9, active: true }];
  const bare = sb._fitDroneSim().find(x => x.kind === 'fighter').dps;
  setTraits(sb, [
    { skillID: 24311, bonus: 5, unitID: 105, bonusText: 'bonus to Fighter damage' },
    { skillID: 24312, bonus: 5, unitID: 105, bonusText: 'bonus to Fighter damage' },
  ]);
  const both = sb._fitDroneSim().find(x => x.kind === 'fighter').dps;
  assert.ok(Math.abs(both / bare - 1.5625) < 1e-9,
    `two racial carrier bonuses at V compound to 1.5625x, got ${(both / bare).toFixed(4)}`);
});

// ── Rigs ─────────────────────────────────────────────────────────────────────

test('armor HP rigs actually add armor', () => {
  // Trimark Armor Pumps carry their bonus on attr 335 as a percent, not the
  // multiplier form the engine looked for — so they contributed nothing at all.
  const sb = loadSim();
  rig(sb, { trimarks: 0 });
  const none = sb._fitShipDerived().armorHp;
  rig(sb, { trimarks: 1 });
  const one = sb._fitShipDerived().armorHp;
  assert.ok(Math.abs(one / none - 1.20) < 0.001, `one Trimark is +20%, got ${(one / none).toFixed(4)}x`);
  rig(sb, { trimarks: 2 });
  const two = sb._fitShipDerived().armorHp;
  // 1.2 × (1 + 0.2·e^−(1/2.67)²) = 1.4085 — not the 1.44 two unpenalized rigs
  // would give.
  assert.ok(Math.abs(two / none - 1.4085) < 0.001,
    `a second rig is stacking-penalized, got ${(two / none).toFixed(4)}x`);
});

// ── Agility and align time ───────────────────────────────────────────────────
// Reported against a Nyx: ours 64.1s align, in-game 36.15s. EVE's own figures
// reconcile exactly (1.386 x 0.0150 agility x 1,740,760t = 36.2s), so the
// formula is not in question — an INPUT is. These pin the agility chain so the
// question can be answered instead of argued: inertia bonuses are negative, and
// a sign mishandled anywhere in the stacking chain would make modules help less
// (or, worse, hurt) without anything throwing.
const ISTAB = () => facts({ id: 1405, name: 'Inertial Stabilizers II', groupName: 'Inertial Stabilizer',
  groupId: 77, slot: 'low', attrs: { 169: -20 } });   // SDE: attr 169 = -20

// The codebase's own stacking curve, so the expectation is derived rather than
// a copied magic number.
const stackF = (i) => Math.exp(-((i / 2.67) ** 2));

test('one inertia module gets the full, unpenalised bonus', () => {
  const sb = loadSim();
  rig(sb, {});
  const bare = sb._fitShipDerived().agility;

  rig(sb, {});
  sb._fitState.modules.low.push(sb._fitMod(ISTAB()));
  const one = sb._fitShipDerived().agility;

  assert.ok(one < bare, 'an inertia stabiliser must LOWER inertia, not raise it');
  assert.ok(Math.abs(one / bare - 0.8) < 1e-6,
    `first module should be a flat -20% (got ${(one / bare).toFixed(6)})`);
});

test('inertia modules stack-penalise like every other chain', () => {
  const sb = loadSim();
  rig(sb, {});
  const bare = sb._fitShipDerived().agility;

  rig(sb, {});
  for (let i = 0; i < 3; i++) sb._fitState.modules.low.push(sb._fitMod(ISTAB()));
  const three = sb._fitShipDerived().agility;

  let expect = 1;
  for (let i = 0; i < 3; i++) expect *= 1 - 0.20 * stackF(i);
  assert.ok(Math.abs(three / bare - expect) < 1e-6,
    `3 istabs should give x${expect.toFixed(6)}, got x${(three / bare).toFixed(6)}`);
  // The marginal module must still help, just less — the shape that proves the
  // penalty is applied rather than the chain being truncated.
  assert.ok(three > bare * 0.8 * 0.8 * 0.8, 'penalised, not multiplicative');
});

test('align time is ln(4) x agility x mass, and plate mass slows it', () => {
  const sb = loadSim();
  rig(sb, {});
  const d = sb._fitShipDerived();
  assert.ok(Math.abs(d.align - (Math.log(4) * d.agility * d.mass) / 1e6) < 1e-9,
    'align must be the EVE formula over the ship-derived agility and mass');

  rig(sb, {});
  sb._fitState.modules.low.push(sb._fitMod(PLATE()));   // 796: +4,500,000 kg
  const withPlate = sb._fitShipDerived();
  assert.ok(withPlate.mass > d.mass, 'a plate adds mass');
  assert.ok(withPlate.align > d.align, 'and a heavier ship aligns slower');
});

// ── Import-from-game picker: search and filter ───────────────────────────────
// The old picker listed a fit's NAME against a 24px icon in a 200px strip, so
// two Nyx fits were indistinguishable and a pilot with sixty of them scrolled a
// four-row viewport. These pin the two things that replaced it.
const PICK_ROWS = [
  { i: 0, name: 'Beehive Refit',  ship: 'Nyx',      klass: 'Supercarrier' },
  { i: 1, name: 'Home Defence',   ship: 'Nyx',      klass: 'Supercarrier' },
  { i: 2, name: 'Beehive Refit',  ship: 'Paladin',  klass: 'Marauder' },
  { i: 3, name: 'Gate Camp',      ship: 'Sabre',    klass: 'Interdictor' },
];
const pick = (sb, q, k = '') => PICK_ROWS.filter(r => sb._fitPickMatches(r, q, k)).map(r => r.i);

test('the picker searches hull, class AND the pilot\'s own label', () => {
  const sb = loadSim();
  // The hull — unfindable before, because only the name was ever shown.
  assert.deepStrictEqual(pick(sb, 'nyx'), [0, 1]);
  // The label the pilot gave it, which spans two different hulls.
  assert.deepStrictEqual(pick(sb, 'beehive'), [0, 2]);
  // The class.
  assert.deepStrictEqual(pick(sb, 'marauder'), [2]);
  assert.deepStrictEqual(pick(sb, ''), [0, 1, 2, 3], 'empty query shows everything');
});

test('search is case-insensitive and ignores surrounding whitespace', () => {
  const sb = loadSim();
  assert.deepStrictEqual(pick(sb, '  NYX  '), [0, 1]);
});

test('the class filter narrows, and composes with the search', () => {
  const sb = loadSim();
  assert.deepStrictEqual(pick(sb, '', 'Supercarrier'), [0, 1]);
  // Both together: "beehive" alone spans two hulls, the class picks one.
  assert.deepStrictEqual(pick(sb, 'beehive', 'Marauder'), [2]);
  assert.deepStrictEqual(pick(sb, 'sabre', 'Supercarrier'), [], 'contradictory filters match nothing');
});

test('the module count counts fitted slots, not item stacks', () => {
  const sb = loadSim();
  // flags: 27 high, 19 med, 11 low, 92 rig — and 5 = cargo, which is a charge
  // or spare, not a fitted module. Counting stacks would report 5 modules.
  const fit = { items: [{ flag: 27 }, { flag: 19 }, { flag: 11 }, { flag: 92 }, { flag: 5 }] };
  assert.strictEqual(sb._fitPickModuleCount(fit), 4);
  assert.strictEqual(sb._fitPickModuleCount({ items: [] }), 0);
  assert.strictEqual(sb._fitPickModuleCount({}), 0, 'a fit with no items must not throw');
});

// ── Importing a game fit: the flag decides, not the item's slot type ─────────
// Reported against a real Nyx: the import came back wearing five Capacitor
// Power Relay IIs, two Sensor Boosters and a cloak, while its three CONCORD
// 25000mm plates and its A-Type membranes were missing entirely. Every one of
// the wrong modules was in the CARGO HOLD. The loader fell back to the item's
// own slot type when the flag was not a slot, and a spare cap relay still
// reports slot 'low' — so the hold was fitted, overflowed the racks, and
// displaced the real modules. Every stat was then computed off the wrong ship.
// ESI sends the enum NAME, verified against /meta/openapi.json: the fitting
// item's `flag` is type string with enum Cargo | DroneBay | FighterBay |
// HiSlot0-7 | LoSlot0-7 | MedSlot0-7 | RigSlot0-2 | SubSystemSlot0-3 | ...
// The loader tested numeric ranges, which are always false for a string, so the
// flag was never read at all.
const CARGO_FLAG = 'Cargo';

async function loadGameFit(sb, items) {
  const facts = {};
  for (const it of items) facts[it.f.id] = it.f;
  sb.window.eveAPI.fitGetHull  = async () => HULL();
  sb.window.eveAPI.fitGetItems = async () => facts;
  await sb._fitLoadGameFit({
    name: 'Pegasus', shipTypeId: HULL().id,
    items: items.map(it => ({ typeId: it.f.id, flag: it.flag, quantity: it.qty || 1 })),
  });
}

// Joined to a string on purpose: these arrays are built inside the vm realm, so
// deepStrictEqual fails on the prototype even when the contents match.
const fitted = (sb, slot) =>
  (sb._fitState.modules[slot] || []).filter(Boolean).map(m => m.f.name).join(' | ');

test('a module in the cargo hold is NOT fitted', async () => {
  const sb = loadSim();
  const relay = facts({ id: 2032, name: 'Capacitor Power Relay II', slot: 'low', volume: 5 });
  await loadGameFit(sb, [{ f: relay, flag: CARGO_FLAG, qty: 5 }]);

  assert.strictEqual(fitted(sb, 'low'), '', 'the hold must not reach the racks');
  assert.strictEqual(sb._fitState.cargo.length, 1, 'it belongs in the cargo hold');
  assert.strictEqual(sb._fitState.cargo[0].name, 'Capacitor Power Relay II');
  assert.strictEqual(sb._fitState.cargo[0].qty, 5, 'and keeps the quantity the pilot stowed');
});

test('cargo does not displace what is genuinely fitted', async () => {
  const sb = loadSim();
  const plate = facts({ id: 41456, name: 'CONCORD 25000mm Steel Plates', slot: 'low',
    groupId: 329, attrs: { 1159: 82500 } });
  const relay = facts({ id: 2032, name: 'Capacitor Power Relay II', slot: 'low', volume: 5 });

  // The shape that broke it: far more low-slot modules in the hold than the
  // hull has low slots, listed BEFORE the fitted ones.
  await loadGameFit(sb, [
    { f: relay, flag: CARGO_FLAG, qty: 9 },
    { f: plate, flag: 'LoSlot0' },
    { f: plate, flag: 'LoSlot1' },
    { f: plate, flag: 'LoSlot2' },
  ]);

  assert.strictEqual(fitted(sb, 'low'),
    'CONCORD 25000mm Steel Plates | CONCORD 25000mm Steel Plates | CONCORD 25000mm Steel Plates',
    'all three plates survive a hold that would have overflowed the rack');
  assert.strictEqual(sb._fitState.cargo.length, 1);
});

test('a fitted module still lands at its exact in-game slot index', async () => {
  const sb = loadSim();
  const sb2 = facts({ id: 1234, name: 'Sensor Booster II', slot: 'med' });
  await loadGameFit(sb, [{ f: sb2, flag: 'MedSlot2' }]);
  assert.strictEqual(sb._fitState.modules.med[2]?.f.name, 'Sensor Booster II',
    'MedSlot2 must land at index 2 — the saved layout survives the round-trip');
});

test('slot flags are parsed from the ESI enum name, and numbers still work', () => {
  const sb = loadSim();
  const at = (f) => sb._fitFlagSlot(f);
  // What ESI actually sends.
  assert.deepEqual(at('LoSlot0'), { slot: 'low', index: 0 });
  assert.deepEqual(at('LoSlot7'), { slot: 'low', index: 7 });
  assert.deepEqual(at('HiSlot3'), { slot: 'high', index: 3 });
  assert.deepEqual(at('MedSlot2'), { slot: 'med', index: 2 });
  assert.deepEqual(at('RigSlot2'), { slot: 'rig', index: 2 });
  assert.deepEqual(at('SubSystemSlot1'), { slot: 'subsystem', index: 1 });
  // Everything that is not a slot.
  for (const f of ['Cargo', 'DroneBay', 'FighterBay', 'Invalid', 'ServiceSlot0', '', null, undefined]) {
    assert.strictEqual(at(f), null, String(f));
  }
  // Legacy numeric flags still resolve — the SDE and local snapshots use them.
  assert.deepEqual(at(11), { slot: 'low', index: 0 });
  assert.deepEqual(at(27), { slot: 'high', index: 0 });
  assert.deepEqual(at(94), { slot: 'rig', index: 2 });
  assert.strictEqual(at(5), null, 'numeric cargo');
});

test('imported fighters are reported, not loaded into invented tubes', async () => {
  const sb = loadSim();
  const carrier = HULL();
  carrier.fighter = { bay: 110000, tubes: 5, light: 3, support: 1, heavy: 4 };
  const ametat = facts({ id: 40348, name: 'Ametat II', categoryId: 87, volume: 1108,
    attrs: { 2215: 6 } });
  const relay  = facts({ id: 2032, name: 'Capacitor Power Relay II', slot: 'low' });

  sb.window.eveAPI.fitGetHull  = async () => carrier;
  sb.window.eveAPI.fitGetItems = async () => ({ 40348: ametat, 2032: relay });
  await sb._fitLoadGameFit({
    name: 'Pegasus', shipTypeId: carrier.id,
    items: [
      { typeId: 40348, flag: 'FighterBay', quantity: 9 },
      { typeId: 2032,  flag: 'LoSlot0',    quantity: 1 },
    ],
  });

  // EVE saves fighters to the BAY with no tube assignment, so 9 Ametat used to
  // come back as a full flight of 6 plus a stray flight of 3 — a layout the
  // pilot never chose, presented as though they had.
  assert.strictEqual((sb._fitState.fighters || []).filter(Boolean).length, 0,
    'no tube may be filled from a bay count');
  assert.strictEqual(sb._fitState.fighterBayNote.length, 1, 'but the bay contents are recorded');
  assert.strictEqual(sb._fitState.fighterBayNote[0].name, 'Ametat II');
  assert.strictEqual(sb._fitState.fighterBayNote[0].qty, 9);
  // And the rest of the fit still imports normally.
  assert.strictEqual(sb._fitState.modules.low[0]?.f.name, 'Capacitor Power Relay II');
});

test('a hull swap clears the imported fighter-bay note', async () => {
  const sb = loadSim();
  sb._fitState.fighterBayNote = [{ name: 'Ametat II', qty: 9 }];
  sb.window.eveAPI.fitGetHull = async () => HULL();
  await sb._fitLoadHull(HULL().id);
  assert.strictEqual(sb._fitState.fighterBayNote.length, 0,
    'a note about another fit must not survive onto this one');
});
