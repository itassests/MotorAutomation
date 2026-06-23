/**
 * Kshema General Insurance — June'26 grid.
 *
 * Two sheets:
 *   - "Pvt car mapping": State Code | State Name | Status
 *       Status ∈ {preferred, Non Preferred, declined} — per-state status used
 *       ONLY for Private Car.
 *   - "Grid": State | Segment | COA%
 *       · GCV/PCV segment rows ("below 3.5T", "12T TO 43T", "3WL PCV") carry a
 *         rate per explicit state (states not listed = no payout).
 *       · Two Pvt Car rows — "Pvt Car (Preferred States)" and
 *         "Pvt Car (Non-Preferred States)" — give the Pvt Car rate, which we
 *         fan out across every state of that status from the mapping sheet.
 *         Declined states get an is_declined Pvt Car row (no payout).
 *
 * preprocessWorkbook reads the mapping sheet into workbookMeta so the Grid
 * parse can resolve preferred/non-preferred/declined states.
 */
const XLSX = require('xlsx');

// State code / name → canonical UPPERCASE state name.
const STATE_CANON = {
  AP: 'ANDHRA PRADESH', 'ANDHRA PRADESH': 'ANDHRA PRADESH',
  AR: 'ARUNACHAL PRADESH', 'ARUNACHAL PRADESH': 'ARUNACHAL PRADESH',
  AS: 'ASSAM', ASSAM: 'ASSAM',
  BR: 'BIHAR', BIHAR: 'BIHAR',
  CG: 'CHHATTISGARH', CHHATTISGARH: 'CHHATTISGARH', CHATTISGARH: 'CHHATTISGARH',
  GA: 'GOA', GOA: 'GOA',
  GJ: 'GUJARAT', GUJARAT: 'GUJARAT',
  HR: 'HARYANA', HARYANA: 'HARYANA',
  HP: 'HIMACHAL PRADESH', 'HIMACHAL PRADESH': 'HIMACHAL PRADESH',
  JH: 'JHARKHAND', JHARKHAND: 'JHARKHAND',
  KA: 'KARNATAKA', KARNATAKA: 'KARNATAKA',
  KL: 'KERALA', KERALA: 'KERALA',
  MP: 'MADHYA PRADESH', 'MADHYA PRADESH': 'MADHYA PRADESH',
  MH: 'MAHARASHTRA', MAHARASHTRA: 'MAHARASHTRA',
  MN: 'MANIPUR', MANIPUR: 'MANIPUR',
  ML: 'MEGHALAYA', MEGHALAYA: 'MEGHALAYA',
  MZ: 'MIZORAM', MIZORAM: 'MIZORAM',
  NL: 'NAGALAND', NAGALAND: 'NAGALAND',
  OD: 'ODISHA', OR: 'ODISHA', ODISHA: 'ODISHA', ORISSA: 'ODISHA',
  PB: 'PUNJAB', PUNJAB: 'PUNJAB',
  RJ: 'RAJASTHAN', RAJASTHAN: 'RAJASTHAN',
  SK: 'SIKKIM', SIKKIM: 'SIKKIM',
  TN: 'TAMIL NADU', 'TAMIL NADU': 'TAMIL NADU', TAMILNADU: 'TAMIL NADU',
  TS: 'TELANGANA', TG: 'TELANGANA', TELANGANA: 'TELANGANA', 'TELANGANA STATE': 'TELANGANA',
  TR: 'TRIPURA', TRIPURA: 'TRIPURA',
  UP: 'UTTAR PRADESH', 'UTTAR PRADESH': 'UTTAR PRADESH',
  UA: 'UTTARAKHAND', UK: 'UTTARAKHAND', UTTARAKHAND: 'UTTARAKHAND', UTTARANCHAL: 'UTTARAKHAND',
  WB: 'WEST BENGAL', 'WEST BENGAL': 'WEST BENGAL',
  AN: 'ANDAMAN & NICOBAR', CH: 'CHANDIGARH', CHANDIGARH: 'CHANDIGARH',
  DN: 'DADRA & NAGAR HAVELI', DD: 'DAMAN & DIU', DL: 'DELHI', DELHI: 'DELHI',
  JK: 'JAMMU & KASHMIR', LA: 'LADAKH', LD: 'LAKSHADWEEP', PY: 'PUDUCHERRY', PONDICHERRY: 'PUDUCHERRY',
};
const NE_STATES = ['ARUNACHAL PRADESH', 'ASSAM', 'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'NAGALAND', 'TRIPURA', 'SIKKIM'];

const canon = (s) => {
  const k = String(s || '').trim().toUpperCase();
  return STATE_CANON[k] || k;
};
const normStatus = (s) => {
  const t = String(s || '').trim().toLowerCase();
  if (/declin/.test(t)) return 'declined';
  if (/non[\s-]*prefer/.test(t)) return 'non_preferred';
  if (/prefer/.test(t)) return 'preferred';
  return null;
};

/** Read the "Pvt car mapping" sheet into workbookMeta.kshemaStatus = [{state,status}]. */
function preprocessWorkbook(workbook, insurerConfig, workbookMeta) {
  const sheetName = workbook.SheetNames.find(s => /pvt\s*car\s*mapping|mapping/i.test(s));
  if (!sheetName) return;
  const aoa = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  const list = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const code = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    const status = normStatus(row[2]);
    if (!status || (!code && !name)) continue;
    list.push({ state: canon(name || code), status });
  }
  workbookMeta.kshemaStatus = list;
}

