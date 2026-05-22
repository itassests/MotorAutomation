const wb = require('xlsx').readFile('uploads/royal_in/royal_other.xlsx', { cellDates: false });
const re = /^school[\s_]*bus$/i;
const target = wb.SheetNames.find(n => re.test(n));
// Try reading with raw values
const aoa = require('xlsx').utils.sheet_to_json(wb.Sheets[target], { header: 1, defval: '', raw: true });
const widths = aoa.map(r => (r || []).length);
console.log(`Sheet "${target}" — ${aoa.length} rows; row widths min=${Math.min(...widths)} max=${Math.max(...widths)}`);
for (let r = 0; r < Math.min(8, aoa.length); r++) {
  const row = aoa[r] || [];
  console.log(`r${r} (len=${row.length}):`);
  for (let i = 0; i < Math.max(15, row.length); i++) {
    const v = row[i];
    if (v === '' || v === null || v === undefined) continue;
    console.log(`  [${i}] type=${typeof v} val="${String(v).slice(0, 100)}"`);
  }
}
// Also check the worksheet's !ref
const sh = wb.Sheets[target];
console.log(`!ref: ${sh['!ref']}`);
