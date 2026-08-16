#!/usr/bin/env node
'use strict';
//
// ─── esi-audit.js ─────────────────────────────────────────────────────────────
// Every place this codebase talks to ESI, and whether it does so correctly.
//
// This exists because the same defect has been "fixed" four times. Each time the
// lint rule was written to match the SHAPE of the mistake — `const ESI_BASE =`,
// then `${ESI_BASE}/vN/` — and each time the next occurrence was written in a
// slightly different shape and sailed straight through a green run. Renaming a
// variable to _TR_ESI defeated it. Passing a bare '/v4/characters/…' into a
// helper defeated it. Inlining the URL as a call argument defeated it.
//
// So this does not pattern-match syntax. It enumerates every literal mention of
// the ESI host and every call that reaches it, classifies each one, and requires
// that anything not provably correct is listed in ALLOWED below with a reason.
// Adding a new ESI call in ANY syntax makes this fail until it is either routed
// through the shared client or explicitly justified.
//
//   node scripts/esi-audit.js          # report + exit 1 on any violation
//   node scripts/esi-audit.js --list   # show every call site, including the ok ones
//
// CCP's requirements this enforces (developers.eveonline.com/blog/
// changing-versions-v42-was-getting-out-of-hand):
//   • unversioned paths — /vN/ is legacy and undocumented at our compat date
//   • X-Compatibility-Date on every request
//   • one identity (User-Agent) so CCP can contact us rather than block us
//   • one base URL, not a copy per file
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOST = 'esi.evetech.net';

// Files allowed to mention the host literally, each with the reason. Anything
// not on this list that mentions it is a finding — no exceptions by syntax.
const ALLOWED = new Map([
  ['src/shared/esi.js',            'the one client: it defines BASE'],
  ['src/request_broker.js',        'per-host lane config keyed by hostname, not a URL'],
  ['scripts/lint.js',              'describes the rule in order to enforce it'],
  ['scripts/esi-audit.js',         'this file'],
  ['test/esi_client.test.js',      'asserts isEsi() recognises the host'],
  ['test/request_broker.test.js',  'fake URLs for lane/cache tests, never fetched'],
  ['README.md',                    'prose'],
  ['CHANGELOG.md',                 'prose'],
]);

// Top-level ESI resources, taken from CCP's own spec. Used to spot a version
// segment in front of a real route without flagging login.eveonline.com/v2/oauth
// or api.eve-scout.com/v2/public.
const RESOURCES = [
  'alliances', 'characters', 'contracts', 'corporation', 'corporations', 'dogma',
  'fleets', 'fw', 'incursions', 'industry', 'insurance', 'killmails', 'loyalty',
  'markets', 'meta', 'opportunities', 'route', 'search', 'sovereignty', 'status',
  'ui', 'universe', 'wars',
].join('|');

const VERSIONED = new RegExp(`/(?:v[0-9]+|latest)/(?:${RESOURCES})\\b`);

const SKIP_DIRS = new Set(['node_modules', '.git', 'graphify-out', 'dist', 'data', 'screeenshots', 'test-results']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (/\.(js|html|md)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip line and block comments so prose never counts as a call.
 *
 * The CRLF normalise on the first line is load-bearing, not tidiness. In
 * JavaScript `.` matches any character EXCEPT line terminators, and \r is one of
 * them — so against a CRLF file `//.*$` never reaches the end of the line, the
 * match fails, and not a single comment gets stripped. This repo is CRLF. The
 * first version of this function looked correct, tested correct in isolation
 * against a string that had already been split on /\r?\n/, and silently stripped
 * nothing when run over real files.
 */
function stripComments(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const findings = [];   // code that would actually reach ESI — these fail the run
const staleDocs = [];  // prose still describing versioned routes — reported, not fatal
const okSites  = [];

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  if (!raw.includes(HOST) && !VERSIONED.test(raw)) continue;

  // Markdown never calls anything. Stale docs still mislead the next person —
  // they are how "we already fixed that" becomes folklore — so they are listed,
  // but they do not fail the build.
  if (rel.endsWith('.md')) {
    raw.split(/\r?\n/).forEach((line, i) => {
      if (VERSIONED.test(line)) staleDocs.push({ where: `${rel}:${i + 1}`, line: line.trim().slice(0, 100) });
    });
    continue;
  }

  const code = stripComments(raw);
  const lines = code.split(/\r?\n/);
  const allowed = ALLOWED.get(rel);

  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}`;

    // 1. A versioned route, however the URL is assembled — literal, template,
    //    or a bare path handed to a helper.
    if (VERSIONED.test(line)) {
      findings.push({ where, what: 'versioned ESI route',
        fix: 'drop the version segment; X-Compatibility-Date pins behaviour', line: line.trim() });
    }

    // 2. The host written out anywhere other than the client.
    if (line.includes(HOST)) {
      if (allowed) okSites.push({ where, why: allowed });
      else findings.push({ where, what: 'ESI host written outside the client',
        fix: "build it with Esi.url(path) / ESI_BASE from src/shared/esi.js", line: line.trim() });
    }
  });
}

const listing = process.argv.includes('--list');
if (listing) {
  console.log('— permitted mentions —');
  for (const s of okSites) console.log(`  ${s.where.padEnd(46)} ${s.why}`);
  console.log('');
}

if (staleDocs.length) {
  console.log(`ℹ ${staleDocs.length} doc line(s) still describe versioned routes (not a call, not fatal):`);
  for (const d of staleDocs) console.log(`   ${d.where}  ${d.line}`);
  console.log('');
}

if (findings.length) {
  console.error(`✖ ESI audit: ${findings.length} violation(s)\n`);
  for (const f of findings) {
    console.error(`  ${f.where}`);
    console.error(`     ${f.what}`);
    console.error(`     ${f.line.slice(0, 110)}`);
    console.error(`     → ${f.fix}\n`);
  }
  process.exit(1);
}

console.log(`ESI audit OK — no versioned routes, no host literals outside the client `
          + `(${okSites.length} permitted mention(s) in ${ALLOWED.size} allowlisted files).`);
