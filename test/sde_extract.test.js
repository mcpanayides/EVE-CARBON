'use strict';
//
// Safe zip extraction (src/sde_fetch.js).
//
// This code exists because extract-zip carries an unfixed high-severity
// path-traversal advisory (CVE-2026-56876) — it writes symlink entries without
// validating their targets, and 2.0.1 is both the latest release and the
// vulnerable one, so there was nothing to upgrade to.
//
// It is the boundary between an archive downloaded off the internet and the
// user's filesystem, so it is tested against archives built to attack it rather
// than trusted to code review. Every case below writes a real malicious zip and
// asserts nothing lands outside the destination.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const yazl   = require('yazl');

const { extractZipSafely, safeEntryPath } = require('../src/sde_fetch');

const S_IFLNK = 0o120000;

/**
 * Write a zip from [{ name, content, mode }] and return its path.
 *
 * yazl refuses to CREATE an entry called "../pwned.txt" — it validates the
 * metadata path on the way in. That is a good default for a writer and useless
 * for building an attack, so any name yazl rejects is written under a
 * placeholder of exactly the same byte length and patched afterwards. The
 * length has to match because a zip stores each filename twice (local header
 * and central directory) with a length field beside it.
 *
 * The result is a genuinely malformed archive of the kind an attacker would
 * send, rather than a mock of one.
 */
function makeZip(dir, entries) {
  const zipPath = path.join(dir, `evil-${Math.random().toString(36).slice(2)}.zip`);
  const zip = new yazl.ZipFile();
  const patches = [];

  for (const e of entries) {
    const opts = e.mode ? { mode: e.mode } : undefined;
    // Ask yazl for the real name and fall back to a placeholder only when it
    // objects. Predicting which names it rejects with a regex of my own just
    // reproduces its validation badly — and a name my regex missed silently
    // became a test that passed for the wrong reason.
    try {
      zip.addBuffer(Buffer.from(e.content ?? 'x'), e.name, opts);
    } catch (_) {
      const placeholder = 'Q'.repeat(Buffer.byteLength(e.name));
      patches.push([placeholder, e.name]);
      zip.addBuffer(Buffer.from(e.content ?? 'x'), placeholder, opts);
    }
  }
  zip.end();

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    zip.outputStream.pipe(out);
    out.on('error', reject);
    out.on('close', () => {
      try {
        if (patches.length) {
          let buf = fs.readFileSync(zipPath);
          for (const [placeholder, real] of patches) {
            const from = Buffer.from(placeholder), to = Buffer.from(real);
            assert.strictEqual(from.length, to.length, 'placeholder must match the real name in length');
            let i = 0, found = 0;
            while ((i = buf.indexOf(from, i)) !== -1) { to.copy(buf, i); i += to.length; found++; }
            assert.ok(found >= 2, `expected the filename twice in the archive, saw ${found}`);
          }
          fs.writeFileSync(zipPath, buf);
        }
        resolve(zipPath);
      } catch (e) { reject(e); }
    });
  });
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eve-carbon-zip-'));
}

// ── The path check on its own ────────────────────────────────────────────────

test('traversal, absolute and drive-letter paths are all refused', () => {
  const dest = path.join(os.tmpdir(), 'dest');
  for (const name of [
    '../escaped.txt',
    '../../../../etc/passwd',
    'a/../../b.txt',
    '/etc/passwd',
    'C:\\Windows\\System32\\evil.dll',
    '..\\..\\escaped.txt',          // backslashes normalised before the check
  ]) {
    const r = safeEntryPath(dest, name);
    assert.ok(r.error, `"${name}" should have been refused`);
    assert.strictEqual(r.full, undefined);
  }
});

test('ordinary nested paths are allowed', () => {
  const dest = path.join(os.tmpdir(), 'dest');
  for (const name of ['types.jsonl', 'sde/types.jsonl', 'a/b/c/d.jsonl', 'dots..in..name.jsonl']) {
    const r = safeEntryPath(dest, name);
    assert.ok(!r.error, `"${name}" should have been allowed, got ${r.error}`);
    assert.ok(r.full.startsWith(path.resolve(dest)));
  }
});

