'use strict';

/**
 * GO DIGIT Heavy Commercial (>12T trucks) — June'26 "HCV Grid" sheet (the CV Grid
 * is "excl. HCV", so >12T tippers/trucks live here). Clean long-format table keyed
 * by cluster × tonnage segment × make × age × body-type × cover → Max CD2.
 *
 * The engine had no source for >12T (the CV resolver returns null for them), so
 * they kept region-blank garbage (GJ10/2381 TATA 20-40T stayed 85). Correct:
 * Good GJ · GCV4 20-40T · age 6+ · Non-Dumper · Tata → Comp 30 / SATP 45.
 *
 * config/go_digit_hcv_jun26.json (regen tools/_gen_godigit_hcv.js). Returns the
 * Max CD2 fraction or null (unknown cluster/segment/age or "D" decline → leave engine).
 */
const CFG = require('../config/go_digit_hcv_jun26.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const regKey = (s) => norm(s).replace(/\s*(CV GRID|RTO CLUSTER|GRID)\s*$/i, '').replace(/[^A-Z0-9]/g, '');

const IDX = {};
for (const c of Object.keys(CFG.grid)) IDX[regKey(c)] = CFG.grid[c];

// tonnage (GVW, tonnes) or the engine's matched segment → HCV tonnage band
function tonnageSeg(params, matchedSegment) {
  const s = norm(matchedSegment);
  if (/44\s*T\s*\+|GREATER THAN 44|44T\+/.test(s)) return '44T+';
  if (/40\s*T\s*\+|GREATER THAN 40/.test(s)) return '40T+';
  if (/40\s*-\s*44|40 TO 44/.test(s)) return '40-44T';
  if (/20\s*TO\s*40|20 To 40/i.test(s)) return 'GCV4 20 to 40T';
  if (/12\s*TO\s*20|12 To 20/i.test(s)) return 'GCV4 12 to 20T';
  const t = Number(params.gvw || params.tonnage || params.weight) || 0; // tonnes
  if (t > 44) return '44T+';
  if (t > 40) return '40T+';
  if (t > 20) return 'GCV4 20 to 40T';
  if (t > 12) return 'GCV4 12 to 20T';
  return null;
}
const segKey = (s) => norm(s).replace(/[^A-Z0-9]/g, '');

function bodyOf(params) {
  const hay = norm(`${params.make} ${params.model} ${params.bodyType || ''} ${params.matchedSegment || ''}`);
  if (/GAS\s*TANK/.test(hay)) return 'gas';
  if (/OIL\s*TANK|\bTANKER\b/.test(hay)) return 'oil';
  if (/TIPPER|DUMPER|TIPPI|TIP\b/.test(hay)) return 'dumper';
  return 'nonDumper';
}

function resolveGoDigitHcvRate(params, region, matchedSegment) {
  const rows = IDX[regKey(region)];
  if (!rows || !rows.length) return null;
  const seg = tonnageSeg(params, matchedSegment);
  if (!seg) return null;
  const wantSeg = segKey(seg);
  const cands = rows.filter((r) => segKey(r.segment) === wantSeg);
  if (!cands.length) return null;

  const age = Number(params.vehicleAge);
  let row = Number.isFinite(age) ? cands.find((r) => age >= r.ageFrom && age <= r.ageTo) : null;
  if (!row) row = cands.find((r) => r.ageFrom <= 6 && r.ageTo >= 6) || cands[cands.length - 1];
  const body = row.bodies[bodyOf(params)] || row.bodies.nonDumper;
  const isSatp = (Number(params.odPremium) || 0) <= 0;
  const cover = isSatp ? body.satp : body.comp;
  const isTata = /TATA/.test(norm(params.make));
  const v = isTata ? cover.tata : cover.other;
  if (v == null || !Number.isFinite(Number(v))) return null;
  return { rate: +(Number(v) / 100).toFixed(4), region, segment: seg, body: bodyOf(params), make: isTata ? 'Tata' : 'Other', age: `${row.ageFrom}-${row.ageTo}` };
}

module.exports = { resolveGoDigitHcvRate, tonnageSeg };
