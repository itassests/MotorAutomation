/**
 * Flat-table parser engine.
 *
 * Used for sheets where each row is a complete rule (e.g. Digit 4W SATP, Taxi).
 * Columns are directly mapped to rule fields via column_map.
 *
 * Config shape:
 * {
 *   layout: "flat_table",
 *   product: "4W",
 *   header_row: 1,
 *   data_start_row: 2,
 *   column_map: { region: 0, segment: 1, age_band: 2, rate_value: 3 },
 *   rate_type: "MAX_CD2",
 *   decline_markers: ["NA"]
 * }
 */

const { normalizeRate, cleanString, parseAgeBand, parseCCBand, parseWeightBand, parseSeatingCapacity, parseFuelTypeFromSegment, parseVehicleAgeFromSegment, parseConditionalRateCell } = require('../utils/normalizer');
const { classifyProduct } = require('../utils/product-classifier');

/**
 * Split a combined "CD1 X% / CD2 Y%" cell into two rate objects.
 * Returns { cd1, cd2 } where each is { rate_value, is_declined, rate_text, is_conditional }
 * or null if the cell doesn't match the pattern.
 */
function splitCd1Cd2Cell(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  // Match "CD1 95% / CD2 40%" or "CD1 95%/CD2 40%" (with optional spaces around /)
  const m = s.match(/CD1\s*([\d.]+)\s*%\s*\/\s*CD2\s*([\d.]+)\s*%/i);
  if (!m) return null;
  const cd1Val = parseFloat(m[1]) / 100;
  const cd2Val = parseFloat(m[2]) / 100;
  return {
    cd1: { rate_value: cd1Val, is_declined: false, rate_text: null, is_conditional: false },
    cd2: { rate_value: cd2Val, is_declined: false, rate_text: null, is_conditional: false },
  };
}

/**
 * Split a "X% on OD, Y% on TP" / "X% on OD & Y% on TP" cell into two
 * rate objects — one applied on the OD premium, one on TP. Used by
 * Royal Sundaram 2w Comp Bike column where one cell encodes both
 * premium-basis rates for the same rule (e.g. "22.5% on OD, 2.5% on TP").
 *
 * Returns { od: {...}, tp: {...} } each with `applied_on` set so the
 * Excel export can place them in the correct premium-basis column, or
 * null if the cell doesn't match the pattern.
 */
function splitOdTpCell(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*%\s*on\s*OD\s*[,&]\s*(\d+(?:\.\d+)?)\s*%\s*on\s*TP/i);
  if (!m) return null;
  const odVal = parseFloat(m[1]) / 100;
  const tpVal = parseFloat(m[2]) / 100;
  return {
    od: { rate_value: odVal, is_declined: false, rate_text: s, is_conditional: false, applied_on: 'OD' },
    tp: { rate_value: tpVal, is_declined: false, rate_text: s, is_conditional: false, applied_on: 'TP' },
  };
}

// ── Body-type helpers (for Additional Notes / Additional Comments sections) ──

const BODY_TYPE_PREFIX_MAP = {
  'non-dumper/tipper': '', 'non dumper/tipper': '', 'non dumper tipper': '',
  'dumper/tipper': 'DUMPER_', 'dumper': 'DUMPER_', 'tipper': 'DUMPER_',
  'port trailer': 'PORT_TRAILER_',
  'oil tanker': 'OIL_TANKER_', 'gas tanker': 'GAS_TANKER_',
  'reefer': 'REEFER_', 'flat bed': 'FLAT_BED_',
  'trailer': 'TRAILER_', 'bulker': 'BULKER_',
};

function bodyTypePrefix(bodyType) {
  if (!bodyType) return '';
  return BODY_TYPE_PREFIX_MAP[bodyType.toLowerCase().trim()] ?? '';
}

/** Map short entry types (CD1, CD2, SATP) → full rate_type with body prefix. */
function buildFullRateType(prefix, entryType) {
  switch (entryType.toUpperCase()) {
    case 'CD1':  return prefix + 'COMP_CD1';
    case 'CD2':  return prefix + 'COMP_MAX_CD2';
    case 'SATP': return prefix + 'SATP_MAX_CD2';
    case 'COMP': return prefix + 'COMP_MAX_CD2';
    case 'SAOD': return prefix + 'SAOD_MAX_CD2';
    default:     return prefix + entryType.toUpperCase();
  }
}

/** Determine product context from the Notes "Product" column. */
function noteProductContext(noteProduct) {
  const s = String(noteProduct || '').toUpperCase();
  if (s.includes('SATP')) return 'SATP';
  if (s.includes('SAOD')) return 'SAOD';
  return 'COMP';
}

function buildNoteRateType(productContext, entryType) {
  const et = entryType.toUpperCase();
  if (et === 'CD1') return productContext + '_CD1';
  if (et === 'CD2') return productContext + '_MAX_CD2';
  if (et === 'SATP') return 'SATP_MAX_CD2';
  return et;
}

/**
 * Parse rate entries from note / comment text.
 *   "CD1 - 85%      CD2 - 5%\r\nSATP - 32.5%"
 *     → [{rate_type:'CD1', rate_value:0.85}, {rate_type:'CD2', rate_value:0.05}, ...]
 *   "Blocked" → [{is_declined: true}]
 */
function parseRateEntryText(text) {
  if (!text) return [];
  const s = String(text).trim();
  if (/^\s*Blocked\s*$/i.test(s)) {
    return [{ rate_type: '', rate_value: null, is_declined: true }];
  }
  const entries = [];
  const re = /(CD1|CD2|SATP|COMP|SAOD)\s*[-–]\s*([\d.]+)\s*%/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    entries.push({
      rate_type: m[1].toUpperCase(),
      rate_value: parseFloat(m[2]) / 100, // store as decimal fraction
      is_declined: false,
    });
  }
  return entries; // "as above" entries are skipped
}

