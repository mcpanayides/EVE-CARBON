// ─── Cost Index Calculator ────────────────────────────────────────────────────
// Data source: ESI /industry/systems/ (same feed Fuzzwork uses)
// Supports: region filter, system name search + jump range, require factory/lab toggles.

// ── Module state ──────────────────────────────────────────────────────────────
let _ciAllSystems   = null;   // raw ESI array, cached for the session
let _ciLoading      = false;
let _ciSort         = { col: 'manufacturing', dir: -1 };
let _ciRegion       = '';
let _ciSystemQuery  = '';
let _ciJumpRange    = 4;
let _ciReqFactory   = false;
let _ciReqLab       = false;
let _ciSearchTimer  = null;
let _ciSystemMap    = {};     // solarSystemId → { name, secStatus, regionName }

// ── EVE region list (id → display name) ──────────────────────────────────────
const CI_REGIONS = {
  '10000001': 'Derelik',          '10000002': 'The Forge',
  '10000003': 'Vale of the Silent','10000005': 'Detorid',
  '10000006': 'Wicked Creek',     '10000007': 'Cache',
  '10000008': 'Scalding Pass',    '10000009': 'Insmother',
  '10000010': 'Tribute',          '10000011': 'Great Wildlands',
  '10000012': 'Curse',            '10000014': 'Catch',
  '10000015': 'Venal',            '10000016': 'Lonetrek',
  '10000018': 'The Citadel',      '10000020': 'Tash-Murkon',
  '10000021': 'Outer Passage',    '10000022': 'Stain',
  '10000023': 'Pure Blind',       '10000025': 'Immensea',
  '10000027': 'Etherium Reach',   '10000028': 'Molden Heath',
  '10000029': 'Geminate',         '10000030': 'Heimatar',
  '10000031': 'Impass',           '10000032': 'Sinq Laison',
  '10000033': 'The Bleak Lands',  '10000034': 'The Kalevala Expanse',
  '10000035': 'Deklein',          '10000036': 'Perrigen Falls',
  '10000037': 'Everyshore',       '10000038': 'The Spire',
  '10000039': 'Esoteria',         '10000040': 'Oasa',
  '10000041': 'Syndicate',        '10000042': 'Metropolis',
  '10000043': 'Domain',           '10000044': 'Solitude',
  '10000045': 'Tenal',            '10000046': 'Fade',
  '10000047': 'Providence',       '10000048': 'Placid',
  '10000049': 'Khanid',           '10000050': 'Querious',
  '10000051': 'Cloud Ring',       '10000052': 'Kador',
  '10000054': 'Aridia',           '10000055': 'Branch',
  '10000056': 'Feythabolis',      '10000057': 'Outer Ring',
  '10000058': 'Fountain',         '10000059': 'Paragon Soul',
  '10000060': 'Delve',            '10000061': 'Tenerifis',
  '10000062': 'Omist',            '10000063': 'Period Basis',
  '10000064': 'Essence',          '10000065': 'Kor-Azor',
  '10000066': 'Perrigen Falls',   '10000067': 'Genesis',
  '10000068': 'Verge Vendor',     '10000069': 'Black Rise',
  '10000070': 'Cobalt Edge',
};

// Activity ids → column keys
const CI_ACTIVITY_MAP = {
  1: 'manufacturing',
  3: 'te_research',
  4: 'me_research',
  5: 'copying',
  8: 'invention',
  11: 'reactions',
};

// ── Render the Cost Index tab ─────────────────────────────────────────────────

