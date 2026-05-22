/**
 * routes/company-margin.js — Company-wide margin baseline.
 *
 * A "company margin" is the expected default margin% the org wants applied
 * across all rate rules. Stored per scope:
 *
 *   GLOBAL  — fallback applied when no vehicle-type override exists
 *   CAR / TW / GCV / PCV / MISC — vehicle-type-specific overrides
 *
 * Endpoints (all under /api/company-margins):
 *   GET    /            → list of every scope row
 *   PUT    /:scope      → upsert  body: { margin_pct, notes? }
 *   DELETE /:scope      → remove (GLOBAL row is protected)
 *   GET    /exceptions  → margin_rules whose margin_pct differs from the
 *                          applicable company margin (scope match: vehicle
 *                          type → fall back to GLOBAL)
 */
const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const router = express.Router();
router.use(express.json());

const VALID_SCOPES = ['GLOBAL', 'CAR', 'TW', 'GCV', 'PCV', 'MISC'];

/** Map a margin_rule's filters_json → effective scope key. The Margins screen
 *  stores filters with a `searchProduct` like "Pvt car" / "TW" / "GCV" /
 *  "PCV" / "MISC". Anything else (including blank) collapses to GLOBAL. */
function scopeFromFilters(filters) {
  if (!filters) return 'GLOBAL';
  const p = String(filters.searchProduct || '').toUpperCase().replace(/\W+/g, '');
  if (p.includes('PVTCAR') || p === 'CAR' || p === '4W' || p === 'PC') return 'CAR';
  if (p === 'TW' || p === '2W' || p === 'TWEV') return 'TW';
  if (p === 'GCV') return 'GCV';
  if (p === 'PCV') return 'PCV';
  if (p === 'MIS' || p === 'MISC') return 'MISC';
  return 'GLOBAL';
}

/** Resolve company margin% for a given scope; falls back to GLOBAL when the
 *  vehicle-type-specific row isn't set. Returns { scope, margin_pct } or
 *  null if no GLOBAL is configured either. */
async function resolveCompanyMargin(pool, scope) {
  const r = await pool.request().query('SELECT scope_key, margin_pct FROM company_margins');
  const map = {};
  for (const row of r.recordset) map[row.scope_key] = Number(row.margin_pct);
  if (scope && map[scope] != null) return { scope, margin_pct: map[scope] };
  if (map.GLOBAL != null) return { scope: 'GLOBAL', margin_pct: map.GLOBAL };
  return null;
}

/** GET /  — list every scope row. */
router.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT scope_key, margin_pct, notes, updated_at, updated_by
       FROM company_margins
       ORDER BY (CASE WHEN scope_key = 'GLOBAL' THEN 0 ELSE 1 END), scope_key`
    );
    res.json({ success: true, count: r.recordset.length, margins: r.recordset });
  } catch (err) { next(err); }
});

/** PUT /:scope — upsert. */
router.put('/:scope', async (req, res, next) => {
  try {
    const scope = String(req.params.scope || '').toUpperCase().trim();
    if (!VALID_SCOPES.includes(scope)) {
      return res.status(400).json({ success: false, error: `Scope must be one of ${VALID_SCOPES.join(', ')}` });
    }
    const pct = req.body && req.body.margin_pct != null ? parseFloat(req.body.margin_pct) : NaN;
    if (!Number.isFinite(pct)) return res.status(400).json({ success: false, error: 'margin_pct required (number)' });
    if (pct < 0 || pct > 100) return res.status(400).json({ success: false, error: 'margin_pct must be 0–100' });
    const notes = (req.body && req.body.notes) || null;
    const pool = await getPool();
    await pool.request()
      .input('s',  sql.VarChar(50), scope)
      .input('p',  sql.Decimal(6, 3), pct)
      .input('n',  sql.NVarChar(500), notes)
      .input('by', sql.NVarChar(100), 'Admin')
      .query(`IF EXISTS (SELECT 1 FROM company_margins WHERE scope_key = @s)
                UPDATE company_margins SET margin_pct = @p, notes = @n, updated_at = GETDATE(), updated_by = @by WHERE scope_key = @s
              ELSE
                INSERT INTO company_margins (scope_key, margin_pct, notes, updated_by) VALUES (@s, @p, @n, @by)`);
    res.json({ success: true, scope, margin_pct: pct });
  } catch (err) { next(err); }
});

/** DELETE /:scope — remove a scope's override. GLOBAL is protected. */
router.delete('/:scope', async (req, res, next) => {
  try {
    const scope = String(req.params.scope || '').toUpperCase().trim();
    if (scope === 'GLOBAL') return res.status(400).json({ success: false, error: 'GLOBAL cannot be deleted (only updated)' });
    if (!VALID_SCOPES.includes(scope)) return res.status(400).json({ success: false, error: 'Invalid scope' });
    const pool = await getPool();
    await pool.request().input('s', sql.VarChar(50), scope)
      .query('DELETE FROM company_margins WHERE scope_key = @s');
    res.json({ success: true, scope });
  } catch (err) { next(err); }
});

/**
 * GET /exceptions — every saved margin_rule whose margin_pct deviates from
 * the applicable company margin (vehicle-type override → GLOBAL fallback).
 *
 * Response per row:
 *   { id, description, filters, margin_pct, scope, company_margin_pct,
 *     deviation, direction, severity }
 *
 * Severity buckets: <1pp delta = OK (filtered out), 1–3pp = LOW,
 * 3–5pp = MEDIUM, >5pp = HIGH.
 */
router.get('/exceptions', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT id, description, filters_json, margin_pct, created_at, updated_at, created_by
       FROM margin_rules
       WHERE active = 1
       ORDER BY id DESC`
    );
    const cmRows = await pool.request().query(
      `SELECT scope_key, margin_pct FROM company_margins`
    );
    const cm = {};
    for (const row of cmRows.recordset) cm[row.scope_key] = Number(row.margin_pct);
    const globalCm = cm.GLOBAL != null ? cm.GLOBAL : null;

    const exceptions = [];
    for (const m of r.recordset) {
      let filters = {};
      try { filters = JSON.parse(m.filters_json || '{}'); } catch (_) { /* ignore */ }
      const scope = scopeFromFilters(filters);
      const companyPct = cm[scope] != null ? cm[scope] : globalCm;
      const usedScope = cm[scope] != null ? scope : (globalCm != null ? 'GLOBAL' : null);
      const userPct = Number(m.margin_pct);
      const deviation = companyPct != null ? +(userPct - companyPct).toFixed(3) : null;
      const direction = deviation == null ? 'unset'
                      : deviation > 0  ? 'above'
                      : deviation < 0  ? 'below' : 'equal';
      const absDev = deviation != null ? Math.abs(deviation) : null;
      const severity = absDev == null ? 'unknown'
                     : absDev < 1 ? 'OK'
                     : absDev < 3 ? 'LOW'
                     : absDev < 5 ? 'MEDIUM'
                     : 'HIGH';
      exceptions.push({
        id: m.id,
        description: m.description,
        filters,
        scope,
        company_margin_pct: companyPct,
        company_margin_scope: usedScope,
        margin_pct: userPct,
        deviation,
        direction,
        severity,
        created_at: m.created_at,
        updated_at: m.updated_at,
        created_by: m.created_by,
      });
    }
    res.json({ success: true, count: exceptions.length, exceptions, company_margins: cm });
  } catch (err) { next(err); }
});

module.exports = router;
