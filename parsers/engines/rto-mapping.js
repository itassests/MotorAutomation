const { cleanString } = require('../utils/normalizer');

function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const { product, data_start_row, column_map, decline_markers = [] } = sheetConfig;
  const cm = column_map;

  for (let r = data_start_row; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row || row.length === 0) continue;

    const rtoCode = cm.rto_code != null ? cleanString(row[cm.rto_code]) : '';
    const region = cm.region != null ? cleanString(row[cm.region]) : '';
    const cluster = cm.cluster != null ? cleanString(row[cm.cluster]) : '';

    if (!rtoCode && !region) continue;

    rules.push({
      layout: 'rto_mapping',
      insurer: meta.insurer,
      product: product,
      rto_code: rtoCode,
      region: region,
      cluster: cluster || region,
    });
  }

  return rules;
}

module.exports = { parse };
