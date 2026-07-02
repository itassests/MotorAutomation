'use strict';

/**
 * National Insurance (national_insurance) motor commission interpreter.
 *
 * GROUND TRUTH: "Remuneration and Reward Scheme Q1 FY2026-27" (card 407). Motor
 * commission is published as TWO legs — an OD leg and a TP leg — and each leg's
 * "Commission" column = Remuneration + Reward. The operator's payout tracker
 * reports the SUM of the two Commission legs (USER-confirmed "consider OD+TP"):
 *     Comprehensive / Package / Bundled / LT : OD-commission + TP-commission
 *     Stand-Alone TP (SATP)                  : TP-commission only
 *     Stand-Alone OD (SAOD)                  : OD-commission only
 * The ingested grid stored only the Remuneration leg (no Reward, not summed),
 * so the engine surfaced one undervalued leg (e.g. GCV ≤3.5T Other≤10 → 0.20
 * vs operator 70 = OD 25 + TP 45).
 *
 * Returns the summed target percentage (number), or null when not covered.
 * Age tiers use vehicleAge; GVW bands use tonnage (in TONNES; PDF kg→T:
 * 3500=3.5, 7500=7.5, 16500=16.5, 34000=34, 40000=40, 48000=48).
 *
 * The OD%/TP% numbers live in config/national_motor.json (editable without code
 * changes when the circular is revised); this function only holds the matching
 * logic (age tiers, GVW bands, seating tiers, cover-type leg selection).
 *
 * @param {object} p extractPolicyParams output.
 * @returns {number|null}
 */
const CFG = require('../config/national_motor.json');

