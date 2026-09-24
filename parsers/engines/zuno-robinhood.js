/**
 * Zuno General Insurance — "Robinhood" broker payout grid (w.e.f. 01-Apr-2026).
 *
 * Source: "Zuno Robinhood PO_ 01-April -26.xlsx", single sheet "BROKERS".
 *
 * Layout (one workbook, one sheet, two sections):
 *
 *   Section 1 — rows 1-22: per-product-line per-region rate table.
 *     Cols: B=Product Line | C=Region/RTO/Zone | D=With NCB (rate) | E=Logic | F=Remarks
 *     Product Lines: Pvt Car Package Comp (Rollover/Renewal), Pvt Car SAOD,
 *       High End, TW NEW, TW TP, Pvt Car TP Only, Pvt new car business.
 *     Region cells often pack multiple states ("North only Delhi NCR,
 *       Chandigarh, Mohali and Panchkula, UP") — fanned out into one rule
 *       per state.
 *     Note row (22): tiered OD-discount payout for Pvt Car —
 *       OD ≥85%  → 19.5% PO
 *       OD ≥90%  → 17.5% PO
 *       NCB = 0  → 15% PO
 *
 *   Section 2 — rows 24-43: state × vehicle-type commercial grid.
 *     Cols: B=Doable State | C=3W GCV | D=3W PCV
 *           E=GCV ≤2.5 TP&Package (Tata/Maruti/Mahindra/Ashok Leyland)
 *           F=GCV 2.5-3.5 TP&Package (same makes)
 *           G=Staff Bus TP&Package
 *           H=Tractor w/ or w/o Single Registered Trailer TP&Package
 *     Empty cells = product not applicable in that state (skip).
 *     "Except PB12 & PB24" / "Except UK01, UK02, UK16 & UK18" in state names —
 *       emit explicit ZERO-rate rules for each excluded RTO so the grid
 *       documents the carve-out.
 *
 * COMP-style products (Pvt Car Package, High End, Pvt new car business,
 * GCV ≤2.5, GCV 2.5-3.5, Staff Bus, Tractor) are emitted as OD+TP pair so
 * the export's mergeOdTpPairs folds them into one display row.
 *
 * SAOD-only / TP-only products are emitted as single rules with the
 * appropriate applied_on.
 *
 * Entry: parse(sheetData, sheetConfig, meta) → rule[]
 */

// ----------------------------------------------------------------------------
// Section-1 region label → state list. Used to fan a packed region string
// (e.g. "North only Delhi NCR, Chandigarh, Mohali and Panchkula, UP") into
// per-state rules. Order matches the operator's typical state lookup.
// ----------------------------------------------------------------------------
const REGION_TO_STATES = {
  'North only Delhi NCR, Chandigarh, Mohali and Panchkula, UP':
    ['Delhi', 'Chandigarh', 'Punjab', 'Haryana', 'Uttar Pradesh'],
  'Gujarat except Surat (GJ-05)': ['Gujarat'],
  'Gujarat except Surat (GJ-05) Without NCB': ['Gujarat'],
  'APTS': ['Andhra Pradesh', 'Telangana'],
  'Chennai only': ['Tamil Nadu'],
  'Karnataka': ['Karnataka'],
  'Maharashtra except Aurangabad & Nasik RTOs': ['Maharashtra'],
  'East except North East':
    ['West Bengal', 'Odisha', 'Bihar', 'Jharkhand', 'Sikkim'],
  // Pvt Car TP Only region buckets
  'North': ['Delhi', 'Punjab', 'Haryana', 'Chandigarh', 'Himachal Pradesh',
            'Jammu & Kashmir', 'Uttar Pradesh', 'Uttarakhand', 'Rajasthan'],
  'South': ['Karnataka', 'Tamil Nadu', 'Kerala', 'Andhra Pradesh',
            'Telangana', 'Puducherry'],
  'West': ['Maharashtra', 'Gujarat', 'Goa', 'Madhya Pradesh', 'Chhattisgarh',
           'Daman & Diu', 'Dadra & Nagar Haveli'],
  'East': ['West Bengal', 'Odisha', 'Bihar', 'Jharkhand', 'Sikkim',
           'Assam', 'Meghalaya', 'Manipur', 'Tripura', 'Nagaland',
           'Mizoram', 'Arunachal Pradesh'],
};

