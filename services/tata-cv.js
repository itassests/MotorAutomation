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
const { rows } = require('../config/tata_cv_jun26.json');
const CLUSTER = require('../config/tata_rto_cluster.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

function cvRegion(params) {
  const code = norm(params.rtoCode).replace(/[^A-Z0-9]/g, '');
  if (!code) return null;
  const keys = [code];
  const m = code.match(/^([A-Z]+)(\d+)$/);
  if (m) keys.push(m[1] + String(parseInt(m[2], 10)).padStart(2, '0'), m[1] + parseInt(m[2], 10));
  for (const k of keys) { if (CLUSTER[k] && CLUSTER[k].cv) return CLUSTER[k].cv; }
  return null;
}

function classifySeg(params) {
  const vt = norm(params.vehicleType);
  const ton = Number(params.tonnage) || 0;
  const seat = Number(params.seatingCapacity) || 0;
  const hay = `${norm(params.vehicleCategory)} ${norm(params.model)} ${norm(params.make)}`;
  const is3W = /\b3\s*W\b|THREE\s*WHEEL|RICKSHAW|RIKSHAW|E-?RICK|\bAUTO\b/.test(hay) ||
    (seat > 0 && seat <= 4 && /PCV|PASSENGER/.test(vt));
  if (/TRACTOR/.test(hay)) return 'Tractor';
  if (/HARVEST/.test(hay)) return 'Harvester';
  if (/TRAILER/.test(hay)) return 'Trailer';
  if (/GCV|GOODS/.test(vt)) {
    if (is3W) return 'GCV 3W';
    if (ton <= 2.0) return 'GCV <= 2.0';
    if (ton <= 2.5) return 'GCV > 2.0 <= 2.5';
    if (ton <= 3.0) return 'GCV > 2.5 <= 3.0';
    if (ton <= 3.5) return 'GCV > 3.0 <= 3.5';
    if (ton <= 7.5) return 'GCV > 3.5 <= 7.5';
    if (ton <= 12) return 'GCV > 7.5 <= 12';
    if (ton <= 20) return 'GCV > 12 <= 20';
    if (ton <= 35) return 'GCV > 20 <= 35';
    if (ton <= 45) return 'GCV > 35 <= 45';
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
  let best = null, bestScore = -1;
  for (const row of rows) {
    if (norm(row.seg) !== norm(seg)) continue;
    if (!(region in row.rates)) continue;
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
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return best ? +Number(best.rates[region]).toFixed(4) : null;
}

module.exports = { resolveTataCvRate, cvRegion, classifySeg };
