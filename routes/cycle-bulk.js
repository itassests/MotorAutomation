/**
 * routes/cycle-bulk.js — Persistent per-cycle bulk calculation snapshots.
 *
 * Why:
 *   The live Bulk Calculation endpoint recomputes every row from tmp_PrarambhData
 *   on every hit. That's fine for ad-hoc "try a range" runs but unusable when you
 *   want stable, editable payout data for a specific cycle — e.g. edit an
 *   outgoing % on row X, exclude row Y from the current cycle, or move row Z to
 *   next cycle.
 *
 *   This module persists computed rows keyed by (cycle_id, policy_no) in
 *   cycle_bulk_rows, and applies row-level overrides (rate / margin / outgoing %,
 *   excluded, moved, note) on every read.
 *
 * Endpoints (all under /api/cycle-bulk):
 *
 *   GET    /:cycleId                          → { stored: bool, rows?, totals?, computed_at? }
 *   POST   /:cycleId/calculate  body:{insurer_slug?, limit?}
 *                                             → runs bulk using the cycle's date_from/date_to,
 *                                               stores the snapshot, returns rows/totals.
 *   POST   /:cycleId/recompute  body:{insurer_slug?, limit?}
 *                                             → wipe existing snapshot + recompute.
 *   PUT    /:cycleId/rows/:policyNo  body:{ rate_pct_override?, margin_pct_override?,
 *                                           outgoing_pct_override?, excluded?, note? }
 *                                             → patch row overrides. Null clears an override.
 *   POST   /:cycleId/rows/:policyNo/move  body:{ target_cycle_id }
 *                                             → mark source row as moved; copy row into target
 *                                               cycle's snapshot (marked excluded=0).
 *   DELETE /:cycleId                          → wipe the snapshot (rows + run header).
 */
const express = require('express');
const sql = require('mssql');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const multer = require('multer');
const { getPool } = require('../db/connection');
const { getPrarambhUatPool } = require('../db/prarambh-uat-connection');
const { runBulkCalculate } = require('./bulk');

const router = express.Router();
router.use(express.json({ limit: '4mb' }));

// Multer upload for UTR file (Excel / CSV). Lives in the same uploads dir
// as the rate-card and statement uploads.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const utrStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `utr_${Date.now()}_${safe}`);
  },
});
const utrUpload = multer({ storage: utrStorage });

/** Fetch cycle { id, name, date_from, date_to, agent_codes[] } or null. */
async function getCycle(pool, id) {
  const r = await pool.request()
    .input('id', sql.Int, id)
    .query('SELECT id, name, date_from, date_to, agent_codes_csv FROM payout_cycles WHERE id = @id AND active = 1');
  if (r.recordset.length === 0) return null;
  const c = r.recordset[0];
  c.date_from = c.date_from.toISOString().slice(0, 10);
  c.date_to   = c.date_to.toISOString().slice(0, 10);
  c.agent_codes = c.agent_codes_csv
    ? String(c.agent_codes_csv).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  return c;
}

/** Normalise an agent code for set comparison. tmp_PrarambhData stores the
 *  POS code in UPIN_CODE / EmployeeCode; case + whitespace can vary. */
function normAgent(s) {
  return String(s || '').trim().toUpperCase();
}

/** When a cycle has an agent_codes allowlist, drop every row whose agent
 *  isn't in it. The result.totals are recomputed on the survivors so the
 *  stored snapshot doesn't double-count. Returns the cycle-restricted shape
 *  unchanged when the allowlist is empty. */
function applyCycleAgentFilter(result, cyc) {
  if (!cyc || !Array.isArray(cyc.agent_codes) || cyc.agent_codes.length === 0) return result;
  const allow = new Set(cyc.agent_codes.map(normAgent));
  const before = (result.rows || []).length;
  const rows = (result.rows || []).filter(r => allow.has(normAgent(r.agent_code)));
  if (rows.length === before) return result;
  // Re-roll totals from the surviving rows so summary cards reflect the cycle.
  const t = {
    income: 0, savings: 0, outgoing: 0, statement_amount: 0,
    matched_rules: 0, matched_margins: 0, matched_statements: 0,
    status_ok: 0, status_ex: 0, status_scr: 0, status_cnr: 0,
    pr_matched_count: 0, pr_net_total: 0, pr_gross_total: 0, pr_od_total: 0, pr_tp_total: 0,
  };
  for (const r of rows) {
    t.income += Number(r.income || 0); t.savings += Number(r.savings || 0); t.outgoing += Number(r.outgoing || 0);
    if (r.statement_amount != null) { t.statement_amount += Number(r.statement_amount); t.matched_statements++; }
    if (r.matched_rule_id) t.matched_rules++;
    if (r.margin_id)       t.matched_margins++;
    if (r.pr_matched) {
      t.pr_matched_count++;
      t.pr_net_total   += Number(r.pr_net_amount || 0);
      t.pr_gross_total += Number(r.pr_gross_amount || 0);
      t.pr_od_total    += Number(r.pr_od_premium || 0);
      t.pr_tp_total    += Number(r.pr_tp_premium || 0);
    }
    switch (r.status) {
      case 'OK':  t.status_ok++;  break;
      case 'EX':  t.status_ex++;  break;
      case 'SCR': t.status_scr++; break;
      case 'CNR': t.status_cnr++; break;
    }
  }
  for (const k of ['income','savings','outgoing','statement_amount','pr_net_total','pr_gross_total','pr_od_total','pr_tp_total']) {
    t[k] = +t[k].toFixed(2);
  }
  return {
    ...result,
    rows,
    totals: t,
    processed: rows.length,
    total_count: result.total_count,
    cycle_filtered_dropped: before - rows.length,
  };
}

/** Merge user overrides into a stored row and return the client-visible object. */
function applyOverrides(storedRow) {
  const row = JSON.parse(storedRow.row_json || '{}');
  // Seed override flags so the UI can render "edited" indicators.
  row.excluded           = !!storedRow.excluded;
  row.moved_to_cycle_id  = storedRow.moved_to_cycle_id || null;
  row.note_user          = storedRow.note || null;
  // Per-axis overrides — recompute income/savings/outgoing if any changed.
  const rate   = storedRow.rate_pct_override     != null ? Number(storedRow.rate_pct_override)     : row.rate_pct;
  const margin = storedRow.margin_pct_override   != null ? Number(storedRow.margin_pct_override)   : row.margin_pct;
  const outPctExplicit = storedRow.outgoing_pct_override != null ? Number(storedRow.outgoing_pct_override) : null;
  const base   = Number(row.premium_base || 0);

  if (rate != null && !isNaN(rate))   row.rate_pct   = rate;
  if (margin != null && !isNaN(margin)) row.margin_pct = margin;

  // When the user hasn't explicitly overridden margin or outgoing, derive
  // the outgoing % from effective_margin_pct (so an agent special-rate /
  // global uplift carries through). Falls back to row.margin_pct if the
  // upstream calc didn't set an effective value.
  const marginForOutgoing = (storedRow.margin_pct_override != null)
    ? Number(row.margin_pct || 0)
    : Number(row.effective_margin_pct != null ? row.effective_margin_pct : (row.margin_pct || 0));
  const outPct = outPctExplicit != null ? outPctExplicit : (Number(row.rate_pct || 0) - marginForOutgoing);
  if (rate != null || margin != null || outPctExplicit != null) {
    // Income: when the rule splits the rate into OD%+TP% legs (od_rate/tp_rate)
    // AND the user hasn't overridden the rate, the commission is OD% on the OD
    // premium + TP% on the TP premium — NOT rate_pct × premium_base. The OD
    // premium ALREADY includes add-on, so add-on is NOT added again.
    if (storedRow.rate_pct_override == null && (row.od_rate != null || row.tp_rate != null)) {
      const odP = Number(row.od_premium) || 0;
      const tpP = Number(row.tp_premium) || 0;
      row.income = +((Number(row.od_rate) || 0) * odP + (Number(row.tp_rate) || 0) * tpP).toFixed(2);
    } else {
      row.income = +(base * Number(row.rate_pct || 0) / 100).toFixed(2);
    }
    // Outgoing = income − our margin cut (margin% × base). Works for both the
    // single-rate and OD+TP income; explicit outgoing override still wins.
    row.outgoing = outPctExplicit != null
      ? +(base * outPctExplicit / 100).toFixed(2)
      : +(row.income - base * marginForOutgoing / 100).toFixed(2);
    row.savings  = +(row.income - row.outgoing).toFixed(2);
    row.outgoing_pct_override = outPctExplicit;   // surface the explicit edit
  }
  // Always expose the effective Outgoing % so the UI and CSV download
  // can read a single field. Rate − Margin (effective) by default; the
  // explicit override wins when present. Rounded to 3 decimals to match
  // rate_pct precision.
  row.outgoing_pct = +Number(outPct).toFixed(3);
  row._edited = !!(storedRow.rate_pct_override != null || storedRow.margin_pct_override != null ||
                   storedRow.outgoing_pct_override != null || storedRow.excluded || storedRow.note);
  row.stored_row_id = storedRow.id;
  // UTR / payment fields surfaced for the UI: 'paid' / 'unpaid' / null.
  row.paid_status   = storedRow.paid_status || null;
  row.paid_at       = storedRow.paid_at || null;
  row.paid_utr      = storedRow.paid_utr || null;
  row.paid_amount   = storedRow.paid_amount != null ? Number(storedRow.paid_amount) : null;
  row.paid_upload_id = storedRow.paid_upload_id || null;
  row.paid_note     = storedRow.paid_note || null;
  return row;
}

/** Recompute totals from a list of rows (with overrides already applied).
 *  Excluded rows contribute nothing — they stay in the list but are flagged. */
function recomputeTotals(rows) {
  const t = {
    income: 0, savings: 0, outgoing: 0, statement_amount: 0,
    matched_rules: 0, matched_margins: 0, matched_statements: 0,
    status_ok: 0, status_ex: 0, status_scr: 0, status_cnr: 0,
    pr_matched_count: 0, pr_net_total: 0, pr_gross_total: 0,
    pr_od_total: 0, pr_tp_total: 0,
    excluded_count: 0,
  };
  for (const r of rows) {
    if (r.excluded) { t.excluded_count++; continue; }
    t.income   += Number(r.income   || 0);
    t.savings  += Number(r.savings  || 0);
    t.outgoing += Number(r.outgoing || 0);
    if (r.statement_amount != null) { t.statement_amount += Number(r.statement_amount); t.matched_statements++; }
    if (r.matched_rule_id) t.matched_rules++;
    if (r.margin_id)       t.matched_margins++;
    if (r.pr_matched) {
      t.pr_matched_count++;
      t.pr_net_total   += Number(r.pr_net_amount || 0);
      t.pr_gross_total += Number(r.pr_gross_amount || 0);
      t.pr_od_total    += Number(r.pr_od_premium || 0);
      t.pr_tp_total    += Number(r.pr_tp_premium || 0);
    }
    switch (r.status) {
      case 'OK':  t.status_ok++;  break;
      case 'EX':  t.status_ex++;  break;
      case 'SCR': t.status_scr++; break;
      case 'CNR': t.status_cnr++; break;
    }
  }
  // Round money fields.
  for (const k of ['income','savings','outgoing','statement_amount','pr_net_total','pr_gross_total','pr_od_total','pr_tp_total']) {
    t[k] = +t[k].toFixed(2);
  }
  return t;
}

