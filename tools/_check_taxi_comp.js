const fs = require('fs');
const path = require('path');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const re = /^taxi[\s_]*comp$/i;
const rules = parseWorkbook(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx'), cfg)
  .filter(r => re.test(String(r.sheet_name || '')));
console.log(`Taxi Comp rules: ${rules.length}`);
const byState = new Map();
for (const r of rules) {
  const k = r.region || '(blank)';
  if (!byState.has(k)) byState.set(k, []);
  byState.get(k).push(r);
}
for (const [st, list] of byState) {
  console.log(`\n[${st}] ${list.length} rules:`);
  for (const r of list) {
    console.log(`  rate_type="${r.rate_type}" rate=${r.rate_value} seg="${r.segment}" seat=${r.seating_capacity_min}-${r.seating_capacity_max} age=${r.vehicle_age_min}-${r.vehicle_age_max} carrier="${r.carrier_type}" remarks="${r.remarks}"`);
  }
}

// Also dump source rows
console.log('\n\n=== source rows ===');
const wb = require('xlsx').readFile(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx'), { cellDates: false });
const target = wb.SheetNames.find(n => re.test(n));
const aoa = require('xlsx').utils.sheet_to_json(wb.Sheets[target], { header: 1, defval: '' });
for (let r = 0; r < Math.min(20, aoa.length); r++) {
  const row = aoa[r] || [];
  console.log(`r${r}:`);
  row.forEach((c, i) => { const s = String(c).trim(); if (s) console.log(`  [${i}] ${s}`); });
}
