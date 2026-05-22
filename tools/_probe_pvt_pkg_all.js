// Dump ALL rows from a sheet so we can see SAOD entries too.
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.argv[2], { cellDates: false });
const sh = wb.Sheets[process.argv[3]];
const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
console.log(`Sheet "${process.argv[3]}" — ${aoa.length} rows`);
console.log('Header:', (aoa[0] || []).map((c, i) => `[${i}]${c}`).join(' | '));
console.log('---');
for (let r = 1; r < aoa.length; r++) {
  const row = (aoa[r] || []).map(c => String(c).slice(0, 30));
  console.log(`row ${r}: ${row.join(' | ')}`);
}
const distinctSection = [...new Set((aoa.slice(1) || []).map(r => String((r || [])[3] || '').trim()).filter(Boolean))];
console.log('\nDistinct Section Text values:', distinctSection);
const distinctBT = [...new Set((aoa.slice(1) || []).map(r => String((r || [])[2] || '').trim()).filter(Boolean))];
console.log('Distinct Business Type values:', distinctBT);
