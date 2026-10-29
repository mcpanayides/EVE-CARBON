'use strict';
//
// ─── skills.js — the demo pilots' skill sheets, queues and implants ───────────
//
// Generated from the real skill catalogue (snapshots/skills.json, ranks and
// training attributes straight from the SDE) rather than hand-listed. A sheet of
// seven skills made the Skills page read as a broken sync; a believable one has
// hundreds, and only maths keeps hundreds consistent:
//
//   • every skillpoints_in_skill is exactly the SP its level costs at its rank;
//   • the queue's head is part-trained, and every finish date follows from the
//     pilot's attributes + implants at the real training rate — so the Planner
//     costing a plan and the Active Queues countdown agree with each other;
//   • the seeded database (demo_data.js) and the ESI fixtures both read from
//     here, so an offline page and a live one can never disagree.
//
// Deterministic throughout: one pilot, one sheet, on every launch.

const CATALOGUE = require('./snapshots/skills.json');   // [id, rank, group, primaryAttr, secondaryAttr]
const { CAST } = require('./cast');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** SP needed to HOLD `level` of a skill: 250 × rank × 2^(2.5(L−1)). */
const spAt = (rank, level) => (level <= 0 ? 0 : Math.round(250 * rank * Math.pow(2, 2.5 * (level - 1))));

const ATTR_KEY = { 164: 'charisma', 165: 'intelligence', 166: 'memory', 167: 'perception', 168: 'willpower' };

// Attribute block (post-remap, implants excluded — that is what ESI reports) and
// the active implants. Slots 1–5 add to training; 6–10 are hardwirings.
const PILOT = {
  main: {
    attrs: { charisma: 20, intelligence: 24, memory: 21, perception: 27, willpower: 23, bonus_remaps: 2 },
    implants: [10217, 10209, 10213, 10222, 10226, 16003, 19548, 19549, 19685, 19550],
    implantBonus: 4,
    // The level most skills in a group sit at. A combat pilot nine years in.
    groups: { 'Spaceship Command': 5, Gunnery: 5, Missiles: 4, Navigation: 5, Engineering: 5, Shields: 5,
              Armor: 4, Targeting: 5, Drones: 5, 'Electronic Systems': 4, Rigging: 4, 'Neural Enhancement': 4,
              'Fleet Support': 4, Scanning: 3, Social: 3, Trade: 3, Science: 3, Subsystems: 3,
              'Resource Processing': 2, Production: 2, 'Planet Management': 2, 'Corporation Management': 1,
              'Structure Management': 1 },
  },
  indy: {
    attrs: { charisma: 19, intelligence: 27, memory: 25, perception: 20, willpower: 24, bonus_remaps: 1 },
    implants: [10216, 10208, 10212, 10221, 10225],
    implantBonus: 3,
    groups: { Production: 5, Science: 5, 'Resource Processing': 5, 'Planet Management': 5, Trade: 4,
              'Structure Management': 3, 'Spaceship Command': 3, Navigation: 4, Engineering: 4, Shields: 3,
              Drones: 4, 'Fleet Support': 2, 'Neural Enhancement': 3, Social: 3, Scanning: 3, Sequencing: 3,
              Targeting: 3, 'Corporation Management': 2, Armor: 2, 'Electronic Systems': 2 },
  },
  scout: {
    attrs: { charisma: 17, intelligence: 21, memory: 21, perception: 27, willpower: 23, bonus_remaps: 2 },
    implants: [10216, 10212],
    implantBonus: 3,
    groups: { Navigation: 4, 'Electronic Systems': 4, Scanning: 4, 'Spaceship Command': 3, Targeting: 3,
              Engineering: 3, Shields: 3, Gunnery: 3, Drones: 2, Armor: 2, 'Neural Enhancement': 2 },
  },
};

// A stable 0..1 per (skill, pilot): which skills sit above or below their group.
function unit(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 2654435761) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function _levelFor(key, id, rank, base) {
  if (!base) return 0;
  const u = unit(id, key.length * 977);
  // Most skills at the group's level, a few a level either side, and the long
  // trains (capital and titan hulls are rank 12-16) a level or two short —
  // nobody nine years in has every titan at V.
  let lvl = base + (u < 0.15 ? -2 : u < 0.4 ? -1 : u > 0.92 ? 1 : 0);
  if (rank >= 12) lvl -= 2; else if (rank >= 8) lvl -= 1;
  return Math.max(0, Math.min(5, lvl));
}

const _sheets = {};

