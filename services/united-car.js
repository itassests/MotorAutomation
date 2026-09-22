/**
 * United India — PRIVATE CAR commission resolver.
 *
 * United's Pvt-Car commission (from the commission-structure PDF, NOT region-based)
 * is a function of POLICY TYPE × SEGMENT (CC / fuel / make) × FUEL(EV) — plus a
 * PREFERRED-CITY-RTO override to 40% (Sub Annexure-3). Our ingestion mis-parsed it
 * (region=RTO code, no make), so CAR mis-rated. This resolver computes the rate %
 * directly from policy params; bulk.js applies it for United + CAR.
 *
 * Grid (Maximum proposed Commission, w.e.f. 01/04/2026):
 *   Non-Electric:
 *     Segment buckets: A=Diesel<=1500cc, B=>2500cc EXCEPT {Tata,Maruti,Mahindra,
 *                      Toyota,Hyundai,Honda,Kia}, C=Other than A/B.
 *     Bundled(1+3) [New]:        A 10%  B 10%  C 27.5%
 *     Package [Renewal/Rollover]: A 5%   B 5%   C 20%
 *     SAOD [all]:                 all 12%
 *     SATP [all]:                 A 5%   B 5%   C 20%
 *   Electric:
 *     Bundled(1+3) [New] 27.5% ; Brand-New SAOD/SATP [New] 22.5% ;
 *     Package/SAOD/SATP [Renewal/Rollover] 17%
 *   PREFERRED-RTO override (Sub Annexure-3, Chennai/Delhi/Bangalore/Mumbai/Ahmedabad/
 *     Hyderabad/Pune/Vizag/Jaipur/Vadodara&Surat + Kerala-all-except-KL15):
 *     40% for ALL segments EXCEPT Diesel<=1500cc.
 *   (Commission is on NET premium = OD+TP.)
 */
const PREF = require('../config/united_pref_rtos.json');
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PREF_SET = new Set(PREF.rtos.map(norm));
const KL_EXCEPT = new Set((PREF.keralaAllExcept || []).map(norm));
const LOW_MAKES = ['TATA', 'MARUTI', 'MAHINDRA', 'TOYOTA', 'HYUNDAI', 'HONDA', 'KIA'];

// ---- REVISED grid effective 01-08-2026 (commission-structure circular) ----
// Full re-map: Pvt-Car is now CC-band x state (fuel-agnostic except EV & the
// preferred-RTO diesel<=1500 carve-out), GCV is a full GVW(kg) x state grid, EV
// cars are a flat 35%, and everything is on NET premium. Date-gated so pre-Aug
// policies keep the old segment logic. (USER 2026-09, PDF-confirmed.)
const CAR_AUG = require('../config/united_car_aug26.json');
const GCV_AUG = require('../config/united_gcv_aug26.json');
const PCV_AUG = require('../config/united_pcv_aug26.json');
const _SUBANN2_RJ = new Set((GCV_AUG.subAnn2Rj || []).map(norm));
const AUG_FROM = '2026-08-01';
const effAug = (params) => {
  const d = String(params.effective_date || params.effectiveDate || params.riskStartDate || '').slice(0, 10);
  return d && d >= AUG_FROM;
};
// RTO state prefix (MH12 -> MH; PY01 -> PY).
const stateOf = (rtoCode) => norm(rtoCode).replace(/[0-9].*$/, '').slice(0, 2);
const pickBand = (bands, val, key) => { for (const b of bands) { if (b[key] == null || val <= b[key]) return b; } return bands[bands.length - 1]; };

