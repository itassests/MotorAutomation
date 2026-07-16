'use strict';

/**
 * RELIANCE — Private Car Comp & SAOD → Luca export rows.
 *
 * WHY THIS EXISTS (routes/bulk.js ~5859): Reliance Pvt-Car is resolved from
 * config at CALCULATION time. The ingested DB sheet ("April PVT COM ") carries
 * only the OD-DISCOUNT-banded view and "missed this fuel/product structure
 * (Petrol COM = 30% everywhere), so most Reliance cars mis-rated or no-ruled".
 * It stores four CONFLICTING COMP rows per region+fuel (0.175 / 0.20 / 0.225 /
 * 0.25) with nothing in the row identity to choose between them. bulk.js
 * REPLACES that whole pool (`rules = [{...}]`) with the resolver's answer
 * whenever the region resolves, so those DB rows are rates the engine never
 * pays → suppressed here.
 *
 * SOURCE: config/reliance_car_grid.json (PERCENTS — divided by 100 below) +
 * config/reliance_high_end.json, mirroring services/reliance-car.js:
 *   - Comprehensive (od>=1, tp>=1): petrolCom for Petrol/CNG/LPG/HEV,
 *     dieselEvCom for Diesel/EV  (resolver: dieselEv = /DIESEL|ELECTRIC|EV|BATTERY/).
 *   - SAOD (od>=1, tp<1): highEndSaod when isHighEnd(make,model), else nonHighEndSaod.
 *   - SATP (od<1) → resolver returns null → NOT expanded (DB has no Reliance CAR
 *     SATP rows either).
 *
 * DELIBERATELY LEFT OUT (see report):
 *   - extWarranty (20%) and the DB's COMP_NilDep rows: the resolver has no
 *     addon/nil-dep input and clobbers the pool anyway, so the engine never pays
 *     them. Emitting them would assert a rate that is never used.
 *   - Diesel/EV COMP for Karnataka & Telangana: the grid splits Bangalore /
 *     Hyderabad (10%) from the rest of the state (5%), but the Luca file has no
 *     city column — both rows would collapse to included_states=karnataka with
 *     CONFLICTING rates. Petrol/CNG and SAOD are identical across that split and
 *     are emitted normally.
 */

const GRID = require('../../config/reliance_car_grid.json');
const HIGH = require('../../config/reliance_high_end.json');

const SHEET = 'Reliance Pvt Car Comp & SAOD';
const has = (v) => v != null && v !== '' && Number.isFinite(Number(v));
const pctToFrac = (v) => +(Number(v) / 100).toFixed(4);   // config stores PERCENT

function row(o) {
  return {
    insurer: 'reliance',
    product: o.product || 'CAR',
    sheet_name: o.sheet_name || SHEET,
    region: o.region || null,
    segment: o.segment || null,
    make: o.make || null,
    model: o.model || null,
    sub_type: o.sub_type || null,
    fuel_type: o.fuel_type || null,
    cc_band_min: null, cc_band_max: null,
    age_band_min: null, age_band_max: null,
    weight_band_min: null, weight_band_max: null,
    rate_type: o.rate_type || null,
    rate_value: o.rate_value,
    remarks: o.remarks || null,
    state: o.state || null,
    effective_from: o.effective_from || null,
  };
}

// Rate-vector equality — used to collapse grid groups that map to the SAME Luca
// state (the export keys on state, not on Reliance's region text, so two groups
// sharing a state MUST agree or one has to be dropped).
const KEYS = ['petrolCom', 'dieselEvCom', 'highEndSaod', 'nonHighEndSaod'];
const sameRates = (a, b) => !!a && !!b && KEYS.every((k) => a[k] === b[k]);

/**
 * Grid group → the concrete Luca states it prices, taken from the resolver's own
 * RTO-state fallback table (services/reliance-car.js regionGroup S{}) so the
 * mapping is the resolver's, not a guess. Goa is added to MUM_PUN_GOA from the
 * group's own name/regex (it is absent from S{}).
 * `cityOnly` groups (BLR_HYD) have no state of their own — handled separately.
 */
const GROUP_STATES = {
  GUJARAT:       ['Gujarat'],
  MP:            ['Madhya Pradesh'],
  KERALA:        ['Kerala'],
  TN:            ['Tamil Nadu'],
  DELHI:         ['Delhi'],
  PUN_HP_JK:     ['Punjab', 'Himachal Pradesh', 'Jammu & Kashmir', 'Chandigarh'],
  UP_HR_RAJ:     ['Uttar Pradesh', 'Haryana', 'Rajasthan'],
  NE_OD_CG:      ['Odisha', 'Chhattisgarh', 'Assam', 'Arunachal Pradesh', 'Manipur',
                  'Meghalaya', 'Mizoram', 'Nagaland', 'Sikkim', 'Tripura'],
  BIH_JHK:       ['Bihar', 'Jharkhand'],
};

