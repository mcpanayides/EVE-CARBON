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
            Click a card's ◇ to set it as your default character (◆) — it's
            auto-selected on startup. Only one character can be default at a
            time. Drag cards to reorder your character list.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('characters')">✕</button>
      </div>

      <div id="selectedCharacterSection"
           style="display:none; padding:20px; border-bottom:1px solid var(--border); background:var(--bg-card);">
        <div class="selected-character-card">
          <div style="display:flex; gap:16px; align-items:center;">
            <img id="selectedCharPortrait" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt=""
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
               style="flex:1; min-width:160px; max-width:380px; font-size:14px; padding:10px;"
               placeholder="Search characters..." />
        <button class="resync-all-btn" id="resyncAllNavBtn" title="Re-sync every character (serialised)">
          ⟳ RESYNC ALL
        </button>
        <button class="add-character-btn" id="addCharacterNavBtn" title="Add character">
          + ADD CHARACTER
        </button>
        <button class="delete-all-characters-btn" id="deleteAllCharactersBtn" title="Remove every character from this app">
          ✕ DELETE ALL CHARACTERS
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
        <!-- Re-renders the widgets in place (what Ctrl+R was being used for when a
             widget paints blank). _injectPageSpinners moves this into the same
             top-right group as the spinner and the ✕. -->
        <button id="dashboardRefreshBtn" class="page-header-btn" onclick="refreshDashboardPage()"
                title="Reload the dashboard widgets">
          <span class="material-symbols-outlined">refresh</span>
        </button>
        <button class="close-page-btn" onclick="closePage('dashboard')">&#x2715;</button>
      </div>
      <div class="page-content"
           style="display:flex; flex-direction:column; gap:10px; padding:16px; overflow-y:auto;">
        <div id="dashboardWelcomeBanner" class="dashboard-welcome-banner"></div>
        <!-- Always-on incursion banner. Not a grid widget — pinned here at the top
             and only shown (display toggled by renderAllianceIncursionAlert) when an
             incursion is active in the character's alliance space. -->
        <div id="allianceIncursionAlert" class="dashboard-incursion-banner" style="display:none;"></div>
        <div class="dashboard-grid-toolbar">
          <div class="dashboard-grid-addwrap">
            <button class="dashboard-add-widget-btn" onclick="toggleAddWidgetMenu(event)">
              <span class="material-symbols-outlined" style="font-size:18px;">add</span> Add Widget
            </button>
            <div id="dashboardAddWidgetMenu" class="dashboard-add-widget-menu" style="display:none;"></div>
          </div>
          <button class="dashboard-reset-layout-btn" onclick="resetDashboardLayout()"
                  title="Restore the default widget layout">Reset layout</button>
        </div>
        <!-- Widgets are injected by dashboard.js → initDashboardGrid() (Gridstack). -->
        <div id="dashboardGrid" class="grid-stack"></div>
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
          <!-- Icon glyphs are set per-tab via CSS (.industry-sub-icon::before in industry-blueprints.css) -->
          <button class="industry-sub-btn active" data-industry-tab="blueprints">
            <span class="industry-sub-icon material-symbols-outlined"></span>My Blueprints
          </button>
          <button class="industry-sub-btn" data-industry-tab="search">
            <span class="industry-sub-icon material-symbols-outlined"></span>BP Search
          </button>
          <button class="industry-sub-btn" data-industry-tab="active-jobs">
            <span class="industry-sub-icon material-symbols-outlined"></span>Active Jobs
          </button>
          <button class="industry-sub-btn" data-industry-tab="salvage">
            <span class="industry-sub-icon material-symbols-outlined"></span>Salvage Calc
          </button>
          <button class="industry-sub-btn" data-industry-tab="orehold">
            <span class="industry-sub-icon material-symbols-outlined"></span>Orehold Minerals Calc
          </button>
          <button class="industry-sub-btn" data-industry-tab="mining">
            <span class="industry-sub-icon material-symbols-outlined"></span>Mining Ledger
          </button>
          <button class="industry-sub-btn" data-industry-tab="cost-index">
            <span class="industry-sub-icon material-symbols-outlined"></span>Cost Index
          </button>
          <button class="industry-sub-btn" data-industry-tab="appraisal">
            <span class="industry-sub-icon material-symbols-outlined"></span>Appraisal
          </button>
          <button class="industry-sub-btn" data-industry-tab="shopping-lists">
            <span class="industry-sub-icon material-symbols-outlined"></span>Shopping Lists
          </button>
          <button class="industry-sub-btn" data-industry-tab="station-checkout">
            <span class="industry-sub-icon material-symbols-outlined"></span>Station Checkout
          </button>
          <button class="industry-sub-btn" data-industry-tab="reactions">
            <span class="industry-sub-icon material-symbols-outlined"></span>Reactions Profit
          </button>
          <button class="industry-sub-btn" data-industry-tab="ore">
            <span class="industry-sub-icon material-symbols-outlined"></span>Ore Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="ice">
            <span class="industry-sub-icon material-symbols-outlined"></span>Ice Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="gas">
            <span class="industry-sub-icon material-symbols-outlined"></span>Gas Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="moon-calc">
            <span class="industry-sub-icon material-symbols-outlined"></span>Moon Calculator
          </button>
          <button class="industry-sub-btn" data-industry-tab="moon">
            <span class="industry-sub-icon material-symbols-outlined"></span>Moon Scanning
          </button>
        </div>
        <div id="industryTabContent" class="industry-content">
          <!-- Populated by navigateToPage('industry') → navigateIndustryTab('blueprints') -->
        </div>
      </div>
    </div>`,

  // ── Finances ────────────────────────────────────────────────────────────────
  // Left TOOLS rail like the Industry/Skills pages. navigateFinancesTab() (in
  // src/func/finances.js) renders each tool into #financesTabContent: Wallets,
  // Contracts (contracts.js), LP Store (lpstore.js) and Trading (trading.js).
  wallets: `
    <div id="page-wallets" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Finances</h2>
          <div class="page-description">
            Wallets, contracts, LP store optimiser and trading tools.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('wallets')">✕</button>
      </div>
      <div class="industry-layout">
        <div class="industry-subnav">
          <div class="industry-subnav-label">TOOLS</div>
          <button class="finances-sub-btn industry-sub-btn active" data-finances-tab="wallets">
            <span class="industry-sub-icon material-symbols-outlined"></span>Wallets
          </button>
          <button class="finances-sub-btn industry-sub-btn" data-finances-tab="contracts">
            <span class="industry-sub-icon material-symbols-outlined"></span>Contracts
          </button>
          <button class="finances-sub-btn industry-sub-btn" data-finances-tab="lpstore">
            <span class="industry-sub-icon material-symbols-outlined"></span>LP Store
          </button>
          <button class="finances-sub-btn industry-sub-btn" data-finances-tab="trading">
            <span class="industry-sub-icon material-symbols-outlined"></span>Trading
          </button>
        </div>
        <div id="financesTabContent" class="industry-content"></div>
      </div>
    </div>`,

  // ── Faction Warfare ───────────────────────────────────────────────────────────
  // Left TOOLS rail like Industry/Finances. navigateFwTab() (src/func/faction-warfare.js)
  // renders each view into #fwTabContent. Most data is public ESI (fw/stats,
  // fw/systems, leaderboards); My Militia needs esi-characters.read_fw_stats.v1.
  fw: `
    <div id="page-fw" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Faction Warfare</h2>
          <div class="page-description">
            Warzone control, militia stats, plex/system status, leaderboards and LP tiers.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('fw')">✕</button>
      </div>
      <div class="industry-layout">
        <div class="industry-subnav">
          <div class="industry-subnav-label">FACTION WAR</div>
          <button class="fw-sub-btn industry-sub-btn active" data-fw-tab="overview">
            <span class="industry-sub-icon material-symbols-outlined"></span>Warzone Control
          </button>
          <button class="fw-sub-btn industry-sub-btn" data-fw-tab="systems">
            <span class="industry-sub-icon material-symbols-outlined"></span>Systems &amp; Plexes
          </button>
          <button class="fw-sub-btn industry-sub-btn" data-fw-tab="leaderboards">
            <span class="industry-sub-icon material-symbols-outlined"></span>Leaderboards
          </button>
          <button class="fw-sub-btn industry-sub-btn" data-fw-tab="militia">
            <span class="industry-sub-icon material-symbols-outlined"></span>My Militia
          </button>
          <button class="fw-sub-btn industry-sub-btn" data-fw-tab="lp">
            <span class="industry-sub-icon material-symbols-outlined"></span>LP &amp; Tiers
          </button>
        </div>
        <div id="fwTabContent" class="industry-content"></div>
      </div>
    </div>`,

  // ── Fleet Commander ─────────────────────────────────────────────────────────
  // Mirrors the Industry page: a left TOOLS sub-nav drives navigateFcTab() and
  // renders into #fcTabContent. Add new FC tools by adding a .fc-sub-btn here
  // and a branch in navigateFcTab() (src/func/fc.js).
  fc: `
    <div id="page-fc" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Fleet Commander</h2>
          <div class="page-description">Live fleet tools for skirmish &amp; fleet commanders.</div>
        </div>
        <button class="close-page-btn" onclick="closePage('fc')">✕</button>
      </div>
      <div class="industry-layout">
        <div class="industry-subnav">
          <div class="industry-subnav-label">TOOLS</div>
          <button class="industry-sub-btn fc-sub-btn active" data-fc-tab="composition">
            <span class="industry-sub-icon material-symbols-outlined">groups</span>Fleet Tracker
          </button>
          <button class="industry-sub-btn fc-sub-btn" data-fc-tab="fitting">
            <span class="industry-sub-icon material-symbols-outlined">build</span>Fitting Simulator
          </button>
          <button class="industry-sub-btn fc-sub-btn" data-fc-tab="intel"
                  title="Early warning from in-game intel channels — hostiles closing on the fleet">
            <span class="industry-sub-icon material-symbols-outlined">radar</span>Early Warning
          </button>
          <button class="industry-sub-btn fc-sub-btn" data-fc-tab="fleetfight"
                  title="Give CCP advance notice of a large fleet fight so they can reinforce the node">
            <span class="industry-sub-icon material-symbols-outlined">campaign</span>Fleet Fight Notify
          </button>
        </div>
        <div id="fcTabContent" class="industry-content">
          <!-- Populated by navigateToPage('fc') → initFcPage() → navigateFcTab('composition') -->
        </div>
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
      <div class="industry-layout">
        <div class="industry-subnav">
          <div class="industry-subnav-label">TOOLS</div>
          <button class="pi-sub-btn industry-sub-btn active" data-pi-tab="colonies">
            <span class="industry-sub-icon material-symbols-outlined"></span>Colonies
          </button>
          <button class="pi-sub-btn industry-sub-btn" data-pi-tab="planet-size">
            <span class="industry-sub-icon material-symbols-outlined"></span>Planet Size Mapper
          </button>
        </div>
        <div id="piTabContent" class="industry-content">
          <!-- Populated by navigateToPage('pi') → initPiPage() → navigatePiTab('colonies') -->
        </div>
      </div>
    </div>`,

  // ── Forums ──────────────────────────────────────────────────────────────────
  forums: `
    <div id="page-forums" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Forums</h2>
          <div class="page-description">Your alliance forum, signed in via your saved session — no password stored.</div>
        </div>
        <button class="close-page-btn" onclick="closePage('forums')">&#x2715;</button>
      </div>
      <div class="forum-toolbar">
        <button class="forum-tb-btn" id="forumBack"    title="Back"        onclick="forumNav('back')"><span class="material-symbols-outlined">arrow_back</span></button>
        <button class="forum-tb-btn" id="forumForward" title="Forward"     onclick="forumNav('forward')"><span class="material-symbols-outlined">arrow_forward</span></button>
        <button class="forum-tb-btn" id="forumReload"  title="Reload"      onclick="forumNav('reload')"><span class="material-symbols-outlined">refresh</span></button>
        <button class="forum-tb-btn" id="forumHome"    title="Forum home"  onclick="forumNav('home')"><span class="material-symbols-outlined">home</span></button>
        <span class="forum-tb-title" id="forumTitle">Forum</span>
        <span class="forum-tb-spacer"></span>
        <span class="forum-status-dot" id="forumStatusDot" title="Session status"></span>
        <span class="forum-status-label" id="forumStatusLabel">checking…</span>
        <button class="forum-tb-btn" id="forumLoginBtn"  title="Log in to the forum"        onclick="forumDoLogin()"><span class="material-symbols-outlined">login</span></button>
        <button class="forum-tb-btn" id="forumLogoutBtn" title="Log out / clear session"    onclick="forumDoLogout()"><span class="material-symbols-outlined">logout</span></button>
        <button class="forum-tb-btn" id="forumExternalBtn" title="Open in external browser" onclick="forumNav('external')"><span class="material-symbols-outlined">open_in_new</span></button>
      </div>
      <div class="forum-viewport" id="forumViewport">
        <webview id="forumWebview" partition="persist:forum" allowpopups style="display:none;"></webview>
        <div class="forum-loading" id="forumLoading" style="display:none;"><div class="forum-spinner"></div></div>
        <div class="forum-empty" id="forumEmpty">
          <span class="material-symbols-outlined forum-empty-icon">forum</span>
          <div class="forum-empty-title">No forum configured yet</div>
          <div class="forum-empty-sub">Add your forum URL in <strong>Settings &rarr; Forums</strong>, then click <strong>Log in</strong> once — your session is saved for next time.</div>
          <button class="forum-empty-btn" onclick="document.getElementById('openSettingsBtn')?.click(); setTimeout(()=>document.querySelector('[data-settings-tab=forums]')?.click(), 140);">Open Forum Settings</button>
        </div>
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

      <!-- Rail + panes. Broadcasts (the ping feed) is a permanent first entry:
           it is not a chat room, it is the bot feed this page was built for, and
           it stays reachable however many rooms get added. -->
      <div class="jabber-layout">
        <div class="jabber-rail">
          <div class="jabber-rail-label">Rooms</div>
          <button class="jabber-room-btn active" data-room="__pings__">
            <span class="material-symbols-outlined jabber-room-icon">campaign</span>
            <span class="jabber-room-name">Broadcasts</span>
          </button>
          <div id="jabberRoomList"></div>
          <button id="jabberFindRoomsBtn" class="jabber-add-room-btn">
            <span class="material-symbols-outlined">travel_explore</span> Find rooms
          </button>
          <button id="jabberAddRoomBtn" class="jabber-add-room-btn">
            <span class="material-symbols-outlined">add</span> Add by address
          </button>
          <div id="jabberRoomHint" class="jabber-rail-hint"></div>
        </div>

        <div class="jabber-panes">
        <div id="jabberPingsPane" class="jabber-pane">

      <!-- Status + controls bar -->
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;
                  padding:10px 16px; border-bottom:1px solid var(--border);
                  background:var(--bg-card); flex-shrink:0;">
        <span id="jabberStatus" class="asset-summary">Connecting to Jabber...</span>
        <span style="flex:1;"></span>
        <!-- What the feed shows. Structure-alert bots post continuously; mixed in
             with fleet broadcasts they bury the thing you opened this page for. -->
        <div class="jabber-feed-filter" id="jabberFeedFilter">
          <button class="jabber-feed-btn active" data-feed="broadcast" title="Fleet broadcasts only">Broadcasts</button>
          <button class="jabber-feed-btn" data-feed="alert" title="Structure and intel alerts">Alerts</button>
          <button class="jabber-feed-btn" data-feed="all" title="Everything received">All</button>
        </div>
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
                      box-shadow:0 4px 16px var(--glass-shadow);">
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
        </div><!-- /jabberPingsPane -->

        <!-- Chat room pane: history above, composer below. One pane reused for
             every room; switching rooms repaints it rather than building one
             pane per room and leaking them. -->
        <div id="jabberRoomPane" class="jabber-pane" style="display:none;">
          <div class="jabber-room-head">
            <span id="jabberRoomTitle" class="jabber-room-title">—</span>
            <span id="jabberRoomJid" class="jabber-room-jid"></span>
            <span style="flex:1;"></span>
            <button id="jabberLoadOlderBtn" class="jabber-cols-btn"
                    title="Fetch older messages from the server archive">Load older</button>
            <button id="jabberLeaveRoomBtn" class="jabber-cols-btn" title="Remove this room from your list">Leave</button>
          </div>
          <!-- Room subject: the MOTD banner every alliance room uses for standings,
               links and "currently offline". Pushed on join and on every change. -->
          <div id="jabberRoomSubject" class="jabber-room-subject" style="display:none;"></div>

          <div class="jabber-room-main">
            <div id="jabberRoomLog" class="jabber-room-log">
              <div class="jabber-room-empty">Select a room.</div>
            </div>
            <aside class="jabber-room-roster">
              <div id="jabberRosterCount" class="jabber-roster-count">0 people in room</div>
              <div id="jabberRosterList" class="jabber-roster-list"></div>
            </aside>
          </div>

          <div class="jabber-room-toolbar">
            <button type="button" class="jabber-fmt-btn" data-fmt="b" title="Bold"><b>B</b></button>
            <button type="button" class="jabber-fmt-btn" data-fmt="i" title="Italic"><i>I</i></button>
            <button type="button" class="jabber-fmt-btn" data-fmt="u" title="Underline"><u>U</u></button>
            <span class="jabber-toolbar-sep"></span>
            <button type="button" class="jabber-fmt-btn" id="jabberEmojiBtn" title="Insert emoji">
              <span class="material-symbols-outlined">mood</span>
            </button>
            <button type="button" class="jabber-fmt-btn" id="jabberLinkBtn" title="Insert a link">
              <span class="material-symbols-outlined">link</span>
            </button>
            <div id="jabberEmojiPicker" class="jabber-emoji-picker" style="display:none;"></div>
          </div>

          <form id="jabberRoomComposer" class="jabber-room-composer" autocomplete="off">
            <input id="jabberRoomInput" class="jabber-room-input" type="text"
                   placeholder="Message the room…" maxlength="1000" />
            <button id="jabberRoomSend" class="jabber-room-send" type="submit">Send</button>
          </form>
        </div>
        </div><!-- /jabber-panes -->
      </div><!-- /jabber-layout -->
    </div>`,

  // ── Calendar ──────────────────────────────────────────────────────────────────
  calendar: `
    <div id="page-calendar" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Calendar</h2>
          <div class="page-description">
            Alliance &amp; imported events — forum calendar plus any iCal feeds. Times shown in EVE (UTC) and local.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('calendar')">✕</button>
      </div>
      <div id="calendarBody"></div>
    </div>`,

  // ── Skills ──────────────────────────────────────────────────────────────────
  // Multi-character skill planner. Mirrors the Industry page's TOOLS sub-nav so
  // more skill tools (remap optimiser, fit requirements) can slot in later.
  // Behaviour lives in src/func/skills.js (initSkillsPage).
  skills: `
    <div id="page-skills" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Skills</h2>
          <div class="page-description">
            Build skill plans once and cost them against every character you own.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('skills')">✕</button>
      </div>
      <div class="industry-layout">
        <div class="industry-subnav">
          <div class="industry-subnav-label">TOOLS</div>
          <button class="skills-sub-btn industry-sub-btn active" data-skills-tab="planner">
            <span class="industry-sub-icon material-symbols-outlined"></span>Planner
          </button>
          <button class="skills-sub-btn industry-sub-btn" data-skills-tab="plans">
            <span class="industry-sub-icon material-symbols-outlined"></span>My Plans
          </button>
          <button class="skills-sub-btn industry-sub-btn" data-skills-tab="queues">
            <span class="industry-sub-icon material-symbols-outlined"></span>Active Queues
          </button>
        </div>
        <div id="skillsTabContent" class="industry-content"></div>
      </div>
    </div>`,

  // ── Killboard ───────────────────────────────────────────────────────────────
  // zKillboard-backed kills/losses feed + all-time PvP stats. No ESI scope —
  // see src/func/killboard.js (initKillboardPage).
  killboard: `
    <div id="page-killboard" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>Killboard</h2>
          <div class="page-description">
            Recent kills and losses with all-time PvP stats, from zKillboard.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('killboard')">✕</button>
      </div>

      <div class="kb-toolbar">
        <select id="kbCharSelect" class="kb-char-select" title="Whose killboard to show"></select>
        <div class="kb-filters">
          <button class="kb-filter active" data-kb-filter="all">All</button>
          <button class="kb-filter" data-kb-filter="kills">Kills</button>
          <button class="kb-filter" data-kb-filter="losses">Losses</button>
          <button class="kb-filter" data-kb-filter="solo">Solo</button>
        </div>
        <button class="kb-btn" id="kbRefreshBtn">Refresh</button>
        <button class="kb-btn" id="kbOpenZkillBtn" title="Open this character on zKillboard">zKillboard ↗</button>
      </div>

      <div class="kb-stats" id="kbStats"></div>

      <div class="kb-feed" id="kbFeed">
        <div class="kb-empty">Loading killboard…</div>
      </div>
    </div>`,

  // ── EVE Mail ────────────────────────────────────────────────────────────────
  // Three panes: labels/folders │ message list │ reading pane. All behaviour is
  // in src/func/mail.js (initMailPage). Mail is live-fetched from ESI and never
  // stored locally, so there is no cache to invalidate here.
  mail: `
    <div id="page-mail" class="nav-page"
         style="flex-direction:column; height:100%; overflow:hidden;">
      <div class="page-header">
        <div>
          <h2>EVE Mail</h2>
          <div class="page-description">
            Read, reply to and send in-game mail. Fetched live from ESI — nothing is stored on disk.
          </div>
        </div>
        <button class="close-page-btn" onclick="closePage('mail')">✕</button>
      </div>

      <div class="mail-tabs">
        <button class="mail-tab active" data-mailtab="mail">Mail</button>
        <button class="mail-tab" data-mailtab="notifications">Notifications</button>
      </div>

      <div class="mail-toolbar">
        <select id="mailCharSelect" class="mail-char-select" title="Which character to read"></select>
        <button class="mail-act-btn primary" id="mailComposeBtn">Compose</button>
        <button class="mail-act-btn" id="mailRefreshBtn">Refresh</button>
        <span class="mail-status" id="mailStatus"></span>
      </div>

      <!-- Tab: Mail -->
      <div class="mail-layout" id="mailTabMail">
        <div class="mail-labels" id="mailLabels"></div>
        <div class="mail-list" id="mailList"></div>
        <div class="mail-reader" id="mailReader">
          <div class="mail-empty">Select a mail to read.</div>
        </div>
      </div>

      <!-- Tab: Notifications (read-only — ESI exposes no write route) -->
      <div class="mail-layout notif-layout" id="mailTabNotifications" style="display:none;">
        <div class="mail-labels notif-filters" id="notifFilters"></div>
        <div class="mail-list" id="notifList"></div>
        <div class="mail-reader" id="notifReader">
          <div class="mail-empty">Select a notification to read.</div>
        </div>
      </div>

      <!-- Composer -->
      <div class="modal-backdrop mail-compose-backdrop" id="mailComposeBackdrop">
        <div class="mail-compose">
          <div class="mail-compose-head">New EVE Mail</div>
          <!-- Which mailbox this is sent FROM. A reply preselects the character
               that received the mail; any character can be picked instead. -->
          <div class="mail-compose-row">
            <label class="mail-meta-label" for="mailComposeFrom">From</label>
            <select id="mailComposeFrom" class="mail-input mail-from-select"
                    title="Which character sends this mail"></select>
          </div>
          <div class="mail-compose-row">
            <input type="text" id="mailComposeSearch" class="mail-input"
                   placeholder="Recipient — character, corporation, alliance or mailing list"/>
            <button class="mail-act-btn" id="mailComposeAddBtn">Add</button>
          </div>
          <div class="mail-chips" id="mailComposeChips"></div>
          <input type="text" id="mailComposeSubject" class="mail-input" placeholder="Subject"/>
          <textarea id="mailComposeBody" class="mail-textarea" rows="12"
                    placeholder="Write your mail…"></textarea>
          <div class="mail-compose-actions">
            <button class="mail-act-btn" id="mailComposeCancelBtn">Cancel</button>
            <button class="mail-act-btn primary" id="mailComposeSendBtn">Send</button>
          </div>
        </div>
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
    // Add the per-page loading spinner beside each ✕ now that all pages are in DOM.
    if (typeof _injectPageSpinners === 'function') _injectPageSpinners();
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