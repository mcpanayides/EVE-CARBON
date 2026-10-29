'use strict';
//
// ─── text.js — plain-text answers for demo mode ───────────────────────────────
//
// The app's raw-text fetch (http-get-text) serves two integrations: iCal feeds
// for the Calendar page, and the GEZ tracker's Google Sheet, read as CSV into
// the blueprint calculator's "My Structures". Demo mode answers both here for
// the demo's own URLs, so a "Sync structures" press on camera works the same
// as on a real profile — and nothing is fetched.

const cal = require('./calendar');

// Not a real sheet: Google sheet ids are 44 random characters, and this is not
// one. Only ever answered locally.
const GEZ_SHEET_ID  = 'vaelin-collective-gez-demo';
const GEZ_SHEET_URL = `https://docs.google.com/spreadsheets/d/${GEZ_SHEET_ID}/edit`;

// The "GEZ Rig List" tab: one row per structure, real Standup rig names so the
// calculator derives the right ME/TE tiers from them (industry-math.js).
const GEZ_CSV = [
  'System,Structure,Name,Service Modules,Rig Slot 1,Rig Slot 2,Rig Slot 3',
  '1DQ1-A,Sotiyo,Vaelin Shipyards,"Manufacturing, Invention, Research",Standup XL-Set Ship Manufacturing Efficiency II,Standup XL-Set Equipment and Consumable Manufacturing Efficiency II,',
  '1DQ1-A,Azbel,Vaelin Components,Manufacturing,Standup L-Set Advanced Component Manufacturing Efficiency II,Standup L-Set Basic Large Ship Manufacturing Efficiency I,',
  '319-3D,Raitaru,Forward Raitaru,Manufacturing,Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II,Standup M-Set Basic Medium Ship Manufacturing Time Efficiency I,Standup M-Set Equipment Manufacturing Material Efficiency I',
  'T5ZI-S,Athanor,Moon Refinery,"Moon Drill, Reprocessing",Standup M-Set Moon Ore Grading Processor I,,',
  '5BTK-M,Tatara,Reaction Farm,"Composite Reactor, Hybrid Reactor",Standup L-Set Reactor Efficiency II,,',
].join('\r\n');

/** Text for one of the demo's own URLs, or null when it is not one of them. */
function text(url, now = Date.now()) {
  const ics = cal.feed(url, now);
  if (ics) return ics;
  if (String(url).includes(`/spreadsheets/d/${GEZ_SHEET_ID}/`)) return GEZ_CSV;
  return null;
}

module.exports = { text, GEZ_SHEET_URL, GEZ_CSV };
