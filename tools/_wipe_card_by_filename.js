// Wipe rate_cards (and dependent rate_rules / rto_mappings / conditional_rates)
// matching a filename pattern, scoped to one insurer.
// Usage:  node tools/_wipe_card_by_filename.js <insurer-slug> <filename-pattern>   # preview
//         CONFIRM=1 node tools/_wipe_card_by_filename.js hdfc_ergo "TW Non New"    # actual delete
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');
const { getPool, close } = require('../db/connection');

const SLUG    = (process.argv[2] || '').trim();
const PATTERN = (process.argv[3] || '').trim();
const CONFIRM = process.env.CONFIRM === '1';

(async () => {
  if (!SLUG || !PATTERN) {
    console.log('Usage: node tools/_wipe_card_by_filename.js <slug> <pattern>');
    process.exit(1);
  }
  const p = await getPool();
  const cards = await p.request()
    .input('s', sql.NVarChar, SLUG)
    .input('p', sql.NVarChar, '%' + PATTERN + '%')
    .query(`SELECT id, file_name, uploaded_at FROM rate_cards
            WHERE insurer = @s AND file_name LIKE @p ORDER BY id`);
  if (!cards.recordset.length) {
    console.log(`No matching cards for ${SLUG} / "${PATTERN}".`);
    await close(); return;
  }
  console.log('Matching cards:');
  console.table(cards.recordset);
  const ids = cards.recordset.map(r => r.id);

  if (!CONFIRM) {
    console.log('\n(set CONFIRM=1 to actually delete)');
    await close(); return;
  }
  const idList = ids.join(',');
  await p.request().query(`DELETE FROM conditional_rates WHERE rate_rule_id IN (SELECT id FROM rate_rules WHERE rate_card_id IN (${idList}))`);
  await p.request().query(`DELETE FROM rate_rules    WHERE rate_card_id IN (${idList})`);
  await p.request().query(`DELETE FROM rto_mappings  WHERE rate_card_id IN (${idList})`);
  await p.request().query(`DELETE FROM rate_cards    WHERE id IN (${idList})`);
  console.log('\nDone.');
  await close();
})().catch(e => { console.error(e); process.exit(1); });
