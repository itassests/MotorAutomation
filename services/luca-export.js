/**
 * Luca-format export — download all OUTGOING rates of all insurers in the
 * 35-column "Luca" layout. Only the commission RATE is exported (placed in
 * tp_commission_percentage / irdai_commission_percentage); income and margin
 * are deliberately NOT included.
 *
 * OUTGOING = grid rate − margin (db/schema.sql: "outgoing = rate − margin").
 * This file is handed to AGENTS, so it must never leak the insurer's grid
 * (incoming) rate. The margin is resolved with the SAME matcher the payout
 * engine uses (routes/bulk.js matchMarginForPolicy over active margin_rules),
 * falling back to the engine's per-product synthetic default. Agent-specific
 * overrides (special_rate_rules / global uplifts) are deliberately NOT applied
 * — this is the STANDARD card; a POS with a special rate gets more than this.
 */
'use strict';

const XLSX = require('xlsx');
const { getPool } = require('../db/connection');
const ex = require('./excel-export');
const { loadMarginRules, matchMarginForPolicy } = require('../routes/bulk');
const { expandConfigRules, isSuppressed } = require('./luca-config-expand');

// inferVehicleType emits 'Pvt car' | 'TW' | 'GCV' | 'PCV' | 'MIS' → canonical.
function canonVt(vt) {
  const v = String(vt || '').toUpperCase().replace(/\s+/g, ' ');
  if (v === 'PVT CAR' || v === 'PVT.CAR' || v === '4W' || v === 'CAR') return 'CAR';
  if (v === 'MIS' || v === 'MISC') return 'MISC';
  if (v === '2W' || v === 'TW') return 'TW';
  return v;   // GCV / PCV
}
// Per-product default — mirrors the engine's synthetic default margin
// (routes/bulk.js: Pvt Car 6%, CV 5%, TW 5%).
function defaultMarginPct(canon) {
  if (canon === 'CAR') return 6;
  if (canon === 'GCV' || canon === 'PCV' || canon === 'MISC') return 5;
  if (canon === 'TW') return 5;
  return 0;
}
/** Margin % for a rate_rules row, mirroring the engine's precedence.
 *  Memoised on the dimensions the matcher actually reads — ~215k rules collapse
 *  to a few thousand distinct keys, which turns an O(rules × margin_rules) scan
 *  (hundreds of millions of compares) into something that finishes in seconds. */
function marginPctForRule(r, canon, marginRules, cache) {
  const ton = r.weight_band_min == null ? undefined : Number(r.weight_band_min);
  const key = [r.insurer, canon, r.region, r.state, r.fuel_type, r.make, ton]
    .map(v => String(v == null ? '' : v).toLowerCase()).join('|');
  if (cache && cache.has(key)) return cache.get(key);
  const params = {
    _insurer_slug: r.insurer,
    vehicleType: canon,
    resolvedRegion: r.region || '',
    _stateName: r.state || '',
    fuelType: r.fuel_type || '',
    make: r.make || '',
    tonnage: ton,
    tonnageMin: ton,
  };
  const matched = matchMarginForPolicy(params, null, marginRules);
  const mp = matched ? Number(matched.margin_pct) : null;
  const val = (mp > 0) ? mp : defaultMarginPct(canon);   // real margin wins; else default
  if (cache) cache.set(key, val);
  return val;
}

const LUCA_HEADERS = [
  'id', 'name', 'insurers', 'year', 'month', 'products', 'coverage_type', 'ncb',
  'commission_on', 'tp_commission_percentage', 'irdai_commission_percentage',
  'slab', 'slab_on', 'is_slab_on_first_tenure', 'flat_commission',
  'excluded_vehicles', 'vehicle_make', 'vehicle_model', 'vehicle_cc',
  'vehicle_age', 'seating_capacity', 'gross_vehicle_weight',
  'fuel_type', 'business_type', 'zones', 'included_states',
  'city', 'excluded_cities', 'included_rto', 'excluded_rto', 'sales_channel',
  'rule_type', 'cpa', 'commission_percent_on_total_commission', 'deduction',
  'discount_range', 'REMARK',
];

