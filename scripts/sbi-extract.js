#!/usr/bin/env node
/**
 * SBI rate-card extractor.
 *
 * Reads the two SBI source files:
 *   1. SBI Effective From 2nd April.xlsx — three sheets:
 *      - "A&B Cat Broker_Apr26"  → main rate grid (~80 cols × ~60 data rows)
 *      - "PVT car SATP-Apr26"    → Pvt Car SATP wide-matrix (CC × Fuel)
 *      - "Cluster Master"        → 1442 RTO → cluster lookup (older)
 *   2. SBI New RTO Master 27th April Effective All Segment.xlsx
 *      - "cluster master"        → 1988 RTO → cluster lookup (newer)
 *
 * Writes to the local DB:
 *   - rate_cards (2 rows: rate sheet + 27th-April RTO master)
 *   - rate_rules (~6000 rows from main grid + ~360 from SATP sheet)
 *   - rto_mappings (1442 rows tied to rate sheet card + 1988 rows tied to
 *     newer RTO master card; resolveRTO will pick by effective date)
 *
 * Run:    node scripts/sbi-extract.js
 *
 * The script is idempotent — running it twice will create duplicate rate
 * cards. To re-run cleanly, delete the SBI rate cards first:
 *   DELETE FROM rate_rules WHERE insurer = 'sbi_general';
 *   DELETE FROM rto_mappings WHERE insurer = 'sbi_general';
 *   DELETE FROM rate_cards WHERE insurer = 'sbi_general';
 */

const path = require('path');
const XLSX = require('xlsx');
const sql = require('mssql');
const { getPool } = require(path.join(__dirname, '..', 'db', 'connection'));

const RATE_FILE = 'D:/Motor_Payout/April26/Ritesh Sir/SBI April Month/SBI Effective From 2nd April.xlsx';
const RTO_FILE  = 'D:/Motor_Payout/April26/Ritesh Sir/SBI April Month/SBI New  RTO Master 27th April Effective All Segment.xlsx';
const INSURER_SLUG = 'sbi_general';

