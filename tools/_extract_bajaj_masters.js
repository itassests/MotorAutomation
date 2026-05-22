/**
 * Extract Bajaj master tables (pincode → state, RTO-prefix → state,
 * HEV makes) from the Robinhood file as JSON constants we can embed in
 * the bajaj_robinhood engine.
 */
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const dir = "D:/Motor_Payout/April26/Ritesh Sir/Bajaj/April'26/Grid";
const robinhood = fs.readdirSync(dir).find(f => /Robinhood/i.test(f));
const wb = XLSX.readFile(path.join(dir, robinhood));

// 1. HEV Treaty makes — make → array of models ('ALL' = any)
const hevSheet = XLSX.utils.sheet_to_json(wb.Sheets['List of HEV Treaty Makes'], { header: 1, defval: '' });
const hev = {};
for (let i = 3; i < hevSheet.length; i++) {  // header at row 2
  const row = hevSheet[i] || [];
  const make  = String(row[0] || '').trim();
  const model = String(row[1] || '').trim();
  if (!make) continue;
  if (!hev[make]) hev[make] = [];
  hev[make].push(model);
}
console.log('// --- HEV makes/models ---');
console.log('const HEV_TREATY = ' + JSON.stringify(hev, null, 2) + ';');

// 2. RTO-prefix → CV Grid State
const cvRto = XLSX.utils.sheet_to_json(wb.Sheets['Pin code for CV(old)'], { header: 1, defval: '' });
const cvMap = {};
for (let i = 1; i < cvRto.length; i++) {
  const code  = String(cvRto[i][0] || '').trim();
  const state = String(cvRto[i][2] || '').trim();
  if (code && state && state !== 'CV Grid State') cvMap[code] = state;
}
console.log('\n// --- RTO-prefix → CV grid state (' + Object.keys(cvMap).length + ' entries) ---');
console.log('// First 8 sample:', Object.fromEntries(Object.entries(cvMap).slice(0, 8)));

// 3. RTO-prefix → TW Grid State
const twRto = XLSX.utils.sheet_to_json(wb.Sheets['Pin code for old Pvt( TW & car)'], { header: 1, defval: '' });
const twMap = {};
for (let i = 1; i < twRto.length; i++) {
  const code  = String(twRto[i][0] || '').trim();
  const state = String(twRto[i][2] || '').trim();
  if (code && state && state !== 'TW Grid State') twMap[code] = state;
}
console.log('// --- RTO-prefix → TW grid state (' + Object.keys(twMap).length + ' entries) ---');
console.log('// First 8 sample:', Object.fromEntries(Object.entries(twMap).slice(0, 8)));

// 4. Pincode → District/State (sample only — too large to embed, will be
// a separate JSON file or queried on demand)
const pinSheet = XLSX.utils.sheet_to_json(wb.Sheets['Pincode wise New TW & Pvt car'], { header: 1, defval: '' });
console.log('\n// Pincode master (' + (pinSheet.length - 3) + ' rows) — will be persisted as separate JSON');
console.log('// Sample first 3:');
for (let i = 3; i < 6; i++) console.log('//   ', JSON.stringify(pinSheet[i].slice(0, 3)));

// Write masters to a JSON file
const out = {
  hev_treaty: hev,
  rto_prefix_to_cv_state: cvMap,
  rto_prefix_to_tw_state: twMap,
};
const outPath = path.join(__dirname, '..', 'config', 'bajaj-masters.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('\nWrote masters to:', outPath);
