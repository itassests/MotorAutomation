/**
 * Bajaj File 1: Pvt Car PC + 2W 1+5 + 2W 1+5 HMC/TVS sheets.
 *
 *   sheet_kind: 'pc'        — Pvt Car (1801) with NCB / Non-NCB split,
 *                              disc cap 79% on OD
 *   sheet_kind: 'tw_1plus5' — 2W New Vehicle 1+5 (OD 1yr, TP 5yr) per make,
 *                              only "Doable Loc" rates emitted
 *   sheet_kind: 'tw_hmc_tvs'— Hero MotoCorp & TVS state × CD-band grid
 */

function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parsePercent(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

// ---------- File 1: PC (Pvt Car) sheet ----------
//
// Header row (R2): Sub Channel | Vertical-Type | Region | Zone | State | City |
//                  Location Code | Vertical Name | Sub Vertical | IMD Code |
//                  Sub IMD Code | IMD Name | SubImd Name | IMD Band | Group Name |
//                  Product Code | NEW BUSINESS | RENEWAL
//
// Data row (R3): one IMD agent's headline rates.
//
// Footer rows (R4, R5) contain NCB notes:
//   "Non HEV Comp | All NCB CASES All Fuel-Up to 79% DTD"      → with-NCB 45%, disc cap 79%
//   "Non HEV Comp | With Out NCB All Fuel 25% Up to 79% DTD"   → without-NCB 25%, disc cap 79%
//
// Emit:
//   - COMP, vehicle_age 0/0 (new vehicle)  → NEW BUSINESS rate
//   - COMP, age_band 1-99 (with NCB)       → RENEWAL rate
//   - COMP, age_band 0-0 (without NCB)     → 25% (from row 5 note)
function parsePC(sheetData, sheetConfig, meta) {
  const rules = [];
  // Find headline row (after header)
  const headerRow = sheetData[2] || [];
  let dataRow = null;
  for (let r = 3; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    if (cellOrNull(row[15]) === '1801') { dataRow = row; break; }
  }
  if (!dataRow) return rules;

  const region   = cellOrNull(dataRow[2]);
  const zone     = cellOrNull(dataRow[3]);
  const state    = cellOrNull(dataRow[4]);
  const city     = cellOrNull(dataRow[5]);
  const imdCode  = cellOrNull(dataRow[9]);
  const imdName  = cellOrNull(dataRow[11]);
  const newRate    = parsePercent(dataRow[16]);
  const renewRate  = parsePercent(dataRow[17]);

  // Extract disc-cap and Non-NCB rate from footer notes (rows 4, 5).
  // Pattern: "Up to NN% DTD" or "All Fuel-Up to NN%" — discount cap.
  let discCapPct = 79;   // default
  let nonNcbRate = 0.25; // default 25%
  for (let r = 4; r < Math.min(sheetData.length, 12); r++) {
    const row = sheetData[r];
    if (!row) continue;
    const note = String(row[1] || '').trim();
    if (!note) continue;
    const m = note.match(/up\s*to\s*(\d+(?:\.\d+)?)\s*%\s*(?:DTD)?/i);
    if (m) discCapPct = parseFloat(m[1]);
    // Detect Non-NCB rate inline: "Without NCB All Fuel 25%"
    const m2 = note.match(/with\s*out\s+ncb.*?(\d+(?:\.\d+)?)\s*%/i);
    if (m2) nonNcbRate = parseFloat(m2[1]) / 100;
  }

  // Build base rule (volume_tier holds disc cap so export populates Discount col)
  const baseFields = {
    product: 'CAR',
    sheet_name: meta.sheetName,
    region:   state || region,
    state:    state || null,
    sub_type: city || null,
    segment:  'Pvt Car',
    make:     'All',
    carrier_type: zone,
    volume_tier: String(discCapPct),    // disc cap as plain integer
    remarks: `IMD ${imdCode || ''} ${imdName || ''}`.trim() || null,
    rate_text: `Bajaj 1801 | ${state || region} | ${city || ''}`,
  };

  if (newRate != null) {
    rules.push({
      ...baseFields,
      rate_type: 'COMP',
      vehicle_age_min: 0, vehicle_age_max: 0,         // new vehicle
      rate_value: newRate,
      is_declined: false,
      rate_text: baseFields.rate_text + ' | NEW BUSINESS',
    });
  }
  if (renewRate != null) {
    rules.push({
      ...baseFields,
      rate_type: 'COMP',
      vehicle_age_min: 1, vehicle_age_max: 99,
      age_band_min: 1, age_band_max: 99,              // with NCB
      rate_value: renewRate,
      is_declined: false,
      rate_text: baseFields.rate_text + ' | RENEWAL (NCB)',
    });
  }
  // Non-NCB rolled-over
  rules.push({
    ...baseFields,
    rate_type: 'COMP',
    vehicle_age_min: 1, vehicle_age_max: 99,
    age_band_min: 0, age_band_max: 0,
    rate_value: nonNcbRate,
    is_declined: false,
    rate_text: baseFields.rate_text + ' | Non-NCB',
  });
  return rules;
}

// ---------- File 1: 2W 1+5 sheet ----------
//
// New vehicle Comp, OD tenure 1yr, TP tenure 5yr.  One row per make
// (Honda, Yamaha, TVS, Bajaj, Vespa, Hero) at fixed IMD agent.
//
// Cell format: "<rate>-Doable Loc" / "<rate>-NTU Grid" / "Max <N>% on Od"
//   - "N-Doable Loc"  → rate N%, only in Doable locations (carrier_type='Doable Loc')
//   - "N-NTU Grid"    → NTU rule, currently SKIPPED per user direction
//   - "Max N% on Od"  → CD cap N% (no payout — discount info only)
//
// Make rules with "Doable Loc" emit a rule; NTU rows are noted in remarks.
function parseTw1plus5(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const make = cellOrNull(row[16]);
    const newBizCell = cellOrNull(row[17]);
    if (!make || !newBizCell) continue;
    const state    = cellOrNull(row[4]) || 'All';   // typically "All"
    const region   = cellOrNull(row[2]);
    const zone     = cellOrNull(row[3]);
    const imdCode  = cellOrNull(row[9]);
    const imdName  = cellOrNull(row[11]);

    // Parse "N-Doable Loc" / "N-NTU Grid" / "Max N% on Od"
    const doable = newBizCell.match(/^(\d+(?:\.\d+)?)\s*-\s*Doable\s*Loc(?:ation)?/i);
    const ntu    = newBizCell.match(/^(\d+(?:\.\d+)?)\s*-\s*NTU\s*Grid/i);
    const maxOd  = newBizCell.match(/^Max\s+(\d+(?:\.\d+)?)\s*%\s+on\s+Od/i);

    if (doable) {
      const rate = parseFloat(doable[1]) / 100;
      rules.push({
        product: 'TW',
        sheet_name: meta.sheetName,
        region:   state === 'All' ? region : state, state: state === 'All' ? null : state,
        sub_type: 'Doable Loc',
        segment:  'TW',
        make:     make,
        vehicle_age_min: 0, vehicle_age_max: 0,           // new vehicle
        rate_type: 'COMP_1+5',                             // OD 1yr + TP 5yr
        rate_value: rate,
        is_declined: false,
        carrier_type: zone,
        remarks: `IMD ${imdCode || ''}; Doable locations only`,
        rate_text: `Bajaj 1826 | ${make} | New 1+5 | Doable Loc`,
      });
    }
    else if (maxOd) {
      // Discount cap rule — record as CD info, not a payout rate
      const cap = parseFloat(maxOd[1]);
      rules.push({
        product: 'TW',
        sheet_name: meta.sheetName,
        region:   state === 'All' ? region : state, state: state === 'All' ? null : state,
        segment:  'TW',
        make:     make,
        vehicle_age_min: 0, vehicle_age_max: 0,
        rate_type: 'COMP_1+5_CD2',
        rate_value: cap / 100,
        volume_tier: String(cap),
        is_declined: false,
        remarks: `Max CD cap ${cap}% on OD`,
        rate_text: `Bajaj 1826 | ${make} | Max ${cap}% on OD`,
      });
    }
    // NTU rules currently skipped per user
  }
  return rules;
}

