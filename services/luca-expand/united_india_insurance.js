'use strict';

/**
 * UNITED INDIA — Luca export expander (Private Car + GCV preferred-RTO).
 *
 * WHY THIS EXISTS
 * ---------------
 * United's only active card (id 577/582, eff 2026-05-01 — there is no June card,
 * which is expected) is a PDF ingest. Its PRIVATE CAR rows are structurally
 * unusable:
 *   - cc_band_min/max and age_band_min/max are ALL NULL, make is the literal
 *     string 'All', region is NULL. The grid's segment split (A = Diesel<=1500cc,
 *     B = >2500cc except 7 makes, C = other) survives ONLY as prose inside
 *     rate_text, so it never reaches a structured column.
 *   - Consequence: every (fuel × rate_type) identity carries TWO CONFLICTING
 *     rates — e.g. Petrol/COMP is both 0.05 and 0.20; Petrol/COMP_1+3 is both
 *     0.10 and 0.275. Any pick is a coin flip (same failure mode as Tata "TW.").
 *   - The Sub Annexure-3 preferred-city-RTO 40% override is ABSENT entirely.
 * routes/bulk.js therefore ALWAYS overrides Pvt Car from services/united-car.js
 * (resolveUnitedCarRate never returns null for vehicleType='CAR'), so 100% of the
 * ingested CAR rows are rates the engine never pays → they are SUPPRESSED here
 * and re-expanded from the resolver.
 *
 * GCV is DIFFERENT — deliberately NOT suppressed. resolveUnitedGcvRate returns
 * non-null ONLY for the Sub Annexure-2 preferred RTOs at <=7.5T; everywhere else
 * bulk.js leaves the DB rule standing. services/united-car.js documents that the
 * full GVW x state grid was intentionally left unimplemented because the operator
 * is inconsistent on the 2-3.5T band and the ingested base already matches the
 * majority. So the DB GCV rows are live rates and must stay. We only ADD the
 * preferred-RTO rows, which the engine pays and which the DB does not contain.
 *
 * HOW THE RATES ARE DERIVED
 * -------------------------
 * Rather than re-encode the grid (and risk drift), this expander CALLS the same
 * resolver routes/bulk.js calls, probing one concrete param set per scope. The
 * resolver picks by SPECIFICITY (make-exception beats cc band beats fuel; the
 * preferred-RTO 40% beats the segment rate except for Segment A and SATP), so —
 * per the luca-config-expand pickTataCar/pickTataCv convention — we resolve the
 * WINNER per concrete scope and then COLLAPSE: a make-specific / RTO-specific /
 * age-specific row is emitted ONLY where its rate actually DIFFERS from the more
 * general row. Rates come back from the resolver as FRACTIONS already (0.275 =
 * 27.5%), so no /100 scaling is applied. The export subtracts the margin itself.
 */

const { resolveUnitedCarRate, resolveUnitedGcvRate } = require('../united-car');
const PREF = require('../../config/united_pref_rtos.json');
const GCV_PREF = require('../../config/united_gcv_pref.json');
const CAR_AUG = require('../../config/united_car_aug26.json');
const GCV_AUG = require('../../config/united_gcv_aug26.json');
const PCV_AUG = require('../../config/united_pcv_aug26.json');

// State code → display name, for enumerating the Aug'26 CC×state / GVW×state grids
// as one row per state (the location-merge then collapses same-rate states into a
// comma list, and produces the "Other than above" bucket).
const STATES = [
  ['AP', 'Andhra Pradesh'], ['AR', 'Arunachal Pradesh'], ['AS', 'Assam'], ['BR', 'Bihar'],
  ['CG', 'Chhattisgarh'], ['GA', 'Goa'], ['GJ', 'Gujarat'], ['HR', 'Haryana'], ['HP', 'Himachal Pradesh'],
  ['JH', 'Jharkhand'], ['JK', 'Jammu & Kashmir'], ['KA', 'Karnataka'], ['KL', 'Kerala'], ['MP', 'Madhya Pradesh'],
  ['MH', 'Maharashtra'], ['MN', 'Manipur'], ['ML', 'Meghalaya'], ['MZ', 'Mizoram'], ['NL', 'Nagaland'],
  ['OD', 'Odisha'], ['PB', 'Punjab'], ['PY', 'Pondicherry'], ['RJ', 'Rajasthan'], ['SK', 'Sikkim'],
  ['TN', 'Tamil Nadu'], ['TS', 'Telangana'], ['TR', 'Tripura'], ['UP', 'Uttar Pradesh'], ['UK', 'Uttarakhand'],
  ['WB', 'West Bengal'], ['DL', 'Delhi'], ['CH', 'Chandigarh'],
];
const carBandRate = (band, code) => band.all != null ? band.all
  : ((CAR_AUG.stateSets[band.set] || []).includes(code) ? band.inR : band.outR);
