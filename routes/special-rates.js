/**
 * Special Rates — agent-specific margin overrides on top of margin_rules.
 *
 * Default outgoing rate to an agent = Income − DefaultMargin (from margin_rules).
 * A "special rate" lets us replace DefaultMargin for one agent (UPIN code) on
 * a specific filter scope. Two flavours:
 *   1) Flat override     — override_margin_pct set, volume_tiers_json NULL
 *   2) Volume-tier rule  — volume_tiers_json set, override_margin_pct NULL.
 *      Tier shape:  [{ premium_min, premium_max, override_margin_pct }, …]
 *      Window:      window_type ∈ ('month','cycle','date_range')
 *
 * Endpoints
 *   GET    /api/special-rates                                   → all (paged)
 *   GET    /api/special-rates?upincode=X                        → for one agent
 *   GET    /api/special-rates/preview?upincode=X[&filters…]     → all rule
 *                                                                 scopes that
 *                                                                 currently have
 *                                                                 a default
 *                                                                 margin, with
 *                                                                 income / default
 *                                                                 margin / current
 *                                                                 outgoing for
 *                                                                 that agent
 *   POST   /api/special-rates                                   → create / update
 *   DELETE /api/special-rates/:id                               → soft-delete
 */

const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { getBeeinsuredPool } = require('../db/beeinsured-connection');
const { marginCoversRateRule } = require('./margins');

const router = express.Router();

/** Same signature shape as margin_rules so a special rate can target the
 *  identical filter scope as a margin. */
function signatureOf(filters) {
  if (!filters || typeof filters !== 'object') return '';
  const clean = {};
  for (const k of Object.keys(filters).sort()) {
    const v = filters[k];
    if (v === null || v === undefined || v === '') continue;
    clean[k] = typeof v === 'string' ? v.toLowerCase().trim() : v;
  }
  return JSON.stringify(clean);
}

/** Validate a tiers array. Returns { ok, error?, normalised? }. Each tier
 *  must carry a numeric override_margin_pct and at least one of
 *  premium_min / premium_max (else it's an unbounded "always" tier).
 *  Sorted ascending by premium_min so the calc lookup is deterministic. */
function validateTiers(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'tiers must be a non-empty array' };
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] || {};
    if (t.override_margin_pct == null || isNaN(Number(t.override_margin_pct))) {
      return { ok: false, error: `tier ${i + 1}: override_margin_pct required (number)` };
    }
    const pmin = t.premium_min != null && t.premium_min !== '' ? Number(t.premium_min) : null;
    const pmax = t.premium_max != null && t.premium_max !== '' ? Number(t.premium_max) : null;
    if (pmin != null && isNaN(pmin)) return { ok: false, error: `tier ${i + 1}: premium_min not a number` };
    if (pmax != null && isNaN(pmax)) return { ok: false, error: `tier ${i + 1}: premium_max not a number` };
    if (pmin != null && pmax != null && pmin > pmax) {
      return { ok: false, error: `tier ${i + 1}: premium_min > premium_max` };
    }
    out.push({ premium_min: pmin, premium_max: pmax, override_margin_pct: Number(t.override_margin_pct) });
  }
  out.sort((a, b) => (a.premium_min ?? -Infinity) - (b.premium_min ?? -Infinity));
  return { ok: true, normalised: out };
}

/** Normalize a window descriptor. Returns { ok, type, from?, to?, error? }.
 *  type ∈ ('month','cycle','date_range'). For 'cycle' the active cycle's
 *  dates are resolved at calc time, not stored. */
function normaliseWindow(win) {
  if (!win || !win.type) return { ok: true, type: null };
  const t = String(win.type).toLowerCase();
  if (!['month', 'cycle', 'date_range'].includes(t)) {
    return { ok: false, error: `window.type must be one of month|cycle|date_range` };
  }
  if (t === 'date_range') {
    const from = win.from ? new Date(win.from) : null;
    const to   = win.to   ? new Date(win.to)   : null;
    if (!from || isNaN(from)) return { ok: false, error: 'window.from required when type=date_range' };
    if (!to   || isNaN(to))   return { ok: false, error: 'window.to required when type=date_range' };
    if (from > to) return { ok: false, error: 'window.from must be <= window.to' };
    return { ok: true, type: t, from, to };
  }
  return { ok: true, type: t };
}

