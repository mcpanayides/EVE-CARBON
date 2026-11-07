'use strict';
//
// The two scope lists. src/ipc/accounts_ipc.js holds what every login asks EVE
// for; main.js holds what a character's token is checked against, which flags a
// character for re-login when its token lacks one. Read from the source, since
// neither file loads outside Electron.
//
// A scope asked for but not checked reaches every character that signs in from
// then on, without making anyone signed in before it sign in again. That is how
// the jump gate search (esi-search.search_structures.v1) arrived in 4.1.2.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

function scopesIn(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const at = src.indexOf('const SCOPES');
  const end = src.indexOf('].join', at);
  assert.ok(at >= 0 && end > at, `${file}: no SCOPES list`);
  // Comments out first: a scope commented out of the list isn't asked for.
  const list = src.slice(at, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...list.matchAll(/'(esi-[a-z_.0-9-]+)'/g)].map(m => m[1]);
}

const asked = scopesIn('src/ipc/accounts_ipc.js');
const checked = scopesIn('main.js');

test('every login asks for the jump gate search, and nobody is made to sign in again for it', () => {
  assert.ok(asked.includes('esi-search.search_structures.v1'), 'logins ask for it');
  assert.ok(!checked.includes('esi-search.search_structures.v1'), 'tokens are not checked for it');
});

test('every scope a token is checked for is one the login asks for', () => {
  // One checked but never asked for would flag every character for re-login, forever.
  assert.deepStrictEqual(checked.filter(s => !asked.includes(s)), []);
});

test('the login list names each scope once', () => {
  assert.strictEqual(new Set(asked).size, asked.length);
});