// ---------- File 1: 2W 1+5 HMC & TVS sheet ----------
//
// Layout (R6 header):
//   OEM | States | CD @ 20% | CD @ above 20-40% | CD @ above 40-50% | CD @ above 50-60% | Basic hygiene
//
// "Hero MotoCorp & TVS" header on R7, then state-keyed data rows from R8.
// CD bands: <=20, 20-40, 40-50, 50-60.
//
// Each state × CD-band cell produces a rule with volume_tier = CD band.
function parseTwHmcTvs(sheetData, sheetConfig, meta) {
  const rules = [];
  // CD bands by column (R6: cells 2-5)
  const CD_BANDS = [
    { col: 2, label: '0-20%',  disc_min: 0,  disc_max: 20 },
    { col: 3, label: '20-40%', disc_min: 20, disc_max: 40 },
    { col: 4, label: '40-50%', disc_min: 40, disc_max: 50 },
    { col: 5, label: '50-60%', disc_min: 50, disc_max: 60 },
  ];

  // Forward-fill the OEM and rate cells — merged cells in the source
  // appear as blank on subsequent rows; xlsx library only surfaces the
  // top-left value of a merge.  Track lastRate per CD band so each
  // following state row inherits the merged rate.
  let currentOem = null;
  const lastRate = {};   // col → rate
  for (let r = 7; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const oem = cellOrNull(row[0]);
    if (oem) currentOem = oem;
    const state = cellOrNull(row[1]);
    if (!state) continue;
    if (!currentOem) continue;

    // Each OEM may apply to Hero+TVS combined
    const makes = currentOem.includes('&')
      ? currentOem.split('&').map(s => s.trim()).filter(Boolean)
      : [currentOem];

    for (const make of makes) {
      for (const band of CD_BANDS) {
        const cellRate = parsePercent(row[band.col]);
        // Forward-fill from previous row when this cell is blank (merged).
        if (cellRate != null) lastRate[band.col] = cellRate;
        const rate = cellRate != null ? cellRate : lastRate[band.col];
        if (rate == null) continue;
        rules.push({
          product:  'TW',
          sheet_name: meta.sheetName,
          region:   state,
          state:    state,
          segment:  'TW',
          make:     make.replace(/^Hero\s*MotoCorp$/i, 'Hero MotoCorp'),
          rate_type: 'COMP',
          rate_value: rate,
          is_declined: false,
          volume_tier: band.label,                    // Discount band
          remarks: `CD ${band.label}; Hero/TVS Bajaj grid`,
          rate_text: `${make} | ${state} | CD ${band.label}`,
        });
      }
    }
  }
  return rules;
}

