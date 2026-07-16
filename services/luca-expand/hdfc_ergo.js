'use strict';

/**
 * HDFC ERGO — GCV + TW (Comp/TP/SAOD) + passenger-3W expander for the Luca export.
 *
 * WHY: HDFC's GCV and TW grids are computed at CALCULATION time by resolvers
 * (services/hdfc-gcv.js, services/hdfc-tw.js, services/hdfc-rto.js) from config
 * JSON, because the generic ingest mangled the source sheets. The DB rows the
 * export would otherwise publish are rates the engine NEVER pays:
 *
 *  - GCV "Grid" (card 533, 957 rows): the source cells are free-text conditional
 *    rules ("Bolero <5 years 37.5%, >5 years 42.5%, others 52.5%", "Grid+7.5%",
 *    "35%, <5 years decline"). The parser flattened them into bare numbers and
 *    dropped the make/age conditions — identity (region 'All', 'GCV', COMP) alone
 *    holds 15 DIFFERENT rate_values from 0.10 to 0.65 across 85 rows.
 *    services/hdfc-gcv.js interprets the APPROVED cell instead.
 *
 *  - TW "Grid - Comp, TP only" (358 rows) and "Grid - SA-OD" (252 rows): the
 *    STATE dimension was lost entirely (rr.state is NULL on every row), so all
 *    the per-state "All" cells collapsed onto region='All' — e.g. (All, Scooter,
 *    COMP, <=150cc) holds 9 distinct values (0.45-0.625) in 10 rows, and (All,
 *    Bike, SAOD, All) holds 8 (0.10-0.60). Delhi-NCR was also conflated with
 *    Haryana (DB Delhi NCR Scooter COMP = 0.55 = Haryana's rate; the real grid
 *    says 60). The SA-OD sheet additionally carries make='TVS' rows derived from
 *    a "TVS 10% less" note that the operator does NOT apply (services/hdfc-tw.js
 *    resolveTwSaodRate pays the base row; bulk.js:6080 re-asserts the same for
 *    ROTN). services/hdfc-tw.js replaces both sheets.
 *
 *  - Passenger 3W ("PCCV 3W"): never ingested at all — no active card has that
 *    sheet, so there is nothing to suppress; the grid lives only in
 *    config/hdfc_pcv_3w.json and is applied by services/hdfc-rto.js.
 *
 * Rates emitted are GRID rates as FRACTIONS (the export subtracts the margin).
 *   - config/hdfc_gcv_grid.json cells → services/hdfc-gcv.js interpret() → fraction
 *   - config/hdfc_tw_grid.json / hdfc_tw_saod.json store PERCENTS (66) → /100
 *   - config/hdfc_pcv_3w.json stores FRACTIONS (0.65) → as-is
 */

const GCV_GRID = require('../../config/hdfc_gcv_grid.json');
const TW_GRID = require('../../config/hdfc_tw_grid.json');
const TW_SAOD = require('../../config/hdfc_tw_saod.json');
const PCV_3W = require('../../config/hdfc_pcv_3w.json');
// The GCV cell interpreter itself — reused (not reimplemented) so the exported
// rate is byte-for-byte what routes/bulk.js pays. Read-only require.
const { interpret } = require('../hdfc-gcv');

const INSURER = 'hdfc_ergo';

/** Shape a pseudo rate_rules row (mirrors luca-config-expand's row()). */
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
    cc_band_min: o.cc_band_min == null ? null : o.cc_band_min,
    cc_band_max: o.cc_band_max == null ? null : o.cc_band_max,
    age_band_min: o.age_band_min == null ? null : o.age_band_min,
    age_band_max: o.age_band_max == null ? null : o.age_band_max,
    weight_band_min: o.weight_band_min == null ? null : o.weight_band_min,
    weight_band_max: o.weight_band_max == null ? null : o.weight_band_max,
    rate_type: o.rate_type || null,
    rate_value: o.rate_value,
    remarks: o.remarks || null,
    state: o.state || null,
    effective_from: o.effective_from || null,
  };
}

// Percent (66) → fraction (0.66). Mirrors the resolvers' `n > 1 ? n / 100 : n`.
function frac(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? +(n / 100).toFixed(4) : +n.toFixed(4);
}

