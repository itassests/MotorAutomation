/**
 * Universal Sompo wide-matrix engine.
 *
 * One engine handles all six sheets in the Universal Sompo workbook:
 *   Pvt Car / CV / Tractor / PCV / Non Tractor / PCV Short Term
 *
 * All sheets share the same column skeleton:
 *   R(header_row): State column codes  (CG, AS, JH, …, KA, KL, AP, TS)
 *   R(data_start..): rate-type / band labels in col 0, % values in cols 1+
 *
 * Per-sheet logic (rate-row interpretation, fan-out for sliding price,
 * discount caps, seating splits, declined makes etc.) is dispatched on
 * `sheet_kind` set in the insurer config.
 *
 * Source notes live verbatim at the bottom of each sheet — see the
 * comments inside each sheet handler for the exact text and the
 * encoding decision.
 *
 * Conventions used by this engine:
 *   - region        ← state code (canonical full name)
 *   - sub_type      ← cluster sub-key when state splits into UP1/2/3,
 *                     RJ1/2/3, MP1/2, KA1/2, DL-NCR, Tri-City
 *   - volume_tier   ← discount cap (single integer string like "80",
 *                     range like "65-69", or GWP slab "Upto 5L")
 *   - carrier_type  ← MH-branch flag for the CV special rule
 *                     ("MH branch" vs "Non-MH branch")
 *   - rate_text     ← human-readable audit trail (state | sub | row)
 */

const { irdaRateFor } = require('../utils/irda-rates');

// ---------- State code → canonical name ----------
//
// The header row uses short codes; downstream matching keys off the
// canonical UPPERCASE state name (matches RTO-derived state names in
// the bulk pipeline).
const STATE_CODES = {
  'CG':       'CHHATTISGARH',
  'AS':       'ASSAM',
  'JH':       'JHARKHAND',
  'WB':       'WEST BENGAL',
  'ODIS':     'ODISHA',
  'BR':       'BIHAR',
  '7S':       'SIKKIM',     // confirmed: 7S = Sikkim
  'MH':       'MAHARASHTRA',
  'GJ/DD':    'GUJARAT',    // composite: Gujarat + Daman & Diu
  'GJ':       'GUJARAT',
  'GOA':      'GOA',
  'MP':       'MADHYA PRADESH',
  'MP1':      'MADHYA PRADESH',
  'MP 1':     'MADHYA PRADESH',
  'MP2':      'MADHYA PRADESH',
  'MP 2':     'MADHYA PRADESH',
  'UP1':      'UTTAR PRADESH',
  'UP2':      'UTTAR PRADESH',
  'UP3':      'UTTAR PRADESH',
  'RJ':       'RAJASTHAN',
  'RJ1':      'RAJASTHAN',
  'RJ2':      'RAJASTHAN',
  'RJ3':      'RAJASTHAN',
  'HR':       'HARYANA',
  'DL':       'DELHI',
  'NCR':      'DELHI',         // PCV Short Term has NCR as separate column
  'DL-NCR':   'DELHI',
  'UK':       'UTTARAKHAND',
  'PB':       'PUNJAB',
  'CH':       'CHANDIGARH',
  'HP':       'HIMACHAL PRADESH',
  'J&K/LA':   'JAMMU & KASHMIR',  // composite: J&K + Ladakh
  'TN':       'TAMIL NADU',
  'PY':       'PUDUCHERRY',
  'PONDI':    'PUDUCHERRY',
  'KA':       'KARNATAKA',
  'KA1':      'KARNATAKA',
  'KA 1':     'KARNATAKA',
  'KA2':      'KARNATAKA',
  'KA 2':     'KARNATAKA',
  'KL':       'KERALA',
  'AP':       'ANDHRA PRADESH',
  'TS':       'TELANGANA',
};

