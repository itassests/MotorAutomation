const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'tata_aig.json'), 'utf8'));

for (const f of ['tata_grid.xlsx', 'tata_pvt_pkg.xlsx']) {
  const fp = path.join(__dirname, '..', 'uploads', 'tata_in', f);
  console.log(`\n========== ${f} ==========`);
  const rules = parseWorkbook(fp, cfg);
  const pvt = rules.filter(r => r.sheet_name === 'Pvt Pkg' || r.sheet_name === 'Sheet1');
  console.log(`Pvt Pkg / Sheet1 rules: ${pvt.length}`);
  const types = {};
  for (const r of pvt) types[r.rate_type] = (types[r.rate_type] || 0) + 1;
  console.log('rate_type breakdown:', types);
  console.log('first 5 rules:');
  for (const r of pvt.slice(0, 5)) {
    console.log(`  ${r.sheet_name} | ${r.rate_type} | sub=${r.sub_type} | fuel=${r.fuel_type} | reg=${r.region} | rate=${r.rate_value}`);
  }
}