// ============================================================================
//  File 2 — Agency 2W Grid 1802 (Motor 2W Comprehensive Grid)
// ============================================================================
//
// Header rows (R0-R5):
//   R0: "Motor 2W Comprehensive Grid"        → product = TW, rate_type = COMP
//   R3: "Rate Structure on 1st Year NET Premium" → applied on NET
//   R4: "Renewal/Rollover of 1802- Monthly Volume of 1st Year Premium"
//   R5: RTO_State_Name | 0-50K | 50K-1 Lakhs | 1-2 Lakhs | 2-3 Lakhs |
//       More than 3 Lakhs | Remarks | Maximum On Scooter
//
// Volume bands (monthly GWP in INR):
//   0-50K     →  0 to 50,000
//   50K-1L    →  50,000 to 1,00,000
//   1-2L      →  1,00,000 to 2,00,000
//   2-3L      →  2,00,000 to 3,00,000
//   3L+       →  3,00,000 to ∞
//
// Cell value types:
//   - decimal (0.35)                → COMP rate on NET of 1st year
//   - "5% on OD & 0% on TP"         → split rate: COMP_OD 5% + COMP_TP 0%
//   - "RTO Based"                   → skip (rates live in RTO Based Payouts sheet)
//   - "IRDA"                        → per Note 9: OEM 22.5% + non-OEM 17.5% on OD
//   - blank                         → skip
//
// Per Note 2: Bajaj/Vespa/Jawa/Royal Enfield Renewal/Rollover → grid − 5%.
// Emitted as sister rules with make=<rollover make>, rate adjusted.
// Volume tier labels — kept as text in volume_tier (the rate_rules.
// weight_band columns are DECIMAL(10,2) and are semantically tonnage,
// not GWP).  The label encodes the min/max GWP range; downstream
// calculation logic can re-parse if needed.
const TW_COMP_1802_VOLUME_BANDS = [
  { col: 1, tier: '0-50K'   },
  { col: 2, tier: '50K-1L'  },
  { col: 3, tier: '1-2L'    },
  { col: 4, tier: '2-3L'    },
  { col: 5, tier: '3L+'     },
];
const TW_MAX_SCOOTER_COL = 7;

