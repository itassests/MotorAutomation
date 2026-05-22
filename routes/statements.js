/**
 * Insurer statement upload + match.
 *
 * The master "statement Mapping.xlsx" in config/statement_mapping/ encodes
 * the per-insurer column names. Column A = canonical SystemCol label,
 * Column B = our system column name, Columns D..end = one per insurer
 * ("Bajaj GI", "Chola M S", …) holding the column name that insurer uses
 * in their statement.
 *
 * Upload flow:
 *   1. User picks insurer + month + year and attaches an Excel/CSV statement.
 *   2. We look up that insurer's column header mapping.
 *   3. Parse the uploaded file, map each row to our canonical fields.
 *   4. Insert one row per policy into statement_rows. Totals update the
 *      parent statement_uploads record.
 *
 * Endpoints:
 *   GET  /api/statements/mapping                          → master mapping
 *   GET  /api/statements/insurers                         → insurers from the mapping
 *   POST /api/statements/upload   file+insurer+month+year → parse + store
 *   GET  /api/statements                                  → list uploads
 *   GET  /api/statements/:id                              → upload details
 *   GET  /api/statements/:id/rows?limit=200               → per-policy rows
 *   DELETE /api/statements/:id                            → soft-delete
 *   GET  /api/statements/match?policy_no=…                → find best match across active statements
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const sql = require('mssql');
const XLSX = require('xlsx');
const { getPool } = require('../db/connection');

const router = express.Router();

const MAPPING_FILE = path.resolve(__dirname, '..', 'config', 'statement_mapping', 'statement_mapping.xlsx');

// ─── Load + cache mapping on startup ───────────────────────────────────────

let _mappingCache = null;

/**
 * Parse the master mapping Excel into a structured object:
 *   {
 *     insurerLabels: [{ label, slug, columnIndex }, …],
 *     fields: [{ impField, systemCol, columnsByInsurerSlug: {slug: "header"} }, …]
 *   }
 * Non-mapped cells ('NA' / blank) are dropped from columnsByInsurerSlug so the
 * upload parser can iterate only real columns.
 */
function loadMapping() {
  if (_mappingCache) return _mappingCache;
  if (!fs.existsSync(MAPPING_FILE)) {
    throw new Error('Statement mapping file not found at ' + MAPPING_FILE);
  }
  const wb = XLSX.readFile(MAPPING_FILE);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Header row: ['Imp Fields','SystemCol','', 'Bajaj GI', 'Chola M S', …]
  const header = aoa[0] || [];
  const insurerLabels = [];
  for (let i = 2; i < header.length; i++) {   // column C onward
    const raw = String(header[i] || '').trim();
    if (!raw) continue;
    insurerLabels.push({
      label: raw,
      slug: slugifyInsurer(raw),
      columnIndex: i,
    });
  }

  const fields = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const impField = String(row[0] || '').trim();
    const systemCol = String(row[1] || '').trim();
    if (!impField) continue;

    const columnsByInsurerSlug = {};
    for (const ins of insurerLabels) {
      const cell = String(row[ins.columnIndex] || '').trim();
      if (!cell || cell.toUpperCase() === 'NA') continue;
      columnsByInsurerSlug[ins.slug] = cell;
    }
    fields.push({ impField, systemCol, columnsByInsurerSlug });
  }

  _mappingCache = { insurerLabels, fields };
  return _mappingCache;
}

