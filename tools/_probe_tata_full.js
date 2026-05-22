// Print rows 0..7 across cols 0..15 for a sheet (compact)
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.argv[2], { cellDates: false });
for (const target of process.argv.slice(3)) {
  const sh = wb.Sheets[target];
  if (!sh) { console.log(`\n=== ${target}: NOT FOUND ===`); continue; }
  const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  console.log(`\n=== ${target} (rows: ${aoa.length}) ===`);
  for (let r = 0; r < Math.min(7, aoa.length); r++) {
    const row = aoa[r] || [];
    console.log(`r${r} (len ${row.length}):`);
    row.forEach((c, i) => {
      if (i > 18) return;
      const s = String(c).trim();
      if (s) console.log(`  [${i}] ${s.slice(0, 40)}`);
    });
  }
}
