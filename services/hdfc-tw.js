// HDFC Two-Wheeler (Comp / TP-Only) rate resolver.
//
// HDFC's TW grid ("TW Effective from 1st April.xlsx" → sheet "Grid - Comp, TP
// only") is a clean cross-tab: Policy Type (Comp / TP Only) × Segment (Bike /
// Scooter / Moped) × Fuel × State × Location, with ≤150cc / >150cc columns. RTOs
// map to (State, Location) via the "TW RTO Master" sheet. The generic parser
// mis-ingested it — it conflated Delhi-NCR with Haryana (so a Delhi scooter got
// the Haryana 0.55 instead of the Delhi-NCR 0.60) and dropped the Bike-Comp rows.
// This module reads the pre-extracted grid (config/hdfc_tw_grid.json) + RTO map
// (config/hdfc_tw_rto.json) and returns the authoritative rate.
//
// Returns: number (fraction) | undefined (can't resolve — caller keeps existing
// rule). Scope: HDFC TW, Comp + TP only (SAOD has its own sheet, not handled here).

const path = require('path');
let GRID = null, RTO = null;
function grid() { if (!GRID) { try { GRID = require(path.join(__dirname, '..', 'config', 'hdfc_tw_grid.json')); } catch (_) { GRID = []; } } return GRID; }
function rtoMap() { if (!RTO) { try { RTO = require(path.join(__dirname, '..', 'config', 'hdfc_tw_rto.json')); } catch (_) { RTO = {}; } } return RTO; }

function isScooter(params) {
  const cat = String(params.vehicleCategory || '').toUpperCase();
  const model = String(params.model || '').toUpperCase();
  if (/SCOOT|MOPED/.test(cat)) return true;
  if (/BIKE|MOTOR\s*CYCLE|MOTORCYCLE/.test(cat)) return false;
  // model fallback (common scooter models)
  return /ACTIVA|JUPITER|NTORQ|N-?TORQ|DIO|ACCESS|MAESTRO|FASCINO|VESPA|PLEASURE|SCOOTY|BURGMAN|AVENIS|RAY|GRAZIA|AEROX|PEP/.test(model);
}

function findRow(state, loc, scooter, pt) {
  const segMatch = r => scooter ? /SCOOTER|MOPED/i.test(r.seg) : /BIKE/i.test(r.seg);
  const rows = grid().filter(r => r.state === state && r.pt === pt && segMatch(r));
  if (!rows.length) return null;
  return rows.find(r => r.loc && loc && r.loc.toUpperCase() === loc.toUpperCase())
      || rows.find(r => !r.loc || /^all$/i.test(r.loc))
      || rows[0];
}

/**
 * @param {object} params  policy params (rtoCode, vehicleCategory, model, cc, insProduct)
 * @param {string} resolvedRegion
 * @param {boolean} isSatp  true for TP-only
 * @returns {number|undefined}
 */
function resolveTwRate(params, resolvedRegion, isSatp) {
  const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let loc = null, state = null;
  const fromCode = code && rtoMap()[code];
  if (fromCode) { state = fromCode.state; loc = fromCode.loc; }
  else {
    // fall back to the resolved region as the location, and infer state from prefix
    loc = resolvedRegion || null;
    const ST = { MH: 'Maharashtra', GJ: 'Gujarat', DL: 'Delhi NCR', HR: 'Haryana', KA: 'Karnataka',
      WB: 'West Bengal', TG: 'Telangana', TS: 'Telangana', AP: 'Andhra Pradesh', HP: 'Himachal Pradesh',
      OD: 'Odisha', OR: 'Odisha', PB: 'Punjab', CH: 'Chandigarh', JH: 'Jharkhand', BR: 'Bihar',
      UA: 'Uttarakhand', UK: 'Uttarakhand', RJ: 'Rajasthan', MP: 'Madhya Pradesh', TN: 'Tamil Nadu',
      UP: 'Uttar Pradesh', GA: 'Goa', JK: 'Jammu and Kashmir', CG: 'Chattisgarh' };
    state = ST[code.slice(0, 2)] || null;
  }
  if (!state) return undefined;
  const pt = isSatp ? 'TP Only' : 'Comp';
  const row = findRow(state, loc, isScooter(params), pt);
  if (!row) return undefined;
  const cc = Number(params.cc) || 0;
  const v = cc > 150 ? row.gt150 : row.le150;
  if (v === '' || v == null) return undefined;
  const n = parseFloat(String(v));
  if (!Number.isFinite(n)) return undefined;
  return n > 1 ? n / 100 : n;
}

