'use strict';

/**
 * TATA AIG CV / PCV / GCV / MISC — June'26 grid (sheet "CV" of
 * "CV Grid -June 26 Robinhood.xlsx"; the hidden "cv checks"/"pci checks" tabs are
 * scratch and ignored). The sheet was mis-ingested into rate_rules (tonnage landed
 * in the fuel column), so resolve it config-driven here instead — like
 * services/tata-car.js.
 *
 * Grid = Segment × Fuel × Section(cover) × Vehicle-Age × Region. Regions are the
 * 61 Tata CV clusters (each column is DM- or HOM-channel-tagged, but the channel
 * is fixed per region so it's just a per-region rate). config/tata_cv_jun26.json.
 * Returns the rate fraction or null.
 */
const ROWS_JUN = require('../config/tata_cv_jun26.json').rows;
const ROWS_JUL = require('../config/tata_cv_jul26.json').rows;
const ROWS_SEP = require('../config/tata_cv_sep26.json').rows;
const CLUSTER = require('../config/tata_rto_cluster.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

// Pick grid generation by risk-start (effective) date: Sep'26 on/after 1-Sep-2026,
// July'26 on/after 1-Jul (and when no date — Sep isn't in force until 1-Sep), June
// before. Mirrors tata-car.js gridFor.
function rowsFor(params) {
  const d = String(params.effective_date || params.effectiveDate || params.riskStartDate || params.policyStartDate || '').slice(0, 10);
  if (d >= '2026-09-01') return ROWS_SEP;
  return (!d || d >= '2026-07-01') ? ROWS_JUL : ROWS_JUN;
}

function cvRegion(params) {
  const code = norm(params.rtoCode).replace(/[^A-Z0-9]/g, '');
  if (!code) return null;
  const keys = [code];
  const m = code.match(/^([A-Z]+)(\d+)$/);
  if (m) keys.push(m[1] + String(parseInt(m[2], 10)).padStart(2, '0'), m[1] + parseInt(m[2], 10));
  for (const k of keys) { if (CLUSTER[k] && CLUSTER[k].cv) return CLUSTER[k].cv; }
  return null;
}

// Recover a GVW tonnage (tonnes) from a goods-truck model string when the source
// data carries no tonnage. Indian truck model codes name the GVW class:
//   • Mahindra Furio N            → N tonnes         (Furio 11 ≈ 12T)
//   • Tata legacy 407 / 709       → 7.5T             (model name, not "4.07T")
//   • Tata/BharatBenz LPT/SE/SK…  → 4-digit NNNN → first two digits = GVW tonnes
//                                   (1109→11, 1212→12, 1613→16, 0909→9)
//   • 3-digit 9NN / 7NN / 4NN     → 9 / 7.5 / 7.5T
// Returns 0 when nothing is recognised (Ace/Magic/Intra SCVs & bare "LPT" stay ≤2.0).
function inferTonnage(hay) {
  let m = hay.match(/\bFURIO\s*(\d{1,2})\b/); if (m) return Number(m[1]);
  if (/\b(?:SFC\s*)?407\b/.test(hay) || /\b709\b/.test(hay)) return 7.5;
  m = hay.match(/\b(?:LPT|LPK|LPS|LPO|SE|SK|SFC|BB)?\s*(\d{4})\b/);
  if (m) { const t = Number(m[1].slice(0, 2)); if (t > 0) return t; }
  m = hay.match(/\b(\d{3})\b/);
  if (m) { const n = Number(m[1]); if (n >= 900) return 9; if (n >= 400) return 7.5; }
  return 0;
}

function classifySeg(params) {
  const vt = norm(params.vehicleType);
  const ton = Number(params.tonnage) || 0;
  const seat = Number(params.seatingCapacity) || 0;
  const hay = `${norm(params.vehicleCategory)} ${norm(params.model)} ${norm(params.make)}`;
  const is3W = /\b3\s*W\b|THREE\s*WHEEL|RICKSHAW|RIKSHAW|E-?RICK|\bAUTO\b/.test(hay) ||
    (seat > 0 && seat <= 4 && /PCV|PASSENGER/.test(vt));
  // The RTO body-type label often reads "MISC - D - Tractor" for construction
  // equipment (pick-n-carry cranes, loaders, excavators) that are NOT agricultural
  // tractors. The grid rates real tractors at 0 but Misc equipment at the Misc
  // rate, so keep cranes/earthmovers out of the Tractor bucket (they fall to Misc).
  const NON_TRACTOR = /HYDRA|CRANE|PICK\s*[N&]\s*CARRY|LOADER|EXCAVAT|BACK\s*HOE|BACKHOE|FORK\s*LIFT|FORKLIFT|DOZER|GRADER|\bJCB\b|POCLAIN|COMPRESSOR|EARTH\s*MOV/.test(hay);
  if (/TRACTOR/.test(hay) && !NON_TRACTOR) return 'Tractor';
  if (/HARVEST/.test(hay)) return 'Harvester';
  if (/TRAILER/.test(hay)) return 'Trailer';
  // Goods trucks frequently arrive with tonnage unpopulated (tmp Tonnes +
  // GROSS_VEHICLE_WEIGHT both null) → they'd default to the smallest, highest-
  // commission GCV band. Indian truck model codes encode the GVW class, so recover
  // it from the model when the data has none (inferTonnage). A goods MISC is only
  // reclassified to GCV when a tonnage is recoverable, else it stays Misc.
  let ton2 = ton;
  if (!(ton2 > 0)) ton2 = inferTonnage(hay);
  const catGoods = /GOODS\s*CARR|COMMERCIAL[\s-]*GOODS/.test(hay);
  const isGcv = /GCV|GOODS/.test(vt) || (catGoods && ton2 > 0);
  if (isGcv) {
    if (is3W) return 'GCV 3W';
    if (ton2 <= 2.0) return 'GCV <= 2.0';
    if (ton2 <= 2.5) return 'GCV > 2.0 <= 2.5';
    if (ton2 <= 3.0) return 'GCV > 2.5 <= 3.0';
    if (ton2 <= 3.5) return 'GCV > 3.0 <= 3.5';
    if (ton2 <= 7.5) return 'GCV > 3.5 <= 7.5';
    if (ton2 <= 12) return 'GCV > 7.5 <= 12';
    if (ton2 <= 20) return 'GCV > 12 <= 20';
    if (ton2 <= 35) return 'GCV > 20 <= 35';
    if (ton2 <= 45) return 'GCV > 35 <= 45';
    return 'GCV > 45';
  }
  if (/PCV|PASSENGER/.test(vt) || is3W) {
    if (/\b2\s*W\b|TWO\s*WHEEL/.test(hay)) return 'PCV 2W';
    if (is3W) return 'PCV 3W';
    if (seat >= 12) {   // bus
      const school = /SCHOOL/.test(hay) ? 'School' : 'Non School';
      const owner = /CORPORATE|COMPANY|\bLTD\b|\bPVT\b|STAFF/.test(hay) ? 'Corporate' : 'Individual';
      const band = seat <= 15 ? '12 to 15' : seat <= 30 ? '16 to 30' : seat <= 50 ? '31 to 50' : '> 50';
      return `PCV Bus ${school} ${owner} ${band}`;
    }
    return /SCHOOL/.test(hay) ? 'PCV 4W School' : 'PCV 4W Non School';
  }
  if (/MISC|MIS\b/.test(vt)) return 'Misc';
  return null;
}

// TATA CV "Incremental Rule" (sheet "Incremental Rule" of the June CV grid):
// the final payout = base rate + an INCREMENT (additive percentage points) keyed
// by Vehicle Class × the policy's IDV slab. The resolver historically returned
// only the base, running ~3pt low vs the operator on ~200 CV rows (e.g. Pune GCV
// base 40 + IDV 656100 [LCV 500-750k = +3] = 43). Applied here so the grid's own
// increment sheet is honoured. Slab caps (₹) → increment points, per class.
const CV_INCREMENT = {
  PCV:   [[50000, 0], [150000, 1], [300000, 2], [500000, 2.5], [750000, 3], [1000000, 4], [Infinity, 4]],
  LCV:   [[50000, 0], [150000, 1], [300000, 2], [500000, 2.5], [750000, 3], [1000000, 4], [Infinity, 4]],
  BUS:   [[50000, 0], [150000, 2], [300000, 3], [500000, 4], [750000, 4.5], [1000000, 4.5], [Infinity, 5]],
  MNHCV: [[50000, 0], [150000, 0.5], [300000, 1.5], [500000, 2.5], [750000, 3], [1000000, 3], [Infinity, 3]],
};
// Map the classifySeg() label → increment vehicle class. LCV = goods ≤ 7.5T,
// MNHCV = goods > 7.5T; PCV bus → BUS; other passenger → PCV. Misc/Tractor/
// Harvester/Trailer aren't in the increment sheet → no increment.
const MNHCV_SEG = new Set(['GCV > 7.5 <= 12', 'GCV > 12 <= 20', 'GCV > 20 <= 35', 'GCV > 35 <= 45', 'GCV > 45']);
function incrementClass(seg) {
  if (/^GCV/.test(seg)) return MNHCV_SEG.has(seg) ? 'MNHCV' : 'LCV';
  if (/^PCV Bus/.test(seg)) return 'BUS';
  if (/^PCV/.test(seg)) return 'PCV';
  return null;
}
function incrementPoints(seg, idv) {
  const cls = incrementClass(seg);
  const v = Number(idv);
  if (!cls || !(v > 0)) return 0;
  for (const [cap, pts] of CV_INCREMENT[cls]) if (v <= cap) return pts;
  return 0;
}

function fuelCat(f) {
  const u = norm(f);
  if (/DIESEL/.test(u)) return 'DIESEL';
  if (/CNG|LPG/.test(u)) return 'CNG';
  if (/ELECTRIC|\bEV\b|BATTERY/.test(u)) return 'ELECTRIC';
  return 'OTHER';
}
function ageBand(age) {
  const a = Number(age) || 0;
  if (a <= 0) return 'BRAND NEW';
  if (a <= 2) return '>=1<=2';
  if (a <= 6) return '>2<=6';
  return '>6';
}

function resolveTataCvRate(params) {
  const region = cvRegion(params);
  if (!region) return null;
  const seg = classifySeg(params);
  if (!seg) return null;
  const fc = fuelCat(params.fuelType);
  const section = (Number(params.odPremium) || 0) > 0 ? 'PACKAGE' : 'SATP';
  const ab = ageBand(params.vehicleAge);
  const nregion = norm(region);
  let best = null, bestScore = -1, bestKey = null;
  for (const row of rowsFor(params)) {
    if (norm(row.seg) !== norm(seg)) continue;
    // Region keys in config are inconsistently cased (city clusters UPPERCASE
    // "PUNE", state clusters Title-case) while cvRegion returns the cluster's
    // Title-case value ("Pune") — match case-insensitively so Pune/Mumbai/
    // Ahmedabad GCV resolve instead of falling through to the April card.
    const rk = Object.keys(row.rates).find((k) => norm(k) === nregion);
    if (!rk) continue;
    const rs = norm(row.section);
    if (rs !== 'ALL' && rs !== section) continue;
    const rf = norm(row.fuel);
    let fscore;
    if (rf === 'ALL') fscore = 0;
    else if (rf === 'DIESEL' && fc === 'DIESEL') fscore = 2;
    else if (rf === 'CNG' && fc === 'CNG') fscore = 2;
    else if (rf === 'ELECTRIC' && fc === 'ELECTRIC') fscore = 2;
    else if (rf === 'OTHER THAN DIESEL' && fc !== 'DIESEL') fscore = 1;
    else continue;
    const ra = norm(row.age);
    let ascore;
    if (ra === 'ALL') ascore = 0;
    else if (ra === ab) ascore = 2;
    else continue;
    const score = fscore + ascore;
    if (score > bestScore) { bestScore = score; best = row; bestKey = rk; }
  }
  if (!best) return null;
  const base = Number(best.rates[bestKey]);
  const inc = incrementPoints(seg, params.idv) / 100;   // points → fraction
  return +(base + inc).toFixed(4);
}

module.exports = { resolveTataCvRate, cvRegion, classifySeg };
