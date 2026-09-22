'use strict';
//
// XEP-0393 Message Styling, and the XHTML-IM copy we send alongside it.
//
// Bold and italic used to arrive back in our own room view as literal asterisks.
// The composer was already sending XEP-0393 — the Stable XMPP standard for this,
// and the replacement for XHTML-IM, which the XSF has deprecated — but nothing on
// the receiving side rendered it.
//
// Most of what is pinned here is where styling must NOT happen. Chat is full of
// asterisks and underscores that are not formatting: arithmetic, snake_case,
// URLs, an unfinished thought. A parser that styles too eagerly mangles the one
// thing a chat log has to be — an accurate record of what was said.
//
// Rules are quoted from the spec (xmpp.org/extensions/xep-0393.html, §5):
//   • an opening directive is valid at the start of a block, after whitespace,
//     or after another opening directive, and MUST NOT be followed by whitespace
//   • a closing directive MUST NOT be preceded by whitespace
//   • a span MUST contain text, spans cannot cross lines
//   • directives inside a preformatted span are not rendered
//
// Room names in every fixture are invented. Nothing here touches a real server.
const test   = require('node:test');
const assert = require('node:assert');
const MS     = require('../src/shared/message_styling.js');

/** Collapse a span tree to a compact string, so assertions read like the input. */
function shape(nodes) {
  return nodes.map(n => {
    if (n.t === 'text') return n.v;
    if (n.t === 'pre')  return `<pre:${n.v}>`;
    return `<${n.t}:${shape(n.c)}>`;
  }).join('');
}
const spans = (s) => shape(MS.parseSpans(s));

// ─── what gets styled ────────────────────────────────────────────────────────

test('the four directives style what they wrap', () => {
  assert.strictEqual(spans('*bold*'), '<strong:bold>');
  assert.strictEqual(spans('_it_'), '<em:it>');
  assert.strictEqual(spans('~gone~'), '<strike:gone>');
  assert.strictEqual(spans('`code`'), '<pre:code>');
});

test('styled and plain runs sit side by side', () => {
  assert.strictEqual(spans('undock *now* and _slowly_'),
                     'undock <strong:now> and <em:slowly>');
});

test('spans nest, because an opening directive may follow another', () => {
  assert.strictEqual(spans('*_both_*'), '<strong:<em:both>>');
  assert.strictEqual(spans('*bold with _it_ inside*'), '<strong:bold with <em:it> inside>');
});

test('nothing inside a preformatted span is styled', () => {
  // "Inline formatting directives inside the preformatted span are not rendered."
  assert.strictEqual(spans('`*not bold*`'), '<pre:*not bold*>');
});

// ─── what must be left exactly as typed ──────────────────────────────────────

test('an opening directive mid-word styles nothing', () => {
  // The rule that saves arithmetic and identifiers: the directive must follow
  // whitespace (or open the line).
  assert.strictEqual(spans('2*3*4'), '2*3*4');
  assert.strictEqual(spans('foo*bar*'), 'foo*bar*');
  assert.strictEqual(spans('some_var_name'), 'some_var_name');
});

test('whitespace just inside a directive voids it', () => {
  assert.strictEqual(spans('* nope*'), '* nope*', 'opening followed by whitespace');
  assert.strictEqual(spans('*nope *'), '*nope *', 'closing preceded by whitespace');
});

test('an empty or unclosed span styles nothing', () => {
  assert.strictEqual(spans('**'), '**');
  assert.strictEqual(spans('*unclosed'), '*unclosed');
  assert.strictEqual(spans('a lone * in a sentence'), 'a lone * in a sentence');
});

test('a URL with underscores in it survives intact', () => {
  // Underscores inside a word cannot open a span, so a link keeps its path —
  // and stays one text run for linkify to find.
  const url = 'https://evewho.com/pilot/Some_Pilot_Name';
  assert.strictEqual(spans(`see ${url} for more`), `see ${url} for more`);
});

// ─── blocks ──────────────────────────────────────────────────────────────────

test('spans never cross lines', () => {
  const b = MS.parseBlocks('*starts here\nends here*');
  assert.strictEqual(b.length, 2);
  assert.strictEqual(shape(b[0].c), '*starts here');
  assert.strictEqual(shape(b[1].c), 'ends here*');
});

test('a fenced block is verbatim and ends at a bare fence', () => {
  const b = MS.parseBlocks('before\n```\n*not bold*\n_nor this_\n```\nafter');
  assert.deepStrictEqual(b.map(x => x.t).join(','), 'line,block,line');
  assert.strictEqual(b[1].v, '*not bold*\n_nor this_');
  assert.strictEqual(b[1].close, '```');
});

