'use strict';

/**
 * Raheja QBE Private Car SATP (standalone-TP) model-specific PO.
 *
 * Raheja caps the SATP payout for a list of (mostly older / low-value) models —
 * USER-supplied. Returns the model's PO fraction (e.g. 0.15) or null when the
 * model isn't on any tier list (engine keeps the region SATP rate).
 *
 * config/raheja_car_satp_models.json holds the tiers (extensible for future
 * 25% / 2.5% tiers): each tier has a `rate`, `makes_all` (every model of the
 * make qualifies) and a per-make `models` token list (model name contains the
 * token).
 */
const SATP_MODELS = require('../config/raheja_car_satp_models.json');
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function resolveRahejaCarSatpModelRate(params) {
  if (String(params.vehicleType || '').toUpperCase() !== 'CAR') return null;
  const makeN = norm(params.make);
  const modelN = norm(params.model);
  if (!makeN && !modelN) return null;
  for (const tier of (SATP_MODELS.tiers || [])) {
    // make-level: every model of these makes qualifies
    if ((tier.makes_all || []).some(m => makeN.includes(norm(m)))) return tier.rate;
    // per-make model-token list: make must match AND model must contain a token
    for (const [mk, toks] of Object.entries(tier.models || {})) {
      if (!makeN.includes(norm(mk))) continue;
      if ((toks || []).some(t => modelN.includes(norm(t)))) return tier.rate;
    }
  }
  return null;
}

module.exports = { resolveRahejaCarSatpModelRate };
