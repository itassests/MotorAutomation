/**
 * Grouped-columns parser engine.
 *
 * Used for sheets like Chola GCCV, PC where:
 *   - Rows describe product/subclass/make/model
 *   - Columns are region pairs, each region having multiple rate types
 *     (e.g. ACT + PACK per region)
 *
 * Config shape:
 * {
 *   layout: "grouped_columns",
 *   product: "CV",
 *   header_rows: { region_row: 0, rate_type_row: 1 },
 *   data_start_row: 2,
 *   key_columns: { product: 0, subclass: 1, make: 2, model: 3 },
 *   region_groups: [
 *     { region: "AP/TS", columns: { ACT: 3, PACK: 4 } },
 *     { region: "KA",    columns: { ACT: 5, PACK: 6 } },
 *     ...
 *   ],
 *   decline_markers: ["NA", ""]
 * }
 */

const { normalizeRate, cleanString, parseWeightBand, parseCCBand, parseSeatingCapacity, parseFuelTypeFromSegment, parseVehicleAgeFromSegment } = require('../utils/normalizer');
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
    key_columns,
    region_groups,
    decline_markers = [],
  } = sheetConfig;

  const kc = key_columns;

  // Carry-down trackers for merged/blank cells in key columns
  let lastProductField = '';
  let lastMake = '';
  let lastModel = '';

  for (let r = data_start_row; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row || row.length === 0) continue;

    // Extract row key fields (with carry-down for merged product/make/model cells)
    let productField = kc.product != null ? cleanString(row[kc.product]) : product;
    if (kc.product != null) {
      if (productField) lastProductField = productField;
      else productField = lastProductField;
    }
    const subclass = kc.subclass != null ? cleanString(row[kc.subclass]) : '';
    let make = kc.make != null ? cleanString(row[kc.make]) : '';
    if (kc.make != null) {
      if (make) lastMake = make;
      else make = lastMake;
    }
    let model = kc.model != null ? cleanString(row[kc.model]) : '';
    if (kc.model != null) {
      if (model) lastModel = model;
      else model = lastModel;
    }
    // Normalize productField to single-line for downstream tagging (e.g. "PC\r\n[SOD]\r\n" → "PC [SOD]")
    const productTag = String(productField || '').replace(/\s+/g, ' ').trim();
    const segment = kc.segment != null ? cleanString(row[kc.segment]) : subclass;
    const fuelType = kc.fuel_type != null ? cleanString(row[kc.fuel_type]) : '';
    const carrierType = kc.carrier_type != null ? cleanString(row[kc.carrier_type]) : '';

    // Skip rows where all key columns are empty
    const hasContent = [productField, subclass, make, model, segment].some(Boolean);
    if (!hasContent) continue;

    // Parse bands from segment / subclass descriptors
    const weightBand = parseWeightBand(segment || subclass);
    const ccBand = parseCCBand(segment || subclass);
    const seatingCapacity = parseSeatingCapacity(segment || subclass);
    const resolvedFuel = fuelType || parseFuelTypeFromSegment(segment || subclass);

    // For GCV segments, also parse vehicle age from segment text
    const segText = segment || subclass;
    const preClassified = classifyProduct(segText, productField || product, meta.sheetName);
    const vehicleAge = preClassified.product === 'GCV'
      ? parseVehicleAgeFromSegment(segText)
      : { min: null, max: null };

    // Iterate over region groups
    for (const rg of region_groups) {
      const region = rg.region;
      const columns = rg.columns; // e.g. { ACT: 3, PACK: 4 }

      for (const [rateType, col] of Object.entries(columns)) {
        if (col >= row.length) continue;

        const cellValue = row[col];
        const normalized = normalizeRate(cellValue, decline_markers);
        if (!normalized) continue;

        const classified = classifyProduct(segment || subclass, productField || product, meta.sheetName);

        rules.push({
          insurer: meta.insurer,
          product: classified.product,
          sheet_name: meta.sheetName,
          region: region,
          segment: segment || subclass,
          make: make,
          model: model,
          sub_type: productTag,
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
