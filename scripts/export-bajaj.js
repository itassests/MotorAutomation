/**
 * Standalone: parse all Bajaj Mar'26 source files with the insurer config
 * and emit a single master 35-column xlsx. No database required.
 *
 * Usage:
 *   node scripts/export-bajaj.js [srcDir] [outFile]
 */

const fs = require('fs');
const path = require('path');
const { parseWorkbook } = require('../parsers/engine');
const { buildExportBufferFromData } = require('../services/excel-export');

const srcDir = process.argv[2] || path.join(__dirname, '..', 'uploads', 'bajaj_mar26');
const outFile = process.argv[3] || path.join(__dirname, '..', 'exports', 'Bajaj_Mar26_master.xlsx');

const cfgPath = path.join(__dirname, '..', 'config', 'insurers', 'bajaj_allianz.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const files = fs.readdirSync(srcDir).filter(f => /\.(xlsx|xlsb|xls)$/i.test(f));
console.log(`[export-bajaj] parsing ${files.length} files from ${srcDir}`);

const allRules = [];
const allRtos = [];
for (const fn of files) {
  const full = path.join(srcDir, fn);
  const rules = parseWorkbook(full, cfg);
  let ruleCount = 0;
  let rtoCount = 0;
  for (const r of rules) {
    if (r.layout === 'rto_mapping') {
      allRtos.push({
        insurer: r.insurer || cfg.insurer,
        product: r.product,
        rto_code: r.rto_code,
        region: r.region,
        cluster: r.cluster || '',
      });
      rtoCount++;
    } else {
      // ensure insurer populated for export normalization
      if (!r.insurer) r.insurer = cfg.insurer;
      allRules.push(r);
      ruleCount++;
    }
  }
  console.log(`  ${fn} → ${ruleCount} rules + ${rtoCount} RTO mappings`);
}

console.log(`[export-bajaj] total: ${allRules.length} rules, ${allRtos.length} RTO mappings`);

const outDir = path.dirname(outFile);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const buf = buildExportBufferFromData(allRules, allRtos);
// buildExportBufferFromData may be async in the db path; here it's sync. Handle both.
Promise.resolve(buf).then(b => {
  fs.writeFileSync(outFile, b);
  console.log(`[export-bajaj] wrote ${outFile} (${b.length.toLocaleString()} bytes)`);
});
