'use strict';

/**
 * IndusInd GCV-LCV addendum — "PO Grid for Aug 2026, effective 16th August"
 * (Addendum LCV.xlsx / Sheet2). Re-prices the light-goods class (TATA/Maruti/
 * Mahindra ≤2.5T) by RTO Region × make-segment, COMP/STP. Overrides the June
 * CV grid (indusind-cv.js) for these specific cells for risk-start ≥ 16-Aug-26.
 *
 * Segments (grid columns):
 *   A = TATA / Maruti, <2T
 *   B = Mahindra (Jeeto & Supro only), <2T
 *   C = "Other" — Mahindra non-Jeeto/Supro <2T, OR any of the three makes 2–2.5T
 * Weight edge: LOWER band owns the boundary (2.0T → <2T tier per house convention).
 *
 * Region is resolved with the SAME logic as the CV grid (config keys are identical:
 * MUMBAI, ROM, GUJ 1, KARNATAKA, DELHI …), so LCV reuses cvRegion(). Makes outside
 * TATA/Maruti/Mahindra, or tonnage >2.5T, are NOT in this addendum → returns null
 * (the June CV resolver's output stands). Returns rate fraction or null.
 */
const GRID = require('../config/indusind_lcv_aug26.json');
const { cvRegion } = require('./indusind-cv');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

function lcvSegment(params) {
  const hay = `${norm(params.vehicleCategory)} ${norm(params.model)} ${norm(params.make)}`;
  const ton = Number(params.tonnage) || 0;
  if (!(ton > 0 && ton <= 2.5)) return null;               // light class only
  const isTata = /TATA/.test(hay), isMaruti = /MARUTI/.test(hay), isMahindra = /MAHINDRA/.test(hay);
  if (!(isTata || isMaruti || isMahindra)) return null;    // addendum covers only these 3 makes
  const isJeetoSupro = isMahindra && /JEETO|SUPRO/.test(hay);
  if (ton <= 2) {
    if (isJeetoSupro) return 'B';
    if (isTata || isMaruti) return 'A';
    return 'C';                                            // Mahindra non-Jeeto/Supro <2T
  }
  return 'C';                                              // any of the three, 2–2.5T
}

function resolveIndusindLcvRate(params) {
  if (!/GCV|GOODS/.test(norm(params.vehicleType))) return null;
  const seg = lcvSegment(params);
  if (!seg) return null;
  const reg = cvRegion(params);
  if (!reg) return null;
  const row = GRID[norm(reg)] || GRID[reg];
  if (!row || !row[seg]) return null;
  const cell = row[seg];
  const od = Number(params.odPremium) || 0;
  const rate = od > 0 ? cell.comp : cell.stp;
  return rate == null || isNaN(rate) ? null : +Number(rate).toFixed(4);
}

module.exports = { resolveIndusindLcvRate, lcvSegment };
