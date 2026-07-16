'use strict';

/**
 * Bajaj Allianz — Private Car COMPREHENSIVE (ROBINHOOD product 1801) expander
 * for the Luca (agent-facing) export.
 *
 * WHY THIS EXISTS
 * ---------------
 * routes/bulk.js (~L3532) gates on `insurerSlug === 'bajaj_allianz'` + CAR +
 * policy-no `/-1801-/` and REPLACES every COMP rate_rule with the rate returned
 * by services/bajaj-car.js (config/bajaj_car_1801.json + config/bajaj_rto_state.json):
 *
 *     rules = [clone(rate = resolveBajajCarRate(params)),
 *              ...rules.filter(r => r.rate_type !== 'COMP')]
 *
 * so for Comprehensive Pvt-Car (1801 = the Comprehensive product code — see
 * [[reference_bajaj_product_codes]]) the ingested COMP rows never pay.
 *
 * The ingested sheet "PVT car Comprehensive & STOD" IS the same 1801 grid, but the
 * ingest LOST the NCB dimension: every region×fuel carries TWO COMP rows — one per
 * NCB column — with no way to tell them apart (e.g. Haryana/Petrol COMP 0.15 AND
 * 0.25 = the grid's petrolNoNcb 15 / petrolNcb 25; Odisha/Petrol 0.15 + 0.30; MP
 * 0.20 + 0.30). Two conflicting rows with the same identity is exactly the failure
 * mode that misleads an agent, and it is also why bulk.js resolves from config
 * instead. Those COMP rows are therefore SUPPRESSED and re-expanded here with the
 * NCB dimension carried explicitly in rate_type ('COMP NCB:GT0' / 'COMP NCB:0').
 *
 * RESOLVER SEMANTICS mirrored exactly (services/bajaj-car.js):
 *   1. Diesel/HEV WITHOUT NCB → 10 UNIVERSALLY (this fires BEFORE the state
 *      lookup — note Puducherry's dieselNoNcb 5 is therefore unreachable).
 *   2. RTO → grid-state via config/bajaj_rto_state.json, then GRID._stateAliases.
 *      Metros carry their own grid-state (HR26/HR51 → DELHI&NCR, KA01 → BANGALORE,
 *      TN01 → CHENNAI, AP09 → HYDERABAD) so they fall through to the default.
 *   3. Grid-state listed in GRID.states → rate by fuel × NCB; the resolver's fuel
 *      classes are DIESEL (/DIESEL/) vs HEV (/ELECTRIC|HYBRID|HEV|BATTERY/) vs
 *      everything else (petrol columns — Petrol AND CNG). HEV *with* NCB takes the
 *      petrol column.
 *   4. Unlisted grid-state / unmapped RTO → GRID.default (45).
 * Config stores PERCENTS → divide by 100.
 *
 * NOT EXPANDED (deliberately — no dimension for them in the export):
 *   - CD > 80% cap (resolver returns 0.10 when params.discountPct > 80).
 *   - OEM-code minimum 19.5 and the UP-West "IRDA" exception (not modelled in the
 *     resolver either).
 * Only the Pvt-Car COMP (1801) leg is expanded. Bajaj's TW / CV / SATP / "PVT car
 * New (1825)" rate_rules are genuine and NOT overridden by any resolver — they are
 * left untouched.
 */

const GRID = require('../../config/bajaj_car_1801.json');
const RTO_STATE = require('../../config/bajaj_rto_state.json');

const SHEET = '1801';
const SEGMENT = 'Private Car Comprehensive';
// Resolver fuel classes: DIESEL, HEV (ELECTRIC/HYBRID), petrol-column (PETROL/CNG).
const FUELS = ['PETROL', 'CNG', 'DIESEL', 'ELECTRIC', 'HYBRID'];

// Human labels for the config's grid-state keys. The "Ex <metro>" wording mirrors
// the grid (and the ingested sheet) because those metro RTOs resolve to their own
// grid-state and take the default rate, not the state rate.
const LABEL = {
  'HARYANA':           { region: 'Haryana Ex Gurgaon & Faridabad', state: 'Haryana' },
  'PUDUCHERRY':        { region: 'Puducherry',                     state: 'Puducherry' },
  'ODISHA':            { region: 'Odisha',                         state: 'Odisha' },
  'JAMMU AND KASHMIR': { region: 'Jammu and Kashmir',              state: 'Jammu and Kashmir' },
  'ASSAM':             { region: 'Assam',                          state: 'Assam' },
  'CHHATTISGARH':      { region: 'Chhattisgarh',                   state: 'Chhattisgarh' },
  'KARNATAKA':         { region: 'Karnataka Ex Bangalore',         state: 'Karnataka' },
  'KERALA':            { region: 'Kerala',                         state: 'Kerala' },
  'MADHYA PRADESH':    { region: 'Madhya Pradesh',                 state: 'Madhya Pradesh' },
  'PUNJAB':            { region: 'Punjab',                         state: 'Punjab' },
  'RAJASTHAN':         { region: 'Rajasthan',                      state: 'Rajasthan' },
  'TAMIL NADU':        { region: 'Tamil Nadu Ex Chennai',          state: 'Tamil Nadu' },
  'TELANGANA':         { region: 'Telangana Ex Hyderabad',         state: 'Telangana' },
  'UTTAR PRADESH':     { region: 'Uttar Pradesh',                  state: 'Uttar Pradesh' },
};

