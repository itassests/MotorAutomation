const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { lookupRates, resolveRTO } = require('../services/rate-lookup');
const { calculatePayout } = require('../services/calculator');

const router = express.Router();

/**
 * POST /lookup
 * Find applicable rate rules based on filters.
 */
router.post('/lookup', async (req, res, next) => {
  try {
    const {
      insurer,
      product,
      sheet_name,
      region,
      segment,
      make,
      vehicle_age,
      fuel_type,
      sub_type,
      addon,
      carrier_type,
      volume_tier,
      seating_capacity,
      rto_code,
      rate_card_id,
      ins_product,
    } = req.body;

    const pool = await getPool();

    // If rto_code is provided, resolve it to a region first
    let resolvedRegion = region;
    if (rto_code && !region) {
      const rtoMapping = await resolveRTO(pool, insurer, product, rto_code);
      if (rtoMapping) {
        resolvedRegion = rtoMapping.region;
      }
    }

    // Default 5,000-row safety cap so the browser can dedupe + render without
    // freezing. `limit=0` opts out (exports, master-excel download).
    const rawLimit = req.body.limit;
    const limit = rawLimit === 0 || rawLimit === '0'
      ? 0
      : (rawLimit != null ? (parseInt(rawLimit, 10) || 5000) : 5000);

    const rulesAll = await lookupRates(pool, {
      insurer,
      product,
      sheet_name,
      region: resolvedRegion,
      segment,
      make,
      vehicle_age: vehicle_age != null ? parseInt(vehicle_age, 10) : null,
      fuel_type,
      sub_type,
      addon,
      carrier_type,
      volume_tier,
      seating_capacity: seating_capacity != null ? parseInt(seating_capacity, 10) : null,
      rate_card_id,
      ins_product,
      limit,
    });

    // CD1 rows are NCB-style discounts, not commission rates — they get used
    // internally by the calculator but are misleading in a "Search Rates" UI
    // that shows Original Rate / Margin / Outgoing. Strip them unless the
    // caller explicitly opts in via include_discounts=true.
    const includeDiscounts = !!req.body.include_discounts;
    const rules = includeDiscounts ? rulesAll : rulesAll.filter(r => {
      const rt = String(r && r.rate_type || '').toUpperCase();
      return rt && !rt.includes('CD1');
    });

    // Attach rto_codes_csv to each rule based on (insurer, product, region) lookups
    // against rto_mappings — so the search / margin-preview cards can show
    // which RTOs hit a given rule. Grouped + cached per-request to avoid a
    // round-trip per rule.
    try {
      const distinctRegions = [...new Set(rules.map(r => r.region).filter(Boolean))];
      if (distinctRegions.length > 0) {
        const rq = pool.request();
        const params = distinctRegions.slice(0, 1000).map((rg, j) => {
          rq.input('rg' + j, sql.NVarChar(200), rg);
          return '@rg' + j;
        });
        const insurerSet = [...new Set(rules.map(r => r.insurer).filter(Boolean))];
        const insParams = insurerSet.slice(0, 50).map((ins, j) => {
          rq.input('ins' + j, sql.VarChar(100), ins);
          return '@ins' + j;
        });
        const insWhere = insParams.length > 0 ? `AND insurer IN (${insParams.join(',')})` : '';
        const rtoR = await rq.query(
          `SELECT insurer, region, rto_code FROM rto_mappings
            WHERE region IN (${params.join(',')}) ${insWhere}`
        );
        // Map (insurer + region) → [rto_codes]
        const byKey = new Map();
        for (const m of rtoR.recordset) {
          const k = (m.insurer || '') + '|' + (m.region || '');
          if (!byKey.has(k)) byKey.set(k, []);
          byKey.get(k).push(m.rto_code);
        }
        for (const r of rules) {
          const codes = byKey.get((r.insurer || '') + '|' + (r.region || '')) || [];
          // Dedupe + sort for stable display.
          const uniq = [...new Set(codes)].sort();
          r.rto_codes = uniq;
          r.rto_codes_csv = uniq.join(', ');
        }
      }
    } catch (e) {
      console.error('[rates/lookup] rto-codes augmentation skipped:', e.message);
    }

    // If the lookup hit the cap, surface a fast count of what the unbounded
    // result would have been so the UI can prompt the user to narrow.
    let truncated = false;
    let totalAvailable = rulesAll.length;
    if (limit > 0 && rulesAll.length === limit) {
      try {
        const probe = pool.request();
        const where = [];
        const addEq = (col, val, type = sql.NVarChar) => {
          if (val != null && val !== '') {
            const k = 'p' + where.length;
            probe.input(k, type, val);
            where.push(`${col} = @${k}`);
          }
        };
        addEq('insurer', insurer, sql.VarChar);
        addEq('product', product, sql.VarChar);
        addEq('sheet_name', sheet_name);
        addEq('region', resolvedRegion);
        addEq('make', make);
        addEq('fuel_type', fuel_type, sql.VarChar);
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const cnt = await probe.query(`SELECT COUNT(*) AS c FROM rate_rules ${whereSql}`);
        totalAvailable = cnt.recordset[0].c;
        truncated = totalAvailable > rulesAll.length;
      } catch (e) {
        // Best-effort — fall back to limit-as-total
        truncated = true;
      }
    }

    res.json({
      success: true,
      resolved_region: resolvedRegion || null,
      rules_count: rules.length,
      rules,
      total_count: rulesAll.length,
      total_available: totalAvailable,
      truncated,
      limit,
      hidden_discount_count: rulesAll.length - rules.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /calculate
 * Calculate payout amounts from matched rules and premium inputs.
 */
router.post('/calculate', async (req, res, next) => {
  try {
    const {
      insurer,
      product,
      sheet_name,
      region,
      segment,
      make,
      vehicle_age,
      fuel_type,
      sub_type,
      addon,
      carrier_type,
      volume_tier,
      seating_capacity,
      rto_code,
      rate_card_id,
      ins_product,
      od_premium,
      tp_premium,
      addon_premium,
      discount_pct,
    } = req.body;

    const pool = await getPool();

    // Resolve RTO if needed
    let resolvedRegion = region;
    if (rto_code && !region) {
      const rtoMapping = await resolveRTO(pool, insurer, product, rto_code);
      if (rtoMapping) {
        resolvedRegion = rtoMapping.region;
      }
    }

    // Lookup matching rules
    const rules = await lookupRates(pool, {
      insurer,
      product,
      sheet_name,
      region: resolvedRegion,
      segment,
      make,
      vehicle_age: vehicle_age != null ? parseInt(vehicle_age, 10) : null,
      fuel_type,
      sub_type,
      addon,
      carrier_type,
      volume_tier,
      seating_capacity: seating_capacity != null ? parseInt(seating_capacity, 10) : null,
      rate_card_id,
      ins_product,
    });

    // Calculate payouts
    const result = calculatePayout(
      rules,
      {
        od_premium: parseFloat(od_premium) || 0,
        tp_premium: parseFloat(tp_premium) || 0,
        addon_premium: parseFloat(addon_premium) || 0,
      },
      {
        vehicle_age: vehicle_age != null ? parseInt(vehicle_age, 10) : null,
        discount_pct: discount_pct != null ? parseFloat(discount_pct) : null,
      }
    );

    res.json({
      success: true,
      resolved_region: resolvedRegion || null,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /resolve-rto/:code
 * Resolve an RTO code to region(s).
 */
router.get('/resolve-rto/:code', async (req, res, next) => {
  try {
    const rtoCode = req.params.code;
    const pool = await getPool();

    const result = await pool
      .request()
      .input('rtoCode', sql.NVarChar, rtoCode)
      .query('SELECT * FROM rto_mappings WHERE rto_code = @rtoCode');

    res.json({
      success: true,
      rto_code: rtoCode,
      mappings: result.recordset,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
