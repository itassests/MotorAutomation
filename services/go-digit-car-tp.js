'use strict';

/**
 * GO DIGIT Private Car SATP (TP-only) — June'26 "Large Broker Grid",
 * sheet "Pvt Car TP Grid". The operator pays the grid's Max CD2 by
 *   4W-TP cluster  ×  fuel/cc segment  ×  age band (<10 / >10 / All).
 *
 * Two things the generic path got wrong and this resolver fixes:
 *  1. CLUSTER. SATP uses the sheet's dedicated "4W TP" cluster column
 *     (e.g. PB02 -> PB_Good), NOT the Comp cluster (PB02 -> PB_CH) the
 *     engine resolves for region. So we map RTO -> cluster ourselves.
 *  2. INGEST GAP. The June re-ingest didn't load this sheet's cluster/
 *     age-split rows, so SATP fell back to the flat April value (e.g.
 *     Punjab Diesel<1500 -> 46 instead of 37.5). Config-driven here.
 *
 * Scope: CAR + SATP only (od<=0). Comp/SAOD -> services/go-digit-car.js.
 * Config: config/go_digit_car_tp_jun26.json (regenerate on re-upload via
 * tools/_gen_godigit_car_tp.js). Returns a rate FRACTION or null (leave
 * the engine's value untouched — never guess).
 */
const CFG = require('../config/go_digit_car_tp_jun26.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
// The RTO-map sheet and the TP-grid sheet spell some clusters differently in
// case/spacing (e.g. map "UP_NEAR_UK" vs grid "UP_Near_UK"). Index the grid by a
// normalized key so the two always line up.
const clKey = (s) => norm(s).replace(/[^A-Z0-9]/g, '');
const GRID_BY_KEY = {};
for (const k of Object.keys(CFG.grid)) GRID_BY_KEY[clKey(k)] = CFG.grid[k];

// Fuel -> grid family token. Go Digit TP segments start with Petrol/Diesel/CNG
// (electric cars are a separate/again path; leave them to the engine).
function fuelFamily(fuel) {
  const f = norm(fuel);
  if (/DIESEL/.test(f)) return 'DIESEL';
  if (/PETROL/.test(f)) return 'PETROL';
  if (/CNG|LPG|BI[\s-]?FUEL|INBUILT/.test(f)) return 'CNG';
  return null;
}

// Parse a segment's cc band. Returns a predicate cc->bool and a specificity rank.
function ccBand(segRest) {
  const s = segRest.replace(/\s+/g, '');
  let m;
  if ((m = s.match(/^(\d+)-(\d+)$/))) { const a = +m[1], b = +m[2]; return { test: (cc) => cc >= a && cc <= b, rank: 3 }; }
  if ((m = s.match(/^<(\d+)$/)))       { const a = +m[1];            return { test: (cc) => cc < a, rank: 2 }; }
  if ((m = s.match(/^>(\d+)$/)))       { const a = +m[1];            return { test: (cc) => cc > a, rank: 2 }; }
  return { test: () => true, rank: 0 }; // plain fuel, no band -> matches any
}

function pickSegment(rows, family, cc) {
  // candidate rows whose segment belongs to this fuel family
  const cands = rows.filter((r) => norm(r.segment).replace(/\s+/g, '').startsWith(family));
  if (!cands.length) return null;
  // group by segment label, attach band info
  const bySeg = new Map();
  for (const r of cands) {
    if (!bySeg.has(r.segment)) {
      const rest = r.segment.replace(new RegExp('^' + family, 'i'), '').trim(); // e.g. "<1500"
      bySeg.set(r.segment, { rest, band: ccBand(rest) });
    }
  }
  // choose the most specific band that contains cc; tie-break higher rank
  let best = null;
  for (const [seg, info] of bySeg) {
    if (info.band.test(cc)) {
      if (!best || info.band.rank > best.rank) best = { seg, rank: info.band.rank };
    }
  }
  if (best) return best.seg;
  // boundary gap (e.g. cc==1000 with only <1000/>1000): fall back to plain-fuel then any
  const plain = [...bySeg].find(([, i]) => i.band.rank === 0);
  if (plain) return plain[0];
  return [...bySeg.keys()][0];
}

function resolveGoDigitCarTpRate(params) {
  if (norm(params.vehicleType) !== 'CAR') return null;
  if ((Number(params.odPremium) || 0) > 0) return null;   // SATP only
  const family = fuelFamily(params.fuelType);
  if (!family) return null;

  const rto = norm(params.rtoCode).replace(/[^A-Z0-9]/g, ''); // "PJ-2"/"PB 02" -> "PB02"
  const cluster = CFG.rtoCluster[rto];
  if (!cluster) return null;
  const rows = GRID_BY_KEY[clKey(cluster)];
  if (!rows || !rows.length) return null;

  const cc = Number(params.cubicCapacity || params.cc) || 0;
  const seg = pickSegment(rows, family, cc);
  if (!seg) return null;

  const age = Number(params.vehicleAge);
  const segRows = rows.filter((r) => r.segment === seg);
  let hit = null;
  const ageBand = Number.isFinite(age) ? (age < 10 ? '<10' : '>10') : null;
  if (ageBand) hit = segRows.find((r) => r.age === ageBand);
  if (!hit) hit = segRows.find((r) => r.age === 'All');
  if (!hit && ageBand) hit = segRows.find((r) => r.age !== 'All'); // single-band segment
  if (!hit) hit = segRows[0];
  if (!hit || !Number.isFinite(Number(hit.pct))) return null;

  return { rate: +(Number(hit.pct) / 100).toFixed(4), cluster, segment: seg, age: hit.age };
}

module.exports = { resolveGoDigitCarTpRate };