// Cluster sub-key per column header — when a state splits, the column
// label carries the cluster (e.g. "UP1" → cluster "UP-1"). Empty when
// no split applies. Used to populate sub_type.
const CLUSTER_SUBKEY = {
  'UP1':   'UP-1', 'UP2': 'UP-2', 'UP3': 'UP-3',
  'RJ1':   'RJ-1', 'RJ2': 'RJ-2', 'RJ3': 'RJ-3',
  // PCV Short Term notes spell out the city membership for MP/KA splits:
  //   MP-1 = Ujjain, Indore, Bhopal      |  MP-2 = Rest of MP
  //   KA-1 = Bangalore, Mysore, Mangalore |  KA-2 = Rest of KA
  // Use the city descriptions as the cluster label so the export's
  // City column surfaces them directly.
  'MP1':   'Ujjain, Indore, Bhopal',
  'MP 1':  'Ujjain, Indore, Bhopal',
  'MP2':   'Rest of MP',
  'MP 2':  'Rest of MP',
  'KA1':   'Bangalore, Mysore, Mangalore',
  'KA 1':  'Bangalore, Mysore, Mangalore',
  'KA2':   'Rest of KA',
  'KA 2':  'Rest of KA',
  'DL-NCR':'DL-NCR',
  'NCR':   'NCR',     // PCV Short Term keeps NCR separate from DL
  'GJ/DD': 'GJ/DD',
  'J&K/LA':'J&K/LA',
};

// ---------- Cluster RTO membership (used by emitClusterMappings) ----------
//
// Sourced from the explicit RTO lists in each sheet's footer notes.
// Membership semantics:
//   UP-1 = "all UP RTOs not in UP-2 or UP-3"
//   RJ-2 = "all RJ RTOs not in RJ-1 or RJ-3"
//   MP-2 = "rest of MP" (anything not in MP-1)
//   KA-2 = "rest of KA"  (anything not in KA-1)
// "Rest of …" buckets are NOT enumerated here — they get matched via the
// region (state) fallback when the lookup fails to find an exact RTO.
const CLUSTERS = {
  'UP-2': ['UP21','UP81','UP80','UP12','UP15','UP11','UP75','UP95','UP84','UP85','UP90','UP20','UP96','UP17'],
  'UP-3': ['UP35','UP44','UP54','UP63','UP36','UP45','UP55','UP64','UP37','UP46','UP56','UP65','UP38','UP47','UP57','UP66','UP40','UP50','UP58','UP67','UP41','UP51','UP60','UP78','UP42','UP52','UP61','UP43','UP53','UP62','UP28','UP30','UP31','UP32','UP33','UP34','UP93','UP92','UP71','UP79'],
  'RJ-1': ['RJ01','RJ03','RJ04','RJ06','RJ08','RJ09','RJ10','RJ12','RJ14','RJ15','RJ16','RJ17','RJ18','RJ19','RJ20','RJ22','RJ24','RJ27','RJ30','RJ33','RJ35','RJ38','RJ39','RJ43','RJ45','RJ46','RJ47','RJ54','RJ55','RJ57','RJ59','RJ60'],
  'RJ-3': ['RJ02','RJ29'],
  // MP-1 / KA-1 city-keyed clusters: RTO codes for Indore/Bhopal/Ujjain
  // and Bangalore/Mysore/Mangalore aren't enumerated in the source notes,
  // so the cluster mapping list stays empty — RTO column will be blank
  // for these rules but the City column carries the city names directly.
  'Ujjain, Indore, Bhopal':         [],
  'Bangalore, Mysore, Mangalore':   [],
  'DL-NCR': ['HR26','HR72','HR55','HR98','HR76','HR51','HR87','HR29','UP14','UP16','HR68','PB65','PB27','PB7'],
  // Plus all DL RTOs — covered by state-level fallback when policy RTO is DL*.
};

// Declined RTOs across all sheets (no payout) — sourced from footer notes.
// Encoded so the bulk pipeline surfaces "Declined by Universal Sompo"
// rather than "no matching rule".  Per-sheet scoping done at emit time.
const DECLINED_RTOS_HR = ['HR27', 'HR74'];                              // Nuh, Mewat
const DECLINED_RTOS_RJ = ['RJ02', 'RJ05', 'RJ11', 'RJ29'];              // Alwar/Bharatpur/Dholpur/Dausa
const DECLINED_RTOS_MP_CITIES = [
  'Morena','Bhind','Gwalior','Datia','Shivpuri','Sheopur','Chhatarpur',
  'Satna','Rewa','Sidhi','Singrauli','Umaria','Shahdol','Jabalpur','Katni',
  'Panna','Damoh','Sagar','Vidisha','Ashoknagar','Guna','Dindori','Mandla',
];

