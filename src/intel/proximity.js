'use strict';
//
// "Is it coming for us, and how long have we got?"
//
// Most intel tools answer a simpler question: is a hostile within N jumps. That
// is a fine tripwire for a roaming gang, but it's the wrong question for the
// case this was built for — a mining fleet with Hulks sieged into a belt, or an
// Orca that needs a minute of warning to align and go. Those fleets can't react
// to "something exists 5 jumps away"; that's true most of the time in null.
//
// What actually matters is the DERIVATIVE. A hostile seen at 6 jumps, then 4,
// then 3, is inbound and has told you its speed. A hostile bouncing between 5
// and 6 is ratting and can be ignored. Same raw distance, opposite decision —
// and it's the difference between an alert people act on and one they mute.
//
// So this tracks each hostile's distance OVER TIME per system, and reports:
//
//   jumps        how far out, now
//   closing      jumps closed since first sighting (negative = leaving)
//   jumpsPerMin  observed transit rate for this contact
//   etaSeconds   jumps / rate — the number a fleet commander actually needs
//
// A gate-to-gate jump for a roaming gang is roughly 20-40s including align and
// session change, so a contact 3 out is ~90s away. That is exactly the margin
// the request described: enough to break siege and get barges off grid.

// Fallback when a contact hasn't been seen often enough to measure its speed.
// Deliberately pessimistic — an interceptor moves far quicker than this, and
// the cost of over-estimating the time you have is barges dying on grid.
const DEFAULT_JUMPS_PER_MIN = 2.0;

// Sightings older than this stop counting toward a track. A hostile reported
// 20 minutes ago tells you nothing about where it is now.
const TRACK_TTL_MS = 15 * 60 * 1000;

// Two sightings in the same system moments apart are the same report echoed by
// several people across several channels — not evidence of movement.
const MIN_LEG_MS = 15 * 1000;

// Gang size bands. A solo roamer, a 10-man gang and a 40-man fleet are three
// completely different problems for a mining op: the first is a nuisance, the
// second kills stragglers, the third means the op is over and everyone goes
// home. Sizing is what turns "hostiles nearby" into a decision.
const GANG_BANDS = [
  { max: 1,        band: 'solo'  },
  { max: 14,       band: 'small' },   // < 15
  { max: 30,       band: 'large' },   // 15-30
  { max: Infinity, band: 'fleet' },   // > 30 — this one gets its own warning
];

/** Band name for a head count, or null when nothing has been reported. */
function gangBand(size) {
  if (!Number.isFinite(size) || size < 1) return null;
  for (const b of GANG_BANDS) if (size <= b.max) return b.band;
  return 'fleet';
}

/**
 * Breadth-first jump distances from one system across the stargate graph.
 *
 * BFS rather than Dijkstra because every gate jump costs the same; the map's
 * _routeDijkstra exists for weighted routing (avoiding low-sec, preferring
 * safety) and is the wrong tool for "how far is this".
 *
 * @param {Map<number, number[]>} adjacency  systemId -> neighbouring systemIds
 * @param {number} originId
 * @param {number} [maxJumps]  stop expanding past here — the whole galaxy is
 *                             never needed and this keeps it to a few ms
 * @returns {Map<number, number>} systemId -> jumps
 */
function jumpDistances(adjacency, originId, maxJumps = 12) {
  const dist = new Map([[originId, 0]]);
  if (!adjacency.has(originId)) return dist;
  let frontier = [originId];
  for (let d = 1; d <= maxJumps && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of (adjacency.get(id) || [])) {
        if (dist.has(nb)) continue;
        dist.set(nb, d);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return dist;
}

/** Adjacency from the SDE's jump rows. Gates are bidirectional. */
function buildAdjacency(jumps) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const j of jumps) {
    const a = j.from ?? j.fromSolarSystemID, b = j.to ?? j.toSolarSystemID;
    if (a == null || b == null) continue;
    link(a, b); link(b, a);
  }
  return adj;
}

