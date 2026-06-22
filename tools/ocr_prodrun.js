/**
 * tools/ocr_prodrun.js — re-process upload 1609's failed PDFs through the real
 * worker against PROD (WRITES results). Run only AFTER ocr_prodtest.js confirms
 * prod returns policy numbers.
 *
 * It (1) forces the prod OCR endpoints, (2) resets upload 1609's PDFs to
 * pending (status=1, retry=0), then (3) runs worker ticks until the queue
 * drains — minting trackers as needed and writing trn_OCRBulkEntry rows exactly
 * like the live worker. Pass an operator empcode as arg 2 for tracker minting
 * fallback (legacy portal folders); the PDFs already carry trackers so it's
 * usually unused.
 *
 * Run ON THE OCR MACHINE from the project root:
 *     node tools/ocr_prodrun.js <empcode>
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

process.env.OCR_GETFILE_URL = 'https://oneerpapi.oneinsure.com/api/master/GetFileInJson';
process.env.OCR_GETOCR_URL  = 'https://oneerpapi.oneinsure.com/api/master/GetOCRdata';

const { getPool } = require('../db/connection');
const worker = require('../services/ocr-worker');

const UPLOAD_ID = parseInt(process.argv[3] || '1609', 10);
const EMPCODE = (process.argv[2] || process.env.OCR_TRACKER_EMPCODE || '').trim();

(async () => {
  const app = await getPool();
  // Reset this folder's PDFs to pending so the worker re-picks them.
  const rst = await app.request().input('u', UPLOAD_ID).query(
    `UPDATE dbo.ocr_bulk_pdf SET status = 1, retry = 0, error = NULL
     WHERE upload_id = @u AND status IN (3, 4)`);
  console.log(`Reset ${rst.rowsAffected[0]} PDF(s) of upload ${UPLOAD_ID} to pending.`);

  // Run ticks until nothing pending remains for this upload (bounded).
  for (let i = 1; i <= 20; i++) {
    await worker.tick(EMPCODE || undefined);
    const q = await app.request().input('u', UPLOAD_ID).query(
      `SELECT SUM(CASE WHEN status IN (1,4) THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN status=2 THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN status=3 THEN 1 ELSE 0 END) failed
       FROM dbo.ocr_bulk_pdf WHERE upload_id = @u`);
    const r = q.recordset[0];
    console.log(`tick ${i}: pending=${r.pending} done=${r.done} failed=${r.failed}`);
    if ((r.pending || 0) === 0) break;
  }

  const fin = await app.request().input('u', UPLOAD_ID).query(
    `SELECT id, status, policy_no, LEFT(error,160) error FROM dbo.ocr_bulk_pdf WHERE upload_id=@u ORDER BY id`);
  console.log('\n=== final ===');
  fin.recordset.forEach(x => console.log(`[${x.id}] status=${x.status} policy=${x.policy_no || '-'} ${x.error ? '| ' + x.error.replace(/\s+/g, ' ') : ''}`));
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
