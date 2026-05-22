/**
 * Bulk commission calculation.
 *
 * Source : vw_NewTempPrarambhExcelMotorDownload (same view as single-policy lookup).
 * Filters: insurer slug (optional) + issue-date range.
 * Per-policy logic: identical to POST /api/policy/lookup — extract params,
 *                   resolve RTO → region, cluster fallback, lookup rates,
 *                   filterRulesByPolicy, pick the first CD2 (non-discount) rule,
 *                   then match against saved margin_rules.
 *
 * For each row the API returns:
 *   rate_pct        : rule.rate_value (decimal, 0..1)
 *   margin_pct      : matched margin_rule.margin_pct (decimal)
 *   premium_base    : base premium used (same choice as policy lookup)
 *   income          : rate_pct × premium_base
 *   savings         : margin_pct × premium_base   (what the margin saves)
 *   outgoing        : (rate_pct − margin_pct) × premium_base
 *
 * Endpoints:
 *   GET  /api/bulk/filters                       → { insurers, min_date, max_date }
 *   POST /api/bulk/calculate  body:{insurer_slug?, date_from?, date_to?, limit?, offset?}
 *                                                → { totals, rows, total_count }
 *   POST /api/bulk/calculate.csv  same body      → CSV stream
 */

const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { getPrarambhUatPool } = require('../db/prarambh-uat-connection');
const { getBeeinsuredPool } = require('../db/beeinsured-connection');
const { lookupRates, resolveRTO } = require('../services/rate-lookup');
const { determinePremium } = require('../services/calculator');
const policyRouter = require('./policy');

const {
  extractPolicyParams,
  resolveInsurerSlug,
  filterRulesByPolicy,
  CLUSTER_STATE_MAP,
  STATE_REGION_MAP,
  rtoStatePrefix,
  inferLocationTiers,
  aliasIciciRegion,
  aliasHdfcRegion,
} = policyRouter;

const PRODUCT_ALIASES = {
  '4W':  ['4W', 'CAR', 'PC', 'PVT.CAR'],
  'CAR': ['CAR', '4W', 'PC', 'PVT.CAR'],
  'PC':  ['PC', '4W', 'CAR'],
  'TW':  ['TW', '2W', 'TW_EV'],
  'GCV': ['GCV', 'CV'],
  'PCV': ['PCV', 'CV'],
  // Chola stores tractor rates under product=GCV with segment "1_TRAC[NEW]" /
  // "1_TRAC[RENEWAL]" — they classify as MISC by vehicle category but live in
  // the GCV grid. Including 'GCV' lets MISC-Tractor policies see those rules.
  'MISC': ['MISC', 'CV', 'GCV'],
  'CV':  ['CV', 'GCV', 'PCV', 'MISC'],
};

const SPECIFIC_VEHICLE_TYPES = new Set(['MISC','GCV','PCV','CAR','TW','TW_EV','4W','2W','PC']);

const router = express.Router();

/** GET /probe/poscodes — inspect Beeinsured_v3_2.tmp_poscodes via the
 *  dedicated connection. */
router.get('/probe/poscodes', async (req, res, next) => {
  try {
    const pool = await getBeeinsuredPool();
    const cols = await pool.request().query(
      `SELECT COLUMN_NAME, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME = 'tmp_poscodes'
       ORDER BY ORDINAL_POSITION`
    );
    const cnt = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.tmp_poscodes`);
    const sample = await pool.request().query(`SELECT TOP 5 * FROM dbo.tmp_poscodes`);
    res.json({
      success: true,
      row_count: cnt.recordset[0].n,
      columns: cols.recordset,
      sample: sample.recordset,
    });
  } catch (err) { next(err); }
});

/** GET /probe/maagent — inspect Beeinsured_v3_2.TMP_MAAGENT (fallback agent table). */
router.get('/probe/maagent', async (req, res, next) => {
  try {
    const pool = await getBeeinsuredPool();
    const cols = await pool.request().query(
      `SELECT COLUMN_NAME, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME = 'TMP_MAAGENT'
       ORDER BY ORDINAL_POSITION`
    );
    const cnt = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.TMP_MAAGENT`);
    const sample = await pool.request().query(`SELECT TOP 5 * FROM dbo.TMP_MAAGENT`);
    res.json({
      success: true,
      row_count: cnt.recordset[0].n,
      columns: cols.recordset,
      sample: sample.recordset,
    });
  } catch (err) { next(err); }
});

/** GET /probe/rto — debug: how many rows have RTO_Code populated? */
router.get('/probe/rto', async (req, res, next) => {
  try {
    const prarambhPool = await getPrarambhUatPool();
    const r = await prarambhPool.request().query(
      `SELECT TOP 10 PolicyNo, INSURERNAME, VehicleType, RTO_Code, StateName, VEHICLE_REGISTRATION_NO
       FROM tmp_PrarambhData
       WHERE INSURERNAME LIKE 'Go Digit%' AND VehicleType LIKE '%Two Wheeler%'
       ORDER BY SubmissionDate DESC`
    );
    const agg = await prarambhPool.request().query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN RTO_Code IS NULL OR RTO_Code = '' THEN 1 ELSE 0 END) AS rto_null,
         SUM(CASE WHEN VEHICLE_REGISTRATION_NO IS NULL OR VEHICLE_REGISTRATION_NO = '' THEN 1 ELSE 0 END) AS regn_null
       FROM tmp_PrarambhData
       WHERE INSURERNAME LIKE 'Go Digit%'`
    );
    res.json({ success: true, sample: r.recordset, aggregates: agg.recordset[0] });
  } catch (err) { next(err); }
});

/** GET /probe — debug: row count + top insurer names. */
router.get('/probe', async (req, res, next) => {
  try {
    const prarambhPool = await getPrarambhUatPool(); // tmp_PrarambhData lives on UAT
    const cnt = await prarambhPool.request().query(`SELECT COUNT(*) AS n FROM tmp_PrarambhData`);
    const ins = await prarambhPool.request().query(
      `SELECT TOP 20 INSURERNAME, COUNT(*) AS n FROM tmp_PrarambhData
       GROUP BY INSURERNAME ORDER BY n DESC`);
    const date = await prarambhPool.request().query(
      `SELECT MIN(SubmissionDate) AS min_d, MAX(SubmissionDate) AS max_d FROM tmp_PrarambhData`);
    res.json({
      success: true,
      row_count: cnt.recordset[0].n,
      top_insurers: ins.recordset,
      date_range: date.recordset[0],
    });
  } catch (err) { next(err); }
});

/** GET /schema — debug endpoint that lists tmp_PrarambhData columns. */
router.get('/schema', async (req, res, next) => {
  try {
    const prarambhPool = await getPrarambhUatPool(); // tmp_PrarambhData lives on UAT
    const r = await prarambhPool.request().query(
      `SELECT COLUMN_NAME, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME = 'tmp_PrarambhData'
       ORDER BY ORDINAL_POSITION`
    );
    res.json({ success: true, columns: r.recordset });
  } catch (err) { next(err); }
});

/** GET /filters — list insurers from the local rate_cards table (fast).
 * Date range defaults are left to the UI so the Prarambh view doesn't get
 * scanned for MIN/MAX (that times out on large tables). The UI should default
 * the From/To dates to a sensible window (last 30 / 90 days).
 */
router.get('/filters', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT DISTINCT insurer FROM rate_cards WHERE status = 'active' ORDER BY insurer`
    );
    // Map each slug to a user-friendly Prarambh insurer name so the
    // dropdown can send the exact string back to /calculate for filtering.
    const SLUG_TO_NAME = {
      go_digit:       'Go Digit',
      digit:          'Go Digit',
      chola_ms:       'Cholamandalam',
      chola:          'Cholamandalam',
      bajaj_allianz:  'Bajaj Allianz',
      bajaj:          'Bajaj Allianz',
      hdfc_ergo:      'HDFC ERGO',
      icici_lombard:  'ICICI Lombard',
      tata_aig:       'Tata AIG',
      reliance:       'Reliance',
      iffco_tokio:    'IFFCO Tokio',
      acko:           'Acko',
      navi:           'Navi',
      future_generali:'Future Generali',
      sbi_general:    'SBI General',
    };
    // Dedupe by display name — multiple slugs (e.g. `digit` + `go_digit`) can
    // roll up to the same Prarambh insurer ("Go Digit"). We keep the first
    // slug seen so the dropdown shows each insurer once.
    const seen = new Set();
    const insurers = [];
    for (const row of r.recordset) {
      const name = SLUG_TO_NAME[(row.insurer || '').toLowerCase()] || row.insurer;
      if (seen.has(name)) continue;
      seen.add(name);
      insurers.push({ slug: row.insurer, insurer_name: name });
    }
    res.json({ success: true, insurers });
  } catch (err) { next(err); }
});

/**
 * Load saved active margin rules into memory — small table, cheap to hold.
 * Returns an array of { margin_pct, filters } ready for matching.
 */
async function loadMarginRules(pool) {
  const r = await pool.request().query(
    `SELECT id, margin_pct, filters_json FROM margin_rules WHERE active = 1`
  );
  return r.recordset.map(row => ({
    id: row.id,
    margin_pct: Number(row.margin_pct),
    filters: (() => { try { return JSON.parse(row.filters_json); } catch { return {}; } })(),
  }));
}

/**
 * Load active special-rate rules indexed by uppercased UPIN code so the
 * per-policy calc can look up overrides for the agent in O(1).
 * Returns Map<upincode_upper, [ { id, filters, override_margin_pct,
 * volume_tiers, window_type, window_from, window_to } ]>.
 */
async function loadSpecialRulesByAgent(pool) {
  const r = await pool.request().query(
    `SELECT id, upincode, filters_json, override_margin_pct, volume_tiers_json,
            window_type, window_from, window_to
     FROM special_rate_rules WHERE active = 1`
  );
  const idx = new Map();
  for (const row of r.recordset) {
    const key = String(row.upincode || '').trim().toUpperCase();
    if (!key) continue;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({
      id: row.id,
      filters: (() => { try { return JSON.parse(row.filters_json); } catch { return {}; } })(),
      override_margin_pct: row.override_margin_pct == null ? null : Number(row.override_margin_pct),
      volume_tiers: row.volume_tiers_json
        ? (() => { try { return JSON.parse(row.volume_tiers_json); } catch { return null; } })()
        : null,
      window_type: row.window_type,
      window_from: row.window_from,
      window_to:   row.window_to,
    });
  }
  return idx;
}

/**
 * Per-agent global uplift map (UPIN → uplift_pct). Applied as a fallback
 * reduction on the default margin when no scope-specific override matches.
 */
async function loadGlobalUpliftsByAgent(pool) {
  const r = await pool.request().query(
    `SELECT upincode, uplift_pct FROM agent_global_uplifts WHERE active = 1`
  );
  const idx = new Map();
  for (const row of r.recordset) {
    const key = String(row.upincode || '').trim().toUpperCase();
    if (!key) continue;
    idx.set(key, Number(row.uplift_pct) || 0);
  }
  return idx;
}

/**
 * Build an in-memory map of UPIN_CODE → agent name from
 * Beeinsured_v3_2.dbo.tmp_poscodes using its own dedicated connection.
 * Used to enrich each policy in the bulk pipeline with an agent name.
 */
let _posMapCache = { map: null, at: 0 };
async function loadPosMap() {
  // Re-fetch at most every 10 minutes to catch new POS codes.
  if (_posMapCache.map && (Date.now() - _posMapCache.at) < 10 * 60 * 1000) {
    return _posMapCache.map;
  }
  const pool = await getBeeinsuredPool();
  const r = await pool.request().query(
    `SELECT upincode, posfullname, status
     FROM dbo.tmp_poscodes
     WHERE upincode IS NOT NULL AND upincode <> ''`
  );
  const map = new Map();
  for (const row of r.recordset) {
    const code = String(row.upincode).trim().toUpperCase();
    if (!code) continue;
    map.set(code, {
      agent_name: (row.posfullname || '').trim() || null,
      status:     (row.status || '').trim() || null,
    });
  }
  _posMapCache = { map, at: Date.now() };
  return map;
}

/**
 * Fallback agent lookup — Beeinsured_v3_2.dbo.TMP_MAAGENT.
 * Used when a policy's UPIN_CODE is not found in tmp_poscodes. TMP_MAAGENT
 * holds MA / branch-level agents (e.g. "PD/AHN/0001") with AgentName,
 * status, RM, location and zone columns we can surface.
 */
let _maagentMapCache = { map: null, at: 0 };
async function loadMaagentMap() {
  if (_maagentMapCache.map && (Date.now() - _maagentMapCache.at) < 10 * 60 * 1000) {
    return _maagentMapCache.map;
  }
  const pool = await getBeeinsuredPool();
  const r = await pool.request().query(
    `SELECT Name, value, AgentName, AgentStatus, ParentRM, Location, Zone
     FROM dbo.TMP_MAAGENT`
  );
  const map = new Map();
  for (const row of r.recordset) {
    const entry = {
      agent_name: (row.AgentName || '').trim() || null,
      status:     (row.AgentStatus || '').trim() || null,
      parent_rm:  (row.ParentRM || '').trim() || null,
      location:   (row.Location || '').trim() || null,
      zone:       (row.Zone || '').trim() || null,
    };
    // Index by both Name and value — some rows use one, some use the other.
    const keys = [];
    if (row.Name  != null) keys.push(String(row.Name).trim().toUpperCase());
    if (row.value != null) keys.push(String(row.value).trim().toUpperCase());
    for (const k of keys) if (k) map.set(k, entry);
  }
  _maagentMapCache = { map, at: Date.now() };
  return map;
}

/**
 * Build a policy_no → PR row lookup (from active pr_rows across all uploads).
 * When multiple PR uploads cover the same policy_no, the most recent
 * year/month wins. Result carries the header premiums so Bulk can show
 * "PR Net" / "PR Gross" / "PR OD" / "PR TP" side-by-side with tmp_PrarambhData.
 */
/** Insurer-specific policy-key variants for PR lookup fallbacks.
 *  Returns an array of stripped/normalised forms to try when the literal
 *  key from tmp_PrarambhData doesn't hit the PR index.
 *
 *  Known patterns:
 *    TATA      "6170434846-00"          → "6170434846"
 *    TATA      "6204468744 01"          → "6204468744"   (space + 2-digit
 *                                                          renewal counter)
 *    Go Digit  "D245987778 / 04042026"  → "D245987778"
 *    (slash)   "D245987778/04042026"    → "D245987778"
 *
 *  Always returns the trimmed/uppercased forms expected by the PR index.
 */
