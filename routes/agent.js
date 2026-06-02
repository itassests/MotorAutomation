/**
 * routes/agent.js — Agent View (self-service dashboard for POSLG agents).
 *
 * Every endpoint is scoped to the LOGGED-IN agent's own data: an agent
 * (role='agent', empcode = their POSLG UPIN) can only ever see policies where
 * cycle_bulk_rows.agent_code = their empcode. Admins may pass ?agent=POSLG… to
 * inspect a specific agent. Reads the bulk snapshot (cycle_bulk_rows).
 *
 *   GET /api/agent/summary   ?cycle_id=  → totals + by-vehicle-type breakdown
 *   GET /api/agent/policies  ?cycle_id=&insurer=&vehicle_type=&paid=
 *   GET /api/agent/statement ?cycle_id=  → xlsx payout statement download
 */
const express = require('express');
const XLSX = require('xlsx');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { attachUser } = require('./auth');

const router = express.Router();
// Must be logged in; every endpoint is then scoped to req.user's own agent code.
router.use(attachUser(), (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' });
  next();
});

// The agent code this request may see: agents are locked to their own empcode;
// admins/others may target a specific agent via ?agent=.
function agentCodeFor(req) {
  const me = String(req.user.empcode || '').trim().toUpperCase();
  if (req.user.role === 'agent') return me;                 // locked to self
  const q = String(req.query.agent || '').trim().toUpperCase();
  return q || me;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Default to the latest cycle that actually has rows for this agent.
async function resolveCycleId(pool, req, agentCode) {
  const q = parseInt(req.query.cycle_id, 10);
  if (Number.isInteger(q)) return q;
  const r = await pool.request().input('ac', agentCode)
    .query(`SELECT MAX(cycle_id) AS cid FROM cycle_bulk_rows WHERE agent_code = @ac`);
  return r.recordset[0] && r.recordset[0].cid != null ? r.recordset[0].cid : null;
}

// Cycle display name (payout_cycles.name), e.g. "April 2nd Cycle".
async function cycleNameFor(pool, cycleId) {
  if (cycleId == null) return null;
  const r = await pool.request().input('id', cycleId)
    .query('SELECT name FROM payout_cycles WHERE id = @id');
  return r.recordset[0] ? r.recordset[0].name : null;
}

// Pull this agent's (non-excluded) rows for a cycle, parsed from row_json and
// merged with the live override/paid columns. One place so every endpoint sees
// the same numbers as the bulk screen.
async function loadAgentRows(pool, cycleId, agentCode) {
  const r = await pool.request()
    .input('cid', cycleId).input('ac', agentCode)
    .query(`SELECT policy_no, insurer_slug, paid_status, paid_amount, paid_utr, paid_at,
                   rate_pct_override, outgoing_pct_override, row_json
            FROM cycle_bulk_rows
            WHERE cycle_id = @cid AND agent_code = @ac AND (excluded = 0 OR excluded IS NULL)`);
  return r.recordset.map(row => {
    let j = {};
    try { j = JSON.parse(row.row_json || '{}'); } catch (_) { /* skip */ }
    const premium = Number(j.premium_base) || 0;
    const commission = Number(j.outgoing) || 0;             // agent's net payout
    return {
      policy_no: j.policy_no || row.policy_no || '',
      insurer: j.insurer || row.insurer_slug || '',
      insurer_slug: row.insurer_slug || j.insurer_slug || '',
      vehicle_type: j.vehicle_type || '—',
      premium,
      commission_rate: j.outgoing_pct != null ? Number(j.outgoing_pct) : (Number(j.rate_pct) || 0),
      commission,
      reg_no: j.vehicle_no || j.rto_code || '',
      paid: String(row.paid_status || '').toLowerCase() === 'paid',
      paid_amount: row.paid_amount != null ? Number(row.paid_amount) : null,
      paid_utr: row.paid_utr || null,
    };
  });
}

/** GET /summary — total NOP / premium / commission + per-vehicle-type split. */
router.get('/summary', async (req, res, next) => {
  try {
    const pool = await getPool();
    const agentCode = agentCodeFor(req);
    const cycleId = await resolveCycleId(pool, req, agentCode);
    if (cycleId == null) {
      return res.json({ success: true, agent: agentCode, cycle_id: null,
        totals: { nop: 0, premium: 0, commission: 0 }, by_vehicle_type: [] });
    }
    const rows = await loadAgentRows(pool, cycleId, agentCode);
    const cycleName = await cycleNameFor(pool, cycleId);
    const totals = { nop: rows.length, premium: 0, commission: 0 };
    const byVt = new Map();
    for (const x of rows) {
      totals.premium += x.premium;
      totals.commission += x.commission;
      if (!byVt.has(x.vehicle_type)) byVt.set(x.vehicle_type, { vehicle_type: x.vehicle_type, nop: 0, premium: 0, commission: 0 });
      const g = byVt.get(x.vehicle_type);
      g.nop++; g.premium += x.premium; g.commission += x.commission;
    }
    const round = (n) => +Number(n || 0).toFixed(2);
    res.json({
      success: true, agent: agentCode, cycle_id: cycleId, cycle_name: cycleName,
      totals: { nop: totals.nop, premium: round(totals.premium), commission: round(totals.commission) },
      by_vehicle_type: [...byVt.values()].map(g => ({
        vehicle_type: g.vehicle_type, nop: g.nop, premium: round(g.premium), commission: round(g.commission),
      })).sort((a, b) => b.nop - a.nop),
    });
  } catch (err) { next(err); }
});

/** GET /policies — policy-level detail with optional filters. */
router.get('/policies', async (req, res, next) => {
  try {
    const pool = await getPool();
    const agentCode = agentCodeFor(req);
    const cycleId = await resolveCycleId(pool, req, agentCode);
    if (cycleId == null) return res.json({ success: true, agent: agentCode, cycle_id: null, policies: [] });
    let rows = await loadAgentRows(pool, cycleId, agentCode);
    const fIns = String(req.query.insurer || '').trim().toLowerCase();
    const fVt  = String(req.query.vehicle_type || '').trim().toUpperCase();
    const fPaid = String(req.query.paid || '').trim().toLowerCase();   // 'paid' | 'unpaid' | ''
    if (fIns) rows = rows.filter(r => String(r.insurer_slug || r.insurer).toLowerCase().includes(fIns) || String(r.insurer).toLowerCase().includes(fIns));
    if (fVt)  rows = rows.filter(r => String(r.vehicle_type).toUpperCase() === fVt);
    if (fPaid === 'paid')   rows = rows.filter(r => r.paid);
    if (fPaid === 'unpaid') rows = rows.filter(r => !r.paid);
    res.json({ success: true, agent: agentCode, cycle_id: cycleId, count: rows.length, policies: rows });
  } catch (err) { next(err); }
});

/** GET /monthly — the agent's commission per calendar month (across cycles),
 *  e.g. April → ₹X, May → ₹Y. Each month aggregates the cycles falling in it. */
router.get('/monthly', async (req, res, next) => {
  try {
    const pool = await getPool();
    const agentCode = agentCodeFor(req);
    const r = await pool.request().input('ac', agentCode).query(`
      SELECT cb.cycle_id, cb.row_json, pc.name AS cycle_name, pc.date_from
      FROM cycle_bulk_rows cb
      LEFT JOIN payout_cycles pc ON pc.id = cb.cycle_id
      WHERE cb.agent_code = @ac AND (cb.excluded = 0 OR cb.excluded IS NULL)`);
    const months = new Map();
    for (const row of r.recordset) {
      let j = {};
      try { j = JSON.parse(row.row_json || '{}'); } catch (_) { /* skip */ }
      const commission = Number(j.outgoing) || 0;
      const premium = Number(j.premium_base) || 0;
      const d = row.date_from ? new Date(row.date_from) : null;
      const key = d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` : 'unknown';
      const label = d ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : 'Unknown';
      if (!months.has(key)) months.set(key, { month_key: key, month: label, nop: 0, premium: 0, commission: 0, cycles: new Set() });
      const g = months.get(key);
      g.nop++; g.premium += premium; g.commission += commission;
      if (row.cycle_name) g.cycles.add(row.cycle_name);
    }
    const round = (n) => +Number(n || 0).toFixed(2);
    const out = [...months.values()]
      .sort((a, b) => (a.month_key < b.month_key ? 1 : -1))   // newest month first
      .map(g => ({ month_key: g.month_key, month: g.month, nop: g.nop,
        premium: round(g.premium), commission: round(g.commission), cycles: [...g.cycles] }));
    res.json({ success: true, agent: agentCode, months: out });
  } catch (err) { next(err); }
});

/** GET /renewals — the agent's motor-renewal dashboard, sourced live from
 *  Prarambh_Live.App_GetMotorRenewalDashboardDetails. Scoped to the agent's own
 *  empcode (the proc filters on UPIN_CODE = @Empcode + reporting hierarchy).
 *  Query: from=YYYY-MM-DD & to=YYYY-MM-DD (policy end-date range). */
router.get('/renewals', async (req, res, next) => {
  try {
    const agentCode = agentCodeFor(req);
    const from = String(req.query.from || '').trim() || null;
    const to   = String(req.query.to || '').trim() || null;
    const pool = await getPrarambhPool();
    const rq = pool.request();
    rq.input('StartDate', sql.VarChar(200), from);
    rq.input('EndDate', sql.VarChar(200), to);
    rq.input('VerticalId', sql.Int, null);
    rq.input('SubBranchId', sql.Int, null);
    rq.input('BranchId', sql.Int, 0);
    rq.input('Trackerno', sql.VarChar(100), null);
    rq.input('customername', sql.VarChar(200), null);
    rq.input('Policynumber', sql.VarChar(200), null);
    rq.input('Vechilenumber', sql.VarChar(100), null);
    rq.input('Empcode', sql.VarChar(50), agentCode);
    rq.input('ProductType', sql.Int, null);
    rq.input('Vechiletype', sql.Int, null);
    rq.input('agentCode', sql.VarChar(100), null);
    const r = await rq.execute('App_GetMotorRenewalDashboardDetails');

    const s = (r.recordsets[0] && r.recordsets[0][0]) || {};
    const rawDetails = r.recordsets[1] || [];
    // mssql collapses duplicate column names into arrays; pick the http(s) one.
    const httpUrl = (v) => {
      if (Array.isArray(v)) return v.find(u => typeof u === 'string' && /^https?:/i.test(u)) || null;
      return (typeof v === 'string' && /^https?:/i.test(v)) ? v : null;
    };
    // The RenewalNotice left-join can fan a policy into several rows — dedupe by Id.
    const byId = new Map();
    for (const x of rawDetails) {
      const id = x.Id;
      const notice = httpUrl(x.RenewalNotice);
      if (!byId.has(id)) {
        byId.set(id, {
          prarambh_id: id,
          tracker_no: x.TrackerNo || '',
          insurer: x.INSURERNAME || '',
          product_type: x.ProductTypeName || '',
          customer_name: x.FULLNAME_PROPOSER || '',
          agent_code: x.UPIN_CODE || '',
          agent_name: x.displayname || '',
          vehicle_type: x.VehicleType || '',
          engine_no: x.ENGINE_NO || '',
          chassis_no: x.CHASIS_NO || '',
          registration_no: x.VEHICLE_REGISTRATION_NO || '',
          policy_no: x.PolicyNo || '',
          prev_policy_url: httpUrl(x.Filepath),
          renewal_notice_url: notice,
          policy_end_date: x.OD_End_Date || null,
          premium: Number(x.ANNUAL_PREMIUM) || 0,
          status: x.RenewalPolicyStatus || '',
          policy_status: x.PolicyStatus || '',
        });
      } else if (notice && !byId.get(id).renewal_notice_url) {
        byId.get(id).renewal_notice_url = notice;
      }
    }
    const details = [...byId.values()];

    // Renewal truth-source: a policy M is "Renewed" when some other
    // TRN_PrarambhMain row M1 carries M1.OldTrackerId = M.Id (the renewal points
    // back at the policy it renewed). Look those up and override the status.
    const ids = details.map(d => Number(d.prarambh_id)).filter(n => Number.isInteger(n));
    if (ids.length) {
      const inList = ids.join(',');   // numeric-validated, safe to inline
      const rr = await pool.request()
        .query(`SELECT DISTINCT OldTrackerId FROM TRN_PrarambhMain WHERE OldTrackerId IN (${inList})`);
      const renewedIds = new Set(rr.recordset.map(x => String(x.OldTrackerId)));
      for (const d of details) {
        if (renewedIds.has(String(d.prarambh_id))) d.status = 'Renewed';
      }
    }

    // Recompute the summary from the corrected statuses so the cards match the
    // table. Non-renewed rows keep the proc's status ('Lost' vs blank/pending).
    const toLakh = (n) => +(Number(n || 0) / 100000).toFixed(2);
    let totPrem = 0, renNop = 0, renPrem = 0, lostNop = 0, lostPrem = 0;
    for (const d of details) {
      totPrem += d.premium;
      const st = String(d.status || '').toLowerCase();
      if (st === 'renewed') { renNop++; renPrem += d.premium; }
      else if (st === 'lost') { lostNop++; lostPrem += d.premium; }
    }

    res.json({
      success: true, agent: agentCode, from, to,
      summary: {
        total_nop: details.length,
        total_premium_lakhs: toLakh(totPrem),
        renewed_nop: renNop,
        renewed_premium_lakhs: toLakh(renPrem),
        lost_nop: lostNop,
        lost_premium_lakhs: toLakh(lostPrem),
      },
      count: details.length,
      details,
    });
  } catch (err) { next(err); }
});

/** GET /statement — download the agent's payout statement for a cycle (xlsx). */
router.get('/statement', async (req, res, next) => {
  try {
    const pool = await getPool();
    const agentCode = agentCodeFor(req);
    const cycleId = await resolveCycleId(pool, req, agentCode);
    if (cycleId == null) return res.status(404).json({ success: false, error: 'No policies for this agent' });
    const rows = await loadAgentRows(pool, cycleId, agentCode);
    const aoa = [['Policy No', 'Insurer', 'Vehicle Type', 'Reg No', 'Premium', 'Commission Rate %', 'Commission Amount', 'Paid', 'UTR']];
    let tp = 0, tc = 0;
    for (const r of rows) {
      aoa.push([r.policy_no, r.insurer, r.vehicle_type, r.reg_no,
        +r.premium.toFixed(2), +Number(r.commission_rate).toFixed(2), +r.commission.toFixed(2),
        r.paid ? 'Paid' : 'Unpaid', r.paid_utr || '']);
      tp += r.premium; tc += r.commission;
    }
    aoa.push([]);
    aoa.push(['TOTAL', '', '', '', +tp.toFixed(2), '', +tc.toFixed(2), '', '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Payout');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payout_${agentCode}_cycle${cycleId}.xlsx"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) { next(err); }
});

module.exports = router;
