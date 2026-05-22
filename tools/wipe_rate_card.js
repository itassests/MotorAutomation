/**
 * tools/wipe_rate_card.js — Delete one specific rate card and every dependent
 * row (rate_rules, conditional_rates linked through them, and rto_mappings
 * that reference the same rate_card_id).
 *
 * Usage:
 *   node tools/wipe_rate_card.js [pattern]
 *
 * `pattern` is matched (LIKE %x%) against rate_cards.file_name. Default:
 *   "Pvt_Car_Comp_SAOD"  (the user's "Effective From 7th Mar'26 ...
 *   Pvt Car Comp+SAOD.xlsx" upload — multer stamps the original name with
 *   underscores in place of spaces / special chars).
 *
 * Set CONFIRM=1 in the env to actually run the deletion. Without that the
 * script previews what would be deleted and exits.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');
const { getPool } = require('../db/connection');

const PATTERN = (process.argv[2] || 'Pvt_Car_Comp_SAOD').trim();
const CONFIRM = process.env.CONFIRM === '1';

(async () => {
  try {
    const pool = await getPool();

    const cards = await pool.request()
      .input('p', sql.NVarChar(500), '%' + PATTERN + '%')
      .query(`SELECT id, insurer, file_name, effective_from, uploaded_at, status
              FROM rate_cards
              WHERE file_name LIKE @p
              ORDER BY uploaded_at DESC`);

    if (cards.recordset.length === 0) {
      console.log(`No rate_cards matched LIKE %${PATTERN}%`);
      process.exit(0);
    }

    console.log('Matching rate_cards:');
    for (const c of cards.recordset) console.log(' ', c);

    const ids = cards.recordset.map(c => c.id);
    const idList = ids.join(',');

    const ruleCount = await pool.request().query(
      `SELECT COUNT(*) AS n FROM rate_rules WHERE rate_card_id IN (${idList})`
    );
    const rtoCount = await pool.request().query(
      `SELECT COUNT(*) AS n FROM rto_mappings WHERE rate_card_id IN (${idList})`
    );
    const condCount = await pool.request().query(
      `SELECT COUNT(*) AS n FROM conditional_rates
       WHERE rate_rule_id IN (SELECT id FROM rate_rules WHERE rate_card_id IN (${idList}))`
    );

    console.log('\nWill delete:');
    console.log(`  rate_cards            : ${cards.recordset.length}`);
    console.log(`  rate_rules            : ${ruleCount.recordset[0].n}`);
    console.log(`  rto_mappings          : ${rtoCount.recordset[0].n}`);
    console.log(`  conditional_rates     : ${condCount.recordset[0].n}`);

    if (!CONFIRM) {
      console.log('\nPreview only. Re-run with CONFIRM=1 to execute the delete.');
      process.exit(0);
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const rq = () => new sql.Request(tx);
      // Children first to respect FKs.
      await rq().query(
        `DELETE FROM conditional_rates
         WHERE rate_rule_id IN (SELECT id FROM rate_rules WHERE rate_card_id IN (${idList}))`
      );
      await rq().query(`DELETE FROM rate_rules    WHERE rate_card_id IN (${idList})`);
      await rq().query(`DELETE FROM rto_mappings  WHERE rate_card_id IN (${idList})`);
      await rq().query(`DELETE FROM rate_cards    WHERE id           IN (${idList})`);
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* noop */ }
      throw err;
    }
    console.log('\nDone.');
    await pool.close();
  } catch (e) {
    console.error('FAIL', e.message);
    process.exit(1);
  }
})();
