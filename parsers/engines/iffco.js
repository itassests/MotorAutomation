/**
 * IFFCO Tokio — Motor commission engine (FY 2026-27 Apr 2026).
 *
 * Source files:
 *   1. "Iffco.pdf"      — Commission Structure (base rates per product).
 *   2. "iffco_rto.xlsx" — Heat map (Red/Green per state × vehicle category).
 *                          Two sheets: "RTO Comp" (CV Comp heat map) and
 *                          "TP" (SATP heat map for all products).
 *
 * Base rates (Pan India unless noted):
 *   - Pvt Car Comp w/ NCB     : 25% on OD
 *   - Pvt Car Comp w/o NCB    : 20% on OD
 *   - Pvt Car SAOD            : 15% on OD
 *   - Pvt Car SATP            : 2.5% on TP (heat-map gated)
 *   - TW Comp (Green & Red)  : 17.5% on OD (GWP 0-1L); 20% on Net (>1L green only)
 *   - TW SATP                 : 2.5% Green / 0% Red (heat-map / state list)
 *   - CV Comp (preferred)    : 17.5% on Net (all GWP slabs same)
 *   - CV SATP (preferred)    : 20% on Net
 *   - Red state × category   → 0% with is_declined=true (per operator spec)
 *
 * Approach: xlsx is the data driver — every Red/Green cell produces a
 * rule per state. Base rates are hard-coded.
 *
 * Entry: parse(sheetData, sheetConfig, meta) → rule[]
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------------------
// Base commission rates — refreshed dynamically from the PDF on every upload
// of the rate-card PDF. The cache file holds the most-recently extracted set
// so the xlsx upload (a separate file) can use the same numbers.
//
// Defaults below are the FY 2026-27 Apr 2026 rates; they apply only when the
// cache is missing (first run, or PDF parse failed).
// ----------------------------------------------------------------------------
const RATES_CACHE_FILE = path.join(__dirname, '..', '..', 'config', 'iffco-rates.json');

const DEFAULT_RATES = {
  PVT_CAR: {
    comp_with_ncb:    0.25,
    comp_without_ncb: 0.20,
    saod:             0.15,
    satp:             0.025,
  },
  TW: {
    comp_od:         0.175,
    comp_net_above1L: 0.20,
    satp_green:      0.025,
    satp_red:        0,
  },
  // CV — three GWP slabs. 0-3 Lacs uses base commission (Comp 17.5% Net /
  // SATP 20% Net). 3-6 Lacs and >6 Lacs flatten both Comp and SATP to a
  // single rate (17.5% and 20% respectively).
  CV: {
    slabs: [
      { tier: 'Upto 3L', tier_min: 0, tier_max: 3, comp_net: 0.175, satp_net: 0.20 },
      { tier: '3L-6L',   tier_min: 3, tier_max: 6, comp_net: 0.175, satp_net: 0.175 },
      { tier: 'Above 6L', tier_min: 6, tier_max: null, comp_net: 0.20, satp_net: 0.20 },
    ],
    // Back-compat aliases (still referenced where slab fanout isn't desired):
    comp_net: 0.175,
    satp_net: 0.20,
  },
};

function loadRates() {
  // Deep-merge cache (if any) into defaults so structural additions to
  // DEFAULT_RATES (e.g. the CV slabs array introduced 2026-05) survive
  // older cache files that lack those keys.
  const cloneDefaults = () => JSON.parse(JSON.stringify(DEFAULT_RATES));
  let cached = null;
  try {
    if (fs.existsSync(RATES_CACHE_FILE)) {
      cached = JSON.parse(fs.readFileSync(RATES_CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[iffco] rates cache read failed, using defaults:', e.message);
  }
  if (!cached) return cloneDefaults();
  const merged = cloneDefaults();
  for (const top of Object.keys(cached)) {
    if (cached[top] && typeof cached[top] === 'object' && !Array.isArray(cached[top])) {
      merged[top] = { ...(merged[top] || {}), ...cached[top] };
    } else {
      merged[top] = cached[top];
    }
  }
  return merged;
}

function saveRates(rates) {
  try {
    fs.writeFileSync(RATES_CACHE_FILE, JSON.stringify(rates, null, 2));
    console.log('[iffco] rates cached to', RATES_CACHE_FILE);
  } catch (e) {
    console.warn('[iffco] rates cache write failed:', e.message);
  }
}

// Module-level singleton, refreshed by parsePdfFile when a PDF is uploaded.
let RATES = loadRates();

// TW state classification — Red states per PDF: AS, MP, CG, RJ, UP, Rest MH, KA, TN, KL.
// "Rest MH" means Maharashtra excluding Mumbai (Mumbai is treated as Green).
const TW_RED_STATES = new Set([
  'Assam', 'Madhya Pradesh', 'Chhattisgarh', 'Rajasthan',
  'Uttar Pradesh', 'Maharashtra', 'Karnataka', 'Tamil Nadu', 'Kerala',
]);

// ----------------------------------------------------------------------------
// State-name normalisation (xlsx headers use various forms)
// ----------------------------------------------------------------------------
const STATE_ALIASES = {
  'ASSAM': 'Assam',
  'DELHI': 'Delhi',
  'UTTRAKH AND SGARH': 'Uttarakhand',
  'UTTRAKHAND': 'Uttarakhand',
  'CHHATTI PRADESH': 'Chhattisgarh',
  'CHHATTISGARH': 'Chhattisgarh',
  'MADHYA PRADESH': 'Madhya Pradesh',
  'BIHAR': 'Bihar',
  'UTTAR PRADESH': 'Uttar Pradesh',
  'RAJASTH AN': 'Rajasthan',
  'RAJASTHAN': 'Rajasthan',
  'HARYAN A': 'Haryana',
  'HARYANA': 'Haryana',
  'HIMACHAL PRADESH': 'Himachal Pradesh',
  'JAMMU & KASHMIR': 'Jammu & Kashmir',
  'JAMMU AND KASHMIR': 'Jammu & Kashmir',
  'PUNJAB': 'Punjab',
  'JHARKHA ND': 'Jharkhand',
  'JHARKHAND': 'Jharkhand',
  'HARKHAND': 'Jharkhand',
  'ORISSA': 'Odisha',
  'ODISHA': 'Odisha',
  'WEST BENGAL': 'West Bengal',
  'EST BENGAL': 'West Bengal',
  'GUJARAT': 'Gujarat',
  'MAHARASHTRA': 'Maharashtra',
  'MUMBAI': 'Maharashtra',     // Mumbai = city in MH; tag separately
  'GOA': 'Goa',
  'ANDHRA PRADESH': 'Andhra Pradesh',
  'TELANGA NA': 'Telangana',
  'TELANGANA': 'Telangana',
  'KARNATAKA': 'Karnataka',
  'KERALA': 'Kerala',
  'TAMIL NADU': 'Tamil Nadu',
  'NE (EXCLUDING ASSAM)': 'North East (excl Assam)',
};

function normState(s) {
  const k = String(s || '').trim().toUpperCase();
  return STATE_ALIASES[k] || (s || '').trim();
}

function isRed(cellValue) {
  const v = String(cellValue || '').trim().toLowerCase().replace(/\s+/g, '');
  return /^red$/.test(v);
}
function isGreen(cellValue) {
  const v = String(cellValue || '').trim().toLowerCase().replace(/\s+/g, '');
  return /^green$/.test(v);
}

// ----------------------------------------------------------------------------
// Category code → product/segment/sub-band metadata for CV heat maps
// ----------------------------------------------------------------------------
function resolveRtoCompCategory(label) {
  const s = String(label || '').trim();
  // A.1 GVW upto/range — GCV
  let m = s.match(/^A\.?1.*upto\s*(\d+)/i);
  if (m) return { product: 'GCV', segment: 'GCV (Public)', weight_min: 0, weight_max: parseInt(m[1])/1000, label: s };
  m = s.match(/^A[.,]1.*?(\d+)[ -]*(\d+)/);
  if (m) return { product: 'GCV', segment: 'GCV (Public)', weight_min: parseInt(m[1])/1000, weight_max: parseInt(m[2])/1000, label: s };
  m = s.match(/^A\.?1.*GT\s*(\d+)/i);
  if (m) return { product: 'GCV', segment: 'GCV (Public)', weight_min: parseInt(m[1])/1000, weight_max: null, label: s };
  if (/^A2[.\- ]/i.test(s)) return { product: 'GCV', segment: 'GCV (Private)', label: s };
  if (/^A3[.\- ]/i.test(s)) return { product: 'GCV', segment: 'Three Wheeler (Public)', label: s };
  if (/^A4[.\- ]/i.test(s)) return { product: 'GCV', segment: 'Three Wheeler (Private)', label: s };
  if (/^B1\b/i.test(s))      return { product: 'CAR', segment: 'Pvt Car', label: s };
  if (/^C1A.*TAXI/i.test(s)) return { product: 'PCV', segment: 'Taxi', seat_min: 0, seat_max: 6, label: s };
  if (/^C1B/i.test(s)) {
    // Strip "C1B-" prefix before extracting the seating range so the "1" in
    // "C1B" doesn't masquerade as the lower bound.
    const tail = s.replace(/^C1B[- ]*/i, '');
    m = tail.match(/(\d+)\D+(\d+)/);
    if (m) return { product: 'PCV', segment: 'PCV (2-6 seats)', seat_min: parseInt(m[1]), seat_max: parseInt(m[2]), label: s };
  }
  if (/^C2/i.test(s)) {
    const tail = s.replace(/^C2[- ]*/i, '');
    m = tail.match(/(\d+)\D+(\d+)/);
    if (m) {
      const seatMin = parseInt(m[1]), seatMax = parseInt(m[2]);
      // Match the TP sheet's naming: seat-cap >10 is "Bus (X-Y seats)", else
      // generic PCV. Keeps Comp + SATP segment names aligned for filtering.
      const seg = seatMax > 10 ? `Bus (${seatMin}-${seatMax} seats)` : `PCV (${seatMin}-${seatMax} seats)`;
      return { product: 'PCV', segment: seg, seat_min: seatMin, seat_max: seatMax, label: s };
    }
    if (/GREATER\s*TH/i.test(s)) return { product: 'PCV', segment: 'Bus (>60 seats)', seat_min: 60, seat_max: null, label: s };
  }
  if (/^C3/i.test(s)) return { product: 'PCV', segment: '3W PCV', label: s };
  if (/^C4/i.test(s)) return { product: 'PCV', segment: '2W PCV', label: s };
  if (/^CLASS\s*E/i.test(s)) return { product: 'MIS', segment: 'Class E', label: s };
  if (/^CLASS\s*F/i.test(s)) return { product: 'MIS', segment: 'Class F', label: s };
  if (/^CLASS\s*G/i.test(s)) return { product: 'MIS', segment: 'Class G', label: s };
  // Misc-D specific sub-types (each gets its own segment so VehicleCategory
  // shows the actual class — Ambulance / Excavator / Mobile Crane / etc.)
  if (/^D[-_ ]?AMBULANCE/i.test(s))         return { product: 'MIS', segment: 'Ambulance',            label: s };
  if (/^D[-_ ]?EXCAVATOR/i.test(s))         return { product: 'MIS', segment: 'Excavator',            label: s };
  if (/^D[-_ ]?MOBILE\s*CRANE/i.test(s))    return { product: 'MIS', segment: 'Mobile Crane',         label: s };
  if (/^D[-_ ]?PUBLICITY\s*VAN/i.test(s))   return { product: 'MIS', segment: 'Publicity Van',        label: s };
  if (/^D[-_ ]?TRACTOR/i.test(s))           return { product: 'MIS', segment: 'Tractor',              label: s };
  if (/^D[-_ ]?TRANSIT\s*(MIX|MIXTURE)/i.test(s)) return { product: 'MIS', segment: 'Transit Mixer', label: s };
  if (/^E[-_ ]?RICKSHAW/i.test(s))          return { product: 'MIS', segment: 'E-Rickshaw',           label: s };
  if (/^D[-_ ]?OTHERS?/i.test(s))           return { product: 'MIS', segment: 'Misc-D Others',        label: s };
  if (/^D-CLASS|^CLASS\s*D|^MISC[- ]D/i.test(s)) return { product: 'MIS', segment: 'Misc-D',           label: s };
  return null;
}

