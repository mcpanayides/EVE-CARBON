// ─── Assets ───────────────────────────────────────────────────────────────────

// A location name that is actually a placeholder, not a real place: an empty
// value, an ESI error string, or a bare "Structure {id}" / "Location {id}" /
// "Station {id}" fallback. Mirrors the locator's _isUnresolvedName so the UI
// can fall back to the solar system instead of showing a meaningless id.
function isUnresolvedLocName(s) {
  return !s
    || /^(structure|location|station)\s+\d+$/i.test(s)
    || /no structure found|not found|forbidden|^error/i.test(s);
}

// ── Blueprint-aware valuation ────────────────────────────────────────────────
// CCP's global adjusted/average price map (one cached call), used to value
// blueprint originals (BPOs) — including seeded Titan/Super BPOs that have no
// Jita 4-4 sell orders. Populated lazily by _ensureMarketPrices().
let marketPriceCache = null;

async function _ensureMarketPrices() {
  if (marketPriceCache) return marketPriceCache;
  try { marketPriceCache = await window.eveAPI.getMarketPrices() || {}; }
  catch (_) { marketPriceCache = {}; }
  return marketPriceCache;
}

// Per-unit ISK value for an asset, honouring blueprint copy/original rules:
//   • BPC  (is_bpc === 1) → 0.01 ISK            (copies valued nominally)
//   • BPO  (is_bpc === 0) → CCP adjusted/average price (true in-game value)
//   • everything else     → Jita 4-4 sell, then buy
// Returns 0 when the relevant price source hasn't loaded yet (caller shows
// "Loading…" and re-runs once prices arrive).
function assetUnitPrice(typeId, isBpc) {
  const bp = String(isBpc); // normalise 1/'1', 0/'0', null/''/undefined
  if (bp === '1') return 0.01;
  // Capital hulls with no real open market (supers/titans, faction dreads) use an
  // authoritative default that overrides any stray/lowball market order.
  const def = assetDefaultValue(typeId);
  if (def > 0) return def;
  if (bp === '0') {
    const m = (marketPriceCache && marketPriceCache[typeId]) || {};
    return m.adjusted || m.average || 0;
  }
  const e = priceCache[typeId] || {};
  return e.sell || e.buy || 0;
}

// Capital hulls that can't be sold on the open market show 0 ISK from every
// price source, so we substitute a sensible default by hull group. Pirate-
// faction variants (metaGroup 4 in the SDE) are valued higher than standard.
// Standard dreadnoughts DO have a market price, so only faction dreads default.
const ASSET_DEFAULT_VALUE = {
  Titan:        { standard: 165e9, faction: 300e9 },
  Supercarrier: { standard:  50e9, faction: 150e9 },
  Dreadnought:  { standard:     0, faction:  30e9 },
};
function assetDefaultValue(typeId) {
  const md = typeMetaCache[typeId];
  if (!md) return 0;                       // metadata not loaded yet
  const tier = ASSET_DEFAULT_VALUE[md.group];
  if (!tier) return 0;
  return md.metaGroup === 4 ? tier.faction : tier.standard;
}

// Format an ISK total: whole numbers for ≥1, two decimals for sub-1 values so a
// single 0.01-ISK blueprint copy doesn't display as "0 ISK".
function _formatAssetIsk(total) {
  return total >= 1
    ? Math.round(total).toLocaleString('en-US')
    : total.toFixed(2);
}

// ── Static type metadata (group / category / slot / meta / tech) ─────────────
// Sourced from the SDE via get-type-metadata (no ESI). Cached per type_id since
// it never changes; populated lazily and rendered into the extra asset columns.
let typeMetaCache = {};

async function _ensureTypeMeta(typeIds) {
  const missing = [...new Set((typeIds || []).map(Number).filter(Boolean))]
    .filter(t => !typeMetaCache[t]);
  if (!missing.length) return typeMetaCache;
  try {
    const meta = await window.eveAPI.getTypeMetadata(missing);
    Object.assign(typeMetaCache, meta || {});
  } catch (_) { /* leave blanks */ }
  return typeMetaCache;
}

// Fill the metadata columns of every item row from typeMetaCache. Cells are
// located by class, so this is safe regardless of column reorder.
function _updateAssetMetaCells() {
  const tbody = document.querySelector('#assetTable tbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr.asset-item-row').forEach(row => {
    const m = typeMetaCache[Number(row.dataset.typeId)];
    if (!m) return;
    const set = (sel, val) => { const td = row.querySelector(sel); if (td) td.textContent = val; };
    set('.asset-item-group-cell',    m.group    || '');
    set('.asset-item-category-cell', m.category || '');
    set('.asset-item-slot-cell',     m.slot     || '');
    set('.asset-item-meta-cell', m.metaLevel != null ? String(m.metaLevel) : 'None');
    set('.asset-item-tech-cell', m.techLevel != null ? String(m.techLevel) : 'None');
  });
}

// ── Read all assets from character_information.db (one call per character) ───
// Returns a flat array with characterId / characterName attached, matching the
// shape the rest of the code expects. No ESI call is made here.
async function loadAssetsFromDb() {
  const accounts = await window.eveAPI.getAccounts().catch(() => []);
  if (!accounts.length) return [];

  const results = await Promise.all(accounts.map(async (acc) => {
    try {
      const rows = await window.eveAPI.getCharacterAssets(acc.characterId);
      if (!Array.isArray(rows)) return [];
      return rows.map(row => ({
        ...row,
        // DB stores the display name as type_name; normalise to .name so
        // renderNextAssetChunk() works without changes.
        name:          row.type_name || row.name || `Type ${row.type_id}`,
        characterId:   acc.characterId,
        characterName: acc.characterName,
      }));
    } catch (e) {
      console.warn(`[Assets] DB read failed for ${acc.characterName}:`, e.message);
      return [];
    }
  }));

  return results.flat();
}

async function loadAssets() {
  const assetTableBody = document.querySelector('#assetTable tbody');
  const assetSummary   = document.getElementById('assetSummary');

  if (assetTableBody) {
    assetTableBody.innerHTML = '<tr><td colspan="10" class="loading-row">Loading assets from local database…</td></tr>';
  }

  try {
    const allAssets = await loadAssetsFromDb();

    if (!allAssets.length) {
      if (assetTableBody) {
        assetTableBody.innerHTML = '<tr><td colspan="10" class="loading-row">No assets yet — add a character on the Characters page; data syncs automatically.</td></tr>';
      }
      if (assetSummary) assetSummary.textContent = 'No assets yet — add a character; data syncs automatically.';
      return;
    }

    allAssetsCache = allAssets;

    // Populate character, region, and corp dropdowns from the loaded data
    populateAssetFilters(allAssets);

    // Apply any filters already set (e.g. user reloaded while filters were active)
    filterAssets();

    const wrapper = document.getElementById('assetTableWrapper');
    if (wrapper) {
      wrapper.removeEventListener('scroll', assetTableScrollHandler);
      wrapper.addEventListener('scroll', assetTableScrollHandler);
    }

    // ── Background refresh: re-poll the DB after 5 s and 30 s ───────────────
    // The locator pipeline resolves structure locations asynchronously after a
    // sync. Re-loading from the DB a couple of times catches rows that were
    // NULL on first load but now have region_name / owner_name filled in.
    // We only re-populate filters + re-render if new data actually arrived.
    for (const delayMs of [5000, 30000]) {
      setTimeout(async () => {
        try {
          const refreshed = await loadAssetsFromDb();
          if (!refreshed.length) return;

          // Check if any previously-null region/owner_name fields are now filled
          const prevNullRegions = allAssetsCache.filter(a => !a.region_name).length;
          const newNullRegions  = refreshed.filter(a => !a.region_name).length;
          if (newNullRegions >= prevNullRegions) return; // nothing changed, skip re-render

          allAssetsCache = refreshed;
          populateAssetFilters(refreshed);
          // Only re-render if no filter is active — avoids resetting a user's scroll mid-browse
          const charVal   = document.getElementById('assetCharFilter')?.value   || '';
          const regionVal = document.getElementById('assetRegionFilter')?.value || '';
          const corpVal   = document.getElementById('assetCorpFilter')?.value   || '';
          const searchVal = document.getElementById('assetSearch')?.value       || '';
          if (!charVal && !regionVal && !corpVal && !searchVal) {
            filterAssets();
          } else {
            // Still re-filter in case the active selection now matches more rows
            filterAssets();
          }
        } catch (e) { /* ignore background refresh errors */ }
      }, delayMs);
    }

  } catch (err) {
    if (assetTableBody) {
      assetTableBody.innerHTML = `<tr><td colspan="10" class="loading-row">Failed to load assets: ${err.message}</td></tr>`;
    }
    if (assetSummary) assetSummary.textContent = 'Asset load failed.';
    throw err;
  }
}

