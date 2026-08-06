/**
 * routes/ocr-bulk.js — OCR Bulk Upload (Node = upload intake only).
 *
 * Node inserts the upload row into the SHARED Prarambh_Live table
 * Trn_PrarambhOCRBulkUploadDetails (Isactive=1); the existing OCR processor
 * does the OCR + tracker generation and writes trn_OCRBulkEntry (Trackerno,
 * PolicyNo, FolderPath). A small Node-owned table (RateExtract.ocr_bulk_meta)
 * records the zip's PDF count + folder key so the tab can show progress and
 * export, without altering the shared tables.
 *
 *   POST   /api/ocr-bulk/upload               multipart (files[] zips + form fields)
 *   GET    /api/ocr-bulk/uploads              list folders (latest first)
 *   GET    /api/ocr-bulk/uploads/:id/progress { total, generated, done, pending }
 *   GET    /api/ocr-bulk/uploads/:id/export   xlsx of TrackerNo + PolicyNo
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sql = require('mssql');
const AdmZip = require('adm-zip');
const XLSX = require('xlsx');
const { getPool } = require('../db/connection');                 // RateExtract (meta)
const { getPrarambhPool } = require('../db/prarambh-connection'); // Prarambh_Live (shared)
const { attachUser } = require('./auth');

const router = express.Router();

// Where the uploaded zips are dropped for the existing OCR processor to pick up.
// Point OCR_ZIP_DROP_DIR at the processor's pickup folder/share in production.
const DROP_DIR = process.env.OCR_ZIP_DROP_DIR
  || path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'ocr_dropzone');
fs.mkdirSync(DROP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DROP_DIR),
  // Keep the original name so FolderPath matches the existing system's convention.
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

router.use(attachUser());

// OCR Bulk Upload is restricted to a SINGLE operator (empcode 107110) — not even
// admins. Gate every endpoint here, not just the UI tab, since the tab being
// hidden is cosmetic. Override the allowed empcode via OCR_BULK_EMPCODE if needed.
const OCR_BULK_EMPCODE = String(process.env.OCR_BULK_EMPCODE || '107110').trim().toUpperCase();
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Login required' });
  if (String(req.user.empcode || '').trim().toUpperCase() !== OCR_BULK_EMPCODE) {
    return res.status(403).json({ success: false, error: 'Not authorized for OCR Bulk Upload' });
  }
  next();
});

// Product Type select (Comp/SAOD/TP) → the wording the existing table uses.
const PRODUCT_MAP = { Comp: 'Comprehensive', Comprehensive: 'Comprehensive', SAOD: 'SAOD', TP: 'TP' };
// Folder key = the bare descriptor the processor stores in entry.FolderPath:
// strip a leading "DD-MM-YYYY_" prefix (if any) and the ".zip" extension.
const folderKey = (zipName) =>
  String(zipName || '').replace(/^\d{1,2}-\d{1,2}-\d{2,4}_/, '').replace(/\.(zip|rar|7z)$/i, '').trim();

/** POST /upload — one Trn_PrarambhOCRBulkUploadDetails (Isactive=1) row per zip. */
router.post('/upload', upload.array('files', 50), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ success: false, error: 'No zip files uploaded' });
    const b = req.body || {};
    const posCode = String(b.posCode || '').trim();
    const bookingLocation = String(b.bookingLocation || '').trim();
    const portalUserId = String(b.portalUserId || '').trim();
    const productType = PRODUCT_MAP[String(b.productType || '').trim()] || String(b.productType || '').trim();
    const insurerId = parseInt(b.insurerId, 10);
    const empcode = (req.user && req.user.empcode) || null;

    const live = await getPrarambhPool();
    const app = await getPool();
    const created = [];

    for (const file of files) {
      // Count PDFs in the zip (for the progress display only).
      let totalPdfs = 0;
      try {
        const zip = new AdmZip(file.path);
        totalPdfs = zip.getEntries().filter(e => !e.isDirectory && /\.pdf$/i.test(e.entryName)).length;
      } catch (_) { totalPdfs = 0; }

      // Insert the shared upload row (Isactive=1) → existing processor picks it up.
      const ins = await live.request()
        .input('pos', sql.VarChar(100), posCode)
        .input('bl', sql.VarChar(1000), bookingLocation)
        .input('pu', sql.VarChar(50), portalUserId)
        .input('pt', sql.VarChar(50), productType)
        .input('fp', sql.NVarChar(sql.MAX), file.originalname)
        .input('iid', sql.Int, Number.isInteger(insurerId) ? insurerId : null)
        .query(`INSERT INTO dbo.Trn_PrarambhOCRBulkUploadDetails
                  (Poscode, BookedLocation, PortalUserId, Producttype, FolderPath, CreatedDate, Isactive, InsurerId)
                OUTPUT INSERTED.id
                VALUES (@pos, @bl, @pu, @pt, @fp, GETDATE(), 1, @iid)`);
      const uploadId = ins.recordset[0].id;

      // Node-owned meta (RateExtract): total PDFs + folder key for progress/export.
      await app.request()
        .input('uid', sql.Int, uploadId)
        .input('fn', sql.NVarChar(500), file.originalname)
        .input('fk', sql.NVarChar(500), folderKey(file.originalname))
        .input('n', sql.Int, totalPdfs)
        .input('emp', sql.NVarChar(100), empcode)
        .query(`INSERT INTO dbo.ocr_bulk_meta (upload_id, folder_name, folder_key, total_pdfs, emp_code)
                VALUES (@uid, @fn, @fk, @n, @emp)`);

      created.push({ id: uploadId, folder: file.originalname, totalPdfs });
    }

    res.json({ success: true, uploads: created });
  } catch (err) { next(err); }
});