/**
 * Tracks contacts and works out which are actually inbound.
 *
 * One tracker per fleet position. Call setOrigin() when the fleet moves — it
 * recomputes distances, which is the only expensive operation here.
 */
// How a contact is identified across sightings.
//
// Keying on the SYSTEM alone cannot express approach at all: a gang moving
// A -> B -> C becomes three unrelated tracks, each with one sighting and no
// vector, and "closing" is structurally always zero. That was the first cut of
// this file, and replaying the corpus through it produced 510 alerts of which
// exactly none knew which way anything was pointed.
//
// Keying on the PILOT is what makes the derivative real. 68% of sightings name
// someone, and in the corpus 312 names appear in more than one system —
// Abyssal Triglav crossed 10 systems in 46 minutes, which is a roaming gang
// with a measurable speed and heading.
//
// Both are kept: named pilots give movement tracks, and unnamed sightings still
// hold a system-level track so a bare "5M2-KP +4" is not thrown away.
const pilotKey  = (name)     => 'p:' + String(name).toLowerCase();
const systemKey = (systemId) => 's:' + systemId;

function createProximityTracker({ adjacency, maxJumps = 12, onSighting } = {}) {
  // MULTIPLE origins, not one. A pilot flying a mining op has a barge in the
  // belt, an Orca on grid and a scout two systems out, and the warning that
  // matters is "something is closing on ANY of them". Measuring from a single
  // character means the alert is silent for the barge that's actually in danger
  // whenever the selected character happens to be somewhere safe.
  let origins = [];              // [{ key, label, systemId }]
  let distByOrigin = new Map();  // origin key -> Map(systemId -> jumps)
  // key -> { label, kind, sightings: [{ts, jumps, systemId, systemName, near}] }
  const tracks = new Map();

  /**
   * Set the monitored positions — usually one per selected character.
   *
   * @param {Array} list [{ key, label, systemId }]
   * @returns {number} systems within reach of at least one origin
   */
  function setOrigins(list) {
    origins = (list || []).filter(o => o && o.systemId != null)
      .map(o => ({ key: String(o.key ?? o.systemId), label: o.label || String(o.systemId), systemId: o.systemId }));
    distByOrigin = new Map();
    const union = new Set();
    for (const o of origins) {
      const d = jumpDistances(adjacency, o.systemId, maxJumps);
      distByOrigin.set(o.key, d);
      for (const id of d.keys()) union.add(id);
    }
    rebaseTracks();
    return union.size;
  }

  /**
   * Re-measure every stored sighting against the CURRENT origins.
   *
   * A sighting records how far away something was from where the fleet stood at
   * the time. Move the fleet and every one of those numbers is in the old frame,
   * while new sightings arrive in the new one — and `closing`, which is just the
   * difference between the first and the last, then compares two different
   * rulers. A fleet that jumped three systems toward a quiet contact would read
   * as that contact charging at them.
   *
   * It matters far more now than it used to: distances survive a restart, and
   * the character has usually MOVED while the app was shut.
   */
  function rebaseTracks() {
    for (const [key, t] of tracks) {
      const kept = [];
      for (const s of t.sightings) {
        const near = nearestTo(s.systemId);
        if (!near) continue;                 // now beyond every origin's horizon
        kept.push({ ...s, jumps: near.jumps, near: near.origin ? near.origin.label : null });
      }
      if (kept.length) t.sightings = kept;
      else tracks.delete(key);
    }
  }

  /** Single-origin convenience — the common case, and what the tests use. */
  function setOrigin(systemId) {
    return systemId == null ? setOrigins([]) : setOrigins([{ key: 'origin', label: 'Fleet', systemId }]);
  }

  /**
   * Distance to the CLOSEST monitored position, and which one that is.
   * Null when the system is beyond every origin's horizon.
   */
  function nearestTo(systemId) {
    let best = null;
    for (const o of origins) {
      const d = distByOrigin.get(o.key)?.get(systemId);
      if (d === undefined) continue;
      if (!best || d < best.jumps) best = { jumps: d, origin: o };
    }
    return best;
  }

  /** Jumps from the nearest monitored position, or null if out of range. */
  function jumpsTo(systemId) {
    const n = nearestTo(systemId);
    return n ? n.jumps : null;
  }

  function prune(now) {
    for (const [key, t] of tracks) {
      t.sightings = t.sightings.filter(s => now - s.ts <= TRACK_TTL_MS);
      if (!t.sightings.length) tracks.delete(key);
    }
  }

  function record(key, label, kind, report, near) {
    let t = tracks.get(key);
    if (!t) { t = { label, kind, sightings: [] }; tracks.set(key, t); }
    const prev = t.sightings[t.sightings.length - 1];
    // Same system moments apart is the same contact echoed by several reporters
    // across several channels, not movement. But a DIFFERENT system always
    // counts — that's the gang actually jumping, which is the signal.
    if (prev && report.systemId === prev.systemId && report.ts - prev.ts < MIN_LEG_MS) return t;
    // Size evidence, from two independent sources that each undercount alone:
    //   • an explicit "+12" in the report
    //   • how many DISTINCT pilots have been named for this contact
    // Reporters rarely list every pilot AND give a count, so the larger of the
    // two is the better estimate. Both only ever grow within a track's lifetime
    // — a gang doesn't shrink because the next reporter typed fewer names.
    if (Number.isFinite(report.count) && report.count > (t.maxCount || 0)) t.maxCount = report.count;
    if (report.pilots && report.pilots.length) {
      t.pilotsSeen = t.pilotsSeen || new Set();
      for (const pn of report.pilots) t.pilotsSeen.add(String(pn).toLowerCase());
    }
    // Roles accumulate across the track: a gang reported as "sabre" once and
    // "3 myrms" later is still a tackle gang.
    if (report.roles && report.roles.length) {
      t.roles = t.roles || new Set();
      for (const r of report.roles) t.roles.add(r);
    }
    if (report.ships && report.ships.length) {
      t.ships = t.ships || new Set();
      for (const sh of report.ships) t.ships.add(sh);
    }
    t.sightings.push({
      ts: report.ts, jumps: near.jumps,
      systemId: report.systemId, systemName: report.systemName,
      // Which monitored character this sighting was closest to — so the alert
      // can say WHO is in danger, not just how far away something is.
      near: near.origin ? near.origin.label : null,
    });

    // Long-term history is fed from HERE rather than from raw reports, because
    // by this point the six people who reported the same gang across four
    // channels have already been collapsed into one sighting. Counting the raw
    // lines instead would make an hour look busy in proportion to how many
    // people happened to be awake to type.
    if (onSighting) {
      const prevSystemId = prev ? prev.systemId : null;
      onSighting({
        ts: report.ts, kind, key, label,
        systemId: report.systemId,
        prevSystemId,
        // Whether the two systems actually share a stargate. Intel is sparse and
        // reporters miss systems, so a contact seen in A and then C is not
        // evidence of an A–C gate; route analysis needs to be able to tell the
        // difference between a jump and a gap in reporting.
        adjacent: prevSystemId != null &&
                  (adjacency.get(prevSystemId) || []).includes(report.systemId),
        size: Math.max(t.maxCount || 0, t.pilotsSeen ? t.pilotsSeen.size : 0),
      });
    }
    return t;
  }

  /**
   * Feed in a parsed intel report.
   *
   * `now` defaults to the REPORT'S OWN timestamp rather than the wall clock.
   * Live, the two are the same; replaying a log file they are not, and defaulting
   * to Date.now() silently pruned every sighting as stale the moment it arrived —
   * a tracker that always returned nothing, with no error to explain why.
   *
   * @returns {object[]} threat assessments touched by this report — one per
   *   named pilot plus the system-level track. Empty when out of range or clear.
   */
  function ingest(report, now = (report && report.ts) || Date.now()) {
    if (!report || report.systemId == null) return [];
    prune(now);

    // A clear retracts rather than being ignored — "YPW-M4 clr" means stop
    // warning about YPW-M4, and it is the second-most common message in the
    // corpus. Pilot tracks are left alone: a system being empty says nothing
    // about where the gang that was in it went.
    if (report.status === 'clear') {
      tracks.delete(systemKey(report.systemId));
      return [];
    }

    const near = nearestTo(report.systemId);
    if (!near) return [];                   // beyond every origin's horizon

    const touched = [];
    for (const pilot of (report.pilots || [])) {
      record(pilotKey(pilot), pilot, 'pilot', report, near);
      touched.push(pilotKey(pilot));
    }
    record(systemKey(report.systemId), report.systemName, 'system', report, near);
    touched.push(systemKey(report.systemId));

    // GROUPED, exactly as active() groups for the list — and deliberately over
    // every track in the system rather than only the ones this report touched.
    // The alert path and the list have to agree on what a contact IS: if one
    // alerts on a bare pilot key while the other shows a merged gang, the
    // suppression keys never match and the same gang warns once per member.
    return activeIn(report.systemId, now);
  }

  /** Live contacts standing in one system, grouped the way the list groups. */
  function activeIn(systemId, now) {
    const raw = [...tracks.keys()].map(k => assess(k, now)).filter(Boolean)
      .filter(c => c.systemId === systemId);
    return groupContacts(raw);
  }

  /**
   * Where a contact stands right now.
   *
   * Rate is measured across the whole observed track rather than the last leg:
   * intel is reported by people, not sampled by instruments, so consecutive
   * gaps are wildly uneven and a single short leg would read as a blistering
   * approach speed.
   */
  function assess(key, now = Date.now()) {
    const t = tracks.get(key);
    if (!t || !t.sightings.length) return null;

    const first = t.sightings[0];
    const last  = t.sightings[t.sightings.length - 1];
    const jumps = last.jumps;
    const size  = Math.max(t.maxCount || 0, t.pilotsSeen ? t.pilotsSeen.size : 0);

    const closed  = first.jumps - last.jumps;          // >0 means inbound
    const elapsed = (last.ts - first.ts) / 60000;      // minutes

    // Rate uses gates CROSSED, not net distance closed: a gang that went out
    // two and back three has moved five gates, and that's its real speed. Net
    // displacement would read a weaving roam as slow and give a dangerously
    // generous ETA.
    let gates = 0;
    for (let i = 1; i < t.sightings.length; i++) {
      gates += Math.abs(t.sightings[i].jumps - t.sightings[i - 1].jumps) || 1;
    }
    let jumpsPerMin = null;
    if (t.sightings.length >= 2 && elapsed > 0.25 && gates > 0) {
      jumpsPerMin = gates / elapsed;
    }
    const rate = jumpsPerMin || DEFAULT_JUMPS_PER_MIN;

    return {
      key,
      kind: t.kind,                 // 'pilot' | 'system'
      label: t.label,               // pilot name, or system name
      systemId:   last.systemId,
      systemName: last.systemName,
      jumps,
      // The monitored character this contact is closest to. With one origin
      // it's always the same; with a spread-out op it's the whole point.
      threatTo: last.near,
      closing: closed,
      // Only claim inbound on corroboration — a single sighting says where
      // something is, never which way it's pointed.
      inbound: closed > 0 && t.sightings.length >= 2,
      jumpsPerMin,
      // ESTIMATE, not a promise. Warp speed varies several-fold between hulls,
      // systems differ in size, and gate-to-gate distance is not uniform — so
      // this is "roughly how long, if it keeps moving as it has been", and the
      // UI shows it with a ~ and leads with jumps instead.
      etaSeconds: Math.round((jumps / rate) * 60),
      // Whether the rate was MEASURED from this contact's own movement or is
      // just the default guess. A caller showing an ETA should say which.
      etaMeasured: jumpsPerMin != null,
      roles: t.roles ? [...t.roles] : [],
      ships: t.ships ? [...t.ships] : [],
      size: size || null,
      band: gangBand(size),
      sightings: t.sightings.length,
      // The actual path, which is what makes the route-pattern analysis
      // possible later and what the operator wants to see on the map now.
      path: t.sightings.map(s => s.systemName),
      first: first.ts,
      last: last.ts,
    };
  }

  return {
    setOrigin, setOrigins, jumpsTo, nearestTo, ingest, assess,
    get origin() { return origins.length === 1 ? origins[0].systemId : null; },
    get origins() { return origins.map(o => ({ ...o })); },
    get reach() {
      const u = new Set();
      for (const d of distByOrigin.values()) for (const id of d.keys()) u.add(id);
      return u.size;
    },
    /** Every live contact, nearest first — what the list renders. */
    active(now = Date.now()) {
      prune(now);
      const raw = [...tracks.keys()].map(k => assess(k, now)).filter(Boolean);
      return groupContacts(raw)
        // DISTANCE LEADS. This used to sort inbound-first on the reasoning that
        // something closing from 6 beats something parked at 4 — defensible, but
        // it buries the contact that is actually on top of you underneath one
        // that merely has a heading. Jumps is also the only exact number here;
        // inbound and closing are inferred, so they break ties rather than
        // setting the order.
        .sort((a, b) => a.jumps - b.jumps || (b.inbound - a.inbound) || b.closing - a.closing);
    },
    clear() { tracks.clear(); },
  };
}

