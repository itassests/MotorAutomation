'use strict';

/**
 * Fleet rate-override management.
 *
 *   GET  /api/fleets                  — list active fleet deals
 *   POST /api/fleets/save             — create a fleet deal (insurer + customer + rate)
 *   POST /api/fleets/:id/deactivate   — soft-delete one fleet deal
 *
 * A fleet deal applies a FLAT rate to every policy of an insurer whose customer
 * (proposer) name matches — see services/fleets.js.
 */

const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const router = express.Router();

// ---- List active fleet deals ----
router.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT id, insurer_slug, fleet_name, customer_name, vehicle_type, rate_pct,
              note, created_by, created_at
       FROM fleet_overrides WHERE active = 1 ORDER BY insurer_slug, customer_name`);
    res.json({ success: true, fleets: r.recordset || [] });
  } catch (e) { next(e); }
});

// ---- Create a fleet deal ----
router.post('/save', express.json({ limit: '256kb' }), async (req, res, next) => {
  try {
    const b = req.body || {};
    const insurer = String(b.insurer_slug || '').trim();
    const customer = String(b.customer_name || '').trim();
    const rate = b.rate_pct != null && b.rate_pct !== '' ? Number(b.rate_pct) : null;
    if (!insurer) return res.status(400).json({ success: false, error: 'Insurer is required' });
    if (!customer) return res.status(400).json({ success: false, error: 'Customer name is required' });
    if (rate == null || !Number.isFinite(rate)) return res.status(400).json({ success: false, error: 'A numeric rate % is required' });
    const pool = await getPool();
    const ins = await pool.request()
      .input('insurer_slug', sql.NVarChar, insurer)
      .input('fleet_name', sql.NVarChar, String(b.fleet_name || '').trim() || null)
      .input('customer_name', sql.NVarChar, customer)
      .input('vehicle_type', sql.NVarChar, String(b.vehicle_type || '').trim() || null)
      .input('rate_pct', sql.Decimal(7, 3), rate)
      .input('note', sql.NVarChar, String(b.note || '').trim() || null)
      .input('created_by', sql.NVarChar, String(b.created_by || 'web').trim())
      .query(
        `INSERT INTO fleet_overrides (insurer_slug, fleet_name, customer_name, vehicle_type, rate_pct, note, created_by, active, created_at)
         OUTPUT INSERTED.id
         VALUES (@insurer_slug, @fleet_name, @customer_name, @vehicle_type, @rate_pct, @note, @created_by, 1, GETDATE())`);
    res.json({ success: true, id: ins.recordset[0] && ins.recordset[0].id });
  } catch (e) { next(e); }
});

// ---- Update one fleet deal ----
router.post('/:id/update', express.json({ limit: '256kb' }), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Bad id' });
    const b = req.body || {};
    const insurer = String(b.insurer_slug || '').trim();
    const customer = String(b.customer_name || '').trim();
    const rate = b.rate_pct != null && b.rate_pct !== '' ? Number(b.rate_pct) : null;
    if (!insurer) return res.status(400).json({ success: false, error: 'Insurer is required' });
    if (!customer) return res.status(400).json({ success: false, error: 'Customer name is required' });
    if (rate == null || !Number.isFinite(rate)) return res.status(400).json({ success: false, error: 'A numeric rate % is required' });
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('insurer_slug', sql.NVarChar, insurer)
      .input('fleet_name', sql.NVarChar, String(b.fleet_name || '').trim() || null)
      .input('customer_name', sql.NVarChar, customer)
      .input('vehicle_type', sql.NVarChar, String(b.vehicle_type || '').trim() || null)
      .input('rate_pct', sql.Decimal(7, 3), rate)
      .input('note', sql.NVarChar, String(b.note || '').trim() || null)
      .query(
        `UPDATE fleet_overrides
            SET insurer_slug = @insurer_slug, fleet_name = @fleet_name, customer_name = @customer_name,
                vehicle_type = @vehicle_type, rate_pct = @rate_pct, note = @note
          WHERE id = @id AND active = 1`);
    if (!r.rowsAffected || !r.rowsAffected[0]) return res.status(404).json({ success: false, error: 'Fleet rate not found' });
    res.json({ success: true, id });
  } catch (e) { next(e); }
});

// ---- Soft-delete one fleet deal ----
router.post('/:id/deactivate', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Bad id' });
    const pool = await getPool();
    await pool.request().input('id', sql.Int, id)
      .query(`UPDATE fleet_overrides SET active = 0 WHERE id = @id`);
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
