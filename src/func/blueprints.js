// ─── Blueprint Library ────────────────────────────────────────────────────────
// Reads blueprint data from character_information.db (SQLite) via the
// 'get-all-blueprints-from-db' IPC handler.
// The View button queries SDE materials and applies the blueprint's real ME/TE.

// NOTE: allLibBPs, filterPerfectOnly, searchTimer, manualSearchTimer,
// currentIndustryTab, selectedBpTypeId, selectedME, selectedTE, and ESI_IMAGE
// are all declared in state.js which loads before this file. Do not re-declare them here.

// ─── Load & filter ────────────────────────────────────────────────────────────

let _bpLibLoading = false;

async function loadBlueprintLibrary() {
  _bpLibLoading = true;
  _renderBpLibLoadingState();   // show bar immediately if the tab is already open

  try {
    let bps = [];
    try {
      bps = await window.eveAPI.getAllBlueprintsFromDb();
    } catch (_) {
      bps = await window.eveAPI.getAllBlueprints();
    }

    allLibBPs = Array.isArray(bps) ? bps : [];
    allLibBPs.sort((a, b) => (a.type_name || a.name || '').localeCompare(b.type_name || b.name || ''));

    allLibBPs = allLibBPs.map(bp => ({
      ...bp,
      name:  bp.type_name || bp.name || `Type ${bp.type_id}`,
      me:    bp.me    ?? 0,
      te:    bp.te    ?? 0,
      runs:  bp.runs  ?? -1,
      isBPC: bp.is_bpc ? true : (bp.isBPC ?? (bp.quantity === -2)),
    }));

    renderBlueprintList(allLibBPs);
  } catch (err) {
    console.error('Failed to load blueprint library from DB:', err);
    showToast('Error loading blueprints from database.', 'error');
    _renderBpLibLoadingState(true);
  } finally {
    _bpLibLoading = false;
  }
}

function _renderBpLibLoadingState(isError = false) {
  const listDiv = document.getElementById('bpLibList');
  if (!listDiv) return;

  if (isError) {
    listDiv.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:48px 20px;
                  font-family:var(--mono);font-size:11px;color:var(--danger);">
        ⚠ FAILED TO LOAD BLUEPRINT LIBRARY
      </div>`;
    return;
  }

  // Build shimmer skeleton cards that match the real vertical .bp-card shape
  const card = () => `
    <div class="bp-skel-card" style="flex-direction:column;align-items:stretch;gap:12px;">
      <!-- pill row -->
      <div style="display:flex;gap:6px;">
        <div class="bp-skel-block" style="width:60px;height:16px;border-radius:999px;"></div>
        <div class="bp-skel-block" style="width:48px;height:16px;border-radius:999px;"></div>
      </div>
      <!-- head: thumb + title -->
      <div style="display:flex;align-items:center;gap:12px;">
        <div class="bp-skel-block" style="width:46px;height:46px;border-radius:14px;flex-shrink:0;"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0;">
          <div class="bp-skel-block" style="height:13px;width:75%;"></div>
          <div class="bp-skel-block" style="height:9px;width:45%;"></div>
        </div>
      </div>
      <!-- ME / TE bars -->
      <div style="display:flex;flex-direction:column;gap:7px;">
        <div class="bp-skel-block" style="height:10px;width:100%;border-radius:999px;"></div>
        <div class="bp-skel-block" style="height:10px;width:100%;border-radius:999px;"></div>
      </div>
      <!-- footer -->
      <div style="display:flex;align-items:center;gap:10px;border-top:1px solid var(--border);padding-top:11px;">
        <div class="bp-skel-block" style="width:26px;height:26px;border-radius:50%;"></div>
        <div class="bp-skel-block" style="height:10px;width:30%;"></div>
        <div class="bp-skel-block" style="width:64px;height:30px;border-radius:999px;margin-left:auto;"></div>
      </div>
    </div>`;

  // Fill the grid with 16 skeleton cards (enough to cover a typical screen)
  listDiv.innerHTML = Array.from({ length: 16 }, card).join('');
}

// Sort modes that need the (lazily computed) build-cost / product / category data
// for the *whole* filtered list before we can order it.
const _BP_ECON_SORTS = ['profit', 'margin', 'output', 'group'];

async function handleLibraryFilter() {
  const gen        = ++_bpFilterGen;
  const query      = (document.getElementById('bpLibSearch')?.value   || '').toLowerCase();
  const filterMode = document.getElementById('bpLibFilter')?.value    || 'all';
  const sortBy     = document.getElementById('bpLibSort')?.value      || 'name';
  const minME      = parseInt(document.getElementById('bpLibMinME')?.value)   || 0;
  const minTE      = parseInt(document.getElementById('bpLibMinTE')?.value)   || 0;
  const minRuns    = parseInt(document.getElementById('bpLibMinRuns')?.value) || 0;

  const filtered = allLibBPs.filter(bp => {
    const matchesName    = bp.name.toLowerCase().includes(query);
    const matchesType    = filterMode === 'all'
                        || (filterMode === 'bpo' && !bp.isBPC)
                        || (filterMode === 'bpc' &&  bp.isBPC);
    const matchesME      = bp.me >= minME;
    const matchesTE      = bp.te >= minTE;
    const matchesRuns    = !bp.isBPC || bp.runs >= minRuns;
    const matchesPerfect = !filterPerfectOnly || (bp.me === 10 && bp.te === 20);
    return matchesName && matchesType && matchesME && matchesTE && matchesRuns && matchesPerfect;
  });

  // Profit / margin / output / group need build-cost + category for everything.
  // Compute (batched + cached) before sorting; show the shimmer while we work.
  if (_BP_ECON_SORTS.includes(sortBy) && filtered.length) {
    const allCached = filtered.every(bp => _bpEconCache.has(_bpEconKey(bp.type_id, bp.me)));
    if (!allCached) {
      _renderBpLibLoadingState();
      await _bpEnsureEconForSort(filtered);
      if (gen !== _bpFilterGen) return;   // a newer filter superseded us
    }
  }

  renderBlueprintList(sortBlueprints(filtered, sortBy));
}

function togglePerfectFilter(value) {
  filterPerfectOnly = typeof value === 'boolean' ? value : !filterPerfectOnly;
  showToast(filterPerfectOnly ? 'Filtering: perfect blueprints only' : 'Showing all blueprints', 'info');
  handleLibraryFilter();
}

// me10 & te20 → 2 · one of them perfect → 1 · neither → 0
function _bpPerfectRank(bp) {
  return (bp.me === 10 ? 1 : 0) + (bp.te === 20 ? 1 : 0);
}

function sortBlueprints(bps, criteria) {
  const econ     = bp => _bpEconCache.get(_bpEconKey(bp.type_id, bp.me)) || {};
  const profitOf = bp => { const e = econ(bp); return (e.hasPrices && e.productValue > 0) ? (e.productValue - e.buildCost) : -Infinity; };
  const byName   = (a, b) => a.name.localeCompare(b.name);

  return [...bps].sort((a, b) => {
    switch (criteria) {
      case 'me':          return (b.me - a.me)                         || byName(a, b);
      case 'te':          return (b.te - a.te)                         || byName(a, b);
      case 'runs':        return ((b.runs || 0) - (a.runs || 0))       || byName(a, b);
      case 'perfect':     return (_bpPerfectRank(b) - _bpPerfectRank(a)) || byName(a, b);
      case 'me-perfect':  return ((b.me === 10) - (a.me === 10)) || (b.me - a.me) || byName(a, b);
      case 'te-perfect':  return ((b.te === 20) - (a.te === 20)) || (b.te - a.te) || byName(a, b);
      case 'profit':      return (profitOf(b) - profitOf(a))          || byName(a, b);
      case 'margin':      return ((econ(b).margin ?? -Infinity) - (econ(a).margin ?? -Infinity)) || byName(a, b);
      case 'output':      return ((econ(b).productValue || 0) - (econ(a).productValue || 0))      || byName(a, b);
      case 'group':       return (econ(a).category || '~').localeCompare(econ(b).category || '~')
                              || (econ(a).group    || '~').localeCompare(econ(b).group    || '~')
                              || byName(a, b);
      default:            return byName(a, b);
    }
  });
}

// ─── Render card list ─────────────────────────────────────────────────────────

// Module-level caches + observer for the lazy build-cost / category enrichment.
// Keyed by `${typeId}:${me}` so re-filters and re-renders reuse prior results
// instead of re-hitting the SDE and ESI markets.
const _bpEconCache    = new Map();   // key → computed econ result
const _bpMatCache     = new Map();   // key → { materials, productTypeId, productQty, baseTime } | null
let   _bpEconObserver = null;
let   _bpFilterGen    = 0;           // bumped each filter so stale async sorts bail out

// ═══ Industry calculator: facility / structure / character settings ═══════════
// These globally configure how build cost, time and ISK/hour are computed (the
// detail panel and the card grid both read them). Pure EVE math lives in
// window.IndustryMath (industry-math.js). Persisted to localStorage.
const IND_SETTINGS_KEY   = 'eve-carbon-industry-settings';
const IND_STRUCTURES_KEY = 'eve-carbon-industry-structures';
const IND_SHEET_URL_KEY  = 'eve-carbon-industry-sheet-url';

function _indDefaults() {
  return {
    facility: 'ec', secStatus: 'null', structureSize: 'L',
    matRig: 't2', timeRig: 't2', taxRate: 0,
    systemName: 'Jita', systemId: 30000142, buildCharId: null,
  };
}
function _indLoadSettings() {
  try { return Object.assign(_indDefaults(), JSON.parse(localStorage.getItem(IND_SETTINGS_KEY) || '{}')); }
  catch (_) { return _indDefaults(); }
}
function _indLoadStructures() {
  try { const a = JSON.parse(localStorage.getItem(IND_STRUCTURES_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

let _indSettings      = _indLoadSettings();
let _indStructures    = _indLoadStructures();
let _indSkills        = { industry: 5, advIndustry: 5 };  // for _indSettings.buildCharId
let _indSkillsCharId  = null;
let _indAdjustedPrices = null;                 // { typeId: adjustedPrice }
const _indCostIndexMap = new Map();            // systemId → manufacturing cost index

function _indSaveSettings()   { try { localStorage.setItem(IND_SETTINGS_KEY, JSON.stringify(_indSettings)); } catch (_) {} }
function _indSaveStructures() { try { localStorage.setItem(IND_STRUCTURES_KEY, JSON.stringify(_indStructures)); } catch (_) {} }

// Signature of everything that changes a computed cost/time, so the econ cache
// invalidates when the user changes facility / character / system.
function _indSig() {
  const s = _indSettings;
  return [s.facility, s.secStatus, s.structureSize, s.matRig, s.timeRig, s.taxRate,
          s.systemId, s.buildCharId, _indSkills.industry, _indSkills.advIndustry].join('|');
}
function _bpEconKey(typeId, me) { return `${typeId}:${me}:${_indSig()}`; }

// Build the IndustryMath modifier-params object for a blueprint's ME/TE.
function _indParams(me, te) {
  const s = _indSettings;
  return { me, te, facility: s.facility, secStatus: s.secStatus,
           structureSize: s.structureSize, matRig: s.matRig, timeRig: s.timeRig };
}

// Load the selected build character's industry skills (cached per char).
async function _indLoadSkills(charId) {
  if (!charId) { _indSkills = { industry: 5, advIndustry: 5 }; _indSkillsCharId = null; return _indSkills; }
  if (_indSkillsCharId === charId) return _indSkills;
  try {
    const lv = await window.eveAPI.getSkillLevels(charId,
      [window.IndustryMath.SKILL_INDUSTRY, window.IndustryMath.SKILL_ADV_INDUSTRY]);
    _indSkills = {
      industry:    lv?.[window.IndustryMath.SKILL_INDUSTRY]     ?? 5,
      advIndustry: lv?.[window.IndustryMath.SKILL_ADV_INDUSTRY] ?? 5,
    };
  } catch (_) { _indSkills = { industry: 5, advIndustry: 5 }; }
  _indSkillsCharId = charId;
  return _indSkills;
}

// ESI adjusted prices (for EIV / job-install fee). Fetched once, cached.
async function _indGetAdjustedPrices() {
  if (_indAdjustedPrices) return _indAdjustedPrices;
  try {
    const mp = await window.eveAPI.getMarketPrices();
    const out = {};
    if (mp) for (const [id, v] of Object.entries(mp)) out[id] = (v && v.adjusted) || 0;
    _indAdjustedPrices = out;
  } catch (_) { _indAdjustedPrices = {}; }
  return _indAdjustedPrices;
}

// Manufacturing cost index for a system (from the same ESI feed the Cost Index
// tool uses; reuses _ciAllSystems if that tab has already loaded it).
async function _indGetCostIndex(systemId) {
  if (!systemId) return 0;
  if (_indCostIndexMap.has(systemId)) return _indCostIndexMap.get(systemId);
  try {
    let systems = (typeof _ciAllSystems !== 'undefined' && _ciAllSystems) ? _ciAllSystems : null;
    if (!systems) {
      systems = await window.eveAPI.esiFetch('https://esi.evetech.net/latest/industry/systems/?datasource=tranquility');
    }
    (Array.isArray(systems) ? systems : []).forEach(s => {
      const mfg = (s.cost_indices || []).find(c => c.activity === 'manufacturing' || c.activity === 1);
      _indCostIndexMap.set(s.solar_system_id, mfg ? mfg.cost_index : 0);
    });
  } catch (_) {}
  return _indCostIndexMap.get(systemId) || 0;
}

// Resolve a typed system name → id + sec, reusing the Cost Index module's system
// map (populated when that tab loads; we kick a background load on first mount).
function _indResolveSystem(name) {
  if (typeof findCISystemByName === 'function') {
    const hit = findCISystemByName(name);
    if (hit && hit.id) {
      _indSettings.systemName = hit.name || name;
      _indSettings.systemId   = hit.id;
      if (hit.secStatus != null) _indSettings.secStatus = _indSecKeyFromStatus(hit.secStatus);
      return true;
    }
  }
  return false;
}
function _indSecKeyFromStatus(sec) {
  if (sec == null) return _indSettings.secStatus;
  if (sec >= 0.45) return 'high';
  if (sec > 0.0)   return 'low';
  return 'null';
}
let _indCiKicked = false;
function _indEnsureSystemData() {
  if (_indCiKicked) return;
  _indCiKicked = true;
  try { if (typeof loadCIData === 'function') loadCIData(false); } catch (_) {}
}

// ── Option label maps for the Facility controls ───────────────────────────────
const IND_FACILITY_OPTS = [['station', 'Station / Assembly Array'], ['ec', 'Engineering Complex'], ['other', 'Other Structure']];
const IND_SEC_OPTS       = [['high', 'High Sec'], ['low', 'Low Sec'], ['null', 'Null Sec'], ['wormhole', 'Wormhole']];
const IND_SIZE_OPTS      = [['M', 'Medium'], ['L', 'Large'], ['XL', 'Extra Large']];
const IND_RIG_OPTS       = [['none', 'No Rig'], ['t1', 'T1 Rig'], ['t2', 'T2 Rig']];

function _indOpt(value, label, sel) {
  return `<option value="${value}"${value === sel ? ' selected' : ''}>${escHtml(label)}</option>`;
}
function _indOpts(pairs, sel) { return pairs.map(([v, l]) => _indOpt(v, l, sel)).join(''); }

// Build the Facility/character controls HTML. The sheet sync lives in app
// Settings (set-once); here we only show the parsed "My Structures" presets.
function _indControlsHtml() {
  const s = _indSettings;
  const rigsOff = s.facility === 'station';
  const presetOpts = `<option value="">— My Structures —</option>` +
    _indStructures.map((st, i) => `<option value="${i}">${escHtml(st.name)}${st.systemName ? ' — ' + escHtml(st.systemName) : ''}</option>`).join('');
  return `
    <div class="bp-facility">
      <div class="bp-facility-row">
        <span class="bp-facility-label">FACILITY</span>
        <select class="field-input bp-facility-sel" data-ind="facility">${_indOpts(IND_FACILITY_OPTS, s.facility)}</select>
        <select class="field-input bp-facility-sel" data-ind="secStatus">${_indOpts(IND_SEC_OPTS, s.secStatus)}</select>
        <select class="field-input bp-facility-sel" data-ind="structureSize" ${rigsOff ? 'disabled' : ''}>${_indOpts(IND_SIZE_OPTS, s.structureSize)}</select>
        <label class="bp-facility-inline">Mat<select class="field-input bp-facility-sel" data-ind="matRig" ${rigsOff ? 'disabled' : ''}>${_indOpts(IND_RIG_OPTS, s.matRig)}</select></label>
        <label class="bp-facility-inline">Time<select class="field-input bp-facility-sel" data-ind="timeRig" ${rigsOff ? 'disabled' : ''}>${_indOpts(IND_RIG_OPTS, s.timeRig)}</select></label>
        <label class="bp-facility-inline">Tax%<input class="field-input bp-facility-num" type="number" min="0" step="0.1" data-ind="taxRate" value="${s.taxRate}"></label>
        <label class="bp-facility-inline">System<input class="field-input bp-facility-sys" type="text" data-ind="systemName" value="${escHtml(s.systemName)}" title="Manufacturing cost index source"></label>
      </div>
      <div class="bp-facility-row">
        <span class="bp-facility-label">BUILD AS</span>
        <select class="field-input bp-facility-sel bp-facility-char" data-ind="buildCharId"><option value="">— Character —</option></select>
        <select class="field-input bp-facility-sel bp-facility-preset" data-ind="structurePreset" title="Apply one of your structures">${presetOpts}</select>
        <span class="bp-facility-hint" data-ind="skillInfo"></span>
      </div>
    </div>`;
}

// Mount the controls into `mountEl` and wire change handlers. `onChange` runs
// after any setting changes (already persisted). Populates char list + skills async.
async function _indRenderControls(mountEl, onChange) {
  if (!mountEl) return;
  mountEl.innerHTML = _indControlsHtml();

  const fire = () => { _indSaveSettings(); if (onChange) onChange(); };

  // Plain settings selects/inputs
  mountEl.querySelectorAll('[data-ind]').forEach(el => {
    const field = el.dataset.ind;
    if (['facility', 'secStatus', 'structureSize', 'matRig', 'timeRig'].includes(field)) {
      el.addEventListener('change', () => {
        _indSettings[field] = el.value;
        if (field === 'facility') _indRenderControls(mountEl, onChange);  // re-render to toggle rig enable
        fire();
      });
    } else if (field === 'taxRate') {
      el.addEventListener('change', () => { _indSettings.taxRate = parseFloat(el.value) || 0; fire(); });
    } else if (field === 'systemName') {
      // System name → id resolution needs the Cost Index system map; load it
      // lazily the first time the user focuses the field (it's heavy).
      el.addEventListener('focus', _indEnsureSystemData);
      el.addEventListener('change', () => {
        _indSettings.systemName = el.value.trim();
        if (!_indResolveSystem(el.value.trim())) { _indSettings.systemId = _indSettings.systemId || 30000142; }
        fire();
      });
    }
  });

  // Build-character picker
  const charSel = mountEl.querySelector('[data-ind="buildCharId"]');
  if (charSel) {
    try {
      const accounts = await window.eveAPI.getAccounts() || {};
      const list = Object.entries(accounts).map(([id, a]) => ({ id, name: a.characterName || `Char ${id}` }));
      // Default to favourite/main if nothing chosen yet
      if (!_indSettings.buildCharId && list.length) {
        let favId = null;
        try { favId = (JSON.parse(localStorage.getItem('char_favorites') || '[]') || [])[0]; } catch (_) {}
        _indSettings.buildCharId = String(favId || list[0].id);
        _indSaveSettings();
      }
      charSel.innerHTML = `<option value="">— Character —</option>` +
        list.map(c => _indOpt(String(c.id), c.name, String(_indSettings.buildCharId))).join('');
    } catch (_) {}
    charSel.addEventListener('change', async () => {
      _indSettings.buildCharId = charSel.value || null;
      _indSaveSettings();
      await _indLoadSkills(_indSettings.buildCharId);
      _indUpdateSkillHint(mountEl);
      if (onChange) onChange();
    });
  }

  // Structures preset picker
  const presetSel = mountEl.querySelector('[data-ind="structurePreset"]');
  if (presetSel) presetSel.addEventListener('change', () => {
    const idx = parseInt(presetSel.value);
    if (!isNaN(idx) && _indStructures[idx]) {
      const p = _indStructures[idx];
      Object.assign(_indSettings, {
        facility: p.facility, secStatus: p.secStatus, structureSize: p.structureSize,
        matRig: p.matRig, timeRig: p.timeRig, taxRate: p.taxRate,
        systemName: p.systemName, systemId: p.systemId || _indSettings.systemId,
      });
      _indRenderControls(mountEl, onChange);
      fire();
    }
  });

  // Load skills for the current character + show the hint
  await _indLoadSkills(_indSettings.buildCharId);
  _indUpdateSkillHint(mountEl);
}

// Re-render the toolbar facility-controls bar (if mounted) so the "My Structures"
// dropdown reflects a fresh sheet sync performed from Settings.
function _indRefreshMountedControls() {
  const bar = document.getElementById('bpFacilityBar');
  if (bar) _indRenderControls(bar, () => { _bpEconCache.clear(); handleLibraryFilter(); });
}

function _indUpdateSkillHint(mountEl) {
  const hint = mountEl?.querySelector('[data-ind="skillInfo"]');
  if (!hint) return;
  hint.textContent = `Industry ${_indSkills.industry} · Adv Industry ${_indSkills.advIndustry}`
    + (_indSkillsCharId ? '' : ' (defaults)');
}

// Pull the structures CSV from a Google Sheet link, parse, resolve system ids,
// and store. Returns the parsed structure count (throws on fetch/parse failure).
async function _indSyncStructuresFromUrl(rawUrl) {
  const raw = (rawUrl || '').trim();
  if (!raw) throw new Error('No sheet link provided');

  // GEZ tracker: read the "GEZ Rig List" tab via gviz (works on link-shared
  // sheets, no "Publish to web" needed, and always targets the right tab).
  const url = window.IndustryMath.toSheetTabCsvUrl(raw, 'GEZ Rig List');
  localStorage.setItem(IND_SHEET_URL_KEY, raw);

  const csv  = await window.eveAPI.httpGetText(url);
  const rows = window.IndustryMath.parseStructuresCsv(csv);
  _indEnsureSystemData();
  rows.forEach(st => {
    if (st.systemName && typeof findCISystemByName === 'function') {
      const hit = findCISystemByName(st.systemName);
      if (hit && hit.id) { st.systemId = hit.id; if (hit.secStatus != null) st.secStatus = _indSecKeyFromStatus(hit.secStatus); }
    }
  });
  _indStructures = rows;
  _indSaveStructures();
  _indRefreshMountedControls();
  return rows.length;
}

// Wire the Industry settings panel (sheet URL + Sync). Called once from ui.js.
function bindIndustrySettings() {
  const input  = document.getElementById('industrySheetUrl');
  const syncBtn = document.getElementById('industrySheetSyncBtn');
  const status = document.getElementById('industrySheetStatus');
  if (!syncBtn || syncBtn.dataset.wired === '1') return;
  syncBtn.dataset.wired = '1';

  const refreshStatus = () => {
    if (status) status.textContent = _indStructures.length
      ? `${_indStructures.length} structure${_indStructures.length === 1 ? '' : 's'} loaded.`
      : 'No structures loaded yet.';
  };
  refreshStatus();

  syncBtn.addEventListener('click', async () => {
    const raw = (input?.value || '').trim();
    if (!raw) { showToast('Paste a published Google Sheet CSV link first.', 'info'); return; }
    syncBtn.disabled = true; syncBtn.textContent = 'Syncing…';
    try {
      const n = await _indSyncStructuresFromUrl(raw);
      refreshStatus();
      showToast(`Loaded ${n} structure${n === 1 ? '' : 's'} from sheet.`, 'success');
    } catch (e) {
      console.error('[industry] sheet sync failed:', e);
      showToast('Sheet sync failed — check the link is published to the web as CSV.', 'error');
    } finally {
      syncBtn.disabled = false; syncBtn.textContent = 'Sync';
    }
  });
}

// Fill the Industry settings input from the saved sheet URL (called on drawer open).
function populateIndustrySettings() {
  const input = document.getElementById('industrySheetUrl');
  if (input) input.value = localStorage.getItem(IND_SHEET_URL_KEY) || '';
  const status = document.getElementById('industrySheetStatus');
  if (status) status.textContent = _indStructures.length
    ? `${_indStructures.length} structure${_indStructures.length === 1 ? '' : 's'} loaded.`
    : 'No structures loaded yet.';
}

// Format seconds → "2d 4h 11m" style duration.
function _indFmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const d = Math.floor(sec / 86400); sec -= d * 86400;
  const h = Math.floor(sec / 3600);  sec -= h * 3600;
  const m = Math.floor(sec / 60);    const s = sec - m * 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  if (!d && !h) parts.push(s + 's');
  return parts.join(' ') || '0s';
}

// Build the detail-panel materials table + cost/time/profit summary HTML from
// already-computed values (o). Pure string builder.
function _bpDetailBreakdownHtml(o) {
  const matRows = o.rows.map(r => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:4px;">
      <img src="${ESI_IMAGE}/${r.mat.typeId}/icon?size=32" onerror="this.src='${ESI_IMAGE}/0/icon?size=32';"
           style="width:28px;height:28px;border-radius:3px;flex-shrink:0;">
      <span style="flex:1;color:var(--text-1);font-size:13px;">${escHtml(r.mat.name || ('Type ' + r.mat.typeId))}</span>
      <span style="font-family:var(--mono);color:var(--text-1);font-size:12px;font-weight:600;min-width:80px;text-align:right;">×${r.qty.toLocaleString()}</span>
      <span style="font-family:var(--mono);color:var(--text-3);font-size:11px;min-width:100px;text-align:right;">${r.unit > 0 ? formatNumber(r.unit) + ' ISK' : '—'}</span>
      <span style="font-family:var(--mono);font-size:11px;font-weight:600;min-width:110px;text-align:right;color:${r.total > 0 ? 'var(--text-1)' : 'var(--text-3)'};">${r.total > 0 ? formatNumber(r.total) : '—'}</span>
    </div>`).join('');

  const sumRow = (k, v, opts = {}) => `
    <div class="bp-sum-row"${opts.top ? ' style="border-top:1px solid var(--border);padding-top:10px;margin-top:2px;"' : ''}>
      <span class="bp-sum-k"${opts.big ? ' style="color:var(--text-2);font-size:13px;"' : ''}>${k}</span>
      <span class="bp-sum-v"${opts.color ? ` style="color:${opts.color};${opts.big ? 'font-size:18px;font-weight:700;' : ''}"` : (opts.big ? ' style="font-size:18px;font-weight:700;"' : '')}>${v}</span>
    </div>`;

  const profitColor = o.profit == null ? 'var(--text-3)' : o.profit >= 0 ? 'var(--success)' : 'var(--danger)';
  const profitText  = o.profit == null ? 'No market data'
                    : (o.profit >= 0 ? '+' : '') + formatNumber(o.profit) + ' ISK';
  const marginText  = o.margin == null ? '—' : `${o.margin >= 0 ? '+' : ''}${o.margin.toFixed(1)}%`;
  const iskHrText   = o.iskHr == null ? '—'
                    : (o.iskHr >= 0 ? '+' : '') + formatNumber(o.iskHr) + ' ISK/hr';

  return `
    <div style="margin-bottom:16px;">
      <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;margin-bottom:8px;">PRODUCES</div>
      <div style="display:flex;align-items:center;padding:8px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:4px;gap:8px;">
        ${o.productImg}
        <span style="color:var(--text-1);font-size:13px;">${escHtml(o.productName || 'Unknown Product')}</span>
        <span style="font-family:var(--mono);color:var(--text-2);margin-left:auto;">×${(o.productQty * o.runs).toLocaleString()}</span>
      </div>
    </div>

    <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;margin-bottom:6px;">
      MATERIALS — ${o.runs} RUN${o.runs === 1 ? '' : 'S'} · ME${o.me}
      <span style="font-size:9px;margin-left:8px;">(facility &amp; rig adjusted, rounded per EVE rules)</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:3px 10px;font-family:var(--mono);font-size:9px;color:var(--text-3);letter-spacing:0.08em;margin-bottom:2px;">
      <span style="width:28px;flex-shrink:0;"></span>
      <span style="flex:1;">MATERIAL</span>
      <span style="min-width:80px;text-align:right;">QTY</span>
      <span style="min-width:100px;text-align:right;">JITA SELL/UNIT</span>
      <span style="min-width:110px;text-align:right;">TOTAL COST</span>
    </div>
    <div>${matRows}</div>

    <div class="bp-detail-summary">
      ${sumRow('Materials (Jita sell)', formatNumber(o.matCost) + ' ISK')}
      ${sumRow(`Job install fee (index ${(o.costIndex * 100).toFixed(2)}% + tax ${o.taxRate}% + SCC 4%)`, formatNumber(o.jobFee) + ' ISK')}
      ${sumRow('Total build cost', formatNumber(o.totalCost) + ' ISK', { top: true, big: true, color: 'var(--accent)' })}
      ${sumRow('Build time', _indFmtDuration(o.buildTime))}
      ${sumRow(`Product value (${(o.productQty * o.runs).toLocaleString()}× ${escHtml(o.productName || '')})`, o.productValue > 0 ? formatNumber(o.productValue) + ' ISK' : '—')}
      ${sumRow('Profit', profitText, { top: true, big: true, color: profitColor })}
      ${sumRow('Margin', marginText, { color: o.margin == null ? 'var(--text-3)' : o.margin >= 0 ? 'var(--success)' : 'var(--danger)' })}
      ${sumRow('Profit / hour', iskHrText, { color: o.iskHr == null ? 'var(--text-3)' : o.iskHr >= 0 ? 'var(--success)' : 'var(--danger)' })}
    </div>`;
}

