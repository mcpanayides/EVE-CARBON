'use strict';
//
// Undoing a Python repr that ESI hands back instead of a string.
//
// A ship named "♦ Pegasus" comes out of /characters/{id}/ship/ as the literal
// seventeen ASCII characters
//
//     u'♦ Pegasus'
//
// — Python 2's repr() of the unicode string, quotes, `u` prefix, escape and all.
// Verified against a real character database: the stored value's code points are
// [117, 39, 92, 117, 50, 54, 54, 54, …], i.e. `u`, `'`, `\`, `u`, `2`, `6`, `6`,
// `6`, so nothing on this side decoded it wrongly — that is what arrived.
//
// It is CCP's own inconsistency, not a general ESI rule: the SAME ship name
// comes back correctly encoded from /characters/{id}/fittings/, which is why the
// fitting window showed "♦ Pegasus" while the character panel showed the repr.
// So this is applied where the affected values enter, not blanket-applied to
// every string from ESI.
//
// CONSERVATIVE BY CONSTRUCTION. A player can legitimately name a ship
// `u'hello'`, and mangling that would be a worse bug than the one being fixed.
// So the whole string must look like a repr — `u` prefix, matching quotes, and
// at least one escape sequence inside — before anything is decoded, and any
// unrecognised escape aborts the whole attempt and returns the input untouched.

// `u'…'` or `u"…"`, whole string, nothing outside the quotes.
const PY_REPR = /^u(['"])([\s\S]*)\1$/;

// The escapes Python's repr actually emits for a unicode string.
const ESCAPE = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
  '\\': '\\', "'": "'", '"': '"', a: '\x07',
};

/**
 * Decode a Python-repr string, or return the input unchanged.
 *
 * @param {*} value
 * @returns {*} the decoded string, or `value` exactly as given
 */
function decodeEsiText(value) {
  if (typeof value !== 'string') return value;
  const m = PY_REPR.exec(value.trim());
  if (!m) return value;
  const body = m[2];
  // No escape at all means this is just a name that happens to start with u' —
  // there is nothing to decode and every reason not to strip its quotes.
  if (!body.includes('\\')) return value;

  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const k = body[++i];
    if (k === undefined) return value;              // trailing backslash: not a repr
    if (k === 'u' || k === 'U' || k === 'x') {
      const len = k === 'x' ? 2 : (k === 'u' ? 4 : 8);
      const hex = body.slice(i + 1, i + 1 + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return value;
      const code = parseInt(hex, 16);
      // Beyond the Unicode range, or a lone surrogate — both mean this was not
      // the repr it looked like.
      if (code > 0x10FFFF) return value;
      out += String.fromCodePoint(code);
      i += len;
      continue;
    }
    if (!(k in ESCAPE)) return value;               // unknown escape: leave it alone
    out += ESCAPE[k];
  }
  return out;
}

module.exports = { decodeEsiText, PY_REPR };
