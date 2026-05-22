/**
 * Liberty broker grid parser.
 *
 * Liberty's "Robinhood" rate file is a wide cross-tab where:
 *   - Rows are state-cluster regions ("ANDHRA PRADESH - 1 KV", "TELANGANA - 2 R")
 *     in the first column.
 *   - Columns are (product/segment × age-or-cc-band × OD-or-SATP) tuples.
 *   - Each cell is a flat rate %. Zero means declined / not offered.
 *
 * Six motor sheets share the same skeleton; each sheet's own
 * column→(product, sub_type, weight/cc/seating, age, ins_product) mapping is
 * declared in config/insurers/liberty.json under `column_groups`. This engine
 * just consumes the declarative map and emits one rule per non-empty cell.
 *
 * Region-cluster join key: the rate sheet's first-column value
 * ("ANDHRA PRADESH - 1 KV") matches the cluster column in the RTO mapping
 * file (Geo Cluster sheet). Loaded via the existing rto_mapping engine.
 */

const { cleanString, normalizeRate } = require('../utils/normalizer');

const APPLIED_TO_INS = {
  OD:  'Comp',
  SATP: 'TP',
  SAOD: 'SAOD',
  TP:   'TP',
};

/** Compose a rate_type tag that survives the Comp/SAOD/TP pattern match
 *  in services/rate-lookup.js. We use:
 *    Comp → 'PACK_LIBERTY'
 *    TP   → 'SATP_LIBERTY'
 *    SAOD → 'SAOD_LIBERTY'
 *  Optional nilDep ('Yes' | 'No') appends '_NilDep' / '_NoNilDep' so the
 *  export's inferNilDepFlag picks it up for the dedicated 'Nil Dep' column. */
function _composeRateType(insProduct, appliedOn, nilDep) {
  let prefix;
  switch (insProduct) {
    case 'Comp': prefix = 'PACK_LIBERTY'; break;
    case 'TP':   prefix = 'SATP_LIBERTY'; break;
    case 'SAOD': prefix = 'SAOD_LIBERTY'; break;
    default:     prefix = 'PACK_LIBERTY';
  }
  let out = prefix;
  if (appliedOn) out += '_' + appliedOn;
  // NilDep tag goes AFTER applied_on so the export's
  //   /(?:^|_)NoNilDep\b/i  /(?:^|_)NilDep\b/i
  // regexes (which require a word boundary after) match at end-of-string.
  if (nilDep === 'Yes') out += '_NilDep';
  else if (nilDep === 'No') out += '_NoNilDep';
  return out;
}

function _parseRateCell(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim();
  if (!s || s === '-' || /^na$/i.test(s) || /^decline/i.test(s)) {
    return { is_declined: true };
  }
  const n = normalizeRate(s);
  return n;
}

/**
 * @param {Array<Array>} sheetData
 * @param {object} sheetConfig - {
 *     product, data_start_row, region_col,
 *     column_groups: [{
 *       ins_product, applied_on?, sub_type?, fuel_type?,
 *       weight_band_min?, weight_band_max?,
 *       cc_band_min?, cc_band_max?,
 *       seating_capacity_min?, seating_capacity_max?,
 *       start_col, ages: [{min, max}], variant_label?
 *     }]
 *   }
 * @param {object} meta - { insurer, rateCardId, sheetName }
 */
function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row : 2;
  const regionCol = sheetConfig.region_col != null ? sheetConfig.region_col : 0;
  const product   = sheetConfig.product;
  const groups    = sheetConfig.column_groups || [];

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r] || [];
    const region = cleanString(row[regionCol]);
    if (!region) continue;

    for (const grp of groups) {
      // Each group describes a contiguous block of columns starting at
      // start_col. ages[] (or a single label) defines what each column means.
      const ages = Array.isArray(grp.ages) && grp.ages.length > 0
        ? grp.ages
        : [null]; // singleton → one column, no age band attached

      for (let i = 0; i < ages.length; i++) {
        const col = grp.start_col + i;
        const cellRaw = row[col];
        const parsed = _parseRateCell(cellRaw);
        if (parsed == null) continue;

        const ageBand = ages[i];
        // ins_products array form lets one column group emit several
        // ins_products from one rate (e.g. "Non Addon (Comp & SOD)" → both
        // Comp and SAOD). Falls back to the singular ins_product field.
        const insProductList = Array.isArray(grp.ins_products) && grp.ins_products.length > 0
          ? grp.ins_products
          : [grp.ins_product || APPLIED_TO_INS[grp.applied_on] || 'Comp'];
        // fuel_types array form lets a multi-fuel header like
        // "Comp (D+CNG+EV)" fan out into one rule per fuel. Falls back to
        // the singular fuel_type field, then to [null] (untyped).
        const fuelList = Array.isArray(grp.fuel_types) && grp.fuel_types.length > 0
          ? grp.fuel_types
          : [grp.fuel_type || null];

        for (const insProduct of insProductList) {
          const appliedOn = grp.applied_on || (insProduct === 'TP' ? 'TP' : 'OD');
          for (const fuel of fuelList) {
            const baseRule = {
              insurer: meta.insurer,
              product: grp.product || product,
              sheet_name: meta.sheetName,
              region,
              segment: grp.sub_type || null,
              sub_type: grp.sub_type || null,
              make: null,
              fuel_type: fuel,
              cc_band_min: grp.cc_band_min != null ? grp.cc_band_min : null,
              cc_band_max: grp.cc_band_max != null ? grp.cc_band_max : null,
              weight_band_min: grp.weight_band_min != null ? grp.weight_band_min : null,
              weight_band_max: grp.weight_band_max != null ? grp.weight_band_max : null,
              seating_capacity_min: grp.seating_capacity_min != null ? grp.seating_capacity_min : null,
              seating_capacity_max: grp.seating_capacity_max != null ? grp.seating_capacity_max : null,
              vehicle_age_min: ageBand && ageBand.min != null ? ageBand.min : null,
              vehicle_age_max: ageBand && ageBand.max != null ? ageBand.max : null,
              // age_band_min/max carry NCB band (the export's inferNCB
              // reads them). Used for "SOD NCB" → 1-99 / "SOD WO NCB" → 0-0.
              age_band_min: grp.ncb_min != null ? grp.ncb_min : null,
              age_band_max: grp.ncb_max != null ? grp.ncb_max : null,
              addon: grp.addon != null ? grp.addon : null,
              carrier_type: null,
              rate_type: _composeRateType(insProduct, appliedOn, grp.nil_dep),
              discount_pct: null,
              remarks: grp.variant_label || null,
            };

            if (parsed && typeof parsed === 'object' && parsed.is_declined) {
              baseRule.rate_value = null;
              baseRule.is_declined = true;
              baseRule.rate_text = String(cellRaw);
              baseRule.is_conditional = false;
            } else {
              baseRule.rate_value = Number(parsed);
              baseRule.is_declined = false;
              baseRule.rate_text = null;
              baseRule.is_conditional = false;
            }
            rules.push(baseRule);
          }
        }
      }
    }
  }
  return rules;
}

module.exports = { parse };
