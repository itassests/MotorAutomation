'use strict';

/**
 * Dynamic, header-role grid resolver (P2 of the robustness architecture).
 *
 * Motive: insurers reship the same grid every month with the sheet layout
 * changed — columns renamed ("Approval Grid" → "Approval Grid For OD"),
 * reordered, or the whole sheet flipped from pivot-by-city to a flat table.
 * Static index/name configs then scramble the parse silently (the June-cycle
 * mispricing). This resolver classifies each column to a ROLE by header-synonym
 * AND value heuristics, so renames/reorders self-heal, and an unrecognised
 * layout is REPORTED (low confidence) instead of mis-parsed.
 *
 * It does not replace the bespoke engines; it is a robust default + a drift
 * detector the ingest gate (P1) and any flat sheet can call.
 *
 *   const { resolveSchema, parseFlatGrid } = require('./grid-schema-resolver');
 *   const schema = resolveSchema(rows);          // { headerRow, roles, confidence, notes }
 *   const rules  = parseFlatGrid(rows, schema, { insurer, product, rateDivisor });
 */

// ── Role vocabulary: header-name patterns (ordered specific→generic) ──────────
const HEADER_SYNONYMS = {
  rate_od: [/approval\s*grid\s*(for\s*)?od/i, /\bod\b.*(grid|rate|payout|po|%)/i, /(grid|rate|payout|po).*\bod\b/i, /own\s*damage.*(rate|grid|payout)/i],
  rate_tp: [/approval\s*grid\s*(for\s*)?tp/i, /\btp\b.*(grid|rate|payout|po|%)/i, /(grid|rate|payout|po).*\btp\b/i, /liability.*(rate|grid|payout)/i],
  rate:    [/approval\s*grid/i, /payout/i, /\bpo\b/i, /commission/i, /brokerage/i, /\brate\b/i, /\bgrid\b/i, /\bimd\b/i, /net\s*po/i],
  region:  [/^\s*rto\s*$/i, /region/i, /\bzone\b/i, /\bcity\b/i, /\bstate\b/i, /location/i, /cluster/i, /geography/i, /circle/i],
  cover:   [/section\s*text/i, /^\s*section\s*$/i, /\bcover\b/i, /policy\s*type/i, /coverage/i],
  segment: [/^\s*segment\s*$/i, /sub[\s_-]*type/i, /body\s*type/i, /vehicle\s*type/i, /\bveh\b/i],
  fuel:    [/fuel/i],
  ncb:     [/\bncb\b/i, /no\s*claim/i],
  biz:     [/business\s*type/i, /\bbiz\b/i, /new.*renew|renew.*new/i, /nb\s*\/?\s*renewal/i],
  make:    [/^\s*make\s*$/i, /manufacturer/i, /\boem\b/i, /make\s*(and|&)?\s*model|make\s*name/i],
  cc:      [/^\s*cc\b/i, /cubic|engine\s*cap|displacement/i],
  tonnage: [/tonnage|\bgvw\b|gross\s*weight|\bton\b|\btn\b/i],
  seating: [/seating|seat\s*cap|\bgvw?seat|carrying\s*cap/i],
  age:     [/\bage\b|vehicle\s*age|year.*band/i],
};

// ── Value vocabularies (used to confirm/repair a role from the data) ──────────
const COVER_VOCAB = /^(package|pkg|comp|comprehensive|saod|\bsod\b|satp|\btp\b|liability|\bact\b|\bod\b|bundled|1\s*\+\s*\d)$/i;
const SEGMENT_VOCAB = /moped|scooter|motor\s*cycle|\bmc\b|\bbike\b|3w|4w|two\s*wheel|goods|passenger|tractor|misc|crane|dumper|tipper|bus|taxi|auto/i;
const FUEL_VOCAB = /^(all|petrol|diesel|cng|lpg|electric|ev|hybrid|hev|battery|bifuel|inbuild|inbuilt|na|other(\s*than\s*diesel)?)$/i;
const BIZ_VOCAB = /^(new|brand\s*new|renewal|rollover|roll\s*over|used|old|nb)$/i;
const NCB_VOCAB = /^(yes|no|y|n|all|0|nil|20|25|35|45|50|>?0)$/i;

