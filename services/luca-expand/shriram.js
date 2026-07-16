'use strict';

/**
 * Shriram — NEW-BUSINESS Two Wheeler (age-0 bundle) expander for the Luca export.
 *
 * WHY
 * ---
 * The June grid sheet "New Business - 2W" is State-group x Manufacturer-group x
 * Body (BIKE <=180CC / SCOOTER-MOPED / EV) -> "Average Net PO (Converted)".
 * The base ingest (card 591) took the WRONG COLUMN ("DIS %") and FLATTENED the
 * make dimension, so the DB rows show rates the engine never pays (e.g. an
 * AP/Telangana Ather EV row carries 45 while the grid Net PO is 40; a Royal
 * Enfield bike row carries 50 while the grid Net PO is 30; a Mumbai Honda new
 * bike got DIS 70 instead of Net PO 35). At CALCULATION time routes/bulk.js
 * (~line 6292) discards those rows for every age-0 TW and takes the make-aware
 * Net PO from services/shriram-tw.js -> config/shriram_tw_nb.json.
 *
 * So: suppress the whole "New Business - 2W" sheet and re-emit it from config.
 * Only that sheet is suppressed — "ROLLOVE (PKG+TP) - 2W" (rollover TW),
 * "BROKER GRID MAR 26" and "Short-term policy" are NOT replaced by any resolver
 * and stay as ingested.
 *
 * HOW
 * ---
 * config/shriram_tw_nb.json `net` is already a FRACTION (0.30 = 30%), so it is
 * passed through unscaled. The resolver picks by SPECIFICITY (mumbai group beats
 * rom group, then the shortest make list, then the highest net), so rather than
 * dumping raw config rows this expander drives the REAL resolver
 * (resolveShriramTwNb) once per concrete scope (state x body x make x cc band)
 * and emits the winner — guaranteeing the exported rate is exactly what the
 * engine pays. Identical rates across a state's makes collapse to one make-less
 * row; a make row is only emitted where its rate actually differs.
 *
 * UNRESOLVED (deliberately not emitted — see the agent report):
 *   - per-RTO carve-outs inside a state (Haryana excl HR38/HR51/HR55; UP excl
 *     UP31): the export has no RTO dimension, and those RTOs fall through to the
 *     (mis-ingested) DB rows rather than to a resolver rate, so no rate is claimed.
 *   - makes absent from the grid (TVS, Yamaha outside West Bengal, Ola, ...):
 *     the resolver returns no match, so nothing is emitted.
 */

const { resolveShriramTwNb } = require('../shriram-tw');

const INSURER = 'shriram';
const SHEET = 'New Business - 2W';

/** Shape a pseudo rate_rules row (only the fields buildLucaBuffer reads). */
function row(o) {
  return {
    insurer: INSURER,
    product: 'TW',
    sheet_name: SHEET,
    region: o.region || null,
    segment: o.segment || null,
    make: o.make || null,
    model: null,
    sub_type: o.sub_type || null,
    fuel_type: o.fuel_type || null,
    cc_band_min: o.cc_band_min == null ? null : o.cc_band_min,
    cc_band_max: o.cc_band_max == null ? null : o.cc_band_max,
    age_band_min: 0,          // NEW business only
    age_band_max: 0,
    weight_band_min: null,
    weight_band_max: null,
    rate_type: 'COMP',        // age-0 bundled package (1+5 / 5+5 / ...) — one Net PO, no NCB split
    rate_value: o.rate_value,
    remarks: o.remarks || null,
    state: o.state || null,
    effective_from: o.effective_from || null,
  };
}

