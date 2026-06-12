/**
 * PR (Premium Register) reconciliation.
 *
 * The operator's Premium Register — the insurer's own per-policy export — is the
 * AUTHORITATIVE source for the key rating factors. Our policy data comes from
 * Prarambh, which has data-quality issues (e.g. the MFG year 1998 bleeding into
 * the CC field for a 100cc bike). When a PR row is matched (by policy_no, with
 * variant + vehicle-no fallback), PR wins for: CC, NCB, FuelType, Tonnage,
 * Seating, Product (Comp/SAOD/TP) — but ONLY when PR carries a valid value;
 * otherwise the Prarambh value is left untouched. Each normaliser returns null
 * when PR's value is missing/blank/unrecognised, which the caller treats as
 * "no override".
 */

// CC: digits only, > 0. (PR stores plain integers, e.g. 100.)
function normCC(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

// NCB → percent. Handles fractions (0.45), percents (45), signed (-45), "%".
function normNCB(v) {
  if (v == null || v === '') return null;
  let n = parseFloat(String(v).replace(/[%,]/g, ''));
  if (!Number.isFinite(n)) return null;
  n = Math.abs(n);
  if (n > 0 && n <= 1) n = n * 100;   // 0.45 → 45
  if (n > 100) return null;
  return +n.toFixed(2);
}

// Fuel → canonical primary fuel. Diesel-vs-non-diesel is what banding cares
// about, so compound bifuels collapse to their lead fuel. Single-letter codes:
// D=Diesel, P=Petrol, C=CNG, B=Battery(electric).
function normFuel(v) {
  const u = String(v || '').toUpperCase().trim();
  if (!u || u === '-' || u === 'INBUILT') return null;
  if (/DIESEL/.test(u) || u === 'D' || u === 'DH') return 'DIESEL';
  if (/ELECTRI|BATTERY/.test(u) || u === 'B' || u === 'E') return 'ELECTRIC';
  if (/HYBRID/.test(u)) return 'HYBRID';
  if (/\bLPG\b|LIQUID\s*PETROL/.test(u)) return 'LPG';
  if (/CNG/.test(u) || u === 'C' || u === 'G') return 'CNG';
  if (/PETROL/.test(u) || u === 'P') return 'PETROL';
  return null;
}

// Tonnage → TONNES. PR stores GVW in KG for most insurers (730..75000) but in
// TONNES for ICICI/Royal (≤60). A real GCV GVW in tonnes is ≤~50, so any value
// > 60 is kg and is divided by 1000.
function normTonnage(v) {
  if (v == null) return null;
  let n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 60) n = n / 1000;
  return +n.toFixed(3);
}

// Seating → positive integer (0/blank = unknown → skip).
function normSeating(v) {
  const n = parseInt(v, 10);
  return (Number.isFinite(n) && n > 0) ? n : null;
}

// Product → Comp | SAOD | TP, from the PR's verbose product phrase. Returns null
// for non-motor products (Health/Travel/Marine/…) and anything unrecognised, so
// those never override the Prarambh-derived product.
function normProduct(v) {
  const u = String(v || '').toUpperCase();
  if (!u) return null;
  if (/STANDALONE\s*(OWN\s*DAMAGE|OD)\b|\bOD\s*ONLY\b|\bSAOD\b|\bSOD\b/.test(u)) return 'SAOD';
  if (/STANDALONE\s*TP\b/.test(u)) return 'TP';
  if (/\bLIABILITY\b|THIRD\s*PARTY|\bTP\s*ONLY\b|\bSATP\b/.test(u)) return 'TP';
  if (/PACKAGE|COMPREHENSIVE|BUNDLED|MULTIYEAR|\bSECURE\b|MOTOR\s*PROTECT|\d\s*\+\s*\d/.test(u)) return 'Comp';
  return null;
}

/**
 * Override params in place with PR's authoritative values (when valid).
 * Tonnage is applied only to commercial vehicles (GCV/PCV/MISC) — TW/CAR don't
 * band by tonnage and PR's value there is a meaningless GVW. Returns a small
 * record of what changed (for diagnostics / logging).
 */
function reconcileParamsWithPR(params, prRow, opts) {
  if (!params || !prRow) return null;
  // Diagnostic kill-switch: PR_SKIP=product,fuel,seating,... disables those
  // factors so a single override's effect can be isolated in a recompute.
  const skip = new Set(String(process.env.PR_SKIP || '').toLowerCase().split(/[,\s]+/).filter(Boolean));
  // A PR row matched by VEHICLE NUMBER (not policy_no) may be a DIFFERENT policy
  // year for the same vehicle (Sompo JH01EQ6188: PR row 2311/84175076 with NCB=20
  // attached to policy AVO/2311/20045527 whose real NCB=0 → matched the with-NCB
  // 37 instead of the operator's Non-NCB 32). Vehicle-matched rows stay
  // authoritative for VEHICLE attributes (cc/fuel/tonnage/seating) but must not
  // override POLICY-YEAR attributes (ncb, product).
  if (opts && opts.vehicleMatched) { skip.add('ncb'); skip.add('product'); }
  const changed = {};
  if (!skip.has('cc')) {
    const cc = normCC(prRow.cc);
    if (cc != null && cc !== params.cc) { changed.cc = [params.cc, cc]; params.cc = cc; }
  }
  if (!skip.has('ncb')) {
    const ncb = normNCB(prRow.ncb);
    if (ncb != null && ncb !== params.ncbPct) { changed.ncbPct = [params.ncbPct, ncb]; params.ncbPct = ncb; }
  }
  if (!skip.has('fuel')) {
    const fuel = normFuel(prRow.fuel_type);
    if (fuel && fuel !== String(params.fuelType || '').toUpperCase()) {
      changed.fuelType = [params.fuelType, fuel]; params.fuelType = fuel;
    }
  }
  const vt = String(params.vehicleType || '').toUpperCase();
  if (!skip.has('tonnage') && /GCV|PCV|MISC/.test(vt)) {
    const t = normTonnage(prRow.tonnage);
    if (t != null && t !== params.tonnage) {
      changed.tonnage = [params.tonnage, t];
      params.tonnage = t; params.tonnageMin = t; params.tonnageMax = t; params.tonnageCoarse = false;
    }
  }
  if (!skip.has('seating')) {
    const seat = normSeating(prRow.seating);
    if (seat != null && seat !== params.seatingCapacity) {
      changed.seatingCapacity = [params.seatingCapacity, seat]; params.seatingCapacity = seat;
    }
  }
  // Product override is OFF by default (opt-in via PR_ENABLE_PRODUCT). Measured
  // regression: forcing insProduct from PR (e.g. a blank Prarambh product -> SAOD
  // for "PRIVATE CAR OD ONLY") flips the rate leg / SAOD-segment matching and cost
  // future_generali -9 matches with no offsetting gains. The other five factors
  // are net-safe; product needs per-insurer handling before it can be trusted.
  if (process.env.PR_ENABLE_PRODUCT === '1' && !skip.has('product')) {
    const prod = normProduct(prRow.product);
    if (prod && prod !== params.insProduct) { changed.insProduct = [params.insProduct, prod]; params.insProduct = prod; }
  }

  return Object.keys(changed).length ? changed : null;
}

module.exports = {
  reconcileParamsWithPR, normCC, normNCB, normFuel, normTonnage, normSeating, normProduct,
};
