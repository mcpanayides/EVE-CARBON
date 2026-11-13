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
//     "inbound" logic depends on. One copy per channel is followed, and KEPT
//     while its client keeps writing it. "The most recently written copy" does
//     not hold still: with several clients in a channel it changes hands with
//     every message, and switching on each change re-read whole files and
//     handed the same messages on again and again (two clients, 20 messages:
//     243 lines). A switch now happens only when the followed copy's client
//     stops writing (it logged off, or left the channel), and reading resumes
//     straight after the last line already read, found in the other copy by
//     the line itself.
//
//  3. THE CLIENT APPENDS WHILE WE READ. fs.watch on an actively-appended file
//     is unreliable on Windows (and the file is held open by EVE), so this
//     polls size via stat and reads only the new bytes. The folder itself is
//     listed only when it gains a file (chatlog_dir.js), not every second.
//
// Reads are clamped to an EVEN byte offset: UTF-16 is two bytes per unit, and
// a read that lands mid-unit corrupts the character across the boundary.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { chatlogListing, channelIn, sessionMayBeLive, FILE_RE } = require('./chatlog_dir');

// EVE has never been consistent about where Documents lives, and OneDrive
// redirection moves it again. Checked in order; the first that exists wins.
const CANDIDATE_DIRS = [
  ['Documents', 'EVE', 'logs', 'Chatlogs'],
  ['OneDrive', 'Documents', 'EVE', 'logs', 'Chatlogs'],
  ['OneDrive', 'Dokumente', 'EVE', 'logs', 'Chatlogs'],   // localized Windows
  ['OneDrive - Personal', 'Documents', 'EVE', 'logs', 'Chatlogs'],
];

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
// How often the followed copy of each channel is weighed against the other
// clients' copies (and at once whenever the folder gains a file).
const PICK_MS = 5000;
// A copy this far behind the newest has stopped being written: its client logged
// off or left. Comfortably longer than EVE takes to flush a line to every copy.
const STALE_MS = 10000;
// Dated lines remembered per channel, to recognise them in another copy.
const RECENT_LINES = 400;
// How much of a copy is read to remember on opening it, and to find our place
// in it on switching. A switch only ever crosses seconds of chat.
const RECENT_SEED_BYTES = 64 * 1024;
const CATCHUP_MAX_BYTES = 256 * 1024;

