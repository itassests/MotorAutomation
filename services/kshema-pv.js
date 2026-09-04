'use strict';

/**
 * Kshema Private Car — "PV Terms" block of the Aug'26 grid
 * (config/kshema_pv_aug26.json). Payout by STATE × CC-band
 * [<1000, 1000–1500, >1500], with metro-city overrides (Chennai, Bangalore,
 * Mumbai/Pune, Kolkata, Hyderabad) that win over their state. Karnataka and
 * Tamil Nadu are ONLY offered via their metro city (no state row).
 *
 * Declines: a fixed list of states (MP/Kerala/CG/J&K/Puducherry/Ladakh/
 * Lakshadweep/Rajasthan) and models (Indica/Indigo/Qualis/Tata Magic/Bolero
 * Pickup/Omni/Eeco). Haryana Pvt-Car is offered ONLY for 6 RTOs (HR26/51/72/
 * 38/55/29); other HR RTOs decline. Returns { rate, declined } or null.
 */
const PV = require('../config/kshema_pv_aug26.json');
const { STATE_CANON } = require('../parsers/engines/kshema');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const rtoKey = (rto) => {
  const c = norm(rto).replace(/[^A-Z0-9]/g, '');
  const m = c.match(/^([A-Z]+)0*(\d+)/);
  return m ? m[1] + m[2].padStart(2, '0') : c;
};
const ccIdx = (cc) => (cc > 0 && cc < 1000) ? 0 : (cc <= 1500 ? 1 : 2);

function cityKey(params) {
  const c = norm(params.city || params.cityName || params._cityName);
  if (/CHENNAI/.test(c)) return 'CHENNAI';
  if (/BANGALORE|BENGALURU/.test(c)) return 'BANGALORE';
  if (/MUMBAI|PUNE|THANE|PIMPRI|NAVI\s*MUMBAI/.test(c)) return 'MUMBAI_PUNE';
  if (/KOLKATA|CALCUTTA/.test(c)) return 'KOLKATA';
  if (/HYDERABAD|SECUNDERABAD/.test(c)) return 'HYDERABAD';
  return null;
}

function resolveKshemaPvRate(params) {
  if (norm(params.vehicleType) !== 'CAR') return null;
  const hay = `${norm(params.model)} ${norm(params.make)} ${norm(params.vehicleCategory)}`;
  if ((PV.declinedModels || []).some((m) => hay.includes(m))) return { rate: 0, declined: true };

  const cc = Number(params.cc) || 0;
  const idx = ccIdx(cc);

  // Metro city wins over state.
  const ck = cityKey(params);
  if (ck && PV.cities[ck]) { const v = PV.cities[ck][idx]; return v == null ? null : { rate: +Number(v).toFixed(4), declined: v === 0 }; }

  const pfx = norm(params.rtoCode).replace(/[^A-Z]/g, '').slice(0, 2);
  const st = STATE_CANON[pfx] || STATE_CANON[norm(params.stateName)] || null;
  if (!st) return null;
  if ((PV.declinedStates || []).includes(st)) return { rate: 0, declined: true };
  if (st === 'HARYANA') {
    if (!(PV.hrRtos || []).includes(rtoKey(params.rtoCode))) return { rate: 0, declined: true };
  }
  const trip = PV.states[st];
  if (!trip) return null;
  const v = trip[idx];
  return v == null ? null : { rate: +Number(v).toFixed(4), declined: v === 0 };
}

module.exports = { resolveKshemaPvRate };
