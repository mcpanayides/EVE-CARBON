// ─── PlanetaryInteraction.js ──────────────────────────────────────────────────

// Confirmed type IDs from EVERef (everef.net/groups/7).
// Image URL format: https://images.evetech.net/types/{id}/icon?size=64
const PI_PLANET_TYPE_IDS = {
  temperate:  11,
  oceanic:    2014,
  ice:        12,
  gas:        13,
  lava:       2015,
  barren:     2016,
  storm:      2017,
  plasma:     2063,
  shattered:  30889,
};

// ─── Module state ─────────────────────────────────────────────────────────────
let _piAllCharData   = [];
let _piJumpCache     = {};
let _piOriginSysId   = null;
let _piOriginSysName = '';
const _piPinsMap     = new Map();  // planet_id → raw ESI pins[]
let _piPlanetNames   = {};         // planet_id → real celestial name ("Zoohen III")

// ─── Resolve real planet names from ESI ───────────────────────────────────────
// planet_id is a celestial ID — the SDE type tables can't name it, and deriving
// a numeral from the ID is wrong (that's where "Planet 98" came from). ESI's
// /universe/planets/{id}/ returns the true name; names never change, so cache
// them on disk for a year.
async function resolvePlanetNames(planetIds) {
  try { _piPlanetNames = (await window.eveAPI.cacheGet('pi-planet-names')) || {}; }
  catch { _piPlanetNames = {}; }

  const missing = [...new Set(planetIds)].filter(id => id && !_piPlanetNames[id]);
  if (missing.length === 0) return;

  await Promise.allSettled(missing.map(async id => {
    try {
      const res = await fetch(
        `https://esi.evetech.net/latest/universe/planets/${id}/?datasource=tranquility`
      );
      if (res.ok) {
        const j = await res.json();
        if (j?.name) _piPlanetNames[id] = j.name;
      }
    } catch { /* leave unresolved — falls back to system name */ }
  }));

  try { await window.eveAPI.cacheSet('pi-planet-names', _piPlanetNames, 365); } catch {}
}

