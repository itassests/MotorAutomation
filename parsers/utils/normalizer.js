/**
 * Utility functions for normalizing rate cell values and parsing
 * segment/band descriptors from insurance rate sheets.
 */

/**
 * Normalize a raw cell value into a structured rate result.
 * @param {*} value - Raw cell value from Excel
 * @param {string[]} declineMarkers - Values that indicate a declined rate (e.g. ["D", "NA"])
 * @returns {{ rate_value: number|null, is_declined: boolean, rate_text: string|null, is_conditional: boolean } | null}
 *   Returns null when the cell should be skipped entirely.
 */
function normalizeRate(value, declineMarkers = []) {
  // Skip empty / null / undefined / blank string
  if (value === null || value === undefined || value === '') return null;

  const strVal = String(value).trim();
  if (strVal === '') return null;

  // Check decline markers (case-insensitive)
  const lowerVal = strVal.toLowerCase();
  const isDeclined = declineMarkers.some(
    (m) => lowerVal === String(m).toLowerCase().trim()
  );
  if (isDeclined) {
    return { rate_value: null, is_declined: true, rate_text: null, is_conditional: false };
  }

  // Pure number (already parsed by xlsx or parseable)
  if (typeof value === 'number' && isFinite(value)) {
    return { rate_value: value, is_declined: false, rate_text: null, is_conditional: false };
  }

  // String that is just a number (e.g. "55" or "55.5" or "55%")
  const numericClean = strVal.replace(/%\s*$/, '').trim();
  const asNum = Number(numericClean);
  if (!isNaN(asNum) && numericClean !== '') {
    // If original string had %, convert to decimal fraction
    const rateVal = strVal.includes('%') ? asNum / 100 : asNum;
    return { rate_value: rateVal, is_declined: false, rate_text: null, is_conditional: false };
  }

  // Pattern: "X% on OD & Y% on TP" / "X% on OD, Y% on TP" — extract OD rate
  // as primary value. Royal 2w Comp uses the comma variant.
  const odTpMatch = strVal.match(/(\d+(?:\.\d+)?)\s*%\s*on\s*OD\s*[,&]\s*(\d+(?:\.\d+)?)\s*%\s*on\s*TP/i);
  if (odTpMatch) {
    const odRate = parseFloat(odTpMatch[1]) / 100;
    return { rate_value: odRate, is_declined: false, rate_text: strVal, is_conditional: false };
  }

  // Single-basis pattern: "26% on Net" / "26%on Net" / "26 % on OD" /
  // "X % on TP" / "X% on Gross". Royal 2w Comp Bike uses "26%on Net"
  // (no comma, no TP partner) for some rows. Extract the rate cleanly
  // and tag the premium basis on `applied_on` so the export column
  // (Applied on) reflects it. Order: must run AFTER the OD-AND-TP
  // pair pattern above so `X% on OD, Y% on TP` still splits correctly.
  const singleBasisMatch = strVal.match(/^\s*([\d.]+)\s*%\s*on\s*(net|od|tp|gross)\b/i);
  if (singleBasisMatch) {
    const rate = parseFloat(singleBasisMatch[1]) / 100;
    const basisRaw = singleBasisMatch[2].toUpperCase();
    const basis = basisRaw === 'NET' ? 'Net'
                : basisRaw === 'GROSS' ? 'Gross'
                : basisRaw;   // OD / TP
    return { rate_value: rate, is_declined: false, rate_text: strVal, is_conditional: false, applied_on: basis };
  }

  // Pattern: "X% (discount upto Y%)" / "X% (with discount upto Y%)" /
  //          "X% ( discount upto Y% only" — Royal CH&RJ / ROI / GJ.
  // The leading X% is the rate; the parenthesised note is a discount cap.
  // We extract the rate cleanly and leave the original text in rate_text
  // so downstream (Excel export) can pull the discount band out of it.
  // The "dscount" typo in ROI is tolerated by the optional letter check.
  const rateWithDiscMatch = strVal.match(
    /^\s*(\d+(?:\.\d+)?)\s*%\s*\(?\s*(?:with\s*)?d[is]?[is]?count\s*upto\s*\d+(?:\.\d+)?\s*%/i
  );
  if (rateWithDiscMatch) {
    const rate = parseFloat(rateWithDiscMatch[1]) / 100;
    return { rate_value: rate, is_declined: false, rate_text: strVal, is_conditional: false };
  }

  // Pattern: "IRDA with discount upto Y% only" — IRDA-baseline rate, with
  // a discount cap. We mark rate_value null (the IRDA note is read at the
  // sheet level by parseIrdaNote → fans out to OD+TP rules) and keep the
  // text so the discount cap is recoverable from rate_text.
  const irdaWithDiscMatch = strVal.match(
    /^\s*IRDA\s*(?:with\s*)?d[is]?[is]?count\s*upto\s*(\d+(?:\.\d+)?)\s*%/i
  );
  if (irdaWithDiscMatch) {
    return { rate_value: null, is_declined: false, rate_text: strVal, is_conditional: false, _irda: true };
  }

  // Conditional text: patterns like "70%/80%", "Age 0-2: 55%\nAge 3+: 65%"
  const hasSlashRates = /\d+(\.\d+)?%\s*\/\s*\d+(\.\d+)?%/.test(strVal);
  const hasAgeRate = /(age|yrs)/i.test(strVal) && /%/.test(strVal);
  const hasCommaSeparated = /\d+(\.\d+)?%\s*,/.test(strVal) && /%/.test(strVal);
  const hasMultipleRates = (strVal.match(/%/g) || []).length >= 2;

  if (hasSlashRates || hasAgeRate || hasCommaSeparated || hasMultipleRates) {
    return { rate_value: null, is_declined: false, rate_text: strVal, is_conditional: true };
  }

  // Fallback: treat any remaining non-empty string as rate_text (non-conditional)
  return { rate_value: null, is_declined: false, rate_text: strVal, is_conditional: false };
}

/**
 * Clean a string value: trim whitespace, collapse multiple spaces.
 * @param {*} str
 * @returns {string}
 */
function cleanString(str) {
  if (str === null || str === undefined) return '';
  return String(str).trim().replace(/\s+/g, ' ');
}

/**
 * Parse a weight band from a segment descriptor.
 * Examples:
 *   "GCV4 upto 2.5T"       → { min: 0, max: 2.5 }
 *   "3.5T_TO_7.5T"         → { min: 3.5, max: 7.5 }
 *   "above 12T"             → { min: 12, max: null }
 *   ">40T"                  → { min: 40, max: null }
 *   "<=2.5T"                → { min: 0, max: 2.5 }
 * @param {string} segment
 * @returns {{ min: number|null, max: number|null }}
 */
function parseWeightBand(segment) {
  if (!segment) return { min: null, max: null };
  const s = cleanString(segment).toUpperCase();

  // Range pattern: "3.5T_TO_7.5T" or "3.5T TO 7.5T" or "3.5T-7.5T"
  let m = s.match(/([\d.]+)\s*T?\s*(?:_TO_|TO|-)\s*([\d.]+)\s*T/i);
  if (m) {
    return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  }

  // "upto X T" or "<= X T" or "< X T"
  m = s.match(/(?:UPTO|UP\s*TO|<=?)\s*([\d.]+)\s*T/i);
  if (m) {
    return { min: 0, max: parseFloat(m[1]) };
  }

  // "X T and above" or "XT+" (e.g. "40T+", "44T+", "2.5 T and Above")
  m = s.match(/([\d.]+)\s*T\s*(?:\+|AND\s+ABOVE)/i);
  if (m) {
    return { min: parseFloat(m[1]), max: null };
  }

  // "above X T" or "> X T" or ">= X T"
  m = s.match(/(?:ABOVE|>=?)\s*([\d.]+)\s*T/i);
  if (m) {
    return { min: parseFloat(m[1]), max: null };
  }

  // Single weight like "2.5T" (but NOT "2.5T+")
  m = s.match(/([\d.]+)\s*T(?!\s*\+)\b/i);
  if (m) {
    return { min: 0, max: parseFloat(m[1]) };
  }

  // GVW notation in kg (Royal 4W GCV EV puts GVW values like
  // "UPTO_3500" / "3500_TO_7500" / ">3500" — no T suffix, kg-based).
  // We auto-convert by detecting integers ≥ 1000 in this position and
  // dividing by 1000 to land on tonnes.
  m = s.match(/^(?:UPTO|UP\s*TO|<=?)[_\s]*(\d{4,})\b/i);
  if (m) {
    return { min: 0, max: parseFloat(m[1]) / 1000 };
  }
  m = s.match(/^(\d{4,})[_\s-]*(?:TO|-)[_\s]*(\d{4,})\b/i);
  if (m) {
    return { min: parseFloat(m[1]) / 1000, max: parseFloat(m[2]) / 1000 };
  }
  m = s.match(/^(?:ABOVE|>=?|GT)[_\s]*(\d{4,})\b/i);
  if (m) {
    return { min: parseFloat(m[1]) / 1000, max: null };
  }

  // GCV context: range without T suffix — "GCV4 1.6 to 2.5" (followed by age or end)
  if (/^GCV/i.test(s)) {
    m = s.match(/GCV\d?\s+([\d.]+)\s*(?:TO|-)\s*([\d.]+)(?:\s|$)/i);
    if (m) {
      return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
    }

    // TATA pivot style — explicit comparison ops with no T suffix:
    //   "GCV > 2.5 <= 3.5"  → { min: 2.5, max: 3.5 }
    //   "GCV <= 2.5"        → { min: 0,   max: 2.5 }
    //   "GCV > 45"          → { min: 45,  max: null }
    m = s.match(/^GCV\s*>\s*([\d.]+)\s*<=\s*([\d.]+)/i);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
    m = s.match(/^GCV\s*<=\s*([\d.]+)/i);
    if (m) return { min: 0, max: parseFloat(m[1]) };
    m = s.match(/^GCV\s*>\s*([\d.]+)\s*$/i);
    if (m) return { min: parseFloat(m[1]), max: null };
  }

  return { min: null, max: null };
}

/**
 * Parse a CC (engine displacement) band from a segment descriptor.
 * Only matches genuine CC/engine displacement values, NOT seating, tonnage, KW, or age.
 *
 * Examples:
 *   "150cc"                                      → { min: 0, max: 150 }
 *   "1000 TO 1500 CC"                            → { min: 1000, max: 1500 }
 *   ">1500 CC"                                   → { min: 1500, max: null }
 *   "<=1000cc"                                   → { min: 0, max: 1000 }
 *   "Petrol<1000"                                → { min: 0, max: 1000 }
 *   "CNG>1000"                                   → { min: 1000, max: null }
 *   "Taxi upto 5 seater diesel > 1000 cc & <= 1500 cc" → { min: 1000, max: 1500 }
 *   "Taxi upto 5 seater diesel < 1000 cc"        → { min: 0, max: 1000 }
 *   "Taxi 6-9 seater"                            → { min: null, max: null } (NOT CC)
 *   "GCV4 upto 2.5T"                             → { min: null, max: null } (NOT CC)
 *   "0-5 years"                                  → { min: null, max: null } (NOT CC)
 * @param {string} segment
 * @returns {{ min: number|null, max: number|null }}
 */
function parseCCBand(segment) {
  if (!segment) return { min: null, max: null };
  const s = cleanString(segment);

  // Check for CC keyword — require digit-adjacency or word boundary so we don't
  // false-match on embedded "CC" inside tokens like PCCV / GCCV / ACCURATE etc.
  const hasCCKeyword = /\d\s*cc\b|\bcc\b|cc\s*\d/i.test(s);
  // Fuel-prefix patterns like "Petrol<1000", "CNG>1000", "Diesel>1500"
  const hasFuelCC = /^(?:Petrol|Diesel|CNG|EV)\s*[<>=\d]/i.test(s);
  // MC/TW segment CC patterns: "MC <155", "MC_180-350"
  const hasMCCC = /^(?:MC|HIGH_SPEED)/i.test(s) && /\d{2,}/.test(s);
  // KW (kilowatt) patterns for electric vehicles: "3-7 KW", "< 3 KW", "> 7 KW"
  const hasKW = /KW/i.test(s) && /\d/.test(s);
  // Watt patterns for electric 3W (Shriram broker grid uses these in
  // remarks/segment text): "Upto 2000 Watt", "Above 2000 Watt", "(Above
  // 2000 Watt)", "1000-3000 Watt". Treat the watt number as the CC
  // equivalent so the MinimumCC/MaximumCC columns display it.
  const hasWatt = /\bwatt\b/i.test(s) && /\d/.test(s);

  // If there's no CC indicator, skip entirely
  if (!hasCCKeyword && !hasFuelCC && !hasMCCC && !hasKW && !hasWatt) {
    return { min: null, max: null };
  }

  // Watt patterns (3W electric motor wattage — used as CC equivalent)
  if (hasWatt) {
    // "Upto 2000 Watt" / "Up to 2000 Watt"
    let wm = s.match(/upto?\s+(\d+)\s*watt/i)
          || s.match(/up\s+to\s+(\d+)\s*watt/i);
    if (wm) return { min: 1, max: parseInt(wm[1], 10) };
    // "Above 2000 Watt" / "(Above 2000 Watt)" / "> 2000 Watt"
    wm = s.match(/(?:above|>)\s*(\d+)\s*watt/i);
    if (wm) return { min: parseInt(wm[1], 10) + 1, max: null };
    // "Below 2000 Watt" / "<= 2000 Watt"
    wm = s.match(/(?:below|<=?)\s*(\d+)\s*watt/i);
    if (wm) {
      const val = parseInt(wm[1], 10);
      return { min: 1, max: /^</.test(wm[0]) && !/<=/.test(wm[0]) ? val - 1 : val };
    }
    // Range "1000-3000 Watt" / "1000 to 3000 Watt"
    wm = s.match(/(\d+)\s*(?:to|[-–])\s*(\d+)\s*watt/i);
    if (wm) return { min: parseInt(wm[1], 10), max: parseInt(wm[2], 10) };
    // Single value "2000 Watt"
    wm = s.match(/(\d+)\s*watt/i);
    if (wm) return { min: 1, max: parseInt(wm[1], 10) };
  }

  // KW patterns (electric vehicles — treat KW values as CC equivalents)
  if (hasKW) {
    // Range with two KW tokens: "7 KW - 16 KW", "7 KW to 16 KW"
    let km = s.match(/(\d+)\s*KW\s*(?:[-_]|TO|–)\s*(\d+)\s*KW/i);
    if (km) return { min: parseInt(km[1], 10), max: parseInt(km[2], 10) };
    // Range with single KW token: "3-7 KW", "3 - 7 KW", "3 TO 7 KW"
    km = s.match(/(\d+)\s*(?:[-_]|TO)\s*(\d+)\s*KW/i);
    if (km) return { min: parseInt(km[1], 10), max: parseInt(km[2], 10) };
    // "<= X KW" or "< X KW"
    km = s.match(/(<=?)\s*(\d+)\s*KW/i);
    if (km) {
      const val = parseInt(km[2], 10);
      return { min: 1, max: km[1] === '<' ? val - 1 : val };
    }
    // ">= X KW" or "> X KW"
    km = s.match(/(>=?)\s*(\d+)\s*KW/i);
    if (km) {
      const val = parseInt(km[2], 10);
      return { min: km[1] === '>' ? val + 1 : val, max: null };
    }
    // Single value: "7 KW"
    km = s.match(/(\d+)\s*KW/i);
    if (km) return { min: 1, max: parseInt(km[1], 10) };
  }

  // For segments with "seater" + "cc", isolate the CC part (after seating info)
  // e.g. "Taxi upto 5 seater diesel < 1000 cc" → work with "< 1000 cc"
  let ccText = s;
  if (/seat/i.test(s) && hasCCKeyword) {
    const ccMatch = s.match(/(?:.*seat(?:er)?[^<>=]*?)([<>=&].+)/i);
    if (ccMatch) {
      ccText = ccMatch[1].trim();
    }
  }

  // Chola underscore-shorthand: "4W_LT_1500CC" / "4W_GT_1500CC" (LT=less than, GT=greater than)
  let lt = s.match(/(?:^|_)LT[_\s]*(\d+)\s*CC/i);
  if (lt) return { min: 1, max: parseInt(lt[1], 10) - 1 };
  let gt = s.match(/(?:^|_)GT[_\s]*(\d+)\s*CC/i);
  if (gt) return { min: parseInt(gt[1], 10) + 1, max: null };

  // Compound range: "> 1000 cc & <= 1500 cc"
  let m = ccText.match(/>\s*(\d+)\s*(?:cc)?\s*&\s*<=?\s*(\d+)\s*(?:cc)?/i);
  if (m) {
    return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }

  // Range with CC: "1000 TO 1500 CC", "1000-1500 CC", "150_350cc"
  m = ccText.match(/(\d+)\s*(?:cc)?\s*(?:TO|[-_])\s*(\d+)\s*cc/i);
  if (m) {
    return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }

  // Range without CC suffix but with fuel prefix: "Petrol1000-1500", "CNG1000-1500"
  if (hasFuelCC) {
    m = s.match(/^(?:Petrol|Diesel|CNG)\s*(\d{3,})\s*[-_]\s*(\d{3,})/i);
    if (m) {
      return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    }
  }

  // MC segment ranges: "MC_180-350_Others", "HIGH_SPEED_150_350cc"
  if (hasMCCC) {
    m = s.match(/(\d{2,})\s*[-_]\s*(\d{2,})/);
    if (m) {
      return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    }
  }

  // "> X cc" or ">= X cc"  (strict > → min = X+1, >= → min = X)
  m = ccText.match(/(>=?)\s*(\d+)\s*(?:cc)?$/i);
  if (!m) m = ccText.match(/(>=?)\s*(\d+)\s*(?:cc)/i);
  if (m && (hasCCKeyword || hasFuelCC)) {
    const val = parseInt(m[2], 10);
    return { min: m[1] === '>' ? val + 1 : val, max: null };
  }

  // "ABOVE X CC" — treated as strict >
  m = ccText.match(/ABOVE\s+(\d+)\s*(?:cc)?/i);
  if (m && (hasCCKeyword || hasFuelCC)) {
    return { min: parseInt(m[1], 10) + 1, max: null };
  }

  // "< X cc" or "<= X cc"  (strict < → max = X-1, <= → max = X)
  m = ccText.match(/(<=?)\s*(\d+)\s*(?:cc)/i);
  if (!m && hasCCKeyword) m = ccText.match(/(<=?)\s*(\d+)/i);
  if (m && (hasCCKeyword || hasFuelCC)) {
    const val = parseInt(m[2], 10);
    return { min: 1, max: m[1] === '<' ? val - 1 : val };
  }

  // "UPTO X CC" — treated as <=
  m = ccText.match(/up\s*to\s+(\d+)\s*(?:cc)/i);
  if (m && hasCCKeyword) {
    return { min: 1, max: parseInt(m[1], 10) };
  }

  // Fuel prefix with operator: "Petrol<1000", "CNG>1000", "Diesel>=1500"
  if (hasFuelCC) {
    m = s.match(/^(?:Petrol|Diesel|CNG|EV)\s*([<>]=?)\s*(\d+)/i);
    if (m) {
      const op = m[1];
      const val = parseInt(m[2], 10);
      if (op === '>') return { min: val + 1, max: null };
      if (op === '>=') return { min: val, max: null };
      if (op === '<') return { min: 1, max: val - 1 };
      if (op === '<=') return { min: 1, max: val };
    }
  }

  // Single CC value: "150cc" or "150 CC"
  m = s.match(/(\d+)\s*cc/i);
  if (m) {
    return { min: 1, max: parseInt(m[1], 10) };
  }

  // MC/HIGH_SPEED single values: "MC <155", "MC>155"
  if (hasMCCC) {
    m = s.match(/([<>]=?)\s*(\d{2,})/);
    if (m) {
      const val = parseInt(m[2], 10);
      if (m[1] === '<') return { min: 1, max: val - 1 };
      if (m[1] === '<=') return { min: 1, max: val };
      if (m[1] === '>') return { min: val + 1, max: null };
      if (m[1] === '>=') return { min: val, max: null };
    }
    m = s.match(/_(\d{2,})(?:cc)?$/i);
    if (m) {
      return { min: 1, max: parseInt(m[1], 10) };
    }
  }

  return { min: null, max: null };
}

/**
 * Parse an age band from text.
 * Examples:
 *   "All"     → { min: 0, max: 99 }
 *   ">10"     → { min: 10, max: 99 }
 *   "<10"     → { min: 0, max: 10 }
 *   "5-10"    → { min: 5, max: 10 }
 *   "0-5yrs"  → { min: 0, max: 5 }
 *   ">=3"     → { min: 3, max: 99 }
 *   "<=5"     → { min: 0, max: 5 }
 *   "3+"      → { min: 3, max: 99 }
 * @param {string} text
 * @returns {{ min: number|null, max: number|null }}
 */
function parseAgeBand(text) {
  if (!text) return { min: null, max: null };
  const s = cleanString(text).toUpperCase();

  if (/^ALL$/i.test(s.trim())) {
    return { min: 0, max: 99 };
  }

  // Range: "5-10", "0-5 yrs", "5 to 10"
  let m = s.match(/([\d]+)\s*(?:-|TO)\s*([\d]+)/i);
  if (m) {
    return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }

  // "3+" or "3+ yrs"
  m = s.match(/([\d]+)\s*\+/);
  if (m) {
    return { min: parseInt(m[1], 10), max: 99 };
  }

  // ">= 10" or "> 10"
  m = s.match(/>=?\s*([\d]+)/);
  if (m) {
    return { min: parseInt(m[1], 10), max: 99 };
  }

  // "<= 5" or "< 5"
  m = s.match(/<=?\s*([\d]+)/);
  if (m) {
    return { min: 0, max: parseInt(m[1], 10) };
  }

  // Single number
  m = s.match(/^([\d]+)$/);
  if (m) {
    return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
  }

  return { min: null, max: null };
}

/**
 * Parse seating capacity from a segment descriptor.
 * Examples:
 *   "Taxi upto 5 seater"      → { min: 1, max: 5 }
 *   "Taxi 6-9 seater"         → { min: 6, max: 9 }
 *   "upto 7 seater"           → { min: 1, max: 7 }
 *   "upto 9 seater"           → { min: 1, max: 9 }
 *   "6-9 seater"              → { min: 6, max: 9 }
 *   "4_MAXI_CAB"              → { min: null, max: null } (no seater keyword)
 * @param {string} segment
 * @returns {{ min: number|null, max: number|null }}
 */
function parseSeatingCapacity(segment) {
  if (!segment) return { min: null, max: null };
  const s = cleanString(segment);

  // PCV Bus / Cab segments where seating range follows the body type rather
  // than a "seater" keyword. Examples from TATA:
  //   "PCV Bus School 16 to 30"      → { min: 16, max: 30 }
  //   "PCV Bus Non School 12 to 14"  → { min: 12, max: 14 }
  //   "PCV Bus School > 14"          → { min: 15, max: null }
  //   "PCV Bus School <= 14"         → { min: 1,  max: 14 }
  if (/\bBus\b/i.test(s)) {
    let bm = s.match(/(\d{1,3})\s*(?:to|-|–)\s*(\d{1,3})/i);
    if (bm) return { min: parseInt(bm[1], 10), max: parseInt(bm[2], 10) };
    bm = s.match(/>\s*(\d{1,3})/);
    if (bm) return { min: parseInt(bm[1], 10) + 1, max: null };
    bm = s.match(/<=\s*(\d{1,3})/);
    if (bm) return { min: 1, max: parseInt(bm[1], 10) };
  }

  // Chola shorthand: "PCCV>6" / "PCCV<6" / "PCCV>=6" (seating carrier operator)
  let pccv = s.match(/\bPCCV\s*([<>]=?)\s*(\d+)/i);
  if (pccv) {
    const op = pccv[1]; const v = parseInt(pccv[2], 10);
    if (op === '>') return { min: v + 1, max: null };
    if (op === '>=') return { min: v, max: null };
    if (op === '<') return { min: 1, max: v - 1 };
    if (op === '<=') return { min: 1, max: v };
  }

  // Range: "6-9 seater" or "6 to 9 seater"
  let m = s.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*seat/i);
  if (m) {
    return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }

  // "upto X seater" or "up to X seater" or "<= X seater"
  m = s.match(/(?:upto|up\s*to|<=?)\s*(\d+)\s*seat/i);
  if (m) {
    return { min: 1, max: parseInt(m[1], 10) };
  }

  // "above X seater" or "> X seater" or ">= X seater"
  m = s.match(/(?:above|>=?)\s*(\d+)\s*seat/i);
  if (m) {
    return { min: parseInt(m[1], 10), max: null };
  }

  // "X & above" or "X+ seater" or "X and above" (number first)
  m = s.match(/(\d+)\s*(?:&|\+|and)\s*above/i);
  if (m) {
    return { min: parseInt(m[1], 10), max: null };
  }

  // Single: "5 seater"
  m = s.match(/(\d+)\s*seat/i);
  if (m) {
    return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
  }

  // (N+M) "seats + driver" notation common in Indian motor insurance:
  //   "SC upto (3+1)"     → max = 4   (3 passengers + 1 driver)
  //   "(6+1) only"        → min=max=7 (6+1 = 7 total)
  //   "SC <= (12+1)"      → max = 13
  //   "Above (6+1)"       → min = 8
  // The (N+M) span has to follow either an SC/Seating mention OR a
  // bound-keyword (upto/above/etc.) — bare "(3+1)" would otherwise pick
  // up false matches.
  const np1 = s.match(/(?:SC|seat\w*|capacity|upto|up\s*to|above|<=?|>=?)[^()]{0,12}\(\s*(\d+)\s*\+\s*(\d+)\s*\)/i);
  if (np1) {
    const total = parseInt(np1[1], 10) + parseInt(np1[2], 10);
    // Determine if it was a bound or exact match by looking at the leading word.
    const lead = s.match(/(upto|up\s*to|<=?|above|>=?)/i);
    if (lead) {
      const op = lead[1].toLowerCase();
      if (/upto|up\s*to|<=?/.test(op)) return { min: 1,         max: total };
      if (/above|>=?/.test(op))         return { min: total + 1, max: null  };
    }
    return { min: total, max: total };
  }

  return { min: null, max: null };
}

