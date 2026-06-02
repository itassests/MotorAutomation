/**
 * United India Insurance — Motor commission engine (w.e.f. 01/04/2026).
 *
 * Source: "United Commission structure.pdf" pages 4-9 (Annexure A2,
 * Motor Department).  The rate grid is fundamentally:
 *
 *   {Product class} × {Vehicle band} × {State group}  →  Commission %
 *
 * where most rows expose a "low-rate states" rate (typically 5%) and an
 * "other states" rate (the headline figure).  Sub-Annexures 2 and 3
 * override individual RTOs in otherwise low-rate states with the
 * higher "other states" rate — these are loaded from
 * "United RTO Master.xlsx" via parseRtoMaster().
 *
 * Scope: MOTOR only (TW / PCV / GCV / Pvt Car / Misc / Tractor / Ambulance /
 * Trade Plate).  Fire / Engg / Liability / PA / Marine / Health / Rural
 * are out of scope per the operator's onboarding spec.
 *
 * Entry points:
 *   parsePdfFile(filePath)  → rule[] (from PDF)
 *   parse(sheetData, sheetConfig, meta)  → rule[] (from xlsx RTO Master)
 */

const fs = require('fs');
const { PDFParse } = require('pdf-parse');

// ============================================================================
//  State groups (the PDF lists rates per group, not per state)
// ============================================================================

// Two Wheeler — by CC band.  Each entry: low-rate states + "other states".
//   Source: page 4 "Two Wheelers Electric and Non-Electric"
const TW_RATES = [
  {
    cc_min: 0, cc_max: 150, fuel: 'Non-Electric', cc_label: 'Upto 150 CC',
    low_states: ['Tamil Nadu', 'Kerala', 'Karnataka', 'Madhya Pradesh', 'Assam'],
    low_rate: 0.05, other_rate: 0.275,
  },
  {
    cc_min: 150, cc_max: 350, fuel: 'Non-Electric', cc_label: '150-350 CC',
    low_states: ['Tamil Nadu', 'Kerala', 'Karnataka', 'Madhya Pradesh', 'Assam'],
    low_rate: 0.05, other_rate: 0.225,
  },
  {
    cc_min: 350, cc_max: null, fuel: 'Non-Electric', cc_label: 'Above 350 CC',
    low_states: ['Tamil Nadu', 'Kerala', 'Karnataka', 'Madhya Pradesh', 'Assam'],
    low_rate: 0.05, other_rate: 0.175,
  },
  {
    cc_min: 0, cc_max: null, fuel: 'Electric', cc_label: 'Electric Vehicles',
    low_states: ['Tamil Nadu', 'Kerala', 'Karnataka', 'Madhya Pradesh', 'Assam'],
    low_rate: 0.05, other_rate: 0.225,
  },
];
const TW_SAOD_RATE = 0.20;   // All states, all bands incl Electric

// PCV — passenger-carrying capacity bands (page 5)
const PCV_RATES = [
  // Two-Wheeled PCV — split by fuel: All CC Bands = Petrol; Electric Vehicles
  // emit a sister rule with fuel_type=Electric.
  { class: '2W PCV', band_label: 'All CC Bands',          fuel: 'Petrol',   rate: 0.10, applies_to: 'all' },
  { class: '2W PCV', band_label: 'Electric Vehicles',     fuel: 'Electric', rate: 0.10, applies_to: 'all' },
  // Three-Wheeled PCV
  {
    class: '3W PCV', band_label: 'All Bands (incl Electric)',
    low_states: ['Madhya Pradesh'], low_rate: 0.25, other_rate: 0.40,
  },
  // 4W PCV > 6 passengers — by PCC band
  {
    class: '4W PCV > 6', band_label: 'PCC <=10 (All Fuel)',     seat_min: 0,  seat_max: 10,
    low_states: ['Haryana', 'Rajasthan'], low_rate: 0.10, other_rate: 0.20,
  },
  {
    class: '4W PCV > 6', band_label: '10<PCC<=20 (All Fuel)',   seat_min: 11, seat_max: 20,
    low_states: ['Tamil Nadu', 'Karnataka'], low_rate: 0.10, other_rate: 0.20,
  },
  {
    class: '4W PCV > 6', band_label: '20<PCC<=30 (Except EV)',  seat_min: 21, seat_max: 30,
    low_states: ['Tamil Nadu', 'Madhya Pradesh', 'Uttar Pradesh'],
    low_rate: 0.075, other_rate: 0.10,
  },
  // PCC 30-60 (Except EV) — flat 5% all states (no state split per PDF)
  { class: '4W PCV > 6', band_label: '30<PCC<=40 (Except EV)',  seat_min: 31, seat_max: 40, rate: 0.05, applies_to: 'all' },
  { class: '4W PCV > 6', band_label: '40<PCC<=50 (Except EV)',  seat_min: 41, seat_max: 50, rate: 0.05, applies_to: 'all' },
  { class: '4W PCV > 6', band_label: '50<PCC<=60 (Except EV)',  seat_min: 51, seat_max: 60, rate: 0.05, applies_to: 'all' },
  { class: '4W PCV > 6', band_label: 'PCC>60 (Except EV)',      seat_min: 61, seat_max: null, rate: 0.05, applies_to: 'all' },
  { class: '4W PCV > 6', band_label: 'PCC>20 (Electric)',       seat_min: 21, seat_max: null, fuel: 'Electric', rate: 0.10, applies_to: 'all' },
  // Taxis (page 5) — 15% in Haryana / Karnataka / Rajasthan / Tamil Nadu /
  // Uttar Pradesh / Madhya Pradesh; 25% in all other states.
  { class: 'Taxi', band_label: 'All CC Bands (incl Electric)',
    low_states: ['Haryana', 'Karnataka', 'Rajasthan', 'Tamil Nadu', 'Uttar Pradesh', 'Madhya Pradesh'],
    low_rate: 0.15, other_rate: 0.25 },
  // "Educational Institution and Staff Buses" — PDF lists a single 62.5% row
  // covering both bus types. Split into two independent categories so
  // VehicleCategory shows "School Bus" / "Staff Bus" explicitly.
  { class: 'School Bus', band_label: 'All Capacity (incl Electric)', rate: 0.625, applies_to: 'all' },
  { class: 'Staff Bus',  band_label: 'All Capacity (incl Electric)', rate: 0.625, applies_to: 'all' },
];

