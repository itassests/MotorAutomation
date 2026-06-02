/**
 * routes/employee.js — Employee Business Dashboard.
 *
 * When an employee logs in we show all motor business booked since 01-Apr-2026
 * across their reporting hierarchy: the logged-in employee + everyone who rolls
 * up to them (X sees X, Y, Z where Z→Y→X). Hierarchy is the recursive
 * reporting tree in Prarambh_Live.BugNet_UserProfiles
 * (EmployeeCode ← reportingmgremployeecode), with a path-based cycle guard.
 *
 * A case "belongs" to the employee who created it
 * (CREATED_BY → Users.UserName → BugNet_UserProfiles.EmployeeCode).
 * Data: TRN_PrarambhMain + TRN_PrarambhMotorDetails (+ MIS / ReportedFields /
 * Proposer), classified via MST_FieldMasters. Online/Offline = NatureOfSale
 * (MST_FieldMasters MasterId 4030): Online = {2,5,6}, Offline = {1,4,…}.
 *
 * All aggregation/filtering happens in SQL so totals stay accurate for large
 * hierarchies; only the case list is capped (for display).
 *
 *   GET /api/employee/dashboard ?from&to&vertical&branch&sub_branch&agent
 *                               &employee&vehicle_type&channel
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

const DEFAULT_FROM = '2026-04-01';
const ONLINE_SET = '(2,5,6)';     // NatureOfSale values treated as Online
const LIST_CAP = 1000;

// Whose hierarchy to show: employees are locked to their own empcode (= their
// BugNet EmployeeCode). Admins may inspect another subtree via ?employee_root=.
function rootEmpFor(req) {
  const me = String(req.user.empcode || '').trim();
  if (req.user.role === 'admin') return String(req.query.employee_root || '').trim() || me;
  return me;
}

// Recursive reporting tree (self + all descendants) with a cycle guard.
const CTE = `
  WITH hier AS (
    SELECT EmployeeCode, reportingmgremployeecode,
           CAST('|' + EmployeeCode + '|' AS VARCHAR(8000)) AS path
    FROM BugNet_UserProfiles WITH (NOLOCK)
    WHERE EmployeeCode = @emp AND IsActive = 1 AND IsValid = 1
    UNION ALL
    SELECT c.EmployeeCode, c.reportingmgremployeecode,
           CAST(h.path + c.EmployeeCode + '|' AS VARCHAR(8000))
    FROM BugNet_UserProfiles c WITH (NOLOCK)
    INNER JOIN hier h ON c.reportingmgremployeecode = h.EmployeeCode
    WHERE c.IsActive = 1 AND c.IsValid = 1 AND CHARINDEX('|' + c.EmployeeCode + '|', h.path) = 0
  )`;

// FROM + joins shared by every query. Aliases referenced by filter clauses:
// f1=vertical, msb=branch, mssb=sub-branch, r=reported (agent/branch ids),
// up=creator employee, f3=vehicle type, m=main (NatureOfSale).
const JOINS = `
  FROM TRN_PrarambhMain m WITH (NOLOCK)
  INNER JOIN TRN_PrarambhMotorDetails md WITH (NOLOCK) ON md.PrarambhMainId = m.Id AND md.ISACTIVE = 1
  LEFT JOIN TRN_PrarambhProposerDetails p WITH (NOLOCK) ON p.PrarambhMainId = m.Id AND p.ISACTIVE = 1
  LEFT JOIN TRN_PrarambhReportedFields r WITH (NOLOCK) ON r.PrarambhMainId = m.Id AND r.ISACTIVE = 1
  LEFT JOIN TRN_PrarambhMotorMISUpdation mis WITH (NOLOCK) ON mis.PrarambhMainId = m.Id AND mis.ISACTIVE = 1
  LEFT JOIN RH_InsurerMast i WITH (NOLOCK) ON i.insid = r.InsurerId
  -- Business is attributed to the case's ReportingEmployeeCode (the sales/
  -- relationship employee on TRN_PrarambhMain), scoped to the logged-in
  -- employee's reporting hierarchy.
  INNER JOIN (SELECT DISTINCT EmployeeCode FROM hier) hh ON hh.EmployeeCode = CONVERT(varchar(50), m.ReportingEmployeeCode)
  LEFT JOIN BugNet_UserProfiles up WITH (NOLOCK) ON up.EmployeeCode = CONVERT(varchar(50), m.ReportingEmployeeCode)
  LEFT JOIN MST_FieldMasters f1 WITH (NOLOCK) ON f1.MasterId = 4040 AND f1.Value = m.Vertical
  LEFT JOIN MST_FieldMasters f3 WITH (NOLOCK) ON f3.MasterId = 9210 AND f3.Value = md.VEHICAL_TYPE_Id
  LEFT JOIN MST_FieldMasters f5 WITH (NOLOCK) ON f5.MasterId = 9220 AND f5.Value = r.Product_Type_Id
  LEFT JOIN MST_FieldMasters fn WITH (NOLOCK) ON fn.MasterId = 4030 AND fn.Value = m.NatureOfSale
  LEFT JOIN MST_FieldMasters ff WITH (NOLOCK) ON ff.MasterId = 8050 AND ff.Value = m.FinalStatus
  LEFT JOIN MST_SalesBranch msb WITH (NOLOCK) ON msb.id = r.SALES_BRANCH_Id
  LEFT JOIN MST_SalesSubBranch mssb WITH (NOLOCK) ON mssb.id = r.SALES_SUB_BRANCH_Id`;

const BASE_WHERE = `
  WHERE m.InsuranceType = 16 AND m.IsActive = 1
    AND CONVERT(date, m.CREATED_DATE) BETWEEN CONVERT(date, @from) AND CONVERT(date, @to)`;

const OPT = ' OPTION (MAXRECURSION 1000)';

// Build a request with the always-present params bound; optionally bind + return
// the optional-filter WHERE fragment.
function prep(pool, root, from, to, q, withFilters) {
  const rq = pool.request();
  rq.input('emp', sql.VarChar(50), root);
  rq.input('from', sql.VarChar(20), from);
  rq.input('to', sql.VarChar(20), to);
  let clause = '';
  if (withFilters) {
    const add = (cond) => { clause += ` AND ${cond}`; };
    if (q.vertical)     { rq.input('vertical', sql.NVarChar(300), q.vertical); add('f1.Name = @vertical'); }
    if (q.branch)       { rq.input('branch', sql.NVarChar(300), q.branch); add('msb.Location = @branch'); }
    if (q.sub_branch)   { rq.input('sub_branch', sql.NVarChar(300), q.sub_branch); add('mssb.Sub_Location = @sub_branch'); }
    if (q.agent)        { rq.input('agent', sql.NVarChar(100), q.agent); add('ISNULL(r.IDVpos, r.UPIN_CODE) = @agent'); }
    if (q.employee)     { rq.input('employee', sql.NVarChar(50), q.employee); add('up.EmployeeCode = @employee'); }
    if (q.vehicle_type) { rq.input('vehicle_type', sql.NVarChar(200), q.vehicle_type); add('f3.Name = @vehicle_type'); }
    const ch = String(q.channel || '').toLowerCase();
    if (ch === 'online')  add(`m.NatureOfSale IN ${ONLINE_SET}`);
    if (ch === 'offline') add(`(m.NatureOfSale NOT IN ${ONLINE_SET} OR m.NatureOfSale IS NULL)`);
  }
  return { rq, clause };
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const root = rootEmpFor(req);
    const from = String(req.query.from || '').trim() || DEFAULT_FROM;
    const to   = String(req.query.to || '').trim() || '2999-12-31';
    if (!root) return res.status(400).json({ success: false, error: 'No employee code on this login' });
    const q = req.query;
    const pool = await getPrarambhPool();
    const round = (n) => +Number(n || 0).toFixed(2);

    // 1) Accurate summary + online/offline split (filtered, no row transfer).
    const sumP = prep(pool, root, from, to, q, true);
    const summaryQ = `${CTE}
      SELECT COUNT(*) AS nop, ISNULL(SUM(md.ANNUAL_PREMIUM),0) AS premium,
        SUM(CASE WHEN m.NatureOfSale IN ${ONLINE_SET} THEN 1 ELSE 0 END) AS online_nop,
        ISNULL(SUM(CASE WHEN m.NatureOfSale IN ${ONLINE_SET} THEN md.ANNUAL_PREMIUM ELSE 0 END),0) AS online_premium,
        SUM(CASE WHEN m.NatureOfSale IN ${ONLINE_SET} THEN 0 ELSE 1 END) AS offline_nop,
        ISNULL(SUM(CASE WHEN m.NatureOfSale IN ${ONLINE_SET} THEN 0 ELSE md.ANNUAL_PREMIUM END),0) AS offline_premium
      ${JOINS} ${BASE_WHERE}${sumP.clause}${OPT}`;

    // 2) By vehicle type (filtered).
    const vtP = prep(pool, root, from, to, q, true);
    const vtQ = `${CTE}
      SELECT ISNULL(f3.Name,'—') AS vehicle_type, COUNT(*) AS nop, ISNULL(SUM(md.ANNUAL_PREMIUM),0) AS premium
      ${JOINS} ${BASE_WHERE}${vtP.clause}
      GROUP BY f3.Name ORDER BY COUNT(*) DESC${OPT}`;

    // 3) By employee (filtered).
    const empP = prep(pool, root, from, to, q, true);
    const empQ = `${CTE}
      SELECT up.EmployeeCode AS code, MAX(up.DisplayName) AS name, COUNT(*) AS nop, ISNULL(SUM(md.ANNUAL_PREMIUM),0) AS premium
      ${JOINS} ${BASE_WHERE}${empP.clause}
      GROUP BY up.EmployeeCode ORDER BY COUNT(*) DESC${OPT}`;

    // 4) Filter option lists — over the whole hierarchy (NO optional filters) so
    //    dropdowns stay complete regardless of the current selection.
    const optP = prep(pool, root, from, to, q, false);
    const optionsQ = `${CTE}
      SELECT DISTINCT f1.Name AS vertical, msb.Location AS branch, mssb.Sub_Location AS sub_branch,
             ISNULL(r.IDVpos, r.UPIN_CODE) AS agent, f3.Name AS vehicle_type,
             up.EmployeeCode AS emp_code, up.DisplayName AS emp_name
      ${JOINS} ${BASE_WHERE}${OPT}`;

    // 5) Case list (filtered, capped for display).
    const listP = prep(pool, root, from, to, q, true);
    const listQ = `${CTE}
      SELECT TOP ${LIST_CAP}
        m.TrackerNo AS tracker_no, m.CREATED_DATE AS created_date, fn.Name AS channel,
        CASE WHEN m.NatureOfSale IN ${ONLINE_SET} THEN 1 ELSE 0 END AS is_online,
        f1.Name AS vertical, msb.Location AS branch, mssb.Sub_Location AS sub_branch,
        ISNULL(r.IDVpos, r.UPIN_CODE) AS agent_code,
        up.EmployeeCode AS employee_code, up.DisplayName AS employee_name,
        f3.Name AS vehicle_type, f5.Name AS product_type, i.CompanyName AS insurer,
        p.FULLNAME_PROPOSER AS customer, mis.POLICY_NO AS policy_no,
        md.VEHICLE_REGISTRATION_NO AS reg_no, md.RTO_Code AS rto, md.StateName AS state,
        ISNULL(md.ANNUAL_PREMIUM,0) AS premium, ff.Name AS status
      ${JOINS} ${BASE_WHERE}${listP.clause}
      ORDER BY m.CREATED_DATE DESC${OPT}`;

    const [sumR, vtR, empR, optR, listR] = await Promise.all([
      sumP.rq.query(summaryQ),
      vtP.rq.query(vtQ),
      empP.rq.query(empQ),
      optP.rq.query(optionsQ),
      listP.rq.query(listQ),
    ]);

    const s = sumR.recordset[0] || {};
    const uniq = (arr) => [...new Set(arr.filter(v => v != null && v !== ''))].sort();
    const oRows = optR.recordset;
    const empMap = new Map();
    oRows.forEach(r => { if (r.emp_code) empMap.set(r.emp_code, r.emp_name || r.emp_code); });

    res.json({
      success: true, root, from, to,
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
        agents: uniq(oRows.map(r => r.agent)),
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