function policyKeyVariants(key) {
  const out = [];
  const k = String(key || '').trim().toUpperCase();
  if (!k) return out;
  // Strip "/ <anything>" — covers Digit's "D... / 04042026" composite.
  const slashStripped = k.split(/\s*\/\s*/)[0].trim();
  if (slashStripped && slashStripped !== k) out.push(slashStripped);
  const baseAfterSlash = slashStripped || k;
  // Strip trailing "-NN" / "-NNN" (TATA endorsement suffix).
  const dashStripped = baseAfterSlash.replace(/-\d{1,3}$/, '');
  if (dashStripped !== baseAfterSlash) out.push(dashStripped);
  // Strip trailing " NN" (TATA renewal counter — space + 1-3 digits, e.g.
  // "6204468744 01"). Test against both the slash-stripped form and the
  // dash-stripped form to compose with prior variants.
  const spaceStripped = baseAfterSlash.replace(/\s+\d{1,3}$/, '');
  if (spaceStripped !== baseAfterSlash) out.push(spaceStripped);
  return out;
}

async function loadPrIndex(pool) {
  const r = await pool.request().query(
    `SELECT pr.policy_no, pr.vehicle_no, pr.od_premium, pr.addon_premium, pr.tp_premium,
            pr.net_amount, pr.gross_amount, pr.sum_insured,
            pr.upload_id, u.insurer_label, u.month, u.year
     FROM pr_rows pr
     INNER JOIN pr_uploads u ON u.id = pr.upload_id
     WHERE u.status = 'active'`
  );
  const idx = new Map();
  // Secondary index: vehicle registration number → PR row.  Used as a
  // fallback when policy_no matching fails (e.g. Prarambh and PR carry
  // different policy-number formats but same registration).
  const byVehicle = new Map();
  const normVeh = (v) => String(v || '').trim().toUpperCase().replace(/[\s\-]/g, '');
  for (const row of r.recordset) {
    if (!row.policy_no) continue;
    const key = String(row.policy_no).trim().toUpperCase();
    const existing = idx.get(key);
    if (!existing || (row.year > existing.year)
      || (row.year === existing.year && row.month > existing.month)) {
      idx.set(key, row);
    }
    // Index by vehicle_no — most-recent year/month wins (same precedence
    // as the policy_no index).  Skip blanks because they would collide
    // across many rows.
    const vKey = normVeh(row.vehicle_no);
    if (vKey && vKey.length >= 6) {
      const exV = byVehicle.get(vKey);
      if (!exV || (row.year > exV.year)
        || (row.year === exV.year && row.month > exV.month)) {
        byVehicle.set(vKey, row);
      }
    }
  }
  // Attach the vehicle index as a property so callers can look it up
  // without needing a parallel return value.
  idx._byVehicle = byVehicle;
  idx._normVeh = normVeh;
  return idx;
}

/**
 * Build a policy_no → { amount, insurer_label, month, year, upload_id, row_id }
 * lookup from all active statement rows. Used by the bulk route so every
 * policy can show its statement amount without a per-row SQL call.
 * Case-insensitive / whitespace-trimmed on the key.
 */
async function loadStatementIndex(pool) {
  const r = await pool.request().query(
    `SELECT sr.id AS row_id, sr.upload_id, sr.policy_no, sr.amount,
            sr.od_commission, sr.addon_commission, sr.tp_commission,
            sr.net_amount, sr.gross_amount, sr.reward,
            su.insurer_label, su.month, su.year
     FROM statement_rows sr
     INNER JOIN statement_uploads su ON su.id = sr.upload_id
     WHERE su.status = 'active'`
  );
  const idx = new Map();
  for (const row of r.recordset) {
    if (!row.policy_no) continue;
    const key = String(row.policy_no).trim().toUpperCase();
    // Keep the most recent match (later year/month wins) by overwriting if newer
    const existing = idx.get(key);
    if (!existing || (row.year > existing.year) ||
        (row.year === existing.year && row.month > existing.month)) {
      idx.set(key, row);
    }
  }
  return idx;
}

// Canonicalise insurer slugs so "digit" and "go_digit" (and "chola" / "chola_ms",
// "bajaj" / "bajaj_allianz") compare equal during margin matching.
const INSURER_SLUG_ALIASES = {
  digit: 'go_digit',         go_digit: 'go_digit',    godigit: 'go_digit',
  chola: 'chola_ms',         chola_ms: 'chola_ms',    cholamandalam: 'chola_ms',
  bajaj: 'bajaj_allianz',    bajaj_allianz: 'bajaj_allianz',
  hdfc: 'hdfc_ergo',         hdfc_ergo: 'hdfc_ergo',
  icici: 'icici_lombard',    icici_lombard: 'icici_lombard',
  tata_aig: 'tata_aig',      tata: 'tata_aig',
};
function canonInsurer(s) {
  const k = String(s || '').toLowerCase().trim();
  return INSURER_SLUG_ALIASES[k] || k;
}

/** Match a policy against a single saved margin rule. */
function policyMatchesMargin(params, rtoInfo, marginFilters) {
  if (!marginFilters || Object.keys(marginFilters).length === 0) return false;
  const f = marginFilters;
  // Insurer — alias-aware compare (digit === go_digit, chola === chola_ms, …)
  if (f.searchInsurer) {
    if (canonInsurer(params._insurer_slug) !== canonInsurer(f.searchInsurer)) return false;
  }
  // Vehicle type (Excel style — "Pvt car"/"TW"/"GCV"/"PCV"/"MIS")
  // Accepts either a single string or an array (multi-select on the UI).
  // When an array, the policy matches if its vehicle type is in the set.
  if (f.searchProduct) {
    const m = {
      'PVT CAR': 'CAR', 'PVT.CAR': 'CAR', '4W': 'CAR', 'CAR': 'CAR',
      'TW': 'TW', '2W': 'TW', 'TW_EV': 'TW',
      'GCV': 'GCV',
      'PCV': 'PCV',
      'MIS': 'MISC', 'MISC': 'MISC',
    };
    const wantList = Array.isArray(f.searchProduct) ? f.searchProduct : [f.searchProduct];
    const vt = String(params.vehicleType || '').toUpperCase();
    const haveCat = m[vt] || vt;
    const anyHit = wantList.some(p => {
      const pt = String(p || '').toUpperCase().replace(/\s+/g, ' ');
      const wantCat = m[pt] || pt;
      return wantCat === haveCat;
    });
    if (!anyHit) return false;
  }
  // Cluster / Region substring (string OR array — array means OR-match).
  if (f.searchCluster) {
    const wantList = (Array.isArray(f.searchCluster) ? f.searchCluster : [f.searchCluster])
      .map(v => String(v || '').toLowerCase()).filter(Boolean);
    if (wantList.length > 0) {
      const have = ((rtoInfo && rtoInfo.cluster) || (rtoInfo && rtoInfo.region) || params.resolvedRegion || '').toLowerCase();
      if (!wantList.some(w => have.includes(w))) return false;
    }
  }
  // State — check many sources: direct StateName column, state-name → RTO
  // prefix map (so "Andhra Pradesh" matches RTO "AP…"), region text, and
  // the rule region's expanded tokens. Accepts string OR array (OR-match).
  if (f.searchState) {
    const NAME_TO_RTO_PREFIX = {
      'andhra pradesh': ['AP', 'TG', 'TS'],
      'telangana': ['TG', 'TS', 'AP'],
      'tamil nadu': ['TN'],
      'karnataka': ['KA'],
      'kerala':    ['KL'],
      'maharashtra': ['MH'],
      'gujarat':   ['GJ'],
      'madhya pradesh': ['MP'],
      'chhattisgarh':   ['CG', 'CT'],
      'uttar pradesh':  ['UP'],
      'uttarakhand':    ['UK'],
      'rajasthan':      ['RJ'],
      'punjab':         ['PB'],
      'haryana':        ['HR'],
      'himachal pradesh':['HP'],
      'jammu and kashmir': ['JK'],
      'west bengal':    ['WB'],
      'bihar':          ['BR'],
      'jharkhand':      ['JH'],
      'odisha':         ['OD', 'OR'],
      'orissa':         ['OD', 'OR'],
      'delhi':          ['DL'],
      'goa':            ['GA'],
      'assam':          ['AS'],
    };
    const wantList = (Array.isArray(f.searchState) ? f.searchState : [f.searchState])
      .map(v => String(v || '').toLowerCase()).filter(Boolean);
    if (wantList.length > 0) {
      const stateName = String(params._stateName || '').toLowerCase();
      const rtoState = String(rtoStatePrefix(params.rtoCode) || '').toUpperCase();
      const regionText = ((rtoInfo && rtoInfo.region) || params.resolvedRegion || '').toLowerCase();
      const anyHit = wantList.some(want => {
        const rtoPrefixesForWantedState = NAME_TO_RTO_PREFIX[want] || [want.toUpperCase()];
        return stateName === want ||
               stateName.includes(want) ||
               rtoPrefixesForWantedState.includes(rtoState) ||
               regionText.includes(want);
      });
      if (!anyHit) return false;
    }
  }
  // City — substring match against StateName / CityName / cluster / region.
  // Accepts string OR array (OR-match).
  if (f.searchCity) {
    const wantList = (Array.isArray(f.searchCity) ? f.searchCity : [f.searchCity])
      .map(v => String(v || '').toLowerCase()).filter(Boolean);
    if (wantList.length > 0) {
      const have = [
        params.cityName,
        rtoInfo && rtoInfo.cluster, rtoInfo && rtoInfo.region,
        params.resolvedRegion,
      ].map(v => String(v || '').toLowerCase()).join(' | ');
      if (!wantList.some(w => have.includes(w))) return false;
    }
  }
  // Make
  if (f.searchMake) {
    const want = String(f.searchMake).toUpperCase();
    const have = String(params.make || '').toUpperCase();
    if (!have.includes(want.split(/\s+/)[0])) return false;
  }
  // Fuel
  if (f.searchFuelType) {
    const want = String(f.searchFuelType).toUpperCase();
    const have = String(params.fuelType || '').toUpperCase();
    if (!have.includes(want)) return false;
  }
  // RTO prefix
  if (f.searchRTO) {
    const want = String(f.searchRTO).toUpperCase();
    const have = String(params.rtoCode || '').toUpperCase();
    if (!have.startsWith(want) && !have.includes(want)) return false;
  }
  // Tonnage range — policy tonnage must fall inside [tonMin, tonMax]
  const tMin = f.searchTonMin != null && f.searchTonMin !== '' ? parseFloat(f.searchTonMin) : null;
  const tMax = f.searchTonMax != null && f.searchTonMax !== '' ? parseFloat(f.searchTonMax) : null;
  if (tMin != null || tMax != null) {
    const pTon = params.tonnage ?? params.tonnageMin;
    if (pTon == null) return false;
    if (tMin != null && pTon < tMin) return false;
    if (tMax != null && pTon > tMax) return false;
  }
  return true;
}

/** Pick the first matching margin (prefer more-specific i.e. more filter keys). */
function matchMarginForPolicy(params, rtoInfo, marginRules) {
  // Sort by specificity (more keys → tried first)
  const sorted = marginRules.slice().sort((a, b) =>
    Object.keys(b.filters || {}).length - Object.keys(a.filters || {}).length
  );
  for (const m of sorted) {
    if (policyMatchesMargin(params, rtoInfo, m.filters)) return m;
  }
  return null;
}

/** Pick the canonical CD2 (non-discount) rule from a filtered rule set. */
function pickPrimaryRateRule(rules) {
  // Drop discount-only rules (CD1 / FLEXI_MAX_CD1 etc.)
  const cd2 = rules.filter(r => {
    const rt = (r.rate_type || '').toUpperCase();
    if (rt === '' || rt === 'CD1' || rt.includes('CD1')) return false;
    if (rt.startsWith('FLEXI')) return false;
    return r.rate_value != null && !r.is_declined;
  });
  if (cd2.length === 0) return null;
  // Prefer a rule where rate_value is between 0 and 1 (already normalised).
  return cd2[0];
}

/** Choose the premium base for income calculation.
 *
 *   GCV / PCV / MISC    → Net premium (PREMIUM_WITHOUT_GST)
 *   CAR / TW   TP       → Net premium (PREMIUM_WITHOUT_GST)
 *   CAR / TW   Comp/SAOD→ OD + Addon, but fall back to Net if OD/Addon are
 *                          zero — many tmp_PrarambhData rows don't populate
 *                          BASE_OD_PREMIUM / ADD_ON_PREMIUM separately,
 *                          leaving PREMIUM_WITHOUT_GST as the only meaningful
 *                          amount.
 *
 * `params.netPremium` is fed from tmp_PrarambhData's `PREMIUM_WITHOUT_GST`
 * column via the remapper in runBulkCalculate.
 */
function premiumBaseFor(params, ruleRateType) {
  const od = params.odPremium || 0;
  const tp = params.tpPremium || 0;
  const addon = params.addonPremium || 0;
  const net = params.netPremium || (od + tp + addon);
  const vt = String(params.vehicleType || '').toUpperCase();
  const ip = String(params.insProduct || '').toUpperCase();

  if (['GCV', 'PCV', 'MISC'].includes(vt)) {
    return net;
  }
  if (ip === 'TP') return net;
  if (ip === 'COMP' || ip === 'SAOD') {
    // OD + Addon preferred; fall back to PREMIUM_WITHOUT_GST when they're zero.
    const odAddon = od + addon;
    if (odAddon > 0) return odAddon;
    return net;
  }
  // Unknown ins_product — prefer net if non-zero, else heuristic.
  if (net > 0) return net;
  return determinePremium(ruleRateType, od, tp, addon);
}

/** Process a single policy row into a bulk-output record.
 * Caches are passed in so repeated (rto_code) and (insurer,product,region,age,fuel)
 * combinations hit memory instead of the DB — typically shrinks a 500-row
 * batch from ~500 DB roundtrips to a handful of unique ones. */
