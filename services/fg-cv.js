// Future Generali Commercial-Vehicle (GCV / PCV) rate resolver.
//
// FG's CV commission = OD rate + TP rate (Comprehensive); TP-only → TP; SAOD → OD.
// The grid (config/fg_cv_grid.json, generated from "CV payout IMD…xlsx", TP cols
// "wef 10-Feb-2026") is keyed by Region × Weight-category, each carrying an OD
// out-flow and 3 TP out-flows (premium bands <50K / 50K-2L / >2L). The premium
// band isn't reliably derivable, so we take the MAX TP for the cell ("match max").
//
// Region comes from the FG RTO master (config/fg_rto_zone.json: RTA → state, zone).
// Region = state, EXCEPT Maharashtra which splits by zone: MUMBAI → "MAHARASHTRA"
// (metro), every other zone (WEST: Pune/Nashik/…) → "ROM" (Rest of Maharashtra).
// Weight-category comes from the vehicle's GVW (PR tonnage, in kg) for GCV-4W, or
// from the body type (3-wheeler auto, taxi, bus, tractor) otherwise.
//
// Returns: number (fraction) | null (FG doesn't operate the cell → decline) |
//          undefined (can't resolve — caller keeps the engine's existing rule).

const path = require('path');
let GRID = null, RTO = null;
function grid() { if (!GRID) { try { GRID = require(path.join(__dirname, '..', 'config', 'fg_cv_grid.json')); } catch (_) { GRID = {}; } } return GRID; }
function rtoZone() { if (!RTO) { try { RTO = require(path.join(__dirname, '..', 'config', 'fg_rto_zone.json')); } catch (_) { RTO = {}; } } return RTO; }

// Fallback prefix → grid region (for RTOs absent from the master). Names match the
// grid's Region strings. Maharashtra falls back to ROM (the common case) when the
// zone is unknown — Mumbai-metro RTOs are in the master so they resolve correctly.
const PREFIX_STATE = {
  GJ: 'GUJARAT', MH: 'ROM', JH: 'JHARKHAND', JK: 'JAMMU & KASHMIR', BR: 'BIHAR',
  DL: 'DELHI', KA: 'KARNATAKA', TN: 'TAMIL NADU', RJ: 'RAJASTHAN', UP: 'UTTAR PRADESH',
  HR: 'HARYANA', PB: 'PUNJAB', WB: 'WEST BENGAL', MP: 'MADHYA PRADESH', GA: 'GOA',
  KL: 'KERALA', AP: 'ANDHRA PRADESH', TS: 'TELANGANA', TG: 'TELANGANA', OD: 'ODISHA',
  OR: 'ODISHA', CG: 'CHATTISGARH', UA: 'UTTARAKHAND', UK: 'UTTARAKHAND',
  HP: 'HIMACHAL PRADESH', CH: 'CHANDIGARH', AS: 'ASSAM', DD: 'DAMAN & DIU',
  DN: 'DADRA & NAGAR HAVELI', PY: 'PUDUCHERRY', ML: 'MEGHALAYA', MN: 'MANIPUR',
  MZ: 'MIZORAM', NL: 'NAGALAND', TR: 'TRIPURA', SK: 'SIKKIM', AR: 'ARUNACHAL PRADESH',
  LD: 'LAKSHADWEEP', AN: 'ANDAMAN & NICOBAR ISLANDS', LA: 'LADAKH',
};