const TW_ROLLOVER_MAKES = ['Bajaj', 'Vespa', 'Jawa', 'Royal Enfield'];

/**
 * The Agency 2W Grid 1802 applies to both Comp and SAOD products.  For
 * each cell-parser rate_type, return the list of rate_types we should
 * actually emit:
 *   "COMP"             → ["COMP", "SAOD"]
 *   "COMP_OD"          → ["COMP_OD", "SAOD_OD"]
 *   "COMP_TP"          → ["COMP_TP"]            (no SAOD-TP)
 *   "COMP_OD_OEM"      → ["COMP_OD_OEM", "SAOD_OD_OEM"]
 *   "COMP_OD_NonOEM"   → ["COMP_OD_NonOEM", "SAOD_OD_NonOEM"]
 */
function expandRateTypes(rt) {
  if (rt === 'COMP_TP') return [rt];               // TP only applies to Comp
  if (/^COMP/.test(rt))  return [rt, rt.replace(/^COMP/, 'SAOD')];
  return [rt];
}

function parseTwComp1802(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row ?? 6;
  const dataEnd   = sheetConfig.data_end_row ?? sheetData.length;

  for (let r = dataStart; r < dataEnd; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const state = cellOrNull(row[0]);
    if (!state) continue;
    if (/^note|^terms|^\d+\./i.test(state)) break;   // bottom notes / T&C
    const remarks = cellOrNull(row[6]);

    // Cols 1-5 → Bike (per user direction); col 7 (Max Scooter) → Scooter.
    // Same grid applies to both Comp AND SAOD products — emit each rule twice
    // (once per rate_type) so a Bajaj-1802 policy of either type matches.
    const allCols = [
      ...TW_COMP_1802_VOLUME_BANDS.map(b => ({ ...b, segment: 'Bike' })),
      { col: TW_MAX_SCOOTER_COL, tier: 'Max Scooter', segment: 'Scooter' },
    ];

    for (const band of allCols) {
      const raw = row[band.col];
      if (raw == null || raw === '') continue;
      const fragments = parseTwCompCell(raw);
      for (const frag of fragments) {
        // For each fragment we emit one rule per (rate_type ∈ {COMP, SAOD}).
        // Special rate_types from the cell parser (COMP_OD / COMP_TP /
        // COMP_OD_OEM / COMP_OD_NonOEM) — convert COMP_* prefix to also
        // emit SAOD_* sister rules with the same rate.
        const productRateTypes = expandRateTypes(frag.rate_type);
        for (const rt of productRateTypes) {
          const baseRule = {
            product:   'TW',
            sheet_name: meta.sheetName,
            region:    state,
            state:     state,
            segment:   band.segment,
            make:      'All',
            rate_type: rt,
            rate_value: frag.rate,
            is_declined: frag.declined === true,
            applied_on: frag.applied_on || 'NET',
            volume_tier: band.tier,           // text label, e.g. "0-50K"
            remarks: [remarks, frag.note].filter(Boolean).join(' | ') || null,
            rate_text: `${state} | ${band.tier} | ${band.segment} | ${rt} | ${frag.label}`,
          };
          rules.push(baseRule);

          // Rollover-make carve-out (Note 2): -5% for Bajaj/Vespa/Jawa/RE.
          // Only emit for the COMP/SAOD plain rate_type (skip OEM/non-OEM
          // IRDA splits — those are pre-set absolute rates).
          if (frag.rate != null && !frag.declined && (rt === 'COMP' || rt === 'SAOD')) {
            for (const m of TW_ROLLOVER_MAKES) {
              rules.push({
                ...baseRule,
                make: m,
                age_band_min: 1,                            // rollover only
                age_band_max: 99,
                rate_value: Math.max(0, +(frag.rate - 0.05).toFixed(6)),
                remarks: `${m} Renewal/Rollover -5% (Note 2)`,
                rate_text: baseRule.rate_text + ` | ${m} rollover -5%`,
              });
            }
          }
        }
      }
    }
  }
  return rules;
}

