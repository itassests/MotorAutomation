const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const fp = path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_cv.xlsx');
const rules = parseWorkbook(fp, cfg);
const sub = rules.filter(r => r.sheet_name === 'Pan India -CV STP' && /vijayawada/i.test(String(r.region || '')));
console.log(`Pan India CV STP, region containing Vijayawada: ${sub.length}`);
for (const r of sub.slice(0, 10)) {
  console.log(`region="${r.region}" remarks="${r.remarks}" segment="${r.segment}" rate_type=${r.rate_type}`);
}
