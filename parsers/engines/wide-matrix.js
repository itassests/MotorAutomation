/**
 * Wide-matrix parser engine.
 *
 * Used for sheets like Digit CV where regions are laid out as column groups,
 * each group containing multiple sub-columns (e.g. CD1, CD2 Comp, CD2 TP).
 * Rows represent vehicle segments with make/carrier details.
 *
 * Config shape:
 * {
 *   layout: "wide_matrix",
 *   product: "CV",
 *   header_rows: { region_row: 0, rate_type_row: 2, sub_column_row: 3 },
 *   data_start_row: 4,
 *   key_columns: { segment: 0, make: 1, carrier_type: 2 },
 *   region_groups: { start_col: 3, cols_per_region: 3, sub_columns: ["CD1", "CD2_OD", "CD2_TP"] },
 *   decline_markers: ["D"]
 * }
 */

const { normalizeRate, cleanString, parseWeightBand, parseCCBand, parseSeatingCapacity, parseFuelTypeFromSegment, parseVehicleAgeFromSegment } = require('../utils/normalizer');
const { classifyProduct } = require('../utils/product-classifier');

/**
 * @param {Array<Array>} sheetData - Raw rows from xlsx
 * @param {object} sheetConfig - Config for this sheet
 * @param {object} meta - { insurer, rateCardId, sheetName }
 * @returns {Array<object>} Normalized rule objects
 */
function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const {
    product,
    header_rows,
    data_start_row,
    key_columns,
    region_groups,
    decline_markers = [],
  } = sheetConfig;

  const regionRow = sheetData[header_rows.region_row] || [];
  const rateTypeRow = header_rows.rate_type_row != null
    ? (sheetData[header_rows.rate_type_row] || [])
    : [];
  const subColRow = header_rows.sub_column_row != null
    ? (sheetData[header_rows.sub_column_row] || [])
    : [];

  const { start_col, cols_per_region, sub_columns } = region_groups;

  // Discover regions by scanning the region row at every Nth column
  const regions = [];
  let lastRegion = '';
  for (let col = start_col; col < regionRow.length; col += cols_per_region) {
    const regionName = cleanString(regionRow[col]);
    if (regionName) lastRegion = regionName;
    regions.push(lastRegion);
  }

  // Process each data row
  for (let r = data_start_row; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row || row.length === 0) continue;

    const segment = cleanString(row[key_columns.segment]);
    const make = key_columns.make != null ? cleanString(row[key_columns.make]) : '';
    const carrierType = key_columns.carrier_type != null ? cleanString(row[key_columns.carrier_type]) : '';

    // Skip rows where segment is empty (likely a blank or separator row)
    if (!segment) continue;

    const weightBand = parseWeightBand(segment);
    const ccBand = parseCCBand(segment);
    const seatingCapacity = parseSeatingCapacity(segment);
    const resolvedFuel = parseFuelTypeFromSegment(segment);

    // For GCV segments, parse vehicle age from segment text
    const preClassified = classifyProduct(segment, product, meta.sheetName);
    const vehicleAge = preClassified.product === 'GCV'
      ? parseVehicleAgeFromSegment(segment)
      : { min: null, max: null };

    // Iterate over each region group
    for (let gi = 0; gi < regions.length; gi++) {
      const region = regions[gi];
      const baseCol = start_col + gi * cols_per_region;

      // Iterate over each sub-column within the group
      for (let si = 0; si < sub_columns.length; si++) {
        const col = baseCol + si;
        if (col >= row.length) continue;

        const cellValue = row[col];
        const normalized = normalizeRate(cellValue, decline_markers);
        if (!normalized) continue; // skip empty cells

        // Determine rate_type from sub-column name or rate_type_row
        let rateType = sub_columns[si] || '';
        if (rateTypeRow[col]) {
          rateType = cleanString(rateTypeRow[col]) || rateType;
        }

        const classified = classifyProduct(segment, product, meta.sheetName);

        rules.push({
          insurer: meta.insurer,
          product: classified.product,
          sheet_name: meta.sheetName,
          region: region,
          segment: segment,
          make: make,
          model: '',
          sub_type: '',
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
          carrier_type: carrierType,
          rate_type: rateType,
          rate_value: normalized.rate_value,
          is_declined: normalized.is_declined,
          rate_text: normalized.rate_text,
          is_conditional: normalized.is_conditional,
        });
      }
    }
  }

  return rules;
}

module.exports = { parse };