// Contacts reported in the same system within this of each other are one gang.
// Intel about a single gang arrives as a scatter of lines from several people
// over a couple of minutes, so the window has to be wide enough to gather them
// and narrow enough that a later, unrelated visitor is not swept in.
const GANG_WINDOW_MS = 5 * 60 * 1000;

/**
 * Fold the tracks that are really ONE gang into a single contact.
 *
 * The tracker deliberately keeps a track per named pilot plus one per system,
 * because that is what makes movement measurable — but it means a gang of three
 * named pilots in U104-3 surfaces as FOUR rows for one problem: three pilots and
 * the system they are standing in. That is what the list actually looked like,
 * and it is worse than noise: the same gang counted four times reads as four
 * separate threats, and each one alerts separately.
 *
 * So: same system, seen within GANG_WINDOW_MS of each other, is one contact.
 * Merging also makes the numbers BETTER rather than merely tidier — every member
 * contributes what it saw, so the gang's size is the largest of all the counts
 * and named pilots, its roles and hulls are the union, and its heading comes
 * from whichever member has been watched longest.
 *
 * Keyed on MEMBERSHIP, not location, so the same gang keeps its identity — and
 * its alert suppression — as it moves from system to system. That is the "trace"
 * half: one row that follows them, rather than a fresh contact at every gate.
 */