// Colour for the category pill + the card's left border, by SDE category name.
function _bpCategoryColor(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('ship'))      return '#5b9bd5'; // blue
  if (c.includes('drone'))     return '#e3a84d'; // amber
  if (c.includes('charge'))    return '#c05c7e'; // pink
  if (c.includes('module'))    return '#4ecbb0'; // teal
  if (c.includes('structure')) return '#7d8fa3'; // grey-blue
  if (c.includes('component')) return '#ab7ab8'; // purple
  if (c.includes('commodity')) return '#ab7ab8'; // purple (build components)
  if (c.includes('material'))  return '#9b8e76'; // tan
  return '#7d8fa3';                               // grey fallback
}

function renderBlueprintList(bps) {
  const listDiv   = document.getElementById('bpLibList');
  const countSpan = document.getElementById('bpLibCount');
  if (!listDiv) return;
  if (countSpan) countSpan.textContent = bps.length;

  // Tear down any observer from a previous render before we replace the cards.
  if (_bpEconObserver) { _bpEconObserver.disconnect(); _bpEconObserver = null; }
  listDiv.innerHTML = '';

  if (bps.length === 0) {
    listDiv.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;margin-top:40px;">
        <div class="empty-icon">⬡</div>
        <div class="empty-title">NO BLUEPRINTS FOUND</div>
        <div class="empty-sub">Sync a character or adjust your advanced filter settings.</div>
      </div>`;
    return;
  }

  bps.forEach(bp => {
    const card = document.createElement('div');
    card.className = 'bp-card';
    card.dataset.typeId = bp.type_id;
    card.dataset.me     = bp.me;
    card.dataset.te     = bp.te;

    const mePct = Math.min(100, Math.max(0, (bp.me / 10) * 100));
    const tePct = Math.min(100, Math.max(0, (bp.te / 20) * 100));

    const isPerfect = bp.me === 10 && bp.te === 20;
    const isTech2   = /\b(?:tech\s*ii|tech\s*2|t2|mk\s*ii|mark\s*ii|\bII\b)\b/i.test(bp.name);
    const isFaction = /\b(?:faction|navy|pirate|guristas|serpentis|angel cartel|blood raiders|sansha|angel|mordu|sisters|drifter|triglavian)\b/i.test(bp.name);

    // ── Status / category pills ──────────────────────────────────────────────
    const pills = [];
    if (isPerfect) {
      pills.push(`<span class="bp-pill perfect" title="Perfect blueprint (ME 10 / TE 20) — click to filter">PERFECT</span>`);
    } else {
      if (bp.me === 10) pills.push(`<span class="bp-pill me" title="Perfect material efficiency">ME 10</span>`);
      if (bp.te === 20) pills.push(`<span class="bp-pill te" title="Perfect time efficiency">TE 20</span>`);
    }
    if (isTech2)   pills.push(`<span class="bp-pill tech2"   title="Tech II blueprint">TECH II</span>`);
    if (isFaction) pills.push(`<span class="bp-pill faction" title="Faction blueprint">FACTION</span>`);
    // Category pill — hidden until the lazy enrichment resolves the SDE category.
    pills.push(`<span class="bp-pill cat no-dot bp-cat-pill" style="display:none;"></span>`);

    // Left-border accent: perfect → purple, else tier, else neutral (category fills in later).
    const accent = isPerfect ? '#ab7ab8' : isTech2 ? '#ffcc00' : isFaction ? '#4ada8a' : 'var(--border-b)';
    card.style.borderLeftColor = accent;
    if (isPerfect) card.dataset.perfect = '1';

    const subType = bp.isBPC ? `BPC · ${bp.runs > 0 ? bp.runs + ' runs' : '∞ runs'}` : 'BPO';

    const charId   = bp.characterId   || bp.character_id   || '';
    const charName = bp.characterName || bp.character_name || 'Unknown';

    card.innerHTML = `
      <div class="bp-pill-row">${pills.join('')}</div>
      <div class="bp-card-head">
        <img class="bp-card-thumb"
             src="${ESI_IMAGE}/${bp.type_id}/bp?size=64"
             onerror="this.onerror=null;this.src='${ESI_IMAGE}/${bp.type_id}/icon?size=64';"
             alt="bp-icon">
        <div class="bp-card-titlewrap">
          <div class="bp-card-title">${escHtml(bp.name)}</div>
          <div class="bp-card-sub"><span class="bp-sub-type">${subType}</span></div>
        </div>
      </div>
      <div class="bp-card-bars">
        <div class="bp-stat">
          <div class="bp-stat-label">ME ${bp.me}</div>
          <div class="bp-stat-track"><div class="bp-stat-fill me" style="width:${mePct}%"></div></div>
        </div>
        <div class="bp-stat">
          <div class="bp-stat-label">TE ${bp.te}</div>
          <div class="bp-stat-track"><div class="bp-stat-fill te" style="width:${tePct}%"></div></div>
        </div>
      </div>
      <div class="bp-card-econ">
        <div>
          <div class="bp-econ-label">BUILD COST · JITA</div>
          <div class="bp-econ-cost muted">…</div>
        </div>
        <div>
          <div class="bp-econ-profit na"></div>
          <div class="bp-econ-margin"></div>
        </div>
      </div>
      <div class="bp-card-foot">
        <div class="bp-card-owner">
          ${charId
            ? `<img class="bp-lib-portrait" src="https://images.evetech.net/characters/${charId}/portrait?size=64"
                    loading="lazy" title="Owned by ${escHtml(charName)}" alt="owner portrait">`
            : `<div class="bp-lib-portrait" style="display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px;">⬡</div>`}
          <span class="bp-card-owner-name">${escHtml(charName)}</span>
        </div>
        <button class="bp-view-btn" type="button">View</button>
      </div>`;

    // View button → SDE-accurate detail panel.
    card.querySelector('.bp-view-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      await openBlueprintDetail(bp);
    });
    // Clicking the card body (not the button) also opens the detail.
    card.addEventListener('click', () => openBlueprintDetail(bp));

    const perfectPill = card.querySelector('.bp-pill.perfect');
    if (perfectPill) perfectPill.addEventListener('click', (ev) => { ev.stopPropagation(); togglePerfectFilter(); });

    listDiv.appendChild(card);
  });

  _bpObserveCards(listDiv);
}

// Lazily compute build cost / margin / category for each card as it scrolls into
// view. fetchHubPrices does one ESI request per uncached type, so we only ever
// price the blueprints the user actually looks at, and cache every result.
function _bpObserveCards(listDiv) {
  const cards = listDiv.querySelectorAll('.bp-card');
  if (!cards.length) return;

  if (!('IntersectionObserver' in window)) {
    cards.forEach(c => _bpEnrichCard(c));   // no observer support → just do them all
    return;
  }

  _bpEconObserver = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      obs.unobserve(entry.target);
      _bpEnrichCard(entry.target);
    });
  }, { root: listDiv, rootMargin: '200px' });

  cards.forEach(c => _bpEconObserver.observe(c));
}

// Fetch (and cache) a blueprint's manufacturing materials + product from the SDE,
// falling back to Fuzzwork. Returns null when there's no manufacturing data.
async function _bpGetMaterials(typeId, me) {
  const key = `${typeId}:${me}`;
  if (_bpMatCache.has(key)) return _bpMatCache.get(key);

  let sde = null;
  try { sde = await window.eveAPI.sdeBlueprintMaterials(typeId, me); } catch (_) {}
  if (!sde || !sde.materials || !sde.materials.length) {
    sde = await fetchFuzzworkMaterials(typeId, me).catch(() => null);
  }
  const val = (sde && sde.materials && sde.materials.length)
    ? { materials: sde.materials, productTypeId: sde.productTypeId || null,
        productQty: sde.productQty || 1, baseTime: sde.baseTime || 0 }
    : null;
  _bpMatCache.set(key, val);
  return val;
}

// Pure-ish: turn materials + price map + product metadata into the econ result,
// applying the active facility/structure/skill settings (material reduction, job
// install fee, build time, ISK/hour). ctx = { me, te, adjustedPrices, costIndex }.
// All figures are for ONE run.
function _bpEconFromData(mat, prices, productMeta, ctx) {
  const result = {
    materialsCost: 0, jobFee: 0, buildCost: 0, productValue: 0,
    margin: null, profit: null, buildTime: 0, iskPerHour: null,
    hasPrices: false, category: null, group: null, noData: false,
  };
  if (!mat) { result.noData = true; return result; }

  const M  = window.IndustryMath;
  const me = (ctx && ctx.me) || 0;
  const te = (ctx && ctx.te) || 0;
  const adj = (ctx && ctx.adjustedPrices) || {};
  const matMod = M.matModifier(_indParams(me, te));

  let cost = 0, anyPriced = false, eivSum = 0;
  for (const m of mat.materials) {
    const baseQty = m.baseQty != null ? m.baseQty : (m.quantity || 0);
    const qty = M.adjustedQty(baseQty, 1, matMod);
    const p = prices[m.typeId];
    const unit = p?.sell > 0 ? p.sell : (p?.buy || 0);
    if (unit > 0) anyPriced = true;
    cost   += unit * qty;
    eivSum += (adj[m.typeId] || 0) * baseQty;
  }
  result.materialsCost = cost;
  result.jobFee   = M.jobFee(eivSum, 1, (ctx && ctx.costIndex) || 0, (_indSettings.taxRate || 0) / 100);
  result.buildCost = result.materialsCost + result.jobFee;

  if (mat.productTypeId) {
    const pp = prices[mat.productTypeId];
    const outUnit = pp?.sell > 0 ? pp.sell : (pp?.buy || 0);
    result.productValue = outUnit * (mat.productQty || 1);
  }
  result.hasPrices = anyPriced && result.materialsCost > 0;
  if (result.hasPrices && result.productValue > 0) {
    result.profit = result.productValue - result.buildCost;
    result.margin = (result.profit / result.buildCost) * 100;
  }

  result.buildTime = M.totalTime(mat.baseTime || 0, 1, M.timeModifier(_indParams(me, te), _indSkills));
  if (result.profit != null && result.buildTime > 0) {
    result.iskPerHour = result.profit / (result.buildTime / 3600);
  }

  if (productMeta) { result.category = productMeta.category || null; result.group = productMeta.group || null; }
  return result;
}

// Compute (and cache) econ for one blueprint — its own price + metadata fetch.
async function _bpComputeEcon(typeId, me, te) {
  const key = _bpEconKey(typeId, me);
  if (_bpEconCache.has(key)) return _bpEconCache.get(key);

  const mat = await _bpGetMaterials(typeId, me);
  if (!mat) { const r = _bpEconFromData(null); _bpEconCache.set(key, r); return r; }

  const ids = mat.materials.map(m => m.typeId);
  if (mat.productTypeId) ids.push(mat.productTypeId);

  let prices = {};
  try { prices = await window.eveAPI.getJitaPrices([...new Set(ids)]) || {}; } catch (_) {}

  let productMeta = null;
  if (mat.productTypeId) {
    try { const meta = await window.eveAPI.getTypeMetadata([mat.productTypeId]); productMeta = meta?.[mat.productTypeId] || null; } catch (_) {}
  }

  const adjustedPrices = await _indGetAdjustedPrices();
  const costIndex      = await _indGetCostIndex(_indSettings.systemId);

  const result = _bpEconFromData(mat, prices, productMeta, { me, te, adjustedPrices, costIndex });
  _bpEconCache.set(key, result);
  return result;
}

// Simple bounded-concurrency runner.
async function _bpRunPool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

// Ensure every blueprint in `bps` has an econ result cached — batched so we make
// ONE price call and ONE metadata call for the whole union of types, instead of
// per-card fetches. Used before profit/margin/output/group sorts.
async function _bpEnsureEconForSort(bps) {
  const todo = bps.filter(bp => !_bpEconCache.has(_bpEconKey(bp.type_id, bp.me)));
  if (!todo.length) return;

  // 1. Materials for all (local SDE queries), bounded concurrency.
  await _bpRunPool(todo, 10, bp => _bpGetMaterials(bp.type_id, bp.me));

  // 2. Union of every type we need a price / category for.
  const priceIds = new Set(), productIds = new Set();
  for (const bp of todo) {
    const mat = _bpMatCache.get(`${bp.type_id}:${bp.me}`);
    if (!mat) continue;
    mat.materials.forEach(m => priceIds.add(m.typeId));
    if (mat.productTypeId) { priceIds.add(mat.productTypeId); productIds.add(mat.productTypeId); }
  }

  // 3. One batched price call + one batched metadata call + shared cost inputs.
  let prices = {}, meta = {};
  if (priceIds.size)   { try { prices = await window.eveAPI.getJitaPrices([...priceIds])   || {}; } catch (_) {} }
  if (productIds.size) { try { meta   = await window.eveAPI.getTypeMetadata([...productIds]) || {}; } catch (_) {} }
  const adjustedPrices = await _indGetAdjustedPrices();
  const costIndex      = await _indGetCostIndex(_indSettings.systemId);

  // 4. Compute + cache each from the shared maps.
  for (const bp of todo) {
    const key = _bpEconKey(bp.type_id, bp.me);
    if (_bpEconCache.has(key)) continue;
    const mat = _bpMatCache.get(`${bp.type_id}:${bp.me}`);
    _bpEconCache.set(key, _bpEconFromData(mat, prices, mat?.productTypeId ? meta[mat.productTypeId] : null,
      { me: bp.me, te: bp.te, adjustedPrices, costIndex }));
  }
}

async function _bpEnrichCard(card) {
  const typeId = Number(card.dataset.typeId);
  const me     = Number(card.dataset.me) || 0;
  const te     = Number(card.dataset.te) || 0;
  const key    = _bpEconKey(typeId, me);

  if (_bpEconCache.has(key)) { _bpApplyEnrichment(card, _bpEconCache.get(key)); return; }
  if (card.dataset.enriching === '1') return;
  card.dataset.enriching = '1';

  const result = await _bpComputeEcon(typeId, me, te);
  _bpApplyEnrichment(card, result);
  delete card.dataset.enriching;
}

function _bpApplyEnrichment(card, data) {
  const costEl   = card.querySelector('.bp-econ-cost');
  const profitEl = card.querySelector('.bp-econ-profit');
  const marginEl = card.querySelector('.bp-econ-margin');
  const catPill  = card.querySelector('.bp-cat-pill');
  const subType  = card.querySelector('.bp-sub-type');

  // Build cost
  if (costEl) {
    if (data.noData) {
      costEl.textContent = 'No build data';
      costEl.classList.add('muted');
    } else if (data.buildCost > 0) {
      costEl.textContent = formatNumber(data.buildCost) + ' ISK';
      costEl.classList.remove('muted');
    } else {
      costEl.textContent = 'No market';
      costEl.classList.add('muted');
    }
  }

  // Profit (product sell − build cost) + margin
  if (profitEl) {
    if (data.hasPrices && data.productValue > 0 && data.margin != null) {
      const profit = data.productValue - data.buildCost;
      profitEl.textContent = (profit >= 0 ? '+' : '') + formatNumber(profit);
      profitEl.className = 'bp-econ-profit ' + (profit >= 0 ? 'pos' : 'neg');
      if (marginEl) {
        marginEl.textContent = `${data.margin >= 0 ? '+' : ''}${data.margin.toFixed(1)}% margin`;
        marginEl.style.color = data.margin >= 0 ? 'var(--success)' : 'var(--danger)';
      }
    } else {
      profitEl.textContent = '';
      profitEl.className = 'bp-econ-profit na';
      if (marginEl) marginEl.textContent = '';
    }
  }

  // Category pill + sub label + left border
  if (data.category && catPill) {
    const color = _bpCategoryColor(data.category);
    catPill.textContent = data.category.toUpperCase();
    catPill.style.color = color;
    catPill.style.background = color + '24';
    catPill.style.display = '';
    if (subType && data.group) subType.textContent = `${subType.textContent} · ${data.group}`;
    // Keep the purple accent on perfect blueprints; otherwise colour by category.
    if (card.dataset.perfect !== '1') card.style.borderLeftColor = color;
  }
}

function bindLibraryEvents() {
  const libInputs = [
    document.getElementById('bpLibSearch'),
    document.getElementById('bpLibMinME'),
    document.getElementById('bpLibMinTE'),
    document.getElementById('bpLibMinRuns'),
  ];
  libInputs.forEach(input => {
    if (input) input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => handleLibraryFilter(), 300);
    });
  });

  const libFilter = document.getElementById('bpLibFilter');
  if (libFilter) libFilter.addEventListener('change', () => handleLibraryFilter());

  const libSort = document.getElementById('bpLibSort');
  if (libSort) libSort.addEventListener('change', () => handleLibraryFilter());

  const toggleBtn = document.getElementById('toggleLibraryBtn');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleLibraryView);
}

// ─── Blueprint Detail Panel ───────────────────────────────────────────────────
// Opens a detail view for the given `bp` object (from the local DB).
// Queries SDE for the canonical material list and applies the blueprint's real ME.

async function openBlueprintDetail(bp) {
  // Show the results panel and hide the list
  const listSection = document.getElementById('bpLibList')?.closest('div[style*="flex-direction:column"]')
                   || document.getElementById('bpLibList')?.parentElement;
  const resultsDiv  = document.getElementById('results');
  if (!resultsDiv) return;

  // Render a loading skeleton immediately
  resultsDiv.style.display = 'block';
  if (listSection) listSection.style.display = 'none';

  resultsDiv.innerHTML = `
    <div class="panel" style="padding:24px;overflow-y:auto;height:100%;">
      <button id="backToBpLib" style="margin-bottom:20px;padding:6px 14px;
        background:var(--bg-hover);border:1px solid var(--border);color:var(--text-1);
        cursor:pointer;border-radius:var(--radius);font-family:var(--mono);font-size:11px;">
        ← BACK TO LIBRARY
      </button>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
        <img src="${ESI_IMAGE}/${bp.type_id}/bp?size=64"
             onerror="this.onerror=null;this.src='${ESI_IMAGE}/${bp.type_id}/icon?size=64';"
             style="width:64px;height:64px;border-radius:4px;border:1px solid var(--border);">
        <div>
          <h2 style="font-size:22px;margin:0 0 6px;color:var(--text-1);">${escHtml(bp.name)}</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <span class="bp-detail-badge" style="background:var(--bg-card);padding:3px 10px;border-radius:3px;
                         font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
              ME <span style="color:var(--success);">${bp.me}</span>
            </span>
            <span class="bp-detail-badge" style="background:var(--bg-card);padding:3px 10px;border-radius:3px;
                         font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
              TE <span style="color:var(--accent);">${bp.te}</span>
            </span>
            <span class="bp-detail-badge" style="background:var(--bg-card);padding:3px 10px;border-radius:3px;
                         font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
              ${bp.isBPC ? `BPC · <span style="color:#4ada8a;">${bp.runs > 0 ? bp.runs + ' runs' : '∞ runs'}</span>` : 'BPO'}
            </span>
          </div>
        </div>
      </div>
      <div id="bpDetailBody" style="background:var(--bg-panel);padding:20px;border:1px solid var(--border);border-radius:6px;">
        <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);letter-spacing:0.08em;">
          LOADING MATERIALS FROM SDE…
        </div>
        <div class="bp-loading-bar" style="margin-top:12px;height:2px;background:var(--bg-card);border-radius:1px;overflow:hidden;">
          <div style="height:100%;width:40%;background:var(--accent);animation:bpLoadSlide 1.2s ease-in-out infinite;"></div>
        </div>
      </div>
    </div>`;

  document.getElementById('backToBpLib')?.addEventListener('click', () => {
    resultsDiv.style.display   = 'none';
    resultsDiv.innerHTML       = '';
    if (listSection) listSection.style.display = 'flex';
    // Settings may have changed in the detail view — resync the toolbar controls
    // and re-cost the grid so the cards reflect the current facility/character.
    const bar = document.getElementById('bpFacilityBar');
    if (bar) _indRenderControls(bar, () => { _bpEconCache.clear(); handleLibraryFilter(); });
    _bpEconCache.clear();
    handleLibraryFilter();
  });

  // ── Fetch SDE materials ──────────────────────────────────────────────────────
  let sdeResult = null;
  try {
    sdeResult = await window.eveAPI.sdeBlueprintMaterials(bp.type_id, bp.me);
  } catch (err) {
    console.warn('[BpDetail] SDE materials failed, falling back to Fuzzwork:', err.message);
  }

  if (!sdeResult || !sdeResult.materials || sdeResult.materials.length === 0) {
    // Fallback: Fuzzwork API with the blueprint's real ME
    try {
      sdeResult = await fetchFuzzworkMaterials(bp.type_id, bp.me);
    } catch (err) {
      console.error('[BpDetail] Fuzzwork fallback also failed:', err.message);
    }
  }

  const detailBody = document.getElementById('bpDetailBody');
  if (!detailBody) return;   // user navigated away

  if (!sdeResult || !sdeResult.materials || sdeResult.materials.length === 0) {
    detailBody.innerHTML = `
      <div style="font-family:var(--mono);font-size:11px;color:var(--text-3);">
        No material data found for this blueprint in the SDE or Fuzzwork.<br>
        It may be a reaction, PI schematic, or an item without manufacturing activity.
      </div>`;
    return;
  }

  // ── Fetch Jita prices (materials + product) + adjusted prices (for EIV) ──────
  const { materials, productTypeId, productName, productQty } = sdeResult;
  const baseTime = sdeResult.baseTime || 0;
  const priceIds = materials.map(m => m.typeId);
  if (productTypeId) priceIds.push(productTypeId);
  let prices = {};
  try { prices = await window.eveAPI.getJitaPrices([...new Set(priceIds)]) || {}; } catch (_) {}
  const adjustedPrices = await _indGetAdjustedPrices();

  const productImg = productTypeId
    ? `<img src="${ESI_IMAGE}/${productTypeId}/icon?size=32"
            onerror="this.src='${ESI_IMAGE}/0/icon?size=32';"
            style="width:24px;height:24px;vertical-align:middle;margin-right:6px;border-radius:2px;">`
    : '';

  const defaultRuns = (bp.isBPC && bp.runs > 0) ? bp.runs : 1;

  // Shell: facility controls + runs + recomputable breakdown + static buttons.
  detailBody.innerHTML = `
    <div id="bpDetailFacility" class="bp-facility-mount"></div>
    <div class="bp-runs-row">
      <span class="bp-facility-label">RUNS</span>
      <input id="bpDetailRuns" class="field-input bp-facility-num" type="number" min="1" value="${defaultRuns}">
    </div>
    <div id="bpBreakdown"></div>
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;">
      <button id="bpTreeBtn" class="bp-view-btn" type="button" style="padding:6px 16px;font-size:11px;background:var(--bg-hover);">
        ⬡ SHOW COMPONENT TREE
      </button>
      <button id="bpAddToListBtn" class="bp-view-btn" type="button" style="padding:6px 16px;font-size:11px;background:var(--bg-hover);margin-left:auto;">
        ➕ ADD TO SHOPPING LIST
      </button>
    </div>
    <div id="bpComponentTree" style="display:none;margin-top:16px;"></div>`;

  // Recompute the breakdown from the live facility settings + runs.
  async function recompute() {
    const breakdown = document.getElementById('bpBreakdown');
    if (!breakdown) return;
    const runs = Math.max(1, parseInt(document.getElementById('bpDetailRuns')?.value) || 1);
    const M = window.IndustryMath;
    const matMod    = M.matModifier(_indParams(bp.me, bp.te));
    const costIndex = await _indGetCostIndex(_indSettings.systemId);

    let matCost = 0, eiv = 0;
    const rows = materials.map(mat => {
      const baseQty = mat.baseQty != null ? mat.baseQty : (mat.quantity || 0);
      const qty  = M.adjustedQty(baseQty, runs, matMod);
      const p    = prices[mat.typeId];
      const unit = p?.sell > 0 ? p.sell : (p?.buy || 0);
      const total = unit * qty;
      matCost += total;
      eiv     += (adjustedPrices[mat.typeId] || 0) * baseQty;
      return { mat, qty, unit, total };
    });
    const jobFee    = M.jobFee(eiv, runs, costIndex, (_indSettings.taxRate || 0) / 100);
    const totalCost = matCost + jobFee;

    let productValue = 0;
    if (productTypeId) {
      const pp = prices[productTypeId];
      const u  = pp?.sell > 0 ? pp.sell : (pp?.buy || 0);
      productValue = u * (productQty || 1) * runs;
    }
    const profit = productValue > 0 ? productValue - totalCost : null;
    const margin = (profit != null && totalCost > 0) ? (profit / totalCost) * 100 : null;
    const buildTime = M.totalTime(baseTime, runs, M.timeModifier(_indParams(bp.me, bp.te), _indSkills));
    const iskHr = (profit != null && buildTime > 0) ? profit / (buildTime / 3600) : null;

    breakdown.innerHTML = _bpDetailBreakdownHtml({
      productImg, productName, productQty, runs, me: bp.me, rows,
      matCost, eiv, jobFee, costIndex, taxRate: _indSettings.taxRate || 0,
      totalCost, productValue, profit, margin, buildTime, iskHr,
    });
  }

  _indRenderControls(document.getElementById('bpDetailFacility'), () => recompute());
  document.getElementById('bpDetailRuns')?.addEventListener('change', () => recompute());
  // Load the build character's skills up front so the first time/ISK-hour is correct.
  await _indLoadSkills(_indSettings.buildCharId);
  await recompute();

  // Add to Shopping List
  document.getElementById('bpAddToListBtn')?.addEventListener('click', () => {
    const slMats = materials.map(m => ({ typeId: m.typeId, name: m.name, qty: m.adjustedQty }));
    if (typeof showAddToShoppingListModal === 'function') {
      showAddToShoppingListModal(slMats, bp.name || `Type ${bp.type_id}`);
    }
  });

  // Component tree toggle — passes SDE materials so root level never needs Fuzzwork
  document.getElementById('bpTreeBtn')?.addEventListener('click', async () => {
    const treeDiv = document.getElementById('bpComponentTree');
    if (!treeDiv) return;
    if (treeDiv.style.display !== 'none') {
      treeDiv.style.display = 'none';
      document.getElementById('bpTreeBtn').textContent = '⬡ SHOW COMPONENT TREE';
      return;
    }
    treeDiv.style.display = 'block';
    document.getElementById('bpTreeBtn').textContent = '⬡ HIDE COMPONENT TREE';
    await renderComponentTreePanel(treeDiv, bp, sdeResult.materials);
  });
}

// ─── Component Tree Panel ─────────────────────────────────────────────────────
// Renders the full manufacturing breakdown with tier depth + reaction controls.
// tierDepth: how many blueprint layers to recurse into before treating a node as
//   a "buy this" leaf.  0 = only T0 raw (minerals/moon goo), 4 = stop at capital
//   components, 99 = fully flatten everything.
// includeReactions: if false, reaction products are treated as leaves (buy off market).

// Build a tree starting from already-known SDE materials (avoids Fuzzwork for root).
// For each material, tries findBpForProduct to check for sub-blueprints, then recurses.
async function buildTreeFromSdeMaterials(sdeMaterials, maxDepth, includeReactions) {
  const REACTION_ACTIVITY = 11;
  const nodes = [];
  for (const mat of sdeMaterials) {
    let subTree    = null;
    let isReaction = false;
    if (maxDepth > 0) {
      try {
        const found = await window.eveAPI.findBpForProduct(mat.typeId);
        const entry = found?.[mat.typeId];
        if (entry?.blueprintDetails) {
          const actId = entry.blueprintDetails.activityID ?? 1;
          isReaction  = actId === REACTION_ACTIVITY;
          if (!isReaction || includeReactions) {
            const subBpId = entry.blueprintDetails.blueprintTypeID;
            // Convert "units of this material needed" into "runs of its blueprint",
            // since one run yields productQty units (reactions yield large batches).
            const outPerRun = entry.blueprintDetails.productQty || 1;
            const subRuns   = Math.max(1, Math.ceil(mat.adjustedQty / outPerRun));
            subTree = await buildRecursiveMaterialTree(subBpId, subRuns, 0, maxDepth - 1, includeReactions);
          }
        }
      } catch (_) {}
    }
    nodes.push({ typeid: mat.typeId, name: mat.name, quantity: mat.adjustedQty, subTree, isReaction, depth: 0 });
  }
  return nodes;
}

async function renderComponentTreePanel(container, bp, rootMaterials = null) {
  container.innerHTML = `
    <div id="ctrlBar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;
         padding:10px 12px;background:var(--bg-card);border:1px solid var(--border);
         border-radius:4px;margin-bottom:12px;">
      <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                   letter-spacing:0.08em;flex-shrink:0;">BREAK DOWN TO:</span>

      <div style="display:flex;gap:4px;flex-wrap:wrap;" id="tierBtns">
        <button class="tier-btn active" data-depth="1"
                style="padding:3px 10px;border-radius:3px;border:1px solid var(--accent);
                       background:var(--accent);color:#000;font-family:var(--mono);
                       font-size:10px;cursor:pointer;font-weight:700;">
          T1 Components
        </button>
        <button class="tier-btn" data-depth="2"
                style="padding:3px 10px;border-radius:3px;border:1px solid var(--border);
                       background:transparent;color:var(--text-2);font-family:var(--mono);
                       font-size:10px;cursor:pointer;">
          T2 Sub-Components
        </button>
        <button class="tier-btn" data-depth="99"
                style="padding:3px 10px;border-radius:3px;border:1px solid var(--border);
                       background:transparent;color:var(--text-2);font-family:var(--mono);
                       font-size:10px;cursor:pointer;">
          Raw (minerals / moon goo)
        </button>
      </div>

      <label style="display:flex;align-items:center;gap:6px;font-family:var(--mono);
                    font-size:10px;color:var(--text-2);margin-left:auto;cursor:pointer;">
        <input type="checkbox" id="includeReactions" checked
               style="accent-color:var(--accent);width:13px;height:13px;">
        Include reaction items
      </label>
    </div>

    <div id="treeOutput" style="font-family:var(--mono);font-size:11px;color:var(--text-3);
         padding:12px;">Building component tree…</div>`;

  // Wire tier buttons
  let currentDepth    = 1;
  let includeReactions = true;

  const rebuild = async () => {
    const out = document.getElementById('treeOutput');
    if (!out) return;
    out.innerHTML = `<div style="padding:12px;color:var(--text-3);">Building component tree…</div>`;
    try {
      // Use SDE materials as root if available (avoids Fuzzwork for capital/special BPs).
      // Fall back to Fuzzwork for blueprints where we don't have root materials cached.
      const tree = rootMaterials?.length
        ? await buildTreeFromSdeMaterials(rootMaterials, currentDepth, includeReactions)
        : await buildRecursiveMaterialTree(bp.type_id, 1, 0, currentDepth, includeReactions);

      if (!tree || tree.length === 0) {
        out.innerHTML = `<div style="padding:12px;color:var(--text-3);">
          No sub-components found — all materials are raw inputs.</div>`;
        return;
      }

      const flat = flattenTreeToLeaves(tree);

      // Fetch Jita prices for the flat leaf list
      let leafPrices = {};
      try {
        const leafIds = [...flat.keys()];
        if (leafIds.length) leafPrices = await window.eveAPI.getJitaPrices(leafIds) || {};
      } catch (_) {}

      out.innerHTML = renderFlatMaterialList(flat, currentDepth, leafPrices);
    } catch (e) {
      out.innerHTML = `<div style="padding:12px;color:var(--danger);">
        ⚠ Component tree error: ${escHtml(e.message)}</div>`;
      console.error('[ComponentTree]', e);
    }
  };

  container.querySelectorAll('.tier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentDepth = parseInt(btn.dataset.depth);
      container.querySelectorAll('.tier-btn').forEach(b => {
        const active = b === btn;
        b.style.background  = active ? 'var(--accent)' : 'transparent';
        b.style.color       = active ? '#000'          : 'var(--text-2)';
        b.style.border      = active ? '1px solid var(--accent)' : '1px solid var(--border)';
        b.style.fontWeight  = active ? '700' : '400';
      });
      rebuild();
    });
  });

  container.querySelector('#includeReactions')?.addEventListener('change', e => {
    includeReactions = e.target.checked;
    rebuild();
  });

  await rebuild();
}

