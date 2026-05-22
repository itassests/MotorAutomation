/**
 * IRDA-mandated default payout rates.
 *
 * Used whenever a rate-card cell says "only IRDA applicable" (no broker
 * margin printed) — we emit the IRDA-default broker payout instead of
 * a declined row, per the firm-wide convention:
 *
 *   COMP rule  → 19.5%
 *   SATP rule  →  2.5%
 *
 * Centralized here so any future change (regulatory revision, contract
 * amendment) is a one-line edit and propagates to every insurer parser
 * that emits "IRDA-only" cells.
 *
 * Caller picks the value via `irdaRateFor(rateType)` which inspects the
 * rate_type string and routes to the matching default.
 */

const IRDA_RATE_COMP = 0.195;  // 19.5%
const IRDA_RATE_SATP = 0.025;  //  2.5%

/**
 * Resolve the IRDA-default payout rate for a given rate_type.
 * Returns a decimal fraction (0.025, 0.195) or null if rate_type is
 * neither COMP- nor SATP-flavoured.
 *
 * Recognized rate_type tags (case-insensitive):
 *   "SATP" / "TP" / "IRDA_TP"        → SATP rate
 *   "COMP" / "OD" / "PACKAGE" / etc. → COMP rate (default fallback)
 */
function irdaRateFor(rateType) {
  const rt = String(rateType || '').toUpperCase();
  if (!rt) return null;
  // SATP-side: SATP itself, IRDA_TP suffix, or pure "TP" tag.
  if (rt === 'SATP' || /(?:^|[_|])SATP(?:[_|]|$)/.test(rt)) return IRDA_RATE_SATP;
  if (/IRDA_TP\b/.test(rt) || /(?:^|[_|])TP(?:[_|]|$)/.test(rt)) return IRDA_RATE_SATP;
  // Everything else (COMP, OD, SAOD, Package, …) → COMP default.
  return IRDA_RATE_COMP;
}

module.exports = {
  IRDA_RATE_COMP,
  IRDA_RATE_SATP,
  irdaRateFor,
};
