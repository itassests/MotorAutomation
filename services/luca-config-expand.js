'use strict';

/**
 * Config-driven insurers → pseudo rate_rules rows for the Luca export.
 *
 * The Luca export reads `rate_rules`, but several insurers keep their grids in
 * config JSON + a resolver and compute the rate at CALCULATION time, so they
 * never write rate_rules — IndusInd has literally ZERO rows. Those insurers were
 * therefore missing (or stale) in the agent-facing file.
 *
 * This module expands each config grid into rows shaped exactly like a
 * rate_rules record, so buildLucaBuffer can feed them through the SAME pipeline
 * (margin → outgoing, make/model split, product taxonomy, state mapping). The
 * rate emitted is the GRID rate — the caller subtracts the margin, identical to
 * a DB-backed row.
 *
 * Each expander is hand-mapped from the insurer's resolver so the semantics
 * match what the engine actually pays. Add one insurer at a time and verify.
 */

const IND_CAR = require('../config/indusind_car.json');
const IND_TW  = require('../config/indusind_tw.json');
const IND_CV  = require('../config/indusind_cv.json');

/** Shape a pseudo rate_rules row (only the fields buildLucaBuffer reads). */
function row(o) {
  return {
    insurer: o.insurer,
    product: o.product || null,
    sheet_name: o.sheet_name || null,
    region: o.region || null,
    segment: o.segment || null,
    make: o.make || null,
    model: o.model || null,
    sub_type: o.sub_type || null,
    fuel_type: o.fuel_type || null,
    cc_band_min: o.cc_band_min == null ? null : o.cc_band_min,
    cc_band_max: o.cc_band_max == null ? null : o.cc_band_max,
    age_band_min: o.age_band_min == null ? null : o.age_band_min,
    age_band_max: o.age_band_max == null ? null : o.age_band_max,
    weight_band_min: o.weight_band_min == null ? null : o.weight_band_min,
    weight_band_max: o.weight_band_max == null ? null : o.weight_band_max,
    rate_type: o.rate_type || null,
    rate_value: o.rate_value,
    remarks: o.remarks || null,
    state: o.state || null,
    effective_from: o.effective_from || null,
  };
}
const has = (v) => v != null && v !== '' && Number.isFinite(Number(v));

