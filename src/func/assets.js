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


// ── What things are worth now lives in the database ──────────────────────────
// Valuation used to happen in this file: a Jita price cache, CCP's adjusted
// price map, SDE metadata for the capital-hull defaults, and a walk over the
// rendered DOM that rolled container contents up into their parents every time
// a price arrived. All of it moved to src/asset_valuation.js and
// src/asset_index.js, where it is computed once per sync and can be sorted and
// aggregated in SQL. This page reads the answer; it no longer works it out.

// Format an ISK total: whole numbers for ≥1, two decimals for sub-1 values so a
// single 0.01-ISK blueprint copy doesn't display as "0 ISK".
function _formatAssetIsk(total) {
  return total >= 1
    ? Math.round(total).toLocaleString('en-US')
    : total.toFixed(2);
}

// ── Re-resolve unresolved structure names ────────────────────────────────────
// Lives in Settings ▸ Database ▸ Structure Names (not the Assets toolbar, where
// it was read as a page refresh and clicked repeatedly). Forces the locator past
// its failure backoff and cache for every structure still showing a fallback
// name. Slow, and rate-limited by design — the outcome of the last run is kept
// so a second click has something to say for itself instead of looking inert.
const ASSET_REPAIR_KEY = 'assetRepairLastRun';
const ASSET_REPAIR_LABEL = 'RESOLVE STRUCTURE NAMES';

function _repairSetStatus(msg, tone) {
  const el = document.getElementById('repairLocationsStatus');
  if (!el) return;
  el.style.color = tone === 'ok' ? 'var(--accent)' : tone === 'bad' ? 'var(--danger)' : 'var(--text-3)';
  el.textContent = msg || '';
}

// Shown when Settings is opened, so the panel explains itself before you click.
function paintAssetRepairLastRun() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(ASSET_REPAIR_KEY) || 'null'); } catch (_) { /* ignore */ }
  if (!last || !last.at) return;
  const mins = Math.round((Date.now() - last.at) / 60_000);
  const when = mins < 1 ? 'just now'
             : mins < 60 ? `${mins} min ago`
             : mins < 1440 ? `${Math.round(mins / 60)} h ago`
             : `${Math.round(mins / 1440)} d ago`;
  _repairSetStatus(`Last run ${when} — resolved ${last.resolved} of ${last.attempted} structure(s).`);
}

async function repairAssetLocations() {
  const btn = document.getElementById('repairLocationsBtn');
  if (btn && btn.disabled) return;
  if (btn) { btn._orig = btn.textContent; btn.textContent = 'RESOLVING…'; btn.disabled = true; }

  // Progress goes to the settings panel as well as the console — from here the
  // Assets table isn't on screen, so the console alone would look like nothing
  // is happening for several minutes.
  const onProgress = (data) => {
    if (!data) return;
    if (typeof logToConsole === 'function') {
      logToConsole(`[Locations] ${data.msg}`, data.done ? 'success' : 'info');
    }
    _repairSetStatus(data.msg, data.done ? 'ok' : null);
  };
  const stopProgress = window.eveAPI?.on?.('repair-progress', onProgress);

  _repairSetStatus('Re-resolving structure names — this can take a few minutes…');
  showToast('Re-resolving structure names — this can take a few minutes…', 'info');
  try {
    const r = await window.eveAPI.repairStructureLocations();
    const attempted = r?.attempted || 0;
    const resolved  = r?.resolved  || 0;
    try {
      localStorage.setItem(ASSET_REPAIR_KEY, JSON.stringify({ at: Date.now(), attempted, resolved }));
    } catch (_) { /* private mode */ }
    // Nothing left to try is a result, not a failure — say so plainly, since the
    // alternative reading ("it did nothing") is what makes people click again.
    _repairSetStatus(attempted === 0
      ? 'Nothing to resolve — every structure in your assets already has a name.'
      : `✓ Resolved ${resolved} of ${attempted} structure(s). The rest need docking access before ESI will name them.`,
      'ok');
    showToast(`✓ Resolved ${resolved} of ${attempted} structures.`, 'success');
    if (typeof loadAssets === 'function') await loadAssets();
  } catch (e) {
    _repairSetStatus(`Repair failed: ${e.message}`, 'bad');
    showToast(`Location repair failed: ${e.message}`, 'error');
  } finally {
    stopProgress?.();
    if (btn) { btn.textContent = btn._orig || ASSET_REPAIR_LABEL; btn.disabled = false; }
  }
}
// ── The Assets page: one query per view ──────────────────────────────────────
//
// The page used to load every asset of every character into one array, then
// filter, group, sort and render it in JS. At ninety characters that array is
// the problem on its own: seconds to cross the IPC boundary, a re-sort of the
// whole portfolio on every keystroke, and a hundred thousand table rows built
// up front and then hidden with display:none.
//
// Now the database answers each view separately. The page opens as a list of
// locations — about a hundred and twenty rows. Opening one asks which
// characters hold something there; opening a character asks for its items.
// Collapsing removes those rows again, so the DOM only ever holds what is
// actually on screen, and no query returns more than a hangar's worth.
//
// Collapse state is the thing that decides what gets FETCHED, not just what is
// visible. That is the substantive change: state is data the page acts on,
// rather than a class applied to rows that were built regardless.
// ─────────────────────────────────────────────────────────────────────────────

