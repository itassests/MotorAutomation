/**
 * Pivot-by-city parser engine.
 *
 * For sheets where:
 *   - Left columns describe the rule (segment / section text / age cat / slab / etc.)
 *   - A wide horizontal block of columns is one row per city/cluster/region,
 *     with each cell holding the rate for that city.
 *   - Optionally, a SECOND block of city columns follows (separated by a
 *     blank divider) carrying a different channel (TATA splits DM vs HOM,
 *     where HOM holds incremental adjustments to add on top of DM).
 *
 * Each (rule × city × channel) emits one rate_rule.
 *
 * Config shape:
 * {
 *   layout: "pivot_by_city",
 *   product: "GCV",                     // optional default; classifyProduct may override
 *   header_row: 0,
 *   data_start_row: 1,
 *   data_end_row: 968,                  // optional — defaults to last row
 *   key_columns: {                      // all optional; absent keys are simply skipped
 *     segment: 0,
 *     section_text: 1,                  // → ins_product (Package/SATP)
 *     vehicle_age: 2,                   // free text "1-5", ">=1<=5" etc.
 *     slab: 3,                          // → volume_tier "Slab 1"…"Slab 7"
 *     vehicle_type: null,
 *     business_type: null,
 *     fuel_type: null,
 *     ncb: null,
 *     addon: null,
 *     make: null
 *   },
 *   city_blocks: [                      // 1 or 2 blocks
 *     { start_col: 4,  end_col: 59,  channel: "DM"  },
 *     { start_col: 61, end_col: 116, channel: "HOM" }
 *   ],
 *   // OR — if channel varies per column (Pvtcar style), use:
 *   // city_blocks: [{ start_col: 12, end_col: 66, channel_row: 3 }]
 *   //   reads the channel label from row 3 for each column
 *   decline_markers: ["D", "NA", "Decline"],
 *   skip_zero_rates: true               // optional (default false). TATA HOM
 *                                       //   often holds 0 for the slab-1 row
 *                                       //   meaning "no incremental add". Set
 *                                       //   true to suppress those rules.
 * }
 */

const {
  normalizeRate,
  cleanString,
  parseCCBand,
  parseWeightBand,
  parseSeatingCapacity,
  parseFuelTypeFromSegment,
  parseVehicleAgeFromSegment,
} = require('../utils/normalizer');
const { classifyProduct } = require('../utils/product-classifier');

/**
 * Parse a free-text age band like ">=1<=5", "1-5", "0 to 2", "<=1", ">=10".
 * Returns { min, max } in years (integers). Either bound may be null.
 */
function parseAgeCat(text) {
  if (text == null) return { min: null, max: null };
  const s = String(text).trim();
  if (!s || s.toUpperCase() === 'NA' || s.toUpperCase() === 'ALL') return { min: null, max: null };

  // "Brand New" → ageless / treat as 0
  if (/^brand\s*new$/i.test(s)) return { min: 0, max: 0 };

  // ">=1<=5" or ">=1 <=5"
  const both = s.match(/>=\s*(\d+)\s*<=\s*(\d+)/);
  if (both) return { min: parseInt(both[1], 10), max: parseInt(both[2], 10) };
  // ">=N"
  const ge = s.match(/^>=\s*(\d+)/);
  if (ge) return { min: parseInt(ge[1], 10), max: null };
  // "<=N"
  const le = s.match(/^<=\s*(\d+)/);
  if (le) return { min: null, max: parseInt(le[1], 10) };
  // ">N"
  const gt = s.match(/^>\s*(\d+)/);
  if (gt) return { min: parseInt(gt[1], 10) + 1, max: null };
  // "<N"
  const lt = s.match(/^<\s*(\d+)/);
  if (lt) return { min: null, max: parseInt(lt[1], 10) - 1 };
  // "N-M" or "N to M" or "N–M"
  const range = s.match(/(\d+)\s*(?:-|to|–)\s*(\d+)/i);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  // Single integer: treat as exact
  const single = s.match(/^(\d+)$/);
  if (single) return { min: parseInt(single[1], 10), max: parseInt(single[1], 10) };
  return { min: null, max: null };
}

