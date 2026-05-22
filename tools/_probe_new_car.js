// Print full row content of New Car sheet, untruncated.
const XLSX = require('xlsx');
const wb = XLSX.readFile('uploads/royal_in/royal_other.xlsx');
const sh = wb.Sheets['New Car '];
const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
console.log('Rows:', aoa.length);
for (let r = 0; r < aoa.length; r++) {
  const row = aoa[r] || [];
  console.log(`r${r}:`);
  row.forEach((c, i) => {
    const s = String(c).trim();
    if (s) console.log(`  [${i}] ${s}`);
  });
}
