/**
 * Bajaj File 3: Robinhood Insurance Broker — multi-LOB grid file.
 *
 * Sheets handled:
 *   sheet_kind: 'cv'             — CV (segment × state × comp%) with per-cell remarks
 *   sheet_kind: 'pvt_car_comp'   — PVT car Comp & STOD with multi-line conditional cells
 *                                  (NCB / Non-NCB × per-fuel × city exclusions)
 *   sheet_kind: 'tw_new'         — TW NEW(1826) district × make-bucket Doable/Declined matrix
 *   sheet_kind: 'pvt_car_new'    — PVT car New (1825) district × Pvt Car Doable/Declined
 *   sheet_kind: 'sheet5_cd_grid' — Hero/TVS CD-band grid (same shape as File 1 HMC&TVS)
 *
 * Skipped (used as masters / contests / informational only):
 *   Sheet1 (priority guideline notes), Pincode wise New TW & Pvt car,
 *   Pin code for CV(old), Pin code for old Pvt, Health-FRH & Ren,
 *   List of HEV Treaty Makes (embedded as constant), Non Motor.
 */

const { irdaRateFor } = require('../utils/irda-rates');

// HEV-treaty makes — used to flag Pvt Car high-end models.  Sourced from
// the "List of HEV Treaty Makes" sheet in the same workbook.
const HEV_TREATY = {
  'AUDI':        ['Q3', 'Q5', 'Q7'],
  'BENTLEY':     ['ALL'],
  'BMW':         ['ALL'],
  'CADILLAC':    ['ALL'],
  'HUMMER':      ['ALL'],
  'JAGUAR':      ['ALL'],
  'LEXUS':       ['ALL'],
  'MAYBACH':     ['ALL'],
  'MERCEDES':    ['ALL'],
  'PORSCHE':     ['ALL'],
  'ROLLS ROYCE': ['ALL'],
  'ROVER':       ['ALL'],
};

function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseRateOrIrda(v) {
  if (v == null || v === '') return { value: null, irda: false };
  const s = String(v).trim();
  if (/^irda$/i.test(s)) return { value: null, irda: true };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (!m) return { value: null, irda: false };
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return { value: null, irda: false };
  return { value: n > 1 ? n / 100 : n, irda: false };
}

// ============================================================================
//  CV sheet
// ============================================================================
//
// Layout (R3 header):
//   Segment | RTO-Statename | Comprehensive | Remarks for Comprehensive | Remarks for Standalone
//
// "Comprehensive" cell:
//   - decimal (0.25, 0.35)        → COMP rate
//   - "IRDA"                       → use firm-wide IRDA-COMP default
//   - blank                        → skip
//
// Per-column remarks: Comp remark applies to COMP rule; SAOD remark applies
// to a sister SAOD rule (same rate) when present.  We emit BOTH a COMP rule
// and (when the SAOD remark column is non-blank) a SAOD rule too.
function parseCV(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 4; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const segment = cellOrNull(row[0]);
    const state   = cellOrNull(row[1]);
    if (!segment || !state) continue;

    // Rate cell may be: numeric / "IRDA" / "20% (Eastern UP Only)"
    let rate = parseRateOrIrda(row[2]);
    let rateScope = null;
    if (rate.value == null && !rate.irda) {
      const cellStr = String(row[2] || '').trim();
      const mWith = cellStr.match(/^(\d+(?:\.\d+)?)\s*%\s*\(([^)]+)\)/);
      if (mWith) {
        rate = { value: parseFloat(mWith[1]) / 100, irda: false };
        rateScope = mWith[2].trim().replace(/\s*only\s*$/i, '').trim();
      } else {
        continue;
      }
    }
    const compRemark = cellOrNull(row[3]);
    const saodRemark = cellOrNull(row[4]);

    const wb = parseSegmentWeightBand(segment);
    const segSeating = parseSegmentSeating(segment);  // PCV "SC <10" / "SC >10"
    const segCategory = parseSegmentCategory(segment); // Staff Bus / School Bus / Non-School Bus / Taxi
    const product = /^pcv|taxi|bus/i.test(segment) ? 'PCV' : 'GCV';

    // GCVE-3W / PCVE-* → Electric, segment normalized to drop the "E"
    const electricMatch = /^(GCV|PCV)E[-\s]?(\d+W|LCV|MHCV|HCV|3W|4W)/i.exec(segment);
    const isElectric = !!electricMatch;
    const normalizedSegment = isElectric
      ? segment.replace(/^(GCV|PCV)E[-\s]*/i, '$1').replace(/\s+/g, ' ').trim()
      : segment;
    const fuelType = isElectric ? 'Electric' : null;

    const baseRate = rate.irda ? irdaRateFor('COMP') : rate.value;

    // Emit rules per product (COMP / SAOD) according to the remark analysis.
    const emit = (rt, remark) => {
      // SAOD only emits when its remark column has content (signals SAOD
      // variant exists); when SAOD remark is blank, no SAOD rule.
      if (rt === 'SAOD' && !remark) return;

      const plan = analyzeCvRemark(remark, baseRate);
      const baseRule = (overrides = {}) => ({
        product,
        sheet_name: meta.sheetName,
        region: state,
        state: state,
        sub_type: rateScope || null,
        segment: normalizedSegment,
        fuel_type: fuelType,
        make: 'All',
        weight_band_min: wb.min,
        weight_band_max: wb.max,
        // Seating from segment ("SC <10" / "SC >10") — remark seating
        // (e.g. "3+1 seating capacity") overrides via the overrides arg.
        seating_capacity_min: segSeating.min,
        seating_capacity_max: segSeating.max,
        rate_type: rt,
        rate_value: baseRate,
        is_declined: false,
        remarks: remark,
        rate_text: `Robinhood CV | ${segment} | ${state}${rt === 'SAOD' ? ' | SAOD' : ''}`,
        ...overrides,
      });

      // ---------------- BASE RULES ----------------
      // baseFuels: emit a separate rule per allowed fuel; otherwise single base.
      const baseFuels = plan.baseFuels || (fuelType ? [fuelType] : [null]);
      // baseRateOverride: e.g. "Rest all locations @ 35% enabler"
      const effectiveBaseRate = plan.baseRateOverride != null ? plan.baseRateOverride : baseRate;

      // Suppress generic 'All'-make base when an Only/Make-split fully replaces it.
      const skipAllBase = !!plan.makeSplit || !!plan.okRtos;

      // Bare "Declined" / "Decined" — emit one declined base rule and skip the rest.
      if (plan.fullyDeclined) {
        rules.push(baseRule({ rate_value: null, is_declined: true, remarks: 'Declined' }));
        return;
      }

      if (!skipAllBase) {
        for (const f of baseFuels) {
          rules.push(baseRule({
            fuel_type: f || null,
            rate_value: effectiveBaseRate,
            // Remark-level seating wins over segment-level SC<n/SC>n.
            seating_capacity_min: plan.seating?.min ?? segSeating.min,
            seating_capacity_max: plan.seating?.max ?? segSeating.max,
            sub_type: plan.allowedRtos?.length ? plan.allowedRtos.join('/') : (rateScope || null),
          }));
        }
      }

      // ---------------- OK-FOR RTOs + REST BLOCKED ----------------
      if (plan.okRtos) {
        for (const rto of plan.okRtos.rtos) {
          rules.push(baseRule({
            sub_type: rto,
            rate_value: effectiveBaseRate,
            remarks: `Ok ${rto} (continue at grid)`,
          }));
        }
        // Catch-all "Others" rule for the state at rate=0 (rest blocked)
        rules.push(baseRule({
          sub_type: 'Others',
          rate_value: 0,
          remarks: 'Remaining RTOs @ NO PAYOUT',
        }));
      }

      // ---------------- PER-RTO CUSTOM RATES ----------------
      for (const rr of plan.rtoRates) {
        rules.push(baseRule({
          sub_type: rr.rto,
          fuel_type: rr.fuel || (fuelType || null),
          rate_value: rr.rate,
          remarks: `${rr.rto}${rr.fuel ? ' ' + rr.fuel : ''} @ ${(rr.rate * 100).toFixed(2)}%`,
        }));
      }

      // ---------------- PER-RTO PER-FUEL BLOCK ----------------
      for (const rb of plan.fuelRtoBlock) {
        rules.push(baseRule({
          sub_type: rb.rto,
          fuel_type: rb.fuel,
          rate_value: 0,
          remarks: `${rb.rto} ${rb.fuel} Blocked @ NO PAYOUT`,
        }));
      }

      // ---------------- MODEL CAPS ("Max N% for BOLERO, MAX PICK UP") ----------------
      if (plan.modelCaps.length) {
        for (const mc of plan.modelCaps) {
          rules.push(baseRule({
            make: mc.make,
            model: mc.model,
            rate_value: mc.rate,
            remarks: `Max ${(mc.rate * 100).toFixed(0)}% for ${mc.model}`,
          }));
        }
        // No explicit "Others" rule — the base make='All' rule already
        // covers everything not in modelCaps at the row rate.
      }

      // ---------------- MODEL RATES (bare carve-outs: "Innova Max 45%", "XUV 500 Max 40%") ----------------
      for (const mr of plan.modelRates) {
        rules.push(baseRule({
          make: mr.make,
          model: mr.model,
          fuel_type: mr.fuel || fuelType,
          rate_value: mr.atIrda ? irdaRateFor('COMP') : mr.rate,
          is_declined: false,
          remarks: mr.atIrda
            ? `${mr.model} @ IRDA`
            : `${mr.model}${mr.fuel ? ' ' + mr.fuel : ''} ${(mr.rate * 100).toFixed(0)}%`,
        }));
      }

      // ---------------- FUEL × MODEL ("Diesel and CNG -Swift, Beat Max 25%") ----------------
      for (const fm of plan.fuelModelRates) {
        for (const f of fm.fuels) {
          for (const md of fm.models) {
            rules.push(baseRule({
              fuel_type: f,
              make: md.make, model: md.model,
              rate_value: fm.rate,
              remarks: `${f} ${md.model} ${(fm.rate * 100).toFixed(0)}%`,
            }));
          }
        }
      }

      // ---------------- CITY × MODEL ("JAMMU-SCORPIO at Max 20%") ----------------
      for (const cm of plan.cityModelRates) {
        rules.push(baseRule({
          region: cm.city,
          carrier_type: '',
          make: cm.make, model: cm.model,
          rate_value: cm.rate,
          remarks: `${cm.city} / ${cm.model} ${(cm.rate * 100).toFixed(0)}%`,
        }));
      }

      // ---------------- ALLOWED-RTOs + FUEL + REST @ IRDA ----------------
      if (plan.allowedRtosWithRest) {
        const { rtos, fuel, restAtIrda } = plan.allowedRtosWithRest;
        for (const rto of rtos) {
          rules.push(baseRule({
            sub_type: rto,
            fuel_type: fuel || fuelType,
            rate_value: effectiveBaseRate,
            remarks: `${rto}${fuel ? ' (' + fuel + ' only)' : ''} @ row rate`,
          }));
        }
        if (restAtIrda) {
          const irdaRate = irdaRateFor('COMP');
          if (Math.abs((effectiveBaseRate ?? 0) - irdaRate) > 1e-6) {
            rules.push(baseRule({
              sub_type: 'Others',
              rate_value: irdaRate,
              remarks: 'Other RTOs @ IRDA',
            }));
          }
        }
      }

      // ---------------- CONTINUE-EXISTING-PO DISTRICTS + Others @ IRDA ----------------
      if (plan.perDistrictPo.length) {
        for (const d of plan.perDistrictPo) {
          rules.push(baseRule({
            region: d.city,
            carrier_type: '',
            rate_value: effectiveBaseRate,
            cc_band_min: d.cc_min ?? null,
            cc_band_max: d.cc_max ?? null,
            vehicle_age_min: d.vehicle_age_min ?? null,
            vehicle_age_max: d.vehicle_age_max ?? null,
            remarks: `Continue existing PO @ ${d.city}`,
          }));
        }
        if (plan.perDistrictRestIrda) {
          const irdaRate = irdaRateFor('COMP');
          if (Math.abs((effectiveBaseRate ?? 0) - irdaRate) > 1e-6) {
            rules.push(baseRule({
              sub_type: 'Others',
              rate_value: irdaRate,
              remarks: 'Other districts @ IRDA',
            }));
          }
        }
      }

      // ---------------- MAKE-SPLIT ("Only TATA, rest IRDA") ----------------
      if (plan.makeSplit) {
        const { namedMake, namedRate, restAction } = plan.makeSplit;
        for (const f of baseFuels) {
          rules.push(baseRule({
            fuel_type: f || null,
            make: namedMake,
            rate_value: namedRate != null ? namedRate : effectiveBaseRate,
            remarks: `Only ${namedMake}`,
          }));
          // Rest action: declined | irda | rate
          if (restAction.type === 'irda') {
            rules.push(baseRule({
              fuel_type: f || null,
              make: 'Others',
              rate_value: irdaRateFor('COMP'),
              remarks: 'Other makes @ IRDA',
            }));
          } else if (restAction.type === 'declined') {
            rules.push(baseRule({
              fuel_type: f || null,
              make: 'Others',
              rate_value: null,
              is_declined: true,
              remarks: 'Other makes declined',
            }));
          } else if (restAction.type === 'rate' && restAction.rate != null) {
            rules.push(baseRule({
              fuel_type: f || null,
              make: 'Others',
              rate_value: restAction.rate,
              remarks: `Other makes @ ${(restAction.rate * 100).toFixed(0)}%`,
            }));
          }
        }
      }

      // ---------------- DECLINED CITIES ----------------
      for (const c of plan.declinedCities) {
        rules.push(baseRule({
          region: c, sub_type: null,
          carrier_type: '',
          rate_value: null, is_declined: true,
          remarks: 'Declined Location',
        }));
      }

      // ---------------- RESTRICTED CITIES @ rate ----------------
      for (const r of plan.restrictedCities) {
        rules.push(baseRule({
          region: r.city, sub_type: null,
          carrier_type: '',
          rate_value: r.rate,
          remarks: `Restricted @ ${(r.rate * 100).toFixed(0)}%`,
        }));
      }

      // ---------------- CITY-MAX carves ("Muzaffarpur - Max 20%") ----------------
      for (const c of plan.cityMaxes) {
        rules.push(baseRule({
          region: c.city, sub_type: null,
          carrier_type: '',
          rate_value: c.rate,
          remarks: `Max ${(c.rate * 100).toFixed(0)}%`,
        }));
      }

      // ---------------- SUB-REGION @ IRDA ("UP West @ IRDA") ----------------
      for (const sr of plan.subRegionRates) {
        rules.push(baseRule({
          region: sr.region, sub_type: null,
          carrier_type: '',
          rate_value: sr.irda ? irdaRateFor('COMP') : sr.rate,
          remarks: sr.irda ? `${sr.region} @ IRDA` : `${sr.region} @ ${(sr.rate * 100).toFixed(0)}%`,
        }));
      }

      // ---------------- DECLINED MAKES / MODELS ----------------
      for (const dm of plan.declinedMakes) {
        const label = dm.bodyType
          ? dm.bodyType
          : `${dm.make || 'All'}${dm.model ? ' / ' + dm.model : ''}`;
        rules.push(baseRule({
          make: dm.make || 'All',
          model: dm.model || null,
          sub_type: dm.bodyType || (rateScope || null),
          fuel_type: dm.fuel || fuelType,
          rate_value: dm.atIrda ? irdaRateFor('COMP') : null,
          is_declined: !dm.atIrda,
          remarks: dm.atIrda ? `${label} @ IRDA` : `Declined ${label}`,
        }));
      }

      // ---------------- EXTRA MAKE RATES ("Bajaj@45%, Piaggio@45%") ----------------
      for (const mr of plan.extraMakeRates) {
        for (const f of baseFuels) {
          rules.push(baseRule({
            fuel_type: f || null,
            make: mr.make,
            rate_value: mr.rate,
            remarks: `${mr.make} @ ${(mr.rate * 100).toFixed(0)}%`,
          }));
        }
      }

      // ---------------- NO-PAYOUT RTOs ("Blocked @NO PAYOUT (MH34)") ----------------
      for (const rto of plan.noPayoutRtos) {
        rules.push(baseRule({
          sub_type: rto,
          carrier_type: '',
          rate_value: 0,
          is_declined: false,
          remarks: `Blocked NO PAYOUT (${rto})`,
        }));
      }

      // ---------------- NO-PAYOUT CITIES ("No PO in the districts of ...") ----------------
      for (const np of plan.noPayoutCities) {
        rules.push(baseRule({
          region: np.city,
          carrier_type: '',
          rate_value: 0,
          is_declined: false,
          vehicle_age_min: np.vehicle_age_max != null ? 0 : null,
          vehicle_age_max: np.vehicle_age_max != null ? np.vehicle_age_max : null,
          cc_band_min: np.cc_min != null ? np.cc_min : null,
          cc_band_max: np.cc_max != null ? np.cc_max : null,
          remarks: `No PO ${np.city}${np.vehicle_age_max != null ? ` (age ≤${np.vehicle_age_max})` : ''}${np.cc_max != null ? ` (CC ≤${np.cc_max})` : ''}${np.cc_min != null ? ` (CC ≥${np.cc_min})` : ''}`,
        }));
      }

      // ---------------- NO-PAYOUT MAKE/MODEL ("No PO for Bajaj-Discover, ...") ----------------
      for (const np of plan.noPayoutMakeModels) {
        rules.push(baseRule({
          make: np.make,
          model: np.model || null,
          rate_value: 0,
          is_declined: false,
          remarks: `No PO ${np.make}${np.model ? ' / ' + np.model : ''}`,
        }));
      }

      // ---------------- PER-FUEL RATE CARVE ("Diesel restricted @ 15%") ----------------
      for (const fr of plan.fuelRates) {
        rules.push(baseRule({
          fuel_type: fr.fuel,
          rate_value: fr.rate,
          remarks: `${fr.fuel} restricted @ ${(fr.rate * 100).toFixed(0)}%`,
        }));
      }

      // ---------------- NEW BUSINESS DECLINED ----------------
      if (plan.newBusinessDeclined) {
        rules.push(baseRule({
          segment: normalizedSegment + ' | New Business',
          rate_value: null, is_declined: true,
          remarks: 'Declined for New Business',
        }));
      }
    };

    emit('COMP', compRemark);
    emit('SAOD', saodRemark);
  }
  return rules;
}

