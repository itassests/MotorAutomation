// Verify IRDA fan-out happened in dry-run.
const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const fp = path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_cv.xlsx');
const rules = parseWorkbook(fp, cfg);

const irda = rules.filter(r => /IRDA/i.test(String(r.rate_type || '')));
const irdaOd = irda.filter(r => /IRDA_OD/i.test(r.rate_type));
const irdaTp = irda.filter(r => /IRDA_TP/i.test(r.rate_type));
console.log(`Total IRDA rules: ${irda.length}  (OD: ${irdaOd.length}, TP: ${irdaTp.length})`);
console.log('First 5 IRDA samples:');
for (const r of irda.slice(0, 5)) {
  console.log(`  [${r.sheet_name}] reg=${r.region} seg="${r.segment}" type=${r.rate_type} rate=${r.rate_value} age=${r.vehicle_age_min}-${r.vehicle_age_max} addon=${r.addon}`);
}
const bySheet = {};
for (const r of irda) bySheet[r.sheet_name] = (bySheet[r.sheet_name] || 0) + 1;
console.log('\nIRDA by sheet:', bySheet);
