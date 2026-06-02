/**
 * Oriental Insurance — Motor commission engine (Circular CR-8742,
 * w.e.f. 1st August 2025 to 31st March 2026).
 *
 * Source: "Remuneration and Incentives Circular 8742 ..." PDF — scanned
 * image, parsed via Document AI for validation only. The rate tables are
 * hard-coded below since the source layout is fixed.
 *
 * Scope: MOTOR section only (TW / Pvt Car / Ambulance / Misc-D / GCCV /
 * PCCV / Educational-Staff Bus / Stand-Alone CPA / Motor Trade). Pan
 * India — no state split.
 *
 * Skipped per operator spec:
 *   - Health / Fire / Marine / Engineering — out of scope (non-motor).
 *   - Volume rewards (additional 1-2% if motor premium > Rs 75L / 1.5Cr)
 *     — cumulative across all policies, not per-rule.
 *
 * Entry: parsePdfFile(filePath) → rule[]
 */

const fs = require('fs');

// ----------------------------------------------------------------------------
// Rate tables — exactly as the PDF lists them. Each row tagged with a
// rate_type (COMP / SAOD / SATP / COMP_1+5 / COMP_1+3 / CPA) and product /
// segment metadata so the export's inferVehicleCategory routes correctly.
// ----------------------------------------------------------------------------

// Two Wheeler (rows 1-4)
const TW_RULES = [
  { row: 1,  age_min: 0,  age_max: 0,  policy: 'COMP_1+5', od: 0.20, tp: 0.80, label: 'New Bundled (1+5)' },
  { row: 2,  age_min: 0,  age_max: 15, policy: 'COMP',     od: 0.20, tp: 0.20, label: 'Package' },
  { row: 3,  age_min: 0,  age_max: 10, policy: 'SAOD',     od: 0.20,           label: 'SAOD' },
  { row: 4,  age_min: 0,  age_max: 50, policy: 'SATP',                tp: 0.20, label: 'Liability Only (TP)' },
];

// Private Car (rows 5-8)
const PVT_CAR_RULES = [
  { row: 5,  age_min: 0,  age_max: 0,  policy: 'COMP_1+3', od: 0.30, tp: 0.50, label: 'New Bundled (1+3)' },
  { row: 6,  age_min: 0,  age_max: 15, policy: 'COMP',     od: 0.15, tp: 0.15, label: 'Package' },
  { row: 7,  age_min: 0,  age_max: 10, policy: 'SAOD',     od: 0.15,           label: 'SAOD' },
  { row: 8,  age_min: 0,  age_max: 50, policy: 'SATP',                tp: 0.15, label: 'Liability Only (TP)' },
];

// Ambulances (Misc class) (rows 9-10)
const AMBULANCE_RULES = [
  { row: 9,  age_min: 0,  age_max: 15, policy: 'COMP', od: 0.20, tp: 0.20, label: 'Package' },
  { row: 10, age_min: 0,  age_max: 50, policy: 'SATP',           tp: 0.10, label: 'Liability Only (TP)' },
];

// Misc-D (other than Ambulance) (rows 11-13)
const MISC_D_RULES = [
  { row: 11, age_min: 0,  age_max: 10, policy: 'COMP', od: 0.125, tp: 0.08, label: 'Package (age ≤10)' },
  { row: 12, age_min: 10, age_max: 15, policy: 'COMP', od: 0.10,  tp: 0.08, label: 'Package (age 10-15)' },
  { row: 13, age_min: 0,  age_max: 50, policy: 'SATP',            tp: 0.08, label: 'Liability Only (TP)' },
];

