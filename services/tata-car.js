'use strict';

/**
 * TATA AIG Private Car — June'26 flat grid (sheet "Private Car" of
 * "Grid PCI & TW- June 26- Robinhood.xlsx"). The grid is a flat table keyed on
 *   Business Type (Brand New / Renewal / Rollover)
 *   × Section       (Package / SAOD / SATP)   -> the cover
 *   × Fuel          (All / Diesel / CNG / Electric / Other Than Diesel)
 *   × RTO           (All + ~55 city/cluster labels — match the tata car clusters)
 *   × NCB           (All / Yes / No)
 *   -> rate %.
 * Package & SAOD rates are pan-India (RTO=All) by fuel×NCB; SATP is RTO-specific.
 *
 * This sheet was NEVER ingested (the config matched ^pci$ / ^pvt car$, the June
 * file named it "Private Car"), so we resolve it here instead — config-driven,
 * like services/united-car.js / reliance-car.js. resolveTataCarRate returns the
 * rate FRACTION or null (no match -> engine keeps whatever it had).
 *
 * Cover from premiums: SATP = od<=0; SAOD = od>0 & tp<=0; Package = od>0 & tp>0.
 * RTO -> grid label via config/tata_rto_cluster.json (the `.car` cluster).
 */
const GRID = require('../config/tata_car_jun26.json').grid;
const CLUSTER = require('../config/tata_rto_cluster.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

function fuelCat(f) {
  const u = norm(f);
  if (/DIESEL/.test(u)) return 'DIESEL';
  if (/CNG|LPG|INBUILT/.test(u)) return 'CNG';
  if (/ELECTRIC|\bEV\b|BATTERY/.test(u)) return 'ELECTRIC';
  return 'PETROL';   // petrol / unknown -> "Other Than Diesel"
}
function bizCat(params) {
  const b = norm(params.businessType);
  // USER RULE: "new business" ≠ "new vehicle". Brand New applies ONLY to a
  // genuinely new vehicle — vehicle age EXACTLY 0. New business on any older OR
  // unknown-age vehicle is a Rollover (new-to-insurer, not a new vehicle). No NCB
  // proxy: an unknown age is treated as an existing vehicle, never Brand New.
  const age = (params.vehicleAge != null && params.vehicleAge !== '') ? Number(params.vehicleAge) : null;
  if (/ROLL/.test(b)) return 'Rollover';
  if (/RENEW/.test(b)) return 'Renewal';
  if (/NEW/.test(b)) return age === 0 ? 'Brand New' : 'Rollover';
  return age === 0 ? 'Brand New' : 'Renewal';
}
function sectionCat(params) {
  const od = Number(params.odPremium) || 0;
  const tp = Number(params.tpPremium) || 0;
  if (od <= 0) return 'SATP';
  if (tp <= 0) return 'SAOD';
  return 'Package';
}
function gridRto(params) {
  const code = norm(params.rtoCode).replace(/[^A-Z0-9]/g, '');
  if (!code) return null;
  const keys = [code];
  const m = code.match(/^([A-Z]+)(\d+)$/);
  if (m) keys.push(m[1] + String(parseInt(m[2], 10)).padStart(2, '0'), m[1] + parseInt(m[2], 10));
  for (const k of keys) { if (CLUSTER[k] && CLUSTER[k].car) return CLUSTER[k].car; }
  return null;
}

function resolveTataCarRate(params) {
  if (norm(params.vehicleType) !== 'CAR') return null;
  const biz = bizCat(params), section = sectionCat(params), fc = fuelCat(params.fuelType);
  const ncbYes = (Number(params.ncbPct) || 0) > 0;
  const rto = gridRto(params);
  let best = null, bestScore = -1;
  for (const g of GRID) {
    if (g.biz !== biz || g.section !== section) continue;
    // fuel specificity
    const gf = norm(g.fuel);
    let fs;
    if (gf === 'ALL') fs = 0;
    else if (gf === 'DIESEL' && fc === 'DIESEL') fs = 2;
    else if (gf === 'CNG' && fc === 'CNG') fs = 2;
    else if (gf === 'ELECTRIC' && fc === 'ELECTRIC') fs = 2;
    else if (gf === 'OTHER THAN DIESEL' && fc !== 'DIESEL') fs = 1;
    else continue;
    // NCB specificity
    const gn = norm(g.ncb);
    let ns;
    if (gn === 'ALL') ns = 0;
    else if (gn === 'YES' && ncbYes) ns = 2;
    else if (gn === 'NO' && !ncbYes) ns = 2;
    else continue;
    // RTO specificity
    let rs;
    if (norm(g.rto) === 'ALL') rs = 0;
    else if (rto && norm(g.rto) === norm(rto)) rs = 4;
    else continue;
    const score = fs + ns + rs;
    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best ? +(best.rate / 100).toFixed(4) : null;
}

module.exports = { resolveTataCarRate };