function cell(v) { return v == null ? '' : String(v).trim(); }
function isNumericish(v) { const s = cell(v).replace(/[%,\s]/g, ''); return s !== '' && Number.isFinite(Number(s)); }
function numVal(v) { return Number(cell(v).replace(/[%,\s]/g, '')); }

/** Score a role from a header string (0..1). */
function scoreHeader(header, role) {
  const h = cell(header);
  if (!h) return 0;
  const pats = HEADER_SYNONYMS[role] || [];
  for (let i = 0; i < pats.length; i++) if (pats[i].test(h)) return 1 - i * 0.06; // earlier pattern = stronger
  return 0;
}

/** Score a role from a column's sample values (0..1). */
function scoreValues(values, role) {
  const vals = values.map(cell).filter((v) => v !== '');
  if (!vals.length) return 0;
  const frac = (re) => vals.filter((v) => re.test(v)).length / vals.length;
  switch (role) {
    case 'cover':   return frac(COVER_VOCAB);
    case 'segment': return frac(SEGMENT_VOCAB);
    case 'fuel':    return frac(FUEL_VOCAB);
    case 'biz':     return frac(BIZ_VOCAB);
    case 'ncb':     return frac(NCB_VOCAB);
    case 'rate': case 'rate_od': case 'rate_tp': {
      const nums = vals.filter(isNumericish);
      if (nums.length / vals.length < 0.6) return 0;
      const inBand = nums.filter((v) => { const n = numVal(v); return n >= 0 && n <= 100; }).length / nums.length;
      return 0.5 * (nums.length / vals.length) + 0.5 * inBand;
    }
    case 'region': {
      // region = mostly non-numeric words, low cardinality relative to rows, not a cover/segment/fuel word
      const words = vals.filter((v) => !isNumericish(v) && !COVER_VOCAB.test(v) && !SEGMENT_VOCAB.test(v) && !FUEL_VOCAB.test(v) && !BIZ_VOCAB.test(v));
      return words.length / vals.length;
    }
    default: return 0;
  }
}

/** Find the header row: the row (in the first ~15) that best matches known role headers. */
function detectHeaderRow(rows) {
  let best = { row: 0, hits: -1 };
  const limit = Math.min(15, rows.length);
  for (let r = 0; r < limit; r++) {
    const cells = (rows[r] || []).map(cell);
    if (cells.filter((c) => c !== '').length < 3) continue;
    let hits = 0;
    for (const c of cells) for (const role in HEADER_SYNONYMS) if (scoreHeader(c, role) > 0) { hits++; break; }
    if (hits > best.hits) best = { row: r, hits };
  }
  return best.row;
}

/**
 * Resolve column roles. Combines header score (0.65) + value score (0.35) and
 * greedily assigns each role to its best column. Returns confidence so the
 * ingest gate can quarantine a low-confidence (drifted/unknown) layout.
 */