/**
 * One pilot's full sheet: `{ skills: [{ skill_id, trained_skill_level,
 * active_skill_level, skillpoints_in_skill }], total_sp, unallocated_sp }`,
 * shaped as ESI's /characters/{id}/skills — the queue head already counted at
 * its part-trained SP.
 */
function sheet(key) {
  if (_sheets[key]) return _sheets[key];
  const prof = PILOT[key];
  const skills = [];
  for (const [id, rank, group] of CATALOGUE) {
    const lvl = _levelFor(key, id, rank, prof.groups[group]);
    if (!lvl) continue;
    skills.push({ skill_id: id, trained_skill_level: lvl, active_skill_level: lvl, skillpoints_in_skill: spAt(rank, lvl) });
  }
  // The queue trains skills from this sheet, so their trained level must be one
  // below the level they finish at — and the head carries its partial SP.
  const q = _queuePlan(key, skills);
  for (const e of q) {
    const row = skills.find(s => s.skill_id === e.id);
    if (row) {
      row.trained_skill_level = row.active_skill_level = e.level - 1;
      row.skillpoints_in_skill = e.head ? e.trainingStartSp : spAt(e.rank, e.level - 1);
    }
  }
  const total = skills.reduce((n, s) => n + s.skillpoints_in_skill, 0);
  return (_sheets[key] = { skills, total_sp: total, unallocated_sp: key === 'main' ? 412_000 : 0, queue: q });
}

// The skills a pilot is training next: the cheapest core-group skills not yet
// at V, so a queue reads like a real one — hours and days at the front, a long
// rank-8 train at the back — rather than seven random skills.
function _queuePlan(key, skills) {
  const prof = PILOT[key];
  const byId = new Map(CATALOGUE.map(r => [r[0], r]));
  const core = Object.entries(prof.groups).filter(([, v]) => v >= 4).map(([g]) => g);
  const cands = skills
    .filter(s => s.trained_skill_level < 5 && s.trained_skill_level >= 1)
    .map(s => ({ s, row: byId.get(s.skill_id) }))
    .filter(({ row }) => core.includes(row[2]))
    .sort((a, b) => unit(a.s.skill_id, 31) - unit(b.s.skill_id, 31))
    .slice(0, key === 'scout' ? 5 : 8);

  const rate = (row) => {
    const a = prof.attrs, bonus = prof.implantBonus;
    const pri = (a[ATTR_KEY[row[3]]] || 20) + bonus, sec = (a[ATTR_KEY[row[4]]] || 20) + bonus;
    return pri + sec / 2;                                       // SP per minute
  };
  let at = 0;                                                   // minutes from now
  return cands.map(({ s, row }, i) => {
    const rank = row[1], level = s.trained_skill_level + 1;
    const startSp = spAt(rank, level - 1), endSp = spAt(rank, level);
    // The head is a third of the way through; the rest start where it ends.
    const trainingStartSp = i === 0 ? Math.round(startSp + (endSp - startSp) * 0.35) : startSp;
    const mins = (endSp - trainingStartSp) / rate(row);
    const startMin = i === 0 ? -((trainingStartSp - startSp) / rate(row)) : at;
    at = (i === 0 ? 0 : at) + mins;
    return { id: s.skill_id, rank, level, head: i === 0, startSp, endSp, trainingStartSp, startMin, finishMin: at };
  });
}

/** ESI /characters/{id}/skillqueue for a pilot, dated from `now`. */
function skillQueue(key, now) {
  return sheet(key).queue.map((e, i) => ({
    skill_id: e.id, finished_level: e.level, queue_position: i,
    level_start_sp: e.startSp, level_end_sp: e.endSp, training_start_sp: e.trainingStartSp,
    start_date: new Date(now + e.startMin * MIN).toISOString(),
    finish_date: new Date(now + e.finishMin * MIN).toISOString(),
  }));
}

/** ESI /characters/{id}/skills (the queue is internal and left out). */
function skills(key) {
  const { skills: rows, total_sp, unallocated_sp } = sheet(key);
  return { skills: rows, total_sp, unallocated_sp };
}

function attributes(key, now) {
  const a = PILOT[key].attrs;
  return { ...a, last_remap_date: new Date(now - 200 * DAY).toISOString() };
}

const implants = (key) => PILOT[key].implants.slice();

/** Which cast key an id belongs to, or null. */
function keyOf(id) {
  for (const [k, c] of Object.entries(CAST)) if (c.id === Number(id)) return k;
  return null;
}

module.exports = { spAt, sheet, skills, skillQueue, attributes, implants, keyOf, PILOT, HOUR, DAY };
