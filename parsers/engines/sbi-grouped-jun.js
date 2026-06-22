/**
 * SBI grouped-columns parser — JUNE'26 split-sheet layout.
 *
 * June restructured the single April "A&B Cat Broker" sheet into two:
 *   - "GCV & Pvt Car Payout Condition"  (sheet_kind: 'gcv_pvtcar')
 *   - "PCV, MISD & TW"                   (sheet_kind: 'pcv_misd_tw')
 *
 * Differences from the April engine (sbi-grouped.js), confirmed against the
 * June file's headers:
 *   - GCV/PvtCar sheet is keyed by RTO CLUSTER NAME (col 1, e.g. "TN - Rest")
 *     + State (col 2). The cluster code matches the SBI RTO-master names, so
 *     region = cluster code directly (plus a canonical-state alias row).
 *   - PCV/MISD/TW sheet keeps the April Zone|State|Circle keys (col 0 = "East 1").
 *   - Many GCV/PvtCar columns are headed "Comp /SATP (Net)" — one number that
 *     applies to BOTH Comprehensive and SATP (user-confirmed) → emit a COMP rule
 *     and an SATP rule sharing the value. "New-Comp (Net)" columns are COMP-only.
 *   - Per-band age tiers: New → age 0/0, "Upto 5 Year"/"Age 1-5" → 1/5,
 *     "Above 5 Year" → 6/99, ">40T Age upto 5" → 0/5.
 *
 * Shared logic (premium slabs, taxi NCB-5% split, declined rows) is reused
 * from the April engine.
 */
const base = require('./sbi-grouped');
const { irdaRateFor } = require('../utils/irda-rates');
const { parseStateField, parseRate, cellOrNull, findClustersForRow, PREMIUM_SLABS, rateForSlab, ZONES } = base;

// ---- Age-tier shorthand ----
const NEW = { vehicle_age_min: 0, vehicle_age_max: 0 };
const A15 = { vehicle_age_min: 1, vehicle_age_max: 5 };
const A699 = { vehicle_age_min: 6, vehicle_age_max: 99 };
const A05 = { vehicle_age_min: 0, vehicle_age_max: 5 };
const ANY = {};

// "Comp /SATP" → both; "comp" → COMP only; "satp" → SATP only.
const CS = ['COMP', 'SATP'];
const C = ['COMP'];
const S = ['SATP'];

/**
 * GCV & Pvt Car sheet column map. Each spec: column + the rule template.
 * `types` lists the rate_types to emit at the cell value. `band` entries with
 * an array expand into multiple make/weight sub-rules sharing the value.
 */
