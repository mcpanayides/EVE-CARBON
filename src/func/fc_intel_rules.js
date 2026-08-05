// ─── Fleet Commander → Early Warning → custom alert rules ─────────────────────
// The built-in proximity alert asks one question for everyone: is something
// close or closing? That is the right default and the wrong ceiling. Rules
// cover the specifics a fleet actually cares about — a named hot-dropper
// anywhere in the region, a −10 on the contact sheet within 10 jumps, one
// interdictor however far out.
//
// Rules ADD to the built-in alert. Turning them all off leaves the tool
// behaving exactly as it did before rules existed.
//
// Every top-level name here is _intelRule*-prefixed: renderer scripts share one
// global scope, and a bare name colliding with another file kills that file
// outright (see the note in fc_intel.js).

let _intelRulesCache = [];

const _INTEL_ROLE_CHOICES = ['tackle', 'cloaky', 'ewar', 'capital', 'logi'];

// The same sentence the rule list shows, built here rather than imported from
// the main-process module — the renderer has no require().
function _intelRuleSentence(r) {
  const m = r.match || {};
  const bits = [];
  // Mirrors ruleMatches(): a present-but-empty list fails closed, so the
  // sentence has to say the rule can never fire rather than implying "anything".
  if (Array.isArray(m.pilots)) {
    bits.push(m.pilots.length ? `a watchlist pilot (${m.pilots.length})`
                              : 'a watchlist pilot — none added yet, so this never fires');
  }
  if (Array.isArray(m.ships)) bits.push(m.ships.length ? m.ships.join(' / ') : 'a ship — none listed yet');
  if (Array.isArray(m.roles)) bits.push(m.roles.length ? m.roles.join(' / ') : 'a role — none picked yet');
  if (Number.isFinite(m.minSize))  bits.push(`${m.minSize}+ pilots`);
  if (Number.isFinite(m.maxStanding)) bits.push(`standing ${m.maxStanding} or worse`);
  if (m.camp)    bits.push('bubbles / gate camp');
  if (m.inbound) bits.push('closing on us');
  const what  = bits.length ? bits.join(' and ') : 'anything';
  const w     = r.within || {};
  const where = (w.minJumps || 0) === 0 ? `within ${w.maxJumps ?? 15} jumps`
                                        : `${w.minJumps}–${w.maxJumps} jumps out`;
  const acts  = [(r.then || {}).notify !== false ? 'notify' : null,
                 (r.then || {}).sound ? 'sound' : null].filter(Boolean).join(' + ') || 'nothing';
  return `When <b>${_intelEsc(what)}</b> is reported <b>${where}</b> → ${acts}`;
}

async function _intelOpenRules() {
  try { _intelRulesCache = await window.eveAPI.intelGetRules(); }
  catch (e) { return showToast(`Couldn't load alerts: ${e.message}`, 'error'); }

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal intel-rules-modal">
      <h3>Custom alerts</h3>
      <div class="intel-ch-help">
        These run alongside the built-in proximity alert. Standings come from your
        alliance contact sheet, so a rule can watch for anyone set to −10.
      </div>
      <div class="intel-rules-list" id="intelRulesList"></div>
      <div class="modal-actions">
        <button class="fc-track-btn fc-invite-btn" data-act="add">+ New alert</button>
        <span class="intel-rules-spacer"></span>
        <button class="fc-track-btn fc-invite-btn" data-act="close">Close</button>
        <button class="fc-track-btn" data-act="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const listEl = modal.querySelector('#intelRulesList');
  const paint = () => {
    listEl.innerHTML = _intelRulesCache.length ? _intelRulesCache.map((r, i) => `
      <div class="intel-rule ${r.enabled ? '' : 'intel-rule-off'}" data-i="${i}">
        <label class="switch intel-rule-sw">
          <input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}>
          <span class="switch-slider"></span>
        </label>
        <div class="intel-rule-body">
          <input class="intel-rule-name" data-act="name" value="${_intelEsc(r.name || '')}">
          <div class="intel-rule-desc">${_intelRuleSentence(r)}</div>
        </div>
        <button class="fc-track-btn fc-invite-btn" data-act="edit">Edit</button>
        <button class="fc-track-btn fc-invite-btn intel-rule-del" data-act="del" title="Delete">✕</button>
      </div>`).join('')
      : '<div class="empty-state">No alerts yet.</div>';

    listEl.querySelectorAll('.intel-rule').forEach(row => {
      const i = Number(row.dataset.i);
      row.querySelector('[data-act="toggle"]').onchange = (e) => {
        _intelRulesCache[i].enabled = e.target.checked; paint();
      };
      row.querySelector('[data-act="name"]').onchange = (e) => { _intelRulesCache[i].name = e.target.value; };
      row.querySelector('[data-act="del"]').onclick   = () => { _intelRulesCache.splice(i, 1); paint(); };
      row.querySelector('[data-act="edit"]').onclick  = () => _intelEditRule(i, paint);
    });
  };
  paint();

  modal.querySelector('[data-act="add"]').onclick = () => {
    _intelRulesCache.push({
      id: `rule-${Date.now().toString(36)}`, enabled: true, name: 'New alert',
      match: {}, within: { minJumps: 0, maxJumps: 15 },
      then: { notify: true, sound: false, level: 'warning' }, quietForS: 60,
    });
    paint();
    _intelEditRule(_intelRulesCache.length - 1, paint);
  };
  const close = () => modal.remove();
  modal.querySelector('[data-act="close"]').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  modal.querySelector('[data-act="save"]').onclick = async () => {
    try {
      await window.eveAPI.intelSetRules(_intelRulesCache);
      close();
      const on = _intelRulesCache.filter(r => r.enabled).length;
      showToast(`${on} alert${on === 1 ? '' : 's'} active.`, 'success');
    } catch (e) { showToast(`Couldn't save alerts: ${e.message}`, 'error'); }
  };
}

