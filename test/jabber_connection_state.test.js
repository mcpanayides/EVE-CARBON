'use strict';
//
// What the Jabber light says, given what an @xmpp/client actually emits.
//
// The light used to follow 'online', 'offline' and 'error' only. @xmpp/client 0.14
// resumes a dropped session through stream management WITHOUT an 'online' event,
// so a socket error before the drop left the light red for as long as the
// resumed session lasted, with pings still arriving through it. These tests
// drive watchConnection with fake clients shaped like the real one: an
// EventEmitter with a `status`, a `jid`, and a `streamManagement` emitter.
//
// DELIBERATELY OFFLINE, like the other Jabber tests: nothing here opens a socket.
const test   = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { watchConnection } = require('../src/jabber_ipc');

function fakeClient() {
  const client = new EventEmitter();
  client.status = 'offline';
  client.jid = 'pilot@example.com/carbon';
  client.streamManagement = new EventEmitter();
  return client;
}

function watched(opts = {}) {
  const client = fakeClient();
  const states = [];
  watchConnection(client, { onState: (s) => states.push(s), ...opts });
  return { client, states, last: () => states[states.length - 1] };
}

test('a fresh session reports online', () => {
  const { client, last } = watched();
  client.status = 'online';
  client.emit('online', 'pilot@example.com/carbon');
  assert.strictEqual(last().status, 'online');
  assert.match(last().message, /Connected as pilot@example\.com/);
});

test('a dropped socket that is resumed ends online, not stuck on the error', () => {
  // The reported bug, in the order the library emits it: the socket errors while
  // the session is still up, closes ('disconnect'), the reconnect module reopens
  // it, and stream management resumes the session — 'resumed' on
  // client.streamManagement, then status set to online with no 'online' event.
  const { client, states, last } = watched();
  client.status = 'online';
  client.emit('online', 'pilot@example.com/carbon');

  client.emit('error', new Error('read ECONNRESET'));
  client.status = 'disconnect';
  client.emit('disconnect', { clean: false });
  assert.strictEqual(last().status, 'reconnecting');
  assert.match(last().message, /ECONNRESET/, 'the cause of the drop is kept for the status line');

  client.status = 'open';
  client.streamManagement.emit('resumed');
  client.status = 'online';   // Connection#_ready(true): no event

  assert.strictEqual(last().status, 'online');
  assert.match(last().message, /Reconnected/);
  assert.ok(!states.some(s => s.status === 'error'),
    'an error on a live session is not a state of its own; the disconnect reports it');
});

test('a resume the server refuses falls back to a fresh session, which also ends online', () => {
  const { client, last } = watched();
  client.status = 'disconnect';
  client.emit('disconnect', { clean: false });
  client.status = 'online';
  client.emit('online', 'pilot@example.com/carbon2');
  assert.strictEqual(last().status, 'online');
});

test('an error while not connected is reported as one', () => {
  const { client, last } = watched();
  client.status = 'connecting';
  client.emit('error', new Error('getaddrinfo ENOTFOUND jabber.example.com'));
  assert.strictEqual(last().status, 'error');
  assert.match(last().message, /ENOTFOUND/);
});

test('an error that leaves the session up does not change the light', () => {
  const { client, states } = watched();
  client.status = 'online';
  client.emit('online', 'pilot@example.com/carbon');
  const before = states.length;
  client.emit('error', new Error('some handler threw'));
  assert.strictEqual(states.length, before);
});

test('the null-write teardown race is ignored outright', () => {
  const { client, states } = watched();
  client.status = 'connecting';
  client.emit('error', new TypeError("Cannot read properties of null (reading 'write')"));
  assert.strictEqual(states.length, 0);
});

test('a deliberate stop reports offline', () => {
  const { client, last } = watched();
  client.status = 'offline';
  client.emit('offline');
  assert.strictEqual(last().status, 'offline');
});

test('a replaced client is ignored: its late events cannot repaint the light', () => {
  let current = null;
  const { client, states } = watched({ isCurrent: (c) => c === current });
  current = client;
  client.status = 'online';
  client.emit('online', 'pilot@example.com/carbon');
  assert.strictEqual(states.length, 1);

  current = null;   // jabber-connect has moved on to a new client
  client.emit('error', new Error('socket hang up'));
  client.emit('disconnect', { clean: false });
  client.emit('offline');
  client.streamManagement.emit('resumed');
  assert.strictEqual(states.length, 1, 'nothing after the replacement is reported');
});

// The fakes above encode what the library does; this checks the library still
// does it. It runs the INSTALLED @xmpp stream-management resume code against a
// real @xmpp Connection with no socket: send() is where the "server" answers
// <resume/> with <resumed/>. If an @xmpp upgrade starts announcing resumes as
// 'online', this still passes (the state is simply reported twice); if it stops
// emitting 'resumed', it fails, and the light would be back to sticking on red.
test('the installed @xmpp resume path is reported as online', async () => {
  const { default: Connection } = await import('@xmpp/connection');
  const { default: xml } = await import('@xmpp/xml');
  const { default: streamManagement, NS } = await import('@xmpp/stream-management');

  const entity = new Connection({ domain: 'example.com' });
  entity.send = async (el) => {
    if (el.is('resume', NS)) {
      setImmediate(() => entity.emit('nonza', xml('resumed', { xmlns: NS, h: '0', previd: el.attrs.previd })));
    }
  };
  entity.sendMany = async () => {};

  let smFeature = null;
  const streamFeatures = { use: (name, ns, handler) => { if (ns === NS) smFeature = handler; } };
  entity.streamManagement = streamManagement({
    streamFeatures, entity, middleware: { use() {}, filter() {} },
  });
  assert.ok(smFeature, 'stream management registered its stream feature');

  const onlineEvents = [];
  entity.on('online', () => onlineEvents.push('online'));
  const states = [];
  watchConnection(entity, { onState: (s) => states.push(s) });

  // A session that was enabled before the drop, which is what makes it resumable.
  entity.streamManagement.id = 'previous-session';
  entity.status = 'open';
  try {
    await smFeature({ entity }, async () => {});

    assert.strictEqual(entity.status, 'online', 'the library considers the session online');
    assert.deepStrictEqual(onlineEvents, [], 'without ever emitting online, which is why watchConnection cannot rely on it');
    assert.strictEqual(states[states.length - 1]?.status, 'online');
    assert.match(states[states.length - 1].message, /Reconnected/);
  } finally {
    // A resumed session arms stream management's 30 s ack request and 60 s
    // timeout, which would hold this test file open for about a minute and a
    // half. Its 'disconnect' listener clears them.
    entity.emit('disconnect', { clean: true });
  }
});

test('a client without stream management still works', () => {
  const client = new EventEmitter();
  client.status = 'offline';
  const states = [];
  watchConnection(client, { onState: (s) => states.push(s) });
  client.status = 'online';
  client.emit('online', 'pilot@example.com');
  assert.strictEqual(states[0].status, 'online');
});
