/**
 * Bajaj Allianz SATP engines — base grid (Oct 2025) + overlay (6 Apr 2026).
 *
 *   sheet_kind: 'satp_pc'    — Pvt Car SATP (Petrol/Diesel/CNG per state)
 *   sheet_kind: 'satp_bike'  — TW Bike SATP per state
 *   sheet_kind: 'satp_scoot' — TW Scooter SATP per state
 *   sheet_kind: 'satp_cv'    — CV SATP per state × segment (weight bands)
 *   sheet_kind: 'satp_overlay' — Additional Cohorts (April overlay) —
 *                                Type|LOB|Segment|RTO_State|Rate columns
 *
 * "IRDA" cells use the firm-wide IRDA default (parsers/utils/irda-rates.js).
 */

const { irdaRateFor } = require('../utils/irda-rates');

function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Parse a rate cell — accepts decimal (0.355) or whole percent (45) or
 *  "IRDA" (use firm-wide default).  Returns { value, irda } where irda is
 *  true if cell was IRDA-flagged. */
function parseRateOrIrda(v) {
  if (v == null || v === '') return { value: null, irda: false, declined: false };
  const s = String(v).trim();
  if (/^irda$/i.test(s)) return { value: null, irda: true, declined: false };
  if (s === '' || s === '-') return { value: null, irda: false, declined: true };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (!m) return { value: null, irda: false, declined: false };
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return { value: null, irda: false, declined: false };
  return { value: n > 1 ? n / 100 : n, irda: false, declined: false };
}

function emit(rules, base, rateCellInfo, rateType, opts = {}) {
  let v = rateCellInfo.value;
  let isDecl = false;
  if (rateCellInfo.irda) v = irdaRateFor(rateType);
  if (rateCellInfo.declined || v == null) { v = null; isDecl = true; }

  // Per-fuel split — when the remark says "Applicable only on Petrol and
  // CNG", emit ONE rule per allowed fuel instead of a single fuel-agnostic
  // base rule. Without this, fuel restriction is lost on SATP rows.  When
  // no baseFuels is supplied, preserve the base rule's existing fuel_type
  // (e.g. Pvt Car SATP column emits per-fuel base rules).
  const fuels = opts.baseFuels && opts.baseFuels.length ? opts.baseFuels : [base.fuel_type ?? null];
  for (const f of fuels) {
    rules.push({
      ...base,
      fuel_type: f,
      rate_type: rateType,
      rate_value: v,
      is_declined: isDecl,
    });
  }
}

// ---------- Pvt Car SATP ----------
//
// Layout (sheet "Private Car SATP"):
//   R3 header: RTO-Statename | District | Petrol Rate | Petrol Comments
//                            | Diesel Rate | Diesel Comments
//                            | CNG Rate | CNG Comments
//   R4..: state rows
function parseSatpPC(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 4; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const state = cellOrNull(row[0]);
    if (!state) continue;
    if (/^irda rate means/i.test(state)) continue;
    const district = cellOrNull(row[1]);

    const fuels = [
      { fuel: 'Petrol', rate: row[2], remark: row[3] },
      { fuel: 'Diesel', rate: row[4], remark: row[5] },
      { fuel: 'CNG',    rate: row[6], remark: row[7] },
    ];

    for (const f of fuels) {
      const r = parseRateOrIrda(f.rate);
      const remark = cellOrNull(f.remark);
      const baseRule = {
        product: 'CAR',
        sheet_name: meta.sheetName,
        // District goes to region (→ City column); state stays in state.
        region: district || state,
        state: state,
        sub_type: null,
        segment: 'Pvt Car SATP',
        make: 'All',
        fuel_type: f.fuel,
        remarks: remark,
        rate_text: `${state}${district ? ' | ' + district : ''} | ${f.fuel}`,
      };
      emit(rules, baseRule, r, 'SATP');
      // Comments column carries make/model/RTO/district carve-outs.
      emitSatpRemarkRules(rules, baseRule, remark, r, 'SATP');
    }
  }
  return rules;
}

