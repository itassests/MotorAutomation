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
const { getPool } = require('../db/connection');
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
// PERF: #base is materialised for EVERY policy in the subtree (~42.5k rows for a
// company-wide root) and every column here is written to tempdb — twice, once per
// attribution branch. Measured: the joins cost 3.8s but the SELECT INTO cost 20s,
// so ROW WIDTH, not the joins, was the dashboard's bottleneck. Columns needed only
// by the capped case list (customer / policy_no / reg_no / created_dt / channel /
// status) are therefore NOT carried here — result set 5 re-joins them for its
// 1000 rows. Keep this list narrow: anything added here is paid 42.5k times.
const baseCols = (scope) => `
      m.Id AS _id, m.TrackerNo,
      CAST(m.CREATED_DATE AS date) AS cdate,
      m.NatureOfSale, m.LogStatusId, mis.POLICY_STATUS_ID AS policy_status_id,
      CASE WHEN mt.PTrackerno IS NOT NULL THEN 1 ELSE 0 END AS in_txn,
      f1.Name AS vertical, msb.Location AS branch, mssb.Sub_Location AS sub_branch,
      ISNULL(r.IDVpos, r.UPIN_CODE) AS agent_code,
      up.EmployeeCode AS employee_code, up.DisplayName AS employee_name,
      f3.Name AS vehicle_type, f5.Name AS product_type,
      i.CompanyName AS insurer,
      md.RTO_Code AS rto, md.StateName AS state,
      CASE WHEN ISNULL(md.NCB, 0) > 0 THEN 1 ELSE 0 END AS has_ncb,
      CASE WHEN ISNULL(md.Addon_Premium, 0) > 0 OR ISNULL(md.ADD_ON_PREMIUM, 0) > 0 THEN 1 ELSE 0 END AS has_addon,
      -- Renewal: IsRenewal flag; same/different insurer compares the OCR-captured
      -- expiring insurer (OCR_Insurer id) against the current insurer (r.InsurerId).
      ISNULL(m.IsRenewal, 0) AS is_renewal,
      CASE WHEN ISNULL(m.IsRenewal, 0) = 1 AND TRY_CONVERT(int, m.OCR_Insurer) = r.InsurerId THEN 1 ELSE 0 END AS renewal_same,
      CASE WHEN ISNULL(m.IsRenewal, 0) = 1 AND TRY_CONVERT(int, m.OCR_Insurer) IS NOT NULL AND r.InsurerId IS NOT NULL AND TRY_CONVERT(int, m.OCR_Insurer) <> r.InsurerId THEN 1 ELSE 0 END AS renewal_diff,
      TRY_CONVERT(int, m.OCR_Insurer) AS prev_insurer_id,
      CASE WHEN m.InsuranceType IN (16, 17) THEN 1 ELSE 0 END AS is_motor,
      -- Motor premium lives in motor-details; non-motor premium in Beeinsured RF (deduped).
      -- Motor-only scope (the default) skips the cross-DB RF join entirely for speed.
      ${scope === 'motor'
        ? 'ISNULL(md.ANNUAL_PREMIUM, 0) AS premium'
        : 'CASE WHEN m.InsuranceType IN (16, 17) THEN ISNULL(md.ANNUAL_PREMIUM, 0) ELSE ISNULL(rfp.prem, 0) END AS premium'}`;
// Head joins. Motor-only scope uses INNER md (every motor policy has details) and
// omits the heavy Beeinsured RF group-by; wider scopes use LEFT md + the RF join.
const joinsHead = (scope) => `
    FROM TRN_PrarambhMain m WITH (NOLOCK)
    ${scope === 'motor'
      ? 'INNER JOIN TRN_PrarambhMotorDetails md WITH (NOLOCK) ON md.PrarambhMainId = m.Id AND md.ISACTIVE = 1'
      : `LEFT JOIN TRN_PrarambhMotorDetails md WITH (NOLOCK) ON md.PrarambhMainId = m.Id AND md.ISACTIVE = 1
    LEFT JOIN (SELECT CurrentTrackerNo, MAX(ISNULL(NULLIF(AnnualPremium, 0), TotalPremium)) AS prem
               FROM Beeinsured_v3_2.dbo.TRN_ReportedFieldsPrarambh WITH (NOLOCK)
               WHERE CurrentTrackerNo IS NOT NULL GROUP BY CurrentTrackerNo) rfp ON rfp.CurrentTrackerNo = m.TrackerNo`}
    -- (Proposer is NOT joined here — customer is only needed by the capped case
    --  list, which re-joins it for its own rows. See the baseCols perf note.)
    LEFT JOIN TRN_PrarambhReportedFields r WITH (NOLOCK) ON r.PrarambhMainId = m.Id AND r.ISACTIVE = 1
    LEFT JOIN TRN_PrarambhMotorMISUpdation mis WITH (NOLOCK) ON mis.PrarambhMainId = m.Id AND mis.ISACTIVE = 1
    LEFT JOIN RH_InsurerMast i WITH (NOLOCK) ON i.insid = r.InsurerId`;
const JOINS_TAIL = `
    LEFT JOIN MST_FieldMasters f1 WITH (NOLOCK) ON f1.MasterId = 4040 AND f1.Value = m.Vertical
    LEFT JOIN MST_FieldMasters f3 WITH (NOLOCK) ON f3.MasterId = 9210 AND f3.Value = md.VEHICAL_TYPE_Id
    LEFT JOIN MST_FieldMasters f5 WITH (NOLOCK) ON f5.MasterId = 9220 AND f5.Value = r.Product_Type_Id
    -- (channel/status FieldMasters are NOT joined here — case-list only.)
    LEFT JOIN MST_SalesBranch msb WITH (NOLOCK) ON msb.id = r.SALES_BRANCH_Id
    LEFT JOIN MST_SalesSubBranch mssb WITH (NOLOCK) ON mssb.id = r.SALES_SUB_BRANCH_Id
    LEFT JOIN (SELECT DISTINCT PTrackerno FROM Beeinsured_v3_2.dbo.TRN_MotorTransactionForPrarambh WITH (NOLOCK)
               WHERE PTrackerno IS NOT NULL AND PTrackerno <> 'DUMMY' AND TransactionDate >= @fy) mt ON mt.PTrackerno = m.TrackerNo`;
