'use strict';

/**
 * Parse-profile orchestration (dynamic, self-describing grid ingestion).
 *
 * At upload we build a PARSE PROFILE per sheet (via grid-schema-resolver), score
 * its health, and persist it. High-confidence sheets parse automatically; low
 * ones are flagged `needs_review` so a human confirms/corrects the detected
 * column→role map (or matrix descriptor) in the UI instead of the engine
 * silently producing null-heavy junk. A stored profile can be re-parsed anytime.
 */
const fs = require('fs');
const sql = require('mssql');
const XLSX = require('xlsx');
const { buildProfile, profileHealth, parseWithProfile } = require('./grid-schema-resolver');

// Gate thresholds — below either, the sheet is flagged for human review.
const GATE = { confidence: 0.6, coverage: 0.5 };

/** Read a workbook's sheets as row-arrays. Supports xlsx/xls/xlsb. */
function readSheets(filePath) {
  const wb = XLSX.readFile(filePath);
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }),
  }));
}

/**
 * Read the rows for ONE profile's sheet from its source file — workbook OR email.
 * Email sheet names are 'Email Table N' (inline table) or 'attach:<file>:<sheet>'
 * (spreadsheet attachment); we re-extract them so the review UI / re-parse works
 * for email-derived profiles just like workbook ones.
 */
