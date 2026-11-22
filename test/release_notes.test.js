'use strict';
// The release notes, and the workflow that publishes them. v4.1.4 came out with
// none: two jobs write to one release and only one of them carried the notes.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
const yaml   = require('js-yaml');
const { releaseNotes, releaseProblems } = require('../scripts/release-notes');
const { parseReleaseFlags } = require('../src/ipc/updater_ipc');

const REPO = path.join(__dirname, '..');
const LOG = '# Changelog\n\nIntro.\n\n---\n\n## [2.0.10] - b\n\nten\n\n## [2.0.1] - a\r\n\r\n> **CRITICAL UPDATE** — why\r\n\r\n- one\r\n';

test('a version gets its own section, and only that', () => {
  assert.deepStrictEqual(releaseNotes(LOG, '2.0.10'), { version: '2.0.10', text: '## [2.0.10] - b\n\nten\n' });
  const one = releaseNotes(LOG, '2.0.1');                // not 2.0.10
  assert.strictEqual(one.text, '## [2.0.1] - a\n\n> **CRITICAL UPDATE** — why\n\n- one\n');
  assert.strictEqual(parseReleaseFlags(one.text).critical, true, 'the critical flag survives');
});

test('a version with no section falls back to the newest', () => {
  assert.strictEqual(releaseNotes(LOG, '9.9.9').version, '2.0.10');
});

test('the current version has its own section', () => {
  const { version } = require('../package.json');
  assert.strictEqual(releaseNotes(fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8'), version).version, version);
});

test('what would be wrong with a published release is said', () => {
  const asset = (name, state = 'uploaded') => ({ name, state });
  const good = { body: 'notes\r\n', draft: false, prerelease: false, assets: [asset('a.exe'), asset('a.dmg')] };
  assert.deepStrictEqual(releaseProblems(good, 'notes\n'), []);
  assert.deepStrictEqual(releaseProblems({ ...good, body: null }, 'notes'), ['the release has no notes']);   // v4.1.4
  assert.deepStrictEqual(releaseProblems({ ...good, body: 'other' }, 'notes'), ['the release notes are not the changelog section']);
  assert.deepStrictEqual(releaseProblems({ ...good, assets: [asset('a.exe'), asset('a.dmg', 'starter')] }, 'notes'), ['no .dmg on the release']);
  assert.strictEqual(releaseProblems({ ...good, draft: true, prerelease: true }, 'notes').length, 2);
});

test('every job that publishes carries the notes, and the result is checked', () => {
  const { jobs } = yaml.load(fs.readFileSync(path.join(REPO, '.github', 'workflows', 'main.yml'), 'utf8'));
  const publishers = Object.entries(jobs).filter(([, j]) => j.steps.some(s => /action-gh-release/.test(s.uses || '')));
  assert.deepStrictEqual(publishers.map(([n]) => n), ['build-windows', 'build-mac']);
  for (const [name, job] of publishers) {
    const at = job.steps.findIndex(s => /action-gh-release/.test(s.uses || ''));
    assert.strictEqual(job.steps[at].with.body_path, 'RELEASE_NOTES.md', `${name} uploads the notes`);
    assert.ok(job.steps.slice(0, at).some(s => /release-notes\.js write .* RELEASE_NOTES\.md/.test(s.run || '')), `${name} writes them first`);
  }
  assert.deepStrictEqual(jobs['check-release'].needs, ['build-windows', 'build-mac']);
  assert.ok(jobs['check-release'].steps.some(s => /release-notes\.js check/.test(s.run || '')));
});