// ── Re-resolve poisoned / unresolved structure names ─────────────────────────
// Triggers the backend repair pass (purge bad cache + force re-resolve through
// the full locator chain) and reloads the table when done. Slow — streams
// progress to the app console.
async function repairAssetLocations() {
  const btn = document.getElementById('repairLocationsBtn');
  if (btn && btn.disabled) return;
  if (btn) { btn._orig = btn.textContent; btn.textContent = '⏳ RESOLVING…'; btn.disabled = true; }

  const onProgress = (data) => {
    if (data && typeof logToConsole === 'function') {
      logToConsole(`[Locations] ${data.msg}`, data.done ? 'success' : 'info');
    }
  };
  if (window.eveAPI?.on) window.eveAPI.on('repair-progress', onProgress);

  showToast('Re-resolving structure names — this can take a few minutes…', 'info');
  try {
    const r = await window.eveAPI.repairStructureLocations();
    showToast(`✓ Resolved ${r?.resolved || 0} of ${r?.attempted || 0} structures.`, 'success');
    if (typeof loadAssets === 'function') await loadAssets();
  } catch (e) {
    showToast(`Location repair failed: ${e.message}`, 'error');
  } finally {
    if (window.eveAPI?.off) window.eveAPI.off('repair-progress', onProgress);
    if (btn) { btn.textContent = btn._orig || '⚲ RESOLVE NAMES'; btn.disabled = false; }
  }
}

// ── Populate character and region dropdowns ───────────────────────────────────
function populateAssetFilters(assets) {
  const charSelect   = document.getElementById('assetCharFilter');
  const regionSelect = document.getElementById('assetRegionFilter');
  const corpSelect   = document.getElementById('assetCorpFilter');
  if (!charSelect || !regionSelect) return;

  // Preserve current selections across a reload
  const prevChar   = charSelect.value;
  const prevRegion = regionSelect.value;
  const prevCorp   = corpSelect?.value || '';

  // Characters — unique by id, sorted by name
  const chars = [...new Map(assets.map(a => [String(a.characterId), a.characterName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));

  charSelect.innerHTML = '<option value="">All Characters</option>';
  chars.forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    charSelect.appendChild(opt);
  });

  // Regions — unique names, sorted alphabetically; add an "Unresolved" bucket
  // for rows where region_name is still NULL so those assets are never invisible.
  const regions         = [...new Set(assets.map(a => a.region_name).filter(Boolean))].sort();
  const unresolvedCount = assets.filter(a => !a.region_name).length;

  regionSelect.innerHTML = '<option value="">All Regions</option>';
  regions.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    regionSelect.appendChild(opt);
  });
  if (unresolvedCount > 0) {
    const opt = document.createElement('option');
    opt.value = '__unresolved__';
    opt.textContent = `(Unresolved — ${unresolvedCount})`;
    regionSelect.appendChild(opt);
  }

  // Corps (owner_name) — unique, sorted, skip blanks
  if (corpSelect) {
    const corps = [...new Set(assets.map(a => a.owner_name).filter(Boolean))].sort();
    corpSelect.innerHTML = '<option value="">All Corps</option>';
    corps.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      corpSelect.appendChild(opt);
    });
  }

  // Restore previous selections if they still exist
  if (prevChar   && charSelect.querySelector(`option[value="${prevChar}"]`))     charSelect.value   = prevChar;
  if (prevRegion && regionSelect.querySelector(`option[value="${prevRegion}"]`)) regionSelect.value = prevRegion;
  if (prevCorp   && corpSelect?.querySelector(`option[value="${prevCorp}"]`))    corpSelect.value   = prevCorp;
}

// ── Grouped location tree — EVE-style ────────────────────────────────────────
//
// Assets are rendered as collapsible location groups, mirroring the EVE client:
//
//   ▶ 0.5  Jita IV - Moon 4 — 42 Items · 1,234,567 ISK
//       Tritanium                    1000    Minerals
//       Damage Control II              1     Damage Control
//
// State is kept in _assetGroupState (locationKey → expanded bool).
// All groups start expanded. Clicking the header row toggles visibility.
// ─────────────────────────────────────────────────────────────────────────────

// Persistent expand/collapse state across filter changes
if (typeof window._assetGroupState === 'undefined') window._assetGroupState = {};

// ── Filter assets and build grouped tree ─────────────────────────────────────
function filterAssets() {
  if (!allAssetsCache) return;

  const searchVal = (document.getElementById('assetSearch')?.value  || '').toLowerCase().trim();
  const charVal   =  document.getElementById('assetCharFilter')?.value   || '';
  const regionVal =  document.getElementById('assetRegionFilter')?.value || '';
  const corpVal   =  document.getElementById('assetCorpFilter')?.value   || '';

  filteredAssetsCache = allAssetsCache.filter(asset => {
    if (charVal && String(asset.characterId) !== charVal) return false;
    if (regionVal === '__unresolved__') {
      if (asset.region_name) return false;
    } else if (regionVal && (asset.region_name || '') !== regionVal) {
      return false;
    }
    if (corpVal && (asset.owner_name || '') !== corpVal) return false;
    if (searchVal) {
      const name     = (asset.name     || asset.type_name || '').toLowerCase();
      const custom   = (asset.custom_name  || '').toLowerCase();
      const location = (asset.location_name || '').toLowerCase();
      const corp     = (asset.owner_name    || '').toLowerCase();
      const region   = (asset.region_name   || '').toLowerCase();
      const sys      = (asset.solar_system_name || '').toLowerCase();
      if (!name.includes(searchVal) && !custom.includes(searchVal) &&
          !location.includes(searchVal) && !corp.includes(searchVal) &&
          !region.includes(searchVal) && !sys.includes(searchVal)) return false;
    }
    return true;
  });

  // Update summary
  const assetSummary = document.getElementById('assetSummary');
  if (assetSummary) {
    const charCount = new Set(filteredAssetsCache.map(a => String(a.characterId))).size;
    const suffix    = filteredAssetsCache.length < allAssetsCache.length
      ? ` (filtered from ${allAssetsCache.length.toLocaleString()})`
      : ' · local DB';
    assetSummary.textContent =
      `${filteredAssetsCache.length.toLocaleString()} assets across ${charCount} character(s)${suffix}`;
  }

  renderAssetTree();
}

// Not used in tree mode but kept so scroll-listener wiring doesn't break
function assetTableScrollHandler() {}

// ── Column sorting ────────────────────────────────────────────────────────────
// Click any column header to sort. The tree structure is always preserved:
// locations stay grouped, characters stay grouped within each location, and the
// chosen column sorts the items inside each character group. Sorting by Name
// also orders the location and character groups themselves (station → character
// → item), as the EVE client does.
//
//   _assetSort.col  — column key ('name','qty','group',…) or null for default
//   _assetSort.dir  —  1 = ascending (A→Z / low→high), -1 = descending
// Text columns open ascending (A→Z); numeric columns open descending (largest
// first), matching how people expect "biggest value" columns to behave.
if (typeof window._assetSort === 'undefined') window._assetSort = { col: null, dir: 1 };

const _ASSET_COL_TYPE = {
  name: 'text', qty: 'num', group: 'text', category: 'text',
  slot: 'text', vol: 'num', meta: 'num', tech: 'num', price: 'num',
};

// Value a given asset contributes to a given sort column. Numeric columns return
// numbers; text columns return lower-cased strings. Missing meta/tech sort last.
function _assetSortValue(asset, col) {
  const md  = typeMetaCache[asset.type_id] || {};
  const qty = asset.quantity || 1;
  switch (col) {
    case 'qty':      return qty;
    case 'group':    return (md.group    || '').toLowerCase();
    case 'category': return (md.category || '').toLowerCase();
    case 'slot':     return (md.slot     || '').toLowerCase();
    case 'vol':      return Number(asset.volume) || 0;
    case 'meta':     return md.metaLevel != null ? Number(md.metaLevel) : -1;
    case 'tech':     return md.techLevel != null ? Number(md.techLevel) : -1;
    case 'price':    return assetUnitPrice(asset.type_id, asset.is_bpc) * qty;
    case 'name':
    default:         return (asset.name || asset.type_name || '').toLowerCase();
  }
}