function resolveSchema(rows) {
  const headerRow = detectHeaderRow(rows);
  const headers = (rows[headerRow] || []).map(cell);
  const nCols = headers.length;
  const sample = rows.slice(headerRow + 1, headerRow + 41);
  const colValues = (c) => sample.map((row) => (row || [])[c]);

  // score[col][role]
  const scores = [];
  for (let c = 0; c < nCols; c++) {
    const vals = colValues(c);
    scores[c] = {};
    for (const role in HEADER_SYNONYMS) {
      const hs = scoreHeader(headers[c], role);
      const vs = scoreValues(vals, role);
      scores[c][role] = 0.65 * hs + 0.35 * vs;
    }
  }

  // Greedy assignment: strongest (col,role) first; each col and each single-slot
  // role used once. Rate roles can co-exist (od/tp/rate) but not on same col.
  const roles = {}; const usedCol = new Set();
  const pairs = [];
  for (let c = 0; c < nCols; c++) for (const role in scores[c]) if (scores[c][role] > 0.3) pairs.push({ c, role, s: scores[c][role] });
  pairs.sort((a, b) => b.s - a.s);
  for (const p of pairs) {
    if (usedCol.has(p.c)) continue;
    if (roles[p.role] != null) continue;
    roles[p.role] = p.c; usedCol.add(p.c);
  }

  // Confidence: did we resolve the essentials (a rate + region-or-national + cover-or-single)?
  const hasRate = roles.rate != null || roles.rate_od != null || roles.rate_tp != null;
  const essentials = [hasRate, roles.region != null || roles.cover != null].filter(Boolean).length;
  const avgTop = pairs.slice(0, Object.keys(roles).length || 1).reduce((a, p) => a + p.s, 0) / (Object.keys(roles).length || 1);
  const confidence = +(Math.min(1, (essentials / 2) * 0.6 + avgTop * 0.4)).toFixed(2);

  const notes = [];
  if (!hasRate) notes.push('no rate column resolved');
  if (roles.region == null) notes.push('no region column resolved (may be national)');
  return { headerRow, headers, roles, confidence, notes };
}

/** Cover token matcher — includes PACK/ACT which the value-vocab omits. */
const COVER_TOKEN = /^(package|pack|pkg|comp|comprehensive|saod|sod|satp|tp|act|od|liability|bundled|1\s*\+\s*\d)$/i;
function isCoverToken(v) { return COVER_TOKEN.test(cell(v)); }

/** Normalise a cover token → COMP | SAOD | TP. */
function coverToRateType(v) {
  const s = cell(v).toLowerCase();
  if (/saod|\bsod\b/.test(s)) return 'SAOD';
  if (/satp|\btp\b|liability|\bact\b/.test(s)) return 'TP';
  if (/package|\bpkg\b|\bpack\b|comp/.test(s)) return 'COMP';
  return null;
}

/** Normalise a fuel token → PETROL|DIESEL|CNG|ELECTRIC|... or '' (=any). */
function normFuel(v) {
  const s = cell(v).toLowerCase();
  if (!s || /^all|^any|^other/.test(s)) return '';
  if (/electric|\bev\b|battery/.test(s)) return 'ELECTRIC';
  if (/hybrid|\bhev\b/.test(s)) return 'HYBRID';
  if (/diesel/.test(s)) return 'DIESEL';
  if (/petrol/.test(s)) return 'PETROL';
  if (/cng|lpg|bifuel|inbuil/.test(s)) return 'CNG';
  return '';
}

/** Normalise a business-type token → NEW|RENEWAL|USED or '' (=any). */
function normBiz(v) {
  const s = cell(v).toLowerCase();
  if (/renew|roll\s*over|rollover/.test(s)) return 'RENEWAL';
  if (/brand\s*new|^new\b|^nb\b/.test(s)) return 'NEW';
  if (/used|old/.test(s)) return 'USED';
  return '';
}

/**
 * Parse a numeric band string → { min, max }. Handles "1000-1500", "1000 to 1500",
 * "Upto 1000"/"<=1000"/"<1000", ">1500"/"Above 1500"/"1500+", or a lone number
 * (exact→[n,n]). Returns nulls when nothing numeric is present.
 */
function parseBand(v) {
  const s = cell(v).toLowerCase().replace(/,/g, '');
  if (!s) return { min: null, max: null };
  let m;
  if ((m = s.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(-?\d+(?:\.\d+)?)/))) return { min: +m[1], max: +m[2] };
  if ((m = s.match(/(?:upto|up\s*to|<=|below|less\s*than|<)\s*(-?\d+(?:\.\d+)?)/))) return { min: null, max: +m[1] };
  if ((m = s.match(/(?:above|more\s*than|greater|>=|>)\s*(-?\d+(?:\.\d+)?)/)) ) return { min: +m[1], max: null };
  if ((m = s.match(/(-?\d+(?:\.\d+)?)\s*\+/))) return { min: +m[1], max: null };
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)$/))) return { min: +m[1], max: +m[1] };
  return { min: null, max: null };
}

