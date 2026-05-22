/**
 * Reliance General Insurance grid engine.
 *
 * One engine with per-sheet dispatch handles four rate sheets from the
 * monthly workbook:
 *
 *   1. April CV26          — main CV grid (50+ rate columns covering
 *                            PCV 3W, School Bus, PCV Taxi variants,
 *                            GCV 2.5K-50K+, GCV 3W, Car Carrier, Flat
 *                            Bed, MISD-CPM, Tractor, Employee Pickup)
 *   2. April-Short Term PCV Taxi — short-term PCV Taxi NND/ND ×
 *                            (Petrol+CNG+Battery / Diesel)
 *   3. April TW26          — TW grid Fresh(1+5)/Fresh(5+5)/COMP/SAOD/STP
 *                            with EV / Yamaha-HMC / Kerala / NE / Kolhapur
 *                            etc. carve-outs
 *   4. April PVT COM       — Pvt Car Petrol-Bifuel / Diesel-EV / SAOD /
 *                            STP, with <1000cc / ZD / EW / Addon-Bundle
 *                            adjustments
 *
 * Skipped sheets: Enabler & Volume Slab, Winter Bonanza (separate
 * contest tasks), PVT car Group / Segment / Obsolete Models Declined
 * (reference masters used at calc time, not at extract time).
 *
 * Conventions:
 *   - region        ← city or cluster name from col 3 (RTO Region)
 *   - sub_type      ← cluster name from col 2 (RTO Region) when ≠ region
 *   - carrier_type  ← Reliance zone (West/South/North/East)
 *   - rate_text     ← human audit trail (zone | cluster | city | row)
 *   - volume_tier   ← discount band when sliding pricing applies
 *                     (currently none for Reliance — Reliance prints
 *                     base rates, hygiene rules apply post-payout)
 */

const { irdaRateFor } = require('../utils/irda-rates');

// ---------- Helpers ----------
function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseRate(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  // Numbers > 1 are percentages (e.g. 32.5 = 32.5%); ≤1 are already
  // decimal fractions (0.225 = 22.5%).  Reliance mixes both styles in
  // the same sheet — some cells like 37.5 / 32.5 / 30 / 21.3 appear
  // as raw percent numbers while neighbours are 0.425 / 0.275 etc.
  return n > 1 ? n / 100 : n;
}

/** Add a percentage-point delta to a base rate (both as decimals). */
function adjustRate(base, deltaPct) {
  if (base == null) return null;
  return Math.max(0, +(base + deltaPct / 100).toFixed(6));
}

/** Set a flat percentage rate (used for EV-make / EW / Kolhapur-style flat overrides). */
function flatRate(pct) {
  return +(pct / 100).toFixed(6);
}

// ---------- Reliance zone label canonicalizer ----------
const ZONES = new Set(['West', 'South', 'North', 'East', 'WEST', 'SOUTH', 'NORTH', 'EAST']);

function normZone(s) {
  const t = String(s || '').trim().toLowerCase();
  if (t === 'west')  return 'West';
  if (t === 'south') return 'South';
  if (t === 'north') return 'North';
  if (t === 'east')  return 'East';
  return null;
}