// GCV — Gross Vehicle Weight bands (page 5-6)
// "Excluded states" group below is the low-rate group for that row.
const GCV_RATES = [
  {
    band_label: 'GVW <= 2000',        weight_min: 0,    weight_max: 2.0,
    low_states: ['Uttar Pradesh'], low_rate: 0.20, other_rate: 0.575,
  },
  {
    band_label: '2000 < GVW <= 3500', weight_min: 2.0,  weight_max: 3.5,
    low_states: ['Haryana', 'Madhya Pradesh', 'Rajasthan', 'Tamil Nadu', 'Uttar Pradesh'],
    low_rate: 0.15, other_rate: 0.50,
  },
  {
    band_label: '3500 < GVW <= 7500', weight_min: 3.5,  weight_max: 7.5,
    low_states: ['Haryana', 'Madhya Pradesh', 'Rajasthan', 'Tamil Nadu', 'Uttar Pradesh'],
    low_rate: 0.10, other_rate: 0.275,
  },
  {
    band_label: '7500 < GVW <= 10000', weight_min: 7.5,  weight_max: 10.0,
    low_states: ['Madhya Pradesh', 'Rajasthan', 'Tamil Nadu'],
    low_rate: 0.10, other_rate: 0.175,
  },
  { band_label: '10000 < GVW <= 12000', weight_min: 10.0, weight_max: 12.0, rate: 0.025, applies_to: 'all' },
  {
    band_label: '12000 < GVW <= 20000', weight_min: 12.0, weight_max: 20.0,
    low_states: ['Haryana', 'Madhya Pradesh', 'Rajasthan', 'Tamil Nadu', 'Uttar Pradesh', 'Karnataka', 'Kerala'],
    low_rate: 0.05, other_rate: 0.15,
  },
  {
    band_label: '20000 < GVW <= 25000', weight_min: 20.0, weight_max: 25.0,
    low_states: ['Haryana', 'Madhya Pradesh', 'Rajasthan', 'Tamil Nadu', 'Uttar Pradesh', 'Karnataka', 'Kerala'],
    low_rate: 0.05, other_rate: 0.15,
  },
  {
    band_label: '25000 < GVW <= 32000', weight_min: 25.0, weight_max: 32.0,
    low_states: ['Haryana', 'Madhya Pradesh', 'Rajasthan', 'Tamil Nadu', 'Uttar Pradesh', 'Karnataka', 'Kerala'],
    low_rate: 0.025, other_rate: 0.125,
  },
  { band_label: '32000 < GVW <= 40000', weight_min: 32.0, weight_max: 40.0, rate: 0.05, applies_to: 'all' },
  {
    band_label: 'GVW > 40000', weight_min: 40.0, weight_max: null,
    low_states: ['Haryana', 'Madhya Pradesh', 'Rajasthan', 'Tamil Nadu', 'Uttar Pradesh', 'Karnataka', 'Kerala'],
    low_rate: 0, other_rate: 0.05,
  },
  // E-Cart — 50% all states, fuel=Electric. Distinct segment so the export
  // surfaces "E-Cart" in the VehicleCategory column (vs the generic "GCV").
  { band_label: 'E-Cart', segment: 'E-Cart', weight_min: null, weight_max: null, fuel: 'Electric', rate: 0.50, applies_to: 'all' },
];

