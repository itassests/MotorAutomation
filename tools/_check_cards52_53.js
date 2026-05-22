require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const r = await p.request().query(`SELECT id, insurer, file_name, effective_from, uploaded_at FROM rate_cards WHERE insurer='tata_aig' ORDER BY id`);
  console.log('TATA cards:'); console.table(r.recordset);
  const counts = await p.request().query(`SELECT rate_card_id, COUNT(*) cnt FROM rate_rules WHERE insurer='tata_aig' GROUP BY rate_card_id ORDER BY rate_card_id`);
  console.log('\nRate rule counts per card:'); console.table(counts.recordset);
  await close();
})();