// ---------- TW Bike SATP ----------
function parseSatpBike(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 4; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const state = cellOrNull(row[0]);
    if (!state || /^irda rate means/i.test(state)) continue;
    const district = cellOrNull(row[1]);
    const rate = parseRateOrIrda(row[2]);
    const remark = cellOrNull(row[3]);
    const baseRule = {
      product: 'TW',
      sheet_name: meta.sheetName,
      region: district || state,
      state: state,
      sub_type: null,
      segment: 'Bike',
      make: 'All',
      remarks: remark,
      rate_text: `${state}${district ? ' | ' + district : ''}`,
    };
    const baseFuels = remark ? cvPlan(remark, rate).baseFuels : null;
    emit(rules, baseRule, rate, 'SATP', { baseFuels });
    emitSatpRemarkRules(rules, baseRule, remark, rate, 'SATP');
  }
  return rules;
}

// Lazy-load to avoid circular requires.
function cvPlan(remark, rateInfo) {
  const { analyzeCvRemark } = require('./bajaj-robinhood');
  const baseRate = rateInfo.irda ? irdaRateFor('SATP') : rateInfo.value;
  return analyzeCvRemark(remark, baseRate);
}

// ---------- TW Scooter SATP ----------
function parseSatpScooter(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 3; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const state = cellOrNull(row[0]);
    if (!state || /^irda rate means/i.test(state)) continue;
    const rate = parseRateOrIrda(row[1]);
    const remark = cellOrNull(row[2]);
    const baseRule = {
      product: 'TW',
      sheet_name: meta.sheetName,
      region: state, state: state,
      segment: 'Scooter',
      make: 'All',
      remarks: remark,
      rate_text: state,
    };
    const baseFuels = remark ? cvPlan(remark, rate).baseFuels : null;
    emit(rules, baseRule, rate, 'SATP', { baseFuels });
    emitSatpRemarkRules(rules, baseRule, remark, rate, 'SATP');
  }
  return rules;
}

/**
 * Apply the CV remark analyzer to SATP TW comments so make-specific lines
 * like "All KTM models and YAMAHA Make Bikes ... @25%" and "No PO for
 * Bajaj-Discover, ..." emit dedicated make-level rules alongside the base.
 */
