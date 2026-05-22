const sql = require('mssql');

/**
 * Core rate lookup logic. Builds dynamic SQL against rate_rules
 * and attaches conditional_rates where applicable.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {object} params
 * @returns {Promise<Array<object>>}
 */
async function lookupRates(pool, params) {
  const {
    insurer,
    product,
    sheet_name,
    region,
    cluster,
    region_list, // Optional: array of candidate region values (used by cluster fallback).
    region_match_mode, // 'strict' (default) | 'token' (slash-delimited list match)
    segment,
    make,
    vehicle_age,
    fuel_type,
    sub_type,
    addon,
    carrier_type,
    volume_tier,
    seating_capacity,
    rate_card_id,
    ins_product,
  } = params;

  const request = pool.request();
  const conditions = [];
  let paramIndex = 0;

  function addParam(name, value, type) {
    const pName = `p${paramIndex++}`;
    request.input(pName, type || sql.NVarChar, value);
    return pName;
  }

  if (insurer) {
    const p = addParam('insurer', insurer);
    conditions.push(`rr.insurer = @${p}`);
  }
  if (product) {
    if (Array.isArray(product) && product.length > 1) {
      // Match any of a product's aliases (e.g. CAR ↔ 4W ↔ PC for Digit).
      const placeholders = product.map((v, i) => {
        const pName = `pp${i}`;
        request.input(pName, sql.NVarChar, v);
        return `@${pName}`;
      });
      conditions.push(`rr.product IN (${placeholders.join(', ')})`);
    } else {
      const val = Array.isArray(product) ? product[0] : product;
      const p = addParam('product', val);
      conditions.push(`rr.product = @${p}`);
    }
  }
  if (sheet_name) {
    const p = addParam('sheet_name', sheet_name);
    conditions.push(`rr.sheet_name = @${p}`);
  }
  // Region / cluster match.
  //
  // Convention: a rule's rr.region may be either
  //   - a single label  ("DL", "Mumbai", "Good UP"), or
  //   - a slash-delimited list ("Mumbai/GA/Pune/Central MH", "AP/TS")
  //     — Chola stores compound clusters this way.
  //
  // Two match modes:
  //   'strict' (default)  — exact equality only. Used for the primary lookup
  //                         so specific regions like "DL" don't spuriously
  //                         match compound "Delhi/NCR" rows.
  //   'token'             — exact OR token-within-slash-list. Used inside the
  //                         cluster fallback loop where compound rows are the
  //                         whole point.
  //
  // When `region_list` is provided (cluster fallback), it overrides region/cluster.
  const regionMode = region_match_mode === 'token' ? 'token' : 'strict';
  function buildRegionClause(values, namePrefix) {
    const parts = [];
    values.forEach((v, i) => {
      // Coerce + sanitise: mssql's NVarChar validator rejects NULL bytes,
      // non-string types, and certain control characters with "Invalid
      // string" — which silently kills the per-policy pipeline (TATA had
      // this).  Stringify defensively and strip control chars.
      const safe = String(v == null ? '' : v).replace(/[\x00-\x1F]/g, '').trim();
      if (!safe) return;
      const pName = `${namePrefix}${i}`;
      request.input(pName, sql.NVarChar, safe);
      parts.push(`rr.region = @${pName}`);
      if (regionMode === 'token') {
        parts.push(`CHARINDEX('/' + @${pName} + '/', '/' + rr.region + '/') > 0`);
      }
    });
    return parts.length > 0 ? `(${parts.join(' OR ')})` : '1=0';
  }

  if (Array.isArray(region_list) && region_list.length > 0) {
    conditions.push(buildRegionClause(region_list, 'rl'));
  } else {
    // Note: don't use chained `&&` to compute these — `expr && cond` returns
    // the last truthy value, so `cluster && cluster.trim() && cluster.trim() !== wantRegion`
    // collapses to the boolean `true` and we end up pushing `true` (a literal
    // four-character string after binding) into targets. Resolve the value
    // and the predicate separately.
    const wantRegion  = (typeof region === 'string')  ? region.trim()  : '';
    const clusterTrim = (typeof cluster === 'string') ? cluster.trim() : '';
    const wantCluster = clusterTrim && clusterTrim !== wantRegion ? clusterTrim : '';
    const targets = [];
    if (wantRegion)  targets.push(wantRegion);
    if (wantCluster) targets.push(wantCluster);
    if (targets.length > 0) {
      conditions.push(buildRegionClause(targets, 'rt'));
    }
  }
  // Optional attribute columns — rate rules follow a NULL-as-wildcard convention.
  // A rule with blank make/fuel/sub_type/addon/etc. means "applies to any value".
  // So match is:  (rr.col IS NULL OR rr.col = '' OR rr.col = @val)
  if (segment) {
    const p = addParam('segment', `%${segment}%`);
    conditions.push(`(rr.segment IS NULL OR rr.segment = '' OR rr.segment LIKE @${p})`);
  }
  if (make) {
    const p = addParam('make', make);
    // Wildcard make markers — engines that don't have NULL columns sometimes
    // stash "All" / "ALL" / "Any" as the wildcard sentinel.  Treat them as
    // equivalent to NULL so a rule like (segment='GCV 3W', make='All')
    // matches a policy with make='BAJAJ AUTO'.
    conditions.push(`(rr.make IS NULL OR rr.make = '' OR LOWER(rr.make) IN ('all','any','others','other') OR rr.make = @${p})`);
  }
  if (fuel_type) {
    // Normalise policy fuel into the set of equivalent tokens used by
    // various insurers' rate cards. Source data uses "INTERNAL_LPG_CNG" /
    // "EXTERNAL_LPG_CNG" / "PETROL/HYBRID" / "PETROL/CNG" / "BIFUEL" but
    // TATA / Royal / Chola rate cards label fuels as plain "Petrol" /
    // "Diesel" / "CNG" / "Electric" / "Battery" / "Other Than Diesel" /
    // "Others". Also, rules sometimes ship slash-delimited lists like
    // "Petrol / CNG / EV". We match if ANY equivalent token applies.
    const upper = String(fuel_type).toUpperCase();
    const equivalents = new Set([fuel_type]);
    const isCng = /CNG|LPG|BIFUEL/i.test(upper);
    const isPetrol = /PETROL|HYBRID/i.test(upper);
    const isDiesel = /DIESEL/i.test(upper);
    const isElectric = /ELECTRIC|BATTERY|\bEV\b/i.test(upper);
    if (isCng) ['CNG', 'LPG', 'Bifuel', 'Other Than Diesel', 'Others', 'Petrol'].forEach(v => equivalents.add(v));
    if (isPetrol) ['Petrol', 'Other Than Diesel', 'Others'].forEach(v => equivalents.add(v));
    if (isDiesel) ['Diesel'].forEach(v => equivalents.add(v));
    if (isElectric) ['Electric', 'Battery', 'EV', 'Other Than Diesel', 'Others'].forEach(v => equivalents.add(v));

    const fuelClauses = [];
    let i = 0;
    for (const eq of equivalents) {
      if (eq == null || eq === '') continue;
      const pName = `ft${i++}`;
      request.input(pName, sql.NVarChar, eq);
      // Match against rule.fuel_type — exact OR token-in-slash-list.
      fuelClauses.push(`rr.fuel_type = @${pName}`);
      fuelClauses.push(`CHARINDEX('/' + @${pName} + '/', '/' + REPLACE(rr.fuel_type, ' ', '') + '/') > 0`);
    }
    conditions.push(
      `(rr.fuel_type IS NULL OR rr.fuel_type = ''` +
      (fuelClauses.length ? ` OR ${fuelClauses.join(' OR ')}` : '') +
      `)`
    );
  }
  if (sub_type) {
    const p = addParam('sub_type', sub_type);
    conditions.push(`(rr.sub_type IS NULL OR rr.sub_type = '' OR rr.sub_type = @${p})`);
  }
  if (addon) {
    const p = addParam('addon', addon);
    conditions.push(`(rr.addon IS NULL OR rr.addon = '' OR rr.addon = @${p})`);
  }
  if (carrier_type) {
    const p = addParam('carrier_type', carrier_type);
    conditions.push(`(rr.carrier_type IS NULL OR rr.carrier_type = '' OR rr.carrier_type = @${p})`);
  }
  if (volume_tier) {
    const p = addParam('volume_tier', volume_tier);
    conditions.push(`(rr.volume_tier IS NULL OR rr.volume_tier = '' OR rr.volume_tier = @${p})`);
  }
  if (rate_card_id) {
    const p = addParam('rate_card_id', rate_card_id, sql.Int);
    conditions.push(`rr.rate_card_id = @${p}`);
  }
  if (vehicle_age != null) {
    const p = addParam('vehicle_age', vehicle_age, sql.Int);
    conditions.push(
      `(rr.vehicle_age_min IS NULL OR rr.vehicle_age_min <= @${p})` +
      ` AND (rr.vehicle_age_max IS NULL OR rr.vehicle_age_max >= @${p})`
    );
  }
  if (seating_capacity != null) {
    const p = addParam('seating_capacity', seating_capacity, sql.Int);
    conditions.push(
      `(rr.seating_capacity_min IS NULL OR rr.seating_capacity_min <= @${p})` +
      ` AND (rr.seating_capacity_max IS NULL OR rr.seating_capacity_max >= @${p})`
    );
  }

  if (ins_product) {
    // Map insurance product to rate_type LIKE patterns.
    // Patterns use % wildcards — rate_types frequently carry make suffixes
    // (e.g. CD2_Kia, 1+3_CD2_Hyundai) and tenure prefixes (1+3_CD2, 3+3_CD2).
    // Keeping these broad is intentional: the policy route OR-matches candidates
    // and the calculator picks the right one by rate_type category.
    const productMap = {
      // Comp includes the bundled "PACK" / "Package" convention (Chola MISC &
      // others use PACK as the Comp rate_type).
      // Chola TW Comp rates carry no Comp/CD2/PACK keyword — they're stored
      // as "NEW(UPTO 30 NOP)" / "NEW(30-100 NOP)" / "NEW(100-500 NOP)"
      // (agent-volume bands) and a flat "ANNUAL". Without these patterns the
      // Comp lookup misses every petrol TW rule. NOP-band selection (which of
      // the three NEW(...) tiers applies for a given agent) isn't implemented
      // yet — picker just takes the first survivor for now.
      // TATA AIG rate types are pipe-delimited "DM|Package|NCB:NCB",
      // "HOM|Package|NCB:Non NCB", "Package_OD", "Package_OD|NCB:Yes" —
      // "Package" is TATA's Comp keyword. Adding %Package% / Package_OD
      // patterns lets these surface for Comp policies.
      'Comp':      ['Comp%', '%CD1%', '%CD2%', 'MAX_CD2%', 'COMP_%', 'COMP\\_%',
                    '1+3_CD2%', '3+3_CD2%', '1+5_CD2%', '5+5_CD2%',
                    'PACK', 'PACK%', 'HEV',
                    'NEW(%', 'ANNUAL%',
                    '%Package%', '%PACKAGE%', 'Package\\_%',
                    // ICICI Lombard universal rate_type — applies to Comp/SAOD/TP alike.
                    // PCV/MISC sheets ship a single ALL_Net column instead of split
                    // Comp/TP rates, so it must surface for all three product groups.
                    'ALL_Net', 'ALL_%'],
      // SAOD = Standalone Own Damage. We try SAOD-only patterns first.
      // The bulk pipeline does a 2nd pass with COMP patterns when this
      // returns 0 — covering insurers (Digit) that don't ship a dedicated
      // SAOD rate_type and instead use Comp's 1+1_MAX_CD2 as the OD-only
      // equivalent.  Keep this list narrow so the first pass is precise.
      // TATA stores SAOD rates as "DM|SAOD|NCB:NCB", "HOM|SAOD|NCB:Non NCB",
      // "SAOD_OD", "SAOD_OD|NCB:Yes". %SAOD% catches the pipe-delimited
      // variants without false-positives on Comp/TP rate types.
      'SAOD':      ['SAOD%', 'SAOD\\_%', 'FLEXI%', 'SOD%', '%MIN_CD1%', '%MAX_CD1%',
                    '%SAOD%',
                    // ICICI universal — see Comp note above.
                    'ALL_Net', 'ALL_%'],
      // TP policies: SATP-prefixed rates (Pvt Car convention) + generic rate
      // types used by commercial rate cards (MAX_CD2, CD1, On Contract, ACT)
      // where rate_type is product-agnostic. The post-filter drops any
      // explicitly COMP-prefixed (or PACK) rules so TP policies never get Comp rates.
      // TATA TP rates are "DM|SATP", "HOM|SATP", "SATP_TP", and "DM|NA"
      // (no-addon TP base). %SATP% / SATP_% catches pipe-delimited variants;
      // "DM|NA"/"HOM|NA" are TATA's TP fallback rate-types.
      'TP':        ['SATP%', 'CD1', 'CD2', 'MAX_CD2', 'MAX\\_CD2[_]%', 'MAX_CD1%',
                    'ACT', 'ACT%', 'TP%', 'On Contract%', '1+1_MAX_CD2%',
                    '%SATP%', 'SATP\\_%', '%|NA', 'DM|NA', 'HOM|NA',
                    // ICICI universal — see Comp note above.
                    'ALL_Net', 'ALL_%'],
      '1+1':       ['1+1%'],
      'Non Motor': ['ALL_EXCEPT%', 'IAR%', 'ANNUAL%', 'NEW%', 'On Contract%'],
    };
    const patterns = productMap[ins_product];
    if (patterns) {
      const orClauses = patterns.map((pat, i) => {
        const pName = `pip${i}`;
        request.input(pName, sql.NVarChar, pat);
        return `rr.rate_type LIKE @${pName}`;
      });
      conditions.push(`(${orClauses.join(' OR ')})`);
    }
  }

  // Optional cap: callers that talk to the browser (Search Rates UI) pass a
  // positive `limit` so a 265k-row response can't freeze the client. Bulk /
  // policy / calculator paths leave it unset and get the full result set.
  const limit = Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : 0;
  const topClause = limit > 0 ? `TOP ${limit} ` : '';

  let query = `SELECT ${topClause}rr.* FROM rate_rules rr`;
  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  // Order by specificity: prefer rules with more non-null fields
  query += `
    ORDER BY
      CASE WHEN rr.region IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN rr.segment IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN rr.make IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN rr.fuel_type IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN rr.sub_type IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN rr.vehicle_age_min IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN rr.addon IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN rr.volume_tier IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN rr.seating_capacity_min IS NOT NULL THEN 1 ELSE 0 END
    DESC`;

  const result = await request.query(query);
  const rules = result.recordset;

  // Attach conditional_rates for conditional rules
  const conditionalRuleIds = rules
    .filter((r) => r.is_conditional)
    .map((r) => r.id);

  if (conditionalRuleIds.length > 0) {
    const crResult = await pool
      .request()
      .query(
        `SELECT * FROM conditional_rates WHERE rate_rule_id IN (${conditionalRuleIds.join(',')})`
      );

    const crMap = {};
    for (const cr of crResult.recordset) {
      if (!crMap[cr.rate_rule_id]) crMap[cr.rate_rule_id] = [];
      crMap[cr.rate_rule_id].push(cr);
    }

    for (const rule of rules) {
      if (rule.is_conditional) {
        rule.conditional_rates = crMap[rule.id] || [];
      }
    }
  }

  return rules;
}