/** GET /summary — folder counts (instant; folder-level only). */
router.get('/summary', async (req, res, next) => {
  try {
    const live = await getPrarambhPool();
    const r = await live.request().query(
      `SELECT Isactive, COUNT(*) AS n FROM dbo.Trn_PrarambhOCRBulkUploadDetails
       WHERE Isactive IN (1, 2) GROUP BY Isactive`);
    let pending = 0, done = 0;
    for (const row of r.recordset) {
      if (row.Isactive === 1) pending = row.n;
      else if (row.Isactive === 2) done = row.n;
    }
    res.json({ success: true, pending, done, total: pending + done });
  } catch (err) { next(err); }
});

/** GET /uploads — ALL active folders (shared table), latest first. */
router.get('/uploads', async (req, res, next) => {
  try {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '300', 10)));
    // Isactive doubles as status: 1 = not done (pending), 2 = done. ?status=1|2
    // narrows to one; anything else (or "all") shows both.
    const st = parseInt(req.query.status, 10);
    const statusWhere = (st === 1 || st === 2) ? `Isactive = ${st}` : 'Isactive IN (1, 2)';
    const live = await getPrarambhPool();
    // Show done folders too so they stay listed for the Excel download.
    const det = await live.request().input('lim', sql.Int, limit).query(
      `SELECT TOP (@lim) id, FolderPath, Poscode, Producttype, BookedLocation, PortalUserId, CreatedDate, Isactive
       FROM dbo.Trn_PrarambhOCRBulkUploadDetails
       WHERE ${statusWhere}
       ORDER BY CreatedDate DESC, id DESC`);
    const rows = det.recordset;
    if (rows.length === 0) return res.json({ success: true, uploads: [] });

    // total_pdfs from Node meta where available (Node-originated uploads only).
    const app = await getPool();
    const idCsv = rows.map(r => r.id).join(',');
    let metaById = new Map();
    try {
      const m = await app.request().query(
        `SELECT upload_id, total_pdfs FROM dbo.ocr_bulk_meta WHERE upload_id IN (${idCsv})`);
      metaById = new Map(m.recordset.map(x => [x.upload_id, x.total_pdfs]));
    } catch (_) { /* meta optional */ }

    const uploads = rows.map(r => ({
      Id: r.id,
      FolderName: r.FolderPath,
      PosCode: r.Poscode || '',
      ProductType: r.Producttype || '',
      BookingLocation: r.BookedLocation || '',
      CreatedDate: r.CreatedDate,
      Status: r.Isactive,                 // 1 = not done, 2 = done
      TotalPdfs: metaById.has(r.id) ? metaById.get(r.id) : null,
    }));
    res.json({ success: true, uploads });
  } catch (err) { next(err); }
});

