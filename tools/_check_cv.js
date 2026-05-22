const xlsx = require('xlsx');
const path = require('path');
const file = path.join(__dirname, '..', 'uploads', 'icici_in', 'Copy of CV GRID MAR 26 - V1.xlsx');
const wb = xlsx.readFile(file, { cellDates: false });
console.log('sheets:', wb.SheetNames);
for (const sn of wb.SheetNames) {
  console.log('\n==========', sn, '==========');
  const aoa = xlsx.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
  console.log('rows:', aoa.length);
  for (let r = 0; r < Math.min(30, aoa.length); r++) {
    const row = aoa[r] || [];
    const has = row.some(c => String(c).trim());
    if (!has) continue;
    console.log('r' + r + ':');
    row.forEach((c, i) => { const s = String(c).trim(); if (s) console.log('  [' + i + '] ' + s.slice(0, 100)); });
  }
}
