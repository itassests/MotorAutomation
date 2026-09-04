'use strict';

/**
 * IndusInd Private-Car "Additional Rate Delhi MH" (Robinhood 11BRG286),
 * applied STATE-BASIS per USER — the agent code is ignored; the rates apply to
 * ALL IndusInd Pvt-Car in Maharashtra, Gujarat and Delhi (config/
 * indusind_car_deal_aug26.json), effective Aug'26. Columns per state:
 * { highEndSaod, saod, comp (Petrol+Bifuel+EV), diesel, newPvt }.
 *
 * Cover routing:
 *   - TP-only (od<=0)          → null (June grid / PVTP addendum handle TP)
 *   - NEW private (age 0 / NEW) → newPvt
 *   - SAOD (od>0, tp<=0)       → highEndSaod if high-end make/model, else saod
 *   - Comp (od>0, tp>0)        → diesel if diesel, else comp
 * Note MH/GJ/DL values equal the June grid except Delhi new-business (0.30 vs
 * 0.275 comp); this override makes that explicit. Returns rate fraction or null.
 */
const CFG = require('../config/indusind_car_deal_aug26.json');
const { isHighEnd } = require('./reliance-car');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const ST = { MH: 'MAHARASHTRA', GJ: 'GUJARAT', DL: 'DELHI' };

function resolveIndusindCarDealRate(params) {
  if (norm(params.vehicleType) !== 'CAR') return null;
  const pfx = norm(params.rtoCode).replace(/[^A-Z]/g, '').slice(0, 2);
  const row = CFG[ST[pfx]];
  if (!row) return null;
  const od = Number(params.odPremium) || 0;
  const tp = Number(params.tpPremium) || 0;
  if (od <= 0) return null;                                   // TP-only handled elsewhere
  const isNew = (Number(params.vehicleAge) || 0) === 0 || norm(params.vehicleRegNo) === 'NEW';
  let rate;
  if (isNew) rate = row.newPvt;
  else if (tp <= 0) rate = isHighEnd(params.make, params.model) ? row.highEndSaod : row.saod;
  else rate = /DIESEL|^D$/.test(norm(params.fuelType)) ? row.diesel : row.comp;
  return rate == null || isNaN(rate) ? null : +Number(rate).toFixed(4);
}

module.exports = { resolveIndusindCarDealRate };
