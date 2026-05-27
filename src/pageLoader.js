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
        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-2); cursor:pointer;">
          <input type="checkbox" id="jabberDirectorOnly" checked
                 style="accent-color:var(--accent);"/>
          Director only
        </label>
        <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-2); cursor:pointer;">
          <input type="checkbox" id="jabberBroadcastOnly" checked
                 style="accent-color:var(--accent);"/>
          Broadcasts only
        </label>
        <span id="jabberSummary" class="asset-summary" style="white-space:nowrap;">0 pings</span>
      </div>

      <!-- Ping table -->
      <div class="asset-table-wrapper" style="padding:0; flex:1; overflow-y:auto;">
        <table id="jabberTable" class="asset-table ping-table" style="width:100%; table-layout:fixed;">
          <colgroup>
            <col style="width:140px;"/>
            <col style="width:120px;"/>
            <col style="width:110px;"/>
            <col style="width:90px;"/>
            <col style="width:130px;"/>
            <col style="width:90px;"/>
            <col style="width:110px;"/>
            <col style="width:80px;"/>
            <col style=""/>
          </colgroup>
          <thead>
            <tr>
              <th>EVE Time</th>
              <th>FC Name</th>
              <th>Formup</th>
              <th>PAP Type</th>
              <th>Doctrine</th>
              <th>Sig</th>
              <th>Pinged By</th>
              <th>Target</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colspan="9" class="loading-row">Loading message history&#x2026;</td>
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
        <h2>Market</h2>
        <button class="close-page-btn" onclick="closePage('market')">✕</button>
      </div>
      <div class="page-content">
        <p>Market data and trading tools - coming soon</p>
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
    const res  = await fetch('page-assets.html');
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
}

// Expose a promise so app.js can await window.__pagesReady uniformly.
// loadAllPages is now async (fetches page-assets.html), so we await it here.
window.__pagesReady = new Promise(resolve => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { loadAllPages().then(resolve); }, { once: true });
  } else {
    loadAllPages().then(resolve);
  }
});