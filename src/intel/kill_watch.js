'use strict';

const { ESI_BASE } = require('../app_ident');   // one base, one place — see src/shared/esi.js
//
// Kill data as a second intel source, fused with chat.
//
// Chat intel is fast but human: misspelt, ambiguous, sometimes wrong, and it
// stops entirely when nobody is watching a gate. Killmails are the opposite —
// slower, but objective. A kill happened, in that system, at that second, with
// those ships. Nothing to parse and nothing to disbelieve.
//
// THREE SOURCES, AND THEY ANSWER DIFFERENT QUESTIONS:
//
//  1. ESI /universe/system_kills/  — ship/pod/NPC kills per system for the last
//     hour, whole galaxy, one unauthenticated call. CCP caches it for an hour,
//     so it is CONTEXT, never an alarm: "the four systems north of us have 11
//     ship kills in the last hour" tells a mining director whether to undock at
//     all. Polling it faster than its own TTL would just burn the error budget
//     for identical bytes.
//
//  2. zKillboard per monitored character — the feed the app already imports.
//     A LOSS by one of our own pilots is the least ambiguous intel that exists:
//     something killed us, there, minutes ago. That is alarm-grade, and it goes
//     into the proximity tracker as a hostile sighting.
//
//  3. zKillboard's live stream (src/intel/zkill_stream.js) — every killmail in
//     New Eden seconds after it happens, unauthenticated. The one that works with
//     the GAME CLOSED: EVE writes the chat logs, so no client means no chat
//     intel, but a kill is server-side and gets rebroadcast regardless. Filtered
//     to systems near the monitored characters, because the raw feed is the
//     whole galaxy and nearly all of it is somebody else's war.
//
// FOR SOURCE 2 THE VICTIM IS THE SIGNAL; FOR SOURCE 3 IT IS THE ATTACKERS.
// Our own loss says "something killed us here". A stranger's loss four jumps out
// says nothing about the victim and everything about who killed them — that is
// the gang, its size, and what it was flying. Both reduce to the same rule:
// THE ATTACKERS ARE THE HOSTILES, which is why one report shape serves both.
//
// Our own KILLS are still not warnings: a hostile who was there and is now dead
// is the opposite of a threat.

const SYSTEM_KILLS_URL = `${ESI_BASE}/universe/system_kills/`;

/**
 * One killmail, whatever wrapper it arrived in.
 *
 * zKillboard has shipped two different envelopes, and the difference is not
 * cosmetic. The retired RedisQ sent `{ package: { killmail, zkb } }`. R2Z2 sends
 *
 *   { killmail_id, hash, esi: { …the ESI killmail… }, zkb, uploaded_at, sequence_id }
 *
 * — the ESI body lives under `esi`, which was confirmed against the live feed
 * after an earlier version of this function looked only for `killmail` and would
 * therefore have discarded every kill in silence while the stream reported
 * itself perfectly healthy.
 *
 * So rather than trusting any one key, this identifies the killmail by the
 * fields it cannot lack — `victim` and `attackers` — and looks in each place the
 * body has been known to sit. The envelope has changed once already.
 */
function normalisePackage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw.package || raw;
  if (!outer || typeof outer !== 'object') return null;

  const looksLikeKillmail = (o) => o && typeof o === 'object' && o.victim && Array.isArray(o.attackers);
  const km = [outer.esi, outer.killmail, outer].find(looksLikeKillmail) || null;
  if (!km) return null;

  return {
    killmail: {
      ...km,
      // The id and time can sit on the wrapper rather than the killmail itself.
      killmail_id:   km.killmail_id   ?? outer.killmail_id   ?? outer.killID ?? null,
      killmail_time: km.killmail_time ?? outer.killmail_time ?? null,
    },
    zkb: outer.zkb || raw.zkb || {},
  };
}

// Matches the endpoint's own cache. See note (1).
const SYSTEM_KILLS_TTL_MS = 60 * 60 * 1000;
// zKillboard's per-entity feed is cached ~10 min upstream in character_ipc.js;
// polling faster returns the same rows.
const ZKILL_POLL_MS = 10 * 60 * 1000;
// A loss older than this says nothing about who is nearby now.
const LOSS_RELEVANT_MS = 20 * 60 * 1000;

