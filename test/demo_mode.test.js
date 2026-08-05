'use strict';
//
// Demo mode's flag parsing, isolated from Electron.
//
// The stake here is higher than it looks. isEnabled() gates a path that WIPES
// files and seeds fake characters; a false positive on a normal launch would
// delete a real profile. So the interesting tests are the negative ones —
// everything that must NOT read as a demo launch.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const demo   = require('../src/demo_mode');

// isEnabled() reads process.argv/env live, so each case swaps them and restores.
function withArgv(argv, env, fn) {
  const oldArgv = process.argv;
  const oldDemo = process.env.EVE_CARBON_DEMO;
  const oldKeep = process.env.EVE_CARBON_DEMO_KEEP;
  const oldSize = process.env.EVE_CARBON_DEMO_SIZE;
  process.argv = ['electron', '.', ...argv];
  for (const k of ['EVE_CARBON_DEMO', 'EVE_CARBON_DEMO_KEEP', 'EVE_CARBON_DEMO_SIZE']) delete process.env[k];
  Object.assign(process.env, env || {});
  try { return fn(); }
  finally {
    process.argv = oldArgv;
    if (oldDemo === undefined) delete process.env.EVE_CARBON_DEMO; else process.env.EVE_CARBON_DEMO = oldDemo;
    if (oldKeep === undefined) delete process.env.EVE_CARBON_DEMO_KEEP; else process.env.EVE_CARBON_DEMO_KEEP = oldKeep;
    if (oldSize === undefined) delete process.env.EVE_CARBON_DEMO_SIZE; else process.env.EVE_CARBON_DEMO_SIZE = oldSize;
  }
}

test('a normal launch is never a demo launch', () => {
  // Each of these has been a real argv in this repo. None may trip demo mode,
  // because demo mode deletes the profile it points at.
  const REAL_LAUNCHES = [
    [],
    ['--user-data-dir=C:\\tmp\\profile'],
    ['--enable-logging'],
    ['--remote-debugging-port=9222'],
    ['--inspect'],
  ];
  for (const argv of REAL_LAUNCHES) {
    assert.strictEqual(withArgv(argv, {}, demo.isEnabled), false, `argv ${JSON.stringify(argv)} must not enable demo mode`);
  }
});

test('a flag that merely CONTAINS --demo does not count', () => {
  // Substring matching here would be a live grenade: --demolish-nothing, or a
  // path like /home/demo/app, must not wipe a profile.
  assert.strictEqual(withArgv(['--demolish'], {}, demo.isEnabled), false);
  assert.strictEqual(withArgv(['/home/demo/eve-carbon'], {}, demo.isEnabled), false);
  assert.strictEqual(withArgv(['--user-data-dir=/opt/demo'], {}, demo.isEnabled), false);
});

test('--demo and EVE_CARBON_DEMO both enable it', () => {
  assert.strictEqual(withArgv(['--demo'], {}, demo.isEnabled), true);
  assert.strictEqual(withArgv([], { EVE_CARBON_DEMO: '1' }, demo.isEnabled), true);
  assert.strictEqual(withArgv([], { EVE_CARBON_DEMO: 'true' }, demo.isEnabled), true);
  // An env var explicitly set to off must stay off.
  assert.strictEqual(withArgv([], { EVE_CARBON_DEMO: '0' }, demo.isEnabled), false);
  assert.strictEqual(withArgv([], { EVE_CARBON_DEMO: '' }, demo.isEnabled), false);
});

test('--demo-keep preserves the profile', () => {
  assert.strictEqual(withArgv(['--demo'], {}, demo.shouldKeep), false, 'default is a clean rebuild');
  assert.strictEqual(withArgv(['--demo', '--demo-keep'], {}, demo.shouldKeep), true);
  assert.strictEqual(withArgv(['--demo'], { EVE_CARBON_DEMO_KEEP: '1' }, demo.shouldKeep), true);
});

test('--demo-size parses, and falls back rather than producing a broken window', () => {
  assert.deepStrictEqual(withArgv(['--demo', '--demo-size=1920x1080'], {}, demo.windowSize), { width: 1920, height: 1080 });
  assert.deepStrictEqual(withArgv(['--demo'], { EVE_CARBON_DEMO_SIZE: '1280x720' }, demo.windowSize), { width: 1280, height: 720 });
  // Garbage must yield the default, not NaN — a NaN width creates a window you
  // cannot see or close.
  for (const bad of ['', 'big', '1920', '1920X1080y', 'x', '-100x-100', '12x12']) {
    const s = withArgv(['--demo', `--demo-size=${bad}`], {}, demo.windowSize);
    assert.deepStrictEqual(s, demo.DEFAULT_SIZE, `"${bad}" should fall back to the default`);
    assert.ok(Number.isFinite(s.width) && s.width > 0, `"${bad}" produced a bad width`);
  }
});

test('windowOptions leaves a normal launch completely alone', () => {
  const base = { width: 1800, height: 1200, minWidth: 900 };
  const out  = withArgv([], {}, () => demo.windowOptions(base));
  assert.strictEqual(out, base, 'must be the same object, not a copy, when not in demo mode');
});