/**
 * Extract fuel type from a segment descriptor.
 * Examples:
 *   "Taxi upto 5 seater diesel"     → "Diesel"
 *   "Taxi upto 5 seater non-diesel" → "Petrol / CNG / EV"
 *   "Taxi upto 5 seater Electric"   → "Electric"
 *   "Taxi upto 7 seater CNG"        → "CNG"
 *   "PCV3W diesel"                  → "Diesel"
 *   "PCV3W non-diesel"              → "Petrol / CNG / EV"
 *   "Petrol<1000"                   → "Petrol"
 *   "Diesel>1500"                   → "Diesel"
 *   "CNG>1000"                      → "CNG"
 *   "1000 TO 1500 CC[D]"            → "Diesel"
 *   "1000 TO 1500 CC[P]"            → "Petrol"
 *   "SC/EV"                         → "Electric"
 *   "E-Rickshaw"                    → "Electric"
 *   "E-Loaders"                     → "Electric"
 * @param {string} segment
 * @returns {string} Fuel type or empty string if not determinable
 */
function parseFuelTypeFromSegment(segment) {
  if (!segment) return '';
  const s = cleanString(segment);
  const lower = s.toLowerCase();

  // Electric variants first (before "non-diesel" check)
  if (lower.includes('electric') || lower.includes('[electric]')) return 'Electric';
  if (/\be[\s-]?(rickshaw|loader)/i.test(s)) return 'Electric';
  if (/\bsc[\/_]ev\b/i.test(s) || lower === 'sc_ev') return 'Electric';
  if (/\d+\s*kw/i.test(s)) return 'Electric';

  // Non-diesel = everything except diesel
  if (/non[\s-]?diesel/i.test(s)) return 'Petrol / CNG / EV';

  // CNG check before diesel (since "CNG" is specific)
  if (/\bcng\b/i.test(s)) return 'CNG';

  // Diesel
  if (/\bdiesel\b/i.test(s) || /\[D\]/.test(s)) return 'Diesel';

  // Petrol
  if (/\bpetrol\b/i.test(s) || /\[P\]/.test(s)) return 'Petrol';

  return '';
}

