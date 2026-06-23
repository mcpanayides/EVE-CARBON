// ─── map.js ───────────────────────────────────────────────────────────────────
// Galaxy map renderer.  HTML5 Canvas + live ESI overlays.
//
// Overlays
//   security    – dot colour = EVE security status (0.0–1.0 official palette)
//   sovereignty – dot colour = empire faction or player-alliance (hashed HSL)
//   incursions  – highlights CONCORD-infested systems in pink
// Toggle
//   jump bridges – yellow diamond on systems with IHUB (jump-bridge precondition)
//
// Interaction: drag to pan, scroll-wheel to zoom, click to open info panel.

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const _MAP_WORLD = 10000; // normalised coordinate space
const _MIN_ZOOM  = 0.008;
const _MAX_ZOOM  = 8;

// ── Module state ──────────────────────────────────────────────────────────────
let _canvas      = null;
let _ctx         = null;
let _panX        = 0, _panY     = 0;
let _zoom        = 1;
let _dragging    = false;
let _dragSX      = 0, _dragSY  = 0;
let _dragPX      = 0, _dragPY  = 0;
let _hovered     = null;
let _selected    = null;
let _overlay     = 'security';
let _showJb      = true;   // Jump Bridges overlay (saved-bridge arcs + IHUB diamonds) on by default
let _rafPending  = false;
let _loaded      = false;

// Data (populated by initMapPage)
let _systems     = [];        // [{id, name, wx, wz, sec, regionId, factionId}]
let _jumps       = [];        // [{from, to}]
let _sovMap      = {};        // {systemId: {allianceId, factionId, corporationId}}
let _incSet      = new Set();
let _jbSet           = new Set();
let _savedBridges    = [];        // user's saved Ansiblex bridges [[idA,idB],…] drawn as green arcs
let _regions         = {};        // {regionId: name}
let _sysById         = {};        // {systemId: system}  — O(1) lookup

// Region-level sovereignty labels (sovereignty overlay, zoomed out)
let _regionCentroids    = {};   // {regionId: {wx, wz}}
let _regionDomSov       = {};   // {regionId: {label, color, isFaction, entityId}}
let _allianceTickers    = {};   // {allianceId: ticker}  — cached after first fetch

// Pending jump — set by window.mapJumpToSystem before galaxy data is ready
let _pendingJumpSystemId = null;

// Jump route overlay (set by window.mapShowRoute) + "you are here" marker.
let _routeIds        = null;   // ordered [systemId] of a plotted route to highlight
let _pendingRouteIds = null;   // route requested before the galaxy finished loading
let _routeWaypointIds   = new Set(); // subset of _routeIds flagged as manual waypoints (drawn light blue)
let _pendingWaypointIds = null;      // waypoints requested before the galaxy finished loading
// Capital JUMP route — a separate overlay drawn pink with arcs, so it can show at
// the same time as the (light-blue, straight) stargate route.
let _jumpRouteIds          = null;
let _jumpRouteWaypointIds  = new Set();
let _pendingJumpRouteIds   = null;
let _pendingJumpWaypointIds = null;

// Stargate travel route (right-click → set start / destination). Safest path by
// standings, computed over the gate network. Separate from the capital jump planner.
let _travelStart = null;
let _travelEnd   = null;
let _gateAdj     = null;   // id → [neighbour ids], built once from _jumps
let _bridgeAdj   = null;   // id → [neighbour ids] via saved Ansiblex bridges (rebuilt per route)
let _whAdj       = null;   // id → [neighbour ids] via EvE-Scout wormhole connections
let _whConns     = null;   // raw EvE-Scout connection list (metadata for the route table)
let _whLoaded    = false;
let _sgLastPath  = null;   // last Stargate-planner route (for minimise redraw)
let _sgNameIndex = null;   // lowercase system name → id (planner autocomplete)
let _youHereId       = null;   // current character's system id ("you are here")

// ── Official EVE security-status colours ──────────────────────────────────────
function _secColor(sec) {
  if (sec === null || sec === undefined) return '#282828';
  if (sec < -0.9)  return '#282828'; // w-space / j-space
  if (sec <= 0.00) return '#c00000'; // deep null
  if (sec <  0.05) return '#ff0000';
  if (sec <  0.15) return '#d73000';
  if (sec <  0.25) return '#f04800';
  if (sec <  0.35) return '#f06000';
  if (sec <  0.45) return '#d77700';
  if (sec <  0.55) return '#efef00'; // 0.5 boundary — hi-sec starts
  if (sec <  0.65) return '#8fef2f';
  if (sec <  0.75) return '#00f000';
  if (sec <  0.85) return '#00ef47';
  if (sec <  0.95) return '#48f0c0';
  return '#2effff';
}

// ── Faction palette for sovereignty overlay ───────────────────────────────────
const _FACTIONS = {
  500001: '#3a8fc5', // Caldari State
  500002: '#b84c14', // Minmatar Republic
  500003: '#c8a020', // Amarr Empire
  500004: '#28a040', // Gallente Federation
  500005: '#7744bb', // Jove Empire
  500006: '#aaaaaa', // CONCORD Assembly
  500007: '#3070aa', // Ammatar Mandate
  500008: '#a07818', // Khanid Kingdom
  500011: '#8b4a20', // Thukker Tribe
  500015: '#cc2266', // Sansha's Nation
  500016: '#880000', // Blood Raider Covenant
};

function _allianceColor(id) {
  if (!id) return '#111827';
  const h = ((id * 2654435761) >>> 0) % 360;
  return `hsl(${h},62%,42%)`;
}

function _sovColor(sysId) {
  const s = _sovMap[sysId];
  if (!s) return '#111827';
  if (s.factionId && _FACTIONS[s.factionId]) return _FACTIONS[s.factionId];
  return _allianceColor(s.allianceId);
}

// ── Friends & Foes overlay ────────────────────────────────────────────────────
// Colours sov by the main/favourite character's ALLIANCE standings toward the
// holder: your sov teal, +10 dark blue, +5 light blue, −5 orange, −10 red, NPC
// sov grey, other player sov dimmed. Standings loaded lazily via _loadFnfStandings.
let _fnfStandings  = {};     // contactId → standing (alliance contacts)
let _fnfAllianceId = null;   // the main/favourite character's alliance
let _fnfLoaded     = false;
let _fnfError      = null;   // 'reauth' | 'no-alliance' | 'no-char' | message | null

function _fnfColor(sys) {
  if (sys.sec > 0.0 && sys.sec < 0.45) return '#e8d44a';     // low-sec → yellow (no sov here)
  const s = _sovMap[sys.id];
  if (!s) return '#0f1420';                                  // hi-sec / unclaimed null
  if (s.factionId && !s.allianceId) return '#5b6472';        // NPC sov → grey
  if (_fnfAllianceId && s.allianceId === _fnfAllianceId) return '#4ecbb0'; // your sov
  if (s.allianceId != null || s.corporationId != null) {
    let st = _fnfStandings[s.allianceId];
    if (st == null) st = _fnfStandings[s.corporationId];
    if (st != null) {
      if (st >= 10) return '#2e6fdb';   // +10 dark blue
      if (st >= 5)  return '#5a9be8';   // +5  light blue
      if (st <= -10) return '#d0263d';  // −10 red
      if (st <= -5)  return '#e67e22';  // −5  orange
    }
    return '#cfd3db';                   // other player sov → very light grey
  }
  return '#0f1420';
}

// Resolve the main/favourite character and load its alliance-set standings.
async function _loadFnfStandings() {
  _fnfStandings = {}; _fnfAllianceId = null; _fnfError = null;
  try {
    const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
    let favId = null;
    try {
      const favs = JSON.parse(localStorage.getItem('char_favorites') || '[]');
      favId = (Array.isArray(favs) ? favs : []).map(String)
        .find(f => accounts.some(a => String(a.characterId) === f));
    } catch (_) {}
    const cid = favId
      || (typeof selectedCharacterId !== 'undefined' && selectedCharacterId ? selectedCharacterId : null)
      || accounts[0]?.characterId;
    if (!cid) { _fnfError = 'no-char'; return; }
    const data = await window.eveAPI.getCharacterData(cid).catch(() => null);
    _fnfAllianceId = data?.info?.alliance_id || null;
    if (!_fnfAllianceId) { _fnfError = 'no-alliance'; return; }
    const res = await window.eveAPI.getAllianceContacts(cid, _fnfAllianceId);
    if (res && res.ok) {
      _fnfStandings = res.standings || {};
      // Diagnostic: how many contacts at each standing tier (is there any −10 red?).
      const vals = Object.values(_fnfStandings);
      const hist = vals.reduce((m, v) => {
        const k = v >= 10 ? '+10' : v >= 5 ? '+5' : v <= -10 ? '-10' : v <= -5 ? '-5' : 'mid(0)';
        m[k] = (m[k] || 0) + 1; return m;
      }, {});
      console.log(`[FnF] alliance ${_fnfAllianceId}: ${vals.length} contacts; tiers:`, hist);
    } else {
      _fnfError = res?.needsReauth ? 'reauth' : (res?.error || 'unavailable');
    }
  } catch (e) { _fnfError = e.message || 'unavailable'; }
  finally { _fnfLoaded = true; }
}