/**
 * Resolve an RTO code to a region via the rto_mappings table.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} insurer
 * @param {string} product
 * @param {string} rtoCode
 * @returns {Promise<object|null>}
 */
async function resolveRTO(pool, insurer, product, rtoCode) {
  // Get all RTO mappings for this insurer + rto_code
  const result = await pool.request()
    .input('insurer', sql.NVarChar, insurer)
    .input('rtoCode', sql.NVarChar, rtoCode)
    .query(
      `SELECT * FROM rto_mappings
       WHERE insurer = @insurer AND rto_code = @rtoCode`
    );

  if (result.recordset.length === 0) return null;
  if (!product) return result.recordset[0];

  // Map vehicle types to config-level product names for matching
  // e.g. GCV/PCV -> CV, CAR -> 4W, TW/TW_EV -> TW
  const productAliases = {
    'GCV': ['CV', 'GCV', 'GCCV'],
    'PCV': ['CV', 'PCV', 'TAXI', 'SCHOOL_STAFF_BUS'],
    'CAR': ['4W', 'CAR', 'PC'],
    'TW': ['TW', '2W', 'TW_EV'],
    'TW_EV': ['TW', 'TW_EV', '2W'],
    'MISC': ['CV', 'MISC'],
    'NON_MOTOR': ['NON_MOTOR'],
  };
  const aliases = productAliases[product] || [product];

  // Try exact product match first
  const exact = result.recordset.find(r => r.product === product);
  if (exact) return exact;

  // Try alias match
  const aliasMatch = result.recordset.find(r => aliases.includes(r.product));
  if (aliasMatch) return aliasMatch;

  // Fallback: return first available
  return result.recordset[0];
}

module.exports = { lookupRates, resolveRTO };