// ---------- Sliding-price tables ----------
//
// Non Tractor (5 bands, base = 80%):
//   Disc 65-69 → +5,  70-74 → +3,  75-79 → +2,  80 → base,  81-85 → -3
//
// Tractor: NO sliding price applies. Note reads
//   "No sliding price up-to T-90% Discount"
// → one rule per cell at the printed rate, with discount range 0-90.
const SLIDING_BANDS_NON_TRACTOR = [
  { tier: '65-69', delta: +5 },
  { tier: '70-74', delta: +3 },
  { tier: '75-79', delta: +2 },
  { tier: '80',    delta:  0 },
  { tier: '81-85', delta: -3 },
];
// Tractor flat band — single entry so the existing emit loop still works,
// but no fan-out happens.  Discount range 0-90 stored in volume_tier.
const SLIDING_BANDS_TRACTOR = [
  { tier: '0-90', delta: 0 },
];

// ---------- Helpers ----------
function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseRate(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

/** Apply a percentage-point delta to a base rate (both as decimals). */
function adjustRate(base, deltaPct) {
  return Math.max(0, +(base + deltaPct / 100).toFixed(6));
}

/** Pull state column metadata from the header row. Returns array of
 *  { col, code, state, sub } for every non-blank state column. */
function parseStateColumns(headerRow) {
  const out = [];
  for (let c = 1; c < headerRow.length; c++) {
    const code = cellOrNull(headerRow[c]);
    if (!code) continue;
    const upperCode = code.toUpperCase();
    const state = STATE_CODES[upperCode];
    if (!state) continue;
    out.push({
      col: c,
      code,
      state,
      sub: CLUSTER_SUBKEY[upperCode] || null,
    });
  }
  return out;
}

// ---------- Sheet handlers ----------

/**
 * Pvt Car sheet. 4 main rate rows + 1 special "5yr+ no addon" overlay:
 *
 *   R4  Package-NCB/New           → COMP, with-NCB OR new vehicle
 *   R5  SAOD-Non-NCB              → SAOD, non-NCB rolled-over
 *   R6  TP - Diesel + Bifuel      → SATP, fuel = Diesel/Bifuel/CNG
 *   R7  TP - Petrol + Electric    → SATP, fuel = Petrol/Electric
 *   R8  >5yr OLD (Without Addon)  → COMP+SAOD overlay, age 6-99,
 *                                   addon=N, applied_on=Net premium
 *
 * Package-NCB/New expands into two age_band variants per cell:
 *   • New vehicle  (vehicle_age 0..0, age_band 0..0)
 *   • With NCB     (vehicle_age 1..99, age_band 1..99)
 */
function parsePvtCar(stateCols, sheetData, dataStart, meta) {
  const rules = [];
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const label = cellOrNull(row[0]);
    if (!label) continue;
    const labelLower = label.toLowerCase();

    for (const sc of stateCols) {
      const v = parseRate(row[sc.col]);
      if (v == null) continue;
      const isDeclined = v === 0 || row[sc.col] === '-';
      const baseRule = {
        product:  'CAR',
        sheet_name: meta.sheetName,
        region:   sc.state,
        sub_type: sc.sub,
        make:     'All',
        rate_value: isDeclined ? null : v,
        is_declined: isDeclined,
        rate_text: `${sc.code} | ${label}`,
      };

      if (/^package[-\s]*ncb\/?new/i.test(labelLower)) {
        // Two variants: New vehicle (age 0/0) + With-NCB (age 1-99 + age_band 1-99)
        rules.push({ ...baseRule, segment: 'Pvt Car', rate_type: 'COMP',
                     vehicle_age_min: 0, vehicle_age_max: 0 });
        rules.push({ ...baseRule, segment: 'Pvt Car', rate_type: 'COMP',
                     vehicle_age_min: 1, vehicle_age_max: 99,
                     age_band_min: 1, age_band_max: 99 });
      } else if (/^saod[-\s]*non[-\s]*ncb/i.test(labelLower)) {
        rules.push({ ...baseRule, segment: 'Pvt Car', rate_type: 'SAOD',
                     age_band_min: 0, age_band_max: 0,
                     vehicle_age_min: 1, vehicle_age_max: 99 });
      } else if (/^tp.*diesel.*bifuel/i.test(labelLower)) {
        for (const f of ['Diesel', 'Bifuel', 'CNG']) {
          rules.push({ ...baseRule, segment: 'Pvt Car', rate_type: 'SATP', fuel_type: f });
        }
      } else if (/^tp.*petrol.*electric/i.test(labelLower)) {
        for (const f of ['Petrol', 'Electric', 'EV']) {
          rules.push({ ...baseRule, segment: 'Pvt Car', rate_type: 'SATP', fuel_type: f });
        }
      } else if (/more\s+than\s+5\s*yr.*without\s+addon/i.test(labelLower)) {
        // Overlay rule for vehicle age > 5 AND no addon — applies to both
        // COMP and SAOD, paid on Net premium.
        for (const rt of ['COMP', 'SAOD']) {
          rules.push({
            ...baseRule, segment: 'Pvt Car', rate_type: rt,
            vehicle_age_min: 6, vehicle_age_max: 99,
            addon: 'N', applied_on: 'NET',
            remarks: '>5 yr vehicle without addon — paid on net premium',
          });
        }
      }
      // Other rows (notes / blanks / footnotes) ignored.
    }
  }
  return rules;
}

