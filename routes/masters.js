/**
 * routes/masters.js — Read-only master data for the Masters menu.
 *
 *   GET /api/masters/insurers   → insurers + plans (from rate_cards + config/insurers)
 *   GET /api/masters/branches   → branch / sub-branch tree (from Beeinsured TMP_MAAGENT)
 *   GET /api/masters/poscodes   → POS codes (from Beeinsured tmp_poscodes)
 *
 * All endpoints aggregate enough fields to fill a table in the UI without
 * leaking raw PII; the Beeinsured pool is the same one used by the bulk
 * agent-enrichment pipeline.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { getPool } = require('../db/connection');
const { getBeeinsuredPool } = require('../db/beeinsured-connection');
const { getPrarambhPool }    = require('../db/prarambh-connection');

const router = express.Router();

/** GET /probe/insurance-plans — find which DB hosts vw_InsurancePlans. */
router.get('/probe/insurance-plans', async (req, res, next) => {
  try {
    const out = {};
    const probe = async (label, getter) => {
      try {
        const p = await getter();
        const cols = await p.request().query(
          `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_NAME = 'vw_InsurancePlans' ORDER BY ORDINAL_POSITION`);
        if (cols.recordset.length > 0) {
          const cnt = await p.request().query('SELECT COUNT(*) AS n FROM vw_InsurancePlans');
          const sample = await p.request().query('SELECT TOP 3 * FROM vw_InsurancePlans');
          out[label] = { columns: cols.recordset, count: cnt.recordset[0].n, sample: sample.recordset };
        }
      } catch (e) { out[label] = { error: e.message }; }
    };
    await probe('beeinsured', () => require('../db/beeinsured-connection').getBeeinsuredPool());
    try { await probe('prarambh_uat', () => require('../db/prarambh-uat-connection').getPrarambhUatPool()); } catch (_) {}
    res.json({ success: true, ...out });
  } catch (err) { next(err); }
});

/** GET /insurers — distinct insurers from rate_cards joined with the on-disk
 *  config (which carries the display name + sheet/plan layout). */
router.get('/insurers', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cards = await pool.request().query(
      `SELECT insurer,
              COUNT(*) AS card_count,
              MAX(uploaded_at) AS last_uploaded,
              MAX(effective_from) AS latest_effective
       FROM rate_cards
       WHERE status = 'active'
       GROUP BY insurer
       ORDER BY insurer`
    );
    const rules = await pool.request().query(
      `SELECT insurer, COUNT(*) AS rule_count, COUNT(DISTINCT product) AS product_count
       FROM rate_rules GROUP BY insurer`
    );
    const ruleByIns = new Map(rules.recordset.map(r => [r.insurer, r]));

    // Sniff config/insurers/*.json for display name + sheet (plan) list.
    const configDir = path.resolve(__dirname, '..', 'config', 'insurers');
    const configByInsurer = {};
    if (fs.existsSync(configDir)) {
      for (const f of fs.readdirSync(configDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const c = JSON.parse(fs.readFileSync(path.join(configDir, f), 'utf8'));
          const slug = (c.insurer || f.replace(/\.json$/, '')).toLowerCase();
          configByInsurer[slug] = {
            display_name: c.display_name || c.insurer || slug,
            plans: (c.sheets || []).map(s => ({
              name: s.name,
              product: (s.config && s.config.product) || null,
              layout: s.layout || null,
            })),
          };
        } catch { /* ignore unreadable config */ }
      }
    }

    const insurers = cards.recordset.map(r => {
      const cfg = configByInsurer[String(r.insurer).toLowerCase()] || {};
      const rs  = ruleByIns.get(r.insurer) || { rule_count: 0, product_count: 0 };
      return {
        insurer_slug:  r.insurer,
        display_name:  cfg.display_name || r.insurer,
        rate_cards:    r.card_count,
        latest_effective: r.latest_effective,
        last_uploaded: r.last_uploaded,
        rule_count:    rs.rule_count,
        product_count: rs.product_count,
        plans:         cfg.plans || [],
      };
    });
    res.json({ success: true, count: insurers.length, insurers });
  } catch (err) { next(err); }
});

