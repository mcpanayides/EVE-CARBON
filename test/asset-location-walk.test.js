'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAssetLocationChain, isPlaceholderName } = require('../src/asset-location-walk');

// Location-bundle fields carried up the chain (matches character_info_db.js).
const LOC_FIELDS = [
  'location_name', 'solar_system_id', 'solar_system_name',
  'region_id', 'region_name', 'security_status', 'owner_id', 'owner_name',
];

// Build a resolver context from a flat list of asset rows.
function ctx(rows, globalLoc = new Map()) {
  const byItemId = new Map();
  for (const r of rows) byItemId.set(r.item_id, r);
  return { byItemId, globalLoc, locFields: LOC_FIELDS, isPlaceholder: isPlaceholderName };
}

// A row whose parent is a resolved root carries the place; nested rows are NULL.
const resolved = (item_id, location_id, place) => ({
  item_id, location_id,
  location_name: place.name ?? null,
  solar_system_id: place.sysId ?? null,
  solar_system_name: place.sys ?? null,
  region_id: null, region_name: place.region ?? null,
  security_status: null, owner_id: null, owner_name: null,
});
const nested = (item_id, location_id) => resolved(item_id, location_id, {}); // all-null place

test('undefined start row → nulls', () => {
  const { bundle, terminusId } = resolveAssetLocationChain(undefined, ctx([]));
  assert.strictEqual(bundle, null);
  assert.strictEqual(terminusId, null);
});

test('row already at a resolved root returns its own place', () => {
  const row = resolved(1, 60003760, { name: 'Jita IV-4', sys: 'Jita' });
  const { bundle } = resolveAssetLocationChain(row, ctx([row]));
  assert.strictEqual(bundle.location_name, 'Jita IV-4');
  assert.strictEqual(bundle.solar_system_name, 'Jita');
});

test('one-level container: module inherits its container’s place', () => {
  const container = resolved(100, 60003760, { name: 'Jita IV-4', sys: 'Jita' });
  const module_   = nested(200, 100); // module sits in the container
  const rows = [container, module_];
  const { bundle, terminusId } = resolveAssetLocationChain(module_, ctx(rows));
  assert.strictEqual(bundle.location_name, 'Jita IV-4');
  // terminusId is the last id we looked up an owner for. Resolving through an
  // OWNED container, that's the container's own id; on a dead-end it's the true
  // unowned structure (see the dead-end tests below) — which is what the caller
  // uses to regroup orphans.
  assert.strictEqual(terminusId, 100);
});

test('container-in-container (asset-safety wrap) climbs through every hop', () => {
  // module → ship → asset-safety wrap → resolved station
  const wrap   = resolved(10, 60003760, { name: 'Jita IV-4', sys: 'Jita' });
  const ship   = nested(20, 10);   // Nossus inside the wrap
  const module_ = nested(30, 20);  // module fitted/loaded in the ship
  const rows = [wrap, ship, module_];
  const { bundle } = resolveAssetLocationChain(module_, ctx(rows));
  assert.strictEqual(bundle.location_name, 'Jita IV-4');
  assert.strictEqual(bundle.solar_system_name, 'Jita');
});

test('deep chain dead-ends at an UNOWNED structure resolved via the global cache', () => {
  // module → ship → wrap → structure(1031..., not an owned row)
  const STRUCT = 1031000000001;
  const wrap   = nested(10, STRUCT); // wrap's parent is a structure we don't own as an asset
  const ship   = nested(20, 10);
  const module_ = nested(30, 20);
  const globalLoc = new Map([[STRUCT, {
    location_name: 'Some Keepstar', solar_system_id: 30000142, solar_system_name: 'Jita',
    region_id: null, region_name: 'The Forge', security_status: null,
  }]]);
  const { bundle, terminusId } = resolveAssetLocationChain(module_, ctx([wrap, ship, module_], globalLoc));
  assert.strictEqual(terminusId, STRUCT);            // true root surfaced
  assert.strictEqual(bundle.location_name, 'Some Keepstar');
  assert.strictEqual(bundle.solar_system_name, 'Jita');
});

test('unowned + unresolved terminus → null bundle but real terminus id', () => {
  const STRUCT = 1054183727940;
  const ship    = nested(20, STRUCT);
  const module_ = nested(30, 20);
  const { bundle, terminusId } = resolveAssetLocationChain(module_, ctx([ship, module_]));
  assert.strictEqual(bundle, null);
  assert.strictEqual(terminusId, STRUCT); // lets the caller regroup orphans under this id
});

test('system-only structure (name unknown) still resolves the system', () => {
  const STRUCT = 1040000000002;
  const ship    = nested(20, STRUCT);
  const module_ = nested(30, 20);
  const globalLoc = new Map([[STRUCT, {
    location_name: null, solar_system_id: 30002187, solar_system_name: 'Amarr',
    region_id: null, region_name: 'Domain', security_status: null,
  }]]);
  const { bundle } = resolveAssetLocationChain(module_, ctx([ship, module_], globalLoc));
  assert.strictEqual(bundle.location_name, null);
  assert.strictEqual(bundle.solar_system_name, 'Amarr');
});

test('placeholder names are NOT treated as a resolved terminus', () => {
  // The wrap carries a bogus "Structure 123" fallback name — must keep climbing.
  const wrap = { item_id: 10, location_id: 60003760,
    location_name: 'Structure 10', solar_system_name: null,
    solar_system_id: null, region_id: null, region_name: null,
    security_status: null, owner_id: null, owner_name: null };
  const station = resolved(60003760, 0, {}); // not an owned row; via global instead
  const ship   = nested(20, 10);
  const module_ = nested(30, 20);
  const globalLoc = new Map([[60003760, {
    location_name: 'Jita IV-4', solar_system_id: 30000142, solar_system_name: 'Jita',
    region_id: null, region_name: 'The Forge', security_status: null,
  }]]);
  const { bundle } = resolveAssetLocationChain(module_, ctx([wrap, ship, module_], globalLoc));
  // wrap's "Structure 10" must be ignored; resolution continues to its parent.
  assert.strictEqual(bundle.location_name, 'Jita IV-4');
  void station;
});

test('self-loop does not hang', () => {
  const a = nested(1, 1); // points at itself
  const { bundle, terminusId } = resolveAssetLocationChain(a, ctx([a]));
  assert.strictEqual(bundle, null);
  assert.strictEqual(terminusId, 1);
});

test('two-node cycle terminates (no infinite loop)', () => {
  const a = nested(1, 2);
  const b = nested(2, 1);
  // Should return within the depth cap rather than spinning forever.
  const { bundle } = resolveAssetLocationChain(a, ctx([a, b]));
  assert.strictEqual(bundle, null);
});

test('chain longer than the depth cap terminates safely', () => {
  // 15 owned, all-unresolved containers nested in each other → exceeds cap of 10.
  const rows = [];
  for (let i = 1; i <= 15; i++) rows.push(nested(i, i + 1));
  const { bundle } = resolveAssetLocationChain(rows[0], ctx(rows));
  assert.strictEqual(bundle, null); // no throw, no hang
});

test('isPlaceholderName flags fallbacks and accepts real names', () => {
  assert.ok(isPlaceholderName('Structure 1031000000001'));
  assert.ok(isPlaceholderName('Location 123'));
  assert.ok(isPlaceholderName('No structure found with that ID!'));
  assert.ok(isPlaceholderName(''));
  assert.ok(isPlaceholderName(null));
  assert.ok(!isPlaceholderName('Jita IV-4 - Caldari Navy Assembly Plant'));
  assert.ok(!isPlaceholderName('Elle’s Keepstar'));
});
