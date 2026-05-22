/**
 * shriram_grid engine
 *
 * Parses Shriram General's monthly Broker Grid + 2W companion sheets.
 * Two row shapes are supported, selected per-sheet via `config.sheet_kind`:
 *
 *   sheet_kind: 'broker_grid'  (BROKER GRID MAR 26, Short-term policy)
 *     Header: State | PRODUCTS | DIS % | PAYOUT % | POLICY TYPE | Age |
 *             UW REMARKS | REMARKS 1
 *     PRODUCTS column encodes product + sub-segment + weight band + fuel +
 *     seating, e.g.
 *       "PCCV 4W SCHOOL BUS"
 *       "PCCV 4W Upto 6+1"
 *       "GCCV LCV UPTO 2000 GVW"
 *       "GCCV LCV 2001-2800 GVW"
 *       "GCCV MCV ABOVE 7501 TO 12000 GVW"
 *       "GCCV HCV 12001 TO 42500 GVW"
 *       "PRIVATE CAR PETROL"
 *       "PRIVATE CAR DIESEL"
 *       "GCCV 3W Except E-CART"
 *       "MISC ----"
 *
 *   sheet_kind: 'two_wheeler'  (New Business - 2W, ROLLOVE (PKG+TP) - 2W)
 *     Header: STATE | MANUFACTURER | BODY TYPE | POLICY TYPE | DIS % |
 *             Average Net PO | UW'S CONDITION | (CHANGE DATE)
 *     The Rollover sheet inserts a PRODUCT NAME column and CC column
 *     between fields; we drive parsing from explicit column indices in
 *     `config.columns`.
 *
 * Shared behaviour:
 *   - PAYOUT cells are passed through normalizeRate; conditional cells
 *     (e.g. "SC>15 PO 50% & <15 30%", "METRO 40 & NON METRO 35", "25 OD")
 *     keep the original string in rate_text and set is_conditional=true.
 *   - State strings are preserved in `region` as-is so downstream lookup
 *     can fan them out (`PAN INDIA` becomes null so the rule covers all).
 *   - Age columns like "upto 15 years", "5 to 10 years" → vehicle_age_min/max.
 *   - Rows where DIS% and PAYOUT% are both 0 are emitted as is_declined.
 */

const { normalizeRate, cleanString } = require('../utils/normalizer');

// Helpers ---------------------------------------------------------------

function _str(v) { return cleanString(v == null ? '' : String(v)); }

/** "PAN INDIA" / "All India" / blank → null (covers all states). */
function _normaliseRegion(state) {
  const s = _str(state).toUpperCase();
  if (!s) return null;
  if (s === 'PAN INDIA' || s === 'PAN-INDIA' || s === 'ALL INDIA' || s === 'ALL') return null;
  return _str(state);
}

/** Parse age band from various Shriram cells:
 *    "upto 15 years"        → { min: 0,  max: 15 }
 *    "6 to 15"              → { min: 6,  max: 15 }
 *    "5 to 10 years"        → { min: 5,  max: 10 }
 *    "11 years to 25 years" → { min: 11, max: 25 }   ← word "years" between
 *    "above 5 years"        → { min: 5,  max: null }
 *  Returns {} when the cell carries no usable range. */
function _parseAgeBand(raw) {
  const s = _str(raw).toLowerCase();
  if (!s || s === '-') return {};
  let m;
  if ((m = s.match(/upto\s+(\d+)\s*(?:years?|yrs?)?/))) return { min: 0, max: parseInt(m[1], 10) };
  // Range: "N to M" with optional "years"/"yrs" between either number and the
  // word "to" or trailing.
  if ((m = s.match(/(\d+)\s*(?:years?|yrs?)?\s+to\s+(\d+)\s*(?:years?|yrs?)?/))) {
    return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }
  if ((m = s.match(/^above\s+(\d+)/))) return { min: parseInt(m[1], 10), max: null };
  return {};
}

/** Shriram's Age column frequently encodes TWO bounds in one cell:
 *    "upto 15 years & upto 20 Years for STP"
 *      → main 0-15 (Comp)  |  STP 0-20 (TP / Standalone-TP)
 *    "upto 15 years & upto 25 Years for STP"
 *      → main 0-15 (Comp)  |  STP 0-25 (TP / Standalone-TP)
 *    "upto 15 years."     → main 0-15, no STP carve-out
 *    "5 to 10 years"      → main 5-10, no STP carve-out
 *
 *  STP = Standalone Third-Party (long-tenure liability-only product). The
 *  carve-out gives the TP rule a longer age cap than the Comp rule. SAOD
 *  is unrelated and is NOT inferred from this column.
 *
 *  Returns { mainMin, mainMax, tpMax } (any may be null). */
function _parseAgeWithStp(raw) {
  const s = _str(raw).toLowerCase();
  if (!s || s === '-') return { mainMin: null, mainMax: null, tpMax: null };
  let tpMax = null;
  const stpMatch = s.match(/upto\s+(\d+)\s*(?:years?|yrs?)?\s*(?:&\s*)?(?:up\s*to)?\s*for\s*stp/i)
                || s.match(/&\s*upto\s+(\d+)\s*(?:years?|yrs?)?[^a-z0-9]*for\s*stp/i);
  if (stpMatch) tpMax = parseInt(stpMatch[1], 10);
  // Strip the STP carve-out then parse the rest.
  const rest = s.replace(/&.*?stp.*$/i, '').replace(/[.,]+$/, '').trim();
  const main = _parseAgeBand(rest);
  return {
    mainMin: main.min ?? null,
    mainMax: main.max ?? null,
    tpMax,
  };
}

/** Detect a Nil-Dep conditional payout in remarks. Patterns:
 *    "for NIL dep cases payout is 42.5%"
 *    "Nil Dep cases @ 42.5%"
 *    "with NIL DEP - 42%"
 *  Returns the conditional rate (number) or null. The engine emits a 2nd
 *  row with rate_type tagged _NilDep so the export's inferNilDepFlag sets
 *  the column to "Yes". */
function _parseNilDepConditional(remarksRaw) {
  const s = _str(remarksRaw);
  if (!s) return null;
  // "for NIL dep cases payout is 42.5%" / "Nil Dep payout is 42%"
  let m = s.match(/(?:for\s+)?nil\s*dep[^.]*?(?:payout\s*is|@|=|-|:)\s*([\d.]+)\s*%/i);
  if (m) return parseFloat(m[1]);
  // "with NIL DEP — 42.5"
  m = s.match(/(?:with|in)\s+nil\s*dep[^.]*?([\d.]+)\s*%/i);
  if (m) return parseFloat(m[1]);
  return null;
}