// ---------------------------------------------------------------------------
// IndusInd — Private Car (config/indusind_car.json, services/indusind-car.js)
//   region → { nonDieselCom, diesel, saod, stp }
//   Comp splits Diesel vs Non-Diesel (petrol / CNG / EV). Emit the non-diesel
//   leg once per concrete fuel so Luca's single-valued fuel_type stays truthful.
// ---------------------------------------------------------------------------
function indusindCar(eff) {
  const out = [];
  for (const g of (IND_CAR.grid || [])) {
    const base = { insurer: 'indusind', product: 'CAR', sheet_name: 'PVT COM',
                   region: g.region, segment: 'Private Car', effective_from: eff };
    if (has(g.nonDieselCom)) {
      for (const f of ['PETROL', 'CNG', 'ELECTRIC']) {
        out.push(row({ ...base, rate_type: 'COMP', fuel_type: f, rate_value: g.nonDieselCom }));
      }
    }
    if (has(g.diesel)) out.push(row({ ...base, rate_type: 'COMP', fuel_type: 'DIESEL', rate_value: g.diesel }));
    if (has(g.saod))   out.push(row({ ...base, rate_type: 'SAOD', rate_value: g.saod }));
    if (has(g.stp))    out.push(row({ ...base, rate_type: 'SATP', rate_value: g.stp }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// IndusInd — Two Wheeler (config/indusind_tw.json, services/indusind-tw.js)
//   region → { fresh15 (new 1+5 bundle), fresh55 (5+5 bundle), comp, saod, stp }
// ---------------------------------------------------------------------------
function indusindTw(eff) {
  const out = [];
  for (const g of (IND_TW.grid || [])) {
    const base = { insurer: 'indusind', product: 'TW', sheet_name: 'TW26',
                   region: g.region, state: g.state, effective_from: eff };
    // "1+5"/"5+5" in the segment makes lucaProduct/coverage tag these as bundled
    // (hybrid) long-term packages — age 0 = brand new.
    if (has(g.fresh15)) out.push(row({ ...base, segment: 'Two Wheeler 1+5 Bundled', rate_type: 'COMP', age_band_min: 0, age_band_max: 0, rate_value: g.fresh15 }));
    if (has(g.fresh55)) out.push(row({ ...base, segment: 'Two Wheeler 5+5 Bundled', rate_type: 'COMP', age_band_min: 0, age_band_max: 0, rate_value: g.fresh55 }));
    if (has(g.comp))    out.push(row({ ...base, segment: 'Two Wheeler', rate_type: 'COMP', rate_value: g.comp }));
    if (has(g.saod))    out.push(row({ ...base, segment: 'Two Wheeler', rate_type: 'SAOD', rate_value: g.saod }));
    if (has(g.stp))     out.push(row({ ...base, segment: 'Two Wheeler', rate_type: 'SATP', rate_value: g.stp }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// IndusInd — CV (config/indusind_cv.json, services/indusind-cv.js)
//   region → 49 rate keys. Each key encodes product + cover (+ tonnage / age /
//   fuel / body), mirrored from the resolver's segKey() logic.
//   cover: 'COMP' | 'SATP'.  ton: [min,max].  age: [min,max].
// ---------------------------------------------------------------------------
const CV_KEYS = {
  // PCV 3-wheeler (auto / e-rickshaw)
  pcv3w_comp:              { product: 'PCV',  segment: 'PCV 3W Auto Rickshaw', cover: 'COMP' },
  pcv3w_stp:               { product: 'PCV',  segment: 'PCV 3W Auto Rickshaw', cover: 'SATP' },
  // PCV school bus (split on age 10)
  schoolbus_lt10:          { product: 'PCV',  segment: 'School Bus', cover: 'COMP', age: [0, 10] },
  schoolbus_gt10:          { product: 'PCV',  segment: 'School Bus', cover: 'COMP', age: [11, null] },
  // PCV taxi
  taxi_lt6_diesel:         { product: 'PCV',  segment: 'Taxi Upto 6 Seater', cover: 'COMP', fuel: 'DIESEL' },
  taxi_lt6_nnd_other:      { product: 'PCV',  segment: 'Taxi Upto 6 Seater', cover: 'COMP' },
  taxi_lt6_nnd_stp_other:  { product: 'PCV',  segment: 'Taxi Upto 6 Seater', cover: 'SATP' },
  taxi_lt6_nd_other:       { product: 'PCV',  segment: 'Taxi Upto 6 Seater Nil Dep', cover: 'COMP' },
  taxi_7p1_nd:             { product: 'PCV',  segment: 'Taxi 7+1 Nil Dep', cover: 'COMP' },
  taxi_7p1_branded_com:    { product: 'PCV',  segment: 'Taxi 7+1 Branded', cover: 'COMP' },
  taxi_7p1_branded_stp:    { product: 'PCV',  segment: 'Taxi 7+1 Branded', cover: 'SATP' },
  taxi_otherbus_com:       { product: 'PCV',  segment: 'Other Bus', cover: 'COMP' },
  taxi_otherbus_stp:       { product: 'PCV',  segment: 'Other Bus', cover: 'SATP' },
  taxi_kaalipeeli:         { product: 'PCV',  segment: 'Taxi Kaali Peeli', cover: 'COMP' },
  // GCV by tonnage (+ age split on 5 where the grid has one)
  gcv_jeeto_supro_lt2t_comp: { product: 'GCV', segment: 'GCV Upto 2T', cover: 'COMP', ton: [0, 2], make: 'Mahindra', model: 'Jeeto, Supro' },
  gcv_jeeto_supro_lt2t_stp:  { product: 'GCV', segment: 'GCV Upto 2T', cover: 'SATP', ton: [0, 2], make: 'Mahindra', model: 'Jeeto, Supro' },
  gcv_other_2_2p5_comp:    { product: 'GCV',  segment: 'GCV 2T-2.5T', cover: 'COMP', ton: [2, 2.5] },
  gcv_other_2_2p5_stp:     { product: 'GCV',  segment: 'GCV 2T-2.5T', cover: 'SATP', ton: [2, 2.5] },
  gcv_2p5_3p5_comp:        { product: 'GCV',  segment: 'GCV 2.5T-3.5T', cover: 'COMP', ton: [2.5, 3.5] },
  gcv_2p5_3p5_stp:         { product: 'GCV',  segment: 'GCV 2.5T-3.5T', cover: 'SATP', ton: [2.5, 3.5] },
  gcv_3p5_7p5_comp:        { product: 'GCV',  segment: 'GCV 3.5T-7.5T', cover: 'COMP', ton: [3.5, 7.5] },
  gcv_3p5_7p5_stp:         { product: 'GCV',  segment: 'GCV 3.5T-7.5T', cover: 'SATP', ton: [3.5, 7.5] },
  gcv_7p5_12_comp:         { product: 'GCV',  segment: 'GCV 7.5T-12T', cover: 'COMP', ton: [7.5, 12] },
  gcv_7p5_12_stp:          { product: 'GCV',  segment: 'GCV 7.5T-12T', cover: 'SATP', ton: [7.5, 12] },
  gcv_12_20_le5_comp:      { product: 'GCV',  segment: 'GCV 12T-20T', cover: 'COMP', ton: [12, 20], age: [0, 5] },
  gcv_12_20_gt5_comp:      { product: 'GCV',  segment: 'GCV 12T-20T', cover: 'COMP', ton: [12, 20], age: [6, null] },
  gcv_12_20_stp:           { product: 'GCV',  segment: 'GCV 12T-20T', cover: 'SATP', ton: [12, 20] },
  gcv_20_40_le5_comp:      { product: 'GCV',  segment: 'GCV 20T-40T', cover: 'COMP', ton: [20, 40], age: [0, 5] },
  gcv_20_40_gt5_comp:      { product: 'GCV',  segment: 'GCV 20T-40T', cover: 'COMP', ton: [20, 40], age: [6, null] },
  gcv_20_40_stp:           { product: 'GCV',  segment: 'GCV 20T-40T', cover: 'SATP', ton: [20, 40] },
  gcv_40_50_comp:          { product: 'GCV',  segment: 'GCV 40T-50T', cover: 'COMP', ton: [40, 50] },
  gcv_40_50_stp:           { product: 'GCV',  segment: 'GCV 40T-50T', cover: 'SATP', ton: [40, 50] },
  gcv_gt50_comp:           { product: 'GCV',  segment: 'GCV Above 50T', cover: 'COMP', ton: [50, null] },
  gcv_gt50_stp:            { product: 'GCV',  segment: 'GCV Above 50T', cover: 'SATP', ton: [50, null] },
  // GCV 3-wheeler (electric / non-electric)
  gcv3w_nonelec_comp:      { product: 'GCV',  segment: 'GCV 3W', cover: 'COMP' },
  gcv3w_nonelec_stp:       { product: 'GCV',  segment: 'GCV 3W', cover: 'SATP' },
  gcv3w_elec_comp:         { product: 'GCV',  segment: 'GCV 3W Electric', cover: 'COMP', fuel: 'ELECTRIC' },
  gcv3w_elec_stp:          { product: 'GCV',  segment: 'GCV 3W Electric', cover: 'SATP', fuel: 'ELECTRIC' },
  // Special bodies
  carcarrier:              { product: 'GCV',  segment: 'Car Carrier', cover: 'COMP' },
  flatbed_comp:            { product: 'GCV',  segment: 'Flatbed Trailer', cover: 'COMP' },
  flatbed_stp:             { product: 'GCV',  segment: 'Flatbed Trailer', cover: 'SATP' },
  emppickup_comp:          { product: 'GCV',  segment: 'Employee Pickup', cover: 'COMP' },
  emppickup_stp:           { product: 'GCV',  segment: 'Employee Pickup', cover: 'SATP' },
  // MISC
  jcb_comp:                { product: 'MISC', segment: 'JCB Backhoe Loader', cover: 'COMP' },
  jcb_stp:                 { product: 'MISC', segment: 'JCB Backhoe Loader', cover: 'SATP' },
  tractor_fresh:           { product: 'MISC', segment: 'Tractor', cover: 'COMP', age: [0, 0] },
  tractor_nonfresh_le5:    { product: 'MISC', segment: 'Tractor', cover: 'COMP', age: [1, 5] },
  tractor_nonfresh_gt5:    { product: 'MISC', segment: 'Tractor', cover: 'COMP', age: [6, null] },
  tractor_stp:             { product: 'MISC', segment: 'Tractor', cover: 'SATP' },
};

function indusindCv(eff) {
  const out = [];
  const grid = IND_CV.grid || {};
  for (const regionKey of Object.keys(grid)) {
    const g = grid[regionKey] || {};
    for (const key of Object.keys(CV_KEYS)) {
      const v = g[key];
      if (!has(v)) continue;
      const m = CV_KEYS[key];
      out.push(row({
        insurer: 'indusind', product: m.product, sheet_name: 'CV26',
        region: g.region || regionKey,
        segment: m.segment, make: m.make, model: m.model, fuel_type: m.fuel,
        rate_type: m.cover, rate_value: v,
        weight_band_min: m.ton ? m.ton[0] : null,
        weight_band_max: m.ton ? m.ton[1] : null,
        age_band_min: m.age ? m.age[0] : null,
        age_band_max: m.age ? m.age[1] : null,
        effective_from: eff,
      }));
    }
  }
  return out;
}

/**
 * Expand every supported config-driven insurer.
 * @param {Map<string,Date|string>} effByInsurer  slug → the insurer's active
 *        card effective_from, so the exported rows carry the right generation.
 * @returns {object[]} pseudo rate_rules rows.
 */
function expandConfigRules(effByInsurer) {
  const eff = (slug) => (effByInsurer && effByInsurer.get(slug)) || null;
  const e = eff('indusind');
  return [
    ...indusindCar(e),
    ...indusindTw(e),
    ...indusindCv(e),
  ];
}

module.exports = { expandConfigRules, indusindCar, indusindTw, indusindCv, CV_KEYS };
