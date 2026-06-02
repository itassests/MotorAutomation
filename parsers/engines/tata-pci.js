/**
 * TATA AIG "PCI" sheet engine — the standard Pvt Car Package / SAOD national
 * grid. Flat layout with a single OD rate column (whole-number percent) keyed
 * by Business Type + Section (Package/SAOD) + Fuel + NCB(Yes/No):
 *
 *   LOB | Business Type | Section Text | Fuel Type | RTO | NCB | OD Grid | TP Grid
 *   PvtCar | Renewal | Package | Diesel | All | Yes | 28 | 0
 *   PvtCar | Renewal | Package | Diesel | All | No  | 19.5 | 0
 *
 * Rates are national (RTO = "All") and stored as whole-number percentages, so
 * region is emitted as the PAN INDIA sentinel and rate_value is divided by 100.
 *
 * Config:
 *   { layout: 'tata_pci', product: 'CAR',
 *     config: { data_start_row, col: { business_type, section, fuel, ncb, od_rate } } }
 */
const { cleanString } = require('../utils/normalizer');

const NATIONAL_REGION = 'PAN INDIA';

function parse(sheetData, sheetConfig, meta) {
  const rules = [];
  const cfg = sheetConfig.config || sheetConfig;
  const dataStart = cfg.data_start_row != null ? cfg.data_start_row : 1;
  const C = cfg.col || { business_type: 1, section: 2, fuel: 3, ncb: 5, od_rate: 6 };

  const normFuel = (f) => {
    const s = cleanString(f).toLowerCase();
    if (!s || s === 'all') return null;                 // wildcard
    if (/diesel/.test(s) && !/other/.test(s)) return 'Diesel';
    if (/cng|lpg|bifuel/.test(s)) return 'CNG';
    if (/electric|ev|battery/.test(s)) return 'Electric';
    if (/petrol/.test(s)) return 'Petrol';
    if (/other\s*than\s*diesel/.test(s)) return 'Other Than Diesel';
    return cleanString(f);
  };

  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const bt      = cleanString(row[C.business_type]);
    const section = cleanString(row[C.section]);
    if (!bt || !section) continue;

    const fuel = normFuel(row[C.fuel]);
    const ncbRaw = cleanString(row[C.ncb]).toLowerCase();
    const rateRaw = row[C.od_rate];
    const rateNum = parseFloat(String(rateRaw).replace(/[%,\s]/g, ''));
    if (!Number.isFinite(rateNum) || rateNum <= 0) continue;   // skip blanks / 0 / TP-only
    const rate = +(rateNum / 100).toFixed(6);                  // whole % → decimal

    // Section → product/rate_type. "Package" = Comprehensive (OD+TP);
    // "SAOD" = standalone own-damage.
    const sec = section.toLowerCase();
    const rateType = /saod/.test(sec) ? 'SAOD' : 'COMP';

    // Business type → vehicle age band + sub_type label.
    const btLower = bt.toLowerCase();
    let ageMin = 1, ageMax = 99, subType = bt;
    if (/brand\s*new|^new$/.test(btLower)) { ageMin = 0; ageMax = 0; subType = 'Brand New'; }
    else if (/rollover/.test(btLower))     { subType = 'Rollover'; }
    else if (/renewal/.test(btLower))      { subType = 'Renewal'; }

    // NCB band → remarks tag (read by the NCB-band smart filter). Yes = NCB
    // 1-99, No = NCB = 0, All = applies to both (no tag).
    let ncbTag = '';
    if (ncbRaw === 'yes' || ncbRaw === 'y') ncbTag = ' | NCB 1-99';
    else if (ncbRaw === 'no' || ncbRaw === 'n') ncbTag = ' | NCB = 0';

    rules.push({
      insurer: meta.insurer,
      product: 'CAR',
      sheet_name: meta.sheetName,
      region: NATIONAL_REGION,
      segment: 'Pvt Car',
      make: 'All',
      model: '',
      sub_type: subType,
      fuel_type: fuel,
      vehicle_age_min: ageMin,
      vehicle_age_max: ageMax,
      rate_type: rateType,
      rate_value: rate,
      is_declined: false,
      applied_on: rateType === 'SAOD' ? 'OD' : 'NET',
      remarks: `PCI | Pvt Car ${section} | ${bt}${ncbTag}`,
      is_conditional: false,
    });
  }
  return rules;
}

module.exports = { parse, NATIONAL_REGION };
