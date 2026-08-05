'use strict';
//
// Resolving system names out of free-text intel chatter.
//
// This is the hard part of reading intel channels, and it is the part that
// decides whether the early-warning system is trusted or ignored. A false
// positive pulls a mining fleet off grid for nothing; enough of those and
// people mute the alert, which is worse than not having it.
//
// MEASURED against 12 023 real messages from east.imperium and
// fareast.imperium (Goonswarm regional intel):
//
//   83% of messages contain an EXACT system name
//    1% resolve only through an abbreviation
//   16% carry no system at all (follow-ups: "ok", "buzzard", "3 myrm 1 thorax")
//
// So exact matching carries this. Abbreviations are a rounding error in volume
// and the main source of false positives, which sets the design:
//
//  1. EXACT NAMES MATCH GALAXY-WIDE. A full system name is unambiguous, and
//     scoping to the channel's declared regions loses real reports — the corpus
//     has east.imperium messages naming TR07-S and AZN-D2, which sit outside
//     the four regions its MOTD lists. Nobody reporting a hostile cares which
//     channel's remit it falls under.
//
//  2. ABBREVIATIONS ONLY RESOLVE WITHIN THE CHANNEL'S REGIONS, and only when
//     unique there. "ualx" → UALX-3 and "shbf" → SHBF-V are genuine; letting
//     them range over all 5 485 systems makes them coin flips.
//
//  3. STOPWORDS ARE DATA, NOT A HAND-LIST. The naive version matched the
//     English word "are" to A-REKV. Real intel vocabulary comes from the corpus
//     (clr, nv, ess, gate, bubble) and — the useful trick — every published
//     ship name comes straight out of the SDE, so "sabre", "stiletto" and
//     "orthrus" can never be read as systems.
//
// Exactly one name is both a ship and a system: Naga. It is treated as
// ambiguous and only resolves when the message names nothing else.

// Function words and intel shorthand. The ship names are NOT here — they come
// from the SDE at build time, so the list stays correct as CCP adds hulls.
const STOPWORDS = new Set([
  // English function words that collide with nullsec names
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'go',
  'gone', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it', 'its',
  'me', 'my', 'no', 'not', 'of', 'off', 'ok', 'on', 'one', 'or', 'our', 'out',
  'she', 'so', 'the', 'their', 'them', 'then', 'they', 'this', 'to', 'two', 'up',
  'us', 'was', 'we', 'were', 'what', 'when', 'where', 'who', 'will', 'with',
  'yes', 'you', 'your', 'new', 'now', 'all', 'any', 'can', 'did', 'get', 'got',
  // Intel shorthand, ranked by frequency in the corpus
  'clr', 'clear', 'nv', 'ess', 'gate', 'bubble', 'bubbles', 'camp', 'camped',
  'gatecamp', 'dead', 'end', 'wh', 'hole', 'filament', 'cyno', 'bridge', 'titan',
  'fleet', 'fleets', 'blue', 'red', 'neut', 'neuts', 'hostile', 'hostiles',
  'status', 'stat', 'kill', 'killed', 'dead', 'safe', 'docked', 'undocked',
  'jumped', 'jumping', 'warping', 'warped', 'headed', 'heading', 'inbound',
  'ratting', 'mining', 'miss', 'issue', 'reported', 'spotted', 'visual',
]);

// Threat roles, keyed on SDE group names.
//
// The axis that matters for the fleet this was built for is NOT damage — it's
// "can this thing stop me leaving?". A Myrmidon can kill a barge but the barge
// can still warp; a Sabre means nobody warps anywhere. That distinction is the
// difference between "finish the cycle" and "break siege NOW", so tackle
// escalates an alert on its own.
//
// Derived from the SDE's own group names rather than a hardcoded hull list, so
// it stays correct as CCP adds hulls.
const SHIP_ROLE_GROUPS = {
  // Stops you leaving. The reason this feature exists.
  'Interdictor':                'tackle',
  'Heavy Interdiction Cruiser': 'tackle',
  'Interceptor':                'tackle',
  // Sees you without being seen — usually the precursor to a drop.
  'Covert Ops':                 'cloaky',
  'Force Recon Ship':           'cloaky',
  'Black Ops':                  'cloaky',
  'Stealth Bomber':             'cloaky',
  'Combat Recon Ship':          'ewar',
  'Electronic Attack Ship':     'ewar',
  // A different order of problem entirely.
  'Dreadnought':                'capital',
  'Carrier':                    'capital',
  'Supercarrier':               'capital',
  'Titan':                      'capital',
  'Force Auxiliary':            'capital',
  'Logistics':                  'logi',
};

