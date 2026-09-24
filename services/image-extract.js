/**
 * image-extract.js — pull rate grids out of an IMAGE of a grid (.png/.jpg/…).
 *
 * Insurers increasingly circulate a screenshot of a table instead of a
 * workbook (e.g. "Magma 4th Sep Effective.png"). Those uploads used to fall
 * through to XLSX.readFile and land a rate card with ZERO rules. Here we OCR
 * the image on the same Document AI processor the scanned-PDF path already
 * uses, and return the tables in exactly the shape services/email-extract.js
 * produces — so routes/upload.js can run images through the identical
 * doc-router + parse-profile pipeline (RTO master / fleet / enabler / rates).
 *
 * Requires Document AI to be configured (see services/docai.js). When it is
 * not, the caller gets a clear error rather than a silent empty card.
 */
const path = require('path');

/** Rows that are entirely blank add nothing and confuse layout profiling. */
const isBlankRow = (r) => !r || r.every((c) => String(c == null ? '' : c).trim() === '');

/**
 * OCR an image into candidate grid tables.
 * @returns {Promise<{format:string,subject:string,date:null,bodyText:string,
 *                    bodyHtml:string,tables:string[][][],attachments:[],
 *                    effective:{from:null,to:null,bounded:boolean}}>}
 */
async function extractImage(filePath) {
  const { processDocument } = require('./docai');
  const { text, tables } = await processDocument(filePath, { reconstructTables: true });

  // docai returns [page][table][row][cell] — flatten to a list of tables and
  // drop anything too small to be a grid (a stray 1-row block is noise).
  const flat = (tables || []).flat()
    .map((t) => (t || []).filter((r) => !isBlankRow(r)))
    .filter((t) => t.length >= 2);

  return {
    format: 'image',
    subject: path.basename(filePath),
    date: null,
    bodyText: text || '',
    bodyHtml: '',
    tables: flat,
    attachments: [],
    // An image carries no reliable validity window — the uploader supplies
    // effective_from. detectWindow() still gets a shot at the OCR'd text via
    // the caller, but we never claim a bounded deal window from a screenshot.
    effective: { from: null, to: null, bounded: false },
  };
}

module.exports = { extractImage };