// High-End preferred cities — each city becomes its own rule with both
// the city (region) and parent state populated, so the export's City and
// State columns are filled distinctly.
const HIGH_END_CITIES = [
  { city: 'Bengaluru',  state: 'Karnataka' },
  { city: 'Delhi',      state: 'Delhi' },
  { city: 'Hyderabad',  state: 'Telangana' },
  { city: 'Mumbai',     state: 'Maharashtra' },
  { city: 'Pune',       state: 'Maharashtra' },
  { city: 'Kolkata',    state: 'West Bengal' },
  { city: 'Ahmedabad',  state: 'Gujarat' },
  { city: 'Chandigarh', state: 'Chandigarh' },
  { city: 'Nagpur',     state: 'Maharashtra' },
  { city: 'Surat',      state: 'Gujarat' },
];

// ----------------------------------------------------------------------------
// Section-2 state-name normalisation (xlsx uses some shortened/typo forms)
// and the RTO carve-outs that need explicit ZERO-rate rules.
// ----------------------------------------------------------------------------
const STATE_ALIASES = {
  'Gujrat': 'Gujarat',
  'KA': 'Karnataka',
  // 'Mumbai' deliberately not aliased here — handled via CITY_TO_STATE so
  // the city name is preserved separately from the parent state row.
  'Maharastra': 'Maharashtra',
  'UP': 'Uttar Pradesh',
  'AP': 'Andhra Pradesh',
  'TS': 'Telangana',
  'TN': 'Tamil Nadu',
  'Chattishgarh': 'Chhattisgarh',
  'UK': 'Uttarakhand',
  'J&K': 'Jammu & Kashmir',
  'Daman': 'Daman & Diu',
  'Dadar': 'Dadra & Nagar Haveli',
};

// Cities that should be surfaced separately from their parent state when
// they appear as standalone rows in the xlsx (so the export's City column
// is populated for the row). e.g. "Mumbai" alongside "Maharastra".
const CITY_TO_STATE = {
  'Mumbai':       'Maharashtra',
  'Gurgaon':      'Haryana',
  'Faridabad':    'Haryana',
  'Ballabhgarh':  'Haryana',
};