// Compare two item rows under the active sort. Ties always fall back to item
// name ascending so the order is stable and predictable.
function _compareAssetItems(a, b) {
  const col = window._assetSort.col;
  const nameA = (a.name || a.type_name || '');
  const nameB = (b.name || b.type_name || '');
  if (!col) return nameA.localeCompare(nameB);

  const type = _ASSET_COL_TYPE[col] || 'text';
  const av = _assetSortValue(a, col);
  const bv = _assetSortValue(b, col);
  let cmp = type === 'num' ? (av - bv) : String(av).localeCompare(String(bv));
  if (cmp === 0) return nameA.localeCompare(nameB); // stable tiebreak, always A→Z
  return cmp * window._assetSort.dir;
}

// Toggle/set the active sort column and re-render. Same column flips direction.
function setAssetSort(col) {
  if (!col || col === 'icon') return;
  const s = window._assetSort;
  if (s.col === col) {
    s.dir *= -1;
  } else {
    s.col = col;
    s.dir = (_ASSET_COL_TYPE[col] === 'num') ? -1 : 1; // num → largest first
  }
  _updateAssetSortIndicators();
  renderAssetTree();
}

// Paint the ▲/▼ caret on the active column header.
function _updateAssetSortIndicators() {
  const thead = document.querySelector('#assetTable thead');
  if (!thead) return;
  thead.querySelectorAll('th[data-col-key]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.colKey === window._assetSort.col) {
      th.classList.add(window._assetSort.dir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });
}

// Delegated header sorting (bound once on the thead, so it survives the reorder/
// resize systems moving the th nodes around).
//
// We can't use a plain 'click' listener: the headers are draggable="true" for
// column reordering, and Chromium suppresses the click whenever the pointer
// moves even a pixel between press and release (it treats it as an aborted
// drag) — which is why clicking/double-clicking did nothing. Instead we watch
// mousedown→mouseup and treat a near-stationary press/release on the same header
// as a sort. A real drag-reorder moves further (and fires dragend, not mouseup),
// so the two never collide.
function _bindAssetSort() {
  const thead = document.querySelector('#assetTable thead');
  if (!thead || thead._sortBound) return;
  thead._sortBound = true;

  let downTh = null, downX = 0, downY = 0;

  thead.addEventListener('mousedown', (e) => {
    downTh = null;
    if (e.button !== 0) return;                                    // left button only
    if (e.target.classList.contains('col-resize-handle')) return; // resize grip, not a sort
    const th = e.target.closest('th[data-col-key]');
    if (!th || th.dataset.colKey === 'icon') return;              // icon column isn't sortable
    downTh = th; downX = e.clientX; downY = e.clientY;
  });

  thead.addEventListener('mouseup', (e) => {
    if (!downTh) return;
    const th    = e.target.closest('th[data-col-key]');
    const moved = Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY);
    if (th === downTh && moved < 5) setAssetSort(th.dataset.colKey);
    downTh = null;
  });
}

