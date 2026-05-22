/**
 * Upload Final Rates — accepts the master 42-column rates_all.xlsx format,
 * converts each row to a JSON object using the sheet headers verbatim,
 * and passes the whole array as a single @Json NVARCHAR(MAX) parameter
 * to the Prarambh_UAT stored procedure App_UPloadPointsdetails.
 */

const express = require('express');
const sql = require('mssql');
const XLSX = require('xlsx');
const { getPrarambhUatPool } = require('../db/prarambh-uat-connection');

const router = express.Router();

// Expected header set — used for validation and trimming of trailing spaces
// (the source workbook has "Modal ", "city ", "Cluster ", "Applied on " etc.).
const EXPECTED_HEADERS = [
  'Srno', 'Insurer', 'StartDate', 'EndDate', 'VehicleType', 'VehicleCategory',
  'ProductType', 'Make', 'Modal', 'Sub Modal', 'Owned By', 'FuelType',
  'MinimumCC', 'MaximumCC', 'MinimumSeatingCapacity', 'MaximumSeatingCapacity',
  'MinAgeofvehicle', 'MaxAgeOfVehicle', 'Min NOP', 'Max NOP',
  'Minimumtonnage', 'Maximumtonnage', 'MinIDV', 'MaxIDV',
  'RTOCode', 'city', 'State', 'Cluster', 'Addon', 'BusinessType', 'Break-In',
  'OD_Tenure', 'TP_Tenure', 'min discount', 'Discount', 'MinimumNCB',
  'MaximumNCB', 'MinimumVolume', 'MaximunVolume', 'Highend', 'Netpoint',
  'Applied on',
];

/** Excel serial → YYYY-MM-DD string. Serial 25569 == 1970-01-01 UTC. */
function excelSerialToIsoDate(serial) {
  if (serial === null || serial === undefined || serial === '') return null;
  const n = Number(serial);
  if (!Number.isFinite(n)) return String(serial); // already a date-like string
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Normalize the parsed Excel rows:
 *   - trim trailing spaces on keys ("Modal " → "Modal")
 *   - convert Excel serial dates in StartDate / EndDate to ISO strings
 *   - convert empty strings to null (cleaner JSON for the SP to consume)
 */
function normalizeRows(rawRows) {
  return rawRows.map(r => {
    const out = {};
    for (const rawKey of Object.keys(r)) {
      const key = String(rawKey).trim();
      let val = r[rawKey];
      if (val === '' || val === undefined) val = null;
      if ((key === 'StartDate' || key === 'EndDate') && val != null) {
        val = excelSerialToIsoDate(val);
      }
      out[key] = val;
    }
    return out;
  });
}

/**
 * POST /api/final-rates/upload
 * multipart/form-data, field name "file" — the rates_all.xlsx workbook.
 * Returns { success, rows_sent, sp_result } on success.
 */
router.post('/upload', async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded. Use field name "file".' });
    }

    // Parse workbook (first sheet)
    let rows;
    let headerList;
    try {
      const wb = XLSX.readFile(req.file.path);
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error('Workbook has no sheets');
      const ws = wb.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (aoa.length === 0) throw new Error('Sheet is empty');
      headerList = aoa[0].map(h => String(h).trim());

      // Validate headers — at least insurer+product+rate columns must exist
      const required = ['Insurer', 'VehicleType', 'ProductType'];
      const missing = required.filter(h => !headerList.includes(h));
      if (missing.length) {
        return res.status(400).json({
          success: false,
          error: `Missing required columns: ${missing.join(', ')}. Expected headers like: ${EXPECTED_HEADERS.slice(0, 8).join(', ')}...`,
        });
      }

      rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    } catch (err) {
      return res.status(400).json({ success: false, error: `Failed to parse Excel: ${err.message}` });
    }

    const normalized = normalizeRows(rows);

    // Chunk size — 47k-row payloads in one SP call were timing out at 120 s.
    // 2000 rows per call keeps each invocation well under a minute and the
    // driver keeps its connection responsive between batches.
    const chunkSize = Math.max(100, parseInt(req.query.chunk || req.body.chunk || '2000', 10));

    const pool = await getPrarambhUatPool();
    const batches = [];
    let totalPayload = 0;
    const started = Date.now();

    for (let i = 0; i < normalized.length; i += chunkSize) {
      const slice = normalized.slice(i, i + chunkSize);
      const json = JSON.stringify(slice);
      totalPayload += json.length;
      try {
        const t0 = Date.now();
        const req2 = pool.request();
        req2.timeout = 300000; // 5-minute per-batch ceiling
        const spResult = await req2
          .input('jsonData', sql.NVarChar(sql.MAX), json)
          .input('ExcelName', sql.NVarChar(255), req.file.originalname || req.file.filename || 'rates_upload.xlsx')
          .input('doneBy', sql.NVarChar(100), 'Admin')
          .execute('App_UPloadPointsdetails');
        batches.push({
          batch: batches.length + 1,
          from_row: i + 1,
          to_row: i + slice.length,
          rows: slice.length,
          ms: Date.now() - t0,
          return_value: spResult.returnValue,
          rowsAffected: spResult.rowsAffected,
          result: spResult.recordset || null,
        });
      } catch (err) {
        return res.status(500).json({
          success: false,
          error: `Stored procedure failed on batch ${batches.length + 1} (rows ${i + 1}-${i + slice.length}): ${err.message}`,
          rows_sent: i,
          rows_total: normalized.length,
          batches,
        });
      }
    }

    res.json({
      success: true,
      rows_sent: normalized.length,
      payload_bytes: totalPayload,
      batches_count: batches.length,
      chunk_size: chunkSize,
      elapsed_ms: Date.now() - started,
      batches,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
