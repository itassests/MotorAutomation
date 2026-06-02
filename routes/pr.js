/**
 * Premium Register upload + match.
 *
 * The master PR_Mapping.xlsx in config/pr_mapping/ encodes per-insurer column
 * names. Column 0 is the canonical field label, column 1 is our SysCol,
 * columns 2..end hold the column name each insurer uses in their PR file
 * ("ICICI", "Go Digit", "TATA", "ROYAL", "BAJAJ/Portal", "Magma", …).
 *
 * Upload flow:
 *   1. User picks insurer + month + year and attaches a PR file (XLSX / CSV).
 *   2. We look up that insurer's column header mapping.
 *   3. Parse each row and map to canonical fields.
 *   4. Insert into pr_rows with parent pr_uploads record.
 *
 * Endpoints:
 *   GET    /api/pr/mapping                    → full mapping
 *   GET    /api/pr/insurers                   → insurers from the mapping
 *   POST   /api/pr/upload  file+insurer+m+y   → parse + store
 *   GET    /api/pr                            → list uploads
 *   GET    /api/pr/:id/rows?limit=200         → per-policy rows
 *   DELETE /api/pr/:id                        → soft-delete
 *   POST   /api/pr/:id/recalc                 → refresh totals
 *   GET    /api/pr/match?policy_no=…          → look up most-recent active PR row
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const sql = require('mssql');
const XLSX = require('xlsx');
const { getPool } = require('../db/connection');
const { getPrarambhUatPool } = require('../db/prarambh-uat-connection');

const router = express.Router();

const MAPPING_FILE = path.resolve(__dirname, '..', 'config', 'pr_mapping', 'pr_mapping.xlsx');

// ─── Vehicle-class normalisation ───────────────────────────────────────────
// The PR file encodes the vehicle class in `product` / `vehicle_category`
// (e.g. "Goods Carrying Package Policy", "GCVGVW<=7.5TON") while Prarambh
// encodes it in `VehicleType` (e.g. "Commercial-Goods Carrying", "Pvt.Car").
// Both collapse to one of five canonical classes so the QC screen can flag a
// class mismatch — e.g. a goods truck (PR=GCV) that Prarambh booked as
// "Pvt.Car". Returns null for non-motor / unclassifiable products so the
// comparison stays neutral (no false mismatch) rather than red.
function vehClass(v) {
  if (v == null || v === '') return null;
  const s = String(v).toUpperCase();
  // GCV/PCV tokens are substring matches: PR's vehicle_category glues them to
  // the weight band ("GCVGVW<=7.5TON", "PCVCC<=18"), so a \b boundary fails.
  // Safe — "GCV"/"PCV" never appear inside the CAR/TW/MISC vocabularies
  // ("MISC-DGVW…" carries "GVW", not "GCV").
  if (/GCV|GCCV|GOODS\s*CARR/.test(s))            return 'GCV';
  if (/PCV|PASSENGER\s*CARR/.test(s))             return 'PCV';
  if (/TWO\s*WHEEL|2\s*WHEEL|MOTOR\s*CYCLE|MOTORCYCLE|\bSCOOTER\b/.test(s)) return 'TW';
  if (/PRIVATE\s*CAR|PVT\.?\s*CAR|MOTOR\s*CAR/.test(s)) return 'CAR';
  if (/MISC|TRACTOR/.test(s))                     return 'MISC';
  return null;
}
// Map a canonical class back to the exact string Prarambh stores in
// VehicleType, so "Update as PR" writes the value Prarambh expects.
const VEHCLASS_TO_VEHICLETYPE = {
  CAR:  'Pvt.Car',
  TW:   'Two Wheeler',
  GCV:  'Commercial-Goods Carrying',
  PCV:  'Commercial-Passenger Carrying',
  MISC: 'Miscellaneous',
};

// ─── RTO-code normalisation ────────────────────────────────────────────────
// The QC screen compares the RTO district both systems resolved the policy
// to. PR carries it inside the registration number (`vehicle_no`, e.g.
// "GJ-15-AB-1234") while Prarambh carries an explicit `RTO_Code` column (and a
// `VEHICLE_REGISTRATION_NO` fallback). Both collapse to the BASE RTO — two
// state letters + district digits, separators and the series letters stripped:
//   "GJ-15-AB-1234" → "GJ15",  "DL1C"  → "DL1",  "MH 12 AB 9" → "MH12".
// Returns null for anything without a valid state+district head ("NEW", "NA",
// a bare branch code) so the comparison stays neutral rather than red.
function rtoBase(v) {
  if (v == null || v === '') return null;
  const raw = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = raw.match(/^([A-Z]{2}\d{1,3})/);   // state letters + district digits
  return m ? m[1] : null;
}

// ─── Mapping loader ────────────────────────────────────────────────────────

let _mappingCache = null;

function loadMapping() {
  if (_mappingCache) return _mappingCache;
  if (!fs.existsSync(MAPPING_FILE)) {
    throw new Error('PR mapping file not found at ' + MAPPING_FILE);
  }
  const wb = XLSX.readFile(MAPPING_FILE);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const header = aoa[0] || [];

  // Header: col 0 = "Remarks", col 1 = "SysCol", col 2.. = insurer labels
  const insurerLabels = [];
  for (let i = 2; i < header.length; i++) {
    const raw = String(header[i] || '').trim();
    if (!raw) continue;
    insurerLabels.push({ label: raw, slug: slugifyInsurer(raw), columnIndex: i });
  }

  const fields = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const impField = String(row[0] || '').trim();
    const sysCol   = String(row[1] || '').trim();
    if (!impField) continue;
    const columnsByInsurerSlug = {};
    for (const ins of insurerLabels) {
      const cell = String(row[ins.columnIndex] || '').trim();
      if (!cell || cell.toUpperCase() === 'NO' || cell.toUpperCase() === 'NA') continue;
      columnsByInsurerSlug[ins.slug] = cell;
    }
    fields.push({ impField, sysCol, columnsByInsurerSlug });
  }

  _mappingCache = { insurerLabels, fields };
  return _mappingCache;
}

/** Normalise insurer labels in the mapping header to our standard slugs. */
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
  if (/libtry|liberty/.test(s)) return 'liberty';
  if (/magma/.test(s)) return 'magma';
  if (/\broyal\b/.test(s)) return 'royal_sundaram';
  if (/\bsbi\b/.test(s) && /new/.test(s)) return 'sbi_general_new';
  if (/\bsbi\b/.test(s)) return 'sbi_general';
  if (/shriram/.test(s)) return 'shriram';
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function resolveColumn(mapping, insurerSlug, impField) {
  const f = mapping.fields.find(x => x.impField.toLowerCase() === impField.toLowerCase());
  return f ? (f.columnsByInsurerSlug[insurerSlug] || null) : null;
}

// Generic header aliases per canonical field — fallback when an insurer has
// no explicit column-mapping in the master file, so ANY insurer's PR can be
// parsed by common header names. pickCell matches these case-insensitively
// and supports the `|` alternation.
const GENERIC_PR_COLUMNS = {
  'Policy No':           'Policy No|Policy Number|POLICY_NUMBER|Policy_No|PolicyNo|Policy|POLICY_NO_CHAR|ILPOS_POLICY_NUMBER',
  'Policy Issued Date':  'Policy Issued Date|Issue Date|Issued Date|Policy Date|POLICY_ISSUE_DATE|Policy Issue Date',
  'Name of Customer':    'Name of Customer|Customer Name|Insured Name|Name|Customer|INSURED_NAME',
  'Vehicle No':          'Vehicle No|Vehicle Number|Registration No|Registration No.|Registration Number|Reg No|VEHICLE_NO|Vehicle_No|RegnNo|MOTOR_REGISTRATION_NO|REGISTRATION_NO|VEHICLE_REGISTRATION_NUMBER|VechileNo|VehicleNo',
  'State':               'State|State Name|StateName',
  'Region':              'Region|Zone|Cluster|RTO_LOCATION',
  'Make':                'Make|Vehicle Make|Manufacturer|MAKE',
  'Model':               'Model|Vehicle Model|MODEL',
  'Sub Model':           'Sub Model|Submodel|Variant|VARIENT|VEHICLE_SUB_CLASS',
  'ENGINE NO':           'Engine No|Engine Number|ENGINE_NO',
  'CHASIS NO':           'Chassis No|Chasis No|Chassis Number|CHASSIS_NO',
  'CC':                  'CC|Cubic Capacity|CUBIC_CAPACITY|MOTOR_ENGINE_CC|Engine CC|ENGINE_CC',
  'Tonnage (GVW)':       'Tonnage|GVW|Gross Vehicle Weight|Tonnage (GVW)|VEHICLE_GROSS_WEIGHT|GVW-TONS',
  'SEAT CAP':            'Seating|Seating Capacity|Seat Cap|No of Seats|SEAT CAP|VEHICLE_SEATING_CAPACITY|SeatingCapacity',
  'Fuel Type':           'Fuel Type|Fuel|FUELTYPE|FUEL_TYPE',
  'Manufacturing year':  'Manufacturing Year|Mfg Year|Year of Manufacture|Year of Manufacturing|MFG_YEAR|YR_OF_MANUFACTURING|YearOfManufacture',
  'Sum Insured':         'Sum Insured|IDV|SI|Insured Value|TOTAL_SI|VEHICLE_BASE_VALUE_IDV|Total Sum Insured|Basic IDV|SumInsured',
  'NCB %':               'NCB %|NCB|NCB Percentage|NCB%|NCB Percent|Previous NCB|Prev NCB|NCB_PERCENTAGE|Actual NCB Percent',
  'Vehicle':             'Vehicle|Vehicle Type|VehicleType',
  'Vehicle Category':    'Vehicle Category|Category|Vehicle Class|VEHICLE_SUB_CLASS',
  'Plan Name':           'Plan Name|Plan|Cover Type',
  'Product':             'Product|Product Name|Product Type',
  'Nill Dep. (YES/NO)':  'Zero Dep|Nil Dep|Nill Dep|Zero Depreciation|Nil Depreciation',
  'OD Premium':          'OD Premium|Basic OD|Net OD Premium|OD Net|NET_OD_PREMIUM|BASIC_OD_PREMIUM|ODNetPremium|OD Amount|Base Premium/Od Premium',
  'Total OD Premium':    'Total OD Premium|Total OD|TOTAL_OD_PREMIUM',
  'ADD ON PREMIUM':      'Add On Premium|Addon Premium|Add-on Premium|Addon|ADD ON PREMIUM|ADD_ON_PREMIUM|AddOnPremium',
  'TP Premium':          'TP Premium|Basic TP|Net TP Premium|Liability Premium|TP Net|NET_TP_PREMIUM|TOTAL_TP_PREMIUM|BASIC_TP_PREMIUM|TpPremium|ALL OTHER TP COVER PREMIUM',
  'Net Amount':          'Net Amount|Net Premium|Premium Without GST|Total Premium Without GST|NET_PREMIUM|Net Written Premium',
  'Gross Amount':        'Gross Amount|Gross Premium|Total Premium|Final Premium|Premium With GST|GROSS_PREMIUM|GWP|GWPFull|GWP Amount|GrossPremium|Gross Written Premium|Gross amount including Tax|OUR SHARE OF PREMIUM GWP',
  'GSt':                 'GST|GSt|Tax|Service Tax|TOTAL_SERVICE_TAX|Service Tax(GST)',
  'PA Cover':            'PA Cover|PA Premium|Owner PA|CPA_PREMIUM',
  'Status':              'Status|Policy Status',
  'OD Start Date':       'OD Start Date|OD Risk Start|START_DATE',
  'OD End Date':         'OD End Date|OD Risk End|EXPIRY_DATE',
  'TP Start Date':       'TP Start Date|TP Risk Start',
  'TP End Date':         'TP End Date|TP Risk End',
};