async function processOnePolicy(pool, policy, marginRules, caches, statementIndex, prIndex, specialRulesByAgent, globalUpliftByAgent) {
  const params = extractPolicyParams(policy);
  const insurerSlug = resolveInsurerSlug(params.insurerName);
  params._insurer_slug = insurerSlug;
  // Pick up the StateName column directly from the remapped row — many
  // tmp_PrarambhData rows have it populated even when RTO_Code is blank.
  params._stateName = policy.STATE || policy['STATE NAME'] || policy.StateName || null;
  params._policy_no = policy.PolicyNo || policy['POLICY NO'] || null;

  if (!insurerSlug) {
    return buildOutputRow(policy, params, null, null, null, null, 'Insurer not mapped', null, null);
  }

  // RTO → region (cached per insurer + product + rto_code)
  let rtoInfo = null;
  let resolvedRegion = null;
  if (params.rtoCode) {
    const rtoKey = `${insurerSlug}||${params.vehicleType}||${params.rtoCode}`;
    if (caches.rto.has(rtoKey)) {
      rtoInfo = caches.rto.get(rtoKey);
    } else {
      try {
        rtoInfo = await resolveRTO(pool, insurerSlug, params.vehicleType, params.rtoCode);
      } catch (_) { rtoInfo = null; }
      caches.rto.set(rtoKey, rtoInfo);
    }
    if (rtoInfo) resolvedRegion = rtoInfo.region;
  }
  // City-region carriers (ICICI / HDFC Ergo): when no RTO is available,
  // prime the initial lookup with the policy's booking location so we narrow
  // to the right city instead of pulling every region nationwide and picking
  // the first survivor.
  if (!resolvedRegion && (insurerSlug === 'icici_lombard' || insurerSlug === 'hdfc_ergo')) {
    const bookedLoc = String(
      policy.BusinessBookedLocation || policy['BUSINESS BOOKED LOCATION'] ||
      policy.BooKedLocation || ''
    ).trim();
    if (bookedLoc) resolvedRegion = bookedLoc;
  }
  // ICICI region-name normalization (see policy.js ICICI_REGION_ALIASES).
  // Translates GURGAON / DELHI / Jammu / etc. into ICICI's actual region
  // labels (NCR / JAMMU AND KASHMIR / …) so the SQL lookup hits.
  if (insurerSlug === 'icici_lombard' && resolvedRegion && aliasIciciRegion) {
    resolvedRegion = aliasIciciRegion(resolvedRegion);
  }
  // HDFC Ergo region-name normalization (see HDFC_REGION_ALIASES).
  if (insurerSlug === 'hdfc_ergo' && resolvedRegion && aliasHdfcRegion) {
    resolvedRegion = aliasHdfcRegion(resolvedRegion);
  }
  params.resolvedRegion = resolvedRegion;

  // Product alias set
  const policyType = String(params.vehicleType || '').toUpperCase();
  const resolvedProduct = SPECIFIC_VEHICLE_TYPES.has(policyType)
    ? params.vehicleType
    : ((rtoInfo && rtoInfo.product) || params.vehicleType);
  const productList = PRODUCT_ALIASES[String(resolvedProduct).toUpperCase()] || [resolvedProduct];
  const productIsTw = String(resolvedProduct).toUpperCase().includes('TW') ||
                      String(resolvedProduct).toUpperCase().includes('2W');

  const baseLookup = {
    insurer: insurerSlug,
    product: productList,
    region: resolvedRegion || '',
    cluster: (rtoInfo && rtoInfo.cluster) || '',
    vehicle_age: params.vehicleAge,
    fuel_type: productIsTw ? '' : (params.fuelType || ''),
    ins_product: params.insProduct || '',
  };

  // Initial strict lookup — cached per (insurer, products, region, cluster, age, fuel, ins_product)
  const lookupKey = JSON.stringify({
    i: baseLookup.insurer,
    p: baseLookup.product,
    r: baseLookup.region,
    c: baseLookup.cluster,
    a: baseLookup.vehicle_age,
    f: baseLookup.fuel_type,
    ip: baseLookup.ins_product,
  });
  let rules;
  if (caches.lookup.has(lookupKey)) {
    rules = caches.lookup.get(lookupKey);
  } else {
    rules = await lookupRates(pool, baseLookup);
    caches.lookup.set(lookupKey, rules);
  }
  const initialSqlCount = rules.length;
  if (rules.length > 0) rules = filterRulesByPolicy(rules, params);
  const initialAfterFilter = rules.length;

  // SAOD second-pass — when SAOD-specific patterns yield 0 rules, retry as
  // Comp.  Per user's spec ("if SAOD has no rule, consider COMP for the
  // same combination") — Digit (and others) don't carry a dedicated SAOD
  // rate_type and use Comp's 1+1_MAX_CD2 as the OD-only equivalent.
  if (rules.length === 0 && baseLookup.ins_product === 'SAOD') {
    const compArgs = { ...baseLookup, ins_product: 'Comp' };
    const compKey = lookupKey + '||saodAsComp';
    let compRules;
    if (caches.lookup.has(compKey)) {
      compRules = caches.lookup.get(compKey);
    } else {
      compRules = await lookupRates(pool, compArgs);
      caches.lookup.set(compKey, compRules);
    }
    const compFiltered = compRules.length > 0 ? filterRulesByPolicy(compRules, params) : [];
    if (compFiltered.length > 0) rules = compFiltered;
  }

  // Multi-RTO-mapping fallback — a single RTO often has SEVERAL mappings
  // for product=CV (different regions per vehicle weight class).  Digit's
  // UP32, for example, has BOTH "GOOD UP" (heavy GCV) and "UP-1" (light
  // commercial; rate sheet uses "UP Cluster 1").  resolveRTO returns the
  // first match — when the first region's rules don't cover the policy's
  // weight class, we re-query with every other CV/GCV mapping for the
  // same RTO and feed them as a region_list.  Also fire when only CD1
  // (discount) rules survived — CD1 alone can't drive a rate calc, so
  // we need to find a rate rule (CD2) somewhere.
  const hasRateRule = rules.some(r => {
    const rt = String(r.rate_type || '').toUpperCase();
    return !rt.includes('CD1') && !rt.startsWith('FLEXI') && r.rate_value != null;
  });
  if (!hasRateRule && params.rtoCode) {
    try {
      const allRtoRes = await pool.request()
        .input('ins', sql.NVarChar(100), insurerSlug)
        .input('rto', sql.NVarChar(20), params.rtoCode)
        .query(`SELECT DISTINCT region, cluster FROM rto_mappings
                WHERE insurer = @ins AND rto_code = @rto`);
      const candidates = new Set();
      for (const r of allRtoRes.recordset) {
        if (r.region) candidates.add(r.region);
        if (r.cluster && r.cluster !== r.region) candidates.add(r.cluster);
        // Also add a "cluster-name → rate-sheet alias" expansion: rto_mappings
        // sometimes use compact codes ("UP-1") while rate_rules carry the
        // human-readable form ("UP Cluster 1") with the same semantics.
        const m = String(r.region || '').match(/^(UP|MH|GJ|RJ|TN|KA|AP|TS|MP|CG|HR|HP|UK|JK|WB|OR|AS|BR|JH|KL|PB|DL|GA|CH|SK|TR|MN|ML|NL|MZ|AR)[\s-]*(\d+)$/i);
        if (m) candidates.add(`${m[1]} Cluster ${m[2]}`);
      }
      // Drop the region we already tried; keep order
      candidates.delete(resolvedRegion);
      candidates.delete((rtoInfo && rtoInfo.cluster) || '');
      if (candidates.size > 0) {
        const fbKey = lookupKey + '||rtoFb:' + [...candidates].join('|');
        let attempt;
        if (caches.lookup.has(fbKey)) {
          attempt = caches.lookup.get(fbKey);
        } else {
          attempt = await lookupRates(pool, {
            ...baseLookup, region: '', cluster: '',
            region_list: [...candidates], region_match_mode: 'token',
          });
          caches.lookup.set(fbKey, attempt);
        }
        const afterFilter = attempt.length > 0 ? filterRulesByPolicy(attempt, params) : [];
        if (afterFilter.length > 0) {
          rules = afterFilter;
          // Pick the region of the first matching rule for surface display.
          resolvedRegion = afterFilter[0].region || resolvedRegion;
        }
      }
    } catch (_) { /* fall through to existing cluster fallback */ }
  }

  // Cluster fallback (same priority-order as single lookup)
  if (rules.length === 0) {
    const key = ((rtoInfo && rtoInfo.cluster) || resolvedRegion || '').trim().toUpperCase();
    const clusterCandidates = CLUSTER_STATE_MAP[key] || [];
    const stateKey = rtoStatePrefix(params.rtoCode);
    const stateCandidates = STATE_REGION_MAP[stateKey] || [];
    // HDFC Ergo / ICICI state-fallback — see policy.js for details. Pull from
    // BOTH the alias map (keyed by resolved region) and the state-fallback
    // map (keyed by RTO state prefix) so missing-RTO policies still hit.
    const policyMod = require('./policy');
    const hdfcCandidates = (insurerSlug === 'hdfc_ergo' && policyMod.getHdfcStateFallbacks)
      ? [
          ...(policyMod.HDFC_REGION_ALIASES?.[key] || []),
          ...policyMod.getHdfcStateFallbacks(stateKey),
        ]
      : [];
    const iciciCandidates = (insurerSlug === 'icici_lombard' && policyMod.getIciciStateFallbacks)
      ? [
          ...(policyMod.ICICI_REGION_ALIASES?.[key] || []),
          ...policyMod.getIciciStateFallbacks(stateKey),
        ]
      : [];
    // Tier-based candidates — Royal Sundaram (and similar) store Comp rates
    // under tier names like "Key Cities" / "Other Cities" / "Rest of State"
    // rather than per-city. The smart filter's remarks-state check then
    // narrows to the correct state.
    // Derive a state-name fallback from the RTO prefix when the source row
    // didn't carry STATE NAME — Royal Sundaram tier rules narrow by state
    // via `remarks`, so getting any state hint matters.
    const STATE_PREFIX_FULL = require('./policy').STATE_PREFIX_FULL || {};
    const rtoStateName = STATE_PREFIX_FULL[rtoStatePrefix(params.rtoCode)] || '';
    const stateForTiers = params._stateName || rtoStateName;
    const tierCandidates = inferLocationTiers
      ? inferLocationTiers((rtoInfo && rtoInfo.cluster) || resolvedRegion, stateForTiers)
      : [];
    const seen = new Set();
    const candidates = [
      ...clusterCandidates, ...stateCandidates,
      ...hdfcCandidates, ...iciciCandidates,
      ...tierCandidates,
    ].filter(r => {
      if (seen.has(r)) return false; seen.add(r); return true;
    });
    for (const r of candidates) {
      const fbKey = lookupKey + '||fb:' + r;
      let attempt;
      if (caches.lookup.has(fbKey)) {
        attempt = caches.lookup.get(fbKey);
      } else {
        attempt = await lookupRates(pool, { ...baseLookup, region: r, cluster: '', region_match_mode: 'token' });
        caches.lookup.set(fbKey, attempt);
      }
      // SAOD-as-Comp 2nd pass inside the fallback chain — Royal Sundaram
      // (and others without a dedicated SAOD rate_type) reuse Comp rates
      // for SAOD policies. The top-of-pipeline 2-pass only fires for the
      // initial region; for tier/cluster candidates the same fallback is
      // needed.
      if (attempt.length === 0 && baseLookup.ins_product === 'SAOD') {
        const fbKeyComp = fbKey + '||saodAsComp';
        if (caches.lookup.has(fbKeyComp)) {
          attempt = caches.lookup.get(fbKeyComp);
        } else {
          attempt = await lookupRates(pool, { ...baseLookup, ins_product: 'Comp', region: r, cluster: '', region_match_mode: 'token' });
          caches.lookup.set(fbKeyComp, attempt);
        }
      }
      const afterFilter = attempt.length > 0 ? filterRulesByPolicy(attempt, params) : [];
      if (afterFilter.length > 0) {
        rules = afterFilter;
        resolvedRegion = r;
        break;
      }
    }
  }

  // GCV → MISC reclassification fallback — JCB / Eicher heavy / Bolero-pickup-
  // style policies often classify under GCV in source data but Digit treats
  // them as MISC (construction equipment, niche carriers).  When the GCV
  // pipeline misses, retry the lookup with product=MISC (and CV alias).
  if (rules.length === 0 && String(params.vehicleType || '').toUpperCase() === 'GCV') {
    const miscArgs = { ...baseLookup, product: ['MISC', 'CV'] };
    const miscKey = lookupKey + '||gcvAsMisc';
    let miscRules;
    if (caches.lookup.has(miscKey)) {
      miscRules = caches.lookup.get(miscKey);
    } else {
      miscRules = await lookupRates(pool, miscArgs);
      caches.lookup.set(miscKey, miscRules);
    }
    const miscFiltered = miscRules.length > 0 ? filterRulesByPolicy(miscRules, params) : [];
    if (miscFiltered.length > 0) rules = miscFiltered;
  }

  // Final fallback: when RTO → cluster/zone lookups all miss, try the
  // policy's StateName / city fields directly against rate-rule regions.
  // ICICI rate cards (and others) carry state names ("Maharashtra",
  // "Andhra Pradesh") and city names ("MUMBAI", "AHMEDABAD") in the
  // `region` column — so a RTO that isn't pre-mapped can still hit a
  // rule by state/city alone.
  if (rules.length === 0) {
    const stateName = String(params._stateName || '').trim();
    const cityName  = String(
      policy['CLIENT CITY NAME'] || policy['VEHICLE CITY']  ||
      policy.client_city_name    || policy.VEHICLE_CITY    || ''
    ).trim();
    const candidates = [];
    if (cityName)  candidates.push(cityName);          // try city first (more specific)
    if (stateName) candidates.push(stateName);
    for (const r of candidates) {
      const fbKey = lookupKey + '||sc:' + r;
      let attempt;
      if (caches.lookup.has(fbKey)) {
        attempt = caches.lookup.get(fbKey);
      } else {
        attempt = await lookupRates(pool, { ...baseLookup, region: r, cluster: '', region_match_mode: 'token' });
        caches.lookup.set(fbKey, attempt);
      }
      const afterFilter = attempt.length > 0 ? filterRulesByPolicy(attempt, params) : [];
      if (afterFilter.length > 0) {
        rules = afterFilter;
        resolvedRegion = r;
        break;
      }
    }
  }

  // Go Digit last-resort: when RTO / cluster / state / city all miss, fall
  // back to "Ahmedabad" as the region. Digit's rate cards lean on city-based
  // regions and Ahmedabad is the catch-all that covers most segments.
  if (rules.length === 0 && insurerSlug === 'go_digit') {
    const fbKey = lookupKey + '||digitAhd';
    let attempt;
    if (caches.lookup.has(fbKey)) {
      attempt = caches.lookup.get(fbKey);
    } else {
      attempt = await lookupRates(pool, { ...baseLookup, region: 'Ahmedabad', cluster: '', region_match_mode: 'token' });
      caches.lookup.set(fbKey, attempt);
    }
    const afterFilter = attempt.length > 0 ? filterRulesByPolicy(attempt, params) : [];
    if (afterFilter.length > 0) {
      rules = afterFilter;
      resolvedRegion = 'Ahmedabad';
    }
  }

  // ICICI Lombard / HDFC Ergo last-resort: when RTO / cluster / state / city
  // all miss, fall back to the policy's booking location. Both carriers
  // bucket rules by booking-branch city, so the booked location hits where
  // the RTO-derived region doesn't.
  if (rules.length === 0 && (insurerSlug === 'icici_lombard' || insurerSlug === 'hdfc_ergo')) {
    let bookedLoc = String(
      policy.BusinessBookedLocation || policy['BUSINESS BOOKED LOCATION'] ||
      policy.BooKedLocation || ''
    ).trim();
    if (insurerSlug === 'icici_lombard' && aliasIciciRegion) bookedLoc = aliasIciciRegion(bookedLoc);
    else if (insurerSlug === 'hdfc_ergo' && aliasHdfcRegion) bookedLoc = aliasHdfcRegion(bookedLoc);
    if (bookedLoc) {
      const fbKey = lookupKey + '||icBl:' + bookedLoc;
      let attempt;
      if (caches.lookup.has(fbKey)) {
        attempt = caches.lookup.get(fbKey);
      } else {
        attempt = await lookupRates(pool, { ...baseLookup, region: bookedLoc, cluster: '', region_match_mode: 'token' });
        caches.lookup.set(fbKey, attempt);
      }
      const afterFilter = attempt.length > 0 ? filterRulesByPolicy(attempt, params) : [];
      if (afterFilter.length > 0) {
        rules = afterFilter;
        resolvedRegion = bookedLoc;
      }
    }
  }

  // Null-rate handling — when filterRulesByPolicy returned rules but ALL
  // their CD2 rates are null (Digit declined the segment+region for that
  // product), try recovery in priority order:
  //   (1) Cross-region: same insurer+product+segment+rate_type in adjacent
  //       regions — find the same rule with a non-null rate.
  //   (2) SATP fallback: when this is a Comp policy with null COMP_MAX_CD2,
  //       check if SATP_MAX_CD2 in same region has a rate; use that as a
  //       proxy with a clear "Comp declined → using TP rate" note.
  //   (3) Otherwise mark the row's rate as DECLINED so the UI/CSV shows
  //       it explicitly instead of "No matching rule".
  let _rateRecoveryNote = null;
  let _isDeclined = false;
  const hasAnyRate = rules.some(r => {
    const rt = String(r.rate_type || '').toUpperCase();
    return !rt.includes('CD1') && !rt.startsWith('FLEXI') && r.rate_value != null;
  });
  if (rules.length > 0 && !hasAnyRate) {
    // Pick a target rule to recover — prefer a Comp-family rate_type (any of
    // COMP_MAX_CD2 / Comp / Comp_New_Car / PACK / Package*). Falls back to
    // the first non-CD1 rule. Generic across insurers (Digit / Royal / TATA).
    const isCompLikeRt = (rt) => {
      const u = String(rt || '').toUpperCase();
      return /^(COMP|PACK|PACKAGE)/.test(u) || /COMP_MAX_CD2|HOM\|PACKAGE|DM\|PACKAGE/.test(u);
    };
    const targetRule = rules.find(r => isCompLikeRt(r.rate_type) && r.rate_value == null)
                    || rules.find(r => !/CD1/i.test(r.rate_type || '') && !/^FLEXI/i.test(r.rate_type || '') && r.rate_value == null);
    const matchedSeg = targetRule ? targetRule.segment : rules[0].segment;
    const wantedRtBase = targetRule ? targetRule.rate_type : (rules[0].rate_type || 'COMP_MAX_CD2');
    // (1) cross-region: same segment + non-null rate in any other region
    try {
      const r1 = await pool.request()
        .input('ins', sql.NVarChar(100), insurerSlug)
        .input('seg', sql.NVarChar(300), matchedSeg)
        .input('rt',  sql.NVarChar(100), wantedRtBase)
        .query(`SELECT TOP 1 region, rate_value FROM rate_rules
                WHERE insurer = @ins AND segment = @seg AND rate_type = @rt
                  AND rate_value IS NOT NULL
                ORDER BY CASE WHEN region = '${(resolvedRegion || '').replace(/'/g, "''")}' THEN 1 ELSE 2 END,
                         id ASC`);
      if (r1.recordset.length > 0) {
        const cross = r1.recordset[0];
        // Use this rate by overriding the matched rule's rate_value AND
        // clearing the is_declined flag — many insurers (Royal Sundaram
        // especially) ship pre-declined rows for regions where they didn't
        // publish rates. Once we substitute a cross-region rate, the row
        // is no longer "declined" for matching purposes.
        const target = rules.find(r => r.rate_type === wantedRtBase);
        if (target) {
          target.rate_value = Number(cross.rate_value);
          target.is_declined = false;
          _rateRecoveryNote = `Comp declined for ${resolvedRegion} — using same segment's rate from ${cross.region}`;
        }
      }
    } catch (_) { /* fall through */ }
    // (2) SATP fallback for Comp policies — if the rule still has null rate
    if (rules.find(r => r.rate_type === wantedRtBase && r.rate_value == null)) {
      const satpRule = rules.find(r => /SATP/i.test(r.rate_type || '') && r.rate_value != null);
      if (satpRule) {
        const target = rules.find(r => r.rate_type === wantedRtBase);
        if (target) {
          target.rate_value = Number(satpRule.rate_value);
          target.is_declined = false;
          _rateRecoveryNote = `Comp declined for ${resolvedRegion} — using SATP rate (${(satpRule.rate_value * 100).toFixed(2)}%) as proxy`;
        }
      }
    }
    // (3) After both recoveries, if still null → mark declined
    if (rules.find(r => r.rate_type === wantedRtBase && r.rate_value == null)) {
      _isDeclined = true;
      _rateRecoveryNote = `Declined by ${insurerSlug} for ${resolvedRegion} / ${matchedSeg} — Comp not offered`;
    }
  }

  const primary = pickPrimaryRateRule(rules);
  if (!primary) {
    // Still try to surface the statement + PR amounts if we have them.
    let stmt = null, pr = null;
    const key = String(params._policy_no || '').trim().toUpperCase();
    if (key) {
      if (statementIndex) stmt = statementIndex.get(key) || null;
      if (prIndex) {
        pr = prIndex.get(key) || null;
        if (!pr) {
          for (const stripped of policyKeyVariants(key)) {
            pr = prIndex.get(stripped);
            if (pr) break;
          }
        }
        if (!pr && prIndex._byVehicle && params.vehicleRegNo) {
          const vKey = prIndex._normVeh(params.vehicleRegNo);
          if (vKey && vKey.length >= 6) {
            pr = prIndex._byVehicle.get(vKey) || null;
          }
        }
      }
    }
    // Build a diagnostic note so the UI can show why this row didn't match.
    // Covers the three common cases so the user can act on it.
    let why = 'No matching rule';
    const bits = [];
    bits.push(`insurer=${insurerSlug || '?'}`);
    bits.push(`product=${resolvedProduct || '?'}`);
    if (resolvedRegion)                              bits.push(`region=${resolvedRegion}`);
    else if (rtoInfo && rtoInfo.cluster)             bits.push(`cluster=${rtoInfo.cluster}`);
    else if (params.rtoCode)                         bits.push(`rto=${params.rtoCode}`);
    if (params.vehicleAge != null)                   bits.push(`age=${params.vehicleAge}`);
    if (baseLookup.fuel_type)                        bits.push(`fuel=${baseLookup.fuel_type}`);
    if (params.insProduct)                           bits.push(`ins=${params.insProduct}`);
    if (initialSqlCount === 0) {
      why = 'No rule hit SQL — check rate card is loaded for ' + (insurerSlug || '?') + '/' + (resolvedProduct || '?');
    } else if (initialAfterFilter === 0) {
      why = `${initialSqlCount} SQL rule(s) found but none survived policy filter (age/fuel/make/seating/tonnage)`;
    } else if (!rtoInfo) {
      why = 'RTO not mapped — ' + (params.rtoCode || '(blank)') + ' has no region/cluster entry';
    }
    why += ' — ' + bits.join(', ');
    // If the recovery block flagged this as declined-by-insurer, surface that
    // as the note instead of the generic "no matching rule" diagnostic — it's
    // a truthful, actionable status.
    if (_isDeclined && _rateRecoveryNote) {
      why = _rateRecoveryNote;
    }
    return buildOutputRow(policy, params, null, null, null, null, why, stmt, pr);
  }

  let rateVal = Number(primary.rate_value || 0);
  if (rateVal > 1) rateVal = rateVal / 100;
  const premiumBase = premiumBaseFor(params, primary.rate_type);
  const income = rateVal * premiumBase;

  // Match a margin rule for this policy
  const matchedMargin = matchMarginForPolicy(params, rtoInfo, marginRules);
  const defaultMarginPctRaw = matchedMargin ? Number(matchedMargin.margin_pct) : 0;
  let effectiveMarginPctRaw = defaultMarginPctRaw;
  let appliedSpecialRate = null;
  let appliedGlobalUplift = 0;
  // Agent-specific override — if the policy carries a UPIN with any active
  // special_rate_rules whose filters cover this scope, prefer the lowest
  // margin (most favourable to the agent). Volume tiers are not applied
  // here yet because per-agent premium accumulation needs its own pass;
  // flat overrides apply directly.
  const _aUpin = String(policy._agent_code || '').trim().toUpperCase();
  if (_aUpin && specialRulesByAgent && specialRulesByAgent.has(_aUpin)) {
    for (const sr of specialRulesByAgent.get(_aUpin)) {
      if (!policyMatchesMargin(params, rtoInfo, sr.filters)) continue;
      if (sr.override_margin_pct == null) continue; // tier-only rule, skip for now
      if (sr.override_margin_pct < effectiveMarginPctRaw) {
        effectiveMarginPctRaw = sr.override_margin_pct;
        appliedSpecialRate = sr;
      }
    }
  }
  // Global uplift fallback — applies only when no scope-specific override
  // already lowered the margin. uplift_pct is the bonus the agent gets
  // (positive number = more outgoing), so we subtract it from the default
  // margin. Floored at 0 so we never produce a negative effective margin.
  if (!appliedSpecialRate && _aUpin && globalUpliftByAgent && globalUpliftByAgent.has(_aUpin)) {
    const uplift = globalUpliftByAgent.get(_aUpin);
    if (uplift > 0) {
      effectiveMarginPctRaw = Math.max(0, effectiveMarginPctRaw - uplift);
      appliedGlobalUplift = uplift;
    }
  }
  const marginPct = effectiveMarginPctRaw / 100;
  const savings = marginPct * premiumBase;
  const outgoing = Math.max(0, income - savings);

  // Tag for the output row so the UI can flag policies whose calc was
  // changed by a Special Rate. source = 'row_override' | 'global_uplift' | null.
  const specialTag = appliedSpecialRate
    ? {
        source: 'row_override',
        special_rate_id: appliedSpecialRate.id,
        default_margin_pct: defaultMarginPctRaw,
        effective_margin_pct: effectiveMarginPctRaw,
      }
    : (appliedGlobalUplift > 0
      ? {
          source: 'global_uplift',
          global_uplift_pct: appliedGlobalUplift,
          default_margin_pct: defaultMarginPctRaw,
          effective_margin_pct: effectiveMarginPctRaw,
        }
      : null);

  // Statement match — look up by policy_no (case-insensitive trim).
  let stmt = null;
  let pr = null;
  const policyKey = String(params._policy_no || policy.PolicyNo || policy['POLICY NO'] || '').trim().toUpperCase();
  if (policyKey) {
    if (statementIndex) stmt = statementIndex.get(policyKey) || null;
    if (prIndex) {
      pr = prIndex.get(policyKey) || null;
      if (!pr) {
        for (const stripped of policyKeyVariants(policyKey)) {
          pr = prIndex.get(stripped);
          if (pr) break;
        }
      }
      // Vehicle-registration fallback (see comment above).
      if (!pr && prIndex._byVehicle && params.vehicleRegNo) {
        const vKey = prIndex._normVeh(params.vehicleRegNo);
        if (vKey && vKey.length >= 6) {
          pr = prIndex._byVehicle.get(vKey) || null;
        }
      }
    }
  }

  return buildOutputRow(policy, params, primary, rateVal, matchedMargin, {
    premium_base: premiumBase,
    income, savings, outgoing,
    special: specialTag,
  }, _rateRecoveryNote, stmt, pr);
}