async function renderCostIndex(container) {
  const regionOptions = Object.entries(CI_REGIONS)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => `<option value="${id}">${escHtml(name)}</option>`)
    .join('');

  container.innerHTML = `
    <div id="ciWrap" style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <!-- ── Toolbar ── -->
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;
                  padding:12px 16px;border-bottom:1px solid var(--border);
                  background:var(--bg-card);flex-shrink:0;">

        <span style="font-family:var(--mono);font-size:11px;color:var(--text-3);
                     letter-spacing:0.1em;white-space:nowrap;">COST INDEX · ESI LIVE</span>

        <!-- Region selector -->
        <select id="ciRegionSel" class="field-input" style="width:180px;"
                title="Filter by region">
          <option value="">— All Regions —</option>
          ${regionOptions}
        </select>

        <!-- Divider / OR label -->
        <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);">OR</span>

        <!-- System search -->
        <div style="position:relative;flex:1;min-width:160px;max-width:260px;">
          <input id="ciSystemSearch" class="field-input" placeholder="System name…"
                 style="width:100%;box-sizing:border-box;"
                 title="Search systems by name — clears region filter" autocomplete="off"/>
          <div id="ciSystemDrop" style="display:none;position:absolute;top:100%;left:0;right:0;
               z-index:200;background:var(--bg-panel);border:1px solid var(--border);
               border-top:none;border-radius:0 0 4px 4px;max-height:200px;overflow-y:auto;"></div>
        </div>

        <!-- Jump range -->
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <label style="font-family:var(--mono);font-size:11px;color:var(--text-2);white-space:nowrap;">
            RANGE
          </label>
          <select id="ciJumpRange" class="field-input" style="width:60px;"
                  title="Max jumps from searched system (system search must be set)">
            ${[1,2,3,4,5,6,7,8,9,10].map(n =>
              `<option value="${n}"${n===4?' selected':''}>${n}</option>`).join('')}
          </select>
          <span style="font-family:var(--mono);font-size:10px;color:var(--text-3);">jumps</span>
        </div>

        <!-- Require Factory / Lab toggles -->
        <label class="ci-toggle-label" title="Only show systems with a factory (manufacturing cost index > 0)">
          <input type="checkbox" id="ciReqFactory"/>
          <span class="ci-toggle-pill">FACTORY</span>
        </label>
        <label class="ci-toggle-label" title="Only show systems with a lab (ME/TE/copy/invention > 0)">
          <input type="checkbox" id="ciReqLab"/>
          <span class="ci-toggle-pill">LAB</span>
        </label>

        <button id="ciRefreshBtn" class="icon-btn"
                style="padding:5px 12px;font-size:12px;margin-left:auto;flex-shrink:0;">
          ⟳ REFRESH
        </button>
        <div id="ciPriceAge" style="font-size:10px;color:var(--text-3);font-family:var(--mono);
                                    white-space:nowrap;flex-shrink:0;"></div>
      </div>

      <!-- ── Stats bar ── -->
      <div id="ciStatsBar" style="display:flex;gap:24px;padding:8px 16px;
           border-bottom:1px solid var(--border);background:var(--bg-panel);
           flex-shrink:0;flex-wrap:wrap;font-family:var(--mono);font-size:10px;">
        <span style="color:var(--text-3);">
          Showing <span id="ciRowCount" style="color:var(--text-1);font-weight:700;">—</span> systems
        </span>
        <span style="color:var(--text-3);">
          Best mfg: <span id="ciBestMfg" style="color:var(--success);font-weight:700;">—</span>
        </span>
        <span style="color:var(--text-3);">
          Best lab: <span id="ciBestLab" style="color:var(--accent);font-weight:700;">—</span>
        </span>
      </div>

      <!-- ── Table ── -->
      <div style="flex:1;overflow-y:auto;">
        <table id="ciTable" style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);background:var(--bg-card);
                       position:sticky;top:0;z-index:2;">
              <th class="ci-th" data-col="system"        style="text-align:left; padding:10px 8px 10px 16px;">SYSTEM ↕</th>
              <th class="ci-th" data-col="region"        style="text-align:left; padding:10px 8px;">REGION ↕</th>
              <th class="ci-th" data-col="security"      style="text-align:center;padding:10px 8px;">SEC ↕</th>
              <th class="ci-th" data-col="manufacturing" style="text-align:right; padding:10px 8px;">MFG ↕</th>
              <th class="ci-th" data-col="te_research"   style="text-align:right; padding:10px 8px;">TIME EFF ↕</th>
              <th class="ci-th" data-col="me_research"   style="text-align:right; padding:10px 8px;">MAT EFF ↕</th>
              <th class="ci-th" data-col="copying"       style="text-align:right; padding:10px 8px;">COPY ↕</th>
              <th class="ci-th" data-col="invention"     style="text-align:right; padding:10px 8px;">INVENTION ↕</th>
              <th class="ci-th" data-col="reactions"     style="text-align:right; padding:10px 16px 10px 8px;">REACTIONS ↕</th>
            </tr>
          </thead>
          <tbody id="ciTableBody">
            <tr><td colspan="9" style="text-align:center;padding:60px;
                color:var(--text-3);font-family:var(--mono);font-size:12px;">
              ◎ Loading cost index data from ESI…</td></tr>
          </tbody>
        </table>
      </div>

      <!-- ── Footer ── -->
      <div style="padding:8px 16px;border-top:1px solid var(--border);background:var(--bg-card);
                  font-size:10px;color:var(--text-3);font-family:var(--mono);flex-shrink:0;">
        Data from CCP ESI /industry/systems/ · Indexes shown as % · Updated every ~60 min by CCP
        · Jump range filter uses ESI route API
      </div>
    </div>

    <style>
      .ci-th {
        cursor:pointer;
        font-family:var(--mono);
        font-size:10px;
        color:var(--text-3);
        letter-spacing:0.08em;
        user-select:none;
        white-space:nowrap;
      }
      .ci-th:hover { color:var(--text-1); }
      .ci-th.active { color:var(--accent); }

      .ci-toggle-label {
        display:flex;align-items:center;cursor:pointer;gap:0;flex-shrink:0;
      }
      .ci-toggle-label input[type=checkbox] { display:none; }
      .ci-toggle-pill {
        padding:4px 10px;
        border:1px solid var(--border);
        border-radius:3px;
        font-family:var(--mono);
        font-size:10px;
        color:var(--text-3);
        background:var(--bg-panel);
        transition:all 0.15s;
        letter-spacing:0.06em;
      }
      .ci-toggle-label input:checked + .ci-toggle-pill {
        background:var(--accent);
        color:var(--bg);
        border-color:var(--accent);
        font-weight:700;
      }
      .ci-row:hover td { background:rgba(255,255,255,0.03); }

      .ci-bar-wrap {
        display:flex;align-items:center;justify-content:flex-end;gap:6px;
      }
      .ci-bar-bg {
        width:48px;height:4px;background:var(--bg-card);border-radius:2px;overflow:hidden;flex-shrink:0;
      }
      .ci-bar-fill { height:100%;border-radius:2px; }
    </style>`;

  // ── Wire up controls ───────────────────────────────────────────────────────

  document.getElementById('ciRefreshBtn').addEventListener('click', () => loadCIData(true));

  document.getElementById('ciRegionSel').addEventListener('change', (e) => {
    _ciRegion = e.target.value;
    // Clear system search when region chosen
    if (_ciRegion) {
      document.getElementById('ciSystemSearch').value = '';
      _ciSystemQuery = '';
    }
    applyCIFilters();
  });

  document.getElementById('ciJumpRange').addEventListener('change', (e) => {
    _ciJumpRange = parseInt(e.target.value);
    if (_ciSystemQuery) applyCIFilters();
  });

  document.getElementById('ciReqFactory').addEventListener('change', (e) => {
    _ciReqFactory = e.target.checked;
    applyCIFilters();
  });

  document.getElementById('ciReqLab').addEventListener('change', (e) => {
    _ciReqLab = e.target.checked;
    applyCIFilters();
  });

  // System search with autocomplete
  const sysInput = document.getElementById('ciSystemSearch');
  const sysDrop  = document.getElementById('ciSystemDrop');

  sysInput.addEventListener('input', () => {
    clearTimeout(_ciSearchTimer);
    _ciSearchTimer = setTimeout(() => handleCISystemInput(), 250);
  });

  sysInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { sysDrop.style.display = 'none'; }
    if (e.key === 'Enter') {
      const first = sysDrop.querySelector('.ci-drop-item');
      if (first) first.click();
    }
  });

  document.addEventListener('click', (e) => {
    if (!sysInput.contains(e.target) && !sysDrop.contains(e.target)) {
      sysDrop.style.display = 'none';
    }
  });

  // Sortable headers
  document.querySelectorAll('#ciWrap .ci-th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (_ciSort.col === col) _ciSort.dir *= -1;
      else { _ciSort.col = col; _ciSort.dir = -1; }
      document.querySelectorAll('#ciWrap .ci-th').forEach(h => h.classList.toggle('active', h.dataset.col === _ciSort.col));
      renderCITable();
    });
  });
  // Mark initial sort column
  document.querySelector(`#ciWrap .ci-th[data-col="${_ciSort.col}"]`)?.classList.add('active');

  // Load data
  await loadCIData(false);
}

