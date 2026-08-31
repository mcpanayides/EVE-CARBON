'use strict';
//
// Clones: a named implant set you put on and take off, like a jump clone.
//
// Fits have always stored their implants and restored them. That is right for
// reopening ONE fit and wrong for comparing TWO: loading the shield version wiped
// the implants the armour version was saved with, so the ten sockets had to be
// filled in again by hand between every comparison — with the implants as the
// constant of the experiment and the hull as the variable, which is the opposite
// of how the storage worked.
//
// The load-order rule below is therefore the whole feature, and the first test
// that matters.
const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('vm');
const fs     = require('fs');
const path   = require('path');

// A real in-memory localStorage — the clone library lives there, so a no-op stub
// would make every save silently succeed and every read come back empty.
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// Frozen SDE facts. Attribute 331 is implantness — the slot the implant seats in.
const IMPLANTS = {
  20498: { id: 20498, name: 'High-grade Halo Alpha',   attrs: { 331: 1 }, categoryId: 20, volume: 1 },
  20499: { id: 20499, name: 'High-grade Halo Beta',    attrs: { 331: 2 }, categoryId: 20, volume: 1 },
  20500: { id: 20500, name: 'High-grade Halo Gamma',   attrs: { 331: 3 }, categoryId: 20, volume: 1 },
  33953: { id: 33953, name: 'Mid-grade Snake Alpha',   attrs: { 331: 1 }, categoryId: 20, volume: 1 },
  33954: { id: 33954, name: 'Mid-grade Snake Beta',    attrs: { 331: 2 }, categoryId: 20, volume: 1 },
  33955: { id: 33955, name: 'Mid-grade Snake Gamma',   attrs: { 331: 3 }, categoryId: 20, volume: 1 },
  33956: { id: 33956, name: 'Mid-grade Snake Delta',   attrs: { 331: 4 }, categoryId: 20, volume: 1 },
  33957: { id: 33957, name: 'Mid-grade Snake Epsilon', attrs: { 331: 5 }, categoryId: 20, volume: 1 },
  3467:  { id: 3467,  name: 'Ogdin’s Eye Coordination Enhancer', attrs: { 331: 6 }, categoryId: 20, volume: 1 },
};

const HULL = {
  id: 24688, name: 'Rokh', groupName: 'Battleship',
  slots: { high: 8, med: 6, low: 3, rig: 3, subsystem: 0 },
  hardpoints: { turret: 8, launcher: 0 },
  output: { cpu: 700, pg: 16000, calibration: 400 },
  cargo: 675, drone: { bay: 50, bandwidth: 25 },
  fighter: { bay: 0, tubes: 0, light: 0, support: 0, heavy: 0 },
  base: {
    shieldHp: 9000, armorHp: 7000, structureHp: 8000, capacitor: 5500,
    rechargeMs: 1_000_000, shieldRechargeMs: 2_000_000,
    shieldRes: { em: 1, th: 1, kin: 1, exp: 1 },
    armorRes: { em: 1, th: 1, kin: 1, exp: 1 },
    hullRes: { em: 1, th: 1, kin: 1, exp: 1 },
  },
  targeting: { lockRange: 90000, scanRes: 100, maxTargets: 7, sensorType: 'Gravimetric', sensorStrength: 20 },
  nav: { maxVel: 90, mass: 100_000_000, agility: 0.1, warpMult: 1, sig: 460 },
  traits: [],
};

