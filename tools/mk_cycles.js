require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'payout_cycles')
      BEGIN
        CREATE TABLE payout_cycles (
          id INT IDENTITY(1,1) PRIMARY KEY,
          name NVARCHAR(200) NOT NULL,
          date_from DATE NOT NULL,
          date_to   DATE NOT NULL,
          active BIT DEFAULT 1,
          created_at DATETIME DEFAULT GETDATE(),
          created_by NVARCHAR(100) DEFAULT 'Admin'
        );
      END;
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_payout_cycles_range')
        CREATE INDEX IX_payout_cycles_range ON payout_cycles(date_from, date_to);
    `);
    console.log('payout_cycles ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
