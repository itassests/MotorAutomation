'use strict';

/**
 * doc-router.js — classify an uploaded/extracted TABLE by what it actually is,
 * and convert it to rows for the right destination table. Operators send many
 * document types through the same upload: rate grids, RTO masters, fleet
 * approvals, enablers. Forcing them all into rate_rules makes junk; this routes
 * each to its home.
 *
 *   classifyTable(rows, {subject}) → { type, headerRow, cols, confidence, note }
 *      type ∈ 'rate' | 'rto_map' | 'fleet' | 'enabler' | 'unknown'
 *   toRtoMappings(rows, cls, opts) → [{ rto_code, region, cluster }]
 *   toFleetOverrides(rows, cls, opts) → [{ customer_name, rate_pct, vehicle_type, fleet_name }]
 *   toEnablerRows(rows, cls) → [{ rto_location, transaction_type, make, coa_pct, discount_pct, payout_pct }]
 */

function cell(v) { return v == null ? '' : String(v).trim(); }
function isNumericish(v) { const s = cell(v).replace(/[%,\s]/g, ''); return s !== '' && Number.isFinite(Number(s)); }
function numVal(v) { const s = cell(v).replace(/[%,\s]/g, ''); return Number(s); }

// RTO code like "GJ01", "MH2", "DD09", "DN03", "TN-Chennai"? → strict code pattern.
const RTO_CODE_RE = /^[A-Z]{2}[- ]?\d{1,3}$/i;
// A cell that is a list of RTO codes ("DD01,DN03,DN08") also counts.
const RTO_LIST_RE = /^([A-Z]{2}[- ]?\d{1,3})(\s*[,/]\s*[A-Z]{2}[- ]?\d{1,3})*$/i;

function detectHeaderRow(rows, limit = 15) {
  let best = 0, bestScore = -1;
  for (let r = 0; r < Math.min(limit, rows.length); r++) {
    const cells = (rows[r] || []).map(cell);
    const nonEmpty = cells.filter((c) => c !== '').length;
    if (nonEmpty < 2) continue;
    // header rows are mostly text, few pure numbers
    const textCells = cells.filter((c) => c !== '' && !isNumericish(c)).length;
    if (textCells > bestScore) { bestScore = textCells; best = r; }
  }
  return best;
}

function colValues(rows, c, headerRow) {
  const out = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const v = cell((rows[r] || [])[c]);
    if (v !== '') out.push(v);
  }
  return out;
}

/**
 * Classify a table. Priority: fleet (tracker+customer) → enabler (IMD/COA/…) →
 * rto_map (rto codes + region, no rate) → rate (a rate column present) → unknown.
 */