/** Load stored rows for a cycle, apply overrides, return null if none. */
async function loadStored(pool, cycleId) {
  const hdr = await pool.request()
    .input('cid', sql.Int, cycleId)
    .query('SELECT row_count, computed_at, totals_json, finalized_at, finalized_by, snapshot_insurer_slug FROM cycle_runs WHERE cycle_id = @cid');
  if (hdr.recordset.length === 0) return null;
  const r = await pool.request()
    .input('cid', sql.Int, cycleId)
    .query(`SELECT id, policy_no, row_json, rate_pct_override, margin_pct_override,
                    outgoing_pct_override, excluded, moved_to_cycle_id, note,
                    paid_status, paid_at, paid_utr, paid_amount, paid_upload_id, paid_note
             FROM cycle_bulk_rows
             WHERE cycle_id = @cid`);
  const rows = r.recordset.map(applyOverrides);
  return {
    stored: true,
    computed_at:  hdr.recordset[0].computed_at,
    row_count:    hdr.recordset[0].row_count,
    finalized_at: hdr.recordset[0].finalized_at,
    finalized_by: hdr.recordset[0].finalized_by,
    finalized:    !!hdr.recordset[0].finalized_at,
    snapshot_insurer_slug: hdr.recordset[0].snapshot_insurer_slug || null,
    rows,
    totals: recomputeTotals(rows),
  };
}

/** Throw a 423-style payload from any mutating route when the cycle has
 *  been finalized. Returns true when the request handler should bail. */
async function isCycleFinalized(pool, cycleId) {
  const r = await pool.request().input('cid', sql.Int, cycleId)
    .query('SELECT finalized_at, finalized_by FROM cycle_runs WHERE cycle_id = @cid');
  if (r.recordset.length === 0) return null;
  return r.recordset[0].finalized_at ? r.recordset[0] : null;
}
function finalizedRejection(res, info) {
  return res.status(423).json({
    success: false,
    error: 'Cycle is finalized — no more changes allowed.',
    finalized_at: info.finalized_at,
    finalized_by: info.finalized_by,
  });
}

/** Persist a fresh calculation result into the cycle snapshot.
 *  `insurerSlug` is the filter used when computing — null means "All
 *  insurers".  Stored on cycle_runs so /calculate can decide whether to
 *  reuse or recompute when a different filter is requested. */
async function storeSnapshot(pool, cycleId, result, insurerSlug) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    await rq().input('cid', sql.Int, cycleId).query('DELETE FROM cycle_bulk_rows WHERE cycle_id = @cid');
    await rq().input('cid', sql.Int, cycleId).query('DELETE FROM cycle_runs WHERE cycle_id = @cid');

    // Dedupe by policy_no (source data can have endorsements / duplicates).
    // Default: keep first occurrence.  But: if a duplicate carries fields
    // the previously-kept row was missing (tracker_no being the common
    // case — endorsements often blank it), backfill those fields onto the
    // kept row so the user's CSV / UI sees the populated value.
    const seen = new Map();
    const BACKFILL_FIELDS = ['tracker_no', 'agent_code', 'agent_name', 'submission_date'];
    for (const row of (result.rows || [])) {
      const pn = String(row.policy_no || '').trim();
      if (!pn) continue;
      if (seen.has(pn)) {
        const kept = seen.get(pn);
        kept._dupe_count = (kept._dupe_count || 1) + 1;
        for (const f of BACKFILL_FIELDS) {
          if ((kept[f] === null || kept[f] === undefined || kept[f] === '') &&
              (row[f] !== null && row[f] !== undefined && row[f] !== '')) {
            kept[f] = row[f];
          }
        }
        continue;
      }
      seen.set(pn, row);
    }
    for (const [pn, row] of seen) {
      await rq()
        .input('cid',   sql.Int, cycleId)
        .input('pn',    sql.NVarChar(200), pn)
        .input('tn',    sql.NVarChar(200), row.tracker_no || null)
        .input('is',    sql.VarChar(100),  row.insurer_slug || null)
        .input('ac',    sql.NVarChar(100), row.agent_code || null)
        .input('json',  sql.NVarChar(sql.MAX), JSON.stringify(row))
        .query(`INSERT INTO cycle_bulk_rows
                  (cycle_id, policy_no, tracker_no, insurer_slug, agent_code, row_json)
                VALUES (@cid, @pn, @tn, @is, @ac, @json)`);
    }
    await rq()
      .input('cid',    sql.Int, cycleId)
      .input('n',      sql.Int, seen.size)
      .input('totals', sql.NVarChar(sql.MAX), JSON.stringify(result.totals || {}))
      .input('ins',    sql.VarChar(100), insurerSlug || null)
      .query(`INSERT INTO cycle_runs (cycle_id, row_count, totals_json, snapshot_insurer_slug)
              VALUES (@cid, @n, @totals, @ins)`);
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* noop */ }
    throw err;
  }
}

/**
 * Partial snapshot replace — swaps ONLY the rows for `insurerSlug`, leaving
 * every other insurer's stored rows untouched. Used for a per-insurer
 * recompute so fixing one carrier's rates doesn't require re-running (and
 * risking) the entire cycle. Dedupes the incoming rows by policy_no.
 */
async function storeSnapshotForInsurer(pool, cycleId, result, insurerSlug) {
  const slug = String(insurerSlug || '').trim();
  if (!slug) throw new Error('storeSnapshotForInsurer requires an insurer slug');
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const rq = () => new sql.Request(tx);
    // Delete only this insurer's rows for the cycle.
    await rq()
      .input('cid', sql.Int, cycleId)
      .input('slug', sql.VarChar(100), slug)
      .query('DELETE FROM cycle_bulk_rows WHERE cycle_id = @cid AND insurer_slug = @slug');

    const seen = new Map();
    const BACKFILL_FIELDS = ['tracker_no', 'agent_code', 'agent_name', 'submission_date'];
    for (const row of (result.rows || [])) {
      if (String(row.insurer_slug || '').trim() !== slug) continue; // safety: only this insurer
      const pn = String(row.policy_no || '').trim();
      if (!pn) continue;
      if (seen.has(pn)) {
        const kept = seen.get(pn);
        for (const f of BACKFILL_FIELDS) {
          if ((kept[f] == null || kept[f] === '') && row[f] != null && row[f] !== '') kept[f] = row[f];
        }
        continue;
      }
      seen.set(pn, row);
    }
    let inserted = 0;
    for (const [pn, row] of seen) {
      await rq()
        .input('cid',  sql.Int, cycleId)
        .input('pn',   sql.NVarChar(200), pn)
        .input('tn',   sql.NVarChar(200), row.tracker_no || null)
        .input('is',   sql.VarChar(100),  row.insurer_slug || null)
        .input('ac',   sql.NVarChar(100), row.agent_code || null)
        .input('json', sql.NVarChar(sql.MAX), JSON.stringify(row))
        .query(`INSERT INTO cycle_bulk_rows
                  (cycle_id, policy_no, tracker_no, insurer_slug, agent_code, row_json)
                VALUES (@cid, @pn, @tn, @is, @ac, @json)`);
      inserted++;
    }
    await tx.commit();
    return inserted;
  } catch (err) {
    try { await tx.rollback(); } catch (_) { /* noop */ }
    throw err;
  }
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

/** GET /:cycleId — return stored rows, or { stored: false } if none. */
// ── Finalize / unfinalize ──────────────────────────────────────────────────

/** GET /finalized — list every cycle's snapshot status. Powers the Admin
 *  panel where an admin can unfinalize any cycle (or see what's still open).
 *  Joins cycle_runs with payout_cycles for the cycle name + dates. */
