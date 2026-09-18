'use strict';
/**
 * Agent-rate grid generator. Reshapes the Luca OUTGOING rows (insurer × region ×
 * coverage × fuel × NCB × cc/age/make → rate) into the human-readable agent PDF
 * layout, one document per PRODUCT × REGION-group:
 *   Insurer | RTO/Region | Plan Name | Fuel Type | NCB | Condition | Rate% | State | OD/NET | Eff
 * Base grid only (per-agent overrides are a later layer). Renders via pdfmake.
 */
const XLSX = require('xlsx');
const { buildLucaBuffer } = require('./luca-export');

// LUCA insurer slug → agent-facing display name.
const DISPLAY = {
  'go-digit': 'Go Digit', 'cholamandalam': 'Chola', 'chola-ms': 'Chola', 'bajaj-allianz': 'Bajaj',
  'hdfc-ergo': 'HDFC ERGO', 'icici-lombard': 'Lombard', 'tata-aig': 'TATA AIG', 'iffco-tokio': 'IFFCO',
  'future-generali': 'Future Generali', 'sbi-general': 'SBI', 'shriram': 'Shriram', 'liberty': 'Liberty',
  'kotak': 'KOTAK', 'magma-hdi': 'Magma', 'royal-sundaram': 'Royal Sundaram', 'universal-sompo': 'Universal',
  'united-india': 'United India', 'oriental': 'Oriental', 'national': 'National', 'new-india': 'New India',
  'raheja-qbe': 'Raheja QBE', 'zuno': 'Zuno', 'kshema': 'Kshema', 'indusind': 'Reliance', 'acko': 'Acko', 'kiwi': 'KIWI',
};
const disp = (slug) => DISPLAY[String(slug || '').toLowerCase()] || String(slug || '');

// Product bucket → the agent-grid document a Luca `products` value belongs to.
const PRODUCT_GROUP = {
  private_car: 'Pvt Car Package', gcv: 'GCV', gcv_3w: 'GCV 3W', lcv: 'GCV', hcv: 'GCV',
  private_bike: 'Two Wheeler', scooter: 'Two Wheeler', pcv: 'PCV', auto: 'PCV 3W', bus: 'Bus',
  taxi: 'Taxi', tractor: 'Misc', misc: 'Misc',
};

// State-group definitions (which included_states belong to a region document).
const STATE_GROUPS = {
  'AP&TS': ['andhra_pradesh', 'telangana'],
  'MH': ['maharashtra', 'goa'],
  'GJ': ['gujarat', 'daman_and_diu', 'dadra_and_nagar_haveli'],
  'Karnataka': ['karnataka'], 'Kerala': ['kerala'], 'Tamil Nadu': ['tamil_nadu', 'puducherry'],
  'North': ['delhi', 'haryana', 'punjab', 'rajasthan', 'uttar_pradesh', 'uttarakhand', 'himachal_pradesh', 'jammu_and_kashmir', 'chandigarh'],
  'East': ['west_bengal', 'bihar', 'jharkhand', 'odisha', 'chhattisgarh', 'assam'],
  'MP': ['madhya_pradesh'],
};

const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const _parseBand = (v) => { const m = /^\[(\d+(?:\.\d+)?),(\d+(?:\.\d+)?|null)\]$/.exec(String(v || '')); return m ? [Number(m[1]), m[2] === 'null' ? null : Number(m[2])] : null; };

