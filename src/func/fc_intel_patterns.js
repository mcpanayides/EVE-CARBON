// ─── Fleet Commander → Early Warning → patterns ───────────────────────────────
// Everything else in the early-warning tool answers "where is it now". This
// answers "where do they usually come from, and when" — the part that lets an op
// be planned rather than merely survived.
//
// The whole design problem here is presenting statistics without lending them
// more authority than they have. So:
//
//   • the sample is always on screen, next to the claim, not behind a tooltip;
//   • the full 24-hour distribution is drawn, with only the hours that cleared
//     the test marked — the operator sees the data, not just the conclusion;
//   • below the evidence threshold the panel says so plainly and shows nothing
//     else, rather than displaying a confident-looking chart of three sightings.
//
// Every top-level name is _intelPat*-prefixed: renderer scripts share ONE global
// scope, and a bare name colliding with another file kills that file outright
// (see the note in fc_intel.js).

/** "10" when a block is uniform, "6–10" when its hours differ. */
const _intelPatDays = (b) => (b.daysLo === b.daysHi ? `${b.daysHi}` : `${b.daysLo}–${b.daysHi}`);

/** A prediction is only worth a row of its own when it is about to matter. */
function _intelPatPredictChip(c) {
  if (!c || !c.predict) return '';
  const p = c.predict;
  const pct = Math.round(p.share * 100);
  const title = `On ${p.n} of the last ${p.outOf} occasions something left ` +
                `${c.systemName} it went to ${p.systemName}, across ${p.days} separate days.` +
                (p.jumps != null ? ` ${p.systemName} is ${p.jumps} jumps from you.` : '');
  return `<span class="intel-tag intel-tag-predict ${p.closer ? 'intel-predict-closer' : ''}"
                title="${_intelEsc(title)}">${p.closer ? '↘' : '→'} ${_intelEsc(p.systemName)}</span>`;
}

async function _intelOpenPatterns() {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal intel-pat-modal">
      <h3>Patterns</h3>
      <div class="intel-ch-help">
        Built from what has actually been seen near your monitored characters.
        Nothing here describes right now — it describes habits.
      </div>
      <div id="intelPatBody" class="intel-pat-body"><div class="empty-state">Reading history…</div></div>
      <div class="modal-actions">
        <button class="fc-track-btn fc-invite-btn" data-act="clear"
                title="Forget everything learned so far — for a move to new space, where none of it holds">Forget history</button>
        <span class="intel-rules-spacer"></span>
        <button class="fc-track-btn" data-act="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('[data-act="close"]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  const body = modal.querySelector('#intelPatBody');
  const load = async () => {
    try {
      body.innerHTML = _intelPatRender(await window.eveAPI.intelPatterns());
    } catch (e) {
      body.innerHTML = `<div class="empty-state">Couldn't read the history: ${_intelEsc(e.message)}</div>`;
    }
  };

  modal.querySelector('[data-act="clear"]').onclick = async () => {
    if (!confirm('Forget every route and time-of-day pattern learned so far?\n\nWorth doing after a move — patterns from your old space do not hold in the new one.')) return;
    try { await window.eveAPI.intelClearPatterns(); await load(); showToast('Pattern history cleared.', 'success'); }
    catch (e) { showToast(`Couldn't clear history: ${e.message}`, 'error'); }
  };

  await load();
}