// ── Build and render the full location-grouped tree ───────────────────────────
function renderAssetTree() {
  const tbody = document.querySelector('#assetTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const source = filteredAssetsCache || allAssetsCache;
  if (!source || !source.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="loading-row">No assets match the current filters.</td></tr>';
    return;
  }

  // ── Group by location, then by character within each location ──────────────
  // Key by the RESOLVED station (name + solar system), not the raw location_id:
  // items inside ships/containers carry the container's item_id as location_id
  // but resolve to the same station name, so keying on location_id would split
  // one station into many groups. The system id keeps same-named structures in
  // different systems apart. Falls back to location_id when unresolved.
  const locMap = new Map(); // locKey → { meta, charMap: Map(charId → { ... items[] }) }
  for (const asset of source) {
    // A name that is really a placeholder ("Structure 1037…", an ESI error),
    // not a place. When the name can't be resolved but we DO know the solar
    // system, fall back to showing the system rather than a raw id.
    const named  = !isUnresolvedLocName(asset.location_name);
    const sysName = asset.solar_system_name || '';
    const label = named
      ? asset.location_name
      : (sysName ? `Unknown Structure — ${sysName}` : `Location ${asset.location_id}`);
    // Keep distinct unknown structures apart by location_id (don't merge two
    // unnamed citadels in the same system); group named ones by name+system.
    const locKey = named
      ? `${asset.location_name}||${asset.solar_system_id || ''}`
      : String(asset.location_id || 'unknown');
    if (!locMap.has(locKey)) {
      locMap.set(locKey, {
        key:             locKey,
        locationName:    label,
        unresolved:      !named,   // no real station/structure name resolved
        solarSystemName: sysName,
        regionName:      asset.region_name       || '',
        secStatus:       asset.security_status,
        charMap:         new Map(),
        count:           0,
      });
    }
    const loc   = locMap.get(locKey);
    const cId   = String(asset.characterId);
    if (!loc.charMap.has(cId)) {
      loc.charMap.set(cId, { characterId: cId, characterName: asset.characterName || `Char ${cId}`, items: [] });
    }
    loc.charMap.get(cId).items.push(asset);
    loc.count++;
  }

  // ── Sort locations ─────────────────────────────────────────────────────────
  // Sorting by Name orders the station headers themselves (with direction);
  // every other column keeps the default region → system → name grouping so the
  // tree stays readable while the items inside each group get sorted.
  const locations = [...locMap.values()].sort((a, b) => {
    if (window._assetSort.col === 'name') {
      return a.locationName.localeCompare(b.locationName) * window._assetSort.dir;
    }
    const ra = a.regionName.localeCompare(b.regionName);
    if (ra !== 0) return ra;
    const sa = a.solarSystemName.localeCompare(b.solarSystemName);
    if (sa !== 0) return sa;
    return a.locationName.localeCompare(b.locationName);
  });

  // ── Background data: Jita prices, CCP adjusted prices, SDE metadata ─────────
  const sourceTypeIds = [...new Set(source.map(a => a.type_id).filter(Boolean))];
  const priceTypeIds  = sourceTypeIds.filter(t => !priceCache[t]);
  // Capture readiness BEFORE kicking off loads. If the active sort depends on
  // data that only just arrived, we re-sort once; if the data was already
  // present, we only patch the cells (re-rendering then would loop).
  const marketWasReady  = marketPriceCache != null;
  const metaWasComplete = sourceTypeIds.every(t => typeMetaCache[t]);
  const sortNeeds = (cols) => cols.includes(window._assetSort.col);

  if (priceTypeIds.length) {
    window.eveAPI.getJitaPrices(priceTypeIds).then(priceMap => {
      Object.assign(priceCache, priceMap || {});
      if (sortNeeds(['price'])) renderAssetTree(); else _updateAssetPriceCells();
    }).catch(() => {});
  }
  _ensureMarketPrices().then(() => {
    if (!marketWasReady && sortNeeds(['price'])) renderAssetTree();
    else _updateAssetPriceCells();
  });
  _ensureTypeMeta(sourceTypeIds).then(() => {
    // Re-render if a sort column needs the freshly-loaded metadata, OR if any
    // unresolved location's Customs-Office/Skyhook label depends on the now-
    // available item categories. metaWasComplete guards against a render loop.
    // 'price' is included because capital default values key off the hull group.
    const needReRender = !metaWasComplete &&
      (sortNeeds(['group', 'category', 'slot', 'meta', 'tech', 'price']) || locations.some(l => l.unresolved));
    if (needReRender) renderAssetTree();
    else { _updateAssetMetaCells(); _updateAssetPriceCells(); }
  });

  if (typeof window._assetCharState === 'undefined') window._assetCharState = {};

  const frag = document.createDocumentFragment();

  // Customs Office / Skyhook detection: a location we couldn't name whose
  // contents are (mostly) Planetary Commodities/Resources is almost certainly a
  // POCO or an Orbital Skyhook — the only things that hold PI out in space. We
  // can't pin its exact celestial without the corp customs-offices scope, but we
  // can at least say WHAT it is instead of a raw "Location {id}". Junk-loot
  // structures (non-PI contents) don't match, so they're never mislabelled.
  // Needs typeMetaCache; on first paint it may be empty — the metadata-load
  // handler above re-renders once it arrives.
  const _isPiLocation = (loc) => {
    let total = 0, pi = 0;
    for (const ch of loc.charMap.values()) {
      for (const it of ch.items) {
        total++;
        const cat = typeMetaCache[it.type_id]?.category;
        if (cat && cat.startsWith('Planetary')) pi++;
      }
    }
    return total > 0 && (pi / total) >= 0.6;
  };

  // ── Consolidate fully-unknown structures ───────────────────────────────────
  // Private/inaccessible structures with no name AND no solar system (and not a
  // POCO/Skyhook) would otherwise each get a noisy "Location {id}" header. Fold
  // them all into ONE group at the bottom so they stop cluttering the list. Their
  // items stay intact under it, grouped by character.
  const _isFullyUnknown = (loc) => loc.unresolved && !loc.solarSystemName && !_isPiLocation(loc);
  const unknowns = locations.filter(_isFullyUnknown);
  if (unknowns.length > 1) {
    const merged = {
      key:             '__unknown_structures__',
      locationName:    'Unknown / inaccessible structures',
      subtitle:        `${unknowns.length} structures · no name or system resolvable`,
      unresolved:      true,
      solarSystemName: '',
      regionName:      '',
      secStatus:       null,
      charMap:         new Map(),
      count:           0,
    };
    for (const u of unknowns) {
      for (const [cId, ch] of u.charMap) {
        if (!merged.charMap.has(cId)) {
          merged.charMap.set(cId, { characterId: cId, characterName: ch.characterName, items: [] });
        }
        merged.charMap.get(cId).items.push(...ch.items);
      }
      merged.count += u.count;
    }
    // Keep the resolved locations in their sorted order; park the merged group last.
    const remaining = locations.filter(l => !_isFullyUnknown(l));
    remaining.push(merged);
    locations.splice(0, locations.length, ...remaining);
  }

  locations.forEach((loc, li) => {
    // Sec status badge
    let secColor = '#666';
    let secStr   = '';
    if (typeof loc.secStatus === 'number') {
      const sec = loc.secStatus;
      secStr = sec.toFixed(1);
      if      (sec >= 0.5) secColor = '#4ecbb0';
      else if (sec >= 0.1) secColor = '#e6c84a';
      else                 secColor = '#e05252';
    }
    const subtitle = loc.subtitle || [loc.solarSystemName, loc.regionName].filter(Boolean).join(' · ');

    // Relabel unresolved PI-bearing locations (POCOs / Skyhooks). The system, if
    // we have one, still rides along in the subtitle below.
    let displayName = loc.locationName;
    if (loc.unresolved && _isPiLocation(loc)) {
      displayName = loc.solarSystemName
        ? 'Customs Office / Skyhook'
        : 'Customs Office / Skyhook — system unknown';
    }

    // ── Location header row ────────────────────────────────────────────────
    const locTr = document.createElement('tr');
    locTr.className = 'asset-group-header asset-loc-header';
    locTr.dataset.locKey = loc.key;
    locTr.innerHTML = `
      <td colspan="10" class="asset-group-header-cell">
        <div class="asset-group-inner">
          <span class="asset-group-chevron"></span>
          ${secStr ? `<span class="asset-group-sec" style="color:${secColor}">${secStr}</span>` : ''}
          <span class="asset-group-location">${escHtml(displayName)}</span>
          ${subtitle ? `<span class="asset-group-subtitle">· ${escHtml(subtitle)}</span>` : ''}
          <span class="asset-group-spacer"></span>
          <span class="asset-group-count">${loc.count.toLocaleString()} item${loc.count !== 1 ? 's' : ''}</span>
          <span class="asset-group-value asset-loc-value" data-loc-key="${escHtml(loc.key)}">—</span>
        </div>
      </td>`;
    frag.appendChild(locTr);

    // ── Character sub-groups, sorted by name (direction follows a Name sort) ──
    const chars = [...loc.charMap.values()].sort((a, b) => {
      const cmp = a.characterName.localeCompare(b.characterName);
      return window._assetSort.col === 'name' ? cmp * window._assetSort.dir : cmp;
    });

    chars.forEach((ch, ci) => {
      const charKey = `${loc.key}|${ch.characterId}`;
      const portrait = `https://images.evetech.net/characters/${ch.characterId}/portrait?size=32`;

      const charTr = document.createElement('tr');
      charTr.className = 'asset-char-header';
      charTr.dataset.locKey  = loc.key;
      charTr.dataset.charKey = charKey;
      charTr.innerHTML = `
        <td colspan="10" class="asset-char-header-cell">
          <div class="asset-char-inner">
            <span class="asset-char-chevron"></span>
            <img class="asset-char-portrait" src="${portrait}"
                 alt="${escHtml(ch.characterName)}" title="${escHtml(ch.characterName)}" />
            <span class="asset-char-name">${escHtml(ch.characterName)}</span>
            <span class="asset-group-spacer"></span>
            <span class="asset-group-count">${ch.items.length.toLocaleString()} item${ch.items.length !== 1 ? 's' : ''}</span>
            <span class="asset-char-value" data-char-key="${escHtml(charKey)}">—</span>
          </div>
        </td>`;
      frag.appendChild(charTr);

      // ── Item rows: nest fitted/contained items under their ship/container ───
      // ESI gives a flat list; an item's location_id points at its immediate
      // parent. Within a character, items whose parent is ANOTHER of their own
      // items (a ship or container) are nested under it — so a fighter support
      // unit shows under the Nyx it's fitted to, not loose in the hangar.
      const itemById   = new Map(ch.items.map(it => [it.item_id, it]));
      const childrenOf = new Map();
      const roots      = [];
      for (const it of ch.items) {
        const parent = it.location_id != null ? itemById.get(it.location_id) : null;
        if (parent && parent !== it) {
          if (!childrenOf.has(it.location_id)) childrenOf.set(it.location_id, []);
          childrenOf.get(it.location_id).push(it);
        } else {
          roots.push(it);
        }
      }

      const buildItemRow = (asset, depth, shipKey, toggleKey, childCount) => {
        const qty      = asset.quantity || 1;
        const itemName = asset.name || asset.type_name || `Type ${asset.type_id}`;
        // Custom ship/container name (e.g. "Snowbird") shown ahead of the type.
        const customName = asset.custom_name && asset.custom_name !== itemName ? asset.custom_name : '';
        const vol      = asset.volume != null ? Number(asset.volume).toFixed(2) : '—';

        const iconHtml = asset.type_id
          ? `<img class="asset-type-icon" src="https://images.evetech.net/types/${asset.type_id}/icon?size=32" alt="" loading="lazy" />`
          : `<span class="asset-type-icon-placeholder"></span>`;

        const md         = typeMetaCache[asset.type_id];
        const grp        = md ? (md.group || '')    : '';
        const cat        = md ? (md.category || '') : '';
        const slotTxt    = md ? (md.slot || '')     : '';
        const metaTxt    = md ? (md.metaLevel != null ? String(md.metaLevel) : 'None') : '';
        const techTxt    = md ? (md.techLevel != null ? String(md.techLevel) : 'None') : '';

        const unitPrice  = assetUnitPrice(asset.type_id, asset.is_bpc);
        const totalPrice = unitPrice * qty;
        const priceText  = totalPrice > 0 ? `${_formatAssetIsk(totalPrice)} ISK` : 'Loading…';
        const priceClass = totalPrice > 0 ? 'has-price' : 'price-loading';

        const itemTr = document.createElement('tr');
        itemTr.className        = 'asset-item-row';
        itemTr.dataset.locKey   = loc.key;
        itemTr.dataset.charKey  = charKey;
        itemTr.dataset.typeId   = asset.type_id  || '';
        itemTr.dataset.quantity = qty;
        itemTr.dataset.isBpc    = asset.is_bpc != null ? String(asset.is_bpc) : '';
        if (shipKey)   itemTr.dataset.shipKey    = shipKey;    // nested → hides with its ship
        if (toggleKey) itemTr.dataset.shipToggle = toggleKey;  // this row IS a ship/container header

        const indent  = 24 + depth * 18;  // 24px matches the cell's default left pad
        const chevron = toggleKey
          ? `<span class="asset-ship-chevron" title="Show/hide contents">▶</span>`
          : '';
        const contains = childCount > 0
          ? ` <span class="asset-fit-badge" title="${childCount} fitted / contained item${childCount !== 1 ? 's' : ''}">⊞ ${childCount}</span>`
          : '';
        const nameInner = customName
          ? `${escHtml(customName)} <span class="asset-typename-dim">(${escHtml(itemName)})</span>`
          : escHtml(itemName);

        itemTr.innerHTML = `
          <td class="asset-item-icon-cell"     data-col-key="icon">${iconHtml}</td>
          <td class="asset-item-name-cell"     data-col-key="name" style="padding-left:${indent}px !important;">${chevron}${nameInner}${contains}</td>
          <td class="asset-item-qty-cell"      data-col-key="qty">${qty > 1 ? qty.toLocaleString() : ''}</td>
          <td class="asset-item-group-cell"    data-col-key="group">${escHtml(grp)}</td>
          <td class="asset-item-category-cell" data-col-key="category">${escHtml(cat)}</td>
          <td class="asset-item-slot-cell"     data-col-key="slot">${escHtml(slotTxt)}</td>
          <td class="asset-item-vol-cell"      data-col-key="vol">${vol}</td>
          <td class="asset-item-meta-cell"     data-col-key="meta">${escHtml(metaTxt)}</td>
          <td class="asset-item-tech-cell"     data-col-key="tech">${escHtml(techTxt)}</td>
          <td class="asset-item-price-cell ${priceClass}" data-col-key="price"
              data-type-id="${asset.type_id || ''}"
              data-quantity="${qty}"
              data-is-bpc="${asset.is_bpc != null ? asset.is_bpc : ''}">${priceText}</td>`;
        frag.appendChild(itemTr);
      };

      // DFS — every descendant of a top-level ship/container shares that ship's
      // collapse key so the whole fit toggles as one unit. Guards against cycles.
      const seen = new Set();
      const emit = (asset, depth, topKey) => {
        if (seen.has(asset.item_id)) return;
        seen.add(asset.item_id);
        const kids = (childrenOf.get(asset.item_id) || []).sort(_compareAssetItems);
        let myShipKey = topKey;
        let toggleKey = null;
        if (depth === 0 && kids.length) {
          toggleKey = `${charKey}|ship|${asset.item_id}`;
          myShipKey = null;       // a top-level container header isn't hidden by itself
          topKey    = toggleKey;  // its descendants collapse under this key
        }
        buildItemRow(asset, depth, myShipKey, toggleKey, kids.length);
        for (const kid of kids) emit(kid, depth + 1, topKey);
      };
      for (const root of roots.sort(_compareAssetItems)) emit(root, 0, null);
    });
  });

  tbody.appendChild(frag);
  _bindAssetCollapse();
  _bindAssetSort();
  _applyAssetVisibility();
  _updateAssetPriceCells();
  _updateAssetMetaCells();
  _updateAssetSortIndicators();
  initAssetColResize();
}

// ── Collapse state ────────────────────────────────────────────────────────────
// Two independent levels, both COLLAPSED by default so the page opens as a tidy
// list of locations and the user drills in: location → characters → items.
//   window._assetGroupState[locKey]    → location expanded   (true = open)
//   window._assetCharState[locKey|cId] → character expanded  (true = open)
// Visibility is derived from state in one pass rather than walking siblings, so
// nesting can't desync the way a sibling-walk would.
if (typeof window._assetGroupState === 'undefined') window._assetGroupState = {};
if (typeof window._assetCharState  === 'undefined') window._assetCharState  = {};
if (typeof window._assetShipState  === 'undefined') window._assetShipState  = {};

function _applyAssetVisibility() {
  const tbody = document.querySelector('#assetTable tbody');
  if (!tbody) return;

  const locOpen  = (k) => window._assetGroupState[k] === true; // default closed
  const charOpen = (k) => window._assetCharState[k]  === true; // default closed
  const shipOpen = (k) => window._assetShipState[k]  === true; // default closed (fits hidden)

  // Set display inline with !important rather than via a CSS class — inline
  // !important sits at the top of the cascade, so nothing (theme rules, the
  // column-reorder system, table-layout) can leave a "hidden" row visible.
  const show = (row, visible) => {
    if (visible) row.style.removeProperty('display');
    else         row.style.setProperty('display', 'none', 'important');
  };

  tbody.querySelectorAll('tr.asset-loc-header').forEach(h => {
    const chev = h.querySelector('.asset-group-chevron');
    if (chev) chev.textContent = locOpen(h.dataset.locKey) ? '▼' : '▶';
  });
  tbody.querySelectorAll('tr.asset-char-header').forEach(h => {
    show(h, locOpen(h.dataset.locKey));
    const chev = h.querySelector('.asset-char-chevron');
    if (chev) chev.textContent = charOpen(h.dataset.charKey) ? '▼' : '▶';
  });
  tbody.querySelectorAll('tr.asset-item-row').forEach(r => {
    let visible = locOpen(r.dataset.locKey) && charOpen(r.dataset.charKey);
    if (r.dataset.shipKey) visible = visible && shipOpen(r.dataset.shipKey); // hide fits of a collapsed ship
    show(r, visible);
    if (r.dataset.shipToggle) {
      const chev = r.querySelector('.asset-ship-chevron');
      if (chev) chev.textContent = shipOpen(r.dataset.shipToggle) ? '▼' : '▶';
    }
  });
}

// Single delegated click handler bound once to the table body. Survives every
// re-render (clearing tbody.innerHTML doesn't drop listeners on tbody itself)
// and any cell reshuffling done by the column reorder system — far more robust
// than per-row listeners, which is why the chevrons weren't responding before.
function _bindAssetCollapse() {
  const tbody = document.querySelector('#assetTable tbody');
  if (!tbody || tbody._collapseBound) return;
  tbody._collapseBound = true;
  tbody.addEventListener('click', (e) => {
    // Ship/container disclosure: toggle just this fit, not the whole character.
    const shipChev = e.target.closest('.asset-ship-chevron');
    if (shipChev) {
      const row = shipChev.closest('tr.asset-item-row');
      const k   = row && row.dataset.shipToggle;
      if (k) {
        window._assetShipState[k] = !(window._assetShipState[k] === true);
        _applyAssetVisibility();
      }
      return;
    }
    const charH = e.target.closest('tr.asset-char-header');
    if (charH) {
      const k = charH.dataset.charKey;
      window._assetCharState[k] = !(window._assetCharState[k] === true);
      _applyAssetVisibility();
      return;
    }
    const locH = e.target.closest('tr.asset-loc-header');
    if (locH) {
      const k = locH.dataset.locKey;
      window._assetGroupState[k] = !(window._assetGroupState[k] === true);
      _applyAssetVisibility();
    }
  });
}

// ── Update price cells and group value totals ─────────────────────────────────
function _updateAssetPriceCells() {
  const tbody = document.querySelector('#assetTable tbody');
  if (!tbody) return;

  // Update individual item price cells
  tbody.querySelectorAll('td.asset-item-price-cell[data-type-id]').forEach(td => {
    const typeId = Number(td.dataset.typeId);
    const qty    = Number(td.dataset.quantity) || 1;
    const isBpc  = td.dataset.isBpc;
    if (!typeId) return;

    const total = assetUnitPrice(typeId, isBpc) * qty;
    if (total > 0) {
      td.textContent = `${_formatAssetIsk(total)} ISK`;
      td.classList.remove('price-loading', 'price-na');
      td.classList.add('has-price');
    } else if (td.textContent === 'Loading…') {
      // Only fall to N/A once the relevant price source has actually loaded:
      // BPOs depend on the market-price map, everything else on the Jita cache.
      const loaded = String(isBpc) === '0' ? (marketPriceCache != null) : !!priceCache[typeId];
      if (loaded) {
        td.textContent = 'N/A';
        td.classList.remove('price-loading');
        td.classList.add('price-na');
      }
    }
  });

  // Roll up totals per character sub-group and per location.
  const charTotals = {};
  const locTotals  = {};
  tbody.querySelectorAll('tr.asset-item-row').forEach(row => {
    const typeId = Number(row.dataset.typeId);
    const qty    = Number(row.dataset.quantity) || 1;
    if (!typeId) return;
    const v  = assetUnitPrice(typeId, row.dataset.isBpc) * qty;
    const ck = row.dataset.charKey;
    const lk = row.dataset.locKey;
    if (ck) charTotals[ck] = (charTotals[ck] || 0) + v;
    if (lk) locTotals[lk]  = (locTotals[lk]  || 0) + v;
  });

  tbody.querySelectorAll('.asset-char-value[data-char-key]').forEach(el => {
    const t = charTotals[el.dataset.charKey] || 0;
    el.textContent = t > 0 ? `${_formatAssetIsk(t)} ISK` : '—';
  });
  tbody.querySelectorAll('.asset-loc-value[data-loc-key]').forEach(el => {
    const t = locTotals[el.dataset.locKey] || 0;
    el.textContent = t > 0 ? `${_formatAssetIsk(t)} ISK` : '—';
  });
}

// Keep this as a no-op — tree renders all at once, scroll is no longer needed
function renderNextAssetChunk() {}

// ── Draggable column resizing ─────────────────────────────────────────────────
//
// Injects a 6 px drag handle at the right edge of every <th> in #assetTable.
// Column widths are persisted to localStorage so they survive page reloads.
// Call once after the table is first rendered; safe to call again (idempotent).
// ─────────────────────────────────────────────────────────────────────────────

const ASSET_COL_STORAGE_KEY = 'assetColWidths';

/** Default column widths in pixels (order matches the 5 <th> elements).
 *  Icon | Item | Qty | Volume | Jita 4-4 Value */
const ASSET_COL_DEFAULTS = [40, 320, 80, 110, 150];
const ASSET_COL_MIN      = 32;   // px — minimum draggable width

function _assetSaveColWidths(widths) {
  try { localStorage.setItem(ASSET_COL_STORAGE_KEY, JSON.stringify(widths)); } catch (e) {}
}

function _assetLoadColWidths() {
  try {
    const raw = localStorage.getItem(ASSET_COL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Discard stale widths saved from the old 10-column layout
      if (Array.isArray(parsed) && parsed.length === ASSET_COL_DEFAULTS.length) return parsed;
      localStorage.removeItem(ASSET_COL_STORAGE_KEY);
    }
  } catch (e) {}
  return [...ASSET_COL_DEFAULTS];
}

function _assetApplyColWidths(ths, widths) {
  ths.forEach((th, i) => {
    th.style.width    = widths[i] + 'px';
    th.style.minWidth = widths[i] + 'px';
  });
}

function initAssetColResize() {
  const table = document.getElementById('assetTable');
  if (!table) return;

  const ths = Array.from(table.querySelectorAll('thead th'));
  if (!ths.length) return;

  // Remove handles from any previous call (idempotent)
  table.querySelectorAll('.col-resize-handle').forEach(h => h.remove());

  // Apply saved (or default) widths to ths
  const widths = _assetLoadColWidths();
  _assetApplyColWidths(ths, widths);

  // Full-screen drag overlay — sits on top of everything during a drag so
  // mousemove/mouseup are never swallowed by iframes, scrollers, or Electron's
  // webview hit-testing. Removed the moment the mouse is released.
  function _makeDragOverlay() {
    const ov = document.createElement('div');
    ov.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'cursor:col-resize', 'user-select:none',
    ].join(';');
    document.body.appendChild(ov);
    return ov;
  }

  ths.forEach((th, colIdx) => {
    const handle = document.createElement('span');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startX  = e.clientX;
      const startW  = th.getBoundingClientRect().width; // reliable after layout
      const overlay = _makeDragOverlay();
      handle.classList.add('dragging');

      const onMove = (ev) => {
        const newW = Math.max(ASSET_COL_MIN, startW + (ev.clientX - startX));
        widths[colIdx]    = Math.round(newW);
        th.style.width    = newW + 'px';
        th.style.minWidth = newW + 'px';
      };

      const onUp = () => {
        overlay.remove();
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup',   onUp,   true);
        _assetSaveColWidths(widths);
      };

      // Use capture so events fire even if a child calls stopPropagation
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup',   onUp,   true);
    });
  });
}

