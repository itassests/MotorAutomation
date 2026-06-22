/**
 * Universal Sompo — single-sheet stacked-block layout.
 *
 * Some Universal Sompo broker grids arrive as ONE sheet ("Sheet1") with every
 * product stacked vertically as a titled block, instead of the usual one-tab-
 * per-product workbook. Each block has the SAME skeleton the per-tab engine
 * already parses (a "GVW/State" header row of state codes, then rate-label
 * rows), so we just split the sheet into blocks and DELEGATE each block to the
 * existing `universal-sompo` engine with the right `sheet_kind`.
 *
 * Detection is content-based: if no product blocks are found (e.g. a multi-tab
 * file that happens to have a "Sheet1"), we return [] so the per-tab entries
 * handle it instead. That makes the two layouts coexist — the engine picks
 * whichever matches the file's actual content.
 */
const us = require('./universal-sompo');
const STATE_CODES = us.STATE_CODES || {};

// Title row → sheet_kind. Order matters: "Non Tractor" must be tested before
// "Tractor", and "PCV Short Term" before plain "PCV".
const KIND_RULES = [
  { re: /non[\s-]*tractor/i,                          kind: 'non_tractor' },
  { re: /pcv\s*short\s*term|short\s*period|short\s*term.*pcv/i, kind: 'pcv_short' },
  { re: /\bpcv\b/i,                                   kind: 'pcv' },
  { re: /\btractor\b/i,                               kind: 'tractor' },
  { re: /pvt\s*car|private\s*car/i,                   kind: 'pvt_car' },
  { re: /\bcv\b|commercial\s*vehicle|\bgcv\b/i,       kind: 'cv' },
];

// Phrases that mark a NOTES row (terms, RTO lists, declines) — never a title.
// Kept tight: product titles legitimately mention "seating"/"package", so those
// are NOT here; titles are positively identified by a month-year / broker code.
const NOTE_WORDS = /terms|condition|declined|no\s*payout|vahan|sliding|mandatory|contribution|falsification|customer\s*state|rest of|all\s*rto|given grid/i;

// A real product-block title carries a month-year ("June-26", "Jun 26") or a
// broker code ("(AGRB)", "(AG-RB)", "(BR)", "- RB"). Notes lines don't.
const TITLE_MARKER = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s'’._-]*\d?2\d\b|\(\s*(ag|rb|br|ag-?rb)\b|\bag-?rb\b|[-\s]rb\s+[a-z]/i;

function kindFor(label) {
  for (const k of KIND_RULES) if (k.re.test(label)) return k.kind;
  return null;
}

/** Count cells in cols 1+ that are recognized state codes — identifies the
 *  real "GVW/State" header row (robust against notes rows containing "state"). */
function countStateCols(row) {
  let n = 0;
  const arr = row || [];
  for (let c = 1; c < arr.length; c++) {
    const code = String(arr[c] == null ? '' : arr[c]).trim().toUpperCase();
    if (code && STATE_CODES[code]) n++;
  }
  return n;
}

/** Find the product-block title rows: a short col-0-only row naming a product
 *  (with a date/grid marker), not a notes row. */
function detectBlocks(sheetData) {
  const titles = [];
  for (let r = 0; r < sheetData.length; r++) {
    const row = sheetData[r] || [];
    const c0 = String(row[0] == null ? '' : row[0]).trim();
    if (!c0) continue;
    const restNonEmpty = row.slice(1).filter(x => String(x == null ? '' : x).trim()).length;
    if (restNonEmpty > 0) continue;             // titles occupy only col 0
    if (NOTE_WORDS.test(c0)) continue;          // skip terms/notes lines
    const kind = kindFor(c0);
    if (!kind) continue;
    if (!TITLE_MARKER.test(c0)) continue;       // require a month-year / broker-code marker
    titles.push({ row: r, kind, title: c0 });
  }
  const blocks = [];
  for (let i = 0; i < titles.length; i++) {
    blocks.push({
      ...titles[i],
      startRow: titles[i].row,
      endRow: i + 1 < titles.length ? titles[i + 1].row : sheetData.length,
    });
  }
  return blocks;
}

function parse(sheetData, sheetConfig, meta) {
  const blocks = detectBlocks(sheetData);
  if (!blocks.length) return [];   // not a stacked file — let per-tab entries handle it

  const all = [];
  for (const b of blocks) {
    const blockData = sheetData.slice(b.startRow, b.endRow);
    // header row = first row in the block carrying ≥3 state codes
    let hdr = -1;
    for (let i = 0; i < blockData.length; i++) {
      if (countStateCols(blockData[i]) >= 3) { hdr = i; break; }
    }
    if (hdr < 0) {
      console.warn(`[us-stacked] block "${b.title}" (${b.kind}): no state header row found — skipped`);
      continue;
    }
    const cfg = { sheet_kind: b.kind, header_row: hdr, data_start_row: hdr + 1 };
    const blockMeta = { ...meta, sheetName: `${meta.sheetName} | ${b.title}` };
    try {
      const rules = us.parse(blockData, cfg, blockMeta);
      console.log(`[us-stacked] block "${b.title}" (${b.kind}) → ${rules.length} rules`);
      all.push(...rules);
    } catch (e) {
      console.error(`[us-stacked] block "${b.title}" (${b.kind}) failed:`, e.message);
    }
  }
  return all;
}

module.exports = { parse, detectBlocks };