// coverage_type + segment/business_type → agent "Plan Name".
function planName(r, col) {
  const cov = String(r[col('coverage_type')] || '').toLowerCase();
  const bt = String(r[col('business_type')] || '').toLowerCase();
  const seg = String(r[col('REMARK')] || '').toLowerCase() + ' ' + String(r[col('vehicle_age')] || '');
  if (bt === 'used_car') return 'Used Car';
  if (/5\s*\+\s*5/.test(seg)) return 'Long Term Package (5+5)';
  if (/3\s*\+\s*3/.test(seg)) return 'Bundled 3+3';
  if (/1\s*\+\s*5/.test(seg)) return 'Bundled 1+5';
  if (cov === 'hybrid' || /1\s*\+\s*3|bundled/.test(seg)) return 'Bundled 1+3';
  if (cov === 'own_damage') return 'SAOD';
  if (cov === 'third_party') return 'SATP';
  if (cov === 'comprehensive') return 'Comprehensive 1+1';
  return cov ? cov.toUpperCase() : '-';
}
function ncbLabel(r, col) {
  const v = String(r[col('ncb')] || '').toUpperCase();
  if (v === 'TRUE') return 'With NCB';
  if (v === 'FALSE') return 'Without NCB';
  return '-';
}
function fuelLabel(r, col) {
  const f = String(r[col('fuel_type')] || '').trim();
  if (!f) return 'All Fuel Type';
  return { PETROL: 'Petrol', DIESEL: 'Diesel', ELECTRICITY: 'Electric', INTERNAL_LPG_CNG: 'CNG/LPG' }[f.toUpperCase()] || f;
}
function conditionText(r, col) {
  const bits = [];
  const cc = _parseBand(r[col('vehicle_cc')]);
  if (cc) bits.push(cc[0] <= 1 && cc[1] != null ? `CC Up to ${cc[1]}` : cc[1] == null ? `CC Above ${cc[0]}` : `CC ${cc[0]}-${cc[1]}`);
  const age = _parseBand(r[col('vehicle_age')]);
  if (age && !(age[0] === 0 && age[1] == null)) bits.push(age[1] == null ? `Age ${age[0]}+ yrs` : age[0] === age[1] ? `Age ${age[0]} yr` : `Age ${age[0]}-${age[1]} yrs`);
  const gvw = _parseBand(r[col('gross_vehicle_weight')]);
  if (gvw) bits.push(gvw[1] == null ? `GVW >${gvw[0]}kg` : `GVW ${gvw[0]}-${gvw[1]}kg`);
  const seat = _parseBand(r[col('seating_capacity')]);
  if (seat) bits.push(seat[1] == null ? `${seat[0]}+ seater` : `${seat[0]}-${seat[1]} seater`);
  const mk = String(r[col('vehicle_make')] || '').trim();
  const md = String(r[col('vehicle_model')] || '').trim();
  if (mk) bits.push(md ? `${mk} ${md}` : mk);
  return bits.join(', ') || '-';
}
function regionLabel(r, col) {
  const rto = String(r[col('included_rto')] || '').trim();
  const city = String(r[col('city')] || '').trim();
  const st = String(r[col('included_states')] || '').trim();
  if (city) return city.length > 60 ? city.slice(0, 57) + '…' : city;
  if (rto) return rto.length > 60 ? rto.split(',').length + ' RTOs' : rto;
  if (st) return st.split(',').map(s => s.replace(/_/g, ' ')).join(', ');
  return 'Pan India';
}

/** Build agent-grid row objects for one product-group × state-group from Luca rows. */
function buildAgentRows(lucaRows, productGroup, stateSlugs) {
  const h = lucaRows[0]; const col = (n) => h.indexOf(n);
  const pI = col('products'), stI = col('included_states'), icI = col('irdai_commission_percentage'), coI = col('commission_on'), mI = col('month');
  const allStates = !stateSlugs || !stateSlugs.length;   // null/empty → every region
  const stateSet = new Set(stateSlugs || []);
  const out = [];
  for (const r of lucaRows.slice(1)) {
    if (PRODUCT_GROUP[String(r[pI] || '')] !== productGroup) continue;
    const states = String(r[stI] || '').split(',').map(s => s.trim()).filter(Boolean);
    const isPanIndia = states.length === 0;
    const inGroup = allStates || isPanIndia || states.some(s => stateSet.has(s));
    if (!inGroup) continue;
    const rate = _num(r[icI]);
    if (rate == null) continue;
    out.push({
      insurer: disp(r[col('insurers')]),
      region: regionLabel(r, col),
      plan: planName(r, col),
      fuel: fuelLabel(r, col),
      ncb: ncbLabel(r, col),
      condition: conditionText(r, col),
      rate,
      state: isPanIndia ? 'Pan India' : states.map(s => s.replace(/_/g, ' ')).join('/'),
      onPay: String(r[coI] || 'OD'),
      eff: (r[mI] || '') + ' 1st',
    });
  }
  // sort: insurer, plan, region
  out.sort((a, b) => a.insurer.localeCompare(b.insurer) || a.plan.localeCompare(b.plan) || a.region.localeCompare(b.region));
  return out;
}

// ---- PDF rendering (pdfkit — bundled standard Helvetica, no font files) ----
const COLS = [
  { k: 'insurer', h: 'Insurer', w: 58 }, { k: 'region', h: 'RTO / Region', w: 150 },
  { k: 'plan', h: 'Plan Name', w: 88 }, { k: 'fuel', h: 'Fuel', w: 52 },
  { k: 'ncb', h: 'NCB', w: 42 }, { k: 'condition', h: 'Condition', w: 196 },
  { k: 'rate', h: 'Rate%', w: 30, c: true }, { k: 'state', h: 'State', w: 66 },
  { k: 'onPay', h: 'Pay', w: 26, c: true }, { k: 'eff', h: 'Eff', w: 40 },
];
const fit = (doc, s, w) => {   // truncate to width with an ellipsis
  s = String(s == null ? '' : s);
  if (doc.widthOfString(s) <= w) return s;
  while (s.length > 1 && doc.widthOfString(s + '…') > w) s = s.slice(0, -1);
  return s + '…';
};
/**
 * Render an agent-grid PDF (Buffer). title e.g. "AP&TS Pvt Car Package 1st Aug'26";
 * guidelines = note strings (page 1); rows = buildAgentRows() output.
 */
