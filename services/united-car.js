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
function isNew(bt) { return /^NEW/.test(String(bt || '').toUpperCase().trim()); }
// Policy-type bucket: Bundled(1+3)=New comprehensive, Package=Renewal/Rollover comp.
function policyBucket(ip, bt) {
  if (ip === 'SAOD') return 'SAOD';
  if (ip === 'TP') return 'SATP';
  return isNew(bt) ? 'BUNDLED' : 'PACKAGE'; // Comp / Package / 1+1 → by business type
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
  const bt = params.businessType;
  const pol = policyBucket(ip, bt);

  if (isEV) {
    if (pol === 'BUNDLED') return 0.275;
    if (pol === 'PACKAGE') return 0.17;
    // SAOD / SATP electric: Brand-New 22.5%, Renewal/Rollover 17%
    return isNew(bt) ? 0.225 : 0.17;
  }

  const seg = segBucket(fuel, params.cc, params.make);
  // Preferred-RTO 40% override — all segments EXCEPT diesel<=1500.
  if (seg !== 'A' && isPreferredRto(params.rtoCode)) return 0.40;

  if (pol === 'SAOD') return 0.12;
  const low = (seg === 'A' || seg === 'B');
  if (pol === 'BUNDLED') return low ? 0.10 : 0.275;
  if (pol === 'PACKAGE') return low ? 0.05 : 0.20;
  if (pol === 'SATP')    return low ? 0.05 : 0.20;
  return null;
}

module.exports = { resolveUnitedCarRate, isPreferredRto };
