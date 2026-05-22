const XLSX = require('xlsx');
const wb = XLSX.readFile('D:/Motor_Payout/April26/Ritesh Sir/Reliance April Month/New GRID ( Effective from 1st  April 2026) 00.00.xlsx');
const aoa = XLSX.utils.sheet_to_json(wb.Sheets['April CV26'], { header: 1, defval: '' });

console.log('=== April CV26 column-by-column header (cols 0-29) ===');
for (let c = 0; c < 30; c++) {
  const r2 = String(aoa[2][c] || '').trim();
  const r3 = String(aoa[3][c] || '').trim();
  const r4 = String(aoa[4][c] || '').trim();
  console.log(`col ${c.toString().padStart(2)}: R2=${JSON.stringify(r2)}\n        R3=${JSON.stringify(r3)}\n        R4=${JSON.stringify(r4)}`);
}
