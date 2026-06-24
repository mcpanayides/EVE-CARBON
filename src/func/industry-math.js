// ─── industry-math.js — pure EVE manufacturing math (no DOM, no globals) ────────
// Material/time modifiers, EIV + job-install-fee, and the structures-sheet CSV
// parser. Every function takes explicit inputs so it can be unit-tested under
// Node and reused in the renderer via window.IndustryMath. Loaded as a plain
// <script> before blueprints.js.
//
// Constants are CCP-tunable game values (community-stable). "Other Structure" is
// treated as rig-capable with no role bonus; only the two universal time skills
// (Industry, Advanced Industry) are modelled — item/category-specific skills and
// capital construction skills are not, so time may differ slightly from in-game
// for some specialised items.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;     // Node / tests
  if (typeof window !== 'undefined') window.IndustryMath = api;                   // renderer
  else if (typeof globalThis !== 'undefined') globalThis.IndustryMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────────────────────
  const SCC_SURCHARGE = 0.04;          // Sales & Compliance Commission surcharge (4%)
  const SKILL_INDUSTRY = 3380;         // Industry: -4% mfg time / level
  const SKILL_ADV_INDUSTRY = 3388;     // Advanced Industry: -3% mfg time / level
  const INDUSTRY_TIME_PER_LVL = 0.04;
  const ADV_INDUSTRY_TIME_PER_LVL = 0.03;
  const JITA_SYSTEM_ID = 30000142;

  // Structure role bonuses (manufacturing).
  const STRUCT_MAT_BONUS = { station: 0, ec: 0.01, other: 0 };
  const EC_TIME_BY_SIZE  = { M: 0.15, L: 0.20, XL: 0.30 };

  // Rig base bonuses (before the security multiplier).
  const RIG_MAT  = { none: 0, t1: 0.02, t2: 0.024 };
  const RIG_TIME = { none: 0, t1: 0.20, t2: 0.24 };

  // Security-status multiplier applied to rig strength.
  const SEC_MULT = { high: 1.0, low: 1.9, null: 2.1, wormhole: 2.1 };

  // ── Per-field bonus lookups ───────────────────────────────────────────────────
  function secMult(secKey)        { return SEC_MULT[secKey] != null ? SEC_MULT[secKey] : 1.0; }
  function structMatBonus(fac)    { return STRUCT_MAT_BONUS[fac] || 0; }
  function structTimeBonus(fac, size) {
    if (fac !== 'ec') return 0;
    return EC_TIME_BY_SIZE[size] != null ? EC_TIME_BY_SIZE[size] : 0;
  }
  // Rigs only apply inside player structures (ec / other), never NPC stations.
  function rigMatBonus(fac, rig)  { return fac === 'station' ? 0 : (RIG_MAT[rig]  || 0); }
  function rigTimeBonus(fac, rig) { return fac === 'station' ? 0 : (RIG_TIME[rig] || 0); }

  // ── Modifiers (multiplicative; <1 means a reduction) ─────────────────────────
  // matMod = (1-ME/100)·(1-structMat)·(1-rigMat·secMult)
  function matModifier(s) {
    const me   = s.me || 0;
    const sm   = secMult(s.secStatus);
    return (1 - me / 100)
         * (1 - structMatBonus(s.facility))
         * (1 - rigMatBonus(s.facility, s.matRig) * sm);
  }

  // timeMod = (1-TE/100)·(1-structTime)·(1-rigTime·secMult)·(1-0.04·Ind)·(1-0.03·AdvInd)
  function timeModifier(s, skills) {
    const te  = s.te || 0;
    const sm  = secMult(s.secStatus);
    const ind = (skills && skills.industry    != null) ? skills.industry    : 5;
    const adv = (skills && skills.advIndustry != null) ? skills.advIndustry : 5;
    return (1 - te / 100)
         * (1 - structTimeBonus(s.facility, s.structureSize))
         * (1 - rigTimeBonus(s.facility, s.timeRig) * sm)
         * (1 - INDUSTRY_TIME_PER_LVL * ind)
         * (1 - ADV_INDUSTRY_TIME_PER_LVL * adv);
  }

  // ── Quantities / time / fees ──────────────────────────────────────────────────
  // EVE rounds the whole-job total to 2 dp then ceils, with a floor of `runs`.
  function adjustedQty(baseQty, runs, matMod) {
    const r = Math.max(1, runs || 1);
    const raw = Math.round(baseQty * r * matMod * 100) / 100;
    return Math.max(r, Math.ceil(raw));
  }

  function totalTime(baseTime, runs, timeMod) {
    return (baseTime || 0) * Math.max(1, runs || 1) * timeMod;
  }

  // EIV per run: Σ(baseQty · adjustedPrice). adjustedPrices: { typeId: adjusted }.
  function eiv(materials, adjustedPrices) {
    let sum = 0;
    for (const m of materials || []) {
      const adj = adjustedPrices ? (adjustedPrices[m.typeId] || 0) : 0;
      sum += adj * (m.baseQty != null ? m.baseQty : (m.quantity || 0));
    }
    return sum;
  }

  // Job install fee total. taxFraction & costIndex are fractions (e.g. 0.05).
  function jobFee(eivPerRun, runs, costIndex, taxFraction) {
    const r = Math.max(1, runs || 1);
    return (eivPerRun || 0) * r * ((costIndex || 0) + (taxFraction || 0) + SCC_SURCHARGE);
  }

  // ── Structures-sheet CSV parsing ──────────────────────────────────────────────
  // Maps free-text cell values onto the dropdown enums used by the calculator.
  function normFacility(v) {
    const t = (v || '').toLowerCase();
    if (t.includes('engineer') || t === 'ec')            return 'ec';
    if (t.includes('station') || t.includes('assembly')) return 'station';
    return 'other';
  }
  function normSize(v) {
    const t = (v || '').toLowerCase();
    if (t.startsWith('xl') || t.includes('extra') || t.includes('sotiyo')) return 'XL';
    if (t.startsWith('l')  || t.includes('large') || t.includes('azbel'))  return 'L';
    return 'M';
  }
  function normSec(v) {
    const t = (v || '').toLowerCase();
    if (t.includes('worm') || t === 'wh' || t.startsWith('w'))   return 'wormhole';
    if (t.includes('null') || t.startsWith('n') || t.startsWith('0')) return 'null';
    if (t.includes('low')  || t.startsWith('l'))                 return 'low';
    return 'high';
  }
  function normRig(v) {
    const t = (v || '').toLowerCase();
    if (t.includes('2') || t.includes('ii')) return 't2';
    if (t.includes('1') || t.includes('i'))  return 't1';
    if (t.includes('none') || t.includes('no') || t === '') return 'none';
    return 'none';
  }
  function normTax(v) {
    const n = parseFloat(String(v).replace('%', '').trim());
    return isFinite(n) ? n : 0;   // percent number, e.g. 1.5
  }

  // Minimal CSV splitter (handles quoted fields + commas inside quotes).
  function splitCsvLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  // EVE Upwell structure type → manufacturing facility + size. This is EVE game
  // knowledge (structure classes), not data lifted from any sheet.
  function structureToFacility(structure) {
    const t = (structure || '').toLowerCase();
    if (t.includes('raitaru')) return { facility: 'ec',    size: 'M'  };
    if (t.includes('azbel'))   return { facility: 'ec',    size: 'L'  };
    if (t.includes('sotiyo'))  return { facility: 'ec',    size: 'XL' };
    if (t.includes('athanor')) return { facility: 'other', size: 'M'  };
    if (t.includes('tatara'))  return { facility: 'other', size: 'L'  };
    if (t.includes('astrahus'))return { facility: 'other', size: 'M'  };
    if (t.includes('fortizar'))return { facility: 'other', size: 'L'  };
    if (t.includes('keepstar'))return { facility: 'other', size: 'XL' };
    return { facility: 'other', size: 'L' };
  }

  // Derive Material/Time rig tiers from a structure's fitted-rig names. Only
  // MANUFACTURING rigs count (reaction/reprocessing/research rigs are ignored).
  // "… Manufacturing Material Efficiency II" → ME tier 2; "… Time Efficiency I"
  // → TE tier 1; a generic "… Manufacturing Efficiency II" counts for both.
  function deriveRigTiers(rigNames) {
    let mat = 0, time = 0;
    for (const raw of rigNames) {
      const r = raw || '';
      if (!/manufactur/i.test(r)) continue;
      const tier = /efficiency\s*ii\b/i.test(r) ? 2 : /efficiency\s*i\b/i.test(r) ? 1 : 0;
      if (!tier) continue;
      const isMat  = /material\s*efficiency/i.test(r);
      const isTime = /time\s*efficiency/i.test(r);
      if (isMat)  mat  = Math.max(mat, tier);
      if (isTime) time = Math.max(time, tier);
      if (!isMat && !isTime) { mat = Math.max(mat, tier); time = Math.max(time, tier); }
    }
    const tierKey = t => t === 2 ? 't2' : t === 1 ? 't1' : 'none';
    return { matRig: tierKey(mat), timeRig: tierKey(time) };
  }

  // Parse the "GEZ Rig List" tab: columns System, Structure, Name, Service
  // Modules, Rig Slot 1/2/3. One preset per structure row (System carries forward
  // when blank). Returns presets; systemId/secStatus are resolved later by caller.
  function parseGezRigList(lines, header) {
    const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; } return -1; };
    const col = {
      system:  idx('system', 'solarsystem'),
      structure: idx('structure', 'structuretype'),
      name:    idx('name', 'structurename'),
      rig1:    idx('rigslot', 'rigslot1', 'rig1'),
      rig2:    idx('rigslot2', 'rig2'),
      rig3:    idx('rigslot3', 'rig3'),
    };
    const at = (cells, i) => (i >= 0 && i < cells.length) ? cells[i].trim() : '';

    const out = [];
    let lastSystem = '';
    for (let r = 1; r < lines.length; r++) {
      const cells = splitCsvLine(lines[r]);
      const sysCell = at(cells, col.system);
      if (sysCell) lastSystem = sysCell;
      const system    = sysCell || lastSystem;
      const structure = at(cells, col.structure);
      const name      = at(cells, col.name);
      if (!structure && !name) continue;             // blank / legend row
      if (!system) continue;

      const fac  = structureToFacility(structure);
      const rigs = deriveRigTiers([at(cells, col.rig1), at(cells, col.rig2), at(cells, col.rig3)]);
      out.push({
        name:          (name ? name + ' — ' : '') + system,
        systemName:    system,
        systemId:      null,
        facility:      fac.facility,
        structureSize: fac.size,
        secStatus:     'null',                        // refined from live data by caller
        matRig:        rigs.matRig,
        timeRig:       rigs.timeRig,
        taxRate:       0,
      });
    }
    return out;
  }

  // Parse a structures CSV. Auto-detects the GEZ "Rig List" tab (System /
  // Structure / Rig Slot columns) and otherwise falls back to a simple schema:
  // name, system, facility, size, security, materialRig, timeRig, tax.
  function parseStructuresCsv(text) {
    if (!text) return [];
    const lines = String(text).split(/\r?\n/).filter(l => l.trim().length);
    if (lines.length < 2) return [];

    const header = splitCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));

    // GEZ Rig List format
    if (header.includes('rigslot1') || header.includes('rigslot')) {
      return parseGezRigList(lines, header);
    }

    // Generic simple format
    const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i !== -1) return i; } return -1; };
    const col = {
      name:    idx('name', 'structure', 'structurename'),
      system:  idx('system', 'systemname', 'solarsystem', 'location'),
      facility:idx('facility', 'type', 'facilitytype'),
      size:    idx('size', 'structuresize'),
      sec:     idx('security', 'sec', 'secstatus', 'securitystatus'),
      matRig:  idx('materialrig', 'matrig', 'merig', 'materialrigtype'),
      timeRig: idx('timerig', 'terig', 'timerigtype'),
      tax:     idx('tax', 'taxrate', 'facilitytax', 'facilitytaxrate'),
    };
    const at = (cells, i) => (i >= 0 && i < cells.length) ? cells[i] : '';
    const out = [];
    for (let r = 1; r < lines.length; r++) {
      const cells = splitCsvLine(lines[r]);
      const name = at(cells, col.name).trim();
      const system = at(cells, col.system).trim();
      if (!name && !system) continue;
      out.push({
        name:          name || system || `Structure ${r}`,
        systemName:    system,
        systemId:      null,
        facility:      normFacility(at(cells, col.facility)),
        structureSize: normSize(at(cells, col.size)),
        secStatus:     normSec(at(cells, col.sec)),
        matRig:        normRig(at(cells, col.matRig)),
        timeRig:       normRig(at(cells, col.timeRig)),
        taxRate:       normTax(at(cells, col.tax)),
      });
    }
    return out;
  }

  // Extract the spreadsheet doc id from any Google Sheets URL.
  function sheetDocId(url) {
    const m = String(url || '').match(/\/spreadsheets\/d\/(?:e\/)?([A-Za-z0-9_-]+)/);
    return m ? m[1] : '';
  }

  // Build a gviz CSV URL for a specific tab by name. gviz fetches link-shared
  // sheets without requiring "Publish to web", and always targets the right tab.
  function toSheetTabCsvUrl(url, sheetName) {
    const id = sheetDocId(url);
    if (!id) return String(url || '');
    const sheet = sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : '';
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${sheet}`;
  }

  // Normalise a Google Sheets share/edit/publish URL to a CSV export URL.
  function toCsvExportUrl(url) {
    if (!url) return '';
    const u = String(url).trim();
    if (/format=csv|output=csv/i.test(u)) return u;            // already CSV
    const m = u.match(/\/spreadsheets\/d\/(?:e\/)?([A-Za-z0-9_-]+)/);
    if (!m) return u;
    const id  = m[1];
    const gid = (u.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }

  return {
    SCC_SURCHARGE, SKILL_INDUSTRY, SKILL_ADV_INDUSTRY, JITA_SYSTEM_ID,
    STRUCT_MAT_BONUS, EC_TIME_BY_SIZE, RIG_MAT, RIG_TIME, SEC_MULT,
    secMult, structMatBonus, structTimeBonus, rigMatBonus, rigTimeBonus,
    matModifier, timeModifier, adjustedQty, totalTime, eiv, jobFee,
    structureToFacility, deriveRigTiers,
    parseStructuresCsv, toCsvExportUrl, toSheetTabCsvUrl, sheetDocId,
  };
});
