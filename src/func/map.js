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
let _showJb      = false;
let _rafPending  = false;
let _loaded      = false;

// Data (populated by initMapPage)
let _systems     = [];        // [{id, name, wx, wz, sec, regionId, factionId}]
let _jumps       = [];        // [{from, to}]
let _sovMap      = {};        // {systemId: {allianceId, factionId, corporationId}}
let _incSet      = new Set();
let _jbSet           = new Set();
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

  // ── Plotted jump route (highlighted over the faint connection mesh) ─────────
  if (_routeIds && _routeIds.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(96,200,255,0.95)';
    ctx.lineWidth   = Math.max(1.5, Math.min(4, _zoom * 4));
    ctx.lineCap     = 'round';
    for (let i = 1; i < _routeIds.length; i++) {
      const a = _sysById[_routeIds[i - 1]], b = _sysById[_routeIds[i]];
      if (!a || !b) continue;
      const [ax, ay] = _w2c(a.wx, a.wz);
      const [bx, by] = _w2c(b.wx, b.wz);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
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

  // ── Route waypoint markers (start/end labelled) ─────────────────────────────
  if (_routeIds && _routeIds.length) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    _routeIds.forEach((id, i) => {
      const s = _sysById[id]; if (!s) return;
      const [cx, cy] = _w2c(s.wx, s.wz);
      if (cx < -30 || cx > W + 30 || cy < -30 || cy > H + 30) return;
      const isEnd = (i === 0 || i === _routeIds.length - 1);
      ctx.beginPath();
      ctx.arc(cx, cy, isEnd ? 7 : 4.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#60c8ff';
      ctx.lineWidth   = 2;
      ctx.stroke();
      if (isEnd) {
        ctx.fillStyle   = '#60c8ff';
        ctx.font        = 'bold 11px var(--mono, monospace)';
        ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
        ctx.fillText(`${s.name} (${i === 0 ? 'start' : 'end'})`, cx, cy - 14);
        ctx.shadowBlur = 0;
      }
    });
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
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
      _updateLegend();
      _scheduleRender();
    });
  });

  const jbBtn = document.getElementById('mapJbToggle');
  if (jbBtn) {
    jbBtn.addEventListener('click', () => {
      _showJb = !_showJb;
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
async function initMapPage() {
  // If already loaded, just ensure the canvas fills its container and re-render
  if (_loaded) {
    _onResize();
    _loadYouAreHere();   // refresh "you are here" (location may have changed)
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
      _pendingRouteIds = null;
      _fitToSystems(_routeIds);
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
window.mapShowRoute = function (systemIds) {
  const ids = (systemIds || []).map(Number).filter(Boolean);
  if (!ids.length) return;
  if (_loaded) {
    _routeIds = ids;
    _fitToSystems(ids);
    _scheduleRender();
  } else {
    _pendingRouteIds = ids;
  }
};
