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
let _piPlanetArtProm = null;
let _piCapacities    = {};   // charId -> piSlotCapacity() result
let _piJumpCache     = {};
let _piOriginSysId   = null;
let _piOriginSysName = '';
let _piOriginCharId  = null;   // whose client receives a 'set destination'
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
        Esi.url(`/universe/planets/${id}`)
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

// ─── Tools rail ───────────────────────────────────────────────────────────────
// Same left TOOLS rail as Industry / Finances / Faction Warfare — the markup in
// pageLoader.js reuses .industry-layout / .industry-subnav / .industry-content and
// tags the buttons .pi-sub-btn[data-pi-tab]. Colonies is the page's main view;
// everything after it is a PI tool.
let _piTab = 'colonies';

function initPiPage() {
  document.querySelectorAll('.pi-sub-btn').forEach(btn => {
    btn.onclick = () => { const t = btn.dataset.piTab; if (t) navigatePiTab(t); };
  });
  // Returned, so navigateToPage can show the header spinner until it settles.
  return navigatePiTab(_piTab || 'colonies');
}

function navigatePiTab(tab) {
  _piTab = tab;
  document.querySelectorAll('.pi-sub-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.piTab === tab));

  const host = document.getElementById('piTabContent');
  if (!host) return;

  if (tab === 'planet-size') return renderPlanetSizeMapper(host);
  if (tab === 'planner')     return renderPiPlanner(host);
  if (tab === 'capacity')    return renderPiCapacityTab(host);

  // Colonies. loadPlanetaryInteraction() renders into #piContainer, so recreate
  // that host on every entry — switching tools replaces the whole content area.
  host.innerHTML = '<div id="piContainer" style="height:100%; overflow-y:auto;"></div>';
  return loadPlanetaryInteraction();
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

    // Every character that loaded, INCLUDING the ones running nothing at all.
    // They used to be filtered out right here, which quietly made this page
    // unable to answer the question it is now asked most often: who has a free
    // slot. An alt with Interplanetary Consolidation V and no colonies is six
    // free planets, and it was the most invisible thing on the page.
    // Nothing downstream minds an empty colonies array -- every consumer
    // flatMaps or reduces over it -- but the empty state below has to count
    // colonies now rather than characters.
    _piAllCharData = allResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    await _piLoadCapacities();

    const totalCols = _piAllCharData.reduce((n, c) => n + (c.colonies || []).length, 0);
    if (totalCols === 0) {
      const sum  = piCapacitySummary();
      const room = sum.freeSlots
        ? ` You have ${sum.freeSlots} free planet slot${sum.freeSlots === 1 ? '' : 's'} across ` +
          `${sum.freeChars} character${sum.freeChars === 1 ? '' : 's'} — nothing is built on ` +
          `${sum.freeChars === 1 ? 'it' : 'them'} yet.`
        : '';
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" style="color:var(--text-3)">🪐</div>
          <div class="empty-title">No Colonies Found</div>
          <div class="empty-sub">No active planetary command centers found across your characters.${room}</div>
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
      // The same character the jumps are counted from is the one whose client
      // gets the waypoint — anything else would route the wrong pilot.
      _piOriginCharId  = refId;
    }

    if (_piOriginSysId) {
      await prefetchJumpDistances(_piOriginSysId, _piAllCharData);
    }

    renderPIShell(container);
    // Fire-and-forget: the shortfall analysis needs the schematic graph, and the
    // colony grid should not wait on an IPC round trip to appear.
    renderPiShortfalls().catch(e => console.warn('[PI] shortfall analysis failed:', e?.message || e));

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
  // `||`, not `??`: a stale or half-synced info row stores an EMPTY name rather
  // than a null, and `??` happily passes '' straight through — which rendered a
  // nameless colony card and a nameless capacity chip.
  const charName = data?.info?.character_name
    || account.characterName || account.character_name
    || account.name || `Character ${charId}`;

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
        // /route/ moved from GET (bare array response) to POST (JSON body,
        // {route:[...]} response) — see developers.eveonline.com/blog/
        // route-to-the-future-upgrading-the-route-route. X-User-Agent and
        // X-Compatibility-Date are added automatically by the fetch wrapper
        // in src/utils.js.
        const res = await fetch(
          Esi.url(`/route/${originSysId}/${destId}`),
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        );
        _piJumpCache[key] = res.ok
          ? (await res.json()).route.length - 1
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
// Entering the PI page fires TWO renders: loadPlanetaryInteraction() paints
// immediately, then _autoSyncPIIfStale() finishes its ESI round-trip and calls
// loadPlanetaryInteraction() again. That second pass rebuilds this whole shell,
// so any filter the user picked in between used to be silently reset to "All"
// mid-interaction. Carry the current selections across the rebuild instead.
function renderPIShell(container) {
  const prevFilters = {
    piFilterChar:   document.getElementById('piFilterChar')?.value,
    piFilterType:   document.getElementById('piFilterType')?.value,
    piFilterSystem: document.getElementById('piFilterSystem')?.value,
    piFilterRange:  document.getElementById('piFilterRange')?.value,
  };

  const totalColonies = _piAllCharData.reduce((n, c) => n + c.colonies.length, 0);

  const allTypes = [...new Set(
    _piAllCharData.flatMap(c => c.colonies.map(col => (col.planet_type || '').toLowerCase()))
  )].filter(Boolean).sort();

  const allSystems = [...new Set(
    _piAllCharData.flatMap(c => c.colonies.map(col => col.solar_system_name || ''))
  )].filter(Boolean).sort();

  // Only characters who actually have colonies belong in the filter: selecting
  // one with none would just empty the grid. Their free slots are still counted
  // -- that is what the capacity row below the strip is for.
  const allChars   = _piAllCharData
    .filter(c => (c.colonies || []).length)
    .map(c => ({ id: c.charId, name: c.charName }));
  const capSummary = piCapacitySummary();

  // The range filter needs a reference system to measure jumps from. Without a
  // synced location for the reference character there is nothing to measure
  // against, so the control is disabled — say why rather than just going dead.
  const rangeDisabled = !_piOriginSysId ? 'disabled' : '';
  const rangeTitle    = _piOriginSysId
    ? `From ${escHtml(_piOriginSysName || 'current system')}`
    : 'Range';
  const rangeHint     = _piOriginSysId
    ? `Jumps from ${escHtml(_piOriginSysName || 'your current system')}`
    : 'Unavailable — sync a character to set a reference system';

  container.innerHTML = `
    <div class="pi-container">

      <div class="pi-header-row">
        <span class="pi-title">Planetary Networks</span>
        <span class="panel-count" id="piColonyCount">
          ${totalColonies} Colon${totalColonies !== 1 ? 'ies' : 'y'} &mdash; ${allChars.length} Character${allChars.length !== 1 ? 's' : ''}
        </span>
      </div>

      ${piStatusStripHtml(piTally(piAllColonies()), capSummary)}
      ${piCapacityRowHtml(capSummary)}
      <div id="piShortfallHost"></div>

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
          <span class="pi-filter-label" title="${rangeHint}">${rangeTitle}</span>
          <select class="pi-filter-select" id="piFilterRange" title="${rangeHint}" ${rangeDisabled}>
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
    const el = document.getElementById(id);
    if (!el) return;
    // Only restore a prior choice that still exists — a character or system can
    // disappear between syncs, and assigning a missing value silently blanks
    // the select instead of falling back to "All".
    const prev = prevFilters[id];
    if (prev && [...el.options].some(o => o.value === prev)) el.value = prev;
    el.addEventListener('change', applyPIFilters);
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

/**
 * Count colonies by state, for the status strip and the dashboard tile.
 *
 * ONE tally, two surfaces. The dashboard used to carry its own copy of this
 * categorisation with a comment promising it matched "the same logic as the PI
 * page" — a promise nothing enforced, on two blocks of code that had no reason
 * to stay in step. The states are the ones getColonyStatus() above already
 * defines, so the strip, the tile and each colony card all agree.
 *
 * `expiring` is a SUBSET of `extracting` (a colony running out in six hours is
 * still extracting), so the four numbers deliberately do not sum to the total.
 * It is the actionable one — the reason to open the page at all.
 *
 * @param {Array} colonies flat list of colony rows
 * @param {number} [now]   injected for tests
 */
function piTally(colonies, now = Date.now()) {
  const t = { total: 0, extracting: 0, expiring: 0, storageFull: 0, idle: 0 };
  for (const col of (colonies || [])) {
    if (!col) continue;
    t.total++;
    const expiresAt = col.extractor_expires_at;
    if (expiresAt && expiresAt > now) {
      t.extracting++;
      if ((expiresAt - now) <= 24 * 3_600_000) t.expiring++;
    } else if (_piStorageFull(col)) {
      t.storageFull++;
    } else {
      t.idle++;
    }
  }
  return t;
}

/**
 * Is any silo at or past 90%?
 *
 * Both row shapes, because the two callers get their colonies from different
 * places: this page from the live sync (`storage` as an array), the dashboard
 * from the character DB (`storage_json` as a string). The dashboard's old copy
 * of the tally parsed both and this page's did not — so the same colony could be
 * "storage full" on one screen and "idle" on the other, which is exactly the
 * kind of quiet disagreement one shared function exists to prevent.
 */
function _piStorageFull(col) {
  let arr = col.storage;
  if (!Array.isArray(arr)) {
    if (!col.storage_json) return false;
    try { arr = JSON.parse(col.storage_json); } catch (_) { return false; }
  }
  return Array.isArray(arr) && arr.some(s => s && s.fill_pct >= 90);
}

/** Every colony across every synced character, flattened. */
function piAllColonies() {
  return _piAllCharData.reduce((acc, c) => acc.concat(c.colonies || []), []);
}

// --- Slot capacity ---------------------------------------------------------
// A character can run 1 planet, +1 per level of Interplanetary Consolidation,
// so 1..6. Nothing else grants a slot: Command Center Upgrades (2505) sets the
// command centre TIER -- how much powergrid and CPU a colony gets -- not how
// many colonies you may have. Both IDs verified against the SDE rather than
// typed from memory; a name search there also matches two Skill Accelerator
// boosters that are not skills at all.
const PI_SLOT_SKILL_ID = 2495;
// Command Center Upgrades sets the command centre TIER, which is what decides
// whether a planet can physically hold a reactor line or only an extractor.
// Slots and capability are two different skills; see PiModel.PLANET_ROLES.
const PI_CCU_SKILL_ID  = 2505;
const PI_MAX_SLOTS     = 6;
// Past this many the row stops being scannable, and someone running fifty alts
// would get a wall of chips. The rest live one click away on the Capacity tab.
const PI_CAP_CHIPS_INLINE = 6;

/**
 * Free planet slots for one character.
 *
 * `skillLevels` is the character's WHOLE skill map, not just 2495, and that is
 * deliberate. An empty map is ambiguous on its own -- the character might have
 * nothing trained, or might simply never have been synced -- and those two must
 * not render the same. Every sync writes the full list, so "has any rows at
 * all" is the only available signal separating them. Reading a missing map as
 * level 0 would give a working four-colony character a capacity of 1 and show
 * them as "-3 free", which is worse than admitting we do not know.
 */
function piSlotCapacity(skillLevels, colonyCount, synced) {
  const used = Math.max(0, Number(colonyCount) || 0);
  // The batched read knows for certain whether a character has ever synced and
  // says so; the per-character read can only infer it from having any rows at
  // all. Prefer the certain answer when it is offered.
  const known = synced != null
    ? !!synced
    : (!!skillLevels && Object.keys(skillLevels).length > 0);
  if (!known) return { known: false, used, capacity: null, free: null, ic: null, ccu: null };

  const lvl = Math.max(0, Math.min(5, Number(skillLevels[PI_SLOT_SKILL_ID]) || 0));
  const ccu = Math.max(0, Math.min(5, Number(skillLevels[PI_CCU_SKILL_ID]) || 0));
  const capacity = Math.min(PI_MAX_SLOTS, 1 + lvl);
  // Clamped: a colony count above capacity means the skill read is older than
  // the colony read, and a negative "free" is never the right answer.
  return { known: true, used, capacity, free: Math.max(0, capacity - used), ic: lvl, ccu };
}

/**
 * Read every character's slot capacity and command-centre tier.
 *
 * One batched IPC for the whole account. This used to be a call per character
 * that pulled their entire skill list -- ~300 rows each -- purely so the row
 * count could distinguish "never synced" from "trained to zero". Correct, but
 * at fifty alts it is fifty round-trips and fifteen thousand rows every time
 * the page opens. `pi-capacities` answers all of it in one call with four
 * numbers per character.
 */
async function _piLoadCapacities() {
  _piCapacities = {};
  if (typeof window === 'undefined' || !window.eveAPI) return;
  const ids = _piAllCharData.map(c => c.charId);
  if (!ids.length) return;

  if (window.eveAPI.piCapacities) {
    const prof = await window.eveAPI.piCapacities(ids).catch(() => null);
    if (prof) {
      for (const c of _piAllCharData) {
        const p = prof[c.charId] ?? prof[String(c.charId)] ?? null;
        _piCapacities[c.charId] = piSlotCapacity(
          p ? { [PI_SLOT_SKILL_ID]: p.ic, [PI_CCU_SKILL_ID]: p.ccu } : null,
          (c.colonies || []).length,
          p ? p.synced : false
        );
      }
      return;
    }
  }

  // Fallback for a renderer running against a preload without the batched
  // channel. Same answers, the slow way.
  if (!window.eveAPI.getSkillLevels) return;
  await Promise.all(_piAllCharData.map(async (c) => {
    const lv = await window.eveAPI.getSkillLevels(c.charId).catch(() => null);
    _piCapacities[c.charId] = piSlotCapacity(lv, (c.colonies || []).length);
  }));
}

/**
 * Make sure the colony network is loaded without rendering the Colonies view.
 *
 * The Capacity and Planner tabs both need the network, and either can be the
 * first thing opened on the page — in which case _piAllCharData is still empty
 * and every total would silently read zero.
 */
async function _piEnsureNetwork() {
  if (typeof window === 'undefined' || !window.eveAPI) return;

  if (!_piAllCharData.length) {
    const accounts = await window.eveAPI.getAccounts().catch(() => []);
    if (!accounts || !accounts.length) return;
    const res = await Promise.allSettled(accounts.map(acc => loadCharacterColonies(acc)));
    _piAllCharData = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  }

  // Not an else. loadPlanetaryInteraction assigns _piAllCharData and only THEN
  // awaits the skill read, so there is a window where the characters are known
  // and their capacities are not. Returning early on a non-empty character list
  // rendered that window as "every character unknown" — which is what opening
  // the Capacity tab while Colonies was still settling actually did.
  if (_piAllCharData.length && !Object.keys(_piCapacities).length) {
    await _piLoadCapacities();
  }
}

/** Capacity across every character, plus the per-character rows behind it. */
function piCapacitySummary() {
  const rows = _piAllCharData.map(c => Object.assign(
    { charId: c.charId, charName: c.charName },
    _piCapacities[c.charId] || piSlotCapacity(null, (c.colonies || []).length)
  ));
  const known = rows.filter(r => r.known);
  return {
    rows,
    freeSlots: known.reduce((n, r) => n + r.free, 0),
    freeChars: known.filter(r => r.free > 0).length,
    unknown:   rows.length - known.length,
  };
}

/**
 * The free-capacity row: one chip per character with somewhere to put a colony,
 * widest opening first.
 *
 * Free slots are a property of a CHARACTER, not of a planet, so they are not
 * shaped like colony cards. An empty card per free slot would have put eighteen
 * placeholders among thirty-eight real colonies and turned the page mostly into
 * absence. Only characters with room get a chip, which makes the row itself the
 * answer to "who?" before anyone reads a number.
 */
function piCapacityRowHtml(sum) {
  const pips = (used, capacity) => Array.from({ length: capacity }, (_, i) =>
    `<span class="pi-pip${i < used ? ' is-used' : ''}"></span>`).join('');

  const open = sum.rows
    .filter(r => r.known && r.free > 0)
    .sort((a, b) => b.free - a.free || String(a.charName).localeCompare(String(b.charName)));

  const shown = open.slice(0, PI_CAP_CHIPS_INLINE);
  const chips = shown.map(r => `
    <span class="pi-cap-chip" title="${escHtml(r.charName)} — ${r.used} of ${r.capacity} planet slots used">
      <span class="pi-cap-name">${escHtml(r.charName)}</span>
      <span class="pi-cap-pips">${pips(r.used, r.capacity)}</span>
      <span class="pi-cap-free">${r.free}</span>
    </span>`).join('');

  // The overflow is a real number, not an ellipsis: someone with forty spare
  // slots needs to see forty, and the click takes them to where they are listed.
  const hidden = open.length - shown.length;
  const more = hidden > 0
    ? `<button class="pi-cap-more" onclick="navigatePiTab('capacity')" title="Open the Capacity tab">+${hidden} more character${hidden === 1 ? '' : 's'}</button>`
    : '';

  // Say the boring outcome out loud. An empty row is ambiguous: it reads as
  // "not loaded yet" exactly as easily as "nothing is free".
  const body = chips || `<span class="pi-cap-none">Every planet slot is in use.</span>`;

  const unknown = sum.unknown
    ? `<span class="pi-cap-unknown" title="Never synced, so their Interplanetary Consolidation level is unknown">${sum.unknown} not synced</span>`
    : '';

  return `
    <div class="pi-cap-row">
      <span class="pi-cap-label">FREE CAPACITY</span>
      ${body}
      ${more}
      ${unknown}
    </div>`;
}

/**
 * The status strip: a wide row of lamps above the filters.
 *
 * Deliberately at the top of the page and full width, because it answers the
 * question you opened Planetary Networks to ask — is anything wrong — before you
 * have touched a single filter. The filters below narrow the cards; this counts
 * everything you own, and says so.
 */
function piStatusStripHtml(tally, cap) {
  const lamp = (kind, n, label, title) => `
    <div class="pi-stat" title="${escHtml(title)}">
      <span class="sig-light sig-${kind}${n > 0 ? '' : ' is-off'}"></span>
      <span class="pi-stat-num">${n}</span>
      <span class="pi-stat-label">${label}</span>
    </div>`;

  // The lamps wrap as a group; the total keeps the right-hand end of the first
  // row. Wrapping them all together let the total drop onto a line of its own
  // the moment the window narrowed, which reads as a second, emptier strip.
  return `
    <div class="pi-status-strip">
      <div class="pi-stats">
        ${lamp('go',   tally.extracting,  'EXTRACTING',   'Colonies with a running extractor')}
        ${lamp('hold', tally.expiring,    'EXPIRING 24H', 'Extractors that run out within a day — these are the ones to go and reset')}
        ${lamp('hold', tally.storageFull, 'STORAGE FULL', 'A silo at 90% or more; production stalls when it fills')}
        ${lamp('stop', tally.idle,        'IDLE',         'No extractor running and nothing blocking — doing nothing at all')}
      </div>
      <div class="pi-stat-total">
        ${cap && cap.freeSlots
          ? `<span class="pi-cap-total" title="Planet slots your characters can still build on">${cap.freeSlots} slot${cap.freeSlots === 1 ? '' : 's'} free</span>`
          : ''}
        <span>${tally.total} colon${tally.total === 1 ? 'y' : 'ies'}</span>
      </div>
    </div>`;
}

// ─── Capacity tab: character colony availability ─────────────────────────────
//
// The inline chip row answers "who has room" for a handful of characters. This
// answers it for a hundred, and adds the half the chips cannot carry: what each
// character's command centre can actually HOLD. Slots and capability are two
// different skills, and only one of them is about how many planets you own.
let _piCapFilter   = '';
let _piCapFreeOnly = false;

/** Capacity rows joined with the role each character's command centre supports. */
function piCapacityRoleRows() {
  const sum = piCapacitySummary();
  return PiModel.assignRoles(PiModel.recommendRoles(sum.rows.map(r => ({
    charId: r.charId, charName: r.charName,
    ccu: r.known ? r.ccu : null, ic: r.known ? r.ic : null,
    free: r.free, used: r.used,
  }))));
}

async function renderPiCapacityTab(host) {
  if (!host) return;
  host.innerHTML = '<div class="loading-row">Reading colonies and skills…</div>';
  await _piEnsureNetwork();
  _piRenderCapacityTab(host);
}

function _piRenderCapacityTab(host) {
  const all = piCapacityRoleRows();
  if (!all.length) {
    host.innerHTML = `<div class="empty-state">
      <div class="empty-title">No Characters</div>
      <div class="empty-sub">Add a character to see what planetary capacity you have.</div>
    </div>`;
    return;
  }

  const q    = _piCapFilter.trim().toLowerCase();
  const rows = all.filter(r =>
    (!q || String(r.charName).toLowerCase().includes(q)) &&
    (!_piCapFreeOnly || (r.known && r.free > 0)));

  const known    = all.filter(r => r.known);
  const slots    = known.reduce((n, r) => n + (r.used + r.free), 0);
  const used     = known.reduce((n, r) => n + r.used, 0);
  const free     = known.reduce((n, r) => n + r.free, 0);
  const unusable = known.filter(r => !r.canRun.length).length;

  const pips = (u, cap) => Array.from({ length: cap }, (_, i) =>
    `<span class="pi-pip${i < u ? ' is-used' : ''}"></span>`).join('');

  const body = rows.map(r => {
    const cap = r.known ? r.used + r.free : 0;
    return `<tr class="pi-cap-tr${r.known && r.free > 0 ? ' has-room' : ''}">
      <td class="pi-cap-td-name">${escHtml(r.charName)}</td>
      <td class="pi-cap-td-slots">${
        r.known
          ? `<span class="pi-cap-pips">${pips(r.used, cap)}</span><span class="pi-cap-frac">${r.used}/${cap}</span>`
          : '<span class="pi-cap-unknown-cell">unknown</span>'}</td>
      <td class="pi-cap-td-free">${r.known ? (r.free || '<span class="pi-cap-zero">0</span>') : '—'}</td>
      <td class="pi-cap-td-cc">${r.known
          ? `${escHtml(r.tier)} <span class="pi-cap-lvl">CCU ${r.ccu}</span>`
          : '—'}</td>
      <td class="pi-cap-td-role">${
        r.note
          ? `<span class="pi-cap-note">${escHtml(r.note)}</span>`
          : r.suggested
            ? `<span class="pi-cap-role" title="This command centre can hold: ${escHtml((r.canRun || []).map(id => (PiModel.PLANET_ROLES.find(x => x.id === id) || {}).name).filter(Boolean).join(', '))}">${escHtml(r.suggestedName)}</span>`
            : `<span class="pi-cap-role-none" title="${escHtml(r.suggestedNote || '')}">—</span>`}</td>
    </tr>`;
  }).join('');

  // The archetypes, priced. This doubles as the explanation of why a character
  // with plenty of free slots may still be the wrong one to put a reactor on.
  const legend = PiModel.PLANET_ROLES.map(role => {
    const c   = PiModel.roleCost(role);
    const min = PiModel.minCcuFor(role);
    return `<div class="pi-role-card">
      <div class="pi-role-head">
        <span class="pi-role-name">${escHtml(role.name)}</span>
        <span class="pi-role-tiers">${escHtml(role.tiers)}</span>
      </div>
      <div class="pi-role-what">${escHtml(role.what)}</div>
      <div class="pi-role-cost">
        <span>${c.pg.toLocaleString()} PG · ${c.cpu.toLocaleString()} CPU</span>
        <span class="pi-role-min">needs CCU ${min == null ? '—' : min}</span>
      </div>
      ${role.planetTypes ? `<div class="pi-role-only">Only on ${role.planetTypes.join(' and ')} planets</div>` : ''}
    </div>`;
  }).join('');

  host.innerHTML = `
    <div class="fin-tab-fill fw-scroll">
      <div class="pi-header-row">
        <span class="pi-title">Character Colony Availability</span>
        <span class="panel-count">${used} of ${slots} slots used &mdash; ${free} free</span>
      </div>

      <div class="pi-cap-bar">
        <div class="pi-filter-item">
          <span class="pi-filter-label">Character</span>
          <input class="pi-filter-select" id="piCapFilter" type="text" placeholder="Filter by name…" value="${escHtml(_piCapFilter)}">
        </div>
        <div class="pi-filter-sep"></div>
        <label class="pi-cap-toggle">
          <input type="checkbox" id="piCapFreeOnly"${_piCapFreeOnly ? ' checked' : ''}>
          <span>Only characters with room</span>
        </label>
        ${unusable ? `<span class="pi-cap-warn" title="A Basic command centre cannot carry any working layout">
          ${unusable} character${unusable === 1 ? '' : 's'} at CCU 0 — train Command Center Upgrades I before using ${unusable === 1 ? 'them' : 'those'}</span>` : ''}
      </div>

      <table class="pi-cap-table">
        <thead><tr>
          <th>Character</th><th>Planet slots</th><th>Free</th>
          <th>Command centre</th><th>Suggested role</th>
        </tr></thead>
        <tbody>${body || `<tr><td colspan="5" class="pi-cap-empty">No characters match.</td></tr>`}</tbody>
      </table>

      <div class="pi-role-head-row">PLANET ROLES — WHAT A COMMAND CENTRE CAN HOLD</div>
      <div class="pi-role-intro">Suggestions above allocate strongest command centre first, to the
        shape a P4 chain actually has: one high-tech planet fed by about three reactor planets, with
        refining and extraction under them. Hover a role to see everything that character could hold
        instead. For an exact answer to a specific product, use the PI Planner.</div>
      <div class="pi-role-grid">${legend}</div>
      <div class="pi-role-foot">Powergrid and CPU read from the SDE. Link cost scales with
        distance between pins, so these are floors — a spread-out layout pays more, which is
        what the headroom of a higher command centre buys you.</div>
    </div>`;

  const f = document.getElementById('piCapFilter');
  if (f) f.oninput = () => { _piCapFilter = f.value; _piRenderCapacityTab(host); f2focus(); };
  const t = document.getElementById('piCapFreeOnly');
  if (t) t.onchange = () => { _piCapFreeOnly = t.checked; _piRenderCapacityTab(host); };

  // Re-rendering the table blows away focus and the caret mid-word otherwise.
  function f2focus() {
    const el = document.getElementById('piCapFilter');
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
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

// Hero art ships in assets/planets/, which build.extraResources copies to
// resources/ -- OUTSIDE the asar -- so the renderer cannot reach it with a path
// relative to index.html in a packaged build. Main resolves it instead (see the
// 'planet-art' handler) and hands back file:// URLs. Resolved once and cached:
// the art cannot change while the app is running, and openPIDetail is hot.
// Always resolves; a failure just yields {} and every planet falls back to CCP.
function piPlanetArt() {
  if (!_piPlanetArtProm) {
    _piPlanetArtProm = Promise.resolve(
      typeof window !== 'undefined' && window.eveAPI?.planetArt ? window.eveAPI.planetArt() : {}
    ).catch(() => ({}));
  }
  return _piPlanetArtProm;
}

async function openPIDetail(planetId, charId) {
  const charData = _piAllCharData.find(c => String(c.charId) === String(charId));
  const colony   = charData?.colonies.find(c => c.planet_id === planetId);
  if (!colony) return;

  const typeKey    = (colony.planet_type || '').toLowerCase().trim();
  const typeId     = PI_PLANET_TYPE_IDS[typeKey] || 2016;
  const iconUrl    = `https://images.evetech.net/types/${typeId}/icon?size=128`;
  // Prefer the art we ship. Failing that, CCP's icon endpoint: `render` DOES NOT
  // EXIST for planets — images.evetech.net/types/{id}/ answers ["icon"] for all
  // nine — so this once asked for a render, got a 400, and silently fell back to
  // the 64px icon stretched across a 700px header. That is why it looked soft.
  const art        = await piPlanetArt();
  const heroUrl    = art[typeKey] || `https://images.evetech.net/types/${typeId}/icon?size=1024`;
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
        <img class="pi-detail-img" src="${heroUrl}"
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

// ═══════════════════════════════════════════════════════════════════════════
// PI production model — shortfall analysis + the planner
//
// Both read src/shared/pi_model.js, so the Colonies banner and the Planner can
// never disagree about what a shortfall is or what it takes to fix one.
//
// THE HONESTY CONSTRAINT, stated once and enforced everywhere below: EVE does
// not publish per-planet resource richness. Not in the SDE, not in ESI. So this
// recommends planet TYPES in LOCATIONS and never claims a given planet is rich.
// Every planner output carries PiModel.SURVEY_CAVEAT for exactly that reason.
// ═══════════════════════════════════════════════════════════════════════════

let _piSchIdx  = null;    // indexed recipe graph, fetched once per session
let _piNames   = {};      // typeID → name
let _piSchemaMissing = false;

/** The recipe graph, or null on an SDE that predates the schematic tables. */
async function piSchematics() {
  if (_piSchIdx || _piSchemaMissing) return _piSchIdx;
  const raw = await window.eveAPI.piSchematics().catch(() => null);
  if (!raw || !raw.schematics?.length) { _piSchemaMissing = true; return null; }
  _piSchIdx = PiModel.indexSchematics(raw.schematics, raw.typeMap);
  // Name every commodity the graph mentions, once.
  const ids = new Set();
  for (const s of _piSchIdx.byId.values()) {
    if (s.output) ids.add(s.output.id);
    s.inputs.forEach(i => ids.add(i.id));
  }
  try {
    const arr = await window.eveAPI.getNames([...ids]);
    if (Array.isArray(arr)) arr.forEach(n => { if (n?.id) _piNames[n.id] = n.name; });
    else if (arr) Object.assign(_piNames, arr);
  } catch (_) { /* ids will show instead of names */ }
  return _piSchIdx;
}

const _piName = (id) => _piNames[id] || `#${id}`;
const _piRate = (n) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1));

/** The banner above the colony grid: what your network cannot currently sustain. */
async function renderPiShortfalls() {
  const host = document.getElementById('piShortfallHost');
  if (!host) return;
  const idx = await piSchematics();
  if (!idx) {
    // Not an error — just an SDE from before the schematics were imported.
    host.innerHTML = `<div class="pi-sf-note">Production analysis needs an updated
      static data export. Settings → Database → Update SDE.</div>`;
    return;
  }

  const cols = piAllColonies();
  const net  = PiModel.tallyNetwork(cols, idx);
  const short = PiModel.shortfalls(net.balance, idx);
  const raw   = PiModel.rawDeficits(net.balance, idx);

  if (!short.length && !raw.length) {
    host.innerHTML = `<div class="pi-sf-ok"><span class="sig-light sig-go"></span>
      Every chain balances — nothing is starved.</div>`;
    return;
  }

  // Deepest tier first: fixing a P3 shortfall is pointless while the P2 under it
  // is also short, and the model already sorts that way.
  const fixes = short.map(s => PiModel.fixFor(s, idx));
  const rows = short.map((s, i) => {
    const fix = fixes[i];
    return `<div class="pi-sf-row">
      <span class="sig-light sig-stop"></span>
      ${_piIcon(s.id)}
      <span class="pi-sf-name">${escHtml(_piName(s.id))}</span>
      <span class="pi-sf-tier">P${s.tier}</span>
      <span class="pi-sf-gap">short ${_piRate(Math.abs(s.perHour))}/hr</span>
      <span class="pi-sf-fix">+${fix.factories} factories · ~${fix.planets} planet${fix.planets === 1 ? '' : 's'}</span>
    </div>`;
  }).join('');

  // A raw deficit is a different complaint: not another factory, another
  // extractor — so it names the planet types that yield it, and prices it in
  // extractors using what THIS player's extractors actually yield. There is no
  // meaningful published average: output depends on planet richness, which EVE
  // never publishes. Their own median is the only honest basis.
  const exProfile = PiModel.extractorProfile(net.perPlanet);
  const rawRows = raw.slice(0, 4).map(d => {
    const fix = PiModel.rawFixFor(d, exProfile);
    return `<div class="pi-sf-row is-raw">
      <span class="sig-light sig-hold"></span>
      ${_piIcon(d.id)}
      <span class="pi-sf-name">${escHtml(_piName(d.id))}</span>
      <span class="pi-sf-tier">P0</span>
      <span class="pi-sf-gap">short ${_piRate(Math.abs(d.perHour))}/hr</span>
      ${fix ? `<span class="pi-sf-ecu" title="Based on your own median extractor: ${_piRate(fix.perEcu)}/hr across ${fix.basis} live extractor${fix.basis === 1 ? '' : 's'}, ${fix.ecusPerPlanet} per planet">+${fix.ecus} extractor${fix.ecus === 1 ? '' : 's'} · ~${fix.planets} planet${fix.planets === 1 ? '' : 's'}</span>` : ''}
      <span class="pi-sf-fix">extract on: ${d.planetTypes.join(' · ')}</span>
    </div>`;
  }).join('');

  // Close the loop. A shortfall priced in planets is only actionable if there
  // is somewhere to put them, and that answer is already on this page -- so say
  // both in one line instead of making anyone hold one number while they scroll
  // for the other. When capacity falls short it names the skill that lifts it.
  const cap  = piCapacitySummary();
  const need = fixes.reduce((n, f) => n + f.planets, 0);
  const room = cap.freeSlots >= need;
  const capLine = !need ? '' : `
      <div class="pi-sf-cap ${room ? 'is-ok' : 'is-short'}">
        <span class="sig-light ${room ? 'sig-go' : 'sig-hold'}"></span>
        <span>Needs ~${need} more planet${need === 1 ? '' : 's'} · ${
          cap.freeSlots
            ? `you have ${cap.freeSlots} free slot${cap.freeSlots === 1 ? '' : 's'} across ${cap.freeChars} character${cap.freeChars === 1 ? '' : 's'}`
            : 'every planet slot you have is in use'
        }${room ? '' : ` — ${need - cap.freeSlots} short. Training Interplanetary Consolidation opens one slot per level.`}</span>
      </div>`;

  host.innerHTML = `
    <div class="pi-shortfalls">
      <div class="pi-sf-head">
        <span class="pi-sf-title">PRODUCTION SHORTFALLS</span>
        <span class="pi-sf-sub">${net.factories} factories · ${net.extractors} extractors${
          net.expiredExtractors ? ` · ${net.expiredExtractors} expired` : ''}${
          net.unfedFactories ? ` · ${net.unfedFactories} unfed` : ''}</span>
      </div>
      ${capLine}
      ${rows}
      ${rawRows}
      <div class="pi-sf-foot">Modelled from installed capacity — every factory counted as running.
        ${net.unfedFactories ? '' : 'Re-sync to include routing, which tells fed factories from idle ones.'}
        ${exProfile.perEcu
          ? `Extractor counts use your own median of ${_piRate(exProfile.perEcu)}/hr per extractor
             (${exProfile.ecus} live, ${(exProfile.ecusPerPlanet || 0).toFixed(1)} per planet). EVE publishes no
             planet richness, so there is no useful average to borrow — and yield decays over a
             program's life, so treat planet counts as a starting figure and survey before committing.`
          : 'Raw deficits cannot be priced in planets until at least one extractor is running — there is no published yield to fall back on.'}</div>
    </div>`;
}

// ─── PI Planner ──────────────────────────────────────────────────────────────
// Pick a product and a rate; it solves the tree backwards into a bill of
// factories and the extraction that stands under it, then finds real planets
// near you that can supply each raw material.
let _piPlanTarget = null;   // typeID
let _piPlanRate   = 1;      // units/hr
// Off by default: the plain answer to "what does this chain cost" is the one
// most people open the planner for, and it must not quietly change depending on
// what happens to be running. Turned on, it answers the other question --
// what is still MISSING -- which is usually the one you act on.
let _piPlanNetOff = false;
let _piPlanJumps  = 5;

async function renderPiPlanner(host) {
  const idx = await piSchematics();
  if (!idx) {
    host.innerHTML = `<div class="fin-tab-fill"><div class="fin-empty">
      The planner needs the planetary schematics, which arrive with an updated
      static data export. Settings → Database → Update SDE.</div></div>`;
    return;
  }

  // Anything with a recipe is a valid target, deepest tiers first — nobody opens
  // a planner to work out how to make one P1.
  const targets = [...idx.producer.keys()]
    .map(id => ({ id, name: _piName(id), tier: PiModel.tierOf(id, idx) }))
    .sort((a, b) => b.tier - a.tier || a.name.localeCompare(b.name));
  if (_piPlanTarget == null) _piPlanTarget = targets[0]?.id ?? null;

  host.innerHTML = `
    <div class="fin-tab-fill fw-scroll">
      <div class="pi-plan-bar">
        <div class="pi-filter-item">
          <span class="pi-filter-label">Product</span>
          <select class="pi-filter-select" id="piPlanTarget">
            ${targets.map(t => `<option value="${t.id}"${t.id === _piPlanTarget ? ' selected' : ''}>P${t.tier} · ${escHtml(t.name)}</option>`).join('')}
          </select>
        </div>
        <div class="pi-filter-sep"></div>
        <div class="pi-filter-item">
          <span class="pi-filter-label">Per hour</span>
          <input class="pi-filter-select" id="piPlanRate" type="number" min="1" max="500" value="${_piPlanRate}">
        </div>
        <div class="pi-filter-sep"></div>
        <div class="pi-filter-item">
          <span class="pi-filter-label">Within</span>
          <select class="pi-filter-select" id="piPlanJumps">
            ${[1, 2, 3, 5, 8].map(j => `<option value="${j}"${j === _piPlanJumps ? ' selected' : ''}>${j} jump${j === 1 ? '' : 's'}</option>`).join('')}
          </select>
        </div>
        <div class="pi-filter-sep"></div>
        <label class="pi-cap-toggle" title="Subtract everything your colonies already produce a surplus of, so the plan shows only what is still missing">
          <input type="checkbox" id="piPlanNetOff"${_piPlanNetOff ? ' checked' : ''}>
          <span>Subtract what I already produce</span>
        </label>
      </div>
      <div class="pi-plan-caveat">
        <span class="material-symbols-outlined">travel_explore</span>
        <span>${escHtml(PiModel.SURVEY_CAVEAT)}</span>
      </div>
      <div id="piPlanOut"><div class="loading-row">Solving…</div></div>
    </div>`;

  const rerun = () => {
    _piPlanTarget = Number(document.getElementById('piPlanTarget').value);
    _piPlanRate   = Math.max(1, Number(document.getElementById('piPlanRate').value) || 1);
    _piPlanNetOff = !!document.getElementById('piPlanNetOff')?.checked;
    _piPlanJumps  = Number(document.getElementById('piPlanJumps').value);
    _piRenderPlanOutput(idx);
  };
  document.getElementById('piPlanTarget').onchange = rerun;
  document.getElementById('piPlanRate').onchange   = rerun;
  document.getElementById('piPlanJumps').onchange  = rerun;
  const netOff = document.getElementById('piPlanNetOff');
  if (netOff) netOff.onchange = rerun;

  return _piRenderPlanOutput(idx);
}

async function _piRenderPlanOutput(idx) {
  const out = document.getElementById('piPlanOut');
  if (!out) return;

  // Only a POSITIVE balance is spare capacity. tallyNetwork returns negatives
  // for the things the colonies page is already reporting as shortfalls, and
  // planFor is careful not to read those as stock on hand.
  let available = null;
  let netChars  = 0;
  if (_piPlanNetOff) {
    await _piEnsureNetwork();
    const cols = piAllColonies();
    netChars = cols.length;
    available = PiModel.tallyNetwork(cols, idx).balance;
  }

  const plan = PiModel.planFor(_piPlanTarget, _piPlanRate, idx, available);

  // Group the factory steps by tier so the plan reads as a build order.
  const byTier = new Map();
  plan.steps.forEach(s => { if (!byTier.has(s.tier)) byTier.set(s.tier, []); byTier.get(s.tier).push(s); });
  const tierBlocks = [...byTier.entries()].map(([tier, steps]) => `
    <div class="pi-plan-tier">
      <div class="pi-plan-tier-head">P${tier}<span class="pi-plan-tier-n">${steps.reduce((n, s) => n + s.factories, 0)} factories</span></div>
      ${steps.map(s => `<div class="pi-plan-row${s.factories === 0 ? ' is-covered' : ''}">
        <span class="pi-plan-count">${s.factories}×</span>
        ${_piIcon(s.id)}
        <span class="pi-plan-name">${escHtml(_piName(s.id))}</span>
        ${s.fromStock > 0
          ? `<span class="pi-plan-have" title="Already produced as surplus by your colonies">${_piRate(s.fromStock)}/hr covered</span>`
          : ''}
        <span class="pi-plan-rate">${_piRate(s.actualPerHour)}/hr</span>
      </div>`).join('')}
    </div>`).join('');

  out.innerHTML = `
    <div class="pi-plan-summary">
      <span class="pi-plan-total">${plan.factories}</span> factories ·
      <span class="pi-plan-total">${plan.raw.length}</span> raw materials ·
      target <span class="pi-plan-total">${_piRate(_piPlanRate)}/hr</span>
      ${_piPlanNetOff
        ? `<span class="pi-plan-net">${netChars
             ? `net of ${netChars} existing colon${netChars === 1 ? 'y' : 'ies'}`
             : 'nothing existing to subtract'}</span>`
        : ''}
    </div>
    <div class="pi-plan-tiers">${tierBlocks}</div>
    <div class="pi-plan-raw-head">EXTRACTION REQUIRED</div>
    <div id="piPlanRaw"><div class="loading-row">Finding planets…</div></div>`;

  // Real planets that can supply each raw material, nearest first.
  const origin = _piOriginSysId;
  const rawHost = document.getElementById('piPlanRaw');
  if (!origin) {
    rawHost.innerHTML = `<div class="fin-empty">Sync a character to set a reference
      system, and this will find planets near you for each material.</div>`;
    return;
  }

  const blocks = await Promise.all(plan.raw.map(async r => {
    const cands = await window.eveAPI.piPlanetCandidates({
      originSystemId: origin, maxJumps: _piPlanJumps, planetTypes: r.planetTypes,
    }).catch(() => []);

    // Group by system: a system with three of the right planet type is a better
    // base than three systems with one each — fewer hauls, one launchpad run.
    const bySys = new Map();
    for (const c of cands) {
      if (!bySys.has(c.systemId)) bySys.set(c.systemId, { systemId: c.systemId, name: c.systemName, jumps: c.jumps, sec: c.security, planets: [] });
      bySys.get(c.systemId).planets.push(c);
    }
    const ranked = [...bySys.values()].sort((a, b) =>
      b.planets.length - a.planets.length || a.jumps - b.jumps);

    const best = ranked[0];
    // THE ALTERNATIVES. Richness is unknowable, so the first suggestion may scan
    // badly and the player needs somewhere else to go without starting over.
    const alts = ranked.slice(1, 4);

    return `<div class="pi-plan-raw">
      <div class="pi-plan-raw-top">
        <span class="sig-light sig-hold"></span>
        ${_piIcon(r.id)}
        <span class="pi-plan-name">${escHtml(_piName(r.id))}</span>
        <span class="pi-plan-rate">${_piRate(r.perHour)}/hr</span>
        <span class="pi-plan-ptypes">${r.planetTypes.join(' · ')}</span>
      </div>
      ${best ? `
        <div class="pi-plan-site">
          ${_piSystemChip(best,
            `${best.jumps}j · ${best.planets.length} planet${best.planets.length === 1 ? '' : 's'} · sec ${Number(best.sec).toFixed(1)}`,
            'is-best')}
        </div>
        ${alts.length ? `<div class="pi-plan-alts">
          <span class="pi-plan-alt-label">if those scan poorly:</span>
          ${alts.map(a => _piSystemChip(a, `${a.jumps}j · ${a.planets.length}`)).join('')}
        </div>` : ''}`
      : `<div class="pi-plan-site is-none">No ${r.planetTypes.join('/')} planet within
           ${_piPlanJumps} jumps — widen the range, or haul this one in.</div>`}
    </div>`;
  }));

  rawHost.innerHTML = blocks.join('');
  _piBindSystemChips(rawHost);
}

// ─── Commodity icons + in-game destination ───────────────────────────────────

/** The EVE item icon for a commodity. Decorative — alt is empty, the name is beside it. */
function _piIcon(typeId, size = 32) {
  return `<img class="pi-ico" src="https://images.evetech.net/types/${typeId}/icon?size=${size}"
               alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}

