'use strict';
//
// Turning a line of intel chatter into something the alert engine can reason
// about.
//
// The grammar here is not invented — it is what 12 023 real messages from
// east.imperium and fareast.imperium actually look like:
//
//   Kylrik Elwin Hurtini > YPW-M4 clr
//   Marvin Outamon      > 5M2-KP +4 1 Thorax 4 Myrmydons
//   Livka               > EKPB-3  Cormack Eto  KRISDOX  Tobias Za
//   Chantelle Anne Inkura > Mae Aivo  TK-DLH jumped through ekpb
//   Kouta Yukimura      > 27-HP0 clear (stilleto and cheetah  Wolf Eyes  Imeda Zaur )
//   Rikooo              > SHBF-V* WH
//   Marvin Outamon      > 3 Myrmidon 1 thorax          <- follow-up, no system
//
// Four things fall out of that corpus and drive the design:
//
//  1. NEGATIVE REPORTS ARE THE SECOND-MOST COMMON MESSAGE. "clr" appears 1 271
//     times and "nv" (no visual) 1 089. Reading either as a sighting would have
//     the alert screaming about systems somebody just declared empty. Clears
//     must actively RETRACT a standing report, not be ignored.
//
//  2. WORD ORDER IS FREE. The system can lead, trail, or sit mid-sentence.
//     Position-based parsing does not survive contact with this data.
//
//  3. FOLLOW-UPS DROP THE SYSTEM. A reporter names a system, then adds detail
//     in later messages. Those belong to the same system, so recent context per
//     author is carried forward — the same behaviour RIFT describes as
//     "follows conversations across multiple follow-up messages".
//
//  4. SHIP NAMES ARE MISSPELT CONSTANTLY — "Myrmydons", "stilleto", "myrm".
//     Ship extraction is therefore best-effort colour for the operator, and is
//     never load-bearing for an alert.