router.get('/finalized', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT cr.cycle_id, cr.row_count, cr.computed_at,
              cr.finalized_at, cr.finalized_by,
              pc.name AS cycle_name, pc.date_from, pc.date_to
       FROM cycle_runs cr
       LEFT JOIN payout_cycles pc ON pc.id = cr.cycle_id
       ORDER BY (CASE WHEN cr.finalized_at IS NULL THEN 1 ELSE 0 END),
                cr.finalized_at DESC, cr.cycle_id DESC`
    );
    const cycles = r.recordset.map(c => ({
      cycle_id:     c.cycle_id,
      cycle_name:   c.cycle_name,
      date_from:    c.date_from instanceof Date ? c.date_from.toISOString().slice(0, 10) : c.date_from,
      date_to:      c.date_to   instanceof Date ? c.date_to.toISOString().slice(0, 10)   : c.date_to,
      row_count:    c.row_count,
      computed_at:  c.computed_at,
      finalized:    !!c.finalized_at,
      finalized_at: c.finalized_at,
      finalized_by: c.finalized_by,
    }));
    res.json({ success: true, count: cycles.length, cycles });
  } catch (err) { next(err); }
});



/** POST /:cycleId/finalize — lock all further edits on the snapshot. */
router.post('/:cycleId(\\d+)/finalize', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const by = (req.body && req.body.by) ? String(req.body.by).slice(0, 100) : 'Admin';
    // Run header must exist (snapshot must be computed before finalizing).
    const r = await pool.request()
      .input('cid', sql.Int, cycleId)
      .input('by',  sql.NVarChar(100), by)
      .query(`UPDATE cycle_runs
               SET finalized_at = GETDATE(), finalized_by = @by
               WHERE cycle_id = @cid AND finalized_at IS NULL`);
    if (r.rowsAffected[0] === 0) {
      // Either no snapshot, or already finalized — distinguish for the UI.
      const cur = await pool.request().input('cid', sql.Int, cycleId)
        .query('SELECT finalized_at, finalized_by FROM cycle_runs WHERE cycle_id = @cid');
      if (cur.recordset.length === 0) {
        return res.status(404).json({ success: false, error: 'No snapshot to finalize. Run the cycle first.' });
      }
      return res.status(409).json({
        success: false,
        error: 'Already finalized',
        finalized_at: cur.recordset[0].finalized_at,
        finalized_by: cur.recordset[0].finalized_by,
      });
    }
    res.json({ success: true, finalized_by: by });
  } catch (err) { next(err); }
});

/** POST /:cycleId/unfinalize — clear the finalize flag. Reserved for admins. */
router.post('/:cycleId(\\d+)/unfinalize', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    await pool.request().input('cid', sql.Int, cycleId)
      .query(`UPDATE cycle_runs
               SET finalized_at = NULL, finalized_by = NULL
               WHERE cycle_id = @cid`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/:cycleId(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    const out = await loadStored(pool, Number(req.params.cycleId));
    if (!out) return res.json({ success: true, stored: false });
    res.json({ success: true, ...out });
  } catch (err) { next(err); }
});

/** POST /:cycleId/calculate — compute + store (no-op if snapshot exists). */
router.post('/:cycleId(\\d+)/calculate', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const requestedInsurer = (req.body && req.body.insurer_slug) || null;
    const existing = await loadStored(pool, cycleId);
    // Reuse cached snapshot ONLY when its insurer filter matches the
    // current request — including the "All insurers" case (both null).
    // Otherwise fall through and recompute so the user gets the data
    // they actually asked for (e.g. switching from chola_ms to "All").
    if (existing && (existing.snapshot_insurer_slug || null) === requestedInsurer) {
      return res.json({ success: true, ...existing, reused: true });
    }

    const cyc = await getCycle(pool, cycleId);
    if (!cyc) return res.status(404).json({ success: false, error: 'Cycle not found' });

    const args = {
      insurer_slug: req.body && req.body.insurer_slug,
      date_from:    cyc.date_from,
      date_to:      cyc.date_to,
      limit:        (req.body && req.body.limit) || 20000,
      // Carry-forward window: off by default to keep cycle strict to its
      // configured date range. Caller can opt in via
      // req.body.lookback_days / lookforward_days when reconciling against
      // operator workbooks that bucket late submissions into a cycle.
      lookback_days:    req.body && req.body.lookback_days    != null ? req.body.lookback_days    : 0,
      lookforward_days: req.body && req.body.lookforward_days != null ? req.body.lookforward_days : 0,
    };
    let result = await runBulkCalculate(args);
    // One auto-retry on a 0-row result — covers transient WAN failures where
    // the remote UAT DB closed the socket mid-query.
    if (!result.rows || result.rows.length === 0) {
      await new Promise(r => setTimeout(r, 1500));
      result = await runBulkCalculate(args);
    }
    if (!result.rows || result.rows.length === 0) {
      const totalCount = result.total_count || 0;
      // Be specific about *why* it's 0 so the user knows what to fix.
      let why;
      if (totalCount === 0) {
        why = `No policies found in tmp_PrarambhData for the cycle window (${cyc.date_from} → ${cyc.date_to})`
            + (args.insurer_slug ? ` and insurer "${args.insurer_slug}"` : '')
            + '. Try widening the cycle dates, removing the insurer filter, or confirming source data exists for this period.';
      } else {
        why = `Source query returned ${totalCount} matching rows but the per-policy pipeline produced 0 output rows`
            + ' — likely a transient WAN failure to the UAT DB during processing. Try again in a moment.';
      }
      return res.status(422).json({
        success: false,
        error: why,
        totals: result.totals || null,
        total_count: totalCount,
        cycle: { from: cyc.date_from, to: cyc.date_to },
        insurer_slug: args.insurer_slug || null,
      });
    }
    // Cycle-scoped agent allowlist — drop rows for agents outside the cycle's
    // configured list (when one is configured). No-op when the cycle was
    // created without a list.
    result = applyCycleAgentFilter(result, cyc);
    if (!result.rows || result.rows.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'After applying the cycle agent allowlist, 0 rows remain. Check that the listed empcodes match what tmp_PrarambhData stores in UPIN_CODE.',
        cycle_filtered_dropped: result.cycle_filtered_dropped || 0,
      });
    }
    await storeSnapshot(pool, cycleId, result, requestedInsurer);
    const out = await loadStored(pool, cycleId);
    res.json({ success: true, ...out, reused: false, cycle_filtered_dropped: result.cycle_filtered_dropped || 0 });
  } catch (err) { next(err); }
});

/** POST /:cycleId/recompute — force wipe + recompute. */
router.post('/:cycleId(\\d+)/recompute', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const cyc = await getCycle(pool, cycleId);
    if (!cyc) return res.status(404).json({ success: false, error: 'Cycle not found' });
    const fin = await isCycleFinalized(pool, cycleId);
    if (fin) return finalizedRejection(res, fin);
    // Preserve existing overrides on re-compute so user edits don't vanish:
    // snapshot the override columns by (policy_no) before wiping, then re-apply
    // them after the new snapshot is stored.
    const prev = await pool.request()
      .input('cid', sql.Int, cycleId)
      .query(`SELECT policy_no, rate_pct_override, margin_pct_override, outgoing_pct_override,
                      excluded, moved_to_cycle_id, note
               FROM cycle_bulk_rows WHERE cycle_id = @cid`);
    const overridesByPolicy = new Map();
    for (const o of prev.recordset) overridesByPolicy.set(String(o.policy_no).trim(), o);

    const args = {
      insurer_slug: req.body && req.body.insurer_slug,
      date_from:    cyc.date_from,
      date_to:      cyc.date_to,
      limit:        (req.body && req.body.limit) || 20000,
      // Carry-forward window: off by default to keep cycle strict to its
      // configured date range. Caller can opt in via
      // req.body.lookback_days / lookforward_days when reconciling against
      // operator workbooks that bucket late submissions into a cycle.
      lookback_days:    req.body && req.body.lookback_days    != null ? req.body.lookback_days    : 0,
      lookforward_days: req.body && req.body.lookforward_days != null ? req.body.lookforward_days : 0,
    };
    let result = await runBulkCalculate(args);
    if (!result.rows || result.rows.length === 0) {
      // Single retry — see note in /calculate route.
      await new Promise(r => setTimeout(r, 1500));
      result = await runBulkCalculate(args);
    }
    if (!result.rows || result.rows.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'Recompute returned 0 rows — existing snapshot (if any) left intact. Likely a source-DB connectivity blip; try again in a moment.',
      });
    }
    result = applyCycleAgentFilter(result, cyc);
    if (!result.rows || result.rows.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'After applying the cycle agent allowlist, 0 rows remain. Existing snapshot left intact.',
        cycle_filtered_dropped: result.cycle_filtered_dropped || 0,
      });
    }
    // Per-insurer recompute: when an insurer_slug is supplied, swap ONLY
    // that insurer's rows and leave the rest of the cycle untouched.
    // Otherwise do a full wipe + store.
    if (args.insurer_slug) {
      const n = await storeSnapshotForInsurer(pool, cycleId, result, args.insurer_slug);
      const out = await loadStored(pool, cycleId);
      return res.json({ success: true, ...out, partial: true,
        insurer_slug: args.insurer_slug, replaced_rows: n });
    }
    await storeSnapshot(pool, cycleId, result, args.insurer_slug || null);

    // Replay overrides (ignore rows that no longer exist).
    if (overridesByPolicy.size > 0) {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        for (const [pn, o] of overridesByPolicy) {
          await new sql.Request(tx)
            .input('cid',  sql.Int, cycleId)
            .input('pn',   sql.NVarChar(200), pn)
            .input('r',    sql.Decimal(10, 4), o.rate_pct_override)
            .input('m',    sql.Decimal(10, 4), o.margin_pct_override)
            .input('op',   sql.Decimal(10, 4), o.outgoing_pct_override)
            .input('ex',   sql.Bit, o.excluded ? 1 : 0)
            .input('mv',   sql.Int, o.moved_to_cycle_id)
            .input('nt',   sql.NVarChar(500), o.note)
            .query(`UPDATE cycle_bulk_rows
                     SET rate_pct_override     = @r,
                         margin_pct_override   = @m,
                         outgoing_pct_override = @op,
                         excluded              = @ex,
                         moved_to_cycle_id     = @mv,
                         note                  = @nt,
                         updated_at            = GETDATE()
                     WHERE cycle_id = @cid AND policy_no = @pn`);
        }
        await tx.commit();
      } catch (err) {
        try { await tx.rollback(); } catch (_) { /* noop */ }
        throw err;
      }
    }

    const out = await loadStored(pool, cycleId);
    res.json({ success: true, ...out, replayed_overrides: overridesByPolicy.size });
  } catch (err) { next(err); }
});

/** POST /:cycleId/recompute-policy — recompute ONE policy in place.
 *  body:{ policy_no }. Uses runBulkCalculate's policy_nos whitelist (bypasses
 *  date/insurer filters) so a single row can be refreshed after a PR edit
 *  without re-running the whole cycle. Preserves that row's overrides. */
router.post('/:cycleId(\\d+)/recompute-policy', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const pn = String((req.body && req.body.policy_no) || '').trim();
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const cyc = await getCycle(pool, cycleId);
    if (!cyc) return res.status(404).json({ success: false, error: 'Cycle not found' });
    const fin = await isCycleFinalized(pool, cycleId);
    if (fin) return finalizedRejection(res, fin);

    // Preserve this policy's overrides across the swap.
    const prev = await pool.request()
      .input('cid', sql.Int, cycleId)
      .input('pn',  sql.NVarChar(200), pn)
      .query(`SELECT rate_pct_override, margin_pct_override, outgoing_pct_override,
                     excluded, moved_to_cycle_id, note
                FROM cycle_bulk_rows WHERE cycle_id = @cid AND policy_no = @pn`);
    const ov = prev.recordset[0] || null;

    const result = await runBulkCalculate({
      policy_nos: [pn],
      date_from:  cyc.date_from,
      date_to:    cyc.date_to,
      limit:      50,
    });
    const matched = (result.rows || []).filter(r => String(r.policy_no || '').trim() === pn);
    if (!matched.length) {
      return res.status(422).json({
        success: false,
        error: 'Recompute produced no row for this policy (not found in source data).',
      });
    }
    const row = matched[0];

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input('cid', sql.Int, cycleId).input('pn', sql.NVarChar(200), pn)
        .query('DELETE FROM cycle_bulk_rows WHERE cycle_id = @cid AND policy_no = @pn');
      await new sql.Request(tx)
        .input('cid',  sql.Int, cycleId)
        .input('pn',   sql.NVarChar(200), pn)
        .input('tn',   sql.NVarChar(200), row.tracker_no || null)
        .input('is',   sql.VarChar(100),  row.insurer_slug || null)
        .input('ac',   sql.NVarChar(100), row.agent_code || null)
        .input('json', sql.NVarChar(sql.MAX), JSON.stringify(row))
        .query(`INSERT INTO cycle_bulk_rows
                  (cycle_id, policy_no, tracker_no, insurer_slug, agent_code, row_json)
                VALUES (@cid, @pn, @tn, @is, @ac, @json)`);
      if (ov) {
        await new sql.Request(tx)
          .input('cid', sql.Int, cycleId).input('pn', sql.NVarChar(200), pn)
          .input('r',  sql.Decimal(10, 4), ov.rate_pct_override)
          .input('m',  sql.Decimal(10, 4), ov.margin_pct_override)
          .input('op', sql.Decimal(10, 4), ov.outgoing_pct_override)
          .input('ex', sql.Bit, ov.excluded ? 1 : 0)
          .input('mv', sql.Int, ov.moved_to_cycle_id)
          .input('nt', sql.NVarChar(500), ov.note)
          .query(`UPDATE cycle_bulk_rows
                     SET rate_pct_override = @r, margin_pct_override = @m,
                         outgoing_pct_override = @op, excluded = @ex,
                         moved_to_cycle_id = @mv, note = @nt, updated_at = GETDATE()
                   WHERE cycle_id = @cid AND policy_no = @pn`);
      }
      await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch (_) { /* noop */ } throw e; }

    res.json({
      success: true,
      policy_no: pn,
      tracker_no: row.tracker_no || null,
      insurer_slug: row.insurer_slug || null,
      our_rate: row.rate_pct != null ? Number(row.rate_pct) : null,
      pr_upload_id: row.pr_upload_id || null,
      matched_segment: row.matched_segment || null,
    });
  } catch (err) { next(err); }
});

/** GET /:cycleId/policy/:policyNo — look up one stored policy's computed
 *  detail (our rate, matched segment, insurer, PR upload for QC deep-link).
 *  Powers the recon screen's Policy Lookup box. Matches on policy_no OR
 *  tracker_no so users can paste either. */
router.get('/:cycleId(\\d+)/policy/:policyNo', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const key = String(req.params.policyNo || '').trim();
    if (!key) return res.status(400).json({ success: false, error: 'policy_no required' });
    const r = await pool.request()
      .input('cid', sql.Int, cycleId)
      .input('k',   sql.NVarChar(200), key)
      .query(`SELECT TOP 1 policy_no, tracker_no, insurer_slug, row_json,
                     rate_pct_override, margin_pct_override, outgoing_pct_override,
                     excluded, note
                FROM cycle_bulk_rows
               WHERE cycle_id = @cid AND (policy_no = @k OR tracker_no = @k)`);
    if (!r.recordset.length) {
      return res.json({ success: true, found: false, key });
    }
    const merged = applyOverrides(r.recordset[0]);
    res.json({
      success: true,
      found: true,
      policy_no:        merged.policy_no || null,
      tracker_no:       merged.tracker_no || null,
      insurer:          merged.insurer || merged.insurer_slug || null,
      insurer_slug:     merged.insurer_slug || null,
      vehicle_type:     merged.vehicle_type || null,
      make:             merged.make || null,
      model:            merged.model || null,
      region:           merged.region || null,
      rto_code:         merged.rto_code || null,
      our_rate:         merged.rate_pct != null ? Number(merged.rate_pct) : null,
      matched_segment:  merged.matched_segment || null,
      matched_rate_type: merged.matched_rate_type || null,
      pr_upload_id:     merged.pr_upload_id || null,
      excluded:         !!merged.excluded,
      note:             merged.note || null,
    });
  } catch (err) { next(err); }
});

/** PUT /:cycleId/rows/:policyNo — patch a single row's overrides. */
router.put('/:cycleId(\\d+)/rows/:policyNo', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const pn = String(req.params.policyNo || '').trim();
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const fin = await isCycleFinalized(pool, cycleId);
    if (fin) return finalizedRejection(res, fin);

    const b = req.body || {};
    // Build a SET-list dynamically so the client can null-clear individual fields.
    const sets = ['updated_at = GETDATE()'];
    const rq = pool.request().input('cid', sql.Int, cycleId).input('pn', sql.NVarChar(200), pn);
    const addDec = (key, col) => {
      if (Object.prototype.hasOwnProperty.call(b, key)) {
        sets.push(`${col} = @${key}`);
        rq.input(key, sql.Decimal(10, 4), b[key] == null || b[key] === '' ? null : Number(b[key]));
      }
    };
    addDec('rate_pct_override',     'rate_pct_override');
    addDec('margin_pct_override',   'margin_pct_override');
    addDec('outgoing_pct_override', 'outgoing_pct_override');
    if (Object.prototype.hasOwnProperty.call(b, 'excluded')) {
      sets.push('excluded = @excluded');
      rq.input('excluded', sql.Bit, b.excluded ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'note')) {
      sets.push('note = @note');
      rq.input('note', sql.NVarChar(500), b.note || null);
    }
    if (sets.length === 1) return res.status(400).json({ success: false, error: 'No fields to update' });

    const r = await rq.query(
      `UPDATE cycle_bulk_rows SET ${sets.join(', ')}
       WHERE cycle_id = @cid AND policy_no = @pn`
    );
    if (r.rowsAffected[0] === 0) return res.status(404).json({ success: false, error: 'Row not found in this cycle' });

    // Return the updated row so the client can re-render in place.
    const fetched = await pool.request()
      .input('cid', sql.Int, cycleId).input('pn', sql.NVarChar(200), pn)
      .query(`SELECT id, policy_no, row_json, rate_pct_override, margin_pct_override,
                      outgoing_pct_override, excluded, moved_to_cycle_id, note
               FROM cycle_bulk_rows WHERE cycle_id = @cid AND policy_no = @pn`);
    const updated = fetched.recordset[0] ? applyOverrides(fetched.recordset[0]) : null;
    res.json({ success: true, row: updated });
  } catch (err) { next(err); }
});

/** POST /:cycleId/rows/:policyNo/move — move a policy to another cycle. */
router.post('/:cycleId(\\d+)/rows/:policyNo/move', async (req, res, next) => {
  try {
    const pool = await getPool();
    const srcId = Number(req.params.cycleId);
    const pn    = String(req.params.policyNo || '').trim();
    const tgtId = Number(req.body && req.body.target_cycle_id);
    if (!pn || !tgtId) return res.status(400).json({ success: false, error: 'policy_no + target_cycle_id required' });
    if (srcId === tgtId) return res.status(400).json({ success: false, error: 'target cycle must differ from source' });
    // Block move both ways: source can't be finalized (lock), and target can't
    // be finalized either (we'd be inserting into a closed cycle).
    const finSrc = await isCycleFinalized(pool, srcId);
    if (finSrc) return finalizedRejection(res, finSrc);
    const finTgt = await isCycleFinalized(pool, tgtId);
    if (finTgt) return res.status(423).json({ success: false, error: 'Target cycle is finalized.', finalized_at: finTgt.finalized_at });

    // Target cycle must exist.
    const tgt = await getCycle(pool, tgtId);
    if (!tgt) return res.status(404).json({ success: false, error: 'Target cycle not found' });

    // Source row.
    const src = await pool.request()
      .input('cid', sql.Int, srcId).input('pn', sql.NVarChar(200), pn)
      .query(`SELECT * FROM cycle_bulk_rows WHERE cycle_id = @cid AND policy_no = @pn`);
    if (src.recordset.length === 0) return res.status(404).json({ success: false, error: 'Row not found' });
    const row = src.recordset[0];

    // Ensure target has a run header so the UI knows it has data.
    await pool.request().input('cid', sql.Int, tgtId).query(
      `IF NOT EXISTS (SELECT 1 FROM cycle_runs WHERE cycle_id = @cid)
         INSERT INTO cycle_runs (cycle_id, row_count, totals_json) VALUES (@cid, 0, '{}')`
    );

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const rq = () => new sql.Request(tx);
      // Upsert into target cycle — replace if policy already exists.
      await rq()
        .input('cid', sql.Int, tgtId)
        .input('pn',  sql.NVarChar(200), pn)
        .query('DELETE FROM cycle_bulk_rows WHERE cycle_id = @cid AND policy_no = @pn');
      await rq()
        .input('cid',   sql.Int, tgtId)
        .input('pn',    sql.NVarChar(200), pn)
        .input('tn',    sql.NVarChar(200), row.tracker_no)
        .input('is',    sql.VarChar(100),  row.insurer_slug)
        .input('ac',    sql.NVarChar(100), row.agent_code)
        .input('json',  sql.NVarChar(sql.MAX), row.row_json)
        .input('r',     sql.Decimal(10, 4), row.rate_pct_override)
        .input('m',     sql.Decimal(10, 4), row.margin_pct_override)
        .input('op',    sql.Decimal(10, 4), row.outgoing_pct_override)
        .input('nt',    sql.NVarChar(500),  `Moved from cycle #${srcId}`)
        .query(`INSERT INTO cycle_bulk_rows
                  (cycle_id, policy_no, tracker_no, insurer_slug, agent_code, row_json,
                   rate_pct_override, margin_pct_override, outgoing_pct_override, note)
                VALUES (@cid, @pn, @tn, @is, @ac, @json, @r, @m, @op, @nt)`);

      // Flag source row as moved + excluded so it doesn't double-count.
      await rq()
        .input('srcId', sql.Int, srcId)
        .input('pn',    sql.NVarChar(200), pn)
        .input('tgt',   sql.Int, tgtId)
        .input('note',  sql.NVarChar(500), `Moved to cycle #${tgtId}`)
        .query(`UPDATE cycle_bulk_rows
                 SET excluded = 1, moved_to_cycle_id = @tgt, note = @note, updated_at = GETDATE()
                 WHERE cycle_id = @srcId AND policy_no = @pn`);

      // Bump target row_count.
      await rq()
        .input('cid', sql.Int, tgtId)
        .query(`UPDATE cycle_runs
                 SET row_count = (SELECT COUNT(*) FROM cycle_bulk_rows WHERE cycle_id = @cid)
                 WHERE cycle_id = @cid`);
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* noop */ }
      throw err;
    }

    res.json({ success: true, moved_to_cycle_id: tgtId, moved_to_cycle_name: tgt.name });
  } catch (err) { next(err); }
});

