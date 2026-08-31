'use strict';
//
// Reading a character's CURRENT system out of EVE's Local chat log.
//
// The bug this exists to stop coming back: every distance, ETA and alert the
// early-warning system reports is measured FROM the monitored character, and
// the only source for that used to be the stored ESI location — refreshed on a
// 30-minute stale gate, from the dashboard, for the selected character only.
// Nothing re-read it while the intel service ran. Jump a super from staging to
// a ratting system and the tool went on measuring every hostile's distance from
// the system you had left, without any sign on screen that it had.
//
// The fixture format is not invented. It was verified against 79 real Local
// logs: EVE opens one file per session per character and appends
//
//     [ 2026.08.30 18:35:57 ] EVE System > Channel changed to Local : C-J6MT
//
// on every system change — 38 of them in one observed evening's roam.
const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
  createLocalPositionWatcher, newestLocalPerCharacter, scanForSystem, preferPosition, CHANGED_RE,
} = require('../src/intel/local_position');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evec-local-'));
}

const CHANGE = (ts, sys) => `[ ${ts} ] EVE System > Channel changed to Local : ${sys}`;

const HEAD = '﻿\n\n        ---------------------------------------------------------------\n' +
             '          Channel ID:      local\n          Channel Name:    Local\n' +
             '          Listener:        Seer Moirai\n' +
             '          Session started: 2026.08.30 18:25:00\n' +
             '        ---------------------------------------------------------------\n\n';

/** A Local log written the way EVE writes them: UTF-16LE, one line per event. */
function writeLocal(dir, charId, lines, { stamp = '20260830_182558' } = {}) {
  const file = path.join(dir, `Local_${stamp}_${charId}.txt`);
  fs.writeFileSync(file, Buffer.from(HEAD + lines.join('\n') + '\n', 'utf16le'));
  return file;
}

/** Append more lines, the way the running client does. */
function appendLocal(file, lines) {
  fs.appendFileSync(file, Buffer.from(lines.join('\n') + '\n', 'utf16le'));
}

// ── The line itself ───────────────────────────────────────────────────────────

test('the system-change line is recognised, spaces and all', () => {
  const grab = (l) => { const m = CHANGED_RE.exec(l); return m ? m[1].trim() : null; };
  assert.strictEqual(grab(CHANGE('2026.08.30 18:35:57', 'C-J6MT')), 'C-J6MT');
  // Multi-word names are real systems, so the pattern takes the rest of the
  // line rather than a token — "New" alone is not a place.
  assert.strictEqual(grab(CHANGE('2026.08.30 18:35:57', 'New Caldari')), 'New Caldari');
  assert.strictEqual(grab(CHANGE('2026.08.30 18:35:57', 'Old Man Star')), 'Old Man Star');
  assert.strictEqual(grab('[ 2026.08.30 18:35:57 ] Someone > c-j6mt clr'), null,
    'ordinary chat naming a system is not a position claim');
});

// ── Seeding: the case that made this necessary ───────────────────────────────

test('a character parked since login has a position on the FIRST tick', () => {
  // The failure mode this pins: tailing from EOF, the way the intel reader
  // deliberately does, would leave someone sitting in their ratting system with
  // no position at all until their next jump — which for a ratting super is
  // hours away, or never.
  const dir = tmpdir();
  writeLocal(dir, 1904208033, [
    CHANGE('2026.08.30 18:26:04', 'ZLO3-V'),
    '[ 2026.08.30 18:27:00 ] Someone > hi',
    CHANGE('2026.08.30 18:35:57', 'C-J6MT'),
  ]);
  const w = createLocalPositionWatcher({ dir });
  w.tick();
  assert.strictEqual(w.positionFor(1904208033).systemName, 'C-J6MT',
    'the LAST change in the file is where the character is now');
});

test('the last change wins when several arrive in one read', () => {
  // A gate run writes eight changes between two polls. Reporting the first
  // would put the fleet a full roam behind where it actually is.
  const dir = tmpdir();
  const file = writeLocal(dir, 90045610, [CHANGE('2026.08.30 18:26:04', 'ZLO3-V')]);
  const w = createLocalPositionWatcher({ dir });
  w.tick();

  appendLocal(file, [
    CHANGE('2026.08.30 18:30:46', '3-LJW3'),
    CHANGE('2026.08.30 18:31:30', '5H-SM2'),
    CHANGE('2026.08.30 18:32:31', 'UM-SCG'),
    CHANGE('2026.08.30 18:35:57', 'C-J6MT'),
  ]);
  w.tick();
  assert.strictEqual(w.positionFor(90045610).systemName, 'C-J6MT');
});