// ── Column spec for the main rate sheet "A&B Cat Broker_Apr26" ──────────
// Each entry maps a column index to the rate fields we'll persist.
// Notes on encoding (per user discussion):
//   - "New-Comp / Non New Comp" on GCV-Upto-2.5T  →  vehicle age 0/0 vs 1/99
//   - R2 age tier (New / Age 1-5 / Age above 5)   →  vehicle_age_min/max
//   - Pvt-Car-Comp & SAOD                          →  rate_type COMP / SAOD
//   - PCV-Taxi Nill Dep / Non Nill Dep             →  addon = Y / N
//   - Tractor C57 "Non New & SATP" (single value)  →  emit two rules
//     (COMP age 1/99 AND SATP) sharing the same rate_value
//   - 2W C82 "Scooter upto 150 cc (Comp & SAOD)"   →  emit two rules
//     (COMP and SAOD) sharing the same rate_value
//
// Fields the script emits per cell:
//   product, segment, make, sub_type, fuel_type, vehicle_age_min/max,
//   cc_band_min/max, addon, rate_type, rate_value, is_declined
const RATE_COLS = (() => {
  const list = [];
  // GCV 4W Upto 2.5T  ------------------------------------------------------
  // Sub: Upto 2.0T-All makes & 2.0-2.5T Tata makes  (C3..C5)
  list.push({ col: 3,  product: 'GCV', segment: 'GCV 4W Upto 2.5T',  make: 'Upto 2.0T-All & 2.0-2.5T Tata', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 4,  product: 'GCV', segment: 'GCV 4W Upto 2.5T',  make: 'Upto 2.0T-All & 2.0-2.5T Tata', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 5,  product: 'GCV', segment: 'GCV 4W Upto 2.5T',  make: 'Upto 2.0T-All & 2.0-2.5T Tata', rate_type: 'SATP' });
  // Sub: 2.0-2.5T-other than Tata makes  (C6..C8)
  list.push({ col: 6,  product: 'GCV', segment: 'GCV 4W 2.0-2.5T',   make: 'Other than Tata',              vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 7,  product: 'GCV', segment: 'GCV 4W 2.0-2.5T',   make: 'Other than Tata',              vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 8,  product: 'GCV', segment: 'GCV 4W 2.0-2.5T',   make: 'Other than Tata',              rate_type: 'SATP' });
  // Sub: GCV 3W  (C9..C11) — note R0 mislabels as 4W; R1 is canonical 3W
  list.push({ col: 9,  product: 'GCV', segment: 'GCV 3W',            make: 'All',                          vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 10, product: 'GCV', segment: 'GCV 3W',            make: 'All',                          rate_type: 'COMP' });
  list.push({ col: 11, product: 'GCV', segment: 'GCV 3W',            make: 'All',                          rate_type: 'SATP' });
  // 2.5T-3.5T GCV 4W  ----------------------------------------------------
  list.push({ col: 12, product: 'GCV', segment: 'GCV 4W 2.5-3.5T',   make: 'Mahindra all variants',        rate_type: 'COMP' });
  list.push({ col: 13, product: 'GCV', segment: 'GCV 4W 2.5-3.5T',   make: 'Mahindra all variants',        rate_type: 'SATP' });
  list.push({ col: 14, product: 'GCV', segment: 'GCV 4W 2.5-3.5T',   make: 'TATA & Ashok Leyland',         rate_type: 'COMP' });
  list.push({ col: 15, product: 'GCV', segment: 'GCV 4W 2.5-3.5T',   make: 'TATA & Ashok Leyland',         rate_type: 'SATP' });
  list.push({ col: 16, product: 'MISC',segment: 'GCV Tractor 2.5-3.5T', make: 'All',                       rate_type: 'COMP' });
  list.push({ col: 17, product: 'MISC',segment: 'GCV Tractor 2.5-3.5T', make: 'All',                       rate_type: 'SATP' });
  // 3.5T-5.0T  ------------------------------------------------------------
  list.push({ col: 18, product: 'GCV', segment: 'GCV 3.5-5.0T',      make: 'Excluding Eicher & Mahindra',  rate_type: 'COMP' });
  list.push({ col: 19, product: 'GCV', segment: 'GCV 3.5-5.0T',      make: 'Excluding Eicher & Mahindra',  rate_type: 'SATP' });
  // 5.0T-7.5T
  list.push({ col: 20, product: 'GCV', segment: 'GCV 5.0-7.5T',      make: 'Excluding Eicher & Mahindra',  rate_type: 'COMP' });
  list.push({ col: 21, product: 'GCV', segment: 'GCV 5.0-7.5T',      make: 'Excluding Eicher & Mahindra',  rate_type: 'SATP' });
  // 7.5T-12T
  list.push({ col: 22, product: 'GCV', segment: 'GCV 7.5-12T',       make: 'Excluding Eicher',             rate_type: 'COMP' });
  list.push({ col: 23, product: 'GCV', segment: 'GCV 7.5-12T',       make: 'Excluding Eicher',             rate_type: 'SATP' });
  // 12T-20T (Other makes) — by age
  list.push({ col: 24, product: 'GCV', segment: 'GCV 12-20T',        make: 'Other makes', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 25, product: 'GCV', segment: 'GCV 12-20T',        make: 'Other makes', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 26, product: 'GCV', segment: 'GCV 12-20T',        make: 'Other makes', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 27, product: 'GCV', segment: 'GCV 12-20T',        make: 'Other makes', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 28, product: 'GCV', segment: 'GCV 12-20T',        make: 'Other makes', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 29, product: 'GCV', segment: 'GCV 12-20T',        make: 'Other makes', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // 12T-20T (TATA & Ashok Leyland) — by age
  list.push({ col: 30, product: 'GCV', segment: 'GCV 12-20T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 31, product: 'GCV', segment: 'GCV 12-20T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 32, product: 'GCV', segment: 'GCV 12-20T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 33, product: 'GCV', segment: 'GCV 12-20T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 34, product: 'GCV', segment: 'GCV 12-20T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 35, product: 'GCV', segment: 'GCV 12-20T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // 20T-40T (Other makes)
  list.push({ col: 36, product: 'GCV', segment: 'GCV 20-40T',        make: 'Other makes', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 37, product: 'GCV', segment: 'GCV 20-40T',        make: 'Other makes', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 38, product: 'GCV', segment: 'GCV 20-40T',        make: 'Other makes', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 39, product: 'GCV', segment: 'GCV 20-40T',        make: 'Other makes', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 40, product: 'GCV', segment: 'GCV 20-40T',        make: 'Other makes', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 41, product: 'GCV', segment: 'GCV 20-40T',        make: 'Other makes', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // 20T-40T (TATA & Ashok Leyland)
  list.push({ col: 42, product: 'GCV', segment: 'GCV 20-40T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 43, product: 'GCV', segment: 'GCV 20-40T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 44, product: 'GCV', segment: 'GCV 20-40T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 45, product: 'GCV', segment: 'GCV 20-40T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 46, product: 'GCV', segment: 'GCV 20-40T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 47, product: 'GCV', segment: 'GCV 20-40T',        make: 'TATA & Ashok Leyland', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // >40T (Other makes)
  list.push({ col: 48, product: 'GCV', segment: 'GCV >40T',          make: 'Other makes', vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 49, product: 'GCV', segment: 'GCV >40T',          make: 'Other makes', vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 50, product: 'GCV', segment: 'GCV >40T',          make: 'Other makes', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 51, product: 'GCV', segment: 'GCV >40T',          make: 'Other makes', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // >40T (TATA & Ashok Leyland)
  list.push({ col: 52, product: 'GCV', segment: 'GCV >40T',          make: 'TATA & Ashok Leyland', vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 53, product: 'GCV', segment: 'GCV >40T',          make: 'TATA & Ashok Leyland', vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 54, product: 'GCV', segment: 'GCV >40T',          make: 'TATA & Ashok Leyland', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 55, product: 'GCV', segment: 'GCV >40T',          make: 'TATA & Ashok Leyland', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // Agricultural Tractor & Harvester (excluding Trailer)
  // C56 "New" → COMP, age 0/0
  // C57 "Non New & SATP" → ONE value, applied to BOTH (COMP age 1/99) AND (SATP)
  list.push({ col: 56, product: 'MISC', segment: 'Agricultural Tractor & Harvester', make: 'All', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 57, product: 'MISC', segment: 'Agricultural Tractor & Harvester', make: 'All', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP', dual_emit: 'SATP' });
  // PCV 3W (Carrying capacity 3+1) — Non Diesel
  list.push({ col: 58, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 59, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 60, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 61, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'SATP' });
  // PCV 3W — Diesel
  list.push({ col: 62, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 63, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 64, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 65, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'SATP' });
  // PCV Taxi 6+1 — by CC band, with Nil-Dep / Non-Nil-Dep variants
  // Upto 999 CC
  list.push({ col: 66, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 0,    cc_band_max: 999,   rate_type: 'COMP', addon: 'Y' });
  list.push({ col: 67, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 0,    cc_band_max: 999,   rate_type: 'COMP', addon: 'N' });
  list.push({ col: 68, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 0,    cc_band_max: 999,   rate_type: 'SATP' });
  // 1000-1499 CC
  list.push({ col: 69, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1000, cc_band_max: 1499, rate_type: 'COMP', addon: 'Y' });
  list.push({ col: 70, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1000, cc_band_max: 1499, rate_type: 'COMP', addon: 'N' });
  list.push({ col: 71, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1000, cc_band_max: 1499, rate_type: 'SATP' });
  // Above 1500 CC
  list.push({ col: 72, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1500, cc_band_max: 99999, rate_type: 'COMP', addon: 'Y' });
  list.push({ col: 73, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1500, cc_band_max: 99999, rate_type: 'COMP', addon: 'N' });
  list.push({ col: 74, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1500, cc_band_max: 99999, rate_type: 'SATP' });
  // PCV Taxi State Capital (Innova / Hycross / Scorpio / Bolero)
  list.push({ col: 75, product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', rate_type: 'COMP', addon: 'Y' });
  list.push({ col: 76, product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', rate_type: 'COMP', addon: 'N' });
  list.push({ col: 77, product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', rate_type: 'SATP' });
  // School Bus 18+ seater
  list.push({ col: 78, product: 'PCV', segment: 'School Bus 18+ seater', make: 'All', seating_capacity_min: 18, rate_type: 'COMP' });
  list.push({ col: 79, product: 'PCV', segment: 'School Bus 18+ seater', make: 'All', seating_capacity_min: 18, rate_type: 'SATP' });
  // Pvt Car (Comp on OD + SAOD on OD)
  list.push({ col: 80, product: 'CAR', segment: 'Pvt Car', make: 'All', rate_type: 'COMP' });
  list.push({ col: 81, product: 'CAR', segment: 'Pvt Car', make: 'All', rate_type: 'SAOD' });
  // 2W (1+1 net premium only)
  // C82 covers "Scooter upto 150 cc (Comp & SAOD)" — emit COMP and SAOD with same value
  list.push({ col: 82, product: 'TW', segment: 'Scooter <=150cc', make: 'All', cc_band_min: 0, cc_band_max: 150,    rate_type: 'COMP', dual_emit: 'SAOD' });
  list.push({ col: 83, product: 'TW', segment: 'Bike <=125cc',    make: 'All', cc_band_min: 0, cc_band_max: 125,    rate_type: 'COMP', dual_emit: 'SAOD' });
  list.push({ col: 84, product: 'TW', segment: 'Bike >125cc',     make: 'All', cc_band_min: 126, cc_band_max: 99999, rate_type: 'COMP', dual_emit: 'SAOD' });
  return list;
})();

/** Pvt Car SATP wide-matrix from Sheet 1 — fixed 6-column layout
 *  (Petrol [0-1000 / 1001-1500 / 1500+] | Diesel [0-1000 / 1001-1500 / 1500+]).
 *  cc_band ranges chosen to align with the headers exactly. */
const PVT_SATP_COLS = [
  { col: 2, fuel_type: 'Petrol', cc_band_min: 0,    cc_band_max: 1000 },
  { col: 3, fuel_type: 'Petrol', cc_band_min: 1001, cc_band_max: 1500 },
  { col: 4, fuel_type: 'Petrol', cc_band_min: 1501, cc_band_max: 99999 },
  { col: 5, fuel_type: 'Diesel', cc_band_min: 0,    cc_band_max: 1000 },
  { col: 6, fuel_type: 'Diesel', cc_band_min: 1001, cc_band_max: 1500 },
  { col: 7, fuel_type: 'Diesel', cc_band_min: 1501, cc_band_max: 99999 },
];

/** ── Declined-RTO footnotes (sheet 0 rows 80+) ──────────────────────────
 *  These are the human-readable notes at the bottom of the rate sheet that
 *  spell out which (segment, state) combinations SBI declines. Encoded
 *  here as a structured table so we can emit `is_declined=true` rows. */
const DECLINED = [
  // "* For 2.5T-3.5T GCV Declined RTOs :- All RTOs declined state-AN/AR/AS/DD/DN/HR/NCR/KA/KL/LA/LD/ML/MN/MP/MZ/NL/PY/RJ/SK/TN/TR/UA/UK/WB/J&K/CG"
  {
    segment: 'GCV 4W 2.5-3.5T',
    states: ['AN','AR','AS','DD','DN','HR','NCR','KA','KL','LA','LD','ML','MN','MP','MZ','NL','PY','RJ','SK','TN','TR','UA','UK','WB','J&K','CG'],
    note: 'SBI declined for 2.5T-3.5T GCV in this state',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

/** Return cell value or null when blank/whitespace. */
function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s;
}

/** Parse rate as decimal (input may be "37" → 0.37 or "0.37"). */
function parseRate(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  // Treat values > 1 as percents (e.g. 37 → 0.37). Below or equal to 1 are
  // already decimal fractions.
  return n > 1 ? n / 100 : n;
}

/** Extract a city qualifier from a state cell like "TAMIL NADU- Chennai" → "Chennai".
 *  Returns null when the cell is just a state name. */
function extractCity(state) {
  if (!state) return null;
  const m = String(state).match(/[-—–]\s*(.+?)\s*$/);
  if (m) return m[1].trim();
  // Bare city names like "Kolkata" — the rate sheet has both "Kolkata" and
  // "Rest of West Bengal" as siblings. Treat short single-word entries with
  // a known city-prefix list as cities.
  const KNOWN_CITIES = ['KOLKATA', 'CHENNAI', 'MUMBAI', 'PUNE', 'DELHI', 'AHMEDABAD', 'BANGALORE', 'BENGALURU', 'HYDERABAD'];
  if (KNOWN_CITIES.includes(String(state).toUpperCase().trim())) return state.trim();
  return null;
}

// ── Main extraction ─────────────────────────────────────────────────────

async function main() {
  console.log('▶  SBI rate-card extractor starting…');
  const pool = await getPool();

  // Insert two rate cards. card_a (rate sheet) covers 2 Apr → 27 Apr;
  // card_b (RTO master) is open-ended from 27 Apr.
  const cardA = await insertRateCard(pool, {
    insurer: INSURER_SLUG,
    file_name: path.basename(RATE_FILE),
    effective_from: '2026-04-02',
    effective_to:   '2026-04-27',
  });
  console.log(`  ✓ rate_card #${cardA} created — rate sheet (2nd Apr → 27 Apr)`);

  const cardB = await insertRateCard(pool, {
    insurer: INSURER_SLUG,
    file_name: path.basename(RTO_FILE),
    effective_from: '2026-04-27',
    effective_to:   null,
  });
  console.log(`  ✓ rate_card #${cardB} created — RTO master (27 Apr → open)`);

  // Close out the older RTO master (sheet 2 of card A) when card B starts.
  // Already handled by effective_to on card A above.

  // ── Sheet 0: A&B Cat Broker_Apr26 ─────────────────────────────────────
  const wb = XLSX.readFile(RATE_FILE);
  const main = XLSX.utils.sheet_to_json(wb.Sheets['A&B Cat Broker_Apr26'], {
    header: 1, defval: '', blankrows: false,
  });
  let mainCount = 0, declinedCount = 0;
  // Data rows start at index 4. Stop when col 0 falls outside the 8 broker
  // zones — anything else is a footnote / decline section.
  const ZONES = new Set(['East 1', 'East 2', 'North 1', 'North 2', 'South 1', 'South 2', 'West 1', 'West 2']);
  for (let r = 4; r < main.length; r++) {
    const row = main[r];
    if (!row) continue;
    const region = cellOrNull(row[0]);
    const state  = cellOrNull(row[1]);
    const circle = cellOrNull(row[2]);
    if (!region || !state || !ZONES.has(region)) continue; // footnote / blank — stop gracefully

    for (const spec of RATE_COLS) {
      const v = parseRate(row[spec.col]);
      if (v == null || v === 0) continue; // blank or genuine zero — skip
      // Persist primary rule
      await insertRateRule(pool, {
        rate_card_id: cardA,
        insurer: INSURER_SLUG,
        product: spec.product,
        sheet_name: 'A&B Cat Broker_Apr26',
        region,                                  // SBI broker zone (East 1, etc.)
        segment: spec.segment,
        make: spec.make || 'All',
        sub_type: extractCity(state) || null,    // e.g. "Chennai" for "TAMIL NADU- Chennai"
        fuel_type: spec.fuel_type || null,
        cc_band_min: spec.cc_band_min ?? null,
        cc_band_max: spec.cc_band_max ?? null,
        vehicle_age_min: spec.vehicle_age_min ?? null,
        vehicle_age_max: spec.vehicle_age_max ?? null,
        seating_capacity_min: spec.seating_capacity_min ?? null,
        addon: spec.addon || null,
        rate_type: spec.rate_type,
        rate_value: v,
        is_declined: false,
        remarks: `${state}${circle ? ' / ' + circle : ''}`,
      });
      mainCount++;
      // Dual-emit: same value applied to a sister rate_type
      // (Tractor C57 "Non New & SATP" / 2W C82-84 "Comp & SAOD")
      if (spec.dual_emit) {
        await insertRateRule(pool, {
          rate_card_id: cardA, insurer: INSURER_SLUG, product: spec.product,
          sheet_name: 'A&B Cat Broker_Apr26', region, segment: spec.segment,
          make: spec.make || 'All', sub_type: extractCity(state) || null,
          fuel_type: spec.fuel_type || null,
          cc_band_min: spec.cc_band_min ?? null, cc_band_max: spec.cc_band_max ?? null,
          vehicle_age_min: spec.vehicle_age_min ?? null, vehicle_age_max: spec.vehicle_age_max ?? null,
          seating_capacity_min: spec.seating_capacity_min ?? null,
          addon: spec.addon || null,
          rate_type: spec.dual_emit,
          rate_value: v, is_declined: false,
          remarks: `${state}${circle ? ' / ' + circle : ''}`,
        });
        mainCount++;
      }
    }
  }
  console.log(`  ✓ ${mainCount} rules from main rate sheet`);

  // ── Declined footnotes ────────────────────────────────────────────────
  // Insert is_declined=true rows so the recovery block can emit the
  // "Declined by SBI" diagnostic instead of "No matching rule".
  for (const decl of DECLINED) {
    for (const stateCode of decl.states) {
      await insertRateRule(pool, {
        rate_card_id: cardA, insurer: INSURER_SLUG, product: 'GCV',
        sheet_name: 'A&B Cat Broker_Apr26',
        region: stateCode,                    // RTO state prefix (matched via rtoStatePrefix)
        segment: decl.segment,
        make: 'All',
        rate_type: 'COMP', rate_value: null, is_declined: true,
        remarks: decl.note,
      });
      declinedCount++;
    }
  }
  console.log(`  ✓ ${declinedCount} declined rows for footnote-listed (segment, state) combos`);

  // ── Sheet 1: PVT car SATP-Apr26 ──────────────────────────────────────
  const satp = XLSX.utils.sheet_to_json(wb.Sheets['PVT car SATP-Apr26'], {
    header: 1, defval: '', blankrows: false,
  });
  let satpCount = 0;
  // Headers: R0 = fuel groups, R1 = column headers (State, Cluster, ...).
  // Data: R2 onwards.
  for (let r = 2; r < satp.length; r++) {
    const row = satp[r];
    if (!row) continue;
    const stateName  = cellOrNull(row[0]);
    const clusterNm  = cellOrNull(row[1]);
    if (!stateName && !clusterNm) continue;
    for (const spec of PVT_SATP_COLS) {
      const v = parseRate(row[spec.col]);
      if (v == null) continue;  // blank → skip; keep is_declined=true for explicit zero
      const isDeclined = v === 0; // zero in this sheet means "declined" per SBI convention
      await insertRateRule(pool, {
        rate_card_id: cardA, insurer: INSURER_SLUG, product: 'CAR',
        sheet_name: 'PVT car SATP-Apr26',
        region: clusterNm,                    // RTO Cluster Name from the sheet
        segment: 'Pvt Car SATP',
        make: 'All',
        sub_type: stateName,                  // state for additional matching context
        fuel_type: spec.fuel_type,
        cc_band_min: spec.cc_band_min, cc_band_max: spec.cc_band_max,
        rate_type: 'SATP',
        rate_value: isDeclined ? null : v,
        is_declined: isDeclined,
        remarks: stateName,
      });
      satpCount++;
    }
  }
  console.log(`  ✓ ${satpCount} rules from PVT car SATP sheet`);

  // ── RTO Mappings ──────────────────────────────────────────────────────
  // Sheet 2 of the rate file (1442 rows, dated 2 Apr) → tied to cardA
  const oldRtos = XLSX.utils.sheet_to_json(wb.Sheets['Cluster Master'], {
    header: 1, defval: '', blankrows: false,
  });
  let oldRtoCount = 0;
  for (let r = 1; r < oldRtos.length; r++) {
    const [statePrefix, location, rtoCode, clusterName] = oldRtos[r] || [];
    if (!rtoCode || !clusterName) continue;
    await insertRtoMapping(pool, {
      rate_card_id: cardA, insurer: INSURER_SLUG,
      product: null,                          // SBI cluster master is product-agnostic
      rto_code: String(rtoCode).trim().toUpperCase(),
      region: extractCity(clusterName) || clusterName,
      cluster: String(clusterName).trim(),
    });
    oldRtoCount++;
  }
  console.log(`  ✓ ${oldRtoCount} RTO mappings from rate-file Cluster Master (effective 2 Apr → 27 Apr)`);

  // RTO Master file (1988 rows, dated 27 Apr) → tied to cardB (newer)
  const newRtoWb = XLSX.readFile(RTO_FILE);
  const newRtos = XLSX.utils.sheet_to_json(
    newRtoWb.Sheets[newRtoWb.SheetNames[0]],
    { header: 1, defval: '', blankrows: false }
  );
  let newRtoCount = 0;
  for (let r = 1; r < newRtos.length; r++) {
    const [statePrefix, location, rtoCode, clusterName] = newRtos[r] || [];
    if (!rtoCode || !clusterName) continue;
    await insertRtoMapping(pool, {
      rate_card_id: cardB, insurer: INSURER_SLUG, product: null,
      rto_code: String(rtoCode).trim().toUpperCase(),
      region: extractCity(clusterName) || clusterName,
      cluster: String(clusterName).trim(),
    });
    newRtoCount++;
  }
  console.log(`  ✓ ${newRtoCount} RTO mappings from RTO Master file (effective 27 Apr → open)`);

  console.log(`\n✅  Done. Summary:
   rate_cards inserted     : 2  (#${cardA}, #${cardB})
   rate_rules main         : ${mainCount}
   rate_rules declined     : ${declinedCount}
   rate_rules SATP         : ${satpCount}
   rto_mappings (old, 2Apr): ${oldRtoCount}
   rto_mappings (new, 27Apr): ${newRtoCount}
   Total rules in DB       : ${mainCount + declinedCount + satpCount}
`);
  await sql.close();
  process.exit(0);
}

// ── Insert helpers ──────────────────────────────────────────────────────

async function insertRateCard(pool, { insurer, file_name, effective_from, effective_to }) {
  const r = await pool.request()
    .input('ins', sql.VarChar(100), insurer)
    .input('fn',  sql.VarChar(500), file_name)
    .input('ef',  sql.Date, effective_from)
    .input('et',  sql.Date, effective_to)
    .query(`INSERT INTO rate_cards (insurer, file_name, effective_from, effective_to)
            OUTPUT INSERTED.id
            VALUES (@ins, @fn, @ef, @et)`);
  return r.recordset[0].id;
}

async function insertRateRule(pool, rule) {
  // remarks isn't a real column on rate_rules — rate_text is. Use rate_text
  // for human-readable notes on each rule.
  const r = pool.request();
  r.input('rcid',   sql.Int,            rule.rate_card_id);
  r.input('ins',    sql.VarChar(100),   rule.insurer);
  r.input('prod',   sql.VarChar(100),   rule.product || null);
  r.input('sheet',  sql.VarChar(200),   rule.sheet_name || null);
  r.input('region', sql.VarChar(200),   rule.region || null);
  r.input('seg',    sql.VarChar(300),   rule.segment || null);
  r.input('make',   sql.VarChar(200),   rule.make || null);
  r.input('subtp',  sql.VarChar(100),   rule.sub_type || null);
  r.input('fuel',   sql.VarChar(50),    rule.fuel_type || null);
  r.input('ccmin',  sql.Int,            rule.cc_band_min ?? null);
  r.input('ccmax',  sql.Int,            rule.cc_band_max ?? null);
  r.input('vamin',  sql.Int,            rule.vehicle_age_min ?? null);
  r.input('vamax',  sql.Int,            rule.vehicle_age_max ?? null);
  r.input('smin',   sql.Int,            rule.seating_capacity_min ?? null);
  r.input('smax',   sql.Int,            rule.seating_capacity_max ?? null);
  r.input('addon',  sql.VarChar(50),    rule.addon || null);
  r.input('rt',     sql.VarChar(50),    rule.rate_type);
  r.input('rv',     sql.Decimal(10, 4), rule.rate_value);
  r.input('decl',   sql.Bit,            rule.is_declined ? 1 : 0);
  r.input('rtxt',   sql.VarChar(500),   rule.remarks || null);
  await r.query(`INSERT INTO rate_rules
    (rate_card_id, insurer, product, sheet_name, region, segment, make, sub_type, fuel_type,
     cc_band_min, cc_band_max, vehicle_age_min, vehicle_age_max,
     seating_capacity_min, seating_capacity_max, addon,
     rate_type, rate_value, is_declined, rate_text)
    VALUES
    (@rcid, @ins, @prod, @sheet, @region, @seg, @make, @subtp, @fuel,
     @ccmin, @ccmax, @vamin, @vamax,
     @smin, @smax, @addon,
     @rt, @rv, @decl, @rtxt)`);
}

async function insertRtoMapping(pool, m) {
  await pool.request()
    .input('rcid',  sql.Int,         m.rate_card_id)
    .input('ins',   sql.VarChar(100),m.insurer)
    .input('prod',  sql.VarChar(100),m.product)
    .input('rto',   sql.VarChar(20), m.rto_code)
    .input('region',sql.VarChar(200),m.region)
    .input('clstr', sql.VarChar(200),m.cluster)
    .query(`INSERT INTO rto_mappings (rate_card_id, insurer, product, rto_code, region, cluster)
            VALUES (@rcid, @ins, @prod, @rto, @region, @clstr)`);
}

main().catch(err => { console.error('✗ Extraction failed:', err); process.exit(1); });