// ─── Auto-sync all characters' PI data, then re-render ───────────────────────
// Fired on entry to the PI page (see navigateToPage). Staleness-gated to 15 min so
// flipping back and forth doesn't re-hit ESI; no manual "Sync" button needed.
let _piLastSync = 0;
let _piSyncing  = false;
async function _autoSyncPIIfStale() {
  if (_piSyncing) return;
  const now = Date.now();
  if (now - _piLastSync < 15 * 60 * 1000) return;          // recently synced — skip
  if (typeof window.eveAPI.syncPI !== 'function') return;  // preload too old
  _piLastSync = now;
  _piSyncing  = true;
  try {
    const accounts = await window.eveAPI.getAccounts().catch(() => []);
    await Promise.allSettled((accounts || []).map(acc => {
      const charId = acc.characterId ?? acc.character_id ?? acc.id;
      return window.eveAPI.syncPI(charId).catch(err => console.warn('[PI] sync failed for', charId, err));
    }));
  } finally { _piSyncing = false; }
  // Re-render if the user is still on the PI page.
  if (typeof currentPage === 'undefined' || currentPage === 'pi') loadPlanetaryInteraction();
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function loadPlanetaryInteraction() {
  const container = document.getElementById('piContainer');
  if (!container) return;

  _piAllCharData = [];
  _piJumpCache   = {};
  _piOriginSysId = null;
  _piPinsMap.clear();

  container.innerHTML = '<div class="loading-row">Syncing Planetary Networks...</div>';

  try {
    const accounts = await window.eveAPI.getAccounts().catch(() => []);

    if (!accounts || accounts.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No Character Selected</div>
          <div class="empty-sub">Please add a character to view Planetary Interaction.</div>
        </div>`;
      return;
    }

    const allResults = await Promise.allSettled(
      accounts.map(acc => loadCharacterColonies(acc))
    );

    _piAllCharData = allResults
      .filter(r => r.status === 'fulfilled' && r.value.colonies.length > 0)
      .map(r => r.value);

    if (_piAllCharData.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" style="color:var(--text-3)">🪐</div>
          <div class="empty-title">No Colonies Found</div>
          <div class="empty-sub">No active planetary command centers found across your characters.</div>
        </div>`;
      return;
    }

    // Resolve real planet names (cached — only hits ESI for new colonies)
    await resolvePlanetNames(
      _piAllCharData.flatMap(c => c.colonies.map(col => col.planet_id))
    );

    // Reference system for range filter — prefer selectedCharacterId
    const refAcct = accounts.find(a =>
      (a.characterId ?? a.character_id ?? a.id) === selectedCharacterId
    ) ?? accounts[0];

    if (refAcct) {
      const refId   = refAcct.characterId ?? refAcct.character_id ?? refAcct.id;
      const refData = await window.eveAPI.getCharacterData(refId).catch(() => null);
      _piOriginSysId   = refData?.location?.solar_system_id   ?? null;
      _piOriginSysName = refData?.location?.solar_system_name ?? '';
    }

    if (_piOriginSysId) {
      await prefetchJumpDistances(_piOriginSysId, _piAllCharData);
    }

    renderPIShell(container);

  } catch (error) {
    console.error('Failed to load PI:', error);
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" style="color:var(--danger)">⚠</div>
        <div class="empty-title">Network Error</div>
        <div class="empty-sub">Failed to establish connection to planetary networks.</div>
      </div>`;
  }
}

// ─── Load one character's colonies from the local DB ──────────────────────────
async function loadCharacterColonies(account) {
  const charId  = account.characterId ?? account.character_id ?? account.id;
  const data    = await window.eveAPI.getCharacterData(charId).catch(() => null);
  const charName = data?.info?.character_name
    ?? account.characterName ?? account.character_name
    ?? account.name ?? `Character ${charId}`;

  const rawColonies = data?.piColonies ?? [];

  rawColonies.forEach(col => {
    if (col.pins_json) {
      try { _piPinsMap.set(col.planet_id, JSON.parse(col.pins_json)); }
      catch { /* ignore malformed JSON */ }
    }
  });

  return {
    charId,
    charName,
    portraitUrl: `https://images.evetech.net/characters/${charId}/portrait?size=64`,
    colonies: rawColonies.map(col => ({
      ...col,
      storage: col.storage_json ? JSON.parse(col.storage_json) : [],
    })),
  };
}

// ─── Pre-fetch jump distances via ESI route API ───────────────────────────────
async function prefetchJumpDistances(originSysId, charData) {
  const uniqueSystems = new Set();
  for (const { colonies } of charData) {
    for (const col of colonies) {
      if (col.solar_system_id && col.solar_system_id !== originSysId) {
        uniqueSystems.add(col.solar_system_id);
      }
    }
  }
  await Promise.allSettled(
    [...uniqueSystems].map(async destId => {
      const key = `${originSysId}:${destId}`;
      if (_piJumpCache[key] !== undefined) return;
      try {
        const res = await fetch(
          `https://esi.evetech.net/latest/route/${originSysId}/${destId}/?datasource=tranquility`
        );
        _piJumpCache[key] = res.ok
          ? (await res.json()).length - 1
          : null;
      } catch { _piJumpCache[key] = null; }
    })
  );
}

function getJumps(colonySysId) {
  if (!_piOriginSysId || !colonySysId) return null;
  if (colonySysId === _piOriginSysId) return 0;
  return _piJumpCache[`${_piOriginSysId}:${colonySysId}`] ?? null;
}

// ─── Render shell: horizontal filter bar + colony body ────────────────────────
function renderPIShell(container) {
  const totalColonies = _piAllCharData.reduce((n, c) => n + c.colonies.length, 0);

  const allTypes = [...new Set(
    _piAllCharData.flatMap(c => c.colonies.map(col => (col.planet_type || '').toLowerCase()))
  )].filter(Boolean).sort();

  const allSystems = [...new Set(
    _piAllCharData.flatMap(c => c.colonies.map(col => col.solar_system_name || ''))
  )].filter(Boolean).sort();

  const allChars = _piAllCharData.map(c => ({ id: c.charId, name: c.charName }));

  const rangeDisabled = !_piOriginSysId ? 'disabled' : '';
  const rangeTitle    = _piOriginSysId
    ? `From ${escHtml(_piOriginSysName || 'current system')}`
    : 'Range';

  container.innerHTML = `
    <div class="pi-container">

      <div class="pi-header-row">
        <span class="pi-title">Planetary Networks</span>
        <span class="panel-count" id="piColonyCount">
          ${totalColonies} Colon${totalColonies !== 1 ? 'ies' : 'y'} &mdash; ${allChars.length} Character${allChars.length !== 1 ? 's' : ''}
        </span>
      </div>

      <!-- Horizontal filter bar -->
      <div class="pi-filter-bar">

        <div class="pi-filter-item">
          <span class="pi-filter-label">Character</span>
          <select class="pi-filter-select" id="piFilterChar">
            <option value="all">All</option>
            ${allChars.map(c => `<option value="${c.id}">${escHtml(c.name)}</option>`).join('')}
          </select>
        </div>

        <div class="pi-filter-sep"></div>

        <div class="pi-filter-item">
          <span class="pi-filter-label">Type</span>
          <select class="pi-filter-select" id="piFilterType">
            <option value="all">All</option>
            ${allTypes.map(t => `<option value="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</option>`).join('')}
          </select>
        </div>

        <div class="pi-filter-sep"></div>

        <div class="pi-filter-item">
          <span class="pi-filter-label">System</span>
          <select class="pi-filter-select" id="piFilterSystem">
            <option value="all">All</option>
            ${allSystems.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('')}
          </select>
        </div>

        <div class="pi-filter-sep"></div>

        <div class="pi-filter-item">
          <span class="pi-filter-label">${rangeTitle}</span>
          <select class="pi-filter-select" id="piFilterRange" ${rangeDisabled}>
            <option value="all">Any</option>
            <option value="0">Here</option>
            <option value="1">≤ 1j</option>
            <option value="3">≤ 3j</option>
            <option value="5">≤ 5j</option>
            <option value="10">≤ 10j</option>
            <option value="20">≤ 20j</option>
          </select>
        </div>

        <div class="pi-filter-sep"></div>

        <button class="pi-filter-reset" id="piFilterReset">✕ Reset</button>

      </div>

      <!-- Colony sections re-rendered by applyPIFilters() -->
      <div id="piColonyBody"></div>

    </div>
  `;

  ['piFilterChar','piFilterType','piFilterSystem','piFilterRange'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyPIFilters);
  });
  document.getElementById('piFilterReset')?.addEventListener('click', resetPIFilters);

  applyPIFilters();
}

// ─── Apply filters and re-render colony body ──────────────────────────────────
function applyPIFilters() {
  const filterChar   = document.getElementById('piFilterChar')?.value   ?? 'all';
  const filterType   = document.getElementById('piFilterType')?.value   ?? 'all';
  const filterSystem = document.getElementById('piFilterSystem')?.value ?? 'all';
  const filterRange  = document.getElementById('piFilterRange')?.value  ?? 'all';
  const maxJumps     = filterRange === 'all' ? null : parseInt(filterRange, 10);

  const body = document.getElementById('piColonyBody');
  if (!body) return;

  const isFiltered = filterChar !== 'all' || filterType !== 'all'
    || filterSystem !== 'all' || filterRange !== 'all';

  const filtered = _piAllCharData
    .filter(c => filterChar === 'all' || String(c.charId) === String(filterChar))
    .map(c => ({
      ...c,
      colonies: c.colonies.filter(col => {
        if (filterType !== 'all' && (col.planet_type || '').toLowerCase() !== filterType) return false;
        if (filterSystem !== 'all' && (col.solar_system_name || '') !== filterSystem) return false;
        if (maxJumps !== null) {
          const j = getJumps(col.solar_system_id);
          if (j === null || j > maxJumps) return false;
        }
        return true;
      }),
    }))
    .filter(c => c.colonies.length > 0);

  const total = filtered.reduce((n, c) => n + c.colonies.length, 0);
  const countEl = document.getElementById('piColonyCount');
  if (countEl) {
    const badge = isFiltered ? ' <span class="pi-filter-active-badge">filtered</span>' : '';
    countEl.innerHTML = `${total} Colon${total !== 1 ? 'ies' : 'y'} &mdash; ${filtered.length} Character${filtered.length !== 1 ? 's' : ''}${badge}`;
  }

  if (filtered.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" style="color:var(--text-3)">🔭</div>
        <div class="empty-title">No Colonies Match</div>
        <div class="empty-sub">Try adjusting your filters.</div>
      </div>`;
    return;
  }

  // Flatten every character's colonies into one grid. Each card already shows
  // the owning character's portrait pip, so no per-character grouping is needed.
  const cards = filtered
    .flatMap(({ charId, portraitUrl, charName, colonies }) =>
      colonies.map(col => buildColonyCard(col, portraitUrl, charName, charId)))
    .join('');
  body.innerHTML = `<div class="pi-grid">${cards}</div>`;
}

