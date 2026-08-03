'use strict';

/**
 * routes/parse-profiles.js — Parse-Profile review (admin-only).
 *
 * Surfaces how each uploaded sheet was dynamically parsed, flags drifted /
 * low-confidence layouts for human review, and lets an admin correct the
 * detected column→role map (flat) or matrix descriptor and RE-PARSE the card's
 * rules — no code change when a grid's format changes.
 *
 *   GET  /                      list profiles (?status=needs_review&insurer=)
 *   GET  /card/:cardId          all profiles for a card
 *   GET  /:id/preview           sheet preview + detected mapping + health
 *   PUT  /:id                   edit mapping → re-parse → new health + sample
 *   POST /:id/confirm           mark confirmed (+ re-parse to be safe)
 *   POST /:id/reject            mark rejected
 */
const express = require('express');
const fs = require('fs');
const sql = require('mssql');
const XLSX = require('xlsx');
const { getPool } = require('../db/connection');
const { attachUser, requireAdmin } = require('./auth');
const {
  loadProfile, reparseProfile, gateStatus, generateProfiles, persistProfiles,
} = require('../services/parse-profile');
const { profileHealth, buildProfile } = require('../services/grid-schema-resolver');

const router = express.Router();
router.use(attachUser());
router.use(requireAdmin);

/** Read one sheet's rows from a stored source file. */
function readSheetRows(sourcePath, sheetName) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('source file not found: ' + sourcePath);
  const wb = XLSX.readFile(sourcePath);
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error('sheet not found: ' + sheetName);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

// ── (re)generate profiles for an EXISTING card ─────────────────────────────────
// Backfill: build + persist parse profiles for a card that predates this feature
// (or was re-shipped). Writes ONLY card_parse_profiles + rate_cards.source_path —
// never rate_rules — so it's safe to run on live cards; applying the parse is a
// separate, explicit confirm/re-parse step. body: { source_path? }
router.post('/generate/:cardId(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    const cardId = Number(req.params.cardId);
    const cr = await pool.request().input('cid', sql.Int, cardId)
      .query('SELECT id, insurer, source_path FROM rate_cards WHERE id=@cid');
    const card = cr.recordset[0];
    if (!card) return res.status(404).json({ success: false, error: 'card not found' });
    let sourcePath = (req.body && req.body.source_path) || card.source_path;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return res.status(400).json({ success: false, error: 'source_path missing/not found — pass body.source_path (uploads/<file>)' });
    }
    if (sourcePath !== card.source_path) {
      await pool.request().input('cid', sql.Int, cardId).input('p', sql.NVarChar, sourcePath)
        .query('UPDATE rate_cards SET source_path=@p WHERE id=@cid');
    }
    const generated = generateProfiles(sourcePath, { insurer: card.insurer });
    await persistProfiles(pool, cardId, sourcePath, generated, { insurer: card.insurer });
    res.json({
      success: true, card_id: cardId, sheets: generated.length,
      needs_review: generated.filter((g) => g.status === 'needs_review').length,
      profiles: generated.map((g) => ({
        sheet: g.sheet_name, layout: g.profile.layout, confidence: g.profile.confidence,
        coverage: g.health.coverage, rules: g.health.rulesOut, status: g.status,
      })),
    });
  } catch (e) { next(e); }
});

// ── list ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const where = [];
    const rq = pool.request();
    if (req.query.status) { where.push('p.status = @status'); rq.input('status', sql.NVarChar, String(req.query.status)); }
    if (req.query.insurer) { where.push('p.insurer = @insurer'); rq.input('insurer', sql.NVarChar, String(req.query.insurer)); }
    const sqlText = `
      SELECT p.id, p.rate_card_id, p.insurer, p.sheet_name, p.layout, p.confidence,
             p.coverage, p.empty_rate_pct, p.data_rows, p.rules_out, p.status, p.notes,
             p.created_at, c.file_name, c.effective_from
      FROM card_parse_profiles p
      LEFT JOIN rate_cards c ON c.id = p.rate_card_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (CASE p.status WHEN 'needs_review' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END), p.confidence ASC, p.id DESC`;
    const r = await rq.query(sqlText);
    res.json({ success: true, profiles: r.recordset });
  } catch (e) { next(e); }
});

// ── all profiles for a card ────────────────────────────────────────────────────
router.get('/card/:cardId(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().input('cid', sql.Int, Number(req.params.cardId))
      .query('SELECT * FROM card_parse_profiles WHERE rate_card_id=@cid ORDER BY id');
    res.json({ success: true, profiles: r.recordset });
  } catch (e) { next(e); }
});