test('windowOptions overrides size but keeps everything else', () => {
  const base = { width: 1800, height: 1200, minWidth: 900, webPreferences: { sandbox: true } };
  const out  = withArgv(['--demo', '--demo-size=1280x720'], {}, () => demo.windowOptions(base));
  assert.strictEqual(out.width, 1280);
  assert.strictEqual(out.height, 720);
  assert.strictEqual(out.minWidth, 900, 'unrelated options must survive');
  assert.deepStrictEqual(out.webPreferences, { sandbox: true });
});

test('redirectPaths does nothing at all on a normal launch', () => {
  // The guard that keeps a normal launch from ever being pointed at the demo
  // profile. If this returned paths, main.js would also run reset() and delete.
  // setPath must never fire; getPath is expected (it captures the real profile).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-none-'));
  const fakeApp = { getPath: () => dir, setPath: () => { throw new Error('setPath must not be called'); } };
  assert.strictEqual(withArgv([], {}, () => freshDemo().redirectPaths(fakeApp)), null);
});

// ── The Settings toggle ───────────────────────────────────────────────────────
// Each of these needs its own module instance: demo_mode caches the real
// userData path on first use (deliberately — see the comment there), and a
// cached path from a previous test would defeat the point of the next one.
function freshDemo() {
  delete require.cache[require.resolve('../src/demo_mode')];
  return require('../src/demo_mode');
}

function tempProfile(configApp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-cfg-'));
  if (configApp) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ app: configApp }));
  return dir;
}

test('the persisted toggle enables demo mode with no flag present', () => {
  const dir = tempProfile({ demoMode: true });
  const d   = freshDemo();
  assert.strictEqual(withArgv([], {}, () => d.isEnabled({ getPath: () => dir })), true);
});

test('a config without the toggle, or with it off, is not a demo launch', () => {
  for (const cfg of [undefined, {}, { demoMode: false }, { theme: 'Default' }]) {
    const dir = tempProfile(cfg);
    const d   = freshDemo();
    assert.strictEqual(withArgv([], {}, () => d.isEnabled({ getPath: () => dir })), false,
      `config ${JSON.stringify(cfg)} must not enable demo mode`);
  }
});

test('a corrupt config is not a demo launch', () => {
  // Malformed JSON must fail closed. Failing open would wipe a real profile.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-bad-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');
  const d = freshDemo();
  assert.strictEqual(withArgv([], {}, () => d.isEnabled({ getPath: () => dir })), false);
});

test('setEnabled preserves the rest of the config', () => {
  const dir = tempProfile({ theme: 'Nebula', minimizeToTray: true });
  const d   = freshDemo();
  d.setEnabled({ getPath: () => dir }, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.app.demoMode, true);
  assert.strictEqual(cfg.app.theme, 'Nebula', 'unrelated settings must survive');
  assert.strictEqual(cfg.app.minimizeToTray, true);
});

test('turning demo mode OFF from inside demo mode writes the REAL config', () => {
  // The trap this whole design exists to avoid. Once redirectPaths() has run,
  // app.getPath('userData') answers with the DEMO directory — which is wiped on
  // every launch. A toggle that wrote there would look like it worked, lose the
  // change on restart, and strand the app in demo mode with no way out.
  const realDir = tempProfile({ demoMode: true, theme: 'Nebula' });
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-profile-'));

  // Simulate the real boot order: getPath returns the real profile until
  // setPath is called, then the demo one — exactly what Electron does.
  let current = realDir;
  const app = { getPath: () => current, setPath: (_k, v) => { current = v; } };

  const d = freshDemo();
  withArgv([], {}, () => {
    const paths = d.redirectPaths(app);
    assert.ok(paths, 'config said demoMode:true, so this must be a demo launch');
    assert.notStrictEqual(app.getPath('userData'), realDir, 'userData must now point at the demo profile');

    // Now the user flips the switch off from inside the running demo.
    d.setEnabled(app, false);
  });

  const realCfg = JSON.parse(fs.readFileSync(path.join(realDir, 'config.json'), 'utf8'));
  assert.strictEqual(realCfg.app.demoMode, false, 'the REAL config must record the change');
  assert.strictEqual(realCfg.app.theme, 'Nebula', 'and keep everything else');
  assert.strictEqual(fs.existsSync(path.join(demoDir, 'config.json')), false,
    'nothing should have been written to the throwaway demo profile');

  // And the next launch must actually come back out of demo mode.
  const next = freshDemo();
  assert.strictEqual(withArgv([], {}, () => next.isEnabled({ getPath: () => realDir })), false,
    'after toggling off, a fresh launch must not be a demo launch');
});

test('the --demo flag outranks a config that says off', () => {
  // The UI greys the toggle out in this case; this is the behaviour it reports.
  const dir = tempProfile({ demoMode: false });
  const d   = freshDemo();
  assert.strictEqual(withArgv(['--demo'], {}, () => d.isEnabled({ getPath: () => dir })), true);
});