// ── Fetch ESI industry systems ─────────────────────────────────────────────────

async function loadCIData(forceRefresh = false) {
  if (_ciLoading) return;
  _ciLoading = true;

  const refreshBtn = document.getElementById('ciRefreshBtn');
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '⟳ LOADING…'; }

  const body = document.getElementById('ciTableBody');

  try {
    logToConsole('Loading cost index data from ESI…', 'info');

    if (!_ciAllSystems || forceRefresh) {
      // ESI endpoint returns all systems with cost indexes
      const resp = await window.eveAPI.esiFetch('https://esi.evetech.net/latest/industry/systems/?datasource=tranquility');
      if (!Array.isArray(resp)) throw new Error('Unexpected ESI response format');
      _ciAllSystems = resp;

      // Also pull system details in parallel batches for names + sec status + region
      await loadCISystemDetails(_ciAllSystems.map(s => s.solar_system_id));

      const ageEl = document.getElementById('ciPriceAge');
      if (ageEl) ageEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

      logToConsole(`Cost index: ${_ciAllSystems.length} systems loaded.`, 'success');
    }

    applyCIFilters();

  } catch (err) {
    console.error('[CostIndex] ESI fetch failed:', err);
    logToConsole(`Cost index load failed: ${err.message}`, 'error');
    if (body) body.innerHTML = `
      <tr><td colspan="9" style="text-align:center;padding:60px;color:var(--danger);
          font-family:var(--mono);font-size:12px;">
        ⚠ Failed to load ESI data: ${escHtml(err.message)}<br>
        <span style="color:var(--text-3);font-size:10px;">Check your internet connection and try refreshing.</span>
      </td></tr>`;
  } finally {
    _ciLoading = false;
    const btn = document.getElementById('ciRefreshBtn');
    if (btn) { btn.disabled = false; btn.textContent = '⟳ REFRESH'; }
  }
}