/**
 * CV sheet — 6 GVW bands (0-3.5T, 3.5-7.5, 7.5-12, 12-20, 20-45, 45+).
 * Each cell is a COMP rate.  MH state has a special branch rule:
 * full grid if booking branch = MH, else −7%. Both variants are emitted.
 */
function parseCV(stateCols, sheetData, dataStart, meta) {
  const rules = [];
  // Keys are space-stripped + lowercased (matching the normalization done
  // below), so e.g. "45T Plus" → "45tplus".
  const GVW_BANDS = {
    '0t-3.5t':    { min: 0,    max: 3.5  },
    '3.5t-7.5t':  { min: 3.5,  max: 7.5  },
    '7.5t-12t':   { min: 7.5,  max: 12   },
    '12t-20t':    { min: 12,   max: 20   },
    '20t-45t':    { min: 20,   max: 45   },
    '45tplus':    { min: 45,   max: 999  },
    '45t+':       { min: 45,   max: 999  },
  };
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const label = cellOrNull(row[0]);
    if (!label) continue;
    const key = label.toLowerCase().replace(/\s+/g, '');
    const band = GVW_BANDS[key];
    if (!band) continue;   // skips footnote rows

    for (const sc of stateCols) {
      const raw = row[sc.col];
      const v = parseRate(raw);
      if (v == null) continue;
      const isDeclined = v === 0;
      const baseRule = {
        product:  'GCV',
        sheet_name: meta.sheetName,
        segment:  'GCV',
        region:   sc.state,
        sub_type: sc.sub,
        make:     'All',
        weight_band_min: band.min,
        weight_band_max: band.max,
        rate_type: 'COMP',
        is_declined: isDeclined,
        rate_text: `${sc.code} | ${label}`,
      };

      if (sc.state === 'MAHARASHTRA' && !isDeclined) {
        // Two variants per MH cell: branch=MH (full rate) vs non-MH (−7%)
        rules.push({ ...baseRule, rate_value: v,                          carrier_type: 'MH branch',     remarks: 'MH grid: booking branch = MH' });
        rules.push({ ...baseRule, rate_value: adjustRate(v, -7),          carrier_type: 'Non-MH branch', remarks: 'MH grid: booking branch ≠ MH (−7%)' });
      } else {
        rules.push({ ...baseRule, rate_value: isDeclined ? null : v });
      }
    }
  }
  return rules;
}

/**
 * Tractor sheet — 3 rate rows (New / Roll over / SATP) × sliding price
 * fan-out for each non-zero cell.
 *
 * SATP is IRDA-mandated and does NOT participate in sliding pricing —
 * emit single rule per cell at the printed rate.
 */
