/**
 * routes/policy-push.js — admin dashboard + controls for the mobile-app policy push.
 *
 *   GET  /summary            today/month/year × {submitted, pushed, failed, pending}
 *   GET  /list               paged rows (?page&size&status&from&to)
 *   GET  /failures           failed rows + error (?page&size)
 *   GET  /policy/:id         one queue row incl. payload_json
 *   POST /repush/:id         re-enqueue unchanged (status→1, retry=0, error=NULL)
 *   PUT  /policy/:id {payload}  correct payload_json then re-enqueue
 *   POST /backfill           start/resume the one-time backfill seeder
 *   GET  /backfill/status    seeder progress
 *
 * Admin-only (attachUser → requireAdmin). All state is in RateExtract (getPool()).
 */
const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { attachUser, requireAdmin } = require('./auth');

const router = express.Router();
router.use(attachUser());
router.use(requireAdmin);

// Status→bucket SUM(CASE) shared by /summary. submitted = all rows in window.
const STATUS_AGG =
  `COUNT(*) AS submitted,
   SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS pushed,
   SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) AS failed,
   SUM(CASE WHEN status IN (1, 4) THEN 1 ELSE 0 END) AS pending,
   SUM(CASE WHEN status = 5 THEN 1 ELSE 0 END) AS awaiting`;

/** GET /summary — counts bucketed by submission_date for today / this month / this year. */
router.get('/summary', async (req, res, next) => {
  try {
    const app = await getPool();
    const q = async (whereClause) =>
      (await app.request().query(`SELECT ${STATUS_AGG} FROM dbo.policy_push_queue WHERE ${whereClause}`)).recordset[0];
    const [today, month, year, all] = await Promise.all([
      q('submission_date = CONVERT(date, GETDATE())'),
      q('YEAR(submission_date) = YEAR(GETDATE()) AND MONTH(submission_date) = MONTH(GETDATE())'),
      q('YEAR(submission_date) = YEAR(GETDATE())'),
      q('1 = 1'),
    ]);
    res.json({ success: true, today, month, year, all });
  } catch (err) { next(err); }
});

/** GET /list — paged queue rows with optional status/date filters. */
router.get('/list', async (req, res, next) => {
  try {
    const app = await getPool();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(req.query.size, 10) || 50));
    const conds = ['1 = 1'];
    const rq = app.request();
    if (req.query.status) { rq.input('st', sql.TinyInt, parseInt(req.query.status, 10)); conds.push('status = @st'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { rq.input('from', sql.Date, req.query.from); conds.push('submission_date >= @from'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { rq.input('to', sql.Date, req.query.to); conds.push('submission_date <= @to'); }
    const where = conds.join(' AND ');
    rq.input('skip', sql.Int, (page - 1) * size).input('take', sql.Int, size);
    // Count with the same filter params bound on a separate request.
    const cntReq = app.request();
    if (req.query.status) cntReq.input('st', sql.TinyInt, parseInt(req.query.status, 10));
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) cntReq.input('from', sql.Date, req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) cntReq.input('to', sql.Date, req.query.to);
    const cnt = (await cntReq.query(`SELECT COUNT(*) AS n FROM dbo.policy_push_queue WHERE ${where}`)).recordset[0].n;
    const rows = (await rq.query(
      `SELECT id, prarambh_main_id, tracker_no, policy_no, submission_date, status, retry, pushed_at, updated_at
         FROM dbo.policy_push_queue WHERE ${where}
        ORDER BY updated_at DESC, id DESC OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY`)).recordset;
    res.json({ success: true, total: cnt, page, size, rows });
  } catch (err) { next(err); }
});

/** GET /failures — paged failed rows with their last error. */
router.get('/failures', async (req, res, next) => {
  try {
    const app = await getPool();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(req.query.size, 10) || 50));
    const cnt = (await app.request().query('SELECT COUNT(*) AS n FROM dbo.policy_push_queue WHERE status = 3')).recordset[0].n;
    const rows = (await app.request().input('skip', sql.Int, (page - 1) * size).input('take', sql.Int, size).query(
      `SELECT id, prarambh_main_id, tracker_no, policy_no, submission_date, retry, error, updated_at
         FROM dbo.policy_push_queue WHERE status = 3
        ORDER BY updated_at DESC, id DESC OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY`)).recordset;
    res.json({ success: true, count: cnt, page, size, rows });
  } catch (err) { next(err); }
});