// ── Load system details (name, sec, region) via eveAPI.getNames + resolveSystemNames ───

async function loadCISystemDetails(systemIds) {
  // getNames wraps ESI POST /universe/names/ via the main-process IPC
  const CHUNK = 800;
  const results = [];
  for (let i = 0; i < systemIds.length; i += CHUNK) {
    const batch = systemIds.slice(i, i + CHUNK);
    try {
      const data = await window.eveAPI.getNames(batch);
      if (Array.isArray(data)) results.push(...data);
    } catch (e) {
      console.warn('[CostIndex] Names batch failed:', e.message);
    }
  }

  // Build quick lookup: id → name
  const nameMap = {};
  results.forEach(r => {
    if (r.category === 'solar_system' || !r.category) nameMap[r.id] = r.name;
  });

  // resolveSystemNames may return { secStatus, regionName, regionId } per system
  let resolvedNames = {};
  try {
    resolvedNames = await window.eveAPI.resolveSystemNames(systemIds.slice(0, 500)) || {};
  } catch (_) {}

  systemIds.forEach(id => {
    _ciSystemMap[id] = {
      name:       nameMap[id] || resolvedNames[id]?.name || `System ${id}`,
      secStatus:  resolvedNames[id]?.secStatus ?? null,
      regionName: resolvedNames[id]?.regionName || '',
      regionId:   resolvedNames[id]?.regionId   || null,
    };
  });
}

