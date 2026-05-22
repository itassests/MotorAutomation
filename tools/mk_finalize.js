require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    // Add finalize columns to cycle_runs (idempotent — safe to re-run).
    await pool.request().query(`
      IF COL_LENGTH('cycle_runs', 'finalized_at') IS NULL
        ALTER TABLE cycle_runs ADD finalized_at DATETIME NULL;
    `);
    await pool.request().query(`
      IF COL_LENGTH('cycle_runs', 'finalized_by') IS NULL
        ALTER TABLE cycle_runs ADD finalized_by NVARCHAR(100) NULL;
    `);
    console.log('cycle_runs finalize columns ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
