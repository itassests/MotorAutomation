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

const CAR_SHEET = 'Pvt Car Commission Structure (May26)';
const GCV_SHEET = 'GCV Sub Annexure-2 Preferred RTO (May26)';

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

function carRate(scope, make, ip, age, rtoCode) {
  return resolveUnitedCarRate({
    vehicleType: 'CAR',
    fuelType: scope.fuel,
    cc: scope.probeCc,
    make: make || null,
    insProduct: ip,
    vehicleAge: age,
    rtoCode,
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
    const vals = cover.ages.map((a) => carRate(scope, make, cover.ip, a.age, probeRto));
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
function carCellMap(scope, make, probeRto) {
  const m = new Map();
  for (const cover of CAR_COVERS) {
    const vals = cover.ages.map((a) => carRate(scope, make, cover.ip, a.age, probeRto));
    if (vals.some((v) => v == null)) continue;
    const flat = cover.flat && vals.every((v) => v === vals[0]);
    if (flat) m.set(cover.rt + '|' + cover.flat + '|:', vals[0]);
    else cover.ages.forEach((a, i) => m.set(cover.rt + '|' + a.label + '|' + a.band.join(':'), vals[i]));
  }
  return m;
}

function unitedCar(eff) {
  const out = [];
  for (const scope of CAR_SCOPES) {
    // (1) pan-India, any make outside the 7 → the general row.
    const genMap = carCellMap(scope, null, NON_PREF_PROBE);
    out.push(...carCell(scope, null, null, NON_PREF_PROBE, eff, null));

    // (2) the 7 carve-out makes, pan-India — only where the make actually moves
    //     the rate (>2500cc Segment B→C, and the Electric line → Segment C).
    const mkGenMap = {};
    for (const mk of BIG_MAKES) {
      mkGenMap[mk] = carCellMap(scope, mk, NON_PREF_PROBE);
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
      const prMap = carCellMap(scope, null, pr.probe);
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
    (r) => /commission_structure\.pdf$/i.test(String(r.sheet_name || ''))
        && /^(CAR|4W|PVT\s*CAR|PVTCAR)$/i.test(String(r.product || '').trim()),
  ],
  expand: (effFrom) => [...unitedCar(effFrom), ...unitedGcv(effFrom)],
  // exported for verification
  unitedCar, unitedGcv,
};