function emitSatpRemarkRules(rules, baseRule, remark, rateInfo, rateType) {
  if (!remark) return;
  const { analyzeCvRemark } = require('./bajaj-robinhood');
  const baseRate = rateInfo.irda ? irdaRateFor(rateType) : rateInfo.value;
  const plan = analyzeCvRemark(remark, baseRate);

  // Declined cities (Kathua, Poonch, Rajouri, ...)
  for (const c of plan.declinedCities) {
    rules.push({
      ...baseRule,
      region: c, sub_type: null,
      rate_type: rateType, rate_value: null, is_declined: true,
      remarks: 'Declined Location',
    });
  }
  // Restricted cities @ N%
  for (const r of plan.restrictedCities) {
    rules.push({
      ...baseRule,
      region: r.city, sub_type: null,
      rate_type: rateType, rate_value: r.rate, is_declined: false,
      remarks: `Restricted @ ${(r.rate * 100).toFixed(0)}%`,
    });
  }
  // City-max ("Muzaffarpur - Max 20%")
  for (const c of plan.cityMaxes) {
    rules.push({
      ...baseRule,
      region: c.city, sub_type: null,
      rate_type: rateType, rate_value: c.rate, is_declined: false,
      remarks: `Max ${(c.rate * 100).toFixed(0)}%`,
    });
  }
  // Sub-region @ IRDA
  for (const sr of plan.subRegionRates) {
    rules.push({
      ...baseRule,
      region: sr.region, sub_type: null,
      rate_type: rateType,
      rate_value: sr.irda ? irdaRateFor(rateType) : sr.rate,
      is_declined: false,
      remarks: sr.irda ? `${sr.region} @ IRDA` : `${sr.region} @ ${(sr.rate * 100).toFixed(0)}%`,
    });
  }
  // Declined makes / models
  for (const dm of plan.declinedMakes) {
    const label = dm.bodyType ? dm.bodyType : `${dm.make || 'All'}${dm.model ? ' / ' + dm.model : ''}`;
    rules.push({
      ...baseRule,
      make: dm.make || 'All',
      model: dm.model || null,
      sub_type: dm.bodyType || null,
      fuel_type: dm.fuel || baseRule.fuel_type,
      rate_type: rateType,
      rate_value: dm.atIrda ? irdaRateFor(rateType) : null,
      is_declined: !dm.atIrda,
      remarks: dm.atIrda ? `${label} @ IRDA` : `Declined ${label}`,
    });
  }
  // Per-fuel rates ("Diesel restricted @ 15%")
  for (const fr of plan.fuelRates) {
    rules.push({
      ...baseRule,
      fuel_type: fr.fuel,
      rate_type: rateType, rate_value: fr.rate, is_declined: false,
      remarks: `${fr.fuel} restricted @ ${(fr.rate * 100).toFixed(0)}%`,
    });
  }
  // Per-make additional rates (KTM @25%, YAMAHA @25%)
  for (const mr of plan.extraMakeRates) {
    rules.push({
      ...baseRule,
      make: mr.make,
      rate_type: rateType,
      rate_value: mr.rate,
      is_declined: false,
      remarks: `${mr.make} @ ${(mr.rate * 100).toFixed(0)}%`,
    });
  }
  // No-PO RTO codes (Blocked @NO PAYOUT (MH34))
  for (const rto of plan.noPayoutRtos) {
    rules.push({
      ...baseRule,
      sub_type: rto,
      rate_type: rateType, rate_value: 0, is_declined: false,
      remarks: `Blocked NO PAYOUT (${rto})`,
    });
  }
  // No-PO city entries (Bareilly, Muzaffarnagar age≤5, etc.)
  for (const np of plan.noPayoutCities) {
    rules.push({
      ...baseRule,
      region: np.city, sub_type: null,
      rate_type: rateType, rate_value: 0, is_declined: false,
      vehicle_age_min: np.vehicle_age_max != null ? 0 : null,
      vehicle_age_max: np.vehicle_age_max != null ? np.vehicle_age_max : null,
      cc_band_min: np.cc_min != null ? np.cc_min : null,
      cc_band_max: np.cc_max != null ? np.cc_max : null,
      remarks: `No PO ${np.city}${np.vehicle_age_max != null ? ` (age ≤${np.vehicle_age_max})` : ''}${np.cc_max != null ? ` (CC ≤${np.cc_max})` : ''}${np.cc_min != null ? ` (CC ≥${np.cc_min})` : ''}`,
    });
  }
  // Bare "Declined" / "Decined" — mark the previously-emitted base rule.
  if (plan.fullyDeclined && rules.length) {
    const last = rules[rules.length - 1];
    last.rate_value = null;
    last.is_declined = true;
    last.remarks = 'Declined';
  }
  // OK-for RTOs + rest blocked
  if (plan.okRtos) {
    for (const rto of plan.okRtos.rtos) {
      rules.push({
        ...baseRule, sub_type: rto,
        rate_type: rateType,
        rate_value: baseRate,
        is_declined: false,
        remarks: `Ok ${rto} (continue at grid)`,
      });
    }
    rules.push({
      ...baseRule, sub_type: 'Others',
      rate_type: rateType, rate_value: 0, is_declined: false,
      remarks: 'Remaining RTOs @ NO PAYOUT',
    });
  }
  // Per-RTO custom rates
  for (const rr of plan.rtoRates) {
    rules.push({
      ...baseRule, sub_type: rr.rto,
      fuel_type: rr.fuel || null,
      rate_type: rateType, rate_value: rr.rate, is_declined: false,
      remarks: `${rr.rto}${rr.fuel ? ' ' + rr.fuel : ''} @ ${(rr.rate * 100).toFixed(2)}%`,
    });
  }
  // Per-RTO per-fuel block
  for (const rb of plan.fuelRtoBlock) {
    rules.push({
      ...baseRule, sub_type: rb.rto, fuel_type: rb.fuel,
      rate_type: rateType, rate_value: 0, is_declined: false,
      remarks: `${rb.rto} ${rb.fuel} Blocked @ NO PAYOUT`,
    });
  }
  // Model caps — only per-model rules.  Base 'All' rule already covers
  // 'other models' at the row rate, so no explicit Others row needed.
  if (plan.modelCaps.length) {
    for (const mc of plan.modelCaps) {
      rules.push({
        ...baseRule, make: mc.make, model: mc.model,
        rate_type: rateType, rate_value: mc.rate, is_declined: false,
        remarks: `Max ${(mc.rate * 100).toFixed(0)}% for ${mc.model}`,
      });
    }
  }
  // No-PO make/model entries (Bajaj-Discover @ 0%, etc.)
  for (const np of plan.noPayoutMakeModels) {
    rules.push({
      ...baseRule,
      make: np.make,
      model: np.model || null,
      rate_type: rateType,
      rate_value: 0,
      is_declined: false,
      remarks: `No PO ${np.make}${np.model ? ' / ' + np.model : ''}`,
    });
  }
  // Make-split ("Only TATA, others IRDA") — rare in SATP TW but handle defensively
  if (plan.makeSplit) {
    const { namedMake, namedRate, restAction } = plan.makeSplit;
    rules.push({
      ...baseRule, make: namedMake,
      rate_type: rateType,
      rate_value: namedRate != null ? namedRate : baseRate,
      is_declined: false,
      remarks: `Only ${namedMake}`,
    });
    if (restAction.type === 'irda') {
      rules.push({
        ...baseRule, make: 'Others',
        rate_type: rateType, rate_value: irdaRateFor(rateType),
        is_declined: false, remarks: 'Other makes @ IRDA',
      });
    }
  }
  // Model rates ("Innova Max 45%", "Swift Diesel - 20%")
  for (const mr of plan.modelRates) {
    rules.push({
      ...baseRule,
      make: mr.make, model: mr.model,
      fuel_type: mr.fuel || baseRule.fuel_type || null,
      rate_type: rateType,
      rate_value: mr.atIrda ? irdaRateFor(rateType) : mr.rate,
      is_declined: false,
      remarks: mr.atIrda
        ? `${mr.model} @ IRDA`
        : `${mr.model}${mr.fuel ? ' ' + mr.fuel : ''} ${(mr.rate * 100).toFixed(0)}%`,
    });
  }
  // Fuel × Model ("Diesel and CNG -Swift Max 25%")
  // When the column is fuel-scoped (Pvt Car SATP per-fuel comments), only
  // emit for fuels that intersect with the column fuel — avoids the SAME
  // remark in Diesel and CNG columns producing duplicate (fuel×model) rules.
  for (const fm of plan.fuelModelRates) {
    const colFuel = baseRule.fuel_type;
    const emitFuels = colFuel
      ? fm.fuels.filter(f => f.toLowerCase() === colFuel.toLowerCase())
      : fm.fuels;
    if (emitFuels.length === 0) continue;
    for (const f of emitFuels) {
      for (const md of fm.models) {
        rules.push({
          ...baseRule,
          fuel_type: f, make: md.make, model: md.model,
          rate_type: rateType, rate_value: fm.rate,
          is_declined: false,
          remarks: `${f} ${md.model} ${(fm.rate * 100).toFixed(0)}%`,
        });
      }
    }
  }
  // City × Model ("JAMMU-SCORPIO at Max 20%")
  for (const cm of plan.cityModelRates) {
    rules.push({
      ...baseRule,
      region: cm.city,
      make: cm.make, model: cm.model,
      rate_type: rateType, rate_value: cm.rate,
      is_declined: false,
      remarks: `${cm.city} / ${cm.model} ${(cm.rate * 100).toFixed(0)}%`,
    });
  }
  // Allowed-RTOs + fuel + rest @ IRDA
  if (plan.allowedRtosWithRest) {
    const { rtos, fuel, restAtIrda } = plan.allowedRtosWithRest;
    for (const rto of rtos) {
      rules.push({
        ...baseRule,
        sub_type: rto,
        fuel_type: fuel || baseRule.fuel_type || null,
        rate_type: rateType, rate_value: baseRate,
        is_declined: false,
        remarks: `${rto}${fuel ? ' (' + fuel + ' only)' : ''} @ row rate`,
      });
    }
    if (restAtIrda) {
      const irdaRate = irdaRateFor(rateType);
      // Skip Others when base rate already equals IRDA — base 'All' already covers it.
      if (Math.abs((baseRate ?? 0) - irdaRate) > 1e-6) {
        rules.push({
          ...baseRule, sub_type: 'Others',
          rate_type: rateType, rate_value: irdaRate,
          is_declined: false, remarks: 'Other RTOs @ IRDA',
        });
      }
    }
  }
  // Continue-Existing-PO per-district + Others @ IRDA
  if (plan.perDistrictPo.length) {
    for (const d of plan.perDistrictPo) {
      rules.push({
        ...baseRule,
        region: d.city,
        rate_type: rateType, rate_value: baseRate,
        is_declined: false,
        cc_band_min: d.cc_min ?? null,
        cc_band_max: d.cc_max ?? null,
        vehicle_age_min: d.vehicle_age_min ?? null,
        vehicle_age_max: d.vehicle_age_max ?? null,
        remarks: `Continue existing PO @ ${d.city}`,
      });
    }
    if (plan.perDistrictRestIrda) {
      const irdaRate = irdaRateFor(rateType);
      if (Math.abs((baseRate ?? 0) - irdaRate) > 1e-6) {
        rules.push({
          ...baseRule,
          sub_type: 'Others',
          rate_type: rateType, rate_value: irdaRate,
          is_declined: false, remarks: 'Other districts @ IRDA',
        });
      }
    }
  }
}

