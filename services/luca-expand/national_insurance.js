'use strict';

/**
 * National Insurance (national_insurance) → Luca export expansion.
 *
 * WHY: National's motor grid is a hand-authored TWO-LEG (OD, TP) table living in
 * config/national_motor.json, resolved at calculation time by
 * services/national-motor.js (hooked in routes/bulk.js ~5488 for CAR / TW / GCV
 * / PCV / MISC). The PDF ingest (card 555, "Remuneration and Reward Scheme
 * Q1 FY2026-27") stored only the Remuneration leg — not Reward, and never
 * summed — and it dropped every dimension: all 20 CAR rows carry the same
 * identity (segment 'Pvt Car', region 'Pan India', NO age band) with
 * CONFLICTING values (0.05 / 0.10 / 0.20). Same for GCV/PCV/MISC/TW. Those rows
 * are rates the engine never pays, so the whole sheet is suppressed and rebuilt
 * from the config exactly as the resolver reads it.
 *
 * PAYOUT MODEL (mirrors `out()` in services/national-motor.js):
 *   SAOD → OD leg only
 *   SATP → TP leg only
 *   Package/Comp → legs EQUAL ? that single value : OD + TP  (the sum)
 * Config stores PERCENTS (25 = 25%), so every rate_value is /100.
 *
 * Age tier keys and the tonnage-band edges are replicated from the resolver:
 *   carTier  new=0 | o10 ≤10 | o15 ≤15 | g15 >15
 *   twTier   new=0 | o5 ≤5 | o10 ≤10 | o15 ≤15 | g15 >15
 *   gcvTier  new=0 | o10 ≤10 | o15 ≤15 | g15 >15
 *   tier5    new=0 | o5 ≤5 | o10 ≤10 | o15 ≤15 | g15 >15   (PCV 3W/taxi/bus, MISC tractor)
 *   le10/gt10 = ≤10yr / >10yr
 * Tonnage bands are TONNES and the LOWER band owns the shared edge (resolver
 * uses `ton <= x.max` on the first matching band).
 */

const CFG = require('../../config/national_motor.json');

const INSURER = 'national_insurance';
const SHEET = 'National Motor Remuneration+Reward (OD+TP)';
const REGION = 'Pan India';

/** Headline rate the engine pays for a Package/Comp cell: equal legs → single
 *  value, differing legs → the sum. Identical to `out()` in national-motor.js. */
const comp = (od, tp) => ((od || 0) === (tp || 0) ? (od || 0) : (od || 0) + (tp || 0));
const pct = (v) => +(Number(v) / 100).toFixed(4);

function row(o) {
  return {
    insurer: INSURER,
    product: o.product || null,
    sheet_name: SHEET,
    region: REGION,
    segment: o.segment || null,
    make: null,
    model: null,
    sub_type: o.sub_type || null,
    fuel_type: null,
    cc_band_min: null,
    cc_band_max: null,
    age_band_min: o.age_band_min == null ? null : o.age_band_min,
    age_band_max: o.age_band_max == null ? null : o.age_band_max,
    weight_band_min: o.weight_band_min == null ? null : o.weight_band_min,
    weight_band_max: o.weight_band_max == null ? null : o.weight_band_max,
    rate_type: o.rate_type,
    rate_value: pct(o.rate_pct),
    remarks: o.remarks || null,
    state: null,
    effective_from: o.effective_from || null,
  };
}

// Age tier → [min, max] band, per tier-key set used by each section.
const BANDS_CAR = { new: [0, 0], o10: [1, 10], o15: [11, 15], g15: [16, null] };
const BANDS_5   = { new: [0, 0], o5: [1, 5], o10: [6, 10], o15: [11, 15], g15: [16, null] };
const LE10 = [0, 10];
const GT10 = [11, null];

/**
 * Emit COMP + SAOD rows for a { tierKey: [od, tp] } package table. Used only by
 * sections WITHOUT a dedicated saod_od table (PCV, MISC) — there the resolver
 * falls through to the package cell and pays the OD leg alone for SAOD.
 */
