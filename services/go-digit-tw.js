'use strict';

/**
 * GO DIGIT Two-Wheeler — June'26 "Large Broker Grid" (sheet "2W Grid 1+1 & SATP").
 * The operator's commission is the grid's **Max CD2** column:
 *   Comp (1+1, bundled OD+TP) → the "1+1 Max CD2" cell
 *   TP   (standalone-TP)      → the "SATP Max CD2" cell
 * keyed by Agency/PB Cluster × Segment. Our June ingestion stored WRONG values into
 * rate_rules (e.g. SC/EV UP+UK_Good2 1+1 → 0.605 vs the grid's 0.56), so ~100 TW
 * policies mis-rated. Validated vs the June-1 reconciliation: 34 Comp match 1+1
 * MaxCD2 + 51 TP match SATP MaxCD2.
 *
 * Segment (Agency/PB Seg): SC/EV (scooter or electric), MC <= 180 Hero/Honda,
 * MC <= 180 Others, MC_180-350_RE (Royal Enfield), MC_180-350_Honda/Jawa/Avenger,
 * MC_180-350_Others, MC>350. Classified from make/model/cc/fuel.
 *
 * Cluster = the region the engine already resolved (rate_rules region), passed in.
 * Returns the rate FRACTION or null (SAOD, unknown cluster/segment → leave engine).
 * config/go_digit_tw_jun26.json (regenerate from the grid on re-upload).
 */
const CFG = require('../config/go_digit_tw_jun26.json');
const GRID = CFG.grid;
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();

function segmentOf(params) {
  const hay = `${norm(params.make)} ${norm(params.model)}`;
  const fuel = norm(params.fuelType);
  if (/ELECTRIC|\bEV\b|BATTERY/.test(fuel) ||
      /ACTIVA|JUPITER|FASCINO|ACCESS|\bDIO\b|NTORQ|MAESTRO|PLEASURE|VESPA|SCOOT|DESTINI|XOOM|\bRAY\b|BURGMAN|AVIATOR|CHETAK|IQUBE|\bZEST\b|GRAZIA|RITMO|FASCINO/.test(hay)) {
    return 'SC/EV';
  }
  const cc = Number(params.cc) || 0;
  if (cc <= 180) return /HERO|HONDA/.test(hay) ? 'MC <= 180 HERO/HONDA' : 'MC <= 180 OTHERS';
  if (cc <= 350) {
    if (/ROYAL\s*ENFIELD|BULLET|CLASSIC|METEOR|HIMALAYAN|THUNDERBIRD|\bRE\b/.test(hay)) return 'MC_180-350_RE';
    if (/HONDA|JAWA|AVENGER/.test(hay)) return 'MC_180-350_HONDA/JAWA/AVENGER';
    return 'MC_180-350_OTHERS';
  }
  return 'MC>350';
}

function resolveGoDigitTwRate(params, region) {
  if (!/TW|2W|TWO WHEELER/.test(norm(params.vehicleType))) return null;
  const cluster = GRID[norm(region)];
  if (!cluster) return null;
  const cell = cluster[segmentOf(params)];
  if (!cell) return null;
  const od = Number(params.odPremium) || 0;
  const tp = Number(params.tpPremium) || 0;
  let rate;
  if (od <= 0) rate = cell.satpMax;            // standalone TP
  else if (tp <= 0) return null;               // SAOD → leave to engine (separate grid)
  else rate = cell.oneMax;                      // Comp (1+1)
  if (rate == null || !Number.isFinite(Number(rate))) return null;
  return +Number(rate).toFixed(4);
}

module.exports = { resolveGoDigitTwRate, segmentOf };