// ─── HTML-table PR files ───────────────────────────────────────────────────
// Some insurer portals (e.g. Bajaj/Portal) export the PR as an HTML <table>
// saved with a `.xls` extension. XLSX.readFile mis-reads these as plain text
// (every cell collapses to __EMPTY → 0 valid rows). Detect HTML by content and
// parse the table directly into header-keyed row objects so the same
// columnMap/pickCell pipeline works unchanged.

function looksLikeHtml(buf) {
  // Sniff the first ~512 non-whitespace bytes for an HTML table/markup opener.
  const head = String(buf).slice(0, 4096).replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<') && /<table\b|<tr\b|<!doctype html|<html\b/.test(head);
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCharCode(+d); } catch { return m; } });
}

// Parse an HTML <table> string → array of row objects keyed by the first row's
// header cells. Tolerant of stray whitespace, nested <div>, and odd markup:
// each <tr>…</tr> yields its <td>/<th> text (tags stripped, entities decoded,
// whitespace collapsed). Returns [] if no usable rows.
function parseHtmlTableRows(html) {
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const matrix = [];
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) {
      cells.push(decodeHtmlEntities(c[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim());
    }
    if (cells.length) matrix.push(cells);
  }
  if (matrix.length < 2) return [];
  const header = matrix[0];
  return matrix.slice(1).map((cells) => {
    const o = {};
    header.forEach((h, i) => { if (String(h).trim()) o[h] = cells[i] !== undefined ? cells[i] : ''; });
    return o;
  });
}

// ─── Row-value helpers ─────────────────────────────────────────────────────

