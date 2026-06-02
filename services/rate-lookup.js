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
    include_null_region, // Optional: when true, also match rules with NULL/'' region
                         // (national / "PAN INDIA" rows). Used by state-keyed insurers
                         // (e.g. Shriram) so a state-constrained lookup still surfaces
                         // the national rules that would otherwise only appear in an
                         // unfiltered (all-region) query.
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
  // Skip "info" rules that carry no numeric rate (e.g. Bajaj's "Doable" /
  // "Refer UW" cells stored as rate_value=NULL). They aren't usable for
  // commission calculation and only displace real-rate rules in the lookup.
  //
  // Exception: keep rate=NULL rows whose `rate_text` carries an age-banded
  // table (e.g. Digit's "Age 0-5: 7.5%\nAge>=6: 29%") OR whose `remarks`
  // encode an IRDA-default rate (e.g. SBI's "Premium below ₹1L — IRDA
  // default applied (SATP 2.5%)"). The bulk pipeline's null-rate
  // recovery block parses these at lookup time and substitutes the
  // applicable rate.
  //
  // is_conditional is a boolean column populated by the parsers for any
  // age-banded / multi-rate cell — using it avoids the `LIKE '%...%'`
  // full-text scans that the previous version triggered on every lookup
  // (full table scans on rate_text/remarks would tank query latency).
  const conditions = [
    `(rr.rate_value IS NOT NULL OR rr.is_conditional = 1)`,
  ];
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
  const regionMode = region_match_mode === 'token' ? 'token'
                   : region_match_mode === 'contains' ? 'contains'
                   : 'strict';
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
      // Separator-insensitive equality. Digit is internally inconsistent about
      // how it spells the same cluster across sheets — the CV RTO mapping
      // resolves "Delhi NCR" (space) while the Taxi grid stores "DELHI-NCR"
      // (hyphen), and exact equality misses the cross-sheet match (zero Taxi
      // candidates → No-Rule). Compare both sides with spaces / hyphens /
      // underscores stripped so "Delhi NCR" ≡ "DELHI-NCR" ≡ "DELHI_NCR".
      // Collation is case-insensitive, so no UPPER() is needed. Skip when the
      // normalised form is empty or identical to the raw value (no separators).
      const normVal = safe.replace(/[\s\-_]/g, '');
      if (normVal && normVal !== safe) {
        const nName = `${namePrefix}n${i}`;
        request.input(nName, sql.NVarChar, normVal);
        parts.push(`REPLACE(REPLACE(REPLACE(rr.region, ' ', ''), '-', ''), '_', '') = @${nName}`);
      }
      if (regionMode === 'token') {
        parts.push(`CHARINDEX('/' + @${pName} + '/', '/' + rr.region + '/') > 0`);
      }
      // 'contains' mode: the search token is a distinctive SUBSTRING of a verbose
      // card label (Shriram stores "GUJARAT & DADRA NAGAR HAVELI & DAMAN & DIU",
      // "TAMILNADU & PONDICHERRY", "PUNJAB/CHANDIGARH"). Match when the token
      // appears anywhere inside rr.region. Collation is case-insensitive.
      if (regionMode === 'contains') {
        parts.push(`rr.region LIKE '%' + @${pName} + '%'`);
      }
    });
    // National / "PAN INDIA" rows are stored with a NULL/'' region. When the
    // caller opts in, OR them into the clause so a state-constrained lookup
    // (e.g. region = 'MAHARASHTRA') still surfaces the national rules.
    if (include_null_region) {
      parts.push(`rr.region IS NULL OR rr.region = ''`);
    }
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
// Build the set of equivalent RTO-code spellings for a raw code. The mapping
// table is inconsistent about zero-padding the numeric district portion
// (e.g. it stores "DL09" while a tracker may carry "DL9"), so we generate both
// the padded and unpadded forms plus the original and match on any of them.
function rtoCodeVariants(rtoCode) {
  const raw = String(rtoCode || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return [];
  const set = new Set([raw]);
  // State letters + numeric district + optional suffix letters (e.g. "DL7C").
  const m = raw.match(/^([A-Z]{2})0*(\d+)([A-Z]*)$/);
  if (m) {
    const [, st, num, suf] = m;
    const n = String(parseInt(num, 10));
    set.add(`${st}${n}${suf}`);                       // unpadded: DL9
    set.add(`${st}${n.padStart(2, '0')}${suf}`);      // 2-padded: DL09
  }
  return [...set];
}

async function resolveRTO(pool, insurer, product, rtoCode) {
  // Get all RTO mappings for this insurer + rto_code (matching any spelling
  // variant — see rtoCodeVariants for the padding-normalisation rationale).
  const variants = rtoCodeVariants(rtoCode);
  if (variants.length === 0) return null;
  const req = pool.request().input('insurer', sql.NVarChar, insurer);
  const params = variants.map((v, i) => {
    req.input(`rto${i}`, sql.NVarChar, v);
    return `@rto${i}`;
  });
  const result = await req.query(
    `SELECT * FROM rto_mappings
     WHERE insurer = @insurer AND rto_code IN (${params.join(', ')})
     ORDER BY rate_card_id DESC`
  );

  // Prefer the most recent rate-card generation. RTO masters accumulate
  // across re-uploads (old cards aren't purged), and an older generation can
  // carry a stale cluster (e.g. GJ09 GCV was ROGJ1 on card 63 but ROGJ2 on
  // the newer cards, matching the current master). Ordering by rate_card_id
  // DESC means the latest mapping wins the exact/alias product match below.
  if (result.recordset.length === 0) return null;
  // Prefer a record whose rto_code matches the exact (original) spelling, then
  // fall through to product matching below over the remaining variant rows.
  const rawUpper = String(rtoCode || '').trim().toUpperCase().replace(/\s+/g, '');
  const exactSpelling = result.recordset.filter(r =>
    String(r.rto_code || '').toUpperCase() === rawUpper);
  const rows = exactSpelling.length ? exactSpelling : result.recordset;
  if (!product) return rows[0];

  // Map vehicle types to config-level product names for matching
  // e.g. GCV/PCV -> CV, CAR -> 4W, TW/TW_EV -> TW
  const productAliases = {
    'GCV': ['CV', 'GCV', 'GCCV'],
    // PCV / MISC are commercial vehicles — their RTO→cluster comes from the
    // CV mapper (stored under product 'GCV'), NOT the Pvt-Car mapper. Without
    // 'GCV' here they fall through to the CAR mapping, which can carry a
    // different cluster (e.g. GJ04 CAR→"ROGJ" has no MISC rules, GJ04
    // GCV→"ROGJ1" does). Include 'GCV' so commercial vehicles use the CV map.
    'PCV': ['CV', 'GCV', 'PCV', 'TAXI', 'SCHOOL_STAFF_BUS'],
    'CAR': ['4W', 'CAR', 'PC'],
    'TW': ['TW', '2W', 'TW_EV'],
    'TW_EV': ['TW', 'TW_EV', '2W'],
    'MISC': ['CV', 'GCV', 'MISC'],
    // E-Rickshaw / electric 3W passenger — Digit's CV RTO sheet maps these to
    // a DIFFERENT cluster column (PCV_3W_Electric) than the generic CV (MCV)
    // column. Prefer the EV-3W mapping, fall back to CV/GCV/PCV.
    'PCV_3W_EV': ['PCV_3W_EV', 'CV', 'GCV', 'PCV'],
    'NON_MOTOR': ['NON_MOTOR'],
  };
  const aliases = productAliases[product] || [product];

  // Try exact product match first
  const exact = rows.find(r => r.product === product);
  if (exact) return exact;

  // Try alias match
  const aliasMatch = rows.find(r => aliases.includes(r.product));
  if (aliasMatch) return aliasMatch;

  // Fallback: return first available
  return rows[0];
}

/**
 * Choose the RTO-mapping product for a policy. Most policies use their coarse
 * vehicleType (CAR/TW/GCV/PCV/...), but some sub-types map to a different
 * cluster column in the insurer's RTO sheet. E-Rickshaw / electric 3W
 * passenger uses the PCV_3W_Electric column (distinct from the generic CV/MCV
 * cluster), so route it to the dedicated 'PCV_3W_EV' product.
 */
function rtoProductFor(params) {
  if (!params) return null;
  const cat = String(params.vehicleCategory || params.vehicleClass || '').toUpperCase();
  const model = String(params.model || '').toUpperCase();
  const hay = `${cat} ${model}`;
  const vt = String(params.vehicleType || '').toUpperCase();

  // Liberty (Robinhood) files THREE different RTO→Geo-Cluster columns keyed by
  // product family (master "RTO_TP Geo Cluster", ingested under card 488):
  //   col5 → Pvt Car & Two Wheeler                       (product 'CAR' / 'TW')
  //   col6 → GCV 3W, GCV 4W <7.5T, PCV 3W & PCV Taxi      (product 'LIB_CV_LIGHT')
  //   col7 → GCV 4W >7.5T, PCV 4W Others & Misc D         (product 'LIB_CV_HEAVY')
  // The zones differ per column (e.g. MH12 = "MAHARASHTRA - 2 P" for PC/TW &
  // light-CV but "MAHARASHTRA - 1 MPK" for heavy-CV), so the right column must
  // be chosen from the policy's CV sub-segment. resolveRTO does an exact
  // product match on these literal product strings.
  if (String(params.insurer || '').toLowerCase() === 'liberty_videocon') {
    if (vt === 'CAR') return 'CAR';
    if (vt === 'TW' || vt === 'TW_EV') return 'TW';
    // MISC (Misc D — tractors etc.) lives in the heavy column.
    if (vt === 'MISC') return 'LIB_CV_HEAVY';
    // 3-wheelers (GCV 3W, PCV 3W / e-rickshaw) → light column.
    const is3W = /3\s*-?\s*W|3\s*WHEEL|RIKSHAW|RICKSHAW|E[-\s]?RICK|E[-\s]?RIK/.test(hay);
    if (is3W) return 'LIB_CV_LIGHT';
    // GCV / PCV 4-wheelers split at 7.5T GVW. Prefer parsed tonnage; fall back
    // to a tonnage figure embedded in the category label ("GCV - 4W 12-20Tn").
    let ton = (params.tonnage != null && params.tonnage !== '') ? Number(params.tonnage) : null;
    if (ton == null || !Number.isFinite(ton)) {
      const m = cat.match(/(\d+(?:\.\d+)?)\s*TN/);   // first number before "Tn"
      if (m) ton = parseFloat(m[1]);
    }
    if (ton != null && Number.isFinite(ton) && ton > 7.5) return 'LIB_CV_HEAVY';
    return 'LIB_CV_LIGHT';   // ≤7.5T, taxis, or unknown → light column
  }

  const isERick = /RIKSHAW|RICKSHAW|E[-\s]?RICK|E[-\s]?RIK/.test(hay);
  if (isERick) return 'PCV_3W_EV';
  return params.vehicleType;
}

module.exports = { lookupRates, resolveRTO, rtoProductFor };