function packageRows(eff, product, segment, tiers, bands) {
  const out = [];
  for (const key of Object.keys(bands)) {
    const legs = tiers[key];
    if (!legs) continue;
    const [od, tp] = legs;
    const [amin, amax] = bands[key];
    const base = { product, segment, age_band_min: amin, age_band_max: amax, effective_from: eff };
    out.push(row({ ...base, rate_type: 'COMP', rate_pct: comp(od, tp) }));
    out.push(row({ ...base, rate_type: 'SAOD', rate_pct: od }));
  }
  return out;
}

function expand(eff) {
  const out = [];

  // ---- Private Car -------------------------------------------------------
  // CAR has its OWN saod_od / satp_tp tables that the resolver checks BEFORE
  // the package table, so do not derive SAOD from the package OD leg here.
  {
    const c = CFG.car;
    const seg = 'Private Car';
    for (const key of Object.keys(BANDS_CAR)) {
      const [od, tp] = c.package[key];
      const [amin, amax] = BANDS_CAR[key];
      out.push(row({ product: 'CAR', segment: seg, rate_type: 'COMP', rate_pct: comp(od, tp),
        age_band_min: amin, age_band_max: amax, effective_from: eff }));
    }
    out.push(row({ product: 'CAR', segment: seg, rate_type: 'SAOD', rate_pct: c.saod_od.le10,
      age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'CAR', segment: seg, rate_type: 'SAOD', rate_pct: c.saod_od.gt10,
      age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));
    out.push(row({ product: 'CAR', segment: seg, rate_type: 'SATP', rate_pct: c.satp_tp.le10,
      age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'CAR', segment: seg, rate_type: 'SATP', rate_pct: c.satp_tp.gt10,
      age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));
  }

  // ---- Two Wheeler -------------------------------------------------------
  {
    const c = CFG.tw;
    const seg = 'Two Wheeler';
    for (const key of Object.keys(BANDS_5)) {
      const [od, tp] = c.package[key];
      const [amin, amax] = BANDS_5[key];
      out.push(row({ product: 'TW', segment: seg, rate_type: 'COMP', rate_pct: comp(od, tp),
        age_band_min: amin, age_band_max: amax, effective_from: eff }));
    }
    out.push(row({ product: 'TW', segment: seg, rate_type: 'SAOD', rate_pct: c.saod_od.le10,
      age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'TW', segment: seg, rate_type: 'SAOD', rate_pct: c.saod_od.gt10,
      age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));
    out.push(row({ product: 'TW', segment: seg, rate_type: 'SATP', rate_pct: c.satp_tp.le10,
      age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'TW', segment: seg, rate_type: 'SATP', rate_pct: c.satp_tp.gt10,
      age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));
  }

  // ---- GCV ---------------------------------------------------------------
  // Package bands and SATP bands have DIFFERENT tonnage edges — emit each from
  // its own table. GCV has no SAOD table, so SAOD = the package OD leg.
  {
    const label = (lo, hi) => (hi == null ? `GCV Above ${lo}T` : `GCV ${lo}T-${hi}T`);
    let lo = 0;
    for (const b of CFG.gcv.package_bands) {
      const hi = b.max;
      const seg = label(lo, hi);
      for (const key of Object.keys(BANDS_CAR)) {
        const [od, tp] = b[key];
        const [amin, amax] = BANDS_CAR[key];
        const base = { product: 'GCV', segment: seg, weight_band_min: lo, weight_band_max: hi,
          age_band_min: amin, age_band_max: amax, effective_from: eff };
        out.push(row({ ...base, rate_type: 'COMP', rate_pct: comp(od, tp) }));
        out.push(row({ ...base, rate_type: 'SAOD', rate_pct: od }));
      }
      lo = hi;
    }
    lo = 0;
    for (const b of CFG.gcv.satp_tp_bands) {
      const hi = b.max;
      const seg = label(lo, hi);
      out.push(row({ product: 'GCV', segment: seg, rate_type: 'SATP', rate_pct: b.le10,
        weight_band_min: lo, weight_band_max: hi,
        age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
      out.push(row({ product: 'GCV', segment: seg, rate_type: 'SATP', rate_pct: b.gt10,
        weight_band_min: lo, weight_band_max: hi,
        age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));
      lo = hi;
    }
  }

  // ---- PCV ---------------------------------------------------------------
  {
    const c = CFG.pcv;

    // School / Educational bus: ≤10yr vs >10yr, no tier table.
    out.push(row({ product: 'PCV', segment: 'School Bus', rate_type: 'COMP',
      rate_pct: comp(c.school.le10[0], c.school.le10[1]),
      age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'PCV', segment: 'School Bus', rate_type: 'SAOD', rate_pct: c.school.le10[0],
      age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'PCV', segment: 'School Bus', rate_type: 'COMP',
      rate_pct: comp(c.school.gt10[0], c.school.gt10[1]),
      age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));
    out.push(row({ product: 'PCV', segment: 'School Bus', rate_type: 'SAOD', rate_pct: c.school.gt10[0],
      age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));
    out.push(row({ product: 'PCV', segment: 'School Bus', rate_type: 'SATP', rate_pct: c.school.satp_tp,
      effective_from: eff }));

    // Passenger 3-Wheeler / Auto (flat SATP across ages).
    out.push(...packageRows(eff, 'PCV', 'PCV Passenger 3 Wheeler', c.three_wheeler.tiers, BANDS_5));
    out.push(row({ product: 'PCV', segment: 'PCV Passenger 3 Wheeler', rate_type: 'SATP',
      rate_pct: c.three_wheeler.satp_tp, effective_from: eff }));

    // Taxi ≤6 seats.
    out.push(...packageRows(eff, 'PCV', 'PCV Taxi Upto 6 Seats', c.taxi_le6.tiers, BANDS_5));
    out.push(row({ product: 'PCV', segment: 'PCV Taxi Upto 6 Seats', rate_type: 'SATP',
      rate_pct: c.taxi_le6.satp_tp.le10, age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'PCV', segment: 'PCV Taxi Upto 6 Seats', rate_type: 'SATP',
      rate_pct: c.taxi_le6.satp_tp.gt10, age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));

    // Bus / passenger carrier 7-30 seats.
    out.push(...packageRows(eff, 'PCV', 'PCV Bus 7 to 30 Seats', c.seat_6_30.tiers, BANDS_5));
    out.push(row({ product: 'PCV', segment: 'PCV Bus 7 to 30 Seats', rate_type: 'SATP',
      rate_pct: c.seat_6_30.satp_tp.le10, age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'PCV', segment: 'PCV Bus 7 to 30 Seats', rate_type: 'SATP',
      rate_pct: c.seat_6_30.satp_tp.gt10, age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));

    // Bus >30 seats — flat, age-independent.
    out.push(row({ product: 'PCV', segment: 'PCV Bus Above 30 Seats', rate_type: 'COMP',
      rate_pct: comp(c.seat_gt30.flat[0], c.seat_gt30.flat[1]), effective_from: eff }));
    out.push(row({ product: 'PCV', segment: 'PCV Bus Above 30 Seats', rate_type: 'SAOD',
      rate_pct: c.seat_gt30.flat[0], effective_from: eff }));
    out.push(row({ product: 'PCV', segment: 'PCV Bus Above 30 Seats', rate_type: 'SATP',
      rate_pct: c.seat_gt30.satp_tp, effective_from: eff }));
  }

  // ---- MISC --------------------------------------------------------------
  {
    const c = CFG.misc;

    // Ambulance: ≤10 / ≤15 / >15, flat SATP.
    const amb = [['le10', [0, 10]], ['le15', [11, 15]], ['gt15', [16, null]]];
    for (const [key, [amin, amax]] of amb) {
      const [od, tp] = c.ambulance[key];
      out.push(row({ product: 'MISC', segment: 'MISC Ambulance', rate_type: 'COMP', rate_pct: comp(od, tp),
        age_band_min: amin, age_band_max: amax, effective_from: eff }));
      out.push(row({ product: 'MISC', segment: 'MISC Ambulance', rate_type: 'SAOD', rate_pct: od,
        age_band_min: amin, age_band_max: amax, effective_from: eff }));
    }
    out.push(row({ product: 'MISC', segment: 'MISC Ambulance', rate_type: 'SATP',
      rate_pct: c.ambulance.satp_tp, effective_from: eff }));

    // Agricultural tractor. The resolver routes E-Rickshaw / E-Cart carrying a
    // MISC vehicleType through this same table, but naming them in the segment
    // would flip inferVehicleType to PCV, so the segment stays tractor-only and
    // the sharing is noted in remarks.
    const TRAC = 'MISC Agricultural Tractor';
    out.push(...packageRows(eff, 'MISC', TRAC, c.tractor.tiers, BANDS_5)
      .map((r) => ({ ...r, remarks: 'Same tiers apply to MISC-class E-Rickshaw / E-Cart' })));
    out.push(row({ product: 'MISC', segment: TRAC, rate_type: 'SATP', rate_pct: c.tractor.satp_tp.le10,
      age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'MISC', segment: TRAC, rate_type: 'SATP', rate_pct: c.tractor.satp_tp.gt10,
      age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));

    // Class E/F/G — flat, age-independent.
    out.push(row({ product: 'MISC', segment: 'MISC Class E/F/G', rate_type: 'COMP',
      rate_pct: comp(c.class_efg.flat[0], c.class_efg.flat[1]), effective_from: eff }));
    out.push(row({ product: 'MISC', segment: 'MISC Class E/F/G', rate_type: 'SAOD',
      rate_pct: c.class_efg.flat[0], effective_from: eff }));
    out.push(row({ product: 'MISC', segment: 'MISC Class E/F/G', rate_type: 'SATP',
      rate_pct: c.class_efg.satp_tp, effective_from: eff }));

    // Other Misc Class D: new / ≤10 / ≤15 / >15.
    const oth = [['new', [0, 0]], ['le10', [1, 10]], ['le15', [11, 15]], ['gt15', [16, null]]];
    for (const [key, [amin, amax]] of oth) {
      const [od, tp] = c.other[key];
      out.push(row({ product: 'MISC', segment: 'MISC Other Class D', rate_type: 'COMP', rate_pct: comp(od, tp),
        age_band_min: amin, age_band_max: amax, effective_from: eff }));
      out.push(row({ product: 'MISC', segment: 'MISC Other Class D', rate_type: 'SAOD', rate_pct: od,
        age_band_min: amin, age_band_max: amax, effective_from: eff }));
    }
    out.push(row({ product: 'MISC', segment: 'MISC Other Class D', rate_type: 'SATP',
      rate_pct: c.other.satp_tp.le10, age_band_min: LE10[0], age_band_max: LE10[1], effective_from: eff }));
    out.push(row({ product: 'MISC', segment: 'MISC Other Class D', rate_type: 'SATP',
      rate_pct: c.other.satp_tp.gt10, age_band_min: GT10[0], age_band_max: GT10[1], effective_from: eff }));
  }

  return out;
}

module.exports = {
  insurer: INSURER,
  // The ONLY National sheet is the Q1 FY26-27 Remuneration+Reward PDF ingest,
  // and services/national-motor.js overrides every product it carries
  // (CAR/TW/GCV/PCV/MISC). Suppress it wholesale — its rows are un-summed
  // single legs with no age/tonnage dimensions and conflicting duplicates.
  suppress: [
    (r) => /Remuneration[_\s]*and[_\s]*Reward[_\s]*Scheme/i.test(String(r.sheet_name || '')),
  ],
  expand,
};