// Renders a single material row with EVE icon, name, quantity, and optional Jita price
function renderMaterialRow(mat, prices = {}) {
  const isComponent = mat.isComponent;
  const p           = prices[mat.typeId];
  const unitPrice   = p?.sell > 0 ? p.sell : (p?.buy || 0);
  const totalCost   = unitPrice * mat.adjustedQty;
  const saved       = mat.baseQty - mat.adjustedQty;

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;
                border-radius:4px;
                background:${isComponent ? 'var(--bg-card)' : 'transparent'};
                border:1px solid ${isComponent ? 'var(--border)' : 'transparent'};">
      <img src="${ESI_IMAGE}/${mat.typeId}/icon?size=32"
           onerror="this.src='${ESI_IMAGE}/0/icon?size=32';"
           style="width:28px;height:28px;border-radius:3px;flex-shrink:0;">
      <span style="flex:1;color:${isComponent ? 'var(--tier-top)' : 'var(--text-1)'};
                   font-family:var(--font);font-size:13px;font-weight:${isComponent ? '600' : '400'};">
        ${isComponent ? '◈ ' : ''}${escHtml(mat.name || `Type ${mat.typeId}`)}
      </span>
      <span style="font-family:var(--mono);color:var(--text-1);font-size:12px;
                   font-weight:600;min-width:70px;text-align:right;flex-shrink:0;">
        ×${mat.adjustedQty.toLocaleString()}
        ${saved > 0
          ? `<span style="font-size:9px;color:var(--success);margin-left:3px;" title="ME saves ${saved.toLocaleString()}">−${saved.toLocaleString()}</span>`
          : ''}
      </span>
      <span style="font-family:var(--mono);color:var(--text-3);font-size:11px;
                   min-width:100px;text-align:right;flex-shrink:0;">
        ${unitPrice > 0 ? formatNumber(unitPrice) + ' ISK' : '—'}
      </span>
      <span style="font-family:var(--mono);font-size:11px;font-weight:${totalCost > 0 ? '600' : '400'};
                   color:${totalCost > 0 ? 'var(--text-1)' : 'var(--text-3)'};
                   min-width:110px;text-align:right;flex-shrink:0;">
        ${totalCost > 0 ? formatNumber(totalCost) : '—'}
      </span>
    </div>`;
}

// ─── Fuzzwork fallback ────────────────────────────────────────────────────────
// Used when SDE is unavailable. Applies ME bonus to Fuzzwork base quantities.

async function fetchFuzzworkMaterials(typeId, me) {
  const data = await window.eveAPI.getBlueprintMaterials(typeId);
  if (!data || !data.materials?.length) return null;

  const materials = data.materials.map(mat => {
    const baseQty    = mat.quantity;
    const adjustedQty = applyMEBonus(baseQty, me);
    return {
      typeId:      mat.typeid,
      name:        mat.name || `Type ${mat.typeid}`,
      baseQty,
      adjustedQty,
      isComponent: false,
    };
  });

  return {
    materials,
    productTypeId: null,
    productName:   null,
    productQty:    1,
  };
}

// ─── ME bonus formula (EVE industry standard) ────────────────────────────────
// Adjusted qty = max(1, ceil( baseQty × (1 − ME/100) ))
// ME 0 = 0% saving; ME 10 = 10% saving (max).

function applyMEBonus(baseQty, me) {
  if (baseQty <= 1) return 1;
  const factor = 1 - (me / 100);
  return Math.max(1, Math.ceil(baseQty * factor));
}

// ─── Recursive component tree ─────────────────────────────────────────────────
// blueprintTypeId : the blueprint (or reaction formula) type ID to expand

async function getCachedBlueprintMaterials(typeId) {
  const key    = `bp_materials_${typeId}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const data = await window.eveAPI.getBlueprintMaterials(typeId);
  await cacheSet(key, data, 7);
  return data;
}