// Pre-fetch assets from local DB in the background at startup (non-blocking).
// No ESI call — just warms allAssetsCache so the Assets page opens instantly.
async function prefetchAssetsBackground() {
  try {
    const cached = await loadAssetsFromDb();
    if (cached?.length) {
      allAssetsCache = cached;
      populateAssetFilters(cached);
    }
  } catch (e) { /* ignore */ }
}

// ── Wallets ───────────────────────────────────────────────────────────────────
// Reads wallet balances exclusively from character_information.db via
// getCharacterData(). Falls back to the dashboard cache only as a secondary
// layer; never calls ESI directly.
// ── Wallet grid ordering (drag-to-reorder, persisted to localStorage) ─────────
// The grid holds the net-worth tile (id "__networth__") plus one tile per
// character (id = characterId). Both kinds are draggable and share one saved
// order list.
const WALLET_ORDER_KEY = 'wallet_card_order';
const NETWORTH_ID      = '__networth__';

function _getWalletOrder() {
  try { const o = JSON.parse(localStorage.getItem(WALLET_ORDER_KEY) || 'null'); return Array.isArray(o) ? o : null; }
  catch (_) { return null; }
}

// Snapshot the current DOM order of every grid tile into localStorage (on drop).
function saveWalletOrder() {
  const grid = document.getElementById('walletsGrid');
  if (!grid) return;
  const order = [...grid.querySelectorAll('[data-char-id]')].map(c => c.dataset.charId).filter(Boolean);
  try { localStorage.setItem(WALLET_ORDER_KEY, JSON.stringify(order)); } catch (_) {}
}