// Pvt-Car (eff Aug'26): EV 35% > preferred-RTO 40% (except diesel<=1500) > CC-band x state.
function unitedCarAug(params) {
  const fuel = String(params.fuelType || '').toUpperCase();
  if (/ELECTRIC|\bEV\b|BATTERY/.test(fuel)) return CAR_AUG.ev;              // flat 35% all covers
  const cc = Number(params.cc) || 0;
  const dieselLe1500 = /DIESEL/.test(fuel) && cc > 0 && cc <= 1500;
  if (!dieselLe1500 && isPreferredRto(params.rtoCode)) return CAR_AUG.preferred;  // 40%
  const ip = String(params.insProduct || '').toUpperCase();
  if (ip === 'SAOD') return CAR_AUG.saod;                                   // 15%
  const fam = (ip === 'TP') ? CAR_AUG.package                               // SATP grouped with Package
            : (isNewVehicle(params.vehicleAge) ? CAR_AUG.bundled : CAR_AUG.package);
  const b = pickBand(fam, cc, 'maxCc');
  if (b.all != null) return b.all;
  const inSet = (CAR_AUG.stateSets[b.set] || []).includes(stateOf(params.rtoCode));
  return inSet ? b.inR : b.outR;
}
// GCV (eff Aug'26): full GVW(kg) x state grid + E-Cart 50%.
function unitedGcvAug(params) {
  const hay = `${params.vehicleCategory || ''} ${params.model || ''} ${params.make || ''}`.toUpperCase();
  if (/E-?\s*CART/.test(hay)) return GCV_AUG.eCart;                         // E-Cart 50%
  const t = Number(params.tonnage);
  if (!Number.isFinite(t) || t <= 0) return null;
  const kg = t * 1000;
  const st = stateOf(params.rtoCode);
  const b = pickBand(GCV_AUG.bands, kg, 'maxKg');
  if (b.all != null) return b.all;
  for (const rule of (b.rules || [])) {
    if (rule.st.includes(st)) {
      if (rule.subAnn2 && st === 'RJ') {   // RJ: only the Sub-Annexure-2 RTOs get the higher rate
        return rtoVariants(params.rtoCode).some(v => _SUBANN2_RJ.has(v)) ? rule.subAnn2 : rule.r;
      }
      return rule.r;
    }
  }
  return b.other;
}

function rtoVariants(code) {
  const c = norm(code);
  const m = c.match(/^([A-Z]+)(\d+)$/);
  if (!m) return [c];
  const n = parseInt(m[2], 10);
  return [...new Set([c, m[1] + n, m[1] + String(n).padStart(2, '0')])];
}
function isPreferredRto(rtoCode) {
  for (const v of rtoVariants(rtoCode)) if (PREF_SET.has(v)) return true;
  const n = norm(rtoCode);
  if (/^KL\d+$/.test(n) && !KL_EXCEPT.has(n)) return true; // Kerala: all except KL15
  return false;
}
// "New" = a NEW VEHICLE (age 0), NOT "New Business". The source BUSINESS_TYPE_ID
// says "New Business" even for a 10-yr-old used car (it means new policy/customer);
// SUB_BUSINESS_TYPE_ID="Used Rollover" + AGE=10 is the truth. Bundled(1+3) is for a
// brand-new vehicle (age 0); any aged vehicle is a Rollover → Package.
function isNewVehicle(age) { return Number(age) === 0; }
// Policy-type bucket: Bundled(1+3)=brand-new vehicle, Package=Renewal/Rollover.
function policyBucket(ip, age) {
  if (ip === 'SAOD') return 'SAOD';
  if (ip === 'TP') return 'SATP';
  return isNewVehicle(age) ? 'BUNDLED' : 'PACKAGE';
}
// Segment bucket (Non-Electric).
function segBucket(fuel, cc, make) {
  const f = String(fuel || '').toUpperCase();
  const c = Number(cc);
  const mk = norm(make);
  if (/DIESEL/.test(f) && c > 0 && c <= 1500) return 'A';          // diesel <=1500
  if (c > 2500 && !LOW_MAKES.some(m => mk.includes(m))) return 'B'; // >2500 except 7 makes
  return 'C';
}