// ── Coordinate normalisation ──────────────────────────────────────────────────
// Projects EVE 3-D (x, z) coords into a square [0, _MAP_WORLD] world-space.
// K-space (id < 31 000 000) sets the bounding box; wormhole systems may fall
// outside [0, _MAP_WORLD] and appear off-screen at the default zoom — that is
// intentional so the main galaxy always fills the viewport.
function _normalise(raw) {
  const ks = raw.filter(s => s.id < 31000000);
  if (!ks.length) return raw.map(s => ({ ...s, wx: 0, wz: 0 }));

  const xs   = ks.map(s => s.x);
  const zs   = ks.map(s => s.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const range = Math.max(maxX - minX, maxZ - minZ) || 1;
  const scale = _MAP_WORLD / range;
  const ox    = (_MAP_WORLD - (maxX - minX) * scale) / 2;
  const oz    = (_MAP_WORLD - (maxZ - minZ) * scale) / 2;

  // z is negated so that high-z (EVE "north", e.g. Tenal) maps to the top of
  // the canvas and low-z (EVE "south", e.g. Period Basis) maps to the bottom.
  const flat = raw.map(s => ({
    ...s,
    wx: ox + (s.x - minX) * scale,
    wz: oz + (maxZ - s.z) * scale,
  }));

  // Rotate 20° counter-clockwise around the galaxy centre so the map sits
  // like a clock face with Tenal at ~12 and Period Basis at ~7–8.
  const angle = 20 * Math.PI / 180;
  const cosA  = Math.cos(angle);
  const sinA  = Math.sin(angle);
  const cx    = _MAP_WORLD / 2;
  const cz    = _MAP_WORLD / 2;

  return flat.map(s => {
    const dx = s.wx - cx;
    const dz = s.wz - cz;
    return {
      ...s,
      wx: cx + dx * cosA + dz * sinA,
      wz: cz - dx * sinA + dz * cosA,
    };
  });
}

// ── View helpers ──────────────────────────────────────────────────────────────
function _w2c(wx, wz) {
  return [_panX + wx * _zoom, _panY + wz * _zoom];
}

function _c2w(cx, cy) {
  return [(cx - _panX) / _zoom, (cy - _panY) / _zoom];
}

function _fitGalaxy() {
  if (!_canvas) return;
  const pad  = 30;
  const fitZ = Math.min(
    (_canvas.width  - pad * 2) / _MAP_WORLD,
    (_canvas.height - pad * 2) / _MAP_WORLD
  );
  _zoom = fitZ;
  _panX = (_canvas.width  - _MAP_WORLD * fitZ) / 2;
  _panY = (_canvas.height - _MAP_WORLD * fitZ) / 2;
}

function _adjustZoom(factor, cx, cy) {
  const [wx, wz] = _c2w(cx, cy);
  const nz = Math.min(_MAX_ZOOM, Math.max(_MIN_ZOOM, _zoom * factor));
  _panX = cx - wx * nz;
  _panY = cy - wz * nz;
  _zoom = nz;
  _scheduleRender();
}

// ── Hit detection ─────────────────────────────────────────────────────────────
function _hitTest(cx, cy) {
  const thr = 10 / _zoom; // 10 canvas-px in world units
  const [wx, wz] = _c2w(cx, cy);
  const thr2 = thr * thr;
  let best = null, bestD2 = thr2;
  for (const s of _systems) {
    const dx = s.wx - wx, dz = s.wz - wz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = s; }
  }
  return best;
}

// ── Region-level sovereignty labels ───────────────────────────────────────────
// Computed once after systems are normalised; stable until next load.
function _computeRegionCentroids() {
  const groups = {};
  for (const s of _systems) {
    if (!s.regionId || s.id >= 31000000) continue; // skip w-space
    if (!groups[s.regionId]) groups[s.regionId] = { sx: 0, sz: 0, n: 0 };
    groups[s.regionId].sx += s.wx;
    groups[s.regionId].sz += s.wz;
    groups[s.regionId].n++;
  }
  _regionCentroids = {};
  for (const [id, g] of Object.entries(groups)) {
    _regionCentroids[id] = { wx: g.sx / g.n, wz: g.sz / g.n };
  }
}

// Recomputed each time _sovMap updates.
function _computeRegionDomSov() {
  const FACTION_LABELS = {
    500001: 'Caldari',     500002: 'Minmatar',  500003: 'Amarr',
    500004: 'Gallente',    500005: 'Jove',       500006: 'CONCORD',
    500007: 'Ammatar',     500008: 'Khanid',     500011: 'Thukker',
    500015: 'Sansha',      500016: 'Blood Raiders',
  };

  // Tally controlled systems per entity within each region
  const tally = {};  // {regionId: {key: count}}
  const total  = {}; // {regionId: systemCount}

  for (const s of _systems) {
    if (!s.regionId || s.id >= 31000000) continue;
    total[s.regionId] = (total[s.regionId] || 0) + 1;
    const sov = _sovMap[s.id];
    if (!sov) continue;
    const key = sov.factionId  ? `f:${sov.factionId}`
              : sov.allianceId ? `a:${sov.allianceId}`
              : null;
    if (!key) continue;
    if (!tally[s.regionId]) tally[s.regionId] = {};
    tally[s.regionId][key] = (tally[s.regionId][key] || 0) + 1;
  }

  _regionDomSov = {};
  for (const [regionId, counts] of Object.entries(tally)) {
    const regionTotal = total[regionId] || 1;
    let bestKey = null, bestCount = 0;
    for (const [k, c] of Object.entries(counts)) {
      if (c > bestCount) { bestCount = c; bestKey = k; }
    }
    // Only label if dominant entity holds at least 15 % of the region
    if (!bestKey || bestCount < regionTotal * 0.15) continue;

    let label, color, entityId, isFaction = false;
    if (bestKey.startsWith('f:')) {
      const fid = parseInt(bestKey.slice(2), 10);
      isFaction = true;
      label = FACTION_LABELS[fid] || `Faction ${fid}`;
      color = _FACTIONS[fid] || '#aaaaaa';
    } else {
      entityId = parseInt(bestKey.slice(2), 10);
      color    = _allianceColor(entityId);
      // Use cached ticker if available, fall back to placeholder
      label    = _allianceTickers[entityId] || null;
    }

    _regionDomSov[regionId] = { label, color, entityId, isFaction,
                                count: bestCount, total: regionTotal };
  }
}

