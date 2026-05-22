// Verify the RTO override note detection + matching for Royal AP / Pan India CV STP
const path = require('path');
const fs = require('fs');
const { parseWorkbook } = require('../parsers/engine');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'insurers', 'royal_sundaram.json'), 'utf8'));

for (const f of ['royal_cv.xlsx']) {
  const fp = path.join(__dirname, '..', 'uploads', 'royal_in', f);
  const rules = parseWorkbook(fp, cfg);
  for (const sheet of ['AP', 'Pan India -CV STP']) {
    const sub = rules.filter(r => r.sheet_name === sheet);
    console.log(`\n=== ${sheet} (${sub.length} rules) ===`);
    const distinctRegions = [...new Set(sub.map(r => r.region))];
    console.log('Distinct regions:', distinctRegions);
    const withOverride = sub.filter(r => /Only for [A-Z]{2}\d/.test(String(r.remarks || '')));
    console.log(`Rules with RTO override remarks: ${withOverride.length}`);
    if (withOverride.length) {
      const sample = withOverride[0];
      console.log(`Sample override: region="${sample.region}" remarks="${sample.remarks}"`);
    }
    const vij = sub.filter(r => /vij(?:ay?)wada/i.test(String(r.region || '')));
    console.log(`Rules with region containing "Vijayawada": ${vij.length}`);
    if (vij.length) {
      const s = vij[0];
      console.log(`  sample: region="${s.region}" remarks="${s.remarks || '(none)'}"`);
    }
  }
}