/** GET /policy/:id — full queue row (incl. payload_json) for the detail/correct view. */
router.get('/policy/:id', async (req, res, next) => {
  try {
    const app = await getPool();
    const r = await app.request().input('id', sql.BigInt, req.params.id)
      .query('SELECT * FROM dbo.policy_push_queue WHERE id = @id');
    if (r.recordset.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, row: r.recordset[0] });
  } catch (err) { next(err); }
});

/** POST /repush/:id — re-enqueue unchanged (transient blips). */
router.post('/repush/:id', async (req, res, next) => {
  try {
    const app = await getPool();
    const r = await app.request().input('id', sql.BigInt, req.params.id).query(
      `UPDATE dbo.policy_push_queue SET status = 1, retry = 0, error = NULL, updated_at = GETDATE()
       OUTPUT INSERTED.id WHERE id = @id AND status <> 4`);
    if (r.recordset.length === 0) return res.status(409).json({ success: false, error: 'Not found or currently in-progress' });
    res.json({ success: true, id: r.recordset[0].id });
  } catch (err) { next(err); }
});

/** PUT /policy/:id — correct the payload then re-enqueue. Body: { payload: {...} }. */
router.put('/policy/:id', async (req, res, next) => {
  try {
    const payload = req.body && req.body.payload;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ success: false, error: 'payload (object) required' });
    }
    const app = await getPool();
    const r = await app.request()
      .input('id', sql.BigInt, req.params.id)
      .input('pl', sql.NVarChar(sql.MAX), JSON.stringify(payload))
      .query(`UPDATE dbo.policy_push_queue
                 SET payload_json = @pl, status = 1, retry = 0, error = NULL, updated_at = GETDATE()
               OUTPUT INSERTED.id WHERE id = @id AND status <> 4`);
    if (r.recordset.length === 0) return res.status(409).json({ success: false, error: 'Not found or currently in-progress' });
    res.json({ success: true, id: r.recordset[0].id });
  } catch (err) { next(err); }
});

/** POST /backfill — kick off (or resume) the one-time backfill seeder. */
router.post('/backfill', async (req, res, next) => {
  try {
    const app = await getPool();
    await app.request().query(
      "UPDATE dbo.policy_push_meta SET backfill_started_at = COALESCE(backfill_started_at, GETDATE()), backfill_done = 0 WHERE meta_key = 'default'");
    const m = (await app.request().query(
      "SELECT backfill_started_at, backfill_done, backfill_seeded FROM dbo.policy_push_meta WHERE meta_key = 'default'")).recordset[0];
    res.json({ success: true, started_at: m.backfill_started_at, done: !!m.backfill_done, seeded: m.backfill_seeded });
  } catch (err) { next(err); }
});

/** GET /backfill/status — seeder progress + a source total estimate. */
router.get('/backfill/status', async (req, res, next) => {
  try {
    const app = await getPool();
    const m = (await app.request().query(
      "SELECT backfill_started_at, backfill_cursor_id, backfill_done, backfill_seeded, last_daily_date FROM dbo.policy_push_meta WHERE meta_key = 'default'")).recordset[0] || {};
    let totalEstimate = null;
    try {
      const live = await getPrarambhPool();
      totalEstimate = (await live.request()
        .query("SELECT COUNT(*) AS n FROM dbo.TRN_PrarambhMain WITH (NOLOCK) WHERE SubmissionDate >= '2026-04-01' AND InsuranceType = 16")).recordset[0].n;
    } catch (_) { /* estimate is best-effort */ }
    res.json({
      success: true,
      started_at: m.backfill_started_at, done: !!m.backfill_done,
      seeded: m.backfill_seeded, cursor: m.backfill_cursor_id,
      last_daily_date: m.last_daily_date, totalEstimate,
    });
  } catch (err) { next(err); }
});

module.exports = router;