const pct = (v) => +(Number(v) / 100).toFixed(4);   // config stores a PERCENT

/**
 * The grid-state keys actually reachable from the RTO master, aliased exactly as
 * services/bajaj-car.js does, and kept only when GRID.states prices them. Driving
 * this off the RTO master (not off Object.keys(GRID.states)) guarantees we never
 * publish a state no RTO can resolve to.
 */
function listedStates() {
  const seen = new Set();
  for (const raw of Object.values(RTO_STATE)) {
    const st = GRID._stateAliases[raw] || raw;
    if (GRID.states[st]) seen.add(st);
  }
  return [...seen].sort();
}

/**
 * rate fraction for a concrete (grid-state | null = default) × fuel × NCB scope.
 * Mirrors resolveBajajCarRate() branch for branch (CD>80% cap excluded — see header).
 */
function rateFor(stateKey, fuel, ncbYes) {
  const f = String(fuel || '').toUpperCase();
  const diesel = /DIESEL/.test(f);
  const hev = /ELECTRIC|HYBRID|\bHEV\b|BATTERY/.test(f);

  if (!ncbYes && (diesel || hev)) return pct(GRID.dieselNoNcb);   // universal, all states

  const g = stateKey && GRID.states[stateKey];
  if (!g) return pct(GRID.default);

  const v = ncbYes ? (diesel ? g.dieselNcb : g.petrolNcb)
                   : (diesel ? g.dieselNoNcb : g.petrolNoNcb);
  if (v == null) return pct(GRID.default);
  return pct(v);
}

function row(o) {
  return {
    insurer: 'bajaj_allianz',
    product: 'CAR',
    sheet_name: SHEET,
    region: o.region || null,
    segment: SEGMENT,
    make: null,
    model: null,
    sub_type: null,
    fuel_type: o.fuel_type || null,
    cc_band_min: null, cc_band_max: null,
    age_band_min: null, age_band_max: null,
    weight_band_min: null, weight_band_max: null,
    rate_type: 'COMP' + (o.ncbYes ? ' NCB:GT0' : ' NCB:0'),
    rate_value: o.rate_value,
    state: o.state || null,
    effective_from: o.effective_from || null,
  };
}

function expand(eff) {
  const out = [];
  const same = (a) => a.every((v) => v === a[0]);

  // ---- Pan-India (default / unlisted grid-state / metro) ------------------
  for (const ncbYes of [true, false]) {
    const def = FUELS.map((f) => rateFor(null, f, ncbYes));
    if (same(def)) {
      out.push(row({ region: 'Pan India', ncbYes, rate_value: def[0], effective_from: eff }));
    } else {
      FUELS.forEach((f, i) => out.push(
        row({ region: 'Pan India', fuel_type: f, ncbYes, rate_value: def[i], effective_from: eff })));
    }
  }

  // ---- Listed grid-states: only where the rate DIFFERS from the default ----
  for (const st of listedStates()) {
    const lab = LABEL[st];
    if (!lab) continue;                       // unlabelled key → skip rather than guess
    for (const ncbYes of [true, false]) {
      const def = FUELS.map((f) => rateFor(null, f, ncbYes));
      const val = FUELS.map((f) => rateFor(st, f, ncbYes));
      // Collapse the fuel dimension only when it changes nothing on BOTH sides.
      if (same(val) && same(def)) {
        if (val[0] === def[0]) continue;      // covered by the pan-India row
        out.push(row({ region: lab.region, state: lab.state, ncbYes,
                       rate_value: val[0], effective_from: eff }));
        continue;
      }
      FUELS.forEach((f, i) => {
        if (val[i] === def[i]) return;        // covered by the pan-India row
        out.push(row({ region: lab.region, state: lab.state, fuel_type: f, ncbYes,
                       rate_value: val[i], effective_from: eff }));
      });
    }
  }
  return out;
}

module.exports = {
  insurer: 'bajaj_allianz',
  suppress: [
    // The ingested 1801 Comprehensive grid: bulk.js drops every COMP rule for
    // product-1801 CARs and injects the config rate, and these rows carry two
    // conflicting COMP values per region×fuel (the NCB column collapsed on
    // ingest). SAOD/STOD rows of the same sheet are NOT replaced → left in place.
    (r) => String(r.sheet_name || '') === 'PVT car Comprehensive & STOD'
        && String(r.product || '').toUpperCase() === 'CAR'
        && /^COMP$/i.test(String(r.rate_type || '')),
  ],
  expand,
  // exported for the verification script
  _rateFor: rateFor,
  _listedStates: listedStates,
};