/**
 * Parse a FLAT grid (one rule per row) using a resolved schema. Emits normalised
 * rule objects. Robust to which columns exist. rateDivisor 100 for whole-percent
 * sources. Only used for flat layouts — pivots keep their bespoke engines.
 */
function parseFlatGrid(rows, schema, opts = {}) {
  const { roles, headerRow } = schema;
  const div = opts.rateDivisor || 100;
  const out = [];
  const get = (row, role) => roles[role] != null ? row[roles[role]] : undefined;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const region = roles.region != null ? cell(get(row, 'region')) : 'PAN INDIA';
    const coverRaw = cell(get(row, 'cover'));
    const segment = cell(get(row, 'segment'));
    // A rate cell must exist; prefer explicit OD/TP, else the generic rate.
    const legs = [];
    if (roles.rate_od != null) legs.push({ key: 'OD', raw: get(row, 'rate_od') });
    if (roles.rate_tp != null) legs.push({ key: 'TP', raw: get(row, 'rate_tp') });
    if (!legs.length && roles.rate != null) legs.push({ key: '', raw: get(row, 'rate') });
    if (!region && !coverRaw && !segment) continue; // blank row

    const baseCover = coverToRateType(coverRaw);
    // Optional dimension columns — emitted only when their role was resolved.
    const fuel = roles.fuel != null ? normFuel(get(row, 'fuel')) : '';
    const biz = roles.biz != null ? normBiz(get(row, 'biz')) : '';
    const make = roles.make != null && cell(get(row, 'make')) ? cell(get(row, 'make')) : 'All';
    const ccB = roles.cc != null ? parseBand(get(row, 'cc')) : { min: null, max: null };
    const tonB = roles.tonnage != null ? parseBand(get(row, 'tonnage')) : { min: null, max: null };
    const seatB = roles.seating != null ? parseBand(get(row, 'seating')) : { min: null, max: null };
    const ageB = roles.age != null ? parseBand(get(row, 'age')) : { min: null, max: null };
    for (const leg of legs) {
      if (!isNumericish(leg.raw)) continue;
      const n = numVal(leg.raw);
      if (!Number.isFinite(n) || n <= 0) continue; // skip 0 / blank (declined handled elsewhere)
      // OD leg of a Package row = COMP-OD; TP leg = the TP cover; single rate = the row's cover.
      let rateType = baseCover || 'COMP';
      let appliedOn = 'NET';
      if (leg.key === 'OD') { rateType = baseCover === 'SAOD' ? 'SAOD' : 'COMP'; appliedOn = 'OD'; }
      else if (leg.key === 'TP') { rateType = 'TP'; appliedOn = 'TP'; }
      out.push({
        insurer: opts.insurer,
        product: opts.product,
        region: region || 'PAN INDIA',
        sub_type: segment || '',
        rate_type: rateType,
        rate_value: +(n / div).toFixed(6),
        applied_on: appliedOn,
        segment: segment || '',
        make,
        fuel_type: fuel,
        business_type: biz || undefined,
        cc_band_min: ccB.min, cc_band_max: ccB.max,
        weight_band_min: tonB.min, weight_band_max: tonB.max,
        seating_capacity_min: seatB.min, seating_capacity_max: seatB.max,
        vehicle_age_min: ageB.min, vehicle_age_max: ageB.max,
        _leg: leg.key, _srcRow: r,
      });
    }
  }
  return out;
}

// ── Matrix (cross-tab / tiled) layout ────────────────────────────────────────
// Many CV grids tile REGION across the top with a COVER sub-row (ACT/PACK/OD/TP)
// and carry vehicle dimensions down the left. The rate for a row lives in many
// columns, each meaning (region × cover) — a flat column→role map can't express
// it, so we detect the two header rows and UNPIVOT to one rule per data-cell.

