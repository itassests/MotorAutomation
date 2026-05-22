// Probe the LAST rows of state CV sheets — looking for "IRDA" notes.
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.argv[2], { cellDates: false });
const target = process.argv[3];
const sh = wb.Sheets[target];
const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
console.log(`=== ${target} (${aoa.length} rows) — last 8 rows ===`);
for (let r = Math.max(0, aoa.length - 8); r < aoa.length; r++) {
  const row = aoa[r] || [];
  console.log(`r${r}:`);
  row.forEach((c, i) => {
    const s = String(c).trim();
    if (s) console.log(`  [${i}] ${s.slice(0, 200)}`);
  });
}
