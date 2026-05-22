const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const dir = 'D:/Motor_Payout/April26/Ritesh Sir/Bajaj/April\'26/Grid';
const files = fs.readdirSync(dir);
console.log('Files:', files);
for (const f of files) {
  if (!/\.xls[bx]?$/i.test(f)) continue;
  const full = path.join(dir, f);
  console.log('\n\n############### ' + f + ' ###############');
  try {
    const wb = XLSX.readFile(full);
    console.log('Sheets:', wb.SheetNames);
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      console.log('\n=== "' + name + '" (' + aoa.length + ' rows) ===');
      const N = Math.min(10, aoa.length);
      for (let i = 0; i < N; i++) {
        const row = (aoa[i] || []).slice(0, 18).map(v => {
          const s = String(v ?? '').trim();
          return s.length > 28 ? s.slice(0, 28) + '…' : s;
        });
        console.log('  R' + i + ': [' + row.join(' | ') + ']');
      }
    }
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}
