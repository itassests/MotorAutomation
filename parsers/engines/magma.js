/**
 * Magma HDI General Insurance — Motor commission engine (w.e.f. 08-Apr-2026).
 *
 * Source files:
 *   1. Comprehensive Grid xlsx (4 sheets by sum-insured band):
 *        '< =5 lac' | '>5 to <=18' | '>18 to <=30' | '> 30 lac'
 *      Each: 114 clusters × ~49 vehicle sub-categories.
 *   2. SATP Grid xlsb (2 sheets by premium band):
 *        '<=2 Lacs' | '>2 Lacs'
 *      Each: 114 clusters × 35 vehicle sub-categories (all TP-only).
 *
 * Row layout:
 *   row 1 = Biz Mix (top-level vehicle category)
 *   row 2 = Budget Mix (full sub-variant label) ← we use this
 *   row 3 = "UW Cluster/Outgo on GWP" marker
 *   rows 4-117 = cluster code (col 0) × rate values (cols 1+)
 *
 * Cell semantics:
 *   - Numeric (e.g. 17.5) → commission % on GWP, emit as applied_on='NET'
 *     (Netpoint column).
 *   - "IRDA" (Comp only) → IRDA-minimum brokerage: 19.5% OD + 2.5% TP, emit
 *     as COMP rule with OD half + TP half (separate rules).
 *   - "Block" (SATP only) → blocked / declined, emit at 0% with is_declined=true.
 *
 * Sum-Insured band → volume_tier on each rule (→ Min/Max Discount columns).
 *
 * Cluster code → region. State is derived from the workbook's "RTO Vs
 * Cluster" sheet (predominant state for the cluster's RTO list).
 *
 * Entry: parse(sheetData, sheetConfig, meta) → rule[]
 */

const XLSX = require('xlsx');

// ----------------------------------------------------------------------------
// Sum-insured / premium band labels keyed by sheet name. The value is a
// short label dropped into volume_tier (→ Discount Min/Max columns) and
// also into rule remarks for clarity.
// ----------------------------------------------------------------------------
// Labels emitted in `volume_tier` must match the export's parseVolumeBand
// patterns ("Upto NL" / "NL-ML" / "Above NL") so the MinimumVolume and
// MaximumVolume columns populate in lakhs.
const SI_BAND_LABELS = {
  // Comp sheets — SI band in lakhs
  '< =5 lac':    { label: 'Upto 5L',  tier_min: 0,   tier_max: 5,   kind: 'comp' },
  '>5 to <=18':  { label: '5L-18L',   tier_min: 5,   tier_max: 18,  kind: 'comp' },
  '>18 to <=30': { label: '18L-30L',  tier_min: 18,  tier_max: 30,  kind: 'comp' },
  '> 30 lac':    { label: 'Above 30L', tier_min: 30, tier_max: null, kind: 'comp' },
  // SATP sheets — premium band in lakhs
  '<=2 Lacs':    { label: 'Upto 2L',  tier_min: 0, tier_max: 2,    kind: 'satp' },
  '>2 Lacs':     { label: 'Above 2L', tier_min: 2, tier_max: null, kind: 'satp' },
};

// ----------------------------------------------------------------------------
// Column → vehicle segment metadata.
// Built from Row 2 (Budget Mix) of each sheet — distinct sub-variant labels.
//
// Each entry: { product, segment, [weight_min/max], [vehicle_age_min/max],
//               [fuel_type], [cc_band_min/max], [ncb_qualifier] }.
// ----------------------------------------------------------------------------

// Common GCV weight bands (shared across Comp and SATP)
const GCV_BANDS = {
  'GCV <=2.5 T':         { weight_min: 0,    weight_max: 2.5 },
  'GCV 2.5 T - 2.8T':    { weight_min: 2.5,  weight_max: 2.8 },
  'GCV 2.8 T - 3.5T':    { weight_min: 2.8,  weight_max: 3.5 },
  'GCV 3.5T - 7.5T':     { weight_min: 3.5,  weight_max: 7.5 },
  'GCV 7.5T - 12T':      { weight_min: 7.5,  weight_max: 12 },
  'GCV 12T-20T Age<5':   { weight_min: 12,   weight_max: 20,  vehicle_age_min: 0,  vehicle_age_max: 4 },
  'GCV 12T-20T Age>=5':  { weight_min: 12,   weight_max: 20,  vehicle_age_min: 5,  vehicle_age_max: 50 },
  'GCV 20T-40T Age<5':   { weight_min: 20,   weight_max: 40,  vehicle_age_min: 0,  vehicle_age_max: 4 },
  'GCV 20T-40T Age>=5':  { weight_min: 20,   weight_max: 40,  vehicle_age_min: 5,  vehicle_age_max: 50 },
  'GCV > 40T':           { weight_min: 40,   weight_max: null },
  'GCV 3W':              { weight_min: 0,    weight_max: null, segment_override: 'GCV 3W' },
};

