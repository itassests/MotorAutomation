/**
 * Future Generali — CV IMD payout grid + RTO blocked + Auto Kerala RTOs.
 *
 * Sheet kinds:
 *   'fg_cv_imd'      — IMD Sheet: Weight × State × Zone × OD + TP rates
 *                      (uses wef 10thFeb2026 TP columns as current).
 *   'fg_cv_rto'      — RTO Blocked: Category × RTA Code × District → Doable/Blocked
 *   'fg_auto_kerala' — Per-Kerala-RTO slab rate (overrides Auto rate for Kerala)
 *
 * Column layout for IMD Sheet (zero-indexed):
 *   0  Weight          (segment: 12K-20K, BOLERO, Auto, Tractor, School Bus, ...)
 *   1  Region          (state)
 *   2  GCI State       (mirror of Region)
 *   3  GCI Zone        (AP & TELANGANA / CENTRAL / EAST / NORTH 1 / NORTH 2 / ...)
 *   4  Operate         ("Yes" / "No ")
 *   5  OD Out flow     (numeric, fraction)
 *   6  TP Outflow <50K wef 1stFeb2026          ← LEGACY
 *   7  TP Outflow 50K-2L wef 1stFeb2026         ← LEGACY
 *   8  TP Outflow >2L wef 1stFeb2026            ← LEGACY
 *   9  TP Outflow <50K wef 10thFeb2026          ← CURRENT
 *   10 TP Outflow 50K-2L wef 10thFeb2026        ← CURRENT
 *   11 TP Outflow >2L wef 10thFeb2026           ← CURRENT
 *   12 RTOs Blocked    (text — "Refer RTO sheet" / "Refer RTO Blocked sheet - <region>")
 *   13 Remarks         (free text)
 *   14 Changes Version (text — version tag)
 */

const SEGMENT_META = {
  // (segment) → product / vehicle_category / weight_band(Tons) / cc_band
  'Auto':            { product: 'PCV', vehicle_category: 'Auto',           weight_band_min: null, weight_band_max: null },
  '3W GCV':          { product: 'GCV', vehicle_category: 'GCV 3W',         weight_band_min: null, weight_band_max: null },
  'Below 2.5 Tons':  { product: 'GCV', vehicle_category: 'GCV 4W upto 2.5T', weight_band_min: 0,   weight_band_max: 2.5 },
  'Below 3.5 Tons':  { product: 'GCV', vehicle_category: 'GCV 4W upto 3.5T', weight_band_min: 0,   weight_band_max: 3.5 },
  '3.5K-7.5K':       { product: 'GCV', vehicle_category: 'GCV 4W',          weight_band_min: 3.5, weight_band_max: 7.5 },
  '7.5K-12K':        { product: 'GCV', vehicle_category: 'GCV 4W',          weight_band_min: 7.5, weight_band_max: 12 },
  '12K-20K':         { product: 'GCV', vehicle_category: 'GCV 4W',          weight_band_min: 12,  weight_band_max: 20 },
  '20K-40K':         { product: 'GCV', vehicle_category: 'GCV 4W',          weight_band_min: 20,  weight_band_max: 40 },
  '40k +':           { product: 'GCV', vehicle_category: 'GCV 4W',          weight_band_min: 40,  weight_band_max: null },
  'BOLERO':          { product: 'GCV', vehicle_category: 'BOLERO',          weight_band_min: null, weight_band_max: null, make: 'Mahindra', model: 'Bolero' },
  'Tractor':         { product: 'MIS', vehicle_category: 'Tractor',         weight_band_min: null, weight_band_max: null },
  'School Bus':      { product: 'PCV', vehicle_category: 'School Bus',      weight_band_min: null, weight_band_max: null },
  'Taxi':            { product: 'PCV', vehicle_category: 'Taxi',            weight_band_min: null, weight_band_max: null },
};

// TP premium bands (Lakhs).  Map to volume_tier text labels for export.
const TP_BANDS = [
  { col10: 9,  label: '<50K',    pmin: 0,    pmax: 0.5 },     // <50k = 0-0.5 Lakhs
  { col10: 10, label: '50K-2L',  pmin: 0.5,  pmax: 2 },
  { col10: 11, label: '>2L',     pmin: 2,    pmax: null },
];