/**
 * Reconciliation status comparing statement amount vs calculated income.
 *   CNR — statement amount missing (Could Not Reconcile)
 *   OK  — amounts are equal (within ₹1 tolerance)
 *   EX  — statement amount > income (Excess received)
 *   SCR — statement amount < income (Short Credit Received)
 */
function reconciliationStatus(income, statementAmount) {
  if (statementAmount == null) return 'CNR';
  const diff = Number(statementAmount) - Number(income || 0);
  if (Math.abs(diff) < 1) return 'OK';
  return diff > 0 ? 'EX' : 'SCR';
}

function buildOutputRow(policy, params, rule, rateVal, marginRule, nums, note, stmt, pr) {
  const income      = nums ? +nums.income.toFixed(2)   : 0;
  const savings     = nums ? +nums.savings.toFixed(2)  : 0;
  const outgoing    = nums ? +nums.outgoing.toFixed(2) : 0;
  const stmtAmount  = stmt ? (Number(stmt.amount) || 0) : null;
  // Compute a fallback premium_base even when no rate rule matched so the
  // user can still see the policy's premium (per request: "even rule not
  // match display other data, only rates and calculation should be ZERO").
  // Use the same heuristic as premiumBaseFor when no rule is in play.
  const premiumBaseShown = nums
    ? nums.premium_base
    : premiumBaseFor(params, '');

  // Compliance derivation — kept up here so it can be referenced as plain
  // keys on the returned object (object-spread of an IIFE was being
  // optimised out by the V8 host on this code path).
  const _insP   = String(params.insProduct || '').toUpperCase();
  const _aCode  = String(policy._agent_code || '').toUpperCase().trim();
  const _idv    = Number(policy['IDV'] || policy['VEHICLE IDV'] || policy.VEHICLE_IDV || 0);
  const _isTp   = _insP === 'TP';
  const _isPos  = /^POS/.test(_aCode);
  const _isPd   = /^PD/.test(_aCode);
  const _idvOk  = _idv > 0 && _idv <= 5000000;
  // Rules:
  //   • TP   policy + POS agent              → Compliance
  //   • non-TP        + POS agent + IDV ≤ 50L → Compliance
  //   • everything else                       → Non-compliance
  // PD agents are always Non-compliance (no TP override).
  const _reasons = [];
  let _compliant;
  if (_isTp && _isPos) {
    _compliant = true;
    _reasons.push('TP policy', 'POS agent');
  } else if (!_isTp && _isPos && _idvOk) {
    _compliant = true;
    _reasons.push('POS agent', `IDV ₹${_idv.toLocaleString('en-IN')} ≤ 50L`);
  } else {
    _compliant = false;
    // Agent-code reason
    if (!_aCode)        _reasons.push('no agent code');
    else if (_isPd)     _reasons.push('PD agent code (non-POS)');
    else if (!_isPos)   _reasons.push(`agent code "${_aCode}" doesn't start with POS`);
    // IDV reason (only matters for non-TP policies)
    if (!_isTp && _isPos && !_idvOk) {
      if (_idv === 0)          _reasons.push('IDV missing');
      else if (_idv > 5000000) _reasons.push(`IDV ₹${_idv.toLocaleString('en-IN')} > 50L`);
    }
  }
  const _complianceFlag   = _compliant ? 'Compliance' : 'Non-compliance';
  const _complianceReason = _reasons.join('; ');
  // Submission date — pull from the remapped tmp_PrarambhData row.
  // SQL column is SubmissionDate (datetime); we surface as ISO YYYY-MM-DD
  // for stable CSV display + downstream cycle filtering.
  let _submissionDate = policy.SubmissionDate || policy['SUBMISSION DATE'] || null;
  if (_submissionDate instanceof Date && !isNaN(_submissionDate)) {
    _submissionDate = _submissionDate.toISOString().slice(0, 10);
  }

  return {
    policy_no: policy['POLICY NO'] || null,
    tracker_no: policy['TRACKER NO'] || null,
    submission_date: _submissionDate,
    insurer: params.insurerName,
    insurer_slug: params._insurer_slug,
    // Agent / POS — UPIN_CODE joined to beeinsured_v3_2.tmp_poscodes for posfullname.
    agent_code: policy._agent_code || null,
    agent_name: policy._agent_name || null,
    agent_commission: policy._agent_commission != null ? policy._agent_commission : null,
    rm_name: policy._rm_name || null,
    agent_pos_matched: policy._agent_pos_matched === true,
    agent_pos_status: policy._agent_pos_status || null,
    agent_pos_source: policy._agent_pos_source || null,   // 'pos' | 'maagent' | null
    agent_location: policy._agent_location || null,
    agent_zone: policy._agent_zone || null,
    vehicle_type: params.vehicleType,
    make: params.make,
    model: params.model,
    rto_code: params.rtoCode,
    region: params.resolvedRegion || null,
    od_premium: params.odPremium || 0,
    tp_premium: params.tpPremium || 0,
    net_premium: params.netPremium || 0,
    premium_base: premiumBaseShown,
    // IDV (Insured Declared Value) — surfaced so the UI can show the
    // compliance reason at a glance (Compliance requires IDV ≤ ₹50L for
    // non-TP policies).
    idv: _idv > 0 ? _idv : null,
    matched_rule_id:  rule ? rule.id : null,
    matched_sheet:    rule ? rule.sheet_name : null,
    matched_segment:  rule ? rule.segment : null,
    matched_rate_type: rule ? rule.rate_type : null,
    rate_pct:   rateVal != null ? +(rateVal * 100).toFixed(3) : null,
    margin_id:  marginRule ? marginRule.id : null,
    // margin_pct stays as the original DEFAULT margin so the UI's Margin
    // column displays unchanged (the agent's special rate is signalled by a
    // chip + the Outgoing %, which reads from effective_margin_pct).
    margin_pct: marginRule ? Number(marginRule.margin_pct) : 0,
    // Special-rate trace — null when the agent has no override / uplift
    // in effect for this scope. effective_margin_pct is the % actually
    // subtracted from rate inside savings/outgoing — the UI uses it to
    // render Outgoing % while keeping margin_pct as the visible default.
    special_rate_source:  nums && nums.special ? nums.special.source              : null,
    special_rate_id:      nums && nums.special ? nums.special.special_rate_id     : null,
    global_uplift_pct:    nums && nums.special ? nums.special.global_uplift_pct   : null,
    effective_margin_pct: nums && nums.special ? nums.special.effective_margin_pct
                                              : (marginRule ? Number(marginRule.margin_pct) : 0),
    income, savings, outgoing,
    // Statement-match fields (null when no statement covers this policy)
    statement_amount:    stmtAmount,
    statement_period:    stmt ? `${String(stmt.month).padStart(2, '0')}-${stmt.year}` : null,
    statement_upload_id: stmt ? stmt.upload_id : null,
    // Premium Register match — from pr_rows keyed by policy_no
    pr_matched:          pr ? true : false,
    pr_od_premium:       pr && pr.od_premium    != null ? Number(pr.od_premium)    : null,
    pr_addon_premium:    pr && pr.addon_premium != null ? Number(pr.addon_premium) : null,
    pr_tp_premium:       pr && pr.tp_premium    != null ? Number(pr.tp_premium)    : null,
    pr_net_amount:       pr && pr.net_amount    != null ? Number(pr.net_amount)    : null,
    pr_gross_amount:     pr && pr.gross_amount  != null ? Number(pr.gross_amount)  : null,
    pr_period:           pr ? `${String(pr.month).padStart(2, '0')}-${pr.year}` : null,
    pr_upload_id:        pr ? pr.upload_id : null,
    // Reconciliation status: CNR / OK / EX / SCR
    status: reconciliationStatus(income, stmtAmount),
    status_variance: stmtAmount != null ? +(stmtAmount - income).toFixed(2) : null,
    // Source-system policy life-cycle flag (e.g. "Active", "Cancelled",
    // "Bounced", "Endorsement"). The remapper drops this on policy._final_status.
    policy_status: policy._final_status || null,
    // Compliance flag — Compliance if TP, OR (agent_code starts with POS
    // AND IDV ≤ ₹50L). Anything else (PD prefix, IDV > 50L on non-TP, no
    // code) is Non-compliance. Reason string captures the deciding factors.
    compliance_flag:   _complianceFlag,
    compliance_reason: _complianceReason,
    note: note || null,
  };
}

