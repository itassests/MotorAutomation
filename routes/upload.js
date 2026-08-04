const express = require('express');
const path = require('path');
const fs = require('fs');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { parseWorkbook } = require('../parsers/engine');
const { validateCard } = require('../services/card-validation');

const router = express.Router();

/**
 * Parse conditional text like "0-2 yrs: 5%, 3-5 yrs: 3%" into structured entries.
 */
function parseConditionalText(rateText) {
  if (!rateText) return [];

  const entries = [];
  // Match patterns like "0-2 yrs: 5%" or "3+ yrs: 2.5%"
  const parts = String(rateText).split(/[,;]/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Pattern: "0-2 yrs: 5%" or "0-2: 5" or "3+: 2.5"
    const match = trimmed.match(
      /(\d+)\s*[-–]\s*(\d+)\s*(?:yrs?|years?)?\s*[:=]\s*([\d.]+)%?/i
    );
    if (match) {
      entries.push({
        condition_type: 'vehicle_age',
        condition_min: parseInt(match[1], 10),
        condition_max: parseInt(match[2], 10),
        condition_text: trimmed,
        rate_value: parseFloat(match[3]),
      });
      continue;
    }

    // Pattern: "3+ yrs: 2.5%"
    const matchPlus = trimmed.match(
      /(\d+)\+?\s*(?:yrs?|years?)?\s*[:=]\s*([\d.]+)%?/i
    );
    if (matchPlus) {
      entries.push({
        condition_type: 'vehicle_age',
        condition_min: parseInt(matchPlus[1], 10),
        condition_max: null,
        condition_text: trimmed,
        rate_value: parseFloat(matchPlus[2]),
      });
    }
  }

  return entries;
}

/**
 * POST /upload
 * Upload an Excel rate card file and parse it into the database.
 */
