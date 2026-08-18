'use strict';
//
// ─── fleet_aar.js — the after action report ───────────────────────────────────
//
// The deliverable. Everything the tracker records exists so that this can be
// pasted into a forum thread after a fleet.
//
// ── Three formats, because the destination decides ───────────────────────────
//
// Most EVE alliance forums run BBCode; some run Markdown; some accept neither.
// A Markdown report pasted into a BBCode forum renders as literal `**` and
// `|---|` garbage, which is worse than plain text. Rather than guess the
// destination, all three are produced from ONE model — `buildReport()` — so the
// numbers can never disagree between formats. Only the decoration differs.
//
// ── The shape it takes, and why ──────────────────────────────────────────────
//
// An FC narrates a fleet as a sequence of places: where we went, what happened
// there, what it cost. So the spine of the report is the movement timeline with
// kills, losses and dwell folded into each system — not three disconnected
// tables the reader has to join by timestamp themselves.
//
// Anything the tracker could not see is stated, never omitted. A report that
// silently under-counts is worse than one admitting a gap, because nobody can
// tell the difference between a quiet fleet and a broken pull.

const fmtIsk = (n) => {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 't';
  if (abs >= 1e9)  return (n / 1e9).toFixed(2) + 'b';
  if (abs >= 1e6)  return (n / 1e6).toFixed(1) + 'm';
  if (abs >= 1e3)  return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
};

const fmtQty = (n) => Number(n || 0).toLocaleString('en-US');

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0m';
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const fmtTime = (ms) => new Date(ms).toISOString().slice(11, 16);   // HH:MM, EVE runs on UTC
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Fold everything into one model. Both formatters render this and nothing else,
 * so the three outputs cannot drift apart.
 *
 * @param {object} data
 * @param {object} data.op        the fleet_ops row
 * @param {Array}  data.roster    fleet_op_roster rows
 * @param {Array}  data.movement  fleet_op_movement rows, dwell already applied
 * @param {Array}  data.kills     fleet_op_kills rows
 * @param {object} [data.mining]  summarise() output from fleet_mining
 * @param {object} [data.names]   { systems, types, characters } id -> name maps
 * @param {Array}  [data.gaps]    strings describing what could not be collected
 */
function buildReport({ op, roster = [], movement = [], kills = [], mining = null,
                       names = {}, gaps = [] }) {
  const sysName  = (id) => (names.systems && names.systems[id]) || `System ${id}`;
  const typeName = (id) => (names.types && names.types[id]) || `Type ${id}`;
  const charName = (id) => (names.characters && names.characters[id]) || `Pilot ${id}`;

  const startedAt = op.started_at;
  const endedAt   = op.ended_at || Date.now();

  const ours   = kills.filter((k) => k.side === 'kill');
  const theirs = kills.filter((k) => k.side === 'loss');
  const iskOut = ours.reduce((n, k) => n + (k.isk || 0), 0);
  const iskIn  = theirs.reduce((n, k) => n + (k.isk || 0), 0);

  // Peak fleet size, from the movement samples. The roster is everyone who was
  // EVER in fleet, which for a three-hour op overstates how many were on grid.
  const peak = movement.reduce((n, m) => Math.max(n, m.members_total || 0), 0);

  // The spine: each system with what happened while the fleet was there.
  const timeline = movement.map((m) => {
    const from = m.at;
    const to   = m.at + (m.dwellMs || 0);
    const inWindow = (k) => k.at >= from && k.at <= to;
    const k = ours.filter(inWindow);
    const l = theirs.filter(inWindow);
    return {
      systemId: m.solar_system_id,
      system:   sysName(m.solar_system_id),
      at: from, dwellMs: m.dwellMs || 0,
      members: m.members_total || 0,
      kills: k.length, losses: l.length,
      iskDestroyed: k.reduce((n, x) => n + (x.isk || 0), 0),
      iskLost:      l.reduce((n, x) => n + (x.isk || 0), 0),
      // Named so a reader can see WHAT died, not just how much it cost.
      killedShips: k.map((x) => typeName(x.victim_ship_type_id)),
      lostShips:   l.map((x) => typeName(x.victim_ship_type_id)),
    };
  });

  // Kills that fall outside every recorded dwell window — the fleet was in
  // transit, or the poll had a gap. Reported separately rather than dropped, so
  // the per-system numbers and the totals always reconcile.
  const placed = new Set(timeline.flatMap((t) =>
    kills.filter((k) => k.at >= t.at && k.at <= t.at + t.dwellMs).map((k) => k.killmail_id)));
  const unplaced = kills.filter((k) => !placed.has(k.killmail_id));

  // Hulls fielded, by how many flew them.
  const hulls = new Map();
  for (const r of roster) hulls.set(r.ship_type_id, (hulls.get(r.ship_type_id) || 0) + 1);

  return {
    name: op.name,
    doctrine: op.doctrine || null,
    date: fmtDate(startedAt),
    startedAt, endedAt,
    durationMs: endedAt - startedAt,
    pilots: new Set(roster.map((r) => r.character_id)).size,
    peak,
    hulls: [...hulls].map(([type_id, count]) => ({ type_id, name: typeName(type_id), count }))
      .sort((a, b) => b.count - a.count),
    kills: ours.length, losses: theirs.length,
    iskDestroyed: iskOut, iskLost: iskIn,
    efficiency: (iskOut + iskIn) > 0 ? iskOut / (iskOut + iskIn) : null,
    timeline, unplaced: unplaced.length,
    biggestKill: ours.slice().sort((a, b) => (b.isk || 0) - (a.isk || 0))[0] || null,
    mining: mining ? {
      ...mining,
      byType: (mining.byType || []).map((t) => ({ ...t, name: typeName(t.type_id) })),
      bySystem: (mining.bySystem || []).map((s) => ({ ...s, name: sysName(s.solar_system_id) })),
    } : null,
    gaps,
    endReason: op.end_reason || null,
    notes: op.notes || null,
    _typeName: typeName, _charName: charName,
  };
}

