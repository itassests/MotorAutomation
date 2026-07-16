'use strict';

/**
 * GO DIGIT — Private Car SATP + Two-Wheeler (annual 1+1/SATP and NEW-vehicle
 * long-term bundles) → pseudo rate_rules rows for the Luca export.
 *
 * WHY: routes/bulk.js resolves these three scopes config-driven at CALC time, so
 * the rates the operator actually pays never reach rate_rules:
 *   • Pvt Car SATP  — the June re-ingest DROPPED the "Pvt Car TP Grid" sheet's
 *     cluster/age-split rows entirely (the DB has NO such sheet), and SATP also
 *     needs the sheet's own "4W TP" cluster (PB08→PB_Good), not the Comp cluster
 *     (PB08→PB_CH). services/go-digit-car-tp.js + config/go_digit_car_tp_jun26.json.
 *   • 2W annual    — "the June ingestion stored WRONG rate_rules values"; the
 *     operator is paid the grid's Max CD2 column. services/go-digit-tw.js +
 *     config/go_digit_tw_jun26.json.
 *   • 2W bundles   — a NEW 2W is sold 1+5 / 5+5 and priced from separate
 *     make-specific sheets, not the annual grid. services/go-digit-tw-bundle.js
 *     + config/go_digit_tw_bundle_jun26.json.
 *
 * SUPPRESSION: none needed here. luca-config-expand.js SUPPRESS already drops
 * go_digit /PVT CAR/ (the mis-read "Pvt Car Comp+SAOD Grid") and /^2W GRID/
 * (the wrong-valued "2W Grid 5+5"). The DB holds no "Pvt Car TP Grid" and no
 * "2W Grid 1+1 & SATP" sheet at all, so there is nothing further to drop.
 * 'CV Grid (excl. HCV)' + 'HCV GRID' DB rows are clean and deliberately KEPT.
 *
 * FIDELITY: rather than re-reading the configs by hand, this module DRIVES the
 * real resolvers over every reachable scope and records the winner. That keeps
 * the export bit-identical to what routes/bulk.js pays, including the resolvers'
 * specificity / fallback ordering (cc-band pick, make→'Others' fallback).
 * Collapsing then removes any scope whose rate equals its catch-all.
 *
 * NOT expanded (deliberately — see report):
 *   • Pvt Car Comp/SAOD → already done by goDigitCar() in luca-config-expand.js.
 *   • 2W SAOD → resolveGoDigitTwRate returns null for SAOD (leaves it to the
 *     engine), so no config rate is authoritative. CFG.saod is unused by bulk.js.
 */

const TP_CFG  = require('../../config/go_digit_car_tp_jun26.json');
const TW_CFG  = require('../../config/go_digit_tw_jun26.json');
const TWB_CFG = require('../../config/go_digit_tw_bundle_jun26.json');
const { resolveGoDigitCarTpRate }   = require('../go-digit-car-tp');
const { resolveGoDigitTwRate }      = require('../go-digit-tw');
const { resolveGoDigitTwBundleRate } = require('../go-digit-tw-bundle');

const TP_SHEET  = 'Pvt Car TP Grid Jun26';
const TW_SHEET  = '2W Grid 1+1 & SATP Jun26';
const TWB_SHEET = '2W Grid Bundle Jun26';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const rnd = (v) => +Number(v).toFixed(4);

/** Shape a pseudo rate_rules row (mirrors luca-config-expand.js row()). */
function row(o) {
  return {
    insurer: 'go_digit',
    product: o.product || null,
    sheet_name: o.sheet_name || null,
    region: o.region || null,
    segment: o.segment || null,
    make: o.make || null,
    model: o.model || null,
    sub_type: o.sub_type || null,
    fuel_type: o.fuel_type || null,
    cc_band_min: num(o.cc_band_min),
    cc_band_max: num(o.cc_band_max),
    age_band_min: num(o.age_band_min),
    age_band_max: num(o.age_band_max),
    weight_band_min: null,
    weight_band_max: null,
    rate_type: o.rate_type || null,
    rate_value: o.rate_value,
    remarks: o.remarks || null,
    state: o.state || null,
    effective_from: o.effective_from || null,
  };
}

