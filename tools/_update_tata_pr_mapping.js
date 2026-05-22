// Update TATA column in pr_mapping.xlsx — fix two cells that previously
// contained English-language formulas (which couldn't resolve as column
// names) so the resolver can pick the actual TATA PR columns.

const xlsx = require('xlsx');
const path = require('path');

const file = path.join(__dirname, '..', 'config', 'pr_mapping', 'pr_mapping.xlsx');
const TATA_COL = 4;

const updates = {
  // TATA file has both 'basictp' and 'net_of_tp' (which is OD-side net).
  // Use basictp for TP premium directly.
  'TPPremium':  'basictp',
  // net_premium is the canonical TATA total-net column; some legacy
  // exports leave it blank in which case fallback to premiumamount.
  'NetAmount':  'net_premium|premiumamount',
};

const wb = xlsx.readFile(file, { cellDates: false, cellStyles: true });
const sheet = wb.Sheets[wb.SheetNames[0]];
const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

let changed = 0;
for (let r = 1; r < aoa.length; r++) {
  const sys = String(aoa[r][1] || '').trim();
  if (!Object.prototype.hasOwnProperty.call(updates, sys)) continue;
  const newVal = updates[sys];
  const cellRef = xlsx.utils.encode_cell({ r, c: TATA_COL });
  const oldVal = String((sheet[cellRef] && sheet[cellRef].v) || '').trim();
  if (oldVal !== newVal) {
    sheet[cellRef] = { t: 's', v: newVal };
    console.log(`r${r} [${sys}] "${oldVal}" → "${newVal}"`);
    changed++;
  }
}

xlsx.writeFile(wb, file);
console.log(`\nUpdated ${changed} cells.`);
