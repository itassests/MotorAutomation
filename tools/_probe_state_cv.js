// Print rows 0-4 of every sheet in a workbook (for state CV header detection)
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.argv[2], { cellDates: false });
const targetNames = process.argv.length > 3 ? process.argv.slice(3) : wb.SheetNames;
for (const name of targetNames) {
  const sh = wb.Sheets[name];
  if (!sh) { console.log(`[${name}] NOT FOUND`); continue; }
  const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  console.log(`\n=== ${name} (rows ${aoa.length}) ===`);
  for (let r = 0; r < Math.min(5, aoa.length); r++) {
    const row = aoa[r] || [];
    const tonRow = row.some(c => /^\s*\d+(\.\d+)?\s*(?:to|-)\s*\d+(\.\d+)?\s*$/i.test(String(c).trim()));
    const hasState = String(row[0] || '').toLowerCase().includes('state');
    const tag = tonRow ? '[TONNAGE]' : (hasState ? '[KEY]' : '');
    const parts = row.slice(0, 12).map((c, i) => `[${i}]${String(c).slice(0, 20).replace(/\n/g, ' ')}`).filter(s => !/\[\d+\]\s*$/.test(s));
    console.log(`r${r} ${tag}: ${parts.join(' | ')}`);
  }
}