function loadSim({ charData = null } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'func', 'fitting.js'), 'utf8');
  const noop = () => {};
  const doc = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop, addEventListener: noop }),
    addEventListener: noop, body: {}, documentElement: { style: {} }, head: {},
  };
  const eveAPI = {
    fitGetItems: async (ids) => {
      const out = {};
      for (const id of ids) if (IMPLANTS[id]) out[id] = IMPLANTS[id];
      return out;
    },
    fitGetHull: async (id) => (id === HULL.id ? JSON.parse(JSON.stringify(HULL)) : null),
    getCharacterData: async () => charData,
  };
  const sb = {
    document: doc, window: { addEventListener: noop, eveAPI }, console,
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: noop,
    navigator: { clipboard: {} }, Image: function () {},
    localStorage: memStorage(),
    Math, Date, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseFloat, parseInt, fetch: () => Promise.reject(new Error('no net')),
  };
  sb.globalThis = sb; sb.window.document = doc;
  vm.runInContext(src + '\n;globalThis.__x = { _fitState };\n', vm.createContext(sb), { filename: 'fitting.js' });
  sb._fitState = sb.__x._fitState;
  return sb;
}

const imp = (id) => ({ id, name: IMPLANTS[id].name });

// ── The load-order rule ──────────────────────────────────────────────────────

test('a worn clone survives loading a fit — the whole point', async () => {
  const S = loadSim();
  await S._fitCloneWearImplants([imp(33953), imp(33954), imp(33955)]);
  S._fitState.activeClone = { id: 'c1', name: 'Mid-grade Snake', implants: S._fitCloneSnapshot() };

  // A fit saved with a COMPLETELY different set. Before clones, this wiped the
  // three Snakes and you re-socketed them by hand to carry on comparing.
  const ok = await S._fitApplySnapshot({
    hullId: HULL.id, fitName: 'Shield Rokh', racks: {},
    implants: [imp(20498), imp(20499), null, null, null, null, null, null, null, null],
  });
  assert.strictEqual(ok, true);

  const worn = S._fitState.implants.filter(Boolean).map(i => i.name);
  assert.deepStrictEqual(worn, ['Mid-grade Snake Alpha', 'Mid-grade Snake Beta', 'Mid-grade Snake Gamma']);
  assert.strictEqual(S._fitState.activeClone.name, 'Mid-grade Snake', 'and it is still worn');
});

test('with no clone on, a fit still restores its own implants', async () => {
  // The old behaviour has to survive: reopening one fit should bring back the
  // set it was saved with.
  const S = loadSim();
  S._fitState.activeClone = null;
  await S._fitApplySnapshot({
    hullId: HULL.id, fitName: 'Armour Rokh', racks: {},
    implants: [imp(20498), imp(20499), null, null, null, null, null, null, null, null],
  });
  assert.deepStrictEqual(S._fitState.implants.filter(Boolean).map(i => i.name),
    ['High-grade Halo Alpha', 'High-grade Halo Beta']);
});

test('a locally saved fit brings its cargo back', async () => {
  // The save path stored cargo and commented that losing it "would be worse than
  // not saving it" — and then _fitLoadLocalFit omitted cargo from the call it
  // made, so every locally saved fit reopened with an empty hold.
  //
  // This goes through _fitLoadLocalFit deliberately. Calling _fitApplySnapshot
  // directly with a cargo key tests the half that was always correct and would
  // pass with the bug still in place — it did, until this was rewritten.
  const S = loadSim();
  S.localStorage.setItem('fitLocalFits', JSON.stringify([{
    id: '1', name: 'Refit Rokh', hullId: HULL.id, hullName: HULL.name,
    racks: {}, drones: [], fighters: [], implants: [],
    cargo: [{ id: 20498, qty: 4 }], saved: '2026-08-31T00:00:00.000Z',
  }]));
  await S._fitLoadLocalFit('1');
  assert.strictEqual(S._fitState.cargo.length, 1, 'the field refit survived the reload');
  assert.strictEqual(S._fitState.cargo[0].qty, 4);
});

// ── Seating ──────────────────────────────────────────────────────────────────

