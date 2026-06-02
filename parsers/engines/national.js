/**
 * National Insurance — Motor commission engine (Q1 FY 2026-27).
 *
 * Source: "Remuneration and Reward Scheme Q1 26-27" PDF (Circular 03/2026-27,
 * w.e.f. 01-Apr-2026 to 30-Jun-2026).
 *
 * Scope: MOTOR section only (Package / SAOD / Long-Term / SATP). Health,
 * PA, Fire, Marine, Engineering, Non-Motor — out of scope.
 *
 * Source value: Remuneration % (excludes Reward bonus). The PDF lists
 * Remuneration (col a) + Reward (col b/c) → Commission (col a+b / a+c).
 * Operator preference: use Remuneration alone.
 *
 * Bundled / Long-Term policies are encoded as two distinct rules:
 *   - New Vehicle (age 0)        : 1st-year rates
 *   - 2nd Year Onwards (age 1+)  : subsequent-year rates
 *
 * All rules Pan India — no state split.
 *
 * Entry: parsePdfFile(filePath) → rule[]
 */

const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------------------
// Helper: emit OD + TP halves at independent rates so the export's
// mergeOdTpPairs combines them into one display row. When one half is 0,
// we still emit it (rate_value = 0) so the column appears explicitly.
// ----------------------------------------------------------------------------
function emitOdTp(rules, base, od, tp) {
  if (od != null) rules.push({ ...base, applied_on: 'OD', rate_value: od });
  if (tp != null) rules.push({ ...base, applied_on: 'TP', rate_value: tp });
}

function mkBase(meta, opts) {
  return {
    product: opts.product,
    sheet_name: meta.sheetName,
    segment: opts.segment,
    make: 'All',
    region: 'Pan India',
    vehicle_age_min: opts.age_min ?? null,
    vehicle_age_max: opts.age_max ?? null,
    weight_band_min: opts.weight_min ?? null,
    weight_band_max: opts.weight_max ?? null,
    seating_capacity_min: opts.seat_min ?? null,
    seating_capacity_max: opts.seat_max ?? null,
    rate_type: opts.rate_type,
    is_declined: false,
    remarks: opts.remarks,
    rate_text: opts.rate_text,
  };
}

// ============================================================================
//  Rate tables — Remuneration % only (excludes Reward column)
// ============================================================================

// Two Wheeler ----------------------------------------------------------------
const TW_RULES = [
  // Bundled 1+5
  { policy: 'Bundled 1+5 (New)',                  rate_type: 'COMP_1+5', age_min: 0, age_max: 0,   od: 0.20, tp: 0.20 },
  { policy: 'Bundled 1+5 (2nd Year Onwards)',     rate_type: 'COMP_1+5', age_min: 1, age_max: 5,   od: 0.00, tp: 0.15 },
  // Stand-Alone OD
  { policy: 'SAOD ≤10 yrs',                        rate_type: 'SAOD',     age_min: 0, age_max: 10,  od: 0.20, tp: null },
  { policy: 'SAOD >10 yrs',                        rate_type: 'SAOD',     age_min: 10, age_max: 99, od: 0.05, tp: null },
  // Package
  { policy: 'Package ≤5 yrs',                       rate_type: 'COMP',     age_min: 0, age_max: 5,   od: 0.20, tp: 0.20 },
  { policy: 'Package >5 to ≤10 yrs',               rate_type: 'COMP',     age_min: 5, age_max: 10,  od: 0.20, tp: 0.15 },
  { policy: 'Package >10 to ≤15 yrs',              rate_type: 'COMP',     age_min: 10, age_max: 15, od: 0.10, tp: 0.10 },
  { policy: 'Package >15 yrs',                       rate_type: 'COMP',     age_min: 15, age_max: 99, od: 0.10, tp: 0.10 },
  // Long Term 5+5
  { policy: 'LT 5+5 (New)',                          rate_type: 'COMP_5+5', age_min: 0, age_max: 0,   od: 0.20, tp: 0.20 },
  { policy: 'LT 5+5 (2nd Year Onwards)',          rate_type: 'COMP_5+5', age_min: 1, age_max: 5,   od: 0.15, tp: 0.15 },
  // LT MCYLT up to 10 yrs (each year)
  { policy: 'LT MCYLT (each year, ≤10 yrs)',       rate_type: 'COMP',     age_min: 0, age_max: 10,  od: 0.10, tp: 0.10 },
  // Standalone TP
  { policy: 'SATP ≤10 yrs',                         rate_type: 'SATP',     age_min: 0, age_max: 10,  od: null, tp: 0.20 },
  { policy: 'SATP >10 yrs',                         rate_type: 'SATP',     age_min: 10, age_max: 99, od: null, tp: 0.15 },
  // 5-Yr LT SATP
  { policy: 'LT SATP 5-yr (New)',                  rate_type: 'SATP_5yr', age_min: 0, age_max: 0,   od: null, tp: 0.20 },
  { policy: 'LT SATP 5-yr (2nd Year Onwards)',    rate_type: 'SATP_5yr', age_min: 1, age_max: 5,   od: null, tp: 0.20 },
  // LT Liability Only (LTA) up to 10 yrs
  { policy: 'LT Liability (LTA, each year ≤10 yrs)', rate_type: 'SATP',  age_min: 0, age_max: 10,  od: null, tp: 0.10 },
];

