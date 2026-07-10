'use strict';

/**
 * IndusInd CV / PCV / GCV / MISC — "June CV26" grid (eff 1-Jun-26).
 * 72 city/state regions (config/indusind_cv.json) × ~25 segments. The resolver
 * (a) resolves the region from City keyword + RTO-state default, (b) classifies
 * the policy into a segment, (c) picks the COMP/STP column from premiums.
 *
 * Segment classification (PCV passenger / GCV goods / MISC):
 *  - PCV 3W (auto / e-rick, seat<=4 or 3W) -> pcv3w
 *  - School Bus -> by vehicle age (>10yr / <=10yr)
 *  - PCV Taxi <6 seat: Diesel -> taxi_lt6_diesel, else taxi_lt6_nnd_other
 *  - PCV Taxi 7+1 (7-8 seat): branded (Maruti/Mahindra/Toyota/KIA/MG) ->
 *    taxi_7p1_branded, else taxi_otherbus; kaali-peeli model -> taxi_kaalipeeli
 *  - GCV 3W -> gcv3w_elec / gcv3w_nonelec
 *  - GCV Jeeto/Supro <2T -> gcv_jeeto_supro_lt2t
 *  - GCV by tonnage (T): 2.5-3.5, 3.5-7.5, 7.5-12, 12-20 (age<=5/>5),
 *    20-40 (age<=5/>5), 40-50, >50
 *  - MISC: Tractor (fresh/<=5yr/>5yr), JCB (MISD CPM), Car Carrier, Flat Bed,
 *    Employee Pickup
 * NND vs ND (nil-dep) cover splits default to NND (no nil-dep data in PR).
 * Returns rate fraction or null.
 */
const GRID = require('../config/indusind_cv.json').grid;
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

// City keyword -> CV grid region (specific cities first).
const CITY = [
  [/MUMBAI|WADALA|WORLI|ANDHERI|BORIVALI|THANE|NAVI\s*MUMBAI|KALYAN|VASAI|PANVEL/, 'MUMBAI'],
  [/PUNE|PIMPRI|CHINCHWAD/, 'PUNE'], [/NAGPUR/, 'NAGPUR'], [/AHMEDNAGAR/, 'AHMEDNAGAR'],
  [/AURANGABAD/, 'AURANGABAD'], [/KOLHAPUR/, 'KOLHAPUR'], [/NASHIK|NASIK/, 'NASHIK'], [/SOLAPUR/, 'SOLAPUR'],
  [/AHMEDABAD/, 'AHMEDABAD'], [/SURAT/, 'SURAT'], [/VADODARA|BARODA/, 'VADODARA'],
  [/GANDHIDHAM|KANDLA/, 'GANDHIDHAM'], [/JAMNAGAR/, 'JAMNAGAR'], [/RAJKOT/, 'RAJKOT'], [/VAPI/, 'VAPI'],
  [/HYDERABAD|SECUNDERABAD/, 'HYDERABAD'], [/BANGALORE|BENGALURU/, 'BANGALORE'],
  [/MANGALORE|MANGALURU/, 'MANGALORE'], [/MYSORE|MYSURU/, 'MYSORE'],
  [/CALICUT|KOZHIKODE/, 'CALICUT'], [/COCHIN|KOCHI|ERNAKULAM/, 'COCHIN'], [/TRIVANDRUM|THIRUVANANTHAPURAM/, 'TRIVANDRUM'],
  [/CHENNAI/, 'CHENNAI'], [/COIMBATORE/, 'COIMBATORE'], [/ERODE/, 'ERODE'], [/MADURAI/, 'MADURAI'], [/PONDICHERRY|PUDUCHERRY/, 'PONDICHERRY'],
  [/DELHI/, 'DELHI'], [/CHANDIGARH/, 'CHANDIGARH'],
  [/\bJAMMU\b/, 'JAMMU'], [/SHIMLA/, 'SHIMLA'], [/SRINAGAR/, 'SRINAGAR'], [/LADAKH|LEH/, 'LADAKH'],
  [/AMRITSAR/, 'AMRITSAR'], [/LUDHIANA/, 'LUDHIANA'],
  [/JAIPUR/, 'JAIPUR'], [/DEHRADUN/, 'DEHRADUN'], [/LUCKNOW/, 'LUCKNOW'], [/VARANASI/, 'VARANASI'],
  [/PATNA/, 'PATNA'], [/JAMSHEDPUR/, 'JAMSHEDPUR'], [/RANCHI/, 'RANCHI'],
  [/BHUBANE|BHUBNE/, 'BHUBANESHWAR'], [/CUTTACK/, 'CUTTACK'], [/ROURKELA/, 'ROURKELA'],
  [/KOLKAT|CALCUTTA/, 'KOLKATA'], [/SILIGURI/, 'SILIGURI'],
  [/AGARTALA/, 'AGARTALA'], [/AIZ?AWL|AIZWAL/, 'AIZWAL'], [/GUWAHATI|GAUHATI/, 'GUWAHATI'],
];
// RTO-state prefix -> default region.
const STATE_DEF = {
  MH: 'ROM', GA: 'GOA', GJ: 'GUJ 1', DD: 'GUJ 1', DN: 'GUJ 1', MP: 'MADHYA PRADESH',
  AP: 'ANDHRA PRADESH', TS: 'TELANGANA', TG: 'TELANGANA', KA: 'KARNATAKA',
  KL: 'KERALA', LD: 'KERALA', TN: 'TAMILNADU', PY: 'TAMILNADU',
  DL: 'DELHI', CH: 'CHANDIGARH', HP: 'HP AND JAMMU', JK: 'HP AND JAMMU', LA: 'LADAKH',
  PB: 'PUNJAB', HR: 'HARYANA', RJ: 'RAJASTHAN', UK: 'UTTARAKHAND', UP: 'UP1',
  BR: 'BIHAR', JH: 'JHARKHAND', OD: 'ODISHA', OR: 'ODISHA', CG: 'CHHATTISGARH', WB: 'WEST BENGAL',
  AS: 'NORTH EAST', AR: 'NORTH EAST', MN: 'NORTH EAST', ML: 'NORTH EAST',
  MZ: 'NORTH EAST', NL: 'NORTH EAST', TR: 'NORTH EAST', SK: 'NORTH EAST',
};

