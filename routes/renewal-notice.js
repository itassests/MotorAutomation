/**
 * Renewal Notice processing.
 *
 * Scans a month folder of renewal-notice PDFs on the network share, matches each
 * file to a Prarambh tracker (the file name is the tracker with special chars
 * stripped), copies it into the CRM userfiles folder as RenewalNotice.pdf, and
 * records a row in TRN_PrarambhAttachments (Attachment_Name = "RenewalNotice").
 *
 * Source : \\192.168.2.254\Motor Renewal\2026\<MonthFolder>\...\<TRACKER>.pdf
 *          (recursive — POS-code subfolders may nest further)
 * Dest   : E:\Beeinsured.com\CRM\Prarambh\Content\userfiles\<stripped-tracker>\RenewalNotice.pdf
 *
 * Runs as a background job (in-memory) so a folder with hundreds of files
 * doesn't block the request; the UI polls GET /progress/:jobId.
 *
 * NOTE: the \\192.168… share and the E:\ drive are SERVER-side paths, so this
 * only works when run on the production server (not the dev box).
 */
const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const sql = require('mssql');
const { getPrarambhPool } = require('../db/prarambh-connection');

const router = express.Router();

// Static base of the renewal-notice share; the caller supplies only the month
// folder (e.g. "July26"). Override via env for other environments.
const SOURCE_BASE = process.env.RENEWAL_SOURCE_BASE || '\\\\192.168.2.254\\Motor Renewal\\2026';
// CRM content root the copied files live under.
const CONTENT_BASE = process.env.RENEWAL_CONTENT_BASE || 'E:\\Beeinsured.com\\CRM\\Prarambh\\Content\\userfiles';

const strip = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// In-memory job registry. jobId → progress object. Lost on restart (acceptable:
// re-run the month).
const jobs = new Map();
let _jobSeq = 0;

/** Recursively collect every *.pdf under dir. */
async function scanPdfs(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (e) { throw new Error(`Cannot read folder "${dir}": ${e.message}`); }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await scanPdfs(full, out);
    } else if (ent.isFile() && /\.pdf$/i.test(ent.name)) {
      out.push({ full, name: ent.name });
    }
  }
}

/** Batch-resolve stripped file names → { Id, TrackerNo } via one scan per chunk. */
async function resolveTrackers(live, strippedNames) {
  const map = new Map();
  const list = [...new Set(strippedNames)];
  const CHUNK = 1500;
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const req = live.request();
    const params = chunk.map((s, j) => { req.input('n' + j, sql.VarChar(120), s); return '@n' + j; });
    const r = await req.query(
      `SELECT Id, TrackerNo,
              REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TrackerNo),'/',''),'-',''),' ',''),'.','') AS stripped
       FROM TRN_PrarambhMain
       WHERE REPLACE(REPLACE(REPLACE(REPLACE(UPPER(TrackerNo),'/',''),'-',''),' ',''),'.','') IN (${params.join(',')})`
    );
    for (const row of r.recordset) map.set(row.stripped, { Id: row.Id, TrackerNo: row.TrackerNo });
  }
  return map;
}

async function processJob(job, empcode) {
  try {
    const srcDir = path.join(SOURCE_BASE, job.monthFolder);
    job.log.push(`Scanning ${srcDir} …`);
    const files = [];
    await scanPdfs(srcDir, files);
    job.total = files.length;
    job.log.push(`Found ${files.length} PDF file(s).`);
    if (!files.length) { job.status = 'done'; job.finishedAt = new Date().toISOString(); return; }

    const live = await getPrarambhPool();
    const trackerMap = await resolveTrackers(live, files.map(f => strip(path.basename(f.name, path.extname(f.name)))));
    job.log.push(`Matched ${trackerMap.size} distinct tracker(s) in Prarambh.`);

    for (const f of files) {
      job.scanned++;
      try {
        const key = strip(path.basename(f.name, path.extname(f.name)));
        const hit = trackerMap.get(key);
        if (!hit) {
          job.unmatched++;
          job.samples.unmatched.length < 25 && job.samples.unmatched.push(f.name);
          continue;
        }
        job.matched++;
        const folderKey = strip(hit.TrackerNo);           // canonical, matches existing convention
        const destFolderFs = path.join(CONTENT_BASE, folderKey);
        const destFileFs = path.join(destFolderFs, 'RenewalNotice.pdf');
        // DB path mirrors the existing rows' format (…userfiles\<tracker>/<file>).
        const dbPath = CONTENT_BASE + '\\' + folderKey + '/RenewalNotice.pdf';

        await fsp.mkdir(destFolderFs, { recursive: true });
        await fsp.copyFile(f.full, destFileFs);
        const st = await fsp.stat(destFileFs);

        await live.request()
          .input('mainId', sql.BigInt, hit.Id)
          .input('fp', sql.NVarChar(500), dbPath)
          .input('fn', sql.NVarChar(255), 'RenewalNotice.pdf')
          .input('an', sql.NVarChar(255), 'RenewalNotice')
          .input('by', sql.VarChar(100), empcode || null)
          .input('sz', sql.Int, st.size)
          .query(
            `INSERT INTO TRN_PrarambhAttachments
               (PrarambhMainId, Filepath, File_Name, Attachment_Name, Uploaded_Time,
                ISACTIVE, ATTACHMENT_MASTER_ID, FILE_EXT, Uploaded_Doneby, docFileSize)
             VALUES
               (@mainId, @fp, @fn, @an, GETDATE(),
                1, NULL, 'pdf', @by, @sz)`
          );
        job.copied++;
        job.samples.copied.length < 25 && job.samples.copied.push(`${hit.TrackerNo} ← ${f.name}`);
      } catch (e) {
        job.errors++;
        job.samples.errors.length < 25 && job.samples.errors.push(`${f.name}: ${e.message}`);
      }
    }
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.log.push(`Done — matched ${job.matched}, copied ${job.copied}, unmatched ${job.unmatched}, errors ${job.errors}.`);
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
    job.log.push(`FAILED: ${e.message}`);
  }
}

/** POST /process  body { monthFolder } — start a background job, return its id. */
router.post('/process', async (req, res, next) => {
  try {
    if (!req.user || !req.user.empcode) return res.status(401).json({ success: false, error: 'Login required' });
    const monthFolder = String((req.body && req.body.monthFolder) || '').trim();
    if (!monthFolder || /[\\/]/.test(monthFolder)) {
      return res.status(400).json({ success: false, error: 'Enter a valid month folder name, e.g. July26' });
    }
    const id = 'rn_' + (++_jobSeq) + '_' + Date.now();
    const job = {
      id, monthFolder, status: 'running', error: null,
      total: 0, scanned: 0, matched: 0, copied: 0, unmatched: 0, errors: 0,
      samples: { copied: [], unmatched: [], errors: [] },
      log: [], startedAt: new Date().toISOString(), finishedAt: null,
      by: req.user.empcode,
    };
    jobs.set(id, job);
    // Keep only the last ~20 jobs.
    if (jobs.size > 20) { const oldest = [...jobs.keys()][0]; jobs.delete(oldest); }
    processJob(job, req.user.empcode);   // fire-and-forget
    res.json({ success: true, jobId: id, source: path.join(SOURCE_BASE, monthFolder) });
  } catch (err) { next(err); }
});

/** GET /progress/:jobId — current job state. */
router.get('/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Unknown job (it may have expired on a server restart)' });
  res.json({ success: true, job });
});

/** GET /jobs — recent jobs (newest first). */
router.get('/jobs', (req, res) => {
  res.json({ success: true, jobs: [...jobs.values()].reverse() });
});

module.exports = router;