/** Is a cell "region-ish" (a label, not a number / cover / fuel word)? */
function isRegionLabel(v) {
  const s = cell(v);
  return s !== '' && !isNumericish(s) && !isCoverToken(s) && !FUEL_VOCAB.test(s);
}

/**
 * Detect a tiled matrix layout. Returns a serialisable layout descriptor
 * { layout:'matrix', regionRow, coverRow, firstRateCol, rateCols, leftCols,
 *   segmentCol, makeCol, rate_divisor, confidence, notes } or null.
 */
function detectMatrix(rows) {
  const limit = Math.min(20, rows.length);
  // 1) cover sub-row = the row (in the head) with the most cover tokens (≥2).
  let coverRow = -1, coverCount = 1;
  for (let r = 0; r < limit; r++) {
    const cells = (rows[r] || []).map(cell);
    const cnt = cells.filter(isCoverToken).length;
    if (cnt >= 2 && cnt > coverCount) { coverCount = cnt; coverRow = r; }
  }
  if (coverRow < 0) return null;

  // 2) firstRateCol = leftmost column carrying a cover token; rateCols = all of them.
  const coverCells = (rows[coverRow] || []).map(cell);
  const rateCols = [];
  for (let c = 0; c < coverCells.length; c++) if (isCoverToken(coverCells[c])) rateCols.push(c);
  if (rateCols.length < 2) return null;
  const firstRateCol = rateCols[0];

  // 3) region row = the row at/above coverRow whose region labels sit in the
  //    rate-column band and are tiled (≥2 distinct, with blank gaps = merged).
  let regionRow = -1, regionScore = 0;
  for (let r = Math.max(0, coverRow - 3); r <= coverRow; r++) {
    const cells = (rows[r] || []).map(cell);
    const labels = rateCols.filter((c) => isRegionLabel(cells[c]));
    const distinct = new Set(labels.map((c) => cells[c].toUpperCase())).size;
    if (distinct >= 2 && distinct > regionScore) { regionScore = distinct; regionRow = r; }
  }
  // header row for the left dimension labels (may equal regionRow)
  const headerRow = regionRow >= 0 ? regionRow : Math.max(0, coverRow - 1);

  // 4) left dimension columns (before firstRateCol) that carry a header label.
  const headCells = (rows[headerRow] || []).map(cell);
  const leftCols = [];
  for (let c = 0; c < firstRateCol; c++) if (headCells[c] !== '') leftCols.push(c);
  // classify left columns → make / segment
  let makeCol = null, segmentCol = null, segScore = -1;
  for (const c of leftCols) {
    const h = headCells[c];
    if (makeCol == null && /make|manufact|oem/i.test(h)) { makeCol = c; continue; }
    // segment candidate: header hints OR values look like segment keys (a_b_c / tonnage)
    const vals = rows.slice(headerRow + 1, headerRow + 30).map((row) => cell((row || [])[c])).filter(Boolean);
    const segLike = vals.filter((v) => /_|gccv|pcv|lcv|gcv|upto|\dt\b|3w|4w|tractor|misc|bus|taxi/i.test(v)).length;
    const hintHdr = /sub.?class|segment|sub.?type|class|prod|body|type|model/i.test(h) ? vals.length * 0.5 : 0;
    const sc = segLike + hintHdr;
    if (sc > segScore) { segScore = sc; segmentCol = c; }
  }

  const rate_divisor = guessRateDivisorAt(rows, coverRow, rateCols);

  // confidence: tiled regions present + covers align + a segment column found.
  const hasRegion = regionRow >= 0;
  const conf = +(Math.min(1,
    0.4 * (hasRegion ? 1 : 0.4) +
    0.35 * Math.min(1, rateCols.length / 4) +
    0.25 * (segmentCol != null ? 1 : 0)).toFixed(2));
  const notes = [];
  if (!hasRegion) notes.push('tiled regions not found — treating as single-region matrix');
  if (segmentCol == null) notes.push('no segment/dimension column resolved');

  return {
    layout: 'matrix', regionRow, coverRow, firstRateCol, rateCols, leftCols,
    segmentCol, makeCol, rate_divisor, confidence: conf, notes,
    headers: headCells,
  };
}

