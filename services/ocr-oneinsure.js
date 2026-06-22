/**
 * services/ocr-oneinsure.js — OneInsure 2-step OCR.
 *
 *   1) GetFileInJson : POST the PDF as multipart form-data, field "file",
 *      content-type application/octet-stream (per the existing .NET client) →
 *      returns a response body.
 *   2) GetOCRdata    : POST that response → triggers the OCR.
 *
 * NOTE: GetOCRdata's HTTP body is only a status flag (typically
 * [{"Prarambhmainid":0,"Result":"False"}]) — it does NOT carry the policy
 * number. The engine writes the extracted number synchronously into
 * Prarambh_Live.TRN_PrarambhMotorMISUpdation.POLICY_NO (keyed by
 * PrarambhMainId); the worker reads it back from there (ocr-worker.lookupPolicyNo).
 * The tolerant findPolicyNo() below is kept only as a best-effort fast path in
 * case a future response ever includes the number.
 *
 * Defaults point at PRODUCTION (no auth); override per-env if needed.
 * Config (env): OCR_GETFILE_URL, OCR_GETOCR_URL, OCR_FILE_FIELD (default "file"),
 *               OCR_POLICY_FIELD (optional exact JSON key).
 */
const fs = require('fs');
const path = require('path');

const GETFILE_URL = process.env.OCR_GETFILE_URL
  || 'https://oneerpapi.oneinsure.com/api/master/GetFileInJson';
const GETOCR_URL = process.env.OCR_GETOCR_URL
  || 'https://oneerpapi.oneinsure.com/api/master/GetOCRdata';
const FILE_FIELD = process.env.OCR_FILE_FIELD || 'file';
const POLICY_FIELD = (process.env.OCR_POLICY_FIELD || '').trim();   // optional exact key

let _logged = 0;
const LOG_BUDGET = parseInt(process.env.OCR_LOG_BUDGET || '8', 10);
function logRaw(tag, value) {
  if (_logged >= LOG_BUDGET) return;
  _logged++;
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s && s.length > 4000) s = s.slice(0, 4000) + `…(+${s.length - 4000} chars)`;
  console.log(`[ocr-oneinsure] RAW ${tag}: ${s}`);
}

async function readBody(res) {
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; } catch (_) { return { json: null, text }; }
}

/** Find the policy number — exact configured key first, then a tolerant search. */
function findPolicyNo(obj, depth = 0) {
  if (obj == null || depth > 7) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findPolicyNo(v, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    if (POLICY_FIELD) {
      for (const [k, v] of Object.entries(obj)) {
        if (k.toLowerCase() === POLICY_FIELD.toLowerCase()
            && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase().replace(/[^a-z]/g, '');
      if (['policyno', 'policynumber', 'policynum', 'plcyno', 'plcynumber'].includes(key)
          && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
    }
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if (key.includes('policy') && /(no\b|number|num)/.test(key)
          && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
    }
    for (const v of Object.values(obj)) { const r = findPolicyNo(v, depth + 1); if (r) return r; }
  }
  return null;
}

/** Run the 2-step OCR on a PDF.
 *  opts: { tracker, prarambhMainId, uploadName, docPassword } — GetFileInJson
 *  (a .NET endpoint) requires all of these alongside the file; omitting them
 *  triggers a server-side NullReferenceException. */
async function runOcr(pdfPath, opts = {}) {
  const buf = fs.readFileSync(pdfPath);

  // Step 1 — GetFileInJson: multipart "file" (octet-stream) + required fields.
  const form = new FormData();
  form.append(FILE_FIELD, new Blob([buf], { type: 'application/octet-stream' }), path.basename(pdfPath));
  form.append('Tracker', String(opts.tracker || ''));
  form.append('UploadName', String(opts.uploadName || path.basename(pdfPath)));
  form.append('PrarambhMainId', String(opts.prarambhMainId == null ? '' : opts.prarambhMainId));
  form.append('DocPassword', String(opts.docPassword || ''));
  const res1 = await fetch(GETFILE_URL, { method: 'POST', body: form });
  const body1 = await readBody(res1);
  logRaw('GetFileInJson(' + res1.status + ')', body1.text);
  if (!res1.ok) throw new Error(`GetFileInJson ${res1.status}: ${(body1.text || '').slice(0, 300)}`);
  const step1Payload = body1.json != null ? body1.json : body1.text;

  // Step 2 — GetOCRdata: pass the step-1 response, expect JSON back.
  const res2 = await fetch(GETOCR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(step1Payload),
  });
  const body2 = await readBody(res2);
  logRaw('GetOCRdata(' + res2.status + ')', body2.text);
  if (!res2.ok) throw new Error(`GetOCRdata ${res2.status}: ${(body2.text || '').slice(0, 300)}`);

  const ocrJson = body2.json;
  const policyNo = ocrJson != null ? findPolicyNo(ocrJson) : null;
  return {
    policyNo, ocrJson, ocrText: body2.text,
    // Diagnostics so a "no policy" failure shows the whole 2-step flow in the DB.
    fileStatus: res1.status, fileText: body1.text,
    sentToStep2: JSON.stringify(step1Payload),
    ocrStatus: res2.status,
  };
}

module.exports = { runOcr, findPolicyNo, GETFILE_URL, GETOCR_URL };