async function readProfileRows(sourcePath, sheetName) {
  if (/\.(eml|msg)$/i.test(sourcePath)) {
    const { extractEmail } = require('./email-extract');
    const info = await extractEmail(sourcePath);
    let m = /^Email Table (\d+)$/.exec(sheetName);
    if (m) return info.tables[Number(m[1]) - 1] || [];
    m = /^attach:(.+):([^:]+)$/.exec(sheetName);
    if (m) {
      const a = (info.attachments || []).find((x) => x.filename === m[1]);
      if (a && a.buffer) { const wb = XLSX.read(a.buffer, { type: 'buffer' }); return XLSX.utils.sheet_to_json(wb.Sheets[m[2]], { header: 1, defval: '' }); }
      return [];
    }
    return [];
  }
  const wb = XLSX.readFile(sourcePath);
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error('sheet not found: ' + sheetName);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

/** auto vs needs_review from health + confidence. */
function gateStatus(profile, health) {
  if ((profile.confidence || 0) < GATE.confidence) return 'needs_review';
  if ((health.coverage || 0) < GATE.coverage) return 'needs_review';
  if ((health.rulesOut || 0) === 0) return 'needs_review';
  return 'auto';
}

/**
 * Build + score a profile for a list of already-extracted sheets
 * ([{ name, rows }]). Shared by workbook uploads AND email (inline-table /
 * attachment) ingestion. Returns [{ sheet_name, profile, health, status }].
 * Sheets < 3 rows are skipped; anything that yields 0 rules is still recorded
 * (needs_review) so nothing is silently dropped.
 */
function profileSheets(sheets, opts = {}) {
  const { insurer, product } = opts;
  const out = [];
  for (const { name, rows } of sheets) {
    if (!rows || rows.length < 3) continue;
    let profile, health, status;
    try {
      profile = buildProfile(rows, { sheet_name: name });
      health = profileHealth(rows, profile, { insurer, product });
      status = gateStatus(profile, health);
    } catch (e) {
      profile = { layout: 'flat', header_row: 0, roles: {}, headers: [], confidence: 0, notes: ['parse error: ' + e.message], rate_divisor: 100, sheet_name: name };
      health = { dataRows: rows.length, rulesOut: 0, coverage: 0, emptyRatePct: 1, confidence: 0 };
      status = 'needs_review';
    }
    out.push({ sheet_name: name, profile, health, status, rows });
  }
  return out;
}

/** Build + score a profile for every non-trivial sheet of a workbook file. */
function generateProfiles(filePath, opts = {}) {
  return profileSheets(readSheets(filePath), opts).map(({ rows, ...g }) => g);
}

/** Replace all stored profiles for a card with a freshly-generated set. */
async function persistProfiles(pool, cardId, sourcePath, generated, opts = {}) {
  const { insurer, product } = opts;
  await pool.request().input('cid', sql.Int, cardId)
    .query('DELETE FROM card_parse_profiles WHERE rate_card_id = @cid');
  for (const g of generated) {
    await pool.request()
      .input('cid', sql.Int, cardId)
      .input('insurer', sql.NVarChar, insurer || null)
      .input('product', sql.NVarChar, product || null)
      .input('sheet', sql.NVarChar, g.sheet_name || null)
      .input('path', sql.NVarChar, sourcePath || null)
      .input('layout', sql.NVarChar, g.profile.layout || 'flat')
      .input('pjson', sql.NVarChar, JSON.stringify(g.profile))
      .input('conf', sql.Float, g.profile.confidence ?? null)
      .input('cov', sql.Float, g.health.coverage ?? null)
      .input('empty', sql.Float, g.health.emptyRatePct ?? null)
      .input('drows', sql.Int, g.health.dataRows ?? null)
      .input('rout', sql.Int, g.health.rulesOut ?? null)
      .input('status', sql.NVarChar, g.status)
      .input('notes', sql.NVarChar, (g.profile.notes || []).join('; ') || null)
      .query(`INSERT INTO card_parse_profiles
        (rate_card_id, insurer, product, sheet_name, source_path, layout, profile_json,
         confidence, coverage, empty_rate_pct, data_rows, rules_out, status, notes)
        VALUES (@cid, @insurer, @product, @sheet, @path, @layout, @pjson,
         @conf, @cov, @empty, @drows, @rout, @status, @notes)`);
  }
}

/** Load stored profiles for a card (parsed profile_json attached as .profile). */
async function loadProfiles(pool, cardId) {
  const r = await pool.request().input('cid', sql.Int, cardId)
    .query('SELECT * FROM card_parse_profiles WHERE rate_card_id = @cid ORDER BY id');
  return r.recordset.map(hydrate);
}

async function loadProfile(pool, profileId) {
  const r = await pool.request().input('id', sql.Int, profileId)
    .query('SELECT * FROM card_parse_profiles WHERE id = @id');
  return r.recordset[0] ? hydrate(r.recordset[0]) : null;
}

function hydrate(row) {
  let profile = {};
  try { profile = JSON.parse(row.profile_json || '{}'); } catch (_) {}
  return { ...row, profile };
}

// rate_rules columns we populate from a dynamic rule object.
function bindRule(reqt, cardId, insurer, sheetName, rule) {
  return reqt
    .input('rate_card_id', sql.Int, cardId)
    .input('insurer', sql.NVarChar, rule.insurer || insurer)
    .input('product', sql.NVarChar, rule.product || null)
    .input('sheet_name', sql.NVarChar, rule.sheet_name || sheetName || null)
    .input('region', sql.NVarChar, rule.region || null)
    .input('segment', sql.NVarChar, rule.segment || null)
    .input('make', sql.NVarChar, rule.make || null)
    .input('sub_type', sql.NVarChar, rule.sub_type || null)
    .input('applied_on', sql.NVarChar, rule.applied_on || null)
    .input('fuel_type', sql.NVarChar, rule.fuel_type || null)
    .input('cc_band_min', sql.Int, rule.cc_band_min ?? null)
    .input('cc_band_max', sql.Int, rule.cc_band_max ?? null)
    .input('weight_band_min', sql.Decimal(10, 2), rule.weight_band_min ?? null)
    .input('weight_band_max', sql.Decimal(10, 2), rule.weight_band_max ?? null)
    .input('vehicle_age_min', sql.Int, rule.vehicle_age_min ?? null)
    .input('vehicle_age_max', sql.Int, rule.vehicle_age_max ?? null)
    .input('seating_capacity_min', sql.Int, rule.seating_capacity_min ?? null)
    .input('seating_capacity_max', sql.Int, rule.seating_capacity_max ?? null)
    .input('rate_type', sql.NVarChar, rule.rate_type || null)
    .input('rate_value', sql.Decimal(10, 4), rule.rate_value ?? null)
    .input('is_declined', sql.Bit, rule.is_declined ? 1 : 0)
    .input('remarks', sql.NVarChar, rule.remarks || null);
}

const INSERT_SQL = `INSERT INTO rate_rules
  (rate_card_id, insurer, product, sheet_name, region, segment, make, sub_type, applied_on,
   fuel_type, cc_band_min, cc_band_max, weight_band_min, weight_band_max,
   vehicle_age_min, vehicle_age_max, seating_capacity_min, seating_capacity_max,
   rate_type, rate_value, is_declined, remarks)
  VALUES
  (@rate_card_id, @insurer, @product, @sheet_name, @region, @segment, @make, @sub_type, @applied_on,
   @fuel_type, @cc_band_min, @cc_band_max, @weight_band_min, @weight_band_max,
   @vehicle_age_min, @vehicle_age_max, @seating_capacity_min, @seating_capacity_max,
   @rate_type, @rate_value, @is_declined, @remarks)`;

/** Insert dynamic rule objects into rate_rules (transactional, batched). */
async function insertRules(pool, cardId, insurer, sheetName, rules) {
  for (let i = 0; i < rules.length; i += 500) {
    const batch = rules.slice(i, i + 500);
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const rule of batch) await bindRule(new sql.Request(tx), cardId, insurer, sheetName, rule).query(INSERT_SQL);
      await tx.commit();
    } catch (e) { await tx.rollback(); throw e; }
  }
  return rules.length;
}

