'use strict';

/**
 * IndusInd Private-Car SEGMENT grid — effective 1-Sept-2026 (USER). A pan-India
 * payout by car SEGMENT × NCB-presence that OVERRIDES the existing IndusInd Pvt-Car
 * match for any car whose segment resolves:
 *      Segment      NCB     Non-NCB
 *      Small        10%     10%
 *      Midsize      20%     20%
 *      Compact      30%     25%
 *      SUV/MUV      35%     35%
 *      High-end     35%     35%
 * Rates in config/indusind_car_segment_sep26.json. Applies to OD-bearing policies
 * (Comp or SAOD, od>0) — NCB is an own-damage concept; TP-only is unaffected (the
 * PVTP addendum handles that). NCB column when ncbPct>0, else Non-NCB.
 *
 * Segment is classified from IndusInd's own make/model→segment master
 * (config/indusind_pvtcar_segment.json, built from "Pvt Car Model Segment.xlsx"):
 * exact/prefix model match, else a make's unanimous segment, else high-end make
 * detection. A car whose segment can't be resolved is NOT overridden (keeps the
 * existing rate) — matching the USER instruction ("existing Pvt matching this rule").
 */
const SEG = require('../config/indusind_pvtcar_segment.json');
const RATE = require('../config/indusind_car_segment_sep26.json');
const { isHighEnd } = require('./reliance-car');
const mkFirst = (s) => String(s || '').toUpperCase().trim().split(/[\s&]+/)[0].replace(/[^A-Z0-9]/g, '');
const modNorm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function classifySegment(params) {
  const mk = mkFirst(params.make);
  const pol = modNorm(params.model);
  const e = SEG[mk];
  if (e) {
    if (pol) {
      // Pass 1 (strong): exact, or the file model is a prefix of the policy model
      // ("Swift" ⊂ "Swift VDI"). Models are longest-first, so the most specific wins.
      for (const [mo, seg] of e.models) {
        if (pol === mo || (mo.length >= 3 && pol.startsWith(mo))) return seg;
      }
      // Pass 2 (weak): policy model is a prefix of a file model (truncated PR model).
      for (const [mo, seg] of e.models) {
        if (pol.length >= 3 && mo.startsWith(pol)) return seg;
      }
    }
    if (e.dom) return e.dom;                               // make is unanimously one segment
  }
  if (isHighEnd(params.make, params.model)) return 'HIGHEND';
  return null;
}

function resolveIndusindCarSegmentRate(params) {
  if (String(params.vehicleType || '').toUpperCase() !== 'CAR') return null;
  if ((Number(params.odPremium) || 0) <= 0) return null;  // OD-bearing only (Comp/SAOD); TP-only unaffected
  const seg = classifySegment(params);
  if (!seg || !RATE[seg]) return null;
  const rate = (Number(params.ncbPct) || 0) > 0 ? RATE[seg].ncb : RATE[seg].nonNcb;
  return rate == null || isNaN(rate) ? null : { rate: +Number(rate).toFixed(4), segment: seg };
}

module.exports = { resolveIndusindCarSegmentRate, classifySegment };
