const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));
const rules = parseWorkbook(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx'), cfg);
// Find the active sheet via the config's name_pattern (NOT a literal name)
// so this diagnostic survives sheet renames the same way production parsing does.
const cfgEntry = cfg.sheets.find(s => /pc[\s_]*comp[\s_]*1/i.test(s.name) || /pc[\s_]*comp[\s_]*1/i.test(s.name_pattern || ''));
const sheetRe = new RegExp(cfgEntry.name_pattern, 'i');
const pc = rules.filter(r => sheetRe.test(String(r.sheet_name || '')));

const byState = new Map();
for (const r of pc) {
  const st = r.remarks || '(blank)';
  if (!byState.has(st)) byState.set(st, { rules: 0, tiers: new Set(), bands: new Set() });
  const e = byState.get(st);
  e.rules++;
  e.tiers.add(r.sub_type || '(blank)');
  e.bands.add(r.volume_tier || '(blank)');
}
const cols = ['State (remarks)','# rules','City tiers','Discount bands'];
const rows = [cols];
for (const [st, e] of [...byState.entries()].sort()) {
  rows.push([st, String(e.rules), [...e.tiers].join(', '), [...e.bands].join(', ')]);
}
const w = cols.map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
for (const r of rows) console.log(r.map((v, c) => String(v).padEnd(w[c])).join('  '));
