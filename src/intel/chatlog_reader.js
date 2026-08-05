'use strict';
//
// Tailing EVE's chat logs.
//
// ESI exposes no chat, so reading intel means reading the files the client
// writes. Everything here is dictated by how EVE actually behaves, which is
// awkward in three specific ways:
//
//  1. UTF-16LE, with a BOM on the file AND on nearly every line. Decoding as
//     UTF-8 yields NUL-separated mush that silently matches nothing.
//
//  2. A NEW FILE PER SESSION PER CHARACTER, named
//     <channel>_<YYYYMMDD>_<HHMMSS>_<characterID>.txt. Log in with three
//     characters and three files receive the same messages — tailing them all
//     triples every report, which would wreck the sighting counts the
//     "inbound" logic depends on. Only the most recently written file per
//     channel is followed.
//
//  3. THE CLIENT APPENDS WHILE WE READ. fs.watch on an actively-appended file
//     is unreliable on Windows (and the file is held open by EVE), so this
//     polls size via stat and reads only the new bytes. Polling a handful of
//     files once a second costs nothing and never misses a rotation.
//
// Reads are clamped to an EVEN byte offset: UTF-16 is two bytes per unit, and
// a read that lands mid-unit corrupts the character across the boundary.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// EVE has never been consistent about where Documents lives, and OneDrive
// redirection moves it again. Checked in order; the first that exists wins.
const CANDIDATE_DIRS = [
  ['Documents', 'EVE', 'logs', 'Chatlogs'],
  ['OneDrive', 'Documents', 'EVE', 'logs', 'Chatlogs'],
  ['OneDrive', 'Dokumente', 'EVE', 'logs', 'Chatlogs'],   // localized Windows
  ['OneDrive - Personal', 'Documents', 'EVE', 'logs', 'Chatlogs'],
];

const FILE_RE = /^(.+)_(\d{8})_(\d{6})_(\d+)\.txt$/;
const POLL_MS = 1000;

/** Where EVE is writing chat logs, or null. */
function findChatlogDir(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = os.homedir();
  for (const parts of CANDIDATE_DIRS) {
    const dir = path.join(home, ...parts);
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch (_) { /* next */ }
  }
  return null;
}

/** Channel name out of a log filename, or null if it isn't one. */
function channelOf(filename) {
  const m = FILE_RE.exec(filename);
  return m ? m[1] : null;
}

/**
 * The file currently being written for each channel.
 *
 * Newest by mtime, not by the timestamp in the name: the name records when the
 * session STARTED, so an old session still being written to is the live one
 * while a newer session that has gone quiet is not.
 */
function newestPerChannel(dir, channels) {
  const want = new Set(channels.map(c => c.toLowerCase()));
  const best = new Map();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return best; }

  for (const name of entries) {
    const ch = channelOf(name);
    if (!ch || !want.has(ch.toLowerCase())) continue;
    const full = path.join(dir, name);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch (_) { continue; }
    const cur = best.get(ch);
    if (!cur || mtime > cur.mtime) best.set(ch, { file: full, mtime });
  }
  return best;
}

/**
 * The channel header EVE writes at the top of every log:
 *
 *     Channel Name:    fareast.imperium
 *     Listener:        Kinetix69
 *
 * and, in the first EVE System line, the MOTD — which for Imperium intel
 * channels names the regions it covers ("Detorid // Cache // Wicked Creek").
 * Those regions are what scope abbreviation matching, so reading them here
 * means the user doesn't have to type them into settings.
 */
function readHeader(file, knownRegions = []) {
  let head = '';
  try {
    const fd  = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n   = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n - (n % 2)).toString('utf16le').replace(/﻿/g, '');
  } catch (_) { return { channel: null, listener: null, regions: [] }; }

  const chan = /Channel Name:\s*(.+)/.exec(head);
  const list = /Listener:\s*(.+)/.exec(head);

  // Region names are matched against the SDE's own list rather than parsed out
  // of the MOTD's punctuation, which varies per channel and changes whenever
  // someone edits it.
  const found = [];
  const lower = head.toLowerCase();
  for (const r of knownRegions) {
    if (lower.includes(String(r).toLowerCase())) found.push(r);
  }
  return {
    channel:  chan ? chan[1].trim() : null,
    listener: list ? list[1].trim() : null,
    regions:  found,
  };
}

