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

/** Normalise a cover token → COMP | SAOD | TP. */
function coverToRateType(v) {
  const s = cell(v).toLowerCase();
  if (/saod|\bsod\b/.test(s)) return 'SAOD';
  if (/satp|\btp\b|liability|\bact\b/.test(s)) return 'TP';
  if (/package|\bpkg\b|comp/.test(s)) return 'COMP';
  return null;
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
        make: 'All',
        _leg: leg.key,
      });
    }
  }
  return out;
}

module.exports = { resolveSchema, parseFlatGrid, HEADER_SYNONYMS };
