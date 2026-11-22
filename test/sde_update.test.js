'use strict';
// The SDE update, where it is saved, and clearing up after the ones that hung.
//
// Up to 4.1.3 an update on an all-users install (Program Files) never finished
// and never failed: the database was built beside the bundled one, sqlite could
// not open the file, and nothing was listening for that. The card sat on "Step 1
// of 16" and each launch left 650 MB in the temp folder. These pin each half:
// what cannot be written is an error, updates go somewhere that can be, and only
// our own old folders are ever removed.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const https  = require('https');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const sqlite3 = require('sqlite3');
const yazl    = require('yazl');

const { buildSdeFromJsonl } = require('../src/sde_build');
const { fetchAndBuildSde }  = require('../src/sde_fetch');
const { createSdeStore, inspectSde } = require('../src/sde_store');
const { findLeftovers, removeLeftovers } = require('../src/sde_cleanup');
const { runWithWatchdog } = require('../src/sde_watchdog');

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-sde-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return d;
};
/** Fail rather than hang: the bug under test was a promise that never settled. */
const within = (ms, p) => {
  let timer;
  const hung = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('HUNG')), ms); });
  return Promise.race([p, hung]).finally(() => clearTimeout(timer));
};

/** Every file the build reads, empty but for one type. */
function jsonl(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'sde_build.js'), 'utf8');
  for (const [, name] of src.matchAll(/f\('([a-zA-Z0-9]+\.jsonl)'\)/g)) fs.writeFileSync(path.join(dir, name), '');
  fs.writeFileSync(path.join(dir, 'types.jsonl'), '{"_key":34,"groupID":18,"name":{"en":"Tritanium"},"published":true}\n');
  return dir;
}
function makeDb(file, { schema = true, types = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Promise((res, rej) => {
    const db = new sqlite3.Database(file);
    db.exec(`CREATE TABLE invTypes (typeID INTEGER); ${types ? 'INSERT INTO invTypes VALUES (34);' : ''}
             ${schema ? 'CREATE TABLE dgmEffectModifiers (effectID INTEGER);' : ''}`,
      (e) => db.close(() => (e ? rej(e) : res(file))));
  });
}

// ── Building ────────────────────────────────────────────────────────────────
test('a destination that cannot be opened is an error, not a hang', async (t) => {
  const d = tmp(t);
  const out = path.join(d, 'taken');
  fs.mkdirSync(out);                                   // a folder where the file should go
  fs.writeFileSync(path.join(out, 'x'), '');           // (so it can't be unlinked either)
  await assert.rejects(within(10000, buildSdeFromJsonl(jsonl(path.join(d, 'j')), out)), /Can't write to/);
});

test('a missing source file is an error, not a hang, and leaves nothing half-written', async (t) => {
  const d = tmp(t);
  const dir = jsonl(path.join(d, 'j'));
  fs.unlinkSync(path.join(dir, 'blueprints.jsonl'));
  const out = path.join(d, 'sde.sql');
  await assert.rejects(within(10000, buildSdeFromJsonl(dir, out)), /ENOENT.*blueprints/);
  assert.strictEqual(fs.existsSync(out), false);
});

test('a good build passes inspection and reports that it is alive', async (t) => {
  const d = tmp(t);
  const dir = jsonl(path.join(d, 'j'));
  const many = Array.from({ length: 12000 }, (_, i) => JSON.stringify({ _key: i + 1, groupID: 18, name: { en: `T${i}` } }));
  fs.writeFileSync(path.join(dir, 'types.jsonl'), many.join('\n'));
  let ticks = 0;
  await buildSdeFromJsonl(dir, path.join(d, 'sde.sql'), () => {}, () => { ticks++; });
  assert.ok(ticks > 5, `a long file ticks as it goes (${ticks})`);
  assert.deepStrictEqual(await inspectSde(path.join(d, 'sde.sql')), { ok: true, schemaOk: true });
});

// ── The whole update, with CCP's server faked ───────────────────────────────
function fakeCcp(t, { zip = null, build = 900 } = {}) {
  const asked = [];
  const real = https.get;
  https.get = (url, _opts, cb) => {
    asked.push(url);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    const isManifest = /latest\.jsonl$/.test(url);
    const body = isManifest ? Buffer.from(`{"_key":"sde","buildNumber":${build},"releaseDate":"x"}\n`) : fs.readFileSync(zip);
    const res = Readable.from([body], { objectMode: false });
    res.statusCode = 200;
    res.headers = { 'content-length': String(body.length) };
    setImmediate(() => cb(res));
    return req;
  };
  t.after(() => { https.get = real; });
  return asked;
}
function zipOf(dir, out) {
  return new Promise((res) => {
    const z = new yazl.ZipFile();
    for (const n of fs.readdirSync(dir)) z.addFile(path.join(dir, n), n);
    z.outputStream.pipe(fs.createWriteStream(out)).on('close', () => res(out));
    z.end();
  });
}
const tempFolders = () => new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('eve-carbon-sde-')));