/**
 * Parse vehicle age from a GCV segment string.
 * Strips tonnage patterns first to avoid false matches, then looks for
 * age patterns signalled by "years", "yrs", "yr", or "age" keyword.
 *
 * Examples:
 *   "GCV4 upto 1.6T 0-5 years"       → { min: 0, max: 5 }
 *   "GCV4 3.5T TO 7.5T 5-10 yrs"     → { min: 5, max: 10 }
 *   "GCV4 upto 2.5T 3+ years"        → { min: 3, max: 99 }
 *   "GCV4 upto 1.6T"                 → { min: null, max: null }
 * @param {string} segment
 * @returns {{ min: number|null, max: number|null }}
 */
function parseVehicleAgeFromSegment(segment) {
  if (!segment) return { min: null, max: null };
  const s = cleanString(segment);

  // Strip tonnage patterns to avoid confusion with age numbers.
  // Order matters: strip "upto X T" as a unit first so "upto" doesn't orphan
  // and greedily consume the next number (which may be part of an age range).
  const cleaned = s
    .replace(/up\s*to[_\s]*([\d.]+)\s*T\b/gi, ' ')                  // "upto 1.6T" as unit
    .replace(/[\d.]+\s*T\s*(?:to|[-–_])\s*[\d.]+\s*T\b/gi, ' ')    // "1.6T to 2.5T"
    .replace(/[\d.]+\s*(?:to|[-–_])\s*[\d.]+\s*T\b/gi, ' ')         // "12 to 20T"
    .replace(/[\d.]+\s*T\b/gi, ' ');                                  // bare "2.5T"

  // "X-Y years" / "X-Yyrs" / "X to Y years" / "age X-Y years"
  let m = cleaned.match(/(?:age\s+)?(\d+)\s*(?:to|[-–])\s*(\d+)\s*(?:years?|yrs?)\b/i);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

  // Bare "X-Y" after "age" keyword
  m = cleaned.match(/age\s+(\d+)\s*(?:to|[-–])\s*(\d+)/i);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

  // "X+ years" / "X+yrs" / "X+ yr"
  m = cleaned.match(/(\d+)\s*\+\s*(?:years?|yrs?)\b/i);
  if (m) return { min: parseInt(m[1], 10), max: 99 };

  // "age X+"
  m = cleaned.match(/age\s+(\d+)\s*\+/i);
  if (m) return { min: parseInt(m[1], 10), max: 99 };

  // Bare "X-Y" (no "years" keyword) — after tonnage stripped, remaining N-N is likely age
  m = cleaned.match(/(\d+)\s*[-–]\s*(\d+)(?:\s|$|\))/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

  // Bare "X+" (no "years" keyword) — after tonnage stripped, remaining N+ is likely age
  m = cleaned.match(/(\d+)\s*\+/);
  if (m) return { min: parseInt(m[1], 10), max: 99 };

  return { min: null, max: null };
}

