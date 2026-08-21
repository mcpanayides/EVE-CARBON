'use strict';
// The hand-curated Modern-map layout must SHIP. It used to be written by an
// in-app editor into userData, so the curated galaxy existed on exactly one
// machine; every install anywhere else fell back to the algorithm and drew a
// visibly more spread-out map. Reported 2026-08-21 as "the map on my other
// computer is far more spaced out".
//
// The subtle half of that bug is the packaging, not the code: a file can exist
// locally, be picked up by a local build, and still be absent from every CI
// release. These tests assert the file is present, complete, AND reachable by
// a fresh clone.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');

const REPO   = path.join(__dirname, '..');
const REL    = path.join('src', 'data', 'modern-map-layout.json');
const LAYOUT = path.join(REPO, REL);

// _persistModernLayout refuses to cache anything smaller; k-space is ~5 250.
const MIN_SYSTEMS = 4000;

test('the curated modern-map layout ships with the app', () => {
  assert.ok(fs.existsSync(LAYOUT), `${REL} must exist — without it every install falls back to the algorithm`);
});

test('the shipped layout is a complete galaxy, not a partial build', () => {
  const j = JSON.parse(fs.readFileSync(LAYOUT, 'utf8'));
  const n = Object.keys(j.systems || {}).length;
  assert.ok(n >= MIN_SYSTEMS, `expected a full k-space layout, got ${n} systems`);
  assert.ok(Number(j.pitch) > 0, 'pitch drives the whole scale of the map');
  assert.ok(Array.isArray(j.labels) && j.labels.length > 0, 'region labels should be present');
  // Shape the renderer actually reads: id -> [x, z].
  for (const [id, xz] of Object.entries(j.systems).slice(0, 50)) {
    assert.ok(Number.isFinite(Number(id)), `system key ${id} should be a numeric id`);
    assert.ok(Array.isArray(xz) && xz.length === 2 && xz.every(Number.isFinite),
      `system ${id} should be [x, z], got ${JSON.stringify(xz)}`);
  }
});

test('the shipped layout is not gitignored', () => {
  // THE bug: .gitignore had an unanchored "data/", which git applies to a
  // directory of that name at ANY depth — so src/data/ was swallowed too. The
  // file would live on one machine, ship from a local build, and be missing
  // from every CI release. Exactly the failure this file exists to prevent.
  let ignored;
  try {
    execFileSync('git', ['check-ignore', '-q', REL], { cwd: REPO, stdio: 'ignore' });
    ignored = true;             // exit 0 = the path IS ignored
  } catch (e) {
    if (e.code === 'ENOENT') return;   // no git available — nothing to assert
    ignored = false;                   // exit 1 = not ignored, which is what we want
  }
  assert.strictEqual(ignored, false,
    `${REL} is gitignored, so it will be missing from CI builds even though it works locally`);
});

test('the SDE is still ignored — anchoring the pattern must not commit it', () => {
  // The counterpart guard: /data/ holds a ~115 MB SQLite build that must never
  // be committed. Loosening the ignore rule to free src/data/ must not free it.
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', path.join('data', 'sde.sql')], { cwd: REPO, stdio: 'ignore' });
    ignored = true;
  } catch (e) {
    if (e.code === 'ENOENT') return;
  }
  assert.strictEqual(ignored, true, 'data/sde.sql must stay ignored');
});