/** Rate-divisor guess for an explicit set of columns (matrix rate cells). */
function guessRateDivisorAt(rows, headerRow, cols) {
  const nums = [];
  for (let r = headerRow + 1; r < rows.length && nums.length < 300; r++) {
    const row = rows[r]; if (!row) continue;
    for (const c of cols) if (isNumericish(row[c])) nums.push(numVal(row[c]));
  }
  if (!nums.length) return 100;
  const frac = nums.filter((n) => n > 0 && n <= 1).length / nums.length;
  return frac > 0.7 ? 1 : 100;
}

/** Unpivot a matrix layout → one rule per (data row × region×cover cell). */
function parseMatrixGrid(rows, layout, opts = {}) {
  const { regionRow, coverRow, rateCols, leftCols, segmentCol, makeCol } = layout;
  const div = layout.rate_divisor || 100;
  const coverCells = (rows[coverRow] || []).map(cell);
  const regionCells = (rows[regionRow >= 0 ? regionRow : coverRow] || []).map(cell);
  // forward-fill region labels rightward across the rate band (merged headers)
  const regionOf = {}; let curRegion = '';
  const maxCol = Math.max(regionCells.length, coverCells.length);
  for (let c = rateCols[0]; c < maxCol; c++) {
    if (regionCells[c] && isRegionLabel(regionCells[c])) curRegion = regionCells[c].trim();
    regionOf[c] = curRegion;
  }
  const out = [];
  const ff = {}; leftCols.forEach((c) => (ff[c] = ''));   // forward-fill down (merged dim cells)
  for (let r = coverRow + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    if (row.map(cell).every((c) => c === '')) continue;
    leftCols.forEach((c) => { const v = cell(row[c]); if (v !== '') ff[c] = v; });
    const segment = segmentCol != null ? (cell(row[segmentCol]) || ff[segmentCol]) : '';
    const make = makeCol != null && cell(row[makeCol]) ? cell(row[makeCol]) : 'All';
    for (const c of rateCols) {
      if (!isNumericish(row[c])) continue;
      const n = numVal(row[c]);
      if (!Number.isFinite(n) || n <= 0) continue;   // 0 / IRDA / blank = declined-or-missing
      const rateType = coverToRateType(coverCells[c]) || 'COMP';
      out.push({
        insurer: opts.insurer,
        product: opts.product,
        region: regionOf[c] || 'PAN INDIA',
        segment,
        sub_type: segment,
        make,
        rate_type: rateType,
        rate_value: +(n / div).toFixed(6),
        applied_on: rateType === 'TP' ? 'TP' : 'NET',
        _srcRow: r, _region_col: c,
      });
    }
  }
  return out;
}

/**
 * Guess whether rate cells are whole-percent (45 → divisor 100) or already
 * fractions (0.45 → divisor 1). Samples the resolved rate column(s).
 */
function guessRateDivisor(rows, schema) {
  const { roles, headerRow } = schema;
  const rateCols = ['rate', 'rate_od', 'rate_tp'].map((r) => roles[r]).filter((c) => c != null);
  if (!rateCols.length) return 100;
  const nums = [];
  for (let r = headerRow + 1; r < rows.length && nums.length < 200; r++) {
    const row = rows[r]; if (!row) continue;
    for (const c of rateCols) if (isNumericish(row[c])) nums.push(numVal(row[c]));
  }
  if (!nums.length) return 100;
  const frac = nums.filter((n) => n > 0 && n <= 1).length / nums.length;
  return frac > 0.7 ? 1 : 100;   // mostly ≤1 → already fractions
}

