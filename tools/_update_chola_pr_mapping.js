// Update the Chola column in pr_mapping.xlsx with April-format headers.
// Each cell uses "old|new" so both old and April formats resolve.

const xlsx = require('xlsx');
const path = require('path');

const file = path.join(__dirname, '..', 'config', 'pr_mapping', 'pr_mapping.xlsx');
const CHOLA_COL = 9; // index from /api/pr/insurers

// SysCol → new value to write into the Chola column.
// Pipe-separated alternatives let a single cell match either old or new
// PR headers without breaking previously-working uploads.
const updates = {
  'PolicyNo':         'Policy No|POLICY_NUMBER',
  'PolicyIssuedDate': 'Issue Date|ISSUE_DATE',
  'NameofCustomer':   'Customer name|CLIENT_NAME',
  'Reg_No':           'Regist_NO|REGISTRATION_NO',
  'Vehicle_Make':     'Make|MAKE',
  'Vehicle_Model':    'Model|MODEL',
  'Engine_No':        'Engine No|ENGINE_NO',
  'Chassis_No':       'Chassis No|CHASSIS_NO',
  'CC':               'Cubic Capacity|CUBIC_CAPACITY',
  'Tonnage':          'Gross Vehicle Weight (GVW)|GROSS_VEHICLE_WEIGHT',
  'Seating':          'Total Seating Capacity|TOTAL_SEATING_CAPACITY',
  'FuelType':         'Fuel Type|FUEL',
  'ManufacturingYear':'MFG Year|YEAR_OF_MANUFACTURE',
  'SumInsured':       'POLICY_SUM_INSURED',
  'NCB':              'NCB_PERCENT',
  'Vehicle':          'Vehicle Type|VEHICLE_TYPE_CC',
  'VehicleCategory':  'VEHICLE_SUB_CLASS|SUB_CLASS|VEHICLE_CATEGORY',
  'PlanName':         'PRODUCT_NAME',
  'TotalODPremium':   'Net OD Premium|NET_OD_PREMIUM',
  'TPPremium':        'Third Party Liability|TP_PREMIUM',
  'NetAmount':        'Net Premium|NET_PREMIUM',
  'GSt':              'Services Tax|SERVICE_TAX_AMOUNT',
  'GrossAmount':      'Gross Premium|GROSS_PREMIUM',
  'PACover':          'PA cover|PA_PREMIUM',
  'ODStartDate':      'RSD',
  'ODEndDate':        'RED',
  'TPStartDate':      'RSD',
  'TPEndDate':        'RED',
};

const wb = xlsx.readFile(file, { cellDates: false, cellStyles: true });
const sheetName = wb.SheetNames[0];
const sheet = wb.Sheets[sheetName];
const aoa = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

let changed = 0;
for (let r = 1; r < aoa.length; r++) {
  const sys = String(aoa[r][1] || '').trim();
  if (!sys) continue;
  if (Object.prototype.hasOwnProperty.call(updates, sys)) {
    const newVal = updates[sys];
    const cellRef = xlsx.utils.encode_cell({ r, c: CHOLA_COL });
    const oldVal = String((sheet[cellRef] && sheet[cellRef].v) || '').trim();
    if (oldVal !== newVal) {
      sheet[cellRef] = { t: 's', v: newVal };
      console.log(`r${r} [${sys}] "${oldVal}" → "${newVal}"`);
      changed++;
    }
  }
}

// Extend used range if needed
const range = xlsx.utils.decode_range(sheet['!ref']);
if (range.e.c < CHOLA_COL) {
  range.e.c = CHOLA_COL;
  sheet['!ref'] = xlsx.utils.encode_range(range);
}

xlsx.writeFile(wb, file);
console.log(`\nUpdated ${changed} cells in ${sheetName}.`);
