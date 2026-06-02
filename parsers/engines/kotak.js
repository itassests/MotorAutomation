/**
 * Kotak General Insurance — Motor commission engine (Apr 2026).
 *
 * Source files (5 separate xlsx uploads):
 *   1. Grid.xlsx                         — base rates (TW + Rest Grid sheets)
 *   2. 2026_03 RTO TP ULR TW UW.xlsx     — RTO → TP Category map (LCV categorization)
 *   3. GCV acceptable RTO.xlsx           — 3 sheets per GVW band, RTO + commission %
 *   4. Private car Acceptable RTO pan india.xlsx — RTO → Pvt Car Category map
 *   5. Tractor RTO - State wise.xlsx     — RTO + state-tier + CD (commission)
 *
 * Each file is uploaded separately. The engine's sheet_kind dispatcher
 * routes each sheet to the right handler. Cross-file lookups aren't needed —
 * each lookup file emits its own per-RTO rules with the rate inlined.
 *
 * Entry: parse(sheetData, sheetConfig, meta) → rule[]
 */

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const cell = v => v == null ? '' : String(v).trim();
const pct = n => (Number(n) || 0) * 100;
function asRate(v) {
  // Accept 0.45, 45, "45%", "0.45" — normalise to decimal 0.45.
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/%/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return n > 1 ? n / 100 : n;
}

function normState(s) {
  return String(s || '').trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bAnd\b/g, '&');
}

// ----------------------------------------------------------------------------
// Sheet kind: kotak_grid_tw — Grid.xlsx "TW" sheet
// Layout (after intro lines):
//   row 6: ["1022(OD+TP)","1022(OD+TP)","1068","1068","1023TP","1023TP"]
//   row 7: ["1022-2W-Bike","1022-2W-Scooter","1068-2W-SAOD Only-Bike",
//           "1068-2W-SAOD Only-Scooter","1023-2W LIABILITY-Bike",
//           "1023-2W LIABILITY-Scooter"]
//   row 9: ["(1+5 and 1+1)","(1+5 and 1+1)"]    (only first 2 cols labeled)
//   row 10: [rate, rate, rate, rate, rate, rate]
// ----------------------------------------------------------------------------
function parseGridTw(aoa, meta) {
  // Per operator spec: ignore the standalone "TW" sheet — use the
  // simplified Bike/Scooter rates from the "Rest Grid" sheet instead
  // (emitted in parseGridRest). Returning [] here lets uploads of the
  // file still succeed (no rules from this sheet).
  return [];

  // ---- Legacy parser (disabled) below — kept for reference -----------
  const rules = [];
  // Find the rate row (single numeric row with 6 values).
  let rateRow = null;
  for (let r = 5; r < Math.min(aoa.length, 20); r++) {
    const vals = (aoa[r] || []).map(c => asRate(c)).filter(v => v != null);
    if (vals.length >= 4) { rateRow = aoa[r]; break; }
  }
  if (!rateRow) return rules;

  // Column → policy + vehicle category
  const TW_COLS = [
    { col: 0, code: '1022', rate_type: 'COMP',     applied_on: 'NET', vehicle: 'Bike',    bundled: '1+5/1+1' },
    { col: 1, code: '1022', rate_type: 'COMP',     applied_on: 'NET', vehicle: 'Scooter', bundled: '1+5/1+1' },
    { col: 2, code: '1068', rate_type: 'SAOD',     applied_on: 'OD',  vehicle: 'Bike' },
    { col: 3, code: '1068', rate_type: 'SAOD',     applied_on: 'OD',  vehicle: 'Scooter' },
    { col: 4, code: '1023', rate_type: 'SATP',     applied_on: 'TP',  vehicle: 'Bike' },
    { col: 5, code: '1023', rate_type: 'SATP',     applied_on: 'TP',  vehicle: 'Scooter' },
  ];
  for (const c of TW_COLS) {
    const rate = asRate(rateRow[c.col]);
    if (rate == null) continue;
    rules.push({
      product: 'TW',
      sheet_name: meta.sheetName,
      // Segment carries the bike/scooter marker so the export's
      // inferVehicleCategory returns "Bike" / "Scooter".
      segment: c.vehicle === 'Scooter' ? 'TW Scooter' : 'TW Bike',
      make: 'All',
      region: 'Pan India',
      // Kotak's internal product codes (1022/1068/1023) stay in remarks
      // only — they are not RTO codes / sub-models and shouldn't surface
      // in the Sub Modal column.
      rate_type: c.rate_type,
      applied_on: c.applied_on,
      rate_value: rate,
      is_declined: false,
      remarks: `Kotak TW ${c.vehicle} | internal code ${c.code} | ${c.rate_type}${c.bundled ? ' ' + c.bundled : ''} | ${pct(rate).toFixed(2)}%`,
      rate_text: `Kotak TW ${c.vehicle} ${c.rate_type} | ${pct(rate).toFixed(2)}%`,
    });
  }
  return rules;
}