// Column order in the OUTPUT file (Luca import schema, USER 2026-07-29). Rows are
// BUILT in LUCA_HEADERS order; remap to this before writing so the build code stays
// simple. gross_vehicle_weight + seating_capacity move to the end; REMARK (comment)
// kept as the trailing column.
const OUTPUT_ORDER = [
  'id', 'name', 'insurers', 'year', 'month', 'products', 'coverage_type', 'ncb',
  'commission_on', 'tp_commission_percentage', 'irdai_commission_percentage',
  'slab', 'slab_on', 'is_slab_on_first_tenure', 'flat_commission', 'excluded_vehicles',
  'vehicle_make', 'vehicle_model', 'vehicle_cc', 'vehicle_age', 'fuel_type',
  'business_type', 'zones', 'included_states', 'city', 'excluded_cities',
  'included_rto', 'excluded_rto', 'sales_channel', 'rule_type', 'cpa',
  'commission_percent_on_total_commission', 'deduction', 'discount_range',
  'gross_vehicle_weight', 'seating_capacity', 'REMARK',
];
const _OUT_IDX = OUTPUT_ORDER.map((h) => LUCA_HEADERS.indexOf(h));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Map an internal rule to the granular Luca product taxonomy:
//   auto | bus | gcv | hcv | lcv | pcv | private_bike | private_car |
//   scooter | taxi | tractor
// Uses the vehicle type + segment/sub-type/sheet keywords, and weight bands for
// the GCV light/heavy split (LCV ≤ 7.5T GVW, HCV > 7.5T — the industry default;
// explicit LCV/MCV/HCV labels in the segment override the tonnage cut).
function lucaProduct(vt, seg, sub, sheet, wMin, wMax) {
  const V = String(vt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hay = `${seg || ''} ${sub || ''} ${sheet || ''}`.toUpperCase();
  if (/TRACTOR/.test(hay)) return 'tractor';
  if (V === 'CAR' || V === '4W' || V === 'PC' || V === 'PVTCAR') return 'private_car';
  if (V === 'TW' || V === '2W' || V === 'TWEV') {
    if (/SCOOT|SCOOTY|MOPED|ACTIVA|JUPITER|FASCINO|ACCESS|\bDIO\b|NTORQ|PLEASURE|VESPA|CHETAK|MAESTRO|BURGMAN/.test(hay)) return 'scooter';
    return 'private_bike';
  }
  if (V === 'PCV') {
    if (/\bBUS\b/.test(hay)) return 'bus';
    if (/AUTO|E-?RICK|E-?CART|RICKSHAW|\b3\s*W|3\s*WHEEL|TREO/.test(hay)) return 'auto';
    if (/TAXI|\bCAB\b|KAALI|MAXICAB|6\s*\+\s*1|7\s*\+\s*1/.test(hay)) return 'taxi';
    return 'pcv';
  }
  if (V === 'GCV') {
    // A 3-wheeler goods carrier (GCV3W / goods auto) is NOT a light truck — keep it
    // distinct so it doesn't collapse onto an LCV of the same tonnage (USER 2026-08,
    // Bajaj: "GCV3W" vs "GCV4W 1.8-2.5T" both fell to 'lcv').
    if (/GCV\s*3\s*W|\b3\s*W\b|3\s*WHEEL|THREE\s*WHEEL/.test(hay)) return 'gcv_3w';
    if (/\bHCV\b|HEAVY/.test(hay)) return 'hcv';
    if (/\bLCV\b|\bMCV\b|LIGHT/.test(hay)) return 'lcv';
    // Tonnage from the weight band (or the largest number in the segment text).
    let t = Number(wMax);
    if (!Number.isFinite(t) || t <= 0) {
      const nums = (hay.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0 && n < 100);
      t = nums.length ? Math.max(...nums) : null;
    }
    if (t != null) return t <= 7.5 ? 'lcv' : 'hcv';
    return 'gcv';
  }
  if (V === 'MISC' || V === 'MIS') {
    if (/AUTO|E-?RICK|RICKSHAW|\b3\s*W/.test(hay)) return 'auto';
    return 'misc';   // Ambulance / MISC-D / Motor Trade / CPA etc. are Misc, NOT gcv
  }
  return V.toLowerCase();
}

// Map our internal insurer slug → the short Luca insurer id (sample uses "hdfc").
// First token before the underscore covers most (hdfc_ergo→hdfc, tata_aig→tata,
// icici_lombard→icici …); multi-word govt insurers keep two tokens.
function lucaInsurer(slug) {
  const s = String(slug || '').toLowerCase().trim().replace(/\s+/g, '_');
  const KEEP_TWO = new Set(['new_india', 'united_india', 'go_digit']);
  const two = s.split('_').slice(0, 2).join('_');
  if (KEEP_TWO.has(two)) return two;
  return s.split('_')[0] || s;
}

// rate_value → Luca % number. The column is INCONSISTENT: most rows are fractions
// (0.275 → 27.5) but some insurers/cards store the percent directly (shriram, and
// mis-ingested tata/go_digit rows: 40 = 40%). A blind ×100 turned those into
// 4-digit values (4000). Fix: only scale fractions (|v| < 1) — values ≥ 1 are
// already percents. Commission % can't be negative, so use the magnitude
// (a few go_digit/chola rows carry a stray minus sign).
function pct(v) {
  if (v == null || v === '') return '';
  let n = Number(v);
  if (!Number.isFinite(n)) return '';
  n = Math.abs(n);
  if (n < 1) n = n * 100;                 // fraction → percent; ≥1 already a percent
  return +n.toFixed(3);
}

// NCB qualifier (TRUE / FALSE / blank) from the rate_type tag.
function lucaNcb(rateType) {
  const rt = String(rateType || '').toUpperCase();
  if (/NON[_\s-]*NCB|NCB\s*[:=]\s*(NONE|NO\b|ZERO|0)/.test(rt)) return 'FALSE';
  if (/NCB\s*[:=]\s*(GT0|YES|NCB)|\bWITH\s*NCB\b/.test(rt)) return 'TRUE';
  return '';
}

// Luca range columns — spec (USER): "Format: [min, max]. Leave blank for all.
// if no max value then null, if no min value make 1"  →  [1000,null] , [1,999]
//
// The ingested bands spell "no bound" several ways and each column has its own
// sentinel, so normalise per column:
//   opts.minDefault — value to use when there is no lower bound (1 for cc /
//                     seating / GVW where 0 is meaningless; 0 for AGE, where a
//                     0-year-old vehicle is real and means brand-new).
//   opts.noMax      — an upper sentinel meaning "no upper bound" (cc 99999,
//                     age 99, GVW 999T). Values at/above it become null.
//   opts.scale      — multiply into the spec's unit (GVW is stored in TONNES,
//                     Luca wants KG → scale 1000, so 2.5T → 2500).
function rangeArr(min, max, opts) {
  const o = opts || {};
  const minDefault = o.minDefault == null ? 1 : o.minDefault;
  let lo = (min == null) ? null : Number(min);
  let hi = (max == null) ? null : Number(max);
  if (!Number.isFinite(lo)) lo = null;
  if (!Number.isFinite(hi)) hi = null;
  // A 0 lower bound means "no lower bound" — except where 0 is a real value (age).
  if (lo === 0 && minDefault !== 0) lo = null;
  if (hi != null && o.noMax != null && hi >= o.noMax) hi = null;
  if (lo == null && hi == null) return '';        // unbounded both ways = all
  const sc = (v) => +(v * (o.scale || 1)).toFixed(0);
  return `[${lo == null ? minDefault : sc(lo)},${hi == null ? 'null' : sc(hi)}]`;
}
const ccBand   = (mn, mx) => rangeArr(mn, mx, { minDefault: 1, noMax: 99999 });
const ageBand  = (mn, mx) => rangeArr(mn, mx, { minDefault: 0, noMax: 99 });
const seatBand = (mn, mx) => rangeArr(mn, mx, { minDefault: 1 });
// GVW: stored in TONNES, Luca wants KG (2.5T -> 2500). 999T = "no upper bound".
const gvwBand  = (mn, mx) => rangeArr(mn, mx, { minDefault: 1, noMax: 999, scale: 1000 });

// Some insurers encode the age band ONLY in the segment text (e.g. Magma TP rows
// "GCV 12T-20T Age<5" / "Age>=5" ship with both age columns NULL), so the structured
// vehicle_age comes out blank and age-banded rows collapse into look-alikes. Parse a
// [min,max] band from the segment as a last resort. "Age<5"→[0,4], "Age>=5"→[5,null].
function ageBandFromSegment(seg) {
  const s = String(seg || '');
  let m;
  if ((m = /age\s*<\s*(\d+)/i.exec(s)))  return [0, +m[1] - 1];
  if ((m = /age\s*<=\s*(\d+)/i.exec(s))) return [0, +m[1]];
  if ((m = /age\s*>=\s*(\d+)/i.exec(s))) return [+m[1], null];
  if ((m = /age\s*>\s*(\d+)/i.exec(s)))  return [+m[1] + 1, null];
  if ((m = /\bage\s*(\d+)\s*[-–]\s*(\d+)/i.exec(s))) return [+m[1], +m[2]];
  return null;
}

// Render a band (used for vehicle_age). Bands are often OPEN-ENDED — "6+ years"
// has no upper bound — and `${min}-${max}` printed those as a dangling "6-",
// which reads as a missing value rather than an open end.
//   both ends → "1-5"
//   no lower  → "0-5"   (upto 5)
//   no upper  → "6+"    (6 and above; a numeric sentinel like 9999 years is nonsense)
function band(min, max) {
  if (min == null && max == null) return '';
  if (min == null) return `0-${max}`;
  if (max == null) return `${min}+`;
  return `${min}-${max}`;
}

// ---- Canonical Luca state slug resolver -------------------------------------
// Maps the many source spellings of a state/region/city (rr.state or rr.region)
// to ONE canonical Luca state slug. Handles: casing, "&"→and, "Rest of X",
// variant spellings (Orissa→odisha, Chattisgarh→chhattisgarh), 2-letter RTO
// prefixes (MH→maharashtra), and major cities (Chennai→tamil_nadu).
const STATE_MAP = {};
const _sk = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const _addState = (slug, ...variants) => { for (const v of variants) STATE_MAP[_sk(v)] = slug; };
_addState('jammu_and_kashmir', 'jammu and kashmir', 'jammu & kashmir', 'j&k', 'jk', 'jammu kashmir', 'jammu', 'kashmir', 'ladakh', 'la');
_addState('himachal_pradesh', 'himachal pradesh', 'himachal', 'hp');
_addState('punjab', 'punjab', 'pb');
_addState('uttarakhand', 'uttarakhand', 'uttaranchal', 'uk', 'ua');
_addState('uttar_pradesh', 'uttar pradesh', 'up', 'lucknow', 'kanpur', 'noida');
_addState('haryana', 'haryana', 'hr', 'gurgaon', 'gurugram', 'faridabad');
_addState('delhi', 'delhi', 'new delhi', 'dl', 'delhi ncr', 'ncr');
_addState('chandigarh', 'chandigarh', 'ch');
_addState('bihar', 'bihar', 'br', 'patna');
_addState('odisha', 'odisha', 'orissa', 'od', 'or', 'bhubaneshwar', 'bhubaneswar', 'cuttack');
_addState('jharkhand', 'jharkhand', 'jh', 'ranchi');
_addState('west_bengal', 'west bengal', 'wb', 'kolkata', 'calcutta');
_addState('assam', 'assam', 'as', 'guwahati');
_addState('sikkim', 'sikkim', 'sk');
_addState('nagaland', 'nagaland', 'nl');
_addState('meghalaya', 'meghalaya', 'ml', 'shillong');
_addState('manipur', 'manipur', 'mn', 'imphal');
_addState('mizoram', 'mizoram', 'mz');
_addState('tripura', 'tripura', 'tr', 'agartala');
_addState('arunachal_pradesh', 'arunachal pradesh', 'arunachal', 'ar');
_addState('rajasthan', 'rajasthan', 'rj', 'jaipur');
_addState('gujarat', 'gujarat', 'gj', 'ahmedabad', 'surat', 'vadodara');
_addState('goa', 'goa', 'ga');
_addState('maharashtra', 'maharashtra', 'mh', 'mumbai', 'pune', 'nagpur', 'nashik', 'thane', 'aurangabad');
_addState('daman_and_diu', 'daman and diu', 'daman & diu', 'daman', 'diu', 'dd');
_addState('dadra_and_nagar_haveli', 'dadra and nagar haveli', 'dadra & nagar haveli', 'dadra', 'dnh', 'dn', 'silvassa');
_addState('andhra_pradesh', 'andhra pradesh', 'andra pradesh', 'ap', 'andhra', 'vijayawada', 'visakhapatnam');
_addState('karnataka', 'karnataka', 'ka', 'bangalore', 'bengaluru', 'mysore', 'mysuru');
_addState('kerala', 'kerala', 'kl', 'kochi', 'cochin', 'trivandrum', 'thiruvananthapuram');
_addState('tamil_nadu', 'tamil nadu', 'tamilnadu', 'tn', 'chennai', 'coimbatore', 'madras');
_addState('telangana', 'telangana', 'ts', 'tg', 'hyderabad');
_addState('puducherry', 'puducherry', 'pondicherry', 'py', 'pondy');
_addState('lakshadweep', 'lakshadweep', 'lakshdweep', 'ld');
_addState('andaman_and_nicobar', 'andaman and nicobar', 'andaman & nicobar', 'andaman', 'andamans', 'nicobar', 'an');
_addState('madhya_pradesh', 'madhya pradesh', 'mp', 'indore', 'bhopal', 'gwalior', 'jabalpur');
_addState('chhattisgarh', 'chhattisgarh', 'chattisgarh', 'chhatisgarh', 'cg', 'raipur');
// Full-state-name keys (length ≥ 5) for substring fallback ("MAHARASHTRA OTHERS").
// Sorted LONGEST-FIRST: several state names contain a shorter one, and the loop
// returns the first hit. "ANDAMAN" contains "DAMAN", so in insertion order every
// Andaman region resolved to daman_and_diu ("ANDAMAN & NICOBAR ISLANDS" and
// "South Andaman" both mapped to Daman & Diu). Longest-first makes the specific
// name win over the substring.
const _STATE_NAME_KEYS = Object.keys(STATE_MAP)
  .filter((k) => k.length >= 5)
  .sort((a, b) => b.length - a.length);

function resolveStateSlug(raw) {
  if (!raw) return null;
  let s = String(raw).toUpperCase().trim().replace(/\s*&\s*/g, ' AND ');
  s = s.replace(/^REST\s+OF\s+/, '').replace(/\s+(OTHERS?|REGION|ZONE|KEY\s*CITIES?|CITY|CITIES)$/g, '');
  const k = _sk(s);
  if (STATE_MAP[k]) return STATE_MAP[k];                 // exact
  const m = s.match(/^([A-Z]{2})[\s-]?\d/);              // RTO code prefix (MH12 → MH)
  if (m && STATE_MAP[_sk(m[1])]) return STATE_MAP[_sk(m[1])];
  for (const key of _STATE_NAME_KEYS) if (k.includes(key)) return STATE_MAP[key]; // substring
  return null;
}

/** Canonical Luca state slug from a rule's state/region (prefers state). */
function lucaState(state, region) {
  return resolveStateSlug(state) || resolveStateSlug(region) || '';
}

// city — the sub-state locality that distinguishes a rule (USER: "city is not
// populating due to this it looks duplicate records"). A rule's region is often a
// CITY / cluster (MAHOBA, ERNAKULAM/KOCHI, "Kanpur,Varanasi", "HARYANA (Excluding
// Gurgaon and Faridabad)") — 1,376 of 2,872 distinct regions. included_states only
// carries the STATE, so two rules for different cities in the same state rendered
// identically. Put the city/cluster region here; blank it when the region is a
// bare STATE (included_states already has that) or a state code / "ALL".
const _BARE_STATE = new Set(['MAHARASHTRA', 'GUJARAT', 'KARNATAKA', 'KERALA', 'TAMILNADU',
  'TELANGANA', 'ANDHRAPRADESH', 'DELHI', 'PUNJAB', 'HARYANA', 'RAJASTHAN', 'WESTBENGAL',
  'BIHAR', 'MADHYAPRADESH', 'UTTARPRADESH', 'UTTARAKHAND', 'ODISHA', 'ORISSA', 'ASSAM',
  'GOA', 'CHHATTISGARH', 'CHATTISGARH', 'JHARKHAND', 'HIMACHALPRADESH', 'JAMMUANDKASHMIR',
  'CHANDIGARH', 'PONDICHERRY', 'PUDUCHERRY', 'DAMANDDIU', 'DADRAANDNAGARHAVELI',
  'ANDAMANANDNICOBAR', 'SIKKIM', 'TRIPURA', 'MEGHALAYA', 'MANIPUR', 'MIZORAM', 'NAGALAND',
  'ARUNACHALPRADESH', 'LAKSHADWEEP']);
function lucaCity(region) {
  const raw = String(region || '').trim();
  if (!raw) return '';
  const U = raw.toUpperCase();
  // Reject segment / cover / spec text that leaks from the region column into
  // "city" (e.g. Bajaj "GCV4 12 To 20T 0 To 1 year (Low CD2 RTOs @ 10% CD2)").
  // A real city/locality is plain alphabetic — no digits, no rate/spec symbols,
  // and no vehicle-type / cover / tonnage / age keywords.
  if (/\d/.test(raw)) return '';                                // GCV4, 12 To 20T, 6+ Years, @10%, CD2
  if (/[@%()\[\]{}<>+\/]/.test(raw)) return '';                 // rate / spec / cluster-combo symbols
  if (/GCV|PCV|LCV|HCV|GCCV|PCCV|\bMISC\b|SEATER|TONNE|\bTON\b|\bGVW\b|\bCD1\b|\bCD2\b|\bRTOS?\b|YEAR|\bYRS?\b|BUNDL|PACKAGE|LIABILITY|\bSATP\b|\bSAOD\b|\bCOMP\b|EXCLUD|EXCEPT|MENTION/.test(U)) return '';
  const bare = raw.toUpperCase().replace(/[^A-Z]/g, '');       // 2-letter state code?
  if (/^[A-Z]{2}$/.test(bare) && STATE_MAP[_sk(bare)]) return '';
  const n = bare.replace(/^RESTOF/, '').replace(/(OTHERS?|REGION|ZONE|KEYCITIES?|CITY|CITIES)$/, '');
  if (!n || n === 'ALL' || n === 'PANINDIA' || n === 'ALLINDIA' || n === 'INDIA'
      || _BARE_STATE.has(n)) return '';                         // region IS a state / pan-India / wildcard
  return raw;                                                    // real city / cluster
}

// Sanitize the vehicle_make column. rr.make is polluted in several grids with
// non-make values: category descriptors ("All", "All Electric Make", "All
// excluding Volvo and Scania", "Excluding Eicher", "All Other Make/Models"),
// age bands mis-mapped into make ("0 yr", "10+ yrs", "4-5 ys", "1+ yr") and
// stray numbers/rates ("0.7", "0.8"). Luca vehicle_make wants a SPECIFIC make
// or blank (= all makes) — so blank out all of the above, keep real makes.
// Insurer grids abbreviate makes ("AL" = Ashok Leyland, "M&M" = Mahindra &
// Mahindra). Agents read this file, so spell them out. Token-anchored (\b) so
// ALTO / ALL / RENAULT are untouched; SML skips the lookahead when the grid
// already says "SML ISUZU" (avoids "SML Isuzu ISUZU").
const MAKE_EXPANSIONS = [
  [/\bA\.?L\.?\b/gi, 'Ashok Leyland'],
  [/\bM\s*&\s*M\b/gi, 'Mahindra & Mahindra'],
  [/\bSML\b(?!\s*ISUZU)/gi, 'SML Isuzu'],
  [/\bRE\b/gi, 'Royal Enfield'],
  [/\bHMSI\b/gi, 'Honda Motorcycle & Scooter India'],
  [/\bHMC\b/gi, 'Hyundai Motor Company'],
  [/\bMSIL\b/gi, 'Maruti Suzuki'],
  [/\bTML\b/gi, 'Tata Motors'],
  [/\bBAL\b/gi, 'Bajaj Auto'],
  [/\bVECV\b/gi, 'VE Commercial Vehicles'],
];
function expandMake(s) {
  let out = s;
  for (const [re, full] of MAKE_EXPANSIONS) out = out.replace(re, full);
  return out.replace(/\s{2,}/g, ' ').trim();
}

// Luca keeps make (manufacturer) and model as SEPARATE fields, but some grids
// put the MODEL in the make column: Bajaj files make = model = "Thar", ICICI
// files make = "Omni" with an empty model. Map the model back to its maker so
// vehicle_make is a real manufacturer and vehicle_model carries the model.
// Only well-known models are listed — an unmapped value is left untouched
// rather than risk asserting the wrong manufacturer to an agent.
const MODEL_TO_MAKE = {
  // Maruti Suzuki
  'OMNI': 'Maruti Suzuki', 'CIAZ': 'Maruti Suzuki', 'IGNIS': 'Maruti Suzuki',
  'JIMNY': 'Maruti Suzuki', 'GRAND VITARA': 'Maruti Suzuki',
  // Hyundai
  'CRETA': 'Hyundai', 'VENUE': 'Hyundai', 'ALCAZAR': 'Hyundai',
  // Tata
  'NEXON': 'Tata', 'HARRIER': 'Tata', 'SAFARI': 'Tata',
  // Mahindra — "Max Pick Up"/"Max 2"/"Max 3" are the Maxx/Maxximo 2.5-3.5T GCV pickups
  'THAR': 'Mahindra', 'XUV700': 'Mahindra', 'SCORPIO N': 'Mahindra',
  'MAX PICK UP': 'Mahindra', 'MAX 2': 'Mahindra', 'MAX 3': 'Mahindra',
  // Kia
  'SELTOS': 'Kia', 'SONET': 'Kia', 'CARENS': 'Kia', 'CARNIVAL': 'Kia',
  // Skoda
  'KUSHAQ': 'Skoda', 'KODIAQ': 'Skoda',
  // Volkswagen
  'TAIGUN': 'Volkswagen', 'TIGUAN': 'Volkswagen',
  // Toyota — Urban Cruiser Hyryder / Innova Hycross
  'HYRYDER': 'Toyota', 'HYCROSS': 'Toyota',
};
// Sanitize vehicle_model. Some grids park a SEGMENT classifier in the model
// column — "HE/UHE" / "Other than HE/UHE" (High-End / Ultra-High-End car tiers)
// are not models and mean nothing to an agent. A genuine multi-model list
// ("Ace, Super Ace, Yodha…") is left intact.
function lucaModel(m) {
  const s = String(m == null ? '' : m).trim();
  if (!s) return '';
  const u = s.toUpperCase().replace(/\s+/g, ' ');
  if (/^(OTHER\s+THAN\s+)?(HE|UHE)(\s*\/\s*(HE|UHE))?$/.test(u)) return '';   // HE/UHE tier, not a model
  if (/^(MODEL|MAKE|SEGMENT|ALL|OTHERS?)$/.test(u)) return '';                 // header/placeholder leak
  return s;
}

/** Split a rate_rules row into a real {make, model} pair for Luca. */
function lucaMakeModel(r) {
  const make = lucaMake(r.make);
  const model = lucaModel(r.model);
  const maker = MODEL_TO_MAKE[make.toUpperCase()];
  if (maker) return { make: maker, model: model || make };   // model sat in the make column
  return { make, model };
}

// Is a single token a real make (not a header, keyword, number, spec, region…)?
function _isRealMakeToken(s) {
  const u = s.toUpperCase();
  if (/^(MAKE|MAKES|SEGMENT|MODEL|MODELS|ONLY|FOR|INCL|INCLUDE|INCLUDES|INCLUDING|WITH|WITHOUT|DOABLE|AND|OR|THE|OTHERS?|OTHER\s*MAKES?)$/.test(u)) return false; // annotation words
  if (s.replace(/[^A-Za-z]/g, '').length <= 1) return false;         // single-letter leak ("D")
  if (/[%:_+<>]/.test(s)) return false;                              // rate/remark/spec leak
  if (/^\d+(\.\d+)?$/.test(s)) return false;                         // pure number / rate
  if (/\b(YR|YRS|YEAR|YEARS|YS)\b/.test(u) || /^\d+\s*[-]/.test(s)) return false; // age band
  if (/^ALL\b/.test(u) || /^NON[\s-]/.test(u)) return false;         // "All ..." / "Non Tata"
  if (/EXCLUD|EXCEPT|OTHER\s+MAKE|OTHER\s+MODEL|OTHER\s+THAN|\bREF\b/.test(u)) return false;
  if (/GCV|PCV|LCV|HCV|MCV|GCCV|PCCV|\bMISC\b|SEATER|SEAT|TONNE|\bTON\b|GVW|LAKH|\bLAC\b|UPTO|DUMPER|TIPPER|BACKHOE|EXCAVATOR|LOADER|CRANE|HARVESTER|TAXI|\bBUS\b|TANKER|DRILLING|\bRIG\b|MOBILEPLANT|RICKSHAW|E-?LOADER/.test(u)) return false;
  if (/\d\s*T\b/.test(u) || /^[A-Z]{2}\s?\d/.test(u)) return false;  // tonnage / RTO-region code
  if (resolveStateSlug(s)) return false;                            // the value IS a region / city / state
  return true;
}
// vehicle_make: only real make name(s). Strips parenthetical notes, splits multi-
// make lists ("Tata, Ashok Leyland & Eicher"), drops annotation words ("For",
// "Only", "including", …) that leaked from the grid, expands abbreviations, dedupes.
function lucaMake(m) {
  const raw = String(m == null ? '' : m).trim();
  if (!raw) return '';
  const stripped = raw.replace(/\([^)]*\)/g, ' ');                  // drop "(including …)" notes
  const out = []; const seen = new Set();
  for (const part of stripped.split(/\s*(?:,|&|\/|\band\b)\s*/i)) {
    const s = part.trim();
    if (!s || !_isRealMakeToken(s)) continue;
    const exp = expandMake(s); const key = exp.toUpperCase();
    if (exp && !seen.has(key)) { seen.add(key); out.push(exp); }
  }
  return out.join(', ');
}