// quantityRequired: how many of the product we need
// depth           : current recursion depth (starts at 0)
// maxDepth        : stop recursing at this depth; treat node as a leaf (buy it)
// includeReactions: if false, reaction products are treated as leaves

// Known reaction activity IDs in the SDE / Fuzzwork schema.
// Fuzzwork's findBpForProduct returns a `activityID` field on blueprintDetails.
// Manufacturing = 1, Reactions = 11.
const REACTION_ACTIVITY_ID = 11;

async function buildRecursiveMaterialTree(
  blueprintTypeId,
  quantityRequired = 1,
  depth            = 0,
  maxDepth         = 1,
  includeReactions = true
) {
  const data = await getCachedBlueprintMaterials(blueprintTypeId);
  if (!data)                   throw new Error(`No data for blueprint ${blueprintTypeId}`);
  if (!data.materials?.length) return [];

  const components = [];
  for (const mat of data.materials) {
    const totalQty = mat.quantity * quantityRequired;
    let subTree      = null;
    let isReaction   = false;

    // Only try to recurse if we haven't hit the depth ceiling
    if (depth < maxDepth) {
      try {
        const subBpData = await window.eveAPI.findBpForProduct(mat.typeid);
        const entry     = subBpData?.[mat.typeid];
        if (entry?.blueprintDetails) {
          const activityId = entry.blueprintDetails.activityID ?? 1;
          isReaction = (activityId === REACTION_ACTIVITY_ID);

          // Recurse if: it's a manufacturing BP, or reactions are included
          if (!isReaction || includeReactions) {
            const nextBpId = entry.blueprintDetails.blueprintTypeID;
            // totalQty is units of `mat` needed; convert to runs of its blueprint
            // (one run yields productQty units) before recursing.
            const outPerRun = entry.blueprintDetails.productQty || 1;
            const subRuns   = Math.max(1, Math.ceil(totalQty / outPerRun));
            subTree = await buildRecursiveMaterialTree(
              nextBpId, subRuns, depth + 1, maxDepth, includeReactions
            );
          }
        }
      } catch (e) { /* raw material — no sub-blueprint */ }
    }

    components.push({
      typeid:     mat.typeid,
      name:       mat.name || `Type ${mat.typeid}`,
      quantity:   totalQty,
      subTree,          // null = leaf (buy this); array = has sub-materials
      isReaction,       // true = produced via reaction formula
      depth,
    });
  }
  return components;
}

// Flatten the tree into a deduplicated leaf-level shopping list.
// Nodes with no subTree (or whose subTree is empty) are leaves = things to buy.
function flattenTreeToLeaves(nodes, accumulated = new Map()) {
  if (!nodes?.length) return accumulated;
  for (const node of nodes) {
    const hasChildren = node.subTree && node.subTree.length > 0;
    if (!hasChildren) {
      // Leaf — aggregate quantity
      const existing = accumulated.get(node.typeid);
      if (existing) {
        existing.quantity += node.quantity;
      } else {
        accumulated.set(node.typeid, {
          typeid:     node.typeid,
          name:       node.name,
          quantity:   node.quantity,
          isReaction: node.isReaction,
        });
      }
    } else {
      // Intermediate node — recurse into children
      flattenTreeToLeaves(node.subTree, accumulated);
    }
  }
  return accumulated;
}

// Render the flat (aggregated) shopping list as a clean table with Jita prices
function renderFlatMaterialList(flatMap, depth, prices = {}) {
  if (!flatMap.size) return '<div style="padding:12px;color:var(--text-3);">No materials found.</div>';

  const rows = [...flatMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  const depthLabel = depth === 99 ? 'Raw inputs (minerals / moon goo / PI)'
                   : depth === 1  ? 'T1 component breakdown'
                   : depth === 2  ? 'T2 sub-component breakdown'
                   : `Tier ${depth} breakdown`;

  let grandTotal = 0;
  const renderedRows = rows.map(row => {
    const p         = prices[row.typeid];
    const unitPrice = p?.sell > 0 ? p.sell : (p?.buy || 0);
    const rowTotal  = unitPrice * row.quantity;
    if (rowTotal > 0) grandTotal += rowTotal;

    const sourceLabel = row.isReaction
      ? `<span style="color:#ab7ab8;font-size:10px;">⚗ REACT</span>`
      : `<span style="color:var(--text-3);font-size:10px;">◈ MANUF</span>`;

    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
        <td style="padding:7px 8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="https://images.evetech.net/types/${row.typeid}/icon?size=32"
                 onerror="this.onerror=null;this.style.display='none';"
                 style="width:22px;height:22px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <span style="color:var(--text-1);">${escHtml(row.name)}</span>
          </div>
        </td>
        <td style="padding:7px 8px;text-align:right;color:var(--text-1);
                   font-family:var(--mono);font-weight:600;white-space:nowrap;">
          ${row.quantity.toLocaleString()}
        </td>
        <td style="padding:7px 8px;text-align:right;font-family:var(--mono);
                   font-size:11px;color:var(--text-3);white-space:nowrap;">
          ${unitPrice > 0 ? formatNumber(unitPrice) + ' ISK' : '—'}
        </td>
        <td style="padding:7px 8px;text-align:right;font-family:var(--mono);
                   font-size:11px;font-weight:600;color:${rowTotal > 0 ? 'var(--text-1)' : 'var(--text-3)'};
                   white-space:nowrap;">
          ${rowTotal > 0 ? formatNumber(rowTotal) : '—'}
        </td>
        <td style="padding:7px 8px;text-align:center;">${sourceLabel}</td>
      </tr>`;
  }).join('');

  return `
    <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                letter-spacing:0.1em;margin-bottom:6px;padding:0 2px;">
      ${escHtml(depthLabel)} — ${rows.length} item${rows.length !== 1 ? 's' : ''} to source
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:1px solid var(--border);">
          <th style="text-align:left;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--text-3);font-weight:500;letter-spacing:0.08em;">ITEM</th>
          <th style="text-align:right;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--text-3);font-weight:500;letter-spacing:0.08em;">QTY</th>
          <th style="text-align:right;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--text-3);font-weight:500;letter-spacing:0.08em;">JITA SELL/UNIT</th>
          <th style="text-align:right;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--accent);font-weight:500;letter-spacing:0.08em;">TOTAL COST</th>
          <th style="text-align:center;padding:6px 8px;font-family:var(--mono);font-size:9px;
                     color:var(--text-3);font-weight:500;letter-spacing:0.08em;">SOURCE</th>
        </tr>
      </thead>
      <tbody>${renderedRows}</tbody>
    </table>
    ${grandTotal > 0 ? `
    <div style="margin-top:12px;padding:10px 14px;background:var(--bg-card);
                border:1px solid var(--border);border-radius:6px;
                display:flex;align-items:baseline;gap:12px;">
      <span style="font-family:var(--mono);font-size:9px;color:var(--text-3);letter-spacing:0.12em;">
        TOTAL MATERIAL COST (JITA SELL)
      </span>
      <span style="font-family:var(--mono);font-size:18px;font-weight:700;color:var(--accent);margin-left:auto;">
        ${formatNumber(grandTotal)} ISK
      </span>
    </div>` : ''}`;
}

// Legacy tree HTML renderer (kept for renderTreeResults compatibility)
function generateTreeHTML(treeNodes) {
  if (!treeNodes?.length) return '';
  return `
    <ul style="list-style:none;padding-left:20px;border-left:1px dashed var(--border);margin-top:8px;">
      ${treeNodes.map(node => {
        const isComponent = node.subTree && node.subTree.length > 0;
        return `
          <li style="margin:8px 0;">
            <div style="display:flex;justify-content:space-between;align-items:center;
                        padding:6px 10px;
                        background:${isComponent ? 'var(--bg-card)' : 'transparent'};
                        border:1px solid ${isComponent ? 'var(--border)' : 'transparent'};
                        border-radius:var(--radius);">
              <span style="color:${isComponent ? 'var(--tier-top)' : 'var(--text-1)'};
                           font-family:var(--font);font-weight:${isComponent ? '600' : '400'};">
                ${isComponent ? '◈' : '⬡'} ${escHtml(node.name)}
              </span>
              <span style="font-family:var(--mono);color:var(--text-2);">×${node.quantity.toLocaleString()}</span>
            </div>
            ${isComponent ? generateTreeHTML(node.subTree) : ''}
          </li>`;
      }).join('')}
    </ul>`;
}

function renderTreeResults(blueprintName, meLevel, materialTree) {
  const resArea = document.getElementById('results');
  resArea.innerHTML = `
    <div class="panel" style="padding:20px;overflow-y:auto;height:100%;">
      <button onclick="backToLibrary()" style="margin-bottom:20px;padding:6px 12px;
        background:var(--bg-hover);border:1px solid var(--border);color:var(--text-1);
        cursor:pointer;border-radius:var(--radius);font-family:var(--mono);font-size:11px;">
        ← BACK TO LIBRARY
      </button>
      <h2 style="font-size:26px;margin-bottom:8px;color:var(--text-1);">${escHtml(blueprintName)}</h2>
      <div style="display:flex;gap:10px;margin-bottom:24px;">
        <span style="background:var(--bg-card);padding:4px 8px;border-radius:3px;
                     font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
          ME: <span style="color:var(--success);">${meLevel}</span>
        </span>
        <span style="background:var(--bg-card);padding:4px 8px;border-radius:3px;
                     font-family:var(--mono);font-size:11px;border:1px solid var(--border);">
          BATCH: <span style="color:var(--accent);">1 RUN</span>
        </span>
      </div>
      <div style="background:var(--bg-panel);padding:20px;border:1px solid var(--border);border-radius:6px;">
        <h3 style="font-size:12px;letter-spacing:0.1em;color:var(--text-3);
                   margin-bottom:15px;font-family:var(--mono);">FULL MANUFACTURING CHAIN</h3>
        ${generateTreeHTML(materialTree)}
      </div>
    </div>`;
}

function backToLibrary() {
  document.getElementById('mainLibraryView').style.display = 'flex';
  document.getElementById('results').style.display         = 'none';
}

// ─── Industry page tab routing ────────────────────────────────────────────────

function initIndustryPage() {
  document.querySelectorAll('.industry-sub-btn').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      const tab = newBtn.dataset.industryTab;
      if (tab) navigateIndustryTab(tab);
    });
  });

  // Auto-open blueprints if the panel has no rendered content yet.
  // Uses querySelector(:scope > *) so HTML comments don't count as content.
  const content = document.getElementById('industryTabContent');
  if (content && !content.querySelector(':scope > *')) {
    navigateIndustryTab('blueprints');
  }
}

function navigateIndustryTab(tab) {
  currentIndustryTab = tab;
  document.querySelectorAll('.industry-sub-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.industryTab === tab);
  });

  const right = document.getElementById('industryTabContent');
  if (!right) return;

  if (tab === 'blueprints') {
    right.innerHTML = `
      <div id="bpLibWrapper" style="display:flex;flex-direction:column;height:100%;">
        <div class="bp-filter-row" style="padding:12px 16px;border-bottom:1px solid var(--border);
             display:flex;flex-wrap:wrap;gap:10px;background:var(--bg-card);align-items:center;">
          <input id="bpLibSearch"  class="field-input" style="flex:1;min-width:180px;" placeholder="Search your blueprint library..."/>
          <select id="bpLibFilter" class="field-input" style="width:140px;">
            <option value="all">All Blueprints</option>
            <option value="bpo">BPO Only</option>
            <option value="bpc">BPC Only</option>
          </select>
          <select id="bpLibSort" class="field-input" style="width:155px;">
            <option value="name">Name (A–Z)</option>
            <option value="profit">Profit High-Low</option>
            <option value="margin">Margin High-Low</option>
            <option value="output">Output Value</option>
            <option value="group">Group</option>
            <option value="perfect">Perfect First</option>
            <option value="me-perfect">ME Perfect First</option>
            <option value="te-perfect">TE Perfect First</option>
            <option value="me">ME High-Low</option>
            <option value="te">TE High-Low</option>
            <option value="runs">Runs</option>
          </select>
          <input id="bpLibMinME"   class="field-input" type="number" placeholder="Min ME"   style="width:75px;" min="0" max="10"/>
          <input id="bpLibMinTE"   class="field-input" type="number" placeholder="Min TE"   style="width:75px;" min="0" max="20"/>
          <input id="bpLibMinRuns" class="field-input" type="number" placeholder="Min Runs" style="width:85px;" min="0"/>
          <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);margin-left:auto;">
            <span id="bpLibCount">0</span> blueprints
          </span>
        </div>
        <div id="bpFacilityBar" class="bp-facility-mount"></div>
        <div id="bpLibList" class="bp-grid"></div>
      </div>
      <div id="results" style="display:none;height:100%;overflow-y:auto;"></div>`;
    bindLibraryEvents();
    // Facility / build-character controls — changing them re-costs the whole grid.
    _indRenderControls(document.getElementById('bpFacilityBar'), () => {
      _bpEconCache.clear();
      handleLibraryFilter();
    });
    // Always render shimmer skeleton first so the user sees something immediately.
    // If data is already loaded, defer the real render to the next event-loop tick
    // so the browser has a chance to paint the skeleton before the heavy DOM work.
    _renderBpLibLoadingState();
    if (!_bpLibLoading) {
      setTimeout(() => renderBlueprintList(allLibBPs), 0);
    }
    // If _bpLibLoading is true, loadBlueprintLibrary() will call renderBlueprintList
    // when it finishes — no extra action needed here.

  } else if (tab === 'search') {
    right.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;">
        <div style="padding:14px 20px 12px;border-bottom:1px solid var(--border);
                    background:var(--bg-card);flex-shrink:0;position:relative;z-index:10;">
          <div style="font-family:var(--mono);font-size:10px;color:var(--text-3);
                      letter-spacing:0.1em;margin-bottom:8px;">BLUEPRINT SEARCH — ALL EVE BLUEPRINTS</div>
          <div style="position:relative;">
            <input id="bpName" class="field-input"
                   placeholder="Search for any blueprint or item name…"
                   style="width:100%;box-sizing:border-box;padding-right:120px;"/>
            <div style="position:absolute;right:10px;top:50%;transform:translateY(-50%);
                        font-family:var(--mono);font-size:10px;color:var(--text-3);pointer-events:none;">
              ESI TYPE SEARCH
            </div>
            <div id="searchDropdown" class="dropdown" style="display:none;"></div>
          </div>
        </div>
        <div id="results" style="flex:1;overflow-y:auto;min-height:0;"></div>
      </div>`;
    const inp = document.getElementById('bpName');
    if (inp) {
      inp.addEventListener('input', () => {
        clearTimeout(manualSearchTimer);
        manualSearchTimer = setTimeout(handleManualSearchInput, 250);
      });
      inp.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = document.querySelector('#searchDropdown .dropdown-item');
          if (first) first.click();
        }
      });
    }
  } else if (tab === 'cost-index') {
    renderCostIndex(right);

  } else if (tab === 'ore') {
    renderOreCalculator(right);

  } else if (tab === 'ice') {
    renderIceCalculator(right);

  } else if (tab === 'gas') {
    renderGasCalculator(right);

  } else if (tab === 'moon-calc') {
    renderMoonCalculator(right);

  } else if (tab === 'salvage') {
    if (typeof renderSalvageCalculator === 'function') renderSalvageCalculator(right);

  } else if (tab === 'reactions') {
    if (typeof renderReactionsCalculator === 'function') renderReactionsCalculator(right);

  } else if (tab === 'orehold') {
    if (typeof renderOreholdCalc === 'function') renderOreholdCalc(right);

  } else if (tab === 'active-jobs') {
    renderActiveJobsPage(right);

  } else if (tab === 'shopping-lists') {
    if (typeof renderShoppingLists === 'function') renderShoppingLists(right);

  } else if (tab === 'moon') {
    renderMoonReformatter(right);

  } else if (tab === 'planet-size') {
    renderPlanetSizeMapper(right);

  } else {
    const labels = {
      'calculator':     'Blueprint Calculator',
      'shopping-lists': 'Shopping Lists',
    };
    right.innerHTML = `
      <div class="empty-state" style="margin-top:80px;">
        <div class="empty-icon">◈</div>
        <div class="empty-title">${escHtml(labels[tab] || tab).toUpperCase()}</div>
        <div class="empty-sub">Coming soon.</div>
      </div>`;
  }
}

// ─── Moon Ore Calculator ──────────────────────────────────────────────────────
// Values raw moon ores by their FULL reprocessing output — every moon material
// (R16+ ores yield a secondary goo) plus the standard-mineral byproducts — priced
// at the selected hub/method with skill+standing fees. Outputs come from the local
// SDE (invTypeMaterials) for exactness; if the SDE isn't downloaded it falls back
// to a hardcoded primary-moon-material estimate and prompts the user to fetch it.
const MOON_TIER_COLORS = { R4: '#7d8fa3', R8: '#4ecbb0', R16: '#5b9bd5', R32: '#e3a84d', R64: '#c05c7e' };

// The 20 base moon ores (first 4 typeIDs of each Moon Asteroid group in the SDE).
const MOON_ORE_TYPES = [
  { id: 45490, tier: 'R4' },  { id: 45491, tier: 'R4' },  { id: 45492, tier: 'R4' },  { id: 45493, tier: 'R4' },
  { id: 45494, tier: 'R8' },  { id: 45495, tier: 'R8' },  { id: 45496, tier: 'R8' },  { id: 45497, tier: 'R8' },
  { id: 45498, tier: 'R16' }, { id: 45499, tier: 'R16' }, { id: 45500, tier: 'R16' }, { id: 45501, tier: 'R16' },
  { id: 45502, tier: 'R32' }, { id: 45503, tier: 'R32' }, { id: 45504, tier: 'R32' }, { id: 45506, tier: 'R32' },
  { id: 45510, tier: 'R64' }, { id: 45511, tier: 'R64' }, { id: 45512, tier: 'R64' }, { id: 45513, tier: 'R64' },
];

// Fallback (no SDE): primary moon material per ore, base yield per 100-unit batch.
const MOON_MATERIAL_IDS = {
  'Hydrocarbons': 16633, 'Atmospheric Gases': 16634, 'Evaporite Deposits': 16635, 'Silicates': 16636,
  'Tungsten': 16637, 'Titanium': 16638, 'Scandium': 16639, 'Cobalt': 16640,
  'Chromium': 16641, 'Vanadium': 16642, 'Cadmium': 16643, 'Platinum': 16644,
  'Mercury': 16646, 'Caesium': 16647, 'Hafnium': 16648, 'Technetium': 16649,
  'Dysprosium': 16650, 'Neodymium': 16651, 'Promethium': 16652, 'Thulium': 16653,
};
const MOON_FALLBACK = [
  { name: 'Bitumens', tier: 'R4', volume: 10, portionSize: 100, material: 'Hydrocarbons',       matQty: 65 },
  { name: 'Coesite',  tier: 'R4', volume: 10, portionSize: 100, material: 'Silicates',          matQty: 65 },
  { name: 'Sylvite',  tier: 'R4', volume: 10, portionSize: 100, material: 'Evaporite Deposits', matQty: 65 },
  { name: 'Zeolites', tier: 'R4', volume: 10, portionSize: 100, material: 'Atmospheric Gases',  matQty: 65 },
  { name: 'Cobaltite', tier: 'R8', volume: 10, portionSize: 100, material: 'Cobalt',   matQty: 40 },
  { name: 'Euxenite',  tier: 'R8', volume: 10, portionSize: 100, material: 'Scandium', matQty: 40 },
  { name: 'Scheelite', tier: 'R8', volume: 10, portionSize: 100, material: 'Tungsten', matQty: 40 },
  { name: 'Titanite',  tier: 'R8', volume: 10, portionSize: 100, material: 'Titanium', matQty: 40 },
  { name: 'Chromite',   tier: 'R16', volume: 10, portionSize: 100, material: 'Chromium', matQty: 40 },
  { name: 'Otavite',    tier: 'R16', volume: 10, portionSize: 100, material: 'Cadmium',  matQty: 40 },
  { name: 'Sperrylite', tier: 'R16', volume: 10, portionSize: 100, material: 'Platinum', matQty: 40 },
  { name: 'Vanadinite', tier: 'R16', volume: 10, portionSize: 100, material: 'Vanadium', matQty: 40 },
  { name: 'Carnotite', tier: 'R32', volume: 10, portionSize: 100, material: 'Technetium', matQty: 50 },
  { name: 'Cinnabar',  tier: 'R32', volume: 10, portionSize: 100, material: 'Mercury',    matQty: 50 },
  { name: 'Pollucite', tier: 'R32', volume: 10, portionSize: 100, material: 'Caesium',    matQty: 50 },
  { name: 'Zircon',    tier: 'R32', volume: 10, portionSize: 100, material: 'Hafnium',    matQty: 50 },
  { name: 'Loparite',  tier: 'R64', volume: 10, portionSize: 100, material: 'Promethium', matQty: 22 },
  { name: 'Monazite',  tier: 'R64', volume: 10, portionSize: 100, material: 'Neodymium',  matQty: 22 },
  { name: 'Xenotime',  tier: 'R64', volume: 10, portionSize: 100, material: 'Dysprosium', matQty: 22 },
  { name: 'Ytterbite', tier: 'R64', volume: 10, portionSize: 100, material: 'Thulium',    matQty: 22 },
];