// ----------------------------------------------------------------------------
// Sheet kind: kotak_grid_rest — Grid.xlsx "Rest Grid" sheet
//
// Multiple sub-sections in one sheet. We scan top-down looking for known
// section markers and parse each section's rates from subsequent rows.
// ----------------------------------------------------------------------------
function parseGridRest(aoa, meta) {
  const rules = [];

  // ----- Private Car section (rows ~13-30) — hard-coded markers
  // 1+3 New: 45% (row 16)
  rules.push(...emitPvtCar(meta, [
    { policy: '1+3 New',          rate_type: 'COMP_1+3', age_min: 0, age_max: 0,
      applied_on: 'NET',          rate: 0.45,
      label: 'Pvt Car 1+3 (New Vehicle)' },
    // 1+1 With NCB — tiered by annual volume:
    //   Upto 50L volume   → 35%
    //   Above 50L volume → 40% (35% base + 5% additional)
    { policy: '1+1 With NCB (Vol Upto 50L)', rate_type: 'COMP_1+1', age_min: 0, age_max: 99,
      applied_on: 'NET',          rate: 0.35,
      sub_type: 'NCB 1-99', volume_tier: 'Upto 50L',
      label: 'Pvt Car 1+1 With NCB | Volume Upto 50L → 35%' },
    { policy: '1+1 With NCB (Vol > 50L)', rate_type: 'COMP_1+1', age_min: 0, age_max: 99,
      applied_on: 'NET',          rate: 0.40,
      sub_type: 'NCB 1-99', volume_tier: 'Above 50L',
      label: 'Pvt Car 1+1 With NCB | Volume Above 50L → 40% (35% base + 5% additional)' },
    { policy: '1+1 Nil NCB',      rate_type: 'COMP_1+1', age_min: 0, age_max: 99,
      applied_on: 'NET',          rate: 0.15,
      sub_type: 'NCB=0',
      label: 'Pvt Car 1+1 Nil NCB' },
    // SAOD: Petrol NCB / Other Fuel NCB / Nil NCB / HEV
    { policy: 'SAOD Petrol With NCB', rate_type: 'SAOD', applied_on: 'OD',
      rate: 0.275, fuel: 'Petrol', sub_type: 'NCB 1-99',
      label: 'Pvt Car SAOD Petrol With NCB' },
    { policy: 'SAOD Other Fuel With NCB', rate_type: 'SAOD', applied_on: 'OD',
      rate: 0.25, fuel: 'Non-Petrol', sub_type: 'NCB 1-99',
      label: 'Pvt Car SAOD Diesel/CNG/LPG/Bifuel With NCB' },
    { policy: 'SAOD Nil NCB',     rate_type: 'SAOD', applied_on: 'OD',
      rate: 0.15, sub_type: 'NCB=0',
      label: 'Pvt Car SAOD Nil NCB' },
    { policy: 'SAOD HEV Nil NCB', rate_type: 'SAOD', applied_on: 'OD',
      rate: 0, fuel: 'Hybrid', sub_type: 'NCB=0',
      label: 'Pvt Car SAOD HEV without NCB — Nil Payout' },
  ]));

  // ----- Pvt Car SATP per RTO Category (rows 32-38)
  rules.push(...emitPvtCarSatp(meta, [
    { cat: 'Category 0', rto_count: 190, fuel: 'Petrol',     rate: 0.50 },
    { cat: 'Category 0', rto_count: 190, fuel: 'Non-Petrol', rate: 0.35 },
    { cat: 'Category 1', rto_count: 76,  fuel: 'Petrol',     rate: 0.45 },
    { cat: 'Category 1', rto_count: 76,  fuel: 'Non-Petrol', rate: 0.25 },
    { cat: 'Category 2', rto_count: 519, fuel: 'Petrol',     rate: 0.35 },
    { cat: 'Category 2', rto_count: 519, fuel: 'Non-Petrol', rate: 0.10 },
  ]));

  // ----- LCV per GVW × RTO Cat (rows 43-46)
  rules.push(...emitLcv(meta, [
    { gvw_min: 0,    gvw_max: 2.5,  cat0: 0.45, cat1: 0.40 },
    { gvw_min: 2.5,  gvw_max: 3.5,  cat0: 0.42, cat1: 0.35 },
    { gvw_min: 3.5,  gvw_max: 7.5,  cat0: 0.35, cat1: 0.25 },
  ]));

  // ----- GCV "As per List" — emit declined placeholder rules
  rules.push(...emitGcvPlaceholder(meta, [
    { gvw_min: 12,  gvw_max: 20, label: 'GCV GVW 12000-20000 (Pan India per acceptable RTO list)' },
    { gvw_min: 20,  gvw_max: 40, label: 'GCV GVW 20001-40000 (Pan India per acceptable RTO list)' },
  ]));

  // ----- TW (Rest Grid values — supersedes the standalone TW sheet).
  // Bike 30%, Scooter 55%. Cluster A/B accepted; Cluster C/D declined (Nil PO).
  // Vehicles above 155 CC and Splendor / Pulsar models are declined per
  // Kotak guidelines (documented in remarks).
  // Per operator: the same rate applies whether the policy is Comp or TP,
  // so emit both COMP and SATP variants from the single rate.
  for (const rt of ['COMP', 'SATP']) {
    rules.push({
      product: 'TW', sheet_name: meta.sheetName,
      segment: 'TW Bike', make: 'All', region: 'Pan India',
      rate_type: rt, applied_on: rt === 'SATP' ? 'TP' : 'NET',
      rate_value: 0.30, is_declined: false,
      remarks: `TW Bike — 30% (Cluster A/B accepted; C/D Nil PO; vehicles >155 CC declined; Splendor & Pulsar models declined) [${rt}]`,
      rate_text: `Kotak TW Bike | 30% (${rt})`,
    });
    rules.push({
      product: 'TW', sheet_name: meta.sheetName,
      segment: 'TW Scooter', make: 'All', region: 'Pan India',
      rate_type: rt, applied_on: rt === 'SATP' ? 'TP' : 'NET',
      rate_value: 0.55, is_declined: false,
      remarks: `TW Scooter — 55% (Cluster A/B accepted; C/D Nil PO; vehicles >155 CC declined) [${rt}]`,
      rate_text: `Kotak TW Scooter | 55% (${rt})`,
    });
  }
  // Cluster C/D decline notice
  rules.push({
    product: 'TW', sheet_name: meta.sheetName,
    segment: 'TW', make: 'All', region: 'Pan India',
    sub_type: 'Cluster C/D',
    rate_type: 'COMP', applied_on: 'NET',
    rate_value: 0, is_declined: true,
    remarks: 'TW Cluster C/D (non-preferred / no-regret) — Nil Payout per Kotak guidelines',
    rate_text: 'Kotak TW Cluster C/D | Declined (Nil PO)',
  });

  // ----- MISD
  rules.push({
    product: 'MIS', sheet_name: meta.sheetName,
    segment: 'Tractor', make: 'All', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'NET',
    rate_value: 0.475, is_declined: false,
    remarks: 'MISD Tractor — 47.5% (per RTO list; outside list = NIL PO)',
    rate_text: 'Kotak MISD Tractor | 47.5%',
  });
  rules.push({
    product: 'MIS', sheet_name: meta.sheetName,
    segment: 'MISC-D', make: 'All', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'NET',
    rate_value: 0.35, is_declined: false,
    remarks: 'MISD Others — 35%',
    rate_text: 'Kotak MISD Others | 35%',
  });
  // MISD Garbage Vans / Cash Vans — same 35% commission, but accept policies
  // with up to 85% customer discount (CD). The 85% is the MAX DISCOUNT cap,
  // not the rate. volume_tier "Upto 85" → Min/Max Discount columns = 0 / 85.
  rules.push({
    product: 'MIS', sheet_name: meta.sheetName,
    segment: 'Garbage Van', make: 'All', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'NET',
    rate_value: 0.35, is_declined: false,
    volume_tier: 'Upto 85',
    remarks: 'MISD Garbage Van — 35% commission | accepts customer discount upto 85%',
    rate_text: 'Kotak MISD Garbage Van | 35% (CD upto 85%)',
  });
  rules.push({
    product: 'MIS', sheet_name: meta.sheetName,
    segment: 'Cash Van', make: 'All', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'NET',
    rate_value: 0.35, is_declined: false,
    volume_tier: 'Upto 85',
    remarks: 'MISD Cash Van — 35% commission | accepts customer discount upto 85%',
    rate_text: 'Kotak MISD Cash Van | 35% (CD upto 85%)',
  });

  // ----- PCV School Bus
  rules.push({
    product: 'PCV', sheet_name: meta.sheetName,
    segment: 'School Bus', make: 'All', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'NET',
    rate_value: 0.65, is_declined: false,
    remarks: 'PCV School Bus — 65%',
    rate_text: 'Kotak PCV School Bus | 65%',
  });

  // ----- Make-specific declines (Bolero Pickup, Eicher)
  rules.push({
    product: 'GCV', sheet_name: meta.sheetName,
    segment: 'LCV', make: 'Bolero Pickup', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'NET',
    rate_value: 0, is_declined: true,
    remarks: 'Bolero Pickup — declined in Delhi NCR, UP, UK, Karnataka, Tamil Nadu, Andhra, Telangana, Kerala, Maharashtra (Excl Mumbai), Gujarat',
    rate_text: 'Kotak Bolero Pickup | declined in listed states',
  });
  rules.push({
    product: 'GCV', sheet_name: meta.sheetName,
    segment: 'LCV', make: 'Eicher', region: 'Pan India',
    rate_type: 'COMP', applied_on: 'NET',
    rate_value: 0, is_declined: true,
    remarks: 'Eicher — declined for Delhi NCR, UP, UK',
    rate_text: 'Kotak Eicher | declined Delhi NCR/UP/UK',
  });

  return rules;
}

