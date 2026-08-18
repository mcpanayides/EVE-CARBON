'use strict';
//
// ─── fleet_ops_ipc.js — recording an op from the roster poll ──────────────────
//
// The renderer already polls the fleet roster every 6 seconds to draw the
// composition view (`src/func/fc.js`). When an op is running it hands each poll
// here as well, and this turns the stream of rosters into a record.
//
// WHY THE TRACKER LIVES IN MAIN, NOT THE RENDERER. The movement debounce is
// stateful — it has to remember which system is currently leading and for how
// many polls. Renderer state dies whenever the user navigates away from the
// Fleet page or the window reloads, and an FC absolutely will tab over to the
// map mid-fleet. Holding it here means a poll that resumes after five minutes
// away continues the same op instead of starting a fresh debounce that
// re-records the system the fleet never left.

const ops = require('../fleet_ops');
const kills = require('../fleet_kills');
const mining = require('../fleet_mining');
const aar = require('../fleet_aar');

// Consecutive polls a new system must hold the majority before it counts as the
// fleet having moved. At the 6s poll cadence this is ~18 seconds of the fleet
// genuinely being somewhere else, which is longer than any gate crossing and
// shorter than any real stop.
const HOLD_POLLS = 3;

function registerFleetOpHandlers({ ipcHandle, getCharDb, httpGet,
                                   loadDB, charInfoDb, resolveNames }) {
  /** Our own characters — the only ones ESI will report mining for. */
  const ourCharacterIds = () => {
    try { return Object.values((loadDB && loadDB().accounts) || {}).map((a) => Number(a.characterId)).filter(Boolean); }
    catch (_) { return []; }
  };
  // opId -> movement tracker. One entry, since only one op runs at a time, but
  // keyed so a stale tracker can never be applied to a newer op.
  const trackers = new Map();

  // The PROMISE is cached, not the tracker. Building one is async (it reads the
  // stored movement to resume from), so caching the result would let two polls
  // that arrive together both miss the map, both build a tracker, and the second
  // silently discard the first's debounce state.
  function trackerFor(db, opId) {
    let pending = trackers.get(opId);
    if (pending) return pending;

    pending = (async () => {
      const t = ops.createMovementTracker({ holdPolls: HOLD_POLLS });
      // Resume against what is already recorded, so restarting the app mid-op
      // does not re-record the system the fleet is standing in as a fresh
      // arrival — the log would show a move that never happened.
      const stored = await ops.getOp(db, opId);
      const last = stored && stored.movement.length ? stored.movement[stored.movement.length - 1] : null;
      if (last) t.resumeAt(last.solar_system_id);
      return t;
    })();

    trackers.set(opId, pending);
    return pending;
  }

  // ── Start / stop ───────────────────────────────────────────────────────────

  ipcHandle('fleet-op-start', async (_, { name, doctrine, bossCharacterId, fleetId } = {}) => {
    try {
      const db = getCharDb();
      if (!db) return { ok: false, error: 'database not ready' };

      // Only one op at a time. Starting a second would split one fleet's record
      // across two rows with no way to tell which poll belonged to which.
      const already = await ops.openOp(db);
      if (already) return { ok: false, error: 'An op is already running.', op: already };

      const opId = await ops.startOp(db, { name, doctrine, bossCharacterId, fleetId });

      // Photograph the mining counters NOW. The ledger is a daily running total
      // with no timestamp, so without a baseline taken at the start there is no
      // way to ever separate this op's yield from the rest of the pilot's day.
      // Taken for every one of our characters, not just those already in fleet —
      // people join late, and a baseline captured later would undercount them.
      if (charInfoDb && typeof charInfoDb.getMiningLedger === 'function') {
        for (const cid of ourCharacterIds()) {
          const ledger = await charInfoDb.getMiningLedger(cid).catch(() => []);
          if (ledger.length) await ops.saveMiningBaseline(db, opId, cid, ledger);
        }
      }
      return { ok: true, opId };
    } catch (e) {
      return { ok: false, error: e.message || 'could not start the op' };
    }
  });

  ipcHandle('fleet-op-stop', async (_, opId, reason) => {
    try {
      const db = getCharDb();
      if (!db) return { ok: false, error: 'database not ready' };
      await ops.endOp(db, opId, { reason: reason || 'stopped' });
      trackers.delete(opId);
      return { ok: true, op: await ops.getOp(db, opId) };
    } catch (e) {
      return { ok: false, error: e.message || 'could not stop the op' };
    }
  });

  // ── The recording path ─────────────────────────────────────────────────────

  ipcHandle('fleet-op-record', async (_, opId, members) => {
    try {
      const db = getCharDb();
      if (!db || !opId) return { ok: false };

      // A poll arriving for an op that has ended is not an error — the renderer
      // can have one in flight when the user hits stop — but it must not write.
      const op = await ops.openOp(db);
      if (!op || op.op_id !== opId) return { ok: false, ended: true };

      const at = Date.now();
      await ops.recordRoster(db, opId, members, at);
      // Undebounced, unlike movement below: this is the set the kill pull
      // searches, and a system omitted here loses every killmail in it.
      await ops.recordSystemsSeen(db, opId, members, at);

      const tracker = await trackerFor(db, opId);
      const move = tracker.observe(members);
      if (move) await ops.recordMovement(db, opId, move, at);

      return { ok: true, moved: move ? move.solarSystemId : null, system: tracker.currentSystem };
    } catch (e) {
      return { ok: false, error: e.message || 'could not record the poll' };
    }
  });

  // ── The kill pull (Phase 2) ────────────────────────────────────────────────
  //
  // One pass when the op closes, one request per system the fleet was SEEN in —
  // not per system it settled in. It goes through main's shared httpGet, which
  // means the broker's rate governor paces it at zKillboard's 1/s and the ESI
  // error-limit gate correctly sits it out (both are host-gated).

  ipcHandle('fleet-op-pull-kills', async (_, opId) => {
    try {
      const db = getCharDb();
      if (!db || !opId) return { ok: false, error: 'database not ready' };
      if (typeof httpGet !== 'function') return { ok: false, error: 'no network client wired' };

      const stored = await ops.getOp(db, opId);
      if (!stored) return { ok: false, error: 'op not found' };

      const systems = await ops.getOpSystems(db, opId);
      if (!systems.length) {
        return { ok: true, summary: kills.summarise([]), systemsSearched: 0, failed: [], truncated: [],
                 reason: 'This op recorded no systems — nothing to search.' };
      }

      const rosterIds = new Set(stored.roster.map((r) => r.character_id));
      const out = await kills.pullOpKills({
        systems,
        rosterIds,
        startedAt: stored.op.started_at,
        // A still-open op is pulled up to now; a closed one stops at its end, so
        // a fight that happened in the same system an hour later is not ours.
        endedAt: stored.op.ended_at || Date.now(),
        httpGet,
      });

      await ops.recordKills(db, opId, out.rows);
      return { ok: true, ...out, rows: undefined, found: out.rows.length };
    } catch (e) {
      return { ok: false, error: e.message || 'the kill pull failed' };
    }
  });

  // ── Mining (Phase 3) ───────────────────────────────────────────────────────
  //
  // Re-runnable on purpose. ESI caches the mining ledger for an hour and
  // `sync-mining-ledger` self-throttles to match, so a pull the moment a fleet
  // stands down cannot see the last stretch of mining. Running it again later
  // recomputes from the same baseline and corrects the numbers rather than
  // adding to them.

  ipcHandle('fleet-op-pull-mining', async (_, opId) => {
    try {
      const db = getCharDb();
      if (!db || !opId) return { ok: false, error: 'database not ready' };
      if (!charInfoDb || typeof charInfoDb.getMiningLedger !== 'function') {
        return { ok: false, error: 'mining ledger unavailable' };
      }

      const stored = await ops.getOp(db, opId);
      if (!stored) return { ok: false, error: 'op not found' };

      if (!(await ops.hasMiningBaseline(db, opId))) {
        // An op started before Phase 3 shipped, or one where no character had a
        // ledger. Saying so beats printing a confident zero.
        return { ok: true, skipped: true,
                 reason: 'No mining baseline was taken when this op started, so its yield cannot be separated from the rest of the day.' };
      }

      const rosterIds = new Set(stored.roster.map((r) => r.character_id));
      const systemIds = new Set((await ops.getOpSystems(db, opId)).map((s) => s.solar_system_id));

      // Only our characters who were actually IN the fleet. An alt mining at
      // home all evening is not part of this op.
      const measured = ourCharacterIds().filter((id) => rosterIds.has(id));

      const rows = [];
      let oldestSync = null;
      for (const cid of measured) {
        const [baseline, current] = await Promise.all([
          ops.getMiningBaseline(db, opId, cid),
          charInfoDb.getMiningLedger(cid).catch(() => []),
        ]);
        const syncedAt = await charInfoDb.getMiningLedgerSyncedAt(cid).catch(() => 0);
        if (syncedAt) oldestSync = oldestSync === null ? syncedAt : Math.min(oldestSync, syncedAt);

        const delta = mining.restrictToSystems(mining.computeDelta(baseline, current), systemIds);
        for (const d of delta) rows.push({ ...d, character_id: cid });
      }

      // Ore prices come from the valuation layer's type_prices, the same basis
      // the rest of the app values things at.
      const prices = new Map(
        (await db.all('SELECT type_id, unit_value FROM type_prices').catch(() => []))
          .map((r) => [r.type_id, r.unit_value]));
      const priced = mining.priceRows(rows, prices);

      await ops.recordMining(db, opId, priced, 'ledger');
      const summary = mining.summarise(priced,
        { pilotsInFleet: rosterIds.size, pilotsMeasured: measured.length });

      return { ok: true, summary, ledgerSyncedAt: oldestSync };
    } catch (e) {
      return { ok: false, error: e.message || 'the mining pull failed' };
    }
  });

  // ── The after action report (Phase 3) ──────────────────────────────────────

  ipcHandle('fleet-op-report', async (_, opId) => {
    try {
      const db = getCharDb();
      if (!db || !opId) return { ok: false, error: 'database not ready' };
      const stored = await ops.getOp(db, opId);
      if (!stored) return { ok: false, error: 'op not found' };

      // Resolve every id the report will print in ONE batch. Doing it per row
      // would be dozens of lookups for a report nobody is waiting on.
      const ids = new Set();
      for (const m of stored.movement) ids.add(m.solar_system_id);
      for (const r of stored.roster)   ids.add(r.ship_type_id);
      for (const k of stored.kills)    { if (k.victim_ship_type_id) ids.add(k.victim_ship_type_id); }
      for (const m of stored.mining)   { ids.add(m.type_id); ids.add(m.solar_system_id); }

      let lookup = {};
      if (typeof resolveNames === 'function' && ids.size) {
        lookup = await resolveNames([...ids]).catch(() => ({}));
      }
      const names = { systems: lookup, types: lookup, characters: lookup };

      const miningSummary = stored.mining.length
        ? mining.summarise(stored.mining.map((r) => ({ ...r, quantity: r.quantity, isk: r.isk })),
            { pilotsInFleet: new Set(stored.roster.map((r) => r.character_id)).size,
              pilotsMeasured: new Set(stored.mining.map((r) => r.character_id)).size })
        : null;

      const out = aar.render({
        op: stored.op, roster: stored.roster, movement: stored.movement,
        kills: stored.kills, mining: miningSummary, names, gaps: [],
      });
      return { ok: true, markdown: out.markdown, bbcode: out.bbcode, text: out.text, model: out.model };
    } catch (e) {
      return { ok: false, error: e.message || 'could not build the report' };
    }
  });

  // Save the report to a file. Copy-to-clipboard covers pasting into a forum
  // post; this covers attaching it, which is how some alliances want AARs filed.
  ipcHandle('fleet-op-save-report', async (_, { name, format, content }) => {
    try {
      const { dialog } = require('electron');
      const fs   = require('fs');
      const path = require('path');
      const ext  = format === 'markdown' ? 'md' : format === 'bbcode' ? 'txt' : 'txt';
      const safe = String(name || 'after-action-report').replace(/[^\w\- ]+/g, '').trim() || 'after-action-report';

      const res = await dialog.showSaveDialog({
        title: 'Save after action report',
        defaultPath: `${safe}.${ext}`,
        filters: [{ name: format === 'markdown' ? 'Markdown' : 'Text', extensions: [ext] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };

      fs.writeFileSync(res.filePath, String(content || ''), 'utf8');
      return { ok: true, path: res.filePath, name: path.basename(res.filePath) };
    } catch (e) {
      return { ok: false, error: e.message || 'could not save the report' };
    }
  });

  ipcHandle('fleet-op-set-notes', async (_, opId, notes) => {
    try {
      const db = getCharDb();
      if (!db || !opId) return { ok: false };
      await db.run(`UPDATE fleet_ops SET notes = ? WHERE op_id = ?`, [String(notes || ''), opId]);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Reading back ───────────────────────────────────────────────────────────

  ipcHandle('fleet-op-current', async () => {
    try {
      const db = getCharDb();
      if (!db) return null;
      return await ops.openOp(db);
    } catch (_) { return null; }
  });

  ipcHandle('fleet-op-list', async (_, limit) => {
    try {
      const db = getCharDb();
      if (!db) return [];
      return await ops.listOps(db, limit || 50);
    } catch (_) { return []; }
  });

  ipcHandle('fleet-op-get', async (_, opId) => {
    try {
      const db = getCharDb();
      if (!db) return null;
      return await ops.getOp(db, opId);
    } catch (_) { return null; }
  });
}

module.exports = { registerFleetOpHandlers, HOLD_POLLS };