let _moonRefineEff = 72.36;
let _moonSort      = { col: 'iskM3', dir: -1 };
let _moonPrices    = {};
let _moonInfo      = null;   // SDE reprocessing keyed by ore typeId, or null when unavailable
let _moonLoading   = false;

// Unified ore rows: { tier, name, volume, portionSize, outputs:[{id,name,qty}] }.
// Uses SDE reprocessing when present, else the primary-material fallback.
function moonOreRows() {
  if (_moonInfo) {
    return MOON_ORE_TYPES.map(o => {
      const info = _moonInfo[o.id];
      if (!info || !info.outputs || !info.outputs.length) return null;
      return {
        tier: o.tier, name: info.name || `Type ${o.id}`,
        volume: info.volume || 10, portionSize: info.portionSize || 100,
        outputs: info.outputs.map(m => ({ id: m.id, name: m.name, qty: m.quantity })),
      };
    }).filter(Boolean);
  }
  return MOON_FALLBACK.map(o => ({
    tier: o.tier, name: o.name, volume: o.volume, portionSize: o.portionSize,
    outputs: [{ id: MOON_MATERIAL_IDS[o.material], name: o.material, qty: o.matQty }],
  }));
}

async function renderMoonCalculator(container) {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  container.innerHTML = `
    <div id="moonCalcWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;
                  padding:12px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;white-space:nowrap;">MOON CALCULATOR</span>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
          <label style="font-size:12px;color:var(--text-2);font-family:var(--mono);">REFINE EFF %</label>
          <input id="moonRefineEff" type="number" min="0" max="100" step="0.01"
                 value="${_moonRefineEff}"
                 class="field-input" style="width:76px;padding:5px 8px;font-size:12px;flex-shrink:0;"
                 title="Reprocessing efficiency — perfect skills no implant = 72.36%, T2 implant = 82.5%"/>
          ${tradeToolbarHtml('moon', accounts)}
          <button id="moonRefreshBtn" class="icon-btn" style="padding:5px 12px;font-size:12px;">⟳ REFRESH</button>
        </div>
        <div id="moonPriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);"></div>
      </div>

      <div style="flex:1;overflow-y:auto;">
        <table id="moonTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);position:sticky;top:0;z-index:1;">
              <th class="moon-th" data-col="tier"     style="text-align:left;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">TIER ↕</th>
              <th class="moon-th" data-col="name"    style="text-align:left;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">MOON ORE ↕</th>
              <th style="text-align:left;padding:10px 8px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">OUTPUTS</th>
              <th class="moon-th" data-col="iskUnit" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">REFINE ISK/UNIT ↕</th>
              <th class="moon-th" data-col="iskM3"   style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:0.1em;color:var(--accent);">REFINE ISK/M³ ↕</th>
            </tr>
          </thead>
          <tbody id="moonTableBody">
            <tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-3);font-family:var(--mono);font-size:12px;">⬡ Fetching prices…</td></tr>
          </tbody>
        </table>
      </div>

      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Net of sales tax (+ broker fee for Sell/Split) at your reprocessing efficiency. <span id="moonModeHint"></span>
      </div>
    </div>`;

  document.getElementById('moonRefineEff').addEventListener('change', e => {
    _moonRefineEff = parseFloat(e.target.value) || 72.36;
    buildMoonTable();
  });
  bindTradeToolbar('moon', () => loadMoonPrices(), () => buildMoonTable());
  updateTradeTaxInfo('moon');
  document.getElementById('moonRefreshBtn').addEventListener('click', () => loadMoonPrices());

  document.querySelectorAll('#moonCalcWrap .moon-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_moonSort.col === col) _moonSort.dir *= -1;
      else { _moonSort.col = col; _moonSort.dir = -1; }
      buildMoonTable();
    });
  });

  await loadMoonPrices();
}

async function loadMoonPrices() {
  if (_moonLoading) return;
  _moonLoading = true;
  const refreshBtn = document.getElementById('moonRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    // Pull exact reprocessing from the local SDE; null/empty → primary-material fallback.
    try {
      const repro = await window.eveAPI.getMoonReprocessing(MOON_ORE_TYPES.map(o => o.id));
      _moonInfo = (repro && Object.keys(repro).length) ? repro : null;
    } catch (_) { _moonInfo = null; }

    const rows     = moonOreRows();
    const priceIds = [...new Set(rows.flatMap(r => r.outputs.map(o => o.id)).filter(Boolean))];
    _moonPrices    = (priceIds.length ? await window.eveAPI.getHubPrices(priceIds, _trade.hub) : {}) || {};

    const hint = document.getElementById('moonModeHint');
    if (hint) hint.textContent = _moonInfo
      ? 'Full reprocessing from SDE — all moon materials + minerals.'
      : 'SDE not found: showing primary moon material only. Run “npm run fetch-sde” for full values.';

    const ageEl = document.getElementById('moonPriceAge');
    if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    buildMoonTable();
  } catch (err) {
    logToConsole(`Moon prices fetch failed: ${err.message}`, 'error');
    const body = document.getElementById('moonTableBody');
    if (body) body.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--danger);font-family:var(--mono);font-size:12px;">⚠ Failed to fetch prices: ${escHtml(err.message)}</td></tr>`;
  } finally {
    _moonLoading = false;
    const btn = document.getElementById('moonRefreshBtn');
    if (btn) btn.disabled = false;
  }
}

function calcMoonRow(ore) {
  const eff = _moonRefineEff / 100, net = tradeNetFactor();
  let perPortion = 0;
  const parts = [];
  for (const o of ore.outputs) {
    const price = tradePrice(_moonPrices[o.id]);
    perPortion += TradeMath.reprocessUnitValue(o.qty, price, eff, 1, net);  // floor(qty*eff)*price*net per portion
    parts.push({ id: o.id, name: o.name, yielded: Math.floor((o.qty || 0) * eff) });
  }
  const iskPerUnit = ore.portionSize ? perPortion / ore.portionSize : 0;
  const iskPerM3   = ore.volume > 0 ? iskPerUnit / ore.volume : 0;
  return { iskPerUnit, iskPerM3, parts };
}

function buildMoonTable() {
  const body = document.getElementById('moonTableBody');
  if (!body) return;
  const tierOrder = { R4: 0, R8: 1, R16: 2, R32: 3, R64: 4 };
  const rows = moonOreRows().map(ore => ({ ore, ...calcMoonRow(ore) }));

  const col = _moonSort.col, dir = _moonSort.dir;
  rows.sort((a, b) => {
    if      (col === 'name')    return dir * a.ore.name.localeCompare(b.ore.name);
    else if (col === 'tier')    return dir * (tierOrder[a.ore.tier] - tierOrder[b.ore.tier]);
    else if (col === 'iskUnit') return dir * (a.iskPerUnit - b.iskPerUnit);
    return dir * (a.iskPerM3 - b.iskPerM3);
  });

  const maxIskM3 = Math.max(...rows.map(r => r.iskPerM3), 1);
  body.innerHTML = rows.map((r, i) => {
    const { ore, iskPerUnit, iskPerM3, parts } = r;
    const tc    = MOON_TIER_COLORS[ore.tier] || 'var(--text-3)';
    const isTop = i === 0;
    const barW  = Math.round((iskPerM3 / maxIskM3) * 100);
    const icons = parts.slice(0, 6).map(p =>
      `<img src="https://images.evetech.net/types/${p.id}/icon?size=32" title="${escHtml(p.name)} ×${formatNumber(p.yielded)}" onerror="this.onerror=null;this.style.display='none';" style="width:20px;height:20px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">`).join('');
    const more  = parts.length > 6 ? `<span style="color:var(--text-3);font-size:10px;">+${parts.length - 6}</span>` : '';
    const tip   = parts.map(p => `${p.name} ×${formatNumber(p.yielded)}`).join(', ');
    return `
      <tr style="border-bottom:1px solid var(--border);background:${isTop ? 'rgba(255,255,255,0.03)' : 'transparent'};${isTop ? 'outline:1px solid var(--accent);' : ''}">
        <td style="padding:10px 14px;white-space:nowrap;"><span style="font-family:var(--mono);font-size:10px;color:${tc};">${ore.tier}</span></td>
        <td style="padding:10px 8px;color:var(--text-1);font-weight:600;">${escHtml(ore.name)}</td>
        <td style="padding:10px 8px;" title="${escHtml(tip)}">
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">${icons}${more}</div>
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);color:var(--text-2);">${iskPerUnit > 0 ? formatNumber(iskPerUnit) : '—'}</td>
        <td style="padding:10px 14px;text-align:right;">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <div style="width:60px;height:4px;background:var(--bg-card);border-radius:2px;overflow:hidden;flex-shrink:0;">
              <div style="height:100%;width:${barW}%;background:${isTop ? 'var(--accent)' : 'var(--text-3)'};border-radius:2px;"></div>
            </div>
            <span style="font-family:var(--mono);font-weight:700;color:${isTop ? 'var(--accent)' : 'var(--text-1)'};">${iskPerM3 > 0 ? formatNumber(iskPerM3) : '—'}</span>
          </div>
        </td>
      </tr>`;
  }).join('');
}

// ─── Moon Scan Reformatter ────────────────────────────────────────────────────
// Takes EVE's raw moon-scan paste (the "Moon Distribution" copy) and reformats
// it into readable per-moon ore lists with percentages — same idea as
// Fuzzwork's ore/reformat tool. Pure client-side text transform; no ESI/SDE.
//
// EVE paste format (tab-separated):
//   Goinard III - Moon 1<tab><tab><tab>
//   <tab>Pyroxeres<tab>0.19<tab>1224<tab>30002053<tab>40137334<tab>40137335
//   <tab>Cobaltite<tab>0.30<tab>45495<tab>...
//   Goinard III - Moon 2<tab>...
// Ore lines start with a tab (empty first column); a non-empty first column is
// a moon header.
function parseMoonScan(text) {
  const moons = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols  = line.split('\t');
    const first = (cols[0] || '').trim();
    const frac  = parseFloat(cols[2]);
    if (!first && cols[1] && cols[1].trim() && !isNaN(frac)) {
      // ore line — only kept if it belongs to a moon header we've seen
      if (cur) cur.ores.push({ name: cols[1].trim(), pct: frac * 100, typeId: (cols[3] || '').trim() });
    } else if (first) {
      cur = { name: first, ores: [] };
      moons.push(cur);
    }
  }
  return moons.filter(m => m.ores.length);
}

function formatMoons(moons, fmt) {
  if (!moons.length) return '';
  const pct  = (p) => p.toFixed(1) + '%';
  // Highest-percentage ore first within each moon.
  const sorted = moons.map(m => ({ name: m.name, ores: m.ores.slice().sort((a, b) => b.pct - a.pct) }));

  if (fmt === 'oneline') {
    return sorted.map(m => `${m.name}: ${m.ores.map(o => `${o.name} ${pct(o.pct)}`).join(', ')}`).join('\n');
  }
  if (fmt === 'tsv') {
    const rows = ['Moon\tOre\tPercent'];
    sorted.forEach(m => m.ores.forEach(o => rows.push(`${m.name}\t${o.name}\t${o.pct.toFixed(1)}`)));
    return rows.join('\n');
  }
  // multiline (default): aligned ore name + right-aligned percentage
  return sorted.map(m => {
    const w = Math.max(0, ...m.ores.map(o => o.name.length));
    const lines = m.ores.map(o => `  ${o.name.padEnd(w)}  ${pct(o.pct).padStart(6)}`);
    return `${m.name}\n${lines.join('\n')}`;
  }).join('\n\n');
}

function renderMoonReformatter(container) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                  padding:12px 18px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);letter-spacing:0.1em;">MOON SCAN REFORMATTER</span>
        <span id="moonStat" style="font-family:var(--mono);font-size:11px;color:var(--text-2);"></span>
        <div style="display:flex;gap:6px;margin-left:auto;align-items:center;">
          <label style="font-size:11px;color:var(--text-3);">Format</label>
          <select id="moonFormat" class="field-input" style="width:170px;padding:4px 8px;font-size:11px;cursor:pointer;">
            <option value="multiline">Multiline</option>
            <option value="oneline">One line per moon</option>
            <option value="tsv">Tab-separated (spreadsheet)</option>
          </select>
          <button id="moonCopyBtn"  class="icon-btn" style="padding:4px 12px;font-size:11px;">⧉ COPY</button>
          <button id="moonClearBtn" class="icon-btn" style="padding:4px 12px;font-size:11px;">✕ CLEAR</button>
        </div>
      </div>
      <div style="flex:1;display:flex;min-height:0;">
        <div style="flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border);">
          <div style="font-size:10px;color:var(--text-3);font-family:var(--mono);letter-spacing:0.1em;padding:8px 14px;">PASTE MOON SCAN</div>
          <textarea id="moonInput" spellcheck="false" placeholder="Paste your moon scan from EVE here (Moon Distribution → copy)…"
            style="flex:1;resize:none;border:none;background:var(--bg-input);color:var(--text-1);font-family:var(--mono);font-size:12px;line-height:1.5;padding:12px 14px;outline:none;min-height:0;"></textarea>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
          <div style="font-size:10px;color:var(--text-3);font-family:var(--mono);letter-spacing:0.1em;padding:8px 14px;">REFORMATTED OUTPUT</div>
          <textarea id="moonOutput" readonly spellcheck="false" placeholder="Reformatted scan appears here…"
            style="flex:1;resize:none;border:none;background:var(--bg-deep);color:var(--text-1);font-family:var(--mono);font-size:12px;line-height:1.5;padding:12px 14px;outline:none;min-height:0;"></textarea>
        </div>
      </div>
    </div>`;

  const input  = container.querySelector('#moonInput');
  const output = container.querySelector('#moonOutput');
  const fmtSel = container.querySelector('#moonFormat');
  const stat   = container.querySelector('#moonStat');

  function refresh() {
    const moons = parseMoonScan(input.value);
    output.value = formatMoons(moons, fmtSel.value);
    const ores  = moons.reduce((n, m) => n + m.ores.length, 0);
    stat.textContent = moons.length
      ? `${moons.length} moon${moons.length !== 1 ? 's' : ''} · ${ores} ore entries`
      : (input.value.trim() ? 'No moon scan data found in paste' : '');
  }

  input.addEventListener('input', refresh);
  fmtSel.addEventListener('change', refresh);
  container.querySelector('#moonCopyBtn').addEventListener('click', () => {
    if (!output.value) return;
    navigator.clipboard.writeText(output.value)
      .then(() => { if (typeof showToast === 'function') showToast('Copied reformatted scan.', 'success'); })
      .catch(() => {});
  });
  container.querySelector('#moonClearBtn').addEventListener('click', () => {
    input.value = ''; refresh(); input.focus();
  });
  refresh();
}

// ─── Planet Size Mapper ───────────────────────────────────────────────────────
// Lists every planet in a region with its diameter (km), grouped by
// constellation, biggest first. Bigger planets give more room to spread PI
// extractor heads — shorter runs, more nodes. All from the local SDE, no ESI.
const PLANET_TYPE_COLORS = {
  Barren: '#b8956a', Temperate: '#4ec9b0', Gas: '#9b8cc4', Ice: '#7fb4d4',
  Lava: '#e0712d', Oceanic: '#3a8fd0', Plasma: '#d04ec0', Storm: '#c4a23a',
};

async function renderPlanetSizeMapper(container) {
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                  padding:12px 18px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);letter-spacing:0.1em;">PLANET SIZE MAPPER</span>
        <span id="psStat" style="font-family:var(--mono);font-size:11px;color:var(--text-2);"></span>
        <div style="display:flex;gap:8px;margin-left:auto;align-items:center;">
          <select id="psRegion" class="field-input" style="width:210px;padding:5px 8px;font-size:12px;cursor:pointer;">
            <option value="">Select region…</option>
          </select>
          <select id="psType" class="field-input" style="width:140px;padding:5px 8px;font-size:12px;cursor:pointer;">
            <option value="">All types</option>
            ${Object.keys(PLANET_TYPE_COLORS).map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="psBody" style="flex:1;overflow-y:auto;min-height:0;">
        <div class="empty-state" style="margin-top:60px;">
          <div class="empty-icon">🪐</div>
          <div class="empty-title">Pick a region</div>
          <div class="empty-sub">Planet diameters help you spot the best PI worlds — bigger = more room to spread extractor heads.</div>
        </div>
      </div>
    </div>`;

  const regionSel = container.querySelector('#psRegion');
  const typeSel   = container.querySelector('#psType');
  const body      = container.querySelector('#psBody');
  const stat      = container.querySelector('#psStat');
  let _planets = [];

  try {
    const regions = await window.eveAPI.sdeGetPlanetRegions();
    (regions || []).forEach(r => {
      const o = document.createElement('option'); o.value = r.id; o.textContent = r.name; regionSel.appendChild(o);
    });
  } catch (_) {}

  async function loadRegion() {
    if (!regionSel.value) {
      body.innerHTML = `<div class="empty-state" style="margin-top:60px;"><div class="empty-icon">🪐</div><div class="empty-title">Pick a region</div></div>`;
      stat.textContent = ''; return;
    }
    body.innerHTML = `<div class="loading-row" style="padding:40px;text-align:center;">Loading planets…</div>`;
    try { _planets = await window.eveAPI.sdeGetRegionPlanets(Number(regionSel.value)) || []; }
    catch (_) { _planets = []; }
    render();
  }

  function render() {
    const type    = typeSel.value;
    const planets = type ? _planets.filter(p => p.type === type) : _planets;
    if (!planets.length) {
      body.innerHTML = `<div class="loading-row" style="padding:40px;text-align:center;">No planets match.</div>`;
      stat.textContent = '0 planets'; return;
    }
    // Group by constellation; constellations ordered by their biggest planet,
    // planets within each ordered by diameter (largest first).
    const groups = new Map();
    planets.forEach(p => { (groups.get(p.con) || groups.set(p.con, []).get(p.con)).push(p); });
    const sections = [...groups.entries()].map(([con, ps]) => {
      ps.sort((a, b) => b.diameterKm - a.diameterKm);
      return { con, ps, max: ps[0].diameterKm };
    }).sort((a, b) => b.max - a.max);

    body.innerHTML = sections.map(sec => `
      <div class="ps-con">
        <div class="ps-con-head">
          <span class="ps-chev">▼</span>
          <span class="ps-con-name">${escHtml(sec.con)}</span>
          <span class="ps-con-meta">${sec.ps.length} planet${sec.ps.length !== 1 ? 's' : ''} · biggest Ø ${sec.max.toLocaleString()} km</span>
        </div>
        <table class="ps-table"><tbody>
          ${sec.ps.map(p => `
            <tr>
              <td class="ps-pname">${escHtml(p.name)}</td>
              <td><span class="ps-type" style="color:${PLANET_TYPE_COLORS[p.type] || 'var(--text-2)'};">${escHtml(p.type)}</span></td>
              <td class="ps-dim">${escHtml(p.sys)}</td>
              <td class="ps-dim ps-right">${p.sec.toFixed(1)}</td>
              <td class="ps-diam ps-right">${p.diameterKm.toLocaleString()} km</td>
            </tr>`).join('')}
        </tbody></table>
      </div>`).join('');
    stat.textContent = `${planets.length} planets · ${sections.length} constellations`;

    body.querySelectorAll('.ps-con-head').forEach(h => h.addEventListener('click', () => {
      const tbl  = h.nextElementSibling;
      const chev = h.querySelector('.ps-chev');
      const hide = tbl.style.display !== 'none';
      tbl.style.display = hide ? 'none' : '';
      chev.textContent  = hide ? '▶' : '▼';
    }));
  }

  regionSel.addEventListener('change', loadRegion);
  typeSel.addEventListener('change', render);
}

// ─── Active Jobs Page ─────────────────────────────────────────────────────────

const _AJ_ACT = {
  1: { label: 'Manufacturing', color: '#4ecbb0' },
  3: { label: 'TE Research',   color: '#4a9fd4' },
  4: { label: 'ME Research',   color: '#ab7ab8' },
  5: { label: 'BP Copy',       color: '#9b59b6' },
  7: { label: 'Reverse Eng.',  color: '#c0392b' },
  8: { label: 'Invention',     color: '#f39c12' },
  9: { label: 'Reaction',      color: '#16a085' },
};

let _ajRefreshTimer = null;