/**
 * Build a SERIALISABLE parse profile for a sheet: the resolved schema plus the
 * detected rate divisor and header labels. Persisted per rate_card+sheet so a
 * re-parse is reproducible and a human can review/correct the column→role map.
 */
function buildProfile(rows, opts = {}) {
  const schema = resolveSchema(rows);
  const flat = {
    layout: 'flat',
    header_row: schema.headerRow,
    headers: schema.headers,
    roles: schema.roles,              // { role: columnIndex } — the editable mapping
    confidence: schema.confidence,
    notes: schema.notes,
    rate_divisor: guessRateDivisor(rows, schema),
  };
  const matrix = detectMatrix(rows);
  // Prefer matrix when it's confidently tiled: a flat resolve of a cross-tab
  // either finds no rate column or covers a tiny fraction of rows, so matrix
  // wins whenever it detected ≥2 rate columns and isn't clearly weaker.
  let chosen = flat;
  if (matrix && matrix.rateCols.length >= 2 && matrix.confidence >= flat.confidence - 0.1) {
    // sanity: matrix must actually emit more rules than flat, else keep flat
    const flatN = parseFlatGrid(rows, schema, opts).length;
    const matN = parseMatrixGrid(rows, matrix, opts).length;
    if (matN > flatN) chosen = matrix;
  }
  chosen.sheet_name = opts.sheet_name || null;
  return chosen;
}

/** Reconstruct the resolveSchema-shaped object from a persisted profile. */
function schemaFromProfile(profile) {
  return { roles: profile.roles || {}, headerRow: profile.header_row || 0, headers: profile.headers || [] };
}

/** Parse a sheet using a (possibly human-corrected) persisted profile. */
function parseWithProfile(rows, profile, opts = {}) {
  if (profile.layout === 'matrix') return parseMatrixGrid(rows, profile, opts);
  return parseFlatGrid(rows, schemaFromProfile(profile), {
    ...opts,
    rateDivisor: profile.rate_divisor || 100,
  });
}

/**
 * Health of a profile against its sheet — used by the confidence gate to flag a
 * card for human review instead of letting a drifted layout parse to junk.
 *   dataRows   = non-empty rows below the header
 *   rulesOut   = rules emitted
 *   emptyRate  = data rows whose rate cell was blank/non-numeric (the null-rate
 *                symptom seen in Chola 39% / Bajaj CV 58%)
 *   coverage   = rulesOut / dataRows  (≈1 healthy, low = drift/mis-map)
 */
function profileHealth(rows, profile, opts = {}) {
  const rules = parseWithProfile(rows, profile, opts);
  const rulesOut = rules.length;
  // header boundary: flat = header_row; matrix = coverRow (data starts below it)
  const headerR = profile.layout === 'matrix' ? profile.coverRow : (profile.header_row || 0);
  let dataRows = 0;
  for (let r = headerR + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    if (row.map(cell).every((c) => c === '')) continue;
    dataRows++;
  }
  // rows that yielded ≥1 rule (works for both layouts via _srcRow tag)
  const rowsWithRule = new Set(rules.map((x) => x._srcRow)).size;
  const emptyRows = Math.max(0, dataRows - rowsWithRule);
  return {
    layout: profile.layout || 'flat',
    dataRows,
    rulesOut,
    rowsWithRule,
    emptyRate: emptyRows,
    emptyRatePct: dataRows ? +(emptyRows / dataRows).toFixed(3) : 0,
    coverage: dataRows ? +(Math.min(1, rowsWithRule / dataRows).toFixed(3)) : 0,
    confidence: profile.confidence,
  };
}

module.exports = {
  resolveSchema, parseFlatGrid, HEADER_SYNONYMS,
  buildProfile, schemaFromProfile, parseWithProfile, profileHealth,
  guessRateDivisor, parseBand, normFuel, normBiz, coverToRateType,
  detectMatrix, parseMatrixGrid, isCoverToken,
};