/**
 * Comprehensive analyzer for CV "Remarks for Comprehensive/Standalone" cells.
 * Returns a plan object that parseCV uses to compose rules:
 *   {
 *     baseFuels: ['Petrol','CNG'] | null,
 *     baseRateOverride: number | null,
 *     seating: { min, max } | null,
 *     allowedRtos: ['DL','MP09'] | null,
 *     newBusinessDeclined: bool,
 *     makeSplit: { namedMake, namedRate, restAction: {type:'irda'|'declined'|'rate', rate?} } | null,
 *     declinedCities: string[],
 *     restrictedCities: { city, rate }[],
 *     cityMaxes:       { city, rate }[],
 *     subRegionRates:  { region, rate?, irda?: bool }[],
 *     declinedMakes:   { make?, model?, fuel?, bodyType?, atIrda?: bool }[],
 *     extraMakeRates:  { make, rate }[],
 *   }
 */
function analyzeCvRemark(text, baseRate) {
  const plan = {
    baseFuels: null,
    baseRateOverride: null,
    seating: null,
    allowedRtos: null,
    newBusinessDeclined: false,
    makeSplit: null,
    declinedCities: [],
    restrictedCities: [],
    cityMaxes: [],
    subRegionRates: [],
    declinedMakes: [],
    extraMakeRates: [],
    fuelRates: [],          // [{ fuel, rate }] — "Diesel restricted @ 15%"
    noPayoutMakeModels: [], // [{ make, model }] — "No PO for Bajaj-Discover, ..."
    noPayoutCities: [],     // [{ city, vehicle_age_max?, cc_min?, cc_max? }]
    noPayoutRtos: [],       // [string]            — "Blocked @NO PAYOUT (MH34)"
    okRtos: null,           // { rtos: [...] }     — "Ok for (X,Y) ... rest blocked @ 0%"
    rtoRates: [],           // [{ rto, rate, fuel? }] — "Operate at N% for X", "X at N%"
    modelCaps: [],          // [{ make, model, rate }] — "Max N% for BOLERO and ..."
    fuelRtoBlock: [],       // [{ fuel, rto }]    — "KA12 Diesel Blocked @NO PAYOUT"
    fullyDeclined: false,   // bare "Declined" / "Decined"
    // NEW: SATP model-cap patterns
    modelRates: [],         // [{ make, model, rate, fuel?, atIrda? }] — "XUV 500 Max 40% PO"
    fuelModelRates: [],     // [{ fuels:[], models:[{make,model}], rate, atIrda? }] — "Diesel and CNG -Swift Max 25%"
    cityModelRates: [],     // [{ city, make, model, rate }] — "JAMMU- SCORPIO at Max 20%"
    perDistrictPo: [],      // [{ city, cc_min?, cc_max?, vehicle_age_min?, vehicle_age_max? }]
    perDistrictRestIrda: false,  // pairs with continue-existing-PO list
    allowedRtosWithRest: null,   // { rtos:[], fuel?, restAtIrda:true } — "Rate ... only for RTO Codes <list> -Petrol Only Rest at IRDA"
  };
  // Dedupe helper for modelRates — collapses identical (make,model,rate,fuel,atIrda) entries
  // when multiple regex patterns capture the same model from the same clause.
  plan._dedupeModelRates = () => {
    const seen = new Set();
    plan.modelRates = plan.modelRates.filter(m => {
      const key = [
        (m.make || '').toLowerCase(),
        (m.model || '').toLowerCase(),
        m.rate ?? '',
        (m.fuel || '').toLowerCase(),
        m.atIrda ? 1 : 0,
      ].join('||');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  if (!text) return plan;
  const norm = String(text).replace(/\r/g, ' ').replace(/\s+/g, ' ').trim();

  // 1. Fuel restriction: "Applicable only on Petrol and CNG" / "only Petrol and CNG"
  const fuelRe = /(?:Applicable\s+)?only\s+(?:on\s+)?((?:Petrol|Diesel|CNG|LPG|EV|Electric)(?:\s*(?:,|and|&)\s*(?:Petrol|Diesel|CNG|LPG|EV|Electric))*)/i;
  const fuelMatch = norm.match(fuelRe);
  if (fuelMatch) {
    plan.baseFuels = fuelMatch[1]
      .split(/\s*(?:,|and|&)\s*/i)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // 2. Seating: "3+1 Seating capacity" → 3 passengers + 1 driver = 4
  const seatMatch = norm.match(/(\d+)\s*\+\s*(\d+)\s+seating/i);
  if (seatMatch) {
    const total = parseInt(seatMatch[1]) + parseInt(seatMatch[2]);
    plan.seating = { min: total, max: total };
  }

  // 3. Allowed RTO-only: "Only DL RTO" / "applicable only for DL RTO's"
  //                     "PO Only for MP09 RTO. Rest all RTOs at IRDA PO."
  const onlyRtoRe = /(?:Only\s+(?:for\s+)?|applicable\s+only\s+for\s+|PO\s+Only\s+for\s+)([A-Z]{2}\d{0,2}(?:\s*,\s*[A-Z]{2}\d{0,2})*)\s+RTO/i;
  const onlyRtoMatch = norm.match(onlyRtoRe);
  if (onlyRtoMatch) {
    plan.allowedRtos = onlyRtoMatch[1].split(/\s*,\s*/).map(s => s.trim().toUpperCase());
  }

  // 4. New Business decline: "...Declined for New Business..."
  if (/Declined?\s+for\s+New\s+Business/i.test(norm)) {
    plan.newBusinessDeclined = true;
  }

  // 5. Make-split — multiple phrasings:
  //   "Only TATA Make, Others Makes are restricted at IRDA"
  //   "Only for Bajaj Auto & rest Make IRDA"
  //   "Bajaj Only @ 50% & other make at IRDA"
  let mkSplit = norm.match(
    /Only\s+(?:for\s+)?([A-Za-z][\w\s&.]+?)(?:\s+Make)?\s*[,&]\s*(?:rest|others?)\s+Makes?\s+(?:are\s+(?:restricted\s+(?:at|@)\s+)?)?IRDA/i
  );
  if (mkSplit) {
    plan.makeSplit = {
      namedMake: mkSplit[1].trim(),
      namedRate: null,                 // = baseRate
      restAction: { type: 'irda' },
    };
  } else {
    // "<Make> Only @ N% & other make at IRDA"
    mkSplit = norm.match(
      /([A-Za-z][\w&]+)\s+Only\s*@\s*(\d+(?:\.\d+)?)\s*%\s*&\s*(?:other|rest)\s+makes?\s+(?:at\s+)?IRDA/i
    );
    if (mkSplit) {
      plan.makeSplit = {
        namedMake: mkSplit[1].trim(),
        namedRate: parseFloat(mkSplit[2]) / 100,
        restAction: { type: 'irda' },
      };
    }
  }

  // 6. Generalized make-rate enabler:
  //    "Enabler -45% for Bajaj & Piaggio and 20% for others as per grid"
  const enablerRe = /Enabler\s*[-:]*\s*(\d+(?:\.\d+)?)\s*%\s+for\s+([A-Za-z][\w\s&]+?)(?:\s+and\s+\d|\s+as\s|$|\.)/i;
  const enabMatch = norm.match(enablerRe);
  if (enabMatch) {
    const rate = parseFloat(enabMatch[1]) / 100;
    const makes = enabMatch[2].split(/\s*&\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
    for (const m of makes) plan.extraMakeRates.push({ make: m, rate });
  }

  // 6e. Bare "Declined" / "Decined" (typo) anywhere in the remark — whole-row decline.
  if (/^(Declined|Decined)\.?$/i.test(norm) || /^(Declined|Decined)\b\s*$/i.test(norm)) {
    plan.fullyDeclined = true;
  }

  // 6e2. Bare "Blocked @NO PAYOUT" / "blocked at no payout" with no RTO/city
  //      context → whole-row override to 0%.
  if (/^\s*Blocked\s*@?\s*NO\s+PAYOUT\.?\s*$/i.test(norm) ||
      /^\s*blocked\s+at\s+no\s+payout\.?\s*$/i.test(norm)) {
    plan.baseRateOverride = 0;
  }

  // 6e3. "1.motorcycle 0%" / "motorcycle 0%" — whole-row 0% override.
  if (/^\s*\d*\.?\s*motorcycle\s+0\s*%\.?\s*$/i.test(norm)) {
    plan.baseRateOverride = 0;
  }

  // 6f. "Continue" alone → no-op (base rule unchanged); nothing to do.

  // 6g. "Ok [for] [(] <RTOs> [)] - Continue at existing grid. Remaining
  //     RTO Codes (if any) to be Blocked @NO PAYOUT"
  //     Variants:
  //       "Ok for (AP07,AP08) - ..."        → AP07, AP08
  //       "Ok Mh07 - ..."                    → MH07
  //       "Ok Mh12,14,42 - ..."              → MH12, MH14, MH42 (state prefix shared)
  //       "Ok Wb 31,32 - ..."                → WB31, WB32
  //       "Ok for BR 01 - ..."               → BR01
  const okForRe = /Ok\s+(?:for\s+)?(?:\(\s*)?([A-Za-z]{2}\s*\d{1,3}(?:[,\s]*(?:[A-Za-z]{2})?\s*\d{1,3})*)\s*\)?\s*-?\s*(?:Continue|continue)/i;
  const okForMatch = norm.match(okForRe);
  if (okForMatch && /(?:Blocked\s*@?\s*NO\s+PAYOUT|rest.*declined)/i.test(norm)) {
    plan.okRtos = { rtos: expandRtoList(okForMatch[1]) };
  }

  // 6h. Per-RTO custom rates — multiple shapes.  Run global scans so a single
  //     remark like "Operate at 32.5% payout for MH16,MH17" plus a second
  //     "Operate MH09 at 42.5% payout" both get captured.
  //
  //   • "Operate at N% payout for <RTO>[;<RTO>;...]"
  let m;
  const operRtoListRe = /Operate\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*%\s*(?:payout\s+)?for\s+([A-Z]{2}\s*\d{1,3}(?:[;,\s]+(?:[A-Z]{2})?\s*\d{1,3})*)/gi;
  while ((m = operRtoListRe.exec(norm)) !== null) {
    const rate = parseFloat(m[1]) / 100;
    for (const rto of expandRtoList(m[2])) plan.rtoRates.push({ rto, rate });
  }
  //   • "Operate <RTO> at N% payout"
  const operRtoFirstRe = /Operate\s+([A-Z]{2}\s*\d{1,3})\s+at\s+(\d+(?:\.\d+)?)\s*%/gi;
  while ((m = operRtoFirstRe.exec(norm)) !== null) {
    plan.rtoRates.push({ rto: expandRtoList(m[1])[0], rate: parseFloat(m[2]) / 100 });
  }
  //   • "<RTO>[s] [&|,] <RTO> to operate as per grid @ N%"
  const operAsGridRe = /([A-Z]{2}\s*\d{1,3}(?:\s*(?:&|,)\s*(?:[A-Z]{2})?\s*\d{1,3})*)\s+to\s+operate\s+as\s+per\s+grid\s*@\s*(\d+(?:\.\d+)?)\s*%/gi;
  while ((m = operAsGridRe.exec(norm)) !== null) {
    const rate = parseFloat(m[2]) / 100;
    for (const rto of expandRtoList(m[1])) plan.rtoRates.push({ rto, rate });
  }
  //   • "<RTO> at N%"   (must follow a "Payout for ..." or be standalone, e.g. "JH02 at 32.5% payout", "KA 19 at 47%")
  const bareRtoAtRe = /(?:^|[.;|]|\s)([A-Z]{2}\s*\d{1,3})\s+at\s+(\d+(?:\.\d+)?)\s*%/gi;
  while ((m = bareRtoAtRe.exec(norm)) !== null) {
    const rto = expandRtoList(m[1])[0];
    const rate = parseFloat(m[2]) / 100;
    if (plan.rtoRates.some(x => x.rto === rto)) continue;     // dedupe
    plan.rtoRates.push({ rto, rate });
  }
  //   • "Operate <Fuel> at N% payout ... applicable for <RTO>[;<RTO>]"
  //     Emits per-RTO + per-fuel custom rate.
  const operFuelRtosRe = /Operate\s+(Petrol|Diesel|CNG|LPG|EV|Electric)\s+at\s+(\d+(?:\.\d+)?)\s*%[\s\S]*?applicable\s+for\s+([A-Z]{2}\s*\d{1,3}(?:[;,&\s]+(?:[A-Z]{2})?\s*\d{1,3})*)/gi;
  while ((m = operFuelRtosRe.exec(norm)) !== null) {
    const fuel = m[1];
    const rate = parseFloat(m[2]) / 100;
    for (const rto of expandRtoList(m[3])) {
      plan.rtoRates.push({ rto, fuel, rate });
    }
  }

  //   • "Payout for <City> RTO will be N%"
  const payoutCityRe = /Payout\s+for\s+([A-Za-z][\w\s]+?)\s+RTO\s+will\s+be\s+(\d+(?:\.\d+)?)\s*%/i;
  const payoutCityMatch = norm.match(payoutCityRe);
  if (payoutCityMatch) {
    plan.rtoRates.push({ rto: payoutCityMatch[1].trim(), rate: parseFloat(payoutCityMatch[2]) / 100 });
  }

  // 6i. "Max N% po on net- All <Model> and <Model> models, No change in other models"
  const maxModelsRe = /Max\s+(\d+(?:\.\d+)?)\s*%\s*po\s*on\s*net\s*[-:]\s*All\s+([A-Z][A-Z0-9\s&-]+?)(?:\s+models?)?\s*(?:,|\.|$|No\s+change)/i;
  const maxModelsMatch = norm.match(maxModelsRe);
  if (maxModelsMatch) {
    const rate = parseFloat(maxModelsMatch[1]) / 100;
    // Split model list by "and" / "&" / ","; each maps to a make via inferMakeFromToken
    const modelTokens = maxModelsMatch[2]
      .split(/\s+and\s+|\s*&\s*|\s*,\s*/i)
      .map(s => s.trim()).filter(Boolean);
    for (const md of modelTokens) {
      const inferred = inferMakeFromToken(toTitleCase(md));
      plan.modelCaps.push({
        make: inferred.make || 'All',
        model: inferred.model || toTitleCase(md),
        rate,
      });
    }
  }

  // 6j. "<RTO> <Fuel> Blocked @NO PAYOUT" — per-RTO + per-fuel block.
  const rtoFuelBlockRe = /([A-Z]{2}\s*\d{1,3})\s+(Petrol|Diesel|CNG|LPG|EV|Electric)\s+Blocked\s*@?\s*NO\s+PAYOUT/gi;
  while ((m = rtoFuelBlockRe.exec(norm)) !== null) {
    plan.fuelRtoBlock.push({
      rto: expandRtoList(m[1])[0],
      fuel: m[2],
    });
  }
  //  "<RTO> Blocked @NO PAYOUT" (no fuel) — handled by existing noPayoutRtos block below.
  const bareRtoBlockRe = /(?:^|[.;|]|\s)([A-Z]{2}\d{1,3})\s+Blocked\s*@?\s*NO\s+PAYOUT/gi;
  while ((m = bareRtoBlockRe.exec(norm)) !== null) {
    const rto = m[1].toUpperCase();
    if (!plan.noPayoutRtos.includes(rto) && !plan.fuelRtoBlock.some(x => x.rto === rto)) {
      plan.noPayoutRtos.push(rto);
    }
  }

  // 6k. "Blocked @ no payout in system-<cities>" — alternative declined-city phrasing.
  //     Always lowercase "in system" suffix. Cities are comma/and-separated.
  const blockedSystemRe = /Blocked\s*@?\s*no\s+payout\s+in\s+system\s*[-:]\s*([^.\d]+?)(?=$|\.|Restric|Decl|\d\.|1\.|2\.)/i;
  const blockedSystemMatch = norm.match(blockedSystemRe);
  if (blockedSystemMatch) {
    for (const c of splitCities(blockedSystemMatch[1])) {
      if (!plan.declinedCities.includes(c)) plan.declinedCities.push(c);
    }
  }

  // 6l. "Blocked @NO PAYOUT RTA-PB16,PB71,..."  (RTA prefix variant of RTO block list)
  const blockedRtaRe = /Blocked\s*@?\s*NO\s+PAYOUT\s+RTA\s*[-:]\s*([A-Z]{2}\s*\d{1,3}(?:\s*,\s*(?:[A-Z]{2})?\s*\d{1,3})*)/i;
  const blockedRtaMatch = norm.match(blockedRtaRe);
  if (blockedRtaMatch) {
    for (const r of expandRtoList(blockedRtaMatch[1])) {
      if (!plan.noPayoutRtos.includes(r)) plan.noPayoutRtos.push(r);
    }
  }

  // 6m. "0 Payout for <City> RTO" / "0 PO for <City> RTO" — city @ 0%.
  const zeroPayoutCityRe = /\b0\s*(?:%\s+)?(?:Payout|PO)\s+for\s+([A-Za-z][\w\s]+?)\s+RTO/gi;
  let zpc;
  while ((zpc = zeroPayoutCityRe.exec(norm)) !== null) {
    const city = zpc[1].trim();
    plan.noPayoutCities.push({ city });
  }

  // 6n. "0% for <Model>" — single model @ 0%. Excluded when followed by RTO/city words.
  const zeroPctModelRe = /\b0\s*%\s+(?:for\s+|on\s+)([A-Za-z][\w\s&-]{1,30}?)(?=$|\.|,|;|\bRTO\b|\band\b)/gi;
  let zpm;
  while ((zpm = zeroPctModelRe.exec(norm)) !== null) {
    const tok = zpm[1].trim();
    if (!tok || /Petrol|Diesel|CNG|LPG|Electric|EV/i.test(tok)) continue;
    const inferred = inferMakeFromToken(toTitleCase(tok));
    plan.modelRates.push({
      make: inferred.make || 'All',
      model: inferred.model || toTitleCase(tok),
      rate: 0,
    });
  }

  // 6o. Bare model carve-outs (independent clauses, no "Max N% po on net" prefix):
  //     "<Model>(all fuel types)- at Max N% PO"
  //     "<Model>- Max N% PO" / "<Model>- max N% PO" / "<Model>- N% PO"
  //     "Innova- max 45% PO" / "XUV 500 Max 40%"
  //     A model token here is a sequence of TitleCase / ALL-CAPS words.
  // Boundary set includes "<space>-" so "above -INNOVA- Max 45% PO" matches.
  // Model tokens allow a trailing numeric word ("XUV 500", "XUV 700").
  // Capture an optional "(all fuel types)" / "(petrol only)" parenthetical
  // so its fuel context lands on the emitted rule.
  const bareModelCapRe = /(?:^|[.,;|]|\s-\s|\s-)\s*([A-Z][A-Za-z0-9]+(?:\s+(?:[A-Z][A-Za-z0-9]+|\d+))?)\s*(?:\(([^)]+)\))?\s*[-–]?\s*(?:at\s+)?(?:Max\s+|max\s+)?(\d+(?:\.\d+)?)\s*%\s*(?:PO|po)/g;
  let bmc;
  while ((bmc = bareModelCapRe.exec(norm)) !== null) {
    const tok = bmc[1].trim();
    const paren = bmc[2] ? bmc[2].trim() : null;
    const rate = parseFloat(bmc[3]) / 100;
    // Reject non-model tokens
    if (/^(Petrol|Diesel|CNG|LPG|Electric|EV|RTO|RTA|Only|Max|Rest|All|Continue|No|Operate|Ok|For|Of|Blocked|Locations?|Regions?|Districts?|Existing|Grid|IRDA|Make|Model)s?$/i.test(tok)) continue;
    // Skip RTO codes — handled separately
    if (/^[A-Z]{2}\s*\d{1,3}[A-Z]?$/.test(tok.replace(/\s/g, ''))) continue;
    const inferred = inferMakeFromToken(tok);
    if (inferred.bodyType) continue;  // not a model

    // Parenthetical qualifier?  "(all fuel types)" → fuel=All.
    // "(petrol only)" / "(diesel only)" → single-fuel rule.
    let fuel = null;
    if (paren) {
      if (/all\s+fuel\s+types?/i.test(paren))     fuel = 'All';
      else {
        const fm = paren.match(/^(Petrol|Diesel|CNG|LPG|EV|Electric)/i);
        if (fm) fuel = fm[1];
      }
    }
    plan.modelRates.push({
      make: inferred.make || 'All',
      model: inferred.model || tok,
      rate,
      ...(fuel ? { fuel } : {}),
    });
  }

  // 6p. "<Model>, <Model> and <Model> at IRDA" — multi-model @ IRDA (no rate).
  const modelsAtIrdaRe = /([A-Z][A-Za-z0-9 ,&-]+?)\s+(?:at|@)\s+IRDA/i;
  // We only run this if a comma-list / "and" join appears before "at IRDA".
  if (/(?:,|\band\b).*?(?:at|@)\s+IRDA/i.test(norm)) {
    const m = norm.match(modelsAtIrdaRe);
    if (m) {
      const tokens = m[1].split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
        .map(s => s.trim()).filter(Boolean)
        .filter(t => !/^(only|for|rest|all|petrol|diesel|cng|lpg|ev|electric|others?|grid)$/i.test(t))
        .filter(t => !/^[A-Z]{2}\s*\d{1,3}$/.test(t));        // exclude RTO codes
      for (const tok of tokens) {
        const inferred = inferMakeFromToken(toTitleCase(tok));
        if (inferred.bodyType) continue;
        // Skip if it doesn't look like a model (single ambiguous word) — only
        // accept when the token resolves to a known make.
        if (!inferred.model || inferred.make === 'All') continue;
        plan.modelRates.push({
          make: inferred.make,
          model: inferred.model,
          atIrda: true,
        });
      }
    }
  }

  // 6q. "<Fuel>[ and <Fuel>] -<Model>, <Model> ... Max N% PO"
  //     Examples:
  //       "Petrol -Swift, WAGON R Max 20% PO"
  //       "Diesel and CNG -Swift, Beat, Fiesta and I20 Max 25% PO"
  const fuelModelRe = /(Petrol|Diesel|CNG|LPG|EV|Electric)(?:\s+and\s+(Petrol|Diesel|CNG|LPG|EV|Electric))?\s*[-–]\s*([^@]+?)\s+(?:Max\s+|max\s+)?(\d+(?:\.\d+)?)\s*%\s*PO/i;
  const fuelModelMatch = norm.match(fuelModelRe);
  if (fuelModelMatch) {
    const fuels = [fuelModelMatch[1]];
    if (fuelModelMatch[2]) fuels.push(fuelModelMatch[2]);
    const rate = parseFloat(fuelModelMatch[4]) / 100;
    const modelTokens = fuelModelMatch[3]
      .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
      .map(s => s.trim()).filter(Boolean);
    const models = [];
    for (const tok of modelTokens) {
      const inferred = inferMakeFromToken(toTitleCase(tok));
      if (inferred.bodyType) continue;
      models.push({ make: inferred.make || 'All', model: inferred.model || tok });
    }
    if (models.length) plan.fuelModelRates.push({ fuels, models, rate });
  }

  // 6r. "<City>- <Model> at Max N%" — city-scoped model rate.
  //     Example: "JAMMU- SCORPIO at Max 20%"
  const cityModelRe = /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s*[-–]\s*([A-Z][A-Za-z0-9 ]+?)\s+(?:at\s+)?(?:Max\s+|max\s+)?(\d+(?:\.\d+)?)\s*%/g;
  let cm;
  while ((cm = cityModelRe.exec(norm)) !== null) {
    const cityRaw = cm[1].trim();
    const modelRaw = cm[2].trim();
    // Reject when city looks like a fuel/keyword or already used by other handlers
    if (/^(Petrol|Diesel|CNG|LPG|Electric|EV|Max|Rest|All|Blocked|No|Ok|Operate|RTO|RTA|Only|For)$/i.test(cityRaw)) continue;
    if (/^(Petrol|Diesel|CNG|LPG|Electric|EV|Max|Rest)$/i.test(modelRaw)) continue;
    if (/^[A-Z]{2}\d{0,3}$/.test(cityRaw)) continue;   // RTO code masquerading as city
    if (/^[A-Z]{2}\d{0,3}$/.test(modelRaw)) continue;
    // Require the model side to be a known model OR ALL-CAPS make name
    const inferred = inferMakeFromToken(toTitleCase(modelRaw));
    if (!inferred.model && inferred.make === toTitleCase(modelRaw)) {
      // ALL-CAPS unknown — fall back to using as model with make=All
    }
    if (inferred.bodyType) continue;
    plan.cityModelRates.push({
      city: toTitleCase(cityRaw),
      make: inferred.make || 'All',
      model: inferred.model || modelRaw,
      rate: parseFloat(cm[3]) / 100,
    });
  }

  // 6r2. Multi-model list with shared rate, no fuel prefix:
  //     "ALTO, OMNI, EECO, CITY, ESTILO and CELERIO-20% PO"
  //     "Swift, WAGON R, Alto and Eeco Max 20% PO"
  //     Require at least 2 comma-or-and separated tokens to avoid false positives.
  // Boundary set includes "% PO " so a second clause separated only by a
  // space after "20% PO ALTO, ..." is detected.  Each model token may carry
  // an optional "(all fuel types)" / "(petrol only)" parenthetical.
  const multiModelRe = /(?:^|[.,;|]|%\s*PO\s+)\s*([A-Z][A-Za-z0-9 ]{0,30}(?:\s*\([^)]+\))?(?:\s*(?:,|and|&)\s*[A-Z][A-Za-z0-9 ]{0,30}(?:\s*\([^)]+\))?){1,15})\s*[-–]?\s*(?:at\s+)?(?:Max\s+|max\s+)?(\d+(?:\.\d+)?)\s*%\s*PO/gi;
  let mmRe;
  while ((mmRe = multiModelRe.exec(norm)) !== null) {
    const head = mmRe[1].trim();
    // Reject if the head looks like a fuel-prefixed clause (those are handled by fuelModelRe)
    if (/^(Petrol|Diesel|CNG|LPG|EV|Electric)\b/i.test(head)) continue;
    const rate = parseFloat(mmRe[2]) / 100;
    const tokens = head.split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
      .map(s => s.trim()).filter(Boolean);
    if (tokens.length < 2) continue;
    // First pass: detect any "(all fuel types)" / "(petrol only)" parenthetical
    // anywhere in the list — it applies to ALL models in the clause.
    let sharedFuel = null;
    for (const tokRaw of tokens) {
      const pm = tokRaw.match(/\(([^)]+)\)/);
      if (!pm) continue;
      if (/all\s+fuel\s+types?/i.test(pm[1])) { sharedFuel = 'All'; break; }
      const fm = pm[1].match(/^(Petrol|Diesel|CNG|LPG|EV|Electric)/i);
      if (fm) { sharedFuel = fm[1]; break; }
    }
    for (const tokRaw of tokens) {
      const tok = tokRaw.replace(/\([^)]*\)/g, '').trim();
      if (/^(Petrol|Diesel|CNG|LPG|Electric|EV|Max|Rest|All|RTO|RTA|Only|For)$/i.test(tok)) continue;
      if (/^[A-Z]{2}\d{0,3}$/.test(tok)) continue;
      const inferred = inferMakeFromToken(toTitleCase(tok));
      if (inferred.bodyType) continue;
      plan.modelRates.push({
        make: inferred.make || 'All',
        model: inferred.model || tok,
        rate,
        ...(sharedFuel ? { fuel: sharedFuel } : {}),
      });
    }
  }

  // 6s2. "<Model> <Fuel> at IRDA" — single model + fuel @ IRDA.
  //     Example: "SWIFT CNG at IRDA"
  const modelFuelIrdaRe = /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)?)\s+(Petrol|Diesel|CNG|LPG|EV|Electric)\s+(?:at|@)\s+IRDA/gi;
  let mfi;
  while ((mfi = modelFuelIrdaRe.exec(norm)) !== null) {
    const tok = mfi[1].trim();
    if (/^(Only|For|Max|Rest|All|RTO|RTA|Blocked|Continue|Operate|Declined|Restricted|Existing|Other)s?$/i.test(tok)) continue;
    const inferred = inferMakeFromToken(toTitleCase(tok));
    if (inferred.bodyType) continue;
    plan.modelRates.push({
      make: inferred.make || 'All',
      model: inferred.model || tok,
      fuel: mfi[2],
      atIrda: true,
    });
  }

  // 6s. "<Model> Diesel - N%" / "<Model> CNG - N%" — model + fuel @ rate.
  const modelFuelRateRe = /\b([A-Z][A-Za-z0-9 ]+?)\s+(Petrol|Diesel|CNG|LPG|EV|Electric)\s*[-–]\s*(\d+(?:\.\d+)?)\s*%/g;
  let mfr;
  while ((mfr = modelFuelRateRe.exec(norm)) !== null) {
    const tok = mfr[1].trim();
    if (/^(Only|For|Max|Rest|All|Continue|No|RTO|RTA|Blocked|Operate|Ok|And|Or)$/i.test(tok)) continue;
    if (/^[A-Z]{2}\d{0,3}$/.test(tok)) continue;
    const inferred = inferMakeFromToken(toTitleCase(tok));
    if (inferred.bodyType) continue;
    plan.modelRates.push({
      make: inferred.make || 'All',
      model: inferred.model || tok,
      fuel: mfr[2],
      rate: parseFloat(mfr[3]) / 100,
    });
  }

  // 6t. "Rate mentioned applies only for RTO Codes <list>-<Fuel> Only Rest RTO Codes at IRDA"
  //     "Rate mentioned applies only for RTO Codes UK04, UK07, UK08, UK14, UK16-Petrol Only Rest RTO Codes at IRDA"
  const allowedRtosWithRestRe = /(?:Rate\s+mentioned\s+applies?\s+)?only\s+for\s+RTO\s+Codes?\s+([A-Z]{2}\s*\d{1,3}(?:\s*,\s*(?:[A-Z]{2})?\s*\d{1,3})*)\s*[-–]?\s*(?:(Petrol|Diesel|CNG|LPG|EV|Electric)\s+Only\s+)?Rest\s+(?:RTO\s+Codes\s+)?at\s+IRDA/i;
  const allowedRtosWithRestMatch = norm.match(allowedRtosWithRestRe);
  if (allowedRtosWithRestMatch) {
    plan.allowedRtosWithRest = {
      rtos: expandRtoList(allowedRtosWithRestMatch[1]),
      fuel: allowedRtosWithRestMatch[2] || null,
      restAtIrda: true,
    };
  }

  // 6u. "Continue Existing PO- <district list with optional CC/age qualifiers>.
  //      All other districts at IRDA"
  //     Example: "Continue Existing PO- SAHARANPUR, AZAMGARH, GAUTAM BUDDHA NAGAR
  //      for TW with > 75 cc, KAUSHAMBI, BIJNOR, MUZAFFARNAGAR with vehicle age > 5,
  //      BAGPAT, ... All other districts at IRDA."
  const continueExistingRe = /Continue\s+Existing\s+PO\s*[-:]\s*([\s\S]+?)\.\s*All\s+other\s+districts?\s+at\s+IRDA/i;
  const continueExistingMatch = norm.match(continueExistingRe);
  if (continueExistingMatch) {
    plan.perDistrictRestIrda = true;
    // The list is comma-separated with embedded qualifier phrases.  Tokenise
    // by commas, then identify qualifier suffixes / prefixes per token.
    const list = continueExistingMatch[1];
    const tokens = list.split(/\s*,\s*/);
    let pendingCC = null, pendingAge = null;
    // We walk left→right.  A qualifier phrase like "for TW with > 75 cc"
    // attaches to the IMMEDIATELY-PRECEDING district token.
    for (let i = 0; i < tokens.length; i++) {
      let t = tokens[i].trim();
      // Qualifier-only token? Attach to previous district.
      const ccMatch = t.match(/^for\s+TW\s+with\s+([<>]=?)\s*(\d+)\s*cc/i);
      const ageMatch = t.match(/with\s+vehicle\s+age\s+([<>]=?)\s*(\d+)/i);
      if (ccMatch) {
        const op = ccMatch[1], n = parseInt(ccMatch[2], 10);
        const cur = plan.perDistrictPo[plan.perDistrictPo.length - 1];
        if (cur) {
          if (op === '>')  cur.cc_min = n + 1;
          if (op === '>=') cur.cc_min = n;
          if (op === '<')  cur.cc_max = n - 1;
          if (op === '<=') cur.cc_max = n;
        }
        continue;
      }
      if (ageMatch) {
        const op = ageMatch[1], n = parseInt(ageMatch[2], 10);
        const cur = plan.perDistrictPo[plan.perDistrictPo.length - 1];
        if (cur) {
          if (op === '>')  cur.vehicle_age_min = n + 1;
          if (op === '>=') cur.vehicle_age_min = n;
          if (op === '<')  cur.vehicle_age_max = n - 1;
          if (op === '<=') cur.vehicle_age_max = n;
        }
        continue;
      }
      // City name — may have a trailing qualifier on the SAME token
      // ("GAUTAM BUDDHA NAGAR for TW with > 75 cc" / "MUZAFFARNAGAR with vehicle age > 5")
      const inlineCc = t.match(/^(.+?)\s+for\s+TW\s+with\s+([<>]=?)\s*(\d+)\s*cc/i);
      const inlineAge = t.match(/^(.+?)\s+with\s+vehicle\s+age\s+([<>]=?)\s*(\d+)/i);
      if (inlineCc) {
        const entry = { city: toTitleCase(inlineCc[1].trim()) };
        const op = inlineCc[2], n = parseInt(inlineCc[3], 10);
        if (op === '>')  entry.cc_min = n + 1;
        if (op === '>=') entry.cc_min = n;
        if (op === '<')  entry.cc_max = n - 1;
        if (op === '<=') entry.cc_max = n;
        plan.perDistrictPo.push(entry);
        continue;
      }
      if (inlineAge) {
        const entry = { city: toTitleCase(inlineAge[1].trim()) };
        const op = inlineAge[2], n = parseInt(inlineAge[3], 10);
        if (op === '>')  entry.vehicle_age_min = n + 1;
        if (op === '>=') entry.vehicle_age_min = n;
        if (op === '<')  entry.vehicle_age_max = n - 1;
        if (op === '<=') entry.vehicle_age_max = n;
        plan.perDistrictPo.push(entry);
        continue;
      }
      // Plain city
      t = t.replace(/\.$/, '').trim();
      if (t.length > 1) plan.perDistrictPo.push({ city: toTitleCase(t) });
    }
  }

  // 6d. "Blocked @NO PAYOUT (MH34, MH35, ...)" — RTO-code-level 0% rules.
  //     Each RTO becomes its own sub_type=RTO_code rule with rate=0.
  const blockedRtoRe = /Blocked\s*@?\s*NO\s+PAYOUT\s*\(([^)]+)\)/i;
  const blockedMatch = norm.match(blockedRtoRe);
  if (blockedMatch) {
    const codes = blockedMatch[1]
      .split(/\s*,\s*|\s+and\s+/i)
      .map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z]{2}\d{0,2}$/.test(s));
    plan.noPayoutRtos.push(...codes);
  }

  // 6c. "No PO in the districts of <city>, <city>, (city with vehicle-age cap),
  //     (<=N CC two wheeler for <city>), ..." — district-level 0% with
  //     optional age / CC qualifiers in parentheses.
  const noPoDistrictsRe = /No\s+PO\s+(?:in\s+the\s+districts?\s+of|for\s+districts?)\s+([^.]+)/i;
  const noPoDistMatch = norm.match(noPoDistrictsRe);
  if (noPoDistMatch) {
    const blob = noPoDistMatch[1];
    // Tokenise: split on commas BUT keep parenthesised groups intact.
    const tokens = [];
    let depth = 0, buf = '';
    for (const ch of blob) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { tokens.push(buf.trim()); buf = ''; }
      else buf += ch;
    }
    if (buf.trim()) tokens.push(buf.trim());

    // Further split bare (non-parenthesised) tokens on " and " so
    // "Barabanki and Aligarh" becomes two entries.
    const finalTokens = [];
    for (const t of tokens) {
      if (/^\(/.test(t.trim())) { finalTokens.push(t); continue; }
      for (const sub of t.split(/\s+and\s+/i)) {
        if (sub.trim()) finalTokens.push(sub);
      }
    }

    for (let tok of finalTokens) {
      tok = tok.replace(/^and\s+/i, '').trim();
      if (!tok) continue;
      // Parenthesised constraint?
      const paren = tok.match(/^\(\s*(.+?)\s*\)\s*$/);
      const inner = paren ? paren[1] : tok;

      // "<city> upto vehicle age N" / "<city> vehicle age <=N"
      let m = inner.match(/^(.+?)\s+(?:upto|up\s*to|<=)\s*vehicle\s*age\s*(\d+)/i);
      if (m) {
        plan.noPayoutCities.push({ city: m[1].trim(), vehicle_age_max: parseInt(m[2], 10) });
        continue;
      }
      // "<=N CC two wheeler for <city>" / "<N cc for <city>"
      m = inner.match(/<\s*=?\s*(\d+)\s*CC\s+.*?for\s+(.+)/i);
      if (m) {
        plan.noPayoutCities.push({ city: m[2].trim(), cc_max: parseInt(m[1], 10) });
        continue;
      }
      m = inner.match(/>\s*=?\s*(\d+)\s*CC\s+.*?for\s+(.+)/i);
      if (m) {
        plan.noPayoutCities.push({ city: m[2].trim(), cc_min: parseInt(m[1], 10) });
        continue;
      }
      // Plain city — strip a trailing "." and "and " prefix
      const city = inner.replace(/^and\s+/i, '').replace(/\.$/, '').trim();
      if (city) plan.noPayoutCities.push({ city });
    }
  }

  // 6a. "No PO for <Make>-<Model>, <Make>-<Model>, ..." — 0% payout per pair.
  //     Example: "No PO for Bajaj-Discover, Hero Honda-Splendor, Yamaha-RX"
  const noPoRe = /No\s+PO\s+for\s+([^.]+?)(?:$|\.|Decl|Restric)/i;
  const noPoMatch = norm.match(noPoRe);
  if (noPoMatch) {
    const tokens = noPoMatch[1].split(/\s*,\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
    for (const tok of tokens) {
      const mm = tok.match(/^([A-Za-z][\w\s&]*?)\s*[-–]\s*([A-Za-z0-9][\w\s&.+-]*)$/);
      if (mm) {
        plan.noPayoutMakeModels.push({ make: mm[1].trim(), model: mm[2].trim() });
      } else {
        // Make-only (no model) — fallback
        plan.noPayoutMakeModels.push({ make: tok, model: null });
      }
    }
  }

  // 6b. "All <Make1> [models] and <Make2> [Make] [Bikes/Models/...] ... @ N%"
  //     Example: "All KTM models and YAMAHA Make Bikes - continue as per the
  //     FY2024-25 finance PO grid. For all doable locations @25%"
  //     Also accepts "@ IRDA[ Payout]" instead of a numeric rate.
  const multiMakeRe = /(?:All\s+)?([A-Z][A-Za-z0-9]{1,15})(?:\s+models?)?\s+(?:and|&)\s+([A-Z][A-Za-z0-9]{1,15})(?:\s+Make)?[^@]*?@\s*(\d+(?:\.\d+)?\s*%|IRDA(?:\s+Payout)?)/i;
  const mmMatch = norm.match(multiMakeRe);
  if (mmMatch) {
    const rateTok = mmMatch[3].trim();
    const rate = /^IRDA/i.test(rateTok)
      ? irdaRateFor('COMP')
      : parseFloat(rateTok) / 100;
    const candidates = [mmMatch[1].trim(), mmMatch[2].trim()];
    // Reject fuel keywords / generic words that aren't makes
    const STOP_TOKENS = /^(Petrol|Diesel|CNG|LPG|EV|Electric|Rest|Others?|All|For|Make|Bike|Model|Vehicle|Location|Region|IRDA|Doable)s?$/i;
    for (const c of candidates) {
      if (STOP_TOKENS.test(c)) continue;
      // Don't double-add when the enabler matcher already captured them.
      if (plan.extraMakeRates.some(x => x.make.toLowerCase() === c.toLowerCase())) continue;
      plan.extraMakeRates.push({ make: c, rate });
    }
  }

  // 7. "Max at N% (CHOD Limit) for <cities> Rest all locations @ M% enabler"
  const maxForRe = /Max\s+at\s+(\d+(?:\.\d+)?)\s*%\s*(?:\([^)]+\))?\s*for\s+([^.]+?)\s+Rest\s+all\s+locations?\s*@\s*(\d+(?:\.\d+)?)\s*%/i;
  const maxForMatch = norm.match(maxForRe);
  if (maxForMatch) {
    const cityRate = parseFloat(maxForMatch[1]) / 100;
    const restRate = parseFloat(maxForMatch[3]) / 100;
    plan.baseRateOverride = restRate;
    const cities = splitCities(maxForMatch[2]);
    for (const c of cities) plan.cityMaxes.push({ city: c, rate: cityRate });
  }

  // 8. "Declined Locations/Regions- A, B, C"  (also "Locaitons" / "Locaions" typos)
  const declRe = /Declined\s+Loca[a-z]+\/?Regions?(?:\s+for[^-]+)?\s*[-:]\s*([^.]+?)(?=$|\.|Restricted|Declined\s+Make|Only\s+for)/gi;
  let dm;
  while ((dm = declRe.exec(norm)) !== null) {
    const cities = splitCities(dm[1]);
    for (const c of cities) {
      if (!plan.declinedCities.includes(c)) plan.declinedCities.push(c);
    }
  }

  // 9. "Restricted Locations/Regions- A, B, ... @ N% PO"
  const restRateRe = /Restricted\s+Loca[a-z]+\/?Regions?\s*[-:]\s*([^@]+?)\s*@\s*(\d+(?:\.\d+)?)\s*%/i;
  const restMatch = norm.match(restRateRe);
  if (restMatch) {
    const rate = parseFloat(restMatch[2]) / 100;
    const cities = splitCities(restMatch[1]);
    for (const c of cities) plan.restrictedCities.push({ city: c, rate });
  }

  // 9b. "<Fuel> restricted @ N%" / "<Fuel> @ N% on OD" — per-fuel rate carve.
  //     Emits separate rules per named fuel.  Multiple matches allowed.
  const fuelRateRe = /\b(Petrol|Diesel|CNG|LPG|EV|Electric)\s+(?:restricted\s+)?@\s*(\d+(?:\.\d+)?)\s*%/gi;
  let fr;
  while ((fr = fuelRateRe.exec(norm)) !== null) {
    plan.fuelRates = plan.fuelRates || [];
    plan.fuelRates.push({ fuel: fr[1], rate: parseFloat(fr[2]) / 100 });
  }

  // 10. "Restricted Locations/Regions- UP West @ IRDA" (sub-region @ IRDA)
  const restIrdaRe = /Restricted\s+Loca[a-z]+\/?Regions?\s*[-:]\s*([A-Za-z][\w\s&.]+?)\s*@\s*IRDA/i;
  const restIrdaMatch = norm.match(restIrdaRe);
  if (restIrdaMatch) {
    plan.subRegionRates.push({ region: restIrdaMatch[1].trim(), irda: true });
  }

  // 10b. "<City> [r]es[t]ricted @ N%" — bare per-city restricted clause
  //      (no "Locations/Regions-" prefix). Allows "restricted"/"resticted"
  //      typo. Excludes the "Petrol/Diesel/CNG ... @ N%" forms (those are
  //      handled by the fuel-rate clause above).
  const fuelKeywords = /^(Petrol|Diesel|CNG|LPG|EV|Electric)$/i;
  const bareCityRe = /(?:^|[,;.|\n])\s*([A-Za-z][A-Za-z\s&.'-]{1,40}?)\s+restr?icted\s*@\s*(\d+(?:\.\d+)?)\s*%/gi;
  let bc;
  while ((bc = bareCityRe.exec(norm)) !== null) {
    const city = bc[1].trim();
    if (fuelKeywords.test(city)) continue;        // fuel name, not a city
    if (/^(Declined|Restricted|Only)/i.test(city)) continue;
    plan.restrictedCities.push({ city, rate: parseFloat(bc[2]) / 100 });
  }

  // 11. "Restricted locaitons-<City> - Max N%" or just "<City> - Max N%" / "<C1>, <C2> - Max N%"
  const maxRe = /(?:Restricted\s+Loca[a-z]+\s*[-:]\s*)?(?:^|[.;|])\s*([A-Za-z][A-Za-z\s,&.'-]{1,80}?)\s*[-–]\s*Max\s+(\d+(?:\.\d+)?)\s*%/gi;
  let mx;
  while ((mx = maxRe.exec(norm)) !== null) {
    const head = mx[1].trim();
    if (/^(Declined|Restricted)/i.test(head)) continue;
    const rate = parseFloat(mx[2]) / 100;
    const cities = head.includes(',') ? splitCities(head) : [head];
    for (const c of cities) plan.cityMaxes.push({ city: c, rate });
  }

  // 12. "Declined Make- <Make> at IRDA" — make at IRDA (not declined per user)
  const declMakeIrdaRe = /Declined\s+Make\s*[-:]\s*([A-Za-z][\w\s&.]+?)\s+at\s+IRDA/i;
  const declMakeIrdaMatch = norm.match(declMakeIrdaRe);
  if (declMakeIrdaMatch) {
    plan.declinedMakes.push({
      make: inferMakeFromToken(declMakeIrdaMatch[1].trim()).make,
      atIrda: true,
    });
  } else {
    // 13. "Declined Make- <Make>" / "Decline Make- <Make>"  (no "at IRDA")
    const declMakeRe = /Declined?\s+Make\s*[-:]\s*([A-Za-z][\w\s&.]+?)(?=$|\.|,|;|&)/i;
    const declMakeMatch = norm.match(declMakeRe);
    if (declMakeMatch && !declMakeIrdaMatch) {
      const made = inferMakeFromToken(declMakeMatch[1].trim());
      plan.declinedMakes.push({ make: made.make, model: made.model });
    }
  }

  // 14. "Declined Make/Model- <list>"  (richest pattern; multiple tokens + fuel qualifier)
  const declMmRe = /Declined\s+Make\/?Model\s*[-:]\s*([^.]+?)(?=$|\.|Declined\s+Locations?|&\s+Declined)/i;
  const declMmMatch = norm.match(declMmRe);
  if (declMmMatch) {
    const blob = declMmMatch[1].trim();
    // Fuel qualifier — "...diesel vehicles" / "...petrol variants"
    const fuelTail = blob.match(/(petrol|diesel|cng|electric|ev)\s+(?:vehicles|variants|cars)?$/i);
    const fuel = fuelTail ? fuelTail[1] : null;
    const cleaned = fuel ? blob.replace(fuelTail[0], '').trim() : blob;

    // "Mahindra -Bolero, Pickup, maxxPickup" / "Mahindra Bolero, Pickup, maxxPickup"
    const makeLed = cleaned.match(/^([A-Z][\w&]+(?:\s+[A-Z][\w&]+)?)\s*-?\s*(.+)$/);
    if (makeLed && isKnownMake(makeLed[1])) {
      const make = makeLed[1].trim();
      const models = splitCities(makeLed[2]);
      if (models.length === 0) {
        plan.declinedMakes.push({ make, fuel });
      } else {
        for (const md of models) plan.declinedMakes.push({ make, model: md, fuel });
      }
    } else {
      // Plain token list — could be makes, models, body types
      const tokens = splitCities(cleaned);
      for (const t of tokens) {
        const inferred = inferMakeFromToken(t);
        if (inferred.bodyType) {
          plan.declinedMakes.push({ bodyType: inferred.bodyType });
        } else if (inferred.model && inferred.make !== 'All') {
          plan.declinedMakes.push({ make: inferred.make, model: inferred.model, fuel });
        } else if (inferred.make && inferred.make !== 'All') {
          plan.declinedMakes.push({ make: inferred.make, fuel });
        } else {
          plan.declinedMakes.push({ model: t, fuel });
        }
      }
    }
  }

  // Dedupe modelRates: identical (make,model,rate,fuel,atIrda) entries can
  // come from multiple regex paths matching the same clause.
  plan._dedupeModelRates();
  return plan;
}

// Body-type tokens — these aren't makes/models but vehicle-usage categories.
const CV_BODY_TYPES = new Set([
  'ambulance', 'crane', 'cranes', 'transit mixer', 'cash van', 'cash vans',
  'garbage carrier', 'tipper', 'school bus', 'staff bus',
]);

// Known make → list of typical models, used to disambiguate single-token entries.
const CV_MAKE_MODEL_INDEX = {
  'Tata':       ['indica', 'magic', 'ace', 'super ace', 'yodha', 'intra', 'xenon', 'sumo', 'safari', 'nexon', 'tiago', 'tigor', 'altroz', 'punch', 'harrier', 'zest', 'bolt', 'manza', 'venture'],
  'Mahindra':   ['bolero', 'pickup', 'maxxpickup', 'jeeto', 'supro', 'imperio', 'thar', 'scorpio', 'xuv500', 'xuv 500', 'xuv700', 'xuv 700', 'xuv300', 'xuv 300', 'tuv300', 'kuv100', 'verito', 'logan', 'marazzo', 'alturas'],
  'Maruti':     ['swift', 'swift dzire', 'swift desire', 'dzire', 'alto', 'wagon r', 'wagonr', 'celerio', 'baleno', 'brezza', 'ertiga', 'eeco', 'omni', 'sx4', 'esteem', 'zen', 'estilo', 's-presso', 'spresso', 'ignis'],
  'Hyundai':    ['santro', 'eon', 'grand i10', 'i10', 'i20', 'creta', 'venue', 'verna', 'elantra', 'tucson', 'kona', 'aura'],
  'Toyota':     ['etios', 'etios liva', 'innova', 'fortuner', 'corolla', 'camry', 'hilux', 'glanza', 'urban cruiser'],
  'Honda':      ['city', 'amaze', 'jazz', 'wrv', 'wr-v', 'civic', 'accord', 'br-v', 'brv'],
  'Chevrolet':  ['beat', 'spark', 'aveo', 'cruze', 'sail', 'enjoy', 'tavera', 'optra'],
  'Ford':       ['fiesta', 'figo', 'ikon', 'ecosport', 'endeavour', 'aspire'],
  'Ashok Leyland': ['dost', 'partner', 'boss', 'ecomet', 'guru', 'mitr', 'bada dost'],
  'Bajaj':      ['re', 'maxima', 'qute', 'discover', 'pulsar', 'platina', 'avenger', 'dominar', 'ct100'],
  'Hero Honda': ['splendor', 'passion', 'glamour', 'cd dawn', 'cd deluxe'],
  'Hero':       ['splendor', 'passion', 'glamour', 'xtreme', 'hf deluxe', 'super splendor'],
  'Yamaha':     ['rx', 'fz', 'fzs', 'r15', 'fazer', 'sz', 'libero'],
  'Eicher':     ['pro', 'skyline'],
  'Force':      ['traveller', 'gurkha', 'trax'],
  'KTM':        ['duke', 'rc'],
  'Piaggio':    ['ape'],
};

function isKnownMake(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (CV_MAKE_MODEL_INDEX[s.trim()]) return true;
  return Object.keys(CV_MAKE_MODEL_INDEX).some(m => m.toLowerCase() === t);
}

/**
 * Infer make + model + body-type from a free-text token.
 *   "Magic"              → { make: 'Tata',     model: 'Magic' }
 *   "Bolero"             → { make: 'Mahindra', model: 'Bolero' }
 *   "Ashok-leyland Dost" → { make: 'Ashok Leyland', model: 'Dost' }
 *   "M&M"                → { make: 'Mahindra' }
 *   "Ambulance"          → { bodyType: 'Ambulance' }
 *   "Eicher"             → { make: 'Eicher' }
 *   "M&M Pickup"         → { make: 'Mahindra', model: 'Pickup' }
 */
function inferMakeFromToken(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();

  // Body type?
  for (const bt of CV_BODY_TYPES) {
    if (lower === bt || lower.endsWith(' ' + bt) || lower.includes(bt + ' ') || lower.startsWith(bt + ' ')) {
      return { bodyType: t.split(' ').map(w => w[0].toUpperCase()+w.slice(1).toLowerCase()).join(' ') };
    }
  }

  // "M&M" → Mahindra
  if (/^M\s*&\s*M$/i.test(t) || /^MAHINDRA(\s*&\s*Mahindra)?$/i.test(t)) {
    return { make: 'Mahindra' };
  }

  // "Ashok-leyland Dost" / "Ashok Leyland Dost"
  const alMatch = t.match(/^Ashok[-\s]?leyland\s*(.*)$/i);
  if (alMatch) return alMatch[1].trim() ? { make: 'Ashok Leyland', model: alMatch[1].trim() } : { make: 'Ashok Leyland' };

  // Known-make prefix? ("M&M Pickup", "Tata Magic")
  for (const make of Object.keys(CV_MAKE_MODEL_INDEX)) {
    if (new RegExp('^' + make.replace(/&/g, '\\&') + '\\b', 'i').test(t)) {
      const rest = t.slice(make.length).trim();
      return rest ? { make, model: rest } : { make };
    }
  }

  // Single-token model → look up parent make
  for (const [make, models] of Object.entries(CV_MAKE_MODEL_INDEX)) {
    if (models.includes(lower)) return { make, model: t };
  }

  // Unknown — keep as make
  return { make: t };
}

/**
 * Expand a free-form RTO list into normalised codes.
 *   "AP07, AP08"          → ['AP07','AP08']
 *   "MH12,14,42"          → ['MH12','MH14','MH42']    (state prefix shared)
 *   "Mh07"                → ['MH07']
 *   "Wb 31,32"            → ['WB31','WB32']
 *   "KL08;KL8A;KL75"      → ['KL08','KL8A','KL75']
 *   "WB 03 & WB11"        → ['WB03','WB11']
 */
function expandRtoList(raw) {
  if (!raw) return [];
  // Pad single digits to 2 digits (MH7 → MH07), preserve alpha suffix (KL8A → KL08A).
  const normNum = (n) => {
    const m = String(n).match(/^(\d+)([A-Z]?)$/);
    if (!m) return String(n).toUpperCase();
    return m[1].padStart(2, '0') + m[2];
  };
  const out = [];
  let lastPrefix = null;
  const tokens = String(raw).split(/[,;\s]*(?:&|,|;)[,;\s]*|\s+/);
  for (let t of tokens) {
    t = t.trim();
    if (!t) continue;
    const fullMatch = t.match(/^([A-Za-z]{2})\s*(\d{1,3}[A-Z]?)$/);
    if (fullMatch) {
      lastPrefix = fullMatch[1].toUpperCase();
      out.push(lastPrefix + normNum(fullMatch[2]));
      continue;
    }
    const numOnly = t.match(/^(\d{1,3}[A-Z]?)$/);
    if (numOnly && lastPrefix) {
      out.push(lastPrefix + normNum(numOnly[1]));
      continue;
    }
    const pfxOnly = t.match(/^([A-Za-z]{2})$/);
    if (pfxOnly) lastPrefix = pfxOnly[1].toUpperCase();
  }
  return [...new Set(out)];
}

function toTitleCase(s) {
  return String(s || '')
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Split a city list — handles commas + " and " + stray "." separators. */
/** Lowercase a string then Title-Case each whitespace-separated word. */
function toTitleCase(s) {
  return String(s || '').toLowerCase().split(/\s+/)
    .map(w => w.length ? w[0].toUpperCase() + w.slice(1) : w)
    .join(' ');
}

function splitCities(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ')              // strip balanced parentheticals
    .replace(/\([^)]*$/g, ' ')               // strip unbalanced "(..." trailing
    .split(/[,;.]|\s+&\s+|\s+and\s+/i)
    .map(x => x.trim().replace(/\.$/, '').replace(/^\s*and\s+/i, '').trim())
    .filter(x => x.length > 1 && !/^PO\b/i.test(x) && !/^IRDA/i.test(x));
}

function parseSegmentWeightBand(seg) {
  const s = String(seg || '');
  let m = s.match(/(\d+(?:\.\d+)?)\s*T\s*-\s*(\d+(?:\.\d+)?)\s*T/i);
  if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  m = s.match(/upto\s*(\d+(?:\.\d+)?)\s*T/i);
  if (m) return { min: 0, max: parseFloat(m[1]) };
  return { min: null, max: null };
}

/**
 * Detect the PCV body/usage category embedded in a segment string.
 *   "PCV 4W Staff Bus nd SC >10"               → "Staff Bus"
 *   "PCV 4W School Bus ..."                    → "School Bus"
 *   "PCV 4W other than school bus and SC <10"  → "Non-School Bus"
 *   "TAXI"                                     → "Taxi"
 *   No PCV body-type hint                      → null
 */
function parseSegmentCategory(seg) {
  const s = String(seg || '');
  if (/other\s+than\s+school\s+bus/i.test(s)) return 'Non-School Bus';
  if (/\bStaff\s+Bus\b/i.test(s))             return 'Staff Bus';
  if (/\bSchool\s+Bus\b/i.test(s))            return 'School Bus';
  if (/^TAXI$/i.test(s.trim()))               return 'Taxi';
  return null;
}

/**
 * Parse seating-capacity hints embedded in a segment string.
 *   "PCV 4W ... SC <10"   → { min: null, max: 9 }
 *   "PCV 4W ... SC >10"   → { min: 11,   max: null }
 *   "PCV 4W ... SC =10"   → { min: 10,   max: 10 }
 *   "PCV 4W ... SC <=10"  → { min: null, max: 10 }
 *   "PCV 4W ... SC >=10"  → { min: 10,   max: null }
 *   No match              → { min: null, max: null }
 */
function parseSegmentSeating(seg) {
  const s = String(seg || '');
  let m = s.match(/\bSC\s*<\s*=\s*(\d+)/i);
  if (m) return { min: null, max: parseInt(m[1], 10) };
  m = s.match(/\bSC\s*>\s*=\s*(\d+)/i);
  if (m) return { min: parseInt(m[1], 10), max: null };
  m = s.match(/\bSC\s*<\s*(\d+)/i);
  if (m) return { min: null, max: parseInt(m[1], 10) - 1 };
  m = s.match(/\bSC\s*>\s*(\d+)/i);
  if (m) return { min: parseInt(m[1], 10) + 1, max: null };
  m = s.match(/\bSC\s*=\s*(\d+)/i);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
  return { min: null, max: null };
}

// ============================================================================
//  PVT car Comprehensive & STOD — multi-line conditional cells
// ============================================================================
//
// Each row is a state.  Col 1 cell is a multi-line block:
//   "W/o NCB: __(Ex Gurgaon & Faridabad)
//        - Diesel at 10% on OD
//        - Petrol at 15% on OD
//    NCB:__(Ex Gurgaon & Faridabad)
//        - Diesel at 25% on OD
//        - Petrol at 25% on OD"
//
// Parser emits one rule per (NCB-section × fuel-bullet).  City exclusions
// land in remarks + as separate declined rules per excluded city.
//
// Special shortcuts:
//   - "All business @ N% on OD"             → single COMP rule, all fuels, all NCB
//   - "Existing grid will apply"            → no rules emitted from this row
function parsePvtCarComp(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const stateCell = cellOrNull(row[0]);
    const ruleText  = String(row[1] || '').trim();
    if (!stateCell || !ruleText) continue;
    if (/^rto\s*state$/i.test(stateCell)) continue;

    // State cell may carry multiple states comma-separated:
    //   "JAMMU & KASHMIR, Ladakh" / "ASSAM, SIKKIM, 6 OTHER NORTH ..."
    const states = stateCell.split(/,(?![^()]*\))/).map(s => s.trim()).filter(Boolean);

    // Quick shortcuts
    if (/^existing\s+grid\s+will\s+apply/i.test(ruleText)) continue;

    const allMatch = ruleText.match(/^all\s+business\s*@\s*(\d+(?:\.\d+)?)\s*%\s*on\s*OD/i);
    if (allMatch) {
      const rate = parseFloat(allMatch[1]) / 100;
      for (const state of states) {
        // Sheet covers both Comp and STOD (SAOD) — emit one rule per product.
        for (const rt of ['COMP', 'SAOD']) {
          rules.push({
            product: 'CAR',
            sheet_name: meta.sheetName,
            region: state,
            state: state,
            segment: 'Pvt Car',
            make: 'All',
            rate_type: rt,
            rate_value: rate,
            is_declined: false,
            applied_on: 'OD',
            rate_text: `Robinhood Pvt Car | ${state} | All Business @ ${rate * 100}% OD | ${rt}`,
          });
        }
      }
      continue;
    }

    // Generic multi-line parser
    const parsed = parsePvtCarBlock(ruleText);
    if (parsed.length === 0) {
      console.warn(`[bajaj-robinhood] PVT car block unparsed: state="${stateCell}" text="${ruleText.slice(0, 80)}…"`);
      continue;
    }
    for (const fragment of parsed) {
      for (const state of states) {
        // Sheet "PVT car Comprehensive & STOD" — same grid applies to both
        // Comp and SAOD/STOD; emit one rule per product.
        for (const rt of ['COMP', 'SAOD']) {
          const remarksParts = [];
          if (fragment.excluded_cities && fragment.excluded_cities.length) {
            remarksParts.push(`Excluding: ${fragment.excluded_cities.join(', ')}`);
          }
          if (fragment.irda) remarksParts.push('IRDA default rate');
          // City-cap fragments (e.g. "Muzaffarpur - Max 20%") put the city
          // in `region` (→ City column) while keeping the parent state in
          // `state` (→ State column).  All other fragments use state-level
          // region.
          const regionVal = fragment.city_match ? fragment.sub_region : state;
          rules.push({
            product: 'CAR',
            sheet_name: meta.sheetName,
            region: regionVal,
            state: state,                             // parent state always
            sub_type: fragment.city_match ? null : (fragment.sub_region || null),
            carrier_type: fragment.city_match ? '' : undefined,  // blank Zone for city carve-outs
            segment: 'Pvt Car',
            make: 'All',
            fuel_type: fragment.fuel,
            age_band_min: fragment.ncb ? 1 : 0,
            age_band_max: fragment.ncb ? 99 : 0,
            rate_type: rt,
            rate_value: fragment.rate,
            is_declined: false,
            applied_on: 'OD',
            remarks: remarksParts.join(' | ') || null,
            rate_text: `Robinhood Pvt Car | ${state}${fragment.sub_region ? ' / ' + fragment.sub_region : ''} | ${fragment.ncb ? 'NCB' : 'Non-NCB'} | ${fragment.fuel} ${(fragment.rate * 100).toFixed(2)}% OD | ${rt}`,
          });
          // Excluded-city declined rules — also per product
          if (fragment.excluded_cities) {
            for (const city of fragment.excluded_cities) {
              rules.push({
                product: 'CAR',
                sheet_name: meta.sheetName,
                region: city,
                state: state,                       // first-class state column
                sub_type: null,
                segment: 'Pvt Car',
                make: 'All',
                fuel_type: fragment.fuel,
                age_band_min: fragment.ncb ? 1 : 0,
                age_band_max: fragment.ncb ? 99 : 0,
                rate_type: rt,
                rate_value: null,
                is_declined: true,
                applied_on: 'OD',
                remarks: `Excluded from ${state} grid`,
                rate_text: `Robinhood Pvt Car | ${city} excluded | ${rt}`,
              });
            }
          }
        }
      }
    }
  }
  return rules;
}

/**
 * Parse a multi-line Pvt Car block into rule fragments.
 *
 * Handles:
 *   • Section headers:  "W/o NCB:" / "NCB:" / "Non-NCB business:" / "NCB business:"
 *   • Inline NCB:       "Diesel w/o NCB at 10% on OD"  /  "Petrol NCB at 25% on OD"
 *   • Fuel bullets:     "- <Fuel> at <N>% on OD"
 *   • Region/All:       "Rest business @ 30% on OD"  /  "UP entire state at 10% on OD"
 *   • City exclusion:   "(Excluding Hyderabad)"  /  "(Ex Gurgaon & Faridabad)"
 *
 * Returns: { ncb: bool, fuel: string, rate: number, excluded_cities: string[] }[]
 */
function parsePvtCarBlock(text) {
  const out = [];
  const lines = text.split(/\r?\n/).map(l => l.trim());

  let currentNcb = null;             // null | true (NCB) | false (Non-NCB)
  let currentExcluded = [];
  let pendingRest = null;            // { rate, excluded_cities } — applied at end as catch-all

  // Helper: has the (ncb, fuel, sub_region) combo already been emitted?
  const isCovered = (ncb, fuel, subRegion) =>
    out.some(f => f.ncb === ncb && f.fuel === fuel && (f.sub_region || null) === (subRegion || null));

  // Parse "<rate-token>" → numeric rate or null (IRDA marker).  Returns
  // { rate: number, irda: bool } when matched, or null otherwise.
  const parseRateToken = (s) => {
    if (!s) return null;
    if (/^irda$/i.test(s.trim())) return { rate: irdaRateFor('COMP'), irda: true };
    const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) return null;
    return { rate: parseFloat(m[1]) / 100, irda: false };
  };

  for (const raw of lines) {
    if (!raw) continue;
    let line = raw.replace(/^[-•••]\s*/, '').trim();

    // Pure section header — "W/o NCB:" / "NCB:" / "Non-NCB business:" / "NCB business:"
    const sec = line.match(/^(W\/o\s*NCB(?:\s+business)?|Non[-\s]*NCB(?:\s+business)?|NCB(?:\s+business)?)\s*:?\s*(.*)$/i);
    if (sec) {
      const tag  = sec[1];
      const rest = sec[2] || '';
      currentNcb = /^(W\/o\s*NCB|Non[-\s]*NCB)/i.test(tag) ? false : true;
      currentExcluded = parseExclusions(rest);
      if (!rest.trim() || /^\(\s*ex/i.test(rest.trim())) continue;  // pure header line
      // Otherwise fall through and parse rest as a content line
      line = rest.trim();
    }

    // Inline form: "<Fuel> w/o NCB at <N>% on OD" or "<Fuel> NCB at <N>%"
    const inlineFuel = line.match(/^(Diesel|Petrol|CNG|EV|Electric|Bifuel|LPG|Hybrid)\s+(w\/o\s+NCB|NCB|Non-NCB)\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*%/i);
    if (inlineFuel) {
      const fuel = inlineFuel[1];
      const ncb  = !/w\/o|non-ncb/i.test(inlineFuel[2]);
      const rate = parseFloat(inlineFuel[3]) / 100;
      const excl = [...parseExclusions(line), ...currentExcluded];
      out.push({ ncb, fuel, rate, excluded_cities: [...new Set(excl)] });
      continue;
    }

    // "<City> - Max N%" / "<City> Max N% on OD" — city-specific cap.
    // Per spec: treat City as both State and City (the cell carries no
    // separate state; we mirror the city name into both columns).  Applies
    // to ALL fuels under currentNcb (or both NCB states when no NCB context
    // was set yet — e.g. cells with just "Muzaffarpur - Max 20%").
    const cityMax = line.match(/^([A-Za-z][\w\s&.()'-]*?)\s*[-–:]?\s*Max\s+(\d+(?:\.\d+)?)\s*%(?:\s*on\s*OD)?/i);
    if (cityMax && !/^(W\/o\s*NCB|Non[-\s]*NCB|NCB|Rest\s+business)/i.test(cityMax[1])) {
      const city = cityMax[1].trim();
      const rate = parseFloat(cityMax[2]) / 100;
      const excl = [...parseExclusions(line), ...currentExcluded];
      const ncbStates = currentNcb !== null ? [currentNcb] : [true, false];
      for (const ncb of ncbStates) {
        for (const f of ['Petrol', 'Diesel', 'CNG']) {
          if (!isCovered(ncb, f, city)) {
            out.push({
              ncb, fuel: f, rate,
              excluded_cities: [...new Set(excl)],
              sub_region: city,
              city_match: true,    // signal: emit with region=city, state=city
            });
          }
        }
      }
      continue;
    }

    // "Rest business @ N% on OD" — catch-all that fills (fuel, ncb) combos
    // NOT already explicitly emitted above.  We DEFER applying it to the
    // end of the block so explicit lines take precedence.
    const rest = line.match(/^Rest\s+business\s*@?\s*(\d+(?:\.\d+)?)\s*%/i);
    if (rest) {
      pendingRest = {
        rate: parseFloat(rest[1]) / 100,
        excluded_cities: [...new Set([...parseExclusions(line), ...currentExcluded])],
      };
      continue;
    }

    // Sub-region rule: "<Region>: <rate-token>" / "<Region>: business at <rate>"
    // Examples:
    //   "UP West: business at IRDA"            → sub_region="UP West", IRDA rate
    //   "Rest of UP: 35% on OD"                → sub_region="Rest of UP", 35%
    //   "Bangalore: 25% on OD only"            → sub_region="Bangalore", 25%
    //   "UP entire state at 10% on OD"         → all-state, 10%
    //
    // Must precede the generic bullet matcher so the colon-prefixed form
    // wins over the generic fuel parser.
    const subRegion = line.match(/^([\w\s/&]+?)\s*:\s*(?:business\s+at\s+)?(\d+(?:\.\d+)?\s*%(?:\s*on\s*OD)?|IRDA)/i);
    if (subRegion && currentNcb !== null) {
      const region = subRegion[1].trim();
      const token  = parseRateToken(subRegion[2]);
      if (!token) continue;
      // Skip if the "sub-region" is actually a fuel keyword — that's a
      // bullet, not a region.
      if (/^(Diesel|Petrol|CNG|EV|Electric|Bifuel|LPG|Hybrid|All\s+Fuels?)$/i.test(region)) {
        // fall through to bullet handler
      } else {
        const excl = [...parseExclusions(line), ...currentExcluded];
        for (const f of ['Petrol', 'Diesel', 'CNG']) {
          if (!isCovered(currentNcb, f, region)) {
            out.push({
              ncb: currentNcb, fuel: f, rate: token.rate,
              excluded_cities: [...new Set(excl)],
              sub_region: region,
              irda: token.irda,
            });
          }
        }
        continue;
      }
    }

    // "<state-region> entire state at N% on OD" — applies to ALL fuels under currentNcb.
    // Example: "UP entire state at 10% on OD".
    const regionAt = line.match(/(?:entire\s+state|all\s+state|state)\s+at\s+(\d+(?:\.\d+)?)\s*%\s*on\s*OD/i)
                  || line.match(/^[\w\s&]+\s+at\s+(\d+(?:\.\d+)?)\s*%\s*on\s*OD/i);
    if (regionAt && currentNcb !== null) {
      const rate = parseFloat(regionAt[1]) / 100;
      const excl = [...parseExclusions(line), ...currentExcluded];
      for (const f of ['Petrol', 'Diesel', 'CNG']) {
        if (!isCovered(currentNcb, f, null)) {
          out.push({ ncb: currentNcb, fuel: f, rate, excluded_cities: [...new Set(excl)] });
        }
      }
      continue;
    }

    // Bullet — "Diesel at 10% on OD" / "Petrol at 15% on OD" / "All Fuels at N%"
    const bullet = line.match(/^(Diesel|Petrol|CNG|EV|Electric|Bifuel|LPG|Hybrid|All\s+Fuels?)\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*%\s*(?:on\s*OD)?/i);
    if (bullet && currentNcb !== null) {
      const fuel = bullet[1].replace(/^All\s+Fuels?$/i, 'All');
      const rate = parseFloat(bullet[2]) / 100;
      const excl = [...parseExclusions(line), ...currentExcluded];
      if (fuel === 'All') {
        for (const f of ['Petrol', 'Diesel', 'CNG']) {
          if (!isCovered(currentNcb, f, null)) {
            out.push({ ncb: currentNcb, fuel: f, rate, excluded_cities: [...new Set(excl)] });
          }
        }
      } else if (!isCovered(currentNcb, fuel, null)) {
        out.push({ ncb: currentNcb, fuel, rate, excluded_cities: [...new Set(excl)] });
      }
    }
  }

  // Apply pending "Rest business" rate to every (NCB × fuel) combination
  // that's still uncovered at the all-state level.  This is the catch-all
  // fallback for combinations not explicitly specified above.
  if (pendingRest) {
    for (const ncb of [true, false]) {
      for (const f of ['Petrol', 'Diesel', 'CNG']) {
        if (!isCovered(ncb, f, null)) {
          out.push({
            ncb,
            fuel: f,
            rate: pendingRest.rate,
            excluded_cities: pendingRest.excluded_cities,
          });
        }
      }
    }
  }

  return out;
}

/** Extract city names from "(Ex city1 & city2)" / "(Excluding city)" patterns. */
function parseExclusions(text) {
  const m = text.match(/\(\s*(?:Ex(?:cluding)?)\.?\s*([^)]+)\)/i);
  if (!m) return [];
  return m[1].split(/&|,/).map(s => s.trim()).filter(Boolean);
}

// ============================================================================
//  TW NEW(1826) — district × make-bucket Doable/Declined matrix
// ============================================================================
//
// Layout (R0 header):
//   Districtname | Statename | Bajaj > 135 cc | Bajaj Upto 135 cc |
//   Other MC > 135 cc | Other MC Upto 135 cc | Royal Enfield | Scooters |
//   Additional Comments
//
// Cell values: "Doable" / "Declined" / "Doable. <conditional>"
//
// Doable cells emit a rule with rate=null (decision flag — actual rate comes
// from File 2's Comp/SAOD grid).  Declined cells emit is_declined=true.
const TW_NEW_MAKE_BUCKETS = [
  { col: 2, make: 'Bajaj',       cc_min: 136, cc_max: 9999 },
  { col: 3, make: 'Bajaj',       cc_min: 0,   cc_max: 135  },
  { col: 4, make: 'Others',      cc_min: 136, cc_max: 9999, sub_type: 'MC' },
  { col: 5, make: 'Others',      cc_min: 0,   cc_max: 135,  sub_type: 'MC' },
  { col: 6, make: 'Royal Enfield', cc_min: null, cc_max: null },
  { col: 7, make: 'All',         cc_min: null, cc_max: null, segment: 'Scooter' },
];

function parseTwNew(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const district = cellOrNull(row[0]);
    const state    = cellOrNull(row[1]);
    if (!district || !state) continue;
    const comment  = cellOrNull(row[8]);

    for (const b of TW_NEW_MAKE_BUCKETS) {
      const cell = cellOrNull(row[b.col]);
      if (!cell) continue;
      const isDoable   = /^doable/i.test(cell);
      const isDeclined = /^declined/i.test(cell);
      if (!isDoable && !isDeclined) continue;

      rules.push({
        product:  'TW',
        sheet_name: meta.sheetName,
        region:   district,
        state:    state,                              // first-class state column
        segment:  b.segment || 'Bike',
        make:     b.make,
        cc_band_min: b.cc_min,
        cc_band_max: b.cc_max,
        // "TW NEW(1826)" = new vehicle — vehicle age 0 only.
        vehicle_age_min: 0,
        vehicle_age_max: 0,
        rate_type: 'COMP',
        rate_value: null,                                  // decision flag only
        is_declined: isDeclined,
        remarks: comment || (isDoable && cell !== 'Doable' ? cell : null),
        rate_text: `Robinhood TW NEW (1826) | ${district} | ${b.make}${b.cc_min!=null?' '+b.cc_min+'-'+b.cc_max+'cc':''} | ${cell}`,
      });
    }
  }
  return rules;
}

// ============================================================================
//  PVT car New (1825) — district × Pvt Car Doable/Declined
// ============================================================================
//
// Each row: District | State | Cell.
// Cell formats observed:
//   • "Doable"                                    — plain doable
//   • "Declined"                                  — plain declined
//   • "Doable. Maruti & Hyundai Declined"         — doable + declined makes
//   • "Doable for <models> @Total 35% on OD"      — model whitelist + rate
//   • "Doable for <models> @Total 35% on OD.
//      Applicable for Petrol variants only"       — + fuel restriction
//   • "HEV Treaty makes doable @Total 35% on OD.
//      Other makes NOT DOABLE"                    — HEV makes only + others declined
//   • "Doable for <models>, HEV Treaty Makes
//      @Total 35% on OD"                          — models + HEV makes combo
//   • "Doable for Mahindra & Mahindra.
//      Doable models: Scorpio N, Thar, XUV700"    — make + specific models
//   • "Doable for ... @total 30% on OD. Max CD @50%" — rate + CD cap
//   • "Doable for Seltos Petrol, ..."             — model with embedded fuel
function parsePvtCarNew(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const district = cellOrNull(row[0]);
    const state    = cellOrNull(row[1]);
    const cell     = cellOrNull(row[2]);
    if (!district || !state || !cell) continue;

    const parsed = parsePvtCarNewCell(cell);
    if (!parsed) continue;   // unrecognised — skip
    for (const frag of parsed) {
      rules.push({
        product:  'CAR',
        sheet_name: meta.sheetName,
        region:   district,
        state:    state,                              // first-class state column
        segment:  'Pvt Car',
        make:     frag.make || 'All',
        model:    frag.model || null,
        fuel_type: frag.fuel || null,
        // "Pvt Car New (1825)" = new vehicle — every rule here applies
        // to brand-new policies (vehicle age 0 only).
        vehicle_age_min: 0,
        vehicle_age_max: 0,
        rate_type: 'COMP',
        rate_value: frag.rate ?? null,
        is_declined: frag.declined === true,
        volume_tier: frag.cd_cap ? String(frag.cd_cap) : null,
        remarks:  frag.note || cell,
        rate_text: `Robinhood Pvt Car NEW (1825) | ${district} | ${frag.label || cell}`,
      });
    }
  }
  return rules;
}

/**
 * Parse a PVT car New (1825) cell into rule fragments.
 *
 * Returns an array of fragments:
 *   { make, model, fuel, rate, cd_cap, declined, note, label }
 *
 * Returns [] when the cell is empty / unrecognised.
 */
function parsePvtCarNewCell(cell) {
  const text = String(cell || '').trim();
  if (!text) return [];
  const out = [];

  // Plain "Doable" / "Declined" — no further structure
  if (/^doable\s*\.?$/i.test(text))   return [{ make: 'All', label: 'Doable' }];
  if (/^declined\s*\.?$/i.test(text)) return [{ make: 'All', declined: true, label: 'Declined' }];

  // "Doable @35% on OD total" / "Doable @ 35% on OD" — Doable for everyone
  // at the stated rate (no model/make restriction).
  const doableRate = text.match(/^doable\s*@?\s*(\d+(?:\.\d+)?)\s*%\s*(?:on\s*OD)?(?:\s*total)?\s*\.?$/i);
  if (doableRate) {
    return [{
      make: 'All',
      rate: parseFloat(doableRate[1]) / 100,
      label: `Doable @${doableRate[1]}% on OD`,
    }];
  }

  // Extract rate (one of "@Total 35% on OD" / "@total 30% on OD" / "@ 35%")
  let rate = null;
  let m = text.match(/@\s*(?:total\s*)?(\d+(?:\.\d+)?)\s*%/i);
  if (m) rate = parseFloat(m[1]) / 100;

  // Extract CD cap (e.g. "Max CD @50%")
  let cdCap = null;
  m = text.match(/Max\s*CD\s*@?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (m) cdCap = parseFloat(m[1]);

  // Fuel restriction: "Applicable for Petrol variants only" / "Petrol variants only"
  let cellFuel = null;
  m = text.match(/(?:Applicable\s+for\s+)?(Petrol|Diesel|CNG|EV|Electric)\s+variants?\s+only/i);
  if (m) cellFuel = m[1];

  // "HEV Treaty makes doable" / "HEV Treaty Makes" — expand using constant
  const hasHEV = /\bHEV\s*Treaty\s*Makes?/i.test(text);
  // "Other makes NOT DOABLE" — emit decline for non-listed makes
  const otherDeclined = /Other\s+makes\s+NOT\s+DOABLE/i.test(text);

  // Extract model list from "Doable for <models>" (up to first ".", "@", or end)
  let modelList = [];
  const modelsMatch = text.match(/Doable\s+for\s+([^@.]+?)(?:\s*@|\s*\.|$)/i);
  if (modelsMatch) {
    modelList = modelsMatch[1]
      .split(/,|&/)
      .map(s => s.trim())
      .filter(s => s && !/HEV\s*Treaty\s*Makes?/i.test(s));   // HEV handled separately
  }

  // "Doable models: A, B, C" form (after a make declaration)
  const modelsBlock = text.match(/Doable\s+models?\s*[:\-]\s*([^.]+)/i);
  if (modelsBlock) {
    modelList = modelsBlock[1]
      .split(/,/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Emit one fragment per model
  for (const m of modelList) {
    // Model name may carry an embedded fuel suffix ("Seltos Petrol")
    const fuelInModel = m.match(/^(.+?)\s+(Petrol|Diesel|CNG|EV|Electric)$/i);
    const model = fuelInModel ? fuelInModel[1].trim() : m;
    const fuel  = fuelInModel ? fuelInModel[2] : cellFuel;
    out.push({
      make: model,                              // models often double as make for matching
      model: model,
      fuel,
      rate,
      cd_cap: cdCap,
      label: `Doable: ${model}${fuel ? ' (' + fuel + ')' : ''}${rate != null ? ' @' + (rate * 100) + '%' : ''}`,
    });
  }

  // Expand HEV Treaty makes when referenced
  if (hasHEV) {
    for (const [make, models] of Object.entries(HEV_TREATY)) {
      if (models.length === 1 && models[0] === 'ALL') {
        out.push({
          make,
          fuel: cellFuel,
          rate,
          cd_cap: cdCap,
          label: `HEV ${make}${rate != null ? ' @' + (rate * 100) + '%' : ''}`,
          note: 'HEV Treaty make',
        });
      } else {
        for (const model of models.flatMap(m => m.split(','))) {
          out.push({
            make,
            model: model.trim(),
            fuel: cellFuel,
            rate,
            cd_cap: cdCap,
            label: `HEV ${make} ${model}${rate != null ? ' @' + (rate * 100) + '%' : ''}`,
            note: 'HEV Treaty make/model',
          });
        }
      }
    }
  }

  // Decline non-listed makes when "Other makes NOT DOABLE"
  if (otherDeclined && out.length > 0) {
    out.push({
      make: 'Others',
      declined: true,
      label: 'Other makes NOT DOABLE',
      note: 'Only listed makes/models are doable',
    });
  }

  // "Doable. Maruti & Hyundai Declined" — declined-make tail (after Doable)
  // Match phrases like "<Make> & <Make> Declined" or "<Make> Declined"
  const declTail = text.match(/Doable[.,]\s*([^.]+?)\s+Declined(?:\.|$)/i);
  if (declTail && out.length === 0) {
    // No explicit doable list — emit baseline Doable and decline the listed makes
    out.push({ make: 'All', label: 'Doable' });
    const declinedMakes = declTail[1].split(/&|,/).map(s => s.trim()).filter(Boolean);
    for (const m of declinedMakes) {
      out.push({ make: m, declined: true, label: `${m} Declined` });
    }
  }

  // No fragments matched — return a single descriptive remark-only fragment
  if (out.length === 0) {
    return [{ make: 'All', note: text.slice(0, 200), label: 'Unparsed' }];
  }
  return out;
}

// ============================================================================
//  Sheet5 — Hero/TVS CD-band state grid (mirror of File 1 HMC&TVS sheet)
// ============================================================================
function parseSheet5(sheetData, sheetConfig, meta) {
  const rules = [];
  const CD_BANDS = [
    { col: 2, label: '0-20%',  disc_min: 0,  disc_max: 20 },
    { col: 3, label: '20-40%', disc_min: 20, disc_max: 40 },
    { col: 4, label: '40-50%', disc_min: 40, disc_max: 50 },
    { col: 5, label: '50-60%', disc_min: 50, disc_max: 60 },
  ];
  // Forward-fill OEM + rate cells (merged cells in source appear blank
  // on subsequent rows; xlsx only returns top-left of a merge).
  let currentOem = null;
  const lastRate = {};
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const oem = cellOrNull(row[0]);
    if (oem) currentOem = oem;
    const state = cellOrNull(row[1]);
    if (!state || !currentOem) continue;
    const makes = currentOem.includes('&')
      ? currentOem.split('&').map(s => s.trim()).filter(Boolean)
      : [currentOem];
    for (const make of makes) {
      for (const band of CD_BANDS) {
        const v = cellOrNull(row[band.col]);
        let cellRate = null;
        if (v) {
          const m = String(v).match(/^(\d+(?:\.\d+)?)\s*%?$/);
          if (m) {
            const n = parseFloat(m[1]);
            cellRate = n > 1 ? n / 100 : n;
          }
        }
        if (cellRate != null) lastRate[band.col] = cellRate;
        const rate = cellRate != null ? cellRate : lastRate[band.col];
        if (rate == null) continue;
        rules.push({
          product:  'TW',
          sheet_name: meta.sheetName,
          region:   state,
          segment:  'TW',
          make:     make,
          rate_type: 'COMP',
          rate_value: rate,
          is_declined: false,
          volume_tier: band.label,
          remarks: `CD ${band.label}; Robinhood Hero/TVS grid`,
          rate_text: `${make} | ${state} | CD ${band.label}`,
        });
      }
    }
  }
  return rules;
}

// ============================================================================
//  Top-level dispatch
// ============================================================================
function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind;
  switch (kind) {
    case 'cv':              return parseCV(sheetData, sheetConfig, meta);
    case 'pvt_car_comp':    return parsePvtCarComp(sheetData, sheetConfig, meta);
    case 'tw_new':          return parseTwNew(sheetData, sheetConfig, meta);
    case 'pvt_car_new':     return parsePvtCarNew(sheetData, sheetConfig, meta);
    case 'sheet5_cd_grid':  return parseSheet5(sheetData, sheetConfig, meta);
    default:
      console.warn(`[bajaj-robinhood] unknown sheet_kind "${kind}" for "${meta.sheetName}"`);
      return [];
  }
}

module.exports = { parse, HEV_TREATY, parsePvtCarBlock, analyzeCvRemark };
