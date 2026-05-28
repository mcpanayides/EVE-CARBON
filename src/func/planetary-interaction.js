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

// ─── Entry point ──────────────────────────────────────────────────────────────
async function loadPlanetaryInteraction() {
  const container = document.getElementById('piContainer');
  if (!container) return;

  _piAllCharData = [];
  _piJumpCache   = {};
  _piOriginSysId = null;

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

  return {
    charId,
    charName,
    portraitUrl: `https://images.evetech.net/characters/${charId}/portrait?size=64`,
    colonies: data?.piColonies ?? [],
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

  let html = '';
  for (const { charId, charName, portraitUrl, colonies } of filtered) {
    html += `
      <div class="pi-char-section">
        <div class="pi-char-header">
          <img class="pi-char-portrait"
               src="${portraitUrl}"
               alt="${escHtml(charName)}"
               onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'54\\' height=\\'54\\'%3E%3Ccircle cx=\\'27\\' cy=\\'27\\' r=\\'27\\' fill=\\'%231a1a1a\\'/%3E%3C/svg%3E'">
          <span class="pi-char-name">${escHtml(charName)}</span>
          <span class="pi-char-planet-count">${colonies.length} / 6</span>
        </div>
        <div class="pi-grid">
          ${colonies.map(col => buildColonyCard(col, portraitUrl, charName)).join('')}
        </div>
      </div>
    `;
  }
  body.innerHTML = html;
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
  if (colony.storage_full) {
    return { cls: 'warning', text: 'Storage at Capacity' };
  }
  return { cls: 'idle', text: 'Idle / Waiting' };
}

// ─── Build a single colony card ───────────────────────────────────────────────
function buildColonyCard(colony, portraitUrl, charName) {
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
      <div class="pi-card-top">
        <div class="pi-card-owner">
          <img class="pi-planet-render" src="${imgSrc}"
               onerror="this.onerror=null;this.src='https://images.evetech.net/types/2016/icon?size=64'"
               alt="${escHtml(planetType)}">
          <img class="pi-owner-portrait"
               src="${portraitUrl}"
               alt="${escHtml(charName)}"
               title="${escHtml(charName)}"
               onerror="this.style.display='none'">
        </div>
        <div class="pi-info">
          <div class="pi-planet-name">${escHtml(planetLabel)}</div>
          <div class="pi-planet-type">${escHtml(planetType)}</div>
        </div>
        <div class="pi-card-badges">
          <div class="pi-cc-badge">CC Lvl ${colony.upgrade_level || 0}</div>
          ${jumpHtml}
        </div>
      </div>

      <div class="pi-stats-grid">
        <div class="pi-stat-box">
          <span class="pi-stat-label">Installations</span>
          <span class="pi-stat-value">${colony.num_pins || 0} Pins</span>
        </div>
        <div class="pi-stat-box">
          <span class="pi-stat-label">System</span>
          <span class="pi-stat-value">${escHtml(colony.solar_system_name || 'Unknown')}</span>
        </div>
      </div>

      <div class="pi-status ${statusClass}">${statusText}</div>
    </div>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getPlanetLabel(colony) {
  const system = colony.solar_system_name || 'Unknown System';
  const num    = colony.planet_id ? (colony.planet_id % 100) : null;
  const roman  = ['','I','II','III','IV','V','VI','VII','VIII','IX','X',
                  'XI','XII','XIII','XIV','XV','XVI'];
  const suffix = (num && num >= 1 && num <= 16) ? roman[num] : (num || '?');
  return `${system} ${suffix}`;
}