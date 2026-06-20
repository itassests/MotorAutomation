/**
 * services/ocr-worker.js — durable, server-side OCR processor (Node owns it).
 *
 * Runs ONLY when OCR_WORKER_ENABLED=1 (default OFF). Must run on the OCR file
 * machine with the existing processor turned OFF. Each tick:
 *   1) Enumerate new pending folders (Isactive=1): locate their PDFs on disk,
 *      queue one ocr_bulk_pdf row per PDF, mark meta.state='processing'.
 *   2) Process queued PDFs: mint a Tracker (once), OCR for the policy number,
 *      then write a trn_OCRBulkEntry row (Trackerno + PolicyNo + FolderPath +
 *      TransactionID) and mark the PDF done.
 *   3) Settle: when a folder's PDFs are all done, flip its Isactive 1→2.
 *
 * State lives in RateExtract (ocr_bulk_meta, ocr_bulk_pdf) so it resumes after
 * any restart/wake. The shared Prarambh_Live tables get only the final entries.
 *
 * Config: OCR_WORKER_ENABLED, OCR_WORKER_TICK_MS, OCR_FOLDERS_PER_TICK,
 *         OCR_PDFS_PER_TICK, OCR_MAX_RETRY, OCR_SOURCE_DIRS (";"-separated dirs
 *         to search for a folder's PDFs/zip), OCR_ZIP_DROP_DIR.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');
const AdmZip = require('adm-zip');
const { getPool } = require('../db/connection');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { generateTracker } = require('./tracker-gen');
const { runOcr } = require('./ocr-oneinsure');

const ENABLED = String(process.env.OCR_WORKER_ENABLED || '0') === '1';
const TICK_MS = parseInt(process.env.OCR_WORKER_TICK_MS || '8000', 10);
const FOLDERS_PER_TICK = parseInt(process.env.OCR_FOLDERS_PER_TICK || '1', 10);
const PDFS_PER_TICK = parseInt(process.env.OCR_PDFS_PER_TICK || '3', 10);
const MAX_RETRY = parseInt(process.env.OCR_MAX_RETRY || '3', 10);
const DROP_DIR = process.env.OCR_ZIP_DROP_DIR
  || path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'ocr_dropzone');
const SOURCE_DIRS = String(process.env.OCR_SOURCE_DIRS || DROP_DIR)
  .split(/[;]/).map(s => s.trim()).filter(Boolean);

const folderKey = (name) =>
  String(name || '').replace(/^\d{1,2}-\d{1,2}-\d{2,4}_/, '').replace(/\.zip$/i, '').trim();

let _running = false;
let _started = false;

/** Locate a folder's PDFs on disk. Returns { dir, pdfs: [fullPath...] } or null. */
function locateFolderPdfs(uploadId, folderName) {
  const key = folderKey(folderName);
  // Recursively collect every PDF under a directory (handles zip→folder→pdfs
  // and folder→subfolder→pdfs); bounded depth so a stray deep tree can't hang.
  const listPdfs = (dir, depth = 0, out = []) => {
    if (depth > 6) return out;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) listPdfs(full, depth + 1, out);
      else if (/\.pdf$/i.test(e.name)) out.push(full);
    }
    return out;
  };
  // 1) A zip dropped by the new tab → extract (preserving inner folders) and walk.
  for (const base of [DROP_DIR, ...SOURCE_DIRS]) {
    const zipPath = path.join(base, folderName);
    if (fs.existsSync(zipPath) && /\.zip$/i.test(zipPath)) {
      const dir = path.join(DROP_DIR, 'extract', String(uploadId));
      try {
        fs.mkdirSync(dir, { recursive: true });
        const zip = new AdmZip(zipPath);
        zip.getEntries().filter(e => !e.isDirectory && /\.pdf$/i.test(e.entryName))
          .forEach(e => zip.extractEntryTo(e, dir, true, true));   // keep inner folder structure
        const pdfs = listPdfs(dir);
        if (pdfs.length) return { dir, pdfs };
      } catch (_) { /* try next */ }
    }
  }
  // 2) An already-extracted folder whose name contains the descriptor.
  for (const base of SOURCE_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name.indexOf(key) !== -1) {
        const dir = path.join(base, ent.name);
        const pdfs = listPdfs(dir);
        if (pdfs.length) return { dir, pdfs };
      }
    }
  }
  return null;
}

