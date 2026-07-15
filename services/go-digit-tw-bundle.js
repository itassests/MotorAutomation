'use strict';

/**
 * GO DIGIT Two-Wheeler LONG-TERM BUNDLES — June'26 "2W Grid 1+5" / "2W Grid 5+5".
 * A NEW two-wheeler is sold as a bundle: 1yr OD + 5yr TP (1+5) or 5yr+5yr (5+5).
 * These are priced from SEPARATE, MAKE-SPECIFIC sheets — NOT the annual
 * "2W Grid 1+1 & SATP" (which services/go-digit-tw.js reads). The engine wasn't
 * tenure-aware for Go Digit TW, so every bundle took the annual Comp rate
 * (e.g. JK1/1203 NTorq 1+5: annual J&K_Srinagar SC/EV 51.5 vs correct 1+5
 * J&K_Srinagar/TVS/SCOOTER Max CD2 = 35).
 *
 * Keyed by tenure(1+5/5+5) × cluster × MAKE × segment; operator pays Max CD2.
 * Cluster = the region the engine already resolved (same cluster names as 1+1).
 * Tenure = params.policyTenure / bundledTag (bucketFromYears → '1+5'/'5+5').
 * config/go_digit_tw_bundle_jun26.json (regen tools/_gen_godigit_tw_bundle.js).
 * Returns {rate,tenure,cluster,make,segment} or null (leave engine untouched).
 */
const CFG = require('../config/go_digit_tw_bundle_jun26.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const clKey = (s) => norm(s).replace(/[^A-Z0-9]/g, '');

// case/separator-insensitive cluster index per tenure
const IDX = {};
for (const t of Object.keys(CFG.grid)) { IDX[t] = {}; for (const c of Object.keys(CFG.grid[t])) IDX[t][clKey(c)] = CFG.grid[t][c]; }

function makeFamily(make) {
  const m = norm(make);
  if (/HERO/.test(m)) return 'HERO MOTOCORP';
  if (/BAJAJ/.test(m)) return 'BAJAJ';
  if (/HONDA/.test(m)) return 'HONDA';
  if (/SUZUKI/.test(m)) return 'SUZUKI';
  if (/\bTVS\b/.test(m)) return 'TVS';
  if (/YAMAHA/.test(m)) return 'YAMAHA';
  if (/ROYAL\s*ENFIELD|ENFIELD/.test(m)) return 'ROYAL ENFIELD';
  return 'Others';
}
const isScooter = (make, model, fuel) => {
  const hay = `${norm(make)} ${norm(model)}`;
  return /ELECTRIC|\bEV\b|BATTERY/.test(norm(fuel)) ||
    /ACTIVA|JUPITER|FASCINO|ACCESS|\bDIO\b|NTORQ|MAESTRO|PLEASURE|VESPA|SCOOT|DESTINI|XOOM|\bRAY\b|BURGMAN|AVIATOR|CHETAK|IQUBE|\bZEST\b|GRAZIA|RITMO|WEGO|GUSTO|\bDURO\b|RODEO|\bDUET\b|SWISH|AEROX|\bVIDA\b|ATHER|AMPERE|\bOLA\b|\bLETS\b|ALPHA|CYGNUS/.test(hay);
};
const isRE = (make, model) => /ROYAL\s*ENFIELD|ENFIELD|BULLET|CLASSIC|METEOR|HIMALAYAN|THUNDERBIRD|INTERCEPTOR|HUNTER|CONTINENTAL/.test(`${norm(make)} ${norm(model)}`);
const isElectric = (fuel) => /ELECTRIC|\bEV\b|BATTERY/.test(norm(fuel));

// ordered segment-key candidates for this vehicle (normalized: no spaces, uppercase)
function segCandidates(params) {
  const cc = Number(params.cc) || 0;
  if (isElectric(params.fuelType)) return ['3-7KW', '<3KW', '>7KW', 'SCOOTER', 'ALL'];
  if (isScooter(params.make, params.model, params.fuelType)) return ['SCOOTER', 'ALL'];
  if (isRE(params.make, params.model)) return cc <= 350 ? ['<=350', 'ALL'] : ['>350', 'ALL'];
  return cc <= 155 ? ['MC<=155', 'ALL'] : ['MC>155', 'ALL'];
}

function resolveGoDigitTwBundleRate(params, region) {
  if (!/TW|2W|TWO WHEELER/.test(norm(params.vehicleType))) return null;
  const tenure = norm(params.policyTenure || params.bundledTag).replace(/\s+/g, '');
  if (tenure !== '1+5' && tenure !== '5+5') return null;   // annual → 1+1 path
  const clusters = IDX[tenure];
  if (!clusters) return null;
  const cl = clusters[clKey(region)];
  if (!cl) return null;

  const fam = makeFamily(params.make);
  const cands = segCandidates(params);
  for (const mk of [fam, 'Others']) {
    const m = cl[mk];
    if (!m) continue;
    for (const sg of cands) {
      if (m[sg] && m[sg].cd2 != null) {
        return { rate: +Number(m[sg].cd2).toFixed(4), tenure, cluster: region, make: mk, segment: sg };
      }
    }
  }
  return null;
}

module.exports = { resolveGoDigitTwBundleRate, makeFamily, segCandidates };
