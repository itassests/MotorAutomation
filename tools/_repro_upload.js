// Reproduce upload-route parsing on the actual uploaded file.
const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const file = path.join(__dirname, '..', 'uploads', '1777449401690_CV__Grid_Communication_Jan_26.xlsx');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'tata_aig.json'), 'utf8'));
console.log('File exists:', fs.existsSync(file), 'size:', fs.statSync(file).size);
console.log('Config insurer:', cfg.insurer, ' sheets:', cfg.sheets.map(s => s.name).join(', '));
const t0 = Date.now();
const rules = parseWorkbook(file, cfg);
console.log(`parsed ${rules.length} rules in ${Date.now() - t0}ms`);
const bySheet = {};
for (const r of rules) bySheet[r.sheet_name || r.layout] = (bySheet[r.sheet_name || r.layout] || 0) + 1;
console.log('by sheet:', bySheet);