// Fetch tickers for all player-alliance dominant holders in one pass.
// Skips any IDs already in _allianceTickers.
async function _fetchDomTickers() {
  const needed = [];
  for (const dom of Object.values(_regionDomSov)) {
    if (!dom.isFaction && dom.entityId && !_allianceTickers[dom.entityId]) {
      needed.push(dom.entityId);
    }
  }
  if (!needed.length) return;

  try {
    const result = await window.eveAPI.mapGetAllianceTickers(needed);
    let changed  = false;
    for (const [id, ticker] of Object.entries(result)) {
      _allianceTickers[parseInt(id, 10)] = ticker;
      changed = true;
    }
    if (changed) {
      // Patch in tickers now that we have them, then re-render
      for (const dom of Object.values(_regionDomSov)) {
        if (!dom.isFaction && dom.entityId) {
          dom.label = _allianceTickers[dom.entityId] || dom.label;
        }
      }
      _scheduleRender();
    }
  } catch (e) {
    console.warn('[Map] Ticker fetch failed:', e.message);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function _render() {
  _rafPending = false;
  if (!_canvas || !_ctx || !_systems.length) return;

  const ctx = _ctx;
  const W   = _canvas.width;
  const H   = _canvas.height;

  // Dot radius scales with zoom so systems stay visible when zoomed out
  const dotR  = Math.max(0.7, Math.min(5, _zoom * _MAP_WORLD / 900));
  const lineW = Math.max(0.08, Math.min(1, _zoom * 2.2));
  // System names only appear once zoomed in past this dot radius; below it region
  // names are shown instead. Raised from the old 2.2 so mid-zoom doesn't turn
  // into an unreadable wall of system labels.
  const SYS_LABEL_DOTR = 3.2;

  // Background
  ctx.fillStyle = '#050810';
  ctx.fillRect(0, 0, W, H);

  // ── Jump connections ───────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(38,52,76,0.9)';
  ctx.lineWidth   = lineW;
  for (const j of _jumps) {
    const a = _sysById[j.from], b = _sysById[j.to];
    if (!a || !b) continue;
    const [ax, ay] = _w2c(a.wx, a.wz);
    const [bx, by] = _w2c(b.wx, b.wz);
    // Skip connection if both endpoints are off-screen
    if (ax < -50 && bx < -50) continue;
    if (ax > W+50 && bx > W+50) continue;
    if (ay < -50 && by < -50) continue;
    if (ay > H+50 && by > H+50) continue;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();

  // ── Saved jump-bridge arcs (your Ansiblex / beacon network) ─────────────────
  // Drawn as a green arc bulging off the straight line so two bridges between the
  // same pair (or overlapping gate routes) stay visually distinct. Tied to the
  // "Jump Bridges" toolbar toggle alongside the IHUB diamonds.
  if (_showJb && _savedBridges.length) {
    ctx.lineCap   = 'round';
    ctx.lineWidth = Math.max(1, Math.min(3, _zoom * 3));
    for (const [ida, idb] of _savedBridges) {
      const a = _sysById[ida], b = _sysById[idb];
      if (!a || !b) continue;
      const [ax, ay] = _w2c(a.wx, a.wz);
      const [bx, by] = _w2c(b.wx, b.wz);
      if ((ax < -50 && bx < -50) || (ax > W + 50 && bx > W + 50) ||
          (ay < -50 && by < -50) || (ay > H + 50 && by > H + 50)) continue;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const arcH = Math.min(len * 0.18, 140);          // perpendicular bulge, capped
      const cpx = (ax + bx) / 2 + (-dy / len) * arcH;
      const cpy = (ay + by) / 2 + ( dx / len) * arcH;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cpx, cpy, bx, by);
      ctx.strokeStyle = 'rgba(64,220,130,0.85)';
      ctx.shadowColor = 'rgba(64,220,130,0.55)';
      ctx.shadowBlur  = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#40dc82';
      const nub = Math.max(1.5, _zoom * 2.5);
      for (const [ex, ey] of [[ax, ay], [bx, by]]) {
        ctx.beginPath(); ctx.arc(ex, ey, nub, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.lineCap = 'butt';
  }

  // ── Stargate route (light blue, straight lines) ─────────────────────────────
  if (_routeIds && _routeIds.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(96,200,255,0.95)';
    ctx.lineWidth   = Math.max(1.5, Math.min(4, _zoom * 4));
    ctx.lineCap     = 'round';
    for (let i = 1; i < _routeIds.length; i++) {
      const a = _sysById[_routeIds[i - 1]], b = _sysById[_routeIds[i]];
      if (!a || !b) continue;
      // A wormhole hop jumps to/from a w-space system (Thera, J-space) that sits
      // far off the k-space map — leave a gap rather than shooting a line off-screen.
      if (a.id >= 31000000 || b.id >= 31000000) continue;
      const [ax, ay] = _w2c(a.wx, a.wz);
      const [bx, by] = _w2c(b.wx, b.wz);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // ── Capital jump route (pink, arcs like jump bridges) ───────────────────────
  if (_jumpRouteIds && _jumpRouteIds.length > 1) {
    ctx.lineCap   = 'round';
    ctx.lineWidth = Math.max(1.5, Math.min(4, _zoom * 4));
    for (let i = 1; i < _jumpRouteIds.length; i++) {
      const a = _sysById[_jumpRouteIds[i - 1]], b = _sysById[_jumpRouteIds[i]];
      if (!a || !b) continue;
      const [ax, ay] = _w2c(a.wx, a.wz);
      const [bx, by] = _w2c(b.wx, b.wz);
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const arcH = Math.min(len * 0.18, 140);
      const cpx = (ax + bx) / 2 + (-dy / len) * arcH;
      const cpy = (ay + by) / 2 + ( dx / len) * arcH;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cpx, cpy, bx, by);
      ctx.strokeStyle = 'rgba(240,120,200,0.92)';
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // ── System dots ───────────────────────────────────────────────────────────
  for (const s of _systems) {
    const [cx, cy] = _w2c(s.wx, s.wz);
    const margin = dotR * 4;
    if (cx < -margin || cx > W + margin) continue;
    if (cy < -margin || cy > H + margin) continue;

    // Overlay colour
    let col;
    switch (_overlay) {
      case 'security':    col = _secColor(s.sec); break;
      case 'sovereignty': col = _sovColor(s.id);  break;
      case 'fnf':         col = _fnfColor(s);     break;
      case 'incursions':  col = _incSet.has(s.id) ? '#dd44aa' : '#1c1c28'; break;
      default:            col = _secColor(s.sec);
    }

    // Core dot
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    // Incursion ring (shows on any overlay as a subtle indicator)
    if (_overlay !== 'incursions' && _incSet.has(s.id)) {
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 2.4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(220,60,150,0.5)';
      ctx.lineWidth   = Math.max(0.4, dotR * 0.5);
      ctx.stroke();
    }

    // Jump bridge diamond
    if (_showJb && _jbSet.has(s.id)) {
      const d = dotR * 3;
      ctx.beginPath();
      ctx.moveTo(cx,     cy - d);
      ctx.lineTo(cx + d, cy    );
      ctx.lineTo(cx,     cy + d);
      ctx.lineTo(cx - d, cy    );
      ctx.closePath();
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth   = Math.max(0.5, dotR * 0.55);
      ctx.stroke();
    }

    // Hover ring
    if (_hovered && _hovered.id === s.id) {
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 3.2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth   = Math.max(0.6, dotR * 0.5);
      ctx.stroke();
    }

    // Selected ring
    if (_selected && _selected.id === s.id) {
      ctx.beginPath();
      ctx.arc(cx, cy, dotR * 3.8, 0, Math.PI * 2);
      ctx.strokeStyle = 'var(--accent, #c0392b)';
      ctx.lineWidth   = Math.max(0.8, dotR * 0.65);
      ctx.stroke();
    }

    // System name — only once zoomed in past SYS_LABEL_DOTR (region names show
    // before that), so medium zoom stays readable instead of becoming a mess.
    if (dotR > SYS_LABEL_DOTR) {
      const fs = Math.max(8, Math.min(14, dotR * 3.2));
      ctx.font      = `${fs}px var(--mono, monospace)`;
      ctx.fillStyle = 'rgba(190,205,225,0.72)';
      ctx.fillText(s.name, cx + dotR + 2, cy + dotR);
    }
  }

  // ── Region labels (zoomed out, before system names take over) ───────────────
  // Shown on every overlay so the galaxy stays readable when zoomed out: region
  // names appear from the initial zoom and fade out right as system names appear
  // (dotR → SYS_LABEL_DOTR). The sovereignty overlay additionally shows the
  // dominant alliance ticker and switches earlier (dotR < 2.5).
  const _isSov          = _overlay === 'sovereignty';
  const _regionLabelMax = _isSov ? 2.5 : SYS_LABEL_DOTR;
  if (dotR < _regionLabelMax) {
    // Fade out smoothly as the system-name threshold approaches.
    const fadeSpan = _isSov ? 1.2 : 0.9;
    ctx.globalAlpha  = Math.min(1, (_regionLabelMax - dotR) / fadeSpan);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    for (const [regionId, centroid] of Object.entries(_regionCentroids)) {
      const [lcx, lcy] = _w2c(centroid.wx, centroid.wz);
      // Skip if centroid is off-screen
      if (lcx < -40 || lcx > W + 40 || lcy < -40 || lcy > H + 40) continue;

      const regionName = _regions[regionId] || '';
      const dom        = _isSov ? _regionDomSov[regionId] : null;

      // Font size: larger when more zoomed in (within zoomed-out range)
      const rfs  = Math.max(10, Math.min(14, _zoom * _MAP_WORLD / 85));
      const lfs  = Math.max(11, Math.min(18, _zoom * _MAP_WORLD / 72));
      const gap  = dom ? rfs * 0.7 : 0;

      // Region name — italic, pale
      ctx.font         = `italic ${rfs}px var(--font, sans-serif)`;
      ctx.fillStyle    = 'rgba(170,185,215,0.55)';
      ctx.shadowColor  = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur   = 4;
      ctx.fillText(regionName, lcx, lcy - gap);

      // Dominant sov ticker / name — bold, alliance colour (sovereignty only)
      if (dom && dom.label) {
        ctx.font      = `bold ${lfs}px var(--mono, monospace)`;
        ctx.fillStyle = dom.color;
        ctx.shadowBlur = 5;
        ctx.fillText(dom.label, lcx, lcy + lfs * 0.65);
      }
      ctx.shadowBlur = 0;
    }

    ctx.globalAlpha  = 1;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // ── Route node markers (start/end/waypoints) — drawn for both overlays ──────
  _drawRouteMarkers(ctx, W, H, _routeIds,     _routeWaypointIds,     '#60c8ff', '#9fd4ff', 7, -14); // stargate (blue)
  _drawRouteMarkers(ctx, W, H, _jumpRouteIds, _jumpRouteWaypointIds, '#f078c8', '#ffb0e0', 9,  18); // jump (pink)

  // ── Pending travel endpoints (set, but route not computed / drawn yet) ───────
  for (const [pid, label, col] of [[_travelStart, 'start', '#4ee37a'], [_travelEnd, 'destination', '#e3a84d']]) {
    if (!pid || (_routeIds && _routeIds.includes(pid)) || (_jumpRouteIds && _jumpRouteIds.includes(pid))) continue; // a route already marks it
    const s = _sysById[pid]; if (!s) continue;
    const [cx, cy] = _w2c(s.wx, s.wz);
    if (cx < -30 || cx > W + 30 || cy < -30 || cy > H + 30) continue;
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = col; ctx.font = 'bold 11px var(--mono, monospace)';
    ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
    ctx.fillText(`${s.name} (${label})`, cx, cy - 14);
    ctx.shadowBlur = 0; ctx.textAlign = 'left';
  }

  // ── "You are here" — current character's system ─────────────────────────────
  if (_youHereId && _sysById[_youHereId]) {
    const s = _sysById[_youHereId];
    const [cx, cy] = _w2c(s.wx, s.wz);
    if (cx > -30 && cx < W + 30 && cy > -30 && cy < H + 30) {
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.strokeStyle = '#4ecbb0';
      ctx.lineWidth   = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#4ecbb0';
      ctx.fill();
      ctx.fillStyle   = '#4ecbb0';
      ctx.font        = 'bold 11px var(--mono, monospace)';
      ctx.textAlign   = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
      ctx.fillText('◉ YOU', cx, cy + 18);
      ctx.shadowBlur = 0;
      ctx.textAlign   = 'left';
    }
  }
}

// Draw start/end/waypoint markers for a route overlay in the given colours.
// endR / labelDy let the two overlays nest (pink ring outside blue) and stagger
// their labels so a shared start/end isn't an unreadable overlap.
function _drawRouteMarkers(ctx, W, H, ids, wpSet, endCol, wpCol, endR, labelDy) {
  if (!ids || !ids.length) return;
  endR = endR || 7;
  labelDy = (labelDy == null) ? -14 : labelDy;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ids.forEach((id, i) => {
    const s = _sysById[id]; if (!s) return;
    const [cx, cy] = _w2c(s.wx, s.wz);
    if (cx < -30 || cx > W + 30 || cy < -30 || cy > H + 30) return;
    const isEnd = (i === 0 || i === ids.length - 1);
    const isWaypoint = !isEnd && wpSet && wpSet.has(id);
    ctx.beginPath();
    ctx.arc(cx, cy, isEnd ? endR : (isWaypoint ? 6 : 4.5), 0, Math.PI * 2);
    if (isWaypoint) { ctx.fillStyle = wpCol; ctx.fill(); ctx.strokeStyle = wpCol; }
    else            { ctx.strokeStyle = endCol; }
    ctx.lineWidth = 2;
    ctx.stroke();
    if (isEnd || isWaypoint) {
      ctx.fillStyle   = isWaypoint ? wpCol : endCol;
      ctx.font        = 'bold 11px var(--mono, monospace)';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
      ctx.fillText(isEnd ? `${s.name} (${i === 0 ? 'start' : 'end'})` : `${s.name} (waypoint)`, cx, cy + labelDy);
      ctx.shadowBlur = 0;
    }
  });
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

function _scheduleRender() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(_render);
}

// ── Info panel ────────────────────────────────────────────────────────────────
async function _showInfo(system) {
  _selected = system;
  const panel  = document.getElementById('mapInfoPanel');
  const nameEl = document.getElementById('mapInfoSystemName');
  const bodyEl = document.getElementById('mapInfoBody');
  if (!panel || !nameEl || !bodyEl) return;

  nameEl.textContent = system.name;

  const regionName = _regions[system.regionId] || `Region ${system.regionId}`;
  const sov        = _sovMap[system.id];
  const incursion  = _incSet.has(system.id);
  const jb         = _jbSet.has(system.id);
  const secColor   = _secColor(system.sec);
  const secDisplay = system.sec !== null ? system.sec.toFixed(1) : '—';

  // Sovereignty label (async — will update once alliance name resolves)
  let sovHtml = '<span style="color:var(--text-3);">None</span>';
  if (sov) {
    if (sov.factionId && _FACTIONS[sov.factionId]) {
      const names = {
        500001: 'Caldari State',  500002: 'Minmatar Republic',
        500003: 'Amarr Empire',   500004: 'Gallente Federation',
        500005: 'Jove Empire',    500006: 'CONCORD Assembly',
        500007: 'Ammatar Mandate',500008: 'Khanid Kingdom',
        500011: 'Thukker Tribe',  500015: "Sansha's Nation",
        500016: 'Blood Raider Covenant',
      };
      const col  = _FACTIONS[sov.factionId];
      const name = names[sov.factionId] || `Faction ${sov.factionId}`;
      sovHtml = `<span style="color:${col};">${name}</span>`;
    } else if (sov.allianceId) {
      const col = _allianceColor(sov.allianceId);
      sovHtml = `<span style="color:${col};" data-alliance-id="${sov.allianceId}">
                   Alliance ${sov.allianceId}
                 </span>`;
    }
  }

  // Your alliance's standing toward this system's sov holder (Friends & Foes data).
  let standingHtml = '<span style="color:var(--text-3);">—</span>';
  if (sov && (sov.allianceId != null || sov.corporationId != null)) {
    if (_fnfAllianceId && sov.allianceId === _fnfAllianceId) {
      standingHtml = '<span style="color:#4ecbb0;">Your alliance</span>';
    } else {
      let st = _fnfStandings[sov.allianceId];
      if (st == null) st = _fnfStandings[sov.corporationId];
      if (st != null) {
        const c = st >= 10 ? '#2e6fdb' : st >= 5 ? '#5a9be8' : st <= -10 ? '#d0263d' : st <= -5 ? '#e67e22' : 'var(--text-3)';
        standingHtml = `<span style="color:${c};">${st > 0 ? '+' : ''}${st}</span>`;
      } else {
        standingHtml = `<span style="color:var(--text-3);">${_fnfLoaded ? 'Not set (neutral)' : 'open Friends & Foes to load'}</span>`;
      }
    }
  }

  bodyEl.innerHTML = `
    <div class="map-info-row">
      <span class="map-info-label">REGION</span>
      <span class="map-info-value">${regionName}</span>
    </div>
    <div class="map-info-row">
      <span class="map-info-label">SECURITY</span>
      <span class="map-info-value" style="color:${secColor};">${secDisplay}</span>
    </div>
    <div class="map-info-row">
      <span class="map-info-label">SOVEREIGNTY</span>
      <span class="map-info-value">${sovHtml}</span>
    </div>
    <div class="map-info-row">
      <span class="map-info-label">STANDING</span>
      <span class="map-info-value">${standingHtml}</span>
    </div>
    <div class="map-info-row">
      <span class="map-info-label">INCURSION</span>
      <span class="map-info-value" style="color:${incursion ? '#dd44aa' : 'var(--text-3)'};">
        ${incursion ? '⚠ Active' : 'None'}
      </span>
    </div>
    <div class="map-info-row">
      <span class="map-info-label">JUMP BRIDGE</span>
      <span class="map-info-value" style="color:${jb ? '#ffd700' : 'var(--text-3)'};">
        ${jb ? '◈ IHUB Present' : 'None'}
      </span>
    </div>
    <div class="map-info-row">
      <span class="map-info-label">SYSTEM ID</span>
      <span class="map-info-value" style="color:var(--text-3);">${system.id}</span>
    </div>
  `;

  panel.style.display = 'flex';
  _scheduleRender();

  // Resolve alliance name asynchronously and update label
  if (sov && sov.allianceId && !sov.factionId) {
    try {
      const names = await window.eveAPI.getNames([sov.allianceId]);
      const aliName = names && names[0] && names[0].name;
      if (aliName) {
        const el = bodyEl.querySelector(`[data-alliance-id="${sov.allianceId}"]`);
        if (el) el.textContent = aliName;
      }
    } catch (_) { /* name resolution is best-effort */ }
  }
}

function mapCloseInfo() {
  _selected = null;
  const panel = document.getElementById('mapInfoPanel');
  if (panel) panel.style.display = 'none';
  _scheduleRender();
}

// ── Legend ────────────────────────────────────────────────────────────────────
function _updateLegend() {
  const el = document.getElementById('mapLegend');
  if (!el) return;

  const dot = (col) => `<span class="map-legend-dot" style="background:${col}"></span>`;

  if (_overlay === 'security') {
    el.innerHTML = `
      <div class="map-legend-title">SECURITY STATUS</div>
      <div class="map-legend-row">${dot('#2effff')} 1.0 Hi-Sec</div>
      <div class="map-legend-row">${dot('#48f0c0')} 0.9</div>
      <div class="map-legend-row">${dot('#00f000')} 0.7</div>
      <div class="map-legend-row">${dot('#efef00')} 0.5</div>
      <div class="map-legend-row">${dot('#d77700')} 0.4 Lo-Sec</div>
      <div class="map-legend-row">${dot('#c00000')} 0.0 Null-Sec</div>
      <div class="map-legend-row">${dot('#282828')} W-Space</div>`;
  } else if (_overlay === 'sovereignty') {
    el.innerHTML = `
      <div class="map-legend-title">SOVEREIGNTY</div>
      <div class="map-legend-row">${dot('#3a8fc5')} Caldari State</div>
      <div class="map-legend-row">${dot('#c8a020')} Amarr Empire</div>
      <div class="map-legend-row">${dot('#28a040')} Gallente Fed.</div>
      <div class="map-legend-row">${dot('#b84c14')} Minmatar Rep.</div>
      <div class="map-legend-row">${dot('#4466aa')} Player Alliance</div>
      <div class="map-legend-row">${dot('#111827')} Unclaimed</div>`;
  } else if (_overlay === 'incursions') {
    el.innerHTML = `
      <div class="map-legend-title">INCURSIONS</div>
      <div class="map-legend-row">${dot('#dd44aa')} Infested System</div>
      <div class="map-legend-row">${dot('#1c1c28')} Clear</div>`;
  } else if (_overlay === 'fnf') {
    const note = _fnfError === 'reauth'
      ? `<div class="map-legend-row" style="color:#e6a23c;">⚠ Sync &amp; re-auth a char for standings</div>`
      : (_fnfError === 'no-alliance' ? `<div class="map-legend-row" style="color:var(--text-3);">No alliance on your character</div>` : '');
    el.innerHTML = `
      <div class="map-legend-title">FRIENDS &amp; FOES</div>
      <div class="map-legend-row">${dot('#4ecbb0')} Your sov</div>
      <div class="map-legend-row">${dot('#2e6fdb')} +10 blue</div>
      <div class="map-legend-row">${dot('#5a9be8')} +5 blue</div>
      <div class="map-legend-row">${dot('#e67e22')} −5 orange</div>
      <div class="map-legend-row">${dot('#d0263d')} −10 red</div>
      <div class="map-legend-row">${dot('#e8d44a')} Low-sec</div>
      <div class="map-legend-row">${dot('#5b6472')} NPC sov</div>
      <div class="map-legend-row">${dot('#cfd3db')} Other sov</div>
      ${note}`;
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
function _initSearch() {
  const input   = document.getElementById('mapSearchInput');
  const results = document.getElementById('mapSearchResults');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.style.display = 'none'; return; }

    const matches = _systems
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 12);

    if (!matches.length) { results.style.display = 'none'; return; }

    results.innerHTML = matches
      .map(s => `<div class="map-search-item" data-sid="${s.id}">${s.name}</div>`)
      .join('');
    results.style.display = 'block';
  });

  results.addEventListener('click', e => {
    const item = e.target.closest('[data-sid]');
    if (!item) return;
    const sys = _sysById[parseInt(item.dataset.sid, 10)];
    if (!sys) return;
    input.value            = sys.name;
    results.style.display  = 'none';
    _flyTo(sys);
    _showInfo(sys);
  });

  // Close results when clicking elsewhere
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !results.contains(e.target)) {
      results.style.display = 'none';
    }
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      results.style.display = 'none';
      input.blur();
    }
  });
}

function _flyTo(system) {
  if (!_canvas) return;
  const targetZoom = Math.max(_zoom, 0.5);
  // Centre on the system at targetZoom
  _zoom = targetZoom;
  const [cx, cy] = _w2c(system.wx, system.wz);
  _panX += _canvas.width  / 2 - cx;
  _panY += _canvas.height / 2 - cy;
  _scheduleRender();
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function _initToolbar() {
  document.querySelectorAll('.map-overlay-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.map-overlay-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _overlay = btn.dataset.overlay;
      // Friends & Foes needs the alliance standings — load them on first use, then redraw.
      if (_overlay === 'fnf' && !_fnfLoaded) {
        _loadFnfStandings().then(() => { _updateLegend(); _scheduleRender(); });
      }
      _updateLegend();
      _scheduleRender();
    });
  });

  const jbBtn = document.getElementById('mapJbToggle');
  if (jbBtn) {
    jbBtn.classList.toggle('active', _showJb);   // reflect the default-on state
    jbBtn.addEventListener('click', () => {
      _showJb = !_showJb;
      if (_showJb) _loadSavedBridges();   // pick up any newly imported bridges
      jbBtn.classList.toggle('active', _showJb);
      _scheduleRender();
    });
  }

  const zoomIn  = document.getElementById('mapZoomIn');
  const zoomOut = document.getElementById('mapZoomOut');
  const zoomFit = document.getElementById('mapZoomFit');
  if (zoomIn)  zoomIn.addEventListener('click',  () => _adjustZoom(1.45, _canvas.width/2, _canvas.height/2));
  if (zoomOut) zoomOut.addEventListener('click', () => _adjustZoom(1/1.45, _canvas.width/2, _canvas.height/2));
  if (zoomFit) zoomFit.addEventListener('click', () => { _fitGalaxy(); _scheduleRender(); });

  const refreshBtn = document.getElementById('mapRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled  = true;
      refreshBtn.style.opacity = '0.45';
      await _loadLiveData();
      // Re-pull alliance standings too (e.g. after a re-auth granted the scope).
      _fnfLoaded = false;
      if (_overlay === 'fnf') { await _loadFnfStandings(); _updateLegend(); _scheduleRender(); }
      // Refresh EvE-Scout wormhole connections (they spawn/die constantly).
      if (_whLoaded) { _whLoaded = false; await _loadWormholes(); }
      refreshBtn.disabled  = false;
      refreshBtn.style.opacity = '';
    });
  }
}

