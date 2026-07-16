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
const TATA_CAR = require('../config/tata_car_jun26.json');
const TATA_CV  = require('../config/tata_cv_jun26.json');
const GD_CAR   = require('../config/go_digit_car_jun26.json');

const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const CONCRETE_FUELS = ['DIESEL', 'CNG', 'ELECTRIC', 'PETROL'];
// rate_type suffix so lucaNcb() reports TRUE/FALSE for the row.
const ncbTag = (yes) => (yes ? ' NCB:GT0' : ' NCB:0');
const SECTION_RT = { PACKAGE: 'COMP', SAOD: 'SAOD', SATP: 'SATP' };

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

// ---------------------------------------------------------------------------
// TATA AIG — Private Car (config/tata_car_jun26.json, services/tata-car.js)
//   biz × section × fuel × rto × ncb → rate (stored as a PERCENT).
//   The resolver picks by SPECIFICITY (fuel: exact 2 > "Other Than Diesel" 1 >
//   All 0; ncb: exact 2 > All 0; rto: exact 4 > All 0), so we cannot dump raw
//   config rows — we resolve the winner per concrete scope exactly as it does,
//   then collapse: emit the pan-India ("All" RTO) row once and only add an RTO
//   row where its rate actually differs.
// ---------------------------------------------------------------------------
function pickTataCar(biz, section, fc, ncbYes, rto) {
  let best = null, bestScore = -1;
  for (const g of (TATA_CAR.grid || [])) {
    if (norm(g.biz) !== norm(biz) || norm(g.section) !== norm(section)) continue;
    const gf = norm(g.fuel); let fs;
    if (gf === 'ALL') fs = 0;
    else if (gf === 'DIESEL' && fc === 'DIESEL') fs = 2;
    else if (gf === 'CNG' && fc === 'CNG') fs = 2;
    else if (gf === 'ELECTRIC' && fc === 'ELECTRIC') fs = 2;
    else if (gf === 'OTHER THAN DIESEL' && fc !== 'DIESEL') fs = 1;
    else continue;
    const gn = norm(g.ncb); let ns;
    if (gn === 'ALL') ns = 0;
    else if (gn === 'YES' && ncbYes) ns = 2;
    else if (gn === 'NO' && !ncbYes) ns = 2;
    else continue;
    let rs;
    if (norm(g.rto) === 'ALL') rs = 0;
    else if (rto && norm(g.rto) === norm(rto)) rs = 4;
    else continue;
    const score = fs + ns + rs;
    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best ? +(best.rate / 100).toFixed(4) : null;   // config stores a percent
}

function tataCar(eff) {
  const grid = TATA_CAR.grid || [];
  const bizes = [...new Set(grid.map(g => g.biz))];
  const sections = [...new Set(grid.map(g => g.section))];
  const rtos = [...new Set(grid.map(g => g.rto))].filter(r => norm(r) !== 'ALL');
  const out = [];
  for (const biz of bizes) for (const section of sections) {
    const rt = SECTION_RT[norm(section)] || 'COMP';
    for (const fc of CONCRETE_FUELS) for (const ncbYes of [true, false]) {
      const all = pickTataCar(biz, section, fc, ncbYes, null);
      const base = {
        insurer: 'tata_aig', product: 'CAR', sheet_name: 'Private Car Jun26',
        segment: `Private Car ${biz}`, fuel_type: fc,
        rate_type: rt + ncbTag(ncbYes), effective_from: eff,
      };
      if (all != null) out.push(row({ ...base, rate_value: all }));
      for (const rto of rtos) {
        const v = pickTataCar(biz, section, fc, ncbYes, rto);
        if (v == null || v === all) continue;      // covered by the pan-India row
        out.push(row({ ...base, region: rto, rate_value: v }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TATA AIG — CV / PCV / GCV / MISC (config/tata_cv_jun26.json, services/tata-cv.js)
//   rows[{seg, fuel, section, age, rates{region}}]; rates are FRACTIONS.
//   Same specificity model (fuel + age). Resolve per scope, then collapse the
//   fuel dimension when it doesn't change the answer (emit blank fuel = all).
// ---------------------------------------------------------------------------
function pickTataCv(seg, section, fc, ab, region) {
  let best = null, bestScore = -1;
  for (const r of (TATA_CV.rows || [])) {
    if (r.seg !== seg || r.section !== section) continue;
    if (r.rates == null || r.rates[region] == null) continue;
    const rf = norm(r.fuel); let fs;
    if (rf === 'ALL') fs = 0;
    else if (rf === 'DIESEL' && fc === 'DIESEL') fs = 2;
    else if (rf === 'CNG' && fc === 'CNG') fs = 2;
    else if (rf === 'ELECTRIC' && fc === 'ELECTRIC') fs = 2;
    else if (rf === 'OTHER THAN DIESEL' && fc !== 'DIESEL') fs = 1;
    else continue;
    const ra = norm(r.age); let as;
    if (ra === 'ALL') as = 0;
    else if (ra === norm(ab)) as = 2;
    else continue;
    const score = fs + as;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best ? +Number(best.rates[region]).toFixed(4) : null;
}
// Tata CV product family + tonnage band from the segment text.
function tataCvMeta(seg) {
  const s = norm(seg);
  if (/TRACTOR/.test(s)) return { product: 'MISC' };
  if (/MISC|CRANE|TIPPER|EXCAVAT|JCB|BACKHOE/.test(s)) return { product: 'MISC' };
  if (/PCV|BUS|TAXI|SCHOOL|AUTO|RICK/.test(s)) return { product: 'PCV' };
  const m = s.match(/>\s*([\d.]+)\s*<=\s*([\d.]+)/);
  if (m) return { product: 'GCV', ton: [Number(m[1]), Number(m[2])] };
  const g = s.match(/>\s*([\d.]+)/);
  if (g) return { product: 'GCV', ton: [Number(g[1]), null] };
  const l = s.match(/<=\s*([\d.]+)/);
  if (l) return { product: 'GCV', ton: [null, Number(l[1])] };
  return { product: 'GCV' };
}
// Age bucket text → [min,max] years.
function tataAgeBand(ab) {
  const a = norm(ab);
  if (/BRAND\s*NEW/.test(a)) return [0, 0];
  let m = a.match(/>=\s*([\d.]+)\s*<=\s*([\d.]+)/); if (m) return [Number(m[1]), Number(m[2])];
  m = a.match(/>\s*([\d.]+)\s*<=\s*([\d.]+)/);      if (m) return [Number(m[1]), Number(m[2])];
  m = a.match(/^>\s*([\d.]+)/);                     if (m) return [Number(m[1]), null];
  return [null, null];
}

function tataCv(eff) {
  const rows = TATA_CV.rows || [];
  const regions = TATA_CV.regions || [];
  const segs = [...new Set(rows.map(r => r.seg))];
  const sections = [...new Set(rows.map(r => r.section))];
  const ages = [...new Set(rows.map(r => String(r.age)))].filter(a => norm(a) !== 'ALL');
  const out = [];
  for (const seg of segs) {
    const meta = tataCvMeta(seg);
    for (const section of sections) {
      const rt = SECTION_RT[norm(section)] || 'COMP';
      for (const ab of ages) {
        const [amin, amax] = tataAgeBand(ab);
        for (const region of regions) {
          const byFuel = CONCRETE_FUELS.map(fc => pickTataCv(seg, section, fc, ab, region));
          if (byFuel.every(v => v == null)) continue;
          const base = {
            insurer: 'tata_aig', product: meta.product, sheet_name: 'CV Jun26',
            region, segment: `${seg} ${ab}`, rate_type: rt,
            weight_band_min: meta.ton ? meta.ton[0] : null,
            weight_band_max: meta.ton ? meta.ton[1] : null,
            age_band_min: amin, age_band_max: amax, effective_from: eff,
          };
          const uniq = [...new Set(byFuel.map(v => String(v)))];
          if (uniq.length === 1) {                       // fuel-invariant → one row, all fuels
            out.push(row({ ...base, rate_value: byFuel[0] }));
          } else {
            CONCRETE_FUELS.forEach((fc, i) => {
              if (byFuel[i] == null) return;
              out.push(row({ ...base, fuel_type: fc, rate_value: byFuel[i] }));
            });
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// GO DIGIT — Private Car Comp/SAOD (config/go_digit_car_jun26.json,
// services/go-digit-car.js). grid: cluster → {saodNonNcb, saodNcb, compNonNcb,
// compNcb, hev}; rates are PERCENTS. The resolver checks HEV FIRST (a strong
// hybrid takes the hev rate regardless of cover/NCB), then SAOD vs Comp × NCB.
// SATP is handled by a separate config (go_digit_car_tp_jun26) — not expanded
// here yet, so Go Digit Pvt Car SATP stays absent for now.
// ---------------------------------------------------------------------------
function goDigitCar(eff) {
  const grid = GD_CAR.grid || {};
  const out = [];
  for (const cluster of Object.keys(grid)) {
    const g = grid[cluster] || {};
    const base = { insurer: 'go_digit', product: 'CAR', sheet_name: 'Pvt Car Comp+SAOD Jun26',
                   region: cluster, segment: 'Private Car', effective_from: eff };
    // HEV wins over cover/NCB in the resolver, so it's its own row.
    if (has(g.hev)) out.push(row({ ...base, segment: 'Private Car Strong Hybrid HEV',
                                   fuel_type: 'HYBRID', rate_type: 'COMP', rate_value: g.hev / 100 }));
    if (has(g.saodNcb))    out.push(row({ ...base, rate_type: 'SAOD' + ncbTag(true),  rate_value: g.saodNcb / 100 }));
    if (has(g.saodNonNcb)) out.push(row({ ...base, rate_type: 'SAOD' + ncbTag(false), rate_value: g.saodNonNcb / 100 }));
    if (has(g.compNcb))    out.push(row({ ...base, rate_type: 'COMP' + ncbTag(true),  rate_value: g.compNcb / 100 }));
    if (has(g.compNonNcb)) out.push(row({ ...base, rate_type: 'COMP' + ncbTag(false), rate_value: g.compNonNcb / 100 }));
  }
  return out;
}

/** DB rows the resolvers REPLACE — must be dropped from the export or the file
 *  shows rates the engine never pays. Keyed insurer → predicate(rate_rules row).
 *  TATA: the June Private Car sheet was NEVER ingested (the "Pvtcar_Extended
 *  Warranty" tab is not the commission grid) and the June CV sheet was
 *  MIS-ingested (tonnage in the fuel column) — both are resolved from config
 *  instead (routes/bulk.js). TATA "TW." rules are genuine and stay. */
const SUPPRESS = [
  { insurer: 'tata_aig', test: (r) => /PVTCAR|PVT\s*CAR|EXTENDED\s*WARRANTY/i.test(String(r.sheet_name || '')) },
  { insurer: 'tata_aig', test: (r) => /^CV$/i.test(String(r.sheet_name || '').trim()) },
  // "TW." is mis-ingested too: region holds a TONNAGE ("3.5") and rate_type holds
  // a RATE + body ("45|Moped"). 3,772 rows carry only 9 distinct identities with
  // CONFLICTING rates (45 vs 40.5) for the same one, so any pick is arbitrary.
  // Drop it — absent beats handing an agent a coin-flip rate. Re-ingest the Tata
  // TW sheet (or add a config resolver) to bring it back.
  { insurer: 'tata_aig', test: (r) => /^TW\.?$/i.test(String(r.sheet_name || '').trim()) },
  // GO DIGIT — same story (routes/bulk.js): the June re-ingestion MIS-READ the
  // two-table Pvt Car sheet and loaded the LEFT make-block, "so every make
  // collapsed to one wrong rate" (the operator pays the RIGHT summary block),
  // and the 2W ingestion "stored wrong rate_rules values". Both are resolved
  // config-driven at calc time, so the DB rows are rates nobody pays.
  // TODO: expand go_digit_car_jun26 / _car_tp / _tw / _tw_bundle into rows —
  // until then Pvt Car + 2W are ABSENT rather than wrong. CV/HCV rows are kept
  // (their sheets ingested cleanly and have no bulk.js override).
  { insurer: 'go_digit', test: (r) => /PVT\s*CAR/i.test(String(r.sheet_name || '')) },
  { insurer: 'go_digit', test: (r) => /^2W\s*GRID/i.test(String(r.sheet_name || '').trim()) },
];
// ---- Plugin expanders -------------------------------------------------------
// Each config-driven insurer can live in its own file under services/luca-expand/
// so they can be added independently. Contract:
//   module.exports = {
//     insurer: '<slug>',                       // rate_cards.insurer slug
//     suppress: [ (row) => bool, ... ],        // optional: DB rows the resolver REPLACES
//     expand:   (effFrom) => [ ...rows ],      // rows shaped like rate_rules
//   };
// Use the `row()` shape below (require this module's ROW_FIELDS doc) — rate_value
// is the GRID rate as a FRACTION; the export subtracts the margin.
const fs = require('fs');
const path = require('path');
function loadPlugins() {
  const dir = path.join(__dirname, 'luca-expand');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    try {
      const p = require(path.join(dir, f));
      if (p && typeof p.expand === 'function') out.push(p);
    } catch (e) { console.warn('[luca-expand] skipped ' + f + ': ' + e.message); }
  }
  return out;
}
const PLUGINS = loadPlugins();

/** True when a DB rate_rules row is superseded by a config resolver. */
function isSuppressed(r) {
  const ins = String(r.insurer || '').toLowerCase();
  if (SUPPRESS.some(s => s.insurer === ins && s.test(r))) return true;
  return PLUGINS.some(p => String(p.insurer || '').toLowerCase() === ins
    && (p.suppress || []).some(t => { try { return t(r); } catch (_) { return false; } }));
}

/**
 * Expand every supported config-driven insurer.
 * @param {Map<string,Date|string>} effByInsurer  slug → the insurer's active
 *        card effective_from, so the exported rows carry the right generation.
 * @returns {object[]} pseudo rate_rules rows.
 */
function expandConfigRules(effByInsurer) {
  const eff = (slug) => (effByInsurer && effByInsurer.get(slug)) || null;
  const ind = eff('indusind');
  const tat = eff('tata_aig');
  return [
    ...indusindCar(ind),
    ...indusindTw(ind),
    ...indusindCv(ind),
    ...tataCar(tat),
    ...tataCv(tat),
    ...goDigitCar(eff('go_digit')),
    // Per-insurer plugin expanders (services/luca-expand/*.js)
    ...PLUGINS.flatMap((p) => {
      try { return p.expand(eff(String(p.insurer || '').toLowerCase())) || []; }
      catch (e) { console.warn('[luca-expand] ' + p.insurer + ' failed: ' + e.message); return []; }
    }),
  ];
}

module.exports = {
  expandConfigRules, isSuppressed, SUPPRESS,
  indusindCar, indusindTw, indusindCv, CV_KEYS,
  tataCar, tataCv, pickTataCar, pickTataCv,
  goDigitCar,
};
