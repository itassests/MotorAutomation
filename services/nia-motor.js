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
 * The OD%/TP% numbers live in config/nia_motor.json (editable without code
 * changes when the circular is revised); this function only holds the matching
 * logic (state uplift, age bands, tonnage bands, cover-type leg selection).
 *
 * @param {object} p extractPolicyParams output (vehicleType, vehicleAge,
 *        insProduct, tonnage, vehicleCategory, fuelType, ...)
 * @returns {number|null} commission percentage, or null if not handled.
 */
const CFG = require('../config/nia_motor.json');

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

  // Age → package band key (identical semantics to the former if/else chain:
  // age 0 = new vehicle; 1–10 = upto_10yr; >10 OR unknown age = above_10yr).
  const bandKey = (age === 0) ? 'new_vehicle'
                : (age != null && age <= 10) ? 'upto_10yr' : 'above_10yr';
  const saodKey = (age != null && age > 10) ? 'above_10yr' : 'upto_10yr';

  let od = null, tp = null;          // commission legs (percent)

  if (vt === 'CAR' || vt === '4W' || vt === 'PC' || vt === 'PVT.CAR') {
    const c = CFG.car;
    // Regional OD-leg uplift: Maharashtra & Karnataka carry a HIGHER Pvt-Car
    // OD-commission leg (30 vs the 20 base) on Package/Comp policies (config
    // car.od_uplift_states / od_leg_uplift vs od_leg_base). BH-series (Bharat)
    // registrations (e.g. "23BH6979D") are NOT state-registered — their rtoCode
    // is a tracker-prefix fabrication, so the uplift must not apply.
    const stPfx = (String(p.rtoCode || '').toUpperCase().match(/^[A-Z]+/) || [''])[0];
    const isBhSeries = /^\d{2}\s*BH/i.test(String(p.vehicleRegNo || '').replace(/[\s-]/g, ''));
    const odLeg = (!isBhSeries && c.od_uplift_states.includes(stPfx)) ? c.od_leg_uplift : c.od_leg_base;
    const band = c.package[bandKey];
    od = (band.od === 'od_leg') ? odLeg : band.od;
    tp = band.tp;
    if (isSaod) { od = c.saod[saodKey]; tp = null; }
    if (isTp)   { od = null; tp = c.satp_tp; }
  } else if (vt === 'TW' || vt === '2W') {
    const c = CFG.tw, band = c.package[bandKey];
    od = band.od; tp = band.tp;
    if (isSaod) { od = c.saod[saodKey]; tp = null; }
    if (isTp)   { od = null; tp = c.satp_tp; }
  } else if (vt === 'GCV') {
    if (ton == null) return null;                  // can't pick weight band
    const band = CFG.gcv.bands.find((b) => ton > b.min_tonnage) || CFG.gcv.bands[CFG.gcv.bands.length - 1];
    const legs = (age === 0) ? band.new : band.old;
    od = legs.od; tp = legs.tp;
    if (isSaod) tp = null;                          // SAOD → OD only
    if (isTp)   od = null;                          // Stand-Alone TP = same TP%
  } else if (vt === 'PCV' || vt === 'MISC' || vt === 'MIS') {
    const c = CFG.pcv_misc;
    const cat = up(p.vehicleCategory);
    const isElectric = /ELECTRIC|\bEV\b|E-RICK|E RICK/.test(cat) || /ELECTRIC/.test(up(p.fuelType));
    if (/SCHOOL/.test(cat)) {                        // School / Institutional Buses
      od = c.school_bus.od; tp = c.school_bus.tp;
    } else if (isElectric && /BUS/.test(cat)) {      // Electric Bus PCV (C2)
      const legs = c.electric_bus[saodKey];          // >10yr → 0/2.5, else 10/2.5
      od = legs.od; tp = legs.tp;
    } else {                                          // Other Commercial Vehicles
      od = c.other.od; tp = c.other.tp;              //   (excl GCV / school bus / electric bus)
    }
    if (isSaod) tp = null;
    if (isTp)   od = null;
  } else {
    return null;                                      // unknown — not handled
  }

  // Headline = OD + TP when the two legs DIFFER; when they are EQUAL the operator
  // reports the single value (not the doubled sum) — per product owner: "OD + TP if
  // OD and TP are not same, otherwise only one." e.g. School/Institutional Bus
  // 60/60 → 60, GCV ≤2000 (age>0) 50/50 → 50. Single-leg covers (SAOD/SATP) report
  // that one leg. (income still = OD%×OD-prem + TP%×TP-prem via the per-leg od/tp.)
  let rate;
  if (od != null && tp != null) rate = (od === tp) ? od : (od + tp);
  else rate = (od != null) ? od : (tp != null ? tp : 0);
  // rate = summed headline (for operator rate-match); od/tp = per-leg commission
  // (% ) so income = OD%×OD-premium + TP%×TP-premium. Null leg → 0 (SATP/SAOD).
  return { rate, od: od || 0, tp: tp || 0 };
}

module.exports = { resolveNiaMotorRate };