test('a fence left open runs to the end of the message', () => {
  const b = MS.parseBlocks('```\nline one\nline two');
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].v, 'line one\nline two');
  assert.strictEqual(b[0].close, '', 'no closing fence was invented');
});

test('consecutive > lines are one quotation, and styled inside', () => {
  const b = MS.parseBlocks('> *first* line\n> second line\nreply');
  assert.strictEqual(b.map(x => x.t).join(','), 'quote,line');
  assert.strictEqual(b[0].c.length, 2);
  assert.strictEqual(shape(b[0].c[0].c), '<strong:first> line');
});

test('plain text reports no styling and reads back unchanged', () => {
  const b = MS.parseBlocks('form up at the staging keepstar');
  assert.strictEqual(MS.hasStyling(b), false);
  assert.strictEqual(MS.plainText(b), 'form up at the staging keepstar');
  assert.strictEqual(MS.hasStyling(MS.parseBlocks('*form up*')), true);
});

// ─── the XHTML-IM copy we send ───────────────────────────────────────────────
// Built with the REAL @xmpp/client xml() factory, the same one jabber_ipc uses,
// so escaping is proven against the library rather than assumed.

let xml;
test.before(async () => { ({ xml } = await import('@xmpp/client')); });

test('plain chat gets no XHTML copy at all', () => {
  assert.strictEqual(MS.toXhtmlIm('just talking', xml), null);
});

test('the copy is namespaced as XEP-0071 requires and drops the directives', () => {
  const out = MS.toXhtmlIm('*undock* _now_', xml).toString();
  assert.match(out, /^<html xmlns="http:\/\/jabber\.org\/protocol\/xhtml-im">/);
  assert.match(out, /<body xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/);
  assert.match(out, /<strong>undock<\/strong> <em>now<\/em>/);
  assert.ok(!/\*|_now_/.test(out), 'the markers are the plain body\'s job, not this one');
});

test('the copy stays inside the XEP-0071 recommended profile', () => {
  // The profile has no <s>, <u>, <code> or <pre>: strike and monospace are spans
  // with a single style, which is how it expresses them.
  const out = MS.toXhtmlIm('~gone~ `J-GAMP`\n```\nblock\n```\n> quoted', xml).toString();
  const tags = [...out.matchAll(/<([a-z]+)[\s>/]/g)].map(m => m[1]);
  const profile = new Set(['html', 'body', 'p', 'br', 'strong', 'em', 'span', 'blockquote']);
  const outside = tags.filter(t => !profile.has(t));
  assert.deepStrictEqual(outside, [], `outside the profile: ${outside.join(', ')}`);
  assert.match(out, /text-decoration: line-through/);
  assert.match(out, /font-family: monospace/);
});

test('markup typed into a message is escaped in the copy, never emitted', () => {
  // The whole reason XEP-0071 was deprecated is HTML injection. We only ever
  // SEND it, but what we send must still be text all the way down.
  const out = MS.toXhtmlIm('*<script>alert(1)</script>* <img src=x onerror=alert(1)>', xml).toString();
  assert.ok(!out.includes('<script'), out);
  assert.ok(!out.includes('<img'), out);
  assert.match(out, /&lt;script&gt;/);
});

// ─── honouring the sender's opt-out ──────────────────────────────────────────

const { parseMamResult } = require('../src/jabber_ipc');

function archived(extra) {
  return xml('message', {},
    xml('result', { xmlns: 'urn:xmpp:mam:2', id: 'arc1', queryid: 'q1' },
      xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
        xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-09-01T12:00:00Z' }),
        xml('message', { from: 'testroom@conference.example.test/configbot' },
          xml('body', {}, 'a*b*c'), ...(extra ? [extra] : [])))));
}

test('an archived message that opted out of styling is recognised', () => {
  const m = parseMamResult(archived(xml('unstyled', { xmlns: MS.STYLING_NS })), 'q1');
  assert.strictEqual(m.unstyled, true);
});

test('only the real namespace counts as an opt-out', () => {
  // Built with the real element type, whose getChild is namespace-aware — a
  // look-alike element in some other namespace must not switch styling off.
  assert.strictEqual(parseMamResult(archived(xml('unstyled', { xmlns: 'urn:example:other' })), 'q1').unstyled, false);
  assert.strictEqual(parseMamResult(archived(null), 'q1').unstyled, false);
});
