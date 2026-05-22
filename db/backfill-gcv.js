/**
 * One-time backfill script: parse weight_band and vehicle_age from segment text
 * for all GCV rows that currently have NULL values.
 *
 * Uses batch updates grouped by distinct segment to minimize queries.
 *
 * Usage: node db/backfill-gcv.js
 */

require('dotenv').config();
const sql = require('mssql');
const { getPool } = require('./connection');
const { parseWeightBand, parseVehicleAgeFromSegment } = require('../parsers/utils/normalizer');

async function backfill() {
  const pool = await getPool();

  // Get distinct segments for GCV rows with null weight or age
  const result = await pool.request().query(`
    SELECT DISTINCT segment
    FROM rate_rules
    WHERE product = 'GCV'
      AND (weight_band_min IS NULL OR vehicle_age_min IS NULL)
  `);

  const segments = result.recordset;
  console.log(`Found ${segments.length} distinct GCV segments to process.`);

  let updatedWeight = 0;
  let updatedAge = 0;

  for (const row of segments) {
    const segment = row.segment;
    const wb = parseWeightBand(segment);
    const va = parseVehicleAgeFromSegment(segment);

    // Update weight band
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
      updatedWeight += res.rowsAffected[0];
    }

    // Update vehicle age
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
      updatedAge += res.rowsAffected[0];
    }

    console.log(`  [${segment}] weight: ${wb.min}/${wb.max}, age: ${va.min}/${va.max}`);
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
