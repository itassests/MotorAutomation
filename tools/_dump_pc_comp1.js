// Dump every PC Comp1 rule the parser produces, in tabular form.
const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const fp = path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx');
const rules = parseWorkbook(fp, cfg);
const pc = rules.filter(r => r.sheet_name === 'PC Comp1');
console.log(`PC Comp1 rules: ${pc.length}\n`);

// Group by region label (state/city)
const byRegion = new Map();
for (const r of pc) {
  const k = `${r.remarks} → ${r.sub_type}`;
  if (!byRegion.has(k)) byRegion.set(k, []);
  byRegion.get(k).push(r);
}
console.log(`Distinct (State → City) groups: ${byRegion.size}\n`);

// Format table
const rows = [['#','State (remarks)','City (sub_type)','Discount Band (vt)','Rate%','Segment']];
let i = 1;
for (const [k, list] of byRegion) {
  for (const r of list) {
    rows.push([
      String(i++),
      r.remarks || '',
      r.sub_type || '',
      r.volume_tier || '',
      r.rate_value != null ? (r.rate_value * 100).toFixed(2) + '%' : '',
      r.segment || '',
    ]);
  }
}
const widths = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c] || '').length)));
for (const r of rows) {
  console.log(r.map((v, c) => String(v || '').padEnd(widths[c])).join('  '));
}
