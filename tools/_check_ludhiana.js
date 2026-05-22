const fs = require('fs');
const path = require('path');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const rules = parseWorkbook(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx'), cfg)
  .filter(x => /PC[ _]Comp/i.test(x.sheet_name || ''));
const lud = rules.filter(x => /Ludhiana/i.test(x.region || ''));
console.log(`Ludhiana rules: ${lud.length}`);
for (const x of lud) {
  console.log(`  remarks="${x.remarks}" reg="${x.region}" vt=${x.volume_tier} rate=${x.rate_value}`);
}