function groupContacts(list, { windowMs = GANG_WINDOW_MS } = {}) {
  const bySystem = new Map();
  for (const c of list) {
    if (!bySystem.has(c.systemId)) bySystem.set(c.systemId, []);
    bySystem.get(c.systemId).push(c);
  }

  const out = [];
  for (const members of bySystem.values()) {
    members.sort((a, b) => a.last - b.last);
    let cluster = [];
    const flush = () => { if (cluster.length) out.push(mergeGang(cluster)); cluster = []; };
    for (const m of members) {
      if (cluster.length && m.last - cluster[cluster.length - 1].last > windowMs) flush();
      cluster.push(m);
    }
    flush();
  }
  return out;
}

/** One contact out of several assessments of the same gang. */
function mergeGang(members) {
  if (members.length === 1) return members[0];

  const pilots = members.filter(m => m.kind === 'pilot');
  const names  = [...new Set(pilots.map(p => p.label))];
  // The derivative comes from whichever member has been watched longest — a
  // pilot followed across four systems knows the heading; one seen once does not.
  const best = members.slice().sort((a, b) => b.sightings - a.sightings)[0];
  const lead = pilots.slice()
    .sort((a, b) => b.sightings - a.sightings || String(a.label).localeCompare(String(b.label)))[0];
  // Every member undercounts on its own: a reporter who typed three names and a
  // reporter who typed "+8" are both describing the same gang.
  const size  = Math.max(...members.map(m => m.size || 0), names.length) || null;
  const path  = members.reduce((a, b) => ((b.path || []).length > (a.path || []).length ? b : a)).path;

  return {
    ...best,
    // Membership, so the row survives the gang moving. Falls back to the best
    // member's own key when nobody was named — a bare "+8 in X" has no identity
    // beyond the system it was seen in.
    key:   names.length ? 'g:' + names.map(n => String(n).toLowerCase()).sort().join('|') : best.key,
    label: lead ? lead.label : best.label,
    pilots: names,
    members: members.length,
    size,
    band:   gangBand(size),
    roles:  [...new Set(members.flatMap(m => m.roles || []))],
    ships:  [...new Set(members.flatMap(m => m.ships || []))],
    path,
    // The LARGEST, never the sum. Every report writes one entry to the pilot
    // track AND one to the system track, so adding them up counts the same
    // sighting twice and overstates how much evidence there is.
    sightings: Math.max(...members.map(m => m.sightings || 0)),
    first:   Math.min(...members.map(m => m.first)),
    last:    Math.max(...members.map(m => m.last)),
    // The strongest evidence of approach among them: one pilot corroborated as
    // closing is enough to call the gang inbound.
    closing: Math.max(...members.map(m => m.closing || 0)),
    inbound: members.some(m => m.inbound),
  };
}