// Canonical Luca fuel_type: ELECTRICITY | DIESEL | INTERNAL_LPG_CNG | PETROL.
// INBUILT = factory gas kit → CNG family. Hybrid/HEV runs on a petrol engine →
// PETROL. Multi-fuel grid rows ("Petrol/CNG/EV", "Other than Diesel") and "All"
// map to blank (the rate applies across fuels — Luca reads blank as all fuels).
function lucaFuel(f) {
  const u = String(f || '').toUpperCase().trim();
  if (!u || u === 'ALL' || /OTHER\s+THAN/.test(u)) return '';
  const hits = [];
  if (/DIESEL/.test(u)) hits.push('DIESEL');
  if (/ELECTRIC|\bEV\b|BATTERY/.test(u)) hits.push('ELECTRICITY');
  if (/CNG|LPG|INBUILT|BI[\s-]?FUEL/.test(u)) hits.push('INTERNAL_LPG_CNG');
  if (/PETROL|GASOLINE|HYBRID|\bHEV\b/.test(u)) hits.push('PETROL');
  return hits.length === 1 ? hits[0] : '';
}

// Business type from segment/sub_type/rate_type keywords: new | rollover |
// renewal | used. Blank when the rule isn't scoped to a business type (most
// rules apply to all), so the column no longer leaks segment/CC/tonnage codes.
// Order matters: rollover/renewal/used are checked before "new" because a
// segment can carry both a cover tag and a bare "NEW" (e.g. "1_TRAC[NEW]").
function lucaBusinessType(seg, sub, rateType) {
  const hay = `${seg || ''} ${sub || ''} ${rateType || ''}`.toUpperCase();
  if (/ROLL[\s-]?OVER/.test(hay)) return 'rollover';
  if (/RENEW/.test(hay)) return 'renewal';
  if (/\bUSED\b|SECOND[\s-]?HAND|PRE[\s-]?OWNED|\bOLD\b/.test(hay)) return 'used';
  if (/BRAND[\s-]?NEW|\bNEW\b|\[NEW\]/.test(hay)) return 'new';
  return '';
}

