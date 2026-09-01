'use strict';
/**
 * Generate Sept'26 Go Digit CV + HCV configs from the Sept "Large Broker Grid"
 * workbook (card 692). Sheets:
 *   - "New CV Format": Segment|Body|RTO Cluster|Make|CD1| COMP[Avg CD2 5-12, Max CD2 13-20] | SATP[Avg 21-28, Max 29-36]
 *   - "HCV Grid OLD" : region-tiled; row cols c1 Cluster, c2 Segment, c3 Make, c4 AgeFrom, c5 AgeTo,
 *                      body blocks Non-Dumper(6-10) Dumper(11-15) Oil(16-20) Gas(21-25); each CD1|AvgComp|MaxComp|AvgSatp|MaxSatp.
 * Output shape mirrors config/go_digit_cv_jun26.json and _hcv_jun26.json so the
 * existing resolvers work unchanged. Rates stored as PERCENTS.
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'uploads', '1788244440236_Large_Broker_Grid_Sep_26_-_Communication__001_.xlsx');
const wb = XLSX.readFile(SRC);

// Merge rows into `grid` under a case-insensitive canonical key so region
// case-variants ("MUMBAI" vs "Mumbai") don't collide when the resolver upper-
// cases the key (which dropped one block). Keeps the first-seen display spelling.
function pushRegion(grid, canon, region, rowsToAdd) {
  const uk = String(region).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  let key = canon.get(uk);
  if (!key) { key = String(region).trim(); canon.set(uk, key); grid[key] = grid[key] || []; }
  grid[key].push(...rowsToAdd);
}

// cell → percent | 'D'(decline→null) | amb('/') | null(blank)
function parseCell(v) {
  if (v == null || v === '') return { val: null, amb: false };
  const s = String(v).trim();
  if (!s) return { val: null, amb: false };
  if (/^d$|decline|declined|no\s*business|nb\b/i.test(s)) return { val: null, amb: false };
  if (s.includes('/') && !/^\d/.test(s)) return { val: null, amb: true };
  // a "0.475 / 0.5"-style ambiguous cell
  if (/\d\s*\/\s*\d/.test(s)) return { val: null, amb: true };
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || s.replace(/[0-9.\s%]/g, '') !== '') {
    // text (a note) → not a rate
    if (!/^\d*\.?\d+%?$/.test(s)) return { val: null, amb: false };
  }
  if (!Number.isFinite(n)) return { val: null, amb: false };
  return { val: n <= 1 ? +(n * 100).toFixed(4) : n, amb: false };
}

// ---------- CV ----------
function genCV() {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['New CV Format'], { header: 1, defval: '' });
  const AGES = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 10], [11, 99]];
  const grid = {};
  const canon = new Map();
  let n = 0;
  for (let i = 5; i < rows.length; i++) {
    const r = rows[i];
    const seg = String(r[0] || '').trim();
    const region = String(r[2] || '').trim();
    const make = String(r[3] || '').trim() || 'All';
    if (!seg || !region) continue;
    if (/^segment$/i.test(seg) || /^region$/i.test(region)) continue;
    // build per-age comp/satp
    const cells = [];
    for (let a = 0; a < 8; a++) {
      const comp = parseCell(r[13 + a]);   // Max CD2 comprehensive
      const satp = parseCell(r[29 + a]);   // Max CD2 SATP
      cells.push({ comp, satp });
    }
    if (cells.every((c) => c.comp.val == null && c.satp.val == null && !c.comp.amb && !c.satp.amb)) continue;
    // collapse consecutive equal age bands
    const out = [];
    for (let a = 0; a < 8; a++) {
      const c = cells[a];
      const sig = `${c.comp.val}|${c.satp.val}|${c.comp.amb || c.satp.amb}`;
      const prev = out[out.length - 1];
      if (prev && prev.sig === sig) { prev.ageMax = AGES[a][1]; }
      else out.push({ ageMin: AGES[a][0], ageMax: AGES[a][1], compMax: c.comp.val, satpMax: c.satp.val, amb: !!(c.comp.amb || c.satp.amb), sig });
    }
    const toAdd = [];
    for (const o of out) {
      if (o.compMax == null && o.satpMax == null && !o.amb) continue;
      toAdd.push({ segment: seg, rawSeg: seg, make, ageMin: o.ageMin, ageMax: o.ageMax, compMax: o.compMax, satpMax: o.satpMax, amb: o.amb });
      n++;
    }
    if (toAdd.length) pushRegion(grid, canon, region, toAdd);
  }
  return { _source: "Large Broker Grid Sep'26 - Communication (001).xlsx / 'New CV Format'. Max CD2: comp cols13-20, SATP cols29-36 by age New/1/2/3/4/5/6-10/11+.", grid, _n: n, _regions: Object.keys(grid).length };
}

// ---------- HCV ----------
function genHCV() {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['HCV Grid OLD'], { header: 1, defval: '' });
  // body block Max-CD2 columns: nonDumper comp=8 satp=10; dumper comp=13 satp=15; oil comp=18 satp=20; gas comp=23 satp=25
  const BODY = { nonDumper: [8, 10], dumper: [13, 15], oil: [18, 20], gas: [23, 25] };
  const grid = {};
  const merged = {};   // canonRegionKey → { display, entries: {seg|from|to → entry} }
  const canon = new Map();
  for (let i = 4; i < rows.length; i++) {
    const r = rows[i];
    const region = String(r[1] || '').trim();
    const seg = String(r[2] || '').trim();
    if (!region || /^cluster$/i.test(region) || !seg || /^segment$/i.test(seg)) continue;
    const from = Number(r[4]), to = Number(r[5]);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const makeRaw = String(r[3] || 'All').trim();
    const isTata = /^tata$/i.test(makeRaw);
    const isExceptTata = /except\s*tata|non[\s-]?tata/i.test(makeRaw);
    const isAll = !isTata && !isExceptTata;   // "All" (or unspecified)
    const uk = region.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!canon.has(uk)) canon.set(uk, region);
    const rkey = canon.get(uk);
    const key = `${seg}||${from}||${to}`;
    merged[rkey] = merged[rkey] || {};
    let e = merged[rkey][key];
    if (!e) {
      e = { segment: seg, ageFrom: from, ageTo: to, bodies: {} };
      for (const b of Object.keys(BODY)) e.bodies[b] = { comp: { tata: null, other: null }, satp: { tata: null, other: null } };
      merged[rkey][key] = e;
    }
    for (const b of Object.keys(BODY)) {
      const [cc, sc] = BODY[b];
      const comp = parseCell(r[cc]).val;
      const satp = parseCell(r[sc]).val;
      if (isAll || isTata) { if (comp != null) e.bodies[b].comp.tata = comp; if (satp != null) e.bodies[b].satp.tata = satp; }
      if (isAll || isExceptTata) { if (comp != null) e.bodies[b].comp.other = comp; if (satp != null) e.bodies[b].satp.other = satp; }
    }
  }
  let n = 0;
  for (const region of Object.keys(merged)) {
    grid[region] = Object.values(merged[region]);
    n += grid[region].length;
  }
  return { _source: "Large Broker Grid Sep'26 - Communication (001).xlsx / 'HCV Grid OLD'. Max CD2 per body-type block; tata/other from Make col.", grid, _n: n, _regions: Object.keys(grid).length };
}

const cv = genCV();
const hcv = genHCV();
fs.writeFileSync(path.join(__dirname, '..', 'config', 'go_digit_cv_sep26.json'), JSON.stringify({ _source: cv._source, grid: cv.grid }));
fs.writeFileSync(path.join(__dirname, '..', 'config', 'go_digit_hcv_sep26.json'), JSON.stringify({ _source: hcv._source, grid: hcv.grid }));
console.log('CV : regions=' + cv._regions + ' rows=' + cv._n);
console.log('HCV: regions=' + hcv._regions + ' rows=' + hcv._n);
// sanity: Mumbai GCV3 + a Good UK HCV
console.log('CV MUMBAI GCV3:', JSON.stringify((cv.grid['MUMBAI'] || []).filter((x) => x.segment === 'GCV3')));
console.log('HCV Good UK 12-20T:', JSON.stringify((hcv.grid['Good UK'] || []).filter((x) => /12 to 20/.test(x.segment)).slice(0, 2)));