const ccLo = (bands, i) => (i === 0 ? 1 : (bands[i - 1].maxCc + 1));

// Pvt-Car (eff Aug'26) enumerated from config: one row per state × cc-band × cover.
// Covers: Bundled(1+3)=COMP age0; Package family=COMP age1+ AND SATP; SAOD 15%; EV 35%.
function unitedCarAugRows(eff) {
  const out = [];
  const emit = (o) => out.push(row({ product: 'CAR', sheet_name: CAR_SHEET, effective_from: eff, ...o }));
  const famRows = (fam, rt, ageMin, ageMax, coverLabel) => {
    fam.forEach((band, i) => {
      const lo = ccLo(fam, i), hi = band.maxCc;
      for (const [code, name] of STATES) {
        emit({ region: name, segment: `Private Car ${coverLabel} ${lo}-${hi == null ? 'up' : hi}cc`,
          fuel_type: null, cc_band_min: lo, cc_band_max: hi, age_band_min: ageMin, age_band_max: ageMax,
          rate_type: rt, rate_value: carBandRate(band, code) });
      }
    });
  };
  famRows(CAR_AUG.bundled, 'COMP', 0, 0, 'Bundled 1+3');                    // brand-new comprehensive
  famRows(CAR_AUG.package, 'COMP', 1, null, 'Package');                     // renewal/rollover comprehensive
  famRows(CAR_AUG.package, 'SATP', null, null, 'SATP');                     // standalone TP (same ladder)
  emit({ region: null, segment: 'Private Car SAOD', rate_type: 'SAOD', rate_value: CAR_AUG.saod });
  emit({ region: null, segment: 'Private Car Electric (all covers)', fuel_type: 'ELECTRIC', rate_type: 'COMP', rate_value: CAR_AUG.ev });
  emit({ region: null, segment: 'Private Car Electric (all covers)', fuel_type: 'ELECTRIC', rate_type: 'SATP', rate_value: CAR_AUG.ev });
  // Preferred-city RTOs → 40% (all segments EXCEPT diesel<=1500). One row per RTO
  // (region=RTO code) so buildLucaBuffer fills included_rto; the merge collapses them.
  for (const r0 of (PREF.rtos || [])) {
    emit({ region: r0, segment: 'Private Car Preferred RTO (40% except diesel<=1500)', rate_type: 'COMP', rate_value: CAR_AUG.preferred });
    emit({ region: r0, segment: 'Private Car Preferred RTO (40% except diesel<=1500)', rate_type: 'SATP', rate_value: CAR_AUG.preferred });
  }
  return out;
}
// GCV (eff Aug'26) enumerated: one row per state × GVW band (+ E-Cart).
function unitedGcvAugRows(eff) {
  const out = [];
  const emit = (o) => out.push(row({ product: 'GCV', sheet_name: GCV_SHEET, rate_type: 'COMP', effective_from: eff, ...o }));
  const subAnn2 = new Set((GCV_AUG.subAnn2Rj || []).map((s) => String(s).toUpperCase()));
  GCV_AUG.bands.forEach((band, i) => {
    const loKg = i === 0 ? 1 : (GCV_AUG.bands[i - 1].maxKg + 1);
    const seg = `GCV ${Math.round(loKg)}-${band.maxKg == null ? 'up' : band.maxKg}kg`;
    for (const [code, name] of STATES) {
      let r;
      if (band.all != null) r = band.all;
      else {
        const hit = (band.rules || []).find((x) => x.st.includes(code));
        r = hit ? hit.r : band.other;
      }
      // weight bands stored in TONNES (export scales ×1000)
      emit({ region: name, segment: seg, weight_band_min: loKg === 1 ? null : loKg / 1000, weight_band_max: band.maxKg == null ? null : band.maxKg / 1000, rate_value: r });
    }
    // Rajasthan Sub-Annexure-2 RTOs override for the 2000-3500 band — one row per RTO.
    const rjRule = (band.rules || []).find((x) => x.subAnn2 && x.st.includes('RJ'));
    if (rjRule) {
      for (const r0 of subAnn2) {
        emit({ region: r0, segment: seg + ' (Sub-Ann2 RJ)', weight_band_min: loKg === 1 ? null : loKg / 1000,
          weight_band_max: band.maxKg == null ? null : band.maxKg / 1000, rate_value: rjRule.subAnn2 });
      }
    }
  });
  out.push(row({ product: 'GCV', sheet_name: GCV_SHEET, segment: 'GCV E-Cart', rate_type: 'COMP', rate_value: GCV_AUG.eCart, effective_from: eff }));
  return out;
}
const _isAug = (eff) => String(eff || '').slice(0, 10) >= '2026-08-01';