/**
 * Core bulk-calculate routine — used by the JSON endpoint AND the CSV endpoint.
 * Returns { totals, rows, processed, total_count, limit, offset }.
 */
async function runBulkCalculate(body) {
  const { insurer_slug, insurer_name, date_from, date_to, limit, offset,
          policy_nos /* explicit whitelist — bypasses date/insurer filters */ } = body || {};
  const cap = Math.min(parseInt(limit || '5000', 10) || 5000, 20000);
  const skip = Math.max(0, parseInt(offset || '0', 10) || 0);

  const prarambhPool = await getPrarambhUatPool(); // tmp_PrarambhData lives on UAT
  const pool         = await getPool();

  const whereBits = [];
  const req2 = prarambhPool.request();
  req2.timeout = 180000;
  if (Array.isArray(policy_nos) && policy_nos.length > 0) {
    // Explicit whitelist — match on PolicyNo OR TrackerNo so the caller can
    // pass either. Limit enforced by list size, not date/insurer.
    const names = policy_nos.slice(0, 500).map((v, i) => {
      req2.input('pn' + i, sql.NVarChar(200), String(v).trim());
      return '@pn' + i;
    });
    whereBits.push(`(PolicyNo IN (${names.join(',')}) OR TrackerNo IN (${names.join(',')}))`);
  } else if (insurer_name) {
    req2.input('ins', sql.NVarChar(200), insurer_name + '%');
    whereBits.push(`INSURERNAME LIKE @ins`);
  } else if (insurer_slug) {
    req2.input('slug', sql.NVarChar(100), insurer_slug);
    whereBits.push(`LOWER(REPLACE(INSURERNAME, ' ', '_')) LIKE LOWER(@slug) + '%'`);
  } else {
    // No explicit insurer filter (i.e. "All insurers" in the UI) — restrict
    // to insurers we currently have rate cards loaded for, so the bulk
    // calc doesn't pull in policies for un-configured carriers (which all
    // match no rule and bloat the CNR / no-stmt count).
    try {
      const cardsRes = await pool.request()
        .query(`SELECT DISTINCT insurer FROM rate_cards
                WHERE insurer IS NOT NULL
                  AND (effective_to IS NULL OR effective_to > GETDATE())`);
      const slugs = cardsRes.recordset
        .map(r => String(r.insurer || '').trim())
        .filter(Boolean);
      if (slugs.length > 0) {
        const ors = slugs.map((s, i) => {
          req2.input('cfgSlug' + i, sql.NVarChar(100), s);
          return `LOWER(REPLACE(INSURERNAME, ' ', '_')) LIKE LOWER(@cfgSlug${i}) + '%'`;
        });
        whereBits.push(`(${ors.join(' OR ')})`);
      }
    } catch (_) { /* if rate_cards lookup fails, fall through with no filter */ }
  }
  // tmp_PrarambhData stores dates in SubmissionDate (datetime) — use that.
  // (Reported_Date is varchar like "04-Mar-26" so it's awkward to range-filter.)
  if (!policy_nos) {
    if (date_from) { req2.input('dfrom', sql.DateTime, new Date(date_from)); whereBits.push(`SubmissionDate >= @dfrom`); }
    if (date_to)   { req2.input('dto',   sql.DateTime, new Date(date_to));   whereBits.push(`SubmissionDate <= @dto`); }
  }
  const whereSql = whereBits.length > 0 ? ` WHERE ${whereBits.join(' AND ')} ` : ' ';
  req2.input('take', sql.Int, cap);
  req2.input('skip', sql.Int, skip);

  // Source table — tmp_PrarambhData (indexed). SELECT only the columns the
  // per-row processor actually consumes; the table has ~200 columns and a
  // naked SELECT * bricked the connection on non-trivial ranges.
  const PROJECT = [
    'PolicyNo','TrackerNo','INSURERNAME','ProductTypeName',
    // VehicleType / VehicalCategoryname were nulled out in the May-26 rebuild
    // of tmp_PrarambhData. The same data now lives in VEHICAL_TYPE_Id
    // ("Two Wheeler", "Pvt.Car", "Commercial-Goods Carrying", …) and
    // VehicalCategory_Updated ("MOTOR_CYCLE", "SCOOTER", "COMPACT_CARS", …).
    // Keep the legacy columns selected so any future repopulation works
    // automatically; remap below uses the new columns as fallbacks.
    'VehicleType','VehicalCategoryname','VEHICAL_TYPE_Id','VehicalCategory_Updated',
    'VEHICAL_MAKE','VEHICAL_MODEL','Vehicle_Sub_Model',
    'FUELTYPE','VEHICAL_FUELTYPE','RTO_Code','CC','SEATING_CAPACITY',
    'GROSS_VEHICLE_WEIGHT','Tonnes','AGE_OF_VEHICLE','DATE_OF_REGISTRATION',
    'VEHICLE_REGISTRATION_NO','VEHICLE_IDV',
    'BASE_OD_PREMIUM','NET_OD_PREMIUM','NET_LIABILITY_PREMIUM',
    'PREMIUM_WITHOUT_GST','ADD_ON_PREMIUM',
    'ANNUAL_PREMIUM','NCB','OD_DISCOUNT',
    'BUSINESS_TYPE_ID','SubmissionDate','City','BooKedLocation',
    // Agent/POS fields used by the Payout Summary screen.
    // UPIN_CODE is the POS code — joined in-memory to beeinsured_v3_2.tmp_poscodes
    // (live server) for posfullname since the tables live on different servers.
    'UPIN_CODE','EmployeeCode','CREATED_BY','rm_Name',
    // Policy life-cycle flag — used by the UI to filter bounced / cancelled
    // / endorsed policies.
    'FinalStatusName',
  ].join(', ');
  const rowsResult = await req2.query(
    `SELECT TOP (@take + @skip) ${PROJECT} FROM tmp_PrarambhData
     ${whereSql}
     ORDER BY SubmissionDate DESC, PolicyNo`
  );
  if (skip > 0) rowsResult.recordset = rowsResult.recordset.slice(skip);
  const totalCount = rowsResult.recordset.length + skip;

  // Remap tmp_PrarambhData's snake_case/underscore columns to the view's
  // original names so extractPolicyParams (shared with single-policy lookup)
  // keeps working unchanged.
  const remapRow = (r) => ({
    ...r,
    'POLICY NO':                r.PolicyNo,
    'TRACKER NO':               r.TrackerNo,
    'INSURER NAME':             r.INSURERNAME,
    'ShortName':                r.INSURERNAME,
    'PRODUCT TYPE':             r.ProductTypeName,
    'PolicyType':               r.ProductTypeName,
    // Vehicle class — try the legacy column first, fall back to VEHICAL_TYPE_Id
    // which carries the post-rebuild value ("Two Wheeler", "Pvt.Car",
    // "Commercial-Goods Carrying", "Commercial-Passenger Carrying",
    // "Miscellaneous"). filterRulesByPolicy treats these as the broad class.
    'MOTOR VEHICAL TYPE':       r.VehicleType || r.VEHICAL_TYPE_Id,
    'VEHICAL TYPE':             r.VehicleType || r.VEHICAL_TYPE_Id,
    'VehicleType':              r.VehicleType || r.VEHICAL_TYPE_Id,
    'VEHICLE TYPE':             r.VehicleType || r.VEHICAL_TYPE_Id,
    'VEHICLE CLASS':            r.VehicleType || r.VEHICAL_TYPE_Id,
    // Sub-category — drives bike/scooter/SUV/compact-car discrimination.
    // VehicalCategory_Updated holds "MOTOR_CYCLE", "SCOOTER", "COMPACT_CARS",
    // etc. The matchers in policy.js already accept MOTOR[\s_]*CYCLE so
    // "MOTOR_CYCLE" → bike works without further normalization.
    'VehicalCategory':          r.VehicalCategoryname || r.VehicalCategory_Updated,
    'VEHICLE CATEGORY':         r.VehicalCategoryname || r.VehicalCategory_Updated,
    'VEHICAL CATEGORY':         r.VehicalCategoryname || r.VehicalCategory_Updated,
    'VEHICAL MAKE':             r.VEHICAL_MAKE,
    'VEHICAL MODEL':            r.VEHICAL_MODEL,
    'VEHICAL SUBMODAL':         r.Vehicle_Sub_Model,
    'FUEL TYPE':                r.FUELTYPE || r.VEHICAL_FUELTYPE,
    'FuelType':                 r.FUELTYPE || r.VEHICAL_FUELTYPE,
    // RTO — prefer the explicit RTO_Code, fall back to the first 4 chars of
    // the registration number (e.g. "MH47AC3924" → "MH47"). ~98% of tmp_Prarambh
    // rows have RTO_Code blank but VEHICLE_REGISTRATION_NO populated.
    'Code':                     r.RTO_Code || r.VEHICLE_REGISTRATION_NO,
    'RTO':                      r.RTO_Code || r.VEHICLE_REGISTRATION_NO,
    'RTO CODE':                 r.RTO_Code || r.VEHICLE_REGISTRATION_NO,
    // City — used by the bulk's state/city fallback when RTO mapping
    // doesn't resolve a region/cluster. tmp_PrarambhData has no StateName.
    'CLIENT CITY NAME':         r.City,
    'VEHICLE CITY':             r.City,
    // Booking location — branch where the policy was booked. Used as the
    // ICICI last-resort region fallback (their rate cards bucket many rules
    // by booking-branch city like "JANAK PURI", "MUMBAI ANDHERI", etc.).
    'BusinessBookedLocation':   r.BooKedLocation,
    'BUSINESS BOOKED LOCATION': r.BooKedLocation,
    'CC':                       r.CC,
    'SEATING CAPACITY':         r.SEATING_CAPACITY,
    'GROSS VEHICLE WEIGHT':     r.GROSS_VEHICLE_WEIGHT,
    'TONNAGE':                  r.Tonnes,
    'AGE OF VEHICLE':           r.AGE_OF_VEHICLE,
    'DATE OF REGISTRATION':     r.DATE_OF_REGISTRATION,
    'VEHICLE REGISTRATION NO':  r.VEHICLE_REGISTRATION_NO,
    'VEHICLE IDV':              r.VEHICLE_IDV,
    'IDV':                      r.VEHICLE_IDV,
    'BASE OD PREMIUM':          r.BASE_OD_PREMIUM,
    'MOTOR NET OD PREMIUM':     r.NET_OD_PREMIUM,
    'NET OD PREMIUM':           r.NET_OD_PREMIUM,
    'LIABILITY PREMIUM':        r.NET_LIABILITY_PREMIUM,
    'TP PREMIUM':               r.NET_LIABILITY_PREMIUM,
    'PREMIUM WITHOUT GST':      r.PREMIUM_WITHOUT_GST,
    'NET PREMIUM':              r.PREMIUM_WITHOUT_GST,
    'ADD ON PREMIUM':           r.ADD_ON_PREMIUM,
    'ADDON PREMIUM':            r.ADD_ON_PREMIUM,
    'ANNUAL PREMIUM':           r.ANNUAL_PREMIUM,
    'MOTOR ANNUAL PREMIUM':     r.ANNUAL_PREMIUM,
    'NCB':                      r.NCB,
    'PREVIOUS NCB':             r.NCB,
    'OD DISCOUNT':              r.OD_DISCOUNT,
    'BUSINESS TYPE':            r.BUSINESS_TYPE_ID,
    'REPORTED BUSINESS TYPE':   r.BUSINESS_TYPE_ID, // ID, not name — best available
    // Agent / POS — UPIN_CODE is authoritative POS code, joined to posfullname
    // from beeinsured_v3_2.tmp_poscodes in-memory (agent_name stitched in below).
    '_agent_code':              r.UPIN_CODE || r.EmployeeCode || null,
    '_agent_name':              r.CREATED_BY || null, // overridden by posMap below
    '_agent_commission':        null,
    '_rm_name':                 r.rm_Name || null,
    // Source-system status flag (Active / Cancelled / Bounced / Endorsement…).
    '_final_status':            r.FinalStatusName || null,
  });
  rowsResult.recordset = rowsResult.recordset.map(remapRow);

  // ── TRN backfill ─────────────────────────────────────────────────────
  // tmp_PrarambhData often has VehicleCategory / Make / Model / FuelType
  // blank for direct-broker policies (MT/DIRSW/...).  beeinsured_v3_2.
  // dbo.TRN_MotorTransactionForPrarambh carries the same data keyed by
  // Trackerno — fetch in one batched query and fill in any blanks.
  try {
    const trackerList = rowsResult.recordset
      .map(r => String(r['TRACKER NO'] || '').trim())
      .filter(Boolean);
    if (trackerList.length > 0) {
      const beePool = await getBeeinsuredPool();
      // Chunk to keep parameter count under SQL's 2100-param limit.
      const CHUNK = 1000;
      const trnByTracker = new Map();
      for (let off = 0; off < trackerList.length; off += CHUNK) {
        const slice = trackerList.slice(off, off + CHUNK);
        const trnReq = beePool.request();
        const placeholders = slice.map((tn, i) => {
          trnReq.input('tn' + i, sql.NVarChar(200), tn);
          return '@tn' + i;
        });
        const trnRes = await trnReq.query(
          `SELECT PTrackerno, Category, Make, Model, FuelType, VehicleSegment
           FROM dbo.TRN_MotorTransactionForPrarambh
           WHERE PTrackerno IN (${placeholders.join(',')})`
        );
        for (const row of trnRes.recordset) {
          trnByTracker.set(String(row.PTrackerno || '').trim(), row);
        }
      }
      // Backfill — only fill fields that are blank/null in tmp_PrarambhData.
      for (const r of rowsResult.recordset) {
        const tn = String(r['TRACKER NO'] || '').trim();
        if (!tn) continue;
        const t = trnByTracker.get(tn);
        if (!t) continue;
        const blank = (v) => v == null || String(v).trim() === '';
        // VehicleCategory — feeds inferVehicleCategory and the policy filter.
        // When the TRN row carries a more specific VehicleSegment ("MOTOR_CYCLE",
        // "SCOOTER"), use that as the canonical category so filterRulesByPolicy
        // can disambiguate Bike vs Scooter (the existing regex matches
        // "MOTORCYCLE" / "BIKE" / "SCOOTER").  Falls back to plain Category
        // when VehicleSegment is generic / missing.
        const segNorm = String(t.VehicleSegment || '').trim().toUpperCase();
        let categoryToFill = t.Category;
        if (/MOTOR[\s_]*CYCLE|^MC$|BIKE/.test(segNorm)) categoryToFill = 'Motorcycle';
        else if (/SCOOTER|^SC$/.test(segNorm))           categoryToFill = 'Scooter';
        // Generic source category like "Two Wheeler" loses the existing value
        // when we have a more specific TRN segment — overwrite it.
        const isGenericSource = /^two\s*wheeler$|^2w$|^four\s*wheeler$|^4w$/i
                                  .test(String(r.VehicalCategoryname || '').trim());
        if ((blank(r.VehicalCategoryname) || isGenericSource) && !blank(categoryToFill)) {
          r.VehicalCategoryname = categoryToFill;
          r['VehicalCategory']  = categoryToFill;
          r['VEHICLE CATEGORY'] = categoryToFill;
          r['VEHICAL CATEGORY'] = categoryToFill;
        }
        if (blank(r.VEHICAL_MAKE) && !blank(t.Make)) {
          r.VEHICAL_MAKE = t.Make;
          r['VEHICAL MAKE'] = t.Make;
        }
        if (blank(r.VEHICAL_MODEL) && !blank(t.Model)) {
          r.VEHICAL_MODEL = t.Model;
          r['VEHICAL MODEL'] = t.Model;
        }
        if (blank(r.FUELTYPE) && blank(r.VEHICAL_FUELTYPE) && !blank(t.FuelType)) {
          r.FUELTYPE = t.FuelType;
          r['FUEL TYPE'] = t.FuelType;
          r['FuelType']  = t.FuelType;
        }
        // VehicleSegment ↔ tmp_PrarambhData has no equivalent column;
        // surface for diagnostics under SEGMENT.
        if (blank(r['SEGMENT']) && !blank(t.VehicleSegment)) {
          r['SEGMENT'] = t.VehicleSegment;
          r['Segment'] = t.VehicleSegment;
        }
      }
    }
  } catch (err) {
    // Don't fail the whole calc on TRN issues — log and continue.
    console.warn('[bulk] TRN backfill skipped:', err.message);
  }

  // ── Prarambh_Live.tmp_motordata backfill ────────────────────────────
  // tmp_motordata is a richer mirror of Prarambh's view layer with 201
  // columns named exactly as extractPolicyParams expects ("PRODUCT TYPE",
  // "VEHICAL MAKE", "City Name", etc.).  Use it to fill anything blank in
  // tmp_PrarambhData — most importantly PRODUCT TYPE which controls the
  // Comp/SAOD/TP filter in filterRulesByPolicy.
  try {
    const trackerList2 = rowsResult.recordset
      .map(r => String(r['TRACKER NO'] || r.TrackerNo || '').trim())
      .filter(Boolean);
    if (trackerList2.length > 0) {
      const livePool = await getPrarambhPool();
      const CHUNK = 1000;
      // Project the fields we know feed extractPolicyParams or downstream
      // filters — keeps the result set lean (full SELECT * has 201 cols).
      // Column list strictly limited to fields confirmed to exist in
      // tmp_motordata (probed via INFORMATION_SCHEMA).  Any typo here
      // would error the whole SELECT and skip the backfill — leaving
      // PRODUCT TYPE empty and dropping rule matches.
      const SELECT_COLS = [
        '[TRACKER NO]','[POLICY NO]','[PRODUCT TYPE]','[POLICY TENURE]',
        '[MOTOR VEHICAL TYPE]','[VEHICAL MAKE]','[VEHICAL MODEL]',
        '[VEHICAL SUBMODAL]','[FUEL TYPE]','[VEHICLE REGISTRATION NO]',
        '[City Name]','[CityName]','[StateName]','[AGE OF VEHICLE]',
        '[SEATING CAPACITY]','[CC]','[BASE OD PREMIUM]','[MOTOR NET OD PREMIUM]',
        '[LIABILITY PREMIUM]','[PREMIUM WITHOUT GST]','[ADD ON PREMIUM]',
        '[MOTOR ANNUAL PREMIUM]','[NCB]','[OD DISCOUNT]',
        '[VEHICLE IDV]','[REPORTED BUSINESS TYPE]','[VehicalCategory]',
      ].join(', ');
      const mdByTracker = new Map();
      for (let off = 0; off < trackerList2.length; off += CHUNK) {
        const slice = trackerList2.slice(off, off + CHUNK);
        const mdReq = livePool.request();
        const placeholders = slice.map((tn, i) => {
          mdReq.input('mtn' + i, sql.NVarChar(200), tn);
          return '@mtn' + i;
        });
        const mdRes = await mdReq.query(
          `SELECT ${SELECT_COLS}
           FROM dbo.tmp_motordata
           WHERE [TRACKER NO] IN (${placeholders.join(',')})`
        );
        for (const row of mdRes.recordset) {
          mdByTracker.set(String(row['TRACKER NO'] || '').trim(), row);
        }
      }
      const blank = (v) => v == null || String(v).trim() === '';
      // Field-by-field backfill — only fill when tmp_PrarambhData blank.
      // Keys on the LEFT are the row keys downstream code reads (matching
      // the remap output / extractPolicyParams expectations).  Sources are
      // tmp_motordata column names.
      const FIELDS = [
        // [target keys (array — all get set), source key]
        [['PRODUCT TYPE', 'PolicyType'],                       'PRODUCT TYPE'],
        [['POLICY TENURE'],                                    'POLICY TENURE'],
        [['MOTOR VEHICAL TYPE','VEHICAL TYPE','VEHICLE TYPE',
          'VehicleType','VEHICLE CLASS'],                      'MOTOR VEHICAL TYPE'],
        [['VEHICAL MAKE'],                                     'VEHICAL MAKE'],
        [['VEHICAL MODEL'],                                    'VEHICAL MODEL'],
        [['VEHICAL SUBMODAL'],                                 'VEHICAL SUBMODAL'],
        [['FUEL TYPE','FuelType'],                             'FUEL TYPE'],
        [['VEHICLE REGISTRATION NO'],                          'VEHICLE REGISTRATION NO'],
        [['CITY','CITY NAME','VEHICLE CITY','City Name'],      'City Name'],
        [['STATE','STATE NAME'],                               'StateName'],
        [['AGE OF VEHICLE'],                                   'AGE OF VEHICLE'],
        [['SEATING CAPACITY'],                                 'SEATING CAPACITY'],
        [['CC'],                                               'CC'],
        [['BASE OD PREMIUM'],                                  'BASE OD PREMIUM'],
        [['MOTOR NET OD PREMIUM','NET OD PREMIUM'],            'MOTOR NET OD PREMIUM'],
        [['LIABILITY PREMIUM','TP PREMIUM'],                   'LIABILITY PREMIUM'],
        [['PREMIUM WITHOUT GST','NET PREMIUM'],                'PREMIUM WITHOUT GST'],
        [['ADD ON PREMIUM','ADDON PREMIUM'],                   'ADD ON PREMIUM'],
        [['MOTOR ANNUAL PREMIUM','ANNUAL PREMIUM'],            'MOTOR ANNUAL PREMIUM'],
        [['NCB','PREVIOUS NCB'],                               'NCB'],
        [['OD DISCOUNT'],                                      'OD DISCOUNT'],
        [['BUSINESS TYPE','REPORTED BUSINESS TYPE'],           'REPORTED BUSINESS TYPE'],
        [['VEHICLE IDV','IDV'],                                'VEHICLE IDV'],
        [['VehicalCategory','VEHICLE CATEGORY','VEHICAL CATEGORY'], 'VehicalCategory'],
      ];
      let backfilledRows = 0;
      for (const r of rowsResult.recordset) {
        const tn = String(r['TRACKER NO'] || r.TrackerNo || '').trim();
        if (!tn) continue;
        const md = mdByTracker.get(tn);
        if (!md) continue;
        let touched = false;
        for (const [targets, src] of FIELDS) {
          const srcVal = md[src];
          if (blank(srcVal)) continue;
          for (const tk of targets) {
            if (blank(r[tk])) { r[tk] = srcVal; touched = true; }
          }
        }
        if (touched) backfilledRows++;
      }
      if (backfilledRows > 0) {
        console.log(`[bulk] tmp_motordata backfill filled fields on ${backfilledRows} rows`);
      }
    }
  } catch (err) {
    console.warn('[bulk] tmp_motordata backfill skipped:', err.message);
  }
  // ─────────────────────────────────────────────────────────────────────

  const marginRules = await loadMarginRules(pool);
  // Agent-specific margin overrides keyed by UPIN. Empty Map when no
  // special_rate_rules exist; lookups are O(1) per policy.
  const specialRulesByAgent = await loadSpecialRulesByAgent(pool);
  // Per-agent global uplift map — fallback when no per-row override hits.
  const globalUpliftByAgent = await loadGlobalUpliftsByAgent(pool);
  // Statement index — policy_no → amount (+ period) from active uploads.
  const statementIndex = await loadStatementIndex(pool);
  // Premium Register index — policy_no → PR amounts from active pr_rows.
  const prIndex = await loadPrIndex(pool);
  // POS maps — primary: tmp_poscodes (UPIN → POS), fallback: TMP_MAAGENT
  // (MA-code → branch agent) for codes not present in tmp_poscodes.
  const [posMap, maagentMap] = await Promise.all([loadPosMap(), loadMaagentMap()]);

  // Enrich each remapped row with agent_name. Source precedence:
  //   1) tmp_poscodes match        → _agent_pos_source = 'pos'
  //   2) TMP_MAAGENT fallback      → _agent_pos_source = 'maagent'
  //   3) no match                  → _agent_pos_matched = false
  for (const r of rowsResult.recordset) {
    const code = String(r._agent_code || '').trim().toUpperCase();
    if (code && posMap.has(code)) {
      const m = posMap.get(code);
      r._agent_name = m.agent_name || r._agent_name;
      r._agent_pos_status = m.status;
      r._agent_pos_matched = true;
      r._agent_pos_source  = 'pos';
    } else if (code && maagentMap.has(code)) {
      const m = maagentMap.get(code);
      r._agent_name = m.agent_name || r._agent_name;
      r._agent_pos_status = m.status;            // e.g. "Approved"
      r._agent_pos_matched = true;
      r._agent_pos_source  = 'maagent';
      // Surface RM / location / zone if not already populated from Prarambh view.
      if (!r.RMName && m.parent_rm) r._rm_name = m.parent_rm;
      r._agent_location = m.location;
      r._agent_zone     = m.zone;
    } else {
      r._agent_pos_matched = false;
      r._agent_pos_source  = null;
    }
  }

  const out = [];
  const totals = {
    income: 0, savings: 0, outgoing: 0, statement_amount: 0,
    matched_rules: 0, matched_margins: 0, matched_statements: 0,
    status_ok: 0, status_ex: 0, status_scr: 0, status_cnr: 0,
    // Premium Register totals (summed across matched rows)
    pr_matched_count: 0, pr_net_total: 0, pr_gross_total: 0,
    pr_od_total: 0, pr_tp_total: 0,
  };
  // Per-run caches — cleared after the batch finishes. RTOs and rate-lookup
  // parameter tuples repeat heavily across policies from the same insurer,
  // so this typically eliminates 90%+ of the per-row DB calls.
  const caches = { rto: new Map(), lookup: new Map() };

  const CONCURRENCY = 10;
  const allRows = rowsResult.recordset;
  for (let i = 0; i < allRows.length; i += CONCURRENCY) {
    const chunk = allRows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(policy => processOnePolicy(pool, policy, marginRules, caches, statementIndex, prIndex, specialRulesByAgent, globalUpliftByAgent).catch(err => {
        // Even on pipeline error, surface the source fields the user
        // typically reconciles by — tracker_no, submission_date, agent —
        // so the row in CSV/UI isn't a near-empty stub.
        let _sd = policy.SubmissionDate;
        if (_sd instanceof Date && !isNaN(_sd)) _sd = _sd.toISOString().slice(0, 10);
        return {
          policy_no:       policy.PolicyNo,
          tracker_no:      policy.TrackerNo || null,
          submission_date: _sd || null,
          insurer:         policy.INSURERNAME,
          agent_code:      policy.UPIN_CODE || policy.EmployeeCode || null,
          agent_name:      policy.AssignedToName || policy.CreatedUserName || null,
          income: 0, savings: 0, outgoing: 0,
          note: 'Error: ' + (err && err.message || err),
        };
      }))
    );
    for (const row of results) {
      out.push(row);
      totals.income   += row.income || 0;
      totals.savings  += row.savings || 0;
      totals.outgoing += row.outgoing || 0;
      if (row.matched_rule_id) totals.matched_rules++;
      if (row.margin_id)       totals.matched_margins++;
      if (row.statement_amount != null) {
        totals.statement_amount += row.statement_amount;
        totals.matched_statements++;
      }
      // Reconciliation status bucket counts
      switch (row.status) {
        case 'OK':  totals.status_ok++;  break;
        case 'EX':  totals.status_ex++;  break;
        case 'SCR': totals.status_scr++; break;
        case 'CNR': totals.status_cnr++; break;
      }
      if (row.pr_matched) {
        totals.pr_matched_count++;
        totals.pr_net_total   += row.pr_net_amount   || 0;
        totals.pr_gross_total += row.pr_gross_amount || 0;
        totals.pr_od_total    += row.pr_od_premium   || 0;
        totals.pr_tp_total    += row.pr_tp_premium   || 0;
      }
    }
  }
  totals.statement_amount = +totals.statement_amount.toFixed(2);
  totals.pr_net_total   = +totals.pr_net_total.toFixed(2);
  totals.pr_gross_total = +totals.pr_gross_total.toFixed(2);
  totals.pr_od_total    = +totals.pr_od_total.toFixed(2);
  totals.pr_tp_total    = +totals.pr_tp_total.toFixed(2);
  totals.income   = +totals.income.toFixed(2);
  totals.savings  = +totals.savings.toFixed(2);
  totals.outgoing = +totals.outgoing.toFixed(2);

  // Permanent exclusions — drop any policy whose PolicyNo OR TrackerNo is
  // registered in excluded_policies. Applied AFTER the per-row processing so
  // diagnostics (counts) reflect the full source set, but totals only include
  // what actually flows into payout.
  try {
    const exc = await pool.request().query('SELECT policy_no FROM excluded_policies');
    const excluded = new Set(exc.recordset.map(r => String(r.policy_no).trim().toUpperCase()));
    if (excluded.size > 0) {
      const keep = out.filter(r => {
        const pn = String(r.policy_no || '').trim().toUpperCase();
        const tn = String(r.tracker_no || '').trim().toUpperCase();
        return !excluded.has(pn) && !excluded.has(tn);
      });
      const dropped = out.length - keep.length;
      if (dropped > 0) {
        console.log(`[bulk] permanently excluded ${dropped} row(s)`);
        // Re-roll totals from the kept list so summaries don't count dropped policies.
        const totals2 = {
          income: 0, savings: 0, outgoing: 0, statement_amount: 0,
          matched_rules: 0, matched_margins: 0, matched_statements: 0,
          status_ok: 0, status_ex: 0, status_scr: 0, status_cnr: 0,
          pr_matched_count: 0, pr_net_total: 0, pr_gross_total: 0, pr_od_total: 0, pr_tp_total: 0,
        };
        for (const r of keep) {
          totals2.income += Number(r.income||0);  totals2.savings += Number(r.savings||0);
          totals2.outgoing += Number(r.outgoing||0);
          if (r.statement_amount != null) { totals2.statement_amount += Number(r.statement_amount||0); totals2.matched_statements++; }
          if (r.matched_rule_id) totals2.matched_rules++;
          if (r.margin_id)       totals2.matched_margins++;
          if (r.pr_matched) {
            totals2.pr_matched_count++;
            totals2.pr_net_total   += Number(r.pr_net_amount||0);
            totals2.pr_gross_total += Number(r.pr_gross_amount||0);
            totals2.pr_od_total    += Number(r.pr_od_premium||0);
            totals2.pr_tp_total    += Number(r.pr_tp_premium||0);
          }
          switch (r.status) { case 'OK':totals2.status_ok++;break;case 'EX':totals2.status_ex++;break;case 'SCR':totals2.status_scr++;break;case 'CNR':totals2.status_cnr++;break; }
        }
        for (const k of Object.keys(totals2)) if (typeof totals2[k] === 'number') totals2[k] = +totals2[k].toFixed(2);
        return { totals: totals2, rows: keep, processed: keep.length, total_count: totalCount, limit: cap, offset: skip, permanently_excluded: dropped };
      }
    }
  } catch (e) { console.error('[bulk] permanent-exclude filter skipped:', e.message); }

  return {
    totals, rows: out, processed: out.length,
    total_count: totalCount, limit: cap, offset: skip,
  };
}