function _ajFmtTime(ms) {
  if (ms <= 0) return 'Done';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function _ajFmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

async function renderActiveJobsPage(container) {
  if (_ajRefreshTimer) { clearInterval(_ajRefreshTimer); _ajRefreshTimer = null; }

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <!-- toolbar -->
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;
                  padding:12px 18px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;">ACTIVE INDUSTRY JOBS</span>
        <span id="ajJobCount" style="font-family:var(--mono);font-size:11px;
               color:var(--text-2);"></span>
        <div style="display:flex;gap:6px;margin-left:auto;">
          <select id="ajFilterActivity" class="field-input"
                  style="width:150px;padding:4px 8px;font-size:11px;">
            <option value="">All Activities</option>
            ${Object.entries(_AJ_ACT).map(([id, a]) =>
              `<option value="${id}">${a.label}</option>`).join('')}
          </select>
          <select id="ajFilterChar" class="field-input"
                  style="width:150px;padding:4px 8px;font-size:11px;">
            <option value="">All Characters</option>
          </select>
          <button id="ajRefreshBtn" class="icon-btn"
                  style="padding:4px 12px;font-size:11px;">⟳ REFRESH</button>
        </div>
      </div>
      <!-- table body -->
      <div style="flex:1;overflow-y:auto;min-height:0;">
        <table id="ajTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:var(--bg-card);border-bottom:2px solid var(--border);
                       position:sticky;top:0;z-index:1;">
              <th class="aj-th" data-col="char"
                  style="text-align:left;padding:10px 14px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;
                         cursor:pointer;white-space:nowrap;">CHARACTER ↕</th>
              <th style="text-align:left;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ITEM</th>
              <th style="text-align:left;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ACTIVITY</th>
              <th class="aj-th" data-col="progress"
                  style="text-align:left;padding:10px 14px;font-family:var(--mono);
                         font-size:10px;color:var(--accent);letter-spacing:0.1em;
                         cursor:pointer;white-space:nowrap;min-width:180px;">PROGRESS ↕</th>
              <th class="aj-th" data-col="end"
                  style="text-align:left;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;
                         cursor:pointer;white-space:nowrap;">ENDS ↕</th>
              <th class="aj-th" data-col="runs"
                  style="text-align:right;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;
                         cursor:pointer;">RUNS ↕</th>
              <th class="aj-th" data-col="cost"
                  style="text-align:right;padding:10px 14px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;
                         cursor:pointer;">COST ↕</th>
              <th style="text-align:left;padding:10px 8px;font-family:var(--mono);
                         font-size:10px;color:var(--text-3);letter-spacing:0.1em;">SYSTEM</th>
            </tr>
          </thead>
          <tbody id="ajTableBody">
            <tr><td colspan="8" style="text-align:center;padding:60px;
                font-family:var(--mono);font-size:12px;color:var(--text-3);">
              ⬡ Loading jobs…
            </td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  let _ajAllJobs   = [];
  let _ajSort      = { col: 'progress', dir: 1 };
  let _ajActFilter = '';
  let _ajCharFilter = '';

  async function loadJobs() {
    const btn = document.getElementById('ajRefreshBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⟳ LOADING…'; }

    try {
      const accounts = await window.eveAPI.getAccounts();
      if (!accounts?.length) {
        document.getElementById('ajTableBody').innerHTML = `
          <tr><td colspan="8" style="text-align:center;padding:60px;
              font-family:var(--mono);font-size:12px;color:var(--text-3);">
            No characters synced.
          </td></tr>`;
        return;
      }

      // Populate character filter
      const charSel = document.getElementById('ajFilterChar');
      if (charSel) {
        charSel.innerHTML = '<option value="">All Characters</option>'
          + accounts.map(a =>
              `<option value="${a.characterId}">${escHtml(a.characterName || a.characterId)}</option>`
            ).join('');
      }

      // Fetch jobs from all characters concurrently
      // character_id is NOT in the ESI response body — must be injected from the request context
      const allRaw = [];
      await Promise.allSettled(accounts.map(async acc => {
        try {
          const jobs = await window.eveAPI.getCharacterActiveJobs(acc.characterId);
          if (Array.isArray(jobs)) {
            jobs.forEach(j => allRaw.push({
              ...j,
              character_id: acc.characterId,
              _charName:    acc.characterName || `Char ${acc.characterId}`,
            }));
          }
        } catch (_) {}
      }));

      // Resolve type names for all blueprint + product IDs
      const typeIds = [...new Set(
        allRaw.flatMap(j => [j.blueprint_type_id, j.product_type_id].filter(Boolean))
      )];
      const nameMap = {};
      if (typeIds.length) {
        try {
          const arr = await window.eveAPI.getNames(typeIds);
          if (Array.isArray(arr)) arr.forEach(e => { if (e.id && e.name) nameMap[e.id] = e.name; });
        } catch (_) {}
        // SDE fallback for any still-missing
        await Promise.allSettled(typeIds.filter(id => !nameMap[id]).map(async id => {
          try { const n = await window.eveAPI.sdeGetName(id); if (n) nameMap[id] = n; } catch (_) {}
        }));
      }

      const activeRaw = allRaw.filter(j => ['active','ready','paused'].includes(j.status));

      // Resolve system names via SDE (offline, no ESI dependency)
      const sysIds = [...new Set(activeRaw.map(j => j.solar_system_id).filter(Boolean))];
      let sysNames = {};
      if (sysIds.length) {
        try { sysNames = await window.eveAPI.sdeGetSystemNames(sysIds) || {}; } catch (_) {}
        // ESI top-up for any SDE gaps
        const missing = sysIds.filter(id => !sysNames[id]);
        if (missing.length) {
          try {
            const esiMap = await window.eveAPI.resolveSystemNames(missing) || {};
            Object.assign(sysNames, esiMap);
          } catch (_) {}
        }
      }

      // Fallback: jobs where solar_system_id = 0 → resolve via facility_id (NPC stations in SDE)
      const facilityIds = [...new Set(
        activeRaw.filter(j => !j.solar_system_id && j.facility_id).map(j => j.facility_id)
      )];
      let facilityToSys = {};
      if (facilityIds.length) {
        try { facilityToSys = await window.eveAPI.sdeFacilityToSystem(facilityIds) || {}; } catch (_) {}
      }

      _ajAllJobs = activeRaw.map(j => ({
        ...j,
        _bpName:     nameMap[j.blueprint_type_id] || `Type ${j.blueprint_type_id}`,
        _prodName:   j.product_type_id ? (nameMap[j.product_type_id] || `Type ${j.product_type_id}`) : null,
        _displayId:  j.product_type_id || j.blueprint_type_id,
        _systemName: (j.solar_system_id && sysNames[j.solar_system_id])
                  || (j.facility_id    && facilityToSys[j.facility_id])
                  || (j.solar_system_id ? `System ${j.solar_system_id}` : null)
                  || '—',
      }));

      renderAJTable();
    } catch (err) {
      console.error('[ActiveJobs]', err);
      document.getElementById('ajTableBody').innerHTML = `
        <tr><td colspan="8" style="text-align:center;padding:60px;
            font-family:var(--mono);font-size:12px;color:var(--danger);">
          ⚠ Failed to load jobs: ${escHtml(err.message)}
        </td></tr>`;
    } finally {
      const btn2 = document.getElementById('ajRefreshBtn');
      if (btn2) { btn2.disabled = false; btn2.textContent = '⟳ REFRESH'; }
    }
  }

  function renderAJTable() {
    const body     = document.getElementById('ajTableBody');
    const countEl  = document.getElementById('ajJobCount');
    if (!body) return;

    const now = Date.now();
    let jobs = _ajAllJobs.slice();

    // Filters
    if (_ajActFilter) jobs = jobs.filter(j => String(j.activity_id) === _ajActFilter);
    if (_ajCharFilter) jobs = jobs.filter(j => String(j.character_id) === _ajCharFilter);

    // Sort
    const statusOrder = { active: 0, ready: 1, paused: 2 };
    jobs.sort((a, b) => {
      const d = _ajSort.dir;
      if (_ajSort.col === 'char')     return d * a._charName.localeCompare(b._charName);
      if (_ajSort.col === 'runs')     return d * ((a.runs ?? 1) - (b.runs ?? 1));
      if (_ajSort.col === 'cost')     return d * ((a.cost ?? 0) - (b.cost ?? 0));
      if (_ajSort.col === 'end') {
        return d * (new Date(a.end_date || 0) - new Date(b.end_date || 0));
      }
      // Default: progress (time remaining asc, ready last)
      const oa = statusOrder[a.status] ?? 3, ob = statusOrder[b.status] ?? 3;
      if (oa !== ob) return d * (oa - ob);
      return d * (new Date(a.end_date || 0) - new Date(b.end_date || 0));
    });

    if (countEl) {
      const chars = new Set(jobs.map(j => j.character_id)).size;
      countEl.textContent = jobs.length
        ? `${jobs.length} job${jobs.length !== 1 ? 's' : ''} · ${chars} character${chars !== 1 ? 's' : ''}`
        : '';
    }

    if (!jobs.length) {
      body.innerHTML = `
        <tr><td colspan="8" style="text-align:center;padding:60px;
            font-family:var(--mono);font-size:12px;color:var(--text-3);">
          ⬡ No active industry jobs.
        </td></tr>`;
      return;
    }

    body.innerHTML = jobs.map(job => {
      const act       = _AJ_ACT[job.activity_id] || { label: `Act ${job.activity_id}`, color: 'var(--text-3)' };
      const itemId    = job._displayId;
      const icon64    = `https://images.evetech.net/types/${itemId}/icon?size=64`;
      const icon32    = `https://images.evetech.net/types/${itemId}/icon?size=32`;
      const iconBp    = `https://images.evetech.net/types/${itemId}/bp?size=32`;

      const itemIcon = itemId
        ? `<img src="${icon64}" style="width:26px;height:26px;border-radius:3px;
                    border:1px solid var(--border);flex-shrink:0;background:var(--bg-deep);"
               onerror="if(this.src==='${icon64}'){this.src='${icon32}'}else if(this.src==='${icon32}'){this.src='${iconBp}'}else{this.style.display='none'}">`
        : '';

      const charPortrait = `<img src="https://images.evetech.net/characters/${job.character_id}/portrait?size=32"
        style="width:22px;height:22px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;"
        onerror="this.style.display='none'">`;

      // Item cell: bp name + arrow + product name (for mfg/invention)
      const nameDisplay = job._prodName && job._prodName !== job._bpName
        ? `<span style="color:var(--text-1);">${escHtml(job._prodName)}</span>
           <span style="font-size:10px;color:var(--text-3);font-family:var(--mono);display:block;">
             from ${escHtml(job._bpName)}
           </span>`
        : `<span style="color:var(--text-1);">${escHtml(job._bpName)}</span>`;

      // Progress cell
      let progressCell;
      if (job.status === 'ready') {
        progressCell = `
          <td style="padding:10px 14px;">
            <span style="font-family:var(--mono);font-size:11px;font-weight:700;
                         color:var(--success);letter-spacing:0.05em;">✓ READY TO DELIVER</span>
          </td>`;
      } else if (job.status === 'paused') {
        progressCell = `
          <td style="padding:10px 14px;">
            <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);">⏸ PAUSED</span>
          </td>`;
      } else {
        const start = new Date(job.start_date).getTime();
        const end   = new Date(job.end_date).getTime();
        const pct   = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
        const left  = Math.max(0, end - now);
        const fillCol = pct >= 90 ? '#4ecbb0' : pct >= 50 ? 'var(--accent)' : '#c0392b';
        progressCell = `
          <td style="padding:10px 14px;">
            <div style="display:flex;flex-direction:column;gap:4px;">
              <div style="height:5px;background:var(--bg-card);border-radius:3px;
                          overflow:hidden;min-width:140px;">
                <div style="height:100%;width:${pct.toFixed(1)}%;background:${fillCol};
                            border-radius:3px;transition:width 0.3s;"></div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;">
                <span style="font-family:var(--mono);font-size:10px;color:var(--text-2);">
                  ${_ajFmtTime(left)} left
                </span>
                <span style="font-family:var(--mono);font-size:9px;color:var(--text-3);">
                  ${pct.toFixed(0)}%
                </span>
              </div>
            </div>
          </td>`;
      }

      const endDate = job.status === 'ready'
        ? `<td style="padding:10px 8px;font-family:var(--mono);font-size:10px;
                      color:var(--success);">Completed</td>`
        : `<td style="padding:10px 8px;font-family:var(--mono);font-size:10px;
                      color:var(--text-3);white-space:nowrap;">${_ajFmtDate(job.end_date)}</td>`;

      const costCell = job.cost > 0
        ? `<td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                      font-size:11px;color:var(--text-2);">${formatNumber(job.cost)}</td>`
        : `<td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                      font-size:11px;color:var(--text-3);">—</td>`;

      const probBadge = job.probability != null && job.activity_id === 8
        ? `<span style="font-family:var(--mono);font-size:9px;color:var(--text-3);
                        margin-left:4px;">${(job.probability * 100).toFixed(0)}%</span>`
        : '';

      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:10px 14px;white-space:nowrap;">
          <div style="display:flex;align-items:center;gap:7px;">
            ${charPortrait}
            <span style="color:var(--text-1);font-size:12px;">${escHtml(job._charName)}</span>
          </div>
        </td>
        <td style="padding:10px 8px;max-width:260px;">
          <div style="display:flex;align-items:flex-start;gap:8px;">
            ${itemIcon}
            <div>${nameDisplay}</div>
          </div>
        </td>
        <td style="padding:10px 8px;white-space:nowrap;">
          <span style="display:inline-block;padding:2px 9px;border-radius:3px;
                       font-family:var(--mono);font-size:10px;font-weight:700;
                       background:${act.color}22;color:${act.color};
                       border:1px solid ${act.color}44;">
            ${act.label}
          </span>
          ${probBadge}
        </td>
        ${progressCell}
        ${endDate}
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);
                   font-size:11px;color:var(--text-2);">${(job.runs ?? 1).toLocaleString()}×</td>
        ${costCell}
        <td style="padding:10px 8px;font-family:var(--mono);font-size:11px;
                   color:var(--text-3);white-space:nowrap;">
          ${escHtml(job._systemName || '—')}
        </td>
      </tr>`;
    }).join('');
  }

  // ── Wire controls ────────────────────────────────────────────────────────────
  container.addEventListener('change', e => {
    if (e.target.id === 'ajFilterActivity') { _ajActFilter  = e.target.value; renderAJTable(); }
    if (e.target.id === 'ajFilterChar')     { _ajCharFilter = e.target.value; renderAJTable(); }
  });

  container.addEventListener('click', e => {
    const th = e.target.closest('.aj-th');
    if (th) {
      const col = th.dataset.col;
      if (_ajSort.col === col) _ajSort.dir *= -1;
      else { _ajSort.col = col; _ajSort.dir = 1; }
      renderAJTable();
    }
    if (e.target.closest('#ajRefreshBtn')) loadJobs();
  });

  // ── Auto-refresh progress bars every 30s ─────────────────────────────────────
  _ajRefreshTimer = setInterval(() => {
    if (document.getElementById('ajTableBody')) renderAJTable();
    else { clearInterval(_ajRefreshTimer); _ajRefreshTimer = null; }
  }, 30000);

  await loadJobs();
}

// ─── Stubs (prevent crashes) ──────────────────────────────────────────────────
function buildCategoryBrowse()        { console.log('Category build stub'); }
function handleBlueprintSearch(query) { console.log('Search stub:', query); }
// handleManualSearchInput is expected to be defined in the search/calculator module.
// This fallback prevents a ReferenceError if it hasn't loaded yet.
if (typeof handleManualSearchInput === 'undefined') {
  window.handleManualSearchInput = function() {
    console.warn('handleManualSearchInput not yet loaded — search module missing?');
  };
}
// ─── Ore Calculator ───────────────────────────────────────────────────────────
// Mirrors the Fuzzwork ore/M3 page:
//   - Pulls Jita 4-4 sell prices for all minerals via the existing getJitaPrices IPC
//   - Displays ore refine yields, ISK/M3, ISK/unit, and raw ore sell price
//   - Lets the user adjust refining efficiency and tax
//   - Sortable columns
//   - Groups: Highsec / Lowsec & Null / Ice (ore only here; ice has its own tab)

// ── Ore data ─────────────────────────────────────────────────────────────────
// typeId matches ESI / SDE. Mineral yields are the base per-100-unit batch.
// volume = m³ per unit.  batchSize = units needed to refine (standard is 100).

const ORE_DATA = [
  // ── Highsec ──────────────────────────────────────────────────────────────
  {
    name:'Veldspar',    typeId:1230,  group:'Highsec',  volume:0.1,  batchSize:100,
    minerals:{ Tritanium:400 }
  },
  {
    name:'Scordite',    typeId:1228,  group:'Highsec',  volume:0.15, batchSize:100,
    minerals:{ Tritanium:150, Pyerite:110 }
  },
  {
    name:'Pyroxeres',   typeId:1224,  group:'Highsec',  volume:0.3,  batchSize:100,
    minerals:{ Pyerite:90, Mexallon:30 }
  },
  {
    name:'Plagioclase', typeId:18,    group:'Highsec',  volume:0.35, batchSize:100,
    minerals:{ Tritanium:175, Mexallon:70 }
  },
  // ── Lowsec ───────────────────────────────────────────────────────────────
  {
    name:'Omber',       typeId:1227,  group:'Lowsec',   volume:0.6,  batchSize:100,
    minerals:{ Pyerite:90, Isogen:75 }
  },
  {
    name:'Kernite',     typeId:20,    group:'Lowsec',   volume:1.2,  batchSize:100,
    minerals:{ Mexallon:60, Isogen:120 }
  },
  // ── Nullsec / 0.0 ────────────────────────────────────────────────────────
  {
    name:'Jaspet',      typeId:1226,  group:'Nullsec',  volume:2,    batchSize:100,
    minerals:{ Mexallon:150, Nocxium:50 }
  },
  {
    name:'Hemorphite',  typeId:1231,  group:'Nullsec',  volume:3,    batchSize:100,
    minerals:{ Isogen:240, Nocxium:90 }
  },
  {
    name:'Hedbergite',  typeId:21,    group:'Nullsec',  volume:3,    batchSize:100,
    minerals:{ Pyerite:450, Nocxium:120 }
  },
  {
    name:'Gneiss',      typeId:1229,  group:'Nullsec',  volume:5,    batchSize:100,
    minerals:{ Pyerite:2000, Mexallon:1500, Isogen:800 }
  },
  // Verified against the local SDE: Gneiss = 1229, Hemorphite = 1231 (these used to
  // collide on 1229). All base-ore yields above match the SDE / ore.cerlestes.de.
  {
    name:'Dark Ochre',  typeId:1232,  group:'Nullsec',  volume:8,    batchSize:100,
    minerals:{ Mexallon:1360, Isogen:1200, Nocxium:320 }
  },
  {
    name:'Crokite',     typeId:1225,  group:'Nullsec',  volume:16,   batchSize:100,
    minerals:{ Pyerite:800, Mexallon:2000, Nocxium:800 }
  },
  {
    name:'Spodumain',   typeId:19,    group:'Nullsec',  volume:16,   batchSize:100,
    minerals:{ Tritanium:48000, Isogen:1000, Nocxium:160, Zydrine:80, Megacyte:40 }
  },
  {
    name:'Bistot',      typeId:1223,  group:'Nullsec',  volume:16,   batchSize:100,
    minerals:{ Pyerite:3200, Mexallon:1200, Zydrine:160 }
  },
  {
    name:'Arkonor',     typeId:22,    group:'Nullsec',  volume:16,   batchSize:100,
    minerals:{ Pyerite:3200, Mexallon:1200, Megacyte:120 }
  },
  {
    name:'Mercoxit',    typeId:11396, group:'Nullsec',  volume:40,   batchSize:100,
    minerals:{ Morphite:140 }
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Shared trade settings for the Ore / Ice / Gas calculators
// ───────────────────────────────────────────────────────────────────────────
// One state object drives all three calcs: which hub to price against, which
// price method (sell/buy/split), and the market tax derived from the selected
// character's Accounting + Broker Relations skills and NPC standings toward the
// hub owner. Owner corp / faction IDs match the backend HUBS map in esi_ipc.js.
const TRADE_HUB_META = {
  jita:    { label: 'Jita',    ownerCorpId: 1000035, factionId: 500001 },
  amarr:   { label: 'Amarr',   ownerCorpId: 1000086, factionId: 500003 },
  dodixie: { label: 'Dodixie', ownerCorpId: 1000120, factionId: 500004 },
  rens:    { label: 'Rens',    ownerCorpId: 1000049, factionId: 500002 },
  hek:     { label: 'Hek',     ownerCorpId: 1000057, factionId: 500002 },
};
const TRADE_BASE_SALES_TAX  = 0.08;  // 8% base (TQ); −11% per Accounting level
const TRADE_BASE_BROKER_FEE = 0.03;  // 3% base at NPC station; reduced by skill + standings

// Persisted across calc re-renders within the session.
let _trade = {
  characterId: null,
  hub:    'jita',
  method: 'sell',           // 'sell' | 'buy' | 'split'
  accounting: 5,            // defaults assume perfect skills until a char is chosen
  brokerRelations: 5,
  standings: {},            // { fromId: standing }
  loaded: false,            // true once a real character profile has been pulled
};

// Thin wrappers over the pure TradeMath module (src/func/trade-math.js, loaded
// before this file) — they read the shared _trade state and delegate the math so
// it stays unit-testable under Node.
function tradeSalesTax() {
  return TradeMath.salesTax(_trade.accounting, TRADE_BASE_SALES_TAX);
}
function tradeBrokerFee() {
  const meta = TRADE_HUB_META[_trade.hub] || TRADE_HUB_META.jita;
  return TradeMath.brokerFee(
    _trade.brokerRelations,
    _trade.standings[meta.factionId]   || 0,
    _trade.standings[meta.ownerCorpId] || 0,
    TRADE_BASE_BROKER_FEE,
  );
}
function tradeNetFactor() {
  return TradeMath.netFactor(_trade.method, tradeSalesTax(), tradeBrokerFee());
}
function tradePrice(p) {
  return TradeMath.pickPrice(p, _trade.method);
}

// Pull the selected character's trade profile (skills + standings) into _trade.
async function loadTradeProfile() {
  if (!_trade.characterId) { _trade.loaded = false; return; }
  try {
    const prof = await window.eveAPI.getTradeProfile(_trade.characterId);
    if (prof) {
      if (prof.accounting != null)      _trade.accounting      = prof.accounting;
      if (prof.brokerRelations != null) _trade.brokerRelations = prof.brokerRelations;
      _trade.standings = prof.standings || {};
      _trade.loaded    = (prof.accounting != null);
    }
  } catch (_) { /* keep current defaults */ }
}

// Shared toolbar controls. `prefix` namespaces element ids per calculator.
function tradeToolbarHtml(prefix, accounts) {
  const charOpts = ['<option value="">Perfect skills</option>']
    .concat((accounts || []).map(a =>
      `<option value="${a.characterId}" ${String(a.characterId) === String(_trade.characterId) ? 'selected' : ''}>${escHtml(a.characterName || ('Char ' + a.characterId))}</option>`))
    .join('');
  const hubOpts = Object.entries(TRADE_HUB_META).map(([k, v]) =>
    `<option value="${k}" ${k === _trade.hub ? 'selected' : ''}>${v.label}</option>`).join('');
  const methodOpts = [['sell', 'Sell'], ['buy', 'Buy'], ['split', 'Split']].map(([k, l]) =>
    `<option value="${k}" ${k === _trade.method ? 'selected' : ''}>${l}</option>`).join('');
  // Compact, fixed-width selects so the controls sit inline on one row (like the
  // cost-index toolbar) instead of stretching full-width and stacking.
  const base = 'class="field-input" style="padding:5px 8px;font-size:12px;flex-shrink:0;';
  return `
    <select id="${prefix}Char"   ${base}width:150px;" title="Character — skills & standings drive the tax">${charOpts}</select>
    <select id="${prefix}Hub"    ${base}width:96px;"  title="Trade hub (price source + broker standings)">${hubOpts}</select>
    <select id="${prefix}Method" ${base}width:92px;"  title="Sell order / Buy order / Split">${methodOpts}</select>
    <span id="${prefix}TaxInfo" style="font-size:10px;color:var(--text-3);font-family:var(--mono);white-space:nowrap;flex-shrink:0;"></span>`;
}

// Wire the shared toolbar. reloadPrices() refetches from the new hub; rebuildTable()
// just recomputes with current prices.
function bindTradeToolbar(prefix, reloadPrices, rebuildTable) {
  const charSel   = document.getElementById(`${prefix}Char`);
  const hubSel    = document.getElementById(`${prefix}Hub`);
  const methodSel = document.getElementById(`${prefix}Method`);
  if (charSel) charSel.addEventListener('change', async (e) => {
    _trade.characterId = e.target.value || null;
    if (_trade.characterId) {
      await loadTradeProfile();
    } else {
      _trade.accounting = 5; _trade.brokerRelations = 5; _trade.standings = {}; _trade.loaded = false;
    }
    updateTradeTaxInfo(prefix);
    rebuildTable();
  });
  if (hubSel) hubSel.addEventListener('change', (e) => {
    _trade.hub = e.target.value || 'jita';
    updateTradeTaxInfo(prefix);
    reloadPrices();
  });
  if (methodSel) methodSel.addEventListener('change', (e) => {
    _trade.method = e.target.value || 'sell';
    updateTradeTaxInfo(prefix);
    rebuildTable();
  });
}

// Refresh the "Sales tax X% · Broker Y%" hint in a calculator toolbar.
function updateTradeTaxInfo(prefix) {
  const el = document.getElementById(`${prefix}TaxInfo`);
  if (!el) return;
  const st = (tradeSalesTax() * 100).toFixed(2);
  const bf = (tradeBrokerFee() * 100).toFixed(2);
  const brokerPart = _trade.method === 'buy' ? '' : ` · Broker ${bf}%`;
  const note = _trade.characterId
    ? (_trade.loaded ? '' : ' · sync char for live skills/standings')
    : ' · perfect skills';
  el.textContent = `Sales tax ${st}%${brokerPart}${note}`;
}

// Mineral type IDs (Jita prices fetched for these)
const MINERAL_IDS = {
  Tritanium: 34,
  Pyerite:   35,
  Mexallon:  36,
  Isogen:    37,
  Nocxium:   38,
  Zydrine:   39,
  Megacyte:  40,
  Morphite:  11399,
};

// Ore raw sell type IDs so we can show "sell raw" price too.
// Verified against the local SDE: Gneiss = 1229 and Hemorphite = 1231 (these two
// previously collided on 1229). All IDs below are the base-ore typeIDs.
const ORE_SELL_IDS = {
  Veldspar:1230, Scordite:1228, Pyroxeres:1224, Plagioclase:18,
  Omber:1227, Kernite:20, Jaspet:1226, Hemorphite:1231,
  Hedbergite:21, Gneiss:1229, 'Dark Ochre':1232, Crokite:1225,
  Spodumain:19, Bistot:1223, Arkonor:22, Mercoxit:11396,
};

// ── State for the ore calculator ─────────────────────────────────────────────
let _oreRefineEff  = 72.36;   // % – the Fuzzwork default (perfect skills no implant)
let _oreSort       = { col: 'iskM3', dir: -1 };
let _orePrices     = {};       // typeId → { sell, buy }
let _oreLoading    = false;

async function renderOreCalculator(container) {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  container.innerHTML = `
    <div id="oreCalcWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <!-- toolbar -->
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;
                  padding:12px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;">ORE CALCULATOR</span>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
          <label style="font-size:12px;color:var(--text-2);font-family:var(--mono);">REFINE EFF %</label>
          <input id="oreRefineEff" type="number" min="0" max="100" step="0.01"
                 value="${_oreRefineEff}"
                 class="field-input" style="width:76px;padding:5px 8px;font-size:12px;"
                 title="Refining efficiency (perfect skills + T2 implant ≈ 82.5%, NPC station max = 72.36%)"/>
          ${tradeToolbarHtml('ore', accounts)}
          <button id="oreRefreshBtn" class="icon-btn"
                  style="padding:5px 12px;font-size:12px;">⟳ REFRESH</button>
        </div>
        <div id="orePriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);"></div>
      </div>

      <!-- mineral price strip -->
      <div id="oreMineralStrip" style="display:flex;gap:0;border-bottom:1px solid var(--border);
           background:var(--bg-panel);flex-shrink:0;overflow-x:auto;">
        ${Object.keys(MINERAL_IDS).map(m => `
          <div style="padding:6px 14px;border-right:1px solid var(--border);white-space:nowrap;">
            <div style="font-size:9px;color:var(--text-3);font-family:var(--mono);letter-spacing:0.08em;">${m.toUpperCase()}</div>
            <div id="mPrice_${m}" style="font-size:11px;color:var(--accent);font-family:var(--mono);">…</div>
          </div>`).join('')}
      </div>

      <!-- table -->
      <div style="flex:1;overflow-y:auto;">
        <table id="oreTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                       position:sticky;top:0;z-index:1;">
              <th class="ore-th" data-col="group"   style="text-align:left;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">GROUP ↕</th>
              <th class="ore-th" data-col="name"    style="text-align:left;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ORE ↕</th>
              <th class="ore-th" data-col="vol"     style="text-align:right;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">M³/UNIT ↕</th>
              <th style="text-align:right;padding:10px 8px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">MINERALS / BATCH</th>
              <th class="ore-th" data-col="iskUnit" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">REFINE ISK/UNIT ↕</th>
              <th class="ore-th" data-col="iskM3"   style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;color:var(--accent);">REFINE ISK/M³ ↕</th>
              <th class="ore-th" data-col="sellRaw" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RAW SELL/UNIT ↕</th>
              <th class="ore-th" data-col="sellM3"  style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RAW SELL/M³ ↕</th>
            </tr>
          </thead>
          <tbody id="oreTableBody">
            <tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-3);
                font-family:var(--mono);font-size:12px;">⬡ Fetching Jita prices…</td></tr>
          </tbody>
        </table>
      </div>

      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Prices from the selected hub. ISK is net of sales tax (+ broker fee for Sell/Split).
        Refine ISK uses your efficiency setting; Raw = sell the ore unprocessed.
      </div>
    </div>`;

  // Bind toolbar controls
  document.getElementById('oreRefineEff').addEventListener('change', e => {
    _oreRefineEff = parseFloat(e.target.value) || 72.36;
    buildOreTable();
  });
  bindTradeToolbar('ore', () => loadOrePrices(), () => buildOreTable());
  updateTradeTaxInfo('ore');
  document.getElementById('oreRefreshBtn').addEventListener('click', () => loadOrePrices());

  // Sortable column headers
  document.querySelectorAll('#oreCalcWrap .ore-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_oreSort.col === col) _oreSort.dir *= -1;
      else { _oreSort.col = col; _oreSort.dir = -1; }
      buildOreTable();
    });
  });

  await loadOrePrices();
}

async function loadOrePrices() {
  if (_oreLoading) return;
  _oreLoading = true;
  const refreshBtn = document.getElementById('oreRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    // Collect all type IDs we need prices for: minerals + raw ores
    const mineralIds = Object.values(MINERAL_IDS);
    const oreIds     = Object.values(ORE_SELL_IDS);
    const allIds     = [...new Set([...mineralIds, ...oreIds])];

    const raw = await window.eveAPI.getHubPrices(allIds, _trade.hub);
    _orePrices = raw || {};

    // Update mineral price strip
    for (const [mName, mId] of Object.entries(MINERAL_IDS)) {
      const el = document.getElementById(`mPrice_${mName}`);
      if (!el) continue;
      const price = tradePrice(_orePrices[mId]);
      el.textContent = price > 0 ? formatNumber(price) + ' ISK' : '—';
    }

    const ageEl = document.getElementById('orePriceAge');
    if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    buildOreTable();
  } catch (err) {
    logToConsole(`Ore prices fetch failed: ${err.message}`, 'error');
    const body = document.getElementById('oreTableBody');
    if (body) body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;
      color:var(--danger);font-family:var(--mono);font-size:12px;">
      ⚠ Failed to fetch prices: ${escHtml(err.message)}</td></tr>`;
  } finally {
    _oreLoading = false;
    const btn = document.getElementById('oreRefreshBtn');
    if (btn) btn.disabled = false;
  }
}

function calcOreRow(ore) {
  const effFactor = (_oreRefineEff / 100);
  const netFactor = tradeNetFactor();               // sales tax (+ broker, per method)

  // Mineral value for one batch after refining efficiency + market fees
  let batchMineralISK = 0;
  for (const [mName, baseQty] of Object.entries(ore.minerals)) {
    const price  = tradePrice(_orePrices[MINERAL_IDS[mName]]);  // sell / buy / split
    const actual = Math.floor(baseQty * effFactor);            // EVE floors refined minerals
    batchMineralISK += actual * price * netFactor;
  }

  const iskPerUnit = batchMineralISK / ore.batchSize;
  const iskPerM3   = iskPerUnit / ore.volume;

  // Raw ore sale proceeds (per unit), same method + fees as refined
  const rawSellUnit = tradePrice(_orePrices[ORE_SELL_IDS[ore.name]]) * netFactor;
  const rawSellM3   = rawSellUnit / ore.volume;

  return { iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 };
}

function buildOreTable() {
  const body = document.getElementById('oreTableBody');
  if (!body) return;

  // Compute values for every ore, attach for sorting
  const rows = ORE_DATA.map(ore => {
    const { iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 } = calcOreRow(ore);
    return { ore, iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 };
  });

  // Sort
  const col = _oreSort.col;
  const dir = _oreSort.dir;
  rows.sort((a, b) => {
    let va, vb;
    if      (col === 'name')    { va = a.ore.name;  vb = b.ore.name; return dir * va.localeCompare(vb); }
    else if (col === 'group')   { va = a.ore.group; vb = b.ore.group; return dir * va.localeCompare(vb); }
    else if (col === 'vol')     { va = a.ore.volume; vb = b.ore.volume; }
    else if (col === 'iskUnit') { va = a.iskPerUnit; vb = b.iskPerUnit; }
    else if (col === 'iskM3')   { va = a.iskPerM3;   vb = b.iskPerM3; }
    else if (col === 'sellRaw') { va = a.rawSellUnit; vb = b.rawSellUnit; }
    else if (col === 'sellM3')  { va = a.rawSellM3;  vb = b.rawSellM3; }
    else                        { va = a.iskPerM3;   vb = b.iskPerM3; }
    return dir * (va - vb);
  });

  // Find max ISK/M3 for a visual bar
  const maxIskM3 = Math.max(...rows.map(r => r.iskPerM3), 1);

  // Group colour chips
  const groupColors = { Highsec: '#4ecbb0', Lowsec: '#e3a84d', Nullsec: '#c05c7e' };

  body.innerHTML = rows.map((r, i) => {
    const { ore, iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 } = r;
    const gc    = groupColors[ore.group] || 'var(--text-3)';
    const barW  = Math.round((iskPerM3 / maxIskM3) * 100);
    const isTop = i === 0;

    // Compact mineral yield summary
    const minSummary = Object.entries(ore.minerals).map(([mn, qty]) => {
      const actual = Math.floor(qty * (_oreRefineEff / 100));
      return `<span style="color:var(--text-2);">${mn.substring(0,3)}:</span>`
           + `<span style="color:var(--text-1);"> ${formatNumber(actual)}</span>`;
    }).join(' &nbsp;');

    return `
      <tr style="border-bottom:1px solid var(--border);
                 background:${isTop ? 'rgba(255,255,255,0.03)' : 'transparent'};
                 ${isTop ? 'outline:1px solid var(--accent);' : ''}">
        <td style="padding:10px 14px;white-space:nowrap;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                       background:${gc};margin-right:6px;vertical-align:middle;"></span>
          <span style="font-family:var(--mono);font-size:10px;color:${gc};">${ore.group}</span>
        </td>
        <td style="padding:10px 8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="https://images.evetech.net/types/${ore.typeId}/icon?size=32"
                 onerror="this.onerror=null;this.style.display='none';"
                 style="width:24px;height:24px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <span style="color:var(--text-1);font-weight:600;">${escHtml(ore.name)}</span>
          </div>
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${ore.volume.toFixed(2)}
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--text-3);">
          ${minSummary}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${iskPerUnit > rawSellUnit ? 'var(--success)' : 'var(--text-2)'};">
          ${iskPerUnit > 0 ? formatNumber(iskPerUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <div style="width:60px;height:4px;background:var(--bg-card);border-radius:2px;overflow:hidden;flex-shrink:0;">
              <div style="height:100%;width:${barW}%;background:${isTop ? 'var(--accent)' : 'var(--text-3)'};border-radius:2px;"></div>
            </div>
            <span style="font-family:var(--mono);font-weight:700;
                         color:${isTop ? 'var(--accent)' : 'var(--text-1)'};">
              ${iskPerM3 > 0 ? formatNumber(iskPerM3) : '—'}
            </span>
          </div>
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${rawSellUnit > iskPerUnit ? 'var(--success)' : 'var(--text-2)'};">
          ${rawSellUnit > 0 ? formatNumber(rawSellUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${rawSellM3 > 0 ? formatNumber(rawSellM3) : '—'}
        </td>
      </tr>`;
  }).join('');
}
// ─── Ice Calculator ───────────────────────────────────────────────────────────
// Mirrors Fuzzwork's ice/M3 page:
//   - All 24 ice types (base + compressed) with correct Fuzzwork yields
//   - Pulls Jita 4-4 sell prices for all 7 ice products via getJitaPrices IPC
//   - ISK/M³ (primary sort, mini bar chart), ISK/unit, raw sell/unit, raw sell/M³
//   - Product price strip at the top
//   - Refining efficiency % (default 72.36%) and tax % (default 5%)
//   - Sortable columns, colour-coded groups, Refresh button
//   - Raw sell > refine cells highlighted green

// ── Ice product type IDs ──────────────────────────────────────────────────────
const ICE_PRODUCT_IDS = {
  'Heavy Water':          16272,
  'Liquid Ozone':         16273,
  'Helium Isotopes':      16274,
  'Strontium Clathrates': 16275,
  'Hydrogen Isotopes':    17889,
  'Oxygen Isotopes':      17887,
  'Nitrogen Isotopes':    17888,
};

// ── Ice data — yields per single unit refined (batchSize = 1 for all ice) ────
// Volumes and yields match the Fuzzwork table exactly.
// group: Highsec / Lowsec / Nullsec / Wormhole / Compressed
const ICE_DATA = [
  // ── Highsec ──────────────────────────────────────────────────────────────
  {
    name: 'Clear Icicle',    typeId: 16262, group: 'Highsec',  volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Helium Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Glacial Mass',    typeId: 16263, group: 'Highsec',  volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Hydrogen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Blue Ice',        typeId: 16264, group: 'Highsec',  volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Oxygen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'White Glaze',     typeId: 16265, group: 'Highsec',  volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Nitrogen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  // ── Lowsec / Null ─────────────────────────────────────────────────────────
  {
    name: 'Glare Crust',     typeId: 16266, group: 'Lowsec',   volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 1381, 'Liquid Ozone': 691, 'Strontium Clathrates': 35 },
  },
  {
    name: 'Dark Glitter',    typeId: 16267, group: 'Lowsec',   volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 691, 'Liquid Ozone': 1381, 'Strontium Clathrates': 69 },
  },
  {
    name: 'Gelidus',         typeId: 16268, group: 'Lowsec',   volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 345, 'Liquid Ozone': 691, 'Strontium Clathrates': 104 },
  },
  {
    name: 'Krystallos',      typeId: 16269, group: 'Lowsec',   volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 173, 'Liquid Ozone': 691, 'Strontium Clathrates': 173 },
  },
  // ── Improved variants (Highsec enhanced) ─────────────────────────────────
  {
    name: 'Thick Blue Ice',           typeId: 17975, group: 'Highsec+', volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Oxygen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Pristine White Glaze',     typeId: 17976, group: 'Highsec+', volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Nitrogen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Smooth Glacial Mass',      typeId: 17977, group: 'Highsec+', volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Hydrogen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Enriched Clear Icicle',    typeId: 17978, group: 'Highsec+', volume: 1000, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Helium Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  // ── Compressed ───────────────────────────────────────────────────────────
  {
    name: 'Compressed Blue Ice',              typeId: 28433, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Oxygen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Clear Icicle',          typeId: 28443, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Helium Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Dark Glitter',          typeId: 28444, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 691, 'Liquid Ozone': 1381, 'Strontium Clathrates': 69 },
  },
  {
    name: 'Compressed Enriched Clear Icicle', typeId: 28445, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Helium Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Gelidus',               typeId: 28446, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 345, 'Liquid Ozone': 691, 'Strontium Clathrates': 104 },
  },
  {
    name: 'Compressed Glacial Mass',          typeId: 28447, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Hydrogen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Glare Crust',           typeId: 28448, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 1381, 'Liquid Ozone': 691, 'Strontium Clathrates': 35 },
  },
  {
    name: 'Compressed Krystallos',            typeId: 28449, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 173, 'Liquid Ozone': 691, 'Strontium Clathrates': 173 },
  },
  {
    name: 'Compressed Pristine White Glaze',  typeId: 28450, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Nitrogen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Smooth Glacial Mass',   typeId: 28451, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Hydrogen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed Thick Blue Ice',        typeId: 28452, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 104, 'Liquid Ozone': 55, 'Oxygen Isotopes': 483, 'Strontium Clathrates': 1 },
  },
  {
    name: 'Compressed White Glaze',           typeId: 28453, group: 'Compressed', volume: 100, batchSize: 1,
    products: { 'Heavy Water': 69, 'Liquid Ozone': 35, 'Nitrogen Isotopes': 414, 'Strontium Clathrates': 1 },
  },
];