const CAR_SHEET = 'Pvt Car Commission Structure (May26)';
const GCV_SHEET = 'GCV Sub Annexure-2 Preferred RTO (May26)';
const PCV_SHEET = 'PCV Commission Structure (May26)';

// PCV (eff Aug'26) enumerated: 4W >6-pax PCC(seat)×state bands, Taxi (Package/SATP)
// ×state, Educational/Staff/School buses 62.5%, 2W-PCV 10%, 3W tiered by state.
function unitedPcvAugRows(eff) {
  const out = [];
  const emit = (o) => out.push(row({ product: 'PCV', sheet_name: PCV_SHEET, rate_type: 'COMP', effective_from: eff, ...o }));
  const inSet = (key, code) => (PCV_AUG.stateSets[key] || []).includes(code);
  // 4W PCV > 6 passengers — one row per PCC band × state.
  PCV_AUG.pcv4w.bands.forEach((band, i) => {
    const lo = i === 0 ? 7 : (PCV_AUG.pcv4w.bands[i - 1].maxPcc + 1);
    const seg = `PCV 4W >6 pax (${lo}-${band.maxPcc == null ? 'up' : band.maxPcc} seats)`;
    for (const [code, name] of STATES) {
      const r = band.all != null ? band.all : (inSet(band.set, code) ? band.inR : band.outR);
      emit({ region: name, segment: seg, rate_value: r });
    }
  });
  emit({ region: null, segment: 'PCV 4W >6 pax Electric (>20 seats)', fuel_type: 'ELECTRIC', rate_value: PCV_AUG.pcv4w.evPcc20 });
  // Taxi (<=6 pax) — Package + SATP per state.
  for (const [code, name] of STATES) {
    const hit = inSet(PCV_AUG.taxi.set, code);
    emit({ region: name, segment: 'PCV Taxi (<=6 pax) Package', rate_type: 'COMP', rate_value: hit ? PCV_AUG.taxi.package.inR : PCV_AUG.taxi.package.outR });
    emit({ region: name, segment: 'PCV Taxi (<=6 pax) SATP', rate_type: 'SATP', rate_value: hit ? PCV_AUG.taxi.satp.inR : PCV_AUG.taxi.satp.outR });
  }
  // Educational/Staff/School buses, 2W-PCV.
  emit({ region: null, segment: 'PCV Educational/Staff/School Bus', rate_value: PCV_AUG.buses });
  emit({ region: null, segment: 'PCV Two-Wheeled', rate_value: PCV_AUG.twoWheeled });
  // 3-Wheeled PCV — MP 25%, 60%-tier states, else 40%.
  for (const [code, name] of STATES) {
    const r = code === 'MP' ? 0.25 : (PCV3W_AUG_60.has(code) ? 0.60 : 0.40);
    emit({ region: name, segment: 'PCV 3-Wheeled', rate_value: r });
  }
  return out;
}
const PCV3W_AUG_60 = new Set(['WB', 'MH', 'GJ', 'DL', 'UK', 'PB', 'GA', 'JK']);