// ── Real archives ────────────────────────────────────────────────────────────

test('a normal archive extracts', async () => {
  const dir = tmp(), dest = path.join(dir, 'out');
  const zipPath = await makeZip(dir, [
    { name: 'types.jsonl', content: '{"a":1}' },
    { name: 'nested/groups.jsonl', content: '{"b":2}' },
  ]);
  await extractZipSafely(zipPath, dest);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'types.jsonl'), 'utf8'), '{"a":1}');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'nested', 'groups.jsonl'), 'utf8'), '{"b":2}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an entry that climbs out of the destination is refused', async () => {
  const dir = tmp(), dest = path.join(dir, 'out');
  const zipPath = await makeZip(dir, [{ name: '../pwned.txt', content: 'owned' }]);

  // Two layers refuse this and yauzl gets there first — it rejects a "../"
  // segment while reading the central directory, before safeEntryPath is
  // reached ("invalid relative path"). Worth knowing rather than assuming our
  // own message: it means traversal is blocked even where this code forgets to
  // check, and it is why safeEntryPath earns its place on the cases yauzl does
  // NOT cover — absolute paths, drive letters, and symlinks.
  //
  // So the assertion is on the outcome, not on whose error it is.
  await assert.rejects(() => extractZipSafely(zipPath, dest));
  assert.strictEqual(fs.existsSync(path.join(dir, 'pwned.txt')), false);
  assert.strictEqual(fs.existsSync(path.join(dest, 'pwned.txt')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a symlink entry is refused rather than written', async () => {
  // The exact shape of CVE-2026-56876: a link pointing outside the extraction
  // directory, which extract-zip would create and then happily write through.
  const dir = tmp(), dest = path.join(dir, 'out');
  const zipPath = await makeZip(dir, [
    { name: 'innocent.jsonl', content: '{}' },
    { name: 'link', content: '../../../../etc/passwd', mode: S_IFLNK | 0o777 },
  ]);
  await assert.rejects(() => extractZipSafely(zipPath, dest), /symlink/i);
  assert.strictEqual(fs.existsSync(path.join(dest, 'link')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a symlink pointing somewhere harmless is still refused', async () => {
  // No allow-list of "safe" link targets: the SDE archive is a flat set of
  // JSONL files and has no legitimate use for symlinks at all, so the rule is
  // simply that there are none.
  const dir = tmp(), dest = path.join(dir, 'out');
  const zipPath = await makeZip(dir, [{ name: 'link', content: 'innocent.jsonl', mode: S_IFLNK | 0o777 }]);
  await assert.rejects(() => extractZipSafely(zipPath, dest), /symlink/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one bad entry stops the extraction, even after good ones', async () => {
  const dir = tmp(), dest = path.join(dir, 'out');
  const zipPath = await makeZip(dir, [
    { name: 'first.jsonl', content: 'ok' },
    { name: '../../escaped.txt', content: 'owned' },
    { name: 'third.jsonl', content: 'ok' },
  ]);
  await assert.rejects(() => extractZipSafely(zipPath, dest));
  assert.strictEqual(fs.existsSync(path.join(path.dirname(dir), 'escaped.txt')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an absolute path inside the archive is refused', async () => {
  const dir = tmp(), dest = path.join(dir, 'out');
  const zipPath = await makeZip(dir, [{ name: '/tmp/eve-carbon-abs-probe.txt', content: 'owned' }]);
  await assert.rejects(() => extractZipSafely(zipPath, dest), /absolute|escapes|traversal/i);
  assert.strictEqual(fs.existsSync('/tmp/eve-carbon-abs-probe.txt'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt archive rejects instead of throwing raw', async () => {
  const dir = tmp(), dest = path.join(dir, 'out');
  const bad = path.join(dir, 'not-a.zip');
  fs.writeFileSync(bad, 'this is not a zip file');
  await assert.rejects(() => extractZipSafely(bad, dest));
  fs.rmSync(dir, { recursive: true, force: true });
});
