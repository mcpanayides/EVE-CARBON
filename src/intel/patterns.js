'use strict';
//
// "They come in the same way, at the same time."
//
// Everything else in the intel system answers where a hostile is RIGHT NOW. This
// answers where they have been in the habit of being — which gate they come
// through, where they go next, and what hour of the day they turn up. That is
// what turns a warning into a plan: an op scheduled around the quiet hours, and
// a scout parked on the gate they actually use rather than the one that looks
// most likely on the map.
//
// THE FAILURE MODE HERE IS DIFFERENT FROM THE REST OF THE TOOL. Elsewhere the
// danger is too many alerts. Here it is a confident claim built out of noise —
// "they always come through YPW-M4" derived from three sightings on one evening.
// An operator who plans an op around that and loses a fleet will never trust the
// tool again, and they would be right not to. So every claim in this file has to
// clear thresholds before it is made at all, and every number is reported with
// the sample it came from.
//
// The specific traps, and what is done about them:
//
//   ONE BIG NIGHT LOOKS LIKE A PATTERN. A 40-man fleet on one evening produces a
//   burst of sightings in one hour, which by raw count buries every other hour.
//   So the primary unit is DISTINCT DAYS, not sightings: an hour counts once per
//   day however busy it was. A pattern that did not repeat across days is not a
//   pattern.
//
//   BUSY SPACE MAKES EVERYTHING LOOK SIGNIFICANT. In active null, hostiles are
//   reported most hours of most days, so "seen on 60% of days" is unremarkable.
//   Each hour is therefore judged against the observed baseline for all hours,
//   not against zero — it has to be at least twice the average AND clear an
//   absolute floor, so the test works in quiet space and busy space alike.
//
//   GAPS IN REPORTING INVENT ROUTES. Intel is written by people watching gates,
//   and they miss systems. A contact seen in A and then in C, with nobody
//   reporting B, is not evidence of an A→C gate. Those hops are kept but flagged,
//   and route analysis uses only transitions between systems that genuinely
//   share a stargate.
//
//   A STITCHED CHAIN WAS NEVER ACTUALLY WALKED. Chaining "most likely next hop"
//   repeatedly produces a plausible corridor that no gang ever flew. So corridors
//   are counted as whole observed walks (n-grams), never assembled from pairwise
//   statistics — every corridor reported was flown end to end, that many times.

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  // A month covers weekly rhythms and forgets the alliance that moved out last
  // quarter. Patterns go stale; remembering forever is its own kind of wrong.
  maxAgeDays: 30,
  // Hard caps so a busy region cannot grow the file without bound. Oldest first.
  maxPresence: 20000,
  maxLegs:     20000,

  // Two sightings of the same contact further apart than this are separate
  // visits, not one continuous roam. Matches the tracker's own TTL.
  walkGapMs: 15 * 60 * 1000,

  // Movements closer together than this are ONE event, however many pilots were
  // named. See countOccasions — this is the unit everything below is counted in.
  occasionGapMs: 5 * 60 * 1000,

  // ── Thresholds below which nothing is claimed ──────────────────────────────
  minDaysObserved:   5,    // days of history before any time-of-day claim at all
  minHourDays:       3,    // an hour must have fired on this many separate days
  minHourShare:      0.35, // …on at least this fraction of observed days
  hourLift:          2,    // …and at least this many times the all-hours average
  minRouteOccasions: 5,    // separate times something left this system
  minRouteShare:     0.5,  // the favoured exit must be at least this dominant
  minRouteDays:      2,    // …taken on at least this many separate days
  minCorridorN:      3,    // separate times a whole route was walked end to end
  maxCorridor:       5,    // longest corridor reported, in systems
  minEntryN:         3,    // separate times a system was where a contact appeared
};

const SAVE_DEBOUNCE_MS = 30_000;

const dayIndex = (ts) => Math.floor(ts / DAY_MS);

/** UTC, deliberately: EVE time is UTC and that is the clock fleets talk in. */
const hourOf    = (ts) => new Date(ts).getUTCHours();
const weekdayOf = (ts) => new Date(ts).getUTCDay();   // 0 = Sunday

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * How many SEPARATE times something happened, given when it was seen.
 *
 * This is the unit every route claim is counted in, and getting it wrong was a
 * bug caught by replaying the real corpus. A gang of six named pilots moving
 * from A to B produces six pilot tracks and therefore six transitions — and a
 * naive count then reports "six out of six went to B, 100%" from what was
 * actually ONE gang moving ONE time. The same over-counting inflates corridors
 * and entry points.
 *
 * So timestamps within `gapMs` of each other collapse to one occasion.
 * Clustered by gap rather than bucketed by clock, because fixed buckets split a
 * gang that happened to move across a boundary into two events.
 */
