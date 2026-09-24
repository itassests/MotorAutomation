/**
 * SBI General — School Bus payout guideline, w.e.f. 01-09-2026.
 *
 * Source: SBI email "School Bus Guideline" (Pankaj Tripathi, 12-Aug-2026),
 * supplied by USER 2026-09-24. Verbatim rules:
 *   - School Bus rates apply on UW-accepted proposals with LoB type "School Bus" only
 *   - Seating capacity 12+1 and above
 *   - Payout of 2% deducted on 12+1 seater; full payout for 18+1 seater and above
 *   - All-India RTOs allowed other than KL and MP, which are fully DECLINED
 *   - RTOs in TN and RJ paid 10% less than the agreed payout slab
 *     (their example: 73% for all states -> 63% for TN/RJ)
 *
 * Both deductions are PERCENTAGE POINTS, not relative — the circular's own
 * 73 -> 63 example fixes that for the 10, and the 2 is read the same way.
 *
 * Seating is TOTAL seats INCLUDING the driver (USER 2026-09-24), so
 * "12+1" = 13 and "18+1" = 19. Buses of 13-18 seats take the -2 points;
 * 19 and above take the full slab.
 *
 * This ADJUSTS whatever School-Bus base rate the engine already matched — it
 * never invents one — so it works regardless of which card supplies the base.
 */
const EFF_FROM = '2026-09-01';
const DECLINED = new Set(['KL', 'MP']);          // fully declined
const REDUCED = new Set(['TN', 'RJ']);           // 10 points below slab
const POINTS_REDUCED = 0.10;
const POINTS_SMALL_BUS = 0.02;
const MIN_SEATS = 13;    // 12+1
const FULL_SEATS = 19;   // 18+1

const norm = (s) => String(s || '').toUpperCase();

/** In force for this policy's risk-start date? */
function effOnOrAfterSept(params) {
  const d = String(params.effective_date || params.effectiveDate || params.riskStartDate || '').slice(0, 10);
  return !!d && d >= EFF_FROM;
}

/**
 * State for the KL/MP/TN/RJ carve-outs. RTO prefix is primary (MH12 -> MH);
 * the resolved region label is the fallback, because SBI's School-Bus rows are
 * filed under full state names ("KERALA", "MADHYA PRADESH", ...).
 */
function stateOf(rtoCode, regionLabel) {
  const rto = norm(rtoCode).replace(/[^A-Z0-9]/g, '');
  const m = rto.match(/^([A-Z]{2})\d/);
  if (m) return m[1];
  const r = norm(regionLabel);
  if (/KERALA/.test(r)) return 'KL';
  if (/MADHYA\s*PRADESH/.test(r)) return 'MP';
  if (/TAMIL\s*NADU/.test(r)) return 'TN';
  if (/RAJASTHAN/.test(r)) return 'RJ';
  return '';
}

/** Is this rule/policy the School Bus line? */
function isSchoolBus(segment, subType) {
  const hay = `${segment || ''} ${subType || ''}`;
  if (/other\s+than\s+school\s*bus/i.test(hay)) return false;   // explicit non-school row
  return /school\s*bus/i.test(hay);
}

/**
 * Apply the guideline to an already-matched School-Bus base rate.
 * @returns {{rate:number, declined:boolean, note:string}|null}
 *          null = guideline does not apply (leave the engine's rule untouched).
 */
function adjustSchoolBusRate(baseRate, params, regionLabel) {
  if (!effOnOrAfterSept(params)) return null;
  const base = Number(baseRate);
  if (!Number.isFinite(base) || base <= 0) return null;   // declined/zero stays as-is

  const st = stateOf(params.rtoCode, regionLabel);
  if (DECLINED.has(st)) {
    return { rate: 0, declined: true, note: `School Bus declined in ${st} (SBI Sep'26 guideline)` };
  }

  // "Seating capacity 12+1 and above" — below that the School-Bus slab does not
  // apply. We deliberately do NOT force a decline here (that would zero a payout
  // on our own initiative); the engine's normal matching stands instead.
  const seats = Number(params.seatingCapacity) || 0;
  if (seats > 0 && seats < MIN_SEATS) return null;

  let rate = base;
  const notes = [];
  if (REDUCED.has(st)) { rate -= POINTS_REDUCED; notes.push(`${st} -10pts`); }
  if (seats >= MIN_SEATS && seats < FULL_SEATS) { rate -= POINTS_SMALL_BUS; notes.push('12+1..17 -2pts'); }
  if (!notes.length) return null;                        // nothing to change

  rate = Math.max(0, +rate.toFixed(4));
  return { rate, declined: false, note: `SBI Sep'26 School Bus: ${notes.join(', ')}` };
}

module.exports = { adjustSchoolBusRate, isSchoolBus, stateOf, effOnOrAfterSept, EFF_FROM };
