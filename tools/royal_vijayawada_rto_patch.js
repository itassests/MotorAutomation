/**
 * Royal Sundaram — Vijayawada RTO override.
 *
 * The bottom-of-sheet note on AP and Pan India CV STP says:
 *   "Vijayawada RTO's - AP16, AP17, AP18, AP19, AP39, AP40
 *    (Pls note that as AP 39 and 40 are common RTO codes for the
 *     entire state, the RTO location need to be Vijayawada)"
 *
 * This script updates rto_mappings rows for those six RTO codes (under
 * insurer = royal_sundaram) so their cluster maps to "VIJAYWADA" /
 * "Vijayawada" — matching the rate_rules.region used by the state CV
 * grids (which expose Vijayawada as one of the clusters in the AP
 * sheet header).
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   node tools/royal_vijayawada_rto_patch.js          # preview
 *   $env:CONFIRM=1; node tools/royal_vijayawada_rto_patch.js   # apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');
const { getPool, close } = require('../db/connection');

const RTO_CODES = ['AP16', 'AP17', 'AP18', 'AP19', 'AP39', 'AP40'];
const NEW_CLUSTER = 'VIJAYWADA';
const CONFIRM = process.env.CONFIRM === '1';

(async () => {
  const p = await getPool();

  // Show current state
  const params = RTO_CODES.map((_, i) => `@r${i}`).join(',');
  const rqShow = p.request();
  RTO_CODES.forEach((c, i) => rqShow.input('r' + i, sql.NVarChar, c));
  const before = await rqShow.query(`
    SELECT id, rto_code, product, region, cluster
    FROM rto_mappings
    WHERE insurer = 'royal_sundaram'
      AND rto_code IN (${params})
    ORDER BY rto_code, product`);
  console.log(`Current rto_mappings for ${RTO_CODES.join(', ')}:`);
  console.table(before.recordset);

  // Filter to rows whose cluster ≠ Vijayawada/Vijaywada
  const stale = before.recordset.filter(
    r => !/^vij(?:ay?)wada$/i.test(String(r.cluster || '').trim())
  );
  console.log(`\nWill update ${stale.length} rows → cluster = "${NEW_CLUSTER}"`);

  if (!CONFIRM) {
    console.log('\n(set CONFIRM=1 to actually apply)');
    await close();
    return;
  }

  let updated = 0;
  for (const row of stale) {
    const r = await p.request()
      .input('id', sql.Int, row.id)
      .input('cluster', sql.NVarChar, NEW_CLUSTER)
      .query('UPDATE rto_mappings SET cluster = @cluster WHERE id = @id');
    updated += r.rowsAffected[0] || 0;
  }
  console.log(`\nDone. Updated ${updated} rows.`);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
