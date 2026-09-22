/**
 * Excel export routes — download parsed rate rules in the user's master
 * 28-column .xlsx format.
 */

const express = require('express');
const { getPool } = require('../db/connection');
const { buildExportBuffer } = require('../services/excel-export');
const { buildLucaBuffer } = require('../services/luca-export');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const agentGrid = require('../services/agent-grid');

const router = express.Router();

function sendXlsx(res, buffer, filename) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`
  );
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
}

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * GET /export/rate-card/:id
 * Download the master Excel for a single uploaded rate card.
 */
router.get('/rate-card/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: 'Invalid rate card ID' });
    }

    const pool = await getPool();
    const cardRow = await pool
      .request()
      .input('id', id)
      .query('SELECT insurer FROM rate_cards WHERE id = @id');
    if (cardRow.recordset.length === 0) {
      return res.status(404).json({ success: false, error: 'Rate card not found' });
    }

    const buffer = await buildExportBuffer(id);
    const insurer = cardRow.recordset[0].insurer || 'insurer';
    sendXlsx(res, buffer, `rates_${insurer}_${todayStamp()}.xlsx`);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /export/all
 * Download a single master Excel covering active rate cards. Optional
 * filters keep the file small enough to open:
 *   ?insurer=tata_aig         — only this insurer's cards
 *   ?product=GCV              — only rules whose `product` column matches
 *                               (CAR / GCV / PCV / TW / MISC / CV / 4W / 2W)
 * Both are case-insensitive. With no filters, every active card is included
 * (the original behaviour).
 */
router.get('/all', async (req, res, next) => {
  try {
    const insurer = String(req.query.insurer || '').trim();
    const product = String(req.query.product || '').trim();

    const pool = await getPool();
    const reqCard = pool.request();
    reqCard.timeout = 600000;  // export can be slow; allow 10 min
    // Only currently-active rate cards: effective_from <= today AND
    // (effective_to IS NULL OR effective_to > today).  Cards superseded
    // by a newer monthly upload have effective_to = the new upload's
    // effective_from, so they drop out automatically.  Older cards
    // missing effective_from default to active (legacy data).
    let q = `SELECT id, insurer FROM rate_cards
              WHERE status = 'active'
                AND (effective_from IS NULL OR effective_from <= CAST(GETDATE() AS DATE))
                AND (effective_to IS NULL OR effective_to > CAST(GETDATE() AS DATE))`;
    if (insurer) {
      reqCard.input('ins', insurer);
      q += " AND LOWER(insurer) = LOWER(@ins)";
    }
    const result = await reqCard.query(q);
    const ids = result.recordset.map(r => r.id);

    if (ids.length === 0) {
      return res.status(404).json({
        success: false,
        error: insurer
          ? `No active rate cards for insurer "${insurer}"`
          : 'No active rate cards to export',
      });
    }

    const buffer = await buildExportBuffer(ids, { product: product || null });

    const stem = ['rates', insurer || 'all', product || ''].filter(Boolean).join('_');
    sendXlsx(res, buffer, `${stem}_${todayStamp()}.xlsx`);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /export/luca
 * Download ALL outgoing rates of ALL active insurers in the 35-column Luca
 * format. Only the commission rate is exported — income and margin are NOT
 * included. Optional ?insurer= filter.
 */
router.get('/luca', async (req, res, next) => {
  try {
    const insurer = String(req.query.insurer || '').trim();
    // Optional effective-date filter (YYYY-MM-DD): export the rate GENERATION in
    // force on that date — every active card with effective_from <= date. We do
    // NOT gate on effective_to: cards are date-chained (a July card carries
    // effective_to = 1-Aug even though it is the latest grid in Sept), and
    // buildLucaBuffer already dedups each rate cell to the newest generation, so
    // adding an effective_to > date clause would wrongly drop every insurer whose
    // grid hasn't changed since its last upload. Defaults to today.
    const edRaw = String(req.query.effective_date || '').trim();
    const effDate = /^\d{4}-\d{2}-\d{2}$/.test(edRaw) ? edRaw : null;
    const pool = await getPool();
    const reqCard = pool.request();
    reqCard.timeout = 600000;
    let q = `SELECT id FROM rate_cards WHERE status = 'active'`;
    if (effDate) {
      reqCard.input('eff', effDate);
      q += ` AND (effective_from IS NULL OR effective_from <= @eff)`;
    } else {
      q += ` AND (effective_from IS NULL OR effective_from <= CAST(GETDATE() AS DATE))`;
    }
    if (insurer) { reqCard.input('ins', insurer); q += ' AND LOWER(insurer) = LOWER(@ins)'; }
    const result = await reqCard.query(q);
    const ids = result.recordset.map(r => r.id);
    if (ids.length === 0) {
      return res.status(404).json({ success: false, error: 'No active rate cards to export' });
    }
    // Product scope: the Luca file covers Pvt Car / TW / GCV only (USER 2026-08-04,
    // PCV & MISC ignored). Override with ?products=CAR,TW,GCV,PCV,MISC (or =ALL).
    const prodParam = String(req.query.products || '').trim();
    const products = prodParam
      ? (/^all$/i.test(prodParam) ? null : prodParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
      : ['CAR', 'TW', 'GCV'];
    // Stamp every row's year/month with the snapshot period (the chosen effective
    // date, else today) so the file is one period — not each grid's filing month.
    const asOfDate = effDate || new Date().toISOString().slice(0, 10);
    // Luca margin: a FLAT 5-point margin applies to EVERY insurer in the Luca file
    // (USER: "5% margin for luca file" — the per-rule company margins, e.g. Go Digit
    // 6%, are for the internal payout only, not the Luca outgoing). Override with
    // ?margin=<points> if a different flat margin is ever needed.
    const flatMargin = /^\d+(\.\d+)?$/.test(String(req.query.margin || '')) ? Number(req.query.margin) : 5;
    const buffer = await buildLucaBuffer(ids, { ...(products ? { products } : {}), asOfDate, flatMargin });
    const stem = ['luca', insurer || 'all', effDate ? `eff${effDate}` : ''].filter(Boolean).join('_');
    sendXlsx(res, buffer, `${stem}_${todayStamp()}.xlsx`);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// AGENT RATE GRID (PDF) — the outgoing rates (grid − real per-rule margin) in the
// agent-facing layout, per product × region, with optional per-agent overrides.
// ---------------------------------------------------------------------------
const AGENT_GUIDE = [
  'Before booking: first check RTO Master & guidelines. Declined make/model & RTO lists apply per insurer.',
  'SBI: Comprehensive up to 20 yr; check RTO Master. Chola: CPA not collected (individual) → 1.5% of OD deducted.',
  'Shriram: SAOD 10% where SAOD grid not mentioned; EV & >15yr declined; −10% if discounting breached.',
  'Magma: CPA premium < Rs 450 not considered for outgo. Royal/Universal: check declined-RTO lists.',
  'Rates = system OUTGOING (grid minus the applicable margin).',
];

/**
 * GET /export/agent-grid?product=&region=&agent=&effective_date=
 *   product  — a product group (default "Pvt Car Package"; see /agent-grid/options)
 *   region   — a state-group key ("AP&TS", "MH", …) or "all" (default)
 *   agent    — optional agent code; applies config/agent_overrides.json for that agent
 */
router.get('/agent-grid', async (req, res, next) => {
  try {
    const product = String(req.query.product || 'Pvt Car Package').trim();
    const region = String(req.query.region || 'all').trim();
    const agent = String(req.query.agent || '').trim();
    const edRaw = String(req.query.effective_date || '').trim();
    const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(edRaw) ? edRaw : new Date().toISOString().slice(0, 10);
    const pool = await getPool();
    const rq = pool.request(); rq.timeout = 600000; rq.input('eff', asOfDate);
    const cards = await rq.query("SELECT id FROM rate_cards WHERE status='active' AND (effective_from IS NULL OR effective_from <= @eff)");
    const ids = cards.recordset.map((r) => r.id);
    if (!ids.length) return res.status(404).json({ success: false, error: 'No active rate cards' });
    const buf = await buildLucaBuffer(ids, { asOfDate });   // real margins (no flatMargin)
    const rows = XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets.Sheet1, { header: 1 });
    const stateSlugs = (region && region.toLowerCase() !== 'all') ? (agentGrid.STATE_GROUPS[region] || null) : null;
    let ag = agentGrid.buildAgentRows(rows, product, stateSlugs);
    let titleAgent = '';
    if (agent) { const r = agentGrid.applyAgentOverrides(ag, agent, product); ag = r.rows; if (r.applied) titleAgent = ` — Agent ${agent}`; }
    if (!ag.length) return res.status(404).json({ success: false, error: `No rows for product "${product}"${stateSlugs ? ' in region ' + region : ''}` });
    const title = `${region.toLowerCase() === 'all' ? '' : region + '  '}${product}  ${asOfDate}${titleAgent}`;
    const pdf = await agentGrid.renderAgentGridPdf(title, AGENT_GUIDE, ag);
    const stem = ['Agent', region.replace(/[^A-Za-z0-9]+/g, ''), product.replace(/[^A-Za-z0-9]+/g, '_'), agent].filter(Boolean).join('_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}_${todayStamp()}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) { next(err); }
});

/**
 * GET /export/agent-grid/all?region=&agent=&effective_date=
 * ONE ZIP with an agent-grid PDF for every product group (all vehicle types),
 * for the chosen region & optional agent. Builds the outgoing snapshot ONCE and
 * renders every product from it (much cheaper than N separate downloads).
 */
router.get('/agent-grid/all', async (req, res, next) => {
  try {
    const region = String(req.query.region || 'all').trim();
    const agent = String(req.query.agent || '').trim();
    const edRaw = String(req.query.effective_date || '').trim();
    const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(edRaw) ? edRaw : new Date().toISOString().slice(0, 10);
    const pool = await getPool();
    const rq = pool.request(); rq.timeout = 600000; rq.input('eff', asOfDate);
    const cards = await rq.query("SELECT id FROM rate_cards WHERE status='active' AND (effective_from IS NULL OR effective_from <= @eff)");
    const ids = cards.recordset.map((r) => r.id);
    if (!ids.length) return res.status(404).json({ success: false, error: 'No active rate cards' });
    // Build the outgoing snapshot once, then render each product group from it.
    const buf = await buildLucaBuffer(ids, { asOfDate });   // real margins (no flatMargin)
    const rows = XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets.Sheet1, { header: 1 });
    const stateSlugs = (region && region.toLowerCase() !== 'all') ? (agentGrid.STATE_GROUPS[region] || null) : null;
    const products = [...new Set(Object.values(agentGrid.PRODUCT_GROUP))];
    const zip = new AdmZip();
    let added = 0;
    for (const product of products) {
      let ag = agentGrid.buildAgentRows(rows, product, stateSlugs);
      if (agent) { const r = agentGrid.applyAgentOverrides(ag, agent, product); ag = r.rows; }
      if (!ag.length) continue;   // no rows for this product in this region — skip
      const titleAgent = agent ? ` — Agent ${agent}` : '';
      const title = `${region.toLowerCase() === 'all' ? '' : region + '  '}${product}  ${asOfDate}${titleAgent}`;
      const pdf = await agentGrid.renderAgentGridPdf(title, AGENT_GUIDE, ag);
      zip.addFile(`${product.replace(/[^A-Za-z0-9]+/g, '_')}.pdf`, pdf);
      added++;
    }
    if (!added) return res.status(404).json({ success: false, error: `No rows for any product${stateSlugs ? ' in region ' + region : ''}` });
    const zipBuf = zip.toBuffer();
    const stem = ['AgentGrids', region.replace(/[^A-Za-z0-9]+/g, ''), agent].filter(Boolean).join('_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}_${todayStamp()}.zip"`);
    res.setHeader('Content-Length', zipBuf.length);
    res.send(zipBuf);
  } catch (err) { next(err); }
});

/** GET /export/agent-grid/options — product groups, regions, and agents-with-overrides (for the UI). */
router.get('/agent-grid/options', (req, res) => {
  res.json({
    products: [...new Set(Object.values(agentGrid.PRODUCT_GROUP))],
    regions: ['all', ...Object.keys(agentGrid.STATE_GROUPS)],
    agents: agentGrid.agentsWithOverrides(),
  });
});

module.exports = router;