function parseTractor(stateCols, sheetData, dataStart, meta) {
  const rules = [];
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const label = cellOrNull(row[0]);
    if (!label) continue;
    const labelLower = label.toLowerCase();

    let rateType = null, ageMin = null, ageMax = null;
    if (/^new$/i.test(label))            { rateType = 'COMP'; ageMin = 0; ageMax = 0; }
    else if (/^roll\s*over$/i.test(label)) { rateType = 'COMP'; ageMin = 1; ageMax = 99; }
    else if (/^satp$/i.test(label))      { rateType = 'SATP'; }
    else continue;

    for (const sc of stateCols) {
      const v = parseRate(row[sc.col]);
      if (v == null) continue;
      const isDeclined = v === 0;
      const baseRule = {
        product:  'MISC',
        sheet_name: meta.sheetName,
        segment:  'Tractor',                                  // VehicleCategory → "Tractor"
        region:   sc.state,
        sub_type: sc.sub,
        make:     'All',
        vehicle_age_min: ageMin,
        vehicle_age_max: ageMax,
        rate_type: rateType,
        is_declined: isDeclined,
        rate_text: `${sc.code} | ${label}`,
      };

      if (isDeclined) {
        rules.push({ ...baseRule, rate_value: null });
        continue;
      }
      if (rateType === 'SATP') {
        rules.push({ ...baseRule, rate_value: v });
        continue;
      }
      // Sliding fan-out for COMP (New / Roll over)
      for (const slab of SLIDING_BANDS_TRACTOR) {
        rules.push({
          ...baseRule,
          rate_value: adjustRate(v, slab.delta),
          volume_tier: slab.tier,        // "65-69" / "80-90" / …
        });
      }
    }
  }
  return rules;
}

/**
 * PCV sheet — 4 rate rows (Package Non-Elec / Package Elec / SATP / Discount).
 * The "Discount" row is the per-state discount cap (single integer). It
 * is NOT emitted as a separate rule — instead its value is stamped onto
 * each Package / SATP row from the same column, encoded in volume_tier
 * so the export's inferRoyalDiscountBand renders min/max discount cols.
 *
 * Declined make/model: MG and BYD — emitted as is_declined rules per state.
 */
function parsePCV(stateCols, sheetData, dataStart, meta) {
  const rules = [];
  // First pass: locate the Discount row and capture per-column caps.
  const discountByCol = new Map();
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    if (/^discount$/i.test(String(row[0] || '').trim())) {
      for (const sc of stateCols) {
        const cap = parseFloat(String(row[sc.col] || '').replace(/[^\d.]/g, ''));
        if (Number.isFinite(cap) && cap > 0) discountByCol.set(sc.col, Math.round(cap));
      }
      break;
    }
  }

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const label = cellOrNull(row[0]);
    if (!label) continue;
    const labelLower = label.toLowerCase();

    let rateType = null, segment = 'PCV', fuel = null;
    if (/^package\s*\(non-electric\)/i.test(labelLower)) { rateType = 'COMP'; fuel = 'Petrol/Diesel/CNG'; }
    else if (/^package\s*electric/i.test(labelLower))    { rateType = 'COMP'; fuel = 'Electric'; }
    else if (/^pcv\s*satp\s*only/i.test(labelLower))     { rateType = 'SATP'; }
    else continue;

    for (const sc of stateCols) {
      const v = parseRate(row[sc.col]);
      if (v == null) continue;
      const isDeclined = v === 0;
      const cap = discountByCol.get(sc.col);
      const rule = {
        product:  'PCV',
        sheet_name: meta.sheetName,
        segment,
        region:   sc.state,
        sub_type: sc.sub,
        make:     'All',
        fuel_type: fuel,
        seating_capacity_max: 8,    // sheet title: "Up-to 8str Only"
        rate_type: rateType,
        rate_value: isDeclined ? null : v,
        is_declined: isDeclined,
        volume_tier: cap != null ? String(cap) : null,
        rate_text: `${sc.code} | ${label}` + (cap != null ? ` | Disc cap ${cap}%` : ''),
        remarks: 'ZD cover not allowed',
      };
      rules.push(rule);
    }
  }

  // Declined makes per Universal Sompo PCV: MG & BYD (across all states)
  for (const sc of stateCols) {
    for (const make of ['MG', 'BYD']) {
      rules.push({
        product: 'PCV',
        sheet_name: meta.sheetName,
        segment: 'PCV',
        region:  sc.state,
        sub_type: sc.sub,
        make,
        rate_type: 'COMP',
        rate_value: null,
        is_declined: true,
        rate_text: `${sc.code} | Declined make ${make}`,
        remarks: 'Universal Sompo declines this make/model on PCV',
      });
    }
  }

  return rules;
}

/**
 * Non Tractor sheet — 5 misc-D vehicle classes + SATP row.
 * Sliding fan-out for COMP rows (5 bands), single rule for SATP.
 */
