// jump_gate_list.js — reading jump gate lists into pairs of systems, and keeping
// the saved networks in step with what EVE reports.
//
// Loaded by the renderer as a <script> tag (window.JumpGateList), by main through
// require() (the hourly read from ESI, src/ipc/jump_gates_ipc.js), and by the
// unit tests. Two networks are kept:
//   • ours: the gates the pilot can use. The planner routes through them and the
//     map draws them green.
//   • theirs: other alliances' gates, which the pilot can't use. The map draws
//     them red and dashed, so a hunter can see where a target's bridge comes out;
//     nothing routes through them.
//
// What it reads, one line at a time:
//   • "A » B" lines. Ansiblex gates are named that way in game, and most alliance
//     lists copy it: "1DQ1-A » 8QT-H4 - Speedway". The other arrows people type
//     (→ ↔ <-> <=> --> -> =>) read the same.
//   • Tab-separated tables with the two systems in the 2nd and 3rd columns, such
//     as the Goonswarm wiki's Webway export:
//       Region  System/POS  System/POS  Status  Owner  Password  Dist (ly)  Route  Friendly
//     A row whose Friendly column says otherwise is another alliance's gate.
//
// Names come back as written. Turning them into system ids is resolveSystem()'s
// job, given the caller's name → id index of the galaxy.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JumpGateList = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // The arrow between two systems. "-->" is listed before "->" so it is taken
  // whole. No system name contains any of these characters, while plenty contain
  // a hyphen (1DQ1-A, MN-Q26), which is why a bare "-" is never an arrow.
  const ARROW_RE = /\s*(?:»|→|↔|<->|<=>|-->|->|=>)\s*/;

  /**
   * The system in a cell: "MN-Q26 @ 1-1" (POS moon notation) → "MN-Q26", and
   * "1DQ1-A - Moon 1 - POS" or "8QT-H4 - Speedway" → the leading name. Only a
   * spaced " - " separates, since hyphens inside names are part of them.
   */
  function cleanSystemName(cell) {
    let s = String(cell || '').trim();
    s = s.split(/\s*@\s*/)[0];
    s = s.split(/\s[-–]\s/)[0];
    return s.trim();
  }

  function fromArrow(text) {
    const m = ARROW_RE.exec(String(text || ''));
    if (!m) return null;
    const a = cleanSystemName(text.slice(0, m.index));
    const b = cleanSystemName(text.slice(m.index + m[0].length));
    return a && b ? { a, b } : null;
  }

  /**
   * One line: { a, b } for a gate, with friendly: false when a table row says it
   * isn't ours; { skip: 'header' } for a table's header; null for anything else
   * (a title, a blank).
   */
  function parseLine(line) {
    const raw = String(line || '').replace(/﻿/g, '');
    if (!raw.trim()) return null;
    if (!raw.includes('\t')) return fromArrow(raw);

    const cols = raw.split('\t');
    // Copied from the game's structure browser, a gate's name comes first and
    // other columns follow. A Webway table starts with the region instead.
    if (ARROW_RE.test(cols[0])) return fromArrow(cols[0]);
    const a = (cols[1] || '').trim(), b = (cols[2] || '').trim();
    if (a && b) {
      if (/^region$/i.test((cols[0] || '').trim()) || /system\s*\/\s*pos/i.test(a)) return { skip: 'header' };
      const pa = cleanSystemName(a), pb = cleanSystemName(b);
      if (!pa || !pb) return null;
      const fr = (cols[8] || '').trim().toLowerCase();
      return fr && !/^(y|yes|true|1|friendly)$/.test(fr) ? { a: pa, b: pb, friendly: false } : { a: pa, b: pb };
    }
    const cell = cols.find(c => ARROW_RE.test(c));
    return cell ? fromArrow(cell) : null;
  }

  /**
   * A whole paste: `pairs` are ours, `theirs` the rows marked not friendly.
   * `unreadable` counts non-blank lines that were neither a gate nor a header:
   * worth showing only when no gate came out at all, since every list has a
   * title or two.
   */
  function parseList(text) {
    const pairs = [], theirs = [];
    let unreadable = 0;
    for (const line of String(text || '').split(/\r?\n/)) {
      const r = parseLine(line);
      if (!r) { if (line.trim()) unreadable++; continue; }
      if (r.skip) continue;
      if (r.friendly === false) theirs.push({ a: r.a, b: r.b });
      else pairs.push(r);
    }
    return { pairs, theirs, unreadable };
  }

  /**
   * A system id for a name, from `index` (lower-case name → id). Falls back to
   * the first and then the last word, so "8QT-H4 [Tunnel]" and "[GSF] 1DQ1-A"
   * still resolve. Null when nothing matches.
   */
  function resolveSystem(name, index) {
    const idx = index || {};
    const look = (k) => (Object.prototype.hasOwnProperty.call(idx, k.toLowerCase()) ? idx[k.toLowerCase()] : null);
    const s = String(name || '').trim();
    if (!s) return null;
    const whole = look(s);
    if (whole != null) return whole;
    const words = s.split(/\s+/);
    if (words.length < 2) return null;
    const first = look(words[0]);
    if (first != null) return first;
    const last = look(words[words.length - 1]);
    return last != null ? last : null;
  }

  /**
   * One parsed gate → [idA, idB], or null. `aId`, the system a structure read
   * from ESI stands in, beats reading it back out of the name, and a gate named
   * the other way round still comes out right.
   */
  function resolvePair(p, index) {
    const a = (p && p.aId && Number(p.aId)) || resolveSystem(p && p.a, index);
    let b = resolveSystem(p && p.b, index);
    if (a && b === a) b = resolveSystem(p.a, index);
    return a && b && a !== b ? [a, b] : null;
  }

  function pairKey(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; }

  /**
   * Adds [idA, idB] pairs to a saved network. A gate is one pair whichever end it
   * is listed from, and a gate to its own system is dropped.
   */
  function addPairs(existing, idPairs) {
    const merged = (Array.isArray(existing) ? existing : []).slice();
    const seen = new Set(merged.map(([a, b]) => pairKey(a, b)));
    let added = 0, dup = 0;
    for (const [a, b] of Array.isArray(idPairs) ? idPairs : []) {
      if (!a || !b || a === b) continue;
      const k = pairKey(a, b);
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      merged.push([a, b]);
      added++;
    }
    return { merged, added, dup };
  }

  /**
   * Gates read from ESI, [{ name, systemId }] per structure, → one pair per gate
   * (each gate stands at both ends), plus what couldn't be read.
   */
  function gatePairs(gates, index) {
    const out = [], seen = new Set(), unresolved = new Set();
    let unreadable = 0;
    for (const g of Array.isArray(gates) ? gates : []) {
      const p = parseLine(g && g.name);
      if (!p || p.skip) { unreadable++; continue; }
      const pair = resolvePair({ ...p, aId: g.systemId }, index);
      if (!pair) { if (!resolveSystem(p.b, index)) unresolved.add(p.b); continue; }
      const k = pairKey(pair[0], pair[1]);
      if (!seen.has(k)) { seen.add(k); out.push(pair); }
    }
    return { pairs: out, unreadable, unresolved: [...unresolved] };
  }

  /**
   * Folds one hourly read from ESI into the saved networks.
   *
   *   friendly  ours as saved: the planner routes through these
   *   other     theirs as saved
   *   last      { mine, theirs }: what ESI gave in the previous round
   *   mine      this round's gates for the character whose gates are ours
   *   theirs    this round's gates seen by the pilot's other characters
   *   complete  every search finished; a round cut short only ever adds
   *
   * A gate ESI reported last round and not this one is gone (destroyed, or no
   * longer open to the pilot) and comes out. A gate pasted by hand was never
   * ESI's and stays. A gate that is ours is never also theirs.
   */
  function applyEsiRound({ friendly = [], other = [], last = {}, mine = [], theirs = [], complete = true } = {}) {
    const keys = (list) => new Set((Array.isArray(list) ? list : []).map(([a, b]) => pairKey(a, b)));
    const mineK = keys(mine);
    const theirsOnly = (Array.isArray(theirs) ? theirs : []).filter(([a, b]) => !mineK.has(pairKey(a, b)));
    const theirsK = keys(theirsOnly);
    const goneMine = new Set(complete ? [...keys(last.mine)].filter(k => !mineK.has(k)) : []);
    const goneTheirs = new Set(complete ? [...keys(last.theirs)].filter(k => !theirsK.has(k)) : []);

    const keptFriendly = (Array.isArray(friendly) ? friendly : []).filter(([a, b]) => !goneMine.has(pairKey(a, b)));
    const f = addPairs(keptFriendly, mine);
    const oursK = keys(f.merged);
    const keptOther = (Array.isArray(other) ? other : [])
      .filter(([a, b]) => !goneTheirs.has(pairKey(a, b)) && !oursK.has(pairKey(a, b)));
    const o = addPairs(keptOther, theirsOnly.filter(([a, b]) => !oursK.has(pairKey(a, b))));
    return {
      friendly: f.merged,
      other: o.merged,
      added: f.added,
      removed: (Array.isArray(friendly) ? friendly.length : 0) - keptFriendly.length,
      otherAdded: o.added,
      otherRemoved: (Array.isArray(other) ? other.length : 0) - keptOther.length,
      // What the next round compares against. After a partial round, what was
      // there before still counts, so a gate isn't forgotten unseen.
      last: complete
        ? { mine: (Array.isArray(mine) ? mine : []).slice(), theirs: theirsOnly }
        : { mine: addPairs(last.mine, mine).merged, theirs: addPairs(last.theirs, theirsOnly).merged },
    };
  }

  return { cleanSystemName, parseLine, parseList, resolveSystem, resolvePair, pairKey, addPairs, gatePairs, applyEsiRound };
});