function _intelPatRender(p) {
  if (!p) return '<div class="empty-state">No history yet.</div>';

  // The sample, first and unmissable. Every number below is only as good as it.
  const head = `
    <div class="intel-pat-sample">
      <b>${p.daysObserved}</b> day${p.daysObserved === 1 ? '' : 's'} of history ·
      <b>${p.sightings}</b> sightings · <b>${p.walks}</b> tracked movements
      ${p.gapped ? ` · <span class="intel-pat-dim" title="A contact seen in one system and then another with nothing reported in between. Those cannot be used for routes — there is no way to know which way they actually went.">${p.gapped} hops had gaps in reporting</span>` : ''}
    </div>`;

  if (!p.ready) {
    // Deliberately shows nothing else. A chart drawn from three sightings looks
    // exactly as convincing as one drawn from three hundred, and that is the
    // failure this panel exists to avoid.
    return head + `
      <div class="intel-pat-notready">
        <span class="material-symbols-outlined">hourglass_empty</span>
        <div>
          <b>Not enough history to say anything yet.</b>
          <div class="intel-pat-dim">Patterns need at least ${p.minDaysObserved} days of watching before
          they mean anything — until then, any shape in the data is as likely to be chance.
          Keep the watcher running and check back.</div>
        </div>
      </div>`;
  }

  const peak = Math.max(1, ...p.hours.map(h => h.days));
  const bars = p.hours.map(h => `
    <div class="intel-pat-bar ${h.notable ? 'intel-pat-bar-hot' : ''}"
         title="${h.label} — hostiles reported on ${h.days} of ${p.daysObserved} days (${Math.round(h.share * 100)}%), ${h.sightings} sightings${h.notable ? `. ${h.lift.toFixed(1)}× the average hour.` : ''}">
      <div class="intel-pat-bar-fill" style="height:${Math.round((h.days / peak) * 100)}%"></div>
      <div class="intel-pat-bar-lbl">${h.bucket % 3 === 0 ? h.label.slice(0, 2) : ''}</div>
    </div>`).join('');

  const blocks = p.hourBlocks || [];
  const hourVerdict = blocks.length
    ? `Busiest <b>${_intelEsc(blocks[0].label)}</b> EVE time — reported on
       ${_intelPatDays(blocks[0])} of the last ${p.daysObserved} days.` +
      (blocks.length > 1
        ? ` Then ${blocks.slice(1).map(b => `<b>${_intelEsc(b.label)}</b> (${_intelPatDays(b)})`).join(', ')}.` : '') +
      ` <span class="intel-pat-dim">An average hour sees activity on
        ${Math.round(p.hourBaseline * 100)}% of days.</span>`
    : `<span class="intel-pat-dim">No hour stands out from the rest — activity is spread across the day.</span>`;

  const days = p.weekdays.filter(d => d.notable);
  const dayVerdict = days.length
    ? `<div class="intel-pat-verdict">Heaviest on <b>${days.map(d => d.label).join(', ')}</b>.</div>` : '';

  const corridors = p.corridors.length ? p.corridors.map(c => `
    <div class="intel-pat-route">
      <div class="intel-pat-route-path">${c.names.map(n => `<span class="ifc ifc-sys">${_intelEsc(n)}</span>`).join('<span class="intel-pat-arrow">›</span>')}</div>
      <div class="intel-pat-route-n">${c.n}× · ${c.days} day${c.days === 1 ? '' : 's'} · ${c.contacts} contacts</div>
    </div>`).join('')
    : `<div class="intel-pat-dim">No route has been flown often enough yet. A corridor has to be
       walked end to end at least three separate times before it counts — a route stitched together
       from "most likely next gate" would look convincing and might never have been flown at all.</div>`;

  const entries = p.entries.length ? `
    <div class="intel-pat-entries">
      ${p.entries.slice(0, 8).map(e => `
        <span class="intel-pat-entry" title="Contacts first appeared here on ${e.days} separate days">
          <b>${_intelEsc(e.name)}</b> <span class="intel-pat-dim">${e.n}×</span></span>`).join('')}
    </div>`
    : '<div class="intel-pat-dim">Nowhere yet stands out as a way in.</div>';

  return head + `
    <div class="intel-pat-section">
      <div class="intel-pat-title">WHEN <span class="intel-hint">days on which hostiles were reported in each hour — EVE time (UTC)</span></div>
      <div class="intel-pat-chart">${bars}</div>
      <div class="intel-pat-verdict">${hourVerdict}</div>
      ${dayVerdict}
    </div>
    <div class="intel-pat-section">
      <div class="intel-pat-title">ROUTES <span class="intel-hint">flown end to end, not inferred</span></div>
      ${corridors}
    </div>
    <div class="intel-pat-section">
      <div class="intel-pat-title">WHERE THEY COME FROM <span class="intel-hint">systems contacts first appear in</span></div>
      ${entries}
    </div>`;
}