/**
 * Parse a Royal state CV-style qualifier banner like:
 *   "All Years with or without Nil Dep"   → age 0-99,  fan out [Yes, No]
 *   "All Years with Nil Dep"              → age 0-99,  Yes
 *   "All Years without Nil Dep"           → age 0-99,  No
 *   "All years"                           → age 0-99,  blank
 *   "Upto 5 Years"                        → age 0-5,   blank
 *   "5 Years & Above"                     → age 5-99,  blank
 *   "5 years & Above"                     → age 5-99,  blank
 *   "Above 5 Years"                       → age 5-99,  blank
 *   "5 & Above Years"                     → age 5-99,  blank
 *   "Brand New"                           → age 0-0,   blank
 *
 * Returns { ageMin, ageMax, depVariants } — depVariants is one of:
 *   ['Yes', 'No']  (fan out: emit two rules, one per dep state)
 *   ['Yes']        (single rule with addon = "Nil Dep")
 *   ['No']         (single rule with addon explicitly blank → "No" in export)
 *   [null]         (qualifier has no dep info — single rule, addon untouched)
 */
/**
 * Scan a sheet for explicit RTO-code override notes.
 *
 * Source pattern (Royal AP / Pan India CV STP):
 *   "Vijayawada RTO's - AP16, AP17, AP18, AP19, AP39, AP40 (Pls note ...)"
 *   "Vijayawada RTOs : AP16,AP17,AP18,AP19"
 *
 * Returns Map<lowercased_cluster_name, [codes]>. When a rule's region
 * matches one of these names, the codes get attached to the rule as a
 * "Only for X, Y, Z" hint in `remarks` so the export's existing
 * parseRtoCodes path uses them in the RTOCode column.
 */
