/**
 * Tonnage fallback from Prarambh_Live.TRN_PrarambhMotorDetails.
 *
 * The view vw_NewTempPrarambhExcelMotorDownload doesn't expose vehicle GVW
 * directly — VehicalCategory text gives a coarse band (e.g. "7.5-12Tn")
 * but doesn't help when missing. The TRN_PrarambhMotorDetails table has
 * a `Tonnes` column (decimal, sometimes stored in KG when > 1000) joined
 * by PrarambhMainId = view's ID.
 *
 * Usage:
 *   - fetchTonnage(pool, mainId)            → Number (in tonnes) or null
 *   - fetchTonnageMap(pool, [id1, id2…])    → Map<id, tonnes>  (batched)
 */
const sql = require('mssql');

function normaliseTonnes(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // The `Tonnes` column stores KG (misnamed) — observed values are integers
  // like 975 (Piaggio Ape), 2670, 10250 (small truck). Convert to tonnes by
  // ÷ 1000 when the value looks like KG (> 50). Anything ≤ 50 is plausibly
  // already in tonnes (no vehicle weighs 50 KG) — pass through unchanged.
  return n > 50 ? +(n / 1000).toFixed(3) : n;
}

async function fetchTonnage(pool, mainId) {
  if (!pool || !mainId) return null;
  try {
    const r = await pool.request()
      .input('id', sql.BigInt, mainId)
      .query('SELECT TOP 1 Tonnes FROM TRN_PrarambhMotorDetails WHERE PrarambhMainId = @id');
    if (r.recordset.length === 0) return null;
    return normaliseTonnes(r.recordset[0].Tonnes);
  } catch (e) {
    console.warn('[prarambh-tonnage] lookup failed:', e.message);
    return null;
  }
}

async function fetchTonnageMap(pool, ids) {
  const out = new Map();
  if (!pool || !ids || ids.length === 0) return out;
  // Chunk to keep IN list manageable (SQL Server caps at 2100 params; we
  // use raw IDs inline to dodge param limit but cap each batch at 1000
  // rows to keep query plans efficient).
  const clean = [...new Set(ids.filter(Boolean).map(String))];
  for (let i = 0; i < clean.length; i += 1000) {
    const batch = clean.slice(i, i + 1000);
    const inList = batch.map(id => Number(id)).filter(Number.isFinite).join(',');
    if (!inList) continue;
    try {
      const r = await pool.request().query(
        `SELECT PrarambhMainId, Tonnes FROM TRN_PrarambhMotorDetails WHERE PrarambhMainId IN (${inList})`
      );
      for (const row of r.recordset) {
        const t = normaliseTonnes(row.Tonnes);
        if (t != null) out.set(String(row.PrarambhMainId), t);
      }
    } catch (e) {
      console.warn('[prarambh-tonnage] batch lookup failed:', e.message);
    }
  }
  return out;
}

/**
 * Fetch RTO_Code + registration + fuel from
 * Prarambh_Live.TRN_PrarambhMotorDetails, keyed by PrarambhMainId.
 * Returns Map<mainId, { rto, reg, fuel }>. Used as the LAST fallback when
 * tmp_PrarambhData (and the Premium Register) lack a usable RTO / fuel.
 */
async function fetchRtoMap(pool, ids) {
  const out = new Map();
  if (!pool || !ids || ids.length === 0) return out;
  const clean = [...new Set(ids.filter(Boolean).map(String))];
  for (let i = 0; i < clean.length; i += 1000) {
    const batch = clean.slice(i, i + 1000);
    const inList = batch.map(id => Number(id)).filter(Number.isFinite).join(',');
    if (!inList) continue;
    try {
      // NCB is stored as a slab CODE in d.NCB, not a percent. The percent lives
      // in MST_FieldMasters (MasterId=9310): f.Value = the code, f.Name = the
      // NCB percent. Code 1 = 0% (new / no NCB), 2 = 20, 3 = 25, 4 = 35,
      // 5 = 45, 6 = 50, 7 = 65, 8 = 55. Code 0/null = NCB unknown (no join row).
      // Joining here lets callers read the resolved percent directly.
      const r = await pool.request().query(
        `SELECT d.PrarambhMainId, d.RTO_Code, d.VEHICLE_REGISTRATION_NO,
                d.FUELTYPE, d.VEHICAL_FUELTYPE, d.CC, d.PRODUCT_TYPE_Id,
                d.NCB AS NCB_Code, f.Name AS NCB_Pct
         FROM TRN_PrarambhMotorDetails d
         LEFT JOIN MST_FieldMasters f ON f.MasterId = 9310 AND f.Value = d.NCB
         WHERE d.PrarambhMainId IN (${inList})`
      );
      for (const row of r.recordset) {
        // Resolved NCB percent: a finite number (0 means explicitly "no NCB"),
        // or null when the code didn't resolve (unknown — caller falls back).
        const p = parseFloat(row.NCB_Pct);
        const ncb = Number.isFinite(p) ? p : null;
        out.set(String(row.PrarambhMainId), {
          rto: row.RTO_Code,
          reg: row.VEHICLE_REGISTRATION_NO,
          fuel: row.FUELTYPE || row.VEHICAL_FUELTYPE || null,
          cc: row.CC,
          productTypeId: row.PRODUCT_TYPE_Id,
          ncb,
        });
      }
    } catch (e) {
      console.warn('[prarambh-tonnage] rto/fuel batch lookup failed:', e.message);
    }
  }
  return out;
}

