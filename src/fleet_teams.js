'use strict';
//
// ─── fleet_teams.js — who was on which side ──────────────────────────────────
//
// A battle report is only useful if the sides are right, and EVE gives us no
// usable way to ask. There is no "is this alliance blue to me" endpoint, and
// even if there were, standings are set per-corp, per-alliance and per-contact
// and change between downtimes. So the sides are INFERRED from the fight itself
// and then corrected by hand, rather than looked up.
//
// THE UNIT OF POLITICS IS THE ALLIANCE, NOT THE PILOT.
// Every assignment is keyed to an alliance id, falling back to the corporation
// id for the unaffiliated. Moving one pilot between columns would be busywork;
// moving their alliance is one action that fixes the whole fight, and it is what
// an FC means when they say "those guys are with us".
//
// THE RULES, IN PRIORITY ORDER
//
//   1. A manual override always wins — the FC's call, never inferred over.
//   2. On our op roster              -> US
//   3. Same alliance/corp as boss    -> US        (blues in the same fleet)
//   4. Attacked alongside one of ours-> FRIENDLY  (co-belligerent)
//   5. We shot them, or they shot us -> HOSTILE
//   6. Anything else on the field    -> HOSTILE, flagged `inferred`
//
// Rule 4 is the one that earns its keep: it learns friendlies from the battle
// rather than from a standings list, so it keeps working when the politics move.
// Rule 6 defaults to HOSTILE deliberately — an unknown on grid is more often an
// enemy than a friend, and the cost of being wrong is one click.

const US       = 'us';
const FRIENDLY = 'friendly';
const HOSTILE  = 'hostile';
const TEAMS    = [US, FRIENDLY, HOSTILE];

/** Alliance if there is one, else corp. Null for NPCs and unowned structures. */
function entityKey(p) {
  if (!p) return null;
  const a = p.alliance_id ?? p.allianceId;
  if (a) return 'a:' + a;
  const c = p.corporation_id ?? p.corporationId;
  if (c) return 'c:' + c;
  return null;
}

const attackersOf = (km) => (Array.isArray(km && km.attackers) ? km.attackers : []);
const victimOf    = (km) => (km && km.victim) || null;
const charOf      = (p)  => (p && (p.character_id ?? p.characterId)) || null;

/**
 * Work out a team for every entity appearing in the killmails.
 *
 * @param {Array}  killmails  zKill/ESI shaped mails ({ victim, attackers, zkb })
 * @param {Object} opts
 * @param {Set}    opts.rosterIds          character ids in our fleet
 * @param {number} [opts.bossAllianceId]
 * @param {number} [opts.bossCorporationId]
 * @param {Object} [opts.overrides]        { [entityKey]: team } — FC corrections
 * @returns {Map} entityKey -> entity record
 */