// Scope-filter at materialization: motor-only (the default) keeps #base small and
// fast; nonmotor/all widen it. This is the primary driver of dashboard load time.
const baseWhere = (scope) => `${scope === 'motor' ? 'm.InsuranceType IN (16, 17) AND ' : scope === 'nonmotor' ? 'm.InsuranceType NOT IN (16, 17) AND ' : ''}m.IsActive = 1
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
const ctes = (scope) => `
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
      SELECT ${baseCols(scope)}
      ${joinsHead(scope)}
      INNER JOIN (SELECT DISTINCT EmployeeCode FROM hier) hh ON hh.EmployeeCode = CONVERT(varchar(50), m.ReportingEmployeeCode)
      LEFT JOIN BugNet_UserProfiles up WITH (NOLOCK) ON up.EmployeeCode = CONVERT(varchar(50), m.ReportingEmployeeCode)
      ${JOINS_TAIL}
      WHERE ${baseWhere(scope)} AND m.ReportingEmployeeCode IS NOT NULL
      UNION ALL
      -- B) online cases (no ReportingEmployeeCode) → referring employee via POS code
      SELECT ${baseCols(scope)}
      ${joinsHead(scope)}
      INNER JOIN Beeinsured_v3_2.dbo.tmp_poscodes pc WITH (NOLOCK) ON pc.upincode = ISNULL(r.IDVpos, r.UPIN_CODE) AND pc.referal_code <> 'Direct'
      INNER JOIN (SELECT DISTINCT EmployeeCode FROM hier) hh ON hh.EmployeeCode = pc.referal_code
      LEFT JOIN BugNet_UserProfiles up WITH (NOLOCK) ON up.EmployeeCode = pc.referal_code
      ${JOINS_TAIL}
      WHERE ${baseWhere(scope)} AND m.ReportingEmployeeCode IS NULL
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
  if (q.product)      { rq.input('product', sql.NVarChar(200), q.product); both('b.product_type = @product'); }
  if (q.insurer)      { rq.input('insurer', sql.NVarChar(300), q.insurer); both('b.insurer = @insurer'); }
  // Motor / Non-Motor scope. Default = motor, so the existing Business Dashboard
  // (which sends no scope) stays motor-only. 'nonmotor' / 'all' opt into the wider base.
  const scope = String(q.scope || 'motor').toLowerCase();
  if (scope === 'motor')         both('b.is_motor = 1');
  else if (scope === 'nonmotor') both('b.is_motor = 0');
  // scope === 'all' → no motor filter
  const ncb = String(q.ncb || '').toLowerCase();
  if (ncb === 'ncb')    both('b.has_ncb = 1');
  if (ncb === 'nonncb') both('b.has_ncb = 0');
  const addon = String(q.addon || '').toLowerCase();
  if (addon === 'addon')   both('b.has_addon = 1');
  if (addon === 'noaddon') both('b.has_addon = 0');
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
    const scope = String(q.scope || 'motor').toLowerCase();
    const batch = `
      ${DECLARES}
      IF OBJECT_ID('tempdb..#base') IS NOT NULL DROP TABLE #base;
      IF OBJECT_ID('tempdb..#hemp') IS NOT NULL DROP TABLE #hemp;
      ${HEMP_SQL}
      ${ctes(scope)}
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
        COUNT(b.TrackerNo) AS nop, ISNULL(SUM(b.premium),0) AS premium,
        SUM(CASE WHEN b.cdate >= @mtd THEN 1 ELSE 0 END) AS mtd_nop,
        ISNULL(SUM(CASE WHEN b.cdate >= @mtd THEN b.premium ELSE 0 END),0) AS mtd_premium
      FROM #hemp he
      LEFT JOIN #base b ON b.employee_code = he.code${DATE_SEL}${cl.full}
      GROUP BY he.code, he.name ORDER BY COUNT(b.TrackerNo) DESC;

      -- 4) Filter options (whole hierarchy, no optional filters)
      SELECT DISTINCT b.vertical, b.branch, b.sub_branch, b.agent_code, b.vehicle_type, b.employee_code, b.employee_name
      FROM #base b;

      -- 5) Case list (capped). customer / policy_no / reg_no / created_dt /
      --    channel / status are needed ONLY here, so they are NOT carried in
      --    #base (writing those wide columns for every row was ~16s of tempdb
      --    for a company-wide root). Re-join them for just these ${LIST_CAP} rows.
      SELECT TOP ${LIST_CAP}
        b.TrackerNo AS tracker_no, m.CREATED_DATE AS created_date, fn.Name AS channel,
        CASE WHEN b.NatureOfSale IN ${ONLINE_SET} THEN 1 ELSE 0 END AS is_online,
        b.vertical, b.branch, b.sub_branch, b.agent_code, b.employee_code, b.employee_name,
        b.vehicle_type, b.product_type, b.insurer, p.FULLNAME_PROPOSER AS customer,
        mis.POLICY_NO AS policy_no, md.VEHICLE_REGISTRATION_NO AS reg_no,
        b.rto, b.state, b.premium, ff.Name AS status
      FROM #base b
      JOIN TRN_PrarambhMain m WITH (NOLOCK) ON m.Id = b._id
      LEFT JOIN TRN_PrarambhProposerDetails p WITH (NOLOCK) ON p.PrarambhMainId = b._id AND p.ISACTIVE = 1
      LEFT JOIN TRN_PrarambhMotorMISUpdation mis WITH (NOLOCK) ON mis.PrarambhMainId = b._id AND mis.ISACTIVE = 1
      LEFT JOIN TRN_PrarambhMotorDetails md WITH (NOLOCK) ON md.PrarambhMainId = b._id AND md.ISACTIVE = 1
      LEFT JOIN MST_FieldMasters fn WITH (NOLOCK) ON fn.MasterId = 4030 AND fn.Value = m.NatureOfSale
      LEFT JOIN MST_FieldMasters ff WITH (NOLOCK) ON ff.MasterId = 8050 AND ff.Value = m.FinalStatus
      WHERE 1=1${DATE_SEL}${cl.full} ORDER BY m.CREATED_DATE DESC;

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
      SELECT b.agent_code AS code, MAX(pc.posfullname) AS name, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium,
        SUM(CASE WHEN b.cdate >= @mtd THEN 1 ELSE 0 END) AS mtd_nop,
        ISNULL(SUM(CASE WHEN b.cdate >= @mtd THEN b.premium ELSE 0 END),0) AS mtd_premium
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

      -- 10) Tree: Branch → Sub-branch → Employee (tree-wise business view)
      SELECT ISNULL(b.branch,'—') AS branch, ISNULL(b.sub_branch,'—') AS sub_branch,
             ISNULL(b.employee_code,'—') AS emp_code, MAX(ISNULL(b.employee_name, b.employee_code)) AS emp_name,
             COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full}
      GROUP BY b.branch, b.sub_branch, b.employee_code
      ORDER BY b.branch, b.sub_branch, COUNT(*) DESC;

      -- 11) By insurer
      SELECT ISNULL(b.insurer,'—') AS k, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full} GROUP BY b.insurer ORDER BY COUNT(*) DESC;

      -- 12) By product type
      SELECT ISNULL(b.product_type,'—') AS k, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full} GROUP BY b.product_type ORDER BY COUNT(*) DESC;

      -- 13) By state. StateName is blank on ~90% of rows (source-data gap) and
      --     NULL vs '' would otherwise show as two separate "—" rows — collapse
      --     every blank/whitespace value into one honest "Unknown" bucket.
      SELECT ISNULL(NULLIF(LTRIM(RTRIM(b.state)), ''), 'Unknown') AS k, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full}
      GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(b.state)), ''), 'Unknown') ORDER BY COUNT(*) DESC;

      -- 14) By RTO (with its state)
      SELECT b.rto AS k, MAX(ISNULL(b.state,'—')) AS state, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full} AND b.rto IS NOT NULL AND b.rto <> '' GROUP BY b.rto ORDER BY COUNT(*) DESC;

      -- 15) Business evaluation — per-agent activity (dormancy: had business last
      --     month but 0 this month; or no business in the last 2 months).
      SELECT b.agent_code AS code, MAX(pc.posfullname) AS name,
        SUM(CASE WHEN b.cdate >= @mtd THEN 1 ELSE 0 END) AS cur_nop,
        SUM(CASE WHEN b.cdate >= DATEADD(MONTH,-1,@mtd) AND b.cdate < @mtd THEN 1 ELSE 0 END) AS prev_nop,
        SUM(CASE WHEN b.cdate >= DATEADD(MONTH,-2,@mtd) AND b.cdate < DATEADD(MONTH,-1,@mtd) THEN 1 ELSE 0 END) AS prev2_nop,
        CONVERT(varchar(10), MAX(b.cdate), 23) AS last_biz,
        COUNT(*) AS ytd_nop, ISNULL(SUM(b.premium),0) AS ytd_prem
      FROM #base b
      LEFT JOIN Beeinsured_v3_2.dbo.tmp_poscodes pc WITH (NOLOCK) ON pc.upincode = b.agent_code
      WHERE b.agent_code IS NOT NULL AND b.agent_code <> ''${cl.base}
      GROUP BY b.agent_code;

      -- 16) POS Active-vs-Total (#18). TOTAL = live POS (deactivateddate IS NULL)
      --     whose referal_code rolls up to this hierarchy. PRODUCING = that POS has
      --     >=1 policy anywhere in #base (this FY). IDLE = live POS, no policy found.
      SELECT COUNT(*) AS total_pos,
        SUM(CASE WHEN bp.agent_code IS NOT NULL THEN 1 ELSE 0 END) AS producing_pos
      FROM Beeinsured_v3_2.dbo.tmp_poscodes pc WITH (NOLOCK)
      INNER JOIN #hemp he ON he.code = pc.referal_code
      LEFT JOIN (SELECT DISTINCT agent_code FROM #base WHERE agent_code IS NOT NULL AND agent_code <> '') bp
        ON bp.agent_code = pc.upincode
      WHERE pc.deactivateddate IS NULL;

      -- 17) Filter combinations — drives cascading dropdowns (branch/sub/employee/
      --     vehicle/product/insurer). One row per distinct combo actually present.
      SELECT DISTINCT ISNULL(b.branch,'') AS branch, ISNULL(b.sub_branch,'') AS sub_branch,
        ISNULL(b.employee_code,'') AS emp_code, ISNULL(b.employee_name, b.employee_code) AS emp_name,
        ISNULL(b.vehicle_type,'') AS vehicle_type, ISNULL(b.product_type,'') AS product, ISNULL(b.insurer,'') AS insurer
      FROM #base b;

      -- 18) Renewal summary (#16). renewed vs new; renewed split same/different insurer.
      SELECT
        SUM(CASE WHEN b.is_renewal=1 THEN 1 ELSE 0 END) AS renewed_nop,
        ISNULL(SUM(CASE WHEN b.is_renewal=1 THEN b.premium ELSE 0 END),0) AS renewed_premium,
        SUM(CASE WHEN b.is_renewal=0 THEN 1 ELSE 0 END) AS new_nop,
        ISNULL(SUM(CASE WHEN b.is_renewal=0 THEN b.premium ELSE 0 END),0) AS new_premium,
        SUM(b.renewal_same) AS same_nop, ISNULL(SUM(CASE WHEN b.renewal_same=1 THEN b.premium ELSE 0 END),0) AS same_premium,
        SUM(b.renewal_diff) AS diff_nop, ISNULL(SUM(CASE WHEN b.renewal_diff=1 THEN b.premium ELSE 0 END),0) AS diff_premium,
        SUM(CASE WHEN b.is_renewal=1 AND b.renewal_same=0 AND b.renewal_diff=0 THEN 1 ELSE 0 END) AS unknown_nop
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full};

      -- 19) Different-insurer renewals — which insurer they switched FROM.
      SELECT ISNULL(i.CompanyName,'—') AS k, COUNT(*) AS nop, ISNULL(SUM(b.premium),0) AS premium
      FROM #base b LEFT JOIN RH_InsurerMast i WITH (NOLOCK) ON i.insid = b.prev_insurer_id
      WHERE b.renewal_diff=1${DATE_SEL}${cl.full} GROUP BY i.CompanyName ORDER BY COUNT(*) DESC;

      -- 20) Renewals by month.
      SELECT CONVERT(varchar(7), b.cdate, 126) AS ym,
        SUM(CASE WHEN b.is_renewal=1 THEN 1 ELSE 0 END) AS renewed_nop,
        SUM(b.renewal_same) AS same_nop, SUM(b.renewal_diff) AS diff_nop,
        SUM(CASE WHEN b.is_renewal=0 THEN 1 ELSE 0 END) AS new_nop
      FROM #base b WHERE 1=1${DATE_SEL}${cl.full} GROUP BY CONVERT(varchar(7), b.cdate, 126) ORDER BY ym;

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
    const treeRows = recs[9] || [];
    const insurerRows = recs[10] || [];
    const productRows = recs[11] || [];
    const stateRows = recs[12] || [];
    const rtoRows = recs[13] || [];
    const evalRows = recs[14] || [];
    const posStat = (recs[15] && recs[15][0]) || {};
    const filterRows = recs[16] || [];
    const renew = (recs[17] && recs[17][0]) || {};
    const renewFromRows = recs[18] || [];
    const renewMonthRows = recs[19] || [];
    const kv = (arr) => arr.map(r => ({ k: r.k || '—', nop: Number(r.nop) || 0, premium: round(r.premium) }));
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
      by_employee: empRows.map(r => ({ code: r.code, name: r.name || r.code, nop: Number(r.nop) || 0, premium: round(r.premium), mtd_nop: Number(r.mtd_nop) || 0, mtd_premium: round(r.mtd_premium) })),
      by_branch: branchRows.map(r => ({ branch: r.branch, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      by_agent: agentRows.map(r => ({ code: r.code, name: r.name || r.code, nop: Number(r.nop) || 0, premium: round(r.premium), mtd_nop: Number(r.mtd_nop) || 0, mtd_premium: round(r.mtd_premium) })),
      // Business months within the FY (drop the leading partial bucket — the
      // 1-Apr cases that fall in the previous FY's March business month).
      by_month: monthRows
        .filter(r => (Number(r.yr) > Number(String(pr.fy_start || '').slice(0, 4)))
                  || (Number(r.yr) === Number(String(pr.fy_start || '').slice(0, 4)) && Number(r.mo) >= 4))
        .map(r => ({ label: `${MON[(Number(r.mo) || 1) - 1]} ${r.yr}`, nop: Number(r.nop) || 0, premium: round(r.premium) })),
      by_insurer: kv(insurerRows),
      by_product: kv(productRows),
      by_state: kv(stateRows),
      renewals: {
        renewed_nop: Number(renew.renewed_nop) || 0, renewed_premium: round(renew.renewed_premium),
        new_nop: Number(renew.new_nop) || 0, new_premium: round(renew.new_premium),
        same_nop: Number(renew.same_nop) || 0, same_premium: round(renew.same_premium),
        diff_nop: Number(renew.diff_nop) || 0, diff_premium: round(renew.diff_premium),
        unknown_nop: Number(renew.unknown_nop) || 0,
        from_insurers: kv(renewFromRows),
        by_month: renewMonthRows.map(r => ({ ym: r.ym, renewed: Number(r.renewed_nop) || 0, same: Number(r.same_nop) || 0, diff: Number(r.diff_nop) || 0, new_nop: Number(r.new_nop) || 0 })),
      },
      by_rto: rtoRows.map(r => ({ k: r.k || '—', state: r.state || '—', nop: Number(r.nop) || 0, premium: round(r.premium) })),
      filter_rows: filterRows.map(r => ({
        branch: r.branch || '', sub_branch: r.sub_branch || '', emp_code: r.emp_code || '', emp_name: r.emp_name || r.emp_code || '',
        vehicle_type: r.vehicle_type || '', product: r.product || '', insurer: r.insurer || '',
      })),
      agent_pos: {
        total: Number(posStat.total_pos) || 0,
        producing: Number(posStat.producing_pos) || 0,
        idle: Math.max(0, (Number(posStat.total_pos) || 0) - (Number(posStat.producing_pos) || 0)),
      },
      agent_activity: evalRows.map(r => ({
        code: r.code, name: r.name || r.code,
        cur_nop: Number(r.cur_nop) || 0, prev_nop: Number(r.prev_nop) || 0, prev2_nop: Number(r.prev2_nop) || 0,
        last_biz: r.last_biz || null, ytd_nop: Number(r.ytd_nop) || 0, ytd_premium: round(r.ytd_prem),
      })),
      tree: treeRows.map(r => ({
        branch: r.branch || '—', sub_branch: r.sub_branch || '—',
        emp_code: r.emp_code || '—', emp_name: r.emp_name || r.emp_code || '—',
        nop: Number(r.nop) || 0, premium: round(r.premium),
      })),
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

// ---------------------------------------------------------------------------
//  GET /api/employee/compare — Current vs Previous period (MTD & YTD).
//  Prev-MTD = the previous business month, same day-of-month window.
//  Prev-YTD = the previous FY, from its 1-Apr up to (today − 1 year).
//  Each bucket returns total {nop, premium} and the Ok-to-Log {nop, premium}.
//  Built for #4/#5 (current-vs-prev Ok-to-Log + growth %). Reuses the same
//  hierarchy base with a WIDENED date window (prev-FY start → today).
// ---------------------------------------------------------------------------
const ctesCmp = (scope) => ctes(scope).replace(/BETWEEN @fy AND @today/g, 'BETWEEN @pfy AND @today');

router.get('/compare', async (req, res, next) => {
  try {
    const root = rootEmpFor(req);
    if (!root) return res.status(400).json({ success: false, error: 'No employee code on this login' });
    const q = req.query;
    const pool = await getPrarambhPool();
    const round = (n) => +Number(n || 0).toFixed(2);
    const rq = pool.request();
    rq.input('emp', sql.VarChar(50), root);
    // dimension filters (no date / no status — periods are computed in SQL)
    let dim = '';
    const addDim = (name, type, val, col) => { if (val) { rq.input(name, type, val); dim += ` AND ${col} = @${name}`; } };
    addDim('vertical', sql.NVarChar(300), q.vertical, 'b.vertical');
    addDim('branch', sql.NVarChar(300), q.branch, 'b.branch');
    addDim('sub_branch', sql.NVarChar(300), q.sub_branch, 'b.sub_branch');
    addDim('agent', sql.NVarChar(100), q.agent, 'b.agent_code');
    addDim('employee', sql.NVarChar(50), q.employee, 'b.employee_code');
    addDim('vehicle_type', sql.NVarChar(200), q.vehicle_type, 'b.vehicle_type');
    addDim('product', sql.NVarChar(200), q.product, 'b.product_type');
    addDim('insurer', sql.NVarChar(300), q.insurer, 'b.insurer');
    const ncb = String(q.ncb || '').toLowerCase();
    if (ncb === 'ncb') dim += ' AND b.has_ncb = 1'; else if (ncb === 'nonncb') dim += ' AND b.has_ncb = 0';
    const ad = String(q.addon || '').toLowerCase();
    if (ad === 'addon') dim += ' AND b.has_addon = 1'; else if (ad === 'noaddon') dim += ' AND b.has_addon = 0';
    const ch = String(q.channel || '').toLowerCase();
    if (ch === 'online')  dim += ` AND b.NatureOfSale IN ${ONLINE_SET}`;
    if (ch === 'offline') dim += ` AND (b.NatureOfSale NOT IN ${ONLINE_SET} OR b.NatureOfSale IS NULL)`;
    const scope = String(q.scope || 'motor').toLowerCase();
    if (scope === 'motor') dim += ' AND b.is_motor = 1'; else if (scope === 'nonmotor') dim += ' AND b.is_motor = 0';

    const bucket = (alias, lo, hi) => `
      SUM(CASE WHEN b.cdate BETWEEN ${lo} AND ${hi} THEN 1 ELSE 0 END) AS ${alias}_nop,
      ISNULL(SUM(CASE WHEN b.cdate BETWEEN ${lo} AND ${hi} THEN b.premium ELSE 0 END),0) AS ${alias}_prem,
      SUM(CASE WHEN b.cdate BETWEEN ${lo} AND ${hi} AND b.LogStatusId = 2 THEN 1 ELSE 0 END) AS ${alias}_ok_nop,
      ISNULL(SUM(CASE WHEN b.cdate BETWEEN ${lo} AND ${hi} AND b.LogStatusId = 2 THEN b.premium ELSE 0 END),0) AS ${alias}_ok_prem`;

    const batch = `
      DECLARE @today date = CAST(GETDATE() AS date);
      DECLARE @fy date = DATEFROMPARTS(CASE WHEN MONTH(@today) >= 4 THEN YEAR(@today) ELSE YEAR(@today) - 1 END, 4, 1);
      DECLARE @mtd date = CASE WHEN DAY(@today) >= 2 THEN DATEFROMPARTS(YEAR(@today), MONTH(@today), 2)
                               ELSE DATEADD(MONTH, -1, DATEFROMPARTS(YEAR(@today), MONTH(@today), 2)) END;
      DECLARE @pfy date = DATEADD(YEAR, -1, @fy);
      DECLARE @pmtd date = DATEADD(MONTH, -1, @mtd);
      DECLARE @pmtd_end date = DATEADD(DAY, -1, @mtd);
      DECLARE @pytd_end date = DATEADD(YEAR, -1, @today);
      IF OBJECT_ID('tempdb..#cbase') IS NOT NULL DROP TABLE #cbase;
      ${ctesCmp(scope)}
      SELECT * INTO #cbase FROM base WHERE rn = 1${OPT};
      SELECT
        CONVERT(varchar(10), @fy, 23) AS fy_start, CONVERT(varchar(10), @today, 23) AS today,
        CONVERT(varchar(10), @mtd, 23) AS mtd_start,
        CONVERT(varchar(10), @pmtd, 23) AS pmtd_start, CONVERT(varchar(10), @pmtd_end, 23) AS pmtd_end,
        CONVERT(varchar(10), @pfy, 23) AS pfy_start, CONVERT(varchar(10), @pytd_end, 23) AS pytd_end,
        ${bucket('cm', '@mtd', '@today')},
        ${bucket('pm', '@pmtd', '@pmtd_end')},
        ${bucket('cy', '@fy', '@today')},
        ${bucket('py', '@pfy', '@pytd_end')}
      FROM #cbase b WHERE 1=1${dim};
      DROP TABLE #cbase;`;

    const result = await rq.query(batch);
    const r = (result.recordsets[result.recordsets.length - 1] || [])[0] || {};
    const buk = (a) => ({
      nop: Number(r[a + '_nop']) || 0, premium: round(r[a + '_prem']),
      ok_to_log: { nop: Number(r[a + '_ok_nop']) || 0, premium: round(r[a + '_ok_prem']) },
    });
    res.json({
      success: true, root,
      mtd: { current: buk('cm'), previous: buk('pm'),
             cur_range: [r.mtd_start, r.today], prev_range: [r.pmtd_start, r.pmtd_end] },
      ytd: { current: buk('cy'), previous: buk('py'),
             cur_range: [r.fy_start, r.today], prev_range: [r.pfy_start, r.pytd_end] },
    });
  } catch (err) { next(err); }
});

