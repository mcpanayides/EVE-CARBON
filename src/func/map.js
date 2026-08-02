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

// Zarzakh (Triglavian hub). Routing *through* it is a trap: entering via a regional
// gate triggers a 6-hour "Emanation Lock" that bars leaving via any other regional
// gate, so it's never the cross-region shortcut the gate graph makes it look like.
// Avoided by default in the Stargate Planner and the map's right-click route.
const _ZARZAKH_ID = 30100000;

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
let _showJb      = true;   // Jump Bridges overlay (saved-bridge arcs + endpoint diamonds) on by default
let _showWh      = true;   // Wormhole connections overlay (EvE-Scout public API) as purple arcs
let _viewMode    = 'modern'; // 'classic' (original look) | 'modern' (flat DOTLAN-style, default)

// Modern "region view" (prototype): when set, the Modern view shows a single region
// laid out from its gate graph (DOTLAN-style), NOT the flattened 3D galaxy.
let _regionView     = null;   // regionId being shown (null = no region picked yet)
let _regionLayout   = null;   // Map(systemId → { x, z }) computed layout positions
let _regionLayoutId = null;   // regionId the cached layout was built for
let _regionExits    = [];     // [{ fromId, name, regionId, regionName, x, z }] inter-region gate stubs
let _regionCache    = new Map(); // regionId → { layout:Map, exits:[] } — per-session
let _hoveredExit    = null;   // exit box currently under the cursor (clickable → its region)
let _hoveredRegion  = null;   // region under the cursor in the galaxy overview (clickable)
let _regionBackRect = null;   // screen rect of the "◄ Galaxy overview" link in region view
let _whArcEdges  = null;   // deduped [[idA,idB],…] of every WH connection to draw as arcs
let _rafPending  = false;
let _loaded      = false;
let _wired       = false;  // canvas/toolbar/search listeners bound (survives a failed load + retry)

// Data (populated by initMapPage)
let _systems     = [];        // [{id, name, wx, wz, sec, regionId, factionId}]
let _jumps       = [];        // [{from, to}]
let _sovMap      = {};        // {systemId: {allianceId, factionId, corporationId}}
let _incSet      = new Set();
// Systems sitting at either end of one of the user's saved bridges — drawn as a
// gold diamond so an endpoint stays findable when its arc runs off-screen.
// This used to be "systems holding an IHUB", fetched from ESI as a proxy for
// "a jump bridge could be anchored here". Equinox made sov itself a sovereignty
// hub, so that set became *every* sov system and the diamond marked the whole of
// null-sec — see the endpoint note in src/ipc/map_ipc.js. Derived from
// _savedBridges now, which is the only real jump-bridge data we have.
let _jbSet           = new Set();
let _savedBridges    = [];        // user's saved Ansiblex bridges [[idA,idB],…] drawn as green arcs
let _regions         = {};        // {regionId: name}
let _sysById         = {};        // {systemId: system}  — O(1) lookup

// Region-level sovereignty labels (sovereignty overlay, zoomed out)
let _regionCentroids    = {};   // {regionId: {wx, wz}}
let _regionDomSov       = {};   // {regionId: {label, color, isFaction, entityId}}
let _allianceTickers    = {};   // {allianceId: ticker}  — cached after first fetch
let _allianceNames      = {};   // {allianceId: name}    — influence territory titles

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
let _pochvenRegionId;      // region id for Pochven (Triglavian) — drawn as triangles
let _exordiumRegionId;     // region id for Exordium (newbie space) — modern-view colour + placement
let _sgLastPath  = null;   // last Stargate-planner route (for minimise redraw)
let _sgAltRoutes = null;   // last computed alternative routes [{path,cost},…]
let _sgNameIndex = null;   // lowercase system name → id (planner autocomplete)
let _youHereId       = null;   // current character's system id ("you are here")

// ── Official EVE security-status colours ──────────────────────────────────────
// Classic view's security ramp — UNCHANGED original colours.
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

// MODERN view's security ramp — CCP flat-map colour language: 1.0 blue →
// 0.5 yellow at the hi-sec boundary → low-sec ambers/reds → nullsec a muted
// rose/magenta (not alarm-red; null is most of the map, and rose keeps the
// picture calm the way the in-game flattened map does). Classic is untouched.
function _secColorModern(sec) {
  if (sec === null || sec === undefined) return '#282828';
  if (sec < -0.9)  return '#282828'; // w-space / j-space
  if (sec <= 0.05) return '#b0487c'; // nullsec — rose
  if (sec <  0.15) return '#8b2434';
  if (sec <  0.25) return '#c02818';
  if (sec <  0.35) return '#d4550f';
  if (sec <  0.45) return '#e08a28';
  if (sec <  0.55) return '#eff17a'; // 0.5 boundary — hi-sec starts
  if (sec <  0.65) return '#a4e25e';
  if (sec <  0.75) return '#5fd6a0';
  if (sec <  0.85) return '#54c8f0';
  if (sec <  0.95) return '#4a9be0';
  return '#3a7bd5';
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
// Thera-region scenery systems to hide (keep Thera itself, 31000005).
const _HIDDEN_SYS = new Set([31000001, 31000002, 31000003, 31000004, 31000006]);

function _normalise(raw) {
  // Drop test / abyssal / proving regions (regionId >= 12000000: ADRxx, VR-xx,
  // GPMRxx) and the Thera-region scenery systems — they're not real travel space
  // and just float around the map.
  const visible = raw.filter(s => (s.regionId || 0) < 12000000 && !_HIDDEN_SYS.has(s.id));

  const ks = visible.filter(s => s.id < 31000000);    // real k-space → main map
  const wh = visible.filter(s => s.id >= 31000000);   // wormhole (Thera + J######) → side block
  if (!ks.length) return visible.map(s => ({ ...s, wx: 0, wz: 0 }));

  const xs = ks.map(s => s.x), zs = ks.map(s => s.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const range = Math.max(maxX - minX, maxZ - minZ) || 1;
  const scale = _MAP_WORLD / range;
  const ox    = (_MAP_WORLD - (maxX - minX) * scale) / 2;
  const oz    = (_MAP_WORLD - (maxZ - minZ) * scale) / 2;

  // Rotate 20° CCW so Tenal sits ~12 o'clock, Period Basis ~7–8. (z negated so
  // EVE "north" maps to the top.)
  const angle = 20 * Math.PI / 180, cosA = Math.cos(angle), sinA = Math.sin(angle);
  const cx = _MAP_WORLD / 2, cz = _MAP_WORLD / 2;

  const ksOut = ks.map(s => {
    const fx = ox + (s.x - minX) * scale;
    const fz = oz + (maxZ - s.z) * scale;
    const dx = fx - cx, dz = fz - cz;
    return { ...s, wx: cx + dx * cosA + dz * sinA, wz: cz - dx * sinA + dz * cosA };
  });

  // Wormhole systems get placeholder positions; _layoutWormholeBlock() arranges
  // them as a grid to the right once the k-space layout is finalised.
  const whOut = wh.map(s => ({ ...s, wx: 0, wz: 0 }));
  return [...ksOut, ...whOut];
}

const _THERA_ID = 31000005, _TURNUR_ID = 30002086;

// Lay out wormhole space. Thera is pinned right next to its sister EvE-Scout hub
// Turnur (most connections bridge Thera↔Turnur and the surrounding low-sec, so
// keeping them adjacent avoids arcs crossing the whole map). The remaining J######
// systems form a static grid to the RIGHT — their connections shift constantly and
// can't be mapped, so it's just a tidy reference block. Run AFTER declutter so both
// sit clear of the galaxy.
function _layoutWormholeBlock() {
  // Pin Thera in the open space up-and-right of Turnur's final (decluttered)
  // position — about midway toward the Avesber cluster so it doesn't overlap it.
  const turnur = _sysById[_TURNUR_ID], thera = _sysById[_THERA_ID];
  if (thera && turnur) { thera.wx = turnur.wx + 60; thera.wz = turnur.wz - 18; }

  const wh = _systems.filter(s => s.id >= 31000000 && s.id !== _THERA_ID);
  if (!wh.length) return;
  let maxX = -Infinity, minZ = Infinity;
  for (const s of _systems) {
    if (s.id >= 31000000) continue;
    if (s.wx > maxX) maxX = s.wx;
    if (s.wz < minZ) minZ = s.wz;
  }
  if (!isFinite(maxX)) { maxX = _MAP_WORLD; minZ = 0; }
  const cols = Math.max(1, Math.ceil(Math.sqrt(wh.length)));
  const cellSize = (_MAP_WORLD * 0.6) / cols;
  const blockX = maxX + _MAP_WORLD * 0.07;   // small gap to the right of the galaxy
  wh.forEach((s, i) => {
    s.wx = blockX + (i % cols) * cellSize;
    s.wz = minZ + (Math.floor(i / cols) + 0.5) * cellSize;
  });
}

// ── Special-region graph relayout ─────────────────────────────────────────────
// A few regions (Pochven, Exordium) are tightly packed in real 3-D space, so the
// raw projection overlaps them into a blob. The in-game new map lays these out
// from their gate graph instead. We approximate that with a force-directed pass,
// applied ONLY to these regions so the rest of the galaxy keeps its real shape.
const _SPECIAL_LAYOUT_REGIONS = ['Pochven', 'Exordium'];

// Fruchterman-Reingold-style spring layout in a unit-ish space. nodes:[{x,y}],
// edges:[[i,j]]. Returns relaxed [{x,y}]. Repulsion spreads, springs pull links.
function _forceLayout(nodes, edges, iterations) {
  const n = nodes.length;
  if (!n) return nodes;
  const k = Math.sqrt(1 / n);                 // ideal edge length
  const pos = nodes.map(nd => ({ x: nd.x, y: nd.y }));
  let temp = 0.15;
  for (let it = 0; it < iterations; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        const d = Math.hypot(dx, dy) || 1e-4;
        const rep = (k * k) / d, ux = dx / d, uy = dy / d;
        disp[i].x += ux * rep; disp[i].y += uy * rep;
        disp[j].x -= ux * rep; disp[j].y -= uy * rep;
      }
    }
    for (const [a, b] of edges) {
      let dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
      const d = Math.hypot(dx, dy) || 1e-4;
      const att = (d * d) / k, ux = dx / d, uy = dy / d;
      disp[a].x -= ux * att; disp[a].y -= uy * att;
      disp[b].x += ux * att; disp[b].y += uy * att;
    }
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(disp[i].x, disp[i].y) || 1e-4;
      const lim = Math.min(d, temp);
      pos[i].x += (disp[i].x / d) * lim;
      pos[i].y += (disp[i].y / d) * lim;
    }
    temp *= 0.985;
  }
  return pos;
}

// ── Global declutter (overlap removal) ────────────────────────────────────────
// Pushes k-space systems that are closer than _DECLUTTER_MIN_DIST apart so dense
// regions stop piling up. Grid-accelerated repulsion (no springs → the overall
// galaxy shape is preserved, just spread out). Higher MIN_DIST = more spacing.
const _DECLUTTER_MIN_DIST = 60;   // world units (map space is _MAP_WORLD = 10000)
const _DECLUTTER_ITERS    = 20;

function _declutterAll() {
  const ks = _systems.filter(s => s.id < 31000000);
  if (ks.length < 2) return;
  const minDist = _DECLUTTER_MIN_DIST;
  const cell    = minDist;
  const key = (gx, gz) => gx + '|' + gz;
  for (let it = 0; it < _DECLUTTER_ITERS; it++) {
    const grid = new Map();
    for (const s of ks) {
      const k = key(Math.floor(s.wx / cell), Math.floor(s.wz / cell));
      (grid.get(k) || grid.set(k, []).get(k)).push(s);
    }
    for (const s of ks) { s._dx = 0; s._dz = 0; }
    for (const s of ks) {
      const gx = Math.floor(s.wx / cell), gz = Math.floor(s.wz / cell);
      for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
        const bucket = grid.get(key(gx + ix, gz + iz));
        if (!bucket) continue;
        for (const o of bucket) {
          if (o === s) continue;
          let dx = s.wx - o.wx, dz = s.wz - o.wz;
          let d = Math.hypot(dx, dz);
          if (d < 1e-3) { dx = Math.sin(s.id) || 1; dz = Math.cos(s.id) || 1; d = Math.hypot(dx, dz) || 1e-3; }
          if (d < minDist) {
            const push = (minDist - d) * 0.5;
            s._dx += (dx / d) * push;
            s._dz += (dz / d) * push;
          }
        }
      }
    }
    for (const s of ks) { s.wx += s._dx; s.wz += s._dz; }
  }
  for (const s of ks) { delete s._dx; delete s._dz; }
}

function _relayoutSpecialRegions() {
  for (const rname of _SPECIAL_LAYOUT_REGIONS) {
    const entry = Object.entries(_regions).find(([, n]) => n === rname);
    if (!entry) continue;
    const rid = Number(entry[0]);
    const sys = _systems.filter(s => s.regionId === rid);
    if (sys.length < 6) continue;

    const idx = new Map(sys.map((s, i) => [s.id, i]));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of sys) { minX = Math.min(minX, s.wx); maxX = Math.max(maxX, s.wx); minZ = Math.min(minZ, s.wz); maxZ = Math.max(maxZ, s.wz); }
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    const cx0 = (minX + maxX) / 2, cz0 = (minZ + maxZ) / 2;

    // Init from current positions (+ tiny deterministic jitter to break overlaps).
    const nodes = sys.map((s, i) => ({
      x: (s.wx - cx0) / span + (Math.sin(i * 12.9898) % 1) * 0.02,
      y: (s.wz - cz0) / span + (Math.cos(i * 78.233) % 1) * 0.02,
    }));
    const edges = [];
    for (const j of _jumps) { const a = idx.get(j.from), b = idx.get(j.to); if (a != null && b != null && a < b) edges.push([a, b]); }

    const pos = _forceLayout(nodes, edges, 500);

    // Rescale the relaxed graph back into the region's spot, with extra breathing
    // room so it reads cleanly instead of staying packed.
    let nx0 = Infinity, nx1 = -Infinity, nz0 = Infinity, nz1 = -Infinity;
    for (const p of pos) { nx0 = Math.min(nx0, p.x); nx1 = Math.max(nx1, p.x); nz0 = Math.min(nz0, p.y); nz1 = Math.max(nz1, p.y); }
    const nspan = Math.max(nx1 - nx0, nz1 - nz0, 1e-6);
    const target = span * 1.5;
    const ncx = (nx0 + nx1) / 2, ncz = (nz0 + nz1) / 2;
    for (let i = 0; i < sys.length; i++) {
      sys[i].wx = cx0 + (pos[i].x - ncx) / nspan * target;
      sys[i].wz = cz0 + (pos[i].y - ncz) / nspan * target;
    }
  }
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
  // Fit the actual content bounds (galaxy + wormhole side block) rather than the
  // fixed _MAP_WORLD box, so the J-space block is visible next to the galaxy and a
  // decluttered (expanded) galaxy isn't clipped.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of (_systems || [])) {
    if (s.wx < minX) minX = s.wx; if (s.wx > maxX) maxX = s.wx;
    if (s.wz < minZ) minZ = s.wz; if (s.wz > maxZ) maxZ = s.wz;
  }
  if (!isFinite(minX)) { minX = 0; maxX = _MAP_WORLD; minZ = 0; maxZ = _MAP_WORLD; }
  const w = (maxX - minX) || _MAP_WORLD, h = (maxZ - minZ) || _MAP_WORLD;
  const pad  = 30;
  const fitZ = Math.min((_canvas.width - pad * 2) / w, (_canvas.height - pad * 2) / h);
  _zoom = fitZ;
  _panX = (_canvas.width  - w * fitZ) / 2 - minX * fitZ;
  _panY = (_canvas.height - h * fitZ) / 2 - minZ * fitZ;
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
  // Modern region view: test in screen space against the laid-out pill centres.
  if (_viewMode === 'modern' && _regionView != null && _regionLayout) {
    let best = null, bestD2 = 18 * 18;
    for (const [id, p] of _regionLayout) {
      const [sx, sy] = _w2c(p.x, p.z);
      const dx = sx - cx, dy = sy - cy, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = _sysById[id]; }
    }
    return best;
  }
  // Modern galaxy overview: nearest cluster node in screen space.
  if (_viewMode === 'modern' && _galaxyModern) {
    let best = null, bestD2 = 14 * 14;
    for (const [id, p] of _galaxyModern.gpos) {
      const [sx, sy] = _w2c(p.x, p.z);
      const dx = sx - cx, dy = sy - cy, d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = _sysById[id]; }
    }
    return best;
  }
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

// Resolve alliance ticker + full name for the given IDs in one batched call,
// skipping any already known. Region labels use the ticker (short, fits under a
// region name); the influence field's territory titles use the name.
// Returns true when anything new landed, so callers can re-render.
async function _fetchAllianceIdents(ids) {
  const needed = [...new Set(ids)].filter(id => id && !_allianceNames[id]);
  if (!needed.length) return false;
  try {
    const result = await window.eveAPI.mapGetAllianceTickers(needed);
    let changed = false;
    for (const [id, ident] of Object.entries(result)) {
      const n = parseInt(id, 10);
      if (ident && typeof ident === 'object') {
        if (ident.ticker) _allianceTickers[n] = ident.ticker;
        if (ident.name)   _allianceNames[n]   = ident.name;
      } else if (ident) {
        _allianceTickers[n] = ident;   // pre-name cache entry (bare ticker string)
      }
      changed = true;
    }
    return changed;
  } catch (e) {
    console.warn('[Map] alliance ident fetch failed:', e.message);
    return false;
  }
}

