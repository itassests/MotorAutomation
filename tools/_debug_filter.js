/**
 * Debug filterRulesByPolicy for a specific tracker.
 * Shows which rules survived, which dropped, and the drop reason.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool, close } = require('../db/connection');
const { lookupRates, resolveRTO } = require('../services/rate-lookup');
const { filterRulesByPolicy, extractPolicyParams, resolveInsurerSlug } = require('../routes/policy');

(async () => {
  const tracker = process.argv[2] || 'MT/DIRSW/MH27/5529/FY26-27/1';
  const p = await getPool();
  // Pull policy from Prarambh
  const polRow = await p.request()
    .input('t', tracker)
    .query(`SELECT TOP 1 * FROM Prarambh_UAT.dbo.vw_NewTempPrarambhExcelMotorDownload WHERE TrackerNo = @t OR Tracker_no = @t`);
  if (!polRow.recordset[0]) {
    // Try via cycle_bulk_rows policy_no
    const cb = await p.request()
      .input('t', tracker)
      .query(`SELECT JSON_VALUE(row_json, '$.policy_no') AS policy_no FROM cycle_bulk_rows
              WHERE JSON_VALUE(row_json, '$.tracker_no') = @t`);
    const polNo = cb.recordset[0]?.policy_no;
    console.log('policy_no:', polNo);
    if (polNo) {
      const r2 = await p.request().input('p', polNo)
        .query(`SELECT TOP 1 * FROM Prarambh_UAT.dbo.vw_NewTempPrarambhExcelMotorDownload WHERE PolicyNo = @p OR POLICY_NO = @p`);
      if (r2.recordset[0]) polRow.recordset[0] = r2.recordset[0];
    }
  }
  const policy = polRow.recordset[0];
  if (!policy) { console.log('Policy not found in Prarambh'); await close(); return; }

  const params = extractPolicyParams(policy);
  console.log('\nExtracted params:', {
    insurerName: params.insurerName,
    vehicleType: params.vehicleType,
    vehicleClass: params.vehicleClass,
    vehicleCategory: params.vehicleCategory,
    make: params.make, model: params.model, fuel: params.fuelType,
    cc: params.cc, age: params.vehicleAge, ncbPct: params.ncbPct,
    seating: params.seatingCapacity, tonnage: params.tonnage,
    rto: params.rtoCode, insProduct: params.insProduct,
  });

  const insurerSlug = resolveInsurerSlug(params.insurerName);
  const rtoInfo = await resolveRTO(p, insurerSlug, params.vehicleType, params.rtoCode);
  console.log('\nRTO info:', rtoInfo);

  const baseLookup = {
    insurer: insurerSlug,
    product: [params.vehicleType],
    region: rtoInfo?.region || '',
    cluster: rtoInfo?.cluster || '',
    vehicle_age: params.vehicleAge,
    fuel_type: params.fuelType || '',
    ins_product: params.insProduct || '',
  };
  const sqlRules = await lookupRates(p, baseLookup);
  console.log('\n=== SQL Rules (' + sqlRules.length + ') ===');
  sqlRules.forEach(r => console.log(' id=', r.id, '| seg=', r.segment, '| make=', r.make,
    '| wb=', r.weight_band_min, '-', r.weight_band_max,
    '| age=', r.vehicle_age_min, '-', r.vehicle_age_max,
    '| rt=', r.rate_type, '| rate=', r.rate_value));

  const trace = [];
  const filtered = filterRulesByPolicy(sqlRules, params, trace);
  console.log('\n=== After filter (' + filtered.length + ' survived) ===');
  filtered.forEach(r => console.log(' id=', r.id, '| seg=', r.segment, '| make=', r.make, '| rate=', r.rate_value));
  if (trace.length > 0) {
    console.log('\n=== Filter trace ===');
    trace.forEach(t => console.log(' ', t));
  }
  await close();
})().catch(e => { console.error(e); process.exit(1); });