// Concrete scopes. `rto` is a REPRESENTATIVE RTO of the scope, chosen to avoid
// the grid's per-RTO exclusions (Haryana -> HR26 not HR38/51/55; UP -> UP32 not
// UP31) so the emitted rate is the state's headline rate.
// Maharashtra is split because the resolver's "MUMBAI (Excl MH-01,48)" group
// covers all of MH EXCEPT MH01/MH48; those two RTOs only see the "ROM" rows.
const SCOPES = [
  { state: 'MAHARASHTRA',       rto: 'MH12', region: 'Maharashtra (Excl MH-01, MH-48)' },
  { state: 'MAHARASHTRA',       rto: 'MH01', region: 'Maharashtra MH-01 / MH-48' },
  { state: 'GOA',               rto: 'GA01', region: 'Goa' },
  { state: 'GUJARAT',           rto: 'GJ01', region: 'Gujarat' },
  { state: 'KARNATAKA',         rto: 'KA01', region: 'Karnataka' },
  { state: 'TAMILNADU',         rto: 'TN01', region: 'Tamil Nadu' },
  { state: 'ANDHRA PRADESH',    rto: 'AP01', region: 'Andhra Pradesh' },
  { state: 'TELANGANA',         rto: 'TG01', region: 'Telangana' },
  { state: 'UTTAR PRADESH',     rto: 'UP32', region: 'Uttar Pradesh', remarks: 'Excludes UP31 (grid carve-out)' },
  { state: 'DELHI',             rto: 'DL01', region: 'Delhi / NCR' },
  { state: 'HARYANA',           rto: 'HR26', region: 'Haryana', remarks: 'Excludes HR38 / HR51 / HR55 (grid carve-out)' },
  { state: 'PUNJAB',            rto: 'PB01', region: 'Punjab' },
  { state: 'RAJASTHAN',         rto: 'RJ01', region: 'Rajasthan' },
  { state: 'MADHYA PRADESH',    rto: 'MP01', region: 'Madhya Pradesh' },
  { state: 'CHHATTISGARH',      rto: 'CG01', region: 'Chhattisgarh' },
  { state: 'BIHAR',             rto: 'BR01', region: 'Bihar' },
  { state: 'JHARKHAND',         rto: 'JH01', region: 'Jharkhand' },
  { state: 'WEST BENGAL',       rto: 'WB01', region: 'West Bengal' },
  { state: 'ODISHA',            rto: 'OD01', region: 'Odisha' },
  { state: 'HIMACHAL PRADESH',  rto: 'HP01', region: 'Himachal Pradesh' },
  { state: 'UTTARAKHAND',       rto: 'UK01', region: 'Uttarakhand' },
  { state: 'ASSAM',             rto: 'AS01', region: 'Assam' },
  { state: 'TRIPURA',           rto: 'TR01', region: 'Tripura' },
  { state: 'JAMMU AND KASHMIR', rto: 'JK01', region: 'J & K' },
  { state: 'KERALA',            rto: 'KL01', region: 'Kerala' },
];

// Every manufacturer token that appears in config/shriram_tw_nb.json, with the
// label to print. Anything else (TVS, Ola, ...) is not on the grid.
const MAKES = [
  { canon: 'HERO',         label: 'HERO' },
  { canon: 'HONDA',        label: 'HONDA' },
  { canon: 'SUZUKI',       label: 'SUZUKI' },
  { canon: 'BAJAJ',        label: 'BAJAJ' },
  { canon: 'YAMAHA',       label: 'YAMAHA' },
  { canon: 'PIAGGIO',      label: 'PIAGGIO' },
  { canon: 'ATHER',        label: 'ATHER' },
  { canon: 'ROYALENFIELD', label: 'ROYAL ENFIELD' },
];