// TP sheet column resolver — header row carries category names without
// a clean separator; we map by ordinal position.
const TP_COLUMNS = [
  // col 0 = STATE
  { col: 1, product: 'CAR', segment: 'Pvt Car', cc_band_min: 0,    cc_band_max: 1000, label: 'PCP <1000cc' },
  { col: 2, product: 'CAR', segment: 'Pvt Car', cc_band_min: 1000, cc_band_max: 1500, label: 'PCP 1001-1500cc' },
  { col: 3, product: 'CAR', segment: 'Pvt Car', cc_band_min: 1500, cc_band_max: null, label: 'PCP >1500cc' },
  { col: 4, product: 'TW',  segment: 'TW',     label: 'TWP' },
  { col: 5, product: 'GCV', segment: 'GCV (Public)', weight_min: 0,  weight_max: 7.5,  label: 'A1 GVW <7500' },
  { col: 6, product: 'GCV', segment: 'GCV (Public)', weight_min: 7.5, weight_max: 40,  label: 'A1 GVW 7500-40000' },
  { col: 7, product: 'GCV', segment: 'GCV (Public)', weight_min: 40,  weight_max: null, label: 'A1 GVW >40000' },
  { col: 8, product: 'GCV', segment: 'GCV (Other than A1)', label: 'Other than A1 (A2/A3/A4)' },
  { col: 9,  product: 'PCV', segment: 'Bus (11-18 seats)',  seat_min: 11, seat_max: 18, label: 'Bus 11-18' },
  { col: 10, product: 'PCV', segment: 'Bus (19-60 seats)',  seat_min: 19, seat_max: 60, label: 'Bus 19-60' },
  { col: 11, product: 'PCV', segment: 'Taxi',                seat_min: 1,  seat_max: 6,  label: 'Taxi C1A (1-6)' },
  { col: 12, product: 'PCV', segment: 'PCV (7-10 seats)',    seat_min: 7,  seat_max: 10, label: 'C2 (7-10)' },
  { col: 13, product: 'PCV', segment: 'Auto Rickshaw / C1B', label: 'Auto Rickshaw C1B' },
  { col: 14, product: 'MIS', segment: 'D-Class & Others',   label: 'D-CLASS & Others' },
];