function resolveUnitedCarRate(params) {
  if (String(params.vehicleType || '').toUpperCase() !== 'CAR') return null;
  if (effAug(params)) return unitedCarAug(params);          // revised grid from 01-08-2026
  const fuel = String(params.fuelType || '').toUpperCase();
  const isEV = /ELECTRIC|\bEV\b|BATTERY/.test(fuel);
  const ip = String(params.insProduct || '').toUpperCase();
  const age = params.vehicleAge;
  const pol = policyBucket(ip, age);

  if (isEV) {
    // USER 2026-09: from 1-Sept-2026 United pays a FLAT 35% on EVERY electric car —
    // all covers (Bundled 1+3 / Package / Long-term 3+3 / SATP / Long-term Liability /
    // SAOD) and all makes — overriding the big-make Segment-C carve-out AND the
    // preferred-RTO 40%. ("Electric Cars … All Vehicles … 35%" grid line.)
    const _eff = String(params.effective_date || '').slice(0, 10);
    if (_eff && _eff >= '2026-09-01') return 0.35;
    // USER 2026-07-14: EVs of the BIG makes (Tata/Maruti/Mahindra/Toyota/Hyundai/Honda/
    // Kia) follow the normal fuel/make SEGMENT (non-diesel → Segment C = 20% Package/SATP,
    // 27.5% Bundled, + the preferred-RTO override), NOT United's flat Electric line.
    // (UP1/16396 Mahindra XUV400 renewal 17 → 20.) Other EV makes keep the Electric line.
    const evBigMake = LOW_MAKES.some(m => norm(params.make).includes(m));
    if (!evBigMake) {
      if (pol === 'BUNDLED') return 0.275;
      if (pol === 'PACKAGE') return 0.17;
      // SAOD / SATP electric: Brand-New (age 0) 22.5%, Renewal/Rollover 17%
      return isNewVehicle(age) ? 0.225 : 0.17;
    }
    // big-make EV → fall through to segBucket (yields Segment C for a non-diesel car)
  }

  const seg = segBucket(fuel, params.cc, params.make);
  // Preferred-RTO 40% override — all segments EXCEPT diesel<=1500, and EXCEPT
  // standalone-TP policies. USER RULING (DL7/14152 Wagon R DL1 SATP "not 40 its
  // 20", grid screenshot): the 40% is a net (OD+TP) city incentive; a SATP
  // policy takes its own SATP grid rate (Diesel<=1500cc 5%, >2500cc except big
  // makes 5%, Other 20%). Grid-strict over operator-match: cycle 12 had the
  // operator pay ~40 to 8 of 10 TP-only preferred-RTO cars and 20 to 2 — the
  // 40-paid ones are operator overpays (As-per-Grid class), per user.
  if (seg !== 'A' && pol !== 'SATP' && isPreferredRto(params.rtoCode)) return 0.40;

  if (pol === 'SAOD') return 0.12;
  const low = (seg === 'A' || seg === 'B');
  if (pol === 'BUNDLED') return low ? 0.10 : 0.275;
  if (pol === 'PACKAGE') return low ? 0.05 : 0.20;
  if (pol === 'SATP')    return low ? 0.05 : 0.20;
  return null;
}

// ---- GCV preferred-RTO override (Sub Annexure-2) ----
// GCV from "excluded states" registered in specific preferred RTOs gets a higher
// commission per GVW band: <=2000kg(UP)->57.5%, 2000-3500kg(UP/HR/TN/RJ)->56.5%,
// 3500-7500kg(UP/HR/TN/RJ)->27.5%. RTO-based (like the Pvt-Car 40%). Returns the
// band rate when the policy's RTO is listed for its tonnage band, else null
// (leave the engine's existing rule — no regression on un-listed RTOs).
//
// NOTE (June-1 reconciliation): the full GVW×state grid (PDF Annexure A2) was NOT
// implemented as a base rate because the operator is INCONSISTENT on the 2000-3500
// band — it pays BOTH 50 (PDF "other states") and 56.5 (revised GGCV) for identical
// MH/WB/JK trucks, and 56.5 is the majority. The mis-ingested flat ~56.5 base already
// matches that majority, so a full grid net-regressed (fixed 21 / broke 23). Left as
// preferred-RTO-only; the ~22 GCV paying 50/15/0 are operator-timing noise.
// Sub-Annexure preferred-RTO override, effective-date aware: on/after 1-Jul-2026
// the July'26 Sub Annexure 3 lists (config/united_gcv_pref_jul26.json) apply — the
// GVW<=2000 band dropped (now flat 57.5% base), RTO lists refreshed; before, the
// April Sub Annexure 2 (config/united_gcv_pref.json). Bands: minTonnes<weight<=maxTonnes.
const _mkBands = (cfg) => cfg.bands.map(b => ({ minTonnes: b.minTonnes == null ? 0 : b.minTonnes, maxTonnes: b.maxTonnes, rate: b.rate, set: new Set(b.rtos.map(norm)) }));
const GCV_BANDS_JUN = _mkBands(require('../config/united_gcv_pref.json'));
const GCV_BANDS_JUL = _mkBands(require('../config/united_gcv_pref_jul26.json'));
function effOnOrAfterJul(params) {
  const d = String(params.effective_date || params.effectiveDate || params.riskStartDate || params.policyStartDate || '').slice(0, 10);
  return !d || d >= '2026-07-01';
}
function resolveUnitedGcvRate(params) {
  if (String(params.vehicleType || '').toUpperCase() !== 'GCV') return null;
  if (effAug(params)) return unitedGcvAug(params);          // full revised GVW grid from 01-08-2026
  const t = Number(params.tonnage);
  if (!Number.isFinite(t) || t <= 0) return null;
  const bands = effOnOrAfterJul(params) ? GCV_BANDS_JUL : GCV_BANDS_JUN;
  const variants = rtoVariants(params.rtoCode);
  for (const b of bands) {
    if (t > b.minTonnes && t <= b.maxTonnes) {
      return variants.some(v => b.set.has(v)) ? b.rate : null; // RTO not preferred → leave to engine base
    }
  }
  return null; // weight outside any preferred band → leave to engine base
}

