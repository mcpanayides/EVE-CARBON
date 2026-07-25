// ─── Skills / skill planner ───────────────────────────────────────────────────
// A multi-character skill planner. A plan is deliberately character-agnostic —
// just an ordered list of { skillId, level } — so the same plan can be costed
// against every character you own and compared side by side ("who trains this
// fastest?"). Plans persist in localStorage, like the shopping lists.
//
// The left rail mirrors the in-game Skills window: skills grouped by their SDE
// group (Gunnery, Spaceship Command, …), expandable, showing your current level.
// The search box also matches ships/modules, so you can plan by goal — "I want
// to fly a Rifter" — and it pulls in every skill that hull requires.
//
// Runs entirely on scopes the app already has (esi-skills.read_skills,
// read_skillqueue, esi-clones.read_implants) — no re-authentication needed.
//
// NOTE: ESI's skill queue is READ-ONLY (POST/PUT → 405), so no tool — EVEMon
// included — can push a plan into the in-game queue. Export therefore produces
// a copy-paste list you paste into the game yourself.
//
// Electron does not implement window.prompt(), so all naming/confirm flows use
// the in-app modal below rather than the browser primitives.

const SK_STORE = 'eveCarbon_skillPlans';

// Dogma attribute ids → the attribute block returned by ESI.
const SK_ATTR = { 164: 'charisma', 165: 'intelligence', 166: 'memory', 167: 'perception', 168: 'willpower' };
const SK_ATTR_KEYS = ['intelligence', 'memory', 'perception', 'willpower', 'charisma'];
const SK_ATTR_SHORT = { intelligence: 'INT', memory: 'MEM', perception: 'PER', willpower: 'WIL', charisma: 'CHA' };

// EVE remap rules: every attribute starts at 17 and you distribute 14 further
// points, at most +10 into any one attribute.
const SK_BASE_ATTR = 17, SK_FREE_POINTS = 14, SK_MAX_BONUS = 10;

let _skDefs      = { list: [], byId: {}, groups: [] };
let _skAccounts  = [];
let _skCharData  = {};
let _skPlans     = [];
let _skActiveId  = null;
let _skTab       = 'planner';
let _skEvalChars = new Set();
let _skLoaded    = false;
let _skOpenGroup = null;     // expanded group in the browser
let _skSearchHits = null;    // null = browsing groups, array = showing search results

// ─── Training maths ──────────────────────────────────────────────────────────
// Total SP to hold a level: 250 × rank × 2^(2.5(L−1)).
const _skSpForLevel = (rank, level) =>
  level <= 0 ? 0 : Math.round(250 * (rank || 1) * Math.pow(2, 2.5 * (level - 1)));

const _skSpPerMinAttrs = (attrs, def) => {
  const p = SK_ATTR[def.primaryAttr], s = SK_ATTR[def.secondaryAttr];
  if (!p || !s) return 0;
  return (attrs[p] || 0) + (attrs[s] || 0) / 2;
};
function _skSpPerMin(charId, def) {
  const cd = _skCharData[charId];
  return cd && def ? _skSpPerMinAttrs(cd.eff, def) : 0;
}

// Cost a plan for one character, simulating training in order so a skill listed
// twice (to 3, then to 5) only pays the difference the second time.
// `attrsOverride` lets the remap/implant tools re-cost against what-if attributes.
function _skCostPlan(entries, charId, attrsOverride) {
  const cd = _skCharData[charId];
  if (!cd) return null;
  const attrs = attrsOverride || cd.eff;
  const simulated = {};
  let totalMin = 0, totalSp = 0;
  const rows = [];
  for (const e of entries) {
    const def = _skDefs.byId[e.skillId];
    if (!def) continue;
    const have = simulated[e.skillId] !== undefined
      ? simulated[e.skillId]
      : (cd.skills[e.skillId]?.sp || 0);
    const target = _skSpForLevel(def.rank, e.level);
    const need   = Math.max(0, target - have);
    const perMin = _skSpPerMinAttrs(attrs, def);
    const mins   = perMin > 0 ? need / perMin : 0;
    simulated[e.skillId] = Math.max(have, target);
    totalMin += mins; totalSp += need;
    rows.push({ skillId: e.skillId, level: e.level, def, need, mins, done: need === 0 });
  }
  return { rows, totalMin, totalSp };
}