// Private Car ----------------------------------------------------------------
const PVT_CAR_RULES = [
  { policy: 'Bundled 1+3 (New)',                     rate_type: 'COMP_1+3', age_min: 0, age_max: 0,   od: 0.20, tp: 0.20 },
  { policy: 'Bundled 1+3 (2nd Year Onwards)',     rate_type: 'COMP_1+3', age_min: 1, age_max: 3,   od: 0.00, tp: 0.20 },
  { policy: 'SAOD ≤10 yrs',                          rate_type: 'SAOD',     age_min: 0, age_max: 10,  od: 0.20, tp: null },
  { policy: 'SAOD >10 yrs',                          rate_type: 'SAOD',     age_min: 10, age_max: 99, od: 0.05, tp: null },
  { policy: 'Package ≤10 yrs',                       rate_type: 'COMP',     age_min: 0, age_max: 10,  od: 0.20, tp: 0.20 },
  { policy: 'Package >10 to ≤15 yrs',               rate_type: 'COMP',     age_min: 10, age_max: 15, od: 0.10, tp: 0.10 },
  { policy: 'Package >15 yrs',                       rate_type: 'COMP',     age_min: 15, age_max: 99, od: 0.05, tp: 0.10 },
  { policy: 'LT 3+3 (New)',                         rate_type: 'COMP_3+3', age_min: 0, age_max: 0,   od: 0.20, tp: 0.20 },
  { policy: 'LT 3+3 (2nd Year Onwards)',         rate_type: 'COMP_3+3', age_min: 1, age_max: 3,   od: 0.20, tp: 0.20 },
  { policy: 'SATP ≤10 yrs',                          rate_type: 'SATP',     age_min: 0, age_max: 10,  od: null, tp: 0.20 },
  { policy: 'SATP >10 yrs',                          rate_type: 'SATP',     age_min: 10, age_max: 99, od: null, tp: 0.15 },
  { policy: 'LT SATP 3-yr (New)',                  rate_type: 'SATP_3yr', age_min: 0, age_max: 0,   od: null, tp: 0.20 },
  { policy: 'LT SATP 3-yr (2nd Year Onwards)',    rate_type: 'SATP_3yr', age_min: 1, age_max: 3,   od: null, tp: 0.20 },
];

// School / Staff Bus ---------------------------------------------------------
const SCHOOL_STAFF_BUS_RULES = [
  { policy: 'Package New',                            rate_type: 'COMP', age_min: 0, age_max: 0,   od: 0.30, tp: 0.30 },
  { policy: 'Package (other than new) ≤10 yrs',     rate_type: 'COMP', age_min: 1, age_max: 10,  od: 0.30, tp: 0.30 },
  { policy: 'Package >10 yrs',                       rate_type: 'COMP', age_min: 10, age_max: 99, od: 0.20, tp: 0.20 },
  { policy: 'SATP ≤10 yrs',                           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null, tp: 0.30 },
  { policy: 'SATP >10 yrs',                          rate_type: 'SATP', age_min: 10, age_max: 99, od: null, tp: 0.20 },
];

