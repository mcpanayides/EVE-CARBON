'use strict';
// What is cleared between versions (src/upkeep.js, the SDE store's stray files,
// the uninstaller), and what the package ships in the first place.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { runUpkeep } = require('../src/upkeep');
const { createSdeStore } = require('../src/sde_store');

const REPO = path.join(__dirname, '..');
const HOUR = 3600e3, DAY = 24 * HOUR;
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-upkeep-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function put(dir, name, { ageMs = 2 * HOUR, body = 'x' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(f, when, when);
  return f;
}
const ls = (d) => fs.readdirSync(d).sort();

test('installers the in-app update downloaded go; anyone else\'s stay', async (t) => {
  const d = tmp(t);
  put(d, 'EVE-Carbon-Setup-1762500000000.exe', { body: 'old installer' });
  put(d, 'EVE-Carbon-Setup-1762500000001.exe', { ageMs: 5 * 60e3 });   // may be running
  put(d, 'EVE-Carbon.Setup.4.1.3.exe');                                // downloaded by hand
  put(d, 'EVE-Carbon-Setup-notes.exe');
  put(d, 'Other-Setup-1762500000000.exe');
  fs.mkdirSync(path.join(d, 'EVE-Carbon-Setup-1762500000002.exe'));    // a folder wearing the name
  const r = await runUpkeep({ tmpDir: d });
  assert.strictEqual(r.files, 1);
  assert.strictEqual(r.bytes, 'old installer'.length);
  assert.strictEqual(fs.existsSync(path.join(d, 'EVE-Carbon-Setup-1762500000000.exe')), false);
  assert.strictEqual(ls(d).length, 5);
});

test('the pattern is the name updater_ipc.js really writes', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'ipc', 'updater_ipc.js'), 'utf8');
  assert.match(src, /`EVE-Carbon-Setup-\$\{Date\.now\(\)\}\.exe`/);
});

test('electron-builder\'s copy of the installer goes, and only that', async (t) => {
  const d = tmp(t);
  put(d, 'installer.exe');
  put(d, 'other.txt');
  await runUpkeep({ updaterDir: d });
  assert.deepStrictEqual(ls(d), ['other.txt']);
});

test('expired cache entries go; live ones, and files that are not entries, stay', async (t) => {
  const d = tmp(t), now = Date.now();
  put(d, 'hubprice_jita_34.json', { body: { ts: now - 2 * DAY, ttl: DAY, v: 5 } });
  put(d, 'loc_full_1.json', { body: { ts: now - 2 * DAY, ttl: 30 * DAY, v: {} } });
  put(d, 'null_value.json', { body: { ts: now - 2 * DAY, ttl: DAY, v: null } });
  put(d, 'settings.json', { ageMs: 400 * DAY, body: { theme: 'x' } });        // no expiry of its own
  put(d, 'broken.json', { ageMs: 400 * DAY, body: '{"ts":' });
  put(d, 'data_0', { ageMs: 400 * DAY });                                     // Chromium shares this folder on Windows
  const r = await runUpkeep({ cacheDir: d });
  assert.strictEqual(r.files, 2);
  assert.deepStrictEqual(ls(d), ['broken.json', 'data_0', 'loc_full_1.json', 'settings.json']);
});

test('an entry rewritten while upkeep looked at it is kept', async (t) => {
  const d = tmp(t), now = Date.now();
  const f = put(d, 'hubprice_jita_34.json', { body: { ts: now - 2 * DAY, ttl: DAY, v: 5 } });
  const real = fs.promises.readFile;
  t.after(() => { fs.promises.readFile = real; });
  fs.promises.readFile = async (...a) => {
    const out = await real(...a);
    fs.writeFileSync(f, JSON.stringify({ ts: Date.now(), ttl: DAY, v: 'fresh' }));
    return out;
  };
  const r = await runUpkeep({ cacheDir: d });
  assert.strictEqual(r.files, 0);
  assert.match(fs.readFileSync(f, 'utf8'), /fresh/);
});

test('ETags nothing has touched for a month go', async (t) => {
  const d = tmp(t);
  put(d, 'a'.repeat(40) + '.json', { ageMs: 31 * DAY });
  put(d, 'b'.repeat(40) + '.json', { ageMs: 5 * DAY });
  put(d, 'README.json', { ageMs: 400 * DAY });
  await runUpkeep({ etagDir: d });
  assert.deepStrictEqual(ls(d), ['README.json', 'b'.repeat(40) + '.json']);
});

test('places that are not there are no trouble', async (t) => {
  const none = path.join(tmp(t), 'nope');
  assert.strictEqual((await runUpkeep({ tmpDir: none, updaterDir: none, cacheDir: none, etagDir: none })).files, 0);
  assert.strictEqual((await runUpkeep({})).files, 0);
});

