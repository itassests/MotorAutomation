'use strict';

/**
 * BAJAJ Private Car Comp/SAOD — Sept'26 "communication" grid (Ro Bajaj Pvt Car.xlsx).
 * That grid is FREE-TEXT prose per RTO-state ("W/o NCB: Diesel 10%, Petrol 15%;
 * NCB: Diesel 25%, Petrol 25%"), so the standard parser only read 6 rules. This
 * resolver applies the parsed rates. Region comes from Bajaj's RTO master (PC
 * sheet) → Grid State (config/bajaj_pvtcar_sep26.json). Rates are OD %.
 *
 * Semantics (config bajaj_pvtcar_sep26.json):
 *   - rates[gridState] = { dNo, pNo, dNcb, pNcb }  (Diesel/Petrol × No-NCB/NCB)
 *   - UP: non-NCB flat (dNo/pNo=10); NCB → West-UP RTOs = IRDA 2.5%, rest = 35%
 *   - states not listed → `default` (the "Excluding Below RTO" tier: 45% NCB,
 *     15% Diesel-no-NCB, 40% Petrol-no-NCB)
 *   - JHARKHAND → null (keeps the prior/existing Bajaj grid — CHOD approval)
 *   - HEV-treaty makes (Audi/BMW/Mercedes/…) → null for now (a separate
 *     conditional "HEV Make Consider" table governs them; not yet modelled here)
 *
 * Scope: bajaj_allianz + CAR + Comp/SAOD + risk-start on/after 1-Sep-2026.
 */
const CFG = (() => { try { return require('../config/bajaj_pvtcar_sep26.json') || {}; } catch (_) { return {}; } })();
const norm = (s) => String(s == null ? '' : s).toUpperCase();
const nrm = (s) => norm(s).replace(/[^A-Z0-9]/g, '');
const HEV_RE = new RegExp('\\b(' + (CFG.hevMakes || []).map((m) => m.replace(/[^A-Z ]/gi, '').trim().replace(/\s+/g, '\\s+')).join('|') + ')\\b', 'i');
const UP_WEST = new Set(CFG.upWest || []);

function isDiesel(fuel) { return /DIESEL/.test(norm(fuel)); }

/** @returns {number|null} OD-payout FRACTION, or null to leave the engine's value. */
function resolveBajajPvtCarSepRate(params) {
  if (nrm(params.vehicleType) !== 'CAR') return null;
  const ip = norm(params.insProduct);
  if (ip !== 'COMP' && ip !== 'SAOD') return null;           // TP handled elsewhere
  const d = String(params.effective_date || params.effectiveDate || params.riskStartDate || params.policyStartDate || '').slice(0, 10);
  if (!(d >= '2026-09-01')) return null;                      // Sept'26 grid only
  const rk = nrm(params.rtoCode);
  const gs = (CFG.rtoState || {})[rk];
  if (!gs) return null;                                       // unknown RTO → leave engine value
  if ((CFG.existingGrid || []).includes(gs)) return null;     // Jharkhand → prior grid
  // HEV-treaty makes have their own conditional table — don't apply the region grid.
  if (HEV_RE.source !== '\\b()\\b' && HEV_RE.test(norm(params.make))) return null;

  const hasNcb = (Number(params.ncbPct) || 0) > 0;
  const diesel = isDiesel(params.fuelType);
  const r = (CFG.rates || {})[gs] || CFG.default;
  if (!r) return null;

  // Uttar Pradesh NCB split: West-UP RTOs at IRDA (2.5%), rest of UP at r.dNcb/pNcb.
  if (gs === 'UTTAR PRADESH' && hasNcb && r.ncbWestIrda != null && UP_WEST.has(rk)) {
    return +(Number(r.ncbWestIrda) / 100).toFixed(4);
  }
  const pct = hasNcb ? (diesel ? r.dNcb : r.pNcb) : (diesel ? r.dNo : r.pNo);
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  return +(Number(pct) / 100).toFixed(4);
}

module.exports = { resolveBajajPvtCarSepRate };