/** Best-guess label for ProductType_Id — derived by inspecting the actual
 *  Category/PlanName distribution per id. Unknown ids fall back to the raw
 *  number so it's still informative. */
const PRODUCT_TYPE_LABELS = {
  0:  'Unspecified',
  1:  'Comprehensive',
  2:  'SAOD',
  3:  'Third Party',
  5:  'Specialty / Group',
  11: 'Term Insurance',
  15: 'ULIP / Life Variant',
  91: 'Mutual Fund (Equity)',
  92: 'Mutual Fund (Debt)',
};

/** GET /insurance-plans — bound to Beeinsured_v3_2.dbo.vw_InsurancePlans.
 *  Powers the Insurer & Plans master screen.
 *
 *   Query params (all optional, all combined with AND):
 *     ?insurer=<short or full name substring>
 *     ?category=<exact category>
 *     ?product_type_id=<int>
 *     ?active=1   → only rows with showinprarambh = 1
 *     ?q=<free text — searches Plan + Insurer + Category>
 *     ?limit=5000 (max 50000)
 */
router.get('/insurance-plans', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '5000', 10) || 5000, 50000);
    // vw_InsurancePlans is sourced from Prarambh_Live per the user request.
    // Note: column names on Prarambh_Live differ slightly from the Beeinsured
    // copy (lowercase `t` in Producttype_id, capital P in showinPrarambh, and
    // the Live view exposes a precomputed ProductTypeName so we don't need a
    // hand-coded id→label map).
    const pool = await getPrarambhPool();
    const rq = pool.request().input('lim', limit);
    // CategoryId 82 = Mutual Funds — explicitly out of scope for the
    // insurance-ops master, even though the source view exposes them.
    const where = ['(CategoryId IS NULL OR CategoryId <> 82)'];
    if (req.query.insurer) {
      rq.input('ins', '%' + req.query.insurer + '%');
      where.push('(InsurerName LIKE @ins OR shortname LIKE @ins)');
    }
    if (req.query.category) { rq.input('cat', req.query.category); where.push('Category = @cat'); }
    if (req.query.product_type_id != null && req.query.product_type_id !== '') {
      rq.input('pt', parseInt(req.query.product_type_id, 10));
      where.push('Producttype_id = @pt');
    }
    if (req.query.active === '1') where.push('showinPrarambh = 1');
    if (req.query.q) {
      rq.input('q', '%' + req.query.q + '%');
      where.push('(PlanName LIKE @q OR InsurerName LIKE @q OR Category LIKE @q OR PlanUniqueCode LIKE @q OR ProductCode LIKE @q OR InsurerPlanname LIKE @q)');
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const r = await rq.query(
      `SELECT TOP (@lim)
              InsurerName, shortname AS InsurerShortName, Category, CategoryId,
              PlanId, PlanName, InsurerPlanname, PlanUniqueCode, ProductCode,
              IsPlanActive, IsInsurerActive, showinPrarambh AS showinprarambh,
              Producttype_id AS ProductType_Id, ProductTypeName
       FROM vw_InsurancePlans ${whereSql}
       ORDER BY InsurerName, Category, PlanName`
    );
    const plans = r.recordset.map(p => ({
      ...p,
      is_active_in_prarambh: p.showinprarambh === 1,
      // Use the view's own ProductTypeName when present, fall back to the
      // hand-coded label, fall back to "Type N".
      product_type_label: p.ProductTypeName
        || PRODUCT_TYPE_LABELS[p.ProductType_Id]
        || (p.ProductType_Id != null ? `Type ${p.ProductType_Id}` : null),
    }));
    res.json({ success: true, count: plans.length, plans });
  } catch (err) { next(err); }
});

/** GET /insurance-plans/filters — distinct categories + product type ids,
 *  used to populate the dropdowns on the Insurer & Plans tab. */
