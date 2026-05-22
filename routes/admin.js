/**
 * routes/admin.js — Admin panel endpoints.
 *
 *  1) POST /api/admin/wipe-transactional
 *     Wipes ALL app data except the admin settings file:
 *       - rate_cards, rate_rules, conditional_rates, rto_mappings
 *       - margin_rules
 *       - statement_uploads, statement_rows
 *       - pr_uploads, pr_rows
 *     Requires { confirm: 'WIPE' } in the body to prevent accidents.
 *
 *  2) GET  /api/admin/menu-settings   → { tabs: { [key]: boolean } }
 *     PUT  /api/admin/menu-settings   body: { tabs: { [key]: boolean } }
 *     Persisted to config/admin-settings.json. Missing keys default to true.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const router = express.Router();

const SETTINGS_FILE = path.join(__dirname, '..', 'config', 'admin-settings.json');

// Canonical tab keys used by index.html (kept in sync with .tabs list)
const TAB_KEYS = [
  'upload', 'search', 'margins', 'statements', 'pr',
  'bulk', 'payout', 'calculate', 'policy', 'cards', 'final',
  'masters',
  'utr',
  'margin-exceptions',
];

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { tabs: {} };
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { tabs: parsed.tabs || {} };
  } catch (e) {
    console.error('[admin] readSettings failed:', e.message);
    return { tabs: {} };
  }
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

/** GET — merged with defaults so every known tab has a boolean. */
router.get('/menu-settings', (req, res) => {
  const saved = readSettings().tabs;
  const tabs = {};
  for (const k of TAB_KEYS) tabs[k] = saved[k] !== false;   // default visible
  res.json({ success: true, tabs, known_keys: TAB_KEYS });
});

/** PUT — replace tab visibility map. */
router.put('/menu-settings', express.json(), (req, res) => {
  const incoming = (req.body && req.body.tabs) || {};
  const tabs = {};
  for (const k of TAB_KEYS) {
    tabs[k] = incoming[k] !== false;
  }
  writeSettings({ tabs, updated_at: new Date().toISOString() });
  res.json({ success: true, tabs });
});

/**
 * POST /wipe-transactional
 * Body: { confirm: 'WIPE' }
 *
 * Deletes (children first to respect FKs):
 *   - conditional_rates  → rate_rules → rate_cards
 *   - rto_mappings
 *   - margin_rules
 *   - statement_rows → statement_uploads
 *   - pr_rows → pr_uploads
 */
router.post('/wipe-transactional', express.json(), async (req, res, next) => {
  try {
    if (!req.body || req.body.confirm !== 'WIPE') {
      return res.status(400).json({
        success: false,
        error: 'Confirmation required: send { "confirm": "WIPE" } in body.',
      });
    }
    const pool = await getPool();

    const TABLES = [
      'conditional_rates',
      'rate_rules',
      'rto_mappings',
      'rate_cards',
      'margin_rules',
      'statement_rows',
      'statement_uploads',
      'pr_rows',
      'pr_uploads',
      'cycle_bulk_rows',
      'cycle_runs',
      'payout_cycles',
      'excluded_policies',
      'agent_recoveries',
      'utr_uploads',
      'company_margins',
    ];

    const countQ = async (table) => {
      try {
        const r = await pool.request().query(`SELECT COUNT(*) AS n FROM ${table}`);
        return r.recordset[0].n;
      } catch { return null; }
    };

    const before = {};
    for (const t of TABLES) before[t] = await countQ(t);

    // Delete in FK-safe order inside a single transaction.
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const rq = () => new sql.Request(tx);
      // rate_rules children first
      await rq().query('DELETE FROM conditional_rates');
      await rq().query('DELETE FROM rate_rules');
      await rq().query('DELETE FROM rto_mappings');
      await rq().query('DELETE FROM rate_cards');
      await rq().query('DELETE FROM margin_rules');
      // statements
      await rq().query('DELETE FROM statement_rows');
      await rq().query('DELETE FROM statement_uploads');
      // premium register
      await rq().query('DELETE FROM pr_rows');
      await rq().query('DELETE FROM pr_uploads');
      // cycles (children first)
      await rq().query('DELETE FROM cycle_bulk_rows');
      await rq().query('DELETE FROM cycle_runs');
      await rq().query('DELETE FROM payout_cycles');
      await rq().query('DELETE FROM excluded_policies');
      await rq().query('DELETE FROM agent_recoveries');
      await rq().query('DELETE FROM utr_uploads');
      await rq().query('DELETE FROM company_margins');
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* noop */ }
      throw err;
    }

    const after = {};
    for (const t of TABLES) after[t] = await countQ(t);

    const deleted = {};
    for (const t of TABLES) deleted[t] = (before[t] || 0) - (after[t] || 0);

    res.json({
      success: true,
      deleted,
      remaining: after,
      wiped_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
