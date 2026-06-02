/**
 * routes/employee.js — Employee Business Dashboard.
 *
 * When an employee logs in we show all motor business booked in the current FY
 * (since 01-Apr) across their reporting hierarchy: the logged-in employee +
 * everyone who rolls up to them (X sees X, Y, Z where Z→Y→X). Hierarchy is the
 * recursive reporting tree in Prarambh_Live.BugNet_UserProfiles
 * (EmployeeCode ← reportingmgremployeecode), IsActive=1 AND IsValid=1, with a
 * path-based cycle guard.
 *
 * Business is attributed to TRN_PrarambhMain.ReportingEmployeeCode (int → cast
 * to varchar to join BugNet's varchar EmployeeCode).
 *
 * Data hygiene (applied everywhere via the `base` CTE):
 *   - IsActive = 1 always.
 *   - LogStatusId = 15 rows are duplicates → excluded.
 *   - Each TrackerNo is counted ONCE (ROW_NUMBER over TrackerNo, keep latest Id).
 *
 * Online/Offline = NatureOfSale (MST_FieldMasters 4030): Online = {2,5,6}.
 * Ok to Log = LogStatusId = 2.
 *
 *   GET /api/employee/dashboard ?from&to&vertical&branch&sub_branch&agent
 *                               &employee&vehicle_type&channel&log_status
 */
const express = require('express');
const sql = require('mssql');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { attachUser } = require('./auth');

const router = express.Router();
router.use(attachUser(), (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' });
  next();
});

const ONLINE_SET = '(2,5,6)';     // NatureOfSale values treated as Online
const LIST_CAP = 1000;

function rootEmpFor(req) {
  const me = String(req.user.empcode || '').trim();
  if (req.user.role === 'admin') return String(req.query.employee_root || '').trim() || me;
  return me;
}

// FY / business-month / today are computed in SQL from the DB's current date.
const DECLARES = `
  DECLARE @today date = CAST(GETDATE() AS date);
  DECLARE @fy date = DATEFROMPARTS(CASE WHEN MONTH(@today) >= 4 THEN YEAR(@today) ELSE YEAR(@today) - 1 END, 4, 1);
  DECLARE @mtd date = CASE WHEN DAY(@today) >= 2 THEN DATEFROMPARTS(YEAR(@today), MONTH(@today), 2)
                           ELSE DATEADD(MONTH, -1, DATEFROMPARTS(YEAR(@today), MONTH(@today), 2)) END;`;