function pickCell(row, name) {
  if (!row || !name) return null;
  // Mapping cells may specify multiple column-name alternatives separated
  // by `|` so a single mapping row works across old + new file formats
  // (e.g. Chola April PR renamed "Policy No" → "POLICY_NUMBER" — the
  // mapping cell can read "Policy No|POLICY_NUMBER" and either matches).
  const candidates = String(name).split('|').map(s => s.trim()).filter(Boolean);
  for (const cand of candidates) {
    const target = cand.toUpperCase();
    for (const k of Object.keys(row)) {
      if (String(k).trim().toUpperCase() === target) {
        const v = row[k];
        if (v !== '' && v !== null && v !== undefined) return v;
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
function toInt(v) {
  const n = toNumber(v);
  return n == null ? null : Math.round(n);
}
function toStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ─── Endpoints ─────────────────────────────────────────────────────────────

router.get('/mapping', (req, res, next) => {
  try { res.json({ success: true, mapping: loadMapping() }); }
  catch (err) { next(err); }
});

router.get('/insurers', async (req, res, next) => {
  try {
    const mapped = loadMapping().insurerLabels.map(x => ({ ...x, mapped: true }));
    const bySlug = new Map(mapped.map(x => [x.slug, x]));
    // Merge in every insurer that has an active rate card, so PR can be
    // uploaded for ANY configured insurer (those without an explicit
    // column-mapping fall back to GENERIC_PR_COLUMNS on upload).
    try {
      const pool = await getPool();
      const r = await pool.request().query(
        `SELECT DISTINCT insurer FROM rate_cards
         WHERE insurer IS NOT NULL
           AND (effective_to IS NULL OR effective_to > GETDATE())`
      );
      for (const row of r.recordset) {
        const slug = String(row.insurer || '').trim();
        if (!slug || bySlug.has(slug)) continue;
        const label = slug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const e = { label, slug, columnIndex: -1, mapped: false };
        bySlug.set(slug, e);
      }
    } catch (_) { /* if rate_cards unavailable, just return the mapped set */ }
    const insurers = [...bySlug.values()].sort((a, b) => {
      if (a.mapped !== b.mapped) return a.mapped ? -1 : 1; // mapped first
      return a.label.localeCompare(b.label);
    });
    res.json({ success: true, insurers });
  } catch (err) { next(err); }
});

router.post('/upload', async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded. Use field name "file".' });
    const insurerSlug = String(req.body.insurer_slug || '').trim();
    const month = parseInt(req.body.month, 10);
    const year  = parseInt(req.body.year, 10);
    if (!insurerSlug) return res.status(400).json({ success: false, error: 'insurer_slug required' });
    if (!(month >= 1 && month <= 12)) return res.status(400).json({ success: false, error: 'month 1..12 required' });
    if (!(year >= 2000 && year <= 2100)) return res.status(400).json({ success: false, error: 'year required' });

    const mapping = loadMapping();
    const mapped = mapping.insurerLabels.find(x => x.slug === insurerSlug);
    // Allow upload for ANY insurer: when there's no explicit mapping, fall
    // back to GENERIC_PR_COLUMNS (common header names). The label is
    // derived from the slug for the upload record.
    const known = mapped || {
      slug: insurerSlug,
      label: insurerSlug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    };
    // col(): explicit insurer mapping FIRST, then the generic alias list APPENDED
    // (pickCell tries them in order). So when the insurer's mapped column exists it
    // wins, but if the file format has drifted (e.g. Reliance/Portal maps OD Premium
    // → "OD Premium" yet the HTML export's column is "ODNetPremium"), the generic
    // alias still resolves it instead of yielding null.
    const col = (impField) => {
      const mappedCol = mapped ? resolveColumn(mapping, insurerSlug, impField) : null;
      const generic = GENERIC_PR_COLUMNS[impField] || null;
      return [mappedCol, generic].filter(Boolean).join('|') || null;
    };
    const columnMap = {
      policy_no:          col('Policy No'),
      policy_issued:      col('Policy Issued Date'),
      customer_name:      col('Name of Customer'),
      vehicle_no:         col('Vehicle No'),
      state:              col('State'),
      region:             col('Region'),
      vehicle_make:       col('Make'),
      vehicle_model:      col('Model'),
      sub_model:          col('Sub Model'),
      engine_no:          col('ENGINE NO'),
      chassis_no:         col('CHASIS NO'),
      cc:                 col('CC'),
      tonnage:            col('Tonnage (GVW)'),
      seating:            col('SEAT CAP'),
      fuel_type:          col('Fuel Type'),
      mfg_year:           col('Manufacturing year'),
      sum_insured:        col('Sum Insured'),
      ncb:                col('NCB %'),
      vehicle_type:       col('Vehicle'),
      vehicle_category:   col('Vehicle Category'),
      plan_name:          col('Plan Name'),
      product:            col('Product'),
      zero_dep:           col('Nill Dep. (YES/NO)'),
      od_premium:         col('OD Premium'),
      total_od_premium:   col('Total \r\nOD Premium') || col('Total OD Premium') || col('Total\nOD Premium'),
      addon_premium:      col('ADD ON PREMIUM'),
      tp_premium:         col('TP Premium'),
      net_amount:         col('Net Amount'),
      gross_amount:       col('Gross Amount'),
      gst:                col('GSt'),
      pa_cover:           col('PA Cover'),
      status:             col('Status'),
      od_start_date:      col('OD Start Date'),
      od_end_date:        col('OD End Date'),
      tp_start_date:      col('TP Start Date'),
      tp_end_date:        col('TP End Date'),
    };

    // Parse file — concatenate rows from ALL sheets in the workbook.
    // Some insurers (e.g. Chola) split policies across multiple sheets
    // by product (OTHERS / PC).  All sheets share the same column headers
    // so a single mapping covers both.  Empty / hidden sheets are skipped.
    let rows;
    try {
      const fileBuf = fs.readFileSync(req.file.path);
      if (looksLikeHtml(fileBuf)) {
        // HTML-table export saved as .xls (e.g. Bajaj/Portal). XLSX can't read
        // these — parse the <table> directly into header-keyed rows.
        rows = parseHtmlTableRows(fileBuf.toString('utf8'));
        for (const r of rows) r._sourceSheet = 'html';
      } else {
        const wb = XLSX.read(fileBuf, { type: 'buffer' });
        rows = [];
        // The header is usually row 0, but some insurers prefix the sheet with
        // title/metadata rows (e.g. Magma: "MTD Data From : …" + a blank row,
        // real "Policy No" header at row 2). XLSX.sheet_to_json keys rows off
        // the FIRST row, so those drop every record (policy_no never matches).
        // Detect the real header row by scanning for the policy-no column label.
        const policyAliases = new Set(
          String(columnMap.policy_no || '').split('|')
            .map(s => s.trim().toUpperCase()).filter(Boolean));
        const findHeaderRow = (ws) => {
          if (!policyAliases.size) return 0;
          const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
          const scan = Math.min(aoa.length, 15);
          for (let r = 0; r < scan; r++) {
            const cells = (aoa[r] || []).map(c => String(c == null ? '' : c).trim().toUpperCase());
            if (cells.some(c => policyAliases.has(c))) return r;
          }
          return 0; // not found — fall back to default (row 0)
        };
        for (const sn of wb.SheetNames) {
          const ws = wb.Sheets[sn];
          if (!ws) continue;
          const hdrRow = findHeaderRow(ws);
          const sheetRows = XLSX.utils.sheet_to_json(ws, { defval: '', range: hdrRow });
          // Tag each row with its source sheet so debugging is easier; the
          // tag is non-mapped so it never lands in pr_rows.
          for (const r of sheetRows) r._sourceSheet = sn;
          rows.push(...sheetRows);
        }
      }
    } catch (err) {
      return res.status(400).json({ success: false, error: 'Failed to parse file: ' + err.message });
    }

    const pool = await getPool();

    const up = await pool.request()
      .input('slug',  sql.VarChar(100),  insurerSlug)
      .input('label', sql.NVarChar(200), known.label)
      .input('m',     sql.Int, month)
      .input('y',     sql.Int, year)
      .input('fn',    sql.NVarChar(500), req.file.originalname || req.file.filename || '')
      .query(`INSERT INTO pr_uploads (insurer_slug, insurer_label, month, year, file_name)
              OUTPUT INSERTED.id
              VALUES (@slug, @label, @m, @y, @fn)`);
    const uploadId = up.recordset[0].id;

    // Build the bulk-insert table.  TDS bulk-load is one round-trip vs.
    // 1.6k+ individual INSERTs which trigger connection state errors on
    // bigger PR files (TATA, ICICI).  We chunk into BATCH_SIZE-row slices
    // because the bigger files carry NVARCHAR(MAX) raw_json strings
    // (full source row) that bloat the TDS packet and cause ECONNRESET
    // on a single bulk-load of 1.6k+ rows.
    const BATCH_SIZE = 500;
    const truncate = (s, len) => {
      if (s == null) return null;
      const str = String(s);
      return str.length > len ? str.slice(0, len) : str;
    };
    const buildEmptyTable = () => {
      const table = new sql.Table('pr_rows');
      table.columns.add('upload_id',          sql.Int,            { nullable: true });
      table.columns.add('insurer_slug',       sql.VarChar(100),   { nullable: true });
      table.columns.add('policy_no',          sql.NVarChar(200),  { nullable: true });
      table.columns.add('customer_name',      sql.NVarChar(300),  { nullable: true });
      table.columns.add('vehicle_no',         sql.NVarChar(100),  { nullable: true });
      table.columns.add('vehicle_make',       sql.NVarChar(200),  { nullable: true });
      table.columns.add('vehicle_model',      sql.NVarChar(200),  { nullable: true });
      table.columns.add('sub_model',          sql.NVarChar(200),  { nullable: true });
      table.columns.add('cc',                 sql.Int,            { nullable: true });
      table.columns.add('tonnage',            sql.Decimal(10, 2), { nullable: true });
      table.columns.add('seating',            sql.Int,            { nullable: true });
      table.columns.add('fuel_type',          sql.NVarChar(50),   { nullable: true });
      table.columns.add('mfg_year',           sql.NVarChar(20),   { nullable: true });
      table.columns.add('sum_insured',        sql.Decimal(18, 2), { nullable: true });
      table.columns.add('ncb',                sql.Decimal(6, 2),  { nullable: true });
      table.columns.add('vehicle_type',       sql.NVarChar(100),  { nullable: true });
      table.columns.add('vehicle_category',   sql.NVarChar(200),  { nullable: true });
      table.columns.add('product',            sql.NVarChar(200),  { nullable: true });
      table.columns.add('zero_dep',           sql.NVarChar(10),   { nullable: true });
      table.columns.add('od_premium',         sql.Decimal(18, 2), { nullable: true });
      table.columns.add('total_od_premium',   sql.Decimal(18, 2), { nullable: true });
      table.columns.add('addon_premium',      sql.Decimal(18, 2), { nullable: true });
      table.columns.add('tp_premium',         sql.Decimal(18, 2), { nullable: true });
      table.columns.add('net_amount',         sql.Decimal(18, 2), { nullable: true });
      table.columns.add('gst',                sql.Decimal(18, 2), { nullable: true });
      table.columns.add('gross_amount',       sql.Decimal(18, 2), { nullable: true });
      table.columns.add('pa_cover',           sql.Decimal(18, 2), { nullable: true });
      table.columns.add('pr_status',          sql.NVarChar(50),   { nullable: true });
      table.columns.add('policy_issued_date', sql.NVarChar(50),   { nullable: true });
      table.columns.add('od_start_date',      sql.NVarChar(50),   { nullable: true });
      table.columns.add('od_end_date',        sql.NVarChar(50),   { nullable: true });
      table.columns.add('tp_start_date',      sql.NVarChar(50),   { nullable: true });
      table.columns.add('tp_end_date',        sql.NVarChar(50),   { nullable: true });
      table.columns.add('state',              sql.NVarChar(200),  { nullable: true });
      table.columns.add('region',             sql.NVarChar(200),  { nullable: true });
      // raw_json (NVARCHAR(MAX) in schema) is intentionally NOT included
      // in the bulk-load: tedious BCP rejects all wide string types
      // (NVarChar(>2000), VarChar(>4000), MAX) with "Invalid column type
      // from bcp client" on this column.  raw_json defaults to NULL on
      // bulk insert; if a debug snapshot is ever needed, run a follow-up
      // UPDATE with the JSON keyed by upload_id+policy_no.
      return table;
    };

    // Pre-filter rows that have a policy number so we can chunk cleanly.
    const validRows = [];
    let totalNet = 0, totalGross = 0, totalOd = 0, totalTp = 0;
    for (const raw of rows) {
      const policyRaw = pickCell(raw, columnMap.policy_no);
      if (!policyRaw) continue;
      // Strip a leading Excel text-marker apostrophe (HTML-exported PR like Reliance
      // prefix policy numbers with ' / &#39; → would never match the cycle's clean no.)
      const policyNo = String(policyRaw).trim().replace(/^'+/, '').trim();

      const odPrem   = toNumber(pickCell(raw, columnMap.od_premium));
      const totalOdP = toNumber(pickCell(raw, columnMap.total_od_premium));
      const addOnP   = toNumber(pickCell(raw, columnMap.addon_premium));
      const tpPrem   = toNumber(pickCell(raw, columnMap.tp_premium));
      const netAmt   = toNumber(pickCell(raw, columnMap.net_amount));
      const grossAmt = toNumber(pickCell(raw, columnMap.gross_amount));
      const gst      = toNumber(pickCell(raw, columnMap.gst));
      const paCover  = toNumber(pickCell(raw, columnMap.pa_cover));

      totalNet   += netAmt   || 0;
      totalGross += grossAmt || 0;
      totalOd    += odPrem   || 0;
      totalTp    += tpPrem   || 0;

      validRows.push({
        policyNo, raw,
        odPrem, totalOdP, addOnP, tpPrem, netAmt, gst, grossAmt, paCover,
      });
    }
    const inserted = validRows.length;

    try {
      for (let off = 0; off < validRows.length; off += BATCH_SIZE) {
        const slice = validRows.slice(off, off + BATCH_SIZE);
        const table = buildEmptyTable();
        for (const v of slice) {
          const raw = v.raw;
          table.rows.add(
            uploadId,
            insurerSlug,
            truncate(v.policyNo, 200),
            truncate(toStr(pickCell(raw, columnMap.customer_name)), 300),
            truncate(toStr(pickCell(raw, columnMap.vehicle_no)),    100),
            truncate(toStr(pickCell(raw, columnMap.vehicle_make)),  200),
            truncate(toStr(pickCell(raw, columnMap.vehicle_model)), 200),
            truncate(toStr(pickCell(raw, columnMap.sub_model)),     200),
            toInt(pickCell(raw, columnMap.cc)),
            toNumber(pickCell(raw, columnMap.tonnage)),
            toInt(pickCell(raw, columnMap.seating)),
            truncate(toStr(pickCell(raw, columnMap.fuel_type)),     50),
            truncate(toStr(pickCell(raw, columnMap.mfg_year)),      20),
            toNumber(pickCell(raw, columnMap.sum_insured)),
            toNumber(pickCell(raw, columnMap.ncb)),
            truncate(toStr(pickCell(raw, columnMap.vehicle_type)),  100),
            truncate(toStr(pickCell(raw, columnMap.vehicle_category)), 200),
            truncate(toStr(pickCell(raw, columnMap.product)),       200),
            truncate(toStr(pickCell(raw, columnMap.zero_dep)),      10),
            v.odPrem, v.totalOdP, v.addOnP, v.tpPrem,
            v.netAmt, v.gst, v.grossAmt, v.paCover,
            truncate(toStr(pickCell(raw, columnMap.status)),        50),
            truncate(toStr(pickCell(raw, columnMap.policy_issued)), 50),
            truncate(toStr(pickCell(raw, columnMap.od_start_date)), 50),
            truncate(toStr(pickCell(raw, columnMap.od_end_date)),   50),
            truncate(toStr(pickCell(raw, columnMap.tp_start_date)), 50),
            truncate(toStr(pickCell(raw, columnMap.tp_end_date)),   50),
            truncate(toStr(pickCell(raw, columnMap.state)),         200),
            truncate(toStr(pickCell(raw, columnMap.region)),        200)
          );
        }
        await pool.request().bulk(table);
      }

      await pool.request()
        .input('id',       sql.Int, uploadId)
        .input('rc',       sql.Int, inserted)
        .input('tnet',     sql.Decimal(18,2), totalNet)
        .input('tgross',   sql.Decimal(18,2), totalGross)
        .input('tod',      sql.Decimal(18,2), totalOd)
        .input('ttp',      sql.Decimal(18,2), totalTp)
        .query(`UPDATE pr_uploads
                SET row_count = @rc, total_net = @tnet, total_gross = @tgross,
                    total_od = @tod, total_tp = @ttp
                WHERE id = @id`);
      try { fs.unlinkSync(req.file.path); } catch (_) {}

      res.json({
        success: true,
        upload_id: uploadId,
        rows_parsed: rows.length,
        rows_inserted: inserted,
        totals: {
          net_amount:  +totalNet.toFixed(2),
          gross_amount:+totalGross.toFixed(2),
          od_premium:  +totalOd.toFixed(2),
          tp_premium:  +totalTp.toFixed(2),
        },
        mapping_used: columnMap,
      });
    } catch (err) {
      // Roll back the inserted upload row so a failed bulk-load doesn't
      // leave an orphan pr_uploads record.
      try {
        await pool.request().input('id', sql.Int, uploadId)
          .query('DELETE FROM pr_uploads WHERE id = @id');
      } catch (_) {}
      throw err;
    }
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT id, insurer_slug, insurer_label, month, year, file_name,
              row_count, total_net, total_gross, total_od, total_tp,
              uploaded_at, status
       FROM pr_uploads WHERE status = 'active' ORDER BY uploaded_at DESC`
    );
    res.json({ success: true, uploads: r.recordset });
  } catch (err) { next(err); }
});

/**
 * GET /find-upload?policy=<policy_no>
 * Resolve which active PR upload contains a given policy, so callers that
 * only know the policy number (e.g. the recon screen) can deep-link into the
 * QC compare workspace (qc.html?upload=…&policy=…). Returns the most-recent
 * active upload that has the policy.
 */
router.get('/find-upload', async (req, res, next) => {
  try {
    const pn = String(req.query.policy || '').trim();
    if (!pn) return res.status(400).json({ success: false, error: 'policy required' });
    const pool = await getPool();
    const r = await pool.request()
      .input('pn', sql.NVarChar(200), pn)
      .query(`SELECT TOP 1 pr.upload_id
                FROM pr_rows pr
                JOIN pr_uploads pu ON pu.id = pr.upload_id
               WHERE pu.status = 'active' AND pr.policy_no = @pn
               ORDER BY pu.uploaded_at DESC`);
    if (!r.recordset.length) {
      return res.json({ success: false, error: 'Policy not found in any active PR upload' });
    }
    res.json({ success: true, upload_id: r.recordset[0].upload_id });
  } catch (err) { next(err); }
});

router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Int, parseInt(req.params.id, 10))
      .query(`SELECT * FROM pr_uploads WHERE id = @id`);
    if (r.recordset.length === 0) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, upload: r.recordset[0] });
  } catch (err) { next(err); }
});

router.get('/:id(\\d+)/rows', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '5000', 10) || 5000, 50000);
    const pool = await getPool();
    const r = await pool.request()
      .input('id', sql.Int, parseInt(req.params.id, 10))
      .input('lim', sql.Int, limit)
      .query(`SELECT TOP (@lim) id, policy_no, customer_name, vehicle_no, vehicle_make,
                     vehicle_model, cc, tonnage, seating, fuel_type, sum_insured, ncb,
                     od_premium, total_od_premium, addon_premium, tp_premium, net_amount,
                     gst, gross_amount, pa_cover, pr_status, state, region, policy_issued_date
              FROM pr_rows WHERE upload_id = @id ORDER BY id`);
    res.json({ success: true, rows: r.recordset });
  } catch (err) { next(err); }
});

router.delete('/:id(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, parseInt(req.params.id, 10))
      .query(`UPDATE pr_uploads SET status = 'inactive' WHERE id = @id`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** POST /:id/recalc — rebuild totals from pr_rows. */
router.post('/:id(\\d+)/recalc', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, id).query(
      `SELECT COUNT(*) AS rc,
              SUM(COALESCE(net_amount,0))   AS tnet,
              SUM(COALESCE(gross_amount,0)) AS tgross,
              SUM(COALESCE(od_premium,0))   AS tod,
              SUM(COALESCE(tp_premium,0))   AS ttp
       FROM pr_rows WHERE upload_id = @id`
    );
    const row = r.recordset[0] || {};
    await pool.request()
      .input('id', sql.Int, id)
      .input('rc',  sql.Int, row.rc || 0)
      .input('tnet',  sql.Decimal(18,2), row.tnet || 0)
      .input('tgross',sql.Decimal(18,2), row.tgross || 0)
      .input('tod',   sql.Decimal(18,2), row.tod || 0)
      .input('ttp',   sql.Decimal(18,2), row.ttp || 0)
      .query(`UPDATE pr_uploads SET row_count=@rc, total_net=@tnet,
              total_gross=@tgross, total_od=@tod, total_tp=@ttp
              WHERE id = @id`);
    res.json({
      success: true, id,
      row_count: row.rc || 0,
      totals: {
        net_amount:  +Number(row.tnet   || 0).toFixed(2),
        gross_amount:+Number(row.tgross || 0).toFixed(2),
        od_premium:  +Number(row.tod    || 0).toFixed(2),
        tp_premium:  +Number(row.ttp    || 0).toFixed(2),
      },
    });
  } catch (err) { next(err); }
});

/**
 * POST /:id/compare — reconcile this Premium Register upload against
 * tmp_PrarambhData by policy_no. For each canonical PR field (that we also
 * have in tmp_PrarambhData), compute a per-field match percentage and a
 * list of exceptions.
 *
 * Body: { tolerance_pct?: number }  // default 0.5% numeric tolerance
 * Response:
 *   {
 *     summary: { pr_rows, matched_policies, unmatched_policies, match_pct_overall },
 *     fields:  [{ field, compared, matched, mismatched, match_pct }, …],
 *     exceptions: [{ policy_no, field, pr_value, db_value, diff }, …],
 *     exceptions_capped: boolean
 *   }
 */
router.post('/:id(\\d+)/compare', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const tolerancePct = Math.max(0, Math.min(50, parseFloat((req.body && req.body.tolerance_pct) || '0.5')));

    const pool = await getPool();
    const prrows = await pool.request()
      .input('id', sql.Int, id)
      .query(
        `SELECT policy_no, vehicle_no, vehicle_make, vehicle_model, sub_model,
                cc, tonnage, seating, fuel_type, mfg_year, sum_insured, ncb,
                od_premium, addon_premium, tp_premium, net_amount, gross_amount,
                state, vehicle_category, product
         FROM pr_rows WHERE upload_id = @id`
      );
    const pr = prrows.recordset;
    if (pr.length === 0) {
      return res.json({ success: true, summary: { pr_rows: 0 }, fields: [], exceptions: [] });
    }

    // Pull corresponding rows from tmp_PrarambhData, keyed by PolicyNo.
    // Use IN batches of 2000 to avoid parameter limits.
    const prarambhPool = await getPrarambhUatPool();
    const byPolicy = new Map();
    const policyNos = [...new Set(pr.map(r => String(r.policy_no).trim()).filter(Boolean))];
    const CHUNK = 1000;
    for (let i = 0; i < policyNos.length; i += CHUNK) {
      const chunk = policyNos.slice(i, i + CHUNK);
      const req2 = prarambhPool.request();
      req2.timeout = 180000;
      const names = chunk.map((_, j) => `@p${j}`);
      chunk.forEach((pn, j) => req2.input('p' + j, sql.NVarChar(200), pn));
      const r = await req2.query(
        `SELECT PolicyNo, VEHICLE_REGISTRATION_NO, VEHICAL_MAKE, VEHICAL_MODEL,
                Vehicle_Sub_Model, CC, Tonnes, GROSS_VEHICLE_WEIGHT, SEATING_CAPACITY,
                FUELTYPE, MFG_YEAR, VEHICLE_IDV, TOTAL_IDV, NCB, BASE_OD_PREMIUM, NET_OD_PREMIUM,
                ADD_ON_PREMIUM, Addon_Premium, LIABILITY_PREMIUM, NET_LIABILITY_PREMIUM,
                PREMIUM_WITHOUT_GST, ANNUAL_PREMIUM, ANNUALPREMIUM, StateName, VehicleType
         FROM tmp_PrarambhData
         WHERE PolicyNo IN (${names.join(', ')})`
      );
      for (const row of r.recordset) {
        if (row.PolicyNo) byPolicy.set(String(row.PolicyNo).trim(), row);
      }
    }

    // ── Field comparators ────────────────────────────────────────────────
    // Each entry maps a PR column to the corresponding tmp_PrarambhData source
    // (often multiple candidates). Type drives the comparison rule.
    const FIELDS = [
      // Vehicle Class — PR's product/category vs Prarambh's VehicleType,
      // normalised to one of GCV/PCV/CAR/TW/MISC. Flags a goods truck booked
      // as Pvt.Car (and vice-versa). Prefer the precise vehicle_category, fall
      // back to product. Incomparable (null) for non-motor products.
      { field: 'Vehicle Class', type: 'class', prCols: ['vehicle_category', 'product'], dbCols: ['VehicleType'] },
      { field: 'Vehicle No',    type: 'str',  prCol: 'vehicle_no',    dbCols: ['VEHICLE_REGISTRATION_NO'] },
      { field: 'Make',          type: 'str',  prCol: 'vehicle_make',  dbCols: ['VEHICAL_MAKE'] },
      { field: 'Model',         type: 'str',  prCol: 'vehicle_model', dbCols: ['VEHICAL_MODEL'] },
      { field: 'Sub Model',     type: 'str',  prCol: 'sub_model',     dbCols: ['Vehicle_Sub_Model'] },
      { field: 'CC',            type: 'int',  prCol: 'cc',            dbCols: ['CC'] },
      { field: 'Tonnage',       type: 'num',  prCol: 'tonnage',       dbCols: ['Tonnes', 'GROSS_VEHICLE_WEIGHT'] },
      { field: 'Seating',       type: 'int',  prCol: 'seating',       dbCols: ['SEATING_CAPACITY'] },
      { field: 'Fuel Type',     type: 'str',  prCol: 'fuel_type',     dbCols: ['FUELTYPE'] },
      { field: 'MFG Year',      type: 'str',  prCol: 'mfg_year',      dbCols: ['MFG_YEAR'] },
      // Sum Insured: PR.sum_insured aligns with Prarambh.TOTAL_IDV (all-
       // coverage IDV including addons / electrical accessories). The
       // VEHICLE_IDV column is the OD-only IDV and consistently differs
       // from PR.sum_insured when addons exist. TOTAL stays primary,
       // VEHICLE is the fallback for older rows missing TOTAL_IDV.
      { field: 'Sum Insured',   type: 'num',  prCol: 'sum_insured',   dbCols: ['TOTAL_IDV', 'VEHICLE_IDV'] },
      { field: 'NCB %',         type: 'num',  prCol: 'ncb',           dbCols: ['NCB'] },
      // OD Premium: PR.od_premium aligns with Prarambh.NET_OD_PREMIUM (the
      // post-discount net OD figure both systems track as "what the customer
      // paid for OD"). BASE_OD_PREMIUM is gross-of-discount and consistently
      // differs by the dealer/agent discount, so using it as primary
      // surfaced a phantom mismatch on every policy.
      { field: 'OD Premium',    type: 'num',  prCol: 'od_premium',    dbCols: ['NET_OD_PREMIUM', 'BASE_OD_PREMIUM'] },
      { field: 'Addon Premium', type: 'num',  prCol: 'addon_premium', dbCols: ['ADD_ON_PREMIUM', 'Addon_Premium'] },
      // TP Premium: PR.tp_premium aligns with Prarambh.NET_LIABILITY_PREMIUM
      // (post-discount net TP). Same reasoning as OD — the gross
      // LIABILITY_PREMIUM consistently differs by the discount, surfacing a
      // phantom mismatch on every policy. NET kept primary, gross fallback.
      { field: 'TP Premium',    type: 'num',  prCol: 'tp_premium',    dbCols: ['NET_LIABILITY_PREMIUM', 'LIABILITY_PREMIUM'] },
      { field: 'Net Amount',    type: 'num',  prCol: 'net_amount',    dbCols: ['PREMIUM_WITHOUT_GST'] },
      { field: 'Gross Amount',  type: 'num',  prCol: 'gross_amount',  dbCols: ['ANNUAL_PREMIUM', 'ANNUALPREMIUM'] },
      { field: 'State',         type: 'str',  prCol: 'state',         dbCols: ['StateName'] },
      // RTO Code — PR's RTO lives inside the registration number; Prarambh has
      // an explicit RTO_Code column (registration as fallback). Both normalised
      // to base RTO (state letters + district digits) before comparing.
      { field: 'RTO Code',      type: 'rto',  prCols: ['vehicle_no'], dbCols: ['RTO_Code', 'VEHICLE_REGISTRATION_NO'] },
    ];

    function firstNonNull(row, cols) {
      for (const c of cols) {
        const v = row[c];
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    }
    function normStr(v) { return v == null ? null : String(v).trim().toLowerCase().replace(/\s+/g, ' '); }
    function normNum(v) {
      if (v == null || v === '') return null;
      const n = parseFloat(String(v).replace(/[,\s₹]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    function compareValues(type, a, b) {
      if (a == null || b == null) return { a, b, match: null };  // incomparable
      if (type === 'class') {
        const ca = vehClass(a), cb = vehClass(b);
        if (ca == null || cb == null) return { a, b, match: null };  // unclassifiable
        return { a, b, match: ca === cb };
      }
      if (type === 'rto') {
        const ra = rtoBase(a), rb = rtoBase(b);
        if (ra == null || rb == null) return { a, b, match: null };  // unparseable
        return { a, b, match: ra === rb };
      }
      if (type === 'str') {
        const sa = normStr(a), sb = normStr(b);
        return { a, b, match: sa === sb };
      }
      // Numeric/int: compare absolute values so sign differences (PR often
      // records refunds / cancellations as negatives) don't count as a
      // mismatch. Original signed values are still returned for display.
      if (type === 'int') {
        const na = normNum(a), nb = normNum(b);
        if (na == null || nb == null) return { a, b, match: null };
        return { a: na, b: nb, match: Math.round(Math.abs(na)) === Math.round(Math.abs(nb)), diff: na - nb };
      }
      // num
      const na = normNum(a), nb = normNum(b);
      if (na == null || nb == null) return { a, b, match: null };
      const aa = Math.abs(na), ab = Math.abs(nb);
      const absTol = 1;  // ₹1 / 1 unit absolute floor
      const pctTol = (tolerancePct / 100) * Math.max(aa, ab);
      const tol = Math.max(absTol, pctTol);
      return { a: na, b: nb, match: Math.abs(aa - ab) <= tol, diff: +(na - nb).toFixed(2) };
    }

    // ── Walk the PR rows ──────────────────────────────────────────────────
    const perField = new Map();
    for (const f of FIELDS) perField.set(f.field, { field: f.field, compared: 0, matched: 0, mismatched: 0 });

    const EXCEPTION_CAP = 2000;
    const exceptions = [];
    const perPolicy = [];     // one entry per PR row (matched or not)
    let matchedPolicies = 0;
    let unmatchedPolicies = 0;

    for (const p of pr) {
      const key = String(p.policy_no).trim();
      const db = byPolicy.get(key);
      if (!db) {
        unmatchedPolicies++;
        perPolicy.push({
          policy_no: key,
          matched: false,               // no Prarambh row
          compared: 0, matched_count: 0, mismatched_count: 0,
          match_pct: null,
          mismatched_fields: [],
        });
        continue;
      }
      matchedPolicies++;
      let pCompared = 0, pMatched = 0, pMismatched = 0;
      const pMismatchedFields = [];
      for (const f of FIELDS) {
        const prVal = f.prCols ? firstNonNull(p, f.prCols) : p[f.prCol];
        const dbVal = firstNonNull(db, f.dbCols);
        if (prVal == null && dbVal == null) continue;       // both blank — ignore
        const cmp = compareValues(f.type, prVal, dbVal);
        if (cmp.match === null) continue;                    // one side blank
        const bucket = perField.get(f.field);
        bucket.compared++;
        pCompared++;
        if (cmp.match) { bucket.matched++; pMatched++; }
        else {
          bucket.mismatched++;
          pMismatched++;
          pMismatchedFields.push(f.field);
          if (exceptions.length < EXCEPTION_CAP) {
            exceptions.push({
              policy_no: key,
              field: f.field,
              pr_value: cmp.a,
              db_value: cmp.b,
              diff: cmp.diff != null ? cmp.diff : null,
            });
          }
        }
      }
      perPolicy.push({
        policy_no: key,
        matched: true,
        compared: pCompared,
        matched_count: pMatched,
        mismatched_count: pMismatched,
        match_pct: pCompared > 0 ? +(100 * pMatched / pCompared).toFixed(2) : null,
        mismatched_fields: pMismatchedFields,
      });
    }

    const fields = [...perField.values()].map(b => ({
      ...b,
      match_pct: b.compared > 0 ? +(100 * b.matched / b.compared).toFixed(2) : null,
    }));
    const totalCompared   = fields.reduce((a, f) => a + f.compared,   0);
    const totalMatched    = fields.reduce((a, f) => a + f.matched,    0);
    const totalMismatched = fields.reduce((a, f) => a + f.mismatched, 0);

    res.json({
      success: true,
      summary: {
        pr_rows: pr.length,
        matched_policies: matchedPolicies,
        unmatched_policies: unmatchedPolicies,
        match_pct_overall: totalCompared > 0 ? +(100 * totalMatched / totalCompared).toFixed(2) : null,
        total_compared: totalCompared,
        total_matched: totalMatched,
        total_mismatched: totalMismatched,
        tolerance_pct: tolerancePct,
      },
      fields,
      policies: perPolicy,
      exceptions,
      exceptions_capped: exceptions.length === EXCEPTION_CAP,
      exceptions_count: totalMismatched,
    });
  } catch (err) { next(err); }
});

/** Shared side-by-side builder used by both GET /:id/policy/:policyNo and
 *  the resolve endpoint so they agree on shape + comparison logic. */
async function buildSideBySide(uploadId, pn) {
  const pool         = await getPool();
  const prarambhPool = await getPrarambhUatPool();

    const prR = await pool.request()
      .input('uid', sql.Int, uploadId)
      .input('pn',  sql.NVarChar(200), pn)
      .query('SELECT TOP 1 * FROM pr_rows WHERE upload_id = @uid AND policy_no = @pn');
    const prRow = prR.recordset[0] || null;

    // tmp_PrarambhData can have multiple rows per PolicyNo (endorsements).
    // /compare uses `byPolicy.set(...)` in insertion order — last row wins.
    // Mirror that here so both endpoints agree on which row to compare.
    const dbR = await prarambhPool.request()
      .input('pn',  sql.NVarChar(200), pn)
      .query(`SELECT PolicyNo, TrackerNo, VEHICLE_REGISTRATION_NO, VEHICAL_MAKE, VEHICAL_MODEL,
                     Vehicle_Sub_Model, CC, Tonnes, GROSS_VEHICLE_WEIGHT, SEATING_CAPACITY,
                     FUELTYPE, MFG_YEAR, VEHICLE_IDV, TOTAL_IDV, NCB, BASE_OD_PREMIUM, NET_OD_PREMIUM,
                     ADD_ON_PREMIUM, Addon_Premium, LIABILITY_PREMIUM, NET_LIABILITY_PREMIUM,
                     PREMIUM_WITHOUT_GST, ANNUAL_PREMIUM, ANNUALPREMIUM, StateName, INSURERNAME,
                     VehicleType, AGE_OF_VEHICLE, RTO_Code, UPIN_CODE
              FROM tmp_PrarambhData WHERE PolicyNo = @pn`);
    const dbRow = dbR.recordset.length > 0 ? dbR.recordset[dbR.recordset.length - 1] : null;
    const dbRowCount = dbR.recordset.length;

    // Same field definitions as /compare — keep in one place if they ever
    // grow; for now duplicated since compare's closure-scoped FIELDS isn't
    // exported.
    const FIELDS = [
      // Vehicle Class — PR's product/category vs Prarambh's VehicleType,
      // normalised to one of GCV/PCV/CAR/TW/MISC. Flags a goods truck booked
      // as Pvt.Car (and vice-versa). Prefer the precise vehicle_category, fall
      // back to product. Incomparable (null) for non-motor products.
      { field: 'Vehicle Class', type: 'class', prCols: ['vehicle_category', 'product'], dbCols: ['VehicleType'] },
      { field: 'Vehicle No',    type: 'str',  prCol: 'vehicle_no',    dbCols: ['VEHICLE_REGISTRATION_NO'] },
      { field: 'Make',          type: 'str',  prCol: 'vehicle_make',  dbCols: ['VEHICAL_MAKE'] },
      { field: 'Model',         type: 'str',  prCol: 'vehicle_model', dbCols: ['VEHICAL_MODEL'] },
      { field: 'Sub Model',     type: 'str',  prCol: 'sub_model',     dbCols: ['Vehicle_Sub_Model'] },
      { field: 'CC',            type: 'int',  prCol: 'cc',            dbCols: ['CC'] },
      { field: 'Tonnage',       type: 'num',  prCol: 'tonnage',       dbCols: ['Tonnes', 'GROSS_VEHICLE_WEIGHT'] },
      { field: 'Seating',       type: 'int',  prCol: 'seating',       dbCols: ['SEATING_CAPACITY'] },
      { field: 'Fuel Type',     type: 'str',  prCol: 'fuel_type',     dbCols: ['FUELTYPE'] },
      { field: 'MFG Year',      type: 'str',  prCol: 'mfg_year',      dbCols: ['MFG_YEAR'] },
      // Sum Insured: PR.sum_insured aligns with Prarambh.TOTAL_IDV (all-
       // coverage IDV including addons / electrical accessories). The
       // VEHICLE_IDV column is the OD-only IDV and consistently differs
       // from PR.sum_insured when addons exist. TOTAL stays primary,
       // VEHICLE is the fallback for older rows missing TOTAL_IDV.
      { field: 'Sum Insured',   type: 'num',  prCol: 'sum_insured',   dbCols: ['TOTAL_IDV', 'VEHICLE_IDV'] },
      { field: 'NCB %',         type: 'num',  prCol: 'ncb',           dbCols: ['NCB'] },
      // OD Premium: PR.od_premium aligns with Prarambh.NET_OD_PREMIUM (the
      // post-discount net OD figure both systems track as "what the customer
      // paid for OD"). BASE_OD_PREMIUM is gross-of-discount and consistently
      // differs by the dealer/agent discount, so using it as primary
      // surfaced a phantom mismatch on every policy.
      { field: 'OD Premium',    type: 'num',  prCol: 'od_premium',    dbCols: ['NET_OD_PREMIUM', 'BASE_OD_PREMIUM'] },
      { field: 'Addon Premium', type: 'num',  prCol: 'addon_premium', dbCols: ['ADD_ON_PREMIUM', 'Addon_Premium'] },
      // TP Premium: PR.tp_premium aligns with Prarambh.NET_LIABILITY_PREMIUM
      // (post-discount net TP). Same reasoning as OD — the gross
      // LIABILITY_PREMIUM consistently differs by the discount, surfacing a
      // phantom mismatch on every policy. NET kept primary, gross fallback.
      { field: 'TP Premium',    type: 'num',  prCol: 'tp_premium',    dbCols: ['NET_LIABILITY_PREMIUM', 'LIABILITY_PREMIUM'] },
      { field: 'Net Amount',    type: 'num',  prCol: 'net_amount',    dbCols: ['PREMIUM_WITHOUT_GST'] },
      { field: 'Gross Amount',  type: 'num',  prCol: 'gross_amount',  dbCols: ['ANNUAL_PREMIUM', 'ANNUALPREMIUM'] },
      { field: 'State',         type: 'str',  prCol: 'state',         dbCols: ['StateName'] },
      // RTO Code — PR's RTO lives inside the registration number; Prarambh has
      // an explicit RTO_Code column (registration as fallback). Both normalised
      // to base RTO (state letters + district digits) before comparing.
      { field: 'RTO Code',      type: 'rto',  prCols: ['vehicle_no'], dbCols: ['RTO_Code', 'VEHICLE_REGISTRATION_NO'] },
    ];
    const firstNonNull = (r, cols) => {
      if (!r) return null;
      for (const c of cols) { const v = r[c]; if (v !== null && v !== undefined && v !== '') return v; }
      return null;
    };
    const normStr = v => v == null ? null : String(v).trim().toLowerCase().replace(/\s+/g, ' ');
    const normNum = v => {
      if (v == null || v === '') return null;
      const n = parseFloat(String(v).replace(/[,\s₹]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const cmp = (type, a, b) => {
      if (a == null || b == null) return null;     // incomparable
      if (type === 'str') return normStr(a) === normStr(b);
      const na = normNum(a), nb = normNum(b);
      if (na == null || nb == null) return null;
      // PR statements often show refunds/cancellations as negatives; compare
      // on magnitude so a sign flip alone doesn't count as a mismatch.
      const aa = Math.abs(na), ab = Math.abs(nb);
      if (type === 'int') return Math.round(aa) === Math.round(ab);
      const tol = Math.max(1, 0.005 * Math.max(aa, ab));
      return Math.abs(aa - ab) <= tol;
    };

    const fields = FIELDS.map(f => {
      const pr = prRow ? (f.prCols ? firstNonNull(prRow, f.prCols) : prRow[f.prCol]) : null;
      const db = firstNonNull(dbRow, f.dbCols);
      let match;
      if (f.type === 'class') {
        const cp = vehClass(pr), cd = vehClass(db);
        match = (cp == null || cd == null) ? null : (cp === cd);
      } else if (f.type === 'rto') {
        const rp = rtoBase(pr), rd = rtoBase(db);
        match = (rp == null || rd == null) ? null : (rp === rd);
      } else {
        match = cmp(f.type, pr, db);
      }
      return { field: f.field, type: f.type, pr, db, match };
    });

    return {
      success: true,
      policy_no: pn,
      pr_found: !!prRow,
      db_found: !!dbRow,
      db_row_count: dbRowCount,          // >1 means endorsement/duplicate rows exist
      pr_row: prRow,
      db_row: dbRow,
      fields,
    };
}

router.get('/:id(\\d+)/policy/:policyNo', async (req, res, next) => {
  try {
    const uploadId = Number(req.params.id);
    const pn = String(req.params.policyNo || '').trim();
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const out = await buildSideBySide(uploadId, pn);
    res.json(out);
  } catch (err) { next(err); }
});

/**
 * PUT /:id/policy/:policyNo/resolve
 * Body: { field: 'CC'|'OD Premium'|…, direction: 'pr'|'prarambh' }
 *
 *   direction: 'pr'       → make Prarambh match PR   (writes tmp_PrarambhData)
 *   direction: 'prarambh' → make PR match Prarambh   (writes pr_rows)
 *
 * Returns the same shape as GET /:id/policy/:policyNo so the client can
 * re-render the side-by-side panel without a second round-trip.
 */
router.put('/:id(\\d+)/policy/:policyNo/resolve', express.json(), async (req, res, next) => {
  try {
    const uploadId = Number(req.params.id);
    const pn = String(req.params.policyNo || '').trim();
    const { field, direction, value } = req.body || {};
    if (!pn)                                 return res.status(400).json({ success: false, error: 'policy_no required' });
    if (!field)                              return res.status(400).json({ success: false, error: 'field required' });
    if (!['pr', 'prarambh'].includes(direction)) {
      return res.status(400).json({ success: false, error: "direction must be 'pr' or 'prarambh'" });
    }

    // Shared field definition — kept alongside /policy/:policyNo reader so
    // column mappings stay in one place.
    const FIELDS = [
      // Vehicle Class resolves PR → Prarambh only: it rewrites Prarambh's
      // VehicleType to the canonical string for PR's class (GCV truck wrongly
      // booked as Pvt.Car → "Commercial-Goods Carrying").
      { field: 'Vehicle Class', type: 'class', prCols: ['vehicle_category', 'product'], dbCol: 'VehicleType' },
      { field: 'Vehicle No',    type: 'str',  prCol: 'vehicle_no',    dbCol: 'VEHICLE_REGISTRATION_NO' },
      { field: 'Make',          type: 'str',  prCol: 'vehicle_make',  dbCol: 'VEHICAL_MAKE' },
      { field: 'Model',         type: 'str',  prCol: 'vehicle_model', dbCol: 'VEHICAL_MODEL' },
      { field: 'Sub Model',     type: 'str',  prCol: 'sub_model',     dbCol: 'Vehicle_Sub_Model' },
      { field: 'CC',            type: 'int',  prCol: 'cc',            dbCol: 'CC' },
      { field: 'Tonnage',       type: 'num',  prCol: 'tonnage',       dbCol: 'Tonnes' },
      { field: 'Seating',       type: 'int',  prCol: 'seating',       dbCol: 'SEATING_CAPACITY' },
      { field: 'Fuel Type',     type: 'str',  prCol: 'fuel_type',     dbCol: 'FUELTYPE' },
      { field: 'MFG Year',      type: 'str',  prCol: 'mfg_year',      dbCol: 'MFG_YEAR' },
      // Resolve target columns kept in sync with the comparison primary:
      //   Sum Insured  → TOTAL_IDV
      //   OD Premium   → NET_OD_PREMIUM
      //   TP Premium   → NET_LIABILITY_PREMIUM
      // Updates flow into the same canonical column the comparison uses,
      // so the resolved row matches PR on the next render.
      { field: 'Sum Insured',   type: 'num',  prCol: 'sum_insured',   dbCol: 'TOTAL_IDV' },
      { field: 'NCB %',         type: 'num',  prCol: 'ncb',           dbCol: 'NCB' },
      { field: 'OD Premium',    type: 'num',  prCol: 'od_premium',    dbCol: 'NET_OD_PREMIUM' },
      { field: 'Addon Premium', type: 'num',  prCol: 'addon_premium', dbCol: 'ADD_ON_PREMIUM' },
      { field: 'TP Premium',    type: 'num',  prCol: 'tp_premium',    dbCol: 'NET_LIABILITY_PREMIUM' },
      { field: 'Net Amount',    type: 'num',  prCol: 'net_amount',    dbCol: 'PREMIUM_WITHOUT_GST' },
      { field: 'Gross Amount',  type: 'num',  prCol: 'gross_amount',  dbCol: 'ANNUAL_PREMIUM' },
      { field: 'State',         type: 'str',  prCol: 'state',         dbCol: 'StateName' },
      // RTO Code resolves PR → Prarambh only: it writes the base RTO derived
      // from PR's registration number into Prarambh's RTO_Code. Reverse is
      // rejected (pr_rows has no RTO column — the RTO lives inside vehicle_no).
      { field: 'RTO Code',      type: 'rto',  prCol: 'vehicle_no',    dbCol: 'RTO_Code' },
    ];
    const f = FIELDS.find(x => x.field === field);
    if (!f) return res.status(400).json({ success: false, error: `Unknown field "${field}"` });

    const pool         = await getPool();
    const prarambhPool = await getPrarambhUatPool();

    // Fetch current values so we know what to copy where.
    const prR = await pool.request()
      .input('uid', sql.Int, uploadId).input('pn', sql.NVarChar(200), pn)
      .query('SELECT TOP 1 * FROM pr_rows WHERE upload_id = @uid AND policy_no = @pn');
    if (prR.recordset.length === 0) return res.status(404).json({ success: false, error: 'PR row not found' });
    const prRow = prR.recordset[0];

    const dbR = await prarambhPool.request()
      .input('pn', sql.NVarChar(200), pn)
      .query(`SELECT ${f.dbCol} AS v FROM tmp_PrarambhData WHERE PolicyNo = @pn`);
    if (dbR.recordset.length === 0) return res.status(404).json({ success: false, error: 'Prarambh row not found' });
    // Last-wins, same as compare/side-by-side.
    const dbVal = dbR.recordset[dbR.recordset.length - 1].v;

    // Pick sql type for parameter binding.
    const typeFor = (t, v) => {
      if (t === 'int') return { tp: sql.Int,          val: v == null ? null : parseInt(String(v).replace(/[^\d-]/g, ''), 10) };
      if (t === 'num') return { tp: sql.Decimal(18,2),val: v == null ? null : parseFloat(String(v).replace(/[^\d.-]/g, '')) };
      return              { tp: sql.NVarChar(500),    val: v == null ? null : String(v) };
    };

    // Capture old + new values so we can log the resolution. The "old"
    // value is whatever the destination side held BEFORE the write; the
    // "new" value is what we wrote. Both sides also surface the originating
    // value (the source side's pre-write value) for audit purposes.
    let oldDest = null, newDest = null;
    if (f.type === 'class') {
      // Class is normalised, not a raw copy: only PR → Prarambh makes sense
      // (PR's product/category is the authoritative class; we fix Prarambh's
      // VehicleType to the canonical string). Reverse direction is rejected —
      // overwriting PR's detailed product text from a 5-way class is lossy.
      if (direction !== 'pr') {
        return res.status(400).json({
          success: false,
          error: 'Vehicle Class can only be corrected PR → Prarambh (it rewrites Prarambh\'s VehicleType).',
        });
      }
      // The QC pane offers a dropdown of the canonical VehicleType strings so
      // the reviewer can pick the correct class explicitly (not only PR's
      // derived one). If a `value` is supplied it must be one of those exact
      // strings (or a class key like "GCV"); otherwise fall back to deriving
      // the class from PR's product/category as before.
      const VALID_VEHTYPES = Object.values(VEHCLASS_TO_VEHICLETYPE);
      let target;
      if (value != null && String(value).trim() !== '') {
        const v = String(value).trim();
        target = VALID_VEHTYPES.includes(v)
          ? v
          : (VEHCLASS_TO_VEHICLETYPE[v.toUpperCase()] || null);
        if (!target) {
          return res.status(422).json({
            success: false,
            error: `Invalid vehicle type "${v}". Must be one of: ${VALID_VEHTYPES.join(', ')}.`,
          });
        }
      } else {
        const cls = vehClass(prRow.vehicle_category || prRow.product);
        target = cls ? VEHCLASS_TO_VEHICLETYPE[cls] : null;
        if (!target) {
          return res.status(422).json({
            success: false,
            error: 'Could not classify the PR vehicle (product / category) into a vehicle type.',
          });
        }
      }
      oldDest = dbVal; newDest = target;
      await prarambhPool.request()
        .input('pn', sql.NVarChar(200), pn)
        .input('v',  sql.NVarChar(500), target)
        .query(`UPDATE tmp_PrarambhData SET VehicleType = @v WHERE PolicyNo = @pn`);
    } else if (f.type === 'rto') {
      // RTO is normalised from PR's registration number, not a raw copy, and
      // pr_rows has no RTO column — so only PR → Prarambh is supported (writes
      // the base RTO into Prarambh's RTO_Code). Reverse direction is rejected.
      if (direction !== 'pr') {
        return res.status(400).json({
          success: false,
          error: 'RTO Code can only be corrected PR → Prarambh (it rewrites Prarambh\'s RTO_Code).',
        });
      }
      const target = rtoBase(prRow.vehicle_no);
      if (!target) {
        return res.status(422).json({
          success: false,
          error: 'Could not derive a valid RTO code from the PR registration number.',
        });
      }
      oldDest = dbVal; newDest = target;
      await prarambhPool.request()
        .input('pn', sql.NVarChar(200), pn)
        .input('v',  sql.NVarChar(500), target)
        .query(`UPDATE tmp_PrarambhData SET RTO_Code = @v WHERE PolicyNo = @pn`);
    } else if (direction === 'pr') {
      // Write PR value onto tmp_PrarambhData (all rows for this PolicyNo —
      // endorsements included — so subsequent compares stay consistent).
      const { tp, val } = typeFor(f.type, prRow[f.prCol]);
      oldDest = dbVal; newDest = val;
      await prarambhPool.request()
        .input('pn', sql.NVarChar(200), pn)
        .input('v',  tp, val)
        .query(`UPDATE tmp_PrarambhData SET ${f.dbCol} = @v WHERE PolicyNo = @pn`);
    } else {
      // Write Prarambh value onto pr_rows for this upload + policy.
      const { tp, val } = typeFor(f.type, dbVal);
      oldDest = prRow[f.prCol]; newDest = val;
      await pool.request()
        .input('uid', sql.Int, uploadId).input('pn', sql.NVarChar(200), pn)
        .input('v',   tp, val)
        .query(`UPDATE pr_rows SET ${f.prCol} = @v WHERE upload_id = @uid AND policy_no = @pn`);
    }

    // Audit log — captures every resolution so the PR Dashboard can count
    // "Updated from PR" / "Updated from Prarambh" and the Admin tab can
    // surface a per-policy resolution history. Created lazily so existing
    // installs don't need a separate migration step.
    try {
      await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'pr_resolutions')
        BEGIN
          CREATE TABLE pr_resolutions (
            id            INT IDENTITY(1,1) PRIMARY KEY,
            upload_id     INT NOT NULL,
            insurer_slug  VARCHAR(100),
            policy_no     NVARCHAR(200) NOT NULL,
            field         NVARCHAR(80)  NOT NULL,
            direction     VARCHAR(20)   NOT NULL, -- 'pr' or 'prarambh'
            old_value     NVARCHAR(500),
            new_value     NVARCHAR(500),
            resolved_at   DATETIME      DEFAULT GETDATE(),
            resolved_by   NVARCHAR(100) DEFAULT 'Admin'
          );
          CREATE INDEX ix_pr_resolutions_upload ON pr_resolutions(upload_id);
          CREATE INDEX ix_pr_resolutions_policy ON pr_resolutions(policy_no);
          CREATE INDEX ix_pr_resolutions_at     ON pr_resolutions(resolved_at);
        END;`);
      await pool.request()
        .input('uid', sql.Int, uploadId)
        .input('slug', sql.VarChar(100), prRow.insurer_slug || null)
        .input('pn', sql.NVarChar(200), pn)
        .input('fld', sql.NVarChar(80), field)
        .input('dir', sql.VarChar(20), direction)
        .input('ov',  sql.NVarChar(500), oldDest == null ? null : String(oldDest))
        .input('nv',  sql.NVarChar(500), newDest == null ? null : String(newDest))
        .query(`INSERT INTO pr_resolutions
                  (upload_id, insurer_slug, policy_no, field, direction, old_value, new_value)
                VALUES (@uid, @slug, @pn, @fld, @dir, @ov, @nv)`);
    } catch (logErr) {
      // Don't fail the resolution if logging fails — audit is best-effort.
      console.error('[pr resolve] audit log failed:', logErr.message);
    }

    // Re-compute side-by-side so the client can drop the result straight into
    // the existing panel.
    const fresh = await buildSideBySide(uploadId, pn);
    res.json({ ...fresh, resolved: { field, direction } });
  } catch (err) { next(err); }
});

router.get('/match', async (req, res, next) => {
  try {
    const pn = String(req.query.policy_no || '').trim();
    if (!pn) return res.status(400).json({ success: false, error: 'policy_no required' });
    const pool = await getPool();
    const r = await pool.request()
      .input('pn', sql.NVarChar(200), pn)
      .query(`SELECT TOP 1 pr.*, u.insurer_label, u.month, u.year
              FROM pr_rows pr
              INNER JOIN pr_uploads u ON u.id = pr.upload_id
              WHERE u.status = 'active' AND pr.policy_no = @pn
              ORDER BY u.year DESC, u.month DESC, pr.id DESC`);
    res.json({ success: true, match: r.recordset[0] || null });
  } catch (err) { next(err); }
});

/**
 * GET /api/pr/dashboard?insurer=&cycle_id=
 *
 * 5-card summary for the Premium Register tab:
 *   1. Total Policy        — Prarambh policies in the selected window
 *                            (cycle date_from..date_to or the whole month
 *                            of the matched PR uploads).
 *   2. Received in PR      — count of pr_rows from active uploads matching
 *                            insurer + window.
 *   3. Matched with PR     — Prarambh policies whose PolicyNo also exists
 *                            in pr_rows for the same window.
 *   4. Updated from PR     — pr_resolutions count with direction='pr'
 *                            (writes that landed in tmp_PrarambhData).
 *   5. Updated from Prarambh
 *                          — pr_resolutions count with direction='prarambh'
 *                            (writes that landed in pr_rows).
 *
 * Filters:
 *   insurer=<slug>   — narrows all 5 metrics to one insurer
 *   cycle_id=<id>    — uses payout_cycles row to define the policy window;
 *                      when omitted, falls back to the cycle that "covers"
 *                      today; when no cycle exists either, the window is
 *                      the current month.
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const insurerSlug = String(req.query.insurer || '').trim() || null;
    const cycleId = req.query.cycle_id != null && req.query.cycle_id !== ''
      ? Number(req.query.cycle_id) : null;

    const pool = await getPool();
    const prarambhPool = await getPrarambhUatPool();

    // Resolve the window. Prefer the explicit cycle; else fall back to
    // "current month" so the dashboard isn't blank when no cycle picked.
    let dateFrom = null, dateTo = null, cycleName = null;
    if (cycleId != null && Number.isFinite(cycleId)) {
      const cyc = await pool.request().input('id', sql.Int, cycleId)
        .query(`SELECT id, name, date_from, date_to FROM payout_cycles WHERE id = @id`);
      if (cyc.recordset.length === 0) {
        return res.status(404).json({ success: false, error: `Cycle ${cycleId} not found` });
      }
      const c = cyc.recordset[0];
      dateFrom = c.date_from; dateTo = c.date_to; cycleName = c.name;
    } else {
      // Default window — start of current month → today + 1 day. Keeps the
      // dashboard meaningful when the user lands on the tab without picking
      // a cycle.
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      dateFrom = start.toISOString().slice(0, 10);
      dateTo   = end.toISOString().slice(0, 10);
    }

    // Make sure the resolutions table exists — created lazily on first
    // resolution write, but the dashboard may run before any resolution.
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'pr_resolutions')
      BEGIN
        CREATE TABLE pr_resolutions (
          id            INT IDENTITY(1,1) PRIMARY KEY,
          upload_id     INT NOT NULL,
          insurer_slug  VARCHAR(100),
          policy_no     NVARCHAR(200) NOT NULL,
          field         NVARCHAR(80)  NOT NULL,
          direction     VARCHAR(20)   NOT NULL,
          old_value     NVARCHAR(500),
          new_value     NVARCHAR(500),
          resolved_at   DATETIME      DEFAULT GETDATE(),
          resolved_by   NVARCHAR(100) DEFAULT 'Admin'
        );
        CREATE INDEX ix_pr_resolutions_upload ON pr_resolutions(upload_id);
        CREATE INDEX ix_pr_resolutions_policy ON pr_resolutions(policy_no);
        CREATE INDEX ix_pr_resolutions_at     ON pr_resolutions(resolved_at);
      END;`);

    // ── Metric 1: Total Policy ────────────────────────────────────────────
    // Prarambh policies in the window. INSURERNAME filter when slug given —
    // mapping slug → display name uses the same convention as bulk pipeline
    // (slug "tata_aig" matches insurers whose INSURERNAME contains "TATA").
    const insurerLike = insurerSlug ? insurerSlugToLikePattern(insurerSlug) : null;
    let totalPolicy = 0;
    try {
      const rq = prarambhPool.request()
        .input('df', sql.Date, dateFrom)
        .input('dt', sql.Date, dateTo);
      let where = `WHERE SubmissionDate >= @df AND SubmissionDate < @dt`;
      if (insurerLike) {
        rq.input('ins', sql.NVarChar(200), insurerLike);
        where += ` AND INSURERNAME LIKE @ins`;
      }
      const r = await rq.query(`SELECT COUNT(DISTINCT PolicyNo) AS n FROM tmp_PrarambhData ${where}`);
      totalPolicy = r.recordset[0]?.n || 0;
    } catch (err) {
      console.error('[pr dashboard] total-policy query:', err.message);
    }

    // ── Metric 2: Received in PR ──────────────────────────────────────────
    // PR rows from active uploads matching the cycle window. PR uploads are
    // keyed by month/year, not date range, so a row is "in window" if its
    // upload's month/year overlaps the cycle.
    const win = monthsInWindow(dateFrom, dateTo);
    const winFilter = win.length
      ? `AND (${win.map((_, i) => `(u.month = @m${i} AND u.year = @y${i})`).join(' OR ')})`
      : '';
    const rxRq = pool.request();
    win.forEach((mY, i) => { rxRq.input('m' + i, sql.Int, mY.m); rxRq.input('y' + i, sql.Int, mY.y); });
    let insClause = '';
    if (insurerSlug) {
      rxRq.input('slug', sql.VarChar(100), insurerSlug);
      insClause = ' AND u.insurer_slug = @slug';
    }
    const recRes = await rxRq.query(
      `SELECT COUNT(DISTINCT pr.policy_no) AS n
       FROM pr_rows pr
       INNER JOIN pr_uploads u ON u.id = pr.upload_id
       WHERE u.status = 'active' ${insClause} ${winFilter}`
    );
    const receivedInPr = recRes.recordset[0]?.n || 0;

    // ── Metric 3: Matched with PR ────────────────────────────────────────
    // Policies that exist in BOTH systems for the window. Pull the set of PR
    // policy numbers and intersect with Prarambh.
    let matchedWithPr = 0;
    try {
      const policySet = await rxRq.query(
        `SELECT DISTINCT pr.policy_no
         FROM pr_rows pr
         INNER JOIN pr_uploads u ON u.id = pr.upload_id
         WHERE u.status = 'active' ${insClause} ${winFilter}`
      ).catch(() => null);
      if (policySet && policySet.recordset.length > 0) {
        const policyNos = policySet.recordset.map(r => r.policy_no).filter(Boolean);
        const CHUNK = 1000;
        for (let i = 0; i < policyNos.length; i += CHUNK) {
          const chunk = policyNos.slice(i, i + CHUNK);
          const req2 = prarambhPool.request();
          req2.timeout = 60000;
          const names = chunk.map((_, j) => `@p${j}`);
          chunk.forEach((pn, j) => req2.input('p' + j, sql.NVarChar(200), pn));
          let extra = '';
          if (insurerLike) {
            req2.input('ins2', sql.NVarChar(200), insurerLike);
            extra = ' AND INSURERNAME LIKE @ins2';
          }
          const r = await req2.query(
            `SELECT COUNT(DISTINCT PolicyNo) AS n
             FROM tmp_PrarambhData
             WHERE PolicyNo IN (${names.join(', ')}) ${extra}`);
          matchedWithPr += r.recordset[0]?.n || 0;
        }
      }
    } catch (err) {
      console.error('[pr dashboard] matched query:', err.message);
    }

    // ── Metrics 4 & 5: Updated from PR / Updated from Prarambh ───────────
    // Sourced from pr_resolutions in the same window. Both directions are
    // pulled in a single grouped query so we don't pay two round-trips.
    const resRq = pool.request()
      .input('df', sql.DateTime, dateFrom)
      .input('dt', sql.DateTime, dateTo);
    let resInsClause = '';
    if (insurerSlug) {
      resRq.input('slug', sql.VarChar(100), insurerSlug);
      resInsClause = ' AND insurer_slug = @slug';
    }
    const resRes = await resRq.query(
      `SELECT direction, COUNT(*) AS n
       FROM pr_resolutions
       WHERE resolved_at >= @df AND resolved_at < DATEADD(day, 1, @dt) ${resInsClause}
       GROUP BY direction`
    );
    let updatedFromPr = 0, updatedFromPrarambh = 0;
    for (const row of resRes.recordset) {
      if (row.direction === 'pr') updatedFromPr = row.n;
      else if (row.direction === 'prarambh') updatedFromPrarambh = row.n;
    }

    res.json({
      success: true,
      filters: {
        insurer: insurerSlug,
        cycle_id: cycleId,
        cycle_name: cycleName,
        date_from: dateFrom,
        date_to: dateTo,
      },
      metrics: {
        total_policy:          totalPolicy,
        received_in_pr:        receivedInPr,
        matched_with_pr:       matchedWithPr,
        updated_from_pr:       updatedFromPr,
        updated_from_prarambh: updatedFromPrarambh,
      },
    });
  } catch (err) { next(err); }
});

/** Slug → INSURERNAME LIKE pattern. tmp_PrarambhData.INSURERNAME carries
 *  the full display name (e.g. "TATA AIG General Insurance Company Ltd"),
 *  so we match on a stable substring of the brand. Mirrors resolveInsurerSlug
 *  from routes/policy.js, but inverted. */
function insurerSlugToLikePattern(slug) {
  const m = {
    tata_aig: '%TATA%',
    chola_ms: '%CHOLA%',
    icici_lombard: '%ICICI%',
    go_digit: '%DIGIT%',
    royal_sundaram: '%ROYAL%',
    bajaj_allianz: '%BAJAJ%',
    hdfc_ergo: '%HDFC%',
    iffco_tokio: '%IFFCO%',
    sbi_general: '%SBI%',
    reliance: '%RELIANCE%',
    new_india: '%NEW INDIA%',
    united_india: '%UNITED INDIA%',
    national: '%NATIONAL%',
    oriental: '%ORIENTAL%',
    universal_sompo: '%SOMPO%',
    future_generali: '%FUTURE%',
    kotak: '%KOTAK%',
    shriram: '%SHRIRAM%',
    raheja_qbe: '%RAHEJA%',
    magma: '%MAGMA%',
    liberty: '%LIBERTY%',
    zuno: '%ZUNO%',
  };
  return m[slug] || `%${slug.replace(/_/g, ' ')}%`;
}

/** Given a date window, list every (month, year) it touches. PR uploads are
 *  monthly so we OR the membership tests across all overlapping months. */
function monthsInWindow(fromStr, toStr) {
  if (!fromStr || !toStr) return [];
  const out = [];
  const f = new Date(fromStr);
  const t = new Date(toStr);
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return [];
  let y = f.getUTCFullYear(), m = f.getUTCMonth() + 1;
  const yT = t.getUTCFullYear(), mT = t.getUTCMonth() + 1;
  while (y < yT || (y === yT && m <= mT)) {
    out.push({ m, y });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

module.exports = router;
module.exports.loadMapping = loadMapping;
module.exports.resolveColumn = resolveColumn;
