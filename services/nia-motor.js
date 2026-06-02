'use strict';

/**
 * New India Assurance (new_india_assurance) motor commission interpreter.
 *
 * GROUND TRUTH: the Q1 FY2026-27 Commission & Incentive circulars (both the
 * Agents/POSP card and the Brokers/Web-Aggregators card carry IDENTICAL motor
 * OD%/TP% tables, so channel is irrelevant). New India publishes commission as
 * TWO legs — an OD-commission % (applied to OD premium) and a TP-commission %
 * (applied to TP premium). The operator's payout tracker reports the headline
 * rate as the SUM of the two legs:
 *     Comprehensive/Package : OD% + TP%
 *     Stand-Alone TP (SATP) : TP% only
 *     Stand-Alone OD (SAOD) : OD% only
 * (e.g. Pvt-Car 1-10yr Package = 20 + 15 = 35; TW new bundled 1+5 = 30 + 10 =
 *  40; GCV >7500 = 10 + 2.5 = 12.5; GCV 2-7.5T Other = 35 + 25 = 60.)
 *
 * Returns the target percentage (e.g. 35 → 35, downstream divides by 100 when
 * cloning rate_value), or null when this interpreter doesn't cover the policy
 * (PCV/MISC/unknown) so the caller leaves the existing rule untouched.
 *
 * @param {object} p extractPolicyParams output (vehicleType, vehicleAge,
 *        insProduct, tonnage, vehicleCategory, fuelType, ...)
 * @returns {number|null} commission percentage, or null if not handled.
 */
function resolveNiaMotorRate(p) {
  const up = (v) => String(v == null ? '' : v).toUpperCase();
  const vt  = up(p.vehicleType);
  const ip  = up(p.insProduct);
  const age = (p.vehicleAge != null && p.vehicleAge !== '') ? Number(p.vehicleAge) : null;
  const ton = (p.tonnage != null && p.tonnage !== '') ? Number(p.tonnage) : null;

  // Cover-type flags. insProduct is Comp / SAOD / TP / SATP / ACT.
  const isSaod = ip === 'SAOD' || ip === 'OD';
  const isTp   = ip === 'TP' || ip === 'SATP' || ip === 'ACT' || ip === 'LIABILITY';
  const isComp = !isSaod && !isTp;   // Comp / Package / Bundled / blank → both legs

  let od = null, tp = null;          // commission legs (percent)

  if (vt === 'CAR' || vt === '4W' || vt === 'PC' || vt === 'PVT.CAR') {
    if (age === 0)        { od = 25; tp = 15; }   // New vehicle – Bundled (1+3)
    else if (age != null && age <= 10) { od = 20; tp = 15; } // 1–10 yr Package
    else                  { od = 20; tp = 12.5; } // Above 10 yr
    if (isSaod) { od = (age != null && age > 10) ? 5 : 20; tp = null; }
    if (isTp)   { od = null; tp = 15; }            // Stand-Alone TP = 15 flat
  } else if (vt === 'TW' || vt === '2W') {
    if (age === 0)        { od = 30; tp = 10; }   // New vehicle – Bundled (1+5)
    else if (age != null && age <= 10) { od = 25; tp = 10; } // 1–10 yr Package
    else                  { od = 25; tp = 7.5; }  // Above 10 yr
    if (isSaod) { od = (age != null && age > 10) ? 5 : 20; tp = null; }
    if (isTp)   { od = null; tp = 10; }            // Stand-Alone TP = 10 flat
  } else if (vt === 'GCV') {
    if (ton == null) return null;                  // can't pick weight band
    if (ton > 7.5)        { od = 10; tp = 2.5; }   // GVW > 7500 KGS — all vehicles
    else if (ton > 2)     { if (age === 0) { od = 40; tp = 25; } else { od = 35; tp = 25; } } // 2000–7500
    else                  { if (age === 0) { od = 55; tp = 50; } else { od = 50; tp = 50; } } // ≤2000
    if (isSaod) tp = null;                          // SAOD → OD only
    if (isTp)   od = null;                          // Stand-Alone TP = same TP%
  } else if (vt === 'PCV' || vt === 'MISC' || vt === 'MIS') {
    const cat = up(p.vehicleCategory);
    const isElectric = /ELECTRIC|\bEV\b|E-RICK|E RICK/.test(cat) || /ELECTRIC/.test(up(p.fuelType));
    if (/SCHOOL/.test(cat)) {                        // School / Institutional Buses
      od = 60; tp = 60;
    } else if (isElectric && /BUS/.test(cat)) {      // Electric Bus PCV (C2)
      if (age != null && age > 10) { od = 0; tp = 2.5; } else { od = 10; tp = 2.5; }
    } else {                                          // Other Commercial Vehicles
      od = 15; tp = 2.5;                              //   (excl GCV / school bus / electric bus)
    }
    if (isSaod) tp = null;
    if (isTp)   od = null;
  } else {
    return null;                                      // unknown — not handled
  }

  let rate = 0;
  if (od != null) rate += od;
  if (tp != null) rate += tp;
  // rate = summed headline (for operator rate-match); od/tp = per-leg commission
  // (% ) so income = OD%×OD-premium + TP%×TP-premium. Null leg → 0 (SATP/SAOD).
  return { rate, od: od || 0, tp: tp || 0 };
}

module.exports = { resolveNiaMotorRate };
