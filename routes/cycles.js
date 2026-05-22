/**
 * routes/cycles.js — CRUD for user-defined payout cycles.
 *
 * A "cycle" is a named date window used across calculation screens to avoid
 * re-typing Mar 1–16 every time you want "March-1st-Cycle". Cycles can also
 * carry an optional allowlist of agent codes (`agent_codes_csv`); when set,
 * every calculation against that cycle is restricted to those agents.
 *
 *   GET    /api/cycles         → list active cycles
 *   POST   /api/cycles         → create { name, date_from, date_to, agent_codes? }
 *   PUT    /api/cycles/:id     → update name / dates / agent_codes
 *   DELETE /api/cycles/:id     → soft-delete (set active = 0)
 */
const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));   // some allowlists hold thousands of codes

/** Normalise a free-form agent-code input (string or array) into a clean
 *  uppercased CSV. Splits on comma, newline, semicolon, tab, or whitespace
 *  so the user can paste from anywhere. Empty input → null. */
function normaliseAgentCodes(input) {
  if (input == null || input === '') return null;
  let raw;
  if (Array.isArray(input)) raw = input.join(',');
  else raw = String(input);
  const codes = raw.split(/[\s,;\t\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toUpperCase());
  // Dedupe while preserving order so audit dumps stay stable.
  const seen = new Set();
  const out = [];
  for (const c of codes) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.length > 0 ? out.join(',') : null;
}

/** Parse a stored CSV back into a string array (handy for the client). */
function parseAgentCodes(csv) {
  if (!csv) return [];
  return String(csv).split(',').map(s => s.trim()).filter(Boolean);
}

/** GET /  — all active cycles. */
router.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT id, name, date_from, date_to, active, created_at, agent_codes_csv
       FROM payout_cycles
       WHERE active = 1
       ORDER BY date_from DESC, id DESC`
    );
    const cycles = r.recordset.map(c => {
      const codes = parseAgentCodes(c.agent_codes_csv);
      return {
        id: c.id, name: c.name, active: c.active, created_at: c.created_at,
        date_from: c.date_from instanceof Date ? c.date_from.toISOString().slice(0, 10) : c.date_from,
        date_to:   c.date_to   instanceof Date ? c.date_to.toISOString().slice(0, 10)   : c.date_to,
        agent_codes: codes,
        agent_codes_count: codes.length,
      };
    });
    res.json({ success: true, cycles });
  } catch (err) { next(err); }
});

function validatePayload(body) {
  const name = (body && body.name || '').toString().trim();
  const from = (body && body.date_from || '').toString().trim();
  const to   = (body && body.date_to   || '').toString().trim();
  if (!name) return 'name is required';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return 'date_from must be YYYY-MM-DD';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to))   return 'date_to must be YYYY-MM-DD';
  if (new Date(from) > new Date(to))     return 'date_from must be on or before date_to';
  return null;
}

/** POST /  — create a cycle. */
router.post('/', async (req, res, next) => {
  try {
    const err = validatePayload(req.body);
    if (err) return res.status(400).json({ success: false, error: err });
    const { name, date_from, date_to } = req.body;
    const codesCsv = normaliseAgentCodes(req.body.agent_codes);
    const pool = await getPool();
    const r = await pool.request()
      .input('name',      sql.NVarChar(200), name.trim())
      .input('date_from', sql.Date, new Date(date_from))
      .input('date_to',   sql.Date, new Date(date_to))
      .input('codes',     sql.NVarChar(sql.MAX), codesCsv)
      .query(
        `INSERT INTO payout_cycles (name, date_from, date_to, agent_codes_csv)
         OUTPUT INSERTED.id, INSERTED.name, INSERTED.date_from, INSERTED.date_to,
                INSERTED.active, INSERTED.created_at, INSERTED.agent_codes_csv
         VALUES (@name, @date_from, @date_to, @codes)`
      );
    const c = r.recordset[0];
    const codes = parseAgentCodes(c.agent_codes_csv);
    res.json({
      success: true,
      cycle: {
        id: c.id, name: c.name, active: c.active, created_at: c.created_at,
        date_from: c.date_from.toISOString().slice(0, 10),
        date_to:   c.date_to.toISOString().slice(0, 10),
        agent_codes: codes,
        agent_codes_count: codes.length,
      },
    });
  } catch (err) { next(err); }
});

/** PUT /:id — update a cycle. Supports updating name/dates/agent_codes; pass
 *  agent_codes: [] (or empty string) to clear the allowlist. */
router.put('/:id(\\d+)', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pool = await getPool();
    // Build SET list dynamically — agent_codes is independently updatable.
    const sets = [];
    const rq  = pool.request().input('id', sql.Int, id);
    if ('name' in (req.body || {}) || 'date_from' in (req.body || {}) || 'date_to' in (req.body || {})) {
      const err = validatePayload(req.body);
      if (err) return res.status(400).json({ success: false, error: err });
      sets.push('name = @name', 'date_from = @df', 'date_to = @dt');
      rq.input('name', sql.NVarChar(200), req.body.name.trim());
      rq.input('df',   sql.Date, new Date(req.body.date_from));
      rq.input('dt',   sql.Date, new Date(req.body.date_to));
    }
    if ('agent_codes' in (req.body || {})) {
      const codesCsv = normaliseAgentCodes(req.body.agent_codes);
      sets.push('agent_codes_csv = @codes');
      rq.input('codes', sql.NVarChar(sql.MAX), codesCsv);
    }
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'no fields to update' });
    const r = await rq.query(
      `UPDATE payout_cycles SET ${sets.join(', ')} WHERE id = @id AND active = 1`
    );
    if (r.rowsAffected[0] === 0) return res.status(404).json({ success: false, error: 'Cycle not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** DELETE /:id — soft-delete. */
router.delete('/:id(\\d+)', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query('UPDATE payout_cycles SET active = 0 WHERE id = @id');
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.parseAgentCodes = parseAgentCodes;
