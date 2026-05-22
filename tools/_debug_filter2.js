/**
 * Debug filterRulesByPolicy with synthetic params matching the bulk's
 * stored note for tracker MT/DIRSW/MH27/5529/FY26-27/1.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
const { lookupRates, resolveRTO } = require('../services/rate-lookup');
const { filterRulesByPolicy } = require('../routes/policy');

(async () => {
  const p = await getPool();
  const params = {
    insurer:        'hdfc_ergo',
    insurerName:    'HDFC ERGO General Insurance',
    vehicleType:    'GCV',
    vehicleClass:   'GCV',
    vehicleCategory:'GCV',
    make:           'ASHOK LEYLAND',
    model:          'DOST',
    fuelType:       'DIESEL',
    cc:             null,
    vehicleAge:     10,
    ncbPct:         0,
    seatingCapacity: 0,
    tonnage:        null,
    rtoCode:        'MH12',
    insProduct:     'Comp',
    addon:          false,
    isHighEnd:      false,
    addonPremium:   0,
  };
  const rtoInfo = await resolveRTO(p, 'hdfc_ergo', 'GCV', 'MH12');
  console.log('RTO info:', rtoInfo);

  const baseLookup = {
    insurer: 'hdfc_ergo',
    product: ['GCV'],
    region: rtoInfo?.region || '',
    cluster: rtoInfo?.cluster || '',
    vehicle_age: params.vehicleAge,
    fuel_type: params.fuelType || '',
    ins_product: params.insProduct || '',
  };
  const sqlRules = await lookupRates(p, baseLookup);
  console.log('\n=== SQL rules ('+sqlRules.length+') ===');
  sqlRules.forEach(r => console.log(' id=', r.id, '| seg=', r.segment, '| make=', r.make,
    '| wb=', r.weight_band_min+'-'+r.weight_band_max,
    '| age=', r.vehicle_age_min+'-'+r.vehicle_age_max,
    '| fuel=', r.fuel_type, '| rt=', r.rate_type, '| rate=', r.rate_value));

  const trace = [];
  const filtered = filterRulesByPolicy(sqlRules, params, trace);
  console.log('\n=== After filter ('+filtered.length+') ===');
  filtered.forEach(r => console.log(' id=', r.id, '| seg=', r.segment, '| make=', r.make, '| rate=', r.rate_value));
  if (trace.length > 0) {
    console.log('\n=== Trace ===');
    trace.slice(0, 30).forEach(t => console.log(' ', t));
  }
  await close();
})().catch(e => { console.error(e); process.exit(1); });
