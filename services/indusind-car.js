'use strict';

/**
 * IndusInd Private Car — "June PVT COM" grid (eff 1-Jun-26). A region-group ×
 * {Non-Diesel-Com / Diesel / SAOD / STP} table (config/indusind_car.json).
 * Cover from premiums: STP = od<=0; SAOD = od>0 & tp<=0; else Comp (Package),
 * where Comp splits Diesel vs Non-Diesel (petrol/CNG/EV). STP is 0 everywhere.
 *
 * Region groups are coarse (state-level) with three metro splits:
 *   Mumbai/Pune/Goa, Bangalore/Hyderabad, Kolkata — detected by city name
 *   (params.city/_cityName) with an RTO-code fallback for the metros.
 * Returns the rate FRACTION or null (no region resolved -> engine unchanged).
 */
const GRID = require('../config/indusind_car.json').grid;
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const RATE = {};
for (const g of GRID) RATE[norm(g.region)] = g;

// metro RTO-code prefixes (state+number) for the city splits
const MUMBAI_PUNE = new Set(['MH01','MH02','MH03','MH04','MH43','MH47','MH48','MH12','MH14']);
const BANGALORE = new Set(['KA01','KA02','KA03','KA04','KA05','KA41','KA50','KA51','KA53']);
const HYDERABAD = new Set(['TS07','TS08','TS09','TS10','TS11','TS12','TS13','TS14','AP09','AP10','AP11','AP12','AP13','TG07','TG08','TG09','TG10','TG11','TG12','TG13','TG14']);
const KOLKATA = new Set(['WB01','WB02','WB03','WB04','WB05','WB06','WB07','WB08','WB09','WB10','WB19','WB20','WB24','WB26']);

function rtoKey(rtoCode) {
  const c = norm(rtoCode).replace(/[^A-Z0-9]/g, '');
  const m = c.match(/^([A-Z]+)(\d+)$/);
  return m ? m[1] + String(parseInt(m[2], 10)).padStart(2, '0') : c;
}
function regionGroup(params) {
  const st = rtoKey(params.rtoCode).replace(/\d+$/, '');   // state prefix
  const rk = rtoKey(params.rtoCode);
  const city = norm(params.city || params.cityName || params._cityName);
  const isMumPune = /MUMBAI|PUNE|THANE|NAVI MUMBAI/.test(city) || MUMBAI_PUNE.has(rk);
  const isBlr = /BANGALORE|BENGALURU/.test(city) || BANGALORE.has(rk);
  const isHyd = /HYDERABAD|SECUNDERABAD/.test(city) || HYDERABAD.has(rk);
  const isKol = /KOLKATA|CALCUTTA/.test(city) || KOLKATA.has(rk);
  switch (st) {
    case 'GA': return 'MUMBAI/PUNE/GOA';
    case 'MH': return isMumPune ? 'MUMBAI/PUNE/GOA' : 'REST OF MAHARASTRA';
    case 'GJ': case 'DD': case 'DN': return 'GUJARAT';
    case 'MP': return 'MADYAPRADESH';
    case 'KA': return isBlr ? 'BANGLORE ,HYDERABAD' : 'REST OF KA,TS,AP';
    case 'TS': case 'TG': case 'AP': return isHyd ? 'BANGLORE ,HYDERABAD' : 'REST OF KA,TS,AP';
    case 'KL': case 'LD': return 'KERALA';
    case 'TN': case 'PY': return 'TAMILNADU';
    case 'DL': return 'DELHI';
    case 'PB': case 'HP': case 'JK': case 'LA': case 'CH': return 'PUNJAB,HP AND JK';
    case 'UP': case 'UK': case 'HR': case 'RJ': return 'UP ,HARYANA,RAJASTHAN';
    case 'OD': case 'OR': case 'CG': case 'AS': case 'AR': case 'MN': case 'ML': case 'MZ': case 'NL': case 'TR': case 'SK':
      return 'NE,ODISHA,CHATTISHGARH';
    case 'BR': case 'JH': return 'BIHAR,JHARKHAND';
    case 'WB': return isKol ? 'KOLKATTA' : 'WEST BENGAL';
    default: return null;
  }
}

function resolveIndusindCarRate(params) {
  if (norm(params.vehicleType) !== 'CAR') return null;
  const grp = regionGroup(params);
  if (!grp) return null;
  const row = RATE[grp];
  if (!row) return null;
  const od = Number(params.odPremium) || 0;
  const tp = Number(params.tpPremium) || 0;
  let rate;
  if (od <= 0) rate = row.stp;                         // TP-only
  else if (tp <= 0) rate = row.saod;                   // standalone OD
  // Diesel tier (lower). Source fuel is sometimes the single-letter code "D"
  // (Mahindra Thar "LX HARD TOP DIESEL" arrives fuel="D"), so match "D" too — else
  // a diesel wrongly takes the Non-Diesel rate (Thar HR26: 15 vs 30).
  else rate = /DIESEL|^D$/.test(norm(params.fuelType)) ? row.diesel : row.nonDieselCom;
  return rate == null ? null : +Number(rate).toFixed(4);
}

module.exports = { resolveIndusindCarRate, regionGroup };
