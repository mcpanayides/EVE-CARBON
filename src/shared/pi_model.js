// pi_model.js — the Planetary Interaction production model.
//
// Loaded by BOTH processes:
//   • main     — require()d by the PI IPC to answer planner queries
//   • renderer — a <script> tag; attaches window.PiModel, used by the Colonies
//                page's shortfall banner and by the PI Planner
//
// Everything here is pure: schematics and colonies in, numbers out. No DOM, no
// ESI, no SQL — which is what lets the whole production model be tested without
// Electron, and what stops the Colonies page and the Planner ever disagreeing
// about what a shortfall is.
//
// ── What this can and cannot know ────────────────────────────────────────────
//
// CAN, exactly: the recipe graph (planetSchematics in the SDE), what every one
// of your factories is set to build (schematic_id on each pin), and what every
// extractor is currently yielding (extractor_details.qty_per_cycle).
//
// CANNOT, at all: how rich an un-surveyed planet is. EVE generates per-planet
// resource abundance server-side and publishes it nowhere — not in the SDE, not
// in ESI. So this model recommends planet TYPES and LOCATIONS, and the player
// still has to survey. Every planner output says so; see SURVEY_CAVEAT.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PiModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const SURVEY_CAVEAT =
    'EVE does not publish planet resource richness — no API has it. These are the '
    + 'right planet types in the right places; you still need to survey them in the '
    + 'client and swap any that scan poorly.';

  // ── Which P0 each planet type can yield ─────────────────────────────────────
  // A fixed game rule, unchanged since 2011, and in no data export — so it is
  // written out here with names beside the ids so it can be read and checked
  // rather than trusted.
  const PLANET_RESOURCES = {
    barren:    [2268, 2267, 2288, 2073, 2270], // Aqueous, Base Metals, Carbon, Microorganisms, Noble Metals
    gas:       [2268, 2267, 2309, 2310, 2311], // Aqueous, Base Metals, Ionic, Noble Gas, Reactive Gas
    ice:       [2268, 2272, 2073, 2310, 2286], // Aqueous, Heavy Metals, Microorganisms, Noble Gas, Planktic
    lava:      [2267, 2307, 2272, 2306, 2308], // Base Metals, Felsic Magma, Heavy Metals, Non-CS, Suspended Plasma
    oceanic:   [2268, 2288, 2287, 2073, 2286], // Aqueous, Carbon, Complex Organisms, Microorganisms, Planktic
    plasma:    [2267, 2272, 2270, 2306, 2308], // Base Metals, Heavy Metals, Noble Metals, Non-CS, Suspended Plasma
    storm:     [2268, 2267, 2309, 2310, 2308], // Aqueous, Base Metals, Ionic, Noble Gas, Suspended Plasma
    temperate: [2268, 2305, 2288, 2287, 2073], // Aqueous, Autotrophs, Carbon, Complex Organisms, Microorganisms
  };

  /** Planet types that can yield a given P0. */
  function planetTypesFor(p0TypeId) {
    return Object.keys(PLANET_RESOURCES).filter(t => PLANET_RESOURCES[t].includes(Number(p0TypeId)));
  }

  // ── Schematic index ─────────────────────────────────────────────────────────

  /**
   * Build the recipe graph from flat SDE rows.
   * @param {Array} schematics  [{ schematicID, schematicName, cycleTime }]
   * @param {Array} typeMap     [{ schematicID, typeID, quantity, isInput }]
   */
  function indexSchematics(schematics, typeMap) {
    const byId = new Map();
    for (const s of (schematics || [])) {
      byId.set(s.schematicID, {
        id: s.schematicID, name: s.schematicName,
        cycle: s.cycleTime || 3600, inputs: [], output: null,
      });
    }
    for (const t of (typeMap || [])) {
      const s = byId.get(t.schematicID);
      if (!s) continue;
      if (t.isInput) s.inputs.push({ id: t.typeID, qty: t.quantity });
      else s.output = { id: t.typeID, qty: t.quantity };
    }
    // producer: typeID -> the schematic that makes it. A commodity has exactly
    // one recipe in PI, which is what makes the tree solvable at all.
    const producer = new Map();
    for (const s of byId.values()) if (s.output) producer.set(s.output.id, s);
    return { byId, producer };
  }

  /** Runs per hour for a schematic. P1 cycles are 30 min, everything else 60. */
  const runsPerHour = (s) => 3600 / (s.cycle || 3600);

  /**
   * Tier of a commodity, derived from the graph rather than from group ids, so
   * it stays right if CCP adds a tier.  P0 = extracted, nothing makes it.
   */
  function tierOf(typeId, idx, seen) {
    const s = idx.producer.get(Number(typeId));
    if (!s) return 0;
    seen = seen || new Set();
    if (seen.has(typeId)) return 0;          // cycle guard; PI has none, but still
    seen.add(typeId);
    return 1 + Math.max(0, ...s.inputs.map(i => tierOf(i.id, idx, seen)));
  }

  // ── What an existing network actually does ─────────────────────────────────

  /**
   * Net production per hour across a set of colonies.
   *
   * `installed` counts every factory pin as running. That is the right question
   * for planning ("does my layout balance?") and the wrong one for monitoring
   * ("is it running now?") — a factory only turns over if something routes
   * material into it. When routes are present the model can say which factories
   * are actually fed; `fedOnly` reports that stricter figure.
   */
  function tallyNetwork(colonies, idx, opts) {
    const now = (opts && opts.now) || Date.now();
    const balance = new Map();
    const add = (id, q) => balance.set(id, (balance.get(id) || 0) + q);

    let extractors = 0, factories = 0, unfedFactories = 0, expiredExtractors = 0;
    const perPlanet = [];

    for (const col of (colonies || [])) {
      if (!col) continue;
      let pins = col.pins;
      if (!Array.isArray(pins)) { try { pins = JSON.parse(col.pins_json || '[]'); } catch (_) { pins = []; } }
      let routes = col.routes;
      if (!Array.isArray(routes)) { try { routes = JSON.parse(col.routes_json || '[]'); } catch (_) { routes = []; } }

      // A factory is "fed" if any route delivers to it. With no routes stored at
      // all we cannot tell, so every factory counts — the old behaviour.
      const fed = new Set(routes.map(r => r.destination_pin_id));
      const knowRoutes = routes.length > 0;

      const planet = { planetId: col.planet_id, system: col.solar_system_name,
                       type: col.planet_type, produces: [], consumes: [], extracts: [] };

      for (const p of pins) {
        const ex = p.extractor_details;
        if (ex && ex.product_type_id) {
          extractors++;
          const expired = p.expiry_time && new Date(p.expiry_time).getTime() <= now;
          if (expired) { expiredExtractors++; continue; }   // a dead extractor yields nothing
          const perHr = (ex.qty_per_cycle || 0) * (3600 / (ex.cycle_time || 3600));
          add(ex.product_type_id, perHr);
          planet.extracts.push({ id: ex.product_type_id, perHour: perHr, heads: (ex.heads || []).length });
          continue;
        }
        if (p.schematic_id == null) continue;               // storage, launchpad, command centre
        const s = idx.byId.get(p.schematic_id);
        if (!s || !s.output) continue;
        factories++;
        if (knowRoutes && !fed.has(p.pin_id)) { unfedFactories++; continue; }
        const r = runsPerHour(s);
        for (const i of s.inputs) { add(i.id, -i.qty * r); planet.consumes.push({ id: i.id, perHour: i.qty * r }); }
        add(s.output.id, s.output.qty * r);
        planet.produces.push({ id: s.output.id, perHour: s.output.qty * r, schematic: s.name });
      }
      perPlanet.push(planet);
    }

    return { balance, perPlanet, extractors, factories, unfedFactories, expiredExtractors };
  }

  /**
   * The materials running at a deficit, worst first.
   *
   * Only commodities something MAKES can be short — a raw P0 deficit means the
   * extractors are not keeping up with the factories, which is a different
   * complaint and is reported separately by `rawDeficits`.
   */
  function shortfalls(balance, idx, epsilon = 0.0001) {
    const out = [];
    for (const [id, qty] of balance) {
      if (qty >= -epsilon) continue;
      if (!idx.producer.has(Number(id))) continue;          // raw, not a shortfall
      out.push({ id: Number(id), perHour: qty, tier: tierOf(id, idx) });
    }
    return out.sort((a, b) => b.tier - a.tier || a.perHour - b.perHour);
  }

  /** P0 the extractors are not supplying fast enough. */
  function rawDeficits(balance, idx, epsilon = 0.0001) {
    const out = [];
    for (const [id, qty] of balance) {
      if (qty >= -epsilon) continue;
      if (idx.producer.has(Number(id))) continue;
      out.push({ id: Number(id), perHour: qty, planetTypes: planetTypesFor(id) });
    }
    return out.sort((a, b) => a.perHour - b.perHour);
  }

  /**
   * What one of THIS player's extractors actually yields.
   *
   * A raw deficit is priced in extractors, and the obvious way to do that would
   * be a published average yield per planet. There isn't one that means
   * anything: output is set by the planet's resource richness, which EVE
   * generates server-side and publishes nowhere, and it varies by an order of
   * magnitude between a poor planet and a rich one.
   *
   * So don't guess -- measure. Every live extractor's real output is already in
   * the network tally, which makes the player's own median the honest basis:
   * it is drawn from their planets, at their richness, in their space.
   *
   * MEDIAN rather than mean, because one freshly-installed extractor on a rich
   * planet would otherwise drag the figure up and understate the answer.
   * Extractor yield also DECAYS across a program's life, so any single reading
   * is one point on a falling curve; a median across many extractors at
   * different points in their cycles is roughly the middle of that curve, which
   * is the right number for planning but is still an estimate.
   *
   * Expired extractors never reach here -- tallyNetwork drops them before this,
   * because a dead extractor yields nothing and would halve the median.
   */
  function extractorProfile(perPlanet) {
    const rates = [];
    let heads = 0, planets = 0;

    for (const p of (perPlanet || [])) {
      if (!p || !p.extracts || !p.extracts.length) continue;
      planets++;
      for (const e of p.extracts) {
        if (e && e.perHour > 0) { rates.push(e.perHour); heads += (e.heads || 0); }
      }
    }
    if (!rates.length) return { ecus: 0, planets: 0, perEcu: null, perHead: null, ecusPerPlanet: null };

    rates.sort((a, b) => a - b);
    const mid    = Math.floor(rates.length / 2);
    const perEcu = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
    const total  = rates.reduce((a, b) => a + b, 0);

    return {
      ecus: rates.length,
      planets,
      perEcu,
      perHead: heads ? total / heads : null,
      ecusPerPlanet: planets ? rates.length / planets : null,
    };
  }

  /**
   * Turn a raw deficit into extractors and planets, using the player's own
   * observed yield. Returns null when there is nothing to measure -- an
   * estimate with no basis is worse than no estimate.
   */
  function rawFixFor(deficit, profile) {
    if (!profile || !(profile.perEcu > 0)) return null;
    const short = Math.abs(deficit.perHour);
    const ecus  = Math.ceil(short / profile.perEcu - 1e-9);
    // How many extractors the player actually puts on one planet, rounded to a
    // whole ECU and never below one.
    const perPlanet = Math.max(1, Math.round(profile.ecusPerPlanet || 1));
    return {
      id: deficit.id,
      shortPerHour: short,
      ecus,
      planets: Math.ceil(ecus / perPlanet),
      perEcu: profile.perEcu,
      ecusPerPlanet: perPlanet,
      basis: profile.ecus,
    };
  }

  // ── What it would take to make something ───────────────────────────────────

  /**
   * Solve a target rate back to the whole tree: factories at each tier and the
   * raw extraction it stands on.
   *
   * Factory counts are ceilinged, because a fifth of a factory does not exist —
   * so the plan over-produces slightly at each tier, exactly as a real layout
   * does.
   *
   * Pass `available` (typeID -> surplus units/hr, from a live network's balance)
   * to plan the DELTA rather than the whole chain: anything you already produce
   * a surplus of is subtracted before the factory count is worked out, and the
   * saving cascades down the tree, because a P2 you no longer need to build is
   * also a P1 and a P0 you no longer need to extract. Omit it and the behaviour
   * is unchanged -- planning from nothing.
   *
   * @param {number} targetTypeId
   * @param {number} perHour   desired output per hour
   * @param {Map}   [available] typeID -> units/hr already spare
   * @returns {{ steps: Array, raw: Array, factories: number }}
   */
  function planFor(targetTypeId, perHour, idx, available) {
    const avail = available instanceof Map ? available : new Map();
    const need = new Map();                                  // typeID -> units/hr
    need.set(Number(targetTypeId), perHour);

    const steps = [];                                        // one per produced commodity
    const raw   = new Map();                                 // typeID -> units/hr

    // Deepest first, so a commodity feeding two branches is solved once with its
    // total demand rather than twice with half of it.
    const order = [...need.keys()];
    const demand = new Map(need);
    const queue = [...order];
    const settled = new Set();

    while (queue.length) {
      // Take the deepest outstanding item — everything above it is now known.
      queue.sort((a, b) => tierOf(b, idx) - tierOf(a, idx));
      const id = queue.shift();
      if (settled.has(id)) continue;
      settled.add(id);

      const s     = idx.producer.get(Number(id));
      const gross = demand.get(id) || 0;
      // Only a POSITIVE balance is spare capacity; a negative one is the
      // shortfall the colonies page is already complaining about, and must
      // never be read as stock on hand.
      const stock = Math.max(0, avail.get(Number(id)) || 0);
      const fromStock = Math.min(stock, gross);
      const want  = Math.max(0, gross - stock);

      if (!s) { raw.set(id, (raw.get(id) || 0) + want); continue; }

      const perFactory = s.output.qty * runsPerHour(s);       // units/hr from one
      // max(0, ...) because a fully covered step lands on Math.ceil(-1e-9),
      // which is -0. It stringifies as "0" so nothing visibly breaks, but a
      // negative factory count should not be representable at all.
      const factories  = Math.max(0, Math.ceil(want / perFactory - 1e-9));
      const actual     = factories * perFactory;

      steps.push({ id: Number(id), name: s.name, tier: tierOf(id, idx),
                   wantPerHour: want, grossPerHour: gross, fromStock,
                   factories, perFactoryPerHour: perFactory,
                   actualPerHour: actual, cycle: s.cycle });

      for (const i of s.inputs) {
        const q = i.qty * runsPerHour(s) * factories;
        demand.set(i.id, (demand.get(i.id) || 0) + q);
        if (!settled.has(i.id)) queue.push(i.id);
      }
    }

    steps.sort((a, b) => b.tier - a.tier);
    return {
      steps,
      raw: [...raw.entries()]
        .map(([id, perHour]) => ({ id: Number(id), perHour, planetTypes: planetTypesFor(id) }))
        .sort((a, b) => b.perHour - a.perHour),
      factories: steps.reduce((n, s) => n + s.factories, 0),
    };
  }

  /**
   * Turn a shortfall into a concrete instruction: how many more factories, and
   * roughly how many planets that is.
   *
   * PLANET_FACTORY_BUDGET is a working figure, not a game constant — how many
   * advanced factories a well-laid-out planet supports once the command centre,
   * launchpad, links and storage have taken their share of CPU and powergrid.
   * It varies with command-centre level and layout, so it is labelled as an
   * estimate everywhere it surfaces.
   */
  const PLANET_FACTORY_BUDGET = 8;

  // ── Colony power and CPU budgets ──────────────────────────────────────────
  //
  // Every figure below is read out of the SDE, not recalled: the command centre
  // ladder from the six published Command Center types (attribute 11 = powergrid
  // output, 48 = CPU output) and the pin costs from attribute 15 (powergrid) and
  // 49 (CPU). Worth verifying rather than trusting memory -- the Advanced and
  // Elite CPU figures in particular are commonly quoted as 22294/27373, and the
  // SDE says 21315/25415.
  //
  // The command centre tier tracks Command Center Upgrades 1:1, so the skill
  // level IS the row index.
  const CCU_SKILL_ID = 2505;

  const CC_BUDGET = [
    { level: 0, tier: 'Basic',    pg: 6000,  cpu: 1675  },
    { level: 1, tier: 'Limited',  pg: 9000,  cpu: 7057  },
    { level: 2, tier: 'Standard', pg: 12000, cpu: 12136 },
    { level: 3, tier: 'Improved', pg: 15000, cpu: 17215 },
    { level: 4, tier: 'Advanced', pg: 17000, cpu: 21315 },
    { level: 5, tier: 'Elite',    pg: 19000, cpu: 25415 },
  ];

  const PIN_COST = {
    extractor: { pg: 2600, cpu: 400,  name: 'Extractor Control Unit' },
    basic:     { pg: 800,  cpu: 200,  name: 'Basic Industry Facility' },
    advanced:  { pg: 700,  cpu: 500,  name: 'Advanced Industry Facility' },
    hitech:    { pg: 400,  cpu: 1100, name: 'High-Tech Production Plant' },
    launchpad: { pg: 700,  cpu: 3600, name: 'Launchpad' },
    storage:   { pg: 700,  cpu: 500,  name: 'Storage Facility' },
    // A link's cost SCALES WITH ITS LENGTH; this is the base, so every total
    // built from it is a floor. Nothing here can know pin spacing on a planet
    // nobody has surveyed, which is why role fit is reported as headroom rather
    // than as a promise.
    link:      { pg: 10,   cpu: 15,   name: 'Link' },
  };

  /** The command centre a character can field, from their CCU level. */
  function colonyBudget(ccuLevel) {
    const i = Math.max(0, Math.min(5, Number(ccuLevel) || 0));
    return CC_BUDGET[i];
  }

  /**
   * Planet archetypes, shaped after how PI is actually run rather than after
   * the tier table: one planet usually spans several tiers. A reactor planet
   * takes imported P1s up through P2 to P3 on the same rock, and only the P4
   * step gets a planet of its own -- fed by P3 hauled in from three others.
   *
   * `planetTypes` on the high-tech role is a hard game restriction, not a
   * preference: High-Tech Production Plants exist ONLY for Barren and Temperate
   * planets in the SDE, so P4 cannot be made anywhere else.
   */
  const PLANET_ROLES = [
    { id: 'extraction', name: 'Extraction',  tiers: 'P0 → P1',
      what: 'Extractor heads feeding basic factories, exporting through the command centre.',
      // One extractor, not two: an ECU is the most powergrid-hungry pin in the
      // game at 2600 PG, and a second one pushes a starter extraction planet
      // past what a Limited command centre can carry. Extraction is therefore
      // heavier on powergrid than refining is -- the opposite of the usual
      // assumption that it is the cheap thing you give a new alt.
      pins: { extractor: 1, basic: 4, storage: 1 }, links: 6 },
    { id: 'refinery',   name: 'Refinery',    tiers: 'P1 → P2',
      what: 'Imported P1 refined into P2. The workhorse middle of any chain.',
      pins: { launchpad: 1, advanced: 4, storage: 1 }, links: 6 },
    { id: 'reactor',    name: 'Reactor',     tiers: 'P1 → P2 → P3',
      what: 'Two tiers on one rock: P1 in by launchpad, P2 made and immediately consumed into P3.',
      pins: { launchpad: 1, advanced: 8, storage: 2 }, links: 12 },
    { id: 'hitech',     name: 'High-Tech',   tiers: 'P3 → P4',
      what: 'Three P3 streams hauled in from reactor planets and combined into P4.',
      pins: { launchpad: 1, hitech: 3, storage: 2 }, links: 7,
      planetTypes: ['barren', 'temperate'] },
  ];

  /** Powergrid and CPU one archetype costs to stand up. */
  function roleCost(role) {
    let pg = 0, cpu = 0;
    for (const [kind, n] of Object.entries(role.pins || {})) {
      const c = PIN_COST[kind];
      if (!c) continue;
      pg += c.pg * n; cpu += c.cpu * n;
    }
    pg  += PIN_COST.link.pg  * (role.links || 0);
    cpu += PIN_COST.link.cpu * (role.links || 0);
    return { pg, cpu };
  }

  /** Lowest Command Center Upgrades level that fits a role, or null if none. */
  function minCcuFor(role) {
    const c = roleCost(role);
    for (const b of CC_BUDGET) if (c.pg <= b.pg && c.cpu <= b.cpu) return b.level;
    return null;
  }

  /** Which archetypes a character at this CCU level can actually stand up. */
  function rolesForCcu(ccuLevel) {
    const b = colonyBudget(ccuLevel);
    return PLANET_ROLES.filter(r => {
      const c = roleCost(r);
      return c.pg <= b.pg && c.cpu <= b.cpu;
    });
  }

  /**
   * How many factories of one kind fit beside a launchpad and two silos.
   *
   * This is the CEILING -- what powergrid and CPU permit. Real planets fit
   * fewer, because links are priced by length and a spread-out layout can spend
   * several times the base link cost. PLANET_FACTORY_BUDGET below stays the
   * conservative planning figure; this is here to show the headroom a higher
   * command centre actually buys, which is the whole reason to train the skill.
   */
  function factoryCeiling(ccuLevel, kind = 'advanced') {
    const b = colonyBudget(ccuLevel);
    const c = PIN_COST[kind];
    if (!c) return 0;
    const pg  = b.pg  - PIN_COST.launchpad.pg  - 2 * PIN_COST.storage.pg;
    const cpu = b.cpu - PIN_COST.launchpad.cpu - 2 * PIN_COST.storage.cpu;
    if (pg <= 0 || cpu <= 0) return 0;
    // One link per factory back to the hub, at base length.
    return Math.max(0, Math.floor(Math.min(
      pg  / (c.pg  + PIN_COST.link.pg),
      cpu / (c.cpu + PIN_COST.link.cpu)
    )));
  }

  /**
   * Which character should run what.
   *
   * Sorts the demanding roles onto the characters that can carry them and
   * leaves the weak ones on extraction, which is the shape players reach for by
   * hand. The ordering that matters is by command centre, NOT by planet count:
   * Interplanetary Consolidation buys more planets, Command Center Upgrades buys
   * a bigger one, and only the second decides what a planet is capable of.
   *
   * @param {Array} chars  [{ charId, charName, ccu, ic, free, used }]
   */
  function recommendRoles(chars) {
    const rows = (chars || []).map(c => {
      const ccu   = c.ccu == null ? null : Math.max(0, Math.min(5, Number(c.ccu) || 0));
      const known = ccu != null;
      const can   = known ? rolesForCcu(ccu) : [];
      const budget = known ? colonyBudget(ccu) : null;
      // The best role a character can hold is the last one they can afford --
      // PLANET_ROLES runs cheapest to most demanding.
      const best  = can.length ? can[can.length - 1] : null;
      return {
        charId: c.charId, charName: c.charName,
        ccu, ic: c.ic == null ? null : Number(c.ic),
        free: c.free, used: c.used, known,
        tier: budget ? budget.tier : null,
        canRun: can.map(r => r.id),
        best: best ? best.id : null,
        bestName: best ? best.name : null,
        // Said plainly, because a command centre this small is a dead end rather
        // than a smaller version of a working one.
        note: !known ? 'Skills never synced — capacity unknown'
            : !can.length ? 'Command Center Upgrades 0 fits no working layout — train it to I before using this character for PI'
            : null,
      };
    });

    // Strongest command centre first, so the scarce high-tech and reactor slots
    // go to the characters that can actually hold them.
    rows.sort((a, b) => (b.ccu == null ? -1 : b.ccu) - (a.ccu == null ? -1 : a.ccu)
                     || String(a.charName).localeCompare(String(b.charName)));
    return rows;
  }

  /**
   * A suggested role for each character, not just the ceiling each could hold.
   *
   * `recommendRoles` answers "what is this character capable of", and past CCU 2
   * the answer is "everything" -- which is true and useless for deciding who
   * does what. This allocates instead, and the shape it allocates to is the one
   * a P4 chain actually has: one high-tech planet is fed by roughly three
   * reactor planets, and those are fed by refining and extraction below them.
   *
   * Characters are taken strongest command centre first, so the scarce
   * demanding slots land on the planets that can carry them and the weaker
   * characters keep the extraction they are perfectly good at. A character with
   * no free slots is skipped: they are already doing something.
   *
   * The mix is a starting allocation, not an optimum -- it cannot be, without
   * knowing which product you are chasing. `planFor` is where an exact answer
   * comes from; this is the answer you can act on before you have one.
   */
  const ROLE_CYCLE = ['hitech', 'reactor', 'reactor', 'reactor'];

  function assignRoles(rows) {
    let cycle = 0;
    return (rows || []).map((r) => {
      const out = Object.assign({}, r, { suggested: null, suggestedName: null });
      if (!r.known || !r.canRun || !r.canRun.length) return out;
      if (!(r.free > 0)) { out.suggestedNote = 'No free slots'; return out; }

      // Walk the chain shape while the character can keep up with it; drop to
      // the most demanding thing they CAN hold once they cannot.
      let want = ROLE_CYCLE[cycle % ROLE_CYCLE.length];
      if (!r.canRun.includes(want)) {
        want = r.canRun[r.canRun.length - 1];
      } else {
        cycle++;   // only a character that took the demanding slot advances it
      }
      const role = PLANET_ROLES.find(x => x.id === want) || null;
      out.suggested     = role ? role.id : null;
      out.suggestedName = role ? role.name : null;
      return out;
    });
  }

  function fixFor(shortfall, idx) {
    const s = idx.producer.get(Number(shortfall.id));
    if (!s) return null;
    const perFactory = s.output.qty * runsPerHour(s);
    const factories  = Math.ceil(Math.abs(shortfall.perHour) / perFactory - 1e-9);
    return {
      id: shortfall.id, name: s.name, tier: shortfall.tier,
      shortPerHour: Math.abs(shortfall.perHour),
      factories, perFactoryPerHour: perFactory,
      planets: Math.ceil(factories / PLANET_FACTORY_BUDGET),
      inputs: s.inputs.map(i => ({ id: i.id, perHour: i.qty * runsPerHour(s) * factories })),
    };
  }

  return {
    SURVEY_CAVEAT, PLANET_RESOURCES, PLANET_FACTORY_BUDGET,
    planetTypesFor, indexSchematics, runsPerHour, tierOf,
    tallyNetwork, shortfalls, rawDeficits, planFor, fixFor,
    extractorProfile, rawFixFor,
    // Colony power budget and role planning
    CCU_SKILL_ID, CC_BUDGET, PIN_COST, PLANET_ROLES,
    colonyBudget, roleCost, minCcuFor, rolesForCcu, factoryCeiling, recommendRoles,
    ROLE_CYCLE, assignRoles,
  };
});
