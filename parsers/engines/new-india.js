/**
 * New India Assurance — Motor commission engine (Brokers/Web Aggregators
 * variant, Q1 FY 2026-27, w.e.f. 01-Apr-2026 through 30-Jun-2026).
 *
 * Source PDF: scanned image — extracted via Google Document AI.  Since the
 * tables don't survive OCR cleanly, the motor rate matrix is hard-coded
 * below and the engine just emits rules at upload time.
 *
 * Scope: MOTOR LoB only (Pvt Car, TW, GCV, School Bus, Other CV, CPA,
 * Electric Bus).  Fire / Marine / Health / etc. are out of scope.
 *
 * Per the operator's onboarding spec we IGNORE:
 *   - Special incentives (₹-per-policy bonuses for Auto/Rickshaw/Taxi)
 *   - Additional incentive stacking (+4% / +5%) on monthly-accretion
 *
 * Entry point: parsePdfFile(filePath) — dispatched by parsers/engine.js
 * when a PDF is uploaded with the New India insurer config.
 */

const path = require('path');
const { extract } = require('../../services/pdf-extract');

// ----------------------------------------------------------------------------
//  Rate tables (from Brokers PDF page 3-6)
// ----------------------------------------------------------------------------

// Pvt Car — Vehicle Age / Category × OD/TP percent
const PVT_CAR_RULES = [
  // New Vehicle Bundled (1+3): each TP year shown verbatim; we model the
  // 1+3 as a single COMP rule with OD=25 and TP=15 (annual TP across all 3
  // years per PDF "15% on 1st, 2nd and 3rd year premium").
  { label: 'Bundled (1+3) New',           policy: '1+3', age_min: 0,   age_max: 0,   od: 0.25, tp: 0.15, fuel: null },
  // 3-year TP only (Standalone Long Term TP) — TP=15% per year, NA OD
  { label: '3-year TP Only New',          policy: 'SATP_3yr', age_min: 0, age_max: 0, od: null, tp: 0.15, fuel: null },
  // Package — vehicle age 1 to 10 years
  { label: 'Package 1-10 yrs',            policy: 'PKG', age_min: 1,   age_max: 10,  od: 0.20, tp: 0.15, fuel: null },
  // Above 10 years
  { label: 'Above 10 yrs',                policy: 'PKG', age_min: 11,  age_max: null,od: 0.20, tp: 0.125, fuel: null },
  // Stand-Alone OD (one rule per age bucket)
  { label: 'SAOD <=10 yrs',               policy: 'SAOD', age_min: 0,  age_max: 10,  od: 0.20, tp: null, fuel: null },
  { label: 'SAOD >10 yrs',                policy: 'SAOD', age_min: 11, age_max: null,od: 0.05, tp: null, fuel: null },
  // Stand-Alone TP
  { label: 'SATP All ages',               policy: 'SATP', age_min: null, age_max: null, od: null, tp: 0.15, fuel: null },
  // Long-Term Pvt Car — 1+3 tenure for NON-NEW vehicles (renewal long-term).
  //  1st-Year Policy: 60% of 1st-Year OD Premium / 45% of 1st-Year TP Premium
  //  2nd-3rd-Year Policy: Nil (no renewal commission within the LT term)
  // Vehicle age > 0 (this is renewal — for brand-new use Bundled 1+3 above).
  { label: 'Long-Term 1st Year (1+3, renewal)',     policy: 'LT_1',   age_min: 1, age_max: null, od: 0.60, tp: 0.45, fuel: null },
  { label: 'Long-Term 2nd-3rd Year (1+3, renewal)', policy: 'LT_2_3', age_min: 1, age_max: null, od: 0,    tp: 0,    fuel: null },
];

// Two Wheeler
const TW_RULES = [
  { label: 'Bundled (1+5) New',           policy: '1+5', age_min: 0,   age_max: 0,   od: 0.30, tp: 0.10, fuel: null },
  { label: '5-year TP Only New',          policy: 'SATP_5yr', age_min: 0, age_max: 0, od: null, tp: 0.10, fuel: null },
  { label: 'Package 1-10 yrs',            policy: 'PKG', age_min: 1,   age_max: 10,  od: 0.25, tp: 0.10, fuel: null },
  { label: 'Above 10 yrs',                policy: 'PKG', age_min: 11,  age_max: null,od: 0.25, tp: 0.075, fuel: null },
  { label: 'SAOD <=10 yrs',               policy: 'SAOD', age_min: 0,  age_max: 10,  od: 0.20, tp: null, fuel: null },
  { label: 'SAOD >10 yrs',                policy: 'SAOD', age_min: 11, age_max: null,od: 0.05, tp: null, fuel: null },
  { label: 'SATP All ages',               policy: 'SATP', age_min: null, age_max: null, od: null, tp: 0.10, fuel: null },
];

