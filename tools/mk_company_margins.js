require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'company_margins')
      BEGIN
        CREATE TABLE company_margins (
          scope_key   VARCHAR(50) PRIMARY KEY,         -- 'GLOBAL' / 'CAR' / 'TW' / 'GCV' / 'PCV' / 'MISC'
          margin_pct  DECIMAL(6, 3) NOT NULL,
          notes       NVARCHAR(500) NULL,
          updated_at  DATETIME DEFAULT GETDATE(),
          updated_by  NVARCHAR(100) DEFAULT 'Admin'
        );
      END;
    `);
    console.log('company_margins ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