function gcvPvtCarCols() {
  const L = [];
  const push = (col, product, segment, make, age, types, extra = {}) =>
    L.push({ col, product, segment, make, ...age, types, ...extra });

  // GCV 4W Upto 2.5T — compound: ≤2.0T All makes + 2.0-2.5T TATA share the cell.
  const gcvSmall = (col, age, types) => {
    L.push({ col, product: 'GCV', segment: 'GCV 4W', make: 'All',  weight_band_min: 0,   weight_band_max: 2.0, ...age, types });
    L.push({ col, product: 'GCV', segment: 'GCV 4W', make: 'TATA', weight_band_min: 2.0, weight_band_max: 2.5, ...age, types });
  };
  gcvSmall(3, NEW, C);     // New-Comp (Net) — COMP only
  gcvSmall(4, A15, CS);    // Upto 5 Year — Comp/SATP
  gcvSmall(5, A699, CS);   // Above 5 Year — Comp/SATP
  // 2.0-2.5T other than Tata
  push(6, 'GCV', 'GCV 4W', 'Others', NEW,  C,  { weight_band_min: 2.0, weight_band_max: 2.5 });
  push(7, 'GCV', 'GCV 4W', 'Others', A15,  CS, { weight_band_min: 2.0, weight_band_max: 2.5 });
  push(8, 'GCV', 'GCV 4W', 'Others', A699, CS, { weight_band_min: 2.0, weight_band_max: 2.5 });
  // GCV 3W
  push(9,  'GCV', 'GCV 3W', 'All', NEW,  C);
  push(10, 'GCV', 'GCV 3W', 'All', A15,  CS);
  push(11, 'GCV', 'GCV 3W', 'All', A699, CS);
  // 2.5-3.5T Mahindra / TATA&AL — Comp/SATP across New / 1-5 / >5
  const band2535 = (cBase, make) => {
    push(cBase,     'GCV', 'GCV 4W', make, NEW,  CS, { weight_band_min: 2.5, weight_band_max: 3.5 });
    push(cBase + 1, 'GCV', 'GCV 4W', make, A15,  CS, { weight_band_min: 2.5, weight_band_max: 3.5 });
    push(cBase + 2, 'GCV', 'GCV 4W', make, A699, CS, { weight_band_min: 2.5, weight_band_max: 3.5 });
  };
  band2535(12, 'MAHINDRA');
  band2535(15, 'TATA & Ashok Leyland');
  // GCV Tractor 2.5-3.5 (single col, all ages)
  push(18, 'MISC', 'GCV Tractor', 'All', ANY, CS, { weight_band_min: 2.5, weight_band_max: 3.5 });
  // 3.5-5 / 5-7.5 / 7.5-12 — single col each, all makes, all ages
  push(19, 'GCV', 'GCV 4W', 'Excluding Eicher & Mahindra', ANY, CS, { weight_band_min: 3.5, weight_band_max: 5.0 });
  push(20, 'GCV', 'GCV 4W', 'Excluding Eicher & Mahindra', ANY, CS, { weight_band_min: 5.0, weight_band_max: 7.5 });
  push(21, 'GCV', 'GCV 4W', 'Excluding Eicher',            ANY, CS, { weight_band_min: 7.5, weight_band_max: 12  });
  // 12-20 / 20-40 — Other makes & TATA&AL, New / 1-5 / >5
  const heavy = (cBase, make, wmin, wmax) => {
    push(cBase,     'GCV', 'GCV', make, NEW,  CS, { weight_band_min: wmin, weight_band_max: wmax });
    push(cBase + 1, 'GCV', 'GCV', make, A15,  CS, { weight_band_min: wmin, weight_band_max: wmax });
    push(cBase + 2, 'GCV', 'GCV', make, A699, CS, { weight_band_min: wmin, weight_band_max: wmax });
  };
  heavy(22, 'Other makes',          12, 20);
  heavy(25, 'TATA & Ashok Leyland', 12, 20);
  heavy(28, 'Other makes',          20, 40);
  heavy(31, 'TATA & Ashok Leyland', 20, 40);
  // >40T — Age upto 5 / Above 5
  push(34, 'GCV', 'GCV', 'Other makes',          A05,  CS, { weight_band_min: 40, weight_band_max: 999 });
  push(35, 'GCV', 'GCV', 'Other makes',          A699, CS, { weight_band_min: 40, weight_band_max: 999 });
  push(36, 'GCV', 'GCV', 'TATA & Ashok Leyland', A05,  CS, { weight_band_min: 40, weight_band_max: 999 });
  push(37, 'GCV', 'GCV', 'TATA & Ashok Leyland', A699, CS, { weight_band_min: 40, weight_band_max: 999 });
  // Pvt Car (other than high-end): Comp (PO on OD) + SAOD
  push(38, 'CAR', 'Pvt Car', 'All', ANY, C);
  push(39, 'CAR', 'Pvt Car', 'All', ANY, ['SAOD']);
  return L;
}