/**
 * Extract specific RTO codes from remarks or segment text.
 * Looks for patterns like:
 *   "Only for AS05, AS07 RTOs"           → ["AS05", "AS07"]
 *   "Only for AS01 & AS02 RTOs"          → ["AS01", "AS02"]
 *   "only for UP32, UP33 and UP41"       → ["UP32", "UP33", "UP41"]
 *   "except UP32,UP33 and UP41"          → { except: ["UP32", "UP33", "UP41"] }
 *   "Declined for all RTOs except UP32"  → { except: ["UP32"] }
 *
 * @param {string} text - Remarks or segment text
 * @returns {{ only: string[], except: string[] } | null}
 *   Returns null if no RTO-specific pattern found.
 */
function parseRtoCodes(text) {
  if (!text) return null;
  let s = cleanString(text);

  // Expand compact prefix-shared lists FIRST. Common Indian source patterns:
  //   "JK-01,04,06,08,11"  → "JK-01, JK-04, JK-06, JK-08, JK-11"
  //   "UP-14,16,37"         → "UP-14, UP-16, UP-37"
  //   "HR-38,51,55,26"      → "HR-38, HR-51, HR-55, HR-26"
  //   "MP06,07,09,10"       → "MP06, MP07, MP09, MP10"
  // The pre-expand picks up <prefix>-?<digits>(,<digits>)+ runs and
  // re-emits with the prefix attached to every number in the run.
  s = s.replace(
    /\b([A-Z]{2,3})[-\s]?(\d{1,3})((?:\s*,\s*\d{1,3})+)/g,
    (match, prefix, first, tail) => {
      const tailNums = tail.match(/\d{1,3}/g) || [];
      return [prefix + first, ...tailNums.map(n => prefix + n)].join(',');
    }
  );

  // Normalise hyphens / spaces between the 2-letter prefix and the 2-3-digit
  // suffix so "HR 68", "HR-68", "WB-02" all collapse to the canonical
  // 2L+2-3D form before the regex runs ("HR68", "WB02").
  s = s.replace(/\b([A-Z]{2})[\s-]+(\d{1,3})\b/g, '$1$2');

  // RTO code pattern: 2 uppercase letters followed by 2-3 digits.
  const rtoPattern = /[A-Z]{2}\d{2,3}/g;

  // "X IS ALLOWED" / "X INCLUDED" / "X is included" → inclusion (treat as "only for")
  if (/\b(?:is\s+allowed|allowed|included)\b/i.test(s) && !/\b(?:not\s+allowed|excluded)\b/i.test(s)) {
    const codes = s.toUpperCase().match(rtoPattern);
    if (codes && codes.length > 0) return { only: codes, except: [] };
  }
  // "X EXCLUDED" / "X is declined" → exclusion
  if (/\b(?:excluded|declined|not\s+allowed)\b/i.test(s)) {
    const codes = s.toUpperCase().match(rtoPattern);
    if (codes && codes.length > 0) return { only: [], except: codes };
  }

  // Check "except" / "excluding" patterns FIRST (before "only for")
  // e.g. "Declined for all RTOs except UP32,UP33 and UP41"
  // e.g. "Excluding WB01, WB02, WB03 RTOs"
  const exceptMatch = s.match(/(?:except|excl(?:uding)?)\s+(.+?)$/i);
  if (exceptMatch) {
    const codes = exceptMatch[1].toUpperCase().match(rtoPattern);
    if (codes && codes.length > 0) {
      return { only: [], except: codes };
    }
  }

  // "Only for XX, YY RTOs" or "Only for XX & YY" or "Only for XX RTO"
  // Also matches: "For AP16 RTO only"
  const onlyMatch = s.match(/(?:only\s+for|for)\s+(.+?)(?:\s+RTOs?)?(?:\s+only)?$/i);
  if (onlyMatch) {
    const codes = onlyMatch[1].toUpperCase().match(rtoPattern);
    if (codes && codes.length > 0) {
      return { only: codes, except: [] };
    }
  }

  // Bare RTO code list without "Only for" prefix (e.g. "TN43, TN50, TN55, TN67")
  const bareCodes = s.toUpperCase().match(rtoPattern);
  if (bareCodes && bareCodes.length >= 2) {
    // If text is mostly RTO codes (at least 2), treat as "only" list
    const textWithoutCodes = s.replace(/[A-Z]{2}\d{2}/gi, '').replace(/[,&\s]+/g, '').trim();
    if (textWithoutCodes.length < 10) {
      return { only: bareCodes, except: [] };
    }
  }

  return null;
}