function _skFmtDuration(mins) {
  if (!isFinite(mins) || mins <= 0) return '—';
  const m = Math.round(mins);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

// The implant bonus currently in the character's head, per attribute — the
// difference between the effective and base attribute blocks.
function _skImplantBonus(charId) {
  const cd = _skCharData[charId];
  const out = {};
  SK_ATTR_KEYS.forEach(k => { out[k] = (cd?.eff?.[k] || 0) - (cd?.attributes?.[k] || 0); });
  return out;
}

// ─── Remap optimiser ─────────────────────────────────────────────────────────
// Brute-forces every legal attribute allocation (17..27 each, 14 points to
// spend) and returns the one that trains this plan fastest. ~161k combinations
// with a handful of attribute-pair buckets each, so it runs in well under a
// second and is exact rather than heuristic.
function _skOptimalRemap(entries, charId) {
  const cd = _skCharData[charId];
  if (!cd || !entries.length) return null;

  // Bucket the SP this plan needs by its (primary, secondary) attribute pair.
  const cost = _skCostPlan(entries, charId);
  const buckets = new Map();
  cost.rows.forEach(r => {
    if (r.need <= 0) return;
    const p = SK_ATTR[r.def.primaryAttr], s = SK_ATTR[r.def.secondaryAttr];
    if (!p || !s) return;
    const key = `${p}|${s}`;
    buckets.set(key, (buckets.get(key) || 0) + r.need);
  });
  if (!buckets.size) return null;
  const pairs = [...buckets.entries()].map(([k, sp]) => {
    const [p, s] = k.split('|');
    return { p, s, sp };
  });

  const imp = _skImplantBonus(charId);
  const timeFor = (alloc) => {
    let t = 0;
    for (const { p, s, sp } of pairs) {
      const rate = (SK_BASE_ATTR + alloc[p] + imp[p]) + (SK_BASE_ATTR + alloc[s] + imp[s]) / 2;
      if (rate <= 0) return Infinity;
      t += sp / rate;
    }
    return t;
  };

  let best = null;
  const [A, B, C, D, E] = SK_ATTR_KEYS;
  for (let a = 0; a <= SK_MAX_BONUS; a++)
  for (let b = 0; a + b <= SK_FREE_POINTS && b <= SK_MAX_BONUS; b++)
  for (let c = 0; a + b + c <= SK_FREE_POINTS && c <= SK_MAX_BONUS; c++)
  for (let d = 0; a + b + c + d <= SK_FREE_POINTS && d <= SK_MAX_BONUS; d++) {
    const e = SK_FREE_POINTS - a - b - c - d;
    if (e < 0 || e > SK_MAX_BONUS) continue;
    const alloc = { [A]: a, [B]: b, [C]: c, [D]: d, [E]: e };
    const t = timeFor(alloc);
    if (!best || t < best.time) best = { time: t, alloc };
  }
  if (!best) return null;

  const attrs = {};
  SK_ATTR_KEYS.forEach(k => { attrs[k] = SK_BASE_ATTR + best.alloc[k] + imp[k]; });
  return {
    alloc: best.alloc,                                   // points spent above base
    base:  Object.fromEntries(SK_ATTR_KEYS.map(k => [k, SK_BASE_ATTR + best.alloc[k]])),
    attrs,                                               // incl. current implants
    optimalMin: best.time,
    currentMin: cost.totalMin,
    savedMin:   Math.max(0, cost.totalMin - best.time),
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────
function _skLoadPlans() {
  try { _skPlans = JSON.parse(localStorage.getItem(SK_STORE) || '[]'); }
  catch (_) { _skPlans = []; }
  if (!Array.isArray(_skPlans)) _skPlans = [];
}
function _skSavePlans() {
  try { localStorage.setItem(SK_STORE, JSON.stringify(_skPlans)); }
  catch (_) { showToast('Could not save skill plans (storage full?).', 'error'); }
}
const _skActive = () => _skPlans.find(p => p.id === _skActiveId) || null;

function _skNewPlan(name = 'New plan', entries = []) {
  const p = { id: `p${Date.now()}${Math.floor(Math.random() * 1000)}`, name, createdAt: Date.now(), entries };
  _skPlans.push(p); _skActiveId = p.id; _skSavePlans();
  return p;
}

// ─── Modal (Electron has no window.prompt) ───────────────────────────────────
function _skModal(title, bodyHtml, { okLabel = 'OK', showOk = true } = {}) {
  return new Promise(resolve => {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop sk-modal-backdrop';
    bd.innerHTML = `
      <div class="sk-modal">
        <div class="sk-modal-head">${escHtml(title)}</div>
        <div class="sk-modal-body">${bodyHtml}</div>
        <div class="sk-modal-actions">
          <button class="sk-btn" data-sk-cancel>Close</button>
          ${showOk ? `<button class="sk-btn primary" data-sk-ok>${escHtml(okLabel)}</button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(bd);
    bd.style.display = 'flex';
    const done = (v) => { bd.remove(); resolve(v); };
    bd.querySelector('[data-sk-cancel]').onclick = () => done(null);
    const ok = bd.querySelector('[data-sk-ok]');
    if (ok) ok.onclick = () => done(bd.querySelector('.sk-modal-input')?.value ?? true);
    bd.onclick = (e) => { if (e.target === bd) done(null); };
    const input = bd.querySelector('.sk-modal-input');
    if (input) {
      input.focus(); input.select();
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } };
    }
  });
}

const _skAskName = (title, value = '') =>
  _skModal(title, `<input class="sk-modal-input field-input" value="${escHtml(value)}" placeholder="Plan name"/>`, { okLabel: 'Save' });

// ─── Entry point ─────────────────────────────────────────────────────────────
async function initSkillsPage() {
  _skLoadPlans();
  _skBindSubnav();

  _skAccounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!Array.isArray(_skAccounts) || !_skAccounts.length) {
    _skRender('<div class="sk-empty">Add a character on the Characters page to plan skills.</div>');
    return;
  }

  if (!_skLoaded) {
    _skRender('<div class="sk-empty">Loading skill data…</div>');
    const defs = await window.eveAPI.sdeGetSkills().catch(() => []);
    _skDefs.list = defs || [];
    _skDefs.byId = Object.fromEntries(_skDefs.list.map(d => [d.id, d]));
    const g = {};
    _skDefs.list.forEach(d => { (g[d.group] = g[d.group] || []).push(d); });
    _skDefs.groups = Object.keys(g).sort().map(name => ({ name, skills: g[name].sort((a, b) => a.name.localeCompare(b.name)) }));
    await Promise.all(_skAccounts.map(a => _skLoadChar(a.characterId)));
    _skLoaded = true;
  }

  if (!_skEvalChars.size) Object.keys(_skCharData).forEach(id => { if (_skCharData[id]) _skEvalChars.add(Number(id)); });
  if (!_skActiveId && _skPlans.length) _skActiveId = _skPlans[0].id;
  _skRenderTab();
}

