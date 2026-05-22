/**
 * Main parser orchestrator.
 *
 * Routes sheet data to the correct layout engine based on sheetConfig.layout,
 * and provides a workbook-level entry point that reads an Excel file and
 * iterates over all configured sheets.
 */

const XLSX = require('xlsx');
const path = require('path');

// Layout engine registry
const engines = {
  wide_matrix: require('./engines/wide-matrix'),
  flat_table: require('./engines/flat-table'),
  cross_tab: require('./engines/cross-tab'),
  grouped_columns: require('./engines/grouped-columns'),
  rto_mapping: require('./engines/rto-mapping'),
  pivot_by_city: require('./engines/pivot-by-city'),
  multi_region_blocks: require('./engines/multi-region-blocks'),
  sbi_grouped:         require('./engines/sbi-grouped'),
  sbi_pvt_satp:        require('./engines/sbi-pvt-satp'),
  universal_sompo:     require('./engines/universal-sompo'),
  reliance_grid:       require('./engines/reliance-grid'),
  hdfc_grid:           require('./engines/hdfc-grid'),
  bajaj_satp:          require('./engines/bajaj-satp'),
  bajaj_pvt_car:       require('./engines/bajaj-pvt-car'),
  bajaj_robinhood:     require('./engines/bajaj-robinhood'),
  shriram_grid:        require('./engines/shriram-grid'),
  liberty_grid:        require('./engines/liberty-grid'),
  future_generali:     require('./engines/future-generali'),
};

/**
 * Parse a single sheet's data using the appropriate layout engine.
 *
 * @param {Array<Array>} sheetData - Raw rows (array of arrays) from xlsx
 * @param {object} sheetConfig - Config object for this sheet (must include `layout`)
 * @param {object} meta - { insurer, rateCardId, sheetName }
 * @returns {Array<object>} Array of normalized rule objects
 */
function parseSheet(sheetData, sheetConfig, meta) {
  const layout = sheetConfig.layout;
  const engine = engines[layout];

  if (!engine) {
    throw new Error(
      `Unknown layout engine "${layout}" for sheet "${meta.sheetName}". ` +
      `Available engines: ${Object.keys(engines).join(', ')}`
    );
  }

  return engine.parse(sheetData, sheetConfig, meta);
}

/**
 * Parse an entire workbook file using an insurer config that defines
 * which sheets to process and how.
 *
 * @param {string} filePath - Absolute path to the Excel file
 * @param {object} insurerConfig - Insurer configuration object with shape:
 *   {
 *     insurer: "Digit",
 *     rate_card_id: "digit_cv_2024",
 *     sheets: {
 *       "Sheet1": { layout: "wide_matrix", ... },
 *       "Sheet2": { layout: "flat_table", ... },
 *       ...
 *     }
 *   }
 * @returns {Array<object>} Combined array of all rules from all sheets
 */