// Order the grid items. Default: net-worth tile first, then characters by total
// wealth. A saved manual drag order takes precedence.
function _orderWalletItems(items) {
  const wealth = (it) => it.kind === 'card' ? (it.data.rawBalance + it.data.assetValue) : 0;
  const def = (a, b) => {
    if (a.kind === 'networth') return -1;
    if (b.kind === 'networth') return 1;
    return wealth(b) - wealth(a);
  };
  const saved = _getWalletOrder();
  if (!saved) return [...items].sort(def);
  const idx = {}; saved.forEach((id, i) => { idx[String(id)] = i; });
  return [...items].sort((a, b) => {
    const ai = idx[a.id] ?? 9999, bi = idx[b.id] ?? 9999;
    return ai !== bi ? ai - bi : def(a, b);
  });
}

// Shared drag wiring for any grid tile (net-worth widget or a character card).
function _wireWalletDrag(el) {
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', el.dataset.charId || '');
    setTimeout(() => el.classList.add('dragging'), 0);
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); saveWalletOrder(); });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    const grid = document.getElementById('walletsGrid');
    const dragging = grid && grid.querySelector('.dragging');
    if (!dragging || dragging === el) return;
    const rect   = el.getBoundingClientRect();
    const before = e.clientY < rect.top    ? true
                 : e.clientY > rect.bottom  ? false
                 : e.clientX < rect.left + rect.width / 2;
    grid.insertBefore(dragging, before ? el : el.nextSibling);
  });
  el.addEventListener('drop', (e) => e.preventDefault());
}