// ── #14 Margin by level ─────────────────────────────────────────────────────
//  GET /api/employee/margin-by-level?cycle_id=
//  Margin is only computed inside payout cycles (cycle_bulk_rows.row_json holds
//  rate_pct / margin_pct / outgoing per policy). We attribute each row's margin
//  to the POS-owner (agent_code → tmp_poscodes.referal_code → an EmployeeCode),
//  then roll it UP the reporting chain and group nodes by their Designation so
//  you see margin at each org tier (Regional / Branch / RM / Team Lead).
//    margin ₹ = premium_base × margin_pct%   income ₹ = premium × rate_pct%
//    payout ₹ = outgoing (premium × outgoing_pct%)
const DESIG_LEVELS = [
  { level: 'Regional',              order: 1, re: /region|zonal|\bzone\b|territory|\barea\b/i },
  { level: 'Branch / Location Head', order: 2, re: /branch|center\s*manager|centre\s*manager|location\s*head|\blh\b/i },
  { level: 'Relationship Manager',  order: 3, re: /relationship\s*manager|\brm\b|sales\s*manager/i },
  { level: 'Team Lead',             order: 4, re: /team\s*(leader|manager)|\btl\b/i },
];
function levelFor(desig) {
  const d = String(desig || '').trim();
  if (!d) return { level: 'Frontline / POS-owner', order: 5 };
  for (const m of DESIG_LEVELS) if (m.re.test(d)) return { level: m.level, order: m.order };
  return { level: 'Other', order: 6 };
}