async function parseWorkbook(filePath, insurerConfig) {
  // PDF route — when the upload is a PDF, dispatch to the per-insurer PDF
  // engine.  Each insurer that supports PDFs registers a sheet entry with
  // `layout: '<insurer>_pdf'` and a `file_pattern` matching .pdf.
  if (/\.pdf$/i.test(filePath)) {
    return await dispatchPdf(filePath, insurerConfig);
  }
  const workbook = XLSX.readFile(filePath, { type: 'file' });
  const allRules = [];
  const rawFileName = path.basename(filePath);
  // Multer saves uploads as `{timestamp}_{safename}` where spaces, `&`, `+`,
  // apostrophes etc. are replaced with `_`. Normalize so `file_pattern`
  // regexes written against the original filename still match.
  const fileName = rawFileName
    .replace(/^\d{8,}_/, '')      // strip timestamp prefix
    .replace(/_+/g, ' ')           // collapse underscore runs to a single space
    .replace(/\s+/g, ' ')          // collapse whitespace
    .trim();

  const sheetsConfig = insurerConfig.sheets || [];
  const insurer = insurerConfig.insurer || '';
  const rateCardId = insurerConfig.rate_card_id || '';

  for (const sheetEntry of sheetsConfig) {
    // Skip placeholder entries (legacy-disabled stubs) — they carry only a
    // `_comment` field, no `name`/`layout`.  These exist to preserve config
    // history without re-running the legacy parser.
    if (!sheetEntry.name && !sheetEntry.layout) continue;

    // Per-sheet file scoping: when the same sheet name appears in multiple
    // workbooks with different layouts (e.g. "PC"/"TW"/"CV" in both Robinhood
    // and SATP Corrections files for Bajaj), the entry can set `file_pattern`
    // to restrict matching to files whose name matches the given regex.
    // Matching is done against the NORMALIZED filename (timestamp stripped,
    // underscores→spaces) so patterns written against the original filename
    // also match multer-renamed uploads.
    if (sheetEntry.file_pattern) {
      try {
        const re = new RegExp(sheetEntry.file_pattern, 'i');
        if (!re.test(fileName) && !re.test(rawFileName)) continue;
      } catch (e) {
        console.warn(
          `[RateExtract] Invalid file_pattern "${sheetEntry.file_pattern}" on sheet "${sheetEntry.name}": ${e.message}`
        );
      }
    }

    const sheetName = sheetEntry.name;
    const sheetConfig = { ...sheetEntry, ...sheetEntry.config };

    // Resolve sheet name with progressively looser matching so monthly file
    // tweaks (case, whitespace) don't break uploads:
    //   1. exact match
    //   2. whitespace-collapsed, case-insensitive equality
    //   3. `name_pattern` regex (explicit opt-in by config author)
    // We deliberately do NOT do generic substring matching — that caused
    // sheet "Pvtcar" to match "RTO-PvtCar Mapper", etc. Configs that need
    // fuzz must declare it via name_pattern.
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let actualSheetName = workbook.SheetNames.find(s => s === sheetName);
    if (!actualSheetName) {
      const target = norm(sheetName);
      actualSheetName = workbook.SheetNames.find(s => norm(s) === target);
    }
    if (!actualSheetName && sheetEntry.name_pattern) {
      try {
        const re = new RegExp(sheetEntry.name_pattern, 'i');
        actualSheetName = workbook.SheetNames.find(s => re.test(s));
      } catch (e) {
        console.warn(
          `[RateExtract] Invalid name_pattern "${sheetEntry.name_pattern}" on sheet "${sheetName}": ${e.message}`
        );
      }
    }
    if (!actualSheetName) {
      console.warn(
        `[RateExtract] Sheet "${sheetName}" not found in workbook "${path.basename(filePath)}". ` +
        `Available sheets: ${workbook.SheetNames.join(', ')}`
      );
      continue;
    }
    if (actualSheetName !== sheetName) {
      console.log(
        `[RateExtract] Sheet "${sheetName}" → matched "${actualSheetName}" via fuzzy lookup.`
      );
    }

    const worksheet = workbook.Sheets[actualSheetName];
    const sheetData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
    });

    const meta = {
      insurer,
      rateCardId,
      sheetName,
    };

    try {
      let rules = parseSheet(sheetData, sheetConfig, meta);
      // Annexure RTO cross-ref: when a sheet config declares
      // `annexure_lookup` (e.g. ICICI TW New 1+5 has "Refer Annexure" cells),
      // resolve the marker against rows of an annexure sheet and attach the
      // applicable RTO codes to each matching rule's remarks.
      if (sheetConfig.annexure_lookup) {
        applyAnnexureLookup(rules, sheetConfig.annexure_lookup, workbook);
      }
      // Shriram-style metro lookup: when a rule carries `_metro_split`
      // (set by shriram-grid for "METRO 40 & NON METRO 35" cells), expand
      // it into one row per metro city (with that city's RTO codes) plus
      // a single non-metro row.
      if (sheetConfig.metro_lookup) {
        rules = applyShriramMetroLookup(rules, sheetConfig.metro_lookup, workbook);
      }
      allRules.push(...rules);
    } catch (err) {
      console.error(
        `[RateExtract] Error parsing sheet "${sheetName}" in "${path.basename(filePath)}":`,
        err.message
      );
    }
  }

  return allRules;
}

/**
 * Dispatch a PDF upload to the engine declared in the insurer config.
 * Looks up the first sheet entry whose layout ends with `_pdf` (e.g.
 * `future_generali_pdf`) and calls its `parsePdfFile(filePath)`.
 */
