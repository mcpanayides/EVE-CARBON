// ─── pageLoader.js ────────────────────────────────────────────────────────────
// Injects all page HTML directly into #navPagesContainer using template literals.
// No fetch() or filesystem access needed — works natively in Electron's renderer.
//
// To add a new page:
//   1. Add its HTML as a new template literal in PAGE_HTML below.
//   2. That's it — no other files need changing.

const PAGE_HTML = {

  // ── Characters ─────────────────────────────────────────────────────────────
  characters: `
    <div id="page-characters" class="nav-page active"
         style="flex-direction:column; height:100%; min-width:0; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Characters</h2>
          <div class="page-description">
            The first character is selected by default on startup.
            Drag cards to reorder your character list.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('characters')">✕</button>
      </div>

      <div id="selectedCharacterSection"
           style="display:none; padding:20px; border-bottom:1px solid var(--border); background:var(--bg-card);">
        <div class="selected-character-card">
          <div style="display:flex; gap:16px; align-items:center;">
            <img id="selectedCharPortrait" src="" alt=""
                 style="width:64px; height:64px; border-radius:50%; border:2px solid var(--accent); object-fit:cover;" />
            <div style="flex:1;">
              <div style="font-size:11px; color:var(--text-2); letter-spacing:0.1em; margin-bottom:4px; font-weight:600;">
                SELECTED CHARACTER
              </div>
              <div id="selectedCharName"
                   style="font-size:18px; font-weight:600; color:var(--text-1); margin-bottom:4px;">
                No Character Selected
              </div>
              <div id="selectedCharMeta"
                   style="font-size:10px; color:var(--text-3); font-family:var(--mono);"></div>
            </div>
            <button class="char-action-btn" onclick="clearSelectedCharacter()" title="Clear selection">✕</button>
          </div>
        </div>
      </div>

      <div class="char-filter-row"
           style="padding:15px; border-bottom:1px solid var(--border); display:flex;
                  flex-wrap:wrap; gap:15px; background:var(--bg-card); align-items:center;">
        <input type="text" id="charSearch" class="field-input"
               style="flex:1; min-width:200px; font-size:14px; padding:10px;"
               placeholder="Search characters..." />
        <button class="add-character-btn" id="addCharacterNavBtn" title="Add character">
          + ADD CHARACTER
        </button>
      </div>

      <div id="accountsListNav" class="accounts-grid">
        <div class="empty-state" style="width:100%;">
          <div class="empty-icon">⬡</div>
          <div class="empty-title">NO CHARACTERS</div>
          <div class="empty-sub">Click + ADD CHARACTER to login with EVE SSO.</div>
        </div>
      </div>
    </div>`,

  // ── Dashboard ───────────────────────────────────────────────────────────────
  dashboard: `
    <div id="page-dashboard" class="nav-page"
         style="flex-direction:column; height:100%; min-width:0; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Dashboard</h2>
          <div class="page-description">
            Command center — net worth, industry jobs, and character status.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('dashboard')">&#x2715;</button>
      </div>
      <div class="page-content"
           style="display:flex; flex-direction:column; gap:16px; padding:16px; overflow-y:auto;">
        <div id="dashboardWelcomeBanner" class="dashboard-welcome-banner"></div>
        <div id="dashboardContent" class="dashboard-grid" style="position:relative;">
          <div class="dashboard-panel" id="dashboardSummaryPanel">
            <div class="dashboard-panel-title">&#x2B21; NET WORTH &amp; WEALTH GROWTH</div>
            <div id="dashboardNetworthSummary"></div>
          </div>
          <div class="dashboard-panel" id="dashboardJobsPanel">
            <div class="dashboard-panel-title">&#x25C8; FINISHED INDUSTRY JOBS</div>
            <div id="dashboardJobsTable"></div>
          </div>
        </div>
      </div>
    </div>`,

  // ── Industry ────────────────────────────────────────────────────────────────
  industry: `
    <div id="page-industry" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Industry</h2>
          <div class="page-description">Manufacturing, blueprints, reactions and more.</div>
        </div>
        <button class="close-page-btn" onclick="closePage('industry')">✕</button>
      </div>
      <div class="industry-layout">
        <div class="industry-subnav">
          <div class="industry-subnav-label">TOOLS</div>
          <button class="industry-sub-btn active" data-industry-tab="blueprints">
            <span class="industry-sub-icon">⬡</span>My Blueprints
          </button>
          <button class="industry-sub-btn" data-industry-tab="search">
            <span class="industry-sub-icon">◑</span>BP Search
          </button>
          <button class="industry-sub-btn" data-industry-tab="active-jobs">
            <span class="industry-sub-icon">◈</span>Active Jobs
          </button>
          <button class="industry-sub-btn" data-industry-tab="calculator">
            <span class="industry-sub-icon">⚙</span>Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="cost-index">
            <span class="industry-sub-icon">◎</span>Cost Index
          </button>
          <button class="industry-sub-btn" data-industry-tab="shopping-lists">
            <span class="industry-sub-icon">⬡</span>Shopping Lists
          </button>
          <button class="industry-sub-btn" data-industry-tab="invention">
            <span class="industry-sub-icon">◆</span>Invention Buddy
          </button>
          <button class="industry-sub-btn" data-industry-tab="reactions">
            <span class="industry-sub-icon">◈</span>Reactions Profit
          </button>
          <button class="industry-sub-btn" data-industry-tab="ore">
            <span class="industry-sub-icon">⬡</span>Ore Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="ice">
            <span class="industry-sub-icon">⬡</span>Ice Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="gas">
            <span class="industry-sub-icon">⬡</span>Gas Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="moon">
            <span class="industry-sub-icon">◎</span>Moon Scanning
          </button>
        </div>
        <div id="industryTabContent" class="industry-content">
          <!-- Populated by navigateToPage('industry') → navigateIndustryTab('blueprints') -->
        </div>
      </div>
    </div>`,

  // ── Assets ──────────────────────────────────────────────────────────────────
  assets: `
    <div id="page-assets" class="nav-page"
         style="flex-direction:column; height:100%;">
      <div class="page-header">
        <div>
          <h2>Assets</h2>
          <div class="page-description">
            Loaded instantly from your local database — no ESI call.
            Sync characters on the Characters page to refresh.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('assets')">✕</button>
      </div>
      <div class="page-content"
           style="display:flex; flex-direction:column; gap:0; height:100%; overflow:hidden;">
        <div class="asset-toolbar"
             style="display:flex; flex-wrap:wrap; align-items:center; gap:10px;
                    padding:12px 16px; border-bottom:1px solid var(--border);
                    background:var(--bg-card); flex-shrink:0;">
          <span id="assetSummary" class="asset-summary" style="margin-right:auto;">Loading assets…</span>
          <input type="text" id="assetSearch" class="field-input"
                 style="width:220px; padding:7px 10px; font-size:13px;"
                 placeholder="Search items…" oninput="filterAssets()" />
          <select id="assetCharFilter" class="field-input"
                  style="width:180px; padding:7px 10px; font-size:13px;"
                  onchange="filterAssets()">
            <option value="">All Characters</option>
          </select>
          <select id="assetRegionFilter" class="field-input"
                  style="width:160px; padding:7px 10px; font-size:13px;"
                  onchange="filterAssets()">
            <option value="">All Regions</option>
          </select>
          <button class="icon-btn" onclick="loadAssets()"
                  title="Reload from local DB" style="padding:7px 14px; font-size:12px;">
            ⟳ RELOAD
          </button>
        </div>
        <div id="assetTableWrapper" class="asset-table-wrapper" style="flex:1; overflow-y:auto;">
          <table id="assetTable" class="asset-table">
            <thead>
              <tr>
                <th>Owner</th>
                <th class="asset-qty-header">Qty</th>
                <th>Item</th>
                <th>Location</th>
                <th>Solar System</th>
                <th>Region</th>
                <th>Sec</th>
                <th>Corp</th>
                <th>Jita 4-4 Value</th>
                <th>Volume (m³)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colspan="10" class="loading-row">
                  No assets loaded yet — sync a character on the Characters page first.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,

  // ── Wallets ─────────────────────────────────────────────────────────────────
  wallets: `
    <div id="page-wallets" class="nav-page"
         style="flex-direction:column; height:100%;">
      <div class="page-header">
        <div>
          <h2>Wallets</h2>
          <div class="page-description">
            Wallet balances are read from your local database.
            Sync characters on the Characters page to refresh.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('wallets')">✕</button>
      </div>
      <div style="display:flex; align-items:center; padding:12px 16px;
                  border-bottom:1px solid var(--border); background:var(--bg-card);
                  flex-shrink:0; flex-wrap:wrap; gap:10px;">
        <span id="walletsSummary" class="asset-summary"></span>
      </div>
      <div id="walletsTotalRow"
           style="display:none; padding:14px 20px; background:var(--bg-panel);
                  border-bottom:1px solid var(--border); flex-shrink:0;">
        <span style="font-size:11px; color:var(--text-2); letter-spacing:0.1em; font-weight:600;">
          COMBINED LIQUID WEALTH
        </span>
        <span id="walletsTotalValue"
              style="margin-left:16px; font-size:20px; font-weight:700;
                     color:var(--accent); font-family:var(--mono);">
          0.00 ISK
        </span>
      </div>
      <div class="page-content" style="overflow-y:auto; padding:16px;">
        <div class="wallets-grid" id="walletsGrid"></div>
      </div>
    </div>`,

  // ── Fleet Commander ─────────────────────────────────────────────────────────
  fc: `
    <div id="page-fc" class="nav-page"
         style="flex-direction:column; height:100%;">
      <div class="page-header">
        <h2>Fleet Commander</h2>
        <button class="close-page-btn" onclick="closePage('fc')">✕</button>
      </div>
      <div class="page-content">
        <p>Fleet command tools and information - coming soon</p>
      </div>
    </div>`,

  // ── Map ─────────────────────────────────────────────────────────────────────
  map: `
    <div id="page-map" class="nav-page"
         style="flex-direction:column; height:100%;">
      <div class="page-header">
        <h2>Map</h2>
        <button class="close-page-btn" onclick="closePage('map')">✕</button>
      </div>
      <div class="page-content">
        <p>Map and navigation page - coming soon</p>
      </div>
    </div>`,

  // ── Planetary Interaction ───────────────────────────────────────────────────
  pi: `
    <div id="page-pi" class="nav-page"
         style="flex-direction:column; height:100%; min-width:0; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Planetary Interaction</h2>
          <div class="page-description">
            Monitor your planetary colonies and extraction networks.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('pi')">✕</button>
      </div>
      <div id="piContainer" style="height:100%; overflow-y:auto;"></div>
    </div>`,

  // ── Forums ──────────────────────────────────────────────────────────────────
  forums: `
    <div id="page-forums" class="nav-page"
         style="flex-direction:column; height:100%;">
      <div class="page-header">
        <h2>Forums</h2>
        <button class="close-page-btn" onclick="closePage('forums')">✕</button>
      </div>
      <div class="page-content">
        <p>Forums and community links - coming soon</p>
      </div>
    </div>`,

  // ── Jabber ──────────────────────────────────────────────────────────────────
  jabber: `
    <div id="page-jabber" class="nav-page"
         style="flex-direction:column; height:100%;">
      <div class="page-header">
        <h2>Jabber</h2>
        <button class="close-page-btn" onclick="closePage('jabber')">✕</button>
      </div>
      <div class="page-content" style="display:flex; flex-direction:column; gap:18px;">
        <div class="panel"
             style="padding:16px; background:var(--bg-panel); border:1px solid var(--border); border-radius:10px;">
          <div style="font-size:13px; color:var(--text-2); line-height:1.5;">
            Jabber login settings are now managed in the settings menu.
            Open the ⚙ button and save your Jabber service, JID and password there,
            then return here to connect.
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
          <span id="jabberStatus" class="asset-summary">Connecting to Jabber...</span>
        </div>
        <div class="ping-filter-row">
          <span style="font-size:13px; color:var(--text-2);">
            Director bot filter is managed in the settings menu.
          </span>
          <span id="jabberSummary" class="asset-summary">No messages received yet.</span>
        </div>
        <div class="asset-table-wrapper" style="padding:0;">
          <table id="jabberTable" class="asset-table ping-table">
            <thead>
              <tr>
                <th>From</th><th>Message</th><th>Type</th><th>Director</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colspan="4" class="loading-row">
                  Auto-connecting to Jabber; saved settings are used from the settings menu.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`,

  // ── Market ──────────────────────────────────────────────────────────────────
  market: `
    <div id="page-market" class="nav-page"
         style="flex-direction:column; height:100%;">
      <div class="page-header">
        <h2>Market</h2>
        <button class="close-page-btn" onclick="closePage('market')">✕</button>
      </div>
      <div class="page-content">
        <p>Market data and trading tools - coming soon</p>
      </div>
    </div>`,

};

// ─── Inject all pages into #navPagesContainer ─────────────────────────────────
function loadAllPages() {
  const container = document.getElementById('navPagesContainer');
  if (!container) {
    console.error('[pageLoader] #navPagesContainer not found.');
    return;
  }
  for (const [, html] of Object.entries(PAGE_HTML)) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) container.appendChild(tmp.firstChild);
  }
}

// Expose a resolved promise so app.js can await window.__pagesReady uniformly.
// Since injection is now synchronous, this resolves immediately.
window.__pagesReady = new Promise(resolve => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { loadAllPages(); resolve(); }, { once: true });
  } else {
    loadAllPages();
    resolve();
  }
});