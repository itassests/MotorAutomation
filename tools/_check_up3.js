require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT TOP 10 id, rate_card_id, sheet_name, region, segment, rate_type, rate_value
    FROM rate_rules
    WHERE insurer='tata_aig' AND region='UP3' AND sheet_name='cv checks'
    ORDER BY rate_card_id DESC, segment, rate_type`);
  console.log('UP3 cv-checks rules sample:'); console.table(r.recordset);

  const cnt = await p.request().query(`
    SELECT region, COUNT(*) cnt
    FROM rate_rules
    WHERE insurer='tata_aig' AND sheet_name='cv checks' AND region LIKE 'UP%'
    GROUP BY region`);
  console.log('\nUP* counts:'); console.table(cnt.recordset);

  const schoolBus = await p.request().query(`
    SELECT TOP 20 id, rate_card_id, sheet_name, region, segment, sub_type, rate_type, rate_value
    FROM rate_rules
    WHERE insurer='tata_aig' AND sheet_name='School Bus'
    ORDER BY rate_card_id DESC, segment`);
  console.log('\nSchool Bus rules:'); console.table(schoolBus.recordset);

  await close();
})();
