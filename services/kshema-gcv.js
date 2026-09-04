'use strict';

/**
 * Kshema GCV / Tractor / School-Bus — "Kshema July" grid (effective Aug'26,
 * USER-confirmed). State × tonnage-band cross-tab (config/kshema_gcv_aug26.json),
 * top/detailed block: Preferred states carry RTO-city granularity for Odisha
 * (Bhubaneswar/Cuttack) and West Bengal (Kolkata/Contai/Durgapur/Asansol);
 * NE + Non-Preferred states use a single Above-40T top band.
 *
 * Tractor/Harvester (MISC) and School Bus (PCV) rates live in the same table.
 * Weight edge: LOWER band owns the boundary (tonnage <= band max). A null/blank
 * cell means the class is declined in that state → rate 0 (is_declined). Returns
 * { rate, declined } or null (state/segment not resolvable → engine unchanged).
 */
const CFG = require('../config/kshema_gcv_aug26.json');
const { STATE_CANON } = require('../parsers/engines/kshema');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const rtoKey = (rto) => {
  const c = norm(rto).replace(/[^A-Z0-9]/g, '');
  const m = c.match(/^([A-Z]+)0*(\d+)/);
  return m ? m[1] + m[2].padStart(2, '0') : c;
};

function stateKey(params) {
  const pfx = norm(params.rtoCode).replace(/[^A-Z]/g, '').slice(0, 2);
  let st = STATE_CANON[pfx] || STATE_CANON[norm(params.stateName)] || null;
  if (!st) return null;
  const rk = rtoKey(params.rtoCode);
  if (st === 'ODISHA' && (CFG.odSpecial || []).includes(rk)) return 'ODISHA__SPECIAL';
  if (st === 'WEST BENGAL' && (CFG.wbSpecial || []).includes(rk)) return 'WEST BENGAL__SPECIAL';
  return st;
}

function resolveKshemaGcvRate(params) {
  const vt = norm(params.vehicleType);
  const hay = `${norm(params.vehicleCategory)} ${norm(params.model)} ${norm(params.make)}`;
  const key = stateKey(params);
  if (!key) return null;
  const row = CFG.gcv[key];
  if (!row) return null;

  let rate;
  if (/SCHOOL\s*BUS/.test(hay) || (/PCV|PASSENGER/.test(vt) && /SCHOOL/.test(hay))) rate = row.schoolBus;
  else if (/TRACTOR|HARVEST/.test(hay)) rate = row.tractor;
  else if (/GCV|GOODS/.test(vt)) {
    const ton = Number(params.tonnage) || 0;
    if (!(ton > 0)) return null;
    let picked = null;
    for (const b of row.bands) { if (b.maxT == null || ton <= b.maxT) { picked = b; break; } }
    if (!picked) return null;
    rate = picked.rate;
  } else return null;

  if (rate == null) return { rate: 0, declined: true };
  return { rate: +Number(rate).toFixed(4), declined: rate === 0 };
}

module.exports = { resolveKshemaGcvRate, stateKey };
