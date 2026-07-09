require('dotenv').config();
const XLSX = require('xlsx');
const { getPool, close } = require('../db/connection');
const { runBulkCalculate } = require('../routes/bulk');

const TOL = 0.6;
const isCV = (r) => /GCV|PCV/i.test(String(r.vehicleType || r.vehicle_type || r.product || r.productType || '')) ||
                    /Commercial/i.test(String(r.vehicleType || ''));

(async () => {
  const pool = await getPool();

  // operator map
  const O = XLSX.utils.sheet_to_json(
    XLSX.readFile('C:/Users/ribweb07/Documents/June 1st.xlsx').Sheets['Sheet1'], { defval: null });
  const opMap = new Map();
  for (const r of O) { const t = String(r['Tracker No'] || '').trim().toUpperCase(); if (t) opMap.set(t, r['New Net']); }

  // BEFORE: stored cycle_bulk_rows for FG (computed with Feb config)
  const before = await pool.request().query(`
    SELECT tracker_no, row_json FROM cycle_bulk_rows
    WHERE cycle_id=13 AND insurer_slug='future_generali'`);
  const beforeMap = new Map();
  for (const r of before.recordset) {
    let j = {}; try { j = JSON.parse(r.row_json); } catch (_) {}
    beforeMap.set(String(r.tracker_no || '').trim().toUpperCase(), j);
  }
  console.log('stored FG rows (before):', before.recordset.length);

  // AFTER: recompute FG now (June config)
  const res = await runBulkCalculate({
    insurer_slug: 'future_generali', date_from: '2026-06-01', date_to: '2026-06-15', limit: 20000,
  });
  const rows = res.rows || [];
  console.log('recomputed FG rows (after):', rows.length);

  let evald = 0, mBefore = 0, mAfter = 0, fixed = 0, regr = 0;
  const fixEx = [], regEx = [];
  for (const row of rows) {
    const trk = String(row.tracker_no || row.trackerNo || '').trim().toUpperCase();
    // only CV
    const vt = String(row.vehicleType || row.vehicle_type || '').toUpperCase();
    if (!/GCV|PCV/.test(vt)) continue;
    if (!opMap.has(trk)) continue;
    const op = opMap.get(trk);
    if (typeof op !== 'number') continue;
    const opPct = op * 100;
    const afterPct = Number(row.rate_pct);
    const bj = beforeMap.get(trk);
    const beforePct = bj ? Number(bj.rate_pct) : null;
    if (!Number.isFinite(afterPct)) continue;
    evald++;
    const okB = beforePct != null && Number.isFinite(beforePct) && Math.abs(beforePct - opPct) <= TOL;
    const okA = Math.abs(afterPct - opPct) <= TOL;
    if (okB) mBefore++;
    if (okA) mAfter++;
    if (!okB && okA) { fixed++; if (fixEx.length < 8) fixEx.push(`${trk} op=${opPct} before=${beforePct} after=${afterPct}`); }
    if (okB && !okA) { regr++; if (regEx.length < 8) regEx.push(`${trk} op=${opPct} before=${beforePct} after=${afterPct}`); }
  }
  console.log(`\nFG CV scored: ${evald}`);
  console.log(`matched BEFORE (Feb): ${mBefore}`);
  console.log(`matched AFTER (June): ${mAfter}`);
  console.log(`FIXED: ${fixed} | REGRESSED: ${regr} | NET: ${fixed - regr}`);
  console.log('fix ex:', fixEx);
  console.log('regress ex:', regEx);
  await close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
