const XLSX = require('xlsx');
const wb = XLSX.readFile('uploads/royal_in/royal_other.xlsx', { cellDates: false });
// Find the school-bus sheet by pattern (NOT literal name)
const re = /^school[\s_]*bus$/i;
const target = wb.SheetNames.find(n => re.test(n));
const aoa = XLSX.utils.sheet_to_json(wb.Sheets[target], { header: 1, defval: '' });
console.log(`Sheet "${target}" — ${aoa.length} rows, max width ${Math.max(...aoa.map(r => (r||[]).length))}`);
for (let r = 0; r < Math.min(40, aoa.length); r++) {
  const row = aoa[r] || [];
  console.log(`r${r} (len ${row.length}):`);
  row.forEach((c, i) => {
    const s = String(c).trim();
    if (s) console.log(`  [${i}] ${s.slice(0, 80)}`);
  });
}