async function _skLoadChar(characterId) {
  const res = await window.eveAPI.skillsGetCharacter(characterId).catch(e => ({ ok: false, error: e.message }));
  if (!res.ok) { _skCharData[characterId] = null; return; }
  const eff = { ...res.attributes };
  if (res.implants && res.implants.length) {
    try {
      const bonuses = await window.eveAPI.sdeImplantAttrs(res.implants);
      Object.values(bonuses || {}).forEach(b => {
        Object.entries(b).forEach(([k, v]) => { eff[k] = (eff[k] || 0) + (Number(v) || 0); });
      });
    } catch (_) { /* base attributes still give a usable estimate */ }
  }
  _skCharData[characterId] = { ...res, eff };
}

const _skCharName = (id) => {
  const a = _skAccounts.find(x => Number(x.characterId) === Number(id));
  return a ? a.characterName : `ID ${id}`;
};
// The character whose "current level" the browser shows — first one compared.
const _skRefChar = () => [..._skEvalChars].find(id => _skCharData[id]) ?? null;

// ─── Chrome ──────────────────────────────────────────────────────────────────
function _skBindSubnav() {
  document.querySelectorAll('.skills-sub-btn').forEach(b => {
    b.onclick = () => {
      _skTab = b.dataset.skillsTab;
      document.querySelectorAll('.skills-sub-btn').forEach(x => x.classList.toggle('active', x === b));
      _skRenderTab();
    };
  });
}
function _skRender(html) {
  const host = document.getElementById('skillsTabContent');
  if (host) host.innerHTML = html;
}
function _skRenderTab() {
  if (_skTab === 'plans') _skRenderPlansTab();
  else _skRenderPlannerTab();
}

// ─── Planner ─────────────────────────────────────────────────────────────────
function _skRenderPlannerTab() {
  const plan = _skActive();
  _skRender(`
    <div class="sk-planner">
      <div class="sk-bar">
        <select id="skPlanSelect" class="field-input">
          ${_skPlans.map(p => `<option value="${p.id}"${p.id === _skActiveId ? ' selected' : ''}>${escHtml(p.name)}</option>`).join('')
            || '<option value="">— no plans yet —</option>'}
        </select>
        <button class="sk-btn primary" id="skNewPlanBtn">+ New plan</button>
        <button class="sk-btn" id="skRenameBtn">Rename</button>
        <button class="sk-btn" id="skDupBtn">Duplicate</button>
        <button class="sk-btn danger" id="skDeleteBtn">Delete</button>
        <span class="sk-spacer"></span>
        <select id="skImportChar" class="field-input" title="Copy a character's current training queue into a new plan">
          <option value="">Import queue from…</option>
          ${_skAccounts.map(a => `<option value="${a.characterId}">${escHtml(a.characterName)}</option>`).join('')}
        </select>
        <button class="sk-btn" id="skExportBtn">Export / copy list</button>
      </div>

      ${!plan ? `
        <div class="sk-firstrun">
          <h3>Build a skill plan</h3>
          <p>A plan is a list of skills and target levels. It isn't tied to one character —
             once you've built it you can cost it against <b>every</b> character you own and
             see who trains it fastest.</p>
          <p>Hit <b>+ New plan</b> to start, then either browse the skill groups on the left,
             or search for a ship (e.g. <i>Rifter</i>) to pull in everything needed to fly it.</p>
        </div>` : `
        <div class="sk-body">
          <div class="sk-browser">
            <input id="skSearch" class="field-input" autocomplete="off"
                   placeholder="Search a skill, or a ship you want to fly…"/>
            <div class="sk-browser-hint" id="skBrowserHint">Browse a group, or search for a ship to add its requirements.</div>
            <div id="skBrowseList" class="sk-browse-list"></div>
          </div>

          <div class="sk-plan">
            <div class="sk-eval">
              <span class="sk-eval-label">Compare</span>
              ${_skAccounts.map(a => {
                const ok = !!_skCharData[a.characterId];
                return `<label class="sk-chip${ok ? '' : ' disabled'}" title="${ok ? '' : 'Skill data unavailable — this character may need re-authenticating'}">
                  <input type="checkbox" data-evalchar="${a.characterId}" ${_skEvalChars.has(Number(a.characterId)) ? 'checked' : ''} ${ok ? '' : 'disabled'}/>
                  ${escHtml(a.characterName)}</label>`;
              }).join('')}
            </div>
            <div id="skTotals" class="sk-totals"></div>
            <div id="skOptimise" class="sk-optimise"></div>
            <div id="skEntries" class="sk-entries"></div>
          </div>
        </div>`}
    </div>`);

  _skBindPlannerControls();
  if (plan) { _skRenderBrowser(); _skRenderTotals(); _skRenderOptimise(); _skRenderEntries(); }
}

