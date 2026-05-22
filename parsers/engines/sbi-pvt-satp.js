/**
 * SBI Pvt Car SATP wide-matrix engine — handles "PVT car SATP-Apr26"
 * sheet. Layout: state + RTO cluster keyed rows, with paired Petrol /
 * Diesel rate columns each split into 3 CC bands (0-1000 / 1001-1500 /
 * 1500+).
 *
 * Layout reference (R0..R2 are headers):
 *   R0: |  | Petrol/Hybrid/EV  | (3 sub-cols) | Diesel/CNG/LPG | (3 sub-cols)
 *   R1: State Name | RTO Cluster Name | A. 0-1000 | B. 1001-1500 | C. 1500+ | (same trio for Diesel)
 *   R2..: data
 *
 * Per the sheet's footer notes, each printed cell value is the BASE for
 * "Above 25 Lakhs" premium slab + age 0 (new vehicle) and expands into
 * multiple rules:
 *
 *   • Fuel-type alias group:
 *       Petrol cell → 3 rules: Petrol / Hybrid / EV
 *       Diesel cell → 3 rules: Diesel / CNG / LPG
 *
 *   • Premium-slab variants (encoded in volume_tier):
 *       > 25 Lakhs   → rate as printed
 *       1L - 25 Lakhs → rate − 2%
 *
 *   • Vehicle-age variants (column header reads "(10+Y)"):
 *       Age 10+ (base)     → rate as printed
 *       Age 1-9 (rollover) → rate − 3%
 *
 * Net: each non-zero cell emits 3 × 2 × 2 = 12 rules.
 *
 * A rate of 0 is interpreted as "declined" per SBI convention — emitted
 * with `is_declined=true` and `rate_value=null` so the recovery layer
 * surfaces them as explicit declines.
 */

const { irdaRateFor } = require('../utils/irda-rates');

const PETROL_FUELS = ['Petrol', 'Hybrid', 'EV'];
const DIESEL_FUELS = ['Diesel', 'CNG', 'LPG'];

const SATP_COLS = [
  { col: 2, fuels: PETROL_FUELS, cc_band_min: 0,    cc_band_max: 1000  },
  { col: 3, fuels: PETROL_FUELS, cc_band_min: 1001, cc_band_max: 1500  },
  { col: 4, fuels: PETROL_FUELS, cc_band_min: 1501, cc_band_max: 99999 },
  { col: 5, fuels: DIESEL_FUELS, cc_band_min: 0,    cc_band_max: 1000  },
  { col: 6, fuels: DIESEL_FUELS, cc_band_min: 1001, cc_band_max: 1500  },
  { col: 7, fuels: DIESEL_FUELS, cc_band_min: 1501, cc_band_max: 99999 },
];

// Premium-slab variants (volume_tier label + delta applied to printed rate).
// Per sheet note:
//   "For less than 25 lac Grid would be lower by 2% & for less than 1 L
//    only IRDA applicable."
// → three tiers:
//   Above 25L  : grid as printed
//   1L-25L     : grid − 2%
//   < 1L       : only IRDA applicable → use firm-wide IRDA defaults
//                (COMP 19.5% / SATP 2.5%) from parsers/utils/irda-rates.js
const PREMIUM_SLABS = [
  { tier: 'Above 25L', delta:  0,     irda_only: false },
  { tier: '1L-25L',    delta: -0.02,  irda_only: false },
  { tier: 'Below 1L',  delta:  0,     irda_only: true  },
];

// Vehicle-age variants. Column header reads "(10+Y)" — printed rate is
// the BASE for age 10+. Per sheet note, age 1-9 gets a 3% discount.
//   "PVT SATP: Grid would be lesser by 3% for vehicle age 1-9 Years".
const AGE_VARIANTS = [
  { min: 10, max: 99, delta:  0     },
  { min: 1,  max: 9,  delta: -0.03  },
];

function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseRate(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row : 2;
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const stateName = cellOrNull(row[0]);
    const cluster   = cellOrNull(row[1]);
    if (!stateName && !cluster) continue;
    for (const spec of SATP_COLS) {
      const raw = row[spec.col];
      if (raw === '' || raw == null) continue;
      const v = parseRate(raw);
      if (v == null) continue;
      const cellDeclined = v === 0;
      for (const fuel of spec.fuels) {
        for (const slab of PREMIUM_SLABS) {
          for (const age of AGE_VARIANTS) {
            // "Below 1L" slab — IRDA-only: substitute firm-wide IRDA default
            // (SATP 2.5% on this sheet). Cell-zero (declined) still wins.
            let rate;
            if (cellDeclined) {
              rate = null;
            } else if (slab.irda_only) {
              rate = irdaRateFor('SATP');
            } else {
              rate = Math.max(0, +(v + slab.delta + age.delta).toFixed(6));
            }
            rules.push({
              product: 'CAR',
              sheet_name: meta.sheetName,
              region: cluster,                  // RTO cluster from the sheet
              segment: 'Pvt Car SATP',
              make: 'All',
              sub_type: stateName,              // state name kept for tie-break / display
              fuel_type: fuel,
              cc_band_min: spec.cc_band_min,
              cc_band_max: spec.cc_band_max,
              vehicle_age_min: age.min,
              vehicle_age_max: age.max,
              volume_tier: slab.tier,           // premium slab: Above 25L / 1L-25L / Below 1L
              rate_type: 'SATP',
              rate_value: rate,
              is_declined: cellDeclined,
              rate_text: slab.irda_only
                ? `${stateName} | Below 1L: IRDA default 2.5%`
                : stateName,
              remarks: slab.irda_only ? 'Premium below ₹1L — IRDA default applied (SATP 2.5%)' : null,
            });
          }
        }
      }
    }
  }
  return rules;
}

module.exports = { parse };
