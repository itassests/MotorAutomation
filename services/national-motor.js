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
 * @param {object} p extractPolicyParams output.
 * @returns {number|null}
 */
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

  if (vt === 'CAR' || vt === '4W' || vt === 'PC' || vt === 'PVT.CAR') {
    if (isTp)   return out(0, (age != null && age > 10) ? 15 : 20);  // SATP ≤10=20 / >10=15
    if (isSaod) return out((age != null && age > 10) ? 5 : 20, 0);   // SAOD ≤10=20 / >10=5
    if (isNew)            return out(25, 25);                        // Bundled 1+3 New = 50
    if (age != null && age <= 10) return out(20, 20);               // Package ≤10 = 40
    if (age != null && age <= 15) return out(15, 17.5);             // Package >10-15 = 32.5
    return out(5, 10);                                              // Package >15 = 15
  }

  if (vt === 'TW' || vt === '2W') {
    if (isTp)   return out(0, (age != null && age > 10) ? 15 : 20);  // SATP ≤10=20 / >10=15
    if (isSaod) return out((age != null && age > 10) ? 5 : 25, 0);   // SAOD ≤10=25 / >10=5
    if (isNew)            return out(27.5, 30);                      // Bundled 1+5 New = 57.5
    if (age != null && age <= 5)  return out(20, 20);               // Package ≤5 = 40
    if (age != null && age <= 10) return out(20, 15);               // Package >5-10 = 35
    if (age != null && age <= 15) return out(15, 15);               // Package >10-15 = 30
    return out(10, 10);                                             // Package >15 = 20
  }

  if (vt === 'GCV') {
    if (ton == null) return null;
    // SATP TP-only bands (PDF groups 7500-34000 together).
    if (isTp) {
      const o10 = (age != null && age > 10);
      if (ton <= 3.5)  return out(0, o10 ? 30 : 40);
      if (ton <= 7.5)  return out(0, o10 ? 20 : 25);
      if (ton <= 34)   return out(0, o10 ? 10 : 15);
      if (ton <= 40)   return out(0, o10 ? 5 : 7.5);
      return out(0, 2.5);
    }
    // Package OD/TP by GVW band × age tier (New / Other≤10 / >10-15 / >15).
    const tier = isNew ? 'new' : (age == null || age <= 10) ? 'o10' : age <= 15 ? 'o15' : 'g15';
    const G = {
      // band: [New, Other≤10, >10-15, >15] each [od,tp]
      a: { new: [30, 45], o10: [25, 45], o15: [20, 30], g15: [5, 20] },   // ≤3.5T
      b: { new: [30, 30], o10: [20, 25], o15: [10, 20], g15: [5, 10] },   // 3.5-7.5T
      c: { new: [20, 20], o10: [15, 15], o15: [10, 15], g15: [10, 10] },  // 7.5-16.5T
      d: { new: [15, 17.5], o10: [15, 15], o15: [10, 10], g15: [10, 5] }, // 16.5-34T
      e: { new: [15, 7.5], o10: [10, 10], o15: [5, 7.5], g15: [2.5, 2.5] }, // 34-40T
      f: { new: [5, 2.5], o10: [5, 2.5], o15: [2.5, 2.5], g15: [0, 2.5] }, // 40-48T
      g: { new: [5, 2.5], o10: [2.5, 2.5], o15: [0, 2.5], g15: [0, 2.5] }, // >48T
    };
    const band = ton <= 3.5 ? 'a' : ton <= 7.5 ? 'b' : ton <= 16.5 ? 'c'
               : ton <= 34 ? 'd' : ton <= 40 ? 'e' : ton <= 48 ? 'f' : 'g';
    const [od, tp] = G[band][tier];
    return out(od, tp);
  }

  if (vt === 'PCV') {
    const is3W = /3\s*W|3\s*WHEEL|RICK|RIKSH|AUTO/.test(cat);
    const isSchool = /SCHOOL|EDUCATION/.test(cat);
    const isBus = /BUS/.test(cat);
    const o10 = (age != null && age > 10);
    // School / Educational / Institutional buses.
    if (isSchool) {
      if (isTp)   return out(0, 45);                                 // SATP school = 45
      if (isNew || (age != null && age <= 10)) return out(50, 50);  // 100
      return out(35, 35);                                           // >10 = 70
    }
    // Seating-based 4W PCV (Taxi ≤6, 6-30, >30) — use seating when present.
    const tier5 = isNew ? 'new' : (age == null || age <= 5) ? 'o5' : age <= 10 ? 'o10' : age <= 15 ? 'o15' : 'g15';
    if (is3W) {
      if (isTp) return out(0, 10);
      const T = { new: [30, 35], o5: [25, 25], o10: [20, 25], o15: [5, 20], g15: [0, 5] };
      const [od, tp] = T[tier5]; return out(od, tp);
    }
    if (seat != null && seat <= 6) {                                 // Taxi
      if (isTp) return out(0, o10 ? 7.5 : 10);
      const T = { new: [20, 15], o5: [20, 15], o10: [17.5, 12.5], o15: [10, 10], g15: [5, 5] };
      const [od, tp] = T[tier5]; return out(od, tp);
    }
    if (seat != null && seat > 6 && seat <= 30) {                    // 6-30 pax
      if (isTp) return out(0, o10 ? 5 : 10);
      const T = { new: [15, 15], o5: [15, 15], o10: [12.5, 12.5], o15: [7.5, 10], g15: [0, 7.5] };
      const [od, tp] = T[tier5]; return out(od, tp);
    }
    if (seat != null && seat > 30) {                                 // >30 pax
      if (isTp) return out(0, 2.5);
      return out(2.5, 2.5);
    }
    // 2W PCV / fallback bus without seating.
    if (isBus) {                                                     // generic bus → 6-30 default
      if (isTp) return out(0, o10 ? 5 : 10);
      const T = { new: [15, 15], o5: [15, 15], o10: [12.5, 12.5], o15: [7.5, 10], g15: [0, 7.5] };
      const [od, tp] = T[tier5]; return out(od, tp);
    }
    return null;                                                     // can't classify (no seating)
  }

  if (vt === 'MISC' || vt === 'MIS') {
    const o10 = (age != null && age > 10);
    const isTractor = /TRACTOR|E[-\s]?RICK|E[-\s]?CART|RICKSHAW/.test(cat) ||
                      /TRACTOR/.test(up(p.model) + ' ' + up(p.make));
    const isAmbulance = /AMBULANCE/.test(cat);
    const isClassEFG = /CLASS\s*[EFG]/.test(cat);
    if (isAmbulance) {
      if (isTp) return out(0, 5);
      if (age == null || age <= 10) return out(15, 5);
      if (age <= 15) return out(10, 5);
      return out(5, 5);
    }
    if (isTractor) {                                                 // Agri tractor / E-rick / E-cart
      if (isTp) return out(0, o10 ? 10 : 15);
      const tier5 = isNew ? 'new' : (age == null || age <= 5) ? 'o5' : age <= 10 ? 'o10' : age <= 15 ? 'o15' : 'g15';
      const T = { new: [35, 35], o5: [25, 25], o10: [20, 25], o15: [7.5, 10], g15: [7.5, 10] };
      const [od, tp] = T[tier5]; return out(od, tp);
    }
    if (isClassEFG) {
      if (isTp) return out(0, 5);
      return out(10, 5);
    }
    // Other Misc Class D.
    if (isTp) return out(0, o10 ? 5 : 10);
    if (isNew) return out(20, 10);
    if (age == null || age <= 10) return out(15, 10);
    if (age <= 15) return out(10, 7.5);
    return out(5, 5);
  }

  return null;
}

module.exports = { resolveNationalMotorRate };
