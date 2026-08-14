#!/usr/bin/env node
// update-docs.js — regenerates src/docs/*.md for changed JS source files.
//
// Uses the GitHub Models API (GPT-4o) via the standard GITHUB_TOKEN —
// no separate API key needed; the token is automatically available in Actions.
//
// Usage (called by update-docs.yml):
//   GITHUB_TOKEN="..." CHANGED_FILES="main.js src/func/jabber.js" node update-docs.js

'use strict';

const OpenAI = require('openai');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '..', '..');  // project root

const client = new OpenAI({
  baseURL: 'https://models.inference.ai.azure.com',
  apiKey:  process.env.GITHUB_TOKEN,
});

// ── Source file → doc file mapping ───────────────────────────────────────────
const SOURCE_TO_DOC = {
  // Main process
  'main.js':                           'src/docs/main.md',

  // Renderer functions
  'src/func/jabber.js':                'src/docs/jabber.md',
  'src/func/ui.js':                    'src/docs/ui.md',
  'src/func/bugs.js':                  'src/docs/bugs.md',
  'src/func/characters.js':            'src/docs/characters.md',
  'src/func/wallets.js':               'src/docs/wallets.md',
  'src/func/assets.js':                'src/docs/assets.md',
  'src/func/dashboard.js':             'src/docs/dahboards.md',
  'src/func/materials.js':             'src/docs/materials.md',
  'src/func/planetary-interaction.js': 'src/docs/planetary-interaction.md',
  'src/func/map.js':                   'src/docs/fleet-up.md',
  'src/func/fleetup.js':               'src/docs/fleet-up.md',
  'src/func/cost-index.js':            'src/docs/cost-index.md',
  'src/func/blueprints.js':            'src/docs/blueprints.md',

  // Preload
  'src/preload.js':                    'src/docs/preloader.md',

  // IPC modules
  'src/ipc/accounts_ipc.js':           'src/docs/apps.md',
  'src/ipc/assets_ipc.js':             'src/docs/assets.md',
  'src/ipc/character_ipc.js':          'src/docs/characters.md',
  'src/ipc/config_ipc.js':             'src/docs/ui.md',
  'src/ipc/pi_ipc.js':                 'src/docs/planetary-interaction.md',
  'src/ipc/station_ipc.js':            'src/docs/locator.md',
  'src/ipc/map_ipc.js':                'src/docs/fleet-up.md',
  'src/ipc/updater_ipc.js':            'src/docs/updater.md',

  // Core modules
  'src/jabber_ipc.js':                 'src/docs/jabber.md',
  'src/jabber_data_db.js':             'src/docs/jabber.md',
  'src/locator.js':                    'src/docs/locator.md',
};

// Build the reverse map: doc → all source files that contribute to it
const DOC_TO_SOURCES = {};
for (const [src, doc] of Object.entries(SOURCE_TO_DOC)) {
  (DOC_TO_SOURCES[doc] = DOC_TO_SOURCES[doc] || []).push(src);
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `\
You are a technical documentation writer for EVE Carbon, an Electron desktop app for EVE Online.
Update or create markdown documentation that accurately reflects JavaScript source code.

House style (match the existing docs exactly):
- H1: the filename or module name
- H2 sections: "Overview", "Module-Level State", "Functions", "IPC Handlers"
- Module-level variables → markdown table with columns: Variable | Purpose
- Each function → H3 in backticks, bold Purpose / Parameters / Returns labels,
  then a "Connects to:" or "Calls:" table listing dependencies
- IPC handlers → document the channel name in monospace, the args and return shape
- Descriptions: 1–2 sentences, no filler
- Do NOT include implementation details — just the public interface and behaviour
- Return ONLY the markdown content. No preamble, no code fences around the output.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFile(rel) {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function writeFile(rel, content) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content.trimEnd() + '\n');
}

function truncate(text, max = 80_000) {
  return text.length <= max ? text : text.slice(0, max) + '\n// ... (truncated)';
}

// ── Update one doc from its source files ──────────────────────────────────────
async function updateDoc(docPath, sourcePaths) {
  const sourceBlocks = sourcePaths
    .map(src => {
      const code = readFile(src);
      return code ? `### ${src}\n\`\`\`js\n${truncate(code)}\n\`\`\`` : null;
    })
    .filter(Boolean)
    .join('\n\n');

  if (!sourceBlocks) {
    console.log(`  All source files missing for ${docPath} — skipping`);
    return false;
  }

  const existingDoc = readFile(docPath);

  const userMessage = existingDoc
    ? `Update the documentation below so it matches the current source code.\n` +
      `Add new entries, remove deleted ones, correct anything that changed.\n` +
      `Keep the same structure and style.\n\n` +
      `Source files:\n${sourceBlocks}\n\n` +
      `Current documentation:\n${existingDoc}`
    : `Generate documentation for the following source files using the project house style.\n\n` +
      `Source files:\n${sourceBlocks}`;

  const response = await client.chat.completions.create({
    model:      'gpt-4o',
    max_tokens: 8192,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage   },
    ],
  });

  const updated = response.choices[0]?.message?.content?.trim();
  if (!updated) {
    console.log(`  Empty response for ${docPath} — skipping`);
    return false;
  }

  writeFile(docPath, updated);
  console.log(`  ✓ wrote ${docPath}  (${updated.length} chars)`);
  return true;
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN not set — aborting');
    process.exit(1);
  }

  const changedFiles = (process.env.CHANGED_FILES || '')
    .trim().split(/\s+/).filter(Boolean);

  if (!changedFiles.length) {
    console.log('No changed files — nothing to do');
    return;
  }

  console.log('Changed JS files:', changedFiles);

  const docsToUpdate = new Set(
    changedFiles.map(f => SOURCE_TO_DOC[f]).filter(Boolean)
  );

  const unmapped = changedFiles.filter(f => !SOURCE_TO_DOC[f]);
  if (unmapped.length) console.log(`  No doc mapping for: ${unmapped.join(', ')}`);

  if (!docsToUpdate.size) {
    console.log('No mapped docs to update — done');
    return;
  }

  console.log(`\nDocs to update: ${[...docsToUpdate].join(', ')}\n`);

  let updated = 0;
  for (const docPath of docsToUpdate) {
    const sources = DOC_TO_SOURCES[docPath] || [];
    console.log(`Processing ${docPath}  (sources: ${sources.join(', ')})`);
    try {
      if (await updateDoc(docPath, sources)) updated++;
    } catch (err) {
      console.error(`  Error updating ${docPath}:`, err.message);
    }
  }

  console.log(`\nFinished — updated ${updated} doc file(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
