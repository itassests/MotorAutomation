/**
 * Dry-run the Universal Sompo engine against the rate file without
 * writing to DB. Prints a per-sheet summary of rules emitted.
 */
const path = require('path');
const { parseWorkbook } = require('../parsers/engine');
const config = require('../config/insurers/universal_sompo.json');

const file = 'D:/Motor_Payout/April26/Ritesh Sir/Universal April Month/Universal Sompo Grid.xlsx';
const rules = parseWorkbook(file, config);

const bySheet = new Map();
for (const r of rules) {
  const k = r.sheet_name || '(unknown)';
  if (!bySheet.has(k)) bySheet.set(k, []);
  bySheet.get(k).push(r);
}

console.log(`\nTotal rules: ${rules.length}\n`);
for (const [sheet, list] of bySheet) {
  const declined = list.filter(r => r.is_declined).length;
  const rateTypes = [...new Set(list.map(r => r.rate_type).filter(Boolean))].sort();
  const segments  = [...new Set(list.map(r => r.segment).filter(Boolean))].sort();
  const states    = [...new Set(list.map(r => r.region).filter(Boolean))].sort();
  console.log(`=== ${sheet} (${list.length} rules, ${declined} declined) ===`);
  console.log(`  rate_types: ${rateTypes.join(', ')}`);
  console.log(`  segments:   ${segments.join(' | ')}`);
  console.log(`  states:     ${states.join(', ')}`);
  // Show 2 example rules
  console.log('  sample rules:');
  for (const r of list.slice(0, 2)) {
    console.log('    ', JSON.stringify({
      region: r.region, sub: r.sub_type, segment: r.segment, make: r.make,
      rate_type: r.rate_type, rate: r.rate_value, declined: r.is_declined,
      vol: r.volume_tier, age: [r.vehicle_age_min, r.vehicle_age_max],
      ageb: [r.age_band_min, r.age_band_max], wb: [r.weight_band_min, r.weight_band_max],
      seat: [r.seating_capacity_min, r.seating_capacity_max], fuel: r.fuel_type,
    }));
  }
}