// 2W CC bands (used for 2W, 2W(1+1), 2W(1+5) groups in Comp).
const TW_CC = {
  '<75cc':     { cc_band_min: 0,    cc_band_max: 75 },
  '75-150cc':  { cc_band_min: 75,   cc_band_max: 150 },
  '150-350cc': { cc_band_min: 150,  cc_band_max: 350 },
  '>350cc':    { cc_band_min: 350,  cc_band_max: null },
  'Scooter':   { sub_kind: 'Scooter' },
};

// Pvt Car CC × fuel for SATP file (4 cc-fuel sub-cells per row).
const PVT_CAR_SATP_CC = {
  'TP_PVT-CAR(<1000cc Diesel)':       { cc_band_min: 0,    cc_band_max: 1000, fuel_type: 'Diesel' },
  'TP_PVT-CAR(<1000cc Petrol)':       { cc_band_min: 0,    cc_band_max: 1000, fuel_type: 'Petrol' },
  'TP_PVT-CAR(1000-1500cc Diesel)':   { cc_band_min: 1000, cc_band_max: 1500, fuel_type: 'Diesel' },
  'TP_PVT-CAR(1000-1500cc Petrol)':   { cc_band_min: 1000, cc_band_max: 1500, fuel_type: 'Petrol' },
  'TP_PVT-CAR(>1500cc Diesel)':       { cc_band_min: 1500, cc_band_max: null, fuel_type: 'Diesel' },
  'TP_PVT-CAR(>1500cc Petrol)':       { cc_band_min: 1500, cc_band_max: null, fuel_type: 'Petrol' },
};

