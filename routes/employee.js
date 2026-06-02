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

// Shared column list + joins for the two attribution paths (offline / online).
const BASE_COLS = `
      m.Id AS _id, m.TrackerNo,
      CAST(m.CREATED_DATE AS date) AS cdate, m.CREATED_DATE AS created_dt,
      m.NatureOfSale, m.LogStatusId, mis.POLICY_STATUS_ID AS policy_status_id,
      CASE WHEN mt.PTrackerno IS NOT NULL THEN 1 ELSE 0 END AS in_txn,
      f1.Name AS vertical, msb.Location AS branch, mssb.Sub_Location AS sub_branch,
      ISNULL(r.IDVpos, r.UPIN_CODE) AS agent_code,
      up.EmployeeCode AS employee_code, up.DisplayName AS employee_name,
      f3.Name AS vehicle_type, f5.Name AS product_type, fn.Name AS channel, ff.Name AS status,
      i.CompanyName AS insurer, p.FULLNAME_PROPOSER AS customer, mis.POLICY_NO AS policy_no,
      md.VEHICLE_REGISTRATION_NO AS reg_no, md.RTO_Code AS rto, md.StateName AS state,
      ISNULL(md.ANNUAL_PREMIUM, 0) AS premium`;
const JOINS_HEAD = `
    FROM TRN_PrarambhMain m WITH (NOLOCK)
    INNER JOIN TRN_PrarambhMotorDetails md WITH (NOLOCK) ON md.PrarambhMainId = m.Id AND md.ISACTIVE = 1
    LEFT JOIN TRN_PrarambhProposerDetails p WITH (NOLOCK) ON p.PrarambhMainId = m.Id AND p.ISACTIVE = 1
    LEFT JOIN TRN_PrarambhReportedFields r WITH (NOLOCK) ON r.PrarambhMainId = m.Id AND r.ISACTIVE = 1
    LEFT JOIN TRN_PrarambhMotorMISUpdation mis WITH (NOLOCK) ON mis.PrarambhMainId = m.Id AND mis.ISACTIVE = 1
    LEFT JOIN RH_InsurerMast i WITH (NOLOCK) ON i.insid = r.InsurerId`;
const JOINS_TAIL = `
    LEFT JOIN MST_FieldMasters f1 WITH (NOLOCK) ON f1.MasterId = 4040 AND f1.Value = m.Vertical
    LEFT JOIN MST_FieldMasters f3 WITH (NOLOCK) ON f3.MasterId = 9210 AND f3.Value = md.VEHICAL_TYPE_Id
    LEFT JOIN MST_FieldMasters f5 WITH (NOLOCK) ON f5.MasterId = 9220 AND f5.Value = r.Product_Type_Id
    LEFT JOIN MST_FieldMasters fn WITH (NOLOCK) ON fn.MasterId = 4030 AND fn.Value = m.NatureOfSale
    LEFT JOIN MST_FieldMasters ff WITH (NOLOCK) ON ff.MasterId = 8050 AND ff.Value = m.FinalStatus
    LEFT JOIN MST_SalesBranch msb WITH (NOLOCK) ON msb.id = r.SALES_BRANCH_Id
    LEFT JOIN MST_SalesSubBranch mssb WITH (NOLOCK) ON mssb.id = r.SALES_SUB_BRANCH_Id
    LEFT JOIN (SELECT DISTINCT PTrackerno FROM Beeinsured_v3_2.dbo.TRN_MotorTransactionForPrarambh WITH (NOLOCK)
               WHERE PTrackerno IS NOT NULL AND PTrackerno <> 'DUMMY' AND TransactionDate >= @fy) mt ON mt.PTrackerno = m.TrackerNo`;
const BASE_WHERE = `m.InsuranceType = 16 AND m.IsActive = 1
      AND m.LogStatusId IS NOT NULL AND m.LogStatusId NOT IN (15, 16)   -- 15=dup, 16=Hold, NULL=in-process
      AND CAST(m.CREATED_DATE AS date) BETWEEN @fy AND @today`;