// ── Change notification ───────────────────────────────────────────────────────

test('a jump fires onChange exactly once, with where it came from', () => {
  const dir = tmpdir();
  const file = writeLocal(dir, 111, [CHANGE('2026.08.30 18:26:04', 'ZLO3-V')]);
  const seen = [];
  const w = createLocalPositionWatcher({ dir, onChange: (c) => seen.push(...c) });

  w.tick();
  assert.strictEqual(seen.length, 1, 'the seed itself is a change: we did not know before');
  assert.strictEqual(seen[0].systemName, 'ZLO3-V');
  assert.strictEqual(seen[0].previous, null);

  w.tick();
  assert.strictEqual(seen.length, 1, 'a quiet tick reports nothing');

  appendLocal(file, [CHANGE('2026.08.30 18:35:57', 'C-J6MT')]);
  w.tick();
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[1].systemName, 'C-J6MT');
  assert.strictEqual(seen[1].previous, 'ZLO3-V',
    'the previous system is carried so the UI can say what moved where');
});

test('re-entering the same system is not a move', () => {
  // Docking, undocking and relogging all re-emit the line. Treating those as
  // jumps would rebuild the whole jump horizon and clear the alert suppressions
  // for nothing — setOrigins is not free.
  const dir = tmpdir();
  const file = writeLocal(dir, 222, [CHANGE('2026.08.30 18:26:04', 'C-J6MT')]);
  const seen = [];
  const w = createLocalPositionWatcher({ dir, onChange: (c) => seen.push(...c) });
  w.tick();
  appendLocal(file, [CHANGE('2026.08.30 18:40:00', 'C-J6MT')]);
  w.tick();
  assert.strictEqual(seen.length, 1, 'seeded once, then silent');
});

// ── The awkward parts of reading a file EVE is writing ───────────────────────

test('a half-written line is held back, not parsed', () => {
  // EVE flushes mid-line. Half of "Channel changed to Local : C-J6MT" is not a
  // system, and reading "C-J" as one would send the fleet a name that does not
  // exist.
  const dir = tmpdir();
  const file = writeLocal(dir, 333, [CHANGE('2026.08.30 18:26:04', 'ZLO3-V')]);
  const w = createLocalPositionWatcher({ dir });
  w.tick();

  fs.appendFileSync(file, Buffer.from('[ 2026.08.30 18:35:57 ] EVE System > Channel changed to Local : C-J6', 'utf16le'));
  w.tick();
  assert.strictEqual(w.positionFor(333).systemName, 'ZLO3-V', 'partial line ignored');

  fs.appendFileSync(file, Buffer.from('MT\n', 'utf16le'));
  w.tick();
  assert.strictEqual(w.positionFor(333).systemName, 'C-J6MT', 'and picked up once complete');
});

// Pins the offset the scanner HANDS BACK. The clamp on the read length itself
// only bites on a short read (the file shrinking between stat and read), which
// a test cannot force without mocking fs — see the note at that line.
test('offsets stay even — UTF-16 is two bytes a unit', () => {
  const dir = tmpdir();
  const file = writeLocal(dir, 444, [CHANGE('2026.08.30 18:26:04', 'ZLO3-V')]);
  const got = scanForSystem(file, 0);
  assert.strictEqual(got.offset % 2, 0, 'a read landing mid-unit corrupts the seam');
  assert.strictEqual(got.systemName, 'ZLO3-V');
});

test('a truncated file is re-read rather than seeked past its own end', () => {
  const dir = tmpdir();
  const file = writeLocal(dir, 555, [CHANGE('2026.08.30 18:26:04', 'ZLO3-V')]);
  const big = fs.statSync(file).size;
  fs.writeFileSync(file, Buffer.from(HEAD + CHANGE('2026.08.30 19:00:00', 'UM-SCG') + '\n', 'utf16le'));
  const got = scanForSystem(file, big + 4096);
  assert.strictEqual(got.systemName, 'UM-SCG');
});

// ── Which file, and whose ─────────────────────────────────────────────────────