function _skBindPlannerControls() {
  const sel = document.getElementById('skPlanSelect');
  if (sel) sel.onchange = () => { _skActiveId = sel.value; _skRenderPlannerTab(); };

  const nb = document.getElementById('skNewPlanBtn');
  if (nb) nb.onclick = async () => {
    const name = await _skAskName('New skill plan', `Plan ${_skPlans.length + 1}`);
    if (name === null) return;
    _skNewPlan(String(name).trim() || `Plan ${_skPlans.length + 1}`);
    _skRenderPlannerTab();
  };

  const rn = document.getElementById('skRenameBtn');
  if (rn) rn.onclick = async () => {
    const p = _skActive(); if (!p) return;
    const name = await _skAskName('Rename plan', p.name);
    if (name === null) return;
    p.name = String(name).trim() || p.name; _skSavePlans(); _skRenderPlannerTab();
  };

  const dp = document.getElementById('skDupBtn');
  if (dp) dp.onclick = () => { const p = _skActive(); if (!p) return;
    _skNewPlan(`${p.name} (copy)`, p.entries.map(e => ({ ...e }))); _skRenderPlannerTab(); };

  const del = document.getElementById('skDeleteBtn');
  if (del) del.onclick = () => {
    const p = _skActive(); if (!p) return;
    if (!confirm(`Delete the plan "${p.name}"? This cannot be undone.`)) return;
    _skPlans = _skPlans.filter(x => x.id !== p.id);
    _skActiveId = _skPlans.length ? _skPlans[0].id : null;
    _skSavePlans(); _skRenderPlannerTab();
  };

  const imp = document.getElementById('skImportChar');
  if (imp) imp.onchange = () => { if (imp.value) { _skImportQueue(Number(imp.value)); imp.value = ''; } };

  const exp = document.getElementById('skExportBtn');
  if (exp) exp.onclick = () => _skExportModal();

  document.querySelectorAll('[data-evalchar]').forEach(cb => {
    cb.onchange = () => {
      const id = Number(cb.dataset.evalchar);
      if (cb.checked) _skEvalChars.add(id); else _skEvalChars.delete(id);
      _skRenderTotals(); _skRenderOptimise(); _skRenderEntries(); _skRenderBrowser();
    };
  });

  const search = document.getElementById('skSearch');
  if (search) {
    let t = null;
    search.oninput = () => { clearTimeout(t); t = setTimeout(() => _skDoSearch(search.value), 180); };
  }
}

// ─── Skill browser (in-game style) ───────────────────────────────────────────
// Groups collapsed by default, exactly like the in-game Skills window; each row
// shows your current level as filled pips plus I–V buttons to add at a level.
function _skRenderBrowser() {
  const host = document.getElementById('skBrowseList');
  const hint = document.getElementById('skBrowserHint');
  if (!host) return;

  if (_skSearchHits) {
    hint.textContent = `${_skSearchHits.skills.length} skill(s), ${_skSearchHits.types.length} ship/item match(es)`;
    host.innerHTML =
      (_skSearchHits.types.length ? `<div class="sk-browse-section">SHIPS &amp; ITEMS — adds everything needed to use it</div>` : '')
      + _skSearchHits.types.map(t => `
          <button class="sk-type-row" data-type="${t.id}">
            <img src="https://images.evetech.net/types/${t.id}/icon?size=32" alt="" loading="lazy" onerror="this.style.display='none'"/>
            <span>${escHtml(t.name)}</span><span class="sk-dim">add required skills</span>
          </button>`).join('')
      + (_skSearchHits.skills.length ? `<div class="sk-browse-section">SKILLS</div>` : '')
      + _skSearchHits.skills.map(d => _skSkillRow(d)).join('')
      + (!_skSearchHits.skills.length && !_skSearchHits.types.length
          ? '<div class="sk-empty">Nothing matched that search.</div>' : '');
  } else {
    hint.textContent = 'Browse a group, or search for a ship to add its requirements.';
    host.innerHTML = _skDefs.groups.map(g => `
      <div class="sk-group">
        <button class="sk-group-head${_skOpenGroup === g.name ? ' open' : ''}" data-group="${escHtml(g.name)}">
          <span class="sk-group-caret">${_skOpenGroup === g.name ? '▾' : '▸'}</span>
          <span>${escHtml(g.name)}</span>
          <span class="sk-dim">${g.skills.length}</span>
        </button>
        ${_skOpenGroup === g.name ? `<div class="sk-group-body">${g.skills.map(d => _skSkillRow(d)).join('')}</div>` : ''}
      </div>`).join('');
  }
  _skBindBrowserRows();
}

// One skill row: name, rank, your current level as pips, and I–V add buttons.
function _skSkillRow(d) {
  const ref = _skRefChar();
  const lvl = ref ? (_skCharData[ref].skills[d.id]?.level || 0) : 0;
  const pips = [1, 2, 3, 4, 5].map(n => `<i class="sk-pip${n <= lvl ? ' on' : ''}"></i>`).join('');
  return `
    <div class="sk-skill-row">
      <div class="sk-skill-main">
        <span class="sk-skill-name">${escHtml(d.name)}</span>
        <span class="sk-skill-meta"><span class="sk-pips">${pips}</span><span class="sk-dim">rank ${d.rank}</span></span>
      </div>
      <div class="sk-lvl-btns">
        ${[1, 2, 3, 4, 5].map(n => `<button class="sk-lvl${n <= lvl ? ' has' : ''}" data-add="${d.id}" data-lvl="${n}"
             title="Add ${escHtml(d.name)} to level ${n}">${n}</button>`).join('')}
      </div>
    </div>`;
}

function _skBindBrowserRows() {
  document.querySelectorAll('[data-group]').forEach(b => b.onclick = () => {
    _skOpenGroup = _skOpenGroup === b.dataset.group ? null : b.dataset.group;
    _skRenderBrowser();
  });
  document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    _skAddSkill(Number(b.dataset.add), Number(b.dataset.lvl), true);
  });
  document.querySelectorAll('[data-type]').forEach(b => b.onclick = () => _skAddTypeRequirements(Number(b.dataset.type)));
}

