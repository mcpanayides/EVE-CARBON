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

// Derive a human-readable planet name: "System Name IV"
function getPlanetLabel(colony) {
  const system = colony.solar_system_name || 'Unknown System';
  const num    = colony.planet_id ? (colony.planet_id % 100) : null;
  const roman  = ['','I','II','III','IV','V','VI','VII','VIII','IX','X',
                  'XI','XII','XIII','XIV','XV','XVI'];
  const suffix = (num && num >= 1 && num <= 16) ? roman[num] : (num || '?');
  return `${system} ${suffix}`;
}

async function loadPlanetaryInteraction() {
  const container = document.getElementById('piContainer');
  if (!container) return;

  if (!selectedCharacterId) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">No Character Selected</div>
        <div class="empty-sub">Please select a character to view Planetary Interaction.</div>
      </div>`;
    return;
  }

  container.innerHTML = '<div class="loading-row">Syncing Planetary Networks...</div>';

  try {
    const colonies = await window.eveAPI.getPIColonies(selectedCharacterId);

    if (!colonies || colonies.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" style="color:var(--text-3)">🪐</div>
          <div class="empty-title">No Colonies Found</div>
          <div class="empty-sub">This character does not have any active planetary command centers.</div>
        </div>`;
      return;
    }

    renderPIColonies(colonies, container);
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

function renderPIColonies(colonies, container) {
  let html = `
    <div class="pi-container">
      <div class="pi-header-row">
        <div class="pi-title">Planetary Networks</div>
        <div class="panel-count">${colonies.length} / 6 Colonies</div>
      </div>
      <div class="pi-grid">
  `;

  colonies.forEach(colony => {
    let statusClass = 'idle';
    let statusText  = 'Idle / Waiting';
    if (colony.is_extracting) {
      statusClass = 'active';
      statusText  = 'Extracting Resources';
    } else if (colony.storage_full) {
      statusClass = 'warning';
      statusText  = 'Storage at Capacity';
    }

    const typeKey     = (colony.planet_type || '').toLowerCase().trim();
    const typeId      = PI_PLANET_TYPE_IDS[typeKey] || 2016;
    // Correct URL format confirmed via images.evetech.net — icon, not render
    const imgSrc      = `https://images.evetech.net/types/${typeId}/icon?size=64`;
    const planetLabel = getPlanetLabel(colony);
    const planetType  = colony.planet_type
      ? colony.planet_type.charAt(0).toUpperCase() + colony.planet_type.slice(1).toLowerCase()
      : 'Unknown Type';

    html += `
      <div class="pi-card">
        <div class="pi-card-top">
          <img class="pi-planet-render" src="${imgSrc}"
               onerror="this.onerror=null;this.src='https://images.evetech.net/types/2016/icon?size=64'"
               alt="${escHtml(planetType)}">
          <div class="pi-info">
            <div class="pi-planet-name">${escHtml(planetLabel)}</div>
            <div class="pi-planet-type">${escHtml(planetType)}</div>
          </div>
          <div class="pi-cc-badge">CC Lvl ${colony.upgrade_level || 0}</div>
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

        <div class="pi-status ${statusClass}">
          ${statusText}
        </div>
      </div>
    `;
  });

  html += `
      </div>
    </div>
  `;

  container.innerHTML = html;
}