/**
 * Parse the Product column from Additional Comments into body type + make note.
 *   "All excluding Volvo and Scania* / Non Dumper/Tipper"
 *     → { vehicleCategory: 'Non-Dumper/Tipper', makeNote: 'All excluding Volvo and Scania' }
 *   "Oil Tanker" → { vehicleCategory: 'Oil Tanker', makeNote: '' }
 */
function parseCommentProduct(product) {
  if (!product) return { vehicleCategory: '', makeNote: '' };
  const s = String(product).trim();
  const patterns = [
    { re: /Non[\s-]*Dumper[\s/]*Tipper/i, label: 'Non-Dumper/Tipper' },
    { re: /Dumper[\s/]*Tipper/i,           label: 'Dumper/Tipper' },
    { re: /Port\s*Trailer/i,              label: 'Port Trailer' },
    { re: /Oil\s*Tanker/i,                label: 'Oil Tanker' },
    { re: /Gas\s*Tanker/i,                label: 'Gas Tanker' },
    { re: /Reefer/i,                       label: 'Reefer' },
    { re: /Flat\s*Bed/i,                  label: 'Flat Bed' },
    { re: /Bulker/i,                       label: 'Bulker' },
  ];
  for (const { re, label } of patterns) {
    const m = s.match(re);
    if (m) {
      const before = s.substring(0, m.index).replace(/[\/\s*]+$/, '').trim();
      return { vehicleCategory: label, makeNote: before };
    }
  }
  return { vehicleCategory: '', makeNote: '' };
}

/**
 * Parse "Additional Notes" and "Additional Comments" sections
 * that appear below the main grid in sheets like HCV GRID.
 */
function parseAdditionalSections(sheetData, sheetConfig, meta) {
  const rules = [];
  const { product } = sheetConfig;

  let notesStart = -1;
  let commentsStart = -1;
  for (let r = 0; r < sheetData.length; r++) {
    const cell = String(sheetData[r]?.[0] || '').trim();
    if (/^Additional\s+Notes/i.test(cell) && notesStart < 0) notesStart = r;
    if (/^Additional\s+Comments/i.test(cell) && commentsStart < 0) commentsStart = r;
  }

  // ── Additional Notes ──
  // Format: Product | Make | Segment | Cluster | Note
  // Note examples: "CD1 - 70%\r\nCD2 - as above", "Blocked"
  if (notesStart >= 0) {
    let headerRow = -1;
    for (let r = notesStart + 1; r < Math.min(notesStart + 5, sheetData.length); r++) {
      if (/^product$/i.test(cleanString(sheetData[r]?.[0] || ''))) { headerRow = r; break; }
    }
    if (headerRow >= 0) {
      for (let r = headerRow + 1; r < sheetData.length; r++) {
        const row = sheetData[r];
        if (!row || !String(row[0] || '').trim()) break;
        if (/^additional/i.test(String(row[0]).trim())) break;

        const noteProduct = cleanString(row[0]);
        const make        = cleanString(row[1]);
        const segment     = cleanString(row[2]);
        const cluster     = cleanString(row[3]);
        const noteText    = String(row[4] || '').trim();
        const prodCtx     = noteProductContext(noteProduct);

        const entries = parseRateEntryText(noteText);
        if (entries.length === 0 && /blocked/i.test(noteText)) {
          entries.push({ rate_type: '', rate_value: null, is_declined: true });
        }

        const classified = classifyProduct(segment, product, meta.sheetName);
        const weightBand = parseWeightBand(segment);
        const vehicleAge = parseVehicleAgeFromSegment(segment);

        for (const entry of entries) {
          const rateType = entry.is_declined
            ? 'BLOCKED'
            : buildNoteRateType(prodCtx, entry.rate_type);

          rules.push({
            insurer: meta.insurer,
            product: classified.product,
            sheet_name: meta.sheetName,
            region: cluster === 'All' ? '' : cluster,
            segment, make,
            model: '', sub_type: '', fuel_type: '',
            cc_band_min: null, cc_band_max: null,
            weight_band_min: weightBand.min, weight_band_max: weightBand.max,
            age_band_min: null, age_band_max: null,
            vehicle_age_min: vehicleAge.min, vehicle_age_max: vehicleAge.max,
            seating_capacity_min: null, seating_capacity_max: null,
            volume_tier: '', addon: '', carrier_type: '',
            remarks: 'Additional Note: ' + noteText,
            rate_type: rateType,
            rate_value: entry.rate_value,
            is_declined: entry.is_declined || false,
            rate_text: null,
            is_conditional: false,
          });
        }
      }
    }
  }

  // ── Additional Comments ──
  // Format: Cluster | Segment | Product | Comments
  // Product may contain body type: "Oil Tanker", "All excluding Volvo…/ Non Dumper/Tipper"
  // Comments contain rates: "CD1 - 85%  CD2 - 5%\r\nSATP - 32.5%"
  if (commentsStart >= 0) {
    let headerRow = -1;
    for (let r = commentsStart + 1; r < Math.min(commentsStart + 3, sheetData.length); r++) {
      if (/^cluster$/i.test(cleanString(sheetData[r]?.[0] || ''))) { headerRow = r; break; }
    }
    if (headerRow >= 0) {
      for (let r = headerRow + 1; r < sheetData.length; r++) {
        const row = sheetData[r];
        if (!row || !String(row[0] || '').trim()) break;
        if (/^(note|additional)/i.test(String(row[0]).trim())) break;

        const cluster        = cleanString(row[0]);
        const segment        = cleanString(row[1]);
        const commentProduct = cleanString(row[2]);
        const comments       = String(row[3] || '').trim();

        const { vehicleCategory, makeNote } = parseCommentProduct(commentProduct);
        const prefix = bodyTypePrefix(vehicleCategory);

        const entries = parseRateEntryText(comments);
        const classified = classifyProduct(segment, product, meta.sheetName);
        const weightBand = parseWeightBand(segment);
        const vehicleAge = parseVehicleAgeFromSegment(segment);

        for (const entry of entries) {
          const fullRateType = entry.rate_type
            ? buildFullRateType(prefix, entry.rate_type)
            : '';

          rules.push({
            insurer: meta.insurer,
            product: classified.product,
            sheet_name: meta.sheetName,
            region: cluster, segment,
            make: makeNote || '',
            model: '', sub_type: '', fuel_type: '',
            cc_band_min: null, cc_band_max: null,
            weight_band_min: weightBand.min, weight_band_max: weightBand.max,
            age_band_min: null, age_band_max: null,
            vehicle_age_min: vehicleAge.min, vehicle_age_max: vehicleAge.max,
            seating_capacity_min: null, seating_capacity_max: null,
            volume_tier: '', addon: '',
            carrier_type: vehicleCategory,
            _vehicle_category: vehicleCategory,
            remarks: 'Additional Comment: ' + commentProduct,
            rate_type: fullRateType,
            rate_value: entry.rate_value,
            is_declined: entry.is_declined || false,
            rate_text: null,
            is_conditional: false,
          });
        }
      }
    }
  }

  return rules;
}

