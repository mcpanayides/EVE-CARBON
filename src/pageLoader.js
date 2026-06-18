// ─── pageLoader.js ────────────────────────────────────────────────────────────
// Injects page HTML into #navPagesContainer.
// Most pages use inline template literals in PAGE_HTML below.
// Exception: page-assets.html is fetched at runtime and is the single
//            source of truth for the assets page — edit that file directly.
//
// To add a new page:
//   1. Add its HTML as a new template literal in PAGE_HTML below, OR
//   2. Create a standalone .html file and fetch it in loadAllPages().

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
              <div id="selectedCharLocation"
                   style="font-size:11px; color:var(--text-2); font-family:var(--mono); margin-top:4px;"></div>
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
        <div id="allianceIncursionAlert" style="display:none;"></div>
        <div id="dashboardContent" class="dashboard-dnd-grid">
          <div class="dashboard-col" id="dashboardColLeft">
            <div class="dashboard-panel dnd-panel" id="dashboardSummaryPanel" draggable="true">
              <div class="dashboard-panel-title dnd-handle">&#x2B21; NET WORTH &amp; WEALTH GROWTH <span class="dnd-grip">⠿</span></div>
              <div id="dashboardNetworthSummary"></div>
            </div>
          </div>
          <div class="dashboard-col" id="dashboardColRight">
            <div class="dashboard-panel dnd-panel" id="dashboardActiveJobsPanel" draggable="true">
              <div class="dashboard-panel-title dnd-handle">&#x25B6; ACTIVE INDUSTRY JOBS <span class="dnd-grip">⠿</span></div>
              <div id="dashboardActiveJobsTable">
                <div style="padding:16px 0;text-align:center;color:var(--text-3);font-family:var(--mono);font-size:11px;">Loading…</div>
              </div>
            </div>
            <div class="dashboard-panel dnd-panel" id="dashboardPIPanel" draggable="true">
              <div id="dashboardPIWidget">
                <div style="padding:16px 0;text-align:center;color:var(--text-3);font-family:var(--mono);font-size:11px;">Loading…</div>
              </div>
            </div>
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
          <button class="industry-sub-btn" data-industry-tab="salvage">
            <span class="industry-sub-icon">⚙</span>Salvage Calc
          </button>
          <button class="industry-sub-btn" data-industry-tab="cost-index">
            <span class="industry-sub-icon">◎</span>Cost Index
          </button>
          <button class="industry-sub-btn" data-industry-tab="shopping-lists">
            <span class="industry-sub-icon">⬡</span>Shopping Lists
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
          <button class="industry-sub-btn" data-industry-tab="moon-calc">
            <span class="industry-sub-icon">⬡</span>Moon Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="moon">
            <span class="industry-sub-icon">◎</span>Moon Scanning
          </button>
          <button class="industry-sub-btn" data-industry-tab="planet-size">
            <span class="industry-sub-icon">🪐</span>Planet Size Mapper
          </button>
        </div>
        <div id="industryTabContent" class="industry-content">
          <!-- Populated by navigateToPage('industry') → navigateIndustryTab('blueprints') -->
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
        <!-- The net-worth tile + character cards are rendered into this grid by
             renderWallets(); the net-worth tile is a draggable 3×2 grid item. -->
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

  // ── Map — fetched at runtime (see loadAllPages below) ───────────────────────
  // page-map.html is the single source of truth for the map page.

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
    <style id="jabberColVisStyle"></style>
    <div id="page-jabber" class="nav-page"
         style="flex-direction:column; height:100%; min-width:0; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Jabber</h2>
          <div class="page-description">Live broadcast feed — newest pings on top.</div>
        </div>
        <button class="close-page-btn" onclick="closePage('jabber')">&#x2715;</button>
      </div>

      <!-- Status + controls bar -->
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;
                  padding:10px 16px; border-bottom:1px solid var(--border);
                  background:var(--bg-card); flex-shrink:0;">
        <span id="jabberStatus" class="asset-summary">Connecting to Jabber...</span>
        <span style="flex:1;"></span>
        <span id="jabberSummary" class="asset-summary" style="white-space:nowrap;">0 pings</span>
        <!-- Zoom controls -->
        <div style="display:flex; align-items:center; gap:3px;">
          <button id="jabberZoomOut" class="jabber-cols-btn" title="Zoom out" style="padding:2px 7px;">&#x2212;</button>
          <span id="jabberZoomLevel" style="font-family:var(--mono);font-size:9px;color:var(--text-3);min-width:22px;text-align:center;">11</span>
          <button id="jabberZoomIn"  class="jabber-cols-btn" title="Zoom in"  style="padding:2px 7px;">+</button>
        </div>
        <div style="position:relative;">
          <button id="jabberColsBtn" class="jabber-cols-btn">Columns &#x25BE;</button>
          <div id="jabberColsDropdown"
               style="display:none; position:absolute; top:calc(100% + 4px); right:0; z-index:200;
                      background:var(--bg-card); border:1px solid var(--border);
                      border-radius:var(--radius); padding:8px 10px; min-width:130px;
                      box-shadow:0 4px 16px rgba(0,0,0,0.5);">
          </div>
        </div>
      </div>

      <!-- Ping table -->
      <div class="asset-table-wrapper" style="padding:0; flex:1; overflow-y:auto; overflow-x:auto;">
        <table id="jabberTable" class="asset-table ping-table" style="width:100%; table-layout:fixed; min-width:600px;">
          <colgroup>
            <col id="jcol-0" style="width:160px"/><!-- EVE Time -->
            <col id="jcol-1" style="width:100px"/><!-- FC Name -->
            <col id="jcol-2" style="width:120px"/><!-- Formup -->
            <col id="jcol-3" style="width:90px"/> <!-- PAP Type -->
            <col id="jcol-4" style="width:110px"/><!-- Doctrine -->
            <col id="jcol-5" style="width:60px"/> <!-- SIG -->
            <col id="jcol-6" style="width:110px"/><!-- Comms -->
            <col id="jcol-7" style="width:90px"/> <!-- Pinged By -->
            <col id="jcol-8" style="width:70px"/> <!-- Target -->
            <col id="jcol-9" style="width:280px"/><!-- Message -->
            <col id="jcol-10" style="width:62px"/><!-- View -->
          </colgroup>
          <thead>
            <tr>
              <th style="position:relative;"><span class="jabber-th-text">EVE Time</span></th>
              <th style="position:relative;"><span class="jabber-th-text">FC Name</span></th>
              <th style="position:relative;"><span class="jabber-th-text">Formup</span></th>
              <th style="position:relative;"><span class="jabber-th-text">PAP Type</span></th>
              <th style="position:relative;"><span class="jabber-th-text">Doctrine</span></th>
              <th style="position:relative;"><span class="jabber-th-text">SIG</span></th>
              <th style="position:relative;"><span class="jabber-th-text">Comms</span></th>
              <th style="position:relative;"><span class="jabber-th-text">Pinged By</span></th>
              <th style="position:relative;"><span class="jabber-th-text">Target</span></th>
              <th style="position:relative;"><span class="jabber-th-text">Message</span></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colspan="11" class="loading-row">Loading message history&#x2026;</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`,

  // ── Market ──────────────────────────────────────────────────────────────────
  market: `
    <div id="page-market" class="nav-page"
         style="flex-direction:column; height:100%;">
      <div class="page-header">
        <div>
          <h2>Market</h2>
          <div class="page-description">
            Active sell orders across all your characters, compared live to Jita 4-4.
            Green = priced at/above Jita, red = below.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('market')">✕</button>
      </div>
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;
                  padding:12px 16px; border-bottom:1px solid var(--border);
                  background:var(--bg-card); flex-shrink:0;">
        <span id="marketSummary" class="asset-summary" style="margin-right:auto;">Loading…</span>
        <button class="icon-btn" onclick="renderMarket()" title="Refresh from ESI"
                style="padding:7px 14px; font-size:12px;">⟳ REFRESH</button>
      </div>
      <div style="flex:1; overflow:auto; min-height:0;">
        <table class="asset-table" style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead>
            <tr>
              <th style="width:44px;"></th>
              <th class="th-item">Item</th>
              <th>Location</th>
              <th class="th-right">Qty</th>
              <th class="th-right">Your Price</th>
              <th class="th-right">Jita 4-4</th>
              <th class="th-right">vs Jita</th>
            </tr>
          </thead>
          <tbody id="marketOrdersBody">
            <tr><td colspan="7" class="loading-row">Loading market orders…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`,

};