function resolveNationalMotorRate(p) {
  const up = (v) => String(v == null ? '' : v).toUpperCase();
  const vt  = up(p.vehicleType);
  const ip  = up(p.insProduct);
  const cat = up(p.vehicleCategory);
  const age = (p.vehicleAge != null && p.vehicleAge !== '') ? Number(p.vehicleAge) : null;
  const ton = (p.tonnage != null && p.tonnage !== '') ? Number(p.tonnage) : null;
  const seat = (p.seatingCapacity != null && p.seatingCapacity !== '') ? Number(p.seatingCapacity) : null;

  const odPrem = Number(p.odPremium != null ? p.odPremium : p.od_premium) || 0;
  const tpPrem = Number(p.tpPremium != null ? p.tpPremium : p.tp_premium) || 0;
  const isSaod = ip === 'SAOD' || ip === 'OD' || (tpPrem === 0 && odPrem > 0);
  const isTp   = ip === 'TP' || ip === 'SATP' || ip === 'ACT' || ip === 'LIABILITY' || (odPrem === 0 && tpPrem > 0);
  const isNew  = age === 0;

  // National pays per the two Commission legs (OD, TP):
  //   SAOD → OD leg, SATP → TP leg.
  //   Comp/Package → if the two legs are EQUAL, pay that single value; if they
  //   DIFFER, pay the SUM (OD + TP). USER-confirmed across CAR (20/20→20),
  //   PCV Taxi (20/15→35), GCV ≤3.5T (25/45→70), GCV mid (15/15→15), GCV
  //   16.5-34T New (15/17.5→32.5). (The earlier premium-blend was wrong.)
  // out(od, tp) → { rate, od, tp }: `rate` is the headline for operator
  // rate-matching (SAOD→OD leg, SATP→TP leg, Comp→equal legs pay the single
  // value, differing legs pay the SUM); `od`/`tp` are the per-leg commission %
  // for the OD%-on-OD-premium + TP%-on-TP-premium income calc. For SATP the OD
  // leg is 0 (TP-only) and vice-versa.
  const out = (od, tp) => {
    od = od || 0; tp = tp || 0;
    if (isSaod) return { rate: od, od, tp: 0 };
    if (isTp)   return { rate: tp, od: 0, tp };
    return { rate: (od === tp ? od : od + tp), od, tp };
  };

  const o10flag = (age != null && age > 10);   // ≤10yr vs >10yr split (unknown age = ≤10)
  // Age → package tier key. Which tiers a section uses (and how unknown age
  // falls) differs per section, so each keeper below picks the matching helper.
  const carTier = isNew ? 'new' : (age != null && age <= 10) ? 'o10' : (age != null && age <= 15) ? 'o15' : 'g15';
  const twTier  = isNew ? 'new' : (age != null && age <= 5) ? 'o5' : (age != null && age <= 10) ? 'o10' : (age != null && age <= 15) ? 'o15' : 'g15';
  const gcvTier = isNew ? 'new' : (age == null || age <= 10) ? 'o10' : age <= 15 ? 'o15' : 'g15';
  const tier5   = isNew ? 'new' : (age == null || age <= 5) ? 'o5' : age <= 10 ? 'o10' : age <= 15 ? 'o15' : 'g15';

  if (vt === 'CAR' || vt === '4W' || vt === 'PC' || vt === 'PVT.CAR') {
    const c = CFG.car;
    if (isTp)   return out(0, o10flag ? c.satp_tp.gt10 : c.satp_tp.le10);   // SATP ≤10=20 / >10=15
    if (isSaod) return out(o10flag ? c.saod_od.gt10 : c.saod_od.le10, 0);   // SAOD ≤10=20 / >10=5
    return out(c.package[carTier][0], c.package[carTier][1]);               // Package by age tier
  }

  if (vt === 'TW' || vt === '2W') {
    const c = CFG.tw;
    if (isTp)   return out(0, o10flag ? c.satp_tp.gt10 : c.satp_tp.le10);   // SATP ≤10=20 / >10=15
    if (isSaod) return out(o10flag ? c.saod_od.gt10 : c.saod_od.le10, 0);   // SAOD ≤10=25 / >10=5
    return out(c.package[twTier][0], c.package[twTier][1]);                 // Package by age tier
  }

  if (vt === 'GCV') {
    if (ton == null) return null;
    // SATP TP-only bands (first band whose max ≥ tonnage; last = open-ended).
    if (isTp) {
      const b = CFG.gcv.satp_tp_bands.find((x) => x.max == null || ton <= x.max);
      return out(0, o10flag ? b.gt10 : b.le10);
    }
    // Package OD/TP by GVW band × age tier (New / Other≤10 / >10-15 / >15).
    const b = CFG.gcv.package_bands.find((x) => x.max == null || ton <= x.max);
    return out(b[gcvTier][0], b[gcvTier][1]);
  }

  if (vt === 'PCV') {
    const c = CFG.pcv;
    const is3W = /3\s*W|3\s*WHEEL|RICK|RIKSH|AUTO/.test(cat);
    const isSchool = /SCHOOL|EDUCATION/.test(cat);
    const isBus = /BUS/.test(cat);
    // School / Educational / Institutional buses.
    if (isSchool) {
      if (isTp)   return out(0, c.school.satp_tp);                   // SATP school = 45
      const legs = (isNew || (age != null && age <= 10)) ? c.school.le10 : c.school.gt10;
      return out(legs[0], legs[1]);                                 // ≤10 = 100, >10 = 70
    }
    if (is3W) {
      if (isTp) return out(0, c.three_wheeler.satp_tp);
      const t = c.three_wheeler.tiers[tier5]; return out(t[0], t[1]);
    }
    if (seat != null && seat <= 6) {                                 // Taxi
      if (isTp) return out(0, o10flag ? c.taxi_le6.satp_tp.gt10 : c.taxi_le6.satp_tp.le10);
      const t = c.taxi_le6.tiers[tier5]; return out(t[0], t[1]);
    }
    if (seat != null && seat > 6 && seat <= 30) {                    // 6-30 pax
      if (isTp) return out(0, o10flag ? c.seat_6_30.satp_tp.gt10 : c.seat_6_30.satp_tp.le10);
      const t = c.seat_6_30.tiers[tier5]; return out(t[0], t[1]);
    }
    if (seat != null && seat > 30) {                                 // >30 pax
      if (isTp) return out(0, c.seat_gt30.satp_tp);
      return out(c.seat_gt30.flat[0], c.seat_gt30.flat[1]);
    }
    // Fallback bus without seating → 6-30 default.
    if (isBus) {
      if (isTp) return out(0, o10flag ? c.seat_6_30.satp_tp.gt10 : c.seat_6_30.satp_tp.le10);
      const t = c.seat_6_30.tiers[tier5]; return out(t[0], t[1]);
    }
    return null;                                                     // can't classify (no seating)
  }

  if (vt === 'MISC' || vt === 'MIS') {
    const c = CFG.misc;
    const isTractor = /TRACTOR|E[-\s]?RICK|E[-\s]?CART|RICKSHAW/.test(cat) ||
                      /TRACTOR/.test(up(p.model) + ' ' + up(p.make));
    const isAmbulance = /AMBULANCE/.test(cat);
    const isClassEFG = /CLASS\s*[EFG]/.test(cat);
    if (isAmbulance) {
      if (isTp) return out(0, c.ambulance.satp_tp);
      const legs = (age == null || age <= 10) ? c.ambulance.le10 : age <= 15 ? c.ambulance.le15 : c.ambulance.gt15;
      return out(legs[0], legs[1]);
    }
    if (isTractor) {                                                 // Agri tractor / E-rick / E-cart
      if (isTp) return out(0, o10flag ? c.tractor.satp_tp.gt10 : c.tractor.satp_tp.le10);
      const t = c.tractor.tiers[tier5]; return out(t[0], t[1]);
    }
    if (isClassEFG) {
      if (isTp) return out(0, c.class_efg.satp_tp);
      return out(c.class_efg.flat[0], c.class_efg.flat[1]);
    }
    // Other Misc Class D.
    if (isTp) return out(0, o10flag ? c.other.satp_tp.gt10 : c.other.satp_tp.le10);
    const legs = isNew ? c.other.new : (age == null || age <= 10) ? c.other.le10 : age <= 15 ? c.other.le15 : c.other.gt15;
    return out(legs[0], legs[1]);
  }

  return null;
}

module.exports = { resolveNationalMotorRate };