// Pvt Car (page 7)
const PVT_CAR_RATES = [
  // Bundled (1+3) New Non-Electric
  { policy: 'Bundled 1+3', business: 'New', fuel: 'Non-Electric',
    rule: 'Diesel <= 1500cc',                                rate: 0.10 },
  { policy: 'Bundled 1+3', business: 'New', fuel: 'Non-Electric',
    rule: 'All >2500cc except Tata/Maruti/Mahindra/Toyota/Hyundai/Honda/Kia', rate: 0.10 },
  { policy: 'Bundled 1+3', business: 'New', fuel: 'Non-Electric',
    rule: 'Other',                                           rate: 0.275 },
  // Package Renewal/Roll-over Non-Electric
  { policy: 'Package',     business: 'Renewal', fuel: 'Non-Electric',
    rule: 'Diesel <= 1500cc',                                rate: 0.05 },
  { policy: 'Package',     business: 'Renewal', fuel: 'Non-Electric',
    rule: 'All >2500cc except Tata/Maruti/Mahindra/Toyota/Hyundai/Honda/Kia', rate: 0.05 },
  { policy: 'Package',     business: 'Renewal', fuel: 'Non-Electric',
    rule: 'Other',                                           rate: 0.20 },
  // SAOD
  { policy: 'SAOD',        business: 'All',     fuel: 'All',
    rule: 'All vehicles',                                    rate: 0.12 },
  // SATP — page 7 shows same as Package Renewal split for SATP
  { policy: 'SATP',        business: 'Renewal', fuel: 'Non-Electric',
    rule: 'Diesel <= 1500cc',                                rate: 0.05 },
  { policy: 'SATP',        business: 'Renewal', fuel: 'Non-Electric',
    rule: 'All >2500cc except Tata/Maruti/Mahindra/Toyota/Hyundai/Honda/Kia', rate: 0.05 },
  { policy: 'SATP',        business: 'Renewal', fuel: 'Non-Electric',
    rule: 'Other',                                           rate: 0.20 },
  // Bundled (1+3) New Electric
  { policy: 'Bundled 1+3', business: 'New',     fuel: 'Electric',
    rule: 'All vehicles New Electric',                       rate: 0.275 },
  // Brand New SAOD / SATP
  { policy: 'SAOD',        business: 'New',     fuel: 'All',
    rule: 'All vehicles New',                                rate: 0.225 },
  { policy: 'SATP',        business: 'New',     fuel: 'All',
    rule: 'All vehicles New',                                rate: 0.225 },
  // Package/SAOD/SATP Renewal/Roll-over — Electric. The PDF lists "All vehicles"
  // with 17%/17% under all three policy headers for Electric fuel. We emit
  // three independent rules so each policy is reportable on its own.
  { policy: 'Package',     business: 'Renewal', fuel: 'Electric',
    rule: 'All vehicles Electric Renewal/Rollover',          rate: 0.17 },
  { policy: 'SAOD',        business: 'Renewal', fuel: 'Electric',
    rule: 'All vehicles Electric Renewal/Rollover',          rate: 0.17 },
  { policy: 'SATP',        business: 'Renewal', fuel: 'Electric',
    rule: 'All vehicles Electric Renewal/Rollover',          rate: 0.17 },
];

// Additional per-policy incentive (page 7-8) — applies on TOP of base rate.
// Reads as: extra OD% / TP% if vehicle CC × state matches.
const PVT_CAR_ADDITIONAL_INCENTIVE = [
  // Non-Electric SATP
  { cc_min: 1000, cc_max: 1200, fuel: 'Non-Electric',
    state_rule: 'Other than Karnataka/Haryana/MP/TN/Rajasthan/UP', od_pct: 0.025, tp_pct: 0.15 },
  { cc_min: 1500, cc_max: 2000, fuel: 'Non-Electric', state_rule: 'All States',
    od_pct: 0.025, tp_pct: 0.15 },
  { cc_min: 2000, cc_max: null, fuel: 'Non-Electric',
    state_rule: 'Other than Karnataka/Haryana/MP/TN/Rajasthan/UP', od_pct: 0.025, tp_pct: 0.15 },
  // Electric SATP
  { cc_min: 0,    cc_max: null, fuel: 'Electric', state_rule: 'All States',
    od_pct: 0.10, tp_pct: 0.10 },
];