// ─── Inject all pages into #navPagesContainer ─────────────────────────────────
// Injects all PAGE_HTML entries first (synchronous), then fetches
// page-assets.html and injects it after — keeping load order intact while
// making page-assets.html the single source of truth for the assets page.
async function loadAllPages() {
  const container = document.getElementById('navPagesContainer');
  if (!container) {
    console.error('[pageLoader] #navPagesContainer not found.');
    return;
  }

  // 1. Inject all inline page templates (characters, dashboard, industry, etc.)
  for (const [, html] of Object.entries(PAGE_HTML)) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) container.appendChild(tmp.firstChild);
  }

  // 2. Fetch and inject page-assets.html — single source of truth for the assets page.
  //    Falls back to a minimal placeholder if the file cannot be loaded so the
  //    app still starts correctly in unexpected environments.
  try {
    const res  = await fetch('./html/page-assets.html');
    const html = await res.text();
    const tmp  = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) container.appendChild(tmp.firstChild);

    // Nodes are now in the live DOM — safe to initialise column resize/reorder.
    // The <script> in page-assets.html only defines initAssetCols(); it deliberately
    // does NOT auto-call it, because innerHTML injection runs the script before the
    // nodes reach the live document (getElementById returns null at that point).
    if (typeof window.initAssetCols === 'function') {
      window.initAssetCols();
    }
  } catch (e) {
    console.error('[pageLoader] Failed to load page-assets.html:', e);
    // Minimal fallback so #page-assets always exists in the DOM
    const fallback = document.createElement('div');
    fallback.id        = 'page-assets';
    fallback.className = 'nav-page';
    fallback.innerHTML = '<p style="padding:20px;color:var(--text-2);">Assets page failed to load.</p>';
    container.appendChild(fallback);
  }

  // 3. Fetch and inject page-map.html — single source of truth for the map page.
  try {
    const res  = await fetch('./html/page-map.html');
    const html = await res.text();
    const tmp  = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) container.appendChild(tmp.firstChild);
  } catch (e) {
    console.error('[pageLoader] Failed to load page-map.html:', e);
    const fallback = document.createElement('div');
    fallback.id        = 'page-map';
    fallback.className = 'nav-page';
    fallback.innerHTML = '<p style="padding:20px;color:var(--text-2);">Map page failed to load.</p>';
    container.appendChild(fallback);
  }
}

// Expose a promise so app.js can await window.__pagesReady uniformly.
// loadAllPages is now async (fetches page-assets.html), so we await it here.
window.__pagesReady = new Promise(resolve => {
  const init = () => loadAllPages().then(() => {
    // Wire jabber IPC listeners — must happen before app.js calls autoConnectJabber
    // so the 'jabber-status' and 'jabber-message' handlers are in place first.
    if (typeof bindJabberEvents === 'function') bindJabberEvents();
    // autoConnectJabber() is called by app.js after __pagesReady resolves —
    // do NOT call it here too or it fires twice on every startup.
    resolve();
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
});