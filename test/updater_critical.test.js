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
  // Looked up BY VERSION, not by position. Written as "[1]" — the first section
  // — it silently started testing 3.4.0 the moment a newer release was added,
  // which is a test that quietly stops testing what it says.
  const fs = require('fs');
  const path = require('path');
  const section = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
    .split(/^## \[/m).find(s => s.startsWith('3.3.0]'));
  assert.ok(section, 'the 3.3.0 section is missing from CHANGELOG.md');
  assert.strictEqual(parseReleaseFlags(section).critical, false);
});

test('a reason that wraps across blockquote lines is joined, not truncated', () => {
  // Changelog blockquotes hard-wrap at ~80 columns. Capturing only the first
  // line cut the real 3.4.0 reason mid-sentence ("…that let a"), which is worse
  // than no reason at all — it reads as a bug in the banner.
  const body = [
    '## [3.4.0] - 2026-08-16',
    '',
    '> **CRITICAL UPDATE** — fixes a security flaw in the SDE updater that let a',
    '> tampered download write files outside its folder',
    '',
    'A security release.',
  ].join('\n');
  const r = parseReleaseFlags(body);
  assert.strictEqual(r.critical, true);
  assert.strictEqual(r.criticalReason,
    'fixes a security flaw in the SDE updater that let a tampered download write files outside its folder');
});

test('the joined reason stops at the end of the blockquote', () => {
  const body = [
    '> **CRITICAL UPDATE** — data loss on upgrade',
    '> from version 3.2 and earlier',
    '',
    'This paragraph must not be swallowed into the reason.',
  ].join('\n');
  assert.strictEqual(parseReleaseFlags(body).criticalReason,
    'data loss on upgrade from version 3.2 and earlier');
});

test('CRLF release bodies parse the same as LF', () => {
  // GitHub returns \r\n in release bodies; this repo is CRLF too. A regex that
  // assumes \n silently sees a different string — the exact trap that made the
  // ESI audit's comment stripper match nothing.
  const body = '> **CRITICAL UPDATE** — wallet totals are wrong\r\n> after a sync\r\n';
  assert.deepStrictEqual(parseReleaseFlags(body),
    { critical: true, criticalReason: 'wallet totals are wrong after a sync' });
});

test('every historical changelog section stays non-critical', () => {
  // 40+ real sections discussing crashes, data loss and security fixes in prose.
  // If the parser is ever loosened, this is what catches it.
  const fs = require('fs');
  const path = require('path');
  const sections = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
    .split(/^## \[/m).slice(1);
  const flagged = sections
    .map(s => ({ ver: (s.match(/^([0-9.]+)\]/) || [])[1], crit: parseReleaseFlags(s).critical }))
    .filter(x => x.crit)
    .map(x => x.ver);
  // Only the current release may be flagged.
  assert.deepStrictEqual(flagged, ['3.4.0']);
});
