require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    // Idempotent column adds on cycle_bulk_rows.
    const cols = [
      ['paid_status',    `VARCHAR(20)`],         // 'paid' | 'unpaid' | NULL
      ['paid_at',        `DATETIME`],
      ['paid_utr',       `NVARCHAR(200)`],
      ['paid_amount',    `DECIMAL(18,2)`],
      ['paid_upload_id', `INT`],
      ['paid_note',      `NVARCHAR(500)`],
    ];
    for (const [c, t] of cols) {
      await pool.request().query(`
        IF COL_LENGTH('cycle_bulk_rows', '${c}') IS NULL
          ALTER TABLE cycle_bulk_rows ADD ${c} ${t} NULL;
      `);
    }
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'utr_uploads')
      BEGIN
        CREATE TABLE utr_uploads (
          id              INT IDENTITY(1,1) PRIMARY KEY,
          cycle_id        INT NOT NULL,
          file_name       NVARCHAR(500),
          row_count       INT       DEFAULT 0,
          matched_count   INT       DEFAULT 0,
          unmatched_count INT       DEFAULT 0,
          total_amount    DECIMAL(18,2) DEFAULT 0,
          uploaded_at     DATETIME  DEFAULT GETDATE(),
          uploaded_by     NVARCHAR(100) DEFAULT 'Admin',
          status          VARCHAR(20) DEFAULT 'active'
        );
      END;
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_utr_uploads_cycle')
        CREATE INDEX IX_utr_uploads_cycle ON utr_uploads(cycle_id);
    `);
    console.log('cycle_bulk_rows.paid_* + utr_uploads ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
