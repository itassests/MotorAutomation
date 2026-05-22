// Print first 7 cols of first 3 rows for a sheet
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.argv[2], { cellDates: false });
const aoa = XLSX.utils.sheet_to_json(wb.Sheets[process.argv[3]], { header: 1, defval: '' });
for (let r = 0; r < Math.min(4, aoa.length); r++) {
  const head = (aoa[r] || []).slice(0, 8).map((v, i) => `[${i}]${String(v).slice(0, 25)}`).join(' ');
  console.log(`row ${r}: ${head}`);
}
