'use strict';
//
// ─── fleet_kills.js — what the fleet killed and what it lost ─────────────────
//
// Phase 2 of the Fleet Tracker. Runs ONCE, when the op closes.
//
// ── Why one pull at the end instead of a live stream ─────────────────────────
//
// The obvious build is to subscribe to zKillboard's live feed for the duration
// of the fleet and match kills as they arrive. Measured, that is ~1,800 requests
// for a three-hour fleet. This is ~15 — one per system the fleet touched — and
// it captures every pilot in fleet rather than only the ones we hold tokens for.
// About 120x less traffic against a free, volunteer-run service, for a strictly
// better result. The live stream still exists for Early Warning, where being
// late actually matters; an after-action report is not in a hurry.
//
// ── Why zKillboard rather than ESI ───────────────────────────────────────────
//
// ESI's killmail routes need a scope we do not request, only cover characters
// and corps we hold tokens for, and return `{killmail_id, killmail_hash}` with
// no timestamp — so finding one fleet's worth means paging and then fetching
// every killmail individually to discover when it happened.
//
// zKillboard's system endpoint returns the FULL killmail inline (verified
// against the live API 2026-08-17: `attackers[]`, `victim{}`, `killmail_time`,
// `solar_system_id`) plus a `zkb` block carrying `totalValue`. One request per
// system, no authentication, no scope, everyone in fleet covered regardless of
// corp, and ISK values we do not have to compute.
//
// Rate: every request goes through the broker's `zkillboard.com` bucket (1/s),
// so a 15-system op takes ~15 seconds and cannot stampede.

// zKillboard's documented constraints (API wiki, checked 2026-08-17):
//   "pastSeconds can maximum go up to 7 days (604800 seconds) and must be a
//    multiple of 3600"
//   "The API will deliver a maximum of 1000 killmails per request"
const HOUR_S        = 3600;
const MAX_PAST_S    = 604800;          // 7 days
const PAGE_SIZE     = 1000;
const MAX_PAGES     = 5;               // 5000 kills in one system in one op is not a fleet fight, it is a bug
const ZKILL_BASE    = 'https://zkillboard.com/api';

/**
 * The `pastSeconds` value that covers an op, rounded to zKillboard's grid.
 *
 * Rounds UP: an op that started 3h10m ago needs 4 hours of history, and asking
 * for 3 would silently miss the first ten minutes — the form-up, which is where
 * the first tackle usually dies.
 *
 * @returns {number|null} null when the op began more than 7 days ago, which the
 *   API cannot answer at all. Null means "cannot pull", not "pull nothing", and
 *   the caller must say so rather than reporting an empty result as zero kills.
 */
function pastSecondsFor(startedAt, now = Date.now()) {
  const elapsed = Math.max(0, now - startedAt) / 1000;
  const rounded = Math.ceil((elapsed + 1) / HOUR_S) * HOUR_S;   // +1s so an exact multiple still covers its own edge
  if (rounded > MAX_PAST_S) return null;
  return Math.max(HOUR_S, rounded);
}

/** zKillboard URL for one system over a window. Two modifiers — their API requires at least two. */
function systemUrl(solarSystemId, pastSeconds, page = 1) {
  const base = `${ZKILL_BASE}/systemID/${solarSystemId}/pastSeconds/${pastSeconds}/`;
  return page > 1 ? `${base}page/${page}/` : base;
}

/**
 * Decide whether a killmail belongs to this op, and on which side.
 *
 * THE ASYMMETRY THAT MATTERS: a killmail is ours if any ATTACKER is in the
 * roster (a fleet kill carries a dozen attackers, so this catches nearly
 * everything), but it is a LOSS only if the VICTIM is one of ours.
 *
 * A mail with our pilots on both sides is a LOSS, not a kill. Someone in fleet
 * shot a fleetmate — an awox, a smartbomb, a mistake — and counting that as a
 * kill would make a fleet look more successful the more of its own it shot.
 *
 * @returns {object|null} a row to store, or null when the mail is not ours or
 *   falls outside the op window.
 */
