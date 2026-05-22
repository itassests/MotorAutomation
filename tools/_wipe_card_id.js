// Wipe rate_card by exact id. Usage: CONFIRM=1 node tools/_wipe_card_id.js 46
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');
const { getPool, close } = require('../db/connection');
const id = parseInt(process.argv[2], 10);
const CONFIRM = process.env.CONFIRM === '1';
(async () => {
  if (!id) { console.log('Usage: node tools/_wipe_card_id.js <id>'); process.exit(1); }
  const p = await getPool();
  const card = await p.request().input('id', sql.Int, id).query('SELECT id, insurer, file_name FROM rate_cards WHERE id=@id');
  if (!card.recordset.length) { console.log('No rate_card with id ' + id); await close(); return; }
  console.log('Card:', card.recordset[0]);
  const rules = await p.request().input('id', sql.Int, id).query('SELECT COUNT(*) c FROM rate_rules WHERE rate_card_id=@id');
  const rtos = await p.request().input('id', sql.Int, id).query('SELECT COUNT(*) c FROM rto_mappings WHERE rate_card_id=@id');
  console.log('rate_rules:', rules.recordset[0].c, 'rto_mappings:', rtos.recordset[0].c);
  if (!CONFIRM) { console.log('(set CONFIRM=1 to delete)'); await close(); return; }
  await p.request().input('id', sql.Int, id).query(`DELETE FROM conditional_rates WHERE rate_rule_id IN (SELECT id FROM rate_rules WHERE rate_card_id=@id)`);
  await p.request().input('id', sql.Int, id).query('DELETE FROM rate_rules WHERE rate_card_id=@id');
  await p.request().input('id', sql.Int, id).query('DELETE FROM rto_mappings WHERE rate_card_id=@id');
  await p.request().input('id', sql.Int, id).query('DELETE FROM rate_cards WHERE id=@id');
  console.log('Deleted.');
  await close();
})();
