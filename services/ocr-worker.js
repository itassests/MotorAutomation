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
// How many PDFs to OCR concurrently per tick. Each OCR round-trip to the engine
// takes ~40s, so serial processing (=1) is the throughput bottleneck. The claim
// query is READPAST-safe, so N workers never grab the same row. Tune via
// OCR_CONCURRENCY; keep modest so the shared OCR engine isn't overwhelmed.
const CONCURRENCY = Math.max(1, parseInt(process.env.OCR_CONCURRENCY || '5', 10));
const MAX_RETRY = parseInt(process.env.OCR_MAX_RETRY || '3', 10);
const DROP_DIR = process.env.OCR_ZIP_DROP_DIR
  || path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'ocr_dropzone');
const SOURCE_DIRS = String(process.env.OCR_SOURCE_DIRS || DROP_DIR)
  .split(/[;]/).map(s => s.trim()).filter(Boolean);

// Operator empcode that mints trackers. Legacy portal folders carry a
// PortalUserId (e.g. "ROBLTD005") that is NOT a Bugnet_userprofiles user, so
// the tracker is minted under the logged-in operator instead. Seeded from
// OCR_TRACKER_EMPCODE; the /process route overrides it with the clicker's empcode.
const TRACKER_EMPCODE = String(process.env.OCR_TRACKER_EMPCODE || '').trim();
let _operator = TRACKER_EMPCODE;

const folderKey = (name) =>
  String(name || '').replace(/^\d{1,2}-\d{1,2}-\d{2,4}_/, '').replace(/\.zip$/i, '').trim();