/** Look up folder_key + total for an upload id. Falls back to the shared table
 *  (deriving folder_key from FolderPath) for folders not uploaded via Node. */
async function getMeta(appPool, id) {
  const r = await appPool.request().input('id', sql.Int, id)
    .query('SELECT folder_key, total_pdfs FROM dbo.ocr_bulk_meta WHERE upload_id = @id');
  if (r.recordset[0]) return r.recordset[0];
  const live = await getPrarambhPool();
  const u = await live.request().input('id', sql.Int, id)
    .query('SELECT FolderPath FROM dbo.Trn_PrarambhOCRBulkUploadDetails WHERE id = @id');
  if (!u.recordset[0]) return null;
  return { folder_key: folderKey(u.recordset[0].FolderPath), total_pdfs: null };
}

/** GET /uploads/:id/progress — Node queue counts if processed here, else the
 *  shared-table entries (existing processor). */
router.get('/uploads/:id/progress', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const app = await getPool();

    // Prefer the Node work queue — it has real per-PDF done/pending/failed.
    const pq = await app.request().input('id', sql.Int, id).query(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS done,
             SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status IN (1, 4) THEN 1 ELSE 0 END) AS pending
      FROM dbo.ocr_bulk_pdf WHERE upload_id = @id`);
    if ((pq.recordset[0].total || 0) > 0) {
      const r = pq.recordset[0];
      return res.json({
        success: true, source: 'node',
        total: r.total, done: r.done || 0, failed: r.failed || 0, pending: r.pending || 0,
        generated: (r.done || 0) + (r.failed || 0),
      });
    }

    // Else fall back to the shared trn_OCRBulkEntry (existing processor).
    const meta = await getMeta(app, id);
    if (!meta) return res.status(404).json({ success: false, error: 'Not found' });
    const live = await getPrarambhPool();
    // "done" = an entry whose tracker has an OCR'd policy number. The number
    // lives in TRN_PrarambhMotorMISUpdation.POLICY_NO (the worker also copies it
    // into trn_OCRBulkEntry.PolicyNo for new folders); legacy folders only have
    // it in MISUpdation. EXISTS avoids row fan-out so "generated" stays exact.
    const c = await live.request().input('k', sql.NVarChar(500), meta.folder_key).query(`
      SELECT COUNT(*) AS generated,
             SUM(CASE WHEN x.PolicyNo IS NOT NULL AND LTRIM(RTRIM(x.PolicyNo)) <> '' THEN 1 ELSE 0 END) AS done
      FROM (
        SELECT COALESCE(NULLIF(LTRIM(RTRIM(e.PolicyNo)), ''), mis.POLICY_NO) AS PolicyNo
        FROM dbo.trn_OCRBulkEntry e
        OUTER APPLY (
          SELECT TOP 1 mis.POLICY_NO
          FROM dbo.TRN_PrarambhMain m
          JOIN dbo.TRN_PrarambhMotorMISUpdation mis ON mis.PrarambhMainId = m.Id
          WHERE m.TrackerNo = e.Trackerno
            AND mis.POLICY_NO IS NOT NULL AND LTRIM(RTRIM(mis.POLICY_NO)) <> ''
          ORDER BY mis.Id DESC
        ) mis
        WHERE CHARINDEX(@k, e.FolderPath) > 0
      ) x`);
    const generated = c.recordset[0].generated || 0;
    const done = c.recordset[0].done || 0;
    const total = (meta.total_pdfs != null) ? meta.total_pdfs : null;   // null = unknown (non-Node folder)
    res.json({
      success: true, source: 'shared', failed: null,
      total,
      generated,
      done,
      pending: total != null ? Math.max(0, total - generated) : null,
    });
  } catch (err) { next(err); }
});

/** GET /uploads/:id/failures — failed PDFs for a Node-processed folder. */
router.get('/uploads/:id/failures', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const app = await getPool();
    const r = await app.request().input('id', sql.Int, id).query(
      `SELECT pdf_path, tracker_no, retry, error, processed_at
       FROM dbo.ocr_bulk_pdf WHERE upload_id = @id AND status = 3 ORDER BY id`);
    const failures = r.recordset.map(x => ({
      pdf: path.basename(x.pdf_path || ''),
      tracker: x.tracker_no || '',
      retry: x.retry,
      error: x.error || '',
      at: x.processed_at,
    }));
    res.json({ success: true, count: failures.length, failures });
  } catch (err) { next(err); }
});

/** POST /uploads/:id/reprocess — re-queue ONE already-done folder for a fresh
 *  OCR run. Reverses settleFolders: clears the folder's per-PDF queue and its
 *  prior shared entries, un-claims the Node meta (state → NULL), and flips the
 *  shared folder back to Isactive=1 so enumerateFolders re-picks it on the next
 *  tick (or "Process now"). Prior trn_OCRBulkEntry rows are deleted first so the
 *  re-run doesn't double-count in progress/export — scoped by the meta's
 *  transaction_id (which upsertMeta preserves across re-runs) and falling back to
 *  the folder_key match the export uses. */
router.post('/uploads/:id/reprocess', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const app = await getPool();
    const live = await getPrarambhPool();

    // Folder must exist in the shared table.
    const f = await live.request().input('id', sql.Int, id)
      .query('SELECT id, FolderPath, Isactive FROM dbo.Trn_PrarambhOCRBulkUploadDetails WHERE id = @id');
    if (!f.recordset[0]) return res.status(404).json({ success: false, error: 'Folder not found' });

    // Meta gives the transaction_id (precise entry key) + folder_key (fallback).
    const mr = await app.request().input('id', sql.Int, id)
      .query('SELECT folder_key, transaction_id FROM dbo.ocr_bulk_meta WHERE upload_id = @id');
    const meta = mr.recordset[0] || { folder_key: folderKey(f.recordset[0].FolderPath), transaction_id: null };

    // 1) Clear prior shared entries for this folder (avoids export/progress
    //    double-count). Prefer the exact transaction_id; else the folder_key match.
    let entriesDeleted = 0;
    if (meta.transaction_id) {
      const d = await live.request().input('tx', sql.NVarChar(50), meta.transaction_id)
        .query('DELETE FROM dbo.trn_OCRBulkEntry WHERE TransactionID = @tx');
      entriesDeleted = d.rowsAffected[0] || 0;
    } else if (meta.folder_key) {
      const d = await live.request().input('k', sql.NVarChar(500), meta.folder_key)
        .query('DELETE FROM dbo.trn_OCRBulkEntry WHERE CHARINDEX(@k, FolderPath) > 0');
      entriesDeleted = d.rowsAffected[0] || 0;
    }

    // 2) Drop the Node per-PDF queue so enumerateFolders re-queues from disk.
    const dq = await app.request().input('id', sql.Int, id)
      .query('DELETE FROM dbo.ocr_bulk_pdf WHERE upload_id = @id');
    const pdfsCleared = dq.rowsAffected[0] || 0;

    // 3) Un-claim the meta so the worker re-enumerates it (state IS NULL check).
    await app.request().input('id', sql.Int, id)
      .query('UPDATE dbo.ocr_bulk_meta SET state = NULL WHERE upload_id = @id');

    // 4) Flip the shared folder back to pending.
    await live.request().input('id', sql.Int, id)
      .query('UPDATE dbo.Trn_PrarambhOCRBulkUploadDetails SET Isactive = 1 WHERE id = @id');

    res.json({
      success: true, id, entriesDeleted, pdfsCleared,
      message: 'Folder re-queued. It will process on the next tick — or click "Process now".',
    });
  } catch (err) { next(err); }
});

/** POST /process — kick a single processing tick on demand (manual run). */
router.post('/process', async (req, res, next) => {
  try {
    if (!req.user || !req.user.empcode) return res.status(401).json({ success: false, error: 'Login required' });
    // The clicking operator's empcode is the identity that mints trackers for
    // legacy portal folders (their PortalUserId isn't a Bugnet_userprofiles user).
    await require('../services/ocr-worker').tick(req.user.empcode);
    res.json({ success: true, message: 'Processing tick run' });
  } catch (err) { next(err); }
});

/** GET /uploads/:id/export — xlsx of TrackerNo + PolicyNo for the folder. */
router.get('/uploads/:id/export', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const app = await getPool();
    const meta = await getMeta(app, id);
    if (!meta) return res.status(404).json({ success: false, error: 'Not found' });

    const live = await getPrarambhPool();
    // Prefer the entry's own PolicyNo (new folders); fall back to the OCR result
    // in TRN_PrarambhMotorMISUpdation via the tracker (legacy folders). OUTER
    // APPLY TOP 1 keeps it one row per entry.
    const r = await live.request().input('k', sql.NVarChar(500), meta.folder_key).query(
      `SELECT e.Trackerno,
              COALESCE(NULLIF(LTRIM(RTRIM(e.PolicyNo)), ''), mis.POLICY_NO) AS PolicyNo
       FROM dbo.trn_OCRBulkEntry e
       OUTER APPLY (
         SELECT TOP 1 mis.POLICY_NO
         FROM dbo.TRN_PrarambhMain m
         JOIN dbo.TRN_PrarambhMotorMISUpdation mis ON mis.PrarambhMainId = m.Id
         WHERE m.TrackerNo = e.Trackerno
           AND mis.POLICY_NO IS NOT NULL AND LTRIM(RTRIM(mis.POLICY_NO)) <> ''
         ORDER BY mis.Id DESC
       ) mis
       WHERE CHARINDEX(@k, e.FolderPath) > 0 ORDER BY e.Id`);
    const aoa = [['Policy No', 'Tracker No']];
    for (const e of r.recordset) aoa.push([e.PolicyNo || '', e.Trackerno || '']);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'OCR Results');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ocr_results_${id}.xlsx"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) { next(err); }
});

/**
 * GET /export?from=YYYY-MM-DD&to=YYYY-MM-DD — ONE consolidated xlsx of every
 * folder's Policy No + Tracker No whose upload CreatedDate falls in the range,
 * with Date + Folder columns so rows can be matched without opening each folder
 * separately. Defaults to the last 30 days when from/to are omitted.
 */
router.get('/export', async (req, res, next) => {
  try {
    const iso = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
    const to = iso(req.query.to) || new Date().toISOString().slice(0, 10);
    const from = iso(req.query.from) ||
      new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

    const live = await getPrarambhPool();
    // Folders whose upload date is in range (Isactive 1=pending / 2=done).
    const folders = (await live.request()
      .input('from', sql.Date, from)
      .input('to', sql.Date, to)
      .query(`SELECT id, FolderPath, CreatedDate
                FROM dbo.Trn_PrarambhOCRBulkUploadDetails
               WHERE Isactive IN (1, 2)
                 AND CONVERT(date, CreatedDate) BETWEEN @from AND @to
               ORDER BY CreatedDate, id`)).recordset;

    const aoa = [['Date', 'Folder', 'Policy No', 'Tracker No']];
    for (const f of folders) {
      const key = folderKey(f.FolderPath);
      if (!key) continue;
      const dateStr = f.CreatedDate ? new Date(f.CreatedDate).toISOString().slice(0, 10) : '';
      // Same per-entry lookup as the single-folder export (PolicyNo with MIS fallback).
      const r = await live.request().input('k', sql.NVarChar(500), key).query(
        `SELECT e.Trackerno,
                COALESCE(NULLIF(LTRIM(RTRIM(e.PolicyNo)), ''), mis.POLICY_NO) AS PolicyNo
           FROM dbo.trn_OCRBulkEntry e
           OUTER APPLY (
             SELECT TOP 1 mis.POLICY_NO
             FROM dbo.TRN_PrarambhMain m
             JOIN dbo.TRN_PrarambhMotorMISUpdation mis ON mis.PrarambhMainId = m.Id
             WHERE m.TrackerNo = e.Trackerno
               AND mis.POLICY_NO IS NOT NULL AND LTRIM(RTRIM(mis.POLICY_NO)) <> ''
             ORDER BY mis.Id DESC
           ) mis
          WHERE CHARINDEX(@k, e.FolderPath) > 0 ORDER BY e.Id`);
      for (const e of r.recordset) aoa.push([dateStr, f.FolderPath || '', e.PolicyNo || '', e.Trackerno || '']);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'OCR Results');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ocr_results_${from}_to_${to}.xlsx"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) { next(err); }
});

module.exports = router;
