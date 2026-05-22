require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT TOP 12 id, segment, make, rate_type, age_band_min, age_band_max, rate_value
    FROM rate_rules WHERE insurer='sbi_general' AND segment LIKE '%Taxi%' ORDER BY id`);
  console.log('PCV Taxi sample:');
  console.table(r.recordset);
  const all = await p.request().query(`SELECT COUNT(*) c FROM rate_rules WHERE insurer='sbi_general'`);
  console.log('total sbi rules:', all.recordset[0].c);
  const niln = await p.request().query(`SELECT DISTINCT rate_type FROM rate_rules WHERE insurer='sbi_general' AND rate_type LIKE '%NilDep%'`);
  console.log('NilDep rate_types:'); console.table(niln.recordset);
  const ageb = await p.request().query(`SELECT TOP 10 segment, rate_type, age_band_min, age_band_max FROM rate_rules WHERE insurer='sbi_general' AND age_band_min IS NOT NULL`);
  console.log('rules with age_band_min set:'); console.table(ageb.recordset);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