// Misc / Tractor / Ambulance / Trade Plate (page 6 — "Misc Vehicles, Motor
// Trade and Standalone CPA" table). Each row produces its own rule with
// product=MIS|CPA (Class of Vehicles) and segment=<Bands/Vehicle Type> so
// the export populates VehicleCategory correctly.
const MISC_RATES = [
  { product: 'MIS', class: 'Misc Vehicles', category: 'Ambulance',                                  rate: 0.20 },
  // Agricultural Tractor — "Maximum proposed Commission" (w.e.f. 01/04/2026)
  // is 40% across both source periods (the 25% column was Existing Pay-out
  // and is superseded by the new grid).
  { product: 'MIS', class: 'Misc Vehicles', category: 'Agricultural Tractor', period: 'w.e.f. 01-01-2026', rate: 0.40 },
  { product: 'MIS', class: 'Misc Vehicles', category: 'Agricultural Tractor', period: 'w.e.f. 05-03-2026', rate: 0.40 },
  { product: 'MIS', class: 'Misc Vehicles', category: 'All other Miscellaneous Vehicles',           rate: 0.10 },
  { product: 'MIS', class: 'Motor Trade',   category: 'Road Risk, Transit & Internal Risk',         rate: 0.05 },
  { product: 'CPA', class: 'Standalone CPA',category: 'Standalone CPA',                             rate: 0.15 },
];

// ============================================================================
//  PDF entry — emit base motor rules from hard-coded tables
// ============================================================================

async function parsePdfFile(filePath) {
  // Validate the PDF is reachable; the rate tables are hard-coded above so
  // we don't actually need to scrape the PDF text — but we still verify it
  // opens cleanly so a swapped/empty file produces a visible error rather
  // than a stealthy "looked OK but used last cycle's rates" run.
  try {
    const buf = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buf });
    const res = await parser.getText();
    if (!/MOTOR DEPARTMENT/i.test(res.text || '')) {
      console.warn('[united-india] PDF does not look like the Motor Commission grid — proceeding with hard-coded rates anyway.');
    }
  } catch (err) {
    console.error('[united-india] PDF read failed:', err.message);
  }

  const rules = [];
  const sheetName = require('path').basename(filePath);
  const meta = { sheetName };

  rules.push(...emitTwoWheeler(meta));
  rules.push(...emitPvtCar(meta));
  rules.push(...emitPCV(meta));
  rules.push(...emitGCV(meta));
  rules.push(...emitMisc(meta));

  return rules;
}

// Non-Electric fuel set — the PDF treats Petrol / Diesel / CNG together
// under "Non-Electric"; we fan out into one rule per fuel for precise
// matching downstream.
const NON_ELECTRIC_FUELS = ['Petrol', 'Diesel', 'CNG'];

// All Indian states/UTs we serve. When a grid row applies a single "other
// states" rate to everything except a small low-rate exclusion list, we
// fan that catch-all out into one explicit rule per remaining state so the
// downstream grid shows the rate against every state name.
const ALL_INDIA_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu & Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Delhi', 'Chandigarh', 'Puducherry',
];
function otherStates(exclude) {
  const ex = new Set((exclude || []).map(s => s.toLowerCase()));
  return ALL_INDIA_STATES.filter(s => !ex.has(s.toLowerCase()));
}
function fuelsFor(fuel) {
  if (!fuel || fuel === 'All') return [null];        // null = any fuel
  if (fuel === 'Non-Electric') return NON_ELECTRIC_FUELS;
  return [fuel];                                     // 'Electric' etc.
}

// UII rule: unless an entry calls out a separate TP rate, the same grid %
// applies to BOTH OD and TP. So every COMP entry is emitted as a pair of
// rules (applied_on='OD' and applied_on='TP') with the same rate — the
// export's mergeOdTpPairs() folds them into one row.
function pushComp(rules, base, rate) {
  rules.push({ ...base, applied_on: 'OD', rate_value: rate });
  rules.push({ ...base, applied_on: 'TP', rate_value: rate });
}

