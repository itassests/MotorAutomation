/**
 * Dry-run HDFC engine over each of the 5 rate files, print summary.
 */
const fs = require('fs');
const path = require('path');
const { parseWorkbook } = require('../parsers/engine');
const config = require('../config/insurers/hdfc_ergo.json');

const dir = 'D:/Motor_Payout/April26/Ritesh Sir/HDFC April Month/Consider';
const files = fs.readdirSync(dir);

const totals = {};
for (const f of files) {
  if (!f.endsWith('.xlsx')) continue;
  if (/Geography/i.test(f)) continue;     // master only, no rate sheets
  const full = path.join(dir, f);
  console.log('\n==== ' + f + ' ====');
  try {
    const rules = parseWorkbook(full, config);
    console.log('  rules:', rules.length);
    const declined = rules.filter(r => r.is_declined).length;
    console.log('  declined:', declined);
    const segs = [...new Set(rules.map(r => r.segment).filter(Boolean))].sort();
    console.log('  segments:', segs.slice(0, 8).join(' | '));
    const subs = [...new Set(rules.map(r => r.sub_type).filter(Boolean))].sort();
    console.log('  sub_types:', subs.slice(0, 10).join(' | '));
    if (rules.length > 0) {
      console.log('  sample:');
      rules.slice(0, 3).forEach(r => console.log('   ', JSON.stringify({
        region: r.region, sub: r.sub_type, segment: r.segment, make: r.make,
        rt: r.rate_type, rate: r.rate_value, decl: r.is_declined,
        age: [r.vehicle_age_min, r.vehicle_age_max], wb: [r.weight_band_min, r.weight_band_max],
        cc: [r.cc_band_min, r.cc_band_max], fuel: r.fuel_type,
      })));
    }
    totals[f] = rules.length;
  } catch (e) {
    console.log('  ERROR:', e.message);
  }
}
console.log('\n=== TOTAL by file ===');
console.log(totals);
