'use strict';
//
// ─── universe.js — public ESI for demo mode: snapshots and a market ───────────
//
// The answers for every route that is the same for everyone — cost indices,
// sovereignty, faction warfare, incursions, traffic, prices. They come from
// snapshots/ (see scripts/demo-snapshot.js for how each was taken and altered)
// and are shaped back into ESI's own JSON here, so the app's real mapping code
// runs on them exactly as it would on a live response.
//
// Snapshot timestamps are stored as offsets from when they were taken. A sov
// timer captured on Monday must still be upcoming whenever the demo is opened,
// so recurring times (vulnerability windows, campaign starts) are folded into
// the next day or two, and one-off times (claimed since, signature ages) are
// replayed relative to now.
//
// Snapshots are loaded on first use, not at require time: the fixtures module is
// required on every intercepted request, and most launches never open the map.

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const _cache = {};
function snap(name) {
  if (!(name in _cache)) {
    try { _cache[name] = require(`./snapshots/${name}.json`); }
    catch (_) { _cache[name] = null; }
  }
  return _cache[name];
}
const iso = (ms) => new Date(ms).toISOString();

// Fold a stored offset into [lo, lo + span) from now — for times that recur, or
// that only matter while they are still ahead.
const fold = (now, offset, span, lo = 0) => now + lo + ((((offset - lo) % span) + span) % span);

// ── Prices ───────────────────────────────────────────────────────────────────
// CCP's bulk list: [adjusted, average] per type. Jita sell runs a little over
// the traded average and buy a little under — the gap the valuation, the
// appraisal and the trading tools all read.
function priceOf(typeId) {
  const p = (snap('prices') || {})[typeId];
  if (!p) return null;
  const avg = p[1] || p[0];
  return avg > 0 ? { adjusted: p[0], average: avg, sell: avg * 1.02, buy: avg * 0.94 } : null;
}

/** CCP /markets/prices/ — every type the snapshot holds, as CCP serves it. */
function marketPrices() {
  return Object.entries(snap('prices') || {}).map(([id, [adjusted_price, average_price]]) =>
    ({ type_id: Number(id), adjusted_price, average_price }));
}

// ── Cost indices ─────────────────────────────────────────────────────────────
function industrySystems() {
  const s = snap('cost-indices');
  if (!s) return [];
  return Object.entries(s.systems).map(([id, vals]) => ({
    solar_system_id: Number(id),
    cost_indices: s.activities.map((activity, i) => ({ activity, cost_index: vals[i] })),
  }));
}

// ── Sovereignty ──────────────────────────────────────────────────────────────
function sovereigntySystems(now) {
  const s = snap('sovereignty');
  if (!s) return { solar_systems: [] };
  return {
    solar_systems: s.systems.map((r) => {
      if (r[1] === 'f') return { solar_system_id: r[0], claim: { faction: { faction_id: r[2] } } };
      const [id, , allianceId, corpId, capital, claimed, hub, dev] = r;
      const alliance = {
        alliance_id: allianceId, corporation_id: corpId,
        is_capital_system: !!capital,
        claimed_since: iso(now + claimed),
      };
      if (hub) {
        // A daily window: keep its time of day, put it within the next 24h.
        const start = fold(now, hub[1], DAY, -2 * HOUR);
        alliance.sovereignty_hub = { id: hub[0], vulnerability_window: { start: iso(start), end: iso(start + (hub[2] - hub[1])) } };
      }
      if (dev) alliance.development = { military_level: dev[0], industrial_level: dev[1], strategic_level: dev[2], activity_defense_multiplier: dev[3] };
      return { solar_system_id: id, claim: { alliance } };
    }),
  };
}

/** Sov timers, spread over the next two days so the Sov Timers overlay is live. */
function sovCampaigns(now) {
  return (snap('sov-campaigns') || []).map(({ startOffset, ...c }) => ({
    ...c, start_time: iso(fold(now, startOffset || 0, 2 * DAY, -HOUR)),
  }));
}

// ── Faction warfare, incursions, traffic ─────────────────────────────────────
const fwSystems      = () => snap('fw-systems') || [];
const fwStats        = () => snap('fw-stats') || [];
const fwWars         = () => snap('fw-wars') || [];
const fwLeaderboards = (kind) => snap(kind ? `fw-leaderboards-${kind}` : 'fw-leaderboards') || { kills: {}, victory_points: {} };
const incursions     = () => snap('incursions') || [];

function systemKills() {
  return (snap('system-kills') || []).map(([system_id, ship_kills, npc_kills, pod_kills]) =>
    ({ system_id, ship_kills, npc_kills, pod_kills }));
}
function systemJumps() {
  return (snap('system-jumps') || []).map(([system_id, ship_jumps]) => ({ system_id, ship_jumps }));
}

/** Tranquility status: up since today's downtime, a believable evening crowd. */
function status(now) {
  const dt = new Date(now); dt.setUTCHours(11, 2, 0, 0);
  if (dt.getTime() > now) dt.setUTCDate(dt.getUTCDate() - 1);
  return { players: 21_437, server_version: '3125844', start_time: dt.toISOString() };
}

/** EvE-Scout's Thera/Turnur signatures, ages replayed from now. */
function eveScout(now) {
  return (snap('eve-scout') || []).map((s) => {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k.endsWith('Offset')) out[k.slice(0, -6)] = v === null ? null : iso(now + v);
      else out[k] = v;
    }
    return out;
  });
}