async function renderWallets() {
  const walletsGrid = document.getElementById('walletsGrid');
  if (!walletsGrid) return;
  if (walletsGrid._isLoading) return;
  walletsGrid._isLoading = true;

  try {
    walletsGrid.innerHTML = '';
    const accounts = await window.eveAPI.getAccounts();

    // Pull wallet balances from the local DB for every character.
    // getCharacterData() returns { info, wallet, location, ship, … } where
    // wallet is the most-recent row from char_X_wallet (balance + synced_at).
    // If the DB has no row yet (character never synced) we fall back to the
    // dashboard cache, then to 0 — never to a live ESI call.
    const cachedDash    = await window.eveAPI.cacheGet('dashboard_cache').catch(() => null);
    const cachedWallets = cachedDash?.walletByChar || {};

    // CCP adjusted prices for valuing each character's assets (one cached call).
    const marketPrices = await window.eveAPI.getMarketPrices().catch(() => ({}));

    const cardData = await Promise.all(accounts.map(async (account) => {
      const cid = String(account.characterId);
      let rawBalance = 0;
      let syncedAt   = null;

      try {
        const charData = await window.eveAPI.getCharacterData(account.characterId);
        if (charData?.wallet?.balance != null) {
          rawBalance = charData.wallet.balance;
          syncedAt   = charData.wallet.synced_at || null;
        } else {
          // No DB row yet — use dashboard cache if available, otherwise 0.
          rawBalance = cachedWallets[cid] ?? 0;
        }
      } catch (e) {
        console.warn(`[Wallets] DB read failed for ${account.characterName}:`, e.message);
        rawBalance = cachedWallets[cid] ?? 0;
      }

      // Asset value from the local DB × CCP adjusted price, with blueprint
      // copies valued at 0.01 ISK — the same rule the dashboard net worth uses.
      let assetValue = 0;
      try {
        const assets = await window.eveAPI.getCharacterAssetsDb(account.characterId);
        (Array.isArray(assets) ? assets : []).forEach(a => {
          let unit;
          if (Number(a.is_bpc) === 1) unit = 0.01;
          else { const p = marketPrices[a.type_id] || {}; unit = p.adjusted || p.average || 0; }
          assetValue += unit * (a.quantity || 1);
        });
      } catch (_) { /* leave 0 */ }

      return { account, rawBalance, assetValue, syncedAt };
    }));

    // Aggregate totals for the net-worth tile.
    const walletByChar = {}, assetByChar = {};
    let totalWallet = 0, overallValue = 0;
    cardData.forEach(({ account, rawBalance, assetValue }) => {
      const cid = String(account.characterId);
      walletByChar[cid] = rawBalance;  totalWallet  += rawBalance;
      assetByChar[cid]  = assetValue;  overallValue += assetValue;
    });

    // ── Render the grid: a draggable 3×2 net-worth tile + character cards ─────
    const items = [
      { id: NETWORTH_ID, kind: 'networth' },
      ...cardData.map(c => ({ id: String(c.account.characterId), kind: 'card', data: c })),
    ];

    _orderWalletItems(items).forEach(item => {
      // ── Net-worth tile (compact dashboard widget) ──────────────────────────
      if (item.kind === 'networth') {
        const tile = document.createElement('div');
        tile.className = 'wallet-card wallet-networth-tile';
        tile.draggable = true;
        tile.dataset.charId = NETWORTH_ID;
        tile.innerHTML = `
          <div class="wallet-networth-head"><span class="dnd-grip">⠿</span> NET WORTH &amp; WEALTH GROWTH</div>
          <div id="walletsNetWorth" class="wallet-networth-body"></div>`;
        walletsGrid.appendChild(tile);
        _wireWalletDrag(tile);
        if (accounts.length && typeof renderKPIPanel === 'function') {
          renderKPIPanel(tile.querySelector('#walletsNetWorth'), accounts, totalWallet, overallValue,
                         totalWallet + overallValue, assetByChar, walletByChar, false, { compact: true });
        }
        return;
      }

      // ── Character card: liquid + asset bars (unified theme colours) ────────
      const { account, rawBalance, assetValue, syncedAt } = item.data;
      let syncLabel = 'Never synced';
      if (syncedAt) syncLabel = `Synced ${new Date(syncedAt).toLocaleString()}`;

      // Bars scale to the character's own total so each card shows its split.
      const charTotal = rawBalance + assetValue || 1;
      const liquidPct = Math.min(100, (rawBalance  / charTotal) * 100);
      const assetPct  = Math.min(100, (assetValue  / charTotal) * 100);

      const card = document.createElement('div');
      card.className = 'wallet-card';
      card.draggable = true;
      card.dataset.charId = account.characterId;
      card.innerHTML = `
        <div class="wallet-header">
          <img class="wallet-avatar" draggable="false"
               src="https://images.evetech.net/characters/${account.characterId}/portrait?size=64"
               alt="${escHtml(account.characterName)}">
          <div class="wallet-info">
            <span class="wallet-name">${escHtml(account.characterName)}</span>
            <span class="wallet-corp">Corp Ticker</span>
          </div>
        </div>
        <div class="wallet-balance-container">
          <span class="wallet-balance-label">Liquid Wealth</span>
          <span class="wallet-balance">
            <span class="wallet-balance-number">0.00</span>
            <span class="isk-symbol"> ISK</span>
          </span>
        </div>
        <div class="wallet-bars">
          <div class="wallet-bar-row">
            <span class="wallet-bar-tag" style="color:var(--liquidisk);">Liquid</span>
            <div class="wallet-bar-track"><div class="wallet-bar-fill liquid" style="width:${liquidPct.toFixed(1)}%"></div></div>
            <span class="wallet-bar-val">${formatISK(rawBalance)}</span>
          </div>
          <div class="wallet-bar-row">
            <span class="wallet-bar-tag" style="color:var(--assets);">Assets</span>
            <div class="wallet-bar-track"><div class="wallet-bar-fill assets" style="width:${assetPct.toFixed(1)}%"></div></div>
            <span class="wallet-bar-val">${formatISK(assetValue)}</span>
          </div>
        </div>
        <div class="wallet-footer">
          <span class="wallet-meta">${escHtml(syncLabel)}</span>
          <button class="wallet-action journal-open-btn" data-char-id="${account.characterId}" data-char-name="${escHtml(account.characterName)}">View Journal</button>
        </div>`;
      walletsGrid.appendChild(card);
      countUp(card.querySelector('.wallet-balance-number'), rawBalance);

      card.querySelector('.journal-open-btn').addEventListener('click', () => {
        openWalletJournal(account.characterId, account.characterName);
      });
      _wireWalletDrag(card);
    });
  } finally {
    walletsGrid._isLoading = false;
  }
}
// ── Wallet Journal Modal ───────────────────────────────────────────────────────

// EVE ref_type → category mapping for the ring chart
const JOURNAL_CATEGORIES = {
  bounty_prizes:              'Bounty',
  bounty_prize:               'Bounty',
  agent_mission_reward:       'Bounty',
  agent_mission_time_bonus_reward: 'Bounty',
  mission_reward:             'Bounty',
  incursion_participant_payou: 'Bounty',
  // Trade
  market_transaction:         'Trade',
  contract_reward:            'Trade',
  contract_price:             'Trade',
  contract_collateral:        'Trade',
  contract_deposit:           'Trade',
  contract_auction_bid:       'Trade',
  contract_auction_bid_corp:  'Trade',
  contract_price_payment_corp:'Trade',
  market_escrow:              'Trade',
  transaction_tax:            'Trade',
  brokers_fee:                'Trade',
  // Transfers
  player_donation:            'Transfers',
  corporation_account_withdrawal: 'Transfers',
  corporation_dividend_payment:   'Transfers',
  ess_escrow_transfer:        'Transfers',
  // Miscellaneous (everything else falls here)
};

const CATEGORY_COLORS = {
  Bounty:    '#e05252',   // red
  Trade:     '#4ecbb0',   // teal
  Misc:      '#8c8c8c',   // grey
  Transfers: '#e6c84a',   // yellow
};

function classifyEntry(entry) {
  const rt = (entry.ref_type || '').toLowerCase();
  return JOURNAL_CATEGORIES[rt] || 'Misc';
}

async function openWalletJournal(characterId, characterName) {
  const backdrop = document.getElementById('walletJournalBackdrop');
  if (!backdrop) return;

  // Set header
  document.getElementById('journalCharPortrait').src =
    `https://images.evetech.net/characters/${characterId}/portrait?size=64`;
  document.getElementById('journalCharName').textContent = characterName;

  // Reset to overview tab
  setJournalTab('overview');
  backdrop.style.display = 'flex';

  // Load data in parallel
  const [journalEntries, lpData] = await Promise.all([
    loadJournalEntries(characterId),
    loadLPData(characterId),
  ]);

  renderJournalOverview(journalEntries);
  renderJournalTransactions(journalEntries);
  renderJournalLP(lpData);
}

function closeWalletJournal() {
  const backdrop = document.getElementById('walletJournalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
  // Destroy chart to free memory
  const canvas = document.getElementById('journalRingChart');
  if (canvas && canvas._chartInstance) {
    canvas._chartInstance.destroy();
    canvas._chartInstance = null;
  }
}

function setJournalTab(tab) {
  document.querySelectorAll('.journal-tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.style.background = active ? 'var(--accent)' : 'none';
    btn.style.color      = active ? '#000' : 'var(--text-2)';
    btn.classList.toggle('active', active);
  });
  document.querySelectorAll('.journal-tab-content').forEach(el => {
    el.style.display = el.id === `journalTab-${tab}` ? '' : 'none';
  });
}

// Bind tab buttons (runs once when modal HTML is created; safe to call multiple times)
(function bindJournalTabs() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.journal-tab-btn');
    if (!btn) return;
    setJournalTab(btn.dataset.tab);
  });
  // Close on backdrop click
  document.addEventListener('click', (e) => {
    const backdrop = document.getElementById('walletJournalBackdrop');
    if (backdrop && e.target === backdrop) closeWalletJournal();
  });
})();

// ── Data loaders ─────────────────────────────────────────────────────────────
async function loadJournalEntries(characterId) {
  // Primary: read from CharDB (synced every 30 min by coreCharacterSync)
  try {
    const rows = await window.eveAPI.getWalletJournal(characterId);
    if (Array.isArray(rows) && rows.length) return rows;
  } catch (e) { /* fall through */ }
  // Fallback: live ESI call if DB is empty (e.g. character never synced yet)
  try {
    const url  = `https://esi.evetech.net/v6/characters/${characterId}/wallet/journal/?datasource=tranquility&page=1`;
    const data = await window.eveAPI.esiFetch(url).catch(() => null);
    if (Array.isArray(data) && data.length) return data;
  } catch (e) { /* ignore */ }
  return [];
}

async function loadLPData(characterId) {
  // Primary: read from CharDB (synced every 30 min by coreCharacterSync)
  try {
    const rows = await window.eveAPI.getLoyaltyPoints(characterId);
    if (Array.isArray(rows) && rows.length) return rows;
  } catch (e) { /* fall through */ }
  // Fallback: live ESI call if DB is empty
  try {
    const url  = `https://esi.evetech.net/v1/characters/${characterId}/loyalty/points/?datasource=tranquility`;
    const data = await window.eveAPI.esiFetch(url).catch(() => null);
    if (Array.isArray(data)) return data;
  } catch (e) { /* ignore */ }
  return [];
}