function classifyTable(rows, opts = {}) {
  if (!rows || rows.length < 2) return { type: 'unknown', headerRow: 0, cols: {}, confidence: 0, note: 'too few rows' };
  const headerRow = detectHeaderRow(rows);
  const headers = (rows[headerRow] || []).map((h) => cell(h).toLowerCase());
  const subject = String(opts.subject || '').toLowerCase();
  const nCols = headers.length;
  const H = headers.join(' | ');

  const find = (re) => headers.findIndex((h) => re.test(h));
  // column with mostly RTO-code values
  let rtoCodeCol = find(/rto[\s_]*code|^rto$|^rto no/);
  if (rtoCodeCol < 0) {
    for (let c = 0; c < nCols; c++) {
      const vals = colValues(rows, c, headerRow);
      if (vals.length && vals.filter((v) => RTO_CODE_RE.test(v) || RTO_LIST_RE.test(v)).length / vals.length >= 0.6) { rtoCodeCol = c; break; }
    }
  }
  // region key: prefer the explicit grid-mapping/cluster column (ICICI's "PO GRID
  // MAPPING" = the city-cluster grids key on, e.g. "Vapi"), THEN region/cluster/
  // zone, and only fall back to raw city/state when nothing better exists.
  let regionCol = find(/grid[\s_]*mapping|po[\s_]*grid/);
  if (regionCol < 0) regionCol = find(/region|cluster|\bzone\b|rto[\s_]*group/);
  if (regionCol < 0) regionCol = find(/rto[\s_]*city|rto[\s_]*state|geography/);
  // a rate column: header hints OR a column mostly numeric in 0..100
  let rateCol = find(/\bpo\s*%|payout|\brate\b|approved\s*pay|net\s*po|imd\b|commission/);
  if (rateCol < 0) {
    for (let c = 0; c < nCols; c++) {
      const vals = colValues(rows, c, headerRow);
      const nums = vals.filter(isNumericish);
      if (vals.length >= 2 && nums.length / vals.length >= 0.6 &&
          nums.filter((v) => numVal(v) >= 0 && numVal(v) <= 100).length / nums.length >= 0.8) { rateCol = c; break; }
    }
  }
  const hasTracker = /tracker/.test(H) || /tracker/.test(subject);
  const hasCustomer = find(/customer|name of|proposer|insured\s*name|client/) >= 0;
  const enablerToken = /approved\s*payout|approved\s*dis|add[\s-]*on|\bimd\b|\bcoa\b|enabler|transaction\s*type|\btransaction\b/.test(H)
    || /enabler/.test(subject);
  const custCol = find(/customer|name of|proposer|insured\s*name|client/);
  const rateHdrCol = find(/rating|payout|\brate\b|approved\s*pay|discount|net\s*po/);

  // ── decide ──
  if (hasTracker && (hasCustomer || custCol >= 0)) {
    return { type: 'fleet', headerRow, confidence: 0.9,
      cols: { customer: custCol, rate: rateHdrCol, tracker: find(/tracker/) },
      note: 'fleet approval (tracker + customer)' };
  }
  if (enablerToken && rateCol >= 0) {
    return { type: 'enabler', headerRow, confidence: 0.8,
      cols: { rto: rtoCodeCol >= 0 ? rtoCodeCol : find(/rto|location/), make: find(/make/),
        transaction: find(/transaction|business|coa/), coa: find(/coa/), discount: find(/discount|approved\s*dis|add[\s-]*on/), payout: find(/approved\s*pay|payout|imd|net\s*po/) },
      note: 'enabler (IMD/COA/approved payout tokens)' };
  }
  if (rtoCodeCol >= 0 && regionCol >= 0 && rateCol < 0) {
    return { type: 'rto_map', headerRow, confidence: 0.85,
      cols: { rto_code: rtoCodeCol, region: regionCol, cluster: find(/actuarial|cluster|group|zone/), product: find(/product\s*categ|^product$|veh.*type/) },
      note: 'RTO master (rto code → region, no rate)' };
  }
  if (rateCol >= 0) {
    return { type: 'rate', headerRow, confidence: 0.6, cols: { rate: rateCol, region: regionCol, rto: rtoCodeCol }, note: 'rate grid' };
  }
  return { type: 'unknown', headerRow, cols: {}, confidence: 0.2, note: 'no rate/rto/fleet/enabler signal' };
}

// Normalise a product-category cell → CAR|TW|GCV|PCV|MISC (best effort).
function normProductCat(v) {
  const s = String(v || '').toUpperCase();
  if (/PVT|PRIVATE|\bCAR\b|4\s*W/.test(s)) return 'CAR';
  if (/\bTW\b|TWO\s*WHEEL|2\s*W/.test(s)) return 'TW';
  if (/GCV|GOODS/.test(s)) return 'GCV';
  if (/PCV|PASSENGER/.test(s)) return 'PCV';
  if (/MISC/.test(s)) return 'MISC';
  return s ? s.replace(/\s+/g, '_') : null;
}