// Raw sell type IDs for ice (same as ICE_DATA typeIds — buying unrefined ice)
const ICE_SELL_IDS = Object.fromEntries(ICE_DATA.map(ice => [ice.name, ice.typeId]));

// ── Ice calculator state ──────────────────────────────────────────────────────
let _iceRefineEff = 72.36;
let _iceSort      = { col: 'iskM3', dir: -1 };
let _icePrices    = {};
let _iceLoading   = false;

async function renderIceCalculator(container) {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  container.innerHTML = `
    <div id="iceCalcWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- toolbar -->
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;
                  padding:12px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;">ICE CALCULATOR</span>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
          <label style="font-size:12px;color:var(--text-2);font-family:var(--mono);">REFINE EFF %</label>
          <input id="iceRefineEff" type="number" min="0" max="100" step="0.01"
                 value="${_iceRefineEff}"
                 class="field-input" style="width:76px;padding:5px 8px;font-size:12px;"
                 title="Refining efficiency — perfect skills no implant = 72.36%, T2 implant = 82.5%"/>
          ${tradeToolbarHtml('ice', accounts)}
          <button id="iceRefreshBtn" class="icon-btn"
                  style="padding:5px 12px;font-size:12px;">⟳ REFRESH</button>
        </div>
        <div id="icePriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);"></div>
      </div>

      <!-- ice product price strip -->
      <div id="iceProductStrip" style="display:flex;gap:0;border-bottom:1px solid var(--border);
           background:var(--bg-panel);flex-shrink:0;overflow-x:auto;">
        ${Object.keys(ICE_PRODUCT_IDS).map(p => `
          <div style="padding:6px 14px;border-right:1px solid var(--border);white-space:nowrap;">
            <div style="font-size:9px;color:var(--text-3);font-family:var(--mono);letter-spacing:0.08em;">
              ${p.toUpperCase().replace(/ /g,'&nbsp;')}
            </div>
            <div id="icePrice_${p.replace(/ /g,'_')}"
                 style="font-size:11px;color:var(--accent);font-family:var(--mono);">…</div>
          </div>`).join('')}
      </div>

      <!-- table -->
      <div style="flex:1;overflow-y:auto;">
        <table id="iceTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                       position:sticky;top:0;z-index:1;">
              <th class="ice-th" data-col="group"   style="text-align:left;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">GROUP ↕</th>
              <th class="ice-th" data-col="name"    style="text-align:left;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ICE ↕</th>
              <th class="ice-th" data-col="vol"     style="text-align:right;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">M³/UNIT ↕</th>
              <th style="text-align:right;padding:10px 8px;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">PRODUCTS / UNIT</th>
              <th class="ice-th" data-col="iskUnit" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">REFINE ISK/UNIT ↕</th>
              <th class="ice-th" data-col="iskM3"   style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:0.1em;color:var(--accent);">REFINE ISK/M³ ↕</th>
              <th class="ice-th" data-col="sellRaw" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RAW SELL/UNIT ↕</th>
              <th class="ice-th" data-col="sellM3"  style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">RAW SELL/M³ ↕</th>
            </tr>
          </thead>
          <tbody id="iceTableBody">
            <tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-3);
                font-family:var(--mono);font-size:12px;">⬡ Fetching Jita prices…</td></tr>
          </tbody>
        </table>
      </div>

      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Prices from the selected hub, net of sales tax (+ broker fee for Sell/Split). Products are
        yielded at base quantity × your efficiency setting. Raw = sell the ice unprocessed.
      </div>
    </div>`;

  // Bind toolbar
  document.getElementById('iceRefineEff').addEventListener('change', e => {
    _iceRefineEff = parseFloat(e.target.value) || 72.36;
    buildIceTable();
  });
  bindTradeToolbar('ice', () => loadIcePrices(), () => buildIceTable());
  updateTradeTaxInfo('ice');
  document.getElementById('iceRefreshBtn').addEventListener('click', () => loadIcePrices());

  // Sortable headers
  document.querySelectorAll('#iceCalcWrap .ice-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_iceSort.col === col) _iceSort.dir *= -1;
      else { _iceSort.col = col; _iceSort.dir = -1; }
      buildIceTable();
    });
  });

  await loadIcePrices();
}