/**
 * @param {number|number[]} ids  rate_card id(s) to export.
 * @returns {Promise<Buffer>} xlsx buffer in Luca layout.
 */
// included_rto — the actual RTO codes a rule covers, comma-separated (USER).
// rate_rules has no rto column; the codes live in rto_mappings keyed by
// (insurer, region|cluster). Two gotchas found in the data:
//   1. Some insurers put the rule's region in rto_mappings.REGION (chola "MUMBAI
//      THANE") and others in .CLUSTER (sbi rules say "AP - Rest", whose region
//      column holds the state code "AP") — so index BOTH.
//   2. Some rules name the state in full ("MAHARASHTRA") where the mapping uses
//      the 2-letter RTO prefix ("MH") — hence the state-name fallback.
// Coverage on the live book: region-only 44.9% → +cluster 63.4% → +state ~65%.
// A rule whose region matches nothing is left BLANK rather than guessed — a wrong
// RTO list would tell an agent a rate applies where it does not.
const STATE_TO_RTO_PREFIX = {
  'ANDHRA PRADESH': 'AP', 'ARUNACHAL PRADESH': 'AR', 'ASSAM': 'AS', 'BIHAR': 'BR',
  'CHHATTISGARH': 'CG', 'CHATTISGARH': 'CG', 'GOA': 'GA', 'GUJARAT': 'GJ',
  'HARYANA': 'HR', 'HIMACHAL PRADESH': 'HP', 'JAMMU AND KASHMIR': 'JK', 'JHARKHAND': 'JH',
  'KARNATAKA': 'KA', 'KERALA': 'KL', 'MADHYA PRADESH': 'MP', 'MAHARASHTRA': 'MH',
  'MANIPUR': 'MN', 'MEGHALAYA': 'ML', 'MIZORAM': 'MZ', 'NAGALAND': 'NL',
  'ODISHA': 'OD', 'ORISSA': 'OD', 'PUNJAB': 'PB', 'RAJASTHAN': 'RJ', 'SIKKIM': 'SK',
  'TAMIL NADU': 'TN', 'TAMILNADU': 'TN', 'TELANGANA': 'TS', 'TRIPURA': 'TR',
  'UTTAR PRADESH': 'UP', 'UTTARAKHAND': 'UK', 'WEST BENGAL': 'WB', 'DELHI': 'DL',
  'CHANDIGARH': 'CH', 'PUDUCHERRY': 'PY', 'PONDICHERRY': 'PY',
};
// magma & magma_hdi are the same underwriter with the SAME cluster labels, but
// their rto_mappings DIVERGE — small "rest-of-state" clusters (CG5, MH7, GJ5, TL4…)
// are filed only under `magma`, while most rate_rules are `magma_hdi` → blank
// included_rto and clusters collapse. Canonicalize the two slugs so their mappings
// merge. Verified state-consistent (CG5→CG, GJ5→GJ, TL4→TS/TG) — no cross-contamination.
const RTO_INSURER_ALIAS = { magma_hdi: 'magma' };
const _rkey = (ins, g) => {
  let s = String(ins || '').toLowerCase().trim();
  s = RTO_INSURER_ALIAS[s] || s;
  return s + '|' + String(g || '').toUpperCase().replace(/\s+/g, ' ').trim();
};