/** Shape a pseudo rate_rules row (the fields buildLucaBuffer reads). */
function row(o) {
  return {
    insurer: 'united_india_insurance',
    product: o.product || null,
    sheet_name: o.sheet_name || null,
    region: o.region || null,
    segment: o.segment || null,
    make: o.make || null,
    model: null,
    sub_type: null,
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
    state: null,
    effective_from: o.effective_from || null,
  };
}

// ---------------------------------------------------------------------------
// PRIVATE CAR
// ---------------------------------------------------------------------------

// The 7 makes the grid carves OUT of Segment B (">2500cc EXCEPT ...") — for them
// a >2500cc car falls back to Segment C. Same list gates the Electric line: a
// big-make EV follows the normal fuel/make segment, not United's flat EV line.
const BIG_MAKES = ['Tata', 'Maruti', 'Mahindra', 'Toyota', 'Hyundai', 'Honda', 'Kia'];

// Concrete fuel x cc scopes that partition United's Pvt-Car segment logic.
// `probeCc` is a value strictly inside the band, used to interrogate the resolver.
const CAR_SCOPES = [
  { fuel: 'DIESEL',   cc: [1, 1500],    probeCc: 1200, label: 'Diesel Upto 1500 CC' },
  { fuel: 'DIESEL',   cc: [1501, 2500], probeCc: 2000, label: 'Diesel 1501-2500 CC' },
  { fuel: 'DIESEL',   cc: [2501, null], probeCc: 3000, label: 'Diesel Above 2500 CC' },
  { fuel: 'PETROL',   cc: [1, 2500],    probeCc: 1200, label: 'Petrol Upto 2500 CC' },
  { fuel: 'PETROL',   cc: [2501, null], probeCc: 3000, label: 'Petrol Above 2500 CC' },
  { fuel: 'CNG',      cc: [1, 2500],    probeCc: 1200, label: 'CNG Upto 2500 CC' },
  { fuel: 'CNG',      cc: [2501, null], probeCc: 3000, label: 'CNG Above 2500 CC' },
  { fuel: 'ELECTRIC', cc: [null, null], probeCc: 0,    label: 'Electric' },
];

// Cover legs. COMP is kept as TWO named lines even when the rates coincide (they
// do inside a preferred RTO, both 40%) because Bundled 1+3 vs annual Package is a
// coverage_type distinction (hybrid vs comprehensive) the export reads off the
// segment text. SAOD/SATP collapse on age when the rate is age-invariant.
const CAR_COVERS = [
  { rt: 'COMP', ip: 'COMP', ages: [{ age: 0, band: [0, 0], label: 'Bundled 1+3 (Brand New)' }] },
  { rt: 'COMP', ip: 'COMP', ages: [{ age: 3, band: [1, null], label: 'Package (Renewal/Rollover)' }] },
  { rt: 'SAOD', ip: 'SAOD', ages: [{ age: 0, band: [0, 0], label: 'SAOD Brand New' },
                                   { age: 3, band: [1, null], label: 'SAOD Renewal/Rollover' }],
    flat: 'SAOD' },
  { rt: 'SATP', ip: 'TP',   ages: [{ age: 0, band: [0, 0], label: 'SATP Brand New' },
                                   { age: 3, band: [1, null], label: 'SATP Renewal/Rollover' }],
    flat: 'SATP' },
];

// Probe RTOs. 'WB01' is NOT in Sub Annexure-3 and is not a KL code, so it reads
// the plain (non-preferred) grid. Kerala is "all KL except KL15", which cannot be
// enumerated as codes — emit it as one named region and probe with KL01.
const NON_PREF_PROBE = 'WB01';
const KERALA_REGION = 'Kerala (all RTOs except KL15)';
const PREF_REGIONS = [
  ...(PREF.rtos || []).map((r) => ({ region: r, probe: r })),
  { region: KERALA_REGION, probe: 'KL01' },
];

