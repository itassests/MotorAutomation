/**
 * Excel export routes — download parsed rate rules in the user's master
 * 28-column .xlsx format.
 */

const express = require('express');
const { getPool } = require('../db/connection');
const { buildExportBuffer } = require('../services/excel-export');
const { buildLucaBuffer } = require('../services/luca-export');

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
    const pool = await getPool();
    const reqCard = pool.request();
    reqCard.timeout = 600000;
    let q = `SELECT id FROM rate_cards
              WHERE status = 'active'
                AND (effective_from IS NULL OR effective_from <= CAST(GETDATE() AS DATE))
                AND (effective_to IS NULL OR effective_to > CAST(GETDATE() AS DATE))`;
    if (insurer) { reqCard.input('ins', insurer); q += ' AND LOWER(insurer) = LOWER(@ins)'; }
    const result = await reqCard.query(q);
    const ids = result.recordset.map(r => r.id);
    if (ids.length === 0) {
      return res.status(404).json({ success: false, error: 'No active rate cards to export' });
    }
    const buffer = await buildLucaBuffer(ids);
    const stem = ['luca', insurer || 'all'].filter(Boolean).join('_');
    sendXlsx(res, buffer, `${stem}_${todayStamp()}.xlsx`);
  } catch (err) { next(err); }
});

module.exports = router;
