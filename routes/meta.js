const express = require('express');
const path = require('path');
const fs = require('fs');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const router = express.Router();

const INSURERS_DIR = path.resolve(__dirname, '..', 'config', 'insurers');

/**
 * GET /insurers
 * List available insurers by scanning config/insurers/ for JSON files.
 */
router.get('/insurers', async (req, res, next) => {
  try {
    const files = fs.readdirSync(INSURERS_DIR).filter((f) => f.endsWith('.json'));
    const insurers = files.map((f) => {
      const config = JSON.parse(fs.readFileSync(path.join(INSURERS_DIR, f), 'utf8'));
      return {
        id: path.basename(f, '.json'),
        display_name: config.display_name || config.insurer,
        insurer: config.insurer,
      };
    });

    res.json({ success: true, insurers });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /all-insurers
 * List all insurers from Prarambh_UAT.vw_InsurancePlans (CategoryId=16 = Motor)
 * Used in the upload dropdown so any insurer's file can be uploaded.
 */
router.get('/all-insurers', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .query(
        `SELECT DISTINCT InsurerId, InsurerName
         FROM Prarambh_UAT.dbo.vw_InsurancePlans
         WHERE CategoryId = 16
         ORDER BY InsurerName`
      );

    // Brand-name slug overrides — for short single-word brands (SBI, HDFC,
    // SBIG, IFFCO) the generic "strip General Insurance, snake-case the
    // rest" rule collapses to a too-short slug that doesn't match the
    // canonical config / resolveInsurerSlug naming. Keep this list in sync
    // with config/insurers/*.json filenames + routes/policy.js
    // resolveInsurerSlug so all three layers agree.
    const SLUG_OVERRIDES = {
      'sbi general insurance':  'sbi_general',
      'hdfc ergo general insurance':  'hdfc_ergo',
      'iffco tokio general insurance': 'iffco_tokio',
      'iffco-tokio general insurance': 'iffco_tokio',
      'kotak mahindra general insurance': 'kotak',
      'universal sompo general insurance': 'universal_sompo',
      'reliance general insurance':         'reliance',
    };
    const deriveSlug = (name) => {
      const key = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (SLUG_OVERRIDES[key]) return SLUG_OVERRIDES[key];
      return name.toLowerCase()
        .replace(/\s+general\s+insurance.*$/i, '')
        .replace(/\s+life\s+insurance.*$/i, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
    };
    const insurers = result.recordset.map((r) => ({
      id: r.InsurerId,
      name: r.InsurerName,
      slug: deriveSlug(r.InsurerName),
    }));

    res.json({ success: true, insurers });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /products/:insurer
 * List distinct products from rate_rules for this insurer (classified products).
 */
router.get('/products/:insurer', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('insurer', sql.NVarChar, req.params.insurer)
      .query(
        `SELECT DISTINCT product FROM rate_rules
         WHERE insurer = @insurer AND product IS NOT NULL
         ORDER BY product`
      );

    const { PRODUCT_LABELS } = require('../parsers/utils/product-classifier');
    const products = result.recordset.map((r) => ({
      code: r.product,
      label: PRODUCT_LABELS[r.product] || r.product,
    }));

    res.json({ success: true, insurer: req.params.insurer, products });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /regions/:insurer/:product
 * List distinct regions from rate_rules for this insurer + product.
 */
router.get('/regions/:insurer/:product', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('insurer', sql.NVarChar, req.params.insurer)
      .input('product', sql.NVarChar, req.params.product)
      .query(
        `SELECT DISTINCT region FROM rate_rules
         WHERE insurer = @insurer AND product = @product AND region IS NOT NULL
         ORDER BY region`
      );

    res.json({
      success: true,
      insurer: req.params.insurer,
      product: req.params.product,
      regions: result.recordset.map((r) => r.region),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /segments/:insurer/:product
 * List distinct segments from rate_rules.
 */
router.get('/segments/:insurer/:product', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('insurer', sql.NVarChar, req.params.insurer)
      .input('product', sql.NVarChar, req.params.product)
      .query(
        `SELECT DISTINCT segment FROM rate_rules
         WHERE insurer = @insurer AND product = @product AND segment IS NOT NULL
         ORDER BY segment`
      );

    res.json({
      success: true,
      insurer: req.params.insurer,
      product: req.params.product,
      segments: result.recordset.map((r) => r.segment),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /makes/:insurer/:product
 * List distinct makes from rate_rules.
 */
router.get('/makes/:insurer/:product', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('insurer', sql.NVarChar, req.params.insurer)
      .input('product', sql.NVarChar, req.params.product)
      .query(
        `SELECT DISTINCT make FROM rate_rules
         WHERE insurer = @insurer AND product = @product AND make IS NOT NULL
         ORDER BY make`
      );

    res.json({
      success: true,
      insurer: req.params.insurer,
      product: req.params.product,
      makes: result.recordset.map((r) => r.make),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /sheets/:insurer/:product
 * List distinct sheet names from rate_rules.
 */
router.get('/sheets/:insurer/:product', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('insurer', sql.NVarChar, req.params.insurer)
      .input('product', sql.NVarChar, req.params.product)
      .query(
        `SELECT DISTINCT sheet_name FROM rate_rules
         WHERE insurer = @insurer AND product = @product AND sheet_name IS NOT NULL
         ORDER BY sheet_name`
      );

    res.json({
      success: true,
      insurer: req.params.insurer,
      product: req.params.product,
      sheets: result.recordset.map((r) => r.sheet_name),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /sub-types/:insurer/:product
 * List distinct sub_types from rate_rules.
 */
router.get('/sub-types/:insurer/:product', async (req, res, next) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('insurer', sql.NVarChar, req.params.insurer)
      .input('product', sql.NVarChar, req.params.product)
      .query(
        `SELECT DISTINCT sub_type FROM rate_rules
         WHERE insurer = @insurer AND product = @product AND sub_type IS NOT NULL AND sub_type != ''
         ORDER BY sub_type`
      );

    res.json({
      success: true,
      insurer: req.params.insurer,
      product: req.params.product,
      sub_types: result.recordset.map((r) => r.sub_type),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
