#!/usr/bin/env node
'use strict';
//
// Refresh the public-universe data demo mode serves — `npm run demo:snapshot`.
//
// Demo mode never reaches the network (see src/demo_fixtures.js), so every page
// that reads PUBLIC ESI — cost indices, faction warfare, sovereignty, incursions,
// traffic, prices — needs an answer stored locally. Hand-writing 5,485 systems'
// cost indices would read as fake, so they are taken from the real API and then
// altered:
//
//   • Cost indices are nudged ±15% per system — believable, not today's numbers.
//   • Every ALLIANCE and player CORPORATION is swapped for an invented one, so the
//     sov map, Force Projection and the timers never show a real organisation.
//     Faction (NPC) ids are kept: the empires are lore, owned by nobody.
//   • Leaderboard and scout names are replaced with CCP NPC agents, whose
//     portraits exist on the image server but who are not players.
//   • Timestamps are stored relative to the snapshot, so the fixtures can shift
//     them to "now" — a sov timer captured today is still upcoming next month.
//
// Prices and traffic are kept as they are: they are aggregate market and
// universe statistics, nobody's data, and the net-worth figures only read true
// when Tritanium costs what Tritanium costs.
//
// Usage: node scripts/demo-snapshot.js [path/to/extracted/sde/jsonl]
//   The optional JSONL folder (any eve-carbon-sde-* temp folder from an SDE
//   build) refreshes the NPC pilot pool; without it the committed pool is kept.

const fs   = require('fs');
const path = require('path');
const Esi  = require('../src/shared/esi');

const OUT = path.join(__dirname, '..', 'src', 'demo', 'snapshots');

// Deterministic 0..1 from an id and a salt: the same system gets the same nudge
// on every refresh, so two snapshots a month apart differ only where ESI does.
function unit(id, salt) {
  let h = 2166136261 ^ salt;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

async function get(p) {
  const r = await fetch(Esi.url(p), { headers: Esi.headers() });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
}

function write(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`${name.padEnd(26)} ${(fs.statSync(file).size / 1024).toFixed(0).padStart(5)} KB`);
}

// Invented ids. Real alliance ids sit around 99,000,000-99,020,000 and player
// corporations below 98,900,000; these ranges are clear of both, and the image
// server answers an unknown id with its default logo rather than an error.
const ALLIANCE_BASE = 99_990_001;
const CORP_BASE     = 98_990_001;

