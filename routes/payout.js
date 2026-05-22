/**
 * Payout Summary — agent-wise aggregation of outgoing + NOP + statement match
 * over a billing cycle.
 *
 * Reuses the exact same per-policy pipeline as /api/bulk/calculate (rate
 * lookup → margin match → statement match → outgoing = income − savings),
 * then groups the resulting rows by POS code (`agent_code`) + agent name.
 *
 * Inputs (JSON body):
 *   month        — 1..12 (optional if date_from/date_to are supplied)
 *   year         — YYYY  (optional if date_from/date_to are supplied)
 *   date_from    — YYYY-MM-DD (overrides month/year derivation)
 *   date_to      — YYYY-MM-DD
 *   insurer_name — optional narrow-down
 *   limit        — row cap (default 20000)
 *
 * Output:
 *   { success, cycle: { from, to }, totals: {...}, agents: [...] }
 *   agents[]: { agent_code, agent_name, nop, outgoing, statement_matched,
 *               statement_amount, income, variance }
 */

const express = require('express');
const bulkRouter = require('./bulk');
const { getPool } = require('../db/connection');

const router = express.Router();

/** Decode {month, year} → {from, to} as the default cycle = full month. */
function cycleFromMonthYear(month, year) {
  if (!month || !year) return { from: null, to: null };
  const m = Math.max(1, Math.min(12, parseInt(month, 10)));
  const y = parseInt(year, 10);
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const to   = new Date(Date.UTC(y, m, 0, 23, 59, 59)); // last day of month
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

/** POST / — build payout summary for the given filters. */
router.post('/summary', async (req, res, next) => {
  try {
    const { month, year, date_from, date_to, insurer_name, limit, cycle_id } = req.body || {};

    // Resolve cycle window. If a cycle_id is given, fetch its dates +
    // agent allowlist (overrides the body's date_from/date_to/agent set).
    let from = date_from || null;
    let to   = date_to   || null;
    let cycleAllowlist = null;
    if (cycle_id) {
      try {
        const sql = require('mssql');
        const localPool = await getPool();
        const r = await localPool.request().input('id', sql.Int, Number(cycle_id))
          .query('SELECT date_from, date_to, agent_codes_csv FROM payout_cycles WHERE id = @id AND active = 1');
        if (r.recordset.length > 0) {
          const c = r.recordset[0];
          from = c.date_from instanceof Date ? c.date_from.toISOString().slice(0, 10) : c.date_from;
          to   = c.date_to   instanceof Date ? c.date_to.toISOString().slice(0, 10)   : c.date_to;
          if (c.agent_codes_csv) {
            cycleAllowlist = new Set(
              String(c.agent_codes_csv).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
            );
          }
        }
      } catch (_) { /* fall through to month/year fallback */ }
    }
    if (!from || !to) {
      const c = cycleFromMonthYear(month, year);
      from = from || c.from;
      to   = to   || c.to;
    }

    // Delegate heavy lifting to runBulkCalculate (same pipeline as Bulk screen).
    const bulk = await bulkRouter.runBulkCalculate({
      insurer_name: insurer_name || undefined,
      date_from: from,
      date_to:   to,
      limit: Math.min(parseInt(limit || '20000', 10) || 20000, 50000),
    });

    // Cycle agent allowlist — if set, drop rows whose agent_code isn't in
    // the list. Done before grouping so excluded counts don't include them.
    if (cycleAllowlist && cycleAllowlist.size > 0) {
      bulk.rows = (bulk.rows || []).filter(r => {
        const code = String(r.agent_code || '').trim().toUpperCase();
        return code && cycleAllowlist.has(code);
      });
    }

    // Group rows by agent_code + agent_name. Inner-join semantics: skip
    // policies whose UPIN_CODE has no match in beeinsured_v3_2.tmp_poscodes
    // (i.e. `agent_pos_matched` is false) so the summary only reflects active
    // POS records. Excluded rows are still returned separately so the UI can
    // drill into them.
    const byAgent = new Map();
    const excludedRows = [];
    const EXCLUDED_CAP = 2000; // cap so a huge cycle doesn't blow up the response
    let excludedCount = 0;
    for (const row of bulk.rows || []) {
      if (!row.agent_pos_matched) {
        excludedCount++;
        if (excludedRows.length < EXCLUDED_CAP) {
          excludedRows.push({
            policy_no: row.policy_no,
            tracker_no: row.tracker_no,
            insurer: row.insurer,
            vehicle_type: row.vehicle_type,
            make: row.make,
            model: row.model,
            rto_code: row.rto_code,
            region: row.region,
            agent_code: row.agent_code,      // the UPIN_CODE that had no match
            agent_name: row.agent_name,      // whatever fallback name (email / created-by)
            rm_name: row.rm_name,
            premium_base: row.premium_base,
            rate_pct: row.rate_pct,
            income: row.income,
            outgoing: row.outgoing,
            statement_amount: row.statement_amount,
            statement_period: row.statement_period,
            status: row.status,
            note: row.note,
          });
        }
        continue;
      }
      const code = (row.agent_code || 'UNKNOWN').toString().trim() || 'UNKNOWN';
      const name = row.agent_name || '—';
      const key  = code + '||' + name;
      let a = byAgent.get(key);
      if (!a) {
        a = {
          agent_code: code,
          agent_name: name,
          agent_pos_source: row.agent_pos_source || null,  // 'pos' | 'maagent'
          agent_location: row.agent_location || null,
          agent_zone: row.agent_zone || null,
          nop: 0,
          income: 0,
          outgoing: 0,
          savings: 0,
          statement_matched: 0,
          statement_amount: 0,
          status_ok: 0, status_ex: 0, status_scr: 0, status_cnr: 0,
        };
        byAgent.set(key, a);
      }
      a.nop += 1;
      a.income   += row.income   || 0;
      a.outgoing += row.outgoing || 0;
      a.savings  += row.savings  || 0;
      if (row.statement_amount != null) {
        a.statement_matched += 1;
        a.statement_amount  += row.statement_amount || 0;
      }
      switch (row.status) {
        case 'OK':  a.status_ok++;  break;
        case 'EX':  a.status_ex++;  break;
        case 'SCR': a.status_scr++; break;
        case 'CNR': a.status_cnr++; break;
      }
    }
    // Pull pending recoveries (CQB / cancellations from earlier cycles) for
    // every agent in this batch. Each agent's payout is reduced by the
    // outstanding (unrecovered) amount, capped at their outgoing.
    let recoveriesByAgent = new Map();
    try {
      const codes = [...byAgent.values()]
        .map(a => String(a.agent_code || '').trim())
        .filter(c => c && c !== 'UNKNOWN');
      if (codes.length > 0) {
        const sql = require('mssql');
        const localPool = await getPool();
        const recoveriesByCode = new Map();
        const CHUNK = 500;
        for (let i = 0; i < codes.length; i += CHUNK) {
          const chunk = codes.slice(i, i + CHUNK);
          const rq = localPool.request();
          const params = chunk.map((c, j) => {
            rq.input('c' + j, sql.NVarChar(100), c);
            return '@c' + j;
          });
          const r = await rq.query(
            `SELECT id, agent_code, policy_no, recovery_amount, applied_amount,
                    reason, original_cycle_id, status
             FROM agent_recoveries
             WHERE status = 'pending' AND agent_code IN (${params.join(',')})`
          );
          for (const row of r.recordset) {
            const key = String(row.agent_code).trim();
            if (!recoveriesByCode.has(key)) recoveriesByCode.set(key, []);
            const remaining = +(Number(row.recovery_amount) - Number(row.applied_amount || 0)).toFixed(2);
            recoveriesByCode.get(key).push({ ...row, remaining });
          }
        }
        recoveriesByAgent = recoveriesByCode;
      }
    } catch (e) { console.error('[payout] recovery lookup skipped:', e.message); }

    const agents = [...byAgent.values()].map(a => {
      const recList = recoveriesByAgent.get(String(a.agent_code).trim()) || [];
      const recoveryDue = +recList.reduce((s, r) => s + Number(r.remaining || 0), 0).toFixed(2);
      const outgoing = +a.outgoing.toFixed(2);
      // Net payable can't go negative — if recoveries exceed outgoing the
      // unrecovered balance carries forward to the next cycle.
      const netPayable = +Math.max(0, outgoing - recoveryDue).toFixed(2);
      const recoveryAppliedHere = +Math.min(recoveryDue, outgoing).toFixed(2);
      return {
        ...a,
        income:   +a.income.toFixed(2),
        outgoing,
        savings:  +a.savings.toFixed(2),
        statement_amount: +a.statement_amount.toFixed(2),
        variance: +(a.statement_amount - a.outgoing).toFixed(2),
        recovery_pending:    recoveryDue,
        recovery_applicable: recoveryAppliedHere,
        recovery_carry_fwd:  +(recoveryDue - recoveryAppliedHere).toFixed(2),
        net_payable:         netPayable,
        recoveries:          recList.map(r => ({
          id: r.id, policy_no: r.policy_no,
          recovery_amount: +Number(r.recovery_amount).toFixed(2),
          applied_amount:  +Number(r.applied_amount || 0).toFixed(2),
          remaining:       r.remaining,
          reason:          r.reason,
          original_cycle_id: r.original_cycle_id,
        })),
      };
    }).sort((a, b) => b.outgoing - a.outgoing);

    res.json({
      success: true,
      cycle: { from, to },
      excluded_unmatched: excludedCount,
      excluded_rows: excludedRows,
      excluded_rows_capped: excludedCount > excludedRows.length,
      totals: {
        nop: (bulk.processed || 0) - excludedCount,
        nop_total_fetched: bulk.processed,
        income:   +((bulk.totals && bulk.totals.income   ) || 0).toFixed(2),
        outgoing: +((bulk.totals && bulk.totals.outgoing ) || 0).toFixed(2),
        savings:  +((bulk.totals && bulk.totals.savings  ) || 0).toFixed(2),
        statement_amount:  +((bulk.totals && bulk.totals.statement_amount) || 0).toFixed(2),
        statement_matched: (bulk.totals && bulk.totals.matched_statements) || 0,
        matched_rules:     (bulk.totals && bulk.totals.matched_rules) || 0,
        matched_margins:   (bulk.totals && bulk.totals.matched_margins) || 0,
      },
      agents,
      agent_count: agents.length,
    });
  } catch (err) { next(err); }
});

module.exports = router;
