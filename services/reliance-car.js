'use strict';

/**
 * Reliance Pvt-Car commission grid — "Reliance Pvt car Comp & SAOD", effective
 * 1 April 2026 (FY26-27). User-supplied; the ingested card (468) only carried the
 * discount-banded view and missed this fuel/product structure (Petrol COM = 30%
 * everywhere), so most Reliance cars mis-rated or no-ruled.
 *
 * Structure (config/reliance_car_grid.json), per region group:
 *   - Comprehensive (OD+TP): by FUEL — Petrol/CNG/LPG (HEV+nonHEV) vs Diesel/EV.
 *   - SAOD (OD-only): by High-End vs Non-High-End. Non-High-End = 30 everywhere.
 *   - Extended Warranty = 20 (not auto-detected — needs an addon flag).
 *   - Obsolete models = declined (no payout) — not modelled here.
 *
 * resolveRelianceCarRate(params) → { rate (0..1), label } | null.
 * SAOD high-end is intentionally NOT applied (the operator data showed luxury SAOD
 * landing on 17.5 / 20 / 30 with no clean make rule — left as default non-high-end
 * pending a confirmed High-End definition). SATP (TP-only) is out of scope → null.
 */

let GRID = null, HIGH = null;
function load() {
  if (GRID) return;
  try { GRID = require('../config/reliance_car_grid.json'); } catch (_) { GRID = {}; }
  try { HIGH = require('../config/reliance_high_end.json'); } catch (_) { HIGH = { wholeHigh: [], mixedHigh: {} }; }
}

const normMM = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Is this car in Reliance's "HIGH END" Pvt-Car segment (sheet "PVT car Segment",
// MAKE+MODEL → VEHICLE_SEGMENT)? 16 makes are wholly high-end (match by make);
// the rest are mixed and need a model match.
function isHighEnd(make, model) {
  load();
  const mk = normMM(make), md = normMM(model);
  if (!mk) return false;
  if ((HIGH.wholeHigh || []).includes(mk)) return true;
  const models = (HIGH.mixedHigh || {})[mk];
  if (!models) return false;
  return models.some(hm => {
    const h = normMM(hm);
    return h.length >= 3 && (md === h || md.startsWith(h) || md.includes(h));
  });
}

// Resolved region / RTO-state → grid region-group key. Region string wins (it already
// carries Reliance's cluster vocabulary, e.g. "Mumbai/Pune/Goa"); RTO-state is a
// fallback for city-level regions ("SURAT" → GUJARAT) and unmatched strings.
function regionGroup(region, rtoState) {
  const r = String(region || '').toUpperCase();
  if (/MUMBAI|PUNE|GOA/.test(r))                              return 'MUM_PUN_GOA';
  if (/MAHARASHTRA/.test(r))                                  return 'REST_MAH';
  if (/GUJARAT|SURAT|AHMEDABAD|VAPI|RAJKOT|VADODARA|BARODA|GANDHI|BHARUCH|JAMNAGAR|MEHASANA|VALSAD|KACHCHH|JUNAGADH|ANAND/.test(r)) return 'GUJARAT';
  if (/MADHYA/.test(r))                                       return 'MP';
  if (/BANGALORE|BANGLORE|BENGALURU|HYDERABAD/.test(r))       return 'BLR_HYD';
  if (/KA\/TS\/AP|KARNATAKA|TELANGANA|ANDHRA/.test(r))        return 'REST_KA_TS_AP';
  if (/KERALA/.test(r))                                       return 'KERALA';
  if (/TAMIL/.test(r))                                        return 'TN';
  if (/DELHI/.test(r))                                        return 'DELHI';
  if (/PUNJAB|HIMACHAL|JAMMU|KASHMIR|CHANDIGARH/.test(r))     return 'PUN_HP_JK';
  if (/UTTAR PRADESH|HARYANA|RAJASTHAN/.test(r))              return 'UP_HR_RAJ';
  if (/ODISHA|CHHATTISGARH|CHATTISGARH|ARUNACHAL|ASSAM|MANIPUR|MEGHALAYA|MIZORAM|NAGALAND|SIKKIM|TRIPURA|NORTH EAST/.test(r)) return 'NE_OD_CG';
  if (/BIHAR|JHARKHAND/.test(r))                              return 'BIH_JHK';
  if (/KOLKAT/.test(r))                                       return 'KOLKATA';
  if (/WEST BENGAL/.test(r))                                  return 'WB';
  const S = { GJ:'GUJARAT', DL:'DELHI', MP:'MP', KL:'KERALA', TN:'TN',
    PB:'PUN_HP_JK', HP:'PUN_HP_JK', JK:'PUN_HP_JK', CH:'PUN_HP_JK',
    UP:'UP_HR_RAJ', HR:'UP_HR_RAJ', RJ:'UP_HR_RAJ',
    OD:'NE_OD_CG', OR:'NE_OD_CG', CG:'NE_OD_CG', AS:'NE_OD_CG', AR:'NE_OD_CG',
    MN:'NE_OD_CG', ML:'NE_OD_CG', MZ:'NE_OD_CG', NL:'NE_OD_CG', SK:'NE_OD_CG', TR:'NE_OD_CG',
    BR:'BIH_JHK', JH:'BIH_JHK', WB:'WB',
    MH:'REST_MAH', KA:'REST_KA_TS_AP', TS:'REST_KA_TS_AP', TG:'REST_KA_TS_AP', AP:'REST_KA_TS_AP' };
  return S[String(rtoState || '').toUpperCase().slice(0, 2)] || null;
}

function resolveRelianceCarRate(params, resolvedRegion) {
  load();
  const st = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  const g = regionGroup(resolvedRegion || params.resolvedRegion, st);
  if (!g || !GRID[g]) return null;
  const G = GRID[g];
  const od = Number(params.odPremium) || 0;
  const tp = Number(params.tpPremium) || 0;
  if (od < 1) return null;                       // SATP (TP-only) — not in this grid
  const fuel = String(params.fuelType || '').toUpperCase();
  const mk   = String(params.make || '').toUpperCase();
  const dieselEv = /DIESEL|ELECTRIC|\bEV\b|BATTERY/.test(fuel) || /\bEV\b|ELECTRIC/.test(mk);
  if (tp < 1) {                                  // SAOD (OD-only)
    // High-End SAOD (region 12.5-22.5%) vs Non-High-End (30%), per the "PVT car Segment"
    // sheet (MAKE+MODEL → VEHICLE_SEGMENT = HIGH END). USER-confirmed: High-End SAOD is
    // 17.5/22.5, never 30 — so where the operator paid a high-end car 30, that's the
    // operator's error and we apply the grid-correct high-end rate.
    const hi = isHighEnd(params.make, params.model);
    return hi
      ? { rate: G.highEndSaod / 100,    label: `Reliance PvtCar ${g} SAOD (high-end)` }
      : { rate: G.nonHighEndSaod / 100, label: `Reliance PvtCar ${g} SAOD (non-high-end)` };
  }
  // Comprehensive (OD + TP)
  const r = dieselEv ? G.dieselEvCom : G.petrolCom;
  return { rate: r / 100, label: `Reliance PvtCar ${g} COMP ${dieselEv ? 'Diesel/EV' : 'Petrol/CNG/LPG'}` };
}

module.exports = { resolveRelianceCarRate, regionGroup };
