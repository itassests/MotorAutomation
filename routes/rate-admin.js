/**
 * routes/rate-admin.js — manual rate editor (admin-only).
 *
 * Lets an admin update or add a single rate_rules row from the Search Rates
 * screen. A rate comes from one of three sources; only rate_rules rows are
 * editable here, so config-/hardcoded-driven insurer×product combos are flagged
 * read-only (editing rate_rules there would be a silent no-op).
 *
 *   GET  /source?insurer=&product=   { source, editable, note, file }
 *   GET  /cards?insurer=             candidate rate_cards to add a rule to
 *   PUT  /rule/:id                   update a rate_rules row's rate (+ audit)
 *   POST /rule                       insert a new rate_rules row (+ audit)
 */
const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { attachUser, requireAdmin } = require('./auth');

const router = express.Router();
router.use(attachUser());
router.use(requireAdmin);

// Which insurer×product rates are NOT in rate_rules (so a rate_rules edit is a
// no-op). Value is the config file to edit instead, or 'HARDCODED'. '*' = all
// products. Everything not listed is rate_rules-driven and editable.
const CONFIG_DRIVEN = {
  tata_aig: { CAR: 'config/tata_car_jun26.json', TW: 'config/flat_grids/tata_aig.json', GCV: 'config/tata_cv_jun26.json', PCV: 'config/tata_cv_jun26.json', MISC: 'config/tata_cv_jun26.json' },
  new_india_assurance: { '*': 'config/nia_motor.json' },
  national_insurance: { '*': 'config/national_motor.json' },
  indusind: { CAR: 'config/indusind_car.json', TW: 'config/indusind_tw.json', GCV: 'config/indusind_cv.json', PCV: 'config/indusind_cv.json', MISC: 'config/indusind_cv.json' },
  united_india: { CAR: 'config/united_pref_rtos.json', GCV: 'config/united_gcv_pref.json', PCV: 'HARDCODED' },
  united_india_insurance: { CAR: 'config/united_pref_rtos.json', GCV: 'config/united_gcv_pref.json', PCV: 'HARDCODED' },
  hdfc_ergo: { TW: 'config/hdfc_tw_grid.json', GCV: 'config/hdfc_gcv_grid.json' },
  future_generali: { GCV: 'config/fg_cv_grid.json' },
  icici_lombard: { GCV: 'config/icici_cv_zone.json', PCV: 'config/icici_cv_zone.json', MISC: 'config/icici_cv_zone.json' },
  reliance: { CAR: 'config/reliance_car_grid.json' },
  bajaj_allianz: { CAR: 'config/bajaj_car_1801.json' },
};

// Normalise a DB product code to a family (CAR / TW / GCV / PCV / MISC).
function productFamily(p) {
  const u = String(p || '').toUpperCase();
  if (['CAR', '4W', 'PC', 'PVT.CAR'].includes(u)) return 'CAR';
  if (['TW', '2W', 'TW_EV'].includes(u)) return 'TW';
  if (u === 'PCV') return 'PCV';
  if (u === 'MISC' || u === 'MIS') return 'MISC';
  return 'GCV'; // GCV, CV → representative GCV family for the source check
}

/** Determine where the rate for (insurer, product) comes from. */
function rateSource(insurer, product) {
  const ins = String(insurer || '').trim();
  const fam = productFamily(product);
  const m = CONFIG_DRIVEN[ins];
  const hit = m && (m['*'] || m[fam]);
  if (hit === 'HARDCODED') {
    return { source: 'hardcoded', editable: false, file: null,
      note: `${ins} ${fam} rates are hardcoded in the engine — not editable from this screen.` };
  }
  if (hit) {
    return { source: 'config', editable: false, file: hit,
      note: `${ins} ${fam} rates are config-driven — the grid rows below are not what the engine uses. To change the rate, edit ${hit}.` };
  }
  return { source: 'rate_rules', editable: true, file: null, note: '' };
}

async function audit(pool, { ruleId, insurer, product, action, oldRate, newRate, empcode, note }) {
  await pool.request()
    .input('r', sql.Int, ruleId != null ? ruleId : null)
    .input('i', sql.VarChar(100), insurer || null)
    .input('p', sql.VarChar(50), product || null)
    .input('a', sql.VarChar(10), action)
    .input('o', sql.Decimal(10, 4), oldRate != null ? oldRate : null)
    .input('n', sql.Decimal(10, 4), newRate != null ? newRate : null)
    .input('e', sql.NVarChar(100), empcode || null)
    .input('nt', sql.NVarChar(500), (note || '').slice(0, 500) || null)
    .query(`INSERT INTO dbo.rate_rule_audit (rule_id, insurer, product, action, old_rate, new_rate, empcode, note)
            VALUES (@r, @i, @p, @a, @o, @n, @e, @nt)`);
}

/** GET /source — is this insurer×product editable here, or config-driven? */
router.get('/source', (req, res) => {
  res.json({ success: true, ...rateSource(req.query.insurer, req.query.product) });
});

/** GET /cards — candidate rate_cards for an insurer (newest first) to add a rule to. */
router.get('/cards', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().input('i', sql.NVarChar(100), String(req.query.insurer || ''))
      .query(`SELECT id, file_name, effective_from, effective_to, status
                FROM dbo.rate_cards WHERE insurer = @i ORDER BY effective_from DESC, id DESC`);
    res.json({ success: true, cards: r.recordset });
  } catch (err) { next(err); }
});

