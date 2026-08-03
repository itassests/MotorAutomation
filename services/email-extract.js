'use strict';

/**
 * email-extract.js — pull rate grids out of .eml / .msg files.
 *
 * Insurers frequently ship (or revise) grids by email. The grid may live as:
 *   • inline HTML table(s) in the body        → extracted here as row arrays
 *   • an xlsx / xls attachment                → returned as a buffer to parse
 *   • a pdf attachment                        → returned as a buffer (config parse)
 *   • an image attachment (jpg/png of a grid) → flagged (needs OCR)
 *   • prose only (a note referencing a file)  → no grid
 *
 * Returns a NORMALISED shape for both formats so the caller (upload route) can
 * feed tables + sheet-attachments straight into the dynamic parse-profile engine
 * and flag image/prose for review.
 *
 *   const { extractEmail } = require('./email-extract');
 *   const info = await extractEmail(filePath);
 *   // { subject, date, bodyText, bodyHtml, tables:[[["c","c"],...]], attachments:[...], effective:{from,to} }
 */
const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');

let MsgReader = null;
try { MsgReader = require('@kenjiuno/msgreader').default || require('@kenjiuno/msgreader'); } catch (_) { /* optional */ }

const SHEET_EXT = /\.(xlsx|xls|xlsb|csv)$/i;
const PDF_EXT = /\.pdf$/i;
const IMG_EXT = /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i;

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Walk every <table> in an HTML string → array of tables, each rows[][] of cell text. */
function htmlTables(html) {
  const out = [];
  const tables = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tbl of tables) {
    const rows = [];
    const trs = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trs) {
      const tds = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      if (tds.length) rows.push(tds.map(stripTags));
    }
    if (rows.length) out.push(rows);
  }
  return out;
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
function monNum(name) {
  const k = String(name || '').slice(0, 3).toLowerCase();
  return MONTHS[k] || null;
}

/**
 * Detect an effective window from subject/body text. Handles:
 *   "20th - 31st July"      → { from: yyyy-07-20, to: yyyy-08-01 }  (to = day after, exclusive)
 *   "9th April to 30th April 2026"
 *   "w.e.f 1st August 2026" / "with effect from 01-Aug-26" → { from, to: null }
 * Year defaults to the email's year when omitted. `to` is EXCLUSIVE (first day the
 * grid is no longer effective) to match rate_cards.effective_to convention.
 */
function detectWindow(text, fallbackYear) {
  const t = String(text || '');
  const yr = () => String(fallbackYear || new Date().getUTCFullYear());
  // range: "DD Mon - DD Mon YYYY" or "DD - DD Mon YYYY" or "DD Mon to DD Mon YYYY"
  let m = t.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*([A-Za-z]{3,})?\s*(?:-|–|—|to)\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s*([A-Za-z]{3,})\s*(\d{4})?/i);
  if (m) {
    const mo2 = monNum(m[4]);
    const mo1 = monNum(m[2]) || mo2;
    if (mo1 && mo2) {
      const y = m[5] || yr();
      const from = `${y}-${mo1}-${String(m[1]).padStart(2, '0')}`;
      // to = day AFTER the last day (exclusive). Compute via Date.
      const last = new Date(`${y}-${mo2}-${String(m[3]).padStart(2, '0')}T00:00:00Z`);
      last.setUTCDate(last.getUTCDate() + 1);
      const to = last.toISOString().slice(0, 10);
      return { from, to, bounded: true };
    }
  }
  // w.e.f / with effect from single date
  m = t.match(/(?:w\.?e\.?f\.?|with\s+effect\s+from|effective(?:\s+from)?)\s*:?\s*(\d{1,2})\s*(?:st|nd|rd|th)?[\s\-/]*([A-Za-z]{3,})[\s\-/]*(\d{2,4})?/i);
  if (m) {
    const mo = monNum(m[2]);
    if (mo) {
      let y = m[3] || yr();
      if (y.length === 2) y = '20' + y;
      return { from: `${y}-${mo}-${String(m[1]).padStart(2, '0')}`, to: null, bounded: false };
    }
  }
  return { from: null, to: null, bounded: false };
}

/** Parse an .eml buffer via mailparser → normalised email info. */
async function parseEml(buf) {
  const mail = await simpleParser(buf);
  const atts = (mail.attachments || []).map((a) => normAtt(a.filename, a.content, a.contentType));
  return {
    format: 'eml',
    subject: mail.subject || '',
    date: mail.date || null,
    bodyText: mail.text || '',
    bodyHtml: mail.html || '',
    tables: htmlTables(mail.html),
    attachments: atts,
  };
}

/** Parse a .msg buffer via msgreader → normalised email info. */
function parseMsg(buf) {
  if (!MsgReader) throw new Error('.msg support unavailable (@kenjiuno/msgreader not loaded)');
  const reader = new MsgReader(buf);
  const d = reader.getFileData();
  const atts = (d.attachments || []).map((a, i) => {
    let content = null;
    try { content = reader.getAttachment(a).content; } catch (_) { /* some inline items fail */ }
    return normAtt(a.fileName, content ? Buffer.from(content) : null, a.attachMimeTag);
  });
  return {
    format: 'msg',
    subject: d.subject || '',
    date: d.messageDeliveryTime ? new Date(d.messageDeliveryTime) : null,
    bodyText: d.body || '',
    bodyHtml: d.bodyHTML || '',
    tables: htmlTables(d.bodyHTML),
    attachments: atts,
  };
}

function normAtt(filename, buffer, mime) {
  const name = filename || 'attachment';
  const ext = (path.extname(name) || '').toLowerCase();
  const isSheet = SHEET_EXT.test(name) || /spreadsheet|excel|csv/i.test(mime || '');
  const isPdf = PDF_EXT.test(name) || /pdf/i.test(mime || '');
  const isImage = IMG_EXT.test(name) || /^image\//i.test(mime || '');
  return { filename: name, ext, mime: mime || '', buffer: buffer || null, size: buffer ? buffer.length : 0, isSheet, isPdf, isImage };
}

/**
 * Extract a rate-grid-bearing structure from a .eml/.msg file (path or buffer).
 * Adds a detected effective window (from subject then body).
 */
async function extractEmail(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const name = Buffer.isBuffer(input) ? '' : String(input);
  const isMsg = /\.msg$/i.test(name) || (buf.length > 8 && buf[0] === 0xD0 && buf[1] === 0xCF); // OLE magic
  const info = isMsg ? parseMsg(buf) : await parseEml(buf);
  const year = info.date ? new Date(info.date).getUTCFullYear() : undefined;
  info.effective = detectWindow(info.subject, year);
  if (!info.effective.from) info.effective = detectWindow(info.bodyText, year);
  return info;
}

module.exports = { extractEmail, htmlTables, detectWindow, stripTags };
