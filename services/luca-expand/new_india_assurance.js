'use strict';

/**
 * NEW INDIA ASSURANCE (new_india_assurance) — config → Luca export rows.
 *
 * WHY THIS EXISTS (routes/bulk.js ~5451, services/nia-motor.js):
 * New India publishes motor commission as TWO LEGS — an OD% (on the OD premium)
 * and a TP% (on the TP premium). The Q1 FY2026-27 circular PDF was ingested with
 * each leg as its OWN rate_rules row, all carrying the SAME identity: e.g. Pvt
 * Car has two rows `product=CAR, segment='Pvt Car', rate_type='COMP'` valued
 * 0.20 (the OD leg) and 0.15 (the TP leg) with nothing in the row to tell them
 * apart. bulk.js therefore REPLACES the whole motor pool with the resolver's
 * answer (`rules = [clone, ...]`), because the engine otherwise "surfaced only
 * ONE leg (e.g. the OD 20 for a Pvt-Car package, vs the operator's 35 = 20+15)".
 * Those DB leg-rows are rates the engine never pays → suppressed below.
 *
 * SOURCE: config/nia_motor.json (PERCENTS — divided by 100 here), mirroring
 * services/nia-motor.js resolveNiaMotorRate() exactly:
 *   headline = OD + TP when the legs DIFFER; when they are EQUAL the operator
 *   reports the single value (School Bus 60/60 → 60, GCV ≤2T old 50/50 → 50).
 *   SAOD → OD leg only. SATP → TP leg only.
 *   Age bands: 0 = new_vehicle, 1-10 = upto_10yr, 11+ = above_10yr
 *   (SAOD bands only split at 10: age ≤10 → upto_10yr).
 *   GCV bands: first band with tonnage STRICTLY greater than min_tonnage wins
 *   (config order 7.5 → 2 → 0), so: >7.5T, >2T..7.5T, >0..2T. new = age 0.
 *
 * Pan-India: car.od_uplift_states is EMPTY in the config (the MH/KA OD uplift
 * was reverted to the circular base on 2026-07-01), so every state resolves to
 * od_leg_base=20 → no state dimension is emitted. If the uplift is ever
 * re-enabled in the config, this file must grow per-state CAR rows.
 *
 * DELIBERATELY LEFT OUT (reported as unresolved):
 *   - GCV ≤2T BRAND NEW Package: headline = 55 + 50 = 105%. The export's pct()
 *     treats any rate_value ≥ 1 as an ALREADY-percent value (1.05 → "1.05%"), so
 *     a 105% headline cannot be represented — it would print a 1.05% rate to the
 *     agent. Omitted; the SAOD (55) and SATP (50) legs of that cell are emitted
 *     normally, as is the ≤2T old-vehicle Package (50).
 *   - MISC / vehicleType 'MIS': the resolver pays these the pcv_misc.other
 *     15/2.5 cell, but lucaProduct() maps every non-auto MISC row to the 'gcv'
 *     product — a 17.5% row would sit in the file next to the REAL GCV rows
 *     (12.5 / 60 / 65) under the same product label. Not expressible → omitted.
 *   - GCV with unknown tonnage: the resolver returns null (no band) and the DB
 *     rows are suppressed, so those policies are simply absent.
 *   - CPA (product='CPA', 1 DB row): not a vehicle type, no resolver override →
 *     the DB row is NOT suppressed and stands on its own.
 */

const CFG = require('../../config/nia_motor.json');

const SHEET = 'New India Q1 FY2026-27 Commission Circular (OD+TP legs)';
const has = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const pctToFrac = (v) => +(Number(v) / 100).toFixed(4);   // config stores PERCENT