async function dispatchPdf(filePath, insurerConfig) {
  const sheetsConfig = insurerConfig.sheets || [];
  const pdfEntry = sheetsConfig.find(s => /_pdf$/i.test(String(s.layout || '')));
  if (!pdfEntry) {
    console.warn(`[RateExtract] PDF uploaded but no PDF layout in config for ${insurerConfig.insurer}`);
    return [];
  }
  const engineName = String(pdfEntry.config?.engine || pdfEntry.layout).replace(/_pdf$/, '-pdf');
  try {
    const pdfEngine = require('./engines/' + engineName);
    if (!pdfEngine.parsePdfFile) {
      console.warn(`[RateExtract] PDF engine "${engineName}" missing parsePdfFile()`);
      return [];
    }
    const rules = await pdfEngine.parsePdfFile(filePath);
    return rules || [];
  } catch (err) {
    console.error(`[RateExtract] PDF engine "${engineName}" failed:`, err.message);
    return [];
  }
}

/**
 * Resolve "Refer Annexure" cells against a separate annexure sheet.
 *
 * The annexure sheet rows are columnar: state, body_type, make → rto_codes.
 * For each rule whose `rate_text` contains the marker phrase, find the
 * annexure row matching (rule.region/state, segment body, make) and
 * append the carve-out RTO list to rule.remarks.
 *
 * Used by ICICI TW New 1+5 to expand cells like
 *   "30%** selected RTOs only. Refer Annexure"
 * → rate_value = 0.30, remarks += "| Only for AP02, AP05, ..."
 */
function applyAnnexureLookup(rules, cfg, workbook) {
  const sheet = workbook.Sheets[cfg.sheet];
  if (!sheet) {
    console.warn(`[RateExtract] annexure_lookup: sheet "${cfg.sheet}" not found`);
    return;
  }
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const dataStart = cfg.data_start_row != null ? cfg.data_start_row : 1;
  const stateCol = cfg.match.state_col;
  const bodyCol  = cfg.match.body_col;
  const makeCol  = cfg.match.make_col;
  const rtoCol   = cfg.rto_col;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const lookup = new Map();
  for (let r = dataStart; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const state = norm(row[stateCol]);
    const body  = norm(row[bodyCol]);
    const make  = norm(row[makeCol]);
    const rto   = String(row[rtoCol] || '').replace(/^\s*Only\s*applicable\s*for\s*:\s*/i, '').trim();
    if (!state || !body || !make || !rto) continue;
    lookup.set(`${state}|${body}|${make}`, rto);
  }
  // Make-name aliases used by the main grid (display label) → annexure
  // raw label.  Annexure uses HMC / HMSI / RE; main grid uses the
  // display-friendly forms.
  const makeAliases = {
    'heromotocorp': 'hmc',
    'honda': 'hmsi',
    'royalenfield': 'royalenfield',
    're': 'royalenfield',
    'suzuki': 'suzuki', 'tvs': 'tvs', 'yamaha': 'yamaha',
  };
  const marker = String(cfg.marker || 'Refer Annexure').toLowerCase();
  for (const rule of rules) {
    const rt = String(rule.rate_text || '');
    if (!rt.toLowerCase().includes(marker)) continue;
    // Extract numeric rate from the cell text (e.g. "30%** selected ...")
    const m = rt.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m && rule.rate_value == null) rule.rate_value = parseFloat(m[1]) / 100;
    // Determine body type: bike vs scooter from segment text
    const segLower = String(rule.segment || '').toLowerCase();
    let body = '';
    if (/scooter/.test(segLower)) body = 'scooter';
    else if (/bike/.test(segLower)) body = 'bike';
    const stateKey = norm(rule.region || rule.remarks || '');
    const makeRaw  = norm(rule.make || '');
    const makeKey  = makeAliases[makeRaw] || makeRaw;
    const key = `${stateKey}|${body}|${makeKey}`;
    const rto = lookup.get(key);
    if (rto) {
      const hint = `Only for ${rto}`;
      rule.remarks = rule.remarks ? `${rule.remarks} | ${hint}` : hint;
    }
  }
}