// ── Apply filters and re-render ────────────────────────────────────────────────

async function applyCIFilters() {
  if (!_ciAllSystems) return;

  let systems = _ciAllSystems.map(raw => {
    const info = _ciSystemMap[raw.solar_system_id] || {};
    const indexes = {};
    (raw.cost_indices || []).forEach(ci => {
      const key = CI_ACTIVITY_MAP[ci.activity];
      if (key) indexes[key] = ci.cost_index;
    });
    return {
      id:             raw.solar_system_id,
      name:           info.name           || `System ${raw.solar_system_id}`,
      secStatus:      info.secStatus      ?? null,
      regionName:     info.regionName     || '',
      regionId:       info.regionId       || null,
      manufacturing:  indexes.manufacturing  || 0,
      te_research:    indexes.te_research    || 0,
      me_research:    indexes.me_research    || 0,
      copying:        indexes.copying        || 0,
      invention:      indexes.invention      || 0,
      reactions:      indexes.reactions      || 0,
    };
  });

  // Region filter
  if (_ciRegion) {
    systems = systems.filter(s => String(s.regionId) === _ciRegion);
  }

  // Require factory (manufacturing index > 0)
  if (_ciReqFactory) systems = systems.filter(s => s.manufacturing > 0);

  // Require lab (any research/copy/invention index > 0)
  if (_ciReqLab) systems = systems.filter(s =>
    s.te_research > 0 || s.me_research > 0 || s.copying > 0 || s.invention > 0);

  // System search / jump range filter
  const sysQuery = (document.getElementById('ciSystemSearch')?.value || '').trim();
  if (sysQuery.length >= 2 && !_ciRegion) {
    const anchor = findCISystemByName(sysQuery);
    if (anchor) {
      // Filter to systems within jump range using ESI route
      systems = await filterByJumpRange(systems, anchor.id, _ciJumpRange);
    } else {
      // Partial name filter
      const q = sysQuery.toLowerCase();
      systems = systems.filter(s => s.name.toLowerCase().includes(q));
    }
  }

  // Store filtered for rendering
  window._ciFilteredSystems = systems;
  renderCITable();
}

// ── Find a system by exact/closest name match in our map ─────────────────────

function findCISystemByName(query) {
  const q = query.trim().toLowerCase();
  let exact = null, partial = null;
  for (const [id, info] of Object.entries(_ciSystemMap)) {
    const n = info.name.toLowerCase();
    if (n === q) { exact = { id: parseInt(id), ...info }; break; }
    if (!partial && n.startsWith(q)) partial = { id: parseInt(id), ...info };
  }
  return exact || partial;
}

// ── Filter systems by jump range via ESI route ────────────────────────────────

async function filterByJumpRange(systems, anchorId, maxJumps) {
  // Build a set of system IDs within range
  const inRange = new Set([anchorId]);

  // Query routes to a sample of systems — ESI route API is cheap
  // We batch check up to 1000 systems concurrently
  const targets = systems.map(s => s.id).filter(id => id !== anchorId);
  const BATCH   = 20;

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const checks = batch.map(async (destId) => {
      try {
        const route = await window.eveAPI.esiFetch(
          `https://esi.evetech.net/latest/route/${anchorId}/${destId}/?datasource=tranquility&flag=shortest`
        );
        if (Array.isArray(route) && route.length - 1 <= maxJumps) {
          inRange.add(destId);
        }
      } catch (_) {
        // unreachable / same system — include if same id
        if (destId === anchorId) inRange.add(destId);
      }
    });
    await Promise.all(checks);

    // Update progress every batch
    const rowCount = document.getElementById('ciRowCount');
    if (rowCount) rowCount.textContent = `checking… (${Math.min(i + BATCH, targets.length)}/${targets.length})`;
  }

  return systems.filter(s => inRange.has(s.id));
}