// ── Renderers ────────────────────────────────────────────────────────────────
// Each takes the model above. Adding a fact means adding it to buildReport and
// then to each renderer — deliberately, so a number cannot exist in one format
// and be missing from another.

function toMarkdown(r) {
  const L = [];
  L.push(`# ${r.name}`);
  L.push('');
  L.push(`**${r.date}** · ${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)} EVE · ${fmtDuration(r.durationMs)}`
       + (r.doctrine ? ` · ${r.doctrine} doctrine` : ''));
  L.push('');
  L.push(`| | |`);
  L.push(`|---|---|`);
  // "45 seen · peak 41 on grid", never "45 (peak 41 on grid)" — the parenthetical
  // form reads as a contradiction when the two numbers differ, which is always.
  L.push(`| Pilots | ${r.pilots} seen${r.peak ? ` · peak ${r.peak} on grid` : ''} |`);
  L.push(`| Kills | **${r.kills}** — ${fmtIsk(r.iskDestroyed)} ISK |`);
  L.push(`| Losses | **${r.losses}** — ${fmtIsk(r.iskLost)} ISK |`);
  if (r.efficiency !== null) L.push(`| Efficiency | ${(r.efficiency * 100).toFixed(1)}% |`);
  if (r.mining) L.push(`| Mined | ${fmtQty(r.mining.units)} units${r.mining.isk !== null ? ` — ${fmtIsk(r.mining.isk)} ISK` : ''} |`);
  L.push('');

  if (r.timeline.length) {
    L.push('## Where we went');
    L.push('');
    for (const t of r.timeline) {
      L.push(`**${t.system}** · ${fmtTime(t.at)} · held ${fmtDuration(t.dwellMs)}`);
      if (t.kills || t.losses) {
        if (t.kills)  L.push(`- Killed ${t.kills} (${fmtIsk(t.iskDestroyed)} ISK)${t.killedShips.length ? ` — ${summariseShips(t.killedShips)}` : ''}`);
        if (t.losses) L.push(`- Lost ${t.losses} (${fmtIsk(t.iskLost)} ISK)${t.lostShips.length ? ` — ${summariseShips(t.lostShips)}` : ''}`);
      } else {
        L.push('- No engagements');
      }
      L.push('');
    }
  }

  if (r.hulls.length) {
    L.push('## What we fielded');
    L.push('');
    for (const h of r.hulls.slice(0, 15)) L.push(`- ${h.count}× ${h.name}`);
    L.push('');
  }

  if (r.mining && r.mining.byType.length) {
    L.push('## Mined');
    L.push('');
    L.push('| Ore | Units |');
    L.push('|---|---|');
    for (const t of r.mining.byType.slice(0, 20)) L.push(`| ${t.name} | ${fmtQty(t.quantity)} |`);
    L.push('');
    L.push(`_${miningCaveat(r.mining)}_`);
    L.push('');
  }

  if (r.notes) { L.push('## Notes'); L.push(''); L.push(r.notes); L.push(''); }

  const caveats = allCaveats(r);
  if (caveats.length) {
    L.push('---');
    for (const c of caveats) L.push(`_${c}_`);
    L.push('');
  }
  L.push(`_Recorded with EVE Carbon._`);
  return L.join('\n');
}

