require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT sheet_name, COUNT(*) c FROM rate_rules WHERE insurer='universal_sompo' GROUP BY sheet_name ORDER BY sheet_name`);
  console.table(r.recordset);
  const tot = await p.request().query(`SELECT COUNT(*) c FROM rate_rules WHERE insurer='universal_sompo'`);
  console.log('total:', tot.recordset[0].c);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
