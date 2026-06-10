'use strict';

/**
 * Fleet rate overrides.
 *
 * A "fleet" is a per-customer special deal: for a given insurer, every policy whose
 * customer (proposer) name matches gets a FLAT rate, regardless of the base grid.
 * Example: insurer = New India, fleet = "XYZ Logistics deal", customer = "XYZ Ltd",
 * rate = 30%  →  all New India policies for "XYZ Ltd" are rated 30%.
 *
 * Each `fleet_overrides` row is ONE deal. Optional narrowing: vehicle_type (CAR/TW/
 * GCV/PCV/MISC). Matching is by insurer + customer-name substring (case-insensitive),
 * the most specific / highest-rate winning on ties. rate_pct → the policy's income rate.
 */

async function loadFleetOverrides(pool) {
  try {
    const r = await pool.request().query(
      `SELECT id, insurer_slug, fleet_name, customer_name, vehicle_type, rate_pct, note
       FROM fleet_overrides WHERE active = 1`);
    return r.recordset || [];
  } catch (_) {
    return [];   // table absent / unreachable → feature simply inactive
  }
}

const up = (v) => String(v == null ? '' : v).toUpperCase().trim();

/**
 * Does this policy match a fleet override row?
 * @param params       extractPolicyParams output
 * @param ov           one fleet_overrides row
 * @param insurerSlug  the policy's resolved insurer slug (canonical)
 */
function policyMatchesFleet(params, ov, insurerSlug) {
  // Insurer must match (canonical slug compare; tolerate core-name overlap).
  const a = up(insurerSlug), b = up(ov.insurer_slug);
  if (b && a !== b && !a.includes(b) && !b.includes(a)) return false;
  // Customer name — the fleet's customer_name must appear in the policy proposer name.
  const cust = up(ov.customer_name);
  if (!cust) return false;                           // a fleet with no customer is meaningless
  if (!up(params.proposerName).includes(cust)) return false;
  // Optional vehicle-type narrowing.
  if (ov.vehicle_type && up(params.vehicleType) !== up(ov.vehicle_type)) return false;
  return true;
}

/**
 * Best matching fleet override for a policy, or null. Prefer the most specific
 * (longer customer-name match, then a vehicle-type-scoped row), then higher rate.
 */
function pickFleetOverride(params, fleets, insurerSlug) {
  if (!fleets || !fleets.length) return null;
  const hits = fleets.filter((ov) => policyMatchesFleet(params, ov, insurerSlug));
  if (!hits.length) return null;
  hits.sort((a, b) =>
    up(b.customer_name).length - up(a.customer_name).length ||   // longer (more specific) name first
    (b.vehicle_type ? 1 : 0) - (a.vehicle_type ? 1 : 0) ||       // vehicle-scoped beats blank
    (Number(b.rate_pct) || 0) - (Number(a.rate_pct) || 0));
  return hits[0];
}

module.exports = { loadFleetOverrides, policyMatchesFleet, pickFleetOverride };
