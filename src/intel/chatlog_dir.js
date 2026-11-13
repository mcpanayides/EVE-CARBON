'use strict';
//
// One cached listing of EVE's Chatlogs folder, shared by every reader.
//
// WHY THIS EXISTS
//
// EVE writes a new file per channel, per character, per session, and never
// deletes one. Someone running 40 clients collects tens of thousands of them in
// a few months. The intel reader and the Local position watcher each listed that
// folder every second (readdirSync, on the main process) and then statted what
// they found, so the cost of a tick grew with the age of the folder instead of
// with anything the player was doing, and every IPC call from every window
// queued behind it.
//
// HOW IT STAYS CHEAP
//
// A folder's own modification time moves when a file is created inside it, and
// does not move when a file inside it is written to. Checked on NTFS: creating a
// file moves it; appending, and writing through a handle held open the way EVE
// holds its logs, leave it alone. EVE appends all day and creates files only at
// a login or a channel join, so one stat of the folder per tick says whether the
// last listing still stands. A deletion is not guaranteed to move it, so the
// listing is redone every few minutes regardless, and a reader that meets a file
// that has gone simply skips it.
//
// WHAT IT KEEPS
//
// Not every name: the newest two files for each channel and character pair,
// which is all any reader asks for, plus the newest session start per channel.
// Memory follows the number of characters and channels, not the years of logs.

const fs   = require('fs');
const path = require('path');

/** `<channel>_<YYYYMMDD>_<HHMMSS>_<characterID>.txt` */
const FILE_RE = /^(.+)_(\d{8})_(\d{6})_(\d+)\.txt$/;

const PER_PAIR  = 2;                  // newest files kept per channel and character
const RELIST_MS = 5 * 60 * 1000;      // a full re-list even when the folder looks unchanged
const MAX_DIRS  = 4;                  // listings kept, one per folder

// No client session outlives the daily downtime, so a session that STARTED more
// than a day before the newest one in the folder cannot still be writing. Two
// hours of slack covers a clock change and a long downtime.
const LIVE_SESSION_HOURS = 26;

const cache = new Map();              // dir -> listing
let version = 0;

/** Newest first; a tie goes to the later name so the order is stable. */
function keepNewest(list, entry, k) {
  let i = 0;
  while (i < list.length && (list[i].stamp > entry.stamp
         || (list[i].stamp === entry.stamp && list[i].name > entry.name))) i++;
  if (i >= k) return;
  list.splice(i, 0, entry);
  if (list.length > k) list.length = k;
}

function build(dir, names, mtimeMs, now) {
  // lower-cased channel -> { name, newestStamp, byChar: Map(characterId -> [entry, ...]) }
  const channels = new Map();
  let newestStamp = '';
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const characterId = Number(m[4]);
    if (!Number.isFinite(characterId)) continue;
    const stamp = m[2] + m[3];
    const key = m[1].toLowerCase();
    let ch = channels.get(key);
    if (!ch) { ch = { name: m[1], newestStamp: '', byChar: new Map() }; channels.set(key, ch); }
    if (stamp > ch.newestStamp) { ch.newestStamp = stamp; ch.name = m[1]; }
    if (stamp > newestStamp) newestStamp = stamp;
    let list = ch.byChar.get(characterId);
    if (!list) { list = []; ch.byChar.set(characterId, list); }
    keepNewest(list, { name, file: path.join(dir, name), channel: m[1], stamp, characterId }, PER_PAIR);
  }
  return { dir, version: ++version, mtimeMs, listedAt: now, newestStamp, channels };
}

const EMPTY = Object.freeze({ dir: null, version: 0, mtimeMs: 0, listedAt: 0, newestStamp: '', channels: new Map() });

/**
 * The folder's index, re-read only when it has changed.
 * @returns {{version:number, newestStamp:string, channels:Map}} `version` moves on every re-read
 */
function chatlogListing(dir, { now = Date.now() } = {}) {
  if (!dir) return EMPTY;
  let mtimeMs;
  try { mtimeMs = fs.statSync(dir).mtimeMs; } catch (_) { return EMPTY; }
  const cached = cache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs && now - cached.listedAt < RELIST_MS) return cached;
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return cached || EMPTY; }
  const next = build(dir, names, mtimeMs, now);
  cache.delete(dir);
  cache.set(dir, next);
  while (cache.size > MAX_DIRS) cache.delete(cache.keys().next().value);
  return next;
}

/** `YYYYMMDDHHMMSS` as milliseconds. Only ever compared with another stamp. */
function stampMs(stamp) {
  if (!stamp || stamp.length < 14) return NaN;
  return Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8),
                  +stamp.slice(8, 10), +stamp.slice(10, 12), +stamp.slice(12, 14));
}

/** Could a session that started at `stamp` still be running, given the newest one? */
function sessionMayBeLive(stamp, newestStamp) {
  const a = stampMs(stamp), b = stampMs(newestStamp);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return b - a <= LIVE_SESSION_HOURS * 3600 * 1000;
}

/** One channel's entry in a listing, or null. */
function channelIn(listing, channel) {
  return listing.channels.get(String(channel).toLowerCase()) || null;
}

module.exports = {
  chatlogListing, channelIn, sessionMayBeLive, stampMs,
  FILE_RE, PER_PAIR, RELIST_MS, LIVE_SESSION_HOURS,
};
