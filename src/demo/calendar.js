'use strict';
//
// ─── calendar.js — the demo's iCal feeds ──────────────────────────────────────
//
// The Calendar page shows the forum's calendar and any iCal feeds, plus PI and
// industry timers — not ESI's character calendar. With no feed, every event the
// demo had piled onto the two or three days its PI and jobs finish, and the rest
// of the month sat empty.
//
// These two feeds fill it the way an active alliance's calendar is full: a
// rhythm of weekly ops (each one VEVENT with an RRULE, which the app's own
// parser expands), a few fortnightly and monthly fixtures, and one-off timers
// and events scattered around them — about one a day, never a wall of them.
// Recurring series start four months back with no end, so whichever month the
// calendar is turned to has events in it.
//
// Served by main.js in demo mode for exactly these URLs; never fetched.

const { DOMAIN } = require('./cast');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const FORUM_FEED = `https://forum.${DOMAIN}/calendar/1-alliance-operations/?do=download`;
const CORP_FEED  = `https://calendar.${DOMAIN}/corp-ops.ics`;

// Recurring: [weekday (0=Sun), hour UTC, minute, hours long, every N weeks or 'month', summary, location, description]
const FORUM_SERIES = [
  [0, 19, 0, 2,  1, 'Alliance strat op — Muninn fleet',   '1DQ1-A', 'Doctrine Muninn with Scimitar support. Form up 18:45 on the titan.'],
  [2, 19, 0, 1.5, 1, 'Newbro fleet — free Retributions',  '1DQ1-A', 'No experience needed. Free hulls in alliance contracts.'],
  [5, 18, 0, 3,  1, 'Home guard & beacon night',          '319-3D', 'Cover fleet up from 18:00. Beacons only once the FC calls it.'],
  [6, 20, 0, 2,  2, 'Capital training op',                '1DQ1-A', 'Dreads and FAX. Check your jump fatigue before the move.'],
  [6, 18, 0, 1.5, 'month', 'Alliance town hall',          'Comms — Town Hall', 'Leadership update, doctrine changes, Q&A.'],
];
const CORP_SERIES = [
  [3, 18, 30, 2, 1, 'Corp mining fleet — Arkonor',        'T5ZI-S',  'Orca boosts on grid. Compressed ore to the buyback, 92% Jita.'],
  [1, 20, 0, 1,  2, 'Moon fracture — T5ZI-S VII - Moon 3', 'T5ZI-S', 'R32 chunk. Bring Hulks; Rorqual cover from home guard.'],
  [4, 17, 0, 1,  'month', 'Corp meeting — month end',     'Comms — Corp', 'Payouts, the industry plan and next month\'s targets.'],
];