function parseNonTractor(stateCols, sheetData, dataStart, meta) {
  const rules = [];
  // First pass: collect the 5 vehicle-class rows (col-0 label, COMP rates
  // per state) — needed to fan the SATP row out across them.  Per user's
  // direction, the 5 misc classes share VehicleCategory='Misc D' (segment
  // stays 'Misc-D' so the export's inferVehicleCategory hits the generic
  // Misc D branch); the specific class lives in `model` instead.
  const vehicleRows = [];   // [{ model, rowIdx }]
  let satpRowIdx = -1;
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const label = cellOrNull(row[0]);
    if (!label) continue;
    if (/^(misc-d.*terms|t-?d\b|discount%|payout|crane,\s*bacho|applicable for|sliding price)/i.test(label)) break;
    if (/^satp$/i.test(label)) {
      satpRowIdx = r;
      continue;
    }
    vehicleRows.push({ model: label, rowIdx: r });
  }

  const emit = (label, model, rateType, baseSpec, sc) => {
    const v = parseRate(sheetData[baseSpec.rowIdx][sc.col]);
    if (v == null) return;
    const isDeclined = v === 0;
    const baseRule = {
      product: 'MISC',
      sheet_name: meta.sheetName,
      // Segment carries the vehicle class as a "Misc-D | <class>" suffix
      // so the export's inferVehicleCategory can lift the class into the
      // VehicleCategory column (per user direction).  VehicleType column
      // still resolves to "MIS" via product.
      segment:  `Misc-D | ${model}`,
      model:    null,                      // Modal column stays blank
      region:   sc.state,
      sub_type: sc.sub,
      make:     'All',
      rate_type: rateType,
      is_declined: isDeclined,
      rate_text: `${sc.code} | ${label}`,
    };
    if (isDeclined) {
      rules.push({ ...baseRule, rate_value: null });
      return;
    }
    if (rateType === 'SATP') {
      rules.push({ ...baseRule, rate_value: v });
      return;
    }
    // COMP rows fan out across 5 sliding-discount bands.
    for (const slab of SLIDING_BANDS_NON_TRACTOR) {
      rules.push({
        ...baseRule,
        rate_value: adjustRate(v, slab.delta),
        volume_tier: slab.tier,
      });
    }
  };

  // COMP rows — one per vehicle class
  for (const sc of stateCols) {
    for (const vr of vehicleRows) {
      emit(vr.model, vr.model, 'COMP', vr, sc);
    }
  }
  // SATP row — fan out across the same 5 vehicle classes (SATP is a rate
  // type, not a vehicle category, per user's clarification).
  if (satpRowIdx >= 0) {
    for (const sc of stateCols) {
      for (const vr of vehicleRows) {
        emit('SATP', vr.model, 'SATP', { rowIdx: satpRowIdx }, sc);
      }
    }
  }
  return rules;
}

/**
 * PCV Short Term sheet — 3 GWP slabs × 7-seater + 8-seater split.
 * Title: "Seating capacity Up-to 7str Only". 8-seater = grid − 3%.
 *
 * Discount cap: 80% for most states; flat 60% for RJ / MP / HR.
 * Encoded in a sister "_disc" rule (not a separate row in the export);
 * we stash discount range in a per-rule field via volume_tier compound
 * "<slab> | Disc <range>".
 *
 * For consistency with PCV (Q6) we emit one rule per (state × slab ×
 * seating) at the rate value, and stash the discount cap as a separate
 * CD1 rule per state.  Reason: GWP slab already occupies volume_tier,
 * so we can't co-locate the discount integer in the same field.
 */
