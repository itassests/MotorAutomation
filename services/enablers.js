'use strict';

/**
 * Enabler / special-payout overrides.
 *
 * Insurers periodically send "enabler" emails registering a special payout deal
 * for a date window, scoped to a segment (e.g. GCV 3W electric) + make (TRIUMPH)
 * + transaction (NEW 1+5) + a per-RTO-location COA% (the revised payout). Per
 * product owner: match by CRITERIA ONLY (no IMD/agent link), and the COA% becomes
 * the policy's income rate. Only matching policies change; everything else is
 * untouched.
 *
 * Each `enabler_overrides` row is ONE (rto_location, coa_pct) line of a deal.
 * loadEnablerOverrides() returns the active rows; policyMatchesEnabler() tests a
 * policy against one row; pickEnablerOverride() returns the best matching row's
 * COA (the most-specific / highest-COA match) or null.
 */

async function loadEnablerOverrides(pool) {
  try {
    const r = await pool.request().query(
      `SELECT id, deal_id, imd_code, segment, vehicle_type, is_3w, is_electric,
              make, transaction_type, is_new, rto_location, coa_pct, discount_pct,
              window_from, window_to
       FROM enabler_overrides WHERE active = 1`);
    return r.recordset || [];
  } catch (_) {
    return [];   // table absent / unreachable → feature simply inactive
  }
}

// Normalise a "DD-Mon-YY" / Date / ISO value to a YYYY-MM-DD string for range
// comparison (string compare is safe in ISO form).
function toIso(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3})[A-Za-z]*[-\/\s](\d{2,4})$/);
  if (m) {
    const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    let yr = m[3]; if (yr.length === 2) yr = '20' + yr;
    const mo = MON[m[2].toLowerCase()];
    if (mo) return `${yr}-${mo}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Does this policy match an enabler override row?
 * @param params  extractPolicyParams output
 * @param ov      one enabler_overrides row
 * @param ctx     { issueDate, rtoCity, cluster } extra match context
 */
function policyMatchesEnabler(params, ov, ctx = {}) {
  const up = (v) => String(v == null ? '' : v).toUpperCase();
  // Vehicle type (GCV / TW / CAR / PCV …)
  if (ov.vehicle_type && up(params.vehicleType) !== up(ov.vehicle_type)) return false;
  const catModel = up(params.vehicleCategory) + ' ' + up(params.model);
  // 3-wheeler
  if (ov.is_3w && !/\b3\s*W\b|3\s*WHEEL|THREE\s*WHEEL|GCV\s*3/.test(catModel)) return false;
  // Electric
  if (ov.is_electric && !/ELECTRIC|\bEV\b|BATTERY/.test(up(params.fuelType))) return false;
  // Make (substring — policy makes are often glued/suffixed)
  if (ov.make && !up(params.make).includes(up(ov.make)) && !up(params.model).includes(up(ov.make))) return false;
  // New vehicle = age 0 (per product owner: transaction "NEW")
  if (ov.is_new && (Number(params.vehicleAge) || 0) !== 0) return false;
  // RTO location — match the deal's location name against any resolved geo field.
  if (ov.rto_location) {
    const loc = up(ov.rto_location).trim();
    const hay = [params.resolvedRegion, ctx.rtoCity, ctx.cluster, params._stateName,
                 params.bookedLocation, params.rtoCode].map(up).join(' | ');
    if (!hay.includes(loc)) return false;
  }
  // Date window — policy issue date within [from, to] inclusive.
  if (ov.window_from || ov.window_to) {
    const d = toIso(ctx.issueDate);
    const from = toIso(ov.window_from);
    const to   = toIso(ov.window_to);
    if (!d) return false;                       // no issue date → can't honour a windowed deal
    if (from && d < from) return false;
    if (to && d > to) return false;
  }
  return true;
}

/**
 * Best matching enabler override for a policy, or null. When several match,
 * prefer the most specific (an explicit rto_location beats a blank one); break
 * ties by the higher COA.
 */
function pickEnablerOverride(params, overrides, ctx = {}) {
  if (!overrides || !overrides.length) return null;
  const hits = overrides.filter((ov) => policyMatchesEnabler(params, ov, ctx));
  if (!hits.length) return null;
  hits.sort((a, b) =>
    (b.rto_location ? 1 : 0) - (a.rto_location ? 1 : 0) ||
    (Number(b.coa_pct) || 0) - (Number(a.coa_pct) || 0));
  return hits[0];
}

module.exports = { loadEnablerOverrides, policyMatchesEnabler, pickEnablerOverride, toIso };