function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseRate(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function isOperate(cell) {
  const s = String(cell || '').trim().toLowerCase();
  return s === 'yes';
}

// --------------- IMD Sheet ---------------
function parseImd(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const seg = cellOrNull(row[0]);
    const state = cellOrNull(row[1]);
    if (!seg || !state) continue;

    const segMeta = SEGMENT_META[seg];
    if (!segMeta) {
      // Unknown segment — skip with a warning so we don't silently miss data
      console.warn(`[future-generali] unknown segment "${seg}" at row ${r+1}`);
      continue;
    }

    const zone = cellOrNull(row[3]);
    const operate = isOperate(row[4]);
    const odRate = parseRate(row[5]);
    const rtoCol = cellOrNull(row[12]);
    const remark = [
      operate ? null : 'Operate=No (declined)',
      rtoCol ? rtoCol : null,
      cellOrNull(row[13]),
      cellOrNull(row[14]),
    ].filter(Boolean).join(' | ') || null;

    const base = {
      product: segMeta.product,
      sheet_name: meta.sheetName,
      region: state,
      state: state,
      carrier_type: zone,
      segment: segMeta.vehicle_category,
      make: segMeta.make || 'All',
      model: segMeta.model || null,
      weight_band_min: segMeta.weight_band_min,
      weight_band_max: segMeta.weight_band_max,
      remarks: remark,
      rate_text: `${seg} | ${state}${zone ? ' | ' + zone : ''}`,
    };

    if (!operate) {
      // Declined: emit one declined rule per product so the export shows
      // the state as no-payout for COMP / SAOD / TP.
      for (const rt of ['COMP', 'SAOD', 'TP']) {
        rules.push({ ...base, rate_type: rt, rate_value: null, is_declined: true });
      }
      continue;
    }

    // SAOD — OD rate only (SAOD is OD-only product).
    if (odRate != null) {
      rules.push({
        ...base,
        rate_type: 'SAOD',
        applied_on: 'OD',
        rate_value: odRate,
        is_declined: false,
      });
    }

    // TP — one rule per premium band (uses wef 10thFeb2026 columns).
    for (const band of TP_BANDS) {
      const rate = parseRate(row[band.col10]);
      if (rate == null) continue;
      rules.push({
        ...base,
        rate_type: 'TP',
        applied_on: 'TP',
        rate_value: rate,
        is_declined: false,
        volume_tier: band.label,
        remarks: (remark ? remark + ' | ' : '') + `TP band ${band.label} (wef 10Feb26)`,
      });
    }

    // COMP — per premium band, emit OD half + TP half so the export's
    // mergeOdTpPairs combines them into ONE COMP row per band with both
    // OD Rate and TP Rate columns populated.
    for (const band of TP_BANDS) {
      const tpRate = parseRate(row[band.col10]);
      if (odRate == null && tpRate == null) continue;
      const common = {
        ...base,
        rate_type: 'COMP',
        volume_tier: band.label,
        is_declined: false,
        remarks: (remark ? remark + ' | ' : '') + `COMP band ${band.label} (wef 10Feb26)`,
      };
      if (odRate != null) {
        rules.push({ ...common, applied_on: 'OD', rate_value: odRate });
      }
      if (tpRate != null) {
        rules.push({ ...common, applied_on: 'TP', rate_value: tpRate });
      }
    }
  }
  return rules;
}

// --------------- RTO Blocked sheet ---------------
//
// Layout (R1 header):
//   Category | RTA Code | District | State | Zone | Doable / Blocked
//
// We only emit DECLINED rules (Blocked rows) because the doable rows are
// implied by the IMD Sheet base rule.  This keeps rule count manageable
// (23k → ~half).  Per row → one declined rule scoped to (segment × RTO).
function parseRtoBlocked(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const category = cellOrNull(row[0]);
    const rta = cellOrNull(row[1]);
    const district = cellOrNull(row[2]);
    const state = cellOrNull(row[3]);
    const zone = cellOrNull(row[4]);
    const status = cellOrNull(row[5]);
    if (!category || !rta || !state || !status) continue;
    if (!/blocked/i.test(status)) continue;     // only emit blocked rows

    const segMeta = SEGMENT_META[category];
    if (!segMeta) continue;        // unknown category — skip silently (RTO sheet is voluminous)

    rules.push({
      product: segMeta.product,
      sheet_name: meta.sheetName,
      region: district || state,
      state: state,
      sub_type: rta,                 // RTO code → RTOCode column via export
      carrier_type: zone,
      segment: segMeta.vehicle_category,
      make: segMeta.make || 'All',
      model: segMeta.model || null,
      weight_band_min: segMeta.weight_band_min,
      weight_band_max: segMeta.weight_band_max,
      rate_type: 'COMP',
      rate_value: null,
      is_declined: true,
      remarks: `Blocked RTO (${rta})`,
      rate_text: `${category} | ${rta} | ${district} | Blocked`,
    });
  }
  return rules;
}

// --------------- Auto Kerala RTO codes sheet ---------------
//
// Layout (R0 header): DISTRICT | LOCATION | RTO CODE | Group Slab | New Slab
//   "New Slab" is the current Auto rate for that Kerala RTO.
function parseAutoKerala(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const district = cellOrNull(row[0]);
    const rto = cellOrNull(row[2]);
    const slab = cellOrNull(row[3]);
    const rate = parseRate(row[4]);
    if (!rto || rate == null) continue;

    const segMeta = SEGMENT_META['Auto'];
    rules.push({
      product: segMeta.product,
      sheet_name: meta.sheetName,
      region: district || 'KERALA',
      state: 'KERALA',
      sub_type: rto,
      segment: segMeta.vehicle_category,
      make: 'All',
      rate_type: 'COMP',
      applied_on: 'OD',
      rate_value: rate,
      is_declined: false,
      volume_tier: slab,
      remarks: `Kerala Auto ${slab || ''}`.trim() || null,
      rate_text: `Kerala Auto | ${rto} | ${district || ''}`,
    });
  }
  return rules;
}

function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind || sheetConfig.kind;
  switch (kind) {
    case 'fg_cv_imd':      return parseImd(sheetData, sheetConfig, meta);
    case 'fg_cv_rto':      return parseRtoBlocked(sheetData, sheetConfig, meta);
    case 'fg_auto_kerala': return parseAutoKerala(sheetData, sheetConfig, meta);
    default:
      console.warn(`[future-generali] unknown sheet_kind: ${kind}`);
      return [];
  }
}

module.exports = { parse, SEGMENT_META };
