'use strict';

/**
 * Parse an enabler email (.eml or .msg) into a structured deal for preview.
 *
 * Email parsing is inherently fragile (operators format these by hand), so this
 * extracts a best-effort draft — the UI shows it for the user to confirm/edit
 * before saving. Returns { header, rows, html } where header carries the deal-wide
 * fields (imd, segment, payout, window) and rows is one record per table line
 * (rto_location, transaction, make, coa_pct, discount_pct).
 */

const { simpleParser } = require('mailparser');

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                 jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
                 january: '01', february: '02', march: '03', april: '04', june: '06',
                 july: '07', august: '08', september: '09', october: '10',
                 november: '11', december: '12' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&ndash;|&#8211;/gi, '-').replace(/&[a-z]+;/gi, ' ');
}
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const num = (s) => { const m = String(s || '').match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };

// Walk <table> rows → array of cell-text arrays (dependency-free, mirrors pr.js).
function htmlTableRows(html) {
  const out = [];
  const tables = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tbl of tables) {
    const trs = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trs) {
      const tds = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      if (tds.length) out.push(tds.map(stripTags));
    }
  }
  return out;
}

// "GCV 3W (electric)" → { vehicle_type, is_3w, is_electric }
function parseSegment(seg) {
  const u = String(seg || '').toUpperCase();
  let vt = null;
  if (/\bGCV\b|GOODS/.test(u)) vt = 'GCV';
  else if (/\bPCV\b|PASSENGER/.test(u)) vt = 'PCV';
  else if (/\bTW\b|TWO\s*WHEEL|2\s*W\b/.test(u)) vt = 'TW';
  else if (/\bCAR\b|PVT|PRIVATE|4\s*W\b/.test(u)) vt = 'CAR';
  else if (/\bMISC\b/.test(u)) vt = 'MISC';
  return {
    vehicle_type: vt,
    is_3w: /\b3\s*W\b|3\s*WHEEL|THREE\s*WHEEL/.test(u) ? 1 : null,
    is_electric: /ELECTRIC|\bEV\b|BATTERY/.test(u) ? 1 : null,
  };
}

// "9th April to 30th April 2026" → { from:'2026-04-09', to:'2026-04-30' }
function parseWindow(text) {
  const t = String(text || '');
  const m = t.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+to\s+(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!m) return { from: null, to: null };
  const mo1 = MONTHS[m[2].toLowerCase()], mo2 = MONTHS[m[4].toLowerCase()];
  if (!mo1 || !mo2) return { from: null, to: null };
  const yr = m[5];
  return {
    from: `${yr}-${mo1}-${String(m[1]).padStart(2, '0')}`,
    to:   `${yr}-${mo2}-${String(m[3]).padStart(2, '0')}`,
  };
}

// Map the table header cells → canonical column indexes.
function mapColumns(headerCells) {
  const idx = { rto: -1, txn: -1, make: -1, coa: -1, disc: -1 };
  headerCells.forEach((h, i) => {
    const u = String(h || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (/RTO|LOCATION/.test(u) && idx.rto < 0) idx.rto = i;
    else if (/TRANS/.test(u)) idx.txn = i;
    else if (/MAKE/.test(u)) idx.make = i;
    else if (/COA/.test(u)) idx.coa = i;
    else if (/DISCOUNT/.test(u)) idx.disc = i;
  });
  return idx;
}

async function extractHtml(buffer, filename) {
  const isMsg = /\.msg$/i.test(filename || '') || (buffer[0] === 0xD0 && buffer[1] === 0xCF);
  if (isMsg) {
    const MsgReader = require('@kenjiuno/msgreader').default || require('@kenjiuno/msgreader');
    const reader = new MsgReader(buffer);
    const data = reader.getFileData();
    return data.bodyHTML || data.body || '';
  }
  const parsed = await simpleParser(buffer);
  return parsed.html || parsed.textAsHtml || parsed.text || '';
}

async function parseEnablerEmail(buffer, filename) {
  const html = await extractHtml(buffer, filename);
  const plain = stripTags(html);

  // Header fields (best-effort regex over the plain text).
  const imd = (plain.match(/\bIM[D]?\s*[-–:]?\s*(\d{5,})/i) || [])[1] || null;
  const segMatch = plain.match(/Segment\s*[-–:]\s*([A-Za-z0-9 ()\/]+?)(?:RTO|Discount|Approved|IMD|$)/i);
  const segment = segMatch ? segMatch[1].trim() : null;
  const cluster = (plain.match(/RTO\s*Cluster\s*[-–:]\s*([A-Za-z &]+?)(?:Discount|Approved|Segment|IMD|$)/i) || [])[1] || null;
  const payout = num((plain.match(/Approved\s*Payout\s*[-–:]\s*([\d.]+\s*%?)/i) || [])[1]);
  const win = parseWindow(plain);
  const segParts = parseSegment(segment);

  // Table rows.
  const rawRows = htmlTableRows(html);
  let rows = [];
  if (rawRows.length >= 2) {
    const idx = mapColumns(rawRows[0]);
    for (let i = 1; i < rawRows.length; i++) {
      const c = rawRows[i];
      const rto = idx.rto >= 0 ? c[idx.rto] : c[0];
      if (!rto) continue;
      const txn = idx.txn >= 0 ? c[idx.txn] : null;
      rows.push({
        rto_location: rto,
        transaction_type: txn,
        is_new: txn && /NEW/i.test(txn) ? 1 : null,
        make: idx.make >= 0 ? c[idx.make] : null,
        coa_pct: idx.coa >= 0 ? num(c[idx.coa]) : null,
        discount_pct: idx.disc >= 0 ? num(c[idx.disc]) : null,
      });
    }
  }

  return {
    header: {
      imd_code: imd ? (/^IM/i.test(imd) ? imd : 'IM-' + imd) : null,
      segment, cluster, approved_payout: payout,
      vehicle_type: segParts.vehicle_type, is_3w: segParts.is_3w, is_electric: segParts.is_electric,
      window_from: win.from, window_to: win.to,
    },
    rows,
    html,
  };
}

module.exports = { parseEnablerEmail, parseSegment, parseWindow, htmlTableRows };
