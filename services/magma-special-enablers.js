/**
 * Magma HDI — "special enablers" (state/cluster-specific rate overrides that sit
 * on top of the filed grid).
 *
 * Source: Magma circular continuing into Sep'26 (USER 2026-09-24), which was
 * omitted from the 30-Aug-2026 communication:
 *
 *   State         Policy Type     LOB                    UW Clusters   Rate
 *   Chhattisgarh  Comprehensive   GCV 20T-40T Age>=5     CG1, CG3      24%
 *
 *   "Note: The below rates are applicable only for Magma Own Renewal with NCB
 *    business."
 *
 * OWN RENEWAL WITH NCB (USER ruling 2026-09-24): there is no previous-insurer
 * field in the pricing params, so this is read as business type RENEWAL
 * (excluding Rollover, which is business switched in from another insurer, and
 * excluding New) AND NCB > 0. Same reading the Zuno gate already uses for these
 * fields.
 *
 * Magma's UW clusters are already modelled as rate_rules.region (CG1..CG7), so
 * the cluster match is a straight region comparison.
 *
 * Each enabler OVERRIDES the matched rate (it is a negotiated rate, not a
 * delta). Date-gated, and a no-op when nothing matches.
 */
const ENABLERS = [
  {
    id: 'CG-GCV-20-40-AGE5',
    effFrom: '2026-09-01',
    state: 'Chhattisgarh',
    clusters: ['CG1', 'CG3'],
    product: 'GCV',
    rateType: 'COMP',            // Policy Type = Comprehensive
    weightMin: 20,               // GCV 20T-40T
    weightMax: 40,
    minAge: 5,                   // Age >= 5
    rate: 0.24,                  // 24%
    ownRenewalWithNcb: true,
    label: "Magma Sep'26 enabler CG1/CG3 GCV 20-40T Age>=5 (Own Renewal w/ NCB)",
  },
];

const up = (s) => String(s || '').toUpperCase();

/** Business type RENEWAL (not Rollover, not New) with a positive NCB. */
function isOwnRenewalWithNcb(params) {
  const biz = up(params.subBusinessType || params.businessType || '');
  if (!biz) return false;
  if (/ROLL/.test(biz)) return false;                 // rolled in from another insurer
  if (!/RENEW/.test(biz)) return false;               // New / anything else
  return (Number(params.ncbPct) || 0) > 0;
}

function effOnOrAfter(params, from) {
  const d = String(params.effective_date || params.effectiveDate || params.riskStartDate || '').slice(0, 10);
  return !!d && d >= from;
}

/**
 * @returns {{rate:number, label:string}|null} null = no enabler applies; leave
 *          the engine's matched rule untouched.
 */
function findMagmaEnabler(rule, params, regionLabel) {
  if (!rule) return null;
  const region = up(regionLabel || rule.region);
  const segment = String(rule.segment || '');
  const age = Number(params.vehicleAge);
  const tonnage = Number(params.tonnage);

  for (const e of ENABLERS) {
    if (!effOnOrAfter(params, e.effFrom)) continue;
    if (!e.clusters.some((c) => c === region)) continue;
    if (e.product && up(rule.product || params.vehicleType) !== e.product) continue;
    if (e.rateType && up(rule.rate_type) !== e.rateType) continue;
    if (e.ownRenewalWithNcb && !isOwnRenewalWithNcb(params)) continue;
    // Band match: prefer the rule's own segment label (Magma files these as
    // "GCV 20T-40T Age>=5"); fall back to the policy's tonnage/age.
    const segHit = /20T\s*-\s*40T/i.test(segment) && /age\s*>?=?\s*5/i.test(segment);
    const numHit = Number.isFinite(tonnage) && tonnage > e.weightMin && tonnage <= e.weightMax
                && Number.isFinite(age) && age >= e.minAge;
    if (!segHit && !numHit) continue;
    return { rate: e.rate, label: e.label };
  }
  return null;
}

module.exports = { findMagmaEnabler, isOwnRenewalWithNcb, ENABLERS };
