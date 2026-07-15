'use strict';

/**
 * GO DIGIT Commercial (GCV / MISC / tractor / E-Rickshaw / PCV3W) — June'26
 * "CV Grid (excl. HCV)". The June ingest parsed the sheet's region-TILED left
 * block WITHOUT carrying the region-block header down, so ~12k CV rows landed
 * region-blank and the matcher grabbed arbitrary values (GJ7/35503 tractor 6+
 * SATP 35 instead of GOOD GJ 47.5; GJ7/35483 GCV4 2.5-3.5T 27.5 instead of 55).
 *
 * config/go_digit_cv_jun26.json is re-parsed from that sheet WITH region tracking
 * (tools/_gen_godigit_cv.js): region -> [{segment, make, ageMin,ageMax, compMax, satpMax, amb}].
 * This resolver keys by the engine's resolved region + the already-matched CV
 * segment + make + vehicle age + cover (SATP if od<=0 else Comp), and returns the
 * Max CD2 fraction — or null (unknown region/segment, ambiguous "/" cell, or a
 * declined "D" cell) to leave the engine's value untouched. Never guesses.
 */
const CFG = require('../config/go_digit_cv_jun26.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const segNorm = (s) => norm(s).replace(/[^A-Z0-9]/g, '');
const regKey = (s) => norm(s).replace(/\s*(CV GRID|RTO CLUSTER|GRID)\s*$/i, '').replace(/[^A-Z0-9]/g, '');

const IDX = {};
for (const r of Object.keys(CFG.grid)) IDX[regKey(r)] = CFG.grid[r];

// strip a trailing age band from a segment label so engine labels line up with base segments
function baseSeg(seg) {
  return String(seg)
    .replace(/\bAge\s*\d+\s*-\s*\d+/ig, '').replace(/\bAge\s*\d+\s*\+/ig, '')
    .replace(/\d+\s*to\s*\d+\s*years?/ig, '').replace(/\d+\s*\+\s*years?/ig, '')
    .replace(/\bage\s*\d+\s*\+/ig, '').replace(/\bage\s*\d+\b/ig, '')
    .replace(/\d+\s*year\b/ig, '').replace(/\s*-\s*$/, '').replace(/\s+/g, ' ').trim();
}

// does a grid make-label apply to this policy make?
function makeMatch(gridMake, polMake, rank) {
  const gm = norm(gridMake), pm = norm(polMake);
  if (/^ALL$/.test(gm)) return rank === 'fallback';
  if (/OIL TANKER/.test(gm)) return false;                 // body-type, not resolvable here
  if (/SONALIKA/.test(gm)) return /SONALIKA/.test(pm);
  if (/OTHER MAKES/.test(gm)) return rank === 'fallback' && !/SONALIKA/.test(pm);
  if (/^TATA$/.test(gm)) return /TATA/.test(pm);
  if (/^MAHINDRA$/.test(gm)) return /MAHINDRA/.test(pm);
  if (/NON[\s-]?TATA/.test(gm)) return rank === 'fallback' && !/TATA/.test(pm);
  if (/^OTHERS?$/.test(gm)) return rank === 'fallback';
  return rank === 'fallback'; // any other narrow label → only as fallback
}

// Only these CV base segments are handled (keeps the resolver away from the
// sheet's Taxi/Bus/PCV4 noise rows — those are priced by other paths).
const CV_SEG_OK = /^(GCV3|GCV4|TRACTOR|MISCD|BACKHOELOADER|ERICKSHAW|EAUTO|ELOADERS|PCV3W|PCV2W)/;

function resolveGoDigitCvRate(params, region, matchedSegment) {
  const rows = IDX[regKey(region)];
  if (!rows || !rows.length) return null;

  const wantSeg = segNorm(baseSeg(matchedSegment));
  if (!wantSeg || !CV_SEG_OK.test(wantSeg)) return null;
  // segment match: exact normalized, else the grid base is a prefix of the wanted (or vice-versa)
  let cands = rows.filter((r) => segNorm(r.segment) === wantSeg);
  if (!cands.length) cands = rows.filter((r) => { const g = segNorm(r.segment); return g && (g === wantSeg || wantSeg.startsWith(g) || g.startsWith(wantSeg)); });
  if (!cands.length) return null;

  const age = Number(params.vehicleAge);
  const isSatp = (Number(params.odPremium) || 0) <= 0;
  const pick = (rank) => {
    let c = cands.filter((r) => makeMatch(r.make, params.make, rank));
    if (Number.isFinite(age)) { const a = c.filter((r) => age >= r.ageMin && age <= r.ageMax); if (a.length) c = a; }
    for (const r of c) {
      if (r.amb) continue;                                 // "/"-ambiguous cell → skip
      const v = isSatp ? r.satpMax : r.compMax;
      if (v != null && Number.isFinite(Number(v))) return { r, v };
    }
    return null;
  };
  const hit = pick('exact') || pick('fallback');
  if (!hit) return null;
  return { rate: +(Number(hit.v) / 100).toFixed(4), region, segment: hit.r.segment, make: hit.r.make, age: `${hit.r.ageMin}-${hit.r.ageMax}` };
}

module.exports = { resolveGoDigitCvRate, baseSeg };
