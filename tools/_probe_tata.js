/**
 * Probe TATA workbooks. Path passed via argv[2] avoids JS string-escape
 * gotchas with apostrophes and commas in the workbook names.
 */
const XLSX = require('xlsx');
function summarise(file) {
  console.log('\n================================================================');
  console.log(file);
  console.log('================================================================');
  let wb;
  try { wb = XLSX.readFile(file, { cellDates: false }); }
  catch (e) { console.log('  READ FAIL:', e.message); return; }
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const rows = aoa.length;
    if (rows === 0) { console.log(`  [${name}] (empty)`); continue; }
    let headerRow = 0;
    for (let i = 0; i < Math.min(15, aoa.length); i++) {
      const nonEmpty = aoa[i].filter(c => c !== '' && c != null).length;
      if (nonEmpty >= 3) { headerRow = i; break; }
    }
    const cols = (aoa[headerRow] || []).map((c, idx) => ({ idx, name: String(c).trim() })).filter(c => c.name);
    console.log(`\n  --- ${name} (${rows} rows, header row idx ${headerRow}) ---`);
    console.log(`  cols (${cols.length}):`);
    for (const c of cols) console.log(`    [${c.idx}] ${c.name}`);
    const dataStart = headerRow + 1;
    for (let i = dataStart; i < Math.min(dataStart + 2, aoa.length); i++) {
      const sample = (aoa[i] || []).slice(0, 14).map(v => String(v).slice(0, 30));
      console.log(`  sample row ${i}: [${sample.join(' | ')}]`);
    }
  }
}
const files = process.argv.slice(2);
for (const f of files) summarise(f);
