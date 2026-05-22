/**
 * Cross-tab parser engine.
 *
 * Used for sheets like Chola TW where:
 *   - Rows have state/region + sub_type (NEW/SOD/ANNUAL/ACT)
 *   - Columns are Make x Segment combinations (Hero 150cc, Hero Scooter, etc.)
 *   - Region value "carries down" — it is only printed once and applies to
 *     subsequent rows until a new region appears.
 *
 * Config shape:
 * {
 *   layout: "cross_tab",
 *   product: "TW",
 *   header_rows: { make_row: 0, segment_row: 1 },
 *   data_start_row: 2,
 *   row_keys: { region: 0, sub_type: 1 },
 *   column_groups: [
 *     { make: "Hero OEM", start_col: 2, segments: ["150cc", "SCOOTER", "150_350cc", "350cc"] },
 *     ...
 *   ],
 *   decline_markers: ["NA"],
 *   region_carries_down: true
 * }
 */

const { normalizeRate, cleanString, parseCCBand, parseWeightBand, parseSeatingCapacity, parseFuelTypeFromSegment, parseVehicleAgeFromSegment } = require('../utils/normalizer');
const { classifyProduct } = require('../utils/product-classifier');

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
    row_keys,
    column_groups,
    decline_markers = [],
    region_carries_down = false,
  } = sheetConfig;

  // Build a flat map of column index → { make, segment }
  const colMap = new Map();
  for (const group of column_groups) {
    for (let i = 0; i < group.segments.length; i++) {
      colMap.set(group.start_col + i, {
        make: group.make,
        segment: group.segments[i],
      });
    }
  }

  let currentRegion = '';

  for (let r = data_start_row; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row || row.length === 0) continue;

    // Extract row keys
    const regionCell = row_keys.region != null ? cleanString(row[row_keys.region]) : '';
    const subType = row_keys.sub_type != null ? cleanString(row[row_keys.sub_type]) : '';

    // Update carried-down region
    if (regionCell) {
      currentRegion = regionCell;
    }
    const region = region_carries_down ? currentRegion : regionCell;

    // Skip rows where both keys are empty (separator rows)
    if (!region && !subType) continue;

    // Iterate over each column group entry
    for (const [col, info] of colMap) {
      if (col >= row.length) continue;

      const cellValue = row[col];
      const normalized = normalizeRate(cellValue, decline_markers);
      if (!normalized) continue;

      const ccBand = parseCCBand(info.segment);
      const seatingCapacity = parseSeatingCapacity(info.segment);
      const resolvedFuel = parseFuelTypeFromSegment(info.segment);

      const classified = classifyProduct(info.segment, product, meta.sheetName);

      // For GCV segments, parse weight band and vehicle age from segment text
      const weightBand = classified.product === 'GCV'
        ? parseWeightBand(info.segment)
        : { min: null, max: null };
      const vehicleAge = classified.product === 'GCV'
        ? parseVehicleAgeFromSegment(info.segment)
        : { min: null, max: null };

      rules.push({
        insurer: meta.insurer,
        product: classified.product,
        sheet_name: meta.sheetName,
        region: region,
        segment: info.segment,
        make: info.make,
        model: '',
        sub_type: subType,
        fuel_type: resolvedFuel,
        cc_band_min: ccBand.min,
        cc_band_max: ccBand.max,
        weight_band_min: weightBand.min,
        weight_band_max: weightBand.max,
        age_band_min: null,
        age_band_max: null,
        vehicle_age_min: vehicleAge.min,
        vehicle_age_max: vehicleAge.max,
        seating_capacity_min: seatingCapacity.min,
        seating_capacity_max: seatingCapacity.max,
        volume_tier: '',
        addon: '',
        carrier_type: '',
        rate_type: subType,
        rate_value: normalized.rate_value,
        is_declined: normalized.is_declined,
        rate_text: normalized.rate_text,
        is_conditional: normalized.is_conditional,
      });
    }
  }

  return rules;
}

module.exports = { parse };
