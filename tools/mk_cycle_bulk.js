require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'cycle_bulk_rows')
      BEGIN
        CREATE TABLE cycle_bulk_rows (
          id                     INT IDENTITY(1,1) PRIMARY KEY,
          cycle_id               INT NOT NULL,
          policy_no              NVARCHAR(200) NOT NULL,
          tracker_no             NVARCHAR(200) NULL,
          insurer_slug           VARCHAR(100) NULL,
          agent_code             NVARCHAR(100) NULL,
          row_json               NVARCHAR(MAX) NOT NULL,
          rate_pct_override      DECIMAL(10,4) NULL,
          margin_pct_override    DECIMAL(10,4) NULL,
          outgoing_pct_override  DECIMAL(10,4) NULL,
          excluded               BIT DEFAULT 0,
          moved_to_cycle_id      INT NULL,
          note                   NVARCHAR(500) NULL,
          created_at             DATETIME DEFAULT GETDATE(),
          updated_at             DATETIME DEFAULT GETDATE(),
          updated_by             NVARCHAR(100) DEFAULT 'Admin'
        );
      END;
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_cycle_bulk_rows_cycle')
        CREATE INDEX IX_cycle_bulk_rows_cycle ON cycle_bulk_rows(cycle_id);
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_cycle_bulk_rows_unique')
        CREATE UNIQUE INDEX IX_cycle_bulk_rows_unique ON cycle_bulk_rows(cycle_id, policy_no);
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'cycle_runs')
      BEGIN
        CREATE TABLE cycle_runs (
          cycle_id    INT PRIMARY KEY,
          row_count   INT DEFAULT 0,
          computed_at DATETIME DEFAULT GETDATE(),
          totals_json NVARCHAR(MAX) NULL
        );
      END;
    `);
    console.log('cycle_bulk_rows + cycle_runs ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