/** PUT /rule/:id — update a rate_rules row's rate (and optionally decline/remarks). */
router.put('/rule/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, error: 'Invalid rule id' });
    const rv = Number(req.body.rate_value);
    if (!Number.isFinite(rv) || rv < 0) return res.status(400).json({ success: false, error: 'rate_value must be a non-negative number' });

    const pool = await getPool();
    const cur = (await pool.request().input('id', sql.Int, id)
      .query('SELECT id, insurer, product, rate_value FROM dbo.rate_rules WHERE id = @id')).recordset[0];
    if (!cur) return res.status(404).json({ success: false, error: 'Rule not found' });

    const src = rateSource(cur.insurer, cur.product);
    if (!src.editable) return res.status(409).json({ success: false, error: src.note, source: src.source, file: src.file });

    const rq = pool.request().input('id', sql.Int, id).input('v', sql.Decimal(10, 4), rv);
    const sets = ['rate_value = @v'];
    if (req.body.is_declined != null) { rq.input('d', sql.Bit, req.body.is_declined ? 1 : 0); sets.push('is_declined = @d'); }
    if (req.body.remarks != null) { rq.input('rm', sql.NVarChar(sql.MAX), String(req.body.remarks)); sets.push('remarks = @rm'); }
    await rq.query(`UPDATE dbo.rate_rules SET ${sets.join(', ')} WHERE id = @id`);

    await audit(pool, { ruleId: id, insurer: cur.insurer, product: cur.product, action: 'update',
      oldRate: cur.rate_value, newRate: rv, empcode: req.user && req.user.empcode, note: req.body.note });
    res.json({ success: true, id, old_rate: cur.rate_value, new_rate: rv });
  } catch (err) { next(err); }
});

/** POST /rule — insert a new rate_rules row. */
router.post('/rule', async (req, res, next) => {
  try {
    const b = req.body || {};
    const insurer = String(b.insurer || '').trim();
    const product = String(b.product || '').trim();
    if (!insurer || !product) return res.status(400).json({ success: false, error: 'insurer and product are required' });
    const rv = Number(b.rate_value);
    if (!Number.isFinite(rv) || rv < 0) return res.status(400).json({ success: false, error: 'rate_value must be a non-negative number' });

    const src = rateSource(insurer, product);
    if (!src.editable) return res.status(409).json({ success: false, error: src.note, source: src.source, file: src.file });

    const pool = await getPool();
    // Target card: the one given, else the newest for this insurer.
    let cardId = parseInt(b.rate_card_id, 10);
    if (!Number.isInteger(cardId)) {
      const c = (await pool.request().input('i', sql.NVarChar(100), insurer)
        .query('SELECT TOP 1 id FROM dbo.rate_cards WHERE insurer = @i ORDER BY effective_from DESC, id DESC')).recordset[0];
      if (!c) return res.status(400).json({ success: false, error: `No rate card exists for ${insurer} to add the rule to` });
      cardId = c.id;
    }

    const num = (v) => (v === '' || v == null ? null : Number(v));
    const str = (v) => (v === '' || v == null ? null : String(v));
    const rq = pool.request()
      .input('card', sql.Int, cardId)
      .input('insurer', sql.NVarChar(100), insurer)
      .input('product', sql.NVarChar(50), product)
      .input('region', sql.NVarChar(200), str(b.region))
      .input('segment', sql.NVarChar(500), str(b.segment))
      .input('make', sql.NVarChar(500), str(b.make))
      .input('subtype', sql.NVarChar(200), str(b.sub_type))
      .input('fuel', sql.NVarChar(100), str(b.fuel_type))
      .input('ccmin', sql.Int, num(b.cc_band_min))
      .input('ccmax', sql.Int, num(b.cc_band_max))
      .input('wmin', sql.Decimal(10, 2), num(b.weight_band_min))
      .input('wmax', sql.Decimal(10, 2), num(b.weight_band_max))
      .input('vamin', sql.Int, num(b.vehicle_age_min))
      .input('vamax', sql.Int, num(b.vehicle_age_max))
      .input('smin', sql.Int, num(b.seating_capacity_min))
      .input('smax', sql.Int, num(b.seating_capacity_max))
      .input('vtier', sql.NVarChar(100), str(b.volume_tier))
      .input('rtype', sql.NVarChar(200), str(b.rate_type) || 'COMP')
      .input('applied', sql.VarChar(10), str(b.applied_on))
      .input('state', sql.VarChar(200), str(b.state))
      .input('rv', sql.Decimal(10, 4), rv)
      .input('decl', sql.Bit, b.is_declined ? 1 : 0)
      .input('rm', sql.NVarChar(sql.MAX), str(b.remarks));
    const ins = await rq.query(`
      INSERT INTO dbo.rate_rules
        (rate_card_id, insurer, product, region, segment, make, sub_type, fuel_type,
         cc_band_min, cc_band_max, weight_band_min, weight_band_max,
         vehicle_age_min, vehicle_age_max, seating_capacity_min, seating_capacity_max,
         volume_tier, rate_type, applied_on, state, rate_value, is_declined, remarks)
      OUTPUT INSERTED.id
      VALUES
        (@card, @insurer, @product, @region, @segment, @make, @subtype, @fuel,
         @ccmin, @ccmax, @wmin, @wmax, @vamin, @vamax, @smin, @smax,
         @vtier, @rtype, @applied, @state, @rv, @decl, @rm)`);
    const newId = ins.recordset[0].id;

    await audit(pool, { ruleId: newId, insurer, product, action: 'insert',
      oldRate: null, newRate: rv, empcode: req.user && req.user.empcode,
      note: `card ${cardId}` + (b.note ? ' · ' + b.note : '') });
    res.json({ success: true, id: newId, rate_card_id: cardId });
  } catch (err) { next(err); }
});

module.exports = router;