// One-offs: [days from today, hour UTC, minute, hours long, summary, location, description]
const FORUM_ONEOFF = [
  [-38, 21, 0, 2, 'CTA — structure defence',               '1DQ1-A',  'All doctrines welcome. 260 pilots undocked; 0 structures lost.'],
  [-30, 19, 30, 2, 'Sov timer — 23G-XC',                   '23G-XC',  'Hub armour timer. Ferox fleet.'],
  [-23, 20, 0, 3, 'Deployment — staging move to 319-3D',   '1DQ1-A',  'Bring everything you can fly.'],
  [-16, 18, 0, 2, 'Alliance Tournament practice',          'Thunderdome', 'Practice brawls. Spectators welcome on stream.'],
  [-9,  21, 30, 2, 'Sov timer — 5BTK-M',                   '5BTK-M',  'Hub vulnerability window. Harpy fleet.'],
  [-4,  20, 0, 2, 'Bomber roam',                           '1DQ1-A',  'Sign up in the bombers room.'],
  [-1,  19, 0, 2, 'Roam — Catch border',                   'HED-GP',  'Hunters and dictors.'],
  [1,   21, 0, 2, 'Structure timer — 319-3D Astrahus',     '319-3D',  'Armour timer. Ferox fleet, form up 20:30.'],
  [3,   20, 0, 3, 'CTA — sov defence',                     'YZ9-F6',  'Everyone in fleet. Every doctrine welcome.'],
  [8,   19, 30, 2, 'Sov timer — I-E3TG',                   'I-E3TG',  'Hub armour. Muninn fleet.'],
  [12,  18, 0, 2, 'Alliance Tournament practice',          'Thunderdome', 'Final practice before submissions.'],
  [17,  21, 0, 3, 'Deployment — Fountain border',          '1DQ1-A',  'Long deployment. Pack a cyno alt.'],
  [24,  20, 0, 2, 'Sov timer — S-6HHN',                    'S-6HHN',  'Hub structure timer.'],
  [31,  19, 0, 2, 'Fleet commander workshop',              'Comms — Town Hall', 'For new FCs: anchoring, broadcasts, calling primaries.'],
  [39,  21, 0, 2, 'CTA — Keepstar timer',                  '1DQ1-A',  'Maximum effort. Titans on standby.'],
  [46,  19, 30, 2, 'Sov timer — M2-XFE',                   'M2-XFE',  'Hub armour timer.'],
];
const CORP_ONEOFF = [
  [-27, 19, 0, 1, 'Skill plan review',                     'Comms — Corp', 'Bring your Planner export.'],
  [-12, 20, 0, 1.5, 'Doctrine refit night',                '1DQ1-A',  'Refit to the new Muninn fit before Sunday.'],
  [-5,  18, 0, 1, 'Industry planning',                     'Comms — Corp', 'Which hulls to build this month, by margin.'],
  [5,   19, 0, 1, 'Newbro mentoring',                      'Rens',    'One-to-one help with skills and fits.'],
  [10,  18, 30, 2, 'Moon fracture — 319-3D IV - Moon 1',   '319-3D',  'R64 chunk — the good stuff.'],
  [20,  20, 0, 1, 'Skill plan review',                     'Comms — Corp', 'Quarterly. Bring your plans.'],
  [33,  19, 0, 2, 'Corp roam — low-sec skirmish',          'Amamake', 'Frigates and destroyers.'],
  [52,  18, 0, 1.5, 'Industry planning',                   'Comms — Corp', 'Next quarter\'s build list.'],
];

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`; };
const text = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

function _midnightUtc(now) { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }

function _vevent(uid, start, hours, summary, location, description, url, rrule, now) {
  return ['BEGIN:VEVENT', `UID:${uid}@${DOMAIN}`, `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + hours * HOUR)}`,
    ...(rrule ? [`RRULE:${rrule}`] : []),
    `SUMMARY:${text(summary)}`, `LOCATION:${text(location)}`, `DESCRIPTION:${text(description)}`,
    `URL:${url}`, 'END:VEVENT'];
}

function _calendar(name, series, oneoffs, now, slug) {
  const today = _midnightUtc(now);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//Vaelin Collective//${name}//EN`, `X-WR-CALNAME:${name}`];
  series.forEach(([weekday, h, m, hours, every, summary, location, description], i) => {
    // Anchor four months back, on the right weekday — the parser expands an
    // RRULE from DTSTART's own weekday (it has no BYDAY).
    let start = today - 120 * DAY;
    while (new Date(start).getUTCDay() !== weekday) start += DAY;
    start += h * HOUR + m * MIN;
    const rrule = every === 'month' ? 'FREQ=MONTHLY' : `FREQ=WEEKLY;INTERVAL=${every}`;
    lines.push(..._vevent(`${slug}-series-${i}`, start, hours, summary, location, description,
      `https://forum.${DOMAIN}/calendar/event/${700 + i}/`, rrule, now));
  });
  oneoffs.forEach(([days, h, m, hours, summary, location, description], i) => {
    const start = today + days * DAY + h * HOUR + m * MIN;
    lines.push(..._vevent(`${slug}-event-${i}`, start, hours, summary, location, description,
      `https://forum.${DOMAIN}/calendar/event/${900 + i}/`, null, now));
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/** The ICS text for one of the demo feed URLs, or null if it is not one. */
function feed(url, now = Date.now()) {
  const u = String(url || '').split('#')[0];
  if (u === FORUM_FEED) return _calendar('Vaelin Collective — Alliance Operations', FORUM_SERIES, FORUM_ONEOFF, now, 'forum');
  if (u === CORP_FEED)  return _calendar('Vaelin Industries — Corp Calendar', CORP_SERIES, CORP_ONEOFF, now, 'corp');
  return null;
}

module.exports = { FORUM_FEED, CORP_FEED, feed };
