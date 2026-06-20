/**
 * services/tracker-gen.js — mint a Tracker No via Prarambh_UAT.App_GenerateTrackerNo.
 *
 * SP inputs (per spec): InsurerTypeId=16, BUSS_TYPE=1, CoverType_ID=9380,
 * CoverType_MasterId=9030, CustomerMobile='', InseptionYear=current year, and
 * VerticalID/SalesBranchId/SalesSubBranch + CreatedBy GUID resolved from the
 * uploader (Prarambh_Live Bugnet_userprofiles + Users). The uploader key can be
 * an employee code (Node tab login) or a PortalUserId (legacy portal folder),
 * so we match Bugnet_userprofiles by EmployeeCode OR UserName.
 */
const sql = require('mssql');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { getPrarambhUatPool } = require('../db/prarambh-uat-connection');

const INSURER_TYPE_ID = 16;
const BUSS_TYPE = 1;
const COVER_TYPE_ID = 9380;
const COVER_TYPE_MASTER_ID = 9030;

const _profileCache = new Map();

/** Resolve vertical/branch/sub-branch + CreatedBy GUID for an uploader key. */
async function resolveProfile(uploaderKey) {
  const key = String(uploaderKey || '').trim();
  if (!key) throw new Error('uploader key (empcode / PortalUserId) required to generate tracker');
  if (_profileCache.has(key.toUpperCase())) return _profileCache.get(key.toUpperCase());

  const pool = await getPrarambhPool();
  const r = await pool.request()
    .input('k', sql.NVarChar(256), key)
    .query(`
      SELECT TOP 1 bp.verticalid AS VerticalId, bp.Branchid AS BranchId,
             bp.SubBranchId AS SubBranchId, u.UserId AS UserId
      FROM Bugnet_userprofiles bp
      LEFT JOIN Users u ON UPPER(u.UserName) = UPPER(bp.UserName)
      WHERE UPPER(bp.EmployeeCode) = UPPER(@k) OR UPPER(bp.UserName) = UPPER(@k)`);
  if (r.recordset.length === 0) {
    throw new Error(`No Bugnet_userprofiles match for uploader "${key}"`);
  }
  const row = r.recordset[0];
  if (!row.UserId) throw new Error(`No Users.UserId (CreatedBy GUID) for uploader "${key}"`);
  const profile = {
    verticalId: row.VerticalId, branchId: row.BranchId,
    subBranchId: row.SubBranchId, userId: row.UserId,
  };
  _profileCache.set(key.toUpperCase(), profile);
  return profile;
}

/** Generate a fresh Tracker No for the given uploader key. */
async function generateTracker(uploaderKey) {
  const p = await resolveProfile(uploaderKey);
  const uat = await getPrarambhUatPool();
  const result = await uat.request()
    .input('InsurerTypeId',      sql.Int, INSURER_TYPE_ID)
    .input('VerticalID',         sql.Int, p.verticalId)
    .input('SalesBranchId',      sql.Int, p.branchId)
    .input('SalesSubBranch',     sql.Int, p.subBranchId)
    .input('CustomerMobile',     sql.VarChar(20), '')
    .input('InseptionYear',      sql.Int, new Date().getFullYear())
    .input('CreatedBy',          sql.UniqueIdentifier, p.userId)
    .input('BUSS_TYPE',          sql.Int, BUSS_TYPE)
    .input('CoverType_MasterId', sql.Int, COVER_TYPE_MASTER_ID)
    .input('CoverType_ID',       sql.Int, COVER_TYPE_ID)
    .input('OLD_TrackerNO',      sql.VarChar(100), null)
    .input('DateApproval',       sql.Bit, null)
    .input('RenewalPaidAmount',  sql.Decimal(18, 2), null)
    .input('RenewalDoneStatus',  sql.VarChar(100), null)
    .input('ReasonForHigherPrem',sql.VarChar(100), null)
    .input('HealthCrmId',        sql.Int, null)
    .execute('App_GenerateTrackerNo');

  const row = (result.recordset && result.recordset[0]) || {};
  const trackerNo = row.TrackerNo || row.trackerNo;
  if (!trackerNo) throw new Error(`App_GenerateTrackerNo returned no TrackerNo (${row.ResponseMsg || 'no message'})`);
  return { trackerNo, id: row.Id, responseMsg: row.ResponseMsg || '' };
}

module.exports = { generateTracker, resolveProfile };
