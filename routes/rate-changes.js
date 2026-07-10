'use strict';

/**
 * Rate-change tracking (v1 — grid rates).
 *
 * Every insurer's grid is stored as generations of `rate_cards` (each dated by
 * `effective_from`), and `rate_rules` hold the per-cell rates. Diffing "the same
 * cell" across consecutive generations tells us which insurer raised or cut a
 * commission rate, sliced by month / product (vehicle type) / region / all the
 * grid params. A cell is identified by KEY_COLS; two rules in different cards
 * with the same key are the same cell in different generations.
 *
 * Endpoints (all read-only):
 *   GET /insurers                      — insurers that have >=2 dated generations
 *   GET /timeline?insurer=&product=&region=&direction=&from=&to=&limit=
 *                                      — individual cell changes (old->new, delta)
 *   GET /summary?product=&from=&to=    — per-insurer (and per-month) up/down counts
 *
 * Phase 2 (not built yet): agent effective-rate changes from special_rate_rules /
 * agent_global_uplifts (they carry created_at) layered on top of the grid rate.
 */

const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const router = express.Router();

// Columns that identify a single grid "cell". Two rules that agree on all of
// these are the same cell across generations; rate_value is what may change.
const KEY_COLS = [
  'product', 'region', 'segment', 'make', 'model', 'sub_type', 'fuel_type',
  'cc_band_min', 'cc_band_max', 'weight_band_min', 'weight_band_max',
  'vehicle_age_min', 'vehicle_age_max', 'seating_capacity_min', 'seating_capacity_max',
  'volume_tier', 'addon', 'carrier_type', 'rate_type', 'applied_on', 'state',
];

const iso = (d) => d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const norm = (v) => v == null ? '' : String(v).trim().toUpperCase();
const cellKey = (r) => KEY_COLS.map((c) => norm(r[c])).join('');
const monthOf = (isoDate) => isoDate ? isoDate.slice(0, 7) : null;   // YYYY-MM

/**
 * Load each insurer cell's rate per generation, then emit a change for every
 * consecutive generation where the (max) rate_value or declined flag moved.
 * Returns { changes, generations }.
 */
async function diffInsurer(pool, insurer, filters = {}) {
  const req = pool.request().input('ins', sql.VarChar(100), insurer);
  let where = 'rr.insurer = @ins';
  if (filters.product) { req.input('prod', sql.VarChar(50), filters.product); where += ' AND rr.product = @prod'; }
  if (filters.region) { req.input('reg', sql.NVarChar(200), filters.region); where += ' AND rr.region = @reg'; }

  // One row per (cell, generation). Collapse ingest duplicates / hi-lo pairs with
  // MAX(rate_value) as the headline rate; MAX(is_declined) flags a declined cell.
  const grp = KEY_COLS.map((c) => 'rr.' + c).join(', ');
  const q = `
    SELECT ${grp}, rc.effective_from AS eff,
           MAX(rr.rate_value) AS rate, MAX(CAST(rr.is_declined AS int)) AS decl
    FROM rate_rules rr
    JOIN rate_cards rc ON rr.rate_card_id = rc.id
    WHERE ${where} AND rc.effective_from IS NOT NULL
    GROUP BY ${grp}, rc.effective_from`;
  const rows = (await req.query(q)).recordset;

  // group by cell
  const cells = new Map();
  const gens = new Set();
  for (const r of rows) {
    const k = cellKey(r);
    gens.add(iso(r.eff));
    (cells.get(k) || cells.set(k, []).get(k)).push(r);
  }

  const changes = [];
  for (const [, list] of cells) {
    list.sort((a, b) => iso(a.eff) < iso(b.eff) ? -1 : 1);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      // Normalize to a fraction — some cards store rate_value as a whole percent
      // (47) and others as a fraction (0.47); mixing them fabricates huge deltas
      // (matches the engine's rateVal>1 -> /100 convention).
      const asFrac = (v) => v == null ? null : (Number(v) > 1 ? Number(v) / 100 : Number(v));
      const oldR = asFrac(prev.rate);
      const newR = asFrac(cur.rate);
      const oldDecl = !!prev.decl, newDecl = !!cur.decl;
      const rateSame = oldR === newR;
      if (rateSame && oldDecl === newDecl) continue;    // unchanged
      const fromDate = iso(prev.eff), toDate = iso(cur.eff);
      let direction;
      if (oldDecl && !newDecl) direction = 'reinstated';
      else if (!oldDecl && newDecl) direction = 'declined';
      else if (newR > oldR) direction = 'up';
      else if (newR < oldR) direction = 'down';
      else continue;
      const rec = { insurer, from_date: fromDate, to_date: toDate, to_month: monthOf(toDate),
        old_rate: oldR, new_rate: newR, old_declined: oldDecl, new_declined: newDecl,
        delta: (oldR != null && newR != null) ? +(newR - oldR).toFixed(4) : null,
        pct_change: (oldR ? +(((newR - oldR) / oldR) * 100).toFixed(1) : null), direction };
      for (const c of KEY_COLS) rec[c] = cur[c];
      changes.push(rec);
    }
  }
  return { changes, generations: [...gens].sort() };
}

