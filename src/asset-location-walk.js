// ─── asset-location-walk.js ───────────────────────────────────────────────────
// Pure asset-location chain resolver. No DB / native deps so it is unit-testable
// in plain `node --test`.
//
// ESI returns a character's assets as a FLAT list: each row's location_id points
// at its IMMEDIATE parent — a station, a structure, a solar system, or ANOTHER
// item the character owns (a ship, a container, an asset-safety wrap). Only rows
// whose parent is a root (station/structure/system) get a resolved location at
// sync time; deeper-nested rows store NULL and must inherit their place from an
// ancestor. This walk climbs the location_id pointers to find that ancestor.
//
// The membership test — "is this location_id one of MY item_ids?" — is what
// separates a container I own (keep climbing) from the Upwell structure I merely
// dock in (the walk's terminus). Handles arbitrary nesting depth, where a
// fixed-depth self-JOIN silently fails past a few hops.
'use strict';

// A name that is really a placeholder, not a place — mirrors the locator's
// _isUnresolvedName so we never treat a fallback as a resolved terminus.
function isPlaceholderName(s) {
  return !s
    || /^(structure|location|station)\s+\d+$/i.test(s)
    || /no structure found|not found|forbidden|^error/i.test(s);
}

// resolveAssetLocationChain(startRow, ctx)
//
//   startRow   : the row to resolve (undefined → nulls)
//   ctx.byItemId   : Map(item_id → row) of every owned asset row
//   ctx.globalLoc  : Map(id → bundle) for unowned termini resolved elsewhere
//                    (upwell_structures / npc_stations / names_cache)
//   ctx.isPlaceholder(name) → true for "Structure {id}" / error fallbacks
//                    (defaults to isPlaceholderName)
//   ctx.locFields  : the location-bundle field names to carry up the chain
//
// Returns { bundle, terminusId }:
//   bundle     — the resolved location bundle, or null if nothing resolved
//   terminusId — the topmost id the walk reached (the real structure/station id,
//                even when its name is still unknown). Lets callers regroup
//                deeply-nested orphans under their true root instead of an
//                intermediate container's item_id.
function resolveAssetLocationChain(startRow, ctx) {
  const { byItemId, globalLoc, locFields } = ctx;
  const isPlaceholder = ctx.isPlaceholder || isPlaceholderName;
  const hasLoc = (row) => row && (!isPlaceholder(row.location_name) || row.solar_system_name != null);

  let cur        = startRow || null;
  let terminusId = startRow ? startRow.location_id : null;

  for (let depth = 0; depth < 10 && cur; depth++) {
    if (hasLoc(cur)) break;                               // found a resolved ancestor
    terminusId = cur.location_id;
    const parent = byItemId.get(cur.location_id);
    if (!parent || parent === cur) { cur = null; break; } // unowned terminus / self-loop
    cur = parent;
  }

  const bundle = hasLoc(cur)
    ? Object.fromEntries(locFields.map((f) => [f, cur[f]]))
    : (globalLoc.get(terminusId) || null);

  return { bundle, terminusId };
}

module.exports = { resolveAssetLocationChain, isPlaceholderName };