async function loadIcePrices() {
  if (_iceLoading) return;
  _iceLoading = true;
  const refreshBtn = document.getElementById('iceRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const productIds = Object.values(ICE_PRODUCT_IDS);
    const rawIceIds  = Object.values(ICE_SELL_IDS);
    const allIds     = [...new Set([...productIds, ...rawIceIds])];

    const raw = await window.eveAPI.getHubPrices(allIds, _trade.hub);
    _icePrices = raw || {};

    // Update product price strip
    for (const [pName, pId] of Object.entries(ICE_PRODUCT_IDS)) {
      const el = document.getElementById(`icePrice_${pName.replace(/ /g, '_')}`);
      if (!el) continue;
      const price = tradePrice(_icePrices[pId]);
      el.textContent = price > 0 ? formatNumber(price) + ' ISK' : '—';
    }

    const ageEl = document.getElementById('icePriceAge');
    if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    buildIceTable();
  } catch (err) {
    logToConsole(`Ice prices fetch failed: ${err.message}`, 'error');
    const body = document.getElementById('iceTableBody');
    if (body) body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;
      color:var(--danger);font-family:var(--mono);font-size:12px;">
      ⚠ Failed to fetch prices: ${escHtml(err.message)}</td></tr>`;
  } finally {
    _iceLoading = false;
    const btn = document.getElementById('iceRefreshBtn');
    if (btn) btn.disabled = false;
  }
}

function calcIceRow(ice) {
  const effFactor = _iceRefineEff / 100;
  const netFactor = tradeNetFactor();             // sales tax (+ broker, per method)

  // Ice refining: EVE floors the product quantities, then applies market fees
  let refineISK = 0;
  for (const [pName, baseQty] of Object.entries(ice.products)) {
    const price  = tradePrice(_icePrices[ICE_PRODUCT_IDS[pName]]);
    const actual = Math.floor(baseQty * effFactor);
    refineISK   += actual * price * netFactor;
  }

  const iskPerUnit = refineISK;                   // batchSize = 1 for all ice
  const iskPerM3   = iskPerUnit / ice.volume;

  // Raw sale proceeds for the unrefined ice unit, same method + fees
  const rawSellUnit = tradePrice(_icePrices[ice.typeId]) * netFactor;
  const rawSellM3   = rawSellUnit / ice.volume;

  return { iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 };
}

function buildIceTable() {
  const body = document.getElementById('iceTableBody');
  if (!body) return;

  const rows = ICE_DATA.map(ice => {
    const { iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 } = calcIceRow(ice);
    return { ice, iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 };
  });

  // Sort
  const col = _iceSort.col;
  const dir = _iceSort.dir;
  rows.sort((a, b) => {
    let va, vb;
    if      (col === 'name')    { return dir * a.ice.name.localeCompare(b.ice.name); }
    else if (col === 'group')   { return dir * a.ice.group.localeCompare(b.ice.group); }
    else if (col === 'vol')     { va = a.ice.volume;   vb = b.ice.volume; }
    else if (col === 'iskUnit') { va = a.iskPerUnit;   vb = b.iskPerUnit; }
    else if (col === 'iskM3')   { va = a.iskPerM3;     vb = b.iskPerM3; }
    else if (col === 'sellRaw') { va = a.rawSellUnit;  vb = b.rawSellUnit; }
    else if (col === 'sellM3')  { va = a.rawSellM3;    vb = b.rawSellM3; }
    else                        { va = a.iskPerM3;     vb = b.iskPerM3; }
    return dir * (va - vb);
  });

  const maxIskM3 = Math.max(...rows.map(r => r.iskPerM3), 1);

  // Group colour coding: Highsec green, Highsec+ teal, Lowsec amber, Compressed purple
  const groupColors = {
    'Highsec':    '#4ecbb0',
    'Highsec+':   '#3ab8d4',
    'Lowsec':     '#e3a84d',
    'Compressed': '#ab7ab8',
  };

  body.innerHTML = rows.map((r, i) => {
    const { ice, iskPerUnit, iskPerM3, rawSellUnit, rawSellM3 } = r;
    const gc    = groupColors[ice.group] || 'var(--text-3)';
    const barW  = Math.round((iskPerM3 / maxIskM3) * 100);
    const isTop = i === 0;

    // Product yield summary
    const prodSummary = Object.entries(ice.products).map(([pn, qty]) => {
      const actual = Math.floor(qty * (_iceRefineEff / 100));
      // Use short abbreviations so the column stays compact
      const abbr = pn.split(' ').map(w => w[0]).join('');
      return `<span style="color:var(--text-2);">${abbr}:</span>`
           + `<span style="color:var(--text-1);"> ${formatNumber(actual)}</span>`;
    }).join(' &nbsp;');

    return `
      <tr style="border-bottom:1px solid var(--border);
                 background:${isTop ? 'rgba(255,255,255,0.03)' : 'transparent'};
                 ${isTop ? 'outline:1px solid var(--accent);' : ''}">
        <td style="padding:10px 14px;white-space:nowrap;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                       background:${gc};margin-right:6px;vertical-align:middle;"></span>
          <span style="font-family:var(--mono);font-size:10px;color:${gc};">${ice.group}</span>
        </td>
        <td style="padding:10px 8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="https://images.evetech.net/types/${ice.typeId}/icon?size=32"
                 onerror="this.onerror=null;this.style.display='none';"
                 style="width:24px;height:24px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <span style="color:var(--text-1);font-weight:600;">${escHtml(ice.name)}</span>
          </div>
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${ice.volume.toLocaleString()}
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);font-size:10px;color:var(--text-3);">
          ${prodSummary}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${iskPerUnit > rawSellUnit ? 'var(--success)' : 'var(--text-2)'};">
          ${iskPerUnit > 0 ? formatNumber(iskPerUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <div style="width:60px;height:4px;background:var(--bg-card);border-radius:2px;overflow:hidden;flex-shrink:0;">
              <div style="height:100%;width:${barW}%;background:${isTop ? 'var(--accent)' : 'var(--text-3)'};border-radius:2px;"></div>
            </div>
            <span style="font-family:var(--mono);font-weight:700;
                         color:${isTop ? 'var(--accent)' : 'var(--text-1)'};">
              ${iskPerM3 > 0 ? formatNumber(iskPerM3) : '—'}
            </span>
          </div>
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${rawSellUnit > iskPerUnit ? 'var(--success)' : 'var(--text-2)'};">
          ${rawSellUnit > 0 ? formatNumber(rawSellUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${rawSellM3 > 0 ? formatNumber(rawSellM3) : '—'}
        </td>
      </tr>`;
  }).join('');
}

// ─── Gas Calculator ───────────────────────────────────────────────────────────
// Gas is a raw-sell calculator — there is no refining step for gas in EVE.
// Value = Jita sell price per unit, ISK/m³, and ISK/full Venture hold (5000 m³).
// Groups: Cytoserocin (lowsec), Mykoserocin (nullsec), Fullerites (wormhole),
//         Hiemal Tricarboxyl Vapor (pochven).

// ── Gas type data ─────────────────────────────────────────────────────────────
// typeId from EVE SDE. volume = m³ per unit.
// ventureHold: the standard Venture gas-cloud scoop cargo hold is 5000 m³,
//   so ventureUnits = 5000 / volume.
const GAS_DATA = [
  // ── Cytoserocin — Lowsec booster gas ────────────────────────────────────
  { name: 'Amber Cytoserocin',     typeId: 25268, group: 'Cytoserocin', volume: 10 },
  { name: 'Azure Cytoserocin',     typeId: 25279, group: 'Cytoserocin', volume: 10 },
  { name: 'Celadon Cytoserocin',   typeId: 25275, group: 'Cytoserocin', volume: 10 },
  { name: 'Golden Cytoserocin',    typeId: 25273, group: 'Cytoserocin', volume: 10 },
  { name: 'Lime Cytoserocin',      typeId: 25277, group: 'Cytoserocin', volume: 10 },
  { name: 'Malachite Cytoserocin', typeId: 25281, group: 'Cytoserocin', volume: 10 },
  { name: 'Vermillion Cytoserocin',typeId: 25271, group: 'Cytoserocin', volume: 10 },
  { name: 'Viridian Cytoserocin',  typeId: 25269, group: 'Cytoserocin', volume: 10 },
  // ── Mykoserocin — Nullsec booster gas ───────────────────────────────────
  { name: 'Amber Mykoserocin',     typeId: 28694, group: 'Mykoserocin', volume: 10 },
  { name: 'Azure Mykoserocin',     typeId: 28700, group: 'Mykoserocin', volume: 10 },
  { name: 'Celadon Mykoserocin',   typeId: 28698, group: 'Mykoserocin', volume: 10 },
  { name: 'Golden Mykoserocin',    typeId: 28696, group: 'Mykoserocin', volume: 10 },
  { name: 'Lime Mykoserocin',      typeId: 28702, group: 'Mykoserocin', volume: 10 },
  { name: 'Malachite Mykoserocin', typeId: 28704, group: 'Mykoserocin', volume: 10 },
  { name: 'Vermillion Mykoserocin',typeId: 28706, group: 'Mykoserocin', volume: 10 },
  { name: 'Viridian Mykoserocin',  typeId: 28708, group: 'Mykoserocin', volume: 10 },
  // ── Fullerites — Wormhole reaction gas ──────────────────────────────────
  { name: 'Fullerite-C50',  typeId: 30370, group: 'Fullerite', volume: 1  },
  { name: 'Fullerite-C60',  typeId: 30371, group: 'Fullerite', volume: 1  },
  { name: 'Fullerite-C70',  typeId: 30372, group: 'Fullerite', volume: 1  },
  { name: 'Fullerite-C72',  typeId: 30373, group: 'Fullerite', volume: 2  },
  { name: 'Fullerite-C84',  typeId: 30374, group: 'Fullerite', volume: 2  },
  { name: 'Fullerite-C28',  typeId: 30375, group: 'Fullerite', volume: 2  },
  { name: 'Fullerite-C32',  typeId: 30376, group: 'Fullerite', volume: 5  },
  { name: 'Fullerite-C320', typeId: 30377, group: 'Fullerite', volume: 5  },
  { name: 'Fullerite-C540', typeId: 30378, group: 'Fullerite', volume: 10 },
  // ── Hiemal — Pochven ────────────────────────────────────────────────────
  { name: 'Hiemal Tricarboxyl Vapor', typeId: 52306, group: 'Pochven', volume: 10 },
];

// Venture gas hold = 5000 m³
const VENTURE_HOLD_M3 = 5000;

// ── Gas calculator state ──────────────────────────────────────────────────────
let _gasSort    = { col: 'iskM3', dir: -1 };
let _gasPrices  = {};
let _gasLoading = false;

async function renderGasCalculator(container) {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  container.innerHTML = `
    <div id="gasCalcWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- toolbar -->
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;
                  padding:12px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">
        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;">GAS CALCULATOR</span>
        <div style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;">
          ${tradeToolbarHtml('gas', accounts)}
          <button id="gasRefreshBtn" class="icon-btn"
                  style="padding:5px 12px;font-size:12px;">⟳ REFRESH</button>
        </div>
        <div id="gasPriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);"></div>
      </div>

      <!-- legend strip -->
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border);
                  background:var(--bg-panel);flex-shrink:0;padding:8px 16px;
                  align-items:center;gap:20px;flex-wrap:wrap;">
        ${[
          ['Cytoserocin', '#e3a84d', 'Lowsec booster gas'],
          ['Mykoserocin',  '#4ecbb0', 'Nullsec booster gas'],
          ['Fullerite',    '#ab7ab8', 'Wormhole reaction gas'],
          ['Pochven',      '#c05c7e', 'Pochven special gas'],
        ].map(([label, color, tip]) => `
          <span style="display:flex;align-items:center;gap:6px;font-size:10px;
                       font-family:var(--mono);color:var(--text-2);" title="${tip}">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                         background:${color};flex-shrink:0;"></span>
            ${label}
          </span>`).join('')}
        <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);margin-left:auto;">
          Venture hold = ${VENTURE_HOLD_M3.toLocaleString()} m³ &nbsp;·&nbsp;
          Gas is sold raw — no refining step
        </span>
      </div>

      <!-- table -->
      <div style="flex:1;overflow-y:auto;">
        <table id="gasTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                       position:sticky;top:0;z-index:1;">
              <th class="gas-th" data-col="group"   style="text-align:left;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">GROUP ↕</th>
              <th class="gas-th" data-col="name"    style="text-align:left;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">GAS TYPE ↕</th>
              <th class="gas-th" data-col="vol"     style="text-align:right;padding:10px 8px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">M³/UNIT ↕</th>
              <th class="gas-th" data-col="iskUnit" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ISK/UNIT ↕</th>
              <th class="gas-th" data-col="iskM3"   style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;letter-spacing:0.1em;color:var(--accent);">ISK/M³ ↕</th>
              <th class="gas-th" data-col="venture" style="text-align:right;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--text-3);letter-spacing:0.1em;">ISK/VENTURE ↕</th>
            </tr>
          </thead>
          <tbody id="gasTableBody">
            <tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-3);
                font-family:var(--mono);font-size:12px;">⬡ Fetching Jita prices…</td></tr>
          </tbody>
        </table>
      </div>

      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Prices from the selected hub, net of sales tax (+ broker fee for Sell/Split). Gas is sold raw — no refining.
        ISK/Venture assumes a full ${VENTURE_HOLD_M3.toLocaleString()} m³ Venture gas hold.
      </div>
    </div>`;

  // Sortable headers
  document.querySelectorAll('#gasCalcWrap .gas-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_gasSort.col === col) _gasSort.dir *= -1;
      else { _gasSort.col = col; _gasSort.dir = -1; }
      buildGasTable();
    });
  });

  bindTradeToolbar('gas', () => loadGasPrices(), () => buildGasTable());
  updateTradeTaxInfo('gas');
  document.getElementById('gasRefreshBtn').addEventListener('click', () => loadGasPrices());

  await loadGasPrices();
}

async function loadGasPrices() {
  if (_gasLoading) return;
  _gasLoading = true;
  const refreshBtn = document.getElementById('gasRefreshBtn');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const allIds = [...new Set(GAS_DATA.map(g => g.typeId))];
    const raw    = await window.eveAPI.getHubPrices(allIds, _trade.hub);
    _gasPrices   = raw || {};

    const ageEl = document.getElementById('gasPriceAge');
    if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    buildGasTable();
  } catch (err) {
    logToConsole(`Gas prices fetch failed: ${err.message}`, 'error');
    const body = document.getElementById('gasTableBody');
    if (body) body.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;
      color:var(--danger);font-family:var(--mono);font-size:12px;">
      ⚠ Failed to fetch prices: ${escHtml(err.message)}</td></tr>`;
  } finally {
    _gasLoading = false;
    const btn = document.getElementById('gasRefreshBtn');
    if (btn) btn.disabled = false;
  }
}

function buildGasTable() {
  const body = document.getElementById('gasTableBody');
  if (!body) return;

  const rows = GAS_DATA.map(gas => {
    const iskPerUnit  = tradePrice(_gasPrices[gas.typeId]) * tradeNetFactor();
    const iskPerM3    = gas.volume > 0 ? iskPerUnit / gas.volume : 0;
    const ventureUnits = Math.floor(VENTURE_HOLD_M3 / gas.volume);
    const iskVenture  = iskPerUnit * ventureUnits;
    return { gas, iskPerUnit, iskPerM3, iskVenture, ventureUnits };
  });

  // Sort
  const col = _gasSort.col;
  const dir = _gasSort.dir;
  rows.sort((a, b) => {
    if      (col === 'name')    return dir * a.gas.name.localeCompare(b.gas.name);
    else if (col === 'group')   return dir * a.gas.group.localeCompare(b.gas.group);
    else if (col === 'vol')     return dir * (a.gas.volume    - b.gas.volume);
    else if (col === 'iskUnit') return dir * (a.iskPerUnit    - b.iskPerUnit);
    else if (col === 'iskM3')   return dir * (a.iskPerM3      - b.iskPerM3);
    else if (col === 'venture') return dir * (a.iskVenture    - b.iskVenture);
    return dir * (a.iskPerM3 - b.iskPerM3);
  });

  const maxIskM3 = Math.max(...rows.map(r => r.iskPerM3), 1);

  const groupColors = {
    'Cytoserocin': '#e3a84d',
    'Mykoserocin': '#4ecbb0',
    'Fullerite':   '#ab7ab8',
    'Pochven':     '#c05c7e',
  };

  body.innerHTML = rows.map((r, i) => {
    const { gas, iskPerUnit, iskPerM3, iskVenture, ventureUnits } = r;
    const gc    = groupColors[gas.group] || 'var(--text-3)';
    const barW  = Math.round((iskPerM3 / maxIskM3) * 100);
    const isTop = i === 0;

    return `
      <tr style="border-bottom:1px solid var(--border);
                 background:${isTop ? 'rgba(255,255,255,0.03)' : 'transparent'};
                 ${isTop ? 'outline:1px solid var(--accent);' : ''}">
        <td style="padding:10px 14px;white-space:nowrap;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                       background:${gc};margin-right:6px;vertical-align:middle;"></span>
          <span style="font-family:var(--mono);font-size:10px;color:${gc};">${gas.group}</span>
        </td>
        <td style="padding:10px 8px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="https://images.evetech.net/types/${gas.typeId}/icon?size=32"
                 onerror="this.onerror=null;this.style.display='none';"
                 style="width:24px;height:24px;border-radius:3px;border:1px solid var(--border);flex-shrink:0;">
            <span style="color:var(--text-1);font-weight:600;">${escHtml(gas.name)}</span>
          </div>
        </td>
        <td style="padding:10px 8px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${gas.volume.toFixed(0)}
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);color:var(--text-2);">
          ${iskPerUnit > 0 ? formatNumber(iskPerUnit) : '—'}
        </td>
        <td style="padding:10px 14px;text-align:right;">
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;">
            <div style="width:60px;height:4px;background:var(--bg-card);border-radius:2px;overflow:hidden;flex-shrink:0;">
              <div style="height:100%;width:${barW}%;background:${isTop ? 'var(--accent)' : 'var(--text-3)'};border-radius:2px;"></div>
            </div>
            <span style="font-family:var(--mono);font-weight:700;
                         color:${isTop ? 'var(--accent)' : 'var(--text-1)'};">
              ${iskPerM3 > 0 ? formatNumber(iskPerM3) : '—'}
            </span>
          </div>
        </td>
        <td style="padding:10px 14px;text-align:right;font-family:var(--mono);
                   color:${isTop ? 'var(--accent)' : 'var(--text-2)'};"
            title="${ventureUnits.toLocaleString()} units × ${formatNumber(iskPerUnit)} ISK">
          ${iskVenture > 0 ? formatNumber(iskVenture) : '—'}
        </td>
      </tr>`;
  }).join('');
}