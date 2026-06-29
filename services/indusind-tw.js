'use strict';

/**
 * IndusInd Two-Wheeler — "June TW26" grid (eff 1-Jun-26). 43 city/state regions
 * (config/indusind_tw.json) × {Fresh(1+5) / Fresh(5+5) / COMP / SAOD / STP}.
 * Region resolved from the policy City (keyword) with an RTO-state default.
 * Cover: Brand New -> Fresh(1+5); Comp (od>0&tp>0) -> COMP; SAOD (tp<=0) -> SAOD;
 * STP (od<=0) -> STP. Returns rate fraction or null.
 */
const GRID = require('../config/indusind_tw.json').grid;
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const RATE = {};
for (const g of GRID) RATE[norm(g.region)] = g;

// City keyword -> grid region (checked first, most specific).
const CITY = [
  [/MUMBAI|WADALA|WORLI|ANDHERI|BORIVALI|THANE|NAVI\s*MUMBAI|KALYAN|VASAI|PANVEL/, 'Mumbai'],
  [/PUNE|PIMPRI|CHINCHWAD/, 'Pune'],
  [/NAGPUR/, 'Nagpur'],
  [/INDORE/, 'Indore'], [/BHOPAL/, 'Bhopal'], [/GWALIOR/, 'Gwalior'],
  [/UJJAIN/, 'Ujjain'], [/RATLAM/, 'Ratlam'], [/REWA/, 'Rewa'],
  [/HYDERABAD|SECUNDERABAD/, 'Hyderabad'],
  [/BANGALORE|BENGALURU/, 'Banglore'],
  [/CHENNAI/, 'Chennai'], [/COIMBATORE/, 'Coimbatore'],
  [/DELHI/, 'Delhi'],
  [/JAIPUR/, 'Jaipur'], [/UDAIPUR/, 'Udaipur'], [/JODHPUR/, 'Jodhpur'],
  [/CHANDIGARH/, 'Chandigargh UT'],
  [/AHMEDABAD/, 'Ahmedabad'], [/SURAT/, 'Surat'], [/VADODARA|BARODA/, 'Vadodara'],
  [/BHUBANE|BHUBNE/, 'Bhubneshwar'],
  [/KOLKAT|CALCUTTA/, 'Kolkatta'],
];
// RTO-state prefix -> default (rest-of-state) region.
const STATE_DEF = {
  MH: 'ROM', MP: 'Rest of MP', TS: 'Telangana', TG: 'Telangana', AP: 'Telangana',
  KA: 'Karnataka', KL: 'Karala', LD: 'Karala', TN: 'Tamilnadu', PY: 'Tamilnadu',
  DL: 'Delhi', RJ: 'Rest of Rajasthan', PB: 'Punjab', CH: 'Chandigargh UT',
  HP: 'HP and Jammu', JK: 'HP and Jammu', LA: 'HP and Jammu',
  UP: 'UP and UK', UK: 'UP and UK', HR: 'Haryana',
  AS: 'North East', AR: 'North East', MN: 'North East', ML: 'North East',
  MZ: 'North East', NL: 'North East', TR: 'North East', SK: 'North East',
  BR: 'Bihar', JH: 'Jarkhand', OD: 'Orissa', OR: 'Orissa',
  WB: 'Westbengal', CG: 'Chattish Garh', GA: 'GOA',
  GJ: 'Gujarat', DD: 'Gujarat', DN: 'Gujarat',
};

function twRegion(params) {
  const city = norm(params.city || params.cityName || params._cityName);
  for (const [re, reg] of CITY) if (re.test(city)) return reg;
  const st = norm(params.rtoCode).replace(/[^A-Z]/g, '').slice(0, 2);
  return STATE_DEF[st] || null;
}

function resolveIndusindTwRate(params) {
  if (norm(params.vehicleType) !== 'TW') return null;
  const reg = twRegion(params);
  if (!reg) return null;
  const row = RATE[norm(reg)];
  if (!row) return null;
  const od = Number(params.odPremium) || 0;
  const tp = Number(params.tpPremium) || 0;
  const isNew = /NEW/i.test(String(params.businessType || '')) || (Number(params.vehicleAge) || 0) === 0;
  // Cover from premiums FIRST (a SAOD/STP isn't "Fresh" even if flagged New):
  // STP = od<=0; SAOD = tp<=0; bundled (od&tp) -> Fresh(1+5) if New else Comp.
  let rate;
  if (od <= 0) rate = row.stp;            // TP-only
  else if (tp <= 0) rate = row.saod;      // standalone OD
  else if (isNew) rate = row.fresh15;     // Brand New bundled (1+5)
  else rate = row.comp;                   // comprehensive renewal
  return rate == null ? null : +Number(rate).toFixed(4);
}

module.exports = { resolveIndusindTwRate, twRegion };
