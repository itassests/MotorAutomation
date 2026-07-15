// Shriram NEW-BUSINESS two-wheeler (age-0 BUNDLE) rate resolver.
//
// The June "New Business - 2W" grid is State-group × Manufacturer-group ×
// Body(BIKE ≤180CC / SCOOTER-MOPED / EV) → "Average Net PO (Converted)". The base
// ingest (card591) took the wrong column ("DIS %") AND flattened the make
// dimension, so e.g. a Mumbai Honda new bike got DIS 70 instead of Net PO 35.
// This resolver reads config/shriram_tw_nb.json and returns the correct Net PO.
// Returns: number (fraction) | undefined (no confident match — keep engine rule).

const path = require('path');
let CFG = null;
function cfg() { if (!CFG) { try { CFG = require(path.join(__dirname, '..', 'config', 'shriram_tw_nb.json')); } catch (_) { CFG = []; } } return CFG; }

const CANON = { MH: 'MAHARASHTRA', GJ: 'GUJARAT', KA: 'KARNATAKA', TN: 'TAMILNADU', AP: 'ANDHRAPRADESH',
  TG: 'TELANGANA', TS: 'TELANGANA', UP: 'UTTARPRADESH', DL: 'DELHI', HR: 'HARYANA', PB: 'PUNJAB',
  RJ: 'RAJASTHAN', MP: 'MADHYAPRADESH', CG: 'CHHATTISGARH', BR: 'BIHAR', JH: 'JHARKHAND',
  WB: 'WESTBENGAL', OD: 'ODISHA', OR: 'ODISHA', HP: 'HIMACHALPRADESH', UK: 'UTTARAKHAND',
  UA: 'UTTARAKHAND', AS: 'ASSAM', TR: 'TRIPURA', GA: 'GOA', JK: 'J&K', KL: 'KERALA' };

function makeCanon(m) {
  return String(m || '').toUpperCase().replace(/\bMOTOCORP\b|\bMOTORS?\b|\bAUTO\b|\bINDIA\b|\bLTD\b|\bLIMITED\b|\bAND MAHINDRA\b|&/g, '').replace(/[^A-Z]/g, '');
}
function bodyOf(params) {
  const cat = String(params.vehicleCategory || '').toUpperCase();
  const fuel = String(params.fuelType || '').toUpperCase();
  const model = String(params.model || '').toUpperCase();
  if (/EV|ELECTRIC/.test(fuel)) return 'EV';
  if (/SCOOT|MOPED/.test(cat) || /ACTIVA|JUPITER|NTORQ|DIO|ACCESS|MAESTRO|FASCINO|PLEASURE|BURGMAN|VESPA|SCOOTY|GRAZIA|AEROX|RAY\b/.test(model)) return 'SCOOTER';
  return 'BIKE';
}
// Does config rule cover this policy's state / RTO?
function stateMatches(rule, stateCanon, rtoCode) {
  const rto = String(rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (rule.mumbai) { // "MUMBAI (Excl MH-01,48)" = all Maharashtra except MH01/MH48 (+ ROM/Goa variants)
    if (stateCanon === 'MAHARASHTRA' && rto !== 'MH01' && rto !== 'MH48') return true;
    if (rule.goa && stateCanon === 'GOA') return true;
    return false;
  }
  if (rule.rom && stateCanon === 'MAHARASHTRA') return true;
  if (rule.allExcept) { // "All except(...)" — the excluded tokens are state abbrevs
    const exStates = rule.allExcept.map(x => CANON[x] || x);
    return !exStates.includes(stateCanon);
  }
  if (rule.states && rule.states.includes(stateCanon)) return true;
  return false;
}

// resolvedRegion string (e.g. "Maharashtra", "J & K") → canonical state token.
function regionToCanon(region) {
  const r = String(region || '').toUpperCase().replace(/[^A-Z&]/g, '');
  if (!r) return null;
  if (/JAMMU|^J&K$|^JK$/.test(r)) return 'J&K';
  const vals = new Set(Object.values(CANON));
  if (vals.has(r)) return r;
  // loose contains (e.g. "ANDHRAPRADESH" etc.)
  for (const v of vals) if (r.includes(v) || v.includes(r)) return v;
  return null;
}

/**
 * @returns {number|undefined}
 */
function resolveShriramTwNb(params, resolvedRegion) {
  if ((Number(params.vehicleAge) || 0) !== 0) return undefined; // NEW business only
  const rto = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // NEW vehicles carry reg "NEW" and no RTO — derive the state from the resolved
  // (booking) region instead.
  const stateCanon = CANON[rto.slice(0, 2)] || regionToCanon(resolvedRegion);
  if (!stateCanon) return undefined;
  const body = bodyOf(params);
  const mk = makeCanon(params.make);
  const cc = Number(params.cc) || 0;
  const cand = cfg().filter(r =>
    r.body === body &&
    stateMatches(r, stateCanon, rto) &&
    r.makes.some(x => x === mk || (mk && (mk.includes(x) || x.includes(mk)))) &&
    (r.ccMax == null || cc === 0 || cc <= r.ccMax) &&
    !(r.excl || []).includes(rto) &&
    !((r.except || []).length && (r.except || []).includes(rto))
  );
  if (!cand.length) return undefined;
  // The "MUMBAI (Excl MH-01,48)" group is the BROAD Maharashtra bucket (operator
  // rates MH39/MH18 Honda bikes on it = 35, not the narrower "ROM" 25) — so a
  // mumbai rule wins over a rom rule. Then most-specific make (shorter list).
  cand.sort((a, b) => (b.mumbai ? 1 : 0) - (a.mumbai ? 1 : 0) || a.makes.length - b.makes.length || b.net - a.net);
  return cand[0].net;
}

module.exports = { resolveShriramTwNb, bodyOf, makeCanon };
