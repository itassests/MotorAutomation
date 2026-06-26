'use strict';

/**
 * Bajaj Allianz Private-Car COMPREHENSIVE (ROBINHOOD product 1801) commission.
 *
 * GROUND TRUTH: "Private Car- Complete Grid- .xlsx", sheet "1801" — the payout is
 * a per-RTO-STATE grid (rate % on OD), by fuel x NCB, NOT zoned. There is NO
 * "Zone-1"/"Delhi" concept (a prior bulk.js override invented that by borrowing
 * the HDFC ROBINHOOD structure — removed). Key rules:
 *   - Universal: Diesel w/o NCB = 10; HEV w/o NCB = 10 (every state incl. default).
 *   - Listed states (config) priced by fuel x NCB; the grid excludes the metros
 *     (Gurgaon/Faridabad from Haryana, Bangalore from Karnataka, Chennai from
 *     Tamil Nadu, Hyderabad from Telangana) — those RTOs carry their own metro
 *     grid-state in the RTO Master and fall to the default.
 *   - "All Other States" (incl. Delhi/Mumbai/Pune/Gujarat/the excluded metros) =
 *     DEFAULT 45 (USER 2026-06-26: the grid says "For All Other States ... Motor
 *     4W on OD = 45%"; the earlier dry-run-tuned 40 was wrong — operator-40 cars
 *     are now grid-correct-45 divergences). Diesel/HEV w/o NCB still = 10.
 *   - NOT modelled (no data): CD>80% cap (19.5 OEM / 15 non-OEM), OEM-code 19.5
 *     minimum, UP-West "IRDA" exception (UP NCB is approximated to 35 everywhere).
 *
 * Returns the rate as a FRACTION (0.40), or null when not applicable (not a CAR,
 * not product 1801, no state resolvable) so the caller leaves the engine alone.
 *
 * @param {object} params extractPolicyParams output (rtoCode, fuelType, ncbPct, vehicleType)
 * @returns {number|null} rate fraction, or null.
 */
const GRID = require('../config/bajaj_car_1801.json');
const RTO_STATE = require('../config/bajaj_rto_state.json');

function gridStateForRto(rtoCode) {
  const code = String(rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
  if (!code) return null;
  // direct, then zero-padded numeric variant (GJ1 <-> GJ01)
  if (RTO_STATE[code]) return RTO_STATE[code];
  const m = code.match(/^([A-Z]+)(\d+)$/);
  if (m) {
    const alt2 = m[1] + String(parseInt(m[2], 10)).padStart(2, '0');
    const alt1 = m[1] + parseInt(m[2], 10);
    if (RTO_STATE[alt2]) return RTO_STATE[alt2];
    if (RTO_STATE[alt1]) return RTO_STATE[alt1];
  }
  return null;
}

function resolveBajajCarRate(params) {
  if (String(params.vehicleType || '').toUpperCase() !== 'CAR') return null;
  // CD > 80% cap (USER 2026-06-26): when the OD discount (Bajaj PR "Comm Disc
  // Rate", a whole percent in params.discountPct) exceeds 80%, the payout is
  // restricted to 10% on OD — overrides the fuel/NCB/state grid below.
  if ((Number(params.discountPct) || 0) > 80) return 0.10;
  const fuel = String(params.fuelType || '').toUpperCase();
  const ncb = (Number(params.ncbPct) || 0) > 0;
  const diesel = /DIESEL/.test(fuel);
  const hev = /ELECTRIC|HYBRID|\bHEV\b|BATTERY/.test(fuel);

  // Universal rule first — Diesel/HEV without NCB = 10, in every state.
  if (!ncb && (diesel || hev)) return +(GRID.dieselNoNcb / 100).toFixed(4);

  let st = gridStateForRto(params.rtoCode);
  if (st) st = (GRID._stateAliases[st] || st);

  const g = st && GRID.states[st];
  if (!g) return +(GRID.default / 100).toFixed(4);   // unlisted state / excluded metro → default

  // UP special: Non-NCB = 10 (handled above for diesel; petrol-no-NCB also 10),
  // NCB = 35 (UP-West "IRDA" exception not modelled).
  let pct;
  if (ncb) pct = diesel ? g.dieselNcb : g.petrolNcb;
  else     pct = diesel ? g.dieselNoNcb : g.petrolNoNcb;
  if (pct == null) return +(GRID.default / 100).toFixed(4);
  return +(pct / 100).toFixed(4);
}

module.exports = { resolveBajajCarRate, gridStateForRto };
