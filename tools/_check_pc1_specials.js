const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const fp = path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx');
const rules = parseWorkbook(fp, cfg);
const pc = rules.filter(r => r.sheet_name === 'PC Comp1');
console.log('PC Comp1 total:', pc.length);
for (const label of ['Nasik', 'Coimbatore', 'Vijaywada']) {
  const sub = pc.filter(r => String(r.region || '').includes(label));
  console.log(`${label}: ${sub.length} rules`);
  for (const r of sub) {
    console.log(`  remarks="${r.remarks}" reg="${r.region}" vt="${r.volume_tier}" rate=${r.rate_value}`);
  }
}
