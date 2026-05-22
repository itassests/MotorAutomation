require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, NUMERIC_PRECISION, NUMERIC_SCALE
    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rate_rules'
    ORDER BY ORDINAL_POSITION`);
  console.table(r.recordset);
  await close();
})();