/**
 * Fetch OD/TP policy-term dates from Prarambh_Live.TRN_PrarambhMotorMISUpdation
 * (keyed by PrarambhMainId) and collapse them into a tenure bucket:
 *   '1+1'  annual OD + annual TP
 *   '1+5'  annual OD + multi-year TP (bundled new vehicle)
 *   '5+5'  multi-year OD + multi-year TP (long-term)
 * Returns Map<mainId, '1+1'|'1+5'|'5+5'>. Rows whose dates don't resolve a
 * usable year span are omitted (caller treats absence as "tenure unknown").
 */
function diffYears(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b) - new Date(a);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / (365.25 * 24 * 3600 * 1000));
}
function bucketFromYears(od, tp) {
  // Use whichever side is known; long-term on either OD or TP implies a
  // multi-year product. Annual on both → 1+1.
  const o = od && od >= 1 ? od : null;
  const t = tp && tp >= 1 ? tp : null;
  if (o == null && t == null) return null;
  const oLong = o != null && o >= 2;
  const tLong = t != null && t >= 2;
  if (oLong && tLong) return '5+5';
  if (!oLong && tLong) return '1+5';
  if (oLong && !tLong) return '5+5'; // long OD, annual TP → still long-term grid
  return '1+1';                       // both annual
}
async function fetchTenureMap(pool, ids) {
  const out = new Map();
  if (!pool || !ids || ids.length === 0) return out;
  const clean = [...new Set(ids.filter(Boolean).map(String))];
  for (let i = 0; i < clean.length; i += 1000) {
    const batch = clean.slice(i, i + 1000);
    const inList = batch.map(id => Number(id)).filter(Number.isFinite).join(',');
    if (!inList) continue;
    try {
      const r = await pool.request().query(
        `SELECT PrarambhMainId, OD_Start_Date, OD_End_Date,
                TP_POLICY_START_DATE, TP_POLICY_END_DATE
         FROM TRN_PrarambhMotorMISUpdation WHERE PrarambhMainId IN (${inList})`
      );
      for (const row of r.recordset) {
        const od = diffYears(row.OD_Start_Date, row.OD_End_Date);
        const tp = diffYears(row.TP_POLICY_START_DATE, row.TP_POLICY_END_DATE);
        const b = bucketFromYears(od, tp);
        if (b) out.set(String(row.PrarambhMainId), b);
      }
    } catch (e) {
      console.warn('[prarambh-tonnage] tenure batch lookup failed:', e.message);
    }
  }
  return out;
}

/**
 * Batch-fetch the Nil-Dep (zero-depreciation) cover flag from
 * Prarambh_Live.TRN_PrarambhMotorDetails.Depreciation, keyed by PrarambhMainId.
 *   Depreciation = 1 → Nil-Dep cover YES (zero-dep add-on present)
 *   Depreciation = 2 → Nil-Dep cover NO  (ordinary depreciation applies)
 * Returns Map<String(mainId), Number(depreciation)>. Rows with a NULL/blank
 * Depreciation are omitted (caller defaults them to "No").
 */
async function fetchDepreciationMap(pool, ids) {
  const out = new Map();
  if (!pool || !ids || ids.length === 0) return out;
  const clean = [...new Set(ids.filter(Boolean).map(String))];
  for (let i = 0; i < clean.length; i += 1000) {
    const batch = clean.slice(i, i + 1000);
    const inList = batch.map(id => Number(id)).filter(Number.isFinite).join(',');
    if (!inList) continue;
    try {
      const r = await pool.request().query(
        `SELECT PrarambhMainId, Depreciation
         FROM TRN_PrarambhMotorDetails WHERE PrarambhMainId IN (${inList})`
      );
      for (const row of r.recordset) {
        const d = parseInt(row.Depreciation, 10);
        if (Number.isFinite(d)) out.set(String(row.PrarambhMainId), d);
      }
    } catch (e) {
      console.warn('[prarambh-tonnage] depreciation batch lookup failed:', e.message);
    }
  }
  return out;
}

module.exports = { fetchTonnage, fetchTonnageMap, normaliseTonnes, fetchRtoMap, fetchTenureMap, fetchDepreciationMap };
