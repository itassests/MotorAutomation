require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT TOP 5 segment, fuel_type, volume_tier, vehicle_age_min, vehicle_age_max, rate_type, rate_value, is_declined
    FROM rate_rules WHERE insurer='sbi_general' AND segment='Pvt Car SATP' ORDER BY id`);
  console.table(r.recordset);
  const v = await p.request().query(`SELECT DISTINCT volume_tier FROM rate_rules WHERE insurer='sbi_general'`);
  console.log('distinct volume_tiers:'); console.table(v.recordset);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