/** Normalise insurer labels from the mapping header to our standard slugs. */
function slugifyInsurer(label) {
  const s = String(label).toLowerCase().trim();
  if (/digit/.test(s)) return 'go_digit';
  if (/chola/.test(s)) return 'chola_ms';
  if (/bajaj/.test(s)) return 'bajaj_allianz';
  if (/hdfc/.test(s)) return 'hdfc_ergo';
  if (/icici/.test(s)) return 'icici_lombard';
  if (/tata/.test(s)) return 'tata_aig';
  if (/reliance/.test(s)) return 'reliance';
  if (/iffco/.test(s)) return 'iffco_tokio';
  if (/zuno|edelweiss/.test(s)) return 'zuno';
  if (/liberty/.test(s)) return 'liberty';
  if (/magma/.test(s)) return 'magma';
  if (/national/.test(s)) return 'national';
  if (/new india/.test(s)) return 'new_india';
  if (/oriental/.test(s)) return 'oriental';
  if (/raheja/.test(s)) return 'raheja_qbe';
  if (/royal/.test(s)) return 'royal_sundaram';
  if (/sbi/.test(s)) return 'sbi_general';
  if (/united/.test(s)) return 'united_india';
  if (/universal/.test(s)) return 'universal_sompo';
  if (/future/.test(s)) return 'future_generali';
  if (/kotak/.test(s)) return 'kotak';
  if (/shriram/.test(s)) return 'shriram';
  // Fallback: snake_case the label
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Canonical → insurer-specific header resolver. */
function resolveInsurerColumn(mapping, insurerSlug, impField) {
  const f = mapping.fields.find(x => x.impField.toLowerCase() === impField.toLowerCase());
  if (!f) return null;
  return f.columnsByInsurerSlug[insurerSlug] || null;
}

/** Strip a trailing month-year suffix (e.g. "_Jan25", "_Mar26", "_FEB_25").
 * Some insurer mappings hardcode the suffix and the actual column in a new
 * upload is named for a different month — we treat the stripped prefix as
 * the canonical name and match any column in the row that starts with it. */
function stripMonthYearSuffix(s) {
  if (!s) return s;
  return String(s).replace(/[_\s]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[_\s]*\d{2,4}\s*$/i, '').trim();
}

/**
 * Read a cell from a parsed row, trying several candidate column names.
 * Matches are case-insensitive and tolerant of trailing month-year suffixes
 * (so "TOTAL_AMT_Jan25" in the mapping also matches "TOTAL_AMT_Mar26",
 * "TOTAL_AMT_Feb_26", or just "TOTAL_AMT" in the statement).
 */
function pickCell(row, candidateNames) {
  if (!row) return null;
  const keys = Object.keys(row);
  // Build two indices:
  //   idxStrict — uppercase + trim only (preserves underscores & spaces)
  //   idxNorm   — strips ALL non-alphanumeric (so "Policy_No" / "Policy No"
  //               / "Policy-No" / "Policy.No" all collapse to "POLICYNO").
  // Mapping files often use one form ("Policy no") while statement files
  // ship another ("Policy_No"). Normalising both sides guarantees we still
  // match.
  const idxStrict = {};
  const idxNorm = {};
  const stripAll = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const k of keys) {
    idxStrict[String(k).trim().toUpperCase()] = { original: k, value: row[k] };
    const n = stripAll(k);
    if (n) idxNorm[n] = { original: k, value: row[k] };
  }
  for (const name of candidateNames) {
    if (!name) continue;
    const want = String(name).trim().toUpperCase();
    // 1. Exact (case-insensitive) match
    if (idxStrict[want] && idxStrict[want].value !== undefined && idxStrict[want].value !== null && idxStrict[want].value !== '') {
      return idxStrict[want].value;
    }
    // 2. Punctuation/whitespace-tolerant match — "Policy no" ⇔ "Policy_No".
    const wantNorm = stripAll(want);
    if (wantNorm && idxNorm[wantNorm] && idxNorm[wantNorm].value !== undefined && idxNorm[wantNorm].value !== null && idxNorm[wantNorm].value !== '') {
      return idxNorm[wantNorm].value;
    }
    // 3. Match after stripping month-year suffix on both sides — covers
    //    "TOTAL_AMT_Jan25" (mapping) vs "TOTAL_AMT_Mar26" (actual file).
    const wantStripped = stripMonthYearSuffix(want).toUpperCase();
    if (wantStripped && wantStripped !== want) {
      for (const k of keys) {
        const ks = stripMonthYearSuffix(String(k)).toUpperCase();
        if (ks === wantStripped && row[k] !== undefined && row[k] !== null && row[k] !== '') {
          return row[k];
        }
      }
      // Same as (2) but for the stripped form
      const wantStrippedNorm = stripAll(wantStripped);
      if (wantStrippedNorm && idxNorm[wantStrippedNorm] && idxNorm[wantStrippedNorm].value !== undefined && idxNorm[wantStrippedNorm].value !== null && idxNorm[wantStrippedNorm].value !== '') {
        return idxNorm[wantStrippedNorm].value;
      }
    }
    // 4. Fall back: case-insensitive prefix match on the stripped form
    if (wantStripped) {
      for (const k of keys) {
        const ku = String(k).trim().toUpperCase();
        if (ku.startsWith(wantStripped) && row[k] !== undefined && row[k] !== null && row[k] !== '') {
          return row[k];
        }
      }
      // Punctuation-stripped prefix
      const wantStrippedNorm = stripAll(wantStripped);
      if (wantStrippedNorm) {
        for (const n of Object.keys(idxNorm)) {
          if (n.startsWith(wantStrippedNorm) && idxNorm[n].value !== undefined && idxNorm[n].value !== null && idxNorm[n].value !== '') {
            return idxNorm[n].value;
          }
        }
      }
    }
  }
  return null;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,\s₹]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ─── Endpoints ─────────────────────────────────────────────────────────────