// Normalise an RTO code to ONE uniform shape (USER): "MH-01" — 2-letter state,
// dash, 2-digit zero-padded district. KA05 / KA5 / "KA 43" / KA-05 all collapse to
// KA-05 / KA-43.
// The trailing letter is DROPPED. In an Indian registration (DL-6C-AB-1234) the
// letter after the district is the VEHICLE-CLASS / series code, NOT part of the
// RTO — "DL6I" is not an RTO, the RTO is DL-06 (USER). Delhi alone has 567 raw
// variants (DL00, DL01, DL-01, DL02C, DL0C, DL0D, DL0I, DL1, DL001 …) that are
// really just 92 offices.
// Dropped entirely, because they are not an RTO the agent can act on:
//   - "ALL" (wildcard — the whole cell goes blank, per USER)
//   - PIN codes / pure numbers ("560098")
//   - unparseable junk ("APRTOCODENOTEXIST", "BIA", "TN/G", "DL1P to DL18P" ranges)
// Dropping beats emitting a malformed code that no one can match on.
function normRto(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s === 'ALL' || /^\d+$/.test(s)) return null;
  const m = s.match(/^([A-Z]{2})(\d{1,3})[A-Z]{0,2}$/);   // trailing class letter ignored
  if (!m) return null;
  return m[1] + '-' + String(parseInt(m[2], 10)).padStart(2, '0');
}

/** insurer+region/cluster → sorted, comma-separated RTO codes. */
async function loadRtoIndex(pool) {
  const rs = await pool.request().query(
    'SELECT insurer, region, cluster, rto_code FROM rto_mappings WHERE rto_code IS NOT NULL');
  const sets = new Map();
  const byState = new Map();   // state prefix ("MH") -> Set of "MH-01" codes
  for (const r of rs.recordset) {
    const code = normRto(r.rto_code);   // uniform MH-01 shape; drops ALL / PIN / junk
    if (!code) continue;
    const st = code.slice(0, 2);        // "MH-01" -> "MH"
    if (!byState.has(st)) byState.set(st, new Set());
    byState.get(st).add(code);
    for (const g of [r.region, r.cluster]) {
      if (!g || !String(g).trim()) continue;
      const k = _rkey(r.insurer, g);
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k).add(code);
    }
  }
  const out = new Map();
  for (const [k, s] of sets) out.set(k, [...s].sort().join(','));
  const stateRtos = new Map();
  for (const [st, s] of byState) stateRtos.set(st, [...s].sort().join(','));
  out._stateRtos = stateRtos;   // attach the global state->RTO map to the index
  return out;
}
// Valid 2-letter RTO/state prefixes (STATE_TO_RTO_PREFIX values + UTs/islands not
// in the state-name map). A rate_rule whose region is one of these is a whole-STATE
// rule; expand it to every RTO in that state so it is not left blank.
const STATE_PREFIXES = new Set([
  ...Object.values(STATE_TO_RTO_PREFIX),
  'AN', 'LD', 'DN', 'DD', 'CH', 'PY', 'TG', 'UA', 'OR', 'UT', 'SK', 'MN', 'MZ', 'AR',
]);
function asStatePrefix(region) {
  let g = String(region || '').toUpperCase().replace(/\s+/g, ' ').trim();
  // "REST OF TAMIL NADU" / "ROM" → the state itself (whole-state fallback).
  g = g.replace(/^REST\s+OF\s+/, '').trim();
  if (STATE_PREFIXES.has(g)) return g === 'TG' ? 'TS' : (g === 'OR' ? 'OD' : (g === 'UA' || g === 'UT' ? 'UK' : g));
  return STATE_TO_RTO_PREFIX[g] || '';
}
// Whole-state fallback: region is a state code/name -> every RTO in that state.
function stateRtoList(idx, region) {
  const p = asStatePrefix(region);
  return (p && idx && idx._stateRtos && idx._stateRtos.get(p)) || '';
}
function rtoListFor(idx, insurer, region) {
  const g = String(region || '').trim();
  if (!g) return '';
  return idx.get(_rkey(insurer, g))
      || idx.get(_rkey(insurer, STATE_TO_RTO_PREFIX[g.toUpperCase().replace(/\s+/g, ' ')] || ' '))
      || '';
}

// RTO-code → city/district name, so the "city" column shows the ACTUAL cities in a
// region cluster (e.g. Liberty "GUJARAT - 1 A" → Ahmedabad, Gandhinagar) instead of
// the opaque cluster label. Keyed in normRto shape ("GJ-01"). Primary source:
// bajaj_rto_district (clean district names); supplemented by tata_rto_cluster where
// its value is a plausible city (skip state/region/ROW* labels).
const RTO_CITY = (() => {
  const map = {};
  const add = (raw, city) => { const k = normRto(raw); const c = String(city || '').trim(); if (k && c && !map[k]) map[k] = c; };
  try { const bd = require('../config/bajaj_rto_district.json'); for (const k in bd) add(k, typeof bd[k] === 'string' ? bd[k] : (bd[k] && (bd[k].district || bd[k].city))); } catch (_) { /* optional */ }
  try {
    const tc = require('../config/tata_rto_cluster.json');
    for (const k in tc) {
      const v = tc[k]; const city = v && (v.car || v.cv || v.tw);
      if (city && !/^RO[A-Z]{2}$|^ROW|^REST\b|PRADESH|\bBENGAL\b|\bNADU\b|ODISHA|^GUJARAT$|^MAHARASHTRA$|^KERALA$|^KARNATAKA$|^BIHAR$|^GOA$|^ASSAM$/i.test(city)) add(k, city);
    }
  } catch (_) { /* optional */ }
  return map;
})();
// Map a comma-separated normRto list ("GJ-01, GJ-18") → deduped city names.
function citiesFromRtoList(rtoStr) {
  if (!rtoStr) return '';
  const seen = new Set(); const out = [];
  for (const code of String(rtoStr).split(',')) {
    const c = RTO_CITY[code.trim()];
    if (c && !seen.has(c.toUpperCase())) { seen.add(c.toUpperCase()); out.push(c); }
  }
  return out.join(', ');
}

// Go Digit Pvt-Car SATP is keyed by a DEDICATED "4W TP" cluster taxonomy
// (HP_Bad, WB_Good, PB_Good … — 92 clusters), NOT the Comp cluster in
// rto_mappings. The SATP rate_rules carry the cluster name as `region`, which
// rto_mappings can't resolve — so ALL 92 clusters render with a BLANK rto/city
// in the Luca file and collapse to one look-alike key per (cc,age,fuel), leaving
// ~530 "same key, different rate" rows that Luca rejects as conflicts. Invert the
// SATP config's rtoCluster {RTO→cluster} into {cluster→RTO list} so each cluster
// gets its real included_rto and the rows stay distinct (USER 2026-08, Digit).
const GD_SATP_CLUSTER_RTOS = (() => {
  const out = new Map();
  try {
    const rc = (require('../config/go_digit_car_tp_jun26.json') || {}).rtoCluster || {};
    const inv = new Map();
    for (const [rto, cluster] of Object.entries(rc)) {
      const code = normRto(rto);
      if (!code) continue;
      const key = String(cluster).toUpperCase().replace(/\s+/g, ' ').trim();
      if (!inv.has(key)) inv.set(key, new Set());
      inv.get(key).add(code);
    }
    for (const [k, s] of inv) out.set(k, [...s].sort().join(','));
  } catch (_) { /* config missing → no-op */ }
  return out;
})();
const gdSatpRtos = (region) =>
  GD_SATP_CLUSTER_RTOS.get(String(region || '').toUpperCase().replace(/\s+/g, ' ').trim()) || '';