// ---- GET /insurers : insurers with >=2 dated generations -------------------
router.get('/insurers', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT rr.insurer, COUNT(DISTINCT rc.effective_from) gens,
             MIN(rc.effective_from) first_eff, MAX(rc.effective_from) last_eff
      FROM rate_rules rr JOIN rate_cards rc ON rr.rate_card_id = rc.id
      WHERE rc.effective_from IS NOT NULL
      GROUP BY rr.insurer HAVING COUNT(DISTINCT rc.effective_from) >= 2
      ORDER BY rr.insurer`);
    res.json({ success: true, insurers: r.recordset.map((x) => ({
      insurer: x.insurer, generations: x.gens,
      first_effective: iso(x.first_eff), last_effective: iso(x.last_eff) })) });
  } catch (err) { next(err); }
});

// ---- GET /timeline : per-cell changes for an insurer (or all) --------------
router.get('/timeline', async (req, res, next) => {
  try {
    const pool = await getPool();
    const { insurer, product, region, direction, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);

    let insurers;
    if (insurer && insurer !== 'all') insurers = [insurer];
    else {
      const r = await pool.request().query(`
        SELECT rr.insurer FROM rate_rules rr JOIN rate_cards rc ON rr.rate_card_id=rc.id
        WHERE rc.effective_from IS NOT NULL
        GROUP BY rr.insurer HAVING COUNT(DISTINCT rc.effective_from) >= 2`);
      insurers = r.recordset.map((x) => x.insurer);
    }

    let all = [];
    for (const ins of insurers) {
      const { changes } = await diffInsurer(pool, ins, { product, region });
      all = all.concat(changes);
    }
    // filters
    if (from) all = all.filter((c) => c.to_date >= from);
    if (to) all = all.filter((c) => c.to_date <= to);
    if (direction && direction !== 'all') all = all.filter((c) => c.direction === direction);
    // newest change first, then biggest magnitude
    all.sort((a, b) => (b.to_date || '').localeCompare(a.to_date || '') ||
      (Math.abs(b.delta || 0) - Math.abs(a.delta || 0)));

    res.json({ success: true, total: all.length, changes: all.slice(0, limit) });
  } catch (err) { next(err); }
});

// ---- GET /summary : per-insurer (and per-month) up/down counts -------------
router.get('/summary', async (req, res, next) => {
  try {
    const pool = await getPool();
    const { product, from, to } = req.query;
    const r = await pool.request().query(`
      SELECT rr.insurer FROM rate_rules rr JOIN rate_cards rc ON rr.rate_card_id=rc.id
      WHERE rc.effective_from IS NOT NULL
      GROUP BY rr.insurer HAVING COUNT(DISTINCT rc.effective_from) >= 2`);
    const insurers = r.recordset.map((x) => x.insurer);

    const byInsurer = [];
    const byMonth = {};       // month -> {up,down,declined,reinstated}
    for (const ins of insurers) {
      const { changes } = await diffInsurer(pool, ins, { product });
      let up = 0, down = 0, declined = 0, reinstated = 0, sumDelta = 0, nDelta = 0;
      for (const c of changes) {
        if (from && c.to_date < from) continue;
        if (to && c.to_date > to) continue;
        if (c.direction === 'up') up++;
        else if (c.direction === 'down') down++;
        else if (c.direction === 'declined') declined++;
        else if (c.direction === 'reinstated') reinstated++;
        if (c.delta != null) { sumDelta += c.delta; nDelta++; }
        const m = c.to_month;
        if (m) { (byMonth[m] = byMonth[m] || { month: m, up: 0, down: 0, declined: 0, reinstated: 0 });
          if (c.direction === 'up') byMonth[m].up++;
          else if (c.direction === 'down') byMonth[m].down++;
          else if (c.direction === 'declined') byMonth[m].declined++;
          else if (c.direction === 'reinstated') byMonth[m].reinstated++; }
      }
      const total = up + down + declined + reinstated;
      if (total > 0) byInsurer.push({ insurer: ins, up, down, declined, reinstated, total,
        net: up - down, avg_delta: nDelta ? +((sumDelta / nDelta) * 100).toFixed(2) : 0 });
    }
    byInsurer.sort((a, b) => b.total - a.total);
    const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
    res.json({ success: true, by_insurer: byInsurer, by_month: months });
  } catch (err) { next(err); }
});

module.exports = router;