// ---------- SATP - CV ----------
//
// Layout (sheet "SATP - CV"):
//   R3 header: RTO-Statename | District | Segment | Rate for all Channel | Comments
//   R4..: data
//
// Segment values: "GCV4W 15T-20T", "GCV4W 2.5T-3.5T", "GCV4W 20T-30T",
//                 "GCV4W 3.5T-7.5T", "GCV4W 7.5T-15T", "GCV4W upto 2.5T",
//                 "GCV3W", "PCV3W", "Taxi", "School Bus", etc.
//
// Weight band parsed from the segment text.
function parseSatpCV(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 4; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const state = cellOrNull(row[0]);
    if (!state || /^irda rate means/i.test(state)) continue;
    const district = cellOrNull(row[1]);
    const segment  = cellOrNull(row[2]);
    if (!segment) continue;
    const rate = parseRateOrIrda(row[3]);
    const remark = cellOrNull(row[4]);

    const wb = parseSegmentWeightBand(segment);
    const product = /^pcv|^taxi|^school|^staff|^bus/i.test(segment) ? 'PCV' : 'GCV';

    // GCVE-* / PCVE-* — the "E" between GCV/PCV and the size marks Electric.
    // Normalise segment by dropping "E" and any separator, set fuel=Electric.
    const electricMatch = /^(GCV|PCV)E[-\s]?(\d+W|LCV|MHCV|HCV|3W|4W)/i.exec(segment);
    const isElectric = !!electricMatch;
    const normalizedSegment = isElectric
      ? segment.replace(/^(GCV|PCV)E[-\s]*/i, '$1').replace(/\s+/g, ' ').trim()
      : segment;
    const fuelType = isElectric ? 'Electric' : null;

    const baseRule = {
      product,
      sheet_name: meta.sheetName,
      // District goes to region (→ City column); state stays in state.
      region: district || state,
      state: state,
      sub_type: null,
      segment: normalizedSegment,
      fuel_type: fuelType,
      make: 'All',
      weight_band_min: wb.min,
      weight_band_max: wb.max,
      remarks: remark,
      rate_text: `${state}${district ? ' | ' + district : ''} | ${segment}`,
    };
    const baseFuels = remark ? cvPlan(remark, rate).baseFuels : null;
    emit(rules, baseRule, rate, 'SATP', { baseFuels });
    // Apply comprehensive remark analyser — emits per-RTO, per-fuel,
    // per-make carve-outs from the Comments column.
    emitSatpRemarkRules(rules, baseRule, remark, rate, 'SATP');
  }
  return rules;
}

