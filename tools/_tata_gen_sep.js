const fs = require('fs'), path = require('path');
const XLSX = require('xlsx');
const D = "D:/Motor_Payout/FY 26-27_New/Sept'26/TATA";
const fn = fs.readdirSync(D).find((f) => /Standard.*Grid.*Communication/i.test(f));
const wb = XLSX.readFile(path.join(D, fn));
const numv = (v) => { const n = Number(String(v).replace(/[%,]/g, '')); return Number.isFinite(n) ? n : null; };

// ---- CAR: "Pvtcar" sheet (regex columns; robust to the extra Segment col) ----
{
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Pvtcar'], { header: 1, defval: '' });
  const H = rows[0].map((c) => String(c).trim().toLowerCase());
  const ci = (re) => H.findIndex((h) => re.test(h));
  const cBiz = ci(/business/), cSec = ci(/section/), cFuel = ci(/fuel/), cRto = ci(/^rto$/), cNcb = ci(/ncb/);
  const cOD = ci(/(approval|grid).*od/), cTP = ci(/(approval|grid).*tp/);
  const grid = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const biz = String(r[cBiz] || '').trim(); if (!biz) continue;
    const section = String(r[cSec] || '').trim();
    const rate = /satp/i.test(section) ? numv(r[cTP]) : numv(r[cOD]);
    if (rate == null) continue;
    grid.push({ biz, section, fuel: String(r[cFuel] || '').trim() || 'All', rto: String(r[cRto] || '').trim() || 'All', ncb: String(r[cNcb] || '').trim() || 'All', rate });
  }
  fs.writeFileSync(path.join(__dirname, '..', 'config', 'tata_car_sep26.json'),
    JSON.stringify({ _source: fn + " sheet Pvtcar (Sep26)", _cols: 'biz/section/fuel/rto/ncb/rate', grid }));
  console.log('CAR grid rows:', grid.length, '| biz:', [...new Set(grid.map(g=>g.biz))].join(','), '| section:', [...new Set(grid.map(g=>g.section))].join(','));
  const jul = require('../config/tata_car_jul26.json').grid;
  const key = (g) => [g.biz, g.section, g.fuel, g.rto, g.ncb].join('|');
  const jm = new Map(jul.map((g) => [key(g), g.rate]));
  let ch=0,add=0; for (const g of grid){ const jr=jm.get(key(g)); if(jr===undefined)add++; else if(Math.abs(jr-g.rate)>0.001){ch++; if(ch<=6)console.log('  CAR CHANGED',key(g),'Jul',jr,'->Sep',g.rate);} }
  console.log('CAR vs July: changed',ch,'added',add);
}

// ---- CV: "CV" sheet (header row where col1=='Segment', regions from col5) ----
{
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['CV'], { header: 1, defval: '' });
  let hr = -1; for (let i = 0; i < 12; i++) { if (String((rows[i]||[])[1]).trim().toLowerCase() === 'segment') { hr = i; break; } }
  const H = rows[hr];
  const regions = []; for (let c = 5; c < H.length; c++) { const rn = String(H[c]).trim(); if (rn) regions.push({ col: c, name: rn }); }
  const cvnum = (v) => { const n = Number(String(v).replace(/[%,]/g, '')); return Number.isFinite(n) ? n : 0; };
  const out = [];
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const seg = String(r[1] || '').trim(); if (!seg) continue;
    const rates = {}; for (const rc of regions) rates[rc.name] = cvnum(r[rc.col]);
    out.push({ seg, fuel: String(r[2] || '').trim() || 'All', section: String(r[3] || '').trim(), age: String(r[4] || '').trim(), rates });
  }
  fs.writeFileSync(path.join(__dirname, '..', 'config', 'tata_cv_sep26.json'),
    JSON.stringify({ _source: fn + " sheet CV (Sep26)", regions: regions.map((r) => r.name), rows: out }));
  console.log('CV rows:', out.length, '| regions:', regions.length);
  const jul = require('../config/tata_cv_jul26.json').rows;
  const key = (r) => [r.seg, r.fuel, r.section, r.age].join('|');
  const jm = new Map(jul.map((r) => [key(r), r.rates]));
  let cr=0,cc=0,nr=0; for (const r of out){ const jr=jm.get(key(r)); if(!jr){nr++;continue;} let x=0; for(const reg in r.rates) if(Math.abs((jr[reg]||0)-r.rates[reg])>0.001)x++; if(x){cr++;cc+=x;} }
  console.log('CV vs July:',cr,'rows changed ('+cc+' cells),',nr,'new rows');
}