// Expansion state. Both default to closed, so the page opens as a tidy list of
// locations and the user drills in: location → characters → items.
//   window._assetGroupState[locKey]        → location expanded
//   window._assetCharState[locKey|charId]  → character expanded
//   window._assetShipState[shipKey]        → a ship/container's fit expanded
if (typeof window._assetGroupState === 'undefined') window._assetGroupState = {};
if (typeof window._assetCharState  === 'undefined') window._assetCharState  = {};
if (typeof window._assetShipState  === 'undefined') window._assetShipState  = {};

// Guards against a slow query painting over a newer one — the search box can
// easily start a second render before the first has returned.
let _assetRenderToken = 0;
// The index is built by the main process after a sync. On a first run, or the
// first launch after upgrading, it may not exist yet; we ask for it to be built
// exactly once rather than on every empty render.
let _assetIndexBuildRequested = false;

/** The four toolbar controls, as the filter object every query takes. */
function assetFilters() {
  return {
    characterId: document.getElementById('assetCharFilter')?.value   || '',
    region:      document.getElementById('assetRegionFilter')?.value || '',
    corp:        document.getElementById('assetCorpFilter')?.value   || '',
    search:      (document.getElementById('assetSearch')?.value || '').trim(),
  };
}

// ── Filter dropdowns ─────────────────────────────────────────────────────────
// Filled from three DISTINCTs rather than by walking every asset in the page's
// memory, which is why they are now correct even before anything is expanded.
function populateAssetFilters(options) {
  const charSelect   = document.getElementById('assetCharFilter');
  const regionSelect = document.getElementById('assetRegionFilter');
  const corpSelect   = document.getElementById('assetCorpFilter');
  if (!charSelect || !regionSelect) return;

  const prevChar   = charSelect.value;
  const prevRegion = regionSelect.value;
  const prevCorp   = corpSelect?.value || '';

  const fill = (sel, allLabel, entries) => {
    if (!sel) return;
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = ''; all.textContent = allLabel;
    sel.appendChild(all);
    for (const { value, label } of entries) {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = label;
      sel.appendChild(opt);
    }
  };

  fill(charSelect, 'All Characters',
    (options.characters || []).map(c => ({ value: String(c.id), label: c.name })));

  // The "Unresolved" bucket exists so assets whose region never resolved are
  // never invisible — without it they belong to no region and no filter reaches
  // them.
  const regions = (options.regions || []).map(r => ({ value: r, label: r }));
  if (options.unresolvedCount > 0) {
    regions.push({ value: '__unresolved__', label: `(Unresolved — ${options.unresolvedCount})` });
  }
  fill(regionSelect, 'All Regions', regions);
  fill(corpSelect, 'All Corps', (options.corps || []).map(c => ({ value: c, label: c })));

  // Restore previous selections if they still exist.
  if (prevChar   && charSelect.querySelector(`option[value="${CSS.escape(prevChar)}"]`))     charSelect.value   = prevChar;
  if (prevRegion && regionSelect.querySelector(`option[value="${CSS.escape(prevRegion)}"]`)) regionSelect.value = prevRegion;
  if (prevCorp   && corpSelect?.querySelector(`option[value="${CSS.escape(prevCorp)}"]`))    corpSelect.value   = prevCorp;
}