/** A line as remembered: a BOM and trailing whitespace are not part of the message. */
const lineKey = (line) => line.replace(/﻿/g, '').trim();
// `[ 2026.08.04 13:12:52 ]` — the only part of a line this file needs to read.
const TS_RE = /^﻿?\[\s*(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*\]/;

/** Milliseconds for a log line's own timestamp, or null. EVE logs in UTC. */
function lineTimestamp(line) {
  const m = TS_RE.exec(line);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function createChatlogReader({ dir, channels = [], knownRegions = [], onLine, onChannels,
                               backfillMs = 0, pickMs = PICK_MS } = {}) {
  // channel -> { file, offset, regions, listener, characterId, stamp,
  //              recent, seen, lastTs }   (recent/seen/lastTs: what was already read)
  const state = new Map();
  let timer = null;
  let baseDir = findChatlogDir(dir);
  let pickedVersion = -1;
  let pickedAt = 0;

  /**
   * Note a line as read. Only dated lines: the header every copy of a channel
   * starts with is the same in all of them, so lining up on it would replay a
   * whole copy. A message carries its time and speaker, and that is unique.
   */
  function remember(st, line) {
    const ts = lineTimestamp(line);
    if (ts == null) return;
    const key = lineKey(line);
    st.recent.push(key);
    st.seen.set(key, (st.seen.get(key) || 0) + 1);
    if (st.recent.length > RECENT_LINES) {
      const old = st.recent.shift();
      const n = st.seen.get(old) - 1;
      if (n > 0) st.seen.set(old, n); else st.seen.delete(old);
    }
    if (st.lastTs == null || ts > st.lastTs) st.lastTs = ts;
  }

  /** Lines of [from, to); the first is dropped when `from` lands mid-file. null if unreadable. */
  function readLines(file, from, to) {
    if (to - from <= 0) return [];
    try {
      const fd  = fs.openSync(file, 'r');
      const buf = Buffer.alloc(to - from);
      const n   = fs.readSync(fd, buf, 0, to - from, from);
      fs.closeSync(fd);
      const lines = buf.slice(0, n - (n % 2)).toString('utf16le').split(/\r?\n/);
      if (from > 0) lines.shift();
      return lines;
    } catch (_) { return null; }
  }

  function openChannel(ch, entry) {
    const file = entry.file;
    const header = readHeader(file, knownRegions);
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) {}
    const end = size - (size % 2);
    const st = {
      file,
      // Start at the END of an existing file. Replaying a whole session's
      // backlog on startup would fire alerts for gangs that passed hours ago —
      // the one thing an early-warning system must never do. `backfillMs` opens
      // a BOUNDED window on that, and the lines it replays are flagged so the
      // service can rebuild its tracks without alerting on any of them.
      offset:      end,
      regions:     header.regions,
      listener:    header.listener,
      characterId: entry.characterId,
      stamp:       entry.stamp,
      recent: [], seen: new Map(), lastTs: null,
    };
    state.set(ch, st);
    // What the file already holds counts as read, so another client's copy can
    // be lined up against it later. Read, not handed on.
    let from = Math.max(0, end - RECENT_SEED_BYTES);
    from -= from % 2;
    const lines = readLines(file, from, end) || [];
    lines.pop();                                   // '' after the last newline, or a line still being written
    for (const line of lines) remember(st, line);
    if (backfillMs > 0 && size > 0) backfill(ch, st, size);
    return st;
  }

  /**
   * Follow another copy of a channel without losing or repeating a line.
   *
   * Every client in a channel writes its own copy of the same messages. The new
   * copy is read back from its tail to the last line already read, and only what
   * follows is handed on. A relog's new file shares no messages with the old
   * session, so all of it is new. A copy that can't be placed at all is joined at
   * its end: missing a few seconds beats replaying an hour as if it were live.
   */
  function switchTo(ch, st, entry, { relog = false } = {}) {
    drain(ch, st);                                 // the last of the old copy first
    let size = 0;
    try { size = fs.statSync(entry.file).size; } catch (_) { return false; }
    const end = size - (size % 2);
    let from = Math.max(0, end - CATCHUP_MAX_BYTES);
    from -= from % 2;
    const lines = readLines(entry.file, from, end);
    if (!lines) return false;                      // locked mid-write; the next pick tries again
    const header = readHeader(entry.file, knownRegions);
    const tail = lines.pop();
    let offset = end;
    if (tail && tail.length) offset -= Buffer.byteLength(tail, 'utf16le');

    let start = lines.length;                      // by default, nothing to hand on
    let last = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (st.seen.has(lineKey(lines[i]))) { last = i; break; }
    }
    if (last >= 0) start = last + 1;
    else if (relog && from === 0) start = 0;
    else if (st.lastTs != null) {
      const i = lines.findIndex(l => { const ts = lineTimestamp(l); return ts != null && ts > st.lastTs; });
      if (i >= 0) start = i;
    }

    Object.assign(st, { file: entry.file, offset, regions: header.regions, listener: header.listener,
                        characterId: entry.characterId, stamp: entry.stamp });
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || st.seen.has(lineKey(line))) continue;   // blank, or in both copies
      remember(st, line);
      try { onLine && onLine(line, { channel: ch, regions: st.regions, file: st.file, listener: st.listener }); }
      catch (e) { console.warn('[intel] line handler threw:', e.message); }
    }
    return true;
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
      remember(st, line);
      try { onLine && onLine(line, { channel: ch, regions: st.regions, file: st.file, listener: st.listener }); }
      catch (e) { console.warn('[intel] line handler threw:', e.message); }
    }
  }

  /**
   * Which copy each channel follows. Runs when the folder gains a file and every
   * `pickMs` otherwise: deciding means statting each client's copy, which is
   * worth doing every few seconds, not every second.
   */
  function pick(listing) {
    let changed = false;
    const present = new Set();
    for (const wanted of channels) {
      const info = channelIn(listing, wanted);
      if (!info) continue;
      const ch = info.name;
      present.add(ch);
      let st = state.get(ch);

      // The same character in a newer session: a relog, or a rejoin. Its old
      // file has stopped; follow the new one from its first line.
      if (st) {
        const own = info.byChar.get(st.characterId);
        if (own && own[0].file !== st.file && own[0].stamp > st.stamp) {
          if (switchTo(ch, st, own[0], { relog: true })) changed = true;
          continue;
        }
      }

      // Each character's newest copy, from sessions that could still be running.
      let newest = null;
      for (const list of info.byChar.values()) {
        const c = list[0];
        if (!sessionMayBeLive(c.stamp, info.newestStamp)) continue;
        let mtime;
        try { mtime = fs.statSync(c.file).mtimeMs; } catch (_) { continue; }
        if (!newest || mtime > newest.mtime) newest = { entry: c, mtime };
      }
      if (!newest) continue;
      if (!st) { openChannel(ch, newest.entry); changed = true; continue; }
      if (newest.entry.file === st.file) continue;

      // Another client wrote last, which with several clients in a channel is
      // true after almost every message. Stay while our copy keeps up; move only
      // once it has fallen well behind, which means its client has stopped.
      let ours = -Infinity;
      try { ours = fs.statSync(st.file).mtimeMs; } catch (_) { /* gone: move */ }
      if (newest.mtime - ours > STALE_MS && switchTo(ch, st, newest.entry)) changed = true;
    }
    for (const ch of [...state.keys()]) if (!present.has(ch)) { state.delete(ch); changed = true; }
    if (changed && onChannels) onChannels(status());
  }

  function tick() {
    if (!baseDir) { baseDir = findChatlogDir(dir); if (!baseDir) return; }
    const listing = chatlogListing(baseDir);
    const now = Date.now();
    if (listing.version !== pickedVersion || now - pickedAt >= pickMs) {
      pick(listing);
      pickedVersion = listing.version;
      pickedAt = now;
    }
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
    setChannels(next) { channels = next || []; state.clear(); pickedVersion = -1; tick(); },
    status,
    tick,           // exposed for tests — no waiting on a timer
    get dir() { return baseDir; },
  };
}