// Build a column-key → metadata resolver. The Budget Mix label drives the
// lookup; the Biz Mix label gives the "group" (e.g. 2W / 2W(1+1) / 2W(1+5)).
function resolveColumn(bizMix, budgetMix) {
  const bm = String(budgetMix || '').trim();
  const biz = String(bizMix || '').trim();

  // ---- GCV bands (Comp + SATP both use the same labels w/ optional "TP " prefix)
  const bmStripped = bm.replace(/^TP[ _-]/i, '');
  if (GCV_BANDS[bmStripped]) {
    return {
      product: 'GCV',
      segment: bmStripped,
      ...GCV_BANDS[bmStripped],
    };
  }

  // ---- PCV 3W variants
  if (/^(TP[-_ ])?PCV[- ]?3W (Electric|New|Old)$/i.test(bmStripped)) {
    const m = bmStripped.match(/(Electric|New|Old)$/i);
    const variant = m[1];
    return {
      product: 'PCV',
      segment: '3W PCV',
      fuel_type: variant === 'Electric' ? 'Electric' : null,
      // New → age 0-0, Old → age 1-99 (operator convention).
      vehicle_age_min: variant === 'New' ? 0 : (variant === 'Old' ? 1 : null),
      vehicle_age_max: variant === 'New' ? 0 : (variant === 'Old' ? 99 : null),
      sub_modal: variant,
      label_extra: variant,
    };
  }

  // ---- PCV Bus (Other / School)
  if (/^(TP[-_ ])?PCV[-_ ]?Bus[_-](Other|School)/i.test(bmStripped) ||
      /^TP-PCV-Bus_(Other|School)/i.test(bmStripped)) {
    const m = bmStripped.match(/(Other|School)/i);
    const kind = m[1];
    return {
      product: 'PCV',
      segment: kind === 'School' ? 'School Bus' : 'PCV Bus',
    };
  }

  // ---- PCV Taxi — matches "PCV-Taxi", "PCV Taxi", "Taxi" (SATP after TP_ strip)
  if (/^(?:PCV[-_ ])?Taxi$/i.test(bmStripped)) {
    return { product: 'PCV', segment: 'Taxi' };
  }

  // ---- Tractor (New / Old) + Harvester (New / Old)
  if (/^(TP[-_ ])?Tractor (New|Old)$/i.test(bmStripped) || /TP-Tractor (New|Old)/i.test(bmStripped)) {
    const m = bmStripped.match(/(New|Old)$/i);
    return {
      product: 'GCV',
      segment: 'Tractor',
      // New → age 0-0, Old → age 1-99.
      vehicle_age_min: m[1] === 'New' ? 0 : 1,
      vehicle_age_max: m[1] === 'New' ? 0 : 99,
      sub_modal: m[1],
      label_extra: m[1],
    };
  }
  if (/^(TP[-_ ])?(CE[ -])?Harvester (New|Old)$/i.test(bmStripped)) {
    const m = bmStripped.match(/(New|Old)$/i);
    return {
      product: 'MIS',
      segment: 'Harvester',
      vehicle_age_min: m[1] === 'New' ? 0 : 1,
      vehicle_age_max: m[1] === 'New' ? 0 : 99,
      sub_modal: m[1],
      label_extra: m[1],
    };
  }

  // ---- CE / Construction Equipment variants
  if (/Construction Eq/i.test(bmStripped)) {
    return { product: 'MIS', segment: 'CE Construction', vehicle_category: 'MISC-D', sub_modal: 'Construction Eq' };
  }
  // Misc-D Others / Garbage — operator wants:
  //   Product = MIS, VehicleCategory = MISC-D, Sub Modal = "Others" / "Garbage"
  if (/Misc-?D Others/i.test(bmStripped)) {
    return { product: 'MIS', segment: 'MISC-D', vehicle_category: 'MISC-D', sub_modal: 'Others' };
  }
  if (/MISD Garbage/i.test(bmStripped)) {
    return { product: 'MIS', segment: 'MISC-D', vehicle_category: 'MISC-D', sub_modal: 'Garbage' };
  }

  // ---- 2W variants — CC band × group (2W / 2W(1+1) / 2W(1+5))
  // The group is in Biz Mix; the cc band is in Budget Mix. SATP labels
  // wrap the band in "2W(...)" (e.g. "2W(<=75cc)" / "2W(Scooter)"); Comp
  // labels use the bare band ("<75cc"). Normalize "<=" → "<" so both
  // "<=75cc" and "<75cc" map to the same TW_CC entry.
  // VehicleCategory:
  //   - "Scooter" column     → "Scooter"
  //   - cc-band columns      → "Bike"
  const wrapped = bmStripped.match(/^2W\(\s*(.+?)\s*\)$/i);
  let ccKey = wrapped ? wrapped[1] : bmStripped;
  const normCcKey = ccKey.replace(/^<=/, '<');     // "<=75cc" → "<75cc"
  if (TW_CC[normCcKey] || TW_CC[ccKey] || TW_CC[bmStripped]) {
    const ccMeta = TW_CC[normCcKey] || TW_CC[ccKey] || TW_CC[bmStripped];
    ccKey = normCcKey;
    const isScooter = ccMeta.sub_kind === 'Scooter';
    const isBundled1Plus1 = /\(1\+1\)/.test(biz);
    const isBundled1Plus5 = /\(1\+5\)/.test(biz);
    const rateType =
      isBundled1Plus5 ? 'COMP_1+5' :
      isBundled1Plus1 ? 'COMP_1+1' :
      'COMP';
    return {
      product: 'TW',
      // Segment carries the marker so the export's inferVehicleCategory
      // returns "Bike" / "Scooter". (The transient _vehicle_category field
      // doesn't survive the DB roundtrip.)
      segment: isScooter ? 'TW Scooter' : 'TW Bike',
      vehicle_category: isScooter ? 'Scooter' : 'Bike',
      cc_band_min: ccMeta.cc_band_min ?? null,
      cc_band_max: ccMeta.cc_band_max ?? null,
      sub_modal: isScooter ? 'Scooter' : ccKey,    // surface band/scooter in Sub Modal
      sub_kind: ccMeta.sub_kind || null,
      rate_type_override: rateType,
      // Bundled 1+1 / 1+5 are new-vehicle policies — vehicle_age = 0.
      vehicle_age_min: (isBundled1Plus1 || isBundled1Plus5) ? 0 : null,
      vehicle_age_max: (isBundled1Plus1 || isBundled1Plus5) ? 0 : null,
      label_extra: ccKey,
    };
  }

  // ---- Pvt Car SATP cc-fuel variants
  if (PVT_CAR_SATP_CC[bmStripped] || PVT_CAR_SATP_CC[bm]) {
    const meta = PVT_CAR_SATP_CC[bmStripped] || PVT_CAR_SATP_CC[bm];
    return {
      product: 'CAR',
      segment: 'Pvt Car',
      ...meta,
      label_extra: bm,
    };
  }

  // ---- Pvt Car Comp variants (1+1, 1+3, regular renewal) with fuel × NCB
  // Group from Biz Mix tells us which variant; Budget Mix has the fuel/NCB.
  if (/Pvt Car/i.test(biz)) {
    const isBundled1Plus3 = /\(1\+3\)/.test(biz);
    const isBundled1Plus1 = /\(1\+1\)/.test(biz);
    const rateType =
      isBundled1Plus3 ? 'COMP_1+3' :
      isBundled1Plus1 ? 'COMP_1+1' :
      'COMP';
    let fuel = null, ncb = null;
    if (/^Diesel/i.test(bm)) fuel = 'Diesel';
    else if (/^Petrol/i.test(bm)) fuel = 'Petrol';
    if (/Zero NCB/i.test(bm)) ncb = 'NCB=0';
    else if (/NCB/i.test(bm))  ncb = 'NCB 1-99';
    return {
      product: 'CAR',
      segment: 'Pvt Car',
      fuel_type: fuel,
      ncb_band: ncb,                                  // → embedded in remarks
      rate_type_override: rateType,
      vehicle_age_min: (isBundled1Plus1 || isBundled1Plus3) ? 0 : null,
      vehicle_age_max: (isBundled1Plus1 || isBundled1Plus3) ? 0 : null,
      label_extra: bm,
    };
  }

  // Unknown column — skip (return null)
  return null;
}