/** ─── Agent-level global uplift ────────────────────────────────────────
 *  A single uplift % per agent that reduces the default margin across
 *  EVERY scope (composes with per-row overrides — specific override
 *  wins, otherwise default - uplift). Stored in agent_global_uplifts.
 */

/** GET /api/special-rates/global?upincode=X
 *    Returns { upincode, uplift_pct, note, ... } or { upincode, uplift_pct: null }
 *    when nothing is saved yet.
 *  GET /api/special-rates/global  (no params)
 *    Returns the full list of agents with a global uplift.
 */
router.get('/global', async (req, res, next) => {
  try {
    const upin = String(req.query.upincode || '').trim();
    const pool = await getPool();
    if (upin) {
      const r = await pool.request()
        .input('upin', sql.NVarChar(50), upin)
        .query(`SELECT TOP 1 id, upincode, pos_name, uplift_pct, note,
                              created_at, updated_at
                FROM agent_global_uplifts
                WHERE active = 1 AND upincode = @upin`);
      if (r.recordset.length === 0) {
        return res.json({ success: true, upincode: upin, uplift_pct: null });
      }
      const row = r.recordset[0];
      return res.json({ success: true, ...row, uplift_pct: Number(row.uplift_pct) });
    }
    const r = await pool.request().query(`
      SELECT id, upincode, pos_name, uplift_pct, note, updated_at
      FROM agent_global_uplifts WHERE active = 1
      ORDER BY updated_at DESC`);
    res.json({
      success: true,
      uplifts: r.recordset.map(x => ({ ...x, uplift_pct: Number(x.uplift_pct) })),
    });
  } catch (err) { next(err); }
});

/** POST /api/special-rates/global
 *    body: { upincode, uplift_pct, pos_name?, note? }
 *  Upserts the per-agent global uplift. uplift_pct may be 0 to clear the
 *  effect without deleting the row; use DELETE to remove it entirely. */
router.post('/global', async (req, res, next) => {
  try {
    const { upincode, uplift_pct, pos_name, note } = req.body || {};
    if (!upincode) return res.status(400).json({ success: false, error: 'upincode required' });
    if (uplift_pct == null || isNaN(Number(uplift_pct))) {
      return res.status(400).json({ success: false, error: 'uplift_pct required (number)' });
    }
    const pool = await getPool();
    const existing = await pool.request()
      .input('upin', sql.NVarChar(50), upincode.trim())
      .query(`SELECT TOP 1 id FROM agent_global_uplifts
              WHERE active = 1 AND upincode = @upin`);
    if (existing.recordset.length > 0) {
      const id = existing.recordset[0].id;
      await pool.request()
        .input('id', sql.Int, id)
        .input('pos', sql.NVarChar(200), pos_name || null)
        .input('uplift', sql.Decimal(6, 3), Number(uplift_pct))
        .input('note', sql.NVarChar(500), note || null)
        .query(`UPDATE agent_global_uplifts
                SET pos_name = @pos, uplift_pct = @uplift, note = @note,
                    updated_at = GETDATE()
                WHERE id = @id`);
      return res.json({ success: true, id, action: 'updated' });
    }
    const ins = await pool.request()
      .input('upin', sql.NVarChar(50), upincode.trim())
      .input('pos', sql.NVarChar(200), pos_name || null)
      .input('uplift', sql.Decimal(6, 3), Number(uplift_pct))
      .input('note', sql.NVarChar(500), note || null)
      .query(`INSERT INTO agent_global_uplifts (upincode, pos_name, uplift_pct, note)
              OUTPUT INSERTED.id
              VALUES (@upin, @pos, @uplift, @note)`);
    res.json({ success: true, id: ins.recordset[0].id, action: 'created' });
  } catch (err) { next(err); }
});