// ----------------------------------------------------------------------------
// Per-sheet parsers
// ----------------------------------------------------------------------------
function parseRtoCompSheet(aoa, meta) {
  // Layout: row 0 header (col 0 = "MAKE" / category label, cols 1+ = state names).
  //         rows 1-N: col 0 = category, col 1+ = "GREEN" / "Red"
  if (!aoa || aoa.length < 2) return [];
  const header = aoa[0] || [];
  const stateCols = [];
  for (let c = 1; c < header.length; c++) {
    const st = normState(header[c]);
    if (st) stateCols.push({ col: c, state: st, raw: header[c] });
  }
  const rules = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const categoryLabel = String(row[0] || '').trim();
    if (!categoryLabel) continue;
    const cat = resolveRtoCompCategory(categoryLabel);
    if (!cat) continue;

    for (const { col, state, raw } of stateCols) {
      const cell = row[col];
      const red = isRed(cell);
      const green = isGreen(cell);
      if (!red && !green) continue;       // skip empty / unknown cells
      const isMumbaiCity = String(raw || '').toUpperCase().trim() === 'MUMBAI';
      // Term 5 — Rajasthan GVW 12K-20K capped at 17.5% (overrides slab 3's 20%).
      // The heat-map A1 7500-40000 cell covers 12-20T inside it; we don't
      // split the cell — instead we cap the slab rates for this state when
      // the row's weight range covers 12-20T.
      const applyRjCap =
        state === 'Rajasthan' && cat.product === 'GCV' &&
        cat.weight_min != null && cat.weight_max != null &&
        cat.weight_min <= 12 && cat.weight_max >= 20;

      // Fan out CV Comp rules by GWP slab. Red state emits 0% for every slab
      // (declined); Green state uses the slab-specific Comp rate.
      for (const slab of RATES.CV.slabs) {
        let rate = red ? 0 : slab.comp_net;
        const wasCapped = !red && applyRjCap && rate > 0.175;
        if (wasCapped) rate = 0.175;
        rules.push({
          product: cat.product,
          sheet_name: meta.sheetName,
          segment: cat.segment,
          make: 'All',
          state: state,
          region: isMumbaiCity ? 'Mumbai' : state,
          weight_band_min: cat.weight_min ?? null,
          weight_band_max: cat.weight_max ?? null,
          seating_capacity_min: cat.seat_min ?? null,
          seating_capacity_max: cat.seat_max ?? null,
          volume_tier: slab.tier,                  // → Min/Max Volume columns
          rate_type: 'COMP',
          applied_on: 'NET',
          rate_value: rate,
          is_declined: red,
          remarks: `${cat.label} | ${state} (${red ? 'RED' : 'GREEN'}) | GWP ${slab.tier} | Comp ${(slab.comp_net*100).toFixed(2)}% on Net${red ? ' — declined (0%)' : ''}${wasCapped ? ' — Rajasthan 12-20T cap 17.5% (Term 5)' : ''}`,
          rate_text: `IFFCO CV Comp | ${cat.label} | ${state} | GWP ${slab.tier} | ${(rate*100).toFixed(2)}%`,
        });
      }

      // Term 4 — Bharat Benz make carve-out: emit per-make rules at base
      // commission only (slab 1 rate), no slab upgrades. Applies to all
      // states and all CV categories. Red state still gets SATP=0% (term 2),
      // but for Comp we follow the operator's current spec — Red Comp = 0%.
      const bbRate = red ? 0 : RATES.CV.slabs[0].comp_net;     // base only
      rules.push({
        product: cat.product,
        sheet_name: meta.sheetName,
        segment: cat.segment,
        make: 'Bharat Benz',
        state: state,
        region: isMumbaiCity ? 'Mumbai' : state,
        weight_band_min: cat.weight_min ?? null,
        weight_band_max: cat.weight_max ?? null,
        seating_capacity_min: cat.seat_min ?? null,
        seating_capacity_max: cat.seat_max ?? null,
        volume_tier: 'All slabs (Bharat Benz)',
        rate_type: 'COMP',
        applied_on: 'NET',
        rate_value: bbRate,
        is_declined: red,
        remarks: `${cat.label} | ${state} (${red ? 'RED' : 'GREEN'}) | Bharat Benz make — restricted to BASE commission across all GWP slabs (Term 4)${red ? ' — declined (0%)' : ''}`,
        rate_text: `IFFCO CV Comp Bharat Benz | ${cat.label} | ${state} | ${(bbRate*100).toFixed(2)}%`,
      });
    }
  }
  return rules;
}

