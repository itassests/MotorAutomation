const XLSX = require('xlsx');
const path = require('path');
const file = 'D:/Motor_Payout/April26/Ritesh Sir/Universal April Month/Universal Sompo Grid.xlsx';
const wb = XLSX.readFile(file);
console.log('Sheets:', wb.SheetNames);
for (const name of wb.SheetNames) {
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
  console.log(`\n=== ${name} (${aoa.length} rows) ===`);
  for (let i = 0; i < Math.min(8, aoa.length); i++) {
    const row = (aoa[i] || []).slice(0, 25).map(v => {
      const s = String(v ?? '').trim();
      return s.length > 30 ? s.slice(0, 30) + '…' : s;
    });
    console.log(`  R${i}: [${row.join(' | ')}]`);
  }
}
