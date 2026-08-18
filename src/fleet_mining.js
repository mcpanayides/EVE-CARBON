'use strict';
//
// ─── fleet_mining.js — what the fleet actually pulled out of the belt ─────────
//
// Phase 3 of the Fleet Tracker.
//
// ── Read this before trusting a number out of here ───────────────────────────
//
// `/characters/{character_id}/mining` returns `{date, solar_system_id, type_id,
// quantity}` — a DAILY RUNNING TOTAL with no timestamp — and only for characters
// we hold a token for. Verified against the ESI OpenAPI spec on 2026-08-17.
// Three consequences follow, and all three are limits of the API, not of this
// code:
//
//  1. THERE IS NO LIVE ORE COUNTER, for anyone. Not for the fleet, not even for
//     your own pilots. The only way to score an op is to photograph the daily
//     counter at the start and subtract at the end.
//  2. WE CAN ONLY SEE OUR OWN CHARACTERS. There is no ESI route that reports
//     another pilot's mining, so a 40-pilot mining fleet reports the yield of
//     however many of those pilots are on this installation. That is usually a
//     small fraction, and the report MUST say so — an alt-only total read as a
//     fleet total would badly understate the op.
//  3. IT IS UP TO AN HOUR BEHIND. ESI caches the route for 3600s and
//     `sync-mining-ledger` self-throttles to match, because asking more often
//     returns identical bytes. So a pull the moment a fleet stands down misses
//     the last stretch of mining. Hence `computeDelta` being re-runnable:
//     running it again an hour later corrects the numbers instead of adding to
//     them.
//
// The one fleet-wide source that does exist is
// `/corporation/{corporation_id}/mining/observers/{observer_id}`, which reports
// per-character quantities for EVERYONE mining at that observer. It needs
// director access and only covers moon drills and corp structures — not belt
// mining — so it is an addition to the above, never a replacement.

/** The ledger's own key. A day rolls over mid-op and that has to stay separable. */
const key = (r) => `${r.date}|${r.solar_system_id}|${r.type_id}`;

/**
 * What was mined between the baseline photograph and now.
 *
 * Pure, and the whole correctness of the feature is here.
 *
 * @param {Array} baseline  ledger rows captured at op start
 * @param {Array} current   ledger rows now
 * @returns {Array} {solar_system_id, type_id, quantity} — only positive deltas
 */
function computeDelta(baseline, current) {
  const before = new Map((baseline || []).map((r) => [key(r), r.quantity || 0]));
  const out = new Map();

  for (const row of current || []) {
    const was = before.get(key(row)) || 0;      // absent from the baseline = all of it is new
    const gained = (row.quantity || 0) - was;

    // Negative deltas are dropped rather than subtracted. A running total should
    // never fall, so a negative means the ledger rolled its 30-day window or the
    // baseline was captured from staler data than `current` — either way it is
    // an artefact, and letting it offset a real gain elsewhere would silently
    // under-report the op.
    if (gained <= 0) continue;

    const k = `${row.solar_system_id}|${row.type_id}`;   // date is collapsed: an op is one outing
    out.set(k, (out.get(k) || 0) + gained);
  }

  return [...out].map(([k, quantity]) => {
    const [solar_system_id, type_id] = k.split('|').map(Number);
    return { solar_system_id, type_id, quantity };
  }).sort((a, b) => b.quantity - a.quantity);
}

/**
 * Keep only what was mined in systems the fleet was actually in.
 *
 * Without this, an alt ratting in a belt at home all evening lands in the fleet's
 * mining total. The op knows exactly where it was — use it.
 */
function restrictToSystems(rows, systemIds) {
  if (!systemIds || !systemIds.size) return rows;
  return rows.filter((r) => systemIds.has(r.solar_system_id));
}

/** Value the haul. `prices` is type_id -> unit_value from the valuation layer. */
function priceRows(rows, prices) {
  return rows.map((r) => ({
    ...r,
    isk: prices && prices.has(r.type_id) ? prices.get(r.type_id) * r.quantity : null,
  }));
}

/**
 * Roll the per-character rows up for display.
 *
 * `coverage` is the honest part: how many pilots were in fleet against how many
 * we could actually see. A UI showing "4.2m units" without "from 3 of 41 pilots"
 * is not a smaller truth, it is a wrong one.
 */
function summarise(rows, { pilotsInFleet = 0, pilotsMeasured = 0 } = {}) {
  const byType = new Map();
  const bySystem = new Map();
  let units = 0, isk = 0, priced = 0;

  for (const r of rows) {
    units += r.quantity;
    if (typeof r.isk === 'number') { isk += r.isk; priced++; }
    byType.set(r.type_id, (byType.get(r.type_id) || 0) + r.quantity);
    bySystem.set(r.solar_system_id, (bySystem.get(r.solar_system_id) || 0) + r.quantity);
  }

  return {
    units,
    isk: priced ? isk : null,
    // Flagged rather than hidden: a partly-priced total is a floor, not a value.
    fullyPriced: priced === rows.length,
    byType:   [...byType].map(([type_id, quantity]) => ({ type_id, quantity })).sort((a, b) => b.quantity - a.quantity),
    bySystem: [...bySystem].map(([solar_system_id, quantity]) => ({ solar_system_id, quantity })).sort((a, b) => b.quantity - a.quantity),
    coverage: { pilotsInFleet, pilotsMeasured },
  };
}

module.exports = { computeDelta, restrictToSystems, priceRows, summarise };