/** Phase 1 — claim + enumerate up to N new pending folders. */
async function enumerateFolders(app, live) {
  // Pending folders from the shared table.
  const pend = await live.request().query(
    `SELECT TOP 50 id, FolderPath, PortalUserId, Poscode FROM dbo.Trn_PrarambhOCRBulkUploadDetails
     WHERE Isactive = 1 ORDER BY id DESC`);
  if (pend.recordset.length === 0) return;
  const ids = pend.recordset.map(r => r.id);
  // Which of these already have a Node meta (claimed)?
  const claimed = new Set();
  const m = await app.request().query(
    `SELECT upload_id FROM dbo.ocr_bulk_meta WHERE upload_id IN (${ids.join(',')}) AND state IS NOT NULL`);
  m.recordset.forEach(r => claimed.add(r.upload_id));

  let taken = 0;
  for (const f of pend.recordset) {
    if (taken >= FOLDERS_PER_TICK) break;
    if (claimed.has(f.id)) continue;
    taken++;
    const found = locateFolderPdfs(f.id, f.FolderPath);
    const uploader = f.PortalUserId || f.Poscode || null;
    const txnId = crypto.randomUUID();
    if (!found) {
      // Remember we tried, so we don't rescan endlessly; an admin can fix the path.
      await upsertMeta(app, f.id, f.FolderPath, 0, uploader, 'no_files', txnId, null);
      console.warn(`[ocr-worker] folder ${f.id} (${f.FolderPath}): no PDFs found on disk`);
      continue;
    }
    await upsertMeta(app, f.id, f.FolderPath, found.pdfs.length, uploader, 'processing', txnId, found.dir);
    for (const p of found.pdfs) {
      await app.request().input('uid', sql.Int, f.id).input('p', sql.NVarChar(1000), p)
        .query('INSERT INTO dbo.ocr_bulk_pdf (upload_id, pdf_path, status) VALUES (@uid, @p, 1)');
    }
    console.log(`[ocr-worker] folder ${f.id}: queued ${found.pdfs.length} PDF(s) from ${found.dir}`);
  }
}

async function upsertMeta(app, id, folderName, total, uploader, state, txnId, dir) {
  await app.request()
    .input('uid', sql.Int, id)
    .input('fn', sql.NVarChar(500), folderName)
    .input('fk', sql.NVarChar(500), folderKey(folderName))
    .input('n', sql.Int, total)
    .input('emp', sql.NVarChar(100), uploader)
    .input('st', sql.NVarChar(20), state)
    .input('tx', sql.NVarChar(50), txnId)
    .input('dir', sql.NVarChar(1000), dir)
    .query(`
      MERGE dbo.ocr_bulk_meta AS t
      USING (SELECT @uid AS upload_id) AS s ON t.upload_id = s.upload_id
      WHEN MATCHED THEN UPDATE SET total_pdfs = @n, emp_code = COALESCE(t.emp_code, @emp),
            state = @st, transaction_id = COALESCE(t.transaction_id, @tx), folder_key = @fk
      WHEN NOT MATCHED THEN INSERT (upload_id, folder_name, folder_key, total_pdfs, emp_code, state, transaction_id)
            VALUES (@uid, @fn, @fk, @n, @emp, @st, @tx);`);
}