function renderAgentGridPdf(title, guidelines, rows) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 16 });
  const chunks = [];
  const done = new Promise((resolve, reject) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const left = 16, top = 16, bottom = doc.page.height - 20;
  const totalW = COLS.reduce((a, c) => a + c.w, 0);
  const rowH = 12, headH = 14, fs = 6.5;

  const drawTitle = () => { doc.font('Helvetica-Bold').fontSize(12).fillColor('#003366').text(title, left, top, { width: totalW, align: 'center' }); doc.fillColor('black'); };
  const drawHeader = (y) => {
    doc.rect(left, y, totalW, headH).fill('#003366');
    doc.font('Helvetica-Bold').fontSize(fs).fillColor('white');
    let x = left;
    for (const c of COLS) { doc.text(c.h, x + 2, y + 3.5, { width: c.w - 4, align: c.c ? 'center' : 'left', lineBreak: false }); x += c.w; }
    doc.fillColor('black').font('Helvetica');
    return y + headH;
  };

  // Page 1: guidelines
  drawTitle();
  let y = top + 20;
  if (guidelines && guidelines.length) {
    doc.font('Helvetica-Bold').fontSize(9).text('Guidelines — check RTO Master & conditions before booking', left, y); y += 16;
    doc.font('Helvetica').fontSize(8);
    for (const g of guidelines) { doc.text('•  ' + g, left, y, { width: totalW }); y = doc.y + 4; }
    doc.addPage(); drawTitle(); y = top + 20;
  }
  y = drawHeader(y);

  doc.fontSize(fs);
  let i = 0;
  for (const r of rows) {
    if (y + rowH > bottom) { doc.addPage(); drawTitle(); y = drawHeader(top + 20); doc.fontSize(fs); }
    if (i % 2 === 1) doc.rect(left, y, totalW, rowH).fill('#eef3f9').fillColor('black');
    let x = left;
    for (const c of COLS) {
      const val = c.k === 'rate' ? String(r.rate) : r[c.k];
      doc.font(c.c ? 'Helvetica-Bold' : 'Helvetica').fillColor('black')
        .text(fit(doc, val, c.w - 4), x + 2, y + 3, { width: c.w - 4, align: c.c ? 'center' : 'left', lineBreak: false });
      x += c.w;
    }
    y += rowH; i++;
  }
  doc.end();
  return done;
}

// ---- Per-agent override layer ----
// config/agent_overrides.json: { <agentCode>: { name, overrides:[{product,insurer,plan,
// fuel,ncb,region,rate,add?,note}] } }. A base row is matched by insurer/product/plan/
// fuel/ncb/region ('*' = any; region matches the row's region OR state, substring) and
// its rate REPLACED. `add:true` appends a row the base grid doesn't have. An agent with
// no matching overrides falls back to the base grid.
function loadAgentOverrides() {
  try { return require('../config/agent_overrides.json') || {}; } catch (_) { return {}; }
}
function agentsWithOverrides() {
  const cfg = loadAgentOverrides();
  return Object.keys(cfg).filter((k) => !k.startsWith('_') && Array.isArray(cfg[k].overrides) && cfg[k].overrides.length);
}
const _wild = (pat, val) => { const p = String(pat == null ? '*' : pat).trim(); if (p === '*' || p === '') return true; return String(val || '').toLowerCase().includes(p.toLowerCase()); };
/**
 * Apply an agent's overrides to base agent rows (for one product group). Returns
 * { rows, applied }. `applied` is false when the agent has no override touching this set
 * (caller then uses the base grid / skips a separate sheet).
 */
function applyAgentOverrides(rows, agentCode, productGroup) {
  const cfg = loadAgentOverrides();
  const a = cfg[agentCode];
  if (!a || !Array.isArray(a.overrides)) return { rows, applied: false };
  const ovs = a.overrides.filter((o) => _wild(o.product, productGroup));
  if (!ovs.length) return { rows, applied: false };
  let applied = false;
  const out = rows.map((r) => {
    for (const o of ovs) {
      if (_wild(o.insurer, r.insurer) && _wild(o.plan, r.plan) && _wild(o.fuel, r.fuel)
        && _wild(o.ncb, r.ncb) && (_wild(o.region, r.region) || _wild(o.region, r.state))) {
        applied = true;
        return { ...r, rate: o.rate, condition: (r.condition && r.condition !== '-' ? r.condition + ' | ' : '') + `AGENT ${agentCode}${o.note ? ' (' + o.note + ')' : ''}` };
      }
    }
    return r;
  });
  for (const o of ovs.filter((x) => x.add)) {   // explicit additions
    applied = true;
    out.push({ insurer: o.insurer || '-', region: o.region === '*' ? 'Pan India' : (o.region || '-'), plan: o.plan || '-', fuel: o.fuel === '*' ? 'All Fuel Type' : (o.fuel || '-'), ncb: o.ncb === '*' ? '-' : (o.ncb || '-'), condition: `AGENT ${agentCode}${o.note ? ' (' + o.note + ')' : ''}`, rate: o.rate, state: o.region || 'Pan India', onPay: 'OD', eff: '' });
  }
  return { rows: out, applied };
}

module.exports = { buildAgentRows, renderAgentGridPdf, applyAgentOverrides, agentsWithOverrides, PRODUCT_GROUP, STATE_GROUPS, disp };
