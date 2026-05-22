// Distinct values in cols 0-3 of cv checks
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.argv[2], { cellDates: false });
const aoa = XLSX.utils.sheet_to_json(wb.Sheets[process.argv[3]], { header: 1, defval: '' });
const sets = [new Set(), new Set(), new Set(), new Set()];
for (let r = 1; r < aoa.length; r++) {
  for (let c = 0; c < 4; c++) {
    const v = String((aoa[r] || [])[c] || '').trim();
    if (v) sets[c].add(v);
  }
}
const labels = ['Segment', 'Section', 'Age', 'Slab'];
sets.forEach((s, i) => {
  console.log(`\n${labels[i]} (${s.size}):`);
  for (const v of [...s].sort()) console.log('  ' + v);
});