// EVE writes: "[ 2026.08.01 18:00:54 ] Marvin Outamon > 5M2-KP +4 1 Thorax"
const LINE_RE = /^\[\s*(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*\]\s*([^>]+?)\s*>\s*(.*)$/;

// "+4", "+20 or so". Bare digits are deliberately NOT counted: "1 Thorax" is a
// ship tally, not a pilot count.
const COUNT_RE  = /(?:^|\s)\+\s?(\d{1,3})\b/;
const CLEAR_RE  = /(?:^|\s)(clr|clear|cleared|nv|no\s+visual|empty)(?:\s|$|[.!,])/i;
const WH_RE     = /(?:^|\s)(wh|wormhole|hole|filament)(?:\s|$)/i;
const CAMP_RE   = /(?:^|\s)(bubble[sd]?|camp(?:ed|ing)?|gate\s?camp|dictor|hictor)(?:\s|$)/i;

// Follow-ups only inherit context this recently. Five minutes is comfortably
// past the observed gap (the Marvin Outamon pair above is 4m52s) while being
// far short of a reporter moving on to somewhere else entirely.
const FOLLOWUP_WINDOW_MS = 5 * 60 * 1000;

/** Split a raw chat-log line into its parts, or null if it isn't a message. */
function parseLine(line) {
  const m = LINE_RE.exec(String(line || '').replace(/﻿/g, '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, author, body] = m;
  return {
    // EVE stamps chat logs in UTC.
    ts: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s),
    author: author.trim(),
    body: body.trim(),
  };
}

/** EVE's own postings (MOTD, join/leave) are not intel. */
function isSystemMessage(parsed) {
  return !parsed || parsed.author === 'EVE System' || !parsed.body;
}

/**
 * Reads a channel's lines into structured reports, holding the per-author
 * context that follow-ups need.
 *
 * @param {object} systemIndex  from src/intel/system_index.js
 * @param {object} [opts]
 * @param {string[]} [opts.regions]  the channel's declared regions (MOTD), used
 *                                   only to disambiguate abbreviations
 */
function createChannelParser(systemIndex, { regions = [], channel = '' } = {}) {
  const lastByAuthor = new Map();   // author -> { systemId, ts }

  /**
   * @returns {object|null} a report, or null for lines that carry no intel
   *   { channel, ts, author, body, systemId, systemName, regionName,
   *     status: 'hostile'|'clear', count, pilots[], ships[], wormhole, camp,
   *     confidence, inherited }
   */
  function ingest(line) {
    const parsed = parseLine(line);
    if (isSystemMessage(parsed)) return null;

    const { ts, author, body } = parsed;
    const matches = systemIndex.matchMessage(body, { regions });
    const isClear = CLEAR_RE.test(body);

    let system = matches[0] || null;
    let inherited = false;

    // No system named — attach it to whatever this author was last talking
    // about, if that was recent enough to still mean the same thing.
    if (!system) {
      const prev = lastByAuthor.get(author);
      if (!prev || ts - prev.ts > FOLLOWUP_WINDOW_MS) return null;
      const sys = systemIndex.get(prev.systemId);
      if (!sys) return null;
      system = { system: sys, confidence: prev.confidence || 'exact' };
      inherited = true;
    } else {
      lastByAuthor.set(author, { systemId: system.system.id, ts, confidence: system.confidence });
    }

    const countMatch = COUNT_RE.exec(body);
    // Hulls first: the words they consume must not be re-read as pilot names.
    const shipHit = extractShips(body, systemIndex);

    return {
      channel,
      ts,
      author,
      body,
      systemId:   system.system.id,
      systemName: system.system.name,
      regionName: system.system.regionName,
      // A clear RETRACTS; anything else naming a system is a sighting. Both
      // matter — see note (1) at the top.
      status:     isClear ? 'clear' : 'hostile',
      count:      countMatch ? Number(countMatch[1]) : null,
      pilots:     extractPilots(body, systemIndex, matches, shipHit.claimed),
      ships:      shipHit.hulls,
      // 'tackle' here is the one that changes what a fleet does — see extractRoles.
      roles:      extractRoles(body, systemIndex),
      wormhole:   WH_RE.test(body),
      camp:       CAMP_RE.test(body),
      confidence: system.confidence,
      inherited,
      // Every system named, so "X jumped from A to B" still marks both.
      allSystemIds: matches.map(m => m.system.id),
    };
  }

  return { ingest, parseLine, get contextSize() { return lastByAuthor.size; } };
}

// Ship mentions, matched against the SDE's published hull list.
//
// Exact (plus plurals) only. Fuzzy matching was measured against the corpus and
// rejected: the near-misses were "here"->Heretic, "are"->Ares, "out"->Outrider,
// "red"->Redeemer — ordinary English words, every one a false positive, for a
// theoretical gain of ~170 occurrences against 3 408 already matched exactly.
// Genuine misspellings ("Myrmydons", "stilleto") simply don't resolve, which is
// the right trade: a missed hull name costs colour, an invented one costs trust.
function extractShips(body, systemIndex) {
  if (systemIndex.matchShips) return systemIndex.matchShips(body);
  const out = new Set();
  for (const raw of String(body).split(/[\s,()[\]/]+/)) {
    const t = systemIndex.normalise(raw);
    if (!t) continue;
    const hull = systemIndex.shipName ? systemIndex.shipName(t) : (systemIndex.isShip(t) ? t : null);
    if (hull) out.add(hull);
  }
  return { hulls: [...out], claimed: new Set(out) };
}

// What the reported ships MEAN, which is the part a mining fleet acts on.
//
// "3 Myrmidons" and "a Sabre" are the same number of hostiles and completely
// different decisions: the first can kill you, the second stops you leaving.
// Roles come from SDE group names plus the handful of role words intel uses
// directly ("dictor", "hic", "bubbled") — see SHIP_ROLE_GROUPS in system_index.
function extractRoles(body, systemIndex) {
  if (!systemIndex.shipRole) return [];
  const out = new Set();
  for (const raw of String(body).split(/[\s,()[\]/]+/)) {
    const role = systemIndex.shipRole(systemIndex.normalise(raw));
    if (role) out.add(role);
  }
  return [...out];
}

// Pilot names matter more than they look: they're what lets the same hostile be
// followed from system to system, which is the whole basis of "inbound" (see
// src/intel/proximity.js). 68% of sightings in the corpus name at least one.
//
// The break that makes this tractable is a formatting convention rather than
// grammar — reporters separate names with DOUBLE spaces:
//
//   EKPB-3  Cormack Eto  KRISDOX  Tobias Za
//
// Splitting on runs of 2+ spaces gets the boundaries right. Single-space
// splitting merged neighbours into "Everett Rockefeller  Wilfred", which then
// tracked as a person who never existed.
function extractPilots(body, systemIndex, systemMatches, shipWords = new Set()) {
  const claimed = new Set(systemMatches.map(m => systemIndex.normalise(m.token)));
  for (const w of shipWords) claimed.add(w);
  const out = [];

  for (let chunk of String(body).split(/\s{2,}|[,()[\]]/)) {
    chunk = chunk.trim();
    if (!chunk) continue;

    // Systems and stopwords are dropped wherever they appear; they are never
    // part of a name.
    let words = chunk.split(/\s+/).filter(w => {
      const k = systemIndex.normalise(w);
      return k && !claimed.has(k) && !systemIndex.STOPWORDS.has(k);
    });

    // Hull names and counts are only stripped from the END of the chunk, which
    // is where people append them: "Mae Aivo thorax", "Wolf Eyes +2".
    //
    // Doing it per-word instead truncated real pilots, because plenty of EVE
    // hulls are ordinary words — "Wolf Eyes" came through as "Eyes" and tracked
    // as a separate hostile, since Wolf is an assault frigate. A ship name in
    // the MIDDLE of a chunk is part of somebody's name.
    const isNoise = (w) => {
      const k = systemIndex.normalise(w);
      return systemIndex.isShip(k) || /^\+?\d+$/.test(k);
    };
    while (words.length && isNoise(words[words.length - 1])) words.pop();
    // A chunk that was nothing but hulls is a ship report, not a pilot.
    if (!words.length) continue;

    if (words.length > 3) continue;   // >3 words is a sentence, not a name
    // A character name starts with a capital and isn't all-caps shouting.
    if (!/^[A-Z]/.test(words[0])) continue;
    const name = words.join(' ');
    if (name.length < 3 || name.length > 37) continue;  // EVE's own name limits
    if (systemIndex.matchToken(name, {})) continue;      // it's a system, not a pilot
    out.push(name);
  }
  return [...new Set(out)];
}

module.exports = {
  createChannelParser, parseLine, isSystemMessage,
  LINE_RE, FOLLOWUP_WINDOW_MS,
};