function classifyKillmail(km, rosterIds, { startedAt, endedAt }) {
  if (!km || !km.killmail_id) return null;

  const at = Date.parse(km.killmail_time);
  if (!Number.isFinite(at)) return null;
  if (at < startedAt || at > endedAt) return null;      // outside the op

  const victimId  = km.victim && km.victim.character_id;
  const attackers = Array.isArray(km.attackers) ? km.attackers : [];

  const ourAttackers = attackers.filter((a) => a && a.character_id && rosterIds.has(a.character_id));
  const victimIsOurs = !!(victimId && rosterIds.has(victimId));
  if (!victimIsOurs && !ourAttackers.length) return null;   // somebody else's fight

  const finalBlow = attackers.find((a) => a && a.final_blow);
  const zkb = km.zkb || {};

  return {
    killmailId:   km.killmail_id,
    killmailHash: zkb.hash || null,
    at,
    solarSystemId: km.solar_system_id || null,
    side: victimIsOurs ? 'loss' : 'kill',
    victimCharacterId:   victimId || null,
    victimCorporationId: (km.victim && km.victim.corporation_id) || null,
    victimAllianceId:    (km.victim && km.victim.alliance_id) || null,
    victimShipTypeId:    (km.victim && km.victim.ship_type_id) || null,
    isk: typeof zkb.totalValue === 'number' ? zkb.totalValue : null,
    finalBlowCharacterId: (finalBlow && finalBlow.character_id) || null,
    // How many of ours were on the mail. On a loss this is friendly fire and is
    // worth seeing; on a kill it is how much of the fleet was actually involved.
    involved: ourAttackers.length,
    npc: !!zkb.npc,
  };
}

/** Kills, losses and ISK either way — the numbers an AAR opens with. */
function summarise(rows) {
  const kills  = rows.filter((r) => r.side === 'kill');
  const losses = rows.filter((r) => r.side === 'loss');
  const isk = (list) => list.reduce((n, r) => n + (r.isk || 0), 0);
  return {
    kills: kills.length,
    losses: losses.length,
    iskDestroyed: isk(kills),
    iskLost: isk(losses),
    efficiency: (isk(kills) + isk(losses)) > 0
      ? isk(kills) / (isk(kills) + isk(losses)) : null,
  };
}

/**
 * Pull every killmail for an op.
 *
 * @param {object}   args
 * @param {Array}    args.systems    every system the fleet was SEEN in (not just
 *                                   the debounced movement log — a kill in a
 *                                   system the fleet only crossed still counts).
 * @param {Set}      args.rosterIds  character ids that were in fleet.
 * @param {Function} args.httpGet    (url) => parsed JSON. Rate-limited upstream.
 * @returns {Promise<{rows:Array, summary:object, systemsSearched:number,
 *                    failed:Array, truncated:Array, reason?:string}>}
 */
async function pullOpKills({ systems, rosterIds, startedAt, endedAt = Date.now(),
                             httpGet, now = Date.now() }) {
  const pastSeconds = pastSecondsFor(startedAt, now);
  if (pastSeconds === null) {
    // Deliberately not an empty success. "No kills found" and "we cannot look"
    // are different answers and an AAR must not print the first when it means
    // the second.
    return { rows: [], summary: summarise([]), systemsSearched: 0, failed: [], truncated: [],
             reason: 'This op started more than 7 days ago — zKillboard cannot search that far back.' };
  }

  const rows = [];
  const seen = new Set();          // killmail_id — a mail can surface in more than one pull
  const failed = [];
  const truncated = [];

  for (const sys of systems) {
    const systemId = sys.solar_system_id ?? sys;
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await httpGet(systemUrl(systemId, pastSeconds, page));
        if (!Array.isArray(batch) || !batch.length) break;

        for (const km of batch) {
          if (seen.has(km && km.killmail_id)) continue;
          const row = classifyKillmail(km, rosterIds, { startedAt, endedAt });
          if (row) { seen.add(row.killmailId); rows.push(row); }
        }

        if (batch.length < PAGE_SIZE) break;                    // last page
        if (page === MAX_PAGES) truncated.push(systemId);       // hit the ceiling — say so
      }
    } catch (e) {
      // One unreachable system must not lose the other fourteen. Recorded so the
      // report can say it is incomplete rather than quietly under-counting.
      failed.push({ systemId, error: e.message || 'request failed' });
    }
  }

  rows.sort((a, b) => a.at - b.at);
  return { rows, summary: summarise(rows), systemsSearched: systems.length, failed, truncated };
}

module.exports = {
  pastSecondsFor,
  systemUrl,
  classifyKillmail,
  summarise,
  pullOpKills,
  HOUR_S,
  MAX_PAST_S,
  PAGE_SIZE,
  MAX_PAGES,
  ZKILL_BASE,
};