test('implants seat by their OWN slot attribute, not array position', async () => {
  // Saved clones are slot-indexed, but the game's jump clones arrive as a flat
  // list with no slots at all. Reading attribute 331 off each implant is the one
  // rule that serves both — indexing by position would mis-seat every game clone.
  const S = loadSim();
  const seated = await S._fitCloneWearImplants([imp(3467), imp(33953), imp(33956)]);  // slots 6, 1, 4
  assert.strictEqual(seated, 3);
  assert.strictEqual(S._fitState.implants[0].name, 'Mid-grade Snake Alpha');
  assert.strictEqual(S._fitState.implants[3].name, 'Mid-grade Snake Delta');
  assert.strictEqual(S._fitState.implants[5].name, 'Ogdin’s Eye Coordination Enhancer');
  assert.strictEqual(S._fitState.implants[1], null);
});

test('wearing a clone replaces the whole set, it does not merge', async () => {
  // Merging would leave stragglers from the previous clone in slots the new one
  // does not fill, and quietly report a tank that no real clone produces.
  const S = loadSim();
  await S._fitCloneWearImplants([imp(20498), imp(20499), imp(20500)]);
  await S._fitCloneWearImplants([imp(33956)]);
  assert.deepStrictEqual(S._fitState.implants.filter(Boolean).map(i => i.name), ['Mid-grade Snake Delta']);
});

// ── Edited detection ─────────────────────────────────────────────────────────

test('the worn clone is compared against the sockets, not trusted', async () => {
  const S = loadSim();
  await S._fitCloneWearImplants([imp(33953), imp(33954)]);
  S._fitState.activeClone = { id: 'c1', name: 'Snake', implants: S._fitCloneSnapshot() };
  assert.strictEqual(S._fitCloneIsEdited(), false);

  S._fitState.implants[2] = { id: 20500, name: IMPLANTS[20500].name, f: IMPLANTS[20500] };
  assert.strictEqual(S._fitCloneIsEdited(), true, 'socketing something extra diverges from the clone');

  S._fitState.implants[2] = null;
  assert.strictEqual(S._fitCloneIsEdited(), false, 'and undoing it converges again');
});

test('two sets are the same only if every slot matches', () => {
  const S = loadSim();
  const a = [imp(33953), imp(33954), null, null, null, null, null, null, null, null];
  assert.strictEqual(S._fitCloneSame(a, a.slice()), true);
  assert.strictEqual(S._fitCloneSame(a, [imp(33953), null, null, null, null, null, null, null, null, null]), false);
  // A shorter array is a set with empty tail slots, not a different shape.
  assert.strictEqual(S._fitCloneSame([imp(33953)], [imp(33953), null, null]), true);
  assert.strictEqual(S._fitCloneSame([], []), true);
});

// ── The one-line summary ─────────────────────────────────────────────────────

test('a clone describes itself by its dominant set, not a list of names', () => {
  const S = loadSim();
  assert.strictEqual(
    S._fitCloneSummary([imp(33953), imp(33954), imp(33955), imp(33956), imp(33957)]),
    '5 implants · Mid-grade Snake ×5');
  assert.strictEqual(
    S._fitCloneSummary([imp(33953), imp(33954), imp(33955), imp(3467)]),
    '4 implants · Mid-grade Snake ×3 + 1 other');
  assert.strictEqual(S._fitCloneSummary([]), 'empty clone');
  assert.strictEqual(S._fitCloneSummary([null, null]), 'empty clone');
});

test('a set of unrelated implants is named, not force-fitted to a set', () => {
  const S = loadSim();
  const out = S._fitCloneSummary([imp(3467)]);
  assert.match(out, /1 implant/);
  assert.match(out, /Ogdin/, 'with one implant there is no set to summarise, so name it');
});

// ── The library ──────────────────────────────────────────────────────────────

