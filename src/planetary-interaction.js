// ─── PlanetaryInteraction.js ──────────────────────────────────────────────────

async function loadPlanetaryInteraction() {
  const container = document.getElementById('piContainer'); // Ensure this exists in your HTML
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
    // Assuming you wired this via IPC
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
  // Build the outer layout
  let html = `
    <div class="pi-container">
      <div class="pi-header-row">
        <div class="pi-title">Planetary Networks</div>
        <div class="panel-count">${colonies.length} / 6 Colonies</div>
      </div>
      <div class="pi-grid">
  `;

  // Build each colony card
  colonies.forEach(colony => {
    // Determine status colors based on your data structure
    // (Adjust these conditions based on how you save 'extracting' or 'full' states in your DB)
    let statusClass = 'idle';
    let statusText = 'Idle / Waiting';
    
    if (colony.is_extracting) {
      statusClass = 'active';
      statusText = 'Extracting Resources';
    } else if (colony.storage_full) {
      statusClass = 'warning';
      statusText = 'Storage at Capacity';
    }

    // ESI requires the planet TYPE ID for renders, not the unique item ID.
    // E.g., Lava Planet TypeID = 11, Temperate = 12. 
    // Fallback to a generic EVE icon if type_id is missing.
    const imgSrc = colony.planet_type_id 
      ? `https://images.evetech.net/types/${colony.planet_type_id}/render?size=128`
      : `https://images.evetech.net/types/11/icon?size=128`; 

    html += `
      <div class="pi-card">
        <div class="pi-card-top">
          <img class="pi-planet-render" src="${imgSrc}" onerror="this.src='fallback.png'">
          <div class="pi-info">
            <div class="pi-planet-name">${escHtml(colony.planet_name || 'Unknown Planet')}</div>
            <div class="pi-planet-type">${escHtml(colony.planet_type || 'Unknown Type')}</div>
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