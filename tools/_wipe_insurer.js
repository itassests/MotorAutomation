// Wipe every rate_card (and dependent rate_rules / rto_mappings / conditional_rates)
// for a single insurer slug. Usage:
//   node tools/_wipe_insurer.js tata_aig          # preview
//   $env:CONFIRM=1; node tools/_wipe_insurer.js tata_aig   # actually delete
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');
const { getPool, close } = require('../db/connection');

const SLUG = (process.argv[2] || '').trim();
const CONFIRM = process.env.CONFIRM === '1';

(async () => {
  if (!SLUG) { console.log('Usage: node tools/_wipe_insurer.js <slug>'); process.exit(1); }
  const p = await getPool();

  const cards = await p.request()
    .input('s', sql.NVarChar, SLUG)
    .query(`SELECT id, insurer, file_name, uploaded_at FROM rate_cards WHERE insurer = @s ORDER BY id`);

  if (!cards.recordset.length) {
    console.log(`No rate_cards for insurer "${SLUG}".`);
    await close(); return;
  }

  console.log(`Matching rate_cards for "${SLUG}":`);
  console.table(cards.recordset);

  const ruleCount = await p.request().input('s', sql.NVarChar, SLUG).query(`SELECT COUNT(*) c FROM rate_rules WHERE insurer = @s`);
  const rtoCount  = await p.request().input('s', sql.NVarChar, SLUG).query(`SELECT COUNT(*) c FROM rto_mappings WHERE insurer = @s`);
  const condCount = await p.request().input('s', sql.NVarChar, SLUG).query(`
    SELECT COUNT(*) c FROM conditional_rates
    WHERE rate_rule_id IN (SELECT id FROM rate_rules WHERE insurer = @s)`);

  console.log(`\nWill delete (cascading):`);
  console.log(`  rate_cards        : ${cards.recordset.length}`);
  console.log(`  rate_rules        : ${ruleCount.recordset[0].c}`);
  console.log(`  rto_mappings      : ${rtoCount.recordset[0].c}`);
  console.log(`  conditional_rates : ${condCount.recordset[0].c}`);

  if (!CONFIRM) {
    console.log(`\n(set CONFIRM=1 to actually delete)`);
    await close(); return;
  }

  await p.request().input('s', sql.NVarChar, SLUG).query(`
    DELETE FROM conditional_rates WHERE rate_rule_id IN (SELECT id FROM rate_rules WHERE insurer = @s)`);
  await p.request().input('s', sql.NVarChar, SLUG).query(`DELETE FROM rate_rules    WHERE insurer = @s`);
  await p.request().input('s', sql.NVarChar, SLUG).query(`DELETE FROM rto_mappings  WHERE insurer = @s`);
  await p.request().input('s', sql.NVarChar, SLUG).query(`DELETE FROM rate_cards    WHERE insurer = @s`);
  console.log(`\nDone.`);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
