'use strict';

/**
 * ICICI Commercial PO grid (June'26 "CV Grid_June 26_New V1(1)") — the higher PO
 * grid the operator actually pays on (the ingested rate_rules are the base grid).
 * config/icici_cv_po_jun26.json holds RAW cells per RTO-cluster × segment; cells are
 * CONDITIONAL, e.g. "NEW:0%,OLD:60%" | "COMP|GJ1|TATA:10%,OTHERS:0%" | "No Biz" | "CC".
 *
 * Note 7: AOTP policies (od<=0) use CV_AOTP where the segment exists, else CV_Comp.
 * Returns the Net% fraction, 0 for decline, or null (unknown / "CC" council-call /
 * unmapped → leave the engine's value). School Bus is intentionally left to the
 * engine for now (operator +2.5 over grid, pending confirmation).
 */
const CFG = require('../config/icici_cv_po_jun26.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
// "&"→"AND" so "JAMMU & KASHMIR" == config "JAMMUANDKASHMIR"; then strip non-alnum
const regKey = (s) => norm(s).replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
// pre-index each table by normalized region key
const TBL_IDX = {};
for (const tbl of ['comp', 'compRight', 'aotp']) {
  TBL_IDX[tbl] = {};
  if (CFG[tbl]) for (const k of Object.keys(CFG[tbl])) TBL_IDX[tbl][regKey(k)] = CFG[tbl][k];
}

// ---- policy → ICICI segment column name -------------------------------------
function segmentFor(p) {
  const vt = norm(p.vehicleType);
  const fuel = norm(p.fuelType);
  const seat = Number(p.seating || p.seatingCapacity) || 0;
  const t = Number(p.gvw || p.tonnage || p.weight) || 0;
  const isElec = /ELECTRIC|\bEV\b|BATTERY/.test(fuel);
  const body = norm(`${p.model} ${p.bodyType}`); // NOT matchedSegment ("Excluding CRANES" would false-trip crane)
  const isNew = (Number(p.vehicleAge) || 0) <= 0;

  // Passenger 3W (auto/e-rick/e-auto)
  if (/PCV/.test(vt) && (t <= 1 || /3W|RICKSHAW|AUTO|E-RICK|TREO|TREO|YATRI|SAARTHI/.test(body) || seat <= 4)) {
    if (isElec) return 'PCV 3W Electric';
    if (/DIESEL/.test(fuel)) return 'PCV 3W Others (Diesel)';
    return isNew ? 'PCV 3W Petrol/CNG New' : 'PCV 3W Petrol/CNG Old';
  }
  // Buses
  if (/PCV|BUS/.test(vt) && seat > 10) {
    if (/STAFF/.test(body)) return seat > 18 ? 'Staff Bus >18' : null;
    // School Bus intentionally skipped (return null → leave engine)
    return null;
  }
  // GCV 3W
  if (/GCV|GOODS/.test(vt) && (t <= 1 || /3W/.test(body))) {
    if (isElec) return 'GCV 3W Electric';
    return isNew ? 'GCV 3W New' : 'GCV 3W Old';
  }
  // Misc-D construction equipment (excluding cranes)
  // Misc-D CE = construction equipment. NOTE: goods pickups (Bolero Max/Maxi, Jeeto)
  // are NOT construction — they're SCV/GCV goods; excluded here so they classify by tonnage.
  if (/MISC/.test(vt) || /BACKHOE|EXCAVATOR|LOADER|JCB|DOZER|GRADER|MOBILE PLANT|DRILLING RIG|FIORI/.test(body)) {
    if (/CRANE/.test(body)) return null;               // cranes handled separately
    return 'MIsc D CE (Excluding CRANES)';
  }
  // Tractor
  if (/TRACTOR/.test(vt) || /TRACTOR/.test(body)) return isNew ? 'Tractor New' : 'Tractor Old';
  // GCV by tonnage/body
  if (/GCV|GOODS/.test(vt)) {
    const bodyTag = /TANKER/.test(body) ? 'Tanker' : /TIPPER|DUMPER/.test(body) ? 'Tipper' : /TRAILER/.test(body) ? 'Trailer' : 'Truck';
    if (t > 0 && t < 2.45) return isNew ? 'SCV <2450 GVW New' : 'SCV <2450 GVW Old';
    if (t >= 2.45 && t < 3.5) return isNew ? 'SCV >= 2450 GVW New' : 'SCV >= 2450 GVW Old';
    if (t >= 3.5 && t < 7.5) return 'LCV 3.5-7.5T';
    if (t >= 7.5 && t < 12) return 'LCV 7.5-12T';
    if (t >= 12 && t < 20) return `MHCV 12-20T ${bodyTag === 'Truck' ? 'Truck' : bodyTag}`;
    if (t >= 20 && t < 40) return `MHCV 20-40T ${bodyTag}`;
    if (t >= 40) return `MHCV >40T ${bodyTag === 'Tipper' ? 'Tipper/ Dumper' : bodyTag}`;
  }
  return null;
}

// ---- conditional cell parser -------------------------------------------------
// cell = comma-separated clauses; clause = "COND|COND|...:VALUE" or "VALUE".
// clause matches if every condition matches ctx; "OTHERS" is the fallback clause.
function parseCell(cell, ctx) {
  const s = String(cell || '').trim();
  if (!s) return null;
  if (/^cc$/i.test(s)) return null;                      // council-call → leave engine
  if (/no\s*biz|decline/i.test(s)) return 0;
  const pct = (str) => { const m = String(str).match(/(-?[\d.]+)\s*%/); return m ? +m[1] : null; };
  if (!/[:|]/.test(s)) { const v = pct(s); return v == null ? null : v; }   // plain "60%"

  const clauses = s.split(',').map((c) => c.trim()).filter(Boolean);
  let fallback = null;
  for (const cl of clauses) {
    const ix = cl.lastIndexOf(':');
    if (ix < 0) continue;
    const conds = cl.slice(0, ix).split('|').map((x) => x.trim()).filter(Boolean);
    const val = pct(cl.slice(ix + 1));
    if (conds.some((c) => /^others?$/i.test(c))) { if (fallback == null) fallback = val; continue; }
    // Non-make conditions (cover/age/sub-cluster) are AND; consecutive MAKE tokens are
    // alternatives (OR): "OLD|AL|TATA|>=6 yrs" = OLD AND (AL OR TATA) AND >=6yrs.
    const makeC = conds.filter(isMakeToken), otherC = conds.filter((c) => !isMakeToken(c));
    if (otherC.every((c) => condMatch(c, ctx)) &&
        (makeC.length === 0 || makeC.some((c) => condMatch(c, ctx)))) return val;
  }
  return fallback;
}

// grid make tokens → canonical make substrings (the grid abbreviates)
const MAKE_ALIAS = { AL: 'ASHOK LEYLAND', 'M&M': 'MAHINDRA', MM: 'MAHINDRA', BB: 'BHARAT BENZ', TATA: 'TATA', EICHER: 'EICHER' };
// a clause token is a MAKE (OR-semantics) unless it's a cover/age/sub-cluster/body keyword
function isMakeToken(c) {
  const u = norm(c);
  if (/^(COMP|AOTP|TP|NEW|OLD|OTHERS?)$/.test(u)) return false;
  if (/\d\s*-\s*\d\s*YRS?|^[<>]=?\s*\d+\s*YRS?|^\d+\s*YRS?/.test(u)) return false;
  if (/^(GJ|MH|UP|TN|KA|RJ)\d/.test(u) || /CLUSTER/.test(u)) return false;
  if (/CRANE|DRILL|MOBILE PLANT|RIG|TIPPER|DUMPER|TANKER/.test(u)) return false;
  return true;
}
function condMatch(c, ctx) {
  const u = norm(c);
  if (u === 'COMP') return ctx.cover === 'COMP';
  if (u === 'AOTP' || u === 'TP') return ctx.cover === 'AOTP';
  if (u === 'NEW') return ctx.isNew;
  if (u === 'OLD') return !ctx.isNew;
  let m;
  if ((m = u.match(/^(\d+)\s*-\s*(\d+)\s*YRS?$/))) return ctx.age >= +m[1] && ctx.age <= +m[2];
  if ((m = u.match(/^>=?\s*(\d+)\s*YRS?$/))) return ctx.age >= +m[1];
  if ((m = u.match(/^<\s*(\d+)\s*YRS?$/))) return ctx.age < +m[1];
  if (/^GJ\d|^MH\d|^UP\d|CLUSTER/i.test(u)) return norm(ctx.subCluster) === u;   // sub-cluster
  if (/CRANE|DRILL|MOBILE PLANT|RIG/.test(u)) return new RegExp(u.replace(/\s+/g, '.*'), 'i').test(ctx.body);
  // otherwise treat as a MAKE token (with grid-abbreviation aliases: AL, M&M, BB…)
  const canon = MAKE_ALIAS[u] || u;
  return ctx.make.includes(canon) || canon.includes(ctx.make) || ctx.make.includes(u);
}

// Segments VALIDATED to match operator via the PO grid (and where the base grid is
// wrong). Scope the live resolver to these for now — the truck/bus/Misc-D segments
// have operator values ABOVE the grid (see project_icici_po_grid) and stay on the
// engine until that basis is confirmed.
// LIVE segments: 3W (PCV/GCV) + LCV + SCV — cells here are clean (plain % or
// OLD|make|age conditionals). EXCLUDED: MHCV (unresolved GJ1/GJ2 sub-clusters →
// wrong OTHERS:0), Misc-D CE (mis-catches tractors), Tractor, GCV3/GCV4 — those
// need sub-cluster resolution / above-grid basis (project_icici_po_grid).
const LIVE_SEG = /3\s*W|LCV|SCV/i;

function resolveIciciCvPoRate(params, opts) {
  const region = norm(params.region || params.resolvedRegion);
  if (!region) return null;
  const seg = segmentFor(params);
  if (!seg) return null;
  if (!(opts && opts.allSegments) && !LIVE_SEG.test(seg)) return null;   // scoped to 3W
  const cover = (Number(params.odPremium) || 0) <= 0 ? 'AOTP' : 'COMP';
  const ctx = {
    cover, isNew: (Number(params.vehicleAge) || 0) <= 0, age: Number(params.vehicleAge) || 0,
    make: norm(params.make), body: norm(`${params.model} ${params.bodyType}`),
    subCluster: norm(params.subCluster || ''),
  };
  const regRow = (tbl) => TBL_IDX[tbl] && TBL_IDX[tbl][regKey(region)];
  // Note 7: AOTP → CV_AOTP first (if segment present), else CV_Comp
  let cell = null;
  if (cover === 'AOTP') { const a = regRow('aotp'); if (a && a[seg] != null) cell = a[seg]; }
  if (cell == null) { const c = regRow('comp'); if (c) cell = c[seg]; }
  if (cell == null) return null;
  const v = parseCell(cell, ctx);
  if (v == null) return null;
  return { rate: +(v / 100).toFixed(4), segment: seg, cover, cell: String(cell).slice(0, 30) };
}

// School-Bus grid rate (fraction) for a region+seating band — used to re-segment a
// bus that the base engine mis-matched to PCV(2W). Returns null if unknown/non-numeric.
function iciciSchoolBusRate(region, seating) {
  const row = TBL_IDX.comp[regKey(region)];
  if (!row) return null;
  const seat = Number(seating) || 0;
  const col = seat > 36 ? 'School Bus >36' : seat >= 18 ? 'School Bus 18-36' : 'School Bus <18';
  const v = parseCell(row[col], {});
  return (v == null || !Number.isFinite(Number(v))) ? null : +(v / 100).toFixed(4);
}

// Misc-D CE rate (fraction) for a region + cover — used to re-price GJ Misc-D at the
// GUJARAT state cluster instead of the city sub-cluster. Empty body ctx so the body
// clauses (Mobile Plant etc.) don't match; returns the plain COMP/AOTP value.
function iciciMiscDCeRate(region, cover) {
  const row = TBL_IDX.comp[regKey(region)];
  if (!row) return null;
  const cell = row['MIsc D CE (Excluding CRANES)'];
  if (!cell) return null;
  const v = parseCell(cell, { cover, body: '', make: '', isNew: false, age: 0 });
  return (v == null || !Number.isFinite(Number(v))) ? null : +(v / 100).toFixed(4);
}

module.exports = { resolveIciciCvPoRate, segmentFor, parseCell, iciciSchoolBusRate, iciciMiscDCeRate };