function parsePCVShort(stateCols, sheetData, dataStart, meta) {
  const rules = [];
  const SLABS = {
    'upto 5l':    { tier: 'Upto 5L',  vol_min: 0,  vol_max: 5  },
    'up to 5l':   { tier: 'Upto 5L',  vol_min: 0,  vol_max: 5  },
    '5 to 25l':   { tier: '5L-25L',   vol_min: 5,  vol_max: 25 },
    '5-25l':      { tier: '5L-25L',   vol_min: 5,  vol_max: 25 },
    'above 25l':  { tier: 'Above 25L', vol_min: 25, vol_max: '' },
  };

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const label = cellOrNull(row[0]);
    if (!label) continue;
    const key = label.toLowerCase().replace(/\s+/g, ' ').trim();
    const slab = SLABS[key];
    if (!slab) continue;     // footnote rows ignored

    for (const sc of stateCols) {
      const v = parseRate(row[sc.col]);
      if (v == null) continue;
      const isDeclined = v === 0;
      const stateLower = sc.state.toLowerCase();
      const flatDisc = (stateLower === 'rajasthan' || stateLower === 'madhya pradesh' || stateLower === 'haryana');
      const discMin = flatDisc ? 60 : 0;
      const discMax = flatDisc ? 60 : 80;

      const baseRule = {
        product:  'PCV',
        sheet_name: meta.sheetName,
        segment:  'PCV Short Term',
        region:   sc.state,
        sub_type: sc.sub,
        make:     'All',
        rate_type: 'COMP',
        is_declined: isDeclined,
        rate_text: `${sc.code} | ${label}` + (flatDisc ? ' | Disc flat 60%' : ' | Disc upto 80%'),
        remarks: 'ZD cover not allowed' + (flatDisc ? ' | Discount flat 60%' : ' | Discount upto 80%'),
      };

      // Two seating variants per cell: ≤7 (printed rate) and 8 (rate − 3%)
      const seatings = [
        { min: 1, max: 7, rate: v },
        { min: 8, max: 8, rate: adjustRate(v, -3) },
      ];

      for (const s of seatings) {
        rules.push({
          ...baseRule,
          seating_capacity_min: s.min,
          seating_capacity_max: s.max,
          rate_value: isDeclined ? null : s.rate,
          // Compound volume_tier: GWP slab; discount band encoded in
          // a separate CD1 rule so both columns populate cleanly.
          volume_tier: slab.tier,
        });
      }

      // Sister CD1 rule for the discount cap — one per (state, slab, seating).
      // Encoded as a rate_type='CD1' rule with rate_value=null and the
      // discount range in volume_tier ("Disc 0-80" / "Disc 60-60").
      // Not emitted for declined cells.
      if (!isDeclined) {
        for (const s of seatings) {
          rules.push({
            ...baseRule,
            seating_capacity_min: s.min,
            seating_capacity_max: s.max,
            rate_type: 'COMP_CD1',
            rate_value: discMax / 100,    // store discount cap as decimal so the merge picks it up
            is_declined: false,
            volume_tier: `Disc ${discMin}-${discMax}`,
          });
        }
      }
    }
  }
  return rules;
}

// ---------- Cluster RTO mappings ----------

/**
 * Emit synthetic rate_card rows of layout 'rto_mapping' so each declared
 * cluster's RTO list is registered in rto_mappings.  Called once per
 * upload (the engine module shares the same rate_card_id across all
 * sheets, and rto_mapping rows live in their own table).
 *
 * Strategy: prepend cluster rows to the rules array and tag them with
 * `_rto_mapping = true`; the upload route detects this and routes them
 * into rto_mappings instead of rate_rules.
 */
function emitClusterMappings(meta) {
  const rows = [];
  for (const [cluster, rtos] of Object.entries(CLUSTERS)) {
    for (const rto of rtos) {
      rows.push({
        // upload.js routes this into the rto_mappings table when
        // layout==='rto_mapping' (see routes/upload.js:173).
        layout: 'rto_mapping',
        insurer: meta.insurer,
        product: null,
        rto_code: rto,
        region: cluster,
        cluster,
      });
    }
  }
  return rows;
}

// ---------- Declined-RTO rules ----------

/**
 * Emit one `is_declined=true` rule per declined RTO so the bulk pipeline
 * surfaces "Declined by Universal Sompo" instead of "no matching rule".
 * Scoped per-product: Pvt Car / CV / PCV / Tractor / Misc-D get a
 * declined row each.
 */
function emitDeclinedRTOs(meta) {
  const out = [];
  const products = [
    { product: 'CAR',  segment: 'Pvt Car' },
    { product: 'GCV',  segment: 'GCV' },
    { product: 'PCV',  segment: 'PCV' },
    { product: 'MISC', segment: 'Tractor' },
    { product: 'MISC', segment: 'Misc-D' },
  ];

  const declined = [
    { rtos: DECLINED_RTOS_HR, state: 'HARYANA',   note: 'HR Nuh / Mewat' },
    { rtos: DECLINED_RTOS_RJ, state: 'RAJASTHAN', note: 'RJ Alwar / Bharatpur / Dholpur / Dausa' },
  ];

  for (const p of products) {
    for (const d of declined) {
      for (const rto of d.rtos) {
        out.push({
          product: p.product,
          sheet_name: meta.sheetName,
          segment: p.segment,
          region: d.state,
          make: 'All',
          rate_type: 'COMP',
          rate_value: null,
          is_declined: true,
          rate_text: `${rto} | Declined`,
          remarks: `Universal Sompo declined RTO (${d.note})`,
        });
      }
    }
    // MP belt — listed by city name, not RTO code.  Encoded under the
    // state-level region with the city in remarks; the bulk pipeline's
    // RTO→state matcher surfaces these as state-wide declines for the
    // MP cluster pending an explicit RTO master.
    for (const city of DECLINED_RTOS_MP_CITIES) {
      out.push({
        product: p.product,
        sheet_name: meta.sheetName,
        segment: p.segment,
        region: 'MADHYA PRADESH',
        sub_type: city,
        make: 'All',
        rate_type: 'COMP',
        rate_value: null,
        is_declined: true,
        rate_text: `MP ${city} | Declined`,
        remarks: `Universal Sompo declined RTO (MP — ${city})`,
      });
    }
  }
  return out;
}

