'use strict';
//
// The early-warning service: chat logs in, threat assessments out.
//
// Lives in the main process because that is where the SDE already is — the
// system index and the 14 000-edge gate graph are built once from SQLite and
// shared, rather than shipped to the renderer.
//
// Pipeline:
//   chatlog_reader  tails the files EVE writes
//   intel_parser    turns a line into { system, pilots, ships, status }
//   proximity       tracks each contact's distance over time from the fleet
//   here            decides what deserves an alert, and rate-limits it
//
// ALERT FATIGUE IS THE FAILURE MODE. Replaying the real corpus produced runs of
// six identical alerts in the same second, because six people report the same
// gang across several channels. An operator who gets that once mutes the tool,
// and then it isn't there for the siege it was built for. Hence _shouldEmit:
// one alert per contact unless it has genuinely got closer or escalated.

const { buildSystemIndex }      = require('./system_index');
const { createChannelParser }   = require('./intel_parser');
const { createChatlogReader }   = require('./chatlog_reader');
const {
  buildAdjacency, createProximityTracker, shouldAlert,
} = require('./proximity');
const { createKillWatch } = require('./kill_watch');
const { createRuleEngine } = require('./alert_rules');
const { createStandingsResolver } = require('./standings');
const { createPatternStore } = require('./patterns');
const { createZkillStream } = require('./zkill_stream');

// At most this many warnings when picking the picture back up. A busy region
// can hold a dozen live contacts, and a dozen alerts at launch is a mute button
// being pressed.
const RESUME_ALERT_MAX = 3;

const DEFAULTS = {
  alertJumps: 5,        // classic tripwire radius
  etaSeconds: 120,      // "two minutes to get off grid" — the stated requirement
  maxJumps:   12,       // horizon for distance calculation
  reAlertMs:  90_000,   // silence for an unchanged contact
  // How much of the log to replay on start, so a relaunch picks up where it
  // left off. Five minutes of intel is still broadly true; an hour of it is a
  // history lesson. 0 disables it.
  backfillMs: 5 * 60_000,
  // Live killmails from zKillboard. Off by default: it is a continuous
  // connection to a free third-party service, which is the user's call to make,
  // not a default to inherit.
  liveKills:  false,
};