/**
 * Parse a conditional rate cell of the form
 *   "TOKEN1|TOKEN2|...:RATE%, TOKEN1|...:RATE%, ..."
 * used by ICICI CV_COMP / CV_AOTP cells like
 *   "M&M|NEW:37%,M&M|OLD:20%,OTHERS:0%"
 *   "COMP|TATA:28%,COMP|AL|>=10 yrs:28%,COMP|OTHERS:5%"
 *   "Age 4-5 yrs:0,OLD|OTHERS:57%"
 *   "OLD:55%,NEW:0%"
 *   "CC,Others:10%"             ← skips CC chunk, emits Others 10%
 *   ">=6 yrs:10%,OTHERS:0%"
 *   "KASHMIR|TATA:50%,KASHMIR|AL:45%,OTHERS:0%"
 *
 * Returns an array of partial rule overrides — one per comma chunk —
 * with optional `make`, `business_type`, `vehicle_age_min/max`,
 * `rto_hint`, `rate_type_hint`.  Caller is responsible for spreading
 * these onto the base rule and persisting them.
 *
 * Returns null when the cell doesn't match the conditional grammar
 * (caller should fall back to normalizeRate).
 */
function parseConditionalRateCell(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  // Quick sniff: must contain ':' AND either '|' or ',' to be conditional.
  // A pure "55%" cell or "OLD:32%" single chunk also qualifies (just `:`).
  if (!raw.includes(':')) return null;

  // Split on top-level commas. The grammar doesn't nest commas, so a plain
  // split is safe.
  const chunks = raw.split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const chunk of chunks) {
    // Skip bare CC (CC Call — rate not in source)
    if (/^cc$/i.test(chunk)) continue;
    const colon = chunk.lastIndexOf(':');
    if (colon < 0) continue;
    const condPart = chunk.slice(0, colon).trim();
    const ratePart = chunk.slice(colon + 1).trim();
    const rateMatch = ratePart.match(/(-?\d+(?:\.\d+)?)/);
    if (!rateMatch) continue;
    const rateNum = parseFloat(rateMatch[1]);
    // Cells use percent ints ("37%", "5%") or bare numbers ("0").  Always
    // divide by 100 to land in the 0–1 fraction range used internally.
    const rateValue = rateNum / 100;
    const rec = {
      rate_value: rateValue,
      rate_text: chunk,
    };
    // Tokenise the condition part on `|`
    const tokens = condPart.split('|').map(t => t.trim()).filter(Boolean);
    for (const tok of tokens) {
      const tu = tok.toUpperCase();
      if (/^(COMP|COMPREHENSIVE)$/.test(tu)) { rec.rate_type_hint = 'COMP'; continue; }
      if (/^(AOTP|TP|SATP|ACT)$/.test(tu))   { rec.rate_type_hint = 'TP';   continue; }
      if (/^SAOD$/.test(tu))                  { rec.rate_type_hint = 'SAOD'; continue; }
      if (/^NEW(\s*BIZ)?$/.test(tu)) {
        rec.business_type = 'New';
        if (rec.vehicle_age_min == null) rec.vehicle_age_min = 0;
        if (rec.vehicle_age_max == null) rec.vehicle_age_max = 0;
        continue;
      }
      if (/^OLD$/.test(tu)) {
        rec.business_type = 'Rollover';
        if (rec.vehicle_age_min == null) rec.vehicle_age_min = 1;
        continue;
      }
      if (/^OTHERS$/.test(tu)) continue;          // no narrowing
      // Age band patterns
      let m;
      if ((m = tok.match(/^(?:Age\s*)?(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*yrs?$/i))) {
        rec.vehicle_age_min = parseInt(m[1], 10);
        rec.vehicle_age_max = parseInt(m[2], 10);
        continue;
      }
      if ((m = tok.match(/^>=?\s*(\d+(?:\.\d+)?)\s*yrs?$/i))) {
        rec.vehicle_age_min = parseInt(m[1], 10);
        continue;
      }
      if ((m = tok.match(/^<=?\s*(\d+(?:\.\d+)?)\s*yrs?$/i))) {
        rec.vehicle_age_max = parseInt(m[1], 10);
        continue;
      }
      if ((m = tok.match(/^(\d+)\s*yrs?$/i))) {
        rec.vehicle_age_min = parseInt(m[1], 10);
        rec.vehicle_age_max = parseInt(m[1], 10);
        continue;
      }
      // Anything else is treated as Make (or RTO hint when in a known
      // RTO-like list — for now we just stash it on `make`; the export
      // can re-route via remarks if needed).  Pre-existing make wins —
      // if a token appears later, append as RTO hint instead.
      if (!rec.make) rec.make = tok;
      else {
        // Already had a Make → this token is likely an RTO/city carve-out
        rec.rto_hint = rec.rto_hint ? `${rec.rto_hint} ${tok}` : tok;
      }
    }
    out.push(rec);
  }
  return out.length > 0 ? out : null;
}

module.exports = {
  normalizeRate,
  cleanString,
  parseWeightBand,
  parseCCBand,
  parseAgeBand,
  parseSeatingCapacity,
  parseFuelTypeFromSegment,
  parseVehicleAgeFromSegment,
  parseRtoCodes,
  parseConditionalRateCell,
};