/** Numeric-or-blank → number|null. "80", "80.5", "80%", "-", "" all handled. */
function _parsePctCell(raw) {
  const s = _str(raw).replace(/%/g, '').trim();
  if (!s || s === '-') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/** Shriram payout cell parser. Cells in the PAYOUT column carry a leading
 *  rate plus an optional applied-on suffix:
 *    "27.5"            → { rate_value: 27.5, applied_on: null }
 *    "25 OD"           → { rate_value: 25,   applied_on: 'OD' }
 *    "15 OD"           → { rate_value: 15,   applied_on: 'OD' }
 *    "10 TP"           → { rate_value: 10,   applied_on: 'TP' }
 *    "17% Net Payout"  → { rate_value: 17,   applied_on: 'NET' }
 *    "35 Net Payout"   → { rate_value: 35,   applied_on: 'NET' }
 *    "35% OD PO"       → { rate_value: 35,   applied_on: 'OD' }
 *    "4.50% OD +_ 5 TP"→ { rate_value: 4.5,  applied_on: 'OD', is_conditional: true,
 *                           rate_text: "4.50% OD +_ 5 TP" }
 *    "SC>15 PO 50% ..."→ { rate_value: null, is_conditional: true, rate_text: original }
 *    "D"/"NA"          → { is_declined: true }
 *  Returns null for empty / "-". */
function _parseShriramPayout(raw) {
  const s = _str(raw).trim();
  if (!s || s === '-') return null;
  if (/^(?:D|NA|Declined)$/i.test(s)) {
    return { rate_value: null, is_declined: true };
  }
  // METRO / NON-METRO conditional — "METRO 40 & NON METRO 35" / "METRO
  // 40 NON-METRO 35". A post-processor (applyShriramMetroLookup in
  // parsers/engine.js) reads the workbook's "Metro RTO Codes" sheet and
  // expands each tagged rule into one row per metro city + one non-metro
  // row. Here we just stash the rates so the post-processor can pick
  // them up via `rule._metro_split`.
  const mm = s.match(/METRO\s*(\d+(?:\.\d+)?)\s*%?\s*(?:&|AND|,)?\s*(?:NON[\s-]*METRO|NON\s*METRO|NONMETRO)\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (mm) {
    return {
      _metro_split: { metro_rate: parseFloat(mm[1]), non_metro_rate: parseFloat(mm[2]) },
      rate_value: parseFloat(mm[1]),   // placeholder — gets replaced per emission by post-processor
      rate_text: s,
      is_conditional: false,
    };
  }
  // SC-conditional cell — "SC>15 PO 50% & <15 30%" / "SC > 15 PO 50% &
  // SC < 15 30%". SC = Seating Capacity. Each branch becomes its own
  // emission with the matching seating band; the broker_grid emitter
  // iterates `sc_variants` instead of the single rate when present.
  const scM = s.match(/SC\s*([><]=?)\s*(\d+)\s*P?O?\s*(\d+(?:\.\d+)?)\s*%?\s*&\s*(?:SC\s*)?([><]=?)\s*(\d+)\s*P?O?\s*(\d+(?:\.\d+)?)\s*%?/i);
  if (scM) {
    const buildBand = (op, n) => {
      const v = parseInt(n, 10);
      switch (op) {
        case '>':  return { seating_min: v + 1, seating_max: null };
        case '>=': return { seating_min: v,     seating_max: null };
        case '<':  return { seating_min: null,  seating_max: v - 1 };
        case '<=': return { seating_min: null,  seating_max: v     };
      }
      return { seating_min: null, seating_max: null };
    };
    const v1 = { rate_value: parseFloat(scM[3]), ...buildBand(scM[1], scM[2]) };
    const v2 = { rate_value: parseFloat(scM[6]), ...buildBand(scM[4], scM[5]) };
    return {
      sc_variants: [v1, v2],
      rate_value: v1.rate_value,    // first variant as fallback
      rate_text: s,
      is_conditional: false,
    };
  }
  // Plain number ("27.5" / "15.0" / "0").
  const plain = Number(s);
  if (!isNaN(plain) && /^[\d.]+$/.test(s)) {
    return { rate_value: plain, applied_on: null };
  }
  // Split OD+TP cell — "15 OD + 1.5 TP" / "19.5 OD+2.5 TP" /
  // "4.50% OD +_ 5 TP" (Future's odd "+_" delimiter). Surface BOTH rates
  // so the engine can give Comp rules the OD rate and TP rules the TP rate.
  const split = s.match(/^([\d.]+)\s*%?\s*OD\b[\s+_\-&,]+([\d.]+)\s*%?\s*TP\b/i);
  if (split) {
    return {
      od_rate: parseFloat(split[1]),
      tp_rate: parseFloat(split[2]),
      rate_value: parseFloat(split[1]),   // default for emitters that don't know which side
      applied_on: 'OD',                    // base orientation; per-ins override happens at emission
      rate_text: s,                        // preserve the original for audit
      is_conditional: false,
    };
  }
  // Leading "<number>[%] [on] <OD|TP|NET|GROSS> [...]"
  const m = s.match(/^([\d.]+)\s*%?\s*(?:on\s+)?(OD|TP|NET|GROSS)\b/i);
  if (m) {
    const rest = s.slice(m[0].length).trim();
    const hasMore = rest && !/^(payout|po|rate|%)\s*$/i.test(rest);
    return {
      rate_value: parseFloat(m[1]),
      applied_on: m[2].toUpperCase() === 'GROSS' ? 'GROSS' : m[2].toUpperCase(),
      rate_text: hasMore ? s : null,
      is_conditional: !!hasMore,
    };
  }
  // Anything else with a leading number — keep that number, flag conditional.
  const lead = s.match(/^([\d.]+)/);
  if (lead) {
    return { rate_value: parseFloat(lead[1]), rate_text: s, is_conditional: true };
  }
  // No usable number — full conditional cell.
  return { rate_value: null, rate_text: s, is_conditional: true };
}

/** Compose rate_type tag including ins-product + applied-on. The
 *  Comp/SAOD/TP prefix survives the rate-lookup pattern match in
 *  services/rate-lookup.js; the OD/TP/NET suffix is consumed by the
 *  export's inferAppliedOn so the "Applied on" column reads correctly.
 *  Optional tenureTag (e.g. "1+5") is appended so the export's
 *  inferTenure() pattern-match (`(\d)\+(\d)`) picks it up per row. */
function _composeRateType(insProduct, appliedOn, tenureTag) {
  let prefix;
  switch (insProduct) {
    case 'Comp': prefix = 'PACK_SHRIRAM'; break;
    case 'TP':   prefix = 'SATP_SHRIRAM'; break;
    case 'SAOD': prefix = 'SAOD_SHRIRAM'; break;
    default:     prefix = 'PACK_SHRIRAM';
  }
  let out = prefix;
  if (tenureTag) out += '_' + tenureTag;
  if (appliedOn) out += '_' + appliedOn;
  return out;
}

/** When the POLICY TYPE cell says BUNDLE, fan the row into 6 tenure
 *  combinations: OD tenures {1, 3, 5} × TP tenures {3, 5}. Returns an
 *  array of tenure tags ("1+3", "1+5", ...) — caller emits one rule per
 *  tag with rate_type tagged via _composeRateType. Non-bundle policies
 *  return [null] (caller emits a single untagged rule). */
function _bundleTenureCombos(rawPolicy) {
  if (!/BUNDLE/i.test(_str(rawPolicy))) return [null];
  const combos = [];
  for (const od of [1, 3, 5]) {
    for (const tp of [3, 5]) {
      combos.push(`${od}+${tp}`);
    }
  }
  return combos;
}

/** Parse the PRODUCTS cell of a broker-grid row.
 *  Recognises Shriram's own taxonomy:
 *    PCCV 4W ...   → CAR / PCV 4W (passenger commercial — buses & taxis)
 *    PCCV 3W ...   → PCV 3W (passenger 3-wheeler)
 *    GCCV LCV ...  → GCV with weight band
 *    GCCV MCV ...  → GCV with weight band
 *    GCCV HCV ...  → GCV with weight band
 *    GCCV 3W ...   → GCV 3W
 *    PRIVATE CAR   → CAR
 *    MISC          → MISC
 *  Returns { product, sub_type?, segment?, fuel_type?, weight_band_min?,
 *  weight_band_max?, seating_capacity_min?, seating_capacity_max?,
 *  carrier_type? } */
function _parseProductsCell(raw) {
  const out = { product: null };
  const s = _str(raw).toUpperCase();
  if (!s) return out;
  out.segment = _str(raw); // preserve original wording

  // Fuel hints anywhere in the cell. "E-CART" / "E-KART" / "E-RICKSHAW"
  // are 3W-electric synonyms — count them as Electric mentions. The
  // "Except" qualifier (e.g. "GCCV 3W Except E-CART") flips this to an
  // *exclusion* and is handled via _parseUwRemarks.fuel_excluded later;
  // here we only set fuel_type when the cell is positively about that fuel.
  const hasExcept = /\b(EXCEPT|WITHOUT|NON|EXCL\.?|EXCLUDING)\b/.test(s);
  if (/\bPETROL\b/.test(s))   out.fuel_type = 'Petrol';
  else if (/\bDIESEL\b/.test(s)) out.fuel_type = 'Diesel';
  else if (!hasExcept && (/\bELECTRIC\b|\bEV\b|\bE[-\s]?CART\b|\bE[-\s]?KART\b|\bE[-\s]?RICKSHAW\b/.test(s))) {
    out.fuel_type = 'Electric';
  }
  else if (/\bCNG\b/.test(s)) out.fuel_type = 'CNG';

  // Weight band — "UPTO 2000 GVW" / "2001-2800 GVW" / "ABOVE 7501 TO 12000 GVW"
  // / "12001 TO 42500 GVW" / "ABOVE 50000 GVW". Shriram quotes GVW in
  // kilograms; the rest of the system stores weight bands in tonnes
  // (matches HDFC/ICICI/Chola/etc.). Divide by 1000 so Bulk Calc's
  // tonnage filter compares like-with-like (e.g. "2.5T" policy ↔ rule
  // weight 2.5, not 2500).
  const _kg = (n) => Math.round(n / 10) / 100; // kg → tonnes, 2 dp
  let wm;
  if ((wm = s.match(/UPTO\s+(\d+)\s*GVW/))) {
    out.weight_band_max = _kg(parseInt(wm[1], 10));
  } else if ((wm = s.match(/ABOVE\s+(\d+)\s*GVW\s+TO\s+(\d+)\s*GVW/))) {
    // "ABOVE 2801 GVW TO 3500 GVW" — GVW twice with TO between.
    out.weight_band_min = _kg(parseInt(wm[1], 10));
    out.weight_band_max = _kg(parseInt(wm[2], 10));
  } else if ((wm = s.match(/ABOVE\s+(\d+)\s+TO\s+(\d+)\s*GVW/))) {
    out.weight_band_min = _kg(parseInt(wm[1], 10));
    out.weight_band_max = _kg(parseInt(wm[2], 10));
  } else if ((wm = s.match(/(\d+)\s*[-]\s*(\d+)\s*GVW/))) {
    out.weight_band_min = _kg(parseInt(wm[1], 10));
    out.weight_band_max = _kg(parseInt(wm[2], 10));
  } else if ((wm = s.match(/(\d+)\s+TO\s+(\d+)\s*GVW/))) {
    out.weight_band_min = _kg(parseInt(wm[1], 10));
    out.weight_band_max = _kg(parseInt(wm[2], 10));
  } else if ((wm = s.match(/ABOVE\s+(\d+)\s*GVW/))) {
    out.weight_band_min = _kg(parseInt(wm[1], 10));
  }

  // Seating — multiple formats seen in Shriram broker grid:
  //   "PCCV 4W Upto 6+1"   → max = 6+1 = 7
  //   "PCCV 4W (7-10)"     → 7-10
  //   "PCCV 4W (7 to 10)"  → 7-10
  //   "PCCV 4W 7 to 10"    → 7-10  (no parens)
  //   "Shriram (6+1)"      → 7-7
  //   "PCV 7 to 10 SEATER" → 7-10
  let sm;
  if ((sm = s.match(/UPTO\s+(\d+)\+1/))) {
    out.seating_capacity_max = parseInt(sm[1], 10) + 1;
  } else if ((sm = s.match(/\((\d+)\s*[-]\s*(\d+)\)/))) {
    // "(7-10)" — paren range with hyphen
    out.seating_capacity_min = parseInt(sm[1], 10);
    out.seating_capacity_max = parseInt(sm[2], 10);
  } else if ((sm = s.match(/\((\d+)\s+TO\s+(\d+)\)/i))) {
    // "(7 to 10)" — paren range with "to"
    out.seating_capacity_min = parseInt(sm[1], 10);
    out.seating_capacity_max = parseInt(sm[2], 10);
  } else if ((sm = s.match(/(\d+)\s+TO\s+(\d+)\s+SEAT/i))) {
    // "7 to 10 seater"
    out.seating_capacity_min = parseInt(sm[1], 10);
    out.seating_capacity_max = parseInt(sm[2], 10);
  } else if ((sm = s.match(/\b(?:GCCV|PCCV|GCV|PCV)\s*\d+W\s+(\d+)\s+TO\s+(\d+)\b/i))) {
    // Bare range after wheel-class: "PCCV 4W 7 to 10"
    out.seating_capacity_min = parseInt(sm[1], 10);
    out.seating_capacity_max = parseInt(sm[2], 10);
  }

  // Product family + sub-type.
  if (/^PCCV\b/.test(s)) {
    // Passenger Carrying Commercial Vehicle — buses, taxis, etc.
    out.product = 'PCV';
    if (/SCHOOL\s*BUS/.test(s))         out.sub_type = 'School Bus';
    else if (/CORPORATE\s*BUS/.test(s)) out.sub_type = 'Corporate Bus';
    else if (/TOURIST\s*BUS/.test(s))   out.sub_type = 'Tourist Bus';
    else if (/TAXI/.test(s))            out.sub_type = 'Taxi';
    else if (/3W/.test(s))              out.sub_type = '3W Auto';
    else if (/UPTO\s+\d+\+1/.test(s))   out.sub_type = 'Upto 6+1';
    return out;
  }
  if (/^GCCV\b/.test(s) || /^GCV\b/.test(s)) {
    out.product = 'GCV';
    if (/3W/.test(s)) out.sub_type = '3W';
    else if (/LCV/.test(s)) out.sub_type = 'LCV';
    else if (/MCV/.test(s)) out.sub_type = 'MCV';
    else if (/HCV/.test(s)) out.sub_type = 'HCV';
    else if (/MISD/.test(s)) out.sub_type = 'MISD';
    return out;
  }
  if (/PRIVATE\s+CAR|^PVT\s*CAR\b|^PC\b/.test(s)) {
    out.product = 'CAR';
    return out;
  }
  if (/^MISC?\b|MISCELLANEOUS|TRACTOR|HARVESTER|CRANE|EXCAVATOR/.test(s)) {
    out.product = 'MISC';
    if (/TRACTOR/.test(s))    out.sub_type = 'Tractor';
    else if (/HARVESTER/.test(s)) out.sub_type = 'Harvester';
    else if (/CRANE/.test(s))     out.sub_type = 'Crane';
    return out;
  }
  if (/TWO\s*WHEELER|^2W\b|^TW\b|BIKE|SCOOTER|MOPED/.test(s)) {
    out.product = 'TW';
    if (/BIKE|MOTOR/.test(s))     out.sub_type = 'Bike';
    else if (/SCOOTER|SCOOTY/.test(s)) out.sub_type = 'Scooter';
    else if (/MOPED/.test(s))     out.sub_type = 'Moped';
    return out;
  }
  return out;
}

/** Map Shriram POLICY TYPE codes to ins_product / rate_type hints used
 *  downstream:
 *    "P"     → Comp (Package — full coverage)
 *    "L"     → TP   (Liability only — Third Party)
 *    "P & L" → Comp (Package + liability sold together)
 *    "STP"   → SAOD (Standalone OD short-term)
 *    "BUNDLE"/"BUNDLED" → Comp (1+5 bundle, etc.)
 */
function _policyTypeToIns(raw) {
  const s = _str(raw).toUpperCase();
  if (!s) return null;
  if (/STP|SHORT[\s-]*TERM/.test(s)) return 'SAOD';
  if (/BUNDLE/.test(s))  return 'Comp';
  if (/^P\s*$/.test(s))  return 'Comp';
  if (/P\s*&\s*L/.test(s)) return 'Comp';
  if (/^L\s*$/.test(s))  return 'TP';
  if (/PACKAGE/.test(s)) return 'Comp';
  return null;
}

/** Map ins_product hint → rate_type token that survives the rate-lookup
 *  Comp/SAOD/TP pattern match in services/rate-lookup.js. We use:
 *    Comp → 'PACK_SHRIRAM'  (matched by 'PACK%' pattern)
 *    TP   → 'SATP_SHRIRAM'  (matched by 'SATP%' pattern)
 *    SAOD → 'SAOD_SHRIRAM'  (matched by 'SAOD%' pattern)
 *  The "_SHRIRAM" suffix preserves the row's source for traceability while
 *  keeping the prefix that the lookup matcher needs. */
function _insProductToRateType(insProduct) {
  switch (insProduct) {
    case 'Comp': return 'PACK_SHRIRAM';
    case 'TP':   return 'SATP_SHRIRAM';
    case 'SAOD': return 'SAOD_SHRIRAM';
    default:     return 'PACK_SHRIRAM';   // unknown → treat as Comp
  }
}

/** Map POLICY TYPE column → ARRAY of ins_products this row applies to.
 *    "P"          → ['Comp']
 *    "L"          → ['TP']
 *    "P & L"      → ['Comp', 'TP']
 *    "P & SA-OD"  → ['Comp', 'SAOD']
 *    "SA-OD"      → ['SAOD']
 *    "STP"        → ['TP']  (long-tenure liability-only)
 *    "BUNDLE"     → ['Comp']
 *    blank        → ['Comp']  (default; safer than dropping the row)
 */
function _policyTypeToInsList(raw) {
  const s = _str(raw).toUpperCase();
  if (!s) return ['Comp'];
  // Strip SA-OD / SAOD tokens before scanning so the lone-letter "P" /
  // "L" probes below don't accidentally match the "O" / "D" inside.
  const sNoSaod = s.replace(/SA[\s-]*OD/g, ' ');
  const list = new Set();
  // STP = Standalone TP (long-tenure liability-only product) — same TP
  // semantics as a normal "L" row, just a different tenure / product code.
  if (/\bSTP\b/.test(s))                list.add('TP');
  if (/BUNDLE|PACKAGE/.test(s))         list.add('Comp');
  if (/SA[\s-]*OD/.test(s))             list.add('SAOD');
  // Standalone P or "P &" or "P + " → Comp
  if (/(^|[^A-Z])P($|[^A-Z])/.test(sNoSaod) && !/PACKAGE/.test(sNoSaod)) list.add('Comp');
  // L (third party / liability) — must be standalone, not part of a word
  if (/(^|[^A-Z])L($|[^A-Z])/.test(sNoSaod)) list.add('TP');
  if (list.size === 0) list.add('Comp');
  return [...list];
}

/** Parse the UW REMARKS / REMARKS 1 cells for actionable rule constraints.
 *  Returns:
 *    { fuel_excluded, make_only, suppress_saod, leftover }
 *  - fuel_excluded: 'Electric' when the row says "EV Fuel Declined" /
 *    "EV declined" / "Electric Declined" / "EV fule Declined" (typo seen).
 *  - make_only: e.g. "BOLERO" when the row says "Bolero Model only" / "Tata
 *    Ace Make only" / "M&M Bolero only". Multi-make lists like "Make Tata –
 *    Ace, Super Ace, Yodha…" are too varied to parse cleanly — left in
 *    `leftover` for the remarks field.
 *  - suppress_saod: true when the row says "SA-OD not allowed" /
 *    "SAOD not allowed". Forces the SAOD emission to be skipped even when
 *    the Age column has an "& upto X for STP" carve-out.
 *  - leftover: the raw concatenated remarks (kept verbatim in remarks col).
 */
function _parseUwRemarks(uwRaw, rem1Raw, segmentRaw) {
  // Scan UW remarks + REMARKS 1 — and (optionally) the segment text, since
  // some Shriram rows tuck an EV exclusion into the PRODUCTS column itself
  // ("GCCV 3W Except E-CART"). Keep the leftover output to JUST the user-
  // facing remarks (segment is preserved separately).
  const remarksJoined = [_str(uwRaw), _str(rem1Raw)].filter(s => s && s !== '-').join(' | ');
  const scanText = [remarksJoined, _str(segmentRaw)].filter(Boolean).join(' | ');
  const out = {
    fuel_excluded: null,    // single sentinel ("Electric") for the legacy path
    fuel_excluded_set: null,// optional Set of multiple excluded fuels
    fuel_only: null,        // positive fuel mention ("EV" / "Electric" alone)
    make_only: null,        // single make OR comma-joined list
    suppress_saod: false,
    leftover: remarksJoined || null,
  };
  if (!scanText) return out;
  // Generic non-EV fuel exclusion patterns. Looks for "Other than DIESEL" /
  // "Except PETROL" / "Without CNG" / "Non-Diesel" etc. Multiple
  // exclusions on the same row are unioned (e.g. "Except E-CART OTHER
  // THAN DIESEL" → exclude both Electric + Diesel).
  const _addExclusion = (fuel) => {
    if (!fuel) return;
    if (!out.fuel_excluded_set) out.fuel_excluded_set = new Set();
    out.fuel_excluded_set.add(fuel);
  };
  for (const m of scanText.matchAll(/\b(?:other\s+than|except|without|non[-\s]*|excl(?:uding)?)\s+(petrol|diesel|cng|lpg)\b/gi)) {
    const f = m[1].toUpperCase();
    _addExclusion(f === 'PETROL' ? 'Petrol' : f === 'DIESEL' ? 'Diesel' : f === 'CNG' ? 'CNG' : 'LPG');
  }
  // EV / Electric declined patterns. Tolerant of typos ("EV fule Declined").
  // "E-Cart" / "E-Kart" / "E-Rickshaw" are 3W-electric synonyms — when
  // mentioned alongside an exclusion verb (Except / Without / Non / Decline)
  // treat as an Electric exclusion too.
  const evToken = '(?:ev|electric|e[-\\s]?cart|e[-\\s]?kart|e[-\\s]?rickshaw)';
  const evDeclineRe = new RegExp(`\\b${evToken}\\b[^.|]*decline`, 'i');
  const evExceptRe  = new RegExp(`\\b(?:except|without|non[-\\s]*|excl\\.?|excluding|no)\\s+${evToken}\\b`, 'i');
  if (evDeclineRe.test(scanText) || evExceptRe.test(scanText)) {
    out.fuel_excluded = 'Electric';
  } else {
    // Standalone EV / Electric mention WITHOUT exclusion verb → fuel=Electric.
    // Also catches "EV only" / "Electric Auto-Rickshaw" / "Above 2000 watt".
    const evMentionRe = new RegExp(`\\b${evToken}\\b`, 'i');
    if (evMentionRe.test(scanText) || /\bwatt\b/i.test(scanText)) {
      out.fuel_only = 'Electric';
    }
  }
  // Parenthesised fuel-only spec — "(CNG ONLY)" / "(Petrol ONLY)" /
  // "(Diesel ONLY)" / "(EV ONLY)" — common in Shriram broker grid for
  // make+fuel carve-outs. Wins over the implicit EV detection above.
  const fuelParenRe = /\(\s*(petrol|diesel|cng|lpg|ev|electric)\s*only\s*\)/i;
  const fpm = scanText.match(fuelParenRe);
  if (fpm) {
    const f = fpm[1].toUpperCase();
    out.fuel_only = (f === 'EV') ? 'Electric'
                  : (f === 'ELECTRIC') ? 'Electric'
                  : (f === 'PETROL') ? 'Petrol'
                  : (f === 'DIESEL') ? 'Diesel'
                  : (f === 'CNG')    ? 'CNG'
                  : (f === 'LPG')    ? 'LPG' : null;
    // A "(CNG ONLY)" carve-out must NOT be combined with a global EV
    // exclusion (otherwise the row would silently emit zero fuel rows).
    out.fuel_excluded = null;
  }
  // SA-OD / SAOD not allowed
  if (/sa[-\s]?od\s+not\s+allowed/i.test(scanText)) {
    out.suppress_saod = true;
  }
  // Make-only patterns. Several shapes seen in Shriram broker grid:
  //   "Bolero Model only"
  //   "M&M MANF ONLY"
  //   "Bajaj and TVS make only"
  //   "TATA, MARUTI SUZUKI, PIAGGIO & ASHOK LEYLAND make only"
  //   "Only HONDA & HYUNDAI & KIA manufacture only"
  // We extract the make-list segment, split on , / & / and, normalise
  // each token, and store as a comma-joined make string (downstream
  // matching is case-insensitive and substring-based, so the joined form
  // works without per-make fan-out).
  const _MAKE_STOPWORDS = new Set([
    'AND','OR','ONLY','EXCEPT','FOR','FROM','TO','THE','MODEL','MAKE',
    'MANUFACTURE','MANUFACTURER','MANUFACTURES','MANF','MFG',
    'ALL','ANY','TAXI','BUS','VEHICLE','BIKE','SCOOTER','MOPED',
    'WITH','WITHOUT','NCB','SAOD','OD','TP','POLICY','POLICIES',
  ]);
  // Strip any leading stopwords (e.g. "ONLY HONDA" → "HONDA"), reject
  // entries that are purely stopwords or start with a banned domain word
  // ("NCB", "CASES", "WITHOUT").
  const _cleanMake = (raw) => {
    if (!raw) return '';
    const tokens = String(raw).toUpperCase().trim().split(/\s+/).filter(Boolean);
    while (tokens.length > 0 && _MAKE_STOPWORDS.has(tokens[0])) tokens.shift();
    if (tokens.length === 0) return '';
    // First surviving token must look like a make (not a domain noun).
    if (_MAKE_STOPWORDS.has(tokens[0])) return '';
    if (/^(NCB|CASES?|WITHOUT|EXCEPT|EXCLUDING|RENEWAL|ROLLOVER)$/i.test(tokens[0])) return '';
    const out = tokens.join(' ');
    return out.length >= 2 ? out : '';
  };
  // Step 1 — locate the make-list span. Two anchor styles:
  //   <list> (Make|Model|Manufactur*|MANF) only
  //   Only <list> (Make|Model|Manufactur*|MANF)
  let listRaw = null;
  let m;
  if ((m = scanText.match(/((?:[A-Za-z][a-zA-Z&]+(?:\s+[A-Za-z][a-zA-Z&]+)?)(?:\s*(?:,|&|and)\s*(?:[A-Za-z][a-zA-Z&]+(?:\s+[A-Za-z][a-zA-Z&]+)?)){0,8})\s+(?:Make|Model|Manufactur\w*|Manf|Mfg)\s+only\b/i))) {
    listRaw = m[1];
  } else if ((m = scanText.match(/(?:^|[|.\s])only\s+((?:[A-Za-z][a-zA-Z&]+(?:\s+[A-Za-z][a-zA-Z&]+)?)(?:\s*(?:,|&|and)\s*(?:[A-Za-z][a-zA-Z&]+(?:\s+[A-Za-z][a-zA-Z&]+)?)){0,8})\s+(?:Make|Model|Manufactur\w*|Manf|Mfg)\b/i))) {
    listRaw = m[1];
  }
  if (listRaw) {
    const parts = listRaw.split(/\s*(?:,|&|\band\b)\s*/i)
      .map(_cleanMake)
      .filter(Boolean);
    if (parts.length > 0) {
      // De-dupe while preserving order.
      const seen = new Set();
      const dedup = [];
      for (const p of parts) { if (!seen.has(p)) { seen.add(p); dedup.push(p); } }
      out.make_only = dedup.join(',');
    }
  }
  // Step 2 — make-prefix style. When the remarks START with uppercase
  // makes and a parenthesised qualifier follows ("TATA & SML ISUZU
  // (CNG ONLY) (UPTO 15 YEARS)"), capture the prefix as the make list.
  // Only fires when the previous Step 1 didn't already populate make_only.
  if (!out.make_only) {
    const prefixM = scanText.match(/^([A-Z][A-Z\s,&]+?)\s*\(/);
    if (prefixM && /\(\s*(?:petrol|diesel|cng|lpg|ev|electric|upto|up\s*to|\d+\s*to\s*\d+|\d+\s*year)/i.test(scanText)) {
      const parts = prefixM[1].split(/\s*(?:,|&|\band\b)\s*/i)
        .map(_cleanMake)
        .filter(Boolean);
      if (parts.length > 0) {
        const seen = new Set();
        const dedup = [];
        for (const p of parts) { if (!seen.has(p)) { seen.add(p); dedup.push(p); } }
        out.make_only = dedup.join(',');
      }
    }
  }
  return out;
}

/** Body-type cell → ARRAY of canonical TW sub-types. A row that lists
 *  multiple body types (e.g. "BIKE / SCOOTER / SCOOTY") fans out into
 *  one rule per type so a Bike-policy lookup matches a Bike rule and a
 *  Scooter-policy lookup matches a Scooter rule. Moped is treated as
 *  its own category (Scooter and Moped are NOT collapsed here — the
 *  margin-coverage matcher already treats them as interchangeable). */
function _bodyTypeListFromCell(raw) {
  const s = _str(raw).toUpperCase();
  if (!s) return [null];
  const out = new Set();
  if (/BIKE|MOTORCYCLE|MOTOR\s*CYCLE/.test(s)) out.add('Bike');
  if (/SCOOTER|SCOOTY/.test(s))                out.add('Scooter');
  if (/MOPED/.test(s))                         out.add('Moped');
  return out.size === 0 ? [null] : [...out];
}

/** "upto 150cc" / "150-350" / "Upto 350 CC" / "150 to 350 cc"
 *  → { cc_band_min, cc_band_max }. */
function _parseCcCell(raw) {
  const s = _str(raw).toLowerCase();
  if (!s || s === '-') return {};
  const u = s.replace(/cc/g, '').replace(/\s+/g, ' ').trim();
  let m;
  if ((m = u.match(/^upto\s+(\d+)/))) return { cc_band_min: null, cc_band_max: parseInt(m[1], 10) };
  if ((m = u.match(/^above\s+(\d+)/))) return { cc_band_min: parseInt(m[1], 10), cc_band_max: null };
  if ((m = u.match(/^(\d+)\s*[-]\s*(\d+)/))) return { cc_band_min: parseInt(m[1], 10), cc_band_max: parseInt(m[2], 10) };
  if ((m = u.match(/^(\d+)\s+to\s+(\d+)/))) return { cc_band_min: parseInt(m[1], 10), cc_band_max: parseInt(m[2], 10) };
  return {};
}

// Sheet-kind handlers ---------------------------------------------------

function _parseBrokerGrid(sheetData, sheetConfig, meta) {
  const rules = [];
  // Header at row 0 by convention (both BROKER GRID MAR 26 and Short-term
  // policy share the same skeleton). data_start_row defaults to 1.
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row : 1;
  // Column positions — same in both supported sheets.
  const COL = { state: 0, products: 1, dis: 2, payout: 3, policy: 4, age: 5, uw: 6, rem1: 7 };
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r] || [];
    const stateRaw    = _str(row[COL.state]);
    const productsRaw = _str(row[COL.products]);
    const disRaw      = _str(row[COL.dis]);
    const payoutRaw   = _str(row[COL.payout]);
    const policyRaw   = _str(row[COL.policy]);
    const ageRaw      = _str(row[COL.age]);
    const uwRaw       = _str(row[COL.uw]);
    const rem1Raw     = _str(row[COL.rem1]);
    if (!stateRaw && !productsRaw && !payoutRaw) continue;
    if (!productsRaw) continue;

    const prod = _parseProductsCell(productsRaw);
    if (!prod.product) continue;

    const region    = _normaliseRegion(stateRaw);
    const insList   = _policyTypeToInsList(policyRaw);
    const ageInfo   = _parseAgeWithStp(ageRaw);
    // Pass productsRaw so segment-embedded exclusions ("Except E-CART") count.
    const uw        = _parseUwRemarks(uwRaw, rem1Raw, productsRaw);
    const discount  = _parsePctCell(disRaw);
    const payout    = _parseShriramPayout(payoutRaw);
    // Remark-side age override — picks up "(AGE >N-M)" / "AGE >N-M" /
    // "Age > N to M". A leading ">" means strict-greater-than, so min=N+1.
    // Wins over the AGE column value because remarks are more specific.
    const _scanForAge = `${_str(uwRaw)} ${_str(rem1Raw)}`;
    const ageOverM = _scanForAge.match(/(?:\(\s*)?AGE\s*(>?)\s*(\d+)\s*[-–to]+\s*(\d+)/i);
    if (ageOverM) {
      const strict = ageOverM[1] === '>';
      const lo = parseInt(ageOverM[2], 10);
      const hi = parseInt(ageOverM[3], 10);
      ageInfo.mainMin = strict ? lo + 1 : lo;
      ageInfo.mainMax = hi;
    }
    // OLD / Used vehicle marker — if remarks tag the row as "OLD" / "Used",
    // bump age min from 0 to 1 since brand-new vehicles aren't "Old".
    if (/\bOLD\b/i.test(_scanForAge) && ageInfo.mainMin === 0) {
      ageInfo.mainMin = 1;
    }
    // Sub-type include list — patterns like "JCB & Excavator(ALL make)" /
    // "JCB & Excavator and except ..." / "Crane & Excavator only". Fans
    // out into one rule per sub-category (each becomes its own Vehicle
    // Category in the export). Whitelist limits to known commercial sub-
    // categories so we don't false-match arbitrary words.
    const _SUBTYPE_VOCAB = new Set([
      'JCB','EXCAVATOR','CRANE','TRACTOR','AMBULANCE','TANKER','BACKHOE',
      'FORKLIFT','BULKER','TIPPER','DUMPER','CONTAINER','TRAILER','REEFER',
      'HARVESTER','LOADER',
    ]);
    const subTypeListMatch = _scanForAge.match(
      /\b([A-Za-z]+(?:\s+[A-Za-z]+)?(?:\s*(?:,|&|and)\s*[A-Za-z]+(?:\s+[A-Za-z]+)?){1,5})\s*(?:\(\s*ALL\s+make\s*\)|only|make\s+only)/i
    );
    let subTypeVariants = [{ subType: prod.sub_type, segment: prod.segment }];
    if (subTypeListMatch) {
      const parts = subTypeListMatch[1].split(/\s*(?:,|&|\band\b)\s*/i)
        .map(p => p.toUpperCase().trim())
        .filter(p => _SUBTYPE_VOCAB.has(p));
      if (parts.length >= 2) {
        // De-dupe order-preserving.
        const seen = new Set();
        const uniq = [];
        for (const p of parts) { if (!seen.has(p)) { seen.add(p); uniq.push(p); } }
        // Title-case for the segment text the export's inferVehicleCategory
        // matches against ("JCB", "Excavator", "Crane", etc.).
        subTypeVariants = uniq.map(p => ({
          subType: p === 'JCB' ? 'JCB' : (p[0] + p.slice(1).toLowerCase()),
          segment: p === 'JCB' ? 'JCB' : (p[0] + p.slice(1).toLowerCase()),
        }));
      }
    }
    // "for NIL dep cases payout is X%" — second emission with Nil Dep = Yes.
    const nilDepRate = _parseNilDepConditional(uwRaw + ' ' + rem1Raw);

    // Determine the (insProduct, ageMin, ageMax) tuples to emit. The Age
    // column's "& upto X for STP" carve-out gives the TP rule a longer
    // age cap than the Comp rule (STP = Standalone-TP, the long-tenure
    // liability-only product). SAOD is independent — only emitted when
    // POLICY TYPE explicitly mentions SAOD.
    const emissions = [];
    for (const ins of insList) {
      if (ins === 'SAOD' && uw.suppress_saod) continue;
      let ageMax = ageInfo.mainMax;
      const ageMin = ageInfo.mainMin ?? 0;
      if (ins === 'TP' && ageInfo.tpMax != null) ageMax = ageInfo.tpMax;
      emissions.push({ ins, ageMin, ageMax });
    }

    // Fuel emissions — when one or more fuels are excluded, fan out into
    // the SURVIVING fuels (one row per remaining fuel) so per-fuel policy
    // lookups still match. Otherwise emit one row with the most specific
    // fuel hint available:
    //   1) product-derived ("PRIVATE CAR PETROL" → Petrol)
    //   2) UW-remarks fuel ("EV" / "Electric Auto-Rickshaw" / "Watt" → Electric)
    //   3) blank (catchall)
    const exclusions = new Set(uw.fuel_excluded_set || []);
    if (uw.fuel_excluded) exclusions.add(uw.fuel_excluded);
    let fuelList;
    if (exclusions.size > 0) {
      const universe = ['Petrol', 'Diesel', 'CNG', 'LPG', 'Electric'];
      fuelList = universe.filter(f => !exclusions.has(f));
      if (fuelList.length === 0) fuelList = [null]; // safety: never emit zero rows
    } else {
      fuelList = [prod.fuel_type || uw.fuel_only || null];
    }

    const remarks = uw.leftover ||
      (productsRaw && prod.segment !== productsRaw ? productsRaw : null);

    // ZONE fan-out: when remarks list multiple zones ("ZONE 1 & 2 BRANCH",
    // "Zone 1, 2 & 3"), emit one row per zone with that zone's number
    // substituted back into the remark string. This way the export's
    // existing single-zone regex picks the right zone per row, and a
    // policy lookup keyed off Zone X cleanly hits the right rule.
    const _zoneListM = remarks
      ? remarks.match(/\bzones?\s+(\d+(?:\s*(?:,|&|and)\s*\d+)+)/i)
      : null;
    const _zoneNums = _zoneListM ? (_zoneListM[1].match(/\d+/g) || []) : [];
    const zoneVariants = _zoneNums.length >= 2
      ? _zoneNums.map(n => ({
          // Substitute "ZONE 1 & 2" → "Zone N" so the per-row remark
          // singles out the zone for that emission.
          remarks: remarks.replace(/\bzones?\s+\d+(?:\s*(?:,|&|and)\s*\d+)+/i, `Zone ${n}`),
        }))
      : [{ remarks }];

    for (const e of emissions) {
     for (const zv of zoneVariants) {
      for (const stv of subTypeVariants) {
      for (const fuel of fuelList) {
        const baseTemplate = {
          insurer: meta.insurer,
          product: prod.product,
          sheet_name: meta.sheetName,
          region,
          segment: stv.segment || prod.segment || null,
          sub_type: stv.subType || prod.sub_type || null,
          make: uw.make_only || null,
          fuel_type: fuel,
          weight_band_min: prod.weight_band_min ?? null,
          weight_band_max: prod.weight_band_max ?? null,
          seating_capacity_min: prod.seating_capacity_min ?? null,
          seating_capacity_max: prod.seating_capacity_max ?? null,
          vehicle_age_min: e.ageMin ?? null,
          vehicle_age_max: e.ageMax ?? null,
          addon: null,
          carrier_type: null,
          discount_pct: discount,
          remarks: zv.remarks,
        };

        // Split "X OD + Y TP" cell — emit TWO halves with matching
        // (stripped) rate_type prefix so the export's mergeOdTpPairs
        // collapses them into ONE Excel row with OD Rate=X and TP Rate=Y.
        // For TP-product (SATP) emissions, just use the TP half rate.
        if (payout && payout.od_rate != null && payout.tp_rate != null) {
          if (e.ins === 'TP') {
            const r = { ...baseTemplate,
              rate_type: _composeRateType('TP', null),  // SATP_SHRIRAM
              rate_value: payout.tp_rate,
              is_declined: false,
              rate_text: payout.rate_text || null,
              is_conditional: false,
            };
            rules.push(r);
          } else {
            // OD half + TP half — both with same prefix (PACK / SAOD).
            const odRule = { ...baseTemplate,
              rate_type: _composeRateType(e.ins, 'OD'),
              rate_value: payout.od_rate,
              is_declined: false,
              rate_text: payout.rate_text || null,
              is_conditional: false,
            };
            const tpRule = { ...baseTemplate,
              rate_type: _composeRateType(e.ins, 'TP'),
              rate_value: payout.tp_rate,
              is_declined: false,
              rate_text: payout.rate_text || null,
              is_conditional: false,
            };
            rules.push(odRule);
            rules.push(tpRule);
          }
          continue;  // skip the single-rate path below
        }

        // SC-conditional path — emit one row per seating-capacity variant.
        if (payout && Array.isArray(payout.sc_variants) && payout.sc_variants.length > 0) {
          for (const v of payout.sc_variants) {
            const r = { ...baseTemplate,
              rate_type: _composeRateType(e.ins, payout.applied_on),
              rate_value: v.rate_value,
              is_declined: false,
              rate_text: payout.rate_text || null,
              is_conditional: false,
              // Seating bands from the SC condition WIN over any product-
              // derived seating; the SC-conditional cell is more specific.
              seating_capacity_min: v.seating_min,
              seating_capacity_max: v.seating_max,
            };
            rules.push(r);
          }
          continue;
        }

        // Single-rate path (the common case): one row per emission.
        const baseRule = { ...baseTemplate,
          rate_type: _composeRateType(e.ins, payout && payout.applied_on),
        };
        if (payout) {
          baseRule.rate_value     = payout.rate_value;
          baseRule.is_declined    = !!payout.is_declined;
          baseRule.rate_text      = payout.rate_text || null;
          baseRule.is_conditional = !!payout.is_conditional;
          // Stash metro-split rates for the post-processor.
          if (payout._metro_split) baseRule._metro_split = payout._metro_split;
        } else {
          baseRule.rate_value = null;
          baseRule.is_declined = false;
          baseRule.rate_text = _str(payoutRaw);
          baseRule.is_conditional = true;
        }
        rules.push(baseRule);

        // Nil-Dep companion: when remarks carry "for NIL dep cases payout
        // is X%", emit a 2nd row with the override rate and rate_type
        // suffixed `_NilDep` so the export's inferNilDepFlag sets the
        // column to "Yes". Skip when no companion is detected or when the
        // base row was declined/conditional with no usable rate.
        if (nilDepRate != null && payout && Number.isFinite(payout.rate_value)) {
          const nd = { ...baseRule };
          nd.rate_value = nilDepRate;
          nd.rate_text = null;
          nd.is_conditional = false;
          nd.rate_type = (baseRule.rate_type || '') + '_NilDep';
          rules.push(nd);
        }
      }
      }  // end subTypeVariants loop
     }  // end zoneVariants loop
    }
  }
  return rules;
}

function _parseTwoWheeler(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row : 1;
  // Column layout differs between the two 2W sheets. 'New Business - 2W' has:
  //   STATE | MANUFACTURER | BODY TYPE | POLICY TYPE | DIS % | Avg Net PO | UW
  // 'ROLLOVE (PKG+TP) - 2W' has:
  //   PRODUCT NAME | STATE | BODY TYPE | CC | Age | DIS % | Avg Net PO | POLICY TYPE | RTO
  // Caller picks via sheetConfig.layout_variant ('new_biz' | 'rollover').
  const variant = sheetConfig.layout_variant || 'new_biz';
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r] || [];
    let state, manufacturer, body, policy, payoutRaw, age, ccCell, productNameRaw, uwRaw, disRaw;
    if (variant === 'rollover') {
      productNameRaw = _str(row[0]);
      state          = _str(row[1]);
      body           = _str(row[2]);
      ccCell         = _str(row[3]);
      age            = _str(row[4]);
      disRaw         = _str(row[5]);   // DISCOUNT %
      payoutRaw      = _str(row[6]);   // Average Net PO
      policy         = _str(row[7]);
      uwRaw          = _str(row[8]);   // RTO guidelines
    } else {
      // 'New Business - 2W' headers say col2=BODY TYPE / col3=POLICY TYPE,
      // but the actual data is the OPPOSITE: col2 holds "BUNDLE" (policy
      // type) and col3 holds "BIKE" / "SCOOTY/MOPED" (body type). Swap.
      state          = _str(row[0]);
      manufacturer   = _str(row[1]);
      policy         = _str(row[2]);   // POLICY TYPE  (BUNDLE)
      body           = _str(row[3]);   // BODY TYPE    (BIKE / SCOOTY/MOPED)
      disRaw         = _str(row[4]);   // DIS %
      payoutRaw      = _str(row[5]);   // Average Net PO (Converted)
      uwRaw          = _str(row[6]);   // UW'S CONDITION
    }
    if (!state && !payoutRaw) continue;

    const bodyList = _bodyTypeListFromCell(body);
    if (bodyList.length === 1 && bodyList[0] === null && !manufacturer && !payoutRaw) continue;

    const region = _normaliseRegion(state);
    const insList = _policyTypeToInsList(policy);
    const cc = ccCell ? _parseCcCell(ccCell) : {};
    const ageBand = age ? _parseAgeBand(age) : {};
    const uw = _parseUwRemarks(uwRaw, '', body);
    const discount = _parsePctCell(disRaw);
    // For rollover sheets, the "RTO GUIDELINES" cell (uwRaw) carries either
    // an RTO code list ("DL & NCR (UP-14,16,37)") or a cluster marker
    // ("AP ONLY", "BR", "JH"). Surface it in the export's RTOCode column
    // by tagging the remark with a [RTO:...] prefix that the export reads
    // (see ruleToRow's _extractRtoGuide).
    const rtoGuide = (variant === 'rollover' && uwRaw && uwRaw !== '-') ? _str(uwRaw) : null;
    const remarksParts = [productNameRaw, uw.leftover || uwRaw, body || ''].filter(Boolean);
    let remarks = remarksParts.join(' | ') || null;
    if (rtoGuide && remarks) {
      remarks = `[RTO: ${rtoGuide}] | ${remarks}`;
    } else if (rtoGuide) {
      remarks = `[RTO: ${rtoGuide}]`;
    }

    // MANUFACTURER cell can hold "HERO/HONDA/SUZUKI" — split into one rule
    // per make so downstream lookups keyed by make match.
    const makeList = manufacturer
      ? manufacturer.split(/[,/&+]/).map(s => _str(s).toUpperCase()).filter(Boolean)
      : [null];
    const payout = _parseShriramPayout(payoutRaw);

    // Honor UW: drop SAOD if "SA-OD not allowed", emit per-fuel when fuel exclusions exist.
    const insListEffective = uw.suppress_saod ? insList.filter(p => p !== 'SAOD') : insList;
    const exclusions2 = new Set(uw.fuel_excluded_set || []);
    if (uw.fuel_excluded) exclusions2.add(uw.fuel_excluded);
    let fuelList;
    if (exclusions2.size > 0) {
      const universe = ['Petrol', 'Diesel', 'CNG', 'LPG', 'Electric'];
      fuelList = universe.filter(f => !exclusions2.has(f));
      if (fuelList.length === 0) fuelList = [null];
    } else {
      fuelList = [uw.fuel_only || (variant === 'rollover' ? 'Petrol' : null)];
    }
    const finalMakeList = uw.make_only ? [uw.make_only] : makeList;
    // BUNDLE rows fan out into OD{1,3,5}×TP{3,5} = 6 tenure combos. The
    // single source rate applies to every combo; the tenure tag survives
    // through rate_type so the export's inferTenure renders the right
    // OD/TP year pair per row. Non-bundle rows emit a single untagged
    // rule (tenureTag === null).
    const tenureCombos = _bundleTenureCombos(policy);

    for (const ins of insListEffective) {
      for (const make of finalMakeList) {
        for (const subType of bodyList) {
          for (const fuel of fuelList) {
            for (const tenureTag of tenureCombos) {
              const baseRule = {
                insurer: meta.insurer,
                product: 'TW',
                sheet_name: meta.sheetName,
                region,
                segment: subType || null,
                sub_type: subType || null,
                make: make || null,
                fuel_type: fuel,
                cc_band_min: cc.cc_band_min ?? null,
                cc_band_max: cc.cc_band_max ?? null,
                vehicle_age_min: ageBand.min ?? null,
                vehicle_age_max: ageBand.max ?? null,
                addon: null,
                carrier_type: null,
                rate_type: _composeRateType(ins, payout && payout.applied_on, tenureTag),
                discount_pct: discount,
                remarks,
              };
              if (payout) {
                baseRule.rate_value     = payout.rate_value;
                baseRule.is_declined    = !!payout.is_declined;
                baseRule.rate_text      = payout.rate_text || null;
                baseRule.is_conditional = !!payout.is_conditional;
              } else {
                baseRule.rate_value = null;
                baseRule.is_declined = false;
                baseRule.rate_text = _str(payoutRaw);
                baseRule.is_conditional = !!_str(payoutRaw);
              }
              rules.push(baseRule);
            }
          }
        }
      }
    }
  }
  return rules;
}

// Public --------------------------------------------------------------

function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind || 'broker_grid';
  if (kind === 'two_wheeler') return _parseTwoWheeler(sheetData, sheetConfig, meta);
  return _parseBrokerGrid(sheetData, sheetConfig, meta);
}

module.exports = { parse };