// GCV ≤ 7500 KGS
const GCV_SMALL_RULES = [
  { label: 'GVW <=2000 New',              weight_min: 0,   weight_max: 2.0, age_min: 0,   age_max: 0,    od: 0.55, tp: 0.50 },
  { label: 'GVW <=2000 Other',            weight_min: 0,   weight_max: 2.0, age_min: 1,   age_max: null, od: 0.50, tp: 0.50 },
  { label: 'GVW 2000-7500 New',           weight_min: 2.0, weight_max: 7.5, age_min: 0,   age_max: 0,    od: 0.40, tp: 0.25 },
  { label: 'GVW 2000-7500 Other',         weight_min: 2.0, weight_max: 7.5, age_min: 1,   age_max: null, od: 0.35, tp: 0.25 },
];

// School / Institutional Buses
const SCHOOL_BUS_RULE = { label: 'School/Institutional Bus All Cases', od: 0.60, tp: 0.60 };

// GCV > 7500 KGS — all vehicles
const GCV_LARGE_RULE = { label: 'GCV >7500 All', weight_min: 7.5, weight_max: null, od: 0.10, tp: 0.025 };

// Other Commercial Vehicles (excluding GCV, school bus, electric bus)
const OTHER_CV_RULE = { label: 'Other CV (excl GCV/School/Electric Bus)', od: 0.15, tp: 0.025 };

// CPA — Compulsory Personal Accident
const CPA_RATE = 0.0325;

// Electric Buses — PCV (C2) other than educational
const ELECTRIC_BUS_RULES = [
  { label: 'Electric Bus PCV upto 10 yrs',  age_min: 0,  age_max: 10,  od: 0.025, tp: 0.10 },
  { label: 'Electric Bus PCV >10 yrs',      age_min: 11, age_max: null, od: 0,    tp: 0.025 },
  // Standalone (Liability) TP — TP=2.5%, OD=NA
  { label: 'Electric Bus PCV SATP Liability', age_min: null, age_max: null, od: null, tp: 0.025 },
];

// ----------------------------------------------------------------------------
//  Entry point
// ----------------------------------------------------------------------------

async function parsePdfFile(filePath) {
  // Validate the PDF is reachable; rate tables are hard-coded so we don't
  // depend on the OCR output — but we still run extract() so a swapped /
  // empty file produces a visible warning.
  try {
    const res = await extract(filePath);
    if (!/NEW\s+INDIA|MOTOR|TWO\s+WHEELER|PRIVATE\s+CAR/i.test(res.text || '')) {
      console.warn('[new-india] PDF does not look like the NIA commission grid — proceeding with hard-coded rates anyway.');
    } else {
      console.log(`[new-india] PDF validated via ${res.source} (${res.text.length} chars)`);
    }
  } catch (err) {
    console.error('[new-india] PDF extract failed:', err.message);
  }

  const sheetName = path.basename(filePath);
  const meta = { sheetName };
  const rules = [];

  rules.push(...emitPvtCar(meta));
  rules.push(...emitTwoWheeler(meta));
  rules.push(...emitGcvSmall(meta));
  rules.push(...emitSchoolBus(meta));
  rules.push(...emitGcvLarge(meta));
  rules.push(...emitOtherCv(meta));
  rules.push(...emitCpa(meta));
  rules.push(...emitElectricBus(meta));

  return rules;
}

// ----------------------------------------------------------------------------
//  Emit helpers — produce OD/TP-paired COMP rules (export's mergeOdTpPairs
//  will fold them into one display row) and standalone SAOD/SATP rules.
// ----------------------------------------------------------------------------

function emitOdTpPair(meta, base, od, tp) {
  // Helper: emit two halves of a COMP rule so the export's mergeOdTpPairs
  // combines them into one row with both OD Rate and TP Rate columns set.
  // Caller-provided rate_type on `base` (e.g. COMP_1+3, COMP_1+5) takes
  // precedence over the COMP default — the spread order matters.
  const rules = [];
  const defaultType = 'COMP';
  if (od != null) {
    rules.push({
      rate_type: defaultType,
      ...base,
      applied_on: 'OD', rate_value: od, is_declined: false,
    });
  }
  if (tp != null) {
    rules.push({
      rate_type: defaultType,
      ...base,
      applied_on: 'TP', rate_value: tp, is_declined: false,
    });
  }
  return rules;
}

