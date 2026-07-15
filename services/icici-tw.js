'use strict';

/**
 * ICICI Two-Wheeler — "TW Grid Premier" (make-aware). The base ingest flattened the
 * make dimension (generic "TW Scooter (1+5) New" = one rate), but the grid is keyed
 * by MAKE × Bike/Scooter. E.g. DL5/7128 Honda Activa NEW in Haryana: base 25 vs
 * grid HMSI(Honda) Scooter = 40 (operator).
 *
 *  NEW (age 0 / 1+5 bundle) → TW-New: region × make × Bike/Scooter (EV = single col).
 *  OLD (age>=1)             → TW Old: region × Bike/Scooter × cover(Comp/SAOD/AOTP).
 *
 * config/icici_tw_jun26.json. Returns the Net% fraction or null (unknown region/make
 * — e.g. Bajaj/KTM/Vespa have NO column in the grid → leave the engine's value).
 */
const CFG = require('../config/icici_tw_jun26.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const regKey = (s) => norm(s).replace(/[^A-Z0-9]/g, '');

const NEW_IDX = {}, OLD_IDX = {};
for (const k of Object.keys(CFG.twNew)) NEW_IDX[regKey(k)] = CFG.twNew[k];
for (const k of Object.keys(CFG.twOld)) OLD_IDX[regKey(k)] = CFG.twOld[k];

function makeCol(make, fuel) {
  if (/ELECTRIC|\bEV\b|BATTERY/.test(norm(fuel))) return 'EV';
  const m = norm(make);
  if (/HERO/.test(m)) return 'HMC';
  if (/HONDA/.test(m)) return 'HMSI';
  if (/ROYAL\s*ENFIELD|ENFIELD/.test(m)) return 'RE';
  if (/SUZUKI/.test(m)) return 'Suzuki';
  if (/\bTVS\b/.test(m)) return 'TVS';
  if (/YAMAHA/.test(m)) return 'Yamaha';
  return null;                                    // Bajaj/KTM/Vespa/… → no grid column
}
const isScooter = (make, model, fuel) => {
  const hay = `${norm(make)} ${norm(model)}`;
  return /ACTIVA|JUPITER|FASCINO|ACCESS|\bDIO\b|NTORQ|MAESTRO|PLEASURE|VESPA|SCOOT|DESTINI|XOOM|\bRAY\b|BURGMAN|AVIATOR|CHETAK|IQUBE|\bZEST\b|GRAZIA|RITMO|WEGO|GUSTO|\bDURO\b|RODEO|\bDUET\b|SWISH|AEROX|\bVIDA\b|ATHER|AMPERE|\bOLA\b|\bLETS\b|ALPHA|CYGNUS|GRAZIA|BEAMING|PLEASURE/.test(hay);
};

function resolveIciciTwRate(params, region) {
  if (!/TW|2W|TWO WHEELER/.test(norm(params.vehicleType))) return null;
  const rk = regKey(region);
  const isNew = (Number(params.vehicleAge) || 0) === 0 ||
    String(params.vehicleRegNo || '').trim().toUpperCase() === 'NEW';
  // BODY: trust the base grid's Scooter/Bike classification (matchedSegment) over the
  // model regex — the regex misses models like TVS Orbiter (scooter) → wrong Bike col.
  const bs = norm(params.matchedSegment);
  const scooter = /SCOOTER/.test(bs) ? true : /\bBIKE\b|MOTOR\s*CYCLE/.test(bs) ? false
    : isScooter(params.make, params.model, params.fuelType);

  if (isNew) {
    const row = NEW_IDX[rk];
    if (!row) return null;
    const mk = makeCol(params.make, params.fuelType);
    if (!mk) return null;
    const key = mk === 'EV' ? 'EV' : mk === 'RE' ? 'RE_Bike' : `${mk}_${scooter ? 'Scooter' : 'Bike'}`;
    const v = row[key];
    if (v == null) return null;
    return { rate: v, tenure: 'New(1+5)', body: mk === 'EV' ? 'EV' : (scooter ? 'Scooter' : 'Bike'), col: key };
  }
  // OLD: body × cover
  const row = OLD_IDX[rk];
  if (!row) return null;
  const od = Number(params.odPremium) || 0, tp = Number(params.tpPremium) || 0;
  const cover = od <= 0 ? 'AOTP' : (tp <= 0 ? 'SAOD' : 'Comp');
  const key = `${scooter ? 'Scooter' : 'Bike'}_${cover}`;
  const v = row[key];
  if (v == null) return null;
  return { rate: v, tenure: 'Old', body: scooter ? 'Scooter' : 'Bike', col: key };
}

module.exports = { resolveIciciTwRate, makeCol, isScooter };