// Editing one rule. Deliberately a flat form rather than RIFT's multi-step
// wizard: every condition is optional and independent, so showing them together
// is fewer clicks AND makes it obvious that leaving one blank means "don't
// care" — a wizard hides that behind a branch you never see.
function _intelEditRule(i, onDone) {
  const r = _intelRulesCache[i];
  if (!r) return;
  const m = r.match || (r.match = {});
  const w = r.within || (r.within = {});
  const t = r.then   || (r.then   = {});
  const csv = (a) => (Array.isArray(a) ? a.join(', ') : '');

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal intel-rule-modal">
      <h3>Edit alert</h3>
      <div class="intel-ch-help">Leave a field blank to ignore it. Everything you do fill in must match.</div>
      <label class="intel-rf">Name<input id="rfName" value="${_intelEsc(r.name || '')}"></label>
      <label class="intel-rf">Watchlist pilots
        <span class="intel-rf-hint">comma separated — known hot-droppers, cyno alts</span>
        <input id="rfPilots" value="${_intelEsc(csv(m.pilots))}" placeholder="Parsiska Ostus, Wolf Eyes"></label>
      <label class="intel-rf">Ships <span class="intel-rf-hint">hull names</span>
        <input id="rfShips" value="${_intelEsc(csv(m.ships))}" placeholder="Sabre, Devoter, Rorqual"></label>
      <label class="intel-rf">Roles
        <span class="intel-rf-choices">${_INTEL_ROLE_CHOICES.map(c => `
          <label class="intel-rf-chk"><input type="checkbox" data-role="${c}"
            ${(m.roles || []).includes(c) ? 'checked' : ''}> ${c}</label>`).join('')}</span></label>
      <div class="intel-rf-row">
        <label class="intel-rf">Gang of at least
          <input id="rfSize" type="number" min="1" max="500" value="${m.minSize ?? ''}" placeholder="any"></label>
        <label class="intel-rf">Standing at or below
          <input id="rfStanding" type="number" min="-10" max="10" step="1" value="${m.maxStanding ?? ''}" placeholder="any"></label>
      </div>
      <div class="intel-rf-row">
        <label class="intel-rf">From <input id="rfMin" type="number" min="0" max="20" value="${w.minJumps ?? 0}"> jumps</label>
        <label class="intel-rf">To <input id="rfMax" type="number" min="0" max="20" value="${w.maxJumps ?? 15}"> jumps</label>
        <label class="intel-rf">Quiet for <input id="rfQuiet" type="number" min="0" max="3600" value="${r.quietForS ?? 60}"> s</label>
      </div>
      <div class="intel-rf-row">
        <label class="intel-rf-chk"><input type="checkbox" id="rfInbound" ${m.inbound ? 'checked' : ''}> only when closing on us</label>
        <label class="intel-rf-chk"><input type="checkbox" id="rfCamp" ${m.camp ? 'checked' : ''}> bubbles / gate camp</label>
      </div>
      <div class="intel-rf-row">
        <label class="intel-rf-chk"><input type="checkbox" id="rfNotify" ${t.notify !== false ? 'checked' : ''}> notify</label>
        <label class="intel-rf-chk"><input type="checkbox" id="rfSound" ${t.sound ? 'checked' : ''}> play a sound</label>
        <label class="intel-rf-chk"><input type="checkbox" id="rfCrit" ${t.level === 'critical' ? 'checked' : ''}> treat as critical</label>
      </div>
      <div class="modal-actions">
        <button class="fc-track-btn fc-invite-btn" data-act="cancel">Cancel</button>
        <button class="fc-track-btn" data-act="ok">Done</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const asList = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  const asNum  = (v) => { const n = Number(v); return v === '' || !Number.isFinite(n) ? undefined : n; };

  modal.querySelector('[data-act="cancel"]').onclick = () => modal.remove();
  modal.querySelector('[data-act="ok"]').onclick = () => {
    const g = (id) => modal.querySelector('#' + id);
    r.name   = g('rfName').value.trim() || 'Alert';
    m.pilots = asList(g('rfPilots').value);
    m.ships  = asList(g('rfShips').value);
    m.roles  = [...modal.querySelectorAll('[data-role]:checked')].map(e => e.dataset.role);
    m.minSize     = asNum(g('rfSize').value);
    m.maxStanding = asNum(g('rfStanding').value);
    m.inbound = g('rfInbound').checked;
    m.camp    = g('rfCamp').checked;

    // DELETE rather than leave empty. An empty array still reads as "this
    // condition is set" to anything checking for presence, which would turn a
    // blank field into a rule that can never match.
    for (const k of ['pilots', 'ships', 'roles']) if (!m[k] || !m[k].length) delete m[k];
    for (const k of ['minSize', 'maxStanding']) if (m[k] === undefined) delete m[k];
    if (!m.inbound) delete m.inbound;
    if (!m.camp)    delete m.camp;

    w.minJumps  = asNum(g('rfMin').value) ?? 0;
    w.maxJumps  = asNum(g('rfMax').value) ?? 15;
    r.quietForS = asNum(g('rfQuiet').value) ?? 60;
    t.notify = g('rfNotify').checked;
    t.sound  = g('rfSound').checked;
    t.level  = g('rfCrit').checked ? 'critical' : 'warning';

    modal.remove();
    if (typeof onDone === 'function') onDone();
  };
}
