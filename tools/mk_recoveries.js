require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'agent_recoveries')
      BEGIN
        CREATE TABLE agent_recoveries (
          id                  INT IDENTITY(1,1) PRIMARY KEY,
          agent_code          NVARCHAR(100) NOT NULL,
          agent_name          NVARCHAR(300) NULL,
          policy_no           NVARCHAR(200) NOT NULL,
          original_cycle_id   INT NULL,
          insurer_slug        VARCHAR(100) NULL,
          recovery_amount     DECIMAL(18,2) NOT NULL,
          reason              NVARCHAR(500) NULL,
          status              VARCHAR(20) DEFAULT 'pending',
          applied_in_cycle_id INT NULL,
          applied_amount      DECIMAL(18,2) DEFAULT 0,
          applied_at          DATETIME NULL,
          created_at          DATETIME DEFAULT GETDATE(),
          created_by          NVARCHAR(100) DEFAULT 'Admin',
          notes               NVARCHAR(500) NULL
        );
      END;
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_agent_recoveries_agent')
        CREATE INDEX IX_agent_recoveries_agent ON agent_recoveries(agent_code, status);
    `);
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_agent_recoveries_policy')
        CREATE INDEX IX_agent_recoveries_policy ON agent_recoveries(policy_no);
    `);
    console.log('agent_recoveries ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