function emitPvtCar(meta) {
  const rules = [];
  for (const r of PVT_CAR_RULES) {
    const base = {
      product: 'CAR',
      sheet_name: meta.sheetName,
      segment: 'Pvt Car',
      make: 'All',
      vehicle_age_min: r.age_min,
      vehicle_age_max: r.age_max,
      fuel_type: r.fuel,
      // Embed policy tenure in rate_type so export inferTenure picks it up
      // (e.g. "1+3" → OD_Tenure=1, TP_Tenure=3).
      remarks: `Pvt Car | ${r.label}${r.policy === '1+3' ? ' (OD 1yr / TP 3yr)' : ''}`,
      rate_text: `NIA Pvt Car | ${r.label} | OD ${r.od ?? '-'} TP ${r.tp ?? '-'}`,
    };
    if (r.policy === '1+3') {
      rules.push(...emitOdTpPair(meta, { ...base, rate_type: 'COMP_1+3' }, r.od, r.tp));
    } else if (r.policy === 'SAOD') {
      rules.push({
        ...base, rate_type: 'SAOD', applied_on: 'OD',
        rate_value: r.od, is_declined: false,
      });
    } else if (r.policy === 'SATP' || r.policy === 'SATP_3yr') {
      rules.push({
        ...base, rate_type: r.policy === 'SATP_3yr' ? 'SATP_3yr' : 'SATP',
        applied_on: 'TP', rate_value: r.tp, is_declined: false,
      });
    } else if (r.policy === 'LT_1') {
      // Long-Term Pvt Car 1+3 — 1st policy-year commission (renewal, age > 0).
      // OD = 60% of 1st-Yr OD premium, TP = 45% of 1st-Yr TP premium.
      // Emit as OD+TP halves with 1+3 tenure encoded so export shows
      // OD_Tenure=1yr / TP_Tenure=3yr.
      rules.push(...emitOdTpPair(meta, {
        ...base, rate_type: 'COMP_1+3',
        remarks: base.remarks + ' — Long-Term 1+3 (1st-Yr commission: 60% OD / 45% TP of 1st-Yr premium)',
      }, r.od, r.tp));
    } else if (r.policy === 'LT_2_3') {
      // Long-Term Pvt Car 1+3 — 2nd & 3rd policy-year commission = Nil.
      // Kept explicit so the grid documents the no-renewal-commission rule.
      rules.push(...emitOdTpPair(meta, {
        ...base, rate_type: 'COMP_1+3',
        remarks: base.remarks + ' — Long-Term 1+3 (2nd & 3rd policy year: Nil commission)',
      }, 0, 0));
    } else {
      // Default — Package
      rules.push(...emitOdTpPair(meta, base, r.od, r.tp));
    }
  }
  return rules;
}

function emitTwoWheeler(meta) {
  const rules = [];
  for (const r of TW_RULES) {
    const base = {
      product: 'TW',
      sheet_name: meta.sheetName,
      segment: 'TW',
      make: 'All',
      vehicle_age_min: r.age_min,
      vehicle_age_max: r.age_max,
      fuel_type: r.fuel,
      remarks: `TW | ${r.label}${r.policy === '1+5' ? ' (OD 1yr / TP 5yr)' : ''}`,
      rate_text: `NIA TW | ${r.label} | OD ${r.od ?? '-'} TP ${r.tp ?? '-'}`,
    };
    if (r.policy === '1+5') {
      rules.push(...emitOdTpPair(meta, { ...base, rate_type: 'COMP_1+5' }, r.od, r.tp));
    } else if (r.policy === 'SAOD') {
      rules.push({ ...base, rate_type: 'SAOD', applied_on: 'OD', rate_value: r.od, is_declined: false });
    } else if (r.policy === 'SATP' || r.policy === 'SATP_5yr') {
      rules.push({
        ...base, rate_type: r.policy === 'SATP_5yr' ? 'SATP_5yr' : 'SATP',
        applied_on: 'TP', rate_value: r.tp, is_declined: false,
      });
    } else {
      rules.push(...emitOdTpPair(meta, base, r.od, r.tp));
    }
  }
  return rules;
}