/**
 * Follows a set of channels and calls back with each new line.
 *
 * @param {object} opts
 * @param {string}   [opts.dir]        override the auto-detected Chatlogs dir
 * @param {string[]} opts.channels     channel names, as they appear in-game
 * @param {string[]} [opts.knownRegions] SDE region names, for MOTD detection
 * @param {Function} opts.onLine       (line, { channel, regions, file }) => void
 * @param {Function} [opts.onChannels] called when the followed file set changes
 */
// How far back a first read may look, in bytes, when backfilling. EVE writes
// UTF-16LE at roughly 150–400 bytes a line, so this covers well over an hour of
// a busy channel; the timestamp filter below is what actually bounds it.
const BACKFILL_MAX_BYTES = 512 * 1024;
// `[ 2026.08.04 13:12:52 ]` — the only part of a line this file needs to read.
const TS_RE = /^﻿?\[\s*(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*\]/;

/** Milliseconds for a log line's own timestamp, or null. EVE logs in UTC. */
function lineTimestamp(line) {
  const m = TS_RE.exec(line);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function createChatlogReader({ dir, channels = [], knownRegions = [], onLine, onChannels,
                               backfillMs = 0 } = {}) {
  const state = new Map();   // channel -> { file, offset, regions, listener }
  let timer = null;
  let baseDir = findChatlogDir(dir);

  function openChannel(ch, file, { fromStart = false } = {}) {
    const header = readHeader(file, knownRegions);
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) {}
    const st = {
      file,
      // Start at the END of an existing file. Replaying a whole session's
      // backlog on startup would fire alerts for gangs that passed hours ago —
      // the one thing an early-warning system must never do. `backfillMs` opens
      // a BOUNDED window on that, and the lines it replays are flagged so the
      // service can rebuild its tracks without alerting on any of them.
      offset:   fromStart ? 0 : size - (size % 2),
      regions:  header.regions,
      listener: header.listener,
    };
    state.set(ch, st);
    if (!fromStart && backfillMs > 0 && size > 0) backfill(ch, st, size);
    return st;
  }

  /**
   * Replay the last `backfillMs` of an existing file, once, on first open.
   *
   * This is what lets a relaunch pick up where it left off: the picture five
   * minutes before a restart is still broadly true, and rebuilding it from the
   * log is better than persisting it, because the log ALSO covers whatever
   * happened while the app was shut. The source of truth stays the source.
   */
  function backfill(ch, st, size) {
    const cutoff = Date.now() - backfillMs;
    const from   = Math.max(0, size - BACKFILL_MAX_BYTES);
    const want   = size - (size % 2) - from;
    if (want <= 0) return;

    let text = '';
    try {
      const fd  = fs.openSync(st.file, 'r');
      const buf = Buffer.alloc(want);
      const n   = fs.readSync(fd, buf, 0, want, from - (from % 2));
      fs.closeSync(fd);
      text = buf.slice(0, n - (n % 2)).toString('utf16le');
    } catch (_) { return; }

    const lines = text.split(/\r?\n/);
    // The first line is very likely cut in half by the seek, and half a report
    // parses as nothing — or worse, as something else.
    if (from > 0) lines.shift();

    for (const line of lines) {
      if (!line.trim()) continue;
      const ts = lineTimestamp(line);
      // No timestamp means a MOTD or join notice, not a report. Undated lines
      // are dropped rather than guessed at — a report with the wrong time would
      // corrupt the very derivative this exists to preserve.
      if (ts == null || ts < cutoff) continue;
      try {
        onLine && onLine(line, { channel: ch, regions: st.regions, file: st.file,
                                 listener: st.listener, backfill: true });
      } catch (e) { console.warn('[intel] backfill handler threw:', e.message); }
    }
  }

  function drain(ch, st) {
    let size;
    try { size = fs.statSync(st.file).size; } catch (_) { return; }
    if (size <= st.offset) {
      // Truncation means the client rewrote the file; start over from the top
      // rather than reading from an offset past its end forever.
      if (size < st.offset) st.offset = 0;
      return;
    }
    const want = size - (size % 2) - st.offset;
    if (want <= 0) return;

    let text = '';
    try {
      const fd  = fs.openSync(st.file, 'r');
      const buf = Buffer.alloc(want);
      const n   = fs.readSync(fd, buf, 0, want, st.offset);
      fs.closeSync(fd);
      const even = n - (n % 2);
      text = buf.slice(0, even).toString('utf16le');
      st.offset += even;
    } catch (e) {
      return;   // locked mid-write; the next tick picks it up
    }

    // A trailing partial line is left for the next read: EVE can flush
    // mid-message and half a report parses as nothing, or worse, as something
    // else. Hold it back until its newline arrives.
    const parts = text.split(/\r?\n/);
    const tail  = parts.pop();
    if (tail && tail.length) st.offset -= Buffer.byteLength(tail, 'utf16le');

    for (const line of parts) {
      if (!line.trim()) continue;
      try { onLine && onLine(line, { channel: ch, regions: st.regions, file: st.file, listener: st.listener }); }
      catch (e) { console.warn('[intel] line handler threw:', e.message); }
    }
  }

  function tick() {
    if (!baseDir) { baseDir = findChatlogDir(dir); if (!baseDir) return; }
    const newest = newestPerChannel(baseDir, channels);
    let changed = false;

    for (const [ch, { file }] of newest) {
      const st = state.get(ch);
      if (!st) { openChannel(ch, file); changed = true; }
      else if (st.file !== file) {
        // Rotation: drain the last of the old file before switching, or the
        // final few reports in it are lost.
        drain(ch, st);
        openChannel(ch, file, { fromStart: true });
        changed = true;
      }
    }
    for (const ch of [...state.keys()]) if (!newest.has(ch)) { state.delete(ch); changed = true; }
    if (changed && onChannels) onChannels(status());

    for (const [ch, st] of state) drain(ch, st);
  }

  function status() {
    return {
      dir: baseDir,
      channels: [...state.entries()].map(([ch, st]) => ({
        channel: ch, file: path.basename(st.file),
        listener: st.listener, regions: st.regions,
      })),
    };
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, POLL_MS);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } state.clear(); },
    setChannels(next) { channels = next || []; state.clear(); tick(); },
    status,
    tick,           // exposed for tests — no waiting on a timer
    get dir() { return baseDir; },
  };
}

