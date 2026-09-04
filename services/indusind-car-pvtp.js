'use strict';

/**
 * IndusInd Private-Car TP (SATP) — "PVTP Grid Fuel-wise 24 Aug" addendum, a
 * RTO-State × {Diesel, Non-Diesel} table (config/indusind_car_pvtp_aug26.json).
 * The June PVT grid (indusind-car.js) sets stp=0 everywhere; this addendum gives
 * the actual Pvt-Car TP payout per state for risk-start ≥ 24-Aug-26. Applies to
 * TP-only Pvt-Car (od<=0). States absent from the grid → null (June stp=0 stands).
 * Returns rate fraction or null.
 */
const GRID = require('../config/indusind_car_pvtp_aug26.json');
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

// RTO state-prefix → PVTP state name (only prefixes the grid actually lists).
const ST = {
  AS: 'ASSAM', TS: 'TELANGANA', TG: 'TELANGANA', JK: 'JAMMU AND KASHMIR', LA: 'JAMMU AND KASHMIR',
  UK: 'UTTARAKHAND', GJ: 'GUJARAT', UP: 'UTTAR PRADESH', CH: 'CHANDIGARH', PB: 'PUNJAB',
  JH: 'JHARKHAND', HP: 'HIMACHAL PRADESH', DL: 'DELHI', WB: 'WEST BENGAL', MH: 'MAHARASHTRA',
  BR: 'BIHAR', GA: 'GOA', AN: 'ANDAMAN AND NICOBAR ISLANDS', MN: 'MANIPUR',
  DN: 'DADRA & NAGAR HAVELI', DD: 'DAMAN & DIU', NL: 'NAGALAND', SK: 'SIKKIM',
  AR: 'ARUNACHAL PRADESH', MZ: 'MIZORAM', ML: 'MEGHALAYA',
};

function resolveIndusindCarPvtpRate(params) {
  if (norm(params.vehicleType) !== 'CAR') return null;
  if ((Number(params.odPremium) || 0) > 0) return null;     // TP-only
  const st = norm(params.rtoCode).replace(/[^A-Z]/g, '').slice(0, 2);
  const name = ST[st];
  if (!name) return null;
  const row = GRID[name];
  if (!row) return null;
  const isDiesel = /DIESEL|^D$/.test(norm(params.fuelType));
  const rate = isDiesel ? row.diesel : row.nonDiesel;
  return rate == null || isNaN(rate) ? null : +Number(rate).toFixed(4);
}

module.exports = { resolveIndusindCarPvtpRate };
