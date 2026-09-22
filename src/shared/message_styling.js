// message_styling.js — XEP-0393 Message Styling, parsed into a safe tree.
//
// Loaded by BOTH processes:
//   • main     — require()d by jabber_ipc to attach an XHTML-IM copy to what we send
//   • renderer — a <script> tag; attaches window.MessageStyling for the room view
//
// ── Why XEP-0393 and not XEP-0071 ─────────────────────────────────────────────
//
// XEP-0071 (XHTML-IM) is DEPRECATED by the XMPP Standards Foundation. Rendering
// HTML that strangers send you is the problem it could never solve safely, and
// its own security section says the profile's exclusions cannot be relied on.
//
// XEP-0393 (Message Styling) is a Stable Standard, and it is the syntax this
// app's composer was already producing: *strong*, _emphasis_, ~strike~ and
// `preformatted`. The asterisks people were seeing were not a missing feature on
// the wire — they were our OWN client not rendering a standard it was sending.
//
// So the body we send stays plain text with its directives in it, which every
// client can read (0393 requires that it degrade to something human-readable),
// and this module turns it into a tree the renderer builds as DOM nodes. The
// spec is explicit that "Markdown parsers often allow arbitrary HTML" and MUST
// NOT be used for this; nothing here ever produces or accepts markup.
//
// The one concession to 0071 is send-only: clients like Pidgin implement XHTML-IM
// but not 0393, so we attach an XHTML-IM copy built from this same tree. We
// generate it, from our own parse, so none of the inbound risk applies. We never
// render XHTML-IM we receive.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MessageStyling = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // A sender can ask for a message not to be styled: an empty <unstyled/> in
  // this namespace (XEP-0393 §6). Bots posting config or code use it.
  const STYLING_NS = 'urn:xmpp:styling:0';
  const XHTML_IM_NS = 'http://jabber.org/protocol/xhtml-im';
  const XHTML_NS    = 'http://www.w3.org/1999/xhtml';

  // The four span directives. There is deliberately no underline: the spec
  // defines none, and the composer's old `__underline__` was an invention that no
  // client anywhere would ever render.
  const SPAN_TYPE = { '*': 'strong', '_': 'em', '~': 'strike', '`': 'pre' };

  const isWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
                    || ch === '\u00a0' || ch === '\u3000';

  /**
   * An opening directive is valid only at the start of its text, after
   * whitespace, and when it is NOT followed by whitespace (§5.1). The third case
   * the spec lists — "after a different opening directive" — falls out of the
   * recursion: a nested span's content is parsed from its own index 0.
   */
  function canOpen(s, i) {
    if (i + 1 >= s.length || isWs(s[i + 1])) return false;
    return i === 0 || isWs(s[i - 1]);
  }

  /**
   * The first matching directive that is not preceded by whitespace, with at
   * least one character between the two — an empty span styles nothing (§5.1).
   * No close on the line means no span: "*not strong" stays literal.
   */
  function findClose(s, i, ch) {
    for (let k = i + 2; k < s.length; k++) {
      if (s[k] === ch && !isWs(s[k - 1])) return k;
    }
    return -1;
  }

  /**
   * Inline spans for ONE line. Spans never cross lines (§5.1), so the caller
   * hands this a line at a time.
   *
   * Node shapes:
   *   { t: 'text', v }
   *   { t: 'strong'|'em'|'strike', d, c: [nodes] }   d = the directive character
   *   { t: 'pre', d, v }                             content is never re-parsed
   */
  function parseSpans(s) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const type = SPAN_TYPE[ch];
      if (type && canOpen(s, i)) {
        const j = findClose(s, i, ch);
        if (j !== -1) {
          flush();
          const inner = s.slice(i + 1, j);
          // "Inline formatting directives inside the preformatted span are not
          // rendered" — so its content is kept verbatim, never recursed into.
          out.push(type === 'pre'
            ? { t: 'pre', d: ch, v: inner }
            : { t: type, d: ch, c: parseSpans(inner) });
          i = j;
          continue;
        }
      }
      buf += ch;
    }
    flush();
    return out;
  }

  /**
   * Block structure (§5.2): plain lines, preformatted blocks fenced by ```, and
   * quotations made of consecutive lines beginning with '>'. A fence left open
   * runs to the end of the message, as the spec says.
   *
   * Node shapes:
   *   { t: 'line',  c: [spans] }
   *   { t: 'block', open, close, v }     close is '' when the fence never closed
   *   { t: 'quote', c: [blocks] }
   */
  function parseBlocks(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('```')) {
        const body = [];
        let close = '';
        let k = i + 1;
        for (; k < lines.length; k++) {
          if (lines[k] === '```') { close = '```'; break; }
          body.push(lines[k]);
        }
        out.push({ t: 'block', open: line, close, v: body.join('\n') });
        i = k;          // k is the closing fence, or one past the end
        continue;
      }

      if (line.startsWith('>')) {
        const quoted = [];
        let k = i;
        while (k < lines.length && lines[k].startsWith('>')) {
          // The '>' and a single following space are the marker, not content.
          quoted.push(lines[k].replace(/^> ?/, ''));
          k++;
        }
        out.push({ t: 'quote', c: parseBlocks(quoted.join('\n')) });
        i = k - 1;
        continue;
      }

      out.push({ t: 'line', c: parseSpans(line) });
    }
    return out;
  }

  /** True when the tree contains any styling at all. */
  function hasStyling(blocks) {
    const spanStyled = (nodes) => nodes.some(n => n.t !== 'text');
    return blocks.some(b =>
      b.t === 'block' || b.t === 'quote' || (b.t === 'line' && spanStyled(b.c)));
  }

  /** Plain text of a tree with every directive removed — for tests and search. */
  function plainText(blocks) {
    const spans = (nodes) => nodes.map(n =>
      n.t === 'text' || n.t === 'pre' ? n.v : spans(n.c)).join('');
    return blocks.map(b =>
      b.t === 'line'  ? spans(b.c)
    : b.t === 'block' ? b.v
    : plainText(b.c)).join('\n');
  }

  /**
   * An XHTML-IM <html/> element for the same text, built with the caller's
   * ltx/@xmpp `xml()` factory — so every text node is escaped by that library
   * and nothing here concatenates markup.
   *
   * Restricted to XEP-0071's recommended profile, which has no <pre>, <code>,
   * <s> or <u>: strike and monospace are spans with a single style property,
   * which is exactly how the profile expresses them. Directives are dropped —
   * the formatting is explicit here, and Pidgin showing "*bold*" in bold, with
   * the asterisks, would look like a bug.
   *
   * Returns null for a message with no styling, so plain chat is not doubled
   * up with a pointless XHTML copy.
   */
  function toXhtmlIm(text, xml) {
    const blocks = parseBlocks(text);
    if (!hasStyling(blocks)) return null;

    const spans = (nodes) => nodes.map(n => {
      switch (n.t) {
        case 'text':   return n.v;
        case 'strong': return xml('strong', {}, ...spans(n.c));
        case 'em':     return xml('em', {}, ...spans(n.c));
        case 'strike': return xml('span', { style: 'text-decoration: line-through' }, ...spans(n.c));
        case 'pre':    return xml('span', { style: 'font-family: monospace' }, n.v);
        default:       return '';
      }
    });

    const withBreaks = (parts) => parts.flatMap((p, i) => (i ? [xml('br'), ...p] : p));

    const blocksToXhtml = (bs) => {
      const out = [];
      let run = [];                      // consecutive plain lines share a <p>
      const flushRun = () => {
        if (run.length) out.push(xml('p', {}, ...withBreaks(run)));
        run = [];
      };
      for (const b of bs) {
        if (b.t === 'line') { run.push(spans(b.c)); continue; }
        flushRun();
        if (b.t === 'block') {
          out.push(xml('p', {}, xml('span', { style: 'font-family: monospace' },
            ...withBreaks(b.v.split('\n').map(l => [l])))));
        } else if (b.t === 'quote') {
          out.push(xml('blockquote', {}, ...blocksToXhtml(b.c)));
        }
      }
      flushRun();
      return out;
    };

    return xml('html', { xmlns: XHTML_IM_NS },
      xml('body', { xmlns: XHTML_NS }, ...blocksToXhtml(blocks)));
  }

  return {
    STYLING_NS, XHTML_IM_NS, XHTML_NS,
    parseSpans, parseBlocks, hasStyling, plainText, toXhtmlIm,
  };
});