// GCV (Goods Commercial Carrying Vehicle) — by GVW × age ---------------------
const GCV_BANDS = [
  { label: 'GCV ≤3500 kg',     weight_min: 0,     weight_max: 3.5 },
  { label: 'GCV 3500-7500 kg',  weight_min: 3.5,   weight_max: 7.5 },
  { label: 'GCV 7500-16500 kg', weight_min: 7.5,   weight_max: 16.5 },
  { label: 'GCV 16500-34000 kg', weight_min: 16.5, weight_max: 34 },
  { label: 'GCV 34000-40000 kg', weight_min: 34,   weight_max: 40 },
  { label: 'GCV 40000-48000 kg', weight_min: 40,   weight_max: 48 },
  { label: 'GCV >48000 kg',     weight_min: 48,    weight_max: null },
];
// GCV rates per band — [Package New, Other ≤10y, 10-15y, >15y, SATP ≤10y, SATP >10y]
// Each entry: { od, tp } for COMP; SATP just tp.
const GCV_RATES_BY_BAND = {
  'GCV ≤3500 kg':     {
    pkg_new:  { od: 0.20, tp: 0.10 },
    pkg_lt10: { od: 0.20, tp: 0.10 },
    pkg_1015: { od: 0.10, tp: 0.10 },
    pkg_gt15: { od: 0.05, tp: 0.10 },
    satp_lt10: 0.10, satp_gt10: 0.10,
  },
  'GCV 3500-7500 kg': {
    pkg_new:  { od: 0.20, tp: 0.10 },
    pkg_lt10: { od: 0.20, tp: 0.10 },
    pkg_1015: { od: 0.10, tp: 0.10 },
    pkg_gt15: { od: 0.05, tp: 0.05 },
    satp_lt10: 0.10, satp_gt10: 0.10,
  },
  'GCV 7500-16500 kg': {
    pkg_new:  { od: 0.15, tp: 0.10 },
    pkg_lt10: { od: 0.15, tp: 0.10 },
    pkg_1015: { od: 0.10, tp: 0.10 },
    pkg_gt15: { od: 0.05, tp: 0.05 },
    satp_lt10: 0.10, satp_gt10: 0.10,
  },
  'GCV 16500-34000 kg': {
    pkg_new:  { od: 0.15, tp: 0.10 },
    pkg_lt10: { od: 0.15, tp: 0.10 },
    pkg_1015: { od: 0.10, tp: 0.10 },
    pkg_gt15: { od: 0.05, tp: 0.05 },
    satp_lt10: 0.10, satp_gt10: 0.10,
  },
  'GCV 34000-40000 kg': {
    pkg_new:  { od: 0.075, tp: 0.075 },
    pkg_lt10: { od: 0.05,  tp: 0.075 },
    pkg_1015: { od: 0.05,  tp: 0.05 },
    pkg_gt15: { od: 0.025, tp: 0.025 },
    satp_lt10: 0.075, satp_gt10: 0.05,
  },
  'GCV 40000-48000 kg': {
    pkg_new:  { od: 0.025, tp: 0.025 },
    pkg_lt10: { od: 0.025, tp: 0.025 },
    pkg_1015: { od: 0.025, tp: 0.025 },
    pkg_gt15: { od: 0.00,  tp: 0.025 },
    satp_lt10: 0.025, satp_gt10: 0.025,
  },
  'GCV >48000 kg': {
    pkg_new:  { od: 0.025, tp: 0.025 },
    pkg_lt10: { od: 0.025, tp: 0.025 },
    pkg_1015: { od: 0.00,  tp: 0.025 },
    pkg_gt15: { od: 0.00,  tp: 0.025 },
    satp_lt10: 0.025, satp_gt10: 0.025,
  },
};

// 3-Wheeler PCV --------------------------------------------------------------
const PCV_3W_RULES = [
  { policy: 'Package New',                           rate_type: 'COMP', age_min: 0, age_max: 0,   od: 0.20, tp: 0.10 },
  { policy: 'Package ≤5 yrs',                        rate_type: 'COMP', age_min: 1, age_max: 5,   od: 0.20, tp: 0.10 },
  { policy: 'Package 5-10 yrs',                     rate_type: 'COMP', age_min: 5, age_max: 10,  od: 0.20, tp: 0.10 },
  { policy: 'Package 10-15 yrs',                    rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.05, tp: 0.10 },
  { policy: 'Package >15 yrs',                      rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.00, tp: 0.05 },
  { policy: 'SATP ≤10 yrs',                         rate_type: 'SATP', age_min: 0, age_max: 10,  od: null, tp: 0.10 },
  { policy: 'SATP >10 yrs',                         rate_type: 'SATP', age_min: 10, age_max: 99, od: null, tp: 0.10 },
];

