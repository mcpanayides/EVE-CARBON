#!/usr/bin/env node
// Lightweight syntax check: runs `node --check` on every project .js file.
// Catches parse/syntax errors without needing a full ESLint setup. Used by CI
// (npm run lint / npm test) and runnable locally.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'release', 'data', '.git', '.vs', '.idea', 'tmp_electron_extracted']);

function collect(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

/** Same walk, for .html — selectors live in inline <script> blocks too. */
function collectHtml(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectHtml(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}
const htmlFiles = () => collectHtml(ROOT, []);

const files = collect(ROOT, []);
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    process.stderr.write(`✖ ${path.relative(ROOT, file)}\n`);
    process.stderr.write((e.stderr ? e.stderr.toString() : String(e)) + '\n');
  }
}

// ── Duplicate top-level names across renderer scripts ────────────────────────
// src/func/*.js load as CLASSIC <script> tags from index.html, so they all
// share ONE global scope. Two files declaring the same top-level const/function
// is a SyntaxError that kills the SECOND file outright — and the symptom shows
// up somewhere else entirely: a bare `_esc` in fc_intel.js took out the whole
// of map.js, surfacing as "initMapPage is not defined" on an unrelated page.
//
// `node --check` cannot see this (each file is valid on its own), so it is
// checked here instead.
const RENDERER_DIR = path.join(ROOT, 'src', 'func');
const DECL_RE = /^(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/gm;

const owners = new Map();   // declared name -> [file, ...]
let rendererFiles = [];
try { rendererFiles = fs.readdirSync(RENDERER_DIR).filter(f => f.endsWith('.js')); } catch (_) {}

for (const name of rendererFiles) {
  const src  = fs.readFileSync(path.join(RENDERER_DIR, name), 'utf8');
  const seen = new Set();
  let m;
  DECL_RE.lastIndex = 0;
  while ((m = DECL_RE.exec(src))) seen.add(m[1]);
  for (const id of seen) {
    if (!owners.has(id)) owners.set(id, []);
    owners.get(id).push(name);
  }
}

const clashes = [...owners.entries()].filter(([, where]) => where.length > 1);
if (clashes.length) {
  process.stderr.write('\n✖ Duplicate top-level declarations across src/func (shared global scope):\n');
  for (const [id, where] of clashes) {
    process.stderr.write(`   ${id}  —  ${where.join(', ')}\n`);
  }
  process.stderr.write('   The later-loaded file fails to execute ENTIRELY. Namespace one of them.\n');
  failed += clashes.length;
}

// ── Substring selectors on the inline `style` attribute ──────────────────────
// `[style*="flex-direction:column"]` and friends are always a time bomb, and one
// of them cost a day: the markup writes the attribute without spaces, but the
// FIRST time JavaScript touches element.style.* the browser re-serialises the
// whole attribute in canonical form — "flex-direction: column", WITH a space.
// The selector silently stops matching from then on.
//
// In blueprints.js that selector fed a .closest() whose result was hidden, so
// once it stopped matching the intended wrapper it walked up and hid
// #page-industry instead: the entire page went blank, with the sub-nav and the
// back button inside it, and it read to the user as a frozen window. It only
// happened on the SECOND open, because the first one is what normalises the
// attribute.
//
// There is no correct use of this. Target the element by id or class.
const STYLE_ATTR_SEL = /\[\s*style\s*[*^$~|]=/;
const styleSelHits = [];
for (const file of collect(ROOT, []).concat(htmlFiles())) {
  // This file describes the pattern in order to find it, so it matches itself.
  if (path.resolve(file) === path.resolve(__filename)) continue;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    if (STYLE_ATTR_SEL.test(line)) styleSelHits.push(`${path.relative(ROOT, file)}:${i + 1}`);
  });
}
if (styleSelHits.length) {
  process.stderr.write('\n✖ Substring selector on the inline style attribute:\n');
  for (const where of styleSelHits) process.stderr.write(`   ${where}\n`);
  process.stderr.write('   The browser rewrites that attribute canonically (with spaces) the moment\n' +
                       '   JS touches element.style.*, so the selector stops matching. Use an id/class.\n');
  failed += styleSelHits.length;
}