// ----------------------------------------------------------------------------
// Pvt Car emit helpers
// ----------------------------------------------------------------------------
const NON_PETROL_FUELS = ['Diesel', 'CNG', 'LPG'];

function emitPvtCar(meta, items) {
  const rules = [];
  for (const it of items) {
    // Fan out by fuel where applicable
    let fuels = [null];
    if (it.fuel === 'Petrol') fuels = ['Petrol'];
    else if (it.fuel === 'Non-Petrol') fuels = NON_PETROL_FUELS;
    else if (it.fuel === 'Hybrid') fuels = ['Hybrid'];

    for (const fuel of fuels) {
      rules.push({
        product: 'CAR',
        sheet_name: meta.sheetName,
        segment: 'Pvt Car',
        make: 'All',
        region: 'Pan India',
        fuel_type: fuel,
        vehicle_age_min: it.age_min ?? null,
        vehicle_age_max: it.age_max ?? null,
        sub_type: it.sub_type || null,
        volume_tier: it.volume_tier || null,    // → Min/Max Volume columns
        rate_type: it.rate_type,
        applied_on: it.applied_on,
        rate_value: it.rate,
        is_declined: it.rate === 0,
        remarks: `Kotak ${it.label}${fuel ? ' | ' + fuel : ''}`,
        rate_text: `Kotak ${it.label}${fuel ? ' | ' + fuel : ''} | ${(it.rate * 100).toFixed(2)}%`,
      });
    }
  }
  return rules;
}

