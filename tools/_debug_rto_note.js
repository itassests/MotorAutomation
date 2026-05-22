// Debug: extract the parseRtoOverrideNotes function from each engine and
// run it directly on the Royal CV file's AP and Pan India CV STP sheets.
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const wb = XLSX.readFile(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_cv.xlsx'), { cellDates: false });

// Inline copy of the regex used in both engines
const re = /\b([A-Za-z][A-Za-z &-]{0,40}?)\s*RTO['’s]*\s*[-:]\s*((?:[A-Z]{2}\d{1,3})(?:\s*,\s*[A-Z]{2}\d{1,3}){0,30})/i;

for (const sheet of ['AP', 'Pan India -CV STP']) {
  const sh = wb.Sheets[sheet];
  if (!sh) { console.log(`[${sheet}] not found`); continue; }
  const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' });
  console.log(`\n=== ${sheet} ===`);
  const map = new Map();
  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < row.length; c++) {
      const s = String(row[c] || '');
      if (!s) continue;
      const m = s.match(re);
      if (m) {
        console.log(`  hit r${r}c${c}: name="${m[1]}", codes="${m[2]}"`);
        const name = m[1].replace(/\s+/g, ' ').trim().toLowerCase().replace(/^(?:the|for|of)\s+/i, '');
        const codes = m[2].split(/\s*,\s*/).map(c => c.trim().toUpperCase()).filter(Boolean);
        map.set(name, codes);
      }
    }
  }
  console.log('  Final map:', [...map.entries()]);
}