/**
 * @param {object} deps
 * @param {Function} deps.httpGet          (url) => parsed JSON
 * @param {Function} deps.getZkillFeed     (kind, entityId) => rows (the app's cached feed)
 * @param {Function} deps.onKillReport     synthetic hostile report → proximity tracker
 * @param {Function} [deps.onActivity]     (Map systemId -> {shipKills, podKills, npcKills})
 * @param {Function} [deps.isRelevant]     (systemId) => bool — is this near us at all
 * @param {Function} [deps.shipFor]        (typeId) => { name, role } | null
 */
function createKillWatch({ httpGet, getZkillFeed, onKillReport, onActivity,
                           isRelevant, shipFor } = {}) {
  let activity   = new Map();   // systemId -> kill counts, last hour
  let activityAt = 0;
  let timer      = null;
  let monitored  = [];          // [{ characterId, name }]
  const seenKills = new Set();  // killmail ids already turned into reports

  async function refreshSystemKills(now = Date.now()) {
    // Absent when the live feed is the only source in use — nothing to poll.
    if (!httpGet) return activity;
    if (now - activityAt < SYSTEM_KILLS_TTL_MS) return activity;
    try {
      const rows = await httpGet(SYSTEM_KILLS_URL);
      if (!Array.isArray(rows)) return activity;
      const next = new Map();
      for (const r of rows) {
        // NPC kills are ratting, not danger — kept separate rather than summed,
        // because a system full of NPC kills is a quiet ratting system and
        // conflating the two would paint it as a warzone.
        next.set(r.system_id, {
          shipKills: r.ship_kills || 0,
          podKills:  r.pod_kills  || 0,
          npcKills:  r.npc_kills  || 0,
        });
      }
      activity   = next;
      activityAt = now;
      onActivity && onActivity(activity);
    } catch (e) {
      console.warn('[intel] system kills fetch failed:', e.message);
    }
    return activity;
  }

  /**
   * Turn recent LOSSES by monitored characters into hostile sightings.
   *
   * Shaped exactly like a parsed chat report so the proximity tracker needs no
   * special case — a kill is just another sighting, with a source label.
   */
  async function refreshLosses(now = Date.now()) {
    if (!getZkillFeed) return;
    for (const char of monitored) {
      let rows;
      try { rows = await getZkillFeed('character', char.characterId); }
      catch (_) { continue; }
      if (!Array.isArray(rows)) continue;

      for (const k of rows) {
        if (!k.isLoss || !k.systemId) continue;
        if (seenKills.has(k.killmailId)) continue;
        const ts = Date.parse(k.time);
        if (!Number.isFinite(ts) || now - ts > LOSS_RELEVANT_MS) continue;
        seenKills.add(k.killmailId);

        onKillReport && onKillReport({
          source:     'killmail',
          channel:    'zkillboard',
          ts,
          author:     'zKillboard',
          body:       `${char.name} lost a ship — ${k.attackerCount} attacker${k.attackerCount === 1 ? '' : 's'}`,
          systemId:   k.systemId,
          systemName: null,          // resolved by the caller against the SDE
          status:     'hostile',
          count:      k.attackerCount || null,
          // No pilot names: zKill gives IDs, and resolving every attacker would
          // be a burst of lookups for a contact the chat channels usually name
          // anyway. The system-level track still carries it.
          pilots:     [],
          ships:      [],
          confidence: 'exact',
          killmailId: k.killmailId,
          totalValue: k.totalValue,
        });
      }
    }
    // Shared with ingestPackage, which is the point: the live stream delivers a kill
    // within seconds and this poll re-delivers the same one up to ten minutes
    // later, so one dedupe set across both sources is what stops the slow path
    // re-reporting what the fast path already warned about.
    bound();
  }

  /**
   * One killmail off the live feed.
   *
   * Everything here is a reason to throw the package away — the feed is the
   * whole galaxy, and at peak that is thousands of kills an hour of which
   * essentially none are ours. Returns the report it produced, or null.
   */
  function ingestPackage(pkg, now = Date.now()) {
    const norm = normalisePackage(pkg);
    if (!norm) return null;
    const { killmail: km, zkb } = norm;
    if (km.solar_system_id == null || km.killmail_id == null) return null;
    if (seenKills.has(km.killmail_id)) return null;

    const ts = Date.parse(km.killmail_time);
    if (!Number.isFinite(ts) || now - ts > LOSS_RELEVANT_MS) return null;

    // Rats killing a ratter is not an intel event. Left in the feed it would be
    // most of the feed — and it would put a "hostile" marker on every quiet
    // ratting system in range, which is precisely backwards.
    if (zkb.npc) return null;

    // The whole galaxy is in this stream; almost none of it is near us.
    if (isRelevant && !isRelevant(km.solar_system_id)) return null;

    // Players only. NPC entries pad `attackers` on any kill where rats joined
    // in, and counting them would inflate the reported gang size.
    const players = (km.attackers || []).filter(a => a && a.character_id != null);
    if (!players.length) return null;

    seenKills.add(km.killmail_id);
    bound();

    const hulls = [], roles = new Set();
    for (const a of players) {
      const s = shipFor && shipFor(a.ship_type_id);
      if (!s) continue;
      if (!hulls.includes(s.name)) hulls.push(s.name);
      if (s.role) roles.add(s.role);
    }

    // Corp and alliance ids come free on a killmail. That is a better standings
    // lookup than chat ever gets: intel is written in names that have to be
    // resolved, whereas this is already the key the contact sheet uses.
    const entityIds = [];
    for (const a of players) {
      if (a.alliance_id    != null) entityIds.push(a.alliance_id);
      if (a.corporation_id != null) entityIds.push(a.corporation_id);
    }

    const victim  = km.victim || {};
    const ourLoss = monitored.some(m => Number(m.characterId) === Number(victim.character_id));
    const victimShip = shipFor && shipFor(victim.ship_type_id);

    const report = {
      source:  'killmail',
      channel: 'zkillboard',
      ts,
      author:  'zKillboard',
      body: `${ourLoss ? 'WE lost' : 'Kill:'} ${victimShip ? victimShip.name : 'a ship'} — ` +
            `${players.length} attacker${players.length === 1 ? '' : 's'}` +
            (hulls.length ? ` (${hulls.slice(0, 4).join(', ')})` : ''),
      systemId:   km.solar_system_id,
      systemName: null,          // resolved by the caller against the SDE
      status:     'hostile',
      // The gang is who did the killing, whoever died.
      count:  players.length,
      // No names: zKillboard sends character ids, and resolving every attacker
      // would be a burst of lookups per kill for a contact the chat channels
      // usually name anyway. The system-level track still carries it.
      pilots: [],
      ships:  hulls.slice(0, 6),
      roles:  [...roles],
      confidence: 'exact',
      killmailId: km.killmail_id,
      totalValue: zkb.totalValue || null,
      entityIds:  [...new Set(entityIds)],
      ourLoss,
      solo: !!zkb.solo,
    };
    onKillReport && onKillReport(report);
    return report;
  }

  /** One op cannot produce thousands of kills, but a long session shouldn't grow forever. */
  function bound() {
    if (seenKills.size <= 500) return;
    const keep = [...seenKills].slice(-250);
    seenKills.clear();
    for (const id of keep) seenKills.add(id);
  }

  return {
    setMonitored(list) { monitored = Array.isArray(list) ? list : []; },
    ingestPackage,

    /** Kill counts for a system in the last hour (null if unknown). */
    activityFor(systemId) { return activity.get(systemId) || null; },

    /** Everything we know, for the UI's activity column. */
    snapshot() { return { activity, activityAt, monitored: monitored.length }; },

    async refresh(now = Date.now()) {
      await refreshSystemKills(now);
      await refreshLosses(now);
    },

    start() {
      if (timer) return;
      const run = () => this.refresh().catch(() => {});
      run();
      // Driven by the FASTER of the two sources; each refresh internally
      // respects its own TTL, so the slow one isn't re-fetched needlessly.
      timer = setInterval(run, ZKILL_POLL_MS);
      if (timer.unref) timer.unref();
    },

    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = {
  createKillWatch, normalisePackage,
  SYSTEM_KILLS_URL, SYSTEM_KILLS_TTL_MS, ZKILL_POLL_MS, LOSS_RELEVANT_MS,
};