/** [{ group, state, region, dropDieselEv }] — one scope per concrete Luca state. */
function scopes() {
  const out = [];
  for (const g of Object.keys(GROUP_STATES)) {
    if (!GRID[g]) continue;
    for (const st of GROUP_STATES[g]) out.push({ group: g, state: st, region: st });
  }
  // Goa rides in the Mumbai/Pune/Goa group.
  if (GRID.MUM_PUN_GOA) out.push({ group: 'MUM_PUN_GOA', state: 'Goa', region: 'Goa' });

  // Maharashtra: MUM_PUN_GOA (Mumbai/Pune) and REST_MAH are both MH. Collapse
  // when identical; if they ever diverge, neither can be expressed → drop both.
  if (sameRates(GRID.MUM_PUN_GOA, GRID.REST_MAH)) {
    out.push({ group: 'MUM_PUN_GOA', state: 'Maharashtra',
               region: 'Maharashtra (Mumbai/Pune & Rest of Maharashtra)' });
  }
  // West Bengal: KOLKATA + WB. Same treatment.
  if (sameRates(GRID.KOLKATA, GRID.WB)) {
    out.push({ group: 'WB', state: 'West Bengal', region: 'West Bengal (incl. Kolkata)' });
  }

  // Karnataka / Telangana / Andhra: BLR_HYD (Bangalore, Hyderabad) vs
  // REST_KA_TS_AP. Rate the state off REST_KA_TS_AP, and drop any leg where the
  // city group disagrees (no city column in the export → would conflict).
  const R = GRID.REST_KA_TS_AP, B = GRID.BLR_HYD;
  if (R) {
    const agrees = (k) => !B || B[k] === R[k];
    out.push({ group: 'REST_KA_TS_AP', state: 'Karnataka', region: 'Karnataka',
               skip: KEYS.filter((k) => !agrees(k)) });
    out.push({ group: 'REST_KA_TS_AP', state: 'Telangana', region: 'Telangana',
               skip: KEYS.filter((k) => !agrees(k)) });
    // Andhra Pradesh has no city carve-out in the grid → all legs are safe.
    out.push({ group: 'REST_KA_TS_AP', state: 'Andhra Pradesh', region: 'Andhra Pradesh' });
  }
  return out;
}

/** Every (make, model) the resolver's isHighEnd() answers TRUE for. */
function highEndIdentities() {
  const out = [];
  for (const mk of (HIGH.wholeHigh || [])) out.push({ make: mk, model: null });
  for (const mk of Object.keys(HIGH.mixedHigh || {})) {
    for (const md of (HIGH.mixedHigh[mk] || [])) out.push({ make: mk, model: md });
  }
  return out;
}

function expand(eff) {
  const out = [];
  const highs = highEndIdentities();
  for (const sc of scopes()) {
    const G = GRID[sc.group];
    if (!G) continue;
    const skip = sc.skip || [];
    const base = { region: sc.region, state: sc.state, effective_from: eff, product: 'CAR' };

    // --- Comprehensive: Petrol / CNG / LPG / HEV -----------------------------
    // HYBRID is intentionally not emitted: lucaFuel() maps HYBRID → PETROL, so it
    // would duplicate the PETROL row (same rate, same output identity).
    if (has(G.petrolCom) && !skip.includes('petrolCom')) {
      for (const f of ['PETROL', 'CNG']) {
        out.push(row({ ...base, segment: 'Private Car', fuel_type: f, rate_type: 'COMP',
                       make: 'All', rate_value: pctToFrac(G.petrolCom),
                       remarks: 'Reliance Pvt Car grid — Comprehensive Petrol/CNG/LPG (incl. HEV)' }));
      }
    }
    // --- Comprehensive: Diesel / EV ------------------------------------------
    if (has(G.dieselEvCom) && !skip.includes('dieselEvCom')) {
      for (const f of ['DIESEL', 'ELECTRIC']) {
        out.push(row({ ...base, segment: 'Private Car', fuel_type: f, rate_type: 'COMP',
                       make: 'All', rate_value: pctToFrac(G.dieselEvCom),
                       remarks: 'Reliance Pvt Car grid — Comprehensive Diesel/EV' }));
      }
    }
    // --- SAOD: non-high-end (the default) ------------------------------------
    if (has(G.nonHighEndSaod) && !skip.includes('nonHighEndSaod')) {
      out.push(row({ ...base, segment: 'Private Car', rate_type: 'SAOD', make: 'All',
                     rate_value: pctToFrac(G.nonHighEndSaod),
                     remarks: 'Reliance Pvt Car grid — SAOD, non-high-end segment' }));
    }
    // --- SAOD: high-end, only where it actually differs -----------------------
    if (has(G.highEndSaod) && !skip.includes('highEndSaod')
        && G.highEndSaod !== G.nonHighEndSaod) {
      for (const h of highs) {
        out.push(row({ ...base, segment: 'Private Car High-End', rate_type: 'SAOD',
                       make: h.make, model: h.model,
                       rate_value: pctToFrac(G.highEndSaod),
                       remarks: 'Reliance Pvt Car grid — SAOD, HIGH END segment (PVT car Segment sheet)' }));
      }
    }
  }
  return out;
}

module.exports = {
  insurer: 'reliance',
  // The ingested Pvt-Car Comp sheet is the OD-discount-banded view that bulk.js
  // replaces wholesale for CAR. Scoped tightly to that sheet: Reliance's other
  // sheets ("April CV26", "April TW26", "April-Short Term PCV Taxi") have no CAR
  // resolver override and are left untouched.
  suppress: [
    (r) => /\bPVT\s*COM\b/i.test(String(r.sheet_name || '')),
  ],
  expand,
  // exported for tests
  scopes, highEndIdentities,
};