async function _skDoSearch(q) {
  const term = (q || '').trim();
  if (term.length < 2) { _skSearchHits = null; _skRenderBrowser(); return; }
  const lower = term.toLowerCase();
  const skills = _skDefs.list
    .filter(d => d.name.toLowerCase().includes(lower))
    .sort((a, b) => a.name.toLowerCase().indexOf(lower) - b.name.toLowerCase().indexOf(lower) || a.name.localeCompare(b.name))
    .slice(0, 40);
  // Ships/modules so you can plan toward a hull rather than guessing skill names.
  let types = [];
  try {
    const hits = await window.eveAPI.searchMarketTypes(term, 8);
    types = (hits || []).filter(t => !_skDefs.byId[t.id]).slice(0, 6);
  } catch (_) { /* skills-only search still works */ }
  _skSearchHits = { skills, types };
  _skRenderBrowser();
}

// ─── Adding to the plan ──────────────────────────────────────────────────────
function _skAddSkill(skillId, level, withPrereqs, quiet) {
  const plan = _skActive(); if (!plan) return 0;
  let added = 0;
  const visit = (id, lvl, seen) => {
    const def = _skDefs.byId[id];
    if (!def || seen.has(`${id}:${lvl}`)) return;
    seen.add(`${id}:${lvl}`);
    if (withPrereqs) def.prereqs.forEach(p => visit(p.id, p.level, seen));
    const existing = plan.entries.find(e => e.skillId === id);
    if (existing) { if (lvl > existing.level) { existing.level = lvl; added++; } return; }
    plan.entries.push({ skillId: id, level: lvl });
    added++;
  };
  visit(skillId, level, new Set());
  _skSavePlans();
  if (!quiet) {
    _skRenderTotals(); _skRenderOptimise(); _skRenderEntries();
    const d = _skDefs.byId[skillId];
    showToast(added ? `Added ${d ? d.name : 'skill'} ${'I'.repeat(0)}${level}${added > 1 ? ` (+${added - 1} prerequisites)` : ''}.`
                    : 'Already in this plan at that level or higher.', added ? 'success' : 'info');
  }
  return added;
}

// "I want to fly a Rifter" — pull in every skill the hull/module requires.
async function _skAddTypeRequirements(typeId) {
  const plan = _skActive(); if (!plan) return;
  const info = await window.eveAPI.sdeTypeRequirements(typeId).catch(() => null);
  if (!info || !info.requirements.length) {
    showToast('That item has no skill requirements in the SDE.', 'info');
    return;
  }
  let added = 0;
  info.requirements.forEach(r => { added += _skAddSkill(r.id, r.level, true, true); });
  _skRenderTotals(); _skRenderOptimise(); _skRenderEntries();
  showToast(added ? `Added ${added} skill(s) to fly/use ${info.name}.` : `${info.name}: all requirements already planned.`,
            added ? 'success' : 'info');
}

// ─── Totals / optimise / entries ─────────────────────────────────────────────
function _skRenderTotals() {
  const host = document.getElementById('skTotals');
  const plan = _skActive();
  if (!host || !plan) return;
  const chars = [..._skEvalChars].filter(id => _skCharData[id]);
  if (!chars.length) { host.innerHTML = '<div class="sk-empty">Tick a character above to see training times.</div>'; return; }
  const costs = chars.map(id => ({ id, cost: _skCostPlan(plan.entries, id) })).filter(c => c.cost);
  if (!costs.length) { host.innerHTML = ''; return; }
  const fastest = costs.reduce((a, b) => (a.cost.totalMin <= b.cost.totalMin ? a : b));
  host.innerHTML = costs.sort((a, b) => a.cost.totalMin - b.cost.totalMin).map(c => `
    <div class="sk-total${c.id === fastest.id && costs.length > 1 ? ' best' : ''}">
      <span class="sk-total-name">${escHtml(_skCharName(c.id))}${c.id === fastest.id && costs.length > 1 ? '<span class="sk-best-tag">FASTEST</span>' : ''}</span>
      <span class="sk-total-time">${_skFmtDuration(c.cost.totalMin)}</span>
      <span class="sk-total-sp">${formatNumber(Math.round(c.cost.totalSp))} SP</span>
    </div>`).join('');
}

// Remap + implant advice for the reference character — "how do I get there faster?"
function _skRenderOptimise() {
  const host = document.getElementById('skOptimise');
  const plan = _skActive();
  if (!host || !plan) return;
  const ref = _skRefChar();
  if (!ref || !plan.entries.length) { host.innerHTML = ''; return; }

  const remap = _skOptimalRemap(plan.entries, ref);
  const cd = _skCharData[ref];
  const base = cd.attributes;

  host.innerHTML = `
    <div class="sk-opt-head">Fastest route for <b>${escHtml(_skCharName(ref))}</b></div>
    <div class="sk-opt-grid">
      ${remap ? `
        <div class="sk-opt-card">
          <div class="sk-opt-title">Optimal remap</div>
          <div class="sk-opt-attrs">
            ${SK_ATTR_KEYS.map(k => {
              const now = base[k] || 0, want = remap.base[k];
              const diff = want - now;
              return `<div class="sk-opt-attr${diff ? (diff > 0 ? ' up' : ' down') : ''}">
                <span>${SK_ATTR_SHORT[k]}</span><b>${want}</b>
                <i>${diff > 0 ? '+' + diff : (diff || '')}</i></div>`;
            }).join('')}
          </div>
          <div class="sk-opt-gain">${remap.savedMin > 1
            ? `Saves <b>${_skFmtDuration(remap.savedMin)}</b> (${_skFmtDuration(remap.optimalMin)} vs ${_skFmtDuration(remap.currentMin)})`
            : 'Your current attributes are already optimal for this plan.'}</div>
          ${cd.attributes.bonusRemaps != null ? `<div class="sk-opt-note">${cd.attributes.bonusRemaps} bonus remap(s) available</div>` : ''}
        </div>` : ''}
      <div class="sk-opt-card sk-boosters" id="skBoosters">
        <div class="sk-opt-title">Boosters &amp; accelerators</div>
        <div class="sk-dim">Pricing options at Jita…</div>
      </div>
    </div>`;

  _skRenderBoosters(ref, plan);   // async — fills #skBoosters once Jita prices load
}

