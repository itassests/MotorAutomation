/**
 * Google Cloud Document AI service.
 *
 * Used as a fallback when a PDF carries no embedded text (scanned image
 * PDFs from insurers like New India Assurance).  Calls the configured
 * Document AI processor and returns the structured table + raw text.
 *
 * Configuration via environment variables OR config/docai.json:
 *   DOCAI_PROJECT   = "ocr-document-ai-496712"
 *   DOCAI_LOCATION  = "us"             (default: us)
 *   DOCAI_PROCESSOR = "3412da1bc7efcdb4"
 *   DOCAI_KEYFILE   = absolute path to the service-account JSON
 *                     (default: <repo>/config/docai-service-account.json)
 *
 * The credentials file is gitignored — never check it in.
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_KEYFILE = path.join(__dirname, '..', 'config', 'docai-service-account.json');
const DEFAULT_LOCATION = 'us';

function getConfig() {
  return {
    projectId:   process.env.DOCAI_PROJECT   || 'ocr-document-ai-496712',
    location:    process.env.DOCAI_LOCATION  || DEFAULT_LOCATION,
    processorId: process.env.DOCAI_PROCESSOR || '3412da1bc7efcdb4',
    keyFile:     process.env.DOCAI_KEYFILE   || DEFAULT_KEYFILE,
  };
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const cfg = getConfig();
  if (!fs.existsSync(cfg.keyFile)) {
    throw new Error(
      `Document AI key file not found at ${cfg.keyFile}. ` +
      `Set DOCAI_KEYFILE env var or place the service-account JSON there.`
    );
  }
  // Lazy import so the package is only loaded when actually used
  const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;
  _client = new DocumentProcessorServiceClient({
    keyFilename: cfg.keyFile,
    apiEndpoint: `${cfg.location}-documentai.googleapis.com`,
  });
  return _client;
}

/**
 * Process a PDF through the configured processor.
 *
 * @param {string} filePath - absolute path to the PDF
 * @returns {Promise<{ text: string, tables: TableRow[][][], pages: number }>}
 *   - text: concatenated text from all pages
 *   - tables: 3-D array: [pageIdx][tableIdx][rowIdx] = array of cell strings
 *   - pages: page count
 */
async function processPdf(filePath) {
  const cfg = getConfig();
  const client = getClient();
  const name = `projects/${cfg.projectId}/locations/${cfg.location}/processors/${cfg.processorId}`;

  const buf = fs.readFileSync(filePath);
  const request = {
    name,
    rawDocument: {
      content: buf.toString('base64'),
      mimeType: 'application/pdf',
    },
    // Imageless mode raises the sync-API page cap from 15 → 30. We don't
    // need page images downstream (we only consume text + tables), so this
    // is a free win for longer PDFs like New India's 24-page grids.
    imagelessMode: true,
  };

  console.log(`[docai] processing ${path.basename(filePath)} (${(buf.length/1024).toFixed(1)} KB) via processor ${cfg.processorId}…`);
  const [result] = await client.processDocument(request);
  const doc = result.document || {};
  const text = doc.text || '';
  const pages = doc.pages || [];

  // Extract structured tables — for each page, walk through doc.pages[].tables
  // and resolve each cell's text via the textSegments anchor.
  const tablesPerPage = pages.map(page => extractTables(page, text));

  console.log(`[docai] extracted ${text.length} chars, ${pages.length} pages, ${tablesPerPage.flat().length} tables`);
  return { text, tables: tablesPerPage, pages: pages.length };
}

/**
 * Extract tables from one Document AI page object.
 *
 * Each table → array of rows, each row → array of cell strings.
 */
function extractTables(page, docText) {
  const tables = page.tables || [];
  return tables.map(t => {
    const headerRows = (t.headerRows || []).map(r => rowToCells(r, docText));
    const bodyRows   = (t.bodyRows   || []).map(r => rowToCells(r, docText));
    return [...headerRows, ...bodyRows];
  });
}

function rowToCells(row, docText) {
  return (row.cells || []).map(cell => resolveAnchor(cell.layout?.textAnchor, docText).trim());
}

function resolveAnchor(anchor, docText) {
  if (!anchor || !anchor.textSegments) return '';
  let out = '';
  for (const seg of anchor.textSegments) {
    const start = Number(seg.startIndex || 0);
    const end   = Number(seg.endIndex   || 0);
    out += docText.slice(start, end);
  }
  return out;
}

module.exports = { processPdf, getConfig };
