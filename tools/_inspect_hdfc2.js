const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// Source dir contains files with non-breaking-space chars; use Get-ChildItem-style
// directory iteration via fs to find them.
const dir = 'D:/Motor_Payout/April26/Ritesh Sir/HDFC April Month/Consider';
const files = fs.readdirSync(dir);
console.log('Files in Consider/:', files);

for (const f of files) {
  if (!f.endsWith('.xlsx')) continue;
  const full = path.join(dir, f);
  console.log('\n\n############### ' + f + ' ###############');
  try {
    const wb = XLSX.readFile(full);
    console.log('Sheets:', wb.SheetNames);
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      console.log(`\n=== Sheet "${name}" (${aoa.length} rows) ===`);
      const showRows = Math.min(15, aoa.length);
      for (let i = 0; i < showRows; i++) {
        const row = (aoa[i] || []).slice(0, 18).map(v => {
          const s = String(v ?? '').trim();
          return s.length > 32 ? s.slice(0, 32) + '…' : s;
        });
        console.log(`  R${i}: [${row.join(' | ')}]`);
      }
    }
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}