function createIntelService({ getSdeDb, onReport, onAlert, onStatus,
                              httpGet, httpPost, getZkillFeed,
                              getRules, getContactSheet,
                              loadPatterns, savePatterns,
                              // zkillFetch is a TEST SEAM and nothing else. Left
                              // undefined, the feed uses its own uncached
                              // transport; never wire the app's shared httpGet
                              // here, for the reasons in zkill_stream.js.
                              zkillBase, zkillFetch } = {}) {
  let index    = null;
  let adjacency = null;
  let tracker  = null;
  let reader   = null;
  let regionNames = [];

  const parsers  = new Map();   // channel -> parser (holds per-author context)
  const lastAlert = new Map();  // contact key -> { ts, jumps, level }
  const recent   = [];          // rolling log of reports, newest last
  const MAX_RECENT = 400;

  let opts    = { ...DEFAULTS };
  let started = false;
  let killWatch = null;
  let zkillStream = null;
  // User-defined rules run ALONGSIDE the built-in proximity alert, never
  // instead of it — with every rule off, the tool behaves exactly as before.
  const rules = createRuleEngine(getRules || (() => []));
  const standings = createStandingsResolver({ httpPost, getContactSheet });
  // Long-term history: which gates hostiles habitually use and what hour they
  // turn up. Survives restarts — a pattern is by definition something that
  // repeats across days, so an in-memory version could never see one.
  const patterns = createPatternStore({ load: loadPatterns, save: savePatterns });

  /** Build the SDE-derived indexes. Idempotent and safe to call again. */
  async function init() {
    const db = getSdeDb && getSdeDb();
    if (!db) throw new Error('SDE not available — intel needs the static data');

    const [systems, jumps, ships] = await Promise.all([
      // security comes along so a system chip can be coloured the way the game
      // colours it — null, low and high are three different conversations.
      db.all(`SELECT s.solarSystemID id, s.solarSystemName name, s.security security,
                     s.regionID regionId, r.regionName regionName
              FROM mapSolarSystems s JOIN mapRegions r ON r.regionID = s.regionID
              WHERE s.solarSystemID < 31000000`),
      db.all('SELECT fromSolarSystemID "from", toSolarSystemID "to" FROM mapSolarSystemJumps'),
      // Ship hulls become stopwords, so "sabre" and "stiletto" can never be read
      // as system names. Sourced from the SDE so it stays right as CCP adds hulls.
      // groupName comes along so hulls can be classified by threat role
      // (interdictor / interceptor / capital…), not just recognised as ships.
      // typeID comes along so killmails — which name nothing and identify hulls
      // only by id — can still say what the gang was flying.
      db.all(`SELECT t.typeID id, t.typeName n, g.groupName grp FROM invTypes t
              JOIN invGroups g ON g.groupID = t.groupID
              WHERE g.categoryID = 6 AND t.published = 1`),
    ]);

    index       = buildSystemIndex(systems, ships.map(s => ({ id: s.id, name: s.n, group: s.grp })));
    adjacency   = buildAdjacency(jumps);
    tracker     = createProximityTracker({
      adjacency, maxJumps: opts.maxJumps,
      onSighting: (s) => patterns.noteSighting(s),
    });
    regionNames = [...new Set(systems.map(s => s.regionName))];

    // Killmails as a second source. Always built: the live feed needs no
    // credentials and no ESI, so someone using ONLY that (no kill counts, no
    // zkill history) still needs the machinery that shapes a killmail into a
    // report. The pollers inside it no-op when their dependencies are absent.
    killWatch = createKillWatch({
      httpGet,
      getZkillFeed,
      // The live feed is the whole galaxy. Anything outside every monitored
      // character's horizon is somebody else's war, and this is the only place
      // that knows where the horizon is.
      isRelevant: (systemId) => !!tracker.nearestTo(systemId),
      shipFor:    (typeId)   => index.ship(typeId),
      onKillReport: (r) => {
        // zKill gives a system ID, not a name — resolve it here so the report
        // is shaped exactly like a parsed chat report downstream.
        const sys = index.get(r.systemId);
        handleReport({ ...r, systemName: sys ? sys.name : `System ${r.systemId}`,
                       regionName: sys ? sys.regionName : null });
      },
      onActivity: () => onStatus && onStatus({ killActivity: true }),
    });

    // The live feed. Built here but not started — see syncLiveKills.
    // Deliberately NOT given the app's shared httpGet: that one caches, and a
    // cached cursor is a feed that reports itself healthy while never
    // advancing. See the note on directGet in zkill_stream.js.
    zkillStream = createZkillStream({
      base:    zkillBase || undefined,
      httpGet: zkillFetch,           // undefined in production — see above
      onKillmail: (pkg) => killWatch.ingestPackage(pkg),
      onStatus:   (s) => onStatus && onStatus({ liveKills: s }),
    });

    return { systems: systems.length, ships: ships.length };
  }

  /**
   * Run the live feed only when it can do something useful.
   *
   * Both conditions matter. Without the option it should not be connecting to a
   * third-party service at all; without a monitored position every killmail in
   * the galaxy is equally irrelevant, because there is nothing to measure
   * distance from and the relevance filter would discard all of them anyway.
   */
  function syncLiveKills() {
    if (!zkillStream) return;
    if (opts.liveKills && tracker && tracker.origins.length) zkillStream.start();
    else zkillStream.stop();
  }

  function parserFor(channel, regions) {
    let p = parsers.get(channel);
    // Regions arrive from the channel's MOTD once its header has been read, so
    // the parser is rebuilt if they turn up after it was created.
    if (!p || (regions && regions.length && p.__regions !== regions.join('|'))) {
      p = createChannelParser(index, { regions: regions || [], channel });
      p.__regions = (regions || []).join('|');
      parsers.set(channel, p);
    }
    return p;
  }

  /**
   * Should this assessment reach the operator?
   *
   * Re-alerts only when the contact has closed further or escalated in
   * severity. Everything else is the same gang being re-reported.
   */
  function shouldEmit(threat, level, now) {
    const prev = lastAlert.get(threat.key);
    if (!prev) return true;
    if (threat.jumps < prev.jumps) return true;                       // closer
    if (level === 'critical' && prev.level !== 'critical') return true; // escalated
    return now - prev.ts > opts.reAlertMs;
  }

  /**
   * The worst standing attached to a report, from whichever key it carries.
   *
   * Chat gives names, which have to be resolved and are unknown on first
   * sighting. Killmails give the attackers' corp and alliance ids outright, so
   * they resolve immediately — the worse of the two is what the contact is
   * judged on, since a red alliance is red whichever source named it.
   */
  function worstStandingFor(report, names) {
    const byName = standings.worstStanding(names);
    const byId   = standings.worstForIds((report && report.entityIds) || []);
    if (!Number.isFinite(byName)) return Number.isFinite(byId) ? byId : null;
    if (!Number.isFinite(byId))   return byName;
    return Math.min(byName, byId);
  }

  /**
   * Where this contact has historically gone next from where it is now.
   *
   * Usually null, and that is the correct answer — most systems have not been
   * observed often enough to say anything, and a made-up heading is worse than
   * no heading. When there IS an answer the predicted system's own distance
   * comes with it, because "they usually go to Z next" only matters once you
   * know whether Z is closer to your barges than where they are standing.
   */
  /**
   * The bits the UI shows that the tracker has no way to know.
   *
   * Region, security and hull type-ids all live in the SDE, and the row that
   * gets rendered wants all three — the hull id in particular, because chat
   * names ships in words and only an id can fetch a picture of one.
   */
  function withDisplay(o) {
    const sys = o.systemId != null && index ? index.get(o.systemId) : null;
    return {
      ...o,
      regionName: o.regionName || (sys ? sys.regionName : null),
      security:   sys && Number.isFinite(sys.security) ? sys.security : null,
      shipIds:    (o.ships || []).map(n => (index ? index.shipId(n) : null)),
    };
  }

  function withPrediction(threat) {
    const p = patterns.predictNext(threat.systemId);
    if (!p) return threat;
    const sys  = index.get(p.systemId);
    const near = tracker.nearestTo(p.systemId);
    return {
      ...threat,
      predict: {
        systemId:   p.systemId,
        systemName: sys ? sys.name : `System ${p.systemId}`,
        share: p.share, n: p.n, days: p.days, outOf: p.outOf,
        jumps: near ? near.jumps : null,
        // The only version of this that changes a decision: their habit takes
        // them TOWARD us. Computed here so every consumer agrees on it.
        closer: near ? near.jumps < threat.jumps : false,
      },
    };
  }

  /**
   * What, if anything, to say about the picture rebuilt from the log.
   *
   * The backfill deliberately alerts on nothing, but staying silent altogether
   * would be its own failure: relaunching in the middle of an incident and
   * getting no warning is exactly when you most need one. So the state is judged
   * ONCE, and only the worst few are reported — tracker.active() is already
   * sorted most-threatening first.
   *
   * Each one is recorded in lastAlert, so the ordinary suppression takes over
   * from here and the next live report about the same gang stays quiet.
   */
  function resumeSweep(now = Date.now()) {
    if (!tracker || !tracker.origins.length) return [];
    const out = [];
    for (const threat of tracker.active(now)) {
      if (out.length >= RESUME_ALERT_MAX) break;
      const names    = threat.kind === 'pilot' ? [threat.label] : [];
      const standing = worstStandingFor({}, names);
      const enriched = withPrediction(withDisplay({ ...threat, standing, pilots: [], camp: false }));
      const verdict  = shouldAlert(enriched, opts);
      if (!verdict) continue;
      lastAlert.set(threat.key, { ts: now, jumps: threat.jumps, level: verdict.level });
      out.push({ ...enriched, ...verdict, resumed: true });
    }
    for (const a of out) onAlert && onAlert(a);
    if (out.length) {
      console.log(`[intel] resumed: ${out.length} contact(s) still worth warning about`);
    }
    return out;
  }

  function handleLine(line, { channel, regions, backfill }) {
    if (!index || !tracker) return;
    const report = parserFor(channel, regions).ingest(line);
    if (report) handleReport(report, { backfill: !!backfill });
  }

  /**
   * One path for every source — chat lines and killmails alike.
   *
   * `backfill` means this line was replayed from the log on startup to rebuild
   * the picture from before a restart. It goes through the tracker and the
   * pattern history exactly as a live line would — that is the whole point, so
   * the derivative survives a relaunch — but it must NEVER raise an alert.
   * Firing warnings for a gang that passed while the app was shut is precisely
   * the failure this system is built to avoid.
   */
  function handleReport(report, { backfill = false } = {}) {
    if (!index || !tracker || !report) return;

    // Enrich before publishing: the feed shows how far away each report is and
    // who it is near, and those come from the tracker rather than the message.
    // Computing it once here keeps the renderer from having to join the two.
    const near = tracker.origins.length ? tracker.nearestTo(report.systemId) : null;
    const enrichedReport = withDisplay({
      ...report,
      jumps:    near ? near.jumps : null,
      nearTo:   near && near.origin ? near.origin.label : null,
      standing: worstStandingFor(report, report.pilots || []),
    });

    recent.push(enrichedReport);
    if (recent.length > MAX_RECENT) recent.shift();
    onReport && onReport(enrichedReport);

    // Rebuild the tracks, then stop. The post-resume sweep in start() decides
    // what — if anything — is still worth saying about them.
    if (backfill) { tracker.ingest(report); return; }

    // No monitored position yet — reports are still logged and listed, there is
    // simply nothing to measure them against. Checked via origins.length, NOT
    // tracker.origin: that convenience getter is null for 0 OR 2+ origins, so
    // using it here would silently disable alerting the moment a second
    // character was monitored.
    if (!tracker.origins.length) return;

    const now = Date.now();
    for (const threat of tracker.ingest(report)) {
      // Worst standing among everyone attached to this contact. Resolution is
      // asynchronous and never blocks — the first sighting queues the lookup,
      // and the same pilot's next report has the answer.
      const names = threat.kind === 'pilot' ? [threat.label] : (report.pilots || []);
      const standing = worstStandingFor(report, names);
      const enriched = withPrediction(withDisplay({
        ...threat, standing, pilots: report.pilots || [], camp: !!report.camp,
      }));

      // 1. The built-in proximity alert.
      const verdict = shouldAlert(enriched, opts);
      if (verdict && shouldEmit(enriched, verdict.level, now)) {
        lastAlert.set(threat.key, { ts: now, jumps: threat.jumps, level: verdict.level });
        onAlert && onAlert({ ...enriched, ...verdict, report });
      }

      // 2. User rules, each with its own suppression window.
      for (const hit of rules.evaluate(enriched, { standing }, now)) {
        onAlert && onAlert({ ...enriched, ...hit, report });
      }
    }
  }

  return {
    init,

    /** Begin following channels. Safe to call repeatedly to change the list. */
    start(channels = [], { dir } = {}) {
      if (!index) throw new Error('intel service: call init() first');
      if (reader) reader.stop();
      reader = createChatlogReader({
        dir,
        channels,
        knownRegions: regionNames,
        onLine: handleLine,
        onChannels: (s) => onStatus && onStatus(s),
        backfillMs: opts.backfillMs,
      });
      // The backfill runs inside this call — createChatlogReader replays on
      // first open and start() ticks synchronously — so by the time it returns,
      // the tracks are rebuilt and the sweep below is looking at a real picture.
      reader.start();
      started = true;
      const resumed = resumeSweep();
      return { ...reader.status(), resumed: resumed.length };
    },

    stop() {
      if (reader) reader.stop();
      if (killWatch) killWatch.stop();
      if (zkillStream) zkillStream.stop();
      // Write the history out now: the debounce is measured in tens of seconds
      // and stopping is usually followed by quitting, which would lose whatever
      // was still pending.
      patterns.flush();
      reader = null; started = false;
    },

    /**
     * Where the fleet is. Everything downstream is relative to this, so it is
     * the one thing that must be right — usually the character's live location.
     */
    setOrigin(systemId) {
      if (!tracker) return 0;
      lastAlert.clear();   // distances all changed; old suppressions are meaningless
      rules.reset();
      const reach = tracker.setOrigin(systemId);
      syncLiveKills();
      return reach;
    },

    /**
     * Monitor several characters at once. Each entry is a position to defend;
     * a contact's distance is to the CLOSEST of them, and alerts name which.
     *
     * @param {Array} list [{ key, label, systemId }]
     */
    setOrigins(list) {
      if (!tracker) return 0;
      lastAlert.clear();
      rules.reset();          // suppressions were about distances that changed
      const reach = tracker.setOrigins(list);
      if (killWatch) {
        killWatch.setMonitored((list || [])
          .filter(o => o && o.characterId)
          .map(o => ({ characterId: o.characterId, name: o.label })));
        killWatch.start();
      }
      syncLiveKills();   // the horizon just changed, or appeared for the first time
      return reach;
    },

    /** Standing for a reported name, or null if unresolved/unknown. */
    standingFor(name) { return standings.standingFor(name); },

    /** Kill counts for a system in the last hour, or null. */
    killActivity(systemId) { return killWatch ? killWatch.activityFor(systemId) : null; },

    setOptions(next = {}) {
      opts = { ...opts, ...next };
      // Re-derive distances at the new horizon. Must go through setOrigins with
      // the FULL list — setOrigin(tracker.origin) would quietly drop every
      // monitored character but one.
      if (tracker && next.maxJumps) tracker.setOrigins(tracker.origins);
      syncLiveKills();
      return { ...opts };
    },

    /** Live contacts, most threatening first. */
    contacts() {
      return tracker ? tracker.active().map(t => withPrediction(withDisplay(t))) : [];
    },

    /**
     * Habitual routes and hours. Everything here is historical — it says nothing
     * about right now, and is deliberately silent until there is enough history
     * to mean something.
     */
    patterns() {
      return patterns.analyse({
        systemNameFor: (id) => { const s = index && index.get(id); return s ? s.name : null; },
      });
    },

    /** Forget the history — for a move to new space, where none of it holds. */
    clearPatterns() { patterns.clear(); return patterns.size; },

    /** Write the history out now, rather than on the debounce. */
    flushPatterns() { patterns.flush(); },

    /** Recent reports for the intel feed, newest first. */
    feed(limit = 100) { return recent.slice(-limit).reverse(); },

    status() {
      return {
        running:  started,
        origin:   tracker ? tracker.origin : null,
        origins:  tracker ? tracker.origins : [],
        reach:    tracker ? tracker.reach : 0,
        kills:    killWatch ? killWatch.snapshot().activityAt : 0,
        // Reported separately from `running`: the live kill feed works with the
        // game closed, so it can be up while the chat reader has nothing to read.
        liveKills: zkillStream ? zkillStream.status() : { running: false, connected: false },
        systems:  index ? index.size : 0,
        options:  { ...opts },
        reader:   reader ? reader.status() : { dir: null, channels: [] },
      };
    },

    // Exposed for tests: drive the pipeline without touching the filesystem.
    _handleLine: handleLine,
    get _killWatch() { return killWatch; },
    get _index()   { return index; },
    get _tracker() { return tracker; },
  };
}

module.exports = { createIntelService, DEFAULTS };