// ── Permanent exclusion list ───────────────────────────────────────────────

/** GET /excluded-policies — all globally excluded policies. */
router.get('/excluded-policies', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      'SELECT policy_no, reason, excluded_at, excluded_by FROM excluded_policies ORDER BY excluded_at DESC'
    );
    res.json({ success: true, policies: r.recordset });
  } catch (err) { next(err); }
});

/** POST /excluded-policies  body:{ policy_no, reason } */
router.post('/excluded-policies', async (req, res, next) => {
  try {
    const pn = String((req.body && req.body.policy_no) || '').trim();
    const reason = (req.body && req.body.reason) || null;
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const pool = await getPool();
    // Upsert.
    await pool.request()
      .input('pn', sql.NVarChar(200), pn)
      .input('rs', sql.NVarChar(500), reason)
      .query(`IF EXISTS (SELECT 1 FROM excluded_policies WHERE policy_no = @pn)
                UPDATE excluded_policies SET reason = @rs, excluded_at = GETDATE() WHERE policy_no = @pn
              ELSE
                INSERT INTO excluded_policies (policy_no, reason) VALUES (@pn, @rs)`);
    // Also mark it excluded in any stored cycle_bulk_rows so the UI reflects it
    // without needing a recompute.
    await pool.request()
      .input('pn', sql.NVarChar(200), pn)
      .input('note', sql.NVarChar(500), reason ? `Permanently excluded: ${reason}` : 'Permanently excluded')
      .query(`UPDATE cycle_bulk_rows SET excluded = 1, note = @note, updated_at = GETDATE()
               WHERE policy_no = @pn`);
    res.json({ success: true, policy_no: pn, reason });
  } catch (err) { next(err); }
});

