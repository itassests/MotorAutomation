/**
 * HDFC ERGO grid engine — multi-file insurer.  Sheet dispatch on
 * `sheet_kind` from the insurer config:
 *
 *   robinhood — Pvt Car Comp + SAOD (Zone1/Zone2 × NCB × fuel)
 *   satp      — Pvt Car SATP (Zone × State × Location × Fuel × CC band)
 *   tw_comp   — TW Comp / TP grid (per state×location×CC band)
 *   tw_saod   — TW SAOD grid (per state×location with make exclusions)
 *   gcv       — GCV multi-weight-band grid with free-text cell rules
 *               (decline carve-outs, age tiers, make-specific rates,
 *               Grid+N% formulas)
 *
 * Conventions:
 *   - region        ← city/location (export City col)
 *   - sub_type      ← "Base" / "Approved" (GCV) or empty/zone for others
 *   - carrier_type  ← Reliance-style HDFC zone label when present
 *   - remarks       ← state name (Royal-style → State col)
 *   - rate_text     ← human audit trail
 */

// ----- Geography master (Pvt Car Robinhood Sheet2) -----
//
// Direct state-name → Zone-1 / Zone-2 lookup.  Used by the Robinhood
// parser to fan zone-keyed rates across each member state of that zone.
const GEO_ZONE = {
  'Rest of Assam':         'Zone-1',
  'KAMRUP':                'Zone-1',
  'Bihar':                 'Zone-1',
  'Jharkhand':             'Zone-1',
  'West Bengal':           'Zone-1',
  'Arunachal Pradesh':     'Zone-1',
  'Manipur':               'Zone-1',
  'Meghalaya':             'Zone-1',
  'Nagaland':              'Zone-1',
  'Odisha':                'Zone-1',
  'Sikkim':                'Zone-1',
  'Tripura':               'Zone-1',
  'ANDHRA PRADESH':        'Zone-1',
  'BANGALORE':             'Zone-1',
  'ANDAMANS':              'Zone-1',
  'Telangana':             'Zone-1',
  'GOA':                   'Zone-1',
  'AHMEDABAD':             'Zone-1',
  'DADRA & NAGAR HAVELI':  'Zone-1',
  'DAMAN':                 'Zone-1',
  'VADODARA':              'Zone-1',
  'Maharashtra':           'Zone-1',
  'NCR':                   'Zone-1',
  'Delhi':                 'Zone-1',
  'Nagaon':                'Zone-2',
  'Chhattisgarh':          'Zone-2',
  'Mizoram':               'Zone-2',
  'Rest of Karnataka':     'Zone-2',
  'Rest of Tamil Nadu':    'Zone-2',
  'Kerala':                'Zone-2',
  'Rest of Gujarat':       'Zone-2',
  'Haryana':               'Zone-2',
  'Himachal Pradesh':      'Zone-2',
  'Punjab':                'Zone-2',
  'Uttar Pradesh':         'Zone-2',
  'Uttarakhand':           'Zone-2',
  'J&K':                   'Zone-2',
  'Chandigarh':            'Zone-2',
  'Madhya Pradesh':        'Zone-2',
  'Rajasthan':             'Zone-2',
};

/** Group geography entries by zone for Robinhood fan-out. */
function statesByZone(zone) {
  return Object.entries(GEO_ZONE)
    .filter(([_, z]) => z === zone)
    .map(([state]) => state);
}

// ----- helpers -----
function cellOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Parse a numeric rate. Accepts "0.6", "60%", "60", " 35 ", and returns a
 *  decimal fraction (0.6 = 60%). Returns null when not a number. */
function parsePlainRate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  // Strict parse: must look like just a number with optional % sign.
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function flatRate(pct) { return +(pct / 100).toFixed(6); }

/** Try to resolve "Grid+N%" / "Grid + 7.5 %" formulas given a base value. */
function applyFormula(approvedText, baseValue) {
  const s = String(approvedText || '').trim();
  if (!s) return null;
  const m = s.match(/^grid\s*\+\s*(\d+(?:\.\d+)?)\s*%?$/i);
  if (!m) return null;
  const delta = parseFloat(m[1]) / 100;
  if (baseValue == null) return null;
  return Math.max(0, +(baseValue + delta).toFixed(6));
}

// ============================================================================
//  GCV cell-text parser
// ============================================================================
//
// GCV cells contain free-text rules.  parseGcvCell(text) returns an array
// of rule fragments; the caller composes them with section context.
//
// Each fragment: { make, vehicle_age_min, vehicle_age_max, rate_value,
//                  is_declined, label }
//
// Recognized patterns (matched in order):
//   1. Pure number  / pure percent      → single fragment, all makes
//   2. "X%, <N years decline"           → rate X% for age >=N + decline <N
//   3. "X%,<=N years decline"           → rate X% for age >N + decline <=N
//   4. "age >N, X%" / "age >N X%"       → rate X% for age >N
//   5. "age >N X%, age <M Y%"           → two fragments (age tiers)
//   6. "Tata X%, Other Y%"              → split by make
//   7. "Make-A & Make-B X%, rest decline" → fragments per make + decline
//   8. "Bolero <N X%, >N Y%, others Z%" → Bolero age tier + other makes
//   9. "Make-A age >N X%, Others age >N Y%" → split by make and age
//  10. "decline" (alone)                → declined fragment
//
// Anything unrecognized: return [] and log a warning so we don't silently
// drop the cell — the calling code should still emit a remarks-only row
// or skip.
/** Build {min,max} age range from an op + N, or [N,N] range. */
function ageFromOp(op, n) {
  if (op === '>')  return { vehicle_age_min: n + 1, vehicle_age_max: 99 };
  if (op === '>=') return { vehicle_age_min: n,     vehicle_age_max: 99 };
  if (op === '<')  return { vehicle_age_min: 0,     vehicle_age_max: n - 1 };
  if (op === '<=') return { vehicle_age_min: 0,     vehicle_age_max: n };
  return {};
}

const MAKE_TOKEN = '(?:Tata|Bolero|Mahindra|Eicher|Ashok\\s*Leyland|Bharat|Others?|Other)';

/**
 * Split a multi-clause cell on commas and process each clause.  Tracks
 * `lastMake` so bare "Age <op> N rate%" clauses inherit the last seen
 * make.  Returns array of fragments; empty array if no clause matched.
 */
