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
  const fuel = String(params.fuelType || '').toUpperCase();
  const isEV = /ELECTRIC|\bEV\b|BATTERY/.test(fuel);
  const ip = String(params.insProduct || '').toUpperCase();
  const age = params.vehicleAge;
  const pol = policyBucket(ip, age);

  if (isEV) {
    if (pol === 'BUNDLED') return 0.275;
    if (pol === 'PACKAGE') return 0.17;
    // SAOD / SATP electric: Brand-New (age 0) 22.5%, Renewal/Rollover 17%
    return isNewVehicle(age) ? 0.225 : 0.17;
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
// commission per GVW band: <=2000kg(UP)->57.5%, 2000-3500kg(UP/HR/TN/RJ)->50%,
// 3500-7500kg(UP/HR/TN/RJ)->27.5%. RTO-based (like the Pvt-Car 40%). Returns the
// band rate when the policy's RTO is listed for its tonnage band, else null
// (leave the engine's existing rule — no regression on un-listed RTOs).
const GCV_PREF = require('../config/united_gcv_pref.json');
const GCV_BANDS = GCV_PREF.bands.map(b => ({ maxTonnes: b.maxTonnes, rate: b.rate, set: new Set(b.rtos.map(norm)) }));
function resolveUnitedGcvRate(params) {
  if (String(params.vehicleType || '').toUpperCase() !== 'GCV') return null;
  const t = Number(params.tonnage);
  if (!Number.isFinite(t) || t <= 0) return null;
  const variants = rtoVariants(params.rtoCode);
  for (const b of GCV_BANDS) {
    if (t <= b.maxTonnes) {
      if (variants.some(v => b.set.has(v))) return b.rate;
      return null; // correct band, RTO not preferred → leave to engine
    }
  }
  return null; // above 7.5T → not covered by Sub Annexure-2
}

// ---- PCV 3-Wheeler override ----
// United's "Three Wheeled (Passenger Carrying)" commission (all bands incl. EV):
// Madhya Pradesh 25%, Other than above States 40%. 3W autos (Atul/Bajaj-RE/TVS-King/
// Piaggio/e-rickshaw) in non-MP states should take 40% but the broad scorer lands on
// the MP 25% row. Scoped to 3W passenger autos; returns null otherwise (no regression).
function resolveUnitedPcvRate(params) {
  if (String(params.vehicleType || '').toUpperCase() !== 'PCV') return null;
  const hay = `${params.vehicleCategory || ''} ${params.model || ''} ${params.make || ''}`.toUpperCase();
  const is3W = /\b3\s*WH|\b3W\b|RIKSHAW|RICKSHAW|E-?RICK|THREE\s*WH/.test(hay) ||
    (Number(params.seatingCapacity) > 0 && Number(params.seatingCapacity) <= 4 &&
      /ATUL|PIAGGIO|\bRE\b|TVS\s*KING|BAJAJ|MAHINDRA\s*ALFA|TREO/.test(hay));
  if (!is3W) return null;
  const st = norm(params.rtoCode).slice(0, 2);
  return st === 'MP' ? 0.25 : 0.40;
}

module.exports = { resolveUnitedCarRate, resolveUnitedGcvRate, resolveUnitedPcvRate, isPreferredRto };
