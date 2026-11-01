// ─── orrery.js — one solar system, laid out for the map ───────────────────────
// No DOM, no globals: unit-testable under Node (`node --test`) and reused in the
// browser via window.Orrery. Loaded as a plain <script> before map.js, which
// owns the canvas and does the drawing.
//
// The SDE places everything in a system - its sun, planets, moons, belts,
// stargates and NPC stations - in metres from the sun (mapDenormalize). To
// scale, that is unreadable: Jita's planets run from 0.28 AU out to 38 AU, and
// its moons, gates and stations sit within a few million km of a planet - four
// of its seven gates within 19,000 km of Jita VIII. Across New Eden a system
// reaches anywhere from 4 AU (J210750) to 203 AU (Thera).
//
// TWO SCALES
//
// Planets, and whatever stands off on its own - a far gate, Zarzakh's station
// in a system with no planets at all - keep their true direction from the sun
// and their true height above the plane; only the distance is squashed, to its
// square root, so the inner planets have room and the order never changes. Everything that sits beside a planet keeps its true
// direction FROM THE PLANET, and is set off from the planet's disc in screen
// pixels by the logarithm of its distance - a gate parked 16,000 km out and a
// moon 14 million km out both show, in order - opening out as you zoom in.
//
// "Height" here is EVE's own y axis, as the galaxy view draws it: the solar
// system is turned exactly as the galaxy around it is, so a gate that sits
// off the plane sits off it on the same side as the systems it leads towards.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node / tests
  if (typeof window !== 'undefined') window.Orrery = api;                      // renderer
})(this, function () {
  'use strict';

  const AU = 149597870700;                                  // m
  const GROUP = { SUN: 6, PLANET: 7, MOON: 8, BELT: 9, GATE: 10, STATION: 15 };
  // A gate this close to a planet is drawn beside it; further out it stands on
  // its own. Most gates are parked by a planet - the median is 54,000 km - and
  // the rest sit tens of AU from any: Jita's region gates are on a 42 AU shell.
  const NEAR = 3e9;                                         // m, 2% of an AU
  // Counted from 2,000 km, so the gates parked a planet's width or two away
  // still get a decade of their own: from 10,000 km, Jita VIII's four sat so
  // close to it that flying in nine times over still left them in a knot.
  const SPREAD = {
    unit:      2e6,   // m that open the first decade: 2,000 km
    gap:       2.5,   // px between a planet's disc and the nearest thing beside it
    perDecade: 4.5,   // px a decade of distance takes at the fitted view...
    grow:      0.85,  // ...and how it grows with zoom (^grow): a planet's company opens out as you fly in
  };

  /** Distance from the sun → its radius in the view before scaling: the square root, in √AU. */
  function squash(m) { return Math.sqrt(Math.max(0, m) / AU); }

  /** Decades of distance from a planet, counted from 2,000 km: 16,000 km is 0.95, a million km 2.7, 22 million 4.0. */
  function decades(m) { return Math.log10(1 + Math.max(0, m) / SPREAD.unit); }

  /** Pixels from a planet's centre to something `k` decades out, the planet `planetPx` in radius, at `zoomRel` times the fitted view. */
  function spreadPx(k, planetPx, zoomRel) {
    return planetPx + SPREAD.gap + k * SPREAD.perDecade * Math.pow(Math.max(1e-3, zoomRel), SPREAD.grow);
  }

  // The reference distances the view's scale can mark, in AU, and the room it
  // leaves round the sun and between two marks, as a share of the system's reach.
  const SCALE = { au: [0.5, 1, 2, 5, 10, 20, 50, 100, 200], first: 0.12, step: 0.14, last: 1.08 };

  const ROMAN = [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  function roman(n) {
    let s = '';
    for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; }
    return s;
  }

  /** "Planet (Gas)" → "gas": the key the planet art is filed under. */
  function planetKind(typeName) {
    const m = /\(([^()]+)\)\s*$/.exec(typeName || '');
    return m ? m[1].trim().toLowerCase() : 'barren';
  }

  /**
   * The art a planet kind wears. Turnur's lone "Scorched Barren" is the one kind
   * of the ten with no art of its own, and it is a barren planet with a bad day.
   */
  function planetSkin(kind) { return String(kind || 'barren').split(' ').pop(); }

  /** "Jita - Stargate (Perimeter)" → "Perimeter": where the gate goes. */
  function gateDestination(name) {
    const m = /\(([^()]+)\)\s*$/.exec(name || '');
    return m ? m[1].trim() : '';
  }

  /** "Stargate (Caldari Region)" → "region": the gate's reach, as CCP types it - system, constellation or region. */
  function gateReach(typeName) {
    const t = String(typeName || '').toLowerCase();
    return t.includes('region') ? 'region' : t.includes('constellation') ? 'constellation' : 'system';
  }

  /** "Jita 4 - Moon 4 - Caldari Navy Assembly Plant" → { at: "Jita 4 - Moon 4", name: "Caldari Navy Assembly Plant" }. */
  function stationParts(name) {
    const s = String(name || '');
    const i = s.lastIndexOf(' - ');
    return i < 0 ? { at: '', name: s } : { at: s.slice(0, i), name: s.slice(i + 3) };
  }

  const LEGIBLE = 0.28;                    // relative luminance: 4.5:1 and better on the map's dark ground
  const legibleCache = new Map();

  /**
   * A colour lifted toward white until it reads as text or a mark on the dark
   * map. The game's security ramp is made for dots: its null-sec red fades into a
   * red nebula, and its near-black for wormhole space is not there at all as words.
   */
  function legible(hex) {
    let out = legibleCache.get(hex);
    if (out) return out;
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const lin = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
    const lum = (t) => {
      const q = c.map(v => v + (255 - v) * t);
      return 0.2126 * lin(q[0]) + 0.7152 * lin(q[1]) + 0.0722 * lin(q[2]);
    };
    let t = 0;
    if (lum(0) < LEGIBLE) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 14; i++) { t = (lo + hi) / 2; if (lum(t) < LEGIBLE) lo = t; else hi = t; }
      t = hi;
    }
    out = '#' + c.map(v => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0')).join('');
    legibleCache.set(hex, out);
    return out;
  }

  const sub  = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len  = (v) => Math.hypot(v[0], v[1], v[2]);
  const unit = (v) => { const l = len(v); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0]; };

  /**
   * One system's mapDenormalize rows, laid out. Each row needs groupId, id,
   * x/y/z (metres from the sun), radius, name, typeName, orbitId,
   * celestialIndex and orbitIndex.
   *
   * Primaries - planets, and whatever has no planet to sit beside - get `p`,
   * their place in the view: squashed, then scaled so the farthest sits at 1.
   * Everything else is a satellite of a planet, with `parent`, `dir` (the unit
   * direction of its true offset from the planet), `d` (that offset in metres)
   * and `k` (its decades). Moons and belts belong to the planet they orbit; a
   * station or a near gate to the planet nearest it. A station also notes the
   * moon it is docked at, when there is one within 200,000 km.
   */
  function layout(rows) {
    const out = { sun: null, planets: [], moons: [], belts: [], gates: [], stations: [], extent: 1 };
    const at = (r) => [r.x || 0, r.y || 0, r.z || 0];
    const sunRow = rows.find(r => r.groupId === GROUP.SUN);
    if (sunRow) out.sun = { kind: 'sun', id: sunRow.id, name: sunRow.name, typeName: sunRow.typeName, radius: sunRow.radius, m: [0, 0, 0], p: [0, 0, 0] };

    for (const r of rows.filter(q => q.groupId === GROUP.PLANET).sort((a, b) => (a.celestialIndex || 0) - (b.celestialIndex || 0))) {
      const m = at(r), d = len(m);
      out.planets.push({
        kind: 'planet', id: r.id, name: r.name, typeName: r.typeName,
        planetKind: planetKind(r.typeName), skin: planetSkin(planetKind(r.typeName)),
        index: r.celestialIndex || 0, numeral: roman(r.celestialIndex || 0), radius: r.radius,
        m, au: d / AU, raw: squash(d), toward: unit(m),
        moons: [], belts: [], stations: [], gates: [],
      });
    }
    const byId = new Map(out.planets.map(p => [p.id, p]));
    const nearest = (m) => {
      let planet = null, d = Infinity;
      for (const p of out.planets) { const e = len(sub(m, p.m)); if (e < d) { d = e; planet = p; } }
      return planet ? { planet, d } : null;
    };
    const beside = (body, planet, m) => {
      const off = sub(m, planet.m), d = len(off);
      return Object.assign(body, { parent: planet, dir: unit(off), d, k: decades(d), m, au: len(m) / AU });
    };
    const alone = (body, m) => {
      const d = len(m);
      return Object.assign(body, { m, au: d / AU, raw: squash(d), toward: unit(m) });
    };

    for (const r of rows) {
      const m = at(r);
      if (r.groupId === GROUP.MOON || r.groupId === GROUP.BELT) {
        const planet = byId.get(r.orbitId) || (nearest(m) || {}).planet;
        if (!planet) continue;
        const moon = r.groupId === GROUP.MOON;
        const b = beside({ kind: moon ? 'moon' : 'belt', id: r.id, name: r.name, typeName: r.typeName, radius: r.radius, index: r.orbitIndex || 0 }, planet, m);
        (moon ? out.moons : out.belts).push(b);
        (moon ? planet.moons : planet.belts).push(b);
      } else if (r.groupId === GROUP.STATION) {
        const n = nearest(m);
        const parts = stationParts(r.name);
        const b = { kind: 'station', id: r.id, name: r.name, short: parts.name, where: parts.at, typeName: r.typeName };
        if (n) {
          beside(b, n.planet, m);
          n.planet.stations.push(b);
        } else {
          alone(b, m);        // Zarzakh: a station, four gates and no planets
        }
        out.stations.push(b);
      } else if (r.groupId === GROUP.GATE) {
        const n = nearest(m);
        const g = { kind: 'gate', id: r.id, name: r.name, typeName: r.typeName, dest: gateDestination(r.name), reach: gateReach(r.typeName) };
        if (n && n.d < NEAR) {
          beside(g, n.planet, m);
          n.planet.gates.push(g);
        } else {
          alone(g, m);
        }
        out.gates.push(g);
      }
    }

    for (const s of out.stations) {
      if (!s.parent) continue;
      let best = null, bd = 2e8;
      for (const mo of s.parent.moons) { const d = len(sub(s.m, mo.m)); if (d < bd) { bd = d; best = mo; } }
      s.moon = best;
    }
    for (const p of out.planets) p.moons.sort((a, b) => a.index - b.index);

    const free = [...out.planets, ...out.gates.filter(g => !g.parent), ...out.stations.filter(st => !st.parent)];
    out.extent = free.reduce((e, b) => Math.max(e, b.raw), 0) || 1;
    for (const b of free) {
      const s = b.raw / out.extent;
      b.p = [b.toward[0] * s, b.toward[1] * s, b.toward[2] * s];
    }
    return out;
  }

  /**
   * The distances worth marking on a system's scale, as { au, r } with r its
   * radius in the view: round numbers that fit inside its reach, clear of the
   * sun and of each other. The spacing has to be worked out for each system -
   * 1, 5, 10 and 20 AU suit Jita, but J210750 only reaches 3.7 AU, and in Thera,
   * at 203, the 1 AU mark would sit inside the sun's glare.
   */
  function scaleMarks(extent) {
    const marks = [];
    let last = SCALE.first - SCALE.step;
    for (const au of SCALE.au) {
      const r = squash(au * AU) / (extent || 1);
      if (r > SCALE.last) break;
      if (r - last < SCALE.step) continue;
      marks.push({ au, r });
      last = r;
    }
    return marks;
  }

  /**
   * A planet's orbit: the circle round the sun through it, tilted to its true
   * height - the plane holding the planet and the level line square to it.
   * EVE's planets never move, so the SDE has no orbits to draw; this is the
   * circle a reader expects, and it runs exactly through the planet. `n`
   * points, starting at the planet itself.
   */
  function orbitRing(p, n) {
    const R = len(p);
    if (!(R > 0) || !(n > 0)) return [];
    const a = [p[0] / R, p[1] / R, p[2] / R];
    const h = Math.hypot(p[0], p[2]);
    const b = h > 1e-9 ? [p[2] / h, 0, -p[0] / h] : [1, 0, 0];
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      pts.push([R * (c * a[0] + s * b[0]), R * (c * a[1] + s * b[1]), R * (c * a[2] + s * b[2])]);
    }
    return pts;
  }

  // ── Arriving and leaving ────────────────────────────────────────────────────
  //
  // In: the galaxy dives into the star, faster and faster, until its light
  // fills the view; the light clears on the system, close in on the sun, and
  // the camera eases back while the orbits draw out from their planets, inner
  // first. Out: back into the sun, and the galaxy rises out of its light to
  // wherever you left it.
  //
  // A dive needs a star on the Spatial map to dive into. Wormhole space has no
  // place on it and the Schematic no camera for it, so those arrive and leave
  // in a flash of the star's light instead: `flash` and `fade` stand in for the
  // dive and the rise, and everything inside the system is the same.
  const ENTER = { dive: 950, flash: 280, reveal: 1500 };   // ms
  const LEAVE = { sink: 600, rise: 950, fade: 380 };       // ms
  const ZOOM_IN = 4;                           // how close to the sun the system opens, x its fitted view

  const clamp01   = (x) => Math.max(0, Math.min(1, x));
  const smooth    = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const easeIn    = (u) => u * u * u;
  const easeOut   = (u) => 1 - Math.pow(1 - u, 3);
  const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

  /** The arrival `ms` in, after a lead of `lead` ms: which scene is up, how far each part has got, and how bright the star's light is (0..1). */
  function arrival(ms, lead = ENTER.dive) {
    if (ms < lead) {
      const dive = clamp01(ms / lead);
      return { scene: 'galaxy', dive, reveal: 0, bloom: smooth(0.4, 1, dive), done: false };
    }
    const reveal = clamp01((ms - lead) / ENTER.reveal);
    return { scene: 'system', dive: 1, reveal, bloom: 1 - smooth(0, 0.32, reveal), done: reveal >= 1 };
  }

  /** The departure `ms` in, ending on `tail` ms of the map coming back. */
  function departure(ms, tail = LEAVE.rise) {
    if (ms < LEAVE.sink) {
      const sink = clamp01(ms / LEAVE.sink);
      return { scene: 'system', sink, rise: 0, bloom: smooth(0.3, 1, sink), done: false };
    }
    const rise = clamp01((ms - LEAVE.sink) / tail);
    return { scene: 'galaxy', sink: 1, rise, bloom: 1 - smooth(0, 0.4, rise), done: rise >= 1 };
  }

  /** How much of ring `i` of `n` (inner first) has drawn out from its planet, `reveal` into the opening. */
  function ringShare(i, n, reveal) {
    const start = 0.06 + 0.42 * (n > 1 ? i / (n - 1) : 0);
    return easeOut(clamp01((reveal - start) / 0.38));
  }

  /** How far planet `i` of `n` has faded in: it arrives as its ring sets out. */
  function planetShare(i, n, reveal) {
    const start = 0.06 + 0.42 * (n > 1 ? i / (n - 1) : 0);
    return smooth(start - 0.02, start + 0.1, reveal);
  }

  return {
    AU, GROUP, NEAR, SPREAD, ENTER, LEAVE, ZOOM_IN,
    squash, decades, spreadPx, roman, legible, planetKind, planetSkin, gateDestination, gateReach, stationParts,
    layout, scaleMarks, orbitRing, arrival, departure, ringShare, planetShare,
    smooth, easeIn, easeOut, easeInOut,
  };
});