test('a folder that cannot be written fails before the download, says which, and cleans up', async (t) => {
  const d = tmp(t);
  const asked = fakeCcp(t);
  const before = tempFolders();
  const blocker = path.join(d, 'file');
  fs.writeFileSync(blocker, '');                       // a file where the folder should be
  await assert.rejects(
    within(10000, fetchAndBuildSde({ userAgent: 'x', outSqlitePath: (b) => path.join(blocker, `sde-${b}.sql`) })),
    (e) => /Can't write to/.test(e.message) && e.message.includes(blocker));
  assert.strictEqual(asked.filter(u => /\.zip$/.test(u)).length, 0, 'the 95 MB were never asked for');
  assert.deepStrictEqual([...tempFolders()].filter(n => !before.has(n)), [], 'no temp folder left');
});

test('an update lands under its build number, with nothing left beside it', async (t) => {
  const d = tmp(t);
  fakeCcp(t, { zip: await zipOf(jsonl(path.join(d, 'j')), path.join(d, 'sde.zip')) });
  const before = tempFolders();
  const dir = path.join(d, 'user', 'sde');
  const store = createSdeStore({ bundledDir: path.join(d, 'app'), userDir: dir });
  const phases = new Set();
  const m = await within(30000, fetchAndBuildSde({
    userAgent: 'x', outSqlitePath: (b) => store.targetFor(b), onProgress: (_s, _p, i) => phases.add(i.phase),
  }));
  assert.strictEqual(m.buildNumber, 900);
  assert.deepStrictEqual(fs.readdirSync(dir), ['sde-900.sql']);
  assert.deepStrictEqual([...phases], ['check', 'download', 'extract', 'build', 'finish', 'done']);
  assert.strictEqual((await store.pick()).build, 900);
  assert.deepStrictEqual([...tempFolders()].filter(n => !before.has(n)), []);
});

test('an update while the old copy is open does not touch it', async (t) => {
  // Windows won't rename over an open file; the old code copied over it instead.
  const d = tmp(t);
  fakeCcp(t, { zip: await zipOf(jsonl(path.join(d, 'j')), path.join(d, 'sde.zip')), build: 901 });
  const dir = path.join(d, 'sde');
  const store = createSdeStore({ bundledDir: path.join(d, 'app'), userDir: dir });
  const old = await makeDb(store.targetFor(900));
  const bytes = fs.readFileSync(old);
  const open = await new Promise((res) => { const db = new sqlite3.Database(old, sqlite3.OPEN_READONLY, () => res(db)); });
  await fetchAndBuildSde({ userAgent: 'x', outSqlitePath: (b) => store.targetFor(b) });
  assert.ok(bytes.equals(fs.readFileSync(old)));
  await new Promise(r => open.close(r));
  assert.strictEqual((await store.pick()).build, 901, 'the next launch takes the new one');
});

// ── Which one is used ───────────────────────────────────────────────────────
async function storeWith(t, { bundled = null, user = [], bundledSchema = true } = {}) {
  const d = tmp(t);
  const bundledDir = path.join(d, 'app'), userDir = path.join(d, 'user');
  if (bundled) {
    await makeDb(path.join(bundledDir, 'sde.sql'), { schema: bundledSchema });
    fs.writeFileSync(path.join(bundledDir, 'sde.md5'), `${bundled}\n`);
  }
  for (const [build, opts] of user) await makeDb(path.join(userDir, `sde-${build}.sql`), opts);
  return { store: createSdeStore({ bundledDir, userDir }), userDir, bundledDir };
}

test('the newer of the shipped and the updated one is used', async (t) => {
  assert.strictEqual((await (await storeWith(t, { bundled: 100, user: [[200]] })).store.pick()).source, 'user');
  assert.strictEqual((await (await storeWith(t, { bundled: 300, user: [[200]] })).store.pick()).source, 'bundled', 'a new release outranks an old update');
  assert.strictEqual((await (await storeWith(t, { bundled: 200, user: [[200]] })).store.pick()).source, 'bundled', 'a tie needs no second copy');
  assert.strictEqual((await (await storeWith(t, { bundled: 9, user: [[10]] })).store.pick()).build, 10, 'numbers, not text');
  assert.strictEqual(await (await storeWith(t)).store.pick(), null);
});

test('a broken, empty or old-schema copy never beats a sound one', async (t) => {
  const { store, userDir } = await storeWith(t, { bundled: 100, user: [[200, { schema: false }], [300, { types: false }]] });
  fs.writeFileSync(path.join(userDir, 'sde-400.sql'), 'not a database at all');
  const p = await store.pick();
  assert.strictEqual(p.source, 'bundled');
  // With nothing better, an old schema still opens: most of the app works on it.
  const only = await storeWith(t, { bundled: 100, bundledSchema: false });
  const q = await only.store.pick();
  assert.strictEqual(q.source, 'bundled');
  assert.strictEqual(q.schemaOk, false);
});

test('superseded copies and old half-written ones are tidied; nothing else is', async (t) => {
  const { store, userDir } = await storeWith(t, { bundled: 100, user: [[200], [300]] });
  const old = new Date(Date.now() - 2 * 3600e3);
  for (const n of ['sde-400.sql.12-abc.tmp', 'sde-400.sql.12-abc.tmp-journal']) {
    fs.writeFileSync(path.join(userDir, n), ''); fs.utimesSync(path.join(userDir, n), old, old);
  }
  fs.writeFileSync(path.join(userDir, 'sde-401.sql.13-def.tmp'), '');   // being written now
  fs.writeFileSync(path.join(userDir, 'notes.txt'), '');
  store.tidy((await store.pick()).path);
  assert.deepStrictEqual(fs.readdirSync(userDir).sort(), ['notes.txt', 'sde-300.sql', 'sde-401.sql.13-def.tmp']);
});

test('a dev checkout keeps reading and writing data/', async (t) => {
  const d = tmp(t);
  const store = createSdeStore({ bundledDir: d });
  assert.strictEqual(store.targetFor(5), path.join(d, 'sde.sql'));
  store.recordBuild(5);
  assert.strictEqual(fs.readFileSync(path.join(d, 'sde.md5'), 'utf8'), '5');
  await makeDb(path.join(d, 'sde.sql'));
  assert.deepStrictEqual(store.tidy(path.join(d, 'sde.sql')), []);
  assert.strictEqual((await store.pick()).build, 5);
});

// ── Clearing up ─────────────────────────────────────────────────────────────
function leftover(root, name, { ageH = 3, bytes = 1000 } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'jsonl'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jsonl', 'types.jsonl'), Buffer.alloc(bytes));
  const when = new Date(Date.now() - ageH * 3600e3);
  for (const p of [path.join(dir, 'jsonl', 'types.jsonl'), path.join(dir, 'jsonl'), dir]) fs.utimesSync(p, when, when);
  return dir;
}

test('only our own old folders are found', async (t) => {
  const root = tmp(t);
  leftover(root, 'eve-carbon-sde-aB3xY9', { bytes: 5000 });
  leftover(root, 'eve-carbon-sde-zzzzzz', { bytes: 700 });
  // Not ours, or not old enough:
  leftover(root, 'eve-carbon-sde-NOW123', { ageH: 0.2 });      // another copy may be using it
  leftover(root, 'eve-carbon-e2e-aB3xY9');
  leftover(root, 'eve-carbon-sde-');
  leftover(root, 'eve-carbon-sde-aB3xY9-mine');
  leftover(root, 'someone-elses');
  fs.writeFileSync(path.join(root, 'eve-carbon-sde-aFile1'), 'a file, not a folder');
  const found = await findLeftovers({ tmpDir: root });
  assert.deepStrictEqual(found.map(f => [path.basename(f.path), f.bytes]).sort(), [['eve-carbon-sde-aB3xY9', 5000], ['eve-carbon-sde-zzzzzz', 700]]);
});

test('a folder still being written inside is left alone, however old it is', async (t) => {
  const root = tmp(t);
  const dir = leftover(root, 'eve-carbon-sde-busy01', { ageH: 48 });
  fs.writeFileSync(path.join(dir, 'jsonl', 'new.jsonl'), 'x');
  const old = new Date(Date.now() - 48 * 3600e3);
  fs.utimesSync(path.join(dir, 'jsonl'), old, old);
  assert.deepStrictEqual(await findLeftovers({ tmpDir: root }), []);
});

test('removing reports progress and what came back, and touches nothing else', async (t) => {
  const root = tmp(t);
  leftover(root, 'eve-carbon-sde-aaaaaa', { bytes: 100 });
  leftover(root, 'eve-carbon-sde-bbbbbb', { bytes: 200 });
  leftover(root, 'keep-me');
  const seen = [];
  const r = await removeLeftovers(await findLeftovers({ tmpDir: root }), (p) => seen.push(p.done));
  assert.deepStrictEqual(r, { removed: 2, failed: 0, freed: 300, bytes: 300 });
  assert.deepStrictEqual(seen, [1, 2]);
  assert.deepStrictEqual(fs.readdirSync(root), ['keep-me']);
});

test('a link wearing the name is never followed or removed', async (t) => {
  const root = tmp(t), precious = tmp(t);
  fs.writeFileSync(path.join(precious, 'keep.txt'), 'x');
  const link = path.join(root, 'eve-carbon-sde-link01');
  fs.symlinkSync(precious, link, 'junction');
  assert.deepStrictEqual(await findLeftovers({ tmpDir: root, minAgeMs: 0 }), []);
  const r = await removeLeftovers([{ path: link, bytes: 1 }]);      // even if it were listed
  assert.strictEqual(r.removed, 0);
  assert.ok(fs.existsSync(path.join(precious, 'keep.txt')));
});

test('removal refuses a path that is not one of ours', async (t) => {
  const root = tmp(t);
  const dir = leftover(root, 'documents');
  assert.deepStrictEqual(await removeLeftovers([{ path: dir, bytes: 1 }]), { removed: 0, failed: 1, freed: 0, bytes: 1 });
  assert.ok(fs.existsSync(dir));
});

// ── The watchdog ────────────────────────────────────────────────────────────
test('a job that goes silent is ended with an error that says so', async () => {
  await assert.rejects(within(3000, runWithWatchdog(() => new Promise(() => {}), { stallMs: 60, tickMs: 20 })), /with no progress/);
});

test('a slow job that keeps reporting is left to finish', async () => {
  const r = await runWithWatchdog(async (alive) => {
    for (let i = 0; i < 12; i++) { await new Promise(res => setTimeout(res, 20)); alive(); }
    return 'done';
  }, { stallMs: 120, tickMs: 20 });
  assert.strictEqual(r, 'done');
});

test('a job\'s own error comes through as it is', async () => {
  await assert.rejects(runWithWatchdog(async () => { throw new Error('HTTP 503'); }), /^Error: HTTP 503$/);
});