// hier (reporting tree) + base (one deduped row per TrackerNo, status-15 dropped,
// all label columns resolved). Every query reads `FROM base WHERE rn = 1`.
const CTES = `
  ;WITH hier AS (
    SELECT EmployeeCode, reportingmgremployeecode, CAST('|' + EmployeeCode + '|' AS VARCHAR(8000)) AS path
    FROM BugNet_UserProfiles WITH (NOLOCK)
    WHERE EmployeeCode = @emp AND IsActive = 1 AND IsValid = 1
    UNION ALL
    SELECT c.EmployeeCode, c.reportingmgremployeecode, CAST(h.path + c.EmployeeCode + '|' AS VARCHAR(8000))
    FROM BugNet_UserProfiles c WITH (NOLOCK)
    INNER JOIN hier h ON c.reportingmgremployeecode = h.EmployeeCode
    WHERE c.IsActive = 1 AND c.IsValid = 1 AND CHARINDEX('|' + c.EmployeeCode + '|', h.path) = 0
  ),
  base AS (
    SELECT
      m.TrackerNo,
      CAST(m.CREATED_DATE AS date) AS cdate, m.CREATED_DATE AS created_dt,
      m.NatureOfSale, m.LogStatusId,
      f1.Name AS vertical, msb.Location AS branch, mssb.Sub_Location AS sub_branch,
      ISNULL(r.IDVpos, r.UPIN_CODE) AS agent_code,
      up.EmployeeCode AS employee_code, up.DisplayName AS employee_name,
      f3.Name AS vehicle_type, f5.Name AS product_type, fn.Name AS channel, ff.Name AS status,
      i.CompanyName AS insurer, p.FULLNAME_PROPOSER AS customer, mis.POLICY_NO AS policy_no,
      md.VEHICLE_REGISTRATION_NO AS reg_no, md.RTO_Code AS rto, md.StateName AS state,
      ISNULL(md.ANNUAL_PREMIUM, 0) AS premium,
      ROW_NUMBER() OVER (PARTITION BY m.TrackerNo ORDER BY m.Id DESC) AS rn
    FROM TRN_PrarambhMain m WITH (NOLOCK)
    INNER JOIN TRN_PrarambhMotorDetails md WITH (NOLOCK) ON md.PrarambhMainId = m.Id AND md.ISACTIVE = 1
    LEFT JOIN TRN_PrarambhProposerDetails p WITH (NOLOCK) ON p.PrarambhMainId = m.Id AND p.ISACTIVE = 1
    LEFT JOIN TRN_PrarambhReportedFields r WITH (NOLOCK) ON r.PrarambhMainId = m.Id AND r.ISACTIVE = 1
    LEFT JOIN TRN_PrarambhMotorMISUpdation mis WITH (NOLOCK) ON mis.PrarambhMainId = m.Id AND mis.ISACTIVE = 1
    LEFT JOIN RH_InsurerMast i WITH (NOLOCK) ON i.insid = r.InsurerId
    INNER JOIN (SELECT DISTINCT EmployeeCode FROM hier) hh ON hh.EmployeeCode = CONVERT(varchar(50), m.ReportingEmployeeCode)
    LEFT JOIN BugNet_UserProfiles up WITH (NOLOCK) ON up.EmployeeCode = CONVERT(varchar(50), m.ReportingEmployeeCode)
    LEFT JOIN MST_FieldMasters f1 WITH (NOLOCK) ON f1.MasterId = 4040 AND f1.Value = m.Vertical
    LEFT JOIN MST_FieldMasters f3 WITH (NOLOCK) ON f3.MasterId = 9210 AND f3.Value = md.VEHICAL_TYPE_Id
    LEFT JOIN MST_FieldMasters f5 WITH (NOLOCK) ON f5.MasterId = 9220 AND f5.Value = r.Product_Type_Id
    LEFT JOIN MST_FieldMasters fn WITH (NOLOCK) ON fn.MasterId = 4030 AND fn.Value = m.NatureOfSale
    LEFT JOIN MST_FieldMasters ff WITH (NOLOCK) ON ff.MasterId = 8050 AND ff.Value = m.FinalStatus
    LEFT JOIN MST_SalesBranch msb WITH (NOLOCK) ON msb.id = r.SALES_BRANCH_Id
    LEFT JOIN MST_SalesSubBranch mssb WITH (NOLOCK) ON mssb.id = r.SALES_SUB_BRANCH_Id
    WHERE m.InsuranceType = 16 AND m.IsActive = 1
      AND (m.LogStatusId IS NULL OR m.LogStatusId <> 15)          -- 15 = duplicates
      AND CAST(m.CREATED_DATE AS date) BETWEEN @fy AND @today
  )`;

const OPT = ' OPTION (MAXRECURSION 1000)';
// Date window for the "current selection" queries (summary / breakdowns / list).
const DATE_SEL = ' AND b.cdate BETWEEN CONVERT(date, @from) AND CONVERT(date, @to)';