/** GET /mapping — full parsed mapping (for debugging / UI display). */
router.get('/mapping', (req, res, next) => {
  try {
    res.json({ success: true, mapping: loadMapping() });
  } catch (err) { next(err); }
});

/** GET /insurers — just the insurer list from the mapping. */
router.get('/insurers', (req, res, next) => {
  try {
    res.json({ success: true, insurers: loadMapping().insurerLabels });
  } catch (err) { next(err); }
});

/**
 * POST /upload — multipart field 'file' + body: insurer_slug, month, year.
 * (Multer wiring happens in server.js so this handler sees req.file.)
 */
router.post('/upload', async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded. Use field name "file".' });
    }
    const insurerSlug = String(req.body.insurer_slug || '').trim();
    const month = parseInt(req.body.month, 10);
    const year  = parseInt(req.body.year, 10);
    if (!insurerSlug) return res.status(400).json({ success: false, error: 'insurer_slug required' });
    if (!(month >= 1 && month <= 12)) return res.status(400).json({ success: false, error: 'month 1..12 required' });
    if (!(year >= 2000 && year <= 2100)) return res.status(400).json({ success: false, error: 'year required' });

    const mapping = loadMapping();
    const known = mapping.insurerLabels.find(x => x.slug === insurerSlug);
    if (!known) return res.status(400).json({ success: false, error: `Insurer slug "${insurerSlug}" not in mapping` });

    // Which column name does THIS insurer use for each canonical field?
    const col = (impField) => resolveInsurerColumn(mapping, insurerSlug, impField);
    const columnMap = {
      policy_no:        col('Policy No'),
      alt_policy_no:    col('Alt policy No'),
      policy_issued:    col('Policy Issued Date'),
      total_commission: col('total commission'),
      od_commission:    col('OD commission'),
      addon_commission: col('ADD ON commission'),
      tp_commission:    col('TP commission'),
      pa_commission:    col('PA commission'),
      terror_commission:col('Terr commission'),
      reward:           col('Reward'),
      net_amount:       col('NetAmount'),
      gross_amount:     col('GrossAmount'),
      od_premium:       col('ODPremium'),
      total_od_premium: col('TotalODPremium'),
      addon_premium:    col('AddOnPremium'),
      tp_premium:       col('TPPremium'),
      sum_insured:      col('SumInsured'),
    };

    // Parse file (xlsx, xls, csv all supported by XLSX.readFile).
    // TATA-style payout files often ship with a title / metadata row above
    // the actual header (so XLSX.utils.sheet_to_json with defaults picks up
    // garbage header), and sometimes the data lives in a sheet named "Data"
    // / "Sheet2" rather than the first sheet. Probe each sheet and each
    // plausible header row (rows 0..9), pick the one that yields a row
    // where pickCell finds policy_no for THIS insurer.
    let rows;
    let pickedSheet = null;
    let pickedHeaderRow = 0;
    let probeReport = [];
    try {
      const wb = XLSX.readFile(req.file.path);
      const policyCandidates = [columnMap.policy_no, columnMap.alt_policy_no, 'POLICY NO', 'PolicyNo'].filter(Boolean);
      let best = null;
      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        // Read as raw 2D array so we can scan for the header row
        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
        if (!matrix.length) continue;
        // Try the default (header = row 0) first, then scan first 10 rows
        // for one whose values include a candidate policy-no column.
        const maxScanRow = Math.min(10, matrix.length - 1);
        for (let h = 0; h <= maxScanRow; h++) {
          const headerRow = matrix[h] || [];
          const headerCells = headerRow.map(c => String(c || '').trim());
          // Does any header cell match a policy-no candidate (case-insensitive,
          // tolerant of trailing month-year suffixes / punctuation)?
          const norm = (s) => stripMonthYearSuffix(String(s || '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
          const headerNorm = headerCells.map(norm);
          const hasPolicyCol = policyCandidates.some(c => {
            const cn = norm(c);
            return cn && headerNorm.some(hn => hn === cn || hn.startsWith(cn) || cn.startsWith(hn) && hn.length >= 6);
          });
          if (hasPolicyCol) {
            // Convert remaining rows to objects keyed by this header
            const dataRows = matrix.slice(h + 1).map(arr => {
              const obj = {};
              headerCells.forEach((k, i) => { if (k) obj[k] = arr[i] !== undefined ? arr[i] : ''; });
              return obj;
            }).filter(r => Object.values(r).some(v => v !== '' && v != null));
            const policyHits = dataRows.filter(r => pickCell(r, policyCandidates) != null).length;
            probeReport.push({ sheet: sheetName, header_row: h, headers_sample: headerCells.slice(0, 10), data_rows: dataRows.length, policy_hits: policyHits });
            if (policyHits > 0 && (!best || policyHits > best.policyHits)) {
              best = { sheet: sheetName, headerRow: h, dataRows, policyHits };
            }
          } else if (h === 0) {
            probeReport.push({ sheet: sheetName, header_row: 0, headers_sample: headerCells.slice(0, 10), note: 'no policy-no column' });
          }
        }
      }
      if (best) {
        rows = best.dataRows;
        pickedSheet = best.sheet;
        pickedHeaderRow = best.headerRow;
      } else {
        // No sheet/header-row had a policy_no column. Preserve the file
        // for diagnosis (don't delete on this failure) and return a
        // verbose error showing every sheet's first row.
        const summaries = (probeReport.length ? probeReport : [{ note: 'no sheets parsed' }])
          .filter(p => p.header_row === 0)
          .map(p => `Sheet "${p.sheet}": [${(p.headers_sample || []).map(h => JSON.stringify(h)).join(', ')}]`);
        return res.status(400).json({
          success: false,
          error: `Could not locate a "policy no" column. ` +
                 `Expected one of: ${policyCandidates.join(' / ')}. ` +
                 `Found — ${summaries.join(' | ')}`,
          probe: probeReport,
          mapping_used: columnMap,
          diagnostic_file_path: req.file.path,
        });
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: 'Failed to parse file: ' + err.message });
    }

    const pool = await getPool();

    // Insert the parent upload record first
    const up = await pool.request()
      .input('slug',  sql.VarChar(100), insurerSlug)
      .input('label', sql.NVarChar(200), known.label)
      .input('m',     sql.Int, month)
      .input('y',     sql.Int, year)
      .input('fn',    sql.NVarChar(500), req.file.originalname || req.file.filename || '')
      .query(`INSERT INTO statement_uploads (insurer_slug, insurer_label, month, year, file_name)
              OUTPUT INSERTED.id
              VALUES (@slug, @label, @m, @y, @fn)`);
    const uploadId = up.recordset[0].id;

    // Insert rows one-by-one (transactional insert — rollback on error).
    const tx = pool.transaction();
    await tx.begin();
    try {
      let inserted = 0;
      let totalAmt = 0;
      for (const raw of rows) {
        const policyNoRaw = pickCell(raw, [columnMap.policy_no, columnMap.alt_policy_no, 'POLICY NO', 'PolicyNo']);
        if (!policyNoRaw) continue; // skip rows without a policy number
        const policyNo = String(policyNoRaw).trim();

        const amount   = toNumber(pickCell(raw, [columnMap.total_commission]));
        const odComm   = toNumber(pickCell(raw, [columnMap.od_commission]));
        const addComm  = toNumber(pickCell(raw, [columnMap.addon_commission]));
        const tpComm   = toNumber(pickCell(raw, [columnMap.tp_commission]));
        const paComm   = toNumber(pickCell(raw, [columnMap.pa_commission]));
        const terComm  = toNumber(pickCell(raw, [columnMap.terror_commission]));
        const netAmt   = toNumber(pickCell(raw, [columnMap.net_amount]));
        const grossAmt = toNumber(pickCell(raw, [columnMap.gross_amount]));
        const reward   = toNumber(pickCell(raw, [columnMap.reward]));

        // Total Amount on the upload record = sum of total commission (the
        // insurer's "TOTAL_AMT" / PointOut column — varies per insurer and is
        // resolved via the mapping). Falls back to gross / net if the total
        // commission column isn't published by that insurer.
        const amountForTotal = amount  != null ? amount
                             : (grossAmt != null ? grossAmt
                             : (netAmt   != null ? netAmt   : 0));
        totalAmt += amountForTotal || 0;
        inserted++;

        await tx.request()
          .input('uid',   sql.Int, uploadId)
          .input('slug',  sql.VarChar(100), insurerSlug)
          .input('pn',    sql.NVarChar(200), policyNo)
          .input('amt',   sql.Decimal(18, 2), amount)
          .input('od',    sql.Decimal(18, 2), odComm)
          .input('ad',    sql.Decimal(18, 2), addComm)
          .input('tp',    sql.Decimal(18, 2), tpComm)
          .input('pa',    sql.Decimal(18, 2), paComm)
          .input('ter',   sql.Decimal(18, 2), terComm)
          .input('net',   sql.Decimal(18, 2), netAmt)
          .input('gross', sql.Decimal(18, 2), grossAmt)
          .input('rew',   sql.Decimal(18, 2), reward)
          .input('raw',   sql.NVarChar(sql.MAX), JSON.stringify(raw))
          .query(`INSERT INTO statement_rows
                 (upload_id, insurer_slug, policy_no, amount, od_commission, addon_commission,
                  tp_commission, pa_commission, terror_commission, net_amount, gross_amount, reward, raw_json)
                 VALUES (@uid, @slug, @pn, @amt, @od, @ad, @tp, @pa, @ter, @net, @gross, @rew, @raw)`);
      }

      await pool.request()
        .input('id',    sql.Int, uploadId)
        .input('rc',    sql.Int, inserted)
        .input('total', sql.Decimal(18, 2), totalAmt)
        .query(`UPDATE statement_uploads SET row_count = @rc, total_amount = @total WHERE id = @id`);

      await tx.commit();

      // Cleanup temp upload file
      try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }

      res.json({
        success: true,
        upload_id: uploadId,
        rows_parsed: rows.length,
        rows_inserted: inserted,
        total_amount: +totalAmt.toFixed(2),
        mapping_used: columnMap,
        sheet: pickedSheet,
        header_row: pickedHeaderRow,
        probe: probeReport,
      });
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  } catch (err) { next(err); }
});