// ── preview: sheet rows + detected mapping + health ────────────────────────────
router.get('/:id(\\d+)/preview', async (req, res, next) => {
  try {
    const pool = await getPool();
    const row = await loadProfile(pool, Number(req.params.id));
    if (!row) return res.status(404).json({ success: false, error: 'profile not found' });
    let rows = [], health = null, err = null;
    try {
      rows = readSheetRows(row.source_path, row.sheet_name);
      health = profileHealth(rows, row.profile, { insurer: row.insurer, product: row.product });
    } catch (e) { err = e.message; }
    const preview = rows.slice(0, 30).map((r) => (r || []).map((v) => (v == null ? '' : String(v))));
    res.json({
      success: true,
      profile: row.profile,
      meta: {
        id: row.id, rate_card_id: row.rate_card_id, insurer: row.insurer, product: row.product,
        sheet_name: row.sheet_name, status: row.status, layout: row.layout,
        confidence: row.confidence, coverage: row.coverage, rules_out: row.rules_out,
      },
      preview, health, source_error: err,
      role_vocabulary: ['rate', 'rate_od', 'rate_tp', 'region', 'cover', 'segment', 'fuel',
        'ncb', 'biz', 'make', 'cc', 'tonnage', 'seating', 'age'],
    });
  } catch (e) { next(e); }
});

// ── edit mapping → re-parse ────────────────────────────────────────────────────
// body: { profile } — the full corrected profile object (flat roles or matrix
// descriptor). We re-parse the card's sheet with it, refresh health + status,
// and persist the corrected profile. Returns new health + a sample of rules.
router.put('/:id(\\d+)', async (req, res, next) => {
  try {
    const pool = await getPool();
    const row = await loadProfile(pool, Number(req.params.id));
    if (!row) return res.status(404).json({ success: false, error: 'profile not found' });
    const newProfile = req.body && req.body.profile;
    if (!newProfile || typeof newProfile !== 'object') {
      return res.status(400).json({ success: false, error: 'body.profile (object) required' });
    }
    newProfile.sheet_name = row.sheet_name;
    // re-parse + replace this sheet's rules
    const { rulesOut, health, rules } = await reparseProfile(pool, row, {
      insurer: row.insurer, product: row.product, profile: newProfile,
    });
    const status = gateStatus(newProfile, health) === 'auto' ? 'confirmed' : 'needs_review';
    await pool.request()
      .input('id', sql.Int, row.id)
      .input('pjson', sql.NVarChar, JSON.stringify(newProfile))
      .input('layout', sql.NVarChar, newProfile.layout || 'flat')
      .input('conf', sql.Float, newProfile.confidence ?? null)
      .input('cov', sql.Float, health.coverage ?? null)
      .input('empty', sql.Float, health.emptyRatePct ?? null)
      .input('drows', sql.Int, health.dataRows ?? null)
      .input('rout', sql.Int, rulesOut)
      .input('status', sql.NVarChar, status)
      .query(`UPDATE card_parse_profiles SET profile_json=@pjson, layout=@layout, confidence=@conf,
              coverage=@cov, empty_rate_pct=@empty, data_rows=@drows, rules_out=@rout, status=@status
              WHERE id=@id`);
    res.json({ success: true, rulesOut, health, status, sample: rules.slice(0, 20) });
  } catch (e) { next(e); }
});

// ── confirm ────────────────────────────────────────────────────────────────────
router.post('/:id(\\d+)/confirm', async (req, res, next) => {
  try {
    const pool = await getPool();
    const row = await loadProfile(pool, Number(req.params.id));
    if (!row) return res.status(404).json({ success: false, error: 'profile not found' });
    const { rulesOut, health } = await reparseProfile(pool, row, { insurer: row.insurer, product: row.product });
    const who = (req.user && (req.user.empcode || req.user.name)) || 'admin';
    await pool.request()
      .input('id', sql.Int, row.id)
      .input('rout', sql.Int, rulesOut)
      .input('cov', sql.Float, health.coverage ?? null)
      .input('who', sql.NVarChar, who)
      .query(`UPDATE card_parse_profiles SET status='confirmed', rules_out=@rout, coverage=@cov,
              confirmed_by=@who, confirmed_at=GETDATE() WHERE id=@id`);
    res.json({ success: true, rulesOut, health });
  } catch (e) { next(e); }
});

// ── reject ─────────────────────────────────────────────────────────────────────
router.post('/:id(\\d+)/reject', async (req, res, next) => {
  try {
    const pool = await getPool();
    const who = (req.user && (req.user.empcode || req.user.name)) || 'admin';
    const r = await pool.request().input('id', sql.Int, Number(req.params.id)).input('who', sql.NVarChar, who)
      .query(`UPDATE card_parse_profiles SET status='rejected', confirmed_by=@who, confirmed_at=GETDATE() WHERE id=@id`);
    res.json({ success: r.rowsAffected[0] > 0 });
  } catch (e) { next(e); }
});

module.exports = router;
