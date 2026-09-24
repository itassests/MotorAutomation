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

// Document AI accepts images as well as PDFs, so a screenshot of a grid can be
// OCR'd on the same processor. Anything not listed here is rejected up-front
// with a clear message rather than failing inside the API call.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};
const mimeForFile = (fp) => MIME_BY_EXT[String(path.extname(fp)).toLowerCase()] || null;

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
async function processDocument(filePath, opts) {
  const cfg = getConfig();
  const client = getClient();
  const name = `projects/${cfg.projectId}/locations/${cfg.location}/processors/${cfg.processorId}`;

  const mimeType = mimeForFile(filePath);
  if (!mimeType) {
    throw new Error('Unsupported file type for Document AI: ' + path.extname(filePath) +
      ' (supported: ' + Object.keys(MIME_BY_EXT).join(', ') + ')');
  }
  const buf = fs.readFileSync(filePath);
  const request = {
    name,
    rawDocument: {
      content: buf.toString('base64'),
      mimeType,
    },
    // Imageless mode raises the sync-API page cap from 15 → 30. We don't
    // need page images downstream (we only consume text + tables), so this
    // is a free win for longer PDFs like New India's 24-page grids.
    ...(mimeType === 'application/pdf' ? { imagelessMode: true } : {}),
  };

  console.log(`[docai] processing ${path.basename(filePath)} (${(buf.length/1024).toFixed(1)} KB) via processor ${cfg.processorId}…`);
  const [result] = await client.processDocument(request);
  const doc = result.document || {};
  const text = doc.text || '';
  const pages = doc.pages || [];

  // Extract structured tables — for each page, walk through doc.pages[].tables
  // and resolve each cell's text via the textSegments anchor.
  // Native tables when the processor provides them. The geometric fallback is
  // OPT-IN (opts.reconstructTables): it is what makes screenshots usable, but on
  // a dense scanned PDF it can emit a very wide, mostly-empty grid, and feeding
  // that to parse-profile risks inventing junk rules for files that previously
  // produced none. Callers that want it ask for it (services/image-extract.js).
  const wantRecon = !!(opts && opts.reconstructTables);
  const tablesPerPage = pages.map((page) => {
    const native = extractTables(page, text);
    if (native.length) return native;
    return wantRecon ? reconstructTable(page, text) : [];
  });

  console.log(`[docai] extracted ${text.length} chars, ${pages.length} pages, ${tablesPerPage.flat().length} tables`);
  return { text, tables: tablesPerPage, pages: pages.length };
}


/**
 * Reconstruct a table from TOKEN COORDINATES.
 *
 * The configured processor is a plain Document-OCR one: it returns rich text +
 * per-token bounding boxes but NEVER populates page.tables (verified on both a
 * PNG and a 2-page PDF). Without this, every screenshot and scanned grid OCRs to
 * text and yields zero rules. So when no native table is present we rebuild the
 * grid geometrically: group tokens into rows by vertical position, then split
 * each row into cells on horizontal gaps, and align those cells into columns.
 *
 * Deliberately conservative — it only emits a table when the result looks like a
 * grid (>=2 rows and >=2 columns), so free prose does not become a fake table.
 */
function boxOf(layout) {
  const poly = layout && layout.boundingPoly;
  const v = poly && (poly.normalizedVertices && poly.normalizedVertices.length ? poly.normalizedVertices : poly.vertices);
  if (!v || !v.length) return null;
  const xs = v.map((q) => Number(q.x) || 0), ys = v.map((q) => Number(q.y) || 0);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

function reconstructTable(page, docText) {
  const toks = (page.tokens || [])
    .map((t) => ({ text: resolveAnchor(t.layout && t.layout.textAnchor, docText).replace(/\s+/g, ' ').trim(), box: boxOf(t.layout) }))
    .filter((t) => t.text && t.box);
  if (toks.length < 6) return [];

  // Typical token height drives the row-banding and gap thresholds, so this
  // works for both normalized (0-1) and pixel coordinate spaces.
  const heights = toks.map((t) => t.box.y1 - t.box.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 0;
  if (!medH) return [];

  // 1. group tokens into rows by vertical centre
  const rows = [];
  for (const t of toks.slice().sort((a, b) => (a.box.y0 - b.box.y0) || (a.box.x0 - b.box.x0))) {
    const cy = (t.box.y0 + t.box.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) <= medH * 0.6);
    if (row) { row.toks.push(t); row.cy = (row.cy * (row.toks.length - 1) + cy) / row.toks.length; }
    else rows.push({ cy, toks: [t] });
  }

  // 2. split each row into cells on horizontal gaps wider than ~1.5 token heights
  const gap = medH * 1.5;
  const celled = rows.map((r) => {
    const sorted = r.toks.sort((a, b) => a.box.x0 - b.box.x0);
    const cells = [];
    let cur = null;
    for (const t of sorted) {
      if (cur && t.box.x0 - cur.x1 <= gap) { cur.text += ' ' + t.text; cur.x1 = Math.max(cur.x1, t.box.x1); }
      else { cur = { text: t.text, x0: t.box.x0, x1: t.box.x1 }; cells.push(cur); }
    }
    return cells;
  }).filter((c) => c.length);
  if (celled.length < 2) return [];

  // 3. align cells into shared columns by left edge
  const edges = [];
  for (const row of celled) for (const c of row) {
    const e = edges.find((x) => Math.abs(x - c.x0) <= gap);
    if (e === undefined) edges.push(c.x0);
  }
  edges.sort((a, b) => a - b);
  if (edges.length < 2) return [];
  const colOf = (x) => { let best = 0, d = Infinity; edges.forEach((e, i) => { const dd = Math.abs(e - x); if (dd < d) { d = dd; best = i; } }); return best; };

  const grid = celled.map((row) => {
    const out = new Array(edges.length).fill('');
    for (const c of row) { const i = colOf(c.x0); out[i] = out[i] ? out[i] + ' ' + c.text : c.text; }
    return out;
  });
  return grid.length >= 2 ? [grid] : [];
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

const processPdf = processDocument;   // back-compat alias (PDF callers unchanged)
module.exports = { processDocument, processPdf, getConfig, mimeForFile, MIME_BY_EXT };
