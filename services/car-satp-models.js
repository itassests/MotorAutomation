'use strict';

/**
 * Private Car SATP (standalone-TP) model-specific PO — shared, config-driven
 * matcher for any insurer that prices certain car models at a fixed/capped TP PO.
 *
 * Per-insurer configs live in config/<slug>_car_satp_models.json. Each holds
 * `tiers[]`; the FIRST matching tier wins. A tier has:
 *   - rate       : the PO fraction (e.g. 0.15, 0.25)
 *   - cap        : (optional) true => "Max X%" — take min(base SATP rate, rate);
 *                  false/absent => set the rate outright.
 *   - makes_all  : (optional) makes whose EVERY model qualifies (substring on make)
 *   - models     : (optional) { MAKE: [tokens] } — make must match AND model
 *                  contains a token
 *   - models_any : (optional) [tokens] — model contains a token, ANY make
 *   - exclude    : (optional) [tokens] — if the model contains any, the tier is
 *                  skipped (e.g. "SWIFT" tier excludes "DZIRE" so a Swift Dzire
 *                  doesn't take the Swift rate)
 *
 * resolveCarSatpModelRate returns { rate, cap } or null (no tier matched →
 * engine keeps the region SATP rate). The caller applies the cap (it has the
 * base rate).
 */
const CONFIGS = {
  raheja_qbe:    safeLoad('../config/raheja_car_satp_models.json'),
  bajaj_allianz: safeLoad('../config/bajaj_car_satp_models.json'),
};
function safeLoad(p) { try { return require(p); } catch (_) { return null; } }

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function resolveCarSatpModelRate(insurerSlug, params) {
  const cfg = CONFIGS[insurerSlug];
  if (!cfg || String(params.vehicleType || '').toUpperCase() !== 'CAR') return null;
  const makeN = norm(params.make);
  const modelN = norm(params.model);
  if (!makeN && !modelN) return null;
  for (const tier of (cfg.tiers || [])) {
    if ((tier.exclude || []).some(t => modelN.includes(norm(t)))) continue;
    const hit =
      (tier.makes_all || []).some(m => makeN.includes(norm(m))) ||
      (tier.models_any || []).some(t => modelN.includes(norm(t))) ||
      Object.entries(tier.models || {}).some(([mk, toks]) =>
        makeN.includes(norm(mk)) && (toks || []).some(t => modelN.includes(norm(t))));
    if (hit) return { rate: tier.rate, cap: !!tier.cap };
  }
  return null;
}

module.exports = { resolveCarSatpModelRate };