// ---------- Reliance city / cluster → canonical state ----------
//
// The CV / Short-Term / TW / Pvt Car sheets use "RTO Region" cells that
// mix three kinds of values: state names ("MADHYA PRADESH"), city names
// ("AHMEDNAGAR", "VAPI", "AGARTALA"), and Reliance-specific cluster
// shorthand ("ROM" = Rest of Maharashtra, "GUJ 1" = Gujarat cluster 1,
// "UP1" / "UP2" = UP zone splits, "HP AND JAMMU" = HP + JK, "NORTH EAST"
// = NE-states cluster).  This table maps every observed value to its
// canonical UPPERCASE state name so we can:
//   - put STATE  in `remarks` (Royal-style → State col in export)
//   - put CITY   in `region`  (export's City col)
//   - put CLUSTER in `sub_type` when distinct from both
const RELIANCE_STATE_LOOKUP = {
  // Maharashtra
  'MUMBAI': 'MAHARASHTRA', 'PUNE': 'MAHARASHTRA', 'NAGPUR': 'MAHARASHTRA',
  'AHMEDNAGAR': 'MAHARASHTRA', 'AURANGABAD': 'MAHARASHTRA', 'KOLHAPUR': 'MAHARASHTRA',
  'NASHIK': 'MAHARASHTRA', 'SOLAPUR': 'MAHARASHTRA', 'ROM': 'MAHARASHTRA',
  'MAHARASHTRA': 'MAHARASHTRA',
  // Goa
  'GOA': 'GOA',
  // Gujarat
  'AHMEDABAD': 'GUJARAT', 'SURAT': 'GUJARAT', 'VADODARA': 'GUJARAT',
  'GANDHIDHAM': 'GUJARAT', 'JAMNAGAR': 'GUJARAT', 'RAJKOT': 'GUJARAT',
  'VAPI': 'GUJARAT', 'GUJ 1': 'GUJARAT', 'GUJARAT': 'GUJARAT',
  // MP / AP / TS
  'MADHYA PRADESH': 'MADHYA PRADESH',
  'ANDHRA PRADESH': 'ANDHRA PRADESH',
  'HYDERABAD': 'TELANGANA', 'TELANGANA': 'TELANGANA',
  // Karnataka
  'BANGALORE': 'KARNATAKA', 'MANGALORE': 'KARNATAKA', 'MYSORE': 'KARNATAKA',
  'KARNATAKA': 'KARNATAKA',
  // Kerala
  'KERALA': 'KERALA', 'CALICUT': 'KERALA', 'COCHIN': 'KERALA', 'TRIVANDRUM': 'KERALA',
  // Tamil Nadu / Pondi
  'CHENNAI': 'TAMIL NADU', 'COIMBATORE': 'TAMIL NADU', 'TAMILNADU': 'TAMIL NADU',
  'ERODE': 'TAMIL NADU', 'MADURAI': 'TAMIL NADU',
  'PONDICHERRY': 'PUDUCHERRY',
  // North
  'DELHI': 'DELHI',
  'CHANDIGARH': 'CHANDIGARH',
  'HP AND JAMMU': 'JAMMU & KASHMIR', 'JAMMU': 'JAMMU & KASHMIR',
  'SRINAGAR': 'JAMMU & KASHMIR', 'LADAKH': 'JAMMU & KASHMIR',
  'SHIMLA': 'HIMACHAL PRADESH',
  'PUNJAB': 'PUNJAB', 'AMRITSAR': 'PUNJAB', 'LUDHIANA': 'PUNJAB',
  'HARYANA': 'HARYANA',
  'RAJASTHAN': 'RAJASTHAN', 'JAIPUR': 'RAJASTHAN',
  'UTTARAKHAND': 'UTTARAKHAND', 'DEHRADUN': 'UTTARAKHAND',
  'UP EAST': 'UTTAR PRADESH', 'UP WEST': 'UTTAR PRADESH',
  'LUCKNOW': 'UTTAR PRADESH', 'VARANASI': 'UTTAR PRADESH',
  'UP1': 'UTTAR PRADESH', 'UP2': 'UTTAR PRADESH',
  // East
  'BIHAR': 'BIHAR', 'PATNA': 'BIHAR',
  'JHARKHAND': 'JHARKHAND', 'JAMSHEDPUR': 'JHARKHAND', 'RANCHI': 'JHARKHAND',
  'BHUBANESHWAR': 'ODISHA', 'CUTTACK': 'ODISHA', 'ROURKELA': 'ODISHA',
  'ODISHA': 'ODISHA',
  'CHHATTISGARH': 'CHHATTISGARH',
  'KOLKATA': 'WEST BENGAL', 'SILIGURI': 'WEST BENGAL', 'WEST BENGAL': 'WEST BENGAL',
  'NORTH EAST': 'NORTH EAST',
  'AGARTALA': 'TRIPURA',
  'AIZWAL':   'MIZORAM',
  'GUWAHATI': 'ASSAM',
};

// Cluster vs city: known cluster labels (non-cities) from RTO Region
// col 2.  Used to decide whether col-2 value should land in sub_type
// (cluster) or be discarded (when same as state/city).
const RELIANCE_CLUSTERS = new Set([
  'ROM', 'GUJ 1', 'GUJARAT', 'HP AND JAMMU', 'UP East', 'UP West',
  'NORTH EAST', 'BHUBANESHWAR',
]);

/** Resolve { state, cluster, city } from a (col2, col3) pair. */
function resolveRTORegion(col2, col3) {
  const c2 = String(col2 || '').trim();
  const c3 = String(col3 || '').trim();
  const upC3 = c3.toUpperCase();
  const upC2 = c2.toUpperCase();
  const stateFromC3 = RELIANCE_STATE_LOOKUP[upC3];
  const stateFromC2 = RELIANCE_STATE_LOOKUP[upC2];
  const state = stateFromC3 || stateFromC2 || null;

  // City: col 3 is the more granular value. Treat it as a city unless
  // it's identical to the resolved state (then there's no city — the
  // row is state-level only).
  let city = c3;
  if (!city || city.toUpperCase() === state || RELIANCE_CLUSTERS.has(c3)) city = null;

  // Cluster: col 2, distinct from state and city
  let cluster = c2;
  if (!cluster || cluster.toUpperCase() === state || cluster === c3 || cluster === city) {
    cluster = null;
  }
  return { state, cluster, city };
}

// ---------- April CV26: hardcoded RATE_COLS spec ----------
//
// Reliance's CV grid has a 3-row header (R2 segment family / R3 product
// segment / R4 rate type).  Rather than discover the lattice from the
// headers, we hardcode one entry per (column, rule) pair. The same
// approach SBI uses — keeps the engine readable and avoids fragile
// header inference.
//
// dual_emit / fan-out conventions:
//   - `fuel_split`     : array of fuel types — emit one rule per fuel
//   - `dual_emit_rt`   : sister rate_type emitted alongside the primary
//                        (e.g. col 11 "Diesel COM & STP" → COMP + SATP)
//   - `seating_min/max`: when the column scopes a seating range (PCV
//                        Taxi 7+1 → 7-7 cap; >8st → 8-99)
//   - `make_only`      : only emit for these makes (PCV Taxi 7+1 NND
//                        Maruti/Mahindra/Toyota/KIA/MG)
//
// Note: in the source row 60-76 some Diesel COM & STP cells are
// expressed as raw percent numbers (32.5, 37.5, 30, 21.3). parseRate
// already routes >1 numbers to the /100 branch.
const PETROL_CNG_BATTERY = ['Petrol', 'CNG', 'EV'];
const ALL_FUELS_PCV      = ['Petrol', 'Diesel', 'CNG', 'EV'];