// ── Canvas setup ──────────────────────────────────────────────────────────────
function _initCanvas() {
  _canvas = document.getElementById('mapCanvas');
  if (!_canvas) return;
  _ctx = _canvas.getContext('2d');

  const vp = document.getElementById('mapViewport');
  if (vp) new ResizeObserver(() => _onResize()).observe(vp);

  // Pan (drag)
  _canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    _dragging = true;
    _dragSX = e.clientX; _dragSY = e.clientY;
    _dragPX = _panX;     _dragPY = _panY;
    _canvas.style.cursor = 'grabbing';
  });

  _canvas.addEventListener('mousemove', e => {
    const rect = _canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (_dragging) {
      _panX = _dragPX + (e.clientX - _dragSX);
      _panY = _dragPY + (e.clientY - _dragSY);
      _scheduleRender();
      return;
    }

    const prev = _hovered;
    _hovered = _hitTest(cx, cy);
    _canvas.style.cursor = _hovered ? 'pointer' : 'grab';
    if (_hovered?.id !== prev?.id) _scheduleRender();

    // Floating tooltip
    const tip = document.getElementById('mapTooltip');
    if (tip) {
      if (_hovered) {
        tip.textContent  = _hovered.name;
        tip.style.left   = (e.clientX + 14) + 'px';
        tip.style.top    = (e.clientY - 10) + 'px';
        tip.style.display = 'block';
      } else {
        tip.style.display = 'none';
      }
    }
  });

  _canvas.addEventListener('mouseup', e => {
    if (!_dragging) return;
    const moved = Math.abs(e.clientX - _dragSX) + Math.abs(e.clientY - _dragSY);
    _dragging = false;
    _canvas.style.cursor = _hovered ? 'pointer' : 'grab';

    if (moved < 5) {
      // Treat as click — toggle info panel
      const rect = _canvas.getBoundingClientRect();
      const sys  = _hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (sys) {
        _showInfo(sys);
      } else {
        _selected = null;
        const p = document.getElementById('mapInfoPanel');
        if (p) p.style.display = 'none';
        _scheduleRender();
      }
    }
  });

  _canvas.addEventListener('mouseleave', () => {
    _dragging = false;
    _hovered  = null;
    _canvas.style.cursor = 'grab';
    const tip = document.getElementById('mapTooltip');
    if (tip) tip.style.display = 'none';
    _scheduleRender();
  });

  // Right-click a system → map context menu (set travel start/destination; and,
  // when a capital jump route is plotted, an entry into the jump-planner options).
  _canvas.addEventListener('contextmenu', e => {
    const rect = _canvas.getBoundingClientRect();
    const sys  = _hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (!sys) return;                       // empty space → keep the default menu
    e.preventDefault();
    _showMapMenu(sys, e.clientX, e.clientY);
  });

  // Zoom (scroll wheel)
  _canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect   = _canvas.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    _adjustZoom(factor, cx, cy);
  }, { passive: false });

  _canvas.style.cursor = 'grab';
}