/**
 * Should this raise an alarm?
 *
 * Two independent triggers, because one number can't serve both cases:
 *   • anything at or inside `alertJumps` — the classic tripwire;
 *   • anything INBOUND that will arrive within `etaSeconds`, however far out it
 *     started. A gang closing fast from 7 jumps deserves the same warning as
 *     one sitting at 3, and the fixed-radius approach misses it entirely.
 */
function shouldAlert(threat, { alertJumps = 5, etaSeconds = 120 } = {}) {
  if (!threat) return null;
  // Tackle changes the decision, not just the urgency. A Myrmidon can kill a
  // barge; a Sabre means the barge never leaves. So anything carrying tackle
  // reports one level hotter, and gets a wider tripwire — by the time a dictor
  // is inside the normal ring it is already too late to break siege.
  const tackle = Array.isArray(threat.roles) && threat.roles.includes('tackle');
  // A fleet gets the same treatment as tackle, for the same reason: by the time
  // 30+ hostiles are inside the ordinary ring, the op is already lost. Numbers
  // and tackle both widen the tripwire; together they don't stack, because one
  // extra ring is enough warning and two would fire on half the galaxy.
  const fleet  = threat.band === 'fleet';
  const ring   = (tackle || fleet) ? alertJumps + 2 : alertJumps;

  if (threat.jumps <= ring) {
    const hot = threat.jumps <= Math.max(1, Math.floor(alertJumps / 2));
    return {
      level:  (hot || tackle || fleet) ? 'critical' : 'warning',
      reason: fleet ? 'fleet' : (tackle ? 'tackle' : 'proximity'),
      tackle, fleet, band: threat.band || null, size: threat.size || null,
    };
  }
  if (threat.inbound && threat.etaSeconds <= etaSeconds) {
    return { level: (tackle || fleet) ? 'critical' : 'warning', reason: 'closing',
             tackle, fleet, band: threat.band || null, size: threat.size || null };
  }
  return null;
}

module.exports = {
  createProximityTracker, jumpDistances, buildAdjacency, shouldAlert, gangBand,
  groupContacts, mergeGang,
  DEFAULT_JUMPS_PER_MIN, TRACK_TTL_MS, GANG_BANDS, GANG_WINDOW_MS,
};
