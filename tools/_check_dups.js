// Find duplicate rate_rules within tata_aig — same signature, different IDs.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  // Specific rules user is looking at
  const r = await p.request().query(`
    SELECT id, rate_card_id, sheet_name, region, segment, rate_type, rate_value,
           weight_band_min, weight_band_max, vehicle_age_min, vehicle_age_max,
           volume_tier, sub_type, fuel_type, addon, make, product
    FROM rate_rules
    WHERE id IN (815609, 815665, 816393)`);
  console.log('=== User\'s 3 rules ===');
  console.table(r.recordset);

  // Find all rules matching the visible-card key (region INDORE, sheet cv checks, segment GCV > 35 ...)
  const sig = await p.request().query(`
    SELECT TOP 30 id, rate_card_id, region, segment, rate_type, rate_value,
           weight_band_min, weight_band_max, vehicle_age_min, vehicle_age_max,
           volume_tier
    FROM rate_rules
    WHERE insurer='tata_aig' AND sheet_name='cv checks'
      AND region='INDORE' AND segment LIKE 'GCV > 35%'
    ORDER BY rate_type, volume_tier, vehicle_age_min`);
  console.log('\n=== All cv-checks rules for INDORE × GCV > 35 ... ===');
  console.table(sig.recordset);

  // Top duplicate signatures by count
  const dups = await p.request().query(`
    SELECT TOP 20 region, segment, rate_type, volume_tier, vehicle_age_min, vehicle_age_max, weight_band_min, weight_band_max, rate_value, COUNT(*) cnt, MIN(id) min_id, MAX(id) max_id
    FROM rate_rules
    WHERE insurer='tata_aig'
    GROUP BY region, segment, rate_type, volume_tier, vehicle_age_min, vehicle_age_max, weight_band_min, weight_band_max, rate_value
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC`);
  console.log('\n=== Top duplicate signatures ===');
  console.table(dups.recordset);
  await close();
})();