/** Parse a segment label's weight band ("GCV4W 15T-20T" / "GCV4W upto 2.5T"). */
function parseSegmentWeightBand(seg) {
  const s = String(seg || '');
  let m = s.match(/(\d+(?:\.\d+)?)\s*T\s*-\s*(\d+(?:\.\d+)?)\s*T/i);
  if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  m = s.match(/upto\s*(\d+(?:\.\d+)?)\s*T/i);
  if (m) return { min: 0, max: parseFloat(m[1]) };
  m = s.match(/above\s*(\d+(?:\.\d+)?)\s*T/i);
  if (m) return { min: parseFloat(m[1]), max: 999 };
  return { min: null, max: null };
}

// ---------- SATP Overlay (Additional Cohorts) ----------
//
// Layout:  Type | LOB | Segment | RTO_State | Rate for All Channel | Remark
//
// Effective from 6 April 2026 — overrides specific (segment × state) cells
// from the base SATP grid.  Emitted with a higher effective_from so the
// matcher's date-based card selection picks these over older entries.
function parseSatpOverlay(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const type    = cellOrNull(row[0]);
    const lob     = cellOrNull(row[1]);
    const segment = cellOrNull(row[2]);
    const state   = cellOrNull(row[3]);
    if (!state || !segment) continue;
    const rate = parseRateOrIrda(row[4]);
    const remark = cellOrNull(row[5]);

    const product =
      /^pcv|taxi|bus/i.test(segment) ? 'PCV' :
      /^gcv/i.test(segment)          ? 'GCV' :
      /^pvt|pc|car/i.test(segment)   ? 'CAR' :
      /^tw|bike|scoot/i.test(segment) ? 'TW'  :
      String(lob || '').toUpperCase().startsWith('CV') ? 'GCV' :
      String(lob || '').toUpperCase().startsWith('TW') ? 'TW'  : 'GCV';

    const baseRule = {
      product,
      sheet_name: meta.sheetName,
      region: state, state: state,
      segment,
      make: 'All',
      remarks: remark ? `April overlay: ${remark}` : 'April overlay (effective 6 Apr 2026)',
      rate_text: `${type || 'SATP'} | ${lob || ''} | ${segment} | ${state}`,
    };
    emit(rules, baseRule, rate, type || 'SATP');
  }
  return rules;
}

// ---------- Top-level dispatch ----------
function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind;
  switch (kind) {
    case 'satp_pc':      return parseSatpPC(sheetData, sheetConfig, meta);
    case 'satp_bike':    return parseSatpBike(sheetData, sheetConfig, meta);
    case 'satp_scoot':   return parseSatpScooter(sheetData, sheetConfig, meta);
    case 'satp_cv':      return parseSatpCV(sheetData, sheetConfig, meta);
    case 'satp_overlay': return parseSatpOverlay(sheetData, sheetConfig, meta);
    default:
      console.warn(`[bajaj-satp] unknown sheet_kind "${kind}" for sheet "${meta.sheetName}"`);
      return [];
  }
}

module.exports = { parse };