/** Channels present in the log directory — what the settings picker offers. */
function discoverChannels(dir) {
  const base = findChatlogDir(dir);
  if (!base) return [];
  const out = [];
  // Each character's newest copies only: one or two stats per character in a
  // channel, where this used to stat every log file ever written.
  for (const info of chatlogListing(base).channels.values()) {
    let lastSeen = 0;
    for (const list of info.byChar.values()) {
      for (const e of list) {
        try { lastSeen = Math.max(lastSeen, fs.statSync(e.file).mtimeMs); } catch (_) { /* gone */ }
      }
    }
    if (lastSeen) out.push({ channel: info.name, lastSeen });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
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
// Asked again on every jump of every character (intel_ipc rebroadcasts the
// monitor list on each position change), so a fleet moving together asks dozens
// of times in a second. The answer is "written in the last ten minutes": five
// seconds old is as good as new.
const ONLINE_CACHE_MS = 5000;
const onlineCache = new Map();          // `${dir}|${freshMs}` -> { at, result }

function detectOnlineCharacters(dir, freshMs = 10 * 60 * 1000) {
  const base = findChatlogDir(dir);
  if (!base) return [];
  const now = Date.now();
  const key = `${base}|${freshMs}`;
  const hit = onlineCache.get(key);
  if (hit && now - hit.at < ONLINE_CACHE_MS) return hit.result.map(c => ({ ...c, channels: [...c.channels] }));

  const listing = chatlogListing(base);
  const byChar = new Map();
  // A character's newest file in each channel is the one its client is writing,
  // and only a session that could still be running can have been written in the
  // last ten minutes. This used to stat every log file in the folder.
  for (const info of listing.channels.values()) {
    for (const [charId, list] of info.byChar) {
      const e = list[0];
      if (!sessionMayBeLive(e.stamp, listing.newestStamp)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(e.file).mtimeMs; } catch (_) { continue; }
      if (now - mtime > freshMs) continue;
      const cur = byChar.get(charId) || { characterId: charId, lastSeen: 0, channels: [] };
      cur.lastSeen = Math.max(cur.lastSeen, mtime);
      if (!cur.channels.includes(e.channel)) cur.channels.push(e.channel);
      byChar.set(charId, cur);
    }
  }
  const result = [...byChar.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  onlineCache.set(key, { at: now, result });
  if (onlineCache.size > 8) onlineCache.delete(onlineCache.keys().next().value);
  return result.map(c => ({ ...c, channels: [...c.channels] }));
}

module.exports = {
  createChatlogReader, findChatlogDir, discoverChannels, detectOnlineCharacters,
  channelOf, readHeader, lineTimestamp,
  CANDIDATE_DIRS, POLL_MS, BACKFILL_MAX_BYTES,
};
