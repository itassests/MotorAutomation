/**
 * Luca-format export — download all OUTGOING rates of all insurers in the
 * 35-column "Luca" layout. Only the commission RATE is exported (placed in
 * tp_commission_percentage / irdai_commission_percentage); income and margin
 * are deliberately NOT included.
 */
'use strict';

const XLSX = require('xlsx');
const { getPool } = require('../db/connection');
const ex = require('./excel-export');

const LUCA_HEADERS = [
  'id', 'name', 'insurers', 'year', 'month', 'products', 'coverage_type', 'ncb',
  'commission_on', 'tp_commission_percentage', 'irdai_commission_percentage',
  'slab', 'slab_on', 'is_slab_on_first_tenure', 'flat_commission',
  'excluded_vehicles', 'vehicle_make', 'vehicle_model', 'vehicle_cc',
  'vehicle_age', 'fuel_type', 'business_type', 'zones', 'included_states',
  'city', 'excluded_cities', 'included_rto', 'excluded_rto', 'sales_channel',
  'rule_type', 'cpa', 'commission_percent_on_total_commission', 'deduction',
  'discount_range', 'REMARK',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function lucaProduct(vt) {
  vt = String(vt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vt === 'CAR' || vt === '4W' || vt === 'PC' || vt === 'PVTCAR') return 'private_car';
  if (vt === 'TW' || vt === '2W' || vt === 'TWEV') return 'two_wheeler';
  if (vt === 'GCV') return 'gcv';
  if (vt === 'PCV') return 'pcv';
  if (vt === 'MISC' || vt === 'MIS') return 'miscellaneous';
  return vt.toLowerCase();
}

// Map our internal insurer slug → the short Luca insurer id (sample uses "hdfc").
// First token before the underscore covers most (hdfc_ergo→hdfc, tata_aig→tata,
// icici_lombard→icici …); multi-word govt insurers keep two tokens.
function lucaInsurer(slug) {
  const s = String(slug || '').toLowerCase().trim().replace(/\s+/g, '_');
  const KEEP_TWO = new Set(['new_india', 'united_india', 'go_digit']);
  const two = s.split('_').slice(0, 2).join('_');
  if (KEEP_TWO.has(two)) return two;
  return s.split('_')[0] || s;
}

// rate_value is stored as a fraction (0.275). Luca wants the % number (27.5).
function pct(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return +(n * 100).toFixed(3);
}

// NCB qualifier (TRUE / FALSE / blank) from the rate_type tag.
function lucaNcb(rateType) {
  const rt = String(rateType || '').toUpperCase();
  if (/NON[_\s-]*NCB|NCB\s*[:=]\s*(NONE|NO\b|ZERO|0)/.test(rt)) return 'FALSE';
  if (/NCB\s*[:=]\s*(GT0|YES|NCB)|\bWITH\s*NCB\b/.test(rt)) return 'TRUE';
  return '';
}

function band(min, max) {
  if (min == null && max == null) return '';
  return `${min == null ? '' : min}-${max == null ? '' : max}`;
}

/**
 * @param {number|number[]} ids  rate_card id(s) to export.
 * @returns {Promise<Buffer>} xlsx buffer in Luca layout.
 */
async function buildLucaBuffer(ids) {
  const idList = Array.isArray(ids) ? ids : [ids];
  const pool = await getPool();
  const rq = pool.request();
  rq.timeout = 600000;
  const ph = idList.map((id, i) => { rq.input('c' + i, id); return '@c' + i; });
  const result = await rq.query(`
    SELECT rr.insurer, rr.product, rr.sheet_name, rr.region, rr.segment, rr.make,
           rr.model, rr.sub_type, rr.fuel_type, rr.cc_band_min, rr.cc_band_max,
           rr.age_band_min, rr.age_band_max, rr.rate_type, rr.rate_value,
           rr.remarks, rr.state, rc.effective_from
    FROM rate_rules rr
    JOIN rate_cards rc ON rc.id = rr.rate_card_id
    WHERE rr.rate_card_id IN (${ph.join(',')})
      AND rr.rate_value IS NOT NULL`);

  const rows = [LUCA_HEADERS.slice()];
  let id = 1;
  for (const r of result.recordset) {
    const insurer = lucaInsurer(r.insurer || '');
    const vt = ex.inferVehicleType(r.sheet_name, r.product, r.segment, r.sub_type);
    const cover = ex.inferProduct(r.rate_type, r.sheet_name, r.sub_type, r.segment); // Comp / TP / SAOD
    const isTp = cover === 'TP';
    const rateP = pct(r.rate_value);
    const coverageType = cover === 'Comp' ? 'comprehensive,own_damage'
                       : cover === 'SAOD' ? 'own_damage' : 'liability';
    const d = r.effective_from ? new Date(r.effective_from) : null;
    const region = String(r.region || r.state || '').trim();

    rows.push([
      id++,                                                   // id
      (insurer + vt + (cover === 'Comp' ? 'PACKAGE' : cover.toUpperCase())).toUpperCase().replace(/[^A-Z0-9]/g, ''), // name
      insurer,                                                // insurers
      d ? d.getFullYear() : '',                               // year
      d ? MONTHS[d.getMonth()] : '',                          // month
      lucaProduct(vt),                                        // products
      coverageType,                                           // coverage_type
      lucaNcb(r.rate_type),                                   // ncb
      isTp ? 'TP' : 'OD',                                     // commission_on
      isTp ? rateP : '',                                      // tp_commission_percentage
      isTp ? '' : rateP,                                      // irdai_commission_percentage (the outgoing OD rate)
      '', '', '', '',                                         // slab, slab_on, is_slab_on_first_tenure, flat_commission
      '',                                                     // excluded_vehicles
      String(r.make || ''),                                   // vehicle_make
      String(r.model || ''),                                  // vehicle_model
      band(r.cc_band_min, r.cc_band_max),                     // vehicle_cc
      band(r.age_band_min, r.age_band_max),                   // vehicle_age
      String(r.fuel_type || ''),                              // fuel_type
      String(r.segment || ''),                                // business_type
      '',                                                     // zones
      region.toLowerCase(),                                   // included_states (best-effort: region)
      '',                                                     // city
      '',                                                     // excluded_cities
      '',                                                     // included_rto
      '',                                                     // excluded_rto
      'pos',                                                  // sales_channel
      'outgoing',                                             // rule_type
      '', '', '', '',                                         // cpa, commission_percent_on_total_commission, deduction, discount_range
      String(r.remarks || '').slice(0, 250),                 // REMARK
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

module.exports = { buildLucaBuffer, LUCA_HEADERS };
