require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../db/connection');
(async () => {
  const p = await getPool();
  const cards = await p.request().query('SELECT id, insurer, file_name, status FROM rate_cards ORDER BY id');
  console.table(cards.recordset);
  const rules = await p.request().query('SELECT insurer, COUNT(*) AS n FROM rate_rules GROUP BY insurer');
  console.log('rules per insurer:');
  console.table(rules.recordset);
  await p.close();
})();