// GCCV (Goods Commercial Carrying Vehicle) — by GVW (rows 14-24).
// Operator confirmed Package rate = Liability rate within each band.
const GCCV_BANDS = [
  { row: 14, gvw_min: 0,     gvw_max: 2.0,   rate: 0.55,  liab: 0.55,  label: 'GVW ≤2000 kg' },
  { row: 15, gvw_min: 2.0,   gvw_max: 3.5,   rate: 0.40,  liab: 0.40,  label: 'GVW 2000-3500 kg' },
  { row: 16, gvw_min: 3.5,   gvw_max: 7.5,   rate: 0.25,  liab: 0.25,  label: 'GVW 3500-7500 kg' },
  { row: 17, gvw_min: 7.5,   gvw_max: 10.0,  rate: 0.15,  liab: 0.15,  label: 'GVW 7500-10000 kg' },
  { row: 18, gvw_min: 10.0,  gvw_max: 12.5,  rate: 0.05,  liab: 0.05,  label: 'GVW 10000-12500 kg' },
  { row: 19, gvw_min: 12.5,  gvw_max: 20.0,  rate: 0.075, liab: 0.075, label: 'GVW 12500-20000 kg' },
  { row: 20, gvw_min: 20.0,  gvw_max: 25.0,  rate: 0.10,  liab: 0.10,  label: 'GVW 20000-25000 kg' },
  { row: 21, gvw_min: 25.0,  gvw_max: 34.0,  rate: 0.075, liab: 0.075, label: 'GVW 25000-34000 kg' },
  { row: 22, gvw_min: 34.0,  gvw_max: 40.0,  rate: 0.05,  liab: 0.05,  label: 'GVW 34000-40000 kg' },
  // Row 23: NIL on OD + 2.5% TP (Package), 2.5% Liability
  { row: 23, gvw_min: 40.0,  gvw_max: 50.0,  od: 0,   tp: 0.025, liab: 0.025, label: 'GVW 40000-50000 kg', split: true },
  // Row 24: NIL Commission both Package and Liability
  { row: 24, gvw_min: 50.0,  gvw_max: null,  rate: 0,     liab: 0,     label: 'GVW >50000 kg' },
];

// PCCV (Passenger Carrying) — rows 25-41. Seating capacity from PDF:
//   Taxi          = "carrying capacity not exceeding 6 passengers"  → seat 0-6
//   6-17 pax      = "carrying capacity exceeding 6 and upto 17"     → seat 7-17
//   17-36 pax     = "carrying capacity exceeding 17 upto 36"        → seat 18-36
//   >36 pax       = "carrying capacity exceeding 36"                → seat 37-null
//   3W PCCV       = 3-Wheeler (default seat ~3) — left null (wheel-based)
//   2W PCCV       = 2-Wheeler (driver + pillion) — left null (wheel-based)
const PCCV_RULES = [
  // 3-Wheeler PCCV (seat capacity not specified by passenger count)
  { row: 25, age_min: 0,  age_max: 0,  segment: '3W PCV',     policy: 'COMP', od: 0.425, tp: 0.425, label: '3W Brand New Package' },
  { row: 26, age_min: 1,  age_max: 15, segment: '3W PCV',     policy: 'COMP', od: 0.35,  tp: 0.35,  label: '3W 1-15 yrs Package' },
  { row: 28, age_min: 0,  age_max: 50, segment: '3W PCV',     policy: 'SATP',            tp: 0.05,  label: '3W Liability Only (TP)' },
  // 4-Wheeled Taxi (≤6 passengers)
  { row: 29, age_min: 0,  age_max: 0,  segment: 'Taxi',        seat_min: 0,  seat_max: 6,  policy: 'COMP', od: 0.20,  tp: 0.20,  label: 'Taxi Brand New Package (≤6 pax)' },
  { row: 30, age_min: 1,  age_max: 15, segment: 'Taxi',        seat_min: 0,  seat_max: 6,  policy: 'COMP', od: 0.15,  tp: 0.15,  label: 'Taxi 1-15 yrs Package (≤6 pax)' },
  { row: 31, age_min: 0,  age_max: 50, segment: 'Taxi',        seat_min: 0,  seat_max: 6,  policy: 'SATP',            tp: 0.05,  label: 'Taxi Liability Only TP (≤6 pax)' },
  // 4-Wheeled 6-17 passengers (exceeding 6, upto 17)
  { row: 32, age_min: 0,  age_max: 0,  segment: '4W PCV 6-17 pax', seat_min: 7,  seat_max: 17, policy: 'COMP', od: 0.15, tp: 0.15, label: '6-17 pax Brand New Package' },
  { row: 33, age_min: 1,  age_max: 15, segment: '4W PCV 6-17 pax', seat_min: 7,  seat_max: 17, policy: 'COMP', od: 0.15, tp: 0.15, label: '6-17 pax 1-15 yrs Package' },
  { row: 34, age_min: 0,  age_max: 50, segment: '4W PCV 6-17 pax', seat_min: 7,  seat_max: 17, policy: 'SATP',            tp: 0.05, label: '6-17 pax Liability Only (TP)' },
  // 4-Wheeled 17-36 passengers (exceeding 17, upto 36)
  { row: 35, age_min: 0,  age_max: 10, segment: '4W PCV 17-36 pax', seat_min: 18, seat_max: 36, policy: 'COMP', od: 0.075, tp: 0.025, label: '17-36 pax ≤10 yrs Package' },
  { row: 36, age_min: 10, age_max: 15, segment: '4W PCV 17-36 pax', seat_min: 18, seat_max: 36, policy: 'COMP', od: 0.05,  tp: 0.025, label: '17-36 pax 10-15 yrs Package' },
  { row: 37, age_min: 0,  age_max: 50, segment: '4W PCV 17-36 pax', seat_min: 18, seat_max: 36, policy: 'SATP',            tp: 0,     label: '17-36 pax Liability Only (TP)' },
  // 4-Wheeled >36 passengers (exceeding 36)
  { row: 38, age_min: 0,  age_max: 15, segment: '4W PCV >36 pax', seat_min: 37, seat_max: null, policy: 'COMP', od: 0.05, tp: 0.05, label: '>36 pax ≤15 yrs Package' },
  { row: 39, age_min: 0,  age_max: 50, segment: '4W PCV >36 pax', seat_min: 37, seat_max: null, policy: 'SATP',            tp: 0,    label: '>36 pax Liability Only (TP)' },
  // 2-Wheeler PCCV (no explicit seat band)
  { row: 40, age_min: 0,  age_max: 15, segment: '2W PCV',     policy: 'COMP', od: 0.10, tp: 0.10, label: '2W ≤15 yrs Package' },
  { row: 41, age_min: 0,  age_max: 50, segment: '2W PCV',     policy: 'SATP',           tp: 0,    label: '2W Liability Only (TP)' },
];