// 4-Wheeled PCV by seating capacity ------------------------------------------
const PCV_4W_GROUPS = [
  // Taxi (≤6 pax)
  { segment: 'Taxi', seat_min: 0,  seat_max: 6,
    rules: [
      { policy: 'Package New',           rate_type: 'COMP', age_min: 0, age_max: 0,   od: 0.20,  tp: 0.10 },
      { policy: 'Package ≤5 yrs',         rate_type: 'COMP', age_min: 1, age_max: 5,   od: 0.20,  tp: 0.10 },
      { policy: 'Package 5-10 yrs',      rate_type: 'COMP', age_min: 5, age_max: 10,  od: 0.175, tp: 0.10 },
      { policy: 'Package 10-15 yrs',     rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.10,  tp: 0.10 },
      { policy: 'Package >15 yrs',       rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.05,  tp: 0.05 },
      { policy: 'SATP ≤10 yrs',           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null,  tp: 0.10 },
      { policy: 'SATP >10 yrs',          rate_type: 'SATP', age_min: 10, age_max: 99, od: null,  tp: 0.075 },
    ],
  },
  // 6-30 pax PCV
  { segment: '4W PCV 6-30 pax', seat_min: 7, seat_max: 30,
    rules: [
      { policy: 'Package New',           rate_type: 'COMP', age_min: 0, age_max: 0,   od: 0.15,  tp: 0.10 },
      { policy: 'Package ≤5 yrs',         rate_type: 'COMP', age_min: 1, age_max: 5,   od: 0.15,  tp: 0.10 },
      { policy: 'Package 5-10 yrs',      rate_type: 'COMP', age_min: 5, age_max: 10,  od: 0.125, tp: 0.10 },
      { policy: 'Package 10-15 yrs',     rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.075, tp: 0.10 },
      { policy: 'Package >15 yrs',       rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.00,  tp: 0.075 },
      { policy: 'SATP ≤10 yrs',           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null,  tp: 0.10 },
      { policy: 'SATP >10 yrs',          rate_type: 'SATP', age_min: 10, age_max: 99, od: null,  tp: 0.05 },
    ],
  },
  // >30 pax PCV
  { segment: '4W PCV >30 pax', seat_min: 31, seat_max: null,
    rules: [
      { policy: 'Package ≤5 yrs',         rate_type: 'COMP', age_min: 0, age_max: 5,   od: 0.025, tp: 0.025 },
      { policy: 'Package 5-10 yrs',      rate_type: 'COMP', age_min: 5, age_max: 10,  od: 0.025, tp: 0.025 },
      { policy: 'Package 10-15 yrs',     rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.025, tp: 0.025 },
      { policy: 'Package >15 yrs',       rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.00,  tp: 0.025 },
      { policy: 'SATP ≤10 yrs',           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null,  tp: 0.025 },
      { policy: 'SATP >10 yrs',          rate_type: 'SATP', age_min: 10, age_max: 99, od: null,  tp: 0.025 },
    ],
  },
];

// 2W PCV ---------------------------------------------------------------------
const PCV_2W_RULES = [
  { policy: 'Package ≤10 yrs',                        rate_type: 'COMP', age_min: 0, age_max: 10,  od: 0.10, tp: 0.05 },
  { policy: 'Package 10-15 yrs',                     rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.10, tp: 0.05 },
  { policy: 'Package >15 yrs',                       rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.10, tp: 0.05 },
  { policy: 'SATP ≤10 yrs',                           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null, tp: 0.05 },
  { policy: 'SATP >10 yrs',                          rate_type: 'SATP', age_min: 10, age_max: 99, od: null, tp: 0.05 },
];