function norm(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// RTO-master state spellings that differ from the IMD grid's Region name.
const STATE_ALIAS = {
  'DIU DAMAN': 'DAMAN & DIU',
  'DAMAN AND DIU': 'DAMAN & DIU',
  'DADAR & NAGAR HAVELI': 'DADRA & NAGAR HAVELI',
  'DADRA AND NAGAR HAVELI': 'DADRA & NAGAR HAVELI',
  'JAMMU AND KASHMIR': 'JAMMU & KASHMIR',
  'ANDAMAN AND NICOBAR ISLANDS': 'ANDAMAN & NICOBAR ISLANDS',
};

function resolveRegion(rtoCode) {
  const code = norm(rtoCode);
  if (!code) return null;
  const info = rtoZone()[code];
  let state = info && info.state, zone = info && info.zone;
  if (!state) {
    const fb = PREFIX_STATE[code.slice(0, 2)];
    return fb && grid()[fb] ? fb : null;
  }
  state = STATE_ALIAS[state] || state;
  // Maharashtra splits by zone (RTO-master driven, not RTO-hardcoded).
  if (state === 'MAHARASHTRA') state = (zone === 'MUMBAI') ? 'MAHARASHTRA' : 'ROM';
  return grid()[state] ? state : null;
}

// GVW → tonnes (PR stores it in kg, e.g. 2960 → 2.96; tolerate values already in T).
function toTonnes(gvw) {
  const n = Number(gvw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 100 ? n / 1000 : n;
}

// Tonnes → GCV-4W weight category.
function gcvBandFromTonnes(t) {
  if (t == null) return null;
  if (t <= 2.5) return 'Below 2.5 Tons';
  if (t <= 3.5) return 'Below 3.5 Tons';
  if (t <= 7.5) return '3.5K-7.5K';
  if (t <= 12)  return '7.5K-12K';
  if (t <= 20)  return '12K-20K';
  if (t <= 40)  return '20K-40K';
  return '40k +';
}
// Parse the tmp vehicleCategory band text ("GCV - 4W 12-20Tn", "…40Tn+", "…Upto 2.5Tn").
function gcvBandFromCategory(cat) {
  if (/40\s*TN?\s*\+|40\s*\+|ABOVE\s*40/.test(cat)) return '40k +';
  if (/20\s*-\s*40/.test(cat)) return '20K-40K';
  if (/12\s*-\s*20/.test(cat)) return '12K-20K';
  if (/7\.5\s*-\s*12/.test(cat)) return '7.5K-12K';
  if (/3\.5\s*-\s*7\.5/.test(cat)) return '3.5K-7.5K';
  if (/2\.5\s*-\s*3\.5/.test(cat)) return 'Below 3.5 Tons';
  if (/UPTO\s*2\.5|UP\s*TO\s*2\.5/.test(cat)) return 'Below 2.5 Tons';
  return null;
}

function weightCategory(params, gvw) {
  const vt = String(params.vehicleType || '').toUpperCase();
  const cat = String(params.vehicleCategory || '').toUpperCase();
  const is3W = /\b3\s*W\b|3\s*WH|RICKSHAW|RIKSHAW/.test(cat);
  if (vt === 'GCV') {
    if (is3W) return '3W GCV';
    // GVW (PR) is authoritative — the tmp category band is sometimes mis-bucketed
    // (e.g. a 2.96T truck tagged "Upto 2.5Tn"). Fall back to the category text when
    // GVW is absent.
    return gcvBandFromTonnes(toTonnes(gvw)) || gcvBandFromCategory(cat);
  }
  if (vt === 'PCV') {
    if (is3W) return 'Auto';
    if (/SCHOOL/.test(cat)) return 'School Bus';
    if (/BUS/.test(cat)) return 'Other Bus';
    return 'Taxi';
  }
  return null;
}

function maxTp(cell) {
  const vals = (cell.tp || []).filter(v => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? Math.max(...vals) : null;
}

/**
 * @param {object} params  policy params (rtoCode, vehicleType, insProduct, vehicleCategory)
 * @param {number} gvw      gross vehicle weight (kg) from the PR row (may be null)
 * @returns {number|null|undefined}
 */
function resolveFgCvRate(params, gvw) {
  const region = resolveRegion(params.rtoCode);
  if (!region) return undefined;
  const wc = weightCategory(params, gvw);
  if (!wc) return undefined;
  const cell = grid()[region] && grid()[region][wc];
  if (!cell) return undefined;
  if (cell.operate === false) return null;             // FG declines this cell
  const ip = String(params.insProduct || '').toUpperCase();
  const od = (typeof cell.od === 'number') ? cell.od : null;
  const tp = maxTp(cell);
  // Returns { rate, od, tp } (all fractions): rate = headline for operator
  // rate-matching; od/tp = per-leg commission so income = OD%×OD-prem +
  // TP%×TP-prem. (null = decline, undefined = not handled — unchanged.)
  if (ip === 'TP' || ip === 'SATP') return tp != null ? { rate: tp, od: 0, tp } : undefined;
  if (ip === 'SAOD') return od != null ? { rate: od, od, tp: 0 } : undefined;   // OD leg only
  if (od == null || tp == null) return undefined;
  return { rate: +(od + tp).toFixed(4), od, tp };           // Comprehensive = OD + TP
}

module.exports = { resolveFgCvRate, resolveRegion, weightCategory };
