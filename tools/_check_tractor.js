const fs = require('fs');
const path = require('path');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const re = /^tractor$/i;
const rules = parseWorkbook(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx'), cfg)
  .filter(r => re.test(String(r.sheet_name || '')));
console.log(`Tractor rules: ${rules.length}`);
const byState = new Map();
for (const r of rules) {
  const k = r.remarks || '(blank)';
  if (!byState.has(k)) byState.set(k, []);
  byState.get(k).push(r);
}
for (const [st, list] of byState) {
  console.log(`\n[${st}] ${list.length} rules:`);
  for (const r of list) {
    console.log(`  rate_type="${r.rate_type}" rate=${r.rate_value} volume_tier="${r.volume_tier}"`);
  }
}