/** Channels present in the log directory — what the settings picker offers. */
function discoverChannels(dir) {
  const base = findChatlogDir(dir);
  if (!base) return [];
  const seen = new Map();
  let entries = [];
  try { entries = fs.readdirSync(base); } catch (_) { return []; }
  for (const name of entries) {
    const ch = channelOf(name);
    if (!ch) continue;
    let mtime = 0;
    try { mtime = fs.statSync(path.join(base, name)).mtimeMs; } catch (_) { continue; }
    if (!seen.has(ch) || seen.get(ch) < mtime) seen.set(ch, mtime);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([channel, mtime]) => ({ channel, lastSeen: mtime }));
}

/**
 * Which characters are CURRENTLY LOGGED IN, from the chat logs themselves.
 *
 * The filename carries the character ID (<channel>_<date>_<time>_<charId>.txt)
 * and EVE only writes to a file while that character is in that channel — so a
 * log touched in the last few minutes means that character is online right now.
 *
 * This is better than asking ESI: /characters/{id}/online/ needs a scope most
 * people haven't granted, is cached for a minute, and answers for one character
 * per call. This is free, instant, and covers every client on the machine
 * including alts on other accounts.
 *
 * @param {number} [freshMs] how recently a log must have been written
 * @returns {Array} [{ characterId, lastSeen, channels: [] }] most recent first
 */
function detectOnlineCharacters(dir, freshMs = 10 * 60 * 1000) {
  const base = findChatlogDir(dir);
  if (!base) return [];
  const now = Date.now();
  const byChar = new Map();
  let entries = [];
  try { entries = fs.readdirSync(base); } catch (_) { return []; }

  for (const name of entries) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const charId = Number(m[4]);
    if (!Number.isFinite(charId)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(path.join(base, name)).mtimeMs; } catch (_) { continue; }
    if (now - mtime > freshMs) continue;
    const cur = byChar.get(charId) || { characterId: charId, lastSeen: 0, channels: [] };
    cur.lastSeen = Math.max(cur.lastSeen, mtime);
    if (!cur.channels.includes(m[1])) cur.channels.push(m[1]);
    byChar.set(charId, cur);
  }
  return [...byChar.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

module.exports = {
  createChatlogReader, findChatlogDir, discoverChannels, detectOnlineCharacters,
  channelOf, readHeader, lineTimestamp,
  CANDIDATE_DIRS, POLL_MS, BACKFILL_MAX_BYTES,
};