// ── ESI: one client, no versioned routes ─────────────────────────────────────
// CCP's developer relations reviewed this repo and found `const ESI_BASE =
// 'https://esi.evetech.net'` declared in EIGHT files, full URLs hard-coded in a
// dozen more, and the identity/compatibility-date plumbing copy-pasted three
// ways — one of which (ping-alert.html) had silently drifted and was sending no
// compatibility date at all.
//
// Versioned /vN/ routes are also the deprecated way of talking to ESI. They
// still work, but every NEW route CCP ships is unversioned-only, so staying on
// them is a slow-motion breakage with no date attached. See
// developers.eveonline.com/blog/changing-versions-v42-was-getting-out-of-hand.
//
// src/shared/esi.js is now the single definition. These checks keep it that way.
// ── Why these rules are written the way they are ────────────────────────────
//
// The first version of them matched literal spellings: `const ESI_BASE = …` and
// `${ESI_BASE}/vN/`. Both were trivially side-stepped without anyone meaning to.
// trading.js named its base `_TR_ESI`, faction-warfare.js named its `_FW_ESI`,
// and main.js passed bare paths like '/v4/characters/…' into a helper that added
// the base on a different line. Result: nine live versioned calls and three
// separate base URLs, with lint green and everyone — including the people who
// wrote the rule — believing the job was done.
//
// So these no longer look for a NAME. They look for the thing itself: the base
// string assigned to anything at all, and a version segment in front of an ESI
// resource however the URL is assembled.
//
// Top-level ESI resources, so `/v2/oauth/…` on login.eveonline.com and
// `/v2/public/…` on eve-scout are not swept up. Sorted by the API, not guessed:
// this list is every first path segment in CCP's own spec.
const ESI_RESOURCES = [
  'alliances', 'characters', 'contracts', 'corporation', 'corporations', 'dogma',
  'fleets', 'fw', 'incursions', 'industry', 'insurance', 'killmails', 'loyalty',
  'markets', 'meta', 'opportunities', 'route', 'search', 'sovereignty', 'status',
  'ui', 'universe', 'wars',
].join('|');

const ESI_RULES = [
  { id: 'a second ESI base URL',
    // Any identifier, not just ESI_BASE. The base belongs in one file.
    re: new RegExp(String.raw`(?:const|let|var)\s+\w+\s*=\s*['"\`]https://esi\.evetech\.net`),
    fix: "import it: const { ESI_BASE } = require('…/app_ident')  — defined in src/shared/esi.js" },
  { id: 'a versioned ESI route',
    // Matches the version segment wherever it appears — after ${ANY_BASE}, after
    // the literal domain, or at the start of a bare path handed to a helper.
    re: new RegExp(String.raw`/(?:v[0-9]+|latest)/(?:${ESI_RESOURCES})\b`),
    fix: 'drop the version segment — X-Compatibility-Date pins behaviour instead (developers.eveonline.com/blog/changing-versions-v42-was-getting-out-of-hand)' },
  { id: 'a second copy of the compatibility date',
    re: /COMPATIBILITY_DATE\s*=\s*['"][0-9]{4}-[0-9]{2}-[0-9]{2}/,
    fix: 'read it from src/shared/esi.js (COMPAT_DATE) — three copies is how one of them drifted' },
];
const ESI_OWNER = path.join(ROOT, 'src', 'shared', 'esi.js');
const esiHits = [];
for (const file of collect(ROOT, []).concat(htmlFiles())) {
  const abs = path.resolve(file);
  // The client itself defines these, and this file describes them to find them.
  if (abs === path.resolve(ESI_OWNER) || abs === path.resolve(__filename)) continue;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;   // prose
    for (const r of ESI_RULES) {
      if (r.re.test(line)) esiHits.push({ where: `${path.relative(ROOT, file)}:${i + 1}`, r });
    }
  });
}
if (esiHits.length) {
  process.stderr.write('\n✖ ESI client rules:\n');
  for (const h of esiHits) process.stderr.write(`   ${h.where}  —  ${h.r.id}\n      ${h.r.fix}\n`);
  failed += esiHits.length;
}

if (failed) {
  console.error(`\nLint failed: ${failed} problem(s) across ${files.length} files.`);
  process.exit(1);
}
console.log(`Lint OK: ${files.length} JS files, no duplicate renderer globals, ` +
            `no style-attribute selectors, one ESI client.`);