/** DELETE /excluded-policies/:policyNo — remove from exclusion list. */
router.delete('/excluded-policies/:policyNo', async (req, res, next) => {
  try {
    const pn = String(req.params.policyNo || '').trim();
    const pool = await getPool();
    await pool.request().input('pn', sql.NVarChar(200), pn)
      .query('DELETE FROM excluded_policies WHERE policy_no = @pn');
    // Un-mark in existing cycle snapshots too.
    await pool.request().input('pn', sql.NVarChar(200), pn)
      .query(`UPDATE cycle_bulk_rows SET excluded = 0, note = NULL, updated_at = GETDATE()
               WHERE policy_no = @pn
                 AND (note LIKE 'Permanently excluded%' OR note IS NULL)`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Add a single policy to a cycle (outside its date range) ────────────────

/** POST /:cycleId/add  body:{ policy_no } */
router.post('/:cycleId(\\d+)/add', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const pn = String((req.body && req.body.policy_no) || '').trim();
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const cyc = await getCycle(pool, cycleId);
    if (!cyc) return res.status(404).json({ success: false, error: 'Cycle not found' });
    const fin = await isCycleFinalized(pool, cycleId);
    if (fin) return finalizedRejection(res, fin);

    // Ensure a run header exists so the UI shows "stored".
    await pool.request().input('cid', sql.Int, cycleId).query(
      `IF NOT EXISTS (SELECT 1 FROM cycle_runs WHERE cycle_id = @cid)
         INSERT INTO cycle_runs (cycle_id, row_count, totals_json) VALUES (@cid, 0, '{}')`
    );

    // Already in this cycle?
    const existing = await pool.request()
      .input('cid', sql.Int, cycleId).input('pn', sql.NVarChar(200), pn)
      .query('SELECT id FROM cycle_bulk_rows WHERE cycle_id = @cid AND policy_no = @pn');
    if (existing.recordset.length > 0) {
      return res.status(409).json({ success: false, error: 'Policy already present in this cycle' });
    }

    // Run the bulk pipeline for just this policy (bypasses date/insurer filter).
    const result = await runBulkCalculate({ policy_nos: [pn], limit: 10 });
    const row = (result.rows || [])[0];
    if (!row) return res.status(404).json({
      success: false,
      error: 'Policy not found in source (tmp_PrarambhData). Check the policy_no / tracker_no.',
    });

    await pool.request()
      .input('cid',   sql.Int, cycleId)
      .input('pn',    sql.NVarChar(200), row.policy_no)
      .input('tn',    sql.NVarChar(200), row.tracker_no || null)
      .input('is',    sql.VarChar(100),  row.insurer_slug || null)
      .input('ac',    sql.NVarChar(100), row.agent_code || null)
      .input('json',  sql.NVarChar(sql.MAX), JSON.stringify(row))
      .input('note',  sql.NVarChar(500), 'Manually added to this cycle')
      .query(`INSERT INTO cycle_bulk_rows
                (cycle_id, policy_no, tracker_no, insurer_slug, agent_code, row_json, note)
              VALUES (@cid, @pn, @tn, @is, @ac, @json, @note)`);
    await pool.request().input('cid', sql.Int, cycleId).query(
      `UPDATE cycle_runs
         SET row_count = (SELECT COUNT(*) FROM cycle_bulk_rows WHERE cycle_id = @cid)
         WHERE cycle_id = @cid`
    );
    res.json({ success: true, added: row });
  } catch (err) { next(err); }
});

// ── UTR upload / payment reconciliation ────────────────────────────────────

/** Pluck the first non-empty value from `row` whose header matches any of
 *  `keys` (case-insensitive, ignores spaces / underscores / hyphens). */
function pickCell(row, keys) {
  const norm = s => String(s || '').toLowerCase().replace(/[\s_-]/g, '');
  const wanted = new Set(keys.map(norm));
  for (const k of Object.keys(row)) {
    if (wanted.has(norm(k))) {
      const v = row[k];
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  return null;
}
const normNum = v => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * POST /:cycleId/utr/upload  (multipart with a `file` field)
 *
 * Parses an Excel / CSV with one row per UTR transaction. Looked-up columns
 * (case-insensitive, space/underscore/hyphen-insensitive):
 *   - Policy / Policy No / Policy Number
 *   - Tracker / Tracker No / Tracker_Code
 *   - UTR / UTR No / Reference
 *   - Amount / Paid Amount / Net Amount
 *   - Date / Payment Date / UTR Date (optional, parsed best-effort)
 *
 * For each row it tries to match cycle_bulk_rows on policy_no first, then on
 * tracker_no. Matched rows get paid_status='paid', paid_utr/paid_amount/etc
 * stamped. Anything not matched is kept on utr_uploads for reference.
 */
router.post('/:cycleId(\\d+)/utr/upload', utrUpload.single('file'), async (req, res, next) => {
  try {
    const cycleId = Number(req.params.cycleId);
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded (field name "file")' });
    const pool = await getPool();

    const fin = await isCycleFinalized(pool, cycleId);
    if (fin) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return finalizedRejection(res, fin);
    }

    // Parse workbook → rows (header inferred by xlsx). Only the first sheet.
    const wb = XLSX.readFile(req.file.path);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (rawRows.length === 0) {
      return res.status(400).json({ success: false, error: 'Empty file' });
    }

    // Index the cycle's stored rows by policy_no AND tracker_no for fast match.
    const cycleRows = await pool.request()
      .input('cid', sql.Int, cycleId)
      .query(`SELECT id, policy_no, tracker_no FROM cycle_bulk_rows WHERE cycle_id = @cid`);
    const byPolicy = new Map();
    const byTracker = new Map();
    for (const r of cycleRows.recordset) {
      if (r.policy_no)  byPolicy.set(String(r.policy_no).trim().toUpperCase(),  r.id);
      if (r.tracker_no) byTracker.set(String(r.tracker_no).trim().toUpperCase(), r.id);
    }

    // Create the upload header so we can tag each cycle_bulk_rows update.
    const upHdr = await pool.request()
      .input('cid', sql.Int, cycleId)
      .input('fn',  sql.NVarChar(500), req.file.originalname)
      .query(`INSERT INTO utr_uploads (cycle_id, file_name, row_count)
              OUTPUT INSERTED.id
              VALUES (@cid, @fn, ${rawRows.length})`);
    const uploadId = upHdr.recordset[0].id;

    let matched = 0, unmatched = 0, totalAmount = 0;
    const unmatchedSamples = [];
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const row of rawRows) {
        const polRaw = pickCell(row, ['Policy', 'PolicyNo', 'Policy No', 'Policy Number', 'PolicyNumber']);
        const trkRaw = pickCell(row, ['Tracker', 'TrackerNo', 'Tracker No', 'Tracker_Code', 'TrackerCode']);
        const utr    = String(pickCell(row, ['UTR', 'UTR No', 'UTRNo', 'UTRNumber', 'Reference', 'RefNo', 'Reference No']) || '').trim();
        const amt    = normNum(pickCell(row, ['Amount', 'Paid Amount', 'PaidAmount', 'Net Amount', 'NetAmount', 'TransactionAmount']));
        const dateRaw = pickCell(row, ['Date', 'Payment Date', 'UTR Date', 'TransactionDate', 'TxnDate']);
        const polKey = polRaw ? String(polRaw).trim().toUpperCase() : null;
        const trkKey = trkRaw ? String(trkRaw).trim().toUpperCase() : null;
        const matchId = (polKey && byPolicy.get(polKey))
                     || (trkKey && byTracker.get(trkKey))
                     || null;
        let paidAt = null;
        if (dateRaw) {
          const d = new Date(dateRaw);
          if (!isNaN(d.getTime())) paidAt = d;
        }
        if (matchId) {
          matched++;
          if (amt) totalAmount += amt;
          await new sql.Request(tx)
            .input('id',   sql.Int, matchId)
            .input('utr',  sql.NVarChar(200), utr || null)
            .input('amt',  sql.Decimal(18, 2), amt)
            .input('at',   sql.DateTime, paidAt)
            .input('upl',  sql.Int, uploadId)
            .query(`UPDATE cycle_bulk_rows
                     SET paid_status    = 'paid',
                         paid_utr       = @utr,
                         paid_amount    = @amt,
                         paid_at        = COALESCE(@at, GETDATE()),
                         paid_upload_id = @upl,
                         updated_at     = GETDATE()
                     WHERE id = @id`);
        } else {
          unmatched++;
          if (unmatchedSamples.length < 100) {
            unmatchedSamples.push({
              policy_no: polRaw, tracker_no: trkRaw, utr, amount: amt,
            });
          }
        }
      }

      // Mark every cycle row that *wasn't* paid as 'unpaid' (only if it
      // doesn't already carry a status — we leave 'paid' rows alone).
      // Paid status only applies to rows that should have been paid in the
      // first place — i.e. not excluded / moved.
      await new sql.Request(tx)
        .input('cid', sql.Int, cycleId)
        .input('upl', sql.Int, uploadId)
        .query(`UPDATE cycle_bulk_rows
                 SET paid_status = 'unpaid'
                 WHERE cycle_id = @cid
                   AND (paid_status IS NULL OR paid_status = 'unpaid')
                   AND (excluded IS NULL OR excluded = 0)
                   AND (moved_to_cycle_id IS NULL)`);

      await new sql.Request(tx)
        .input('id',   sql.Int, uploadId)
        .input('m',    sql.Int, matched)
        .input('u',    sql.Int, unmatched)
        .input('amt',  sql.Decimal(18, 2), totalAmount)
        .query(`UPDATE utr_uploads
                 SET matched_count = @m, unmatched_count = @u, total_amount = @amt
                 WHERE id = @id`);
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) {}
      throw err;
    }

    // Stats: how many cycle_bulk_rows are now unpaid + their total outgoing.
    const unpaidStats = await pool.request()
      .input('cid', sql.Int, cycleId)
      .query(`SELECT COUNT(*) AS n FROM cycle_bulk_rows
               WHERE cycle_id = @cid AND paid_status = 'unpaid'
                 AND (excluded IS NULL OR excluded = 0)
                 AND moved_to_cycle_id IS NULL`);

    res.json({
      success: true,
      upload_id: uploadId,
      file_name: req.file.originalname,
      utr_rows:  rawRows.length,
      matched, unmatched,
      total_amount: +totalAmount.toFixed(2),
      cycle_unpaid_count: unpaidStats.recordset[0].n,
      unmatched_samples: unmatchedSamples,
    });
  } catch (err) { next(err); }
});

/** GET /:cycleId/unpaid — list policies in the cycle that are still unpaid
 *  (paid_status = 'unpaid' or NULL after at least one UTR upload).  */
router.get('/:cycleId(\\d+)/unpaid', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const r = await pool.request()
      .input('cid', sql.Int, cycleId)
      .query(`SELECT id, policy_no, tracker_no, agent_code, insurer_slug, row_json,
                     rate_pct_override, margin_pct_override, outgoing_pct_override,
                     excluded, moved_to_cycle_id, note, paid_status, paid_at,
                     paid_utr, paid_amount, paid_upload_id, paid_note
              FROM cycle_bulk_rows
              WHERE cycle_id = @cid
                AND (paid_status IS NULL OR paid_status = 'unpaid')
                AND (excluded IS NULL OR excluded = 0)
                AND moved_to_cycle_id IS NULL`);
    const rows = r.recordset.map(applyOverrides);
    res.json({ success: true, count: rows.length, rows });
  } catch (err) { next(err); }
});

/** POST /:cycleId/move-unpaid  body: { target_cycle_id, policy_nos? }
 *  Bulk-move every unpaid row in the source cycle into the target cycle.
 *  If `policy_nos` is given, only those are moved; otherwise every unpaid
 *  row qualifies. Reuses the same exclusion + insert pattern as /move. */
