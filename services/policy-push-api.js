/**
 * services/policy-push-api.js — external mobile-app push client.
 *
 * Two calls (URLs/creds from env, provided when the contract arrives):
 *   1) getToken()  — POST the token endpoint, cache {value, expiresAt} with TTL,
 *      refresh 30s before expiry.
 *   2) pushData()  — POST one policy payload with the Bearer token; on 401 refresh
 *      the token ONCE and retry; throw on any non-OK (the worker owns retry).
 *
 * buildPayload(policyRow) maps a Prarambh view row → the API's JSON shape. It's a
 * PLACEHOLDER until the API contract is provided — mirror the /lookup view columns.
 *
 * DRY-RUN: with POLICY_PUSH_DRYRUN=1 (or when the URLs aren't configured), pushData
 * logs and returns {dryRun:true} instead of calling out — lets the worker/backfill
 * be exercised end-to-end before real creds exist. Set POLICY_PUSH_DRYRUN_FAIL to a
 * substring to force failures on matching trackers (for testing the failure path).
 *
 * Config (env): POLICY_PUSH_TOKEN_URL, POLICY_PUSH_DATA_URL, POLICY_PUSH_CLIENT_ID,
 *               POLICY_PUSH_CLIENT_SECRET, POLICY_PUSH_TOKEN_TTL_MS (fallback TTL),
 *               POLICY_PUSH_DRYRUN, POLICY_PUSH_DRYRUN_FAIL.
 */
const TOKEN_URL = (process.env.POLICY_PUSH_TOKEN_URL || 'https://online.oneinsure.com/apis/auth/coverfox/token/').trim();
const DATA_URL = (process.env.POLICY_PUSH_DATA_URL || 'https://online.oneinsure.com/policy-details/motor').trim();
const COOKIE = (process.env.POLICY_PUSH_COOKIE || '').trim();   // optional session cookie, if the API needs it
const CLIENT_ID = process.env.POLICY_PUSH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.POLICY_PUSH_CLIENT_SECRET || '';
const GRANT_TYPE = process.env.POLICY_PUSH_GRANT_TYPE || 'client_credentials';
const TOKEN_TTL_MS = parseInt(process.env.POLICY_PUSH_TOKEN_TTL_MS || '3300000', 10); // 55 min
// Dry-run is the DEFAULT (safe) now that DATA_URL has a real default — going live
// requires an explicit POLICY_PUSH_DRYRUN=0. Also forced on if no data URL.
const DRYRUN = String(process.env.POLICY_PUSH_DRYRUN || '1') !== '0' || !DATA_URL;
const DRYRUN_FAIL = (process.env.POLICY_PUSH_DRYRUN_FAIL || '').trim();

let _token = { value: null, expiresAt: 0 };

/** Fetch (and cache) the API token. Pass {force:true} to bypass the cache. */
async function getToken({ force = false } = {}) {
  if (DRYRUN) return 'dryrun-token';
  const now = Date.now();
  if (!force && _token.value && now < _token.expiresAt - 30000) return _token.value;
  if (!TOKEN_URL) throw new Error('POLICY_PUSH_TOKEN_URL not configured');
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('POLICY_PUSH_CLIENT_ID/SECRET not configured');
  // OAuth2 client_credentials — the OneInsure token endpoint expects
  // application/x-www-form-urlencoded (client_id, client_secret, grant_type).
  const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: GRANT_TYPE });
  // The token gates every push, so absorb a transient network blip with a short
  // retry (observed occasional "fetch failed" to this host). 3 quick attempts.
  let res, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!res) throw new Error('token fetch failed: ' + ((lastErr && (lastErr.cause?.code || lastErr.message)) || 'network'));
  const text = await res.text();
  if (!res.ok) throw new Error(`token ${res.status}: ${text.slice(0, 300)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('token response not JSON: ' + text.slice(0, 200)); }
  const value = j.access_token || j.token || j.Token || j.data?.token;
  if (!value) throw new Error('token missing in response: ' + text.slice(0, 200));
  const ttl = j.expires_in ? (Number(j.expires_in) * 1000) : TOKEN_TTL_MS;
  _token = { value, expiresAt: Date.now() + ttl };
  return value;
}

/**
 * Push one policy payload as multipart/form-data (the OneInsure
 * /policy-details/motor endpoint expects form fields, not JSON). Returns the API
 * response (or {dryRun:true}). Throws on failure.
 */
async function pushData(payload, token) {
  if (DRYRUN) {
    const key = String(payload && (payload.policy_number || payload.registration_number) || '');
    if (DRYRUN_FAIL && key.includes(DRYRUN_FAIL)) throw new Error(`dry-run forced failure for ${key}`);
    return { dryRun: true };
  }
  const doPost = (tok) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(payload)) fd.append(k, v == null ? '' : String(v));
    const headers = { Authorization: 'Bearer ' + tok, 'User-Agent': 'Policy Insertion', Accept: 'application/json' };
    if (COOKIE) headers.Cookie = COOKIE;
    // NB: do NOT set Content-Type — fetch sets the multipart boundary from FormData.
    return fetch(DATA_URL, { method: 'POST', headers, body: fd });
  };
  let tok = token || await getToken();
  let res = await doPost(tok);
  if (res.status === 401) {                 // token expired mid-flight — refresh once
    tok = await getToken({ force: true });
    res = await doPost(tok);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`push ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return { ok: true, raw: text.slice(0, 200) }; }
}

