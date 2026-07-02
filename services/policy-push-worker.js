/**
 * services/policy-push-worker.js — durable, server-side policy-push processor.
 *
 * Runs ONLY when POLICY_PUSH_ENABLED=1 (default OFF; enable on ONE host). Each tick:
 *   1) runDailyEnqueue — once per day, enqueue the previous day's submissions.
 *   2) seedBackfill     — one Id-cursor page of TRN_PrarambhMain >= 2026-04-01 (one-time).
 *   3) drainQueue       — claim a batch of pending rows, build payload, push, mark done/failed.
 *
 * State lives in RateExtract (policy_push_queue, policy_push_meta) so it resumes
 * after any restart. Prarambh_Live is read-only (source of identity + payload).
 *
 * Config: POLICY_PUSH_ENABLED, POLICY_PUSH_TICK_MS, PUSH_BATCH_PER_TICK,
 *         PUSH_SEED_BATCH, POLICY_PUSH_MAX_RETRY, POLICY_PUSH_BACKFILL_FROM.
 */
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { getToken, pushData, buildPayload, DRYRUN } = require('./policy-push-api');

const ENABLED = String(process.env.POLICY_PUSH_ENABLED || '0') === '1';
const TICK_MS = parseInt(process.env.POLICY_PUSH_TICK_MS || '10000', 10);
const BATCH_PER_TICK = parseInt(process.env.PUSH_BATCH_PER_TICK || '20', 10);
const SEED_BATCH = parseInt(process.env.PUSH_SEED_BATCH || '1000', 10);
const MAX_RETRY = parseInt(process.env.POLICY_PUSH_MAX_RETRY || '3', 10);
const BACKFILL_FROM = (process.env.POLICY_PUSH_BACKFILL_FROM || '2026-04-01').trim();
const INSERT_CHUNK = 500;   // rows per insert (×3 params < 2100 SQL limit)

let _running = false;
let _started = false;

const errMsg = (e) => (e && (e.message || String(e))) || 'unknown error';

/* ------------------------------------------------------------------ meta ---- */
async function readMeta(app) {
  const r = await app.request().query(
    "SELECT backfill_started_at, backfill_cursor_id, backfill_done, backfill_seeded, last_daily_date " +
    "FROM dbo.policy_push_meta WHERE meta_key = 'default'");
  return r.recordset[0] || {};
}

/**
 * Insert identity rows into the queue, skipping any already present (unique index
 * on prarambh_main_id). rows = [{id, trk, sd}]. Returns count inserted.
 */
async function insertIfAbsent(app, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const rq = app.request();
    const tuples = chunk.map((r, j) => {
      rq.input('id' + j, sql.BigInt, r.id);
      rq.input('trk' + j, sql.NVarChar(200), r.trk || null);
      rq.input('sd' + j, sql.Date, r.sd);
      return `(@id${j}, @trk${j}, @sd${j})`;
    });
    const res = await rq.query(
      `INSERT INTO dbo.policy_push_queue (prarambh_main_id, tracker_no, submission_date, status)
       SELECT v.id, v.trk, v.sd, 1
       FROM (VALUES ${tuples.join(',')}) v(id, trk, sd)
       WHERE NOT EXISTS (SELECT 1 FROM dbo.policy_push_queue q WHERE q.prarambh_main_id = v.id)`);
    inserted += res.rowsAffected[0] || 0;
  }
  return inserted;
}

/* --------------------------------------------------------------- backfill --- */
async function seedBackfill(app, live) {
  const meta = await readMeta(app);
  if (meta.backfill_done) return;
  if (!meta.backfill_started_at) return;   // not kicked off yet (admin POST /backfill)

  const cursor = meta.backfill_cursor_id != null ? Number(meta.backfill_cursor_id) : 0;
  const rows = (await live.request()
    .input('from', sql.Date, BACKFILL_FROM)
    .input('cursor', sql.BigInt, cursor)
    .input('take', sql.Int, SEED_BATCH)
    .query(`SELECT TOP (@take) m.Id AS id, m.TrackerNo AS trk, CONVERT(date, m.SubmissionDate) AS sd
              FROM dbo.TRN_PrarambhMain m WITH (NOLOCK)
             WHERE m.SubmissionDate >= @from AND m.Id > @cursor AND m.InsuranceType = 16
               AND m.TrackerNo NOT LIKE '%/DUM/%'
             ORDER BY m.Id ASC`)).recordset;

  if (rows.length === 0) {
    await app.request().query("UPDATE dbo.policy_push_meta SET backfill_done = 1 WHERE meta_key = 'default'");
    console.log('[policy-push] backfill complete');
    return;
  }
  const inserted = await insertIfAbsent(app, rows);
  const maxId = rows[rows.length - 1].id;
  await app.request().input('cur', sql.BigInt, maxId).input('n', sql.Int, inserted)
    .query("UPDATE dbo.policy_push_meta SET backfill_cursor_id = @cur, backfill_seeded = backfill_seeded + @n WHERE meta_key = 'default'");
}

