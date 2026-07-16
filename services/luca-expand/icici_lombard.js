'use strict';

/**
 * ICICI Lombard — Luca export expander (CV/PO grid + Two-Wheeler).
 *
 * WHY THIS EXISTS
 * ---------------
 * routes/bulk.js overrides the ingested rate_rules for two ICICI families:
 *
 *  1. CV "PO grid" (config/icici_cv_po_jun26.json + services/icici-cv-po.js).
 *     The ingested CV_COMP / CV_AOTP rows are the BASE grid and they FLATTENED the
 *     grid's conditional cells ("OLD|1-3 yrs:0%,OTHERS:40%") down to a single value
 *     — usually the 0% leg. e.g. BIHAR "GCV 3W Old": DB 0% vs PO grid 40% for a
 *     4-yr-old. The live engine is scoped to 3W / LCV / SCV (LIVE_SEG in the
 *     resolver); MHCV / Misc-D / Tractor / buses / taxis stay on the DB rows, so
 *     ONLY the 3W/LCV/SCV cells are suppressed here.
 *
 *  2. TW (config/icici_tw_jun26.json + services/icici-tw.js).
 *     VERIFIED: the ingested "TW Old" sheet matches config.twOld EXACTLY (882/882
 *     rows, zero divergence) — it is clean, the override is a no-op for it, so it is
 *     NOT suppressed and NOT re-emitted. The real gap is TW **New** (make × body,
 *     the 1+5 bundle), which exists in NO rate_card at all. Those rows are added.
 *
 * FIDELITY
 * --------
 * The PO cells are conditional on cover × age × make (and sub-cluster). Rather than
 * re-implement that, this module calls the resolver's OWN parseCell(), then resolves
 * the winner per concrete scope (cover × age × make probe) and collapses:
 * a base "all makes" row per age band, plus a make row only where the rate DIFFERS.
 *
 * Two consequences of mirroring the engine, deliberately preserved:
 *  - ctx.subCluster is never populated by any caller, so sub-cluster clauses
 *    (GJ1 / KA1 / UP1 EAST / BHUBANESHWAR …) never fire. Cells that resolve to
 *    nothing return null → the engine keeps the DB row → we neither emit nor suppress.
 *  - services/icici-cv-po.js isMakeToken() mis-classes age bands with a two-digit
 *    upper bound ("4-10yrs", "6-10yrs", "1-10 yrs") as MAKE tokens, which flips them
 *    from AND- to OR-semantics. KARNATAKA "LCV 7.5-12T" = "AL|1-3yrs|10+ YRS:0%,
 *    TATA|1-5yrs:0%,EICHER|4-10yrs:0%,OTHERS:25%" therefore pays 0% to ANY make aged
 *    4-10, not just Eicher. That is what the ENGINE PAYS, so it is what this file
 *    reports — an agent quoted 25% who is then paid 0% is the harm case. Flagged for
 *    a separate resolver fix; NOT worked around here.
 */

const CV = require('../../config/icici_cv_po_jun26.json');
const TW = require('../../config/icici_tw_jun26.json');
const { parseCell } = require('../icici-cv-po');

const INSURER = 'icici_lombard';

// region key — identical normalisation to services/icici-cv-po.js
const cvKey = (s) => String(s == null ? '' : s).trim().toUpperCase()
  .replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
// region key — identical normalisation to services/icici-tw.js
const twKey = (s) => String(s == null ? '' : s).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

const CV_COMP_IDX = {}; for (const k of Object.keys(CV.comp || {})) CV_COMP_IDX[cvKey(k)] = CV.comp[k];
const CV_AOTP_IDX = {}; for (const k of Object.keys(CV.aotp || {})) CV_AOTP_IDX[cvKey(k)] = CV.aotp[k];

/** Shape a pseudo rate_rules row (mirrors luca-config-expand.js `row`). */
function row(o) {
  return {
    insurer: INSURER,
    product: o.product || null,
    sheet_name: o.sheet_name || null,
    region: o.region || null,
    segment: o.segment || null,
    make: o.make || null,
    model: o.model || null,
    sub_type: o.sub_type || null,
    fuel_type: o.fuel_type || null,
    cc_band_min: null,
    cc_band_max: null,
    age_band_min: o.age_band_min == null ? null : o.age_band_min,
    age_band_max: o.age_band_max == null ? null : o.age_band_max,
    weight_band_min: o.weight_band_min == null ? null : o.weight_band_min,
    weight_band_max: o.weight_band_max == null ? null : o.weight_band_max,
    rate_type: o.rate_type || null,
    rate_value: o.rate_value,
    remarks: o.remarks || null,
    state: null,
    effective_from: o.effective_from || null,
  };
}