// Intel shorthand for a ROLE rather than a hull. Rare in the corpus (dictor 8,
// hic 3, ceptor 6) but unambiguous when it appears — and "bubble"/"bubbled"
// shows up 157 times, which makes it the single biggest tackle signal there is.
const ROLE_WORDS = {
  dictor: 'tackle', dictors: 'tackle', hic: 'tackle', hics: 'tackle',
  ceptor: 'tackle', ceptors: 'tackle', tackle: 'tackle',
  bubble: 'tackle', bubbles: 'tackle', bubbled: 'tackle',
  bomber: 'cloaky', bombers: 'cloaky', sb: 'cloaky', covops: 'cloaky', cov: 'cloaky',
  recon: 'ewar', logi: 'logi',
  dread: 'capital', dreads: 'capital', carrier: 'capital', titan: 'capital', super: 'capital',
};

/**
 * @param {Array} systems  [{ id, name, regionId, regionName }]
 * @param {Array} shipTypes  published hulls: plain names, or { name, group }
 *                           — the group form unlocks threat-role classification
 */
function buildSystemIndex(systems, shipTypes = []) {
  const byId    = new Map();
  const exact   = new Map();   // lowercased name -> system
  const ships   = new Set();
  const shipRoleByName = new Map();   // lowercased hull -> role
  // Multi-word hulls ("Omen Navy Issue", "Republic Fleet Firetail") indexed by
  // word count so a message can be scanned longest-phrase-first. Without this,
  // "Omen Navy Issue" matched only "omen" and left "Navy" behind — which the
  // pilot extractor then reported as a hostile pilot called Navy. That word
  // appears 211 times in the corpus.
  const shipPhrases = new Map();   // wordCount -> Set(lowercased phrase)
  // Hulls by typeID, for sources that speak in ids rather than words. Killmails
  // arrive from zKillboard with ship_type_id and nothing else, so without this
  // the objective source is the one that cannot say what anything was flying.
  const shipById = new Map();      // typeID -> { name, role }
  const shipIdByName = new Map();  // lowercased hull -> typeID
  let maxShipWords = 1;
  for (const s of shipTypes) {
    const name = String(s && s.name != null ? s.name : s).toLowerCase();
    if (!name) continue;
    ships.add(name);
    const words = name.split(/\s+/).length;
    if (words > 1) {
      if (!shipPhrases.has(words)) shipPhrases.set(words, new Set());
      shipPhrases.get(words).add(name);
      if (words > maxShipWords) maxShipWords = words;
    }
    const role = s && s.group ? SHIP_ROLE_GROUPS[s.group] : null;
    if (role) shipRoleByName.set(name, role);
    if (s && Number.isFinite(s.id)) {
      // The display name, not the lowercased match key — this one is shown.
      shipById.set(s.id, { name: String(s.name), role: role || null });
      // …and the reverse, so a hull picked out of a chat line can be shown with
      // its icon. Chat names hulls in words; only the id can fetch a picture.
      shipIdByName.set(name, s.id);
    }
  }
  const byRegion = new Map();  // regionName -> system[]

  for (const s of systems) {
    byId.set(s.id, s);
    exact.set(String(s.name).toLowerCase(), s);
    const key = String(s.regionName || '');
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key).push(s);
  }

  // Names that are also ship hulls (just "Naga" today). Resolving one of these
  // on sight would fire an alert every time somebody reports the ship.
  const ambiguous = new Set();
  for (const name of exact.keys()) if (ships.has(name)) ambiguous.add(name);

  // Abbreviation tables are built lazily per region-set and cached: there are a
  // handful of channels, each asked thousands of times.
  const abbrevCache = new Map();

  function abbrevTable(regions) {
    const key = (regions || []).slice().sort().join('|');
    if (abbrevCache.has(key)) return abbrevCache.get(key);

    const scoped = [];
    for (const r of (regions || [])) for (const s of (byRegion.get(r) || [])) scoped.push(s);

    // A prefix only earns a place if it points at exactly one system. Anything
    // claimed twice is deleted rather than resolved arbitrarily.
    const table = new Map();
    for (const s of scoped) {
      const flat = String(s.name).toLowerCase().replace(/-/g, '');
      for (let L = 3; L <= flat.length; L++) {
        const k = flat.slice(0, L);
        if (table.has(k)) table.set(k, null); else table.set(k, s);
      }
    }
    for (const [k, v] of [...table]) if (!v) table.delete(k);
    abbrevCache.set(key, table);
    return table;
  }

  /** Strip punctuation people decorate reports with: "EKPB-3," "SHBF-V*" "(X1-IZ0)" */
  function normalise(token) {
    return String(token || '').toLowerCase().replace(/^[^a-z0-9-]+|[^a-z0-9-]+$/g, '');
  }

  /**
   * Resolve one token to a system.
   * @returns {{system: object, confidence: 'exact'|'abbrev', ambiguous?: boolean}|null}
   */
  function matchToken(token, { regions = [] } = {}) {
    const t = normalise(token);
    if (!t || t.length < 2) return null;

    const hit = exact.get(t);
    if (hit) return { system: hit, confidence: 'exact', ambiguous: ambiguous.has(t) };

    // Below here we're guessing, so the guards matter more than the coverage.
    if (STOPWORDS.has(t)) return null;
    if (ships.has(t))     return null;
    const flat = t.replace(/-/g, '');
    if (flat.length < 3)  return null;
    const abbrev = abbrevTable(regions).get(flat);
    return abbrev ? { system: abbrev, confidence: 'abbrev' } : null;
  }

  /**
   * Every system named in a message, in order of appearance and de-duplicated.
   *
   * Ambiguous names (Naga) are dropped when anything else resolved — in a
   * message like "Naga  X1-IZ0" the hull reading is obviously the right one.
   */
  function matchMessage(text, { regions = [] } = {}) {
    const out  = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/[\s,()[\]/]+/)) {
      const m = matchToken(raw, { regions });
      if (!m || seen.has(m.system.id)) continue;
      seen.add(m.system.id);
      out.push({ ...m, token: raw });
    }
    const solid = out.filter(m => !m.ambiguous);
    return solid.length ? solid : out;
  }

  return {
    matchToken, matchMessage, normalise,
    get(id) { return byId.get(id) || null; },
    /** Hull and threat role for a typeID, or null. Killmails speak in ids. */
    ship(typeId) { return shipById.get(typeId) || null; },
    /** typeID for a hull NAME, or null — chat names hulls in words. */
    shipId(name) {
      const t = String(name || '').toLowerCase();
      return shipIdByName.get(t) ?? shipIdByName.get(t.replace(/s$/, '')) ?? null;
    },
    /**
     * Is this token a published ship hull?
     *
     * Plurals resolve to their singular — "myrmidons", "stilettos", "lokis" all
     * appear in the corpus. Only ever a trailing -s, and only when the singular
     * is itself an exact hull, so it can't invent anything.
     *
     * Deliberately NO prefix matching: measured against the corpus, the
     * near-misses were "here"->Heretic, "are"->Ares, "out"->Outrider,
     * "red"->Redeemer — ordinary English words, every one a false positive.
     */
    isShip(token) {
      const t = String(token || '').toLowerCase();
      return ships.has(t) || (t.endsWith('s') && ships.has(t.slice(0, -1)));
    },

    /** Canonical hull name for a token (resolving plurals), or null. */
    shipName(token) {
      const t = String(token || '').toLowerCase();
      if (ships.has(t)) return t;
      const sing = t.endsWith('s') ? t.slice(0, -1) : null;
      return sing && ships.has(sing) ? sing : null;
    },

    /**
     * Every hull named in a message, preferring the LONGEST match.
     *
     * @returns {{hulls: string[], claimed: Set<string>}} `claimed` holds the
     *   individual words the hulls consumed, so the pilot extractor can skip
     *   them — "Omen Navy Issue" yields one hull and three claimed words rather
     *   than one hull plus a pilot called Navy.
     */
    matchShips(text) {
      const words = String(text || '').split(/[\s,()[\]/]+/).filter(Boolean).map(w => normalise(w));
      const hulls = [];
      const claimed = new Set();
      let i = 0;
      while (i < words.length) {
        let hit = null, span = 0;
        for (let n = Math.min(maxShipWords, words.length - i); n >= 1; n--) {
          const phrase = words.slice(i, i + n).join(' ');
          if (!phrase.trim()) continue;
          const canon = n > 1
            ? ((shipPhrases.get(n) && shipPhrases.get(n).has(phrase)) ? phrase : null)
            : (ships.has(phrase) ? phrase
               : (phrase.endsWith('s') && ships.has(phrase.slice(0, -1)) ? phrase.slice(0, -1) : null));
          if (canon) { hit = canon; span = n; break; }
        }
        if (hit) {
          hulls.push(hit);
          // Only MULTI-word hulls claim their words. "Omen Navy Issue" must
          // consume "navy" and "issue" or they surface as ghost pilots — but a
          // single-word hull must NOT, because plenty of them are ordinary
          // words that appear inside real names. Claiming "wolf" turned the
          // pilot "Wolf Eyes" into "Eyes". Single-word hulls are handled by the
          // trailing-noise rule in extractPilots instead, which strips a hull
          // appended AFTER a name without touching one inside it.
          if (span > 1) for (let k = 0; k < span; k++) claimed.add(words[i + k]);
          i += span;
        } else i++;
      }
      return { hulls: [...new Set(hulls)], claimed };
    },

    /**
     * Threat role for a hull or a piece of role jargon — 'tackle', 'cloaky',
     * 'ewar', 'capital', 'logi', or null for ordinary combat ships.
     */
    shipRole(token) {
      const t = String(token || '').toLowerCase();
      if (ROLE_WORDS[t]) return ROLE_WORDS[t];
      const hull = ships.has(t) ? t : (t.endsWith('s') && ships.has(t.slice(0, -1)) ? t.slice(0, -1) : null);
      return hull ? (shipRoleByName.get(hull) || null) : null;
    },
    size: byId.size,
    shipCount: ships.size,
    ambiguousNames: ambiguous,
    STOPWORDS,
  };
}

module.exports = { buildSystemIndex, STOPWORDS, SHIP_ROLE_GROUPS, ROLE_WORDS };
