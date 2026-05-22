// Inspect seating coverage on the latest TATA bus rules.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const cards = await p.request().query(`
    SELECT TOP 5 id, file_name, uploaded_at FROM rate_cards
    WHERE insurer='tata_aig' ORDER BY id DESC`);
  console.log('Latest TATA cards:'); console.table(cards.recordset);

  const r = await p.request().query(`
    SELECT TOP 25 id, rate_card_id, segment, region,
           seating_capacity_min, seating_capacity_max, rate_type, rate_value
    FROM rate_rules
    WHERE insurer='tata_aig' AND segment LIKE 'PCV Bus%'
    ORDER BY rate_card_id DESC, segment, region`);
  console.log('\nPCV Bus rules sample:'); console.table(r.recordset);

  const stats = await p.request().query(`
    SELECT segment,
           COUNT(*) total,
           SUM(CASE WHEN seating_capacity_min IS NOT NULL OR seating_capacity_max IS NOT NULL THEN 1 ELSE 0 END) with_seating
    FROM rate_rules
    WHERE insurer='tata_aig' AND segment LIKE 'PCV Bus%'
    GROUP BY segment
    ORDER BY segment`);
  console.log('\nPCV Bus seating coverage:'); console.table(stats.recordset);

  await close();
})();
