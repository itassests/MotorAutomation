require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'app_users')
      BEGIN
        CREATE TABLE app_users (
          empcode          NVARCHAR(100) PRIMARY KEY,
          name             NVARCHAR(300) NULL,
          role             VARCHAR(20)   DEFAULT 'user',  -- 'admin' | 'user'
          permissions_json NVARCHAR(MAX) NULL,            -- per-screen grants
          active           BIT           DEFAULT 1,
          last_login       DATETIME      NULL,
          created_at       DATETIME      DEFAULT GETDATE(),
          created_by       NVARCHAR(100) DEFAULT 'Admin'
        );
      END;
    `);
    // Seed a default admin so the first user can log in.
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM app_users WHERE empcode = 'ADMIN')
        INSERT INTO app_users (empcode, name, role, permissions_json)
        VALUES ('ADMIN', 'Default Admin', 'admin', '{"all":true}');
    `);
    console.log('app_users ensured');
    await pool.close();
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
})();