function _onResize() {
  if (!_canvas) return;
  const vp = document.getElementById('mapViewport');
  if (!vp) return;
  const rect  = vp.getBoundingClientRect();
  const prevW = _canvas.width, prevH = _canvas.height;
  _canvas.width  = Math.floor(rect.width)  || 300;
  _canvas.height = Math.floor(rect.height) || 300;

  if (!_loaded || prevW === 0 || prevH === 0) {
    _fitGalaxy();
  } else {
    // Keep the galaxy centre stable across resize
    _panX += (_canvas.width  - prevW) / 2;
    _panY += (_canvas.height - prevH) / 2;
  }
  _scheduleRender();
}

// ── Live ESI data ─────────────────────────────────────────────────────────────
async function _loadLiveData() {
  const [sovR, incR, jbR] = await Promise.allSettled([
    window.eveAPI.mapGetSovereignty(),
    window.eveAPI.mapGetIncursions(),
    window.eveAPI.mapGetJumpBridges(),
  ]);
  if (sovR.status === 'fulfilled') _sovMap = sovR.value || {};
  if (incR.status === 'fulfilled') _incSet = new Set(incR.value || []);
  if (jbR.status  === 'fulfilled') _jbSet  = new Set(jbR.value  || []);

  // Recompute region dominant holders then fetch tickers (async, re-renders when done)
  _computeRegionDomSov();
  _scheduleRender();
  _fetchDomTickers(); // background — patches labels in once tickers arrive
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Called by app.js / ui.js when the user navigates to the map page.
// Idempotent — second+ calls just re-render without reloading galaxy data.
// Read the user's saved Ansiblex bridges (shared localStorage key with the Jump
// Planner / settings importer). Called on map entry, on toggling the overlay on,
// and via window.mapReloadBridges() after an import so the arcs update live.
async function _loadSavedBridges() {
  try {
    const b = await window.eveAPI.getJumpBridges() || [];
    _savedBridges = Array.isArray(b)
      ? b.filter(p => Array.isArray(p) && p.length === 2).map(p => [Number(p[0]), Number(p[1])])
      : [];
  } catch (_) { _savedBridges = []; }
  if (_loaded) _scheduleRender();
}
window.mapReloadBridges = function () { _loadSavedBridges(); };

// ── Stargate travel route (safest by standings) ───────────────────────────────
// Right-click → "Set as start" / "Set as destination". Computes the safest gate
// route preferring (cheapest→dearest): your sov / hi-sec, +5/+10 blue, neutral &
// NPC sov, low-sec, then −5 / −10 red only as a last resort. Works hi↔low↔null.
function _ensureGateAdj() {
  if (_gateAdj) return;
  _gateAdj = new Map();
  for (const j of _jumps) {
    if (!_gateAdj.has(j.from)) _gateAdj.set(j.from, []);
    _gateAdj.get(j.from).push(j.to);
  }
}

// Bidirectional adjacency from the saved Ansiblex bridges. Rebuilt per route so it
// always reflects the current network. A bridge hop is one jump that skips the
// gate distance — the router takes it whenever it beats burning gates.
function _buildBridgeAdj() {
  _bridgeAdj = new Map();
  for (const pair of _savedBridges) {
    const a = pair[0], b = pair[1];
    if (!_bridgeAdj.has(a)) _bridgeAdj.set(a, []);
    if (!_bridgeAdj.has(b)) _bridgeAdj.set(b, []);
    _bridgeAdj.get(a).push(b);
    _bridgeAdj.get(b).push(a);
  }
}

// EvE-Scout wormhole connections (Thera/Turnur) as bidirectional 1-jump edges.
// Loaded once per session; reload via window.mapReloadWormholes() to refresh.
async function _loadWormholes() {
  if (_whLoaded) return;
  try { _whConns = await window.eveAPI.getEveScoutConnections() || []; }
  catch (_) { _whConns = []; }
  _whAdj = new Map();
  for (const c of _whConns) {
    if (!_sysById[c.inId] || !_sysById[c.outId]) continue;
    if (!_whAdj.has(c.inId))  _whAdj.set(c.inId, []);
    if (!_whAdj.has(c.outId)) _whAdj.set(c.outId, []);
    _whAdj.get(c.inId).push(c.outId);
    _whAdj.get(c.outId).push(c.inId);
  }
  _whLoaded = true;
}
window.mapReloadWormholes = function () { _whLoaded = false; return _loadWormholes(); };

// Per-system safety cost (lower = preferred). Uses the Friends & Foes standings.
function _travelSafetyCost(sys) {
  const sec = sys.sec;
  if (sec >= 0.45) return 1;                       // hi-sec — safe to travel
  const s = _sovMap[sys.id];
  if (s) {                                         // null-sec sov
    if (_fnfAllianceId && s.allianceId === _fnfAllianceId) return 1;   // your sov
    let st = (s.allianceId != null) ? _fnfStandings[s.allianceId] : null;
    if (st == null && s.corporationId != null) st = _fnfStandings[s.corporationId];
    if (st != null) {
      if (st >= 5)   return 2;     // blue (+5 / +10)
      if (st <= -10) return 100;   // red — last resort
      if (st <= -5)  return 50;    // orange
    }
    return 6;                      // neutral / NPC sov
  }
  if (sec > 0.0 && sec < 0.45) return 10;          // low-sec
  return 6;                                        // unclaimed / NPC null
}

// Min-heap for Dijkstra.
function _mapHeap() {
  const a = [];
  return {
    size: () => a.length,
    push(c, id) { a.push([c, id]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } },
    pop() { const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; },
  };
}

// Core gate pathfinder, shared by the right-click route and the Stargate Planner.
// opts: { mode:'safest'|'shortest', avoidLow, avoidNull, avoidRed }. Returns the
// ordered system-id path, or null if unreachable. Endpoints are never filtered out.
function _travelRoutePath(startId, endId, opts = {}) {
  if (!_sysById[startId] || !_sysById[endId]) return null;
  _ensureGateAdj();
  const { mode = 'safest', avoidLow = false, avoidNull = false, avoidRed = false, useBridges = false, useWormholes = false } = opts;
  if (useBridges) _buildBridgeAdj();

  const dist = new Map(), prev = new Map(), done = new Set();
  const heap = _mapHeap();
  dist.set(startId, 0); heap.push(0, startId);
  while (heap.size()) {
    const [d, id] = heap.pop();
    if (done.has(id)) continue;
    done.add(id);
    if (id === endId) break;
    // Gates + (optionally) Ansiblex bridges form one network — the router picks
    // the cheapest mix, so a bridge replaces a long gate burn when it's listed.
    const neighbours = (_gateAdj.get(id) || [])
      .concat(useBridges   && _bridgeAdj ? (_bridgeAdj.get(id) || []) : [])
      .concat(useWormholes && _whAdj     ? (_whAdj.get(id)     || []) : []);
    for (const to of neighbours) {
      if (done.has(to)) continue;
      const toSys = _sysById[to];
      if (!toSys) continue;
      if (to !== endId) {
        if (avoidLow  && toSys.sec > 0.0 && toSys.sec < 0.45) continue;
        if (avoidNull && toSys.sec <= 0.0) continue;
        if (avoidRed  && _travelSafetyCost(toSys) >= 50) continue;
      }
      const nd = d + (mode === 'shortest' ? 1 : _travelSafetyCost(toSys));
      if (nd < (dist.has(to) ? dist.get(to) : Infinity)) {
        dist.set(to, nd); prev.set(to, id); heap.push(nd, to);
      }
    }
  }
  if (!prev.has(endId) && startId !== endId) return null;
  const path = [endId];
  let cur = endId;
  while (cur !== startId) { const p = prev.get(cur); if (p == null) break; path.unshift(p); cur = p; }
  return path;
}

async function _computeTravelRoute() {
  if (!_travelStart || !_travelEnd) return;
  if (!_fnfLoaded) await _loadFnfStandings();   // so blue/red weighting applies
  const path = _travelRoutePath(_travelStart, _travelEnd, { mode: 'safest', useBridges: true });
  if (!path) {
    if (typeof showToast === 'function') showToast('No gate route found between those systems.', 'error');
    return;
  }
  if (typeof window.mapShowRoute === 'function') window.mapShowRoute(path);
  if (typeof showToast === 'function') showToast(`Safest route: ${path.length - 1} jumps.`, 'success');
}

// Push the map's start/destination into BOTH planners so the same selection drives
// a capital jump plan and a sub-cap stargate plan (each auto-plots on open).
function _pushEndpointsToPlanners() {
  if (typeof window.jpSetEndpoints === 'function') window.jpSetEndpoints(_travelStart, _travelEnd);
  // Also draw the capital jump route (pink arcs) so both plots show together — no
  // need to open the Jump Planner first. (Won't fit the view; the stargate route does.)
  if (_travelStart && _travelEnd && typeof window.jpPlotToMap === 'function') {
    window.jpPlotToMap(_travelStart, _travelEnd);
  }
  const sg = document.getElementById('stargatePlannerModal');
  if (sg && sg.style.display !== 'none') {
    if (_travelStart && _sysById[_travelStart]) sg.querySelector('#sgFrom').value = _sysById[_travelStart].name;
    if (_travelEnd   && _sysById[_travelEnd])   sg.querySelector('#sgTo').value   = _sysById[_travelEnd].name;
    if (_travelStart && _travelEnd) _sgPlot();
  }
}

// Sov / standing label + colour for a system (Stargate Planner route table).
function _travelSovLabel(s) {
  if (s.sec >= 0.45) return { color: '#9fd4ff', label: 'hi-sec' };
  const sv = _sovMap[s.id];
  if (sv) {
    if (_fnfAllianceId && sv.allianceId === _fnfAllianceId) return { color: '#4ecbb0', label: 'your sov' };
    let st = (sv.allianceId != null) ? _fnfStandings[sv.allianceId] : null;
    if (st == null && sv.corporationId != null) st = _fnfStandings[sv.corporationId];
    if (st != null) {
      if (st >= 5)   return { color: st >= 10 ? '#2e6fdb' : '#5a9be8', label: `blue +${st}` };
      if (st <= -10) return { color: '#d0263d', label: `red ${st}` };
      if (st <= -5)  return { color: '#e67e22', label: `red ${st}` };
    }
    if (sv.factionId && !sv.allianceId) return { color: '#5b6472', label: 'NPC sov' };
    return { color: '#cfd3db', label: 'neutral sov' };
  }
  if (s.sec > 0.0 && s.sec < 0.45) return { color: '#e8d44a', label: 'low-sec' };
  return { color: '#6b7280', label: 'null' };
}

// ── Map context menu ──────────────────────────────────────────────────────────
function _closeMapMenu() { const m = document.getElementById('mapCtxMenu'); if (m) m.remove(); }
function _mapMenuOutside(e) {
  const m = document.getElementById('mapCtxMenu');
  if (!m) return;
  if (m.contains(e.target)) document.addEventListener('click', _mapMenuOutside, { once: true });
  else _closeMapMenu();
}

function _showMapMenu(sys, x, y) {
  _closeMapMenu();
  const esc = (typeof escHtml === 'function') ? escHtml : (s => s);
  const btn = (act, label, color) =>
    `<button class="map-ctx" data-act="${act}" style="display:block;width:100%;text-align:left;background:none;border:none;border-top:1px solid var(--border);color:${color || 'var(--text-1)'};padding:8px 12px;cursor:pointer;font-family:var(--mono,monospace);font-size:12px;">${label}</button>`;

  let body = `<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-weight:700;font-family:var(--mono,monospace);font-size:12px;color:var(--text-1);">📍 ${esc(sys.name)}</div>`;
  body += btn('start', '📍 Set as start');
  body += btn('end',   '🏁 Set as destination');
  if (_travelStart || _travelEnd || _routeIds || _jumpRouteIds) body += btn('clear', '✕ Clear routes', '#e05252');
  if (window.jpHasActiveRoute && window.jpHasActiveRoute()) body += btn('jump', '⤓ Jump route options…');

  const menu = document.createElement('div');
  menu.id = 'mapCtxMenu';
  menu.style.cssText = 'position:fixed;z-index:10060;min-width:210px;background:var(--bg-card);'
    + 'border:1px solid var(--accent);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,0.6);overflow:hidden;';
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.innerHTML  = body;
  document.body.appendChild(menu);

  const r = menu.getBoundingClientRect();
  if (r.right  > window.innerWidth)  menu.style.left = Math.max(8, window.innerWidth  - r.width  - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top  = Math.max(8, window.innerHeight - r.height - 8) + 'px';

  menu.querySelectorAll('.map-ctx').forEach(b => {
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-deep)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'none'; });
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      _closeMapMenu();
      if (act === 'start') {
        _travelStart = sys.id;
        if (typeof showToast === 'function') showToast(`Start: ${sys.name}`, 'success');
        _pushEndpointsToPlanners();
        if (_travelEnd) _computeTravelRoute(); else _scheduleRender();
      } else if (act === 'end') {
        _travelEnd = sys.id;
        if (typeof showToast === 'function') showToast(`Destination: ${sys.name}`, 'success');
        _pushEndpointsToPlanners();
        if (_travelStart) _computeTravelRoute(); else _scheduleRender();
      } else if (act === 'clear') {
        _travelStart = _travelEnd = null;
        _routeIds = null; _routeWaypointIds = new Set();
        _jumpRouteIds = null; _jumpRouteWaypointIds = new Set();
        _scheduleRender();
        if (typeof showToast === 'function') showToast('Routes cleared.', 'info');
      } else if (act === 'jump' && window.jpHandleMapRightClick) {
        window.jpHandleMapRightClick(sys.id, x, y);
      }
    });
  });

  setTimeout(() => document.addEventListener('click', _mapMenuOutside, { once: true }), 0);
}