function emitTwoWheeler(meta) {
  const rules = [];
  for (const r of TW_RATES) {
    const fuels = fuelsFor(r.fuel);
    // One rule per (state × fuel) in the low-rate group
    for (const state of r.low_states) {
      for (const fuel of fuels) {
        pushComp(rules, {
          product: 'TW',
          sheet_name: meta.sheetName,
          segment: 'TW',
          state: state, region: state,
          make: 'All',
          cc_band_min: r.cc_min,
          cc_band_max: r.cc_max,
          fuel_type: fuel,
          rate_type: 'COMP',
          is_declined: false,
          remarks: `${r.cc_label} | Low-rate state${fuel ? ' (' + fuel + ')' : ''} | rate applies to OD & TP`,
          rate_text: `TW ${r.cc_label} | ${state}${fuel ? ' ' + fuel : ''} | ${(r.low_rate*100).toFixed(2)}%`,
        }, r.low_rate);
      }
    }
    // Catch-all "Other states" — fan out into one rule per remaining state × fuel
    for (const state of otherStates(r.low_states)) {
      for (const fuel of fuels) {
        pushComp(rules, {
          product: 'TW',
          sheet_name: meta.sheetName,
          segment: 'TW',
          state: state, region: state,
          make: 'All',
          cc_band_min: r.cc_min,
          cc_band_max: r.cc_max,
          fuel_type: fuel,
          rate_type: 'COMP',
          is_declined: false,
          remarks: `${r.cc_label} | ${state}${fuel ? ' (' + fuel + ')' : ''} (other-states bucket) | rate applies to OD & TP`,
          rate_text: `TW ${r.cc_label} | ${state}${fuel ? ' ' + fuel : ''} | ${(r.other_rate*100).toFixed(2)}%`,
        }, r.other_rate);
      }
    }
  }
  // TW SAOD — 20% all states all bands (no fuel split)
  rules.push({
    product: 'TW', sheet_name: meta.sheetName, segment: 'TW',
    make: 'All', rate_type: 'SAOD', rate_value: TW_SAOD_RATE,
    applied_on: 'OD', is_declined: false,
    remarks: 'TW SAOD — all bands incl Electric',
    rate_text: `TW SAOD | All states | 20%`,
  });
  return rules;
}

function emitPCV(meta) {
  const rules = [];
  for (const r of PCV_RATES) {
    // "Except EV" rows apply to Non-Electric fuels only — fan out into
    // Petrol/Diesel/CNG so the rule grid lists each fuel explicitly.
    // Otherwise use whatever the row declared (or null = any fuel).
    const isExceptEV = /except\s*ev/i.test(r.band_label || '');
    const fuelList = isExceptEV ? NON_ELECTRIC_FUELS : [r.fuel || null];

    for (const fuel of fuelList) {
      const fuelTag = isExceptEV ? ` (${fuel})` : '';
      const baseRule = {
        product: 'PCV',
        sheet_name: meta.sheetName,
        segment: r.class,
        make: 'All',
        seating_capacity_min: r.seat_min ?? null,
        seating_capacity_max: r.seat_max ?? null,
        fuel_type: fuel,
        rate_type: 'COMP',
        is_declined: false,
        rate_text: `PCV ${r.class} | ${r.band_label}${fuelTag}`,
      };
      if (r.applies_to === 'all') {
        // Fan out "all states" rows into one rule per state too, so the
        // grid shows the rate against each state explicitly.
        for (const state of ALL_INDIA_STATES) {
          pushComp(rules, {
            ...baseRule, state: state, region: state,
            remarks: `${r.band_label}${fuelTag} | ${state} | rate applies to OD & TP`,
          }, r.rate);
        }
      } else {
        // One rule per low-rate state
        for (const state of r.low_states) {
          pushComp(rules, {
            ...baseRule, state: state, region: state,
            remarks: `${r.band_label}${fuelTag} | ${state} (low-rate state) | rate applies to OD & TP`,
          }, r.low_rate);
        }
        // Fan "Others" bucket out into one rule per remaining state
        for (const state of otherStates(r.low_states)) {
          pushComp(rules, {
            ...baseRule, state: state, region: state,
            remarks: `${r.band_label}${fuelTag} | ${state} (other-states bucket) | rate applies to OD & TP`,
          }, r.other_rate);
        }
      }
    }
  }
  return rules;
}

function emitGCV(meta) {
  const rules = [];
  for (const r of GCV_RATES) {
    const baseRule = {
      product: 'GCV',
      sheet_name: meta.sheetName,
      segment: r.segment || 'GCV',     // E-Cart overrides to its own segment
      make: 'All',
      weight_band_min: r.weight_min,
      weight_band_max: r.weight_max,
      fuel_type: r.fuel || null,
      rate_type: 'COMP',
      is_declined: false,
      rate_text: `GCV ${r.band_label}`,
    };
    if (r.applies_to === 'all') {
      for (const state of ALL_INDIA_STATES) {
        pushComp(rules, {
          ...baseRule, state: state, region: state,
          remarks: `${r.band_label} | ${state} | rate applies to OD & TP`,
        }, r.rate);
      }
    } else {
      // One rule per low-rate / excluded state
      for (const state of r.low_states) {
        pushComp(rules, {
          ...baseRule, state: state, region: state,
          remarks: `${r.band_label} | ${state} (excluded — Sub-Annexure 2 RTOs override) | rate applies to OD & TP`,
        }, r.low_rate);
      }
      // Fan "Others" out per remaining state
      for (const state of otherStates(r.low_states)) {
        pushComp(rules, {
          ...baseRule, state: state, region: state,
          remarks: `${r.band_label} | ${state} (other-states bucket) | rate applies to OD & TP`,
        }, r.other_rate);
      }
    }
  }
  return rules;
}

