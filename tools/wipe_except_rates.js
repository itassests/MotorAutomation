/**
 * tools/wipe_except_rates.js — Clear every operational table EXCEPT the
 * rate cards (rate_cards, rate_rules, rto_mappings, conditional_rates) and
 * the user / settings tables (app_users, …). Run before exercising an
 * end-to-end test cycle.
 *
 * Usage:  node tools/wipe_except_rates.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');
const { getPool } = require('../db/connection');

// FK-safe deletion order. Each table is wiped inside a single transaction so
// a mid-run failure leaves the DB consistent.
const TABLES = [
  // Cycle child tables before parents
  'cycle_bulk_rows',
  'cycle_runs',
  'agent_recoveries',
  'excluded_policies',
  'utr_uploads',
  'payout_cycles',

  // Statements
  'statement_rows',
  'statement_uploads',

  // Premium Register
  'pr_rows',
  'pr_uploads',

  // Margins
  'margin_rules',
];

const PRESERVED = [
  'rate_cards',
  'rate_rules',
  'rto_mappings',
  'conditional_rates',
  'app_users',
];

(async () => {
  try {
    const pool = await getPool();

    const countQ = async (table) => {
      try {
        const r = await pool.request().query(`SELECT COUNT(*) AS n FROM ${table}`);
        return r.recordset[0].n;
      } catch { return null; }
    };

    console.log('=== BEFORE ===');
    const before = {};
    for (const t of [...TABLES, ...PRESERVED]) {
      before[t] = await countQ(t);
      console.log(`  ${t}: ${before[t]}`);
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const t of TABLES) {
        await new sql.Request(tx).query(`DELETE FROM ${t}`);
      }
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* noop */ }
      throw err;
    }

    console.log('\n=== AFTER (transactional wipe) ===');
    for (const t of [...TABLES, ...PRESERVED]) {
      const n = await countQ(t);
      const kept = PRESERVED.includes(t);
      const tag  = kept ? '(preserved)' : '(wiped)';
      const delta = before[t] != null && n != null ? `Δ ${(n - before[t])}` : '';
      console.log(`  ${t.padEnd(22)} ${String(n).padStart(8)}  ${tag}  ${delta}`);
    }
    await pool.close();
    console.log('\nDone.');
  } catch (e) {
    console.error('FAIL', e.message);
    process.exit(1);
  }
})();