function countOccasions(timestamps, gapMs) {
  if (!timestamps.length) return 0;
  const t = [...timestamps].sort((a, b) => a - b);
  let n = 1;
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > gapMs) n++;
  return n;
}

/**
 * How often activity fell in each bucket, judged against its own baseline.
 *
 * Counts DISTINCT DAYS per bucket rather than sightings — see the note on "one
 * big night" in the header. Returns every bucket so the caller can draw the
 * whole distribution, with `notable` set only on the ones that clear the bar.
 *
 * @param {Array} rows      [{ t }] — anything with a timestamp
 * @param {Function} bucketOf  ts -> bucket index
 * @param {number} buckets  how many there are (24 hours, 7 weekdays)
 */
function bucketPattern(rows, bucketOf, buckets, opt) {
  const daysPer = Array.from({ length: buckets }, () => new Set());
  const seen    = Array(buckets).fill(0);
  const allDays = new Set();

  for (const r of rows) {
    const b = bucketOf(r.t);
    const d = dayIndex(r.t);
    daysPer[b].add(d);
    seen[b]++;
    allDays.add(d);
  }

  const daysObserved = allDays.size;
  // The average fraction of observed days on which any one bucket sees activity.
  // In quiet space this is near zero and the absolute floor does the work; in
  // busy null it can be a third, and the relative test does.
  const totalHits = daysPer.reduce((a, s) => a + s.size, 0);
  const baseline  = daysObserved ? totalHits / (buckets * daysObserved) : 0;

  const out = [];
  for (let b = 0; b < buckets; b++) {
    const days  = daysPer[b].size;
    const share = daysObserved ? days / daysObserved : 0;
    out.push({
      bucket: b,
      sightings: seen[b],
      days,
      share,
      // How much more often than average — the number worth showing next to a
      // claim, because "on 70% of days" means nothing without knowing the norm.
      lift: baseline > 0 ? share / baseline : 0,
      notable:
        daysObserved >= opt.minDaysObserved &&
        days  >= opt.minHourDays &&
        share >= opt.minHourShare &&
        share >= baseline * opt.hourLift,
    });
  }
  return { buckets: out, daysObserved, baseline };
}

/**
 * Group the flagged hours into consecutive blocks.
 *
 * 19:00, 20:00 and 21:00 are not three findings — they are one evening, and
 * that is how a fleet talks about them. Reported separately they also force the
 * UI into "19:00, 20:00, 21:00 — 10/10 days, 10/10 days, 10/10 days", which
 * makes the reader zip two lists together to learn one thing.
 *
 * Wraps around midnight: UTC prime time straddles it for a good part of the
 * playerbase, and a 23:00–01:00 block split in two reads as unrelated.
 *
 * @param {Array} hours  the 24 buckets from analyse(), in clock order
 * @returns {Array} [{ from, to, label, daysLo, daysHi, hours }] loudest first
 */
function hourBlocks(hours) {
  const notable = (hours || []).filter(h => h.notable);
  const set  = new Set(notable.map(h => h.bucket));
  const byId = new Map(notable.map(h => [h.bucket, h]));
  const used = new Set();
  const blocks = [];

  for (const h of notable) {
    if (used.has(h.bucket)) continue;
    // Rewind to the start of this run, bailing if it circles the whole clock.
    let start = h.bucket;
    for (let i = 0; i < 24; i++) {
      const prev = (start + 23) % 24;
      if (!set.has(prev) || prev === h.bucket) break;
      start = prev;
    }
    const members = [];
    for (let cur = start; set.has(cur) && !used.has(cur); cur = (cur + 1) % 24) {
      used.add(cur);
      members.push(byId.get(cur));
    }
    const hh = (b) => `${String(b).padStart(2, '0')}:00`;
    blocks.push({
      from: members[0].bucket,
      to:   members[members.length - 1].bucket,
      label: members.length === 1 ? hh(members[0].bucket)
                                  : `${hh(members[0].bucket)}–${hh(members[members.length - 1].bucket)}`,
      daysLo: Math.min(...members.map(m => m.days)),
      daysHi: Math.max(...members.map(m => m.days)),
      hours: members.map(m => m.bucket),
    });
  }
  // Loudest first: the block seen on the most days is the one to plan around.
  return blocks.sort((a, b) => b.daysHi - a.daysHi);
}

