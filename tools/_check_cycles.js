require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT TOP 10 * FROM payout_cycles ORDER BY id DESC`);
  console.table(r.recordset);
  // Show distinct insurers in latest cycle
  const latest = r.recordset[0];
  if (latest) {
    console.log('\nInsurers in latest cycle (id=' + latest.id + '):');
    const q = await p.request()
      .input('cid', latest.id)
      .query(`SELECT JSON_VALUE(row_json, '$.INSURER_NAME') AS insurer, COUNT(*) AS cnt
              FROM cycle_bulk_rows WHERE cycle_id = @cid
              GROUP BY JSON_VALUE(row_json, '$.INSURER_NAME')
              ORDER BY cnt DESC`);
    console.table(q.recordset);
  }
  await close();
})().catch(e => { console.error(e); process.exit(1); });