/** GET / — list uploads. */
router.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT id, insurer_slug, insurer_label, month, year, file_name,
              row_count, matched_count, total_amount, uploaded_at, status
       FROM statement_uploads WHERE status = 'active' ORDER BY uploaded_at DESC`
    );
    res.json({ success: true, uploads: r.recordset });
  } catch (err) { next(err); }
});

/** GET /:id — upload details. */
router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Int, parseInt(req.params.id, 10))
      .query(`SELECT * FROM statement_uploads WHERE id = @id`);
    if (r.recordset.length === 0) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, upload: r.recordset[0] });
  } catch (err) { next(err); }
});

/** GET /:id/rows?limit=200 — per-policy rows. */
router.get('/:id(\\d+)/rows', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '5000', 10) || 5000, 50000);
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Int, parseInt(req.params.id, 10))
      .input('lim', sql.Int, limit)
      .query(`SELECT TOP (@lim) id, policy_no, amount, od_commission, addon_commission,
                     tp_commission, pa_commission, terror_commission, net_amount,
                     gross_amount, reward, raw_json
              FROM statement_rows WHERE upload_id = @id ORDER BY id`);

    // veh_reg_no + net_premium aren't first-class columns on statement_rows
    // — they vary too much across insurer statements. Pull them out of
    // raw_json on the way out so the UI doesn't have to know the source
    // schema. Match keys case-insensitively after stripping non-alphanumerics
    // so "Veh Reg No", "VEH_REG_NO", "VehRegNo" all resolve.
    const norm = k => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const VEH_KEYS = ['vehregno','vehiclenumber','vehicleno','vehicleregistrationno','registrationno','regno','vehicleregistrationnumber','vehno'];
    const NET_KEYS = ['netpremium','netamount','net','premium','netprem'];
    function fromJson(raw, candidates) {
      if (!raw) return null;
      let obj; try { obj = JSON.parse(raw); } catch { return null; }
      // Build a normalised map once.
      const normMap = {};
      for (const k of Object.keys(obj)) normMap[norm(k)] = obj[k];
      for (const c of candidates) if (normMap[c] != null && normMap[c] !== '') return normMap[c];
      return null;
    }

    const rows = r.recordset.map(row => {
      const veh = fromJson(row.raw_json, VEH_KEYS);
      const np  = fromJson(row.raw_json, NET_KEYS);
      // Drop raw_json from the wire — we already extracted what's needed.
      const { raw_json, ...rest } = row;
      return { ...rest, veh_reg_no: veh, net_premium: np };
    });
    res.json({ success: true, rows });
  } catch (err) { next(err); }
});

/**
 * POST /:id/recalc — re-aggregate row_count + total_amount from statement_rows.
 * Useful after the Total-Amount rule changed (e.g. switched from total
 * commission to net amount) so existing uploads update without re-upload.
 */
router.post('/:id(\\d+)/recalc', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Int, id)
      .query(`SELECT
                COUNT(*) AS rc,
                SUM(COALESCE(amount, gross_amount, net_amount, 0)) AS total
              FROM statement_rows WHERE upload_id = @id`);
    const row = r.recordset[0] || { rc: 0, total: 0 };
    await pool.request()
      .input('id', sql.Int, id)
      .input('rc', sql.Int, row.rc)
      .input('total', sql.Decimal(18, 2), row.total)
      .query(`UPDATE statement_uploads SET row_count = @rc, total_amount = @total WHERE id = @id`);
    res.json({ success: true, id, row_count: row.rc, total_amount: +Number(row.total || 0).toFixed(2) });
  } catch (err) { next(err); }
});

/** DELETE /:id — soft-delete the upload. */
router.delete('/:id(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, parseInt(req.params.id, 10))
      .query(`UPDATE statement_uploads SET status = 'inactive' WHERE id = @id`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * GET /match?policy_no=… → returns the most recent active statement row
 * for a policy. Used by the Bulk Calculation route.
 */
router.get('/match', async (req, res, next) => {
  try {
    const pn = String(req.query.policy_no || '').trim();
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const pool = await getPool();
    const r = await pool.request()
      .input('pn', sql.NVarChar(200), pn)
      .query(`SELECT TOP 1 sr.*, su.insurer_label, su.month, su.year
              FROM statement_rows sr
              INNER JOIN statement_uploads su ON su.id = sr.upload_id
              WHERE su.status = 'active' AND sr.policy_no = @pn
              ORDER BY su.year DESC, su.month DESC, sr.id DESC`);
    res.json({ success: true, match: r.recordset[0] || null });
  } catch (err) { next(err); }
});

// Reusable loader for other modules (e.g. bulk calc)
module.exports = router;
module.exports.loadMapping = loadMapping;
module.exports.resolveInsurerColumn = resolveInsurerColumn;