function emitPvtCarSatp(meta, items) {
  const rules = [];
  // Excluded makes — each gets a per-fuel × per-category zero-rate rule so
  // policies on Mahindra / Tata land on the explicit decline and don't get
  // attributed to the 'All' rule.
  const EXCLUDED_MAKES = ['Mahindra', 'Tata'];
  for (const it of items) {
    const fuels = it.fuel === 'Petrol' ? ['Petrol'] : NON_PETROL_FUELS;
    for (const fuel of fuels) {
      // Main rule — matches every make EXCEPT M&M/Tata (declined below).
      rules.push({
        product: 'CAR',
        sheet_name: meta.sheetName,
        segment: 'Pvt Car',
        make: 'All',
        region: 'Pan India',
        fuel_type: fuel,
        sub_type: it.cat,                              // → Sub Modal: Category 0/1/2
        rate_type: 'SATP',
        applied_on: 'TP',
        rate_value: it.rate,
        is_declined: false,
        remarks: `Kotak Pvt Car SATP | ${it.cat} (${it.rto_count} RTOs) | ${fuel} | Excluding M&M and Tata Motors | ${(it.rate*100).toFixed(2)}%`,
        rate_text: `Kotak Pvt Car SATP ${it.cat} ${fuel} | ${(it.rate*100).toFixed(2)}%`,
      });
      // Excluded-make decline rules
      for (const make of EXCLUDED_MAKES) {
        rules.push({
          product: 'CAR',
          sheet_name: meta.sheetName,
          segment: 'Pvt Car',
          make: make,
          region: 'Pan India',
          fuel_type: fuel,
          sub_type: it.cat,
          rate_type: 'SATP',
          applied_on: 'TP',
          rate_value: 0,
          is_declined: true,
          remarks: `Kotak Pvt Car SATP | ${it.cat} | ${fuel} | Make ${make} — excluded (0%)`,
          rate_text: `Kotak Pvt Car SATP ${it.cat} ${fuel} ${make} | excluded`,
        });
      }
    }
  }
  return rules;
}