/**
 * Map a vw_NewTempPrarambhExcelMotorDownload row → the OneInsure
 * /policy-details/motor multipart fields. Field names match the API's form keys.
 *
 * Dates are passed through as the view formats them (e.g. "14-Apr-26"); if the API
 * wants ISO, we normalise here once the format is confirmed.
 *
 * Fields we DON'T hold in the motor view are sent blank (documented inline):
 *   tp_insurer, nominee_age (view has DOB OF NOMINEE, not age), is_used,
 *   is_corporate_bus, pa_amount, has_ncb_certificate, all add-on flags
 *   (is_key_replacement … is_consumables_cover), is_depreciation_waiver, role,
 *   vehicle_id, document_content (no PDF bytes), policy_document (filename only).
 */
function buildPayload(row) {
  const g = (k) => {
    if (row[k] != null) return row[k];
    const lk = String(k).toLowerCase();
    for (const kk of Object.keys(row)) if (kk.toLowerCase() === lk) return row[kk];
    return '';
  };
  const num = (k) => { const v = g(k); return v === '' || v == null ? '' : String(v); };
  // Dates → DD-MM-YYYY (API format). Handles view strings "14-Apr-26" /
  // "14-Apr-2026", ISO, already-DMY, and JS Date objects; drops placeholders.
  const MO = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const fmt = (dd, mm, yyyy) => `${String(dd).padStart(2, '0')}-${String(mm).padStart(2, '0')}-${yyyy}`;
  const d = (k) => {
    let v = g(k);
    if (v == null || v === '') return '';
    if (v instanceof Date) { if (isNaN(v) || v.getFullYear() <= 1901) return ''; return fmt(v.getDate(), v.getMonth() + 1, v.getFullYear()); }
    const s = String(v).trim(); if (!s) return '';
    let m = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3,})[-\/ ](\d{2,4})$/);           // 14-Apr-26 / 14-Apr-2026
    if (m) { const mo = MO[m[2].slice(0, 3).toLowerCase()]; if (!mo) return ''; let y = m[3]; if (y.length === 2) y = '20' + y; return Number(y) <= 1901 ? '' : fmt(m[1], mo, y); }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return Number(m[1]) <= 1901 ? '' : fmt(m[3], m[2], m[1]);   // ISO
    m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); if (m) return Number(m[3]) <= 1901 ? '' : fmt(m[1], m[2], m[3]);  // already DMY
    const dt = new Date(s); if (!isNaN(dt) && dt.getFullYear() > 1901) return fmt(dt.getDate(), dt.getMonth() + 1, dt.getFullYear());
    return '';
  };
  const bool01 = (v) => /^(1|y|yes|true|t)$/i.test(String(v == null ? '' : v).trim()) ? '1' : '0';
  const b = (k) => bool01(g(k));
  // coverage_type: prefer the product-type text (the view's TP premium is often 0
  // even on Comp rows), fall back to the premium split.
  const od = parseFloat(g('BASE OD PREMIUM')) || 0;
  const tp = parseFloat(g('LIABILITY PREMIUM')) || 0;
  const ptype = String(g('PRODUCT TYPE') || g('POLICY TYPE')).toUpperCase();
  let coverage;
  if (/COMPREHENSIVE|PACKAGE/.test(ptype)) coverage = 'comprehensive';
  else if (/SAOD|OWN\s*DAMAGE|STAND.*OD/.test(ptype)) coverage = 'own_damage';
  else if (/THIRD|LIABILITY|\bTP\b|SATP|\bACT\b/.test(ptype)) coverage = 'third_party';
  else coverage = (od > 0 && tp > 0) ? 'comprehensive' : (od > 0 ? 'own_damage' : 'third_party');
  const addr = [g('MAILING ADDRESS LINE_1'), g('MAILING ADDRESS LINE_2')].filter(Boolean).join(', ');
  const financed = (String(g('HYPOTHECATION')).trim() || g('BANK NAME')) ? '1' : '0';
  // business_type → motor_* (confirmed value "motor_renew"; motor_new/rollover/used inferred).
  const bt = String(g('POLICY TYPE') || g('REPORTED BUSINESS TYPE')).toUpperCase();
  const business_type = /ROLL/.test(bt) ? 'motor_rollover'
                      : /RENEW/.test(bt) ? 'motor_renew'
                      : /USED|SECOND|OLD/.test(bt) ? 'motor_used'
                      : 'motor_new';
  // is_used: a vehicle with age > 0 (or a renewal/rollover) is second-hand.
  const usedVeh = (parseFloat(g('AGE OF VEHICLE')) || 0) > 0 || business_type !== 'motor_new' ? '1' : '0';

  return {
    insurer: g('INSURER NAME'),
    mobile: g('PRIMARY MOBILE NO'),
    email: g('EMAIL'),
    name: g('FULL NAME') || g('REPORTED CUSTOMER NAME'),
    marital_status: g('MARITAL STATUS'),
    gender: g('GENDER'),
    birth_date: d('DOB'),
    sales_channel: 'pos',
    business_type: business_type,
    product_type: g('PRODUCT TYPE'),
    renewed_from_insurer: g('OTHER POLICY INSURER NAME'),
    previous_policy_number: g('OTHER POLICY NO'),
    previous_policy_expiry_date: d('POLICY EXPIRY DATE'),
    tp_insurer: '',
    policy_expiry_date: d('POLICY END DATE'),
    previous_ncb: num('PREVIOUS NCB'),
    nominee_age: '',
    nominee_name: g('NOMINEE NAME'),
    nominee_relationship: g('NOMINEE RELATION WITH POLICY HOLDER'),
    chassis_number: g('CHASIS NO'),
    engine_number: g('ENGINE NO'),
    financier: g('BANK NAME'),
    fuel_type: g('FUEL TYPE'),
    is_anti_theft_fitted: b('ANTI THEFT'),
    is_financed: financed,
    is_used: usedVeh,
    make: g('VEHICAL MAKE'),
    manufacturing_date: d('DATE OF MFG'),
    model: g('VEHICAL MODEL'),
    registration_date: d('DATE OF REGISTRATION'),
    registration_number: g('VEHICLE REGISTRATION NO'),
    rto: g('Code'),
    seating_capacity: num('SEATING CAPACITY'),
    variant: g('VEHICAL SUBMODAL'),
    address: addr,
    city: g('MAILING ADDRESS CITY') || g('CityName'),
    pincode: g('MAILING ADDRESS PINCODE'),
    role: '',
    state: g('MAILING ADDRESS STATE') || g('StateName'),
    coverage_type: coverage,
    tp_policy_insurer: '',
    issue_date: d('POLICY ISSUED DATE'),
    policy_start_date: d('POLICY START DATE'),
    policy_end_date: d('POLICY END DATE'),
    tp_policy_end_date: d('TP_POLICY_END_DATE'),
    is_corporate_bus: '0',
    vehicle_category: g('VehicalCategory'),
    policy_number: g('POLICY NO'),
    tp_policy_number: g('TP_POLICY_NO'),
    tp_premium: num('LIABILITY PREMIUM'),
    od_premium: num('BASE OD PREMIUM'),
    pa_amount: '',
    service_tax: num('GST AMOUNT'),
    premium: num('MOTOR ANNUAL PREMIUM') || num('PREMIUM WITHOUT GST'),
    ncb: num('NCB'),
    has_ncb_certificate: '0',
    insurer_declared_idv: num('VEHICLE IDV') || num('TOTAL IDV'),
    electrical_value: num('ELECTRICAL ACCESSORIES'),
    non_electrical_value: num('NON ELECTRICAL ACCESSORIES'),
    cng_kit_value: num('CNG LPG KIT'),
    is_depreciation_waiver: '0',
    is_key_replacement: '0',
    is_road_side_assistance: '0',
    is_invoice_cover: '0',
    is_engine_protector: '0',
    is_ncb_protection: '0',
    is_legal_liability_driver: '0',
    is_consumables_cover: '0',
    voluntary_deductible: num('VOLUNTARY DISCOUNT AMOUNT'),
    policy_document: 'policy_document.pdf',
    vehicle_id: '',
    pos_code: g('Agent Code') || g('PortalUserId'),
    document_content: '',
  };
}

module.exports = { getToken, pushData, buildPayload, DRYRUN };