function carRate(scope, make, ip, age, rtoCode, eff) {
  return resolveUnitedCarRate({
    vehicleType: 'CAR',
    fuelType: scope.fuel,
    cc: scope.probeCc,
    make: make || null,
    insProduct: ip,
    vehicleAge: age,
    rtoCode,
    effective_date: eff || null,   // so date-gated rules (EV 35% from Sept'26) resolve
  });
}

/**
 * Emit the rows for one (scope x make x region) cell, collapsing the age
 * dimension on SAOD/SATP when the rate does not move with age.
 * `baselines` = the same cell resolved at every MORE-GENERAL level (make=null
 * and/or region=null). A row is emitted only where it differs from ALL of them —
 * if any more-general row already states this rate, the specific row adds nothing.
 */
function carCell(scope, make, regionLabel, probeRto, eff, baselines) {
  const bases = (Array.isArray(baselines) ? baselines : [baselines]).filter(Boolean);
  const out = [];
  for (const cover of CAR_COVERS) {
    const vals = cover.ages.map((a) => carRate(scope, make, cover.ip, a.age, probeRto, eff));
    if (vals.some((v) => v == null)) continue;
    const flat = cover.flat && vals.every((v) => v === vals[0]);
    const legs = flat
      ? [{ band: [null, null], label: cover.flat, value: vals[0] }]
      : cover.ages.map((a, i) => ({ band: a.band, label: a.label, value: vals[i] }));
    for (const leg of legs) {
      const key = cover.rt + '|' + leg.label + '|' + leg.band.join(':');
      if (bases.some((b) => b.get(key) === leg.value)) continue;   // collapse: a general row already says this
      out.push(row({
        product: 'CAR',
        sheet_name: CAR_SHEET,
        region: regionLabel,
        segment: `Private Car ${scope.label} ${leg.label}`,
        make: make || null,
        fuel_type: scope.fuel,
        cc_band_min: scope.cc[0],
        cc_band_max: scope.cc[1],
        age_band_min: leg.band[0],
        age_band_max: leg.band[1],
        rate_type: cover.rt,
        rate_value: leg.value,
        effective_from: eff,
      }));
    }
  }
  return out;
}

/** Index a cell's resolved values so the more-specific level can collapse against it. */
function carCellMap(scope, make, probeRto, eff) {
  const m = new Map();
  for (const cover of CAR_COVERS) {
    const vals = cover.ages.map((a) => carRate(scope, make, cover.ip, a.age, probeRto, eff));
    if (vals.some((v) => v == null)) continue;
    const flat = cover.flat && vals.every((v) => v === vals[0]);
    if (flat) m.set(cover.rt + '|' + cover.flat + '|:', vals[0]);
    else cover.ages.forEach((a, i) => m.set(cover.rt + '|' + a.label + '|' + a.band.join(':'), vals[i]));
  }
  return m;
}