/** RTO master rows → rto_mappings records. Explodes comma-lists; per-row product. */
function toRtoMappings(rows, cls, opts = {}) {
  const { rto_code, region, cluster, product } = cls.cols;
  const out = [];
  for (let r = cls.headerRow + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const codeRaw = cell(row[rto_code]);
    const reg = cell(row[region]);
    if (!codeRaw || !reg) continue;
    const clust = cluster != null && cluster >= 0 ? cell(row[cluster]) : null;
    const prod = product != null && product >= 0 ? normProductCat(row[product]) : (opts.product || null);
    for (const code of codeRaw.split(/[,/]/).map((s) => s.trim()).filter(Boolean)) {
      out.push({ insurer: opts.insurer, product: prod, rto_code: code.toUpperCase().replace(/[\s-]/g, ''), region: reg, cluster: clust || null });
    }
  }
  return out;
}

/** Fleet approval rows → fleet_overrides records. */
function toFleetOverrides(rows, cls, opts = {}) {
  const { customer, rate } = cls.cols;
  const out = [];
  for (let r = cls.headerRow + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const name = cell(row[customer]);
    if (!name) continue;
    // rate: prefer the flagged rate col; else the first numeric % cell in the row
    let pct = rate != null && rate >= 0 && isNumericish(row[rate]) ? numVal(row[rate]) : null;
    if (pct == null) { for (const v of row) if (isNumericish(v) && numVal(v) > 0 && numVal(v) <= 100) { pct = numVal(v); break; } }
    if (pct == null) continue;
    out.push({ insurer_slug: opts.insurer, fleet_name: opts.fleet_name || name, customer_name: name, vehicle_type: null, rate_pct: pct, note: opts.note || 'fleet approval (email)' });
  }
  return out;
}

/** Enabler rows → normalised enabler line records (for enabler_overrides). */
function toEnablerRows(rows, cls) {
  const { rto, make, transaction, coa, discount, payout } = cls.cols;
  const pick = (row, i) => (i != null && i >= 0 ? cell(row[i]) : '');
  const numOrNull = (v) => (isNumericish(v) ? numVal(v) : null);
  const out = [];
  for (let r = cls.headerRow + 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    if (row.map(cell).every((c) => c === '')) continue;
    const rl = pick(row, rto), mk = pick(row, make);
    if (!rl && !mk) continue;
    out.push({
      rto_location: rl || null,
      make: mk || null,
      transaction_type: pick(row, transaction) || null,
      coa_pct: numOrNull(pick(row, coa)),
      discount_pct: numOrNull(pick(row, discount)),
      payout_pct: numOrNull(pick(row, payout)),
    });
  }
  return out;
}

const sql = require('mssql');

/**
 * Classify + route a set of extracted sheets to their home tables. Rate/unknown
 * sheets are returned for the caller's dynamic parse-profile path; rto_map /
 * fleet / enabler sheets are ingested here into rto_mappings / fleet_overrides /
 * enabler_overrides. Returns a summary with per-type counts and rateSheets.
 */
