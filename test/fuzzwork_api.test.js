'use strict';
//
// The Fuzzwork blueprint API — URL and response shape.
//
// Both were wrong, and neither failed loudly. The URL was missing its /blueprint
// path segment so every single call 404'd, and it carried &runs=1&me=0&pe=0,
// which the API has no concept of. Because Fuzzwork is only a FALLBACK behind
// the SDE, nothing in the app broke visibly — an install without the SDE
// downloaded just quietly showed no materials while generating a 404 per
// blueprint and per component in every tree.
//
// It took the service's operator getting in touch to surface it. This is a free
// service run by one person; the tests below exist so we cannot go back to
// hammering it.
const test   = require('node:test');
const assert = require('node:assert');
const { _fuzzwork } = require('../src/ipc/esi_ipc');
const { FUZZWORK_BLUEPRINT_URL, _fuzzworkMaterials } = _fuzzwork;

test('the URL has the /blueprint path segment', () => {
  const url = FUZZWORK_BLUEPRINT_URL(590);
  assert.strictEqual(url, 'https://www.fuzzwork.co.uk/blueprint/api/blueprint.php?typeid=590');
  // The exact shape that 404'd, spelled out so it cannot come back.
  assert.ok(!/\/api\/blueprint\.php/.test(url.replace('/blueprint/api/', '/OK/')),
    'the bare /api/blueprint.php path does not exist and 404s every time');
});

test('no runs / me / pe parameters — the API has no such concept', () => {
  const url = FUZZWORK_BLUEPRINT_URL(590);
  for (const p of ['runs=', 'me=', 'pe=']) {
    assert.ok(!url.includes(p), `${p} is meaningless to this API and was part of the bad request`);
  }
});

// A real response, trimmed — captured from the live endpoint for typeid 590.
const REAL = {
  requestedid: 590,
  blueprintSkills: { 1: [{ typeid: 3380, name: 'Industry', level: 1 }] },
  blueprintDetails: {
    maxProductionLimit: 30, productTypeID: 587, productTypeName: 'Rifter',
    productQuantity: 1, techLevel: 1, adjustedPrice: 1234,
  },
  activityMaterials: {
    1: [{ typeid: 34, name: 'Tritanium', quantity: 24000, maketype: -1 },
        { typeid: 35, name: 'Pyerite',   quantity: 4500,  maketype: -1 }],
    8: [{ typeid: 20410, name: 'Datacore', quantity: 2, maketype: -1 }],
  },
};

test('materials come from activityMaterials, not a `materials` key', () => {
  // The response has no top-level `materials`. Reading one — which is what the
  // code did — finds nothing even when the request finally succeeds.
  assert.strictEqual(REAL.materials, undefined, 'the API really does not send this');
  const out = _fuzzworkMaterials(REAL, 590);
  assert.ok(out, 'the adapter found the manufacturing recipe');
  assert.deepStrictEqual(out.materials, [
    { typeid: 34, quantity: 24000, name: 'Tritanium' },
    { typeid: 35, quantity: 4500,  name: 'Pyerite' },
  ]);
});

test('manufacturing is preferred, and invention is never mistaken for a recipe', () => {
  // Activity 1 is manufacturing, 11 reactions, 8 invention. Datacores are not
  // how you build a Rifter.
  const out = _fuzzworkMaterials(REAL, 590);
  assert.ok(!out.materials.some(m => m.name === 'Datacore'), 'activity 8 is not a build recipe');
});

test('a reaction formula falls back to activity 11', () => {
  const reaction = { activityMaterials: { 11: [{ typeid: 16670, name: 'Crystallite Alloy', quantity: 100 }] },
                     blueprintDetails: { productTypeID: 16671, productTypeName: 'Thing', productQuantity: 200 } };
  const out = _fuzzworkMaterials(reaction, 4321);
  assert.strictEqual(out.materials.length, 1);
  assert.strictEqual(out.productQuantity, 200);
});

test('product details ride along — the old call could not supply them', () => {
  const out = _fuzzworkMaterials(REAL, 590);
  assert.strictEqual(out.productTypeID, 587);
  assert.strictEqual(out.productTypeName, 'Rifter');
  assert.strictEqual(out.productQuantity, 1);
  assert.strictEqual(out.blueprintTypeID, 590);
});

test('an empty or unusable response yields null rather than a broken record', () => {
  // ?producttypeid=… answers 200 with an EMPTY body, which is why that call was
  // removed outright rather than repointed.
  for (const bad of [null, undefined, {}, '', { activityMaterials: {} },
                     { activityMaterials: { 8: [{ typeid: 1, quantity: 1 }] } }]) {
    assert.strictEqual(_fuzzworkMaterials(bad, 1), null, `should reject ${JSON.stringify(bad)}`);
  }
});
