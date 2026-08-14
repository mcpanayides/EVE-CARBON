'use strict';
//
// Room discovery (XEP-0030 disco#items) — conference-host derivation and result
// parsing.
//
// DELIBERATELY OFFLINE. Nothing here opens a socket or names a real server: the
// stanza objects are fakes shaped like @xmpp/xml elements. Testing this against a
// live conference service would mean hammering someone's production MUC with
// enumeration requests, which is a good way to get an account banned. For a
// manual smoke test use a public test service (conference.jabber.org), never a
// corp/alliance server.
const test   = require('node:test');
const assert = require('node:assert');

const { conferenceHostFor, parseDiscoItems } = require('../src/jabber_ipc');

// Minimal stand-in for an @xmpp/xml element: only getChildren + attrs are used.
const fakeQuery = (items) => ({
  getChildren: (name) => (name === 'item' ? items.map(attrs => ({ attrs })) : []),
});

test('conference host is derived from the account domain', () => {
  assert.strictEqual(conferenceHostFor('goonfleet.com'), 'conference.goonfleet.com');
  assert.strictEqual(conferenceHostFor('fraternity.com'), 'conference.fraternity.com');
  assert.strictEqual(conferenceHostFor('EXAMPLE.COM'), 'conference.example.com');
  assert.strictEqual(conferenceHostFor('  spaced.com  '), 'conference.spaced.com');
});

test('a domain that is already a service host is left alone', () => {
  // Otherwise a user pasting the full conference host gets
  // conference.conference.example.com and an empty list they cannot explain.
  assert.strictEqual(conferenceHostFor('conference.goonfleet.com'), 'conference.goonfleet.com');
  assert.strictEqual(conferenceHostFor('muc.example.com'), 'muc.example.com');
  assert.strictEqual(conferenceHostFor('chat.example.com'), 'chat.example.com');
  assert.strictEqual(conferenceHostFor('rooms.example.com'), 'rooms.example.com');
});

test('no domain yields no suggestion rather than a broken host', () => {
  assert.strictEqual(conferenceHostFor(''), '');
  assert.strictEqual(conferenceHostFor(null), '');
  assert.strictEqual(conferenceHostFor(undefined), '');
});

test('disco items become name/description rows, sorted by name', () => {
  const rooms = parseDiscoItems(fakeQuery([
    { jid: 'recon_coord@conference.example.com', name: 'recon_coord' },
    { jid: 'gshi@conference.example.com',        name: 'GSHI' },
    { jid: 'liberty@conference.example.com',     name: 'liberty Squad' },
  ]));

  assert.deepStrictEqual(rooms.map(r => r.name), ['gshi', 'liberty', 'recon_coord']);
  // Name is the JID's local part — what you would otherwise have had to type.
  // Description is whatever the service calls it, which is often but not always
  // the same string.
  assert.deepStrictEqual(rooms.find(r => r.name === 'gshi'), {
    jid: 'gshi@conference.example.com', name: 'gshi', description: 'GSHI',
  });
  assert.strictEqual(rooms.find(r => r.name === 'liberty').description, 'liberty Squad');
});

test('unjoinable and malformed items are dropped', () => {
  const rooms = parseDiscoItems(fakeQuery([
    { jid: 'good@conference.example.com', name: 'Good' },
    { name: 'No JID at all' },                       // nothing to join
    { jid: '', name: 'Empty JID' },
    { jid: 'conference.example.com', name: 'The service itself' },  // not a room
  ]));
  assert.deepStrictEqual(rooms.map(r => r.jid), ['good@conference.example.com']);
});

test('a room with no description still lists', () => {
  const rooms = parseDiscoItems(fakeQuery([{ jid: 'plain@conference.example.com' }]));
  assert.strictEqual(rooms.length, 1);
  assert.strictEqual(rooms[0].name, 'plain');
  assert.strictEqual(rooms[0].description, '');
});

test('an empty or absent query yields an empty list, not a throw', () => {
  assert.deepStrictEqual(parseDiscoItems(fakeQuery([])), []);
  assert.deepStrictEqual(parseDiscoItems(null), []);
  assert.deepStrictEqual(parseDiscoItems(undefined), []);
  assert.deepStrictEqual(parseDiscoItems({}), []);
});

// ─── Archived history (XEP-0313 MAM) ─────────────────────────────────────────
// Same rule as above: no sockets, no real servers. The stanzas here are fakes
// shaped like @xmpp/xml elements.
const { parseMamResult, delayStamp } = require('../src/jabber_ipc');

// Minimal element stand-in supporting getChild/getChildText/attrs.
function el(name, attrs = {}, children = [], text = null) {
  return {
    name, attrs, children, text,
    getChild(n, xmlns) {
      return children.find(c => c.name === n && (!xmlns || c.attrs?.xmlns === xmlns))
          || children.find(c => c.name === n) || null;
    },
    // Real @xmpp/xml elements have this; leaving it out made every feature list
    // look empty, so a namespace test passed by returning null for everything.
    getChildren(n) { return children.filter(c => c.name === n); },
    getChildText(n) { return children.find(c => c.name === n)?.text ?? null; },
  };
}

const mamStanza = ({ id = 'a1', from = 'corp@conference.example.com/pilotone',
                     body = 'hello', stamp = '2026-08-01T12:00:00Z', queryid = 'q1' } = {}) =>
  el('message', {}, [
    el('result', { id, queryid, xmlns: 'urn:xmpp:mam:2' }, [
      el('forwarded', { xmlns: 'urn:xmpp:forward:0' }, [
        el('delay', { xmlns: 'urn:xmpp:delay', stamp }),
        el('message', { from }, [el('body', {}, [], body)]),
      ]),
    ]),
  ]);

