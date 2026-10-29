// ─── force-projection.js — Ansiblex jump-bridge zoning & spheres of influence ──
// No DOM, no globals: unit-testable under Node (`node --test`) and reused in the
// browser via window.ForceProjection. Loaded as a plain <script> before map.js.
//
// WHAT THIS MODELS
//
// An Ansiblex jump gate charges a capacitor "fare" that scales with how far the
// gate sits from its owning alliance's sovereignty CAPITAL system, measured in
// light-years through real space. Close to home the fare is waived; far from it
// the cost multiplies, which is what makes long-range projection expensive.
//
// WHERE THE CAPITAL COMES FROM
//
// ESI's public /sovereignty/systems, which the map already polls for the sov
// overlay: each alliance claim carries `is_capital_system`, true on exactly one
// system per alliance that has designated a capital. capitalsFromSov() below
// turns that into { allianceId: systemId }.
//
// This was once wrongly believed not to exist. ESI serves its OLDEST schema
// (compatibility date 2020-01-01) unless a newer one is asked for, and that
// schema has no capital field anywhere; the current one does. Always audit
// against the latest compatibility date, not the default.
//
// An alliance holding sov with no capital set (4 of 71 when checked live) is
// reported as `unknown` rather than guessed — the one thing worse than no
// zoning is confident wrong zoning.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node / tests
  if (typeof window !== 'undefined') window.ForceProjection = api;             // renderer
  else if (typeof globalThis !== 'undefined') globalThis.ForceProjection = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // EVE's light-year, not the real one. CCP's map-data guide states the game
  // uses exactly this and warns that the physical value (9.4607304725808e15)
  // produces impossible jumps. Must stay in step with JP_LY in jump-planner.js;
  // test/force_projection.test.js asserts they agree.
  const LY_METRES = 9.46e15;

  // The bands, from the sov capital outward.
  //
  // `maxLy` is INCLUSIVE and the bands are quoted as 0–5, 5.1–10, 10.1–15 … so a
  // system at exactly 5.0 LY is Zone 1 and anything above it is Zone 2. The 0.1
  // in the published figures is display rounding, not a real gap: treating it as
  // one would leave 5.0–5.1 belonging to no zone at all.
  //
  // Colours are TOKEN NAMES, never literals. Themes re-point the --pal-* tokens,
  // and canvas silently drops var(), so the renderer resolves these through
  // map.js's token resolver rather than reading them as CSS.
  const ZONES = [
    { zone: 1, maxLy: 5,        multiplier: 0,  token: '--pal-green',  label: 'Zone 1', note: 'free' },
    { zone: 2, maxLy: 10,       multiplier: 2,  token: '--pal-teal',   label: 'Zone 2', note: '2x' },
    { zone: 3, maxLy: 15,       multiplier: 6,  token: '--pal-gold',   label: 'Zone 3', note: '6x' },
    { zone: 4, maxLy: 20,       multiplier: 9,  token: '--pal-orange', label: 'Zone 4', note: '9x' },
    { zone: 5, maxLy: Infinity, multiplier: 15, token: '--pal-red',    label: 'Zone 5', note: '15x' },
  ];

  // An alliance with no designated capital. Violet, and deliberately NOT zone 5:
  // "we do not know" and "it is very far away" are different answers, and
  // collapsing them would quietly invent a cost.
  const UNKNOWN = Object.freeze({
    zone: null, multiplier: null, token: '--pal-purple', label: 'Zone unknown', note: 'no sov capital',
  });

  /**
   * Every alliance's sov capital, from a normalised sov map.
   *
   * `sovMap` is { systemId: { allianceId, isCapital } } as map_ipc produces it.
   * Accepts the raw ESI field names too, so it works on either side of the
   * normaliser. Returns { allianceId: systemId } with no entry for an alliance
   * that holds sov but has not designated a capital.
   */
  function capitalsFromSov(sovMap) {
    const out = {};
    for (const [sysId, h] of Object.entries(sovMap || {})) {
      if (!h) continue;
      const cap = h.isCapital === true || h.is_capital_system === true;
      const al = h.allianceId || h.alliance_id;
      if (cap && al) out[al] = Number(sysId);
    }
    return out;
  }

  /** The ring radii a sphere-of-influence overlay draws, in light-years. */
  function zoneRadiiLy() {
    return ZONES.filter(z => Number.isFinite(z.maxLy)).map(z => z.maxLy);
  }

  /** Straight-line distance between two systems, in light-years. */
  function distanceLy(a, b) {
    if (!a || !b) return null;
    const dx = (a.x - b.x), dy = (a.y - b.y), dz = (a.z - b.z);
    if (![dx, dy, dz].every(Number.isFinite)) return null;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / LY_METRES;
  }

  /** The band a distance falls in. A null/!finite distance is `unknown`. */
  function zoneFor(ly) {
    if (ly === null || ly === undefined || !Number.isFinite(ly) || ly < 0) return UNKNOWN;
    for (const z of ZONES) if (ly <= z.maxLy) return z;
    return ZONES[ZONES.length - 1];
  }

  /**
   * The zone a system sits in relative to one capital.
   * Returns { ...band, ly } so callers can show the distance that produced it.
   */
  function zoneOfSystem(system, capitalSystem) {
    const ly = distanceLy(system, capitalSystem);
    const band = zoneFor(ly);
    return Object.assign({}, band, { ly });
  }

  /**
   * Where the chosen capitals can project to.
   *
   * Every system within the last finite band (20 LY) of the NEAREST of
   * `capitals`, zoned by that distance. Systems further out are left out rather
   * than tagged zone 5: zone 5 is "everything else", most of the galaxy, and
   * marking all of it would bury the systems the question is actually about.
   *
   * This is distance from the alliance you are looking at to every system,
   * whoever holds it — the same geometry the spheres of influence draw, so a
   * system's marker and the sphere it sits in can never disagree.
   */
  function reachZones(systems, capitals) {
    const caps = (capitals || []).filter(c => c && [c.x, c.y, c.z].every(Number.isFinite));
    const out = new Map();
    if (!caps.length) return out;
    const edge = ZONES[ZONES.length - 2].maxLy;            // 20 — the last finite band
    for (const s of (systems || [])) {
      let best = Infinity, from = null;
      for (const c of caps) {
        const ly = distanceLy(s, c);
        if (ly !== null && ly < best) { best = ly; from = c; }
      }
      if (best <= edge) out.set(s.id, Object.assign({}, zoneFor(best), { ly: best, capitalId: from.id }));
    }
    return out;
  }

  // ── Ansiblex capacitor and fares ─────────────────────────────────────────
  //
  // Sources: CCP, "Force Projection: Ansiblex Capacitor Update" (the per-hull
  // table) and Patch Notes 24.01 (what shipped). Where they disagree, the patch
  // notes win: they are later and describe the live game.
  //
  //   * Each Ansiblex holds 1250 TJ and recharges ~200 TJ an hour.
  //   * A jump costs  hull base x zone multiplier,  where the zone is the
  //     DESTINATION's distance from the owning alliance's capital - so heading
  //     home is cheaper than heading out - and it is charged to the Ansiblex at
  //     the ORIGIN. Each end of a bridge is its own structure with its own
  //     capacitor: A->B drains A, B->A drains B.
  //   * The distance between the two Ansiblexes plays no part.
  //   * Capitals are barred. Rorquals, freighters and jump freighters are not.
  //   * An alliance with no capital - including the cooldown after changing or
  //     losing one - pays zone 5 on everything.
  const ANSIBLEX = Object.freeze({ capacityTJ: 1250, rechargeTJPerHour: 200 });

  // Hull base cost, TJ. Every row of CCP's table is base x [0, 2, 6, 9, 15]
  // except two Rorqual cells (zone 2: 57, zone 3: 104.5, where the formula gives
  // 38 and 114). The article itself says those may be typos, and the Rorqual's
  // zone 4 and 5 values do follow the formula, so the formula is used here.
  // `allowed: false` marks hulls that cannot use an Ansiblex at all.
  const SHIP_CLASSES = Object.freeze([
    { id: 'capsule',      name: 'Capsule',                   base: 1 },
    { id: 'shuttle',      name: 'Shuttle',                   base: 1 },
    { id: 'corvette',     name: 'Corvette',                  base: 1 },
    { id: 'hauler',       name: 'Hauler (T1 industrial)',    base: 1 },
    { id: 'freighter',    name: 'Freighter',                 base: 1 },
    { id: 'jf',           name: 'Jump Freighter',            base: 1 },
    { id: 'barge',        name: 'Mining Barge',              base: 1 },
    { id: 'exhumer',      name: 'Exhumer',                   base: 1 },
    { id: 'expfrig',      name: 'Expedition Frigate',        base: 1 },
    { id: 'protoexp',     name: 'Prototype Exploration Ship', base: 1 },
    { id: 'frigate',      name: 'Frigate',                   base: 4 },
    { id: 'covops',       name: 'Covert Ops',                base: 5 },
    { id: 'destroyer',    name: 'Destroyer',                 base: 6 },
    { id: 'af',           name: 'Assault Frigate',           base: 7 },
    { id: 'br',           name: 'Blockade Runner',           base: 7 },
    { id: 'dst',          name: 'Deep Space Transport',      base: 7 },
    { id: 'ceptor',       name: 'Interceptor',               base: 8 },
    { id: 'dictor',       name: 'Interdictor',               base: 8.5 },
    { id: 'cmddessie',    name: 'Command Destroyer',         base: 9 },
    { id: 'eas',          name: 'Electronic Attack Ship',    base: 9 },
    { id: 'logifrig',     name: 'Logistics Frigate',         base: 9 },
    { id: 't3d',          name: 'Tactical Destroyer',        base: 9 },
    { id: 'orca',         name: 'Industrial Command Ship',   base: 10 },
    { id: 'cruiser',      name: 'Cruiser',                   base: 10 },
    { id: 'hic',          name: 'Heavy Interdiction Cruiser', base: 10.5 },
    { id: 'bomber',       name: 'Stealth Bomber',            base: 11 },
    { id: 'forcerecon',   name: 'Force Recon Ship',          base: 11.5 },
    { id: 'hac',          name: 'Heavy Assault Cruiser',     base: 11.5 },
    { id: 'combatrecon',  name: 'Combat Recon Ship',         base: 11.5 },
    { id: 'flagcruiser',  name: 'Flag Cruiser',              base: 12 },
    { id: 'logi',         name: 'Logistics Cruiser',         base: 12.5 },
    { id: 't3c',          name: 'Strategic Cruiser',         base: 13 },
    { id: 'abc',          name: 'Attack Battlecruiser',      base: 14 },
    { id: 'bc',           name: 'Combat Battlecruiser',      base: 14.5 },
    { id: 'expcmd',       name: 'Expedition Command Ship',   base: 15 },
    { id: 'cmdship',      name: 'Command Ship',              base: 16.5 },
    { id: 'battleship',   name: 'Battleship',                base: 16.5 },
    { id: 'blops',        name: 'Black Ops',                 base: 18 },
    { id: 'marauder',     name: 'Marauder',                  base: 19 },
    { id: 'rorqual',      name: 'Rorqual',                   base: 19 },
    { id: 'carrier',      name: 'Carrier',                   base: null, allowed: false },
    { id: 'dread',        name: 'Dreadnought',               base: null, allowed: false },
    { id: 'fax',          name: 'Force Auxiliary',           base: null, allowed: false },
    { id: 'super',        name: 'Supercarrier',              base: null, allowed: false },
    { id: 'titan',        name: 'Titan',                     base: null, allowed: false },
  ].map(c => Object.freeze(Object.assign({ allowed: true }, c))));

  /** A hull class by id, or null. */
  function shipClass(id) {
    return SHIP_CLASSES.find(c => c.id === id) || null;
  }

  /** Capacitor one jump costs, in TJ. null when the hull cannot use Ansiblexes. */
  function fareTJ(classId, zone) {
    const c = shipClass(classId);
    if (!c || !c.allowed || c.base === null) return null;
    const band = ZONES.find(z => z.zone === zone);
    return band ? c.base * band.multiplier : null;
  }

  /**
   * Price one Ansiblex jump from `origin` to `dest`.
   *
   * `ownerCapital` is the capital system of the alliance that owns the origin
   * Ansiblex, or null if it has none - in which case everything is zone 5,
   * which is how the game charges an alliance without a capital.
   */
  function jumpFare(origin, dest, classId, ownerCapital) {
    const noCapital = !ownerCapital;
    const ly = noCapital ? null : distanceLy(dest, ownerCapital);
    const band = noCapital ? ZONES[ZONES.length - 1] : zoneFor(ly);
    return {
      zone: band.zone, multiplier: band.multiplier, ly,
      fare: band.zone === null ? null : fareTJ(classId, band.zone),
      noCapital,
    };
  }

  /** How many ships of one fare an Ansiblex holding `availableTJ` can send. */
  function shipsThrough(fare, availableTJ) {
    if (fare === null || fare === undefined) return 0;
    if (fare === 0) return Infinity;              // zone 1 is free
    return Math.floor(Math.max(0, availableTJ) / fare);
  }

  /**
   * Capacitor an Ansiblex has back, `hours` after it was drained.
   *
   * Linear at CCP's stated average of ~200 TJ an hour. The real curve is the
   * ship-capacitor one - slowest near empty and full, fastest in the middle -
   * so this reads a little high early on and a little low late. It is the
   * figure CCP publishes; the curve's constants are not published.
   */
  function rechargedTJ(hours) {
    if (!(hours > 0)) return 0;
    return Math.min(ANSIBLEX.capacityTJ, hours * ANSIBLEX.rechargeTJPerHour);
  }

  return { LY_METRES, ZONES, UNKNOWN, capitalsFromSov, zoneRadiiLy, distanceLy, zoneFor,
           zoneOfSystem, reachZones,
           ANSIBLEX, SHIP_CLASSES, shipClass, fareTJ, jumpFare, shipsThrough, rechargedTJ };
});