// Ambulance ------------------------------------------------------------------
const AMBULANCE_RULES = [
  { policy: 'Package ≤10 yrs',                       rate_type: 'COMP', age_min: 0, age_max: 10,  od: 0.15, tp: 0.05 },
  { policy: 'Package 10-15 yrs',                    rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.10, tp: 0.05 },
  { policy: 'Package 15 yrs',                        rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.05, tp: 0.05 },
  { policy: 'SATP ≤10 yrs',                           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null, tp: 0.05 },
  { policy: 'SATP >10 yrs',                          rate_type: 'SATP', age_min: 10, age_max: 99, od: null, tp: 0.05 },
];

// Agri Tractor / E-rickshaw / E-cart (Misc Class-D) --------------------------
const TRACTOR_ERICKSHAW_RULES = [
  { policy: 'Package New',                            rate_type: 'COMP', age_min: 0, age_max: 0,   od: 0.20, tp: 0.10 },
  { policy: 'Package ≤5 yrs (other than new)',       rate_type: 'COMP', age_min: 1, age_max: 5,   od: 0.20, tp: 0.10 },
  { policy: 'Package 5-10 yrs',                     rate_type: 'COMP', age_min: 5, age_max: 10,  od: 0.20, tp: 0.10 },
  { policy: 'Package 10-15 yrs',                    rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.075, tp: 0.10 },
  { policy: 'Package >15 yrs',                      rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.075, tp: 0.10 },
  { policy: 'SATP ≤10 yrs',                           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null, tp: 0.10 },
  { policy: 'SATP >10 yrs',                          rate_type: 'SATP', age_min: 10, age_max: 99, od: null, tp: 0.10 },
];

// Other Misc Class-D (excluding Agri Tractor / E-rickshaw / E-cart) ----------
const MISC_D_OTHER_RULES = [
  { policy: 'Package New',                            rate_type: 'COMP', age_min: 0, age_max: 0,   od: 0.20, tp: 0.10 },
  { policy: 'Package ≤10 yrs',                       rate_type: 'COMP', age_min: 1, age_max: 10,  od: 0.15, tp: 0.10 },
  { policy: 'Package 10-15 yrs',                    rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.10, tp: 0.075 },
  { policy: 'Package >15 yrs',                      rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.05, tp: 0.05 },
  { policy: 'SATP ≤10 yrs',                           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null, tp: 0.10 },
  { policy: 'SATP >10 yrs',                          rate_type: 'SATP', age_min: 10, age_max: 99, od: null, tp: 0.05 },
];

// Class E, F, G --------------------------------------------------------------
const CLASS_EFG_RULES = [
  { policy: 'Package New',                            rate_type: 'COMP', age_min: 0, age_max: 0,   od: 0.10, tp: 0.05 },
  { policy: 'Package ≤10 yrs',                       rate_type: 'COMP', age_min: 1, age_max: 10,  od: 0.10, tp: 0.05 },
  { policy: 'Package 10-15 yrs',                    rate_type: 'COMP', age_min: 10, age_max: 15, od: 0.10, tp: 0.05 },
  { policy: 'Package >15 yrs',                      rate_type: 'COMP', age_min: 15, age_max: 99, od: 0.10, tp: 0.05 },
  { policy: 'SATP ≤10 yrs',                           rate_type: 'SATP', age_min: 0, age_max: 10,  od: null, tp: 0.05 },
  { policy: 'SATP >10 yrs',                          rate_type: 'SATP', age_min: 10, age_max: 99, od: null, tp: 0.05 },
];

// ============================================================================
//  Emit helpers
// ============================================================================
function emitClass(rules, meta, ruleList, product, segment) {
  for (const r of ruleList) {
    const base = mkBase(meta, {
      product, segment,
      age_min: r.age_min, age_max: r.age_max,
      seat_min: r.seat_min, seat_max: r.seat_max,
      weight_min: r.weight_min, weight_max: r.weight_max,
      rate_type: r.rate_type,
      remarks: `${segment} | ${r.policy} | Remuneration only (excl Reward)`,
      rate_text: `National ${segment} | ${r.policy} | OD ${r.od ?? '-'} TP ${r.tp ?? '-'}`,
    });
    emitOdTp(rules, base, r.od, r.tp);
  }
}