async function main() {
  const now = Date.now();
  const meta = { capturedAt: new Date(now).toISOString() };

  // ── Prices: CCP's bulk list, compacted to [adjusted, average] ────────────────
  const prices = {};
  for (const p of await get('/markets/prices')) {
    prices[p.type_id] = [round(p.adjusted_price || 0, 2), round(p.average_price || 0, 2)];
  }
  write('prices.json', prices);

  // ── Cost indices: real, nudged ±15% per system and activity ─────────────────
  const ACTS = ['manufacturing', 'researching_time_efficiency', 'researching_material_efficiency',
                'copying', 'invention', 'reaction'];
  const costIndices = {};
  for (const s of await get('/industry/systems')) {
    const by = Object.fromEntries((s.cost_indices || []).map(c => [c.activity, c.cost_index]));
    costIndices[s.solar_system_id] = ACTS.map((a, i) =>
      round((by[a] || 0) * (0.85 + 0.3 * unit(s.solar_system_id, 11 + i)), 5));
  }
  write('cost-indices.json', { activities: ACTS, systems: costIndices });

  // ── Sovereignty: real map, invented owners ───────────────────────────────────
  // Ranked by systems held, so the largest real alliance becomes the first
  // invented one — the map keeps its real SHAPE (who borders whom, how big)
  // without any real name on it.
  const sov = await get('/sovereignty/systems');
  const held = new Map(), corpHeld = new Map();
  for (const s of sov.solar_systems || []) {
    const a = s.claim && s.claim.alliance;
    if (!a) continue;
    held.set(a.alliance_id, (held.get(a.alliance_id) || 0) + 1);
    corpHeld.set(a.corporation_id, (corpHeld.get(a.corporation_id) || 0) + 1);
  }
  const allianceMap = new Map([...held].sort((x, y) => y[1] - x[1]).map(([id], i) => [id, ALLIANCE_BASE + i]));
  const corpMap     = new Map([...corpHeld].sort((x, y) => y[1] - x[1]).map(([id], i) => [id, CORP_BASE + i]));
  const ms = (iso) => (iso ? Date.parse(iso) - now : null);
  // Unclaimed systems are left out — the map reads a missing system as unheld.
  const sovOut = (sov.solar_systems || []).filter(s => s.claim && (s.claim.alliance || s.claim.faction)).map((s) => {
    const a = s.claim && s.claim.alliance, f = s.claim && s.claim.faction;
    if (a) {
      const hub = a.sovereignty_hub || null;
      return [s.solar_system_id, 'a', allianceMap.get(a.alliance_id), corpMap.get(a.corporation_id),
        a.is_capital_system ? 1 : 0, ms(a.claimed_since),
        hub ? [hub.id, ms(hub.vulnerability_window && hub.vulnerability_window.start),
                       ms(hub.vulnerability_window && hub.vulnerability_window.end)] : null,
        a.development ? [a.development.military_level || 0, a.development.industrial_level || 0,
                         a.development.strategic_level || 0, a.development.activity_defense_multiplier || 0] : null];
    }
    return [s.solar_system_id, 'f', f.faction_id];
  });
  write('sovereignty.json', { alliances: allianceMap.size, systems: sovOut });

  // Campaigns: the same remap, so a timer's defender is one of the invented
  // alliances that actually holds that system on the demo map.
  const campaigns = (await get('/sovereignty/campaigns')).map(c => ({
    ...c,
    defender_id: allianceMap.get(c.defender_id) || (c.defender_id ? ALLIANCE_BASE + 90 : c.defender_id),
    participants: (c.participants || []).map(p => ({ ...p, alliance_id: allianceMap.get(p.alliance_id) || ALLIANCE_BASE + 91 })),
    start_time: undefined, startOffset: ms(c.start_time),
  }));
  write('sov-campaigns.json', campaigns);

  // ── Faction warfare: real warzone, nudged victory points ────────────────────
  const fwSystems = (await get('/fw/systems')).map(s => ({
    ...s, victory_points: Math.round(s.victory_points * (0.9 + 0.2 * unit(s.solar_system_id, 31))),
  }));
  write('fw-systems.json', fwSystems);
  write('fw-stats.json', await get('/fw/stats'));
  write('fw-wars.json', await get('/fw/wars'));
  write('fw-leaderboards.json', await get('/fw/leaderboards'));

  // Leaderboards name real pilots and corporations. Their AMOUNTS are kept (so
  // the charts have the real distribution) and their ids are replaced from the
  // invented pools — characters by NPC agents, corporations by invented ids.
  const pilots = loadPilotPool();
  let p = 0, c = 0;
  const pilotFor = new Map(), corpFor = new Map();
  const remap = (board, key, pick) => {
    const out = {};
    for (const [section, groups] of Object.entries(board)) {
      out[section] = {};
      for (const [period, rows] of Object.entries(groups)) {
        out[section][period] = rows.map(r => ({ ...r, [key]: pick(r[key]) }));
      }
    }
    return out;
  };
  write('fw-leaderboards-characters.json', remap(await get('/fw/leaderboards/characters'), 'character_id',
    (id) => { if (!pilotFor.has(id)) pilotFor.set(id, pilots[p++ % pilots.length].id); return pilotFor.get(id); }));
  write('fw-leaderboards-corporations.json', remap(await get('/fw/leaderboards/corporations'), 'corporation_id',
    (id) => { if (!corpFor.has(id)) corpFor.set(id, CORP_BASE + 700 + c++); return corpFor.get(id); }));

  // ── Incursions, traffic, kills: aggregate, kept as they are ─────────────────
  write('incursions.json', await get('/incursions'));
  write('system-kills.json', (await get('/universe/system_kills')).map(k => [k.system_id, k.ship_kills, k.npc_kills, k.pod_kills]));
  write('system-jumps.json', (await get('/universe/system_jumps')).map(j => [j.system_id, j.ship_jumps]));

  // ── EvE-Scout: Thera/Turnur connections, scout names replaced ──────────────
  try {
    const r = await fetch('https://api.eve-scout.com/v2/public/signatures', { headers: { 'User-Agent': Esi.userAgent() } });
    const sigs = await r.json();
    write('eve-scout.json', sigs.map((s, i) => {
      const scout = pilots[(i * 7) % pilots.length];
      const out = {};
      for (const [k, v] of Object.entries(s)) {
        // EVERY *_by_ field, not a list of the ones seen so far: the first cut
        // named created_by and completed_by and let updated_by's real pilot through.
        if (/_time$|_at$/.test(k) && typeof v === 'string') out[k + 'Offset'] = ms(v);
        else if (/_by_id$/.test(k)) out[k] = scout.id;
        else if (/_by_name$/.test(k)) out[k] = scout.name;
        else out[k] = v;
      }
      return out;
    }));
  } catch (e) { console.warn('eve-scout skipped:', e.message); }

  // ── LP stores the cast holds points with (real offers — public, static-ish) ──
  const lp = {};
  for (const corp of [1000035, 1000080, 1000130, 1000182]) {
    lp[corp] = (await get(`/loyalty/stores/${corp}/offers`)).map(o => ({
      offer_id: o.offer_id, type_id: o.type_id, quantity: o.quantity, lp_cost: o.lp_cost,
      isk_cost: o.isk_cost, ak_cost: o.ak_cost, required_items: o.required_items || [],
    }));
  }
  write('lp-offers.json', lp);

  await snapshotSkills();
  write('meta.json', meta);
}

