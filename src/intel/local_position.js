'use strict';
//
// Where each character actually is, read from EVE's own Local chat log.
//
// WHY NOT ESI
//
// The obvious source is /characters/{id}/location/. It is authoritative and
// cached for only 5 seconds, so it *could* be near-live — but the app polls it
// on a 30-minute stale gate from the dashboard's character sync, and only for
// the selected character. Monitoring an alt meant its position could be half an
// hour old, or older: nothing re-read it while the early-warning system ran.
//
// For a tool whose entire job is "something is N jumps from you", a stale
// origin is not a cosmetic problem. Every distance, every ETA and every alert
// is measured from it, so a fleet that has jumped six systems is being warned
// about the space it left.
//
// WHAT EVE ACTUALLY WRITES
//
// Verified against 79 real Local logs in this repo's author's Chatlogs
// directory rather than assumed. EVE opens ONE Local file per session per
// character — Local_<YYYYMMDD>_<HHMMSS>_<characterID>.txt — and appends a line
// to it on every single system change:
//
//     [ 2026.08.30 18:35:57 ] EVE System > Channel changed to Local : C-J6MT
//
// One observed session logged 38 of them across an evening's roam. The line is
// on disk within a second of the jump, needs no scope and no token, and covers
// every character running on the machine including alts that were never
// authenticated to the app.
//
// So: the newest Local file per character is tailed the same way the intel
// reader tails channels, and the last such line is that character's position.
//
// LIMITS, STATED PLAINLY
//
//  • It needs a client that has run. With EVE closed this reports where the
//    character LOGGED OFF, which is where they will be when they log back in —
//    still the best answer available, but `at` says how old it is so callers
//    can show that rather than implying it is live.
//  • The phrase is the English client's. A localized client writes its own
//    wording and simply won't match, in which case the caller keeps whatever
//    position it had from ESI. It degrades to the old behaviour; it never
//    invents one.
//  • A system NAME is what this returns. Turning it into an id is the caller's
//    job, because that needs the SDE.

const fs   = require('fs');
const path = require('path');
const { findChatlogDir, lineTimestamp } = require('./chatlog_reader');

/** `Local_20260831_090536_1904208033.txt` */
const LOCAL_FILE_RE = /^Local_(\d{8})_(\d{6})_(\d+)\.txt$/i;

// The system name may contain spaces ("New Caldari", "Old Man Star"), so this
// takes the rest of the line rather than a token.
const CHANGED_RE = /Channel changed to Local\s*:\s*(.+?)\s*$/;

const POLL_MS = 1000;

// How far back a first read may look. The largest Local file observed was
// 820 KB — a day in Jita — so this covers a whole session several times over.
const SEED_MAX_BYTES = 4 * 1024 * 1024;

// Newest-by-mtime decides which file is live, but statting all 79 Local files
// every second to find out is wasteful. The filename records when the session
// started, so the live file is almost always the newest-named one; checking two
// per character keeps the safety margin at a fraction of the cost.
const CANDIDATES_PER_CHAR = 2;

/** Local logs grouped by character, newest session first (by name, not stat). */
function localFilesByCharacter(dir) {
  const byChar = new Map();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return byChar; }

  for (const name of entries) {
    const m = LOCAL_FILE_RE.exec(name);
    if (!m) continue;
    const charId = Number(m[3]);
    if (!Number.isFinite(charId)) continue;
    if (!byChar.has(charId)) byChar.set(charId, []);
    byChar.get(charId).push({ name, file: path.join(dir, name), stamp: `${m[1]}${m[2]}` });
  }
  for (const list of byChar.values()) list.sort((a, b) => b.stamp.localeCompare(a.stamp));
  return byChar;
}

/**
 * The Local file currently being written for each character.
 *
 * By mtime among the newest few, not by name alone: a client left running
 * across midnight keeps writing to a file whose name is a day old, and that
 * file is the live one.
 */
function newestLocalPerCharacter(dir) {
  const out = new Map();
  for (const [charId, list] of localFilesByCharacter(dir)) {
    let best = null;
    for (const c of list.slice(0, CANDIDATES_PER_CHAR)) {
      let mtime = 0;
      try { mtime = fs.statSync(c.file).mtimeMs; } catch (_) { continue; }
      if (!best || mtime > best.mtime) best = { file: c.file, mtime };
    }
    if (best) out.set(charId, best);
  }
  return out;
}

/**
 * Read `file` from `offset` and return the LAST system change in that range.
 *
 * Byte offsets are clamped even throughout: EVE writes UTF-16LE at two bytes a
 * unit, and a read that lands mid-unit corrupts the character across the seam.
 * A trailing partial line is handed back in `offset` rather than parsed — the
 * client flushes mid-line, and half of "Channel changed to Local : C-J6MT" is
 * not a system.
 *
 * @returns {{ systemName: string|null, at: number|null, offset: number }}
 */
