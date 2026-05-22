/**
 * Recon Summary — consolidated reconciliation view across cycles.
 *
 * Pulls cycle_bulk_rows.row_json (per-policy snapshot) and aggregates by
 * status (OK / EX / SCR / CNR) with optional Insurer + Financial-Year
 * filters. Drill-down endpoint returns the policy-level rows for a given
 * (status, insurer, FY) combination.
 *
 * FY convention: Indian FY runs Apr 1 → Mar 31. A cycle whose date_from
 * is in Apr–Dec belongs to FY{startYear}-{startYear+1}, while Jan–Mar
 * cycles belong to FY{startYear-1}-{startYear}. Filter accepts the start
 * year (e.g. fy=2026 means FY 2026-27).
 */
const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const router = express.Router();

/** Map a YYYY-MM-DD date string → FY start year (Apr-Mar). */
function fyStartYear(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const month = d.getUTCMonth() + 1; // 1..12
  const year = d.getUTCFullYear();
  return month >= 4 ? year : year - 1;
}

/** Format FY start year as "FY26-27" (display label). */
function fyLabel(startYear) {
  if (startYear == null) return null;
  const a = String(startYear).slice(2);
  const b = String(startYear + 1).slice(2);
  return `FY${a}-${b}`;
}

/** Status normaliser — defaults to CNR for unknown / blank values. */
function statusOf(row) {
  const s = String(row.status || '').toUpperCase();
  if (s === 'OK' || s === 'EX' || s === 'SCR' || s === 'CNR') return s;
  return 'CNR';
}

/** Aggregate a list of rows into a single bucket: NOP + sum of income +
 *  statement-NOP (count where statement_amount is non-null) + sum of
 *  statement_amount. */
function emptyBucket() {
  return { nop: 0, income: 0, stmt_nop: 0, stmt_amount: 0, outgoing: 0 };
}
function addRowToBucket(bucket, row) {
  bucket.nop += 1;
  bucket.income += Number(row.income || 0);
  bucket.outgoing += Number(row.outgoing || 0);
  if (row.statement_amount != null && row.statement_amount !== '') {
    bucket.stmt_nop += 1;
    bucket.stmt_amount += Number(row.statement_amount || 0);
  }
}
function roundBucket(b) {
  return {
    nop: b.nop,
    income: +b.income.toFixed(2),
    outgoing: +b.outgoing.toFixed(2),
    stmt_nop: b.stmt_nop,
    stmt_amount: +b.stmt_amount.toFixed(2),
  };
}

/**
 * Load cycle metadata + every snapshot row matching the FY / insurer
 * filter. Reads cycle_bulk_rows.row_json — that's the canonical source
 * for "what was calculated" + "what came in via the statement upload".
 */
async function loadFilteredRows(pool, { fy, insurerSlug }) {
  // Cycles in the requested FY (Apr y → Mar y+1).
  const cycRq = pool.request();
  let cycSql = `SELECT id, name AS cycle_name, date_from, date_to FROM payout_cycles WHERE 1=1`;
  if (fy != null && Number.isFinite(Number(fy))) {
    const startYear = Number(fy);
    cycSql += ` AND date_from >= @fyStart AND date_from < @fyEnd`;
    cycRq.input('fyStart', sql.Date, `${startYear}-04-01`);
    cycRq.input('fyEnd',   sql.Date, `${startYear + 1}-04-01`);
  }
  cycSql += ` ORDER BY date_from ASC`;
  const cycRes = await cycRq.query(cycSql);
  const cycles = cycRes.recordset;
  const cycleIds = cycles.map(c => c.id);
  if (cycleIds.length === 0) return { cycles, rows: [] };

  // Pull all snapshot rows for those cycles. Insurer filter happens both
  // in SQL (when given) and as a final defensive check after row_json
  // parsing — the column was added late and some older rows may have a
  // null insurer_slug.
  const rowsRq = pool.request();
  const cycPlaceholders = cycleIds.map((id, i) => {
    const n = `c${i}`;
    rowsRq.input(n, sql.Int, id);
    return `@${n}`;
  });
  let rowsSql = `SELECT cycle_id, policy_no, tracker_no, insurer_slug, row_json
                 FROM cycle_bulk_rows
                 WHERE cycle_id IN (${cycPlaceholders.join(', ')})`;
  if (insurerSlug) {
    rowsRq.input('ins', sql.VarChar(100), insurerSlug);
    rowsSql += ` AND insurer_slug = @ins`;
  }
  const rowsRes = await rowsRq.query(rowsSql);
  const out = [];
  for (const r of rowsRes.recordset) {
    let parsed = null;
    try { parsed = JSON.parse(r.row_json || '{}'); } catch (_) { continue; }
    if (!parsed) continue;
    if (insurerSlug && parsed.insurer_slug && parsed.insurer_slug !== insurerSlug) continue;
    parsed._cycle_id = r.cycle_id;
    out.push(parsed);
  }
  return { cycles, rows: out };
}