// ── Render the table ──────────────────────────────────────────────────────────

function renderCITable() {
  const body = document.getElementById('ciTableBody');
  if (!body) return;

  const systems = window._ciFilteredSystems || [];

  // Sort
  const col = _ciSort.col;
  const dir = _ciSort.dir;
  const sorted = [...systems].sort((a, b) => {
    if (col === 'system')   return dir * a.name.localeCompare(b.name);
    if (col === 'region')   return dir * a.regionName.localeCompare(b.regionName);
    if (col === 'security') return dir * ((a.secStatus ?? -99) - (b.secStatus ?? -99));
    return dir * ((a[col] || 0) - (b[col] || 0));
  });

  // Stats
  const rowCount = document.getElementById('ciRowCount');
  if (rowCount) rowCount.textContent = sorted.length.toLocaleString();

  const mfgSorted  = [...sorted].sort((a, b) => a.manufacturing - b.manufacturing);
  const labSorted  = [...sorted].sort((a, b) =>
    (a.me_research + a.te_research + a.copying + a.invention) -
    (b.me_research + b.te_research + b.copying + b.invention));

  const bestMfgEl = document.getElementById('ciBestMfg');
  const bestLabEl = document.getElementById('ciBestLab');
  if (bestMfgEl) {
    const b = mfgSorted.find(s => s.manufacturing > 0);
    bestMfgEl.textContent = b ? `${b.name} (${formatCI(b.manufacturing)})` : '—';
  }
  if (bestLabEl) {
    const b = labSorted.find(s => s.me_research > 0 || s.te_research > 0);
    bestLabEl.textContent = b ? `${b.name} (ME: ${formatCI(b.me_research)})` : '—';
  }

  if (sorted.length === 0) {
    body.innerHTML = `
      <tr><td colspan="9" style="text-align:center;padding:60px;
          color:var(--text-3);font-family:var(--mono);font-size:12px;">
        ◎ No systems match your filters.</td></tr>`;
    return;
  }

  // Column max values for bar scaling
  const maxMfg = Math.max(...sorted.map(s => s.manufacturing), 0.001);
  const maxLab = Math.max(...sorted.map(s => s.me_research), 0.001);
  const maxInv = Math.max(...sorted.map(s => s.invention), 0.001);

  body.innerHTML = sorted.map(sys => {
    const sec     = sys.secStatus;
    const secStr  = sec !== null ? sec.toFixed(1) : '?';
    const secCol  = sec === null ? 'var(--text-3)'
                  : sec >= 0.5  ? 'var(--success)'
                  : sec > 0.0   ? '#e3a84d'
                  : 'var(--danger)';

    const mfgPct  = Math.round((sys.manufacturing / maxMfg) * 100);
    const mePct   = Math.round((sys.me_research   / maxLab) * 100);
    const invPct  = Math.round((sys.invention     / maxInv) * 100);

    const hasMfg  = sys.manufacturing > 0;
    const hasLab  = sys.me_research > 0 || sys.te_research > 0 || sys.copying > 0 || sys.invention > 0;

    return `
      <tr class="ci-row" style="border-bottom:1px solid var(--border);">
        <td style="padding:9px 8px 9px 16px;">
          <div style="display:flex;align-items:center;gap:8px;">
            ${hasMfg ? '<span title="Has factory" style="color:var(--accent);font-size:10px;">⚙</span>' : ''}
            ${hasLab ? '<span title="Has lab"     style="color:#ab7ab8;font-size:10px;">◑</span>'      : ''}
            <span style="color:var(--text-1);font-weight:600;">${escHtml(sys.name)}</span>
          </div>
        </td>
        <td style="padding:9px 8px;font-family:var(--mono);font-size:10px;color:var(--text-3);">
          ${escHtml(sys.regionName)}
        </td>
        <td style="padding:9px 8px;text-align:center;font-family:var(--mono);font-size:11px;
                   font-weight:700;color:${secCol};">${secStr}</td>
        <td style="padding:9px 8px;text-align:right;">
          ${ciBarCell(sys.manufacturing, mfgPct, hasMfg ? 'var(--accent)' : 'var(--text-3)')}
        </td>
        <td style="padding:9px 8px;text-align:right;">
          ${ciBarCell(sys.te_research, mePct, 'var(--text-2)')}
        </td>
        <td style="padding:9px 8px;text-align:right;">
          ${ciBarCell(sys.me_research, mePct, '#ab7ab8')}
        </td>
        <td style="padding:9px 8px;text-align:right;">
          ${ciBarCell(sys.copying, 0, 'var(--text-2)')}
        </td>
        <td style="padding:9px 8px;text-align:right;">
          ${ciBarCell(sys.invention, invPct, '#e3a84d')}
        </td>
        <td style="padding:9px 16px 9px 8px;text-align:right;">
          ${ciBarCell(sys.reactions, 0, 'var(--text-2)')}
        </td>
      </tr>`;
  }).join('');
}