// ---------------------------------------------------------------------------
// 1) PRIVATE CAR SATP — config/go_digit_car_tp_jun26.json
// ---------------------------------------------------------------------------
// The grid's only cc boundaries are 1000 and 1500, and its band forms are
// "<b" / ">b" / "a-b" (inclusive). That makes these 5 intervals the complete
// set of cc equivalence classes — one probe per class is exhaustive.
const TP_CC_CLASSES = [
  { min: 0,    max: 999,  probe: 900 },
  { min: 1000, max: 1000, probe: 1000 },
  { min: 1001, max: 1499, probe: 1200 },
  { min: 1500, max: 1500, probe: 1500 },
  { min: 1501, max: null, probe: 2000 },
];
// resolver age split is `age < 10 ? '<10' : '>10'`, so ">10" really owns age>=10.
const TP_AGE_CLASSES = [
  { min: 0,  max: 9,    probe: 5 },
  { min: 10, max: null, probe: 12 },
];
const TP_FUELS = [
  { luca: 'PETROL',   probe: 'Petrol' },
  { luca: 'DIESEL',   probe: 'Diesel' },
  { luca: 'CNG',      probe: 'CNG' },
];

/** cluster (as spelled in CFG.grid) → one RTO that resolves to it. */
function tpClusterRtos() {
  const key = (s) => String(s).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const byKey = new Map();                       // clKey → grid's spelling
  for (const c of Object.keys(TP_CFG.grid || {})) if (!byKey.has(key(c))) byKey.set(key(c), c);
  const out = new Map();                         // grid spelling → representative RTO
  for (const [rto, cl] of Object.entries(TP_CFG.rtoCluster || {})) {
    const g = byKey.get(key(cl));
    if (g && !out.has(g)) out.set(g, rto);
  }
  return out;
}

function tpProbe(rto, fuel, cc, age) {
  try {
    const r = resolveGoDigitCarTpRate({
      vehicleType: 'CAR', odPremium: 0, tpPremium: 1,
      rtoCode: rto, fuelType: fuel, cubicCapacity: cc, vehicleAge: age,
    });
    return r && r.rate != null && Number.isFinite(Number(r.rate))
      ? { rate: rnd(r.rate), seg: String(r.segment) } : null;
  } catch (_) { return null; }
}