function emitLcv(meta, items) {
  const rules = [];
  for (const it of items) {
    for (const cat of [
      { tag: 'Cat 0', rate: it.cat0 },
      { tag: 'Cat 1', rate: it.cat1 },
    ]) {
      rules.push({
        product: 'GCV',
        sheet_name: meta.sheetName,
        segment: 'LCV',
        make: 'All',
        region: 'Pan India',
        weight_band_min: it.gvw_min,
        weight_band_max: it.gvw_max,
        sub_type: cat.tag,
        rate_type: 'COMP',
        applied_on: 'NET',
        rate_value: cat.rate,
        is_declined: false,
        remarks: `Kotak LCV GVW ${it.gvw_min*1000}-${it.gvw_max*1000} kg | RTO ${cat.tag} | Pan India | ${(cat.rate*100).toFixed(2)}% (Cat 0/1 RTOs only; rest = NIL)`,
        rate_text: `Kotak LCV ${it.gvw_min*1000}-${it.gvw_max*1000} kg | RTO ${cat.tag} | ${(cat.rate*100).toFixed(2)}%`,
      });
    }
  }
  return rules;
}

function emitGcvPlaceholder(meta, items) {
  const rules = [];
  for (const it of items) {
    rules.push({
      product: 'GCV',
      sheet_name: meta.sheetName,
      segment: 'GCV',
      make: 'All',
      region: 'Pan India',
      weight_band_min: it.gvw_min,
      weight_band_max: it.gvw_max,
      rate_type: 'COMP',
      applied_on: 'NET',
      rate_value: 0,
      is_declined: true,
      remarks: `${it.label} — rate per acceptable RTO list (see GCV RTO file)`,
      rate_text: `Kotak GCV ${it.gvw_min*1000}-${it.gvw_max*1000} kg | per RTO list`,
    });
  }
  return rules;
}