router.get('/margin-by-level', async (req, res, next) => {
  try {
    const root = rootEmpFor(req);
    if (!root) return res.status(400).json({ success: false, error: 'No employee code on this login' });
    const rxPool = await getPool();
    const prPool = await getPrarambhPool();
    const round = (n) => +Number(n || 0).toFixed(2);

    // 1) Cycle list (only cycles that have rows) + resolve the selected/default cycle.
    const cyc = await rxPool.request().query(`
      SELECT pc.id, pc.name, pc.date_from, pc.date_to,
             (SELECT COUNT(*) FROM cycle_bulk_rows cb WHERE cb.cycle_id = pc.id) AS rows
      FROM payout_cycles pc
      WHERE EXISTS (SELECT 1 FROM cycle_bulk_rows cb WHERE cb.cycle_id = pc.id)
      ORDER BY pc.date_to DESC`);
    const cycles = cyc.recordset.map(c => ({
      id: c.id, name: c.name,
      date_from: c.date_from ? c.date_from.toISOString().slice(0, 10) : null,
      date_to: c.date_to ? c.date_to.toISOString().slice(0, 10) : null, rows: c.rows,
    }));
    if (!cycles.length) return res.json({ success: true, root, cycles: [], cycle: null, levels: [], totals: {} });
    // default = latest past cycle with rows; else the newest with rows
    const todayIso = new Date().toISOString().slice(0, 10);
    let cycleId = parseInt(req.query.cycle_id, 10);
    if (!cycleId || !cycles.some(c => c.id === cycleId)) {
      const past = cycles.filter(c => (c.date_from || '9999') <= todayIso);
      cycleId = (past[0] || cycles[0]).id;
    }
    const cycle = cycles.find(c => c.id === cycleId);

    // 2) Cycle rows → per-poscode margin/income/payout/premium/nop.
    const rowsRs = await rxPool.request().input('cid', sql.Int, cycleId).query(`
      SELECT agent_code, row_json, rate_pct_override, margin_pct_override, outgoing_pct_override, excluded
      FROM cycle_bulk_rows WHERE cycle_id = @cid AND ISNULL(excluded, 0) = 0 AND agent_code IS NOT NULL`);
    const posAgg = new Map(); // poscode → {margin,income,payout,premium,nop}
    for (const r of rowsRs.recordset) {
      let j = {}; try { j = JSON.parse(r.row_json || '{}'); } catch { /* skip */ }
      const premium = Number(j.premium_base || j.net_premium || 0);
      const ratePct = r.rate_pct_override != null ? Number(r.rate_pct_override) : Number(j.rate_pct || 0);
      const marginPct = r.margin_pct_override != null ? Number(r.margin_pct_override) : Number(j.effective_margin_pct != null ? j.effective_margin_pct : j.margin_pct || 0);
      const payout = r.outgoing_pct_override != null ? premium * Number(r.outgoing_pct_override) / 100 : Number(j.outgoing || 0);
      const income = premium * ratePct / 100;
      const margin = premium * marginPct / 100;
      const code = String(r.agent_code);
      const a = posAgg.get(code) || { margin: 0, income: 0, payout: 0, premium: 0, nop: 0 };
      a.margin += margin; a.income += income; a.payout += payout; a.premium += premium; a.nop += 1;
      posAgg.set(code, a);
    }

    // 3) Subtree roster (EmployeeCode → manager, name, designation) rooted at `root`.
    const rosterRs = await prPool.request().input('emp', sql.VarChar(50), root).query(`
      ;WITH hier AS (
        SELECT EmployeeCode, reportingmgremployeecode, DisplayName, Designation, Location,
               CAST('|' + EmployeeCode + '|' AS VARCHAR(8000)) AS path
        FROM BugNet_UserProfiles WITH (NOLOCK)
        WHERE EmployeeCode = @emp AND IsActive = 1 AND IsValid = 1
        UNION ALL
        SELECT c.EmployeeCode, c.reportingmgremployeecode, c.DisplayName, c.Designation, c.Location,
               CAST(h.path + c.EmployeeCode + '|' AS VARCHAR(8000))
        FROM BugNet_UserProfiles c WITH (NOLOCK)
        INNER JOIN hier h ON c.reportingmgremployeecode = h.EmployeeCode
        WHERE c.IsActive = 1 AND c.IsValid = 1 AND CHARINDEX('|' + c.EmployeeCode + '|', h.path) = 0
      )
      SELECT EmployeeCode AS code, MAX(reportingmgremployeecode) AS mgr,
             MAX(DisplayName) AS name, MAX(Designation) AS designation, MAX(Location) AS location
      FROM hier GROUP BY EmployeeCode OPTION (MAXRECURSION 1000);`);
    const roster = new Map(); // code → {mgr,name,designation,location}
    for (const r of rosterRs.recordset) roster.set(String(r.code), { mgr: r.mgr ? String(r.mgr) : null, name: r.name, designation: r.designation, location: r.location });

    // 4) poscode → owning EmployeeCode (tmp_poscodes.referal_code).
    const posMapRs = await prPool.request().query(`
      SELECT upincode, referal_code FROM Beeinsured_v3_2.dbo.tmp_poscodes WITH (NOLOCK)
      WHERE upincode IS NOT NULL AND referal_code IS NOT NULL`);
    const posOwner = new Map();
    for (const r of posMapRs.recordset) if (!posOwner.has(String(r.upincode))) posOwner.set(String(r.upincode), String(r.referal_code));

    // 5) Roll up. For each poscode walk owner→root, then attribute its margin to
    //    the NEAREST ancestor of EACH level (not every ancestor). That way a policy
    //    lands on exactly one node per level, so summing a level's nodes counts each
    //    policy once — no double-count when a level has nested nodes (e.g. a chain of
    //    frontline POS-owners, or an RM reporting to a senior RM).
    const nodeAgg = new Map(); // code → {margin,income,payout,premium,nop}
    const nodeLevel = new Map(); // code → level info
    const bump = (code, info, a) => {
      const n = nodeAgg.get(code) || { margin: 0, income: 0, payout: 0, premium: 0, nop: 0 };
      n.margin += a.margin; n.income += a.income; n.payout += a.payout; n.premium += a.premium; n.nop += a.nop;
      nodeAgg.set(code, n); nodeLevel.set(code, info);
    };
    let unattributed = { margin: 0, income: 0, payout: 0, premium: 0, nop: 0 };
    for (const [poscode, a] of posAgg) {
      const owner = posOwner.get(poscode);
      if (!owner || !roster.has(owner)) { ['margin', 'income', 'payout', 'premium', 'nop'].forEach(k => unattributed[k] += a[k]); continue; }
      // build chain owner..root (nearest first)
      const chain = []; let node = owner, guard = 0; const seen = new Set();
      while (node && roster.has(node) && !seen.has(node) && guard++ < 100) {
        seen.add(node); chain.push(node);
        node = node === root ? null : roster.get(node).mgr;
      }
      const usedLevels = new Set();
      for (const code of chain) {
        const info = levelFor((roster.get(code) || {}).designation);
        if (usedLevels.has(info.level)) continue; // nearest node of this level only
        usedLevels.add(info.level);
        bump(code, info, a);
      }
    }

    // 6) Group nodes by their (nearest-of-level) bucket; only nodes with business.
    const byLevel = new Map();
    for (const [code, n] of nodeAgg) {
      if (n.nop === 0) continue;
      const info = roster.get(code) || {};
      const lv = nodeLevel.get(code) || levelFor(info.designation);
      const bucket = byLevel.get(lv.level) || { level: lv.level, order: lv.order, nodes: [], totals: { margin: 0, income: 0, payout: 0, premium: 0, nop: 0 } };
      bucket.nodes.push({
        code, name: info.name || code, designation: info.designation || null, location: info.location || null,
        margin: round(n.margin), income: round(n.income), payout: round(n.payout), premium: round(n.premium), nop: n.nop,
        margin_pct: n.premium ? round(n.margin / n.premium * 100) : 0,
      });
      byLevel.set(lv.level, bucket);
    }
    const levels = [...byLevel.values()].sort((x, y) => x.order - y.order);
    for (const lv of levels) {
      lv.nodes.sort((a, b) => b.margin - a.margin);
      // Each policy hits at most one node per level, so summing this level's nodes
      // counts each policy once — a clean level total.
      lv.totals = lv.nodes.reduce((t, nd) => { t.margin += nd.margin; t.income += nd.income; t.payout += nd.payout; t.premium += nd.premium; t.nop += nd.nop; return t; }, { margin: 0, income: 0, payout: 0, premium: 0, nop: 0 });
      ['margin', 'income', 'payout', 'premium'].forEach(k => lv.totals[k] = round(lv.totals[k]));
    }

    // Overall totals = the ATTRIBUTED book only (poscodes whose owner is in this
    // root's subtree). Never fall back to the whole cycle — that would double-count
    // business owned outside the viewer's org.
    const totals = (() => {
      const t = { margin: 0, income: 0, payout: 0, premium: 0, nop: 0 };
      for (const [poscode, a] of posAgg) {
        const owner = posOwner.get(poscode);
        if (!owner || !roster.has(owner)) continue;
        ['margin', 'income', 'payout', 'premium', 'nop'].forEach(k => t[k] += a[k]);
      }
      ['margin', 'income', 'payout', 'premium'].forEach(k => t[k] = round(t[k]));
      return t;
    })();

    res.json({
      success: true, root, cycle, cycles, levels, totals,
      unattributed: { margin: round(unattributed.margin), premium: round(unattributed.premium), nop: unattributed.nop },
    });
  } catch (err) { next(err); }
});