let CV_RTO_MASTER = null;
function cvRtoMaster() {
  if (!CV_RTO_MASTER) { try { CV_RTO_MASTER = require('../config/reliance_rto_master.json').map || {}; } catch (_) { CV_RTO_MASTER = {}; } }
  return CV_RTO_MASTER;
}
function cvRegion(params) {
  // Authoritative Reliance/IndusInd RTO master wins — its Region_City labels match the
  // CV grid region keys exactly (DELHI, UP1, ROM, GUJ 1, HYDERABAD…). e.g. UP14 (Noida)
  // → DELHI (NCR), where PCV-taxi ≤6 non-diesel = 0.375, vs UP1 = 0 (declined).
  const rk = norm(params.rtoCode).replace(/[^A-Z0-9]/g, '');
  const mm = cvRtoMaster()[rk];
  if (mm && mm.region) {
    const R = norm(mm.region);
    if (GRID[R]) return R;
  }
  const city = norm(params.city || params.cityName || params._cityName);
  for (const [re, reg] of CITY) if (re.test(city)) return reg;
  const st = norm(params.rtoCode).replace(/[^A-Z]/g, '').slice(0, 2);
  return STATE_DEF[st] || null;
}

// Classify -> { comp: <key>, stp: <key> } (or a single key for Comp/STP-shared).
function classify(params) {
  const vt = norm(params.vehicleType);
  const seat = Number(params.seatingCapacity) || 0;
  const ton = Number(params.tonnage) || 0;
  const age = Number(params.vehicleAge) || 0;
  const hay = `${norm(params.vehicleCategory)} ${norm(params.model)} ${norm(params.make)}`;
  const fuel = norm(params.fuelType);
  const isElec = /ELECTRIC|\bEV\b|BATTERY/.test(fuel);
  const is3W = /3\s*W|THREE\s*WHEEL|RICKSHAW|RIKSHAW|E-?RICK|AUTO/.test(hay) || (seat > 0 && seat <= 4 && /PCV|PASSENGER/.test(vt));
  const branded = /MARUTI|MAHINDRA|TOYOTA|\bKIA\b|\bMG\b/.test(hay);

  // MISC bodies
  if (/TRACTOR/.test(hay)) {
    return { comp: age <= 0 ? 'tractor_fresh' : (age <= 5 ? 'tractor_nonfresh_le5' : 'tractor_nonfresh_gt5'), stp: 'tractor_stp' };
  }
  if (/JCB|BACKHOE|EXCAVAT|CRANE|LOADER|DOZER|CATERPILLAR|L\s*&\s*T|FORKLIFT|CONSTRUCTION/.test(hay)) return { comp: 'jcb_comp', stp: 'jcb_stp' };
  if (/CAR\s*CARRIER/.test(hay)) return { comp: 'carcarrier', stp: 'carcarrier' };
  if (/FLAT\s*BED/.test(hay)) return { comp: 'flatbed_comp', stp: 'flatbed_stp' };
  if (/EMPLOYEE|STAFF\s*PICK|EMP\s*PICK/.test(hay)) return { comp: 'emppickup_comp', stp: 'emppickup_stp' };

  const isGcv = /GCV|GOODS/.test(vt);
  const isPcv = /PCV|PASSENGER/.test(vt);

  if (isGcv) {
    if (is3W) return isElec ? { comp: 'gcv3w_elec_comp', stp: 'gcv3w_elec_stp' } : { comp: 'gcv3w_nonelec_comp', stp: 'gcv3w_nonelec_stp' };
    if (/JEETO|SUPRO/.test(hay) && ton <= 2) return { comp: 'gcv_jeeto_supro_lt2t_comp', stp: 'gcv_jeeto_supro_lt2t_stp' };
    if (ton > 0 && ton <= 2.5) return { comp: 'gcv_other_2_2p5_comp', stp: 'gcv_other_2_2p5_stp' };
    if (ton <= 3.5) return { comp: 'gcv_2p5_3p5_comp', stp: 'gcv_2p5_3p5_stp' };
    if (ton <= 7.5) return { comp: 'gcv_3p5_7p5_comp', stp: 'gcv_3p5_7p5_stp' };
    if (ton <= 12) return { comp: 'gcv_7p5_12_comp', stp: 'gcv_7p5_12_stp' };
    if (ton <= 20) return { comp: age <= 5 ? 'gcv_12_20_le5_comp' : 'gcv_12_20_gt5_comp', stp: 'gcv_12_20_stp' };
    if (ton <= 40) return { comp: age <= 5 ? 'gcv_20_40_le5_comp' : 'gcv_20_40_gt5_comp', stp: 'gcv_20_40_stp' };
    if (ton <= 50) return { comp: 'gcv_40_50_comp', stp: 'gcv_40_50_stp' };
    return { comp: 'gcv_gt50_comp', stp: 'gcv_gt50_stp' };
  }

  if (isPcv || is3W) {
    if (is3W) return { comp: 'pcv3w_comp', stp: 'pcv3w_stp' };
    if (/SCHOOL\s*BUS/.test(hay)) {
      const k = age > 10 ? 'schoolbus_gt10' : 'schoolbus_lt10';
      return { comp: k, stp: k };
    }
    if (/KAALI|KALI\s*PEELI|BLACK\s*YELLOW/.test(hay)) return { comp: 'taxi_kaalipeeli', stp: 'taxi_kaalipeeli' };
    if (seat >= 7) {   // 7+1 and bigger buses
      return branded ? { comp: 'taxi_7p1_branded_com', stp: 'taxi_7p1_branded_stp' }
                     : { comp: 'taxi_otherbus_com', stp: 'taxi_otherbus_stp' };
    }
    // <= 6 seat taxi
    if (/DIESEL/.test(fuel)) return { comp: 'taxi_lt6_diesel', stp: 'taxi_lt6_diesel' };
    return { comp: 'taxi_lt6_nnd_other', stp: 'taxi_lt6_nnd_stp_other' };
  }
  return null;
}

function resolveIndusindCvRate(params) {
  const vt = norm(params.vehicleType);
  if (!/PCV|GCV|GOODS|PASSENGER|MISC|MIS/.test(vt)) return null;
  const reg = cvRegion(params);
  if (!reg) return null;
  const row = GRID[reg] || GRID[norm(reg)];
  if (!row) return null;
  const seg = classify(params);
  if (!seg) return null;
  const od = Number(params.odPremium) || 0;
  const key = od > 0 ? seg.comp : seg.stp;
  const rate = row[key];
  return rate == null ? null : +Number(rate).toFixed(4);
}

module.exports = { resolveIndusindCvRate, cvRegion, classify };