/** PCV / MISD / TW sheet column map (April-style Zone|State|Circle keys). */
function pcvMisdTwCols() {
  const L = [];
  const p = (col, o) => L.push({ col, ...o });
  // Agricultural Tractor & Harvester
  p(3, { product: 'MISC', segment: 'Agricultural Tractor & Harvester', make: 'All', ...NEW, types: C });
  p(4, { product: 'MISC', segment: 'Agricultural Tractor & Harvester', make: 'All', vehicle_age_min: 1, vehicle_age_max: 99, types: CS });
  // PCV 3W (3+1) — Non Diesel / Diesel × New / Non New, Comp + SATP cols
  p(5,  { product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', ...NEW, types: C });
  p(6,  { product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', ...NEW, types: S });
  p(7,  { product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 1, vehicle_age_max: 99, types: C });
  p(8,  { product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Petrol/CNG/EV', vehicle_age_min: 1, vehicle_age_max: 99, types: S });
  p(9,  { product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel', ...NEW, types: C });
  p(10, { product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel', ...NEW, types: S });
  p(11, { product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel', vehicle_age_min: 1, vehicle_age_max: 99, types: C });
  p(12, { product: 'PCV', segment: 'PCV 3W (3+1)', make: 'All', fuel_type: 'Diesel', vehicle_age_min: 1, vehicle_age_max: 99, types: S });
  // PCV Taxi 6+1 by CC — Nil Dep / Non Nil Dep (ncb_split) + SATP
  const taxi = (cBase, ccMin, ccMax) => {
    p(cBase,     { product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: ccMin, cc_band_max: ccMax, rate_type: 'COMP_NilDep',   ncb_split: true, types: ['_RAW'] });
    p(cBase + 1, { product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: ccMin, cc_band_max: ccMax, rate_type: 'COMP_NoNilDep', ncb_split: true, types: ['_RAW'] });
    p(cBase + 2, { product: 'PCV', segment: 'PCV Taxi 6+1', make: 'All', cc_band_min: ccMin, cc_band_max: ccMax, types: S });
  };
  taxi(13, 0, 999);
  taxi(16, 1000, 1499);
  taxi(19, 1500, 99999);
  // PCV Taxi State Capital 6+1 (premium makes)
  p(22, { product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', rate_type: 'COMP_NilDep',   ncb_split: true, types: ['_RAW'] });
  p(23, { product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', rate_type: 'COMP_NoNilDep', ncb_split: true, types: ['_RAW'] });
  p(24, { product: 'PCV', segment: 'PCV Taxi 6+1 State Capital', make: 'Innova/Hycross/Scorpio/Bolero', types: S });
  // School Bus 18+ seater
  p(25, { product: 'PCV', segment: 'School Bus', make: 'All', seating_capacity_min: 18, types: C });
  p(26, { product: 'PCV', segment: 'School Bus', make: 'All', seating_capacity_min: 18, types: S });
  // 2W (1+1) — Comp + SAOD share the cell
  p(27, { product: 'TW', segment: 'Scooter', make: 'All', cc_band_min: 0,   cc_band_max: 150,   types: ['COMP', 'SAOD'] });
  p(28, { product: 'TW', segment: 'Bike',    make: 'All', cc_band_min: 0,   cc_band_max: 125,   types: ['COMP', 'SAOD'] });
  p(29, { product: 'TW', segment: 'Bike',    make: 'All', cc_band_min: 126, cc_band_max: 99999, types: ['COMP', 'SAOD'] });
  return L;
}

const GCV_PVTCAR_COLS = gcvPvtCarCols();
const PCV_MISD_TW_COLS = pcvMisdTwCols();

/** Build the slab variants for one (cell value, rate_type). */
function emitSlabRules(baseRule, v, rateType, ncbSplit, pushFn) {
  for (const slab of PREMIUM_SLABS) {
    const slabRate = rateForSlab(v, rateType, slab);
    const rule = { ...baseRule, rate_type: rateType, rate_value: slabRate,
      volume_tier: slab.tier,
      rate_text: `${baseRule.rate_text} | ${slab.tier}` + (slab.irda_only ? ' (IRDA default)' : ''),
      remarks: slab.irda_only ? 'Premium below ₹1L — IRDA default applied' : null };
    if (ncbSplit && !slab.irda_only) {
      const nonNcb = Math.max(0, +(slabRate - 0.05).toFixed(6));
      pushFn({ ...rule, age_band_min: 1, age_band_max: 99, vehicle_age_min: 1, vehicle_age_max: 99 });
      pushFn({ ...rule, age_band_min: 0, age_band_max: 0,  vehicle_age_min: 1, vehicle_age_max: 99, rate_value: nonNcb });
      pushFn({ ...rule, age_band_min: 0, age_band_max: 0,  vehicle_age_min: 0, vehicle_age_max: 0,  rate_value: nonNcb });
    } else {
      pushFn(rule);
    }
  }
}

function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind;
  const cols = kind === 'pcv_misd_tw' ? PCV_MISD_TW_COLS : GCV_PVTCAR_COLS;
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row
    : (kind === 'pcv_misd_tw' ? 4 : 5);
  const rules = [];

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;

    // Resolve the row key + region(s) per sheet.
    let regions = [];     // list of region strings to emit (cluster code + state alias)
    let stateRaw = null, clusterCode = null, zone = null, circle = null;
    if (kind === 'pcv_misd_tw') {
      zone = cellOrNull(row[0]); stateRaw = cellOrNull(row[1]); circle = cellOrNull(row[2]);
      if (!zone || !stateRaw || !ZONES.has(zone)) continue;
      const sf = parseStateField(stateRaw);
      regions = [sf && sf.state ? sf.state : stateRaw];
    } else {
      clusterCode = cellOrNull(row[1]) || cellOrNull(row[0]);
      stateRaw = cellOrNull(row[2]);
      if (!clusterCode || !stateRaw) continue;
      if (/^region$|^rto cluster|^state$/i.test(clusterCode)) continue;   // header row guard
      const sf = parseStateField(stateRaw);
      const stateName = sf && sf.state ? sf.state : stateRaw;
      // Emit under the cluster code (matches RTO master) AND the canonical state.
      regions = [clusterCode];
      if (stateName && stateName.toUpperCase() !== clusterCode.toUpperCase()) regions.push(stateName);
    }

    const rowStart = rules.length;
    const keyText = kind === 'pcv_misd_tw' ? `${zone} | ${stateRaw}${circle ? ' | ' + circle : ''}` : `${clusterCode} | ${stateRaw}`;

    for (const spec of cols) {
      const v = parseRate(row[spec.col]);
      if (v == null || v === 0) continue;
      const region0 = regions[0];
      const baseRule = {
        product: spec.product,
        sheet_name: meta.sheetName,
        region: region0,
        segment: spec.segment,
        make: spec.make || 'All',
        sub_type: kind === 'pcv_misd_tw' ? circle : stateRaw,
        fuel_type: spec.fuel_type || null,
        cc_band_min: spec.cc_band_min ?? null,
        cc_band_max: spec.cc_band_max ?? null,
        weight_band_min: spec.weight_band_min ?? null,
        weight_band_max: spec.weight_band_max ?? null,
        vehicle_age_min: spec.vehicle_age_min ?? null,
        vehicle_age_max: spec.vehicle_age_max ?? null,
        seating_capacity_min: spec.seating_capacity_min ?? null,
        carrier_type: zone || null,
        is_declined: false,
        rate_text: keyText,
      };
      const ncbSplit = !!spec.ncb_split;
      // NCB-split (PCV taxi) specs use the printed value at the spec's own
      // rate_type; otherwise emit each listed type at the cell value.
      const typeList = ncbSplit ? [spec.rate_type] : spec.types;
      for (const rt of typeList) {
        emitSlabRules(baseRule, v, rt, ncbSplit, (ru) => rules.push(ru));
      }
    }

    // Region aliases: clone this row's rules for each additional region (the
    // canonical state, plus any RTO-master cluster codes mapped to the key).
    const extraRegions = regions.slice(1);
    const clusterAliases = kind === 'pcv_misd_tw'
      ? findClustersForRow(regions[0], circle) : [];
    const allAliases = [...extraRegions, ...clusterAliases];
    if (allAliases.length) {
      const rowRules = rules.slice(rowStart);
      for (const orig of rowRules) {
        for (const reg of allAliases) {
          rules.push({ ...orig, region: reg, rate_text: `${reg} | (alias for ${orig.region})` });
        }
      }
    }
  }

  return rules;
}

module.exports = { parse, GCV_PVTCAR_COLS, PCV_MISD_TW_COLS };