router.get('/insurance-plans/filters', async (req, res, next) => {
  try {
    const pool = await getPrarambhPool();
    // Same exclusion as /insurance-plans — Mutual Funds (CategoryId 82) are
    // out of scope for the insurance-ops master.
    const EXC = `(CategoryId IS NULL OR CategoryId <> 82)`;
    const cats = await pool.request().query(
      `SELECT CategoryId AS id, MAX(Category) AS name, COUNT(*) AS n
       FROM vw_InsurancePlans
       WHERE Category IS NOT NULL AND Category <> '' AND ${EXC}
       GROUP BY CategoryId
       ORDER BY MAX(Category)`
    );
    const pts  = await pool.request().query(
      `SELECT Producttype_id AS id, MAX(ProductTypeName) AS name, COUNT(*) AS n
       FROM vw_InsurancePlans
       WHERE Producttype_id IS NOT NULL AND ${EXC}
       GROUP BY Producttype_id ORDER BY Producttype_id`
    );
    const insurers = await pool.request().query(
      `SELECT InsurerId AS id, MAX(InsurerName) AS name, MAX(shortname) AS short_name, COUNT(*) AS n
       FROM vw_InsurancePlans
       WHERE InsurerName IS NOT NULL AND ${EXC}
       GROUP BY InsurerId
       ORDER BY MAX(InsurerName)`
    );
    res.json({
      success: true,
      categories: cats.recordset.map(r => ({ id: r.id, name: r.name, count: r.n })),
      product_types: pts.recordset.map(r => ({
        id: r.id, count: r.n,
        label: r.name || PRODUCT_TYPE_LABELS[r.id] || `Type ${r.id}`,
      })),
      insurers: insurers.recordset.map(r => ({
        id: r.id, name: r.name, short_name: r.short_name, count: r.n,
      })),
    });
  } catch (err) { next(err); }
});

/**
 * POST /insurance-plans  body: { insurer_id, category_id, plan_name,
 *                                product_type_id?, plan_unique_code?,
 *                                insurer_plan_name? }
 *
 * Inserts a new row into Prarambh_Live.dbo.RH_InsPlanMast with sensible
 * defaults: IsActive = 1, ShowInPrarambh = 1, DOE = GETDATE(),
 * DoneBy = 'RateExtract'. PLANid is set to MAX(PLANid)+1 inside a
 * transaction (the column isn't an identity).
 */
router.post('/insurance-plans', express.json(), async (req, res, next) => {
  try {
    const sql = require('mssql');
    const b = req.body || {};
    const insurerId  = parseInt(b.insurer_id,  10);
    const categoryId = parseInt(b.category_id, 10);
    const planName   = String(b.plan_name || '').trim();
    if (!insurerId)  return res.status(400).json({ success: false, error: 'insurer_id required'  });
    if (!categoryId) return res.status(400).json({ success: false, error: 'category_id required' });
    if (!planName)   return res.status(400).json({ success: false, error: 'plan_name required'   });

    const productTypeId = b.product_type_id != null && b.product_type_id !== ''
      ? parseInt(b.product_type_id, 10) : null;
    const uniqueCode    = b.plan_unique_code ? String(b.plan_unique_code).trim() : null;
    const insurerPlanName = b.insurer_plan_name ? String(b.insurer_plan_name).trim() : null;

    const pool = await getPrarambhPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const next = await new sql.Request(tx).query(
        `SELECT ISNULL(MAX(PLANid), 0) + 1 AS next_id FROM RH_InsPlanMast`
      );
      const nextId = next.recordset[0].next_id;
      await new sql.Request(tx)
        .input('id',   sql.Int, nextId)
        .input('ins',  sql.Int, insurerId)
        .input('cat',  sql.Int, categoryId)
        .input('name', sql.NVarChar(500), planName)
        .input('uc',   sql.NVarChar(200), uniqueCode)
        .input('pt',   sql.Int, productTypeId)
        .input('ipn',  sql.NVarChar(500), insurerPlanName)
        .input('by',   sql.NVarChar(100), 'RateExtract')
        .query(`INSERT INTO RH_InsPlanMast
                  (PLANid, InsId, CategoryId, PlanName, PlanUniqueCode,
                   IsActive, DOE, DoneBy, ShowInPrarambh, ProductType_Id,
                   InsurerPlanname)
                VALUES (@id, @ins, @cat, @name, @uc,
                        1, GETDATE(), @by, 1, @pt,
                        @ipn)`);
      await tx.commit();
      res.json({ success: true, plan_id: nextId, plan_name: planName });
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* noop */ }
      throw err;
    }
  } catch (err) { next(err); }
});

