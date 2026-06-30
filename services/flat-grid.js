'use strict';

/**
 * Generic flat-grid loader + resolver. The durable replacement for hand-written
 * per-insurer CV/Car/TW resolvers: a grid that is a FLAT TABLE (one row per
 * region, dimensions in named columns — Business Type / Segment / Section /
 * Fuel / RTO / Age / Rate) is parsed generically and matched generically.
 *
 * What stays per-insurer (declared in config/flat_grids/<slug>.json):
 *   - column names (which header maps to biz/segment/section/fuel/region/age/rate)
 *   - how to resolve the policy's RTO to the grid's region label
 *   - a small SEGMENT classifier (tonnage bands / seat bands / keyword map / TW
 *     moped-scooter-bike) — the one irreducibly insurer-specific bit
 *
 * The extracted grid rows live in config/flat_grids/data/<slug>__<sheetId>.json
 * (refreshed by the same extractor at upload), so a new month = re-upload, no code.
 */
const fs = require('fs');
const path = require('path');

const CFG_DIR = path.join(__dirname, '..', 'config', 'flat_grids');
const DATA_DIR = path.join(CFG_DIR, 'data');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

// ---- per-insurer specs (loaded once) ----
const SPECS = {};
try {
  for (const f of fs.readdirSync(CFG_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { SPECS[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(CFG_DIR, f), 'utf8')); } catch (_) { /* skip bad config */ }
  }
} catch (_) { /* dir missing */ }

// extracted grid data cache (slug__sheetId -> rows)
const _dataCache = {};
function gridData(slug, sheetId) {
  const k = slug + '__' + sheetId;
  if (k in _dataCache) return _dataCache[k];
  try { _dataCache[k] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, k + '.json'), 'utf8')).rows; }
  catch (_) { _dataCache[k] = null; }
  return _dataCache[k];
}

/**
 * Extract a flat sheet (array-of-arrays from XLSX header:1) into normalized rows
 * using a sheet spec. Returns [{biz, segment, section, fuel, age, region, rate}].
 * Auto-detects the header row (first row containing the configured 'rate' and
 * 'region' column names) if header_row isn't given.
 */
function extractFlatGrid(rows, sheet) {
  const cols = sheet.columns || {};
  const want = Object.values(cols).map(norm);
  let hr = sheet.header_row;
  if (hr == null) {
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const hits = (rows[i] || []).filter((c) => want.includes(norm(c))).length;
      if (hits >= Math.min(3, want.length)) { hr = i; break; }
    }
  }
  if (hr == null) return [];
  const header = (rows[hr] || []).map(norm);
  const idx = {};
  for (const [role, name] of Object.entries(cols)) {
    const n = norm(name);
    let i = header.indexOf(n);                       // exact
    if (i < 0) i = header.findIndex((h) => h && h.includes(n));   // header contains the configured name ("Approval Grid" → "Approval Grid For OD")
    idx[role] = i;                                   // first match (rate-OD repeats — take first)
  }
  const out = [];
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const region = idx.region >= 0 ? String(r[idx.region] ?? '').trim() : '';
    const rateRaw = idx.rate >= 0 ? r[idx.rate] : null;
    if (!region || rateRaw === '' || rateRaw == null) continue;
    const rate = Number(rateRaw);
    if (!Number.isFinite(rate)) continue;
    out.push({
      biz: idx.biz >= 0 ? String(r[idx.biz] ?? '').trim() : '',
      segment: idx.segment >= 0 ? String(r[idx.segment] ?? '').trim() : '',
      section: idx.section >= 0 ? String(r[idx.section] ?? '').trim() : '',
      fuel: idx.fuel >= 0 ? String(r[idx.fuel] ?? '').trim() : '',
      age: idx.age >= 0 ? String(r[idx.age] ?? '').trim() : '',
      region, rate,
    });
  }
  return out;
}

/** Persist extracted rows (called at upload so future months self-refresh). */
function saveGridData(slug, sheetId, rows, sourceFile) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, slug + '__' + sheetId + '.json'),
      JSON.stringify({ _source: sourceFile || null, rows }, null, 0));
    delete _dataCache[slug + '__' + sheetId];
  } catch (_) { /* best effort */ }
}

// ---- generic dimension matchers ----
const fuelCat = (f) => {
  const u = norm(f);
  if (/DIESEL/.test(u)) return 'DIESEL';
  if (/CNG|LPG/.test(u)) return 'CNG';
  if (/ELECTRIC|\bEV\b|BATTERY/.test(u)) return 'ELECTRIC';
  return 'OTHER';
};
function fuelScore(rowFuel, fc) {
  const rf = norm(rowFuel);
  if (rf === '' || rf === 'ALL') return 0;
  if (rf === 'DIESEL' && fc === 'DIESEL') return 2;
  if (rf === 'CNG' && fc === 'CNG') return 2;
  if (rf === 'ELECTRIC' && fc === 'ELECTRIC') return 2;
  if (rf === 'OTHER THAN DIESEL' && fc !== 'DIESEL') return 1;
  if (rf === norm(fc)) return 2;
  return -1;
}
function ageBand(age) {
  const a = Number(age) || 0;
  if (a <= 0) return 'BRAND NEW';
  if (a <= 2) return '>=1<=2';
  if (a <= 6) return '>2<=6';
  return '>6';
}
function bizCat(params) {
  const b = norm(params.businessType);
  if (/ROLL/.test(b)) return 'ROLLOVER';
  if (/RENEW/.test(b)) return 'RENEWAL';
  if (/NEW/.test(b) || (Number(params.vehicleAge) || 0) === 0) return 'BRAND NEW';
  return 'RENEWAL';
}
function sectionCat(params) {
  const od = Number(params.odPremium) || 0;
  const tp = Number(params.tpPremium) || 0;
  if (od <= 0) return 'SATP';
  if (tp <= 0) return 'SAOD';
  return 'PACKAGE';
}