// Body scopes, expressed as the params the resolver's bodyOf() reads.
//   BIKE is cc-gated by the grid (most bike cells are "<=180CC"), so it is probed
//   at both a <=180 cc and a >180 cc point and only split when the rate differs.
const BODIES = [
  { body: 'BIKE',    segment: 'Two Wheeler Bike New Business (Bundled)',
    params: { vehicleCategory: 'MOTORCYCLE', fuelType: 'PETROL' }, fuel_type: null, sub_type: 'Bike',
    ccProbes: [{ cc: 150, min: null, max: 180 }, { cc: 350, min: 181, max: null }] },
  { body: 'SCOOTER', segment: 'Two Wheeler Scooter New Business (Bundled)',
    params: { vehicleCategory: 'SCOOTER', fuelType: 'PETROL' }, fuel_type: null, sub_type: 'Scooter / Moped',
    ccProbes: [{ cc: 110, min: null, max: null }] },
  // The grid's EV cell is body-agnostic (the resolver's bodyOf() returns 'EV' for
  // ANY electric two-wheeler), so the same rate is emitted under a scooter-flavoured
  // and a bike-flavoured segment — otherwise lucaProduct would file every electric
  // 2W as 'private_bike' and the e-scooters (Ather / Chetak / Vida) would be missing.
  { body: 'EV',      segment: 'Two Wheeler Electric Scooter New Business (Bundled)',
    params: { vehicleCategory: 'SCOOTER', fuelType: 'ELECTRIC' }, fuel_type: 'ELECTRIC', sub_type: 'Electric Scooter',
    ccProbes: [{ cc: 0, min: null, max: null }] },
  { body: 'EV',      segment: 'Two Wheeler Electric Bike New Business (Bundled)',
    params: { vehicleCategory: 'MOTORCYCLE', fuelType: 'ELECTRIC' }, fuel_type: 'ELECTRIC', sub_type: 'Electric Bike',
    ccProbes: [{ cc: 0, min: null, max: null }] },
];

/** Resolver-truth rate for one concrete cell, or undefined. */
function rateFor(scope, body, mk, cc) {
  const params = {
    vehicleType: 'TW', vehicleAge: 0, rtoCode: scope.rto,
    make: mk.canon, cc, ...body.params,
  };
  const v = resolveShriramTwNb(params, scope.region);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function expand(effFrom) {
  const out = [];
  for (const scope of SCOPES) {
    for (const body of BODIES) {
      const base = {
        region: scope.region, state: scope.state, segment: body.segment,
        sub_type: body.sub_type, fuel_type: body.fuel_type,
        remarks: scope.remarks || null, effective_from: effFrom || null,
      };

      // 1) per make: the resolver's rate at each cc probe. Collapse the cc
      //    dimension first — a make whose rate is the same on both sides of the
      //    grid's 180CC line becomes ONE all-cc row.
      const cells = [];   // { mk, min, max, v }
      for (const mk of MAKES) {
        const probes = body.ccProbes.map(p => ({ p, v: rateFor(scope, body, mk, p.cc) }));
        const defined = probes.filter(x => x.v !== undefined);
        if (!defined.length) continue;
        if (defined.length === probes.length && new Set(defined.map(x => x.v)).size === 1) {
          cells.push({ mk, min: null, max: null, v: defined[0].v });
        } else {
          for (const d of defined) cells.push({ mk, min: d.p.min, max: d.p.max, v: d.v });
        }
      }
      if (!cells.length) continue;

      // 2) per cc band: collapse the make dimension — if EVERY make on the grid
      //    pays the same here, emit one make-less row; otherwise the grid really
      //    does price by manufacturer group, so emit one row per make.
      const bands = new Map();
      for (const c of cells) {
        const k = `${c.min}|${c.max}`;
        if (!bands.has(k)) bands.set(k, []);
        bands.get(k).push(c);
      }
      for (const group of bands.values()) {
        const b = { ...base, cc_band_min: group[0].min, cc_band_max: group[0].max };
        if (group.length === MAKES.length && new Set(group.map(c => c.v)).size === 1) {
          out.push(row({ ...b, make: null, rate_value: group[0].v }));
        } else {
          for (const c of group) out.push(row({ ...b, make: c.mk.label, rate_value: c.v }));
        }
      }
    }
  }
  return out;
}

module.exports = {
  insurer: INSURER,
  // The resolver replaces this sheet wholesale for every age-0 TW, and the rows
  // are demonstrably mis-ingested (DIS % column + flattened make). Nothing else
  // from Shriram is suppressed.
  suppress: [
    (r) => String(r && r.sheet_name || '').trim().toUpperCase() === 'NEW BUSINESS - 2W',
  ],
  expand,
};
