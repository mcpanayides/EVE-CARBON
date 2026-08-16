'use strict';
//
// Marking a release critical.
//
// The release body IS the CHANGELOG section for that tag (the "Release notes"
// step in .github/workflows/main.yml extracts it), so this parser is the
// contract between what someone writes in CHANGELOG.md and whether users see a
// red banner. Getting it wrong fails in the worst direction: a release that
// needed to shout goes out looking routine, and nobody finds out until the
// support messages arrive.
//
// Both accepted forms are tested, and — more importantly — so are the ordinary
// release notes that must NOT trip it. This project ships changelogs that
// discuss crashes, data loss and security fixes in prose; if any of that read as
// critical, the flag would fire on nearly every release and mean nothing.
const test   = require('node:test');
const assert = require('node:assert');

const { parseReleaseFlags } = require('../src/ipc/updater_ipc');

// ── The machine-readable marker ──────────────────────────────────────────────

test('the HTML comment marks a release critical', () => {
  const r = parseReleaseFlags('Some notes\n<!-- eve-carbon:critical -->\nmore notes');
  assert.strictEqual(r.critical, true);
  assert.strictEqual(r.criticalReason, null);
});

test('the comment can carry a reason', () => {
  const r = parseReleaseFlags('<!-- eve-carbon:critical: assets are lost on upgrade from 3.2 -->');
  assert.strictEqual(r.critical, true);
  assert.strictEqual(r.criticalReason, 'assets are lost on upgrade from 3.2');
});

test('the comment is case- and space-tolerant', () => {
  for (const body of [
    '<!--eve-carbon:critical-->',
    '<!--   EVE-Carbon:Critical   -->',
    '<!-- eve-carbon:critical:   spaced out   -->',
  ]) {
    assert.strictEqual(parseReleaseFlags(body).critical, true, body);
  }
});

// ── The human form ───────────────────────────────────────────────────────────

test('a CRITICAL UPDATE line marks a release critical', () => {
  const r = parseReleaseFlags('## [4.0.0]\n\n> **CRITICAL UPDATE** — corrupts the asset index\n\nOther notes.');
  assert.strictEqual(r.critical, true);
  assert.strictEqual(r.criticalReason, 'corrupts the asset index');
});

test('markdown emphasis is stripped from the reason', () => {
  // The reason goes into textContent, so asterisks would be shown literally.
  const r = parseReleaseFlags('> **Critical update**: fixes `wallet` **data loss**');
  assert.strictEqual(r.criticalReason, 'fixes wallet data loss');
});

test('the word alone is enough, with or without "update"', () => {
  assert.strictEqual(parseReleaseFlags('**CRITICAL**').critical, true);
  assert.strictEqual(parseReleaseFlags('> Critical update').critical, true);
});

// ── What must NOT trip it ────────────────────────────────────────────────────

test('ordinary release notes are not critical', () => {
  const body = [
    '## [3.3.0] - 2026-08-15',
    'The Assets page is rebuilt from the database up.',
    '### Assets',
    '- **Sorting by value now ranks everything you own.**',
    '- Fixed a crash when opening a container.',
    '- Assets no longer go missing during a sync.',
  ].join('\n');
  const r = parseReleaseFlags(body);
  assert.strictEqual(r.critical, false);
  assert.strictEqual(r.criticalReason, null);
});

test('prose that merely mentions the word mid-sentence is not critical', () => {
  // This is the failure that would make the flag worthless: changelogs discuss
  // severity all the time. Only a line that STARTS with the marker counts.
  for (const body of [
    'This fixes a critical bug in the asset index.',
    'The covering index is the critical difference — 1013 ms to 26 ms.',
    'Reviewers said the timing was critical update-side.',
  ]) {
    assert.strictEqual(parseReleaseFlags(body).critical, false, body);
  }
});

test('an empty or missing body is not critical', () => {
  for (const body of [undefined, null, '', '   ']) {
    const r = parseReleaseFlags(body);
    assert.strictEqual(r.critical, false);
    assert.strictEqual(r.criticalReason, null);
  }
});

test('the real 3.3.0 changelog section does not read as critical', () => {
  // Guards against the parser being loosened until it fires on everything.
  const fs = require('fs');
  const path = require('path');
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const section = changelog.split(/^## \[/m)[1] || '';
  assert.strictEqual(parseReleaseFlags(section).critical, false);
});