test('a cut-off update\'s file beside the shipped database goes; the database stays', (t) => {
  const d = tmp(t);
  put(d, 'sde.sql', { ageMs: 90 * DAY });
  put(d, 'sde.md5', { ageMs: 90 * DAY });
  put(d, 'sde.sql.tmp');
  put(d, 'sde.sql.tmp-journal');
  put(d, 'sde.sql.412-a1b2c3.tmp');
  put(d, 'sde.sql.413-a1b2c4.tmp', { ageMs: 60e3 });                   // being written now
  put(d, 'sde.sql.fuzzwork-backup', { ageMs: 90 * DAY });
  put(d, 'sde.sql.pre-nebula', { ageMs: 90 * DAY });
  put(d, 'character_information.db', { ageMs: 90 * DAY });
  const keep = ['character_information.db', 'sde.md5', 'sde.sql', 'sde.sql.413-a1b2c4.tmp', 'sde.sql.fuzzwork-backup', 'sde.sql.pre-nebula'];
  createSdeStore({ bundledDir: d, userDir: path.join(d, 'none') }).tidy(path.join(d, 'sde.sql'));
  assert.deepStrictEqual(ls(d), keep);
  createSdeStore({ bundledDir: d }).tidy(path.join(d, 'sde.sql'));     // a dev checkout
  assert.deepStrictEqual(ls(d), keep);
});

// ── What is shipped ─────────────────────────────────────────────────────────
const pkg = require('../package.json');
const shipped = pkg.build.files.filter(f => !f.startsWith('!'));

test('the package ships what the app loads, and lists it', () => {
  // It was "**/*": 111 MB of SDE packed a second time inside the app, with the
  // tests, the scripts and the documentation.
  assert.ok(!shipped.includes('**/*'), 'a list, not everything');
  for (const p of shipped) assert.ok(fs.existsSync(path.join(REPO, p.replace(/\/\*\*\/\*$/, ''))), `${p} exists`);
  for (const bad of ['data', 'test', 'e2e', 'scripts', 'img', 'graphify-out', 'dist']) {
    assert.ok(!shipped.some(f => f.split('/')[0] === bad), `${bad} is not shipped`);
  }
});

test('nothing but the SDE leaves the data folder', () => {
  // data/ is where a dev checkout keeps its own character database.
  const data = pkg.build.extraResources.find(r => r.from === 'data/');
  assert.deepStrictEqual(data.filter, ['sde.sql', 'sde.md5']);
});

test('everything main resolves beside itself is in the package', () => {
  // A path the list misses works in dev and is missing from every release.
  const top = shipped.map(f => f.split('/')[0]);
  const src = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
  const outside = new Set(['data', 'assets', '.env']);                 // in resources/ when packaged
  let seen = 0;
  for (const [, first] of src.matchAll(/path\.join\(__dirname,\s*'([^']+)'/g)) {
    seen++;
    assert.ok(outside.has(first) || top.includes(first), `main.js reads ${first}/, which is not shipped`);
  }
  for (const [, p] of src.matchAll(/require\('\.\/([^']+)'\)/g)) {
    seen++;
    assert.ok(top.includes(p.split('/')[0]), `main.js requires ./${p}, which is not shipped`);
  }
  assert.ok(seen > 30, 'the patterns still match main.js');
});

test('every runtime dependency is one the app requires', () => {
  const used = new Set();
  const scan = (file) => {
    for (const [, m] of fs.readFileSync(file, 'utf8').matchAll(/(?:require|import)\('([^.'][^']*)'\)/g)) {
      used.add(m.startsWith('@') ? m.split('/').slice(0, 2).join('/') : m.split('/')[0]);
    }
  };
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (e.name.endsWith('.js')) scan(p);
    }
  })(path.join(REPO, 'src'));
  scan(path.join(REPO, 'main.js'));
  assert.deepStrictEqual(Object.keys(pkg.dependencies).filter(d => !used.has(d)), [], 'dependencies nothing requires');
});

test('the uninstaller looks where the profile really is, and an update never asks', () => {
  const nsh = fs.readFileSync(path.join(REPO, 'build', 'installer.nsh'), 'utf8');
  assert.ok(nsh.includes(`RMDir /r "\${EC_ROAMING}\\${pkg.productName}"`), 'Electron names the profile from productName');
  assert.ok(nsh.includes('${ifNot} ${isUpdated}'));
  assert.ok(nsh.includes('/SD IDNO') && nsh.includes('MB_DEFBUTTON2'), '"No" is the default, silent or not');
  assert.ok(!/!macro customInstall\b/.test(nsh), 'installing asks nothing about your data');
});