/**
 * Parse a TW Comp 1802 cell into rule fragments.
 * Returns: array of { rate, rate_type, applied_on, declined, label, note }
 */
function parseTwCompCell(raw) {
  if (raw == null || raw === '') return [];
  const s = String(raw).trim();
  if (!s) return [];

  // "5% on OD & 0% on TP"  → two fragments
  let m = s.match(/(\d+(?:\.\d+)?)\s*%\s*on\s*OD\s*&\s*(\d+(?:\.\d+)?)\s*%\s*on\s*TP/i);
  if (m) {
    return [
      { rate: parseFloat(m[1]) / 100, rate_type: 'COMP_OD', applied_on: 'OD', label: m[1] + '% on OD' },
      { rate: parseFloat(m[2]) / 100, rate_type: 'COMP_TP', applied_on: 'TP', label: m[2] + '% on TP' },
    ];
  }

  // "IRDA"  →  emit OEM 22.5% + non-OEM 17.5% (Note 9)
  if (/^irda$/i.test(s)) {
    return [
      { rate: 0.225, rate_type: 'COMP_OD_OEM',    applied_on: 'OD', label: 'IRDA OEM 22.5% on OD',     note: 'IRDA OEM (Note 9a)' },
      { rate: 0.175, rate_type: 'COMP_OD_NonOEM', applied_on: 'OD', label: 'IRDA non-OEM 17.5% on OD', note: 'IRDA non-OEM (Note 9b)' },
    ];
  }

  // "RTO Based" / "Refer RTO Basis Payout Sheet"  → skip
  if (/^rto\s*based|refer\s*rto/i.test(s)) return [];

  // Plain decimal / percent
  if (typeof raw === 'number') {
    return [{ rate: raw > 1 ? raw / 100 : raw, rate_type: 'COMP', applied_on: 'NET', label: 'Comp on NET' }];
  }
  m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (m) {
    const n = parseFloat(m[1]);
    return [{ rate: n > 1 ? n / 100 : n, rate_type: 'COMP', applied_on: 'NET', label: 'Comp on NET' }];
  }

  // Unknown — log and skip
  return [{ rate: null, rate_type: 'COMP', declined: true, applied_on: 'NET', label: 'Unparsed: ' + s.slice(0, 40), note: s }];
}