// ---- PCV 3-Wheeler override ----
// United's "Three Wheeled (Passenger Carrying)" commission (all bands incl. EV).
// Pre-July: Madhya Pradesh 25%, other 40%. July'26 adds a 60% tier for WB/MH/GJ/DL/
// Uttarakhand/PB/Goa/J&K. 3W autos (Atul/Bajaj-RE/TVS-King/Piaggio/e-rickshaw) in
// non-MP states should take the state rate but the broad scorer lands on the MP 25%
// row. Scoped to 3W passenger autos; returns null otherwise (no regression).
// State by RTO prefix: Goa registers as GA, Uttarakhand UK, J&K JK.
const PCV3W_60_STATES = new Set(['WB', 'MH', 'GJ', 'DL', 'UK', 'PB', 'GA', 'JK']);
const _is3WPcv = (hay, seat) =>
  /\b3\s*WH|\b3W\b|RIKSHAW|RICKSHAW|E-?RICK|THREE\s*WH/.test(hay) ||
  (seat > 0 && seat <= 4 && /ATUL|PIAGGIO|\bRE\b|TVS\s*KING|BAJAJ|MAHINDRA\s*ALFA|TREO/.test(hay));

// PCV (eff Aug'26): full revised grid — buses 62.5%, 3W tiered, 2W-PCV 10%, and
// 4W split on seating: >6 pax = "4W PCV >6 passengers" PCC(=seats)×state bands,
// <=6 pax = Taxi (Package vs SATP). All on NET premium.
function unitedPcvAug(params) {
  const hay = `${params.vehicleCategory || ''} ${params.model || ''} ${params.make || ''}`.toUpperCase();
  const seat = Number(params.seatingCapacity) || 0;
  const fuel = String(params.fuelType || '').toUpperCase();
  const isEV = /ELECTRIC|\bEV\b|BATTERY/.test(fuel);
  const st = stateOf(params.rtoCode);
  const inSet = (key) => (PCV_AUG.stateSets[key] || []).includes(st);
  // Educational / Staff / School buses (NOT ordinary route buses) → 62.5%.
  if (/SCHOOL|STAFF|EDUCATION/.test(hay)) return PCV_AUG.buses;
  // Three-wheeled passenger carriers → tiered state grid (unchanged from pre-Aug).
  if (_is3WPcv(hay, seat)) {
    if (st === 'MP') return 0.25;
    if (PCV3W_60_STATES.has(st)) return 0.60;
    return 0.40;
  }
  // Two-wheeled PCV → flat 10%.
  if (/\b2\s*WH|TWO\s*WH/.test(hay)) return PCV_AUG.twoWheeled;
  if (seat <= 0) return null;                       // 4W but no seating → leave to engine base
  if (seat <= 6) {                                  // Taxi
    const t = (String(params.insProduct || '').toUpperCase() === 'TP') ? PCV_AUG.taxi.satp : PCV_AUG.taxi.package;
    return inSet(PCV_AUG.taxi.set) ? t.inR : t.outR;
  }
  // 4W PCV > 6 passengers — PCC(=seat) × state bands.
  if (isEV && seat > 20) return PCV_AUG.pcv4w.evPcc20;   // electric >20 pax → 10%
  const b = pickBand(PCV_AUG.pcv4w.bands, seat, 'maxPcc');
  if (b.all != null) return b.all;
  return inSet(b.set) ? b.inR : b.outR;
}

function resolveUnitedPcvRate(params) {
  if (String(params.vehicleType || '').toUpperCase() !== 'PCV') return null;
  if (effAug(params)) return unitedPcvAug(params);         // revised full PCV grid from 01-08-2026
  const hay = `${params.vehicleCategory || ''} ${params.model || ''} ${params.make || ''}`.toUpperCase();
  const is3W = _is3WPcv(hay, Number(params.seatingCapacity) || 0);
  if (!is3W) return null;
  const st = norm(params.rtoCode).slice(0, 2);
  if (st === 'MP') return 0.25;
  if (effOnOrAfterJul(params) && PCV3W_60_STATES.has(st)) return 0.60;  // July'26 60% tier
  return 0.40;
}

module.exports = { resolveUnitedCarRate, resolveUnitedGcvRate, resolveUnitedPcvRate, isPreferredRto };