// ---------- Cluster ↔ region swap ----------
//
// The Excel export's RTO lookup keys off `rule.region` against
// rto_mappings.region/cluster.  For rules with a cluster sub_type
// (DL-NCR, UP-1/2/3, RJ-1/2/3, MP-1/2, KA-1/2, GJ/DD, J&K/LA, NCR)
// we want the lookup to hit the cluster mappings — so swap:
//
//   pre :  region = "DELHI"      sub_type = "DL-NCR"  remarks = X
//   post:  region = "DL-NCR"     sub_type = "DL-NCR"  remarks = "DELHI | X"
//
// The export's State-col detection matches on remarks containing a
// known state name (compound-aware via "|" splits) so the State column
// still shows "Delhi" / "Uttar Pradesh" / etc. and the RTO codes from
// the cluster mapping populate RTOCode.
function swapClusterRegion(rule) {
  if (!rule || rule._rto_mapping || rule.layout === 'rto_mapping') return rule;
  const sub = rule.sub_type;
  if (!sub) return rule;
  // Only swap when sub_type is one of the cluster keys we emit — leave
  // declined-RTO rows (sub_type = city name) alone.
  const isCluster = /^(DL-NCR|NCR|UP-[123]|RJ-[123]|GJ\/DD|J&K\/LA|Ujjain|Bangalore|Rest of (MP|KA))/.test(sub);
  if (!isCluster) return rule;
  const state = rule.region;
  if (!state) return rule;
  rule.region = sub;
  rule.remarks = rule.remarks ? `${state} | ${rule.remarks}` : state;
  return rule;
}

// ---------- Top-level dispatch ----------

function parse(sheetData, sheetConfig, meta) {
  const headerRow = sheetData[sheetConfig.header_row] || [];
  const stateCols = parseStateColumns(headerRow);
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row : (sheetConfig.header_row + 1);
  const kind = sheetConfig.sheet_kind || '';

  let rules = [];
  switch (kind) {
    case 'pvt_car':     rules = parsePvtCar(stateCols, sheetData, dataStart, meta); break;
    case 'cv':          rules = parseCV(stateCols, sheetData, dataStart, meta);     break;
    case 'tractor':     rules = parseTractor(stateCols, sheetData, dataStart, meta); break;
    case 'pcv':         rules = parsePCV(stateCols, sheetData, dataStart, meta);    break;
    case 'non_tractor': rules = parseNonTractor(stateCols, sheetData, dataStart, meta); break;
    case 'pcv_short':   rules = parsePCVShort(stateCols, sheetData, dataStart, meta); break;
    default:
      console.warn(`[universal-sompo] unknown sheet_kind "${kind}" for sheet "${meta.sheetName}"`);
  }

  // Append declined-RTO carve-outs and the cluster→RTO mappings — emit
  // them once on the Pvt Car sheet so they don't duplicate six times.
  // Cluster mappings carry layout='rto_mapping' which upload.js routes
  // into the rto_mappings table instead of rate_rules.
  if (kind === 'pvt_car') {
    rules.push(...emitDeclinedRTOs(meta));
    rules.push(...emitClusterMappings(meta));
  }

  // Swap (region <-> sub_type) for cluster rules so the export's RTO
  // lookup matches the cluster mapping rows.
  for (const r of rules) swapClusterRegion(r);

  return rules;
}

module.exports = {
  parse,
  emitClusterMappings,   // exposed for upload route to emit RTO rows
  CLUSTERS,
  STATE_CODES,
};
