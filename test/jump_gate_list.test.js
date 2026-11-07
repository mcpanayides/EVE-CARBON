'use strict';
//
// Reading jump gate lists (src/shared/jump_gate_list.js): pasted "A » B" lines
// and Webway-style tables on Settings → Jump Gates, and the in-game Ansiblex
// names that Gates from EVE brings back from ESI.
const test   = require('node:test');
const assert = require('node:assert');

const JG = require('../src/shared/jump_gate_list');

test('a cell is cut down to its system, keeping the hyphens inside names', () => {
  assert.strictEqual(JG.cleanSystemName('MN-Q26 @ 1-1'), 'MN-Q26');
  assert.strictEqual(JG.cleanSystemName('1DQ1-A - Moon 1 - POS'), '1DQ1-A');
  assert.strictEqual(JG.cleanSystemName('  8QT-H4 - Speedway '), '8QT-H4');
  assert.strictEqual(JG.cleanSystemName('G-ME2K'), 'G-ME2K');
  assert.strictEqual(JG.cleanSystemName(''), '');
});

test('"A » B" lines read the way the game names Ansiblex gates', () => {
  assert.deepStrictEqual(JG.parseLine('1DQ1-A » 8QT-H4 - Speedway'), { a: '1DQ1-A', b: '8QT-H4' });
  assert.deepStrictEqual(JG.parseLine('1DQ1-A»8QT-H4'), { a: '1DQ1-A', b: '8QT-H4' });
  assert.deepStrictEqual(JG.parseLine('﻿T5ZI-S » Q-JQSG'), { a: 'T5ZI-S', b: 'Q-JQSG' });
  assert.deepStrictEqual(JG.parseLine('Y-OMTZ » MO-GZ5 @ 3-2'), { a: 'Y-OMTZ', b: 'MO-GZ5' });
});

test('the other arrows people type read the same, and a hyphen in a name is never one', () => {
  for (const arrow of ['→', '↔', '<->', '<=>', '-->', '->', '=>']) {
    assert.deepStrictEqual(JG.parseLine(`MN-Q26 ${arrow} G-ME2K`), { a: 'MN-Q26', b: 'G-ME2K' }, arrow);
  }
  assert.strictEqual(JG.parseLine('MN-Q26 - G-ME2K'), null);                  // a spaced hyphen is not an arrow
  assert.strictEqual(JG.parseLine('1DQ1-A'), null);
});

test('Webway table rows: the 2nd and 3rd columns, the header left out, unfriendly rows marked as theirs', () => {
  const row = (...c) => c.join('\t');
  assert.deepStrictEqual(JG.parseLine(row('Delve', '1DQ1-A @ 1-1', '319-3D', 'Online', 'GSF', '', '4.2', '', 'Yes')), { a: '1DQ1-A', b: '319-3D' });
  assert.deepStrictEqual(JG.parseLine(row('Region', 'System / POS', 'System / POS', 'Status')), { skip: 'header' });
  assert.deepStrictEqual(JG.parseLine(row('Delve', 'A', 'B', 'Online', 'X', '', '1', '', 'No')), { a: 'A', b: 'B', friendly: false });
  assert.deepStrictEqual(JG.parseLine(row('Delve', 'A', 'B', 'Online')), { a: 'A', b: 'B' });   // no Friendly column: ours
  // An arrow in a later column (a route, say) doesn't override the table.
  assert.deepStrictEqual(JG.parseLine(row('Delve', '1DQ1-A', '319-3D', 'Online', 'GSF', '', '4.2', '1DQ1-A -> 319-3D', 'Yes')),
                         { a: '1DQ1-A', b: '319-3D' });
});

test('a gate copied from the game with its other columns reads by its name', () => {
  assert.deepStrictEqual(JG.parseLine('1DQ1-A » 8QT-H4 - Speedway\tAnsiblex Jump Bridge\t0 m'), { a: '1DQ1-A', b: '8QT-H4' });
  assert.deepStrictEqual(JG.parseLine('Ansiblex Jump Bridge\t\t\t1DQ1-A » 8QT-H4'), { a: '1DQ1-A', b: '8QT-H4' });
});

test('a whole paste: ours, theirs, and lines that are neither', () => {
  const text = ['The Webway', '', '1DQ1-A » 8QT-H4 - Speedway', 'Region\tSystem / POS\tSystem / POS',
                'Delve\tT5ZI-S\t4O-239\tOnline\tGSF\t\t1\t\tNo', 'notes from last week', 'Q-JQSG -> T5ZI-S'].join('\r\n');
  const r = JG.parseList(text);
  assert.deepStrictEqual(r.pairs, [{ a: '1DQ1-A', b: '8QT-H4' }, { a: 'Q-JQSG', b: 'T5ZI-S' }]);
  assert.deepStrictEqual(r.theirs, [{ a: 'T5ZI-S', b: '4O-239' }]);
  assert.strictEqual(r.unreadable, 2);                                         // the title and the note
  assert.deepStrictEqual(JG.parseList(''), { pairs: [], theirs: [], unreadable: 0 });
});

