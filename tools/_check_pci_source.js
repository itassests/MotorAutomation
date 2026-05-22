require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
(async () => {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT rc.id AS rate_card_id,
           rc.insurer,
           rc.file_name,
           rc.effective_from,
           rc.uploaded_at,
           COUNT(rr.id) AS pci_rule_count
    FROM rate_cards rc
    JOIN rate_rules rr ON rr.rate_card_id = rc.id
    WHERE rr.sheet_name = 'pci checks'
    GROUP BY rc.id, rc.insurer, rc.file_name, rc.effective_from, rc.uploaded_at
    ORDER BY rc.uploaded_at DESC`);
  console.log("Cards that contain 'pci checks' rules:");
  console.table(r.recordset);
  await close();
})();