/**
 * Send a system to the running EVE client as the autopilot destination.
 *
 * Uses the SAME character the jump counts are measured from — routing a
 * different pilot would make the "3 jumps" beside it a lie. Needs that character
 * logged into a running client; ESI answers with a plain 401 when it is not, so
 * the toast says what to do rather than repeating the status code.
 */
async function piSetDestination(systemId, systemName) {
  if (!_piOriginCharId) {
    showToast('No reference character — sync one to set destinations.', 'error');
    return;
  }
  try {
    await window.eveAPI.setAutopilotDestination(_piOriginCharId, Number(systemId));
    showToast(`Destination set: ${systemName}`, 'success');
  } catch (e) {
    const msg = String(e?.message || e);
    showToast(/could not be found|401|Unauthorized/i.test(msg)
      ? 'Open EVE and log that character in first.'
      : `Could not set destination: ${msg}`, 'error');
  }
}

/** A clickable system chip. Left-click sets destination — no hidden right-click. */
function _piSystemChip(sys, meta, cls) {
  return `<button class="pi-sys-chip ${cls || ''}" data-sys="${sys.systemId ?? ''}"
                  data-sys-name="${escHtml(sys.name)}"
                  title="Set destination in the running EVE client">
    <span class="material-symbols-outlined pi-sys-ico">my_location</span>
    <span class="pi-sys-name">${escHtml(sys.name)}</span>
    ${meta ? `<span class="pi-sys-meta">${meta}</span>` : ''}
  </button>`;
}

/** Bind every chip in a container. Called after each planner render. */
function _piBindSystemChips(root) {
  (root || document).querySelectorAll('.pi-sys-chip[data-sys]').forEach(btn => {
    if (btn._piBound) return;
    btn._piBound = true;
    btn.addEventListener('click', () => piSetDestination(btn.dataset.sys, btn.dataset.sysName));
  });
}