/**
 * Split one contact's transitions back into separate visits.
 *
 * Legs are stored flat; a contact seen over three evenings is three roams, not
 * one twelve-system walk. Anything separated by more than walkGapMs starts a new
 * walk, which is also what stops a corridor from being stitched across a gap
 * nobody observed.
 *
 * @returns {Array} [{ key, ts, systems: number[], gapped: boolean }]
 */
function buildWalks(legs, opt) {
  const byKey = new Map();
  for (const l of legs) {
    if (!byKey.has(l.k)) byKey.set(l.k, []);
    byKey.get(l.k).push(l);
  }

  const walks = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.t - b.t);
    let cur = null;
    let prevTs = 0;
    for (const l of list) {
      // A gapped hop (the two systems share no stargate, because nobody reported
      // what was in between) ENDS the walk rather than extending it. Carrying on
      // through it would splice two separate stretches into one route that was
      // never flown.
      const contiguous = cur && l.a === cur.systems[cur.systems.length - 1]
                             && l.t - prevTs <= opt.walkGapMs && !l.g;
      if (!contiguous) {
        if (cur && cur.systems.length >= 2) walks.push(cur);
        cur = l.g ? null : { key, ts: l.t, systems: [l.a, l.b] };
      } else {
        cur.systems.push(l.b);
      }
      prevTs = l.t;
    }
    if (cur && cur.systems.length >= 2) walks.push(cur);
  }
  return walks;
}

/**
 * Where a contact in this system tends to go next.
 *
 * Only real gate transitions count, so this is a statement about gates rather
 * than about who happened to be reported where.
 */
function routeStats(legs, opt = DEFAULTS) {
  const out = new Map();   // fromId -> { ts, occasions, to: Map(toId -> {...}) }
  for (const l of legs) {
    if (l.g) continue;                    // gapped hop — not a gate transition
    if (!out.has(l.a)) out.set(l.a, { ts: [], to: new Map() });
    const from = out.get(l.a);
    from.ts.push(l.t);
    if (!from.to.has(l.b)) from.to.set(l.b, { ts: [], days: new Set(), keys: new Set() });
    const t = from.to.get(l.b);
    t.ts.push(l.t);
    t.days.add(dayIndex(l.t));
    t.keys.add(l.k);
  }
  // Collapse gangs moving together into single events — see countOccasions.
  for (const from of out.values()) {
    from.occasions = countOccasions(from.ts, opt.occasionGapMs);
    for (const t of from.to.values()) t.occasions = countOccasions(t.ts, opt.occasionGapMs);
  }
  return out;
}

/**
 * Whole routes that were actually flown, counted as observed n-grams.
 *
 * Never assembled from pairwise "most likely next hop": see the header. A
 * corridor that is wholly contained in a longer reported one is dropped, so the
 * list reads as distinct routes rather than every prefix of the same one.
 */
function corridors(walks, opt) {
  const grams = new Map();   // "a>b>c" -> { systems, ts, days:Set, keys:Set }
  for (const w of walks) {
    for (let len = 3; len <= opt.maxCorridor; len++) {
      for (let i = 0; i + len <= w.systems.length; i++) {
        const seg = w.systems.slice(i, i + len);
        const id  = seg.join('>');
        if (!grams.has(id)) grams.set(id, { systems: seg, ts: [], days: new Set(), keys: new Set() });
        const g = grams.get(id);
        g.ts.push(w.ts);
        g.days.add(dayIndex(w.ts));
        g.keys.add(w.key);
      }
    }
  }
  // A gang of six walking one route is six walks and ONE use of it.
  for (const g of grams.values()) g.n = countOccasions(g.ts, opt.occasionGapMs);

  const kept = [...grams.values()]
    .filter(g => g.n >= opt.minCorridorN && (g.days.size >= 2 || g.keys.size >= 2))
    // Longest first, so containment pruning below keeps the fullest route.
    .sort((a, b) => b.systems.length - a.systems.length || b.n - a.n);

  // Delimiter-padded on BOTH ends before the containment test. Without the
  // padding, system 10>11>12 reads as a sub-path of 110>11>12 — a substring
  // match on numeric ids that happen to share a suffix, which would silently
  // drop a real corridor whenever an id was a suffix of a neighbouring one.
  const bounded = (systems) => `>${systems.join('>')}>`;
  const final = [];
  for (const g of kept) {
    const id = bounded(g.systems);
    if (final.some(f => bounded(f.systems).includes(id))) continue;
    final.push(g);
  }
  return final
    .map(g => ({ systems: g.systems, n: g.n, days: g.days.size, contacts: g.keys.size }))
    .sort((a, b) => b.n - a.n);
}