function goDigitCarSatp(eff) {
  const out = [];
  for (const [cluster, rto] of tpClusterRtos()) {
    for (const f of TP_FUELS) {
      // cells[ccIdx] = [ resultForAge<10, resultForAge>=10 ]
      const cells = TP_CC_CLASSES.map((c) => TP_AGE_CLASSES.map((a) => tpProbe(rto, f.probe, c.probe, a.probe)));
      const sig = (i) => JSON.stringify(cells[i]);
      // merge contiguous cc classes that behave identically
      let i = 0;
      while (i < TP_CC_CLASSES.length) {
        if (cells[i].every((x) => x == null)) { i++; continue; }   // no grid cell for this cc class
        let j = i;
        while (j + 1 < TP_CC_CLASSES.length && sig(j + 1) === sig(i)) j++;
        const ccMin = TP_CC_CLASSES[i].min === 0 ? null : TP_CC_CLASSES[i].min;
        const ccMax = TP_CC_CLASSES[j].max;
        const base = {
          product: 'CAR', sheet_name: TP_SHEET, region: cluster,
          segment: 'Private Car SATP', fuel_type: f.luca,
          cc_band_min: ccMin, cc_band_max: ccMax,
          rate_type: 'SATP', effective_from: eff,
        };
        const [y, o] = cells[i];
        // collapse the age split when both bands land on the same grid cell
        if (y && o && y.rate === o.rate && y.seg === o.seg) {
          out.push(row({ ...base, sub_type: y.seg, rate_value: y.rate }));
        } else {
          cells[i].forEach((c, k) => {
            if (!c) return;
            out.push(row({
              ...base, sub_type: c.seg, rate_value: c.rate,
              age_band_min: TP_AGE_CLASSES[k].min === 0 ? null : TP_AGE_CLASSES[k].min,
              age_band_max: TP_AGE_CLASSES[k].max,
            }));
          });
        }
        i = j + 1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2) TWO-WHEELER annual — config/go_digit_tw_jun26.json ("2W Grid 1+1 & SATP")
// ---------------------------------------------------------------------------
// Only these 7 segment keys can ever come out of go-digit-tw.js segmentOf();
// any other key in the config (e.g. "MC_180-350_OTHER THAN RE") is unreachable
// and must NOT be exported — the engine can never pay it.
// `probe` = params that make segmentOf() return exactly this key.
// `rows`  = how to describe that segment to an agent (one row per named make).
const TW_SEGMENTS = [
  { key: 'SC/EV',
    probe: { make: 'Honda', model: 'Activa', cc: 110, fuelType: 'Petrol' },
    rows: [{ segment: 'Two Wheeler Scooter or Electric', sub_type: 'Scooter / EV (any make, any cc)' }] },
  { key: 'MC <= 180 HERO/HONDA',
    probe: { make: 'Hero', model: 'Splendor', cc: 110, fuelType: 'Petrol' },
    rows: [{ segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle upto 180cc', make: 'HERO', cc_band_max: 180 },
           { segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle upto 180cc', make: 'HONDA', cc_band_max: 180 }] },
  { key: 'MC <= 180 OTHERS',
    probe: { make: 'Bajaj', model: 'Platina', cc: 110, fuelType: 'Petrol' },
    rows: [{ segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle upto 180cc, makes other than Hero/Honda', cc_band_max: 180 }] },
  { key: 'MC_180-350_RE',
    probe: { make: 'Royal Enfield', model: 'Bullet', cc: 350, fuelType: 'Petrol' },
    rows: [{ segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle 181-350cc Royal Enfield', make: 'ROYAL ENFIELD', cc_band_min: 181, cc_band_max: 350 }] },
  { key: 'MC_180-350_HONDA/JAWA/AVENGER',
    probe: { make: 'Honda', model: 'CB300', cc: 300, fuelType: 'Petrol' },
    rows: [{ segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle 181-350cc Honda/Jawa/Avenger', make: 'HONDA', cc_band_min: 181, cc_band_max: 350 },
           { segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle 181-350cc Honda/Jawa/Avenger', make: 'JAWA', cc_band_min: 181, cc_band_max: 350 },
           { segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle 181-350cc Honda/Jawa/Avenger', model: 'AVENGER', cc_band_min: 181, cc_band_max: 350 }] },
  { key: 'MC_180-350_OTHERS',
    probe: { make: 'Bajaj', model: 'Pulsar', cc: 220, fuelType: 'Petrol' },
    rows: [{ segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle 181-350cc, other than RE/Honda/Jawa/Avenger', cc_band_min: 181, cc_band_max: 350 }] },
  { key: 'MC>350',
    probe: { make: 'Bajaj', model: 'Dominar', cc: 400, fuelType: 'Petrol' },
    rows: [{ segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle above 350cc', cc_band_min: 351 }] },
];

function twProbe(region, seg, cover) {
  const p = { vehicleType: 'TW', ...seg.probe };
  if (cover === 'SATP') { p.odPremium = 0; p.tpPremium = 1; }
  else                  { p.odPremium = 1; p.tpPremium = 1; }
  try {
    const r = resolveGoDigitTwRate(p, region);
    return r != null && Number.isFinite(Number(r)) ? rnd(r) : null;
  } catch (_) { return null; }
}

function goDigitTwAnnual(eff) {
  const out = [];
  for (const region of Object.keys(TW_CFG.grid || {})) {
    for (const seg of TW_SEGMENTS) {
      // Only emit what the config actually carries for this cluster.
      if (!((TW_CFG.grid[region] || {})[seg.key])) continue;
      for (const cover of ['COMP', 'SATP']) {
        const rate = twProbe(region, seg, cover);
        if (rate == null) continue;
        for (const r of seg.rows) {
          out.push(row({
            product: 'TW', sheet_name: TW_SHEET, region,
            segment: r.segment, sub_type: r.sub_type, make: r.make, model: r.model,
            cc_band_min: r.cc_band_min, cc_band_max: r.cc_band_max,
            rate_type: cover, rate_value: rate, effective_from: eff,
          }));
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3) TWO-WHEELER long-term bundles — config/go_digit_tw_bundle_jun26.json
// ---------------------------------------------------------------------------
// go-digit-tw-bundle.js keys by tenure × cluster × makeFamily × segCandidates,
// falling back to the 'Others' make block. So: resolve the 'Others' result per
// (tenure, cluster, scope) as the catch-all row, and only add a make-specific
// row where its resolved rate actually DIFFERS.
const TWB_MAKES = [
  { fam: 'HERO MOTOCORP', probe: 'Hero',          luca: 'HERO' },
  { fam: 'BAJAJ',         probe: 'Bajaj',         luca: 'BAJAJ' },
  { fam: 'HONDA',         probe: 'Honda',         luca: 'HONDA' },
  { fam: 'SUZUKI',        probe: 'Suzuki',        luca: 'SUZUKI' },
  { fam: 'TVS',           probe: 'TVS',           luca: 'TVS' },
  { fam: 'YAMAHA',        probe: 'Yamaha',        luca: 'YAMAHA' },
  { fam: 'ROYAL ENFIELD', probe: 'Royal Enfield', luca: 'ROYAL ENFIELD' },
];
// Every distinct segCandidates() outcome. `reMakes` restricts the Royal-Enfield
// scopes to the make families that can realistically reach them (an RE-badged
// model under an unlisted make falls to the 'Others' block).
const TWB_SCOPES = [
  { id: 'EV',       probe: { model: 'Scooter', fuelType: 'Electric', cc: 0 },
    segment: 'Two Wheeler Electric', sub_type: 'Electric two wheeler', fuel_type: 'ELECTRIC' },
  { id: 'SCOOTER',  probe: { model: 'Activa', fuelType: 'Petrol', cc: 110 },
    segment: 'Two Wheeler Scooter', sub_type: 'Scooter (non-electric)' },
  { id: 'MC<=155',  probe: { model: 'Splendor', fuelType: 'Petrol', cc: 110 },
    segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle upto 155cc', cc_band_max: 155 },
  { id: 'MC>155',   probe: { model: 'Pulsar', fuelType: 'Petrol', cc: 220 },
    segment: 'Two Wheeler Motorcycle', sub_type: 'Motorcycle above 155cc', cc_band_min: 156 },
  { id: 'RE<=350',  probe: { model: 'Bullet', fuelType: 'Petrol', cc: 350 }, reOnly: true,
    segment: 'Two Wheeler Motorcycle', sub_type: 'Royal Enfield type upto 350cc', cc_band_max: 350 },
  { id: 'RE>350',   probe: { model: 'Bullet', fuelType: 'Petrol', cc: 500 }, reOnly: true,
    segment: 'Two Wheeler Motorcycle', sub_type: 'Royal Enfield type above 350cc', cc_band_min: 351 },
];

function twbProbe(tenure, cluster, make, scope) {
  try {
    const r = resolveGoDigitTwBundleRate(
      { vehicleType: 'TW', policyTenure: tenure, make, ...scope.probe }, cluster);
    return r && r.rate != null && Number.isFinite(Number(r.rate))
      ? { rate: rnd(r.rate), seg: String(r.segment), mk: String(r.make) } : null;
  } catch (_) { return null; }
}

function goDigitTwBundle(eff) {
  const out = [];
  for (const tenure of Object.keys(TWB_CFG.grid || {})) {
    for (const cluster of Object.keys(TWB_CFG.grid[tenure] || {})) {
      for (const scope of TWB_SCOPES) {
        // catch-all: an unlisted make resolves through the 'Others' block
        const other = twbProbe(tenure, cluster, 'Zzz Unlisted Make', scope);
        const base = {
          product: 'TW', sheet_name: TWB_SHEET, region: cluster,
          segment: scope.segment, fuel_type: scope.fuel_type,
          cc_band_min: scope.cc_band_min, cc_band_max: scope.cc_band_max,
          // The bundle is an OD+TP package (1yr/5yr OD + 5yr TP) → COMP.
          rate_type: 'COMP', effective_from: eff,
        };
        const tag = ` [${tenure} bundle]`;
        if (other) {
          out.push(row({ ...base, sub_type: scope.sub_type + tag, rate_value: other.rate }));
        }
        for (const m of TWB_MAKES) {
          if (scope.reOnly && m.fam !== 'ROYAL ENFIELD') continue;
          // Converse guard (adversarial review): segCandidates() in
          // services/go-digit-tw-bundle.js routes ANY isRE() make to the RE bands
          // ('<=350'/'>350') and can NEVER return an MC/SCOOTER/EV band. Probing a
          // non-RE scope with Royal Enfield therefore silently resolved to the RE
          // cell and emitted 89 rows the engine contradicts (3 hard: export 0.275
          // where the config pays 0). RE only belongs under its own scopes.
          if (!scope.reOnly && m.fam === 'ROYAL ENFIELD') continue;
          const hit = twbProbe(tenure, cluster, m.probe, scope);
          if (!hit) continue;
          // collapse: identical to the catch-all → the catch-all row already says it
          if (other && hit.rate === other.rate) continue;
          out.push(row({ ...base, make: m.luca, sub_type: scope.sub_type + tag, rate_value: hit.rate }));
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corrupt-cell guard. A commission is a fraction in [0,1]. A handful of source
// cells are outside it — 13 "2W Grid 5+5" cd2 cells hold 5 / 7.5 / 10 (the raw
// percent leaked through un-normalized: GJ_Good/SUZUKI/MC<=155 = 10 → 1000%),
// and 2W 1+1 NE_REF/MC_180-350_RE oneMax is -0.015. Whether "10" means 0.10 or
// is a stray cannot be established from the config, so these are DROPPED, not
// guessed: the engine's own (wrong) value stays internal, but an agent must
// never be handed it. Fix the cell in the config to bring the row back.
function plausible(rows) {
  return rows.filter((r) => {
    const v = Number(r.rate_value);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return true;
    console.warn('[luca-expand] go_digit: dropped implausible rate ' + r.rate_value +
      ' (' + r.sheet_name + ' / ' + r.region + ' / ' + (r.make || 'any make') + ' / ' + r.sub_type + ')');
    return false;
  });
}

module.exports = {
  insurer: 'go_digit',
  // Empty on purpose — luca-config-expand.js SUPPRESS already drops go_digit
  // /PVT CAR/ + /^2W GRID/, and the two sheets expanded here were never
  // ingested at all. 'CV Grid (excl. HCV)' / 'HCV GRID' stay.
  suppress: [],
  expand: (effFrom) => plausible([
    ...goDigitCarSatp(effFrom),
    ...goDigitTwAnnual(effFrom),
    ...goDigitTwBundle(effFrom),
  ]),
  // exported for the verification script
  _internal: { goDigitCarSatp, goDigitTwAnnual, goDigitTwBundle },
};