// Grid GCV/PCV segment → product + band.
function segmentSpec(segRaw) {
  const s = String(segRaw || '').trim().toLowerCase();
  if (/pvt\s*car/.test(s)) return { product: 'CAR', segment: 'Pvt Car' };
  if (/3\s*wl|3w|3\s*wheel/.test(s)) return { product: 'PCV', segment: 'PCV 3W' };
  if (/below\s*3\.?5/.test(s)) return { product: 'GCV', segment: 'GCV', weight_band_min: 0, weight_band_max: 3.5 };
  if (/12\s*t.*43\s*t|12.*43/.test(s)) return { product: 'GCV', segment: 'GCV', weight_band_min: 12, weight_band_max: 43 };
  return { product: 'GCV', segment: 'GCV' };   // fallback: unknown GCV band
}

// Resolve a Grid state token to canonical state name(s) (handles APTS, NORTHEAST).
function resolveGridStates(raw) {
  const u = String(raw || '').trim().toUpperCase();
  if (/^APTS$/.test(u)) return ['ANDHRA PRADESH', 'TELANGANA'];
  if (/^NORTH\s*EAST$|^NORTHEAST$|^NE$/.test(u)) return NE_STATES.slice();
  return [canon(u)];
}

function parseRate(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const status = meta.kshemaStatus || [];
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row : 1;
  let pvtCarDeclinedEmitted = false;

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const stateRaw = String(row[0] || '').trim();
    const segRaw = String(row[1] || '').trim();
    const rate = parseRate(row[2]);
    if (!stateRaw || !segRaw) continue;
    const spec = segmentSpec(segRaw);

    if (spec.product === 'CAR') {
      // Pvt Car — fan across states of the matching status from the mapping sheet.
      const wantStatus = /non[\s-]*prefer/i.test(stateRaw) ? 'non_preferred'
        : /prefer/i.test(stateRaw) ? 'preferred' : null;
      if (rate == null || !wantStatus) continue;
      for (const st of status.filter(s => s.status === wantStatus)) {
        // COA% applies to TP-only policies too (user-confirmed) → emit COMP + SATP.
        for (const rtype of ['COMP', 'SATP']) {
          rules.push({
            product: 'CAR', sheet_name: meta.sheetName, region: st.state,
            segment: 'Pvt Car', make: 'All', rate_type: rtype, rate_value: rate,
            is_declined: false,
            rate_text: `Pvt Car | ${st.state} | ${wantStatus.replace('_', '-')}`,
          });
        }
      }
      // Emit declined Pvt Car rows once (no payout in declined states).
      if (!pvtCarDeclinedEmitted) {
        pvtCarDeclinedEmitted = true;
        for (const st of status.filter(s => s.status === 'declined')) {
          for (const rtype of ['COMP', 'SATP']) {
            rules.push({
              product: 'CAR', sheet_name: meta.sheetName, region: st.state,
              segment: 'Pvt Car', make: 'All', rate_type: rtype, rate_value: null,
              is_declined: true, rate_text: `Pvt Car | ${st.state} | declined`,
            });
          }
        }
      }
      continue;
    }

    // GCV / PCV — one rule per resolved state.
    if (rate == null) continue;
    for (const stName of resolveGridStates(stateRaw)) {
      // COA% applies to TP-only policies too (user-confirmed) → emit COMP + SATP.
      for (const rtype of ['COMP', 'SATP']) {
        rules.push({
          product: spec.product, sheet_name: meta.sheetName, region: stName,
          segment: spec.segment, make: 'All', rate_type: rtype, rate_value: rate,
          weight_band_min: spec.weight_band_min ?? null,
          weight_band_max: spec.weight_band_max ?? null,
          is_declined: false,
          rate_text: `${spec.segment} | ${stName} | ${segRaw}`,
        });
      }
    }
  }
  return rules;
}

module.exports = { parse, preprocessWorkbook, STATE_CANON };
