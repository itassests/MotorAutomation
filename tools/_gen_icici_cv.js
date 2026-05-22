// Generate ICICI CV_COMP and CV_AOTP rate_columns programmatically.
// Outputs JSON snippets to stdout; paste into config/insurers/icici_lombard.json.

const compSegments = [
  // [colIdx, sheet header, segment, vehicle_category, fuel, weight_min, weight_max, age_min, age_max]
  [1,  'GCV 3W New',                'GCV 3W (New)',                          '3W',           null, null, null, 0, 0],
  [2,  'GCV 3W Old',                'GCV 3W (Old)',                          '3W',           null, null, null, 1, null],
  [3,  'GCV 3W Electric',           'GCV 3W Electric',                       '3W',           'Electric', null, null, null, null],
  [4,  'SCV <2450 GVW New',         'SCV <2.45T GVW (New)',                  'SCV',          null, null, 2.45, 0, 0],
  [5,  'SCV <2450 GVW Old',         'SCV <2.45T GVW (Old)',                  'SCV',          null, null, 2.45, 1, null],
  [6,  'SCV >= 2450 GVW New',       'SCV >=2.45T GVW (New)',                 'SCV',          null, 2.45, null, 0, 0],
  [7,  'SCV >= 2450 GVW Old',       'SCV >=2.45T GVW (Old)',                 'SCV',          null, 2.45, null, 1, null],
  [8,  'LCV 3.5-7.5T',              'LCV 3.5-7.5T',                          'LCV',          null, 3.5,  7.5,  null, null],
  [9,  'LCV 7.5-12T',               'LCV 7.5-12T',                           'LCV',          null, 7.5,  12,   null, null],
  [10, 'MHCV 12-20T Tanker',        'MHCV 12-20T Tanker',                    'Tanker',       null, 12,   20,   null, null],
  [11, 'MHCV 12-20T Tipper',        'MHCV 12-20T Tipper',                    'Dumper/Tipper',null, 12,   20,   null, null],
  [12, 'MHCV 12-20T Truck',         'MHCV 12-20T Truck',                     'MHCV',         null, 12,   20,   null, null],
  [13, 'MHCV 20-40T Tanker',        'MHCV 20-40T Tanker',                    'Tanker',       null, 20,   40,   null, null],
  [14, 'MHCV 20-40T Tipper',        'MHCV 20-40T Tipper',                    'Dumper/Tipper',null, 20,   40,   null, null],
  [15, 'MHCV 20-40T Truck',         'MHCV 20-40T Truck',                     'MHCV',         null, 20,   40,   null, null],
  [16, 'MHCV 20-40T Trailer',       'MHCV 20-40T Trailer',                   'Trailer',      null, 20,   40,   null, null],
  [17, 'MHCV >40T Tanker',          'MHCV >40T Tanker',                      'Tanker',       null, 40,   null, null, null],
  [18, 'MHCV >40T Tipper/ Dumper',  'MHCV >40T Tipper/Dumper',               'Dumper/Tipper',null, 40,   null, null, null],
  [19, 'MHCV >40T Trailer',         'MHCV >40T Trailer',                     'Trailer',      null, 40,   null, null, null],
  [20, 'MHCV >40T Truck',           'MHCV >40T Truck',                       'MHCV',         null, 40,   null, null, null],
  [21, 'MIsc D CE',                 'Misc D CE (Excluding CRANES)',          'Misc D',       null, null, null, null, null],
  [22, 'Tractor New',               'Tractor (New)',                         'Tractor',      null, null, null, 0, 0],
  [23, 'Tractor Old',               'Tractor (Old)',                         'Tractor',      null, null, null, 1, null],
  [24, 'PCV 3W Petrol/CNG New',     'PCV 3W Petrol/CNG (New)',               '3W',           'Petrol/CNG', null, null, 0, 0],
  [25, 'PCV 3W Petrol/CNG Old',     'PCV 3W Petrol/CNG (Old)',               '3W',           'Petrol/CNG', null, null, 1, null],
  [26, 'PCV 3W Others (Diesel)',    'PCV 3W Diesel',                         '3W',           'Diesel', null, null, null, null],
  [27, 'PCV 3W Electric',           'PCV 3W Electric',                       '3W',           'Electric', null, null, null, null],
  [28, 'School Bus <18',            'School Bus <=18 Seater',                'School Bus',   null, null, null, null, null],
  [29, 'School Bus 18-36',          'School Bus 18-36 Seater',               'School Bus',   null, null, null, null, null],
  [30, 'School Bus >36',            'School Bus >36 Seater',                 'School Bus',   null, null, null, null, null],
  [31, 'Staff Bus >18',             'Staff Bus >18 Seater',                  'Staff Bus',    null, null, null, null, null],
  [32, 'PCVTAXI Electric',          'PCV Taxi Electric',                     'Taxi',         'Electric', null, null, null, null],
  [33, 'PCVTAXI <=1000CC',          'PCV Taxi <=1000CC',                     'Taxi',         null, null, null, null, null],
  [34, 'PCVTAXI >1000CC',           'PCV Taxi >1000CC',                      'Taxi',         null, null, null, null, null],
  [35, 'PCV(2W)',                   'PCV 2W',                                '2W',           null, null, null, null, null],
];

