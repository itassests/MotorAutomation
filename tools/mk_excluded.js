require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'excluded_policies')
      BEGIN
        CREATE TABLE excluded_policies (
          policy_no   NVARCHAR(200) PRIMARY KEY,
          reason      NVARCHAR(500) NULL,
          excluded_at DATETIME DEFAULT GETDATE(),
          excluded_by NVARCHAR(100) DEFAULT 'Admin'
        );
      END;
    `);
    console.log('excluded_policies ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