// ============================================================================
//  File 2 — RTO Based Payouts File (RTO-level overrides for the 1802 grid)
// ============================================================================
//
// Header rows (R0-R2):
//   R2: RTO Code | District Name | Commission Grid State | UP Region Mapping |
//       0-50K | 50K-1L | 1-2L | 2-3L | 3L+ | | Maximum On Scooter | ...
//
// Same volume bands as the state-level Agency 2W Grid 1802 — but keyed by
// RTO code instead of state.  Emits per (rto_code × volume_band × Bike/Scooter
// × Comp/SAOD), plus the same rollover-make -5% carve-outs.
//
// `region` is set to the Commission Grid State (col 2) so policies whose
// RTO resolves via rto_mappings to a state still match.  `sub_type`
// carries the RTO code so RTO-specific lookups work.
const TW_COMP_1802_RTO_COLS = [
  { col: 4, tier: '0-50K'   },
  { col: 5, tier: '50K-1L'  },
  { col: 6, tier: '1-2L'    },
  { col: 7, tier: '2-3L'    },
  { col: 8, tier: '3L+'     },
];
const TW_COMP_1802_RTO_SCOOTER_COL = 10;

function parseTwComp1802Rto(sheetData, sheetConfig, meta) {
  const rules = [];
  const dataStart = sheetConfig.data_start_row ?? 3;

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const rtoCode  = cellOrNull(row[0]);
    const district = cellOrNull(row[1]);
    const state    = cellOrNull(row[2]);
    if (!rtoCode || !state) continue;
    if (/^rto\s*code$/i.test(rtoCode)) continue;   // header

    const allCols = [
      ...TW_COMP_1802_RTO_COLS.map(b => ({ ...b, segment: 'Bike' })),
      { col: TW_COMP_1802_RTO_SCOOTER_COL, tier: 'Max Scooter', segment: 'Scooter' },
    ];

    for (const band of allCols) {
      const raw = row[band.col];
      if (raw == null || raw === '') continue;
      const fragments = parseTwCompCell(raw);
      for (const frag of fragments) {
        const productRateTypes = expandRateTypes(frag.rate_type);
        for (const rt of productRateTypes) {
          const baseRule = {
            product:   'TW',
            sheet_name: meta.sheetName,
            region:    state,
            state:     state,
            sub_type:  rtoCode,                      // RTO-specific lookup
            segment:   band.segment,
            make:      'All',
            rate_type: rt,
            rate_value: frag.rate,
            is_declined: frag.declined === true,
            applied_on: frag.applied_on || 'NET',
            volume_tier: band.tier,
            remarks:   district ? `District: ${district}` : null,
            rate_text: `${rtoCode} (${state}) | ${band.tier} | ${band.segment} | ${rt} | ${frag.label}`,
          };
          rules.push(baseRule);

          // Same rollover-make carve-out per Note 2
          if (frag.rate != null && !frag.declined && (rt === 'COMP' || rt === 'SAOD')) {
            for (const m of TW_ROLLOVER_MAKES) {
              rules.push({
                ...baseRule,
                make: m,
                age_band_min: 1,
                age_band_max: 99,
                rate_value: Math.max(0, +(frag.rate - 0.05).toFixed(6)),
                remarks: `${m} Renewal/Rollover -5% (Note 2)` + (district ? ` | District: ${district}` : ''),
                rate_text: baseRule.rate_text + ` | ${m} rollover -5%`,
              });
            }
          }
        }
      }
    }
  }
  return rules;
}

// ---------- Top-level dispatch ----------
function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind;
  switch (kind) {
    case 'pc':               return parsePC(sheetData, sheetConfig, meta);
    case 'tw_1plus5':        return parseTw1plus5(sheetData, sheetConfig, meta);
    case 'tw_hmc_tvs':       return parseTwHmcTvs(sheetData, sheetConfig, meta);
    case 'tw_comp_1802':     return parseTwComp1802(sheetData, sheetConfig, meta);
    case 'tw_comp_1802_rto': return parseTwComp1802Rto(sheetData, sheetConfig, meta);
    default:
      console.warn(`[bajaj-pvt-car] unknown sheet_kind "${kind}" for "${meta.sheetName}"`);
      return [];
  }
}

module.exports = { parse };