/**
 * PUT /insurance-plans/:planId/active   body: { active: true|false }
 * Toggles a plan's status in Prarambh_Live.dbo.RH_InsPlanMast.
 * Both flags move together (per the user spec):
 *   active = false → IsActive = 0, ShowInPrarambh = 0
 *   active = true  → IsActive = 1, ShowInPrarambh = 1
 * Returns the updated row count + new flag values.
 */
router.put('/insurance-plans/:planId(\\d+)/active', express.json(), async (req, res, next) => {
  try {
    const planId = Number(req.params.planId);
    const active = !!(req.body && req.body.active);
    if (!planId) return res.status(400).json({ success: false, error: 'planId required' });

    const sql = require('mssql');
    const pool = await getPrarambhPool();
    const r = await pool.request()
      .input('id',  sql.Int, planId)
      .input('val', sql.Int, active ? 1 : 0)
      .input('by',  sql.NVarChar(100), 'RateExtract')
      .query(`UPDATE RH_InsPlanMast
              SET IsActive       = @val,
                  ShowInPrarambh = @val,
                  ModifiedDate   = GETDATE(),
                  ModifiedBy     = @by
              WHERE PLANid = @id`);
    if (r.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, error: `Plan ${planId} not found in RH_InsPlanMast` });
    }
    res.json({ success: true, plan_id: planId, active, updated: r.rowsAffected[0] });
  } catch (err) { next(err); }
});

/** GET /branches — bound to Prarambh_Live.dbo.vwVerticalBranchSubBranch.
 *  Returns one row per (branch, sub-branch) pair with the columns the UI
 *  table renders (vertical / branch / sub-branch / tracker_code) plus the
 *  IDs + active flags it needs to drive the edit & deactivate actions. */
router.get('/branches', async (req, res, next) => {
  try {
    const pool = await getPrarambhPool();
    const r = await pool.request().query(
      `SELECT Verticalid, Vertical, VerticalCode,
              Branchid, Location, MIS_BranchName,
              SubBranchId, Sub_Location, MIS_SubBranch, MISSubbranchname,
              Tracker_Code, Tracker_Prefix, Zone AS zone,
              isactive, isactivesubbranch
       FROM vwVerticalBranchSubBranch
       ORDER BY Vertical, Location, Sub_Location`
    );
    const rows = r.recordset.map(x => ({
      vertical_id: x.Verticalid,
      vertical: x.Vertical,
      vertical_code: x.VerticalCode,
      branch_id: x.Branchid,
      branch_name: x.Location,             // primary editable name
      branch_display: x.MIS_BranchName,    // longer label "Vertical - Location"
      sub_branch_id: x.SubBranchId,
      sub_branch_name: x.Sub_Location,
      sub_branch_display: x.MISSubbranchname || x.MIS_SubBranch,
      tracker_code: x.Tracker_Code,
      tracker_prefix: x.Tracker_Prefix,
      zone: x.zone,
      branch_active:     x.isactive === 1,
      sub_branch_active: x.isactivesubbranch === 1,
    }));
    res.json({ success: true, count: rows.length, rows });
  } catch (err) { next(err); }
});

/**
 * PUT /branches/:branchId  body: { name?, active? }
 * Writes to Prarambh_Live.dbo.MST_SalesBranch.
 */
router.put('/branches/:branchId(\\d+)', express.json(), async (req, res, next) => {
  try {
    const sql = require('mssql');
    const id = Number(req.params.branchId);
    const { name, active } = req.body || {};
    const sets = [];
    const rq = (await getPrarambhPool()).request().input('id', sql.Int, id);
    if (name != null) {
      const n = String(name).trim();
      if (!n) return res.status(400).json({ success: false, error: 'name cannot be empty' });
      sets.push('Location = @nm');
      rq.input('nm', sql.NVarChar(200), n);
    }
    if (active != null) {
      sets.push('IsActive = @ac');
      rq.input('ac', sql.Int, active ? 1 : 0);
    }
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'name and/or active required' });
    const r = await rq.query(`UPDATE MST_SalesBranch SET ${sets.join(', ')} WHERE ID = @id`);
    if (r.rowsAffected[0] === 0) return res.status(404).json({ success: false, error: 'Branch not found' });
    res.json({ success: true, branch_id: id });
  } catch (err) { next(err); }
});