// Educational Institution and Staff Buses (rows 42-43) — split into two
// distinct segments so VehicleCategory shows School Bus / Staff Bus
// independently (operator preference; matches UII engine behaviour).
const SCHOOL_STAFF_BUS_RULES = [
  { row: 42, age_min: 0, age_max: 15, policy: 'COMP', od: 0.60, tp: 0.60, label: '≤15 yrs Package (60%)' },
  { row: 43, age_min: 0, age_max: 50, policy: 'SATP',           tp: 0.45, label: 'Liability Only TP (45%)' },
];

// Stand-Alone CPA (row 44)
const CPA_RATE = 0.025;

// Motor Trade (row 45)
const MOTOR_TRADE_RATE = 0.10;

// ----------------------------------------------------------------------------
// Emit helpers — produce OD/TP-paired COMP rules (export's mergeOdTpPairs
// folds them into one display row) and standalone SAOD/SATP rules.
// ----------------------------------------------------------------------------

function emitOdTpPair(meta, base, od, tp) {
  // Caller-supplied rate_type on `base` (e.g. COMP_1+5, COMP_1+3) wins
  // over the default 'COMP'.
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
    is_declined: false,
    remarks: opts.remarks,
    rate_text: opts.rate_text,
  };
}

function emitVehicleClass(rules, meta, ruleList, product, segment) {
  for (const r of ruleList) {
    const base = mkBase(meta, {
      product, segment: r.segment || segment,
      age_min: r.age_min, age_max: r.age_max,
      seat_min: r.seat_min, seat_max: r.seat_max,
      remarks: `Row ${r.row} — ${r.label}`,
      rate_text: `Oriental ${segment} | ${r.label} | OD ${r.od ?? '-'} TP ${r.tp ?? '-'}`,
    });
    switch (r.policy) {
      case 'COMP':
      case 'COMP_1+5':
      case 'COMP_1+3':
        rules.push(...emitOdTpPair(meta, { ...base, rate_type: r.policy }, r.od, r.tp));
        break;
      case 'SAOD':
        rules.push({ ...base, rate_type: 'SAOD', applied_on: 'OD', rate_value: r.od, is_declined: false });
        break;
      case 'SATP':
        rules.push({ ...base, rate_type: 'SATP', applied_on: 'TP', rate_value: r.tp, is_declined: false });
        break;
    }
  }
}

