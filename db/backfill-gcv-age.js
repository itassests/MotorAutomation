/**
 * Backfill vehicle_age for GCV rows where segment has age info
 * but age was already parsed from other sources for some rows.
 * This catches segments like "GCV4 upto 1.6T 0-5 years" that
 * were uploaded before the age parsing was in place.
 *
 * Usage: node db/backfill-gcv-age.js
 */

require('dotenv').config();
const sql = require('mssql');
const { getPool } = require('./connection');
const { parseWeightBand, parseVehicleAgeFromSegment } = require('../parsers/utils/normalizer');

async function backfill() {
  const pool = await getPool();

  // Get ALL distinct GCV segments (including those that already got weight but not age)
  const result = await pool.request().query(`
    SELECT DISTINCT segment
    FROM rate_rules
    WHERE product = 'GCV'
  `);

  const segments = result.recordset;
  console.log(`Found ${segments.length} total distinct GCV segments.`);

  let updatedWeight = 0;
  let updatedAge = 0;

  for (const row of segments) {
    const segment = row.segment;
    const wb = parseWeightBand(segment);
    const va = parseVehicleAgeFromSegment(segment);

    // Update weight band where still null
    if (wb.min !== null || wb.max !== null) {
      const res = await pool.request()
        .input('seg', sql.VarChar, segment)
        .input('wbMin', sql.Decimal(10, 2), wb.min)
        .input('wbMax', sql.Decimal(10, 2), wb.max)
        .query(`
          UPDATE rate_rules
          SET weight_band_min = @wbMin, weight_band_max = @wbMax
          WHERE product = 'GCV' AND segment = @seg AND weight_band_min IS NULL AND weight_band_max IS NULL
        `);
      if (res.rowsAffected[0] > 0) updatedWeight += res.rowsAffected[0];
    }

    // Update vehicle age where still null
    if (va.min !== null || va.max !== null) {
      const res = await pool.request()
        .input('seg', sql.VarChar, segment)
        .input('vaMin', sql.Int, va.min)
        .input('vaMax', sql.Int, va.max)
        .query(`
          UPDATE rate_rules
          SET vehicle_age_min = @vaMin, vehicle_age_max = @vaMax
          WHERE product = 'GCV' AND segment = @seg AND vehicle_age_min IS NULL AND vehicle_age_max IS NULL
        `);
      if (res.rowsAffected[0] > 0) {
        updatedAge += res.rowsAffected[0];
        console.log(`  Age updated [${segment}] → ${va.min}-${va.max} (${res.rowsAffected[0]} rows)`);
      }
    }
  }

  console.log(`\nBackfill complete:`);
  console.log(`  Weight band updated: ${updatedWeight} rows`);
  console.log(`  Vehicle age updated: ${updatedAge} rows`);
  process.exit(0);
}

backfill().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
