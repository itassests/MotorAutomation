// HDFC PCV / passenger-3W (e-rickshaw & 3W autos) rate resolver.
//
// HDFC's "PCCV 3W" grid files a SINGLE cover-agnostic payout (column "BDE") per
// State × Location × Business-type(New/Non-New) × Fuel — there is NO Comp/TP
// split. The base ingest labeled every row rate_type=COMP, so TP-only policies
// (e-rickshaws are usually TP) match nothing → 0%. Additionally HDFC has ZERO
// rto_mappings, so the region never resolves (falls to the bare booked-location
// city, e.g. "MEERUT", which matches no region label) → also 0%.
//
// This resolver fixes both: it maps the registration RTO → the grid's region
// label via the authoritative "HDFC RTO Master" (config/hdfc_rto_master.json,
// GCV-3W sheet) and returns the single BDE rate (config/hdfc_pcv_3w.json), which
// bulk.js applies to Comp AND TP alike. Scope: passenger 3W only; goods 3W keeps
// the GCV resolver (services/hdfc-gcv.js).

const path = require('path');
let MASTER = null, PCV = null;
function master() { if (!MASTER) { try { MASTER = require(path.join(__dirname, '..', 'config', 'hdfc_rto_master.json')); } catch (_) { MASTER = {}; } } return MASTER; }
function pcv() { if (!PCV) { try { PCV = require(path.join(__dirname, '..', 'config', 'hdfc_pcv_3w.json')); } catch (_) { PCV = {}; } } return PCV; }

const regKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// master GCV-3W location-group NAME → the PCV-3W grid's region LABEL (regKey'd).
const GROUP_TO_PCV = {
  'West Uttar Pradesh': 'West UP, Lucknow, Varanasi, Kanpur, Allahabad',
  'Lucknow': 'West UP, Lucknow, Varanasi, Kanpur, Allahabad',
  'Kanpur': 'West UP, Lucknow, Varanasi, Kanpur, Allahabad',
  'Varanasi': 'West UP, Lucknow, Varanasi, Kanpur, Allahabad',
  'Allahabad': 'West UP, Lucknow, Varanasi, Kanpur, Allahabad',
  'Bengaluru': 'Bangalore',
  'Ahmedabad': 'Ahm, Vad, Surat', 'Vadodra': 'Ahm, Vad, Surat', 'Surat': 'Ahm, Vad, Surat',
  'Vijayawada': 'Visakhapatnam Vijaywada', 'Visakhapatnam': 'Visakhapatnam Vijaywada',
  'Bhubaneshwar': 'Bhubaneswar Cuttack', 'Cuttack': 'Bhubaneswar Cuttack',
  'Mumbai': 'Mumbai,Pune', 'Pune': 'Mumbai,Pune',
  'Nagpur': 'Nashik Nagpur', 'Nashik': 'Nashik Nagpur',
  'Chennai': 'Chennai', 'Delhi NCR': 'Delhi NCR', 'Hyderabad': 'Hyderabad',
  'Indore': 'Indore', 'Kolkata': 'Kolkata',
  'Mysore': 'ROK', 'Goa': 'ROM',
};
const DECLINE_GROUP = /declined/i;

function is3W(params) {
  const hay = `${String(params.vehicleCategory || '')} ${String(params.model || '')}`.toUpperCase();
  return /3\s*-?\s*W|3\s*WHEEL|RIKSHAW|RICKSHAW|E[-\s]?RICK|E[-\s]?RIK/.test(hay);
}
function isPassenger(params) {
  const cat = String(params.vehicleCategory || '').toUpperCase();
  const vt = String(params.vehicleType || '').toUpperCase();
  if (/GOODS|GCV|GOOD CARRYING/.test(cat)) return false;
  return vt === 'PCV' || /PASSENGER|RIKSHAW|RICKSHAW|E[-\s]?RICK/.test(cat);
}
function fuelFam(params) {
  // CNG / LPG / Petrol all share the grid's "Petrol/CNG/LPG" column → PETROL.
  const f = `${String(params.fuelType || '')} ${String(params.vehicleCategory || '')}`.toUpperCase();
  if (/EV|ELECTRIC|E-?RICK|E-?RIK/.test(f)) return 'EV';
  if (/DIESEL/.test(f)) return 'DIESEL';
  return 'PETROL';
}

// Resolve the grid region-label key for a passenger-3W policy.
function regionKeyFor(params, resolvedRegion) {
  const code = normCode(params.rtoCode);
  const group = master().gcv3 && master().gcv3[code];
  if (group) {
    if (DECLINE_GROUP.test(group)) return '__DECLINE__';
    if (GROUP_TO_PCV[group]) return regKey(GROUP_TO_PCV[group]);
    // group name that IS a config label (e.g. "Kolkata") — match by regKey.
    if (pcv()[regKey(group)]) return regKey(group);
  }
  // fall back to the already-resolved region string (booked-location etc.)
  if (resolvedRegion && pcv()[regKey(resolvedRegion)]) return regKey(resolvedRegion);
  return null;
}

/**
 * PCV-3W region label (for display / resolvedRegion), or null.
 */
function resolveHdfcPcvRegion(params, resolvedRegion) {
  if (!params || !params.rtoCode) return null;
  if (!(is3W(params) && isPassenger(params))) return null;
  const rk = regionKeyFor(params, resolvedRegion);
  if (!rk || rk === '__DECLINE__') return null;
  const e = pcv()[rk];
  return (e && e._label) || null;
}

/**
 * Cover-agnostic PCV-3W payout rate for a policy (applies to Comp & TP).
 * @returns {number|null|undefined} number rate, null = declined, undefined = leave engine.
 */
function resolveHdfcPcv3wRate(params, resolvedRegion) {
  if (!params || !params.rtoCode) return undefined;
  if (!(is3W(params) && isPassenger(params))) return undefined;
  const rk = regionKeyFor(params, resolvedRegion);
  if (rk === '__DECLINE__') return null;
  const e = rk && pcv()[rk];
  if (!e) return undefined;
  const biz = (Number(params.vehicleAge) || 0) === 0 ? 'New' : 'NonNew';
  const ff = fuelFam(params);
  const band = e[biz] || e[biz === 'NonNew' ? 'New' : 'NonNew'];
  if (!band) return undefined;
  const rate = band[ff] != null ? band[ff] : band['PETROL'];
  return rate != null ? rate : undefined;
}

module.exports = { resolveHdfcPcvRegion, resolveHdfcPcv3wRate };
