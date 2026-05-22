/**
 * SBI grouped-columns parser — handles the main SBI rate sheet
 * "A&B Cat Broker_Apr26".
 *
 * The sheet ships a 4-row header (R0 segment / R1 make sub-bucket /
 * R2 age tier / R3 rate type) over ~80 rate columns, with row keys at
 * (Region | State | Circle).  Rather than try to discover that lattice
 * from the headers, this engine uses a HARDCODED column spec — one
 * entry per (rule, column) pair, pre-computed.
 *
 *   - SBI broker zone (East 1, West 2, …) → output carrier_type
 *     (volume_tier is reserved for the premium-volume slab — see
 *     PREMIUM_SLABS below.  carrier_type is otherwise unused for SBI.)
 *   - State (col 1) → output region (canonical uppercase state name).
 *     City qualifiers ("TAMIL NADU- Chennai", "Kolkata", "Hyderabad")
 *     get pulled into sub_type so a city-specific row beats the
 *     state-level "Rest of …" row at match time.  "(Eastern)/(Central)/
 *     (Rest)" UP-style sub-divisions also land in sub_type.
 *   - Original raw State + Circle text → rate_text for audit.
 *
 * Compound R1 labels are SPLIT into multiple per-column rules so the
 * matcher sees one make per rule:
 *   "Upto 2.0T-All makes & 2.0-2.5T Tata makes"  →  two rules per cell
 *     · weight_band 0..2.0,  make='All'
 *     · weight_band 2.0..2.5,make='TATA'
 *   Same cell value applies to both rules.
 *
 * Special-case behaviours:
 *   - GCV-Upto-2.5T New-Comp / Non New Comp → vehicle_age 0/0 vs 1/99
 *   - R2 age tiers (`Age 1-5 Years`, `Age above 5 years`)→ vehicle_age
 *   - PCV Taxi Nill Dep / Non Nill Dep → addon = Y / N
 *   - Tractor C57 "Non New & SATP" → spec.dual_emit='SATP' so each
 *     cell emits TWO rules (COMP age 1/99 + SATP) sharing the value
 *   - 2W C82-C84 "Comp & SAOD" → spec.dual_emit='SAOD'
 *
 * Declined-RTO footnotes are emitted as `is_declined=true` rows so the
 * bulk pipeline's null-rate recovery surfaces "Declined by SBI" rather
 * than "No matching rule".
 */

