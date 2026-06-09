'use strict';

/**
 * Enabler / special-payout deal management.
 *
 *   POST /api/enablers/parse   — upload .eml/.msg → parsed draft (preview, no save)
 *   POST /api/enablers/save    — persist a confirmed deal (header + rows)
 *   GET  /api/enablers         — list active deal rows
 *   POST /api/enablers/:id/deactivate — soft-delete one row
 *   POST /api/enablers/deal/:dealId/deactivate — soft-delete a whole deal
 *
 * Each saved row is one (rto_location, coa_pct) line; the engine applies the COA%
 * as the income rate to policies matching the deal's criteria (services/enablers.js).
 */

const express = require('express');
const multer = require('multer');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { parseEnablerEmail } = require('../services/enabler-parse');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---- Parse an uploaded .eml/.msg into a preview draft (no DB write) ----
router.post('/parse', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'Email file (.eml/.msg) required' });
    const draft = await parseEnablerEmail(req.file.buffer, req.file.originalname);
    res.json({ success: true, filename: req.file.originalname, ...draft });
  } catch (e) { next(e); }
});

// ---- Save a confirmed deal: header + rows[] → enabler_overrides ----
router.post('/save', express.json({ limit: '5mb' }), async (req, res, next) => {
  try {
    const { header = {}, rows = [], source_file = null, created_by = 'web' } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, error: 'At least one deal row is required' });
    }
    const pool = await getPool();
    const dealId = header.deal_id || header.imd_code || ('DEAL-' + Date.now());
    let inserted = 0;
    for (const r of rows) {
      const coa = r.coa_pct != null && r.coa_pct !== '' ? Number(r.coa_pct) : null;
      if (coa == null) continue;                       // a row with no payout is meaningless
      await pool.request()
        .input('deal_id', sql.NVarChar, dealId)
        .input('imd_code', sql.NVarChar, header.imd_code || null)
        .input('segment', sql.NVarChar, header.segment || null)
        .input('vehicle_type', sql.NVarChar, header.vehicle_type || null)
        .input('is_3w', sql.Bit, header.is_3w ? 1 : null)
        .input('is_electric', sql.Bit, header.is_electric ? 1 : null)
        .input('make', sql.NVarChar, r.make || header.make || null)
        .input('transaction_type', sql.NVarChar, r.transaction_type || null)
        .input('is_new', sql.Bit, r.is_new ? 1 : null)
        .input('rto_location', sql.NVarChar, r.rto_location || null)
        .input('coa_pct', sql.Decimal(7, 3), coa)
        .input('discount_pct', sql.Decimal(7, 3), r.discount_pct != null && r.discount_pct !== '' ? Number(r.discount_pct) : null)
        .input('window_from', sql.Date, header.window_from || null)
        .input('window_to', sql.Date, header.window_to || null)
        .input('source_file', sql.NVarChar, source_file || null)
        .input('created_by', sql.NVarChar, created_by)
        .query(`INSERT INTO enabler_overrides
          (deal_id, imd_code, segment, vehicle_type, is_3w, is_electric, make,
           transaction_type, is_new, rto_location, coa_pct, discount_pct,
           window_from, window_to, source_file, created_by, active)
          VALUES (@deal_id, @imd_code, @segment, @vehicle_type, @is_3w, @is_electric,
           @make, @transaction_type, @is_new, @rto_location, @coa_pct, @discount_pct,
           @window_from, @window_to, @source_file, @created_by, 1)`);
      inserted++;
    }
    res.json({ success: true, deal_id: dealId, inserted });
  } catch (e) { next(e); }
});

// ---- List active deal rows (newest first) ----
router.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT id, deal_id, imd_code, segment, vehicle_type, is_3w, is_electric, make,
              transaction_type, is_new, rto_location, coa_pct, discount_pct,
              CONVERT(varchar(10), window_from, 23) window_from,
              CONVERT(varchar(10), window_to, 23) window_to,
              source_file, created_by, CONVERT(varchar(19), created_at, 120) created_at
       FROM enabler_overrides WHERE active = 1 ORDER BY id DESC`);
    res.json({ success: true, rows: r.recordset });
  } catch (e) { next(e); }
});

// ---- Deactivate one row ----
router.post('/:id(\\d+)/deactivate', async (req, res, next) => {
  try {
    const pool = await getPool();
    await pool.request().input('id', sql.Int, Number(req.params.id))
      .query(`UPDATE enabler_overrides SET active = 0 WHERE id = @id`);
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ---- Deactivate a whole deal ----
router.post('/deal/:dealId/deactivate', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().input('d', sql.NVarChar, req.params.dealId)
      .query(`UPDATE enabler_overrides SET active = 0 WHERE deal_id = @d AND active = 1`);
    res.json({ success: true, deactivated: r.rowsAffected[0] });
  } catch (e) { next(e); }
});

module.exports = router;