// Parse a Doable-State cell into one or more { state, city, excluded } entries.
// Examples:
//   "Punjab ( Except PB12 & PB24 )" → [{ state:'Punjab', excluded:['PB12','PB24']}]
//   "UK ( Except UK01, UK02, UK16 & UK18 )" → [{state:'Uttarakhand', excluded:[…]}]
//   "Mumbai" → [{ state:'Maharashtra', city:'Mumbai' }]
//   "Delhi, Gurgaon, Faridabad & Ballabhgarh" → 4 rows:
//     [{state:'Delhi'}, {state:'Haryana', city:'Gurgaon'},
//      {state:'Haryana', city:'Faridabad'}, {state:'Haryana', city:'Ballabhgarh'}]
function parseStateCell(cell) {
  const raw = String(cell || '').trim();
  if (!raw) return [];

  // Pull excluded RTO codes if the cell contains "Except <list>".
  const exceptMatch = raw.match(/except\s+([^)]+?)\s*\)?\s*$/i);
  const excluded = exceptMatch
    ? (exceptMatch[1].match(/[A-Z]{2}\s*\d{1,3}[A-Z]?/gi) || [])
        .map(s => s.replace(/\s+/g, '').toUpperCase())
    : [];
  // Strip the "( Except ... )" tail to get the bare cell text.
  const bare = raw.replace(/\s*\(.*$/, '').trim();

  // Whole-cell alias check first — "J&K" must not be split on the `&`.
  if (STATE_ALIASES[bare]) return [{ state: STATE_ALIASES[bare], excluded }];

  // Multi-token cell: "Delhi, Gurgaon, Faridabad & Ballabhgarh"
  if (/[,&]/.test(bare)) {
    const tokens = bare.split(/[,&]/).map(t => t.trim()).filter(Boolean);
    return tokens.map(tok => {
      if (CITY_TO_STATE[tok]) return { state: CITY_TO_STATE[tok], city: tok, excluded: [] };
      const stateName = STATE_ALIASES[tok] || tok;
      return { state: stateName, excluded: [] };
    });
  }

  // Single city → state + city (so the City column populates).
  if (CITY_TO_STATE[bare]) {
    return [{ state: CITY_TO_STATE[bare], city: bare, excluded }];
  }
  // Single state via alias / bare.
  return [{ state: STATE_ALIASES[bare] || bare, excluded }];
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const cell = v => v == null ? '' : String(v).trim();

function pushComp(rules, base, rate) {
  // OD + TP halves at same rate so mergeOdTpPairs folds them into one row.
  rules.push({ ...base, applied_on: 'OD', rate_value: rate });
  rules.push({ ...base, applied_on: 'TP', rate_value: rate });
}

// ----------------------------------------------------------------------------
// Section 1 — Product Line × Region rate table (rows 1-22)
// ----------------------------------------------------------------------------
// Maps the xlsx Product Line label to (product, segment, rateType, applied_on,
// how-to-emit). emitMode:
//   'comp'    → OD + TP halves at same rate (Pvt Car Package, High End, Pvt
//                new car biz)
//   'saod'    → OD only
//   'satp'    → TP only
//   'satp_tw' → TP only for TW
//   'new_tw'  → both OD+TP at the same rate (TW NEW = bundled 1+5 — but the
//                rate cell was empty in the source, so we emit 0%)
const PRODUCT_LINES = {
  'Pvt Car Package Comp (Rollover/Renewal)':
    { product: 'CAR', segment: 'Pvt Car', rate_type: 'COMP', emit: 'comp', sub_type: 'Rollover/Renewal' },
  // July'26: NEW headline comp-with-NCB rate, Pan India 38%. Applies to comp
  // business that is NOT rollover/renewal (bulk.js gates by business type; the
  // region-specific 30% Rollover/Renewal rows win by specificity for those).
  'Pvt Car Package With NCB':
    { product: 'CAR', segment: 'Pvt Car', rate_type: 'COMP', emit: 'comp', sub_type: 'With NCB' },
  'PVT car Pakage With NCB':   // operator's July'26 spelling (typo "Pakage")
    { product: 'CAR', segment: 'Pvt Car', rate_type: 'COMP', emit: 'comp', sub_type: 'With NCB' },
  'Pvt Car SAOD':
    { product: 'CAR', segment: 'Pvt Car', rate_type: 'SAOD', emit: 'saod' },
  // "High End" → segment carries the marker so the export's inferHEV() tags
  // the Highend column = Yes. We further fan out into one rule per approved
  // luxury make so each make is a first-class entry (Mercedes-Benz, BMW,
  // Audi, Volvo, Land Rover, Mini, Jaguar). Max IDV = Rs. 1.75 Cr and the
  // 7 mandatory add-ons are captured in remarks.
  'High End':
    { product: 'CAR', segment: 'Pvt Car High End', rate_type: 'COMP', emit: 'comp',
      makes: ['Mercedes-Benz', 'BMW', 'Audi', 'Volvo', 'Land Rover', 'Mini', 'Jaguar'],
      remarks_prefix: 'High End — Max IDV Rs. 1.75 Cr. Mandatory add-ons: Zero Dep, Engine Protect (preferred 0-2 yrs), RTI (preferred 0-2 yrs), Tyre Secure, Key Protection, Consumables, Roadside Assistance.' },
  'TW NEW':
    { product: 'TW',  segment: 'TW', rate_type: 'COMP_1+5', emit: 'new_tw' },
  'TW TP':
    { product: 'TW',  segment: 'TW', rate_type: 'SATP', emit: 'satp_tw' },
  'TW TP Only':   // July'26 rename of "TW TP"
    { product: 'TW',  segment: 'TW', rate_type: 'SATP', emit: 'satp_tw' },
  'Pvt Car TP Only':
    { product: 'CAR', segment: 'Pvt Car', rate_type: 'SATP', emit: 'satp' },
  'Pvt new car business':
    { product: 'CAR', segment: 'Pvt Car', rate_type: 'COMP_1+3', emit: 'comp',
      vehicle_age_min: 0, vehicle_age_max: 0,
      remarks_prefix: 'New Vehicle Business (1+3 bundled) — No linked discount with payout.' },
};

// Tiered overrides from the note row. The two OD-discount tiers populate
// the Min/Max Discount columns via `volume_tier` (which the export's
// inferRoyalDiscountBand() reads). The NCB=0 tier isn't a discount band,
// so it surfaces in Sub Modal via `sub_type` instead.
const PVT_CAR_DISCOUNT_TIERS = [
  { trigger: 'OD discount ≥ 85% (but < 90%)', volume_tier: '85-89', rate: 0.195 },
  { trigger: 'OD discount ≥ 90%',             volume_tier: '> 90',  rate: 0.175 },
  { trigger: 'NCB = 0',                       sub_type:    'NCB=0', rate: 0.15  },
];

function emitSection1Row(rules, meta, productLine, regionLabel, rate, addon) {
  const cfg = PRODUCT_LINES[productLine];
  if (!cfg) {
    console.warn(`[zuno] unknown product line: ${productLine}`);
    return;
  }
  // NCB qualifier: column header in source xlsx reads "With NCB" — meaning
  // every Section 1 rate applies for NCB 1-99 (any positive NCB). The
  // explicit "<region> Without NCB" rows carry NCB=0 instead. The discount-
  // tier note row also emits a separate global NCB=0 → 15% override rule.
  const isWithoutNcb = /without\s*ncb/i.test(regionLabel);
  const ncbBand = isWithoutNcb ? 'NCB = 0' : 'NCB 1-99';
  // Pan India / "All doable RTO" rows: emit a single rule with no state.
  const isPan = /pan\s*india/i.test(regionLabel) ||
                /all\s*doable\s*RTO/i.test(regionLabel);
  // Normalize a "Pan India" region to the pooled candidate label so the
  // bulk candidate-region list ('Pan India (doable RTOs)') actually reaches it.
  const panRegion = /pan\s*india/i.test(regionLabel) ? 'Pan India (doable RTOs)' : regionLabel;
  // High End → per-city fanout (each city + its parent state, surfaced
  // in the City and State columns). Other product lines → per-state fanout.
  const isHighEnd = productLine === 'High End';
  const targets = isPan
    ? [{ state: null, city: null }]
    : isHighEnd
      ? HIGH_END_CITIES.map(c => ({ state: c.state, city: c.city }))
      : (REGION_TO_STATES[regionLabel] || [null]).map(s => ({ state: s, city: null }));

  // Fan out per approved make when the product line carries a make-restricted
  // list (High End). Otherwise emit a single make='All' rule.
  const makesList = cfg.makes || ['All'];
  for (const t of targets) {
    const state = t.state;
    const city  = t.city;
    for (const make of makesList) {
      const labelLoc = city ? `${city} (${state})` : (state || regionLabel);
      const base = {
        product: cfg.product,
        sheet_name: meta.sheetName,
        segment: cfg.segment,
        make: make,
        state: state || undefined,
        region: city || state || (isPan ? panRegion : regionLabel),  // city > state > (pooled Pan India | raw label)
        sub_type: cfg.sub_type || null,
        addon: addon || null,   // Sep26: "Without Add-on"=No vs "With Add-on"=Yes blocks
        rate_type: cfg.rate_type,
        vehicle_age_min: cfg.vehicle_age_min ?? null,
        vehicle_age_max: cfg.vehicle_age_max ?? null,
        is_declined: false,
        remarks: (cfg.remarks_prefix ? cfg.remarks_prefix + ' | ' : '') +
                 `${productLine} | ${labelLoc}` +
                 (cfg.makes ? ` | ${make}` : '') +
                 ` | ${ncbBand} | rate applies to OD & TP`,
        rate_text: `Zuno ${productLine}${cfg.makes ? ' ' + make : ''} | ${labelLoc} | ${ncbBand} | ${(rate*100).toFixed(2)}%`,
      };

      switch (cfg.emit) {
        case 'comp':    pushComp(rules, base, rate); break;
        case 'new_tw':  pushComp(rules, base, rate); break;
        case 'saod':    rules.push({ ...base, applied_on: 'OD', rate_value: rate }); break;
        case 'satp':    // fall through
        case 'satp_tw': rules.push({ ...base, applied_on: 'TP', rate_value: rate }); break;
        default:        console.warn(`[zuno] unknown emit mode: ${cfg.emit}`);
      }
    }
  }
}

function emitPvtCarDiscountTiers(rules, meta) {
  for (const t of PVT_CAR_DISCOUNT_TIERS) {
    pushComp(rules, {
      product: 'CAR',
      sheet_name: meta.sheetName,
      segment: 'Pvt Car',
      make: 'All',
      region: 'Pan India (doable RTOs)',
      // OD-discount tiers go to volume_tier (→ Min/Max Discount columns).
      // The NCB=0 tier has no OD discount band — it surfaces via sub_type
      // in the Sub Modal column instead.
      volume_tier: t.volume_tier || null,
      sub_type:    t.sub_type    || null,
      rate_type: 'COMP',
      is_declined: false,
      remarks: `Pvt Car discount override — ${t.trigger} → payout ${(t.rate*100).toFixed(2)}% | rate applies to OD & TP`,
      rate_text: `Zuno Pvt Car ${t.trigger} | ${(t.rate*100).toFixed(2)}%`,
    }, t.rate);
  }
}

// ----------------------------------------------------------------------------
// Section 2 — State × Vehicle Type commercial grid (rows 24-43)
// ----------------------------------------------------------------------------
// Column index → product/segment metadata for the commercial grid.
//   C(2)=3W GCV | D(3)=3W PCV
//   E(4)=GCV ≤2.5 TP&Package (Tata/Maruti/Mahindra/Ashok Leyland)
//   F(5)=GCV 2.5-3.5 TP&Package (same makes)
//   G(6)=Staff Bus TP&Package
//   H(7)=Tractor w/ or w/o single trailer TP&Package
const RESTRICTED_MAKES = ['Tata', 'Maruti', 'Mahindra', 'Ashok Leyland'];

// `dual: true` → emit two rules per state at the same rate: one COMP
// (OD+TP halves) and one SATP (TP only). Used for Staff Bus where the
// column header "Staff Bus (TP & Package)" means the rate applies to both
// the standalone-TP product AND the Package product.
const SEC2_COLS = [
  // Columns are resolved from the section-2 header row by `match` (NOT by a
  // fixed index): the operator reflows this grid between months — Sep'26 both
  // dropped the leading blank column A and inserted a new "3.5 to 7.5" column,
  // which silently shifted Staff Bus / Tractor under positional parsing.
  { match: /3\s*W\s*GCV/i, product: 'GCV', segment: '3W GCV', dual: true,
    label: '3W GCV TP & Package' },
  { match: /3\s*W\s*PCV/i, product: 'PCV', segment: '3W PCV',
    label: '3W PCV TP & Package' },
  { match: /upto\s*2\.5/i, product: 'GCV', segment: 'GCV', dual: true,
    weight_min: 0,   weight_max: 2.5,
    makes: RESTRICTED_MAKES,
    label: 'GCV <=2.5T TP & Package (Tata/Maruti/Mahindra/Ashok Leyland)' },
  { match: /2\.5\s*to\s*3\.5/i, product: 'GCV', segment: 'GCV', dual: true,
    weight_min: 2.5, weight_max: 3.5,
    makes: RESTRICTED_MAKES,
    label: 'GCV 2.5-3.5T TP & Package (Tata/Maruti/Mahindra/Ashok Leyland)' },
  { match: /3\.5\s*to\s*7\.5/i, product: 'GCV', segment: 'GCV', dual: true,
    weight_min: 3.5, weight_max: 7.5,
    makes: RESTRICTED_MAKES,
    label: 'GCV 3.5-7.5T TP & Package (Tata/Maruti/Mahindra/Ashok Leyland)' },
  { match: /staff\s*bus/i, product: 'PCV', segment: 'Staff Bus', dual: true,
    label: 'Staff Bus TP & Package' },
  { match: /tractor/i, product: 'GCV', segment: 'Tractor', dual: true,
    label: 'Tractor (with or w/o single registered trailer) TP & Package' },
];

function emitSection2Row(rules, meta, entry, row, cols) {
  // entry: { state, city?, excluded[] } — one parsed token from the row's
  // first column. State must always be set; city is optional.
  if (!entry || !entry.state) return;
  const state = entry.state;
  const city = entry.city || null;
  const excluded = entry.excluded || [];

  // Every SEC2 column produces a rule for every state row, even when the
  // source cell is blank — blanks become explicit 0% rules so the grid
  // documents which products are inapplicable in each state (e.g. TN has
  // no Staff Bus/Tractor entries; Goa has no GCV ≤2.5 / 2.5-3.5 / Tractor;
  // UK has only the GCV mid-tier; Daman / Dadar are all-zero).
  for (const def of (cols || SEC2_COLS)) {   // cols = header-resolved indices
    const raw = cell(row[def.col]);
    const rate = raw ? parseFloat(raw) : NaN;
    const rateValue = (isNaN(rate) || rate < 0)
      ? 0
      : (rate > 1 ? rate / 100 : rate);  // "40" → 0.40
    const isZero = rateValue === 0;

    // Loop body uses `state` directly; the legacy outer `for (const state of stateNames)`
    // is gone — entry already carries a single state.
    {
      const locLabel = city ? `${city} (${state})` : state;
      // Restricted-make rows: one rule per allowed make. Otherwise, single
      // make='All' rule.
      const makesList = def.makes || ['All'];
      for (const make of makesList) {
        const baseCommon = {
          product: def.product,
          sheet_name: meta.sheetName,
          segment: def.segment,
          state: state,
          region: city || state,           // city wins → populates City column
          make: make,
          weight_band_min: def.weight_min ?? null,
          weight_band_max: def.weight_max ?? null,
          is_declined: false,
          remarks: `${def.label} | ${locLabel}` +
                   (excluded.length ? ` (Except ${excluded.join(', ')})` : '') +
                   (isZero ? ' — 0% (no payout for this column in this location per source grid)' : '') +
                   ` | rate applies to OD & TP`,
          rate_text: `Zuno ${def.label} | ${locLabel}${excluded.length ? ' except ' + excluded.join('/') : ''} | ${(rateValue*100).toFixed(2)}%`,
        };
        // COMP (Package) — emit OD + TP halves at the same rate.
        pushComp(rules, { ...baseCommon, rate_type: 'COMP' }, rateValue);
        // Dual products: when column header is "<X> (TP & Package)" emit
        // an additional SATP-only rule at the same rate (currently used
        // for Staff Bus per operator spec — col 6).
        if (def.dual) {
          rules.push({
            ...baseCommon, rate_type: 'SATP',
            applied_on: 'TP', rate_value: rateValue,
            remarks: baseCommon.remarks + ' | also applicable to standalone TP',
          });
        }
      }
      // Excluded RTOs → ZERO-rate rules (same shape as the parent state row).
      for (const rto of excluded) {
        const makesList2 = def.makes || ['All'];
        for (const make of makesList2) {
          const zeroBase = {
            product: def.product,
            sheet_name: meta.sheetName,
            segment: def.segment,
            state: state,
            region: rto,
            sub_type: rto,                   // → RTOCode column
            make: make,
            weight_band_min: def.weight_min ?? null,
            weight_band_max: def.weight_max ?? null,
            is_declined: false,
            remarks: `${def.label} | Excluded RTO ${rto} (${state}) — 0% (carve-out from parent state grid)`,
            rate_text: `Zuno ${def.label} | ${state} ${rto} | 0%`,
          };
          pushComp(rules, { ...zeroBase, rate_type: 'COMP' }, 0);
          if (def.dual) {
            rules.push({ ...zeroBase, rate_type: 'SATP', applied_on: 'TP', rate_value: 0 });
          }
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Entry — parse the entire BROKERS sheet
// ----------------------------------------------------------------------------
function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  if (!Array.isArray(sheetData) || sheetData.length === 0) return rules;

  // ---- Resolve the column layout from the HEADER ROWS ----------------------
  // Never trust fixed column indices: the operator reflows this sheet between
  // months. Sep'26 dropped the leading blank column A (shifting every column
  // left by one) AND inserted a new "3.5 to 7.5" GCV band mid-grid, which under
  // the old positional parsing silently pushed Staff Bus / Tractor one column
  // off. Positional parsing produced ZERO rules for that file.
  const findIdx = (row, re) => (row || []).findIndex((c) => re.test(cell(c)));

  // Section-1 header rows carry "Product Line" + "Region/RTO/Zone". There can be
  // MORE THAN ONE: Sep'26 splits Pvt Car Package into a "Without Add-on With NCB"
  // block and a "With Add-on & NCB" block, each with its own rate column.
  const s1Headers = [];
  let s2Header = -1;
  for (let r = 0; r < sheetData.length; r++) {
    const row = sheetData[r] || [];
    const plCol = findIdx(row, /^product\s*line$/i);
    const regionCol = findIdx(row, /region\s*\/?\s*rto/i);
    if (plCol >= 0 && regionCol >= 0) {
      const rateCol = regionCol + 1;
      const rateHdr = cell(row[rateCol]);
      const addon = /without\s*add[\s-]*on/i.test(rateHdr) ? 'No'
                  : /with\s*add[\s-]*on/i.test(rateHdr) ? 'Yes'
                  : null;   // Apr/Jul grids: plain "With NCB" — no add-on dimension
      s1Headers.push({ row: r, plCol, regionCol, rateCol, addon });
      continue;
    }
    if (s2Header < 0 && findIdx(row, /^doable\s*state$/i) >= 0) s2Header = r;
  }

  const blockEnd = (i) => (i + 1 < s1Headers.length)
    ? s1Headers[i + 1].row
    : (s2Header >= 0 ? s2Header : sheetData.length);

  // Walk one section-1 block, calling back with (productLine, region, rate).
  const walkBlock = (h, end, cb) => {
    let currentPL = null;
    for (let r = h.row + 1; r < end; r++) {
      const row = sheetData[r] || [];
      const c1 = cell(row[h.plCol]);
      const c2 = cell(row[h.regionCol]);
      const c3 = cell(row[h.rateCol]);
      if (c1) currentPL = c1;
      if (/^note\s*:/i.test(currentPL || '') || /^note\s*:/i.test(c1)) {
        cb(null, null, null, true);   // note row → discount tiers
        currentPL = null;
        continue;
      }
      if (!c2) continue;
      const rate = c3 ? parseFloat(c3) : NaN;
      if (isNaN(rate) || rate <= 0) {
        if (currentPL && /^TW\s/i.test(currentPL)) cb(currentPL, c2, 0, false);
        continue;
      }
      cb(currentPL, c2, rate > 1 ? rate / 100 : rate, false);
    }
  };

  // Pass 1 — which product lines appear in MORE THAN ONE block? Only those are
  // genuine add-on variants. Products that merely sit below the second header
  // (Pvt Car TP Only, Pvt new car business) must NOT inherit its add-on flag.
  const seenBy = new Map();
  s1Headers.forEach((h, i) => walkBlock(h, blockEnd(i), (pl) => {
    if (!pl) return;
    if (!seenBy.has(pl)) seenBy.set(pl, new Set());
    seenBy.get(pl).add(i);
  }));
  const isSplit = (pl) => (seenBy.get(pl) || new Set()).size > 1;

  // Pass 2 — emit.
  let notesDone = false;
  s1Headers.forEach((h, i) => walkBlock(h, blockEnd(i), (pl, region, rate, isNote) => {
    if (isNote) {
      if (!notesDone) { emitPvtCarDiscountTiers(rules, meta); notesDone = true; }
      return;
    }
    emitSection1Row(rules, meta, pl, region, rate, isSplit(pl) ? h.addon : null);
  }));

  // ---- Section 2 — State × Vehicle Type grid -------------------------------
  if (s2Header >= 0) {
    const hdr = sheetData[s2Header] || [];
    const stateCol = findIdx(hdr, /^doable\s*state$/i);
    // Bind each product column to a real index by matching its header text.
    const cols = SEC2_COLS
      .map((def) => ({ ...def, col: findIdx(hdr, def.match) }))
      .filter((def) => def.col >= 0);
    for (const def of SEC2_COLS) {
      if (findIdx(hdr, def.match) < 0) {
        console.warn(`[zuno] section-2 column not found in header: ${def.label}`);
      }
    }
    for (let r = s2Header + 1; r < sheetData.length; r++) {
      const row = sheetData[r] || [];
      const c1 = cell(row[stateCol]);
      if (!c1) continue;
      if (/^(fleet|for\s*mmv|guidelines|approved\s*luxury|preferred\s*makes|mandatory\s*add|all\s*policies|zero\s*dep|engine\s*protect|return\s*to\s*invoice|tyre|key\s*prot|consumables|roadside|^\d+\.)/i.test(c1)) {
        break;
      }
      const entries = parseStateCell(c1);
      if (!entries || entries.length === 0) continue;
      for (const entry of entries) {
        emitSection2Row(rules, meta, entry, row, cols);
      }
    }
  }

  return rules;
}

module.exports = { parse };