/**
 * Read Shriram's "Metro RTO Codes" sheet and expand any rule tagged with
 * `_metro_split` into per-city + non-metro variants.
 *
 * The metro sheet has a 3-column-group layout (city headers in row 0,
 * "RTO CODE | RTO NAME" sub-headers in row 1, then 2-col groups separated
 * by blank columns). Each city group looks like:
 *
 *     "Bangalore Metro RTO codes"  ""  ""  "Chennai METRO RTO"  …
 *     "RTO CODE"  "RTO NAME"        ""  "RTO CODE"  "RTO NAME"   …
 *     "KA-01"     "BANGALORE..."    ""  "TN-01"     "Chennai..."  …
 *
 * Returns a Map<cityLabel, { state, rto_codes:[] }>.
 */
function _readMetroSheet(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) {
    console.warn(`[metro] sheet "${sheetName}" not found`);
    return new Map();
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (aoa.length < 3) return new Map();
  // Find city header positions in row 0 (cells with text containing "Metro" or "METRO").
  const headerRow = aoa[0] || [];
  const cityCols = []; // { col, label }
  for (let c = 0; c < headerRow.length; c++) {
    const v = String(headerRow[c] || '').trim();
    if (v && /metro/i.test(v)) cityCols.push({ col: c, label: v });
  }
  // Heuristic state-from-city map (covers the common Indian metro labels).
  const cityToState = {
    bangalore: 'Karnataka', bengaluru: 'Karnataka',
    chennai: 'Tamil Nadu',
    hyderabad: 'Telangana', secunderabad: 'Telangana',
    mumbai: 'Maharashtra', pune: 'Maharashtra',
    delhi: 'Delhi', ncr: 'Delhi',
    kolkata: 'West Bengal', calcutta: 'West Bengal',
    ahmedabad: 'Gujarat', surat: 'Gujarat',
    jaipur: 'Rajasthan',
    kochi: 'Kerala', cochin: 'Kerala',
  };
  const out = new Map();
  for (const { col, label } of cityCols) {
    const cityName = label.replace(/metro\s*rto\s*codes?/i, '').replace(/metro\s*rto/i, '').trim();
    const cityKey = cityName.toLowerCase().split(/\s+/)[0];
    const state = cityToState[cityKey] || '';
    const codes = new Set();
    for (let r = 2; r < aoa.length; r++) {
      const raw = String((aoa[r] || [])[col] || '').trim();
      if (!raw) continue;
      // Normalise "KA-01" / "KA 01" → "KA01".
      const norm = raw.replace(/\b([A-Z]{2,3})[\s-]+(\d{1,3})\b/g, '$1$2').toUpperCase();
      const m = norm.match(/[A-Z]{2,3}\d{1,3}/g);
      if (m) for (const c of m) codes.add(c);
    }
    if (codes.size > 0) {
      out.set(cityName, { state, rto_codes: [...codes] });
    }
  }
  return out;
}

function applyShriramMetroLookup(rules, cfg, workbook) {
  const sheetName = cfg && cfg.sheet ? cfg.sheet : 'Metro RTO Codes';
  const metro = _readMetroSheet(workbook, sheetName);
  if (metro.size === 0) return rules;
  // Flatten ALL metro RTO codes for the non-metro complement marker.
  const allMetroCodes = new Set();
  for (const { rto_codes } of metro.values()) for (const c of rto_codes) allMetroCodes.add(c);

  const out = [];
  for (const r of rules) {
    if (!r._metro_split) { out.push(r); continue; }
    const { metro_rate, non_metro_rate } = r._metro_split;
    // One row per metro city — preserves the city in remarks/region and
    // tags RTOCode column via the `[RTO: ...]` marker that ruleToRow extracts.
    for (const [city, info] of metro.entries()) {
      const cityRow = { ...r };
      delete cityRow._metro_split;
      cityRow.rate_value = metro_rate;
      cityRow.region = info.state || cityRow.region;
      cityRow.remarks = `[RTO: ${info.rto_codes.join(', ')}] | ${city} (METRO ${metro_rate}%)`;
      out.push(cityRow);
    }
    // One non-metro row at the lower rate. RTOCode column shows
    // "Non-Metro" as the cluster marker.
    const nm = { ...r };
    delete nm._metro_split;
    nm.rate_value = non_metro_rate;
    nm.remarks = `[RTO: Non-Metro] | NON-METRO ${non_metro_rate}%`;
    out.push(nm);
  }
  return out;
}

module.exports = { parseSheet, parseWorkbook };