function emitGCV(rules, meta) {
  for (const band of GCV_BANDS) {
    const r = GCV_RATES_BY_BAND[band.label];
    const baseOpts = (label, ageMin, ageMax, rateType) => ({
      product: 'GCV', segment: 'GCV',
      weight_min: band.weight_min, weight_max: band.weight_max,
      age_min: ageMin, age_max: ageMax,
      rate_type: rateType,
      remarks: `${band.label} | ${label} | Remuneration only (excl Reward)`,
      rate_text: `National ${band.label} | ${label}`,
    });
    // Package
    emitOdTp(rules, mkBase(meta, baseOpts('Package New', 0, 0, 'COMP')),
             r.pkg_new.od, r.pkg_new.tp);
    emitOdTp(rules, mkBase(meta, baseOpts('Package (other than new) ≤10 yrs', 1, 10, 'COMP')),
             r.pkg_lt10.od, r.pkg_lt10.tp);
    emitOdTp(rules, mkBase(meta, baseOpts('Package 10-15 yrs', 10, 15, 'COMP')),
             r.pkg_1015.od, r.pkg_1015.tp);
    emitOdTp(rules, mkBase(meta, baseOpts('Package >15 yrs', 15, 99, 'COMP')),
             r.pkg_gt15.od, r.pkg_gt15.tp);
    // SATP
    emitOdTp(rules, mkBase(meta, baseOpts('SATP ≤10 yrs', 0, 10, 'SATP')), null, r.satp_lt10);
    emitOdTp(rules, mkBase(meta, baseOpts('SATP >10 yrs', 10, 99, 'SATP')), null, r.satp_gt10);
  }
}

function emitPCV4W(rules, meta) {
  for (const g of PCV_4W_GROUPS) {
    for (const r of g.rules) {
      const base = mkBase(meta, {
        product: 'PCV', segment: g.segment,
        seat_min: g.seat_min, seat_max: g.seat_max,
        age_min: r.age_min, age_max: r.age_max,
        rate_type: r.rate_type,
        remarks: `${g.segment} | ${r.policy} | Remuneration only (excl Reward)`,
        rate_text: `National ${g.segment} | ${r.policy}`,
      });
      emitOdTp(rules, base, r.od, r.tp);
    }
  }
}

function emitSchoolStaffBus(rules, meta) {
  // Source row reads "School / Staff Bus" → split into two distinct segments
  // so VehicleCategory shows each separately (matches UII / Oriental pattern).
  for (const seg of ['School Bus', 'Staff Bus']) {
    emitClass(rules, meta, SCHOOL_STAFF_BUS_RULES, 'PCV', seg);
  }
}

// ============================================================================
//  PDF entry — validate file, emit hard-coded motor rules
// ============================================================================
async function parsePdfFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (!buf || buf.length === 0) console.warn('[national] empty PDF');
  } catch (err) {
    console.error('[national] PDF read failed:', err.message);
  }

  const rules = [];
  const meta = { sheetName: path.basename(filePath) };

  emitClass(rules, meta, TW_RULES,                 'TW',  'TW');
  emitClass(rules, meta, PVT_CAR_RULES,            'CAR', 'Pvt Car');
  emitSchoolStaffBus(rules, meta);
  emitGCV(rules, meta);
  emitClass(rules, meta, PCV_3W_RULES,             'PCV', '3W PCV');
  emitPCV4W(rules, meta);
  emitClass(rules, meta, PCV_2W_RULES,             'PCV', '2W PCV');
  // Product code 'MISC' (not 'MIS') so these rows surface under the MISC
  // product-alias lookup (['MISC','CV','GCV']) and survive the MISC-family
  // segment gate in filterRulesByPolicy (which keys on the "Misc" segment
  // text). The bare 'MIS' code is absent from every product-alias list, so a
  // MISC-type policy (e.g. National's "MISC - D - Others" trucks) never saw
  // these rules and fell to no-rule.
  emitClass(rules, meta, AMBULANCE_RULES,          'MISC', 'Ambulance');
  emitClass(rules, meta, TRACTOR_ERICKSHAW_RULES,  'MISC', 'Agri Tractor / E-rickshaw / E-cart');
  emitClass(rules, meta, MISC_D_OTHER_RULES,       'MISC', 'Misc-D Other');
  emitClass(rules, meta, CLASS_EFG_RULES,          'MISC', 'Class E/F/G');

  return rules;
}

module.exports = { parsePdfFile };