// ---------------------------------------------------------------------------
// CV — live segments only (the resolver's LIVE_SEG = /3W|LCV|SCV/).
//   key   = the column name in config/icici_cv_po_jun26.json
//   label = agent-facing segment text. It MUST classify correctly through
//           excel-export.inferVehicleType(): a leading "GCV" token pins the goods
//           carriers; product:'PCV' pins the passenger 3-wheelers.
//   ages  : 'new' → only reachable with age 0 (segmentFor picks the New column)
//           'old' → only reachable with age >= 1
//           'any' → column has no New/Old split
// ---------------------------------------------------------------------------
const LIVE = {
  'GCV 3W New':             { product: 'GCV', label: 'GCV 3W Goods Auto New',            ages: 'new' },
  'GCV 3W Old':             { product: 'GCV', label: 'GCV 3W Goods Auto Old',            ages: 'old' },
  'GCV 3W Electric':        { product: 'GCV', label: 'GCV 3W Goods Auto Electric',       ages: 'any', fuel: 'ELECTRIC' },
  'SCV <2450 GVW New':      { product: 'GCV', label: 'GCV SCV below 2.45T GVW New',      ages: 'new', wmin: 0,    wmax: 2.45 },
  'SCV <2450 GVW Old':      { product: 'GCV', label: 'GCV SCV below 2.45T GVW Old',      ages: 'old', wmin: 0,    wmax: 2.45 },
  'SCV >= 2450 GVW New':    { product: 'GCV', label: 'GCV SCV 2.45T-3.5T GVW New',       ages: 'new', wmin: 2.45, wmax: 3.5 },
  'SCV >= 2450 GVW Old':    { product: 'GCV', label: 'GCV SCV 2.45T-3.5T GVW Old',       ages: 'old', wmin: 2.45, wmax: 3.5 },
  'LCV 3.5-7.5T':           { product: 'GCV', label: 'GCV LCV 3.5T-7.5T',                ages: 'any', wmin: 3.5,  wmax: 7.5 },
  'LCV 7.5-12T':            { product: 'GCV', label: 'GCV LCV 7.5T-12T',                 ages: 'any', wmin: 7.5,  wmax: 12 },
  'PCV 3W Petrol/CNG New':  { product: 'PCV', label: 'PCV 3W Auto Rickshaw Petrol/CNG New', ages: 'new' },
  'PCV 3W Petrol/CNG Old':  { product: 'PCV', label: 'PCV 3W Auto Rickshaw Petrol/CNG Old', ages: 'old' },
  'PCV 3W Others (Diesel)': { product: 'PCV', label: 'PCV 3W Auto Rickshaw Diesel',      ages: 'any', fuel: 'DIESEL' },
  'PCV 3W Electric':        { product: 'PCV', label: 'PCV 3W E-Rickshaw Electric',       ages: 'any', fuel: 'ELECTRIC' },
};

// DB segment text (as ingested in CV_COMP / CV_AOTP) → config column.
const DB_SEG = {
  'GCV 3W (New)': 'GCV 3W New',
  'GCV 3W (Old)': 'GCV 3W Old',
  'GCV 3W Electric': 'GCV 3W Electric',
  'SCV <2.45T GVW (New)': 'SCV <2450 GVW New',
  'SCV <2.45T GVW (Old)': 'SCV <2450 GVW Old',
  'SCV >=2.45T GVW (New)': 'SCV >= 2450 GVW New',
  'SCV >=2.45T GVW (Old)': 'SCV >= 2450 GVW Old',
  'LCV 3.5-7.5T': 'LCV 3.5-7.5T',
  'LCV 7.5-12T': 'LCV 7.5-12T',
  'PCV 3W Petrol/CNG (New)': 'PCV 3W Petrol/CNG New',
  'PCV 3W Petrol/CNG (Old)': 'PCV 3W Petrol/CNG Old',
  'PCV 3W Diesel': 'PCV 3W Others (Diesel)',
  'PCV 3W Electric': 'PCV 3W Electric',
};