// ----------------------------------------------------------------------------
// Cluster → state lookup (built once per workbook by scanning the
// "RTO Vs Cluster" sheet for predominant state per cluster).
// ----------------------------------------------------------------------------
function buildClusterStateMap(workbook) {
  const map = new Map();    // cluster → { states: Map<state, count> }
  const ws = workbook.Sheets['RTO Vs Cluster'];
  if (!ws) return map;
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (aoa.length === 0) return map;

  // The two source files use different column layouts. Auto-detect by header.
  //   Comp xlsx  : header at row 1 (row 0 is a banner). Layout:
  //                UW RTO | RevisedRTOCode | Product Category | V REG REGION
  //                | RTO STATE | UW Cluster (26-27) | Actuarial Cluster
  //   SATP xlsb  : header at row 0. Layout:
  //                RTO Code | Product Category | LOCATION DESC | UW Cluster (25-26)
  //                | Actuarial Cluster (25-26) | Cluster State (25-26)
  let headerRow = 0;
  let dataStart = 1;
  // Find the row that contains a "UW Cluster" or "Cluster State" / "RTO STATE" header.
  for (let r = 0; r < Math.min(3, aoa.length); r++) {
    const cells = (aoa[r] || []).map(c => String(c || '').trim());
    if (cells.some(c => /UW\s*Cluster|Cluster State|RTO STATE|UW RTO|RTO Code/i.test(c))) {
      headerRow = r;
      dataStart = r + 1;
      break;
    }
  }
  const headers = (aoa[headerRow] || []).map(c => String(c || '').trim());
  const findCol = (re) => headers.findIndex(h => re.test(h));
  const clusterCol = findCol(/UW\s*Cluster/i);
  let   stateCol   = findCol(/RTO\s*STATE/i);
  if (stateCol < 0) stateCol = findCol(/Cluster\s*State/i);
  if (clusterCol < 0 || stateCol < 0) {
    console.warn(`[magma] buildClusterStateMap: cluster/state cols not found in headers: ${headers.join(' | ')}`);
    return new Map();
  }

  for (let r = dataStart; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const state   = String(row[stateCol]   || '').trim();
    const cluster = String(row[clusterCol] || '').trim();
    if (!cluster) continue;
    const entry = map.get(cluster) || { states: new Map() };
    if (state) entry.states.set(state, (entry.states.get(state) || 0) + 1);
    map.set(cluster, entry);
  }
  // Reduce → predominant state (most rows)
  const out = new Map();
  for (const [cluster, entry] of map.entries()) {
    let bestState = null, bestCount = 0;
    for (const [st, ct] of entry.states.entries()) {
      if (ct > bestCount) { bestState = st; bestCount = ct; }
    }
    out.set(cluster, bestState);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Cell value classification
// ----------------------------------------------------------------------------
function classifyCell(v) {
  const s = String(v || '').trim();
  if (!s) return { kind: 'empty' };
  if (/^IRDA$/i.test(s)) return { kind: 'irda' };
  if (/^Block(ed)?$/i.test(s)) return { kind: 'block' };
  if (/^NA$/i.test(s)) return { kind: 'empty' };
  const n = parseFloat(s);
  if (!isNaN(n) && n >= 0) return { kind: 'numeric', rate: n };
  return { kind: 'unknown', raw: s };
}

// ----------------------------------------------------------------------------
// Emit rules from a single sheet (one SI band)
// ----------------------------------------------------------------------------
function emitSheet(rules, aoa, sheetName, meta, clusterStateMap) {
  const bandInfo = SI_BAND_LABELS[sheetName] || { label: sheetName, kind: 'comp' };
  const isSatp = bandInfo.kind === 'satp';

  // Resolve column metadata once per sheet.
  const bizMix    = aoa[1] || [];
  const budgetMix = aoa[2] || [];
  const cols = [];
  const lastCol = Math.max(bizMix.length, budgetMix.length);
  for (let c = 1; c < lastCol; c++) {
    const meta = resolveColumn(bizMix[c], budgetMix[c]);
    if (meta) cols.push({ col: c, meta });
  }

  for (let r = 4; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const cluster = String(row[0] || '').trim();
    if (!cluster) continue;
    const state = clusterStateMap.get(cluster) || null;

    for (const { col, meta: cm } of cols) {
      const cls = classifyCell(row[col]);
      if (cls.kind === 'empty' || cls.kind === 'unknown') continue;

      const baseRule = {
        product: cm.product,
        sheet_name: meta.sheetName,
        segment: cm.segment_override || cm.segment,
        // Force-set vehicle category when the column metadata declares it
        // (e.g. Misc-D Others / Garbage / CE → "MISC-D"). The export's
        // ruleToRow honours rule._vehicle_category as an override.
        _vehicle_category: cm.vehicle_category || undefined,
        make: 'All',
        state: state || undefined,
        // Cluster code goes to `region` so the policy lookup's region filter
        // can match RTO → cluster mappings (rto_mappings table). The
        // "[RTO: <cluster>]" prefix in remarks surfaces the same code in
        // the export's RTOCode column.
        region: cluster,
        // Sub Modal column carries the variant label ("Others" / "Garbage"
        // / "New" / "Old" / "Electric" / cc-band / "Scooter").
        sub_type: cm.sub_modal || null,
        fuel_type: cm.fuel_type || null,
        cc_band_min: cm.cc_band_min ?? null,
        cc_band_max: cm.cc_band_max ?? null,
        weight_band_min: cm.weight_min ?? null,
        weight_band_max: cm.weight_max ?? null,
        vehicle_age_min: cm.vehicle_age_min ?? null,
        vehicle_age_max: cm.vehicle_age_max ?? null,
        volume_tier: bandInfo.label,                 // → Min/Max Volume cols
        is_declined: false,
      };

      const labelExtra = cm.label_extra ? ` (${cm.label_extra})` : '';
      const ncbTag    = cm.ncb_band ? ` | ${cm.ncb_band}` : '';
      // "[RTO: <cluster>]" prefix is parsed by ruleToRow and surfaces in the
      // RTOCode column. We use it for Magma cluster codes (CG1 / AP / MH3 /
      // …) which aren't true RTO codes but represent the cluster group.
      const remarksBase = `[RTO: ${cluster}] Magma ${isSatp ? 'SATP' : 'Comp'} | ${cm.segment}${labelExtra} | Cluster ${cluster}${state ? ' (' + state + ')' : ''} | ${bandInfo.label}${ncbTag}`;

      if (cls.kind === 'numeric') {
        // Magma cells are net commission % on GWP — emit single applied_on='NET'
        // rule (→ Netpoint column). For SATP file, applied_on='TP' since
        // the standalone-TP product expects only TP rate.
        rules.push({
          ...baseRule,
          rate_type: isSatp ? 'SATP' : (cm.rate_type_override || 'COMP'),
          applied_on: isSatp ? 'TP' : 'NET',
          rate_value: cls.rate > 1 ? cls.rate / 100 : cls.rate,
          remarks: remarksBase,
          rate_text: `${remarksBase} | ${(cls.rate).toFixed(2)}% on GWP`,
        });
      } else if (cls.kind === 'irda') {
        // IRDA cell: IRDA-min brokerage. For Comp emit OD 19.5% + TP 2.5%;
        // for SATP emit TP 2.5% only.
        if (isSatp) {
          rules.push({
            ...baseRule,
            rate_type: 'SATP', applied_on: 'TP', rate_value: 0.025,
            remarks: remarksBase + ' | IRDA-min (TP 2.5%)',
            rate_text: `${remarksBase} | IRDA TP 2.5%`,
          });
        } else {
          rules.push({
            ...baseRule,
            rate_type: cm.rate_type_override || 'COMP',
            applied_on: 'OD', rate_value: 0.195,
            remarks: remarksBase + ' | IRDA-min (OD 19.5% / TP 2.5%)',
            rate_text: `${remarksBase} | IRDA OD 19.5% TP 2.5%`,
          });
          rules.push({
            ...baseRule,
            rate_type: cm.rate_type_override || 'COMP',
            applied_on: 'TP', rate_value: 0.025,
            remarks: remarksBase + ' | IRDA-min (OD 19.5% / TP 2.5%)',
            rate_text: `${remarksBase} | IRDA OD 19.5% TP 2.5%`,
          });
        }
      } else if (cls.kind === 'block') {
        // SATP-only: cell reads "Block" → declined / blocked. Emit a 0-rate
        // rule with is_declined=true so the grid shows the carve-out.
        rules.push({
          ...baseRule,
          rate_type: 'SATP', applied_on: 'TP', rate_value: 0,
          is_declined: true,
          remarks: remarksBase + ' | BLOCKED (no payout)',
          rate_text: `${remarksBase} | BLOCKED`,
        });
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Entry — called per sheet by the workbook parser. We re-read the workbook
// here to access the cross-sheet RTO Vs Cluster lookup (since the engine's
// `parse` is called once per data sheet but we need workbook context).
// ----------------------------------------------------------------------------

// Workbook-level cache (set in the first call, reused across sheets of the
// same workbook). Keyed by sheet_name in meta — same workbook produces the
// same lookup so we share it.
const _wbCache = new Map();

function getClusterStateMap(meta) {
  // Use a workbook-relative cache key. Since parseWorkbook doesn't pass
  // the workbook reference, we infer from filePath / meta.
  // Cache lifetime is per-upload (process is restarted between uploads).
  if (meta._magma_cluster_state_map) return meta._magma_cluster_state_map;
  return null;
}

function parse(sheetData, sheetConfig, meta) {
  if (!Array.isArray(sheetData) || sheetData.length < 5) return [];
  // sheetConfig.config.sheet_name may carry the actual sheet name when the
  // parser dispatches via name_pattern; fall back to meta.sheetName.
  const sheetName = (sheetConfig && sheetConfig.config && sheetConfig.config.actual_sheet) ||
                    (sheetConfig && sheetConfig.sheet_name) ||
                    meta.sheetName;

  // The cluster→state map needs the "RTO Vs Cluster" sheet which isn't in
  // sheetData (we only get one sheet at a time). Use the global hook
  // populated by parseWorkbook via a pre-pass.
  const clusterStateMap = (meta._magma_cluster_state_map instanceof Map)
    ? meta._magma_cluster_state_map
    : new Map();

  const rules = [];
  emitSheet(rules, sheetData, sheetName, meta, clusterStateMap);
  return rules;
}

// Optional pre-pass — called by parseWorkbook when the engine exports
// `preprocessWorkbook`. Reads "RTO Vs Cluster" sheet once and stashes the
// cluster→state map on meta so per-sheet parse() calls can use it.
function preprocessWorkbook(workbook, insurerConfig, meta) {
  meta._magma_cluster_state_map = buildClusterStateMap(workbook);
}

module.exports = { parse, preprocessWorkbook };
