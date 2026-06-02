/**
 * Unified PDF text/table extractor.
 *
 * Strategy:
 *   1. Try pdf-parse (fast, free, native text PDFs)
 *   2. If pdf-parse returns empty text → fall back to Document AI
 *      (handles scanned/image PDFs, costs $$ but only fires when needed)
 *
 * Engines call extract(filePath) and receive { text, tables, pages,
 * source: 'pdf-parse' | 'docai' }.
 *
 * tables[i][j][k] = string  (page i, table j, row k = array of cell strings)
 *   pdf-parse path leaves tables as [] (no table extraction).
 *   docai path populates them from the Form Parser / Layout Parser output.
 */

const fs = require('fs');
const path = require('path');

/** Threshold: if pdf-parse text — after stripping page markers — is shorter
 *  than this many chars, treat as scanned and fall back to Document AI. */
const TEXT_FALLBACK_THRESHOLD = 200;

/** Strip page-number markers like "-- 3 of 24 --" that pdf-parse always
 *  emits but which carry no real content. */
function stripPageMarkers(text) {
  return String(text || '').replace(/^-+\s*\d+\s*of\s*\d+\s*-+$/gm, '');
}

async function extract(filePath) {
  // Step 1 — pdf-parse
  let text = '';
  let pages = 0;
  try {
    const { PDFParse } = require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buf });
    const res = await parser.getText();
    text  = res.text || '';
    pages = res.pages?.length || 0;
  } catch (err) {
    console.warn('[pdf-extract] pdf-parse failed:', err.message);
  }

  // Step 2 — if real content (excluding page markers) is too short, try Document AI
  const contentChars = stripPageMarkers(text).replace(/\s+/g, '').length;
  if (contentChars < TEXT_FALLBACK_THRESHOLD) {
    try {
      console.log(`[pdf-extract] ${path.basename(filePath)} has ${text.length} chars after pdf-parse — falling back to Document AI`);
      const { processPdf } = require('./docai');
      const docai = await processPdf(filePath);
      return {
        text: docai.text,
        tables: docai.tables,
        pages: docai.pages,
        source: 'docai',
      };
    } catch (err) {
      console.error('[pdf-extract] Document AI fallback failed:', err.message);
      // fall through with whatever pdf-parse gave us
    }
  }

  return { text, tables: [], pages, source: 'pdf-parse' };
}

module.exports = { extract };