// ---- config-driven segment classifier ----
function classifySegment(spec, params) {
  const c = spec.classifier;
  if (!c || c.type === 'none') return null;   // grid has no segment dimension
  const hay = `${norm(params.vehicleCategory)} ${norm(params.model)} ${norm(params.make)}`;
  const seat = Number(params.seatingCapacity) || 0;
  const ton = Number(params.tonnage) || 0;
  if (c.type === 'tw') {
    if (/MOPED|\bTVS\s*XL\b|LUNA/.test(hay)) return 'Moped';
    if (/ACTIVA|JUPITER|FASCINO|ACCESS|DIO|BURGMAN|NTORQ|MAESTRO|AVIATOR|PLEASURE|VESPA|SCOOT|DESTINI|XOOM|\bRAY\b|ALPHA|CHETAK|IQUBE|ZEST/.test(hay)) return 'Scooter';
    return 'Bike';
  }
  if (c.type === 'keyword') {
    for (const [seg, re] of Object.entries(c.map || {})) if (new RegExp(re, 'i').test(hay)) return seg;
    return c.default || null;
  }
  if (c.type === 'tonnage') {
    for (const b of (c.bands || [])) if (ton <= b.max) return b.label;
    return (c.bands && c.bands.length) ? c.bands[c.bands.length - 1].label : null;
  }
  if (c.type === 'seat') {
    for (const b of (c.bands || [])) if (seat <= b.max) return b.label;
    return null;
  }
  return null;
}

function resolveRegion(spec, params) {
  const rr = spec.regionResolver || {};
  if (rr.type === 'tata_cluster') {
    const CLUSTER = require('../config/tata_rto_cluster.json');
    const code = norm(params.rtoCode).replace(/[^A-Z0-9]/g, '');
    const keys = [code];
    const m = code.match(/^([A-Z]+)(\d+)$/);
    if (m) keys.push(m[1] + String(parseInt(m[2], 10)).padStart(2, '0'), m[1] + parseInt(m[2], 10));
    for (const k of keys) { if (CLUSTER[k] && CLUSTER[k][rr.field]) return CLUSTER[k][rr.field]; }
    return null;
  }
  return null;
}

/** Resolve a policy's rate from the insurer's configured flat grids. */
function resolveFlatGridRate(insurerSlug, params) {
  const spec = SPECS[insurerSlug];
  if (!spec) return null;
  const vt = norm(params.vehicleType);
  for (const sheet of (spec.sheets || [])) {
    if ((sheet.products || []).length && !sheet.products.some((p) => norm(p) === vt)) continue;
    const rows = gridData(insurerSlug, sheet.id);
    if (!rows || !rows.length) continue;
    const region = resolveRegion(sheet, params);
    if (!region) continue;
    const seg = classifySegment(sheet, params);
    const biz = bizCat(params), section = sectionCat(params), fc = fuelCat(params.fuelType), ab = ageBand(params.vehicleAge);
    let best = null, bestScore = -1;
    for (const row of rows) {
      if (norm(row.region) !== norm(region)) continue;
      if (seg != null && row.segment && norm(row.segment) !== norm(seg)) continue;
      if (row.section && norm(row.section) !== section && norm(row.section) !== 'ALL') continue;
      if (row.biz && norm(row.biz) !== biz && norm(row.biz) !== 'ALL') continue;
      const fs2 = fuelScore(row.fuel, fc); if (fs2 < 0) continue;
      let as = 0;
      if (row.age && norm(row.age) !== 'ALL') { if (norm(row.age) === ab) as = 2; else continue; }
      const score = fs2 + as;
      if (score > bestScore) { bestScore = score; best = row; }
    }
    if (best) return +(Number(best.rate) / (sheet.rate_divisor || 1)).toFixed(4);
  }
  return null;
}

/**
 * On upload, refresh the flat-grid data for an insurer from its workbook: for
 * each configured sheet (matched by the `sheet` regex), extract + save the rows.
 * Returns a report [{id, sheet, rows}] so the upload can surface what refreshed.
 * Best-effort — never throws (the normal ingest already succeeded).
 */
function refreshFromWorkbook(insurerSlug, filePath) {
  const spec = SPECS[insurerSlug];
  if (!spec || !/\.xls/i.test(String(filePath || ''))) return [];
  const report = [];
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(filePath);
    for (const sheet of (spec.sheets || [])) {
      if (!sheet.sheet) continue;
      const re = new RegExp(sheet.sheet, 'i');
      const sn = wb.SheetNames.find((n) => re.test(String(n).trim()));
      if (!sn) continue;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
      const grid = extractFlatGrid(rows, sheet);
      if (grid.length) { saveGridData(insurerSlug, sheet.id, grid, sn); report.push({ id: sheet.id, sheet: sn, rows: grid.length }); }
    }
  } catch (_) { /* best effort */ }
  return report;
}

module.exports = { extractFlatGrid, saveGridData, resolveFlatGridRate, gridData, refreshFromWorkbook, SPECS };
