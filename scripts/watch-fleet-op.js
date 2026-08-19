'use strict';
//
// ─── watch-fleet-op.js — live view of a running fleet op ─────────────────────
//
// For FC testing (see TODO.md, "FC Testing"): run this beside the app while
// flying a fleet, and it prints the op as it builds — roster, ship swaps,
// movement, systems seen, kills, mining.
//
// Usage:  npm run watch:op          poll every 5s, print only on change
//         npm run watch:op -- --once   single snapshot
//
// OPENED READ-ONLY on purpose. The app holds one write connection in WAL mode;
// a second writer would contend with it, and the point of this is to observe
// the app's behaviour rather than perturb it.
//
// The distinction it exists to show: MOVEMENT is debounced and is the readable
// narrative, SYSTEMS SEEN is not and is what the kill pull searches. A system
// the fleet crossed in one poll appears only in the latter, and is marked.

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

// Electron's userData dir on Windows. Overridable for a copied database.
const DB = process.env.EVE_CARBON_DB
  || path.join(process.env.APPDATA || '', 'EVE Carbon', 'character_information.db');
const ONCE = process.argv.includes('--once');

// EVERY time printed here is UTC, because EVE runs on UTC and the report does
// too. The header was local once; a local header over UTC data reads as a
// two-hour gap on a SAST clock and makes a fresh op look stale.
const t = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : '—');
const dur = (ms) => {
  if (!ms || ms < 0) return '0m';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

async function snapshot(db) {
  const tables = (await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fleet_op%'")).map((r) => r.name);
  if (!tables.includes('fleet_ops')) {
    return { none: 'no fleet_ops table yet — start an op once to create it' };
  }

  const op = await db.get('SELECT * FROM fleet_ops ORDER BY started_at DESC LIMIT 1');
  if (!op) return { none: 'no ops recorded yet' };

  const [roster, movement, systems, kills, mining, baseline] = await Promise.all([
    db.all('SELECT character_id, ship_type_id, first_seen, last_seen FROM fleet_op_roster WHERE op_id=? ORDER BY first_seen', [op.op_id]),
    db.all('SELECT at, solar_system_id, members_there, members_total FROM fleet_op_movement WHERE op_id=? ORDER BY at', [op.op_id]),
    db.all('SELECT solar_system_id, first_seen, last_seen FROM fleet_op_systems WHERE op_id=? ORDER BY first_seen', [op.op_id]),
    db.all('SELECT * FROM fleet_op_kills WHERE op_id=? ORDER BY at', [op.op_id]),
    db.all('SELECT * FROM fleet_op_mining WHERE op_id=?', [op.op_id]),
    db.get('SELECT COUNT(*) c, COUNT(DISTINCT character_id) chars FROM fleet_op_mining_baseline WHERE op_id=?', [op.op_id]),
  ]);
  return { op, roster, movement, systems, kills, mining, baseline };
}

function render(s) {
  if (s.none) return s.none;
  const { op } = s;
  const L = [];
  L.push(`OP #${op.op_id} "${op.name}"  ${op.ended_at ? 'CLOSED (' + (op.end_reason || '?') + ')' : 'RUNNING'}`);
  L.push(`   boss=${op.boss_character_id} fleet=${op.fleet_id || '—'} doctrine=${op.doctrine || '—'}`);
  L.push(`   ${t(op.started_at)} → ${op.ended_at ? t(op.ended_at) : 'now'}  (${dur((op.ended_at || Date.now()) - op.started_at)})`);

  L.push(`   roster: ${new Set(s.roster.map((r) => r.character_id)).size} pilots, ${s.roster.length} pilot-hull rows`);
  for (const r of s.roster) {
    L.push(`      char ${r.character_id}  hull ${r.ship_type_id}  ${t(r.first_seen)} → ${t(r.last_seen)}`);
  }

  L.push(`   movement (debounced — the narrative): ${s.movement.length}`);
  s.movement.forEach((m, i) => {
    const next = i + 1 < s.movement.length ? s.movement[i + 1].at : (op.ended_at || Date.now());
    L.push(`      ${t(m.at)}  sys ${m.solar_system_id}  held ${dur(next - m.at)}  (${m.members_there}/${m.members_total} there)`);
  });

  const inMove = new Set(s.movement.map((m) => m.solar_system_id));
  L.push(`   systems SEEN (what the kill pull searches): ${s.systems.length}`);
  for (const sy of s.systems) {
    L.push(`      sys ${sy.solar_system_id}  ${t(sy.first_seen)} → ${t(sy.last_seen)}`
         + (inMove.has(sy.solar_system_id) ? '' : '   <-- PASS-THROUGH, correctly absent from movement'));
  }

  L.push(`   mining baseline: ${s.baseline.c} rows across ${s.baseline.chars} characters`
       + (s.baseline.c ? '' : '   <-- none taken; yield cannot be computed'));

  if (s.kills.length) {
    L.push(`   kills/losses: ${s.kills.length}`);
    for (const k of s.kills) {
      L.push(`      ${t(k.at)}  ${String(k.side).toUpperCase().padEnd(5)} sys ${k.solar_system_id}`
           + `  ship ${k.victim_ship_type_id}  ${((k.isk || 0) / 1e6).toFixed(1)}m`
           + `  ours-on-mail=${k.involved}${k.npc ? '  NPC' : ''}`);
    }
  }
  if (s.mining.length) {
    L.push(`   mining rows: ${s.mining.length}`);
    for (const m of s.mining) {
      L.push(`      char ${m.character_id} sys ${m.solar_system_id} type ${m.type_id}  ${m.quantity}`);
    }
  }
  return L.join('\n');
}

(async () => {
  let db;
  try {
    db = await open({ filename: DB, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  } catch (e) {
    console.error(`Could not open ${DB}\n  ${e.message}\n` +
                  '  Set EVE_CARBON_DB to point at character_information.db if it lives elsewhere.');
    process.exit(1);
  }

  let last = '';
  const tick = async () => {
    try {
      const out = render(await snapshot(db));
      if (out !== last) {
        console.log('\n─── ' + new Date().toTimeString().slice(0, 8) + ' ' + '─'.repeat(50));
        console.log(out);
        last = out;
      }
    } catch (e) { console.log('read error:', e.message); }
  };

  await tick();
  if (ONCE) { await db.close(); return; }
  console.log('\n(watching — Ctrl+C to stop)');
  setInterval(tick, 5000);
})();