// ----------------------------------------------------------------------------
// Sheet kind: kotak_rto_pvt_car — Pvt Car RTO Sheet2
// Cols: RTO_Reg_Code | KGI_Districts | Private Car (Category) | States
// Fan out each RTO with the corresponding rate from Grid.xlsx (Cat 0/1/2 ×
// Petrol/Non-Petrol fuels).
// ----------------------------------------------------------------------------
const PVT_CAR_SATP_RATES = {
  'Category 0': { petrol: 0.50, non_petrol: 0.35 },
  'Category 1': { petrol: 0.45, non_petrol: 0.25 },
  'Category 2': { petrol: 0.35, non_petrol: 0.10 },
};
function parsePvtCarRto(aoa, meta) {
  const rules = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const rto = cell(row[0]);
    const city = cell(row[1]);
    const cat = cell(row[2]);
    const state = normState(row[3]);
    if (!rto || !cat || !PVT_CAR_SATP_RATES[cat]) continue;
    const rates = PVT_CAR_SATP_RATES[cat];
    for (const fuelGroup of [
      { name: 'Petrol',     fuels: ['Petrol'],          rate: rates.petrol },
      { name: 'Non-Petrol', fuels: NON_PETROL_FUELS,    rate: rates.non_petrol },
    ]) {
      for (const fuel of fuelGroup.fuels) {
        // Main rule (every make except M&M/Tata)
        rules.push({
          product: 'CAR',
          sheet_name: meta.sheetName,
          segment: 'Pvt Car',
          make: 'All',
          state, region: city || state,
          sub_type: rto,                              // → RTOCode column
          fuel_type: fuel,
          rate_type: 'SATP',
          applied_on: 'TP',
          rate_value: fuelGroup.rate,
          is_declined: false,
          remarks: `Kotak Pvt Car SATP | ${state}/${city} ${rto} | ${cat} | ${fuel} | Excluding M&M and Tata | ${(fuelGroup.rate*100).toFixed(2)}%`,
          rate_text: `Kotak Pvt Car SATP | ${state}/${city} ${rto} | ${cat} ${fuel} | ${(fuelGroup.rate*100).toFixed(2)}%`,
        });
        // Excluded-make declines
        for (const exMake of ['Mahindra', 'Tata']) {
          rules.push({
            product: 'CAR',
            sheet_name: meta.sheetName,
            segment: 'Pvt Car',
            make: exMake,
            state, region: city || state,
            sub_type: rto,
            fuel_type: fuel,
            rate_type: 'SATP',
            applied_on: 'TP',
            rate_value: 0,
            is_declined: true,
            remarks: `Kotak Pvt Car SATP | ${state}/${city} ${rto} | ${cat} | ${fuel} | Make ${exMake} — excluded (0%)`,
            rate_text: `Kotak Pvt Car SATP | ${state}/${city} ${rto} | ${cat} ${fuel} ${exMake} | excluded`,
          });
        }
      }
    }
  }
  return rules;
}

// ----------------------------------------------------------------------------
// Sheet kind: kotak_rto_tp_ulr — TP ULR TW UW.xlsx "RTO Level TP ULR"
// Cols: RTO Code | District | State | Revised_TP Category (Category 0/1)
// Used for LCV RTO categorization. Fan out LCV rules per RTO × 3 GVW bands ×
// Cat 0/1 rate from Grid.
// ----------------------------------------------------------------------------
const LCV_RATES_BY_GVW = [
  { gvw_min: 0,    gvw_max: 2.5,  cat0: 0.45, cat1: 0.40 },
  { gvw_min: 2.5,  gvw_max: 3.5,  cat0: 0.42, cat1: 0.35 },
  { gvw_min: 3.5,  gvw_max: 7.5,  cat0: 0.35, cat1: 0.25 },
];
function parseTpUlr(aoa, meta) {
  const rules = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const rto = cell(row[0]);
    const city = cell(row[1]);
    const state = normState(row[2]);
    const cat = cell(row[3]);
    if (!rto) continue;
    const isCat0 = /Category\s*0/i.test(cat);
    const isCat1 = /Category\s*1/i.test(cat);
    if (!isCat0 && !isCat1) continue;          // Cat 2+ not accepted for LCV
    for (const band of LCV_RATES_BY_GVW) {
      const rate = isCat0 ? band.cat0 : band.cat1;
      rules.push({
        product: 'GCV',
        sheet_name: meta.sheetName,
        segment: 'LCV',
        make: 'All',
        state, region: city || state,
        sub_type: rto,
        weight_band_min: band.gvw_min,
        weight_band_max: band.gvw_max,
        rate_type: 'COMP',
        applied_on: 'NET',
        rate_value: rate,
        is_declined: false,
        remarks: `Kotak LCV | ${state}/${city} ${rto} | ${cat} | GVW ${band.gvw_min*1000}-${band.gvw_max*1000} kg | ${(rate*100).toFixed(2)}%`,
        rate_text: `Kotak LCV | ${state}/${city} ${rto} ${cat} | GVW ${band.gvw_min*1000}-${band.gvw_max*1000} | ${(rate*100).toFixed(2)}%`,
      });
    }
  }
  return rules;
}