const RATE_COLS = (() => {
  const list = [];

  // GCV 4W Upto 2.5T  -----------------------------------------------------
  // Compound R1: "Upto 2.0T-All makes & 2.0-2.5T Tata makes" → split into
  // two rules per cell so the matcher picks by (make + weight band):
  //   sub-rule A → weight 0..2.0T, make='All'   (any make in this band)
  //   sub-rule B → weight 2.0..2.5T, make='TATA' (TATA only in this band)
  // Both share the same cell value (rate_value).
  list.push({ col: 3, product: 'GCV', segment: 'GCV 4W',  make: 'All',  weight_band_min: 0,   weight_band_max: 2.0, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 3, product: 'GCV', segment: 'GCV 4W',  make: 'TATA', weight_band_min: 2.0, weight_band_max: 2.5, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 4, product: 'GCV', segment: 'GCV 4W',  make: 'All',  weight_band_min: 0,   weight_band_max: 2.0, vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 4, product: 'GCV', segment: 'GCV 4W',  make: 'TATA', weight_band_min: 2.0, weight_band_max: 2.5, vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 5, product: 'GCV', segment: 'GCV 4W',  make: 'All',  weight_band_min: 0,   weight_band_max: 2.0, rate_type: 'SATP' });
  list.push({ col: 5, product: 'GCV', segment: 'GCV 4W',  make: 'TATA', weight_band_min: 2.0, weight_band_max: 2.5, rate_type: 'SATP' });
  // Sub: 2.0-2.5T-other than Tata — covers 2.0..2.5T weight band, all
  // makes EXCEPT TATA. Encoded as make='Others' (matcher fallback path).
  list.push({ col: 6, product: 'GCV', segment: 'GCV 4W',  make: 'Others', weight_band_min: 2.0, weight_band_max: 2.5, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 7, product: 'GCV', segment: 'GCV 4W',  make: 'Others', weight_band_min: 2.0, weight_band_max: 2.5, vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 8, product: 'GCV', segment: 'GCV 4W',  make: 'Others', weight_band_min: 2.0, weight_band_max: 2.5, rate_type: 'SATP' });
  // Sub: GCV 3W (R0 mislabels as 4W; R1 is canonical 3W)
  list.push({ col: 9,  product: 'GCV', segment: 'GCV 3W', make: 'All', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 10, product: 'GCV', segment: 'GCV 3W', make: 'All', rate_type: 'COMP' });
  list.push({ col: 11, product: 'GCV', segment: 'GCV 3W', make: 'All', rate_type: 'SATP' });

  // 2.5T-3.5T  ------------------------------------------------------------
  list.push({ col: 12, product: 'GCV',  segment: 'GCV 4W', make: 'MAHINDRA',           weight_band_min: 2.5, weight_band_max: 3.5, rate_type: 'COMP' });
  list.push({ col: 13, product: 'GCV',  segment: 'GCV 4W', make: 'MAHINDRA',           weight_band_min: 2.5, weight_band_max: 3.5, rate_type: 'SATP' });
  list.push({ col: 14, product: 'GCV',  segment: 'GCV 4W', make: 'TATA & Ashok Leyland', weight_band_min: 2.5, weight_band_max: 3.5, rate_type: 'COMP' });
  list.push({ col: 15, product: 'GCV',  segment: 'GCV 4W', make: 'TATA & Ashok Leyland', weight_band_min: 2.5, weight_band_max: 3.5, rate_type: 'SATP' });
  list.push({ col: 16, product: 'MISC', segment: 'GCV Tractor', make: 'All', weight_band_min: 2.5, weight_band_max: 3.5, rate_type: 'COMP' });
  list.push({ col: 17, product: 'MISC', segment: 'GCV Tractor', make: 'All', weight_band_min: 2.5, weight_band_max: 3.5, rate_type: 'SATP' });

  // 3.5T-5.0T  / 5.0T-7.5T / 7.5T-12T  -----------------------------------
  list.push({ col: 18, product: 'GCV', segment: 'GCV 4W', make: 'Excluding Eicher & Mahindra', weight_band_min: 3.5, weight_band_max: 5.0, rate_type: 'COMP' });
  list.push({ col: 19, product: 'GCV', segment: 'GCV 4W', make: 'Excluding Eicher & Mahindra', weight_band_min: 3.5, weight_band_max: 5.0, rate_type: 'SATP' });
  list.push({ col: 20, product: 'GCV', segment: 'GCV 4W', make: 'Excluding Eicher & Mahindra', weight_band_min: 5.0, weight_band_max: 7.5, rate_type: 'COMP' });
  list.push({ col: 21, product: 'GCV', segment: 'GCV 4W', make: 'Excluding Eicher & Mahindra', weight_band_min: 5.0, weight_band_max: 7.5, rate_type: 'SATP' });
  list.push({ col: 22, product: 'GCV', segment: 'GCV 4W', make: 'Excluding Eicher',            weight_band_min: 7.5, weight_band_max: 12,  rate_type: 'COMP' });
  list.push({ col: 23, product: 'GCV', segment: 'GCV 4W', make: 'Excluding Eicher',            weight_band_min: 7.5, weight_band_max: 12,  rate_type: 'SATP' });

  // 12T-20T (Other makes)  ------------------------------------------------
  list.push({ col: 24, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 25, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 26, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 27, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 28, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 29, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // 12T-20T (TATA & Ashok Leyland)
  list.push({ col: 30, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 31, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 32, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 33, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 34, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 35, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 12, weight_band_max: 20, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // 20T-40T (Other makes)
  list.push({ col: 36, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 37, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 38, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 39, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 40, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 41, product: 'GCV', segment: 'GCV', make: 'Other makes', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // 20T-40T (TATA & Ashok Leyland)
  list.push({ col: 42, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 43, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 44, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 45, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 1, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 46, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 47, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 20, weight_band_max: 40, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  // >40T (Other makes / TATA & Ashok Leyland)
  list.push({ col: 48, product: 'GCV', segment: 'GCV', make: 'Other makes',          weight_band_min: 40, weight_band_max: 999, vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 49, product: 'GCV', segment: 'GCV', make: 'Other makes',          weight_band_min: 40, weight_band_max: 999, vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 50, product: 'GCV', segment: 'GCV', make: 'Other makes',          weight_band_min: 40, weight_band_max: 999, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 51, product: 'GCV', segment: 'GCV', make: 'Other makes',          weight_band_min: 40, weight_band_max: 999, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });
  list.push({ col: 52, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 40, weight_band_max: 999, vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'COMP' });
  list.push({ col: 53, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 40, weight_band_max: 999, vehicle_age_min: 0, vehicle_age_max: 5,  rate_type: 'SATP' });
  list.push({ col: 54, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 40, weight_band_max: 999, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 55, product: 'GCV', segment: 'GCV', make: 'TATA & Ashok Leyland', weight_band_min: 40, weight_band_max: 999, vehicle_age_min: 6, vehicle_age_max: 99, rate_type: 'SATP' });

  // Tractor & Harvester (excl. Trailer) — C56 "New", C57 "Non New & SATP"
  // C57 emits one COMP age 1/99 row + a sister SATP row sharing the value.
  list.push({ col: 56, product: 'MISC', segment: 'Agricultural Tractor & Harvester', make: 'All', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 57, product: 'MISC', segment: 'Agricultural Tractor & Harvester', make: 'All', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP', dual_emit: 'SATP' });

  // PCV 3W (3+1) — Non Diesel / Diesel × New / Non New
  list.push({ col: 58, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 59, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 60, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 61, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'SATP' });
  list.push({ col: 62, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel',         vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'COMP' });
  list.push({ col: 63, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel',         vehicle_age_min: 0, vehicle_age_max: 0,  rate_type: 'SATP' });
  list.push({ col: 64, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel',         vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'COMP' });
  list.push({ col: 65, product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel',         vehicle_age_min: 1, vehicle_age_max: 99, rate_type: 'SATP' });

  // PCV Taxi 6+1 — by CC × (Nil-Dep / Non-Nil-Dep / SATP) × (NCB / Non-NCB)
  //
  // Source header: "PCV Taxi (Carrying capacity upto 6+1) with NCB only
  //                 (NON NCB/New Vehicle grid would be lesser by 5%)"
  // Each Comp Nil-Dep / Non-Nil-Dep cell therefore expands into two rules:
  //   • NCB-only       → rate_value = cell, age_band_min=1, age_band_max=99
  //   • Non-NCB / New  → rate_value = cell − 0.05, age_band_min=0, age_band_max=0
  // The `ncb_split: true` flag on the spec triggers this in the engine.
  // Nil-Dep flag is encoded in rate_type suffix (`_NilDep` / `_NoNilDep`)
  // so the Excel export's "Nil Dep" column populates correctly.
  // SATP rates are IRDA-mandated and do NOT vary by NCB — emitted once.
  list.push({ col: 66, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 0,    cc_band_max: 999,   rate_type: 'COMP_NilDep',   ncb_split: true });
  list.push({ col: 67, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 0,    cc_band_max: 999,   rate_type: 'COMP_NoNilDep', ncb_split: true });
  list.push({ col: 68, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 0,    cc_band_max: 999,   rate_type: 'SATP' });
  list.push({ col: 69, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1000, cc_band_max: 1499,  rate_type: 'COMP_NilDep',   ncb_split: true });
  list.push({ col: 70, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1000, cc_band_max: 1499,  rate_type: 'COMP_NoNilDep', ncb_split: true });
  list.push({ col: 71, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1000, cc_band_max: 1499,  rate_type: 'SATP' });
  list.push({ col: 72, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1500, cc_band_max: 99999, rate_type: 'COMP_NilDep',   ncb_split: true });
  list.push({ col: 73, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1500, cc_band_max: 99999, rate_type: 'COMP_NoNilDep', ncb_split: true });
  list.push({ col: 74, product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: 1500, cc_band_max: 99999, rate_type: 'SATP' });
  list.push({ col: 75, product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', rate_type: 'COMP_NilDep',   ncb_split: true });
  list.push({ col: 76, product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', rate_type: 'COMP_NoNilDep', ncb_split: true });
  list.push({ col: 77, product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', rate_type: 'SATP' });

  // School Bus 18+ seater
  list.push({ col: 78, product: 'PCV', segment: 'School Bus', make: 'All', seating_capacity_min: 18, rate_type: 'COMP' });
  list.push({ col: 79, product: 'PCV', segment: 'School Bus', make: 'All', seating_capacity_min: 18, rate_type: 'SATP' });

  // Pvt Car COMP / SAOD (no SATP on this sheet — sheet 1 carries it)
  list.push({ col: 80, product: 'CAR', segment: 'Pvt Car', make: 'All', rate_type: 'COMP' });
  list.push({ col: 81, product: 'CAR', segment: 'Pvt Car', make: 'All', rate_type: 'SAOD' });

  // 2W (1+1) — each cell emits a COMP rule + a SAOD rule sharing rate_value
  list.push({ col: 82, product: 'TW', segment: 'Scooter', make: 'All', cc_band_min: 0,   cc_band_max: 150,   rate_type: 'COMP', dual_emit: 'SAOD' });
  list.push({ col: 83, product: 'TW', segment: 'Bike',    make: 'All', cc_band_min: 0,   cc_band_max: 125,   rate_type: 'COMP', dual_emit: 'SAOD' });
  list.push({ col: 84, product: 'TW', segment: 'Bike',    make: 'All', cc_band_min: 126, cc_band_max: 99999, rate_type: 'COMP', dual_emit: 'SAOD' });

  return list;
})();

/** Declined-RTO footnotes from the rate sheet's bottom rows. Encoded as
 *  data so we can emit explicit `is_declined=true` rows for each
 *  (segment, state) combo. */
const DECLINED = [
  {
    segment: 'GCV 4W',  // covers 2.5T-3.5T (weight_band 2.5-3.5)
    weight_band_min: 2.5, weight_band_max: 3.5,
    states: ['AN','AR','AS','DD','DN','HR','NCR','KA','KL','LA','LD','ML','MN','MP','MZ','NL','PY','RJ','SK','TN','TR','UA','UK','WB','J&K','CG'],
    note: 'SBI declined for 2.5T-3.5T GCV in this state',
  },
];

const ZONES = new Set(['East 1','East 2','North 1','North 2','South 1','South 2','West 1','West 2']);

const { irdaRateFor } = require('../utils/irda-rates');

/**
 * Premium-slab variants per the rate sheet's footer note:
 *   "All Broker - Above 25 Lakhs Grid effective from 2nd Apr 26 to 30 Apr 26.
 *    Note - For less than 25 lac Grid would be lower by 2% & for less than
 *    1 L only IRDA applicable."
 *
 * Slab is judged against Total Motor Biz of the month (broker volume).
 * Each cell in the rate sheet expands into 3 slab variants so the matcher
 * picks based on the broker's volume.
 *
 *   Above 25L  → grid as printed
 *   1L-25L     → grid − 2%
 *   Below 1L   → IRDA default (firm-wide table in parsers/utils/irda-rates.js)
 *
 * Slab is stored in `volume_tier`; the SBI broker zone (East 1, West 2…)
 * which previously occupied volume_tier is moved to `carrier_type` so the
 * Excel export's parseVolumeBand sees a clean slab string.
 */
const PREMIUM_SLABS = [
  { tier: 'Above 25L', delta:  0,     irda_only: false },
  { tier: '1L-25L',    delta: -0.02,  irda_only: false },
  { tier: 'Below 1L',  delta:  0,     irda_only: true  },
];

/** Resolve a (cell rate, rate_type) pair into the rate to emit for a slab. */
function rateForSlab(v, rateType, slab) {
  if (slab.irda_only) return irdaRateFor(rateType);
  return Math.max(0, +(v + slab.delta).toFixed(6));
}

/**
 * SBI RTO Master cluster name → list of (state, city) tokens that the
 * rate sheet uses for the same area. Reverse-keyed to find every cluster
 * code that should match a given rate-sheet row.
 *
 * Why: SBI ships two files — the rate sheet (rows keyed by state/city
 * like "PUNJAB / CHANDIGARH" + "Chandigarh") and the RTO master (RTOs
 * keyed by cluster names like "PB - AJHLG" / "PB - Rest" / "CG -
 * Tricity").  The bulk pipeline resolves a policy RTO via the RTO master
 * and ends up with cluster names that don't appear in the rate sheet.
 *
 * To bridge:  for each rate-sheet row, the engine emits the original
 * rule plus alias rules with region=<cluster_code> for every cluster
 * code that maps to this row.  The matcher's region-IN lookup then hits
 * via the cluster name.
 *
 * Mapping derived by inspecting both files side-by-side; ambiguous
 * entries (e.g. CG-Tricity → Chandigarh? Chhattisgarh?) leaned on the
 * RTO codes that map under the cluster (PB01 = Chandigarh sector RTO →
 * CG-Tricity = Chandigarh tri-city).
 */
const SBI_ROW_CLUSTERS = {
  // Punjab + Chandigarh + HP+JK rows in the rate sheet share the same
  // "Chandigarh" circle.  All Chandigarh-tricity / PB / HP / JK / HR
  // clusters from the RTO master flow through this row.
  'PUNJAB / CHANDIGARH:Chandigarh':         ['PB - AJHLG', 'PB - Rest', 'CG - Tricity', 'CH - R', 'CH - Rest'],
  'CHANDIGARH:Chandigarh':                  ['CG - Tricity', 'CH - R', 'CH - Rest'],
  'HARYANA:Chandigarh':                     ['HR - Rest'],
  'HIMACHAL PRADESH:Chandigarh':            ['HP'],
  'JAMMU AND KASHMIR:Chandigarh':           ['JK'],

  // Maharashtra splits — Mumbai/Pune/Navi Mumbai are the metro cluster (MH - M),
  // RO Maharashtra is MH - Rest. Goa rolls under MH - Rest as a separate row.
  'Mumbai:Mumbai metro':                    ['MH - M'],
  'Pune:Maharashtra':                       ['MH - M'],
  'Navi Mumbai:Mumbai metro':               ['MH - M'],
  'RO Maharashtra:Maharashtra':             ['MH - Rest'],
  'GOA:Maharashtra':                        ['GA'],

  // Karnataka — Bangalore vs RO
  'Bangalore:Bangalore':                    ['KA - B'],
  'ROKarnataka:Bangalore':                  ['KA - Rest'],

  // Telangana / AP — Hyderabad cluster vs Rest
  'TELANGANA:Hyderabad':                    ['TS - H', 'TS - Rest 1', 'TS - Rest 2'],
  'ANDHRA PRADESH:Amaravati':               ['AP - Rest', 'AP - VVK'],

  // Kerala
  'KERALA:Thiruvananthapuram':              ['KL - Rest', 'KL - KE'],

  // Delhi / NCR
  'DELHI:Delhi':                            ['DL - NCR'],
  'NCR:Delhi':                              ['DL - NCR'],

  // East
  'BIHAR:Patna':                            ['BR'],
  'JHARKHAND:Patna':                        ['JH'],
  'ODISHA:Bhubaneswar':                     [],
  'CHATTISGARH:Bhopal':                     [],
  'MADHYA PRADESH:Bhopal':                  [],
  'RAJASTHAN:Jaipur':                       [],

  // Gujarat — Ahmedabad/Surat/Vadodara cluster + Rest
  'Ahmedabad, Baroda & Surat:Ahmadabad':    ['GJ - A', 'GJ - V', 'GJ - S'],
  'Rest Of Gujarat:Ahmadabad':              ['GJ - R', 'GJ - Rest'],

  // Assam
  'ASSAM:North East':                       ['AS'],

  // North-East cluster — most of the small NE states share the master's
  // "North East 2" cluster.
  'ARUNACHAL PRADESH:North East':           ['North East 2'],
  'MEGHALAYA:North East':                   ['North East 2'],
  'MIZORAM:North East':                     ['North East 2'],
  'MANIPUR:North East':                     ['North East 2'],
  'NAGALAND:North East':                    ['North East 2'],
  'TRIPURA:North East':                     ['North East 2'],
  'SIKKIM:North East':                      ['North East 2'],

  // UP variants — RTO master clusters: UP - AKLGV (Allahabad/Kanpur/
  // Lucknow/Gorakhpur/Varanasi mix), UP - Rest 1 (Eastern UP), UP - Rest 2
  // (Western UP).  Best-fit mapping to the rate sheet's three UP rows.
  'UTTAR PRADESH (Central):Lucknow':        ['UP - AKLGV'],
  'UTTAR PRADESH (Eastern):Lucknow':        ['UP - Rest 1'],
  'UTTAR PRADESH (Rest):Lucknow':           ['UP - Rest 2'],

  // West Bengal — Kolkata vs rest
  'Kolkata:Kolkata':                        ['WB - K'],
  'Rest of West Bengal:Kolkata':            ['WB - Rest 1', 'WB - Rest 2'],

  // Tamil Nadu — Chennai I/II + Rest
  'TAMIL NADU- Chennai:Chennai':            ['TN - C'],
  'TAMIL NADU- Chennai II:Chennai':         ['TN - CO'],
  'Rest of Tamilnadu:Chennai':              ['TN - Rest'],
  'PONDICHERRY:Chennai':                    ['TN - Rest'],

  // Uttarakhand — single cluster code "UK" in master.
  'UTTARANCHAL:Delhi':                      ['UK'],

  // Daman & Diu — sometimes clustered under GJ-S in master.
  'Daman & Diu:Ahmadabad':                  ['GJ - Rest', 'GJ - S'],
  'DADRA AND NAGAR HAVELI:Ahmadabad':       ['GJ - Rest', 'GJ - S'],
};

function findClustersForRow(stateText, cityText) {
  const key = `${(stateText || '').trim()}:${(cityText || '').trim()}`;
  return SBI_ROW_CLUSTERS[key] || [];
}

/** State-name canonicalizer. Maps the rate sheet's state-column variants
 *  to a canonical UPPERCASE state name suitable for matching against
 *  RTO-derived state names in the bulk pipeline.  Returns null when the
 *  input doesn't look like a state. */
const STATE_ALIASES = {
  'TAMIL NADU': 'TAMIL NADU',
  'TAMILNADU': 'TAMIL NADU',
  'WEST BENGAL': 'WEST BENGAL',
  'WB': 'WEST BENGAL',
  'ANDHRA PRADESH': 'ANDHRA PRADESH',
  'TELANGANA': 'TELANGANA',
  'KARNATAKA': 'KARNATAKA',
  'KERALA': 'KERALA',
  'MAHARASHTRA': 'MAHARASHTRA',
  'GUJARAT': 'GUJARAT',
  'GUJRAT': 'GUJARAT',
  'RAJASTHAN': 'RAJASTHAN',
  'PUNJAB': 'PUNJAB',
  'HARYANA': 'HARYANA',
  'DELHI': 'DELHI',
  'NCR': 'DELHI',
  'BIHAR': 'BIHAR',
  'JHARKHAND': 'JHARKHAND',
  'ODISHA': 'ODISHA',
  'ORISSA': 'ODISHA',
  'CHHATTISGARH': 'CHHATTISGARH',
  'CHATTISGARH': 'CHHATTISGARH',
  'CG': 'CHHATTISGARH',
  'MADHYA PRADESH': 'MADHYA PRADESH',
  'UTTAR PRADESH': 'UTTAR PRADESH',
  'UTTARANCHAL': 'UTTARAKHAND',
  'UTTARAKHAND': 'UTTARAKHAND',
  'HIMACHAL PRADESH': 'HIMACHAL PRADESH',
  'JAMMU AND KASHMIR': 'JAMMU & KASHMIR',
  'J&K': 'JAMMU & KASHMIR',
  'PUNJAB / CHANDIGARH': 'PUNJAB',
  'CHANDIGARH': 'CHANDIGARH',
  'GOA': 'GOA',
  'PONDICHERRY': 'PUDUCHERRY',
  'PUDUCHERRY': 'PUDUCHERRY',
  'ARUNACHAL PRADESH': 'ARUNACHAL PRADESH',
  'ASSAM': 'ASSAM',
  'MANIPUR': 'MANIPUR',
  'MEGHALAYA': 'MEGHALAYA',
  'MIZORAM': 'MIZORAM',
  'NAGALAND': 'NAGALAND',
  'TRIPURA': 'TRIPURA',
  'SIKKIM': 'SIKKIM',
};

/** City → canonical state. The rate sheet drops bare city names ("Kolkata",
 *  "Hyderabad", "Bangalore") that the matcher needs to map back to a state
 *  for region lookup. */
const CITY_TO_STATE = {
  'KOLKATA':   'WEST BENGAL',
  'BANGALORE': 'KARNATAKA',
  'BENGALURU': 'KARNATAKA',
  'HYDERABAD': 'TELANGANA',
  'CHENNAI':   'TAMIL NADU',
  'MUMBAI':    'MAHARASHTRA',
  'PUNE':      'MAHARASHTRA',
  'AHMEDABAD': 'GUJARAT',
  'DELHI':     'DELHI',
  'PATNA':     'BIHAR',
  'JAIPUR':    'RAJASTHAN',
  'LUCKNOW':   'UTTAR PRADESH',
};

/**
 * Parse the State column into structured fields.
 * Returns { state, city, sub_division, raw } where:
 *   - state         — canonical UPPERCASE state name (used as the
 *                     `region` lookup key downstream)
 *   - city          — city qualifier when the entry is a city-specific
 *                     row ("Kolkata", "TAMIL NADU- Chennai", etc.)
 *   - sub_division  — non-city sub-region tag for entries like
 *                     "UTTAR PRADESH (Eastern)" or "Rest of Tamilnadu"
 *
 * Examples:
 *   "ARUNACHAL PRADESH"         → { state: "ARUNACHAL PRADESH" }
 *   "Kolkata"                   → { state: "WEST BENGAL", city: "Kolkata" }
 *   "Rest of West Bengal"       → { state: "WEST BENGAL", sub_division: "Rest" }
 *   "TAMIL NADU- Chennai"       → { state: "TAMIL NADU", city: "Chennai" }
 *   "TAMIL NADU- Chennai II"    → { state: "TAMIL NADU", city: "Chennai II" }
 *   "Rest of Tamilnadu"         → { state: "TAMIL NADU", sub_division: "Rest" }
 *   "UTTAR PRADESH (Eastern)"   → { state: "UTTAR PRADESH", sub_division: "Eastern" }
 *   "PUNJAB / CHANDIGARH"       → { state: "PUNJAB" }
 */
function parseStateField(raw) {
  if (!raw) return null;
  const original = String(raw).trim();
  if (!original) return null;
  const u = original.toUpperCase();

  // "Rest of <state>"  → sub_division=Rest, state=<state>
  let m = original.match(/^Rest\s+of\s+(.+)$/i);
  if (m) {
    const stateRaw = m[1].trim().toUpperCase();
    const state = STATE_ALIASES[stateRaw] || stateRaw;
    return { state, sub_division: 'Rest', raw: original };
  }

  // "<state> (<sub-division>)"  →  e.g. "UTTAR PRADESH (Eastern)"
  m = original.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (m) {
    const stateRaw = m[1].trim().toUpperCase();
    const subDiv = m[2].trim();
    const state = STATE_ALIASES[stateRaw] || stateRaw;
    return { state, sub_division: subDiv, raw: original };
  }

  // "<state>- <city>" (TAMIL NADU- Chennai). Hyphen may be ascii or unicode.
  m = original.match(/^(.+?)\s*[-—–]\s*(.+)$/);
  if (m) {
    const stateRaw = m[1].trim().toUpperCase();
    const cityRaw  = m[2].trim();
    if (STATE_ALIASES[stateRaw] || /^[A-Z]/.test(stateRaw)) {
      return { state: STATE_ALIASES[stateRaw] || stateRaw, city: cityRaw, raw: original };
    }
  }

  // "<state> / <state>" — composite (e.g. "PUNJAB / CHANDIGARH"). Take
  // the first as primary; the matcher can still hit on alias.
  m = original.match(/^(.+?)\s*\/\s*(.+)$/);
  if (m) {
    const stateRaw = m[1].trim().toUpperCase();
    return { state: STATE_ALIASES[stateRaw] || stateRaw, raw: original };
  }

  // Bare city name → derive state from CITY_TO_STATE
  const cityState = CITY_TO_STATE[u];
  if (cityState) {
    return { state: cityState, city: original.trim(), raw: original };
  }

  // Plain state name
  return { state: STATE_ALIASES[u] || u, raw: original };
}

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
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row : 4;

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    // Direct 1:1 mapping per user spec:
    //   col 0 "Region" → Zone        → volume_tier
    //   col 1 "State Name" → State   → region   (kept as-is, raw value)
    //   col 2 "Circle" → City        → sub_type (kept as-is, raw value)
    const zone  = cellOrNull(row[0]);       // East 1, West 2, …
    const state = cellOrNull(row[1]);       // ARUNACHAL PRADESH, Kolkata, RO Maharashtra, …
    const city  = cellOrNull(row[2]);       // North East, Kolkata, Patna, Mumbai metro, …
    if (!zone || !state || !ZONES.has(zone)) continue; // footnote / blank — stop
    const rowStart = rules.length;          // index where this row's rules begin

    for (const spec of RATE_COLS) {
      const v = parseRate(row[spec.col]);
      if (v == null || v === 0) continue;
      // Each cell expands into 3 slab variants (Above 25L / 1L-25L / Below 1L).
      // Slab is stored in `volume_tier`; the SBI broker zone moves to
      // `carrier_type` so volume_tier carries only the volume slab.
      for (const slab of PREMIUM_SLABS) {
        const slabRate = rateForSlab(v, spec.rate_type, slab);
        const baseRule = {
          product: spec.product,
          sheet_name: meta.sheetName,
          region:   state,                                 // State Name (col 1) verbatim
          segment:  spec.segment,
          make:     spec.make || 'All',
          sub_type: city,                                  // Circle (col 2) verbatim — City
          fuel_type: spec.fuel_type || null,
          cc_band_min:    spec.cc_band_min ?? null,
          cc_band_max:    spec.cc_band_max ?? null,
          weight_band_min: spec.weight_band_min ?? null,
          weight_band_max: spec.weight_band_max ?? null,
          vehicle_age_min: spec.vehicle_age_min ?? null,
          vehicle_age_max: spec.vehicle_age_max ?? null,
          seating_capacity_min: spec.seating_capacity_min ?? null,
          addon:    spec.addon || null,
          volume_tier:  slab.tier,                         // premium slab
          carrier_type: zone,                              // SBI broker zone (was volume_tier)
          rate_type: spec.rate_type,
          rate_value: slabRate,
          is_declined: false,
          rate_text: `${zone} | ${state}${city ? ' | ' + city : ''} | ${slab.tier}` +
                     (slab.irda_only ? ' (IRDA default)' : ''),
          remarks: slab.irda_only ? 'Premium below ₹1L — IRDA default applied' : null,
        };
        // For IRDA-only slab, NCB doesn't apply (broker gets flat IRDA rate
        // regardless of NCB or vehicle age) — emit a single rule, not the
        // 3-way split.  Other slabs follow the existing ncb_split / dual_emit
        // expansion using slabRate as the cell rate.
        if (spec.ncb_split && !slab.irda_only) {
          // Source header:
          //   "PCV Taxi (Carrying capacity upto 6+1) with NCB only
          //    (NON NCB/New Vehicle grid would be lesser by 5%)"
          // → emit 3 variants per cell so the matcher hits both
          //   "no NCB" AND "new vehicle" cases:
          //
          //   1) NCB + rolled-over   : age_band 1..99, vehicle_age 1..99
          //   2) Non-NCB rolled-over : age_band 0..0,  vehicle_age 1..99,  rate − 5%
          //   3) New Vehicle         : age_band 0..0,  vehicle_age 0..0,   rate − 5%
          //                            (a brand-new vehicle has no NCB by definition)
          const nonNcbRate = Math.max(0, +(slabRate - 0.05).toFixed(6));
          rules.push({ ...baseRule, age_band_min: 1, age_band_max: 99, vehicle_age_min: 1, vehicle_age_max: 99 });
          rules.push({ ...baseRule, age_band_min: 0, age_band_max: 0,  vehicle_age_min: 1, vehicle_age_max: 99, rate_value: nonNcbRate });
          rules.push({ ...baseRule, age_band_min: 0, age_band_max: 0,  vehicle_age_min: 0, vehicle_age_max: 0,  rate_value: nonNcbRate });
        } else {
          rules.push(baseRule);
        }
        if (spec.dual_emit) {
          // Sister rate_type (e.g. SAOD for Comp, SATP for tractor Non-New).
          // For IRDA-only slab the rate must be re-resolved against the new
          // rate_type since IRDA differs by COMP vs SATP.
          const sisterRate = slab.irda_only
            ? irdaRateFor(spec.dual_emit)
            : slabRate;
          rules.push({ ...baseRule, rate_type: spec.dual_emit, rate_value: sisterRate });
        }
      }
    }

    // Cluster-alias emission: for this row's (state, city), find every
    // SBI RTO master cluster code that maps to it and clone every rule
    // emitted in this row with region = cluster_code.  This bridges the
    // naming gap (rate sheet uses state names, RTO master uses cluster
    // codes like "PB - AJHLG") so the bulk pipeline's RTO→cluster lookup
    // hits a rate rule.
    const clusters = findClustersForRow(state, city);
    if (clusters.length > 0) {
      const rowRules = rules.slice(rowStart);
      for (const orig of rowRules) {
        for (const clusterCode of clusters) {
          rules.push({
            ...orig,
            region: clusterCode,
            rate_text: `${clusterCode} | (alias for ${orig.region}${orig.sub_type ? ' | ' + orig.sub_type : ''})`,
          });
        }
      }
    }
  }

  // Declined-RTO footnote rows — emit one is_declined=true row per
  // (segment, state) combo so the bulk recovery surfaces "Declined by SBI"
  // rather than "No matching rule".
  for (const decl of DECLINED) {
    for (const stateCode of decl.states) {
      rules.push({
        product: 'GCV',
        sheet_name: meta.sheetName,
        region: stateCode,
        segment: decl.segment,
        make: 'All',
        weight_band_min: decl.weight_band_min ?? null,
        weight_band_max: decl.weight_band_max ?? null,
        rate_type: 'COMP',
        rate_value: null,
        is_declined: true,
        rate_text: decl.note,
      });
    }
  }

  return rules;
}

module.exports = { parse };