function ciBarCell(value, pct, color) {
  if (!value || value === 0) {
    return `<span style="font-family:var(--mono);color:var(--text-3);font-size:11px;">—</span>`;
  }
  return `
    <div class="ci-bar-wrap">
      <div class="ci-bar-bg">
        <div class="ci-bar-fill" style="width:${pct}%;background:${color};"></div>
      </div>
      <span style="font-family:var(--mono);font-size:11px;color:${color};min-width:52px;text-align:right;">
        ${formatCI(value)}
      </span>
    </div>`;
}

function formatCI(value) {
  if (!value || value === 0) return '—';
  return (value * 100).toFixed(3) + '%';
}

// ── System autocomplete ───────────────────────────────────────────────────────

async function handleCISystemInput() {
  const input = document.getElementById('ciSystemSearch');
  const drop  = document.getElementById('ciSystemDrop');
  if (!input || !drop) return;

  const q = input.value.trim();
  if (q.length < 2) { drop.style.display = 'none'; return; }

  // Search local map first
  const ql = q.toLowerCase();
  const matches = Object.entries(_ciSystemMap)
    .filter(([, info]) => info.name.toLowerCase().startsWith(ql))
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .slice(0, 20);

  if (matches.length === 0 && Object.keys(_ciSystemMap).length > 0) {
    drop.innerHTML = `<div style="padding:8px 12px;font-family:var(--mono);font-size:11px;
      color:var(--text-3);">No system found</div>`;
    drop.style.display = 'block';
    return;
  }

  drop.innerHTML = matches.map(([id, info]) => `
    <div class="ci-drop-item" data-id="${id}" data-name="${escHtml(info.name)}"
         style="padding:7px 12px;cursor:pointer;font-family:var(--mono);font-size:12px;
                color:var(--text-1);border-bottom:1px solid var(--border);"
         onmouseover="this.style.background='var(--bg-hover)'"
         onmouseout="this.style.background=''">
      <span style="font-weight:600;">${escHtml(info.name)}</span>
      <span style="font-size:10px;color:var(--text-3);margin-left:8px;">${escHtml(info.regionName)}</span>
    </div>`).join('');

  drop.querySelectorAll('.ci-drop-item').forEach(item => {
    item.addEventListener('click', () => {
      input.value  = item.dataset.name;
      _ciSystemQuery = item.dataset.name;
      drop.style.display = 'none';
      // Clear region filter when using system search
      const regionSel = document.getElementById('ciRegionSel');
      if (regionSel) { regionSel.value = ''; _ciRegion = ''; }
      applyCIFilters();
    });
  });

  drop.style.display = matches.length > 0 ? 'block' : 'none';
}