// Bajaj files Pvt-Car SATP / OD per DISTRICT (region = "Faridkot", "Amritsar",
// "Rest of UP" …). config/bajaj_rto_district.json maps RTO→district; invert it so
// each district region resolves to its RTOs instead of rendering blank and
// collapsing into same-key conflicts (USER 2026-08, Bajaj — part A). Metros that
// carry NO district override in the config are added explicitly below.
const _normKey = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const BAJAJ_DISTRICT_RTOS = (() => {
  const out = new Map();
  try {
    const cfg = require('../config/bajaj_rto_district.json') || {};
    const inv = new Map();
    for (const [rto, district] of Object.entries(cfg)) {
      const code = normRto(rto);
      if (!code) continue;
      const key = _normKey(district);
      if (!inv.has(key)) inv.set(key, new Set());
      inv.get(key).add(code);
    }
    for (const [k, s] of inv) out.set(k, [...s].sort().join(','));
  } catch (_) { /* config missing → no-op */ }
  return out;
})();
// Metros absent from the district-override config (their RTOs sit at the state
// head, not overridden). Curated city RTO sets (normRto shape).
const BAJAJ_METRO_RTOS = {
  'CHENNAI': 'TN-01,TN-02,TN-03,TN-04,TN-05,TN-06,TN-07,TN-09,TN-10,TN-11,TN-12,TN-13,TN-14,TN-18,TN-19,TN-20,TN-22,TN-85',
  'MUMBAI': 'MH-01,MH-02,MH-03,MH-04,MH-43,MH-47,MH-48',
  'KOLKATA': 'WB-01,WB-02,WB-03,WB-04,WB-05,WB-06,WB-07,WB-08',
  'BANGALORE': 'KA-01,KA-02,KA-03,KA-04,KA-05,KA-41,KA-50,KA-51,KA-52,KA-53',
  'HYDERABAD': 'TS-07,TS-08,TS-09,TS-10,TS-11,TS-12,TS-13,TS-14,TS-15,TS-28,TS-29',
};
function bajajDistrictRtos(region) {
  const k = _normKey(region);
  return BAJAJ_DISTRICT_RTOS.get(k) || BAJAJ_METRO_RTOS[k] || '';
}

// The `slab` column is a PREMIUM / VOLUME band (e.g. "0-50K", "1-2L", "3L+",
// "Below 1L", "1L-25L", "Above 25L", "Upto 2L"). Some volume_tier values are NOT
// slabs — they are segment/model text or stray numbers mis-parsed into the column
// (Bajaj: "Max Scooter" 13.5k rows, "50", "20-40%"). Populating those as a slab is
// wrong and also makes non-slab rows look distinct. Only treat a value as a slab
// when it carries a money magnitude (K/L/CR/lakh) or a band keyword; else blank
// (USER 2026-08, Bajaj). Percent values ("20-40%") are discount ranges, not slabs.
function slabValue(vt) {
  const s = String(vt == null ? '' : vt).trim();
  if (!s) return '';
  const u = s.toUpperCase();
  if (/%/.test(u)) return '';                                       // discount range, not a slab
  if (/\d\s*(K|L|CR|LAKH|LAC|LACS|LAKHS)\b/.test(u)) return s;      // 0-50K, 1-2L, 3L+, Above 25L
  if (/\b(BELOW|ABOVE|UP\s*TO|UPTO|OVER|LESS THAN|MORE THAN)\b/.test(u)) return s;
  return '';                                                        // "Max Scooter", "50", plain text
}

