/**
 * Repair blank INSURERNAME on staging rows from Prarambh_Live.
 *
 * tmp_PrarambhData (UAT) sometimes lands a policy with an empty INSURERNAME.
 * Because the bulk source query restricts "All insurers" to carriers that have
 * a live rate card, those rows were dropped BEFORE pricing and never surfaced
 * as a "no rule" row — the Sept'26 cycle quietly lost 801 of them.
 *
 * The authoritative current-insurer value lives in
 * Prarambh_Live.TRN_PrarambhReportedFields.INSURERNAME, keyed by
 * PrarambhMainId (= tmp_PrarambhData.ID). We read it back and fill the gap.
 *
 * NOTE ON TRN_PrarambhMain.OCR_Insurer: that column is populated far more
 * often, but it is the OCR-captured EXPIRING insurer on a renewal (see
 * routes/employee.js, which compares it against the current r.InsurerId to
 * split same-insurer vs different-insurer renewals). Filling the CURRENT
 * insurer from it would price a switched-carrier renewal against the previous
 * carrier's grid, so it is deliberately NOT used as a fallback here.
 */

const { getPrarambhPool } = require('../db/prarambh-connection');

const isBlank = (v) => !String(v == null ? '' : v).trim();

/**
 * Fill INSURERNAME in place for rows that have none.
 *
 * @param {Array<object>} rows  staging rows carrying `ID` (= PrarambhMainId)
 * @returns {Promise<{attempted:number, repaired:number, unresolved:number, byInsurer:object}>}
 */
async function repairBlankInsurerNames(rows) {
  const out = { attempted: 0, repaired: 0, unresolved: 0, byInsurer: {} };
  if (!Array.isArray(rows) || rows.length === 0) return out;

  const gaps = rows.filter((r) => isBlank(r.INSURERNAME) && r.ID != null);
  out.attempted = gaps.length;
  if (gaps.length === 0) return out;

  const ids = [...new Set(gaps.map((r) => String(r.ID)).filter((x) => /^\d+$/.test(x)))];
  if (ids.length === 0) { out.unresolved = gaps.length; return out; }

  const byId = new Map();
  const pool = await getPrarambhPool();
  // Chunked so a wide cycle window cannot blow the 2100-parameter / expression
  // limit on the IN list.
  const CHUNK = 900;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const res = await pool.request().query(
      `SELECT PrarambhMainId, INSURERNAME
         FROM TRN_PrarambhReportedFields WITH (NOLOCK)
        WHERE ISACTIVE = 1
          AND LTRIM(RTRIM(ISNULL(INSURERNAME, ''))) <> ''
          AND PrarambhMainId IN (${slice.join(',')})`
    );
    for (const r of res.recordset) {
      // PrarambhMainId is a bigint — the driver hands those back as STRINGS,
      // so key the map on the string form and look up the same way. Keying on
      // Number() silently matched nothing.
      const k = String(r.PrarambhMainId);
      if (!byId.has(k)) byId.set(k, String(r.INSURERNAME).trim());
    }
  }

  for (const r of gaps) {
    const name = byId.get(String(r.ID));
    if (name) {
      r.INSURERNAME = name;
      r._insurer_name_repaired = true;
      out.repaired += 1;
      out.byInsurer[name] = (out.byInsurer[name] || 0) + 1;
    } else {
      out.unresolved += 1;
    }
  }
  return out;
}

module.exports = { repairBlankInsurerNames };