function emitPvtCar(meta) {
  const rules = [];
  for (const r of PVT_CAR_RATES) {
    // Fuel narrowing — Diesel-specific rule honours Diesel only; else fan out.
    let fuelList;
    if (/^Diesel/i.test(r.rule)) {
      fuelList = ['Diesel'];
    } else {
      fuelList = fuelsFor(r.fuel);
    }

    // Tenure encoding — embed "1+3" in rate_type so the export's
    // inferTenure() reads OD_Tenure=1 and TP_Tenure=3 automatically.
    //   Bundled 1+3 → COMP_1+3 (or SAOD_1+3 / TP_1+3 as policy demands)
    //   Package    → COMP (1+1 by default, no special suffix needed)
    //   SAOD       → SAOD
    //   SATP       → SATP
    let rateTypeBase;
    if (r.policy === 'SAOD')       rateTypeBase = 'SAOD';
    else if (r.policy === 'SATP')  rateTypeBase = 'SATP';
    else                            rateTypeBase = 'COMP';
    const isBundled = r.policy === 'Bundled 1+3';
    const rateType = isBundled ? rateTypeBase + '_1+3' : rateTypeBase;

    // New business → vehicle age 0-0; Renewal/All → unset (any age)
    const isNew = /^New$/i.test(r.business);
    const vehAgeMin = isNew ? 0 : null;
    const vehAgeMax = isNew ? 0 : null;

    for (const fuel of fuelList) {
      const base = {
        product: 'CAR',
        sheet_name: meta.sheetName,
        segment: 'Pvt Car',
        make: 'All',
        fuel_type: fuel,
        vehicle_age_min: vehAgeMin,
        vehicle_age_max: vehAgeMax,
        rate_type: rateType,
        is_declined: false,
        remarks: `${r.policy} | ${r.business}${isNew ? ' (Vehicle age 0)' : ''} | ${r.rule}${fuel && fuel !== 'Diesel' ? ' (' + fuel + ')' : ''}${r.policy === 'Package' || r.policy === 'Bundled 1+3' ? ' | rate applies to OD & TP' : ''}`,
        rate_text: `Pvt Car ${r.policy} ${r.business} | ${r.rule} | ${fuel || 'All Fuels'} | ${(r.rate*100).toFixed(2)}%`,
      };
      // SAOD = OD only; SATP = TP only; Bundled/Package = same rate to both OD & TP.
      if (r.policy === 'SAOD') {
        rules.push({ ...base, applied_on: 'OD', rate_value: r.rate });
      } else if (r.policy === 'SATP') {
        rules.push({ ...base, applied_on: 'TP', rate_value: r.rate });
      } else {
        pushComp(rules, base, r.rate);
      }
    }
  }
  return rules;
}

function emitMisc(meta) {
  const rules = [];
  for (const r of MISC_RATES) {
    const base = {
      product: r.product,
      sheet_name: meta.sheetName,
      // segment carries the "Bands / Vehicle Type" so the export's
      // inferVehicleCategory surfaces it in the VehicleCategory column.
      segment: r.category,
      make: 'All',
      rate_type: r.product === 'CPA' ? 'CPA' : 'COMP',
      is_declined: false,
      remarks: `${r.class} | ${r.category}${r.period ? ' (' + r.period + ')' : ''} (all states)${r.product === 'CPA' ? '' : ' | rate applies to OD & TP'}`,
      rate_text: `${r.class} | ${r.category}${r.period ? ' (' + r.period + ')' : ''} | ${(r.rate*100).toFixed(2)}%`,
    };
    if (r.product === 'CPA') {
      // CPA = standalone personal-accident liability — keep as NET (no OD/TP split).
      rules.push({ ...base, applied_on: 'NET', rate_value: r.rate });
    } else {
      pushComp(rules, base, r.rate);
    }
  }
  return rules;
}

// ============================================================================
//  XLSX entry — parse "United RTO Master.xlsx" Sub-Annexure 2 / 3
// ============================================================================

function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind || sheetConfig.kind;
  switch (kind) {
    case 'uii_rto_gcv':       return parseRtoGcv(sheetData, meta);
    case 'uii_rto_pvt_car':   return parseRtoPvtCar(sheetData, meta);
    default:
      console.warn(`[united-india] unknown sheet_kind: ${kind}`);
      return [];
  }
}

/**
 * "RTO GCV" sheet — Sub-Annexure 2.
 * Layout: a section header like "A. Goods Carrying vehicle Upto 2000kgs",
 * then per-state subgroup rows "(i) Uttar Pradesh State RTO  UP 11 UP12 ...".
 * Each listed RTO gets a separate rule overriding the low-rate state base
 * with the "other states" rate (which the PDF labels per section).
 */
