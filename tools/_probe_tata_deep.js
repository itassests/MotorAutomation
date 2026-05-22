/**
 * Deep TATA probe: dump full header rows for the pivot sheets so we can
 * lock down the city columns + DM/HOM split before writing the config.
 *
 * Usage: node tools/_probe_tata_deep.js <file> <sheet> [headerRowOverride]
 */
const XLSX = require('xlsx');
const file = process.argv[2];
const targetSheet = process.argv[3];
const headerOverride = process.argv[4] != null ? parseInt(process.argv[4], 10) : null;

const wb = XLSX.readFile(file, { cellDates: false });
const sheet = wb.Sheets[targetSheet];
if (!sheet) {
  console.log('Sheet not found. Available:', wb.SheetNames.join(' | '));
  process.exit(1);
}
const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
console.log(`Sheet "${targetSheet}" — rows: ${aoa.length}`);

// Print first 8 rows fully
console.log('\n---- first 8 rows (full) ----');
for (let r = 0; r < Math.min(8, aoa.length); r++) {
  const row = aoa[r];
  console.log(`row ${r} (len ${row.length}):`);
  row.forEach((c, i) => {
    const s = String(c).trim();
    if (s) console.log(`  [${i}] ${s.slice(0, 60)}`);
  });
}

// Pick header row
let headerRow = headerOverride;
if (headerRow == null) {
  for (let i = 0; i < Math.min(15, aoa.length); i++) {
    const nonEmpty = aoa[i].filter(c => c !== '' && c != null).length;
    if (nonEmpty >= 5) { headerRow = i; break; }
  }
}
console.log(`\n---- chosen header row: ${headerRow} ----`);
const header = aoa[headerRow] || [];
console.log(`header has ${header.length} columns; non-blank count: ${header.filter(c => String(c).trim()).length}`);

// Look 2 rows above header row for "DM"/"HOM" channel banner
for (let off = 1; off <= 3; off++) {
  const r = headerRow - off;
  if (r < 0) break;
  const row = aoa[r] || [];
  const banners = row.map((c, i) => ({ i, v: String(c).trim() })).filter(x => x.v);
  if (banners.length) {
    console.log(`\n  banner row ${r}:`);
    for (const b of banners) console.log(`    [${b.i}] ${b.v.slice(0, 50)}`);
  }
}

// Dump first 5 data rows
console.log(`\n---- first 5 data rows (cols 0-30 + last 5) ----`);
for (let r = headerRow + 1; r < Math.min(headerRow + 6, aoa.length); r++) {
  const row = aoa[r] || [];
  const head = row.slice(0, 30).map((v, i) => `[${i}]${String(v).slice(0, 12)}`).join(' ');
  console.log(`row ${r}: ${head}`);
}