function parseTpSheet(aoa, meta) {
  // Layout: header rows 0-2 (compound). Data rows from 3.
  //   col 0 = STATE; cols 1-14 = vehicle categories (TP_COLUMNS table).
  if (!aoa || aoa.length < 4) return [];
  const rules = [];
  // Cities that appear as standalone rows but belong to a parent state.
  // For Iffco the TP sheet lists Mumbai separately from Maharashtra.
  const CITY_TO_PARENT = {
    'MUMBAI': 'Maharashtra',
  };
  for (let r = 3; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const stateRaw = String(row[0] || '').trim();
    if (!stateRaw) continue;
    const stateRawUC = stateRaw.toUpperCase();
    const isCityRow = !!CITY_TO_PARENT[stateRawUC];
    const state = isCityRow ? CITY_TO_PARENT[stateRawUC] : normState(stateRaw);
    const city  = isCityRow ? stateRaw.charAt(0) + stateRaw.slice(1).toLowerCase() : null;
    if (!state) continue;
    for (const def of TP_COLUMNS) {
      const cell = row[def.col];
      const red = isRed(cell);
      const green = isGreen(cell);
      if (!red && !green) continue;

      // CV categories fan out per GWP slab (3 rules). Pvt Car & TW keep a
      // single rule (no slab gating in the source).
      const isCvCategory = def.product === 'GCV' || def.product === 'PCV' || def.product === 'MIS';
      const slabs = isCvCategory
        ? RATES.CV.slabs.map(s => ({ tier: s.tier, satp_net: s.satp_net }))
        : [{ tier: null, satp_net: def.product === 'CAR' ? RATES.PVT_CAR.satp : RATES.TW.satp_green }];

      // Term 5 — Rajasthan GCV 12-20T cap (only for the wide-band cell which
      // covers 12-20T inside it).
      const applyRjCap =
        state === 'Rajasthan' && def.product === 'GCV' &&
        def.weight_min != null && def.weight_max != null &&
        def.weight_min <= 12 && def.weight_max >= 20;

      for (const slab of slabs) {
        let rate = red ? 0 : slab.satp_net;
        const wasCapped = !red && applyRjCap && rate > 0.175;
        if (wasCapped) rate = 0.175;
        rules.push({
          product: def.product,
          sheet_name: meta.sheetName,
          segment: def.segment,
          make: 'All',
          state: state,
          region: city || state,
          cc_band_min: def.cc_band_min ?? null,
          cc_band_max: def.cc_band_max ?? null,
          weight_band_min: def.weight_min ?? null,
          weight_band_max: def.weight_max ?? null,
          seating_capacity_min: def.seat_min ?? null,
          seating_capacity_max: def.seat_max ?? null,
          volume_tier: slab.tier,
          rate_type: 'SATP',
          applied_on: 'TP',
          rate_value: rate,
          is_declined: red,
          remarks: `${def.label} | ${state}${city ? '/' + city : ''} (${red ? 'RED' : 'GREEN'})${slab.tier ? ' | GWP ' + slab.tier : ''} | SATP ${(slab.satp_net*100).toFixed(2)}%${red ? ' — declined (0%)' : ''}${wasCapped ? ' — Rajasthan 12-20T cap 17.5% (Term 5)' : ''}`,
          rate_text: `IFFCO SATP | ${def.label} | ${state}${city ? '/' + city : ''}${slab.tier ? ' | GWP ' + slab.tier : ''} | ${(rate*100).toFixed(2)}%`,
        });
      }

      // Term 4 — Bharat Benz SATP carve-out (CV only; base rate only).
      if (isCvCategory) {
        const baseSatp = RATES.CV.slabs[0].satp_net;
        const bbRate = red ? 0 : baseSatp;
        rules.push({
          product: def.product,
          sheet_name: meta.sheetName,
          segment: def.segment,
          make: 'Bharat Benz',
          state: state,
          region: city || state,
          cc_band_min: def.cc_band_min ?? null,
          cc_band_max: def.cc_band_max ?? null,
          weight_band_min: def.weight_min ?? null,
          weight_band_max: def.weight_max ?? null,
          seating_capacity_min: def.seat_min ?? null,
          seating_capacity_max: def.seat_max ?? null,
          volume_tier: 'All slabs (Bharat Benz)',
          rate_type: 'SATP',
          applied_on: 'TP',
          rate_value: bbRate,
          is_declined: red,
          remarks: `${def.label} | ${state}${city ? '/' + city : ''} (${red ? 'RED' : 'GREEN'}) | Bharat Benz make — restricted to BASE SATP across all slabs (Term 4)${red ? ' — declined (0%)' : ''}`,
          rate_text: `IFFCO SATP Bharat Benz | ${def.label} | ${state}${city ? '/' + city : ''} | ${(bbRate*100).toFixed(2)}%`,
        });
      }
    }
  }
  return rules;
}

