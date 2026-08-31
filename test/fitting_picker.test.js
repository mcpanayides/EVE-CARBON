'use strict';
//
// What the shared item picker SAYS about a row before you click it.
//
// The bays used to add items through an inline search whose results dropped in a
// box on top of the very list they were being added to: searching "high" for an
// implant covered all ten sockets, so you could not see which slot the implant
// would take or what was already there. The fix moves adding into a modal and
// puts the consequence on every row.
//
// That only helps if the consequence is TRUE. A row that says "slot 4 is empty"
// over an occupied socket is worse than the overlay it replaced — the overlay
// was merely in the way; this would be lying. So the row's words are named
// functions, and these are the assertions on them.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

// Same harness as fitting_sim.test.js: fitting.js is a plain renderer script, so
// it is run in a vm context. Top-level `function` declarations land on that
// context's global and are reachable; top-level `const` bindings are not, hence
// the appended exporter.
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

// A row exactly as fit-search returns it: id, name, and the facts the picker
// needs to describe the row without a second round-trip.
const row = (o) => Object.assign(
  { id: 1, name: 'Item', groupName: '', groupId: 0, categoryId: 7, volume: 0,
    implantSlot: null, squadron: null }, o);

// ── Implant slot ─────────────────────────────────────────────────────────────

test('an implant slot is only 1–10', () => {
  const S = loadSim();
  assert.strictEqual(S._fitImplantSlotOf(row({ implantSlot: 1 })), 1);
  assert.strictEqual(S._fitImplantSlotOf(row({ implantSlot: 10 })), 10);
  // Verified against data/sde.sql: of every published implant, exactly ONE has
  // an implantness outside 1–10 — Genolution 'Auroral' AU-79, which carries 79.
  assert.strictEqual(S._fitImplantSlotOf(row({ implantSlot: 79 })), null);
  assert.strictEqual(S._fitImplantSlotOf(row({ implantSlot: 0 })), null);
  assert.strictEqual(S._fitImplantSlotOf(row({ implantSlot: null })), null);
});

test('the one unsocketable implant is blocked, and says why', () => {
  const S = loadSim();
  assert.strictEqual(S._fitImplantRowBlock(row({ implantSlot: 6 })), null);
  const why = S._fitImplantRowBlock(row({ name: "Genolution 'Auroral' AU-79", implantSlot: 79 }));
  assert.match(why, /no implant slot/i);
  assert.match(why, /79/, 'names the value, so the claim is checkable rather than a shrug');
});

// ── Implant consequence ──────────────────────────────────────────────────────

test('an implant row says which socket it takes and what it replaces', () => {
  const S = loadSim();
  S._fitState.implants = new Array(10).fill(null);
  assert.strictEqual(S._fitImplantRowNote(row({ id: 20498, implantSlot: 1 })), 'slot 1 is empty');

  S._fitState.implants[0] = { id: 20499, name: 'High-grade Halo Beta' };
  assert.strictEqual(S._fitImplantRowNote(row({ id: 20498, implantSlot: 1 })),
    'replaces High-grade Halo Beta',
    'the whole point: you can see what you are about to overwrite');

  // Same implant already in that socket — picking it would be a no-op, and
  // saying "replaces itself" would be nonsense.
  assert.strictEqual(S._fitImplantRowNote(row({ id: 20499, implantSlot: 1 })), 'already socketed');
});

test('an implant row reads the socket it targets, not the first one', () => {
  // The bug this pins: indexing implants[n] instead of implants[n - 1] shifts
  // every note by one socket, so the list is confidently wrong everywhere.
  const S = loadSim();
  S._fitState.implants = new Array(10).fill(null);
  S._fitState.implants[5] = { id: 999, name: 'Ogdin’s Eye' };
  assert.strictEqual(S._fitImplantRowNote(row({ implantSlot: 6 })), 'replaces Ogdin’s Eye');
  assert.strictEqual(S._fitImplantRowNote(row({ implantSlot: 5 })), 'slot 5 is empty');
  assert.strictEqual(S._fitImplantRowNote(row({ implantSlot: 7 })), 'slot 7 is empty');
});

// ── Cargo consequence ────────────────────────────────────────────────────────

function cargoHull(S, cargoM3) {
  S._fitState.hull = {
    id: 1, name: 'Test', slots: { high: 0, med: 0, low: 0, rig: 0, subsystem: 0 },
    hardpoints: { turret: 0, launcher: 0 }, output: { cpu: 0, pg: 0, calibration: 0 },
    cargo: cargoM3, drone: { bay: 0, bandwidth: 0 },
    fighter: { bay: 0, tubes: 0, light: 0, support: 0, heavy: 0 },
    base: { shieldHp: 0, armorHp: 0, structureHp: 0, capacitor: 0, rechargeMs: 1,
            shieldRechargeMs: 1, shieldRes: {}, armorRes: {}, hullRes: {} },
    targeting: {}, nav: { maxVel: 0, mass: 1, agility: 1, warpMult: 1, sig: 1 }, traits: [],
  };
  S._fitState.racks = { high: [], med: [], low: [], rig: [], subsystem: [] };
  S._fitState.cargo = [];
}

test('a cargo row says how many more the hold takes', () => {
  const S = loadSim();
  cargoHull(S, 100);
  // 100 m³ free, 5 m³ each → 20 more.
  assert.match(S._fitCargoRowNote(row({ id: 7, volume: 5 })), /^20 more fit in the hold$/);
});