function emitGcvSmall(meta) {
  const rules = [];
  for (const r of GCV_SMALL_RULES) {
    const base = {
      product: 'GCV',
      sheet_name: meta.sheetName,
      segment: 'GCV',
      make: 'All',
      weight_band_min: r.weight_min,
      weight_band_max: r.weight_max,
      vehicle_age_min: r.age_min,
      vehicle_age_max: r.age_max,
      remarks: `GCV ≤ 7500 | ${r.label}`,
      rate_text: `NIA GCV ≤ 7500 | ${r.label} | OD ${r.od} TP ${r.tp}`,
    };
    rules.push(...emitOdTpPair(meta, base, r.od, r.tp));
    // Also emit a standalone TP rule (PDF says "Stand-Alone TP: Same as above TP %")
    rules.push({
      ...base, rate_type: 'SATP',
      applied_on: 'TP', rate_value: r.tp, is_declined: false,
      remarks: `${base.remarks} (SATP)`,
    });
  }
  return rules;
}

function emitSchoolBus(meta) {
  const r = SCHOOL_BUS_RULE;
  const base = {
    product: 'PCV',
    sheet_name: meta.sheetName,
    segment: 'School Bus',
    make: 'All',
    remarks: 'School/Institutional Bus — All Cases',
    rate_text: `NIA School/Institutional Bus | OD ${r.od} TP ${r.tp}`,
  };
  return [
    ...emitOdTpPair(meta, base, r.od, r.tp),
    { ...base, rate_type: 'SATP', applied_on: 'TP', rate_value: r.tp, is_declined: false,
      remarks: base.remarks + ' (SATP)' },
  ];
}

function emitGcvLarge(meta) {
  const r = GCV_LARGE_RULE;
  const base = {
    product: 'GCV',
    sheet_name: meta.sheetName,
    segment: 'GCV',
    make: 'All',
    weight_band_min: r.weight_min,
    weight_band_max: r.weight_max,
    remarks: 'GCV > 7500 KGS — All Vehicles',
    rate_text: `NIA GCV >7500 | OD ${r.od} TP ${r.tp}`,
  };
  return [
    ...emitOdTpPair(meta, base, r.od, r.tp),
    { ...base, rate_type: 'SATP', applied_on: 'TP', rate_value: r.tp, is_declined: false,
      remarks: base.remarks + ' (SATP)' },
  ];
}

function emitOtherCv(meta) {
  const r = OTHER_CV_RULE;
  const base = {
    product: 'MIS',
    sheet_name: meta.sheetName,
    segment: 'Other CV',
    make: 'All',
    remarks: 'Other Commercial Vehicles (excluding GCV / school bus / electric bus)',
    rate_text: `NIA Other CV | OD ${r.od} TP ${r.tp}`,
  };
  return [
    ...emitOdTpPair(meta, base, r.od, r.tp),
    { ...base, rate_type: 'SATP', applied_on: 'TP', rate_value: r.tp, is_declined: false,
      remarks: base.remarks + ' (SATP)' },
  ];
}

function emitCpa(meta) {
  return [{
    product: 'CPA',
    sheet_name: meta.sheetName,
    segment: 'CPA',
    make: 'All',
    rate_type: 'CPA',
    applied_on: 'NET',
    rate_value: CPA_RATE,
    is_declined: false,
    remarks: 'Compulsory Personal Accident — All Vehicles',
    rate_text: `NIA CPA | ${(CPA_RATE * 100).toFixed(2)}%`,
  }];
}

function emitElectricBus(meta) {
  const rules = [];
  for (const r of ELECTRIC_BUS_RULES) {
    const base = {
      product: 'PCV',
      sheet_name: meta.sheetName,
      segment: 'Electric Bus PCV (C2)',
      make: 'All',
      fuel_type: 'Electric',
      vehicle_age_min: r.age_min,
      vehicle_age_max: r.age_max,
      remarks: `${r.label} (other than Educational Institution Buses)`,
      rate_text: `NIA Electric Bus PCV | ${r.label} | OD ${r.od ?? '-'} TP ${r.tp ?? '-'}`,
    };
    if (/Liability\)?\s*TP|SATP/i.test(r.label)) {
      rules.push({
        ...base, rate_type: 'SATP', applied_on: 'TP',
        rate_value: r.tp, is_declined: false,
      });
    } else {
      rules.push(...emitOdTpPair(meta, base, r.od, r.tp));
    }
  }
  return rules;
}

module.exports = { parsePdfFile };