// ---------------------------------------------------------------------------
// GCV — config/hdfc_gcv_grid.json + services/hdfc-gcv.js
//
// Each (state, loc, band) row holds an Approved-Comp and Approved-SATP cell that
// interpret() resolves against a MAKE × AGE context. We can't dump the raw cells
// (they're prose), so we resolve the winner for every concrete scope exactly as
// the resolver does, then collapse:
//   - probe ages 0..6 (every threshold in the grid text is <= 5, so age 6 stands
//     for "6 and older") and merge contiguous ages with an equal outcome;
//   - emit the "other makes" outcome once as the make-agnostic catch-all row, and
//     add a make row only where that make's rate actually DIFFERS.
// interpret() returns: number = fraction, null = DECLINED (grid pays 0),
// undefined = un-parseable prose → emit NOTHING (never guess).
// ---------------------------------------------------------------------------

// Weight bands, mirroring bandFromCat() in services/hdfc-gcv.js.
const BANDS = {
  '3W': { seg: 'GCV 3W Goods Auto', ton: [null, null] },
  '0-2.5T': { seg: 'GCV 0-2.5T', ton: [0, 2.5] },
  '2.5-3.5T': { seg: 'GCV 2.5T-3.5T', ton: [2.5, 3.5] },
  '3.5-7.5T': { seg: 'GCV 3.5T-7.5T', ton: [3.5, 7.5] },
  '7.5-12T': { seg: 'GCV 7.5T-12T', ton: [7.5, 12] },
  '12-17T': { seg: 'GCV 12T-17T', ton: [12, 17] },
  '20-25T': { seg: 'GCV 20T-25T', ton: [20, 25] },
};
// HDFC's "Tata" premium applies to LIGHT Tata only; on the heavy bands a Tata
// takes the "others" rate (services/hdfc-gcv.js HEAVY_BANDS).
const HEAVY_BANDS = new Set(['7.5-12T', '12-17T', '20-25T']);
const AGE_PROBES = [0, 1, 2, 3, 4, 5, 6];

// Make scopes → the ctx flags services/hdfc-gcv.js would build for that make.
const MAKE_SCOPES = [
  { key: 'OTHER', make: null, model: null },
  { key: 'TATA', make: 'TATA', model: null },
  { key: 'BOLERO', make: 'MAHINDRA', model: 'BOLERO' },
  { key: 'MAHINDRA', make: 'MAHINDRA', model: null },
  { key: 'EICHER', make: 'EICHER', model: null },
];
function ctxFor(key, band, age) {
  return {
    isBolero: key === 'BOLERO',
    // resolver: isTata = /TATA/.test(make) && !HEAVY_BANDS.has(band)
    isTata: key === 'TATA' && !HEAVY_BANDS.has(band),
    isMahindra: key === 'MAHINDRA' || key === 'BOLERO',
    isEicher: key === 'EICHER',
    age,
  };
}

// interpret() outcome → a comparable key. undefined = unresolved, null = decline.
const okey = (v) => (v === undefined ? 'U' : v === null ? 'D' : String(v));

// Probe the cell across ages for one make scope → [{amin, amax, val}] with
// contiguous equal outcomes merged; the last band is open-ended (amax = null).
function ageBands(cell, base, band, scopeKey) {
  const vals = AGE_PROBES.map((a) => interpret(cell, base, ctxFor(scopeKey, band, a)));
  const out = [];
  for (let i = 0; i < AGE_PROBES.length; i++) {
    const prev = out[out.length - 1];
    if (prev && okey(prev.val) === okey(vals[i])) { prev.amax = AGE_PROBES[i]; continue; }
    out.push({ amin: AGE_PROBES[i], amax: AGE_PROBES[i], val: vals[i] });
  }
  out[out.length - 1].amax = null;          // the last probe (6) stands for "6+"
  if (out.length === 1) { out[0].amin = null; }   // age-invariant cell
  return out;
}
// Outcome of a scope at a given age (for the differs-from-catch-all test).
const at = (bands, age) => {
  const b = bands.find((x) => (x.amin == null || age >= x.amin) && (x.amax == null || age <= x.amax));
  return b ? b.val : undefined;
};
const sameAsOther = (a, b) => AGE_PROBES.every((age) => okey(at(a, age)) === okey(at(b, age)));