// Probe every make the grid can actually key on. Probes are the CANONICAL make
// strings condMatch() compares against (it aliases AL→ASHOK LEYLAND, M&M→MAHINDRA,
// BB→BHARAT BENZ). Model tokens in the grid (BOLERO / SUPRO / "TATA Ace") are NOT
// probed: condMatch only ever sees the MAKE, so they fall to OTHERS — except
// "TATA Ace", which the TATA probe picks up via condMatch's canon.includes(make).
const MAKE_PROBES = [
  { probe: 'TATA', label: 'Tata' },
  { probe: 'ASHOK LEYLAND', label: 'Ashok Leyland' },
  { probe: 'MAHINDRA', label: 'Mahindra' },
  { probe: 'EICHER', label: 'Eicher' },
  { probe: 'BHARAT BENZ', label: 'Bharat Benz' },
  { probe: 'MARUTI', label: 'Maruti' },
  { probe: 'BAJAJ', label: 'Bajaj' },
  { probe: 'PIAGGIO', label: 'Piaggio' },
  { probe: 'ATUL', label: 'Atul' },
  { probe: 'TVS', label: 'TVS' },
];
// A make no grid token can match, used to read the cell's "all other makes" leg.
// Must be non-empty: condMatch does canon.includes(ctx.make), and '' matches all.
const OTHER = '__OTHER__';

const MAX_AGE = 30;                       // probe ceiling; a band reaching it is open-ended
const seq = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };

/** Replicate resolveIciciCvPoRate's cell selection exactly (Note 7: AOTP → CV_AOTP first). */
function pickCell(regionKey, seg, cover) {
  let cell = null;
  if (cover === 'AOTP') {
    const a = CV_AOTP_IDX[regionKey];
    if (a && a[seg] != null) cell = a[seg];
  }
  if (cell == null) {
    const c = CV_COMP_IDX[regionKey];
    if (c) cell = c[seg];
  }
  return cell == null ? null : cell;
}

/** Evaluate one concrete scope → fraction, or null (engine would keep the DB row). */
function evalScope(cell, cover, age, make) {
  const v = parseCell(cell, {
    cover,
    isNew: age <= 0,
    age,
    make,
    body: '',                 // no body ctx: 3W/LCV/SCV cells carry no body clause
    subCluster: '',           // never populated by any caller — see header
  });
  return v == null ? null : +(v / 100).toFixed(4);   // config cells are PERCENT strings
}

/** Group consecutive ages carrying the same non-null value into [min,max,value] bands. */
function toBands(ages, valueAt) {
  const out = [];
  let cur = null;
  for (const a of ages) {
    const v = valueAt(a);
    if (v == null) { cur = null; continue; }
    if (cur && cur.v === v && cur.max === a - 1) { cur.max = a; continue; }
    cur = { min: a, max: a, v };
    out.push(cur);
  }
  return out;
}