test('one character per file, keyed off the id in the name', () => {
  const dir = tmpdir();
  writeLocal(dir, 1904208033, [CHANGE('2026.08.30 18:26:04', 'C-J6MT')]);
  writeLocal(dir, 90045610,   [CHANGE('2026.08.30 18:26:04', 'Jita')]);
  const w = createLocalPositionWatcher({ dir });
  w.tick();
  assert.strictEqual(w.positionFor(1904208033).systemName, 'C-J6MT');
  assert.strictEqual(w.positionFor(90045610).systemName, 'Jita');
  assert.strictEqual(w.positionFor(999), null, 'a character with no log has no position');
});

test('other channels are not read as position', () => {
  // Alliance and the intel channels sit in the same directory and carry the
  // same filename shape. Only Local states where you are.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'Alliance_20260830_182558_777.txt'),
    Buffer.from(HEAD + CHANGE('2026.08.30 18:26:04', 'Jita') + '\n', 'utf16le'));
  fs.writeFileSync(path.join(dir, 'fareast.imperium_20260830_182558_777.txt'),
    Buffer.from(HEAD + CHANGE('2026.08.30 18:26:04', 'Jita') + '\n', 'utf16le'));
  const w = createLocalPositionWatcher({ dir });
  w.tick();
  assert.strictEqual(w.positionFor(777), null);
  assert.strictEqual(newestLocalPerCharacter(dir).size, 0);
});

test('a relog switches to the new session file and reseeds from it', () => {
  // The new file has a newer name AND a newer mtime; the position in it must
  // replace the old one rather than the watcher tailing a file EVE has stopped
  // writing to.
  const dir = tmpdir();
  writeLocal(dir, 888, [CHANGE('2026.08.30 18:26:04', 'ZLO3-V')], { stamp: '20260830_182558' });
  const w = createLocalPositionWatcher({ dir });
  w.tick();
  assert.strictEqual(w.positionFor(888).systemName, 'ZLO3-V');

  const newer = writeLocal(dir, 888, [CHANGE('2026.08.31 09:05:46', 'C-J6MT')], { stamp: '20260831_090536' });
  const t = Date.now() / 1000 + 60;
  fs.utimesSync(newer, t, t);
  w.tick();
  assert.strictEqual(w.positionFor(888).systemName, 'C-J6MT');
});

test('an empty directory yields nothing and throws nothing', () => {
  const dir = tmpdir();
  const w = createLocalPositionWatcher({ dir });
  w.tick();
  assert.strictEqual(w.positions().size, 0);
});

// ── Which source to believe ───────────────────────────────────────────────────

test('a running client always beats a stale ESI row', () => {
  const now = Date.now();
  const log = { source: 'log', systemId: 1, vouchedAt: now - 2_000 };
  const esi = { source: 'esi', systemId: 2, vouchedAt: now - 28 * 60_000 };
  assert.strictEqual(preferPosition(log, esi).source, 'log',
    'this is the whole bug: a 28-minute-old ESI row was deciding every distance');
});

test('a character last flown on another machine is NOT pinned by our old log', () => {
  // Real case, from this repo author's own Chatlogs: a character parked in
  // Emrayur 22 days ago. Preferring the log unconditionally would measure every
  // hostile's distance from a system they left three weeks earlier.
  const now = Date.now();
  const log = { source: 'log', systemId: 1, vouchedAt: now - 22 * 24 * 3600_000 };
  const esi = { source: 'esi', systemId: 2, vouchedAt: now - 2 * 3600_000 };
  assert.strictEqual(preferPosition(log, esi).source, 'esi');
});

test('a parked ratter keeps its log position — the client is still vouching', () => {
  // The trap this avoids: the character has not JUMPED for three hours, but the
  // client has been appending to Local the whole time. Comparing jump time
  // against sync time would hand a parked super to a half-hour-old ESI row.
  const now = Date.now();
  const log = { source: 'log', systemId: 1, vouchedAt: now - 5_000 };   // seenAt, not the jump
  const esi = { source: 'esi', systemId: 2, vouchedAt: now - 20 * 60_000 };
  assert.strictEqual(preferPosition(log, esi).source, 'log');
});

test('either source alone is used, and neither means null', () => {
  const log = { source: 'log', vouchedAt: 1 };
  const esi = { source: 'esi', vouchedAt: 2 };
  assert.strictEqual(preferPosition(log, null).source, 'log');
  assert.strictEqual(preferPosition(null, esi).source, 'esi');
  assert.strictEqual(preferPosition(null, null), null);
  assert.strictEqual(preferPosition({ source: 'log' }, { source: 'esi' }).source, 'log',
    'a tie goes to the log — EVE wrote it about itself');
});