/** Systems where contacts first show up — literally "where they come from". */
function entryPoints(walks, opt) {
  const first = new Map();
  for (const w of walks) {
    const id = w.systems[0];
    if (!first.has(id)) first.set(id, { ts: [], days: new Set(), keys: new Set() });
    const e = first.get(id);
    e.ts.push(w.ts);
    e.days.add(dayIndex(w.ts));
    e.keys.add(w.key);
  }
  return [...first.entries()]
    .map(([systemId, e]) => ({
      systemId,
      n: countOccasions(e.ts, opt.occasionGapMs),   // one gang arriving is one arrival
      days: e.days.size, contacts: e.keys.size,
    }))
    .filter(e => e.n >= opt.minEntryN)
    .sort((a, b) => b.n - a.n);
}

/**
 * The history behind all of the above, kept small and forgetful.
 *
 * `load` and `save` are injected so the analysis can be tested without touching
 * a filesystem, and so the caller decides where it lives and how it is written.
 *
 * @param {object} deps
 * @param {Function} [deps.load]  () => { presence, legs } | null
 * @param {Function} [deps.save]  (snapshot) => void — may be async; never awaited
 */
function createPatternStore({ load, save, options } = {}) {
  const opt = { ...DEFAULTS, ...(options || {}) };
  let presence = [];   // { t, s, n }        — hostiles seen in a system
  let legs     = [];   // { t, a, b, k, g }  — one contact moving a -> b
  let routes   = null; // memoised routeStats, invalidated on write
  let saveTimer = null;
  let loaded = false;
  // The newest timestamp ever recorded. On relaunch the chat log is replayed to
  // rebuild the live tracks, and those replayed lines are the SAME sightings
  // this store already counted before the restart — without this they would be
  // counted twice, and a habit measured in "separate occasions" would drift
  // upward every time the app was restarted.
  let lastNotedTs = 0;

  function hydrate() {
    if (loaded) return;
    loaded = true;
    let data = null;
    try { data = load && load(); } catch (e) { data = null; }
    // A corrupt or hand-edited file must cost the history, never the launch.
    if (data && Array.isArray(data.presence)) {
      presence = data.presence.filter(r => r && Number.isFinite(r.t) && Number.isFinite(r.s));
    }
    if (data && Array.isArray(data.legs)) {
      legs = data.legs.filter(r => r && Number.isFinite(r.t) && Number.isFinite(r.a) && Number.isFinite(r.b));
    }
    lastNotedTs = Number.isFinite(data && data.lastNotedTs) ? data.lastNotedTs : 0;
    for (const r of presence) if (r.t > lastNotedTs) lastNotedTs = r.t;
    for (const r of legs)     if (r.t > lastNotedTs) lastNotedTs = r.t;
    prune();
  }

  function prune(now = Date.now()) {
    const cutoff = now - opt.maxAgeDays * DAY_MS;
    const fresh  = (r) => r.t >= cutoff;
    if (presence.some(r => !fresh(r))) presence = presence.filter(fresh);
    if (legs.some(r => !fresh(r)))     legs     = legs.filter(fresh);
    if (presence.length > opt.maxPresence) presence = presence.slice(-opt.maxPresence);
    if (legs.length > opt.maxLegs)         legs     = legs.slice(-opt.maxLegs);
    routes = null;
  }

  function scheduleSave() {
    if (saveTimer || !save) return;
    // Debounced: a busy channel produces sightings continuously, and rewriting
    // the file on each one would be a megabyte of disk churn per minute for data
    // nobody reads until the operator opens the panel.
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, SAVE_DEBOUNCE_MS);
    if (saveTimer.unref) saveTimer.unref();
  }

  function flush() {
    if (!save) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { save({ version: 1, presence, legs, lastNotedTs }); }
    catch (e) { console.warn('[intel] pattern history save failed:', e.message); }
  }

  /**
   * One accepted sighting from the proximity tracker.
   *
   * Fed from the tracker rather than from raw reports because the tracker has
   * already collapsed the six people who reported the same gang across four
   * channels into one sighting. Counting the raw lines instead would make an
   * hour look busy in proportion to how many people were awake to type.
   */
  function noteSighting({ ts, kind, key, systemId, prevSystemId, adjacent, size } = {}) {
    if (!Number.isFinite(ts) || !Number.isFinite(systemId)) return;
    hydrate();
    // Already counted, in this session or a previous one — see lastNotedTs.
    if (ts <= lastNotedTs) return;

    lastNotedTs = ts;

    // Presence comes off the SYSTEM track: exactly one per system per sighting,
    // whether the report named nobody or twelve people.
    let changed = false;
    if (kind === 'system') {
      presence.push({ t: ts, s: systemId, n: size || 0 });
      if (presence.length > opt.maxPresence) presence.shift();
      changed = true;
    }

    // Movement only exists on PILOT tracks — a system track never leaves its own
    // system, so its "previous system" is always itself.
    if (kind === 'pilot' && Number.isFinite(prevSystemId) && prevSystemId !== systemId) {
      legs.push({ t: ts, a: prevSystemId, b: systemId, k: key, ...(adjacent ? {} : { g: 1 }) });
      if (legs.length > opt.maxLegs) legs.shift();
      routes = null;
      changed = true;
    }
    // Most pilot sightings are a name reported again in the system it was
    // already in, and record nothing. Scheduling a write for those would rewrite
    // the whole file every 30 seconds to save data identical to what is there.
    if (changed) scheduleSave();
  }

  function stats() {
    hydrate();
    if (!routes) routes = routeStats(legs, opt);
    return routes;
  }

  /**
   * Where a contact in this system will probably go next, or null.
   *
   * Null is the common and correct answer: most systems have never been seen
   * enough times to say anything, and inventing a heading for them is exactly
   * the failure this file is written to avoid.
   */
  function predictNext(systemId) {
    const from = stats().get(systemId);
    if (!from || from.occasions < opt.minRouteOccasions) return null;
    let best = null;
    for (const [toId, t] of from.to) {
      if (!best || t.occasions > best.n) best = { systemId: toId, n: t.occasions, days: t.days.size };
    }
    if (!best) return null;
    // Both tests matter and neither implies the other. A dominant share says
    // they have a favourite gate; separate days say it is a habit rather than
    // one evening's fleet movement replayed from several pilots' tracks.
    if (best.days < opt.minRouteDays) return null;
    const share = best.n / from.occasions;
    if (share < opt.minRouteShare) return null;   // no favourite — say nothing
    return { ...best, share, outOf: from.occasions };
  }

  /**
   * Everything the patterns panel shows.
   *
   * @param {Function} [systemNameFor]  id -> name, for display
   */
  function analyse({ now = Date.now(), systemNameFor } = {}) {
    hydrate();
    prune(now);
    const name = (id) => {
      const n = systemNameFor && systemNameFor(id);
      return n || `System ${id}`;
    };

    const hours    = bucketPattern(presence, hourOf,    24, opt);
    const weekdays = bucketPattern(presence, weekdayOf, 7,  opt);
    const walks    = buildWalks(legs, opt);
    const hourRows = hours.buckets.map(b => ({ ...b, label: `${String(b.bucket).padStart(2, '0')}:00` }));

    return {
      // Stated up front and shown in the UI: every claim below is only as good
      // as this, and the operator gets to see it rather than infer it.
      daysObserved: hours.daysObserved,
      sightings:    presence.length,
      movements:    legs.length,
      gapped:       legs.filter(l => l.g).length,
      walks:        walks.length,
      // Enough to start claiming anything?
      ready: hours.daysObserved >= opt.minDaysObserved,
      minDaysObserved: opt.minDaysObserved,

      hours: hourRows,
      weekdays: weekdays.buckets.map(b => ({ ...b, label: WEEKDAY_NAMES[b.bucket] })),
      hourBaseline: hours.baseline,
      // Consecutive flagged hours, already grouped — the renderer formats these
      // into a sentence and does no analysis of its own.
      hourBlocks: hourBlocks(hourRows),

      corridors: corridors(walks, opt).map(c => ({
        ...c, names: c.systems.map(name),
      })),
      entries: entryPoints(walks, opt).map(e => ({ ...e, name: name(e.systemId) })),
    };
  }

  return {
    noteSighting, analyse, predictNext, flush,
    /** Drop the history — for a move to new space, where none of it holds. */
    clear() { hydrate(); presence = []; legs = []; routes = null; lastNotedTs = 0; flush(); },
    snapshot() { hydrate(); return { version: 1, presence, legs, lastNotedTs }; },
    get size() { hydrate(); return { presence: presence.length, legs: legs.length }; },
  };
}

module.exports = {
  createPatternStore, bucketPattern, hourBlocks, buildWalks, routeStats, corridors,
  entryPoints, countOccasions, DEFAULTS, WEEKDAY_NAMES, SAVE_DEBOUNCE_MS,
};