test('saving under an existing name overwrites that clone, not appends', async () => {
  const S = loadSim();
  await S._fitCloneWearImplants([imp(33953)]);
  S._fitCloneSaveCurrent('Snake');
  await S._fitCloneWearImplants([imp(33953), imp(33954)]);
  S._fitCloneSaveCurrent('snake');                     // same name, different case

  const list = S._fitClones();
  assert.strictEqual(list.length, 1, 'one clone, not two near-identical ones');
  assert.strictEqual(list[0].implants.filter(Boolean).length, 2, 'and it is the newer set');
});

test('saving a clone makes it the worn one', async () => {
  const S = loadSim();
  await S._fitCloneWearImplants([imp(33953)]);
  S._fitCloneSaveCurrent('Snake');
  assert.strictEqual(S._fitState.activeClone.name, 'Snake');
  assert.strictEqual(S._fitCloneIsEdited(), false);
});

test('a blank name saves nothing', () => {
  const S = loadSim();
  assert.strictEqual(S._fitCloneSaveCurrent('   '), null);
  assert.strictEqual(S._fitClones().length, 0);
});

test('taking a clone off leaves the implants alone', async () => {
  // Taking off UNPINS; it does not strip your head. Wiping the sockets would
  // make "take off" destructive in a way the word does not imply.
  const S = loadSim();
  await S._fitCloneWearImplants([imp(33953), imp(33954)]);
  S._fitState.activeClone = { id: 'c1', name: 'Snake', implants: S._fitCloneSnapshot() };
  S._fitCloneTakeOff();
  assert.strictEqual(S._fitState.activeClone, null);
  assert.strictEqual(S._fitState.implants.filter(Boolean).length, 2);
});

// ── The character's real clones ──────────────────────────────────────────────

test('the game’s own clones are read from the local character DB', async () => {
  const S = loadSim({
    charData: {
      implants: [
        { implant_id: 33953, type_name: 'Mid-grade Snake Alpha', slot: 1 },
        { implant_id: 33954, type_name: 'Mid-grade Snake Beta', slot: 2 },
      ],
      jumpClones: [
        { jump_clone_id: 7, clone_name: 'PvP', location_name: 'Jita IV - Moon 4',
          implants_json: JSON.stringify([{ type_id: 20498, type_name: 'High-grade Halo Alpha' }]) },
        { jump_clone_id: 8, clone_name: null, location_name: 'C-J6MT', implants_json: '[]' },
      ],
    },
  });
  // The picker reads the selected character from a <select> the harness has no
  // DOM for, so point it at one directly.
  S.document.getElementById = (id) => (id === 'fitCharSelect' ? { value: '90045610' } : null);

  const clones = await S._fitGameClones();
  assert.strictEqual(clones.length, 3, 'the current clone plus two jump clones');
  assert.strictEqual(clones[0].name, 'Current clone');
  assert.strictEqual(clones[0].implants.length, 2);
  assert.strictEqual(clones[1].name, 'PvP');
  assert.strictEqual(clones[1].where, 'Jita IV - Moon 4');
  assert.strictEqual(clones[2].name, 'Jump clone 8', 'an unnamed clone still gets a label');
});

test('no character data means no game clones, not a crash', async () => {
  const S = loadSim({ charData: null });
  S.document.getElementById = (id) => (id === 'fitCharSelect' ? { value: '1' } : null);
  // .length, not deepStrictEqual: _fitGameClones builds its array with a literal
  // inside the vm realm, whose Array.prototype is not the test realm's, and
  // deepStrictEqual compares prototypes. Two empty arrays fail it.
  assert.strictEqual((await S._fitGameClones()).length, 0);
});

test('a malformed implants_json is skipped, not fatal', async () => {
  const S = loadSim({
    charData: { implants: [], jumpClones: [{ jump_clone_id: 9, location_name: 'X', implants_json: '{not json' }] },
  });
  S.document.getElementById = (id) => (id === 'fitCharSelect' ? { value: '1' } : null);
  const clones = await S._fitGameClones();
  assert.strictEqual(clones.length, 1);
  assert.strictEqual(clones[0].implants.length, 0);
});