// ── Stargate Route Planner (modal) ────────────────────────────────────────────
// A From→To planner for regular sub-cap stargate travel, mirroring the Jump
// Planner. Routes safest-by-standings (or shortest), with avoid toggles, and a
// "show / centre on map" button.
function openStargatePlanner() {
  let modal = document.getElementById('stargatePlannerModal');
  if (!modal) { modal = _sgBuildModal(); document.body.appendChild(modal); }
  modal.style.display = 'flex';
  const pill = document.getElementById('sgRestorePill');
  if (pill) pill.style.display = 'none';
  _sgPopulateDatalist();
  if (!_fnfLoaded) _loadFnfStandings();   // load standings so safest weighting works
  // Pre-fill From/To from a start/destination set on the map, and auto-plot.
  const f = document.getElementById('sgFrom'), t = document.getElementById('sgTo');
  if (_travelStart && _sysById[_travelStart] && f) f.value = _sysById[_travelStart].name;
  if (_travelEnd   && _sysById[_travelEnd]   && t) t.value = _sysById[_travelEnd].name;
  if (f && t && f.value && t.value) _sgPlot();
}

function _sgClose()    { const m = document.getElementById('stargatePlannerModal'); if (m) m.style.display = 'none'; const p = document.getElementById('sgRestorePill'); if (p) p.style.display = 'none'; }
function _sgMinimize() {
  const m = document.getElementById('stargatePlannerModal'); if (m) m.style.display = 'none';
  _sgShowPill();
  if (_sgLastPath && typeof window.mapShowRoute === 'function') window.mapShowRoute(_sgLastPath);
}
function _sgRestore()  { const p = document.getElementById('sgRestorePill'); if (p) p.style.display = 'none'; const m = document.getElementById('stargatePlannerModal'); if (m) m.style.display = 'flex'; }
function _sgShowPill() {
  let pill = document.getElementById('sgRestorePill');
  if (!pill) {
    pill = document.createElement('button');
    pill.id = 'sgRestorePill';
    pill.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:10050;display:flex;align-items:center;gap:8px;'
      + 'background:var(--bg-card);border:1px solid var(--accent);color:var(--text-1);border-radius:20px;padding:8px 16px;'
      + 'font-size:12px;font-family:var(--mono,monospace);cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.5);';
    pill.addEventListener('click', _sgRestore);
    document.body.appendChild(pill);
  }
  const jumps = _sgLastPath ? _sgLastPath.length - 1 : 0;
  pill.innerHTML = `🧭 Stargate Planner${jumps ? ` · ${jumps} jumps` : ''} <span style="opacity:.7;">▢</span>`;
  pill.style.display = 'flex';
}