// ----------------------------------------------------------------------------
// Sheet kind: kotak_rto_gcv — GCV acceptable RTO.xlsx (one of 3 GVW sheets)
// Cols: RTO_Code | GCV Category | Commission
// Each sheet maps to a different GVW band (set via sheet_kind suffix).
// ----------------------------------------------------------------------------
const GCV_SHEET_BANDS = {
  'kotak_rto_gcv_upto_2_5':  { gvw_min: 0,   gvw_max: 2.5, label: 'GCV ≤2.5 ton' },
  'kotak_rto_gcv_2_5_3_5':   { gvw_min: 2.5, gvw_max: 3.5, label: 'GCV 2.5-3.5 ton' },
  'kotak_rto_gcv_3_5_7_5':   { gvw_min: 3.5, gvw_max: 7.5, label: 'GCV 3.5-7.5 ton' },
};
function parseGcvRto(aoa, meta, kind) {
  const band = GCV_SHEET_BANDS[kind];
  if (!band) return [];
  const rules = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const rto = cell(row[0]);
    const category = cell(row[1]);
    const rate = asRate(row[2]);
    if (!rto || rate == null) continue;
    rules.push({
      product: 'GCV',
      sheet_name: meta.sheetName,
      segment: 'GCV',
      make: 'All',
      region: rto,
      sub_type: rto,
      weight_band_min: band.gvw_min,
      weight_band_max: band.gvw_max,
      rate_type: 'COMP',
      applied_on: 'NET',
      rate_value: rate,
      is_declined: false,
      remarks: `Kotak ${band.label} | ${rto}${category ? ' (' + category + ')' : ''} | ${(rate*100).toFixed(2)}%`,
      rate_text: `Kotak ${band.label} | ${rto} | ${(rate*100).toFixed(2)}%`,
    });
  }
  return rules;
}

// ----------------------------------------------------------------------------
// Sheet kind: kotak_rto_tractor — Tractor RTO sheet
// Layout: side-by-side 6-col blocks. Each block:
//   RTO_Code | State_Final | District | District_Modified | Category Tractor | CD
// Iterate cols 0-5 then 7-12 (skipping empty separator col 6).
// ----------------------------------------------------------------------------
function parseTractorRto(aoa, meta) {
  const rules = [];
  const blocks = [{ start: 0 }, { start: 7 }];     // two blocks per row
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    for (const b of blocks) {
      const rto = cell(row[b.start]);
      const state = normState(row[b.start + 1]);
      const district = cell(row[b.start + 2]);
      const tier = cell(row[b.start + 4]);
      const rate = asRate(row[b.start + 5]);
      if (!rto || rate == null) continue;
      rules.push({
        product: 'MIS',
        sheet_name: meta.sheetName,
        segment: 'Tractor',
        make: 'All',
        state, region: district || state,
        sub_type: rto,
        rate_type: 'COMP',
        applied_on: 'NET',
        rate_value: rate,
        volume_tier: tier,                         // e.g. "West Bengal_1"
        is_declined: false,
        remarks: `Kotak Tractor | ${state}/${district} ${rto} | Tier ${tier} | ${(rate*100).toFixed(2)}%`,
        rate_text: `Kotak Tractor | ${state}/${district} ${rto} | ${(rate*100).toFixed(2)}%`,
      });
    }
  }
  return rules;
}

// ----------------------------------------------------------------------------
// Engine entry — dispatch by sheet_kind
// ----------------------------------------------------------------------------
function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig?.config?.sheet_kind || sheetConfig?.kind;
  switch (kind) {
    case 'kotak_grid_tw':           return parseGridTw(sheetData, meta);
    case 'kotak_grid_rest':         return parseGridRest(sheetData, meta);
    case 'kotak_rto_pvt_car':       return parsePvtCarRto(sheetData, meta);
    case 'kotak_rto_tp_ulr':        return parseTpUlr(sheetData, meta);
    case 'kotak_rto_tractor':       return parseTractorRto(sheetData, meta);
    case 'kotak_rto_gcv_upto_2_5':
    case 'kotak_rto_gcv_2_5_3_5':
    case 'kotak_rto_gcv_3_5_7_5':
      return parseGcvRto(sheetData, meta, kind);
    default:
      console.warn(`[kotak] unknown sheet_kind: ${kind}`);
      return [];
  }
}

module.exports = { parse };