function toBBCode(r) {
  const L = [];
  L.push(`[size=150][b]${r.name}[/b][/size]`);
  L.push(`[i]${r.date} · ${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)} EVE · ${fmtDuration(r.durationMs)}`
       + (r.doctrine ? ` · ${r.doctrine} doctrine` : '') + '[/i]');
  L.push('');
  L.push('[list]');
  L.push(`[*]Pilots: ${r.pilots} seen${r.peak ? ` · peak ${r.peak} on grid` : ''}`);
  L.push(`[*]Kills: [b]${r.kills}[/b] — ${fmtIsk(r.iskDestroyed)} ISK`);
  L.push(`[*]Losses: [b]${r.losses}[/b] — ${fmtIsk(r.iskLost)} ISK`);
  if (r.efficiency !== null) L.push(`[*]Efficiency: ${(r.efficiency * 100).toFixed(1)}%`);
  if (r.mining) L.push(`[*]Mined: ${fmtQty(r.mining.units)} units${r.mining.isk !== null ? ` — ${fmtIsk(r.mining.isk)} ISK` : ''}`);
  L.push('[/list]');
  L.push('');

  if (r.timeline.length) {
    L.push('[b]Where we went[/b]');
    L.push('[list]');
    for (const t of r.timeline) {
      const bits = [];
      if (t.kills)  bits.push(`killed ${t.kills} (${fmtIsk(t.iskDestroyed)})`);
      if (t.losses) bits.push(`lost ${t.losses} (${fmtIsk(t.iskLost)})`);
      L.push(`[*][b]${t.system}[/b] · ${fmtTime(t.at)} · held ${fmtDuration(t.dwellMs)}`
           + (bits.length ? ` — ${bits.join(', ')}` : ' — no engagements'));
    }
    L.push('[/list]');
    L.push('');
  }

  if (r.hulls.length) {
    L.push('[b]What we fielded[/b]');
    L.push('[list]');
    for (const h of r.hulls.slice(0, 15)) L.push(`[*]${h.count}× ${h.name}`);
    L.push('[/list]');
    L.push('');
  }

  if (r.mining && r.mining.byType.length) {
    L.push('[b]Mined[/b]');
    L.push('[list]');
    for (const t of r.mining.byType.slice(0, 20)) L.push(`[*]${t.name}: ${fmtQty(t.quantity)}`);
    L.push('[/list]');
    L.push(`[i]${miningCaveat(r.mining)}[/i]`);
    L.push('');
  }

  if (r.notes) { L.push('[b]Notes[/b]'); L.push(r.notes); L.push(''); }

  for (const c of allCaveats(r)) L.push(`[i]${c}[/i]`);
  L.push('[i]Recorded with EVE Carbon.[/i]');
  return L.join('\n');
}

