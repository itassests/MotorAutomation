// For each sheet+headerRow, print last non-blank col index in that row.
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.argv[2], { cellDates: false });
const args = process.argv.slice(3); // pairs: sheet headerRow
for (let i = 0; i < args.length; i += 2) {
  const sheet = args[i], hr = parseInt(args[i + 1], 10);
  const sh = wb.Sheets[sheet];
  if (!sh) { console.log(`${sheet}: NOT FOUND`); continue; }
  const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  const row = aoa[hr] || [];
  let last = -1;
  for (let c = 0; c < row.length; c++) {
    if (String(row[c]).trim()) last = c;
  }
  // Show non-blank header columns from last 10
  const tail = [];
  for (let c = Math.max(0, last - 10); c <= last; c++) {
    const v = String(row[c]).trim();
    tail.push(`[${c}]${v.slice(0, 18)}`);
  }
  console.log(`${sheet} (hr ${hr}): last non-blank col = ${last}; tail = ${tail.join(' ')}`);
}