async function buildLucaBuffer(ids, opts) {
  // Restrict to specific canonical vehicle types when requested (USER 2026-08-04:
  // Luca file = Pvt Car / TW / GCV only, ignore PCV & MISC). null = no filter.
  const allowTypes = (opts && Array.isArray(opts.products) && opts.products.length)
    ? new Set(opts.products.map((p) => String(p).toUpperCase().trim()))
    : null;
  const idList = Array.isArray(ids) ? ids : [ids];
  const pool = await getPool();
  const rq = pool.request();
  rq.timeout = 600000;
  const ph = idList.map((id, i) => { rq.input('c' + i, id); return '@c' + i; });
  // Keep only the LATEST generation of each rate cell. Insurers leave older
  // cards open (Royal has BOTH "CV Grid__1st May" and "CV Grid__14th June"
  // effective today), so exporting every effective card mixes May+June rates
  // and duplicates rows. Ranking each identity (insurer + all rate dimensions)
  // by effective_from DESC and keeping rn=1 means the newest card wins where it
  // restates a cell, while a cell only an older card has (e.g. Royal's May-only
  // STP grid) survives — i.e. "June if available, else May". Mirrors the engine's
  // per-cover "latest card ≤ date, else earliest" rule (services/rate-lookup.js).
  const result = await rq.query(`
    WITH picked AS (
      SELECT rr.insurer, rr.product, rr.sheet_name, rr.region, rr.segment, rr.make,
             rr.model, rr.sub_type, rr.fuel_type, rr.cc_band_min, rr.cc_band_max,
             -- age lives in EITHER age_band_* OR vehicle_age_* depending on the
             -- ingestion path (e.g. Magma writes vehicle_age_*, leaving age_band_*
             -- NULL). Reading only age_band_* left vehicle_age blank, collapsing
             -- age-banded rows into look-alikes (same params, diff rate). COALESCE both.
             COALESCE(rr.age_band_min, rr.vehicle_age_min) AS age_band_min,
             COALESCE(rr.age_band_max, rr.vehicle_age_max) AS age_band_max,
             rr.weight_band_min, rr.weight_band_max,
             rr.seating_capacity_min, rr.seating_capacity_max, rr.volume_tier,
             rr.rate_type, rr.rate_value,
             rr.remarks, rr.state, rc.effective_from,
             ROW_NUMBER() OVER (
               PARTITION BY rr.insurer, rr.product, rr.sheet_name, rr.region, rr.segment,
                            rr.make, rr.model, rr.sub_type, rr.fuel_type,
                            rr.cc_band_min, rr.cc_band_max,
                            COALESCE(rr.age_band_min, rr.vehicle_age_min),
                            COALESCE(rr.age_band_max, rr.vehicle_age_max),
                            rr.weight_band_min, rr.weight_band_max,
                            rr.seating_capacity_min, rr.seating_capacity_max, rr.volume_tier,
                            rr.rate_type, rr.state
               ORDER BY rc.effective_from DESC, rr.id DESC) AS rn
      FROM rate_rules rr
      JOIN rate_cards rc ON rc.id = rr.rate_card_id
      WHERE rr.rate_card_id IN (${ph.join(',')})
        AND rr.rate_value IS NOT NULL
        -- CD1 is the DISCOUNT column on Digit/wide-matrix grids, NOT a commission
        -- (services/rate-lookup.js pickPrimaryRateRule drops it, so the engine
        -- never pays it). It was leaking into the file as commission — Go Digit
        -- "HCV GRID" COMP_CD1 cells held 99, exported as a 99% agent rate.
        -- FLEXI rows are likewise not a payable commission. Mirror the engine.
        AND rr.rate_type IS NOT NULL AND rr.rate_type <> ''
        AND rr.rate_type NOT LIKE '%CD1%'
        AND rr.rate_type NOT LIKE 'FLEXI%'
    )
    SELECT * FROM picked WHERE rn = 1`);

  // Active company margins, loaded once — same source the payout engine uses.
  const marginRules = await loadMarginRules(pool);
  const marginCache = new Map();
  const rtoIdx = await loadRtoIndex(pool);   // included_rto lookup

  // Config-driven insurers keep their grids in JSON + a resolver and never write
  // rate_rules (IndusInd has ZERO), so they'd be missing from an agent's file.
  // Expand them into rows shaped like rate_rules and run them through the same
  // pipeline below. Each row carries its insurer's card effective_from so the
  // year/month columns show the right generation.
  const effByInsurer = new Map();
  if (idList.length) {
    const effRq = pool.request();
    const eph = idList.map((cid, i) => { effRq.input('e' + i, cid); return '@e' + i; });
    const effRs = await effRq.query(
      `SELECT LOWER(insurer) AS insurer, MAX(effective_from) AS eff
         FROM rate_cards WHERE id IN (${eph.join(',')}) GROUP BY LOWER(insurer)`);
    for (const e of effRs.recordset) effByInsurer.set(e.insurer, e.eff);
  }
  const configRows = expandConfigRules(effByInsurer);
  // Drop DB rows the resolvers REPLACE (e.g. Tata's never-ingested Private Car
  // sheet and mis-ingested CV sheet) — otherwise the file would carry rates the
  // engine never pays alongside the correct config-expanded ones.
  const dbRows = result.recordset.filter(r => !isSuppressed(r));

  const rows = [LUCA_HEADERS.slice()];
  const _emitted = new Set();   // output-level dedupe (see the push below)
  let id = 1;
  for (const r of dbRows.concat(configRows)) {
    const insurer = lucaInsurer(r.insurer || '');
    const vt = ex.inferVehicleType(r.sheet_name, r.product, r.segment, r.sub_type);
    // Product scope (USER): the Luca file covers Pvt Car / TW / GCV only — skip
    // PCV and MISC. canonVt folds inferVehicleType's forms (Pvt car/4W→CAR,
    // 2W→TW, MIS→MISC) so the allowlist matches on the CAR/TW/GCV/PCV/MISC family.
    if (allowTypes && !allowTypes.has(canonVt(vt))) continue;
    const cover = ex.inferProduct(r.rate_type, r.sheet_name, r.sub_type, r.segment); // Comp / TP / SAOD
    const isTp = cover === 'TP';
    const mm = lucaMakeModel(r);   // make = manufacturer, model = model (kept separate)
    // OUTGOING = grid rate − margin (never expose the grid rate). USER 2026-07-17:
    // when the margin meets/exceeds the income we take NO margin and the agent
    // keeps the whole rate — mirrors routes/bulk.js so the file cannot promise a
    // rate the engine won't pay. Floors at 0 (a declined/0% grid stays 0).
    const gridP = pct(r.rate_value);
    const marginP = marginPctForRule(r, canonVt(vt), marginRules, marginCache);
    const rateP = gridP === '' ? ''
      : Math.max(0, +((gridP > 0 && marginP >= gridP) ? gridP : gridP - marginP).toFixed(3));
    // USER 2026-07-17: "if TP, OD, IRDA all rates are either ZERO or blank dont
    // download those records". Each row carries the rate in exactly ONE of
    // tp_commission_percentage / irdai_commission_percentage, so a blank-or-zero
    // rateP means every commission column on the row is empty — a declined /
    // nil-payout cell that tells an agent nothing. Drop the row entirely.
    if (rateP === '' || Number(rateP) === 0) continue;
    // Luca coverage_type taxonomy: comprehensive | own_damage | third_party | hybrid.
    // hybrid = a bundled long-term COMPREHENSIVE package where the OD and TP
    // tenures differ (1+3, 1+5, 5+5, 3+3, bundled, long-term). Plain annual 1+1
    // comprehensive stays 'comprehensive'. SAOD → own_damage, TP → third_party.
    // A bundle tag is OD-tenure + TP-tenure with the TP leg ≥ 2 years (1+3, 1+5,
    // 5+5, 3+3 …). Guard against SEATING specs ("6+1", "18+1", "6 + 1") — those
    // have a +1 driver, so require the second number ≥ 2 (also excludes plain 1+1).
    const covHay = `${r.segment || ''} ${r.sub_type || ''} ${r.sheet_name || ''} ${r.rate_type || ''}`.toUpperCase();
    const bt = /(\d+)\s*\+\s*(\d+)/.exec(covHay);
    const isBundled = /BUNDL|LONG[\s-]?TERM|\bLT\b/.test(covHay)
                   || (bt && +bt[1] >= 1 && +bt[1] <= 5 && +bt[2] >= 2 && +bt[2] <= 5);
    const coverageType = cover === 'Comp' ? (isBundled ? 'hybrid' : 'comprehensive')
                       : cover === 'SAOD' ? 'own_damage'
                       : 'third_party';
    // NB: bundle tenure (1+5 / 5+5) is deliberately NOT written to the slab/tenure
    // column — USER 2026-08 asked to leave it blank for now. (This means 1+5 vs 5+5
    // bundles on the same cell can still look like a Luca conflict; revisit later.)
    const d = r.effective_from ? new Date(r.effective_from) : null;
    const region = String(r.region || r.state || '').trim();
    let rtoList = rtoListFor(rtoIdx, r.insurer, region);     // shared by city + included_rto
    // A sub_type that is a comma/space-separated RTO list is MORE specific than the
    // region (Bajaj GCV per-RTO overrides: sub_type "WB73,WB76,WB77,WB79" / "NL01").
    // Use it as the included_rto so the override rows carry their real RTOs instead
    // of collapsing onto the base region row (USER 2026-08, Bajaj GCV).
    {
      const codes = String(r.sub_type || '').split(/[,\s;/]+/).map(normRto).filter(Boolean);
      if (codes.length) rtoList = [...new Set(codes)].sort().join(',');
    }
    // Some insurers (Kotak GCV) file per-RTO with the RTO CODE itself AS the region
    // ("AP16", "BR39"). The cluster lookup then finds nothing and the row shows only
    // the state, so AP16 and AP25 (different rates) collapse to look-alikes. If the
    // region is itself a valid RTO code, use it directly as the included_rto.
    if (!rtoList) { const c = normRto(region); if (c) rtoList = c; }
    // Go Digit SATP: region is a "4W TP" cluster (HP_Bad …) — resolve to its RTOs
    // so the 92 clusters don't collapse to a blank look-alike key (see map above).
    if (!rtoList && /go_digit/i.test(String(r.insurer || ''))) { const rl = gdSatpRtos(region); if (rl) rtoList = rl; }
    // Bajaj district / metro region (Faridkot, Amritsar, Chennai …) → its RTOs.
    if (!rtoList && /bajaj/i.test(String(r.insurer || ''))) { const rl = bajajDistrictRtos(region); if (rl) rtoList = rl; }
    // Whole-state region (Chola "JH"/"MH", and any insurer whose rule region is a
    // bare state code/name): expand to every RTO in that state so it isn't blank.
    if (!rtoList) { const rl = stateRtoList(rtoIdx, region); if (rl) rtoList = rl; }

    const rowArr = [
      0,                                                      // id — assigned below after the dedupe check
      (insurer + vt + (cover === 'Comp' ? 'PACKAGE' : cover.toUpperCase())).toUpperCase().replace(/[^A-Z0-9]/g, ''), // name
      insurer,                                                // insurers
      d ? d.getFullYear() : '',                               // year
      d ? MONTHS[d.getMonth()] : '',                          // month
      lucaProduct(vt, r.segment, r.sub_type, r.sheet_name, r.weight_band_min, r.weight_band_max), // products
      coverageType,                                           // coverage_type
      lucaNcb(r.rate_type),                                   // ncb
      isTp ? 'TP' : 'OD',                                     // commission_on
      isTp ? rateP : '',                                      // tp_commission_percentage
      isTp ? '' : rateP,                                      // irdai_commission_percentage (the outgoing OD rate)
      // slab — the premium/volume band (e.g. "Below 1L", "Upto 2L", "<50K"). Was
      // blank + carried only in the REMARK ("slab:X"), which collapsed premium-tiered
      // rules into look-alike rows (same visible params, different rate). Populate the
      // structured column so each band is distinct (USER 2026-08). slab_on/tenure/flat blank.
      '', '', '', '',   // slab / slab_on / tenure / flat — blank: the agent payout
                        // does not depend on OUR volume slab (USER 2026-08).
      '',                                                     // excluded_vehicles
      mm.make,                                                // vehicle_make (manufacturer)
      mm.model,                                               // vehicle_model
      ccBand(r.cc_band_min, r.cc_band_max),                   // vehicle_cc — [min,max]
      // vehicle_age — [min,max]; blank for HYBRID (USER): a hybrid row is a
      // bundled long-term package (1+3 / 1+5 / 5+5), which by definition is
      // written on a BRAND-NEW vehicle, so an age band on it is meaningless to
      // Luca. Blank = "all ages". Non-hybrid covers keep their band.
      coverageType === 'hybrid' ? ''                                           // vehicle_age
        : (ageBand(r.age_band_min, r.age_band_max)
           || (function () { const b = ageBandFromSegment(r.segment); return b ? ageBand(b[0], b[1]) : ''; })()),
      seatBand(r.seating_capacity_min, r.seating_capacity_max),                 // seating_capacity
      gvwBand(r.weight_band_min, r.weight_band_max),                            // gross_vehicle_weight (kg)
      lucaFuel(r.fuel_type),                                  // fuel_type
      lucaBusinessType(r.segment, r.sub_type, r.rate_type),   // business_type
      '',                                                     // zones
      lucaState(r.state, r.region),                           // included_states (canonical state slug)
      citiesFromRtoList(rtoList) || lucaCity(region),         // city — cities in the cluster (RTO→city), else clean locality
      '',                                                     // excluded_cities
      rtoList,                                                // included_rto (comma-separated)
      '',                                                     // excluded_rto
      'pos',                                                  // sales_channel
      'outgoing',                                             // rule_type
      '', '', '', '',                                         // cpa, commission_percent_on_total_commission, deduction, discount_range
      // Comment: carry every rate dimension Luca has NO dedicated column for —
      // segment / sub_type / volume_tier (e.g. Ambulance vs MISC-D vs Motor Trade;
      // SBI/Bajaj volume slabs). Without them, rows sharing every visible column but
      // differing only by one of these look like unexplained duplicates
      // (USER 2026-07-29). Original remark appended last.
      // volume_tier now lives in the structured `slab` column (above), so it's no
      // longer duplicated here; REMARK keeps segment/sub_type + the original remark.
      ([[r.segment, r.sub_type].map(x => String(x || '').trim()).filter(Boolean).join(' ').trim(),
        String(r.remarks || '').trim()].filter(Boolean).join(' | ')).slice(0, 250),  // REMARK / comment
    ];
    // Output-level dedupe (USER: "it looks duplicate records"). Different source
    // rate_rules can render to a byte-identical Luca row — e.g. two rows that
    // differ only in a column Luca doesn't carry (sub_type). Identical on every
    // agent-visible column = indistinguishable, so emit it once. Key on the whole
    // row EXCEPT the id (index 0) and the REMARK (last col — free text, not a
    // rate dimension, so it shouldn't create a phantom "distinct" row).
    const sig = rowArr.slice(1, rowArr.length - 1).join('');
    if (_emitted.has(sig)) continue;
    _emitted.add(sig);
    rowArr[0] = id++;
    rowArr._vt = String(r.volume_tier || '');   // source volume tier (for the slab-collapse below)
    rows.push(rowArr);
  }

  // De-conflict overlapping definitions (USER 2026-08, Bajaj part A):
  //   1. Catch-all regions ("Rest of <state>", "Other RTOs") that resolve to the
  //      SAME RTOs as a specific sibling row → give the catch-all the WHOLE state
  //      MINUS the specific rows' RTOs, so it covers only the leftover RTOs (and
  //      drop it if nothing is left). This is the "rest except X" Luca can't express.
  //   2. MISP rows (agent's own arrangement) are dropped when a grid row exists for
  //      the same cell — the file should carry the standard grid payout.
  {
    const HI = (n) => LUCA_HEADERS.indexOf(n);
    const I_RTO = HI('included_rto'), I_CITY = HI('city'), I_STATE = HI('included_states'), I_REM = HI('REMARK');
    const KEY_COLS = ['insurers', 'products', 'coverage_type', 'ncb', 'commission_on', 'slab',
      'vehicle_make', 'vehicle_model', 'vehicle_cc', 'vehicle_age', 'seating_capacity',
      'gross_vehicle_weight', 'fuel_type', 'business_type'].map(HI);
    const cellKey = (row) => KEY_COLS.map((i) => String(row[i])).join('|');
    const isCatchAll = (row) => /\brest\s+of\b|\bother\s+rtos?\b|\bremaining\s+rtos?\b/i.test(String(row[I_REM] || ''));
    const isMisp = (row) => /\bMISP\b/i.test(String(row[I_REM] || ''));

    const data = rows.slice(1);
    const specificRtos = new Map();   // cellKey → Set of RTO codes claimed by specific rows
    const hasGrid = new Set();        // cellKeys that have a non-MISP row
    for (const row of data) {
      if (!isMisp(row)) hasGrid.add(cellKey(row));
      if (isCatchAll(row) || isMisp(row)) continue;
      const k = cellKey(row);
      if (!specificRtos.has(k)) specificRtos.set(k, new Set());
      String(row[I_RTO] || '').split(',').forEach((c) => { const t = c.trim(); if (t) specificRtos.get(k).add(t); });
    }
    const kept = [rows[0]];
    for (const row of data) {
      const k = cellKey(row);
      if (isMisp(row) && hasGrid.has(k)) continue;          // rule 2: drop MISP, keep grid
      if (isCatchAll(row)) {                                 // rule 1: catch-all = state − specific
        const spec = specificRtos.get(k);
        if (spec && spec.size) {
          const stPrefix = asStatePrefix(String(row[I_STATE] || '').replace(/_/g, ' '));
          const stateAll = (stPrefix && rtoIdx._stateRtos && rtoIdx._stateRtos.get(stPrefix)) || String(row[I_RTO] || '');
          const remaining = stateAll.split(',').map((s) => s.trim()).filter((c) => c && !spec.has(c));
          if (!remaining.length) continue;                  // catch-all covers nothing new → drop
          row[I_RTO] = remaining.join(',');
          row[I_CITY] = citiesFromRtoList(row[I_RTO]) || row[I_CITY];
        }
      }
      kept.push(row);
    }

    // Slab collapse (USER 2026-08): the slab column is blank (agent payout does not
    // depend on OUR volume slab), so rows that differ ONLY by volume tier now share a
    // key with different rates. Keep the HIGHEST tier's row (3L+ > 2-3L > … > 0-50K)
    // and drop the rest. Only fires when the group's members carry DISTINCT volume
    // tiers — a same-tier different-rate group is a real conflict, left untouched.
    const tierMag = (vt) => {
      const u = String(vt || '').toUpperCase();
      if (/\+|\bABOVE\b|\bOVER\b|\bMORE THAN\b/.test(u)) return 1e12;   // open-ended top band = highest
      const mag = { K: 1e3, L: 1e5, LAKH: 1e5, LAC: 1e5, CR: 1e7 };
      const m = [...u.matchAll(/(\d+(?:\.\d+)?)\s*(K|L|CR|LAKH|LAC)/g)];
      return m.length ? Math.max(...m.map((x) => Number(x[1]) * (mag[x[2]] || 1))) : 0;
    };
    const I_INS = HI('insurers'), I_TP = HI('tp_commission_percentage'), I_OD = HI('irdai_commission_percentage');
    const rateOf = (row) => Math.max(Number(row[I_TP]) || 0, Number(row[I_OD]) || 0);
    const collKey = (row) => KEY_COLS.map((i) => String(row[i])).join('|') + '|' + String(row[I_RTO]);
    const byColl = new Map();
    for (const row of kept.slice(1)) {
      const k = collKey(row);
      if (!byColl.has(k)) byColl.set(k, []);
      byColl.get(k).push(row);
    }
    const dropped = new Set();
    for (const grp of byColl.values()) {
      if (grp.length < 2) continue;
      const tiers = new Set(grp.map((r0) => String(r0._vt || '')));
      let best;
      if (tiers.size >= 2) {
        // distinct volume tiers → keep the highest tier (USER: 3L+).
        best = grp[0];
        for (const r0 of grp) if (tierMag(r0._vt) > tierMag(best._vt)) best = r0;
      } else if (/bajaj/i.test(String(grp[0][I_INS] || ''))) {
        // Bajaj same exact cell+RTO at different rates = a duplicated per-RTO
        // override (base-with-note vs explicit row) → keep the higher rate. Scoped
        // to Bajaj so Go Digit bundles (differ by tenure) are left untouched.
        best = grp[0];
        for (const r0 of grp) if (rateOf(r0) > rateOf(best)) best = r0;
      } else {
        continue;   // other insurers: same-tier different-rate = real conflict, keep all
      }
      for (const r0 of grp) if (r0 !== best) dropped.add(r0);
    }
    const kept2 = kept.filter((row, i) => i === 0 || !dropped.has(row));

    rows.length = 0;
    for (const row of kept2) rows.push(row);
  }

  // Reorder every row (header included) from build order to the Luca output order.
  const outRows = rows.map((row) => _OUT_IDX.map((i) => row[i]));
  const ws = XLSX.utils.aoa_to_sheet(outRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

module.exports = { buildLucaBuffer, LUCA_HEADERS, lucaProduct, lucaState, lucaFuel, lucaMake, lucaMakeModel, lucaBusinessType };
