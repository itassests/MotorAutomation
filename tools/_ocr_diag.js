/**
 * tools/_ocr_diag.js — run ON THE SERVER to see exactly what the OCR worker
 * sees when locating a folder's PDFs. Usage:  node tools/_ocr_diag.js 1609
 */
require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { locateFolderPdfs } = require('../services/ocr-worker');

const DROP_DIR = process.env.OCR_ZIP_DROP_DIR
  || path.join(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'), 'ocr_dropzone');
const SOURCE_DIRS = String(process.env.OCR_SOURCE_DIRS || DROP_DIR)
  .split(/[;]/).map(s => s.trim()).filter(Boolean);
const folderKey = (name) =>
  String(name || '').replace(/^\d{1,2}-\d{1,2}-\d{2,4}_/, '').replace(/\.zip$/i, '').trim();

(async () => {
  const id = parseInt(process.argv[2] || '1609', 10);
  const live = await getPrarambhPool();
  const r = await live.request().query(
    `SELECT id, FolderPath FROM Trn_PrarambhOCRBulkUploadDetails WHERE id=${id}`);
  if (!r.recordset.length) { console.log('no folder', id); process.exit(0); }
  const folderName = r.recordset[0].FolderPath;
  const key = folderKey(folderName);
  console.log('folder id      :', id);
  console.log('DB FolderPath  :', folderName);
  console.log('stripped key   :', key);
  console.log('OCR_ZIP_DROP_DIR:', DROP_DIR);
  console.log('OCR_SOURCE_DIRS:', JSON.stringify(SOURCE_DIRS));
  console.log('');
  for (const base of SOURCE_DIRS) {
    let ents = [];
    let readable = true;
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { readable = false; console.log('  [base]', base, '-> UNREADABLE:', e.message); }
    if (!readable) continue;
    console.log('  [base]', base, '->', ents.length, 'entries');
    // show entries whose stripped key matches (in either direction)
    const hits = ents.filter(e => {
      const ek = folderKey(e.name);
      return ek === key || ek.indexOf(key) !== -1 || key.indexOf(ek) !== -1;
    });
    if (hits.length) {
      for (const h of hits) console.log('      MATCH:', (h.isDirectory() ? '[dir] ' : '[file]'), h.name);
    } else {
      // show a few names containing a distinctive token so we can eyeball the real name
      const tok = (key.match(/POSLG\d+/i) || [''])[0];
      const near = ents.filter(e => tok && e.name.toUpperCase().indexOf(tok.toUpperCase()) !== -1).slice(0, 5);
      console.log('      no key match.', near.length ? 'entries containing ' + tok + ':' : 'sample entries:');
      (near.length ? near : ents.slice(0, 5)).forEach(e => console.log('        -', e.name));
    }
  }
  console.log('');
  const loc = locateFolderPdfs(id, folderName);
  console.log('locateFolderPdfs result:', loc ? (loc.pdfs.length + ' PDFs in ' + loc.dir) : 'NULL (no_files)');
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