// ─── Booster / accelerator cost optimiser ────────────────────────────────────
// For the active plan + reference character, prices out the ways of training
// faster and ranks them by both value (ISK per day saved) and raw speed:
//   • learning implants — a permanent one-time cost (+N to all five attributes)
//   • cerebral accelerators — temporary, so a long plan needs several
//     (units = ceil(plan time ÷ duration)); +N to all five while active
//   • the two stacked — the "money-no-object" fastest option
// All prices are Jita sell; anything with no market price is dropped, which
// removes the non-tradeable Serenity/expired/event boosters automatically.
let _skBoosters = null;

async function _skLoadBoosters() {
  if (_skBoosters) return _skBoosters;
  const data = await window.eveAPI.sdeAttributeBoosters().catch(() => ({ implants: [], accelerators: [] }));
  const ids = [...(data.implants || []).map(i => i.id), ...(data.accelerators || []).map(a => a.id)];
  const prices = ids.length ? await window.eveAPI.getJitaPrices(ids).catch(() => ({})) : {};
  const priceOf = (id) => Number((prices[id] || prices[String(id)] || {}).sell) || 0;

  // Cheapest priced learning implant for each attribute+bonus.
  const impByKey = {};
  (data.implants || []).forEach(i => {
    const p = priceOf(i.id);
    if (!p) return;
    const k = `${i.attr}:${i.bonus}`;
    if (!impByKey[k] || p < impByKey[k].price) impByKey[k] = { ...i, price: p };
  });
  // Cheapest priced accelerator per bonus tier.
  const accByBonus = {};
  (data.accelerators || []).forEach(a => {
    const p = priceOf(a.id);
    if (!p) return;
    if (!accByBonus[a.bonus] || p < accByBonus[a.bonus].price) accByBonus[a.bonus] = { ...a, price: p };
  });
  _skBoosters = { impByKey, accelerators: Object.values(accByBonus).sort((x, y) => x.bonus - y.bonus) };
  return _skBoosters;
}

// Cost of a full +N learning-implant set (all five attributes). complete=false
// if the market is missing an implant for some attribute at that tier.
function _skImplantSetCost(N) {
  let cost = 0;
  for (const attr of SK_ATTR_KEYS) {
    const e = _skBoosters.impByKey[`${attr}:${N}`];
    if (!e) return { cost: 0, complete: false };
    cost += e.price;
  }
  return { cost, complete: true };
}

