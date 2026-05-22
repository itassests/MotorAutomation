require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='rto_mappings'
    ORDER BY ORDINAL_POSITION`);
  console.table(r.recordset);
  await close();
})();
