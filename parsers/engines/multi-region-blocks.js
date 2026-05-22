/**
 * multi_region_blocks engine
 *
 * Handles Royal Sundaram-style "PC Comp1" sheets where 5+ regions are
 * laid out HORIZONTALLY in independent column-groups, with several BLOCKS
 * of regions stacked VERTICALLY (each block keyed on its own discount-band
 * column). Each region exposes 1 key column (Discount Band %) followed
 * by 3 rate columns (Key Cities / Other cities / Rest of state).
 *
 * Excerpt of the layout this handles:
 *
 *      Region label row  →  | (1) Delhi-NCR        | (6) Punjab           | …
 *      Sub-header row    →  | DiscBand | Key | Oth | DiscBand | Key | Oth | …
 *      Data rows         →  | Upto 20  |  X  |  X  | Upto 20  |  X  |  X  | …
 *                           | 20-50    |  X  |  X  | 20-50    |  X  |  X  | …
 *
 * Config:
 * {
 *   "layout": "multi_region_blocks",
 *   "product": "CAR",
 *   "config": {
 *     "rate_subtypes": ["Key Cities", "Other Cities", "Rest of State"],
 *     "blocks": [
 *       {
 *         "data_rows": [7, 8, 9, 10, 11],
 *         "regions": [
 *           { "col": 1,  "label": "Delhi-NCR" },
 *           { "col": 6,  "label": "Punjab"    },
 *           …
 *         ]
 *       },
 *       …
 *     ],
 *     "decline_markers": ["NA", "D"],
 *     "segment_prefix": "Pvt Car",
 *     "rate_type": "Comp"
 *   }
 * }
 *
 * Each (block × region × dataRow × rateSubtypeIdx) emits one rate_rule
 * with:
 *   - region        = region.label
 *   - sub_type      = rate_subtypes[idx]      (Key Cities / Other / Rest)
 *   - volume_tier   = discount_band cell      (Upto 20, 20-50, 50-60, …)
 *   - segment       = `${segment_prefix} ${sub_type}` (e.g. "Pvt Car Key Cities")
 *   - rate_type     = config rate_type        (default "Comp")
 *   - rate_value    = the rate cell
 *
 * Regions whose `col`-group has empty rate cells (e.g. "Nasik & Nagpur"
 * which only shows Discount Band) are still handled — the empty cells
 * are skipped by normalizeRate.
 */

const { normalizeRate, cleanString } = require('../utils/normalizer');
const { classifyProduct } = require('../utils/product-classifier');

function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const {
    product,
    blocks = [],
    rate_subtypes = ['Key Cities', 'Other Cities', 'Rest of State'],
    decline_markers = [],
    segment_prefix = '',
    rate_type = 'Comp',
    fuel_type = '',
  } = sheetConfig;

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error(`multi_region_blocks needs ≥1 blocks (sheet "${meta.sheetName}")`);
  }

  for (const block of blocks) {
    const dataRows = Array.isArray(block.data_rows) ? block.data_rows : [];
    const regions  = Array.isArray(block.regions)   ? block.regions   : [];
    if (!dataRows.length || !regions.length) continue;

    for (const region of regions) {
      const startCol = region.col;
      if (startCol == null) continue;
      const label = String(region.label || '').trim();

      // Per-region rate_subtypes override — Coimbatore / Vijaywada in
      // PC Comp1 block 4 have only ONE rate column (no Key Cities / Other
      // / Rest split), so they declare a single-element subtype list.
      const subtypesForRegion = Array.isArray(region.rate_subtypes)
        ? region.rate_subtypes
        : rate_subtypes;

      // Per-region rate column offsets — Ludhiana carves out from Punjab
      // with 3 sub-columns (Key/Other/Rest) but only the Rest column has
      // actual rates; the other two are "NA". We point the single subtype
      // straight at that rate column via [3] (col + 3 = Rest of state).
      // Default: [1, 2, 3, …] (= startCol+1, startCol+2, …).
      const rateOffsetsForRegion = Array.isArray(region.rate_col_offsets)
        ? region.rate_col_offsets
        : subtypesForRegion.map((_, i) => 1 + i);

      for (const r of dataRows) {
        const row = sheetData[r];
        if (!row || row.length === 0) continue;

        const discountBand = cleanString(row[startCol]);
        if (!discountBand) continue;            // empty discount band → blank row

        for (let i = 0; i < subtypesForRegion.length; i++) {
          const subtype = subtypesForRegion[i];
          const rateCol = startCol + (rateOffsetsForRegion[i] != null ? rateOffsetsForRegion[i] : 1 + i);
          const cellValue = row[rateCol];
          const normalized = normalizeRate(cellValue, decline_markers);
          if (!normalized) continue;

          const segment = segment_prefix ? `${segment_prefix} ${subtype}` : subtype;
          const classified = classifyProduct(segment, product, meta.sheetName);

          // Layout convention for PC Comp1-style multi-region grids:
          //   - remarks  ← state name (so the export's state-grid branch
          //                fires: State column = state, Zone column = blank)
          //   - region   ← city tier (Key Cities / Other Cities / Rest
          //                of State) — lands in the city column of Excel
          //
          // For most regions, region.label IS a state name (Tamil Nadu,
          // Karnataka, etc.) so we use it as both label & state. For
          // city-level regions (Coimbatore, Vijaywada) the config sets
          // an explicit `state` so the parent state lands in remarks
          // and the city itself stays in region/sub_type.
          const stateForRule = region.state || label;
          rules.push({
            insurer: meta.insurer,
            product: classified.product,
            sheet_name: meta.sheetName,
            region: subtype,        // Key Cities / Other Cities / Rest of State / city name
            segment,
            make: '',
            model: '',
            sub_type: subtype,
            fuel_type: fuel_type || '',
            cc_band_min: null,
            cc_band_max: null,
            weight_band_min: null,
            weight_band_max: null,
            age_band_min: null,
            age_band_max: null,
            vehicle_age_min: null,
            vehicle_age_max: null,
            seating_capacity_min: null,
            seating_capacity_max: null,
            volume_tier: discountBand,
            addon: '',
            carrier_type: '',
            rate_type,
            rate_value: normalized.rate_value,
            is_declined: normalized.is_declined,
            rate_text: normalized.rate_text,
            is_conditional: normalized.is_conditional,
            remarks: stateForRule,  // state name → export uses this for State column
          });
        }
      }
    }
  }

  return rules;
}

module.exports = { parse };