function parseRtoOverrideNotes(sheetData) {
  const map = new Map();
  if (!Array.isArray(sheetData)) return map;
  // Match "<Name> RTO('s)? - / : <list of codes>".
  // Allow <Name> to span 1-4 words (alpha, ampersand, hyphen). Codes are
  // 2-letter state prefix + 1-3 digits, comma-separated, optional spaces.
  // Apostrophe class includes ASCII ' and curly Unicode ' (U+2019) which
  // Excel often substitutes — Royal Pan India CV STP / AP notes use it.
  const re = /\b([A-Za-z][A-Za-z &-]{0,40}?)\s*RTO['’s]*\s*[-:]\s*((?:[A-Z]{2}\d{1,3})(?:\s*,\s*[A-Z]{2}\d{1,3}){0,30})/i;
  for (const row of sheetData) {
    if (!row) continue;
    for (const cell of row) {
      const s = String(cell || '');
      if (!s) continue;
      const m = s.match(re);
      if (!m) continue;
      const name = m[1].replace(/\s+/g, ' ').trim().toLowerCase();
      // Trim trailing connector words like "the" / "for" if any, plus
      // any trailing punctuation (some sheets mark cluster names with
      // a "*" annotation, e.g. "Vijayawada*").
      const cleanName = name.replace(/^(?:the|for|of)\s+/i, '').replace(/[^a-z0-9]+$/g, '');
      const codes = m[2].split(/\s*,\s*/).map(c => c.trim().toUpperCase()).filter(Boolean);
      if (cleanName && codes.length > 0) {
        // Merge if the same cluster is mentioned in multiple cells
        const existing = map.get(cleanName);
        if (existing) {
          for (const c of codes) {
            if (!existing.includes(c)) existing.push(c);
          }
        } else {
          map.set(cleanName, codes);
        }
      }
    }
  }
  return map;
}

/**
 * Scan all rows of a sheet for an "IRDA - X% on OD and Y% on TP ( > Z yrs )"
 * footer note (Royal Sundaram state CV grids include this on the last
 * row of each sheet so an "IRDA" cell elsewhere doesn't mean "declined"
 * but rather "use IRDA-baseline rate"). Returns { odRate, tpRate, ageMin }
 * or null when no such note is found.
 */
function parseIrdaNote(sheetData) {
  if (!Array.isArray(sheetData)) return null;
  for (let r = 0; r < sheetData.length; r++) {
    const row = sheetData[r] || [];
    for (const cell of row) {
      const s = String(cell || '');
      if (!/IRDA\s*[-:]/i.test(s)) continue;
      const m = s.match(/IRDA\s*[-:]\s*([\d.]+)\s*%\s*on\s*OD\s*(?:and|&|,)\s*([\d.]+)\s*%\s*on\s*TP/i);
      if (!m) continue;
      const odRate = parseFloat(m[1]) / 100;
      const tpRate = parseFloat(m[2]) / 100;
      // Optional age constraint like "( > 4yrs )" / "(>4 years)"
      let ageMin = null;
      const am = s.match(/[>>]=?\s*(\d+)\s*y(?:rs?|ears?)/i);
      if (am) ageMin = parseInt(am[1], 10) + 1;   // ">4 yrs" → ages 5+
      return { odRate, tpRate, ageMin, raw: s.trim() };
    }
  }
  return null;
}

function parseYearDepQualifier(text) {
  // Normalise "w/o", "w/O", "with out" etc. to "without" so a single
  // regex can pick all spellings up.
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const s = raw
    .replace(/\bw\s*\/\s*[oO]\b/g, 'without')
    .replace(/\bwith\s+out\b/gi, 'without')
    .replace(/\bw\.?\s*\/\s*\.?\s*[oO]\b/g, 'without');

  let ageMin = null, ageMax = null;
  if (!s) return { ageMin, ageMax, depVariants: [null], make: '', makeNote: '' };

  if (/\bbrand\s*new\b/i.test(s)) { ageMin = 0; ageMax = 0; }
  else if (/\ball\s*years?\b/i.test(s)) { ageMin = 0; ageMax = 99; }
  else {
    // "Upto 5 Years" / "Up to 5 Years" / "Up-to 5 Year" — tolerate the
    // space, hyphen, or none between "up" and "to".
    let m = s.match(/\bup\s*[-\s]?\s*to\s+(\d+)\s*years?\b/i);
    if (m) { ageMin = 0; ageMax = parseInt(m[1], 10); }
    if (ageMin == null && ageMax == null) {
      m = s.match(/(\d+)\s*(?:&|and)\s*above\s*years?/i)
        || s.match(/(\d+)\s*years?\s*(?:&|and)?\s*above/i)
        || s.match(/above\s*(\d+)\s*years?/i);
      if (m) { ageMin = parseInt(m[1], 10); ageMax = 99; }
    }
    if (ageMin == null && ageMax == null) {
      m = s.match(/(\d+)\s*to\s*(\d+)\s*years?/i);
      if (m) { ageMin = parseInt(m[1], 10); ageMax = parseInt(m[2], 10); }
    }
  }

  // Order matters here — "with or without" must match before the more
  // permissive "without" / "with" branches.
  let depVariants = [null];
  if (/with\s*or\s*without\s*nil\s*dep/i.test(s)) depVariants = ['Yes', 'No'];
  else if (/without\s*nil\s*dep/i.test(s))        depVariants = ['No'];
  else if (/with\s*nil\s*dep/i.test(s))           depVariants = ['Yes'];

  // Make / make-family qualifier.  Order matters here:
  //   1. "Other than X" → exclusion note (no `make` narrowing)
  //   2. Parenthesised make like "(AL)" / "(Eicher)" / "(TATA)" /
  //      "(TATA AL)" — extract and expand abbreviations
  //   3. Bare "TATA & AL" mention in the qualifier text
  //   4. "All Makes" / "all Makes" → leave make blank (no narrowing)
  let make = '';
  let makeNote = '';
  if (/\bother\s*than\b/i.test(s)) {
    const m = s.match(/other\s*than\s*([\w &,]+)/i);
    if (m) makeNote = `Other than ${expandMakeAbbreviations(m[1].trim())}`;
  } else {
    // Parenthesised make qualifier (handles unclosed paren too —
    // Royal MH / AP cells sometimes drop the closing bracket).
    const parenMatch = s.match(/\(\s*([A-Za-z][A-Za-z &,]*?)\s*(?:\)|$)/);
    if (parenMatch) {
      const inside = parenMatch[1].trim();
      // Skip generic "all Makes" wrappings.
      if (!/^all\s*Makes$/i.test(inside)) {
        const expanded = expandMakeAbbreviations(inside);
        if (expanded) make = expanded;
      }
    }
    // Fall-back: bare "TATA & AL" / "TATA AL" in the qualifier (no parens).
    if (!make && /\b(?:TATA|Tata)\s*&?\s*AL\b/i.test(s)) {
      make = 'TATA, Ashok Leyland';
    }
  }

  return { ageMin, ageMax, depVariants, make, makeNote };
}

// Expand common abbreviations Royal uses for makes inside parenthesised
// qualifiers ("(AL)" → "Ashok Leyland", "(TATA AL)" → "TATA, Ashok
// Leyland"). Unknown tokens fall through unchanged.
function expandMakeAbbreviations(text) {
  if (!text) return '';
  const norm = String(text).replace(/\s+/g, ' ').replace(/^\s*&\s*/, '').trim();
  const upper = norm.toUpperCase();
  // Direct matches first (single make, multi-make combos)
  const direct = {
    'AL':            'Ashok Leyland',
    'TATA':          'TATA',
    'EICHER':        'Eicher',
    'BHARATBENZ':    'BharatBenz',
    'BB':            'BharatBenz',
    'MAHINDRA':      'Mahindra',
    'TATA AL':       'TATA, Ashok Leyland',
    'TATA & AL':     'TATA, Ashok Leyland',
    'TATA, AL':      'TATA, Ashok Leyland',
    'AL & TATA':     'TATA, Ashok Leyland',
    'EICHER & AL':   'Eicher, Ashok Leyland',
    'TATA EICHER':   'TATA, Eicher',
    'TATA & EICHER': 'TATA, Eicher',
  };
  if (direct[upper]) return direct[upper];
  // Token-by-token expansion for combinations not in the direct map.
  const tokenMap = { AL: 'Ashok Leyland', BB: 'BharatBenz' };
  const tokens = upper.split(/\s*[&,]\s*|\s+/).filter(Boolean);
  if (tokens.every(t => /^[A-Z]+$/.test(t))) {
    return tokens.map(t => tokenMap[t] || (t.charAt(0) + t.slice(1).toLowerCase())).join(', ');
  }
  return norm;
}

/**
 * Parse a plain numeric tonnage band found in a column header.
 * Royal Sundaram state CV sheets use bare "0 to 2.3", "7.5 and 12",
 * "20 to 40", "Above 45", "Upto 2.5" style headers (no "T" suffix), so
 * the global parseWeightBand (which requires the T marker) doesn't fire.
 * This helper is invoked only in column-header → segment layouts.
 */
function parsePlainBand(text) {
  if (!text) return { min: null, max: null };
  const s = String(text).replace(/\s+/g, ' ').trim();
  // Strip any " upto X% disc" / "@ ..." / qualifier suffix so the leading
  // numeric range still matches.
  const head = s.split(/\s+(?:upto|@|with|w\/|other|Other|tata|TATA|all|All|dis|Dis)/i)[0];
  let m = head.match(/^\s*([\d.]+)\s*(?:to|and|-|–)\s*([\d.]+)/i);
  if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  m = head.match(/^\s*Above\s+([\d.]+)/i);
  if (m) return { min: parseFloat(m[1]), max: null };
  m = head.match(/^\s*(?:Upto|Up\s*to|<=?)\s*([\d.]+)/i);
  if (m) return { min: 0, max: parseFloat(m[1]) };
  return { min: null, max: null };
}

function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const {
    product,
    header_row = 0,
    data_start_row,
    data_end_row,
    key_columns = {},
    city_blocks = [],
    decline_markers = [],
    skip_zero_rates = false,
    // Where the column header text lands on each emitted rule:
    //   "region"  → header is treated as a city / cluster (default)
    //   "segment" → header is the segment (e.g. "0 to 2.3" tonnage band).
    //               In that case region/state come from key_columns.region.
    column_header_field = 'region',
    // Default values for any rule field that ends up blank/null after
    // parsing. Useful when a sheet's header / title row carries metadata
    // common to ALL its rules (Royal state CV grids: "GCV - 4 wheeler
    // Non EV - BAC Grid for Comprehensive Policy" → fuel_type ≠ Electric).
    defaults = {},
    // Like defaults but ALWAYS overrides — for fields where the parsed
    // value (e.g. the channel banner text in rate_type) is unwanted and
    // should be replaced wholesale (Royal state CV: rate_type → "Comp").
    force_overrides = {},
  } = sheetConfig;

  if (!Array.isArray(city_blocks) || city_blocks.length === 0) {
    throw new Error(`pivot_by_city requires at least one city_blocks entry (sheet "${meta.sheetName}")`);
  }

  const headerRowArr = sheetData[header_row] || [];

  // Detect a sheet-level "IRDA - X% on OD and Y% on TP ( > Zyrs )" footer
  // note once per sheet. When present, an "IRDA" cell value will fan out
  // into a paired (OD, TP) rule instead of being treated as declined.
  const irdaNote = parseIrdaNote(sheetData);

  // Detect "<Cluster> RTO's - <codes>" override notes. When a rule's
  // region matches one of these names, the listed codes get attached
  // as an "Only for X, Y, Z" hint so the export's RTOCode column shows
  // those specific codes (overrides the default rtoIndex lookup).
  const rtoOverrideNotes = parseRtoOverrideNotes(sheetData);

  // Resolve per-column metadata: for each block, build [{col, city, channel}]
  const colDescriptors = [];
  for (const block of city_blocks) {
    const start = block.start_col;
    const end = block.end_col;
    const channelRow = block.channel_row != null ? block.channel_row : null;
    const channelStatic = block.channel || null;
    for (let c = start; c <= end; c++) {
      const cityRaw = headerRowArr[c];
      const city = cleanString(cityRaw)
        .replace(/^Sum of\s+/i, '')           // TATA pivot leaves "Sum of XYZ"
        .trim();
      if (!city) continue;                     // gap/divider column — skip
      let channel = channelStatic;
      if (channelRow != null) {
        const banner = (sheetData[channelRow] || [])[c];
        channel = cleanString(banner) || null;
      }
      colDescriptors.push({ col: c, city, channel });
    }
  }

  const dStart = data_start_row != null ? data_start_row : header_row + 1;
  const dEnd = data_end_row != null ? Math.min(data_end_row, sheetData.length - 1) : sheetData.length - 1;

  for (let r = dStart; r <= dEnd; r++) {
    const row = sheetData[r];
    if (!row || row.length === 0) continue;

    // Pull row keys
    const get = (idx) => idx != null && idx >= 0 ? cleanString(row[idx]) : '';
    let segment = get(key_columns.segment);
    const sectionText = get(key_columns.section_text);   // Package / SATP
    const vehicleAgeText = get(key_columns.vehicle_age);
    const slab = get(key_columns.slab);
    const vehicleType = get(key_columns.vehicle_type);
    const businessType = get(key_columns.business_type);
    const fuelTypeKey = get(key_columns.fuel_type);
    const ncb = get(key_columns.ncb);
    const addonKey = get(key_columns.addon);
    const makeKey = get(key_columns.make);
    const regionKey = get(key_columns.region);   // used when column_header_field === "segment"
    const remarksKey = get(key_columns.remarks);

    // For the segment-as-header layout the row needs at least a region key
    // (e.g. RTO Division) — segments come from the column header instead.
    const isSegmentLayout = column_header_field === 'segment';
    if (isSegmentLayout) {
      if (!regionKey && !remarksKey) continue;
    } else if (!segment && !sectionText && !slab && !vehicleType && !businessType) {
      continue;
    }

    // Skip pivot grand-total / subtotal rows
    if (/^grand\s*total$/i.test(segment) || /^total$/i.test(segment)) continue;
    if (isSegmentLayout && (/^grand\s*total$/i.test(regionKey) || /^total$/i.test(regionKey))) continue;

    // Derive bands from text
    const ageBand = parseAgeCat(vehicleAgeText);
    const weightBand = parseWeightBand(segment) || { min: null, max: null };
    const ccBand = parseCCBand(segment) || { min: null, max: null };
    const seating = parseSeatingCapacity(segment) || { min: null, max: null };

    // Classify product (sheet-level default → may be refined by segment text)
    const classified = classifyProduct(segment || vehicleType || '', product, meta.sheetName);

    // Resolve fuel: explicit key column wins over segment-parsed
    const fuelFromKey = fuelTypeKey && !/^all$/i.test(fuelTypeKey) ? fuelTypeKey : '';
    const fuelFromSeg = parseFuelTypeFromSegment(segment || '') || '';
    const fuel = fuelFromKey || fuelFromSeg || '';

    // Map "Section Text" → ins_product semantics if present
    // Package/SAOD → Comp; SATP/TP → TP. Stored in rate_type alongside slab.
    const rateTypeBits = [];
    if (sectionText) rateTypeBits.push(sectionText);
    if (slab) rateTypeBits.push(slab);
    if (ncb && !/^na$/i.test(ncb) && !/^all$/i.test(ncb)) rateTypeBits.push(`NCB:${ncb}`);

    for (const desc of colDescriptors) {
      const cellValue = row[desc.col];

      // IRDA cell handling — when the sheet has an IRDA footer note and
      // this cell literally reads "IRDA", treat it as the OD+TP paired
      // baseline rate. Fan out is handled below by injecting a synthetic
      // pair into the depVariants loop.
      const isIrdaCell = irdaNote && typeof cellValue === 'string' && /^\s*IRDA\s*$/i.test(cellValue);

      const normalized = isIrdaCell
        ? null
        : normalizeRate(cellValue, decline_markers);
      if (!normalized && !isIrdaCell) continue;
      if (normalized && skip_zero_rates && normalized.rate_value === 0) continue;

      const channel = desc.channel || '';
      const rateTypeFinal = channel
        ? [channel, ...rateTypeBits].join('|')
        : rateTypeBits.join('|');

      // Column header → segment layout (Royal state CV grid):
      //   the column header text (e.g. "0 to 2.3", "7.5 to 12 Other than TATA")
      //   becomes the rule's segment, and region/state come from key_columns.
      // Default layout (TATA): column header is the city/cluster → region.
      let outRegion;
      let outSegment;
      if (isSegmentLayout) {
        outRegion = regionKey;
        // Collapse multi-line column headers into a single line for storage
        outSegment = String(desc.city).replace(/\s*\n\s*/g, ' ').trim();
      } else {
        outRegion = desc.city;
        outSegment = segment;
      }

      // Re-derive bands from the *outgoing* segment (only when segment came
      // from the column header — otherwise the row-key segment was already
      // band-parsed above).  We also try the plain "X to Y" / "Above X" /
      // "Upto X" parser (Royal CV state sheets), then fall back to
      // parseWeightBand which requires a "T" marker.
      let colWeightBand, colCcBand, colSeating;
      if (isSegmentLayout) {
        colWeightBand = parseWeightBand(outSegment) || { min: null, max: null };
        if (colWeightBand.min == null && colWeightBand.max == null) {
          colWeightBand = parsePlainBand(outSegment);
        }
        colCcBand = parseCCBand(outSegment) || { min: null, max: null };
        colSeating = parseSeatingCapacity(outSegment) || { min: null, max: null };
      } else {
        colWeightBand = weightBand;
        colCcBand = ccBand;
        colSeating = seating;
      }

      // Parse year-band / Nil-Dep / make qualifier from the combined
      // channel banner + segment text.  Royal state CV sheets carry
      // these qualifiers in BOTH places (banner row above the tonnage
      // header AND the tonnage cell itself), so concatenating gives
      // the parser a complete picture.
      const qualifierText = isSegmentLayout
        ? `${desc.channel || ''} ${outSegment || ''}`
        : '';
      const qual = qualifierText.trim()
        ? parseYearDepQualifier(qualifierText)
        : { ageMin: null, ageMax: null, depVariants: [null], make: '', makeNote: '' };

      // Append make-family qualifier ("Other than TATA, AL") onto the
      // segment so the make-narrowing context survives without stealing
      // the remarks slot (which holds the state name in segment-layout).
      const segmentWithMakeNote = qual.makeNote
        ? `${outSegment || ''}${outSegment ? ' ' : ''}(${qual.makeNote})`.trim()
        : outSegment;

      // Build one rule template, then fan out across dep variants. When
      // depVariants is [null] we just emit the single rule unchanged.
      const baseRule = {
        insurer: meta.insurer,
        product: classified.product,
        sheet_name: meta.sheetName,
        region: outRegion,
        segment: segmentWithMakeNote,
        make: makeKey || qual.make || '',
        model: vehicleType || '',
        sub_type: businessType || '',
        fuel_type: fuel,
        cc_band_min: colCcBand.min,
        cc_band_max: colCcBand.max,
        weight_band_min: colWeightBand.min,
        weight_band_max: colWeightBand.max,
        age_band_min: null,
        age_band_max: null,
        vehicle_age_min: qual.ageMin != null ? qual.ageMin : ageBand.min,
        vehicle_age_max: qual.ageMax != null ? qual.ageMax : ageBand.max,
        seating_capacity_min: colSeating.min,
        seating_capacity_max: colSeating.max,
        volume_tier: slab || '',
        addon: addonKey && !/^all$/i.test(addonKey) ? addonKey : '',
        carrier_type: '',
        rate_type: rateTypeFinal,
        rate_value: normalized ? normalized.rate_value : null,
        is_declined: normalized ? normalized.is_declined : false,
        rate_text: normalized ? normalized.rate_text : null,
        is_conditional: normalized ? normalized.is_conditional : false,
        // remarks holds the state name when key_columns.remarks is wired
        // to col 0 of a Royal state grid. Export uses this to populate
        // the State column and keep Zone blank.
        remarks: remarksKey || '',
      };

      // RTO-code override from sheet notes — when the rule's region
      // matches a "<Cluster> RTO's - <codes>" note, append the explicit
      // code list to remarks as "Only for ...".  The export's
      // parseRtoCodes already understands this hint and will use the
      // listed codes for the RTOCode column, ignoring the rtoIndex
      // lookup for that row.  Trailing punctuation/markers ("*") are
      // stripped before the lookup so a sheet entry like "Vijayawada*"
      // still matches the note's "Vijayawada".
      const ovKey = String(outRegion || '').toLowerCase().trim().replace(/[^a-z0-9]+$/g, '');
      const ovCodes = rtoOverrideNotes.get(ovKey);
      if (ovCodes && ovCodes.length > 0) {
        const ovHint = `Only for ${ovCodes.join(', ')}`;
        baseRule.remarks = baseRule.remarks
          ? `${baseRule.remarks} | ${ovHint}`
          : ovHint;
      }

      // IRDA fan-out — for each dep variant, emit one OD rule + one TP
      // rule with the parsed baseline rates and the age constraint from
      // the footer note. The IRDA rate_text gets carried so the user can
      // trace back to the source notation.
      if (isIrdaCell) {
        for (const depFlag of qual.depVariants) {
          for (const ot of ['OD', 'TP']) {
            const rule = { ...baseRule };
            rule.rate_value = ot === 'OD' ? irdaNote.odRate : irdaNote.tpRate;
            rule.rate_text = irdaNote.raw;
            // Apply IRDA's age threshold (e.g. >4 yrs → min 5) if it's
            // narrower than what the qualifier already gave us.
            if (irdaNote.ageMin != null) {
              rule.vehicle_age_min = Math.max(rule.vehicle_age_min ?? 0, irdaNote.ageMin);
              if (rule.vehicle_age_max == null) rule.vehicle_age_max = 99;
            }
            if (depFlag === 'Yes') rule.addon = rule.addon || 'Nil Dep';
            else if (depFlag === 'No') rule.addon = '';
            // Apply defaults / force_overrides BEFORE appending the IRDA tag,
            // so a force_overrides.rate_type ("Comp") becomes the prefix and
            // the IRDA_OD / IRDA_TP suffix survives as a sub-tag.
            if (defaults && typeof defaults === 'object') {
              for (const key of Object.keys(defaults)) {
                const cur = rule[key];
                const isBlank = cur == null || cur === '';
                if (isBlank) rule[key] = defaults[key];
              }
            }
            if (force_overrides && typeof force_overrides === 'object') {
              for (const key of Object.keys(force_overrides)) {
                rule[key] = force_overrides[key];
              }
            }
            const baseRt = rule.rate_type || '';
            rule.rate_type = baseRt ? `${baseRt}_IRDA_${ot}` : `IRDA_${ot}`;
            // Tag explicit dep state so the export can show Yes/No
            // (and skip the column when not applicable).
            if (depFlag === 'Yes')      rule.rate_type += '_NilDep';
            else if (depFlag === 'No')  rule.rate_type += '_NoNilDep';
            rules.push(rule);
          }
        }
        continue;
      }

      for (const depFlag of qual.depVariants) {
        const rule = { ...baseRule };
        // Encode depreciation status on the addon field so the export's
        // existing Addon column shows Yes/No naturally.
        if (depFlag === 'Yes') rule.addon = rule.addon || 'Nil Dep';
        else if (depFlag === 'No') rule.addon = '';   // explicit "No" — Addon column blank → renders "No"
        // depFlag === null → leave addon as-is

        // Apply sheet-level defaults for any field that's still blank/null.
        if (defaults && typeof defaults === 'object') {
          for (const key of Object.keys(defaults)) {
            const cur = rule[key];
            const isBlank = cur == null || cur === '';
            if (isBlank) rule[key] = defaults[key];
          }
        }
        if (force_overrides && typeof force_overrides === 'object') {
          for (const key of Object.keys(force_overrides)) {
            rule[key] = force_overrides[key];
          }
        }
        // Append an explicit Nil-Dep tag to rate_type so the export can
        // distinguish "explicitly No" / "explicitly Yes" from "not
        // applicable" (where the source qualifier never mentioned dep).
        // depFlag === null means no dep mention → leave rate_type alone.
        if (depFlag === 'Yes')      rule.rate_type = (rule.rate_type ? rule.rate_type + '_' : '') + 'NilDep';
        else if (depFlag === 'No')  rule.rate_type = (rule.rate_type ? rule.rate_type + '_' : '') + 'NoNilDep';
        rules.push(rule);
      }
    }
  }

  return rules;
}

module.exports = { parse };