function cvRows(eff, keys) {
  const out = [];
  for (const regionLabel of Object.keys(CV.comp || {})) {
    const rk = cvKey(regionLabel);
    for (const [seg, meta] of Object.entries(LIVE)) {
      for (const cover of ['COMP', 'AOTP']) {
        const cell = pickCell(rk, seg, cover);
        if (cell == null) continue;
        const ages = meta.ages === 'new' ? [0]
          : meta.ages === 'old' ? seq(1, MAX_AGE) : seq(0, MAX_AGE);

        const base = {};
        for (const a of ages) base[a] = evalScope(cell, cover, a, OTHER);

        const mkVals = MAKE_PROBES.map((m) => {
          const v = {};
          let differs = false;
          for (const a of ages) { v[a] = evalScope(cell, cover, a, m.probe); if (v[a] !== base[a]) differs = true; }
          return { m, v, differs };
        });

        const anyBase = ages.some((a) => base[a] != null);
        if (!anyBase && !mkVals.some((x) => x.differs && ages.some((a) => x.v[a] != null))) continue;

        const shell = {
          product: meta.product,
          sheet_name: 'CV PO Grid Jun26',
          region: regionLabel,
          segment: meta.label,
          fuel_type: meta.fuel || null,
          weight_band_min: meta.wmin == null ? null : meta.wmin,
          weight_band_max: meta.wmax == null ? null : meta.wmax,
          rate_type: cover === 'AOTP' ? 'SATP' : 'COMP',
          effective_from: eff,
        };
        const band = (b, extra) => row({
          ...shell, ...extra,
          age_band_min: b.min,
          age_band_max: b.max >= MAX_AGE ? null : b.max,
          rate_value: b.v,
        });

        let emitted = 0;
        for (const b of toBands(ages, (a) => base[a])) { out.push(band(b, {})); emitted++; }
        for (const { m, v, differs } of mkVals) {
          if (!differs) continue;                       // fully covered by the base row
          // only the ages where this make actually departs from the base
          for (const b of toBands(ages, (a) => (v[a] === base[a] ? null : v[a]))) {
            out.push(band(b, { make: m.label }));
            emitted++;
          }
        }
        if (emitted) keys.add(`${cover}|${rk}|${seg}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TW — NEW (1+5 bundle) only. config.twNew stores FRACTIONS already (0.3 = 30%).
//   region × make-column × Bike/Scooter. makeCol() returns 'EV' for ANY electric
//   make, so the EV column is a single make-agnostic ELECTRIC row; the make columns
//   are therefore the non-electric (petrol) legs.
//   Makes with no grid column (Bajaj / KTM / Vespa) resolve to null → the engine
//   keeps its DB row → nothing is emitted for them. Reported as unresolved.
// ---------------------------------------------------------------------------
const TW_NEW_COLS = [
  { key: 'HMC_Bike', make: 'Hero', body: 'Bike' },
  { key: 'HMC_Scooter', make: 'Hero', body: 'Scooter' },
  { key: 'HMSI_Bike', make: 'Honda', body: 'Bike' },
  { key: 'HMSI_Scooter', make: 'Honda', body: 'Scooter' },
  { key: 'RE_Bike', make: 'Royal Enfield', body: 'Bike' },
  { key: 'Suzuki_Bike', make: 'Suzuki', body: 'Bike' },
  { key: 'Suzuki_Scooter', make: 'Suzuki', body: 'Scooter' },
  { key: 'TVS_Bike', make: 'TVS', body: 'Bike' },
  { key: 'TVS_Scooter', make: 'TVS', body: 'Scooter' },
  { key: 'Yamaha_Bike', make: 'Yamaha', body: 'Bike' },
  { key: 'Yamaha_Scooter', make: 'Yamaha', body: 'Scooter' },
];

function twRows(eff) {
  const out = [];
  for (const regionLabel of Object.keys(TW.twNew || {})) {
    const r = TW.twNew[regionLabel];
    if (!r) continue;
    const shell = {
      product: 'TW', sheet_name: 'TW Grid Premier Jun26 (New)', region: regionLabel,
      rate_type: 'COMP', age_band_min: 0, age_band_max: 0, effective_from: eff,
    };
    for (const c of TW_NEW_COLS) {
      if (r[c.key] == null) continue;
      out.push(row({
        ...shell,
        segment: `Two Wheeler ${c.body} New 1+5 Bundled`,
        make: c.make,
        fuel_type: 'PETROL',            // electric of ANY make routes to the EV column
        rate_value: r[c.key],
      }));
    }
    if (r.EV != null) {
      out.push(row({
        ...shell,
        segment: 'Two Wheeler New 1+5 Bundled',
        fuel_type: 'ELECTRIC',
        rate_value: r.EV,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
let CACHE = null;
function build() {
  if (CACHE) return CACHE;
  const keys = new Set();
  const rows = cvRows(null, keys).concat(twRows(null));
  CACHE = { rows, keys };
  return CACHE;
}

/**
 * Suppress ONLY the CV base-grid cells the PO resolver actually replaces:
 * the 3W / LCV / SCV segments, and only for the exact (cover, region, segment)
 * scopes where the PO grid produced a rate. Where the PO cell yields nothing
 * (sub-cluster-only cells, "CC" council-call, "COMP:x%" read under AOTP) the
 * engine keeps the DB row, so the DB row is left alone.
 * "TW Old" is NOT suppressed — verified identical to config.twNew's twOld table.
 */
function suppressCv(r) {
  if (!/^icici/i.test(String(r.insurer || '').trim())) return false;
  const sn = String(r.sheet_name || '').trim();
  const cover = /^CV_COMP$/i.test(sn) ? 'COMP' : /^CV_AOTP$/i.test(sn) ? 'AOTP' : null;
  if (!cover) return false;
  const seg = DB_SEG[String(r.segment || '').trim()];
  if (!seg) return false;
  return build().keys.has(`${cover}|${cvKey(r.region)}|${seg}`);
}

module.exports = {
  insurer: INSURER,
  suppress: [suppressCv],
  expand: (effFrom) => build().rows.map((r) => ({ ...r, effective_from: effFrom || null })),
  // exported for verification
  _internals: { LIVE, DB_SEG, pickCell, evalScope, build },
};
