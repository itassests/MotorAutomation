require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF COL_LENGTH('payout_cycles', 'agent_codes_csv') IS NULL
        ALTER TABLE payout_cycles ADD agent_codes_csv NVARCHAR(MAX) NULL;
    `);
    console.log('payout_cycles.agent_codes_csv ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