const CV_RATE_COLS = [
  // PCV 3W (Non Diesel)  cols 4-5 — single fuel group, COMP + STP pair
  { col: 4,  segment: 'PCV 3W',           sub_type: 'Non Diesel', fuel_split: PETROL_CNG_BATTERY, rate_type: 'COMP' },
  { col: 5,  segment: 'PCV 3W',           sub_type: 'Non Diesel', fuel_split: PETROL_CNG_BATTERY, rate_type: 'SATP' },

  // School Bus (4 ownership × age variants)  cols 6-9
  { col: 6, segment: 'School Bus', sub_type: '>10 Year, Owned by Individual', vehicle_age_min: 11, vehicle_age_max: 99, rate_type: 'COMP' },
  { col: 7, segment: 'School Bus', sub_type: '>10 Year, Owned by School',     vehicle_age_min: 11, vehicle_age_max: 99, rate_type: 'COMP' },
  { col: 8, segment: 'School Bus', sub_type: '<10 Year, Owned by Individual', vehicle_age_min: 0,  vehicle_age_max: 10, rate_type: 'COMP' },
  { col: 9, segment: 'School Bus', sub_type: '<10 Year, Owned by School',     vehicle_age_min: 0,  vehicle_age_max: 10, rate_type: 'COMP' },

  // PCV TAXI  NND <6ST (cols 10-12) — three sub-types
  // Col 10: Comp Other (Petrol+CNG+Battery) NND     → fuel split, COMP, NoNilDep
  // Col 11: Diesel COM & STP                         → Diesel, both COMP + SATP
  // Col 12: STP Other (Petrol+CNG+Battery)           → fuel split, SATP, NoNilDep
  { col: 10, segment: 'PCV Taxi <6 St', fuel_split: PETROL_CNG_BATTERY, seating_capacity_max: 6,
    rate_type: 'COMP_NoNilDep' },
  { col: 11, segment: 'PCV Taxi <6 St', fuel_type: 'Diesel', seating_capacity_max: 6,
    rate_type: 'COMP_NoNilDep', dual_emit_rt: 'SATP' },
  { col: 12, segment: 'PCV Taxi <6 St', fuel_split: PETROL_CNG_BATTERY, seating_capacity_max: 6,
    rate_type: 'SATP' },

  // Col 13: PCV Taxi <6 ST ND COM (Petrol+CNG+Battery)   → with NilDep, fuel split, COMP
  { col: 13, segment: 'PCV Taxi <6 St', fuel_split: PETROL_CNG_BATTERY, seating_capacity_max: 6,
    rate_type: 'COMP_NilDep' },

  // Col 14: PCV Taxi 7+1 ST ND COM and STP (no fuel split — all fuels apply)
  { col: 14, segment: 'PCV Taxi 7+1', seating_capacity_min: 7, seating_capacity_max: 7,
    fuel_split: ALL_FUELS_PCV, rate_type: 'COMP_NilDep', dual_emit_rt: 'SATP' },

  // Cols 15-16: PCV Taxi 7+1 (Only NND) — Maruti/Mahindra/Toyota/KIA/MG, all fuels
  { col: 15, segment: 'PCV Taxi 7+1', seating_capacity_min: 7, seating_capacity_max: 7,
    fuel_split: ALL_FUELS_PCV, rate_type: 'COMP_NoNilDep',
    make_only: ['Maruti', 'Mahindra', 'Toyota', 'KIA', 'MG'] },
  { col: 16, segment: 'PCV Taxi 7+1', seating_capacity_min: 7, seating_capacity_max: 7,
    fuel_split: ALL_FUELS_PCV, rate_type: 'SATP',
    make_only: ['Maruti', 'Mahindra', 'Toyota', 'KIA', 'MG'] },

  // Cols 17-18: PCV Taxi other Bus >8 St & PCV 7+1 other Make (NND)
  { col: 17, segment: 'PCV Taxi >8 St / 7+1 Other Make', seating_capacity_min: 8, fuel_split: ALL_FUELS_PCV,
    rate_type: 'COMP_NoNilDep' },
  { col: 18, segment: 'PCV Taxi >8 St / 7+1 Other Make', seating_capacity_min: 8, fuel_split: ALL_FUELS_PCV,
    rate_type: 'SATP' },

  // Col 19: PCV Taxi Kaali Peeli — single rate covers Comp + SATP
  { col: 19, segment: 'PCV Taxi Kaali Peeli',
    rate_type: 'COMP', dual_emit_rt: 'SATP' },

  // Col 20-21: GCV TATA / Maruti < 2T
  { col: 20, segment: 'GCV', sub_type: '<2T', make_only: ['TATA', 'Maruti Suzuki'], weight_band_min: 0, weight_band_max: 2,    rate_type: 'COMP' },
  { col: 21, segment: 'GCV', sub_type: '<2T', make_only: ['TATA', 'Maruti Suzuki'], weight_band_min: 0, weight_band_max: 2,    rate_type: 'SATP' },

  // Col 22-23: header reads "Other (Mahindra & AL-Below 2.5K) TATA Maruti
  // 2K-2.5K)" — one cell value covers TWO make×weight combinations:
  //   1. Mahindra / Ashok Leyland → weight 0-2.5T  (Below 2.5K)
  //   2. TATA / Maruti Suzuki     → weight 2-2.5T
  // Each cell fans out to 2 rules per make group via make_only.
  { col: 22, segment: 'GCV', weight_band_min: 0, weight_band_max: 2.5, make_only: ['Mahindra', 'Ashok Leyland'], rate_type: 'COMP' },
  { col: 22, segment: 'GCV', weight_band_min: 2, weight_band_max: 2.5, make_only: ['TATA', 'Maruti Suzuki'],     rate_type: 'COMP' },
  { col: 23, segment: 'GCV', weight_band_min: 0, weight_band_max: 2.5, make_only: ['Mahindra', 'Ashok Leyland'], rate_type: 'SATP' },
  { col: 23, segment: 'GCV', weight_band_min: 2, weight_band_max: 2.5, make_only: ['TATA', 'Maruti Suzuki'],     rate_type: 'SATP' },

  // Cols 24-29: GCV weight bands 2.5-3.5K / 3.5-7.5K / 7.5-12K
  { col: 24, segment: 'GCV', weight_band_min: 2.5, weight_band_max: 3.5, rate_type: 'COMP' },
  { col: 25, segment: 'GCV', weight_band_min: 2.5, weight_band_max: 3.5, rate_type: 'SATP' },
  { col: 26, segment: 'GCV', weight_band_min: 3.5, weight_band_max: 7.5, rate_type: 'COMP' },
  { col: 27, segment: 'GCV', weight_band_min: 3.5, weight_band_max: 7.5, rate_type: 'SATP' },
  { col: 28, segment: 'GCV', weight_band_min: 7.5, weight_band_max: 12,  rate_type: 'COMP' },
  { col: 29, segment: 'GCV', weight_band_min: 7.5, weight_band_max: 12,  rate_type: 'SATP' },

  // Cols 30-32: GCV 12K-20K — UPTO 5 yr / STP / Above 5 yr
  { col: 30, segment: 'GCV', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'COMP' },
  { col: 31, segment: 'GCV', weight_band_min: 12, weight_band_max: 20, rate_type: 'SATP' },
  { col: 32, segment: 'GCV', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' },

  // Cols 33-35: GCV 20-40K — TATA/AL/Eicher COMP, STP all makes
  { col: 33, segment: 'GCV', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'COMP', make_only: ['TATA', 'Ashok Leyland', 'Eicher'] },
  { col: 34, segment: 'GCV', weight_band_min: 20, weight_band_max: 40, rate_type: 'SATP' },
  { col: 35, segment: 'GCV', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP', make_only: ['TATA', 'Ashok Leyland', 'Eicher'] },

  // Cols 36-37: GCV >40K-50K
  { col: 36, segment: 'GCV', weight_band_min: 40, weight_band_max: 50, rate_type: 'COMP', make_only: ['TATA', 'Ashok Leyland', 'Eicher'] },
  { col: 37, segment: 'GCV', weight_band_min: 40, weight_band_max: 50, rate_type: 'SATP' },

  // Cols 38-39: GCV >50K
  { col: 38, segment: 'GCV', weight_band_min: 50, weight_band_max: 999, rate_type: 'COMP', make_only: ['TATA', 'Ashok Leyland', 'Eicher'] },
  { col: 39, segment: 'GCV', weight_band_min: 50, weight_band_max: 999, rate_type: 'SATP' },

  // Cols 40-43: GCV 3W (Non Electric / Electric)
  { col: 40, segment: 'GCV 3W', sub_type: 'Non Electric', fuel_split: ['Petrol', 'CNG', 'Diesel'], rate_type: 'COMP' },
  { col: 41, segment: 'GCV 3W', sub_type: 'Non Electric', fuel_split: ['Petrol', 'CNG', 'Diesel'], rate_type: 'SATP' },
  { col: 42, segment: 'GCV 3W', sub_type: 'Electric',     fuel_type: 'EV', rate_type: 'COMP' },
  { col: 43, segment: 'GCV 3W', sub_type: 'Electric',     fuel_type: 'EV', rate_type: 'SATP' },

  // Col 44: Car Carrier — single rate covers COMP + SATP
  { col: 44, segment: 'GCV Car Carrier', rate_type: 'COMP', dual_emit_rt: 'SATP' },

  // Cols 45-46: Flat Bed COMP + STP
  { col: 45, segment: 'GCV Flat Bed', rate_type: 'COMP' },
  { col: 46, segment: 'GCV Flat Bed', rate_type: 'SATP' },

  // Cols 47-48: MISD CPM (JCB / L&T / Caterpillar)
  // Sub-class lives in segment as "Misc-D | <class>" so the export's
  // inferVehicleCategory lifts it to the VehicleCategory column.
  { col: 47, segment: 'Misc-D | JCB / L&T / Caterpillar', rate_type: 'COMP' },
  { col: 48, segment: 'Misc-D | JCB / L&T / Caterpillar', rate_type: 'SATP' },

  // Cols 49-52: Tractor (Agricultural without Trailer)
  //   Col 49: Comp (Fresh)              — vehicle_age 0-0
  //   Col 50: Comp (Non-fresh) <5 Years — vehicle_age 1-5
  //   Col 51: Comp (Non-fresh) >5 Years — vehicle_age 6-99
  //   Col 52: STP                       — all ages
  // Per user direction: VehicleCategory = "Tractor" (segment stays plain
  // "Tractor", no sub-class pipe).  The "Agricultural without Trailer"
  // detail lives in sub_type → Sub Modal column.
  { col: 49, segment: 'Tractor', sub_type: 'Agricultural without Trailer', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' },
  { col: 50, segment: 'Tractor', sub_type: 'Agricultural without Trailer', vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' },
  { col: 51, segment: 'Tractor', sub_type: 'Agricultural without Trailer', vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' },
  { col: 52, segment: 'Tractor', sub_type: 'Agricultural without Trailer', rate_type: 'SATP' },

  // Cols 53-54: Employee Pickup
  { col: 53, segment: 'PCV Employee Pickup', rate_type: 'COMP' },
  { col: 54, segment: 'PCV Employee Pickup', rate_type: 'SATP' },
];

// ---------- April CV26 parser ----------
function parseCV(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row ?? 5;

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const zone   = normZone(row[1]);
    const c2     = cellOrNull(row[2]);
    const c3     = cellOrNull(row[3]);
    if (!zone || !c2 || !c3) continue;
    const loc = resolveRTORegion(c2, c3);
    if (!loc.state) continue;     // skip rows whose RTO Region we don't recognize

    for (const spec of CV_RATE_COLS) {
      const v = parseRate(row[spec.col]);
      if (v == null) continue;
      const isDeclined = v === 0;
      const fuels = spec.fuel_split || [spec.fuel_type || null];
      const makes = spec.make_only || [spec.make || 'All'];

      for (const fuel of fuels) {
        for (const make of makes) {
          const baseRule = {
            product:  inferProduct(spec),
            sheet_name: meta.sheetName,
            // Royal-style state-CV layout: state in remarks, city in
            // region, vehicle sub-class in sub_type.  Export's State/
            // City/Zone cols will resolve via existing detection.
            // Priority: spec.sub_type (vehicle sub-class — semantic)
            // wins over loc.cluster (geographic — already conveyed by
            // region/remarks).  Fall back to cluster only when the spec
            // doesn't supply a sub-class.
            region:   loc.city || loc.state,
            sub_type: spec.sub_type || loc.cluster || null,
            segment:  spec.segment,
            make,
            fuel_type: fuel,
            cc_band_min: spec.cc_band_min ?? null,
            cc_band_max: spec.cc_band_max ?? null,
            weight_band_min: spec.weight_band_min ?? null,
            weight_band_max: spec.weight_band_max ?? null,
            vehicle_age_min: spec.vehicle_age_min ?? null,
            vehicle_age_max: spec.vehicle_age_max ?? null,
            seating_capacity_min: spec.seating_capacity_min ?? null,
            seating_capacity_max: spec.seating_capacity_max ?? null,
            carrier_type: zone,                                  // Zone col
            remarks:  loc.state,                                 // State col (Royal-style)
            rate_type: spec.rate_type,
            rate_value: isDeclined ? null : v,
            is_declined: isDeclined,
            rate_text: `${zone} | ${c2} | ${c3}`,
          };
          rules.push(baseRule);
          if (spec.dual_emit_rt) {
            rules.push({ ...baseRule, rate_type: spec.dual_emit_rt });
          }
        }
      }
    }
  }
  return rules;
}

function inferProduct(spec) {
  const seg = String(spec.segment || '').toLowerCase();
  if (seg.includes('school bus') || seg.includes('pcv'))   return 'PCV';
  if (seg.includes('tractor'))                              return 'MISC';
  if (seg.includes('misc-d'))                               return 'MISC';
  if (seg.includes('gcv'))                                  return 'GCV';
  if (seg.includes('flat bed') || seg.includes('carrier'))  return 'GCV';
  return 'GCV';
}

// ---------- April-Short Term PCV Taxi ----------
//
// Layout: Zone | RTO Region | RTO Region | NND header (cols 3,4) | ND header (cols 5,6)
// Cols 3-6:
//   3: Short Term COM Other (Petrol+CNG+Battery) NND
//   4: Short Term Other (Diesel) — NND
//   5: Short Term COM Other (Petrol+CNG+Battery) ND
//   6: Short Term Other (Diesel) — ND
//
// Each rule is a Short-Term PCV Taxi COMP rule.  OD/TP tenure < 1 year
// (handled by the export's existing "Short Term" sheet detection →
// OD_Tenure 0.1 / TP_Tenure 0.11).
const PCV_SHORT_COLS = [
  { col: 4, fuel_split: PETROL_CNG_BATTERY, rate_type: 'COMP_NoNilDep' },
  { col: 5, fuel_type: 'Diesel',            rate_type: 'COMP_NoNilDep' },
  { col: 6, fuel_split: PETROL_CNG_BATTERY, rate_type: 'COMP_NilDep'   },
  { col: 7, fuel_type: 'Diesel',            rate_type: 'COMP_NilDep'   },
];

function parsePCVShort(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row ?? 4;
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const zone = normZone(row[1]);
    const c2   = cellOrNull(row[2]);
    const c3   = cellOrNull(row[3]);
    if (!zone || !c2 || !c3) continue;
    const loc = resolveRTORegion(c2, c3);
    if (!loc.state) continue;

    for (const spec of PCV_SHORT_COLS) {
      const v = parseRate(row[spec.col]);
      if (v == null) continue;
      const isDeclined = v === 0;
      const fuels = spec.fuel_split || [spec.fuel_type];
      for (const fuel of fuels) {
        rules.push({
          product:  'PCV',
          sheet_name: meta.sheetName,
          region:   loc.city || loc.state,
          sub_type: loc.cluster || null,
          segment:  'PCV Taxi Short Term',
          make:     'All',
          fuel_type: fuel,
          carrier_type: zone,
          remarks:  loc.state,
          rate_type: spec.rate_type,
          rate_value: isDeclined ? null : v,
          is_declined: isDeclined,
          rate_text: `${zone} | ${c2} | ${c3} | Short Term`,
        });
      }
    }
  }
  return rules;
}

// ---------- April TW26 ----------
//
// Layout (R3 header):
//   col 0: ZONE  | col 1: States | col 2: Fresh(1+5) | col 3: Fresh(5+5)
//   col 4: COMP | col 5: SAOD | col 6: STP
//
// Rate-row labels (col 1): "Mumbai.Pune", "MH,GA", "GJ", "MP", "TN", "KA",
//   "AP,TS", "KL", "DL,PB,HP,JK", "UP,UK", "RJ and HR", "BH,JH,WB",
//   "OD,CG", "NE"  (last two and KL are zero/declined per notes).
//
// Notes-driven rule fan-outs:
//   • EV makes flat 25%   (Fresh 1+5 and 5+5 only)
//   • Yamaha + HMC: above grid −2.5%   (Fresh 1+5 and 5+5)
//   • Kerala (all RTO) + North East (all RTO): zeroed out
//   • Kolhapur, Mysore, Mangalore, WB (excluding Kolkata): flat 20%
//     (Fresh 1+5 and 5+5)
//   • Bike COM (1+1, 1+5, 5+5) and STP NOT covered by Fresh grid
//   • LT 1+5 / 5+5 paid 50% year 1 + 50% year 2
// Column indices reflect the actual sheet layout (col 0 is blank,
// col 1 = zone, col 2 = states label, col 3-7 = rates).
//
// Fresh(1+5) and Fresh(5+5) encode new-vehicle long-term tenure:
//   • Fresh(1+5) → new vehicle (age 0), OD tenure 1 year, TP tenure 5
//   • Fresh(5+5) → new vehicle (age 0), OD tenure 5 years, TP tenure 5
// Tenure pattern lives in rate_type ("COMP_1+5") so the export's
// inferTenure regex (\d)\+(\d) lifts od/tp into OD_Tenure / TP_Tenure.
const TW_RATE_COLS = [
  { col: 3, segment: 'TW Scooter', rate_type: 'COMP_1+5',
    vehicle_age_min: 0, vehicle_age_max: 0, fresh: true },
  { col: 4, segment: 'TW Scooter', rate_type: 'COMP_5+5',
    vehicle_age_min: 0, vehicle_age_max: 0, fresh: true },
  { col: 5, segment: 'TW',         rate_type: 'COMP' },
  { col: 6, segment: 'TW',         rate_type: 'SAOD' },
  { col: 7, segment: 'TW',         rate_type: 'SATP' },
];

const TW_STATE_RULES = [
  // [label-from-sheet, list-of-canonical-states]
  { label: 'Mumbai.Pune',   states: ['MAHARASHTRA'], cluster: 'Mumbai/Pune', isCity: true },
  { label: 'MH,GA',         states: ['MAHARASHTRA','GOA'] },
  { label: 'GJ',            states: ['GUJARAT'] },
  { label: 'MP',            states: ['MADHYA PRADESH'] },
  { label: 'TN',            states: ['TAMIL NADU'] },
  { label: 'KA',            states: ['KARNATAKA'] },
  { label: 'AP,TS',         states: ['ANDHRA PRADESH','TELANGANA'] },
  { label: 'KL',            states: ['KERALA'] },
  { label: 'DL,PB,HP,JK',   states: ['DELHI','PUNJAB','HIMACHAL PRADESH','JAMMU & KASHMIR'] },
  { label: 'UP,UK',         states: ['UTTAR PRADESH','UTTARAKHAND'] },
  { label: 'RJ and HR',     states: ['RAJASTHAN','HARYANA'] },
  { label: 'BH,JH,WB',      states: ['BIHAR','JHARKHAND','WEST BENGAL'] },
  { label: 'OD,CG',         states: ['ODISHA','CHHATTISGARH'] },
  { label: 'NE',            states: ['ARUNACHAL PRADESH','ASSAM','MANIPUR','MEGHALAYA','MIZORAM','NAGALAND','SIKKIM','TRIPURA'] },
];

// Cities that get the flat 20% override on TW Fresh grids
const TW_FLAT_20_CITIES = ['Kolhapur', 'Mysore', 'Mangalore'];

// EV makes that get flat 25%
const TW_EV_MAKES = ['Ola', 'Ather', 'TVS iQube', 'Bajaj Chetak', 'Hero Vida', 'Ultraviolette', 'Okinawa'];

function parseTW(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row ?? 4;

  // Track current zone (zone label only appears on the row that
  // introduces a new zone block; subsequent rows in the same zone leave
  // col 0 blank).
  let currentZone = null;

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const z = normZone(row[1]);
    if (z) currentZone = z;
    const label = cellOrNull(row[2]);
    if (!label) continue;
    if (/^term\s*condition|grid not|payout will|tw scooter|tw contest/i.test(label)) break;

    const stateGroup = TW_STATE_RULES.find(g => g.label === label);
    if (!stateGroup) continue;

    for (const spec of TW_RATE_COLS) {
      const v = parseRate(row[spec.col]);
      if (v == null) continue;
      const isDeclined = v === 0;

      for (const state of stateGroup.states) {
        const baseRule = {
          product:  'TW',
          sheet_name: meta.sheetName,
          region:   stateGroup.isCity ? stateGroup.cluster : state,
          sub_type: stateGroup.isCity ? state : null,
          segment:  spec.segment,
          make:     'All',
          vehicle_age_min: spec.vehicle_age_min ?? null,
          vehicle_age_max: spec.vehicle_age_max ?? null,
          rate_type: spec.rate_type,
          rate_value: isDeclined ? null : v,
          is_declined: isDeclined,
          carrier_type: currentZone,
          remarks:  state,                                 // State col → state
          rate_text: `${currentZone || '?'} | ${state} | ${label}` +
                     (spec.fresh ? ' | Fresh, paid 50% Y1 + 50% Y2' : ''),
        };
        rules.push(baseRule);

        // Notes fan-out — Fresh grids (cols 3,4) only
        if (!isDeclined && spec.fresh) {
          // Yamaha & HMC: −2.5%
          for (const m of ['Yamaha', 'Hero MotoCorp']) {
            rules.push({
              ...baseRule, make: m,
              rate_value: adjustRate(v, -2.5),
              rate_text: baseRule.rate_text + ` | ${m} −2.5%`,
            });
          }
          // EV makes: flat 25% (overrides grid completely)
          for (const m of TW_EV_MAKES) {
            rules.push({
              ...baseRule, make: m, fuel_type: 'EV',
              rate_value: flatRate(25),
              rate_text: baseRule.rate_text + ` | ${m} EV flat 25%`,
            });
          }
        }
      }

      // City carve-outs (Kolhapur / Mysore / Mangalore / WB excl Kolkata)
      // — flat 20% on Fresh grids only.  Emitted once per spec/city.
      if (!isDeclined && spec.fresh) {
        const FLAT_20 = [
          { city: 'Kolhapur',  state: 'MAHARASHTRA' },
          { city: 'Mysore',    state: 'KARNATAKA' },
          { city: 'Mangalore', state: 'KARNATAKA' },
          { city: 'Rest of WB (excl Kolkata)', state: 'WEST BENGAL' },
        ];
        for (const c of FLAT_20) {
          rules.push({
            product:  'TW',
            sheet_name: meta.sheetName,
            region:   c.city,
            sub_type: null,
            segment:  spec.segment,
            make:     'All',
            vehicle_age_min: spec.vehicle_age_min ?? null,
            vehicle_age_max: spec.vehicle_age_max ?? null,
            rate_type: spec.rate_type,
            rate_value: flatRate(20),
            is_declined: false,
            carrier_type: currentZone,
            remarks:  c.state,
            rate_text: `${c.city} | flat 20% (TW Fresh carve-out)`,
          });
        }
      }
    }
  }
  return rules;
}

// ---------- April PVT COM ----------
//
// Layout (R2 header):
//   col 0: ZONE | col 1: RTO Region | col 2: Petrol/Bifuel COM
//   col 3: Diesel/EV COM | col 4: SAOD | col 5: STP
//
// Notes-driven fan-outs (per cell):
//   1. Base rate as printed (paid on OD premium)
//   2. <1000cc:    rate − 5%   (cc_band_max=999 variant)
//   3. ZD policy:  rate − 2.5% (rate_type=COMP_NilDep variant)
//   4. EW Pvt Car: flat 20%    (separate addon='EW' rule)
//   5. Addon Bundle (Tyre/RTI sourced): rate + 2.5% (addon='Y' variant)
const PVT_RATE_COLS = [
  { col: 2, fuel_split: ['Petrol', 'Bifuel', 'CNG'], rate_type: 'COMP' },
  { col: 3, fuel_split: ['Diesel', 'EV'],            rate_type: 'COMP' },
  { col: 4, rate_type: 'SAOD' },
  { col: 5, rate_type: 'SATP' },
];

const PVT_REGION_RULES = [
  { label: 'MUMBAI/PUNE/GOA',          states: ['MAHARASHTRA','GOA'], cluster: 'Mumbai/Pune/Goa', isCity: true },
  { label: 'REST OF MAHARASTRA',       states: ['MAHARASHTRA'], cluster: 'Rest of Maharashtra', isCity: true },
  { label: 'GUJARAT',                  states: ['GUJARAT'] },
  { label: 'MADYAPRADESH',             states: ['MADHYA PRADESH'] },
  { label: 'Banglore ,Hyderabad',      states: ['KARNATAKA','TELANGANA'], cluster: 'Bangalore/Hyderabad', isCity: true },
  { label: 'Rest of KA,TS,AP',         states: ['KARNATAKA','TELANGANA','ANDHRA PRADESH'], cluster: 'Rest of KA/TS/AP', isCity: true },
  { label: 'Kerala',                   states: ['KERALA'] },
  { label: 'Tamilnadu',                states: ['TAMIL NADU'] },
  { label: 'Delhi',                    states: ['DELHI'] },
  { label: 'Punjab,HP and JK',         states: ['PUNJAB','HIMACHAL PRADESH','JAMMU & KASHMIR'] },
  { label: 'UP ,Haryana,Rajasthan',    states: ['UTTAR PRADESH','HARYANA','RAJASTHAN'] },
  { label: 'NE,Odisha,Chattishgarh',   states: ['ODISHA','CHHATTISGARH','ARUNACHAL PRADESH','ASSAM','MANIPUR','MEGHALAYA','MIZORAM','NAGALAND','SIKKIM','TRIPURA'] },
  { label: 'Bihar,Jharkhand',          states: ['BIHAR','JHARKHAND'] },
  { label: 'Kolkatta',                 states: ['WEST BENGAL'], cluster: 'Kolkata', isCity: true },
  { label: 'West Bengal',              states: ['WEST BENGAL'], cluster: 'Rest of West Bengal', isCity: true },
];

function parsePvtCar(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row ?? 3;

  let currentZone = null;
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const z = normZone(row[0]);
    if (z) currentZone = z;
    const label = cellOrNull(row[1]);
    if (!label) continue;
    if (/^term|^payout|^addon|^standalone|^ew|^insure|^uncure/i.test(label)) break;

    const reg = PVT_REGION_RULES.find(g => g.label.toLowerCase() === label.toLowerCase());
    if (!reg) continue;

    for (const spec of PVT_RATE_COLS) {
      const v = parseRate(row[spec.col]);
      if (v == null) continue;
      const isDeclined = v === 0;
      const fuels = spec.fuel_split || [null];

      for (const state of reg.states) {
        for (const fuel of fuels) {
          const baseRule = {
            product:  'CAR',
            sheet_name: meta.sheetName,
            region:   reg.isCity ? reg.cluster : state,
            sub_type: null,                                  // cluster/city goes in region
            segment:  'Pvt Car',
            make:     'All',
            fuel_type: fuel,
            rate_type: spec.rate_type,
            rate_value: isDeclined ? null : v,
            is_declined: isDeclined,
            carrier_type: currentZone,
            applied_on: 'OD',
            remarks:  state,                                 // State col → state
            rate_text: `${currentZone || '?'} | ${state} | ${reg.label}`,
          };
          rules.push(baseRule);
          if (isDeclined) continue;

          // Note 2: <1000cc — rate − 5%   (separate rule with cc cap)
          rules.push({
            ...baseRule,
            cc_band_max: 999,
            rate_value: adjustRate(v, -5),
            rate_text: baseRule.rate_text + ' | <1000cc −5%',
          });
          // Note 3: Standalone ZD — rate − 2.5%  (NilDep variant; only for COMP rows)
          if (spec.rate_type === 'COMP') {
            rules.push({
              ...baseRule,
              rate_type: 'COMP_NilDep',
              rate_value: adjustRate(v, -2.5),
              rate_text: baseRule.rate_text + ' | Standalone ZD −2.5%',
            });
          }
          // Note 5: Addon Bundle (Tyre/RTI sourced) — rate + 2.5%
          if (spec.rate_type === 'COMP') {
            rules.push({
              ...baseRule,
              addon: 'Y',
              rate_value: adjustRate(v, +2.5),
              rate_text: baseRule.rate_text + ' | Addon Bundle (Tyre/RTI) +2.5%',
            });
          }
        }
      }
    }

    // Note 4: EW Pvt Car flat 20% — emitted once per region (covers the
    // EW addon product). Standalone rule with rate_type='COMP_EW'.
    for (const state of reg.states) {
      rules.push({
        product:  'CAR',
        sheet_name: meta.sheetName,
        region:   reg.isCity ? reg.cluster : state,
        sub_type: null,
        segment:  'Pvt Car EW',
        make:     'All',
        rate_type: 'COMP_EW',
        rate_value: flatRate(20),
        is_declined: false,
        carrier_type: currentZone,
        remarks:  state,
        rate_text: `${currentZone || '?'} | ${state} | Pvt Car EW flat 20% (Extended Warranty addon)`,
      });
    }
  }
  return rules;
}

// ---------- Top-level dispatch ----------
function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind || '';
  switch (kind) {
    case 'cv':         return parseCV(sheetData, sheetConfig, meta);
    case 'pcv_short':  return parsePCVShort(sheetData, sheetConfig, meta);
    case 'tw':         return parseTW(sheetData, sheetConfig, meta);
    case 'pvt_car':    return parsePvtCar(sheetData, sheetConfig, meta);
    default:
      console.warn(`[reliance-grid] unknown sheet_kind "${kind}" for sheet "${meta.sheetName}"`);
      return [];
  }
}

module.exports = { parse };