function _sgBuildModal() {
  const m = document.createElement('div');
  m.id = 'stargatePlannerModal';
  m.className = 'jp-modal-backdrop';
  m.innerHTML = `
    <div class="jp-modal">
      <div class="jp-modal-header">
        <span class="panel-icon">🧭</span><span>Stargate Route Planner</span>
        <span id="sgStatus" class="jp-status"></span>
        <button class="icon-btn sg-min" title="Minimise — keep the route and view it on the map" style="margin-left:auto;font-size:16px;line-height:1;">—</button>
        <button class="icon-btn sg-close" title="Close" style="font-size:16px;">✕</button>
      </div>
      <div class="jp-modal-body">
        <div class="jp-form">
          <div class="jp-field"><label>From</label>
            <input id="sgFrom" class="field-input" autocomplete="off" spellcheck="false" placeholder="Start system…" list="sgSysList"></div>
          <div class="jp-field"><label>To</label>
            <input id="sgTo" class="field-input" autocomplete="off" spellcheck="false" placeholder="Destination system…" list="sgSysList"></div>
          <datalist id="sgSysList"></datalist>
          <div class="jp-field"><label>Mode</label>
            <select id="sgMode" class="field-input" style="cursor:pointer;">
              <option value="safest">Safest (alliance standings)</option>
              <option value="shortest">Shortest (fewest jumps)</option>
            </select>
          </div>
          <div class="jp-toggles">
            <label class="jp-check"><input type="checkbox" id="sgUseBridges" checked> Use jump bridges (Ansiblex)</label>
            <label class="jp-check"><input type="checkbox" id="sgUseWh"> Use EvE-Scout connections (Thera/Turnur)</label>
            <label class="jp-check"><input type="checkbox" id="sgAvoidLow"> Avoid low-sec</label>
            <label class="jp-check"><input type="checkbox" id="sgAvoidNull"> Avoid null-sec</label>
            <label class="jp-check"><input type="checkbox" id="sgAvoidRed"> Avoid red (−5 / −10)</label>
          </div>
          <button id="sgPlotBtn" class="calc-btn" style="width:100%;margin-top:6px;">PLOT ROUTE</button>
          <div class="jp-range-note" id="sgNote">Safest prefers your sov, blues and hi-sec; drops to neutral, low-sec, then red only if needed.</div>
        </div>
        <div class="jp-result" id="sgResult">
          <div class="jp-empty">Enter a start and destination, then plot a route.</div>
        </div>
      </div>
    </div>`;

  m.addEventListener('click', (e) => { if (e.target === m) _sgClose(); });
  m.querySelector('.sg-close').addEventListener('click', _sgClose);
  m.querySelector('.sg-min').addEventListener('click', _sgMinimize);
  m.querySelector('#sgPlotBtn').addEventListener('click', _sgPlot);
  m.querySelector('#sgTo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _sgPlot(); } });
  // Auto re-plot whenever any option (or From/To) changes.
  ['#sgMode', '#sgUseBridges', '#sgUseWh', '#sgAvoidLow', '#sgAvoidNull', '#sgAvoidRed', '#sgFrom', '#sgTo']
    .forEach(sel => { const el = m.querySelector(sel); if (el) el.addEventListener('change', _sgMaybeReplot); });
  return m;
}

// Re-plot the stargate route if both endpoints are valid (used by option toggles).
function _sgMaybeReplot() {
  const from = _sgResolve(document.getElementById('sgFrom').value);
  const to   = _sgResolve(document.getElementById('sgTo').value);
  if (from && to && from.id !== to.id) _sgPlot();
}

function _sgPopulateDatalist() {
  const dl = document.getElementById('sgSysList');
  if (!dl || dl._filled || !_systems.length) return;
  // All map points (k-space systems) for autocomplete.
  dl.innerHTML = _systems
    .filter(s => s.id < 31000000)
    .map(s => `<option value="${s.name}"></option>`).join('');
  dl._filled = true;
  if (!_sgNameIndex) {
    _sgNameIndex = {};
    for (const s of _systems) _sgNameIndex[s.name.toLowerCase()] = s.id;
  }
}

function _sgResolve(text) {
  if (!text) return null;
  if (!_sgNameIndex) _sgPopulateDatalist();
  const id = _sgNameIndex ? _sgNameIndex[text.trim().toLowerCase()] : null;
  return id ? _sysById[id] : null;
}

async function _sgPlot() {
  const result = document.getElementById('sgResult');
  const from = _sgResolve(document.getElementById('sgFrom').value);
  const to   = _sgResolve(document.getElementById('sgTo').value);
  if (!from || !to) { result.innerHTML = `<div class="jp-empty jp-err">Pick valid start and destination systems.</div>`; return; }
  if (from.id === to.id) { result.innerHTML = `<div class="jp-empty">Start and destination are the same system.</div>`; return; }

  if (!_fnfLoaded) { result.innerHTML = `<div class="jp-empty">Loading standings…</div>`; await _loadFnfStandings(); }
  const useWh = document.getElementById('sgUseWh').checked;
  if (useWh && !_whLoaded) { result.innerHTML = `<div class="jp-empty">Loading EvE-Scout connections…</div>`; await _loadWormholes(); }
  const opts = {
    mode:         document.getElementById('sgMode').value,
    avoidLow:     document.getElementById('sgAvoidLow').checked,
    avoidNull:    document.getElementById('sgAvoidNull').checked,
    avoidRed:     document.getElementById('sgAvoidRed').checked,
    useBridges:   document.getElementById('sgUseBridges').checked,
    useWormholes: useWh,
  };
  const path = _travelRoutePath(from.id, to.id, opts);
  if (!path) { result.innerHTML = `<div class="jp-empty jp-err">No gate route found with those constraints. Try removing an avoid filter.</div>`; return; }
  _sgRenderRoute(path, opts);
}

function _sgRenderRoute(path, opts) {
  const result = document.getElementById('sgResult');
  _sgLastPath = path;
  const jumps = path.length - 1;
  // Classify each hop: gate (default), Ansiblex bridge, or EvE-Scout wormhole.
  const isGate   = (a, b) => (_gateAdj.get(a)   || []).includes(b);
  const isBridge = (a, b) => _bridgeAdj && (_bridgeAdj.get(a) || []).includes(b);
  const isWh     = (a, b) => _whAdj     && (_whAdj.get(a)     || []).includes(b);
  const whInfo   = (a, b) => (_whConns || []).find(c =>
    (c.inId === a && c.outId === b) || (c.inId === b && c.outId === a));
  let red = 0, low = 0, bridges = 0, wormholes = 0;
  const rows = path.map((id, i) => {
    const s = _sysById[id];
    const region = _regions[s.regionId] || '';
    if (_travelSafetyCost(s) >= 50) red++;
    if (s.sec > 0.0 && s.sec < 0.45) low++;
    let hopMark = '';
    if (i > 0 && !isGate(path[i - 1], id)) {
      if (isBridge(path[i - 1], id)) { bridges++; hopMark = '<span style="color:#40dc82;" title="Jump bridge">◈ </span>'; }
      else if (isWh(path[i - 1], id)) {
        wormholes++;
        const c = whInfo(path[i - 1], id);
        const t = c ? `EvE-Scout wormhole ${c.whType || ''} · ${c.maxShip || ''}${c.remainingHours != null ? ` · ${c.remainingHours}h left` : ''}` : 'EvE-Scout wormhole';
        hopMark = `<span style="color:#b07cff;" title="${t.trim()}">🌀 </span>`;
      }
    }
    const sov = _travelSovLabel(s);
    const tag = i === 0 ? ' <span class="jp-dim">(start)</span>' : (i === path.length - 1 ? ' <span class="jp-dim">(end)</span>' : '');
    const bridgeMark = hopMark;
    return `
      <tr>
        <td class="jp-num">${i === 0 ? '●' : i}</td>
        <td><span class="jp-secdot" style="background:${_secColor(s.sec)}"></span>${bridgeMark}${escHtml(s.name)}${tag}</td>
        <td class="jp-dim">${escHtml(region)}</td>
        <td class="jp-right">${s.sec != null ? s.sec.toFixed(1) : '—'}</td>
        <td><span class="jp-secdot" style="background:${sov.color}"></span><span class="jp-dim">${sov.label}</span></td>
      </tr>`;
  }).join('');

  result.innerHTML = `
    <div class="jp-banner">${opts.mode === 'shortest' ? '↪ Shortest route — fewest jumps (gates + bridges).' : '🛡 Safest route — prefers your sov, blues & hi-sec; red only as a last resort.'}</div>
    <div class="jp-totals">
      <div><span class="jp-tot-num">${jumps}</span><span class="jp-tot-lbl">jumps</span></div>
      ${bridges ? `<div><span class="jp-tot-num" style="color:#40dc82;">${bridges}</span><span class="jp-tot-lbl">bridges</span></div>` : ''}
      ${wormholes ? `<div><span class="jp-tot-num" style="color:#b07cff;">${wormholes}</span><span class="jp-tot-lbl">wormholes</span></div>` : ''}
      ${low ? `<div><span class="jp-tot-num" style="color:#e8d44a;">${low}</span><span class="jp-tot-lbl">low-sec</span></div>` : ''}
      ${red ? `<div><span class="jp-tot-num" style="color:#d0263d;">${red}</span><span class="jp-tot-lbl">red</span></div>` : ''}
    </div>
    <button id="sgShowMapBtn" class="icon-btn" style="width:100%;margin:4px 0 8px;padding:6px;font-size:12px;cursor:pointer;">🗺 Show / centre on map</button>
    <table class="jp-route-table">
      <thead><tr><th></th><th>System</th><th>Region</th><th class="jp-right">Sec</th><th>Sov</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  const btn = document.getElementById('sgShowMapBtn');
  if (btn) btn.addEventListener('click', () => {
    // Minimise the planner and draw + centre the route so it's actually visible.
    _sgMinimize();
  });
}

async function initMapPage() {
  _loadSavedBridges();   // refresh saved bridge arcs on every entry to the map
  // If already loaded, just ensure the canvas fills its container and re-render
  if (_loaded) {
    _onResize();
    _loadYouAreHere();   // refresh "you are here" (location may have changed)
    _scheduleRender();
    return;
  }

  const loadingEl = document.getElementById('mapLoading');
  const canvasEl  = document.getElementById('mapCanvas');

  _initCanvas();
  _initToolbar();
  _initSearch();
  _updateLegend();

  if (loadingEl) loadingEl.style.display = 'flex';
  if (canvasEl)  canvasEl.style.display  = 'none';

  try {
    logToConsole('[Map] Loading galaxy data from SDE…', 'info');
    const galaxy = await window.eveAPI.mapGetGalaxy();

    _systems  = _normalise(galaxy.systems);
    _jumps    = galaxy.jumps;
    _regions  = galaxy.regions;
    _sysById  = {};
    for (const s of _systems) _sysById[s.id] = s;

    _computeRegionCentroids(); // must come after normalisation & _regions are set

    _loaded = true;
    _onResize(); // Size the canvas now that data is ready; calls _fitGalaxy()

    if (loadingEl) loadingEl.style.display = 'none';
    if (canvasEl)  canvasEl.style.display  = 'block';

    logToConsole(`[Map] ${_systems.length.toLocaleString()} systems, ${_jumps.length.toLocaleString()} connections loaded`, 'success');

    // Honour any pending jump from viewSystemOnMap() called before load completed
    if (_pendingJumpSystemId) {
      const jumpSys = _sysById[_pendingJumpSystemId];
      _pendingJumpSystemId = null;
      if (jumpSys) { _flyTo(jumpSys); _showInfo(jumpSys); }
    }

    // Honour a route requested before the galaxy finished loading.
    if (_pendingRouteIds) {
      _routeIds = _pendingRouteIds;
      _routeWaypointIds = _pendingWaypointIds || new Set();
      _pendingRouteIds = null;
      _pendingWaypointIds = null;
      _fitToSystems(_routeIds);
    }
    if (_pendingJumpRouteIds) {
      _jumpRouteIds = _pendingJumpRouteIds;
      _jumpRouteWaypointIds = _pendingJumpWaypointIds || new Set();
      _pendingJumpRouteIds = null;
      _pendingJumpWaypointIds = null;
    }

    // Mark the selected character's current system.
    _loadYouAreHere();

    // Kick off live overlay fetches in the background (non-blocking)
    _loadLiveData();

  } catch (err) {
    const txt = loadingEl && loadingEl.querySelector('.map-loading-text');
    if (txt) txt.textContent = `Failed to load: ${err.message}`;
    logToConsole(`[Map] Galaxy load failed: ${err.message}`, 'error');
  }
}

// ── Global bridge — called by dashboard "View on Map" buttons ─────────────────
// Switches to Incursions overlay and flies to the given system.
// Safe to call before the galaxy has loaded; the jump is deferred until ready.
window.mapJumpToSystem = function (systemId) {
  // Always switch to incursions overlay so the context is clear
  _overlay = 'incursions';
  document.querySelectorAll('.map-overlay-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('[data-overlay="incursions"]');
  if (btn) btn.classList.add('active');
  if (typeof _updateLegend === 'function') _updateLegend();

  if (_loaded && _sysById[systemId]) {
    _flyTo(_sysById[systemId]);
    _showInfo(_sysById[systemId]);
    _scheduleRender();
  } else {
    // Galaxy still loading — store target; initMapPage will honour it on completion
    _pendingJumpSystemId = systemId;
  }
};

// ── Fit the viewport to a set of systems (used by the route overlay) ──────────
function _fitToSystems(ids) {
  if (!_canvas) return;
  const pts = (ids || []).map(id => _sysById[id]).filter(Boolean);
  if (!pts.length) return;
  const xs = pts.map(p => p.wx), zs = pts.map(p => p.wz);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const pad = 90;
  const z = Math.min(
    (_canvas.width  - pad * 2) / Math.max(1, maxX - minX),
    (_canvas.height - pad * 2) / Math.max(1, maxZ - minZ)
  );
  _zoom = Math.max(_MIN_ZOOM, Math.min(0.5, z));   // cap so short routes keep galaxy context
  const midX = (minX + maxX) / 2, midZ = (minZ + maxZ) / 2;
  _panX = _canvas.width  / 2 - midX * _zoom;
  _panY = _canvas.height / 2 - midZ * _zoom;
}

// Load the selected character's current system for the "you are here" marker.
async function _loadYouAreHere() {
  try {
    const cid = (typeof selectedCharacterId !== 'undefined' && selectedCharacterId) ? selectedCharacterId : null;
    if (!cid || !window.eveAPI || !window.eveAPI.getCharacterData) { _youHereId = null; return; }
    const d = await window.eveAPI.getCharacterData(cid);
    const sysId = d && d.location && d.location.solar_system_id;
    _youHereId = (sysId && _sysById[sysId]) ? sysId : null;
    if (_youHereId) _scheduleRender();
  } catch (_) { _youHereId = null; }
}

// ── Global bridge — called by the Jump Planner "Show on Map" button ───────────
// Highlights an ordered list of system IDs as a route and fits the view to it.
// Stargate route overlay (light blue, straight). fit defaults to centring the view.
window.mapShowRoute = function (systemIds, waypointIds, fit = true) {
  const ids = (systemIds || []).map(Number).filter(Boolean);
  if (!ids.length) return;
  const wps = new Set((waypointIds || []).map(Number).filter(Boolean));
  if (_loaded) {
    _routeIds = ids;
    _routeWaypointIds = wps;
    if (fit) _fitToSystems(ids);
    _scheduleRender();
  } else {
    _pendingRouteIds = ids;
    _pendingWaypointIds = wps;
  }
};

// Capital JUMP route overlay (pink, arcs). Coexists with the stargate route.
window.mapShowJumpRoute = function (systemIds, waypointIds, fit = true) {
  const ids = (systemIds || []).map(Number).filter(Boolean);
  if (!ids.length) return;
  const wps = new Set((waypointIds || []).map(Number).filter(Boolean));
  if (_loaded) {
    _jumpRouteIds = ids;
    _jumpRouteWaypointIds = wps;
    if (fit) _fitToSystems(ids);
    _scheduleRender();
  } else {
    _pendingJumpRouteIds = ids;
    _pendingJumpWaypointIds = wps;
  }
};
