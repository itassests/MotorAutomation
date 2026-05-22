const XLSX = require('xlsx');
const file = 'D:/Motor_Payout/April26/Ritesh Sir/Reliance April Month/New GRID ( Effective from 1st  April 2026) 00.00.xlsx';
const wb = XLSX.readFile(file);
console.log('Sheets:', wb.SheetNames);
for (const name of wb.SheetNames) {
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
  console.log(`\n========== ${name} (${aoa.length} rows) ==========`);
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const all = row.map(v => String(v ?? '').trim()).filter(s => s);
    if (all.length === 0) { console.log(`  R${i}: (blank)`); continue; }
    console.log(`  R${i} (${row.length} cols): ${all.slice(0, 30).join(' | ')}`);
  }
}
