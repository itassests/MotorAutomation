require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    const runs = await pool.request().query('SELECT * FROM cycle_runs');
    console.log('cycle_runs:', runs.recordset);
    const rows = await pool.request().query('SELECT cycle_id, COUNT(*) AS n FROM cycle_bulk_rows GROUP BY cycle_id');
    console.log('cycle_bulk_rows counts:', rows.recordset);
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
