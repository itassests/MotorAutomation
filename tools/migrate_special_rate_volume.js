/**
 * Idempotent migration — adds the volume-uplift columns to special_rate_rules:
 *   exclusions_json (conditions excluded from threshold + uplift),
 *   apply_mode ('per_policy' | 'overall'),
 *   rule_kind  ('scope_override' | 'volume_uplift').
 *
 * Run on each environment after deploying the volume-uplift feature:
 *   node tools/migrate_special_rate_volume.js
 */
require('dotenv').config({ override: true });
const { getPool } = require('../db/connection');

(async () => {
  const pool = await getPool();
  const cols = (await pool.request().query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='special_rate_rules'"
  )).recordset.map(r => r.COLUMN_NAME);
  const add = async (name, ddl) => {
    if (cols.includes(name)) { console.log(name, '— already present, skip'); return; }
    await pool.request().query(`ALTER TABLE special_rate_rules ADD ${ddl}`);
    console.log('added', name);
  };
  await add('exclusions_json', 'exclusions_json NVARCHAR(MAX) NULL');
  await add('apply_mode', 'apply_mode VARCHAR(20) NULL');
  await add('rule_kind', 'rule_kind VARCHAR(20) NULL');
  console.log('migration complete');
  process.exit(0);
})().catch(e => { console.error('migration failed:', e.message); process.exit(1); });