test('a cargo row counts what is already loaded, and says so', () => {
  const S = loadSim();
  cargoHull(S, 100);
  S._fitState.cargo = [{ id: 7, name: 'Paste', qty: 10, f: { volume: 5 } }];   // 50 m³ used
  const note = S._fitCargoRowNote(row({ id: 7, volume: 5 }));
  assert.match(note, /10 more fit/, 'free space is measured against what is ALREADY in the hold');
  assert.match(note, /10 loaded/, 'and the stack you have is named');
});

test('a full hold says it would overfill rather than quietly reporting zero', () => {
  const S = loadSim();
  cargoHull(S, 10);
  S._fitState.cargo = [{ id: 7, name: 'Paste', qty: 2, f: { volume: 5 } }];
  assert.match(S._fitCargoRowNote(row({ id: 8, volume: 5 })), /would overfill/);
});

test('an item with no SDE volume is described, not divided by', () => {
  const S = loadSim();
  cargoHull(S, 100);
  assert.match(S._fitCargoRowNote(row({ id: 9, volume: 0 })), /no volume in the SDE/);
});

// ── Fighter constraints ──────────────────────────────────────────────────────

const LIGHT = 1652, SUPPORT = 1537, HEAVY = 1653;

function carrier(S, { tubes = 3, light = 3, support = 1, heavy = 0, bay = 60000 } = {}) {
  S._fitState.hull = {
    id: 23913, name: 'Nyx', slots: { high: 0, med: 0, low: 0, rig: 0, subsystem: 0 },
    hardpoints: { turret: 0, launcher: 0 }, output: { cpu: 0, pg: 0, calibration: 0 },
    cargo: 1000, drone: { bay: 0, bandwidth: 0 },
    fighter: { bay, tubes, light, support, heavy },
    base: { shieldHp: 0, armorHp: 0, structureHp: 0, capacitor: 0, rechargeMs: 1,
            shieldRechargeMs: 1, shieldRes: {}, armorRes: {}, hullRes: {} },
    targeting: {}, nav: { maxVel: 0, mass: 1, agility: 1, warpMult: 1, sig: 1 }, traits: [],
  };
  S._fitState.fighters = new Array(tubes).fill(null);
}

test('a loadable squadron is not blocked', () => {
  const S = loadSim();
  carrier(S);
  assert.strictEqual(S._fitFighterRowBlock(row({ groupId: LIGHT, squadron: 9, volume: 1000 })), null);
});

test('a hull with no tubes of that role blocks, and names the role', () => {
  const S = loadSim();
  carrier(S, { tubes: 3, light: 3, support: 0, heavy: 0 });
  const why = S._fitFighterRowBlock(row({ groupId: SUPPORT, squadron: 9, volume: 1000 }));
  assert.match(why, /No free support squadron slots/);
  assert.match(why, /0\/0|\(0\/0\)/, 'the count is shown, so the limit is checkable');
});

test('full tubes are reported before a full bay — the limit you hit first', () => {
  // Order matters. With every tube loaded AND the bay near full, "bay full" is
  // technically true and useless: emptying the bay would not help.
  const S = loadSim();
  carrier(S, { tubes: 2, light: 2, bay: 1500 });
  S._fitState.fighters = [
    { id: 1, name: 'A', f: { volume: 500, groupId: LIGHT }, units: 1, active: true },
    { id: 2, name: 'B', f: { volume: 500, groupId: LIGHT }, units: 1, active: true },
  ];
  assert.match(S._fitFighterRowBlock(row({ groupId: LIGHT, squadron: 9, volume: 1000 })),
    /All 2 launch tubes are loaded/);
});

test('a bay too small for one unit blocks with the volume', () => {
  const S = loadSim();
  carrier(S, { tubes: 3, light: 3, bay: 1000 });
  S._fitState.fighters = [
    { id: 1, name: 'A', f: { volume: 500, groupId: LIGHT }, units: 1, active: true }, null, null,
  ];
  const why = S._fitFighterRowBlock(row({ groupId: LIGHT, squadron: 9, volume: 1000 }));
  assert.match(why, /Fighter bay full/);
});

test('a non-fighter is rejected as such', () => {
  const S = loadSim();
  carrier(S);
  assert.strictEqual(S._fitFighterRowBlock(row({ groupId: 999, squadron: null, volume: 10 })),
    'Not a fighter squadron.');
});

test('a fighter row names its tube and how much of the squadron fits', () => {
  const S = loadSim();
  carrier(S, { tubes: 3, light: 3, bay: 60000 });
  assert.strictEqual(S._fitFighterRowNote(row({ groupId: LIGHT, squadron: 9, volume: 1000 })),
    'light · tube 1 · full 9-unit squadron');

  // Bay holds only four more units of a nine-unit squadron: say four, not nine.
  carrier(S, { tubes: 3, light: 3, bay: 4000 });
  assert.strictEqual(S._fitFighterRowNote(row({ groupId: HEAVY, squadron: 9, volume: 1000 })),
    'heavy · tube 1 · only 4 of 9 units fit');
});

test('the note points at the first FREE tube, not tube 1', () => {
  const S = loadSim();
  carrier(S, { tubes: 3, light: 3, bay: 60000 });
  S._fitState.fighters = [
    { id: 1, name: 'A', f: { volume: 1000, groupId: LIGHT }, units: 1, active: true }, null, null,
  ];
  assert.match(S._fitFighterRowNote(row({ groupId: LIGHT, squadron: 9, volume: 1000 })), /tube 2/);
});