// ----------------------------------------------------------------------------
// Base Pan-India rules (not in heat map): Pvt Car Comp / TW Comp
// Emitted once per upload to cover the non-state-fanned base rates.
// ----------------------------------------------------------------------------
function emitBaseRules(meta) {
  const rules = [];
  // Pvt Car Pan India base (Comp, SAOD) — these supplement the per-state
  // SATP rules emitted from the TP sheet.
  rules.push({
    product: 'CAR', sheet_name: meta.sheetName, segment: 'Pvt Car',
    make: 'All', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'OD',
    rate_value: RATES.PVT_CAR.comp_with_ncb,
    is_declined: false,
    remarks: 'Pvt Car Comp with NCB | Pan India | 25% on OD',
    rate_text: 'IFFCO Pvt Car Comp w/ NCB | Pan India | 25% OD',
    sub_type: 'With NCB',
  });
  rules.push({
    product: 'CAR', sheet_name: meta.sheetName, segment: 'Pvt Car',
    make: 'All', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'OD',
    rate_value: RATES.PVT_CAR.comp_without_ncb,
    is_declined: false,
    remarks: 'Pvt Car Comp without NCB | Pan India | 20% on OD',
    rate_text: 'IFFCO Pvt Car Comp w/o NCB | Pan India | 20% OD',
    sub_type: 'NCB=0',
  });
  rules.push({
    product: 'CAR', sheet_name: meta.sheetName, segment: 'Pvt Car',
    make: 'All', region: 'Pan India',
    rate_type: 'SAOD', applied_on: 'OD',
    rate_value: RATES.PVT_CAR.saod,
    is_declined: false,
    remarks: 'Pvt Car SAOD | Pan India | 15% on OD',
    rate_text: 'IFFCO Pvt Car SAOD | Pan India | 15% OD',
  });
  // TW per-state Comp rules — Green states 0-1L 17.5% OD + above 1L 20% Net;
  // Red states all-business 17.5% OD only.
  const ALL_STATES = [
    'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
    'Haryana','Himachal Pradesh','Jammu & Kashmir','Jharkhand','Karnataka','Kerala',
    'Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha',
    'Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh',
    'Uttarakhand','West Bengal','Delhi','Chandigarh','Puducherry',
  ];
  for (const state of ALL_STATES) {
    const isRedState = TW_RED_STATES.has(state);
    // 0-1L band — Comp 17.5% OD
    rules.push({
      product: 'TW', sheet_name: meta.sheetName, segment: 'TW',
      make: 'All', state: state, region: state,
      rate_type: 'COMP', applied_on: 'OD',
      rate_value: RATES.TW.comp_od,
      volume_tier: 'Upto 1L',
      is_declined: false,
      remarks: `TW Comp | ${state} (${isRedState ? 'RED' : 'GREEN'}) | GWP 0-1L | 17.5% on OD`,
      rate_text: `IFFCO TW Comp | ${state} | GWP Upto 1L | 17.5% OD`,
    });
    // >1L band — Comp 20% Net (Green states only)
    if (!isRedState) {
      rules.push({
        product: 'TW', sheet_name: meta.sheetName, segment: 'TW',
        make: 'All', state: state, region: state,
        rate_type: 'COMP', applied_on: 'NET',
        rate_value: RATES.TW.comp_net_above1L,
        volume_tier: 'Above 1L',
        is_declined: false,
        remarks: `TW Comp | ${state} (GREEN) | GWP >1L | 20% on Net`,
        rate_text: `IFFCO TW Comp | ${state} | GWP Above 1L | 20% Net`,
      });
    }
    // Mumbai special — green city in red state Maharashtra
    if (state === 'Maharashtra') {
      rules.push({
        product: 'TW', sheet_name: meta.sheetName, segment: 'TW',
        make: 'All', state: 'Maharashtra', region: 'Mumbai',
        rate_type: 'COMP', applied_on: 'NET',
        rate_value: RATES.TW.comp_net_above1L,
        volume_tier: 'Above 1L',
        is_declined: false,
        remarks: 'TW Comp | Mumbai (GREEN city within RED state MH) | GWP >1L | 20% on Net',
        rate_text: 'IFFCO TW Comp | Mumbai | GWP Above 1L | 20% Net',
      });
    }
  }
  return rules;
}