// ---- SAOD ----
let SAOD = null;
function saodGrid() { if (!SAOD) { try { SAOD = require(path.join(__dirname, '..', 'config', 'hdfc_tw_saod.json')); } catch (_) { SAOD = []; } } return SAOD; }

/**
 * Resolve HDFC TW SAOD rate. The operator uses the BASE (blank-remarks) row;
 * "exc X" rows apply only when there is no plain row and the make isn't X. The
 * sheet's "TVS 10% less" note is NOT applied (operator pays the base rate — e.g.
 * TVS Jupiter Delhi-NCR Scooter → 25, not 20/15).
 * @returns {number|undefined}
 */
function resolveTwSaodRate(params, resolvedRegion) {
  const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const fromCode = code && rtoMap()[code];
  let state = fromCode && fromCode.state, loc = fromCode && fromCode.loc;
  if (!state) {
    const ST = { MH: 'Maharashtra', GJ: 'Gujarat', DL: 'Delhi NCR', HR: 'Haryana', KA: 'Karnataka',
      WB: 'West Bengal', TG: 'Telangana', TS: 'Telangana', AP: 'Andhra Pradesh', HP: 'Himachal Pradesh',
      OD: 'Odisha', OR: 'Odisha', PB: 'Punjab', CH: 'Chandigarh', JH: 'Jharkhand', BR: 'Bihar',
      UA: 'Uttarakhand', UK: 'Uttarakhand', RJ: 'Rajasthan', MP: 'Madhya Pradesh', TN: 'Tamil Nadu',
      UP: 'Uttar Pradesh', GA: 'Goa' };
    state = ST[code.slice(0, 2)] || null;
    loc = resolvedRegion || null;
  }
  if (!state) return undefined;
  const scooter = isScooter(params);
  const make = String(params.make || '').toUpperCase();
  const segMatch = r => scooter ? /SCOOTER|MOPED/i.test(r.seg) : /BIKE/i.test(r.seg);
  let rows = saodGrid().filter(r => r.state === state && segMatch(r));
  if (loc) {
    const byLoc = rows.filter(r => r.loc && r.loc.toUpperCase() === String(loc).toUpperCase());
    if (byLoc.length) rows = byLoc; else rows = rows.filter(r => !r.loc || /^all$/i.test(r.loc)).length ? rows.filter(r => !r.loc || /^all$/i.test(r.loc)) : rows;
  }
  if (!rows.length) return undefined;
  // "exc X" applies only when make != X; drop rows excluded for this make.
  const applic = rows.filter(r => {
    const m = r.rem.match(/exc\s+(.+)/i);
    if (!m) return true;
    const excl = m[1].split(/[,/&]/).map(s => s.trim().toUpperCase()).filter(Boolean);
    return !excl.some(x => make.includes(x) || x.includes(make));
  });
  const pool = applic.length ? applic : rows;
  // prefer the blank-remarks (base) row
  const base = pool.find(r => !r.rem) || pool[0];
  const v = base && base.bde;
  if (v === '' || v == null) return undefined;
  const n = parseFloat(String(v));
  if (!Number.isFinite(n)) return undefined;
  return n > 1 ? n / 100 : n;
}

module.exports = { resolveTwRate, resolveTwSaodRate, isScooter };
