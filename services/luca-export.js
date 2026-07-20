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
    return 'gcv';
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

function lucaMake(m) {
  const s = String(m == null ? '' : m).trim();
  if (!s) return '';
  const u = s.toUpperCase();
  // Column-header / placeholder leaks — not a make, and meaningless to an agent.
  if (/^(MAKE|MAKES|SEGMENT|MODEL|OTHER,?\s*MAKES?)$/.test(u)) return '';
  if (s.replace(/[^A-Za-z]/g, '').length <= 1) return '';            // single-letter leak ("D")
  if (/[%:_+<>]/.test(s)) return '';                                 // rate/remark/cluster/region-combo/spec leak (real makes use spaces)
  if (/^\d+(\.\d+)?$/.test(s)) return '';                            // pure number / rate
  if (/\b(YR|YRS|YEAR|YEARS|YS)\b/.test(u) || /^\d+\s*[-]/.test(s)) return ''; // age band
  if (/^ALL\b/.test(u) || /^NON[\s-]/.test(u) || /^OTHERS?$/.test(u)) return ''; // "All ..." / "Non Tata" / "Other(s)"
  if (/EXCLUD|EXCEPT|OTHER\s+MAKE|OTHER\s+MODEL|OTHER\s+THAN|\bREF\b/.test(u)) return ''; // exclusion / region-ref
  // segment / vehicle-type / spec words (no \b so glued forms like "BackhoeLoader" are caught)
  if (/GCV|PCV|LCV|HCV|MCV|GCCV|PCCV|\bMISC\b|SEATER|SEAT|TONNE|\bTON\b|GVW|LAKH|\bLAC\b|UPTO|DUMPER|TIPPER|BACKHOE|EXCAVATOR|LOADER|CRANE|HARVESTER|TAXI|\bBUS\b|TANKER|DRILLING|\bRIG\b|MOBILEPLANT|RICKSHAW|E-?LOADER/.test(u)) return '';
  if (/\d\s*T\b/.test(u) || /^[A-Z]{2}\s?\d/.test(u)) return '';     // tonnage ("40T") / RTO-region code ("TN1", "HP 21")
  if (resolveStateSlug(s)) return '';                               // the value IS a region / city / state name
  return expandMake(s);                                              // real make — abbreviations spelled out
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
const _rkey = (ins, g) => String(ins || '').toLowerCase().trim() + '|'
  + String(g || '').toUpperCase().replace(/\s+/g, ' ').trim();

/** insurer+region/cluster → sorted, comma-separated RTO codes. */
async function loadRtoIndex(pool) {
  const rs = await pool.request().query(
    'SELECT insurer, region, cluster, rto_code FROM rto_mappings WHERE rto_code IS NOT NULL');
  const sets = new Map();
  for (const r of rs.recordset) {
    const code = String(r.rto_code).toUpperCase().trim();
    if (!code) continue;
    for (const g of [r.region, r.cluster]) {
      if (!g || !String(g).trim()) continue;
      const k = _rkey(r.insurer, g);
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k).add(code);
    }
  }
  const out = new Map();
  for (const [k, s] of sets) out.set(k, [...s].sort().join(','));
  return out;
}
function rtoListFor(idx, insurer, region) {
  const g = String(region || '').trim();
  if (!g) return '';
  return idx.get(_rkey(insurer, g))
      || idx.get(_rkey(insurer, STATE_TO_RTO_PREFIX[g.toUpperCase().replace(/\s+/g, ' ')] || ' '))
      || '';
}

async function buildLucaBuffer(ids) {
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
             rr.age_band_min, rr.age_band_max, rr.weight_band_min, rr.weight_band_max,
             rr.seating_capacity_min, rr.seating_capacity_max,
             rr.rate_type, rr.rate_value,
             rr.remarks, rr.state, rc.effective_from,
             ROW_NUMBER() OVER (
               PARTITION BY rr.insurer, rr.product, rr.sheet_name, rr.region, rr.segment,
                            rr.make, rr.model, rr.sub_type, rr.fuel_type,
                            rr.cc_band_min, rr.cc_band_max, rr.age_band_min, rr.age_band_max,
                            rr.weight_band_min, rr.weight_band_max,
                            rr.seating_capacity_min, rr.seating_capacity_max,
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
  let id = 1;
  for (const r of dbRows.concat(configRows)) {
    const insurer = lucaInsurer(r.insurer || '');
    const vt = ex.inferVehicleType(r.sheet_name, r.product, r.segment, r.sub_type);
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
    const d = r.effective_from ? new Date(r.effective_from) : null;
    const region = String(r.region || r.state || '').trim();

    rows.push([
      id++,                                                   // id
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
      '', '', '', '',                                         // slab, slab_on, is_slab_on_first_tenure, flat_commission
      '',                                                     // excluded_vehicles
      mm.make,                                                // vehicle_make (manufacturer)
      mm.model,                                               // vehicle_model
      ccBand(r.cc_band_min, r.cc_band_max),                   // vehicle_cc — [min,max]
      // vehicle_age — [min,max]; blank for HYBRID (USER): a hybrid row is a
      // bundled long-term package (1+3 / 1+5 / 5+5), which by definition is
      // written on a BRAND-NEW vehicle, so an age band on it is meaningless to
      // Luca. Blank = "all ages". Non-hybrid covers keep their band.
      coverageType === 'hybrid' ? '' : ageBand(r.age_band_min, r.age_band_max), // vehicle_age
      seatBand(r.seating_capacity_min, r.seating_capacity_max),                 // seating_capacity
      gvwBand(r.weight_band_min, r.weight_band_max),                            // gross_vehicle_weight (kg)
      lucaFuel(r.fuel_type),                                  // fuel_type
      lucaBusinessType(r.segment, r.sub_type, r.rate_type),   // business_type
      '',                                                     // zones
      lucaState(r.state, r.region),                           // included_states (canonical state slug)
      '',                                                     // city
      '',                                                     // excluded_cities
      rtoListFor(rtoIdx, r.insurer, region),                  // included_rto (comma-separated)
      '',                                                     // excluded_rto
      'pos',                                                  // sales_channel
      'outgoing',                                             // rule_type
      '', '', '', '',                                         // cpa, commission_percent_on_total_commission, deduction, discount_range
      String(r.remarks || '').slice(0, 250),                 // REMARK
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

module.exports = { buildLucaBuffer, LUCA_HEADERS, lucaProduct, lucaState, lucaFuel, lucaMake, lucaMakeModel, lucaBusinessType };