// ── Renderers ─────────────────────────────────────────────────────────────────
function renderJournalOverview(entries) {
  const now    = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;

  // Only last 30 days
  const recent = entries.filter(e => {
    const t = e.date ? new Date(e.date).getTime() : 0;
    return t >= cutoff;
  });

  // Split income vs expenses by category
  const incomeByCat  = { Bounty: 0, Trade: 0, Misc: 0, Transfers: 0 };
  const expenseByCat = { Bounty: 0, Trade: 0, Misc: 0, Transfers: 0 };
  let totalIncome = 0, totalExpense = 0;

  recent.forEach(e => {
    const amt = parseFloat(e.amount) || 0;
    const cat = classifyEntry(e);
    if (amt >= 0) {
      incomeByCat[cat] = (incomeByCat[cat] || 0) + amt;
      totalIncome += amt;
    } else {
      expenseByCat[cat] = (expenseByCat[cat] || 0) + Math.abs(amt);
      totalExpense += Math.abs(amt);
    }
  });

  // Update income/expense totals
  document.getElementById('journalIncomeTotal').textContent  = formatISK(totalIncome);
  document.getElementById('journalExpenseTotal').textContent = formatISK(totalExpense);

  // ── Income breakdown legend (right column) ──────────────────────────────────
  const legendEl = document.getElementById('journalLegend');
  if (legendEl) {
    const allCats = Object.keys(incomeByCat);
    legendEl.innerHTML = allCats.map(cat => {
      const pct = totalIncome > 0 ? (incomeByCat[cat] / totalIncome * 100).toFixed(1) : '0.0';
      const amt = formatISK(incomeByCat[cat]);
      return `<div style="display:flex;align-items:center;gap:12px;">
        <span style="width:12px;height:12px;border-radius:3px;background:${CATEGORY_COLORS[cat]};flex-shrink:0;"></span>
        <span style="font-size:13px;color:var(--text-2);font-family:var(--mono);min-width:44px;">${pct}%</span>
        <span style="font-size:13px;color:var(--text-1);flex:1;">${cat}</span>
        <span style="font-size:12px;color:var(--text-3);font-family:var(--mono);">${amt}</span>
      </div>`;
    }).join('');
  }

  // ── Stacked daily income + cumulative growth chart ──────────────────────────
  const canvas = document.getElementById('journalRingChart');
  if (!canvas) return;
  if (canvas._chartInstance) { canvas._chartInstance.destroy(); canvas._chartInstance = null; }
  if (typeof Chart === 'undefined') return;

  const DAY   = 86400000;
  const days  = 30;
  const start = now - days * DAY;

  // Bucket income per day by category; build the running cumulative total.
  const dayCat = Array.from({ length: days }, () => ({ Bounty: 0, Trade: 0, Misc: 0, Transfers: 0 }));
  recent.forEach(e => {
    const amt = parseFloat(e.amount) || 0;
    if (amt < 0) return;                       // income only for the bars
    const t = e.date ? new Date(e.date).getTime() : 0;
    let di = Math.floor((t - start) / DAY);
    if (di < 0) di = 0; else if (di > days - 1) di = days - 1;
    dayCat[di][classifyEntry(e)] += amt;
  });

  const labels = Array.from({ length: days }, (_, i) =>
    new Date(start + i * DAY).toLocaleDateString('en', { day: 'numeric', month: 'short' }));

  const CAT_ORDER   = ['Bounty', 'Trade', 'Misc', 'Transfers'];
  const barDatasets = CAT_ORDER.map(cat => ({
    type: 'bar', label: cat, stack: 'income', yAxisID: 'y',
    data: dayCat.map(d => Math.round(d[cat])),
    backgroundColor: CATEGORY_COLORS[cat],
    borderWidth: 0, borderRadius: 2,
    categoryPercentage: 0.86, barPercentage: 0.96,
  }));

  let run = 0;
  const cumulative = dayCat.map(d => {
    run += d.Bounty + d.Trade + d.Misc + d.Transfers;
    return Math.round(run);
  });
  const lineDataset = {
    type: 'line', label: 'Cumulative income', yAxisID: 'y1',
    data: cumulative,
    borderColor: '#e8e8e8', borderWidth: 2, tension: 0.35,
    pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: '#e8e8e8',
    fill: true,
    backgroundColor: (c) => {
      const area = c.chart.chartArea;
      if (!area) return 'rgba(232,232,232,0.06)';
      const g = c.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, 'rgba(232,232,232,0.16)');
      g.addColorStop(1, 'rgba(232,232,232,0)');
      return g;
    },
  };

  const fmtAxis = (v) =>
    v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' :
    v >= 1e6 ? (v / 1e6).toFixed(0) + 'M' :
    v >= 1e3 ? (v / 1e3).toFixed(0) + 'k' : v;

  canvas._chartInstance = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [...barDatasets, lineDataset] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatISK(ctx.parsed.y)}` },
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
        }
      },
      scales: {
        x:  { stacked: true, ticks: { color: '#6a6a6a', font: { size: 9, family: 'monospace' }, autoSkip: true, maxRotation: 0, maxTicksLimit: 8 }, grid: { display: false } },
        y:  { stacked: true, beginAtZero: true, ticks: { color: '#6a6a6a', font: { size: 9, family: 'monospace' }, callback: fmtAxis }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { color: '#8a8a8a', font: { size: 9, family: 'monospace' }, callback: fmtAxis } },
      }
    }
  });
}

function renderJournalTransactions(entries) {
  const tbody = document.getElementById('journalTransactionBody');
  if (!tbody) return;

  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-3);font-family:var(--mono);font-size:12px;">No journal entries found. Sync this character to populate data.</td></tr>`;
    return;
  }

  // Sort newest first
  const sorted = [...entries].sort((a, b) => {
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  tbody.innerHTML = sorted.slice(0, 500).map(e => {
    const amt     = parseFloat(e.amount) || 0;
    const bal     = parseFloat(e.balance) || 0;
    const amtColor = amt >= 0 ? '#4ecbb0' : 'var(--danger)';
    const amtStr   = (amt >= 0 ? '+' : '') + formatISK(amt);
    const dateStr  = e.date ? new Date(e.date).toLocaleString('en-ZA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }) : '—';
    // Human-readable ref type
    const typeLabel = (e.ref_type || '—')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    const desc = escHtml(e.description || e.reason || '—');

    return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
      <td style="padding:9px 12px;font-size:11px;color:var(--text-3);font-family:var(--mono);white-space:nowrap;">${dateStr}</td>
      <td style="padding:9px 12px;font-size:12px;color:var(--text-2);white-space:nowrap;">${typeLabel}</td>
      <td style="padding:9px 12px;font-size:12px;color:${amtColor};font-family:var(--mono);text-align:right;white-space:nowrap;">${amtStr}</td>
      <td style="padding:9px 12px;font-size:12px;color:var(--text-3);font-family:var(--mono);text-align:right;white-space:nowrap;">${formatISK(bal)}</td>
      <td style="padding:9px 12px;font-size:12px;color:var(--text-2);max-width:300px;word-break:break-word;">${desc}</td>
    </tr>`;
  }).join('');
}

async function renderJournalLP(lpRows) {
  const tbody = document.getElementById('journalLPBody');
  if (!tbody) return;

  if (!lpRows.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="padding:20px;text-align:center;color:var(--text-3);font-family:var(--mono);font-size:12px;">No LP data found. Sync this character to populate standings.</td></tr>`;
    return;
  }

  // Sort by LP descending
  const sorted = [...lpRows].sort((a, b) => (b.loyalty_points || 0) - (a.loyalty_points || 0));

  // Resolve corporation names via ESI names endpoint
  let nameMap = {};
  try {
    const ids = sorted.map(r => r.corporation_id).filter(Boolean);
    if (ids.length) {
      const names = await window.eveAPI.getNames(ids).catch(() => []);
      if (Array.isArray(names)) names.forEach(n => { nameMap[n.id] = n.name; });
    }
  } catch (e) { /* leave names as IDs */ }

  tbody.innerHTML = sorted.map(row => {
    const corpId   = row.corporation_id || 0;
    const corpName = escHtml(nameMap[corpId] || `Corp ${corpId}`);
    const lp       = (row.loyalty_points || 0).toLocaleString();
    // No live store lookup available without additional ESI; show placeholder
    const store    = '—';

    return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
      <td style="padding:11px 16px;font-size:13px;color:var(--text-1);">${corpName}</td>
      <td style="padding:11px 16px;font-size:13px;color:var(--accent);font-family:var(--mono);text-align:right;">${lp}</td>
      <td style="padding:11px 16px;font-size:12px;color:var(--text-3);">${store}</td>
    </tr>`;
  }).join('');
}