function unitedCar(eff) {
  if (_isAug(eff)) return unitedCarAugRows(eff);   // revised CC×state grid eff 01-08-2026
  const out = [];
  for (const scope of CAR_SCOPES) {
    // (1) pan-India, any make outside the 7 → the general row.
    const genMap = carCellMap(scope, null, NON_PREF_PROBE, eff);
    out.push(...carCell(scope, null, null, NON_PREF_PROBE, eff, null));

    // (2) the 7 carve-out makes, pan-India — only where the make actually moves
    //     the rate (>2500cc Segment B→C, and the Electric line → Segment C).
    const mkGenMap = {};
    for (const mk of BIG_MAKES) {
      mkGenMap[mk] = carCellMap(scope, mk, NON_PREF_PROBE, eff);
      out.push(...carCell(scope, mk, null, NON_PREF_PROBE, eff, genMap));
    }

    // (3) Sub Annexure-3 preferred RTOs — 40% for every segment EXCEPT Diesel
    //     <=1500cc and except SATP. Emitted per make level, collapsed against
    //     that make's own pan-India row.
    //     that make's own pan-India row. A make row inside a preferred RTO is
    //     collapsed against the RTO's OWN no-make row (not the pan-India one):
    //     once the region already says 40%, naming the make adds nothing. Only
    //     the big-make EVs survive here — a non-big-make EV keeps the flat
    //     Electric line in a preferred city, a big-make EV takes Segment C → 40%.
    for (const pr of PREF_REGIONS) {
      const prMap = carCellMap(scope, null, pr.probe, eff);
      out.push(...carCell(scope, null, pr.region, pr.probe, eff, genMap));
      for (const mk of BIG_MAKES) {
        // Collapse against BOTH the RTO's no-make row and the make's pan-India
        // row. The latter matters for SATP, which the preferred-RTO 40% never
        // touches — its rate is region-invariant, so the pan-India make row
        // already covers every preferred RTO.
        out.push(...carCell(scope, mk, pr.region, pr.probe, eff, [prMap, mkGenMap[mk]]));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// GCV — Sub Annexure-2 preferred RTOs only (the DB base grid is NOT suppressed).
// Bands are read as [0,2], (2,3.5], (3.5,7.5] because resolveUnitedGcvRate
// returns on the FIRST band whose maxTonnes covers the tonnage.
// ---------------------------------------------------------------------------
const GCV_BAND_META = [
  { max: 2.0, min: null, probe: 1.5, label: 'GCV Upto 2T' },
  { max: 3.5, min: 2.0,  probe: 3.0, label: 'GCV Above 2T Upto 3.5T' },
  { max: 7.5, min: 3.5,  probe: 5.0, label: 'GCV Above 3.5T Upto 7.5T' },
];

function unitedGcv(eff) {
  if (_isAug(eff)) return unitedGcvAugRows(eff);   // full revised GVW×state grid eff 01-08-2026
  const out = [];
  const bands = GCV_PREF.bands || [];
  for (let i = 0; i < bands.length && i < GCV_BAND_META.length; i++) {
    const meta = GCV_BAND_META[i];
    if (Number(bands[i].maxTonnes) !== meta.max) continue;   // config drifted → skip, never guess
    for (const rto of (bands[i].rtos || [])) {
      // Ask the resolver rather than trusting bands[i].rate, so the emitted value
      // is exactly what routes/bulk.js clones onto the rule pool.
      const v = resolveUnitedGcvRate({ vehicleType: 'GCV', tonnage: meta.probe, rtoCode: rto });
      if (v == null) continue;
      out.push(row({
        product: 'GCV',
        sheet_name: GCV_SHEET,
        region: rto,
        segment: meta.label,
        weight_band_min: meta.min,
        weight_band_max: meta.max,
        rate_type: 'COMP',
        rate_value: v,
        effective_from: eff,
      }));
    }
  }
  return out;
}

module.exports = {
  insurer: 'united_india_insurance',
  // Suppress ONLY the Private Car rows of the commission-structure PDF ingest.
  // Scoped by BOTH the sheet name and product because this insurer ingests every
  // product under the SAME sheet_name (the PDF filename) — TW / PCV / GCV / MIS /
  // CPA rows are live and must survive.
  suppress: [
    // Pvt-Car, GCV AND PCV are now fully re-expanded from the Aug'26 grid (config-
    // driven), so drop ALL PDF-ingested CAR + GCV + PCV rate rows regardless of
    // sheet_name (the PDF filename varies per card, and old rows carry stale
    // segment/EV rates). TW / MIS / CPA rows are unchanged and stay live.
    (r) => /^(CAR|4W|PVT\s*CAR|PVTCAR|GCV|GCCV|GOODS|PCV|PCCV|PASSENGER)$/i.test(String(r.product || '').trim()),
  ],
  expand: (effFrom) => [...unitedCar(effFrom), ...unitedGcv(effFrom), ...unitedPcv(effFrom)],
  // exported for verification
  unitedCar, unitedGcv, unitedPcv,
};

// PCV: revised grid from 01-08-2026; before that, leave the ingested PCV rows
// (only the 3W override existed pre-Aug, applied at pricing time by bulk.js).
function unitedPcv(eff) {
  return _isAug(eff) ? unitedPcvAugRows(eff) : [];
}