async function _skRenderBoosters(charId, plan) {
  const host = document.getElementById('skBoosters');
  if (!host) return;
  await _skLoadBoosters();
  if (!document.getElementById('skBoosters')) return;   // navigated away while pricing

  const base = _skCharData[charId].attributes;
  const timeAt = (bonus) => {
    const attrs = {}; SK_ATTR_KEYS.forEach(k => { attrs[k] = (base[k] || 0) + bonus; });
    const c = _skCostPlan(plan.entries, charId, attrs);
    return c ? c.totalMin : 0;
  };
  const baseline = timeAt(0);

  // Accelerator scenario: how many to cover the (boosted) plan, and total cost.
  const accScenario = (acc, implantBonus = 0, implantCost = 0, label = null) => {
    const bonus = implantBonus + acc.bonus;
    const min = timeAt(bonus);
    const units = Math.max(1, Math.ceil((min / 60) / acc.durationHours));
    return {
      label: label || `${_skAccShort(acc.name)} ×${units}`,
      detail: `+${bonus} · ${units} × ${acc.durationHours}h accelerator${implantBonus ? ' + implants' : ''}`,
      bonus, min, cost: implantCost + units * acc.price, kind: 'mixed',
    };
  };

  const scen = [{ label: 'No boosters', detail: 'Current attributes', bonus: 0, min: baseline, cost: 0 }];

  // Learning-implant sets (+3 cheap, +5 standard).
  [3, 5].forEach(N => {
    const s = _skImplantSetCost(N);
    if (s.complete) scen.push({ label: `+${N} learning implants`, detail: 'Permanent · one-time cost', bonus: N, min: timeAt(N), cost: s.cost, kind: 'implant' });
  });

  const acc = _skBoosters.accelerators;
  const set5 = _skImplantSetCost(5);
  if (acc.length) {
    // A mid-tier accelerator alone (value), and the strongest (speed).
    const strongest = acc[acc.length - 1];
    const midValue = acc.find(a => a.bonus >= 6) || strongest;
    scen.push(accScenario(midValue, 0, 0));
    if (set5.complete) scen.push(accScenario(strongest, 5, set5.cost, `+5 implants + ${_skAccShort(strongest.name)}`));
  }

  // Rank: fastest = least time; best value = most days saved per ISK spent.
  const fastest = scen.reduce((a, b) => (b.min < a.min ? b : a));
  const paid = scen.filter(s => s.cost > 0 && baseline - s.min > 0);
  const bestValue = paid.length
    ? paid.reduce((a, b) => (((baseline - b.min) / b.cost) > ((baseline - a.min) / a.cost) ? b : a))
    : null;

  host.innerHTML = `
    <div class="sk-opt-title">Boosters &amp; accelerators</div>
    <table class="sk-boost-table">
      <thead><tr><th>Option</th><th class="sk-num">Time</th><th class="sk-num">Saves</th><th class="sk-num">Cost</th></tr></thead>
      <tbody>
        ${scen.sort((a, b) => b.min - a.min).map(s => {
          const saved = baseline - s.min;
          const tag = s === fastest && s.cost > 0 ? '<span class="sk-boost-tag fast">FASTEST</span>'
                    : (bestValue && s === bestValue) ? '<span class="sk-boost-tag value">BEST VALUE</span>' : '';
          return `<tr class="${s === fastest && s.cost > 0 ? 'is-fast' : ''}${bestValue && s === bestValue ? ' is-value' : ''}">
            <td><div class="sk-boost-name">${escHtml(s.label)}${tag}</div><div class="sk-dim">${escHtml(s.detail)}</div></td>
            <td class="sk-num">${_skFmtDuration(s.min)}</td>
            <td class="sk-num sk-done">${saved > 1 ? _skFmtDuration(saved) : '—'}</td>
            <td class="sk-num">${s.cost > 0 ? formatISK(s.cost) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div class="sk-opt-note">Jita sell prices. Accelerator counts assume back-to-back use for the whole plan; learning implants are a one-off (until pod loss).</div>`;
}

// "Expert 'Boost' Cerebral Accelerator" → "Expert 'Boost'" for a compact label.
const _skAccShort = (name) => String(name || '').replace(/\s*Cerebral Accelerator\s*/i, '').trim() || name;

function _skRenderEntries() {
  const host = document.getElementById('skEntries');
  const plan = _skActive();
  if (!host || !plan) return;
  if (!plan.entries.length) {
    host.innerHTML = `<div class="sk-empty">
      This plan is empty.<br><br>
      Pick a group on the left and hit <b>1–5</b> next to a skill, or search for a ship
      to add everything you need to fly it. Prerequisites are added automatically.</div>`;
    return;
  }
  const chars = [..._skEvalChars].filter(id => _skCharData[id]);
  const perChar = chars.map(id => ({ id, cost: _skCostPlan(plan.entries, id) })).filter(c => c.cost);

  host.innerHTML = `
    <table class="sk-table">
      <thead><tr>
        <th style="width:34px;">#</th><th>Skill</th><th class="sk-num">Lvl</th><th class="sk-num">SP</th>
        ${perChar.map(c => `<th class="sk-num">${escHtml(_skCharName(c.id))}</th>`).join('')}
        <th style="width:64px;"></th>
      </tr></thead>
      <tbody>
        ${plan.entries.map((e, i) => {
          const def = _skDefs.byId[e.skillId];
          const base = perChar[0] ? perChar[0].cost.rows[i] : null;
          return `<tr>
            <td class="sk-dim sk-num">${i + 1}</td>
            <td>${escHtml(def ? def.name : `Skill ${e.skillId}`)}<span class="sk-dim"> · rank ${def ? def.rank : '?'}</span></td>
            <td class="sk-num">${e.level}</td>
            <td class="sk-num sk-dim">${base ? formatNumber(Math.round(base.need)) : '—'}</td>
            ${perChar.map(c => { const r = c.cost.rows[i];
              return `<td class="sk-num${r && r.done ? ' sk-done' : ''}">${r ? (r.done ? '✓' : _skFmtDuration(r.mins)) : '—'}</td>`; }).join('')}
            <td class="sk-num">
              <button class="sk-mini" data-up="${i}" title="Move up">▲</button>
              <button class="sk-mini" data-del="${i}" title="Remove">✕</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    plan.entries.splice(Number(b.dataset.del), 1);
    _skSavePlans(); _skRenderTotals(); _skRenderOptimise(); _skRenderEntries();
  });
  host.querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.up); if (i <= 0) return;
    [plan.entries[i - 1], plan.entries[i]] = [plan.entries[i], plan.entries[i - 1]];
    _skSavePlans(); _skRenderTotals(); _skRenderEntries();
  });
}

// ─── Import / export ─────────────────────────────────────────────────────────
function _skImportQueue(charId) {
  const cd = _skCharData[charId];
  if (!cd || !cd.queue || !cd.queue.length) { showToast('That character has nothing in its training queue.', 'error'); return; }
  const entries = cd.queue.slice().sort((a, b) => (a.position || 0) - (b.position || 0))
    .map(q => ({ skillId: q.skillId, level: q.finishedLevel }))
    .filter(e => _skDefs.byId[e.skillId]);
  if (!entries.length) { showToast('Could not resolve that queue against the SDE.', 'error'); return; }
  _skNewPlan(`${_skCharName(charId)}'s queue`, entries);
  _skRenderPlannerTab();
  showToast(`Imported ${entries.length} skills from the queue.`, 'success');
}

function _skExportText(plan, fmt) {
  if (fmt === 'emp') {
    return '<?xml version="1.0" encoding="utf-8"?>\n<plan name="' + _skXml(plan.name) + '" revision="1">\n'
      + plan.entries.map(e => {
          const d = _skDefs.byId[e.skillId];
          return `  <entry skillID="${e.skillId}" skill="${_skXml(d ? d.name : '')}" level="${e.level}" priority="3" type="Planned" />`;
        }).join('\n') + '\n</plan>';
  }
  if (fmt === 'text') {
    return plan.entries.map(e => { const d = _skDefs.byId[e.skillId]; return `${d ? d.name : e.skillId} ${e.level}`; }).join('\n');
  }
  // Multibuy: one skillbook per line, deduped — you only ever buy one copy.
  const seen = new Set();
  return plan.entries.map(e => {
    if (seen.has(e.skillId)) return null;
    seen.add(e.skillId);
    const d = _skDefs.byId[e.skillId];
    return d ? d.name : null;
  }).filter(Boolean).join('\n');
}

// Shows the list rather than silently copying, so it's obvious what you're
// pasting into the game.
async function _skExportModal() {
  const plan = _skActive();
  if (!plan || !plan.entries.length) { showToast('Nothing to export — the plan is empty.', 'error'); return; }
  // _skModal builds its DOM synchronously, so the fields exist as soon as it
  // returns its promise — fill in the default (multibuy) view straight away
  // rather than leaving an empty box until a format button is pressed.
  const closed = _skModal(`Export “${plan.name}”`, `
    <div class="sk-exp-tabs">
      <button class="sk-btn primary" data-fmt="multibuy">Multibuy list</button>
      <button class="sk-btn" data-fmt="text">Plain text</button>
      <button class="sk-btn" data-fmt="emp">EVEMon .emp</button>
    </div>
    <div class="sk-exp-hint" id="skExpHint">Paste into the in-game Multibuy window to buy every skillbook in this plan.</div>
    <textarea class="sk-exp-text" id="skExpText" readonly spellcheck="false"></textarea>
    <button class="sk-btn primary" id="skExpCopy" style="align-self:flex-start;">Copy to clipboard</button>
  `, { showOk: false });
  const box = document.getElementById('skExpText');
  if (box) box.value = _skExportText(plan, 'multibuy');
  await closed;
}

const _skXml = (s) => String(s || '').replace(/[<>&"']/g, c => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// ─── My Plans ────────────────────────────────────────────────────────────────
function _skRenderPlansTab() {
  if (!_skPlans.length) {
    _skRender(`<div class="sk-firstrun">
      <h3>No saved plans yet</h3>
      <p>This tab is the comparison view: every plan you've saved, costed against every
         character, so you can see at a glance who should train what.</p>
      <p>Go to <b>Planner</b> and hit <b>+ New plan</b> to create your first one.</p>
    </div>`);
    return;
  }
  const chars = _skAccounts.map(a => Number(a.characterId)).filter(id => _skCharData[id]);
  _skRender(`
    <div class="sk-plans">
      <div class="sk-plans-intro">Every saved plan costed against every character. The
        fastest character for each plan is highlighted. Click <b>Open</b> to edit a plan in the Planner.</div>
      <table class="sk-table">
        <thead><tr>
          <th>Plan</th><th class="sk-num">Skills</th>
          ${chars.map(id => `<th class="sk-num">${escHtml(_skCharName(id))}</th>`).join('')}
          <th style="width:160px;"></th>
        </tr></thead>
        <tbody>
          ${_skPlans.map(p => {
            const costs = chars.map(id => ({ id, cost: _skCostPlan(p.entries, id) }));
            const valid = costs.filter(c => c.cost);
            const best = valid.length > 1 ? valid.reduce((a, b) => (a.cost.totalMin <= b.cost.totalMin ? a : b)) : null;
            return `<tr>
              <td><b>${escHtml(p.name)}</b></td>
              <td class="sk-num sk-dim">${p.entries.length}</td>
              ${costs.map(c => `<td class="sk-num${best && c.id === best.id ? ' sk-best' : ''}">${c.cost ? _skFmtDuration(c.cost.totalMin) : '—'}</td>`).join('')}
              <td class="sk-num">
                <button class="sk-mini wide" data-open="${p.id}">Open</button>
                <button class="sk-mini wide" data-delplan="${p.id}">Delete</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`);

  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    _skActiveId = b.dataset.open; _skTab = 'planner';
    document.querySelectorAll('.skills-sub-btn').forEach(x => x.classList.toggle('active', x.dataset.skillsTab === 'planner'));
    _skRenderTab();
  });
  document.querySelectorAll('[data-delplan]').forEach(b => b.onclick = () => {
    const p = _skPlans.find(x => x.id === b.dataset.delplan);
    if (!p || !confirm(`Delete the plan "${p.name}"?`)) return;
    _skPlans = _skPlans.filter(x => x.id !== p.id);
    if (_skActiveId === p.id) _skActiveId = _skPlans.length ? _skPlans[0].id : null;
    _skSavePlans(); _skRenderPlansTab();
  });
}

// Export modal is built by _skModal, so its controls are wired once it exists.
document.addEventListener('click', (ev) => {
  const fmtBtn = ev.target.closest('[data-fmt]');
  const box = document.getElementById('skExpText');
  if (fmtBtn && box) {
    const plan = _skActive(); if (!plan) return;
    document.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('primary', b === fmtBtn));
    box.value = _skExportText(plan, fmtBtn.dataset.fmt);
    const hint = document.getElementById('skExpHint');
    if (hint) hint.textContent = fmtBtn.dataset.fmt === 'multibuy'
      ? 'Paste into the in-game Multibuy window to buy every skillbook in this plan.'
      : fmtBtn.dataset.fmt === 'text'
        ? 'One skill and target level per line — readable, and accepted by most planners.'
        : 'EVEMon plan file. Save as .emp and import it in EVEMon.';
  }
  if (ev.target.id === 'skExpCopy' && box) {
    try { navigator.clipboard.writeText(box.value); showToast('Copied to clipboard.', 'success'); }
    catch (_) { box.select(); showToast('Press Ctrl+C to copy.', 'info'); }
  }
});