// ── Skill catalogue (static, from the local SDE) ───────────────────────────────
// The demo pilots' skill sheets are generated from this, so total SP, queue
// lengths and plan costs are all real maths on real ranks. Static data, but
// demo mode reads it on the IPC path where the SDE is a cost, so it is cached.
async function snapshotSkills() {
  const sqlite3 = require('sqlite3');
  const sdePath = path.join(__dirname, '..', 'data', 'sde.sql');
  if (!fs.existsSync(sdePath)) { console.warn('skills.json skipped: no data/sde.sql'); return; }
  const db = new sqlite3.Database(sdePath, sqlite3.OPEN_READONLY);
  const rows = await new Promise((res, rej) => db.all(`
    SELECT t.typeID AS id, gr.groupName AS grp,
      (SELECT COALESCE(valueFloat, valueInt) FROM dgmTypeAttributes a WHERE a.typeID = t.typeID AND a.attributeID = 275) AS rank,
      (SELECT COALESCE(valueFloat, valueInt) FROM dgmTypeAttributes a WHERE a.typeID = t.typeID AND a.attributeID = 180) AS pri,
      (SELECT COALESCE(valueFloat, valueInt) FROM dgmTypeAttributes a WHERE a.typeID = t.typeID AND a.attributeID = 181) AS sec
    FROM invTypes t JOIN invGroups gr ON gr.groupID = t.groupID
    WHERE gr.categoryID = 16 AND t.published = 1 ORDER BY t.typeID`, (e, r) => (e ? rej(e) : res(r))));
  db.close();
  write('skills.json', rows.map(r => [r.id, r.rank, r.grp, r.pri, r.sec]));
}

// ── NPC pilot pool ─────────────────────────────────────────────────────────────
// Agents from the SDE's npcCharacters: real portraits on the image server, no
// player behind them. Refreshed only when a JSONL folder is passed; otherwise the
// committed pool is reused, because a fresh checkout has no extracted SDE.
function loadPilotPool() {
  const poolFile = path.join(OUT, 'npc-pilots.json');
  const dir = process.argv[2];
  if (dir && fs.existsSync(path.join(dir, 'npcCharacters.jsonl'))) {
    const rows = fs.readFileSync(path.join(dir, 'npcCharacters.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const pool = rows
      .filter(r => !r.ceo && r._key >= 3011000 && /^[A-Za-z]+ [A-Za-z]+$/.test(r.name && r.name.en || ''))
      .filter((r, i) => i % 37 === 0)            // a spread across races and corps, not one block
      .slice(0, 160)
      .map(r => ({ id: r._key, name: r.name.en, male: !!r.gender, race: r.raceID, bloodline: r.bloodlineID }));
    write('npc-pilots.json', pool);
    return pool;
  }
  if (!fs.existsSync(poolFile)) throw new Error('No npc-pilots.json yet — pass an extracted SDE jsonl folder once.');
  return JSON.parse(fs.readFileSync(poolFile, 'utf8'));
}

main().catch((e) => { console.error(e); process.exit(1); });