/** Phase 2 — process up to N queued PDFs. */
async function processPdfs(app, live) {
  for (let i = 0; i < PDFS_PER_TICK; i++) {
    const claim = await app.request().query(`
      UPDATE TOP (1) p SET p.status = 4
      OUTPUT INSERTED.id, INSERTED.upload_id, INSERTED.pdf_path, INSERTED.tracker_no, INSERTED.retry
      FROM dbo.ocr_bulk_pdf p WITH (READPAST, ROWLOCK, UPDLOCK) WHERE p.status = 1`);
    if (claim.recordset.length === 0) break;
    const row = claim.recordset[0];
    const meta = await app.request().input('id', sql.Int, row.upload_id)
      .query('SELECT emp_code, transaction_id, folder_key FROM dbo.ocr_bulk_meta WHERE upload_id = @id');
    const md = meta.recordset[0] || {};
    let trackerNo = row.tracker_no || null;
    try {
      if (!trackerNo) {
        trackerNo = (await generateTracker(md.emp_code)).trackerNo;
        await app.request().input('id', sql.Int, row.id).input('t', sql.NVarChar(200), trackerNo)
          .query('UPDATE dbo.ocr_bulk_pdf SET tracker_no = @t WHERE id = @id');
      }
      const { policyNo } = await runOcr(row.pdf_path);
      if (!policyNo) throw new Error('OCR returned no policy number');
      // Final result → shared trn_OCRBulkEntry (Trackerno + PolicyNo + FolderPath + TransactionID).
      await live.request()
        .input('t', sql.VarChar(500), trackerNo)
        .input('p', sql.VarChar(200), policyNo)
        .input('fp', sql.NVarChar(sql.MAX), path.dirname(row.pdf_path))
        .input('tx', sql.VarChar(500), md.transaction_id || null)
        .query(`INSERT INTO dbo.trn_OCRBulkEntry (Trackerno, PolicyNo, FolderPath, TransactionID, CreatedDate)
                VALUES (@t, @p, @fp, @tx, GETDATE())`);
      await app.request().input('id', sql.Int, row.id).input('p', sql.NVarChar(200), policyNo)
        .query('UPDATE dbo.ocr_bulk_pdf SET status = 2, policy_no = @p, error = NULL, processed_at = GETDATE() WHERE id = @id');
    } catch (err) {
      const next = (row.retry || 0) + 1;
      const status = next < MAX_RETRY ? 1 : 3;
      await app.request().input('id', sql.Int, row.id).input('t', sql.NVarChar(200), trackerNo)
        .input('s', sql.Int, status).input('r', sql.Int, next)
        .input('e', sql.NVarChar(sql.MAX), String(err.message || '').slice(0, 3900))
        .query('UPDATE dbo.ocr_bulk_pdf SET status = @s, tracker_no = @t, retry = @r, error = @e, processed_at = GETDATE() WHERE id = @id');
      console.warn(`[ocr-worker] pdf ${row.id} failed: ${err.message}`);
    }
  }
}

/** Phase 3 — flip folders whose PDFs are all settled to Done (Isactive=2). */
async function settleFolders(app, live) {
  const r = await app.request().query(`
    SELECT m.upload_id
    FROM dbo.ocr_bulk_meta m
    WHERE m.state = 'processing'
      AND NOT EXISTS (SELECT 1 FROM dbo.ocr_bulk_pdf p WHERE p.upload_id = m.upload_id AND p.status IN (1, 4))`);
  for (const row of r.recordset) {
    await live.request().input('id', sql.Int, row.upload_id)
      .query('UPDATE dbo.Trn_PrarambhOCRBulkUploadDetails SET Isactive = 2 WHERE id = @id AND Isactive = 1');
    await app.request().input('id', sql.Int, row.upload_id)
      .query("UPDATE dbo.ocr_bulk_meta SET state = 'done' WHERE upload_id = @id");
    console.log(`[ocr-worker] folder ${row.upload_id} done → Isactive=2`);
  }
}

async function tick() {
  if (_running) return;
  _running = true;
  try {
    const app = await getPool();
    const live = await getPrarambhPool();
    await enumerateFolders(app, live);
    await processPdfs(app, live);
    await settleFolders(app, live);
  } catch (err) {
    console.warn('[ocr-worker] tick error:', err.message);
  } finally {
    _running = false;
  }
}

async function startWorker() {
  if (_started) return;
  if (!ENABLED) { console.log('[ocr-worker] disabled (set OCR_WORKER_ENABLED=1 on the OCR machine to run)'); return; }
  _started = true;
  try {
    const app = await getPool();
    await app.request().query('UPDATE dbo.ocr_bulk_pdf SET status = 1 WHERE status = 4');   // reclaim stale
  } catch (err) { console.warn('[ocr-worker] startup reclaim skipped:', err.message); }
  setInterval(tick, TICK_MS);
  console.log(`[ocr-worker] started (tick ${TICK_MS}ms, ${FOLDERS_PER_TICK} folder(s)/${PDFS_PER_TICK} PDF(s) per tick)`);
}

module.exports = { startWorker, tick, locateFolderPdfs };