/** DELETE /api/special-rates/global/:upincode — soft-delete the uplift row. */
router.delete('/global/:upincode', async (req, res, next) => {
  try {
    const upin = String(req.params.upincode || '').trim();
    if (!upin) return res.status(400).json({ success: false, error: 'upincode required' });
    const pool = await getPool();
    await pool.request()
      .input('upin', sql.NVarChar(50), upin)
      .query(`UPDATE agent_global_uplifts SET active = 0, updated_at = GETDATE()
              WHERE upincode = @upin AND active = 1`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** GET /api/special-rates                — all active rules
 *  GET /api/special-rates?upincode=ABC   — only that agent
 */
router.get('/', async (req, res, next) => {
  try {
    const upin = String(req.query.upincode || '').trim();
    const pool = await getPool();
    const rq = pool.request();
    let where = 'WHERE active = 1';
    if (upin) { rq.input('upin', sql.NVarChar(50), upin); where += ' AND upincode = @upin'; }
    const r = await rq.query(`
      SELECT id, upincode, pos_name, description, filters_json,
             override_margin_pct, volume_tiers_json,
             window_type, window_from, window_to,
             created_at, updated_at, created_by
      FROM special_rate_rules ${where}
      ORDER BY upincode, updated_at DESC`);
    const rules = r.recordset.map(row => ({
      ...row,
      filters: (() => { try { return JSON.parse(row.filters_json); } catch { return null; } })(),
      volume_tiers: row.volume_tiers_json
        ? (() => { try { return JSON.parse(row.volume_tiers_json); } catch { return null; } })()
        : null,
    }));
    res.json({ success: true, rules });
  } catch (err) { next(err); }
});

/** POST / — create or update (overwrite when same agent+signature already exists). */
router.post('/', async (req, res, next) => {
  try {
    const {
      upincode, pos_name, description, filters,
      override_margin_pct, volume_tiers, window,
      force,
    } = req.body || {};

    if (!upincode || typeof upincode !== 'string') {
      return res.status(400).json({ success: false, error: 'upincode required' });
    }
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ success: false, error: 'description required' });
    }
    const sig = signatureOf(filters);
    if (!sig) return res.status(400).json({ success: false, error: 'filters must be a non-empty object' });

    // Exactly one of override_margin_pct vs volume_tiers must be set.
    const hasFlat   = override_margin_pct != null && override_margin_pct !== '';
    const hasTiers  = Array.isArray(volume_tiers) && volume_tiers.length > 0;
    if (hasFlat === hasTiers) {
      return res.status(400).json({
        success: false,
        error: 'Provide exactly one of override_margin_pct OR volume_tiers (not both, not neither)',
      });
    }

    let normalisedTiers = null;
    let win = { ok: true, type: null };
    if (hasTiers) {
      const v = validateTiers(volume_tiers);
      if (!v.ok) return res.status(400).json({ success: false, error: v.error });
      normalisedTiers = v.normalised;
      win = normaliseWindow(window || { type: 'month' });
      if (!win.ok) return res.status(400).json({ success: false, error: win.error });
      if (!win.type) return res.status(400).json({ success: false, error: 'window.type required for volume tiers' });
    } else if (isNaN(Number(override_margin_pct))) {
      return res.status(400).json({ success: false, error: 'override_margin_pct must be numeric' });
    }

    const pool = await getPool();
    const existing = await pool.request()
      .input('upin', sql.NVarChar(50), upincode.trim())
      .input('sig',  sql.NVarChar(500), sig)
      .query(`SELECT TOP 1 id FROM special_rate_rules
              WHERE upincode = @upin AND filter_signature = @sig AND active = 1`);

    if (existing.recordset.length > 0 && !force) {
      return res.status(409).json({
        success: false, exists: true,
        existing_id: existing.recordset[0].id,
        error: 'A special rate for this agent + scope already exists. Send {force:true} to overwrite.',
      });
    }

    const params = (rq) => rq
      .input('upin',    sql.NVarChar(50),  upincode.trim())
      .input('pos',     sql.NVarChar(200), pos_name || null)
      .input('desc',    sql.NVarChar(500), description.slice(0, 500))
      .input('filters', sql.NVarChar(sql.MAX), JSON.stringify(filters))
      .input('sig',     sql.NVarChar(500), sig)
      .input('flat',    sql.Decimal(6, 3), hasFlat ? Number(override_margin_pct) : null)
      .input('tiers',   sql.NVarChar(sql.MAX), normalisedTiers ? JSON.stringify(normalisedTiers) : null)
      .input('wtype',   sql.VarChar(20), win.type || null)
      .input('wfrom',   sql.Date, win.from || null)
      .input('wto',     sql.Date, win.to   || null);

    if (existing.recordset.length > 0 && force) {
      const id = existing.recordset[0].id;
      await params(pool.request().input('id', sql.Int, id))
        .query(`UPDATE special_rate_rules
                SET pos_name = @pos, description = @desc,
                    filters_json = @filters,
                    override_margin_pct = @flat,
                    volume_tiers_json = @tiers,
                    window_type = @wtype, window_from = @wfrom, window_to = @wto,
                    updated_at = GETDATE()
                WHERE id = @id`);
      return res.json({ success: true, id, action: 'updated' });
    }

    const ins = await params(pool.request())
      .query(`INSERT INTO special_rate_rules
                (upincode, pos_name, description, filters_json, filter_signature,
                 override_margin_pct, volume_tiers_json,
                 window_type, window_from, window_to)
              OUTPUT INSERTED.id
              VALUES (@upin, @pos, @desc, @filters, @sig,
                      @flat, @tiers, @wtype, @wfrom, @wto)`);
    res.json({ success: true, id: ins.recordset[0].id, action: 'created' });
  } catch (err) { next(err); }
});

/** DELETE /:id — soft delete */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'invalid id' });
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query(`UPDATE special_rate_rules SET active = 0, updated_at = GETDATE() WHERE id = @id`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** GET /preview?upincode=X
 *  Returns the working set for the Special Rates UI:
 *    every margin_rules row that exists, joined to a typical income (taken
 *    from the matching rate_rules group max), and to any existing special
 *    rate for that agent at the same signature.
 *
 *  Shape:
 *    [{
 *       margin_rule_id, filters, description,
 *       income_pct,                 // representative income from rate_rules
 *       default_margin_pct,         // from margin_rules
 *       current_outgoing_pct,       // income - (special override if any) or income - default
 *       special_rate_id,            // nullable
 *       override_margin_pct,        // nullable (flat)
 *       volume_tiers,               // nullable (array)
 *       window_type, window_from, window_to
 *     }]
 *
 *  This is intentionally a SINGLE round-trip per agent so the UI can render
 *  hundreds of rows without N+1 queries. The income lookup uses MAX(rate_value)
 *  across rate_rules whose product+insurer match the margin's filter; for
 *  more precise income display the UI can defer to a per-row "Search Rates"
 *  click.
 */
router.get('/preview', async (req, res, next) => {
  try {
    const upin = String(req.query.upincode || '').trim();
    if (!upin) return res.status(400).json({ success: false, error: 'upincode required' });

    const pool = await getPool();

    // 1) All active margins.
    const mr = await pool.request().query(`
      SELECT id, description, filters_json, margin_pct
      FROM margin_rules WHERE active = 1`);
    const margins = mr.recordset.map(row => ({
      id: row.id,
      description: row.description,
      filters: (() => { try { return JSON.parse(row.filters_json); } catch { return null; } })(),
      filter_signature: null,
      default_margin_pct: Number(row.margin_pct),
    }));
    // Recompute signature from parsed filters so we can join on it.
    for (const m of margins) m.filter_signature = signatureOf(m.filters || {});

    // 1b) Per-agent global uplift (if any) — applied as a fallback uplift
    //     on every row that doesn't have a more-specific override.
    const ug = await pool.request()
      .input('upin', sql.NVarChar(50), upin)
      .query(`SELECT TOP 1 uplift_pct FROM agent_global_uplifts
              WHERE active = 1 AND upincode = @upin`);
    const globalUplift = ug.recordset.length > 0 ? Number(ug.recordset[0].uplift_pct) : 0;

    // 2) Existing special rates for this agent → map by signature.
    const sr = await pool.request()
      .input('upin', sql.NVarChar(50), upin)
      .query(`SELECT id, filter_signature, override_margin_pct, volume_tiers_json,
                     window_type, window_from, window_to
              FROM special_rate_rules WHERE active = 1 AND upincode = @upin`);
    const specialBySig = new Map();
    for (const r of sr.recordset) {
      specialBySig.set(r.filter_signature, {
        id: r.id,
        override_margin_pct: r.override_margin_pct == null ? null : Number(r.override_margin_pct),
        volume_tiers: r.volume_tiers_json
          ? (() => { try { return JSON.parse(r.volume_tiers_json); } catch { return null; } })()
          : null,
        window_type: r.window_type,
        window_from: r.window_from,
        window_to:   r.window_to,
      });
    }

    // 3) Representative income per insurer + product. We use a single
    //    aggregate query so this stays one round-trip.
    //    rate_value is mixed-format in the DB — some rows store fractions
    //    (0.05 = 5%) and some store percent (5 = 5%). Normalise to % so the
    //    display is consistent with how Bulk Calculation reports it.
    const rrAgg = await pool.request().query(`
      SELECT insurer, product, MAX(rate_value) AS max_rate, AVG(rate_value) AS avg_rate
      FROM rate_rules
      WHERE rate_value IS NOT NULL
      GROUP BY insurer, product`);
    const _toPct = (v) => {
      const n = Number(v);
      if (!isFinite(n)) return 0;
      return n <= 1 ? n * 100 : n;
    };
    const incomeByKey = new Map();
    for (const r of rrAgg.recordset) {
      const k = `${(r.insurer || '').toLowerCase()}|${(r.product || '').toUpperCase()}`;
      incomeByKey.set(k, { max: _toPct(r.max_rate), avg: _toPct(r.avg_rate) });
    }

    // 4) Build preview rows.
    const rows = margins.map(m => {
      const f = m.filters || {};
      const ins = (f.searchInsurer || '').toLowerCase();
      const prods = Array.isArray(f.searchProduct) ? f.searchProduct : (f.searchProduct ? [f.searchProduct] : []);
      let bestMax = 0;
      for (const p of prods) {
        const k = `${ins}|${String(p).toUpperCase()}`;
        const v = incomeByKey.get(k);
        if (v && v.max > bestMax) bestMax = v.max;
      }
      const income_pct = bestMax || null;
      const sp = specialBySig.get(m.filter_signature) || null;
      // Effective-margin precedence (lowest wins):
      //   per-row override (flat)  > default - global uplift  > default
      let effective_margin = m.default_margin_pct;
      let uplift_applied = false;
      if (sp && sp.override_margin_pct != null) {
        effective_margin = sp.override_margin_pct;
      } else if (globalUplift > 0) {
        effective_margin = m.default_margin_pct - globalUplift;
        uplift_applied = true;
      }
      const current_outgoing_pct = income_pct == null ? null : (income_pct - effective_margin);

      return {
        margin_rule_id: m.id,
        filters: f,
        description: m.description,
        income_pct,
        default_margin_pct: m.default_margin_pct,
        current_outgoing_pct,
        global_uplift_applied: uplift_applied,
        special_rate_id:     sp ? sp.id : null,
        override_margin_pct: sp ? sp.override_margin_pct : null,
        volume_tiers:        sp ? sp.volume_tiers : null,
        window_type:         sp ? sp.window_type : null,
        window_from:         sp ? sp.window_from : null,
        window_to:           sp ? sp.window_to   : null,
      };
    });

    res.json({ success: true, count: rows.length, global_uplift_pct: globalUplift, rows });
  } catch (err) { next(err); }
});

/** Resolve the effective margin for an agent against a rate_rule.
 *  Pure helper used by the calc path (e.g. excel-export, bulk).
 *
 *    pickEffectiveMargin({ rule, defaultMargin, specialRules, agentPremium })
 *
 *  - rule:           a rate_rules row (insurer/product/region/etc.)
 *  - defaultMargin:  the default margin % from margin_rules that covers `rule`
 *                    (or 0 if none).
 *  - specialRules:   array of { filters, override_margin_pct, volume_tiers, ... }
 *                    pre-loaded for this one agent.
 *  - agentPremium:   premium booked for the agent in the relevant window
 *                    (the caller resolves the window — month/cycle/date_range).
 *
 *  Returns the % that should be subtracted from income for THIS agent on THIS
 *  rule. Picks the most-favourable-to-agent (lowest) margin when multiple
 *  special rules cover the rule.
 */
function pickEffectiveMargin({ rule, defaultMargin, specialRules, agentPremium }) {
  const candidates = [Number(defaultMargin) || 0];
  for (const s of specialRules || []) {
    if (!marginCoversRateRule(s.filters || {}, rule)) continue;
    if (s.override_margin_pct != null) {
      candidates.push(Number(s.override_margin_pct));
      continue;
    }
    if (Array.isArray(s.volume_tiers) && s.volume_tiers.length > 0 && agentPremium != null) {
      // Pick first tier whose [premium_min..premium_max] contains agentPremium.
      // Tiers were sorted ascending on insert.
      for (const t of s.volume_tiers) {
        const pmin = t.premium_min == null ? -Infinity : Number(t.premium_min);
        const pmax = t.premium_max == null ?  Infinity : Number(t.premium_max);
        if (agentPremium >= pmin && agentPremium <= pmax) {
          candidates.push(Number(t.override_margin_pct));
          break;
        }
      }
    }
  }
  return Math.min(...candidates);
}

module.exports = router;
module.exports.pickEffectiveMargin = pickEffectiveMargin;