function scanForSystem(file, offset = 0) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { return { systemName: null, at: null, offset }; }

  // Truncated or replaced under us — start over rather than reading past the end
  // forever.
  let from = offset > size ? 0 : offset;
  const end = size - (size % 2);
  const want = end - (from - (from % 2));
  if (want <= 0) return { systemName: null, at: null, offset: end };

  let text = '';
  let readFrom = from - (from % 2);
  try {
    const fd  = fs.openSync(file, 'r');
    const buf = Buffer.alloc(want);
    const n   = fs.readSync(fd, buf, 0, want, readFrom);
    fs.closeSync(fd);
    // `n` is even under the clamps above, so this last one only bites on a SHORT
    // read — the file shrinking between the stat and the read. Rare, racy, and
    // not reachable from a test without mocking fs, so it is defence rather
    // than something the suite pins. Kept because chatlog_reader.drain() has
    // exactly the same guard and an odd slice here corrupts a whole line.
    text = buf.slice(0, n - (n % 2)).toString('utf16le');
  } catch (_) {
    return { systemName: null, at: null, offset };   // locked mid-write; next tick
  }

  const parts = text.split(/\r?\n/);
  const tail  = parts.pop();
  let next = readFrom + Buffer.byteLength(text, 'utf16le');
  if (tail && tail.length) next -= Buffer.byteLength(tail, 'utf16le');

  // The LAST match wins: a single read after a multi-jump gate run contains
  // several changes, and only the final one is where the character is now.
  let systemName = null, at = null;
  for (const line of parts) {
    const m = CHANGED_RE.exec(line.replace(/﻿/g, ''));
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    systemName = name;
    at = lineTimestamp(line);
  }
  return { systemName, at, offset: next };
}

/** Seed offset for a first read — the last SEED_MAX_BYTES of the file. */
function seedOffset(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { return 0; }
  const from = Math.max(0, size - SEED_MAX_BYTES);
  return from - (from % 2);
}

/**
 * Follows every character's Local log and reports where each one is.
 *
 * @param {object}   opts
 * @param {string}   [opts.dir]     override the auto-detected Chatlogs dir
 * @param {number}   [opts.pollMs]
 * @param {Function} [opts.onChange] (change) => void, only when a system CHANGES
 */
function createLocalPositionWatcher({ dir, pollMs = POLL_MS, onChange } = {}) {
  // characterId -> { file, offset, systemName, at }
  const state = new Map();
  let timer = null;
  let baseDir = findChatlogDir(dir);

  function tick() {
    if (!baseDir) { baseDir = findChatlogDir(dir); if (!baseDir) return; }
    const newest = newestLocalPerCharacter(baseDir);
    const changes = [];

    for (const [charId, { file, mtime }] of newest) {
      let st = state.get(charId);
      if (!st || st.file !== file) {
        // First sight, or a relog. Either way the current position has to be
        // recovered from what is already in the file — tailing from the end
        // would leave the character position-less until their next jump, which
        // for someone parked in a ratting system is forever.
        st = { file, offset: seedOffset(file), systemName: st ? st.systemName : null,
               at: st ? st.at : null, seenAt: mtime };
        state.set(charId, st);
      }
      // When the CLIENT was last writing, as distinct from when the character
      // last jumped. A ratter parked for three hours has an old `at` and a
      // seconds-old `seenAt`, and it is `seenAt` that says the position is
      // still being vouched for by a running client.
      st.seenAt = mtime;
      const got = scanForSystem(file, st.offset);
      st.offset = got.offset;
      if (got.systemName && got.systemName !== st.systemName) {
        const previous = st.systemName;
        st.systemName = got.systemName;
        st.at = got.at != null ? got.at : Date.now();
        changes.push({ characterId: charId, systemName: st.systemName, previous, at: st.at });
      } else if (got.systemName) {
        // Same system re-reported (relog into the same place) — not a move, but
        // it does prove the character is still there.
        st.at = got.at != null ? got.at : st.at;
      }
    }

    if (changes.length && onChange) {
      try { onChange(changes); }
      catch (e) { console.warn('[intel] local-position handler threw:', e.message); }
    }
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, pollMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },

    /** characterId -> { systemName, at, seenAt } for every character seen. */
    positions() {
      const out = new Map();
      for (const [charId, st] of state) {
        if (st.systemName) out.set(charId, { systemName: st.systemName, at: st.at, seenAt: st.seenAt });
      }
      return out;
    },

    /** One character's position, or null. */
    positionFor(characterId) {
      const st = state.get(Number(characterId));
      return st && st.systemName
        ? { systemName: st.systemName, at: st.at, seenAt: st.seenAt }
        : null;
    },

    tick,           // exposed for tests — no waiting on a timer
    get dir() { return baseDir; },
  };
}

/**
 * Which of two conflicting answers to believe: the Local log, or the ESI row.
 *
 * NOT "the log always". While the client is running the log cannot lose — its
 * file is being appended to continuously, so its vouch is seconds old against
 * an ESI row up to half an hour stale. But a character last flown on ANOTHER
 * machine has a log here that stopped weeks ago while ESI has kept syncing.
 * This repo author's own Chatlogs directory contains exactly that: a character
 * parked in Emrayur 22 days ago. Preferring the log unconditionally would pin
 * them to a system they left three weeks earlier and measure every hostile's
 * distance from it.
 *
 * So: newest vouch wins, and a tie goes to the log, which is the more direct
 * evidence — EVE wrote it about itself.
 *
 * @param {{vouchedAt:number}|null} log
 * @param {{vouchedAt:number}|null} esi
 */
function preferPosition(log, esi) {
  if (!log) return esi || null;
  if (!esi) return log;
  return (log.vouchedAt || 0) >= (esi.vouchedAt || 0) ? log : esi;
}

module.exports = {
  createLocalPositionWatcher, localFilesByCharacter, newestLocalPerCharacter,
  scanForSystem, preferPosition, LOCAL_FILE_RE, CHANGED_RE, POLL_MS, SEED_MAX_BYTES,
};