// Build a request with the always-present params; optionally bind + return the
// optional-filter WHERE fragment (referencing the deduped `base` alias `b`).
function prep(pool, root, from, to, q, withFilters) {
  const rq = pool.request();
  rq.input('emp', sql.VarChar(50), root);
  rq.input('from', sql.VarChar(20), from);
  rq.input('to', sql.VarChar(20), to);
  let clause = '';
  if (withFilters) {
    const add = (cond) => { clause += ` AND ${cond}`; };
    if (q.vertical)     { rq.input('vertical', sql.NVarChar(300), q.vertical); add('b.vertical = @vertical'); }
    if (q.branch)       { rq.input('branch', sql.NVarChar(300), q.branch); add('b.branch = @branch'); }
    if (q.sub_branch)   { rq.input('sub_branch', sql.NVarChar(300), q.sub_branch); add('b.sub_branch = @sub_branch'); }
    if (q.agent)        { rq.input('agent', sql.NVarChar(100), q.agent); add('b.agent_code = @agent'); }
    if (q.employee)     { rq.input('employee', sql.NVarChar(50), q.employee); add('b.employee_code = @employee'); }
    if (q.vehicle_type) { rq.input('vehicle_type', sql.NVarChar(200), q.vehicle_type); add('b.vehicle_type = @vehicle_type'); }
    if (q.log_status)   { rq.input('log_status', sql.Int, parseInt(q.log_status, 10)); add('b.LogStatusId = @log_status'); }
    const ch = String(q.channel || '').toLowerCase();
    if (ch === 'online')  add(`b.NatureOfSale IN ${ONLINE_SET}`);
    if (ch === 'offline') add(`(b.NatureOfSale NOT IN ${ONLINE_SET} OR b.NatureOfSale IS NULL)`);
  }
  return { rq, clause };
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const root = rootEmpFor(req);
    const from = String(req.query.from || '').trim() || '2026-04-01';
    const to   = String(req.query.to || '').trim() || '2999-12-31';
    if (!root) return res.status(400).json({ success: false, error: 'No employee code on this login' });
    const q = req.query;
    const pool = await getPrarambhPool();
    const round = (n) => +Number(n || 0).toFixed(2);

    // 1) Summary + online/offline (current selection).
    const sumP = prep(pool, root, from, to, q, true);
    const summaryQ = `${DECLARES}${CTES}
      SELECT COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium,
        SUM(CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 1 ELSE 0 END) AS online_nop,
        ISNULL(SUM(CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN b.premium ELSE 0 END),0) AS online_premium,
        SUM(CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 0 ELSE 1 END) AS offline_nop,
        ISNULL(SUM(CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 0 ELSE b.premium END),0) AS offline_premium
      FROM base b WHERE b.rn = 1${DATE_SEL}${sumP.clause}${OPT}`;

    // 2) By vehicle type.
    const vtP = prep(pool, root, from, to, q, true);
    const vtQ = `${DECLARES}${CTES}
      SELECT ISNULL(b.vehicle_type,'—') AS vehicle_type, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM base b WHERE b.rn = 1${DATE_SEL}${vtP.clause}
      GROUP BY b.vehicle_type ORDER BY COUNT(*) DESC${OPT}`;

    // 3) By employee.
    const empP = prep(pool, root, from, to, q, true);
    const empQ = `${DECLARES}${CTES}
      SELECT b.employee_code AS code, MAX(b.employee_name) AS name, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM base b WHERE b.rn = 1${DATE_SEL}${empP.clause}
      GROUP BY b.employee_code ORDER BY COUNT(*) DESC${OPT}`;

    // 4) Filter options — whole hierarchy (FY window), no optional filters.
    const optP = prep(pool, root, from, to, q, false);
    const optionsQ = `${DECLARES}${CTES}
      SELECT DISTINCT b.vertical, b.branch, b.sub_branch, b.agent_code, b.vehicle_type,
             b.employee_code, b.employee_name
      FROM base b WHERE b.rn = 1${OPT}`;

    // 5) Case list (current selection, capped).
    const listP = prep(pool, root, from, to, q, true);
    const listQ = `${DECLARES}${CTES}
      SELECT TOP ${LIST_CAP}
        b.TrackerNo AS tracker_no, b.created_dt AS created_date, b.channel,
        CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 1 ELSE 0 END AS is_online,
        b.vertical, b.branch, b.sub_branch, b.agent_code, b.employee_code, b.employee_name,
        b.vehicle_type, b.product_type, b.insurer, b.customer, b.policy_no,
        b.reg_no, b.rto, b.state, b.premium, b.status
      FROM base b WHERE b.rn = 1${DATE_SEL}${listP.clause}
      ORDER BY b.created_dt DESC${OPT}`;

    // 6) Period buckets (YTD / MTD / FTD) — Total + Ok-to-Log. Periods report
    //    both, so strip the log-status drill filter for this request.
    const perP = prep(pool, root, from, to, { ...q, log_status: '' }, true);
    const periodsQ = `${DECLARES}${CTES}
      SELECT
        CONVERT(varchar(10), @fy, 23) AS fy_start, CONVERT(varchar(10), @mtd, 23) AS mtd_start, CONVERT(varchar(10), @today, 23) AS today,
        COUNT(*) AS ytd_nop, ISNULL(SUM(b.premium),0) AS ytd_prem,
        SUM(CASE WHEN b.cdate >= @mtd THEN 1 ELSE 0 END) AS mtd_nop,
        ISNULL(SUM(CASE WHEN b.cdate >= @mtd THEN b.premium ELSE 0 END),0) AS mtd_prem,
        SUM(CASE WHEN b.cdate = @today THEN 1 ELSE 0 END) AS ftd_nop,
        ISNULL(SUM(CASE WHEN b.cdate = @today THEN b.premium ELSE 0 END),0) AS ftd_prem,
        SUM(CASE WHEN b.LogStatusId = 2 THEN 1 ELSE 0 END) AS ytd_ok_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 2 THEN b.premium ELSE 0 END),0) AS ytd_ok_prem,
        SUM(CASE WHEN b.LogStatusId = 2 AND b.cdate >= @mtd THEN 1 ELSE 0 END) AS mtd_ok_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 2 AND b.cdate >= @mtd THEN b.premium ELSE 0 END),0) AS mtd_ok_prem,
        SUM(CASE WHEN b.LogStatusId = 2 AND b.cdate = @today THEN 1 ELSE 0 END) AS ftd_ok_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 2 AND b.cdate = @today THEN b.premium ELSE 0 END),0) AS ftd_ok_prem
      FROM base b WHERE b.rn = 1${perP.clause}${OPT}`;

    const [sumR, vtR, empR, optR, listR, perR] = await Promise.all([
      sumP.rq.query(summaryQ),
      vtP.rq.query(vtQ),
      empP.rq.query(empQ),
      optP.rq.query(optionsQ),
      listP.rq.query(listQ),
      perP.rq.query(periodsQ),
    ]);

    const s = sumR.recordset[0] || {};
    const uniq = (arr) => [...new Set(arr.filter(v => v != null && v !== ''))].sort();
    const oRows = optR.recordset;
    const empMap = new Map();
    oRows.forEach(r => { if (r.employee_code) empMap.set(r.employee_code, r.employee_name || r.employee_code); });

    const pr = perR.recordset[0] || {};
    const periods = {
      fy_start: pr.fy_start, mtd_start: pr.mtd_start, today: pr.today,
      ytd: { nop: Number(pr.ytd_nop) || 0, premium: round(pr.ytd_prem), from: pr.fy_start, to: pr.today,
             ok_to_log: { nop: Number(pr.ytd_ok_nop) || 0, premium: round(pr.ytd_ok_prem) } },
      mtd: { nop: Number(pr.mtd_nop) || 0, premium: round(pr.mtd_prem), from: pr.mtd_start, to: pr.today,
             ok_to_log: { nop: Number(pr.mtd_ok_nop) || 0, premium: round(pr.mtd_ok_prem) } },
      ftd: { nop: Number(pr.ftd_nop) || 0, premium: round(pr.ftd_prem), from: pr.today, to: pr.today,
             ok_to_log: { nop: Number(pr.ftd_ok_nop) || 0, premium: round(pr.ftd_ok_prem) } },
    };

    res.json({
      success: true, root, from, to, periods,
      summary: {
        nop: Number(s.nop) || 0, premium: round(s.premium),
        online_nop: Number(s.online_nop) || 0, online_premium: round(s.online_premium),
        offline_nop: Number(s.offline_nop) || 0, offline_premium: round(s.offline_premium),
      },
      by_vehicle_type: vtR.recordset.map(r => ({ vehicle_type: r.vehicle_type, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      by_employee: empR.recordset.map(r => ({ code: r.code, name: r.name || r.code, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      options: {
        verticals: uniq(oRows.map(r => r.vertical)),
        branches: uniq(oRows.map(r => r.branch)),
        sub_branches: uniq(oRows.map(r => r.sub_branch)),
        agents: uniq(oRows.map(r => r.agent_code)),
        vehicle_types: uniq(oRows.map(r => r.vehicle_type)),
        employees: [...empMap.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => (a.name > b.name ? 1 : -1)),
      },
      truncated: listR.recordset.length >= LIST_CAP,
      cases: listR.recordset.map(r => ({
        tracker_no: r.tracker_no || '', created_date: r.created_date || null,
        channel: r.channel || '', is_online: !!r.is_online,
        vertical: r.vertical || '', branch: r.branch || '', sub_branch: r.sub_branch || '',
        agent_code: r.agent_code || '', employee_code: r.employee_code || '', employee_name: r.employee_name || '',
        vehicle_type: r.vehicle_type || '—', product_type: r.product_type || '', insurer: r.insurer || '',
        customer: r.customer || '', policy_no: r.policy_no || '', reg_no: r.reg_no || '',
        rto: r.rto || '', state: r.state || '', premium: Number(r.premium) || 0, status: r.status || '',
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
