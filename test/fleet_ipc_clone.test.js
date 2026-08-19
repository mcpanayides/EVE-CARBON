'use strict';
//
// The report crossed Electron IPC carrying two name-resolver CLOSURES on its
// model (_typeName, _charName). Structured clone cannot copy a function and
// rejects the ENTIRE reply, so the report modal received a rejected promise and
// showed nothing — "Error occurred in handler for 'fleet-op-report': An object
// could not be cloned."
//
// Nothing in-process catches this: the same model is perfectly valid until it
// hits the boundary. It took a live op to surface it, so it gets a test.
const test   = require('node:test');
const assert = require('node:assert');
const { cloneable } = require('../src/ipc/fleet_ops_ipc.js');
const aar = require('../src/fleet_aar.js');

const OP = { op_id: 1, name: 'test', doctrine: 'shield', started_at: 1000, ended_at: 2000, end_reason: 'stopped' };

test('cloneable strips functions at any depth', () => {
  const src = { a: 1, fn: () => {}, nested: { b: 2, fn2: () => {} }, list: [1, () => {}, { fn3: () => {} }] };
  const out = cloneable(src);
  assert.doesNotThrow(() => structuredClone(out));
  assert.strictEqual(out.a, 1);
  assert.strictEqual(out.fn, undefined);
  assert.strictEqual(out.nested.fn2, undefined);
  assert.strictEqual(out.nested.b, 2);
  assert.deepStrictEqual(out.list, [1, {}]);   // the bare function drops out
});

test('a rendered report model survives structured clone once stripped', () => {
  const out = aar.render({
    op: OP, roster: [], movement: [], kills: [], mining: null,
    names: { systems: {}, types: {}, characters: {} }, gaps: [],
  });

  // The raw model is NOT cloneable — that is the bug, asserted so nobody
  // "simplifies" the strip away believing it was never needed.
  assert.throws(() => structuredClone(out.model), /could not be cloned/i);

  const payload = { ok: true, markdown: out.markdown, bbcode: out.bbcode, text: out.text, model: cloneable(out.model) };
  assert.doesNotThrow(() => structuredClone(payload));
  assert.ok(payload.markdown.length > 0, 'markdown survived');
});