function toText(r) {
  const L = [];
  const rule = '='.repeat(Math.max(20, r.name.length));
  L.push(r.name); L.push(rule);
  L.push(`${r.date}  ${fmtTime(r.startedAt)}-${fmtTime(r.endedAt)} EVE  (${fmtDuration(r.durationMs)})`
       + (r.doctrine ? `  ${r.doctrine} doctrine` : ''));
  L.push('');
  L.push(`Pilots  : ${r.pilots} seen${r.peak ? `  peak ${r.peak} on grid` : ''}`);
  L.push(`Kills   : ${r.kills}  (${fmtIsk(r.iskDestroyed)} ISK)`);
  L.push(`Losses  : ${r.losses}  (${fmtIsk(r.iskLost)} ISK)`);
  if (r.efficiency !== null) L.push(`Eff.    : ${(r.efficiency * 100).toFixed(1)}%`);
  if (r.mining) L.push(`Mined   : ${fmtQty(r.mining.units)} units${r.mining.isk !== null ? `  (${fmtIsk(r.mining.isk)} ISK)` : ''}`);
  L.push('');

  if (r.timeline.length) {
    L.push('WHERE WE WENT');
    L.push('-------------');
    for (const t of r.timeline) {
      L.push(`${t.system}  ${fmtTime(t.at)}  held ${fmtDuration(t.dwellMs)}`);
      if (t.kills)  L.push(`    killed ${t.kills}  ${fmtIsk(t.iskDestroyed)} ISK${t.killedShips.length ? `  (${summariseShips(t.killedShips)})` : ''}`);
      if (t.losses) L.push(`    lost   ${t.losses}  ${fmtIsk(t.iskLost)} ISK${t.lostShips.length ? `  (${summariseShips(t.lostShips)})` : ''}`);
      if (!t.kills && !t.losses) L.push('    no engagements');
    }
    L.push('');
  }

  if (r.hulls.length) {
    L.push('WHAT WE FIELDED');
    L.push('---------------');
    for (const h of r.hulls.slice(0, 15)) L.push(`  ${String(h.count).padStart(3)}x ${h.name}`);
    L.push('');
  }

  if (r.mining && r.mining.byType.length) {
    L.push('MINED');
    L.push('-----');
    for (const t of r.mining.byType.slice(0, 20)) L.push(`  ${fmtQty(t.quantity).padStart(12)}  ${t.name}`);
    L.push(`  ${miningCaveat(r.mining)}`);
    L.push('');
  }

  if (r.notes) { L.push('NOTES'); L.push('-----'); L.push(r.notes); L.push(''); }

  const caveats = allCaveats(r);
  if (caveats.length) { for (const c of caveats) L.push(`* ${c}`); L.push(''); }
  L.push('Recorded with EVE Carbon.');
  return L.join('\n');
}

// "3× Sabre, 2× Malediction" — counted rather than listed, because a 40-kill
// system would otherwise print forty lines of the same hull.
function summariseShips(list) {
  const counts = new Map();
  for (const n of list) counts.set(n, (counts.get(n) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([n, c]) => (c > 1 ? `${c}× ${n}` : n)).join(', ');
}

// The mining number is the one most likely to be misread, so it never appears
// without saying whose it is.
function miningCaveat(m) {
  const { pilotsInFleet, pilotsMeasured } = m.coverage || {};
  const base = pilotsInFleet
    ? `Mining covers ${pilotsMeasured} of ${pilotsInFleet} pilots — ESI only reports mining for characters signed into this app.`
    : 'Mining covers only characters signed into this app — ESI reports no one else\'s.';
  return m.fullyPriced === false ? `${base} Some ore could not be priced, so the ISK figure is a floor.` : base;
}

function allCaveats(r) {
  const out = [...(r.gaps || [])];
  if (r.unplaced) {
    out.push(`${r.unplaced} killmail${r.unplaced === 1 ? '' : 's'} fell outside the recorded system windows and ` +
             `${r.unplaced === 1 ? 'is' : 'are'} counted in the totals but not against a system.`);
  }
  if (r.endReason && r.endReason !== 'stopped') {
    out.push(`This op ended early (${r.endReason}), so the record may be incomplete.`);
  }
  return out;
}

/** All three at once — the renderer offers whichever the destination takes. */
function render(data) {
  const model = buildReport(data);
  return { model, markdown: toMarkdown(model), bbcode: toBBCode(model), text: toText(model) };
}

module.exports = { buildReport, toMarkdown, toBBCode, toText, render,
                   fmtIsk, fmtDuration, summariseShips };