async function routeAndIngest(pool, cardId, sheets, opts = {}) {
  const { insurer, subject, sourceFile } = opts;
  const rateSheets = [], classified = [];
  const counts = { rto_map: 0, fleet: 0, enabler: 0, rate: 0, unknown: 0 };

  for (const { name, rows } of sheets) {
    const cls = classifyTable(rows, { subject });
    classified.push({ sheet: name, type: cls.type, confidence: cls.confidence, note: cls.note });
    if (cls.type === 'rate' || cls.type === 'unknown') { rateSheets.push({ name, rows }); counts[cls.type]++; continue; }

    if (cls.type === 'rto_map') {
      const maps = toRtoMappings(rows, cls, { insurer });
      if (maps.length >= 50) {
        // Authoritative master → replace, but SCOPED to the products in this sheet
        // (Magma ships separate GCV and Pvt Car RTO sheets; a blanket insurer-wide
        // delete would let the second sheet wipe the first).
        const prods = [...new Set(maps.map((m) => m.product))];
        if (prods.length === 1 && prods[0] == null) {
          await pool.request().input('ins', sql.NVarChar, insurer).query('DELETE FROM rto_mappings WHERE insurer=@ins AND product IS NULL');
        } else {
          for (const pr of prods) {
            const rq = pool.request().input('ins', sql.NVarChar, insurer);
            if (pr == null) await rq.query('DELETE FROM rto_mappings WHERE insurer=@ins AND product IS NULL');
            else await rq.input('pr', sql.NVarChar, pr).query('DELETE FROM rto_mappings WHERE insurer=@ins AND product=@pr');
          }
        }
      }
      const tr = (v, n) => (v == null ? null : (String(v).length > n ? String(v).slice(0, n) : String(v)));
      for (let i = 0; i < maps.length; i += 5000) {
        const table = new sql.Table('rto_mappings');
        table.columns.add('rate_card_id', sql.Int, { nullable: true });
        table.columns.add('insurer', sql.VarChar(100), { nullable: true });
        table.columns.add('product', sql.VarChar(100), { nullable: true });
        table.columns.add('rto_code', sql.VarChar(20), { nullable: true });
        table.columns.add('region', sql.VarChar(200), { nullable: true });
        table.columns.add('cluster', sql.VarChar(200), { nullable: true });
        for (const m of maps.slice(i, i + 5000)) table.rows.add(cardId, tr(m.insurer, 100), tr(m.product, 100), tr(m.rto_code, 20), tr(m.region, 200), tr(m.cluster, 200));
        await pool.request().bulk(table);
      }
      counts.rto_map += maps.length;
    } else if (cls.type === 'fleet') {
      const fleets = toFleetOverrides(rows, cls, { insurer, note: 'fleet approval: ' + (subject || sourceFile || '') });
      for (const fo of fleets) {
        // replace any prior active deal for this insurer+customer
        await pool.request().input('ins', sql.NVarChar, fo.insurer_slug).input('cust', sql.NVarChar, fo.customer_name)
          .query("UPDATE fleet_overrides SET active=0 WHERE insurer_slug=@ins AND customer_name=@cust AND active=1");
        await pool.request()
          .input('ins', sql.NVarChar, fo.insurer_slug).input('fn', sql.NVarChar, fo.fleet_name)
          .input('cust', sql.NVarChar, fo.customer_name).input('vt', sql.NVarChar, fo.vehicle_type)
          .input('rate', sql.Decimal(7, 3), fo.rate_pct).input('note', sql.NVarChar, fo.note)
          .query('INSERT INTO fleet_overrides (insurer_slug,fleet_name,customer_name,vehicle_type,rate_pct,note,active) VALUES (@ins,@fn,@cust,@vt,@rate,@note,1)');
        counts.fleet++;
      }
    } else if (cls.type === 'enabler') {
      const erows = toEnablerRows(rows, cls);
      const dealId = 'EML-' + (subject || sourceFile || 'enabler').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40) + '-' + name.replace(/[^A-Za-z0-9]+/g, '');
      for (const er of erows) {
        const coa = er.payout_pct != null ? er.payout_pct : er.coa_pct;   // payout is the enabler value
        if (coa == null) continue;
        await pool.request()
          .input('deal', sql.NVarChar, dealId).input('rto', sql.NVarChar, er.rto_location)
          .input('make', sql.NVarChar, er.make).input('tt', sql.NVarChar, er.transaction_type)
          .input('coa', sql.Decimal(7, 3), coa)
          .input('disc', sql.Decimal(7, 3), er.discount_pct)
          .input('src', sql.NVarChar, sourceFile || null).input('by', sql.NVarChar, opts.createdBy || 'upload')
          .query(`INSERT INTO enabler_overrides (deal_id,rto_location,make,transaction_type,coa_pct,discount_pct,source_file,created_by,active)
                  VALUES (@deal,@rto,@make,@tt,@coa,@disc,@src,@by,1)`);
        counts.enabler++;
      }
    }
  }
  return { rateSheets, counts, classified };
}

module.exports = { classifyTable, toRtoMappings, toFleetOverrides, toEnablerRows, routeAndIngest };