/**
 * Re-parse a single stored profile against its source file and REPLACE that
 * sheet's rate_rules on the card. Used by the review UI after a human edits the
 * mapping, and by the dynamic upload path. Returns { rulesOut, coverage }.
 */
async function reparseProfile(pool, profileRow, opts = {}) {
  const path = profileRow.source_path;
  if (!path || !fs.existsSync(path)) throw new Error('source file not found for re-parse: ' + path);
  const insurer = opts.insurer || profileRow.insurer;
  const product = opts.product || profileRow.product;
  const sheet = profileRow.sheet_name;
  const rows = await readProfileRows(path, sheet);
  const profile = opts.profile || profileRow.profile;
  const rules = parseWithProfile(rows, profile, { insurer, product, sheetName: sheet });
  const health = profileHealth(rows, profile, { insurer, product });
  // replace this sheet's rules on the card
  await pool.request()
    .input('cid', sql.Int, profileRow.rate_card_id)
    .input('sheet', sql.NVarChar, sheet)
    .query('DELETE FROM rate_rules WHERE rate_card_id = @cid AND sheet_name = @sheet');
  await insertRules(pool, profileRow.rate_card_id, insurer, sheet, rules.map((r) => ({ ...r, product: r.product || product })));
  return { rulesOut: rules.length, health, rules };
}

/**
 * Insert dynamically-parsed rules for the AUTO (high-confidence) sheets of a
 * workbook — used at upload for insurers with no hand config (or whose config
 * parse produced nothing), so unknown / format-drifted grids still ingest. Only
 * touches 'auto' sheets; 'needs_review' sheets wait for human confirmation.
 * Returns total rules inserted.
 */
async function insertAutoRules(pool, filePath, cardId, insurer, generated, product) {
  const wb = XLSX.readFile(filePath);
  let total = 0;
  for (const g of generated) {
    if (g.status !== 'auto') continue;
    const ws = wb.Sheets[g.sheet_name]; if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const rules = parseWithProfile(rows, g.profile, { insurer, product, sheetName: g.sheet_name });
    if (!rules.length) continue;
    await pool.request().input('cid', sql.Int, cardId).input('sheet', sql.NVarChar, g.sheet_name)
      .query('DELETE FROM rate_rules WHERE rate_card_id = @cid AND sheet_name = @sheet');
    // keep the per-row inferred product; fall back to the caller's product only when blank
    await insertRules(pool, cardId, insurer, g.sheet_name, rules.map((r) => ({ ...r, product: r.product || product })));
    total += rules.length;
  }
  return total;
}

/**
 * Insert dynamic rules for the AUTO sheets of an already-profiled sheet set
 * (rows in memory — used by email ingestion where there's no re-readable file
 * per table). `generated` items must carry `.rows` (profileSheets includes them).
 */
async function insertAutoRulesFromGenerated(pool, cardId, insurer, generated, product) {
  let total = 0;
  for (const g of generated) {
    if (g.status !== 'auto' || !g.rows) continue;
    const rules = parseWithProfile(g.rows, g.profile, { insurer, product, sheetName: g.sheet_name });
    if (!rules.length) continue;
    await pool.request().input('cid', sql.Int, cardId).input('sheet', sql.NVarChar, g.sheet_name)
      .query('DELETE FROM rate_rules WHERE rate_card_id = @cid AND sheet_name = @sheet');
    await insertRules(pool, cardId, insurer, g.sheet_name, rules.map((r) => ({ ...r, product: r.product || product })));
    total += rules.length;
  }
  return total;
}

module.exports = {
  GATE, readSheets, readProfileRows, gateStatus, profileSheets, generateProfiles, persistProfiles,
  loadProfiles, loadProfile, insertRules, reparseProfile, insertAutoRules,
  insertAutoRulesFromGenerated,
};
