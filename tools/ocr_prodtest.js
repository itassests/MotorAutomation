/**
 * tools/ocr_prodtest.js — one-off PROD OCR verification (read-only).
 *
 * Runs the real 2-step OneInsure OCR (GetFileInJson → GetOCRdata) against the
 * PRODUCTION endpoints for the 10 PDFs of upload 1609 that failed on UAT, and
 * prints whether a policy number comes back. It does NOT change any queue
 * status, does NOT write trn_OCRBulkEntry, and does NOT mint trackers — it only
 * re-uploads each PDF to prod (step 1 places the file) and reads the OCR result.
 *
 * Run ON THE OCR MACHINE (where the extracted PDFs live), from the project root:
 *     node tools/ocr_prodtest.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Force PROD endpoints BEFORE requiring ocr-oneinsure (it reads these at load).
process.env.OCR_GETFILE_URL = 'https://oneerpapi.oneinsure.com/api/master/GetFileInJson';
process.env.OCR_GETOCR_URL  = 'https://oneerpapi.oneinsure.com/api/master/GetOCRdata';

const sql = require('mssql');
const { runOcr } = require('../services/ocr-oneinsure');
const { getPool } = require('../db/connection');
const { getPrarambhPool } = require('../db/prarambh-connection');

const UPLOAD_ID = parseInt(process.argv[2] || '1609', 10);

// Resolve the stored (relative) pdf_path against the project root if needed.
function resolvePath(p) {
  if (fs.existsSync(p)) return p;
  const r = path.join(__dirname, '..', p);
  return fs.existsSync(r) ? r : null;
}

// GetOCRdata writes the policy number into TRN_PrarambhMotorMISUpdation.POLICY_NO
// (keyed by PrarambhMainId), synchronously — read it back from there.
async function lookupPolicyNo(live, mainId) {
  if (mainId == null) return null;
  const r = await live.request().input('id', sql.BigInt, mainId).query(
    `SELECT TOP 1 POLICY_NO FROM dbo.TRN_PrarambhMotorMISUpdation
     WHERE PrarambhMainId = @id AND POLICY_NO IS NOT NULL AND LTRIM(RTRIM(POLICY_NO)) <> ''
     ORDER BY Id DESC`);
  return r.recordset[0] ? String(r.recordset[0].POLICY_NO).trim() : null;
}

(async () => {
  console.log('PROD GetFileInJson:', process.env.OCR_GETFILE_URL);
  console.log('PROD GetOCRdata   :', process.env.OCR_GETOCR_URL);
  const app = await getPool();
  const live = await getPrarambhPool();
  const rows = (await app.request().input('u', UPLOAD_ID).query(
    `SELECT id, pdf_path, tracker_no, prarambh_main_id
     FROM dbo.ocr_bulk_pdf WHERE upload_id = @u ORDER BY id`)).recordset;
  console.log(`\nTesting ${rows.length} PDF(s) from upload ${UPLOAD_ID} against PROD...\n`);

  let ok = 0, noPolicy = 0, missing = 0, err = 0;
  for (const r of rows) {
    const file = resolvePath(r.pdf_path);
    const name = path.basename(r.pdf_path);
    if (!file) { console.log(`[${r.id}] MISSING FILE  ${r.pdf_path}`); missing++; continue; }
    try {
      const o = await runOcr(file, {
        tracker: r.tracker_no, prarambhMainId: r.prarambh_main_id,
        uploadName: name, docPassword: '',
      });
      // Source of truth is the DB write, not the HTTP response.
      const policyNo = o.policyNo || await lookupPolicyNo(live, r.prarambh_main_id);
      if (policyNo) { console.log(`[${r.id}] OK  policy=${policyNo}   (${name})`); ok++; }
      else {
        console.log(`[${r.id}] NO POLICY  step1(${o.fileStatus}) step2(${o.ocrStatus}) | MISUpdation empty for main ${r.prarambh_main_id}`);
        noPolicy++;
      }
    } catch (e) { console.log(`[${r.id}] ERROR  ${e.message}`); err++; }
  }
  console.log(`\n=== PROD result: ${ok} with policy, ${noPolicy} no-policy, ${missing} file-missing, ${err} error ===`);
  console.log(ok > 0
    ? '>>> PROD OCR WORKS. Point the worker env at prod and re-run the batch.'
    : '>>> PROD OCR returned no policy numbers — engine/flow issue persists (escalate to OneInsure).');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
