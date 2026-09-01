'use strict';

/**
 * KOTAK — Private Car SATP (make × RTO × fuel × CC grid) → Luca export rows.
 *
 * WHY THIS EXISTS: the "SATP Private car Pan india Sep.'26" grid (card 710) was
 * MIS-INGESTED — the RTOCodeMAKE composite key ("AP11HONDA") landed whole in the
 * region column, product came in NULL, the three CC bands collapsed, and every
 * cell was tagged COMP even though it is a SATP (TP) grid. Those rows therefore
 * (a) never classify as CAR so they drop out of the file, and (b) if read by the
 * engine would assert a 50% OD comp. The engine already prices this grid from
 * config/kotak_satp_pvtcar_sep26.json (routes/bulk.js, date-aware ≥ 1-Sep-2026);
 * this expander surfaces the SAME config in the Luca file, and `suppress` drops
 * the mis-ingested DB rows.
 *
 * Config shape: { RTO: { MAKE: { P:[<1000,1000-1500,>1500], C:[…], D:[…] } } }.
 * Rates are FRACTIONS (0.5 = 50%). 0 = NIL PO (dropped — the export skips a
 * zero/blank commission row). MAKE 'OTHERS' is the per-RTO catch-all and is
 * emitted with a literal make label so it doesn't collide with the specific-make
 * rows (a blank make would read as "all makes" and conflict).
 *
 * Only emitted for the Sept generation (card effective_from ≥ 1-Sep-2026): the
 * make-grid was never in the file before, so we don't back-date it onto older
 * exports.
 */

const SEP = require('../../config/kotak_satp_pvtcar_sep26.json');
const JUN = require('../../config/kotak_satp_pvtcar.json');   // 11-Jun make-grid

// Date-banded grid: the make-grid supersedes the district COA SATP from 11-Jun;
// the Sept grid takes over on 1-Sep. Before 11-Jun there was no make-grid.
function gridFor(dd) {
  if (dd >= '2026-09-01') return { g: SEP, sheet: 'SATP Private Car Pan India Sep26' };
  if (dd >= '2026-06-11') return { g: JUN, sheet: 'SATP Private Car make-grid Jun26' };
  return null;
}
// P/C/D → concrete Luca fuel; the CC band index → [min,max] cc (matches the
// engine's ci: cc<1000 → 0, cc<=1500 → 1, else 2).
const FUEL = { P: 'PETROL', C: 'CNG', D: 'DIESEL' };
const CC_BANDS = [[null, 999], [1000, 1500], [1501, null]];

function row(o) {
  return {
    insurer: 'kotak', product: 'CAR', sheet_name: o.sheet_name,
    region: o.region, segment: 'Pvt Car SATP',
    make: o.make || null, model: null, sub_type: null,
    fuel_type: o.fuel_type || null,
    cc_band_min: o.cc_band_min == null ? null : o.cc_band_min,
    cc_band_max: o.cc_band_max == null ? null : o.cc_band_max,
    age_band_min: null, age_band_max: null,
    weight_band_min: null, weight_band_max: null,
    seating_capacity_min: null, seating_capacity_max: null,
    rate_type: 'SATP', rate_value: o.rate_value,
    remarks: 'Kotak Pvt Car SATP grid (Sep26) — RTO × make × fuel × CC',
    state: null, effective_from: o.effective_from || null,
  };
}

const allEq = (a) => a[0] === a[1] && a[1] === a[2];

function expand(eff) {
  const dd = eff instanceof Date ? eff.toISOString().slice(0, 10) : String(eff || '').slice(0, 10);
  const pick = gridFor(dd);
  if (!pick) return [];                 // pre-make-grid era → COA DB rows stand
  const { g: GRID, sheet } = pick;

  const out = [];
  for (const rto of Object.keys(GRID)) {
    const makes = GRID[rto] || {};
    for (const mk of Object.keys(makes)) {
      const g = makes[mk] || {};
      const makeLabel = mk;   // keep 'OTHERS' literal so it never reads as all-makes
      // Collapse the fuel dimension: if P, C, D are identical vectors emit one
      // fuel-invariant group (blank fuel = all fuels); otherwise one per fuel.
      const vecs = { P: g.P || [0, 0, 0], C: g.C || [0, 0, 0], D: g.D || [0, 0, 0] };
      const sig = (v) => v.join('|');
      const groups = new Map();   // signature → { fuels:[], vec }
      for (const fk of ['P', 'C', 'D']) {
        const s = sig(vecs[fk]);
        if (!groups.has(s)) groups.set(s, { fuels: [], vec: vecs[fk] });
        groups.get(s).fuels.push(fk);
      }
      for (const { fuels, vec } of groups.values()) {
        if (vec.every((x) => !(Number(x) > 0))) continue;    // all NIL → nothing to emit
        const fuelInvariant = fuels.length === 3;            // P=C=D
        const emitFuels = fuelInvariant ? [null] : fuels.map((fk) => FUEL[fk]);
        // Collapse the CC dimension when all three bands share a rate.
        const ccGroups = allEq(vec)
          ? [{ cc: [null, null], rate: vec[0] }]
          : vec.map((rate, i) => ({ cc: CC_BANDS[i], rate }));
        for (const cg of ccGroups) {
          if (!(Number(cg.rate) > 0)) continue;
          for (const f of emitFuels) {
            out.push(row({
              region: rto, make: makeLabel, fuel_type: f,
              cc_band_min: cg.cc[0], cc_band_max: cg.cc[1],
              rate_value: cg.rate, effective_from: eff, sheet_name: sheet,
            }));
          }
        }
      }
    }
  }
  return out;
}

module.exports = {
  insurer: 'kotak',
  // Drop the mis-ingested Sept SATP card (sheet "Sheet1", region = RTO+MAKE
  // composite like "AP11HONDA"): resolved from config instead. Scoped so the
  // genuine Kotak sheets (TW, GCV, COA SATP, tractor) are untouched.
  suppress: [
    // (a) the mis-ingested Sept SATP card 710 (sheet "Sheet1", region=RTO+MAKE).
    (r) => /^sheet1$/i.test(String(r.sheet_name || '').trim())
        && /^[A-Z]{2}\d+[A-Z]{2,}$/i.test(String(r.region || '').trim()),
    // (b) the district COA / generic Pvt-Car SATP DB rows (cards 455/519/547/649,
    // sheets "RTO list for each district" / "Sheet2" / "Rest Grid"): the engine
    // prices Kotak CAR SATP from the make-grid config (bulk.js) from 11-Jun on, so
    // these are rates it never pays. Comp/SAOD rows are left untouched.
    (r) => /^CAR$/i.test(String(r.product || '').trim())
        && /^SATP$/i.test(String(r.rate_type || '').trim()),
  ],
  expand,
};