const GCV_SECTIONS = {
  // section text → matching GCV band + override rate
  'A. Goods Carrying vehicle Upto 2000kgs': { weight_min: 0,   weight_max: 2.0, rate: 0.575 },
  'B. Goods Carrying vehicle 2000 to 3500 Kgs': { weight_min: 2.0, weight_max: 3.5, rate: 0.50 },
  'C. Goods Carrying vehicle 3500 -7500 Kgs':   { weight_min: 3.5, weight_max: 7.5, rate: 0.275 },
};

function parseRtoGcv(data, meta) {
  const rules = [];
  let currentSection = null;
  let currentState = null;
  for (let r = 2; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;
    const col0 = cellOrNull(row[0]);
    const col1 = cellOrNull(row[1]);

    // Section header — match against known weight signatures (typos / spacing
    // in the source make exact-string matching unreliable).
    if (col0) {
      const norm = col0.replace(/\s+/g, ' ').trim().toLowerCase();
      let match = null;
      if (/upto\s*2000\s*kgs/i.test(norm))                      match = 'A. Goods Carrying vehicle Upto 2000kgs';
      else if (/2000\s*to\s*3500/i.test(norm))                  match = 'B. Goods Carrying vehicle 2000 to 3500 Kgs';
      else if (/3500\s*[-–to]+\s*7500/i.test(norm))             match = 'C. Goods Carrying vehicle 3500 -7500 Kgs';
      if (match) {
        currentSection = { name: match, ...GCV_SECTIONS[match] };
        currentState = null;
        continue;
      }
    }

    // Sub-group header — e.g. "(i)  Uttar Pradesh State RTO" with col1 = state name
    if (col0 && /^\(i+\)|^\(iv\)|^\(v\)/i.test(col0) && col1) {
      currentState = col1.replace(/\s*State\s*RTO/i, '').trim();
    }

    // Each row after the sub-group has up to 4 RTO codes in cols 2-5
    if (currentSection && currentState) {
      for (let c = 2; c < row.length; c++) {
        const code = cellOrNull(row[c]);
        if (!code) continue;
        const cleanCode = code.replace(/\s+/g, '').toUpperCase();
        if (!/^[A-Z]{2}\d{1,3}$/.test(cleanCode)) continue;
        pushComp(rules, {
          product: 'GCV',
          sheet_name: meta.sheetName,
          state: currentState,
          region: cleanCode,
          sub_type: cleanCode,                            // RTO code → RTOCode column
          segment: 'GCV',
          make: 'All',
          weight_band_min: currentSection.weight_min,
          weight_band_max: currentSection.weight_max,
          rate_type: 'COMP',
          is_declined: false,
          remarks: `Preferred RTO (${currentState}) — overrides low-rate state base for ${currentSection.name} | rate applies to OD & TP`,
          rate_text: `UII GCV preferred RTO | ${currentState} ${cleanCode} | ${(currentSection.rate*100).toFixed(2)}%`,
        }, currentSection.rate);
      }
    }
  }
  return rules;
}

/**
 * "RTO FOR PVT CAR" sheet — Sub-Annexure 3.
 * Layout: per-city subgroup with up to 4 RTO codes per row.
 * Each RTO becomes a 40% commission rule with fuel fan-out:
 *   - Petrol (any CC)
 *   - CNG (any CC)
 *   - Diesel >1500cc only (PDF clause "excluding Diesel ≤1500cc")
 * So 3 fuel rules per RTO × OD+TP = 6 rate-rule rows per RTO code.
 */
const PVT_CAR_PREFERRED_FUEL_FANOUT = [
  { fuel: 'Petrol', cc_min: null, cc_max: null },
  { fuel: 'CNG',    cc_min: null, cc_max: null },
  { fuel: 'Diesel', cc_min: 1500, cc_max: null }, // >1500cc only
];

