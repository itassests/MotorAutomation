const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const inDir = path.join(__dirname, '..', 'uploads', 'royal_in');
for (const f of ['royal_cv.xlsx', 'royal_other.xlsx', 'royal_rto.xlsb']) {
  const fp = path.join(inDir, f);
  console.log(`\n========== ${f} ==========`);
  const t0 = Date.now();
  let rules;
  try { rules = parseWorkbook(fp, cfg); }
  catch (e) { console.log('FAIL:', e.message); continue; }
  console.log(`Total rules: ${rules.length}  (${Date.now() - t0}ms)`);
  const bySheet = {};
  for (const r of rules) {
    const k = (r.sheet_name || r.layout || '?') + (r.product ? `[${r.product}]` : '');
    bySheet[k] = (bySheet[k] || 0) + 1;
  }
  console.log('By sheet[product]:', bySheet);
  const seenSheet = {};
  for (const r of rules) {
    const k = r.sheet_name || r.layout;
    if ((seenSheet[k] = (seenSheet[k] || 0) + 1) > 2) continue;
    if (r.layout === 'rto_mapping') console.log(`  [${k}/${r.product}] rto=${r.rto_code} reg=${r.region} cl=${r.cluster}`);
    else console.log(`  [${k}] reg=${r.region} seg="${r.segment}" rate=${r.rate_value} type=${r.rate_type} fuel=${r.fuel_type} wt=${r.weight_band_min}-${r.weight_band_max}`);
  }
}