router.post('/upload', async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded. Use field name "file".' });
    }

    const { insurer, effective_from } = req.body;
    if (!insurer) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: insurer' });
    }

    // ── EMAIL (.eml/.msg) branch ────────────────────────────────────────────────
    // Extract grids from the mail body (inline HTML tables) + spreadsheet
    // attachments, parse them with the dynamic engine, and land them as a card.
    // A bounded deal window (e.g. "20th-31st Jul") is an OVERLAY (standing grid
    // stays open); an unbounded grid supersedes prior open cards by effective date.
    if (/\.(eml|msg)$/i.test(req.file.originalname) || /\.(eml|msg)$/i.test(req.file.path)) {
      const pool = await getPool();
      const filePath = req.file.path;
      const fileName = req.file.originalname;
      const { extractEmail } = require('../services/email-extract');
      const pp = require('../services/parse-profile');
      const XLSXlib = require('xlsx');
      const info = await extractEmail(filePath);

      const sheets = [];
      info.tables.forEach((rows, i) => sheets.push({ name: 'Email Table ' + (i + 1), rows }));
      const attNotes = [];
      for (const a of info.attachments) {
        if (a.isSheet && a.buffer) {
          try {
            const wb = XLSXlib.read(a.buffer, { type: 'buffer' });
            for (const sn of wb.SheetNames) {
              sheets.push({ name: 'attach:' + a.filename + ':' + sn, rows: XLSXlib.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' }) });
            }
          } catch (e) { attNotes.push('attachment "' + a.filename + '" unreadable: ' + e.message); }
        } else if (a.isPdf) {
          attNotes.push('PDF attachment "' + a.filename + '" — needs a config parser (not auto-parsed)');
        } else if (a.isImage && a.size > 4000) {
          attNotes.push('image attachment "' + a.filename + '" — likely a grid image; route to OCR');
        }
      }

      const effFrom = effective_from || info.effective.from;
      if (!effFrom) {
        return res.status(400).json({ success: false, error: 'No effective_from supplied and none detected in the email — please provide it.' });
      }
      const effTo = info.effective.bounded ? info.effective.to : null;

      // Emails often bundle PRIOR months' grids for comparison (Raheja ships
      // July + June + May + Apr). Keep only the table(s) whose labelled month
      // matches the effective month, so we don't ingest conflicting old rates.
      const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
      const monthOf = (rows) => {
        for (const row of (rows || []).slice(0, 4)) for (const c of row) {
          const m = String(c == null ? '' : c).match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*['\s\-/]{0,3}(\d{2,4})\b/i);
          if (m) { let y = m[2]; if (y.length === 2) y = '20' + y; return y + '-' + MON[m[1].slice(0, 3).toLowerCase()]; }
        }
        return null;
      };
      const effMonth = String(effFrom).slice(0, 7);
      const tblMonth = sheets.map((s) => (/^Email Table/.test(s.name) ? monthOf(s.rows) : undefined));
      if (tblMonth.some((m) => m === effMonth)) {
        for (let i = sheets.length - 1; i >= 0; i--) if (tblMonth[i] && tblMonth[i] !== effMonth) sheets.splice(i, 1);
      }

      if (!effTo) {
        await pool.request().input('insurer', sql.NVarChar, insurer).input('ef', sql.Date, new Date(effFrom))
          .query('UPDATE rate_cards SET effective_to=@ef WHERE insurer=@insurer AND effective_to IS NULL AND effective_from<@ef');
      }
      const cardRes = await pool.request()
        .input('insurer', sql.NVarChar, insurer).input('fn', sql.NVarChar, fileName)
        .input('ef', sql.Date, new Date(effFrom))
        .input('et', sql.Date, effTo ? new Date(effTo) : null)
        .input('sp', sql.NVarChar, filePath)
        .query('INSERT INTO rate_cards (insurer,file_name,effective_from,effective_to,source_path) OUTPUT INSERTED.id VALUES (@insurer,@fn,@ef,@et,@sp)');
      const cardId = cardRes.recordset[0].id;

      // Classify + route each table: RTO master → rto_mappings, fleet approval →
      // fleet_overrides, enabler → enabler_overrides; rate/unknown continue to the
      // dynamic parse-profile path below.
      const { routeAndIngest } = require('../services/doc-router');
      const routed = await routeAndIngest(pool, cardId, sheets, { insurer, subject: info.subject, sourceFile: fileName });
      const generated = pp.profileSheets(routed.rateSheets, { insurer });
      const dynCount = await pp.insertAutoRulesFromGenerated(pool, cardId, insurer, generated, null);
      await pp.persistProfiles(pool, cardId, filePath, generated.map(({ rows, ...g }) => g), { insurer });

      let ruleCounts = null;
      try {
        const cnt = await pool.request().input('cid', sql.Int, cardId).query(`
          SELECT ISNULL(NULLIF(product,''),'(unset)') AS product, ISNULL(NULLIF(rate_type,''),'(none)') AS cover, COUNT(*) AS n
          FROM rate_rules WHERE rate_card_id=@cid GROUP BY ISNULL(NULLIF(product,''),'(unset)'), ISNULL(NULLIF(rate_type,''),'(none)')`);
        const bp = {};
        for (const row of cnt.recordset) { const p = (bp[row.product] = bp[row.product] || { total: 0, covers: {} }); p.total += row.n; p.covers[row.cover] = (p.covers[row.cover] || 0) + row.n; }
        ruleCounts = { total: Object.values(bp).reduce((a, p) => a + p.total, 0), by_product: Object.entries(bp).sort((a, b) => b[1].total - a[1].total).map(([product, v]) => ({ product, total: v.total, covers: v.covers })) };
      } catch (_) { /* best effort */ }

      const noGrid = dynCount === 0 && routed.counts.rto_map === 0 && routed.counts.fleet === 0 && routed.counts.enabler === 0;
      return res.json({
        success: true, rate_card_id: cardId, source: 'email', format: info.format,
        subject: info.subject, effective_from: effFrom, effective_to: effTo, bounded: !!effTo,
        rules_count: dynCount, tables_found: info.tables.length,
        routed: routed.counts, classified: routed.classified,
        attachments: info.attachments.map((a) => ({ name: a.filename, kind: a.isSheet ? 'sheet' : a.isPdf ? 'pdf' : a.isImage ? 'image' : 'other', size: a.size })),
        notes: attNotes, no_grid: noGrid,
        parse_profiles: {
          total: generated.length, auto: generated.filter((g) => g.status === 'auto').length,
          needs_review: generated.filter((g) => g.status === 'needs_review').map((g) => g.sheet_name),
          sheets: generated.map((g) => ({ sheet: g.sheet_name, layout: g.profile.layout, confidence: g.profile.confidence, coverage: g.health.coverage, rules: g.health.rulesOut, status: g.status })),
        },
        rule_counts: ruleCounts,
      });
    }

    if (!effective_from) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: effective_from' });
    }

    // Load insurer config — if no config exists, auto-generate one from the Excel file
    const configPath = path.resolve(__dirname, '..', 'config', 'insurers', `${insurer}.json`);
    let insurerConfig;

    if (fs.existsSync(configPath)) {
      insurerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } else if (/\.(pdf|msg)$/i.test(req.file.path)) {
      // No config for this insurer AND the upload isn't an Excel workbook —
      // skip auto-detection (XLSX would error on PDF/MSG). Return a clean
      // error so the operator knows to add a config first.
      return res.status(400).json({
        success: false,
        error: `No config found for insurer "${insurer}". PDF/MSG uploads require a hand-written config in config/insurers/${insurer}.json.`,
      });
    } else {
      // Auto-generate a basic flat_table config by scanning the uploaded Excel
      const XLSX = require('xlsx');
      const workbook = XLSX.readFile(req.file.path);
      const sheets = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const rowCount = data.length;
        // Find the header row (first row with multiple non-empty cells)
        let headerRow = 0;
        for (let i = 0; i < Math.min(10, data.length); i++) {
          const nonEmpty = (data[i] || []).filter(c => c !== '' && c !== null && c !== undefined).length;
          if (nonEmpty >= 3) { headerRow = i; break; }
        }
        const headers = (data[headerRow] || []).map((h, idx) => ({ col: idx, name: String(h).trim() })).filter(h => h.name);
        return { name, rowCount, headerRow, headers: headers.slice(0, 20) };
      });

      // Create auto config
      insurerConfig = {
        insurer: insurer,
        display_name: insurer.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        auto_generated: true,
        sheets: sheets.map(s => ({
          name: s.name,
          layout: 'flat_table',
          config: {
            product: 'AUTO',
            data_start_row: s.headerRow + 1,
            column_map: {},
            rate_columns: [],
            decline_markers: ['D', 'NA', 'Declined'],
            _detected_headers: s.headers,
            _note: 'Auto-generated config — review and adjust column_map and rate_columns for accurate parsing'
          }
        }))
      };

      // Save the auto config for future reference
      const configDir = path.dirname(configPath);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(insurerConfig, null, 2));
      console.log(`[RateExtract] Auto-generated config for ${insurer} at ${configPath}`);
      console.log(`[RateExtract] Detected ${sheets.length} sheets:`, sheets.map(s => `${s.name} (${s.rowCount} rows, ${s.headers.length} cols)`).join(', '));
    }

    const pool = await getPool();
    const filePath = req.file.path;
    const fileName = req.file.originalname;

    // 1. Close out previously-active rate cards for this insurer whose
    //    effective_from is older than the new card's effective_from.  This
    //    gives clean monthly boundaries: when April rates arrive,
    //    March's effective_to is set to April 1 so /export/all (which
    //    filters by today active) only returns the new April rates.
    //
    //    Cards uploaded EARLIER for the same effective month are NOT
    //    closed (so multi-file insurers like ICICI — Pvt Car + TW + CV
    //    uploaded the same day — coexist).
    await pool
      .request()
      .input('insurer', sql.NVarChar, insurer)
      .input('effective_from', sql.Date, new Date(effective_from))
      .query(
        `UPDATE rate_cards
            SET effective_to = @effective_from
          WHERE insurer = @insurer
            AND effective_to IS NULL
            AND effective_from < @effective_from`
      );

    // 2. Insert new rate_card record (effective_to left NULL — open-ended)
    const cardResult = await pool
      .request()
      .input('insurer', sql.NVarChar, insurer)
      .input('file_name', sql.NVarChar, fileName)
      .input('effective_from', sql.Date, new Date(effective_from))
      .input('source_path', sql.NVarChar, filePath)
      .query(
        `INSERT INTO rate_cards (insurer, file_name, effective_from, source_path)
         OUTPUT INSERTED.id
         VALUES (@insurer, @file_name, @effective_from, @source_path)`
      );
    const rateCardId = cardResult.recordset[0].id;

    // 2. Parse the workbook (or PDF — parseWorkbook is async since PDF
    //    extraction uses promise-based libs).
    const allRules = await parseWorkbook(filePath, insurerConfig);

    // 2b. LLM-fallback enrichment for fields the regex engine left blank.
    // Each distinct UW remark is sent to Claude Haiku at most once and
    // cached in parsed_remarks_cache. Safe no-op when ANTHROPIC_API_KEY is
    // unset — the upload continues with whatever the regex engine produced.
    try {
      const { enrichRulesWithLlmRemarks } = require('../services/llm-remark-parser');
      await enrichRulesWithLlmRemarks(allRules);
    } catch (e) {
      console.warn('[upload] LLM enrichment skipped:', e.message);
    }

    // Separate RTO mapping rules from rate rules
    const rtoRules = [];
    const rateRules = [];

    for (const rule of allRules) {
      if (rule.layout === 'rto_mapping') {
        rtoRules.push(rule);
      } else {
        rateRules.push(rule);
      }
    }

    // 3. Insert rate_rules. Strategy:
    //    - Conditional rules (need INSERTED.id to link conditional_rates) →
    //      per-row INSERT with OUTPUT (small count, OK to be slow).
    //    - Everything else → TDS bulk-load via sql.Table + Request.bulk()
    //      (handles 200k+ rows in seconds instead of hours over WAN).
    const conditionalEntries = []; // { ruleId, entries[] }
    const condRules = rateRules.filter(r => r.is_conditional && r.rate_text);
    const bulkRules = rateRules.filter(r => !(r.is_conditional && r.rate_text));

    // 3a. Per-row insert for conditional rules (need id for linkage).
    if (condRules.length > 0) {
      for (let i = 0; i < condRules.length; i += 500) {
        const batch = condRules.slice(i, i + 500);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
          for (const rule of batch) {
            const result = await new sql.Request(transaction)
              .input('rate_card_id', sql.Int, rateCardId)
              .input('insurer', sql.NVarChar, rule.insurer || insurer)
              .input('product', sql.NVarChar, rule.product || null)
              .input('sheet_name', sql.NVarChar, rule.sheetName || rule.sheet_name || null)
              .input('region', sql.NVarChar, rule.region || null)
              .input('segment', sql.NVarChar, rule.segment || null)
              .input('make', sql.NVarChar, rule.make || null)
              .input('model', sql.NVarChar, rule.model || null)
              .input('sub_type', sql.NVarChar, rule.sub_type || null)
              .input('state', sql.NVarChar, rule.state || null)
              .input('applied_on', sql.NVarChar, rule.applied_on || null)
              .input('fuel_type', sql.NVarChar, rule.fuel_type || null)
              .input('cc_band_min', sql.Int, rule.cc_band_min ?? null)
              .input('cc_band_max', sql.Int, rule.cc_band_max ?? null)
              .input('weight_band_min', sql.Decimal(10, 2), rule.weight_band_min ?? null)
              .input('weight_band_max', sql.Decimal(10, 2), rule.weight_band_max ?? null)
              .input('age_band_min', sql.Int, rule.age_band_min ?? null)
              .input('age_band_max', sql.Int, rule.age_band_max ?? null)
              .input('vehicle_age_min', sql.Int, rule.vehicle_age_min ?? null)
              .input('vehicle_age_max', sql.Int, rule.vehicle_age_max ?? null)
              .input('seating_capacity_min', sql.Int, rule.seating_capacity_min ?? null)
              .input('seating_capacity_max', sql.Int, rule.seating_capacity_max ?? null)
              .input('volume_tier', sql.NVarChar, rule.volume_tier || null)
              .input('addon', sql.NVarChar, rule.addon || null)
              .input('carrier_type', sql.NVarChar, rule.carrier_type || null)
              .input('rate_type', sql.NVarChar, rule.rate_type || null)
              .input('rate_value', sql.Decimal(10, 4), rule.rate_value ?? null)
              .input('is_declined', sql.Bit, rule.is_declined ? 1 : 0)
              .input('rate_text', sql.NVarChar, rule.rate_text || null)
              .input('is_conditional', sql.Bit, rule.is_conditional ? 1 : 0)
              .input('remarks', sql.NVarChar, rule.remarks || null)
              .input('discount_pct', sql.Decimal(5, 2), rule.discount_pct ?? null)
              .query(
                `INSERT INTO rate_rules
                 (rate_card_id, insurer, product, sheet_name, region, segment, make, model,
                  sub_type, state, applied_on, fuel_type, cc_band_min, cc_band_max, weight_band_min, weight_band_max,
                  age_band_min, age_band_max, vehicle_age_min, vehicle_age_max,
                  seating_capacity_min, seating_capacity_max, volume_tier,
                  addon, carrier_type, rate_type, rate_value, is_declined, rate_text, is_conditional, remarks, discount_pct)
                 OUTPUT INSERTED.id
                 VALUES
                 (@rate_card_id, @insurer, @product, @sheet_name, @region, @segment, @make, @model,
                  @sub_type, @state, @applied_on, @fuel_type, @cc_band_min, @cc_band_max, @weight_band_min, @weight_band_max,
                  @age_band_min, @age_band_max, @vehicle_age_min, @vehicle_age_max,
                  @seating_capacity_min, @seating_capacity_max, @volume_tier,
                  @addon, @carrier_type, @rate_type, @rate_value, @is_declined, @rate_text, @is_conditional, @remarks, @discount_pct)`
              );

            const insertedId = result.recordset[0].id;
            const parsed = parseConditionalText(rule.rate_text);
            if (parsed.length > 0) conditionalEntries.push({ ruleId: insertedId, entries: parsed });
          }
          await transaction.commit();
        } catch (err) {
          await transaction.rollback();
          throw err;
        }
      }
    }

    // 3b. Bulk-load the rest via TDS bulk insert. Chunked at 5,000 rows so a
    //     huge upload doesn't sit on a single uninterrupted TDS message for
    //     minutes (better progress + robustness against WAN drops).
    if (bulkRules.length > 0) {
      const truncate = (v, n) => {
        if (v == null) return null;
        const s = String(v);
        return s.length > n ? s.slice(0, n) : s;
      };
      // Numeric coercion for bulk-load columns. `?? null` does NOT catch NaN, so
      // a parser yielding NaN (e.g. Number('') or a bad band) reached the bulk
      // load and crashed it with "Invalid number". Coerce non-finite → null.
      const num = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const intOrNull = (v) => { const n = num(v); return n === null ? null : Math.round(n); };

      for (let i = 0; i < bulkRules.length; i += 5000) {
        const slice = bulkRules.slice(i, i + 5000);
        const table = new sql.Table('rate_rules');
        // table.create = false (default) — table must already exist.
        table.columns.add('rate_card_id',         sql.Int,            { nullable: true });
        table.columns.add('insurer',              sql.VarChar(100),   { nullable: true });
        table.columns.add('product',              sql.VarChar(100),   { nullable: true });
        table.columns.add('sheet_name',           sql.VarChar(200),   { nullable: true });
        table.columns.add('region',               sql.VarChar(200),   { nullable: true });
        table.columns.add('segment',              sql.VarChar(300),   { nullable: true });
        table.columns.add('make',                 sql.VarChar(200),   { nullable: true });
        table.columns.add('model',                sql.VarChar(200),   { nullable: true });
        table.columns.add('sub_type',             sql.VarChar(100),   { nullable: true });
        table.columns.add('state',                sql.VarChar(200),   { nullable: true });
        table.columns.add('applied_on',           sql.VarChar(10),    { nullable: true });
        table.columns.add('fuel_type',            sql.VarChar(50),    { nullable: true });
        table.columns.add('cc_band_min',          sql.Int,            { nullable: true });
        table.columns.add('cc_band_max',          sql.Int,            { nullable: true });
        table.columns.add('weight_band_min',      sql.Decimal(10, 2), { nullable: true });
        table.columns.add('weight_band_max',      sql.Decimal(10, 2), { nullable: true });
        table.columns.add('age_band_min',         sql.Int,            { nullable: true });
        table.columns.add('age_band_max',         sql.Int,            { nullable: true });
        table.columns.add('vehicle_age_min',      sql.Int,            { nullable: true });
        table.columns.add('vehicle_age_max',      sql.Int,            { nullable: true });
        table.columns.add('volume_tier',          sql.VarChar(100),   { nullable: true });
        table.columns.add('addon',                sql.VarChar(50),    { nullable: true });
        table.columns.add('carrier_type',         sql.VarChar(100),   { nullable: true });
        table.columns.add('rate_type',            sql.VarChar(50),    { nullable: true });
        table.columns.add('rate_value',           sql.Decimal(10, 4), { nullable: true });
        table.columns.add('is_declined',          sql.Bit,            { nullable: true });
        table.columns.add('rate_text',            sql.VarChar(500),   { nullable: true });
        table.columns.add('is_conditional',       sql.Bit,            { nullable: true });
        table.columns.add('seating_capacity_min', sql.Int,            { nullable: true });
        table.columns.add('seating_capacity_max', sql.Int,            { nullable: true });
        table.columns.add('remarks',              sql.VarChar(500),   { nullable: true });
        table.columns.add('discount_pct',         sql.Decimal(5, 2),  { nullable: true });

        for (const rule of slice) {
          table.rows.add(
            rateCardId,
            truncate(rule.insurer || insurer, 100),
            truncate(rule.product, 100),
            truncate(rule.sheetName || rule.sheet_name, 200),
            truncate(rule.region, 200),
            truncate(rule.segment, 300),
            truncate(rule.make, 200),
            truncate(rule.model, 200),
            truncate(rule.sub_type, 100),
            truncate(rule.state, 200),
            truncate(rule.applied_on, 10),
            truncate(rule.fuel_type, 50),
            intOrNull(rule.cc_band_min),
            intOrNull(rule.cc_band_max),
            num(rule.weight_band_min),
            num(rule.weight_band_max),
            intOrNull(rule.age_band_min),
            intOrNull(rule.age_band_max),
            intOrNull(rule.vehicle_age_min),
            intOrNull(rule.vehicle_age_max),
            truncate(rule.volume_tier, 100),
            truncate(rule.addon, 50),
            truncate(rule.carrier_type, 100),
            truncate(rule.rate_type, 50),
            num(rule.rate_value),
            rule.is_declined ? 1 : 0,
            truncate(rule.rate_text, 500),
            rule.is_conditional ? 1 : 0,
            intOrNull(rule.seating_capacity_min),
            intOrNull(rule.seating_capacity_max),
            truncate(rule.remarks, 500),
            num(rule.discount_pct)
          );
        }

        const req = pool.request();
        await req.bulk(table);
        console.log(`[RateExtract] bulk-inserted ${slice.length} rate_rules (${Math.min(i + slice.length, bulkRules.length)}/${bulkRules.length})`);
      }
    }

    // 4. Insert conditional_rates
    if (conditionalEntries.length > 0) {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        for (const { ruleId, entries } of conditionalEntries) {
          for (const entry of entries) {
            await new sql.Request(transaction)
              .input('rate_rule_id', sql.Int, ruleId)
              .input('condition_type', sql.NVarChar, entry.condition_type)
              .input('condition_min', sql.Int, entry.condition_min ?? null)
              .input('condition_max', sql.Int, entry.condition_max ?? null)
              .input('condition_text', sql.NVarChar, entry.condition_text)
              .input('rate_value', sql.Decimal(10, 4), entry.rate_value)
              .query(
                `INSERT INTO conditional_rates
                 (rate_rule_id, condition_type, condition_min, condition_max, condition_text, rate_value)
                 VALUES (@rate_rule_id, @condition_type, @condition_min, @condition_max, @condition_text, @rate_value)`
              );
          }
        }
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    }

    // 5. Bulk-insert RTO mappings via TDS bulk-load.
    let rtoCount = 0;
    if (rtoRules.length > 0) {
      const trunc = (v, n) => v == null ? null : (String(v).length > n ? String(v).slice(0, n) : String(v));
      for (let i = 0; i < rtoRules.length; i += 5000) {
        const slice = rtoRules.slice(i, i + 5000);
        const table = new sql.Table('rto_mappings');
        table.columns.add('rate_card_id', sql.Int,          { nullable: true });
        table.columns.add('insurer',      sql.VarChar(100), { nullable: true });
        table.columns.add('product',      sql.VarChar(100), { nullable: true });
        table.columns.add('rto_code',     sql.VarChar(20),  { nullable: true });
        table.columns.add('region',       sql.VarChar(200), { nullable: true });
        table.columns.add('cluster',      sql.VarChar(200), { nullable: true });
        for (const rto of slice) {
          table.rows.add(
            rateCardId,
            trunc(rto.insurer || insurer, 100),
            trunc(rto.product, 100),
            trunc(rto.rto_code, 20),
            trunc(rto.region, 200),
            trunc(rto.cluster, 200)
          );
        }
        await pool.request().bulk(table);
        rtoCount += slice.length;
      }
      console.log(`[RateExtract] bulk-inserted ${rtoCount} rto_mappings`);
    }

    const response = {
      success: true,
      rate_card_id: rateCardId,
      rules_count: rateRules.length,
      rto_count: rtoCount,
    };

    // 6. Dynamic parse profiles (self-describing ingestion). For EVERY upload we
    //    detect a layout per sheet (flat | matrix unpivot), score its health, and
    //    persist a reproducible, human-reviewable parse profile. Low-confidence /
    //    low-coverage sheets are flagged `needs_review` so a drifted layout is
    //    surfaced instead of silently mis-parsed. When there is no hand config (or
    //    the config parse produced nothing), the dynamic engine BECOMES the parser
    //    for the high-confidence sheets — so unknown/reshuffled grids still ingest.
    try {
      const pp = require('../services/parse-profile');
      const { routeAndIngest } = require('../services/doc-router');
      // Classify every sheet: RTO master → rto_mappings, fleet approval →
      // fleet_overrides, enabler → enabler_overrides. Rate/unknown sheets stay on
      // the dynamic parse-profile path (rate_rules). Handles workbooks that are
      // actually RTO masters / fleet lists, not rate grids.
      const allSheets = pp.readSheets(filePath);
      const routed = await routeAndIngest(pool, rateCardId, allSheets, { insurer, sourceFile: fileName });
      const generated = pp.profileSheets(routed.rateSheets, { insurer });
      await pp.persistProfiles(pool, rateCardId, filePath, generated.map(({ rows, ...g }) => g), { insurer });
      if (insurerConfig.auto_generated || rateRules.length === 0) {
        const dynCount = await pp.insertAutoRulesFromGenerated(pool, rateCardId, insurer, generated, null);
        if (dynCount > 0) {
          response.dynamic_rules_count = dynCount;
          response.rules_count = dynCount;
        }
      }
      if (routed.counts.rto_map || routed.counts.fleet || routed.counts.enabler) response.routed = routed.counts;
      response.classified = routed.classified;
      response.parse_profiles = {
        total: generated.length,
        auto: generated.filter((g) => g.status === 'auto').length,
        needs_review: generated.filter((g) => g.status === 'needs_review').map((g) => g.sheet_name),
        sheets: generated.map((g) => ({
          sheet: g.sheet_name, layout: g.profile.layout, confidence: g.profile.confidence,
          coverage: g.health.coverage, rules: g.health.rulesOut, status: g.status,
        })),
      };
    } catch (e) {
      console.warn('[upload] parse-profile step skipped:', e.message);
      response.parse_profiles = { error: e.message };
    }

    // 7. Rule counts by vehicle type (product) and cover — a post-upload summary
    //    so the operator immediately sees WHAT was ingested (e.g. GCV 656, PCV 210).
    try {
      const cnt = await pool.request().input('cid', sql.Int, rateCardId).query(`
        SELECT ISNULL(NULLIF(product, ''), '(unset)') AS product,
               ISNULL(NULLIF(rate_type, ''), '(none)') AS cover,
               COUNT(*) AS n
        FROM rate_rules WHERE rate_card_id = @cid
        GROUP BY ISNULL(NULLIF(product, ''), '(unset)'), ISNULL(NULLIF(rate_type, ''), '(none)')`);
      const byProduct = {};
      for (const row of cnt.recordset) {
        const p = (byProduct[row.product] = byProduct[row.product] || { total: 0, covers: {} });
        p.total += row.n; p.covers[row.cover] = (p.covers[row.cover] || 0) + row.n;
      }
      response.rule_counts = {
        total: Object.values(byProduct).reduce((a, p) => a + p.total, 0),
        by_product: Object.entries(byProduct)
          .sort((a, b) => b[1].total - a[1].total)
          .map(([product, v]) => ({ product, total: v.total, covers: v.covers })),
      };
    } catch (e) { response.rule_counts = { error: e.message }; }

    // Validate the just-ingested card so a bad parse (0 rules / scratch sheet /
    // scrambled columns / mostly-zero) is flagged at the door, not weeks later.
    try { response.validation = await validateCard(pool, rateCardId); }
    catch (e) { response.validation = { error: e.message }; }

    // Refresh any generically-handled flat grids for this insurer from the same
    // workbook (config/flat_grids/<slug>.json) — so a re-upload auto-updates the
    // grid data the resolver uses; no code change per month.
    try {
      const { refreshFromWorkbook } = require('../services/flat-grid');
      const fg = refreshFromWorkbook(insurer, filePath);
      if (fg.length) response.flat_grids = fg;
    } catch (_) { /* best effort */ }

    // If config was auto-generated, include info about detected sheets
    if (insurerConfig.auto_generated) {
      response.auto_generated = true;
      response.detected_sheets = insurerConfig.sheets.map(s => ({
        name: s.name,
        headers: (s.config._detected_headers || []).map(h => h.name),
      }));
      response.message = `Config auto-generated for "${insurer}". ${rateRules.length} rules parsed with basic detection. Review config/insurers/${insurer}.json to tune column mappings for better accuracy.`;
    }

    res.json(response);
  } catch (err) {
    next(err);
  }
});

