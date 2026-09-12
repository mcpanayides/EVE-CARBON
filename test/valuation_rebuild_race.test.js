'use strict';
//
// Two rebuilds must never materialise the valuation at the same time.
//
// This is a real crash, reported from a terminal:
//
//   [valuation] startup refresh failed:
//   SQLITE_CONSTRAINT: UNIQUE constraint failed: asset_value.item_id
//
// Every rebuild path ends in the same two statements — DELETE FROM asset_value,
// then INSERT the whole thing back. Interleave two of them and you get
//
//     DELETE(A)  DELETE(B)  INSERT(A)  INSERT(B)
//
// where B's insert lands on the rows A just wrote. The transaction inside
// rebuildAssetValues does not save it: both run on ONE shared sqlite
// connection, so they share the transaction rather than being isolated by it.
//
// The debounced path had a `running` flag, but it guarded only itself — the
// startup price refresh and both IPC entry points went straight past it. So
// this is a cold-start race, most likely to fire exactly when the app opens and
// a character sync lands inside the twenty-second startup refresh.
//
// The fake database below records statement order rather than executing
// anything, because the ORDER is the whole bug; a real sqlite file would prove
// the constraint fires but not that the fix is the serialisation.
const test   = require('node:test');
const assert = require('node:assert');

const { registerValuationHandlers } = require('../src/ipc/valuation_ipc');

/** Which of the statements we care about, if any, this SQL is. */
function tag(sql) {
  const s = String(sql).replace(/\s+/g, ' ').trim().toUpperCase();
  if (s.startsWith('DELETE FROM ASSET_VALUE')) return 'DELETE';
  if (s.startsWith('INSERT INTO ASSET_VALUE')) return 'INSERT';
  return null;
}

// A tick between statements is what lets two rebuilds interleave at all. Without
// it each one would run to completion synchronously and the bug would hide.
const tick = () => new Promise(r => setImmediate(r));

function fakeDb(log) {
  return {
    async exec(sql) {
      const t = tag(sql);
      if (t) log.push(t);
      await tick();
    },
    async all(sql) {
      await tick();
      // rebuildAssetValues asks sqlite_master which character asset tables
      // exist; everything else is happy with nothing.
      return /SQLITE_MASTER/i.test(String(sql)) ? [{ name: 'char_1_assets' }] : [];
    },
    async get(sql) {
      await tick();
      // type_prices must be non-zero or rebuildFromLocalData escalates to a
      // full network refresh instead of materialising.
      return /TYPE_PRICES/i.test(String(sql)) ? { c: 1 } : { c: 0, n: 0 };
    },
    async run() { await tick(); },
  };
}

function harness(log) {
  const db = fakeDb(log);
  return registerValuationHandlers({
    ipcHandle: () => {},
    getCharDb: () => db,
    charInfoDb: { getCharacterAssets: async () => [] },
    httpGet: async () => [],
    fetchHubPrices: async () => ({}),
    fetchTypeMetadata: async () => ({}),
    loadDB: () => ({ accounts: {} }),
    esiBase: 'https://esi.example.invalid',
  });
}

/** Every DELETE must be immediately followed by its own INSERT. */
function assertPaired(log, why) {
  assert.ok(log.length >= 2, `${why}: expected some work, got ${JSON.stringify(log)}`);
  assert.strictEqual(log.length % 2, 0, `${why}: unpaired statements ${JSON.stringify(log)}`);
  for (let i = 0; i < log.length; i += 2) {
    assert.strictEqual(log[i], 'DELETE', `${why}: expected DELETE at ${i} in ${JSON.stringify(log)}`);
    assert.strictEqual(log[i + 1], 'INSERT', `${why}: expected INSERT at ${i + 1} in ${JSON.stringify(log)}`);
  }
}

test('two concurrent rebuilds do not interleave their DELETE and INSERT', async () => {
  const log = [];
  const api = harness(log);

  // Fired together, exactly as the startup refresh and a post-sync rebuild do.
  await Promise.all([
    api.rebuildFromLocalData({ allowPriceFetch: false }),
    api.rebuildFromLocalData({ allowPriceFetch: false }),
  ]);

  // Unserialised this logs DELETE,DELETE,INSERT,INSERT — the second INSERT
  // landing on the first's rows is the reported UNIQUE constraint failure.
  assertPaired(log, 'two concurrent rebuilds');
});

test('a crowd of rebuilds still runs strictly one at a time', async () => {
  const log = [];
  const api = harness(log);
  await Promise.all(Array.from({ length: 6 },
    () => api.rebuildFromLocalData({ allowPriceFetch: false })));
  assertPaired(log, 'six concurrent rebuilds');
  assert.strictEqual(log.length, 12);
});

test('a failed rebuild does not poison the ones behind it', async () => {
  // The queue is a promise chain. If a rejection were allowed to propagate down
  // it, one bad rebuild would take every later rebuild with it and the
  // valuation would stay stale until the app restarted.
  const log = [];
  let failNext = true;
  const db = fakeDb(log);
  const original = db.exec.bind(db);
  db.exec = async (sql) => {
    if (failNext && tag(sql) === 'INSERT') { failNext = false; throw new Error('disk I/O error'); }
    return original(sql);
  };

  const api = registerValuationHandlers({
    ipcHandle: () => {},
    getCharDb: () => db,
    charInfoDb: { getCharacterAssets: async () => [] },
    httpGet: async () => [],
    fetchHubPrices: async () => ({}),
    fetchTypeMetadata: async () => ({}),
    loadDB: () => ({ accounts: {} }),
    esiBase: 'https://esi.example.invalid',
  });

  const results = await Promise.allSettled([
    api.rebuildFromLocalData({ allowPriceFetch: false }),
    api.rebuildFromLocalData({ allowPriceFetch: false }),
  ]);
  assert.strictEqual(results[0].status, 'rejected', 'the first one really did fail');
  assert.strictEqual(results[1].status, 'fulfilled', 'the second must still run');
});

test('the escalation to a full refresh does not deadlock on its own lock', async () => {
  // rebuildFromLocalData escalates to refreshValuation when no prices exist,
  // and refreshValuation calls straight back into rebuildFromLocalData. If the
  // lock were taken around the whole function rather than around the writing
  // half, that inner call would wait forever on a lock its own caller holds —
  // and the valuation would simply never appear, with nothing logged.
  const log = [];
  const db = fakeDb(log);
  db.get = async (sql) => {
    await tick();
    // No prices on disk: force the escalation path.
    return /TYPE_PRICES/i.test(String(sql)) ? { c: 0 } : { c: 0, n: 0 };
  };

  const api = registerValuationHandlers({
    ipcHandle: () => {},
    getCharDb: () => db,
    charInfoDb: { getCharacterAssets: async () => [] },
    httpGet: async () => [],
    fetchHubPrices: async () => ({}),
    fetchTypeMetadata: async () => ({}),
    loadDB: () => ({ accounts: {} }),
    esiBase: 'https://esi.example.invalid',
  });

  const done = await Promise.race([
    api.rebuildFromLocalData().then(() => 'returned'),
    new Promise(r => setTimeout(() => r('DEADLOCK'), 2_000)),
  ]);
  assert.strictEqual(done, 'returned');
});