// ── #15 POSP creation by Location / RM / BM ─────────────────────────────────
//  GET /api/employee/posp-creation?from=&to=
//  A "creation" = a POS row in tmp_poscodes whose certificate_date falls in the
//  window. We attribute it to the POS's owner (referal_code = an EmployeeCode),
//  roll up the reporting tree the same way as margins, and also cut by month and
//  by the owner's branch Location. certificate_date is a d/MMM/yyyy VARCHAR →
//  TRY_CONVERT parses it (~100% coverage; livedate is staler so we prefer cert).
router.get('/posp-creation', async (req, res, next) => {
  try {
    const root = rootEmpFor(req);
    if (!root) return res.status(400).json({ success: false, error: 'No employee code on this login' });
    const prPool = await getPrarambhPool();
    const today = new Date().toISOString().slice(0, 10);
    const fyStart = (() => { const d = new Date(today); const y = d.getUTCFullYear(); return (d.getUTCMonth() + 1 >= 4 ? y : y - 1) + '-04-01'; })();
    const from = String(req.query.from || '').trim() || fyStart;
    const to = String(req.query.to || '').trim() || today;

    // Subtree roster rooted at `root` (code → manager, name, designation, location).
    const rosterRs = await prPool.request().input('emp', sql.VarChar(50), root).query(`
      ;WITH hier AS (
        SELECT EmployeeCode, reportingmgremployeecode, DisplayName, Designation, Location,
               CAST('|' + EmployeeCode + '|' AS VARCHAR(8000)) AS path
        FROM BugNet_UserProfiles WITH (NOLOCK)
        WHERE EmployeeCode = @emp AND IsActive = 1 AND IsValid = 1
        UNION ALL
        SELECT c.EmployeeCode, c.reportingmgremployeecode, c.DisplayName, c.Designation, c.Location,
               CAST(h.path + c.EmployeeCode + '|' AS VARCHAR(8000))
        FROM BugNet_UserProfiles c WITH (NOLOCK)
        INNER JOIN hier h ON c.reportingmgremployeecode = h.EmployeeCode
        WHERE c.IsActive = 1 AND c.IsValid = 1 AND CHARINDEX('|' + c.EmployeeCode + '|', h.path) = 0
      )
      SELECT EmployeeCode AS code, MAX(reportingmgremployeecode) AS mgr,
             MAX(DisplayName) AS name, MAX(Designation) AS designation, MAX(Location) AS location
      FROM hier GROUP BY EmployeeCode OPTION (MAXRECURSION 1000);`);
    const roster = new Map();
    for (const r of rosterRs.recordset) roster.set(String(r.code), { mgr: r.mgr ? String(r.mgr) : null, name: r.name, designation: r.designation, location: r.location });

    // POS rows created in [from, to] (parse the d/MMM/yyyy cert date).
    const posRs = await prPool.request().input('from', sql.VarChar(20), from).input('to', sql.VarChar(20), to).query(`
      SELECT referal_code, city, state,
             CONVERT(varchar(7), TRY_CONVERT(date, certificate_date), 126) AS ym,
             CASE WHEN deactivateddate IS NULL OR deactivateddate = '' THEN 1 ELSE 0 END AS active
      FROM Beeinsured_v3_2.dbo.tmp_poscodes WITH (NOLOCK)
      WHERE referal_code IS NOT NULL
        AND TRY_CONVERT(date, certificate_date) BETWEEN @from AND @to`);

    // Roll up: attribute each POS to owner's nearest ancestor per level; also month + location cuts.
    const nodeAgg = new Map();   // code → {created, active}
    const nodeLevel = new Map();
    const byMonth = new Map();   // ym → {created, active}
    const byLocation = new Map();// location → {created, active}
    const totals = { created: 0, active: 0 };
    const unattributed = { created: 0, active: 0 };
    const bump = (map, key, active) => { const n = map.get(key) || { created: 0, active: 0 }; n.created += 1; n.active += active; map.set(key, n); };
    for (const p of posRs.recordset) {
      const owner = String(p.referal_code);
      const active = p.active ? 1 : 0;
      if (!roster.has(owner)) { unattributed.created += 1; unattributed.active += active; continue; }
      totals.created += 1; totals.active += active;
      if (p.ym) bump(byMonth, p.ym, active);
      // chain owner..root, nearest node per level
      const chain = []; let node = owner, guard = 0; const seen = new Set();
      while (node && roster.has(node) && !seen.has(node) && guard++ < 100) { seen.add(node); chain.push(node); node = node === root ? null : roster.get(node).mgr; }
      const loc = (roster.get(owner).location || p.state || '—');
      bump(byLocation, loc, active);
      const usedLevels = new Set();
      for (const code of chain) {
        const info = levelFor((roster.get(code) || {}).designation);
        if (usedLevels.has(info.level)) continue;
        usedLevels.add(info.level);
        const n = nodeAgg.get(code) || { created: 0, active: 0 };
        n.created += 1; n.active += active; nodeAgg.set(code, n); nodeLevel.set(code, info);
      }
    }

    // Group nodes by level.
    const byLevel = new Map();
    for (const [code, n] of nodeAgg) {
      if (n.created === 0) continue;
      const info = roster.get(code) || {};
      const lv = nodeLevel.get(code) || levelFor(info.designation);
      const bucket = byLevel.get(lv.level) || { level: lv.level, order: lv.order, nodes: [], totals: { created: 0, active: 0 } };
      bucket.nodes.push({ code, name: info.name || code, designation: info.designation || null, location: info.location || null, created: n.created, active: n.active });
      byLevel.set(lv.level, bucket);
    }
    const levels = [...byLevel.values()].sort((x, y) => x.order - y.order);
    for (const lv of levels) {
      lv.nodes.sort((a, b) => b.created - a.created);
      lv.totals = lv.nodes.reduce((t, nd) => { t.created += nd.created; t.active += nd.active; return t; }, { created: 0, active: 0 });
    }
    const monthsArr = [...byMonth.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([ym, v]) => ({ ym, created: v.created, active: v.active }));
    const locArr = [...byLocation.entries()].map(([location, v]) => ({ location, created: v.created, active: v.active })).sort((a, b) => b.created - a.created);

    res.json({ success: true, root, range: { from, to }, totals, unattributed, levels, by_month: monthsArr, by_location: locArr });
  } catch (err) { next(err); }
});

module.exports = router;
