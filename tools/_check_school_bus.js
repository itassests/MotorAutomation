const fs = require('fs');
const path = require('path');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const re = /^school[\s_]*bus$/i;
const rules = parseWorkbook(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx'), cfg)
  .filter(r => re.test(String(r.sheet_name || '')));
console.log(`School Bus rules: ${rules.length}`);
const byState = new Map();
for (const r of rules) {
  const k = r.remarks || '(blank)';
  if (!byState.has(k)) byState.set(k, []);
  byState.get(k).push(r);
}
let i = 0;
for (const [st, list] of byState) {
  if (i++ > 4) break;
  console.log(`\n[${st}] ${list.length} rules:`);
  for (const r of list) {
    console.log(`  rate_type="${r.rate_type}" rate=${r.rate_value} sub_type=${r.sub_type} segment=${r.segment}`);
  }
}
