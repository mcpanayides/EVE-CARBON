// intel-row.js — one intel row, rendered the same way everywhere.
//
// Loaded by BOTH processes' renderers:
//   • the Fleet Commander → Early Warning page (src/func/fc_intel.js)
//   • the floating pop-out window (src/html/intel-widget.html)
//
// Those are separate windows with separate scripts, and the row markup was
// duplicated between them. Two copies of a layout drift — the widget quietly
// stops showing a column the page gained — so the builder lives here and the
// stylesheet (fc.css) is shared too.
//
// ── The column order, and why it is this one ────────────────────────────────
//
//   time · region · system · ships · size · types · ETA
//
// It reads left to right as the question an FC actually asks: when was this,
// whereabouts, exactly where, what is it flying, how many, what can it do to me,
// and how long have I got. The two things that decide whether you act — WHAT and
// HOW MANY — sit in the middle where the eye lands, and the two hard numbers
// (jumps, ETA) anchor the right edge where they can be scanned down a column.
//
// Hulls carry their icon because a picture of a Sabre is recognised faster than
// the word, and recognising tackle a second sooner is the entire product. The
// icons come from CCP's image server, the same source the rest of the app uses,
// and every one degrades to just the name if it fails to load.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IntelRow = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const ICON = (id, size) => `https://images.evetech.net/types/${id}/icon?size=${size || 32}`;

  /**
   * Rounded to something a person would say out loud.
   *
   * Reporting "~83s" implies a precision the estimate does not have: warp speed
   * varies several-fold between hulls and systems differ in size, so this is
   * "roughly how long if it keeps moving as it has been".
   */
  function fmtEta(sec) {
    if (sec == null) return '';
    if (sec <= 0)    return 'HERE';
    if (sec < 45)    return '~30s';
    if (sec < 90)    return '~1m';
    if (sec < 150)   return '~2m';
    if (sec < 600)   return '~' + Math.round(sec / 60) + 'm';
    return '10m+';
  }

  const fmtClock = (ts) =>
    ts == null ? '' : new Date(ts).toISOString().slice(11, 19);

  function ago(ts) {
    if (ts == null) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60)    return s + 's';
    if (s < 3600)  return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  /** The game's own three-way split. Null, low and high are different problems. */
  function secClass(security) {
    if (!Number.isFinite(security)) return 'sec-unknown';
    if (security >= 0.45) return 'sec-high';
    if (security >  0.0)  return 'sec-low';
    return 'sec-null';
  }

  /** Colour by urgency, not raw distance — closing from 8 beats parked at 3. */
  function urgency(c) {
    if (!c) return 'watch';
    if (c.jumps != null && c.jumps <= 1) return 'critical';
    if (c.inbound && c.etaSeconds != null && c.etaSeconds <= 120) return 'critical';
    if (c.jumps != null && c.jumps <= 3) return 'warning';
    if (c.inbound) return 'warning';
    return 'watch';
  }

  function bandLabel(row) {
    if (!row.band) return '';
    if (row.band === 'solo')  return 'SOLO';
    if (row.band === 'fleet') return 'FLEET ' + row.size;
    return 'GANG ' + row.size;
  }

  /**
   * Hull chips, with icons where the type id is known.
   *
   * Chat names hulls in words, so the id comes from an SDE lookup that can miss;
   * killmails carry the id outright. Either way the NAME is always shown and the
   * icon is decoration — a hull nobody could resolve still reads correctly.
   */
  function shipChips(row, limit) {
    const names = row.ships || [];
    const ids   = row.shipIds || [];
    if (!names.length) return '';
    return names.slice(0, limit || 4).map((name, i) => {
      const id = ids[i];
      const img = id
        ? `<img class="ir-ship-icon" src="${ICON(id, 32)}" alt="" loading="lazy"
                onerror="this.style.display='none'">`
        : '';
      return `<span class="ir-ship" title="${esc(name)}">${img}${esc(name)}</span>`;
    }).join('');
  }

  /**
   * One row.
   *
   * @param {object} row  a contact assessment or a feed report, already carrying
   *   { ts|last, regionName, systemName, security, ships, shipIds, size, band,
   *     roles, jumps, etaSeconds, etaMeasured, label, inbound, closing, kind,
   *     source, status, camp, standing, threatTo, predict }
   * @param {object} [opts]
   * @param {boolean} [opts.compact]  the pop-out: drops region and the raw line
   * @param {boolean} [opts.relative] show "4m" rather than a wall clock
   * @param {Function|string} [opts.extra]  extra HTML for the SHIPS cell. The
   *   page uses it for the "likely next system" chip, which the pop-out has no
   *   room for — a slot rather than a second copy of this function.
   */
  function rowHtml(row, opts) {
    const o = opts || {};
    const time = o.relative ? ago(row.last != null ? row.last : row.ts)
                            : fmtClock(row.ts != null ? row.ts : row.last);
    const clear = row.status === 'clear';
    const eta   = fmtEta(row.etaSeconds);

    const cls = [
      'ir-row',
      'intel-' + urgency(row),
      clear ? 'ir-clear' : '',
      row.source === 'killmail' ? 'ir-kill' : '',
      o.compact ? 'ir-compact' : '',
    ].filter(Boolean).join(' ');

    // The label is the pilot for a tracked contact and nothing for a bare system
    // report — in that case the system chip already carries the whole message.
    const label = row.kind === 'pilot' || (row.pilots && row.pilots.length)
      ? (row.label && row.label !== row.systemName ? row.label : (row.pilots || [])[0])
      : null;

    return `<div class="${cls}" title="${esc(row.body || '')}">
      <span class="ir-time">${esc(time)}</span>
      ${o.compact ? '' : `<span class="ir-region">${esc(row.regionName || '')}</span>`}
      <span class="ir-system ${secClass(row.security)}">${esc(row.systemName || '')}</span>
      <span class="ir-what">
        ${clear ? '<span class="ir-flag ir-flag-clear">clear</span>' : ''}
        ${label ? `<span class="ir-pilot">${esc(label)}</span>` : ''}
        ${shipChips(row, o.compact ? 3 : 4)}
        ${row.camp ? '<span class="ir-flag ir-flag-camp">bubbled</span>' : ''}
        ${Number.isFinite(row.standing) && row.standing <= -5
          ? `<span class="ir-flag ir-flag-red">${row.standing}</span>` : ''}
        ${row.source === 'killmail' ? '<span class="ir-flag ir-flag-kill">kill</span>' : ''}
        ${typeof o.extra === 'function' ? (o.extra(row) || '') : (o.extra || '')}
      </span>
      <span class="ir-size">${row.band
        ? `<span class="intel-tag intel-band-${row.band}">${bandLabel(row)}</span>`
        : (Number.isFinite(row.count) ? `<span class="intel-tag">+${row.count}</span>` : '')}</span>
      <span class="ir-types">${(row.roles || [])
        .map(r => `<span class="intel-tag intel-role-${r}">${esc(String(r).toUpperCase())}</span>`)
        .join('')}${row.inbound ? `<span class="intel-tag intel-tag-inbound">IN −${row.closing}</span>` : ''}</span>
      <span class="ir-eta">${row.jumps != null
        ? `<b class="ir-jumps">${row.jumps}<span class="ir-j">j</span></b>` : ''}${
        eta ? `<span class="ir-etaval ${row.etaMeasured ? '' : 'intel-eta-guess'}">${esc(eta)}</span>` : ''}</span>
    </div>`;
  }

  /** Column headings, so the row order is legible rather than guessed at. */
  function headerHtml(opts) {
    const o = opts || {};
    return `<div class="ir-row ir-head ${o.compact ? 'ir-compact' : ''}">
      <span class="ir-time">TIME</span>
      ${o.compact ? '' : '<span class="ir-region">REGION</span>'}
      <span class="ir-system">SYSTEM</span>
      <span class="ir-what">SHIPS</span>
      <span class="ir-size">SIZE</span>
      <span class="ir-types">TYPE</span>
      <span class="ir-eta">ETA</span>
    </div>`;
  }

  return { rowHtml, headerHtml, fmtEta, fmtClock, ago, secClass, urgency, bandLabel, esc };
});
