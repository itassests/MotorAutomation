// Scan all sheets in both Royal workbooks for "note-like" content —
// any non-blank cell after the first contiguous block of empty rows
// past the main data, plus any cell containing "Note" / "Pls" / "*" /
// "IRDA" / "Discount" / "Disc" markers.
const XLSX = require('xlsx');
const path = require('path');

function scan(file, label) {
  const wb = XLSX.readFile(file, { cellDates: false });
  console.log(`\n========== ${label} ==========`);
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    if (aoa.length === 0) continue;
    // Identify the last DATA row (last row with ≥3 non-empty cells).
    let lastData = -1;
    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const non = row.filter(c => String(c || '').trim()).length;
      if (non >= 3) lastData = r;
    }
    // Notes are any non-blank text below lastData OR matching keywords anywhere.
    const noteRows = [];
    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r] || [];
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c] || '').trim();
        if (!v) continue;
        const isAfterData = r > lastData;
        const isKeyword = /\b(?:Note|Notes|Pls|Please|IRDA|\*|disc|discount|applicab|exclu|exception)\b/i.test(v);
        if ((isAfterData || isKeyword) && v.length > 5) {
          noteRows.push({ r, c, v: v.slice(0, 200) });
        }
      }
    }
    if (noteRows.length === 0) continue;
    console.log(`\n--- [${name}] notes (lastData=r${lastData}) ---`);
    for (const n of noteRows) console.log(`  r${n.r}c${n.c}: ${n.v}`);
  }
}
scan(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_cv.xlsx'), 'royal_cv.xlsx');
scan(path.join(__dirname, '..', 'uploads', 'royal_in', 'royal_other.xlsx'), 'royal_other.xlsx');
