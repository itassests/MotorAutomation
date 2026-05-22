const XLSX = require('xlsx');
const file = 'D:/Motor_Payout/April26/Ritesh Sir/Universal April Month/Universal Sompo Grid.xlsx';
const wb = XLSX.readFile(file);
for (const name of wb.SheetNames) {
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
  console.log(`\n========== ${name} (${aoa.length} rows) ==========`);
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i] || [];
    // print all non-empty cells with their full content for headings/notes,
    // but only show col 0 for footer-rich rows
    const all = row.map(v => String(v ?? '').trim()).filter(s => s);
    if (all.length === 0) { console.log(`  R${i}: (blank)`); continue; }
    console.log(`  R${i} (${row.length} cols): ${all.slice(0, 30).join(' | ')}`);
  }
}