/**
 * @param {Array<Array>} sheetData
 * @param {object} sheetConfig
 * @param {object} meta - { insurer, rateCardId, sheetName }
 * @returns {Array<object>}
 */
function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const {
    product,
    data_start_row,
    data_end_row,
    column_map,
    rate_type = '',
    decline_markers = [],
    extra_rate_columns = [],
    rate_columns = [],
    skip_header_rows = false,
    // Sheet-level "fixed rate" cells. Each entry reads a value from a
    // single cell once at parse start and emits a rule with that value
    // for every data row. Used for Royal School Bus where "Brokerage: 50%"
    // sits in cell B4 and applies as the OD rate for every state below.
    //
    // Config shape:
    //   "fixed_rate_columns": [
    //     {
    //       "rate_type": "TP_BAC_OD",
    //       "value_cell_row": 3, "value_cell_col": 1,
    //       "segment": "School Bus"
    //     }
    //   ]
    //
    // The fixed rule shares region / segment / sub_type with the per-row
    // rule from the regular rate_columns so the OD+TP pair-merger in the
    // export combines them onto a single Excel row.
    fixed_rate_columns = [],
  } = sheetConfig;

  const cm = column_map;

  // Resolve fixed-rate values once per sheet.
  const resolvedFixedRates = [];
  for (const f of fixed_rate_columns) {
    const r = f.value_cell_row;
    const c = f.value_cell_col;
    if (r == null || c == null) continue;
    const cell = (sheetData[r] || [])[c];
    const norm = normalizeRate(cell, decline_markers);
    if (norm && norm.rate_value != null && !norm.is_declined) {
      resolvedFixedRates.push({
        rate_type: f.rate_type || 'OD',
        rate_value: norm.rate_value,
        rate_text: norm.rate_text,
        segment: f.segment,
        make: f.make,
        sub_type: f.sub_type,
        fuel_type: f.fuel_type,
      });
    }
  }

  // Detect header text for skipping repeated header blocks (e.g. Taxi sheet)
  const headerRow = sheetData[sheetConfig.header_row] || [];
  const headerFirstCell = headerRow[0] ? cleanString(headerRow[0]) : '';

  const endRow = data_end_row || sheetData.length;

  // When additional_sections is configured, stop main grid parsing at the first
  // "Additional Notes:" or "Additional Comments:" marker row.
  let effectiveEndRow = endRow;
  if (sheetConfig.additional_sections) {
    for (let r = data_start_row; r < endRow; r++) {
      const cell = String(sheetData[r]?.[0] || '').trim();
      if (/^Additional\s+(Notes|Comments)/i.test(cell)) {
        effectiveEndRow = r;
        break;
      }
    }
  }

  // Section markers: scan all rows once, finding sections and their starting row indices
  const sectionMarkers = sheetConfig.section_markers || [];
  const sectionSpans = []; // [{ startRow, marker }]
  if (sectionMarkers.length > 0) {
    for (let r = 0; r < effectiveEndRow; r++) {
      const row = sheetData[r];
      if (!row) continue;
      const rowText = row.map(c => String(c || '')).join(' ');
      for (const marker of sectionMarkers) {
        if (new RegExp(marker.pattern, 'i').test(rowText)) {
          sectionSpans.push({ startRow: r, marker });
          break;
        }
      }
    }
  }
  const findActiveSection = (rowIdx) => {
    let active = null;
    for (const span of sectionSpans) {
      if (span.startRow <= rowIdx) active = span.marker;
      else break;
    }
    return active;
  };

  // Carry-down state: when a row has blank region/segment/make but the previous
  // data row had a value (merged-cell pattern), reuse it. Opt-in via config.
  const regionCarriesDown = sheetConfig.region_carries_down === true;
  const makeCarriesDown = sheetConfig.make_carries_down === true;
  let lastRegion = '';
  let lastMake = '';

  // RTO-code override notes — same shape as in pivot_by_city.  When a row's
  // region matches a "<Cluster> RTO's - <codes>" sheet note, those codes
  // are attached as an "Only for ..." hint in remarks.
  const rtoOverrideNotes = (function scanRtoNotes() {
    const map = new Map();
    // Apostrophe class includes ASCII ' and curly U+2019 (Excel often
    // substitutes the curly variant — Royal Pan India CV STP uses it).
    const re = /\b([A-Za-z][A-Za-z &-]{0,40}?)\s*RTO['’s]*\s*[-:]\s*((?:[A-Z]{2}\d{1,3})(?:\s*,\s*[A-Z]{2}\d{1,3}){0,30})/i;
    for (const row of sheetData) {
      if (!row) continue;
      for (const cell of row) {
        const s = String(cell || '');
        if (!s) continue;
        const m = s.match(re);
        if (!m) continue;
        const name = m[1].replace(/\s+/g, ' ').trim().toLowerCase()
          .replace(/^(?:the|for|of)\s+/i, '').replace(/[^a-z0-9]+$/g, '');
        const codes = m[2].split(/\s*,\s*/).map(c => c.trim().toUpperCase()).filter(Boolean);
        if (name && codes.length > 0) {
          const existing = map.get(name);
          if (existing) {
            for (const cc of codes) if (!existing.includes(cc)) existing.push(cc);
          } else {
            map.set(name, codes);
          }
        }
      }
    }
    return map;
  })();

  // Generic carry-forward: a list of column indices whose blank cells should
  // inherit from the most recent non-blank cell in that column. Used when an
  // upstream Excel file relies on visually-merged cells (Royal "New Car" puts
  // Makes + Incentive only on the first row of a 5-row vehicle group).
  const carryForwardCols = Array.isArray(sheetConfig.carry_forward_columns)
    ? sheetConfig.carry_forward_columns.map(n => parseInt(n, 10)).filter(Number.isFinite)
    : [];
  if (carryForwardCols.length > 0) {
    const lastByCol = new Map();
    const start = data_start_row;
    const end = Math.min(effectiveEndRow, sheetData.length);
    for (let r = start; r < end; r++) {
      const row = sheetData[r];
      if (!row) continue;
      for (const c of carryForwardCols) {
        const v = row[c];
        const isBlank = v === undefined || v === null || String(v).trim() === '';
        if (!isBlank) {
          lastByCol.set(c, v);
        } else if (lastByCol.has(c)) {
          row[c] = lastByCol.get(c);
        }
      }
    }
  }

  for (let r = data_start_row; r < effectiveEndRow; r++) {
    const row = sheetData[r];
    if (!row || row.length === 0) continue;

    // Skip repeated header rows embedded in data
    if (skip_header_rows || headerFirstCell) {
      const firstCell = cleanString(row[0]);
      if (firstCell && firstCell === headerFirstCell) continue;
    }

    // Determine active section marker for this row
    const activeSection = findActiveSection(r);

    // Extract mapped values
    let region = cm.region != null ? cleanString(row[cm.region]) : '';
    if (regionCarriesDown) {
      if (region) lastRegion = region;
      else region = lastRegion;
    }
    const segment = cm.segment != null ? cleanString(row[cm.segment]) : '';
    let make = cm.make != null ? cleanString(row[cm.make]) : '';
    if (makeCarriesDown) {
      if (make) lastMake = make;
      else make = lastMake;
    }
    const model = cm.model != null ? cleanString(row[cm.model]) : '';
    const subType = cm.sub_type != null ? cleanString(row[cm.sub_type]) : '';
    const fuelType = cm.fuel_type != null ? cleanString(row[cm.fuel_type]) : '';
    const addon = cm.addon != null ? cleanString(row[cm.addon]) : '';
    const carrierType = cm.carrier_type != null ? cleanString(row[cm.carrier_type]) : '';
    const volumeTier = cm.volume_tier != null ? cleanString(row[cm.volume_tier]) : '';
    const remarks1 = cm.remarks != null ? cleanString(row[cm.remarks]) : '';
    const remarks2 = cm.remarks_2 != null ? cleanString(row[cm.remarks_2]) : '';
    let remarks = [remarks1, remarks2].filter(Boolean).join(' | ');

    // RTO-code override from sheet notes — append "Only for X, Y" hint
    // when the row's region matches a "<Cluster> RTO's - <codes>" note.
    // Trailing punctuation/markers ("Vijayawada*") are stripped so the
    // lookup still matches the note's name.
    const ovKey = String(region || '').toLowerCase().trim().replace(/[^a-z0-9]+$/g, '');
    const ovCodes = rtoOverrideNotes.get(ovKey);
    if (ovCodes && ovCodes.length > 0) {
      const ovHint = `Only for ${ovCodes.join(', ')}`;
      remarks = remarks ? `${remarks} | ${ovHint}` : ovHint;
    }

    // Skip rows where all key fields are empty
    // EXCEPT when a rate_column carries its own region/segment override AND has
    // a non-empty cell — those rows (e.g. Royal "EV 3w Comp") have no anchor
    // cells in column_map but still produce valid rules per rate_column.
    if (!region && !segment && !make) {
      const hasRateColAnchor = rate_columns.some(rc =>
        (rc.region || rc.segment) &&
        row[rc.column] !== undefined && row[rc.column] !== null && String(row[rc.column]).trim() !== ''
      );
      if (!hasRateColAnchor) continue;
    }

    // Parse bands from text fields
    const ageBandText = cm.age_band != null ? cleanString(row[cm.age_band]) : '';
    const ageBand = ageBandText ? parseAgeBand(ageBandText) : { min: null, max: null };

    const ccBandText = cm.cc_band != null ? cleanString(row[cm.cc_band]) : '';
    const ccBand = ccBandText ? parseCCBand(ccBandText) : { min: null, max: null };

    // Parse CC from segment text when no dedicated column (e.g. "Taxi upto 5 seater Electric < 1000 cc")
    if (ccBand.min === null && ccBand.max === null && segment) {
      const segCC = parseCCBand(segment);
      ccBand.min = segCC.min;
      ccBand.max = segCC.max;
    }

    const weightBandText = cm.weight_band != null ? cleanString(row[cm.weight_band]) : '';
    const weightBand = weightBandText ? parseWeightBand(weightBandText) : { min: null, max: null };

    const vehicleAgeText = cm.vehicle_age != null ? cleanString(row[cm.vehicle_age]) : '';
    let vehicleAge = vehicleAgeText ? parseAgeBand(vehicleAgeText) : { min: null, max: null };

    // Support separate age_from / age_to columns (e.g. HCV GRID)
    if (cm.age_from != null && cm.age_to != null) {
      const ageFrom = row[cm.age_from];
      const ageTo = row[cm.age_to];
      if (ageFrom !== '' && ageFrom !== null && ageFrom !== undefined) {
        vehicleAge = {
          min: parseInt(ageFrom, 10) || 0,
          max: ageTo !== '' && ageTo !== null && ageTo !== undefined ? parseInt(ageTo, 10) : null,
        };
      }
    }

    // Parse seating capacity: prefer dedicated column, fall back to segment text
    let seatingCapacity;
    if (cm.seating_capacity != null) {
      const seatText = cleanString(row[cm.seating_capacity]);
      seatingCapacity = seatText ? parseSeatingCapacity(seatText) : { min: null, max: null };
    } else {
      seatingCapacity = parseSeatingCapacity(segment);
    }
    const resolvedFuel = fuelType || parseFuelTypeFromSegment(segment);

    // For GCV segments, parse weight band and vehicle age from segment text
    // when not already provided by dedicated columns
    const classified = classifyProduct(segment, product, meta.sheetName);
    if (classified.product === 'GCV') {
      if (weightBand.min === null && weightBand.max === null) {
        const wb = parseWeightBand(segment);
        weightBand.min = wb.min;
        weightBand.max = wb.max;
      }
      if (vehicleAge.min === null && vehicleAge.max === null) {
        const va = parseVehicleAgeFromSegment(segment);
        vehicleAge.min = va.min;
        vehicleAge.max = va.max;
      }
    }
    // Apply section marker overrides: vehicle_type (→ product), seating defaults, category
    // The vehicle_category is injected into segment as a prefix so it persists to DB.
    let sectionProduct = classified.product;
    let sectionSeatingMin = seatingCapacity.min;
    let sectionSeatingMax = seatingCapacity.max;
    let sectionSegment = segment;
    if (activeSection) {
      if (activeSection.vehicle_type) sectionProduct = activeSection.vehicle_type;
      // Only apply seating defaults when the row didn't already provide them
      if (sectionSeatingMin == null && activeSection.seating_min != null) sectionSeatingMin = activeSection.seating_min;
      if (sectionSeatingMax == null && activeSection.seating_max != null) sectionSeatingMax = activeSection.seating_max;
      // Prefix the vehicle_category to segment (e.g. "School Bus | Gujarat") so
      // inferVehicleCategory can read it back in the export
      if (activeSection.vehicle_category) {
        sectionSegment = sectionSegment
          ? `${activeSection.vehicle_category} | ${sectionSegment}`
          : activeSection.vehicle_category;
      }
    }

    // NOP / NEW-business parsing: "NEW(100-500 NOP)" / "NEW(30-100 NOP)" / "NEW(UPTO 30 NOP)"
    // sits in sub_type or volume_tier. Parse it, set vehicle age = 0 (brand new),
    // and stash the range in volume_tier for export-time Min/Max NOP columns.
    let effVolumeTier = volumeTier;
    let effVehicleAge = { min: vehicleAge.min, max: vehicleAge.max };
    const nopSource = [subType, volumeTier].find(v => /NEW\s*\(/i.test(v || '')) || '';
    if (nopSource) {
      const nop = parseNopRange(nopSource);
      if (nop) {
        // Stash as compact string the export can re-parse: "NOP 100-500" / "NOP upto 30"
        effVolumeTier = nop.min != null && nop.max != null
          ? `NOP ${nop.min}-${nop.max}`
          : nop.max != null
            ? `NOP upto ${nop.max}`
            : `NOP ${nop.min}+`;
        // NEW business → vehicle age 0
        if (effVehicleAge.min == null && effVehicleAge.max == null) {
          effVehicleAge = { min: 0, max: 0 };
        }
      }
    }

    const baseRule = {
      insurer: meta.insurer,
      product: sectionProduct,
      sheet_name: meta.sheetName,
      region, segment: sectionSegment, make, model, sub_type: subType,
      fuel_type: resolvedFuel,
      cc_band_min: ccBand.min, cc_band_max: ccBand.max,
      weight_band_min: weightBand.min, weight_band_max: weightBand.max,
      age_band_min: ageBand.min, age_band_max: ageBand.max,
      vehicle_age_min: effVehicleAge.min, vehicle_age_max: effVehicleAge.max,
      seating_capacity_min: sectionSeatingMin, seating_capacity_max: sectionSeatingMax,
      volume_tier: effVolumeTier, addon, carrier_type: carrierType, remarks,
    };

    // Primary rate column
    if (cm.rate_value != null) {
      const cellValue = row[cm.rate_value];
      const normalized = normalizeRate(cellValue, decline_markers);
      if (normalized) {
        rules.push({ ...baseRule, rate_type, ...normalized });
      }
    }

    // Extra rate columns (e.g. MAX_CD2_1, MAX_CD2_2). Supports the same
    // per-column overrides as `rate_columns` (make, segment, fuel_type,
    // owned_by, sub_type) so a single sheet entry can fan out to multiple
    // blocks each with their own segment / product context.
    for (const extra of extra_rate_columns) {
      const cellValue = row[extra.column];
      const normalized = normalizeRate(cellValue, decline_markers);
      if (normalized) {
        const overrides = { rate_type: extra.rate_type, ...normalized };
        if (extra.make)      overrides.make      = extra.make;
        if (extra.segment)   overrides.segment   = extra.segment;
        if (extra.fuel_type) overrides.fuel_type = extra.fuel_type;
        if (extra.owned_by)  overrides.sub_type  = extra.owned_by;
        if (extra.sub_type)  overrides.sub_type  = extra.sub_type;
        if (extra.region)    overrides.region    = extra.region;
        rules.push({ ...baseRule, ...overrides });
      }
    }

    // Optional: read a per-row Section Text column and prepend it to each
    // rate_columns[].rate_type. Lets one config emit "Package_OD",
    // "SAOD_OD", "SATP_TP" depending on which section the row belongs to,
    // instead of hard-coding "Comp_OD" everywhere.
    //
    // When the Section Text cell is literally "All", we keep the prefix
    // "All" (rather than dropping it) so the export pre-processor can
    // expand the rule into Comp / SAOD / TP variants.
    let rowPrefix = '';
    if (sheetConfig.rate_type_prefix_column != null) {
      const raw = row[sheetConfig.rate_type_prefix_column];
      const cleaned = String(raw == null ? '' : raw).trim();
      if (cleaned && !/^(na|n\/a|-)$/i.test(cleaned)) {
        rowPrefix = cleaned;
      }
    }

    // Optional: read a per-row NCB column and append "|NCB:<value>" to the
    // rate_type. Mirrors how pivot_by_city encodes NCB so inferNCB in the
    // export can detect Yes / No / numeric ranges uniformly.
    let ncbSuffix = '';
    if (sheetConfig.ncb_column != null) {
      const raw = row[sheetConfig.ncb_column];
      const cleaned = String(raw == null ? '' : raw).trim();
      if (cleaned && !/^(all|na|n\/a|-|any)$/i.test(cleaned)) {
        ncbSuffix = `|NCB:${cleaned}`;
      }
    }

    const applyPrefix = (rt) => {
      const base = rowPrefix ? `${rowPrefix}_${rt}` : rt;
      return ncbSuffix ? `${base}${ncbSuffix}` : base;
    };

    // rate_columns: used when there's no primary rate_value in column_map
    for (const rc of rate_columns) {
      const cellValue = row[rc.column];

      // If split_cd1_cd2 is enabled, try to split "CD1 X% / CD2 Y%" cells into two rules
      if (sheetConfig.split_cd1_cd2) {
        const split = splitCd1Cd2Cell(cellValue);
        if (split) {
          const rtBase = rc.rate_type.replace(/^COMP_/, '').replace(/_MAX_CD2$|_CD2$|_CD1$/, '');
          const cd1RateType = rtBase ? `${rtBase}_CD1` : 'CD1';
          const cd2RateType = rc.rate_type;
          const ovBase = { ...(rc.make ? { make: rc.make } : {}), ...(rc.owned_by ? { sub_type: rc.owned_by } : {}) };
          rules.push({ ...baseRule, rate_type: applyPrefix(cd1RateType), ...split.cd1, ...ovBase });
          rules.push({ ...baseRule, rate_type: applyPrefix(cd2RateType), ...split.cd2, ...ovBase });
          continue;
        }
      }

      // ICICI CV grid: cells like "M&M|NEW:37%,M&M|OLD:20%,OTHERS:0%" or
      // "COMP|TATA:28%,COMP|AL|>=10 yrs:28%,COMP|OTHERS:5%" → expand into
      // multiple rules (one per comma-separated chunk) with overrides for
      // Make / business_type / vehicle_age / rate_type_hint extracted from
      // the `|` tokens.  Bare "CC" chunks are skipped (CC Call).  Activated
      // by `parse_conditional_cells: true` on the sheet config.
      if (sheetConfig.parse_conditional_cells) {
        const condRules = parseConditionalRateCell(cellValue);
        if (condRules && condRules.length > 0) {
          const baseRt = applyPrefix(rc.rate_type);
          for (const cr of condRules) {
            const overrides = { rate_type: baseRt, ...cr };
            // Apply normal per-rate-column overrides on top of the cell-
            // derived ones so segment / make / fuel anchors still flow.
            if (rc.make && !overrides.make)         overrides.make      = rc.make;
            if (rc.owned_by && !overrides.sub_type) overrides.sub_type  = rc.owned_by;
            if (rc.segment)                         overrides.segment   = rc.segment;
            if (rc.fuel_type && !overrides.fuel_type) overrides.fuel_type = rc.fuel_type;
            if (rc.region && !overrides.region)     overrides.region    = rc.region;
            if (rc.applied_on && !overrides.applied_on) overrides.applied_on = rc.applied_on;
            if (rc.vehicle_age_min != null && overrides.vehicle_age_min == null) overrides.vehicle_age_min = rc.vehicle_age_min;
            if (rc.vehicle_age_max != null && overrides.vehicle_age_max == null) overrides.vehicle_age_max = rc.vehicle_age_max;
            // Strip helper hints from final rule object — convert
            // rate_type_hint to rate_type suffix; tuck rto_hint into remarks
            const hint = overrides.rate_type_hint;
            if (hint) {
              // Replace base rate_type when the cell explicitly states
              // COMP/TP/SAOD (e.g. col header is generic but cell says AOTP)
              overrides.rate_type = hint === 'COMP' ? `Comp${baseRt.startsWith('Comp') ? baseRt.slice(4) : ''}`
                                  : hint === 'TP'   ? 'TP'
                                  : hint === 'SAOD' ? 'SAOD'
                                  : overrides.rate_type;
            }
            delete overrides.rate_type_hint;
            const rtoHint = overrides.rto_hint;
            delete overrides.rto_hint;
            // business_type already encodes via remarks marker for export
            // BusinessType detection.  Add [NEW]/[ROLLOVER] tag in remarks.
            const bt = overrides.business_type;
            delete overrides.business_type;
            const tag = bt === 'New' ? '[NEW]' : bt === 'Rollover' ? '[ROLLOVER]' : '';
            const baseRemarks = baseRule.remarks || '';
            const extra = [tag, rtoHint ? `Only for ${rtoHint}` : '', rc.remarks || ''].filter(Boolean).join(' | ');
            overrides.remarks = [baseRemarks, extra].filter(Boolean).join(' | ');
            // Re-parse seating/CC/weight from segment override (same as
            // the regular path).
            if (rc.segment) {
              const seatFromOv = parseSeatingCapacity(rc.segment);
              if (seatFromOv.min != null || seatFromOv.max != null) {
                overrides.seating_capacity_min = seatFromOv.min;
                overrides.seating_capacity_max = seatFromOv.max;
              }
              const ccFromOv = parseCCBand(rc.segment);
              if (ccFromOv.min != null || ccFromOv.max != null) {
                overrides.cc_band_min = ccFromOv.min;
                overrides.cc_band_max = ccFromOv.max;
              }
              const wtFromOv = parseWeightBand(rc.segment);
              if (wtFromOv.min != null || wtFromOv.max != null) {
                overrides.weight_band_min = wtFromOv.min;
                overrides.weight_band_max = wtFromOv.max;
              }
            }
            rules.push({ ...baseRule, ...overrides });
          }
          continue;
        }
      }

      // If split_od_tp is enabled, try to split "X% on OD, Y% on TP" cells.
      // Emits two rules for the same rule context:
      //   - <base>_OD with rate_value = OD%, applied_on = "OD"
      //   - <base>_TP with rate_value = TP%, applied_on = "TP"
      // Both share the same segment / region / sub_type so the rule
      // matcher treats them as a paired pair.
      if (sheetConfig.split_od_tp) {
        const split = splitOdTpCell(cellValue);
        if (split) {
          const baseRt = applyPrefix(rc.rate_type);
          const ovBase = {};
          if (rc.make)      ovBase.make      = rc.make;
          if (rc.owned_by)  ovBase.sub_type  = rc.owned_by;
          if (rc.segment)   ovBase.segment   = rc.segment;
          if (rc.fuel_type) ovBase.fuel_type = rc.fuel_type;
          // Encode applied_on into rate_type so the export's inferAppliedOn
          // can pick it up (e.g. "Comp_OD" / "Comp_TP").
          rules.push({ ...baseRule, ...ovBase, rate_type: `${baseRt}_OD`, rate_value: split.od.rate_value, is_declined: false, rate_text: split.od.rate_text, is_conditional: false });
          rules.push({ ...baseRule, ...ovBase, rate_type: `${baseRt}_TP`, rate_value: split.tp.rate_value, is_declined: false, rate_text: split.tp.rate_text, is_conditional: false });
          continue;
        }
      }

      const normalized = normalizeRate(cellValue, decline_markers);
      if (normalized) {
        // Optional: drop rows where the rate is exactly 0 (TATA ROBINHOOD
        // emits 0 in either OD or TP depending on which section applies).
        if (sheetConfig.skip_zero_rates && normalized.rate_value === 0) continue;
        const overrides = { rate_type: applyPrefix(rc.rate_type), ...normalized };
        // Support make override from column config (e.g. column header contains make name)
        if (rc.make) overrides.make = rc.make;
        // Support owned_by from column config — store in sub_type for DB persistence
        if (rc.owned_by) overrides.sub_type = rc.owned_by;
        // Support segment override (e.g. column header "7 KW Bike" → segment carries CC+category)
        if (rc.segment) overrides.segment = rc.segment;
        // Support fuel_type override from column config (e.g. "Electric")
        if (rc.fuel_type) overrides.fuel_type = rc.fuel_type;
        // Support region override (e.g. EV 3w Comp blocks: "Pan India",
        // "Delhi NCR", "Tamil Nadu") so each rate column can pin its own
        // region when column_map has none.
        if (rc.region) overrides.region = rc.region;
        // Support applied_on override (e.g. ICICI Pvt Car: TP "Act only" is
        // applied on Net, Comp/SAOD with NCB>0% is applied on OD).  The
        // export reads `rule.applied_on` ahead of inferring from rate_type.
        if (rc.applied_on) overrides.applied_on = rc.applied_on;
        // Support vehicle age override (e.g. ICICI Pvt Car New 1+3/3+3
        // → vehicle_age 0–0 to mark brand-new policies).
        if (rc.vehicle_age_min != null) overrides.vehicle_age_min = rc.vehicle_age_min;
        if (rc.vehicle_age_max != null) overrides.vehicle_age_max = rc.vehicle_age_max;
        // Support remarks override (e.g. tag rows with NCB / business-type
        // markers like "[NEW]" / "[ROLLOVER]" so inferBusinessType picks
        // them up at export time without rewriting segment).
        if (rc.remarks) {
          overrides.remarks = baseRule.remarks
            ? `${baseRule.remarks} | ${rc.remarks}`
            : rc.remarks;
        }
        // Re-parse seating / CC / weight bands from the column's segment
        // override.  Many sheets only carry the descriptive segment
        // ("Taxi 4-6 Seater", "Pvt Car <1000CC", "Bike <150CC") on the
        // rate column itself — without this re-parse, the band fields
        // stay null because the row-level segment was empty.
        if (rc.segment) {
          const seatFromOv = parseSeatingCapacity(rc.segment);
          if (seatFromOv.min != null || seatFromOv.max != null) {
            overrides.seating_capacity_min = seatFromOv.min;
            overrides.seating_capacity_max = seatFromOv.max;
          }
          const ccFromOv = parseCCBand(rc.segment);
          if (ccFromOv.min != null || ccFromOv.max != null) {
            overrides.cc_band_min = ccFromOv.min;
            overrides.cc_band_max = ccFromOv.max;
          }
          const wtFromOv = parseWeightBand(rc.segment);
          if (wtFromOv.min != null || wtFromOv.max != null) {
            overrides.weight_band_min = wtFromOv.min;
            overrides.weight_band_max = wtFromOv.max;
          }
        }
        rules.push({ ...baseRule, ...overrides });
      }

      // Emit fixed-rate rules (constants from a single sheet cell) for
      // each data row so the OD+TP pair-merger can combine them with the
      // matching per-row rate. The rule shares context (region / segment
      // / sub_type) with the regular rules so they pair cleanly.
      for (const fx of resolvedFixedRates) {
        const overrides = { rate_type: applyPrefix(fx.rate_type), rate_value: fx.rate_value, rate_text: fx.rate_text, is_declined: false, is_conditional: false };
        if (fx.make)      overrides.make      = fx.make;
        if (fx.segment)   overrides.segment   = fx.segment;
        if (fx.sub_type)  overrides.sub_type  = fx.sub_type;
        if (fx.fuel_type) overrides.fuel_type = fx.fuel_type;
        rules.push({ ...baseRule, ...overrides });
      }
    }
  }

  // Parse Additional Notes / Additional Comments sections below the main grid
  if (sheetConfig.additional_sections) {
    rules.push(...parseAdditionalSections(sheetData, sheetConfig, meta));
  }

  // Sheet-level notes: scan text in rows (typically below grid) for phrases that
  // apply constraints to ALL rules in the sheet. Currently supported:
  //   "Above Grid is applicable for Non-Electric Bus" → fuel_type = Petrol / Diesel / CNG
  //   "Only for Electric" / "Electric Only" → fuel_type = Electric
  const sheetFuelHint = detectSheetFuelHint(sheetData);
  if (sheetFuelHint) {
    for (const r of rules) {
      // Only override when the rule doesn't already have a fuel type
      if (!r.fuel_type) r.fuel_type = sheetFuelHint;
    }
  }

  return rules;
}

/**
 * Scan all rows of a sheet for note text that hints at fuel-type restrictions.
 * Returns a normalized fuel-type string (multi-fuel strings are "/" separated)
 * or null when no hint is found.
 */
function detectSheetFuelHint(sheetData) {
  // First pass: look for title-style "Electric" markers in the top 5 rows
  // (e.g. "TW Electric" banner, "All Electric Make" header) — these hint that
  // the ENTIRE sheet / grid applies to Electric vehicles.
  const topRows = sheetData.slice(0, 5);
  for (const row of topRows) {
    if (!row) continue;
    // Skip rows that are clearly fuel-type sub-header rows (sibling fuel
    // names share the row, e.g. ICICI Pvt Car header carries
    // "Petrol | CNG | Diesel | Electric" across columns).  The "Electric"
    // here is a column label, not a sheet-wide marker.
    const labels = row.map(c => String(c || '').trim().toUpperCase()).filter(Boolean);
    const hasOtherFuel = labels.some(l => /^(PETROL|DIESEL|CNG|LPG|HYBRID)$/.test(l));
    if (hasOtherFuel) continue;
    for (const cell of row) {
      const c = String(cell || '').trim();
      if (!c) continue;
      // Standalone title cell: "TW Electric", "Electric", "Electric Vehicle", "EV Grid"
      if (/^(tw\s+electric|electric(\s+vehicles?)?|ev\s+grid|all\s+electric(\s+make)?)$/i.test(c)) {
        return 'Electric';
      }
    }
  }

  // Second pass: notes / narrative text anywhere in the sheet
  for (const row of sheetData) {
    if (!row) continue;
    const txt = row.map(c => String(c || '')).join(' ').trim();
    if (!txt) continue;
    // "Non-Electric Bus" / "Non Electric" → Petrol, Diesel, CNG (not Electric)
    if (/non[\s-]?electric/i.test(txt)) {
      return 'Petrol / Diesel / CNG';
    }
    // "Only for Electric" / "Electric only" / "Electric vehicles only"
    if (/(only\s+for\s+electric|electric\s+only|electric\s+vehicles?\s+only|applicable\s+for\s+electric)/i.test(txt)) {
      return 'Electric';
    }
  }
  return null;
}

/**
 * Parse "NEW(100-500 NOP)" / "NEW(30-100 NOP)" / "NEW(UPTO 30 NOP)" → {min, max}.
 * Returns null if no NOP pattern is found.
 */
function parseNopRange(text) {
  const s = String(text || '').toUpperCase();
  if (!/NOP/.test(s)) return null;
  // "UPTO N NOP" / "UP TO N NOP" / "<= N NOP"
  let m = s.match(/(?:UP\s*TO|UPTO|<=?)\s*(\d+)\s*NOP/);
  if (m) return { min: null, max: parseInt(m[1], 10) };
  // "A-B NOP" / "A TO B NOP"
  m = s.match(/(\d+)\s*(?:-|TO|–)\s*(\d+)\s*NOP/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  // ">= N NOP" / "> N NOP" / "N+ NOP"
  m = s.match(/(?:>=?|ABOVE)\s*(\d+)\s*NOP/);
  if (m) return { min: parseInt(m[1], 10), max: null };
  m = s.match(/(\d+)\s*\+\s*NOP/);
  if (m) return { min: parseInt(m[1], 10), max: null };
  // Single value: "N NOP"
  m = s.match(/(\d+)\s*NOP/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
  return null;
}

module.exports = { parse, parseNopRange };
