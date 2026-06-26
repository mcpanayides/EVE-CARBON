// ─── ics-parse.js — pure iCalendar (RFC 5545) parser, no DOM, no globals ────────
// Parses VEVENTs into plain objects and does minimal RRULE expansion. Exposed in
// the renderer via window.IcsParse and require()-able under Node for tests.
//
// Scope/approximations: DTSTART/DTEND with a trailing Z (UTC) and VALUE=DATE
// (all-day) are handled exactly. TZID is best-effort — if a matching VTIMEZONE
// with a fixed offset is present we apply it, otherwise the local-looking time is
// treated as UTC. RRULE expansion covers FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with
// INTERVAL/COUNT/UNTIL, expanded only within the requested window.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;     // Node / tests
  if (typeof window !== 'undefined') window.IcsParse = api;                       // renderer
  else if (typeof globalThis !== 'undefined') globalThis.IcsParse = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 86400000;

  // RFC 5545 line unfolding: a CRLF followed by a space or tab continues the
  // previous line. Normalise CRLF/CR to LF first.
  function unfold(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .replace(/\n[ \t]/g, '');
  }

  // Decode the TEXT escaping used by SUMMARY/DESCRIPTION/LOCATION.
  function decodeText(v) {
    return String(v || '')
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  // Split a content line "NAME;PARAM=x:VALUE" into { name, params, value }.
  function parseLine(line) {
    const colon = line.indexOf(':');
    if (colon === -1) return null;
    const left  = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const segs  = left.split(';');
    const name  = segs[0].toUpperCase();
    const params = {};
    for (let i = 1; i < segs.length; i++) {
      const eq = segs[i].indexOf('=');
      if (eq !== -1) params[segs[i].slice(0, eq).toUpperCase()] = segs[i].slice(eq + 1);
    }
    return { name, params, value };
  }

  // Parse an iCal date/time value into { date:Date, allDay:bool }.
  // tzOffsetMin: minutes to subtract to reach UTC for a TZID (best-effort).
  function parseDate(value, params, tzOffsets) {
    const v = String(value || '').trim();
    // All-day: VALUE=DATE or bare YYYYMMDD
    if ((params && /DATE/i.test(params.VALUE || '')) || /^\d{8}$/.test(v)) {
      const y = +v.slice(0, 4), mo = +v.slice(4, 6) - 1, d = +v.slice(6, 8);
      return { date: new Date(Date.UTC(y, mo, d)), allDay: true };
    }
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (!m) {
      const t = Date.parse(v);
      return { date: isNaN(t) ? null : new Date(t), allDay: false };
    }
    const [, Y, Mo, D, H, Mi, S, Z] = m;
    let ms = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
    if (!Z) {
      // Floating or TZID local time → shift to UTC by the zone offset if known.
      const tzid = params && params.TZID;
      const offMin = (tzid && tzOffsets && tzOffsets[tzid] != null) ? tzOffsets[tzid] : 0;
      ms -= offMin * 60000;   // offset is minutes east of UTC
    }
    return { date: new Date(ms), allDay: false };
  }

  // Pull fixed UTC offsets out of VTIMEZONE blocks: TZID → minutes east of UTC.
  // Uses the STANDARD TZOFFSETTO (ignores DST transitions — best effort).
  function parseTimezones(lines) {
    const offsets = {};
    let curTz = null, inStd = false, off = null;
    for (const raw of lines) {
      const u = raw.toUpperCase();
      if (u.startsWith('BEGIN:VTIMEZONE')) { curTz = null; off = null; }
      else if (u.startsWith('TZID:')) curTz = raw.slice(5).trim();
      else if (u.startsWith('BEGIN:STANDARD')) inStd = true;
      else if (u.startsWith('END:STANDARD')) inStd = false;
      else if (inStd && u.startsWith('TZOFFSETTO:')) {
        const s = raw.slice('TZOFFSETTO:'.length).trim();
        const mm = s.match(/^([+-])(\d{2})(\d{2})$/);
        if (mm) off = (mm[1] === '-' ? -1 : 1) * (+mm[2] * 60 + +mm[3]);
      }
      else if (u.startsWith('END:VTIMEZONE')) { if (curTz && off != null) offsets[curTz] = off; }
    }
    return offsets;
  }

  // Parse a full ICS document into an array of event objects.
  function parseIcs(text) {
    const lines = unfold(text).split('\n');
    const tzOffsets = parseTimezones(lines);

    const events = [];
    let cur = null;
    for (const line of lines) {
      const u = line.toUpperCase();
      if (u.startsWith('BEGIN:VEVENT')) { cur = {}; continue; }
      if (u.startsWith('END:VEVENT')) {
        if (cur && cur.start) {
          if (!cur.end) cur.end = cur.allDay ? new Date(cur.start.getTime() + DAY_MS) : cur.start;
          events.push(cur);
        }
        cur = null;
        continue;
      }
      if (!cur) continue;

      const p = parseLine(line);
      if (!p) continue;
      switch (p.name) {
        case 'UID':         cur.uid = p.value.trim(); break;
        case 'SUMMARY':     cur.summary = decodeText(p.value); break;
        case 'DESCRIPTION': cur.description = decodeText(p.value); break;
        case 'LOCATION':    cur.location = decodeText(p.value); break;
        case 'URL':         cur.url = p.value.trim(); break;
        case 'RRULE':       cur.rrule = p.value.trim(); break;
        case 'DTSTART': {
          const d = parseDate(p.value, p.params, tzOffsets);
          cur.start = d.date; cur.allDay = d.allDay; break;
        }
        case 'DTEND': {
          const d = parseDate(p.value, p.params, tzOffsets);
          cur.end = d.date; if (d.allDay) cur.allDay = true; break;
        }
        default: break;
      }
    }
    return events.filter(e => e.start instanceof Date && !isNaN(e.start));
  }

  // Parse RRULE "FREQ=WEEKLY;INTERVAL=2;COUNT=10;UNTIL=20260101T000000Z".
  function parseRrule(rrule) {
    const out = {};
    for (const part of String(rrule || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq !== -1) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    }
    return out;
  }

  // Expand one event into concrete occurrences overlapping [rangeStart, rangeEnd).
  // Non-recurring events are returned as-is (when in range). Window-bounded.
  function expandRecurring(ev, rangeStart, rangeEnd) {
    const durMs = (ev.end && ev.start) ? Math.max(0, ev.end - ev.start) : 0;
    const overlaps = (s) => (s.getTime() + durMs) > rangeStart.getTime() && s.getTime() < rangeEnd.getTime();

    if (!ev.rrule) {
      return overlaps(ev.start) ? [occurrence(ev, ev.start, durMs)] : [];
    }

    const r = parseRrule(ev.rrule);
    const freq = (r.FREQ || '').toUpperCase();
    const interval = Math.max(1, parseInt(r.INTERVAL) || 1);
    const count = r.COUNT ? parseInt(r.COUNT) : Infinity;
    let until = Infinity;
    if (r.UNTIL) { const d = parseDate(r.UNTIL, {}, {}); if (d.date) until = d.date.getTime(); }

    const out = [];
    let s = new Date(ev.start.getTime());
    let n = 0;
    const HARD_CAP = 1000;   // safety against runaway rules
    while (n < count && s.getTime() <= until && out.length < HARD_CAP) {
      if (s.getTime() > rangeEnd.getTime()) break;
      if (overlaps(s)) out.push(occurrence(ev, new Date(s.getTime()), durMs));
      n++;
      const next = new Date(s.getTime());
      if (freq === 'DAILY')        next.setUTCDate(next.getUTCDate() + interval);
      else if (freq === 'WEEKLY')  next.setUTCDate(next.getUTCDate() + 7 * interval);
      else if (freq === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + interval);
      else if (freq === 'YEARLY')  next.setUTCFullYear(next.getUTCFullYear() + interval);
      else break;   // unsupported FREQ — emit only the first occurrence
      s = next;
    }
    return out;
  }

  function occurrence(ev, start, durMs) {
    return {
      uid: ev.uid, summary: ev.summary, description: ev.description,
      location: ev.location, url: ev.url, allDay: !!ev.allDay,
      start, end: new Date(start.getTime() + durMs),
    };
  }

  return { unfold, decodeText, parseLine, parseDate, parseTimezones, parseIcs, parseRrule, expandRecurring };
});
