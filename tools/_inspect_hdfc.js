const XLSX = require('xlsx');
const path = require('path');
const files = [
  'D:/Motor_Payout/April26/Ritesh Sir/HDFC April Month/Pvt Car Comp & SAOD/ROBINHOOD Final Rate Pvt Car (1).xlsx',
  'D:/Motor_Payout/April26/Ritesh Sir/HDFC April Month/Final Grid Received on 22nd April But Effective 1st April 2026.xlsx',
  'D:/Motor_Payout/April26/Ritesh Sir/HDFC April Month/HDFC PCCV 3W Effective From 1st April.xlsx',
  'D:/Motor_Payout/April26/Ritesh Sir/HDFC April Month/HDFC RTO Master.xlsx',
  'D:/Motor_Payout/April26/Ritesh Sir/HDFC April Month/Pvt Car SATP Effective from 1st April.xlsx',
  'D:/Motor_Payout/April26/Ritesh Sir/HDFC April Month/TW Effective from 1st April.xlsx',
];
for (const f of files) {
  console.log('\n\n############### FILE:', path.basename(f), '###############');
  try {
    const wb = XLSX.readFile(f);
    console.log('Sheets:', wb.SheetNames);
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      console.log(`\n=== Sheet "${name}" (${aoa.length} rows) ===`);
      const showRows = Math.min(8, aoa.length);
      for (let i = 0; i < showRows; i++) {
        const row = (aoa[i] || []).slice(0, 18).map(v => {
          const s = String(v ?? '').trim();
          return s.length > 28 ? s.slice(0, 28) + '…' : s;
        });
        console.log(`  R${i}: [${row.join(' | ')}]`);
      }
    }
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}