function assignTeams(killmails, { rosterIds = new Set(), bossAllianceId = null,
                                  bossCorporationId = null, overrides = {} } = {}) {
  const out  = new Map();
  const ours = new Set();
  if (bossAllianceId)    ours.add('a:' + bossAllianceId);
  if (bossCorporationId) ours.add('c:' + bossCorporationId);

  const touch = (p) => {
    const key = entityKey(p);
    if (!key) return null;
    let e = out.get(key);
    if (!e) {
      e = {
        key, team: null, reason: null,
        allianceId:    p.alliance_id ?? p.allianceId ?? null,
        corporationId: p.corporation_id ?? p.corporationId ?? null,
        pilots: new Set(), ships: new Set(),
        losses: 0, kills: 0, iskLost: 0,
      };
      out.set(key, e);
    }
    const cid = charOf(p);
    if (cid) e.pilots.add(cid);
    const sid = p.ship_type_id ?? p.shipTypeId;
    if (sid) e.ships.add(sid);
    return e;
  };

  // Pass 1 — register everyone and mark the sides each mail implies. Two passes
  // are needed because co-belligerence (rule 4) cannot be judged until we know
  // which mails involved us at all.
  const oursAttacked = [];
  for (const km of killmails || []) {
    const v    = victimOf(km);
    const ve   = touch(v);
    const isk  = Number(km && km.zkb && km.zkb.totalValue) || 0;
    if (ve) { ve.losses += 1; ve.iskLost += isk; }

    let weAttacked = false;
    for (const a of attackersOf(km)) {
      const ae = touch(a);
      if (ae) ae.kills += 1;
      const cid = charOf(a);
      if (cid && rosterIds.has(cid)) weAttacked = true;
    }

    const victimIsOurs = !!(charOf(v) && rosterIds.has(charOf(v)));
    if (weAttacked) oursAttacked.push(km);
    if (weAttacked && !victimIsOurs && ve) ve._weShotThem = true;
    if (victimIsOurs) {
      for (const a of attackersOf(km)) {
        const ae = touch(a);
        if (ae) ae._theyShotUs = true;
      }
    }
  }

  // Pass 2 — anyone who attacked on the same mail as us fought alongside us.
  for (const km of oursAttacked) {
    for (const a of attackersOf(km)) {
      const ae = touch(a);
      if (ae) ae._foughtWithUs = true;
    }
  }

  // Pass 3 — decide, highest-priority rule first.
  for (const e of out.values()) {
    const ov = overrides[e.key];
    if (ov && TEAMS.includes(ov)) { e.team = ov; e.reason = 'override'; }
    else if ([...e.pilots].some((p) => rosterIds.has(p))) { e.team = US; e.reason = 'roster'; }
    else if (ours.has(e.key))     { e.team = US;       e.reason = 'boss-org'; }
    else if (e._foughtWithUs)     { e.team = FRIENDLY; e.reason = 'fought-with-us'; }
    else if (e._weShotThem || e._theyShotUs) { e.team = HOSTILE; e.reason = 'engaged'; }
    else                          { e.team = HOSTILE; e.reason = 'inferred'; }

    delete e._weShotThem;
    delete e._theyShotUs;
    delete e._foughtWithUs;
  }

  return out;
}

/**
 * Chronological losses, tagged with the team that lost the ship.
 *
 * Columns show what each side LOST, which is what a battle report is: "Team B
 * lost 62 ships" is the readable fact. Grouping by killer would put one mail in
 * several columns at once.
 */
function buildTimeline(killmails, teams) {
  const rows = [];
  for (const km of killmails || []) {
    const v = victimOf(km);
    if (!v) continue;
    const key = entityKey(v);
    const e   = key && teams.get(key);
    const at  = Date.parse(km.killmail_time || km.killmailTime || 0) || Number(km.at) || 0;
    rows.push({
      killmailId:    km.killmail_id ?? km.killmailId ?? null,
      at,
      solarSystemId: km.solar_system_id ?? km.solarSystemId ?? null,
      team:          e ? e.team : HOSTILE,
      entityKey:     key,
      characterId:   charOf(v),
      corporationId: v.corporation_id ?? v.corporationId ?? null,
      allianceId:    v.alliance_id ?? v.allianceId ?? null,
      shipTypeId:    v.ship_type_id ?? v.shipTypeId ?? null,
      isk:           Number(km.zkb && km.zkb.totalValue) || 0,
      npc:           !!(km.zkb && km.zkb.npc),
    });
  }
  return rows.sort((a, b) => a.at - b.at || (a.killmailId || 0) - (b.killmailId || 0));
}

/** Per-team totals for the column headers, mirroring a battle report's summary. */
function summariseTeams(timeline) {
  const base = () => ({ ships: 0, isk: 0, pilots: new Set() });
  const acc  = { [US]: base(), [FRIENDLY]: base(), [HOSTILE]: base() };
  for (const r of timeline || []) {
    const t = acc[r.team] || acc[HOSTILE];
    t.ships += 1;
    t.isk   += r.isk;
    if (r.characterId) t.pilots.add(r.characterId);
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) =>
    [k, { ships: v.ships, isk: v.isk, pilots: v.pilots.size }]));
}

module.exports = {
  US, FRIENDLY, HOSTILE, TEAMS,
  entityKey, assignTeams, buildTimeline, summariseTeams,
};
