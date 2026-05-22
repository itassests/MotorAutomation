/**
 * Backfill seating_capacity_min/max on existing rate_rules using the current
 * parseSeatingCapacity logic in normalizer.js. Useful when the parser was
 * upgraded after rules were already inserted.
 *
 * Usage:
 *   node tools/backfill_seating.js              # preview
 *   $env:CONFIRM=1; node tools/backfill_seating.js  # apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');
const { getPool, close } = require('../db/connection');
const { parseSeatingCapacity } = require('../parsers/utils/normalizer');

const CONFIRM = process.env.CONFIRM === '1';

(async () => {
  const p = await getPool();

  // Distinct segments that look like they might encode seating but currently
  // have null seating columns. Filter to PCV / Bus / Cab / Seater patterns.
  const segs = await p.request().query(`
    SELECT segment, COUNT(*) cnt
    FROM rate_rules
    WHERE (seating_capacity_min IS NULL AND seating_capacity_max IS NULL)
      AND segment IS NOT NULL AND segment <> ''
      AND (
        segment LIKE '%Bus%'
        OR segment LIKE '%Seater%'
        OR segment LIKE '%seat %'
        OR segment LIKE '%Cab%'
      )
    GROUP BY segment
    ORDER BY cnt DESC`);

  let willUpdate = 0;
  const updates = [];
  for (const row of segs.recordset) {
    const { min, max } = parseSeatingCapacity(row.segment);
    if (min == null && max == null) continue;
    updates.push({ segment: row.segment, min, max, cnt: row.cnt });
    willUpdate += row.cnt;
  }

  console.log(`Distinct segments with parseable seating: ${updates.length}`);
  console.log(`Total rules that will be updated: ${willUpdate}`);
  console.table(updates.slice(0, 20));

  if (!CONFIRM) {
    console.log('\n(set CONFIRM=1 to apply)');
    await close(); return;
  }

  let done = 0;
  for (const u of updates) {
    const r = await p.request()
      .input('seg', sql.NVarChar(300), u.segment)
      .input('mn', sql.Int, u.min ?? null)
      .input('mx', sql.Int, u.max ?? null)
      .query(`UPDATE rate_rules
              SET seating_capacity_min = @mn, seating_capacity_max = @mx
              WHERE segment = @seg
                AND (seating_capacity_min IS NULL AND seating_capacity_max IS NULL)`);
    done += r.rowsAffected[0] || 0;
    process.stdout.write(`  ${done}/${willUpdate}  (${u.segment} → ${u.min}-${u.max})\r`);
  }
  console.log(`\n\nDone. Updated ${done} rules.`);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