const aotpSegments = [
  [1,  'LCV 3.5-7.5T',              'LCV 3.5-7.5T',                          'LCV',          null, 3.5,  7.5,  null, null],
  [2,  'LCV 7.5-12T',               'LCV 7.5-12T',                           'LCV',          null, 7.5,  12,   null, null],
  [3,  'MHCV 12-20T Tanker',        'MHCV 12-20T Tanker',                    'Tanker',       null, 12,   20,   null, null],
  [4,  'MHCV 12-20T Tipper',        'MHCV 12-20T Tipper',                    'Dumper/Tipper',null, 12,   20,   null, null],
  [5,  'MHCV 12-20T Truck',         'MHCV 12-20T Truck',                     'MHCV',         null, 12,   20,   null, null],
  [6,  'MHCV 20-40T Tanker',        'MHCV 20-40T Tanker',                    'Tanker',       null, 20,   40,   null, null],
  [7,  'MHCV 20-40T Tipper',        'MHCV 20-40T Tipper',                    'Dumper/Tipper',null, 20,   40,   null, null],
  [8,  'MHCV 20-40T Truck',         'MHCV 20-40T Truck',                     'MHCV',         null, 20,   40,   null, null],
  [9,  'MHCV 20-40T Trailer',       'MHCV 20-40T Trailer',                   'Trailer',      null, 20,   40,   null, null],
  [10, 'MHCV >40T Tanker',          'MHCV >40T Tanker',                      'Tanker',       null, 40,   null, null, null],
  [11, 'MHCV >40T Tipper/Dumper',   'MHCV >40T Tipper/Dumper',               'Dumper/Tipper',null, 40,   null, null, null],
  [12, 'MHCV >40T Trailer',         'MHCV >40T Trailer',                     'Trailer',      null, 40,   null, null, null],
  [13, 'MHCV >40T Truck',           'MHCV >40T Truck',                       'MHCV',         null, 40,   null, null, null],
];

function rcFor(seg, applied_on, rate_type) {
  const [col, _hdr, segment, _cat, fuel, wmin, wmax, amin, amax] = seg;
  const rc = { column: col, rate_type, segment, applied_on };
  if (fuel) rc.fuel_type = fuel;
  if (amin != null) rc.vehicle_age_min = amin;
  if (amax != null) rc.vehicle_age_max = amax;
  return rc;
}

const compRcs = compSegments.map(s => rcFor(s, 'Net', 'Comp'));
const aotpRcs = aotpSegments.map(s => rcFor(s, 'Net', 'TP'));

console.log('CV_COMP rate_columns:');
console.log(JSON.stringify(compRcs, null, 2));
console.log('\nCV_AOTP rate_columns:');
console.log(JSON.stringify(aotpRcs, null, 2));