// ── A market ─────────────────────────────────────────────────────────────────
// Region order books and price history are generated around the real price, so
// every type answers, not just the handful a fixture remembered. Seeded from
// the type id: the same book on every take.
function _rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const _JITA = { station: 60003760, system: 30000142 };

/**
 * ESI /markets/{region}/orders for one type: a ladder of sells above the price
 * and buys below it. `ours` are the cast's own orders, so the undercut check
 * sees a real rival either side of them — beaten on some types, best on others.
 */
function regionOrders(typeId, orderType = 'all', now = Date.now(), ours = []) {
  const p = priceOf(typeId);
  if (!p) return [];
  const rnd = _rng(typeId * 7919);
  const out = [];
  const tick = (v) => (v >= 100 ? Math.round(v * 100) / 100 : Math.round(v * 100) / 100);
  for (let i = 0; i < 9; i++) {
    out.push({ order_id: 7_100_000_000 + typeId * 40 + i, type_id: typeId, is_buy_order: false,
      price: tick(p.sell * (1 + i * 0.006 + rnd() * 0.004)), volume_total: 40 + Math.floor(rnd() * 400),
      volume_remain: 10 + Math.floor(rnd() * 300), min_volume: 1, duration: 90, range: 'region',
      issued: iso(now - Math.floor(rnd() * 5 * DAY)), location_id: _JITA.station, system_id: _JITA.system });
    out.push({ order_id: 7_100_000_000 + typeId * 40 + 20 + i, type_id: typeId, is_buy_order: true,
      price: tick(p.buy * (1 - i * 0.008 - rnd() * 0.004)), volume_total: 100 + Math.floor(rnd() * 900),
      volume_remain: 50 + Math.floor(rnd() * 600), min_volume: 1, duration: 90, range: i % 3 ? 'station' : 'region',
      issued: iso(now - Math.floor(rnd() * 7 * DAY)), location_id: _JITA.station, system_id: _JITA.system });
  }
  // A rival a hair under (or over, for buys) each of our orders on half the
  // types; on the rest ours stays the best price. All one way would show only
  // half of the Undercut Alerts view.
  for (const o of ours.filter(o => o.type_id === typeId)) {
    const beaten = (typeId % 2) === 0;
    if (!beaten) continue;
    out.push({ order_id: 7_200_000_000 + o.order_id, type_id: typeId, is_buy_order: o.is_buy_order,
      price: tick(o.price * (o.is_buy_order ? 1.003 : 0.997)), volume_total: 20, volume_remain: 12,
      min_volume: 1, duration: 30, range: 'station', issued: iso(now - 40 * MIN),
      location_id: o.location_id || _JITA.station, system_id: _JITA.system });
  }
  if (orderType === 'sell') return out.filter(o => !o.is_buy_order);
  if (orderType === 'buy')  return out.filter(o => o.is_buy_order);
  return out;
}

/** ESI /markets/{region}/history: a year of daily rows drifting around the price. */
function regionHistory(typeId, now = Date.now()) {
  const p = priceOf(typeId);
  if (!p) return [];
  const rnd = _rng(typeId * 104729);
  const phase = rnd() * Math.PI * 2;
  const vol = p.average > 1e8 ? 40 : p.average > 1e6 ? 900 : p.average > 1e4 ? 12_000 : 2_000_000;
  const out = [];
  for (let d = 365; d >= 1; d--) {
    const date = new Date(now - d * DAY).toISOString().slice(0, 10);
    // A slow swing plus day-to-day noise, centred on today's real price.
    const avg = p.average * (1 + 0.07 * Math.sin(d / 29 + phase) + 0.03 * (rnd() - 0.5)) * (1 + d / 3650);
    out.push({ date, average: Math.round(avg * 100) / 100,
      highest: Math.round(avg * 1.04 * 100) / 100, lowest: Math.round(avg * 0.95 * 100) / 100,
      order_count: Math.round(vol / 40 * (0.6 + rnd())), volume: Math.round(vol * (0.5 + rnd())) });
  }
  return out;
}

/** Fuzzwork aggregates for any type, from the same real prices. */
function fuzzworkAggregates(typeIds, fallback) {
  const out = {};
  const f = (n) => String(Math.round(n * 100) / 100);
  for (const raw of typeIds) {
    const id = Number(raw);
    if (!Number.isFinite(id)) continue;
    const p = priceOf(id);
    const sell = p ? p.sell : fallback(id);
    const buy  = p ? p.buy  : sell * 0.92;
    out[String(id)] = {
      buy:  { weightedAverage: f(buy),  max: f(buy),  min: f(buy * 0.85), stddev: '0', median: f(buy),
              volume: '412000', orderCount: '180', percentile: f(buy) },
      sell: { weightedAverage: f(sell), max: f(sell * 1.2), min: f(sell), stddev: '0', median: f(sell),
              volume: '388000', orderCount: '164', percentile: f(sell) },
    };
  }
  return out;
}

/** LP store offers for an NPC corporation (real offers, snapshotted). */
function lpOffers(corpId) {
  const all = snap('lp-offers') || {};
  return all[corpId] || [];
}

module.exports = {
  priceOf, marketPrices, industrySystems, sovereigntySystems, sovCampaigns,
  fwSystems, fwStats, fwWars, fwLeaderboards, incursions, systemKills, systemJumps,
  status, eveScout, regionOrders, regionHistory, fuzzworkAggregates, lpOffers,
};