// Fetch tickers for all player-alliance dominant holders in one pass.
async function _fetchDomTickers() {
  const needed = Object.values(_regionDomSov)
    .filter(d => !d.isFaction && d.entityId && !_allianceTickers[d.entityId])
    .map(d => d.entityId);
  if (!needed.length) return;

  if (await _fetchAllianceIdents(needed)) {
    // Patch in tickers now that we have them, then re-render
    for (const dom of Object.values(_regionDomSov)) {
      if (!dom.isFaction && dom.entityId) {
        dom.label = _allianceTickers[dom.entityId] || dom.label;
      }
    }
    _scheduleRender();
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
// EvE-Scout hub systems drawn as pentagons: Thera (31000005) and Turnur (30002086).
const _PENTAGON_SYS = new Set([31000005, 30002086]);

// Trace a regular N-gon (point up) into the current path — used for node glyphs.
function _regularPolyPath(ctx, cx, cy, r, sides) {
  for (let k = 0; k < sides; k++) {
    const ang = -Math.PI / 2 + k * (2 * Math.PI / sides);
    const px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ── Modern view helpers ───────────────────────────────────────────────────────
// Flat, schematic "DOTLAN" style: solid straight gate lines, flat-coloured nodes,
// no glow / bloom / gradients. Shares system positions with the classic view.

// Colour a system's dot uses under the current overlay (shared by both views).
function _systemColor(s) {
  // With the influence field up, a dot's job changes: the security ramp paints
  // every null system the same rose (_secColorModern), which on top of per-holder
  // territory reads as pink confetti over an unrelated map. Tint the dot to the
  // territory it sits in instead, lifted so it still stands off its own ground.
  // Systems no holder reaches — empire, NPC null, w-space — keep the overlay's
  // own colour, so the field only overrides where it has something to say.
  if (_infActive() && _infSysCol) {
    const col = _infSysCol.get(s.id);
    if (col) return _infLighten(col);
  }
  switch (_overlay) {
    case 'sovereignty': return _sovColor(s.id);
    case 'fnf':         return _fnfColor(s);
    case 'incursions':  return _incSet.has(s.id) ? '#dd44aa' : '#1c1c28';
    case 'security':
    default:
      if (_viewMode === 'modern') {
        _resolveSpecialRegionIds();
        // Pochven reads as nullsec (its raw sec of −1 would hit the grey
        // w-space branch); Exordium is newbie space — deeper blue than 1.0.
        if (s.regionId === _pochvenRegionId)  return '#b0487c';
        if (s.regionId === _exordiumRegionId) return '#2456a8';
        return _secColorModern(s.sec);
      }
      return _secColor(s.sec);
  }
}

// Resolve the special region ids once (shared by classic glyphs + modern colours).
function _resolveSpecialRegionIds() {
  if (_pochvenRegionId === undefined) {
    _pochvenRegionId = null;
    for (const [rid, name] of Object.entries(_regions)) {
      if (name === 'Pochven') { _pochvenRegionId = Number(rid); break; }
    }
  }
  if (_exordiumRegionId === undefined) {
    _exordiumRegionId = null;
    for (const [rid, name] of Object.entries(_regions)) {
      if (name === 'Exordium') { _exordiumRegionId = Number(rid); break; }
    }
  }
}

// ── Influence field (Verite-style territory blobs) ───────────────────────────
// Verite Rendition's sov map doesn't colour systems, it colours *territory*:
// "different systems generate different amounts of influence which are then
// transmitted to nearby systems" (evenews24.com/verite-renditions-sov-map).
// Same model here. Every player-sov system emits influence for whoever holds it;
// that influence travels outward along the GATE GRAPH (not raw distance — a
// system two jumps away is closer in EVE terms than one across a rift), decaying
// per hop. The result is painted as a hex field where the strongest holder wins
// each cell. Cells won by the same holder share their edges exactly, so they
// fuse into one contiguous shape — that's the "tiles lock together" effect —
// and a blurred additive second pass gives the whole thing its glow.
//
// Drawn under everything else (right after the background) so gates, dots and
// labels stay legible on top, exactly as on Verite's maps.
const INF_JUMPS    = 3;      // gate hops influence travels
const INF_DECAY    = 0.45;   // strength multiplier per hop
const INF_MIN      = 0.02;   // stop propagating below this
const INF_HEX      = 0.6;    // hex circumradius, in median-gate-lengths
const INF_SPREAD   = 2.2;    // how far one system paints, in median-gate-lengths
const INF_BANDS    = 5;      // alpha quantisation (keeps fills batched)
const INF_FILL     = 0.42;   // flat territory alpha at full strength
const INF_GLOW     = 0.34;   // additive blurred pass alpha
const INF_BLUR_MAX = 28;     // glow radius cap, px
const INF_TITLE_MIN   = 10;   // min cells in a territory before it gets a title
// Title size in px, lerped across the zoom range — and deliberately INVERTED:
// biggest at the galaxy overview, where a bloc name is all you can read anyway,
// and smallest zoomed in, where system names carry the detail and a huge holder
// name would just sit on top of them.
const INF_TITLE_PX_OUT = 24;  // galaxy overview
const INF_TITLE_PX_IN  = 12;  // zoomed right in
const INF_TITLE_ROOM  = 2.5;  // territory must cover this × the title's own area

let _showInf   = false;  // toolbar toggle
let _infCells  = null;   // { byBatch: Map("colour|band" → [x,z,…]), R, titles } world units
let _infKey    = '';     // cache key for the above (data + colour source + view)
let _infBuf    = null;   // offscreen canvas the field is painted into
let _infBufKey = '';     // cache key for the buffer (adds the view transform)
let _infSysCol = null;   // systemId → its territory's colour (tints the dots)

// Is the field actually part of the current picture? The region view deliberately
// doesn't draw it (see _renderRegion), and everything that keys off the field —
// dot tints, titles, hiding region names — has to agree with that, or a region
// would show influence-tinted dots floating over no territory at all.
function _infActive() {
  return _showInf && !(_viewMode === 'modern' && _regionView != null);
}

// Everyone you have no standing toward holds ~40% of null between them. At the
// dot palette's near-white that would be most of the glow, drowning out the
// colours you actually care about, so the field substitutes a dim slate — the
// one place it deliberately departs from the overlay's own legend.
const INF_NEUTRAL = '#5c6478';

// Which colour a system contributes to the field. Player sov only: NPC/faction
// "claims" cover the whole of empire space and would smear the entire map, and
// unclaimed null has nobody to attribute. The palette follows the active
// overlay — Friends & Foes gives the standings view (your teal, blue +5/+10,
// orange/red hostiles), anything else gives per-alliance territory colours.
function _infColorOf(s) {
  const sov = _sovMap[s.id];
  if (!sov || sov.allianceId == null) return null;
  if (_overlay !== 'fnf') return _sovColor(s.id);
  const c = _fnfColor(s);
  return c === '#cfd3db' ? INF_NEUTRAL : c;
}

// The field tracks the actual HOLDER per cell, not the colour, because under
// Friends & Foes a colour is a standings class shared by dozens of alliances —
// "+10 blue" can't title a territory. Colour is derived from the winning holder
// afterwards via a system it actually owns, so the tier thresholds stay defined
// in exactly one place (_fnfColor).
// Returns Map(allianceId → { rep, colour }) where rep is a representative system.
function _infHolders() {
  const holders = new Map();
  for (const s of _systems) {
    const sov = _sovMap[s.id];
    if (!sov || sov.allianceId == null || holders.has(sov.allianceId)) continue;
    const colour = _infColorOf(s);
    if (colour) holders.set(sov.allianceId, { rep: s, colour });
  }
  return holders;
}

// Median gate length in whatever position space we're drawing. Everything else
// is expressed as a multiple of this, so the field keeps the same visual density
// in Classic, the Modern galaxy overview and a Modern region — three coordinate
// spaces with wildly different scales.
function _infMedianGate(posOf) {
  const lens = [];
  for (const j of _jumps) {
    if (j.from > j.to) continue;               // each edge once
    const a = posOf(j.from), b = posOf(j.to);
    if (!a || !b) continue;
    lens.push(Math.hypot(a.x - b.x, a.z - b.z));
  }
  if (!lens.length) return 0;
  lens.sort((x, y) => x - y);
  return lens[Math.floor(lens.length / 2)] || 0;
}

// Spread each holder's influence out over the gate graph. Reaching a system by
// several routes stacks — a system deep inside one alliance's space accumulates
// far more than a border system its neighbour also pushes into, which is what
// makes borders land where they intuitively should.
function _infPropagate(holders) {
  _ensureGateAdj();
  const bump = (m, id, aid, w) => {
    let c = m.get(id);
    if (!c) m.set(id, c = new Map());
    c.set(aid, (c.get(aid) || 0) + w);
  };

  const acc = new Map();          // sysId → Map(allianceId → weight)
  let frontier = new Map();
  for (const s of _systems) {
    const aid = _sovMap[s.id]?.allianceId;
    if (aid == null || !holders.has(aid)) continue;
    bump(acc, s.id, aid, 1);
    bump(frontier, s.id, aid, 1);
  }

  for (let hop = 0; hop < INF_JUMPS; hop++) {
    const next = new Map();
    for (const [id, hs] of frontier) {
      const nbs = _gateAdj.get(id);
      if (!nbs) continue;
      for (const nb of nbs) {
        for (const [aid, w] of hs) {
          const nw = w * INF_DECAY;
          if (nw < INF_MIN) continue;
          bump(acc, nb, aid, nw);
          bump(next, nb, aid, nw);
        }
      }
    }
    frontier = next;
  }

  const out = [];
  for (const [id, hs] of acc) {
    let ba = null, bw = 0;
    for (const [aid, w] of hs) if (w > bw) { bw = w; ba = aid; }
    if (ba != null) out.push({ id, aid: ba, w: bw });
  }
  return out;
}

// Cube-round an axial hex coordinate to the nearest whole cell.
function _hexRound(q, r) {
  const x = q, z = r, y = -x - z;
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz)  rx = -ry - rz;
  else if (dy > dz)        ry = -rx - rz;
  else                     rz = -rx - ry;
  return [rx, rz];
}

// Paint the propagated influence into pointy-top hex cells. Each system splats a
// squared-falloff disc of its holder's colour over the cells within reach; every
// cell then goes to whichever holder pushed hardest into it.
function _infBuildCells(posOf) {
  const pitch = _infMedianGate(posOf);
  if (!pitch) return null;
  const holders = _infHolders();
  if (!holders.size) return null;
  const nodes = _infPropagate(holders);
  if (!nodes.length) return null;

  const R      = pitch * INF_HEX;
  const spread = pitch * INF_SPREAD;
  const reach  = Math.ceil(spread / (1.5 * R)) + 1;

  // Per-system winner, so the dots can be tinted to the territory they sit in.
  _infSysCol = new Map();
  for (const n of nodes) _infSysCol.set(n.id, holders.get(n.aid).colour);

  const cells = new Map();        // "q,r" → { q, r, x, z, hs: Map(allianceId → weight) }
  for (const n of nodes) {
    const p = posOf(n.id);
    if (!p) continue;
    const [cq, cr] = _hexRound(
      (Math.sqrt(3) / 3 * p.x - p.z / 3) / R,
      (2 / 3 * p.z) / R
    );
    for (let dq = -reach; dq <= reach; dq++) {
      for (let dr = -reach; dr <= reach; dr++) {
        const q = cq + dq, r = cr + dr;
        const x = R * Math.sqrt(3) * (q + r / 2);
        const z = R * 1.5 * r;
        const d = Math.hypot(x - p.x, z - p.z);
        if (d > spread) continue;
        const f = (1 - d / spread) ** 2;
        const k = q + ',' + r;
        let c = cells.get(k);
        if (!c) cells.set(k, c = { q, r, x, z, hs: new Map() });
        c.hs.set(n.aid, (c.hs.get(n.aid) || 0) + n.w * f);
      }
    }
  }

  // Collapse to one winner per cell, then bucket by colour + quantised alpha so
  // the whole field draws in a handful of batched fills instead of per-cell.
  const byBatch = new Map();
  const won     = new Map();      // "q,r" → { cell, aid }
  for (const [k, c] of cells) {
    let ba = null, bw = 0, tot = 0;
    for (const [aid, w] of c.hs) { tot += w; if (w > bw) { bw = w; ba = aid; } }
    if (ba == null) continue;
    const band = Math.ceil(Math.min(1, tot * 0.55) * INF_BANDS);
    if (band <= 0) continue;
    const colour = holders.get(ba).colour;
    const bk = colour + '|' + band;
    let arr = byBatch.get(bk);
    if (!arr) byBatch.set(bk, arr = []);
    arr.push(c.x, c.z);
    won.set(k, { cell: c, aid: ba });
  }

  return { byBatch, R, titles: _infTitles(won, holders) };
}

// Flood-fill the won cells into contiguous same-holder territories and place one
// title at each one's centroid. A holder split across the map (staging pocket
// here, home region there) rightly gets a title per blob rather than one label
// floating in the gap between them.
function _infTitles(won, holders) {
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
  const seen = new Set();
  const titles = [];

  for (const [k0, w0] of won) {
    if (seen.has(k0)) continue;
    seen.add(k0);
    const stack = [k0];
    let sx = 0, sz = 0, n = 0;
    while (stack.length) {
      const k = stack.pop();
      const w = won.get(k);
      sx += w.cell.x; sz += w.cell.z; n++;
      for (const [dq, dr] of NB) {
        const nk = (w.cell.q + dq) + ',' + (w.cell.r + dr);
        if (seen.has(nk)) continue;
        const nw = won.get(nk);
        if (!nw || nw.aid !== w0.aid) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
    if (n < INF_TITLE_MIN) continue;      // too small to be worth naming
    titles.push({ x: sx / n, z: sz / n, aid: w0.aid, cells: n,
                  colour: holders.get(w0.aid).colour });
  }
  // Biggest first: the declutter pass below keeps whichever it reaches first, so
  // a major bloc's title always wins its ground over a small neighbour's.
  titles.sort((a, b) => b.cells - a.cells);
  return titles;
}

function _infInvalidate() { _infKey = ''; _infBufKey = ''; }

// The --mono custom property, resolved to something canvas will actually accept.
//
// Canvas 2D parses `font` as a CSS shorthand VALUE, not as a declaration, so
// var() never gets substituted — the whole string fails to parse and the
// assignment is silently dropped, leaving the context on its default
// 10px sans-serif. (Verified: setting "30.4px var(--mono, monospace)" reads back
// "10px sans-serif".) Every canvas font in this file therefore goes through
// _mono() below. Never write var(--mono) into ctx.font.
//
// The same is true of fillStyle and strokeStyle: var() there is dropped too, and
// the context silently keeps whatever colour was set last — so tokens the canvas
// needs get resolved here as well, never written into a canvas property raw.
//
// Resolved once per frame by _render() rather than per call: getComputedStyle
// forces a style resolution, and these are set inside per-system draw loops.
// Re-reading every frame still lets a theme switch take effect without a reload.
let _fontStack = '';
let _accentCol = '';
function _refreshThemeVars() {
  const cs = getComputedStyle(document.documentElement);
  _fontStack = cs.getPropertyValue('--mono').trim()   || 'monospace';
  _accentCol = cs.getPropertyValue('--accent').trim() || '#e0483a';
}
function _monoStack() {
  if (!_fontStack) _refreshThemeVars();
  return _fontStack;
}
function _accent() {
  if (!_accentCol) _refreshThemeVars();
  return _accentCol;
}

// Canvas font shorthand, with the resolved family list. Weight is optional.
function _mono(px, weight) {
  return `${weight ? weight + ' ' : ''}${px}px ${_monoStack()}`;
}

// Anything drawn ON a territory — its title, its system dots — comes from the
// same colour as the territory itself, and _allianceColor's hsl(h,62%,42%) over
// a field of hsl(h,62%,42%) is nearly invisible. Lift it well clear of the
// background while keeping the hue, so it still reads as belonging to the
// ground under it.
function _infLighten(colour) {
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(colour);
  if (hsl) return `hsl(${hsl[1]},${Math.min(100, +hsl[2] + 18)}%,78%)`;
  const hex = /^#([0-9a-f]{6})$/i.exec(colour);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const mix = c => Math.round(c + (255 - c) * 0.5);
    return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }
  return colour;
}

// Territory titles — who actually owns the ground you're looking at, in the
// holder's own colour so a title reads as belonging to the blob under it. Drawn
// LAST by each view (unlike the field itself, which goes underneath everything)
// so nothing overprints them.
//
// Sized off the caller's own region-title size, which the views compute
// differently and clamp between their own bounds — so they pass those bounds in
// too, and the scale below rides them: biggest zoomed right in, more restrained
// at the galaxy overview where the names have to share the screen.
function _drawInfluenceTitles(ctx, W, H, baseFont, baseMin, baseMax) {
  if (!_infActive() || !_infCells || !_infCells.titles.length) return;

  // baseFont is the caller's own region-title size, clamped between its bounds —
  // used here purely as a normalised "how zoomed in am I" for the lerp.
  const t01 = baseMax > baseMin ? (baseFont - baseMin) / (baseMax - baseMin) : 1;
  const fs  = INF_TITLE_PX_OUT + (INF_TITLE_PX_IN - INF_TITLE_PX_OUT) * t01;

  ctx.save();
  ctx.font         = _mono(fs.toFixed(1));
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor  = 'rgba(0,0,0,0.95)';
  ctx.shadowBlur   = 7;

  // A territory only gets named once it's big enough ON SCREEN to carry the
  // name — hex area × cells × zoom². That's what makes this readable at a
  // glance: zoomed out to the whole galaxy you get the handful of blocs that
  // actually own the picture, and smaller holders name themselves as you zoom
  // into them, instead of 85 labels fighting over the same pixels at every zoom.
  const cellArea = 2.598 * _infCells.R * _infCells.R * _zoom * _zoom;

  // Greedy declutter: titles are pre-sorted biggest-territory-first, so a small
  // holder never elbows a major bloc's name off its own space.
  const placed = [];
  for (const t of _infCells.titles) {
    const name = _allianceNames[t.aid] || _allianceTickers[t.aid];
    if (!name) continue;                        // still resolving — skip, not "Alliance 99…"
    const [cx, cy] = _w2c(t.x, t.z);
    if (cx < -60 || cx > W + 60 || cy < -30 || cy > H + 30) continue;
    const textW = ctx.measureText(name).width;
    if (t.cells * cellArea < textW * fs * INF_TITLE_ROOM) continue;
    const halfW = textW / 2 + fs * 0.4;
    if (placed.some(p => Math.abs(p.cx - cx) < p.halfW + halfW && Math.abs(p.cy - cy) < fs * 1.8)) continue;
    placed.push({ cx, cy, halfW });
    ctx.fillStyle = _infLighten(t.colour);
    ctx.fillText(name, cx, cy);
  }
  ctx.restore();
}

// Paint the field, then composite it twice: once flat (the territory) and once
// blurred and additive (the glow). posOf maps a system id to its {x,z} in the
// caller's coordinate space, so all three views share this one drawer.
function _drawInfluenceField(ctx, W, H, posOf) {
  if (!_infActive()) return;

  const key = [_viewMode, _regionView, _overlay, Object.keys(_sovMap).length, _fnfLoaded].join('|');
  if (key !== _infKey) {
    _infKey = key;
    _infCells = _infBuildCells(posOf);
    _infBufKey = '';
    // Resolve the names for the titles. Fires once per rebuild (the key guard
    // above), and re-renders when they land so titles appear without a nudge.
    if (_infCells && _infCells.titles.length) {
      _fetchAllianceIdents(_infCells.titles.map(t => t.aid))
        .then(changed => { if (changed) _scheduleRender(); });
    }
  }
  const F = _infCells;
  if (!F || !F.byBatch.size) return;

  if (!_infBuf || _infBuf.width !== W || _infBuf.height !== H) {
    _infBuf = document.createElement('canvas');
    _infBuf.width = W; _infBuf.height = H;
    _infBufKey = '';
  }

  // A hair of overlap kills the antialiased hairlines that would otherwise show
  // every hex seam inside what should read as one solid territory.
  const rPx = F.R * _zoom * 1.02;
  if (rPx < 0.35) return;                       // zoomed out past usefulness

  // Repaint the buffer only when the view actually moved — a still map composites
  // two cached drawImage calls per frame instead of rebuilding tens of thousands
  // of hexes.
  const tkey = `${key}|${W}x${H}|${_panX.toFixed(1)}|${_panY.toFixed(1)}|${_zoom}`;
  if (_infBufKey !== tkey) {
    _infBufKey = tkey;
    const b = _infBuf.getContext('2d');
    b.clearRect(0, 0, W, H);
    const m = rPx * 2;
    for (const [k, xs] of F.byBatch) {
      const cut  = k.lastIndexOf('|');
      b.fillStyle   = k.slice(0, cut);
      b.globalAlpha = (Number(k.slice(cut + 1)) / INF_BANDS) * INF_FILL;
      b.beginPath();
      for (let i = 0; i < xs.length; i += 2) {
        const [cx, cy] = _w2c(xs[i], xs[i + 1]);
        if (cx < -m || cx > W + m || cy < -m || cy > H + m) continue;
        for (let v = 0; v < 6; v++) {
          const a  = Math.PI / 180 * (60 * v - 30);   // pointy-top
          const px = cx + rPx * Math.cos(a), py = cy + rPx * Math.sin(a);
          if (v === 0) b.moveTo(px, py); else b.lineTo(px, py);
        }
        b.closePath();
      }
      b.fill();
    }
    b.globalAlpha = 1;
  }

  ctx.save();
  ctx.globalAlpha = INF_GLOW;
  ctx.globalCompositeOperation = 'lighter';
  // Glow scales with the tiles themselves, so the bloom looks the same whether
  // you're at the galaxy overview or zoomed into one region.
  ctx.filter = `blur(${Math.max(4, Math.min(INF_BLUR_MAX, rPx * 3)).toFixed(1)}px)`;
  ctx.drawImage(_infBuf, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(_infBuf, 0, 0);
  ctx.restore();
}

// Flat, solid, straight gate links for the modern view: thin neutral grey for
// ordinary gates, a flat amber for cross-region ("regional") gates so they read as
// the long hauls. No curves, no glow — a clean schematic network.
function _drawModernLinks(ctx, W, H, lineW) {
  const off = (ax, ay, bx, by) =>
    (ax < -50 && bx < -50) || (ax > W + 50 && bx > W + 50) ||
    (ay < -50 && by < -50) || (ay > H + 50 && by > H + 50);
  const line = (a, b) => {
    const [ax, ay] = _w2c(a.wx, a.wz), [bx, by] = _w2c(b.wx, b.wz);
    if (off(ax, ay, bx, by)) return;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  };

  // Ordinary intra-region gates — thin solid grey.
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(150,160,176,0.42)';
  ctx.lineWidth   = Math.max(0.12, lineW);
  for (const j of _jumps) {
    const a = _sysById[j.from], b = _sysById[j.to];
    if (!a || !b || a.regionId !== b.regionId) continue;
    line(a, b);
  }
  ctx.stroke();

  // Cross-region (regional) gates — flat amber, slightly thicker.
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(196,140,64,0.65)';
  ctx.lineWidth   = Math.max(0.5, lineW * 1.3);
  for (const j of _jumps) {
    const a = _sysById[j.from], b = _sysById[j.to];
    if (!a || !b || a.regionId === b.regionId) continue;
    line(a, b);
  }
  ctx.stroke();
}

// ── Modern region view (DOTLAN-style per-region layout) ───────────────────────
// Trace a pill / stadium (rounded-rect) path for a system node label.
function _pillPath(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

// The k-space region we open by default in Modern (their first example), else the
// first region alphabetically.
function _defaultRegionId() {
  for (const [rid, name] of Object.entries(_regions)) if (name === 'Period Basis') return Number(rid);
  const ks = Object.keys(_regions).map(Number).filter(r => r < 11000000).sort((a, b) => a - b);
  return ks[0] != null ? ks[0] : null;
}

// World-grid cell size (square so edges resolve to vertical / 45° / steeper grid
// angles, never random ones). Big enough that name pills never overlap at the
// default zoom.
const _REGION_CELL = 110;

// Eight grid directions (E, SE, S, SW, W, NW, N, NE) for hanging spurs / exit boxes,
// plus a snap of an arbitrary delta to the nearest of them.
const _REGION_DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
function _dir8(dx, dz) {
  if (!dx && !dz) return -1;
  return ((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8;
}
// Pick a clean outward direction (index into _REGION_DIRS) to hang a satellite off
// node (px,pz): maximise "outward" from the centroid, avoid running collinear with an
// existing edge (so the stub never overlaps a gate line), prefer vertical/horizontal,
// and skip occupied target cells.
function _pickStubDir(px, pz, cX, cZ, blocked, free) {
  let best = 6, bestScore = -Infinity;   // default N
  const ox = px - cX, oz = pz - cZ, ol = Math.hypot(ox, oz) || 1;
  for (let i = 0; i < 8; i++) {
    const dx = _REGION_DIRS[i][0], dz = _REGION_DIRS[i][1], dl = Math.hypot(dx, dz);
    let score = ((dx * ox + dz * oz) / (dl * ol)) * 3;            // outward
    if (blocked.has(i) || blocked.has((i + 4) % 8)) score -= 6;   // collinear with an edge
    if (dx === 0 || dz === 0) score += 0.4;                       // prefer vertical/horizontal
    if (free && !free(i)) score -= 100;                           // target cell taken
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// The intra-region gate graph for one region: its systems, the adjacency between
// them, and a membership set. Node POSITIONS no longer come from here — see
// _buildRegionLayout, which uses the force layout instead. (This used to also
// compute a layered BFS grid; that produced the tall vertical ribbon and its only
// consumer now discards it, so it's gone — `git log` has it if it's ever wanted.)
// Pure (no globals beyond _systems / _jumps).
function _regionGraph(regionId) {
  const sys = _systems.filter(s => s.regionId === regionId && s.id < 31000000);
  const inRegion = new Set(sys.map(s => s.id));
  const adj = new Map(sys.map(s => [s.id, []]));
  if (!sys.length) return { sys, adj, inRegion };

  for (const j of _jumps) if (inRegion.has(j.from) && inRegion.has(j.to)) adj.get(j.from).push(j.to);
  for (const [k, v] of adj) adj.set(k, [...new Set(v)]);
  return { sys, adj, inRegion };
}

// Single-region view layout: clean node positions + clickable inter-region gate
// stubs, oriented so the region's gateways sit at the top. Cached per region.
function _buildRegionLayout(regionId) {
  const cached = _regionCache.get(regionId);
  if (cached) { _regionLayout = cached.layout; _regionExits = cached.exits; _regionLayoutId = regionId; return _regionLayout; }

  // Node positions come from the force layout. The previous layered grid put BFS
  // depth on one axis and slot-within-layer on the other, so a chain-shaped
  // region (most of null) came out as a ribbon tens of layers long and two or
  // three wide — a narrow vertical stack down the middle of a landscape canvas,
  // with the whole width wasted either side.
  // The force layout is seeded from the systems' true positions and relaxes every
  // gate to one rest length, so a region keeps its real shape and spreads over
  // both axes. It's the same layout the galaxy overview's clusters already use.
  const { sys, adj, inRegion } = _regionGraph(regionId);
  const map = new Map(), exits = [];
  for (const [id, p] of _regionForceLayout(sys.map(s => s.id), adj)) {
    map.set(id, { x: p.x * _REGION_CELL, z: p.z * _REGION_CELL });
  }

  // Lay the region's long axis across the canvas. Regions are elongated in real
  // space and the direction is arbitrary, so an unrotated Delve arrives 1650×1980
  // — overflowing a landscape viewport vertically while leaving the sides empty.
  // Rotating the dominant axis (same 2-D PCA the overview orients clusters with)
  // onto the horizontal spends the space we actually have. Done BEFORE the exit
  // stubs below so they're placed against the final positions.
  if (map.size > 2) {
    const ang = _pcaAngle([...map.values()]);
    const ca = Math.cos(-ang), sa = Math.sin(-ang);
    for (const p of map.values()) {
      const x = p.x * ca - p.z * sa;
      p.z = p.x * sa + p.z * ca;
      p.x = x;
    }
  }

  if (sys.length) {
    const ck = (x, z) => Math.round(x / _REGION_CELL) + '|' + Math.round(z / _REGION_CELL);
    let cX0 = 0, cZ0 = 0; for (const p of map.values()) { cX0 += p.x; cZ0 += p.z; } cX0 /= map.size; cZ0 /= map.size;
    const occ = new Set(); for (const p of map.values()) occ.add(ck(p.x, p.z));
    const edgeDirs = (id, here) => {
      const set = new Set();
      for (const v of adj.get(id)) { const vp = map.get(v); if (vp) { const i = _dir8(vp.x - here.x, vp.z - here.z); if (i >= 0) set.add(i); } }
      return set;
    };
    // Inter-region gate stubs hung at a clean outward angle, never along a gate line.
    const seen = new Set(), usedDir = new Map();
    for (const j of _jumps) {
      if (!inRegion.has(j.from) || inRegion.has(j.to)) continue;
      const key = j.from + '>' + j.to;
      if (seen.has(key)) continue; seen.add(key);
      const ext = _sysById[j.to], ip = map.get(j.from);
      if (!ext || !ip) continue;
      const blocked = edgeDirs(j.from, ip);
      for (const u of (usedDir.get(j.from) || [])) blocked.add(u);
      const free = (i) => !occ.has(ck(ip.x + _REGION_DIRS[i][0] * _REGION_CELL, ip.z + _REGION_DIRS[i][1] * _REGION_CELL));
      const di = _pickStubDir(ip.x, ip.z, cX0, cZ0, blocked, free);
      (usedDir.get(j.from) || usedDir.set(j.from, []).get(j.from)).push(di);
      exits.push({
        fromId: j.from, name: ext.name, regionId: ext.regionId,
        regionName: _regions[ext.regionId] || '',
        x: ip.x + _REGION_DIRS[di][0] * _REGION_CELL * 1.7,
        z: ip.z + _REGION_DIRS[di][1] * _REGION_CELL * 1.7,
      });
    }
    // Orient gateways to the top: flip vertically if exits sit in the lower half.
    let zmin = Infinity, zmax = -Infinity;
    for (const p of map.values()) { zmin = Math.min(zmin, p.z); zmax = Math.max(zmax, p.z); }
    let emz = 0; for (const e of exits) emz += e.z; emz /= (exits.length || 1);
    if (exits.length && emz > (zmin + zmax) / 2) {
      for (const p of map.values()) p.z = -p.z;
      for (const e of exits) e.z = -e.z;
    }
  }

  _regionLayout = map; _regionExits = exits; _regionLayoutId = regionId;
  _regionCache.set(regionId, { layout: map, exits });
  return map;
}

// ── Modern galaxy overview ────────────────────────────────────────────────────
// The whole galaxy laid out with each region's clean modern cluster placed at its
// CLASSIC centroid and rotated to the region's classic stretch direction (so the
// overall shape still reads like the classic map). Built once, cached.
let _galaxyModern = null;   // { gpos:Map(id→{x,z}), labels:[{regionId,name,x,z}], pitch }

// ── Modern layout: hand-curated (saved) vs algorithmic ────────────────────────
// The in-app layout editor that used to write these is gone (the layout is
// finished — see modern-map-layout.json), but loading + applying a
// previously-saved layout still lives here permanently: it wins over the
// algorithm wholesale, every load, via _buildGalaxyModern() below.
let _savedModernLayout = null;    // parsed userData layout (null = algorithmic)

function _modernLayoutFromSaved(saved) {
  try {
    if (!saved || !saved.systems) return null;
    const gpos = new Map();
    for (const [id, xz] of Object.entries(saved.systems)) {
      if (Array.isArray(xz) && xz.length === 2) gpos.set(Number(id), { x: xz[0], z: xz[1] });
    }
    if (!gpos.size) return null;
    const labels = Array.isArray(saved.labels) ? saved.labels : [];
    console.log(`[map] modern layout: using CUSTOM saved layout (${gpos.size} systems)`);
    return { gpos, labels, pitch: Number(saved.pitch) || 22 };
  } catch (_) { return null; }
}

// Dominant-axis angle of a point cloud (2-D PCA) — used to orient each cluster.
function _pcaAngle(pts) {
  const n = pts.length; if (n < 2) return Math.PI / 2;
  let mx = 0, mz = 0; for (const p of pts) { mx += p.x; mz += p.z; } mx /= n; mz /= n;
  let cxx = 0, cxz = 0, czz = 0;
  for (const p of pts) { const dx = p.x - mx, dz = p.z - mz; cxx += dx * dx; cxz += dx * dz; czz += dz * dz; }
  return 0.5 * Math.atan2(2 * cxz, cxx - czz);
}

// Per-region force layout — the reference 2D-mode look. Springs pull EVERY
// gate link toward one uniform rest length (so squares render as squares and
// chains as even ladders), a spatial-hash collision pass keeps systems from
// touching, and seeding from the true star positions keeps the drawing nearly
// crossing-free. Returns Map(id → {x, z}) in rest-length units, centred.
function _regionForceLayout(ids, adjAll) {
  const out = new Map();
  const n = ids.length;
  if (!n) return out;
  const index = new Map(ids.map((id, i) => [id, i]));

  // Seed from true positions, scaled so the median gate edge starts near 1.
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = _sysById[ids[i]];
    px[i] = s ? s.wx : 0; pz[i] = s ? s.wz : 0;
  }
  const ea = [], eb = [];
  for (let i = 0; i < n; i++) {
    for (const v of (adjAll.get(ids[i]) || [])) {
      const j = index.get(v);
      if (j !== undefined && j > i) { ea.push(i); eb.push(j); }
    }
  }
  const seedLens = ea.map((a, e) => Math.hypot(px[eb[e]] - px[a], pz[eb[e]] - pz[a])).sort((x, y) => x - y);
  const med = seedLens.length ? (seedLens[Math.floor(seedLens.length / 2)] || 1) : 1;
  for (let i = 0; i < n; i++) { px[i] /= med; pz[i] /= med; }

  const MIND = 0.8;   // no two systems closer than 80% of an edge length
  for (let it = 0; it < 220; it++) {
    const step = 0.05 + 0.25 * (1 - it / 220);   // cooling
    // Uniform-length springs (both directions: long edges contract, short expand).
    for (let e = 0; e < ea.length; e++) {
      const a = ea[e], b = eb[e];
      let dx = px[b] - px[a], dz = pz[b] - pz[a];
      const d = Math.hypot(dx, dz) || 0.001;
      const f = ((d - 1) / d) * 0.5 * step;
      dx *= f; dz *= f;
      px[a] += dx; pz[a] += dz; px[b] -= dx; pz[b] -= dz;
    }
    // Collision repulsion via spatial hash (only neighbouring cells checked).
    const cell = new Map();
    for (let i = 0; i < n; i++) {
      const k = Math.round(px[i]) + ':' + Math.round(pz[i]);
      const bucket = cell.get(k);
      if (bucket) bucket.push(i); else cell.set(k, [i]);
    }
    for (let i = 0; i < n; i++) {
      const cx0 = Math.round(px[i]), cz0 = Math.round(pz[i]);
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
        const bucket = cell.get((cx0 + gx) + ':' + (cz0 + gz));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          let dx = px[j] - px[i], dz = pz[j] - pz[i];
          const d = Math.hypot(dx, dz) || 0.001;
          if (d >= MIND) continue;
          const f = ((MIND - d) / d) * 0.5 * step;
          dx *= f; dz *= f;
          px[i] -= dx; pz[i] -= dz; px[j] += dx; pz[j] += dz;
        }
      }
    }
  }

  // ── Rectification — the reference's "clean" look ──────────────────────────
  // Snap every node onto the integer grid (high-degree hubs first, spiralling
  // to the nearest free cell on collision). Gate neighbours end up 1 cell or a
  // diagonal apart, so edges render as straight horizontals / verticals / 45°s
  // instead of the organic squiggle the raw force layout produces.
  const keyOf = (gx, gz) => gx + ':' + gz;
  const taken = new Map();
  const degree = new Array(n).fill(0);
  for (let e = 0; e < ea.length; e++) { degree[ea[e]]++; degree[eb[e]]++; }
  const orderIdx = [...Array(n).keys()].sort((a, b) => degree[b] - degree[a]);
  for (const i of orderIdx) {
    let gx = Math.round(px[i]), gz = Math.round(pz[i]);
    if (taken.has(keyOf(gx, gz))) {
      let found = false;
      for (let r = 1; r <= 6 && !found; r++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          for (let dz = -r; dz <= r && !found; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            if (!taken.has(keyOf(gx + dx, gz + dz))) { gx += dx; gz += dz; found = true; }
          }
        }
      }
    }
    taken.set(keyOf(gx, gz), i);
    px[i] = gx; pz[i] = gz;
  }

  // Greedy octilinear polish: nudge each node into a neighbouring free cell
  // when that makes its edges shorter and closer to the 8 compass directions.
  const inc = Array.from({ length: n }, () => []);
  for (let e = 0; e < ea.length; e++) { inc[ea[e]].push(e); inc[eb[e]].push(e); }
  const EIGHTH = Math.PI / 4;
  const nodeCost = (i, x, z) => {
    let c = 0;
    for (const e of inc[i]) {
      const j = ea[e] === i ? eb[e] : ea[e];
      const dx = px[j] - x, dz = pz[j] - z;
      const d = Math.hypot(dx, dz) || 0.001;
      c += Math.abs(d - 1);                                        // uniform length
      const a = Math.atan2(dz, dx);
      c += Math.abs(a - Math.round(a / EIGHTH) * EIGHTH) * 0.8;    // octilinearity
    }
    return c;
  };
  const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const i of orderIdx) {
      let bestX = px[i], bestZ = pz[i], bestC = nodeCost(i, px[i], pz[i]);
      for (const [dx, dz] of DIRS8) {
        const nx = px[i] + dx, nz = pz[i] + dz;
        if (taken.has(keyOf(nx, nz))) continue;
        const c = nodeCost(i, nx, nz);
        if (c < bestC - 1e-6) { bestC = c; bestX = nx; bestZ = nz; }
      }
      if (bestX !== px[i] || bestZ !== pz[i]) {
        taken.delete(keyOf(px[i], pz[i]));
        taken.set(keyOf(bestX, bestZ), i);
        px[i] = bestX; pz[i] = bestZ;
      }
    }
  }

  let mx = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += px[i]; mz += pz[i]; }
  mx /= n; mz /= n;
  for (let i = 0; i < n; i++) out.set(ids[i], { x: px[i] - mx, z: pz[i] - mz });
  return out;
}

// Pochven is one 27-system ring (three Triglavian clades) — the force layout
// draws it as a wobbly loop. Present it as the iconic triangle instead:
// Kino at the top, Niarja right, Archee left, the rest spaced evenly along
// the sides by walking the actual gate ring. Returns Map(id → {x,z}) in world
// units, or null when the ring/corners can't be resolved (→ force layout).
function _pochvenTriangleLayout(sys, GRID_UNIT) {
  const byName = new Map(sys.map(s => [String(s.name || '').trim().toLowerCase(), s]));
  const kino = byName.get('kino'), niarja = byName.get('niarja'), archee = byName.get('archee');
  if (!kino || !niarja || !archee) return null;

  // Ring order = ANGULAR order around the region centroid. Pochven's gate
  // graph has extra chords at the clade borders (the corner knots in the
  // reference), which dead-end a naive graph walk — but the seed positions
  // already form a clean ring, so geometry gives the cycle robustly.
  let cx = 0, cz = 0;
  for (const s of sys) { cx += s.wx; cz += s.wz; }
  cx /= sys.length; cz /= sys.length;
  const ordered = [...sys].sort((a, b) =>
    Math.atan2(a.wz - cz, a.wx - cx) - Math.atan2(b.wz - cz, b.wx - cx));

  let seq = ordered.map(s => s.id);
  const rot = seq.indexOf(kino.id);
  seq = [...seq.slice(rot), ...seq.slice(0, rot)];
  if (seq.indexOf(niarja.id) > seq.indexOf(archee.id)) {
    seq = [seq[0], ...seq.slice(1).reverse()];
  }
  const jN = seq.indexOf(niarja.id), jA = seq.indexOf(archee.id);
  if (jN <= 0 || jA <= jN) return null;

  const Rr = (sys.length / 3) * GRID_UNIT * 0.9;      // circumradius — roomy, clean sides
  const C = [
    { x: 0,            z: -Rr       },   // Kino — top
    { x: Rr * 0.866,   z: Rr * 0.5  },   // Niarja — right
    { x: -Rr * 0.866,  z: Rr * 0.5  },   // Archee — left
  ];
  const pos = new Map();
  const side = (from, to, a, b, includeEnd) => {
    const steps = to - from + (includeEnd ? 0 : 1);
    for (let k = 0; k <= to - from; k++) {
      const t = steps ? k / steps : 0;
      pos.set(seq[from + k], { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  };
  side(0,  jN, C[0], C[1], true);                 // Kino → Niarja
  side(jN, jA, C[1], C[2], true);                 // Niarja → Archee
  side(jA, seq.length - 1, C[2], C[0], false);    // Archee → (short of) Kino

  let mx = 0, mz = 0;
  for (const p of pos.values()) { mx += p.x; mz += p.z; }
  mx /= pos.size; mz /= pos.size;
  for (const p of pos.values()) { p.x -= mx; p.z -= mz; }
  return pos;
}

function _buildGalaxyModern() {
  // Only trust the cache once it actually has content. _onResize() can call
  // this (via _fitGalaxyModern) from a ResizeObserver callback that fires as
  // soon as the map viewport gets laid out — which can happen before galaxy
  // data (and _regionCentroids) has finished loading. Without this guard, that
  // premature call would build an empty result and cache it permanently (the
  // real data loading afterwards would never re-trigger a rebuild), which is
  // exactly what a blank Modern map with no systems/regions/hint text was.
  if (_galaxyModern && _galaxyModern.gpos.size) return _galaxyModern;
  // A hand-curated saved layout (the in-app editor) beats the algorithm.
  const custom = _modernLayoutFromSaved(_savedModernLayout);
  if (custom) { _galaxyModern = custom; return _galaxyModern; }
  console.log('[map] modern flat layout v9 — Pochven rose, Exordium newbie-blue pinned below');
  const gpos = new Map(), labels = [];
  // The three Jove regions are unreachable by players and render as degenerate
  // streaks — the reference map filters them out too.
  const JOVE = new Set(['A821-A', 'J7HZ-F', 'UUA-F4']);
  const rids = Object.keys(_regionCentroids).map(Number)
    .filter(r => r < 11000000 && _regions[r] && !JOVE.has(_regions[r]));

  // CCP flat-map look (in-game "flattened" style):
  //   • one dot pitch everywhere (GRID_UNIT) — a region's footprint follows its
  //     system count, never the local crowding;
  //   • systems arranged as per-CONSTELLATION mini-grids, packed around the
  //     region centre, so every region reads as a knot of small tidy clumps;
  //   • regions pushed apart until the voids between clusters are proportional
  //     to the clusters themselves (the "islands in space" texture), with a
  //     gentle homing pull so New Eden's overall geography survives.
  const GRID_UNIT = 22;   // world units between adjacent systems, everywhere

  // Global k-space gate adjacency (feeds every constellation mini-grid).
  const adjAll = new Map();
  for (const j of _jumps) {
    const a = _sysById[j.from], b = _sysById[j.to];
    if (!a || !b) continue;
    if (!adjAll.has(j.from)) adjAll.set(j.from, []);
    adjAll.get(j.from).push(j.to);
  }

  // 1) Per region: constellation clumps → local relaxation into one cluster.
  const clusters = [];
  for (const r of rids) {
    const sys = _systems.filter(s => s.regionId === r && s.id < 31000000);
    if (!sys.length) continue;

    // One force layout over the whole region: every gate edge relaxes to the
    // same length, so the region reads as a single clean circuit diagram
    // (constellations emerge as natural knots because the seed positions and
    // gate topology already cluster them — no explicit clump machinery).
    // Pochven is special-cased: its 27-system gate ring renders as the iconic
    // triangle (Kino top, Niarja right, Archee left) instead of a wobbly loop.
    const local = new Map();
    let rad = 1;
    const triangle = (_regions[r] === 'Pochven') ? _pochvenTriangleLayout(sys, GRID_UNIT) : null;
    if (_regions[r] === 'Pochven') console.log('[map] Pochven triangle:', triangle ? 'applied' : 'FELL BACK to force layout');
    if (triangle) {
      for (const [id, p] of triangle) {
        local.set(id, p);
        rad = Math.max(rad, Math.hypot(p.x, p.z));
      }
    } else {
      const layout = _regionForceLayout(sys.map(s => s.id), adjAll);
      for (const [id, p] of layout) {
        const rx = p.x * GRID_UNIT, rz = p.z * GRID_UNIT;
        local.set(id, { x: rx, z: rz });
        rad = Math.max(rad, Math.hypot(rx, rz));
      }
    }
    const c = _regionCentroids[r];
    clusters.push({ r, local, rad, x: c.wx, z: c.wz, ox: c.wx, oz: c.wz });
  }

  // 2) Relaxation: separate clusters until the void between any two regions is
  //    proportional to their size — just enough to island every region while
  //    the clusters dominate the canvas. Mild homing keeps New Eden's shape.
  const need = (A, B) => (A.rad + B.rad) * 0.30 + 36;
  // Runs pair separation until a full sweep moves nothing (true convergence) or
  // the cap is hit. Returns true when fully separated — the fixed-count version
  // stopped mid-untangle after compaction, which is what left empire regions
  // interleaved on screen.
  const separate = (homing, maxIterations) => {
    for (let it = 0; it < maxIterations; it++) {
      let moved = false;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const A = clusters[i], B = clusters[j];
          const target = need(A, B);
          let dx = B.x - A.x, dz = B.z - A.z;
          const d = Math.hypot(dx, dz) || 0.001;
          if (d >= target) continue;
          const push = ((target - d) / 2) / d;
          dx *= push; dz *= push;
          A.x -= dx; A.z -= dz; B.x += dx; B.z += dz;
          moved = true;
        }
      }
      if (homing) { for (const c of clusters) { c.x += (c.ox - c.x) * 0.01; c.z += (c.oz - c.z) * 0.01; } }
      else if (!moved) return true;
    }
    return false;
  };
  separate(true, 240);    // geography-preserving spread

  // 3) Compaction: pure separation leaves the cloud at its inflated initial
  //    spread — pockets of dead air everywhere. Alternately nudge every cluster
  //    toward the cloud's centre and re-separate; equilibrium is the tightest
  //    packing the required gaps allow, while relative geography survives.
  // Fewer, gentler rounds than before: aggressive compaction buried the empire
  // core (central clusters can't move — inbound neighbours pile onto them).
  for (let round = 0; round < 14; round++) {
    let cx = 0, cz = 0;
    for (const c of clusters) { cx += c.x; cz += c.z; }
    cx /= clusters.length; cz /= clusters.length;
    for (const c of clusters) { c.x += (cx - c.x) * 0.04; c.z += (cz - c.z) * 0.04; }
    separate(false, 60);
  }
  // Final pass MUST reach zero overlap — run to convergence, generous cap.
  separate(false, 2000);

  // 4) Manual placement: Exordium (newbie space) sits directly BELOW Pochven
  //    with a little air. Both are pinned; every other cluster yields, so the
  //    no-overlap guarantee holds around the pair.
  const pochIdx = clusters.findIndex(c => _regions[c.r] === 'Pochven');
  const exoIdx  = clusters.findIndex(c => _regions[c.r] === 'Exordium');
  if (pochIdx >= 0 && exoIdx >= 0) {
    const P = clusters[pochIdx], E = clusters[exoIdx];
    E.x = P.x;
    E.z = P.z + P.rad + E.rad + 70;
    const pinned = new Set([pochIdx, exoIdx]);
    for (let it = 0; it < 800; it++) {
      let moved = false;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          if (pinned.has(i) && pinned.has(j)) continue;   // the pair keeps its manual gap
          const A = clusters[i], B = clusters[j];
          const target = need(A, B);
          let dx = B.x - A.x, dz = B.z - A.z;
          const d = Math.hypot(dx, dz) || 0.001;
          if (d >= target) continue;
          const push = (target - d) / d;
          if (pinned.has(i))      { B.x += dx * push;     B.z += dz * push; }
          else if (pinned.has(j)) { A.x -= dx * push;     A.z -= dz * push; }
          else {
            A.x -= dx * push / 2; A.z -= dz * push / 2;
            B.x += dx * push / 2; B.z += dz * push / 2;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  // 3) Refit the relaxed cloud into the world box and emit final positions.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of clusters) {
    minX = Math.min(minX, c.x - c.rad); maxX = Math.max(maxX, c.x + c.rad);
    minZ = Math.min(minZ, c.z - c.rad); maxZ = Math.max(maxZ, c.z + c.rad);
  }
  const s = Math.min(_MAP_WORLD / ((maxX - minX) || 1), _MAP_WORLD / ((maxZ - minZ) || 1));
  for (const c of clusters) {
    const cx = (c.x - minX) * s, cz = (c.z - minZ) * s;
    for (const [id, p] of c.local) gpos.set(id, { x: cx + p.x * s, z: cz + p.z * s });
    labels.push({ regionId: c.r, name: _regions[c.r], x: cx, z: cz });
  }
  // Final dot pitch in world units — the renderer sizes dots from this so
  // neighbouring systems can never merge into a blob at any refit scale.
  _galaxyModern = { gpos, labels, pitch: GRID_UNIT * s };
  return _galaxyModern;
}

// Fit the galaxy-overview cluster cloud to the viewport.
function _fitGalaxyModern() {
  const g = _buildGalaxyModern();
  if (!_canvas || !g.gpos.size) { _fitGalaxy(); return; }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of g.gpos.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const w = (maxX - minX) || 1, h = (maxZ - minZ) || 1, pad = 40;
  _zoom = Math.min((_canvas.width - pad * 2) / w, (_canvas.height - pad * 2) / h);
  _panX = (_canvas.width  - w * _zoom) / 2 - minX * _zoom;
  _panY = (_canvas.height - h * _zoom) / 2 - minZ * _zoom;
}

// Leave a single region back to the galaxy overview.
function _backToOverview() {
  _regionView = null; _hoveredExit = null;
  _buildGalaxyModern(); _fitGalaxyModern();
  const sel = document.getElementById('mapRegionSelect');
  if (sel) sel.value = 'galaxy';
  _scheduleRender();
}

// ── Modern-view overlay drawers (galaxy overview + region view) ───────────────
// Ports of the overlays classic's _render() draws (wormhole/jump-bridge arcs,
// jump-bridge diamonds, stargate + capital routes) — feature parity for Modern,
// which used to skip all of this. `posMap` is whichever Modern position Map the
// caller is using (the overview's gp, or a region's layout); both are
// Map(systemId → {x,z}) fed through the same _w2c() the classic path uses, just
// with Modern's flattened coordinates instead of true positions. A system with
// no entry in posMap (off in another region, or w-space not part of the current
// layout) is simply skipped — same net effect as classic's explicit ID checks.
function _drawModernWormholeArcs(ctx, W, H, posMap) {
  if (!(_showWh && _whArcEdges && _whArcEdges.length)) return;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(0.8, Math.min(2.4, _zoom * 2.4));
  ctx.strokeStyle = 'rgba(138,43,196,0.7)';
  ctx.shadowColor = 'rgba(138,43,196,0.45)';
  ctx.shadowBlur  = 4;
  for (const [ida, idb] of _whArcEdges) {
    const a = posMap.get(ida), b = posMap.get(idb);
    if (!a || !b) continue;
    const [ax, ay] = _w2c(a.x, a.z);
    const [bx, by] = _w2c(b.x, b.z);
    if ((ax < -50 && bx < -50) || (ax > W + 50 && bx > W + 50) ||
        (ay < -50 && by < -50) || (ay > H + 50 && by > H + 50)) continue;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const arcH = Math.min(len * 0.16, 120);
    const cpx = (ax + bx) / 2 + (-dy / len) * arcH;
    const cpy = (ay + by) / 2 + ( dx / len) * arcH;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(cpx, cpy, bx, by);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.lineCap = 'butt';
}

function _drawModernJumpBridgeArcs(ctx, W, H, posMap) {
  if (!(_showJb && _savedBridges.length)) return;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, Math.min(3, _zoom * 3));
  for (const [ida, idb] of _savedBridges) {
    const a = posMap.get(ida), b = posMap.get(idb);
    if (!a || !b) continue;
    const [ax, ay] = _w2c(a.x, a.z);
    const [bx, by] = _w2c(b.x, b.z);
    if ((ax < -50 && bx < -50) || (ax > W + 50 && bx > W + 50) ||
        (ay < -50 && by < -50) || (ay > H + 50 && by > H + 50)) continue;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const arcH = Math.min(len * 0.18, 140);
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

// Stargate route (light blue) + capital jump route (pink arcs) — whichever
// planner last produced a result, drawn exactly like classic's version.
function _drawModernRoutes(ctx, W, H, posMap) {
  if (_routeIds && _routeIds.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(96,200,255,0.95)';
    ctx.lineWidth   = Math.max(1.5, Math.min(4, _zoom * 4));
    ctx.lineCap     = 'round';
    for (let i = 1; i < _routeIds.length; i++) {
      const a = posMap.get(_routeIds[i - 1]), b = posMap.get(_routeIds[i]);
      if (!a || !b) continue;
      const [ax, ay] = _w2c(a.x, a.z);
      const [bx, by] = _w2c(b.x, b.z);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  if (_jumpRouteIds && _jumpRouteIds.length > 1) {
    ctx.lineCap   = 'round';
    ctx.lineWidth = Math.max(1.5, Math.min(4, _zoom * 4));
    for (let i = 1; i < _jumpRouteIds.length; i++) {
      const a = posMap.get(_jumpRouteIds[i - 1]), b = posMap.get(_jumpRouteIds[i]);
      if (!a || !b) continue;
      const [ax, ay] = _w2c(a.x, a.z);
      const [bx, by] = _w2c(b.x, b.z);
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
}

// Per-system markers drawn inline in the dot-drawing loop of both Modern
// sub-views: the gold IHUB/jump-bridge diamond outline and the incursion ring.
function _drawModernSystemMarkers(ctx, cx, cy, dotR, sysId) {
  if (_showJb && _jbSet.has(sysId)) {
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
  if (_overlay !== 'incursions' && _incSet.has(sysId)) {
    ctx.beginPath();
    ctx.arc(cx, cy, dotR * 2.4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(220,60,150,0.5)';
    ctx.lineWidth   = Math.max(0.4, dotR * 0.5);
    ctx.stroke();
  }
}

// Route start/end/waypoint markers (reuses _drawRouteMarkers with a Modern
// posOf), pending travel endpoints (start/destination set but no route
// computed yet), and the "you are here" indicator — fresh code rather than
// extracted from classic's _render(), so classic's existing block is never
// touched. posMap is the caller's gp (overview) or layout (region).
function _drawModernRouteExtras(ctx, W, H, posMap) {
  const posOf = (s) => { const p = posMap.get(s.id); return p ? [p.x, p.z] : [s.wx, s.wz]; };

  _drawRouteMarkers(ctx, W, H, _routeIds,     _routeWaypointIds,     '#60c8ff', '#9fd4ff', 7, -14, posOf);
  _drawRouteMarkers(ctx, W, H, _jumpRouteIds, _jumpRouteWaypointIds, '#f078c8', '#ffb0e0', 9,  18, posOf);

  for (const [pid, label, col] of [[_travelStart, 'start', '#4ee37a'], [_travelEnd, 'destination', '#e3a84d']]) {
    if (!pid || (_routeIds && _routeIds.includes(pid)) || (_jumpRouteIds && _jumpRouteIds.includes(pid))) continue;
    const s = _sysById[pid]; if (!s) continue;
    const [wx, wz] = posOf(s);
    const [cx, cy] = _w2c(wx, wz);
    if (cx < -30 || cx > W + 30 || cy < -30 || cy > H + 30) continue;
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = col; ctx.font = _mono(11, 'bold');
    ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
    ctx.fillText(`${s.name} (${label})`, cx, cy - 14);
    ctx.shadowBlur = 0; ctx.textAlign = 'left';
  }

  if (_youHereId && _sysById[_youHereId]) {
    const s = _sysById[_youHereId];
    const [wx, wz] = posOf(s);
    const [cx, cy] = _w2c(wx, wz);
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
      ctx.font        = _mono(11, 'bold');
      ctx.textAlign   = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
      ctx.fillText('◉ YOU', cx, cy + 18);
      ctx.shadowBlur = 0;
      ctx.textAlign   = 'left';
    }
  }
}

function _renderGalaxyModern() {
  const ctx = _ctx, W = _canvas.width, H = _canvas.height;
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, W, H);
  const g = _buildGalaxyModern(), gp = g.gpos;
  if (!gp.size) return;

  _drawInfluenceField(ctx, W, H, id => gp.get(id));

  const off = (ax, ay, bx, by) => (ax < -40 && bx < -40) || (ax > W + 40 && bx > W + 40) || (ay < -40 && by < -40) || (ay > H + 40 && by > H + 40);
  const lineW = Math.max(0.12, Math.min(1.1, _zoom * 22));

  // Links fade with distance, sharpen with zoom (reference behaviour: quiet
  // threads at the overview, a crisp legible circuit once you're in a region).
  const pitchPxL   = (g.pitch || 22) * _zoom;
  const intraAlpha = Math.max(0.14, Math.min(0.42, 0.10 + pitchPxL * 0.010));
  const interAlpha = Math.max(0.08, Math.min(0.22, 0.06 + pitchPxL * 0.004));

  // Intra-region links (subtle grey) then inter-region gates (long faint threads —
  // CCP flat-map style, where the dots carry the picture and lines stay quiet).
  ctx.strokeStyle = `rgba(150,160,176,${intraAlpha})`; ctx.lineWidth = lineW; ctx.beginPath();
  for (const j of _jumps) {
    const a = gp.get(j.from), b = gp.get(j.to); if (!a || !b) continue;
    const sa = _sysById[j.from], sb = _sysById[j.to]; if (!sa || !sb || sa.regionId !== sb.regionId) continue;
    const [ax, ay] = _w2c(a.x, a.z), [bx, by] = _w2c(b.x, b.z); if (off(ax, ay, bx, by)) continue;
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  }
  ctx.stroke();
  ctx.strokeStyle = `rgba(170,190,220,${interAlpha})`; ctx.lineWidth = Math.max(0.2, lineW * 0.7); ctx.beginPath();
  for (const j of _jumps) {
    if (j.from > j.to) continue;
    const a = gp.get(j.from), b = gp.get(j.to); if (!a || !b) continue;
    const sa = _sysById[j.from], sb = _sysById[j.to]; if (!sa || !sb || sa.regionId === sb.regionId) continue;
    const [ax, ay] = _w2c(a.x, a.z), [bx, by] = _w2c(b.x, b.z); if (off(ax, ay, bx, by)) continue;
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  }
  ctx.stroke();

  // Overlays ported from classic's render path — wormhole/jump-bridge arcs,
  // then routes on top, same draw order as classic (see _render()).
  _drawModernWormholeArcs(ctx, W, H, gp);
  _drawModernJumpBridgeArcs(ctx, W, H, gp);
  _drawModernRoutes(ctx, W, H, gp);

  // System dots — sized from the layout's actual pitch so two neighbouring
  // systems can never overlap into a smudge, at any zoom or refit scale.
  const pitchPx = (g.pitch || 22) * _zoom;
  const dotR = Math.max(0.7, Math.min(3.5, pitchPx * 0.22));
  for (const [id, p] of gp) {
    const s = _sysById[id]; if (!s) continue;
    const [cx, cy] = _w2c(p.x, p.z);
    if (cx < -8 || cx > W + 8 || cy < -8 || cy > H + 8) continue;
    ctx.beginPath(); ctx.arc(cx, cy, dotR, 0, Math.PI * 2); ctx.fillStyle = _systemColor(s); ctx.fill();
    _drawModernSystemMarkers(ctx, cx, cy, dotR, id);
  }

  // Region labels at the cluster centres (highlight the one under the cursor).
  // Hidden while the influence field is up — its territory titles sit in the same
  // place and say more; the hovered region still highlights via its cluster.
  const regionFs = Math.max(9, Math.min(15, _zoom * 30));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = _mono(regionFs, 'bold');
  if (!_infActive()) for (const lb of g.labels) {
    const [lx, ly] = _w2c(lb.x, lb.z);
    if (lx < -80 || lx > W + 80 || ly < -30 || ly > H + 30) continue;
    // 0.56 over the #07080c backdrop lands at 4.8:1 — these are the overview's
    // primary wayfinding labels and regionFs bottoms out at 9px, so they have to
    // clear 4.5:1 as normal text, not ride the large-text exemption.
    ctx.fillStyle = (_hoveredRegion === lb.regionId) ? 'rgba(245,215,150,1)' : 'rgba(205,215,235,0.56)';
    ctx.shadowColor = 'rgba(0,0,0,0.95)'; ctx.shadowBlur = 4;
    ctx.fillText(lb.name.toUpperCase(), lx, ly);
    ctx.shadowBlur = 0;
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

  _drawInfluenceTitles(ctx, W, H, regionFs, 9, 15);   // matches regionFs' own clamp

  // Route markers + pending-endpoint + "you are here" — drawn last, on top of
  // everything, same order as classic's equivalent block.
  _drawModernRouteExtras(ctx, W, H, gp);

  ctx.fillStyle = 'rgba(150,160,180,0.8)'; ctx.font = _mono(11);
  ctx.fillText('Modern galaxy overview — click a region to open it', 14, H - 14);
}

// Open the region at a fixed, overlap-free zoom: fit the layout width to the
// viewport but clamp so cell spacing never drops below the pill size (big regions
// extend past the viewport and you pan/scroll, DOTLAN-style). Align the spine top.
// Smallest zoom at which no two name pills can touch, for the region currently
// laid out: the widest pill (measured in the font the pills actually draw in)
// over the closest pair the layout produced. Cached per region — the O(n²) pass
// is a few thousand comparisons on region open, not per frame.
const REGION_PILL_GAP = 6;   // px of daylight to leave between two pills
let _regionFloor = null, _regionFloorId = null;
function _regionZoomFloor() {
  if (_regionFloorId === _regionLayoutId && _regionFloor != null) return _regionFloor;
  const pts = [..._regionLayout.values()];
  if (pts.length < 2 || !_ctx) return 0.6;

  _ctx.save();
  _ctx.font = _mono(11);                      // must match _renderRegion's pill font
  let maxPill = 0;
  for (const id of _regionLayout.keys()) {
    const s = _sysById[id];
    if (!s) continue;
    const wpx = _ctx.measureText(s.name).width + 14;   // + padX * 2
    if (wpx > maxPill) maxPill = wpx;
  }
  _ctx.restore();

  let minSep = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
      if (d < minSep) minSep = d;
    }
  }
  if (!isFinite(minSep) || minSep <= 0) return 0.6;

  _regionFloorId = _regionLayoutId;
  _regionFloor = Math.max(0.6, (maxPill + REGION_PILL_GAP) / minSep);
  return _regionFloor;
}

function _fitRegion() {
  if (!_regionLayout || !_regionLayout.size || !_canvas) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const grow = (x, z) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  };
  for (const p of _regionLayout.values()) grow(p.x, p.z);
  for (const e of (_regionExits || [])) grow(e.x, e.z);   // keep gateway boxes in frame

  const w = (maxX - minX) || 1, h = (maxZ - minZ) || 1;
  // Fit BOTH axes — fitting width alone left a tall layout running off the bottom
  // while the sides sat empty. PAD leaves room for the pills themselves (they're a
  // fixed screen size, so they overhang their point) and the title/back-link.
  const PAD_X = 150, PAD_Y = 130;
  const fit = Math.min((_canvas.width - PAD_X) / w, (_canvas.height - PAD_Y) / h);
  // Zoom floor keeps neighbouring pills off each other. It has to be measured,
  // not a constant: pills are a fixed screen size while the layout is in world
  // units, so the floor is (widest label) ÷ (tightest pair). A constant 0.6 was
  // fine for null-sec — six-character names, ~54px pills — but empire regions
  // carry names like "New Caldari" at ~87px, and 0.6 only buys 66px of gap, so
  // The Forge opened with 16 pairs of pills sitting on top of each other.
  _zoom = Math.max(_regionZoomFloor(), Math.min(1.15, fit));
  _panX = _canvas.width  / 2 - ((minX + maxX) / 2) * _zoom;
  _panY = _canvas.height / 2 - ((minZ + maxZ) / 2) * _zoom + 22;   // clear the title
}

// Exit box (if any) under a screen point — uses the screen rect each box stored on
// its last render. Returns the exit (→ click navigates to its region).
function _regionExitAt(cx, cy) {
  if (!(_viewMode === 'modern' && _regionView != null) || !_regionExits) return null;
  for (const ex of _regionExits) {
    if (ex._sx == null) continue;
    if (Math.abs(cx - ex._sx) <= ex._w / 2 && Math.abs(cy - ex._sy) <= ex._h / 2) return ex;
  }
  return null;
}

// Open a region in the Modern view: build (or reuse) its layout and fit to it.
function _enterRegion(regionId) {
  if (regionId == null) return;
  _regionView = regionId;
  _hoveredExit = null;
  _buildRegionLayout(regionId);
  _fitRegion();
  const sel = document.getElementById('mapRegionSelect');
  if (sel) sel.value = String(regionId);
}

// Leave a Modern region drill-down back to the CURRENT mode's galaxy-level view.
// Used by external entry points (route overlays, "view on map", search fly-to)
// that operate in galaxy coordinates. Used to force-switch to Classic because
// only Classic could draw galaxy-coordinate overlays — now that Modern's
// overview (_renderGalaxyModern) draws the same routes/jump-bridges/wormholes,
// this just backs out of a region (which has no "whole galaxy" context of its
// own) instead of abandoning whichever mode the user actually has open.
function _forceGalaxyView() {
  if (_regionView == null) return;   // already at a galaxy-level view, either mode
  _regionView = null;
  const sel = document.getElementById('mapRegionSelect');
  if (sel) {
    sel.style.display = (_viewMode === 'modern') ? '' : 'none';
    sel.value = 'galaxy';
  }
}

// Fill the region dropdown from loaded region data (known space only). Safe to call
// repeatedly; only fills once.
function _populateRegionSelect() {
  const sel = document.getElementById('mapRegionSelect');
  if (!sel || sel._filled || !_regions || !Object.keys(_regions).length) return;
  const opts = Object.entries(_regions)
    .map(([rid, name]) => ({ rid: Number(rid), name }))
    .filter(o => o.rid < 11000000 && o.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="galaxy">◄ Galaxy overview</option>'
    + opts.map(o => `<option value="${o.rid}">${o.name}</option>`).join('');
  sel._filled = true;
}

// Render the Modern region view: straight gate links + DOTLAN-style name pills laid
// out from the gate graph. Replaces the galaxy render entirely while a region is open.
function _renderRegion() {
  const ctx = _ctx, W = _canvas.width, H = _canvas.height;
  ctx.fillStyle = '#12141a';
  ctx.fillRect(0, 0, W, H);

  const layout = _regionLayout;
  if (!layout || !layout.size) {
    ctx.fillStyle = 'rgba(205,215,235,0.6)';
    ctx.font = _mono(14);
    ctx.textAlign = 'center';
    ctx.fillText('No systems to lay out for this region.', W / 2, H / 2);
    ctx.textAlign = 'left';
    return;
  }

  // No influence field here on purpose. It's a galaxy-scale idea — "who holds
  // what across New Eden" — and inside one region it degenerates: a region has
  // essentially one holder, so the field is a flat wash, and the region layout
  // is a schematic grid rather than real space, so the territory shape it drew
  // would be an artifact of the grid rather than anything true.

  // Gate links — thin solid grey straight lines.
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(150,160,176,0.5)';
  ctx.lineWidth   = Math.max(0.6, Math.min(1.6, _zoom * 200));
  for (const j of _jumps) {
    const a = layout.get(j.from), b = layout.get(j.to);
    if (!a || !b) continue;
    const [ax, ay] = _w2c(a.x, a.z), [bx, by] = _w2c(b.x, b.z);
    if ((ax < -60 && bx < -60) || (ax > W + 60 && bx > W + 60) ||
        (ay < -40 && by < -40) || (ay > H + 40 && by > H + 40)) continue;
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  }
  ctx.stroke();

  // Inter-region gate stubs — amber connectors out to the neighbour boxes.
  if (_regionExits.length) {
    ctx.strokeStyle = 'rgba(196,140,64,0.85)';
    ctx.lineWidth   = Math.max(0.8, Math.min(2, _zoom * 220));
    ctx.beginPath();
    for (const ex of _regionExits) {
      const ip = layout.get(ex.fromId); if (!ip) continue;
      const [ax, ay] = _w2c(ip.x, ip.z), [sx, sy] = _w2c(ex.x, ex.z);
      if ((ax < -80 && sx < -80) || (ax > W + 80 && sx > W + 80) ||
          (ay < -60 && sy < -60) || (ay > H + 60 && sy > H + 60)) continue;
      ctx.moveTo(ax, ay); ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  // Overlays ported from classic's render path — same as the galaxy overview.
  // The per-system jump-bridge diamond isn't drawn here: it's sized for a plain
  // dot and would sit oddly on these wider name pills, so the arcs + routes
  // (unaffected by that) are the parity that matters in a region view.
  _drawModernWormholeArcs(ctx, W, H, layout);
  _drawModernJumpBridgeArcs(ctx, W, H, layout);
  _drawModernRoutes(ctx, W, H, layout);

  // System pills (fixed screen size, DOTLAN-like name labels).
  const fs = 11;
  ctx.font = _mono(fs);
  ctx.textBaseline = 'middle';
  for (const [id, p] of layout) {
    const s = _sysById[id]; if (!s) continue;
    const [cx, cy] = _w2c(p.x, p.z);
    if (cx < -90 || cx > W + 90 || cy < -30 || cy > H + 30) continue;
    const border = _systemColor(s);   // respects the active overlay (sec / sov / F&F / incursions)
    const tw  = ctx.measureText(s.name).width;
    const padX = 7, padY = 4;
    const w = tw + padX * 2, h = fs + padY * 2;
    _pillPath(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fillStyle = 'rgba(38,40,50,0.96)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = border;
    ctx.stroke();
    if (_selected && _selected.id === id) { ctx.lineWidth = 2.5; ctx.strokeStyle = '#e0b34a'; ctx.stroke(); }
    else if (_hovered && _hovered.id === id) { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke(); }
    ctx.fillStyle = 'rgba(226,231,240,0.96)';
    ctx.textAlign = 'center';
    ctx.fillText(s.name, cx, cy);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Inter-region gate stub boxes — clickable links to the neighbouring region.
  if (_regionExits.length) {
    const efs = 10;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const ex of _regionExits) {
      const [sx, sy] = _w2c(ex.x, ex.z);
      ctx.font = _mono(efs);
      const tw1 = ctx.measureText(ex.name).width;
      ctx.font = _mono(efs - 1);
      const tw2 = ctx.measureText(ex.regionName + '  ▸').width;
      const w = Math.max(tw1, tw2) + 16, h = efs * 2 + 10;
      ex._sx = sx; ex._sy = sy; ex._w = w; ex._h = h;   // remembered for click hit-testing
      if (sx < -100 || sx > W + 100 || sy < -50 || sy > H + 50) continue;
      const hot = _hoveredExit === ex;
      _pillPath(ctx, sx - w / 2, sy - h / 2, w, h, 4);
      ctx.fillStyle = hot ? 'rgba(46,38,24,0.98)' : 'rgba(26,24,28,0.97)';
      ctx.fill();
      ctx.lineWidth = hot ? 1.8 : 1.2;
      ctx.strokeStyle = hot ? 'rgba(240,190,110,1)' : 'rgba(196,140,64,0.9)';
      ctx.stroke();
      ctx.font = _mono(efs);
      ctx.fillStyle = 'rgba(232,234,242,0.96)';
      ctx.fillText(ex.name, sx, sy - efs * 0.55);
      ctx.font = _mono(efs - 1);
      ctx.fillStyle = hot ? 'rgba(240,200,140,1)' : 'rgba(204,158,96,0.95)';
      ctx.fillText(ex.regionName + '  ▸', sx, sy + efs * 0.6);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // Route markers + pending-endpoint + "you are here" — drawn last (bar the
  // title/back-link below), same order as classic's equivalent block.
  _drawModernRouteExtras(ctx, W, H, layout);

  // Title + back link + hint.
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(210,218,236,0.92)';
  ctx.font = _mono(14, 'bold');
  ctx.fillText(`${_regions[_regionView] || 'Region'} · ${layout.size} systems`, 14, 24);
  // Clickable "◄ Galaxy overview" link (rect remembered for hit-testing).
  ctx.font = _mono(12);
  const back = '◄ Galaxy overview';
  ctx.fillStyle = 'rgba(150,190,235,0.95)';
  ctx.fillText(back, 14, 44);
  _regionBackRect = { x: 12, y: 32, w: ctx.measureText(back).width + 4, h: 18 };
  ctx.fillStyle = 'rgba(150,160,180,0.7)';
  ctx.font = _mono(11);
  ctx.fillText('Click an amber gateway box to jump to a neighbouring region', 14, 62);
  ctx.shadowBlur = 0;
}

function _render() {
  _rafPending = false;
  if (!_canvas || !_ctx || !_systems.length) return;
  _refreshThemeVars();   // once per frame — every _mono()/_accent() below reads it
  // Modern takes over the whole canvas (its own coordinate space): a single region
  // when one is open, otherwise the galaxy overview of all region clusters.
  if (_viewMode === 'modern' && _regionView != null) { _renderRegion(); return; }
  if (_viewMode === 'modern') { _renderGalaxyModern(); return; }

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
  const _modern = _viewMode === 'modern';

  // Background — classic: pure black (in-game star map). Modern: a flat dark slate
  // for the schematic DOTLAN-style panel look.
  ctx.fillStyle = _modern ? '#12141a' : '#000000';
  ctx.fillRect(0, 0, W, H);

  _drawInfluenceField(ctx, W, H, id => _sysById[id] && { x: _sysById[id].wx, z: _sysById[id].wz });

  // ── Jump connections ────────────────────────────────────────────────────────
  // Two passes: ordinary intra-region gates as faint grey dashed lines, and
  // regional (cross-region) "smuggler" gates as solid dark maroon so they stand out.
  const _offscreen = (ax, ay, bx, by) =>
    (ax < -50 && bx < -50) || (ax > W + 50 && bx > W + 50) ||
    (ay < -50 && by < -50) || (ay > H + 50 && by > H + 50);

  if (_modern) {
    // Modern view: flat solid straight gate links (no glow), replacing the classic
    // dashed/maroon passes.
    _drawModernLinks(ctx, W, H, lineW);
  } else {
    // 1. Normal gates — faint grey dashed.
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(150,160,180,0.18)';
    ctx.lineWidth   = lineW;
    ctx.setLineDash([3.5, 4.5]);
    for (const j of _jumps) {
      const a = _sysById[j.from], b = _sysById[j.to];
      if (!a || !b || a.regionId !== b.regionId) continue;   // cross-region drawn below
      const [ax, ay] = _w2c(a.wx, a.wz);
      const [bx, by] = _w2c(b.wx, b.wz);
      if (_offscreen(ax, ay, bx, by)) continue;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Regional smuggler gates (cross-region) — solid dark purple.
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(58, 10, 44, 0.78)';
    ctx.lineWidth   = Math.max(lineW * 1.3, 0.75);
    for (const j of _jumps) {
      const a = _sysById[j.from], b = _sysById[j.to];
      if (!a || !b || a.regionId === b.regionId) continue;   // only cross-region
      const [ax, ay] = _w2c(a.wx, a.wz);
      const [bx, by] = _w2c(b.wx, b.wz);
      if (_offscreen(ax, ay, bx, by)) continue;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
  }

  // ── Wormhole connection arcs (EvE-Scout public API) ─────────────────────────
  // Every Thera/Turnur/J-space connection drawn as a dark-purple arc, exactly like
  // the jump-bridge arcs. Tied to the "Wormholes" toolbar toggle.
  if (_showWh && _whArcEdges && _whArcEdges.length) {
    ctx.lineCap   = 'round';
    ctx.lineWidth = Math.max(0.8, Math.min(2.4, _zoom * 2.4));
    ctx.strokeStyle = 'rgba(138,43,196,0.7)';
    ctx.shadowColor = 'rgba(138,43,196,0.45)';
    ctx.shadowBlur  = 4;
    for (const [ida, idb] of _whArcEdges) {
      const a = _sysById[ida], b = _sysById[idb];
      if (!a || !b) continue;
      const [ax, ay] = _w2c(a.wx, a.wz);
      const [bx, by] = _w2c(b.wx, b.wz);
      if ((ax < -50 && bx < -50) || (ax > W + 50 && bx > W + 50) ||
          (ay < -50 && by < -50) || (ay > H + 50 && by > H + 50)) continue;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const arcH = Math.min(len * 0.16, 120);
      const cpx = (ax + bx) / 2 + (-dy / len) * arcH;
      const cpy = (ay + by) / 2 + ( dx / len) * arcH;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cpx, cpy, bx, by);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.lineCap = 'butt';
  }

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
      // A hop into the J-space grid sits far off the k-space map — leave a gap
      // rather than shooting a line off-screen. Thera is pinned by Turnur, so it
      // draws normally.
      if ((a.id >= 31000000 && a.id !== _THERA_ID) || (b.id >= 31000000 && b.id !== _THERA_ID)) continue;
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

  // Identify Pochven (Triglavian) once so those systems can render as triangles.
  _resolveSpecialRegionIds();

  // ── System glyphs ──────────────────────────────────────────────────────────
  for (const s of _systems) {
    const [cx, cy] = _w2c(s.wx, s.wz);
    const margin = dotR * 4;
    if (cx < -margin || cx > W + margin) continue;
    if (cy < -margin || cy > H + margin) continue;

    // Overlay colour (shared with the modern territory field).
    const col = _systemColor(s);

    // Node glyph: a dot by default; special systems get distinct polygons —
    //   Pochven (Triglavian) → triangle, Thera/Turnur → pentagon, Zarzakh → hexagon.
    ctx.beginPath();
    const r = dotR * 1.7;
    if      (s.id === _ZARZAKH_ID)            _regularPolyPath(ctx, cx, cy, r, 6); // Zarzakh
    else if (_PENTAGON_SYS.has(s.id))         _regularPolyPath(ctx, cx, cy, r, 5); // Thera / Turnur
    else if (s.regionId === _pochvenRegionId) _regularPolyPath(ctx, cx, cy, r, 3); // Pochven
    else                                      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    // Modern view: a thin flat outline crisps the node edge against the slate
    // background (no glow), once dots are big enough to read it.
    if (_modern && dotR > 1.1) {
      ctx.lineWidth   = Math.max(0.4, dotR * 0.28);
      ctx.strokeStyle = 'rgba(8,10,14,0.85)';
      ctx.stroke();
    }

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
      ctx.strokeStyle = _accent();
      ctx.lineWidth   = Math.max(0.8, dotR * 0.65);
      ctx.stroke();
    }

    // System name + security — only once zoomed in past SYS_LABEL_DOTR. Name in
    // pale mono, then the sec value in its sec colour (the in-game label style).
    if (dotR > SYS_LABEL_DOTR) {
      const fs = Math.max(8, Math.min(14, dotR * 3.2));
      ctx.font         = _mono(fs);
      ctx.shadowColor  = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 3;
      const lx = cx + dotR * 1.9 + 2, ly = cy + dotR * 0.5;
      ctx.fillStyle = 'rgba(205,215,235,0.8)';
      ctx.fillText(s.name, lx, ly);
      if (s.sec != null) {
        const nameW = ctx.measureText(s.name + ' ').width;
        ctx.fillStyle = _secColor(s.sec);
        ctx.fillText(s.sec.toFixed(1), lx + nameW, ly);
      }
      ctx.shadowBlur = 0;
    }
  }

  // ── Region labels (zoomed out, before system names take over) ───────────────
  // Shown on every overlay so the galaxy stays readable when zoomed out: region
  // names appear from the initial zoom and fade out right as system names appear
  // (dotR → SYS_LABEL_DOTR). The sovereignty overlay additionally shows the
  // dominant alliance ticker and switches earlier (dotR < 2.5).
  //
  // Suppressed entirely while the influence field is up: its territory titles
  // occupy the same space and answer the same question better, and the two sets
  // of labels stacked on one another was just noise. That takes the dominant
  // ticker with it — the titles already name the holder, at more length.
  const _isSov          = _overlay === 'sovereignty';
  const _regionLabelMax = _isSov ? 2.5 : SYS_LABEL_DOTR;
  if (dotR < _regionLabelMax && !_infActive()) {
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

      // Region name — uppercase, letter-spaced mono (new in-game map style)
      ctx.font          = _mono(rfs);
      ctx.letterSpacing = `${Math.max(1, rfs * 0.2)}px`;
      ctx.fillStyle     = 'rgba(205,215,235,0.62)';
      ctx.shadowColor   = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur    = 4;
      ctx.fillText(regionName.toUpperCase(), lcx, lcy - gap);
      ctx.letterSpacing = '0px';

      // Dominant sov ticker / name — bold, alliance colour (sovereignty only)
      if (dom && dom.label) {
        ctx.font      = _mono(lfs, 'bold');
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

  // Territory titles ride the same size curve as the region titles above, but
  // outside the `dotR < _regionLabelMax` gate: region names hand over to system
  // names as you zoom in, whereas "who owns this" is the one thing you still
  // want answered once you're down among the systems.
  _drawInfluenceTitles(ctx, W, H, Math.max(10, Math.min(14, _zoom * _MAP_WORLD / 85)), 10, 14);

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
    ctx.fillStyle = col; ctx.font = _mono(11, 'bold');
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
      ctx.font        = _mono(11, 'bold');
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
// posOf(system) -> [wx,wz] defaults to classic's true position, so the
// existing classic call site (inside _render(), unchanged) behaves exactly as
// before. Modern's render functions pass their own posMap-backed lookup —
// see _renderGalaxyModern()/_renderRegion() — to reuse this instead of a
// second copy of the marker-drawing logic.
function _drawRouteMarkers(ctx, W, H, ids, wpSet, endCol, wpCol, endR, labelDy, posOf) {
  if (!ids || !ids.length) return;
  posOf = posOf || ((s) => [s.wx, s.wz]);
  endR = endR || 7;
  labelDy = (labelDy == null) ? -14 : labelDy;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ids.forEach((id, i) => {
    const s = _sysById[id]; if (!s) return;
    const [wx, wz] = posOf(s);
    const [cx, cy] = _w2c(wx, wz);
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
      ctx.font        = _mono(11, 'bold');
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
  // The ramp the canvas is currently painting — the panel used to always show the
  // Classic hue for a value the Modern view had drawn in a different one.
  const secColor   = (_viewMode === 'modern' ? _secColorModern : _secColor)(system.sec);
  const secDisplay = system.sec !== null ? system.sec.toFixed(1) : '—';

  // Sovereignty label (async — will update once alliance name resolves)
  let sovHtml = '<span class="map-muted">None</span>';
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
  let standingHtml = '<span class="map-muted">—</span>';
  if (sov && (sov.allianceId != null || sov.corporationId != null)) {
    if (_fnfAllianceId && sov.allianceId === _fnfAllianceId) {
      standingHtml = '<span class="map-mark-own">Your alliance</span>';
    } else {
      let st = _fnfStandings[sov.allianceId];
      if (st == null) st = _fnfStandings[sov.corporationId];
      if (st != null) {
        const cls = st >= 10 ? 'map-mark-blue-10'  : st >= 5  ? 'map-mark-blue-5'
                  : st <= -10 ? 'map-mark-red'     : st <= -5 ? 'map-mark-orange-5'
                  : 'map-muted';
        standingHtml = `<span class="${cls}">${st > 0 ? '+' : ''}${st}</span>`;
      } else {
        standingHtml = `<span class="map-muted">${_fnfLoaded ? 'Not set (neutral)' : 'open Friends &amp; Foes to load'}</span>`;
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
      <span class="map-info-value ${incursion ? 'map-mark-incursion' : 'map-muted'}">
        ${incursion ? '⚠ Active' : 'None'}
      </span>
    </div>
    <div class="map-info-row">
      <span class="map-info-label">JUMP BRIDGE</span>
      <span class="map-info-value ${jb ? 'map-mark-bridge-node' : 'map-muted'}">
        ${jb ? '◈ Bridge endpoint' : 'None'}
      </span>
    </div>
    <div class="map-info-row">
      <span class="map-info-label">SYSTEM ID</span>
      <span class="map-info-value map-muted">${system.id}</span>
    </div>
  `;

  panel.classList.remove('is-hidden');
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
  if (panel) panel.classList.add('is-hidden');
  _scheduleRender();
}

// ── Legend ────────────────────────────────────────────────────────────────────
// A pure function of what is actually on screen: (view mode, overlay, the three
// layer toggles, whether a route is plotted). It used to describe the Classic
// security ramp while the app booted into Modern and painted a different one, and
// it never mentioned the shapes, arcs or route lines at all — a legend that is
// wrong is worse than none, because it turns "I don't know" into confident
// misreading. Every handler that changes any of those inputs calls this.
function _updateLegend() {
  const el = document.getElementById('mapLegend');
  if (!el) return;

  // Swatch fills are data (a ramp value, an alliance hash), not design decisions,
  // so they are the one thing here that is legitimately inline.
  const dot  = (col) => `<span class="map-legend-dot" style="background:${col}"></span>`;
  const line = (col) => `<span class="map-legend-line" style="background:${col}"></span>`;
  const row  = (mark, label) => `<div class="map-legend-row">${mark} ${label}</div>`;
  const glyph = (g) => `<span class="map-legend-glyph" aria-hidden="true">${g}</span>`;

  // The ramp the canvas is ACTUALLY painting with, so the two can never diverge.
  const sec = _viewMode === 'modern' ? _secColorModern : _secColor;

  let html = '';

  if (_overlay === 'security') {
    html = `<div class="map-legend-title">SECURITY STATUS</div>
      ${row(dot(sec(1.0)),  '1.0 High-sec')}
      ${row(dot(sec(0.9)),  '0.9')}
      ${row(dot(sec(0.7)),  '0.7')}
      ${row(dot(sec(0.5)),  '0.5')}
      ${row(dot(sec(0.4)),  '0.4 Low-sec')}
      ${row(dot(sec(0.0)),  '0.0 Null-sec')}
      ${row(dot(sec(null)), 'W-space')}`;
  } else if (_overlay === 'sovereignty') {
    html = `<div class="map-legend-title">SOVEREIGNTY</div>
      ${row(dot('#3a8fc5'), 'Caldari State')}
      ${row(dot('#c8a020'), 'Amarr Empire')}
      ${row(dot('#28a040'), 'Gallente Fed.')}
      ${row(dot('#b84c14'), 'Minmatar Rep.')}
      ${row(dot('#4466aa'), 'Player alliance')}
      <div class="map-legend-note">Each alliance gets its own hue — the swatch is a stand-in.</div>
      ${row(dot('#111827'), 'Unclaimed')}`;
  } else if (_overlay === 'incursions') {
    html = `<div class="map-legend-title">INCURSIONS</div>
      ${row(dot('#dd44aa'), 'Infested system')}
      ${row(dot('#1c1c28'), 'Clear')}`;
  } else if (_overlay === 'fnf') {
    const note = _fnfError === 'reauth'
      ? `<div class="map-legend-note map-legend-warn">Sync and re-auth a character to load standings</div>`
      : (_fnfError === 'no-alliance'
          ? `<div class="map-legend-note">No alliance on your character</div>` : '');
    html = `<div class="map-legend-title">FRIENDS &amp; FOES</div>
      ${row(dot('#4ecbb0'), 'Your sov')}
      ${row(dot('#2e6fdb'), '+10 blue')}
      ${row(dot('#5a9be8'), '+5 blue')}
      ${row(dot('#e67e22'), '−5 orange')}
      ${row(dot('#d0263d'), '−10 red')}
      ${row(dot('#e8d44a'), 'Low-sec')}
      ${row(dot('#5b6472'), 'NPC sov')}
      ${row(dot('#cfd3db'), 'Other sov')}
      ${note}`;
  }

  // With the influence field up, _systemColor repaints every sov dot to its
  // territory's colour — so the ramp above stops describing the dots, and saying
  // so is the difference between a reading and a misreading.
  if (_infActive()) {
    html += `<div class="map-legend-note">Influence is on: system dots carry their territory's colour, not the ramp above.</div>`;
  }

  // Marks: only what is on screen right now, so this section stays short and
  // never claims something the canvas isn't drawing.
  const marks = [];
  if (_viewMode === 'modern' && _regionView == null) {
    marks.push(row(glyph('▲⬠⬡'), 'Pochven · Thera/Turnur · Zarzakh'));
  }
  if (_showJb)        marks.push(row(glyph('◆'), 'Jump-bridge endpoint'));
  if (_incSet.size)   marks.push(row(glyph('◎'), 'Incursion'));
  if (_youHereId)     marks.push(row(dot('#4ecbb0'), 'You are here'));
  if (marks.length) html += `<div class="map-legend-title map-legend-sub">MARKS</div>${marks.join('')}`;

  const lines = [ row(line('rgba(150,160,176,0.42)'), 'Stargate') ];
  lines.push(row(line('rgba(196,140,64,0.65)'), 'Regional gate'));
  if (_showJb)                     lines.push(row(line('rgba(64,220,130,0.85)'),  'Jump bridge'));
  if (_showWh)                     lines.push(row(line('rgba(138,43,196,0.7)'),   'Wormhole'));
  if (_routeIds && _routeIds.length)         lines.push(row(line('rgba(96,200,255,0.95)'), 'Stargate route'));
  if (_jumpRouteIds && _jumpRouteIds.length) lines.push(row(line('rgba(240,120,200,0.92)'), 'Jump route'));
  html += `<div class="map-legend-title map-legend-sub">LINES</div>${lines.join('')}`;

  // Freshness, not a control: the map polls on ESI's own cadence, so the honest
  // thing to show is how old this is — and to say plainly when a fetch failed
  // rather than letting an outage read as "the galaxy is unclaimed".
  const stale = _liveFail === 'both' || _liveFail === 'sov';
  const fresh = !_sovAt && !_liveFail
    ? 'Sov loading…'
    : `Sov ${_agoLabel(_sovAt)}${_liveFail ? ' · last fetch failed' : ''}`;
  html += `<div class="map-legend-fresh${stale ? ' map-legend-warn' : ''}">${fresh}</div>`;

  el.innerHTML = html;
}

// ── Search ────────────────────────────────────────────────────────────────────
// The query goes back onto the page as markup, so it has to be escaped: a pilot
// pasting "<Alliance>" should see it, not have it swallowed as a tag.
function _esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Index of the highlighted result, or -1 for "none". Kept module-level so the
// keyboard and pointer paths share one notion of what is selected.
let _searchIdx = -1;

const SEARCH_LIMIT = 12;

// Rank matches so the system you typed is the one you can hit Enter on: exact
// name first, then names that start with the query, then anything containing it,
// alphabetical within each band. `includes()` alone put Jita behind five systems
// whose names merely contain "jita".
function _searchRank(q) {
  const out = [];
  for (const s of _systems) {
    const n = s.name.toLowerCase();
    const i = n.indexOf(q);
    if (i < 0) continue;
    out.push({ s, band: n === q ? 0 : i === 0 ? 1 : 2 });
  }
  out.sort((a, b) => a.band - b.band || a.s.name.localeCompare(b.s.name));
  return out.map(o => o.s);
}

function _initSearch() {
  const input   = document.getElementById('mapSearchInput');
  const results = document.getElementById('mapSearchResults');
  if (!input || !results) return;

  const close = () => {
    results.classList.add('is-hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    _searchIdx = -1;
  };

  const options = () => Array.from(results.querySelectorAll('[data-sid]'));

  // Move the highlight, keep it in view, and tell the screen reader which option
  // is current — the input keeps focus throughout, so aria-activedescendant is
  // the only thing that announces the change.
  const highlight = idx => {
    const opts = options();
    if (!opts.length) return;
    _searchIdx = (idx + opts.length) % opts.length;
    opts.forEach((el, i) => {
      const on = i === _searchIdx;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        input.setAttribute('aria-activedescendant', el.id);
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  const choose = sys => {
    if (!sys) return;
    input.value = sys.name;
    close();
    _forceGalaxyView();   // search fly-to works in galaxy coords
    _flyTo(sys);
    _showInfo(sys);
  };

  input.addEventListener('input', () => {
    const raw = input.value.trim();
    const q   = raw.toLowerCase();
    if (!q) { close(); return; }

    const all     = _searchRank(q);
    const matches = all.slice(0, SEARCH_LIMIT);
    _searchIdx = -1;

    if (!matches.length) {
      // An empty dropdown used to look identical to having typed nothing at all.
      results.innerHTML = `<div class="map-search-empty">No systems match “${_esc(raw)}”</div>`;
    } else {
      results.innerHTML = matches
        .map((s, i) => `<div class="map-search-item" role="option" aria-selected="false" id="mapSearchOpt${i}" data-sid="${s.id}">${_esc(s.name)}</div>`)
        .join('') +
        (all.length > matches.length
          ? `<div class="map-search-more">${matches.length} of ${all.length.toLocaleString()} matches — keep typing</div>`
          : '');
    }
    results.classList.remove('is-hidden');
    input.setAttribute('aria-expanded', 'true');
  });

  results.addEventListener('click', e => {
    const item = e.target.closest('[data-sid]');
    if (!item) return;
    choose(_sysById[parseInt(item.dataset.sid, 10)]);
  });

  // Close results when clicking elsewhere
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !results.contains(e.target)) close();
  });

  input.addEventListener('keydown', e => {
    const open = !results.classList.contains('is-hidden');
    switch (e.key) {
      case 'Escape':
        if (open) { close(); } else { input.blur(); }
        e.preventDefault();
        break;
      case 'ArrowDown':
        if (open) { highlight(_searchIdx + 1); e.preventDefault(); }
        break;
      case 'ArrowUp':
        if (open) { highlight(_searchIdx - 1); e.preventDefault(); }
        break;
      case 'Home':
        if (open && _searchIdx >= 0) { highlight(0); e.preventDefault(); }
        break;
      case 'End':
        if (open && _searchIdx >= 0) { highlight(options().length - 1); e.preventDefault(); }
        break;
      case 'Enter': {
        if (!open) break;
        // No explicit highlight yet: Enter takes the top-ranked match, which is
        // the exact name whenever one exists.
        const opts = options();
        const el   = opts[_searchIdx >= 0 ? _searchIdx : 0];
        if (el) { choose(_sysById[parseInt(el.dataset.sid, 10)]); e.preventDefault(); }
        break;
      }
    }
  });
}

// Switch to the Map page and centre on a solar system by name (used by the
// calendar's moon-extraction popup). Navigates first — which lazy-inits the map on
// first visit — then polls until the system list is loaded before flying to it.
async function mapGoToSystem(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return false;
  if (typeof navigateToPage === 'function') navigateToPage('map');

  for (let i = 0; i < 60; i++) {                 // up to ~6s for first-visit load
    if (Array.isArray(_systems) && _systems.length) {
      const sys = _systems.find(s => s.name.toLowerCase() === want)
               || _systems.find(s => s.name.toLowerCase().startsWith(want));
      if (sys) {
        _forceGalaxyView();   // galaxy-coord fly-to — leave any Modern region view
        _flyTo(sys);
        _showInfo(sys);
        const input = document.getElementById('mapSearchInput');
        if (input) input.value = sys.name;
        return true;
      }
      break;   // systems are loaded but the name isn't on the map — stop waiting
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (typeof showToast === 'function') showToast(`Couldn't find ${name} on the map.`, 'info');
  return false;
}

// World coords for a system in whichever galaxy-level view is currently active
// — true classic position, or the Modern overview's flattened position. Used
// by galaxy-level entry points (fly-to, fit-to-systems) so they land in the
// right spot regardless of which mode the user has open. Callers of these are
// expected to have already left any Modern region drill-down (_forceGalaxyView),
// so the overview's gpos is always the right Modern lookup here.
function _worldPos(system) {
  if (_viewMode === 'modern') {
    const p = _buildGalaxyModern().gpos.get(system.id);
    if (p) return [p.x, p.z];
  }
  return [system.wx, system.wz];
}

function _flyTo(system) {
  if (!_canvas) return;
  const targetZoom = Math.max(_zoom, 0.5);
  // Centre on the system at targetZoom
  _zoom = targetZoom;
  const [wx, wz] = _worldPos(system);
  const [cx, cy] = _w2c(wx, wz);
  _panX += _canvas.width  / 2 - cx;
  _panY += _canvas.height / 2 - cy;
  _scheduleRender();
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
// Lit state and its announced state are one call, so a screen reader can never
// disagree with the pixels.
function _press(btn, on) {
  if (!btn) return;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function _initToolbar() {
  document.querySelectorAll('.map-overlay-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.map-overlay-btn')
        .forEach(b => _press(b, b === btn));
      _overlay = btn.dataset.overlay;
      // Friends & Foes needs the alliance standings — load them on first use, then redraw.
      if (_overlay === 'fnf' && !_fnfLoaded) {
        _loadFnfStandings().then(() => { _updateLegend(); _scheduleRender(); });
      }
      _updateLegend();
      _scheduleRender();
    });
  });

  // View style (Classic / Modern). Kept separate from the overlay buttons so the
  // overlay handler above doesn't clear it. Modern opens a DOTLAN-style per-region
  // view (prototype); Classic returns to the whole-galaxy overview.
  const regionSel = document.getElementById('mapRegionSelect');
  document.querySelectorAll('.map-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.view;
      if (mode === _viewMode) return;
      _viewMode = mode;
      document.querySelectorAll('.map-view-btn')
        .forEach(b => _press(b, b.dataset.view === mode));
      if (mode === 'modern') {
        _populateRegionSelect();
        if (regionSel) { regionSel.style.display = ''; regionSel.value = 'galaxy'; }
        _regionView = null;                 // start at the galaxy overview
        _buildGalaxyModern();
        _fitGalaxyModern();
      } else {
        if (regionSel) regionSel.style.display = 'none';
        _regionView = null;
        _fitGalaxy();
      }
      _updateLegend();   // Classic and Modern paint different security ramps
      _scheduleRender();
    });
  });

  if (regionSel) {
    regionSel.addEventListener('change', () => {
      if (_viewMode !== 'modern') {
        _viewMode = 'modern';
        document.querySelectorAll('.map-view-btn')
          .forEach(b => b.classList.toggle('active', b.dataset.view === 'modern'));
        regionSel.style.display = '';
      }
      if (regionSel.value === 'galaxy') { _backToOverview(); _updateLegend(); return; }
      _enterRegion(Number(regionSel.value));
      _updateLegend();   // the special-shape row only applies to the overview
      _scheduleRender();
    });
  }

  const jbBtn = document.getElementById('mapJbToggle');
  if (jbBtn) {
    _press(jbBtn, _showJb);   // reflect the default-on state
    jbBtn.addEventListener('click', () => {
      _showJb = !_showJb;
      if (_showJb) _loadSavedBridges();   // pick up any newly imported bridges
      _press(jbBtn, _showJb);
      _updateLegend();
      _scheduleRender();
    });
  }

  const whBtn = document.getElementById('mapWhToggle');
  if (whBtn) {
    _press(whBtn, _showWh);   // default-on
    whBtn.addEventListener('click', async () => {
      _showWh = !_showWh;
      _press(whBtn, _showWh);
      _updateLegend();
      if (_showWh) await _ensureWhArcs();        // lazy-load the connections on first enable
      _scheduleRender();
    });
  }

  const infBtn = document.getElementById('mapInfToggle');
  if (infBtn) {
    infBtn.addEventListener('click', () => {
      _showInf = !_showInf;
      _press(infBtn, _showInf);
      // Under Friends & Foes the field is drawn from the standings, so make sure
      // they're loaded — otherwise the first paint would be all neutral.
      if (_showInf && _overlay === 'fnf' && !_fnfLoaded) {
        _loadFnfStandings().then(() => { _infInvalidate(); _updateLegend(); _scheduleRender(); });
      }
      _updateLegend();   // the field repaints the dots — the ramp stops describing them
      _scheduleRender();
    });
  }

  const zoomIn  = document.getElementById('mapZoomIn');
  const zoomOut = document.getElementById('mapZoomOut');
  const zoomFit = document.getElementById('mapZoomFit');
  if (zoomIn)  zoomIn.addEventListener('click',  () => _adjustZoom(1.45, _canvas.width/2, _canvas.height/2));
  if (zoomOut) zoomOut.addEventListener('click', () => _adjustZoom(1/1.45, _canvas.width/2, _canvas.height/2));
  if (zoomFit) zoomFit.addEventListener('click', () => {
    if (_viewMode === 'modern' && _regionView != null) _fitRegion(); else _fitGalaxy();
    _scheduleRender();
  });

  // There is deliberately no Refresh control here. Everything the old ⟳ button
  // did now happens on the endpoints' own cadence in _startLivePolling(), and the
  // legend reports the age of the data instead.
}

// ── Canvas setup ──────────────────────────────────────────────────────────────
function _initCanvas() {
  _canvas = document.getElementById('mapCanvas');
  if (!_canvas) return;
  _ctx = _canvas.getContext('2d');

  const vp = document.getElementById('mapViewport');
  if (vp) new ResizeObserver(() => _onResize()).observe(vp);

  // Pan (drag).
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

    const tip = document.getElementById('mapTooltip');

    // Modern region view: an inter-region gateway box under the cursor is a clickable
    // link to that region — take priority over system hover.
    const prevEx = _hoveredExit;
    _hoveredExit = _regionExitAt(cx, cy);
    if (_hoveredExit) {
      if (_hovered) { _hovered = null; }
      _canvas.style.cursor = 'pointer';
      if (tip) {
        tip.textContent = `${_hoveredExit.name} → ${_hoveredExit.regionName}`;
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
        tip.style.display = 'block';
      }
      if (prevEx !== _hoveredExit) _scheduleRender();
      return;
    }
    if (prevEx) _scheduleRender();

    const prev = _hovered;
    _hovered = _hitTest(cx, cy);
    _canvas.style.cursor = _hovered ? 'pointer' : 'grab';

    // Galaxy overview: track the hovered region so its label can highlight.
    const inOverview = _viewMode === 'modern' && _regionView == null;
    if (inOverview) {
      const reg = _hovered ? _hovered.regionId : null;
      if (reg !== _hoveredRegion) { _hoveredRegion = reg; _scheduleRender(); }
    }
    if (_hovered?.id !== prev?.id) _scheduleRender();

    // Floating tooltip
    if (tip) {
      if (_hovered) {
        tip.textContent  = inOverview ? `${_hovered.name} · ${_regions[_hovered.regionId] || ''}` : _hovered.name;
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
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      // Modern region view: the "◄ Galaxy overview" link returns to the overview.
      if (_viewMode === 'modern' && _regionView != null && _regionBackRect &&
          mx >= _regionBackRect.x && mx <= _regionBackRect.x + _regionBackRect.w &&
          my >= _regionBackRect.y && my <= _regionBackRect.y + _regionBackRect.h) {
        _backToOverview();
        return;
      }
      // Modern region view: clicking a gateway box jumps to that region.
      const ex = _regionExitAt(mx, my);
      if (ex && ex.regionId != null) {
        _enterRegion(ex.regionId);
        _hoveredExit = null;
        _scheduleRender();
        return;
      }
      // Galaxy overview: clicking a cluster opens that region.
      if (_viewMode === 'modern' && _regionView == null) {
        const hit = _hitTest(mx, my);
        if (hit) _enterRegion(hit.regionId);
        return;
      }
      const sys  = _hitTest(mx, my);
      if (sys) {
        _showInfo(sys);
      } else {
        _selected = null;
        const p = document.getElementById('mapInfoPanel');
        if (p) p.classList.add('is-hidden');
        _scheduleRender();
      }
    }
  });

  _canvas.addEventListener('mouseleave', () => {
    _dragging = false;
    _hovered  = null;
    _hoveredExit = null;
    _hoveredRegion = null;
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
    if (_viewMode === 'modern') _fitGalaxyModern(); else _fitGalaxy();
  } else {
    // Keep the galaxy centre stable across resize
    _panX += (_canvas.width  - prevW) / 2;
    _panY += (_canvas.height - prevH) / 2;
  }
  _scheduleRender();
}

// ── Live ESI data ─────────────────────────────────────────────────────────────
// ESI sets the tempo (PRODUCT.md Principle 3): sovereignty is cached 5 minutes on
// CCP's side and incursions 30, so those are the cadences the map polls at. There
// is deliberately no Refresh control — the legend reports how old the data is
// instead, which is the question a pilot actually has.
const SOV_TTL_MS = 5 * 60 * 1000;
const INC_TTL_MS = 30 * 60 * 1000;
const WH_TTL_MS  = 15 * 60 * 1000;   // EvE-Scout is a public API, not ESI

let _sovAt     = 0;      // epoch ms of the last SUCCESSFUL sovereignty fetch
let _incAt     = 0;      // …and incursions
let _whAt      = 0;      // …and the EvE-Scout wormhole arcs
let _liveFail  = null;   // 'sov' | 'inc' | 'both' | null — what failed last cycle
let _pollTimer = null;

const _mapVisible = () =>
  !document.hidden && !!document.getElementById('page-map')?.classList.contains('active');

// "How old is what I'm looking at" — deliberately coarse; nobody needs seconds.
function _agoLabel(t) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

async function _loadLiveData({ sov = true, inc = true } = {}) {
  const [sovR, incR] = await Promise.allSettled([
    sov ? window.eveAPI.mapGetSovereignty() : Promise.resolve(null),
    inc ? window.eveAPI.mapGetIncursions()  : Promise.resolve(null),
  ]);

  // A rejected fetch must not be mistaken for "the galaxy is unclaimed": keep the
  // last good data and say the overlay is stale rather than repainting it empty.
  const sovBad = sov && sovR.status === 'rejected';
  const incBad = inc && incR.status === 'rejected';
  if (sov && !sovBad) { _sovMap = sovR.value || {};            _sovAt = Date.now(); }
  if (inc && !incBad) { _incSet = new Set(incR.value || []);   _incAt = Date.now(); }

  _liveFail = sovBad && incBad ? 'both' : sovBad ? 'sov' : incBad ? 'inc' : null;
  if (_liveFail) {
    logToConsole(`[Map] Live overlay fetch failed (${_liveFail}) — keeping the last good data`, 'warning');
  }

  // Recompute region dominant holders then fetch tickers (async, re-renders when done)
  _computeRegionDomSov();
  _updateLegend();    // freshness line moved with the data
  _scheduleRender();
  _fetchDomTickers(); // background — patches labels in once tickers arrive
  _startLivePolling();
}

function _startLivePolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    // Nothing is fetched while the map is off-screen: those calls would land on a
    // page nobody is looking at and spend ESI error budget the rest of the app needs.
    if (!_mapVisible()) return;
    const now = Date.now();
    await _loadLiveData({ sov: true, inc: now - _incAt >= INC_TTL_MS });

    // Wormholes churn faster than sov but come from a public API, not ESI, so they
    // ride their own slower cadence rather than every sov tick.
    if (_showWh && now - _whAt >= WH_TTL_MS) {
      _whAt = now;
      _whLoaded = false;
      await _ensureWhArcs();
      _scheduleRender();
    }
  }, SOV_TTL_MS);
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
  // Endpoint markers follow the bridge list — rebuilt here so an import shows up
  // without a reload, same as the arcs.
  _jbSet = new Set(_savedBridges.flat());
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
  _rebuildWhArcs();
}
window.mapReloadWormholes = function () { _whLoaded = false; return _loadWormholes(); };

// Build the deduped edge list of EvE-Scout API connections for the dark-purple map
// arcs (drawn like jump bridges).
function _rebuildWhArcs() {
  const seen = new Set();
  _whArcEdges = [];
  const add = (a, b) => {
    if (a == null || b == null || a === b || !_sysById[a] || !_sysById[b]) return;
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    _whArcEdges.push([a, b]);
  };
  for (const c of (_whConns || [])) add(c.inId, c.outId);
}

// Load the EvE-Scout connections (once per session), build the arc set + redraw.
// The toolbar ⟳ forces a refresh (holes spawn/die constantly).
async function _ensureWhArcs() {
  if (!_whLoaded) await _loadWormholes();
  _rebuildWhArcs();
  _scheduleRender();
}

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
// opts: { mode:'safest'|'shortest', avoidLow, avoidNull, avoidRed, useBridges,
// useWormholes }. removedNodes / removedEdges (Sets; edges keyed "from>to") let
// Yen's k-shortest carve out alternatives. Returns { path, cost } or null.
// Endpoints are never filtered out.
function _routeDijkstra(startId, endId, opts = {}, removedNodes = null, removedEdges = null) {
  if (!_sysById[startId] || !_sysById[endId]) return null;
  _ensureGateAdj();
  const { mode = 'safest', avoidLow = false, avoidNull = false, avoidRed = false, avoidZarzakh = false, useBridges = false, useWormholes = false } = opts;
  if (useBridges) _buildBridgeAdj();

  const dist = new Map(), prev = new Map(), done = new Set();
  const heap = _mapHeap();
  dist.set(startId, 0); heap.push(0, startId);
  while (heap.size()) {
    const [d, id] = heap.pop();
    if (done.has(id)) continue;
    done.add(id);
    if (id === endId) break;
    // Gates + (optionally) Ansiblex bridges + wormholes form one network — the
    // router picks the cheapest mix.
    const neighbours = (_gateAdj.get(id) || [])
      .concat(useBridges   && _bridgeAdj ? (_bridgeAdj.get(id) || []) : [])
      .concat(useWormholes && _whAdj     ? (_whAdj.get(id)     || []) : []);
    for (const to of neighbours) {
      if (done.has(to)) continue;
      if (removedNodes && removedNodes.has(to)) continue;
      if (removedEdges && removedEdges.has(id + '>' + to)) continue;
      const toSys = _sysById[to];
      if (!toSys) continue;
      if (to !== endId) {
        if (avoidLow  && toSys.sec > 0.0 && toSys.sec < 0.45) continue;
        if (avoidNull && toSys.sec <= 0.0) continue;
        if (avoidRed  && _travelSafetyCost(toSys) >= 50) continue;
        // Zarzakh's 6h gate lock means you can't gate out the far side — never route
        // through it (it stays reachable only as an explicit destination).
        if (avoidZarzakh && to === _ZARZAKH_ID) continue;
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
  if (path[0] !== startId) return null;
  return { path, cost: dist.get(endId) || 0 };
}

function _travelRoutePath(startId, endId, opts = {}) {
  const r = _routeDijkstra(startId, endId, opts);
  return r ? r.path : null;
}

// Total routing cost of an explicit path (matches _routeDijkstra's edge weights).
function _pathCost(path, opts) {
  if ((opts.mode || 'safest') === 'shortest') return path.length - 1;
  let c = 0;
  for (let i = 1; i < path.length; i++) { const s = _sysById[path[i]]; c += s ? _travelSafetyCost(s) : 1; }
  return c;
}

// Up to K shortest loopless routes (Yen's algorithm) for the Stargate Planner's
// "alternative routes". Returns [{ path, cost }, …] best-first.
function _kShortestRoutes(startId, endId, opts = {}, K = 3) {
  const first = _routeDijkstra(startId, endId, opts);
  if (!first) return [];
  const A = [first], B = [];
  const keyOf = p => p.join(',');
  const seen = new Set([keyOf(first.path)]);

  for (let k = 1; k < K; k++) {
    const prevPath = A[k - 1].path;
    for (let i = 0; i < prevPath.length - 1; i++) {
      const spurNode = prevPath[i];
      const rootPath = prevPath.slice(0, i + 1);
      const removedEdges = new Set(), removedNodes = new Set();
      // Block the edge each accepted path takes after this shared root, so the spur
      // diverges; drop the root's earlier nodes to keep the result loopless.
      for (const p of A) {
        const pp = p.path;
        if (pp.length > i + 1 && rootPath.every((n, idx) => pp[idx] === n)) {
          removedEdges.add(pp[i] + '>' + pp[i + 1]);
        }
      }
      for (let j = 0; j < rootPath.length - 1; j++) removedNodes.add(rootPath[j]);

      const spur = _routeDijkstra(spurNode, endId, opts, removedNodes, removedEdges);
      if (spur) {
        const total = rootPath.slice(0, -1).concat(spur.path);
        const kk = keyOf(total);
        if (!seen.has(kk)) { B.push({ path: total, cost: _pathCost(total, opts) }); seen.add(kk); }
      }
    }
    if (!B.length) break;
    B.sort((a, b) => a.cost - b.cost || a.path.length - b.path.length);
    A.push(B.shift());
  }
  return A;
}

async function _computeTravelRoute() {
  if (!_travelStart || !_travelEnd) return;
  if (!_fnfLoaded) await _loadFnfStandings();   // so blue/red weighting applies
  const path = _travelRoutePath(_travelStart, _travelEnd, { mode: 'safest', useBridges: true, avoidZarzakh: true });
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
  const esc = (typeof escHtml === 'function') ? escHtml : _esc;
  const btn = (act, icon, label, cls) =>
    `<button type="button" class="map-ctx${cls ? ' ' + cls : ''}" data-act="${act}">`
    + `<span class="material-symbols-outlined" aria-hidden="true">${icon}</span>${label}</button>`;

  let body = `<div class="map-ctx-title">${esc(sys.name)}</div>`;
  body += btn('start', 'trip_origin', 'Set as start');
  body += btn('end',   'flag',        'Set as destination');
  if (_travelStart || _travelEnd || _routeIds || _jumpRouteIds) {
    body += btn('clear', 'close', 'Clear routes', 'map-ctx-danger');
  }
  if (window.jpHasActiveRoute && window.jpHasActiveRoute()) {
    body += btn('jump', 'rocket_launch', 'Jump route options…');
  }

  const menu = document.createElement('div');
  menu.id = 'mapCtxMenu';
  menu.className = 'map-ctx-menu';
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
  pill.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">explore</span>`
                 + ` Stargate Planner${jumps ? ` · ${jumps} jumps` : ''}`;
  pill.style.display = 'flex';
}

function _sgBuildModal() {
  const m = document.createElement('div');
  m.id = 'stargatePlannerModal';
  m.className = 'jp-modal-backdrop';
  m.innerHTML = `
    <div class="jp-modal">
      <div class="jp-modal-header">
        <span class="panel-icon material-symbols-outlined" aria-hidden="true">explore</span><span>Stargate Route Planner</span>
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
            <label class="jp-check"><input type="checkbox" id="sgAvoidZarzakh" checked> Avoid Zarzakh <span class="jp-dim" style="font-weight:400;">(6 h gate lock — can't exit the other side)</span></label>
          </div>
          <button id="sgPlotBtn" class="calc-btn" style="width:100%;margin-top:6px;">PLOT ROUTE</button>
          <div style="display:flex;gap:6px;margin-top:6px;">
            <button id="sgSendGameBtn" class="icon-btn" style="flex:1;padding:7px;font-size:12px;cursor:pointer;" title="Set this route as autopilot waypoints in your running EVE client"><span class="material-symbols-outlined" aria-hidden="true">satellite_alt</span> Send to game</button>
            <button id="sgAltBtn" class="icon-btn" style="flex:1;padding:7px;font-size:12px;cursor:pointer;" title="Show up to 3 alternative routes">Alternatives</button>
          </div>
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
  m.querySelector('#sgPlotBtn').addEventListener('click', _sgPlotAndShow);
  m.querySelector('#sgSendGameBtn').addEventListener('click', _sgSendToGame);
  m.querySelector('#sgAltBtn').addEventListener('click', _sgShowAlternatives);
  m.querySelector('#sgTo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _sgPlotAndShow(); } });
  // Auto re-plot whenever any option (or From/To) changes.
  ['#sgMode', '#sgUseBridges', '#sgUseWh', '#sgAvoidLow', '#sgAvoidNull', '#sgAvoidRed', '#sgAvoidZarzakh', '#sgFrom', '#sgTo']
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
  if (!from || !to) { result.innerHTML = `<div class="jp-empty jp-err">Pick valid start and destination systems.</div>`; return null; }
  if (from.id === to.id) { result.innerHTML = `<div class="jp-empty">Start and destination are the same system.</div>`; return null; }

  if (!_fnfLoaded) { result.innerHTML = `<div class="jp-empty">Loading standings…</div>`; await _loadFnfStandings(); }
  const useWh = document.getElementById('sgUseWh').checked;
  if (useWh && !_whLoaded) { result.innerHTML = `<div class="jp-empty">Loading EvE-Scout connections…</div>`; await _loadWormholes(); }
  const opts = {
    mode:         document.getElementById('sgMode').value,
    avoidLow:     document.getElementById('sgAvoidLow').checked,
    avoidNull:    document.getElementById('sgAvoidNull').checked,
    avoidRed:     document.getElementById('sgAvoidRed').checked,
    avoidZarzakh: document.getElementById('sgAvoidZarzakh').checked,
    useBridges:   document.getElementById('sgUseBridges').checked,
    useWormholes: useWh,
  };
  const path = _travelRoutePath(from.id, to.id, opts);
  if (!path) { result.innerHTML = `<div class="jp-empty jp-err">No gate route found with those constraints. Try removing an avoid filter.</div>`; return null; }
  _sgRenderRoute(path, opts);
  return path;
}

// PLOT ROUTE / Enter: plot, then minimise the planner and centre the route on the
// map so it's immediately visible. (Auto-replot from typing/toggling keeps the
// planner open — only an explicit plot collapses to the map.)
async function _sgPlotAndShow() {
  const path = await _sgPlot();
  if (path && path.length > 1) _sgMinimize();
}

// Resolve the in-game character (selected → favourite → first).
async function _sgPickChar() {
  const accounts = (await window.eveAPI.getAccounts().catch(() => [])) || [];
  if (typeof selectedCharacterId !== 'undefined' && selectedCharacterId &&
      accounts.some(a => String(a.characterId) === String(selectedCharacterId))) return selectedCharacterId;
  try {
    const favs = JSON.parse(localStorage.getItem('char_favorites') || '[]');
    const fav = (Array.isArray(favs) ? favs : []).map(String)
      .find(f => accounts.some(a => String(a.characterId) === f));
    if (fav) return fav;
  } catch (_) {}
  return accounts[0]?.characterId || null;
}

// "📡 Send to game": push the plotted route into the running EVE client as ordered
// autopilot waypoints (k-space systems only — the client can't route to w-space).
async function _sgSendToGame() {
  if (!_sgLastPath || _sgLastPath.length < 2) { if (typeof showToast === 'function') showToast('Plot a route first.', 'error'); return; }
  const ids = _sgLastPath.filter(id => id < 31000000);   // skip Thera / J-space
  if (!ids.length) { if (typeof showToast === 'function') showToast('No k-space systems to set as waypoints.', 'error'); return; }
  const cid = await _sgPickChar();
  if (!cid) { if (typeof showToast === 'function') showToast('No character — add one on the Characters page.', 'error'); return; }

  const btn = document.getElementById('sgSendGameBtn');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = `Sending ${ids.length}…`; }
  try {
    const res = await window.eveAPI.setAutopilotRoute(cid, ids);
    if (typeof showToast === 'function') {
      _ensureGateAdj();
      const hadWh = _sgLastPath.some((id, i) => i > 0 && !((_gateAdj.get(_sgLastPath[i - 1]) || []).includes(id)));
      showToast(`Sent ${res.count} waypoints to EVE.${hadWh ? ' Wormhole/bridge hops aren’t auto-flown — jump those manually.' : ''}`, 'success');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Could not set waypoints.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// "⎇ Alternatives": compute up to 3 shortest distinct routes (Yen's) and show them
// as selectable chips above the route table.
async function _sgShowAlternatives() {
  const result = document.getElementById('sgResult');
  const from = _sgResolve(document.getElementById('sgFrom').value);
  const to   = _sgResolve(document.getElementById('sgTo').value);
  if (!from || !to || from.id === to.id) { if (typeof showToast === 'function') showToast('Pick a valid start and destination first.', 'error'); return; }

  if (!_fnfLoaded) await _loadFnfStandings();
  const useWh = document.getElementById('sgUseWh').checked;
  if (useWh && !_whLoaded) await _loadWormholes();
  const opts = {
    mode:         document.getElementById('sgMode').value,
    avoidLow:     document.getElementById('sgAvoidLow').checked,
    avoidNull:    document.getElementById('sgAvoidNull').checked,
    avoidRed:     document.getElementById('sgAvoidRed').checked,
    avoidZarzakh: document.getElementById('sgAvoidZarzakh').checked,
    useBridges:   document.getElementById('sgUseBridges').checked,
    useWormholes: useWh,
  };
  if (result) result.innerHTML = `<div class="jp-empty">Finding alternative routes…</div>`;
  await new Promise(r => setTimeout(r, 20));   // let the message paint
  const routes = _kShortestRoutes(from.id, to.id, opts, 3);
  if (!routes.length) { if (result) result.innerHTML = `<div class="jp-empty jp-err">No route found.</div>`; return; }
  _sgAltRoutes = routes;
  _sgRenderAlternatives(opts, 0);
}

// Render the selected alternative (table + map) with a chip selector on top.
function _sgRenderAlternatives(opts, idx) {
  if (!_sgAltRoutes || !_sgAltRoutes[idx]) return;
  _sgRenderRoute(_sgAltRoutes[idx].path, opts);
  const result = document.getElementById('sgResult');
  if (!result) return;
  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;';
  chips.innerHTML = _sgAltRoutes.map((r, i) => {
    const sel = i === idx;
    return `<button data-alt="${i}" style="flex:1;min-width:84px;padding:6px;font-size:11px;cursor:pointer;border-radius:6px;`
      + `border:1px solid ${sel ? 'var(--accent,#60c8ff)' : 'var(--border,#2a3450)'};`
      + `background:${sel ? 'rgba(96,200,255,0.15)' : 'transparent'};color:var(--text-1,#cdd6e6);">`
      + `Route ${i + 1}<br><span style="opacity:.7;">${r.path.length - 1} jumps</span></button>`;
  }).join('');
  result.prepend(chips);
  chips.querySelectorAll('[data-alt]').forEach(b =>
    b.addEventListener('click', () => _sgRenderAlternatives(opts, Number(b.dataset.alt))));
  // Reflect the selected alternative on the map (don't re-fit while comparing).
  if (typeof window.mapShowRoute === 'function') window.mapShowRoute(_sgAltRoutes[idx].path, [], false);
}

function _sgRenderRoute(path, opts) {
  const result = document.getElementById('sgResult');
  _sgLastPath = path;
  const jumps = path.length - 1;
  // Classify each hop: gate (default), Ansiblex bridge, or EvE-Scout wormhole.
  const isGate   = (a, b) => (_gateAdj.get(a)   || []).includes(b);
  const isBridge = (a, b) => _bridgeAdj && (_bridgeAdj.get(a) || []).includes(b);
  const isWh     = (a, b) => opts.useWormholes && _whAdj && (_whAdj.get(a) || []).includes(b);
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
      if (isBridge(path[i - 1], id)) { bridges++; hopMark = '<span class="map-mark-bridge" title="Jump bridge">◈ </span>'; }
      else if (isWh(path[i - 1], id)) {
        wormholes++;
        const c = whInfo(path[i - 1], id);
        const t = c ? `EvE-Scout wormhole ${c.whType || ''} · ${c.maxShip || ''}${c.remainingHours != null ? ` · ${c.remainingHours}h left` : ''}` : 'EvE-Scout wormhole';
        hopMark = `<span class="map-mark-wormhole" title="${t.trim()}">◇ </span>`;
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
    <div class="jp-banner">${opts.mode === 'shortest' ? 'Shortest route — fewest jumps (gates + bridges).' : 'Safest route — prefers your sov, blues &amp; hi-sec; red only as a last resort.'}</div>
    <div class="jp-totals">
      <div><span class="jp-tot-num">${jumps}</span><span class="jp-tot-lbl">jumps</span></div>
      ${bridges ? `<div><span class="jp-tot-num map-mark-bridge">${bridges}</span><span class="jp-tot-lbl">bridges</span></div>` : ''}
      ${wormholes ? `<div><span class="jp-tot-num map-mark-wormhole">${wormholes}</span><span class="jp-tot-lbl">wormholes</span></div>` : ''}
      ${low ? `<div><span class="jp-tot-num map-mark-lowsec">${low}</span><span class="jp-tot-lbl">low-sec</span></div>` : ''}
      ${red ? `<div><span class="jp-tot-num map-mark-red">${red}</span><span class="jp-tot-lbl">red</span></div>` : ''}
    </div>
    <button id="sgShowMapBtn" class="icon-btn" style="width:100%;margin:4px 0 8px;padding:6px;font-size:12px;cursor:pointer;"><span class="material-symbols-outlined" aria-hidden="true">map</span> Show / centre on map</button>
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

// ── Viewport state ────────────────────────────────────────────────────────────
// One switch for the three states the viewport can be in. Exactly one of loading,
// error and canvas is on screen at a time — the failure path used to rewrite the
// loading text and leave the spinner turning underneath it, which reads as
// "still working" and "it failed" simultaneously, with the canvas hidden for good.
function _setMapState(state, cause) {
  const loadingEl = document.getElementById('mapLoading');
  const errorEl   = document.getElementById('mapError');
  const canvasEl  = document.getElementById('mapCanvas');
  const causeEl   = document.getElementById('mapErrorCause');

  loadingEl?.classList.toggle('is-hidden', state !== 'loading');
  errorEl?.classList.toggle('is-hidden',   state !== 'error');
  canvasEl?.classList.toggle('is-hidden',  state !== 'ready');

  // The raw message is the technical cause, never the headline: it sits under the
  // plain-language explanation, and is dropped entirely when there is none.
  if (causeEl) causeEl.textContent = state === 'error' && cause ? cause : '';
}

function _initErrorState() {
  document.getElementById('mapErrorRetry')?.addEventListener('click', () => initMapPage());
  document.getElementById('mapErrorSettings')?.addEventListener('click', () => {
    // Same hand-off the forum empty state uses: open Settings, then select the tab
    // once its panel has mounted.
    document.getElementById('openSettingsBtn')?.click();
    setTimeout(() => document.querySelector('[data-settings-tab=database]')?.click(), 140);
  });
}

async function initMapPage() {
  _loadSavedBridges();   // refresh saved bridge arcs on every entry to the map
  // If already loaded, just ensure the canvas fills its container and re-render
  if (_loaded) {
    _onResize();
    _loadYouAreHere();   // refresh "you are here" (location may have changed)
    if (_showWh && (!_whArcEdges || !_whArcEdges.length)) _ensureWhArcs();
    _scheduleRender();
    return;
  }

  // Bind once. The error state's Try-again re-enters initMapPage, so without this
  // guard a retry would stack a second copy of every canvas and toolbar listener.
  if (!_wired) {
    _wired = true;
    _initCanvas();
    _initToolbar();
    _initSearch();
    _initErrorState();
  }
  _updateLegend();
  // Hand-curated layout (if the user saved one) — must be in hand before the
  // first Modern render so it wins over the algorithm.
  try { _savedModernLayout = await window.eveAPI.modernLayoutGet(); } catch (_) { _savedModernLayout = null; }

  _setMapState('loading');

  try {
    logToConsole('[Map] Loading galaxy data from SDE…', 'info');
    const galaxy = await window.eveAPI.mapGetGalaxy();

    _systems  = _normalise(galaxy.systems);
    _jumps    = galaxy.jumps;
    _regions  = galaxy.regions;
    _sysById  = {};
    for (const s of _systems) _sysById[s.id] = s;

    _declutterAll();           // collision pass — push overlapping systems apart
    _relayoutSpecialRegions(); // declutter Pochven/Exordium via a gate-graph layout
    _layoutWormholeBlock();     // J-space grid to the right of the (final) galaxy
    _computeRegionCentroids(); // must come after normalisation & _regions are set
    _populateRegionSelect();   // fill the Modern-view region picker

    _loaded = true;
    _onResize(); // Size the canvas now that data is ready; calls _fitGalaxy()

    _setMapState('ready');

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

    // Load + draw the EvE-Scout wormhole connection arcs too.
    if (_showWh) _ensureWhArcs();

  } catch (err) {
    _setMapState('error', err && err.message);
    logToConsole(`[Map] Galaxy load failed: ${err.message}`, 'error');
  }
}

// ── Global bridge — called by dashboard "View on Map" buttons ─────────────────
// Switches to Incursions overlay and flies to the given system.
// Safe to call before the galaxy has loaded; the jump is deferred until ready.
window.mapJumpToSystem = function (systemId) {
  _forceGalaxyView();   // galaxy-coord jump — leave any Modern region view
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
  const coords = pts.map(_worldPos);
  const xs = coords.map(c => c[0]), zs = coords.map(c => c[1]);
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
    _forceGalaxyView();   // routes are drawn in galaxy coords
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
    _forceGalaxyView();   // routes are drawn in galaxy coords
    _jumpRouteIds = ids;
    _jumpRouteWaypointIds = wps;
    if (fit) _fitToSystems(ids);
    _scheduleRender();
  } else {
    _pendingJumpRouteIds = ids;
    _pendingJumpWaypointIds = wps;
  }
};