router.post('/:cycleId(\\d+)/move-unpaid', async (req, res, next) => {
  try {
    const pool = await getPool();
    const srcId = Number(req.params.cycleId);
    const tgtId = Number(req.body && req.body.target_cycle_id);
    const onlyPolicies = Array.isArray(req.body && req.body.policy_nos)
      ? req.body.policy_nos.map(p => String(p).trim()).filter(Boolean)
      : null;
    if (!tgtId)            return res.status(400).json({ success: false, error: 'target_cycle_id required' });
    if (srcId === tgtId)   return res.status(400).json({ success: false, error: 'target cycle must differ from source' });

    const finSrc = await isCycleFinalized(pool, srcId);
    if (finSrc) return finalizedRejection(res, finSrc);
    const finTgt = await isCycleFinalized(pool, tgtId);
    if (finTgt) return res.status(423).json({ success: false, error: 'Target cycle is finalized.', finalized_at: finTgt.finalized_at });

    const tgt = await getCycle(pool, tgtId);
    if (!tgt) return res.status(404).json({ success: false, error: 'Target cycle not found' });

    // Pick rows.
    const rqPick = pool.request().input('cid', sql.Int, srcId);
    let pickWhere = `WHERE cycle_id = @cid
                       AND (paid_status IS NULL OR paid_status = 'unpaid')
                       AND (excluded IS NULL OR excluded = 0)
                       AND moved_to_cycle_id IS NULL`;
    if (onlyPolicies && onlyPolicies.length > 0) {
      const params = onlyPolicies.slice(0, 1000).map((p, j) => {
        rqPick.input('p' + j, sql.NVarChar(200), p);
        return '@p' + j;
      });
      pickWhere += ` AND policy_no IN (${params.join(',')})`;
    }
    const pick = await rqPick.query(`SELECT * FROM cycle_bulk_rows ${pickWhere}`);
    if (pick.recordset.length === 0) {
      return res.json({ success: true, moved: 0, target_cycle_id: tgtId });
    }

    // Make sure the target cycle has a run header.
    await pool.request().input('cid', sql.Int, tgtId).query(
      `IF NOT EXISTS (SELECT 1 FROM cycle_runs WHERE cycle_id = @cid)
         INSERT INTO cycle_runs (cycle_id, row_count, totals_json) VALUES (@cid, 0, '{}')`
    );

    let moved = 0;
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const row of pick.recordset) {
        const pn = row.policy_no;
        // Replace if it already exists in target.
        await new sql.Request(tx)
          .input('cid', sql.Int, tgtId).input('pn', sql.NVarChar(200), pn)
          .query('DELETE FROM cycle_bulk_rows WHERE cycle_id = @cid AND policy_no = @pn');
        await new sql.Request(tx)
          .input('cid',   sql.Int, tgtId)
          .input('pn',    sql.NVarChar(200), pn)
          .input('tn',    sql.NVarChar(200), row.tracker_no)
          .input('is',    sql.VarChar(100),  row.insurer_slug)
          .input('ac',    sql.NVarChar(100), row.agent_code)
          .input('json',  sql.NVarChar(sql.MAX), row.row_json)
          .input('r',     sql.Decimal(10, 4), row.rate_pct_override)
          .input('m',     sql.Decimal(10, 4), row.margin_pct_override)
          .input('op',    sql.Decimal(10, 4), row.outgoing_pct_override)
          .input('nt',    sql.NVarChar(500),  `Carried forward from cycle #${srcId} (unpaid)`)
          .query(`INSERT INTO cycle_bulk_rows
                    (cycle_id, policy_no, tracker_no, insurer_slug, agent_code, row_json,
                     rate_pct_override, margin_pct_override, outgoing_pct_override, note)
                  VALUES (@cid, @pn, @tn, @is, @ac, @json, @r, @m, @op, @nt)`);
        await new sql.Request(tx)
          .input('id',  sql.Int, row.id)
          .input('tgt', sql.Int, tgtId)
          .input('nt',  sql.NVarChar(500), `Moved unpaid → cycle #${tgtId}`)
          .query(`UPDATE cycle_bulk_rows
                   SET excluded = 1, moved_to_cycle_id = @tgt, note = @nt, updated_at = GETDATE()
                   WHERE id = @id`);
        moved++;
      }
      await new sql.Request(tx)
        .input('cid', sql.Int, tgtId)
        .query(`UPDATE cycle_runs
                 SET row_count = (SELECT COUNT(*) FROM cycle_bulk_rows WHERE cycle_id = @cid)
                 WHERE cycle_id = @cid`);
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) {}
      throw err;
    }
    res.json({ success: true, moved, target_cycle_id: tgtId, target_cycle_name: tgt.name });
  } catch (err) { next(err); }
});

/** GET /:cycleId/utr-uploads — history of UTR files uploaded against this cycle. */
router.get('/:cycleId(\\d+)/utr-uploads', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const r = await pool.request()
      .input('cid', sql.Int, cycleId)
      .query(`SELECT id, file_name, row_count, matched_count, unmatched_count,
                     total_amount, uploaded_at, uploaded_by, status
              FROM utr_uploads
              WHERE cycle_id = @cid AND status = 'active'
              ORDER BY uploaded_at DESC`);
    res.json({ success: true, count: r.recordset.length, uploads: r.recordset });
  } catch (err) { next(err); }
});

// ── Recovery (CQB / cancellations) ─────────────────────────────────────────

/**
 * POST /:cycleId/rows/:policyNo/cqb  body: { reason }
 * Mark a policy as Cheque Bounce / cancelled. The row is excluded from the
 * current cycle totals AND a recovery entry is created against the agent.
 * The recovery is then deducted from the agent's payout in subsequent cycles
 * via routes/payout.js.
 */
router.post('/:cycleId(\\d+)/rows/:policyNo/cqb', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const pn      = String(req.params.policyNo || '').trim();
    const kind    = String((req.body && req.body.kind) || 'CQB').trim().toUpperCase();
    // Default reason text differs by kind so audit logs read naturally.
    const reasonInput = String((req.body && req.body.reason) || '').trim();
    const defaultReason = kind === 'CANCELLED' ? 'Policy cancelled' : 'Cheque bounced';
    const reason = reasonInput || defaultReason;
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const fin = await isCycleFinalized(pool, cycleId);
    if (fin) return finalizedRejection(res, fin);

    // Pull the row (with overrides applied) so we know exactly what was paid.
    const r = await pool.request()
      .input('cid', sql.Int, cycleId).input('pn', sql.NVarChar(200), pn)
      .query(`SELECT id, policy_no, agent_code, insurer_slug, row_json,
                     rate_pct_override, margin_pct_override, outgoing_pct_override, excluded
              FROM cycle_bulk_rows WHERE cycle_id = @cid AND policy_no = @pn`);
    if (r.recordset.length === 0) return res.status(404).json({ success: false, error: 'Row not found in this cycle' });
    const row = r.recordset[0];
    const applied = applyOverrides(row);
    const recoveryAmount = +Number(applied.outgoing || 0).toFixed(2);
    const agentCode = applied.agent_code || row.agent_code || null;
    const agentName = applied.agent_name || null;
    const insurerSlug = applied.insurer_slug || row.insurer_slug || null;
    if (!agentCode) {
      return res.status(400).json({ success: false, error: 'Cannot create recovery: row has no agent_code (UPIN).' });
    }

    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      // Avoid duplicate recoveries for the same (policy_no, original_cycle_id).
      const existing = await new sql.Request(tx)
        .input('pn',  sql.NVarChar(200), pn)
        .input('cid', sql.Int, cycleId)
        .query(`SELECT id FROM agent_recoveries
                 WHERE policy_no = @pn AND original_cycle_id = @cid AND status <> 'written_off'`);
      if (existing.recordset.length > 0) {
        await tx.rollback();
        return res.status(409).json({ success: false, error: 'Recovery already exists for this policy in this cycle.' });
      }

      // Persist the kind (CQB or CANCELLED) as a prefix in the reason so
      // audits / drill-down can tell them apart without a schema change.
      const reasonStored = `[${kind === 'CANCELLED' ? 'CANCELLED' : 'CQB'}] ${reason}`;
      await new sql.Request(tx)
        .input('ac',  sql.NVarChar(100), agentCode)
        .input('an',  sql.NVarChar(300), agentName)
        .input('pn',  sql.NVarChar(200), pn)
        .input('oc',  sql.Int, cycleId)
        .input('is',  sql.VarChar(100),  insurerSlug)
        .input('amt', sql.Decimal(18, 2), recoveryAmount)
        .input('rs',  sql.NVarChar(500), reasonStored)
        .query(`INSERT INTO agent_recoveries
                  (agent_code, agent_name, policy_no, original_cycle_id, insurer_slug,
                   recovery_amount, reason, status)
                VALUES (@ac, @an, @pn, @oc, @is, @amt, @rs, 'pending')`);

      // Mark the row as excluded so the source cycle totals reflect the
      // cancellation. Note carries the recovery info for visibility.
      const noteLabel = kind === 'CANCELLED' ? 'CANCELLED' : 'CQB';
      await new sql.Request(tx)
        .input('cid',  sql.Int, cycleId)
        .input('pn',   sql.NVarChar(200), pn)
        .input('note', sql.NVarChar(500), `${noteLabel}: ${reason} — ₹${recoveryAmount.toLocaleString('en-IN')} recovery pending against ${agentCode}`)
        .query(`UPDATE cycle_bulk_rows
                 SET excluded = 1, note = @note, updated_at = GETDATE()
                 WHERE cycle_id = @cid AND policy_no = @pn`);

      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* noop */ }
      throw err;
    }
    res.json({
      success: true,
      kind: kind === 'CANCELLED' ? 'CANCELLED' : 'CQB',
      recovery_amount: recoveryAmount,
      agent_code: agentCode,
      agent_name: agentName,
      reason,
    });
  } catch (err) { next(err); }
});

/**
 * GET /recoveries?agent_code=&status=&policy_no=
 * Pending or applied recoveries — the Payout Summary screen uses this to
 * surface the per-agent deduction; an Admin screen lists everything.
 */
router.get('/recoveries', async (req, res, next) => {
  try {
    const pool = await getPool();
    const where = [];
    const rq = pool.request();
    if (req.query.agent_code) { rq.input('ac', sql.NVarChar(100), req.query.agent_code); where.push('agent_code = @ac'); }
    if (req.query.status)     { rq.input('st', sql.VarChar(20), req.query.status);     where.push('status = @st'); }
    if (req.query.policy_no)  { rq.input('pn', sql.NVarChar(200), req.query.policy_no); where.push('policy_no = @pn'); }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const r = await rq.query(
      `SELECT id, agent_code, agent_name, policy_no, original_cycle_id, insurer_slug,
              recovery_amount, reason, status, applied_in_cycle_id, applied_amount,
              applied_at, created_at, notes
       FROM agent_recoveries ${whereSql}
       ORDER BY status ASC, created_at DESC`
    );
    res.json({ success: true, count: r.recordset.length, recoveries: r.recordset });
  } catch (err) { next(err); }
});

/**
 * PUT /recoveries/:id/apply  body: { applied_amount?, applied_in_cycle_id, notes? }
 * Mark a recovery (fully or partially) deducted in a payout cycle. If the
 * applied_amount equals or exceeds recovery_amount → status='applied';
 * otherwise it stays 'pending' but the running total ticks up.
 */
router.put('/recoveries/:id(\\d+)/apply', async (req, res, next) => {
  try {
    const pool = await getPool();
    const id = Number(req.params.id);
    const cycleId = Number(req.body && req.body.applied_in_cycle_id);
    if (!cycleId) return res.status(400).json({ success: false, error: 'applied_in_cycle_id required' });

    const cur = await pool.request().input('id', sql.Int, id)
      .query('SELECT recovery_amount, applied_amount FROM agent_recoveries WHERE id = @id');
    if (cur.recordset.length === 0) return res.status(404).json({ success: false, error: 'Recovery not found' });
    const target = Number(cur.recordset[0].recovery_amount);
    const already = Number(cur.recordset[0].applied_amount || 0);
    const requested = req.body && req.body.applied_amount != null
      ? Number(req.body.applied_amount)
      : (target - already);
    const newApplied = Math.min(target, already + requested);
    const status = newApplied >= target - 0.01 ? 'applied' : 'pending';
    await pool.request()
      .input('id',  sql.Int, id)
      .input('ap',  sql.Decimal(18, 2), newApplied)
      .input('cid', sql.Int, cycleId)
      .input('st',  sql.VarChar(20), status)
      .input('nt',  sql.NVarChar(500), (req.body && req.body.notes) || null)
      .query(`UPDATE agent_recoveries
               SET applied_amount      = @ap,
                   applied_in_cycle_id = @cid,
                   applied_at          = GETDATE(),
                   status              = @st,
                   notes               = COALESCE(@nt, notes)
               WHERE id = @id`);
    res.json({ success: true, applied_amount: newApplied, status });
  } catch (err) { next(err); }
});