/** GET /validate/:cardId — re-run validation on an already-uploaded card. */
router.get('/validate/:cardId(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    const v = await validateCard(pool, Number(req.params.cardId));
    res.json({ success: true, validation: v });
  } catch (err) { next(err); }
});

/**
 * GET /rate-cards
 * List all uploaded rate cards.
 */
router.get('/rate-cards', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT * FROM rate_cards ORDER BY uploaded_at DESC');
    res.json({ success: true, rate_cards: result.recordset });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /coverage-matrix
 * Insurer × effective-month coverage so the user can spot gaps. Each cell
 * carries the number of rate cards uploaded for that insurer/month and the
 * total rate rules across them (a card with rules=0 = uploaded but parsed
 * nothing). Months derived from rate_cards.effective_from.
 */
router.get('/coverage-matrix', async (req, res, next) => {
  try {
    const pool = await getPool();
    // Cards per insurer per effective-month.
    const cards = await pool.request().query(`
      SELECT insurer,
             CONVERT(char(7), effective_from, 126) AS ym,
             COUNT(*) AS cards
      FROM rate_cards
      WHERE effective_from IS NOT NULL
      GROUP BY insurer, CONVERT(char(7), effective_from, 126)`);
    // Rule totals per insurer per effective-month (join kept light via group).
    const rules = await pool.request().query(`
      SELECT c.insurer,
             CONVERT(char(7), c.effective_from, 126) AS ym,
             COUNT(r.id) AS rules
      FROM rate_cards c
      INNER JOIN rate_rules r ON r.rate_card_id = c.id
      WHERE c.effective_from IS NOT NULL
      GROUP BY c.insurer, CONVERT(char(7), c.effective_from, 126)`);

    const ruleMap = new Map();
    for (const r of rules.recordset) ruleMap.set(r.insurer + '|' + r.ym, r.rules);

    const months = new Set();
    const byInsurer = new Map();
    for (const c of cards.recordset) {
      months.add(c.ym);
      if (!byInsurer.has(c.insurer)) byInsurer.set(c.insurer, {});
      byInsurer.get(c.insurer)[c.ym] = {
        cards: c.cards,
        rules: ruleMap.get(c.insurer + '|' + c.ym) || 0,
      };
    }
    const monthList = [...months].sort();
    const rows = [...byInsurer.entries()]
      .map(([insurer, cells]) => ({ insurer, cells }))
      .sort((a, b) => a.insurer.localeCompare(b.insurer));

    res.json({ success: true, months: monthList, rows });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /rate-cards/:id
 * Delete a rate card and all associated data.
 */
router.delete('/rate-cards/:id', async (req, res, next) => {
  try {
    const rateCardId = parseInt(req.params.id, 10);
    if (isNaN(rateCardId)) {
      return res.status(400).json({ success: false, error: 'Invalid rate card ID' });
    }

    const pool = await getPool();

    // Delete in order: conditional_rates -> rate_rules -> rto_mappings -> rate_cards
    await pool
      .request()
      .input('id', sql.Int, rateCardId)
      .query(
        `DELETE cr FROM conditional_rates cr
         INNER JOIN rate_rules rr ON cr.rate_rule_id = rr.id
         WHERE rr.rate_card_id = @id`
      );

    await pool
      .request()
      .input('id', sql.Int, rateCardId)
      .query('DELETE FROM rate_rules WHERE rate_card_id = @id');

    await pool
      .request()
      .input('id', sql.Int, rateCardId)
      .query('DELETE FROM rto_mappings WHERE rate_card_id = @id');

    await pool
      .request()
      .input('id', sql.Int, rateCardId)
      .query('DELETE FROM rate_cards WHERE id = @id');

    res.json({ success: true, deleted: rateCardId });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /rate-cards/:id/clone
 * Clone an existing rate card into a new month, copying all rate_rules
 * and rto_mappings.  Used when an insurer says "April rates same as
 * March" — instead of re-uploading the same file, the user clicks
 * "Copy to next month" and supplies the new effective_from date.
 *
 * Body: { effective_from: "YYYY-MM-DD" }
 *
 * Behaviour:
 *   1. Closes out the source card by setting effective_to = new
 *      effective_from (so it stops being current).  Same close-out rule
 *      as a fresh upload.
 *   2. Inserts a new rate_cards row with file_name suffixed by
 *      " (cloned from #N)" and effective_to NULL (open-ended).
 *   3. Copies rate_rules with INSERT ... SELECT under the new card_id.
 *   4. Copies rto_mappings the same way.
 *
 * Returns the new rate_card_id and counts.
 */
router.post('/rate-cards/:id/clone', async (req, res, next) => {
  try {
    const sourceId = parseInt(req.params.id, 10);
    if (isNaN(sourceId)) {
      return res.status(400).json({ success: false, error: 'Invalid rate card ID' });
    }
    const { effective_from } = req.body || {};
    if (!effective_from) {
      return res.status(400).json({ success: false, error: 'Missing required field: effective_from' });
    }
    const newDate = new Date(effective_from);
    if (isNaN(newDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date: effective_from' });
    }

    const pool = await getPool();

    // Look up source card
    const srcRes = await pool
      .request()
      .input('id', sql.Int, sourceId)
      .query('SELECT id, insurer, file_name FROM rate_cards WHERE id = @id');
    if (srcRes.recordset.length === 0) {
      return res.status(404).json({ success: false, error: `Rate card #${sourceId} not found` });
    }
    const src = srcRes.recordset[0];

    // 1. Close out previously-active cards (same logic as fresh upload)
    await pool
      .request()
      .input('insurer', sql.NVarChar, src.insurer)
      .input('effective_from', sql.Date, newDate)
      .query(
        `UPDATE rate_cards
            SET effective_to = @effective_from
          WHERE insurer = @insurer
            AND effective_to IS NULL
            AND effective_from < @effective_from`
      );

    // 2. Insert new rate_card (clone marker in file_name)
    const newName = `${src.file_name} (cloned from #${sourceId})`;
    const insRes = await pool
      .request()
      .input('insurer', sql.NVarChar, src.insurer)
      .input('file_name', sql.NVarChar, newName)
      .input('effective_from', sql.Date, newDate)
      .query(
        `INSERT INTO rate_cards (insurer, file_name, effective_from)
         OUTPUT INSERTED.id
         VALUES (@insurer, @file_name, @effective_from)`
      );
    const newId = insRes.recordset[0].id;

    // 3. Copy rate_rules.  Explicit column list so IDENTITY (id) is
    //    auto-assigned and the new rate_card_id replaces the old one.
    const rrRes = await pool
      .request()
      .input('newId', sql.Int, newId)
      .input('srcId', sql.Int, sourceId)
      .query(
        `INSERT INTO rate_rules (
           rate_card_id, insurer, product, sheet_name, region, segment,
           make, model, sub_type, fuel_type,
           cc_band_min, cc_band_max,
           weight_band_min, weight_band_max,
           age_band_min, age_band_max,
           vehicle_age_min, vehicle_age_max,
           seating_capacity_min, seating_capacity_max,
           volume_tier, addon, carrier_type,
           rate_type, rate_value, rate_text,
           is_declined, is_conditional, remarks
         )
         SELECT
           @newId, insurer, product, sheet_name, region, segment,
           make, model, sub_type, fuel_type,
           cc_band_min, cc_band_max,
           weight_band_min, weight_band_max,
           age_band_min, age_band_max,
           vehicle_age_min, vehicle_age_max,
           seating_capacity_min, seating_capacity_max,
           volume_tier, addon, carrier_type,
           rate_type, rate_value, rate_text,
           is_declined, is_conditional, remarks
         FROM rate_rules
         WHERE rate_card_id = @srcId`
      );

    // 4. Copy rto_mappings
    const rtoRes = await pool
      .request()
      .input('newId', sql.Int, newId)
      .input('srcId', sql.Int, sourceId)
      .query(
        `INSERT INTO rto_mappings (rate_card_id, insurer, product, rto_code, region, cluster)
         SELECT @newId, insurer, product, rto_code, region, cluster
         FROM rto_mappings
         WHERE rate_card_id = @srcId`
      );

    res.json({
      success: true,
      source_card_id: sourceId,
      new_card_id: newId,
      rate_rules_copied: rrRes.rowsAffected[0] || 0,
      rto_mappings_copied: rtoRes.rowsAffected[0] || 0,
      effective_from,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