function parseMultiClause(raw) {
  const out = [];
  const clauses = raw.split(/,/).map(s => s.trim()).filter(Boolean);
  let lastMake = null;

  // Recognized clause shapes:
  const makeAgeRate = new RegExp(
    `^(${MAKE_TOKEN})\\s*age\\s*(?:(<=?|>=?)\\s*(\\d+)|(\\d+)\\s*(<=?|>=?))\\s*(?:years?)?\\s*(\\d+(?:\\.\\d+)?)\\s*%$`,
    'i'
  );
  const makeRate    = new RegExp(`^(${MAKE_TOKEN})\\s+(\\d+(?:\\.\\d+)?)\\s*%$`, 'i');
  const rateMake    = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*%\\s+(${MAKE_TOKEN})$`, 'i');
  // Rate-first with Make+Age:  "40% Bolero age <4"
  const rateMakeAge = new RegExp(
    `^(\\d+(?:\\.\\d+)?)\\s*%\\s+(${MAKE_TOKEN})\\s+age\\s*(<=?|>=?)\\s*(\\d+)$`,
    'i'
  );
  // Rate-first age + make:  "47.5% age <2 others"
  const rateAgeMake = new RegExp(
    `^(\\d+(?:\\.\\d+)?)\\s*%\\s+age\\s*(<=?|>=?)\\s*(\\d+)\\s+(${MAKE_TOKEN})$`,
    'i'
  );
  const ageRate     = /^age\s*(?:(<=?|>=?)\s*(\d+)|(\d+)\s*(<=?|>=?))\s*(?:years?)?\s*(\d+(?:\.\d+)?)\s*%$/i;
  const rateAge     = /^(\d+(?:\.\d+)?)\s*%\s+age\s*(<=?|>=?)\s*(\d+)$/i;
  const bareRate    = /^(\d+(?:\.\d+)?)\s*%$/;

  for (const c of clauses) {
    let m;
    // a) Make + Age + Rate
    if ((m = c.match(makeAgeRate))) {
      lastMake = canonicalizeMake(m[1]) || m[1];
      const op = m[2] || m[5];
      const n  = parseInt(m[3] || m[4], 10);
      out.push({ make: lastMake, ...ageFromOp(op, n), rate_value: parseFloat(m[6]) / 100, is_declined: false, label: `${lastMake} ${op}${n}` });
      continue;
    }
    // b) Make + Rate
    if ((m = c.match(makeRate))) {
      lastMake = canonicalizeMake(m[1]) || m[1];
      out.push({ make: lastMake, rate_value: parseFloat(m[2]) / 100, is_declined: false, label: lastMake });
      continue;
    }
    // c) Rate + Make + Age   (e.g. "40% Bolero age <4")
    if ((m = c.match(rateMakeAge))) {
      lastMake = canonicalizeMake(m[2]) || m[2];
      const op = m[3], n = parseInt(m[4], 10);
      out.push({ make: lastMake, ...ageFromOp(op, n), rate_value: parseFloat(m[1]) / 100, is_declined: false, label: `${lastMake} ${op}${n}` });
      continue;
    }
    // c2) Rate + Age + Make   (e.g. "47.5% age <2 others")
    if ((m = c.match(rateAgeMake))) {
      lastMake = canonicalizeMake(m[4]) || m[4];
      const op = m[2], n = parseInt(m[3], 10);
      out.push({ make: lastMake, ...ageFromOp(op, n), rate_value: parseFloat(m[1]) / 100, is_declined: false, label: `${lastMake} ${op}${n}` });
      continue;
    }
    // c3) Rate + Make
    if ((m = c.match(rateMake))) {
      lastMake = canonicalizeMake(m[2]) || m[2];
      out.push({ make: lastMake, rate_value: parseFloat(m[1]) / 100, is_declined: false, label: lastMake });
      continue;
    }
    // d) Age + Rate (bare; inherit lastMake)
    if (lastMake && (m = c.match(ageRate))) {
      const op = m[1] || m[4];
      const n  = parseInt(m[2] || m[3], 10);
      out.push({ make: lastMake, ...ageFromOp(op, n), rate_value: parseFloat(m[5]) / 100, is_declined: false, label: `${lastMake} ${op}${n}` });
      continue;
    }
    // e) Rate + Age (bare; inherit lastMake)
    if (lastMake && (m = c.match(rateAge))) {
      const op = m[2];
      const n  = parseInt(m[3], 10);
      out.push({ make: lastMake, ...ageFromOp(op, n), rate_value: parseFloat(m[1]) / 100, is_declined: false, label: `${lastMake} ${op}${n}` });
      continue;
    }
    // f) Bare rate (no make context — apply to All)
    if ((m = c.match(bareRate))) {
      out.push({ make: 'All', rate_value: parseFloat(m[1]) / 100, is_declined: false, label: 'plain' });
      continue;
    }
    // g) "rest decline" / "others decline" — handled by caller
    // h) unmatched — skip (caller may log later)
  }

  // Sanity: only return when we matched at least one clause-with-make so
  // we don't shadow the simpler patterns above.
  return out.some(f => f.make !== 'All') ? out : [];
}

/** Canonicalize a free-text make name to a stable label. */
function canonicalizeMake(s) {
  const t = String(s || '').trim().toLowerCase().replace(/[\s\-&]+/g, '');
  if (t === 'tata')           return 'TATA';
  if (t === 'mahindra')       return 'Mahindra';
  if (t === 'bolero')         return 'Bolero';
  if (t === 'eicher')         return 'Eicher';
  if (t === 'ashokleyland')   return 'Ashok Leyland';
  if (t === 'al')             return 'Ashok Leyland';
  if (t === 'bharat')         return 'Bharat';
  if (t === 'others' || t === 'other' || t === 'rest' || t === 'otherwise') return 'Others';
  if (!t) return null;
  return s.trim();
}

/**
 * Match age-tier clauses: handles capitalized "Age", "0-N" range form,
 * and rate-first / age-first orderings. Returns array of fragments.
 *
 * Examples it covers:
 *   "Age >4 30%, Age 0-4 20%"      → 2 fragments
 *   "age >4 40%, age <4 25%"       → 2 fragments
 *   "Age >4 26%, Age 0-4 15%"      → 2 fragments
 */
function matchAgeTierClauses(raw) {
  const re = /age\s*(?:(>=?|<=?)\s*(\d+)|(\d+)\s*-\s*(\d+))\s+(\d+(?:\.\d+)?)\s*%/gi;
  const out = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    let amin = null, amax = null;
    if (m[1]) {
      const op = m[1], n = parseInt(m[2], 10);
      if (op === '>')  { amin = n + 1; amax = 99; }
      if (op === '>=') { amin = n;     amax = 99; }
      if (op === '<')  { amin = 0;     amax = n - 1; }
      if (op === '<=') { amin = 0;     amax = n; }
    } else {
      amin = parseInt(m[3], 10);
      amax = parseInt(m[4], 10);
    }
    out.push({
      make: 'All',
      vehicle_age_min: amin,
      vehicle_age_max: amax,
      rate_value: parseFloat(m[5]) / 100,
      is_declined: false,
      label: `age ${amin}-${amax}`,
    });
  }
  return out.length >= 2 ? out : [];   // require at least 2 to consider it "tiered"
}

function parseGcvCell(text) {
  const original = String(text || '').trim();
  if (!original) return [];
  // Normalize common variations so the downstream regexes have fewer
  // forms to match:
  //   "47.5% in Bolero"        → "47.5% Bolero"
  //   "<5 years"               → "age <5"
  //   ">5 years"               → "age >5"
  //   "0-4 years"              → "age 0-4"
  //   " and "                  → ", "         (treat as clause separator)
  const raw = original
    .replace(/\s+in\s+/gi, ' ')
    .replace(/(<=?|>=?)\s*(\d+)\s*years?/gi, 'age $1$2')
    .replace(/(\d+)\s*-\s*(\d+)\s+years?/gi, 'age $1-$2')
    .replace(/\s+and\s+/gi, ', ');
  const lower = raw.toLowerCase();

  // 1. Pure number / "0.6"-style decimal or "35%" percent
  const plain = parsePlainRate(raw);
  if (plain != null) {
    return [{ make: 'All', rate_value: plain, is_declined: plain === 0, label: 'plain' }];
  }

  // "decline" only
  if (/^decline$|^declined$/i.test(raw)) {
    return [{ make: 'All', rate_value: null, is_declined: true, label: 'declined' }];
  }

  const out = [];

  // Split on commas to get phrase chunks; we'll try to match each.
  // Some chunks like "Tata <N years X%" can't be split cleanly so we
  // also process the whole string with multi-clause regexes first.

  // Multi-clause: "Bolero <N X%, >N Y%, others Z%"
  const bolero = raw.match(/Bolero\s*<\s*(\d+)\s*years?\s*(\d+(?:\.\d+)?)\s*%[,\s]+(?:>?\s*\d+\s*years?\s*)?(\d+(?:\.\d+)?)\s*%[,\s]+others?\s+(\d+(?:\.\d+)?)\s*%/i);
  if (bolero) {
    const n = parseInt(bolero[1], 10);
    out.push({ make: 'Bolero', vehicle_age_min: 0,   vehicle_age_max: n - 1, rate_value: parseFloat(bolero[2]) / 100, is_declined: false, label: 'Bolero <N' });
    out.push({ make: 'Bolero', vehicle_age_min: n,   vehicle_age_max: 99,    rate_value: parseFloat(bolero[3]) / 100, is_declined: false, label: 'Bolero >=N' });
    out.push({ make: 'Others', rate_value: parseFloat(bolero[4]) / 100, is_declined: false, label: 'others' });
    return out;
  }

  // "Bolero age 0-N decline, others X%"
  const boleroDecline = raw.match(/Bolero\s+age\s+0\s*-\s*(\d+)\s+decline[,\s]+others?\s+(\d+(?:\.\d+)?)\s*%/i);
  if (boleroDecline) {
    const n = parseInt(boleroDecline[1], 10);
    out.push({ make: 'Bolero', vehicle_age_min: 0,    vehicle_age_max: n,  rate_value: null, is_declined: true,  label: 'Bolero age 0-N declined' });
    out.push({ make: 'Bolero', vehicle_age_min: n + 1,vehicle_age_max: 99, rate_value: parseFloat(boleroDecline[2]) / 100, is_declined: false, label: 'Bolero age >N' });
    out.push({ make: 'Others', rate_value: parseFloat(boleroDecline[2]) / 100, is_declined: false, label: 'others' });
    return out;
  }

  // "Tata X%, Other Y%" / "Tata 30%, Other Age4 >30%" / "Tata 23%, Others 20%"
  const tataOther = raw.match(/Tata\s+(?:age\s*>?\s*\d+\s+)?(\d+(?:\.\d+)?)\s*%[,\s]+(?:other(?:s)?|rest)\s*(?:age\s*\d?\s*>?\s*\d+\s+)?(\d+(?:\.\d+)?)\s*%/i);
  if (tataOther && !/age/i.test(raw.replace(/Tata\s+(?:age\s*>?\s*\d+\s+)?\d+(?:\.\d+)?\s*%/i, ''))) {
    out.push({ make: 'TATA',   rate_value: parseFloat(tataOther[1]) / 100, is_declined: false, label: 'Tata' });
    out.push({ make: 'Others', rate_value: parseFloat(tataOther[2]) / 100, is_declined: false, label: 'others' });
    return out;
  }

  // Multi-clause make/age/rate parser — split on commas and process each
  // clause, inheriting `lastMake` when an "Age" clause appears bare.  Handles:
  //
  //   "Tata Age >4 25%, Others Age >4 20%"
  //   "Tata 30%, Other Age4 >30%"             (typo variant of "Age >4")
  //   "Others Age >4 20%, Age <4 15%, Tata Age >4 25%, Age <4 15%"
  //                                            (bare Age clauses inherit
  //                                             last seen make)
  //   "Tata 23%, Others 20%"
  //   "25% Tata, 20% Others"                   (rate-first form)
  //   "tata 25%, others 20%"                   (lowercase)
  const multi = parseMultiClause(raw);
  if (multi.length > 0) {
    if (/rest\s+decline|others?\s+decline/i.test(lower)) {
      multi.push({ make: 'Others', rate_value: null, is_declined: true, label: 'rest decline' });
    }
    return multi;
  }

  // "X% for <Make> & <Make> rest decline"  /  "<Make>-& <Make>- X%, rest decline"
  const multiMakeRest = raw.match(/(\d+(?:\.\d+)?)\s*%\s+(?:for\s+)?([\w\s&\-]+?)\s+rest\s+decline/i)
                     || raw.match(/([\w\s&\-]+?)[-\s]+(\d+(?:\.\d+)?)\s*%\s*,\s*rest\s+decline/i);
  if (multiMakeRest) {
    const isFirstNumber = /^\d/.test(raw);
    const rate = parseFloat(isFirstNumber ? multiMakeRest[1] : multiMakeRest[2]) / 100;
    const makeStr = isFirstNumber ? multiMakeRest[2] : multiMakeRest[1];
    const makes = makeStr.split(/&|and/i).map(s => s.replace(/[-,]/g, '').trim()).filter(Boolean);
    for (const m of makes) {
      const make = canonicalizeMake(m);
      if (make) out.push({ make, rate_value: rate, is_declined: false, label: `${make} ${rate * 100}%` });
    }
    out.push({ make: 'Others', rate_value: null, is_declined: true, label: 'rest decline' });
    return out;
  }

  // "Y%, X% for <Make> >N <Make> in <City>"  — base rate + make/age carve-out
  // Example: "25%, 35% for Tata >4 Tata in Pune" → All: 25%, TATA >4: 35% (Pune)
  const baseAndCarveout = raw.match(/^(\d+(?:\.\d+)?)\s*%\s*,\s*(\d+(?:\.\d+)?)\s*%\s+for\s+(\w+)\s+>(\d+)/i);
  if (baseAndCarveout) {
    const baseRate    = parseFloat(baseAndCarveout[1]) / 100;
    const carveRate   = parseFloat(baseAndCarveout[2]) / 100;
    const carveMake   = canonicalizeMake(baseAndCarveout[3]) || baseAndCarveout[3];
    const carveAge    = parseInt(baseAndCarveout[4], 10);
    out.push({ make: 'All',    rate_value: baseRate,  is_declined: false, label: 'base' });
    out.push({ make: carveMake, vehicle_age_min: carveAge + 1, vehicle_age_max: 99,
               rate_value: carveRate, is_declined: false, label: `${carveMake} >${carveAge}` });
    return out;
  }

  // "X% in Tata and Y% Otherwise" / "X% in Tata, Y% Otherwise"
  const inMakeOther = raw.match(/(\d+(?:\.\d+)?)\s*%\s+in\s+(\w+)\s+(?:and|,)\s+(\d+(?:\.\d+)?)\s*%\s+otherwise/i);
  if (inMakeOther) {
    const make = canonicalizeMake(inMakeOther[2]) || inMakeOther[2];
    out.push({ make, rate_value: parseFloat(inMakeOther[1]) / 100, is_declined: false, label: `${make}` });
    out.push({ make: 'Others', rate_value: parseFloat(inMakeOther[3]) / 100, is_declined: false, label: 'others' });
    return out;
  }

  // "Age <op> N rate%, Age <op> M rate%"  (capitalized "Age", word order rate-first)
  // Also handles "Age 0-N  rate%" range form.
  const ageTierCap = matchAgeTierClauses(raw);
  if (ageTierCap.length > 0) {
    return ageTierCap;
  }

  // "rate% age<op>N" — rate before age (e.g. "20% age>4")
  const rateBeforeAge = raw.match(/^(\d+(?:\.\d+)?)\s*%\s+age\s*(>=?|<=?)\s*(\d+)$/i);
  if (rateBeforeAge) {
    const rate = parseFloat(rateBeforeAge[1]) / 100;
    const op   = rateBeforeAge[2];
    const n    = parseInt(rateBeforeAge[3], 10);
    let amin = null, amax = null;
    if (op === '>')  { amin = n + 1; amax = 99; }
    if (op === '>=') { amin = n;     amax = 99; }
    if (op === '<')  { amin = 0;     amax = n - 1; }
    if (op === '<=') { amin = 0;     amax = n; }
    return [{ make: 'All', vehicle_age_min: amin, vehicle_age_max: amax, rate_value: rate, is_declined: false, label: 'age-qualified' }];
  }

  // "X%, <N years decline" / "X%,<=N years decline"
  // After normalization, also matches "X%, age <N decline" / "X%, age <=N decline"
  const declMix = raw.match(/(\d+(?:\.\d+)?)\s*%\s*,\s*(?:age\s*)?(<=?|>=?)\s*(\d+)\s*(?:years?\s*)?decline/i);
  if (declMix) {
    const rate = parseFloat(declMix[1]) / 100;
    const op   = declMix[2];
    const n    = parseInt(declMix[3], 10);
    if (op === '<') {
      out.push({ make: 'All', vehicle_age_min: n,   vehicle_age_max: 99, rate_value: rate, is_declined: false, label: 'eligible' });
      out.push({ make: 'All', vehicle_age_min: 0,   vehicle_age_max: n-1, rate_value: null, is_declined: true,  label: '<N declined' });
    } else if (op === '<=') {
      out.push({ make: 'All', vehicle_age_min: n+1, vehicle_age_max: 99, rate_value: rate, is_declined: false, label: 'eligible' });
      out.push({ make: 'All', vehicle_age_min: 0,   vehicle_age_max: n,   rate_value: null, is_declined: true,  label: '<=N declined' });
    }
    return out;
  }

  // "age >N, X%" or "age >=N X%" (no decline clause)
  const ageOnly = raw.match(/^age\s*(>=?|<=?)\s*(\d+)[,\s]+(\d+(?:\.\d+)?)\s*%$/i);
  if (ageOnly) {
    const op = ageOnly[1], n = parseInt(ageOnly[2], 10), rate = parseFloat(ageOnly[3]) / 100;
    let amin = null, amax = null;
    if (op === '>')  { amin = n + 1; amax = 99; }
    if (op === '>=') { amin = n;     amax = 99; }
    if (op === '<')  { amin = 0;     amax = n - 1; }
    if (op === '<=') { amin = 0;     amax = n; }
    return [{ make: 'All', vehicle_age_min: amin, vehicle_age_max: amax, rate_value: rate, is_declined: false, label: 'age-qualified' }];
  }

  // "age >N X%, age <M Y%"
  const ageTierSplit = raw.match(/age\s*(>=?|<=?)\s*(\d+)\s*(\d+(?:\.\d+)?)\s*%\s*,\s*age\s*(>=?|<=?)\s*(\d+)\s*(\d+(?:\.\d+)?)\s*%/i);
  if (ageTierSplit) {
    const m1 = ageTierSplit;
    const tiers = [
      [m1[1], parseInt(m1[2], 10), parseFloat(m1[3]) / 100],
      [m1[4], parseInt(m1[5], 10), parseFloat(m1[6]) / 100],
    ];
    for (const [op, n, rate] of tiers) {
      let amin = null, amax = null;
      if (op === '>')  { amin = n + 1; amax = 99; }
      if (op === '>=') { amin = n;     amax = 99; }
      if (op === '<')  { amin = 0;     amax = n - 1; }
      if (op === '<=') { amin = 0;     amax = n; }
      out.push({ make: 'All', vehicle_age_min: amin, vehicle_age_max: amax, rate_value: rate, is_declined: false, label: 'age-tier' });
    }
    return out;
  }

  // Couldn't parse — log once and return empty (caller emits a remarks-only row).
  if (!parseGcvCell._warned) parseGcvCell._warned = new Set();
  if (!parseGcvCell._warned.has(raw)) {
    parseGcvCell._warned.add(raw);
    console.warn(`[hdfc-grid] GCV unrecognized cell text: ${JSON.stringify(raw)}`);
  }
  return [];
}

// ============================================================================
//  Robinhood — Pvt Car Comp + SAOD
// ============================================================================
//
// Layout:
//   R0: ["Robinhood"]
//   R1: ["", "", "P NCB", "PNNCB", "Non Petrol NCB", "Non Petrol NNCB"]
//   R2: ["Zone1", "Package", x, y, z, w]
//   R3: ["",       "SAOD",    x, y, z, w]
//   R4: blank
//   R5: ["Zone 2", "Package", ...]
//   R6: ["",       "SAOD", ...]
//   ... notes rows below
//
// Per-cell fan-out:
//   • Fuel: P columns → Petrol/Hybrid/EV (note "EV/Hybrid in Petrol Grid")
//   •       Non Petrol → Diesel/CNG/LPG (note "Non Petrol = Diesel/CNG/LPG")
//   • NCB:  NCB column → covers rolled-over with NCB AND new vehicle
//                        (note "New Business considered as NCB")
//           NNCB column → rolled-over without NCB
function parseRobinhood(sheetData, sheetConfig, meta) {
  const rules = [];
  const PETROL_FUELS     = ['Petrol', 'Hybrid', 'EV'];
  const NON_PETROL_FUELS = ['Diesel', 'CNG', 'LPG'];
  const COL_SPECS = [
    { col: 2, fuels: PETROL_FUELS,     ncb: 'NCB' },
    { col: 3, fuels: PETROL_FUELS,     ncb: 'NoNCB' },
    { col: 4, fuels: NON_PETROL_FUELS, ncb: 'NCB' },
    { col: 5, fuels: NON_PETROL_FUELS, ncb: 'NoNCB' },
  ];

  // Find Zone1 / Zone 2 row pairs by scanning col 0
  let currentZone = null;
  for (let r = 2; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const z = cellOrNull(row[0]);
    if (z) {
      const m = String(z).match(/zone\s*(\d)/i);
      if (m) currentZone = `Zone-${m[1]}`;
      else if (/^slab|^non petrol|^new|^ev|^hybrid/i.test(z)) break;  // notes
    }
    const policyType = cellOrNull(row[1]);  // "Package" or "SAOD"
    if (!policyType || !currentZone) continue;
    const rt = /^saod$/i.test(policyType) ? 'SAOD' : 'COMP';
    const states = statesByZone(currentZone);
    if (states.length === 0) continue;

    for (const spec of COL_SPECS) {
      const v = parsePlainRate(row[spec.col]);
      if (v == null) continue;
      const isDeclined = v === 0;
      for (const fuel of spec.fuels) {
        for (const state of states) {
          // NCB encoding:
          //   NCB column   → covers New Vehicle (age 0) AND rolled-over with NCB
          //   NoNCB column → rolled-over without NCB
          if (spec.ncb === 'NCB') {
            // Variant 1: new vehicle (age 0)
            rules.push(makeRobinhoodRule(state, currentZone, rt, fuel, v, isDeclined,
              { vehicle_age_min: 0, vehicle_age_max: 0 }, 'New vehicle (NCB column)', meta));
            // Variant 2: rolled-over with NCB
            rules.push(makeRobinhoodRule(state, currentZone, rt, fuel, v, isDeclined,
              { vehicle_age_min: 1, vehicle_age_max: 99, age_band_min: 1, age_band_max: 99 },
              'Rolled-over with NCB', meta));
          } else {
            // NoNCB: rolled-over without NCB
            rules.push(makeRobinhoodRule(state, currentZone, rt, fuel, v, isDeclined,
              { vehicle_age_min: 1, vehicle_age_max: 99, age_band_min: 0, age_band_max: 0 },
              'Rolled-over without NCB', meta));
          }
        }
      }
    }
  }
  return rules;
}

function makeRobinhoodRule(state, zone, rateType, fuel, value, isDeclined, ageFields, label, meta) {
  return {
    product:  'CAR',
    sheet_name: meta.sheetName,
    region:   state,
    sub_type: zone,                                    // Zone-1 / Zone-2 in Sub Modal
    segment:  'Pvt Car Robinhood',
    make:     'All',
    fuel_type: fuel,
    rate_type: rateType,
    rate_value: isDeclined ? null : value,
    is_declined: isDeclined,
    carrier_type: zone,
    remarks:  state,                                   // State col → state
    rate_text: `Robinhood ${zone} | ${state} | ${fuel} | ${label}`,
    ...ageFields,
  };
}

// ============================================================================
//  Pvt Car SATP
// ============================================================================
//
// Layout (Grid sheet, header row 1):
//   col 1: Zone | col 2: State | col 3: Locations | col 4: Fuel | col 5: BDE %
//
// Notes:
//   - Locations with "*" are state-level (expanded via Location Master)
//   - BDE printed is for CC ≥ 1000
//   - For CC 0-999: BDE − 5%
//
// Each cell fans out into 2 CC variants per fuel (cc≥1000 + cc<1000).
function parseSATP(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 2; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const zone     = cellOrNull(row[0]);
    const state    = cellOrNull(row[1]);
    const location = cellOrNull(row[2]);
    const fuel     = cellOrNull(row[3]);
    const bde      = parsePlainRate(row[4]);
    if (!zone || !state || !location || !fuel || bde == null) continue;
    const isDeclined = bde === 0;

    // Strip trailing "*" marker (state-level marker)
    const locClean = location.replace(/\*+$/, '');

    // Region aliases — bulk pipeline labels NCR-area policies as
    // "Delhi NCR", but the SATP rate sheet uses "Ncr" / "NCR".
    // Add aliases so a policy with region="Delhi NCR" hits the right row.
    const SATP_ALIASES = {
      'Ncr':    ['Delhi NCR', 'NCR'],
      'NCR':    ['Delhi NCR'],
      'Delhi':  ['Delhi NCR', 'NCR'],
    };
    const regionTokens = [locClean, ...(SATP_ALIASES[locClean] || [])];

    for (const regionToken of regionTokens) {
      const baseRule = {
        product:  'CAR',
        sheet_name: meta.sheetName,
        region:   regionToken,
        sub_type: null,
        segment:  'Pvt Car SATP',
        make:     'All',
        fuel_type: fuel,
        rate_type: 'SATP',
        carrier_type: zone,
        remarks:  state,
        rate_text: `${zone} | ${state} | ${location} | ${fuel}`,
      };

      // CC ≥ 1000 — base rate
      rules.push({
        ...baseRule,
        cc_band_min: 1000, cc_band_max: 99999,
        rate_value: isDeclined ? null : bde,
        is_declined: isDeclined,
      });
      // CC 0-999 — base − 5%
      rules.push({
        ...baseRule,
        cc_band_min: 0, cc_band_max: 999,
        rate_value: isDeclined ? null : Math.max(0, +(bde - 0.05).toFixed(6)),
        is_declined: isDeclined,
        rate_text: baseRule.rate_text + ' | <1000cc −5%',
      });
    }
  }
  return rules;
}

// ============================================================================
//  PCV 3W grid (HDFC PCCV 3W Effective From 1st April.xlsx)
// ============================================================================
//
// Layout (3W-GRID sheet, header at R0):
//   col 0: State | col 1: Location | col 2: Business type | col 3: Fuel
//   col 4: BDE  | col 5: Comments
//
// Business type → vehicle age band:
//   "New"                → vehicle_age 0..0
//   "Non New" / "Non-New"→ vehicle_age 1..99
//
// Fuel "Petrol/CNG/LPG" fans out into 3 separate fuel-type rules.
function parsePCV3W(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const state    = cellOrNull(row[0]);
    const location = cellOrNull(row[1]);
    const business = cellOrNull(row[2]);
    const fuelCell = cellOrNull(row[3]);
    const bde      = parsePlainRate(row[4]);
    if (!state || !location || !business || !fuelCell || bde == null) continue;

    const isDeclined = bde === 0;
    let ageMin, ageMax;
    if (/^new$/i.test(business))             { ageMin = 0; ageMax = 0;  }
    else if (/^non[-\s]?new$/i.test(business)) { ageMin = 1; ageMax = 99; }
    else continue;   // unknown business type — skip

    // Fuel split: "Petrol/CNG/LPG" → [Petrol, CNG, LPG], else single.
    const fuels = fuelCell.includes('/')
      ? fuelCell.split('/').map(s => s.trim()).filter(Boolean)
      : [fuelCell];

    // Compound location strings ("Mumbai,Pune" / "Nashik Nagpur" / "Bhubaneswar
    // Cuttack" etc.) need to fan out so a policy with region="Mumbai" still
    // matches a rule with location="Mumbai,Pune".  Split on comma OR run of
    // whitespace between two title-cased city names.
    const locTokens = (() => {
      const set = new Set([location]);
      if (location.includes(',')) {
        location.split(',').map(s => s.trim()).filter(Boolean).forEach(t => set.add(t));
      } else if (/^[A-Z][a-z]+ [A-Z][a-z]/.test(location)) {
        // "Nashik Nagpur" / "Bhubaneswar Cuttack" — two title-cased words
        location.split(/\s+/).filter(Boolean).forEach(t => set.add(t));
      }
      return [...set];
    })();

    for (const fuel of fuels) {
      for (const locToken of locTokens) {
      rules.push({
        product:  'PCV',
        sheet_name: meta.sheetName,
        region:   locToken,
        sub_type: null,
        segment:  'PCV 3W',
        make:     'All',
        fuel_type: fuel,
        vehicle_age_min: ageMin,
        vehicle_age_max: ageMax,
        rate_type: 'COMP',                   // BDE applies to Package
        rate_value: isDeclined ? null : bde,
        is_declined: isDeclined,
        remarks:  state,
        rate_text: `${state} | ${location} | ${business} | ${fuel}`,
      });
      }
    }
  }
  return rules;
}

// ============================================================================
//  TW Comp / TP grid
// ============================================================================
//
// Layout (Grid - Comp, TP only sheet):
//   col 0: Policy Type | col 1: Segment | col 2: Fuel | col 3: State
//   col 4: Location    | col 5: Upto 150cc BDE % | col 6: Above 150cc BDE %
//
// Notes:
//   • Yamaha, KTM, Suzuki, Bajaj — covered by separate carve-outs (skipped here)
//   • EV blocked in the system → emit declined rules for fuel='EV'
//   • TVS will be given 10% less BDE — emit per-state TVS variant rule
//   • Bad locations (rate=0) → declined
function parseTWComp(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 2; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const policyType = cellOrNull(row[0]);
    const segment    = cellOrNull(row[1]);
    const fuel       = cellOrNull(row[2]);
    const state      = cellOrNull(row[3]);
    const location   = cellOrNull(row[4]);
    if (!policyType || !segment || !state || !location) continue;
    if (/^term|^yamaha|^ev|^this grid|^all the locations/i.test(policyType)) break;

    const upto150  = parsePlainRate(row[5]);
    const above150 = parsePlainRate(row[6]);

    const ccBands = [
      { min: 0,    max: 150, rate: upto150 },
      { min: 151,  max: 9999, rate: above150 },
    ];
    // "TP Only" / "TP" / "SATP" → SATP rate type;  "Comp" / "Comprehensive" → COMP
    const baseRT = /^tp(\s+only)?$|^satp$/i.test(policyType) ? 'SATP' : 'COMP';

    // "Scooter / Moped" segment fans out into 2 distinct rules per cell
    // — one for Scooter and one for Moped — so each appears as its own
    // Excel row with the proper VehicleCategory.  Other segments stay
    // unchanged.
    const segments = /\bScooter\b.*\bMoped\b|\bMoped\b.*\bScooter\b/i.test(segment)
      ? ['Scooter', 'Moped']
      : [segment];

    // Region aliases for TW: "All" or state-level rows in Delhi/HR/UP get
    // labelled as "Delhi NCR" by the bulk pipeline; emit aliases so the
    // policy region matches.  Same for compound location strings like
    // "Kanpur,Varanasi" → emit each city as a separate rule.
    const TW_LOC_ALIASES = {
      'All':  state.toLowerCase() === 'delhi'           ? ['Delhi NCR', 'NCR'] :
              state.toLowerCase() === 'haryana'         ? ['Delhi NCR'] :
              state.toLowerCase() === 'uttar pradesh'   ? [] : [],
    };
    const baseLocTokens = location.includes(',')
      ? [location, ...location.split(',').map(s => s.trim()).filter(Boolean)]
      : [location];
    const aliasLocTokens = TW_LOC_ALIASES[location] || [];
    const locTokens = [...new Set([...baseLocTokens, ...aliasLocTokens])];

    for (const cc of ccBands) {
      if (cc.rate == null) continue;
      const isDeclined = cc.rate === 0;
      for (const seg of segments) {
       for (const locTok of locTokens) {
        const baseRule = {
          product:  'TW',
          sheet_name: meta.sheetName,
          region:   locTok,
          sub_type: null,
          segment:  seg,
          make:     'All',
          fuel_type: fuel,
          cc_band_min: cc.min, cc_band_max: cc.max,
          rate_type: baseRT,
          rate_value: isDeclined ? null : cc.rate,
          is_declined: isDeclined,
          remarks:  state,
          rate_text: `${state} | ${location} | ${seg} | ${fuel} | ${cc.min}-${cc.max}cc`,
        };
        rules.push(baseRule);

        // (Note: TVS −10% only applies on SAOD grid, not Comp/TP — handled
        // in parseTWSaod.)

        // EV blocked — emit a declined EV variant
        rules.push({
          ...baseRule,
          fuel_type: 'EV',
          rate_value: null,
          is_declined: true,
          rate_text: baseRule.rate_text + ' | EV blocked',
          remarks: state + ' | EV blocked',
        });
       }
      }
    }
  }
  return rules;
}

// ============================================================================
//  TW SA-OD grid
// ============================================================================
//
// Layout (Grid - SA-OD):
//   col 0: Policy Type | col 1: Segment | col 2: Fuel | col 3: Zone
//   col 4: State | col 5: Location | col 6: Remarks (e.g. "exc Hero")
//   col 7: BDE %
//
// "exc Make" in remarks → emit a declined rule for that make.
function parseTWSaod(sheetData, sheetConfig, meta) {
  const rules = [];
  for (let r = 1; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const policyType = cellOrNull(row[0]);
    const segment    = cellOrNull(row[1]);
    const fuel       = cellOrNull(row[2]);
    const zone       = cellOrNull(row[3]);
    const state      = cellOrNull(row[4]);
    const location   = cellOrNull(row[5]);
    const remarks    = cellOrNull(row[6]);
    const bde        = parsePlainRate(row[7]);
    if (!policyType || !segment || !state) continue;
    if (/^tvs|^ev|^this grid/i.test(policyType)) break;
    if (bde == null) continue;
    const isDeclined = bde === 0;

    // "Scooter / Moped" → 2 separate rules (one per segment).
    const segments = /\bScooter\b.*\bMoped\b|\bMoped\b.*\bScooter\b/i.test(segment)
      ? ['Scooter', 'Moped']
      : [segment];

    // Region aliases (SAOD): "All" or "Kolkata"-style state-level
    // entries in Delhi/HR/UP get labelled "Delhi NCR" by the bulk
    // pipeline.  Handle compound location strings too.
    const stLow = (state || '').toLowerCase();
    const SAOD_LOC_ALIASES = (location === 'All' || !location)
      ? (stLow.includes('delhi') || stLow.includes('haryana') ? ['Delhi NCR', 'NCR'] : [])
      : [];
    const baseLocTokens = location
      ? (location.includes(',')
          ? [location, ...location.split(',').map(s => s.trim()).filter(Boolean)]
          : [location])
      : [state];
    const locTokens = [...new Set([...baseLocTokens, ...SAOD_LOC_ALIASES])];

    for (const seg of segments) {
     for (const locTok of locTokens) {
      const baseRule = {
        product:  'TW',
        sheet_name: meta.sheetName,
        region:   locTok || state,
        sub_type: null,
        segment:  seg,
        make:     'All',
        fuel_type: fuel,
        rate_type: 'SAOD',
        rate_value: isDeclined ? null : bde,
        is_declined: isDeclined,
        carrier_type: zone,
        remarks:  state + (remarks ? ' | ' + remarks : ''),
        rate_text: `${zone} | ${state} | ${location || 'All'} | ${seg} | ${fuel}`,
      };
      rules.push(baseRule);

      // "exc Make" → emit a declined rule for that make in this row's scope.
      let excludedMake = null;
      if (remarks) {
        const excMatch = remarks.match(/exc\s+([A-Za-z][\w\s/]+?)(?:$|\s*[,;])/i);
        if (excMatch) {
          excludedMake = excMatch[1].trim();
          rules.push({
            ...baseRule, make: excludedMake,
            rate_value: null, is_declined: true,
            rate_text: baseRule.rate_text + ` | ${excludedMake} excluded`,
          });
        }
      }

      // TVS −10% applies on SAOD only (per sheet note).  Skip when this
      // row already excludes TVS via "exc TVS" remark.
      if (!isDeclined && !(excludedMake && /tvs/i.test(excludedMake))) {
        rules.push({
          ...baseRule,
          make: 'TVS',
          rate_value: Math.max(0, +(bde - 0.10).toFixed(6)),
          rate_text: baseRule.rate_text + ' | TVS −10% (SAOD)',
        });
      }
     }
    }
  }
  return rules;
}

// ============================================================================
//  GCV Grid
// ============================================================================
//
// Layout (Grid sheet):
//   Multi-section workbook.  Each section starts with a header row like
//     "States | Location | XX Comp | XX SATP | XX Comp Approved | XX SATP Approved"
//   followed by data rows.  Sections are: 3W, 0-2.5T, 2.5T-3.5T, 3.5T-7.5T,
//   7.5T-12T, 12T-17T, 20-25T (and possibly more).
//
// For each data cell we run parseGcvCell to extract rule fragments, then
// emit Base + Approved variants.  Approved formula "Grid+N%" → base + N%.
const GCV_SECTION_PATTERNS = [
  // Detect section header rows by looking at col 2.
  { regex: /^3W\s+Comp$/i,         segment: 'GCV 3W',           weight_band_min: null, weight_band_max: null  },
  { regex: /^0-2\.5T\s+Comp$/i,    segment: 'GCV',              weight_band_min: 0,    weight_band_max: 2.5   },
  { regex: /^2\.5T-3\.5T\s+Comp$/i,segment: 'GCV',              weight_band_min: 2.5,  weight_band_max: 3.5   },
  { regex: /^3\.5T-7\.5T\s+Comp$/i,segment: 'GCV',              weight_band_min: 3.5,  weight_band_max: 7.5   },
  { regex: /^7\.5T-12T\s+Comp$/i,  segment: 'GCV',              weight_band_min: 7.5,  weight_band_max: 12    },
  { regex: /^12T-17T\s+Comp$/i,    segment: 'GCV',              weight_band_min: 12,   weight_band_max: 17    },
  { regex: /^17T-20T\s+Comp$/i,    segment: 'GCV',              weight_band_min: 17,   weight_band_max: 20    },
  { regex: /^20-25T\s+Comp$/i,     segment: 'GCV',              weight_band_min: 20,   weight_band_max: 25    },
  { regex: /^25T-?\+?\s+Comp$/i,   segment: 'GCV',              weight_band_min: 25,   weight_band_max: 999   },
];

function parseGCV(sheetData, sheetConfig, meta) {
  const rules = [];
  let section = null;     // current section context

  for (let r = 0; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const cell0 = String(row[0] || '').trim();
    const cell1 = String(row[1] || '').trim();
    const cell2 = String(row[2] || '').trim();

    // Header row detection
    if (/^states$/i.test(cell0) && /^location$/i.test(cell1)) {
      section = GCV_SECTION_PATTERNS.find(s => s.regex.test(cell2)) || null;
      continue;
    }
    // Section divider rows like "4W & above" — set section to null,
    // wait for the next "States | Location | ..." header.
    if (/^4w\b|^3w\b/i.test(cell0)) { section = null; continue; }
    if (!section) continue;

    const state    = cellOrNull(row[0]);
    const location = cellOrNull(row[1]);
    if (!state || !location) continue;
    if (/^states$|^location$/i.test(state)) continue;

    const baseComp     = String(row[2] || '').trim();
    const baseSatp     = String(row[3] || '').trim();
    const approvedComp = String(row[4] || '').trim();
    const approvedSatp = String(row[5] || '').trim();

    // Each cell may yield multiple fragments — emit Base + Approved per fragment.
    emitGcvCell(rules, section, state, location, 'COMP', baseComp,     approvedComp, meta);
    emitGcvCell(rules, section, state, location, 'SATP', baseSatp,     approvedSatp, meta);
  }
  return rules;
}

// HDFC's bulk-pipeline region resolution maps RTOs to display labels
// like "ROG Bad locations" / "Bad locations" / "Delhi NCR" that don't
// match the rate sheet's literal labels ("Bad" / "All").  This table
// maps each rate-sheet location string to the additional region aliases
// we should emit so the matcher hits.
//
// Entries are scoped per (state, location) when context matters
// (e.g. "Bad" in Gujarat → "ROG Bad locations" but "Bad" in WB
// → different alias).  Use null state for any-state matches.
const HDFC_LOCATION_ALIASES = {
  // Gujarat
  'Gujarat:Bad':                        ['Bad locations', 'ROG Bad locations'],
  'Gujarat:Others, DD, DN':             ['Rest of Gujarat', 'ROG', 'DD', 'DN', 'VADODARA'],
  'Gujarat:Ahemedabad, Surat':          ['Ahmedabad', 'Surat'],

  // Maharashtra — already handled by comma-split, but add the standalone city forms
  'Maharashtra:Good':                   ['Good locations'],
  'Maharashtra:Others 2':               ['Others'],

  // Delhi
  'Delhi:All':                          ['Delhi NCR', 'NCR'],

  // West Bengal
  'West Bengal:Others excluding declined RTOs': ['ROWB', 'Rest of WB', 'Rest of West Bengal'],

  // Karnataka
  'Karnataka:Others':                   ['Rest of Karnataka', 'ROK'],

  // Generic — applied to any state when cell text matches
  '*:All':                              [],   // no extra aliases
  '*:Bad':                              ['Bad locations'],
  '*:All excluding declined RTOs':      [],
};

function getHDFCLocationAliases(state, location) {
  const key1 = `${state}:${location}`;
  const key2 = `*:${location}`;
  return [
    ...(HDFC_LOCATION_ALIASES[key1] || []),
    ...(HDFC_LOCATION_ALIASES[key2] || []),
  ];
}

function emitGcvCell(rules, section, state, location, rateType, baseText, approvedText, meta) {
  // Per user direction: emit ONLY the Approved grid (not Base).  Sub_type
  // is left empty.  When Approved is a "Grid+N%" formula, resolve it by
  // adding N% to the parsed Base value.
  const formulaMatch = String(approvedText || '').trim().match(/^grid\s*\+\s*(\d+(?:\.\d+)?)\s*%?$/i);
  let frags;
  if (formulaMatch) {
    const delta = parseFloat(formulaMatch[1]) / 100;
    const baseFrags = parseGcvCell(baseText);
    frags = baseFrags.map(f => ({
      ...f,
      rate_value: f.rate_value == null ? null : Math.max(0, +(f.rate_value + delta).toFixed(6)),
      label: `${f.label} + Grid+${formulaMatch[1]}%`,
    }));
  } else {
    frags = parseGcvCell(approvedText);
  }

  // Compound location strings like "Mumbai, Pune, Goa" or "Others, DD, DN"
  // need to fan out so a policy whose region resolves to a single token
  // ("Pune") still finds the rule.  We emit BOTH the original compound
  // string AND each comma-separated token as a separate region.  Plus
  // HDFC-specific aliases (e.g. "Bad" → "ROG Bad locations") to bridge
  // the bulk-pipeline's region naming.
  const tokens = location.includes(',')
    ? [location, ...location.split(',').map(s => s.trim()).filter(Boolean)]
    : [location];
  const aliases = getHDFCLocationAliases(state, location);
  const allTokens = [...new Set([...tokens, ...aliases])];

  for (const f of frags) {
    for (const regionToken of allTokens) {
      rules.push({
        // All rules in this file are GCV (cargo).  HDFC ships PCV 3W
        // (passenger autos) as a separate file (HDFC PCCV 3W ...) handled
        // by the pcv_3w sheet kind.  GCV 3W here = goods carrier 3W
        // (Bajaj Maxima Cargo, Atul Shakti, Piaggio APE pickup, etc.).
        product:  'GCV',
        sheet_name: meta.sheetName,
        region:   regionToken,
        sub_type: null,                                          // Sub Modal stays blank
        segment:  section.segment,
        make:     f.make,
        weight_band_min: section.weight_band_min,
        weight_band_max: section.weight_band_max,
        vehicle_age_min: f.vehicle_age_min ?? null,
        vehicle_age_max: f.vehicle_age_max ?? null,
        rate_type: rateType,
        rate_value: f.rate_value,
        is_declined: f.is_declined === true,
        remarks:  state,
        rate_text: `${state} | ${location} | ${section.segment}` +
                   (section.weight_band_min != null ? ` ${section.weight_band_min}-${section.weight_band_max}T` : '') +
                   ` | ${f.label}`,
      });
    }
  }
}

// ============================================================================
//  Top-level dispatch
// ============================================================================
function parse(sheetData, sheetConfig, meta) {
  const kind = sheetConfig.sheet_kind || '';
  switch (kind) {
    case 'robinhood': return parseRobinhood(sheetData, sheetConfig, meta);
    case 'satp':      return parseSATP(sheetData, sheetConfig, meta);
    case 'tw_comp':   return parseTWComp(sheetData, sheetConfig, meta);
    case 'tw_saod':   return parseTWSaod(sheetData, sheetConfig, meta);
    case 'gcv':       return parseGCV(sheetData, sheetConfig, meta);
    case 'pcv_3w':    return parsePCV3W(sheetData, sheetConfig, meta);
    default:
      console.warn(`[hdfc-grid] unknown sheet_kind "${kind}" for sheet "${meta.sheetName}"`);
      return [];
  }
}

module.exports = { parse, parseGcvCell, GEO_ZONE };