function gcv(eff) {
  const out = [];
  for (const g of GCV_GRID) {
    const meta = BANDS[g.band];
    if (!meta) continue;
    for (const cover of ['COMP', 'SATP']) {
      const cell = cover === 'SATP' ? g.apprSatp : g.apprComp;
      const base = cover === 'SATP' ? g.baseSatp : g.baseComp;
      if (!String(cell || '').trim()) continue;

      const byScope = {};
      for (const s of MAKE_SCOPES) byScope[s.key] = ageBands(cell, base, g.band, s.key);
      const other = byScope.OTHER;

      const emit = (scope, bands) => {
        for (const b of bands) {
          if (b.val === undefined) continue;             // un-parseable → never guess
          out.push(row({
            product: 'GCV',
            sheet_name: 'GCV Grid (HDFC approved)',
            region: g.loc || null,
            state: g.state || null,
            segment: meta.seg,
            make: scope.make,
            model: scope.model,
            weight_band_min: meta.ton[0],
            weight_band_max: meta.ton[1],
            age_band_min: b.amin,
            age_band_max: b.amax,
            rate_type: cover,
            rate_value: b.val === null ? 0 : b.val,      // null = grid DECLINE → 0%
            remarks: b.val === null ? 'Declined by grid' : null,
            effective_from: eff,
          }));
        }
      };

      emit(MAKE_SCOPES[0], other);                        // make-agnostic catch-all
      for (const s of MAKE_SCOPES.slice(1)) {
        const bands = byScope[s.key];
        if (sameAsOther(bands, other)) continue;          // covered by the catch-all
        // A Bolero is a Mahindra: if the make=MAHINDRA row is being emitted and
        // says the same thing, don't restate it as a model row.
        if (s.key === 'BOLERO' && !sameAsOther(byScope.MAHINDRA, other)
            && sameAsOther(bands, byScope.MAHINDRA)) continue;
        emit(s, bands);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TW Comp / TP-Only — config/hdfc_tw_grid.json + services/hdfc-tw.js
//   rows: {pt: 'Comp'|'TP Only', seg: 'Scooter / Moped'|'Bike', state, loc,
//          le150, gt150} — PERCENTS. The resolver splits on cc 150 only.
//   fuel_type is left NULL on purpose: the config's "Petrol" column is the only
//   one filed and resolveTwRate never gates on fuel (an EV scooter takes the
//   same rate), so tagging PETROL would wrongly narrow the row.
// ---------------------------------------------------------------------------
function tw(eff) {
  const out = [];
  for (const g of TW_GRID) {
    const rt = /TP/i.test(String(g.pt)) ? 'SATP' : 'COMP';
    const seg = /BIKE/i.test(String(g.seg)) ? 'Two Wheeler Bike' : 'Two Wheeler Scooter / Moped';
    const lo = frac(g.le150), hi = frac(g.gt150);
    const base = {
      product: 'TW', sheet_name: 'TW Grid - Comp, TP only',
      region: g.loc || 'All', state: g.state || null, segment: seg,
      rate_type: rt, effective_from: eff,
    };
    if (lo != null && hi != null && lo === hi) {
      out.push(row({ ...base, rate_value: lo }));                       // cc-invariant
    } else {
      if (lo != null) out.push(row({ ...base, cc_band_min: 0, cc_band_max: 150, rate_value: lo }));
      if (hi != null) out.push(row({ ...base, cc_band_min: 151, rate_value: hi }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TW SAOD — config/hdfc_tw_saod.json + services/hdfc-tw.js resolveTwSaodRate()
//   The resolver takes the BASE (blank-remarks) row of each (state, loc, seg)
//   group and IGNORES the "exc <make>" variants: when a blank row exists it wins
//   for every make (`pool.find(r => !r.rem) || pool[0]`), and in a group whose
//   only row is an "exc" row that row is returned regardless of make (the make
//   filter empties the pool, which then falls back to the same rows). So the
//   paid rate is make-INVARIANT → one make-agnostic row per group.
// ---------------------------------------------------------------------------
function twSaod(eff) {
  const groups = new Map();
  for (const r of TW_SAOD) {
    const k = [r.state, r.loc, r.seg].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const rows of groups.values()) {
    const pick = rows.find((r) => !r.rem) || rows[0];
    const v = frac(pick.bde);
    if (v == null) continue;
    out.push(row({
      product: 'TW', sheet_name: 'TW Grid - SA-OD',
      region: pick.loc || 'All', state: pick.state || null,
      segment: /BIKE/i.test(String(pick.seg)) ? 'Two Wheeler Bike' : 'Two Wheeler Scooter / Moped',
      rate_type: 'SAOD', rate_value: v, effective_from: eff,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Passenger 3W (auto / e-rickshaw) — config/hdfc_pcv_3w.json + services/hdfc-rto.js
//   region → {_label, New:{DIESEL,PETROL,EV}, NonNew:{...}} — FRACTIONS, and a
//   SINGLE cover-agnostic payout (the grid files one "BDE" column), which
//   bulk.js applies to Comp AND TP alike → emit both COMP and SATP.
//   Mirrors resolveHdfcPcv3wRate's two fallbacks:
//     band = e[biz] || e[otherBiz];  rate = band[fuel] != null ? band[fuel] : band.PETROL
//   New = age 0; NonNew = age 1+.
// ---------------------------------------------------------------------------
const PCV_FUEL = { DIESEL: 'DIESEL', PETROL: 'PETROL', EV: 'ELECTRIC' };

function pcv3w(eff) {
  const out = [];
  for (const key of Object.keys(PCV_3W)) {
    const e = PCV_3W[key];
    if (!e) continue;
    for (const biz of ['New', 'NonNew']) {
      const band = e[biz] || e[biz === 'NonNew' ? 'New' : 'NonNew'];
      if (!band) continue;
      for (const f of Object.keys(PCV_FUEL)) {
        const rate = band[f] != null ? band[f] : band.PETROL;
        if (rate == null) continue;                       // no cell → emit nothing
        for (const rt of ['COMP', 'SATP']) {
          out.push(row({
            product: 'PCV',
            sheet_name: 'PCCV 3W',
            region: e._label || key,
            segment: biz === 'New' ? 'PCV 3W Auto Rickshaw Brand New' : 'PCV 3W Auto Rickshaw',
            fuel_type: PCV_FUEL[f],
            age_band_min: biz === 'New' ? 0 : 1,
            age_band_max: biz === 'New' ? 0 : null,
            rate_type: rt,
            rate_value: +Number(rate).toFixed(4),
            effective_from: eff,
          }));
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suppression — ONLY the two mis-ingested sheets the resolvers replace.
// sheet_name 'Grid' is shared with the Pvt-Car card, so the GCV test also pins
// product='GCV'. The Pvt-Car sheets ('PVT Car', 'Grid'/CAR) are NOT touched.
// ---------------------------------------------------------------------------
const sheet = (r) => String(r.sheet_name || '').trim();
const prod = (r) => String(r.product || '').trim().toUpperCase();

module.exports = {
  insurer: INSURER,
  suppress: [
    // GCV free-text grid flattened into ambiguous numbers → services/hdfc-gcv.js
    (r) => prod(r) === 'GCV' && /^Grid$/i.test(sheet(r)),
    // TW Comp/TP: state dimension lost, Delhi-NCR = Haryana → services/hdfc-tw.js
    (r) => prod(r) === 'TW' && /^Grid\s*-\s*Comp,\s*TP only$/i.test(sheet(r)),
    // TW SAOD: state dimension lost + unpaid "TVS 10% less" rows → services/hdfc-tw.js
    (r) => prod(r) === 'TW' && /^Grid\s*-\s*SA-?OD$/i.test(sheet(r)),
  ],
  expand: (effFrom) => [
    ...gcv(effFrom),
    ...tw(effFrom),
    ...twSaod(effFrom),
    ...pcv3w(effFrom),
  ],
};