function parseRtoPvtCar(data, meta) {
  const rules = [];
  let currentCity = null;
  for (let r = 2; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;
    const col0 = cellOrNull(row[0]);
    const col1 = cellOrNull(row[1]);
    // Sub-group header
    if (col0 && /^\(/.test(col0) && col1) {
      currentCity = col1.trim();
    }
    if (!currentCity) continue;
    for (let c = 2; c < row.length; c++) {
      const code = cellOrNull(row[c]);
      if (!code) continue;

      // Kerala State — "All RTOs except KL15" — emit one rule per fuel fan-out
      // for the state-wide 40% bucket, then explicit ZERO-rate rules for each
      // excluded RTO (so the excluded RTOs are first-class no-payout rows).
      //
      // NB: the source xlsx cell occasionally drops the "15" suffix and reads
      // just "All RTOs except KL" — fall back to KL15 (the documented excluded
      // RTO per operator spec) when the regex finds no explicit codes.
      if (/^all\s+rtos?\s+except/i.test(code)) {
        let excluded = code.match(/KL\s*\d{1,2}/gi)?.map(s => s.replace(/\s+/g, '').toUpperCase()) || [];
        if (excluded.length === 0) excluded = ['KL15'];
        for (const f of PVT_CAR_PREFERRED_FUEL_FANOUT) {
          const ccTag = f.fuel === 'Diesel' ? ' >1500cc' : '';
          pushComp(rules, {
            product: 'CAR',
            sheet_name: meta.sheetName,
            state: 'Kerala',
            region: 'Kerala',
            segment: 'Pvt Car',
            make: 'All',
            fuel_type: f.fuel,
            cc_band_min: f.cc_min,
            cc_band_max: f.cc_max,
            rate_type: 'COMP',
            is_declined: false,
            remarks: `Preferred Kerala (${f.fuel}${ccTag}) — 40% (excluding Diesel ≤1500cc, excluding RTOs: ${excluded.join(', ')}) | rate applies to OD & TP`,
            rate_text: `UII Pvt Car preferred | Kerala ${f.fuel}${ccTag} (except ${excluded.join('/')}) | 40%`,
          }, 0.40);
        }
        // Excluded RTOs (e.g. KL15) get explicit ZERO commission rules,
        // same fuel fan-out as preferred — so the grid clearly shows they
        // are no-payout rather than being silently absent.
        for (const rtoCode of excluded) {
          for (const f of PVT_CAR_PREFERRED_FUEL_FANOUT) {
            const ccTag = f.fuel === 'Diesel' ? ' >1500cc' : '';
            pushComp(rules, {
              product: 'CAR',
              sheet_name: meta.sheetName,
              state: 'Kerala',
              region: rtoCode,
              sub_type: rtoCode,
              segment: 'Pvt Car',
              make: 'All',
              fuel_type: f.fuel,
              cc_band_min: f.cc_min,
              cc_band_max: f.cc_max,
              rate_type: 'COMP',
              is_declined: false,
              remarks: `Excluded Kerala RTO (${rtoCode}, ${f.fuel}${ccTag}) — 0% (carved out of preferred-state 40% bucket)`,
              rate_text: `UII Pvt Car excluded | Kerala ${rtoCode} ${f.fuel}${ccTag} | 0%`,
            }, 0.00);
          }
        }
        continue;
      }

      const cleanCode = code.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{1,3}$/.test(cleanCode)) continue;
      for (const f of PVT_CAR_PREFERRED_FUEL_FANOUT) {
        const ccTag = f.fuel === 'Diesel' ? ' >1500cc' : '';
        pushComp(rules, {
          product: 'CAR',
          sheet_name: meta.sheetName,
          region: cleanCode,
          sub_type: cleanCode,
          state: stateFromRtoCode(cleanCode),
          segment: 'Pvt Car',
          make: 'All',
          fuel_type: f.fuel,
          cc_band_min: f.cc_min,
          cc_band_max: f.cc_max,
          rate_type: 'COMP',
          is_declined: false,
          remarks: `Preferred city RTO (${currentCity}, ${f.fuel}${ccTag}) — 40% commission (excluding Diesel ≤1500cc) | rate applies to OD & TP`,
          rate_text: `UII Pvt Car preferred | ${currentCity} ${cleanCode} ${f.fuel}${ccTag} | 40%`,
        }, 0.40);
      }
    }
  }
  return rules;
}

// ----------------------------------------------------------------------------

function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

const RTO_PREFIX_TO_STATE = {
  AN: 'Andaman & Nicobar', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh',
  AS: 'Assam', BR: 'Bihar', CG: 'Chhattisgarh', CH: 'Chandigarh',
  DD: 'Daman & Diu', DL: 'Delhi', DN: 'Dadra & Nagar Haveli',
  GA: 'Goa', GJ: 'Gujarat', HP: 'Himachal Pradesh', HR: 'Haryana',
  JH: 'Jharkhand', JK: 'Jammu & Kashmir', KA: 'Karnataka', KL: 'Kerala',
  LD: 'Lakshadweep', MH: 'Maharashtra', ML: 'Meghalaya', MN: 'Manipur',
  MP: 'Madhya Pradesh', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha',
  PB: 'Punjab', PY: 'Puducherry', RJ: 'Rajasthan', SK: 'Sikkim',
  TN: 'Tamil Nadu', TR: 'Tripura', TS: 'Telangana', TG: 'Telangana',
  UP: 'Uttar Pradesh', UK: 'Uttarakhand', WB: 'West Bengal',
};
function stateFromRtoCode(code) {
  const prefix = code.slice(0, 2).toUpperCase();
  return RTO_PREFIX_TO_STATE[prefix] || null;
}

module.exports = { parse, parsePdfFile };