// Flatten an error to a useful string. mssql wraps SP failures in a RequestError
// whose .message is empty and whose .originalError is an AggregateError bundling
// the real SQL errors — so a naive String(err.message) yields "".
function errMsg(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.message) parts.push(err.message);
  const oe = err.originalError;
  if (oe) {
    if (Array.isArray(oe.errors)) parts.push(...oe.errors.map(e => (e && e.message) || String(e)));
    else if (oe.message) parts.push(oe.message);
  }
  if (Array.isArray(err.precedingErrors)) parts.push(...err.precedingErrors.map(e => (e && e.message) || String(e)));
  const out = parts.filter(Boolean).join(' | ');
  return out || (err.name ? `${err.name} (no message)` : String(err));
}

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
  const extractZip = (zipPath) => {
    const dir = path.join(DROP_DIR, 'extract', String(uploadId));
    fs.mkdirSync(dir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.getEntries().filter(e => !e.isDirectory && /\.pdf$/i.test(e.entryName))
      .forEach(e => zip.extractEntryTo(e, dir, true, true));   // keep inner folder structure
    return { dir, pdfs: listPdfs(dir) };
  };
  // 1) Exact zip name in the dropzone / source dirs (new-tab uploads).
  for (const base of [DROP_DIR, ...SOURCE_DIRS]) {
    const zipPath = path.join(base, folderName);
    if (fs.existsSync(zipPath) && /\.zip$/i.test(zipPath)) {
      try { const r = extractZip(zipPath); if (r.pdfs.length) return r; } catch (_) { /* next */ }
    }
  }
  // 2) Fuzzy scan: a zip FILE or an already-extracted FOLDER whose
  //    date-prefix-stripped name matches the descriptor (on-disk names often
  //    carry a "DD-MM-YYYY_" prefix the DB FolderPath lacks, or vice versa).
  for (const base of SOURCE_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const entKey = folderKey(ent.name);
      const matches = entKey === key || entKey.indexOf(key) !== -1 || key.indexOf(entKey) !== -1;
      if (!matches) continue;
      try {
        if (ent.isDirectory()) {
          const dir = path.join(base, ent.name);
          const pdfs = listPdfs(dir);
          if (pdfs.length) return { dir, pdfs };
        } else if (/\.zip$/i.test(ent.name)) {
          const r = extractZip(path.join(base, ent.name));
          if (r.pdfs.length) return r;
        }
      } catch (_) { /* next entry */ }
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

/** Mint a tracker under the folder's emp_code, falling back to the operator
 *  empcode when that identity isn't a Bugnet_userprofiles user (legacy portal
 *  folders whose PortalUserId is an agent code, not an employee). */
async function mintTracker(folderEmp) {
  const tried = [];
  const candidates = [];
  if (folderEmp) candidates.push(folderEmp);
  if (_operator && _operator !== folderEmp) candidates.push(_operator);
  if (!candidates.length) throw new Error('no tracker identity (set OCR_TRACKER_EMPCODE or run via Process now)');
  let lastErr;
  for (const c of candidates) {
    try { return await generateTracker(c); }
    catch (e) {
      lastErr = e; tried.push(c);
      // Only fall through on an identity miss; surface real SP/DB errors.
      if (!/No Bugnet_userprofiles match|No Users\.UserId/i.test(e.message)) throw e;
    }
  }
  throw new Error(`${lastErr ? lastErr.message : 'tracker failed'} (tried: ${tried.join(', ')})`);
}

/** Read the OCR'd policy number back from Prarambh_Live. GetOCRdata's HTTP
 *  response is only a status flag; the engine writes the extracted number into
 *  TRN_PrarambhMotorMISUpdation.POLICY_NO (keyed by PrarambhMainId), so that —
 *  not the response body — is the source of truth. Resolves the main id from
 *  the tracker when it wasn't passed through. */
async function lookupPolicyNo(live, mainId, trackerNo) {
  let id = mainId;
  if (id == null && trackerNo) {
    const m = await live.request().input('tk', sql.VarChar(500), trackerNo)
      .query('SELECT TOP 1 Id FROM dbo.TRN_PrarambhMain WHERE TrackerNo = @tk ORDER BY Id DESC');
    if (m.recordset[0]) id = m.recordset[0].Id;
  }
  if (id == null) return null;
  const r = await live.request().input('id', sql.BigInt, id).query(
    `SELECT TOP 1 POLICY_NO FROM dbo.TRN_PrarambhMotorMISUpdation
     WHERE PrarambhMainId = @id AND POLICY_NO IS NOT NULL AND LTRIM(RTRIM(POLICY_NO)) <> ''
     ORDER BY Id DESC`);
  return r.recordset[0] ? String(r.recordset[0].POLICY_NO).trim() : null;
}

/** Claim a single queued PDF, flipping it to status=4 (processing). READPAST +
 *  ROWLOCK make this safe for concurrent workers — each claims a distinct row.
 *  Returns the claimed row, or null when the queue is empty. */
async function claimOnePdf(app) {
  const claim = await app.request().query(`
    UPDATE TOP (1) p SET p.status = 4
    OUTPUT INSERTED.id, INSERTED.upload_id, INSERTED.pdf_path, INSERTED.tracker_no, INSERTED.prarambh_main_id, INSERTED.retry
    FROM dbo.ocr_bulk_pdf p WITH (READPAST, ROWLOCK, UPDLOCK) WHERE p.status = 1`);
  return claim.recordset.length ? claim.recordset[0] : null;
}

/** OCR one claimed PDF end-to-end and finalize it (status=2 + policy on success,
 *  retry or status=3 on failure). Self-contained so a wave can run in parallel. */
async function handlePdf(app, live, row) {
  {
    const meta = await app.request().input('id', sql.Int, row.upload_id)
      .query('SELECT emp_code, transaction_id, folder_key FROM dbo.ocr_bulk_meta WHERE upload_id = @id');
    const md = meta.recordset[0] || {};
    let trackerNo = row.tracker_no || null;
    let mainId = row.prarambh_main_id != null ? row.prarambh_main_id : null;
    try {
      if (!trackerNo) {
        const minted = await mintTracker(md.emp_code);
        trackerNo = minted.trackerNo;
        if (minted.id != null) mainId = minted.id;
        await app.request().input('id', sql.Int, row.id)
          .input('t', sql.NVarChar(200), trackerNo)
          .input('pm', sql.Int, mainId != null ? mainId : null)
          .query('UPDATE dbo.ocr_bulk_pdf SET tracker_no = @t, prarambh_main_id = @pm WHERE id = @id');
      }
      const ocr = await runOcr(row.pdf_path, {
        tracker: trackerNo, prarambhMainId: mainId,
        uploadName: path.basename(row.pdf_path), docPassword: '',
      });
      // The policy number lands in TRN_PrarambhMotorMISUpdation (written
      // synchronously by GetOCRdata), not in the HTTP response — read it back.
      const policyNo = ocr.policyNo || await lookupPolicyNo(live, mainId, trackerNo);
      if (!policyNo) throw new Error('OCR no policy. '
        + `step1 GetFileInJson(${ocr.fileStatus}): ` + String(ocr.fileText || '').slice(0, 1200)
        + ` || sentToStep2: ` + String(ocr.sentToStep2 || '').slice(0, 600)
        + ` || step2 GetOCRdata(${ocr.ocrStatus}): ` + String(ocr.ocrText || '').slice(0, 800));
      // Final result → shared trn_OCRBulkEntry (Trackerno + PolicyNo + FolderPath + TransactionID).
      await live.request()
        .input('t', sql.VarChar(500), trackerNo)
        .input('p', sql.VarChar(200), policyNo)
        .input('fp', sql.NVarChar(sql.MAX), path.dirname(row.pdf_path))
        .input('tx', sql.VarChar(500), md.transaction_id || null)
        .query(`INSERT INTO dbo.trn_OCRBulkEntry (Trackerno, PolicyNo, FolderPath, TransactionID, CreatedDate)
                VALUES (@t, @p, @fp, @tx, GETDATE())`);
      // Finalize this tracker's data entry: App_BulkOcr enriches the reported
      // fields (insurer / POS from the folder) and submits the tracker to the
      // U/W team (IsOCR=1). It's idempotent (UPDATEs keyed by TrackerNo), so a
      // best-effort call here is safe — a failure is logged but must NOT re-queue
      // the PDF, which would duplicate the trn_OCRBulkEntry row just written.
      try {
        await live.request()
          .input('folderId', sql.VarChar(10), String(row.upload_id))
          .input('Trackerno', sql.VarChar(500), trackerNo)
          .input('TransactionNo', sql.VarChar(500), md.transaction_id || null)
          .input('filepath', sql.VarChar(sql.MAX), row.pdf_path)
          .execute('dbo.App_BulkOcr');
      } catch (spErr) {
        console.warn(`[ocr-worker] App_BulkOcr failed for ${trackerNo}: ${errMsg(spErr)}`);
      }
      await app.request().input('id', sql.Int, row.id).input('p', sql.NVarChar(200), policyNo)
        .query('UPDATE dbo.ocr_bulk_pdf SET status = 2, policy_no = @p, error = NULL, processed_at = GETDATE() WHERE id = @id');
    } catch (err) {
      const next = (row.retry || 0) + 1;
      const status = next < MAX_RETRY ? 1 : 3;
      await app.request().input('id', sql.Int, row.id).input('t', sql.NVarChar(200), trackerNo)
        .input('s', sql.Int, status).input('r', sql.Int, next)
        .input('e', sql.NVarChar(sql.MAX), errMsg(err).slice(0, 3900))
        .query('UPDATE dbo.ocr_bulk_pdf SET status = @s, tracker_no = @t, retry = @r, error = @e, processed_at = GETDATE() WHERE id = @id');
      console.warn(`[ocr-worker] pdf ${row.id} failed: ${errMsg(err)}`);
    }
  }
}

/** Phase 2 — claim a wave of up to CONCURRENCY queued PDFs and OCR them in
 *  parallel. Settling runs after each wave (in tick), so folders roll to "done"
 *  incrementally rather than all at the very end. */
async function processPdfs(app, live) {
  const wave = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const row = await claimOnePdf(app);
    if (!row) break;
    wave.push(row);
  }
  if (wave.length) await Promise.all(wave.map((r) => handlePdf(app, live, r)));
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

async function tick(operatorEmpcode) {
  if (operatorEmpcode) _operator = String(operatorEmpcode).trim();
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
  console.log(`[ocr-worker] started (tick ${TICK_MS}ms, ${FOLDERS_PER_TICK} folder(s)/tick, ${CONCURRENCY} PDF(s) in parallel per wave)`);
}

module.exports = { startWorker, tick, locateFolderPdfs };
