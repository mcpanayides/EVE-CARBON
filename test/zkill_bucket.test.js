'use strict';
// Guards the sequence bucketing the batched fan-out is built on.
//
// The whole economic argument rests on two properties, so they are asserted
// rather than assumed:
//
//   • every client asks for the SAME urls (block boundaries are fixed, not
//     derived from each client's cursor), so one cache entry serves everyone;
//   • a FINISHED block is immutable and can be cached hard, while the newest
//     one must not be — caching a still-filling block for a day would freeze
//     the feed for every client at once.
const test   = require('node:test');
const assert = require('node:assert');

let B;
test.before(async () => { B = await import('../workers/zkill-fanout/bucket.js'); });

test('block boundaries are fixed, not relative to a cursor', () => {
  const { bucketOf, BUCKET_SIZE } = B;
  // Two clients at different cursors inside the same block must ask for the
  // same block — this is the property that makes the cache collapse.
  const base = 96_000_000;
  const b = bucketOf(base);
  for (let i = 0; i < BUCKET_SIZE; i++) {
    assert.strictEqual(bucketOf(base + i - (base % BUCKET_SIZE)), b,
      `offset ${i} must stay in block ${b}`);
  }
  assert.strictEqual(bucketOf(base - (base % BUCKET_SIZE) + BUCKET_SIZE), b + 1,
    'and the next id starts the next block');
});

test('a block covers exactly BUCKET_SIZE ids, contiguously', () => {
  const { bucketRange, BUCKET_SIZE, bucketOf } = B;
  const r = bucketRange(1_920_000);
  assert.strictEqual(r.to - r.from + 1, BUCKET_SIZE);
  assert.strictEqual(bucketOf(r.from), 1_920_000);
  assert.strictEqual(bucketOf(r.to), 1_920_000, 'last id is still in the block');
  // No gaps and no overlap between neighbours.
  assert.strictEqual(bucketRange(1_920_001).from, r.to + 1);
});

test('only a finished block may be cached hard', () => {
  const { isComplete, bucketRange } = B;
  const bucket = 1_000;
  const { to } = bucketRange(bucket);
  assert.strictEqual(isComplete(bucket, to + 1), true, 'newest is past the block: finished');
  assert.strictEqual(isComplete(bucket, to), false, 'newest is the last id: still filling');
  assert.strictEqual(isComplete(bucket, to - 10), false, 'newest is inside the block');
});

test('a long-closed client jumps to the present instead of walking back', () => {
  const { bucketsToFetch, bucketOf } = B;
  const newest = 96_000_000;
  const weekAgo = newest - 300_000;          // far outside the relevance window
  const got = bucketsToFetch(weekAgo, newest, 4);
  assert.strictEqual(got.length, 4, 'capped');
  assert.strictEqual(got[got.length - 1], bucketOf(newest), 'ends at the present');
  assert.ok(got[0] > bucketOf(weekAgo), 'and does not start where it left off');
});

test('a caught-up client asks for nothing new', () => {
  const { bucketsToFetch, bucketRange } = B;
  const bucket = 500;
  const { from } = bucketRange(bucket);
  assert.deepStrictEqual(bucketsToFetch(from, from, 4), [bucket],
    'the block it is already in, to pick up anything added since');
});

test('blocks come back oldest first, so kills stay in order', () => {
  const { bucketsToFetch } = B;
  const got = bucketsToFetch(96_000_000, 96_000_400, 10);
  assert.ok(got.length > 1);
  for (let i = 1; i < got.length; i++) {
    assert.strictEqual(got[i], got[i - 1] + 1, 'contiguous and ascending');
  }
});

test('nonsense input yields nothing rather than throwing', () => {
  const { bucketOf, bucketRange, bucketsToFetch, isComplete } = B;
  for (const bad of [undefined, null, NaN, -1, 'abc']) {
    assert.strictEqual(bucketOf(bad), null, String(bad));
    assert.strictEqual(bucketRange(bad), null, String(bad));
  }
  assert.deepStrictEqual(bucketsToFetch(undefined, 100), []);
  assert.deepStrictEqual(bucketsToFetch(100, undefined), []);
  assert.deepStrictEqual(bucketsToFetch(500, 100), [], 'newest behind the cursor');
  assert.strictEqual(isComplete(undefined, 100), false);
});
