'use strict';
//
// Canned ESI for demo mode.
//
// The point of these is that Mail, Notifications and Calendar are LIVE-fetched:
// no fixture means those pages screenshot empty, which is the half of the app
// most worth showing. So the tests assert the routes actually match — a silent
// miss here looks like "the demo data is thin" rather than like a bug.
const test   = require('node:test');
const assert = require('node:assert');

const fx = require('../src/demo_fixtures');
// The base comes from the one client, never typed here — `npm run esi:audit`
// enforces that, and it caught this file writing the host by hand.
const { ESI_BASE } = require('../src/app_ident');

const NOW = Date.parse('2026-08-19T12:00:00Z');
const u = (p) => ESI_BASE + p + '?datasource=tranquility';

test('an unmatched route returns undefined so it falls through to the network', () => {
  // undefined, NOT null: null is a legitimate response body and would wrongly
  // short-circuit the real request.
  assert.strictEqual(fx.match(u('/characters/123/wallet')), undefined);
  assert.strictEqual(fx.match('not a url'), undefined);
});

test('the mail routes are all matched', () => {
  const headers = fx.match(u('/characters/2118400001/mail'));
  assert.ok(Array.isArray(headers) && headers.length >= 5, 'inbox has mail');
  assert.ok(headers.some((m) => m.is_read === false), 'something is unread, so the badge shows');

  const labels = fx.match(u('/characters/2118400001/mail/labels'));
  assert.ok(labels.total_unread_count > 0);
  assert.ok(labels.labels.some((l) => l.name === 'Alliance'));

  assert.deepStrictEqual(fx.match(u('/characters/2118400001/mail/lists')), []);
});

test('a mail body resolves for every header, so no mail opens blank', () => {
  const headers = fx.match(u('/characters/2118400001/mail'), { now: NOW });
  for (const h of headers) {
    const body = fx.match(u('/characters/2118400001/mail/' + h.mail_id));
    assert.ok(body && typeof body.body === 'string' && body.body.length > 40,
      'mail ' + h.mail_id + ' (' + h.subject + ') needs a real body');
    assert.strictEqual(body.subject, h.subject, 'the body carries its own subject');
  }
});

test('notifications and calendar are populated', () => {
  const notes = fx.match(u('/characters/2118400001/notifications'));
  assert.ok(notes.length >= 3);
  // The app parses the YAML `text` blob per type; an empty one renders as a
  // bare type name, which looks broken on camera.
  for (const n of notes) assert.ok(n.text && n.text.includes(':'), n.type + ' needs a text blob');

  const cal = fx.match(u('/characters/2118400001/calendar'));
  assert.ok(cal.length >= 3);
  assert.ok(cal.some((e) => e.event_response === 'accepted'));
});

test('timestamps are relative to now, so the demo never goes stale', () => {
  const a = fx.match(u('/characters/2118400001/mail'), { now: NOW })[0].timestamp;
  const b = fx.match(u('/characters/2118400001/mail'), { now: NOW + 60_000 })[0].timestamp;
  assert.notStrictEqual(a, b, 'the fixture must move with the clock, not hard-code a date');
  assert.ok(Date.parse(a) < NOW, 'mail arrived in the past');
});
