'use strict';

/**
 * GO DIGIT Private Car — June'26 "Large Broker Grid" (sheet "Pvt Car Comp+SAOD
 * Grid"). That sheet is TWO tables side by side:
 *   LEFT  (cols 0-8)  — a make-specific Comp block (Hyundai/Mahindra/Tata/…).
 *   RIGHT (cols 12-17)— the summary grid the operator actually pays on:
 *                       Cluster × {SAOD, Comp} × {Non-NCB, NCB} + a HEV column.
 *
 * The June re-ingestion mis-read the two-table layout and loaded the LEFT
 * make-block values into rate_rules (make/segment blank), so every make in a
 * cluster collapsed to one wrong rate — Go Digit scattered hi/lo vs the operator.
 * Validated against the June reconciliation: the RIGHT block explains ~100 of the
 * 103 Pvt-Car Comp/SAOD mismatches; the make-block does not.
 *
 * This resolver returns the correct rate FRACTION from the right block (or null
 * to leave the engine's value untouched). Config: config/go_digit_car_jun26.json
 * (regenerate from the grid on re-upload). The cluster is the region the engine
 * has ALREADY resolved (rate_rules region = Mum/ROM/…), passed in as `region`.
 *
 * Scope: Comp (od>0 & tp>0) and SAOD (od>0 & tp<=0) only. SATP (od<=0) is a
 * separate Go Digit grid ("Pvt Car TP Grid") — left to the existing path.
 */
const GRID = require('../config/go_digit_car_jun26.json').grid;
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

function isHev(fuel) {
  return /HYBRID|\bHEV\b|STRONG\s*HYBRID/.test(norm(fuel));
}

// Go Digit's summary block prices a specific MAKE+MODEL group off the "HEV" column
// regardless of fuel (a diesel Mercedes GLE takes HEV 24% in MUM, not plain Comp
// 22%). The authoritative list is Go Digit's "HEV Make Model List" (config/
// go_digit_hev_models.json, regenerate from the sheet on re-share). It is MODEL-
// specific — Mercedes GLE/GLS/S-Class are HEV, but a Toyota Yaris is NOT — so a
// make-only match is wrong. Match make (prefix either way, handles "Toyota
// Kirloskar…" ↔ "Toyota") AND model (policy model starts with the listed model).
const HEV_MODELS = (() => {
  try { return require('../config/go_digit_hev_models.json') || {}; }
  catch (_) { return {}; }
})();
const strip = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
function isHevMake(make, model) {
  const pm = strip(make), pmodel = strip(model);
  if (!pm) return false;
  for (const key of Object.keys(HEV_MODELS)) {
    // Brand match: one side is a prefix of the other (min 3 chars to avoid noise).
    if (key.length < 3 || !(pm.startsWith(key) || key.startsWith(pm))) continue;
    for (const lm of HEV_MODELS[key]) {
      if (lm && pmodel && lm.length >= 2 && (pmodel === lm || pmodel.startsWith(lm))) return true;
    }
  }
  return false;
}

function resolveGoDigitCarRate(params, region) {
  if (norm(params.vehicleType) !== 'CAR') return null;
  const od = Number(params.odPremium) || 0;
  const tp = Number(params.tpPremium) || 0;
  if (od <= 0) return null;                     // SATP handled elsewhere
  const key = norm(region).replace(/\s+/g, '_'); // "REST OF GJ" -> "REST_OF_GJ"
  const g = GRID[key] || GRID[norm(region)];
  if (!g) return null;
  const ncbYes = (Number(params.ncbPct) || 0) > 0;
  // A residual sub-rupee TP leg (rounding artifact) is a SAOD policy, not Comp.
  const isSaod = tp < 1;
  let pct;
  if (isHev(params.fuelType) || isHevMake(params.make, params.model)) pct = g.hev;
  else if (isSaod) pct = ncbYes ? g.saodNcb : g.saodNonNcb;    // SAOD
  else pct = ncbYes ? g.compNcb : g.compNonNcb;                // Comp
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  return +(Number(pct) / 100).toFixed(4);
}

module.exports = { resolveGoDigitCarRate };