/**
 * GET /api/recon/summary?fy=2026&insurer=tata_aig
 *
 * Returns:
 *  {
 *    success: true,
 *    filters: { fy, fy_label, insurer },
 *    cycles: [...],          — included so the UI can show date range
 *    totals: {...},          — overall NOP / Income / Stmt NOP / Stmt Amount
 *    by_status: { OK: {...}, EX: {...}, SCR: {...}, CNR: {...} },
 *    by_insurer: { tata_aig: { ...status buckets... }, chola_ms: {...} },
 *    by_cycle:   { 11: {...}, 12: {...} },
 *  }
 */
router.get('/summary', async (req, res, next) => {
  try {
    const fy = req.query.fy != null && req.query.fy !== '' ? Number(req.query.fy) : null;
    const insurerSlug = String(req.query.insurer || '').trim() || null;
    const pool = await getPool();
    const { cycles, rows } = await loadFilteredRows(pool, { fy, insurerSlug });

    const totals = emptyBucket();
    const by_status = { OK: emptyBucket(), EX: emptyBucket(), SCR: emptyBucket(), CNR: emptyBucket() };
    const by_insurer = {};
    const by_cycle = {};
    for (const row of rows) {
      const st = statusOf(row);
      addRowToBucket(totals, row);
      addRowToBucket(by_status[st], row);
      const ins = row.insurer_slug || '(unknown)';
      if (!by_insurer[ins]) by_insurer[ins] = { _label: row.insurer || ins, total: emptyBucket(), by_status: { OK: emptyBucket(), EX: emptyBucket(), SCR: emptyBucket(), CNR: emptyBucket() } };
      addRowToBucket(by_insurer[ins].total, row);
      addRowToBucket(by_insurer[ins].by_status[st], row);
      const cid = row._cycle_id;
      if (!by_cycle[cid]) by_cycle[cid] = { total: emptyBucket(), by_status: { OK: emptyBucket(), EX: emptyBucket(), SCR: emptyBucket(), CNR: emptyBucket() } };
      addRowToBucket(by_cycle[cid].total, row);
      addRowToBucket(by_cycle[cid].by_status[st], row);
    }

    // Round buckets for display
    const roundedTotals = roundBucket(totals);
    const roundedByStatus = {};
    for (const k of Object.keys(by_status)) roundedByStatus[k] = roundBucket(by_status[k]);
    const roundedByInsurer = {};
    for (const k of Object.keys(by_insurer)) {
      const v = by_insurer[k];
      const bs = {};
      for (const s of Object.keys(v.by_status)) bs[s] = roundBucket(v.by_status[s]);
      roundedByInsurer[k] = { label: v._label, total: roundBucket(v.total), by_status: bs };
    }
    const roundedByCycle = {};
    for (const k of Object.keys(by_cycle)) {
      const v = by_cycle[k];
      const bs = {};
      for (const s of Object.keys(v.by_status)) bs[s] = roundBucket(v.by_status[s]);
      // Find cycle metadata for label
      const meta = cycles.find(c => String(c.id) === String(k));
      roundedByCycle[k] = {
        cycle_id: Number(k),
        cycle_name: meta ? meta.cycle_name : null,
        date_from: meta ? meta.date_from : null,
        date_to: meta ? meta.date_to : null,
        total: roundBucket(v.total),
        by_status: bs,
      };
    }

    res.json({
      success: true,
      filters: { fy, fy_label: fy != null ? fyLabel(fy) : null, insurer: insurerSlug },
      cycles,
      totals: roundedTotals,
      by_status: roundedByStatus,
      by_insurer: roundedByInsurer,
      by_cycle: roundedByCycle,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/recon/fy-list — returns the distinct FY start-years that have
 * cycle data, plus their display labels. Used to populate the FY filter
 * dropdown in the UI.
 */
router.get('/fy-list', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT DISTINCT date_from FROM payout_cycles WHERE date_from IS NOT NULL`);
    const set = new Set();
    for (const row of r.recordset) {
      const sy = fyStartYear(row.date_from);
      if (sy != null) set.add(sy);
    }
    const list = [...set].sort((a, b) => b - a).map(sy => ({ start_year: sy, label: fyLabel(sy) }));
    res.json({ success: true, fys: list });
  } catch (err) { next(err); }
});

/**
 * GET /api/recon/policies?fy=&insurer=&status=&cycle_id=
 *
 * Drill-down: returns the policy-level rows behind a (status, insurer,
 * FY[, cycle_id]) bucket. Sorted by largest variance first so the user
 * sees the rows that need attention at the top.
 */
router.get('/policies', async (req, res, next) => {
  try {
    const fy = req.query.fy != null && req.query.fy !== '' ? Number(req.query.fy) : null;
    const insurerSlug = String(req.query.insurer || '').trim() || null;
    const status = String(req.query.status || '').toUpperCase().trim() || null;
    const cycleId = req.query.cycle_id != null && req.query.cycle_id !== '' ? Number(req.query.cycle_id) : null;
    const pool = await getPool();
    const { rows } = await loadFilteredRows(pool, { fy, insurerSlug });

    let filtered = rows;
    if (status) filtered = filtered.filter(r => statusOf(r) === status);
    if (cycleId != null && Number.isFinite(cycleId)) filtered = filtered.filter(r => r._cycle_id === cycleId);

    // Sort by absolute variance (statement - income) DESC so biggest
    // discrepancies surface first. Ties / nulls go last.
    filtered.sort((a, b) => {
      const vA = a.statement_amount != null ? Math.abs(Number(a.statement_amount) - Number(a.income || 0)) : -1;
      const vB = b.statement_amount != null ? Math.abs(Number(b.statement_amount) - Number(b.income || 0)) : -1;
      return vB - vA;
    });

    // Project a slim row for the UI table (full row_json is heavy).
    const projected = filtered.map(r => ({
      cycle_id: r._cycle_id,
      policy_no: r.policy_no,
      tracker_no: r.tracker_no,
      insurer_slug: r.insurer_slug,
      insurer: r.insurer,
      vehicle_type: r.vehicle_type,
      make: r.make,
      model: r.model,
      rto_code: r.rto_code,
      region: r.region,
      net_premium: r.net_premium,
      premium_base: r.premium_base,
      matched_segment: r.matched_segment,
      matched_rate_type: r.matched_rate_type,
      rate_pct: r.rate_pct,
      income: r.income,
      outgoing: r.outgoing,
      statement_amount: r.statement_amount,
      status: statusOf(r),
      variance: r.statement_amount != null ? +(Number(r.statement_amount) - Number(r.income || 0)).toFixed(2) : null,
    }));

    res.json({
      success: true,
      filters: { fy, fy_label: fy != null ? fyLabel(fy) : null, insurer: insurerSlug, status, cycle_id: cycleId },
      count: projected.length,
      rows: projected,
    });
  } catch (err) { next(err); }
});

module.exports = router;
