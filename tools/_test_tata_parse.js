/**
 * Dry-run the TATA insurer config against the staged workbooks.
 * Prints rule counts per sheet and a few sample rules.
 */
const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'tata_aig.json'), 'utf8'));
const inDir = path.join(__dirname, '..', 'uploads', 'tata_in');

const files = [
  'tata_grid.xlsx',     // cv checks + pci checks
  'tata_rto.xlsb'       // RTO mappers
];

for (const f of files) {
  const fp = path.join(inDir, f);
  console.log(`\n========== ${f} ==========`);
  const t0 = Date.now();
  let rules;
  try {
    rules = parseWorkbook(fp, cfg);
  } catch (e) {
    console.log('PARSE FAIL:', e.message);
    continue;
  }
  const ms = Date.now() - t0;
  console.log(`Total rules: ${rules.length}  (${ms}ms)`);

  // Count by sheet
  const bySheet = {};
  for (const r of rules) {
    const k = r.sheet_name || r.layout || '?';
    bySheet[k] = (bySheet[k] || 0) + 1;
  }
  console.log('By sheet:', bySheet);

  // Count rate_rules vs rto_mappings
  const rtoCount = rules.filter(r => r.layout === 'rto_mapping').length;
  console.log(`  rto_mapping rows: ${rtoCount},  rate_rules: ${rules.length - rtoCount}`);

  // Channel distribution for rate rules
  const channels = {};
  for (const r of rules) {
    if (r.layout === 'rto_mapping') continue;
    const ch = (r.rate_type || '').split('|')[0] || '(none)';
    channels[ch] = (channels[ch] || 0) + 1;
  }
  console.log('  channels:', channels);

  // Print 3 sample rules per sheet
  const seen = {};
  for (const r of rules) {
    const k = r.sheet_name || r.layout;
    if ((seen[k] = (seen[k] || 0) + 1) > 3) continue;
    if (r.layout === 'rto_mapping') {
      console.log(`  [${k}] rto=${r.rto_code} region=${r.region} cluster=${r.cluster}`);
    } else {
      console.log(`  [${k}] seg="${r.segment}" reg=${r.region} rate=${r.rate_value} type=${r.rate_type} age=${r.vehicle_age_min}-${r.vehicle_age_max} wt=${r.weight_band_min}-${r.weight_band_max} fuel=${r.fuel_type}`);
    }
  }
}
