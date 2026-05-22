require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
const { buildExportBuffer } = require('../services/excel-export');
const XLSX = require('xlsx');

(async () => {
  const p = await getPool();
  const r = await p.request().query(`SELECT id FROM rate_cards WHERE insurer='universal_sompo' ORDER BY id DESC`);
  const ids = r.recordset.map(x => x.id);
  console.log('Card IDs:', ids);
  if (ids.length === 0) { console.log('no cards'); await close(); return; }

  const buf = await buildExportBuffer(ids);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const sheetIdx = aoa[0].indexOf('SheetName');
  console.log('Total Excel rows:', aoa.length - 1);
  const counts = {};
  for (let i = 1; i < aoa.length; i++) {
    const s = aoa[i][sheetIdx];
    counts[s || '(blank)'] = (counts[s || '(blank)']||0)+1;
  }
  console.log('Rows by SheetName:', counts);
  await close();
})().catch(e => { console.error(e); process.exit(1); });