function row(o) {
  return {
    insurer: 'new_india_assurance',
    product: o.product || null,
    sheet_name: o.sheet_name || SHEET,
    region: o.region || null,
    segment: o.segment || null,
    make: o.make || null,
    model: o.model || null,
    sub_type: o.sub_type || null,
    fuel_type: o.fuel_type || null,
    cc_band_min: null, cc_band_max: null,
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

/** resolveNiaMotorRate()'s headline rule, verbatim: legs equal → the single
 *  value; legs differ → the sum; single-leg covers → that leg. */
function headline(od, tp) {
  if (od != null && tp != null) return (od === tp) ? od : (od + tp);
  if (od != null) return od;
  if (tp != null) return tp;
  return 0;
}

/** Emit the COMP / SAOD / SATP triple for one two-leg cell.
 *  `skipComp` drops only the Package leg (used for the 105% GCV ≤2T new cell). */
function legs(base, od, tp, out, skipComp) {
  if (!skipComp && (has(od) || has(tp))) {
    const h = headline(has(od) ? Number(od) : null, has(tp) ? Number(tp) : null);
    if (h < 100) out.push(row({ ...base, rate_type: 'COMP', rate_value: pctToFrac(h) }));
  }
  if (has(od)) out.push(row({ ...base, rate_type: 'SAOD', rate_value: pctToFrac(od) }));
  if (has(tp)) out.push(row({ ...base, rate_type: 'SATP', rate_value: pctToFrac(tp) }));
}

// ---------------------------------------------------------------------------
// Private Car — CFG.car
// ---------------------------------------------------------------------------
function car(eff) {
  const out = [];
  const c = CFG.car;
  // od_uplift_states is empty → odLeg is always od_leg_base (see header note).
  const odLeg = (c.od_uplift_states || []).length ? null : c.od_leg_base;
  if (odLeg == null) return out;      // uplift re-enabled → per-state, not handled
  const base = { product: 'CAR', effective_from: eff,
                 remarks: 'New India circular — Pvt Car OD leg + TP leg (headline = OD+TP)' };
  const leg = (b) => (b.od === 'od_leg' ? odLeg : b.od);

  const nb = c.package.new_vehicle;
  const u10 = c.package.upto_10yr;
  const a10 = c.package.above_10yr;

  // Package (Comp). SAOD/SATP for cars come from their OWN config cells
  // (c.saod / c.satp_tp), NOT from the package legs — the resolver overrides
  // both — so only the COMP leg is emitted from the package bands.
  out.push(row({ ...base, segment: 'Private Car Brand New (1+3 Bundled)',
                 age_band_min: 0, age_band_max: 0, rate_type: 'COMP',
                 rate_value: pctToFrac(headline(leg(nb), nb.tp)) }));
  out.push(row({ ...base, segment: 'Private Car', age_band_min: 1, age_band_max: 10,
                 rate_type: 'COMP', rate_value: pctToFrac(headline(leg(u10), u10.tp)) }));
  out.push(row({ ...base, segment: 'Private Car', age_band_min: 11, age_band_max: null,
                 rate_type: 'COMP', rate_value: pctToFrac(headline(leg(a10), a10.tp)) }));

  // SAOD — own cell, split at age 10 (resolver saodKey: age > 10 → above_10yr).
  out.push(row({ ...base, segment: 'Private Car', age_band_min: 0, age_band_max: 10,
                 rate_type: 'SAOD', rate_value: pctToFrac(c.saod.upto_10yr),
                 remarks: 'New India circular — Pvt Car Stand-Alone OD (OD leg only)' }));
  out.push(row({ ...base, segment: 'Private Car', age_band_min: 11, age_band_max: null,
                 rate_type: 'SAOD', rate_value: pctToFrac(c.saod.above_10yr),
                 remarks: 'New India circular — Pvt Car Stand-Alone OD (OD leg only)' }));
  // SATP — own cell, all ages.
  out.push(row({ ...base, segment: 'Private Car', rate_type: 'SATP',
                 rate_value: pctToFrac(c.satp_tp),
                 remarks: 'New India circular — Pvt Car Stand-Alone TP (TP leg only)' }));
  return out;
}

// ---------------------------------------------------------------------------
// Two Wheeler — CFG.tw (identical shape to CFG.car, no state uplift)
// ---------------------------------------------------------------------------
function tw(eff) {
  const out = [];
  const c = CFG.tw;
  const base = { product: 'TW', effective_from: eff,
                 remarks: 'New India circular — Two Wheeler OD leg + TP leg (headline = OD+TP)' };
  const nb = c.package.new_vehicle, u10 = c.package.upto_10yr, a10 = c.package.above_10yr;

  out.push(row({ ...base, segment: 'Two Wheeler Brand New (1+5 Bundled)',
                 age_band_min: 0, age_band_max: 0, rate_type: 'COMP',
                 rate_value: pctToFrac(headline(nb.od, nb.tp)) }));
  out.push(row({ ...base, segment: 'Two Wheeler', age_band_min: 1, age_band_max: 10,
                 rate_type: 'COMP', rate_value: pctToFrac(headline(u10.od, u10.tp)) }));
  out.push(row({ ...base, segment: 'Two Wheeler', age_band_min: 11, age_band_max: null,
                 rate_type: 'COMP', rate_value: pctToFrac(headline(a10.od, a10.tp)) }));
  out.push(row({ ...base, segment: 'Two Wheeler', age_band_min: 0, age_band_max: 10,
                 rate_type: 'SAOD', rate_value: pctToFrac(c.saod.upto_10yr),
                 remarks: 'New India circular — Two Wheeler Stand-Alone OD (OD leg only)' }));
  out.push(row({ ...base, segment: 'Two Wheeler', age_band_min: 11, age_band_max: null,
                 rate_type: 'SAOD', rate_value: pctToFrac(c.saod.above_10yr),
                 remarks: 'New India circular — Two Wheeler Stand-Alone OD (OD leg only)' }));
  out.push(row({ ...base, segment: 'Two Wheeler', rate_type: 'SATP',
                 rate_value: pctToFrac(c.satp_tp),
                 remarks: 'New India circular — Two Wheeler Stand-Alone TP (TP leg only)' }));
  return out;
}

// ---------------------------------------------------------------------------
// GCV — CFG.gcv.bands (first band with tonnage > min_tonnage wins)
// The band's tonnage SCOPE is (min_tonnage, previous band's min_tonnage].
// Segment text carries an explicit LCV/HCV token so lucaProduct() splits the
// light/heavy classes correctly (its tonnage sniff reads the segment digits and
// would call "Above 7.5T" an LCV).
// ---------------------------------------------------------------------------
function gcv(eff) {
  const out = [];
  const bands = (CFG.gcv && CFG.gcv.bands) || [];
  // config order is DESCENDING by min_tonnage; upper bound = the previous entry's min.
  const sorted = bands.slice().sort((a, b) => b.min_tonnage - a.min_tonnage);
  sorted.forEach((b, i) => {
    const lo = Number(b.min_tonnage);
    const hi = i === 0 ? null : Number(sorted[i - 1].min_tonnage);
    const heavy = hi == null || hi > 7.5;
    const label = hi == null ? `Above ${lo}T` : (lo === 0 ? `Upto ${hi}T` : `${lo}T-${hi}T`);
    const seg = `GCV ${heavy ? 'HCV' : 'LCV'} ${label}`;
    const base = { product: 'GCV', segment: seg, weight_band_min: lo, weight_band_max: hi,
                   effective_from: eff,
                   remarks: `New India circular — GCV ${label} OD leg + TP leg (headline = OD+TP)` };
    const same = b.new && b.old && b.new.od === b.old.od && b.new.tp === b.old.tp;
    if (same) {
      // Age is not a dimension for this band — emit once, all ages.
      legs(base, b.new.od, b.new.tp, out, headline(b.new.od, b.new.tp) >= 100);
    } else {
      if (b.new) legs({ ...base, age_band_min: 0, age_band_max: 0, segment: seg + ' Brand New' },
                      b.new.od, b.new.tp, out, headline(b.new.od, b.new.tp) >= 100);
      if (b.old) legs({ ...base, age_band_min: 1, age_band_max: null },
                      b.old.od, b.old.tp, out, headline(b.old.od, b.old.tp) >= 100);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// PCV — CFG.pcv_misc. The resolver keys off vehicleCategory:
//   /SCHOOL/ → school_bus; electric AND /BUS/ → electric_bus; else → other.
// MISC ('MIS') vehicles also take `other`, but are NOT emitted (see header).
// ---------------------------------------------------------------------------
function pcv(eff) {
  const out = [];
  const c = CFG.pcv_misc || {};
  if (c.school_bus) {
    legs({ product: 'PCV', segment: 'School Bus', effective_from: eff,
           remarks: 'New India circular — School / Institutional Bus (OD leg = TP leg = 60 → headline 60)' },
         c.school_bus.od, c.school_bus.tp, out);
  }
  if (c.electric_bus) {
    const eb = { product: 'PCV', segment: 'Electric Bus', fuel_type: 'ELECTRIC',
                 effective_from: eff,
                 remarks: 'New India circular — Electric Bus OD leg + TP leg (headline = OD+TP)' };
    const u = c.electric_bus.upto_10yr, a = c.electric_bus.above_10yr;
    if (u) legs({ ...eb, age_band_min: 0, age_band_max: 10 }, u.od, u.tp, out);
    if (a) legs({ ...eb, age_band_min: 11, age_band_max: null }, a.od, a.tp, out);
  }
  if (c.other) {
    legs({ product: 'PCV', segment: 'Other Commercial Passenger Vehicle', effective_from: eff,
           remarks: 'New India circular — Other Commercial Vehicles (excl GCV / school bus / electric bus)' },
         c.other.od, c.other.tp, out);
  }
  return out;
}

function expand(eff) {
  return [...car(eff), ...tw(eff), ...gcv(eff), ...pcv(eff)];
}

module.exports = {
  insurer: 'new_india_assurance',
  // The Q1 FY2026-27 circular PDF is the ONLY ingested sheet, and its motor rows
  // are single OD/TP LEGS that bulk.js replaces wholesale for every vehicle type
  // the resolver covers (CAR / TW / GCV / PCV / MIS). The CPA row on the same
  // sheet has no resolver override → deliberately NOT matched.
  suppress: [
    (r) => /Incentive_and_Commission_Structure/i.test(String(r.sheet_name || ''))
        && /^(CAR|TW|GCV|PCV|MISC?)$/i.test(String(r.product || '').trim()),
  ],
  expand,
  // exported for tests
  car, tw, gcv, pcv, headline,
};