/**
 * PUT /sub-branches/:subBranchId  body: { name?, active? }
 * Writes to Prarambh_Live.dbo.MST_SalesSubBranch.
 */
router.put('/sub-branches/:subBranchId(\\d+)', express.json(), async (req, res, next) => {
  try {
    const sql = require('mssql');
    const id = Number(req.params.subBranchId);
    const { name, active } = req.body || {};
    const sets = [];
    const rq = (await getPrarambhPool()).request().input('id', sql.Int, id);
    if (name != null) {
      const n = String(name).trim();
      if (!n) return res.status(400).json({ success: false, error: 'name cannot be empty' });
      sets.push('Sub_Location = @nm');
      rq.input('nm', sql.NVarChar(200), n);
    }
    if (active != null) {
      sets.push('IsActive = @ac');
      rq.input('ac', sql.Int, active ? 1 : 0);
    }
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'name and/or active required' });
    const r = await rq.query(`UPDATE MST_SalesSubBranch SET ${sets.join(', ')} WHERE ID = @id`);
    if (r.rowsAffected[0] === 0) return res.status(404).json({ success: false, error: 'Sub-branch not found' });
    res.json({ success: true, sub_branch_id: id });
  } catch (err) { next(err); }
});

/** GET /poscodes — full POS-code master from Beeinsured. Capped to keep the
 *  payload small; the UI does client-side filter. */
router.get('/poscodes', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '5000', 10) || 5000, 50000);
    const q = String(req.query.q || '').trim();
    // tmp_poscodes lives only on Beeinsured_v3_2 (it's the canonical POS
    // master used by the bulk agent-enrichment pipeline). An earlier
    // search/replace accidentally swapped this to the Prarambh pool — keep
    // it on Beeinsured.
    const pool = await getBeeinsuredPool();
    const rq = pool.request().input('lim', limit);
    let where = `WHERE upincode IS NOT NULL AND upincode <> ''`;
    if (q) {
      rq.input('q', '%' + q + '%');
      where += ` AND (upincode LIKE @q OR posfullname LIKE @q OR pancard LIKE @q)`;
    }
    const r = await rq.query(
      `SELECT TOP (@lim) upincode, posfullname, status, pancard,
                            state, city, pin, livedate, deactivateddate,
                            referal_code
       FROM dbo.tmp_poscodes ${where}
       ORDER BY upincode`
    );
    // Derive an "effective_status" so the UI can show 'De-active' whenever
    // deactivateddate is populated, regardless of what the source `status`
    // column says.
    const poscodes = r.recordset.map(p => ({
      ...p,
      effective_status: p.deactivateddate ? 'De-active' : (p.status || ''),
    }));
    res.json({ success: true, count: poscodes.length, poscodes });
  } catch (err) { next(err); }
});

/**
 * PUT /poscodes/:upincode  body: { referal_code }
 * Updates the referal code on Beeinsured_v3_2.dbo.tmp_poscodes for one POS.
 * Pass null / empty string to clear it.
 */
router.put('/poscodes/:upincode', express.json(), async (req, res, next) => {
  try {
    const sql = require('mssql');
    const upin = String(req.params.upincode || '').trim();
    if (!upin) return res.status(400).json({ success: false, error: 'upincode required' });
    if (!('referal_code' in (req.body || {}))) {
      return res.status(400).json({ success: false, error: 'referal_code required' });
    }
    const ref = req.body.referal_code == null || req.body.referal_code === ''
      ? null
      : String(req.body.referal_code).trim();
    const pool = await getBeeinsuredPool();
    const r = await pool.request()
      .input('upin', sql.NVarChar(100), upin)
      .input('ref',  sql.NVarChar(200), ref)
      .query(`UPDATE dbo.tmp_poscodes
              SET referal_code = @ref
              WHERE upincode = @upin`);
    if (r.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, error: 'POS code not found' });
    }
    res.json({ success: true, upincode: upin, referal_code: ref });
  } catch (err) { next(err); }
});

module.exports = router;
