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
const { lookupRates, resolveRTO, rtoProductFor } = require('../services/rate-lookup');
const { determinePremium } = require('../services/calculator');
const { reconcileParamsWithPR } = require('../services/pr-reconcile');
const policyRouter = require('./policy');

// Bajaj RTO-code → district-region map. Bajaj's rate_rules carry district-level
// region rows (e.g. "Bhavnagar" 0.375) that override the state row ("GUJARAT"
// 0.575), but rto_mappings resolves every RTO to its state. This map (built from
// the payout-grid "RTO mapping" sheet, normalized to the exact rate_rules region
// names) lets the engine reach the district row. Load is best-effort.
let BAJAJ_RTO_DISTRICT = {};
try { BAJAJ_RTO_DISTRICT = require('../config/bajaj_rto_district.json'); } catch (_) { BAJAJ_RTO_DISTRICT = {}; }

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
  shriramRtoDeclined,
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
  'MISC': ['MISC', 'MIS', 'CV', 'GCV'],
  'CV':  ['CV', 'GCV', 'PCV', 'MISC', 'MIS'],
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
            window_type, window_from, window_to, exclusions_json, apply_mode, rule_kind
     FROM special_rate_rules WHERE active = 1`
  );
  const idx = new Map();
  const safe = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
  for (const row of r.recordset) {
    const key = String(row.upincode || '').trim().toUpperCase();
    if (!key) continue;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({
      id: row.id,
      filters: safe(row.filters_json, {}),
      override_margin_pct: row.override_margin_pct == null ? null : Number(row.override_margin_pct),
      volume_tiers: safe(row.volume_tiers_json, null),
      window_type: row.window_type,
      window_from: row.window_from,
      window_to:   row.window_to,
      exclusions: safe(row.exclusions_json, []),
      apply_mode: row.apply_mode || 'per_policy',
      rule_kind: row.rule_kind || (row.volume_tiers_json ? 'volume_uplift' : 'scope_override'),
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
    `SELECT upincode, uplift_pct, product, insurer FROM agent_global_uplifts WHERE active = 1`
  );
  // Map<UPIN, [{ product, insurer, uplift }]> — an agent may hold a global
  // uplift (product/insurer null) plus per-product / per-product+insurer ones.
  const idx = new Map();
  for (const row of r.recordset) {
    const key = String(row.upincode || '').trim().toUpperCase();
    if (!key) continue;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({
      product: String(row.product || '').trim().toUpperCase() || null,
      insurer: String(row.insurer || '').trim().toLowerCase() || null,
      uplift: Number(row.uplift_pct) || 0,
    });
  }
  return idx;
}

// Map a policy vehicleType to the product family the uplift scope is keyed on.
function _upliftProductFamily(vt) {
  vt = String(vt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vt === 'CAR' || vt === '4W' || vt === 'PC' || vt === 'PVTCAR') return 'CAR';
  if (vt === 'TW' || vt === '2W' || vt === 'TWEV') return 'TW';
  if (vt === 'GCV') return 'GCV';
  if (vt === 'PCV') return 'PCV';
  if (vt === 'MISC' || vt === 'MIS') return 'MISC';
  return vt;
}

// Pick the most-specific matching uplift for a policy from the agent's list.
// Specificity: product+insurer > product > insurer > global (both null).
function _pickUplift(list, vt, insurerSlug) {
  if (!Array.isArray(list)) return 0;
  const fam = _upliftProductFamily(vt);
  const ins = String(insurerSlug || '').trim().toLowerCase();
  let best = null, bestScore = -1;
  for (const u of list) {
    const upFam = u.product ? _upliftProductFamily(u.product) : null;
    if (upFam && upFam !== fam) continue;             // product scope must match
    if (u.insurer && u.insurer !== ins) continue;     // insurer scope must match
    const score = (upFam ? 2 : 0) + (u.insurer ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = u; }
  }
  return best ? best.uplift : 0;
}

// ── Volume-based uplift ──────────────────────────────────────────────────────
// Does a row match a flexible condition (scope or exclusion)? `online` is
// handled here; everything else reuses the margin filter matcher.
function _vuMatch(ctx, cond, isOnline) {
  const c = { ...(cond || {}) };
  const wantsOnline = c.online === true;
  delete c.online;
  if (wantsOnline && !isOnline) return false;
  const hasOther = Object.keys(c).some(k => c[k] != null && c[k] !== '' && (!Array.isArray(c[k]) || c[k].length));
  if (hasOther && !policyMatchesMargin(ctx.params, ctx.rtoInfo, c)) return false;
  if (!hasOther && !wantsOnline) return false;   // empty condition matches nothing
  return true;
}

// Is a row within the rule's window? cycle/null = whole run; date_range =
// rule bounds; month = the row's date is in the current calendar month.
function _vuInWindow(ctx, rule) {
  const wt = String(rule.window_type || '').toLowerCase();
  if (!wt || wt === 'cycle') return true;
  const d = ctx.date ? new Date(ctx.date) : null;
  if (!d || isNaN(d)) return false;
  if (wt === 'date_range') {
    if (rule.window_from && d < new Date(rule.window_from)) return false;
    if (rule.window_to && d > new Date(rule.window_to)) return false;
    return true;
  }
  if (wt === 'month') {
    const now = new Date();
    return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
  }
  return true;
}

/**
 * Apply volume-based uplift rules across the computed rows (post-pass).
 *  - Accumulate each agent's qualifying NET premium per rule (scope match,
 *    not excluded, within window) → pick the tier → uplift %.
 *  - per_policy: add the uplift % to each qualifying row's outgoing.
 *  - overall:    one lump-sum (uplift% × accumulated) returned in the summary.
 * Mutates rows + `totals`; returns a summary array. Strips _vu from all rows.
 */
async function applyVolumeUplift(rows, specialRulesByAgent, totals) {
  const summary = [];
  try {
    // Gather active volume-uplift rules from the loaded special-rules map.
    const volRules = [];
    for (const [upin, list] of specialRulesByAgent.entries()) {
      for (const sr of list) {
        if (sr.rule_kind === 'volume_uplift' && Array.isArray(sr.volume_tiers) && sr.volume_tiers.length) {
          volRules.push({ upin, sr });
        }
      }
    }
    if (!volRules.length) return summary;

    // Load the online tracker set only if some rule references `online`.
    let onlineSet = null;
    const needsOnline = volRules.some(({ sr }) =>
      (sr.exclusions || []).some(c => c && c.online === true) ||
      (sr.filters && sr.filters.online === true));
    if (needsOnline) {
      try {
        const bee = await getBeeinsuredPool();
        const r = await bee.request().query(
          `SELECT DISTINCT PTrackerno FROM dbo.TRN_MotorTransactionForPrarambh WITH (NOLOCK)
           WHERE PTrackerno IS NOT NULL AND PTrackerno <> 'DUMMY'`);
        onlineSet = new Set(r.recordset.map(x => String(x.PTrackerno).trim().toUpperCase()));
      } catch (e) { console.error('[bulk] volume-uplift online set load failed:', e.message); onlineSet = new Set(); }
    }
    const isOnlineOf = (ctx) => onlineSet ? onlineSet.has(String(ctx.tracker || '').toUpperCase()) : false;

    // Index rows by agent for quick scoping.
    const byAgent = new Map();
    for (const row of rows) {
      if (!row._vu) continue;
      const a = row._vu.agent;
      if (!a) continue;
      if (!byAgent.has(a)) byAgent.set(a, []);
      byAgent.get(a).push(row);
    }

    const pickTier = (tiers, accum) => {
      const matches = tiers.filter(t =>
        (t.premium_min == null || accum >= t.premium_min) &&
        (t.premium_max == null || accum <= t.premium_max));
      // Highest applicable band (tiers are sorted ascending by min).
      return matches.length ? matches[matches.length - 1] : null;
    };

    for (const { upin, sr } of volRules) {
      const agentRows = byAgent.get(upin);
      if (!agentRows || !agentRows.length) continue;
      // Qualifying rows: scope match (empty scope = all) AND not excluded AND in window.
      const scopeKeys = Object.keys(sr.filters || {}).filter(k => k !== 'online');
      const qualifies = (row) => {
        const ctx = row._vu;
        const online = isOnlineOf(ctx);
        if (scopeKeys.length && !_vuMatch(ctx, sr.filters, online)) return false;
        if ((sr.exclusions || []).some(c => _vuMatch(ctx, c, online))) return false;
        if (!_vuInWindow(ctx, sr)) return false;
        return true;
      };
      const qualRows = agentRows.filter(qualifies);
      if (!qualRows.length) continue;
      const accum = qualRows.reduce((s, r) => s + (Number(r._vu.premiumBase) || 0), 0);
      const tier = pickTier(sr.volume_tiers, accum);
      const upliftPct = tier && tier.uplift_pct != null ? Number(tier.uplift_pct) : 0;
      if (!(upliftPct > 0)) continue;

      if (sr.apply_mode === 'overall') {
        const amount = +(upliftPct / 100 * accum).toFixed(2);
        totals.outgoing += amount;
        summary.push({ upincode: upin, special_rate_id: sr.id, apply_mode: 'overall',
          accumulated_premium: +accum.toFixed(2), uplift_pct: upliftPct, nop: qualRows.length, amount });
      } else {
        let delta = 0;
        for (const row of qualRows) {
          const pb = Number(row._vu.premiumBase) || 0;
          const add = +(upliftPct / 100 * pb).toFixed(2);
          row.outgoing = +((Number(row.outgoing) || 0) + add).toFixed(2);
          row.savings  = +((Number(row.savings)  || 0) - add).toFixed(2);
          row.outgoing_pct = +(((Number(row.outgoing_pct) || 0)) + upliftPct).toFixed(3);
          row.volume_uplift_pct = upliftPct;
          row.special_rate_source = 'volume_uplift';
          row.special_rate_id = sr.id;
          delta += add;
        }
        totals.outgoing += delta;
        totals.savings  -= delta;
        summary.push({ upincode: upin, special_rate_id: sr.id, apply_mode: 'per_policy',
          accumulated_premium: +accum.toFixed(2), uplift_pct: upliftPct, nop: qualRows.length, amount: +delta.toFixed(2) });
      }
    }
  } catch (e) {
    console.error('[bulk] applyVolumeUplift failed:', e.message);
  } finally {
    for (const row of rows) { if (row._vu) delete row._vu; }   // never persist the context
  }
  return summary;
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
            pr.net_amount, pr.gross_amount, pr.sum_insured, pr.ncb, pr.fuel_type, pr.cc,
            pr.tonnage, pr.seating, pr.product, pr.region, pr.raw_json, pr.final_discount,
            pr.upload_id, u.insurer_label, u.month, u.year
     FROM pr_rows pr
     INNER JOIN pr_uploads u ON u.id = pr.upload_id
     WHERE u.status = 'active'`
  );
  // Pull the OD-discount % from the PR raw row's FINALDISCOUNT column. Some
  // insurers (Royal) store it as a signed fraction (-0.85 = 85% discount);
  // others may already give a percent. Normalise to a positive percent.
  const parseFinalDiscount = (rawJson) => {
    if (!rawJson) return null;
    let obj; try { obj = JSON.parse(rawJson); } catch { return null; }
    if (!obj) return null;
    // Case-insensitive lookup of the FINALDISCOUNT header.
    let raw = null;
    for (const k of Object.keys(obj)) {
      if (String(k).replace(/[\s_]/g, '').toUpperCase() === 'FINALDISCOUNT') { raw = obj[k]; break; }
    }
    if (raw == null || raw === '') return null;
    let n = parseFloat(String(raw).replace(/[%,]/g, ''));
    if (!Number.isFinite(n)) return null;
    n = Math.abs(n);                 // -0.85 → 0.85
    if (n <= 1) n = n * 100;         // fraction → percent (0.85 → 85)
    return +n.toFixed(3);
  };
  // Pull the operator's own location fields off the PR raw row. Needed for
  // BH-series (Bharat-series) registrations like "23BH6834D": their RTO_Code
  // carries no state ("23BH"), the source City/StateName come through as the
  // placeholder "India", and our tracker-prefix RTO fallback fabricates a
  // wrong state (e.g. tracker "…/DL7/…" → DELHI). The PR file classifies the
  // vehicle for TP pricing in State_For_TP_ULR ("Rest Of Maharashtra") and
  // Key_City_Group, which is the authoritative region for these rows.
  const prField = (obj, ...names) => {
    if (!obj) return null;
    const want = names.map(n => n.replace(/[\s_]/g, '').toUpperCase());
    for (const k of Object.keys(obj)) {
      const nk = String(k).replace(/[\s_]/g, '').toUpperCase();
      if (want.includes(nk)) {
        const v = obj[k];
        if (v != null && String(v).trim() !== '' && String(v).trim() !== '-') return String(v).trim();
      }
    }
    return null;
  };
  for (const row of r.recordset) {
    let obj = null;
    if (row.raw_json) { try { obj = JSON.parse(row.raw_json); } catch { obj = null; } }
    // Prefer the dedicated final_discount column (captured at ingest, bulk-load
    // safe); fall back to parsing raw_json for older uploads that have it.
    row.final_discount = (row.final_discount != null)
      ? +Number(row.final_discount).toFixed(3)
      : parseFinalDiscount(row.raw_json);
    row.pr_state_tp  = prField(obj, 'State_For_TP_ULR');
    row.pr_key_city  = prField(obj, 'Key_City_Group');
    row.pr_city      = prField(obj, 'City', 'CityName', 'VEHICLE CITY');
    row.pr_state     = prField(obj, 'State', 'StateName', 'STATE NAME');
    // Policy/risk start (inception) date — authoritative fallback for the Bajaj
    // policy-start-date rate-card selection when tmp_PrarambhData.POLICY_START_DATE
    // is null/garbage. PR carries it as RISK_INC_DATE / OD_Start_Date.
    row.pr_start_date = prField(obj, 'RISK_INC_DATE', 'OD_Start_Date', 'od_start_date',
                                'POLICY_START_DATE', 'Risk_Inception_Date', 'RISK INCEPTION DATE');
    delete row.raw_json;             // keep index rows lean after extraction
  }
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
    // Precedence: most-recent upload (year, then month) wins. On a SAME-upload
    // tie (duplicate policy_no rows in one upload — e.g. an OD-leg line with a
    // blank/zero NCB beside the real PACKAGE line), prefer the row carrying a
    // non-zero NCB so reconcile doesn't clobber a valid source NCB with a stale
    // 0. (Tata 6206177570: upload 19 had ncb=0 AND ncb=20 rows; the 0 was
    // winning purely on DB row order, dropping the car from the NCB-1-99 28%
    // band to the NCB=0 19.5% band.)
    const sameUpload = existing && row.year === existing.year && row.month === existing.month;
    const better = !existing
      || (row.year > existing.year)
      || (row.year === existing.year && row.month > existing.month)
      || (sameUpload && (Number(existing.ncb) || 0) === 0 && (Number(row.ncb) || 0) > 0);
    if (better) {
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

/** Pick the canonical CD2 (non-discount) rule from a filtered rule set.
 *
 *  CD1 is the discount column for Digit/wide-matrix grids — it is NOT a
 *  commission rate. Drop it. When CD2 is null and no other rate is
 *  available, the null-rate recovery block (above) substitutes a SATP
 *  proxy rate before this function is called.
 */
function pickPrimaryRateRule(rules) {
  const cd2 = rules.filter(r => {
    const rt = (r.rate_type || '').toUpperCase();
    if (rt === '' || rt === 'CD1' || rt.includes('CD1')) return false;
    if (rt.startsWith('FLEXI')) return false;
    return r.rate_value != null && !r.is_declined;
  });
  if (cd2.length === 0) return null;
  // De-prioritise "act-only" (_ACT) rate types when a non-ACT sibling survives
  // the same policy filter. Royal Sundaram quotes BOTH a 0% SATP_ACT (standalone
  // act-only) and the real SATP_PACK for the same Pvt-Car segment; cd2[0] would
  // otherwise headline the 0% act-only rate. Only narrows the pool when an _ACT
  // rate actually competes with a real rate, so other insurers are unaffected.
  const nonAct = cd2.filter(r => !/_ACT\b|ACT$/i.test(r.rate_type || ''));
  const pool = nonAct.length > 0 ? nonAct : cd2;
  // Tiebreak: prefer a non-zero rate over a 0% sibling — a 0% headline when a
  // real rate exists for the same segment is almost always the wrong pick.
  const nonZero = pool.filter(r => Number(r.rate_value) > 0);
  const finalPool = nonZero.length > 0 ? nonZero : pool;
  // AVG vs MAX: go_digit (and similar wide-matrix grids) carry both an AVG and
  // a MAX CD2 commission for the same segment (e.g. COMP_AVG_CD2 vs
  // COMP_MAX_CD2, SATP_AVG_CD2 vs SATP_MAX_CD2). When both survive the policy
  // filter, take MAX. Only narrows when a MAX sibling actually competes, so
  // grids that carry a single (un-suffixed) rate are unaffected.
  const maxRt = finalPool.filter(r => /(^|_)MAX(_|$)/.test((r.rate_type || '').toUpperCase()));
  return (maxRt.length > 0 ? maxRt : finalPool)[0];
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
  // Nil-Dep (zero-dep) cover flag from Prarambh_Live (1=Yes / 2=No), stamped on
  // the row by the bulk pre-fetch. Drives Royal GCV Comp_NilDep vs Comp_NoNilDep.
  if (policy._depreciation != null) params._depreciation = Number(policy._depreciation);

  // PR (Premium Register) reconciliation — the operator's own export is the
  // authoritative source for the key rating factors. When a PR row matches (by
  // policy_no, with stripped-variant + vehicle-no fallback), PR wins for CC,
  // NCB, FuelType, Tonnage, Seating and Product wherever it carries a valid
  // value (fixes e.g. a 100cc bike whose Prarambh CC is the 1998 MFG year).
  // Runs before every downstream gate so the corrected params propagate.
  //
  // Exclusions: Royal's PR export carries NO cc (so it gains nothing from the
  // override that drives the gains elsewhere), and overriding its fuel/seating/
  // NCB interacts with Royal's heavily-tuned grids to lose 2 matches with zero
  // offsetting gain (verified: full reconcile 376 vs no-reconcile 378, no single
  // factor isolates it). Skip Royal until per-factor handling is justified.
  const PR_RECONCILE_EXCLUDE = new Set(['royal_sundaram']);
  if (prIndex && !PR_RECONCILE_EXCLUDE.has(insurerSlug) && (params._policy_no || params.vehicleRegNo)) {
    let prMatch = null;
    let _prViaVehicle = false;
    if (params._policy_no) {
      const pk = String(params._policy_no).trim().toUpperCase();
      prMatch = prIndex.get(pk) || null;
      if (!prMatch) for (const v of policyKeyVariants(params._policy_no)) { prMatch = prIndex.get(v); if (prMatch) break; }
    }
    if (!prMatch && params.vehicleRegNo && prIndex._byVehicle && prIndex._normVeh) {
      const vk = prIndex._normVeh(params.vehicleRegNo);
      if (vk && vk.length >= 6) { prMatch = prIndex._byVehicle.get(vk) || null; _prViaVehicle = !!prMatch; }
    }
    if (prMatch) {
      const ch = reconcileParamsWithPR(params, prMatch, { vehicleMatched: _prViaVehicle });
      if (ch) params._prReconciled = ch;
      // Booking-location city from PR (e.g. THANE) — used for TATA new-vehicle
      // cluster resolution where the RTO is a "NEW" placeholder.
      params._prRegion = prMatch.region || null;
    }
  }

  // Shriram Pvt-Car: CNG/LPG cars belong to the PETROL segment. The grid has only
  // PRIVATE CAR PETROL / PRIVATE CAR DIESEL; USER-confirmed (DJ1/6578 Ertiga VXI
  // CNG, Jharkhand, NCB-0: operator paid the PETROL Maruti-family "without NCB"
  // 30, we matched DIESEL Without-NCB 20). Also covers the blank-fuel case where
  // only the model name carries "CNG"/"LPG".
  if (insurerSlug === 'shriram' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR') {
    const _fu = String(params.fuelType || '').toUpperCase();
    const _mdl = `${params.model || ''} ${params.vehicleCategory || ''}`.toUpperCase();
    if (/CNG|LPG/.test(_fu) || (!_fu && /\bCNG\b|\bLPG\b/.test(_mdl))) {
      params.fuelType = 'Petrol';
    }
  }

  // Royal Pvt-Car Comp grid bands its payout by OD discount (stored in
  // rate_rules.volume_tier: "Upto 20" / "20-50" / "50-60" / "60-70" / ">70").
  // tmp_PrarambhData.OD_DISCOUNT is blank for these rows, so the discount must
  // come from the PR file's FINALDISCOUNT column (e.g. -0.85 → 85%). Pull it
  // from the PR index and feed it as discountPct so filterRulesByPolicy picks
  // the right band. Royal-only; when no PR row / FINALDISCOUNT, leave the
  // existing discountPct (from OD_DISCOUNT) untouched.
  if (insurerSlug === 'royal_sundaram' && prIndex && params._policy_no) {
    const pk = String(params._policy_no).trim().toUpperCase();
    let prRow = prIndex.get(pk) || null;
    if (!prRow) {
      for (const stripped of policyKeyVariants(params._policy_no)) {
        prRow = prIndex.get(stripped); if (prRow) break;
      }
    }
    if (prRow && prRow.final_discount != null) params.discountPct = prRow.final_discount;
  }

  // BH-series (Bharat-series) registration override. A reg like "23BH6834D"
  // has RTO_Code "23BH" (no state), source City/StateName come through as the
  // placeholder "India", and cleanRtoCode() rejects it — so extractPolicyParams
  // falls back to the tracker-prefix RTO ("…/DL7/…" → DELHI), which is wrong.
  // For these rows, take the region from the operator's own PR classification
  // (State_For_TP_ULR / Key_City_Group / City / State). _bhRegion overrides the
  // resolved region below; _stateName feeds the state/tier fallback.
  // Reliance NEW two-wheeler: a brand-new TW (vehicle_no='NEW') sometimes carries
  // AGE_OF_VEHICLE=1 (data quirk) instead of 0, which misses the new-vehicle /
  // bundle-tenure selection and lands on the annual Comp rate instead of the
  // COMP_1+5 bundle. USER-confirmed (JK1/833 NTORQ NEW, 1+5 bundle, age 1: op 48 =
  // J&K Scooter COMP_1+5 47.5, not annual Comp 52.5); its age-0 NEW siblings
  // (JK1/797 …) all match at 47.5. Force age 0 so the bundle logic fires.
  if (insurerSlug === 'reliance' && String(params.vehicleType || '').toUpperCase() === 'TW' &&
      String(params.vehicleRegNo || '').trim().toUpperCase() === 'NEW' && (Number(params.vehicleAge) || 0) > 0) {
    params.vehicleAge = 0;
  }
  // TATA: same data quirk on cars — a brand-new vehicle (vehicle_no='NEW',
  // BUSINESS/SUB_BUSINESS = New Business / New Vehicle) sometimes reports
  // AGE_OF_VEHICLE=1 because it was manufactured in the prior calendar year but
  // first-insured now. TATA's Pvt-Car grid prices a NEW car off the "Brand New"
  // sub_type (age 0-0); age 1 misses it and lands on the Renewal age-1-99 band
  // (e.g. PAN INDIA COMP: Brand New 0.30 vs Renewal Other-Than-Diesel 0.25).
  // USER-confirmed (GJ1/32328 Innova Hycross NEW: op 30 = Brand New 0.30).
  if (insurerSlug === 'tata_aig' &&
      String(params.vehicleRegNo || '').trim().toUpperCase() === 'NEW' && (Number(params.vehicleAge) || 0) > 0) {
    params.vehicleAge = 0;
  }

  const isBhSeries = /^\s*\d{2}\s*BH/i.test(String(params.vehicleRegNo || '')) ||
                     /^\d{2}BH$/i.test(String(params.rtoCode || ''));
  if (isBhSeries && prIndex && params._policy_no) {
    const pk = String(params._policy_no).trim().toUpperCase();
    let prRow = prIndex.get(pk) || null;
    if (!prRow) {
      for (const stripped of policyKeyVariants(params._policy_no)) {
        prRow = prIndex.get(stripped); if (prRow) break;
      }
    }
    if (prRow) {
      // Prefer the TP-pricing state ("Rest Of Maharashtra"); a non-"State"
      // Key_City_Group names a specific key city; else fall back to city/state.
      const keyCity = (prRow.pr_key_city && !/^state$/i.test(prRow.pr_key_city))
        ? prRow.pr_key_city : null;
      const prRegion = prRow.pr_state_tp || keyCity || prRow.pr_city || prRow.pr_state || null;
      if (prRegion) {
        params._bhRegion = prRegion.toUpperCase();
        // The tracker-derived RTO ("DL7") is bogus for a BH-series vehicle —
        // drop it so the Royal state-gate (policy.js, which derives the policy
        // state from rtoStatePrefix(rtoCode) and would wrongly read DELHI)
        // falls back to _stateName instead. Feed _stateName the PR region/state
        // ("Rest Of Maharashtra") so its tokens match the rule's state remarks.
        params.rtoCode = '';
        const realState = (prRow.pr_state && !/^india$/i.test(prRow.pr_state))
          ? prRow.pr_state : (prRow.pr_state_tp || prRegion);
        params._stateName = realState;
      }
    }
  }

  // Royal Pvt-Car Noida override. RTO UP16 = Gautam Buddha Nagar (Noida) sits
  // in the NCR, and Royal pays the Delhi-NCR rate for it — NOT the "Rest of
  // Uttar Pradesh" rate — even though the PR file labels it "Rest Of Uttar
  // Pradesh" and the RTO state is UP. (Confirmed against cycle 11: UP16 car was
  // paid 23 = DELHI-NCR SATP_PACK 1000-1500, while a sibling UP15 "Rest Of UP"
  // car was paid 31.) Map UP16 cars to the Delhi-NCR region so they take the
  // NCR/Delhi rate. Scoped to Royal + CAR + exactly UP16; clear rtoCode so the
  // Royal state-gate (policy.js) doesn't derive UTTAR PRADESH from the prefix
  // and instead reads DELHI (→ NCR alias) from _stateName.
  if (insurerSlug === 'royal_sundaram' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      /^UP[\s-]?16$/i.test(String(params.rtoCode || ''))) {
    params._ncrDelhiForce = true;
    params._stateName = 'DELHI';
    params.rtoCode = '';
  }

  // Tonnage fallback — caches.tonnageById is a Map<mainId, tonnes> populated
  // once before the per-policy loop (see runBulkCalculate).
  // Fire when tonnage is unknown OR only a coarse "Upto X" category stand-in —
  // a precise GVW (TRN) should refine the band (e.g. "Upto 2.5Tn" → 2.5 but
  // the real 1.6T belongs in "<= 2").
  if ((params.tonnage == null || params.tonnageCoarse) && params.mainId && caches && caches.tonnageById) {
    const t = caches.tonnageById.get(String(params.mainId));
    if (t != null) {
      params.tonnage = t;
      params.tonnageCoarse = false;   // now a precise value
      // Collapse the coarse min/max to the precise value so band-overlap
      // checks key off the real GVW.
      params.tonnageMin = t;
      params.tonnageMax = t;
    }
  }

  // Tonnage fallback #2 — Premium Register (pr_rows.tonnage). When the Prarambh
  // GVW lookup above yields nothing (no mainId, or TRN row lacks GVW), the policy
  // arrives with tonnage=null and every weight-banded GCV rule is filtered out
  // (→ no rule / wrong band). The operator's PR file usually carries the
  // registered GVW, so take it from there. Per product owner: "wherever tonnage
  // is missing, take it from PR; if not found there, move on." Only fills a
  // genuinely-missing/coarse value — a precise Prarambh GVW already set above is
  // left intact.
  if ((params.tonnage == null || params.tonnageCoarse) && prIndex && params._policy_no) {
    const pkT = String(params._policy_no).trim().toUpperCase();
    let prT = prIndex.get(pkT) || null;
    if (!prT) {
      for (const stripped of policyKeyVariants(params._policy_no)) {
        prT = prIndex.get(stripped); if (prT) break;
      }
    }
    const ton = prT && prT.tonnage != null ? Number(prT.tonnage) : null;
    if (ton != null && Number.isFinite(ton) && ton > 0) {
      params.tonnage = ton;
      params.tonnageCoarse = false;
      params.tonnageMin = ton;
      params.tonnageMax = ton;
    }
  }

  if (!insurerSlug) {
    return buildOutputRow(policy, params, null, null, null, null, 'Insurer not mapped', null, null);
  }

  // RTO → region (cached per insurer + product + rto_code)
  let rtoInfo = null;
  let resolvedRegion = null;
  if (params.rtoCode) {
    // E-Rickshaw / electric 3W passenger maps to a different RTO cluster
    // column than generic CV — use a dedicated RTO product so resolveRTO
    // picks the PCV_3W_Electric cluster (e.g. UP41 → "Good UP", not "UP-1").
    const rtoProduct = rtoProductFor(params);
    const rtoKey = `${insurerSlug}||${rtoProduct}||${params.rtoCode}`;
    if (caches.rto.has(rtoKey)) {
      rtoInfo = caches.rto.get(rtoKey);
    } else {
      try {
        rtoInfo = await resolveRTO(pool, insurerSlug, rtoProduct, params.rtoCode);
      } catch (_) { rtoInfo = null; }
      caches.rto.set(rtoKey, rtoInfo);
    }
    if (rtoInfo) resolvedRegion = rtoInfo.region;
  }
  // BH-series: the operator's PR classification is authoritative. Override the
  // (tracker-fabricated) RTO region with the PR-derived region and drop the
  // bogus cluster so the state/tier fallback keys off the real location.
  if (params._bhRegion) {
    resolvedRegion = params._bhRegion;
    rtoInfo = null;
  }
  // Royal Noida (UP16) → Delhi-NCR rate (see UP16 block above).
  if (params._ncrDelhiForce) {
    resolvedRegion = 'DELHI';
    rtoInfo = null;
  }
  // Royal Chandigarh grid. Royal files a SEPARATE Pvt-Car Comp grid for
  // Chandigarh (remarks="Chandigarh", only the "Rest of State" tier carries a
  // rate — Key/Other Cities are blank), distinct from the Punjab grid. The
  // rate-card RTO cluster is authoritative: several non-CH RTOs (PB01/27/65/70,
  // HR70/99) map to the CHANDIGARH cluster but carry a PB/HR state prefix, so
  // the state-gate (policy.js, derives state from rtoStatePrefix) would wrongly
  // pick the Punjab/Haryana grid (e.g. PB27 → Punjab "Other Cities" >70 = 0.245
  // instead of Chandigarh "Rest of State" >70 = 0.27). Force the Chandigarh grid
  // for any Royal CAR whose cluster is CHANDIGARH: clear rtoCode so the
  // state-gate falls back to _stateName='CHANDIGARH'. Keep rtoInfo (cluster
  // CHANDIGARH drives the tier fallback). CH-prefix RTOs already resolve to
  // Chandigarh via the prefix, so this only corrects the PB/HR-clustered ones.
  if (insurerSlug === 'royal_sundaram' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      rtoInfo && String(rtoInfo.cluster || '').toUpperCase() === 'CHANDIGARH') {
    params._stateName = 'CHANDIGARH';
    params.rtoCode = '';
    resolvedRegion = 'CHANDIGARH';
  }
  // City-region carriers (ICICI / HDFC Ergo): when no RTO is available,
  // prime the initial lookup with the policy's booking location so we narrow
  // to the right city instead of pulling every region nationwide and picking
  // the first survivor.
  // HDFC: the Ahmedabad city RTOs (GJ01/GJ27) have NO rto_mapping row and the
  // Robinhood grid keys them to the AHMEDABAD (Zone-1) region — so the ONLY
  // resolution path is the booked-location string, which is null for some
  // policies (GJ1/32428 Land Rover Defender: BooKedLocation null → region null
  // → arbitrary 'Rest of Assam' 27.5 vs the AHMEDABAD Zone-1 Petrol 30 the
  // operator paid). Map these RTOs directly so resolution is booked-loc-independent.
  if (!resolvedRegion && insurerSlug === 'hdfc_ergo') {
    const _ahmRto = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (_ahmRto === 'GJ01' || _ahmRto === 'GJ1' || _ahmRto === 'GJ27') resolvedRegion = 'Ahmedabad';
    // TN RTOs with no rto_mapping (TN45/TN99/… — the higher non-Chennai series)
    // fall to the booked-location → wrongly 'Mumbai' (Chennai RTOs TN01-14 are
    // mapped and resolve fine). They're Tamil Nadu = "ROTN" (Rest of Tamil Nadu;
    // same SAOD rate as Chennai = 55). USER-flagged (TN1/791 TN99 TVS Scooter
    // SAOD: op 55, not Mumbai 30; TN1/974 TN45 Yamaha Bike: op 55). TW-scoped.
    else if (String(params.vehicleType || '').toUpperCase() === 'TW') {
      // HDFC TW: an RTO with no rto_mapping leaves region null → the generic
      // lookup grabs an arbitrary "Delhi NCR" row (MH13/2233 MH21 Unicorn Bike
      // SAOD → Delhi-NCR Bike 35 vs ROM 30; MH11/1188 UP66 TVS Scooter SAOD →
      // NCR "All" 20 vs Rest-of-UP 10). Resolve the state's rest-of-state TW
      // region directly (Mumbai/Pune/Chennai/NCR-UP RTOs are mapped, so only the
      // genuinely-unmapped rest-of-state ones reach here). USER-flagged (TN/MH/UP).
      const _st2 = _ahmRto.slice(0, 2);
      if (/^TN\d+$/.test(_ahmRto)) resolvedRegion = 'ROTN';
      else if (_st2 === 'MH') resolvedRegion = 'ROM';
      else if (_st2 === 'UP' && !/^UP(14|16)\b/.test(_ahmRto)) resolvedRegion = 'Rest of UP';
    }
  }
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
  // GATED to !rtoInfo: the ICICI RTO-master (rto_mappings) now carries the
  // authoritative PO-GRID region per RTO. Re-aliasing those would corrupt a
  // canonical state region (e.g. GUJARAT → AHMEDABAD & GANDHINAGAR). Only the
  // booked-location fallback (city names) needs the alias normalization.
  if (insurerSlug === 'icici_lombard' && resolvedRegion && aliasIciciRegion && !rtoInfo) {
    resolvedRegion = aliasIciciRegion(resolvedRegion);
  }
  // HDFC Ergo region-name normalization (see HDFC_REGION_ALIASES).
  if (insurerSlug === 'hdfc_ergo' && resolvedRegion && aliasHdfcRegion) {
    resolvedRegion = aliasHdfcRegion(resolvedRegion);
  }
  // Universal Sompo: files rates under the full UPPERCASE state name +
  // cluster regions. Scope the initial lookup to the primary state region
  // (else an empty region returns all-state rules and the dedup can pick a
  // wrong state — e.g. MH GCV matching J&K). Cluster variants feed the
  // fallback (usCandidates below).
  if (insurerSlug === 'universal_sompo' && !resolvedRegion && !(rtoInfo && rtoInfo.cluster)) {
    const US_SR = require('./policy').US_STATE_REGION || {};
    const fam = US_SR[rtoStatePrefix(params.rtoCode)];
    if (fam && fam.length) resolvedRegion = fam[0];
  }
  // Zuno: has ZERO rto_mappings, so region never resolves and every car falls to
  // the "Pan India (doable RTOs)" bucket — where the NCB=0 override pays a flat 15%.
  // Zuno files Pvt-Car rates per FULL STATE NAME (Delhi / Uttar Pradesh / Punjab /
  // Haryana / Maharashtra …), and the regional Comp rate (e.g. North/UP = 28%) is a
  // FLAT rate (the "NCB 1-99" in remarks is informational, not a gate). Resolve the
  // region from the RTO state prefix (labels match STATE_PREFIX_FULL exactly) so the
  // policy lands on its own state's rate instead of Pan-India 15%. USER-confirmed flat
  // North rate. (City-RTO refinements — Mumbai/Pune/Bengaluru — take the state rate.)
  // A NEW car (vehicle age 0, non-TP) takes Zuno's "Pvt new car business / New
  // Vehicle Business" grid = 30% filed under region "All doable RTO's" (COMP_1+3,
  // age 0-0) — applies REGARDLESS of state and REGARDLESS of tenure (the rule says
  // "New Vehicle", so gate on AGE only, not 1+1 vs 1+3). USER-confirmed (funnel).
  // Resolve age-0 to that region directly so the 30% is the primary (and the
  // Pan-India NCB=0 15% floor — a different region — is NOT pooled). Non-new cars
  // (age > 0) resolve to their STATE for the regional Rollover/Renewal rate.
  if (insurerSlug === 'zuno' && !resolvedRegion && params.rtoCode) {
    const _age0 = (Number(params.vehicleAge) || 0) === 0;
    const _pureTp = /^(TP|SATP|ACT)$/i.test(String(params.insProduct || ''));
    if (_age0 && !_pureTp) {
      resolvedRegion = "All doable RTO's";
    } else {
      const SPF = require('./policy').STATE_PREFIX_FULL || {};
      const st = SPF[rtoStatePrefix(params.rtoCode)];
      if (st) resolvedRegion = st;
    }
  }
  // Kotak: has ZERO rto_mappings, and its GCV grid is keyed PER RTO CODE — the
  // GCV-segment rows carry region = the RTO code itself (e.g. region='HR38',
  // sub_type='HR38'), one row per tonnage band. With no rto_mapping the region
  // never resolves, so the initial lookup pulled an arbitrary wrong RTO's row
  // (e.g. SONIPAT/DL14 LCV 0.25 instead of HR38 GCV 0.35). Use the policy's RTO
  // code AS the region so the lookup hits the right RTO's GCV bands. Scoped to
  // GCV (CAR rows are keyed by CITY region + sub_type=code, a separate path).
  if (insurerSlug === 'kotak' && !resolvedRegion &&
      String(params.vehicleType || '').toUpperCase() === 'GCV' && params.rtoCode) {
    resolvedRegion = String(params.rtoCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  // Shriram: regions are full UPPERCASE state names; national rows are NULL/''
  // ("PAN INDIA"). No RTO→region map ships, so seed the region from the
  // RTO-state's full name — otherwise an empty region returns ALL-state rules
  // and the scorer lands on an arbitrary state (e.g. MH GCV → ODISHA rate).
  // include_null_region (below) keeps the national PAN-INDIA rows reachable.
  // Shriram GCV/PCV grids label regions with verbose multi-state strings
  // ("GUJARAT & DADRA NAGAR HAVELI & DAMAN & DIU", "TAMILNADU & PONDICHERRY",
  // "PUNJAB/CHANDIGARH", "MUMBAI", "ROM"). The plain state name from
  // STATE_PREFIX_FULL never matches under strict equality, so resolve a set of
  // distinctive SEARCH TOKENS via aliasShriramRegion and match them with
  // 'contains' (substring) mode. Maharashtra splits Mumbai-metro RTOs → MUMBAI,
  // rest → ROM. include_null_region (below) keeps national PAN-INDIA rows.
  let shriramRegionTokens = null;
  if (insurerSlug === 'shriram') {
    const P = require('./policy');
    const SPF = P.STATE_PREFIX_FULL || {};
    const fullState = resolvedRegion || SPF[rtoStatePrefix(params.rtoCode)];
    if (P.aliasShriramRegion) {
      const toks = P.aliasShriramRegion(fullState, params.rtoCode);
      if (toks && toks.length) shriramRegionTokens = toks;
    }
    if (!resolvedRegion && fullState) resolvedRegion = fullState;
  }
  // United India GCV funnel: 0 rto_mappings → region never resolves, and a 3W/light
  // goods category often has a null Tonnes field. Two funnel steps so the existing
  // weight-band + state lookup can fire deterministically:
  //   (1) region = registration STATE NAME (from the RTO prefix),
  //   (2) tonnage = derived from the CATEGORY text ("GCV - 4W 2.5-3.5Tn",
  //       "GCV - 4W Upto 2.5Tn", "GCV - 4W Above 40Tn") when Tonnes is null.
  // GCV-scoped (PCV/TW handled separately); include_null_region keeps national rows.
  let unitedGcvFunnel = false;
  if (insurerSlug === 'united_india_insurance') {
    const P = require('./policy');
    const SPF = P.STATE_PREFIX_FULL || {};
    const stateName = SPF[rtoStatePrefix(params.rtoCode)] || params._stateName || '';
    // Region = registration STATE NAME for ALL United products (it ships 0 rto_mappings).
    if (!resolvedRegion && stateName) { resolvedRegion = stateName; unitedGcvFunnel = true; }
    if (String(params.vehicleType || '').toUpperCase() === 'GCV' && params.tonnage == null) {
      // Take the tonnage NUMBER from the category and let it fall into whatever
      // weight band it lands in (e.g. 2.5 → the 2-3.5 band). Keep it simple — one
      // value, mapped by the normal band gate. "X-YTn" → the in-between value,
      // "Upto XTn" → X, "Above XTn" → X.
      const cat = String(params.vehicleCategory || '');
      let m, t = null;
      if ((m = cat.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*Tn/i))) { t = (+m[1] + +m[2]) / 2; }
      else if ((m = cat.match(/Upto\s*(\d+(?:\.\d+)?)\s*Tn/i))) { t = +m[1]; }
      else if ((m = cat.match(/Above\s*(\d+(?:\.\d+)?)\s*Tn/i))) { t = (+m[1]) + 1; }
      if (t != null) { params.tonnage = t; params.tonnageMin = t; params.tonnageMax = t; params.tonnageCoarse = false; }
    }
  }

  // Oriental GCV 3-wheeler: a 3W goods auto (Piaggio Ape / Bajaj RE) is ALWAYS the
  // lightest GVW band (<=2000kg / 0-2T = Row14 55%). Don't band 3W by GVW/tonnage —
  // the source GVW is routinely null or garbage (one APE XTRA LD had a 2-3.5T value
  // while the identical model elsewhere had none). Force tonnage into the 0-2T band
  // so the standard weight gate keeps Row14 and drops heavier bands. All Oriental
  // Ape/RE 3W = 55. Oriental + GCV + 3W scoped (zero effect elsewhere).
  if (insurerSlug === 'oriental_insurance' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV' &&
      /\b3\s*W\b|3\s*WHEEL|THREE\s*WHEEL/i.test(String(params.vehicleCategory || ''))) {
    params.tonnage = 1; params.tonnageMin = 1; params.tonnageMax = 1; params.tonnageCoarse = false;
  }

  // Shriram private-car fuel bucketing: the grid files only PRIVATE CAR PETROL
  // and PRIVATE CAR DIESEL — there is NO CNG/LPG private-car row. Per product
  // owner:
  //   - CNG / LPG  → DIESEL band (the lower rate; matches the operator, e.g.
  //                  MH14/6865 = 15 vs operator 14).
  //   - fuel BLANK → PETROL band (genuinely-unknown fuel default).
  // Coerce the fuel so the SQL lookup AND the scorer's fuel-bucket preference
  // both land deterministically (otherwise a blank fuel leaves primary='' and
  // petrol/diesel tie arbitrarily).
  if (insurerSlug === 'shriram' && String(params.vehicleType || '').toUpperCase() === 'CAR') {
    const fu = String(params.fuelType || '').trim().toUpperCase();
    if (/\bCNG\b|\bLPG\b/.test(fu)) {
      params.fuelType = 'Diesel';
    } else if (fu === '') {
      params.fuelType = 'Petrol';
    }
  }
  // Magma GCV >40T: the >40T tonnage grid is split by cluster. In SOME regions it
  // carries only anomalously-low placeholder rates (~0.08-0.13, e.g. NE6 0.08,
  // WB 0.12) that the operator does NOT use — there the operator rates on the
  // next-lower 20T-40T slab (USER-confirmed, e.g. MH22/4933 42T → "GCV 20T-40T
  // Age>=5" 0.22, not >40T 0.12). But in OTHER regions the >40T band carries a
  // PROPER rate the operator DOES use (e.g. MH1 >40T Comp 0.24 = operator 24).
  // Rule (USER-confirmed): use the real >40T band when its rate is proper
  // (>= 0.15); otherwise cap to 20-40T. We probe the region's >40T rate first.
  if (insurerSlug === 'magma_hdi' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV' &&
      Number(params.tonnage) > 40) {
    let real40Proper = false;
    try {
      const reg40 = resolvedRegion || '';
      const k40 = 'magma40T::' + reg40;
      let r40;
      if (caches.lookup.has(k40)) r40 = caches.lookup.get(k40);
      else {
        r40 = await lookupRates(pool, { insurer: 'magma_hdi', product: 'GCV', region: reg40 });
        caches.lookup.set(k40, r40);
      }
      // Probe the >40T rate for THIS policy's cover only — a region can carry a
      // proper SATP >40T (0.29) but an anomalously-low COMP >40T (0.14); taking
      // the max across both would wrongly read "proper" and apply the low COMP
      // rate (regressing Comp >40T trucks, e.g. MH22/5019). Match rate_type to
      // the policy cover: Comp→COMP rows, TP/SAOD→SATP rows; unknown→either.
      const ip = String(params.insProduct || '').toUpperCase();
      const coverRe = ip === 'COMP' ? /COMP/i
                    : (ip === 'TP' || ip === 'SAOD') ? /SATP|SAOD|^TP$|^ACT$/i
                    : /./;
      const max40 = Math.max(0, ...r40
        .filter(r => />\s*40\s*T/i.test(String(r.segment || '')) &&
                     coverRe.test(String(r.rate_type || '')))
        .map(r => Number(r.rate_value) || 0));
      real40Proper = max40 >= 0.15;
    } catch (e) { /* probe failed → fall back to the cap (safe default) */ }
    // Anomalously-low / unknown >40T rate → cap to the 20-40T slab.
    if (!real40Proper) params.tonnage = 39;
  }

  // ---- TATA: NEW-vehicle cluster from BOOKING LOCATION ----
  // A NEW vehicle (vehicle_no "NEW" / age 0) has no real RTO yet, so the RTO-based
  // region is a placeholder and mis-resolves (e.g. generic "Rest of Maharashtra" 41%
  // when the operator rates the Mumbai-metro cluster 58-61%). USER-confirmed: for
  // TATA new vehicles ONLY, resolve the cluster from the PR booking location (THANE→
  // MUMBAI, MOTI NAGAR→DELHI; major cities match directly). Unknown rest-of-state
  // cities (Nashik/Himmatnagar) aren't in the city set → fall back to the RTO region.
  if (insurerSlug === 'tata_aig' && params._prRegion &&
      (params.vehicleAge === 0 || String(params.vehicleRegNo || '').trim().toUpperCase() === 'NEW')) {
    const TATA_BOOKING_ALIAS = {
      'THANE': 'MUMBAI', 'NAVI MUMBAI': 'MUMBAI', 'KALYAN': 'MUMBAI', 'PANVEL': 'MUMBAI',
      'MOTI NAGAR': 'DELHI', 'MOTINAGAR': 'DELHI',
    };
    const TATA_CITY_REGIONS = new Set(['MUMBAI', 'PUNE', 'NAGPUR', 'SURAT', 'AHMEDABAD',
      'DELHI', 'HYDERABAD', 'BANGALORE', 'CHENNAI', 'KOLKATA', 'JAIPUR', 'INDORE',
      'RAJKOT', 'VADODARA', 'COIMBATORE', 'BHUBANESHWAR', 'CHANDIGARH', 'GOA',
      'VIJAYWADA', 'VISHAKAPATNAM']);
    const bl = String(params._prRegion).toUpperCase().trim();
    const mapped = TATA_BOOKING_ALIAS[bl] || bl;
    if (TATA_CITY_REGIONS.has(mapped)) {
      resolvedRegion = mapped;
      params._tataBookingRegion = mapped;
    }
  }
  params.resolvedRegion = resolvedRegion;

  // Product alias set
  const policyType = String(params.vehicleType || '').toUpperCase();
  const resolvedProduct = SPECIFIC_VEHICLE_TYPES.has(policyType)
    ? params.vehicleType
    : ((rtoInfo && rtoInfo.product) || params.vehicleType);
  // NOTE: clone the alias array — PRODUCT_ALIASES values are shared module-level
  // arrays. Pushing onto the reference (e.g. the Shriram 3W e-cart PCV add-on
  // below) would permanently mutate the global alias and leak PCV into EVERY
  // subsequent GCV lookup. Always work on a copy.
  const productList = [...(PRODUCT_ALIASES[String(resolvedProduct).toUpperCase()] || [resolvedProduct])];
  const productIsTw = String(resolvedProduct).toUpperCase().includes('TW') ||
                      String(resolvedProduct).toUpperCase().includes('2W');

  // Shriram 3W e-cart: the combined "PCCV 3W E-Rickshaw and GCCV 3W E-cart"
  // segment is filed in the rate card under product=PCV, even though such a
  // vehicle is classified GCV. A GCV-only lookup never sees it (and falls back
  // to a wrong region/rate). Add PCV to the candidate products so the combined
  // segment is considered (e.g. UP1/14760 → UTTAR PRADESH = 54 instead of 44).
  if (insurerSlug === 'shriram' && String(params.vehicleType || '').toUpperCase() === 'GCV') {
    const cat = String(params.vehicleCategory || '').toUpperCase();
    const fu  = String(params.fuelType || '').toUpperCase();
    // Category can be "GCV - 3W" or "E-Rikshaw-Good Carrying". The combined
    // grid row is electric-only, so require an electric signal (fuel = ELECTRIC,
    // or an e-rickshaw / e-cart category) — this keeps CNG/diesel 3W goods
    // vehicles (e.g. Bajaj Cargo CNG) out of the PCV combined segment.
    const isEcartCat = /\b3W\b|3\s*WHEEL|RIKSHAW|RICKSHAW|E-?CART/.test(cat);
    const isElec     = /ELECTRIC|\bEV\b/.test(fu) || /RIKSHAW|RICKSHAW|E-?CART/.test(cat);
    if (isEcartCat && isElec && !productList.includes('PCV')) productList.push('PCV');
  }

  // Bajaj: select the rate-card GENERATION effective for the POLICY START DATE —
  // a May-start policy takes the May card if one is loaded, else falls back to
  // April (the latest card whose effective_from ≤ start date; earliest if none is
  // yet effective). Scoped to Bajaj per product owner; other insurers are NOT
  // date-filtered here (chola/reliance/royal/sbi carry multiple effective-from
  // generations that must keep coexisting). All-April currently → no-op until a
  // May Bajaj card is uploaded.
  let _bajajEffDate;
  if (insurerSlug === 'bajaj_allianz') {
    // Always pass an effective_date so the generation filter ALWAYS runs (else a
    // null/garbage start date leaves April+May rules mixed → pickPrimary grabs the
    // wrong generation). Prefer POLICY_START_DATE, fall back to issue date, then to
    // a far-past sentinel → which makes the filter fall back to the EARLIEST (April)
    // card. So unknown-date / historical policies stay on April; only a genuine
    // start date ≥ 1-May routes to May.
    const _en = require('../services/enablers');
    // USER-confirmed rule: Bajaj applies the grid GENERATION effective on the
    // policy's RISK-START date (OD start / policy start / TP start), NOT the
    // issue/booking date. e.g. UP1/15178 issued 29-Apr but starts 01-May → the
    // 1-May card (47.5) = operator 48, where issue-date wrongly gave the April
    // card (44.5). Date priority: OD start → policy start → TP start → PR
    // risk-inception → (last resort) issue date → far-past sentinel (→ earliest
    // /April card for unknown-date rows).
    //
    // TRADE-OFF (accepted): the ~64 REST-OF-WEST-BENGAL SATP bikes issued 30-Apr
    // with start 02-May now route to the 1-May card (50.5) per the start-date
    // rule, whereas the operator paid them the April rate (47.5/48). Those become
    // grid-correct-on-May with the operator value as noise → marked As-per-Grid.
    const _pr = (prIndex && params._policy_no) ? prIndex.get(String(params._policy_no).trim().toUpperCase()) : null;
    _bajajEffDate = _en.toIso(policy.OD_Start_Date)
                 || _en.toIso(policy.POLICY_START_DATE)
                 || _en.toIso(policy.TP_POLICY_START_DATE)
                 || _en.toIso(_pr && _pr.pr_start_date)
                 || _en.toIso(policy.POLICY_ISSUED_DATE)
                 || '2000-01-01';
  }

  const baseLookup = {
    insurer: insurerSlug,
    product: productList,
    region: resolvedRegion || '',
    cluster: (rtoInfo && rtoInfo.cluster) || '',
    vehicle_age: params.vehicleAge,
    fuel_type: productIsTw ? '' : (params.fuelType || ''),
    ins_product: params.insProduct || '',
    ...(_bajajEffDate ? { effective_date: _bajajEffDate } : {}),
    // Shriram: state-name region filter must still surface national
    // (NULL/'' region = "PAN INDIA") rows.
    include_null_region: insurerSlug === 'shriram' || unitedGcvFunnel,
    // Shriram: match the verbose card labels by substring tokens (overrides
    // region/cluster when present).
    ...(shriramRegionTokens
      ? { region_list: shriramRegionTokens, region_match_mode: 'contains' }
      : {}),
    // Kotak MISC (tractor / cash van / garbage van): the MIS grid is keyed by
    // RTO CODE in sub_type (region = city, e.g. region='AMETHI' sub_type='UP36').
    // Kotak has 0 rto_mappings so region never resolves; an empty region matches
    // ALL regions, and the sub_type filter then narrows to the policy's RTO.
    // Kotak: MISC is always RTO-keyed. CAR/TW are RTO-keyed ONLY for SATP (TP) —
    // their Comp rate is NCB-banded (region/NCB level, sub_type-NULL), so gating a
    // Comp policy by RTO wrongly strands it. Gate CAR/TW only for TP/SATP/ACT or
    // OD=0 (matches the Kotak Pvt-Car SATP override's scope). Fixes WB-68/KA-34
    // SATP picking a random district's 35% without breaking Comp matching.
    ...(insurerSlug === 'kotak' && params.rtoCode && (
          ['MISC', 'MIS'].includes(policyType)
          || (['CAR', '4W', 'PC', 'TW', '2W'].includes(policyType) &&
              (/TP|SATP|ACT/i.test(String(params.insProduct || '')) ||
               (Number(params.odPremium != null ? params.odPremium : params.od_premium) || 0) === 0))
        )
      ? { sub_type: String(params.rtoCode).toUpperCase().replace(/[^A-Z0-9]/g, '') }
      : {}),
    // Bajaj TW "RTO Based Payouts" grid is keyed by RTO CODE in sub_type (UP17=Bagpat,
    // UP80=Agra, UP81=Aligarh…). Without gating sub_type the lookup returns ALL ~46
    // district rows for the region and pickPrimary grabs an ARBITRARY district's rate
    // (e.g. a UP-81/Aligarh scooter wrongly took Bagpat's 0.20). Gate sub_type to the
    // policy's RTO code so only the correct district matches (UP81 → IRDA scooter
    // 17.5/22.5). sub_type-NULL/'' rows (state defaults) still survive as fallback.
    ...(insurerSlug === 'bajaj_allianz' && productIsTw && params.rtoCode
      ? { sub_type: String(params.rtoCode).toUpperCase().replace(/[^A-Z0-9]/g, '') }
      : {}),
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
    rl: baseLookup.region_list || null,
    rm: baseLookup.region_match_mode || null,
    st: baseLookup.sub_type || null,
    ed: baseLookup.effective_date || null,
  });
  let rules;
  if (caches.lookup.has(lookupKey)) {
    rules = caches.lookup.get(lookupKey);
  } else {
    rules = await lookupRates(pool, baseLookup);
    caches.lookup.set(lookupKey, rules);
  }
  const initialSqlCount = rules.length;

  // Liberty "Non Add-on Cases" rate (MUST run on RAW lookup rows, before
  // filterRulesByPolicy collapses each rate_type to one scored survivor — the
  // 0.29 blank/fuel row out-scores the 'No' row otherwise). The Robinhood PC
  // sheet carries a "PC -Non Add on Cases (Comp & SOD)" column ingested as
  // addon='No' (e.g. 0.20) that pays a lower rate to a Comp/SAOD car sold
  // WITHOUT add-on cover. Where a 'No' row exists for a rate_type, keep ONLY the
  // 'No' rows so the Non-Addon rate wins; where the grid defines none (most
  // regions), leave the pool so the regular rate still applies (no null).
  // Gated to no-addon CARs (ADD_ON_PREMIUM = 0). NOTE: the operator's add-on
  // flag isn't perfectly captured by ADD_ON_PREMIUM (a few zero-addon cars were
  // paid the regular rate and vice-versa) — best-effort per user direction.
  if (insurerSlug === 'liberty_videocon' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      !(Number(params.addonPremium) > 0) && rules.length) {
    const isComp = String(params.insProduct || '').toUpperCase() === 'COMP';
    const age = Number(params.vehicleAge) || 0;
    const isMH = /^MAHARASHTRA\b/i.test(String(resolvedRegion || ''));
    const netRows = rules.filter(r => /_NET\b|_NET$/.test(String(r.rate_type || '')));
    if (isComp && isMH && age > 5 && netRows.length) {
      // "PC >5 Year Non-ZD (Net) – MH Only" column (col6): a Maharashtra
      // Comprehensive car older than 5 years with NO add-on takes the flat
      // Net 0.20 instead of the regular OD rate. The Net rows are ingested as
      // a separate rate_type (PACK_LIBERTY_NET*); drop the Package/SAOD OD rows
      // so the Net rate wins. SATP (TP-only) policies are insProduct=TP and
      // never enter this branch, and with-add-on / ≤5yr cars keep the OD rate.
      rules = rules.filter(r => !/PACK_LIBERTY_OD|SAOD_LIBERTY_OD/.test(String(r.rate_type || '')));
    } else {
      // "PC -Non Add on Cases (Comp & SOD)" column (col5): where a Non-Addon
      // ('No') row exists for a rate_type, keep ONLY it so the Non-Addon rate
      // wins; where the grid defines none (most regions), leave the pool so the
      // regular rate still applies (no null). NOTE: the operator's add-on flag
      // isn't perfectly captured by the premium fields — best-effort per user.
      const isNo = r => String(r.addon || '').trim().toLowerCase() === 'no';
      const byRt = {};
      for (const r of rules) (byRt[r.rate_type] = byRt[r.rate_type] || []).push(r);
      const next = [];
      for (const arr of Object.values(byRt)) {
        next.push(...(arr.some(isNo) ? arr.filter(isNo) : arr));
      }
      rules = next;
    }
  }

  // ---- Liberty CAR NCB band (remarks-encoded) ----
  // Liberty's CAR OD grid splits SAOD (and some Comp) rows by NCB in the REMARKS text
  // ("SOD WO NCB (…)" = the WITHOUT-NCB rate, e.g. 0.195; "SOD NCB (…)" = the WITH-NCB
  // rate, e.g. 0.235) — NOT a column, so both rows survive and pickPrimary takes the
  // higher (with-NCB) one even for a zero-NCB policy (UP3/4592 NCB=0 → wrongly 23.5%
  // instead of 19.5%). Gate per rate_type: NCB>0 → keep "NCB" rows / drop "WO NCB";
  // NCB==0 → keep "WO NCB" / drop "NCB". Only fires when BOTH variants exist for a
  // rate_type (so fuel-banded or single-row rate_types are untouched). Liberty+CAR.
  if (insurerSlug === 'liberty_videocon' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' && rules.length) {
    const hasNcb = Number(params.ncbPct) > 0;
    const isWoNcb = r => /W\/?O\s*NCB|WITHOUT\s*NCB|NON[\s_-]*NCB/i.test(String(r.remarks || ''));
    const isWithNcb = r => /\bNCB\b/i.test(String(r.remarks || '')) && !isWoNcb(r);
    const byRt = {};
    for (const r of rules) (byRt[r.rate_type] = byRt[r.rate_type] || []).push(r);
    const next = [];
    for (const arr of Object.values(byRt)) {
      if (arr.some(isWoNcb) && arr.some(isWithNcb)) next.push(...arr.filter(hasNcb ? isWithNcb : isWoNcb));
      else next.push(...arr);
    }
    rules = next;
  }

  if (rules.length > 0) rules = filterRulesByPolicy(rules, params);
  const initialAfterFilter = rules.length;

  // ---- Bajaj district-level rate override ----
  // Bajaj files many SATP rates per-district (e.g. GUJARAT "Bhavnagar" 0.375,
  // "Dahod"/"Sabarkantha" 0.225, "Rajkot" 0) as region-named rows that override
  // the state row ("GUJARAT" 0.575), but rto_mappings resolves every RTO to its
  // state — so the state row always won. Resolve the policy RTO to its district
  // (BAJAJ_RTO_DISTRICT) and, for any rate_type that has a district-specific row,
  // replace the state-region rows of that rate_type with the district rows. Only
  // rate_types that actually carry a district row are swapped, so non-overridden
  // products (e.g. state-level Comp) and non-specified districts are untouched.
  // Bajaj-scoped → zero effect on any other insurer.
  if (insurerSlug === 'bajaj_allianz' && params.rtoCode && rules.length > 0) {
    const code = String(params.rtoCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const distRegion = BAJAJ_RTO_DISTRICT[code];
    if (distRegion && distRegion.toUpperCase() !== String(resolvedRegion || '').toUpperCase()) {
      const dKey = lookupKey + '||bajajDist:' + distRegion;
      let dRules;
      if (caches.lookup.has(dKey)) {
        dRules = caches.lookup.get(dKey);
      } else {
        dRules = await lookupRates(pool, { ...baseLookup, region: distRegion, cluster: '' });
        caches.lookup.set(dKey, dRules);
      }
      const dFiltered = dRules.length > 0 ? filterRulesByPolicy(dRules, params) : [];
      if (dFiltered.length > 0) {
        const dTypes = new Set(dFiltered.map(r => r.rate_type));
        rules = rules.filter(r => !dTypes.has(r.rate_type)).concat(dFiltered);
      }
    }
  }

  // ---- Kotak Pvt-Car SATP exact-RTO (Category) override ----
  // Kotak's Pvt-Car SATP rate is keyed by the EXACT RTO code in rule.sub_type,
  // which encodes the Category × Fuel: GJ05 = Category-1 (Diesel/CNG/LPG 25%,
  // Petrol 45%), GJ01/GJ11 = Category-2 (Diesel 10%, Petrol 35%). Kotak has no
  // rto_mappings, so region mis-resolves (GJ05 Surat → "Ahmedabad") and the
  // matcher pools the wrong RTO's rows (GJ01 Cat-2 → Diesel 10%) instead of the
  // policy's own GJ05 Cat-1 row (25%). Re-query by sub_type = the policy's RTO
  // code (region cleared) so the exact RTO's rows are pooled; the existing fuel
  // + make-exclusion filter then lands the right cell. Scoped to Kotak + CAR +
  // TP-only (Comp rates are NCB-banded, not per-RTO — left untouched).
  if (insurerSlug === 'kotak' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      params.rtoCode &&
      (/TP|SATP|ACT/i.test(String(baseLookup.ins_product || '')) ||
       (Number(params.odPremium != null ? params.odPremium : params.od_premium) || 0) === 0)) {
    const krRaw = String(params.rtoCode).trim().toUpperCase().replace(/\s+/g, '');
    const krVars = new Set([krRaw]);
    const krM = krRaw.match(/^([A-Z]{2})0*(\d+)([A-Z]*)$/);
    if (krM) { const [, st, num, suf] = krM; const n = String(parseInt(num, 10));
      krVars.add(st + n + suf); krVars.add(st + n.padStart(2, '0') + suf); }
    for (const v of krVars) {
      const kKey = lookupKey + '||kotakRto:' + v;
      let kRules;
      if (caches.lookup.has(kKey)) kRules = caches.lookup.get(kKey);
      else { kRules = await lookupRates(pool, { ...baseLookup, region: '', cluster: '', region_list: null, sub_type: v }); caches.lookup.set(kKey, kRules); }
      const vNorm = v.replace(/[^A-Z0-9]/g, '');
      const kExact = kRules.filter(r => /SATP/i.test(String(r.rate_type || '')) &&
        String(r.sub_type || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === vNorm);
      const kFiltered = kExact.length > 0 ? filterRulesByPolicy(kExact, params) : [];
      if (kFiltered.length > 0) {
        const kTypes = new Set(kFiltered.map(r => r.rate_type));
        rules = rules.filter(r => !kTypes.has(r.rate_type)).concat(kFiltered);
        break;
      }
    }
  }

  // ---- Kotak GCV (LCV) exact-RTO override ----
  // Kotak files GCV commission as COMP-only, keyed by sub_type=RTO code, in two
  // duplicate segments — "LCV" (<7.5T: bands ≤2.5 / 2.5-3.5 / 3.5-7.5) and "GCV"
  // (heavier bands) — with the band rate varying by RTO Category (e.g. HOWRAH
  // WB11 = 45 / 42 / 35). There is NO TP rate, so a TP-only GCV (od=0) finds
  // nothing under the TP lookup, and an unmapped RTO (WB11 has no Kotak
  // rto_mapping) never region-matches the rows. Re-query by sub_type = the
  // policy RTO with ins_product=Comp (so TP-only also gets the COMP rate the
  // operator pays) and region cleared; the weight band then resolves from the
  // Prarambh tonnage (Tonnes column). Scoped Kotak + GCV. Only replaces the pool
  // when the exact-RTO query yields filtered rows (else leaves existing/no-rule).
  if (insurerSlug === 'kotak' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV' &&
      params.rtoCode) {
    const grRaw = String(params.rtoCode).trim().toUpperCase().replace(/\s+/g, '');
    const grVars = new Set([grRaw]);
    const grM = grRaw.match(/^([A-Z]{2})0*(\d+)([A-Z]*)$/);
    if (grM) { const [, st, num, suf] = grM; const n = String(parseInt(num, 10));
      grVars.add(st + n + suf); grVars.add(st + n.padStart(2, '0') + suf); }
    for (const v of grVars) {
      const gKey = lookupKey + '||kotakGcvRto:' + v;
      let gRules;
      if (caches.lookup.has(gKey)) gRules = caches.lookup.get(gKey);
      else { gRules = await lookupRates(pool, { ...baseLookup, ins_product: 'Comp', region: '', cluster: '', region_list: null, sub_type: v }); caches.lookup.set(gKey, gRules); }
      const vN = v.replace(/[^A-Z0-9]/g, '');
      const gExact = gRules.filter(r => String(r.sub_type || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === vN);
      // Minimal band + make filter — do NOT use filterRulesByPolicy here: it drops
      // COMP rows for a TP-only policy (cover gate), but Kotak files GCV COMP-only
      // and the operator pays that rate regardless of cover. Pick the weight band
      // from tonnage; honour make-exclusion (rows are make="All" wildcard or a
      // specific excluded make at 0%). Needs a tonnage to band — tonnage-less rows
      // match no band and stay no-rule (acceptable).
      const gTon = Number(params.tonnage);
      const polMake = String(params.make || '').toUpperCase().replace(/[^A-Z]/g, '');
      const gFiltered = (Number.isFinite(gTon) ? gExact.filter(r => {
        const wmin = r.weight_band_min, wmax = r.weight_band_max;
        if (wmin != null && !(gTon >= Number(wmin))) return false;
        if (wmax != null && !(gTon <= Number(wmax))) return false;
        const mk = String(r.make || '').toUpperCase();
        if (mk && !/^(ALL|ANY|OTHERS?|)$/.test(mk) &&
            mk.replace(/[^A-Z]/g, '') !== polMake) return false;
        return true;
      }) : []);
      if (gFiltered.length > 0) { rules = gFiltered; break; }
    }
  }

  // ---- IFFCO Tokio MISC → GCV middle-slab override ----
  // USER-confirmed three facts: (1) iffco has NO separate MISC grid — Misc-D
  // goods vehicles rate off the GCV grid; (2) iffco ships ZERO rto_mappings and
  // its grid is purely STATE-based; (3) the per-state premium SLAB to apply is
  // ALWAYS the middle "3L-6L" tier. So an iffco MISC policy → GCV "Other than A1"
  // segment for the policy's STATE, "3L-6L" slab (e.g. RJ Misc-D "1512" → 0.175).
  // Region is seeded from the RTO-state full name. Scoped iffco + MISC. This
  // intentionally diverges from the operator file (which paid the Upto-3L 0.20
  // slab) — grid-correctness over operator-match, USER-confirmed.
  // Also rescues a genuine iffco GCV that found NO rule (unmapped RTO → no
  // region): same state + "Other than A1" + 3L-6L slab. Gated on rules.length===0
  // so an iffco GCV that DID resolve a region/rate is left untouched.
  {
  const iffVt = String(params.vehicleType || '').toUpperCase();
  const iffEligible = ['MISC', 'MIS'].includes(iffVt) || (iffVt === 'GCV' && !resolvedRegion);
  if (insurerSlug === 'iffco_tokio' && iffEligible && params.rtoCode) {
    const stName = (require('./policy').STATE_PREFIX_FULL || {})[rtoStatePrefix(params.rtoCode)];
    if (stName) {
      const iKey = lookupKey + '||iffcoMiscGcv:' + stName;
      let iRules;
      if (caches.lookup.has(iKey)) iRules = caches.lookup.get(iKey);
      else {
        iRules = await lookupRates(pool, { insurer: 'iffco_tokio', product: 'GCV',
          region: stName, volume_tier: '3L-6L' });
        caches.lookup.set(iKey, iRules);
      }
      // The goods rate for a state lives under whichever zone segment is non-zero:
      // "GCV (Public)" for A1 states (e.g. Tamil Nadu), "GCV (Other than A1)" for
      // A2/A3/A4 states (e.g. Rajasthan). Take the middle (3L-6L) slab and pick the
      // highest NON-ZERO goods rate across those segments — both land on 0.175.
      const iPick = iRules.filter(r =>
        /GCV \((Public|Other than A1|Private)\)/i.test(String(r.segment || '')) &&
        /3L\s*-\s*6L/i.test(String(r.volume_tier || '')) &&
        Number(r.rate_value) > 0);
      if (iPick.length > 0) {
        const best = iPick.reduce((a, b) => Number(b.rate_value) > Number(a.rate_value) ? b : a);
        rules = [best]; resolvedRegion = stName; params.resolvedRegion = stName;
      }
    }
  }
  }

  // ---- IFFCO Tokio TW state/slab override ----
  // Same story as iffco GCV/MISC: ZERO rto_mappings, STATE-based grid. The TW
  // grid is premium-slab keyed ("Upto 1L" / "Above 1L", COMP rate_type; a NULL
  // SATP row sits at 0). No region → no rule, and SAOD/TP find nothing (COMP-only
  // grid). When no region resolved, seed it from the RTO-state, pick the "TW"
  // COMP rate for the premium slab (Upto 1L when net premium ≤ ₹1L, else Above
  // 1L), cover-agnostic. e.g. TN23 Ola S1X SAOD → TN "TW" Upto-1L 0.175 = 17.5.
  if (insurerSlug === 'iffco_tokio' &&
      /^(TW|2W)$/.test(String(params.vehicleType || '').toUpperCase()) &&
      !resolvedRegion && params.rtoCode) {
    const stName = (require('./policy').STATE_PREFIX_FULL || {})[rtoStatePrefix(params.rtoCode)];
    if (stName) {
      const odP = Number(params.odPremium != null ? params.odPremium : params.od_premium) || 0;
      const tpP = Number(params.tpPremium != null ? params.tpPremium : params.tp_premium) || 0;
      const net = odP + tpP;
      // Cover split (per the iffco TW grid): "Comp & SAOD" uses the COMP rows
      // (17.5% on OD for the 0-1L slab, 20% on Net for Above-1L green states);
      // "Stand Alone TP" uses the SATP row (2.5% green / 0% for the AS,MP,CG,RJ,UP,
      // Rest-MH,KA,TN,KL group). State-group differences are already baked into the
      // ingested per-state rows, so we only pick by cover + premium slab.
      const isSatp = /^(TP|SATP|ACT|LIABILITY)$/i.test(String(params.insProduct || '')) ||
                     (odP === 0 && tpP > 0);
      const slab = net > 100000 ? 'Above 1L' : 'Upto 1L';
      const tKey = lookupKey + '||iffcoTw:' + stName;
      let tRules;
      if (caches.lookup.has(tKey)) tRules = caches.lookup.get(tKey);
      else { tRules = await lookupRates(pool, { insurer: 'iffco_tokio', product: 'TW', region: stName }); caches.lookup.set(tKey, tRules); }
      const isTwSeg = r => /^TW$/i.test(String(r.segment || '').trim());
      const slabRe = new RegExp(slab.replace(/\s+/g, '\\s*'), 'i');
      let tPick;
      if (isSatp) {
        // Standalone TP → the SATP-typed TW row (0 = group-B decline; 2.5 = green).
        tPick = tRules.filter(r => isTwSeg(r) && /SATP/i.test(String(r.rate_type || '')));
      } else {
        // Comp & SAOD → the COMP row for the premium slab.
        tPick = tRules.filter(r => isTwSeg(r) && /COMP/i.test(String(r.rate_type || '')) &&
          slabRe.test(String(r.volume_tier || '')) && Number(r.rate_value) > 0);
      }
      if (tPick.length > 0) {
        const best = tPick.reduce((a, b) => Number(b.rate_value) > Number(a.rate_value) ? b : a);
        rules = [best]; resolvedRegion = stName; params.resolvedRegion = stName;
      }
    }
  }

  // SAOD second-pass — when SAOD-specific patterns yield 0 rules, retry as
  // Comp.  Per user's spec ("if SAOD has no rule, consider COMP for the
  // same combination") — Digit (and others) don't carry a dedicated SAOD
  // rate_type and use Comp's 1+1_MAX_CD2 as the OD-only equivalent.
  //
  // Two-wheeler exception: "SAOD as Comp is not applicable for TW." Insurers do
  // not let a standalone-OD two-wheeler borrow the comprehensive TW commission —
  // a SAOD TW with no dedicated SAOD/OD grid pays 0 (e.g. Royal MH27/5491 Royal
  // Enfield Classic 350: our borrowed Comp 26 vs operator 0). Pvt-Car SAOD still
  // borrows Comp (that fallback stays on for cars), so this is TW-only. Skip the
  // SAOD→Comp retry for two-wheelers so a SAOD TW resolves to no-rule instead of
  // a spurious Comp rate.
  // EXCEPTION — Royal SCOOTERS: Royal pays a scooter SAOD at its Scooter Comp(1+1)
  // rate (no dedicated scooter-SAOD rate_type exists), unlike bikes which genuinely
  // pay 0 for SAOD. USER-confirmed (BG3/5115 Honda Activa SAOD, KA25 → ROKA Scooter
  // Comp 22, op 20; bike SAOD e.g. Enfield Classic 350 stays no-rule/0). So allow
  // the SAOD→Comp borrow for Royal scooters only; all other TW SAOD stays skipped.
  const _saodMdl = String(params.model || '').toUpperCase();
  const _saodCat = String(params.vehicleCategory || params.vehicleClass || '').toUpperCase();
  const _saodIsScooter = /ACTIVA|JUPITER|FASCINO|ACCESS|DIO|BURGMAN|NTORQ|MAESTRO|AVIATOR|PLEASURE|VESPA|SCOOTY|DESTINI|XOOM|\bRAY\b|ALPHA|CHETAK|IQUBE|OLA\s+S\d|ELECTRIC\s*SCOOTER/.test(_saodMdl) || /SCOOT/.test(_saodCat);
  const skipSaodAsComp = productIsTw && !(insurerSlug === 'royal_sundaram' && _saodIsScooter);
  if (rules.length === 0 && baseLookup.ins_product === 'SAOD' && !skipSaodAsComp) {
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
    // Reliance: city-named regions + state-prefix clusters (UP1, UP2, MH1, ...).
    const relianceCandidates = (insurerSlug === 'reliance')
      ? (() => {
          const out = [];
          const cityRaw = String(params.city || params.cityName || params._cityName || '').trim();
          if (cityRaw) out.push(cityRaw.toUpperCase());
          if (stateKey === 'UP') out.push('UP1', 'UP2');
          if (stateKey === 'MH') out.push('MH1', 'MH2');
          return out;
        })()
      : [];
    // Bajaj: TW grids file Delhi under multiple labels including
    // "DELHI&NCR (Including Gurgaon and Faridabad)"; GCV ships SATP under
    // compound region labels bundling border UTs (Gujarat + Daman/Diu/DNH,
    // TN + Lakshadweep, J&K + Ladakh, Assam + Sikkim + NE). The bare
    // state-name region carries only COMP — without these aliases a TP-only
    // policy in those states lands no-rule. Mirrors policy.js bajajCandidates.
    const bajajCandidates = (insurerSlug === 'bajaj_allianz')
      ? (() => {
          const out = [];
          if (stateKey === 'DL') {
            out.push(
              'DELHI&NCR (Including Gurgaon and Faridabad)',
              'DELHI- NCR',
              'DELHI',
              'RTO-DL',
              'New Delhi'
            );
          }
          if (stateKey === 'HR') out.push('Haryana', 'HARYANA (Excluding Gurgaon and Faridabad)', 'Gurgaon', 'Faridabad');
          if (stateKey === 'GJ' || stateKey === 'DD' || stateKey === 'DN') {
            out.push('GUJARAT, Daman & Diu, Dadra & Nagar Haveli', 'GUJARAT');
          }
          if (stateKey === 'TN') out.push('TAMIL NADU, Lakshadweep', 'TAMIL NADU');
          if (stateKey === 'JK' || stateKey === 'LA') out.push('JAMMU & KASHMIR, Ladakh', 'JAMMU & KASHMIR');
          if (stateKey === 'AS') out.push('ASSAM, SIKKIM, 6 OTHER NORTH EASTERN STATES', 'ASSAM');
          const cityRaw = String(params.city || params.cityName || params._cityName || '').trim();
          if (cityRaw) out.push(cityRaw);
          return out;
        })()
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
    let tierCandidates = inferLocationTiers
      ? inferLocationTiers((rtoInfo && rtoInfo.cluster) || resolvedRegion, stateForTiers, insurerSlug)
      : [];
    // Royal Pvt-Car AUTHORITATIVE city tier from the RTO Master's "City
    // Configuration for Private Car" column (Key Cities / Other Cities / Rest of
    // State). The inferLocationTiers heuristic always tries "Other Cities" before
    // "Rest of State", so a true Rest-of-State RTO (e.g. UP70 Allahabad) wrongly
    // headlines the Other Cities rate (19.5) instead of Rest of State (12.5 = op).
    // Prepend the RTO's authoritative tier so the ordered fallback loop hits it
    // first. USER-confirmed (UP1/14971 UP70 → Rest of State 12.5 = op 13).
    // EXCEPTION: Nashik/Nagpur clusters keep the heuristic order (Royal prices
    // them under a dedicated "Nasik & Nagpur" tier, which inferLocationTiers
    // already leads with — the RTO Master labels them "Other Cities").
    if (insurerSlug === 'royal_sundaram' &&
        /^(CAR|4W|PVT)/i.test(String(params.vehicleType || ''))) {
      const _clusterUp = String((rtoInfo && rtoInfo.cluster) || resolvedRegion || '').toUpperCase();
      if (!/^(NASHIK|NASIK|NAGPUR)$/.test(_clusterUp)) {
        const ROYAL_CITY_TIER = require('../config/royal_pvtcar_city_tier.json');
        const _rc = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const _m = _rc.match(/^([A-Z]+)(\d+)$/);
        const _variants = [_rc];
        if (_m) { _variants.push(_m[1] + parseInt(_m[2], 10), _m[1] + String(parseInt(_m[2], 10)).padStart(2, '0')); }
        let _tier = null;
        for (const v of _variants) { if (ROYAL_CITY_TIER[v]) { _tier = ROYAL_CITY_TIER[v]; break; } }
        if (_tier) tierCandidates = [_tier, ...tierCandidates];
      }
    }
    const seen = new Set();
    // Zuno: catch-all regions + Pan India NCB=0/discount-override bucket.
    const zunoCandidates = (insurerSlug === 'zuno')
      ? ["All doable RTO's", "All doable RTO'S", 'Pan India (doable RTOs)']
      : [];
    // TATA: national Pvt Car Package/SAOD (PCI) under "PAN INDIA".
    const tataCandidates = (insurerSlug === 'tata_aig') ? ['PAN INDIA'] : [];
    // Universal Sompo: state region + cluster / city-group variants.
    const usCandidates = (insurerSlug === 'universal_sompo')
      ? ((require('./policy').US_STATE_REGION || {})[stateKey] || [])
      : [];
    // United India Insurance: regions are full state name or specific RTO code.
    const STATE_PREFIX_FULL_LOCAL = require('./policy').STATE_PREFIX_FULL || {};
    const uiiCandidates = (insurerSlug === 'united_india_insurance')
      ? (() => {
          const out = [];
          const rto = String(params.rtoCode || '').trim().toUpperCase();
          if (rto) out.push(rto);
          const fullState = STATE_PREFIX_FULL_LOCAL[stateKey];
          if (fullState) out.push(fullState);
          return out;
        })()
      : [];
    // SBI General: cluster-coded regions (UP - AKLGV / MH - Rest / PB - AJHLG…).
    // Many segments (PCV 3W, School Bus) aren't published in every cluster;
    // fall through to the state's "Rest" clusters and the bare state-name
    // region. Mirrors policy.js sbiCandidates.
    const sbiCandidates = (insurerSlug === 'sbi_general')
      ? (() => {
          const STATE_FAMILIES = {
            UP: ['UP - AKLGV', 'UP - Rest 1', 'UP - Rest 2', 'UTTAR PRADESH', 'UTTAR PRADESH (Eastern)'],
            MH: ['MH - M', 'MH - Rest', 'Mumbai', 'Navi Mumbai', 'Pune', 'RO Maharashtra', 'MAHARASHTRA'],
            GJ: ['GJ - A', 'GJ - S', 'GJ - V', 'GJ - Rest', 'Ahmedabad, Baroda & Surat', 'GUJARAT'],
            PB: ['PB - AJHLG', 'PB - Rest', 'PUNJAB / CHANDIGARH', 'PUNJAB'],
            DL: ['DELHI', 'DL - NCR'],
            KA: ['KA - B', 'Bangalore', 'KARNATAKA'],
            TN: ['TN - C', 'TN - CO', 'TAMIL NADU- Chennai', 'TAMIL NADU- Chennai II', 'TAMIL NADU'],
            TS: ['TS - H', 'TS - Rest 1', 'TS - Rest 2', 'TELANGANA'],
            AP: ['AP - VVK', 'AP - Rest', 'ANDHRA PRADESH'],
            WB: ['WB - K', 'WB - Rest 1', 'WB - Rest 2', 'Kolkata', 'Rest of West Bengal'],
            CH: ['CH - R', 'CH - Rest'],
            CG: ['CG - Tricity'],
            HP: ['HP', 'HIMACHAL PRADESH'],
            JK: ['JK', 'JAMMU AND KASHMIR'],
            JH: ['JH', 'JHARKHAND'],
            BR: ['BR', 'BIHAR'],
            OD: ['ODISHA'],
            RJ: ['RAJASTHAN'],
            GA: ['GA', 'GOA'],
            DD: ['Daman & Diu', 'DADRA AND NAGAR HAVELI'],
            DN: ['DADRA AND NAGAR HAVELI'],
          };
          return STATE_FAMILIES[stateKey] || [];
        })()
      : [];
    // Royal Sundaram TW Comp grid labels the rest-of-state bucket as
    // "<STATE>_OTHERS" (e.g. MAHARASHTRA_OTHERS), but rto_mappings clusters
    // those RTOs as "REST OF <STATE>". The generic MH state fallback tries
    // 'Pune'/'Mum' first and Royal's grid HAS a literal PUNE region, so a
    // genuine rest-of-Maharashtra TW (e.g. MH44) wrongly took the PUNE rate
    // (0.26) instead of MAHARASHTRA_OTHERS (0.22). Map the "REST OF <STATE>"
    // cluster to the correct "_OTHERS" grid region and try it FIRST. TW-scoped
    // so the CAR tier path (Key Cities / Other Cities / Rest of State) is
    // untouched.
    const royalRestCandidates = (insurerSlug === 'royal_sundaram' && productIsTw)
      ? (() => {
          const clu = String((rtoInfo && rtoInfo.cluster) || '').toUpperCase().trim();
          const m = clu.match(/^REST\s+OF\s+(.+)$/);
          if (m) {
            const st = m[1].trim();
            return [st.replace(/\s+/g, '') + '_OTHERS', st + '_OTHERS'];
          }
          return [];
        })()
      : [];
    const candidates = [
      ...royalRestCandidates,
      ...clusterCandidates, ...stateCandidates,
      ...hdfcCandidates, ...iciciCandidates,
      ...relianceCandidates, ...bajajCandidates, ...sbiCandidates,
      ...uiiCandidates, ...zunoCandidates, ...usCandidates, ...tataCandidates,
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
      if (attempt.length === 0 && baseLookup.ins_product === 'SAOD' && !skipSaodAsComp) {
        const fbKeyComp = fbKey + '||saodAsComp';
        if (caches.lookup.has(fbKeyComp)) {
          attempt = caches.lookup.get(fbKeyComp);
        } else {
          attempt = await lookupRates(pool, { ...baseLookup, ins_product: 'Comp', region: r, cluster: '', region_match_mode: 'token' });
          caches.lookup.set(fbKeyComp, attempt);
        }
      }
      // TP-as-Comp 2nd pass — several insurers quote a single Comp rate
      // that covers both OD and TP (UII for GCV/TW, Kotak for TW, IFFCO
      // Tokio). Retry the lookup with ins_product='Comp' so the COMP-only
      // rules surface; the smart filter retains them via the OD-&-TP
      // remarks heuristic / TW family guard.
      if (attempt.length === 0
          && baseLookup.ins_product === 'TP') {
        const fbKeyComp = fbKey + '||kotakTpAsComp';
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

  // Shriram all-region last resort: GCV / MISC / some PCV+CAR rules are filed
  // by internal ZONE labels a state-name region filter can't reach yet. When
  // the state-scoped + national lookup and all fallbacks find nothing, drop the
  // region filter so the scorer can still surface a rule — the pre-state-fix
  // behaviour, so this can never do worse than baseline for those products.
  if (rules.length === 0 && insurerSlug === 'shriram') {
    const fbKey = lookupKey + '||shriramAll';
    let attempt;
    if (caches.lookup.has(fbKey)) {
      attempt = caches.lookup.get(fbKey);
    } else {
      attempt = await lookupRates(pool, { ...baseLookup, region: '', cluster: '', include_null_region: false });
      caches.lookup.set(fbKey, attempt);
    }
    const afterFilter = attempt.length > 0 ? filterRulesByPolicy(attempt, params) : [];
    if (afterFilter.length > 0) rules = afterFilter;
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
    // Prefer a candidate whose remarks/rate_text carry a recoverable hint
    // (IRDA-default rate or an age-band table). When the policy's TP
    // premium is below ₹1L, the IRDA-default remark applies — pick that
    // rule so step (0a) can substitute its rate.
    const polTpForPick = Number(params.tpPremium || 0);
    const hasIrdaHint = (r) => /IRDA[^%]*?[\d.]+\s*%/i.test(String(r.remarks || r.rate_text || ''));
    const hasAgeHint  = (r) => /age/i.test(String(r.rate_text || ''));
    const isNullRate  = (r) => r.rate_value == null;
    const targetRule =
         rules.find(r => isCompLikeRt(r.rate_type) && isNullRate(r) && hasAgeHint(r))
      || rules.find(r => isCompLikeRt(r.rate_type) && isNullRate(r) && hasIrdaHint(r) && polTpForPick < 100000)
      || rules.find(r => isCompLikeRt(r.rate_type) && isNullRate(r))
      || rules.find(r => isNullRate(r) && hasAgeHint(r))
      || rules.find(r => isNullRate(r) && hasIrdaHint(r) && polTpForPick < 100000)
      || rules.find(r => !/CD1/i.test(r.rate_type || '') && !/^FLEXI/i.test(r.rate_type || '') && isNullRate(r));
    const matchedSeg = targetRule ? targetRule.segment : rules[0].segment;
    const wantedRtBase = targetRule ? targetRule.rate_type : (rules[0].rate_type || 'COMP_MAX_CD2');
    // (0) Age-banded conditional cell: rate_text carries the band table (e.g.
    //     "Age 0-5: 7.5%\nAge>=6: 29%") but rate_value is null because the
    //     wide-matrix parser couldn't pick a single number. Parse it at
    //     lookup time and substitute the band that matches the policy's age.
    //     The parser engine now fans these out at parse time for new
    //     uploads — this runtime recovery handles legacy DB rows.
    // (0a) IRDA-default rate parsed from remarks. SBI's TP grid carries
    //      a "Premium below ₹1L — IRDA default applied (SATP 2.5%)" note
    //      in `remarks` but the extractor stored `rate_value=null`. When
    //      the policy's TP premium is below ₹1L (matching the note's
    //      trigger), parse the percentage from the note and substitute it.
    if (targetRule && targetRule.rate_value == null) {
      const remarkBag = [targetRule.remarks, targetRule.rate_text]
        .filter(Boolean).join(' ');
      const polTp = Number(params.tpPremium || 0);
      const irdaMatch = remarkBag.match(/IRDA[^%]*\(\s*\w*\s*([\d.]+)\s*%\s*\)/i)
                     || remarkBag.match(/IRDA[^%]*?([\d.]+)\s*%/i);
      // The remark explicitly conditions on "Premium below ?1L" — only fire
      // when the policy's TP premium is genuinely under 1L. (Tata Magic
      // TP=2094 qualifies.) Otherwise the IRDA-default doesn't apply.
      const belowOneLac = polTp > 0 && polTp < 100000;
      if (irdaMatch && (belowOneLac || !/below\s*[?₹]?\s*1\s*L/i.test(remarkBag))) {
        const pct = parseFloat(irdaMatch[1]);
        if (Number.isFinite(pct) && pct > 0 && pct < 100) {
          targetRule.rate_value = +(pct / 100).toFixed(6);
          targetRule.is_declined = false;
          _rateRecoveryNote = `IRDA-default rate ${pct}% parsed from remarks (TP=${polTp})`;
        }
      }
    }
    // (0) Age-banded conditional cell
    if (targetRule && targetRule.rate_value == null
        && targetRule.rate_text && /age/i.test(targetRule.rate_text)) {
      try {
        const { parseAgeBandedRates } = require('../parsers/engines/wide-matrix');
        const bands = parseAgeBandedRates ? parseAgeBandedRates(targetRule.rate_text) : null;
        const polAge = params.vehicleAge;
        if (bands && polAge != null) {
          const hit = bands.find(b =>
            (b.vehicle_age_min == null || polAge >= b.vehicle_age_min) &&
            (b.vehicle_age_max == null || polAge <= b.vehicle_age_max)
          );
          if (hit) {
            targetRule.rate_value = hit.rate_value;
            targetRule.is_declined = false;
            _rateRecoveryNote = `Age-banded cell parsed at lookup — age ${polAge} → ${(hit.rate_value * 100).toFixed(2)}% (band ${hit.vehicle_age_min}–${hit.vehicle_age_max ?? '∞'})`;
          }
        }
      } catch (_) { /* fall through */ }
    }
    // (1) cross-region: same segment + non-null rate in any other region.
    //     Skip when step (0) already substituted a rate for the target rule.
    if (rules.find(r => r.rate_type === wantedRtBase && r.rate_value == null)) {
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
    }
    // (2) SATP fallback for Comp policies — if the rule still has null rate
    if (rules.find(r => r.rate_type === wantedRtBase && r.rate_value == null)) {
      let satpRule = rules.find(r => /SATP/i.test(r.rate_type || '') && r.rate_value != null);
      // Most Comp lookups have already had SATP rules dropped by the smart
      // filter (`ip='Comp'` → drop SATP_*), so the in-memory `rules` array
      // doesn't carry them. Look the SATP sibling up directly in the same
      // region+segment when no in-memory candidate exists. Digit's wide-
      // matrix grid is the common case: COMP_MAX_CD2 is null but SATP_MAX_CD2
      // is populated — we use the SATP rate as the Comp proxy with a clear
      // recovery note.
      if (!satpRule) {
        try {
          const r2 = await pool.request()
            .input('ins',  sql.NVarChar(100), insurerSlug)
            .input('seg',  sql.NVarChar(300), matchedSeg)
            .input('reg',  sql.NVarChar(200), resolvedRegion || '')
            .query(`SELECT TOP 1 rate_type, rate_value FROM rate_rules
                    WHERE insurer = @ins AND segment = @seg AND region = @reg
                      AND rate_value IS NOT NULL
                      AND rate_type LIKE 'SATP%'
                    ORDER BY id ASC`);
          if (r2.recordset.length > 0) {
            satpRule = r2.recordset[0];
          }
        } catch (_) { /* fall through */ }
      }
      if (satpRule) {
        const target = rules.find(r => r.rate_type === wantedRtBase);
        if (target) {
          target.rate_value = Number(satpRule.rate_value);
          target.is_declined = false;
          _rateRecoveryNote = `Comp not quoted for ${resolvedRegion} / ${matchedSeg} — using SATP rate (${(satpRule.rate_value * 100).toFixed(2)}%) as proxy`;
        }
      }
    }
    // (3) After both recoveries, if still null → mark declined
    if (rules.find(r => r.rate_type === wantedRtBase && r.rate_value == null)) {
      _isDeclined = true;
      _rateRecoveryNote = `Declined by ${insurerSlug} for ${resolvedRegion} / ${matchedSeg} — Comp not offered`;
    }
  }

  // Shriram RTO-level decline: a grid row can carry a UW remark listing
  // specific RTO districts as declined/excluded, e.g.
  //   "UP 70, 75, 79, 82, 84, 95 IS DECLINED | UP 11 EXCLUDED (PART OF UK-RSD)"
  // When the policy's RTO is one of those, the insurer won't write it — so the
  // policy is DECLINED. Force a null-rate (declined) output rather than rating
  // it OR falling back to another region's rule. `rules` here is already the
  // policy-filtered candidate set, so any surviving decline remark genuinely
  // applies to this policy's segment/weight/region. Operator pays zero on these,
  // so a null rate is scored as agreement by the recompare.
  if (insurerSlug === 'shriram' && rules.length > 0 &&
      rules.some(r => shriramRtoDeclined(r.remarks || r.rate_text, params.rtoCode))) {
    let stmtD = null, prD = null;
    const keyD = String(params._policy_no || '').trim().toUpperCase();
    if (keyD) {
      if (statementIndex) stmtD = statementIndex.get(keyD) || null;
      if (prIndex) {
        prD = prIndex.get(keyD) || null;
        if (!prD) for (const stripped of policyKeyVariants(keyD)) { prD = prIndex.get(stripped); if (prD) break; }
      }
    }
    const noteD = `Declined by shriram — RTO ${params.rtoCode} excluded/declined under UW remarks`;
    return buildOutputRow(policy, params, null, null, null, null, noteD, stmtD, prD);
  }

  // Shriram TW Bike — Maharashtra rate-region fix. The Shriram Bike grid carries
  // THREE overlapping Maharashtra region definitions (different source sheets,
  // conflicting values): "MUMBAI (Excl MH-01,48)/GOA"=35, "ROM"=25, and
  // "MUMBAI (Excl MH-01,48)/ROM/GOA"=20. Region resolution lands rural-MH bikes
  // on plain "ROM" (25), but the operator pays 35 to ALL Maharashtra bikes —
  // verified vs operator file (cycle 12+11): 21/21 MH bikes paid 35/40, NONE at
  // 20/25, across rural districts (MH39/MH28/MH21/MH30/MH18) not just Mumbai. Bump
  // every Bike PACK rule below 35 to 35 so whichever tenure variant pickPrimary
  // selects carries the operator-correct rate. Scoped to Shriram + TW + Bike + MH
  // state (Gujarat 38 and all other insurers untouched); zero-regression because
  // no MH bike is paid 20/25 and an already-35 rule is left alone. SATP bike rows
  // (SATP_SHRIRAM, separate cover) are NOT touched.
  if (insurerSlug === 'shriram' &&
      String(params.vehicleType || '').toUpperCase() === 'TW' &&
      String(rtoStatePrefix(params.rtoCode) || '').toUpperCase() === 'MH' &&
      rules.length > 0) {
    rules = rules.map(r =>
      (/bike/i.test(String(r.sub_type || r.segment || '')) &&
       /PACK_SHRIRAM/i.test(String(r.rate_type || '')) &&
       Number(r.rate_value) < 35)
        ? { ...r, rate_value: 35, _mhBikeOverride: true }
        : r);
  }

  // Kotak MISC Tractor — Uttar Pradesh uniform top-tier. Kotak's tractor grid is
  // district-tiered (0.30-0.475); within UP it splits western-UP/Kanpur-Lucknow
  // (0.47-0.475) vs eastern-UP districts (0.40, e.g. Sultanpur/Jaunpur/Ayodhya/
  // Ambedkar Nagar/Amethi/Barabanki). But the operator pays ~48 to ALL UP tractors
  // — verified vs operator file (cycle 12+11): 6/6 western-UP (0.475) match 48,
  // 12/12 eastern-UP (0.40) miss at 48. So the eastern-UP 0.40 tier is too low;
  // bump every UP tractor COMP rule below 0.475 up to 0.475 (→47.5, within ±0.5 of
  // 48). The already-0.475 western-UP rows are left alone (zero-regression). Scoped
  // Kotak + MISC + Tractor + UP state; other states (no tractor data) untouched.
  if (insurerSlug === 'kotak' &&
      String(params.vehicleType || '').toUpperCase() === 'MISC' &&
      String(rtoStatePrefix(params.rtoCode) || '').toUpperCase() === 'UP' &&
      rules.length > 0) {
    rules = rules.map(r =>
      (/tractor/i.test(String(r.segment || '')) &&
       /^COMP$/i.test(String(r.rate_type || '')) &&
       Number(r.rate_value) < 0.475)
        ? { ...r, rate_value: 0.475, _kotakUpTractorOverride: true }
        : r);
  }

  // Royal Sundaram EV STP grid (sheet "EV STP", region "All Geos"): a flat
  // standalone-TP commission for ELECTRIC vehicles, split by class —
  //   PCV 3-wheeler (= E-Rickshaw) 0.54 | PCV 4-wheeler 0.47 |
  //   Two Wheeler 0.50 | Goods Carrying Garbage vehicle 0.65 (all SATP_BAC).
  // These rows live under the quasi-region "All Geos", which the region gate
  // never tries — so an electric E-Rickshaw on a standalone-TP policy can't
  // reach them and falls through to the zero-rate generic "PCV Auto 0-3
  // Seater" SATP. Inject the correct EV-STP row when the policy is Royal +
  // electric + standalone-TP AND no real (non-zero) STP rate otherwise
  // matched, so a policy that already prices correctly is never overridden.
  if (insurerSlug === 'royal_sundaram') {
    const fu  = String(params.fuelType || '').toUpperCase();
    const cat = String(params.vehicleCategory || params.vehicleClass || '').toUpperCase();
    const mdl = String(params.model || '').toUpperCase();
    const ip  = String(params.insProduct || '').toUpperCase();
    const isElectric = /ELECTRIC|BATTERY|\bEV\b/.test(fu) ||
                       /E-?RIKSHAW|E-?RICKSHAW|E-?CART/.test(cat + ' ' + mdl);
    const isStandaloneTp = ip === 'TP' || (Number(params.odPremium) || 0) === 0;
    const cur = pickPrimaryRateRule(rules);
    const curRate = cur ? Number(cur.rate_value) : 0;
    if (isElectric && isStandaloneTp && !(curRate > 0)) {
      const vt = String(params.vehicleType || '').toUpperCase();
      const isRick = /RIKSHAW|RICKSHAW|E-?RICK|E-?RIK|\b3W\b|3\s*WHEEL|TREO|PCV3W?/.test(cat + ' ' + mdl);
      let wantSeg = null;
      if (vt === 'PCV')      wantSeg = isRick ? 'PCV - 3 wheeler' : 'PCV - 4 wheeler';
      else if (vt === 'TW')  wantSeg = 'Two Wheeler';
      else if (vt === 'GCV' && /GARBAGE/.test(cat + ' ' + mdl)) wantSeg = 'Goods Carrying Garbage vehicle';
      if (wantSeg) {
        try {
          const evKey = 'royalEvStp::' + wantSeg;
          let evRows;
          if (caches.lookup.has(evKey)) {
            evRows = caches.lookup.get(evKey);
          } else {
            const er = await pool.request()
              .input('seg', sql.NVarChar(200), wantSeg)
              .query(`SELECT TOP 1 * FROM rate_rules
                      WHERE insurer = 'royal_sundaram' AND sheet_name = 'EV STP'
                        AND region = 'All Geos' AND segment = @seg
                        AND rate_value IS NOT NULL
                      ORDER BY id ASC`);
            evRows = er.recordset;
            caches.lookup.set(evKey, evRows);
          }
          if (evRows && evRows.length > 0) rules = [...rules, evRows[0]];
        } catch (_) { /* leave rules unchanged on lookup failure */ }
      }
    }
  }

  // Royal Sundaram E-Rickshaw PACKAGE grid: an electric 3W passenger E-Rickshaw
  // on a Comp/package policy prices off the dedicated "3W E-Rickshaw" Comp_PACKAGE
  // rows — Delhi NCR 37.5 | Tamil Nadu 35 | Pan India (rest) 40 — NOT the generic
  // regional "3W PCV Auto 0-3 Seater" Comp_BAC. Those E-Rickshaw rows live under
  // region "Pan India"/"Delhi NCR"/"Tamil Nadu" and are only reached by the
  // 0-rule fallback, which never fires when the resolved region happens to carry
  // a generic "3W PCV Auto" row (e.g. Nagpur = 0.20). So an e-rickshaw in such a
  // region wrongly takes the generic auto rate (MH49/Nagpur: our 0.20 vs operator
  // 0.40). Inject the region-correct E-Rickshaw Comp_PACKAGE row and drop the
  // generic "3W PCV Auto" rows so it wins pickPrimary's id-order pick. Royal +
  // electric + E-Rickshaw + package (od>0) only; skipped when a dedicated
  // E-Rickshaw package row already survived (the fallback path — UK e-rickshaws),
  // so already-correct policies are never disturbed.
  if (insurerSlug === 'royal_sundaram') {
    const fu  = String(params.fuelType || '').toUpperCase();
    const cat = String(params.vehicleCategory || params.vehicleClass || '').toUpperCase();
    const mdl = String(params.model || '').toUpperCase();
    const hay = cat + ' ' + mdl;
    const isElectric = /ELECTRIC|BATTERY|\bEV\b/.test(fu) ||
                       /E-?RIKSHAW|E-?RICKSHAW|E-?CART/.test(hay);
    const isERick = /E-?RIKSHAW|E-?RICKSHAW|E-?RICK|E-?RIK/.test(hay);
    const isPackage = (Number(params.odPremium) || 0) > 0;
    const hasERickRow = rules.some(r =>
      /E-?RICKSHAW/i.test(String(r.segment || '')) &&
      /PACKAGE/i.test(String(r.rate_type || '')));
    if (isElectric && isERick && isPackage && !hasERickRow) {
      const st    = String(resolvedRegion || '').toUpperCase();
      const rtoSt = String(params.rtoCode || '').toUpperCase().slice(0, 2);
      let evSeg, evReg;
      if (rtoSt === 'DL' || /DELHI|NCR/.test(st)) {
        evSeg = '3W E-Rickshaw Delhi NCR';  evReg = 'Delhi NCR';
      } else if (rtoSt === 'TN' || /TAMIL\s*NADU|CHENNAI/.test(st)) {
        evSeg = '3W E-Rickshaw Tamil Nadu'; evReg = 'Tamil Nadu';
      } else {
        evSeg = '3W E-Rickshaw Pan India (except Delhi NCR/Tamil Nadu)'; evReg = 'Pan India';
      }
      try {
        const rkKey = 'royalERickPkg::' + evReg;
        let rkRows;
        if (caches.lookup.has(rkKey)) {
          rkRows = caches.lookup.get(rkKey);
        } else {
          const rr = await pool.request()
            .input('seg', sql.NVarChar(200), evSeg)
            .input('reg', sql.NVarChar(100), evReg)
            .query(`SELECT TOP 1 * FROM rate_rules
                    WHERE insurer = 'royal_sundaram' AND region = @reg
                      AND segment = @seg AND rate_type = 'Comp_PACKAGE'
                      AND rate_value IS NOT NULL
                    ORDER BY id ASC`);
          rkRows = rr.recordset;
          caches.lookup.set(rkKey, rkRows);
        }
        if (rkRows && rkRows.length > 0) {
          rules = rules.filter(r => !/3W\s*PCV\s*AUTO|PCV\s*AUTO/i.test(String(r.segment || '')));
          rules = [...rules, rkRows[0]];
        }
      } catch (_) { /* leave rules unchanged on lookup failure */ }
    }
  }

  // Royal Sundaram two-wheeler CC-band gate: the Royal TW grid publishes ONLY a
  // "Bike <150CC" band (plus Scooter) — there is NO >150CC two-wheeler band, and
  // the operator pays 0 commission on a >150cc bike. But the "<150CC" rules carry
  // no CC column, so a 220cc bike (e.g. Bajaj Pulsar 220) still matched "Bike
  // <150CC ..." and borrowed the 26% rate. Drop the <150CC-segment rules when the
  // policy's engine CC exceeds 150 so the bike resolves to no-rule (= operator 0).
  if (insurerSlug === 'royal_sundaram' && productIsTw) {
    const ccNum = Number(params.cc) || 0;
    if (ccNum > 150) {
      rules = rules.filter(r => !/<\s*150\s*CC/i.test(String(r.segment || '')));
    }
  }

  // Bajaj Allianz Pvt-Car Comprehensive — MH / GJ / DD / DN region grid
  // (ROBINHOOD product 1801). The Bajaj "PC" grid (sheet "PC" in the Pvt-car-comp
  // .xlsb) files an MH&GJ-specific Comprehensive payout that was NEVER ingested:
  // the "PVT car Comprehensive & STOD" sheet has NO Gujarat/Maharashtra rows, so
  // GJ/MH cars fall through to the flat Pan-India COMP 0.40. The real MH&GJ grid
  // (CD up to 80% DTD) is: With-NCB (any fuel / HEV) = 0.45; Without-NCB Petrol =
  // 0.45; Without-NCB Diesel / HEV / other = 0.10. Inject the correct COMP rate
  // (drop the Pan-India COMP fallback so it wins pickPrimary's first-of-pool pick).
  // Scoped to product 1801 + MH/GJ/DD/DN, so no other Bajaj car is touched.
  // Verified: 8 With-NCB → 45, 3 Without-NCB Diesel → 10, all = operator.
  // (The grid's CD>80% rows — With-NCB 0.15 / Non-NCB Diesel 0.10 / Petrol 0.15 —
  // are not applied: Bajaj OD-discount isn't wired into params and every observed
  // MH/GJ 1801 car is ≤80% DTD. Revisit if a >80%-DTD MH/GJ 1801 car appears.)
  // Bajaj GCV >43T (Gujarat) Comp rate fix. The ingested Gujarat "GCV4W more than
  // 43T" COMP row is 0.195, but the operator uniformly pays 0.15 (= the Mumbai
  // >43T COMP value — the representative national rate; Gujarat's 0.195 is the
  // ingest outlier). Verified vs operator file (cycle 12+11): 28/28 GJ >43T Comp
  // paid exactly 15, NONE at 19.5 → zero-regression. Scoped to Bajaj + GCV +
  // "more than 43T" + COMP + GJ state (SATP >43T rows and other states untouched).
  if (insurerSlug === 'bajaj_allianz' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV' &&
      String(rtoStatePrefix(params.rtoCode) || '').toUpperCase() === 'GJ' &&
      rules.length > 0) {
    rules = rules.map(r =>
      (/more than 43T/i.test(String(r.segment || '')) &&
       /^COMP$/i.test(String(r.rate_type || '')) &&
       Number(r.rate_value) > 0.15)
        ? { ...r, rate_value: 0.15, _bajaj43tOverride: true }
        : r);
  }

  // ---- Bajaj Pvt-Car Comprehensive — authoritative ROBINHOOD 1801 state grid ----
  // Source: "Private Car- Complete Grid- .xlsx" sheet "1801" — a per-RTO-STATE
  // grid (rate % on OD) by fuel x NCB, NOT zoned. services/bajaj-car.js resolves
  // rtoCode → grid-state (via the file's RTO Master, with Gurgaon/Faridabad/
  // Bangalore/Chennai/Hyderabad metros excluded → default) and the rate.
  // This REPLACES the earlier hand-derived MH&GJ(0.45) / Rajasthan(0.30) /
  // Delhi-"Zone-1"(0.30) overrides — the last was a FABRICATED borrow of the HDFC
  // ROBINHOOD zone structure (no Bajaj sheet has zones; user-flagged). Default 40
  // (operator pays 40, not the grid's printed 45 ceiling). Dry-run vs operator on
  // the 23 product-1801 CAR cars: +9 net (default 40) — the 4 op-45 GJ/MH cars are
  // operator inconsistency (same RTO pays both 40 and 45). CD>80% cap / OEM-min /
  // UP-West-IRDA are NOT modelled (no CD/OEM data); UP-NCB approximated to 35.
  if (insurerSlug === 'bajaj_allianz' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      /-1801-/.test(String(params._policy_no || '')) && rules.length) {
    try {
      const { resolveBajajCarRate } = require('../services/bajaj-car');
      const br = resolveBajajCarRate(params);
      if (br != null) {
        const compRules = rules.filter(r => /^COMP$/i.test(String(r.rate_type || '')));
        const base = compRules[0] || rules[0];
        if (base) {
          const clone = { ...base, rate_type: 'COMP', rate_value: br,
                          sheet_name: '1801', segment: 'Pvt Car Comprehensive (1801 grid)' };
          rules = [clone, ...rules.filter(r => !/^COMP$/i.test(String(r.rate_type || '')))];
        }
      }
    } catch (_) { /* leave rules unchanged on any failure */ }
  }

  // ---- HDFC Pvt-Car Zone × Fuel × NCB override ----
  // HDFC's ROBINHOOD Pvt-Car grid is Zone-1/Zone-2 × (Petrol vs Non-Petrol) ×
  // (NCB vs No-NCB), but the 4 fuel/NCB columns were mis-ingested as AGE bands
  // (age=0→0.195 / age≥1→0.30), so the engine keyed CAR rate off age. Recompute
  // the correct rate from the authoritative grid:
  //   Zone-1 base 0.30, Zone-2 base 0.275; Non-Petrol(Diesel/CNG/LPG) + No-NCB
  //   + not-New → 0.195 (both zones). Petrol/EV/Hybrid use the Petrol grid (=base);
  //   New Business counts as NCB. Zone from region/RTO-state (Geography Groupings):
  //   most states are whole-zone; GJ (Ahmedabad/Vadodara/Daman/DNH=Z1, rest=Z2),
  //   KA (Bangalore=Z1, rest=Z2), TN/Kerala/Chhattisgarh/Mizoram/Haryana/HP/Punjab/
  //   UP/UK/J&K/Chandigarh/MP/Rajasthan=Z2, Assam-Nagaon=Z2; everything else Z1.
  if (insurerSlug === 'hdfc_ergo' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR') {
    const ip = String(params.insProduct || '').toUpperCase();
    if (ip === 'COMP' || ip === 'SAOD') {
      const st  = String(rtoStatePrefix(params.rtoCode) || '').toUpperCase();
      const reg = String(resolvedRegion || '').toUpperCase();
      const ZONE2 = new Set(['CG','CH','MZ','KL','HR','HP','PB','UP','UA','UK','JK','MP','RJ','TN','PY']);
      let zone;
      if (st === 'GJ')      zone = /AHMEDABAD|VADODARA|BARODA|DAMAN|DADRA|GANDHINAGAR/.test(reg) ? 1 : 2;
      else if (st === 'KA') zone = /BANGALORE|BENGALURU/.test(reg) ? 1 : 2;
      else if (st === 'AS') zone = /NAGAON/.test(reg) ? 2 : 1;
      else                  zone = ZONE2.has(st) ? 2 : 1;
      const fuel = String(params.fuelType || '').toUpperCase();
      const nonPetrol = /DIESEL|CNG|LPG/.test(fuel) && !/PETROL|EV|ELECTRIC|HYBRID/.test(fuel);
      // The grid notes "New Business = NCB", but the operator's actual payments
      // contradict it (new-business diesel NCB=0 cars were paid the No-NCB 0.195,
      // not the NCB base) — so gate on ACTUAL NCB only to match the operator.
      const hasNCB = (Number(params.ncbPct) || 0) > 0;
      const zoneBase = zone === 1 ? 0.30 : 0.275;
      const target = (nonPetrol && !hasNCB) ? 0.195 : zoneBase;
      const want = ip === 'SAOD' ? 'SAOD' : 'COMP';
      const base = rules.find(r => String(r.rate_type || '').toUpperCase() === want) || rules[0];
      if (base) {
        const clone = { ...base, rate_type: want, rate_value: target,
                        segment: 'Pvt Car Robinhood', sub_type: 'Zone-' + zone,
                        cc_band_min: null, cc_band_max: null, age_band_min: null, age_band_max: null };
        rules = [clone, ...rules.filter(r => String(r.rate_type || '').toUpperCase() !== want)];
      }
    } else if (ip === 'TP' || ip === 'SATP') {
      // HDFC Pvt-Car SATP grid lists only metros (Mumbai/Pune/Surat/… have their
      // own rows) plus state catch-alls (Maharashtra/Gujarat/…). Rest-of-state
      // cities (Nashik/Satara/Kolhapur…) have NO own row and must roll up to the
      // state rate (e.g. Nashik Petrol-1000+ → "Maharashtra" 0.45, NOT the
      // Mumbai/Pune 0.60). config/hdfc_satp_region.json (built from the RTO
      // Master "Pvt Car TP RTO" sheet: location→cluster/state, rolled to the SATP
      // grid's regions) maps ONLY those rest-of-state locations — metros are
      // absent so they stay as-is (no Surat-style regression).
      let satpMap = null;
      try { satpMap = require('../config/hdfc_satp_region.json'); } catch (_) { satpMap = {}; }
      // Use the ORIGINAL RTO cluster (rtoInfo.region), not resolvedRegion — the
      // latter is mutated by the cluster-fallback (~L1190): a rest-of-state city
      // like "Nashik" has no SATP grid row, so the fallback broadens and grabs a
      // metro row (Pune), overwriting the real RTO region. rtoInfo.region keeps
      // the authoritative "Nashik" we need to roll up to "Maharashtra".
      const rawReg = (rtoInfo && rtoInfo.region) || resolvedRegion;
      const key = String(rawReg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const satpRegion = key && satpMap[key];
      if (satpRegion && satpRegion.toUpperCase() !== String(rawReg || '').toUpperCase()) {
        const fuel = String(params.fuelType || '').toUpperCase();
        const fcol = /DIESEL/.test(fuel) ? 'Diesel' : (/CNG|LPG/.test(fuel) ? 'CNG' : 'Petrol');
        const cc = Number(params.cc) || 0;
        try {
          const sr = await pool.request()
            .input('reg', sql.NVarChar(200), satpRegion)
            .input('f', sql.NVarChar(50), fcol)
            .input('cc', sql.Int, cc)
            .query(`SELECT TOP 1 * FROM rate_rules
                    WHERE insurer LIKE '%hdfc%' AND segment LIKE '%Pvt Car%' AND rate_type='SATP'
                      AND region=@reg AND fuel_type=@f
                      AND (@cc BETWEEN cc_band_min AND cc_band_max OR cc_band_min IS NULL)
                    ORDER BY cc_band_min DESC`);
          if (sr.recordset.length) {
            const b = sr.recordset[0];
            const clone = { ...b, rate_type: 'SATP', segment: 'Pvt Car SATP' };
            rules = [clone, ...rules.filter(r => String(r.rate_type || '').toUpperCase() !== 'SATP')];
          }
        } catch (_) { /* leave rules unchanged on lookup failure */ }
      }
    }
  }

  // ---- SBI Pvt-Car Comp volume-tier "take max" ----
  // SBI's Pvt-Car Comp grid bands the rate by volume_tier "Below 1L / 1L-25L /
  // Above 25L" — which is TOTAL PREMIUM (not IDV) and isn't reliably derivable
  // here, so the engine's tier filter can land on a lower band (e.g. GJ-S
  // 1L-25L=0.28 when the operator paid the Above-25L 0.30). Per direction: ignore
  // the tier and take the MAX Comp rate for the region (the operator pays the top
  // band almost always — matched SBI CAR Comp are all at-region-max). Excludes the
  // "Below 1L" IRDA-default rows. SBI-CAR-COMP scoped.
  if (insurerSlug === 'sbi_general' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      String(params.insProduct || '').toUpperCase() === 'COMP' && rules.length) {
    try {
      const regions = [resolvedRegion, rtoInfo && rtoInfo.cluster, rtoInfo && rtoInfo.region]
        .filter(Boolean).map(String);
      if (regions.length) {
        const reqM = pool.request();
        const inList = regions.map((r, i) => { reqM.input('mr' + i, sql.NVarChar(200), r); return '@mr' + i; }).join(',');
        const mr = await reqM.query(`SELECT MAX(rate_value) AS mx FROM rate_rules
          WHERE insurer LIKE '%sbi%' AND segment LIKE '%Pvt Car%' AND rate_type='COMP'
            AND region IN (${inList}) AND rate_value IS NOT NULL
            AND (remarks IS NULL OR remarks NOT LIKE '%IRDA%')`);
        const mx = mr.recordset[0] && mr.recordset[0].mx;
        if (mx != null) {
          const base = rules.find(r => String(r.rate_type || '').toUpperCase() === 'COMP') || rules[0];
          if (base) {
            const clone = { ...base, rate_type: 'COMP', rate_value: mx, volume_tier: null,
              segment: 'Pvt Car (SBI max-tier)' };
            rules = [clone, ...rules.filter(r => String(r.rate_type || '').toUpperCase() !== 'COMP')];
          }
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- SBI Pvt-Car SATP MH-N null-CC-band decline ----
  // SBI's MH-N (Nagpur/Vidarbha) Pvt-Car SATP grid declines whole CC bands — cc 0-1000 is
  // ENTIRELY null = declined (operator their=0: MH22/4900 cc998, 4973/4988 cc796, all MH-N).
  // The generic engine, finding MH-N's own cc band null, borrows another region's rate (even
  // a Mumbai 52% for cc796). SCOPED to cluster MH-N + CAR + Liability: query MH-N's OWN
  // current-card SATP rate for the policy's cc band; if MH-N has ZERO non-null rate there →
  // DECLINE (no-rule). Bands where MH-N IS rated (cc1001-1500/1501+, where many policies are
  // operator-paid 39-45) keep the engine's rate untouched → no regression.
  if (insurerSlug === 'sbi_general' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      (Number(params.odPremium) === 0 || /^(TP|SATP|ACT)$/i.test(String(params.insProduct || ''))) &&
      rtoInfo && /^MH\s*-\s*N$/i.test(String(rtoInfo.cluster || '')) && rules.length) {
    try {
      const cc = Number(params.cc) || 0;
      // Map policy fuel → SBI fuel_type column value (the MH-N grid declines cc1001-1500
      // for Diesel/CNG/LPG but pays Petrol/EV/Hybrid — fuel must gate the decline).
      const _f = String(params.fuelType || '').toUpperCase();
      const fuelCol = /DIESEL/.test(_f) ? 'Diesel' : /PETROL/.test(_f) ? 'Petrol' :
        /CNG/.test(_f) ? 'CNG' : /LPG/.test(_f) ? 'LPG' :
        /ELECTRIC|\bEV\b|BATTERY/.test(_f) ? 'EV' : /HYBRID/.test(_f) ? 'Hybrid' : null;
      const satpRule = rules.find(r => /SATP/i.test(String(r.rate_type || '')) && /Pvt\s*Car/i.test(String(r.segment || '')));
      if (satpRule && cc > 0) {
        const mnKey = lookupKey + '||sbiMhnSatp:' + cc + ':' + (fuelCol || '');
        let hasRate;
        if (caches.lookup.has(mnKey)) hasRate = caches.lookup.get(mnKey);
        else {
          const mr = await pool.request().input('cc', sql.Int, cc).input('fuel', sql.NVarChar(20), fuelCol)
            .query(`SELECT TOP 1 rr.rate_value FROM rate_rules rr JOIN rate_cards rc ON rr.rate_card_id = rc.id
                    WHERE rr.insurer='sbi_general' AND rr.region='MH - N' AND rr.segment LIKE '%Pvt Car%SATP%'
                      AND rr.rate_type='SATP' AND rr.rate_value IS NOT NULL
                      AND rr.cc_band_min <= @cc AND rr.cc_band_max >= @cc
                      AND (@fuel IS NULL OR rr.fuel_type = @fuel)
                      AND (rr.remarks IS NULL OR rr.remarks NOT LIKE '%IRDA%')`);
          hasRate = mr.recordset.length > 0;
          caches.lookup.set(mnKey, hasRate);
        }
        if (!hasRate) {
          rules = [{ ...satpRule, rate_value: 0, is_declined: 1,
            segment: (satpRule.segment || 'Pvt Car SATP') + ' (SBI MH-N ≤CC declined)' }];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- SBI GCV MH cluster rollup (MH-N / MH-P → MH-Rest) ----
  // SBI's rto_mappings split Maharashtra into clusters MH-M / MH-N / MH-P /
  // MH-Rest, but the SBI GCV grid only carries MH-M and MH-Rest rows — so an
  // MH-N (Nagpur) / MH-P (Pune) GCV policy has no grid row and falls back to
  // MH-M (Mumbai-metro, the higher rate). Per direction, roll the unlisted MH
  // clusters to MH-Rest (rest-of-Maharashtra). Re-query the SAME segment's MH-Rest
  // rates and take the max (the MH-Rest cell carries a few values; the top band
  // is what applies). SBI-GCV-MH scoped — other regions/products untouched.
  if (insurerSlug === 'sbi_general' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV' &&
      rtoInfo && /^MH\s*-\s*[NP]$/i.test(String(rtoInfo.cluster || '')) && rules.length) {
    try {
      // GCV 3W only — GCV 4W in MH-N/MH-P already match correctly via the MH-M
      // fallback at their specific band, so the MH-Rest-max roll would regress
      // them. The 3W cell is the one that mis-defaults to the MH-M high rate.
      const segRule = rules.find(r => /GCV\s*3\s*W/i.test(String(r.segment || '')));
      const seg = segRule && segRule.segment;
      const rt  = (segRule && segRule.rate_type) || 'COMP';
      if (seg) {
        const mr = await pool.request()
          .input('seg', sql.NVarChar(200), seg)
          .input('rt',  sql.NVarChar(50), rt)
          .query(`SELECT MAX(rate_value) AS mx FROM rate_rules
                  WHERE insurer LIKE '%sbi%' AND segment=@seg AND rate_type=@rt
                    AND region='MH - Rest' AND rate_value IS NOT NULL
                    AND (remarks IS NULL OR remarks NOT LIKE '%IRDA%')`);
        const mx = mr.recordset[0] && mr.recordset[0].mx;
        if (mx != null) {
          const clone = { ...segRule, rate_value: mx, region: 'MH - Rest',
            segment: seg + ' (SBI MH-Rest)' };
          rules = [clone, ...rules.filter(r => r !== segRule)];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- SBI GCV Maharashtra region routing (RTO-master authoritative) ----
  // SBI's GCV rate grid ("A&B Cat Broker" sheet) has only TWO Maharashtra region
  // rows: Mumbai/Navi-Mumbai (Circle "Mumbai metro") and Pune/RO-Maharashtra/Goa
  // (Circle "Maharashtra"). There is NO Nagpur/MH-N row — so per the SBI RTO
  // master, the non-Mumbai clusters (MH-N Nagpur/Vidarbha, MH-P Pune, MH-Rest) all
  // roll into "RO Maharashtra" (= region "MH - Rest", schedule lower than metro),
  // and only genuine Mumbai (cluster MH-M) takes the "Mumbai metro" schedule. The
  // old code wrongly let MH-N fall back to the MH-M grid and take its "Maharashtra"
  // sub_type (a HIGHER schedule, e.g. 2.5T max 0.675 vs RO-Maharashtra 0.65).
  // Fix: route by cluster to the correct region+sub and take the band max (the
  // volume_tier within is total premium — not derivable, operator pays top band).
  // Excludes IRDA rows and 3W (the MH-N/MH-P→MH-Rest block above owns 3W).
  if (insurerSlug === 'sbi_general' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV' &&
      rtoInfo && /^MH\b/i.test(String(rtoInfo.cluster || '')) && rules.length) {
    try {
      // Accept the Maharashtra REGION ALIASES too (the SBI GCV grid stores rows under raw
      // labels "Pune" / "Mumbai" / "Navi Mumbai" / "Maharashtra" that alias to MH-M/MH-Rest).
      // Without these a Nagpur (MH-N) GCV that matched the "Pune" alias 0.675 never got routed
      // to its correct MH-Rest 0.65 (MH22/5010 etc. their=65). tgtReg is still driven by the
      // rto-master cluster (MH-M = Mumbai metro, else MH-Rest), so the alias only enables the find.
      const segRule = rules.find(r => /^(MH - M|MH - Rest|RO Maharashtra|Pune|Mumbai|Navi\s*Mumbai|Maharashtra)$/i.test(String(r.region || ''))
        && /GCV/i.test(String(r.segment || ''))
        && !/GCV\s*3\s*W/i.test(String(r.segment || '')));
      if (segRule) {
        const isMumbai = /^MH\s*-\s*M$/i.test(String(rtoInfo.cluster));
        const tgtReg = isMumbai ? 'MH - M' : 'MH - Rest';
        const tgtSub = isMumbai ? 'Mumbai metro' : 'Maharashtra';
        const reqM = pool.request()
          .input('reg', sql.NVarChar(100), tgtReg)
          .input('seg', sql.NVarChar(200), segRule.segment)
          .input('rt',  sql.NVarChar(50), String(segRule.rate_type || 'COMP'))
          .input('sub', sql.NVarChar(100), tgtSub)
          .input('age', sql.Int, Number(params.vehicleAge) || 0);
        let wtClause = '';
        if (segRule.weight_band_min != null && segRule.weight_band_max != null) {
          reqM.input('wmin', sql.Float, segRule.weight_band_min);
          reqM.input('wmax', sql.Float, segRule.weight_band_max);
          wtClause = ' AND weight_band_min=@wmin AND weight_band_max=@wmax';
        }
        // Respect the vehicle-AGE band: the MH-Rest GCV rows are age-banded (age 1-5
        // max 0.21 vs age 6-99 max 0.29). The MAX must stay WITHIN the policy's age
        // band (operator pays the top VOLUME tier of that age band) — taking MAX across
        // all ages over-rated an age-4 truck at the age-6+ 0.29 (MH1/2411 their=21).
        const mr = await reqM.query(`SELECT MAX(rate_value) AS mx FROM rate_rules
          WHERE insurer LIKE '%sbi%' AND region=@reg AND segment=@seg
            AND rate_type=@rt AND sub_type=@sub AND rate_value IS NOT NULL${wtClause}
            AND (vehicle_age_min IS NULL OR vehicle_age_min <= @age)
            AND (vehicle_age_max IS NULL OR vehicle_age_max >= @age)
            AND (remarks IS NULL OR remarks NOT LIKE '%IRDA%')`);
        const mx = mr.recordset[0] && mr.recordset[0].mx;
        if (mx != null && (mx !== segRule.rate_value || segRule.region !== tgtReg)) {
          const clone = { ...segRule, rate_value: mx, region: tgtReg, sub_type: tgtSub,
            segment: segRule.segment + ' (SBI ' + tgtReg + '/' + tgtSub + ')' };
          rules = [clone, ...rules.filter(r => r !== segRule)];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- SBI PCV (taxi/bus) Mumbai-metro sub routing ----
  // SBI's PCV region "MH - M" COMBINES Mumbai (sub_type "Mumbai metro") and Pune
  // (sub_type "Maharashtra"); the RTO-master cluster distinguishes them — MH-M = Mumbai
  // metro (MH01/02/06/43/47…), MH-P = Pune (MH12/14). For a Mumbai RTO the engine matched
  // the cheaper Pune sub ("Maharashtra" SATP cc0-999 0.37) instead of "Mumbai metro" (0.53
  // — MH20/6872 MH06 their=53). Route the sub by cluster (MH-M → Mumbai metro) and take the
  // band MAX within the same cc + age band. SBI + PCV + cluster MH-M scoped; Pune (MH-P)
  // keeps its "Maharashtra" sub untouched.
  if (insurerSlug === 'sbi_general' &&
      String(params.vehicleType || '').toUpperCase() === 'PCV' &&
      rtoInfo && /^MH\s*-\s*M$/i.test(String(rtoInfo.cluster || '')) && rules.length) {
    try {
      const segRule = rules.find(r => /^MH - M$/i.test(String(r.region || '')) &&
        /Taxi|PCV|Bus/i.test(String(r.segment || '')));
      if (segRule) {
        const reqP = pool.request()
          .input('reg', sql.NVarChar(100), segRule.region)
          .input('seg', sql.NVarChar(200), segRule.segment)
          .input('rt', sql.NVarChar(50), String(segRule.rate_type || 'SATP'))
          .input('sub', sql.NVarChar(100), 'Mumbai metro')
          .input('age', sql.Int, Number(params.vehicleAge) || 0);
        let ccClause = '';
        if (segRule.cc_band_min != null && segRule.cc_band_max != null) {
          reqP.input('ccmin', sql.Int, segRule.cc_band_min);
          reqP.input('ccmax', sql.Int, segRule.cc_band_max);
          ccClause = ' AND cc_band_min=@ccmin AND cc_band_max=@ccmax';
        }
        const mr = await reqP.query(`SELECT MAX(rate_value) AS mx FROM rate_rules
          WHERE insurer LIKE '%sbi%' AND region=@reg AND segment=@seg AND rate_type=@rt
            AND sub_type=@sub AND rate_value IS NOT NULL${ccClause}
            AND (vehicle_age_min IS NULL OR vehicle_age_min <= @age)
            AND (vehicle_age_max IS NULL OR vehicle_age_max >= @age)
            AND (remarks IS NULL OR remarks NOT LIKE '%IRDA%')`);
        const mx = mr.recordset[0] && mr.recordset[0].mx;
        if (mx != null && (mx !== segRule.rate_value || segRule.sub_type !== 'Mumbai metro')) {
          const clone = { ...segRule, rate_value: mx, sub_type: 'Mumbai metro',
            segment: segRule.segment + ' (SBI MH-M/Mumbai metro)' };
          rules = [clone, ...rules.filter(r => r !== segRule)];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- SBI GCV Gujarat volume-tier take-max ----
  // SBI's GCV Gujarat grid (single sub_type "Ahmadabad") is volume_tier-banded
  // (= total premium, not derivable); the operator pays the TOP band. The engine's
  // arbitrary tier pick landed mid-band (GJ - Rest 3W: our 0.50 vs the operator's
  // Above-25L 0.525≈53). Take the max within the matched region+segment+rate_type
  // (+weight-band when present), excluding IRDA rows. SBI-GCV-GJ scoped: only ONE
  // SBI GCV policy is in Gujarat and it sits at the region max, so this can't
  // regress a sibling — and it must NOT be generalised (UP GCV has matched rows at
  // BOTH 56 and 57, DL6/9459 & MH23/9196 already sit ABOVE operator, so a blanket
  // GCV take-max would break them).
  if (insurerSlug === 'sbi_general' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV' &&
      rtoInfo && /^GJ\b/i.test(String(rtoInfo.cluster || rtoInfo.region || '')) && rules.length) {
    try {
      const segRule = rules.find(r => /^GJ/i.test(String(r.region || '')) && /GCV/i.test(String(r.segment || '')));
      if (segRule) {
        const reqM = pool.request()
          .input('reg', sql.NVarChar(100), segRule.region)
          .input('seg', sql.NVarChar(200), segRule.segment)
          .input('rt',  sql.NVarChar(50), String(segRule.rate_type || 'COMP'));
        let wtClause = '';
        if (segRule.weight_band_min != null && segRule.weight_band_max != null) {
          reqM.input('wmin', sql.Float, segRule.weight_band_min);
          reqM.input('wmax', sql.Float, segRule.weight_band_max);
          wtClause = ' AND weight_band_min=@wmin AND weight_band_max=@wmax';
        }
        const mr = await reqM.query(`SELECT MAX(rate_value) AS mx FROM rate_rules
          WHERE insurer LIKE '%sbi%' AND region=@reg AND segment=@seg AND rate_type=@rt
            AND rate_value IS NOT NULL${wtClause}
            AND (remarks IS NULL OR remarks NOT LIKE '%IRDA%')`);
        const mx = mr.recordset[0] && mr.recordset[0].mx;
        if (mx != null && mx !== segRule.rate_value) {
          const clone = { ...segRule, rate_value: mx, volume_tier: null,
            segment: segRule.segment + ' (SBI GJ max-tier)' };
          rules = [clone, ...rules.filter(r => r !== segRule)];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- SBI TW Bike SAOD decline ----
  // All SBI TW policies in the book are SAOD. SBI commissions SCOOTER SAOD
  // (operator pays e.g. 0.35) but DECLINES BIKE SAOD (operator pays 0) — the grid
  // restricts "TW Bike" to a small doable-RTO list (GJ…) while Scooter is broadly
  // allowed; Delhi/Bihar bikes fall outside it. The parser still emitted a generic
  // Bike-SAOD rate (0.235), so we wrongly output 23.5 vs operator 0. Force no-rule
  // for SBI TW Bike SAOD → recompare treats our-null vs operator-0 as a match.
  // Scooter SAOD untouched (cat carries "Scooter"). SBI-TW-Bike-SAOD scoped.
  if (insurerSlug === 'sbi_general' &&
      String(params.vehicleType || '').toUpperCase() === 'TW' &&
      String(params.insProduct || '').toUpperCase() === 'SAOD' &&
      /BIKE/i.test(String(params.vehicleCategory || '')) &&
      !/SCOOT|MOPED/i.test(String(params.vehicleCategory || ''))) {
    rules = [];
  }

  // ---- Future Generali Pvt-Car Comp take-max ----
  // FG's Pvt-Car COMP grid is NATIONAL (region=NULL) and is just a 6-step ladder
  // "IRDA 15% + N% addition" = 0.195/0.21/0.225/0.25/0.275/0.30. The addition tier
  // isn't derivable per policy, and the operator (Robinhood broker) pays the TOP
  // band 0.30 on every Pvt-Car Comp (verified: 59/59 CAR Comp → operator 30). With
  // no discriminator the engine defaulted to the lowest 0.195. Take the max Comp.
  // FG-CAR scoped, gated on a COMP rule being present: that covers both Comp and
  // SAOD (FG has no car SAOD rule so SAOD borrows Comp = also 0.30). TP-only CARs
  // keep only their region-specific TP rule after filterRulesByPolicy (no COMP
  // survivor), so they're untouched and stay 0.20.
  if (insurerSlug === 'future_generali' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      rules.some(r => String(r.rate_type || '').toUpperCase() === 'COMP')) {
    try {
      const mr = await pool.request().query(`SELECT MAX(rate_value) AS mx FROM rate_rules
        WHERE insurer='future_generali' AND segment LIKE '%Pvt Car%' AND rate_type='COMP'
          AND rate_value IS NOT NULL`);
      const mx = mr.recordset[0] && mr.recordset[0].mx;
      if (mx != null) {
        const base = rules.find(r => String(r.rate_type || '').toUpperCase() === 'COMP');
        if (base) {
          const clone = { ...base, rate_type: 'COMP', rate_value: mx,
            segment: 'Pvt Car (FG max)' };
          rules = [clone, ...rules.filter(r => String(r.rate_type || '').toUpperCase() !== 'COMP')];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- Reliance TW (state grid × segment × tenure rate_type) ----
  // Reliance TW = STATE grid (from RTO) × rate_type. rate_types: COMP / SAOD / SATP(TP)
  // for annual, and COMP_1+5 / COMP_5+5 long-term bundles under segment "TW Scooter".
  // NEW two-wheelers (age 0) are sold as the 1+5 bundle → "TW Scooter" COMP_1+5
  // (e.g. J&K new scooter 0.475 ≈ operator 0.48). The RTO master resolves to a city
  // (SRINAGAR) that the TW grid lacks → no-rule; so resolve TW region to the STATE
  // (RTO prefix; metro Mumbai/Pune & special cities kept). NOT gated on rules.length
  // (new-scooter J&K policies resolve to 0 rules). Reliance-TW scoped.
  if (insurerSlug === 'reliance' &&
      String(params.vehicleType || '').toUpperCase() === 'TW') {
    try {
      const ST = { MH:'MAHARASHTRA', GJ:'GUJARAT', KA:'KARNATAKA', TN:'TAMIL NADU', DL:'DELHI',
        UP:'UTTAR PRADESH', HR:'HARYANA', PB:'PUNJAB', RJ:'RAJASTHAN', MP:'MADHYA PRADESH',
        WB:'WEST BENGAL', AP:'ANDHRA PRADESH', TS:'TELANGANA', TG:'TELANGANA', KL:'KERALA',
        OD:'ODISHA', OR:'ODISHA', BR:'BIHAR', JH:'JHARKHAND', CG:'CHHATTISGARH', GA:'GOA',
        HP:'HIMACHAL PRADESH', JK:'JAMMU & KASHMIR', UK:'UTTARAKHAND', UA:'UTTARAKHAND',
        AS:'ASSAM', ML:'MEGHALAYA', MN:'MANIPUR', MZ:'MIZORAM', NL:'NAGALAND', TR:'TRIPURA',
        SK:'SIKKIM', AR:'ARUNACHAL PRADESH' };
      const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const rcity = String((rtoInfo && rtoInfo.region) || '').toUpperCase();
      let twReg;
      if (/MUMBAI|^PUNE$/.test(rcity)) twReg = 'Mumbai/Pune';
      else if (rcity === 'KOLHAPUR') twReg = 'Kolhapur';
      else if (rcity === 'MANGALORE') twReg = 'Mangalore';
      else if (rcity === 'MYSORE') twReg = 'Mysore';
      else twReg = ST[code.slice(0, 2)];
      const ip = String(params.insProduct || '').toUpperCase();
      const age = Number(params.vehicleAge) || 0;
      const sc = (String(params.vehicleCategory || '') + ' ' + String(params.model || '')).toUpperCase();
      const isScooter = /SCOOT|ACTIVA|JUPITER|DIO|NTORQ|N-?TORQ|ACCESS|MAESTRO|FASCINO|VESPA|PLEASURE|BURGMAN|AVENIS|GRAZIA|AEROX|PEP|RAY|SCOOTY/.test(sc);
      let seg = 'TW', rtClause = "rate_type='COMP'";
      if (ip === 'TP' || ip === 'SATP') rtClause = "rate_type='SATP'";
      else if (ip === 'SAOD') rtClause = "rate_type='SAOD'";
      else if (age === 0 && isScooter) { seg = 'TW Scooter'; rtClause = "rate_type IN ('COMP_1+5','COMP_5+5')"; }
      if (twReg) {
        const mr = await pool.request().input('reg', sql.NVarChar(80), twReg).input('seg', sql.NVarChar(40), seg)
          .query(`SELECT MAX(rate_value) AS mx FROM rate_rules WHERE insurer LIKE '%reliance%'
                  AND segment=@seg AND region=@reg AND ${rtClause} AND rate_value IS NOT NULL`);
        const mx = mr.recordset[0] && mr.recordset[0].mx;
        if (mx != null) {
          const base = rules[0] || { insurer: insurerSlug };
          const clone = { ...base, rate_type: 'COMP', rate_value: mx, region: twReg, segment: seg + ' (Reliance)' };
          rules = [clone, ...rules.filter(r => r !== base)];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- Reliance PCV (School Bus tier + Taxi segment) ----
  // School Bus grid = age(>10/<10) × owner(Individual/School). Operator uses the
  // "Owned by Individual" tier (we wrongly took the School max), tier by age. Taxi:
  // route to "PCV Taxi <6 St" (the standard taxi, for 4-6 & 7-10 seaters) at
  // COMP_NoNilDep (operator's higher dep variant), not the "Short Term" rule the
  // generic matcher picked. Region = resolved city (rtoInfo.region). Reliance-PCV.
  if (insurerSlug === 'reliance' &&
      String(params.vehicleType || '').toUpperCase() === 'PCV') {
    try {
      const ST = { MH:'MAHARASHTRA', GJ:'GUJARAT', KA:'KARNATAKA', TN:'TAMIL NADU', DL:'DELHI',
        UP:'UTTAR PRADESH', HR:'HARYANA', PB:'PUNJAB', RJ:'RAJASTHAN', MP:'MADHYA PRADESH',
        WB:'WEST BENGAL', AP:'ANDHRA PRADESH', TS:'TELANGANA', TG:'TELANGANA', KL:'KERALA',
        OD:'ODISHA', OR:'ODISHA', BR:'BIHAR', JH:'JHARKHAND', CG:'CHHATTISGARH', GA:'GOA',
        HP:'HIMACHAL PRADESH', JK:'JAMMU & KASHMIR', UK:'UTTARAKHAND', UA:'UTTARAKHAND', AS:'ASSAM' };
      const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      // resolved city first, then the STATE (the School Bus/Taxi grids carry a state
      // row like "MAHARASHTRA" for RTO-master catch-alls like "Rest of Maharashtra"
      // that aren't grid regions).
      const regions = [...new Set([(rtoInfo && rtoInfo.region) || resolvedRegion, ST[code.slice(0, 2)]].filter(Boolean))];
      const cat = String(params.vehicleCategory || '').toUpperCase();
      const ip = String(params.insProduct || '').toUpperCase();
      const age = Number(params.vehicleAge) || 0;
      let seg = null, extra = '', rtClause = null;
      if (/SCHOOL\s*BUS/.test(cat)) {
        seg = 'School Bus';
        extra = "AND sub_type LIKE '%Individual%' AND sub_type LIKE '" + (age > 10 ? '>10%' : '<10%') + "'";
        rtClause = (ip === 'TP' || ip === 'SATP') ? "rate_type='SATP'" : "rate_type='COMP'";
      } else if (/TAXI/.test(cat)) {
        seg = 'PCV Taxi <6 St';
        rtClause = (ip === 'TP' || ip === 'SATP') ? "rate_type='SATP'" : "rate_type IN ('COMP_NoNilDep','COMP_NilDep')";
      }
      if (seg && regions.length) {
        for (const reg of regions) {
          const mr = await pool.request().input('reg', sql.NVarChar(80), reg).input('seg', sql.NVarChar(60), seg)
            .query(`SELECT MAX(rate_value) AS mx FROM rate_rules WHERE insurer LIKE '%reliance%'
                    AND segment=@seg AND region=@reg AND ${rtClause} ${extra} AND rate_value IS NOT NULL`);
          const mx = mr.recordset[0] && mr.recordset[0].mx;
          if (mx != null) {
            const base = rules[0] || { insurer: insurerSlug };
            const clone = { ...base, rate_type: 'COMP', rate_value: mx, region: reg, segment: seg + ' (Reliance)' };
            rules = [clone, ...rules.filter(r => r !== base)];
            break;
          }
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- Chola CAR Comprehensive (region cluster × CC band × NCB) ----
  // Chola's Pvt-Car grid is keyed by region cluster (GJ / MH-GA / AP-TS / JH / …),
  // CC band (UPTO 1000 / 1000 TO 1500 / ABOVE 1500) and NCB variant (base ~0.30;
  // "NCB GT OR Equal to 25%" higher), under sub_type "PC [PACK]" (comprehensive) vs
  // "PC [SOD]" (standalone-OD). Chola has almost no rto_mappings (only MH, and those
  // point at CV sub-clusters like "PUNE" that the CAR grid doesn't use), so region
  // never resolved → CAR fell to a wrong region's "PC [SOD]" 0.10. Resolve the CAR
  // region from the RTO state-prefix → cluster, pick PC[PACK]/PACK at the policy's CC
  // band + NCB tier, take max. Chola-CAR-COMP scoped (SAOD keeps its own PC[SOD]).
  // SAOD extension (USER-confirmed MH23/9440 Brezza petrol SAOD NCB-0, MH40):
  // region never resolved → matched AP/TS "NCB≥25" 21.5; the correct MH/GA
  // "PC [SOD]" petrol base is 0.19 = operator. SAOD resolves the same region
  // cluster but picks sub_type PC[SOD] at the fuel-suffixed segment ([P]/[D]).
  const _cholaCarProd = String(params.insProduct || '').toUpperCase();
  if (insurerSlug === 'chola_ms' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      (_cholaCarProd === 'COMP' || _cholaCarProd === 'SAOD') && rules.length) {
    try {
      // Haryana (HR) has no own Chola Pvt-Car region — it takes the PB (Punjab) grid
      // (USER-confirmed).
      const ST2REG = { GJ:'GJ', MH:'MH/GA', GA:'MH/GA', AP:'AP/TS', TS:'AP/TS', TG:'AP/TS',
        KA:'KA', DL:'DL', TN:'TN', RJ:'RJ', PB:'PB', HR:'PB', HP:'HP', UP:'UP', OD:'OD', OR:'OD',
        JH:'JH', JK:'JK', MP:'MP', WB:'WB', UK:'UK', UA:'UK', CG:'CG', BR:'BH', AN:'AN',
        AS:'AS/ML/TR/AR/NL', ML:'AS/ML/TR/AR/NL', TR:'AS/ML/TR/AR/NL', AR:'AS/ML/TR/AR/NL', NL:'AS/ML/TR/AR/NL' };
      const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      // UP16 (Noida) takes Chola's "UP- East" grid, not plain UP — USER-confirmed
      // (DL7/14263 Creta diesel NCB-0: operator paid the UP-East 1000-1500 base 25,
      // plain-UP base is 20; neighbouring UP14/15/17 verified on plain UP).
      const reg = code.startsWith('UP16') ? 'UP- East' : ST2REG[code.slice(0, 2)];
      if (reg) {
        const cc = Number(params.cc) || 0;
        const ccBand = cc > 0 && cc <= 1000 ? 'UPTO 1000 CC'
                     : cc <= 1500 ? '1000 TO 1500 CC' : 'ABOVE 1500 CC';
        const ncb = Number(params.ncbPct) || 0;
        const isSaod = _cholaCarProd === 'SAOD';
        // SAOD ("PC [SOD]") segments carry a FUEL suffix: "1000 TO 1500 CC[P]" /
        // "...CC[D]". '[' is a LIKE wildcard-class char in SQL Server → escape as '[[]'.
        const fuelSuffix = /DIESEL/i.test(String(params.fuelType || '')) ? '[[]D]' : '[[]P]';
        const segPat = isSaod ? (ccBand + fuelSuffix + '%') : (ccBand + '%');
        const subPat = isSaod ? '%SOD%' : '%PACK%';
        const reqC = pool.request().input('reg', sql.NVarChar(60), reg).input('seg', sql.NVarChar(80), segPat)
                                   .input('sub', sql.NVarChar(40), subPat);
        // NCB ≥ 25% → the "NCB GT OR Equal to 25%" tier; else the base (no-NCB) band.
        const ncbClause = ncb >= 25 ? "AND segment LIKE '%OR Equal to 25%'" : "AND segment NOT LIKE '%NCB%'";
        // MIN (not MAX): where a region+band carries duplicate card-gen rows (e.g. JH
        // 1000-1500 base = 25 AND 30), the operator pays the lower/current 25;
        // single-valued regions (GJ/MH base 0.30) are unaffected.
        const mr = await reqC.query(`SELECT MIN(rate_value) AS mx FROM rate_rules
          WHERE insurer LIKE '%chola%' AND region=@reg AND sub_type LIKE @sub
            AND rate_type='PACK' AND segment LIKE @seg ${ncbClause} AND rate_value IS NOT NULL`);
        const mx = mr.recordset[0] && mr.recordset[0].mx;
        if (mx != null) {
          const base = rules[0] || { insurer: insurerSlug };
          const clone = { ...base, rate_type: 'PACK', rate_value: mx, region: reg,
            sub_type: isSaod ? 'PC [SOD]' : 'PC [PACK]',
            segment: ccBand + (isSaod ? ' SAOD' : '') + ' (Chola CAR)' };
          rules = [clone, ...rules.filter(r => r !== base)];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- Chola tractor (1_TRAC) region + NEW/RENEWAL resolver ----
  // Chola files tractor rates in the GCV grid (segment 1_TRAC[NEW]/[RENEWAL], sub_type
  // MSV, PACK), region-banded (BH=Bihar 0.44, AP 0.45, …). Tractors arrive vehicleType=
  // MISC (not GCV) so the Chola GCV resolver below skips them; and Chola has sparse
  // rto_mappings (no BR), so region resolves null → the generic engine grabs an arbitrary
  // region's tractor row (BH2/6073 BR27 → AP [NEW] 0.45 vs the correct Bihar 0.44).
  // Resolve region from the RTO state-prefix (same scheme as Chola GCV) and pick [NEW]
  // (age 0) or [RENEWAL] (age>=1 — a used/registered vehicle, regardless of a misleading
  // "New Business" type). Chola + tractor scoped; unresolved prefix → keep engine rule.
  if (insurerSlug === 'chola_ms' &&
      /\bTRACTOR\b/i.test(`${params.vehicleCategory || ''} ${params.model || ''}`)) {
    try {
      const TREG = { GJ: 'GJ', MH: 'Mumbai/GA/Pune/Central MH', GA: 'Mumbai/GA/Pune/Central MH',
        AP: 'AP', TS: 'TS', TG: 'TS', KA: 'KA', DL: 'DL', TN: 'TN-Chennai', RJ: 'RJ', PB: 'PB',
        HP: 'HP', UP: 'UP', OD: 'OD', OR: 'OD', JH: 'JH', JK: 'JK', MP: 'MP', WB: 'WB', UK: 'UK',
        UA: 'UK', CG: 'CG', BR: 'BH', AN: 'AN', AS: 'AS/ML/TR/AR/NL/SK', ML: 'AS/ML/TR/AR/NL/SK',
        TR: 'AS/ML/TR/AR/NL/SK', AR: 'AS/ML/TR/AR/NL/SK', NL: 'AS/ML/TR/AR/NL/SK', SK: 'AS/ML/TR/AR/NL/SK' };
      const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const reg = TREG[code.slice(0, 2)];
      if (reg) {
        const band = (Number(params.vehicleAge) || 0) < 1 ? 'NEW' : 'RENEWAL';
        const trKey = lookupKey + '||cholaTrac:' + reg + ':' + band;
        let trRows;
        if (caches.lookup.has(trKey)) trRows = caches.lookup.get(trKey);
        else {
          // Scope to the CURRENT card (latest effective_from): Chola carries multiple
          // card generations (e.g. WB [RENEWAL] = 0.375 on the stale Mar-2025 card 40 vs
          // 0.2/0.325 on the Apr-2026 cards). Order by effective_from DESC so the stale
          // higher rate is excluded, then take the region's top current-card rate.
          const trSql = (segParam) => `SELECT TOP 1 rr.rate_value FROM rate_rules rr
              JOIN rate_cards rc ON rr.rate_card_id = rc.id
              WHERE rr.insurer='chola_ms' AND rr.region=@reg AND rr.segment LIKE ${segParam}
                AND rr.rate_value > 0 ORDER BY rc.effective_from DESC, rr.rate_value DESC`;
          trRows = (await pool.request().input('reg', sql.NVarChar(60), reg)
            .input('seg', '%TRAC[[]' + band + ']%').query(trSql('@seg'))).recordset;
          // fallback: region has no band-specific tractor row → try the other band
          if (!trRows.length) {
            const other = band === 'NEW' ? 'RENEWAL' : 'NEW';
            trRows = (await pool.request().input('reg', sql.NVarChar(60), reg)
              .input('seg', '%TRAC[[]' + other + ']%').query(trSql('@seg'))).recordset;
          }
          caches.lookup.set(trKey, trRows);
        }
        if (trRows[0]) {
          const base = rules[0] || { insurer: insurerSlug };
          const clone = { ...base, rate_type: 'PACK', rate_value: Number(trRows[0].rate_value),
            is_declined: 0, region: reg, sub_type: 'MSV', segment: '1_TRAC[' + band + '] (Chola ' + reg + ')' };
          rules = [clone];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- Chola excavator / construction-equipment (JCB) region resolver ----
  // Chola's excavator (2_EXCAVATOR — JCB/backhoe) rate is region-banded (PACK = Comp,
  // ACT = Liability), current-card: GJ/MH/etc 0.30, KA/UP 0.175, MP/RJ 0 (declined), and
  // some regions carry NO ACT row at all (Liability declined there). Tractors/excavators
  // arrive vehicleType=MISC → region resolves null → the generic engine grabs an arbitrary
  // region's rate AND can mis-pick a GCV CC-band segment ("3_4W_GT_1500CC" 12.5%) over the
  // EXCAVATOR segment when CC>1500 (MH23/9363 UP JCB → 12.5 vs UP PACK 17.5 their=18).
  // Resolve region, pick the EXCAVATOR rate for the policy's cover (ACT if Liability/od=0,
  // else PACK) from the CURRENT card; rate 0 or no-row → decline. Chola + JCB/excavator.
  if (insurerSlug === 'chola_ms' &&
      (/\bJCB\b|EXCAVATOR|BACKHOE/i.test(`${params.vehicleCategory || ''} ${params.model || ''}`) ||
        rules.some(r => /EXCAVATOR/i.test(String(r.segment || ''))))) {
    try {
      const CEREG = { GJ: 'GJ', MH: 'Mumbai/GA/Pune/Central MH', GA: 'Mumbai/GA/Pune/Central MH',
        AP: 'AP', TS: 'TS', TG: 'TS', KA: 'KA', DL: 'DL', TN: 'TN-Chennai', RJ: 'RJ', PB: 'PB',
        HP: 'HP', UP: 'UP', OD: 'OD', OR: 'OD', JH: 'JH', JK: 'JK', MP: 'MP', WB: 'WB', UK: 'UK',
        UA: 'UK', CG: 'CG', BR: 'BH', AN: 'AN', AS: 'AS/ML/TR/AR/NL/SK', ML: 'AS/ML/TR/AR/NL/SK',
        TR: 'AS/ML/TR/AR/NL/SK', AR: 'AS/ML/TR/AR/NL/SK', NL: 'AS/ML/TR/AR/NL/SK', SK: 'AS/ML/TR/AR/NL/SK' };
      const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const reg = CEREG[code.slice(0, 2)];
      if (reg) {
        const cover = (Number(params.odPremium) === 0 || /^(TP|SATP|ACT)$/i.test(String(params.insProduct || ''))) ? 'ACT' : 'PACK';
        const ceKey = lookupKey + '||cholaCe:' + reg + ':' + cover;
        let ceRows;
        if (caches.lookup.has(ceKey)) ceRows = caches.lookup.get(ceKey);
        else {
          ceRows = (await pool.request().input('reg', sql.NVarChar(60), reg).input('rt', sql.NVarChar(10), cover)
            .query(`SELECT TOP 1 rr.rate_value FROM rate_rules rr JOIN rate_cards rc ON rr.rate_card_id = rc.id
                    WHERE rr.insurer='chola_ms' AND rr.region=@reg AND rr.segment LIKE '%EXCAVATOR%'
                      AND rr.rate_type=@rt ORDER BY rc.effective_from DESC, rr.rate_value DESC`)).recordset;
          caches.lookup.set(ceKey, ceRows);
        }
        const base = rules[0] || { insurer: insurerSlug };
        const rv = ceRows[0] ? Number(ceRows[0].rate_value) : null;
        if (rv == null || rv === 0) {
          // no current-card excavator rate for this region+cover (or explicit 0) → decline
          rules = [{ ...base, rate_value: 0, is_declined: 1, segment: '2_EXCAVATOR (Chola ' + reg + ' ' + cover + ' — declined)' }];
        } else {
          rules = [{ ...base, rate_type: cover, rate_value: rv, is_declined: 0,
            region: reg, sub_type: 'MSV', segment: '2_EXCAVATOR (Chola ' + reg + ')' }];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- Chola GCV (region cluster × tonnage band, sub_type GCCV) ----
  // Chola GCV uses its OWN region scheme (distinct from CAR): all MH → "Mumbai/GA/
  // Pune/Central MH", TN → "TN-Chennai", AS group → "AS/ML/TR/AR/NL/SK", else state
  // code. Rules are sub_type "GCCV", rate_type PACK, segment = tonnage band
  // (2_UPTO_3.5T / 3_3.5T_TO_7.5T / … / 10_ABOVE_47.5T) plus a BLANK-segment headline
  // (GJ ≤3.5T rate lives there = 0.58). Region never resolved (rto_mappings ~MH-only),
  // so GCV matched a wrong segment at 0. Resolve region from RTO state-prefix, map
  // tonnage→band, take MAX GCCV/PACK (>0, non-electric). ≤3.5T pools blank+UPTO_3.5T+
  // 3W so GJ's blank 0.58 wins. Chola-GCV scoped; unresolved region → keep engine rule.
  if (insurerSlug === 'chola_ms' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV') {
    try {
      const GREG = { GJ:'GJ', MH:'Mumbai/GA/Pune/Central MH', GA:'Mumbai/GA/Pune/Central MH',
        AP:'AP', TS:'TS', TG:'TS', KA:'KA', DL:'DL', TN:'TN-Chennai', RJ:'RJ', PB:'PB', HP:'HP',
        UP:'UP', OD:'OD', OR:'OD', JH:'JH', JK:'JK', MP:'MP', WB:'WB', UK:'UK', UA:'UK', CG:'CG',
        BR:'BH', AN:'AN', AS:'AS/ML/TR/AR/NL/SK', ML:'AS/ML/TR/AR/NL/SK', TR:'AS/ML/TR/AR/NL/SK',
        AR:'AS/ML/TR/AR/NL/SK', NL:'AS/ML/TR/AR/NL/SK', SK:'AS/ML/TR/AR/NL/SK' };
      const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      let reg = GREG[code.slice(0, 2)];
      // Maharashtra GCV splits Mumbai/Pune/Central-MH vs ROM (Rest of MH). Chola's
      // rto_mappings only carry the Mumbai/Pune/Central-MH RTOs (→ MUMBAI THANE /
      // CENTRAL MH / PUNE); MH RTOs ABSENT from the master are ROM (lower rates, e.g.
      // ≤3.5T "Other" 0.35 vs Mumbai-cluster 0.45). MH15/MH24 (unmapped) → ROM.
      if (/^MH/.test(code) && reg) {
        const rm = await pool.request().input('c', sql.NVarChar(12), code)
          .query("SELECT TOP 1 region FROM rto_mappings WHERE insurer LIKE '%chola%' AND REPLACE(rto_code,'-','')=@c");
        const rg = rm.recordset[0] && rm.recordset[0].region;
        reg = (rg && /MUMBAI|CENTRAL|PUNE|THANE/i.test(rg)) ? 'Mumbai/GA/Pune/Central MH' : 'ROM';
      }
      const cat = String(params.vehicleCategory || '').toUpperCase();
      const is3W = /\b3\s*W\b|3\s*WH/.test(cat);
      const isElectric = /ELECTRIC/i.test(String(params.fuelType || '')) || /E-?RIK|E-?RICK/i.test(cat);
      const ton = Number(params.tonnage) || 0;
      if (reg) {
        let segClause;
        if (is3W) segClause = isElectric ? "segment LIKE '%GCCV_3W%Electric%'" : "segment LIKE '%GCCV_3W%'";
        else if (ton <= 3.5) {
          // ≤3.5T GCV has a MAKE split: Tata/Maruti → "TATA/ Maruti/ Mahindra" rows
          // (2_UPTO_3.5T); everything else (incl. Mahindra Bolero, Ashok Leyland
          // Dost) → "All Other Make/Models" (GJ 0.58 / MH 0.45). Operator treats
          // Mahindra as "Other" here despite the label. segment IS NOT NULL drops the
          // null-segment artifact (MH 0.55) so the real "" Other row wins. ELECTRIC
          // goods carriers (Euler / E-rickshaw) use the "[Electric]" variant (≤3.5T
          // Other 0.375) — not the non-electric blank row.
          const isTMM = /\bTATA\b|MARUTI/i.test(String(params.make || ''));
          if (isElectric) segClause = "segment LIKE '%UPTO[_]3.5%Electric%'";
          else segClause = isTMM
            ? "make LIKE '%TATA%' AND segment LIKE '%UPTO[_]3.5%'"
            : "make LIKE '%Other%' AND segment IS NOT NULL";
        }
        else if (ton <= 7.5) segClause = "segment LIKE '3[_]%'";
        else if (ton <= 12)  segClause = "segment LIKE '4[_]%'";
        else if (ton <= 16)  segClause = "segment LIKE '5[_]%'";
        else if (ton <= 20)  segClause = "segment LIKE '6[_]%'";
        else if (ton <= 40)  segClause = "segment LIKE '7[_]%'";
        else if (ton <= 43)  segClause = "segment LIKE '8[_]%'";
        else if (ton <= 47.5) segClause = "segment LIKE '9[_]%'";
        else segClause = "segment LIKE '10[_]%'";
        // Only exclude the [Electric] rows for non-electric vehicles.
        const elecFilter = isElectric ? '' : "AND segment NOT LIKE '%Electric%'";
        const mr = await pool.request().input('reg', sql.NVarChar(80), reg)
          .query(`SELECT MAX(rate_value) AS mx FROM rate_rules
                  WHERE insurer LIKE '%chola%' AND region=@reg AND sub_type='GCCV'
                    AND rate_type='PACK' AND rate_value > 0 ${elecFilter}
                    AND ${segClause}`);
        const mx = mr.recordset[0] && mr.recordset[0].mx;
        if (mx != null) {
          const base = rules[0] || { insurer: insurerSlug };
          const clone = { ...base, rate_type: 'PACK', rate_value: mx, region: reg,
            sub_type: 'GCCV', segment: 'GCCV (Chola ' + reg + ')' };
          rules = [clone, ...rules.filter(r => r !== base)];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- Chola TW Comprehensive (region × CC-band / scooter, ANNUAL base) ----
  // Chola TW uses YET another region scheme ("KA (Bangalore)", "GJ/DN/DD", "TN/ROK",
  // "JK/LD" …). Segment = "150cc" (≤150) / "150_350cc" / "SCOOTER". The grid is
  // NOP-volume-tier banded (NEW UPTO-30 / 30-100 / 100-500 NOP = agent policy-count)
  // + ANNUAL / SOD / ACT, with duplicate card-gen rows — so the operator pays the
  // ANNUAL base (the lowest, low-volume rate): KA 150cc → 0.03, KA SCOOTER → 0.375.
  // Region never resolved (matched a wrong region's NOP rate). Resolve TW region from
  // state-prefix, pick segment, take MIN ANNUAL. Chola-TW-COMP scoped. (NOP-tier
  // siblings that were paid a higher tier can't be derived — left.)
  if (insurerSlug === 'chola_ms' &&
      String(params.vehicleType || '').toUpperCase() === 'TW' &&
      String(params.insProduct || '').toUpperCase() === 'COMP' && rules.length) {
    try {
      const TWREG = { KA:'KA (Bangalore)', MH:'MH', AP:'AP', TS:'TS', GJ:'GJ/DN/DD', DN:'GJ/DN/DD',
        DD:'GJ/DN/DD', DL:'DL', BR:'BR', HP:'HP', JH:'JH', MP:'MP', OD:'OD', OR:'OD', PB:'PB',
        RJ:'RJ', UK:'UK', UA:'UK', WB:'WB', GA:'GA', AN:'AN', JK:'JK/LD', LD:'JK/LD', KL:'KL/LD',
        TN:'TN/ROK', UP:'East UP', AS:'AS/ML/TR/ AR/NL', ML:'AS/ML/TR/ AR/NL', TR:'AS/ML/TR/ AR/NL',
        AR:'AS/ML/TR/ AR/NL', NL:'AS/ML/TR/ AR/NL' };
      const code = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const reg = TWREG[code.slice(0, 2)];
      if (reg) {
        const cat = String(params.vehicleCategory || '').toUpperCase();
        const model = String(params.model || '').toUpperCase();
        const isScooter = /SCOOT|ACTIVA|JUPITER|NTORQ|DIO|ACCESS|MAESTRO|FASCINO|VESPA|PLEASURE|BURGMAN|AVENIS|GRAZIA|AEROX|PEP/.test(cat + ' ' + model);
        const cc = Number(params.cc) || 0;
        const seg = isScooter ? 'SCOOTER' : (cc > 0 && cc <= 150 ? '150cc' : '150_350cc');
        // TW ANNUAL is MAKE-banded (Honda lower; Hero/TVS/Suzuki/Yamaha OEM higher;
        // e.g. KA scooter Honda 0.375 vs TVS 0.40; KA 150cc Honda 0.03 vs Hero/TVS
        // 0.075 vs Suzuki 0.10). Match the policy make → its OEM rate.
        const mk = String(params.make || '').toUpperCase();
        const MKMAP = { HONDA: 'Honda', HERO: 'Hero', TVS: 'TVS', SUZUKI: 'Suzuki', YAMAHA: 'Yamaha' };
        let gmk = null;
        for (const k in MKMAP) { if (mk.includes(k)) { gmk = MKMAP[k]; break; } }
        const reqTW = pool.request().input('reg', sql.NVarChar(60), reg).input('seg', sql.NVarChar(40), seg);
        let mkClause = '';
        if (gmk) { reqTW.input('mk', sql.NVarChar(40), '%' + gmk + '%'); mkClause = 'AND make LIKE @mk'; }
        const mr = await reqTW.query(`SELECT MIN(rate_value) AS mn FROM rate_rules WHERE insurer LIKE '%chola%'
                  AND region=@reg AND segment=@seg AND rate_type='ANNUAL' AND rate_value > 0 ${mkClause}`);
        const mn = mr.recordset[0] && mr.recordset[0].mn;
        if (mn != null) {
          const base = rules[0];
          const clone = { ...base, rate_type: 'ANNUAL', rate_value: mn, region: reg,
            segment: seg + ' (Chola TW)' };
          rules = [clone, ...rules.filter(r => r !== base)];
        }
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- Future Generali CV (GCV / PCV) interpreter ----
  // FG's CV commission = OD rate + TP rate (Comp); TP-only → TP; SAOD → OD. The grid
  // is keyed by Region × Weight-category (services/fg-cv.js, from the IMD sheet's
  // 10-Feb TP columns). Region comes from the FG RTO master (state + zone; Maharashtra
  // splits Mumbai→"MAHARASHTRA" vs rest→"ROM"); weight-category from the vehicle's GVW
  // (PR tonnage, kg) with a fallback to the tmp category band. resolveFgCvRate returns
  // a number (override), null (FG declines the cell → no-rule), or undefined (can't
  // resolve → keep the engine's rule, so unhandled shapes never regress). FG-CV scoped.
  if (insurerSlug === 'future_generali' &&
      /^(GCV|PCV)$/.test(String(params.vehicleType || '').toUpperCase()) && rules.length) {
    try {
      let gvw = null;
      try {
        const pq = await pool.request().input('p', sql.NVarChar(120), String(params._policy_no || ''))
          .query(`SELECT TOP 1 tonnage FROM pr_rows WHERE insurer_slug='future_generali'
                  AND policy_no=@p AND tonnage IS NOT NULL ORDER BY id DESC`);
        const pt = pq.recordset[0] && pq.recordset[0].tonnage;
        if (pt != null && pt > 0) gvw = pt;
      } catch (_) { /* no PR tonnage → resolver falls back to the category band */ }
      const g = require('../services/fg-cv').resolveFgCvRate(params, gvw);
      if (g !== undefined) {
        const ip = String(params.insProduct || '').toUpperCase();
        const rt = (ip === 'TP' || ip === 'SATP') ? 'TP' : (ip === 'SAOD' ? 'SAOD' : 'COMP');
        const base = rules.find(r => /GCV|BOLERO|TAXI|AUTO|BUS|TRACTOR/i.test(String(r.segment || ''))) || rules[0];
        // g is { rate, od, tp } (fractions) or null (decline). rate_value =
        // headline (match); od_rate/tp_rate = legs so income = OD%×OD + TP%×TP.
        const clone = { ...base, rate_type: rt,
          rate_value: g === null ? 0 : g.rate,
          od_rate: g === null ? undefined : g.od,
          tp_rate: g === null ? undefined : g.tp,
          is_declined: g === null ? 1 : base.is_declined, segment: 'FG CV (OD+TP)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged on failure */ }
  }

  // ---- HDFC GCV free-text conditional grid override ----
  // The GCV grid encodes make(Tata/Mahindra-Bolero/Eicher/others)×age×location
  // rules as free text (e.g. "Bolero <5 years 37.5%, >5 years 42.5%, others 52.5%",
  // "Grid+7.5%", "Tata age >4 25%, others age >4 20%"), which the generic parser
  // flattened into ambiguous numeric rows. services/hdfc-gcv.js interprets the
  // APPROVED cell for this policy and returns a confident rate (number), a decline
  // (null), or undefined when it can't parse — in which case we leave the engine's
  // existing rule untouched (so un-handled shapes never regress).
  if (insurerSlug === 'hdfc_ergo' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV') {
    try {
      const { resolveGcvRate } = require('../services/hdfc-gcv');
      const ip = String(params.insProduct || '').toUpperCase();
      const isSatp = ip === 'TP' || ip === 'SATP' || (Number(params.odPremium) || 0) === 0;
      const st = String(rtoStatePrefix(params.rtoCode) || '').toUpperCase();
      const g = resolveGcvRate(params, resolvedRegion, st, isSatp);
      if (g !== undefined) {
        const want = isSatp ? 'SATP' : 'COMP';
        const base = rules.find(r => String(r.rate_type || '').toUpperCase().includes(want))
                  || rules.find(r => /GCV/i.test(String(r.segment || ''))) || rules[0]
                  // No base rule to clone: the initial lookup pool was empty (no
                  // region/band match) — synthesize a minimal rule so the
                  // interpreter's rate still applies (else these fall to no-rule).
                  || { insurer: insurerSlug, region: resolvedRegion || null };
        const clone = { ...base, rate_type: base.rate_type || want,
          rate_value: g === null ? 0 : g, is_declined: g === null ? 1 : base.is_declined,
          segment: 'GCV (HDFC approved grid)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged on any failure */ }
  }

  // ---- United India PRIVATE CAR grid override ----
  // United's Pvt-Car commission is CC × fuel × make × policy-type PLUS a preferred-
  // city-RTO 40% override (Sub Annexure-3) — NOT region-based. The PDF-sourced
  // rules were mis-parsed (region=RTO code, no make), so CAR mis-rated (our 5 vs
  // operator 40). services/united-car.js computes the rate % directly from params;
  // clone it onto the pool so it wins. Returns null when it can't decide → leave
  // the engine's existing rule (no regression on un-handled shapes).
  if (insurerSlug === 'united_india_insurance' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR') {
    try {
      const { resolveUnitedCarRate } = require('../services/united-car');
      const ur = resolveUnitedCarRate(params);
      if (ur != null) {
        const base = rules.find(r => /CAR|PVT/i.test(String(r.segment || ''))) || rules[0]
          || { insurer: insurerSlug, region: resolvedRegion || null, segment: 'Pvt Car' };
        const clone = { ...base, rate_type: base.rate_type || 'COMP', rate_value: ur,
          is_declined: 0, segment: 'Pvt Car (United grid)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged */ }
  }

  // ---- United India GCV preferred-RTO override (Sub Annexure-2) ----
  // GCV from excluded states in specific preferred RTOs gets a higher per-band
  // commission (<=2T UP 57.5%, 2-3.5T 50%, 3.5-7.5T 27.5%). RTO-based; the broad
  // empty-region scorer otherwise lands on an arbitrary state's lower GCV rate.
  if (insurerSlug === 'united_india_insurance' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV') {
    try {
      const { resolveUnitedGcvRate } = require('../services/united-car');
      const ug = resolveUnitedGcvRate(params);
      if (ug != null) {
        const base = rules.find(r => /GCV/i.test(String(r.segment || ''))) || rules[0]
          || { insurer: insurerSlug, region: resolvedRegion || null, segment: 'GCV' };
        const clone = { ...base, rate_type: base.rate_type || 'COMP', rate_value: ug,
          is_declined: 0, segment: 'GCV (United Sub-Annexure-2)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged */ }
  }

  // ---- United PCV route bus → seating-banded "4W PCV > 6 passengers" grid ----
  // United rates route/stage buses as ordinary "4W PCV > 6" passenger vehicles, banded by
  // SEATING (PCC) × fuel × region (PCC<=10 / 10-20 / 20-30 / 30-40 / 40-50 / 50-60 / >60,
  // EV = "PCC>20 (Electric)"). The global route-bus decline drops them to no-rule, AND the
  // PCC band lives in rate_text (not a column) so the right band must be parsed. Re-query
  // the "4W PCV > 6" segment for the region and pick the row whose PCC band contains the
  // policy seating and whose fuel matches (All Fuel for the ≤20 bands; Diesel/Petrol/CNG
  // for ≥20; Electric for EV). USER-confirmed: JK1/840 (21-seat diesel, J&K) → 10%.
  // United + PCV + route-bus scoped; rate applies to OD & TP (single rate on net).
  if (insurerSlug === 'united_india_insurance' &&
      String(params.vehicleType || '').toUpperCase() === 'PCV' &&
      /\bROUTE\s*BUS\b|\bSTAGE\s*CARR?IAGE\b|\bCONTRACT\s*CARR?IAGE\b/i.test(String(params.vehicleCategory || ''))) {
    const seat = Number(params.seatingCapacity) || 0;
    const fuel = String(params.fuelType || '').toUpperCase();
    const isEV = /ELECTRIC|\bEV\b|BATTERY/.test(fuel);
    if (seat > 6) {
      const busKey = lookupKey + '||unitedPcvBus';
      let busRules;
      if (caches.lookup.has(busKey)) busRules = caches.lookup.get(busKey);
      else { busRules = await lookupRates(pool, { ...baseLookup, segment: '4W PCV > 6' }); caches.lookup.set(busKey, busRules); }
      const fuelTok = /DIESEL/.test(fuel) ? 'DIESEL' : (/CNG|LPG/.test(fuel) ? 'CNG' : (/PETROL/.test(fuel) ? 'PETROL' : null));
      const bandHit = (txt) => {
        const t = String(txt || ''); let m;
        if ((m = t.match(/(\d+)\s*<\s*PCC\s*<=\s*(\d+)/i))) return seat > +m[1] && seat <= +m[2];
        if ((m = t.match(/PCC\s*<=\s*(\d+)/i))) return seat <= +m[1];
        if ((m = t.match(/PCC\s*>\s*(\d+)/i))) return seat > +m[1];
        return false;
      };
      const fuelHit = (txt) => {
        const t = String(txt || '');
        if (isEV) return /ELECTRIC/i.test(t);
        if (/ELECTRIC/i.test(t)) return false;
        return /ALL\s*FUEL/i.test(t) || (fuelTok && new RegExp('\\(' + fuelTok + '\\)', 'i').test(t));
      };
      const cand = busRules.filter(r => Number(r.rate_value) >= 0 && bandHit(r.rate_text) && fuelHit(r.rate_text));
      if (cand.length > 0) rules = [{ ...cand[0], segment: 'PCV 4W >6 (United seating grid)' }];
    }
  }

  // ---- United India GCV E-Cart / E-Rickshaw → 3W-PCV rate (MP 25% / Other 40%) ----
  // A goods e-rickshaw / e-cart ("E-Rikshaw-Good Carrying", "E CART", "E RICKSHAW") is a
  // 3-wheeler electric vehicle; United rates it like its 3W PASSENGER auto (Three Wheeled
  // (Passenger Carrying): MP 25%, other states 40%) — NOT the generic small-GCV GVW band
  // (<=2000kg 20%) the engine landed on, and NOT the stale "E-Cart" 50% segment row.
  // Operator-confirmed: DL5/6771 (E CART, UP37) their=40. (Mirrors the Shriram pattern —
  // GCV e-carts must search the 3W/PCV rate.) United+GCV+e-cart scoped.
  if (insurerSlug === 'united_india_insurance' &&
      String(params.vehicleType || '').toUpperCase() === 'GCV') {
    const hay = `${params.vehicleCategory || ''} ${params.model || ''} ${params.make || ''}`.toUpperCase();
    if (/E-?\s*CART|E-?\s*RICK|RIKSHAW|RICKSHAW/.test(hay)) {
      const st = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2);
      const ecRate = st === 'MP' ? 0.25 : 0.40;
      const base = rules.find(r => /GCV|E-?CART|RICK/i.test(String(r.segment || ''))) || rules[0]
        || { insurer: insurerSlug, region: resolvedRegion || null, segment: 'GCV' };
      const clone = { ...base, rate_type: base.rate_type || 'COMP', rate_value: ecRate,
        is_declined: 0, segment: 'GCV E-Cart (United 3W rate)' };
      rules = [clone, ...rules.filter(r => r !== base)];
    }
  }

  // ---- United India PCV 3-Wheeler override (MP 25% / Other 40%) ----
  if (insurerSlug === 'united_india_insurance' &&
      String(params.vehicleType || '').toUpperCase() === 'PCV') {
    try {
      const { resolveUnitedPcvRate } = require('../services/united-car');
      const up = resolveUnitedPcvRate(params);
      if (up != null) {
        const base = rules.find(r => /PCV|3\s*W|RICK/i.test(String(r.segment || ''))) || rules[0]
          || { insurer: insurerSlug, region: resolvedRegion || null, segment: 'PCV 3W' };
        const clone = { ...base, rate_type: base.rate_type || 'COMP', rate_value: up,
          is_declined: 0, segment: 'PCV 3W (United grid)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged */ }
  }

  // ---- HDFC Two-Wheeler (Comp / TP) grid override ----
  // The TW grid ("Grid - Comp, TP only" sheet) was mis-ingested — Delhi-NCR got
  // conflated with Haryana (0.55 instead of 0.60) and Bike-Comp rows were dropped.
  // services/hdfc-tw.js reads the clean grid + TW RTO Master and returns the
  // authoritative rate by RTO→(State,Location) × Bike/Scooter × cc × Comp/TP.
  // Only Comp & TP — SAOD has its own sheet (left to the existing engine).
  if (insurerSlug === 'hdfc_ergo' &&
      String(params.vehicleType || '').toUpperCase() === 'TW') {
    const ip = String(params.insProduct || '').toUpperCase();
    try {
      const tw = require('../services/hdfc-tw');
      let g, want;
      if (ip === 'COMP') { g = tw.resolveTwRate(params, resolvedRegion, false); want = 'COMP'; }
      else if (ip === 'TP' || ip === 'SATP') { g = tw.resolveTwRate(params, resolvedRegion, true); want = 'SATP'; }
      else if (ip === 'SAOD') { g = tw.resolveTwSaodRate(params, resolvedRegion); want = 'SAOD'; }
      if (g !== undefined) {
        const base = rules.find(r => String(r.rate_type || '').toUpperCase().includes(want))
                  || rules.find(r => /SCOOTER|BIKE/i.test(String(r.segment || ''))) || rules[0]
                  || { insurer: insurerSlug, region: resolvedRegion || null };
        const clone = { ...base, rate_type: base.rate_type || want, rate_value: g,
          segment: 'TW (HDFC grid)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged on any failure */ }
  }

  // ---- New India Assurance motor OD+TP override ----
  // New India publishes commission as two legs: an OD-commission % (on OD
  // premium) and a TP-commission % (on TP premium). The operator's payout
  // tracker reports the headline rate as the SUM of the two legs (Comp = OD+TP,
  // SATP = TP, SAOD = OD). The ingested grid stored the two legs as separate
  // COMP/SATP rows, so the engine surfaced only ONE leg (e.g. the OD 20 for a
  // Pvt-Car package, vs the operator's 35 = 20+15). services/nia-motor.js
  // returns the summed target % from the published OD%/TP% tables (number), or
  // null when it doesn't cover the policy (PCV/MISC) → leave the engine alone.
  if (insurerSlug === 'new_india_assurance' &&
      ['CAR', 'TW', 'GCV', '4W', '2W', 'PC', 'PCV', 'MISC', 'MIS'].includes(String(params.vehicleType || '').toUpperCase())) {
    try {
      const { resolveNiaMotorRate } = require('../services/nia-motor');
      const res = resolveNiaMotorRate(params);
      if (res != null) {
        const ip = String(params.insProduct || '').toUpperCase();
        const want = (ip === 'TP' || ip === 'SATP' || ip === 'ACT') ? 'SATP'
                   : (ip === 'SAOD' || ip === 'OD') ? 'SAOD' : 'COMP';
        const base = rules.find(r => String(r.rate_type || '').toUpperCase().includes(want))
                  || rules[0]
                  || { insurer: insurerSlug, region: resolvedRegion || null };
        // rate_value = summed headline (operator match); od_rate/tp_rate = legs
        // so income = OD%×OD-prem + TP%×TP-prem.
        const clone = { ...base, rate_type: base.rate_type || want,
          rate_value: +(res.rate / 100).toFixed(4), is_declined: 0,
          od_rate: +(res.od / 100).toFixed(4), tp_rate: +(res.tp / 100).toFixed(4),
          segment: (base.segment || params.vehicleType || '') + ' (NIA OD+TP)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged on any failure */ }
  }

  // ---- National Insurance motor OD+TP override ----
  // Same two-leg structure as New India: commission = OD-leg + TP-leg, each leg
  // = Remuneration + Reward. The operator sums the legs (USER-confirmed). The
  // ingested grid stored Remuneration-only single legs, so the engine
  // undervalued (e.g. GCV ≤3.5T Other≤10 → 0.20 vs operator 70 = 25+45).
  // services/national-motor.js returns the summed % (number) or null.
  if (insurerSlug === 'national_insurance' &&
      ['CAR', 'TW', 'GCV', '4W', '2W', 'PC', 'PCV', 'MISC', 'MIS'].includes(String(params.vehicleType || '').toUpperCase())) {
    try {
      const { resolveNationalMotorRate } = require('../services/national-motor');
      const res = resolveNationalMotorRate(params);
      if (res != null) {
        const ip = String(params.insProduct || '').toUpperCase();
        const want = (ip === 'TP' || ip === 'SATP' || ip === 'ACT') ? 'SATP'
                   : (ip === 'SAOD' || ip === 'OD') ? 'SAOD' : 'COMP';
        const base = rules.find(r => String(r.rate_type || '').toUpperCase().includes(want))
                  || rules[0]
                  || { insurer: insurerSlug, region: resolvedRegion || null };
        // rate_value = headline (for operator rate-match); od_rate/tp_rate = the
        // per-leg commission so income = OD%×OD-prem + TP%×TP-prem.
        const clone = { ...base, rate_type: base.rate_type || want,
          rate_value: +(res.rate / 100).toFixed(4), is_declined: 0,
          od_rate: +(res.od / 100).toFixed(4), tp_rate: +(res.tp / 100).toFixed(4),
          segment: (base.segment || params.vehicleType || '') + ' (NIC OD+TP)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged on any failure */ }
  }

  // ---- Oriental new-vehicle BUNDLED OD+TP sum (all vehicle types) ----
  // Oriental's grid (image, USER-confirmed): a NEW vehicle sold as a Bundled Policy
  // pays an OD-leg % on OD premium + a TP-leg % on TP premium for the 1st year, and
  // the operator's tracker reports the headline as the SUM of the two legs (same
  // convention as New India / National). Each bundled product is ingested as TWO
  // separate rows under ONE bundled rate_type, both age 0-0:
  //   TW  "New Bundled (1+5)"  COMP_1+5 = 0.20 (OD) + 0.80 (TP) → 100
  //   CAR "New Bundled (1+3)"  COMP_1+3 = 0.30 (OD) + 0.50 (TP) →  80
  // filterRulesByPolicy collapses each rate_type to ONE surviving row, so the engine
  // surfaced only one leg (e.g. 0.20). USER rule: "all vehicle types where OD and TP
  // are defined separately → apply OD + TP." This fires ONLY when the matched pool
  // carries a bundled COMP_1+N rate_type (a genuine two-leg new-vehicle product) —
  // regular Package (single COMP row) and Liability (SATP) policies are untouched, so
  // the 36 Comp-package matches (operator pays COMP-only, e.g. CAR 15 / GCV 55) and
  // the SATP/SAOD matches stay intact. Re-read both legs and sum.
  if (insurerSlug === 'oriental_insurance' &&
      (Number(params.vehicleAge) || 0) === 0 &&
      rules.some(r => /^COMP_1\+\d/i.test(String(r.rate_type || '')))) {
    try {
      const bundledRt = String((rules.find(r => /^COMP_1\+\d/i.test(String(r.rate_type || ''))) || {}).rate_type || '').toUpperCase();
      const obKey = lookupKey + '||orientalBundle:' + bundledRt;
      let obRules;
      if (caches.lookup.has(obKey)) obRules = caches.lookup.get(obKey);
      else { obRules = await lookupRates(pool, { ...baseLookup, ins_product: '', vehicle_age: null }); caches.lookup.set(obKey, obRules); }
      const legs = obRules
        .filter(r => String(r.rate_type || '').toUpperCase() === bundledRt)
        .map(r => Number(r.rate_value) || 0)
        .filter(v => v > 0);
      if (legs.length >= 2) {
        const sum   = legs.reduce((a, b) => a + b, 0);
        const odLeg = Math.min(...legs);   // OD leg (smaller %)
        const tpLeg = Math.max(...legs);   // TP leg (larger %)
        const base = rules.find(r => String(r.rate_type || '').toUpperCase() === bundledRt) || rules[0];
        const clone = { ...base, rate_type: base.rate_type || bundledRt,
          rate_value: +sum.toFixed(4), is_declined: 0,
          od_rate: +odLeg.toFixed(4), tp_rate: +tpLeg.toFixed(4),
          segment: (base.segment || params.vehicleType || '') + ' (Oriental bundled OD+TP)' };
        rules = [clone, ...rules.filter(r => r !== base)];
      }
    } catch (_) { /* leave rules unchanged on any failure */ }
  }

  // ---- Bajaj PCV Staff Bus: COMP(OD-leg) + SATP(TP-leg) premium-weighted blend ----
  // Bajaj files the bus commission as TWO legs by rate_type: COMP = OD-leg %, SATP =
  // TP-leg % (e.g. Gujarat "Staff Bus SC>10" COMP 0.25 / SATP 0.53). A Comprehensive
  // bus is ~99% TP premium, so the operator's effective commission = the premium-
  // weighted blend (COMP×OD + SATP×TP)/net ≈ the SATP rate (~53 Gujarat/Mumbai, ~48
  // Pune). The engine was picking the flat COMP 0.25 (=25) — GJ10/1463 our 25 vs op 52.
  // USER-confirmed: use the region's OWN SATP. The two legs are sometimes filed under
  // DIFFERENT region labels (COMP under "GUJARAT", SATP under "GUJARAT, Daman & Diu,
  // Dadra & Nagar Haveli"), so the SATP is fetched by a STATE-TOKEN region match, not
  // the resolved region. Comp/Package only — SATP-only (Liability) buses already take
  // the SATP leg directly; the 0.025 residual SATP is excluded by the rate floor.
  if (insurerSlug === 'bajaj_allianz' &&
      String(params.vehicleType || '').toUpperCase() === 'PCV' &&
      /^COMP/i.test(String(params.insProduct || ''))) {
    const compBus = rules.find(r => /Staff\s*Bus/i.test(String(r.segment || '')) &&
                                     String(r.rate_type || '').toUpperCase() === 'COMP');
    const odP = Number(params.odPremium) || 0;
    const tpP = Number(params.tpPremium) || 0;
    const net = odP + tpP;
    if (compBus && net > 0) {
      try {
        const seg = compBus.segment;
        const stTok = String(resolvedRegion || '').trim().split(/[\s,]+/)[0] || '';   // GUJARAT / PUNE / MUMBAI…
        const sbKey = lookupKey + '||bajajBusSatp:' + seg + ':' + stTok;
        let satpRows;
        if (caches.lookup.has(sbKey)) satpRows = caches.lookup.get(sbKey);
        else {
          satpRows = (await pool.request()
            .input('seg', seg).input('tok', '%' + stTok + '%')
            .query(`SELECT TOP 1 rate_value FROM rate_rules
                    WHERE insurer='bajaj_allianz' AND product='PCV' AND segment=@seg
                      AND rate_type='SATP' AND rate_value > 0.3 AND region LIKE @tok
                    ORDER BY rate_value DESC`)).recordset;
          caches.lookup.set(sbKey, satpRows);
        }
        const satp = satpRows[0] ? Number(satpRows[0].rate_value) : null;
        const comp = Number(compBus.rate_value) || 0;
        if (satp != null) {
          const blend = (comp * odP + satp * tpP) / net;
          // Operator reports the headline as the FLOORED integer percent (52.78 and
          // 52.91 both → 52, not rounded to 53), so floor the blend to whole-percent
          // for the rate-match headline; od_rate/tp_rate keep the true legs for income.
          const headline = Math.floor(blend * 100) / 100;
          const clone = { ...compBus, rate_value: +headline.toFixed(4), is_declined: 0,
            od_rate: +comp.toFixed(4), tp_rate: +satp.toFixed(4),
            segment: (compBus.segment || '') + ' (Bajaj bus OD+TP)' };
          rules = [clone, ...rules.filter(r => r !== compBus)];
        }
      } catch (_) { /* leave rules unchanged on any failure */ }
    }
  }

  // ---- Kotak MISD flat-rate override ----
  // USER-confirmed: Kotak's MISD (Miscellaneous-D) segment has only TWO payout
  // rates — Tractor = 47.5% (any tractor on the acceptable-RTO list; the sheet's
  // per-RTO "CD" column 47%/40% is a category marker, NOT the payout, so the
  // engine wrongly surfaced 0.40/0.47) and Others (Garbage/Cash vans) = 35%.
  // Override the rate on the matched MIS row accordingly. Tractors whose RTO
  // isn't on the list resolve to no-rule (NIL PO) and are left untouched.
  if (insurerSlug === 'kotak' &&
      ['MISC', 'MIS'].includes(String(params.vehicleType || '').toUpperCase()) &&
      rules.length > 0) {
    const seg0 = String(rules[0].segment || '').toUpperCase();
    const cat  = String(params.vehicleCategory || '').toUpperCase();
    const isTractor = /TRACTOR/.test(seg0) || /TRACTOR/.test(cat) ||
                      /TRACTOR/.test(String(params.model || '') + ' ' + String(params.make || ''));
    const base = rules[0];
    // MISD pays only 47.5% or 35%. For tractors the sheet's per-RTO category
    // (carried as the ingested CD value: high tier ~47% → 47.5% payout; low
    // tier 40% → 35% payout) selects which. Non-tractor MISD (Garbage/Cash
    // vans) → 35%.
    const cd = Number(base.rate_value) || 0;
    const target = isTractor ? (cd >= 0.45 ? 0.475 : 0.35) : 0.35;

    const clone = { ...base, rate_value: target, is_declined: 0,
      segment: (base.segment || 'MISD') + ' (Kotak MISD)' };
    rules = [clone, ...rules.filter(r => r !== base)];
  }

  // ---- Kotak PCV flat 65% ----
  // USER-confirmed: Kotak pays a flat 65% on ALL PCV — no segment / seating /
  // age / cover condition. The ingested grid carried only ONE PCV row, segment
  // "School Bus" 0.65 (Pan India), so non-school-bus PCVs (e.g. a Maruti Omni
  // passenger van, TP-only) matched no segment and fell through to no-rule.
  // The operator file confirms 65 across Kotak PCV (school-bus AND others:
  // 5/5 paid 65). Inject a 0.65 rule for any Kotak PCV so every PCV prices at
  // 65; the school-bus rows already at 0.65 are unchanged (zero-regression).
  if (insurerSlug === 'kotak' && String(params.vehicleType || '').toUpperCase() === 'PCV') {
    const base = rules[0] || { insurer: insurerSlug, region: resolvedRegion || 'Pan India' };
    const clone = { ...base, rate_type: base.rate_type || 'COMP', rate_value: 0.65,
      is_declined: 0, segment: 'PCV (Kotak flat 65)' };
    rules = [clone];
  }

  // ---- Oriental Ambulance → dedicated "Ambulance" segment ----
  // Oriental's grid has a SEPARATE Ambulance segment (Package 20% / Liability 10%)
  // distinct from the generic MISC-D (Package 12.5% / Liability 8%). Ambulances
  // arrive vehicleType=MISC with vehicleCategory "MISC - D - Ambulance" — the
  // "MISC - D" prefix matches the generic MISC-D segment and (both rows being
  // make-null) the generic row wins the byType COMP slot before pickPrimary sees
  // the higher Ambulance rate. Detect AMBULANCE in category/model and keep ONLY the
  // Ambulance-segment rows so the dedicated rate wins. Oriental + MISC scoped; real
  // MISC-D earthmovers/transit-mixers (no AMBULANCE token) are untouched.
  if (insurerSlug === 'oriental_insurance' &&
      ['MISC', 'MIS'].includes(String(params.vehicleType || '').toUpperCase())) {
    const hay = `${params.make || ''} ${params.model || ''} ${params.vehicleCategory || ''}`.toUpperCase();
    if (/\bAMBULANCE\b/.test(hay)) {
      // Re-query fresh — the earlier filterRulesByPolicy byType collapse already
      // dropped the Ambulance COMP row in favour of the make-null MISC-D row.
      const ambKey = lookupKey + '||orientalAmb';
      let ambRules;
      if (caches.lookup.has(ambKey)) ambRules = caches.lookup.get(ambKey);
      else { ambRules = await lookupRates(pool, { ...baseLookup, segment: 'Ambulance' }); caches.lookup.set(ambKey, ambRules); }
      const ambPick = ambRules.filter(r => /AMBULANCE/i.test(String(r.segment || '')) && Number(r.rate_value) > 0);
      if (ambPick.length > 0) {
        // Respect the policy cover (COMP vs SATP) via filterRulesByPolicy.
        const ambFiltered = filterRulesByPolicy(ambPick, params);
        rules = ambFiltered.length > 0 ? ambFiltered : ambPick;
      }
    }
  }

  // ---- Oriental MISC Package OD+TP legs ----
  // Oriental's MISC Package rates (MISC-D, "MISC - D - Others", Ambulance) are TWO-
  // legged: a distinct OD-leg % and TP-leg % encoded in rate_text ("OD 0.125 TP 0.08"),
  // ingested as two COMP rows — the byType collapse keeps only ONE leg and applies it
  // flat to net premium (over/under-charging). USER-confirmed ("MISC others .. its
  // OD + TP"): commission = OD%×OD-prem + TP%×TP-prem, headline = OD+TP summed
  // (Oriental/NIA convention; when legs are equal the sum collapses to the single rate,
  // e.g. Ambulance OD0.2/TP0.2 → 20). Parse the surviving COMP row's rate_text and
  // attach od_rate/tp_rate so income (bulk.js ~L3729) is leg-based. Oriental+MISC+COMP;
  // SATP/Liability (single TP leg) is untouched.
  if (insurerSlug === 'oriental_insurance' &&
      ['MISC', 'MIS'].includes(String(params.vehicleType || '').toUpperCase())) {
    const compRule = rules.find(r => /^COMP/i.test(String(r.rate_type || '')));
    const m = compRule && String(compRule.rate_text || '').match(/OD\s*([\d.]+)\s*TP\s*([\d.]+)/i);
    if (compRule && m) {
      const odLeg = parseFloat(m[1]), tpLeg = parseFloat(m[2]);
      if (odLeg > 0 && tpLeg > 0) {
        const headline = (odLeg === tpLeg) ? odLeg : +(odLeg + tpLeg).toFixed(4);
        const clone = { ...compRule, rate_value: headline,
          od_rate: +odLeg.toFixed(4), tp_rate: +tpLeg.toFixed(4),
          segment: (compRule.segment || '') + ' (Oriental MISC OD+TP)' };
        rules = [clone, ...rules.filter(r => r !== compRule)];
      }
    }
  }

  // ---- Magma MISC construction-equipment → "CE Construction" segment ----
  // Magma files MISC-D in two flavours: garbage vehicles and Construction
  // Equipment ("CE Construction"). JCBs, excavators, loaders, graders, backhoes
  // etc. are CONSTRUCTION equipment (USER-confirmed "JCB is part of construction")
  // but they match the generic "MISC-D" segment (e.g. DL6/9560 JCB → MISC-D 0.21
  // instead of CE Construction). Detect construction equipment by make/model and
  // re-query the "CE Construction" segment; the highest-volume override below then
  // picks the top slab (SATP Above 2L 0.20 for DL NCR = operator 20). Magma+MISC.
  if (insurerSlug === 'magma_hdi' &&
      ['MISC', 'MIS'].includes(String(params.vehicleType || '').toUpperCase())) {
    const hay = `${params.make || ''} ${params.model || ''} ${params.vehicleCategory || ''}`.toUpperCase();
    const isCE = /\bJCB\b|EXCAVAT|\bLOADER\b|BACKHOE|GRADER|\bDOZER\b|\bCRANE\b|FORK\s*LIFT|FORKLIFT|POCLAIN|BOBCAT|COMPACTOR|\bPAVER\b|\bCONSTRUCTION\b/.test(hay);
    if (isCE) {
      const ceKey = lookupKey + '||magmaCE';
      let ceRules;
      if (caches.lookup.has(ceKey)) ceRules = caches.lookup.get(ceKey);
      else { ceRules = await lookupRates(pool, { ...baseLookup, segment: 'CE Construction' }); caches.lookup.set(ceKey, ceRules); }
      const cePick = ceRules.filter(r => /CE\s*Construction/i.test(String(r.segment || '')) && Number(r.rate_value) > 0);
      if (cePick.length > 0) rules = cePick;
    }
  }

  // ---- Magma always-highest volume-tier override ----
  // Magma's grids band the rate by a premium/IDV VOLUME slab ("Upto 2L"/"Above
  // 2L" for SATP; "Upto 5L"/"5L-18L"/"18L-30L"/"Above 30L" for Comp). The slab is
  // mis-selected from the (small) policy premium → the LOWEST tier, but the
  // operator always rates on the HIGHEST volume tier. USER-confirmed: "always take
  // higher volume in Magma." Re-query all volume tiers for the matched segment
  // (same cover via baseLookup.ins_product) and swap in the highest-rate row.
  // USER-confirmed for ALL Magma products (GCV/MISC/PCV/CAR/TW): the operator rates
  // on the HIGHEST volume TIER. Pick the highest tier (NOT the highest rate — within
  // a tier there are NCB/fuel sub-rows) and re-run filterRulesByPolicy so the right
  // sub-row in that tier is selected. e.g. BR Pvt-Car SATP "Above 2L" (right sub-row
  // 0.46) instead of "Upto 2L" 0.45. Only acts when the pool sits on a volume-tier
  // row and a higher tier exists.
  if (insurerSlug === 'magma_hdi' && rules.length > 0 &&
      rules.some(r => String(r.volume_tier || '').trim() !== '')) {
    const segRule = rules.find(r => String(r.volume_tier || '').trim() !== '');
    const _vt = String(params.vehicleType || '').toUpperCase();
    const _isCommercial = ['GCV', 'MISC', 'MIS', 'PCV'].includes(_vt);
    const _isSatpRule = /SATP|SAOD|ACT|^TP$/i.test(String(segRule && segRule.rate_type || ''));
    const seg = String(segRule && segRule.segment || '');
    // Rank a volume tier so "Above N" > "X-N" (upper bound) > "Upto N".
    const tierRank = (vt) => {
      const s = String(vt || ''); let m;
      if ((m = s.match(/above\s*(\d+)/i))) return parseInt(m[1], 10) + 1e6;
      if ((m = s.match(/(\d+)\s*L?\s*-\s*(\d+)/i))) return parseInt(m[2], 10);
      if ((m = s.match(/upto\s*(\d+)/i))) return parseInt(m[1], 10);
      return 0;
    };
    if (!(_isCommercial || _isSatpRule)) {
      // ---- Personal-vehicle (Pvt Car / TW) Comprehensive ----
      // USER-confirmed: the operator rates these at the HIGHEST volume tier, on the
      // grid selected by BUSINESS TYPE, then the fuel&NCB sub-row. Magma's Comp grid
      // splits into NEW-BUSINESS bundled grids (COMP_1+1 = annual OD+TP, COMP_1+3 =
      // multi-year TP) and a plain COMP renewal/rollover grid. (Our ingest stamped
      // the _1+1/_1+3 grids vehicle_age 0-0 — that's the "1+1"/"1+3" tenure label
      // mis-read as age, NOT a real new-vehicle age gate: e.g. DJ1/6551 is an age-4
      // Used Rollover but BUSINESS_TYPE='New Business', and the operator used
      // COMP_1+1. So we IGNORE the age band here and pick the grid by business type.)
      //   New Business + annual TP  → COMP_1+1   (DJ1/6551 Petrol&NCB Above-30L 0.17 = op 17)
      //   New Business + multi-yr TP→ COMP_1+3
      //   Renewal / Rollover / other→ COMP       (plain age-agnostic renewal grid)
      // MH24/724 (New Business, Diesel&NCB) → COMP_1+1 Above-30L 0.16 = operator 16.
      const isNew = /NEW/i.test(String(params.businessType || ''));
      const tb = String(policy._tenureBucket || '').trim();
      const wantRt = !isNew ? 'COMP'
                   : (tb === '1+5' || tb === '5+5') ? 'COMP_1+3'
                   : 'COMP_1+1';
      const pcKey = lookupKey + '||magmaPC:' + seg + ':' + wantRt;
      let pcRules;
      if (caches.lookup.has(pcKey)) pcRules = caches.lookup.get(pcKey);
      // Clear vehicle_age (the _1+1/_1+3 grids carry a spurious 0-0 age band) and
      // ins_product (so all COMP-family rate_types are returned), then pick by name.
      else { pcRules = await lookupRates(pool, { ...baseLookup, volume_tier: '', ins_product: '', vehicle_age: null }); caches.lookup.set(pcKey, pcRules); }
      let cand = pcRules.filter(r => String(r.segment || '') === seg &&
        String(r.rate_type || '').toUpperCase() === wantRt &&
        String(r.volume_tier || '').trim() !== '');
      // Fuel: Pvt-Car rows split Diesel vs everything-else (Petrol grid also serves
      // CNG/LPG/EV/Hybrid — no own row). TW may have no fuel split.
      const pf = String(params.fuelType || '').toUpperCase();
      if (cand.some(r => r.fuel_type)) {
        const fuMatch = cand.filter(r => {
          const rf = String(r.fuel_type || '').toUpperCase();
          if (!rf) return true;
          return /DIESEL/.test(rf) ? /DIESEL/.test(pf) : !/DIESEL/.test(pf);
        });
        if (fuMatch.length) cand = fuMatch;
      }
      // NCB sub-row: remarks carry "& NCB" vs "& Zero NCB" (COMP_1+3 has no split).
      const hasNcb = Number(params.ncbPct || 0) > 0;
      const ncbMatch = cand.filter(r => {
        const rem = String(r.remarks || '');
        if (!/ncb/i.test(rem)) return true;          // no NCB split → keep
        const isZero = /zero\s*ncb/i.test(rem);
        return hasNcb ? !isZero : isZero;
      });
      if (ncbMatch.length) cand = ncbMatch;
      // Highest volume tier.
      if (cand.length) {
        const maxRank = Math.max(...cand.map(r => tierRank(r.volume_tier)));
        const top = cand.filter(r => tierRank(r.volume_tier) === maxRank);
        if (top.length) rules = top;
      }
    } else {
    // "Always highest tier" for SATP premium slabs (all products) and COMMERCIAL
    // Comp (GCV/MISC/PCV — always high-value). Pick the highest tier (NOT highest
    // rate — within a tier are NCB/fuel sub-rows) and re-run filterRulesByPolicy.
    const hvKey = lookupKey + '||magmaHiVol:' + seg;
    let hvRules;
    if (caches.lookup.has(hvKey)) hvRules = caches.lookup.get(hvKey);
    else { hvRules = await lookupRates(pool, { ...baseLookup, volume_tier: '' }); caches.lookup.set(hvKey, hvRules); }
    const segRows = hvRules.filter(r => String(r.segment || '') === seg && String(r.volume_tier || '').trim() !== '');
    if (segRows.length) {
      const maxRank = Math.max(...segRows.map(r => tierRank(r.volume_tier)));
      if (maxRank > tierRank(segRule.volume_tier)) {
        const topRows = segRows.filter(r => tierRank(r.volume_tier) === maxRank);
        const filtered = filterRulesByPolicy(topRows, params);
        if (filtered.length) rules = filtered;
      }
    }
    }
  }

  // ---- IDV gate DISABLED ----
  // Per product owner ("ignore IDV and apply"): commission rules are applied
  // REGARDLESS of IDV. (Previously a >₹50L IDV cleared the pool as a high-value
  // referral; that proved wrong — the operator pays commission on high-IDV vehicles,
  // e.g. National MISC-D trailers and commercial fleets.) Kept as a named constant
  // (always false) so the downstream no-rule note / output flag references still resolve.
  const idvOver50L = false;
  if (idvOver50L) rules = [];

  // ---- Reliance Pvt-Car Comp & SAOD grid (effective 1 Apr 2026) ----
  // User-supplied fuel/product grid the ingested card (468) missed: Comprehensive
  // is Petrol/CNG/LPG = 30% everywhere / Diesel-EV = region 5-10%; SAOD non-high-end
  // = 30%. Authoritative for Reliance CAR COMP/SAOD, so the computed rate REPLACES the
  // pool (diesel-EV's LOWER rate must win, not pickPrimary's MAX) and also rescues the
  // no-rule cars (city-region like "SURAT" had no CAR rule). SATP / unknown region →
  // resolver returns null → pool untouched. SAOD high-end & Extended-Warranty (20%) are
  // intentionally left as default (operator data showed no clean luxury-SAOD rule).
  if (insurerSlug === 'reliance' && String(params.vehicleType || '').toUpperCase() === 'CAR') {
    const _relCar = require('../services/reliance-car').resolveRelianceCarRate(params, params.resolvedRegion || resolvedRegion);
    if (_relCar) {
      const _base = rules[0] || {};
      const _rt = (Number(params.tpPremium) || 0) < 1 ? 'SAOD' : 'COMP';
      rules = [{ ..._base,
        id: _base.id || -7301,
        insurer: 'reliance', product: 'CAR',
        region: String(resolvedRegion || _base.region || ''),
        segment: _relCar.label, sub_type: '', make: 'All', fuel_type: null,
        rate_type: _rt, rate_value: _relCar.rate,
        rate_text: _relCar.label, remarks: 'Reliance Apr26 Comp&SAOD grid' }];
    }
  }

  // ---- Shriram Pvt-Car explicit-NCB-row preference ----
  // Shriram prices Pvt-Car cells as NCB / Without-NCB twins (in remarks), plus
  // unbanded make-special rows ("Only HONDA & HYUNDAI & KIA manufacture only",
  // PACK_SHRIRAM_OD). The NCB scoring can't cross rate_types, so the unbanded
  // 32.5 OD row beat the exact "Without NCB Except Maruti ALTO/SWIFT" 20 for an
  // NCB-0 aged i20 (PJ2/4799, operator 20). USER-confirmed: NCB-0 renewals take
  // the Without-NCB row. Aged (>=1) NCB-0 cars with an explicit Without-NCB row
  // in the pool drop unbanded siblings; new cars (age 0) keep the special rows.
  if (insurerSlug === 'shriram' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      (Number(params.ncbPct) || 0) === 0 &&
      (Number(params.vehicleAge) || 0) >= 1 && rules.length > 1) {
    const hasWithoutNcb = rules.some(r => /\bwithout\s*ncb\b/i.test(String(r.remarks || '')));
    if (hasWithoutNcb) {
      rules = rules.filter(r => /\bncb\b/i.test(String(r.remarks || '')) === true
        ? true : !/PACK_SHRIRAM_OD|SAOD_SHRIRAM_OD/i.test(String(r.rate_type || '')))
        .filter(r => !(/\bncb\s*cases\b/i.test(String(r.remarks || '')) && !/without/i.test(String(r.remarks || ''))));
    }
  }

  // ---- Zuno Pvt-Car SAOD routing ----
  // Zuno keeps its only CAR-SAOD rates OUTSIDE the regional grids: "All doable
  // RTO'S" SAOD 24% (NCB 1-99) and the Pan-India "NCB = 0 → 15%" floor. A
  // Gujarat (etc.) SAOD car finds no regional SAOD rule, the SAOD-as-Comp pass
  // borrows the regional COMP 28%, and the zunoCandidates fallback never fires
  // (pool non-empty) — so ALL Zuno SAOD cars over-rated at 28 (operator: NCB-0
  // → 15, NCB-positive → 24). Route them to the real SAOD rows. (The 12 cars
  // the operator paid 19.5/20 = the OD-disc ≥85% override — discount data is
  // blank in tmp and Zuno has no PR matches, so they land on 24 = closer.)
  const _zunoTpEnd = new Date(policy.TP_POLICY_END_DATE != null ? policy.TP_POLICY_END_DATE : NaN);
  const _zunoHasLiveTp = !isNaN(_zunoTpEnd.getTime()) && _zunoTpEnd.getFullYear() > 2000;
  const _zunoIsNew = (Number(params.vehicleAge) || 0) === 0 ||
                     String(params.vehicleRegNo || '').trim().toUpperCase() === 'NEW';
  // North states keep the regional flat rate for NCB=0 (USER-confirmed, DL10/6283) —
  // the Pan-India NCB=0 floor must not be forced there.
  const _zunoNorth = /^(UTTAR PRADESH|DELHI|PUNJAB|HARYANA|CHANDIGARH)$/i.test(String(params.resolvedRegion || resolvedRegion || ''));
  if (insurerSlug === 'zuno' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' && !_zunoIsNew) {
    // Zuno keeps its CAR SAOD rate ("All doable RTO'S" SAOD 24, NCB 1-99) and the
    // Pan-India "NCB = 0 → 15" floor OUTSIDE the regional grids, and the regional
    // match keeps the zero-rule fallback from ever pooling them. Operator logic
    // (verified GJ, 38 cars): no live TP leg (epoch TP_POLICY_END_DATE, raw
    // NET_LIABILITY=0 — params.tpPremium is unreliable: the Net−OD fallback
    // manufactures a phantom TP) → true SAOD → NCB>0 = 24, NCB=0 = 15 floor;
    // live TP leg (genuine Package) → NCB>0 = regional Comp (28), NCB=0 = 15
    // floor (the floor is a COMP override and applies to Package too, except
    // the North-flat states).
    const _zunoTrueSaod = String(params.insProduct || '').toUpperCase() === 'SAOD' ||
      ((Number(params.odPremium) || 0) > 0 &&
       (parseFloat(policy.NET_LIABILITY_PREMIUM) || 0) < 1 && !_zunoHasLiveTp);
    // TP-only (standalone-TP / Liability, no OD leg) must NOT take the NCB=0
    // floor — that floor is a COMPREHENSIVE override (applies to OD&TP), whereas
    // a TP-only policy takes its regional SATP rate. USER-checked BG3/5116
    // (KA Bolero, Liability, NET_OD=0, NCB=0): operator paid the Karnataka SATP
    // 18, not the 15 floor. Detect TP-only by no OD premium + TP-product.
    const _zunoTpOnly = (Number(params.odPremium) || 0) <= 0 &&
      /^(TP|SATP|ACT|LIABILITY)$/.test(String(params.insProduct || '').toUpperCase());
    const ncb = Number(params.ncbPct) || 0;
    if (!_zunoTpOnly && (_zunoTrueSaod || (ncb === 0 && !_zunoNorth))) {
      const zKey = 'zuno||carSaodRows';
      let zRows;
      if (caches.lookup.has(zKey)) zRows = caches.lookup.get(zKey);
      else {
        const zq = await pool.request().query(
          `SELECT * FROM rate_rules WHERE insurer = 'zuno' AND product = 'CAR' AND rate_value IS NOT NULL
             AND (rate_type = 'SAOD' OR (sub_type = 'NCB=0' AND region LIKE 'Pan India%'))`);
        zRows = zq.recordset || [];
        caches.lookup.set(zKey, zRows);
      }
      const floorRow = zRows.find(r => String(r.sub_type || '') === 'NCB=0');
      const saodRow  = zRows.find(r => String(r.rate_type) === 'SAOD');
      let pick = null;
      if (ncb === 0 && !_zunoNorth) pick = floorRow || (
        _zunoTrueSaod ? saodRow : null);                  // NCB=0 → 15 floor (SAOD & Package alike)
      else if (_zunoTrueSaod && ncb > 0) pick = saodRow;  // true SAOD, NCB>0 → 24
      if (pick) rules = [pick];
    }
  }

  // ---- Go Digit CAR: Comprehensive/SAOD must not take the SATP "MAX_CD2" rate ----
  // "MAX_CD2" is the 4W-SATP commission column (source sheet "4W SATP", header
  // "Max CD2", region label "Guj_Good") — the Standalone-TP grid, NOT a
  // comprehensive rate. A Comprehensive car with identifiable fuel/CC resolves to
  // the SATP region ("Guj_Good") and pickPrimary takes the higher SATP rate (e.g.
  // Diesel<1500 39) — but the real "Pvt Car Comp+SAOD Grid" rate lives under a
  // DIFFERENT region label ("GJ_Good"/cluster) that wasn't pooled, so it's
  // unreachable. USER-confirmed (GJ1/32268 Ford Ecosport, Comprehensive, od 706):
  // should be COMP_NCB 28, not SATP 39. Blast radius verified: 66 of 67 CAR
  // MAX_CD2 cars are genuinely TP-only (keep MAX_CD2) — only this 1 Comp car.
  // For a NON-TP go_digit CAR: drop MAX_CD2 intruders; if that empties the pool
  // (SATP region was the only one resolved), fetch the Comp+SAOD grid rate for
  // the RTO's Comp-grid region by NCB.
  if (insurerSlug === 'go_digit' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' && rules.length) {
    const ipU = String(params.insProduct || '').toUpperCase();
    const isTpOnly = /^(TP|SATP|ACT|LIABILITY)$/.test(ipU) || (Number(params.odPremium) || 0) <= 0;
    if (!isTpOnly) {
      const nonCd2 = rules.filter(r => String(r.rate_type || '').toUpperCase() !== 'MAX_CD2');
      if (nonCd2.length && nonCd2.length !== rules.length) {
        rules = nonCd2;                               // Comp/SAOD rows already pooled — evict the SATP intruder
      } else if (!nonCd2.length) {
        // Pool was ONLY MAX_CD2 (SATP region resolved) — fetch the real Comp/SAOD rate.
        const isSaod = ipU === 'SAOD';
        const ncb = Number(params.ncbPct) || 0;
        const wantType = isSaod ? (ncb > 0 ? 'SAOD_NCB' : 'SAOD_NON_NCB')
                                : (ncb > 0 ? 'COMP_NCB' : 'COMP_NON_NCB');
        const rtoN = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        try {
          const cq = await pool.request()
            .input('rto', sql.NVarChar(20), rtoN)
            .input('wt', sql.NVarChar(20), wantType)
            .query(`SELECT TOP 1 rr.* FROM rate_rules rr
                    WHERE rr.insurer='go_digit' AND rr.product='CAR' AND rr.rate_type=@wt
                      AND rr.rate_value IS NOT NULL
                      AND rr.region IN (SELECT region FROM rto_mappings
                                        WHERE insurer='go_digit'
                                          AND REPLACE(REPLACE(rto_code,'-',''),' ','')=@rto)`);
          if (cq.recordset.length) rules = [cq.recordset[0]];
        } catch (_) { /* leave rules unchanged on lookup failure */ }
      }
    } else {
      // TP-only: the SATP "MAX_CD2" cluster must come from the AUTHORITATIVE
      // "4W RTO" sheet (4WTP column), not our rto_mappings — which lists some
      // RTOs under BOTH Good and Bad (e.g. WB20 → WB_Bad AND WB_Good) so the
      // lookup picked the wrong one. USER-confirmed BH2/6107 (WB20 Petrol>1000):
      // WB_Good = 40, not WB_Bad 43. Re-resolve to cl.tp and re-fetch the MAX_CD2
      // rate for the same fuel/CC segment at the policy's age band.
      let _gdCl = null;
      try { _gdCl = require('../config/godigit_rto_cluster.json'); } catch (_) { _gdCl = {}; }
      const rtoN = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const authCl = _gdCl[rtoN] && _gdCl[rtoN].tp;
      const cur = rules.find(r => String(r.rate_type || '').toUpperCase() === 'MAX_CD2');
      if (authCl && cur && String(cur.region || '').toUpperCase() !== String(authCl).toUpperCase()) {
        try {
          const aq = await pool.request()
            .input('reg', sql.NVarChar(40), authCl)
            .input('seg', sql.NVarChar(40), cur.segment)
            .input('age', sql.Int, Math.round(Number(params.vehicleAge) || 0))
            .query(`SELECT TOP 1 rr.* FROM rate_rules rr
                    WHERE rr.insurer='go_digit' AND rr.product='CAR' AND rr.rate_type='MAX_CD2'
                      AND rr.region=@reg AND rr.segment=@seg AND rr.rate_value IS NOT NULL
                      AND @age BETWEEN COALESCE(rr.vehicle_age_min,0) AND COALESCE(rr.vehicle_age_max,99)`);
          if (aq.recordset.length) rules = [aq.recordset[0], ...rules.filter(r => r !== cur)];
        } catch (_) { /* leave rules unchanged on lookup failure */ }
      }
    }
  }

  // ---- Royal Haryana: non-Gurgaon/Faridabad HR cars use "Rest of State" ----
  // Royal's Haryana Comp grid rates ONLY the "Rest of State" tier (Key/Other
  // Cities rows are null). Gurgaon (HR26) & Faridabad (HR51) RTOs correctly use
  // the Delhi-NCR grid (HR26 op 20 ≈ 19.5); but every OTHER Haryana RTO (HR12,
  // HR98) wrongly fell to Delhi-NCR Other Cities (19.5) instead of Haryana Rest
  // of State (12.5). USER-confirmed (DL10/6468 HR98, FINALDISCOUNT 26 → "20-50"):
  // HR98 is Rest-of-Haryana (op 12.5) despite its PR "Gurgaon" tag. Route
  // non-Gurgaon/Faridabad HR CAR Comp to Haryana "Rest of State" for the band.
  if (insurerSlug === 'royal_sundaram' &&
      String(params.vehicleType || '').toUpperCase() === 'CAR' &&
      String(params.insProduct || '').toUpperCase() === 'COMP' &&
      params.discountPct != null && rules.length) {
    const rtoN = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const ROYAL_HR_NCR = new Set(['HR26', 'HR51', 'HR55', 'HR72', 'HR87']); // Gurgaon + Faridabad → Delhi-NCR grid
    if (/^HR\d+$/.test(rtoN) && !ROYAL_HR_NCR.has(rtoN)) {
      // Pick the Haryana "Rest of State" band (lower-incl: 50→"50-60", etc.).
      const d = Number(params.discountPct) || 0;
      const inBand = (t) => {
        let mm;
        if ((mm = /^upto\s*(\d+(?:\.\d+)?)$/i.exec(t)))                  return d >= 0 && d < parseFloat(mm[1]);
        if ((mm = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(t)))     return d >= parseFloat(mm[1]) && d < parseFloat(mm[2]);
        if ((mm = /^>\s*(\d+(?:\.\d+)?)$/.exec(t)))                      return d >= parseFloat(mm[1]);
        return false;
      };
      try {
        const hq = await pool.request().query(
          `SELECT * FROM rate_rules WHERE insurer='royal_sundaram' AND product='CAR'
             AND rate_type='Comp' AND remarks='Haryana' AND segment LIKE '%Rest of State%'
             AND rate_value IS NOT NULL`);
        const hit = hq.recordset.find(r => inBand(String(r.volume_tier || '').trim()));
        if (hit) rules = [hit];
      } catch (_) { /* leave rules unchanged on lookup failure */ }
    }
  }

  // ---- HDFC TW ROTN: make-specific row yields to "All" ----
  // In Rest-of-Tamil-Nadu (ROTN) the operator pays the make-agnostic ("All")
  // TW rate, NOT the make-specific lower one — e.g. TN1/791 (TN99 TVS Scooter
  // SAOD): grid ROTN Scooter TVS=45 vs All=55, operator pays 55. USER-confirmed,
  // ROTN-SCOPED: in Chennai the TVS-specific rate IS honored (TN1/782 op 45), so
  // this must NOT touch Chennai/other regions. The byType collapse keeps the
  // make-specific row (higher make-score) and drops "All", so fetch the ROTN
  // "All" row for the same segment/rate_type and use it.
  if (insurerSlug === 'hdfc_ergo' &&
      String(params.vehicleType || '').toUpperCase() === 'TW' &&
      String(resolvedRegion || '').toUpperCase() === 'ROTN' && rules.length) {
    const cur = rules[0];
    const curMake = String(cur && cur.make || '').toUpperCase();
    if (curMake && curMake !== 'ALL') {
      try {
        const aq = await pool.request()
          .input('seg', sql.NVarChar(40), cur.segment)
          .input('rt', sql.NVarChar(20), cur.rate_type)
          .query(`SELECT TOP 1 * FROM rate_rules WHERE insurer='hdfc_ergo' AND product='TW'
                    AND region='ROTN' AND segment=@seg AND rate_type=@rt
                    AND (make IS NULL OR UPPER(make)='ALL') AND rate_value IS NOT NULL
                  ORDER BY rate_value DESC`);
        if (aq.recordset.length) rules = [aq.recordset[0], ...rules.filter(r => r !== cur)];
      } catch (_) { /* leave rules unchanged on lookup failure */ }
    }
  }

  // ---- Shriram NEW two-wheeler: rate by BOOKING LOCATION (Mumbai grid) ----
  // A NEW TW has a placeholder/null RTO and resolves to ROM (Scooter 35), but the
  // operator rates it by the booking-location grid. Shriram's Mumbai TW grid
  // ("MUMBAI (Excl MH-01,48)/GOA", Scooter 40) is otherwise unreachable (compound
  // region label, no Shriram rto_mapping). USER-confirmed (MH37/3599 NEW Activa
  // booked Mumbai: op 40 = Mumbai Scooter, not ROM 35). For a Shriram NEW TW
  // booked in Mumbai (RTO not the excluded MH01/48), fetch the Mumbai grid rate
  // for the segment and inject it.
  if (insurerSlug === 'shriram' && String(params.vehicleType || '').toUpperCase() === 'TW' && rules.length) {
    const isNew = String(params.vehicleRegNo || '').trim().toUpperCase() === 'NEW' || (Number(params.vehicleAge) || 0) === 0;
    const booked = String(policy.BusinessBookedLocation || policy['BUSINESS BOOKED LOCATION'] || policy.BooKedLocation || '').toUpperCase();
    const rtoN = String(params.rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (isNew && /MUMBAI/.test(booked) && rtoN !== 'MH01' && rtoN !== 'MH48') {
      const curSeg = String((rules[0] && rules[0].segment) || '');
      const isScoot = /scooter|scooty|moped|activa/i.test(curSeg + ' ' + String(params.model || ''));
      try {
        const mq = await pool.request().input('seg', sql.NVarChar(40), isScoot ? '%Scooter%' : '%Bike%')
          .query(`SELECT TOP 1 * FROM rate_rules WHERE insurer='shriram' AND product='TW'
                    AND region LIKE 'MUMBAI (Excl%' AND segment LIKE @seg
                    AND rate_type LIKE 'PACK%' AND rate_value IS NOT NULL ORDER BY rate_value DESC`);
        if (mq.recordset.length) rules = [mq.recordset[0], ...rules.filter(r => r !== rules[0])];
      } catch (_) { /* leave rules unchanged on lookup failure */ }
    }
  }

  // Bajaj COMP OD leg — OEM vs NonOEM. Each district splits the COMP OD leg into
  // COMP_OD_OEM (OEM/dealer-sourced) and COMP_OD_NonOEM (open-market/broker), both
  // surviving byType. This is a BROKER book (MT/DIR… trackers), so the NonOEM rate
  // applies — drop the OEM rows when a NonOEM sibling is present so pickPrimary
  // takes NonOEM. USER-confirmed (BG3/5065 Honnavar Scooter: OEM 22.5 vs NonOEM
  // 17.5 = operator 18).
  if (insurerSlug === 'bajaj_allianz' &&
      rules.some(r => /^COMP_OD_NonOEM$/i.test(String(r.rate_type || '')))) {
    rules = rules.filter(r => !/^COMP_OD_OEM$/i.test(String(r.rate_type || '')));
  }
  // TATA NEW two-wheeler scooter in Delhi → Brand-New rate. A new vehicle
  // (reg 'NEW'/age 0) must take the "Brand New" sub_type, but TATA files the
  // Scooter Brand-New rate under rate_type DM|All while Renewal/Rollover sit in
  // DM|Package — so pickPrimary defaults to the Renewal Package rate (0.53) and
  // misses Brand New. For a Delhi scooter, Brand-New = DM|All 0.45. USER-confirmed
  // (DL1/2070 TVS Jupiter NEW, Delhi: grid Brand New 0.45; operator 30 is a
  // separate anomaly → As-per-Grid). Scoped to TATA+TW+NEW+Delhi+scooter so the
  // Maharashtra/other new-TW (operator pays Renewal HOM|Package 52) are untouched.
  if (insurerSlug === 'tata_aig' && productIsTw &&
      (String(params.vehicleRegNo || '').trim().toUpperCase() === 'NEW' || params.vehicleAge === 0) &&
      String(resolvedRegion || '').toUpperCase() === 'DELHI') {
    const _mdlScoot = `${params.model || ''} ${params.vehicleCategory || ''}`.toUpperCase();
    if (/ACTIVA|JUPITER|FASCINO|ACCESS|DIO|NTORQ|MAESTRO|AVIATOR|VESPA|SCOOTY|SCOOTER|CHETAK|IQUBE/.test(_mdlScoot)) {
      try {
        const bnq = await pool.request().query(
          `SELECT TOP 1 * FROM rate_rules WHERE insurer='tata_aig' AND product='TW'
             AND region='Delhi' AND segment='Scooter' AND sub_type='Brand New'
             AND rate_value IS NOT NULL ORDER BY rate_value DESC`);
        if (bnq.recordset.length) rules = [bnq.recordset[0]];
      } catch (_) { /* leave rules unchanged on lookup failure */ }
    }
  }
  let primary = pickPrimaryRateRule(rules);
  // ---- Enabler / special-payout override ----
  // A criteria-scoped enabler deal (segment + make + transaction + RTO location +
  // date window) overrides the policy's income rate to the deal's COA% — REGARDLESS
  // of the base grid, and even when no base rule matched (the deal itself is the
  // rate). Only matching policies change; every other policy keeps the system rate.
  // Criteria-only (no IMD/agent link) per product owner; COA → income rate.
  let _enablerHit = null;
  if (caches && caches.enablers && caches.enablers.length && !idvOver50L) {
    _enablerHit = require('../services/enablers').pickEnablerOverride(params, caches.enablers, {
      issueDate: policy.POLICY_ISSUED_DATE || policy['POLICY_ISSUED_DATE'] || null,
      rtoCity: (rtoInfo && (rtoInfo.city || rtoInfo.region)) || null,
      cluster: (rtoInfo && rtoInfo.cluster) || null,
    });
  }
  if (_enablerHit && _enablerHit.coa_pct != null) {
    primary = { ...(primary || {}),
      id: primary ? primary.id : null,
      rate_value: Number(_enablerHit.coa_pct) / 100,
      od_rate: null, tp_rate: null,                 // flat COA — no OD/TP leg split
      rate_type: (primary && primary.rate_type) || 'ENABLER',
      segment: 'Enabler COA — ' + (_enablerHit.rto_location || _enablerHit.segment || 'deal'),
      sheet_name: 'enabler:' + (_enablerHit.deal_id || _enablerHit.id),
      _enabler_id: _enablerHit.id };
  }

  // ---- Fleet rate override ----
  // A per-customer fleet deal (insurer + customer/proposer name, optional vehicle type)
  // overrides the income rate to a FLAT rate for every matching policy — regardless of
  // the base grid, and even when no base rule matched. Most-specific customer-name match
  // wins. Takes final precedence (after the base rule and the enabler).
  let _fleetHit = null;
  if (caches && caches.fleets && caches.fleets.length && !idvOver50L) {
    _fleetHit = require('../services/fleets').pickFleetOverride(params, caches.fleets, insurerSlug);
  }
  if (_fleetHit && _fleetHit.rate_pct != null) {
    primary = { ...(primary || {}),
      id: primary ? primary.id : null,
      rate_value: Number(_fleetHit.rate_pct) / 100,
      od_rate: null, tp_rate: null,                 // flat fleet rate — no OD/TP leg split
      rate_type: (primary && primary.rate_type) || 'FLEET',
      segment: 'Fleet — ' + (_fleetHit.fleet_name || _fleetHit.customer_name || 'deal'),
      sheet_name: 'fleet:' + _fleetHit.id,
      _fleet_id: _fleetHit.id };
  }

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
    // All-insurer IDV gate takes precedence over any other no-rule reason.
    if (idvOver50L) {
      why = 'IDV > ₹50L — rule not applied (all-insurer rule)';
      bits.push(`idv=${Math.round(Number(params.idv))}`);
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

  // ---- Bajaj split OD/TP COMP grid → leg-based income (OD-% headline) ----
  // Bajaj's per-district grid files the COMP commission as SEPARATE legs:
  // COMP_OD_* (OD-premium leg) and COMP_TP (TP-premium leg), e.g. "5% on OD &
  // 0% on TP". The operator quotes the OD-leg % as the Total Rate (Kanchipuram
  // TN21: grid 5% on OD / 0% on TP, operator paid 5 = the OD%). pickPrimary
  // already headlines the OD leg, so the rate_pct is correct — but INCOME must be
  // leg-based (OD%×OD + TP%×TP), NOT the OD% applied to the whole premium (which
  // over-counts the No-PO TP). So fetch the same-district COMP_TP rate (absent →
  // 0 = No-PO) and attach od_rate/tp_rate; the headline stays the OD %.
  // USER-confirmed (earlier premium-weighted-blend headline understated it —
  // Kanchipuram blend 1.985 vs op 5 — reverted to the OD-% headline). Only fires
  // for a genuine package (both legs present) on a COMP_OD headline — ~2/cycle.
  if (insurerSlug === 'bajaj_allianz' && primary &&
      /^COMP_OD(_|$)/i.test(String(primary.rate_type || ''))) {
    const odP = Number(params.odPremium) || 0;
    const tpP = Number(params.tpPremium) || 0;
    if (odP > 0 && tpP > 0) {
      let tpRate = 0;
      try {
        const tpq = await pool.request()
          .input('reg', sql.NVarChar, String(primary.region || ''))
          .input('seg', sql.NVarChar, String(primary.segment || ''))
          .input('sub', sql.NVarChar, String(primary.sub_type || ''))
          .input('card', sql.Int, Number(primary.rate_card_id) || 0)
          .query(`SELECT TOP 1 rate_value FROM rate_rules
                  WHERE insurer='bajaj_allianz' AND product=@prod AND region=@reg
                    AND ISNULL(segment,'')=@seg AND ISNULL(sub_type,'')=@sub
                    AND rate_type='COMP_TP' AND rate_card_id=@card`
                  .replace('@prod', `'${String(primary.product || '').replace(/'/g, "''")}'`));
        if (tpq.recordset.length) tpRate = Number(tpq.recordset[0].rate_value) || 0;
      } catch (_) { /* leave tpRate=0 (No-PO) on lookup failure */ }
      const odRate = Number(primary.rate_value) || 0;
      // Headline rate_pct STAYS the OD-leg % (= the grid's "X% on OD" — what the
      // operator quotes as Total Rate, e.g. Kanchipuram TN21 op 5 = OD 5%). Only
      // attach the OD/TP legs so INCOME is leg-based (OD%×OD + TP%×TP) rather than
      // OD% applied to the whole premium. (Earlier premium-weighted-blend headline
      // understated it — Kanchipuram blend 1.985 vs op 5; reverted per USER.)
      primary.od_rate = odRate;
      primary.tp_rate = tpRate;
    }
  }

  let rateVal = Number(primary.rate_value || 0);
  if (rateVal > 1) rateVal = rateVal / 100;
  // Universal Sompo GCV — operator pays a uniform +1% over the grid (confirmed
  // via file recon: every GCV rate is exactly our grid + 1%). Insurer+product
  // scoped, applied to the resolved (non-zero) rate.
  if (insurerSlug === 'universal_sompo' && String(params.vehicleType || '').toUpperCase() === 'GCV' && rateVal > 0) {
    rateVal = +(rateVal + 0.01).toFixed(6);
  }
  const premiumBase = premiumBaseFor(params, primary.rate_type);
  // OD+TP rates: when a rule carries SEPARATE OD and TP commission legs
  // (rule.od_rate / rule.tp_rate, as fractions), the commission is OD% applied
  // to the OD premium + TP% applied to the TP premium — NOT a single headline
  // rate on the whole premium. The OD premium ALREADY includes add-on (per
  // insurer), so add-on is NOT added again. Headline rate_pct (rateVal) is
  // still used for operator rate-matching.
  let income;
  if (primary.od_rate != null || primary.tp_rate != null) {
    const odP = Number(params.odPremium) || 0;
    const tpP = Number(params.tpPremium) || 0;
    income = (Number(primary.od_rate) || 0) * odP + (Number(primary.tp_rate) || 0) * tpP;
  } else {
    income = rateVal * premiumBase;
  }

  // Match a margin rule for this policy
  const matchedMargin = matchMarginForPolicy(params, rtoInfo, marginRules);
  // Default-margin fallback: apply a flat per-product-class default so the row
  // doesn't end up at 0% margin.
  //   Pvt Car (CAR / 4W / PC)         → 5%
  //   Commercial (GCV / PCV / MISC)   → 6%
  //   Two-wheeler (TW / 2W / TW_EV)   → 3%
  // Fires when no margin_rule matched OR the matched rule is 0% (a 0%-margin
  // rule otherwise blocks the default and the row shows 0). A matched rule with
  // a real (>0) margin always wins.
  const matchedMarginPct = matchedMargin ? Number(matchedMargin.margin_pct) : null;
  let _syntheticMargin = null;
  if (!matchedMargin || !(matchedMarginPct > 0)) {
    const vt = String(params.vehicleType || '').toUpperCase();
    const isPvtCar = vt === 'CAR' || vt === '4W' || vt === 'PC' || vt === 'PVT.CAR';
    const isCv     = vt === 'GCV' || vt === 'PCV' || vt === 'MISC' || vt === 'MIS' || vt === 'CV';
    const isTw     = vt === 'TW' || vt === '2W' || vt === 'TW_EV';
    if (isPvtCar)    _syntheticMargin = { id: null, margin_pct: 5, _synthetic: true, _basis: 'default Pvt Car 5%' };
    else if (isCv)   _syntheticMargin = { id: null, margin_pct: 6, _synthetic: true, _basis: 'default CV 6%' };
    else if (isTw)   _syntheticMargin = { id: null, margin_pct: 3, _synthetic: true, _basis: 'default TW 3%' };
  }
  // Prefer a real (>0) matched margin; else the synthetic default; else the
  // matched (possibly 0) rule / null.
  const effectiveMatched = (matchedMargin && matchedMarginPct > 0)
    ? matchedMargin
    : (_syntheticMargin || matchedMargin);
  const defaultMarginPctRaw = effectiveMatched ? Number(effectiveMatched.margin_pct) : 0;
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
    // Pick the most-specific uplift scoped to this policy's product / insurer
    // (product+insurer > product > insurer > agent-wide). 0 if none match.
    const uplift = _pickUplift(globalUpliftByAgent.get(_aUpin), params.vehicleType, insurerSlug);
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

  const _vuRow = buildOutputRow(policy, params, primary, rateVal, effectiveMatched, {
    premium_base: premiumBase,
    income, savings, outgoing,
    special: specialTag,
  }, _rateRecoveryNote, stmt, pr);
  // Context for the volume-uplift post-pass (depends on per-agent totals, so it
  // can't run per-policy). Stripped from every row before snapshot/return.
  _vuRow._vu = {
    agent: _aUpin, params, rtoInfo, premiumBase,
    tracker: String(policy.TrackerNo || '').trim(),
    date: policy.SubmissionDate || policy.CREATED_DATE || policy.OkaytoLogDate || null,
  };
  return _vuRow;
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
    vehicle_no: params.vehicleRegNo || policy.VEHICAL_NO || policy.VEHICLE_NO || policy['VEHICLE NO'] || null,
    rto_code: params.rtoCode,
    region: params.resolvedRegion || null,
    od_premium: params.odPremium || 0,
    tp_premium: params.tpPremium || 0,
    addon_premium: params.addonPremium || 0,
    net_premium: params.netPremium || 0,
    premium_base: premiumBaseShown,
    // IDV (Insured Declared Value) — surfaced so the UI can show the
    // compliance reason at a glance (Compliance requires IDV ≤ ₹50L for
    // non-TP policies).
    idv: _idv > 0 ? _idv : null,
    // IDV gate disabled ("ignore IDV and apply") — nothing is referred on IDV, so this
    // is always false. The recon "IDV > 50L" referral card consequently shows 0.
    idv_over_50l: false,
    matched_rule_id:  rule ? rule.id : null,
    matched_sheet:    rule ? rule.sheet_name : null,
    matched_segment:  rule ? rule.segment : null,
    matched_rate_type: rule ? rule.rate_type : null,
    rate_pct:   rateVal != null ? +(rateVal * 100).toFixed(3) : null,
    // OD+TP per-leg commission (fractions) — present only for rules that split
    // the rate into OD% (on OD premium) + TP% (on TP premium). Lets the income
    // re-derivation (applyOverrides) reproduce the per-leg calc, not rate×base.
    od_rate: rule && rule.od_rate != null ? Number(rule.od_rate) : null,
    tp_rate: rule && rule.tp_rate != null ? Number(rule.tp_rate) : null,
    // Per-leg commission amounts (OD% × OD-premium, TP% × TP-premium) — shown
    // in the bulk screen alongside OD Rate / TP Rate / Total for OD+TP rules.
    od_comm: rule && rule.od_rate != null ? +(Number(rule.od_rate) * (params.odPremium || 0)).toFixed(2) : null,
    tp_comm: rule && rule.tp_rate != null ? +(Number(rule.tp_rate) * (params.tpPremium || 0)).toFixed(2) : null,
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
    // Outgoing % — Rate − effective Margin. Surfaced as a top-level field
    // so the UI and CSV download can read it directly without
    // recomputing. applyOverrides() recomputes when the user edits any axis.
    outgoing_pct: +(
      Number(rateVal != null ? rateVal * 100 : 0)
      - (nums && nums.special ? Number(nums.special.effective_margin_pct || 0)
                              : (marginRule ? Number(marginRule.margin_pct || 0) : 0))
    ).toFixed(3),
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
    // Bidirectional + core/first-token match — mirrors the "All insurers"
    // branch below. A naive forward-only prefix (`INSURERNAME LIKE @slug%`)
    // fails when the slug is LONGER than the brand name in tmp_PrarambhData
    // (e.g. INSURERNAME "Liberty" with slug "liberty_videocon" → 0 rows). The
    // reverse comparison and the "_videocon/_general/…" core strip recover it.
    const core = insurer_slug.replace(/_(general|insurance|videocon|hdi|allianz|tokio|sundaram|sompo|lombard|ergo|aig|ms)$/i, '');
    const firstToken = insurer_slug.split('_')[0];
    req2.input('slug', sql.NVarChar(100), insurer_slug);
    req2.input('slugCore', sql.NVarChar(100), core);
    req2.input('slugFirst', sql.NVarChar(100), firstToken);
    whereBits.push(`(
        LOWER(REPLACE(INSURERNAME, ' ', '_')) LIKE LOWER(@slug) + '%'
     OR LOWER(@slug) LIKE LOWER(REPLACE(INSURERNAME, ' ', '_')) + '%'
     OR LOWER(REPLACE(INSURERNAME, ' ', '_')) LIKE LOWER(@slugCore) + '%'
     OR LOWER(REPLACE(INSURERNAME, ' ', '_')) LIKE LOWER(@slugFirst) + '%'
    )`);
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
        // Bidirectional match — handles both directions of brand-name drift:
        //  (1) INSURERNAME more specific than slug: "Bajaj Allianz General"
        //      → "bajaj_allianz_general" LIKE "bajaj_allianz%" ✓
        //  (2) INSURERNAME shorter than slug: "Liberty" with slug
        //      "liberty_videocon" → reverse match "liberty_videocon" LIKE
        //      "liberty%" ✓
        //  Also strip trailing "_general" / "_insurance" / "_videocon" from
        //  the slug before the second comparison so brand renames (Liberty
        //  Videocon → Liberty, IFFCO-Tokio → IFFCO Tokio General) still hit.
        const ors = slugs.map((s, i) => {
          // Bidirectional + first-word fallback to handle brand drift:
          //   (a) INSURERNAME more specific than slug: "Bajaj Allianz General"
          //       → starts with "bajaj_allianz"
          //   (b) INSURERNAME shorter than slug: "Liberty" / slug
          //       "liberty_videocon"
          //   (c) Different rooted name: "Cholamandalam" / slug "chola_ms"
          //       — match on the first token of the slug ("chola") which is
          //       a prefix of "cholamandalam".
          const core = s.replace(/_(general|insurance|videocon|hdi|allianz|tokio|sundaram|sompo|lombard|ergo|aig|ms)$/i, '');
          const firstToken = s.split('_')[0];
          req2.input('cfgSlug' + i, sql.NVarChar(100), s);
          req2.input('cfgSlugCore' + i, sql.NVarChar(100), core);
          req2.input('cfgSlugFirst' + i, sql.NVarChar(100), firstToken);
          return `(
              LOWER(REPLACE(INSURERNAME, ' ', '_')) LIKE LOWER(@cfgSlug${i}) + '%'
           OR LOWER(@cfgSlug${i}) LIKE LOWER(REPLACE(INSURERNAME, ' ', '_')) + '%'
           OR LOWER(REPLACE(INSURERNAME, ' ', '_')) LIKE LOWER(@cfgSlugCore${i}) + '%'
           OR LOWER(REPLACE(INSURERNAME, ' ', '_')) LIKE LOWER(@cfgSlugFirst${i}) + '%'
          )`;
        });
        whereBits.push(`(${ors.join(' OR ')})`);
      }
    } catch (_) { /* if rate_cards lookup fails, fall through with no filter */ }
  }
  // tmp_PrarambhData stores dates in SubmissionDate (datetime) — use that.
  // (Reported_Date is varchar like "04-Mar-26" so it's awkward to range-filter.)
  // Carry-forward window: operators bucket late-submitted policies from
  // the previous cycle and early-issued policies that arrived after the
  // cycle's close into the current cycle. The body can pass
  // `lookback_days` and `lookforward_days` to widen the SubmissionDate
  // filter by N days on each side. Defaults = 0 (strict window) for
  // backwards compatibility.
  const lookbackDays    = Math.max(0, Math.min(60, parseInt(body && body.lookback_days,    10) || 0));
  const lookforwardDays = Math.max(0, Math.min(60, parseInt(body && body.lookforward_days, 10) || 0));
  const widenDate = (d, days) => { const dd = new Date(d); dd.setDate(dd.getDate() + days); return dd; };
  if (!policy_nos) {
    if (date_from) {
      const eff = lookbackDays > 0 ? widenDate(date_from, -lookbackDays) : new Date(date_from);
      req2.input('dfrom', sql.DateTime, eff);
      whereBits.push(`SubmissionDate >= @dfrom`);
    }
    if (date_to) {
      const eff = lookforwardDays > 0 ? widenDate(date_to, lookforwardDays) : new Date(date_to);
      req2.input('dto', sql.DateTime, eff);
      whereBits.push(`SubmissionDate <= @dto`);
    }
  }
  const whereSql = whereBits.length > 0 ? ` WHERE ${whereBits.join(' AND ')} ` : ' ';
  req2.input('take', sql.Int, cap);
  req2.input('skip', sql.Int, skip);

  // Source table — tmp_PrarambhData (indexed). SELECT only the columns the
  // per-row processor actually consumes; the table has ~200 columns and a
  // naked SELECT * bricked the connection on non-trivial ranges.
  const PROJECT = [
    // ID = PrarambhMainId — joins to Prarambh_Live.TRN_PrarambhMotorDetails
    // for the tonnage + RTO fallbacks. Without it those lookups get no keys.
    'ID',
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
    'PREMIUM_WITHOUT_GST','ADD_ON_PREMIUM','Addon_Premium',
    'ANNUAL_PREMIUM','NCB','OD_DISCOUNT',
    'BUSINESS_TYPE_ID','SubmissionDate','POLICY_ISSUED_DATE','POLICY_START_DATE','City','BooKedLocation',
    // OD/TP period dates → odTenure/tpTenure → bundledTag ("1+1"/"1+3"/"3+3"); used by the
    // go_digit CAR bundled-vs-annual tenure routing (3+3 new car → 3+3_CD2, not annual).
    'OD_Start_Date','OD_End_Date','TP_POLICY_START_DATE','TP_POLICY_END_DATE',
    // Proposer name — used to infer Corporate vs Individual ownership (PCV
    // bus rates split on this; a company-style name → Corporate, else Individual).
    'FULLNAME_PROPOSER',
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
    'FULL NAME':                r.FULLNAME_PROPOSER,
    'PROPOSER NAME':            r.FULLNAME_PROPOSER,
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
    // tmp_PrarambhData carries TWO add-on columns: ADD_ON_PREMIUM (often empty)
    // and Addon_Premium (the populated one for many policies). Use whichever is
    // non-zero so add-on presence is detected reliably (e.g. Liberty's "Non
    // Add-on Cases" rate must NOT apply to a car that actually carries add-on
    // cover — GJ7/34068 has Addon_Premium=4343 but ADD_ON_PREMIUM=0).
    'ADD ON PREMIUM':           (Number(r.ADD_ON_PREMIUM) || Number(r.Addon_Premium) || 0),
    'ADDON PREMIUM':            (Number(r.ADD_ON_PREMIUM) || Number(r.Addon_Premium) || 0),
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
          `SELECT PTrackerno, Category, Make, Model, FuelType, VehicleSegment, NCBPercentage
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
        // Stash TRN's NCB% so the NCB-resolution pass (after the PR index
        // loads) can use it as the LAST fallback when tmp_PrarambhData and
        // PR both lack a usable NCB. Don't apply here — PR has priority.
        if (t.NCBPercentage != null && String(t.NCBPercentage).trim() !== '') {
          r._trnNcb = Number(t.NCBPercentage);
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
  // Enabler / special-payout overrides — criteria-scoped COA% income-rate
  // overrides from uploaded enabler emails (segment + make + transaction + RTO
  // location + date window). Empty array when none active.
  const enablerOverrides = await require('../services/enablers').loadEnablerOverrides(pool);
  // Fleet overrides — per-customer flat rate scoped to an insurer (e.g. "XYZ Ltd" → 30%).
  const fleetOverrides = await require('../services/fleets').loadFleetOverrides(pool);
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

  // ── NCB resolution fallback chain ───────────────────────────────────
  // Data-validation rule: when tmp_PrarambhData's NCB is missing / NULL /
  // ZERO, fall back to (1) the Premium Register row for the same policy,
  // then (2) the Beeinsured TRN_MotorTransactionForPrarambh NCB% (stashed
  // as r._trnNcb during the TRN backfill). The first source with a
  // positive NCB wins. A genuinely zero-NCB policy stays 0 only when ALL
  // three sources agree it's 0/absent.
  // Derive an RTO prefix (2 alpha + 1-2 digit) from a registration number.
  const rtoFromReg = (reg) => {
    const m = String(reg || '').toUpperCase().replace(/[\s-]/g, '').match(/^([A-Z]{2}\d{1,2})/);
    return m ? m[1] : '';
  };
  const isValidRto = (v) => /^[A-Z]{2}\d{1,2}$/i.test(String(v || '').trim());
  // Normalise an explicit RTO_Code column value to its BASE RTO: strip
  // separators and the trailing series letter(s). "DL-1C" → "DL1",
  // "MH 12 AB" → "MH12", "GJ05" → "GJ05". Returns '' for garbage
  // ("NEW", "NA", a branch code with no digits).
  const normRtoCode = (v) => {
    const raw = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = raw.match(/^([A-Z]{2}\d{1,3})/);   // state letters + district digits
    return m ? m[1] : '';
  };

  // Pre-fetch RTO from Prarambh_Live.TRN_PrarambhMotorDetails (keyed by
  // PrarambhMainId) — the LAST RTO fallback when both tmp_PrarambhData and
  // the Premium Register lack a usable RTO. Batched once for the whole run.
  let trnRtoById = new Map();
  let tenureById = new Map();
  let depById = new Map();
  try {
    const rtoIds = rowsResult.recordset.map(r => r.ID || r.PrarambhMainId).filter(Boolean);
    if (rtoIds.length > 0) {
      const { fetchRtoMap, fetchTenureMap, fetchDepreciationMap } = require('../services/prarambh-tonnage');
      const { getPrarambhPool } = require('../db/prarambh-connection');
      const ppool = await getPrarambhPool();
      trnRtoById = await fetchRtoMap(ppool, rtoIds);
      // Tenure bucket (1+1 / 1+5 / 5+5) from OD/TP term dates — drives which
      // multi-year Comp grid a TW/CAR policy routes to.
      tenureById = await fetchTenureMap(ppool, rtoIds);
      // Nil-Dep (zero-dep) cover flag — Royal's GCV grid files parallel
      // "with Nil Dep" (Comp_NilDep) and "without Nil Dep" (Comp_NoNilDep)
      // rates; Depreciation (1=Nil-Dep, 2=No) picks the right one.
      depById = await fetchDepreciationMap(ppool, rtoIds);
    }
  } catch (e) {
    console.warn('[bulk] TRN RTO/tenure/depreciation pre-fetch failed:', e.message);
  }

  let _ncbFromPr = 0, _ncbFromTrn = 0, _ncbFromTrnd = 0, _regFromPr = 0, _rtoFromPr = 0, _rtoFromTrn = 0;
  let _fuelFromPr = 0, _fuelFromTrn = 0;
  let _ccFromPr = 0, _ccFromTrn = 0;
  let _prodFromPr = 0, _prodFromTrn = 0, _prodFromPrem = 0;
  let _tenureResolved = 0;
  const usableFuel = (v) => {
    const s = String(v || '').trim();
    return s && !/^(all|na|n\/a|other|others)$/i.test(s) ? s : '';
  };
  // A usable CC is a positive engine cubic-capacity number.
  // A CC below 50 is not a real engine size (smallest motor-vehicle engines are
  // ~50cc mopeds) — treat sub-50 values as garbage so the PR fallback fires.
  // Many tmp rows carry a placeholder CC (e.g. 1, 5, 40) that silently blocked
  // the PR lookup; the operator's real engine CC lives in the PR file
  // (ICICI: MOTOR_ENGINE_CC) and is ingested into pr_rows.cc.
  const usableCc = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 50 ? n : null;
  };
  for (const r of rowsResult.recordset) {
    // Nil-Dep (zero-dep) cover flag from Prarambh_Live (1=Yes / 2=No). Stamped
    // onto the row so extractPolicyParams/processOnePolicy can route Royal's
    // Comp_NilDep vs Comp_NoNilDep GCV bands.
    {
      const mainId = r.ID || r.PrarambhMainId;
      const dep = mainId != null ? depById.get(String(mainId)) : undefined;
      if (dep != null) r._depreciation = dep;
    }
    // Locate the PR row once (by policy_no, then by existing registration).
    // A VEHICLE-matched PR row may be a DIFFERENT policy year for the same
    // vehicle (Sompo: prior-year row with NCB=20 attached to a real-NCB-0
    // renewal → with-NCB 37 instead of the operator's Non-NCB 32). Such rows
    // stay usable for VEHICLE attributes but must not supply POLICY-YEAR
    // attributes (NCB, product) — see prViaVehicle gates below.
    let pr = null, prViaVehicle = false;
    if (prIndex) {
      const pk = String(r.PolicyNo || r['POLICY NO'] || '').trim().toUpperCase();
      pr = pk ? prIndex.get(pk) : null;
      if (!pr && prIndex._byVehicle && r.VEHICLE_REGISTRATION_NO) {
        const vk = prIndex._normVeh(r.VEHICLE_REGISTRATION_NO);
        if (vk && vk.length >= 6) { pr = prIndex._byVehicle.get(vk) || null; prViaVehicle = !!pr; }
      }
    }

    // (A) Registration number — fill from PR when the source row is blank.
    const haveReg = String(r.VEHICLE_REGISTRATION_NO || '').trim() !== '';
    if (!haveReg && pr && pr.vehicle_no) {
      r.VEHICLE_REGISTRATION_NO = pr.vehicle_no;
      r['VEHICLE REGISTRATION NO'] = pr.vehicle_no;
      _regFromPr++;
    }

    // (B) RTO code — ALWAYS prefer the explicit RTO_Code COLUMN (it is the
    // authoritative RTO), normalised to its base ("DL-1C" → "DL1"). Source
    // priority: tmp.RTO_Code → TRN.RTO_Code. The registration-number prefix is
    // a LAST resort only (used when no column carries a usable code), because
    // a registration can carry a branch/series that differs from the RTO.
    {
      const tmpNorm = normRtoCode(r.RTO_Code);
      let resolvedRto = tmpNorm;
      let src = tmpNorm ? 'tmp' : '';
      // (1) TRN_PrarambhMotorDetails explicit RTO_Code column.
      if (!resolvedRto) {
        const mainId = r.ID || r.PrarambhMainId;
        const trn = mainId ? trnRtoById.get(String(mainId)) : null;
        if (trn) {
          resolvedRto = normRtoCode(trn.rto);
          if (resolvedRto) src = 'TRN';
        }
      }
      // (2) LAST resort — derive from a registration number (PR's, then tmp's,
      // then TRN's). Only when no explicit RTO_Code column had a usable value.
      if (!resolvedRto) {
        resolvedRto = rtoFromReg(pr && pr.vehicle_no) || rtoFromReg(r.VEHICLE_REGISTRATION_NO);
        if (resolvedRto) src = (pr && pr.vehicle_no) ? 'PR' : 'tmp';
        if (!resolvedRto) {
          const mainId = r.ID || r.PrarambhMainId;
          const trn = mainId ? trnRtoById.get(String(mainId)) : null;
          if (trn) { resolvedRto = rtoFromReg(trn.reg); if (resolvedRto) src = 'TRN'; }
        }
      }
      // Apply only when it changes/sets the value (and is a real code). Never
      // overwrite a good column value with a worse derivation.
      if (resolvedRto && resolvedRto !== String(r.RTO_Code || '').trim().toUpperCase()) {
        r.RTO_Code = resolvedRto;
        r['Code'] = resolvedRto;
        r['RTO CODE'] = resolvedRto;
        if (src === 'PR') _rtoFromPr++;
        else if (src === 'TRN') _rtoFromTrn++;
      }
    }

    // (B2) Fuel type — when tmp_PrarambhData lacks a usable fuel, fill from
    // PR, then from TRN_PrarambhMotorDetails. Same chain as RTO
    // (tmp → PR → MotorDetails). "All"/"NA"/"Others" count as not-usable.
    if (!usableFuel(r.FUELTYPE) && !usableFuel(r.VEHICAL_FUELTYPE)) {
      let fuel = '';
      let fsrc = '';
      if (pr && usableFuel(pr.fuel_type)) { fuel = usableFuel(pr.fuel_type); fsrc = 'PR'; }
      if (!fuel) {
        const mainId = r.ID || r.PrarambhMainId;
        const trn = mainId ? trnRtoById.get(String(mainId)) : null;
        if (trn && usableFuel(trn.fuel)) { fuel = usableFuel(trn.fuel); fsrc = 'TRN'; }
      }
      if (fuel) {
        r.FUELTYPE = fuel;
        r['FUEL TYPE'] = fuel;
        r['FuelType'] = fuel;
        r.VEHICAL_FUELTYPE = fuel;
        if (fsrc === 'PR') _fuelFromPr++;
        else if (fsrc === 'TRN') _fuelFromTrn++;
      }
    }

    // (B3) CC (engine cubic capacity) — when tmp lacks a usable CC, fill from
    // PR, then from TRN_PrarambhMotorDetails. Same chain as fuel/RTO. CC drives
    // CAR/TW segment bands (Petrol<1000 vs >1000, MC<=180, etc.).
    if (!usableCc(r.CC)) {
      let cc = null;
      let csrc = '';
      if (pr && usableCc(pr.cc) != null) { cc = usableCc(pr.cc); csrc = 'PR'; }
      if (cc == null) {
        const mainId = r.ID || r.PrarambhMainId;
        const trn = mainId ? trnRtoById.get(String(mainId)) : null;
        if (trn && usableCc(trn.cc) != null) { cc = usableCc(trn.cc); csrc = 'TRN'; }
      }
      if (cc != null) {
        r.CC = cc;
        r['CC'] = cc;
        if (csrc === 'PR') _ccFromPr++;
        else if (csrc === 'TRN') _ccFromTrn++;
      }
    }

    // (B4) Product type — tmp_PrarambhData's ProductTypeName is often the
    // generic "Motor" (or blank), which doesn't tell Comprehensive vs TP vs
    // SAOD and so can't route to the right rate sheet. Resolve a concrete
    // product from PR.product first, then from TRN_PrarambhMotorDetails'
    // PRODUCT_TYPE_Id (1 → Comprehensive, 2 → TP/Liability, 3 → SAOD).
    {
      const cur = String(r.ProductTypeName || r['PRODUCT TYPE'] || '').trim();
      const ambiguous = !cur || /^(motor|all|na|n\/a|other|others)$/i.test(cur);
      if (ambiguous) {
        let resolved = '';
        let psrc = '';
        // (1) PR.product — already a descriptive string ("Comprehensive",
        // "Own Damage", "Liability", "SAOD", "Package", …). Normalise it.
        // (Vehicle-matched PR = possibly another policy year — skip product too.)
        if (pr && !prViaVehicle && pr.product) {
          const p = String(pr.product).trim().toUpperCase();
          if (/SAOD|STANDALONE|STAND ALONE|OWN\s*DAMAGE|\bOD\b/.test(p)) { resolved = 'SAOD'; psrc = 'PR'; }
          else if (/\b(TP|THIRD\s*PARTY|LIABILITY|SATP|ACT)\b/.test(p)) { resolved = 'Liability'; psrc = 'PR'; }
          else if (/COMP|PACKAGE|COMPREHENSIVE|BUNDLED|\b1\s*\+\s*\d/.test(p)) { resolved = 'Comprehensive'; psrc = 'PR'; }
        }
        // (2) TRN PRODUCT_TYPE_Id — numeric code (1=Comp, 2=TP, 3=SAOD).
        if (!resolved) {
          const mainId = r.ID || r.PrarambhMainId;
          const trn = mainId ? trnRtoById.get(String(mainId)) : null;
          const pid = trn ? parseInt(trn.productTypeId, 10) : NaN;
          if (pid === 1) { resolved = 'Comprehensive'; psrc = 'TRN'; }
          else if (pid === 2) { resolved = 'Liability'; psrc = 'TRN'; }
          else if (pid === 3) { resolved = 'SAOD'; psrc = 'TRN'; }
        }
        // (3) Premium composition — the most reliable fallback when neither
        // PR nor TRN carries an explicit product code (Digit's "Motor " rows
        // have both NULL). OD-only → SAOD, TP-only → Liability, both → Comp.
        if (!resolved) {
          const od = (parseFloat(r.NET_OD_PREMIUM) || 0) || (parseFloat(r.BASE_OD_PREMIUM) || 0);
          const tp = parseFloat(r.NET_LIABILITY_PREMIUM) || 0;
          if (od > 0 && tp > 0)      { resolved = 'Comprehensive'; psrc = 'PREM'; }
          else if (od > 0 && tp <= 0){ resolved = 'SAOD';          psrc = 'PREM'; }
          else if (tp > 0 && od <= 0){ resolved = 'Liability';     psrc = 'PREM'; }
        }
        if (resolved) {
          r.ProductTypeName = resolved;
          r['PRODUCT TYPE'] = resolved;
          r['PolicyType'] = resolved;
          if (psrc === 'PR') _prodFromPr++;
          else if (psrc === 'TRN') _prodFromTrn++;
          else _prodFromPrem++;
        }
      }
      // Premium-composition sanity override: a policy with NO OD premium and a
      // real TP premium CANNOT be SAOD (SAOD = OD-only) or Comprehensive — the
      // TRN/source product code is wrong (e.g. TATA UP1/15044: TRN said SAOD for
      // a TP-only bike → matched the HOM|SAOD 20% instead of HOM|SATP 36% =
      // operator). Force Liability so it routes to the SATP/TP rates. One-way
      // override only (the reverse — Comp with tp=0 — is a legitimate bundled
      // long-term-TP renewal shape, left untouched).
      {
        const odc = (parseFloat(r.NET_OD_PREMIUM) || 0) || (parseFloat(r.BASE_OD_PREMIUM) || 0);
        const tpc = parseFloat(r.NET_LIABILITY_PREMIUM) || 0;
        const curP = String(r.ProductTypeName || r['PRODUCT TYPE'] || '').toUpperCase();
        if (odc <= 0 && tpc > 0 && /SAOD|STANDALONE|OWN\s*DAMAGE|COMP|PACKAGE/.test(curP) && !/TP|THIRD|LIABILITY|SATP/.test(curP)) {
          r.ProductTypeName = 'Liability';
          r['PRODUCT TYPE'] = 'Liability';
          r['PolicyType'] = 'Liability';
        }
      }
    }

    // (B5) Tenure bucket — derived from OD/TP policy-term dates
    // (TRN_PrarambhMotorMISUpdation). Routes multi-year Comp policies to the
    // correct grid (1+1 vs 1+5 vs 5+5). Stashed as a private column the
    // policy-param extractor reads.
    {
      const mainId = r.ID || r.PrarambhMainId;
      const b = mainId ? tenureById.get(String(mainId)) : null;
      if (b) { r._tenureBucket = b; _tenureResolved++; }
    }

    // (C) NCB — fill from PR, then TRN, when tmp lacks a positive value.
    const tmpNcb = parseFloat(r.NCB);
    if (!(Number.isFinite(tmpNcb) && tmpNcb > 0)) {
      let resolved = null, source = null;
      if (pr && !prViaVehicle && pr.ncb != null) {   // vehicle-matched PR = possibly another policy year — no NCB
        const n = parseFloat(pr.ncb);
        if (Number.isFinite(n) && n > 0) { resolved = n; source = 'PR'; }
      }
      if (resolved == null && r._trnNcb != null) {
        const n = parseFloat(r._trnNcb);
        if (Number.isFinite(n) && n > 0) { resolved = n; source = 'TRN'; }
      }
      // TRN_PrarambhMotorDetails NCB slab — resolved to a percent (via
      // MST_FieldMasters 9310) in fetchRtoMap. Authoritative for renewals where
      // PR / Beeinsured lack the value. A resolved 0 means "explicitly no NCB"
      // (new policy) which the matcher already treats as the default, so only a
      // positive value is promoted here.
      if (resolved == null) {
        const mainId = r.ID || r.PrarambhMainId;
        const trnRow = mainId ? trnRtoById.get(String(mainId)) : null;
        const n = trnRow && trnRow.ncb != null ? parseFloat(trnRow.ncb) : NaN;
        if (Number.isFinite(n) && n > 0) { resolved = n; source = 'TRND'; }
      }
      if (resolved != null) {
        r.NCB = resolved; r['NCB'] = resolved; r['PREVIOUS NCB'] = resolved;
        r._ncb_source = source;
        if (source === 'PR') _ncbFromPr++;
        else if (source === 'TRND') _ncbFromTrnd++;
        else _ncbFromTrn++;
      }
    }
  }
  if (_ncbFromPr || _ncbFromTrn || _ncbFromTrnd || _regFromPr || _rtoFromPr || _rtoFromTrn || _fuelFromPr || _fuelFromTrn || _ccFromPr || _ccFromTrn || _prodFromPr || _prodFromTrn || _prodFromPrem || _tenureResolved) {
    console.log(`[bulk] PR enrichment — NCB: ${_ncbFromPr} PR/${_ncbFromTrn} TRN/${_ncbFromTrnd} TRND · Reg: ${_regFromPr} · RTO: ${_rtoFromPr} PR/${_rtoFromTrn} TRN · Fuel: ${_fuelFromPr} PR/${_fuelFromTrn} TRN · CC: ${_ccFromPr} PR/${_ccFromTrn} TRN · Product: ${_prodFromPr} PR/${_prodFromTrn} TRN/${_prodFromPrem} PREM · Tenure: ${_tenureResolved}`);
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
  const caches = { rto: new Map(), lookup: new Map(), tonnageById: new Map(), enablers: enablerOverrides, fleets: fleetOverrides };

  const allRows = rowsResult.recordset;

  // Tonnage fallback batch — collect all PrarambhMainIds (view's ID column)
  // and fetch Tonnes from TRN_PrarambhMotorDetails in one go. Lets the
  // per-row processor patch params.tonnage when VehicalCategory text didn't
  // carry the band.
  try {
    const { fetchTonnageMap } = require('../services/prarambh-tonnage');
    const ids = allRows.map(r => r.ID || r.PrarambhMainId).filter(Boolean);
    if (ids.length > 0) {
      const { getPrarambhPool } = require('../db/prarambh-connection');
      const ppool = await getPrarambhPool();
      caches.tonnageById = await fetchTonnageMap(ppool, ids);
      console.log(`[bulk] tonnage fallback: ${caches.tonnageById.size}/${ids.length} mainIds resolved`);
    }
  } catch (e) {
    console.warn('[bulk] tonnage fallback pre-fetch failed:', e.message);
  }

  // Concurrency: process N policies at a time. Higher values reduce wall-
  // clock at the cost of more concurrent DB requests on the shared pool.
  // mssql defaults max=10 on the pool — set CONCURRENCY at or below the
  // pool's max to avoid request queueing inside the driver. Override via
  // BULK_CONCURRENCY env var if needed.
  const CONCURRENCY = Math.max(1, parseInt(process.env.BULK_CONCURRENCY || '25', 10) || 25);
  console.log(`[bulk] processing ${allRows.length} policies @ concurrency=${CONCURRENCY}`);
  // Transient-error retry shield — ECONNRESET / connection-lost / deadlock
  // happen sporadically under load. One retry with a tiny backoff recovers
  // the vast majority without restarting the whole recompute.
  const isTransient = (e) => {
    const m = String((e && e.message) || e || '').toLowerCase();
    return m.includes('econnreset') || m.includes('connection lost') ||
           m.includes('connection is closed') || m.includes('deadlock') ||
           m.includes('timeout') || m.includes('socket hang up');
  };
  const runWithRetry = async (policy) => {
    try {
      return await processOnePolicy(pool, policy, marginRules, caches, statementIndex, prIndex, specialRulesByAgent, globalUpliftByAgent);
    } catch (e) {
      if (!isTransient(e)) throw e;
      await new Promise(r => setTimeout(r, 250 + Math.random() * 250));
      return await processOnePolicy(pool, policy, marginRules, caches, statementIndex, prIndex, specialRulesByAgent, globalUpliftByAgent);
    }
  };
  for (let i = 0; i < allRows.length; i += CONCURRENCY) {
    const chunk = allRows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(policy => runWithRetry(policy).catch(err => {
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
  // Volume-based uplift — post-pass over all rows (needs per-agent totals).
  // Mutates rows + totals.outgoing/savings; strips the _vu context.
  const volumeUplifts = await applyVolumeUplift(out, specialRulesByAgent, totals);
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
        return { totals: totals2, rows: keep, processed: keep.length, total_count: totalCount, limit: cap, offset: skip, permanently_excluded: dropped, volume_uplifts: volumeUplifts };
      }
    }
  } catch (e) { console.error('[bulk] permanent-exclude filter skipped:', e.message); }

  return {
    totals, rows: out, processed: out.length,
    total_count: totalCount, limit: cap, offset: skip,
    volume_uplifts: volumeUplifts,
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

/** GET /debug-source-count — count policies in tmp_PrarambhData by insurer for a date range.
 *  Used to diagnose "why is policy X missing from cycle Y?" — compare against
 *  the configured rate_cards.insurer list to find dropped insurers.
 */
router.get('/debug-source-count', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ success: false, error: 'from / to dates required (YYYY-MM-DD)' });
    const prarambhPool = await getPrarambhUatPool();
    const r = await prarambhPool.request()
      .input('dfrom', sql.DateTime, new Date(from))
      .input('dto',   sql.DateTime, new Date(to))
      .query(`SELECT INSURERNAME AS insurer, COUNT(*) AS cnt
              FROM tmp_PrarambhData
              WHERE SubmissionDate >= @dfrom AND SubmissionDate <= @dto
              GROUP BY INSURERNAME
              ORDER BY cnt DESC`);
    const pool = await getPool();
    const cardsRes = await pool.request().query(
      `SELECT DISTINCT insurer FROM rate_cards
       WHERE insurer IS NOT NULL
         AND (effective_to IS NULL OR effective_to > GETDATE())`
    );
    const configuredSlugs = new Set(cardsRes.recordset.map(c => String(c.insurer).toLowerCase()));
    const slugify = (s) => String(s || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const breakdown = r.recordset.map(row => {
      const slug = slugify(row.insurer);
      // Bidirectional prefix match — mirrors runBulkCalculate's filter so
      // the diagnostic agrees with what the cycle actually keeps. Also
      // strips trailing brand suffixes ("_videocon" / "_general" / etc.)
      // so a renamed insurer (Liberty Videocon → Liberty) still matches.
      const core = (s) => s.replace(/_(general|insurance|videocon|hdi|allianz|tokio|sundaram|sompo|lombard|ergo|aig)$/i, '');
      const matched = [...configuredSlugs].some(s =>
        slug.startsWith(s) || s.startsWith(slug) || slug.startsWith(core(s))
      );
      return { insurer: row.insurer, slug, cnt: row.cnt, has_rate_card: matched };
    });
    const dropped = breakdown.filter(b => !b.has_rate_card);
    res.json({
      success: true,
      from, to,
      total_rows: breakdown.reduce((s, b) => s + b.cnt, 0),
      dropped_rows: dropped.reduce((s, b) => s + b.cnt, 0),
      dropped_insurers: dropped,
      all_insurers: breakdown,
    });
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
    const { lookupRates, resolveRTO, rtoProductFor } = require('../services/rate-lookup');
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
    const { lookupRates, resolveRTO, rtoProductFor } = require('../services/rate-lookup');
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

/** GET /debug-sheets/:insurer — distinct sheet_name + row counts + sample rates. */
router.get('/debug-sheets/:insurer', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('ins', sql.NVarChar(100), req.params.insurer)
      .query(`SELECT sheet_name, COUNT(*) AS n,
                     MIN(rate_value) AS min_rate, MAX(rate_value) AS max_rate
              FROM rate_rules WHERE insurer = @ins
              GROUP BY sheet_name ORDER BY n DESC`);
    res.json({ success: true, sheets: r.recordset });
  } catch (err) { next(err); }
});

/** POST /fix-us-overlay-age — one-off: widen US ">5yr without addon"
 *  overlay from age_min=6 to age_min=5 on existing DB rows (so a 5-yr-old
 *  vehicle is included), without needing a rate-card re-upload. Idempotent. */
router.post('/fix-us-overlay-age', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `UPDATE rate_rules
       SET vehicle_age_min = 5
       WHERE insurer = 'universal_sompo'
         AND segment = 'Pvt Car'
         AND vehicle_age_min = 6
         AND (remarks LIKE '%without addon%' OR addon = 'N')`
    );
    res.json({ success: true, rows_updated: r.rowsAffected[0] });
  } catch (err) { next(err); }
});

/** GET /debug-rules — dump rules for a given lookup. */
router.get('/debug-rules', async (req, res, next) => {
  try {
    const { insurer, region, product, ins_product, fuel, segment, rate_type, sheet_not } = req.query;
    const pool = await getPool();
    const r = await pool.request()
      .input('ins',  sql.NVarChar(100), insurer || '')
      .input('reg',  sql.NVarChar(200), region  || '')
      .input('prod', sql.NVarChar(50),  product || '')
      .input('fuel', sql.NVarChar(50),  fuel    || '')
      .input('seg',  sql.NVarChar(300), segment || '')
      .input('rt',   sql.NVarChar(100), rate_type || '')
      .input('shnot',sql.NVarChar(200), sheet_not || '')
      .query(`SELECT TOP 100 id, rate_type, segment, region, make, model, sheet_name,
                     fuel_type, vehicle_age_min, vehicle_age_max, seating_capacity_min,
                     seating_capacity_max, weight_band_min, weight_band_max,
                     cc_band_min, cc_band_max, sub_type, addon, carrier_type,
                     rate_value, remarks
              FROM rate_rules
              WHERE insurer = @ins
                AND (CHARINDEX('/' + @reg + '/', '/' + region + '/') > 0 OR region = @reg)
                AND product LIKE @prod + '%'
                AND (@fuel = '' OR fuel_type = @fuel)
                AND (@seg = ''  OR segment   = @seg)
                AND (@rt = ''   OR rate_type = @rt)
                AND (@shnot = '' OR sheet_name NOT LIKE '%' + @shnot + '%')`);
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
// Reusable margin/outgoing primitives for the Agent Rate Search route, so the
// agent-facing outgoing rate matches exactly what the bulk pipeline computes.
module.exports.loadMarginRules = loadMarginRules;
module.exports.loadSpecialRulesByAgent = loadSpecialRulesByAgent;
module.exports.loadGlobalUpliftsByAgent = loadGlobalUpliftsByAgent;
module.exports.matchMarginForPolicy = matchMarginForPolicy;
module.exports.policyMatchesMargin = policyMatchesMargin;
module.exports._pickUplift = _pickUplift;