test('a parsed gate resolves to a pair, the structure’s own system first', () => {
  const idx = { '1dq1-a': 1, '8qt-h4': 2, 't5zi-s': 3 };
  assert.deepStrictEqual(JG.resolvePair({ a: '1DQ1-A', b: '8QT-H4' }, idx), [1, 2]);
  assert.deepStrictEqual(JG.resolvePair({ a: 'typo', b: '8QT-H4', aId: 1 }, idx), [1, 2]);
  assert.deepStrictEqual(JG.resolvePair({ a: '8QT-H4', b: '1DQ1-A', aId: 1 }, idx), [1, 2]);   // named the other way round
  assert.strictEqual(JG.resolvePair({ a: '1DQ1-A', b: 'Nowhere' }, idx), null);
  assert.strictEqual(JG.resolvePair({ a: '1DQ1-A', b: '1DQ1-A' }, idx), null);
});

test('gates read from ESI become one pair per gate', () => {
  const idx = { '1dq1-a': 1, '8qt-h4': 2, 't5zi-s': 3 };
  const r = JG.gatePairs([
    { name: '1DQ1-A » 8QT-H4 - Speedway', systemId: 1 },
    { name: '8QT-H4 » 1DQ1-A - Speedway', systemId: 2 },          // the same gate's other end
    { name: 'T5ZI-S » Nowhere', systemId: 3 },
    { name: 'Keepstar of Doom', systemId: 1 },
  ], idx);
  assert.deepStrictEqual(r.pairs, [[1, 2]]);
  assert.strictEqual(r.unreadable, 1);
  assert.deepStrictEqual(r.unresolved, ['Nowhere']);
});

// ─── the hourly read from ESI ─────────────────────────────────────────────────

test('a round adds new gates and takes out the ones ESI no longer reports, but never a pasted one', () => {
  const r = JG.applyEsiRound({
    friendly: [[1, 2], [3, 4], [8, 9]],                 // 8-9 was pasted by hand
    other: [], last: { mine: [[1, 2], [3, 4]], theirs: [] },
    mine: [[2, 1], [5, 6]], theirs: [],                 // 3-4 is gone; 5-6 is new
  });
  assert.deepStrictEqual(r.friendly, [[1, 2], [8, 9], [5, 6]]);
  assert.deepStrictEqual([r.added, r.removed], [1, 1]);
  assert.deepStrictEqual(r.last.mine, [[2, 1], [5, 6]]);
});

test('other characters’ gates are theirs, unless they are also ours, and leave when no longer seen', () => {
  const r = JG.applyEsiRound({
    friendly: [[1, 2]], other: [[7, 8], [10, 11]], last: { mine: [[1, 2]], theirs: [[7, 8]] },
    mine: [[1, 2]], theirs: [[2, 1], [20, 21]],          // 2-1 is ours too; 7-8 is gone; 10-11 was pasted
  });
  assert.deepStrictEqual(r.other, [[10, 11], [20, 21]]);
  assert.deepStrictEqual([r.otherAdded, r.otherRemoved], [1, 1]);
  assert.deepStrictEqual(r.last.theirs, [[20, 21]]);
});

test('a round cut short only adds, and remembers what it had', () => {
  const r = JG.applyEsiRound({
    friendly: [[1, 2], [3, 4]], other: [[7, 8]], last: { mine: [[1, 2], [3, 4]], theirs: [[7, 8]] },
    mine: [[5, 6]], theirs: [], complete: false,
  });
  assert.deepStrictEqual(r.friendly, [[1, 2], [3, 4], [5, 6]]);
  assert.deepStrictEqual(r.other, [[7, 8]]);
  assert.strictEqual(r.removed, 0);
  assert.deepStrictEqual(r.last.mine, [[1, 2], [3, 4], [5, 6]]);
});

test('a gate that becomes ours stops being theirs', () => {
  const r = JG.applyEsiRound({ friendly: [], other: [[1, 2]], last: {}, mine: [[1, 2]], theirs: [] });
  assert.deepStrictEqual(r.friendly, [[1, 2]]);
  assert.deepStrictEqual(r.other, []);
});

test('names resolve whole, case aside, or by their first or last word', () => {
  const idx = { '1dq1-a': 30004759, '8qt-h4': 30004767, 'old man star': 30005005 };
  assert.strictEqual(JG.resolveSystem('1DQ1-A', idx), 30004759);
  assert.strictEqual(JG.resolveSystem('Old Man Star', idx), 30005005);
  assert.strictEqual(JG.resolveSystem('8QT-H4 [Tunnel]', idx), 30004767);       // a suffix
  assert.strictEqual(JG.resolveSystem('[GSF] 1DQ1-A', idx), 30004759);          // a prefix
  assert.strictEqual(JG.resolveSystem('Nowhere', idx), null);
  assert.strictEqual(JG.resolveSystem('', idx), null);
  assert.strictEqual(JG.resolveSystem('constructor', idx), null);               // not the object's own keys
});

test('adding pairs keeps one per gate, whichever end it is listed from', () => {
  const saved = [[1, 2]];
  const r = JG.addPairs(saved, [[2, 1], [3, 4], [4, 3], [5, 5], [3, 6]]);
  assert.deepStrictEqual(r.merged, [[1, 2], [3, 4], [3, 6]]);
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.dup, 2);
  assert.deepStrictEqual(saved, [[1, 2]]);                                     // the saved list itself is untouched
  assert.strictEqual(JG.pairKey(9, 3), JG.pairKey(3, 9));
});