/** PUT /recoveries/:id/write-off — abandon a recovery (e.g. agent left). */
router.put('/recoveries/:id(\\d+)/write-off', async (req, res, next) => {
  try {
    const pool = await getPool();
    const id = Number(req.params.id);
    const note = (req.body && req.body.notes) || 'Written off';
    const r = await pool.request()
      .input('id', sql.Int, id)
      .input('nt', sql.NVarChar(500), note)
      .query(`UPDATE agent_recoveries
              SET status = 'written_off', notes = @nt, applied_at = GETDATE()
              WHERE id = @id`);
    if (r.rowsAffected[0] === 0) return res.status(404).json({ success: false, error: 'Recovery not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** DELETE /:cycleId — wipe snapshot (keeps the cycle definition). */
router.delete('/:cycleId(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cycleId = Number(req.params.cycleId);
    const fin = await isCycleFinalized(pool, cycleId);
    if (fin) return finalizedRejection(res, fin);
    await pool.request().input('cid', sql.Int, cycleId).query('DELETE FROM cycle_bulk_rows WHERE cycle_id = @cid');
    await pool.request().input('cid', sql.Int, cycleId).query('DELETE FROM cycle_runs WHERE cycle_id = @cid');
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * POST /:cycleId/diagnose-missing — for a list of tracker numbers, look each
 * up in tmp_PrarambhData and the cycle snapshot, then return a per-tracker
 * reason for absence: out-of-window / null-insurer / null-policy / endorsed
 * / matched-under-different-tracker / etc.
 *
 * Body: { trackers: ["MT/...", ...] }
 */
router.post('/:cycleId(\\d+)/diagnose-missing',
  express.json(),
  async (req, res, next) => {
    try {
      const cycleId = Number(req.params.cycleId);
      const trackers = Array.isArray(req.body && req.body.trackers) ? req.body.trackers : [];
      if (trackers.length === 0) return res.status(400).json({ success: false, error: 'trackers array required' });
      const pool = await getPool();
      const cyc = await getCycle(pool, cycleId);
      if (!cyc) return res.status(404).json({ success: false, error: 'Cycle not found' });
      const dateFrom = new Date(cyc.date_from);
      const dateTo   = new Date(cyc.date_to);

      // Step 1: lookup each tracker in tmp_PrarambhData (UAT pool).
      const prarambhPool = await getPrarambhUatPool();
      const sourceByTracker = new Map();
      // Chunk in batches of 500 to keep IN-list manageable.
      for (let i = 0; i < trackers.length; i += 500) {
        const batch = trackers.slice(i, i + 500);
        const r = prarambhPool.request();
        const names = batch.map((t, j) => { r.input('t' + j, sql.NVarChar(200), t); return '@t' + j; });
        const qr = await r.query(
          `SELECT TrackerNo, PolicyNo, SubmissionDate, INSURERNAME, FinalStatusName
           FROM tmp_PrarambhData
           WHERE TrackerNo IN (${names.join(',')})`
        );
        for (const row of qr.recordset) sourceByTracker.set(row.TrackerNo, row);
      }

      // Step 2: load cycle snapshot keyed by policy_no.
      const dbRows = await pool.request()
        .input('cid', sql.Int, cycleId)
        .query(`SELECT policy_no, row_json FROM cycle_bulk_rows WHERE cycle_id = @cid`);
      const cycleByPolicy = new Map();
      const cycleByTracker = new Map();
      for (const r of dbRows.recordset) {
        const merged = JSON.parse(r.row_json || '{}');
        if (merged.policy_no) cycleByPolicy.set(String(merged.policy_no).trim(), merged);
        if (merged.tracker_no) cycleByTracker.set(String(merged.tracker_no).trim(), merged);
      }

      // Step 3: classify each tracker.
      const out = [];
      for (const t of trackers) {
        const src = sourceByTracker.get(t);
        if (!src) {
          out.push({ tracker: t, reason: 'not_in_source', detail: 'No row in tmp_PrarambhData' });
          continue;
        }
        const sd = src.SubmissionDate ? new Date(src.SubmissionDate) : null;
        const inWindow = sd && sd >= dateFrom && sd <= dateTo;
        const r = {
          tracker: t,
          source_policy_no: src.PolicyNo || null,
          source_submit_date: src.SubmissionDate || null,
          source_insurer: src.INSURERNAME || null,
          source_status: src.FinalStatusName || null,
        };
        if (!src.PolicyNo) { r.reason = 'null_policy_no'; out.push(r); continue; }
        if (!src.INSURERNAME) { r.reason = 'null_insurer'; out.push(r); continue; }
        if (!inWindow) {
          r.reason = sd && sd < dateFrom ? 'submit_before_window' : 'submit_after_window';
          out.push(r);
          continue;
        }
        // In window — check if the policy IS in cycle 11 under a different tracker.
        const cyc = cycleByPolicy.get(String(src.PolicyNo).trim());
        if (cyc) {
          r.reason = 'in_cycle_under_different_tracker';
          r.cycle_tracker = cyc.tracker_no;
          r.cycle_rate_pct = cyc.rate_pct;
          out.push(r);
          continue;
        }
        // In window, insurer + policy_no present, but not in cycle → likely
        // dropped by the insurer-slug filter or by cycle-agent allowlist.
        const cfgInsurer = String(src.INSURERNAME).toLowerCase();
        // Check rate_cards configured slugs (already fetched once per call).
        // For simplicity, just flag as "filtered" — operator can drill in.
        r.reason = 'filtered_out_during_calc';
        r.detail = 'In date window but not in cycle — likely insurer without rate card, or agent allowlist filter';
        out.push(r);
      }

      // Summary buckets.
      const summary = {};
      for (const r of out) summary[r.reason] = (summary[r.reason] || 0) + 1;
      res.json({ success: true, cycle_id: cycleId,
        cycle_window: { from: cyc.date_from, to: cyc.date_to },
        total: out.length, summary, rows: out });
    } catch (err) { next(err); }
  }
);

/**
 * POST /:cycleId/compare-trackers — one-time reconciliation tool.
 *
 * Accepts an Excel / CSV upload with two columns:
 *   - Tracker No / TrackerNo / Tracker / PTrackerno
 *   - Total Rate / TotalRate / Rate %        (decimal or % string)
 *
 * Joins against the cycle's snapshot and returns:
 *   - missing_in_our_data : trackers in the Excel that aren't in the cycle
 *   - missing_in_excel    : trackers in the cycle that aren't in the Excel
 *   - rate_comparison     : matched trackers with our rate_pct vs their total_rate
 *                           and the diff (in %). Sorted by abs(diff) desc.
 */
// Last-uploaded reconciliation file per cycle, so the user can re-compare
// after a recompute without re-uploading. Persisted to a JSON sidecar so it
// survives server restarts.
const RECON_CACHE_PATH = path.join(UPLOAD_DIR, '_recon_file_cache.json');
function loadReconCache() {
  try { return JSON.parse(fs.readFileSync(RECON_CACHE_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveReconFile(cycleId, filePath, originalName) {
  const c = loadReconCache();
  c[String(cycleId)] = { path: filePath, name: originalName || null, at: new Date().toISOString() };
  try { fs.writeFileSync(RECON_CACHE_PATH, JSON.stringify(c, null, 2)); } catch (_) { /* noop */ }
}

/** Core comparison — shared by the upload route and the re-compare route. */
// Parse ?compare_cycles=11,12 (or body) → extra cycle ids (excluding primary).
function parseCompareCycles(req, primary) {
  const raw = String((req.query && req.query.compare_cycles) || (req.body && req.body.compare_cycles) || '');
  return [...new Set(raw.split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n !== primary))];
}

async function compareTrackersCore(cycleId, filePath, fmt, res, extraCycleIds = []) {
      const pool = await getPool();

      // Parse the uploaded file. Operator workbooks may stack a group-label
      // row above the real headers and keep the tracker detail on a "Data"
      // sheet — both handled below.
      const wb = XLSX.readFile(filePath);
      const normHeader = (s) => String(s || '').toLowerCase().replace(/[\s_/%-]+/g, '');
      const trackerPats = ['trackerno', 'ptrackerno', 'tracker'];
      const ratePats    = ['totalrate', 'totalrt', 'ratepct', 'rate'];
      const isTracker = (s) => { const n = normHeader(s); return trackerPats.some(p => n === p || n.includes(p)); };
      const isRate    = (s) => { const n = normHeader(s); return ratePats.some(p => n === p || n.includes(p)); };
      // Scan EVERY sheet for the one whose header row carries BOTH a
      // tracker-ish and a total-rate-ish cell. Operator workbooks often
      // lead with a payout-summary sheet (Vertical/Branch/Bank) and keep
      // the tracker-level detail on a later sheet. Within each sheet, scan
      // the first 10 rows so a group-label band above the headers is OK.
      let arr = null, headerRowIdx = -1, chosenSheet = null;
      const sheetProbes = [];
      // Prefer a sheet literally named "Data" (the operator's tracker-level
      // detail tab) before falling back to the rest. Avoids accidentally
      // locking onto a payout-summary sheet whose headers also contain a
      // loose "rate"-ish column.
      const orderedSheets = [
        ...wb.SheetNames.filter(sn => /^data$/i.test(String(sn).trim())),
        ...wb.SheetNames.filter(sn => !/^data$/i.test(String(sn).trim())),
      ];
      for (const sn of orderedSheets) {
        const a = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '', raw: false });
        let hr = -1;
        for (let i = 0; i < Math.min(a.length, 10); i++) {
          const r = a[i] || [];
          if (r.some(isTracker) && r.some(isRate)) { hr = i; break; }
        }
        sheetProbes.push(`${sn}: ${a[0] ? a[0].slice(0, 8).join(' | ') : '(empty)'}`);
        if (hr >= 0) { arr = a; headerRowIdx = hr; chosenSheet = sn; break; }
      }
      if (headerRowIdx < 0) {
        return res.status(400).json({
          success: false,
          error: `Could not detect Tracker / Total Rate header row in any sheet. Sheets scanned:\n${sheetProbes.join('\n')}`,
        });
      }
      const headers = arr[headerRowIdx];
      const dataRows = arr.slice(headerRowIdx + 1);
      // Map to objects using the detected headers.
      const rawRows = dataRows.map(r => {
        const o = {};
        for (let c = 0; c < headers.length; c++) o[String(headers[c] || `_col${c}`)] = r[c] != null ? r[c] : '';
        return o;
      });
      const findKey = (row, patterns) => {
        for (const k of Object.keys(row)) {
          const n = normHeader(k);
          if (patterns.some(p => n === p || n.includes(p))) return k;
        }
        return null;
      };
      // Resolve columns by INDEX (not object key) because operator workbooks
      // frequently repeat header names — e.g. the conso file has two "Rewards"
      // columns (one a rate, one a commission amount). Object-keyed access
      // would silently collapse them; index access is unambiguous.
      const idxOf = (patterns, fromIdx = 0) => {
        for (let c = fromIdx; c < headers.length; c++) {
          const n = normHeader(headers[c]);
          if (patterns.some(p => n === p || n.includes(p))) return c;
        }
        return -1;
      };
      const trackerColIdx = idxOf(trackerPats);
      // Total Rate = the operator's gross commission rate INCLUDING the
      // "Rewards" incentive line. We don't model Rewards, so the apples-to-
      // apples comparison against our computed rate is (Total Rate − Rewards),
      // which equals the operator's "Net%" base for GCV/TW/PCV and the
      // effective rate for CAR (where Net% is left blank). Pick the Rewards
      // column that sits just LEFT of Total Rate (the rate-block rewards),
      // not the later commission-amount "Rewards".
      const totalRateColIdx = idxOf(['totalrate']) >= 0 ? idxOf(['totalrate'])
                            : (idxOf(['totalrt']) >= 0 ? idxOf(['totalrt']) : idxOf(ratePats));
      let rewardsColIdx = -1;
      for (let c = totalRateColIdx - 1; c >= 0; c--) {
        if (normHeader(headers[c]) === 'rewards' || normHeader(headers[c]).includes('reward')) { rewardsColIdx = c; break; }
      }
      if (trackerColIdx < 0 || totalRateColIdx < 0) {
        return res.status(400).json({
          success: false,
          error: `Could not detect Tracker / Total Rate columns. Header row ${headerRowIdx} = ${headers.join(' | ')}`,
        });
      }

      // Build excelMap: tracker → rate (decimal as % i.e. 12.5 means 12.5%)
      const parseRate = (v) => {
        if (v == null || v === '') return null;
        const s = String(v).trim().replace(/%/g, '').replace(/,/g, '');
        const n = Number(s);
        if (!Number.isFinite(n)) return null;
        // Heuristic: if value <= 1, treat as fraction (0.275 → 27.5%);
        //            else assume already in %.
        return n <= 1 ? +(n * 100).toFixed(3) : +n.toFixed(3);
      };
      const excelMap = new Map();
      for (const r of dataRows) {
        const t = String(r[trackerColIdx] || '').trim();
        if (!t) continue;
        const total = parseRate(r[totalRateColIdx]);
        const rewards = rewardsColIdx >= 0 ? parseRate(r[rewardsColIdx]) : null;
        // Net commission rate = Total − Rewards (Rewards is an incentive we
        // don't compute). Guard: only subtract when both are present.
        let rate = total;
        if (total != null && rewards != null) rate = +(total - rewards).toFixed(3);
        excelMap.set(t, rate);
      }

      // Load our cycle snapshot.
      // Build `ours` from the primary cycle + any extra cycles requested, so a
      // tracker booked in another cycle (e.g. the April-1st cycle) isn't flagged
      // missing. Primary cycle ordered LAST so it wins if a tracker is in both.
      const cmpIds = [...new Set([...(extraCycleIds || []), cycleId])].filter(n => Number.isInteger(n));
      const dbRows = await pool.request()
        .query(`SELECT id, policy_no, row_json,
                       rate_pct_override, margin_pct_override,
                       outgoing_pct_override, excluded, note
                FROM cycle_bulk_rows WHERE cycle_id IN (${cmpIds.join(',')})
                ORDER BY CASE WHEN cycle_id = ${cycleId} THEN 1 ELSE 0 END`);

      const ours = new Map();   // tracker → { our_rate, policy_no, income, ... }
      for (const r of dbRows.recordset) {
        const merged = applyOverrides(r);
        const tracker = merged.tracker_no || merged.policy_no;
        if (!tracker) continue;
        ours.set(String(tracker).trim(), {
          policy_no: merged.policy_no,
          tracker_no: merged.tracker_no,
          insurer: merged.insurer || merged.insurer_slug || null,
          insurer_slug: merged.insurer_slug || null,
          vehicle_type: merged.vehicle_type || null,
          our_rate: merged.rate_pct != null ? Number(merged.rate_pct) : null,
          income: merged.income,
          premium_base: merged.premium_base,
          excluded: !!merged.excluded,
          matched_rule_id: merged.matched_rule_id,
        });
      }

      // Set differences.
      const missing_in_our_data = [];
      const rate_comparison = [];
      for (const [tracker, theirRate] of excelMap.entries()) {
        const us = ours.get(tracker);
        if (!us) { missing_in_our_data.push({ tracker, their_rate: theirRate }); continue; }
        const diff = (us.our_rate != null && theirRate != null)
          ? +(us.our_rate - theirRate).toFixed(3)
          : null;
        rate_comparison.push({
          tracker,
          policy_no: us.policy_no,
          insurer: us.insurer,
          insurer_slug: us.insurer_slug,
          vehicle_type: us.vehicle_type,
          our_rate: us.our_rate,
          their_rate: theirRate,
          diff,
          income: us.income,
          excluded: us.excluded,
          no_rule: !us.matched_rule_id,
          // rate_match: true when within tolerance. Default ±0.5%, but Reliance
          // uses ±1.0% — its operator tracker applies a ~1% Rewards/retention so the
          // net paid rate is consistently ~1 below the grid we compute (per direction:
          // "if 1 diff consider as match" — Reliance only). When we produce NO rule
          // (our_rate null → zero commission) and the operator also paid zero, that's
          // agreement (both decline) — count it as a match.
          rate_match: (us.our_rate != null && theirRate != null)
            ? Math.abs(us.our_rate - theirRate) <= (/reliance/i.test(us.insurer_slug || '') ? 1 : 0.5)
            : (us.our_rate == null && (theirRate == null || theirRate === 0)),
        });
      }
      const missing_in_excel = [];
      for (const [tracker, us] of ours.entries()) {
        if (!excelMap.has(tracker)) missing_in_excel.push({
          tracker, policy_no: us.policy_no, insurer: us.insurer,
          insurer_slug: us.insurer_slug, vehicle_type: us.vehicle_type,
          our_rate: us.our_rate,
        });
      }

      // Sort the rate comparison by |diff| desc so largest mismatches surface first.
      rate_comparison.sort((a, b) => Math.abs(b.diff || 0) - Math.abs(a.diff || 0));

      const summary = {
        excel_total:               excelMap.size,
        cycle_total:               ours.size,
        missing_in_our_data_count: missing_in_our_data.length,
        missing_in_excel_count:    missing_in_excel.length,
        matched_count:             rate_comparison.length,
        // Within matched, how many have a rate difference > 0.5% vs perfect agreement.
        rate_match_exact:    rate_comparison.filter(r => r.diff != null && Math.abs(r.diff) < 0.01).length,
        rate_match_within_1: rate_comparison.filter(r => r.diff != null && Math.abs(r.diff) < 1).length,
        rate_diff_over_5:    rate_comparison.filter(r => r.diff != null && Math.abs(r.diff) > 5).length,
        // Rate match within ±0.5% tolerance (the UI's match/un-match split).
        rate_matched:        rate_comparison.filter(r => r.rate_match).length,
        rate_unmatched:      rate_comparison.filter(r => !r.rate_match).length,
      };

      // CSV / XLSX download — fmt passed by the caller route.
      if (fmt === 'xlsx') {
        const wbOut = XLSX.utils.book_new();
        const summarySheet = XLSX.utils.json_to_sheet([summary]);
        XLSX.utils.book_append_sheet(wbOut, summarySheet, 'Summary');
        const rcSheet = XLSX.utils.json_to_sheet(rate_comparison);
        XLSX.utils.book_append_sheet(wbOut, rcSheet, 'Rate Comparison');
        const m1 = XLSX.utils.json_to_sheet(missing_in_our_data);
        XLSX.utils.book_append_sheet(wbOut, m1, 'Missing In Our Data');
        const m2 = XLSX.utils.json_to_sheet(missing_in_excel);
        XLSX.utils.book_append_sheet(wbOut, m2, 'Missing In Excel');
        const buf = XLSX.write(wbOut, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="cycle${cycleId}_compare.xlsx"`);
        return res.send(buf);
      }
      if (fmt === 'csv') {
        const esc = (v) => {
          if (v == null) return '';
          const s = String(v);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const sections = [];
        sections.push('# Summary');
        sections.push(Object.keys(summary).join(','));
        sections.push(Object.values(summary).map(esc).join(','));
        sections.push('');
        sections.push('# Rate Comparison (largest |diff| first)');
        if (rate_comparison[0]) {
          const cols = Object.keys(rate_comparison[0]);
          sections.push(cols.join(','));
          for (const r of rate_comparison) sections.push(cols.map(c => esc(r[c])).join(','));
        }
        sections.push('');
        sections.push('# Missing In Our Data (in Excel, not in cycle)');
        if (missing_in_our_data[0]) {
          const cols = Object.keys(missing_in_our_data[0]);
          sections.push(cols.join(','));
          for (const r of missing_in_our_data) sections.push(cols.map(c => esc(r[c])).join(','));
        }
        sections.push('');
        sections.push('# Missing In Excel (in cycle, not in Excel)');
        if (missing_in_excel[0]) {
          const cols = Object.keys(missing_in_excel[0]);
          sections.push(cols.join(','));
          for (const r of missing_in_excel) sections.push(cols.map(c => esc(r[c])).join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="cycle${cycleId}_compare.csv"`);
        return res.send('﻿' + sections.join('\r\n'));
      }

      res.json({
        success: true,
        cycle_id: cycleId,
        detected_columns: {
          tracker: headers[trackerColIdx],
          rate: headers[totalRateColIdx],
          rewards: rewardsColIdx >= 0 ? headers[rewardsColIdx] : null,
          rate_basis: rewardsColIdx >= 0 ? 'Total Rate − Rewards' : 'Total Rate',
          sheet: chosenSheet,
        },
        summary,
        missing_in_our_data,
        missing_in_excel,
        rate_comparison,
      });
}

// Upload + compare. Caches the file path so it can be re-compared later
// (e.g. after a recompute) without re-uploading.
router.post('/:cycleId(\\d+)/compare-trackers',
  utrUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'File upload required' });
      const cycleId = Number(req.params.cycleId);
      saveReconFile(cycleId, req.file.path, req.file.originalname);
      const fmt = String((req.query && req.query.format) || '').toLowerCase();
      await compareTrackersCore(cycleId, req.file.path, fmt, res, parseCompareCycles(req, cycleId));
    } catch (err) { next(err); }
  }
);

// Re-compare against the LAST uploaded file for this cycle — no re-upload.
// Reflects the current (possibly just-recomputed) cycle snapshot.
router.post('/:cycleId(\\d+)/recompare',
  async (req, res, next) => {
    try {
      const cycleId = Number(req.params.cycleId);
      const cache = loadReconCache();
      const entry = cache[String(cycleId)];
      if (!entry || !entry.path || !fs.existsSync(entry.path)) {
        return res.status(404).json({ success: false,
          error: 'No previously uploaded file for this cycle — upload once first.' });
      }
      const fmt = String((req.query && req.query.format) || '').toLowerCase();
      await compareTrackersCore(cycleId, entry.path, fmt, res, parseCompareCycles(req, cycleId));
    } catch (err) { next(err); }
  }
);

// Report whether a cached reconciliation file exists for a cycle (UI uses
// this to enable/disable the "Re-compare (last file)" button).
router.get('/:cycleId(\\d+)/recon-file', async (req, res) => {
  const entry = loadReconCache()[String(Number(req.params.cycleId))];
  res.json({ success: true, has_file: !!(entry && entry.path && fs.existsSync(entry.path)),
    name: entry ? entry.name : null, at: entry ? entry.at : null });
});

module.exports = router;
