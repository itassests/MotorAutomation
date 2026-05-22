require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const pool = await getPool();
  const card = await pool.request().query(`SELECT TOP 5 id, insurer, file_name, effective_from, uploaded_at FROM rate_cards ORDER BY id DESC`);
  console.log('Recent rate_cards:');
  console.table(card.recordset);
  const rules = await pool.request().query(`SELECT rate_card_id, COUNT(*) cnt FROM rate_rules WHERE rate_card_id >= 40 GROUP BY rate_card_id ORDER BY rate_card_id DESC`);
  console.log('\nRate rule counts for recent cards:');
  console.table(rules.recordset);
  const rtos = await pool.request().query(`SELECT rate_card_id, COUNT(*) cnt FROM rto_mappings WHERE rate_card_id >= 40 GROUP BY rate_card_id ORDER BY rate_card_id DESC`);
  console.log('\nRTO mapping counts:');
  console.table(rtos.recordset);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