// ─── Reset all filters ────────────────────────────────────────────────────────
function resetPIFilters() {
  ['piFilterChar','piFilterType','piFilterSystem','piFilterRange'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  applyPIFilters();
}

// ─── Derive colony status from the stored extractor_expires_at field ──────────
// main.js fetches per-planet pin detail during sync and stores the soonest
// future extractor expiry as extractor_expires_at (ms epoch).  We just read it.
function getColonyStatus(colony) {
  const expiresAt = colony.extractor_expires_at;
  if (expiresAt && expiresAt > Date.now()) {
    const diffMs  = expiresAt - Date.now();
    const hrs     = Math.floor(diffMs / 3_600_000);
    const mins    = Math.floor((diffMs % 3_600_000) / 60_000);
    const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    return { cls: 'active', text: `Extracting — expires in ${timeStr}` };
  }
  if (colony.storage && colony.storage.some(s => s.fill_pct >= 90)) {
    return { cls: 'warning', text: 'Storage at Capacity' };
  }
  return { cls: 'idle', text: 'Idle / Waiting' };
}

// ─── Facilities list HTML (grouped pins) for the detail panel ─────────────────
async function buildPinsListHtml(planetId) {
  const pins = _piPinsMap.get(planetId) || [];
  if (pins.length === 0) {
    return '<div class="pi-detail-empty">No facility data — resync PI to populate.</div>';
  }

  // Group by type_id, tracking soonest expiry
  const groups = new Map();
  for (const pin of pins) {
    if (!groups.has(pin.type_id)) groups.set(pin.type_id, { count: 0, expiryMs: null });
    const g = groups.get(pin.type_id);
    g.count++;
    if (pin.expiry_time) {
      const t = new Date(pin.expiry_time).getTime();
      if (!g.expiryMs || t < g.expiryMs) g.expiryMs = t;
    }
  }

  // Resolve SDE names for all unique type IDs
  const nameMap = {};
  await Promise.all([...groups.keys()].map(async typeId => {
    const name = await window.eveAPI.sdeGetName(typeId).catch(() => null);
    nameMap[typeId] = name || `Type ${typeId}`;
  }));

  // Most common first, then alphabetically
  const sorted = [...groups.entries()].sort((a, b) =>
    b[1].count - a[1].count || nameMap[a[0]].localeCompare(nameMap[b[0]])
  );

  const now = Date.now();
  let html = '';
  for (const [typeId, g] of sorted) {
    const name    = escHtml(nameMap[typeId]);
    const iconUrl = `https://images.evetech.net/types/${typeId}/icon?size=32`;
    let   extra   = '';
    if (g.expiryMs) {
      const diffMs = g.expiryMs - now;
      if (diffMs > 0) {
        const hrs  = Math.floor(diffMs / 3_600_000);
        const mins = Math.floor((diffMs % 3_600_000) / 60_000);
        extra = `<span class="pi-pin-expiry">${hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`}</span>`;
      }
    }
    html += `
      <div class="pi-pin-row">
        <img class="pi-pin-icon" src="${iconUrl}"
             onerror="this.style.visibility='hidden'" alt="">
        <span class="pi-pin-name">${name}</span>
        ${extra}
        <span class="pi-pin-count">×${g.count}</span>
      </div>`;
  }
  return `<div class="pi-pins-list">${html}</div>`;
}

// ─── Planet detail panel — big planet visual + full colony breakdown ──────────
// Opened by the "View Details" button on a colony card. The hero image uses the
// full-size type render (placeholder until the animated clips arrive).
function _piEscListener(e) { if (e.key === 'Escape') closePIDetail(); }

function closePIDetail() {
  const back = document.getElementById('piDetailBackdrop');
  if (back) back.style.display = 'none';
  document.removeEventListener('keydown', _piEscListener);
}

async function openPIDetail(planetId, charId) {
  const charData = _piAllCharData.find(c => String(c.charId) === String(charId));
  const colony   = charData?.colonies.find(c => c.planet_id === planetId);
  if (!colony) return;

  const typeKey    = (colony.planet_type || '').toLowerCase().trim();
  const typeId     = PI_PLANET_TYPE_IDS[typeKey] || 2016;
  const renderUrl  = `https://images.evetech.net/types/${typeId}/render?size=512`;
  const iconUrl    = `https://images.evetech.net/types/${typeId}/icon?size=64`;
  const planetName = getPlanetLabel(colony);
  const planetType = colony.planet_type
    ? colony.planet_type.charAt(0).toUpperCase() + colony.planet_type.slice(1).toLowerCase()
    : 'Unknown Type';

  const { cls: statusClass, text: statusText } = getColonyStatus(colony);
  const jumps    = getJumps(colony.solar_system_id);
  const jumpText = jumps === null ? '' : jumps === 0 ? ' · Here' : ` · ${jumps} jump${jumps !== 1 ? 's' : ''}`;

  // Create the backdrop once, reuse it after
  let back = document.getElementById('piDetailBackdrop');
  if (!back) {
    back = document.createElement('div');
    back.id        = 'piDetailBackdrop';
    back.className = 'modal-backdrop';
    back.style.cssText = 'display:none; position:fixed; inset:0;';
    back.addEventListener('click', e => { if (e.target === back) closePIDetail(); });
    document.body.appendChild(back);
  }

  back.innerHTML = `
    <div class="modal pi-detail-modal">

      <!-- Hero: blown-up planet render with name overlay -->
      <div class="pi-detail-hero">
        <img class="pi-detail-img" src="${renderUrl}"
             onerror="this.onerror=null;this.src='${iconUrl}'" alt="${escHtml(planetType)}">
        <div class="pi-detail-hero-shade"></div>
        <button class="icon-btn pi-detail-close" onclick="closePIDetail()" title="Close">✕</button>
        <div class="pi-detail-hero-text">
          <div class="pi-detail-name">${escHtml(planetName)}</div>
          <div class="pi-detail-sub">${escHtml(planetType)} · ${escHtml(colony.solar_system_name || 'Unknown System')}${jumpText}</div>
        </div>
      </div>

      <div class="pi-detail-body">

        <!-- Status strip -->
        <div class="pi-status ${statusClass} pi-detail-status">${statusText}</div>

        <!-- Stat blocks -->
        <div class="pi-detail-stats">
          <div class="pi-detail-stat">
            <div class="pi-detail-stat-label">Character</div>
            <div class="pi-detail-stat-value pi-detail-char">
              <img src="${charData.portraitUrl}" alt="" onerror="this.style.display='none'">
              <span>${escHtml(charData.charName)}</span>
            </div>
          </div>
          <div class="pi-detail-stat">
            <div class="pi-detail-stat-label">Command Center</div>
            <div class="pi-detail-stat-value">Level ${colony.upgrade_level || 0}</div>
          </div>
          <div class="pi-detail-stat">
            <div class="pi-detail-stat-label">Installations</div>
            <div class="pi-detail-stat-value">${colony.num_pins || 0} Pins</div>
          </div>
        </div>

        <!-- Storage -->
        <div class="pi-detail-section-label">Storage</div>
        ${buildStorageBars(colony.storage) || '<div class="pi-detail-empty">No storage facilities.</div>'}

        <!-- Facilities -->
        <div class="pi-detail-section-label">Facilities</div>
        <div class="pi-detail-pins" id="piDetailPins">
          <div class="loading-row">Loading facilities…</div>
        </div>

      </div>
    </div>`;

  back.style.display = 'flex';
  document.addEventListener('keydown', _piEscListener);

  // Fill the facilities list asynchronously (SDE name lookups)
  const pinsEl = document.getElementById('piDetailPins');
  if (pinsEl) pinsEl.innerHTML = await buildPinsListHtml(planetId);
}

// ─── Build storage fill bars for a colony card ────────────────────────────────
// Launchpads  → green   Storage Facilities → blue
// Both go amber ≥70% and red ≥90%.
// Uses the label field set by summariseStorage ('Launchpad' / 'Storage Facility').

function buildStorageBars(storage) {
  if (!storage || storage.length === 0) return '';
  const rows = storage.map(s => {
    const isLaunchpad = s.label === 'Launchpad';
    const baseColor   = isLaunchpad ? 'green' : 'blue';
    const fillCls     = s.fill_pct >= 90 ? 'critical'
                      : s.fill_pct >= 70 ? 'high'
                      : baseColor;
    const shortLabel  = isLaunchpad ? 'LP' : 'SF';
    return `
      <div class="pi-bar-row">
        <span class="pi-bar-label">${shortLabel}</span>
        <div class="pi-bar-track">
          <div class="pi-bar-fill ${fillCls}" style="width:${s.fill_pct}%"></div>
        </div>
        <span class="pi-bar-pct">${s.fill_pct}%</span>
      </div>`;
  }).join('');
  return `<div class="pi-bars-block">${rows}</div>`;
}
// ─── Build a single colony card ───────────────────────────────────────────────
// Clean spatial card: [planet icon + portrait pip] | [name / type / bars] with
// a footer of status + View Details. All the deep info (CC level, facilities,
// extractors) lives in the detail panel — openPIDetail().
function buildColonyCard(colony, portraitUrl, charName, charId) {
  const { cls: statusClass, text: statusText } = getColonyStatus(colony);

  const typeKey     = (colony.planet_type || '').toLowerCase().trim();
  const typeId      = PI_PLANET_TYPE_IDS[typeKey] || 2016;
  const imgSrc      = `https://images.evetech.net/types/${typeId}/icon?size=64`;
  const planetLabel = getPlanetLabel(colony);
  const planetType  = colony.planet_type
    ? colony.planet_type.charAt(0).toUpperCase() + colony.planet_type.slice(1).toLowerCase()
    : 'Unknown Type';

  const jumps    = getJumps(colony.solar_system_id);
  const jumpCls  = jumps === null ? 'far'
    : jumps === 0          ? 'same'
    : jumps <= 3           ? 'near-green'
    : jumps <= 6           ? 'near-yellow'
    : 'far-red';
  const jumpText = jumps === null ? '? Jumps'
    : jumps === 0          ? 'Here'
    : `${jumps} Jump${jumps !== 1 ? 's' : ''}`;
  const jumpHtml = _piOriginSysId
    ? `<span class="pi-jump-badge ${jumpCls}">${jumpText}</span>`
    : '';

  return `
    <div class="pi-card">

      <!-- ── Top row: icon · info · jump badge ───────────────────────────── -->
      <div class="pi-card-row">

        <!-- Planet icon with owner portrait overlay (blueprint-style) -->
        <div class="pi-card-icon-wrap">
          <img class="pi-card-planet-img" src="${imgSrc}"
               onerror="this.onerror=null;this.src='https://images.evetech.net/types/2016/icon?size=64'"
               alt="${escHtml(planetType)}">
          <img class="pi-card-portrait-pip"
               src="${portraitUrl}"
               alt="${escHtml(charName)}"
               title="${escHtml(charName)}"
               onerror="this.style.display='none'">
        </div>

        <!-- Name, type, system, then storage bars -->
        <div class="pi-card-body">
          <div class="pi-card-name">${escHtml(planetLabel)}</div>
          <div class="pi-card-type">${escHtml(planetType)} · ${escHtml(colony.solar_system_name || 'Unknown')}</div>
          ${buildStorageBars(colony.storage)}
        </div>

        <div class="pi-card-meta">
          ${jumpHtml}
        </div>

      </div>

      <!-- ── Footer: status + details ─────────────────────────────────────── -->
      <div class="pi-card-footer">
        <div class="pi-status ${statusClass}">${statusText}</div>
        <button class="pi-details-btn"
                onclick="openPIDetail(${colony.planet_id}, '${charId}')">
          View Details ›
        </button>
      </div>

    </div>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Real celestial name from ESI (resolved + cached at load). Falls back to the
// system name if ESI hasn't answered — never invents a planet numeral.
function getPlanetLabel(colony) {
  const esiName = colony.planet_id ? _piPlanetNames[colony.planet_id] : null;
  if (esiName) return esiName;
  return colony.solar_system_name || 'Unknown Planet';
}