function emitGCCV(rules, meta) {
  for (const b of GCCV_BANDS) {
    // Package rule: weight band + age 0-15 (including brand new)
    const basePkg = mkBase(meta, {
      product: 'GCV', segment: 'GCCV',
      age_min: 0, age_max: 15,
      weight_min: b.gvw_min, weight_max: b.gvw_max,
      remarks: `Row ${b.row} — ${b.label} | Package (age ≤15 incl Brand New)`,
      rate_text: `Oriental GCCV ${b.label} | Package`,
    });
    if (b.split) {
      // Row 23: NIL OD + 2.5% TP — distinct OD/TP rates
      rules.push(...emitOdTpPair(meta, { ...basePkg, rate_type: 'COMP' }, b.od, b.tp));
    } else {
      rules.push(...emitOdTpPair(meta, { ...basePkg, rate_type: 'COMP' }, b.rate, b.rate));
    }
    // Liability rule — no age restriction
    const baseLiab = mkBase(meta, {
      product: 'GCV', segment: 'GCCV',
      age_min: 0, age_max: 50,
      weight_min: b.gvw_min, weight_max: b.gvw_max,
      remarks: `Row ${b.row}(a) — ${b.label} | Liability Only (TP)`,
      rate_text: `Oriental GCCV ${b.label} | Liability`,
    });
    rules.push({ ...baseLiab, rate_type: 'SATP', applied_on: 'TP', rate_value: b.liab, is_declined: false });
  }
}

function emitSchoolStaffBus(rules, meta) {
  // The PDF lists a single "Educational Institution and Staff Buses" header
  // — split into two segments per operator preference.
  for (const segName of ['School Bus', 'Staff Bus']) {
    for (const r of SCHOOL_STAFF_BUS_RULES) {
      const base = mkBase(meta, {
        product: 'PCV', segment: segName,
        age_min: r.age_min, age_max: r.age_max,
        remarks: `Row ${r.row} — ${segName}: ${r.label}`,
        rate_text: `Oriental ${segName} | ${r.label}`,
      });
      if (r.policy === 'COMP') {
        rules.push(...emitOdTpPair(meta, { ...base, rate_type: 'COMP' }, r.od, r.tp));
      } else if (r.policy === 'SATP') {
        rules.push({ ...base, rate_type: 'SATP', applied_on: 'TP', rate_value: r.tp, is_declined: false });
      }
    }
  }
}

function emitCpa(rules, meta) {
  rules.push({
    product: 'CPA', sheet_name: meta.sheetName,
    segment: 'Standalone CPA', make: 'All',
    region: 'Pan India',
    rate_type: 'CPA', applied_on: 'NET', rate_value: CPA_RATE,
    is_declined: false,
    remarks: `Row 44 — Stand-Alone CPA (all class of vehicles)`,
    rate_text: `Oriental Standalone CPA | 2.5%`,
  });
}

function emitMotorTrade(rules, meta) {
  rules.push(...emitOdTpPair(meta, mkBase(meta, {
    product: 'MIS', segment: 'Motor Trade',
    age_min: null, age_max: null,
    remarks: `Row 45 — Motor Trade Policies E,F,G | Package (10% Net)`,
    rate_text: `Oriental Motor Trade | Package | 10%`,
  }), MOTOR_TRADE_RATE, MOTOR_TRADE_RATE));
}

// ----------------------------------------------------------------------------
// PDF entry — validate the file then emit hard-coded motor rules
// ----------------------------------------------------------------------------

async function parsePdfFile(filePath) {
  // Validate the file opens — but rates are hard-coded so we don't need
  // its content. A bad file produces a visible error rather than silently
  // using last cycle's rates.
  try {
    const buf = fs.readFileSync(filePath);
    if (!buf || buf.length === 0) {
      console.warn('[oriental] PDF file is empty');
    }
  } catch (err) {
    console.error('[oriental] PDF read failed:', err.message);
  }

  const rules = [];
  const meta = { sheetName: require('path').basename(filePath) };

  emitVehicleClass(rules, meta, TW_RULES,        'TW',  'TW');
  emitVehicleClass(rules, meta, PVT_CAR_RULES,   'CAR', 'Pvt Car');
  emitVehicleClass(rules, meta, AMBULANCE_RULES, 'MIS', 'Ambulance');
  emitVehicleClass(rules, meta, MISC_D_RULES,    'MIS', 'MISC-D');
  emitGCCV(rules, meta);
  emitVehicleClass(rules, meta, PCCV_RULES,      'PCV', 'PCCV');
  emitSchoolStaffBus(rules, meta);
  emitCpa(rules, meta);
  emitMotorTrade(rules, meta);

  return rules;
}

module.exports = { parsePdfFile };