/** POST /calculate — run the bulk calculation and return rows + totals. */
router.post('/calculate', async (req, res, next) => {
  try {
    const result = await runBulkCalculate(req.body);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

/** POST /calculate.csv — same inputs as /calculate, but returns a CSV stream. */
router.post('/calculate.csv', async (req, res, next) => {
  try {
    const data = await runBulkCalculate(req.body);

    const cols = ['policy_no','tracker_no','insurer','vehicle_type','make','model','rto_code','region',
                  'od_premium','tp_premium','net_premium','premium_base',
                  'matched_rule_id','matched_sheet','matched_segment','matched_rate_type',
                  'rate_pct','margin_id','margin_pct',
                  'special_rate_source','special_rate_id','global_uplift_pct','effective_margin_pct',
                  'income','savings','outgoing',
                  'statement_period','statement_upload_id','statement_amount',
                  'pr_period','pr_upload_id','pr_od_premium','pr_addon_premium',
                  'pr_tp_premium','pr_net_amount','pr_gross_amount',
                  'status','status_variance','note'];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = cols.join(',');
    const lines = data.rows.map(r => cols.map(c => esc(r[c])).join(','));
    const csv = [header, ...lines].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bulk_commission.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

/** GET /debug-bulk-policy/:tracker — run the full bulk pipeline for one
 *  policy and report what happened.  Used to diagnose the bulk vs policy-
 *  lookup divergence (e.g. SATP_MAX_CD2 matched in policy lookup but
 *  bulk says "No matching rule"). */
router.get('/debug-bulk-policy/:tracker', async (req, res, next) => {
  try {
    const tn = String(req.params.tracker || '').trim();
    const prarambhPool = await getPrarambhUatPool();
    const pool = await getPool();
    const r = await prarambhPool.request().input('tn', sql.NVarChar(200), tn)
      .query(`SELECT TOP 1 * FROM tmp_PrarambhData
              WHERE PolicyNo = @tn OR TrackerNo = @tn`);
    if (r.recordset.length === 0) return res.json({ success: false, error: 'no policy' });
    const raw = r.recordset[0];
    const remap = {
      ...raw,
      'POLICY NO': raw.PolicyNo, 'TRACKER NO': raw.TrackerNo,
      'INSURER NAME': raw.INSURERNAME, 'ShortName': raw.INSURERNAME,
      'PRODUCT TYPE': raw.ProductTypeName, 'PolicyType': raw.ProductTypeName,
      'MOTOR VEHICAL TYPE': raw.VehicleType, 'VEHICAL TYPE': raw.VehicleType,
      'VEHICLE TYPE': raw.VehicleType, 'VehicleType': raw.VehicleType,
      'VehicalCategory': raw.VehicalCategoryname,
      'VEHICAL MAKE': raw.VEHICAL_MAKE, 'VEHICAL MODEL': raw.VEHICAL_MODEL,
      'FUEL TYPE': raw.FUELTYPE || raw.VEHICAL_FUELTYPE,
      'FuelType': raw.FUELTYPE || raw.VEHICAL_FUELTYPE,
      'Code': raw.RTO_Code || raw.VEHICLE_REGISTRATION_NO,
      'RTO': raw.RTO_Code || raw.VEHICLE_REGISTRATION_NO,
      'STATE': raw.StateName, 'STATE NAME': raw.StateName,
      'AGE OF VEHICLE': raw.AGE_OF_VEHICLE,
      'BASE OD PREMIUM': raw.BASE_OD_PREMIUM,
      'NET OD PREMIUM': raw.NET_OD_PREMIUM,
      'TP PREMIUM': raw.LIABILITY_PREMIUM || raw.NET_LIABILITY_PREMIUM,
      'NET PREMIUM': raw.PREMIUM_WITHOUT_GST,
      'PREMIUM WITHOUT GST': raw.PREMIUM_WITHOUT_GST,
    };
    const policyMod = require('./policy');
    const params = policyMod.extractPolicyParams(remap);
    const insurerSlug = policyMod.resolveInsurerSlug(params.insurerName);
    params._insurer_slug = insurerSlug;
    const productList = PRODUCT_ALIASES[String(params.vehicleType).toUpperCase()] || [params.vehicleType];
    const baseLookup = {
      insurer: insurerSlug, product: productList,
      region: '', cluster: '',
      vehicle_age: params.vehicleAge,
      fuel_type: params.vehicleType === 'TW' ? '' : (params.fuelType || ''),
      ins_product: params.insProduct || '',
    };
    const { lookupRates, resolveRTO } = require('../services/rate-lookup');
    const rtoInfo = await resolveRTO(pool, insurerSlug, params.vehicleType, params.rtoCode).catch(() => null);
    const lookupArgs = { ...baseLookup,
      region:  (rtoInfo && rtoInfo.region)  || '',
      cluster: (rtoInfo && rtoInfo.cluster) || '' };
    const rules = await lookupRates(pool, lookupArgs);
    const _trace = [];
    const filtered = rules.length > 0 ? policyMod.filterRulesByPolicy(rules, params, _trace) : [];
    res.json({
      success: true,
      params: {
        insurer: params.insurerName, slug: insurerSlug,
        vehicleType: params.vehicleType, insProduct: params.insProduct,
        vehicleAge: params.vehicleAge, rtoCode: params.rtoCode,
        fuelType: params.fuelType, make: params.make, model: params.model,
        vehicleCategory: params.vehicleCategory, vehicleClass: params.vehicleClass,
        businessType: params.businessType, ncbPct: params.ncbPct,
        isHighEnd: params.isHighEnd,
      },
      rto_info: rtoInfo,
      lookup_args: lookupArgs,
      sql_rules_count: rules.length,
      sql_rules: rules.slice(0, 10).map(r => ({ rt: r.rate_type, seg: r.segment, age: r.vehicle_age_min + '-' + r.vehicle_age_max, make: r.make })),
      filtered_count: filtered.length,
      filtered: filtered.slice(0, 10).map(r => ({ rt: r.rate_type, seg: r.segment })),
    });
  } catch (err) { next(err); }
});

/** GET /debug-motordata/:pn — inspect Prarambh_Live.dbo.tmp_motordata. */
router.get('/debug-motordata/:pn', async (req, res, next) => {
  try {
    const pn = String(req.params.pn || '').trim();
    const livePool = await getPrarambhPool();
    const cols = await livePool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'tmp_motordata'
      ORDER BY ORDINAL_POSITION`);
    let rows = [];
    let err = null;
    try {
      const r = await livePool.request().input('pn', sql.NVarChar(200), pn)
        .query(`SELECT TOP 3 * FROM dbo.tmp_motordata
                WHERE PolicyNo = @pn OR TrackerNo = @pn OR currenttrackerno = @pn`);
      rows = r.recordset;
    } catch (e) { err = e.message; }
    res.json({ success: true, query: pn, row_count: rows.length, rows, err, columns: cols.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-trn/:tracker — inspect TRN_MotorTransactionForPrarambh row.
 *  TRN table lives on beeinsured_v3_2; used as fallback for missing fields
 *  (e.g. VehicleCategory) when tmp_PrarambhData has them blank. */
router.get('/debug-trn/:tracker', async (req, res, next) => {
  try {
    const tn = String(req.params.tracker || '').trim();
    const beeinsuredPool = await getBeeinsuredPool();
    // Probe to find the table — try a few candidate schemas / DB-qualified
    // names so the response carries diagnostic info if our default guess is
    // wrong.
    const probe = await beeinsuredPool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'TRN_MotorTransactionForPrarambh'
      ORDER BY ORDINAL_POSITION`);
    let rows = [];
    let err = null;
    try {
      const r = await beeinsuredPool.request()
        .input('tn', sql.NVarChar(200), tn)
        .query(`SELECT TOP 3 PTrackerno, Trackerno, Category, Make, Model,
                       FuelType, VehicleSegment, Insurer, PlanName
                FROM dbo.TRN_MotorTransactionForPrarambh
                WHERE PTrackerno = @tn`);
      rows = r.recordset;
    } catch (e) { err = e.message; }
    res.json({ success: true, tracker: tn, row_count: rows.length, rows, err, candidates: probe.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-filter — run lookupRates + filterRulesByPolicy and show drops. */
router.get('/debug-filter', async (req, res, next) => {
  try {
    const tn = String(req.query.tracker || '').trim();
    const prarambhPool = await getPrarambhUatPool();
    const livePool = await getPrarambhPool();
    const pool = await getPool();
    const r1 = await prarambhPool.request().input('tn', sql.NVarChar(200), tn)
      .query(`SELECT TOP 1 * FROM tmp_PrarambhData
              WHERE PolicyNo = @tn OR TrackerNo = @tn`);
    if (r1.recordset.length === 0) return res.json({ success: false, error: 'no policy' });
    const raw = r1.recordset[0];
    // Pull from tmp_motordata for backfill
    const r2 = await livePool.request().input('tn', sql.NVarChar(200), tn)
      .query(`SELECT TOP 1 * FROM dbo.tmp_motordata WHERE [TRACKER NO] = @tn`);
    const md = r2.recordset[0] || {};
    // Build remapped row including motordata backfill
    const remap = { ...raw,
      'POLICY NO': raw.PolicyNo, 'TRACKER NO': raw.TrackerNo,
      'INSURER NAME': raw.INSURERNAME,
      'PRODUCT TYPE': raw.ProductTypeName || md['PRODUCT TYPE'],
      'MOTOR VEHICAL TYPE': raw.VehicleType || md['MOTOR VEHICAL TYPE'],
      'VEHICAL TYPE': raw.VehicleType || md['MOTOR VEHICAL TYPE'],
      'VEHICLE TYPE': raw.VehicleType || md['MOTOR VEHICAL TYPE'],
      'VehicleType': raw.VehicleType || md['MOTOR VEHICAL TYPE'],
      'VehicalCategory': raw.VehicalCategoryname || md['VehicalCategory'],
      'VEHICAL MAKE': raw.VEHICAL_MAKE || md['VEHICAL MAKE'],
      'VEHICAL MODEL': raw.VEHICAL_MODEL || md['VEHICAL MODEL'],
      'FUEL TYPE': raw.FUELTYPE || md['FUEL TYPE'],
      'FuelType': raw.FUELTYPE || md['FUEL TYPE'],
      'Code': raw.RTO_Code || raw.VEHICLE_REGISTRATION_NO,
      'RTO': raw.RTO_Code || raw.VEHICLE_REGISTRATION_NO,
      'STATE': raw.StateName, 'STATE NAME': raw.StateName,
      'AGE OF VEHICLE': raw.AGE_OF_VEHICLE,
      'BASE OD PREMIUM': raw.BASE_OD_PREMIUM, 'NET OD PREMIUM': raw.NET_OD_PREMIUM,
      'TP PREMIUM': raw.LIABILITY_PREMIUM || raw.NET_LIABILITY_PREMIUM,
      'PREMIUM WITHOUT GST': raw.PREMIUM_WITHOUT_GST,
      'NET PREMIUM': raw.PREMIUM_WITHOUT_GST,
    };
    const policyMod = require('./policy');
    const params = policyMod.extractPolicyParams(remap);
    const insurerSlug = policyMod.resolveInsurerSlug(params.insurerName);
    params._stateName = remap['STATE NAME'] || raw.StateName || null;
    const productList = PRODUCT_ALIASES[String(params.vehicleType).toUpperCase()] || [params.vehicleType];
    const { lookupRates, resolveRTO } = require('../services/rate-lookup');
    const rtoInfo = await resolveRTO(pool, insurerSlug, params.vehicleType, params.rtoCode).catch(() => null);
    const args = {
      insurer: insurerSlug, product: productList,
      region: (rtoInfo && rtoInfo.region) || '',
      cluster: (rtoInfo && rtoInfo.cluster) || '',
      vehicle_age: params.vehicleAge,
      fuel_type: params.vehicleType === 'TW' ? '' : (params.fuelType || ''),
      ins_product: params.insProduct || '',
    };
    const rules = await lookupRates(pool, args);
    const _trace = [];
    const filtered = rules.length > 0 ? policyMod.filterRulesByPolicy(rules, params, _trace) : [];

    // Also: scan candidate scooter/MC rules in the SQL set so we can see
    // which non-CD1 rules were eliminated and why.
    const candidates = (rules || []).filter(r => {
      const rt = (r.rate_type || '').toUpperCase();
      return !rt.includes('CD1') && !rt.startsWith('FLEXI');
    });

    // Bucket failures: try filter and report which rules dropped + why
    const dropReasons = { tenure: 0, ncb: 0, product_mismatch: 0, business_type: 0,
                          make_bucket: 0, age_band: 0, segment_match: 0, tw_token: 0,
                          cc_seg: 0, seating: 0, tonnage: 0, weight_band: 0,
                          fuel_seg: 0, segment_make: 0, other: 0, };
    res.json({
      success: true,
      params: {
        insurer: insurerSlug, vehicleType: params.vehicleType,
        insProduct: params.insProduct, vehicleCategory: params.vehicleCategory,
        vehicleClass: params.vehicleClass, fuelType: params.fuelType,
        vehicleAge: params.vehicleAge, cc: params.cc, seating: params.seatingCapacity,
        tonnage: params.tonnage, make: params.make, model: params.model,
        ncbPct: params.ncbPct, businessType: params.businessType, isHighEnd: params.isHighEnd,
      },
      rto_info: rtoInfo, lookup_args: args, sql_count: rules.length,
      filtered_count: filtered.length,
      // Show first 8 rules that DROPPED + first 8 that survived
      sample_dropped: rules.filter(r => !filtered.includes(r)).slice(0, 8).map(r => ({
        rt: r.rate_type, seg: r.segment, age: r.vehicle_age_min+'-'+r.vehicle_age_max,
        seat: r.seating_capacity_min+'-'+r.seating_capacity_max,
        wt: r.weight_band_min+'-'+r.weight_band_max,
        cc: r.cc_band_min+'-'+r.cc_band_max,
        fuel: r.fuel_type, make: r.make, region: r.region,
      })),
      sample_kept: filtered.map(r => ({
        rt: r.rate_type, seg: r.segment, region: r.region, rate: r.rate_value,
      })),
      // Show ALL 1+1_MAX_CD2 / MC <= 180 candidates so we can see if
      // they were in the SQL set but dropped by the filter.
      _trace_total: _trace.length,
      stage_traces: _trace.filter(t => t.stage),
      one_plus_one_candidates: _trace.filter(t => !t.stage && /1\+1_MAX_CD2/.test(t.rt)).slice(0, 12),
      candidate_count: candidates.length,
      candidate_segments: [...new Set(candidates.map(r => r.rate_type + '|' + r.segment + '|' + r.region))].slice(0, 30),
    });
  } catch (err) { next(err); }
});

/** GET /debug-lookup — run lookupRates with explicit args. */
router.get('/debug-lookup', async (req, res, next) => {
  try {
    const { insurer, region, product, age, fuel, ins_product } = req.query;
    const pool = await getPool();
    const { lookupRates } = require('../services/rate-lookup');
    const args = {
      insurer,
      product: product ? product.split(',') : undefined,
      region: region || '',
      cluster: '',
      vehicle_age: age != null ? Number(age) : undefined,
      fuel_type: fuel || '',
      ins_product: ins_product || '',
    };
    const rules = await lookupRates(pool, args);
    res.json({
      success: true, args,
      count: rules.length,
      sample: rules.slice(0, 8).map(r => ({ rt: r.rate_type, seg: r.segment, age: r.vehicle_age_min+'-'+r.vehicle_age_max, fuel: r.fuel_type, region: r.region })),
    });
  } catch (err) { next(err); }
});

/** GET /debug-seg-regions — for a specific segment, list its regions. */
router.get('/debug-seg-regions', async (req, res, next) => {
  try {
    const { insurer, segment } = req.query;
    const pool = await getPool();
    const r = await pool.request()
      .input('ins', sql.NVarChar(100), insurer || '')
      .input('seg', sql.NVarChar(300), '%' + (segment||'') + '%')
      .query(`SELECT region, segment, fuel_type, vehicle_age_min, vehicle_age_max, rate_type, COUNT(*) AS n
              FROM rate_rules
              WHERE insurer = @ins AND segment LIKE @seg
              GROUP BY region, segment, fuel_type, vehicle_age_min, vehicle_age_max, rate_type
              ORDER BY region, segment, rate_type`);
    res.json({ success: true, rows: r.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-unmatched/:cycleId/:slug — list unmatched policies for an insurer. */
router.get('/debug-unmatched/:cycleId/:slug', async (req, res, next) => {
  try {
    const cycleId = Number(req.params.cycleId);
    const slug = String(req.params.slug || '').trim();
    const pool = await getPool();
    const r = await pool.request()
      .input('cid', sql.Int, cycleId)
      .input('slug', sql.NVarChar(100), slug)
      .query(`SELECT policy_no, tracker_no, insurer_slug, row_json
              FROM cycle_bulk_rows
              WHERE cycle_id = @cid AND insurer_slug = @slug
              ORDER BY policy_no`);
    const out = [];
    for (const row of r.recordset) {
      try {
        const j = JSON.parse(row.row_json || '{}');
        if (!j.matched_rule_id) {
          out.push({
            policy_no: row.policy_no,
            tracker_no: row.tracker_no,
            vehicle_type: j.vehicle_type, vehicle_category: j.vehicle_category,
            product: j.product, make: j.make, model: j.model,
            rto_code: j.rto_code, region: j.region, state: j.state,
            fuel: j.fuel_type, age: j.vehicle_age, seating: j.seating_capacity,
            tonnage: j.tonnage, cc: j.cc,
            note: j.note,
          });
        }
      } catch {}
    }
    res.json({ success: true, count: out.length, rows: out });
  } catch (err) { next(err); }
});

/** GET /debug-regions — distinct regions for an insurer. */
router.get('/debug-regions/:insurer', async (req, res, next) => {
  try {
    const ins = String(req.params.insurer || '').trim();
    const pool = await getPool();
    const r = await pool.request().input('ins', sql.NVarChar(100), ins)
      .query(`SELECT DISTINCT region FROM rate_rules WHERE insurer = @ins ORDER BY region`);
    res.json({ success: true, count: r.recordset.length, regions: r.recordset.map(x => x.region) });
  } catch (err) { next(err); }
});

/** GET /debug-rto/:rtoCode — show all RTO mappings for a code. */
router.get('/debug-rto/:rtoCode', async (req, res, next) => {
  try {
    const code = String(req.params.rtoCode || '').trim();
    const pool = await getPool();
    const r = await pool.request().input('c', sql.NVarChar(20), code)
      .query(`SELECT id, insurer, product, rto_code, region, cluster, rate_card_id
              FROM rto_mappings
              WHERE rto_code = @c
              ORDER BY insurer, product`);
    res.json({ success: true, count: r.recordset.length, rows: r.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-rule/:id — fetch a single rate_rules row. */
router.get('/debug-rule/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, id)
      .query(`SELECT * FROM rate_rules WHERE id = @id`);
    res.json({ success: true, rule: r.recordset[0] || null });
  } catch (err) { next(err); }
});

/** GET /debug-segments — distinct segments for an insurer/product. */
router.get('/debug-segments', async (req, res, next) => {
  try {
    const { insurer, product } = req.query;
    const pool = await getPool();
    const r = await pool.request()
      .input('ins', sql.NVarChar(100), insurer || '')
      .input('prod', sql.NVarChar(50), product || '')
      .query(`SELECT segment, region, COUNT(*) AS n
              FROM rate_rules
              WHERE insurer = @ins AND product LIKE @prod + '%'
              GROUP BY segment, region
              ORDER BY segment`);
    res.json({ success: true, rows: r.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-rules — dump rules for a given lookup. */
router.get('/debug-rules', async (req, res, next) => {
  try {
    const { insurer, region, product, ins_product } = req.query;
    const pool = await getPool();
    const r = await pool.request()
      .input('ins',  sql.NVarChar(100), insurer || '')
      .input('reg',  sql.NVarChar(200), region  || '')
      .input('prod', sql.NVarChar(50),  product || '')
      .query(`SELECT TOP 30 id, rate_type, segment, region, make, model,
                     fuel_type, vehicle_age_min, vehicle_age_max, seating_capacity_min,
                     seating_capacity_max, weight_band_min, weight_band_max,
                     cc_band_min, cc_band_max, sub_type, addon, carrier_type,
                     rate_value, remarks
              FROM rate_rules
              WHERE insurer = @ins
                AND (CHARINDEX('/' + @reg + '/', '/' + region + '/') > 0 OR region = @reg)
                AND product LIKE @prod + '%'`);
    res.json({ success: true, count: r.recordset.length, rules: r.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-pr-uploads — list pr_uploads with row counts. */
router.get('/debug-pr-uploads', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT u.id, u.insurer_slug, u.month, u.year, u.file_name, u.status,
              (SELECT COUNT(*) FROM pr_rows WHERE upload_id = u.id) AS row_count
       FROM pr_uploads u ORDER BY u.id DESC`
    );
    res.json({ success: true, uploads: r.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-pr/:pn — dump pr_rows entries containing a policy substring. */
router.get('/debug-pr/:pn', async (req, res, next) => {
  try {
    const pn = String(req.params.pn || '').trim();
    const pool = await getPool();
    const r = await pool.request()
      .input('pn',  sql.NVarChar(200), pn)
      .input('lk',  sql.NVarChar(200), '%' + pn + '%')
      .query(`SELECT TOP 10 pr.id, pr.upload_id, pr.insurer_slug, pr.policy_no,
                     LEN(pr.policy_no) AS policy_no_len,
                     pr.net_amount, u.month, u.year, u.status
              FROM pr_rows pr
              INNER JOIN pr_uploads u ON u.id = pr.upload_id
              WHERE pr.policy_no = @pn OR pr.policy_no LIKE @lk
              ORDER BY u.year DESC, u.month DESC`);
    res.json({ success: true, query: pn, row_count: r.recordset.length, rows: r.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-snapshot/:cycleId/:pn — dump the stored cycle row for a policy. */
router.get('/debug-snapshot/:cycleId/:pn', async (req, res, next) => {
  try {
    const cycleId = Number(req.params.cycleId);
    const pn = String(req.params.pn || '').trim();
    const pool = await getPool();
    const r = await pool.request()
      .input('cid', sql.Int, cycleId)
      .input('pn',  sql.NVarChar(200), pn)
      .query(`SELECT TOP 5 cycle_id, policy_no, tracker_no AS db_tracker_no, insurer_slug,
                     LEN(row_json) AS json_len, row_json
              FROM cycle_bulk_rows
              WHERE cycle_id = @cid AND (policy_no = @pn OR tracker_no = @pn)`);
    res.json({ success: true, cycleId, policy_no: pn, row_count: r.recordset.length, rows: r.recordset });
  } catch (err) { next(err); }
});

/** GET /debug-policy/:pn — diagnostic: dump a single tmp_PrarambhData row.
 *  Lets the user inspect what columns SQL is actually returning for a
 *  specific policy_no when something looks off in the bulk output. */
router.get('/debug-policy/:pn', async (req, res, next) => {
  try {
    const pn = String(req.params.pn || '').trim();
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const prarambhPool = await getPrarambhUatPool();
    const r = await prarambhPool.request()
      .input('pn', sql.NVarChar(200), pn)
      .query(`SELECT TOP 5 PolicyNo, TrackerNo, INSURERNAME, SubmissionDate, ProductTypeName,
                     UPIN_CODE, EmployeeCode, AssignedToName, FinalStatusName,
                     BASE_OD_PREMIUM, NET_OD_PREMIUM, LIABILITY_PREMIUM,
                     NET_LIABILITY_PREMIUM, PREMIUM_WITHOUT_GST, ADD_ON_PREMIUM,
                     Addon_Premium, ANNUAL_PREMIUM, ANNUALPREMIUM
              FROM tmp_PrarambhData
              WHERE PolicyNo = @pn OR TrackerNo = @pn`);
    res.json({ success: true, policy_no: pn, row_count: r.recordset.length, rows: r.recordset });
  } catch (err) { next(err); }
});

module.exports = router;
// Reusable bulk-calc internals for the Payout Summary route.
module.exports.runBulkCalculate = runBulkCalculate;