// ── Price staleness ──────────────────────────────────────────────────────────
// Every ISK figure on this page is now materialised, which means it is exactly
// as old as the last price refresh. When prices were fetched live during render
// the question never arose; now the page has to answer it out loud rather than
// present a stored number as though it were current.
//
// Deliberately a label and not a button. Prices refresh on their own — shortly
// after launch and after a sync — and a refresh control here would be pressed
// as though it reloaded the page, which is exactly how RESOLVE NAMES ended up
// being moved into Settings.
function paintValuationAge(meta) {
  const el = document.getElementById('assetPriceAge');
  if (!el) return;

  const at = meta && (meta.prices_updated_at || meta.values_rebuilt_at);
  if (!at) {
    el.textContent = 'Prices not loaded yet';
    el.className = 'asset-price-age is-stale';
    el.title = 'No prices stored yet — they are fetched automatically shortly after launch.';
    return;
  }

  const ageMs = Date.now() - new Date(at).getTime();
  const mins  = Math.round(ageMs / 60_000);
  const when  = mins < 1    ? 'just now'
              : mins < 60   ? `${mins} min ago`
              : mins < 1440 ? `${Math.round(mins / 60)} h ago`
              :               `${Math.round(mins / 1440)} d ago`;
  // A day is the point at which a figure is worth doubting rather than reading.
  const stale = ageMs > 24 * 3_600_000;

  el.textContent = `Prices ${when}`;
  el.className = `asset-price-age${stale ? ' is-stale' : ''}`;
  el.title = `Jita 4-4 and CCP reference prices last refreshed ${new Date(at).toLocaleString()}. `
           + 'Refreshed automatically after launch and after each sync.';
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function loadAssets() {
  const tbody = document.querySelector('#assetTable tbody');
  if (tbody && !tbody.querySelector('tr.asset-loc-header')) {
    tbody.innerHTML = '<tr><td colspan="10" class="loading-row">Loading assets…</td></tr>';
  }

  try {
    const [options, meta] = await Promise.all([
      window.eveAPI.assetsFilterOptions(),
      window.eveAPI.valuationMeta().catch(() => ({})),
    ]);
    populateAssetFilters(options);
    paintValuationAge(meta);
    await renderAssetGroups();
  } catch (err) {
    if (tbody) {
      const row  = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 10;
      cell.className = 'loading-row';
      cell.textContent = `Failed to load assets: ${err.message}`;
      row.appendChild(cell);
      tbody.replaceChildren(row);
    }
    throw err;
  }
}

// ── Filter changes ───────────────────────────────────────────────────────────
// Debounced: every keystroke in the search box would otherwise start a query
// that scans the search column of every asset. 200 ms is below the point where
// typing feels laggy and well above the interval between two keystrokes.
let _assetFilterTimer = null;
function filterAssets() {
  if (_assetFilterTimer) clearTimeout(_assetFilterTimer);
  _assetFilterTimer = setTimeout(() => { renderAssetGroups().catch(() => {}); }, 200);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function _assetTbody() { return document.querySelector('#assetTable tbody'); }

/** Insert nodes directly after a reference row, keeping tree order. */
function _assetInsertAfter(ref, nodes) {
  let at = ref;
  for (const n of nodes) { at.insertAdjacentElement('afterend', n); at = n; }
}

/** Remove rows matching a predicate. Used when a group collapses. */
function _assetRemoveRows(pred) {
  const tbody = _assetTbody();
  if (!tbody) return;
  for (const row of [...tbody.children]) if (pred(row)) row.remove();
}

function _assetSecClass(sec) {
  if (typeof sec !== 'number') return 'sec-unknown';
  if (sec >= 0.5) return 'sec-high';
  if (sec >= 0.1) return 'sec-low';
  return 'sec-null';
}

/** The whole visible page: the summary line and one row per location. */
async function renderAssetGroups() {
  const tbody = _assetTbody();
  if (!tbody) return;

  const token   = ++_assetRenderToken;
  const filters = assetFilters();
  const sort    = window._assetSort;

  const [summary, groups] = await Promise.all([
    window.eveAPI.assetsSummary(filters),
    window.eveAPI.assetsLocationGroups(filters, sort),
  ]);
  if (token !== _assetRenderToken) return;   // a newer render already started

  const el = document.getElementById('assetSummary');
  if (el) {
    if (!summary.totalRows) {
      el.textContent = 'No assets yet — add a character on the Characters page; data syncs automatically.';
    } else {
      const suffix = summary.filtered
        ? ` (filtered from ${summary.totalRows.toLocaleString()})`
        : ' · local DB';
      el.textContent = `${summary.rows.toLocaleString()} assets across `
                     + `${summary.characters} character(s)${suffix} · `
                     + `${_formatAssetIsk(summary.value)} ISK`;
    }
  }

  tbody.innerHTML = '';

  if (!groups.length) {
    const msg = summary.totalRows
      ? 'No assets match the current filters.'
      : 'No assets indexed yet — they are built shortly after a sync completes.';
    tbody.innerHTML = `<tr><td colspan="10" class="loading-row">${escHtml(msg)}</td></tr>`;

    // Nothing indexed at all is very likely an install that synced before this
    // table existed. Ask for it to be built, once, rather than leaving an empty
    // page and no explanation.
    if (!summary.totalRows && !_assetIndexBuildRequested) {
      _assetIndexBuildRequested = true;
      window.eveAPI.valuationRebuild?.()
        .then(r => { if (r && r.indexRows) loadAssets().catch(() => {}); })
        .catch(() => {});
    }
    return;
  }

  const frag = document.createDocumentFragment();
  for (const g of groups) frag.appendChild(_assetLocHeaderRow(g));
  tbody.appendChild(frag);

  _bindAssetCollapse();
  _bindAssetSort();
  _updateAssetSortIndicators();
  initAssetColResize();

  // Re-open whatever was open before this render. Expansion is state, so a sort
  // or a filter change does not close the branch the user was reading.
  for (const g of groups) {
    if (window._assetGroupState[g.loc_key] === true) {
      await _assetExpandLocation(g.loc_key, token);
      if (token !== _assetRenderToken) return;
    }
  }
}

function _assetLocHeaderRow(g) {
  const tr = document.createElement('tr');
  tr.className = 'asset-group-header asset-loc-header';
  tr.dataset.locKey = g.loc_key;

  const secStr   = typeof g.security_status === 'number' ? g.security_status.toFixed(1) : '';
  const subtitle = g.subtitle || [g.solar_system_name, g.region_name].filter(Boolean).join(' · ');
  const count    = g.item_count || 0;

  tr.innerHTML = `
    <td colspan="10" class="asset-group-header-cell">
      <div class="asset-group-inner">
        <span class="asset-group-chevron">▶</span>
        ${secStr ? `<span class="asset-group-sec ${_assetSecClass(g.security_status)}">${secStr}</span>` : ''}
        <span class="asset-group-location">${escHtml(g.loc_label || '')}</span>
        ${subtitle ? `<span class="asset-group-subtitle">· ${escHtml(subtitle)}</span>` : ''}
        <span class="asset-group-spacer"></span>
        <span class="asset-group-count">${count.toLocaleString()} item${count !== 1 ? 's' : ''}</span>
        <span class="asset-group-value asset-loc-value">${g.value > 0 ? `${_formatAssetIsk(g.value)} ISK` : '—'}</span>
      </div>
    </td>`;
  return tr;
}

function _assetCharHeaderRow(locKey, ch) {
  const charKey  = `${locKey}|${ch.character_id}`;
  const portrait = `https://images.evetech.net/characters/${ch.character_id}/portrait?size=32`;
  const count    = ch.item_count || 0;

  const tr = document.createElement('tr');
  tr.className = 'asset-char-header';
  tr.dataset.locKey  = locKey;
  tr.dataset.charKey = charKey;
  tr.dataset.charId  = String(ch.character_id);
  tr.innerHTML = `
    <td colspan="10" class="asset-char-header-cell">
      <div class="asset-char-inner">
        <span class="asset-char-chevron">▶</span>
        <img class="asset-char-portrait" src="${portrait}"
             alt="${escHtml(ch.character_name || '')}" title="${escHtml(ch.character_name || '')}" />
        <span class="asset-char-name">${escHtml(ch.character_name || `Char ${ch.character_id}`)}</span>
        <span class="asset-group-spacer"></span>
        <span class="asset-group-count">${count.toLocaleString()} item${count !== 1 ? 's' : ''}</span>
        <span class="asset-char-value">${ch.value > 0 ? `${_formatAssetIsk(ch.value)} ISK` : '—'}</span>
      </div>
    </td>`;
  return tr;
}

function _assetItemRow(r, ctx) {
  const { locKey, charKey, depth, shipKey, toggleKey, childCount } = ctx;
  const qty      = r.quantity || 1;
  const itemName = r.type_name || `Type ${r.type_id}`;
  const custom   = r.custom_name && r.custom_name !== itemName ? r.custom_name : '';
  const vol      = r.volume != null ? Number(r.volume).toFixed(2) : '—';

  // Blueprints have no /icon on the image server (it 400s) — originals use /bp
  // and copies /bpc. is_bpc is only set for rows that came from the blueprint
  // sync, so the category is the fallback test rather than a bare /icon request
  // the server has already refused.
  const bpcNum      = r.is_bpc == null ? null : Number(r.is_bpc);
  const isBlueprint = bpcNum != null || /blueprint/i.test(r.type_category || '');
  const bpVariant   = bpcNum === 1 ? 'bpc' : (isBlueprint ? 'bp' : null);
  const iconHtml = r.type_id
    ? `<img class="asset-type-icon" src="https://images.evetech.net/types/${r.type_id}/${bpVariant || 'icon'}?size=32" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
    : `<span class="asset-type-icon-placeholder"></span>`;

  const catDisplay = bpcNum === 1 ? 'Blueprint Copy'
                   : bpcNum === 0 ? 'Blueprint Original'
                   : (r.type_category || '');

  // A container is worth what it is carrying. An Asset Safety Wrap's own type is
  // worth nothing while it holds a billion ISK of modules, and that total is
  // exactly the number you need to decide whether to pay to get it back.
  const total     = Number(r.total_value) || 0;
  const contained = Number(r.contained_value) || 0;
  const own       = Number(r.own_value) || 0;
  const priceText = total > 0 ? `${_formatAssetIsk(total)} ISK` : 'N/A';
  const priceCls  = total > 0 ? (contained > 0 ? 'has-price price-contents' : 'has-price') : 'price-na';
  const priceTitle = contained > 0
    ? (own > 0
        ? `${_formatAssetIsk(own)} ISK item + ${_formatAssetIsk(contained)} ISK contents`
        : `${_formatAssetIsk(contained)} ISK of contents`)
    : '';

  const tr = document.createElement('tr');
  tr.className        = 'asset-item-row';
  tr.dataset.locKey   = locKey;
  tr.dataset.charKey  = charKey;
  tr.dataset.typeId   = r.type_id || '';
  tr.dataset.itemId   = r.item_id != null ? String(r.item_id) : '';
  if (shipKey)   tr.dataset.shipKey    = shipKey;    // nested → hides with its ship
  if (toggleKey) tr.dataset.shipToggle = toggleKey;  // this row IS a ship/container

  const indent   = 24 + depth * 18;   // 24px matches the cell's default left pad
  const chevron  = toggleKey ? `<span class="asset-ship-chevron" title="Show/hide contents">▶</span>` : '';
  const contains = childCount > 0
    ? ` <span class="asset-fit-badge" title="${childCount} fitted / contained item${childCount !== 1 ? 's' : ''}">⊞ ${childCount}</span>`
    : '';
  const nameInner = custom
    ? `${escHtml(custom)} <span class="asset-typename-dim">(${escHtml(itemName)})</span>`
    : escHtml(itemName);

  tr.innerHTML = `
    <td class="asset-item-icon-cell"     data-col-key="icon">${iconHtml}</td>
    <td class="asset-item-name-cell"     data-col-key="name" style="padding-left:${indent}px !important;">${chevron}${nameInner}${contains}</td>
    <td class="asset-item-qty-cell"      data-col-key="qty">${qty > 1 ? qty.toLocaleString() : ''}</td>
    <td class="asset-item-group-cell"    data-col-key="group">${escHtml(r.type_group || '')}</td>
    <td class="asset-item-category-cell" data-col-key="category">${escHtml(catDisplay)}</td>
    <td class="asset-item-slot-cell"     data-col-key="slot">${escHtml(r.type_slot || '')}</td>
    <td class="asset-item-vol-cell"      data-col-key="vol">${vol}</td>
    <td class="asset-item-meta-cell"     data-col-key="meta">${r.meta_level != null ? r.meta_level : 'None'}</td>
    <td class="asset-item-tech-cell"     data-col-key="tech">${r.tech_level != null ? r.tech_level : 'None'}</td>
    <td class="asset-item-price-cell ${priceCls}" data-col-key="price"${priceTitle ? ` title="${escHtml(priceTitle)}"` : ''}>${priceText}</td>`;
  return tr;
}

// ── Expanding and collapsing ─────────────────────────────────────────────────
// Expanding fetches; collapsing throws the rows away. That is what keeps the
// DOM proportional to what is on screen rather than to what is owned.

async function _assetExpandLocation(locKey, token = _assetRenderToken) {
  const tbody = _assetTbody();
  if (!tbody) return;
  const header = [...tbody.children].find(
    r => r.classList.contains('asset-loc-header') && r.dataset.locKey === locKey);
  if (!header) return;

  const chars = await window.eveAPI.assetsGroupCharacters(locKey, assetFilters(), window._assetSort);
  if (token !== _assetRenderToken) return;
  // Guard against a double-click having collapsed it while the query was out.
  if (window._assetGroupState[locKey] !== true) return;

  // Idempotent: two fast clicks can leave two expansions in flight for the same
  // location, and both would pass the check above. Clearing first means the
  // second simply repaints rather than inserting the whole group twice.
  _assetRemoveRows(r => r.dataset.locKey === locKey && !r.classList.contains('asset-loc-header'));
  _assetInsertAfter(header, chars.map(ch => _assetCharHeaderRow(locKey, ch)));
  const chev = header.querySelector('.asset-group-chevron');
  if (chev) chev.textContent = '▼';

  for (const ch of chars) {
    if (window._assetCharState[`${locKey}|${ch.character_id}`] === true) {
      await _assetExpandCharacter(locKey, ch.character_id, token);
      if (token !== _assetRenderToken) return;
    }
  }
}

function _assetCollapseLocation(locKey) {
  _assetRemoveRows(r => r.dataset.locKey === locKey && !r.classList.contains('asset-loc-header'));
  const tbody = _assetTbody();
  const header = tbody && [...tbody.children].find(
    r => r.classList.contains('asset-loc-header') && r.dataset.locKey === locKey);
  const chev = header && header.querySelector('.asset-group-chevron');
  if (chev) chev.textContent = '▶';
}

async function _assetExpandCharacter(locKey, charId, token = _assetRenderToken) {
  const tbody = _assetTbody();
  if (!tbody) return;
  const charKey = `${locKey}|${charId}`;
  const header = [...tbody.children].find(
    r => r.classList.contains('asset-char-header') && r.dataset.charKey === charKey);
  if (!header) return;

  const res = await window.eveAPI.assetsGroupItems(locKey, charId, assetFilters(), window._assetSort);
  if (token !== _assetRenderToken) return;
  if (window._assetCharState[charKey] !== true) return;

  const rows = res.rows || [];

  // Nest fitted and contained items under their ship or container. ESI gives a
  // flat list; an item's location_id points at its immediate parent, so a
  // fighter shows under the carrier it is in rather than loose in the hangar.
  const byId = new Map(rows.map(r => [r.item_id, r]));
  const kids = new Map();
  const roots = [];
  for (const r of rows) {
    const parent = r.location_id != null ? byId.get(r.location_id) : null;
    if (parent && parent !== r) {
      if (!kids.has(r.location_id)) kids.set(r.location_id, []);
      kids.get(r.location_id).push(r);
    } else {
      roots.push(r);
    }
  }

  const out  = [];
  const seen = new Set();
  const emit = (r, depth, topKey) => {
    if (seen.has(r.item_id)) return;      // ESI has returned parent cycles
    seen.add(r.item_id);
    const children = kids.get(r.item_id) || [];
    let shipKey = topKey;
    let toggleKey = null;
    if (depth === 0 && children.length) {
      toggleKey = `${charKey}|ship|${r.item_id}`;
      shipKey = null;        // a top-level container header is not hidden by itself
      topKey  = toggleKey;   // but its descendants collapse under this key
    }
    out.push(_assetItemRow(r, { locKey, charKey, depth, shipKey, toggleKey, childCount: children.length }));
    for (const kid of children) emit(kid, depth + 1, topKey);
  };
  for (const r of roots) emit(r, 0, null);

  if (res.truncated) {
    const note = document.createElement('tr');
    note.className = 'asset-item-row asset-truncated-note';
    note.dataset.locKey  = locKey;
    note.dataset.charKey = charKey;
    note.innerHTML = `<td colspan="10" class="loading-row">Showing the ${rows.length.toLocaleString()} most valuable of ${res.total.toLocaleString()} items here — narrow the search to see the rest.</td>`;
    out.push(note);
  }

  // Same idempotence guard as the location level, for the same reason.
  _assetRemoveRows(r => r.dataset.charKey === charKey && !r.classList.contains('asset-char-header'));
  _assetInsertAfter(header, out);
  const chev = header.querySelector('.asset-char-chevron');
  if (chev) chev.textContent = '▼';
  _applyAssetShipVisibility(charKey);
}

function _assetCollapseCharacter(locKey, charId) {
  const charKey = `${locKey}|${charId}`;
  _assetRemoveRows(r => r.dataset.charKey === charKey && !r.classList.contains('asset-char-header'));
  const tbody = _assetTbody();
  const header = tbody && [...tbody.children].find(
    r => r.classList.contains('asset-char-header') && r.dataset.charKey === charKey);
  const chev = header && header.querySelector('.asset-char-chevron');
  if (chev) chev.textContent = '▶';
}

// Ship and container fits are already in the DOM once their character group is
// open — the whole hangar came back in one query — so this level is a show/hide
// rather than a fetch. Inline display:none with !important sits at the top of
// the cascade, where no theme rule or column-reorder pass can override it.
function _applyAssetShipVisibility(charKey) {
  const tbody = _assetTbody();
  if (!tbody) return;
  const open = (k) => window._assetShipState[k] === true;
  for (const row of tbody.querySelectorAll('tr.asset-item-row')) {
    if (charKey && row.dataset.charKey !== charKey) continue;
    if (row.dataset.shipKey) {
      if (open(row.dataset.shipKey)) row.style.removeProperty('display');
      else row.style.setProperty('display', 'none', 'important');
    }
    if (row.dataset.shipToggle) {
      const chev = row.querySelector('.asset-ship-chevron');
      if (chev) chev.textContent = open(row.dataset.shipToggle) ? '▼' : '▶';
    }
  }
}

// One delegated click handler bound once to the table body. It survives every
// re-render (clearing tbody.innerHTML does not drop listeners on tbody itself)
// and any cell reshuffling by the column-reorder system.
function _bindAssetCollapse() {
  const tbody = _assetTbody();
  if (!tbody || tbody._collapseBound) return;
  tbody._collapseBound = true;

  tbody.addEventListener('click', (e) => {
    const shipChev = e.target.closest('.asset-ship-chevron');
    if (shipChev) {
      const row = shipChev.closest('tr.asset-item-row');
      const k   = row && row.dataset.shipToggle;
      if (k) {
        window._assetShipState[k] = !(window._assetShipState[k] === true);
        _applyAssetShipVisibility(row.dataset.charKey);
      }
      return;
    }

    const charH = e.target.closest('tr.asset-char-header');
    if (charH) {
      const k = charH.dataset.charKey;
      const open = !(window._assetCharState[k] === true);
      window._assetCharState[k] = open;
      if (open) _assetExpandCharacter(charH.dataset.locKey, Number(charH.dataset.charId)).catch(() => {});
      else      _assetCollapseCharacter(charH.dataset.locKey, Number(charH.dataset.charId));
      return;
    }

    const locH = e.target.closest('tr.asset-loc-header');
    if (locH) {
      const k = locH.dataset.locKey;
      const open = !(window._assetGroupState[k] === true);
      window._assetGroupState[k] = open;
      if (open) _assetExpandLocation(k).catch(() => {});
      else      _assetCollapseLocation(k);
    }
  });
}

// ── Column sorting ───────────────────────────────────────────────────────────
// Click any header to sort. The sort is applied in SQL, so it orders the whole
// portfolio rather than whatever happened to be loaded: location headers are
// ranked by what they hold, characters within a location likewise, and items
// within a hangar by the chosen column.
//
//   _assetSort.col — column key ('name','qty','price',…) or null for default
//   _assetSort.dir —  1 ascending, -1 descending
// Text columns open ascending (A→Z); numeric columns open descending, matching
// how people expect a "biggest value" column to behave.
if (typeof window._assetSort === 'undefined') window._assetSort = { col: null, dir: 1 };

const _ASSET_COL_TYPE = {
  name: 'text', qty: 'num', group: 'text', category: 'text',
  slot: 'text', vol: 'num', meta: 'num', tech: 'num', price: 'num',
};

function setAssetSort(col) {
  if (!col || col === 'icon') return;
  const s = window._assetSort;
  if (s.col === col) {
    s.dir *= -1;
  } else {
    s.col = col;
    s.dir = (_ASSET_COL_TYPE[col] === 'num') ? -1 : 1;   // num → largest first
  }
  _updateAssetSortIndicators();
  renderAssetGroups().catch(() => {});
}

/** Paint the ▲/▼ caret on the active column header. */
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

// Delegated header sorting, bound once on the thead so it survives the reorder
// and resize systems moving the th nodes around.
//
// A plain 'click' listener does not work: the headers are draggable="true" for
// column reordering, and Chromium suppresses the click whenever the pointer
// moves even a pixel between press and release (it reads as an aborted drag) —
// which is why clicking used to do nothing. So watch mousedown→mouseup and treat
// a near-stationary press on one header as a sort. A real drag moves further and
// fires dragend rather than mouseup, so the two never collide.
function _bindAssetSort() {
  const thead = document.querySelector('#assetTable thead');
  if (!thead || thead._sortBound) return;
  thead._sortBound = true;

  let downTh = null, downX = 0, downY = 0;

  thead.addEventListener('mousedown', (e) => {
    downTh = null;
    if (e.button !== 0) return;                                   // left button only
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

// Kept as no-ops: the table is no longer built in scroll-driven chunks, but the
// wiring that called them lives in other files.
function assetTableScrollHandler() {}
function renderNextAssetChunk() {}

// ── Draggable column resizing ─────────────────────────────────────────────────
//
// Injects a 6 px drag handle at the right edge of every <th> in #assetTable.
// Column widths are persisted to localStorage so they survive page reloads.
// Call once after the table is first rendered; safe to call again (idempotent).
// ─────────────────────────────────────────────────────────────────────────────

const ASSET_COL_STORAGE_KEY = 'assetColWidths';

/** Default column widths in pixels — one per <th>, in document order:
 *  Icon | Name | Qty | Group | Category | Slot | Volume | Meta | Tech | Price
 *
 *  This list had five entries against a ten-column table, left behind when the
 *  extra columns were added. _assetApplyColWidths walks every th, so columns six
 *  to ten were being set to "undefinedpx" — invalid, ignored, and only visible
 *  as the last five columns quietly ignoring a drag. It also broke persistence
 *  outright: a saved array was length-checked against this one, so any width the
 *  user set was thrown away on the next load. Matches the colgroup in
 *  page-assets.html; the two must stay the same length as the header row. */
const ASSET_COL_DEFAULTS = [40, 240, 70, 150, 110, 70, 100, 80, 80, 130];
const ASSET_COL_MIN      = 32;   // px — minimum draggable width

function _assetSaveColWidths(widths) {
  try { localStorage.setItem(ASSET_COL_STORAGE_KEY, JSON.stringify(widths)); } catch (e) {}
}

function _assetLoadColWidths() {
  try {
    const raw = localStorage.getItem(ASSET_COL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Discard widths saved against a different column count — an older layout,
      // or the truncated five-entry list this used to ship with.
      if (Array.isArray(parsed) && parsed.length === ASSET_COL_DEFAULTS.length
          && parsed.every(w => Number.isFinite(w))) return parsed;
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

// Warm the filter dropdowns at startup so the Assets page opens with its
// controls already populated. No ESI call and no asset rows — three DISTINCTs
// against the index, which is the whole cost of this now.
async function prefetchAssetsBackground() {
  try {
    const options = await window.eveAPI.assetsFilterOptions();
    if (options && (options.characters || []).length) populateAssetFilters(options);
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
    // Bounded: the cards (name + balance) come from the local DB and don't need
    // prices — only the asset-value figure does — so a slow/hung price fetch must
    // not hold up the whole grid. A timeout is treated like the existing error
    // path (empty → 0 asset value), which self-corrects on the next render.
    const marketPrices = await Promise.race([
      window.eveAPI.getMarketPrices().catch(() => ({})),
      new Promise(resolve => setTimeout(() => resolve({}), 4000)),
    ]);

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

  // The overview + transactions come from the wallet journal (local DB, fast), so
  // render them as soon as it loads. LP lives on its own tab and its DB-miss
  // fallback hits ESI — load it separately so a slow loyalty fetch can't hold up
  // the journal totals.
  const journalEntries = await loadJournalEntries(characterId);
  renderJournalOverview(journalEntries);
  renderJournalTransactions(journalEntries);
  loadLPData(characterId).then(renderJournalLP).catch(() => {});
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
    const url  = `https://esi.evetech.net/characters/${characterId}/wallet/journal/?datasource=tranquility&page=1`;
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
    const url  = `https://esi.evetech.net/characters/${characterId}/loyalty/points/?datasource=tranquility`;
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