test('an archived message keeps its own room, sender, id and sent time', () => {
  const m = parseMamResult(mamStanza(), 'q1');
  assert.deepStrictEqual(m, {
    stanzaId: 'a1',
    roomJid: 'corp@conference.example.com',
    senderNick: 'pilotone',
    body: 'hello',
    receivedAt: '2026-08-01T12:00:00.000Z',
  });
});

test('archived messages from another query are ignored', () => {
  // Two history pulls can overlap; taking the wrong page would interleave them.
  assert.strictEqual(parseMamResult(mamStanza({ queryid: 'other' }), 'q1'), null);
  // No queryid on the result: accepted, since some servers omit it.
  assert.ok(parseMamResult(mamStanza({ queryid: undefined }), 'q1'));
});

test('archive entries with nothing to show are skipped', () => {
  // Subject changes and chat-state notifications have no body.
  const noBody = el('message', {}, [
    el('result', { id: 'a2', queryid: 'q1' }, [
      el('forwarded', {}, [el('message', { from: 'corp@conference.example.com/x' }, [])]),
    ]),
  ]);
  assert.strictEqual(parseMamResult(noBody, 'q1'), null);
  assert.strictEqual(parseMamResult(el('message', {}, []), 'q1'), null);
  assert.strictEqual(parseMamResult(null, 'q1'), null);
});

test('a delay stamp is what dates a replayed message, not the moment it arrived', () => {
  assert.strictEqual(delayStamp(el('m', {}, [el('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-07-04T09:30:00Z' })])),
    '2026-07-04T09:30:00.000Z');
  // Live messages carry no delay — they are happening now, and the caller
  // falls back to the current time.
  assert.strictEqual(delayStamp(el('m', {}, [])), null);
  assert.strictEqual(delayStamp(el('m', {}, [el('delay', { stamp: 'not a date' })])), null);
  assert.strictEqual(delayStamp(null), null);
});

// ─── Occupants and MAM capability ────────────────────────────────────────────
const { parseOccupantPresence, occupantSort, mamNamespaceFrom } = require('../src/jabber_ipc');

const presence = (from, { role, affiliation, type } = {}) =>
  el('presence', { from, type }, [
    el('x', { xmlns: 'http://jabber.org/protocol/muc#user' }, [
      el('item', { role, affiliation }),
    ]),
  ]);

test('occupant presence yields nick, room and both MUC ranks', () => {
  assert.deepStrictEqual(
    parseOccupantPresence(presence('corp@conference.example.com/BeeBot',
      { role: 'moderator', affiliation: 'owner' })),
    { roomJid: 'corp@conference.example.com', nick: 'BeeBot',
      role: 'moderator', affiliation: 'owner', leaving: false });
});

test('a presence with no muc payload is a plain participant, not a failure', () => {
  const bare = el('presence', { from: 'corp@conference.example.com/someone' }, []);
  const p = parseOccupantPresence(bare);
  assert.strictEqual(p.role, 'participant');
  assert.strictEqual(p.affiliation, 'none');
});

test('leaving is what removes someone from the roster', () => {
  const gone = parseOccupantPresence(
    presence('corp@conference.example.com/leaver', { type: 'unavailable' }));
  assert.strictEqual(gone.leaving, true);
  // Room presence with no resource is the room itself, not an occupant.
  assert.strictEqual(parseOccupantPresence(el('presence', { from: 'corp@conference.example.com' }, [])), null);
});

test('the roster ranks by standing, then moderators, then name', () => {
  const people = [
    { nick: 'zulu',    role: 'participant', affiliation: 'none' },
    { nick: 'alpha',   role: 'participant', affiliation: 'none' },
    { nick: 'themod',  role: 'moderator',   affiliation: 'none' },
    { nick: 'amember', role: 'participant', affiliation: 'member' },
    { nick: 'theboss', role: 'moderator',   affiliation: 'owner' },
    { nick: 'anadmin', role: 'moderator',   affiliation: 'admin' },
  ];
  assert.deepStrictEqual(people.sort(occupantSort).map(p => p.nick),
    ['theboss', 'anadmin', 'amember', 'themod', 'alpha', 'zulu']);
});

test('MAM support is read from what the room advertises, newest version first', () => {
  const info = (...vars) => el('query', {}, vars.map(v => el('feature', { var: v })));
  assert.strictEqual(mamNamespaceFrom(info('urn:xmpp:mam:2')), 'urn:xmpp:mam:2');
  assert.strictEqual(mamNamespaceFrom(info('urn:xmpp:mam:0', 'urn:xmpp:mam:1')), 'urn:xmpp:mam:1');
  assert.strictEqual(mamNamespaceFrom(info('urn:xmpp:mam:0')), 'urn:xmpp:mam:0');
});

test('a room advertising no MAM is detected before a query is sent', () => {
  // This is the case that produced "IQ request cannot be processed by the MUC
  // room itself" — asking a room that never claimed to support archives.
  const info = el('query', {}, [
    el('feature', { var: 'http://jabber.org/protocol/muc' }),
    el('feature', { var: 'muc_persistent' }),
  ]);
  assert.strictEqual(mamNamespaceFrom(info), null);
  assert.strictEqual(mamNamespaceFrom(null), null);
});