// Full hierarchy employee roster (with names) → #hemp. Lets the employee
// leaderboard rank EVERY employee in the subtree, including those with zero
// business (the genuine bottom performers), not just those who have cases.
const HEMP_SQL = `
  ;WITH hier AS (
    SELECT EmployeeCode, reportingmgremployeecode, DisplayName, CAST('|' + EmployeeCode + '|' AS VARCHAR(8000)) AS path
    FROM BugNet_UserProfiles WITH (NOLOCK)
    WHERE EmployeeCode = @emp AND IsActive = 1 AND IsValid = 1
    UNION ALL
    SELECT c.EmployeeCode, c.reportingmgremployeecode, c.DisplayName, CAST(h.path + c.EmployeeCode + '|' AS VARCHAR(8000))
    FROM BugNet_UserProfiles c WITH (NOLOCK)
    INNER JOIN hier h ON c.reportingmgremployeecode = h.EmployeeCode
    WHERE c.IsActive = 1 AND c.IsValid = 1 AND CHARINDEX('|' + c.EmployeeCode + '|', h.path) = 0
  )
  SELECT EmployeeCode AS code, MAX(DisplayName) AS name INTO #hemp FROM hier GROUP BY EmployeeCode OPTION (MAXRECURSION 1000);`;

// hier (reporting tree) + base (one deduped row per TrackerNo). Attribution is
// a UNION: offline cases match on m.ReportingEmployeeCode (fast, indexed); online
// cases (no ReportingEmployeeCode) fall back to tmp_poscodes.referal_code keyed
// on the case's POS/UPIN code. Every query reads `FROM #base WHERE rn = 1`.
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
    SELECT u.*, ROW_NUMBER() OVER (PARTITION BY u.TrackerNo ORDER BY u._id DESC) AS rn
    FROM (
      -- A) cases with a ReportingEmployeeCode (offline + most business)
      SELECT ${BASE_COLS}
      ${JOINS_HEAD}
      INNER JOIN (SELECT DISTINCT EmployeeCode FROM hier) hh ON hh.EmployeeCode = CONVERT(varchar(50), m.ReportingEmployeeCode)
      LEFT JOIN BugNet_UserProfiles up WITH (NOLOCK) ON up.EmployeeCode = CONVERT(varchar(50), m.ReportingEmployeeCode)
      ${JOINS_TAIL}
      WHERE ${BASE_WHERE} AND m.ReportingEmployeeCode IS NOT NULL
      UNION ALL
      -- B) online cases (no ReportingEmployeeCode) → referring employee via POS code
      SELECT ${BASE_COLS}
      ${JOINS_HEAD}
      INNER JOIN Beeinsured_v3_2.dbo.tmp_poscodes pc WITH (NOLOCK) ON pc.upincode = ISNULL(r.IDVpos, r.UPIN_CODE) AND pc.referal_code <> 'Direct'
      INNER JOIN (SELECT DISTINCT EmployeeCode FROM hier) hh ON hh.EmployeeCode = pc.referal_code
      LEFT JOIN BugNet_UserProfiles up WITH (NOLOCK) ON up.EmployeeCode = pc.referal_code
      ${JOINS_TAIL}
      WHERE ${BASE_WHERE} AND m.ReportingEmployeeCode IS NULL
    ) u
  )`;

const OPT = ' OPTION (MAXRECURSION 1000)';
// Date window for the "current selection" queries (summary / breakdowns / list).
const DATE_SEL = ' AND b.cdate BETWEEN CONVERT(date, @from) AND CONVERT(date, @to)';

// Bind the always-present params + optional filters on a single request, and
// return two WHERE fragments (referencing the materialised #base alias `b`):
//   full — every filter incl. the status drills (summary / breakdowns / list)
//   base — only the non-status filters (periods, which report every status)
function buildClauses(rq, root, from, to, q) {
  rq.input('emp', sql.VarChar(50), root);
  rq.input('from', sql.VarChar(20), from);
  rq.input('to', sql.VarChar(20), to);
  let full = '', base = '';
  const both = (c) => { full += ` AND ${c}`; base += ` AND ${c}`; };
  const onlyFull = (c) => { full += ` AND ${c}`; };
  if (q.vertical)     { rq.input('vertical', sql.NVarChar(300), q.vertical); both('b.vertical = @vertical'); }
  if (q.branch)       { rq.input('branch', sql.NVarChar(300), q.branch); both('b.branch = @branch'); }
  if (q.sub_branch)   { rq.input('sub_branch', sql.NVarChar(300), q.sub_branch); both('b.sub_branch = @sub_branch'); }
  if (q.agent)        { rq.input('agent', sql.NVarChar(100), q.agent); both('b.agent_code = @agent'); }
  if (q.employee)     { rq.input('employee', sql.NVarChar(50), q.employee); both('b.employee_code = @employee'); }
  if (q.vehicle_type) { rq.input('vehicle_type', sql.NVarChar(200), q.vehicle_type); both('b.vehicle_type = @vehicle_type'); }
  const ch = String(q.channel || '').toLowerCase();
  if (ch === 'online')  both(`b.NatureOfSale IN ${ONLINE_SET}`);
  if (ch === 'offline') both(`(b.NatureOfSale NOT IN ${ONLINE_SET} OR b.NatureOfSale IS NULL)`);
  // status drills — full only (periods always report all statuses side by side)
  if (q.log_status)    { rq.input('log_status', sql.Int, parseInt(q.log_status, 10)); onlyFull('b.LogStatusId = @log_status'); }
  if (q.policy_status) { rq.input('policy_status', sql.Int, parseInt(q.policy_status, 10)); onlyFull('b.policy_status_id = @policy_status'); }
  if (q.online_txn)    { onlyFull('b.in_txn = 1'); }
  return { full, base };
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

    // Materialise the deduped hierarchy set into #base ONCE (the recursive
    // hierarchy + the cross-DB online join run a single time), then run every
    // aggregation against #base — far cheaper than rebuilding base per query
    // and avoids the cross-DB join timing out under 6× parallel evaluation.
    const rq = pool.request();
    const cl = buildClauses(rq, root, from, to, q);
    const batch = `
      ${DECLARES}
      IF OBJECT_ID('tempdb..#base') IS NOT NULL DROP TABLE #base;
      IF OBJECT_ID('tempdb..#hemp') IS NOT NULL DROP TABLE #hemp;
      ${HEMP_SQL}
      ${CTES}
      SELECT * INTO #base FROM base WHERE rn = 1${OPT};

      -- 1) Summary + online/offline (NatureOfSale-based)
      SELECT COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium,
        SUM(CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 1 ELSE 0 END) AS online_nop,
        ISNULL(SUM(CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN b.premium ELSE 0 END),0) AS online_premium,
        SUM(CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 0 ELSE 1 END) AS offline_nop,
        ISNULL(SUM(CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 0 ELSE b.premium END),0) AS offline_premium
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full};

      -- 2) By vehicle type
      SELECT ISNULL(b.vehicle_type,'—') AS vehicle_type, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full} GROUP BY b.vehicle_type ORDER BY COUNT(*) DESC;

      -- 3) By employee — full hierarchy roster (0 for those with no business)
      SELECT he.code, he.name,
        COUNT(b.TrackerNo) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #hemp he
      LEFT JOIN #base b ON b.employee_code = he.code${DATE_SEL}${cl.full}
      GROUP BY he.code, he.name ORDER BY COUNT(b.TrackerNo) DESC;

      -- 4) Filter options (whole hierarchy, no optional filters)
      SELECT DISTINCT b.vertical, b.branch, b.sub_branch, b.agent_code, b.vehicle_type, b.employee_code, b.employee_name
      FROM #base b;

      -- 5) Case list (capped)
      SELECT TOP ${LIST_CAP}
        b.TrackerNo AS tracker_no, b.created_dt AS created_date, b.channel,
        CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 1 ELSE 0 END AS is_online,
        b.vertical, b.branch, b.sub_branch, b.agent_code, b.employee_code, b.employee_name,
        b.vehicle_type, b.product_type, b.insurer, b.customer, b.policy_no,
        b.reg_no, b.rto, b.state, b.premium, b.status
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full} ORDER BY b.created_dt DESC;

      -- 6) Period buckets (YTD / MTD / FTD) — every status side by side
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
        ISNULL(SUM(CASE WHEN b.LogStatusId = 2 AND b.cdate = @today THEN b.premium ELSE 0 END),0) AS ftd_ok_prem,
        -- U/W Pending = LogStatusId 1
        SUM(CASE WHEN b.LogStatusId = 1 THEN 1 ELSE 0 END) AS ytd_uw_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 1 THEN b.premium ELSE 0 END),0) AS ytd_uw_prem,
        SUM(CASE WHEN b.LogStatusId = 1 AND b.cdate >= @mtd THEN 1 ELSE 0 END) AS mtd_uw_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 1 AND b.cdate >= @mtd THEN b.premium ELSE 0 END),0) AS mtd_uw_prem,
        SUM(CASE WHEN b.LogStatusId = 1 AND b.cdate = @today THEN 1 ELSE 0 END) AS ftd_uw_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 1 AND b.cdate = @today THEN b.premium ELSE 0 END),0) AS ftd_uw_prem,
        -- Return to Bops = LogStatusId 6
        SUM(CASE WHEN b.LogStatusId = 6 THEN 1 ELSE 0 END) AS ytd_rtb_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 6 THEN b.premium ELSE 0 END),0) AS ytd_rtb_prem,
        SUM(CASE WHEN b.LogStatusId = 6 AND b.cdate >= @mtd THEN 1 ELSE 0 END) AS mtd_rtb_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 6 AND b.cdate >= @mtd THEN b.premium ELSE 0 END),0) AS mtd_rtb_prem,
        SUM(CASE WHEN b.LogStatusId = 6 AND b.cdate = @today THEN 1 ELSE 0 END) AS ftd_rtb_nop,
        ISNULL(SUM(CASE WHEN b.LogStatusId = 6 AND b.cdate = @today THEN b.premium ELSE 0 END),0) AS ftd_rtb_prem,
        -- CQB = MIS POLICY_STATUS_ID 7
        SUM(CASE WHEN b.policy_status_id = 7 THEN 1 ELSE 0 END) AS ytd_cqb_nop,
        ISNULL(SUM(CASE WHEN b.policy_status_id = 7 THEN b.premium ELSE 0 END),0) AS ytd_cqb_prem,
        SUM(CASE WHEN b.policy_status_id = 7 AND b.cdate >= @mtd THEN 1 ELSE 0 END) AS mtd_cqb_nop,
        ISNULL(SUM(CASE WHEN b.policy_status_id = 7 AND b.cdate >= @mtd THEN b.premium ELSE 0 END),0) AS mtd_cqb_prem,
        SUM(CASE WHEN b.policy_status_id = 7 AND b.cdate = @today THEN 1 ELSE 0 END) AS ftd_cqb_nop,
        ISNULL(SUM(CASE WHEN b.policy_status_id = 7 AND b.cdate = @today THEN b.premium ELSE 0 END),0) AS ftd_cqb_prem,
        -- Online = tracker present in Beeinsured motor-transaction table
        SUM(CASE WHEN b.in_txn = 1 THEN 1 ELSE 0 END) AS ytd_on_nop,
        ISNULL(SUM(CASE WHEN b.in_txn = 1 THEN b.premium ELSE 0 END),0) AS ytd_on_prem,
        SUM(CASE WHEN b.in_txn = 1 AND b.cdate >= @mtd THEN 1 ELSE 0 END) AS mtd_on_nop,
        ISNULL(SUM(CASE WHEN b.in_txn = 1 AND b.cdate >= @mtd THEN b.premium ELSE 0 END),0) AS mtd_on_prem,
        SUM(CASE WHEN b.in_txn = 1 AND b.cdate = @today THEN 1 ELSE 0 END) AS ftd_on_nop,
        ISNULL(SUM(CASE WHEN b.in_txn = 1 AND b.cdate = @today THEN b.premium ELSE 0 END),0) AS ftd_on_prem
      FROM #base b WHERE 1=1${cl.base};

      -- 7) By branch (for the branch-wise comparison chart)
      SELECT ISNULL(b.branch,'—') AS branch, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full} GROUP BY b.branch ORDER BY COUNT(*) DESC;

      -- 8) By agent (POS) — for Top 10 / Bottom 10 agent charts; name from tmp_poscodes
      SELECT b.agent_code AS code, MAX(pc.posfullname) AS name, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b
      LEFT JOIN Beeinsured_v3_2.dbo.tmp_poscodes pc WITH (NOLOCK) ON pc.upincode = b.agent_code
      WHERE 1=1${DATE_SEL}${cl.full} AND b.agent_code IS NOT NULL AND b.agent_code <> ''
      GROUP BY b.agent_code;

      -- 9) Month-on-month trend (NOP + premium per BUSINESS month, which runs
      --    2nd → 1st of next month — same as MTD; the business month of a date
      --    is the calendar month of (date - 1 day)). Dimension filters applied,
      --    date selection ignored so the full FY trend shows.
      SELECT YEAR(DATEADD(DAY,-1,b.cdate)) AS yr, MONTH(DATEADD(DAY,-1,b.cdate)) AS mo,
             COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b WHERE 1=1${cl.base}
      GROUP BY YEAR(DATEADD(DAY,-1,b.cdate)), MONTH(DATEADD(DAY,-1,b.cdate))
      ORDER BY YEAR(DATEADD(DAY,-1,b.cdate)), MONTH(DATEADD(DAY,-1,b.cdate));

      DROP TABLE #base; DROP TABLE #hemp;`;

    const result = await rq.query(batch);
    const recs = result.recordsets;
    const s = (recs[0] && recs[0][0]) || {};
    const vtRows = recs[1] || [];
    const empRows = recs[2] || [];
    const oRows = recs[3] || [];
    const listRows = recs[4] || [];
    const pr = (recs[5] && recs[5][0]) || {};
    const branchRows = recs[6] || [];
    const agentRows = recs[7] || [];
    const monthRows = recs[8] || [];
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const uniq = (arr) => [...new Set(arr.filter(v => v != null && v !== ''))].sort();
    const empMap = new Map();
    oRows.forEach(r => { if (r.employee_code) empMap.set(r.employee_code, r.employee_name || r.employee_code); });
    const periods = {
      fy_start: pr.fy_start, mtd_start: pr.mtd_start, today: pr.today,
      ytd: { nop: Number(pr.ytd_nop) || 0, premium: round(pr.ytd_prem), from: pr.fy_start, to: pr.today,
             ok_to_log: { nop: Number(pr.ytd_ok_nop) || 0, premium: round(pr.ytd_ok_prem) },
             uw_pending: { nop: Number(pr.ytd_uw_nop) || 0, premium: round(pr.ytd_uw_prem) },
             return_to_bops: { nop: Number(pr.ytd_rtb_nop) || 0, premium: round(pr.ytd_rtb_prem) },
             cqb: { nop: Number(pr.ytd_cqb_nop) || 0, premium: round(pr.ytd_cqb_prem) },
             online: { nop: Number(pr.ytd_on_nop) || 0, premium: round(pr.ytd_on_prem) } },
      mtd: { nop: Number(pr.mtd_nop) || 0, premium: round(pr.mtd_prem), from: pr.mtd_start, to: pr.today,
             ok_to_log: { nop: Number(pr.mtd_ok_nop) || 0, premium: round(pr.mtd_ok_prem) },
             uw_pending: { nop: Number(pr.mtd_uw_nop) || 0, premium: round(pr.mtd_uw_prem) },
             return_to_bops: { nop: Number(pr.mtd_rtb_nop) || 0, premium: round(pr.mtd_rtb_prem) },
             cqb: { nop: Number(pr.mtd_cqb_nop) || 0, premium: round(pr.mtd_cqb_prem) },
             online: { nop: Number(pr.mtd_on_nop) || 0, premium: round(pr.mtd_on_prem) } },
      ftd: { nop: Number(pr.ftd_nop) || 0, premium: round(pr.ftd_prem), from: pr.today, to: pr.today,
             ok_to_log: { nop: Number(pr.ftd_ok_nop) || 0, premium: round(pr.ftd_ok_prem) },
             uw_pending: { nop: Number(pr.ftd_uw_nop) || 0, premium: round(pr.ftd_uw_prem) },
             return_to_bops: { nop: Number(pr.ftd_rtb_nop) || 0, premium: round(pr.ftd_rtb_prem) },
             cqb: { nop: Number(pr.ftd_cqb_nop) || 0, premium: round(pr.ftd_cqb_prem) },
             online: { nop: Number(pr.ftd_on_nop) || 0, premium: round(pr.ftd_on_prem) } },
    };

    res.json({
      success: true, root, from, to, periods,
      summary: {
        nop: Number(s.nop) || 0, premium: round(s.premium),
        online_nop: Number(s.online_nop) || 0, online_premium: round(s.online_premium),
        offline_nop: Number(s.offline_nop) || 0, offline_premium: round(s.offline_premium),
      },
      by_vehicle_type: vtRows.map(r => ({ vehicle_type: r.vehicle_type, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      by_employee: empRows.map(r => ({ code: r.code, name: r.name || r.code, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      by_branch: branchRows.map(r => ({ branch: r.branch, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      by_agent: agentRows.map(r => ({ code: r.code, name: r.name || r.code, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      // Business months within the FY (drop the leading partial bucket — the
      // 1-Apr cases that fall in the previous FY's March business month).
      by_month: monthRows
        .filter(r => (Number(r.yr) > Number(String(pr.fy_start || '').slice(0, 4)))
                  || (Number(r.yr) === Number(String(pr.fy_start || '').slice(0, 4)) && Number(r.mo) >= 4))
        .map(r => ({ label: `${MON[(Number(r.mo) || 1) - 1]} ${r.yr}`, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      options: {
        verticals: uniq(oRows.map(r => r.vertical)),
        branches: uniq(oRows.map(r => r.branch)),
        sub_branches: uniq(oRows.map(r => r.sub_branch)),
        agents: uniq(oRows.map(r => r.agent_code)),
        vehicle_types: uniq(oRows.map(r => r.vehicle_type)),
        employees: [...empMap.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => (a.name > b.name ? 1 : -1)),
      },
      truncated: listRows.length >= LIST_CAP,
      cases: listRows.map(r => ({
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
