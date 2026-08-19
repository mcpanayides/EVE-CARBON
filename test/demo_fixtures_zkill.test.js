'use strict';
//
// zKillboard fixtures for demo mode.
//
// The Killboard is the page with the strongest reason to be faked — a real
// screenshot publishes what its owner flies and loses. These fixtures return
// RAW zkill shapes so the handler's own mapping still runs; a fixture that
// returned finished rows would prove the mapping worked when it never ran.
const test   = require('node:test');
const assert = require('node:assert');

const fx = require('../src/demo_fixtures');

const NOW = Date.parse('2026-08-19T12:00:00Z');

test('the feed has both kills and losses for the demo main', () => {
  const feed = fx.zkillFeed('character', fx.MAIN, 1, NOW);
  assert.ok(feed.length >= 6, 'enough rows to fill the page');

  const losses = feed.filter((k) => [fx.MAIN, fx.INDY, fx.SCOUT].includes(k.victim.character_id));
  const kills  = feed.filter((k) => !losses.includes(k));
  assert.ok(kills.length  > 0, 'there are kills');
  assert.ok(losses.length > 0, 'and losses — an all-green board reads as fake');
});

test('every killmail carries the fields the mapper reads', () => {
  for (const k of fx.zkillFeed('character', fx.MAIN, 1, NOW)) {
    assert.ok(k.killmail_id, 'killmail_id');
    assert.ok(Date.parse(k.killmail_time), 'a parseable killmail_time');
    assert.ok(k.solar_system_id, 'solar_system_id');
    assert.ok(k.victim && k.victim.ship_type_id, 'a victim with a hull');
    assert.ok(Array.isArray(k.attackers) && k.attackers.length, 'attackers');
    assert.ok(k.attackers.some((a) => a.final_blow), k.killmail_id + ' needs a final blow');
    assert.ok(k.zkb && typeof k.zkb.totalValue === 'number', 'a zkb value');
  }
});

test('paging past the first page returns empty rather than repeating', () => {
  // Repeating page 1 forever would make the list scroll infinitely with the
  // same six kills, which looks broken the moment anyone scrolls on camera.
  assert.deepStrictEqual(fx.zkillFeed('character', fx.MAIN, 2, NOW), []);
});

test('stats carry the rankings and history the rank trend needs', () => {
  const s = fx.zkillStats('character', fx.MAIN, NOW);
  assert.ok(s.shipsDestroyed > s.shipsLost, 'a plausible board');

  for (const p of ['alltime', 'recent', 'weekly']) {
    const cur = s.rankings[p] && s.rankings[p].all;
    assert.ok(cur && typeof cur.ranks.overall === 'number', p + ' needs a current rank');
    assert.ok(cur.metrics && cur.metrics.shipsDestroyed > 0, p + ' needs metrics for efficiency');

    const hist = s.rankHistory[p] && s.rankHistory[p].all;
    const days = Object.keys(hist || {});
    assert.ok(days.length, p + ' needs a history snapshot or the trend arrow cannot render');

    // Rank numbers are placings: LOWER is better. The snapshot must be worse
    // than now, or every arrow renders flat and the feature looks dead.
    assert.ok(hist[days[0]].ranks.overall > cur.ranks.overall,
      p + ' history should be a worse placing than current, so the trend climbs');
  }
});
