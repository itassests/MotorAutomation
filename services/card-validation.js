'use strict';

/**
 * Rate-card ingestion validation. Run after a card's rules are inserted (at
 * upload) or on demand for an existing card. Surfaces the failure modes we've
 * actually hit so a bad ingest is caught at the door, not tracker-by-tracker:
 *   - 0 rules (parser produced nothing — wrong sheet/column config)
 *   - scratch/hidden sheets ingested ("cv checks", "pci checks", "test", …)
 *   - scrambled columns (e.g. tonnage text landing in fuel_type — the Tata June
 *     CV bug)
 *   - mostly-zero / mostly-blank rates (parse misalignment)
 *
 * Returns { card_id, total, distinct_regions, zero_pct, sheets:[…], flags:[…] }
 * where flags have { level: 'error'|'warn', msg }.
 */

// fuel_type should be a fuel word; these tokens mean it's holding something else.
const FUEL_SCRAMBLE = /[<>]=?|\bGCV\b|\bPCV\b|TONNE|\bTN\b|PACKAGE|\bSATP\b|\bSAOD\b|>=|<=|\d{3,}/i;
// sheet names that look like scratch/QA tabs, not real grids.
const SCRATCH_SHEET = /check|test|scratch|temp(?!o)|pending|backup|\bcopy\b|dummy|\bwip\b|sample|do not use|don'?t use/i;
const VALID_FUEL = /^(ALL|PETROL|DIESEL|CNG|LPG|ELECTRIC|EV|HYBRID|HEV|BATTERY|BIFUEL|PETROL\/CNG|OTHER|OTHER THAN DIESEL|INBUILT|NA|)$/i;

async function validateCard(pool, cardId) {
  const rules = (await pool.request().input('c', cardId).query(
    `SELECT product, region, fuel_type, rate_type, segment, rate_value, sheet_name
       FROM rate_rules WHERE rate_card_id = @c`)).recordset;
  const total = rules.length;
  const flags = [];
  if (total === 0) {
    flags.push({ level: 'error', msg: 'No rules ingested — the parser produced 0 rows. Check the sheet name / column mapping for this insurer.' });
    return { card_id: cardId, total: 0, distinct_regions: 0, zero_pct: 0, sheets: [], flags };
  }

  const sheets = {};
  for (const r of rules) {
    const s = r.sheet_name || '(none)';
    const g = sheets[s] || (sheets[s] = { count: 0, zero: 0, nullRate: 0, fuelScramble: 0, badFuel: 0 });
    g.count++;
    if (r.rate_value == null) g.nullRate++;
    else if (Number(r.rate_value) === 0) g.zero++;
    const fu = r.fuel_type == null ? '' : String(r.fuel_type).trim();
    if (fu && FUEL_SCRAMBLE.test(fu)) g.fuelScramble++;
    else if (fu && !VALID_FUEL.test(fu)) g.badFuel++;
  }

  const sheetReport = Object.entries(sheets).map(([name, g]) => {
    const sf = [];
    if (SCRATCH_SHEET.test(name)) sf.push({ level: 'error', msg: 'looks like a scratch/QA tab — should it be ingested at all?' });
    if (g.fuelScramble / g.count > 0.3) sf.push({ level: 'error', msg: `fuel column scrambled — ${Math.round(100 * g.fuelScramble / g.count)}% hold non-fuel values (e.g. tonnage/segment). Columns are likely misaligned.` });
    if (g.zero / g.count > 0.8) sf.push({ level: 'warn', msg: `${Math.round(100 * g.zero / g.count)}% of rates are 0 — possible parse misalignment or a declined block.` });
    if (g.nullRate / g.count > 0.5) sf.push({ level: 'warn', msg: `${Math.round(100 * g.nullRate / g.count)}% of rates are blank.` });
    return { name, count: g.count, flags: sf };
  }).sort((a, b) => b.count - a.count);

  sheetReport.forEach((s) => s.flags.forEach((f) => flags.push({ level: f.level, msg: `sheet "${s.name}": ${f.msg}` })));

  const zero = rules.filter((r) => Number(r.rate_value) === 0).length;
  const distinctRegions = new Set(rules.map((r) => r.region)).size;
  return {
    card_id: cardId,
    total,
    distinct_regions: distinctRegions,
    zero_pct: +(100 * zero / total).toFixed(0),
    sheets: sheetReport,
    flags,
  };
}

module.exports = { validateCard };