// ----------------------------------------------------------------------------
// Engine entry — dispatcher per sheet kind
// ----------------------------------------------------------------------------
function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig?.config?.sheet_kind || sheetConfig?.kind;
  switch (kind) {
    case 'iffco_rto_comp': {
      const rules = parseRtoCompSheet(sheetData, meta);
      // Emit base Pan-India rules once (alongside the first sheet only — flag
      // on meta to avoid double-counting if both sheets parse in same upload).
      if (!meta._iffco_base_emitted) {
        rules.push(...emitBaseRules(meta));
        meta._iffco_base_emitted = true;
      }
      return rules;
    }
    case 'iffco_tp':
      return parseTpSheet(sheetData, meta);
    default:
      console.warn(`[iffco] unknown sheet_kind: ${kind}`);
      return [];
  }
}

// ----------------------------------------------------------------------------
// PDF entry — OCR via Document AI (since PDF is scanned), then extract the
// 8-10 base rates via regex. The rates are cached so the subsequent xlsx
// upload can use them.
// ----------------------------------------------------------------------------
async function parsePdfFile(filePath) {
  let text = '';
  try {
    const { processPdf } = require('../../services/docai');
    const res = await processPdf(filePath);
    text = res.text || '';
  } catch (err) {
    console.error('[iffco] Document AI failed:', err.message);
    return [];
  }
  if (!text) {
    console.warn('[iffco] PDF text empty — keeping cached/default rates.');
    return [];
  }

  // Extract base rates via pattern matching on the OCR text.
  const rates = JSON.parse(JSON.stringify(DEFAULT_RATES));   // start from defaults

  // ---- Pvt Car ----
  // "Comprehensive (On OD)  25%" / "With NCB ... 25%"
  // The OCR layout puts headers and values on separate lines; we scan for
  // the section then take the first 4 percentages.
  const pvtSec = text.match(/Private Car[\s\S]{0,800}/i);
  if (pvtSec) {
    const nums = (pvtSec[0].match(/(\d+(?:\.\d+)?)\s*%/g) || [])
      .map(s => parseFloat(s) / 100);
    // PDF column order: With NCB Comp, SAOD, SATP, Without NCB Comp
    //                   25%        15%   2.5%   20%
    if (nums.length >= 4) {
      rates.PVT_CAR.comp_with_ncb    = nums[0];
      rates.PVT_CAR.saod             = nums[1];
      rates.PVT_CAR.satp             = nums[2];
      rates.PVT_CAR.comp_without_ncb = nums[3];
    }
  }

  // ---- TW ----
  // Green states 0-1L: "17.5% on OD" then SATP "2.50%"; >1L "20% On Net"
  // Red states: "17.5% on OD" then SATP "0.00%"
  const twSec = text.match(/Two[- ]?Wheeler[\s\S]{0,1500}/i);
  if (twSec) {
    const m1 = twSec[0].match(/(\d+(?:\.\d+)?)\s*%\s*on\s*OD/i);
    if (m1) rates.TW.comp_od = parseFloat(m1[1]) / 100;
    const m2 = twSec[0].match(/(\d+(?:\.\d+)?)\s*%\s*On\s*Net/i);
    if (m2) rates.TW.comp_net_above1L = parseFloat(m2[1]) / 100;
    // SATP green is the first non-zero % after "2.50%" pattern; SATP red is
    // the second value (typically 0%). The PDF lists them in pairs.
    const satpMatches = twSec[0].match(/(\d+(?:\.\d+)?)\s*%/g);
    if (satpMatches) {
      const greens = satpMatches.map(s => parseFloat(s) / 100).filter(v => v > 0 && v < 0.05);
      if (greens.length) rates.TW.satp_green = greens[0];
    }
  }

  // ---- CV ----
  // "All Preferred segments ... 17.50% ... 20.00%" — Comp Net + SATP Net
  const cvSec = text.match(/Commercial Vehicles[\s\S]{0,1500}/i);
  if (cvSec) {
    const nums = (cvSec[0].match(/(\d+(?:\.\d+)?)\s*%/g) || [])
      .map(s => parseFloat(s) / 100);
    if (nums.length >= 2) {
      rates.CV.comp_net = nums[0];
      rates.CV.satp_net = nums[1];
    }
  }

  // Persist + use immediately
  saveRates(rates);
  RATES = rates;

  console.log('[iffco] parsed rates from PDF:', JSON.stringify(rates));

  // The PDF doesn't produce rules directly — the xlsx upload does. We return
  // a marker rule so the upload pipeline shows non-zero "config received".
  return [{
    product: 'META',
    sheet_name: path.basename(filePath),
    segment: 'IFFCO Rate Reference',
    region: 'N/A',
    rate_type: 'META',
    applied_on: 'N/A',
    rate_value: 0,
    is_declined: false,
    remarks: `[META] Base rates extracted from PDF: ${JSON.stringify(rates)}. Now upload iffco_rto.xlsx to generate rate rules.`,
    rate_text: '[META] IFFCO rate reference loaded',
  }];
}

module.exports = { parse, parsePdfFile };