/* ------------------------------------------------------------- daily job ---- */
async function runDailyEnqueue(app, live) {
  const meta = await readMeta(app);
  // "Yesterday" per the DB clock; guarded so it runs at most once per day.
  const y = (await app.request().query("SELECT CONVERT(date, DATEADD(day, -1, GETDATE())) AS d")).recordset[0].d;
  const yIso = new Date(y).toISOString().slice(0, 10);
  const lastIso = meta.last_daily_date ? new Date(meta.last_daily_date).toISOString().slice(0, 10) : null;
  if (lastIso === yIso) return;

  const rows = (await live.request().input('d', sql.Date, yIso)
    .query(`SELECT m.Id AS id, m.TrackerNo AS trk, CONVERT(date, m.SubmissionDate) AS sd
              FROM dbo.TRN_PrarambhMain m WITH (NOLOCK)
             WHERE CONVERT(date, m.SubmissionDate) = @d AND m.InsuranceType = 16
               AND m.TrackerNo NOT LIKE '%/DUM/%'`)).recordset;
  const inserted = await insertIfAbsent(app, rows);
  // Re-activate deferred rows (status 5 = awaiting policy number) once a day — a
  // policy issued since the last attempt now has a number and can push.
  await app.request().query('UPDATE dbo.policy_push_queue SET status = 1, error = NULL, updated_at = GETDATE() WHERE status = 5');
  await app.request().input('d', sql.Date, yIso)
    .query("UPDATE dbo.policy_push_meta SET last_daily_date = @d WHERE meta_key = 'default'");
  if (inserted > 0) console.log(`[policy-push] daily enqueue ${yIso}: +${inserted}`);
}

/* ------------------------------------------------------------ push drain ---- */
/** Build the push payload for a policy from the live view (keyed by tracker). */
async function buildPayloadFromView(live, row) {
  if (!row.tracker_no) throw new Error('no tracker_no to resolve payload');
  // Single indexed row by tracker → SELECT * is safe here (the /lookup path does
  // the same); buildPayload picks the ~60 fields it needs from the 262-col view.
  const r = await live.request().input('t', sql.NVarChar(200), row.tracker_no).query(
    `SELECT TOP 1 * FROM dbo.vw_NewTempPrarambhExcelMotorDownload WHERE [TRACKER NO] = @t`);
  if (r.recordset.length === 0) throw new Error(`policy not found in view for tracker ${row.tracker_no}`);
  const view = r.recordset[0];
  return { payload: buildPayload(view), policyNo: view['POLICY NO'] || null };
}

async function drainQueue(app, live) {
  for (let i = 0; i < BATCH_PER_TICK; i++) {
    // Claim one pending row atomically (skip locked rows so concurrent ticks/hosts don't collide).
    const claim = await app.request().query(
      `UPDATE TOP (1) q SET q.status = 4, q.updated_at = GETDATE()
       OUTPUT INSERTED.id, INSERTED.prarambh_main_id, INSERTED.tracker_no,
              INSERTED.policy_no, INSERTED.retry, INSERTED.payload_json
       FROM dbo.policy_push_queue q WITH (READPAST, ROWLOCK, UPDLOCK) WHERE q.status = 1`);
    if (claim.recordset.length === 0) break;
    const row = claim.recordset[0];
    try {
      let payload, policyNo = row.policy_no;
      if (row.payload_json) {                 // corrected repush → use the stored/edited payload
        payload = JSON.parse(row.payload_json);
        if (payload && payload.policyNo) policyNo = payload.policyNo;
      } else {
        const built = await buildPayloadFromView(live, row);
        payload = built.payload; policyNo = built.policyNo;
      }
      // The mobile API upserts by policy_number, so a blank one would create a
      // junk record. Not-yet-issued policies have no number yet — DEFER them
      // (status 5 "awaiting policy number"), re-activated daily until issued.
      if (!policyNo || String(policyNo).trim() === '') {
        await app.request().input('id', sql.BigInt, row.id)
          .query("UPDATE dbo.policy_push_queue SET status = 5, error = 'awaiting policy number', updated_at = GETDATE() WHERE id = @id");
        continue;
      }
      const token = await getToken();
      await pushData(payload, token);
      await app.request()
        .input('id', sql.BigInt, row.id)
        .input('p', sql.NVarChar(200), policyNo)
        .input('pl', sql.NVarChar(sql.MAX), JSON.stringify(payload))
        .query(`UPDATE dbo.policy_push_queue
                   SET status = 2, pushed_at = GETDATE(), error = NULL,
                       policy_no = @p, payload_json = @pl, updated_at = GETDATE()
                 WHERE id = @id`);
    } catch (err) {
      const next = (row.retry || 0) + 1;
      const status = next < MAX_RETRY ? 1 : 3;
      await app.request()
        .input('id', sql.BigInt, row.id).input('s', sql.TinyInt, status)
        .input('r', sql.Int, next).input('e', sql.NVarChar(sql.MAX), errMsg(err).slice(0, 3900))
        .query('UPDATE dbo.policy_push_queue SET status = @s, retry = @r, error = @e, updated_at = GETDATE() WHERE id = @id');
    }
  }
}

/* ----------------------------------------------------------------- tick ----- */
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const app = await getPool();
    const live = await getPrarambhPool();
    await runDailyEnqueue(app, live);
    await seedBackfill(app, live);
    await drainQueue(app, live);
  } catch (err) {
    console.warn('[policy-push] tick error:', errMsg(err));
  } finally {
    _running = false;
  }
}

async function startWorker() {
  if (_started) return;
  if (!ENABLED) { console.log('[policy-push] disabled (set POLICY_PUSH_ENABLED=1 on ONE host to run)'); return; }
  _started = true;
  try {
    const app = await getPool();
    await app.request().query('UPDATE dbo.policy_push_queue SET status = 1 WHERE status IN (4, 5)');   // reclaim stale in-progress + retry deferred
  } catch (err) { console.warn('[policy-push] startup reclaim skipped:', errMsg(err)); }
  setInterval(tick, TICK_MS);
  console.log(`[policy-push] started (tick ${TICK_MS}ms, ${BATCH_PER_TICK}/tick, dryRun=${DRYRUN})`);
}

module.exports = { startWorker, tick, seedBackfill, runDailyEnqueue, drainQueue };
